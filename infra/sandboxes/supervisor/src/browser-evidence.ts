import { z } from "zod";

const identity = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);
const executionIdentity = z.string().min(1).refine((value) => value.trim().length > 0 &&
  !/[\u0000-\u001f\u007f]/.test(value) && Buffer.byteLength(value, "utf8") <= 2048);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const event = z.object({
  at: z.number().finite().positive(),
  method: z.enum([
    "Target.attachToTarget", "Security.setIgnoreCertificateErrors", "helper.selected",
    "Inspector.detached", "Target.detachedFromTarget", "transport.closed",
    "Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFailed", "helper.result",
  ]),
  sessionId: identity.optional(),
  targetId: identity.optional(),
  requestId: identity.optional(),
  urlSha256: digest.optional(),
  requestMethod: z.enum(["GET", "POST", "HEAD"]).optional(),
  status: z.number().int().min(100).max(599).optional(),
  ignore: z.boolean().optional(),
  acknowledged: z.boolean().optional(),
  ok: z.boolean().optional(),
  errorCode: z.enum([
    "net::ERR_CERT_AUTHORITY_INVALID", "net::ERR_CERT_DATE_INVALID", "net::ERR_CERT_COMMON_NAME_INVALID",
    "net::ERR_NAME_NOT_RESOLVED", "net::ERR_NAME_RESOLUTION_FAILED",
    "net::ERR_CONNECTION_CLOSED", "net::ERR_CONNECTION_RESET", "net::ERR_CONNECTION_ABORTED",
    "net::ERR_TIMED_OUT", "net::ERR_EMPTY_RESPONSE", "net::ERR_INTERNET_DISCONNECTED", "net::ERR_ABORTED", "OTHER",
  ]).optional(),
}).strict();
const envelope = z.object({
  version: z.literal(1), runId: identity, executionId: executionIdentity,
  command: z.enum(["snapshot", "navigate", "act", "clear_origin_storage", "tab_list", "tab_switch", "tab_close",
    "scroll", "downloads", "click_selector", "harvest_json", "solve_challenge", "stealth"]),
  startedAt: z.number().finite().positive(), completedAt: z.number().finite().positive(),
  complete: z.boolean(), events: z.array(event).max(160),
}).strict();

export function browserEvidenceContext(runId?: string, executionId?: string) {
  if (runId === undefined && executionId === undefined) return undefined;
  return { runId: identity.parse(runId), executionId: executionIdentity.parse(executionId) };
}

export function decodeBrowserExecutionId(encoded?: string) {
  if (encoded === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]{1,2731}$/.test(encoded)) throw new Error("Invalid browser execution transport");
  const value = Buffer.from(encoded, "base64url").toString("utf8");
  if (Buffer.from(value, "utf8").toString("base64url") !== encoded) throw new Error("Invalid browser execution encoding");
  return executionIdentity.parse(value);
}

export function consumeBrowserEvidence(
  value: unknown,
  expected: ReturnType<typeof browserEvidenceContext>,
  command: string,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid page browser result");
  }
  const { _browserEvidence: raw, ...result } = value as Record<string, unknown>;
  if (!expected) return { result, evidence: undefined };
  const parsed = envelope.safeParse(raw);
  if (!parsed.success || parsed.data.runId !== expected.runId ||
      parsed.data.executionId !== expected.executionId || parsed.data.command !== command ||
      parsed.data.startedAt > parsed.data.completedAt ||
      parsed.data.events.some((entry) => entry.at < parsed.data.startedAt || entry.at > parsed.data.completedAt)) {
    return { result, evidence: { ...expected, command, complete: false, captureError: "INVALID_OR_MISSING_CAPTURE" } };
  }
  return { result, evidence: parsed.data };
}
