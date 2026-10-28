import { describe, expect, it } from "vitest";
import { BrowserRecovery } from "./browser-recovery.js";
import { formatThaiBrowserFailureMessage } from "./verified-urls.js";
import { verifyWebGoal, type WebGoalState } from "./web-goal-verification.js";

describe("Phase 3F & 3G: Recovery & Challenge Invariants", () => {
  describe("R03: Flow state invalid (HTTP 400 internal auth route)", () => {
    const internalFlowError = {
      ok: false,
      url: "https://accounts.google.com/signin/v2/challenge?flowEntry=ServiceLogin",
      hostname: "accounts.google.com",
      httpStatus: 400,
      error: "Error 400 (Bad Request)!!1",
    };

    it("records flow_state_invalid on HTTP 400 auth URL", () => {
      const recovery = new BrowserRecovery([
        { kind: "browser_navigate", result: internalFlowError },
      ]);
      const navFailure = recovery.getNavigationFailure();
      expect(navFailure).toBeDefined();
      expect(navFailure?.errorKind).toBe("flow_state_invalid");
      expect(navFailure?.errorCode).toBe("FLOW_STATE_INVALID");
    });

    it("blocks retrying the exact broken internal auth URL", () => {
      const recovery = new BrowserRecovery([
        { kind: "browser_navigate", result: internalFlowError },
      ]);
      const blocked = recovery.blockedResult("browser_navigate", {
        url: "https://accounts.google.com/signin/v2/challenge?flowEntry=ServiceLogin",
      });
      expect(blocked).toBeDefined();
      expect(blocked?.errorCode).toBe("FLOW_STATE_INVALID");
      expect(blocked?.error).toContain("navigate to the service entry point instead");
    });

    it("allows navigating to the service entry point (base login URL) to recover", () => {
      const recovery = new BrowserRecovery([
        { kind: "browser_navigate", result: internalFlowError },
      ]);
      const allowed = recovery.blockedResult("browser_navigate", {
        url: "https://accounts.google.com/",
      });
      expect(allowed).toBeUndefined();
    });

    it("blocks browser_act while page is stuck in invalid flow state", () => {
      const recovery = new BrowserRecovery([
        { kind: "browser_navigate", result: internalFlowError },
      ]);
      const actBlocked = recovery.blockedResult("browser_act");
      expect(actBlocked).toBeDefined();
      expect(actBlocked?.errorCode).toBe("FLOW_STATE_INVALID");
      expect(actBlocked?.error).toContain("Return to service entry point first");
    });
  });

  describe("R02: CDP disconnection / target closed recovery", () => {
    it("records CDP disconnected and blocks browser_act until reconnected", () => {
      const recovery = new BrowserRecovery([
        { kind: "browser_act", result: { ok: false, error: "WebSocket connection closed (CDP disconnected)" } },
      ]);
      expect(recovery.isCdpDisconnected()).toBe(true);

      const blocked = recovery.blockedResult("browser_act");
      expect(blocked).toBeDefined();
      expect(blocked?.errorCode).toBe("CDP_DISCONNECTED");
      expect(blocked?.retryable).toBe(true);

      // Successful navigation clears CDP disconnection
      recovery.record("browser_navigate", { ok: true, url: "https://example.com" });
      expect(recovery.isCdpDisconnected()).toBe(false);
      expect(recovery.blockedResult("browser_act")).toBeUndefined();
    });
  });

  describe("Phase 3G: Security challenge (CAPTCHA) detection & takeover handoff", () => {
    it("detects CAPTCHA in browser_act and blocks further automated page actions", () => {
      const recovery = new BrowserRecovery([
        {
          kind: "browser_act",
          result: {
            ok: false,
            error: "Security verification required: Cloudflare Turnstile challenge detected",
            challengeDetected: true,
            challengeType: "turnstile",
          },
        },
      ]);
      expect(recovery.isChallengeDetected()).toBe(true);
      expect(recovery.getChallengeType()).toBe("turnstile");

      const blocked = recovery.blockedResult("browser_act");
      expect(blocked).toBeDefined();
      expect(blocked?.blocked).toBe(true);
      expect(blocked?.fallback).toBe("request_takeover");
      expect(String(blocked?.note)).toContain("ตรวจพบแบบทดสอบความปลอดภัย");
    });

    it("detects challenge from browser_snapshot and reports in unresolvedResult", () => {
      const recovery = new BrowserRecovery();
      recovery.record("browser_snapshot", {
        ok: true,
        title: "Just a moment... | Security Verification",
        challengeDetected: true,
      });
      expect(recovery.isChallengeDetected()).toBe(true);

      const unresolved = recovery.unresolvedResult();
      expect(unresolved).toBeDefined();
      expect(unresolved?.challengeDetected).toBe(true);
      expect(unresolved?.fallback).toBe("request_takeover");
    });

    it("clears challenge when snapshot confirms challenge resolved", () => {
      const recovery = new BrowserRecovery([
        {
          kind: "browser_act",
          result: { ok: false, error: "CAPTCHA detected", challengeDetected: true },
        },
      ]);
      expect(recovery.isChallengeDetected()).toBe(true);

      // Snapshot taken after human solves CAPTCHA
      recovery.record("browser_snapshot", {
        ok: true,
        title: "Shopee Thailand | Search Results",
        challengeDetected: false,
      });
      expect(recovery.isChallengeDetected()).toBe(false);
      expect(recovery.blockedResult("browser_act")).toBeUndefined();
    });
  });

  describe("Thai browser failure message formatting", () => {
    it("formats Thai message for challenge", () => {
      const msg = formatThaiBrowserFailureMessage({
        challengeDetected: true,
        challengeType: "hCaptcha",
      });
      expect(msg).toContain("ตรวจพบแบบทดสอบความปลอดภัย (hCaptcha)");
      expect(msg).toContain("ต้องให้ผู้ใช้ช่วยดำเนินการบนหน้าจอ");
    });

    it("formats Thai message for FLOW_STATE_INVALID", () => {
      const msg = formatThaiBrowserFailureMessage({
        errorCode: "FLOW_STATE_INVALID",
      });
      expect(msg).toContain("HTTP 400 (flow state ไม่ถูกต้อง)");
      expect(msg).toContain("ควรนำทางกลับไปยังหน้าเริ่มต้นของบริการ");
    });

    it("formats Thai message for CDP_DISCONNECTED", () => {
      const msg = formatThaiBrowserFailureMessage({
        errorCode: "CDP_DISCONNECTED",
      });
      expect(msg).toContain("การเชื่อมต่อเบราว์เซอร์ขัดข้อง (CDP disconnected)");
    });
  });

  describe("Goal verification invariant: B03 & C06", () => {
    const baseState: WebGoalState = {
      actionsAttempted: 2,
      lastActionOk: true,
      domStateChanged: true,
      searchSubmitted: true,
      currentUrl: "https://shopee.co.th/search?keyword=น้ำเปล่า",
    };

    it("B03: rejects completion when challenge is detected on HTTP 200 page", () => {
      const challengeState: WebGoalState = {
        ...baseState,
        challengeDetected: true,
        challengeType: "turnstile",
      };
      const result = verifyWebGoal("ค้นหา น้ำเปล่า ใน shopee", challengeState);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("ตรวจพบแบบทดสอบความปลอดภัย (turnstile)");
    });

    it("B03: rejects completion when page title indicates security challenge", () => {
      const challengeTitleState: WebGoalState = {
        ...baseState,
        currentTitle: "Just a moment... | Cloudflare Challenge",
      };
      const result = verifyWebGoal("ค้นหา น้ำเปล่า ใน shopee", challengeTitleState);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("หน้าเว็บติดแบบทดสอบความปลอดภัย");
    });

    it("C06: challenge cleared does not automatically satisfy incomplete task", () => {
      // Challenge is cleared (challengeDetected=false), but search submission did not occur (still on homepage)
      const postChallengeIncomplete: WebGoalState = {
        actionsAttempted: 1,
        lastActionOk: true,
        challengeDetected: false,
        searchAttempted: false,
        searchSubmitted: false,
        navigationOnly: true,
        currentUrl: "https://shopee.co.th/",
      };
      const result = verifyWebGoal("ค้นหา น้ำเปล่า ใน shopee", postChallengeIncomplete);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("งานค้นหายังไม่สำเร็จ");
    });

    it("passes verification when challenge is solved and search goal is genuinely verified", () => {
      const verifiedState: WebGoalState = {
        actionsAttempted: 3,
        lastActionOk: true,
        lastActionVerified: true,
        challengeDetected: false,
        searchAttempted: true,
        searchSubmitted: true,
        domStateChanged: true,
        currentUrl: "https://shopee.co.th/search?keyword=น้ำเปล่า",
      };
      const result = verifyWebGoal("ค้นหา น้ำเปล่า ใน shopee", verifiedState);
      expect(result.ok).toBe(true);
    });
  });
});
