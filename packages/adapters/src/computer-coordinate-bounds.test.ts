import { describe, expect, it } from "vitest";
import {
  assertComputerCoordinates,
  findWindowByClass,
  isWindowClosed,
  observationToolResult,
  parseComputerActions,
  sanitizeWindowInfo,
  sanitizeWindowTitle,
  transformCoordinatesWithMetadata,
} from "./computer-tools.js";

describe("desktop coordinate dispatch boundary", () => {
  it.each([1385, 1915, 1280])("rejects actual Chief incident x=%s before input", (x) => {
    const actions = parseComputerActions([
      { kind: "focus", application: "chromium" },
      { kind: "click", x, y: 11 },
    ]);
    expect(() => assertComputerCoordinates(actions, { width: 1280, height: 800 })).toThrow(
      /outside.*No input was dispatched/,
    );
  });

  it("uses both dimensions of the current screen without rescaling", () => {
    const edge = parseComputerActions([{ kind: "click", x: 1279, y: 799 }]);
    expect(() => assertComputerCoordinates(edge, { width: 1280, height: 800 })).not.toThrow();
    expect(() => assertComputerCoordinates(edge, { width: 1024, height: 768 })).toThrow(/outside/);
    const outsideY = parseComputerActions([{ kind: "click", x: 0, y: 800 }]);
    expect(() => assertComputerCoordinates(outsideY, { width: 1280, height: 800 })).toThrow(/outside/);
  });

  it("rejects invalid step in the tail of a batch before any dispatch", () => {
    const batch = parseComputerActions([
      { kind: "focus", application: "chromium" },
      { kind: "move", x: 100, y: 100 },
      { kind: "click", x: 1915, y: 11 },
    ]);
    expect(() => assertComputerCoordinates(batch, { width: 1280, height: 800 })).toThrow(
      /Coordinate \(1915, 11\) is outside.*No input was dispatched/,
    );
  });

  it("does not accept missing geometry as proof that coordinates are safe", () => {
    const actions = parseComputerActions([{ kind: "click", x: 10, y: 10 }]);
    expect(() => assertComputerCoordinates(actions, { width: 0, height: 800 })).toThrow(
      /valid screen/,
    );
    expect(() => assertComputerCoordinates(actions, { width: -100, height: 800 })).toThrow(
      /valid screen/,
    );
  });

  it("rejects negative or malformed coordinates at parse time", () => {
    expect(() => parseComputerActions([{ kind: "click", x: -10, y: 20 }])).toThrow(
      /non-negative coordinate/,
    );
    expect(() => parseComputerActions([{ kind: "click", x: NaN, y: 20 }])).toThrow(
      /non-negative coordinate/,
    );
  });
});

describe("coordinate metadata transformation and no silent clamping", () => {
  it("transforms normalized coordinates explicitly when metadata is provided", () => {
    const actions = parseComputerActions([{ kind: "click", x: 0.5, y: 0.25 }]);
    const transformed = transformCoordinatesWithMetadata(actions, {
      normalized: true,
      targetDimensions: { width: 1280, height: 800 },
    });
    expect(transformed[0]).toMatchObject({ x: 640, y: 200 });
  });

  it("rescales model-resized coordinates when source and target dimensions are provided", () => {
    const actions = parseComputerActions([{ kind: "click", x: 960, y: 540 }]);
    const transformed = transformCoordinatesWithMetadata(actions, {
      sourceDimensions: { width: 1920, height: 1080 },
      targetDimensions: { width: 1280, height: 720 },
    });
    expect(transformed[0]).toMatchObject({ x: 640, y: 360 });
  });

  it("does not guess dimensions and does not double-transform", () => {
    const actions = parseComputerActions([{ kind: "click", x: 500, y: 300 }]);
    const once = transformCoordinatesWithMetadata(actions, {
      sourceDimensions: { width: 1000, height: 600 },
      targetDimensions: { width: 2000, height: 1200 },
    });
    expect(once[0]).toMatchObject({ x: 1000, y: 600 });

    // Second transform with same or other options must not re-multiply
    const twice = transformCoordinatesWithMetadata(once, {
      sourceDimensions: { width: 1000, height: 600 },
      targetDimensions: { width: 2000, height: 1200 },
    });
    expect(twice[0]).toMatchObject({ x: 1000, y: 600 });
  });

  it("does not silently clamp out-of-bounds coordinates", () => {
    const actions = parseComputerActions([{ kind: "click", x: 1500, y: 300 }]);
    // If metadata transforms x to 3000 on a 1280x800 screen, it must not clamp to 1279; assertComputerCoordinates must reject it
    const transformed = transformCoordinatesWithMetadata(actions, {
      sourceDimensions: { width: 1000, height: 600 },
      targetDimensions: { width: 2000, height: 1200 },
    });
    expect(transformed[0]).toMatchObject({ x: 3000, y: 600 });
    expect(() =>
      assertComputerCoordinates(transformed, { width: 1280, height: 800 }),
    ).toThrow(/outside.*desktop/);
  });
});

describe("window closing verification and sanitized metadata", () => {
  it("does not consider a window closed simply because activeWindow is undefined", () => {
    const observation = {
      windows: [
        { id: "0x00600003", pid: 886, wmClass: "chromium.Chromium", title: "MDCU Lecture - Chromium" },
      ],
      activeWindow: undefined,
    };
    // Window is still in inventory => NOT closed!
    expect(isWindowClosed("0x00600003", observation)).toBe(false);
  });

  it("verifies a window is closed when target id is absent from inventory", () => {
    const observation = {
      windows: [
        { id: "0x01800001", pid: 999, wmClass: "xterm.XTerm", title: "Terminal" },
      ],
      activeWindow: undefined,
    };
    expect(isWindowClosed("0x00600003", observation)).toBe(true);
  });

  it("finds a window by wmClass", () => {
    const windows = [
      { id: "0x00600003", wmClass: "chromium.Chromium" },
      { id: "0x01000001", wmClass: "xterm.XTerm" },
    ];
    expect(findWindowByClass(windows, "chromium")?.id).toBe("0x00600003");
    expect(findWindowByClass(windows, "firefox")).toBeUndefined();
  });

  it("sanitizes window title by redacting URL query parameters and secrets", () => {
    const raw =
      "MDCU Lecture - https://flick.docchula.com/api/watch?token=SECRET_TOKEN_123&auth=SUPER_SECRET - Chromium";
    const sanitized = sanitizeWindowTitle(raw);
    expect(sanitized).not.toContain("SECRET_TOKEN_123");
    expect(sanitized).not.toContain("SUPER_SECRET");
    expect(sanitized).toContain("https://flick.docchula.com/api/watch");
    expect(sanitized).toContain("MDCU Lecture");
  });

  it("includes extended metadata and window inventory in observationToolResult details without whole raw image", () => {
    const sampleObservation = {
      frameId: "test-frame-123",
      capturedAt: "2026-10-13T12:00:00.000Z",
      mimeType: "image/png" as const,
      image: new Uint8Array([1, 2, 3]),
      width: 1280,
      height: 800,
      display: ":1",
      screenIdentity: { display: ":1", generation: 2, profile: "/profiles/chromium" },
      windows: [
        {
          id: "0x00600003",
          wmClass: "chromium.Chromium",
          title: "MDCU Lecture?token=abc - Chromium",
        },
      ],
      activeWindow: { id: "0x00600003", title: "MDCU Lecture?token=abc - Chromium" },
      cursor: { x: 100, y: 100 },
    };
    const result = observationToolResult(sampleObservation);
    expect(result.details).toMatchObject({
      frameId: "test-frame-123",
      width: 1280,
      height: 800,
      display: ":1",
      screenIdentity: { display: ":1", generation: 2 },
      originalDimensions: { width: 1280, height: 800 },
      displayedDimensions: { width: 1280, height: 800 },
      windows: [
        { id: "0x00600003", wmClass: "chromium.Chromium", title: "MDCU Lecture - Chromium" },
      ],
      activeWindow: { id: "0x00600003", title: "MDCU Lecture - Chromium" },
    });
    // Ensure raw image bytes are not in details:
    expect((result.details as Record<string, unknown>).image).toBeUndefined();
  });
});
