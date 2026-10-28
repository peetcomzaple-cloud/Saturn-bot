import { describe, expect, it } from "vitest";
import {
  createActionBarrier,
  createTakeoverControlGate,
  HumanHasControlError,
  SnapshotRequiredError,
} from "./action-barrier.js";

describe("OpenBot ActionBarrier (borrowed core contract)", () => {
  it("POS-1: admits actions when open and releases properly", () => {
    const barrier = createActionBarrier();
    expect(barrier.pending()).toBe(0);
    const release1 = barrier.enter();
    expect(barrier.pending()).toBe(1);
    const release2 = barrier.enter();
    expect(barrier.pending()).toBe(2);

    release1();
    expect(barrier.pending()).toBe(1);
    // Idempotent release
    release1();
    expect(barrier.pending()).toBe(1);

    release2();
    expect(barrier.pending()).toBe(0);
  });

  it("POS-2: closing barrier rejects new admissions immediately", () => {
    const barrier = createActionBarrier();
    barrier.close();
    expect(() => barrier.enter()).toThrow("Action admission is closed for this computer.");
  });

  it("POS-3: drain awaits in-flight active actions and resolves once all release", async () => {
    const barrier = createActionBarrier();
    const release = barrier.enter();
    barrier.close();

    let drained = false;
    const drainPromise = barrier.drain(1_000).then(() => {
      drained = true;
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(drained).toBe(false);

    release();
    await drainPromise;
    expect(drained).toBe(true);
    expect(barrier.pending()).toBe(0);
  });

  it("NEG-1: drain rejects when active action fails to release within timeout", async () => {
    const barrier = createActionBarrier();
    const release = barrier.enter();
    barrier.close();

    await expect(barrier.drain(50)).rejects.toThrow("An admitted action is still finishing");
    expect(barrier.pending()).toBe(1);

    release();
    await barrier.drain(50);
    expect(barrier.pending()).toBe(0);
  });
});

describe("TakeoverControlGate Adapter (integrated Rakazo takeover contract)", () => {
  it("POS-4: normal bot actions admitted when holder is bot and no snapshot required", () => {
    const gate = createTakeoverControlGate();
    expect(gate.getHolder()).toBe("bot");
    expect(gate.isResumeSnapshotRequired()).toBe(false);

    const release = gate.admitBotAction(true);
    expect(gate.pendingActions()).toBe(1);
    release();
    expect(gate.pendingActions()).toBe(0);
  });

  it("POS-5: taking human control closes admission and drains active bot actions", async () => {
    const gate = createTakeoverControlGate({ drainTimeoutMs: 500 });
    const release = gate.admitBotAction(false);

    let takeoverDone = false;
    const takeoverPromise = gate.takeHumanControl().then(() => {
      takeoverDone = true;
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(takeoverDone).toBe(false);
    expect(gate.getHolder()).toBe("bot");

    // In-flight bot action finishes
    release();
    await takeoverPromise;
    expect(takeoverDone).toBe(true);
    expect(gate.getHolder()).toBe("human");

    // Once human has control, new bot actions are blocked
    expect(() => gate.admitBotAction(false)).toThrow(HumanHasControlError);
  });

  it("POS-6: releasing human control sets resumeSnapshotRequired and blocks browser mutations until snapshot", async () => {
    const gate = createTakeoverControlGate();
    await gate.takeHumanControl();
    gate.releaseHumanControl();

    expect(gate.getHolder()).toBe("bot");
    expect(gate.isResumeSnapshotRequired()).toBe(true);

    // Read-only or non-mutation action is allowed
    const releaseReadOnly = gate.admitBotAction(false);
    releaseReadOnly();

    // Browser mutation action is strictly blocked
    expect(() => gate.admitBotAction(true)).toThrow(SnapshotRequiredError);

    // Recording fresh snapshot lifts the requirement
    gate.recordSnapshotTaken();
    expect(gate.isResumeSnapshotRequired()).toBe(false);

    // Now browser mutation is admitted
    const releaseMutation = gate.admitBotAction(true);
    releaseMutation();
    expect(gate.pendingActions()).toBe(0);
  });

  it("POS-7: releaseHumanControl and requireResumeSnapshot enforce snapshot flag across process boundaries", () => {
    // Fresh gate instance as created in a worker process resuming a run
    const gateWorker = createTakeoverControlGate();
    expect(gateWorker.getHolder()).toBe("bot");
    expect(gateWorker.isResumeSnapshotRequired()).toBe(false);

    // When worker resumes from takeover checkpoint, releaseHumanControl enforces snapshot
    gateWorker.releaseHumanControl();
    expect(gateWorker.isResumeSnapshotRequired()).toBe(true);
    expect(() => gateWorker.admitBotAction(true)).toThrow(SnapshotRequiredError);

    // Recording fresh snapshot clears requirement
    gateWorker.recordSnapshotTaken();
    expect(gateWorker.isResumeSnapshotRequired()).toBe(false);

    // requireResumeSnapshot also directly sets the requirement
    gateWorker.requireResumeSnapshot();
    expect(gateWorker.isResumeSnapshotRequired()).toBe(true);
    expect(() => gateWorker.admitBotAction(true)).toThrow(SnapshotRequiredError);
  });

  it("POS-8: setHumanControl immediately blocks admission without waiting for drain", () => {
    const gate = createTakeoverControlGate();
    gate.setHumanControl();
    expect(gate.getHolder()).toBe("human");
    expect(() => gate.admitBotAction(false)).toThrow(HumanHasControlError);
    expect(() => gate.admitBotAction(true)).toThrow(HumanHasControlError);
  });
});
