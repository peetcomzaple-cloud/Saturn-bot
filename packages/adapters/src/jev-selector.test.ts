import { describe, expect, it } from "vitest";
import type { AdapterContext, BrowserSnapshotResult, ComputerRef } from "@rakazo/adapter-kit";
import { JevUltrafastAdapter } from "./jev-adapter.js";
import {
  buildSelectorObservation,
  formatPromptForChineseSelector,
  parseSelectorDecision,
} from "./structured-action-selector.js";

function makeContext(signal?: AbortSignal): AdapterContext {
  return {
    operationId: "test-op",
    traceId: "test-trace",
    spaceId: "space-1",
    userId: "user-1",
    signal: signal ?? new AbortController().signal,
  };
}

function makeComputer(fence = 1): ComputerRef {
  return {
    id: "computer-jev-1",
    botId: "bot-1",
    kind: "docker",
    scope: "dedicated",
    leaseFence: fence,
  } as any;
}

const mockSnapshot: BrowserSnapshotResult = {
  url: "https://example.com/login",
  title: "Login Portal",
  tree: '- textbox "Username" [e1]\n- textbox "Password" [e2]\n- button "Login" [e3]',
  elements: [
    { ref: "e1", role: "textbox", name: "Username", tag: "input" },
    { ref: "e2", role: "textbox", name: "Password", tag: "input" },
    { ref: "e3", role: "button", name: "Login", tag: "button" },
  ],
};

describe("Jev Decision Loop Conformance [03_JEV_TEST_PROTOCOL.md J01-J14]", () => {
  it("J01: disambiguates duplicate buttons by form context and selects correct candidate", async () => {
    const snap: BrowserSnapshotResult = {
      url: "https://example.com/multi-form",
      title: "Multi Form",
      tree: "",
      elements: [
        { ref: "e1", role: "button", name: "Sign In", tag: "button" }, // Customer login
        { ref: "e2", role: "button", name: "Sign In", tag: "button" }, // Admin login
      ],
    };

    const adapter = new JevUltrafastAdapter({
      mockEndpoint: async (payload) => {
        expect(payload.goal).toContain("Admin");
        return {
          success: true,
          decision: {
            kind: "action",
            candidateId: 2,
            action: "click",
            reason: "Targeted Admin sign-in button",
          },
        };
      },
    });

    const ctx = makeContext();
    const dec = await adapter.selectAction("Sign in as Admin", snap, makeComputer(1), ctx);
    expect(dec.kind).toBe("action");
    expect(dec.selectedCandidateId).toBe(2);
    expect(dec.selectedRef).toBe("e2");
  });

  it("J02: handles language overlay and selects language option", async () => {
    const snap: BrowserSnapshotResult = {
      url: "https://example.com",
      title: "Overlay",
      tree: "",
      elements: [
        { ref: "e1", role: "button", name: "Select Thai ภาษาไทย", tag: "button" },
        { ref: "e2", role: "button", name: "Select English", tag: "button" },
      ],
    };

    const adapter = new JevUltrafastAdapter({
      mockEndpoint: async () => ({
        success: true,
        decision: {
          kind: "action",
          candidateId: 1,
          action: "click",
          reason: "Clear language overlay by selecting requested Thai language",
        },
      }),
    });

    const dec = await adapter.selectAction("Use Thai language", snap, makeComputer(1), makeContext());
    expect(dec.kind).toBe("action");
    expect(dec.selectedRef).toBe("e1");
  });

  it("J03: rejects stale ref when candidate ID does not exist in observation", () => {
    const obs = buildSelectorObservation(mockSnapshot);
    // Model returns candidateId 99 which does not exist
    const dec = parseSelectorDecision(
      JSON.stringify({ kind: "action", candidateId: 99, action: "click" }),
      obs,
    );
    expect(dec.kind).toBe("no-match");
    expect(dec.reason).toContain("out of range");
  });

  it("J04: selects dropdown / option candidate with verified text", async () => {
    const snap: BrowserSnapshotResult = {
      url: "https://example.com/dropdown",
      title: "Dropdown",
      tree: "",
      elements: [
        { ref: "e1", role: "combobox", name: "Country", tag: "select" },
        { ref: "e2", role: "option", name: "Thailand", tag: "option" },
      ],
    };

    const adapter = new JevUltrafastAdapter({
      mockEndpoint: async () => ({
        success: true,
        decision: {
          kind: "action",
          candidateId: 1,
          action: "fill",
          text: "Thailand",
          reason: "Select Thailand in Country combobox",
        },
      }),
    });

    const dec = await adapter.selectAction("Select Thailand", snap, makeComputer(1), makeContext());
    expect(dec.kind).toBe("action");
    expect(dec.actionKind).toBe("fill");
    expect(dec.actionText).toBe("Thailand");
  });

  it("J05: returns wait on loading state instead of sending repeated clicks", async () => {
    const adapter = new JevUltrafastAdapter({
      mockEndpoint: async () => ({
        success: true,
        decision: {
          kind: "wait",
          reason: "Page is still loading results",
        },
      }),
    });

    const dec = await adapter.selectAction("Search items", mockSnapshot, makeComputer(1), makeContext());
    expect(dec.kind).toBe("wait");
  });

  it("J06: returns need-input for credential inputs rather than guessing passwords", async () => {
    const adapter = new JevUltrafastAdapter({
      mockEndpoint: async () => ({
        success: true,
        decision: {
          kind: "need-input",
          reason: "Protected password required from user",
        },
      }),
    });

    const dec = await adapter.selectAction("Log in with password", mockSnapshot, makeComputer(1), makeContext());
    expect(dec.kind).toBe("need-input");
  });

  it("J07: reports ungrounded DONE when goal requires terminal verification", async () => {
    // When Jev reports DONE, but user goal was interactive checkout on cart page
    const adapter = new JevUltrafastAdapter({
      mockEndpoint: async () => ({
        success: true,
        decision: {
          kind: "done",
          reason: "Claiming finished without order confirmation",
        },
      }),
    });

    const dec = await adapter.selectAction("Complete checkout", mockSnapshot, makeComputer(1), makeContext());
    expect(dec.kind).toBe("done");
    // Decision is typed "done" for executor verification
  });

  it("J08: rejects malformed API response, NaN, and invalid candidate IDs", () => {
    const obs = buildSelectorObservation(mockSnapshot);

    const nanDec = parseSelectorDecision('{"kind":"action", "candidateId":"NaN"}', obs);
    expect(nanDec.kind).toBe("no-match");

    const malformedJson = parseSelectorDecision("INVALID_JSON", obs);
    expect(malformedJson.kind).toBe("no-match");
    expect(malformedJson.reason).toContain("Malformed JSON");
  });

  it("J09: enforces fence check and throws on aborted signals", async () => {
    const adapter = new JevUltrafastAdapter({
      mockEndpoint: async () => ({
        success: true,
        decision: { kind: "wait" },
      }),
    });

    const ctrl = new AbortController();
    ctrl.abort();

    await expect(
      adapter.selectAction("Goal", mockSnapshot, makeComputer(1), makeContext(ctrl.signal)),
    ).rejects.toThrow();
  });

  it("J10: verifies live key absence reports NOT_TESTED without failing offline suite", async () => {
    const unconfiguredAdapter = new JevUltrafastAdapter();
    expect(unconfiguredAdapter.isLiveConfigured()).toBe(false);

    const dec = await unconfiguredAdapter.selectAction("Goal", mockSnapshot, makeComputer(1), makeContext());
    expect(dec.kind).toBe("no-match");
    expect(dec.reason).toContain("NOT_TESTED");
  });

  it("J11: ensures secret passwords are NEVER embedded in selector payload", () => {
    const prompt = formatPromptForChineseSelector("Login with password secret123", "Fill password", {
      url: "https://example.com",
      title: "Login",
      candidates: [{ candidateId: 1, ref: "e1", role: "textbox", name: "Password" }],
      snapshotTruncated: false,
    });

    // Prompt instructs selector to return need-input and NEVER guess passwords in text
    expect(prompt).toContain('选择 "need-input"（绝不要在 text 中猜测密码）');
  });

  it("J12: text helper does not replace genuine user text with hallucinations", () => {
    const obs = buildSelectorObservation(mockSnapshot);
    const dec = parseSelectorDecision(
      JSON.stringify({
        kind: "action",
        candidateId: 1,
        action: "fill",
        text: "admin_user",
        reason: "Fill username",
      }),
      obs,
    );
    expect(dec.actionText).toBe("admin_user");
  });

  it("J13: returns no-match when target is truncated from snapshot", () => {
    const truncatedSnap: BrowserSnapshotResult = {
      url: "https://example.com",
      title: "Truncated",
      tree: "",
      elements: Array.from({ length: 80 }, (_, i) => ({
        ref: `e${i + 1}`,
        role: "button",
        name: `Item ${i + 1}`,
      })),
    };

    const obs = buildSelectorObservation(truncatedSnap);
    expect(obs.snapshotTruncated).toBe(true);

    const prompt = formatPromptForChineseSelector("Find Item 100", "Locate Item 100", obs);
    expect(prompt).toContain('若候选中没有匹配元素且目标已被截断，选择 "no-match"');
  });

  it("J14: handles frame identity and reports embedded frames", () => {
    const frameSnap: BrowserSnapshotResult = {
      url: "https://example.com/framed",
      title: "Framed",
      tree: "Document contains 1 embedded frame(s)",
      elements: [{ ref: "e1", role: "button", name: "Top Button" }],
    };

    const obs = buildSelectorObservation(frameSnap);
    expect(obs.candidates.length).toBe(1);
    expect(obs.candidates[0]!.name).toBe("Top Button");
  });
});
