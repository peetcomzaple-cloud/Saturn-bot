import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { ComputerBrowserProvider } from "./computer-browser.js";
import { browserSnapshotFromTool } from "./browser-tools.js";
import { describe, expect, it } from "vitest";
import { BrowserRecovery } from "./browser-recovery.js";

const stale = { ok: false, completed: 0, uncertain: false, error: "Stale element ref" };

describe("browser failure recovery", () => {
  it("allows one fresh attempt, then blocks across approval resumes and snapshots", () => {
    const recovery = new BrowserRecovery([{ kind: "browser_act", result: stale }]);
    expect(recovery.blockedResult()).toBeUndefined();
    // One failed click is still not a completed task, even before the retry limit.
    expect(recovery.unresolvedResult()).toMatchObject({ completed: 0, ok: false });
    recovery.record("browser_snapshot", { ok: true });
    recovery.record("browser_act", stale);
    expect(recovery.blockedResult()).toMatchObject({ fallback: "computer_act", uncertain: false });
    recovery.record("browser_snapshot", { ok: true });
    expect(recovery.blockedResult()).toBeDefined();
  });

  it.each([
    { completed: 1, uncertain: false },
    { completed: 0, uncertain: true },
  ])("does not replay a partial or uncertain mutation: %s", (progress) => {
    const recovery = new BrowserRecovery([
      { kind: "browser_act", result: { ...stale, ...progress } },
    ]);
    expect(recovery.blockedResult()).toMatchObject({ uncertain: true });
  });

  it("clears the failure only after a successful action, not a failed fallback", () => {
    const effects = [
      { kind: "browser_act", result: stale },
      { kind: "browser_act", result: stale },
    ];
    const recovery = new BrowserRecovery(effects);
    recovery.record("computer_act", { error: "Screen unavailable" });
    expect(recovery.blockedResult()).toBeDefined();
    recovery.record("computer_act", { completed: 1 });
    expect(recovery.blockedResult()).toBeUndefined();
    expect(recovery.unresolvedResult()).toBeUndefined();
    expect(
      new BrowserRecovery([
        ...effects,
        { kind: "computer_act", result: { completed: 1 } },
      ]).blockedResult(),
    ).toBeUndefined();
  });

  describe("navigation failure recovery", () => {
    const nxdomainFailure = {
      ok: false,
      url: "https://flick.mdcu.ac.th/",
      hostname: "flick.mdcu.ac.th",
      error: "net::ERR_NAME_NOT_RESOLVED",
      errorCode: "NXDOMAIN",
      errorKind: "nxdomain",
      retryable: false,
      suggestions: ["https://flick.docchula.com/"],
      note: "เปิด flick.mdcu.ac.th ไม่ได้ เพราะตรวจไม่พบชื่อโดเมนใน DNS",
    };

    it("records navigation failure and blocks browser_act", () => {
      const recovery = new BrowserRecovery([
        { kind: "browser_navigate", result: nxdomainFailure },
      ]);
      const actBlocked = recovery.blockedResult("browser_act");
      expect(actBlocked).toBeDefined();
      expect(actBlocked?.error).toContain("navigation to https://flick.mdcu.ac.th/ failed");

      const unresolved = recovery.unresolvedResult();
      expect(unresolved).toBeDefined();
      expect(unresolved?.errorCode).toBe("NXDOMAIN");
      expect(unresolved?.fallback).toBeUndefined(); // Fallback to computer_act suppressed for NXDOMAIN
      expect(unresolved?.suggestions).toEqual(["https://flick.docchula.com/"]);
    });

    it("blocks retrying the same NXDOMAIN host via browser_navigate or computer_act", () => {
      const recovery = new BrowserRecovery([
        { kind: "browser_navigate", result: nxdomainFailure },
      ]);

      // Retrying the same unresolvable URL is blocked
      const navBlocked = recovery.blockedResult("browser_navigate", {
        url: "https://flick.mdcu.ac.th/another-page",
      });
      expect(navBlocked).toBeDefined();
      expect(navBlocked?.errorCode).toBe("NXDOMAIN");

      // Desktop fallback trying to open the unresolvable host is also blocked
      const desktopBlocked = recovery.blockedResult("computer_act", {
        action: "launch",
        application: "google-chrome",
        uri: "https://flick.mdcu.ac.th/",
      });
      expect(desktopBlocked).toBeDefined();
      expect(desktopBlocked?.errorCode).toBe("NXDOMAIN");
    });

    it("allows navigating to a different verified URL", () => {
      const recovery = new BrowserRecovery([
        { kind: "browser_navigate", result: nxdomainFailure },
      ]);
      const diffNav = recovery.blockedResult("browser_navigate", {
        url: "https://flick.docchula.com/",
      });
      expect(diffNav).toBeUndefined();
    });

    it("clears navigation failure only when browser_navigate succeeds, not on snapshot or computer_act", () => {
      const recovery = new BrowserRecovery([
        { kind: "browser_navigate", result: nxdomainFailure },
      ]);

      // Snapshot does NOT clear navigation failure
      recovery.record("browser_snapshot", { ok: true, title: "about:blank" });
      expect(recovery.unresolvedResult()).toBeDefined();

      // computer_act click does NOT clear navigation failure
      recovery.record("computer_act", { completed: 1 });
      expect(recovery.unresolvedResult()).toBeDefined();

      // Successful browser_navigate DOES clear navigation failure
      recovery.record("browser_navigate", {
        ok: true,
        url: "https://flick.docchula.com/",
        title: "Flick Chula",
      });
      expect(recovery.unresolvedResult()).toBeUndefined();
      expect(recovery.blockedResult("browser_act")).toBeUndefined();
    });
  });

  describe("stale ref pre-dispatch recovery and idempotency", () => {
    it("guides model to take fresh snapshot before retrying browser_act on stale ref", () => {
      const recovery = new BrowserRecovery([{ kind: "browser_act", result: stale }]);
      // Without fresh snapshot, browser_act is blocked with guidance
      const blocked = recovery.blockedResult("browser_act");
      expect(blocked).toBeDefined();
      expect(blocked?.failedBeforeDispatch).toBe(true);
      expect(blocked?.retryable).toBe(true);
      expect(String(blocked?.error)).toContain("Call browser_snapshot");

      // Recording a successful snapshot unblocks browser_act for retry
      recovery.record("browser_snapshot", { ok: true, elements: [] });
      expect(recovery.blockedResult("browser_act")).toBeUndefined();

      // Successful retry clears all failures
      recovery.record("browser_act", { ok: true, completed: 1 });
      expect(recovery.blockedResult("browser_act")).toBeUndefined();
      expect(recovery.unresolvedResult()).toBeUndefined();
    });

    it("locks and falls back to computer_act if stale ref fails twice after snapshots", () => {
      const recovery = new BrowserRecovery([{ kind: "browser_act", result: stale }]);
      recovery.record("browser_snapshot", { ok: true });
      recovery.record("browser_act", stale);
      const blocked = recovery.blockedResult("browser_act");
      expect(blocked).toBeDefined();
      expect(blocked?.fallback).toBe("computer_act");
      expect(String(blocked?.note)).toContain("Do not retry browser_act");
    });

    it("never permits replaying an action that was uncertain or partially completed", () => {
      const partial = new BrowserRecovery([
        { kind: "browser_act", result: { ok: false, completed: 1, uncertain: false, error: "timeout" } },
      ]);
      expect(partial.blockedResult("browser_act")).toBeDefined();
      expect(partial.blockedResult("browser_act")?.uncertain).toBe(true);

      const uncertain = new BrowserRecovery([
        { kind: "browser_act", result: { ok: false, completed: 0, uncertain: true, error: "network reset" } },
      ]);
      expect(uncertain.blockedResult("browser_act")).toBeDefined();
      expect(uncertain.blockedResult("browser_act")?.uncertain).toBe(true);
    });
  });

  describe("main-document HTTP status and scoped storage recovery", () => {
    it("classifies HTTP 400 and allows a single scoped browser_clear_origin_storage attempt before retrying", () => {
      const http400 = {
        ok: false,
        url: "https://portal.example.test/dashboard",
        title: "400 Bad Request",
        httpStatus: 400,
        httpStatusStatus: "known",
        errorCode: "FLOW_STATE_INVALID",
        errorKind: "flow_state_invalid",
        retryable: true,
        error: "HTTP 400 on https://portal.example.test/dashboard",
      };
      const recovery = new BrowserRecovery([
        { kind: "browser_navigate", result: http400 },
      ]);
      expect(recovery.unresolvedResult()).toMatchObject({
        errorCode: "FLOW_STATE_INVALID",
        httpStatus: 400,
        httpStatusStatus: "known",
      });
      // First clear_origin_storage is allowed
      expect(
        recovery.blockedResult("browser_clear_origin_storage", {
          origin: "https://portal.example.test",
        }),
      ).toBeUndefined();

      recovery.record("browser_clear_origin_storage", {
        ok: true,
        origin: "https://portal.example.test",
        clearedStorageTypes: ["cookies", "local_storage"],
      });
      // Second clear_origin_storage in the same failure cycle is blocked to prevent loops
      expect(
        recovery.blockedResult("browser_clear_origin_storage", {
          origin: "https://portal.example.test",
        }),
      ).toMatchObject({
        ok: false,
        retryable: false,
      });

      // Retrying navigate after clearing storage is allowed once
      expect(
        recovery.blockedResult("browser_navigate", {
          url: "https://portal.example.test/dashboard",
        }),
      ).toBeUndefined();
    });

    it("classifies HTTP 429 with Retry-After and HTTP 401/403/5xx/challenge", () => {
      const recovery429 = new BrowserRecovery([
        {
          kind: "browser_navigate",
          result: {
            ok: false,
            url: "https://api.example.test/items",
            httpStatus: 429,
            httpStatusStatus: "known",
            retryAfterMs: 30_000,
          },
        },
      ]);
      expect(recovery429.unresolvedResult()).toMatchObject({
        errorCode: "HTTP_429",
        errorKind: "rate_limited",
        httpStatus: 429,
        retryAfterMs: 30_000,
        retryable: true,
      });

      const recovery403Challenge = new BrowserRecovery([
        {
          kind: "browser_navigate",
          result: {
            ok: false,
            url: "https://secure.example.test/login",
            httpStatus: 403,
            httpStatusStatus: "known",
            challengeDetected: true,
          },
        },
      ]);
      expect(recovery403Challenge.unresolvedResult()).toMatchObject({
        errorCode: "CHALLENGE_DETECTED",
        errorKind: "challenge",
        httpStatus: 403,
        retryable: false,
      });

      const recovery503 = new BrowserRecovery([
        {
          kind: "browser_navigate",
          result: {
            ok: false,
            url: "https://service.example.test/",
            httpStatus: 503,
            httpStatusStatus: "known",
          },
        },
      ]);
      expect(recovery503.unresolvedResult()).toMatchObject({
        errorCode: "HTTP_503",
        errorKind: "server_error",
        httpStatus: 503,
        retryable: true,
      });
    });

    it("does not fabricate HTTP failure when httpStatusStatus is unknown and ok is true", () => {
      const recovery = new BrowserRecovery([
        {
          kind: "browser_navigate",
          result: {
            ok: true,
            url: "https://spa.example.test/app",
            title: "SPA App",
            httpStatusStatus: "unknown",
          },
        },
      ]);
      expect(recovery.unresolvedResult()).toBeUndefined();
      expect(recovery.blockedResult("browser_act")).toBeUndefined();
    });
  });
});



describe("aborted navigation reconciled by a replacement document", () => {
  const failure = { ok: false, url: "https://workspace.example.test/document", error: "Navigation failed: net::ERR_ABORTED" };
  const snapshot = { ok: true, url: failure.url, readyState: "complete", tree: "Document content",
    targetId: "replacement", frameId: "frame", loaderId: "loader", snapshotGeneration: 1 };

  it("clears an aborted navigation only after a fresh document snapshot at the exact URL", () => {
    const recovery = new BrowserRecovery([{ kind: "browser_navigate", result: failure }]);
    expect(recovery.unresolvedResult()).toBeDefined();
    recovery.record("browser_snapshot", snapshot);
    expect(recovery.unresolvedResult()).toBeUndefined();
    expect(recovery.blockedResult("browser_act")).toBeUndefined();
  });

  it.each([
    { url: "https://workspace.example.test/other" }, { url: "chrome-error://chromewebdata/" },
    { ok: false }, { ok: null }, { fallback: "computer_act" }, { error: "snapshot failed" }, { readyState: "loading" }, { tree: "" },
    { targetId: undefined }, { frameId: undefined }, { loaderId: undefined }, { snapshotGeneration: 0 },
    { tree: "This site cannot be reached ERR_CONNECTION_REFUSED" },
    { httpStatus: 403 }, { status_code: 403 }, { status_code: 503 }, { errorDocumentStatus: 403 }, { challengeDetected: true },
  ])("preserves failure when recovery evidence is incomplete or blocked: %j", (delta) => {
    const recovery = new BrowserRecovery([{ kind: "browser_navigate", result: failure }]);
    recovery.record("browser_snapshot", { ...snapshot, ...delta });
    expect(recovery.unresolvedResult()).toBeDefined();
  });

  it.each(["net::ERR_NAME_NOT_RESOLVED", "net::ERR_CERT_AUTHORITY_INVALID", "HTTP 403", "HTTP 429", "net::ERR_TIMED_OUT"])(
    "does not clear other navigation failures on snapshot: %s", (error) => {
      const recovery = new BrowserRecovery([{ kind: "browser_navigate", result: { ...failure, error } }]);
      recovery.record("browser_snapshot", snapshot);
      expect(recovery.unresolvedResult()).toBeDefined();
    },
  );
});


it("reconciles aborted navigation through the real provider and snapshot tool boundary", async () => {
  const url = "https://workspace.example.test/document";
  const browser = new ComputerBrowserProvider({ liveDriver: async () => ({
    ok: true, url, title: "Document", tree: "Recovered document", elements: [],
    readyState: "complete", targetId: "replacement", frameId: "frame", loaderId: "loader", snapshotGeneration: 1,
  }) });
  const computer: ComputerRef = { id: "computer-test", botId: "bot-test", kind: "docker", providerRef: "computer-test" };
  const context: AdapterContext = { operationId: "op", traceId: "trace", spaceId: "space", userId: "user", signal: new AbortController().signal };
  const result = await browserSnapshotFromTool(browser, computer, context, {});
  expect(result).not.toHaveProperty("ok");
  const recovery = new BrowserRecovery([{ kind: "browser_navigate", result: { ok: false, url, error: "net::ERR_ABORTED" } }]);
  recovery.record("browser_snapshot", result);
  expect(recovery.unresolvedResult()).toBeUndefined();
});
