import type { ComputerObservation } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { createThreadScreenPublisher } from "./thread-screen.js";

const observation: ComputerObservation = {
  frameId: "frame-1",
  capturedAt: "2026-01-01T00:00:00.000Z",
  mimeType: "image/png",
  image: new Uint8Array([1, 2, 3]),
  width: 1280,
  height: 800,
};

function fixture() {
  const controller = new AbortController();
  const block = {
    kind: "image" as const,
    artifactId: "artifact-1",
    name: "computer-screen.png",
    mimeType: "image/png",
  };
  const attach = vi.fn().mockResolvedValue(block);
  const publish = vi.fn().mockResolvedValue(undefined);
  const describeError = vi.fn().mockReturnValue("capture failed (redacted)");
  const send = createThreadScreenPublisher({
    signal: controller.signal,
    attach,
    publish,
    describeError,
  });
  return { controller, block, attach, publish, describeError, send };
}

describe("computer screenshots in native threads", () => {
  it("persists actual bytes through private artifacts before publishing an image block", async () => {
    const f = fixture();
    await f.send(async () => observation, "run-1:action-1");
    expect(f.attach).toHaveBeenCalledWith(observation, "run-1:action-1");
    expect(f.publish).toHaveBeenCalledWith([f.block], "computer-screen:run-1:action-1");
    expect(f.attach.mock.invocationCallOrder[0]).toBeLessThan(
      f.publish.mock.invocationCallOrder[0]!,
    );
  });

  it("skips repeated observe frames but attaches a fresh frame after every action", async () => {
    const f = fixture();
    await f.send(async () => observation, "action-1", true);
    await f.send(async () => observation, "observe-1");
    await f.send(async () => observation, "action-2", true);
    expect(f.publish).toHaveBeenCalledTimes(2);
    expect(f.publish).toHaveBeenLastCalledWith([f.block], "computer-screen:action-2");
  });

  it.each(["capture", "attach"])(
    "reports %s failure without repeating the action or leaking its error",
    async (stage) => {
      const f = fixture();
      const error = new Error("sensitive backend detail");
      const capture = vi.fn().mockResolvedValue(observation);
      if (stage === "capture") capture.mockRejectedValue(error);
      else f.attach.mockRejectedValue(error);
      await expect(f.send(capture, "action-1", true)).resolves.toBeUndefined();
      expect(capture).toHaveBeenCalledOnce();
      expect(f.describeError).toHaveBeenCalledWith(error);
      expect(f.publish).toHaveBeenCalledWith(
        [{ kind: "text", text: "Computer screenshot unavailable: capture failed (redacted)" }],
        "computer-screen-error:action-1",
      );
    },
  );

  it("does not capture or publish after stop aborts the run", async () => {
    const f = fixture();
    const capture = vi.fn().mockResolvedValue(observation);
    f.controller.abort();
    await expect(f.send(capture, "action-1")).rejects.toThrow();
    expect(capture).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("does not retry a completed action when thread persistence is unavailable", async () => {
    const f = fixture();
    f.publish.mockRejectedValue(new Error("database unavailable"));
    const capture = vi.fn().mockResolvedValue(observation);
    await expect(f.send(capture, "action-1", true)).resolves.toBeUndefined();
    expect(capture).toHaveBeenCalledOnce();
    expect(f.attach).toHaveBeenCalledOnce();
  });

  it("does not publish a frame if stop arrives while capture is pending", async () => {
    const f = fixture();
    await expect(
      f.send(async () => {
        f.controller.abort();
        return observation;
      }, "action-1"),
    ).rejects.toThrow();
    expect(f.attach).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });
});
