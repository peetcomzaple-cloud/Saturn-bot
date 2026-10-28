import { Duplex } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getContainer: vi.fn(), exec: vi.fn() }));
vi.mock("dockerode", () => ({ default: class { getContainer = mocks.getContainer; } }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv("HOSTNAME", "");
  vi.stubEnv("SANDBOX_SUPERVISOR_TOKEN", "test-token");
  mocks.getContainer.mockReturnValue({
    inspect: async () => ({ Config: { Labels: {
      "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space",
    } }, State: { Running: true } }),
    exec: mocks.exec,
  });
  mocks.exec.mockImplementation(async ({ Cmd }: { Cmd: string[] }) => {
    const output = Cmd.join(" ").includes("rakazo-page-browser") ? JSON.stringify({ ok: true, tabs: [] }) : "";
    return {
      start: async () => new Duplex({
        read() { if (output) this.push(Buffer.from(output)); this.push(null); },
        write(_chunk, _encoding, done) { done(); },
      }),
      inspect: async () => ({ ExitCode: 0 }),
    };
  });
});
afterEach(() => vi.unstubAllEnvs());

it.each(['{', JSON.stringify({ command: "tab_close", allowLastTab: "yes" }),
  JSON.stringify({ command: "unknown" })])("returns 400 for an invalid browser body without starting a helper: %s", async (body) => {
  const { supervisorApp } = await import("./index.js");
  const response = await supervisorApp.request("/computers/container-one/browser", {
    method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" }, body,
  });
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({ error: "Invalid request" });
  expect(mocks.exec).not.toHaveBeenCalled();
});

it.each([
  { command: "tab_list" },
  { command: "tab_close", targetId: "target-one" },
  { command: "tab_close", urlIncludes: "example.test", allowLastTab: false },
  { command: "tab_close", titleIncludes: "Secondary", allowLastTab: true },
])("routes $command through the owned screen without losing target fields", async (body) => {
  const { supervisorApp } = await import("./index.js");
  const response = await supervisorApp.request("/computers/container-one/browser", {
    method: "POST", headers: {
      authorization: "Bearer test-token", "content-type": "application/json",
      "x-rakazo-bot-id": "bot", "x-rakazo-space-id": "space", "x-rakazo-screen-id": "bot",
      "x-rakazo-screen-lease-id": "run-one:1",
    }, body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ ok: true, tabs: [] });
  const calls = mocks.exec.mock.calls.map(([options]) => options);
  const browser = calls.find((options) => options.Cmd.join(" ").includes("rakazo-page-browser"));
  expect(browser).toBeDefined();
  expect(browser.Cmd.join(" ")).toContain(JSON.stringify(body));
  expect(browser.Env).toEqual(expect.arrayContaining(["DISPLAY=:99", "RAKAZO_CDP_PORT=9320"]));
});

it("rejects a tab command for another bot before starting a helper", async () => {
  const { supervisorApp } = await import("./index.js");
  const response = await supervisorApp.request("/computers/container-one/browser", {
    method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json",
      "x-rakazo-bot-id": "other", "x-rakazo-space-id": "space" },
    body: JSON.stringify({ command: "tab_close", targetId: "target-one" }),
  });
  await expect(response.json()).resolves.toMatchObject({ ok: false });
  expect(mocks.exec).not.toHaveBeenCalled();
});
