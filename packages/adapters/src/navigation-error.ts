import dns from "node:dns/promises";

export type NavigationErrorKind =
  | "nxdomain"
  | "dns_timeout"
  | "connection_refused"
  | "connection_timeout"
  | "tls_error"
  | "http_error"
  | "dom_error"
  | "unknown";

export interface ClassifiedNavigationError {
  url: string;
  hostname: string;
  error: string;
  errorCode: string;
  errorKind: NavigationErrorKind;
  retryable: boolean;
  recoveryGuidance: string;
  dnsStatus?: string;
  suggestions?: string[];
}

export type DnsLookupFn = (
  hostname: string,
) => Promise<{ address?: string; code?: string }>;

const SENSITIVE_QUERY_KEY_PATTERN =
  /^(token|access_token|id_token|auth|key|apikey|api_key|secret|password|passwd|code|session|session_id|sig|signature|credential|client_secret)$/i;

/**
 * Strips userinfo and redacts sensitive query parameters from URLs before logging or reporting.
 */
export function sanitizeUrlForReporting(rawUrl: string): {
  sanitizedUrl: string;
  hostname: string;
} {
  try {
    const parsed = new URL(rawUrl);
    parsed.username = "";
    parsed.password = "";
    for (const [key, value] of Array.from(parsed.searchParams.entries())) {
      if (SENSITIVE_QUERY_KEY_PATTERN.test(key) || value.length > 64) {
        parsed.searchParams.set(key, "[REDACTED]");
      }
    }
    return {
      sanitizedUrl: parsed.toString(),
      hostname: parsed.hostname,
    };
  } catch {
    const stripped = rawUrl.split("?")[0] ?? rawUrl;
    return {
      sanitizedUrl: stripped,
      hostname: stripped.replace(/^[a-zA-Z]+:\/\//, "").split("/")[0]?.split(":")[0] ?? "",
    };
  }
}

/**
 * Checks DNS resolution for a hostname.
 */
export async function probeDnsHost(
  hostname: string,
  options?: { lookupFn?: DnsLookupFn; timeoutMs?: number },
): Promise<{ resolved: boolean; code?: string; address?: string }> {
  if (!hostname || hostname === "localhost" || hostname === "127.0.0.1") {
    return { resolved: true, address: "127.0.0.1" };
  }

  const lookupFn =
    options?.lookupFn ??
    (async (host: string) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? 3000);
      try {
        const res = await dns.lookup(host);
        return { address: res.address };
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        return { code: code || "ENOTFOUND" };
      } finally {
        clearTimeout(timeout);
      }
    });

  try {
    const result = await lookupFn(hostname);
    if (result.address) {
      return { resolved: true, address: result.address };
    }
    const code = result.code?.toUpperCase();
    if (code === "ENOTFOUND" || code === "ENODATA" || code === "NXDOMAIN") {
      return { resolved: false, code: "NXDOMAIN" };
    }
    if (code === "ETIMEOUT" || code === "ESERVFAIL" || code === "EREFUSED") {
      return { resolved: false, code: "DNS_TIMEOUT" };
    }
    return { resolved: false, code: code || "DNS_ERROR" };
  } catch {
    return { resolved: false, code: "NXDOMAIN" };
  }
}

/**
 * Classifies browser navigation errors into structured, actionable categories.
 */
export async function classifyNavigationError(
  rawUrl: string,
  rawError: string,
  options?: {
    lookupFn?: DnsLookupFn;
    dnsTimeoutMs?: number;
    suggestions?: string[];
  },
): Promise<ClassifiedNavigationError> {
  const { sanitizedUrl, hostname } = sanitizeUrlForReporting(rawUrl);
  const err = String(rawError || "").trim();
  const upper = err.toUpperCase();

  // 1. Host resolution failures (ERR_NAME_NOT_RESOLVED / ERR_NAME_RESOLUTION_FAILED)
  if (
    upper.includes("ERR_NAME_NOT_RESOLVED") ||
    upper.includes("ERR_NAME_RESOLUTION_FAILED") ||
    upper.includes("ENOTFOUND")
  ) {
    const dnsResult = await probeDnsHost(hostname, {
      lookupFn: options?.lookupFn,
      timeoutMs: options?.dnsTimeoutMs,
    });

    if (!dnsResult.resolved && dnsResult.code === "NXDOMAIN") {
      return {
        url: sanitizedUrl,
        hostname,
        error: err,
        errorCode: "NXDOMAIN",
        errorKind: "nxdomain",
        retryable: false,
        dnsStatus: "NXDOMAIN",
        suggestions: options?.suggestions,
        recoveryGuidance:
          "ไม่พบชื่อโดเมนใน DNS (NXDOMAIN) การใช้ desktop tools หรือ retry ไม่สามารถแก้ปัญหาโดเมนที่ไม่มีอยู่ได้ กรุณาตรวจสอบ URL หรือเลือกจากรายการที่ยืนยันแล้ว",
      };
    }

    if (!dnsResult.resolved && dnsResult.code === "DNS_TIMEOUT") {
      return {
        url: sanitizedUrl,
        hostname,
        error: err,
        errorCode: "DNS_TIMEOUT",
        errorKind: "dns_timeout",
        retryable: true,
        dnsStatus: "TIMEOUT",
        suggestions: options?.suggestions,
        recoveryGuidance: "การค้นหา DNS ใช้เวลานานเกินกำหนดหรือขัดข้องชั่วคราว สามารถลองซ้ำได้ตามขอบเขตที่กำหนด",
      };
    }

    return {
      url: sanitizedUrl,
      hostname,
      error: err,
      errorCode: "NAME_RESOLUTION_FAILED",
      errorKind: "nxdomain",
      retryable: false,
      dnsStatus: dnsResult.code ?? "UNRESOLVED",
      suggestions: options?.suggestions,
      recoveryGuidance: "ไม่สามารถแปลงชื่อโฮสต์ได้ กรุณาตรวจสอบ URL หรือเลือกจากรายการที่ยืนยันแล้ว",
    };
  }

  // 2. DNS timeout
  if (upper.includes("ERR_DNS_TIMED_OUT") || upper.includes("ETIMEOUT")) {
    return {
      url: sanitizedUrl,
      hostname,
      error: err,
      errorCode: "DNS_TIMEOUT",
      errorKind: "dns_timeout",
      retryable: true,
      dnsStatus: "TIMEOUT",
      recoveryGuidance: "DNS lookup timed out. Retry with bounded backoff.",
    };
  }

  // 3. Connection refused
  if (upper.includes("ERR_CONNECTION_REFUSED") || upper.includes("ECONNREFUSED")) {
    return {
      url: sanitizedUrl,
      hostname,
      error: err,
      errorCode: "CONNECTION_REFUSED",
      errorKind: "connection_refused",
      retryable: true,
      recoveryGuidance: "Server refused the connection. The service might be down on the destination port.",
    };
  }

  // 4. Connection timeout
  if (
    upper.includes("ERR_CONNECTION_TIMED_OUT") ||
    upper.includes("ERR_TIMED_OUT") ||
    upper.includes("ETIMEDOUT")
  ) {
    return {
      url: sanitizedUrl,
      hostname,
      error: err,
      errorCode: "CONNECTION_TIMEOUT",
      errorKind: "connection_timeout",
      retryable: true,
      recoveryGuidance: "Connection to server timed out. Check network path or retry with bounded backoff.",
    };
  }

  // 5. TLS / SSL certificate error
  if (
    upper.includes("ERR_CERT_") ||
    upper.includes("ERR_SSL_") ||
    upper.includes("CERTIFICATE") ||
    upper.includes("UNABLE_TO_VERIFY_LEAF_SIGNATURE")
  ) {
    return {
      url: sanitizedUrl,
      hostname,
      error: err,
      errorCode: "TLS_CERT_ERROR",
      errorKind: "tls_error",
      retryable: false,
      recoveryGuidance: "TLS certificate verification failed. Do not disable certificate validation.",
    };
  }

  // 6. HTTP errors (e.g. 403, 404, 500)
  const httpMatch = err.match(/\bHTTP\s+(\d{3})\b/i) || err.match(/\bstatus\s+(\d{3})\b/i);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    return {
      url: sanitizedUrl,
      hostname,
      error: err,
      errorCode: `HTTP_${status}`,
      errorKind: "http_error",
      retryable: status >= 500,
      recoveryGuidance: `HTTP response ${status} received from server.`,
    };
  }

  // 7. General fallback / unknown browser error
  return {
    url: sanitizedUrl,
    hostname,
    error: err,
    errorCode: "BROWSER_ERROR",
    errorKind: "unknown",
    retryable: false,
    recoveryGuidance: "Browser navigation failed. Inspect error and page state.",
  };
}
