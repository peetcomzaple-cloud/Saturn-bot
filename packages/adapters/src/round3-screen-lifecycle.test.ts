import type { ComputerAction, ComputerObservation } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isPointerClickAction,
  isKeyboardSubmitAction,
  isWindowCloseAction,
  isWindowClosed,
  verifyWindowCloseEvidence,
  sanitizeScreenIdentity,
  isSameScreenGeneration,
  sanitizeWebScreenIdentity,
  observationToolResult,
  parseComputerActions,
  type ExtendedComputerObservation,
  type ScreenIdentityMetadata,
  type WindowInventoryEntry,
} from "./computer-tools.js";
import {
  ensureScreenCommand,
  launchBrowserCommand,
  stopBrowserCommand,
} from "@rakazo/core/node/desktop-runtime";

describe("Rakazo ROUND3 Owner C: Screen lifecycle & browser separation", () => {
  describe("1. View/observe decoupling from browser launch", () => {
    it("ensureScreenCommand prepares Xvfb, fluxbox, and VNC gateway without launching Chromium or polling CDP", () => {
      // For secondary screens (index >= 1), Xvfb and fluxbox are launched
      const command = ensureScreenCommand(1, "bot-beta", "secret_view_token_123");

      // Transport components must be present
      expect(command).toContain("Xvfb");
      expect(command).toContain("fluxbox");
      expect(command).toContain("x11vnc");
      expect(command).toContain("desktop_view_token='secret_view_token_123'");

      // Browser execution and CDP polling must NOT be in ensureScreenCommand
      expect(command).not.toContain("nohup /tmp/rakazo/browser-launch");
      expect(command).not.toContain("browser CDP not ready");
      expect(command).not.toContain("browser_running && (echo >/dev/tcp");
    });

    it("launchBrowserCommand is explicit and handles CDP readiness polling", () => {
      const command = launchBrowserCommand(0, "bot-alpha");

      // Explicit launch command must start the launcher and poll CDP debug port
      expect(command).toContain("nohup /tmp/rakazo/browser-launch-1");
      expect(command).toContain("browser_running && (echo >/dev/tcp/127.0.0.1/9222)");
      expect(command).toContain("computer browser CDP not ready on 9222");
    });

    it("stopBrowserCommand touches /tmp/rakazo/browser-closed marker upon stopping browser", () => {
      const command = stopBrowserCommand("bot-alpha");
      expect(command).toContain("/tmp/rakazo/browser-closed-");
    });
  });

  describe("2. Window inventory tri-state & close evidence verification", () => {
    const targetWid = "0x01a00003";
    beforeEach(() => {
      vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-14T03:00:02Z"));
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("unreadable / unknown window inventory never concludes window is closed", () => {
      // When inventory status is unknown (e.g. wmctrl failed/timeout), isWindowClosed must return false
      const obsUnknown: Partial<ExtendedComputerObservation> = {
        windowInventoryStatus: "unknown",
        windows: [],
      };
      expect(isWindowClosed(targetWid, obsUnknown as ExtendedComputerObservation)).toBe(false);

      // Undefined windows also returns false
      expect(isWindowClosed(targetWid, undefined)).toBe(false);
      expect(isWindowClosed(targetWid, { windows: undefined })).toBe(false);
    });

    it("validempty and validnonempty correctly detect closed target window", () => {
      const obsEmpty: Partial<ExtendedComputerObservation> = {
        windowInventoryStatus: "validempty",
        windows: [],
      };
      expect(isWindowClosed(targetWid, obsEmpty as ExtendedComputerObservation)).toBe(true);

      const obsOtherWindow: Partial<ExtendedComputerObservation> = {
        windowInventoryStatus: "validnonempty",
        windows: [{ id: "0x09999999", title: "Terminal", wmClass: "XTerm" }],
      };
      expect(isWindowClosed(targetWid, obsOtherWindow as ExtendedComputerObservation)).toBe(true);

      const obsWithTarget: Partial<ExtendedComputerObservation> = {
        windowInventoryStatus: "validnonempty",
        windows: [{ id: targetWid, title: "Chromium", wmClass: "Chromium" }],
      };
      expect(isWindowClosed(targetWid, obsWithTarget as ExtendedComputerObservation)).toBe(false);
    });

    it("verifyWindowCloseEvidence validates focusproof and target window absence", () => {
      const beforeObs: ExtendedComputerObservation = {
        frameId: "frame-1",
        capturedAt: "2026-10-14T03:00:00Z",
        windowInventoryFreshness: "2026-10-14T03:00:00Z",
        screenIdentity: {
          computerId: "computer-test",
          display: ":1",
          generation: 1,
          profileFingerprint: "profile-test",
        },
        width: 1280,
        height: 800,
        mimeType: "image/png",
        image: new Uint8Array([0]),
        activeWindow: { id: targetWid, title: "Google - Chromium" },
        windowInventoryStatus: "validnonempty",
        windows: [{ id: targetWid, title: "Google - Chromium", isCurrentProfile: true }],
      };

      const afterObs: ExtendedComputerObservation = {
        frameId: "frame-2",
        capturedAt: "2026-10-14T03:00:01Z",
        windowInventoryFreshness: "2026-10-14T03:00:01Z",
        screenIdentity: {
          computerId: "computer-test",
          display: ":1",
          generation: 1,
          profileFingerprint: "profile-test",
        },
        width: 1280,
        height: 800,
        mimeType: "image/png",
        image: new Uint8Array([0]),
        windowInventoryStatus: "validempty",
        windows: [],
      };

      const result = verifyWindowCloseEvidence({
        targetWindowId: targetWid,
        beforeObservation: beforeObs,
        afterObservation: afterObs,
        activeWindowBefore: { id: targetWid, title: "Google - Chromium" },
        requireFocusProof: true,
      });

      expect(result.verified).toBe(true);
      expect(result.focusProofSatisfied).toBe(true);
      expect(result.preservedOtherWindows).toBe(true);
      expect(result.closedWindowId).toBe(targetWid);
    });

    it("verifyWindowCloseEvidence rejects when inventory is unknown", () => {
      const afterObsUnknown: ExtendedComputerObservation = {
        frameId: "frame-2",
        capturedAt: "2026-10-14T03:00:01Z",
        width: 1280,
        height: 800,
        mimeType: "image/png",
        image: new Uint8Array([0]),
        windowInventoryStatus: "unknown",
        windows: [],
      };

      const result = verifyWindowCloseEvidence({
        targetWindowId: targetWid,
        afterObservation: afterObsUnknown,
      });

      expect(result.verified).toBe(false);
      expect(result.reason).toContain("Window inventory status is unknown");
    });

    it("verifyWindowCloseEvidence protects windows of other bots on team computer", () => {
      const otherBotWindow: WindowInventoryEntry = {
        id: "0x02b00004",
        title: "Bot Beta - Chromium",
        isCurrentProfile: false,
      };

      const beforeObs: ExtendedComputerObservation = {
        frameId: "frame-1",
        capturedAt: "2026-10-14T03:00:00Z",
        windowInventoryFreshness: "2026-10-14T03:00:00Z",
        screenIdentity: {
          computerId: "computer-test",
          display: ":1",
          generation: 1,
          profileFingerprint: "profile-test",
        },
        width: 1280,
        height: 800,
        mimeType: "image/png",
        image: new Uint8Array([0]),
        activeWindow: { id: targetWid, title: "Bot Alpha - Chromium" },
        windowInventoryStatus: "validnonempty",
        windows: [
          { id: targetWid, title: "Bot Alpha - Chromium", isCurrentProfile: true },
          otherBotWindow,
        ],
      };

      // Scenario where someone accidentally killed all browsers instead of targeting targetWid
      const afterObsKilledAll: ExtendedComputerObservation = {
        frameId: "frame-2",
        capturedAt: "2026-10-14T03:00:01Z",
        windowInventoryFreshness: "2026-10-14T03:00:01Z",
        screenIdentity: {
          computerId: "computer-test",
          display: ":1",
          generation: 1,
          profileFingerprint: "profile-test",
        },
        width: 1280,
        height: 800,
        mimeType: "image/png",
        image: new Uint8Array([0]),
        windowInventoryStatus: "validempty",
        windows: [],
      };

      const result = verifyWindowCloseEvidence({
        targetWindowId: targetWid,
        beforeObservation: beforeObs,
        afterObservation: afterObsKilledAll,
        activeWindowBefore: { id: targetWid, title: "Bot Alpha - Chromium" },
      });

      expect(result.verified).toBe(false);
      expect(result.preservedOtherWindows).toBe(false);
      expect(result.reason).toContain(
        "Safety check failed: window 0x02b00004 belonging to another profile was closed",
      );
    });
  });

  describe("3. Screen identity, generation tracking & no viewToken leaks", () => {
    it("sanitizeScreenIdentity removes viewToken, token, controlToken while preserving identity metadata", () => {
      const rawIdentity: ScreenIdentityMetadata & Record<string, unknown> = {
        computerId: "comp-123",
        botId: "bot-alpha",
        screenId: "screen-1",
        display: ":1",
        generation: 2,
        profile: "/home/rakazo/.browser-profiles/chromium-bot-abc",
        profileFingerprint: "e3b0c44298fc1c14",
        browserClosed: true,
        viewToken: "super_secret_view_token",
        controlToken: "super_secret_control_token",
        token: "token_123",
      };

      const sanitized = sanitizeScreenIdentity(rawIdentity);
      expect(sanitized).toBeDefined();
      expect(sanitized?.display).toBe(":1");
      expect(sanitized?.generation).toBe(2);
      expect(sanitized?.profileFingerprint).toBe("e3b0c44298fc1c14");
      expect(sanitized?.browserClosed).toBe(true);

      // Must NOT leak tokens
      expect((sanitized as Record<string, unknown>).viewToken).toBeUndefined();
      expect((sanitized as Record<string, unknown>).controlToken).toBeUndefined();
      expect((sanitized as Record<string, unknown>).token).toBeUndefined();
    });

    it("observationToolResult omits viewToken and includes inventory freshness and status", () => {
      const obs: ExtendedComputerObservation = {
        frameId: "frame-1-100",
        capturedAt: "2026-10-14T03:30:00Z",
        width: 1280,
        height: 800,
        mimeType: "image/png",
        image: new Uint8Array([1, 2, 3]),
        display: ":1",
        screenIdentity: {
          display: ":1",
          generation: 1,
          profileFingerprint: "abc1234567890123",
          browserClosed: false,
          ...({ viewToken: "LEAKED_TOKEN" } as Record<string, unknown>),
        },
        windowInventoryStatus: "validnonempty",
        windowInventoryFreshness: "2026-10-14T03:30:00Z",
        windows: [{ id: "0x123", title: "Test Window" }],
      };

      const result = observationToolResult(obs);
      const details = result.details as Record<string, unknown>;
      expect(details.frameId).toBe("frame-1-100");
      expect(details.windowInventoryStatus).toBe("validnonempty");
      expect(details.windowInventoryFreshness).toBe("2026-10-14T03:30:00Z");

      const identity = details.screenIdentity as Record<string, unknown>;
      expect(identity.viewToken).toBeUndefined();

      // Check text content as well
      const firstPart = result.content[0];
      const text = firstPart && firstPart.type === "text" ? firstPart.text : "";
      expect(text).not.toContain("LEAKED_TOKEN");
    });

    it("isSameScreenGeneration and sanitizeWebScreenIdentity preserve frontend screen matching", () => {
      const a = { display: ":1", generation: 1, computerId: "comp-1" };
      const b = { display: ":1", generation: 1, computerId: "comp-1" };
      const stale = { display: ":1", generation: 2, computerId: "comp-1" };

      expect(isSameScreenGeneration(a, b)).toBe(true);
      expect(isSameScreenGeneration(a, stale)).toBe(false);

      const webClean = sanitizeWebScreenIdentity({
        ...a,
        ...({ viewToken: "secret" } as Record<string, unknown>),
      });
      expect(webClean).toBeDefined();
      expect((webClean as Record<string, unknown>).viewToken).toBeUndefined();
    });
  });

  describe("4. Normalized pointer click and action shape recognition", () => {
    it("parseComputerActions normalizes click into pointer shape", () => {
      const parsed = parseComputerActions([{ kind: "click", x: 640, y: 400, button: "left" }]);

      expect(parsed).toHaveLength(1);
      const action = parsed[0]!;
      expect(action.kind).toBe("pointer");
      if (action.kind === "pointer") {
        expect(action.type).toBe("click");
        expect(action.x).toBe(640);
        expect(action.y).toBe(400);
      }
    });

    it("isPointerClickAction recognizes both normalized { kind: 'pointer', type: 'click' } and legacy { kind: 'click' }", () => {
      const normalizedAction: ComputerAction = {
        kind: "pointer",
        type: "click",
        button: "left",
        x: 640,
        y: 400,
      };
      const legacyAction = { kind: "click", x: 640, y: 400 } as unknown as ComputerAction;
      const moveAction: ComputerAction = {
        kind: "pointer",
        type: "move",
        x: 640,
        y: 400,
      };

      expect(isPointerClickAction(normalizedAction)).toBe(true);
      expect(isPointerClickAction(legacyAction)).toBe(true);
      expect(isPointerClickAction(moveAction)).toBe(false);
    });

    it("isKeyboardSubmitAction recognizes Enter and Return", () => {
      expect(isKeyboardSubmitAction({ kind: "key", key: "Enter" })).toBe(true);
      expect(isKeyboardSubmitAction({ kind: "key", key: "Return" })).toBe(true);
      expect(isKeyboardSubmitAction({ kind: "key", key: "Tab" })).toBe(false);
    });

    it("isWindowCloseAction recognizes Alt+F4, Ctrl+W, Ctrl+Q", () => {
      expect(isWindowCloseAction({ kind: "key", key: "F4", modifiers: ["Alt"] })).toBe(true);
      expect(isWindowCloseAction({ kind: "key", key: "w", modifiers: ["Control"] })).toBe(true);
      expect(isWindowCloseAction({ kind: "key", key: "q", modifiers: ["Ctrl"] })).toBe(true);
      expect(isWindowCloseAction({ kind: "key", key: "a", modifiers: ["Ctrl"] })).toBe(false);
    });
  });
});
