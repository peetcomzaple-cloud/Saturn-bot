import { expect, it, vi } from "vitest";
import { runDocker } from "./docker-cli.js";

const spawn = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("A cancelled Docker command must not spawn a process.");
  }),
);

vi.mock("node:child_process", () => ({ spawn }));

it("does not start Docker when its caller already cancelled the operation", async () => {
  const controller = new AbortController();
  controller.abort();

  await expect(
    runDocker("docker", ["compose", "up", "-d"], {
      cwd: process.cwd(),
      env: {},
      timeoutMs: 1_000,
      signal: controller.signal,
    }),
  ).resolves.toEqual({ code: 130, stdout: "", stderr: "" });
  expect(spawn).not.toHaveBeenCalled();
});
