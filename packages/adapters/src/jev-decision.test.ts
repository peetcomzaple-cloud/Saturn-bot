import { describe, expect, it, vi } from "vitest";
import {
  createJevDecisionAdapter,
  JEV_OPENROUTER_MODEL,
  MODEL_ERROR_QUESTION,
  CLOSE_NEGATION_QUESTION,
} from "./jev-decision.js";
import { createJevNegationClassifier } from "./model-error-classifier.js";

const answer = (choice = "prohibited", confidence = 0.99, model = JEV_OPENROUTER_MODEL) =>
  new Response(
    JSON.stringify({
      model,
      answers: {
        category: {
          type: "choice",
          choice,
          confidence,
          probabilities: { prohibited: 0.99, affirmative: 0.01, uncertain: 0 },
        },
      },
      usage: { input_tokens: 400, output_tokens: 46, cost: 0.0000168 },
    }),
  );

describe("pinned optional Jev Decisions adapter", () => {
  it("uses the existing credential loader only after opt-in and never a chat endpoint", async () => {
    const loadApiKey = vi.fn().mockResolvedValue("fake-private-key");
    const fetch = vi.fn().mockResolvedValue(answer());
    expect(
      createJevDecisionAdapter({ enabled: false, transport: "openrouter", loadApiKey, fetch }),
    ).toBeUndefined();
    expect(loadApiKey).not.toHaveBeenCalled();
    const decide = createJevDecisionAdapter({
      enabled: true,
      transport: "openrouter",
      loadApiKey,
      fetch,
    })!;
    const result = await decide({ instruction: "ห้ามใช้ shell หรือ kill" }, CLOSE_NEGATION_QUESTION);
    expect(fetch.mock.calls[0]![0]).toBe("https://openrouter.ai/api/alpha/decisions");
    const request = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(request.model).toBe(JEV_OPENROUTER_MODEL);
    expect(request.questions.category.type).toBe("choice");
    expect(request).not.toHaveProperty("messages");
    expect(result).toMatchObject({
      status: "ok",
      actualModel: JEV_OPENROUTER_MODEL,
      inputTokens: 400,
      outputTokens: 46,
      costUsd: 0.0000168,
    });
    expect(JSON.stringify(result)).not.toContain("fake-private-key");
  });
  it("rejects a moved model, HTTP errors and malformed confidence without leaking provider bodies", async () => {
    const fetch = vi.fn();
    const decide = createJevDecisionAdapter({
      enabled: true,
      transport: "openrouter",
      apiKey: "fake",
      fetch,
    })!;
    fetch.mockResolvedValueOnce(answer("other", 1, "typesafe/jev-latest"));
    expect((await decide({ error: "unknown" }, MODEL_ERROR_QUESTION)).status).toBe(
      "model_mismatch",
    );
    fetch.mockResolvedValueOnce(new Response("private upstream details", { status: 429 }));
    expect(await decide({ error: "unknown" }, MODEL_ERROR_QUESTION)).toMatchObject({
      status: "unavailable",
      httpStatus: 429,
    });
    fetch.mockResolvedValueOnce(answer("other", 2));
    expect((await decide({ error: "unknown" }, MODEL_ERROR_QUESTION)).status).toBe(
      "invalid_response",
    );
  });
  it("asks on uncertainty, low confidence, no key or request failure", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(answer())
      .mockResolvedValueOnce(answer("affirmative", 0.88))
      .mockResolvedValueOnce(answer("uncertain", 0.99))
      .mockRejectedValueOnce(new Error("private error"));
    const classify = createJevNegationClassifier({
      enabled: true,
      transport: "openrouter",
      apiKey: "fake",
      fetch,
    })!;
    expect(await classify("ห้ามใช้ shell หรือ kill")).toBe("prohibited");
    expect(await classify("ออกจากโปรแกรมทดสอบได้เลย")).toBe("uncertain");
    expect(await classify("mixed instruction")).toBe("uncertain");
    expect(await classify("unknown")).toBe("uncertain");
    expect(createJevNegationClassifier({ enabled: true, transport: "openrouter" })).toBeUndefined();
  });
});
