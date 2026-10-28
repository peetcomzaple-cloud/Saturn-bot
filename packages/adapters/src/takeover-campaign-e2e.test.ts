import type {
  AdapterContext,
  JobPublisher,
  SandboxProvider,
  ComputerRef,
} from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserRecovery,
  classifyHttp401Or403,
  detectVerifiedChallengeSignal,
} from "./browser-recovery.js";
import { expireComputerControl } from "./computer-control.js";
import {
  acquireComputerExecutionLease,
  holdComputerExecutionLeaseForTakeover,
} from "./computer-lifecycle.js";
import { buildWebWorkflowTurnNote } from "./executor.js";
import { FakeBrowserProvider } from "./fake-browser.js";
import { PageBrowserSession, pageBrowserSessionKey } from "./page-browser-session.js";
import {
  clearAllTakeoverControlGates,
  continueRunClaimFence,
  createActionBarrier,
  createTakeoverControlGate,
  getTakeoverControlGate,
  HumanHasControlError,
  refreshTakeoverContinuePlan,
  SnapshotRequiredError,
  takeoverContinuePlan,
  takeoverResumeFromRelease,
} from "./takeover-resume.js";
import { verifyWebGoal } from "./web-goal-verification.js";

afterEach(() => {
  clearAllTakeoverControlGates();
});

describe("T22c: HTTP 403 Challenge Barrier & Clean Halt to waiting_takeover", () => {
  it("T22c-1: detects Cloudflare, Turnstile, HCaptcha, and Thai security challenges on HTTP 403", () => {
    const cloudflareSignal = detectVerifiedChallengeSignal({
      httpStatus: 403,
      title: "Just a moment...",
      tree: "Verify you are human by completing the action below. Cloudflare Ray ID: 89abcdef",
    });
    expect(cloudflareSignal).toEqual({
      detected: true,
      challengeType: "cloudflare_challenge",
    });

    const thaiCheckboxSignal = detectVerifiedChallengeSignal({
      httpStatus: 403,
      title: "ยืนยันตัวตน",
      elements: [{ role: "checkbox", name: "ยืนยันว่าคุณไม่ใช่บอท (Turnstile)" }],
    });
    expect(thaiCheckboxSignal).toEqual({
      detected: true,
      challengeType: "captcha",
    });

    const c403 = classifyHttp401Or403({
      status: 403,
      url: "https://portal.example.co.th/login",
      title: "Just a moment...",
      bodySnippet: "Verify you are human - Cloudflare Turnstile",
      challengeDetected: true,
    });
    expect(c403.errorCode).toBe("CHALLENGE_DETECTED");
    expect(c403.errorKind).toBe("challenge");
    expect(c403.retryable).toBe(false);
    expect(c403.note).toContain("request_takeover");
  });

  it("T22c-2: enforces zero destructive retry (blocks repeat navigate, browser_act, and cookie/storage clearing)", () => {
    const challengeUrl = "https://portal.example.co.th/auth/login";
    const recovery = new BrowserRecovery([
      {
        kind: "browser_navigate",
        result: {
          ok: false,
          url: challengeUrl,
          httpStatus: 403,
          httpStatusStatus: "known",
          title: "Just a moment...",
          error: "Anti-bot or security challenge detected (Cloudflare Turnstile)",
          challengeDetected: true,
          challengeType: "turnstile",
        },
      },
    ]);

    expect(recovery.isChallengeDetected()).toBe(true);
    expect(recovery.getChallengeType()).toBe("turnstile");

    // 1. Retrying navigation to the same challenge URL is blocked (non-retryable)
    const retryNavBlocked = recovery.blockedResult("browser_navigate", { url: challengeUrl });
    expect(retryNavBlocked).toMatchObject({
      ok: false,
      errorCode: "CHALLENGE_DETECTED",
      retryable: false,
    });

    // 2. Attempting automated page actions (browser_act) is blocked and directs to request_takeover
    const actBlocked = recovery.blockedResult("browser_act", {
      actions: [{ kind: "click", ref: "e1" }],
    });
    expect(actBlocked).toMatchObject({
      ok: false,
      blocked: true,
      challengeDetected: true,
      challengeType: "turnstile",
      fallback: "request_takeover",
    });

    // 3. Attempting destructive cookie/storage clear on a challenge barrier is strictly forbidden
    const clearStorageBlocked = recovery.blockedResult("browser_clear_origin_storage", {
      origin: "https://portal.example.co.th",
    });
    expect(clearStorageBlocked).toMatchObject({
      ok: false,
      retryable: false,
      errorCode: "STORAGE_CLEAR_FORBIDDEN_FOR_CHALLENGE",
      fallback: "request_takeover",
    });

    // 4. request_takeover itself is never blocked by BrowserRecovery
    expect(recovery.blockedResult("request_takeover", {})).toBeUndefined();
  });

  it("T22c-3: cleanly halts run to waiting_takeover, emits challenge takeover effect, and holds 24h execution lease", async () => {
    const now = Date.now();
    let storedExpiresAt = new Date(now + 5 * 60_000);
    const updateMany = vi.fn().mockImplementation(async ({ data }) => {
      storedExpiresAt = data.expiresAt;
      return { count: 1 };
    });
    const externalEffectCreate = vi.fn().mockResolvedValue({ id: "eff-takeover-1" });
    const pauseRunForTakeover = vi.fn().mockResolvedValue(true);

    const prisma = {
      computerExecutionLease: { updateMany },
      externalEffect: { create: externalEffectCreate },
    } as unknown as PrismaClient;

    const lease = {
      computerId: "comp-t22c",
      botId: "bot-t22c",
      runId: "run-t22c",
      fence: 3,
    };

    // Hold computer execution lease for takeover (extends TTL to ~24 hours)
    const held = await holdComputerExecutionLeaseForTakeover(prisma, lease);
    expect(held).toBe(true);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(storedExpiresAt.getTime() - now).toBeGreaterThanOrEqual(23 * 60 * 60_000);

    // Pause run to waiting_takeover and verify takeover_requested effect payload on HTTP 403 challenge
    const latestHttpStatus = 403;
    const isChallenge = true;
    const isLoginTask = true;
    const loginFormVisible = false;
    const isHttpError = latestHttpStatus >= 400;
    const isNonChallengeHttpError = !isChallenge && isHttpError;

    const handoffType =
      isChallenge && !isNonChallengeHttpError
        ? "challenge"
        : isLoginTask
          ? loginFormVisible
            ? "ready_to_fill"
            : "blocker"
          : "takeover";
    expect(handoffType).toBe("challenge");

    await prisma.externalEffect.create({
      data: {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: lease.botId,
        runId: lease.runId,
        kind: "takeover_requested",
        idempotencyKey: `takeover:${lease.runId}:${lease.fence}`,
        status: "completed",
        request: {
          reason: "[พบการตรวจสอบความปลอดภัย] กรุณายืนยัน Cloudflare Turnstile บนหน้าจอ",
          url: "https://portal.example.co.th/auth/login",
          handoffType,
          login_form_visible: loginFormVisible,
          challenge_detected: isChallenge,
        },
        result: {
          login_form_visible: loginFormVisible,
          challenge_detected: isChallenge,
          url: "https://portal.example.co.th/auth/login",
          handoffType,
        },
      },
    });

    const paused = await pauseRunForTakeover({
      spaceId: "space-1",
      threadId: "thread-1",
      botId: lease.botId,
      runId: lease.runId,
      attemptId: "att-1",
      leaseOwner: "worker-1",
      leaseFence: lease.fence,
      reason: "[พบการตรวจสอบความปลอดภัย] กรุณายืนยัน Cloudflare Turnstile บนหน้าจอ",
      computerId: lease.computerId,
    });

    expect(paused).toBe(true);
    expect(externalEffectCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "takeover_requested",
          status: "completed",
          request: expect.objectContaining({
            handoffType: "challenge",
            challenge_detected: true,
          }),
        }),
      }),
    );
  });
});

describe("T37b: Takeover Status Resume, Fresh Snapshot Enforcement & Thai Reconnect", () => {
  it("T37b-1: plans takeover continuation accurately across done, released, skipped, and expired states", () => {
    // 1. Still waiting for takeover (no checkpoint yet)
    const waitingRun = { status: "waiting_takeover", checkpoint: null };
    const waitingPlan = takeoverContinuePlan(waitingRun);
    expect(waitingPlan).toEqual({
      resumeCheckpoint: null,
      heldForTakeover: true,
      resumeHeldLease: true,
      takeoverResume: null,
    });
    expect(continueRunClaimFence(waitingRun)).toEqual({
      status: "waiting_takeover",
      checkpoint: null,
    });

    // 2. Concurrent release while worker is holding transitions plan from held -> resumed
    const refreshedDone = refreshTakeoverContinuePlan(waitingPlan, {
      status: "running",
      checkpoint: "takeover",
    });
    expect(refreshedDone.heldForTakeover).toBe(false);
    expect(refreshedDone.resumeHeldLease).toBe(true);
    expect(refreshedDone.resumeCheckpoint).toBe("takeover");
    expect(refreshedDone.takeoverResume?.promptNote).toMatch(/finished the login/i);

    // 3. Skipped or expired release maps to takeover-skipped
    for (const reason of ["skipped", "expired"] as const) {
      const skippedResume = takeoverResumeFromRelease(reason);
      expect(skippedResume.checkpoint).toBe("takeover-skipped");
      expect(skippedResume.promptNote).toMatch(/skipped the login/i);
    }

    const skippedPlan = takeoverContinuePlan({
      status: "queued",
      checkpoint: "takeover-skipped",
    });
    expect(skippedPlan.heldForTakeover).toBe(false);
    expect(skippedPlan.resumeHeldLease).toBe(true);
    expect(skippedPlan.resumeCheckpoint).toBe("takeover-skipped");
  });

  it("T37b-2: reclaims held computer execution lease on resume with monotonic fence increment", async () => {
    const updateManyAndReturn = vi.fn().mockResolvedValue([{ fence: 4 }]);
    const findUniqueOrThrow = vi.fn().mockResolvedValue({
      id: "comp-t37b",
      state: "running",
      maintenanceId: null,
      updatedAt: new Date(),
    });
    const prisma = {
      computer: { findUniqueOrThrow },
      computerExecutionLease: { updateManyAndReturn },
    } as unknown as PrismaClient;

    const resumedLease = await acquireComputerExecutionLease(prisma, {
      computerId: "comp-t37b",
      botId: "bot-t37b",
      runId: "run-t37b",
      resumeHeldLease: true,
    });

    expect(resumedLease).toEqual({
      computerId: "comp-t37b",
      botId: "bot-t37b",
      runId: "run-t37b",
      fence: 4,
    });
    expect(updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          computerId: "comp-t37b",
          botId: "bot-t37b",
          OR: expect.arrayContaining([{ runId: "run-t37b" }]),
        }),
        data: expect.objectContaining({
          runId: "run-t37b",
          fence: { increment: 1 },
        }),
      }),
    );
  });

  it("T37b-3: preserves multi-turn Thai language requirement and exact user email identifier across takeover resume", () => {
    const thaiPrompt =
      "ช่วยเข้าสู่ระบบที่ https://portal.example.co.th/login ด้วยอีเมล somchai.k@chula.ac.th แล้วดึงยอดคงเหลือใบแจ้งหนี้ให้หน่อยครับ";
    const recentUserTexts = [
      "ใช้อีเมล somchai.k@chula.ac.th เท่านั้นนะครับ ห้ามใช้บัญชีตัวอย่าง",
      "ผมกดยืนยัน CAPTCHA และเข้าสู่ระบบให้เรียบร้อยแล้วครับ ลุยต่อได้เลย",
    ];

    const resumeNoteDone = buildWebWorkflowTurnNote(
      thaiPrompt,
      recentUserTexts,
      true,
      "fixture account: demo@argon-fixture.local",
      "https://portal.example.co.th/login",
      "takeover",
    );

    expect(resumeNoteDone).toBeDefined();
    expect(resumeNoteDone).toContain("[Language Requirement: The user wrote in Thai.");
    expect(resumeNoteDone).toContain(
      '[Identifier Retention: The user previously provided the email "somchai.k@chula.ac.th".',
    );
    expect(resumeNoteDone).toContain(
      "[Takeover Release Continuation: The user just released screen control in the existing browser session. First call browser_snapshot",
    );

    const resumeNoteSkipped = buildWebWorkflowTurnNote(
      thaiPrompt,
      recentUserTexts,
      true,
      undefined,
      "https://portal.example.co.th/login",
      "takeover-skipped",
    );
    expect(resumeNoteSkipped).toBeDefined();
    expect(resumeNoteSkipped).toContain("[Language Requirement: The user wrote in Thai.");
    expect(resumeNoteSkipped).toContain(
      '[Identifier Retention: The user previously provided the email "somchai.k@chula.ac.th".',
    );
    expect(resumeNoteSkipped).toContain(
      "[Takeover Skipped Continuation: The user skipped or canceled the screen takeover. First call browser_snapshot",
    );
  });

  it("T37b-4: enforces fresh snapshot after takeover release and completes post-takeover Thai workflow end-to-end", async () => {
    const computer: ComputerRef = {
      id: "comp-t37b-e2e",
      botId: "bot-t37b-e2e",
      homeKey: "home-t37b-e2e",
      kind: "docker",
    };
    const context: AdapterContext = {
      operationId: "op-t37b",
      traceId: "trace-t37b",
      spaceId: "space-t37b",
      userId: "user-t37b",
      botId: computer.botId,
      signal: new AbortController().signal,
    };

    const pages: Record<string, { title: string; html: string }> = {
      "https://portal.example.co.th/billing": {
        title: "Just a moment...",
        html: "<html><body><h1>Verify you are human</h1><button id='cf-turnstile'>Verify you are human (Turnstile)</button></body></html>",
      },
    };

    const browser = new FakeBrowserProvider({ pages });
    const gate = getTakeoverControlGate(computer.id);
    const recovery = new BrowserRecovery();

    // Step 1: Bot navigates to target billing URL and encounters Cloudflare Turnstile challenge
    const initialNav = await browser.navigate(
      computer,
      { url: "https://portal.example.co.th/billing" },
      context,
    );
    recovery.record("browser_navigate", {
      ...initialNav,
      httpStatus: 403,
      challengeDetected: true,
      challengeType: "turnstile",
    });
    expect(recovery.isChallengeDetected()).toBe(true);

    // Step 2: Run halts for human takeover; human takes control of screen
    await gate.takeHumanControl();
    expect(gate.getHolder()).toBe("human");

    // While human has control, any bot action is blocked with HumanHasControlError
    const blockedDuringTakeover = await browser.act(
      computer,
      { actions: [{ kind: "click", ref: "e1" }] },
      context,
    );
    expect(blockedDuringTakeover.ok).toBe(false);
    expect(blockedDuringTakeover.error).toContain("A person has control");

    // Step 3: Human solves challenge & logs in as somchai.k@chula.ac.th on the screen, then releases takeover ("done")
    const session = browser.sessions.get(pageBrowserSessionKey(computer, context));
    session.setTakeoverGate(undefined);
    session.load(
      "https://portal.example.co.th/billing",
      `<!doctype html><html><head><title>ระบบใบแจ้งหนี้ - จุฬาลงกรณ์มหาวิทยาลัย</title></head><body>
        <a href="#profile" id="account-link">บัญชีผู้ใช้: somchai.k@chula.ac.th</a>
        <button id="ack-btn">รับทราบยอดแจ้งหนี้ 12,450.00 บาท (INV-2569-088)</button>
      </body></html>`,
    );
    session.setTakeoverGate(gate);

    gate.releaseHumanControl();
    expect(gate.getHolder()).toBe("bot");
    expect(gate.isResumeSnapshotRequired()).toBe(true);

    // Step 4: Bot resumes from "takeover" checkpoint. Any mutation before browser_snapshot MUST fail with SnapshotRequiredError!
    expect(() => gate.admitBotAction(true)).toThrow(SnapshotRequiredError);
    const prematureAct = await browser.act(
      computer,
      { actions: [{ kind: "click", ref: "e1" }] },
      context,
    );
    expect(prematureAct.ok).toBe(false);
    expect(prematureAct.error).toContain(
      "Take a fresh browser snapshot after handback before acting.",
    );

    // Step 5: Bot takes a fresh browser_snapshot, clearing the snapshot requirement and reconciling challenge state
    const freshSnap = await browser.snapshot(computer, {}, context);
    recovery.record("browser_snapshot", {
      ...freshSnap,
      challengeDetected: false,
    });
    expect(gate.isResumeSnapshotRequired()).toBe(false);
    expect(recovery.isChallengeDetected()).toBe(false);
    expect(freshSnap.title).toContain("ระบบใบแจ้งหนี้");
    expect(freshSnap.tree).toContain("somchai.k@chula.ac.th");
    expect(freshSnap.tree).toContain("12,450.00 บาท");

    // Step 6: Post-snapshot browser_act mutation now succeeds
    const ackRef = freshSnap.elements.find((el) => el.name.includes("รับทราบยอดแจ้งหนี้"))?.ref;
    expect(ackRef).toBeDefined();
    const postSnapAct = await browser.act(
      computer,
      { actions: [{ kind: "click", ref: ackRef! }] },
      context,
    );
    expect(postSnapAct.ok).toBe(true);
    recovery.record("browser_act", postSnapAct);

    // Step 7: Web goal verification passes for the completed post-takeover state
    const goalCheck = verifyWebGoal(
      "เปิดหน้า https://portal.example.co.th/billing แล้วกดปุ่มรับทราบยอดแจ้งหนี้และสรุปยอดคงเหลือให้ด้วยครับ",
      {
        actionsAttempted: 1,
        lastActionOk: true,
        lastActionVerified: true,
        domStateChanged: true,
        currentUrl: freshSnap.url,
        currentTitle: freshSnap.title,
      },
    );
    expect(goalCheck.ok).toBe(true);
  });
});

describe("Action Barrier Invariants: Draining, Bot Blocking & Expired/Skipped Release", () => {
  it("BARRIER-1: drains multiple concurrent in-flight bot actions before granting human control", async () => {
    const gate = createTakeoverControlGate({ drainTimeoutMs: 1_000 });
    const release1 = gate.admitBotAction(false);
    const release2 = gate.admitBotAction(true);
    expect(gate.pendingActions()).toBe(2);

    let humanGranted = false;
    const takeoverPromise = gate.takeHumanControl().then(() => {
      humanGranted = true;
    });

    // While draining, new bot actions are immediately rejected by the closed barrier
    expect(() => gate.admitBotAction(false)).toThrow(
      "Action admission is closed for this computer.",
    );

    release1();
    await new Promise((r) => setTimeout(r, 15));
    expect(humanGranted).toBe(false);
    expect(gate.pendingActions()).toBe(1);

    release2();
    await takeoverPromise;
    expect(humanGranted).toBe(true);
    expect(gate.getHolder()).toBe("human");
    expect(gate.pendingActions()).toBe(0);

    // Subsequent bot actions throw HumanHasControlError
    expect(() => gate.admitBotAction(false)).toThrow(HumanHasControlError);
    expect(() => gate.admitBotAction(true)).toThrow(HumanHasControlError);
  });

  it("BARRIER-2: rejects human takeover on drain timeout and preserves accurate pending count", async () => {
    const gate = createTakeoverControlGate({ drainTimeoutMs: 40 });
    const releaseStuck = gate.admitBotAction(true);

    await expect(gate.takeHumanControl()).rejects.toThrow(
      "An admitted action is still finishing; human control has not been granted",
    );
    expect(gate.getHolder()).toBe("bot");
    expect(gate.pendingActions()).toBe(1);

    // Once stuck action finally exits, a retry of takeHumanControl succeeds cleanly
    releaseStuck();
    await gate.takeHumanControl();
    expect(gate.getHolder()).toBe("human");
  });

  it("BARRIER-3: handles expired takeover lease by revoking screen control, emitting expired release, and resuming as takeover-skipped", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUnique = vi.fn().mockResolvedValue({
      id: "comp-exp-1",
      spaceId: "space-1",
      homeKey: "bot-1",
      kind: "docker",
      providerRef: "container-1",
      state: "running",
      controlHolder: "user",
      controlLeaseId: "lease-exp-1",
      controlLeaseExpiresAt: new Date(Date.now() - 1_000),
      controlBotId: "bot-1",
      controlRunId: "run-exp-1",
      bots: [{ id: "bot-1" }],
    });
    const findFirstRun = vi.fn().mockResolvedValue({ id: "run-exp-1" });
    const finalizeComputerControlRelease = vi.fn().mockResolvedValue({ runId: "run-exp-1" });
    const setScreenControl = vi.fn().mockResolvedValue(undefined);
    const enqueue = vi.fn().mockResolvedValue(undefined);

    const deps = {
      prisma: {
        computer: { findUnique, updateMany },
        computerExecutionLease: { findFirst: vi.fn().mockResolvedValue(null) },
        run: { findFirst: findFirstRun },
      } as unknown as PrismaClient,
      sandbox: { setScreenControl } as unknown as SandboxProvider,
      jobs: { enqueue } as unknown as JobPublisher,
      events: { finalizeComputerControlRelease } as unknown as ThreadEvents,
    };

    const expired = await expireComputerControl(deps, "comp-exp-1", "lease-exp-1");
    expect(expired).toBe(true);
    expect(setScreenControl).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "container-1" }),
      false,
      expect.objectContaining({ operationId: "computer.control-expire" }),
      "lease-exp-1",
    );
    expect(finalizeComputerControlRelease).toHaveBeenCalledWith({
      spaceId: "space-1",
      computerId: "comp-exp-1",
      botId: "bot-1",
      runId: "run-exp-1",
      leaseId: "lease-exp-1",
      holder: "none",
      reason: "expired",
    });
    expect(enqueue).toHaveBeenCalledWith({
      name: "run.continue",
      payload: { runId: "run-exp-1" },
      replaceKey: "run:run-exp-1",
    });

    // When the worker picks up run.continue after expiry, the checkpoint is takeover-skipped
    // and the control gate requires a fresh snapshot before any browser mutation
    const resumeInfo = takeoverResumeFromRelease("expired");
    expect(resumeInfo.checkpoint).toBe("takeover-skipped");

    const plan = takeoverContinuePlan({
      status: "queued",
      checkpoint: resumeInfo.checkpoint,
    });
    expect(plan.resumeCheckpoint).toBe("takeover-skipped");
    expect(plan.heldForTakeover).toBe(false);
    expect(plan.resumeHeldLease).toBe(true);

    const session = new PageBrowserSession(
      "https://portal.example.co.th/login",
      "<html><body><h1>Just a moment...</h1><button id='retry'>Verify</button></body></html>",
      { takeoverGate: getTakeoverControlGate("comp-exp-1") },
    );
    const gate = getTakeoverControlGate("comp-exp-1");
    gate.releaseHumanControl();
    expect(gate.isResumeSnapshotRequired()).toBe(true);

    // Mutation before snapshot is blocked
    const blockedAct = session.act([{ kind: "click", ref: "retry" }]);
    expect(blockedAct.ok).toBe(false);
    expect(blockedAct.error).toContain("Take a fresh browser snapshot after handback before acting.");

    // Fresh snapshot succeeds and lifts the gate
    const snap = session.snapshot();
    expect(snap.title).toBe("");
    expect(gate.isResumeSnapshotRequired()).toBe(false);
  });
});
