import type { ComputerAction } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computerObservation } from "./computer-support.js";
import {
  assertComputerCoordinates,
  observationToolResult,
  parseComputerActions,
  sanitizeScreenIdentity,
  sanitizeWindowTitle,
  transformCoordinatesWithMetadata,
  verifyWindowCloseEvidence,
  requestedCloseTarget,
  desktopCloseActionRefusal,
} from "./computer-tools.js";
import type { ExtendedComputerObservation, ScreenIdentityMetadata } from "./computer-tools.js";

const identity = {
  computerId: "computer-test",
  botId: "bot-test",
  screenId: "screen-test",
  display: ":1",
  generation: 2,
  profileFingerprint: "profile-test",
};
function observation(after = false): ExtendedComputerObservation {
  return {
    frameId: after ? "frame-after" : "frame-before",
    capturedAt: after ? "2026-10-16T10:00:01Z" : "2026-10-16T10:00:00Z",
    windowInventoryFreshness: after ? "2026-10-16T10:00:01Z" : "2026-10-16T10:00:00Z",
    mimeType: "image/png",
    image: new Uint8Array([0]),
    width: 1280,
    height: 800,
    screenIdentity: { ...identity },
    windowInventoryStatus: after ? "validempty" : "validnonempty",
    windows: after ? [] : [{ id: "target", isCurrentProfile: true }],
    ...(after ? {} : { activeWindow: { id: "target", title: "Browser" } }),
  };
}

describe("production computer evidence boundaries", () => {
  it("verifies an explicitly named independent program while preserving the bot browser", () => {
    const before = observation();
    const after = observation(true);
    const target = {
      id: "target",
      pid: 123,
      wmClass: "FixtureApp",
      title: "Independent Test Window",
      isCurrentProfile: false,
    };
    const bot = {
      id: "bot-browser",
      pid: 456,
      wmClass: "Chromium",
      title: "Bot Browser",
      isCurrentProfile: true,
    };
    before.windows = [target, bot];
    before.activeWindow = target;
    after.windows = [bot];
    after.windowInventoryStatus = "validnonempty";
    expect(requestedCloseTarget("Close Independent Test Window", before)).toEqual(target);
    expect(requestedCloseTarget("Close Missing Window", before)).toBeUndefined();
    expect(
      verifyWindowCloseEvidence({
        targetWindowId: target.id,
        beforeObservation: before,
        afterObservation: after,
        requireFocusProof: true,
      }).verified,
    ).toBe(false);
    expect(
      verifyWindowCloseEvidence({
        targetWindowId: target.id,
        authorizedExternalTargetId: target.id,
        beforeObservation: before,
        afterObservation: after,
        requireFocusProof: true,
        actionScope: "window",
        nowMs: Date.parse("2026-10-16T10:00:02Z"),
      }),
    ).toMatchObject({ verified: true, preservedOtherWindows: true });
    after.windows = [];
    after.windowInventoryStatus = "validempty";
    expect(
      verifyWindowCloseEvidence({
        targetWindowId: target.id,
        authorizedExternalTargetId: target.id,
        beforeObservation: before,
        afterObservation: after,
        requireFocusProof: true,
      }).verified,
    ).toBe(false);
  });
  it("refuses typed process commands while allowing visual close/focus actions", () => {
    expect(
      desktopCloseActionRefusal(parseComputerActions([{ kind: "type", text: "kill 123" }])),
    ).toBeTruthy();
    expect(
      desktopCloseActionRefusal(parseComputerActions([{ kind: "key", key: "k" }])),
    ).toBeTruthy();
    expect(
      desktopCloseActionRefusal(parseComputerActions([{ kind: "key", key: "Alt+F4" }])),
    ).toBeUndefined();
    expect(desktopCloseActionRefusal([{ kind: "open", path: "terminal" }])).toBeTruthy();
    expect(desktopCloseActionRefusal([{ kind: "launch", application: "terminal" }])).toBeTruthy();
  });
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-16T10:00:02Z"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it.each([NaN, Infinity, -Infinity, 0, -1, 0.5])(
    "rejects invalid geometry %s before dispatch",
    (width) => {
      expect(() =>
        assertComputerCoordinates([{ kind: "pointer", type: "click", x: 1, y: 1 }], {
          width,
          height: 800,
        }),
      ).toThrow(/valid screen geometry/);
    },
  );
  it.each([null, true, "", "12", {}, undefined])("rejects malformed pointer x=%j", (x) => {
    expect(() => parseComputerActions([{ kind: "click", x, y: 1 }])).toThrow(/coordinate/);
  });
  it("rejects a missing pointer coordinate even in the tail of a batch", () => {
    const actions = [
      { kind: "focus", application: "chromium" },
      { kind: "pointer", type: "click", x: 1 },
    ] as unknown as ComputerAction[];
    expect(() => assertComputerCoordinates(actions, { width: 1280, height: 800 })).toThrow();
  });
  it("uses a typed allowlist for identity and model-visible window metadata", () => {
    const fakeSecret = "synthetic-secret-do-not-emit";
    const raw = {
      ...identity,
      browserClosed: false,
      apiKey: fakeSecret,
      extra: { token: fakeSecret },
      generation: { token: fakeSecret },
    };
    expect(sanitizeScreenIdentity(raw)).not.toHaveProperty("apiKey");
    expect(sanitizeScreenIdentity(raw)).not.toHaveProperty("extra");
    expect(sanitizeScreenIdentity(raw)).not.toHaveProperty("generation");
    const obs = observation();
    obs.screenIdentity = raw as unknown as ScreenIdentityMetadata;
    obs.windows = [{ id: "target", title: "Browser", apiKey: fakeSecret }];
    obs.activeWindow = { id: "target", title: "Browser", token: fakeSecret };
    const result = observationToolResult(obs);
    expect(JSON.stringify(result)).not.toContain(fakeSecret);
    expect((result.details as Record<string, unknown>).screenIdentity).toMatchObject({
      computerId: "computer-test",
      browserClosed: false,
    });
  });
  it("requires the target to have existed in the before inventory", () => {
    const before = observation();
    before.windows = [];
    expect(
      verifyWindowCloseEvidence({
        targetWindowId: "target",
        beforeObservation: before,
        afterObservation: observation(true),
      }).verified,
    ).toBe(false);
  });
  it("rejects wrong focus when proof is required", () => {
    expect(
      verifyWindowCloseEvidence({
        targetWindowId: "target",
        beforeObservation: observation(),
        afterObservation: observation(true),
        requireFocusProof: true,
        activeWindowBefore: { id: "other", title: "Other" },
      }),
    ).toMatchObject({ verified: false, focusProofSatisfied: false });
  });
  it.each(["generation", "display", "profileFingerprint", "computerId", "botId", "screenId"])(
    "rejects mismatched %s",
    (field) => {
      const after = observation(true);
      after.screenIdentity = {
        ...after.screenIdentity,
        [field]: field === "generation" ? 3 : "other",
      };
      expect(
        verifyWindowCloseEvidence({
          targetWindowId: "target",
          beforeObservation: observation(),
          afterObservation: after,
        }).verified,
      ).toBe(false);
    },
  );
  it("rejects stale inventory and unchanged observations", () => {
    const after = observation(true);
    after.windowInventoryFreshness = "2026-10-15T10:00:00Z";
    expect(
      verifyWindowCloseEvidence({
        targetWindowId: "target",
        beforeObservation: observation(),
        afterObservation: after,
      }).verified,
    ).toBe(false);
    const same = observation(true);
    same.frameId = "frame-before";
    same.capturedAt = "2026-10-16T10:00:00Z";
    expect(
      verifyWindowCloseEvidence({
        targetWindowId: "target",
        beforeObservation: observation(),
        afterObservation: same,
      }).verified,
    ).toBe(false);
  });
  it("does not claim focus proof when none was observed", () => {
    const before = observation();
    before.activeWindow = undefined;
    expect(
      verifyWindowCloseEvidence({
        targetWindowId: "target",
        beforeObservation: before,
        afterObservation: observation(true),
      }),
    ).toMatchObject({ verified: true, focusProofSatisfied: false });
  });
  it.each(["runId", "leaseId", "fence"])("rejects a missing or changed %s", (field) => {
    const before = observation();
    before.screenIdentity = { ...before.screenIdentity, [field]: "one" };
    expect(
      verifyWindowCloseEvidence({
        targetWindowId: "target",
        beforeObservation: before,
        afterObservation: observation(true),
      }).verified,
    ).toBe(false);
  });
  it("rejects missing identity, missing inventory timestamps, and expired proof", () => {
    const after = observation(true);
    after.screenIdentity = undefined;
    expect(
      verifyWindowCloseEvidence({
        targetWindowId: "target",
        beforeObservation: observation(),
        afterObservation: after,
      }).verified,
    ).toBe(false);
    const missing = observation(true);
    missing.windowInventoryFreshness = undefined;
    expect(
      verifyWindowCloseEvidence({
        targetWindowId: "target",
        beforeObservation: observation(),
        afterObservation: missing,
      }).verified,
    ).toBe(false);
    expect(
      verifyWindowCloseEvidence({
        targetWindowId: "target",
        beforeObservation: observation(),
        afterObservation: observation(true),
        nowMs: Date.parse("2026-10-16T10:01:00Z"),
      }).verified,
    ).toBe(false);
  });
  it("rejects inconsistent and duplicated inventories", () => {
    const before = observation();
    before.windows?.push({ id: "target" });
    expect(
      verifyWindowCloseEvidence({
        targetWindowId: "target",
        beforeObservation: before,
        afterObservation: observation(true),
      }).verified,
    ).toBe(false);
    const after = observation(true);
    after.windowInventoryStatus = "validnonempty";
    expect(
      verifyWindowCloseEvidence({
        targetWindowId: "target",
        beforeObservation: observation(),
        afterObservation: after,
      }).verified,
    ).toBe(false);
  });
  it("accepts an observed target disappearing while another window survives", () => {
    const before = observation();
    before.windows?.push({ id: "other", isCurrentProfile: false });
    const after = observation(true);
    after.windows = [{ id: "other", isCurrentProfile: false }];
    after.windowInventoryStatus = "validnonempty";
    expect(
      verifyWindowCloseEvidence({
        targetWindowId: "target",
        beforeObservation: before,
        afterObservation: after,
        requireFocusProof: true,
      }),
    ).toMatchObject({ verified: true, focusProofSatisfied: true, preservedOtherWindows: true });
  });

  it("wires producer window inventory and screenIdentity through DockerSandboxProvider to verifyWindowCloseEvidence", async () => {
    const { DockerSandboxProvider } = await import("./docker-sandbox.js");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/observe")) {
        return new Response(
          JSON.stringify({
            image: Buffer.from([1, 2, 3, 4]).toString("base64"),
            mimeType: "image/png",
            width: 1280,
            height: 800,
            display: ":1",
            capturedAt: "2026-10-16T10:00:00.500Z",
            windowInventoryStatus: "validnonempty",
            windowInventoryFreshness: "2026-10-16T10:00:00.400Z",
            windows: [
              {
                id: "0x01400003",
                wmClass: "chromium.Chromium",
                title: "Target Browser",
                pid: 4100,
                isCurrentProfile: true,
              },
              {
                id: "0x02000009",
                wmClass: "chromium.Chromium",
                title: "Other Bot Browser",
                pid: 4200,
                isCurrentProfile: false,
              },
            ],
            activeWindow: {
              id: "0x01400003",
              title: "Target Browser",
              wmClass: "chromium.Chromium",
              pid: 4100,
              isCurrentProfile: true,
            },
            screenIdentity: {
              computerId: "computer-test",
              botId: "bot-test",
              screenId: "bot-test",
              display: ":1",
              generation: 1,
              profile: "/home/rakazo/.browser-profiles/chromium-bot-test",
              profileFingerprint: "chromium-bot-test",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          completed: 1,
          observation: {
            image: Buffer.from([5, 6, 7, 8]).toString("base64"),
            mimeType: "image/png",
            width: 1280,
            height: 800,
            display: ":1",
            capturedAt: "2026-10-16T10:00:01.200Z",
            windowInventoryStatus: "validnonempty",
            windowInventoryFreshness: "2026-10-16T10:00:01.100Z",
            windows: [
              {
                id: "0x02000009",
                wmClass: "chromium.Chromium",
                title: "Other Bot Browser",
                pid: 4200,
                isCurrentProfile: false,
              },
            ],
            activeWindow: {
              id: "0x02000009",
              title: "Other Bot Browser",
              wmClass: "chromium.Chromium",
              pid: 4200,
              isCurrentProfile: false,
            },
            screenIdentity: {
              computerId: "computer-test",
              botId: "bot-test",
              screenId: "bot-test",
              display: ":1",
              generation: 1,
              profile: "/home/rakazo/.browser-profiles/chromium-bot-test",
              profileFingerprint: "chromium-bot-test",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    try {
      const provider = new DockerSandboxProvider("http://supervisor.test", "secret-token");
      const computer = {
        id: "computer-test",
        botId: "bot-test",
        kind: "docker" as const,
        providerRef: "computer-test",
      };
      const context = {
        operationId: "op-1",
        traceId: "trace-1",
        spaceId: "space-1",
        userId: "user-1",
        botId: "bot-test",
        runId: "run-1",
        screenLeaseId: "run-1:4",
        signal: new AbortController().signal,
      };
      const beforeObs = await provider.observe(computer, context);
      const actResult = await provider.act(
        computer,
        { actions: [{ kind: "key", key: "F4", modifiers: ["Alt"] }], observe: true },
        context,
      );
      expect(beforeObs.screenIdentity).toMatchObject({
        computerId: "computer-test",
        botId: "bot-test",
        screenId: "bot-test",
        display: ":1",
        generation: 1,
        profileFingerprint: "chromium-bot-test",
        runId: "run-1",
        leaseId: "run-1:4",
        fence: 4,
      });
      const evidence = verifyWindowCloseEvidence({
        targetWindowId: "0x01400003",
        beforeObservation: beforeObs,
        afterObservation: actResult.observation,
        activeWindowBefore: {
          id: beforeObs.activeWindow!.id,
          title: beforeObs.activeWindow!.title ?? "",
        },
        requireFocusProof: true,
      });
      expect(evidence).toMatchObject({
        verified: true,
        focusProofSatisfied: true,
        preservedOtherWindows: true,
        closedWindowId: "0x01400003",
      });

      const changedLeaseObs = await provider.observe(computer, {
        ...context,
        screenLeaseId: "run-1:5",
      });
      expect(
        verifyWindowCloseEvidence({
          targetWindowId: "0x01400003",
          beforeObservation: changedLeaseObs,
          afterObservation: actResult.observation,
          requireFocusProof: true,
        }).verified,
      ).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("enforces target profile ownership, surviving window identity, and observed focus provenance", () => {
    const profileFalseBefore = observation();
    profileFalseBefore.windows = [{ id: "target", isCurrentProfile: false }];
    expect(
      verifyWindowCloseEvidence({
        targetWindowId: "target",
        beforeObservation: profileFalseBefore,
        afterObservation: observation(true),
      }).verified,
    ).toBe(false);

    const profileUndefinedBefore = observation();
    profileUndefinedBefore.windows = [{ id: "target" }];
    expect(
      verifyWindowCloseEvidence({
        targetWindowId: "target",
        beforeObservation: profileUndefinedBefore,
        afterObservation: observation(true),
      }).verified,
    ).toBe(false);

    const xidReuseBefore = observation();
    xidReuseBefore.windows = [
      { id: "target", isCurrentProfile: true, pid: 100, wmClass: "chromium.Chromium" },
      { id: "other", isCurrentProfile: false, pid: 200, wmClass: "chromium.Chromium" },
    ];
    const xidReuseAfter = observation(true);
    xidReuseAfter.windowInventoryStatus = "validnonempty";
    xidReuseAfter.windows = [
      { id: "other", isCurrentProfile: true, pid: 999, wmClass: "xterm.XTerm" },
    ];
    expect(
      verifyWindowCloseEvidence({
        targetWindowId: "target",
        beforeObservation: xidReuseBefore,
        afterObservation: xidReuseAfter,
      }).verified,
    ).toBe(false);

    const noObservedFocusBefore = observation();
    noObservedFocusBefore.activeWindow = undefined;
    expect(
      verifyWindowCloseEvidence({
        targetWindowId: "target",
        beforeObservation: noObservedFocusBefore,
        afterObservation: observation(true),
        activeWindowBefore: { id: "target", title: "Browser" },
        requireFocusProof: true,
      }),
    ).toMatchObject({ verified: false, focusProofSatisfied: false });
  });

  it("distinguishes independent captures with identical image bytes from replayed observations", () => {
    const png = new Uint8Array([1, 2, 3, 4]);
    const before = computerObservation(png, {
      mimeType: "image/png",
      width: 1280,
      height: 800,
      capturedAt: "2026-10-16T10:00:00Z",
      windowInventoryFreshness: "2026-10-16T10:00:00Z",
      screenIdentity: { ...identity },
      windowInventoryStatus: "validnonempty",
      windows: [{ id: "target", isCurrentProfile: true }],
      activeWindow: { id: "target", title: "Browser" },
    });
    const after = computerObservation(png, {
      mimeType: "image/png",
      width: 1280,
      height: 800,
      capturedAt: "2026-10-16T10:00:01Z",
      windowInventoryFreshness: "2026-10-16T10:00:01Z",
      screenIdentity: { ...identity },
      windowInventoryStatus: "validempty",
      windows: [],
    });
    expect(before.frameId).not.toBe(after.frameId);
    expect(
      verifyWindowCloseEvidence({
        targetWindowId: "target",
        beforeObservation: before,
        afterObservation: after,
        requireFocusProof: true,
      }).verified,
    ).toBe(true);
  });

  it("redacts URL query/hash tokens in window titles and validates coordinate transforms", () => {
    expect(
      sanitizeWindowTitle("Login https://example.test/callback?token=jwt.part.sig - Chromium"),
    ).toBe("Login https://example.test/callback - Chromium");
    expect(sanitizeWindowTitle("App ?code=a/b.c+d#state=xyz - Browser")).toBe("App  - Browser");
    expect(sanitizeWindowTitle("https://[invalid]/cb#access_token=secret")).toBe(
      "https://[invalid]/cb",
    );

    const normalized = transformCoordinatesWithMetadata(
      [{ kind: "pointer", type: "click", x: 1, y: 1, button: "left" }],
      { normalized: true, targetDimensions: { width: 1280, height: 800 } },
    );
    expect(normalized[0]).toMatchObject({ x: 1279, y: 799 });
    expect(() => assertComputerCoordinates(normalized, { width: 1280, height: 800 })).not.toThrow();

    expect(() =>
      assertComputerCoordinates([{ kind: "click" } as unknown as ComputerAction], {
        width: 1280,
        height: 800,
      }),
    ).toThrow(/outside/);

    expect(() =>
      transformCoordinatesWithMetadata(
        [{ kind: "pointer", type: "click", x: 10, y: 10, button: "left" }],
        {
          sourceDimensions: { width: 0, height: 800 },
          targetDimensions: { width: 1280, height: 800 },
        },
      ),
    ).toThrow(/Invalid source dimensions/);
  });
});
