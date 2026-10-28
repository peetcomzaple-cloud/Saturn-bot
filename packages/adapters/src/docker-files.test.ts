import { afterEach, describe, expect, it, vi } from "vitest";
import { DockerSandboxProvider } from "./docker-sandbox.js";

const context = {
  operationId: "files-test",
  traceId: "files-test",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};
const computer = {
  id: "container-1",
  providerRef: "container-1",
  botId: "bot-1",
  kind: "docker" as const,
};

describe("Docker workspace file listing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists the workspace root when the model supplies dot", async () => {
    const entries = [{ path: "notes.txt", kind: "file", size: 3 }];
    const fetch = vi.fn().mockResolvedValue(Response.json(entries));
    vi.stubGlobal("fetch", fetch);
    const sandbox = new DockerSandboxProvider("http://supervisor.test", "test-token");
    expect(await sandbox.listFiles(computer, ".", context)).toEqual(entries);
    expect(new URL(fetch.mock.calls[0]?.[0]).searchParams.get("path")).toBe("");
  });

  it("reports the supervisor error instead of only the HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ error: "directory not found" }, { status: 404 })),
    );
    const sandbox = new DockerSandboxProvider("http://supervisor.test", "test-token");
    await expect(sandbox.listFiles(computer, "missing", context)).rejects.toThrow(
      /404.*directory not found/,
    );
  });

  it("refuses parent traversal before contacting the supervisor", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const sandbox = new DockerSandboxProvider("http://supervisor.test", "test-token");
    await expect(sandbox.listFiles(computer, "./../", context)).rejects.toThrow(/escapes/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
