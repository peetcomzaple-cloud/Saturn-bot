/**
 * Adapted from the independent-expiry pattern in CopilotKit/OpenBot
 * toolkit/src/lease.ts @ e8bb27368ff436958b614292ae91283e51d5a813.
 * MIT, Copyright (c) 2026 CopilotKit. Full notice:
 * THIRD_PARTY_NOTICES_OPENBOT_CUA.md at this candidate's root.
 *
 * This supervises an already-held lease. It never wakes a bot or retries a model.
 */
export function watchLeaseRenewal(input: {
  renew: () => Promise<boolean>;
  everyMs: number;
  lifetimeMs: number;
  initialExpiresAt: number;
  onLost: () => void;
}): { stop: () => void } {
  const { renew, everyMs, lifetimeMs, initialExpiresAt, onLost } = input;
  if (!Number.isFinite(everyMs) || !Number.isFinite(lifetimeMs) ||
      !Number.isFinite(initialExpiresAt) || everyMs <= 0 || lifetimeMs <= everyMs) {
    throw new Error("Invalid lease renewal timing");
  }
  let stopped = false;
  let pending = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    stopped = true;
    if (interval !== undefined) clearInterval(interval);
    if (expiry !== undefined) clearTimeout(expiry);
  };
  const lose = () => {
    if (stopped) return;
    stop();
    onLost();
  };
  const armExpiry = (remainingMs: number) => {
    if (expiry !== undefined) clearTimeout(expiry);
    if (remainingMs <= 0) {
      lose();
      return;
    }
    expiry = setTimeout(lose, remainingMs);
    expiry.unref?.();
  };
  armExpiry(Math.min(initialExpiresAt - Date.now(), lifetimeMs));
  if (!stopped) {
    interval = setInterval(() => {
      if (stopped || pending) return;
      pending = true;
      // Renewal extends from request time, not a delayed response's arrival.
      const requestedAt = performance.now();
      void Promise.resolve().then(renew).then(
        (renewed) => {
          pending = false;
          if (stopped) return;
          if (!renewed) { lose(); return; }
          armExpiry(lifetimeMs - (performance.now() - requestedAt));
        },
        () => { pending = false; lose(); },
      );
    }, everyMs);
    interval.unref?.();
  }
  return { stop };
}
