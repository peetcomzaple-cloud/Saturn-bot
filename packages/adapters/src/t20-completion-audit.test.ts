import { describe, expect, it } from "vitest";
import { toolCompletionAuditPayload } from "./executor.js";

describe("computer completion evidence audit", () => {
  it("persists active window identity and an existing lease digest without titles or lease values", () => {
    const payload = toolCompletionAuditPayload({ name: "computer_observe", executionId: "observe", durationMs: 1,
      result: { kind: "agent_tool_result", content: [], details: {
        screenLeaseDigest: "a".repeat(64),
        activeWindow: { id: "0x1", pid: 123, isCurrentProfile: true, title: "private title", token: "private token" },
      } },
    });
    expect(payload).toMatchObject({ screenLeaseDigest: "a".repeat(64),
      activeWindow: { id: "0x1", pid: 123, isCurrentProfile: true } });
    expect(JSON.stringify(payload)).not.toMatch(/private|title|token/);
  });

  it("persists computer refusal proof without titles, profile paths, tokens or arbitrary fields", () => {
    const payload = toolCompletionAuditPayload({
      name: "computer_act", executionId: "call-proof", durationMs: 1,
      result: { kind: "agent_tool_result", content: [], details: {
        windowInventoryStatus: "unknown", windowInventoryFreshness: "2026-10-23T00:00:00Z",
        screenIdentity: { computerId: "computer-1", generation: 4, profile: "/private/profile", controlToken: "secret-token" },
        windows: [{ id: "0x1", pid: 123, isCurrentProfile: true, title: "private title", token: "secret-token" }],
        windowCloseVerification: { verified: false, reason: "refused fake-secret", arbitrary: "private" },
      } },
    }, ["fake-secret"]);
    expect(payload).toMatchObject({ windowInventoryStatus: "unknown", windowInventoryCount: 1,
      windowInventoryTruncated: false, screenIdentity: { computerId: "computer-1", generation: 4 },
      windows: [{ id: "0x1", pid: 123, isCurrentProfile: true }],
      windowCloseVerification: { verified: false },
    });
    expect(JSON.stringify(payload)).not.toMatch(/private|secret-token|fake-secret|arbitrary/);
    expect((payload.screenIdentity as Record<string, unknown>).profileDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("bounds inventory and never turns missing or malformed proof into verified closure", () => {
    const result = { kind: "agent_tool_result", content: [], details: {
      windows: Array.from({ length: 257 }, (_, i) => ({ id: `0x${i + 1}` })),
      windowCloseVerification: { verified: "true" },
      windowInventoryStatus: "invalid",
    } };
    const payload = toolCompletionAuditPayload({ name: "computer_observe", executionId: "call", durationMs: 1, result });
    expect(payload.windowInventoryCount).toBe(257);
    expect(payload.windowInventoryTruncated).toBe(true);
    expect(payload.windows).toHaveLength(256);
    expect(payload).not.toHaveProperty("windowCloseVerification");
    expect(payload).not.toHaveProperty("windowInventoryStatus");
    expect(toolCompletionAuditPayload({ name: "other_tool", executionId: "call", durationMs: 1, result })).not.toHaveProperty("windows");
  });

});
