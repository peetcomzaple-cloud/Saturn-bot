import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { runDocker } from "./docker-cli.js";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));

afterEach(() => vi.clearAllMocks());

it.each(["stdout", "stderr"] as const)(
  "preserves Thai and emoji split across %s chunks",
  async (stream) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: undefined,
    });
    spawn.mockReturnValue(child);
    const lines: string[] = [];
    const result = runDocker("docker", ["info"], {
      cwd: process.cwd(),
      env: {},
      timeoutMs: 1_000,
      onLine: (line) => lines.push(line),
    });
    const text = "กำลังเตรียมเครื่อง 🪐\nแฟ้มงานพร้อมแล้ว";
    const bytes = Buffer.from(text, "utf8");
    for (let index = 0; index < bytes.length; index++) {
      child[stream].write(bytes.subarray(index, index + 1));
    }
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0);

    await expect(result).resolves.toMatchObject({ code: 0, [stream]: text });
    expect(lines).toEqual(text.split("\n"));
  },
);
