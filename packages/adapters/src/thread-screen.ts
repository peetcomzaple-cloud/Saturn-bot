import type { ComputerObservation } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";

/** Publish through the existing private artifact and thread stores, never a public URL. */
export function createThreadScreenPublisher(deps: {
  signal: AbortSignal;
  attach: (observation: ComputerObservation, operationId: string) => Promise<MessageBlock>;
  publish: (blocks: MessageBlock[], clientNonce: string) => Promise<unknown>;
  describeError: (error: unknown) => string;
}) {
  let lastPublishedFrameId: string | undefined;
  return async (
    capture: () => Promise<ComputerObservation>,
    operationId: string,
    force = false,
  ): Promise<void> => {
    deps.signal.throwIfAborted();
    try {
      const observation = await capture();
      deps.signal.throwIfAborted();
      if (!force && observation.frameId === lastPublishedFrameId) return;
      const block = await deps.attach(observation, operationId);
      deps.signal.throwIfAborted();
      await deps.publish([block], `computer-screen:${operationId}`);
      lastPublishedFrameId = observation.frameId;
    } catch (error) {
      deps.signal.throwIfAborted();
      // A screenshot failure must not turn a successful click/type into a retry.
      // Persist a bounded, redacted error without discarding the action result.
      await deps
        .publish(
          [
            {
              kind: "text",
              text: `Computer screenshot unavailable: ${deps.describeError(error).slice(0, 300)}`,
            },
          ],
          `computer-screen-error:${operationId}`,
        )
        .catch(() => undefined);
    }
  };
}
