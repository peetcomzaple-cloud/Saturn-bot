import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcileApprovalReminders } from "./approval-reminders.js";

vi.mock("@rakazo/db", () => ({
  createThreadMessageInTransaction: vi.fn(async () => ({ id: "message-1" })),
  appendEventInTransaction: vi.fn(async () => ({ seq: 3 })),
}));
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "approval-test-"));
  directories.push(dataDir);
  const effect = {
    id: "effect-1",
    kind: "browser_navigate",
    spaceId: "space-1",
    runId: "run-1",
    run: { id: "run-1", threadId: "thread-1", botId: "bot-1", userId: "user-1" },
    request: { key: "never-copy-this-key" },
  };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    externalEffect: { findFirst: vi.fn(async () => ({ id: effect.id })) },
    message: {
      findMany: vi.fn(async () => [
        { blocks: [{ kind: "ask", approvalEffectId: effect.id, status: "pending" }] },
      ]),
      findFirst: vi.fn(async () => null),
    },
  };
  const prisma = {
    externalEffect: { findMany: vi.fn(async () => [effect]) },
    $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
  } as unknown as PrismaClient;
  const notify = vi.fn(async () => undefined);
  return { dataDir, tx, prisma, notify, events: { notify } as unknown as ThreadEvents };
}

describe("native approval reminders", () => {
  it("queries waits older than ten seconds, publishes to that thread, and logs metadata only", async () => {
    const f = await fixture();
    const now = new Date("2026-01-01T00:00:15Z");
    await reconcileApprovalReminders(f, now);
    expect(f.prisma.externalEffect.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: "intended",
          run: { status: "waiting_input", updatedAt: { lt: new Date("2026-01-01T00:00:05Z") } },
        },
        select: expect.not.objectContaining({
          request: expect.anything(),
          result: expect.anything(),
        }),
      }),
    );
    expect(f.notify).toHaveBeenCalledWith("thread-1", 3);
    const log = await readFile(path.join(f.dataDir, "audit.log"), "utf8");
    expect(JSON.parse(log)).toMatchObject({
      event: "approval.pending",
      kind: "browser_navigate",
      effectId: "effect-1",
    });
    expect(log).not.toContain("never-copy-this-key");
    if (process.platform !== "win32")
      expect((await stat(path.join(f.dataDir, "audit.log"))).mode & 0o777).toBe(0o600);
  });
  it.each(["answered", "duplicate", "no-card"])("does not remind an %s approval", async (mode) => {
    const f = await fixture();
    if (mode === "answered") f.tx.externalEffect.findFirst.mockResolvedValue(null as never);
    if (mode === "duplicate") f.tx.message.findFirst.mockResolvedValue({ id: "old" } as never);
    if (mode === "no-card") f.tx.message.findMany.mockResolvedValue([]);
    await reconcileApprovalReminders(f);
    expect(f.notify).not.toHaveBeenCalled();
    await expect(readFile(path.join(f.dataDir, "audit.log"))).rejects.toThrow();
  });
});
