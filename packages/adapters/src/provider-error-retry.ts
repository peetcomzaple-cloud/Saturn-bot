import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

/** Retry only an opaque provider error before ANY text, thinking, or tool-call output. */
export function retryEmptyProviderError(
  initial: AssistantMessageEventStream,
  restart: () => AssistantMessageEventStream,
  model: Model<Api>,
  signal?: AbortSignal,
): AssistantMessageEventStream {
  const output = new AssistantMessageEventStream();
  let last: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    timestamp: Date.now(),
  };
  const work = async () => {
    let stream = initial;
    for (let attempt = 0; attempt < 2; attempt++) {
      let partial = false;
      let retry = false;
      for await (const event of stream) {
        last =
          event.type === "done"
            ? event.message
            : event.type === "error"
              ? event.error
              : event.partial;
        const content = last.content;
        partial ||=
          content.length > 0 ||
          ("delta" in event && event.delta.length > 0) ||
          event.type === "toolcall_start";
        const errCandidate =
          event.type === "error"
            ? (event.error?.errorMessage ||
              (event.error as { message?: string } | undefined)?.message ||
              last.errorMessage ||
              "")
            : "";
        if (
          event.type === "error" &&
          !partial &&
          attempt === 0 &&
          !signal?.aborted &&
          /finish_reason:\s*error/i.test(errCandidate.trim())
        ) {
          retry = true;
          break;
        }
        output.push(event);
        if (event.type === "done" || event.type === "error") {
          output.end(last);
          return;
        }
      }
      if (!retry) throw new Error("Model stream ended without a terminal event");
      signal?.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      stream = restart();
    }
  };
  void work().catch((error) => {
    const aborted = signal?.aborted;
    const failure: AssistantMessage = {
      ...last,
      stopReason: aborted ? "aborted" : "error",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
    output.push({ type: "error", reason: aborted ? "aborted" : "error", error: failure });
    output.end(failure);
  });
  return output;
}
