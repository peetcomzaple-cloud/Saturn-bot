import { describe, expect, it } from "vitest";
import { parseObservation } from "./supervisor-logic.js";

describe("window inventory source freshness", () => {
  const inventoryOutput = (freshness = "2026-10-23T10:00:00Z", capturedAt = "2026-10-23T10:00:01Z", windows: unknown[] = []) =>
    `IMAGE YQ==\nINVENTORY_STATUS ${windows.length ? "validnonempty" : "validempty"}\nWINDOWS_JSON ${JSON.stringify(windows)}\n${freshness ? `INVENTORY_TS ${freshness}\n` : ""}${capturedAt ? `CAPTURED_AT ${capturedAt}\n` : ""}`;

  it.each([
    ["2026-10-23T09:59:55.999Z", "2026-10-23T10:00:01Z"],
    ["2026-10-23T10:00:01.001Z", "2026-10-23T10:00:01Z"],
    ["", "2026-10-23T10:00:01Z"],
    ["2026-10-23T10:00:00Z", ""],
    ["2026-10-23T10:00:00", "2026-10-23T10:00:01Z"],
    ["2026-10-23T10:00:00Z", "2026-10-23T10:00:01"],
    ["not-a-date", "2026-10-23T10:00:01Z"],
  ])("marks stale/future/missing/unzoned inventory unknown (%s -> %s)", (freshness, capturedAt) => {
    for (const windows of [[], [{ id: "0x1", pid: 123, isCurrentProfile: true }]]) {
      const result = parseObservation(inventoryOutput(freshness, capturedAt, windows));
      expect(result.windowInventoryStatus).toBe("unknown");
      expect(result.windows).toBeUndefined();
      expect(result.windowInventoryFreshness).toBe(freshness || undefined);
    }
  });

  it.each(["2026-10-23T10:00:01Z", "2026-10-23T09:59:56Z", "2026-10-23T17:00:00+07:00"])(
    "preserves truly empty and populated inventories inside the five-second source freshness bound (%s)",
    (freshness) => {
      for (const windows of [[], [{ id: "0x1", pid: 123, isCurrentProfile: true }]]) {
        const result = parseObservation(inventoryOutput(freshness, "2026-10-23T10:00:01Z", windows));
        expect(result.windowInventoryStatus).toBe(windows.length ? "validnonempty" : "validempty");
        expect(result.windows).toHaveLength(windows.length);
      }
    },
  );

});
