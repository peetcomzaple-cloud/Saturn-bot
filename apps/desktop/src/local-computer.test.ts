import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunDocker, RunDockerResult } from "./docker-cli.js";
import {
  BACKEND_MEMORY_RESERVE_MB,
  COMPUTER_LIMITS_REJECTED,
  computerCapacityError,
  computerResourceEnv,
  describeEngineCapacity,
  initialStackState,
  LocalStackController,
  type LocalStackDeps,
  parseEngineCapacity,
  requestStackStart,
  STACK_ENV_FILE,
  STACK_PROJECT_NAME,
} from "./local-stack.js";
import {
  DEFAULT_COMPUTER_RESOURCES,
  parseComputerResources,
  parseSetupInput,
  parseStoredSetup,
  sameComputerResources,
  serializeSetup,
} from "./setup-config.js";

const COMPOSE_DIR = path.resolve(import.meta.dirname, "..", "..", "..", "infra", "compose");
const UNREPORTED = { status: "unknown", reason: "engine-did-not-report" } as const;

describe("parseComputerResources", () => {
  it("accepts whole megabytes and half-CPU steps within bounds", () => {
    expect(parseComputerResources({ memoryMb: 4096, cpus: 1.5 })).toEqual({
      memoryMb: 4096,
      cpus: 1.5,
    });
    expect(parseComputerResources(DEFAULT_COMPUTER_RESOURCES)).toEqual(DEFAULT_COMPUTER_RESOURCES);
  });

  it.each([
    ["missing fields", {}],
    ["null", null],
    ["array", []],
    ["string memory", { memoryMb: "2048", cpus: 2 }],
    ["NaN memory", { memoryMb: Number.NaN, cpus: 2 }],
    ["Infinity memory", { memoryMb: Number.POSITIVE_INFINITY, cpus: 2 }],
    ["fractional memory", { memoryMb: 2048.5, cpus: 2 }],
    ["negative memory", { memoryMb: -2048, cpus: 2 }],
    ["zero memory", { memoryMb: 0, cpus: 2 }],
    ["below minimum memory", { memoryMb: 512, cpus: 2 }],
    ["absurd memory", { memoryMb: 1e12, cpus: 2 }],
    ["NaN cpus", { memoryMb: 2048, cpus: Number.NaN }],
    ["Infinity cpus", { memoryMb: 2048, cpus: Number.POSITIVE_INFINITY }],
    ["negative cpus", { memoryMb: 2048, cpus: -1 }],
    ["zero cpus", { memoryMb: 2048, cpus: 0 }],
    ["too many cpus", { memoryMb: 2048, cpus: 65 }],
    ["quarter-step cpus", { memoryMb: 2048, cpus: 1.25 }],
    ["string cpus", { memoryMb: 2048, cpus: "2" }],
  ])("rejects %s", (_name, value) => {
    expect(parseComputerResources(value)).toBeNull();
  });
});

describe("setup config with computer limits", () => {
  it("keeps reading configs written before limits existed", () => {
    const legacy = JSON.stringify({ mode: "new", serverUrl: "http://127.0.0.1:45173" });
    expect(parseStoredSetup(legacy)).toEqual({ mode: "new", serverUrl: "http://127.0.0.1:45173" });
    const existing = JSON.stringify({ mode: "existing", serverUrl: "https://saturn.example.com" });
    expect(parseStoredSetup(existing)).toEqual({
      mode: "existing",
      serverUrl: "https://saturn.example.com",
    });
  });

  it("round-trips limits through serialize and parse", () => {
    const setup = {
      mode: "new" as const,
      serverUrl: "http://127.0.0.1:45173",
      computer: { memoryMb: 3072, cpus: 2.5 },
    };
    expect(parseStoredSetup(serializeSetup(setup))).toEqual(setup);
  });

  it("rejects a setup whose limits are invalid instead of dropping them", () => {
    expect(
      parseSetupInput({
        mode: "new",
        serverUrl: "http://127.0.0.1:45173",
        computer: { memoryMb: Number.NaN, cpus: 2 },
      }),
    ).toBeNull();
  });

  it("does not attach limits to an existing server", () => {
    expect(
      parseSetupInput({
        mode: "existing",
        serverUrl: "https://saturn.example.com",
        computer: DEFAULT_COMPUTER_RESOURCES,
      }),
    ).toBeNull();
  });

  it("drops unknown extra keys", () => {
    expect(
      parseSetupInput({
        mode: "new",
        serverUrl: "http://127.0.0.1:45173",
        computer: { memoryMb: 2048, cpus: 2, dockerSocket: "/var/run/docker.sock" },
        extra: true,
      }),
    ).toEqual({
      mode: "new",
      serverUrl: "http://127.0.0.1:45173",
      computer: { memoryMb: 2048, cpus: 2 },
    });
  });
});

describe("engine capacity", () => {
  it("parses memory in bytes and CPU count", () => {
    expect(parseEngineCapacity("8589934592 4\n")).toEqual({ memoryMb: 8192, cpus: 4 });
  });

  it.each([
    ["", { memoryMb: null, cpus: null }],
    ["garbage", { memoryMb: null, cpus: null }],
    ["0 0", { memoryMb: null, cpus: null }],
    ["-1 -1", { memoryMb: null, cpus: null }],
    ["1e9 2", { memoryMb: null, cpus: 2 }],
    ["8589934592", { memoryMb: 8192, cpus: null }],
  ])("treats %j as unknown where unusable", (raw, expected) => {
    expect(parseEngineCapacity(raw)).toEqual(expected);
  });

  it("never treats an unreported value as enough room for large limits", () => {
    const unknown = { status: "unknown", reason: "engine-did-not-report" } as const;
    expect(computerCapacityError({ memoryMb: 262_144, cpus: 64 }, unknown)).toContain(
      "cannot be checked",
    );
    expect(computerCapacityError({ memoryMb: 4096, cpus: 2 }, unknown)).toContain("2048 MB");
    expect(computerCapacityError({ memoryMb: 2048, cpus: 4 }, unknown)).toContain("2 CPUs");
  });

  it("lets the defaults proceed while the capacity is unknown", () => {
    expect(
      computerCapacityError(DEFAULT_COMPUTER_RESOURCES, {
        status: "unknown",
        reason: "engine-query-failed",
      }),
    ).toBeNull();
    expect(computerCapacityError({ memoryMb: 1024, cpus: 0.5 }, UNREPORTED)).toBeNull();
  });

  it("judges a half-reported engine only on what it reported", () => {
    const memoryOnly = { status: "known", memoryMb: 16_384, cpus: null } as const;
    expect(computerCapacityError({ memoryMb: 4096, cpus: 2 }, memoryOnly)).toBeNull();
    expect(computerCapacityError({ memoryMb: 4096, cpus: 8 }, memoryOnly)).toContain("2 CPUs");
  });

  it("rejects memory that would starve the backend services", () => {
    const capacity = { status: "known", memoryMb: 4096, cpus: 8 } as const;
    expect(computerCapacityError({ memoryMb: 2048, cpus: 2 }, capacity)).toContain(
      `${BACKEND_MEMORY_RESERVE_MB} MB`,
    );
    expect(
      computerCapacityError({ memoryMb: 4096 - BACKEND_MEMORY_RESERVE_MB, cpus: 2 }, capacity),
    ).toBeNull();
  });

  it("rejects more CPUs than the engine has", () => {
    expect(
      computerCapacityError(
        { memoryMb: 1024, cpus: 8 },
        { status: "known", memoryMb: 32_768, cpus: 4 },
      ),
    ).toContain("4 CPUs");
  });

  it("describes the query result for the setup window", () => {
    const base = { stderr: "" };
    expect(describeEngineCapacity({ ...base, code: 0, stdout: "8589934592 4\n" })).toEqual({
      status: "known",
      memoryMb: 8192,
      cpus: 4,
    });
    expect(describeEngineCapacity({ ...base, code: 1, stdout: "" })).toEqual({
      status: "unknown",
      reason: "engine-query-failed",
    });
    expect(describeEngineCapacity({ ...base, code: 0, stdout: "<no value> <no value>" })).toEqual({
      status: "unknown",
      reason: "engine-did-not-report",
    });
  });
});

describe("sameComputerResources", () => {
  it("compares values and treats missing as equal only to missing", () => {
    expect(sameComputerResources({ memoryMb: 2048, cpus: 2 }, { memoryMb: 2048, cpus: 2 })).toBe(
      true,
    );
    expect(sameComputerResources({ memoryMb: 2048, cpus: 2 }, { memoryMb: 4096, cpus: 2 })).toBe(
      false,
    );
    expect(sameComputerResources(undefined, null)).toBe(true);
    expect(sameComputerResources({ memoryMb: 2048, cpus: 2 }, null)).toBe(false);
  });
});

describe("requestStackStart", () => {
  function fakeStack() {
    const started: unknown[][] = [];
    const state = initialStackState("v1.2.3");
    return {
      started,
      stack: {
        state: () => state,
        start: (...args: unknown[]) => {
          started.push(args);
          return Promise.resolve(state);
        },
      },
    };
  }

  it.each([
    ["65 CPUs", { memoryMb: 2048, cpus: 65 }],
    ["0.75 CPUs", { memoryMb: 2048, cpus: 0.75 }],
    ["more than 256 GB", { memoryMb: 262_145, cpus: 2 }],
    ["NaN", { memoryMb: Number.NaN, cpus: 2 }],
    ["null", null],
    ["a string", "2048"],
  ])("refuses %s with an explanation and leaves the stack alone", (_name, payload) => {
    const { stack, started } = fakeStack();
    const result = requestStackStart(stack, payload);
    expect(result.rejected).toBe(COMPUTER_LIMITS_REJECTED);
    expect(result.state).toEqual(initialStackState("v1.2.3"));
    expect(started).toHaveLength(0);
  });

  it("starts with valid limits and without any when none were sent", () => {
    const { stack, started } = fakeStack();
    expect(requestStackStart(stack, { memoryMb: 4096, cpus: 1.5 }).rejected).toBeUndefined();
    expect(requestStackStart(stack, undefined).rejected).toBeUndefined();
    expect(started).toEqual([[{ memoryMb: 4096, cpus: 1.5 }], []]);
  });
});

describe("Saturn bot project namespace", () => {
  it("does not share a Compose project with Rakazo", async () => {
    expect(STACK_PROJECT_NAME).toBe("saturn-bot-desktop");
    expect(STACK_PROJECT_NAME).not.toMatch(/^rakazo/);
    const compose = await readFile(path.join(COMPOSE_DIR, "docker-compose.images.yml"), "utf8");
    expect(compose).toMatch(/^name: saturn-bot$/m);
    expect(compose).not.toMatch(/^name: rakazo/m);
  });
});

describe("computerResourceEnv", () => {
  it("maps to the variables the supervisor already enforces", () => {
    expect(computerResourceEnv({ memoryMb: 3072, cpus: 1.5 })).toEqual({
      RAKAZO_COMPUTER_MEMORY: "3072m",
      RAKAZO_COMPUTER_CPUS: "1.5",
    });
  });

  it("leaves the compose defaults alone when nothing was chosen", () => {
    expect(computerResourceEnv(null)).toEqual({});
  });
});

interface RecordedCall {
  args: string[];
  env: Record<string, string>;
}

describe("LocalStackController with computer limits", () => {
  let root: string;
  let calls: RecordedCall[];

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "saturn-local-computer-"));
    calls = [];
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function controller(capacity: Partial<RunDockerResult> = { stdout: "34359738368 8\n" }) {
    const run: RunDocker = async (_binary, args, options) => {
      calls.push({ args, env: options.env });
      if (args[0] === "compose" && args[1] === "version") {
        return { code: 0, stdout: "2.29.0\n", stderr: "" };
      }
      if (args[0] === "info" && args[2] === "{{.ServerVersion}}") {
        return { code: 0, stdout: "27.1.1\n", stderr: "" };
      }
      if (args[0] === "info") return { code: 0, stdout: "", stderr: "", ...capacity };
      return { code: 0, stdout: "", stderr: "" };
    };
    const deps: LocalStackDeps = {
      platform: "linux",
      env: { PATH: "/usr/bin", HOME: "/home/me" },
      exists: (file) => file === "/usr/bin/docker",
      allocatePort: async () => 45174,
      stackDir: path.join(root, "stack"),
      resourceDir: COMPOSE_DIR,
      localWebUrl: "http://127.0.0.1:5173",
      imageTag: "v1.2.3",
      randomHex: (bytes) => "ab".repeat(bytes),
      sleep: async () => undefined,
      healthTimeoutMs: 50,
      run,
      probe: async () => "v1.2.3",
    };
    return new LocalStackController(deps);
  }

  const composeCalls = () => calls.filter((call) => call.args[0] === "compose");

  it("passes the chosen limits to every compose call", async () => {
    const stack = controller();
    const state = await stack.start({ memoryMb: 3072, cpus: 1.5 });
    expect(state.phase).toBe("ready");
    expect(composeCalls().length).toBeGreaterThan(2);
    for (const call of composeCalls()) {
      expect(call.env).toMatchObject({
        RAKAZO_COMPUTER_MEMORY: "3072m",
        RAKAZO_COMPUTER_CPUS: "1.5",
      });
    }
    expect(stack.computerResources()).toEqual({ memoryMb: 3072, cpus: 1.5 });
  });

  it("does not set limits for a start that never chose any", async () => {
    const stack = controller();
    await stack.start();
    for (const call of calls) {
      expect(call.env).not.toHaveProperty("RAKAZO_COMPUTER_MEMORY");
      expect(call.env).not.toHaveProperty("RAKAZO_COMPUTER_CPUS");
    }
    // No limits chosen means no capacity query either.
    expect(calls.filter((call) => call.args[0] === "info")).toHaveLength(1);
  });

  it("fails before pulling when the engine is too small, and never starts compose", async () => {
    const stack = controller({ stdout: "4294967296 4\n" });
    const state = await stack.start({ memoryMb: 2048, cpus: 2 });
    expect(state.phase).toBe("failed");
    expect(state.message).toContain("4096 MB");
    expect(composeCalls().filter((call) => call.args.includes("pull"))).toHaveLength(0);
    expect(composeCalls().filter((call) => call.args.includes("up"))).toHaveLength(0);
  });

  it("fails when more CPUs are requested than the engine reports", async () => {
    const state = await controller({ stdout: "34359738368 2\n" }).start({
      memoryMb: 1024,
      cpus: 4,
    });
    expect(state.phase).toBe("failed");
    expect(state.message).toContain("2 CPUs");
  });

  it("proceeds with the defaults when the engine cannot answer, and says the capacity is unknown", async () => {
    const state = await controller({ code: 1, stderr: "template parsing error" }).start({
      memoryMb: 2048,
      cpus: 2,
    });
    expect(state.phase).toBe("ready");
    expect(state.capacity).toEqual({ status: "unknown", reason: "engine-query-failed" });
  });

  it("stops before pulling when limits above the defaults cannot be checked", async () => {
    const stack = controller({ code: 0, stdout: "<no value> <no value>" });
    const state = await stack.start({ memoryMb: 4096, cpus: 2 });
    expect(state.phase).toBe("failed");
    expect(state.message).toContain("cannot be checked");
    expect(state.capacity).toEqual({ status: "unknown", reason: "engine-did-not-report" });
    expect(composeCalls().filter((call) => call.args.includes("pull"))).toHaveLength(0);
  });

  it("reports the capacity it compared against", async () => {
    const state = await controller().start({ memoryMb: 2048, cpus: 2 });
    expect(state.capacity).toEqual({ status: "known", memoryMb: 32_768, cpus: 8 });
  });

  it("starts the saturn-bot project and never the Rakazo desktop project", async () => {
    await controller().start({ memoryMb: 2048, cpus: 2 });
    const projects = composeCalls()
      .filter((call) => call.args.includes("--project-name"))
      .map((call) => call.args[call.args.indexOf("--project-name") + 1]);
    expect(projects.length).toBeGreaterThan(1);
    expect(new Set(projects)).toEqual(new Set([STACK_PROJECT_NAME]));
    expect(STACK_PROJECT_NAME).not.toBe("rakazo-desktop");
  });

  it("keeps the existing .env untouched; limits ride on the launch environment", async () => {
    const stack = controller();
    await stack.start({ memoryMb: 2048, cpus: 2 });
    const env = await readFile(path.join(root, "stack", STACK_ENV_FILE), "utf8");
    expect(env).not.toContain("RAKAZO_COMPUTER_MEMORY=2048m");
  });

  it("a retry with new limits replaces the old ones", async () => {
    const stack = controller();
    await stack.start({ memoryMb: 2048, cpus: 2 });
    calls.length = 0;
    await stack.start({ memoryMb: 4096, cpus: 3 });
    expect(composeCalls().at(-1)?.env).toMatchObject({
      RAKAZO_COMPUTER_MEMORY: "4096m",
      RAKAZO_COMPUTER_CPUS: "3",
    });
  });
});
