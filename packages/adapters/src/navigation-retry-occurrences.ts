import { toolEffectIdempotencyKey } from "@rakazo/core/node/approval-effect-key";

/** Completed, explicitly retryable navigation failures may be retried after a pause.
 * Successful or uncertain effects keep their original replay keys.
 */
export function restoredNavigationRetryOccurrences(
  runId: string,
  effects: Array<{ kind: string; request: unknown; result: unknown; idempotencyKey: string }>,
): Map<string, number> {
  const offsets = new Map<string, number>();
  const replayOnly = new Set<string>();
  for (const effect of effects) {
    if (effect.kind !== "browser_navigate" || !effect.request ||
        typeof effect.request !== "object" || Array.isArray(effect.request)) continue;
    const request = effect.request as Record<string, unknown>;
    const key = toolEffectIdempotencyKey(runId, effect.kind, request);
    const suffix = effect.idempotencyKey === key ? "0" :
      effect.idempotencyKey.startsWith(`${key}:`) ? effect.idempotencyKey.slice(key.length + 1) : "";
    if (!/^\d+$/.test(suffix)) continue;
    const occurrence = Number(suffix);
    if (!Number.isSafeInteger(occurrence) || occurrence >= Number.MAX_SAFE_INTEGER) continue;
    const result = effect.result && typeof effect.result === "object"
      ? effect.result as Record<string, unknown> : {};
    const status = result.httpStatus;
    if (typeof request.url !== "string" || result.url !== request.url ||
        result.ok !== false || result.retryable !== true ||
        (result.uncertain !== undefined && result.uncertain !== false) ||
        (result.completed !== undefined && result.completed !== 0) ||
        typeof status !== "number" || !Number.isInteger(status) ||
        !(status === 429 || (status >= 500 && status <= 599))) {
      replayOnly.add(key);
      continue;
    }
    offsets.set(key, Math.max(offsets.get(key) ?? 0, occurrence + 1));
  }
  for (const key of replayOnly) offsets.delete(key);
  return offsets;
}
