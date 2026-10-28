import { toolEffectIdempotencyKey } from "@rakazo/core/node/approval-effect-key";
import { describe, expect, it } from "vitest";
import { BrowserRecovery } from "./browser-recovery.js";
import { restoredNavigationRetryOccurrences } from "./navigation-retry-occurrences.js";

const request = { url: "https://fixture.test/limited" };
const failure = { ok: false, url: request.url, error: "HTTP 429", httpStatus: 429, retryable: true };
const key = toolEffectIdempotencyKey("run", "browser_navigate", request);
const effect = { kind: "browser_navigate", request, result: failure, idempotencyKey: key };

describe("navigation retries after resume", () => {
  it("uses a fresh effect for the one permitted retry, then blocks at two actual failures", () => {
    const restored = restoredNavigationRetryOccurrences("run", [effect]);
    expect(toolEffectIdempotencyKey("run", effect.kind, request, restored.get(key))).not.toBe(key);
    const recovery = new BrowserRecovery([effect]);
    expect(recovery.blockedResult("browser_navigate", request)).toBeUndefined();
    recovery.record("browser_navigate", failure);
    expect(recovery.blockedResult("browser_navigate", request)).toMatchObject({ errorCode: "RETRY_LIMIT_EXCEEDED" });
    expect(new BrowserRecovery([effect, effect]).blockedResult("browser_navigate", request))
      .toMatchObject({ errorCode: "RETRY_LIMIT_EXCEEDED" });
  });

  it.each([429, 500, 502, 503, 504, 599])("advances an explicit retryable HTTP %s failure", (httpStatus) => {
    expect(restoredNavigationRetryOccurrences("run", [{ ...effect, result: { ...failure, httpStatus } }]).get(key)).toBe(1);
  });

  it.each([
    { ...failure, ok: true }, { ...failure, uncertain: true }, { ...failure, completed: 1 },
    { ...failure, uncertain: "unknown" }, { ...failure, completed: "1" }, { ...failure, completed: -1 },
    { ...failure, retryable: false }, { ...failure, httpStatus: 403 },
    { ...failure, httpStatus: 600 }, { ...failure, url: "https://other.test/" }, {},
  ])("preserves replay for successful, uncertain, foreign or ineligible outcomes %j", (result) => {
    expect(restoredNavigationRetryOccurrences("run", [{ ...effect, result }]).size).toBe(0);
  });

  it("preserves successful replay even when another matching failure exists", () => {
    expect(restoredNavigationRetryOccurrences("run", [effect, { ...effect,
      idempotencyKey: `${key}:1`, result: { ok: true, url: request.url } }]).size).toBe(0);
  });

  it("ignores foreign-run and legacy keys, non-navigation mutations and malformed suffixes", () => {
    for (const candidate of [{ ...effect, idempotencyKey: key.replace("run:", "other:") },
      { ...effect, kind: "browser_act" }, { ...effect, idempotencyKey: "legacy" },
      { ...effect, idempotencyKey: `${key}:1junk` }]) {
      expect(restoredNavigationRetryOccurrences("run", [candidate]).size).toBe(0);
    }
  });
});
