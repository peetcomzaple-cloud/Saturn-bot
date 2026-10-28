import { Duplex, PassThrough, Readable, Writable } from "node:stream";
import { resolveSupervisorToken } from "@rakazo/core";
import { beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ exec: vi.fn(), inspect: vi.fn(), stdin: [] as string[],
  browserResponse: undefined as Record<string, unknown> | undefined }));
vi.mock("dockerode", () => ({
  default: class {
    getContainer() {
      return mock;
    }
  },
}));

import { supervisorApp } from "./index.js";

beforeEach(() => {
  mock.exec.mockReset();
  mock.inspect.mockReset();
  mock.stdin.length = 0;
  mock.browserResponse = undefined;
  mock.inspect.mockResolvedValue({
    Config: {
      Labels: { "rakazo.managed": "true", "rakazo.botId": "home", "rakazo.spaceId": "space" },
    },
    HostConfig: { NetworkMode: "none" },
    NetworkSettings: { Networks: {} },
  });
  mock.exec.mockImplementation(async (options: { Cmd: string[] }) => ({
    // Docker's hijacked exec stream is duplex: stdin is written, output is read.
    start: async () =>
      Duplex.from({
        readable: Readable.from([
          Buffer.from(
            options.Cmd.includes("/usr/local/bin/rakazo-page-browser")
              ? JSON.stringify(mock.browserResponse ?? {
                  ok: true,
                  url: "https://example.test",
                  title: "Fixture",
                  tree: "",
                  elements: [],
                })
              : "",
          ),
        ]),
        writable: new Writable({
          write(chunk, _encoding, callback) {
            mock.stdin.push(String(chunk));
            callback();
          },
        }),
      }),
    inspect: async () => ({ ExitCode: 0 }),
  }));
});

async function snapshot(id: string, screen: string, lease: string, home = "home") {
  return supervisorApp.request(`/computers/${id}/browser`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": home,
      "x-rakazo-space-id": "space",
      "x-rakazo-screen-id": screen,
      "x-rakazo-screen-lease-id": lease,
    },
    body: JSON.stringify({ command: "snapshot" }),
  });
}

it("captures the owned display with the installed ImageMagick utility when scrot is absent", async () => {
  mock.inspect.mockResolvedValue({
    Config: { Labels: { "rakazo.managed": "true", "rakazo.botId": "home", "rakazo.spaceId": "space" } },
    HostConfig: { NetworkMode: "none" }, NetworkSettings: { Networks: {} },
  });
  const previous = mock.exec.getMockImplementation()!;
  mock.exec.mockImplementation(async (options: { Cmd: string[] }) => {
    const command = options.Cmd.join(" ");
    if (!command.includes('printf "IMAGE "')) return previous(options);
    const installedCapture = command.includes("import -window root png:-");
    return {
      start: async () => Duplex.from({
        readable: Readable.from([Buffer.from(installedCapture
          ? "DISPLAY :99\nGEOM 1280 800\nIMAGE iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB\n"
          : "DISPLAY :99\nGEOM 1280 800\nIMAGE \n")]),
        writable: new PassThrough(),
      }),
      inspect: async () => ({ ExitCode: 0 }),
    };
  });
  const response = await supervisorApp.request("/computers/computer-image-utility/observe", {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "home", "x-rakazo-space-id": "space",
      "x-rakazo-screen-id": "home", "x-rakazo-screen-lease-id": "run-image:1",
    },
    body: "{}",
  });
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toMatchObject({ display: ":99", image: expect.any(String) });
});

it("propagates authenticated execution metadata to the helper and strips private capture from the response", async () => {
  mock.browserResponse = { ok: true, _browserEvidence: {
    version: 1, runId: "run-current", executionId: JSON.stringify(["pi-tool", "main", "call-1"]), command: "snapshot",
    startedAt: 1000, completedAt: 1002, complete: true,
    events: [{ at: 1001, method: "helper.selected", sessionId: "session-one", targetId: "target-one" }],
  } };
  const response = await supervisorApp.request("/computers/computer-evidence/browser", {
    method: "POST", headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`, "content-type": "application/json",
      "x-rakazo-bot-id": "home", "x-rakazo-space-id": "space", "x-rakazo-screen-id": "first",
      "x-rakazo-screen-lease-id": "run-current:1", "x-rakazo-run-id": "run-current",
      "x-rakazo-execution-id-b64": Buffer.from(JSON.stringify(["pi-tool", "main", "call-1"])).toString("base64url"),
    }, body: JSON.stringify({ command: "snapshot", runId: "model-must-not-override" }),
  });
  expect(await response.json()).toEqual({ ok: true });
  expect(mock.exec.mock.calls.at(-1)?.[0].Env).toEqual(expect.arrayContaining([
    "RAKAZO_BROWSER_RUN_ID=run-current", `RAKAZO_BROWSER_EXECUTION_ID=${JSON.stringify(["pi-tool", "main", "call-1"])}`,
  ]));
  expect(mock.stdin.join("")).not.toContain("model-must-not-override");
});

it("resolves the owned display and refuses an older fence before running the helper", async () => {
  expect(await (await snapshot("computer-lease", "first", "run:2")).json()).toMatchObject({
    ok: true,
  });
  expect(await (await snapshot("computer-lease", "second", "other:2")).json()).toMatchObject({
    ok: true,
  });
  expect(mock.exec.mock.calls.at(-1)?.[0]).toMatchObject({
    Env: [
      "DISPLAY=:100",
      "RAKAZO_CDP_PORT=9321",
      "HOME=/home/rakazo",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "RAKAZO_BROWSER_WATCH_STDIN=1",
      "RAKAZO_BROWSER_ARGS_STDIN=1",
    ],
  });
  mock.exec.mockClear();
  expect(await (await snapshot("computer-lease", "first", "run:1")).json()).toMatchObject({
    ok: false,
  });
  expect(mock.exec).not.toHaveBeenCalled();
});

it.each(["browser", "actions", "input"] as const)(
  "finishes in-flight %s before acknowledging a newer owner",
  async (route) => {
    const id = `computer-inflight-fence-${route}`;
    await snapshot(id, "screen", "old-run:1");
    const previous = mock.exec.getMockImplementation()!;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const actionEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const events: string[] = [];
    mock.exec.mockImplementation(async (options: { Cmd: string[] }) => {
      const helper = options.Cmd.indexOf("/usr/local/bin/rakazo-page-browser");
      const isAction =
        route === "browser"
          ? helper >= 0 && options.Cmd[helper + 1] === "act"
          : route === "actions"
            ? options.Cmd.some((arg) => arg.includes("for step in json.loads(sys.argv[1]):"))
            : options.Cmd.includes("xdotool");
      if (isAction) {
        entered();
        await gate;
        events.push("old-action-finished");
      }
      return previous(options);
    });
    const body =
      route === "browser"
        ? { command: "act", actions: [{ kind: "click", ref: "fixture-button" }] }
        : route === "actions"
          ? { actions: [{ kind: "key", key: "Enter" }], observe: false }
          : { input: { kind: "key", key: "Enter" } };
    const action = supervisorApp.request(`/computers/${id}/${route}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "content-type": "application/json",
        "x-rakazo-bot-id": "home",
        "x-rakazo-space-id": "space",
        "x-rakazo-screen-id": "screen",
        "x-rakazo-screen-lease-id": "old-run:1",
      },
      body: JSON.stringify(body),
    });
    await Promise.race([
      actionEntered,
      Promise.resolve(action).then(() => {
        throw new Error("fixture action ended before reaching the controlled I/O");
      }),
    ]);
    let claimed = false;
    const claim = snapshot(id, "screen", "new-run:2").then((response) => {
      claimed = true;
      events.push("new-owner-acknowledged");
      return response;
    });
    try {
      // A separate computer must still progress while this action is held. Its
      // fresh-screen setup also drains the immediate mocked transport callbacks.
      expect(
        (await snapshot(`computer-fence-independent-${route}`, "screen", "other:1")).status,
      ).toBe(200);
      expect(claimed).toBe(false);
    } finally {
      release();
      await Promise.all([action, claim]);
    }
    expect(events).toEqual(["old-action-finished", "new-owner-acknowledged"]);
    mock.exec.mockClear();
    expect(await (await snapshot(id, "screen", "old-run:1")).json()).toMatchObject({ ok: false });
    const staleRelease = await supervisorApp.request(`/computers/${id}/screen`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "x-rakazo-bot-id": "home",
        "x-rakazo-space-id": "space",
        "x-rakazo-screen-id": "screen",
        "x-rakazo-screen-lease-id": "old-run:1",
        "x-rakazo-cancel-run-work": "1",
      },
    });
    expect(await staleRelease.json()).toEqual({ ok: true });
    expect(mock.exec).not.toHaveBeenCalled();
    expect(await (await snapshot(id, "screen", "new-run:2")).json()).toMatchObject({ ok: true });
  },
);

it("rejects another computer identity before any command executes", async () => {
  expect(
    await (await snapshot("computer-identity", "first", "run:1", "foreign-home")).json(),
  ).toMatchObject({ ok: false });
  expect(mock.exec).not.toHaveBeenCalled();
});

it.each(["http", "https"])(
  "rejects %s URL credentials before executing any command",
  async (scheme) => {
    const response = await supervisorApp.request("/computers/computer-credentials/browser", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command: "navigate",
        url: `${scheme}://example:fake-password@example.test`,
      }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mock.exec).not.toHaveBeenCalled();
    expect(mock.inspect).not.toHaveBeenCalled();
  },
);

it("closes helper stdin and releases a queued screen claim when the request is cancelled", async () => {
  const stream = new PassThrough();
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const defaultExec = mock.exec.getMockImplementation()!;
  mock.exec.mockImplementation(async (options: { Cmd: string[]; AttachStdin?: boolean }) => {
    const helper = options.Cmd.indexOf("/usr/local/bin/rakazo-page-browser");
    if (helper < 0 || options.Cmd[helper + 1] !== "act") return defaultExec(options);
    expect(options.AttachStdin).toBe(true);
    return {
      start: async (options: { stdin: boolean }) => {
        expect(options.stdin).toBe(true);
        started();
        return stream;
      },
      inspect: async () => ({ ExitCode: 130 }),
    };
  });
  const response = supervisorApp.request("/computers/computer-cancel/browser", {
    method: "POST",
    signal: controller.signal,
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "home",
      "x-rakazo-space-id": "space",
      "x-rakazo-screen-id": "screen",
      "x-rakazo-screen-lease-id": "cancelled-run:1",
    },
    body: JSON.stringify({ command: "act", actions: [{ kind: "click", ref: "test-ref" }] }),
  });
  await ready;
  const replacement = snapshot("computer-cancel", "screen", "replacement-run:2");
  controller.abort();
  expect(await (await response).json()).toMatchObject({ ok: false, uncertain: true });
  expect(stream.destroyed).toBe(true);
  expect(await (await replacement).json()).toMatchObject({ ok: true });
});

it("sends a saved-login fill only over stdin, never in the helper's arguments", async () => {
  const actions = [
    { kind: "fill", ref: "e1", text: "fake-password-1", origin: "https://login.example.test" },
  ];
  const response = await supervisorApp.request("/computers/computer-login/browser", {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "home",
      "x-rakazo-space-id": "space",
      "x-rakazo-screen-id": "first",
      "x-rakazo-screen-lease-id": "run:9",
    },
    body: JSON.stringify({ command: "act", actions }),
  });
  expect(await response.json()).toMatchObject({ ok: true });
  const helperCall = mock.exec.mock.calls.find(([options]) =>
    options.Cmd.includes("/usr/local/bin/rakazo-page-browser"),
  )!;
  expect(JSON.stringify(helperCall[0].Cmd)).not.toContain("fake-password-1");
  expect(helperCall[0].Env).toContain("RAKAZO_BROWSER_ARGS_STDIN=1");
  expect(mock.stdin.join("")).toBe(`${JSON.stringify({ command: "act", actions })}\n`);
});
