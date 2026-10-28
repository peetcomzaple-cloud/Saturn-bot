import { createHash } from "node:crypto";
import type { AgentRunRequest, SandboxProvider } from "@rakazo/adapter-kit";
import {
  legacyScopedToolEffectIdempotencyKey,
  toolEffectIdempotencyKey,
} from "@rakazo/core/node/approval-effect-key";
import { describe, expect, it, vi } from "vitest";
import type * as AutoReviewModule from "./auto-review.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import type * as PiModelsModule from "./pi-models.js";
import type { CloseNegationClassifier } from "./model-error-classifier.js";

vi.mock("./pi-models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof PiModelsModule>()),
  listPiCatalog: () => [
    {
      provider: "openrouter",
      id: "deepseek/deepseek-v4-flash-0731",
      cost: { input: 0.1, output: 0.2 },
    },
    { provider: "openrouter", id: "openai/gpt-4o", cost: { input: 1, output: 2 } },
  ],
}));

const { mockProvisionedComputerKind } = vi.hoisted(() => ({
  mockProvisionedComputerKind: { value: "desktop" },
}));

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: mockProvisionedComputerKind.value }),
}));

vi.mock("./auto-review.js", async (importOriginal) => ({
  ...(await importOriginal<typeof AutoReviewModule>()),
  resolveAutoReviewChecker: () => ({ provider: "scripted", model: "checker" }),
  isAutoReviewCheckerConfigured: () => true,
  runAutoReviewJudge: vi.fn(),
}));

type Effect = {
  id: string;
  spaceId: string;
  runId?: string;
  kind: string;
  idempotencyKey: string;
  status: string;
  request: unknown;
  result?: unknown;
  reviewDecision?: string;
};

type ToolCall = {
  name: string;
  args: Record<string, unknown>;
  executionId: string;
};

function fixture(
  runId = "run-1",
  options: {
    computerKind?: "desktop" | "container";
    browser?: unknown;
    initialEffects?: Effect[];
    allowFailedOutcome?: boolean;
    sandbox?: Pick<SandboxProvider, "observe" | "act"> & Partial<Pick<SandboxProvider, "releaseScreen">>;
    taskPrompt?: string;
    emitToolCompletions?: boolean;
    defaultModel?: { provider: string; id: string };
    taskModelTiers?: { read: { provider: string; id: string }; strong: { provider: string; id: string } };
    expectModelRun?: boolean;
    pinnedModel?: { provider: string; id: string };
    latestUserText?: string;
    sourcePromptBeforeAnswer?: string;
    closeNegationClassifier?: CloseNegationClassifier;
    resumedModel?: { provider: string; id: string; switches: number };
  } = {},
) {
  const effects: Effect[] = [...(options.initialEffects ?? [])];
  const results: unknown[] = [];
  const scratchpadRows: Array<{
    id: string;
    spaceId: string;
    botId: string;
    userId: string;
    title: string;
    status: string;
    notes: string;
    createdAt: Date;
    updatedAt: Date;
  }> = [];
  const run = {
    id: runId,
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: "user",
    leaseFence: 0,
    autoModelSwitches: 0,
    ...(!options.defaultModel && !options.pinnedModel
      ? { modelPinned: true, modelProvider: "scripted", modelId: "scripted" }
      : {}),
    ...(options.latestUserText ? { sourceMessageId: "source-old" } : {}),
    ...(options.sourcePromptBeforeAnswer ? { sourceMessageId: "source-original" } : {}),
    ...(options.pinnedModel
      ? {
          modelPinned: true,
          modelProvider: options.pinnedModel.provider,
          modelId: options.pinnedModel.id,
        }
      : {}),
    ...(options.resumedModel
      ? {
          modelProvider: options.resumedModel.provider,
          modelId: options.resumedModel.id,
          autoModelSwitches: options.resumedModel.switches,
        }
      : {}),
  };
  const memoryCommit = vi.fn(async () => ({ revision: "rev-1" }));
  const externalEffect = {
    findMany: vi.fn(
      async ({
        where,
      }: {
        where?: {
          id?: string;
          spaceId?: string;
          runId?: string;
          status?: string;
          kind?: string | { in?: string[] };
        };
      } = {}) =>
        effects.filter((effect) => {
          if (where?.status && effect.status !== where.status) return false;
          if (typeof where?.kind === "string" && effect.kind !== where.kind) return false;
          if (typeof where?.kind === "object" && where.kind.in && !where.kind.in.includes(effect.kind)) {
            return false;
          }
          if (where?.spaceId && effect.spaceId !== where.spaceId) return false;
          if (where?.runId && effect.runId && effect.runId !== where.runId) return false;
          if (where?.id && effect.id !== where.id) return false;
          return true;
        }),
    ),
    findUnique: vi.fn(
      async ({ where }: { where: { id?: string; idempotencyKey?: string } }) =>
        effects.find((effect) =>
          where.id ? effect.id === where.id : effect.idempotencyKey === where.idempotencyKey,
        ) ?? null,
    ),
    create: vi.fn(async ({ data }: { data: Omit<Effect, "id"> }) => {
      const effect = { ...data, id: `effect-${effects.length + 1}` };
      effects.push(effect);
      return { ...effect };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Effect> }) => {
      Object.assign(effects.find((effect) => effect.id === where.id)!, data);
    }),
    updateMany: vi.fn(
      async ({ where, data }: { where: { id: string; status: string }; data: Partial<Effect> }) => {
        const effect = effects.find(
          (effect) => effect.id === where.id && effect.status === where.status,
        );
        if (!effect) return { count: 0 };
        Object.assign(effect, data);
        return { count: 1 };
      },
    ),
  };
  const prisma = {
    computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
    modelImageCapability: {
      findUnique: vi.fn(async ({ where }) => ({
        capability: where.userId_provider_modelId_endpointKey.modelId.includes("deepseek")
          ? "text"
          : "vision",
      })),
    },
    spaceBackupModel: {
      findMany: vi.fn(async () =>
        options.taskModelTiers
          ? [
              {
                provider: options.taskModelTiers.strong.provider,
                modelId: options.taskModelTiers.strong.id,
              },
            ]
          : [],
      ),
    },
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: { findUniqueOrThrow: vi.fn(async () => ({ id: run.threadId, groupId: null })) },
    message: {
      findMany: vi.fn(async () => options.sourcePromptBeforeAnswer ? [
        { id: "answered-question", role: "bot", seq: 2, threadId: run.threadId, runId,
          blocks: [{ kind: "ask", text: "What should be closed?", status: "answered", answer: options.taskPrompt }] },
        { id: "source-original", role: "user", seq: 1, threadId: run.threadId, runId,
          blocks: [{ kind: "text", text: options.sourcePromptBeforeAnswer }] },
      ] : options.latestUserText ? [{ id: "source-new", role: "user", seq: 2,
        threadId: run.threadId, createdAt: new Date("2026-01-01T00:00:00Z"),
        blocks: [{ kind: "text", text: options.latestUserText }] }] : []),
      findUnique: vi.fn(async () => ({ seq: 1, clientNonce: null })),
      findFirst: vi.fn(async () => null),
    },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: options.taskPrompt ?? "Update shared state" })),
    },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: {
      findFirst: vi.fn(async () =>
        options.taskModelTiers
          ? {
              modelId: options.defaultModel?.id,
              isDefault: true,
              credential: {
                id: "credential-1",
                provider: options.defaultModel?.provider,
                secretId: "secret-1",
              },
            }
          : null,
      ),
    },
    secret: { findFirst: vi.fn(async () => ({ id: "secret-1", ciphertext: "fake-cipher" })) },
    userModelCredential: {
      findFirst: vi.fn(async () => ({
        id: "credential-1",
        provider: options.defaultModel?.provider ?? options.pinnedModel?.provider ?? "scripted",
        secretId: "secret-1",
      })),
      findMany: vi.fn(async () => (options.taskModelTiers ? [{ provider: "openrouter" }] : [])),
    },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: options.defaultModel?.provider ?? "scripted",
        defaultModelId: options.defaultModel?.id ?? "scripted",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    agentSecret: { findMany: vi.fn(async () => []) },
    botSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: {
      findMany: vi.fn(async () => scratchpadRows),
      create: vi.fn(
        async ({
          data,
        }: {
          data: {
            spaceId: string;
            botId: string;
            userId: string;
            title: string;
            status: string;
            notes: string;
          };
        }) => {
          const now = new Date("2026-09-14T00:00:00.000Z");
          const row = {
            id: `scratch-${scratchpadRows.length + 1}`,
            ...data,
            createdAt: now,
            updatedAt: now,
          };
          scratchpadRows.push(row);
          return row;
        },
      ),
    },
    actionApprovalRule: { findMany: vi.fn(async () => []) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => ({ enabled: false })) },
    externalEffect,
  };
  const pauseRunForInput = vi.fn(async () => {
    run.status = "waiting_input";
    return true;
  });
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  let calls: ToolCall[] = [];
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    for (const call of calls) {
      const result = await request.executeTool!(call.name, call.args, call.executionId);
      results.push(result);
      if (options.emitToolCompletions) {
        await request.onToolCompleted?.({ name: call.name, executionId: call.executionId, durationMs: 1, result });
        // Pi can finish before the consumer drains its queued tool event.
        yield { type: "tool" as const, ...call };
      }
    }
    yield { type: "done" as const, text: "Done" };
  });
  const append = vi.fn(async (_event: { type: string; runId?: string; payload?: Record<string, unknown> }) => undefined);
  const executor = createRunExecutor({
    prisma,
    closeNegationClassifier: options.closeNegationClassifier,
    secretStore: { load: vi.fn(async () => "fake-api-key") },
    taskModelTiers: options.taskModelTiers,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: {
      discoverTools: async () => [],
      resolveCall: async () => undefined,
      execute: async function* () {},
    },
    sandbox: { describe: () => ({ capabilities: { graphical: options.computerKind !== "desktop" } }),
      async *exportWorkspace() {}, ...options.sandbox },
    home: { commit: vi.fn(async () => "fixture-revision") },
    browser: options.browser,
    memory: {
      describe: () => ({ capabilities: {} }),
      read: async () => ({ documents: [] }),
      search: async () => [],
      commit: memoryCommit,
      exportMarkdown: async function* () {},
    },
    memoryProviders: { resolve: async () => null },
    events: { append, pauseRunForInput, finalizeRun },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  return {
    effects,
    results,
    scratchpadRows,
    memoryCommit,
    append,
    runtimeRun,
    runRow: run,
    finalizeRun,
    pauseRunForInput,
    setCalls(next: ToolCall[]) {
      calls = next;
    },
    async run() {
      run.status = "queued";
      mockProvisionedComputerKind.value = options.computerKind ?? "desktop";
      try {
        await executor.continueRun(run.id, "worker-1");
      } finally {
        mockProvisionedComputerKind.value = "desktop";
      }
      if (options.expectModelRun === false) expect(runtimeRun).not.toHaveBeenCalled();
      else
        expect(
          runtimeRun,
          JSON.stringify({ finalize: finalizeRun.mock.calls, pause: pauseRunForInput.mock.calls }),
        ).toHaveBeenCalled();
      expect(prisma.attempt.update).not.toHaveBeenCalled();
      if (!options.allowFailedOutcome) {
        expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
      }
    },
  };
}

describe("mutating tool effect idempotency keys", () => {
  it("retains the selected vision model and remaining switch budget across resume", async () => {
    const text = { provider: "openrouter", id: "deepseek/deepseek-v4-flash-0731" };
    const vision = { provider: "openrouter", id: "openai/gpt-4o" };
    const f = fixture("run-resumed-model", {
      defaultModel: text,
      taskModelTiers: { read: text, strong: vision },
      resumedModel: { ...vision, switches: 2 },
    });
    await f.run();
    const request = f.runtimeRun.mock.calls[0]![0];
    expect(request.model).toMatchObject(vision);
    expect(request.maxFallbackSwitches).toBe(0);
    expect(f.runRow.autoModelSwitches).toBe(2);
  });
  it("honors a high-confidence prohibition without executing tools or asking again", async () => {
    const classify = vi.fn(async () => "prohibited" as const);
    const f = fixture("run-prohibition", {
      taskPrompt: "ห้ามใช้ shell หรือ kill เพื่อปิดหน้าต่าง",
      closeNegationClassifier: classify,
      expectModelRun: false,
    });
    await f.run();
    expect(classify).toHaveBeenCalledOnce();
    expect(f.effects).toEqual([]);
    expect(f.pauseRunForInput).not.toHaveBeenCalled();
    expect(f.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
  });
  it.each([undefined, async () => "uncertain" as const])(
    "asks before any model/tool call when negation is unresolved",
    async (classifier) => {
      const f = fixture("run-negation-uncertain", {
        taskPrompt: "ห้ามใช้ shell หรือ kill เพื่อปิดหน้าต่าง",
        closeNegationClassifier: classifier,
        expectModelRun: false,
      });
      await f.run();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
      expect(f.effects).toEqual([]);
    },
  );
  it("uses the active follow-up prompt for vision routing as well as closure scope", async () => {
    const text = { provider: "openrouter", id: "deepseek/deepseek-v4-flash-0731" };
    const vision = { provider: "openrouter", id: "openai/gpt-4o" };
    const tabClose = vi.fn(async () => ({ ok: true }));
    const f = fixture("run-followup-close", { computerKind: "container", taskPrompt: "Read a file",
      latestUserText: "Close window 0x00000001 and preserve the other windows",
      defaultModel: text, taskModelTiers: { read: text, strong: vision }, allowFailedOutcome: true,
      browser: { describe: () => ({ capabilities: { page: true } }), tabClose } });
    f.setCalls([{ name: "browser_tab_close", args: { targetId: "target" }, executionId: "wrong-scope" }]);
    await f.run();
    expect(f.runtimeRun.mock.calls[0]?.[0]).toMatchObject({ model: vision });
    expect(tabClose).not.toHaveBeenCalled();
  });

  it("keeps an explicitly pinned text-only model and asks for a model change", async () => {
    const text = { provider: "openrouter", id: "deepseek/deepseek-v4-flash-0731" };
    const vision = { provider: "openrouter", id: "openai/gpt-4o" };
    const f = fixture("run-pinned-text-desktop", { computerKind: "container", taskPrompt: "Close window 0x00000001",
      defaultModel: text, pinnedModel: text, taskModelTiers: { read: text, strong: vision },
      expectModelRun: false, allowFailedOutcome: true });
    await f.run();
    expect(f.runRow).toMatchObject({
      modelPinned: true,
      modelProvider: text.provider,
      modelId: text.id,
    });
    expect(f.pauseRunForInput).toHaveBeenCalled();
    expect(f.finalizeRun).not.toHaveBeenCalled();
  });

  it("does not substitute a browser-tab close for a requested OS-window close", async () => {
    const tabClose = vi.fn(async () => ({ ok: true }));
    const f = fixture("run-wrong-close-scope", { computerKind: "container",
      taskPrompt: "Close window 0x00000001 and preserve all other windows", allowFailedOutcome: true,
      browser: { describe: () => ({ capabilities: { page: true } }), tabClose } });
    f.setCalls([{ name: "browser_tab_close", args: { targetId: "target-one" }, executionId: "wrong-scope" }]);
    await f.run();
    expect(tabClose).not.toHaveBeenCalled();
    expect(f.results).toContainEqual(expect.objectContaining({ error: expect.stringContaining("OS window"), fallback: "computer_act" }));
    expect(f.effects.some((effect) => effect.kind === "browser_tab_close")).toBe(false);
  });

  it("pauses before calling a text-only model when no vision alternative can close an OS window", async () => {
    const f = fixture("run-no-vision", {
      computerKind: "container",
      taskPrompt: "Close window 0x00000001",
      defaultModel: { provider: "openrouter", id: "deepseek/deepseek-v4-flash-0731" },
      expectModelRun: false, allowFailedOutcome: true });
    await f.run();
    expect(f.pauseRunForInput).toHaveBeenCalled();
    expect(f.finalizeRun).not.toHaveBeenCalled();
  });

  it("keeps a text-only Auto model for a browser-tab task that does not require desktop tools", async () => {
    const text = { provider: "openrouter", id: "deepseek/deepseek-v4-flash-0731" };
    const f = fixture("run-page-without-vision", {
      computerKind: "container",
      taskPrompt: "Close the secondary browser tab",
      defaultModel: text,
      allowFailedOutcome: true,
    });
    f.setCalls([
      {
        name: "computer_act",
        args: { actions: [{ kind: "click", x: 10, y: 10 }] },
        executionId: "blind-act",
      },
    ]);
    await f.run();
    const request = f.runtimeRun.mock.calls[0]?.[0];
    expect(request).toMatchObject({ model: text });
    expect(request.model.acceptsImages).toBe(false);
    expect(request.tools.map((tool) => tool.name)).toContain("computer_observe");
    expect(f.results).toContainEqual(expect.objectContaining({ failedBeforeDispatch: true }));
    expect(f.effects.some((effect) => effect.kind === "computer_act")).toBe(false);
  });

  it.each([
    "Close only window 0x00000001 and keep the other windows open",
    "ปิดเฉพาะหน้าต่าง XID 0x00000001 โดยใช้ computer_observe และ computer_act",
  ])("routes an Auto desktop-close task to the configured vision tier: %s", async (taskPrompt) => {
    const vision = { provider: "openrouter", id: "openai/gpt-4o" };
    const text = { provider: "openrouter", id: "deepseek/deepseek-v4-flash-0731" };
    const f = fixture("run-desktop-vision", { computerKind: "container", taskPrompt,
      defaultModel: text, taskModelTiers: { read: text, strong: vision }, allowFailedOutcome: true });
    await f.run();
    const request = f.runtimeRun.mock.calls[0]?.[0];
    expect(request).toMatchObject({ model: { provider: vision.provider, id: vision.id } });
    expect(request.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["computer_observe", "computer_act"]));
  });
  it.each(["unknown", "validempty", "validnonempty"] as const)("persists actual executor close verification for %s inventory", async (status) => {
    const now = Date.now();
    const identity = { computerId: "computer-1", botId: "bot-1", screenId: "bot-1",
      display: ":1", generation: 2, profile: "/synthetic/profile", profileFingerprint: "fingerprint",
      leaseId: "run-close-audit:1" };
    const before = { frameId: "before", capturedAt: new Date(now - 1000).toISOString(),
      windowInventoryFreshness: new Date(now - 1000).toISOString(), windowInventoryStatus: "validnonempty" as const,
      windows: [{ id: "0x00000001", pid: 123, wmClass: status === "validnonempty" ? "FixtureApp" : "chromium", isCurrentProfile: status !== "validnonempty" },
        ...(status === "validnonempty" ? [{ id: "0x00000002", pid: 456, wmClass: "Chromium", isCurrentProfile: true }] : [])],
      activeWindow: { id: "0x00000001", title: "Fixture", pid: 123, isCurrentProfile: status !== "validnonempty" }, screenIdentity: identity,
      mimeType: "image/png" as const, image: new Uint8Array([0]), width: 100, height: 100 };
    const after = { ...before, frameId: "after", capturedAt: new Date(now).toISOString(),
      windowInventoryFreshness: new Date(now).toISOString(), windowInventoryStatus: status,
      windows: status === "validempty" ? [] : status === "validnonempty" ? [before.windows[1]!] : undefined, activeWindow: undefined };
    const sandbox = { observe: vi.fn(async () => before),
      act: vi.fn(async () => ({ completed: 1, observation: after })), releaseScreen: vi.fn(async () => undefined) };
    const f = fixture("run-close-audit", { computerKind: "container", sandbox,
      emitToolCompletions: true, allowFailedOutcome: true,
      sourcePromptBeforeAnswer: status === "validnonempty" ? "ห้ามใช้ browser tool หรือ kill โปรแกรม" : undefined,
      taskPrompt: "Close only window 0x00000001 and verify its disappearance" });
    f.setCalls([{ name: "computer_observe", args: {}, executionId: "observe-1" },
      { name: "computer_act", args: { actions: [{ kind: "key", key: "F4", modifiers: ["Alt"] }] }, executionId: "close-1" }]);
    await f.run();
    expect(sandbox.act).toHaveBeenCalledTimes(1);
    expect(f.pauseRunForInput).not.toHaveBeenCalled();
    expect(f.runtimeRun.mock.calls[0]![0].tools.map((tool) => tool.name).some((name) => name.startsWith("browser_"))).toBe(false);
    const audits = f.append.mock.calls.map(([event]) => event);
    for (const executionId of ["observe-1", "close-1"]) {
      const called = audits.findIndex((event) => event.type === "agent.tool.called" && event.payload?.executionId === executionId);
      const done = audits.findIndex((event) => event.type === "agent.tool.completed" && event.payload?.executionId === executionId);
      expect(called).toBeGreaterThanOrEqual(0);
      expect(done).toBeGreaterThan(called);
      expect(audits.filter((event) => event.type === "agent.tool.called" && event.payload?.executionId === executionId)).toHaveLength(1);
    }
    const observeAudit = f.append.mock.invocationCallOrder[audits.findIndex((event) => event.type === "agent.tool.called" && event.payload?.executionId === "observe-1")]!;
    expect(observeAudit).toBeLessThan(sandbox.observe.mock.invocationCallOrder[0]!);
    const observed = f.append.mock.calls.map(([event]) => event).find((event) =>
      event?.type === "agent.tool.completed" && event.payload?.executionId === "observe-1");
    expect(observed).toMatchObject({ payload: {
      activeWindow: { id: "0x00000001", isCurrentProfile: status !== "validnonempty" },
      screenLeaseDigest: createHash("sha256").update(identity.leaseId).digest("hex"),
    } });
    expect(JSON.stringify(observed)).not.toContain(identity.leaseId);
    const completion = f.append.mock.calls.map(([event]) => event).find((event) =>
      event?.type === "agent.tool.completed" && event.payload?.executionId === "close-1");
    expect(completion).toMatchObject({ runId: "run-close-audit", payload: {
      name: "computer_act", windowInventoryStatus: status,
      windowCloseVerification: { verified: status !== "unknown" },
    } });
    const proof = completion?.payload?.windowCloseVerification as { reason?: string; focusProofSatisfied?: boolean } | undefined;
    if (status === "unknown") {
      expect(proof?.reason).toMatch(/unknown/);
    } else {
      expect(proof?.focusProofSatisfied).toBe(true);
    }
    if (status === "unknown") expect(sandbox.releaseScreen).toHaveBeenCalledOnce();
    else {
      expect(f.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
      expect(sandbox.releaseScreen).not.toHaveBeenCalled();
    }
  });

  it("resumes a retryable navigation with one fresh request, then enforces the restored budget", async () => {
    const runId = "run-navigation-resume";
    const request = { url: "https://fixture.test/limited" };
    const originalKey = toolEffectIdempotencyKey(runId, "browser_navigate", request);
    const priorFailure: Effect = {
      id: "effect-prior-429",
      spaceId: "space-1",
      runId,
      kind: "browser_navigate",
      idempotencyKey: originalKey,
      status: "completed",
      request,
      result: {
        ok: false,
        url: request.url,
        title: "Rate limited",
        error: "HTTP 429",
        httpStatus: 429,
        retryable: true,
      },
    };
    const browser = {
      describe: () => ({ capabilities: { page: true, refs: true } }),
      navigate: vi.fn(async () => ({
        ok: false,
        url: request.url,
        title: "Rate limited",
        error: "HTTP 429",
        httpStatus: 429,
        retryable: true,
      })),
      snapshot: vi.fn(),
      act: vi.fn(),
    };
    const f = fixture(runId, {
      computerKind: "container",
      browser,
      initialEffects: [priorFailure],
      allowFailedOutcome: true,
    });
    f.setCalls([
      { name: "browser_navigate", args: request, executionId: "resume-call-1" },
      { name: "browser_navigate", args: request, executionId: "resume-call-2" },
    ]);

    await f.run();

    expect(browser.navigate).toHaveBeenCalledTimes(1);
    expect(f.effects.map((effect) => effect.idempotencyKey)).toEqual([
      originalKey,
      toolEffectIdempotencyKey(runId, "browser_navigate", request, 1),
    ]);
    expect(f.effects[1]?.result).toEqual(expect.objectContaining({ httpStatus: 429, retryable: true }));
    expect(f.results[0]).toEqual(expect.objectContaining({ httpStatus: 429, retryable: true }));
    expect(f.results[1]).toEqual(
      expect.objectContaining({ ok: false, errorCode: "RETRY_LIMIT_EXCEEDED", retryable: false }),
    );
  });

  it("executes different tools that share a reused provider tool-call id", async () => {
    const f = fixture("run-a");
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "team preference" },
        executionId: "call_0",
      },
      {
        name: "scratchpad_add",
        args: { title: "follow up with design" },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.scratchpadRows).toHaveLength(1);
    expect(f.effects.map((effect) => effect.idempotencyKey)).toEqual([
      toolEffectIdempotencyKey("run-a", "remember", {
        path: "MEMORY.md",
        content: "team preference",
      }),
      toolEffectIdempotencyKey("run-a", "scratchpad_add", {
        title: "follow up with design",
      }),
    ]);
    expect(f.effects.every((effect) => effect.status === "completed")).toBe(true);
    expect(f.results[0]).toEqual({ ok: true });
    expect(f.results[1]).toEqual(
      expect.objectContaining({
        item: expect.objectContaining({ title: "follow up with design" }),
      }),
    );
  });

  it("executes the same provider tool-call id on different runs", async () => {
    const first = fixture("run-1");
    first.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "first bot note" },
        executionId: "call_0",
      },
    ]);
    await first.run();

    const second = fixture("run-2");
    // Shared ExternalEffect table: prior completed rows remain visible by idempotency key.
    second.effects.push(...first.effects);
    second.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "second bot note" },
        executionId: "call_0",
      },
    ]);
    await second.run();

    expect(second.memoryCommit).toHaveBeenCalledOnce();
    expect(second.effects.map((effect) => effect.idempotencyKey)).toEqual([
      toolEffectIdempotencyKey("run-1", "remember", {
        path: "MEMORY.md",
        content: "first bot note",
      }),
      toolEffectIdempotencyKey("run-2", "remember", {
        path: "MEMORY.md",
        content: "second bot note",
      }),
    ]);
    expect(second.results[0]).toEqual({ ok: true });
  });

  it("replays a true retry of the same effect without re-executing", async () => {
    const f = fixture("run-retry");
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "durable fact" },
        executionId: "call_0",
      },
    ]);
    await f.run();
    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(1);

    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "durable fact" },
        executionId: "call_0",
      },
    ]);
    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(1);
    expect(f.effects[0]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-retry", "remember", {
        path: "MEMORY.md",
        content: "durable fact",
      }),
    );
    expect(f.results[1]).toEqual({ ok: true });
  });

  it("replays the same logical effect when restart assigns a new tool-call id", async () => {
    const f = fixture("run-replay-id");
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "durable fact" },
        executionId: "toolu_abc",
      },
    ]);
    await f.run();
    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(1);

    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "durable fact" },
        executionId: "toolu_xyz",
      },
    ]);
    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(1);
    expect(f.effects[0]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-replay-id", "remember", {
        path: "MEMORY.md",
        content: "durable fact",
      }),
    );
    expect(f.results[1]).toEqual({ ok: true });
  });

  it("executes the same tool twice in one run when args differ but the provider id is reused", async () => {
    const f = fixture("run-args");
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "first fact" },
        executionId: "call_0",
      },
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "second fact" },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledTimes(2);
    expect(f.effects).toHaveLength(2);
    expect(f.effects[0]?.idempotencyKey).not.toBe(f.effects[1]?.idempotencyKey);
    expect(f.results).toEqual([{ ok: true }, { ok: true }]);
  });

  it("replays a legacy bare provider idempotency key for the same run and tool", async () => {
    const f = fixture("run-legacy");
    f.effects.push({
      id: "legacy-1",
      spaceId: "space-1",
      runId: "run-legacy",
      kind: "remember",
      idempotencyKey: "call_0",
      status: "completed",
      request: { path: "MEMORY.md", content: "legacy fact" },
      result: { ok: true, legacy: true },
    });
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "legacy fact" },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.effects).toHaveLength(1);
    expect(f.results[0]).toEqual({ ok: true, legacy: true });
  });

  it("replays a legacy scoped key that included the provider tool-call id", async () => {
    const args = { path: "MEMORY.md", content: "legacy scoped fact" };
    const f = fixture("run-legacy-scoped");
    f.effects.push({
      id: "legacy-scoped-1",
      spaceId: "space-1",
      runId: "run-legacy-scoped",
      kind: "remember",
      idempotencyKey: legacyScopedToolEffectIdempotencyKey(
        "run-legacy-scoped",
        "remember",
        "call_0",
        args,
      ),
      status: "completed",
      request: args,
      result: { ok: true, legacy: true },
    });
    f.setCalls([
      {
        name: "remember",
        args,
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.effects).toHaveLength(1);
    expect(f.results[0]).toEqual({ ok: true, legacy: true });
  });

  it("does not reuse an incomplete legacy effect when the request differs", async () => {
    const f = fixture("run-legacy-mismatch");
    f.effects.push({
      id: "legacy-open",
      spaceId: "space-1",
      runId: "run-legacy-mismatch",
      kind: "remember",
      idempotencyKey: "call_0",
      status: "intended",
      request: { path: "MEMORY.md", content: "old fact" },
    });
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "new fact" },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(2);
    expect(f.effects[1]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-legacy-mismatch", "remember", {
        path: "MEMORY.md",
        content: "new fact",
      }),
    );
    expect(f.results[0]).toEqual({ ok: true });
  });

  it("executes two identical-args mutating calls in one live run", async () => {
    const args = { path: "MEMORY.md", content: "same fact" };
    const f = fixture("run-live-repeat");
    f.setCalls([
      { name: "remember", args, executionId: "call_a" },
      { name: "remember", args, executionId: "call_b" },
    ]);

    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledTimes(2);
    expect(f.effects).toHaveLength(2);
    expect(f.effects[0]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-live-repeat", "remember", args),
    );
    expect(f.effects[1]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-live-repeat", "remember", args, 1),
    );
    expect(f.results).toEqual([{ ok: true }, { ok: true }]);
  });

  it("replays a legacy scoped key when restart assigns a new tool-call id", async () => {
    const args = { path: "MEMORY.md", content: "legacy scoped fact" };
    const f = fixture("run-legacy-new-id");
    f.effects.push({
      id: "legacy-scoped-old-id",
      spaceId: "space-1",
      runId: "run-legacy-new-id",
      kind: "remember",
      idempotencyKey: legacyScopedToolEffectIdempotencyKey(
        "run-legacy-new-id",
        "remember",
        "call_old",
        args,
      ),
      status: "completed",
      request: args,
      result: { ok: true, legacy: true },
    });
    f.setCalls([
      {
        name: "remember",
        args,
        executionId: "call_new",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.effects).toHaveLength(1);
    expect(f.results[0]).toEqual({ ok: true, legacy: true });
  });
});
