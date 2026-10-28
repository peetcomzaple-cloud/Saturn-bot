import type {
  AdapterContext,
  BrowserActRequest,
  BrowserActResult,
  BrowserSnapshotResult,
  ComputerRef,
} from "@rakazo/adapter-kit";
import {
  buildSelectorObservation,
  parseSelectorDecision,
  type SelectorDecision,
  type SelectorObservation,
} from "./structured-action-selector.js";

export interface JevAdapterConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxActions?: number;
  maxTextChars?: number;
  /** Test hook for injecting mock Jev endpoint response */
  mockEndpoint?: (payload: JevRequestPayload) => Promise<JevApiResponse>;
}

export interface JevRequestPayload {
  goal: string;
  subgoal?: string;
  observation: SelectorObservation;
  activeFence?: number;
}

export interface JevApiResponse {
  success: boolean;
  decision?: {
    kind: string;
    candidateId?: number;
    action?: string;
    text?: string;
    reason?: string;
    confidence?: number;
  };
  error?: string;
}

export interface JevExecutionResult {
  decision: SelectorDecision;
  dispatched: boolean;
  applied: boolean;
  verified: boolean;
  liveStatus: "PASS" | "FAIL" | "NOT_TESTED";
  error?: string;
}

/**
 * Jev Ultrafast Decision Adapter.
 * Conforms to 03_JEV_TEST_PROTOCOL.md.
 * Does not replace core execution or goal gates.
 * Marked NOT_TESTED if live API key is absent.
 */
export class JevUltrafastAdapter {
  readonly config: JevAdapterConfig;
  private readonly maxActions: number;
  private readonly maxTextChars: number;

  constructor(config: JevAdapterConfig = {}) {
    this.config = config;
    this.maxActions = config.maxActions ?? 250;
    this.maxTextChars = config.maxTextChars ?? 6000;
  }

  isLiveConfigured(): boolean {
    return Boolean(this.config.apiKey && this.config.apiKey.trim() !== "");
  }

  async selectAction(
    goal: string,
    snapshot: BrowserSnapshotResult,
    computer: ComputerRef,
    context: AdapterContext,
    subgoal?: string,
  ): Promise<SelectorDecision> {
    context.signal.throwIfAborted();
    const currentFence = (computer as any).leaseFence ?? (computer as any).fence;

    const obs = buildSelectorObservation(snapshot, {
      activeFence: typeof currentFence === "number" ? currentFence : undefined,
      runId: (computer as any).runId,
    });

    // Check payload limits
    if (obs.candidates.length > this.maxActions) {
      obs.candidates = obs.candidates.slice(0, this.maxActions);
      obs.snapshotTruncated = true;
    }

    const payload: JevRequestPayload = {
      goal,
      subgoal,
      observation: obs,
      activeFence: typeof currentFence === "number" ? currentFence : undefined,
    };

    if (this.config.mockEndpoint) {
      const resp = await this.config.mockEndpoint(payload);
      return this.handleJevResponse(resp, obs);
    }

    if (!this.isLiveConfigured()) {
      // Live Jev is NOT_TESTED when no API key is provided
      return {
        kind: "no-match",
        reason: "Jev API key not configured (Live status: NOT_TESTED)",
      };
    }

    // Call live Jev endpoint
    try {
      const res = await fetch(`${this.config.baseUrl || "https://api.jev-ultrafast.invalid"}/v1/select`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: context.signal,
      });

      if (!res.ok) {
        return {
          kind: "blocked",
          reason: `Jev API error: ${res.status} ${res.statusText}`,
        };
      }

      const json = (await res.json()) as JevApiResponse;
      return this.handleJevResponse(json, obs);
    } catch (err) {
      context.signal.throwIfAborted();
      return {
        kind: "blocked",
        reason: `Jev network/request failure: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private handleJevResponse(resp: JevApiResponse, obs: SelectorObservation): SelectorDecision {
    if (!resp.success || !resp.decision) {
      return {
        kind: "no-match",
        reason: resp.error || "Jev returned empty or unsuccessful response",
      };
    }

    // Sanitize any action text to max characters
    if (resp.decision.text && resp.decision.text.length > this.maxTextChars) {
      resp.decision.text = resp.decision.text.slice(0, this.maxTextChars);
    }

    return parseSelectorDecision(JSON.stringify(resp.decision), obs);
  }
}
