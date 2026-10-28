import type Docker from "dockerode";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { computerBridgeNameFor, computerNetworkNameFor } from "./computer-spec.js";

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  createNetwork: vi.fn(),
  getContainer: vi.fn(),
  listContainers: vi.fn(),
}));
vi.mock("dockerode", () => ({
  default: class {
    createNetwork = mocks.createNetwork;
    listContainers = mocks.listContainers;
    getContainer = mocks.getContainer;
    getNetwork() {
      return {
        inspect: mocks.inspect,
        connect: mocks.connect,
        disconnect: mocks.disconnect,
        remove: vi.fn().mockResolvedValue(undefined),
      };
    }
  },
}));
const name = computerNetworkNameFor("fixture-bot");
const info = (running = true, networkId?: string) => ({
  Id: "fixture-container", State: { Running: running }, HostConfig: { NetworkMode: name },
  NetworkSettings: { Networks: networkId ? { [name]: { NetworkID: networkId } } : {} },
}) as Docker.ContainerInspectInfo;
const container = { id: "fixture-container" } as Docker.Container;

beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  vi.stubEnv("HOSTNAME", ""); vi.stubEnv("SANDBOX_SUPERVISOR_TOKEN", "fixture-token");
  vi.stubEnv("SANDBOX_SCREEN_NETWORK", "isolated");
  vi.stubEnv("SANDBOX_COMPUTER_EGRESS", "restricted");
  mocks.inspect.mockRejectedValue(Object.assign(new Error("no such network"), { statusCode: 404 }));
  mocks.connect.mockResolvedValue(undefined); mocks.disconnect.mockResolvedValue(undefined);
  mocks.createNetwork.mockResolvedValue({});
});
afterEach(() => vi.unstubAllEnvs());

it.each([true, false])("rejoins the exact container after idle reclamation (running=%s)", async (running) => {
  const { restoreComputerNetwork } = await import("./index.js");
  await expect(restoreComputerNetwork(container, info(running), "fixture-bot", "fixture-owner")).resolves.toBe(true);
  expect(mocks.createNetwork).toHaveBeenCalledWith(expect.objectContaining({
    Name: name, Labels: expect.objectContaining({ "rakazo.botId": "fixture-bot", "rakazo.computerOwner": "fixture-owner" }),
    Options: expect.objectContaining({ "com.docker.network.bridge.name": computerBridgeNameFor("fixture-bot") }),
  }));
  expect(mocks.connect).toHaveBeenCalledExactlyOnceWith({ Container: "fixture-container" });
});
it("leaves a healthy network and endpoint untouched", async () => {
  mocks.inspect.mockResolvedValue({ Id: "network-current" });
  const { restoreComputerNetwork } = await import("./index.js");
  await expect(restoreComputerNetwork(container, info(true, "network-current"), "fixture-bot", "fixture-owner")).resolves.toBe(false);
  expect(mocks.createNetwork).not.toHaveBeenCalled(); expect(mocks.connect).not.toHaveBeenCalled();
});
it("does not reconnect to another install's network", async () => {
  mocks.inspect.mockResolvedValue({ Id: "foreign", Labels: { "rakazo.computerOwner": "other" } });
  const { restoreComputerNetwork } = await import("./index.js");
  await expect(restoreComputerNetwork(container, info(), "fixture-bot", "fixture-owner")).rejects.toThrow(/owner mismatch/);
  expect(mocks.createNetwork).not.toHaveBeenCalled(); expect(mocks.connect).not.toHaveBeenCalled();
});
it("surfaces transient Docker errors without replacing or creating a network", async () => {
  mocks.inspect.mockRejectedValue(Object.assign(new Error("Docker unavailable"), { statusCode: 503 }));
  const { restoreComputerNetwork } = await import("./index.js");
  await expect(restoreComputerNetwork(container, info(), "fixture-bot", "fixture-owner")).rejects.toThrow("Docker unavailable");
  expect(mocks.createNetwork).not.toHaveBeenCalled(); expect(mocks.connect).not.toHaveBeenCalled();
});
it("refuses a container configured for a different network", async () => {
  const bad = info(); bad.HostConfig.NetworkMode = "bridge";
  const { restoreComputerNetwork } = await import("./index.js");
  await expect(restoreComputerNetwork(container, bad, "fixture-bot", "fixture-owner")).rejects.toThrow(/network mismatch/);
  expect(mocks.createNetwork).not.toHaveBeenCalled(); expect(mocks.connect).not.toHaveBeenCalled();
});
it("does not change the shared internal-network topology", async () => {
  vi.stubEnv("SANDBOX_SCREEN_NETWORK", "internal");
  const { restoreComputerNetwork } = await import("./index.js");
  await expect(restoreComputerNetwork(container, info(), "fixture-bot", "fixture-owner")).resolves.toBe(false);
  expect(mocks.inspect).not.toHaveBeenCalled(); expect(mocks.createNetwork).not.toHaveBeenCalled();
});
it("replaces only the stale endpoint on an owned restricted network", async () => {
  mocks.inspect.mockResolvedValue({ Id: "current", Labels: { "rakazo.computerOwner": "fixture-owner", "rakazo.botId": "fixture-bot" },
    Options: { "com.docker.network.bridge.name": computerBridgeNameFor("fixture-bot") } });
  mocks.createNetwork.mockRejectedValue(new Error("network already exists"));
  const { restoreComputerNetwork } = await import("./index.js");
  await expect(restoreComputerNetwork(container, info(true, "stale"), "fixture-bot", "fixture-owner")).resolves.toBe(true);
  expect(mocks.disconnect).toHaveBeenCalledExactlyOnceWith({ Container: "fixture-container", Force: true });
  expect(mocks.connect).toHaveBeenCalledExactlyOnceWith({ Container: "fixture-container" });
});
it("fails without replacing the container when Docker refuses the reconnect", async () => {
  mocks.connect.mockRejectedValue(Object.assign(new Error("Docker permission denied"), { statusCode: 500 }));
  const { restoreComputerNetwork } = await import("./index.js");
  await expect(restoreComputerNetwork(container, info(), "fixture-bot", "fixture-owner")).rejects.toThrow("Docker permission denied");
});
it("does not deadlock when GET /computers/:id/screen overlaps DELETE /computers/:id in isolated mode", async () => {
  const { PassThrough, Readable } = await import("node:stream");
  vi.stubEnv("HOSTNAME", "supervisor-1");
  mocks.listContainers.mockResolvedValue([]);
  mocks.inspect.mockResolvedValue({
    Id: "network-current",
    Containers: { "supervisor-1": {} },
    Labels: { "rakazo.computerOwner": "fixture-owner", "rakazo.botId": "fixture-bot" },
  });
  let releaseSupervisorInspect!: () => void;
  let supervisorInspectEntered!: () => void;
  const supervisorInspectGate = new Promise<void>((resolve) => {
    releaseSupervisorInspect = resolve;
  });
  const onSupervisorInspect = new Promise<void>((resolve) => {
    supervisorInspectEntered = resolve;
  });
  const botInfo = {
    Id: "fixture-container",
    Name: "/rakazo-bot-fixture",
    State: { Running: true },
    Config: {
      Image: "rakazo-computer:local",
      Labels: { "rakazo.managed": "true", "rakazo.botId": "fixture-bot", "rakazo.spaceId": "space-1" },
    },
    HostConfig: { NetworkMode: name },
    NetworkSettings: {
      Networks: { [name]: { NetworkID: "network-current", IPAddress: "127.0.0.1" } },
      Ports: {},
    },
  };
  mocks.getContainer.mockImplementation((id: string) => {
    if (id === "supervisor-1") {
      return {
        inspect: async () => {
          supervisorInspectEntered();
          await supervisorInspectGate;
          return { Id: "supervisor-1", Config: { Labels: {} }, Mounts: [] };
        },
      };
    }
    return {
      inspect: vi.fn().mockResolvedValue(botInfo),
      remove: vi.fn().mockResolvedValue(undefined),
      exec: vi.fn().mockResolvedValue({
        start: async () => Readable.from([Buffer.alloc(0)]),
        inspect: async () => ({ ExitCode: 0 }),
      }),
    };
  });
  const { supervisorApp } = await import("./index.js");
  const headers = {
    authorization: "Bearer fixture-token",
    "x-rakazo-bot-id": "fixture-bot",
    "x-rakazo-space-id": "space-1",
    "x-rakazo-screen-id": "fixture-bot",
    "x-rakazo-screen-lease-id": "run-1:1",
  };
  const screenPromise = supervisorApp.request("/computers/fixture-container/screen", {
    method: "GET",
    headers,
  });
  await onSupervisorInspect;
  const deletePromise = supervisorApp.request("/computers/fixture-container", {
    method: "DELETE",
    headers,
  });
  // Allow DELETE to acquire withBotLifecycleLock("fixture-bot") and reach withComputerScreenLock("fixture-container")
  await new Promise((resolve) => setTimeout(resolve, 20));
  releaseSupervisorInspect();
  const deleteResponse = await Promise.race([
    deletePromise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("AB-BA lock order deadlock between screen and delete")), 400),
    ),
  ]);
  expect(deleteResponse.status).toBe(200);
  void Promise.resolve(screenPromise).catch(() => undefined);
});
