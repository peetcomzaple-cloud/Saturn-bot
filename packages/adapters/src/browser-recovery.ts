export interface SubresourceErrorRecord {
  url: string;
  status?: number;
  mimeType?: string;
  type?: string;
  errorText?: string;
}

export interface NavigationFailureRecord {
  url: string;
  hostname: string;
  error: string;
  errorCode: string;
  errorKind: string;
  retryable: boolean;
  httpStatus?: number;
  httpStatusStatus?: "known" | "unknown";
  retryAfterMs?: number;
  redirected?: boolean;
  suggestions?: string[];
  note?: string;
  attempts: number;
}

export function detectVerifiedChallengeSignal(
  value: Record<string, unknown>,
): { detected: boolean; challengeType?: string } {
  const httpStatus =
    typeof value.httpStatus === "number"
      ? value.httpStatus
      : typeof value.status_code === "number"
        ? value.status_code
        : undefined;

  if (
    value.challengeDetected !== true &&
    httpStatus !== undefined &&
    (httpStatus === 400 || httpStatus === 404 || httpStatus >= 500)
  ) {
    return { detected: false };
  }

  if (value.challengeDetected === true) {
    return {
      detected: true,
      challengeType:
        typeof value.challengeType === "string" && value.challengeType
          ? value.challengeType
          : "captcha",
    };
  }

  const errStr = typeof value.error === "string" ? value.error : "";
  if (/Anti-bot or security challenge detected/i.test(errStr)) {
    return {
      detected: true,
      challengeType:
        typeof value.challengeType === "string" && value.challengeType
          ? value.challengeType
          : /turnstile/i.test(errStr)
            ? "turnstile"
            : /hcaptcha/i.test(errStr)
              ? "hcaptcha"
              : "captcha",
    };
  }

  const elements = Array.isArray(value.elements)
    ? (value.elements as Array<{ role?: string; name?: string; tag?: string; type?: string }>)
    : [];
  for (const el of elements) {
    const role = String(el?.role ?? "").toLowerCase();
    const name = String(el?.name ?? "");
    if (
      (role === "checkbox" || role === "button" || role === "iframe") &&
      /(?:turnstile|hcaptcha|recaptcha|verify you are human|ยืนยันว่าคุณไม่ใช่บอท|ฉันไม่ใช่โปรแกรมอัตโนมัติ)/i.test(
        name,
      )
    ) {
      return { detected: true, challengeType: "captcha" };
    }
    if (
      (role === "textbox" || role === "spinbutton") &&
      /(?:\botp\b|\bmfa\b|\b2fa\b|one-time password|verification code|authenticator code|รหัสยืนยัน|รหัส otp)/i.test(
        name,
      )
    ) {
      return { detected: true, challengeType: "mfa_challenge" };
    }
  }

  const title = typeof value.title === "string" ? value.title : "";
  const tree = typeof value.tree === "string" ? value.tree : "";
  if (
    /^(?:just a moment\.\.\.|attention required!\s*\|\s*cloudflare)$/i.test(title.trim()) &&
    /(?:verify you are human|checking your browser before accessing|enable javascript and cookies to continue|cloudflare)/i.test(
      `${title}\n${tree}\n${errStr}`,
    )
  ) {
    return { detected: true, challengeType: "cloudflare_challenge" };
  }

  return { detected: false };
}

export const DEFAULT_MAX_RETRY_AFTER_MS = 60_000;

export function isProviderOrSchemaApi400(input: {
  url?: string;
  title?: string;
  error?: string;
  bodySnippet?: string;
}): boolean {
  const url = String(input.url ?? "");
  const textSpace = `${input.title ?? ""}\n${input.error ?? ""}\n${input.bodySnippet ?? ""}`;
  const hasApiPath = /\/(?:api|v1|v2|graphql|rest)\//i.test(url);
  const hasSchemaText =
    /(?:invalid_request_error|schema[\s_-]*validation|validation[\s_-]*error|missing[\s_-]*required[\s_-]*(?:field|parameter|argument)|malformed[\s_-]*(?:json|request|payload|query)|invalid[\s_-]*(?:parameter|argument|tool[\s_-]*input))/i.test(
      textSpace,
    );
  return hasSchemaText || (hasApiPath && !/(?:flow[\s_-]*state|servicelogin|oauth)/i.test(textSpace));
}

export function isEvidencedAuthFlow400(input: {
  url?: string;
  title?: string;
  error?: string;
  bodySnippet?: string;
  errorCode?: unknown;
  errorKind?: unknown;
  redirectChain?: Array<{ url?: string; status?: number }>;
}): boolean {
  if (
    input.errorCode === "FLOW_STATE_INVALID" ||
    input.errorKind === "flow_state_invalid"
  ) {
    return true;
  }
  const url = String(input.url ?? "");
  const redirectUrls = Array.isArray(input.redirectChain)
    ? input.redirectChain.map((r) => String(r?.url ?? "")).join(" ")
    : "";
  const urlSpace = `${url} ${redirectUrls}`;
  const textSpace = `${input.title ?? ""}\n${input.error ?? ""}\n${input.bodySnippet ?? ""}`;

  if (
    isProviderOrSchemaApi400(input) &&
    !/(?:oauth|saml|oidc|flow_state|flowentry|servicelogin)/i.test(urlSpace)
  ) {
    return false;
  }

  const hasAuthFlowUrlEvidence =
    /\/(?:login|signin|sign-in|auth|oauth|oauth2|saml|oidc|sso|servicelogin|authorize|callback)\b/i.test(
      urlSpace,
    ) ||
    /(?:^|[?&])(?:flow|flowentry|flowname|flow_state|state|code|samlrequest|relaystate|client_id|redirect_uri|nonce)=/i.test(
      urlSpace,
    ) ||
    /(?:bad-flow|flow-state|bad-cookie)/i.test(urlSpace);

  const hasAuthFlowTextEvidence =
    /(?:flow[\s_-]*state[\s_-]*(?:invalid|missing|expired)|invalid[\s_-]*flow[\s_-]*state|login[\s_-]*flow|auth(?:entication)?[\s_-]*flow|missing[\s_-]*flow[\s_-]*parameter|corrupt(?:ed)?[\s_-]*(?:auth|login|session|origin)[\s_-]*cookie|session[\s_-]*flow[\s_-]*expired)/i.test(
      textSpace,
    );

  return hasAuthFlowUrlEvidence || hasAuthFlowTextEvidence;
}

export function classifyHttp400(input: {
  url?: string;
  title?: string;
  error?: string;
  bodySnippet?: string;
  errorCode?: unknown;
  errorKind?: unknown;
  redirectChain?: Array<{ url?: string; status?: number }>;
}): {
  errorCode: string;
  errorKind: string;
  retryable: boolean;
  suggestions?: string[];
  note: string;
} {
  if (isEvidencedAuthFlow400(input)) {
    return {
      errorCode: "FLOW_STATE_INVALID",
      errorKind: "flow_state_invalid",
      retryable: true,
      suggestions: [
        "Return to service entry point (base login URL) before attempting any storage resets; if still failing, call browser_clear_origin_storage on that origin once",
      ],
      note:
        "หน้าล็อกอินภายในคืนค่า HTTP 400 Bad Request เนื่องจากขาด flow state ให้กลับไปยัง entry point เริ่มต้นของบริการ หากยังติดสถานะเดิมจึงใช้ browser_clear_origin_storage สำหรับ origin นั้นเพียงครั้งเดียว",
    };
  }
  if (isProviderOrSchemaApi400(input)) {
    return {
      errorCode: "HTTP_400_API",
      errorKind: "api_bad_request",
      retryable: false,
      note:
        "คำขอ API หรือพารามิเตอร์ไม่ถูกต้อง (HTTP 400) กรุณาแก้ไขโครงสร้างคำขอหรือพารามิเตอร์ ห้ามล้างคุกกี้หรือ storage ของเบราว์เซอร์",
    };
  }
  return {
    errorCode: "HTTP_400",
    errorKind: "http_error",
    retryable: false,
    note:
      "หน้าเว็บคืนค่า HTTP 400 Bad Request (คำขอไม่ถูกต้องทั่วไป ไม่ใช่สถานะล็อกอิน flow_state_invalid) ห้ามล้างคุกกี้เว้นแต่มีหลักฐานว่าข้อมูล origin เสียหาย",
  };
}

export function classifyHttp401Or403(input: {
  status: number;
  url?: string;
  title?: string;
  error?: string;
  bodySnippet?: string;
  challengeDetected?: boolean;
}): {
  errorCode: string;
  errorKind: string;
  retryable: boolean;
  note: string;
} {
  const status = input.status;
  const textSpace = `${input.title ?? ""}\n${input.error ?? ""}\n${input.bodySnippet ?? ""}`;
  if (
    input.challengeDetected ||
    /(?:captcha|challenge|turnstile|hcaptcha|just a moment|verify you are human)/i.test(textSpace)
  ) {
    return {
      errorCode: "CHALLENGE_DETECTED",
      errorKind: "challenge",
      retryable: false,
      note: "ตรวจพบแบบทดสอบความปลอดภัย (CAPTCHA/Challenge) บนหน้า HTTP 403 กรุณาใช้ request_takeover",
    };
  }
  if (
    status === 401 ||
    /(?:session[\s_-]*expired|token[\s_-]*expired|login[\s_-]*required|authentication[\s_-]*required|please[\s_-]*(?:log[\s_-]*in|sign[\s_-]*in)|unauthenticated|re-?authenticate)/i.test(
      textSpace,
    )
  ) {
    return {
      errorCode: status === 401 ? "HTTP_401" : "HTTP_403_AUTH_EXPIRED",
      errorKind: "auth_expired",
      retryable: false,
      note: "เซสชันหมดอายุหรือต้องเข้าสู่ระบบใหม่ กรุณานำทางไปยังหน้าล็อกอินหรือใช้ request_secret/request_takeover",
    };
  }
  if (
    /(?:insufficient[\s_-]*permission|permission[\s_-]*denied|access[\s_-]*denied[\s_-]*for[\s_-]*(?:role|user|account)|requires[\s_-]*(?:admin|elevated|role)|not[\s_-]*authorized[\s_-]*to[\s_-]*access|forbidden[\s_-]*role|missing[\s_-]*scope)/i.test(
      textSpace,
    )
  ) {
    return {
      errorCode: "HTTP_403_INSUFFICIENT_PERMISSION",
      errorKind: "insufficient_permission",
      retryable: false,
      note: "บัญชีปัจจุบันไม่มีสิทธิ์เข้าถึงทรัพยากรนี้ (Insufficient Permission) ห้ามส่งซ้ำหรือล้างคุกกี้",
    };
  }
  if (
    /(?:waf|firewall|cloudflare[\s_-]*ray|akamai|imperva|blocked[\s_-]*by[\s_-]*security[\s_-]*policy|ip[\s_-]*blocked|geo[\s_-]*blocked|access[\s_-]*denied)/i.test(
      textSpace,
    )
  ) {
    return {
      errorCode: "HTTP_403_WAF_DENIED",
      errorKind: "waf_denied",
      retryable: false,
      note: "ถูกปฏิเสธการเข้าถึงโดย WAF หรือนโยบายความปลอดภัย ให้ใช้ connector ที่ได้รับอนุญาตหรือแหล่งข้อมูลสาธารณะ (public mirror) ที่ถูกต้องแทน",
    };
  }
  return {
    errorCode: `HTTP_${status}`,
    errorKind: "auth_or_forbidden",
    retryable: false,
    note: "ไม่สามารถเข้าถึงหน้านี้ได้ (HTTP 403) กรุณาตรวจสอบสิทธิ์หรือใช้แหล่งข้อมูลสำรองที่ได้รับอนุญาต",
  };
}

/** A run-scoped budget, restored from existing effect results after an approval resume. */
export class BrowserRecovery {
  private failures = 0;
  private staleRefFailures = 0;
  private snapshotSinceStale = false;
  private uncertain = false;
  private lastError = "";
  private navigationFailure?: NavigationFailureRecord;
  private originStorageClearedForCurrentFailure = false;
  private challengeDetected = false;
  private challengeType?: string;
  private cdpDisconnected = false;
  private reconciledSinceUncertain = false;
  private dispatchedRefsWhileUncertain = new Set<string>();
  private subresourceErrors: SubresourceErrorRecord[] = [];
  private maxRetryAfterMs = DEFAULT_MAX_RETRY_AFTER_MS;

  constructor(
    effects: Array<{ kind: string; result: unknown }> = [],
    options: { maxRetryAfterMs?: number } = {},
  ) {
    if (typeof options.maxRetryAfterMs === "number" && options.maxRetryAfterMs > 0) {
      this.maxRetryAfterMs = options.maxRetryAfterMs;
    }
    for (const effect of effects) this.record(effect.kind, effect.result);
  }

  getSubresourceErrors(): SubresourceErrorRecord[] {
    return this.subresourceErrors;
  }

  isChallengeDetected(): boolean {
    return this.challengeDetected;
  }

  getChallengeType(): string | undefined {
    return this.challengeType;
  }

  isCdpDisconnected(): boolean {
    return this.cdpDisconnected;
  }

  getNavigationFailure(): NavigationFailureRecord | undefined {
    return this.navigationFailure;
  }

  record(name: string, result: unknown): void {
    if (
      name !== "browser_act" &&
      name !== "computer_act" &&
      name !== "browser_navigate" &&
      name !== "browser_snapshot" &&
      name !== "browser_clear_origin_storage"
    ) {
      return;
    }
    if (!result || typeof result !== "object") return;
    const value = result as Record<string, unknown>;

    if (name === "browser_clear_origin_storage") {
      if (!value.error && value.ok !== false) {
        this.originStorageClearedForCurrentFailure = true;
        if (this.navigationFailure?.errorKind === "flow_state_invalid") {
          this.navigationFailure = undefined;
        }
      }
      return;
    }

    // Handle browser_snapshot: record fresh snapshot taken, rebind CDP, and reconcile uncertain state
    if (name === "browser_snapshot") {
      if (!value.error && value.ok !== false) {
        // A replacement document can finish an interrupted navigation without another navigate call.
        // Other network, HTTP and challenge failures still require their normal recovery path.
        if (
          this.navigationFailure &&
          (this.navigationFailure.errorCode === "BROWSER_ERROR" ||
            this.navigationFailure.errorCode === "ERR_ABORTED") &&
          /\bnet::ERR_ABORTED\b/.test(this.navigationFailure.error) &&
          (value.ok === true || value.ok === undefined) &&
          value.fallback === undefined &&
          value.url === this.navigationFailure.url &&
          value.readyState === "complete" &&
          typeof value.tree === "string" && value.tree.trim().length > 0 &&
          !/\b(?:net::)?ERR_[A-Z_]+\b/.test(value.tree) &&
          !(typeof this.navigationFailure.httpStatus === "number" && this.navigationFailure.httpStatus >= 400) &&
          typeof value.targetId === "string" && value.targetId.length > 0 &&
          typeof value.frameId === "string" && value.frameId.length > 0 &&
          typeof value.loaderId === "string" && value.loaderId.length > 0 &&
          Number.isSafeInteger(value.snapshotGeneration) && Number(value.snapshotGeneration) > 0 &&
          !(typeof value.httpStatus === "number" && value.httpStatus >= 400) &&
          !(typeof value.status_code === "number" && value.status_code >= 400) &&
          !(typeof value.errorDocumentStatus === "number" && value.errorDocumentStatus >= 400) &&
          !detectVerifiedChallengeSignal(value).detected
        ) {
          this.navigationFailure = undefined;
        }
        this.snapshotSinceStale = true;
        this.cdpDisconnected = false;
        if (this.uncertain) {
          this.reconciledSinceUncertain = true;
        }
        if (Array.isArray(value.subresourceErrors)) {
          this.subresourceErrors = value.subresourceErrors as SubresourceErrorRecord[];
        }
        if (value.challengeDetected === false) {
          this.challengeDetected = false;
          this.challengeType = undefined;
        }
      }
      const challengeSig = detectVerifiedChallengeSignal(value);
      if (challengeSig.detected) {
        this.challengeDetected = true;
        this.challengeType = challengeSig.challengeType ?? "captcha";
      } else if (value.challengeDetected === false || (!value.error && value.ok !== false)) {
        this.challengeDetected = false;
        this.challengeType = undefined;
      }
      return;
    }

    // Handle browser_navigate
    if (name === "browser_navigate") {
      const httpStatus =
        typeof value.httpStatus === "number"
          ? value.httpStatus
          : typeof value.status_code === "number"
            ? value.status_code
            : undefined;
      const httpStatusStatus: "known" | "unknown" =
        value.httpStatusStatus === "known" || value.httpStatusStatus === "unknown"
          ? value.httpStatusStatus
          : httpStatus !== undefined
            ? "known"
            : "unknown";
      const retryAfterMs =
        typeof value.retryAfterMs === "number" && Number.isFinite(value.retryAfterMs)
          ? value.retryAfterMs
          : undefined;
      const redirected = typeof value.redirected === "boolean" ? value.redirected : undefined;

      const challengeSig = detectVerifiedChallengeSignal(value);
      const isChallengeSignal = challengeSig.detected;

      if (isChallengeSignal) {
        this.challengeDetected = true;
        this.challengeType = challengeSig.challengeType ?? "captcha";
      } else if (value.challengeDetected === false) {
        this.challengeDetected = false;
        this.challengeType = undefined;
      }

      if (value.error || value.ok === false || (httpStatus !== undefined && httpStatus >= 400)) {
        const err = String(
          value.error || (httpStatus !== undefined ? `HTTP ${httpStatus}` : "Navigation failed"),
        );
        const url = String(value.url ?? "");
        let hostname = String(value.hostname ?? "");
        if (!hostname && url) {
          try {
            hostname = new URL(url).hostname;
          } catch {
            hostname = url.replace(/^[a-zA-Z]+:\/\//, "").split("/")[0]?.split(":")[0] ?? "";
          }
        }

        const isNxdomain =
          value.errorCode === "NXDOMAIN" ||
          err.includes("ERR_NAME_NOT_RESOLVED") ||
          err.includes("ERR_NAME_RESOLUTION_FAILED") ||
          err.includes("ENOTFOUND");

        const isTlsDns =
          !isNxdomain &&
          (value.errorCode === "TLS_DNS" ||
            err.includes("ERR_CONNECTION_REFUSED") ||
            err.includes("ERR_CERT_") ||
            err.includes("ERR_SSL_") ||
            err.includes("certificate"));

        const isCdp =
          err.includes("WebSocket") ||
          err.includes("Target closed") ||
          err.includes("CDP disconnected") ||
          err.includes("No target");

        const is400Signal =
          !isChallengeSignal &&
          (httpStatus === 400 ||
            err.includes("Error 400") ||
            err.includes("400 Bad Request"));

        const isTimeout =
          !isNxdomain &&
          !isTlsDns &&
          !isCdp &&
          (value.errorCode === "NAVIGATION_TIMEOUT" ||
            err.includes("ERR_CONNECTION_TIMED_OUT") ||
            err.includes("ERR_TIMED_OUT") ||
            err.includes("Navigation did not settle") ||
            /timed?\s*out/i.test(err));

        let errorCode = String(value.errorCode ?? "BROWSER_ERROR");
        let errorKind = String(value.errorKind ?? "unknown");
        let retryable = value.retryable === true;
        let suggestions = Array.isArray(value.suggestions)
          ? (value.suggestions as string[])
          : undefined;
        let note = typeof value.note === "string" ? value.note : undefined;

        if (isNxdomain) {
          errorCode = "NXDOMAIN";
          errorKind = "nxdomain";
          retryable = false;
        } else if (isTlsDns) {
          errorCode = "TLS_DNS";
          errorKind = "tls_dns";
          retryable = false;
          note =
            note ||
            "ตรวจพบข้อผิดพลาดใบรับรองความปลอดภัย TLS/SSL ห้ามข้ามหน้าเตือนใบรับรอง (certificate interstitial) โดยเด็ดขาด";
        } else if (isCdp) {
          errorCode = "CDP_DISCONNECTED";
          errorKind = "cdp_disconnected";
          retryable = true;
          this.cdpDisconnected = true;
          this.staleRefFailures = Math.max(1, this.staleRefFailures);
          this.snapshotSinceStale = false;
        } else if (isTimeout) {
          errorCode = "NAVIGATION_TIMEOUT";
          errorKind = "timeout";
          retryable = true;
        } else if (isChallengeSignal) {
          errorCode = "CHALLENGE_DETECTED";
          errorKind = "challenge";
          retryable = false;
        } else if (is400Signal) {
          const c400 = classifyHttp400({
            url,
            title: typeof value.title === "string" ? value.title : undefined,
            error: err,
            bodySnippet: typeof value.bodySnippet === "string" ? value.bodySnippet : undefined,
            errorCode: value.errorCode,
            errorKind: value.errorKind,
            redirectChain: Array.isArray(value.redirectChain)
              ? (value.redirectChain as Array<{ url?: string; status?: number }>)
              : undefined,
          });
          errorCode = c400.errorCode;
          errorKind = c400.errorKind;
          retryable = c400.retryable;
          suggestions = suggestions || c400.suggestions;
          note = note || c400.note;
        } else if (httpStatus === 401 || httpStatus === 403) {
          const c403 = classifyHttp401Or403({
            status: httpStatus,
            url,
            title: typeof value.title === "string" ? value.title : undefined,
            error: err,
            bodySnippet: typeof value.bodySnippet === "string" ? value.bodySnippet : undefined,
            challengeDetected: isChallengeSignal,
          });
          errorCode = c403.errorCode;
          errorKind = c403.errorKind;
          retryable = c403.retryable;
          note = note || c403.note;
        } else if (httpStatus === 404) {
          errorCode = "HTTP_404";
          errorKind = "http_not_found";
          retryable = false;
        } else if (httpStatus === 429) {
          if (retryAfterMs !== undefined && retryAfterMs > this.maxRetryAfterMs) {
            errorCode = "RETRY_AFTER_EXCEEDED";
            errorKind = "rate_limited_deadline_exceeded";
            retryable = false;
            note =
              note ||
              `Rate limited (HTTP 429) with Retry-After (${Math.ceil(retryAfterMs / 1000)}s) exceeding execution budget. Defer or report BLOCKED; do not clear cookies.`;
          } else {
            errorCode = "HTTP_429";
            errorKind = "rate_limited";
            retryable = true;
          }
        } else if (httpStatus !== undefined && httpStatus >= 500) {
          errorCode = `HTTP_${httpStatus}`;
          errorKind = "server_error";
          retryable = true;
        } else if (httpStatus !== undefined && httpStatus >= 400) {
          errorCode = `HTTP_${httpStatus}`;
          errorKind = "http_error";
          retryable = false;
        }

        this.navigationFailure = {
          url,
          hostname,
          error: err,
          errorCode,
          errorKind,
          retryable,
          httpStatus,
          httpStatusStatus,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          ...(redirected !== undefined ? { redirected } : {}),
          suggestions,
          note,
          attempts: (this.navigationFailure?.attempts ?? 0) + 1,
        };
      } else {
        // Successful navigation clears any navigation failure and old page stale ref state
        this.navigationFailure = undefined;
        this.originStorageClearedForCurrentFailure = false;
        this.cdpDisconnected = false;
        this.staleRefFailures = 0;
        this.snapshotSinceStale = false;
        this.subresourceErrors = Array.isArray(value.subresourceErrors)
          ? (value.subresourceErrors as SubresourceErrorRecord[])
          : [];
        if (this.uncertain) {
          this.reconciledSinceUncertain = true;
        } else {
          this.failures = 0;
          this.lastError = "";
        }
      }
      return;
    }

    // Handle browser_act and computer_act
    if (value.error || value.ok === false) {
      if (name === "browser_act") {
        const err = String(value.error || "");
        const challengeSig = detectVerifiedChallengeSignal(value);
        if (challengeSig.detected) {
          this.challengeDetected = true;
          this.challengeType = challengeSig.challengeType ?? "captcha";
          this.lastError = err || "Security challenge detected";
          return;
        }

        const isCdp =
          err.includes("WebSocket") ||
          err.includes("Target closed") ||
          err.includes("CDP disconnected") ||
          err.includes("No target");
        if (isCdp) {
          this.cdpDisconnected = true;
          this.lastError = err;
          return;
        }

        const isStaleBeforeDispatch =
          !value.uncertain &&
          Number(value.completed ?? 0) === 0 &&
          (err.includes("Stale element ref") ||
            err.includes("Unknown element ref"));
        if (isStaleBeforeDispatch) {
          this.staleRefFailures += 1;
          this.snapshotSinceStale = false;
          this.lastError = err || "Stale element ref";
        } else {
          this.failures += 1;
          const becameUncertain = value.uncertain === true || Number(value.completed ?? 0) > 0;
          if (becameUncertain) {
            this.uncertain = true;
            this.reconciledSinceUncertain = false;
            if (Array.isArray(value.dispatchedRefs)) {
              for (const ref of value.dispatchedRefs) {
                if (typeof ref === "string" && ref) this.dispatchedRefsWhileUncertain.add(ref);
              }
            }
          }
          this.lastError = err || "Page action was not confirmed";
        }
      }
    } else {
      // Successful action clears action failures
      this.failures = 0;
      this.staleRefFailures = 0;
      this.snapshotSinceStale = false;
      this.uncertain = false;
      this.reconciledSinceUncertain = false;
      this.dispatchedRefsWhileUncertain.clear();
      this.lastError = "";
      this.cdpDisconnected = false;
      if (name === "browser_act") {
        const challengeSig = detectVerifiedChallengeSignal(value);
        if (challengeSig.detected) {
          this.challengeDetected = true;
          this.challengeType = challengeSig.challengeType ?? "captcha";
        } else if (value.challengeDetected === false || Array.isArray(value.elements)) {
          this.challengeDetected = false;
          this.challengeType = undefined;
        }
      }
      // NOTE: A successful computer_act does NOT clear navigation failure,
      // because clicking the desktop does not prove navigation to a dead domain succeeded.
    }
  }

  blockedResult(
    toolName?: string,
    args?: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    // 1. Check if browser_navigate is blocked
    if (toolName === "browser_navigate") {
      if (this.navigationFailure) {
        const targetUrl = String(args?.url ?? "");
        let targetHost = "";
        try {
          targetHost = new URL(targetUrl).hostname;
        } catch {
          targetHost = targetUrl.replace(/^[a-zA-Z]+:\/\//, "").split("/")[0]?.split(":")[0] ?? "";
        }

        // If previous failure was NXDOMAIN and targeting the same unresolvable host, block it!
        if (
          this.navigationFailure.errorKind === "nxdomain" &&
          (!targetHost || targetHost === this.navigationFailure.hostname)
        ) {
          return {
            ok: false,
            error: `Domain ${this.navigationFailure.hostname} does not exist in DNS (NXDOMAIN). Do not retry without a different verified URL.`,
            errorCode: "NXDOMAIN",
            retryable: false,
            suggestions: this.navigationFailure.suggestions,
            note: this.navigationFailure.note,
          };
        }

        // If flow_state_invalid: block retrying the exact same broken URL, but allow navigating to service entry point
        if (
          this.navigationFailure.errorKind === "flow_state_invalid" &&
          targetUrl &&
          targetUrl === this.navigationFailure.url
        ) {
          return {
            ok: false,
            error: `Navigation to ${this.navigationFailure.url} failed with HTTP 400 (flow state invalid). Do not retry the exact internal flow URL; navigate to the service entry point instead.`,
            errorCode: "FLOW_STATE_INVALID",
            retryable: false,
            suggestions: this.navigationFailure.suggestions,
            note: this.navigationFailure.note,
          };
        }

        // TLS/DNS host-level errors block the broken hostname
        if (
          this.navigationFailure.errorKind === "tls_dns" &&
          (!targetHost || targetHost === this.navigationFailure.hostname)
        ) {
          return {
            ok: false,
            error: `Navigation to ${this.navigationFailure.hostname} failed (${this.navigationFailure.errorCode}) and is not retryable. Never bypass certificate warnings.`,
            errorCode: this.navigationFailure.errorCode,
            retryable: false,
            note: this.navigationFailure.note,
          };
        }

        // Non-retryable HTTP URL errors block repeating the exact same URL,
        // while allowing fallback navigation to other paths on the same host (/login, /directory, /public/mirror).
        if (
          !this.navigationFailure.retryable &&
          targetUrl &&
          targetUrl === this.navigationFailure.url
        ) {
          return {
            ok: false,
            error: `Navigation to ${this.navigationFailure.url} failed (${this.navigationFailure.errorCode}) and is not retryable.`,
            errorCode: this.navigationFailure.errorCode,
            retryable: false,
            note: this.navigationFailure.note,
          };
        }

        // Bounded retries for transient failures (max 2 attempts)
        if (
          this.navigationFailure.attempts >= 2 &&
          targetHost === this.navigationFailure.hostname &&
          (!targetUrl || targetUrl === this.navigationFailure.url)
        ) {
          return {
            ok: false,
            error: `Navigation to ${this.navigationFailure.url} reached retry limit (${this.navigationFailure.attempts} attempts).`,
            errorCode: "RETRY_LIMIT_EXCEEDED",
            retryable: false,
          };
        }
      }
      return undefined;
    }

    if (toolName === "browser_clear_origin_storage") {
      if (this.challengeDetected) {
        return {
          ok: false,
          retryable: false,
          errorCode: "STORAGE_CLEAR_FORBIDDEN_FOR_CHALLENGE",
          error:
            "Clearing cookies/storage while facing a security challenge is forbidden to prevent session revocation.",
          fallback: "request_takeover",
        };
      }
    }

    // 2. Check if browser_act is blocked
    if (toolName === "browser_act") {
      if (this.challengeDetected) {
        return {
          ok: false,
          completed: 0,
          blocked: true,
          challengeDetected: true,
          challengeType: this.challengeType,
          error: `Security challenge (${this.challengeType || "CAPTCHA"}) detected. Automated page actions paused.`,
          fallback: "request_takeover",
          note: "ตรวจพบแบบทดสอบความปลอดภัย (CAPTCHA) กรุณาใช้ request_takeover เพื่อให้ผู้ใช้ช่วยยืนยันบนหน้าจอ ห้ามส่งคำสั่งอัตโนมัติซ้ำ",
        };
      }
      if (this.cdpDisconnected) {
        return {
          ok: false,
          completed: 0,
          error: "Browser connection was interrupted (CDP disconnected). Reconnect or inspect page before retrying.",
          errorCode: "CDP_DISCONNECTED",
          retryable: true,
          note: "การเชื่อมต่อเบราว์เซอร์ขัดข้อง ควรเชื่อมต่อใหม่ก่อนลองส่งคำสั่งบนหน้าเว็บ",
        };
      }
      if (this.navigationFailure) {
        if (this.navigationFailure.errorKind === "flow_state_invalid") {
          return {
            ok: false,
            completed: 0,
            error: `Cannot perform page actions: current page is an invalid flow state (${this.navigationFailure.error}). Return to service entry point first.`,
            errorCode: "FLOW_STATE_INVALID",
            suggestions: this.navigationFailure.suggestions,
            note: this.navigationFailure.note,
          };
        }
        return {
          ok: false,
          completed: 0,
          error: `Cannot perform page actions: navigation to ${this.navigationFailure.url} failed (${this.navigationFailure.error}).`,
          errorCode: this.navigationFailure.errorCode,
        };
      }
      if (this.uncertain) {
        if (!this.reconciledSinceUncertain) {
          return {
            ...this.unresolvedResult(),
            errorCode: "UNCERTAIN_MUTATION_RECONCILE_REQUIRED",
            error: `Previous page action had an uncertain outcome (${this.lastError}). Inspect and reconcile actual page/server state via browser_snapshot or a read-only status URL before executing further actions.`,
          };
        }
        const requestedActions = Array.isArray(args?.actions)
          ? (args.actions as Array<{ ref?: unknown }>)
          : [];
        const duplicateRef = requestedActions
          .map((a) => String(a?.ref ?? ""))
          .find((ref) => ref && this.dispatchedRefsWhileUncertain.has(ref));
        if (duplicateRef) {
          return {
            ok: false,
            completed: 0,
            uncertain: true,
            errorCode: "DUPLICATE_MUTATION_PREVENTED",
            error: `Action ref ${duplicateRef} was already dispatched before transport loss. Do not replay the same mutating step.`,
          };
        }
        if (this.dispatchedRefsWhileUncertain.size > 0) {
          return undefined;
        }
        return this.unresolvedResult();
      }
      if (this.staleRefFailures > 0) {
        if (this.staleRefFailures >= 2) {
          return {
            ok: false,
            completed: 0,
            uncertain: false,
            fallback: "computer_act",
            error: `Page actions paused after repeated stale ref failures: ${this.lastError}`,
            note: "Do not retry browser_act or request another approval for it in this run. Use computer_observe to inspect the actual screen, then computer_act for the remaining work, or request_takeover if desktop tools are unavailable. Never repeat completed or uncertain actions. Do not claim the requested task succeeded without evidence.",
          };
        }
        if (!this.snapshotSinceStale) {
          return {
            ok: false,
            completed: 0,
            failedBeforeDispatch: true,
            retryable: true,
            error: "Element ref was stale before dispatch. Call browser_snapshot to get fresh element refs before retrying browser_act.",
            note: "Element ref was stale before dispatch. Call browser_snapshot to get fresh element refs and retry browser_act with the new ref.",
          };
        }
        return undefined;
      }
      if (this.failures < 2 && !this.uncertain) return undefined;
      return this.unresolvedResult();
    }

    // 3. Check if browser_clear_origin_storage is blocked (only one scoped clear per failure cycle, never for 429 or non-flow 400)
    if (toolName === "browser_clear_origin_storage") {
      if (
        this.navigationFailure?.errorKind === "rate_limited" ||
        this.navigationFailure?.errorKind === "rate_limited_deadline_exceeded" ||
        this.navigationFailure?.httpStatus === 429
      ) {
        return {
          ok: false,
          retryable: false,
          error:
            "Clearing cookies or origin storage to evade HTTP 429 rate limiting is forbidden. Respect Retry-After backoff instead.",
          errorCode: "COOKIE_CLEAR_FORBIDDEN_FOR_429",
        };
      }
      if (
        this.navigationFailure &&
        (this.navigationFailure.errorKind === "http_error" ||
          this.navigationFailure.errorKind === "http_bad_request" ||
          this.navigationFailure.errorKind === "api_bad_request" ||
          this.navigationFailure.errorKind === "insufficient_permission" ||
          this.navigationFailure.errorKind === "waf_denied")
      ) {
        return {
          ok: false,
          retryable: false,
          error: `Clearing origin storage is not permitted for ${this.navigationFailure.errorCode} (${this.navigationFailure.errorKind}) without evidenced corrupt auth/flow state.`,
          errorCode: "STORAGE_CLEAR_FORBIDDEN_FOR_ERROR_KIND",
        };
      }
      if (this.originStorageClearedForCurrentFailure) {
        return {
          ok: false,
          retryable: false,
          error:
            "Origin storage was already cleared once in this recovery cycle. Do not repeatedly clear storage; navigate to the service entry point or request_takeover if still blocked.",
          errorCode: "STORAGE_CLEAR_ALREADY_ATTEMPTED",
        };
      }
      return undefined;
    }

    // 4. Check if computer_act fallback is blocked (NXDOMAIN cannot be solved by desktop Chrome)
    if (toolName === "computer_act") {
      if (this.navigationFailure?.errorKind === "nxdomain") {
        const argsStr = JSON.stringify(args ?? "");
        if (argsStr.includes(this.navigationFailure.hostname)) {
          return {
            ok: false,
            completed: 0,
            error: `Cannot open ${this.navigationFailure.hostname}: domain does not exist in DNS (NXDOMAIN). Desktop fallback cannot resolve a non-existent DNS domain.`,
            errorCode: "NXDOMAIN",
          };
        }
      }
      return undefined;
    }

    // Any other specific tool (browser_snapshot, computer_observe, request_takeover, request_secret, etc.) is never blocked
    if (toolName !== undefined) {
      return undefined;
    }

    // Default check without toolName specified
    if (this.challengeDetected) {
      return this.unresolvedResult();
    }
    if (this.cdpDisconnected) {
      return this.unresolvedResult();
    }
    if (this.navigationFailure) {
      return this.unresolvedResult();
    }
    if (this.uncertain) return this.unresolvedResult();
    if (this.staleRefFailures >= 2) return this.unresolvedResult();
    if (this.failures < 2 && !this.uncertain) return undefined;
    return this.unresolvedResult();
  }

  unresolvedResult(): Record<string, unknown> | undefined {
    if (this.challengeDetected) {
      return {
        ok: false,
        completed: 0,
        uncertain: false,
        challengeDetected: true,
        challengeType: this.challengeType,
        errorCode: "CHALLENGE_DETECTED",
        errorKind: "challenge",
        retryable: false,
        ...(this.navigationFailure?.httpStatus !== undefined
          ? { httpStatus: this.navigationFailure.httpStatus }
          : {}),
        ...(this.navigationFailure?.httpStatusStatus !== undefined
          ? { httpStatusStatus: this.navigationFailure.httpStatusStatus }
          : {}),
        error: `Security challenge (${this.challengeType || "CAPTCHA"}) detected on page.`,
        fallback: "request_takeover",
        note: "ตรวจพบแบบทดสอบความปลอดภัย (CAPTCHA) ต้องให้ผู้ใช้ช่วยดำเนินการบนหน้าจอ",
      };
    }

    if (this.cdpDisconnected) {
      return {
        ok: false,
        completed: 0,
        uncertain: false,
        errorCode: "CDP_DISCONNECTED",
        error: "Browser connection was interrupted (CDP disconnected).",
        note: "การเชื่อมต่อเบราว์เซอร์ขัดข้อง",
      };
    }

    // If navigation failed and was never recovered by a successful navigation:
    if (this.navigationFailure) {
      const isNxdomain = this.navigationFailure.errorKind === "nxdomain";
      const isFlowInvalid = this.navigationFailure.errorKind === "flow_state_invalid";
      return {
        ok: false,
        completed: 0,
        uncertain: false,
        error: `Navigation to ${this.navigationFailure.url} failed: ${this.navigationFailure.error}`,
        errorCode: this.navigationFailure.errorCode,
        errorKind: this.navigationFailure.errorKind,
        hostname: this.navigationFailure.hostname,
        httpStatus: this.navigationFailure.httpStatus,
        httpStatusStatus: this.navigationFailure.httpStatusStatus,
        ...(this.navigationFailure.retryAfterMs !== undefined
          ? { retryAfterMs: this.navigationFailure.retryAfterMs }
          : {}),
        suggestions: this.navigationFailure.suggestions,
        retryable: this.navigationFailure.retryable,
        fallback: isNxdomain ? undefined : "computer_act",
        note:
          this.navigationFailure.note ||
          (isNxdomain
            ? "Cannot resolve domain name in DNS. Do not retry this URL or use desktop fallback to fix DNS."
            : isFlowInvalid
              ? "หน้าเว็บคืนค่า HTTP 400 flow state ไม่ถูกต้อง ควรกลับไปยัง entry point เริ่มต้นของบริการ"
              : "Page navigation failed and was not recovered."),
      };
    }

    if (this.failures === 0 && this.staleRefFailures === 0 && !this.uncertain) return undefined;
    const isStale =
      !this.uncertain &&
      this.staleRefFailures > 0 &&
      this.lastError.includes("Stale element ref");
    return {
      ok: false,
      completed: 0,
      uncertain: this.uncertain,
      error: `Page actions paused after a browser failure: ${this.lastError}`,
      fallback: isStale && this.staleRefFailures < 2 ? undefined : "computer_act",
      note: isStale && this.staleRefFailures < 2
        ? "Element ref was stale before dispatch. Call browser_snapshot to get fresh element refs and retry browser_act with the new ref."
        : "Do not retry browser_act or request another approval for it in this run. Use computer_observe to inspect the actual screen, then computer_act for the remaining work, or request_takeover if desktop tools are unavailable. Never repeat completed or uncertain actions. Do not claim the requested task succeeded without evidence.",
    };
  }
}
