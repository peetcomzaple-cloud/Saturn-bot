import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { MessageBlock } from "@rakazo/contracts";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { appendEventInTransaction, createThreadMessageInTransaction } from "@rakazo/db";

export const APPROVAL_REMINDER_AFTER_MS = 10_000;

/** Uses native pending effects and thread events; it never reads tool arguments. */
export async function reconcileApprovalReminders(
  deps: { prisma: PrismaClient; events: ThreadEvents; dataDir: string },
  now = new Date(),
) {
  const effects = await deps.prisma.externalEffect.findMany({
    where: {
      status: "intended",
      run: {
        status: "waiting_input",
        updatedAt: { lt: new Date(now.getTime() - APPROVAL_REMINDER_AFTER_MS) },
      },
    },
    orderBy: { createdAt: "asc" },
    take: 100,
    select: {
      id: true,
      kind: true,
      spaceId: true,
      runId: true,
      run: { select: { id: true, threadId: true, botId: true, userId: true } },
    },
  });
  for (const effect of effects) {
    const clientNonce = `approval-reminder:${effect.id}`;
    const committed = await deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM external_effects WHERE id = ${effect.id} FOR UPDATE`;
      const current = await tx.externalEffect.findFirst({
        where: {
          id: effect.id,
          spaceId: effect.spaceId,
          status: "intended",
          run: { status: "waiting_input" },
        },
        select: { id: true },
      });
      if (!current) return null;
      // A human question/secret request is not an action approval. Require the real card.
      const asks = await tx.message.findMany({
        where: { threadId: effect.run.threadId, runId: effect.runId, role: "bot" },
        select: { blocks: true },
      });
      const pending = asks.some(
        (message) =>
          Array.isArray(message.blocks) &&
          message.blocks.some(
            (block) =>
              block &&
              typeof block === "object" &&
              "kind" in block &&
              block.kind === "ask" &&
              "approvalEffectId" in block &&
              block.approvalEffectId === effect.id &&
              "status" in block &&
              block.status === "pending",
          ),
      );
      if (
        !pending ||
        (await tx.message.findFirst({
          where: { threadId: effect.run.threadId, clientNonce },
          select: { id: true },
        }))
      )
        return null;
      // Only metadata may reach the file. Never include request, result, prompt, or credentials.
      const kind = effect.kind.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
      const blocks: MessageBlock[] = [{ kind: "text", text: `Approval pending: ${kind}.` }];
      await mkdir(deps.dataDir, { recursive: true, mode: 0o700 });
      await appendFile(
        path.join(deps.dataDir, "audit.log"),
        JSON.stringify({
          at: now.toISOString(),
          event: "approval.pending",
          effectId: effect.id,
          runId: effect.runId,
          botId: effect.run.botId,
          kind,
        }) + "\n",
        { mode: 0o600 },
      );
      const message = await createThreadMessageInTransaction(tx, {
        threadId: effect.run.threadId,
        botId: effect.run.botId,
        runId: effect.runId,
        role: "bot",
        blocks,
        clientNonce,
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: effect.spaceId,
        threadId: effect.run.threadId,
        botId: effect.run.botId,
        runId: effect.runId,
        type: "thread.message.created",
        payload: { messageId: message.id, role: "bot", blocks },
      });
      return { threadId: effect.run.threadId, seq: event.seq };
    });
    if (committed) await deps.events.notify(committed.threadId, committed.seq);
  }
}
