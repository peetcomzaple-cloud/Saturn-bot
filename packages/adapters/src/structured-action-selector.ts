import type { BrowserSnapshotNode, BrowserSnapshotResult } from "@rakazo/adapter-kit";

export type SelectionDecisionKind =
  | "action"
  | "wait"
  | "no-match"
  | "ambiguous"
  | "blocked"
  | "need-input"
  | "done";

export interface CandidateAction {
  candidateId: number;
  ref: string;
  role: string;
  name: string;
  value?: string;
  tag?: string;
}

export interface SelectorObservation {
  url: string;
  title: string;
  candidates: CandidateAction[];
  snapshotTruncated: boolean;
  activeFence?: number;
  runId?: string;
}

export interface SelectorDecision {
  kind: SelectionDecisionKind;
  selectedCandidateId?: number;
  selectedRef?: string;
  actionKind?: "click" | "fill" | "type";
  actionText?: string;
  secretReference?: string;
  reason: string;
  confidence?: number;
}

/**
 * Builds structured observation candidates from accessibility snapshot.
 */
export function buildSelectorObservation(
  snapshot: BrowserSnapshotResult,
  options: { activeFence?: number; runId?: string } = {},
): SelectorObservation {
  const candidates: CandidateAction[] = (snapshot.elements || []).map((el, idx) => ({
    candidateId: idx + 1,
    ref: el.ref,
    role: el.role,
    name: el.name,
    value: el.value,
    tag: el.tag,
  }));

  return {
    url: snapshot.url,
    title: snapshot.title,
    candidates,
    snapshotTruncated: Boolean(snapshot.elements && snapshot.elements.length >= 80),
    activeFence: options.activeFence,
    runId: options.runId,
  };
}

/**
 * Format candidate list for Chinese structured models (DeepSeek-V3 / Qwen-2.5).
 */
export function formatPromptForChineseSelector(
  goal: string,
  subgoal: string,
  obs: SelectorObservation,
): string {
  const candidatesJson = JSON.stringify(
    obs.candidates.map((c) => ({
      id: c.candidateId,
      ref: c.ref,
      role: c.role,
      name: c.name,
      value: c.value,
    })),
    null,
    2,
  );

  return `你是一个精确的网页动作选择器（Web Action Selector）。
用户最终目标: ${goal}
当前子目标: ${subgoal}
页面URL: ${obs.url}
页面标题: ${obs.title}

候选操作元素:
${candidatesJson}

请以严格的 JSON 格式输出决策（禁止包含 Markdown 代码块标记以外的任何额外文本）：
{
  "kind": "action" | "wait" | "no-match" | "ambiguous" | "blocked" | "need-input" | "done",
  "candidateId": number (当 kind="action" 时必需),
  "action": "click" | "fill" | "type",
  "text": string (仅当 fill/type 时需要),
  "reason": "简要说明选择理由",
  "confidence": number (0.0 到 1.0)
}
注意：
1. 若页面正在加载或需要等待网络响应，选择 "wait"。
2. 若候选中没有匹配元素且目标已被截断，选择 "no-match"。
3. 若存在多个无法区分的同名目标，选择 "ambiguous"。
4. 遇到验证码、阻止访问或权限屏障，选择 "blocked"。
5. 需要用户输入密码或敏感凭据，选择 "need-input"（绝不要在 text 中猜测密码）。
6. 目标已确认达成，选择 "done"。`;
}

/**
 * Parse and validate model response schema strictly.
 * Rejects NaN, out-of-range candidate IDs, ungrounded actions.
 */
export function parseSelectorDecision(
  rawText: string,
  obs: SelectorObservation,
): SelectorDecision {
  let parsed: any;
  try {
    // Strip markdown code fences if present
    const clean = rawText.replace(/```json\s*|\s*```/g, "").trim();
    parsed = JSON.parse(clean);
  } catch (err) {
    return {
      kind: "no-match",
      reason: `Malformed JSON response from selector: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const kind = String(parsed.kind || "").toLowerCase() as SelectionDecisionKind;
  if (!["action", "wait", "no-match", "ambiguous", "blocked", "need-input", "done"].includes(kind)) {
    return {
      kind: "no-match",
      reason: `Invalid decision kind: ${parsed.kind}`,
    };
  }

  if (kind !== "action") {
    return {
      kind,
      reason: String(parsed.reason || `Selector returned ${kind}`),
      confidence: typeof parsed.confidence === "number" && !isNaN(parsed.confidence) ? parsed.confidence : undefined,
    };
  }

  const candidateId = Number(parsed.candidateId);
  if (!Number.isInteger(candidateId) || isNaN(candidateId) || candidateId <= 0) {
    return {
      kind: "no-match",
      reason: `Invalid candidateId: ${parsed.candidateId}`,
    };
  }

  const match = obs.candidates.find((c) => c.candidateId === candidateId);
  if (!match) {
    return {
      kind: "no-match",
      reason: `candidateId ${candidateId} out of range [1..${obs.candidates.length}]`,
    };
  }

  const actionKind = String(parsed.action || "click").toLowerCase();
  if (!["click", "fill", "type"].includes(actionKind)) {
    return {
      kind: "no-match",
      reason: `Unsupported action kind: ${actionKind}`,
    };
  }

  return {
    kind: "action",
    selectedCandidateId: candidateId,
    selectedRef: match.ref,
    actionKind: actionKind as "click" | "fill" | "type",
    actionText: parsed.text ? String(parsed.text) : undefined,
    reason: String(parsed.reason || `Selected candidate ${candidateId}`),
    confidence: typeof parsed.confidence === "number" && !isNaN(parsed.confidence) ? parsed.confidence : 1.0,
  };
}
