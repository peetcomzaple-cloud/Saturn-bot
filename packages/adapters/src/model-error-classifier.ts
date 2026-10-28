import {
  createJevDecisionAdapter,
  MODEL_ERROR_QUESTION,
  CLOSE_NEGATION_QUESTION,
} from "./jev-decision.js";

/** Narrow classification only. No task, screenshot, credentials or tool arguments are sent. */
export type ModelErrorClass = "image_unsupported" | "rate_limit_or_quota" | "other";
export type ModelErrorClassifier = (
  errorText: string,
  signal?: AbortSignal,
) => Promise<ModelErrorClass>;
export type CloseNegationClassifier = (
  instruction: string,
  signal?: AbortSignal,
) => Promise<"prohibited" | "affirmative" | "uncertain">;

/** Separate opt-in: no key, failed request or low confidence always means ask. */
export function createJevNegationClassifier(
  input: Parameters<typeof createJevDecisionAdapter>[0],
): CloseNegationClassifier | undefined {
  const decide = createJevDecisionAdapter(input);
  if (!decide) return undefined;
  return async (instruction, signal) => {
    const answer = await decide({ instruction }, CLOSE_NEGATION_QUESTION, signal);
    if (answer.status !== "ok" || (answer.confidence ?? 0) < 0.95) return "uncertain";
    return answer.choice === "prohibited" || answer.choice === "affirmative"
      ? answer.choice
      : "uncertain";
  };
}

export function classifyKnownModelError(text: string): ModelErrorClass | undefined {
  const value = text.toLowerCase();
  // Image size/count/format, authentication and malformed requests are not evidence
  // that a model cannot see. Only explicit modality rejection is durable evidence.
  if (
    /image.{0,40}(?:too large|size|resolution|format|count|limit)|(?:unauthorized|invalid api key|authentication|forbidden)/.test(
      value,
    )
  )
    return "other";
  if (
    /(?:does not|doesn't|do not|cannot|can't|not|unsupported).{0,35}(?:support|accept|process|image input|vision).{0,30}(?:image|vision)|(?:image|vision).{0,35}(?:not supported|unsupported|not available|not permitted)|only supports? text|supports? only text|text.only model/.test(
      value,
    )
  )
    return "image_unsupported";
  if (
    /\b(?:http|status|statuscode|status code)\s*[:=]?\s*(?:400|401|403|422)\b|context.length|invalid.request|invalid.parameter/.test(
      value,
    )
  )
    return "other";
  if (
    /\b429\b|rate.?limit|too many requests|quota|insufficient (?:credits|funds)|credit balance|billing limit/.test(
      value,
    )
  )
    return "rate_limit_or_quota";
  return undefined;
}

export async function classifyModelError(
  text: string,
  optionalClassifier?: ModelErrorClassifier,
  signal?: AbortSignal,
): Promise<ModelErrorClass> {
  const known = classifyKnownModelError(text);
  if (known) return known;
  if (!optionalClassifier || signal?.aborted) return "other";
  try {
    return await optionalClassifier(text, signal);
  } catch {
    return "other";
  }
}

/** Opt-in, text-only TypeSafe adapter. Version and host are deliberately pinned. */
export function createTypeSafeErrorClassifier(input: {
  enabled: boolean;
  apiKey?: string;
  fetch?: typeof fetch;
  transport?: "typesafe" | "openrouter";
  loadApiKey?: () => Promise<string | undefined>;
}): ModelErrorClassifier | undefined {
  const decide = createJevDecisionAdapter({ ...input, transport: input.transport ?? "typesafe" });
  if (!decide) return undefined;
  return async (errorText, signal) => {
    const answer = await decide({ error: errorText }, MODEL_ERROR_QUESTION, signal);
    if (answer.status !== "ok" || (answer.confidence ?? 0) < 0.95) return "other";
    return answer.choice === "image_unsupported" || answer.choice === "rate_limit_or_quota"
      ? answer.choice
      : "other";
  };
}
