import { describe, expect, it, vi } from "vitest";
import { classifyModelError, createTypeSafeErrorClassifier } from "./model-error-classifier.js";

describe("code-first model error classification", () => {
  it.each([
    ["HTTP 400: this model does not support image input", "image_unsupported"],
    ["Image input is not supported by this model", "image_unsupported"],
    ["Only supports text", "image_unsupported"],
    ["Image size too large", "other"],
    ["Image format unsupported", "other"],
    ["Image count limit exceeded", "other"],
    ["401 Unauthorized: vision unavailable", "other"],
    ["HTTP 422 invalid request", "other"],
    ["context_length_exceeded", "other"],
    ["429 rate limit", "rate_limit_or_quota"],
    ["Insufficient credits", "rate_limit_or_quota"],
  ] as const)("handles %s without spending a classifier request", async (text, expected) => {
    const optional = vi.fn();
    expect(await classifyModelError(text, optional)).toBe(expected);
    expect(optional).not.toHaveBeenCalled();
  });
  it("sends only unknown errors to the optional classifier and fails closed on classifier errors", async () => {
    const optional = vi.fn().mockResolvedValue("image_unsupported");
    expect(await classifyModelError("provider code xyz", optional)).toBe("image_unsupported");
    expect(optional).toHaveBeenCalledOnce();
    optional.mockRejectedValue(new Error("classifier unavailable"));
    expect(await classifyModelError("unknown", optional)).toBe("other");
    const abort = new AbortController();
    abort.abort();
    optional.mockClear();
    expect(await classifyModelError("unknown", optional, abort.signal)).toBe("other");
    expect(optional).not.toHaveBeenCalled();
  });
  it("supports the pinned OpenRouter route without touching a bot model selection", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({
          model: "typesafe/jev-1.14-20261014",
          answers: { category: { type: "choice", choice: "image_unsupported", confidence: 0.99 } },
        }),
      );
    const classify = createTypeSafeErrorClassifier({
      enabled: true,
      transport: "openrouter",
      loadApiKey: async () => "fake-key",
      fetch,
    })!;
    expect(await classify("unknown modality rejection")).toBe("image_unsupported");
    expect(fetch.mock.calls[0]![0]).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(JSON.parse(fetch.mock.calls[0]![1].body).model).toBe("typesafe/jev-1.14-20261014");
  });
});
