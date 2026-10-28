import type { AgentRuntimeEvent, AgentToolCompletion } from "@rakazo/adapter-kit";

/** Only standalone commands qualify; instructions involving other work use the native model. */
export function isDirectFileListing(prompt: string): boolean {
  return /^(?:list files|list_files|ลิสต์ไฟล์|แสดงรายการไฟล์)\s*[.!]?$/i.test(prompt.trim());
}

export async function* directFileListingEvents(deps: {
  runId: string;
  signal: AbortSignal;
  execute: (name: string, args: Record<string, unknown>, executionId: string) => Promise<unknown>;
  completed: (completion: AgentToolCompletion) => Promise<void>;
}): AsyncIterable<AgentRuntimeEvent> {
  const executionId = `${deps.runId}:direct-list-files`;
  const checkStopped = () => {
    if (deps.signal.aborted) throw new Error("File listing was aborted");
  };
  checkStopped();
  yield { type: "tool", name: "list_files", args: { path: "" }, executionId };
  checkStopped();
  const startedAt = Date.now();
  let result: unknown;
  let error: unknown;
  try {
    result = await deps.execute("list_files", { path: "" }, executionId);
  } catch (failure) {
    error = failure;
  }
  // Audit failures must not retry the filesystem operation or hide its result.
  await deps
    .completed({
      name: "list_files",
      executionId,
      durationMs: Date.now() - startedAt,
      ...(result === undefined ? {} : { result }),
      ...(error === undefined ? {} : { error }),
    })
    .catch(() => undefined);
  checkStopped();
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  if (error !== undefined || record.error) {
    const detail = error instanceof Error ? error.message : String(error ?? record.error);
    yield { type: "done", text: `File listing failed: ${detail.slice(0, 500)}` };
    return;
  }
  if (!Array.isArray(record.entries)) throw new Error("File listing returned no entries");
  const filenames = record.entries.map((entry: { path: string }) => entry.path);
  yield { type: "done", text: filenames.length ? filenames.join("\n") : "Workspace is empty." };
}
