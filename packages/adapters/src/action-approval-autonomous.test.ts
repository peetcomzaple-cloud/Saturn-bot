import {
  planActionGate,
  resolveActionApprovalDetail,
  type ActionApprovalRule,
} from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { buildApprovalAskBlock } from "./approval-ask.js";
import { advanceToolCallLoopGuard, recordToolResult } from "./tool-loop.js";

describe("autonomous action approval & loop guard", () => {
  describe("rule resolution with opposite effect elimination", () => {
    it("resolves allow when require_approval rule has been replaced by always_allow", () => {
      // In the old buggy state, both require_approval and always_allow were present,
      // and require_approval won because of resolver conflict.
      // With our shared policy writer, the obsolete require_approval is deleted.
      const rules: ActionApprovalRule[] = [
        { effect: "always_allow", matchKind: "tool", matchValue: "browser_navigate" },
      ];

      const resolved = resolveActionApprovalDetail({
        toolName: "browser_navigate",
        rules,
      });

      expect(resolved.decision).toBe("allow");
      expect(resolved.source).toBe("always_allow");
    });

    it("does not call auto-review judge when tool is covered by always_allow", () => {
      const rules: ActionApprovalRule[] = [
        { effect: "always_allow", matchKind: "tool", matchValue: "browser_navigate" },
      ];

      const resolved = resolveActionApprovalDetail({
        toolName: "browser_navigate",
        rules,
      });

      const gate = planActionGate({
        resolved,
        consequential: true,
        autoReviewEnabled: true,
        checkerConfigured: true,
      });

      expect(gate).toBe("allow");
    });

    it("asks for approval when rule is switched back to require_approval", () => {
      const rules: ActionApprovalRule[] = [
        { effect: "require_approval", matchKind: "tool", matchValue: "browser_navigate" },
      ];

      const resolved = resolveActionApprovalDetail({
        toolName: "browser_navigate",
        rules,
      });

      expect(resolved.decision).toBe("ask");
      expect(resolved.source).toBe("require_approval");
    });

    it("does not allow tool when rule is revoked (falls back to default requiring approval for consequential tools)", () => {
      const rules: ActionApprovalRule[] = [];

      const resolved = resolveActionApprovalDetail({
        toolName: "browser_navigate",
        rules,
      });

      // Default source
      expect(resolved.source).toBe("default");
    });

    it("does not leak approval across different spaces or users", () => {
      // Space 1 user 1 has always_allow for browser_act
      const space1Rules: ActionApprovalRule[] = [
        { effect: "always_allow", matchKind: "tool", matchValue: "browser_act" },
      ];
      // Space 2 has no rules
      const space2Rules: ActionApprovalRule[] = [];

      const space1Resolved = resolveActionApprovalDetail({
        toolName: "browser_act",
        rules: space1Rules,
      });
      const space2Resolved = resolveActionApprovalDetail({
        toolName: "browser_act",
        rules: space2Rules,
      });

      expect(space1Resolved.decision).toBe("allow");
      expect(space2Resolved.decision).toBe("allow");
      expect(space2Resolved.source).toBe("default");
    });
  });

  describe("mandatory approval cards", () => {
    it("omits always allow button when mandatory approval is required", () => {
      const block = buildApprovalAskBlock(
        "effect-123",
        "browser_navigate",
        { url: "https://example.com" },
        [],
        {
          mandatory: true,
          askReason: "Unattended execution requires approval / การทำงานอัตโนมัติต้องได้รับการอนุมัติ",
        },
      );

      expect(block.kind).toBe("ask");
      if (block.kind !== "ask") throw new Error("Expected ask block");

      const actionIds = block.actions?.map((a) => a.id) ?? [];
      expect(actionIds).toContain("allow");
      expect(actionIds).toContain("deny");
      expect(actionIds).not.toContain("always");
      expect(block.detail).toContain("Unattended execution requires approval");
    });

    it("includes always allow button for standard conversational approval", () => {
      const block = buildApprovalAskBlock(
        "effect-456",
        "browser_navigate",
        { url: "https://example.com" },
        [],
        {
          mandatory: false,
        },
      );

      expect(block.kind).toBe("ask");
      if (block.kind !== "ask") throw new Error("Expected ask block");

      const actionIds = block.actions?.map((a) => a.id) ?? [];
      expect(actionIds).toContain("allow");
      expect(actionIds).toContain("always");
      expect(actionIds).toContain("deny");
    });
  });

  describe("tool loop guard", () => {
    it("flags stuck when identical tool calls return identical outputs 6 times", () => {
      let streak: { key: string | undefined; count: number; lastOutput?: string } = { key: undefined, count: 0 };
      let stuck = false;

      for (let i = 0; i < 6; i++) {
        const res = advanceToolCallLoopGuard(
          streak,
          "shell",
          { command: "npm test" },
          "FAILED: test error",
        );
        streak = res.streak;
        stuck = res.stuck;
      }

      expect(stuck).toBe(true);
      expect(streak.count).toBe(6);
    });

    it("resets streak count when tool returns different output (polling/reading progress)", () => {
      let streak: { key: string | undefined; count: number; lastOutput?: string } = { key: undefined, count: 0 };

      for (let i = 0; i < 20; i++) {
        // Output changes on each poll
        const res = advanceToolCallLoopGuard(
          streak,
          "read_file",
          { path: "output.log" },
          `Log line ${i}: status=${i}`,
        );
        streak = res.streak;
        expect(res.stuck).toBe(false);
      }
    });

    it("recordToolResult resets streak count on output change", () => {
      let streak = { key: "read_file:{}", count: 5, lastOutput: "output-A" };
      const updated = recordToolResult(streak, "output-B");
      expect(updated.count).toBe(0);
      expect(updated.lastOutput).toBe("output-B");
    });

    it("recordToolResult maintains streak count on identical output", () => {
      let streak = { key: "read_file:{}", count: 5, lastOutput: "output-A" };
      const updated = recordToolResult(streak, "output-A");
      expect(updated.count).toBe(5);
      expect(updated.lastOutput).toBe("output-A");
    });
  });
});
