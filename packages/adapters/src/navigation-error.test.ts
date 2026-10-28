import { describe, expect, it } from "vitest";
import {
  classifyNavigationError,
  probeDnsHost,
  sanitizeUrlForReporting,
} from "./navigation-error.js";

describe("navigation error classification and sanitization", () => {
  it("sanitizes URLs and redacts sensitive query parameters", () => {
    const raw = "https://user:pass@example.com/login?token=secret123&session_id=abc456&safe=value";
    const { sanitizedUrl, hostname } = sanitizeUrlForReporting(raw);
    expect(hostname).toBe("example.com");
    expect(sanitizedUrl).not.toContain("pass");
    expect(sanitizedUrl).not.toContain("secret123");
    expect(sanitizedUrl).toContain("token=%5BREDACTED%5D");
    expect(sanitizedUrl).toContain("safe=value");
  });

  it("probes DNS using mock lookup", async () => {
    const resolved = await probeDnsHost("valid.test", {
      lookupFn: async () => ({ address: "192.168.1.1" }),
    });
    expect(resolved.resolved).toBe(true);
    expect(resolved.address).toBe("192.168.1.1");

    const nxdomain = await probeDnsHost("notfound.test", {
      lookupFn: async () => ({ code: "ENOTFOUND" }),
    });
    expect(nxdomain.resolved).toBe(false);
    expect(nxdomain.code).toBe("NXDOMAIN");

    const timeout = await probeDnsHost("timeout.test", {
      lookupFn: async () => ({ code: "ETIMEOUT" }),
    });
    expect(timeout.resolved).toBe(false);
    expect(timeout.code).toBe("DNS_TIMEOUT");
  });

  it("classifies ERR_NAME_NOT_RESOLVED as non-retryable nxdomain", async () => {
    const classified = await classifyNavigationError(
      "https://flick.mdcu.ac.th/login",
      "net::ERR_NAME_NOT_RESOLVED",
      {
        lookupFn: async () => ({ code: "ENOTFOUND" }),
        suggestions: ["https://flick.docchula.com/"],
      },
    );

    expect(classified.errorKind).toBe("nxdomain");
    expect(classified.errorCode).toBe("NXDOMAIN");
    expect(classified.retryable).toBe(false);
    expect(classified.hostname).toBe("flick.mdcu.ac.th");
    expect(classified.suggestions).toEqual(["https://flick.docchula.com/"]);
    expect(classified.recoveryGuidance).toMatch(/NXDOMAIN/);
  });

  it("classifies connection refused as retryable", async () => {
    const classified = await classifyNavigationError(
      "https://example.test/service",
      "net::ERR_CONNECTION_REFUSED",
    );
    expect(classified.errorKind).toBe("connection_refused");
    expect(classified.retryable).toBe(true);
  });

  it("classifies TLS certificate error as non-retryable", async () => {
    const classified = await classifyNavigationError(
      "https://example.test/service",
      "net::ERR_CERT_COMMON_NAME_INVALID",
    );
    expect(classified.errorKind).toBe("tls_error");
    expect(classified.retryable).toBe(false);
  });

  it("classifies HTTP 404 as non-retryable and HTTP 503 as retryable", async () => {
    const err404 = await classifyNavigationError("https://example.test/404", "HTTP 404 Not Found");
    expect(err404.errorKind).toBe("http_error");
    expect(err404.errorCode).toBe("HTTP_404");
    expect(err404.retryable).toBe(false);

    const err503 = await classifyNavigationError(
      "https://example.test/503",
      "HTTP 503 Service Unavailable",
    );
    expect(err503.errorKind).toBe("http_error");
    expect(err503.errorCode).toBe("HTTP_503");
    expect(err503.retryable).toBe(true);
  });
});
