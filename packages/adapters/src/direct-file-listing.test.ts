import { describe, expect, it, vi } from "vitest";
import { directFileListingEvents, isDirectFileListing } from "./direct-file-listing.js";

describe("direct native workspace listing", () => {
  it("recognizes only a standalone listing, including Thai", () => {
    for (const prompt of ["list files", " List files. ", "list_files", "ลิสต์ไฟล์", "แสดงรายการไฟล์"])
      expect(isDirectFileListing(prompt)).toBe(true);
    for (const prompt of [
      "list files then delete them",
      "list files /etc",
      "Read file notes.txt",
      "Do not list files",
    ])
      expect(isDirectFileListing(prompt)).toBe(false);
  });

  const setup = () => ({
    runId: "run-1",
    signal: new AbortController().signal,
    execute: vi.fn().mockResolvedValue({ entries: [{ path: "notes.txt" }, { path: "project/" }] }),
    completed: vi.fn().mockResolvedValue(undefined),
  });
  async function collect(deps: ReturnType<typeof setup>) {
    const events = [];
    for await (const event of directFileListingEvents(deps)) events.push(event);
    return events;
  }
  it("uses the native tool at workspace root once and returns actual names without a model", async () => {
    const deps = setup();
    expect(await collect(deps)).toEqual([
      {
        type: "tool",
        name: "list_files",
        args: { path: "" },
        executionId: "run-1:direct-list-files",
      },
      { type: "done", text: "notes.txt\nproject/" },
    ]);
    expect(deps.execute).toHaveBeenCalledExactlyOnceWith(
      "list_files",
      { path: "" },
      "run-1:direct-list-files",
    );
    expect(deps.completed).toHaveBeenCalledOnce();
  });
  it("reports a tool failure with its message", async () => {
    const deps = setup();
    deps.execute.mockRejectedValue(new Error("sandbox unavailable"));
    expect((await collect(deps)).at(-1)).toEqual({
      type: "done",
      text: "File listing failed: sandbox unavailable",
    });
  });
  it("does not repeat a successful read when auditing fails", async () => {
    const deps = setup();
    deps.completed.mockRejectedValue(new Error("audit unavailable"));
    expect((await collect(deps)).at(-1)).toHaveProperty("text", "notes.txt\nproject/");
    expect(deps.execute).toHaveBeenCalledOnce();
  });
  it("does not execute after stop, including between the tool event and dispatch", async () => {
    const deps = setup();
    const controller = new AbortController();
    deps.signal = controller.signal;
    const events = directFileListingEvents(deps)[Symbol.asyncIterator]();
    await events.next();
    controller.abort();
    await expect(events.next()).rejects.toThrow(/aborted/);
    expect(deps.execute).not.toHaveBeenCalled();
  });
  it("does not publish a result if stop occurs during the read", async () => {
    const deps = setup();
    const controller = new AbortController();
    deps.signal = controller.signal;
    deps.execute.mockImplementation(async () => {
      controller.abort();
      return { entries: [] };
    });
    await expect(collect(deps)).rejects.toThrow(/aborted/);
  });
});
