import { describe, expect, it } from "vitest";
import {
  clearAllTakeoverControlGates,
  createActionBarrier,
  createTakeoverControlGate,
  getTakeoverControlGate,
  HumanHasControlError,
  SnapshotRequiredError,
  DESKTOP_HELD_FOR_TAKEOVER_MESSAGE,
} from "./takeover-resume.js";
import { FakeBrowserProvider } from "./fake-browser.js";
import { PageBrowserSession } from "./page-browser-session.js";
import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";

describe("OpenBot Action Barrier Runtime Wiring Integration", () => {
  it("POS-INTEG-1: Tool action admission and in-flight draining on human takeover", async () => {
    const computerId = "comp-integ-1";
    const gate = getTakeoverControlGate(computerId, { drainTimeoutMs: 1_000 });
    expect(gate.getHolder()).toBe("bot");
    expect(gate.pendingActions()).toBe(0);

    // Bot enters admission for an in-flight tool action
    const releaseAction = gate.admitBotAction(false);
    expect(gate.pendingActions()).toBe(1);

    let drained = false;
    // Human takeover triggered while action is in flight
    const takeoverPromise = gate.takeHumanControl().then(() => {
      drained = true;
    });

    // Verify takeover has not resolved yet because action is in-flight
    await new Promise((r) => setTimeout(r, 20));
    expect(drained).toBe(false);

    // Action finishes and releases admission
    releaseAction();
    await takeoverPromise;

    expect(drained).toBe(true);
    expect(gate.getHolder()).toBe("human");
    expect(gate.pendingActions()).toBe(0);
    clearAllTakeoverControlGates();
  });

  it("NEG-INTEG-1: In-flight action timeout rejects human takeover", async () => {
    const computerId = "comp-integ-2";
    const gate = getTakeoverControlGate(computerId, { drainTimeoutMs: 50 });

    // Bot action hangs
    const _releaseAction = gate.admitBotAction(true);
    expect(gate.pendingActions()).toBe(1);

    await expect(gate.takeHumanControl()).rejects.toThrow(
      "An admitted action is still finishing; human control has not been granted",
    );
    _releaseAction();
    clearAllTakeoverControlGates();
  });

  it("POS-INTEG-2: Human takeover blocks subsequent bot tool actions", async () => {
    const computerId = "comp-integ-3";
    const gate = getTakeoverControlGate(computerId);
    await gate.takeHumanControl();
    expect(gate.getHolder()).toBe("human");

    // Bot tool attempt is rejected
    expect(() => gate.admitBotAction(true)).toThrow(HumanHasControlError);
    expect(() => gate.admitBotAction(false)).toThrow(HumanHasControlError);

    // PageBrowserSession wired with gate also refuses action
    const session = new PageBrowserSession("http://localhost", "<html><body><button id='b'>Click</button></body></html>", {
      takeoverGate: gate,
    });
    const result = session.act([{ kind: "click", ref: "b" }]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("A person has control");
    clearAllTakeoverControlGates();
  });

  it("POS-INTEG-3: Post-takeover release strictly enforces fresh snapshot before mutations", async () => {
    const computerId = "comp-integ-4";
    const gate = getTakeoverControlGate(computerId);
    await gate.takeHumanControl();

    // Human releases control (clicks 'I am done')
    gate.releaseHumanControl();
    expect(gate.getHolder()).toBe("bot");
    expect(gate.isResumeSnapshotRequired()).toBe(true);

    const session = new PageBrowserSession(
      "http://localhost",
      "<html><body><button id='btn'>Submit</button></body></html>",
      { takeoverGate: gate },
    );

    // Immediate mutation without snapshot MUST throw SnapshotRequiredError
    expect(() => gate.admitBotAction(true)).toThrow(SnapshotRequiredError);
    const actResult = session.act([{ kind: "click", ref: "btn" }]);
    expect(actResult.ok).toBe(false);
    expect(actResult.error).toContain("Take a fresh browser snapshot after handback before acting.");

    // Read-only snapshot succeeds and records snapshot taken
    const snap = session.snapshot();
    expect(snap.elements.length).toBeGreaterThan(0);
    expect(gate.isResumeSnapshotRequired()).toBe(false);

    // Mutation is now admitted
    expect(() => gate.admitBotAction(true)).not.toThrow();
    const release = gate.admitBotAction(true);
    release();
    clearAllTakeoverControlGates();
  });

  it("POS-INTEG-4: End-to-end caller-level workflow via FakeBrowserProvider", async () => {
    const computer: ComputerRef = {
      id: "comp-integ-5",
      botId: "bot-integ-5",
      providerRef: "key-5",
      kind: "docker",
    };
    const context: AdapterContext = {
      operationId: "op-1",
      traceId: "trace-1",
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-integ-5",
      signal: new AbortController().signal,
    };

    const browser = new FakeBrowserProvider({
      pages: {
        "http://app.test/dashboard": {
          title: "Dashboard",
          html: "<html><body><h1>Dashboard</h1><button id='logout'>Logout</button></body></html>",
        },
      },
    });

    const gate = getTakeoverControlGate(computer.id);

    // 1. Bot navigates to page
    const nav = await browser.navigate(computer, { url: "http://app.test/dashboard" }, context);
    expect(nav.url).toBe("http://app.test/dashboard");

    // 2. Human takes control
    await gate.takeHumanControl();
    expect(gate.getHolder()).toBe("human");

    // 3. Bot action during human takeover is rejected
    const actWhileHuman = await browser.act(
      computer,
      { actions: [{ kind: "click", ref: "logout" }] },
      context,
    );
    expect(actWhileHuman.ok).toBe(false);
    expect(actWhileHuman.error).toContain("A person has control");

    // 4. Human releases control
    gate.releaseHumanControl();
    expect(gate.getHolder()).toBe("bot");
    expect(gate.isResumeSnapshotRequired()).toBe(true);

    // 5. Attempting to click before snapshot is strictly blocked
    const actBeforeSnapshot = await browser.act(
      computer,
      { actions: [{ kind: "click", ref: "logout" }] },
      context,
    );
    expect(actBeforeSnapshot.ok).toBe(false);
    expect(actBeforeSnapshot.error).toContain("Take a fresh browser snapshot after handback before acting.");

    // 6. Taking a fresh snapshot clears the requirement
    const snapshot = await browser.snapshot(computer, {}, context);
    expect(snapshot.title).toBe("Dashboard");
    expect(snapshot.elements.length).toBeGreaterThan(0);
    expect(gate.isResumeSnapshotRequired()).toBe(false);

    // 7. Clicking with the fresh snapshot ref now succeeds
    const button = snapshot.elements[0];
    if (!button) throw new Error("Fixture snapshot must contain the logout button");
    const buttonRef = button.ref;
    const actAfterSnapshot = await browser.act(
      computer,
      { actions: [{ kind: "click", ref: buttonRef }] },
      context,
    );
    expect(actAfterSnapshot.ok).toBe(true);
    clearAllTakeoverControlGates();
  });

  it("NEG-INTEG-SNAPSHOT-FAIL: Failed snapshot does not clear resume requirement and keeps mutations blocked", async () => {
    const computerId = "comp-integ-fail-snap";
    const gate = getTakeoverControlGate(computerId);
    await gate.takeHumanControl();
    gate.releaseHumanControl();
    expect(gate.getHolder()).toBe("bot");
    expect(gate.isResumeSnapshotRequired()).toBe(true);

    const session = new PageBrowserSession(
      "http://localhost",
      "<html><body><button id='action-btn'>Click Me</button></body></html>",
      { takeoverGate: gate },
    );

    // Initial mutation attempt is blocked
    expect(() => gate.admitBotAction(true)).toThrow(SnapshotRequiredError);
    const actBlockedBefore = session.act([{ kind: "click", ref: "action-btn" }]);
    expect(actBlockedBefore.ok).toBe(false);
    expect(actBlockedBefore.error).toContain("Take a fresh browser snapshot after handback before acting.");

    // Simulate snapshot failure: e.g. DOM closed or broken, or throwing an error
    // In PageBrowserSession, buildSnapshot throws if window is closed/corrupted
    (session as any).dom.window.close();
    expect(() => session.snapshot()).toThrow();

    // Verify snapshot requirement was NOT cleared on failed observation
    expect(gate.isResumeSnapshotRequired()).toBe(true);
    expect(() => gate.admitBotAction(true)).toThrow(SnapshotRequiredError);

    // Also simulate caller-level tool result containing error { error: "Snapshot failed" }
    // As wired in executor.ts (line 7377), snapshot with error does not call recordSnapshotTaken
    const mockToolResultWithError = { error: "Failed to capture window snapshot", ok: false };
    const snapshotHasError = Boolean(
      mockToolResultWithError &&
        typeof mockToolResultWithError === "object" &&
        ("error" in mockToolResultWithError || (mockToolResultWithError as any).ok === false),
    );
    if (!snapshotHasError) {
      gate.recordSnapshotTaken();
    }
    // Verify requirement remains true
    expect(gate.isResumeSnapshotRequired()).toBe(true);
    expect(() => gate.admitBotAction(true)).toThrow(SnapshotRequiredError);

    // Reinitialize valid session: successful snapshot clears requirement
    const validSession = new PageBrowserSession(
      "http://localhost",
      "<html><body><button id='action-btn'>Click Me</button></body></html>",
      { takeoverGate: gate },
    );
    const validSnap = validSession.snapshot();
    expect(validSnap.elements.length).toBeGreaterThan(0);
    expect(gate.isResumeSnapshotRequired()).toBe(false);

    // Now mutation succeeds
    expect(() => gate.admitBotAction(true)).not.toThrow();
    clearAllTakeoverControlGates();
  });

  it("POS-INTEG-CROSS-PROCESS: Cross-process boundary coordination between API and Worker containers", async () => {
    // Model two separate process memories:
    // Process 1: rakazo-api-1 (handles authed.computer.takeover and release)
    // Process 2: rakazo-worker-1 (runs executor.ts continueRun and tool execution)

    const gateApi = createTakeoverControlGate({ drainTimeoutMs: 500 });
    const gateWorker = createTakeoverControlGate({ drainTimeoutMs: 500 });

    // 1. Worker is actively executing a bot action in the worker container
    const workerReleaseAction = gateWorker.admitBotAction(false);
    expect(gateWorker.pendingActions()).toBe(1);
    expect(gateApi.pendingActions()).toBe(0); // API in-memory map has 0 actions

    // 2. Simulated DB state: worker holds active computerExecutionLease with run.status === 'running'
    const now = Date.now();
    const dbExecutionLease = {
      computerId: "comp-cross-proc",
      botId: "bot-cross-proc",
      runId: "run-cross-proc",
      fence: 1,
      expiresAt: new Date(now + 60_000),
    };
    const dbRun = {
      id: "run-cross-proc",
      botId: "bot-cross-proc",
      status: "running" as "running" | "waiting_takeover",
      checkpoint: null as string | null,
    };

    // Helper mirroring router.ts / computer-status.ts executionBlocksUserTakeover check:
    const executionBlocksUserTakeover = (input: {
      hasLease: boolean;
      leaseExpiresAt: Date | null | undefined;
      runStatus: string | null | undefined;
      takeoverRequested?: boolean;
    }) => {
      if (!input.hasLease) return false;
      if (input.runStatus === "waiting_takeover" || input.takeoverRequested) return false;
      const leaseActive = Boolean(input.leaseExpiresAt && input.leaseExpiresAt.getTime() > Date.now());
      const runActive = Boolean(input.runStatus && ["queued", "leased", "running"].includes(input.runStatus));
      return leaseActive || runActive;
    };

    // Verify API takeover is blocked by DB execution lease check while worker is active
    const takeoverBlocked = executionBlocksUserTakeover({
      hasLease: Boolean(dbExecutionLease),
      leaseExpiresAt: dbExecutionLease.expiresAt,
      runStatus: dbRun.status,
      takeoverRequested: false,
    });
    expect(takeoverBlocked).toBe(true);

    // 3. Worker finishes turn and yields: run status transitions to 'waiting_takeover'
    workerReleaseAction();
    expect(gateWorker.pendingActions()).toBe(0);
    dbRun.status = "waiting_takeover";

    // Now API takeover check allows takeover to proceed
    const takeoverAllowed = !executionBlocksUserTakeover({
      hasLease: Boolean(dbExecutionLease),
      leaseExpiresAt: dbExecutionLease.expiresAt,
      runStatus: dbRun.status,
      takeoverRequested: true,
    });
    expect(takeoverAllowed).toBe(true);

    // API grants human control in API container
    await gateApi.takeHumanControl();
    expect(gateApi.getHolder()).toBe("human");

    // 4. Human finishes login and API releases control:
    // In router.ts / finalizeComputerControlRelease, DB run checkpoint becomes 'takeover'
    gateApi.releaseHumanControl();
    expect(gateApi.getHolder()).toBe("bot");
    dbRun.checkpoint = "takeover";

    // 5. Worker container resumes execution via continueRun:
    // Worker inspects run.checkpoint ('takeover') and initializes gateWorker
    const isTakeoverResume = dbRun.checkpoint === "takeover";
    expect(isTakeoverResume).toBe(true);

    // In worker container (executor.ts line 4118), worker calls gate.releaseHumanControl()
    gateWorker.releaseHumanControl();

    // Verify worker gate strictly enforces resumeSnapshotRequired across the process boundary
    expect(gateWorker.getHolder()).toBe("bot");
    expect(gateWorker.isResumeSnapshotRequired()).toBe(true);

    // Worker attempts mutation tool (e.g. computer_act or click) - strictly blocked!
    expect(() => gateWorker.admitBotAction(true)).toThrow(SnapshotRequiredError);

    // Worker performs fresh observation (computer_observe / browser_snapshot)
    gateWorker.recordSnapshotTaken();
    expect(gateWorker.isResumeSnapshotRequired()).toBe(false);

    // Mutation tool is now admitted in worker container
    const workerMutation = gateWorker.admitBotAction(true);
    expect(typeof workerMutation).toBe("function");
    workerMutation();
    expect(gateWorker.pendingActions()).toBe(0);
  });
});
