import type {
  AdapterContext,
  AgentHomeStore,
  ComputerRef,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { computerSleepJob } from "@rakazo/adapter-kit";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { shellQuote } from "@rakazo/core/node/desktop-runtime";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { expireComputerControl, hasActiveComputerControl } from "./computer-control.js";
import { toComputerRef } from "./computer-lifecycle.js";
import { checkpointComputerWorkspace } from "./computer-workspace.js";

export const DEFAULT_SANDBOX_IDLE_MS = 10 * 60 * 1000;
const BACKGROUND_WORK_MARKER_PREFIX = "/tmp/rakazo-background-";
const BACKGROUND_WORK_IDLE_SENTINEL = "rakazo-background-idle";

export const BACKGROUND_WORK_LAUNCH = [
  `marker="${BACKGROUND_WORK_MARKER_PREFIX}$1-$2-$3"`,
  "set -o noclobber",
  'exec 9>"$marker" || exit 1',
  "set +o noclobber",
  'exec bash -lc "$4"',
].join("\n");

// Read the process table and descriptor links in one interpreter. Forking a
// readlink process for every descriptor can exceed the cancellation deadline.
export const COLLECT_COMPUTER_RUN_PROCESSES = String.raw`
import os
import sys

prefix = '/tmp/rakazo-background-' + sys.argv[1] + '-' + sys.argv[2] + '-'
excluded = {1, os.getpid(), os.getppid()}
owned = {}
for entry in sys.argv[3].split():
    pid, start = map(int, entry.split(':'))
    if pid > 1 and start > 0 and pid not in excluded:
        owned[pid] = start

def identity(pid):
    try:
        with open('/proc/' + str(pid) + '/stat') as stream:
            fields = stream.read().rpartition(') ')[2].split()
        return int(fields[1]), int(fields[19])
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        return None

table = {}
for name in os.listdir('/proc'):
    if name.isdecimal() and int(name) not in excluded:
        pid = int(name)
        row = identity(pid)
        if row is not None:
            table[pid] = row

for pid, row in table.items():
    try:
        with os.scandir('/proc/' + str(pid) + '/fd') as descriptors:
            for descriptor in descriptors:
                try:
                    target = os.readlink(descriptor.path)
                except (FileNotFoundError, ProcessLookupError, PermissionError):
                    continue
                if target.startswith(prefix) and identity(pid) == row:
                    # Keep an older identity across grace; a reused PID must
                    # never acquire ownership simply by reappearing.
                    owned.setdefault(pid, row[1])
                    break
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        continue

changed = True
while changed:
    changed = False
    for pid, (parent, start) in table.items():
        if pid in owned or parent not in owned:
            continue
        current_parent = identity(parent)
        if current_parent is not None and current_parent[1] == owned[parent]:
            owned[pid] = start
            changed = True

print(' '.join(str(pid) + ':' + str(start) for pid, start in owned.items()))
`;

/** Terminate background shell wrappers for one cancelled run. Browser teardown stays screen-scoped. */
export const CANCEL_COMPUTER_RUN_WORK = [
  'computerId="$1"',
  'runId="$2"',
  '[ -n "$computerId" ] && [ -n "$runId" ] || exit 0',
  `prefix="${BACKGROUND_WORK_MARKER_PREFIX}$computerId-$runId-"`,
  "proc_ppid_starttime() {",
  '  [ -r "/proc/$1/stat" ] || return 1',
  '  IFS= read -r _st_line <"/proc/$1/stat" 2>/dev/null || return 1',
  '  _st_rest="${_st_line##*) }"',
  "  set -- $_st_rest",
  '  [ -n "${2:-}" ] && [ -n "${20:-}" ] || return 1',
  '  printf "%s %s\\n" "$2" "${20}"',
  "}",
  "kill_verified() {",
  '  _sig="$1"; _vpid="$2"; _vstart="$3"',
  '  [ -n "$_vpid" ] && [ "$_vpid" != "$$" ] || return 0',
  '  if [ -n "$_vstart" ] && [ -d /proc ]; then',
  '    _cur="$(proc_ppid_starttime "$_vpid" 2>/dev/null)" || return 0',
  '    [ "${_cur#* }" = "$_vstart" ] || return 0',
  "  fi",
  '  kill -"$_sig" "$_vpid" 2>/dev/null || true',
  "}",
  '_owned_list=" "',
  "collect_owned_tree() {",
  `  _collected="$(python3 -c ${shellQuote(COLLECT_COMPUTER_RUN_PROCESSES)} "$computerId" "$runId" "$_owned_list")" || return 1`,
  '  _owned_list=" $_collected "',
  "}",
  // The marker descriptor identifies launch roots; collect their descendants
  // before signalling so children that close inherited descriptors are included.
  "if [ -d /proc ]; then",
  "  collect_owned_tree || exit 1",
  "  for _entry in $_owned_list; do",
  // Never kill -PID (process group): sandbox work often shares the caller's PGID.
  '    kill_verified TERM "${_entry%:*}" "${_entry#*:}"',
  "  done",
  'elif [ "$(uname -s 2>/dev/null)" = "Darwin" ] && command -v lsof >/dev/null 2>&1; then',
  '  for marker in "$prefix"*; do',
  '    [ -e "$marker" ] || continue',
  '    for pid in $(lsof -t -- "$marker" 2>/dev/null); do',
  '      kill -TERM "$pid" 2>/dev/null || true',
  "    done",
  "  done",
  "fi",
  'if [ -n "${RAKAZO_CANCEL_INTERMEDIATE_HOOK:-}" ] && [ -f "$RAKAZO_CANCEL_INTERMEDIATE_HOOK" ]; then',
  '  sh "$RAKAZO_CANCEL_INTERMEDIATE_HOOK" "$computerId" "$runId" "$_owned_list" 2>/dev/null || true',
  'elif [ -f "${prefix}intermediate-hook.sh" ]; then',
  '  sh "${prefix}intermediate-hook.sh" "$computerId" "$runId" "$_owned_list" 2>/dev/null || true',
  "fi",
  "sleep 0.2",
  "if [ -d /proc ]; then",
  "  collect_owned_tree || exit 1",
  "  for _entry in $_owned_list; do",
  '    kill_verified KILL "${_entry%:*}" "${_entry#*:}"',
  "  done",
  'elif [ "$(uname -s 2>/dev/null)" = "Darwin" ] && command -v lsof >/dev/null 2>&1; then',
  '  for marker in "$prefix"*; do',
  '    [ -e "$marker" ] || continue',
  '    for pid in $(lsof -t -- "$marker" 2>/dev/null); do',
  '      kill -KILL "$pid" 2>/dev/null || true',
  "    done",
  "  done",
  "fi",
  'rm -f -- "$prefix"* 2>/dev/null || true',
].join("\n");

/**
 * Kill the primary browser session without matching chromium-screen-* profiles.
 * Covers Docker (--user-data-dir=.../chromium) and portable launches that only
 * use the symlinked primary profile (E2B desktop.launch / Daytona nohup).
 */
export const CANCEL_PRIMARY_BROWSER_WORK = [
  "pkill -TERM -f -- '--user-data-dir=.*/.browser-profiles/chromium$' || true",
  "pkill -TERM -f -- '--user-data-dir=.*/.browser-profiles/chromium ' || true",
  // Portable primary browsers often omit --user-data-dir; match argv0 only so
  // unrelated processes (e.g. node --engine=chromium) are not killed.
  "if [ -d /proc ]; then for pid in /proc/[0-9]*; do",
  '  cmdline="$(tr "\\0" " " <"$pid/cmdline" 2>/dev/null)" || continue',
  '  case "$cmdline" in *chromium-screen-*) continue ;; esac',
  '  argv0=""; IFS= read -r -d "" argv0 <"$pid/cmdline" || true',
  '  case "$argv0" in',
  "    */google-chrome|*/google-chrome-*|google-chrome|google-chrome-*|*/chromium|*/chromium-*|chromium|chromium-*|*/chrome|chrome|*/firefox|*/firefox-*|firefox|firefox-*)",
  `      kill -TERM "\${pid#/proc/}" 2>/dev/null || true`,
  "      ;;",
  "  esac",
  "done; fi",
  "sleep 0.2",
  "pkill -KILL -f -- '--user-data-dir=.*/.browser-profiles/chromium$' || true",
  "pkill -KILL -f -- '--user-data-dir=.*/.browser-profiles/chromium ' || true",
  "if [ -d /proc ]; then for pid in /proc/[0-9]*; do",
  '  cmdline="$(tr "\\0" " " <"$pid/cmdline" 2>/dev/null)" || continue',
  '  case "$cmdline" in *chromium-screen-*) continue ;; esac',
  '  argv0=""; IFS= read -r -d "" argv0 <"$pid/cmdline" || true',
  '  case "$argv0" in',
  "    */google-chrome|*/google-chrome-*|google-chrome|google-chrome-*|*/chromium|*/chromium-*|chromium|chromium-*|*/chrome|chrome|*/firefox|*/firefox-*|firefox|firefox-*)",
  `      kill -KILL "\${pid#/proc/}" 2>/dev/null || true`,
  "      ;;",
  "  esac",
  "done; fi",
  'rm -f "$HOME/.browser-profiles/chromium/SingletonLock" "$HOME/.browser-profiles/chromium/SingletonCookie" "$HOME/.browser-profiles/chromium/SingletonSocket" 2>/dev/null || true',
].join("; ");

export function cancelComputerRunWorkArgv(computerId: string, runId: string): string[] {
  return ["bash", "-c", CANCEL_COMPUTER_RUN_WORK, "rakazo-cancel-run-work", computerId, runId];
}

export async function cancelComputerRunWork(
  sandbox: Pick<SandboxProvider, "execute">,
  computer: ComputerRef,
  computerId: string,
  runId: string,
  context: AdapterContext,
): Promise<void> {
  if (!computerId || !runId) return;
  try {
    for await (const _event of sandbox.execute(
      computer,
      { argv: cancelComputerRunWorkArgv(computerId, runId), timeoutMs: 15_000 },
      context,
    )) {
      // Drain so providers can finish the exec session.
    }
  } catch {
    // Best effort after the run is already cancelled.
  }
}

export const BACKGROUND_WORK_PROBE = [
  `prefix="${BACKGROUND_WORK_MARKER_PREFIX}$1-"`,
  `idle() { printf '${BACKGROUND_WORK_IDLE_SENTINEL}\\n'; exit 1; }`,
  'markers=("$prefix"*)',
  "if [ -d /proc ]; then",
  "  command -v readlink >/dev/null 2>&1 || exit 2",
  "  for fd in /proc/[0-9]*/fd/*; do",
  '    target="$(readlink "$fd" 2>/dev/null)"',
  '    case "$target" in "$prefix"*) exit 0 ;; esac',
  "  done",
  `  for marker in "\${markers[@]}"; do [ -e "$marker" ] && rm -f -- "$marker"; done`,
  "  idle",
  "fi",
  'if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then',
  "  command -v lsof >/dev/null 2>&1 || exit 2",
  `  for marker in "\${markers[@]}"; do`,
  '    [ -e "$marker" ] || continue',
  '    lsof -t -- "$marker" >/dev/null 2>&1 && exit 0',
  '    rm -f -- "$marker"',
  "  done",
  "  idle",
  "fi",
  "exit 2",
].join("\n");

export function sandboxIdleMs(): number {
  const raw = Number(process.env.SANDBOX_IDLE_MS ?? DEFAULT_SANDBOX_IDLE_MS);
  return Number.isFinite(raw) && raw >= 30_000 ? raw : DEFAULT_SANDBOX_IDLE_MS;
}

export function computerIdleSleepEnabled(): boolean {
  return process.env.SANDBOX_IDLE_MS?.trim() !== "0";
}

export function scheduleComputerSleep(jobs: JobPublisher, computerId: string): void {
  if (!computerId || !computerIdleSleepEnabled()) return;
  void jobs.enqueue(computerSleepJob(computerId, new Date(Date.now() + sandboxIdleMs())));
}

export async function touchRunningComputer(
  deps: { sandbox: SandboxProvider; jobs: JobPublisher },
  computer: { id: string; homeKey: string; providerRef: string; kind: string },
): Promise<void> {
  scheduleComputerSleep(deps.jobs, computer.id);
  await deps.sandbox.keepAlive?.(toComputerRef(computer));
}

export async function sleepComputerIfIdle(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    home: AgentHomeStore;
    jobs: JobPublisher;
    events: ThreadEvents;
  },
  computerId: string,
): Promise<void> {
  if (!computerIdleSleepEnabled()) return;
  let computer = await loadComputer(deps.prisma, computerId);
  if (!computer?.providerRef || computer.state !== "running") return;

  if (computer.controlBotId && computer.controlLeaseId && !hasActiveComputerControl(computer)) {
    await expireComputerControl(deps, computer.id, computer.controlLeaseId);
    computer = await loadComputer(deps.prisma, computerId);
    if (!computer?.providerRef || computer.state !== "running") return;
  }

  const activeStatuses = hasActiveComputerControl(computer)
    ? [...ACTIVE_RUN_STATUSES]
    : ACTIVE_RUN_STATUSES.filter((status) => status !== "waiting_takeover");
  if (await findActiveRun(deps.prisma, computerId, activeStatuses)) {
    scheduleComputerSleep(deps.jobs, computerId);
    return;
  }

  const ref = toComputerRef(computer);
  const ctx: AdapterContext = {
    operationId: "computer.sleep",
    traceId: "computer.sleep",
    spaceId: computer.spaceId,
    userId: computer.userId,
    botId: computer.controlBotId ?? undefined,
    signal: new AbortController().signal,
  };
  if (await hasActiveBackgroundWork(deps.sandbox, ref, ctx, computerId)) {
    scheduleComputerSleep(deps.jobs, computerId);
    await deps.sandbox.keepAlive?.(ref);
    return;
  }

  const checkpointedAt = new Date();
  const recorded = await deps.prisma.computer.updateMany({
    where: {
      id: computerId,
      state: "running",
      maintenanceId: null,
      providerRef: computer.providerRef,
      updatedAt: computer.updatedAt,
      executionRunId: null,
      executionLeases: { none: { expiresAt: { gt: checkpointedAt } } },
    },
    data: { state: "suspending", updatedAt: checkpointedAt },
  });
  if (recorded.count !== 1) {
    scheduleComputerSleep(deps.jobs, computerId);
    return;
  }
  const suspensionClaim = {
    id: computerId,
    state: "suspending",
    providerRef: computer.providerRef,
    updatedAt: checkpointedAt,
  };

  try {
    const revision = await checkpointComputerWorkspace(
      deps.home,
      deps.sandbox,
      computer.homeKey,
      ref,
      ctx,
    );
    const saved = await deps.prisma.computer.updateMany({
      where: suspensionClaim,
      data: { homeRevision: revision, updatedAt: checkpointedAt },
    });
    if (saved.count !== 1) {
      await deps.prisma.computer.updateMany({
        where: suspensionClaim,
        data: { state: "running" },
      });
      scheduleComputerSleep(deps.jobs, computerId);
      return;
    }
  } catch (error) {
    await deps.prisma.computer.updateMany({
      where: suspensionClaim,
      data: { state: "running" },
    });
    scheduleComputerSleep(deps.jobs, computerId);
    throw error;
  }

  const [current, activeAfterCheckpoint, backgroundAfterCheckpoint] = await Promise.all([
    deps.prisma.computer.findUnique({
      where: { id: computerId },
      select: { state: true, providerRef: true, updatedAt: true },
    }),
    findActiveRun(deps.prisma, computerId, activeStatuses),
    hasActiveBackgroundWork(deps.sandbox, ref, ctx, computerId),
  ]);
  if (activeAfterCheckpoint || backgroundAfterCheckpoint) {
    await deps.prisma.computer.updateMany({
      where: suspensionClaim,
      data: { state: "running" },
    });
    scheduleComputerSleep(deps.jobs, computerId);
    if (backgroundAfterCheckpoint) await deps.sandbox.keepAlive?.(ref);
    return;
  }
  if (
    current?.state !== "suspending" ||
    current.providerRef !== computer.providerRef ||
    current.updatedAt.getTime() !== checkpointedAt.getTime()
  ) {
    await deps.prisma.computer.updateMany({
      where: suspensionClaim,
      data: { state: "running" },
    });
    scheduleComputerSleep(deps.jobs, computerId);
    return;
  }

  try {
    await deps.sandbox.stop(ref, ctx);
  } catch (error) {
    await deps.prisma.computer.updateMany({
      where: suspensionClaim,
      data: { state: "running" },
    });
    throw error;
  }
  await deps.prisma.computer.update({
    where: suspensionClaim,
    data: {
      state: "suspended",
      controlHolder: "none",
      controlLeaseId: null,
      controlLeaseExpiresAt: null,
      controlBotId: null,
      controlRunId: null,
    },
  });
  const bots = await deps.prisma.bot.findMany({
    where: { computerId },
    select: { id: true, thread: { select: { id: true } } },
  });
  for (const bot of bots) {
    if (!bot.thread) continue;
    await deps.events.append({
      spaceId: computer.spaceId,
      threadId: bot.thread.id,
      botId: bot.id,
      type: "computer.status",
      payload: { status: "suspended" },
    });
  }
}

function loadComputer(prisma: PrismaClient, computerId: string) {
  return prisma.computer.findUnique({
    where: { id: computerId },
    select: {
      id: true,
      homeKey: true,
      providerRef: true,
      kind: true,
      state: true,
      spaceId: true,
      userId: true,
      controlHolder: true,
      controlLeaseId: true,
      controlLeaseExpiresAt: true,
      controlBotId: true,
      updatedAt: true,
    },
  });
}

function findActiveRun(prisma: PrismaClient, computerId: string, statuses: readonly string[]) {
  return prisma.run.findFirst({
    where: {
      bot: { computerId },
      status: { in: statuses as (typeof ACTIVE_RUN_STATUSES)[number][] },
    },
    select: { id: true },
  });
}

async function hasActiveBackgroundWork(
  sandbox: SandboxProvider,
  computer: ReturnType<typeof toComputerRef>,
  context: AdapterContext,
  computerId: string,
): Promise<boolean> {
  if (sandbox.inspectBackgroundWork) {
    try {
      return (await sandbox.inspectBackgroundWork(computer, computerId, context)) !== "idle";
    } catch {
      return true;
    }
  }
  let exitCode: number | undefined;
  let stdout = "";
  try {
    for await (const event of sandbox.execute(
      computer,
      {
        argv: ["bash", "-c", BACKGROUND_WORK_PROBE, "rakazo-background-probe", computerId],
        timeoutMs: 10_000,
      },
      context,
    )) {
      if (event.type === "stdout") stdout += event.data;
      if (event.type === "exit") exitCode = event.code;
    }
  } catch {
    return true;
  }
  // Only the probe's explicit idle result permits suspension; unsupported or failed probes retry.
  return exitCode !== 1 || stdout.trim() !== BACKGROUND_WORK_IDLE_SENTINEL;
}
