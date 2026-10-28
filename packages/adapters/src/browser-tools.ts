import type {
  AdapterContext,
  BrowserActKind,
  BrowserActStep,
  BrowserClearOriginStorageRequest,
  BrowserProvider,
  BrowserStorageType,
  ComputerRef,
} from "@rakazo/adapter-kit";
import type { LoginField } from "./bot-secrets.js";
import { redactConnectorPayload } from "./connector-safety.js";
import { classifyHttp400, classifyHttp401Or403 } from "./browser-recovery.js";
import { formatThaiDnsFailureMessage } from "./verified-urls.js";

const MAX_BROWSER_ACTIONS = 24;
const ALLOWED_STORAGE_TYPES = new Set<BrowserStorageType>([
  "cookies",
  "local_storage",
  "indexeddb",
  "cache_storage",
  "service_workers",
]);

/** Fills a saved website login by name; the model never supplies or sees the value. */
export type SecretFillStep = {
  kind: "fill_secret";
  ref: string;
  secret?: string;
  field: LoginField;
};
export type BrowserActInput = BrowserActStep | SecretFillStep;
export type ResolveSecretFill =
  | ((step: SecretFillStep) => Promise<{ text: string; origin: string } | { error: string }>)
  | ((step: {
      kind?: "fill_secret";
      ref?: string;
      secret?: string;
      field: "username" | "password";
    }) => Promise<{ text: string; origin: string } | { error: string }>);

export interface BrowserNavigateToolOptions {
  spaceId?: string;
  findVerifiedUrls?: (spaceId: string, keyword: string) => Promise<string[]>;
}

export function isBrowserNoOp(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  return r.noOp === true || (r.ok === true && r.stateChanged === false && Number(r.completed ?? 0) === 0);
}

export function isBrowserPreDispatchFailure(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  return (
    r.failedBeforeDispatch === true ||
    (!r.uncertain && Number(r.completed ?? 0) === 0 && Boolean(r.error))
  );
}

export function isBrowserUncertain(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  return r.uncertain === true || (r.ok === false && Number(r.completed ?? 0) > 0);
}

export async function browserNavigateFromTool(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  args: Record<string, unknown>,
  options?: BrowserNavigateToolOptions,
) {
  const url = String(args.url ?? "").trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
      return {
        error: "An HTTP(S) URL without embedded credentials is required",
        fallback: "computer_act" as const,
      };
    }
  } catch {
    return {
      error: "An HTTP(S) URL without embedded credentials is required",
      fallback: "computer_act" as const,
    };
  }

  try {
    const result = await browser.navigate(computer, { url, signal: context.signal }, context);
    const errText = typeof result.error === "string" ? result.error : "";
    const isNxdomain =
      errText.includes("ERR_NAME_NOT_RESOLVED") ||
      errText.includes("ERR_NAME_RESOLUTION_FAILED") ||
      errText.includes("ENOTFOUND") ||
      (result as { errorCode?: unknown }).errorCode === "NXDOMAIN";
    if (isNxdomain) {
      const hostname = parsed.hostname;
      let suggestions: string[] | undefined;
      if (options?.findVerifiedUrls && options.spaceId) {
        const keyword =
          hostname
            .toLowerCase()
            .split(/[.-]/)
            .find((tok) => tok.length > 2 && !["www", "com", "net", "org", "co", "th", "ac"].includes(tok)) ??
          hostname;
        const found = await options.findVerifiedUrls(options.spaceId, keyword).catch(() => []);
        if (found.length > 0) suggestions = found;
      }
      const { fallback: _dropFallback, ...rest } = result;
      return {
        ...rest,
        ok: false,
        url: result.url || url,
        hostname,
        error: errText || `net::ERR_NAME_NOT_RESOLVED (${hostname})`,
        errorCode: "NXDOMAIN",
        errorKind: "nxdomain",
        retryable: false,
        ...(suggestions ? { suggestions } : {}),
        note: formatThaiDnsFailureMessage({ hostname, suggestions }),
      };
    }
    if (typeof result.httpStatus === "number" && result.httpStatus >= 400) {
      const status = result.httpStatus;
      const httpStatusStatus = result.httpStatusStatus ?? "known";
      if (status === 400) {
        const c400 = classifyHttp400({
          url: result.url || url,
          title: result.title,
          error: result.error,
          redirectChain: result.redirectChain,
        });
        return {
          ...formatBrowserResult(result),
          ok: false,
          httpStatusStatus,
          error: result.error || `HTTP 400 Bad Request (${result.url || url})`,
          errorCode: c400.errorCode,
          errorKind: c400.errorKind,
          retryable: c400.retryable,
          ...(c400.suggestions ? { suggestions: c400.suggestions } : {}),
          note: c400.note,
        };
      }
      if (status === 429) {
        return {
          ...formatBrowserResult(result),
          ok: false,
          httpStatusStatus,
          error: result.error || `HTTP 429 Too Many Requests (${result.url || url})`,
          errorCode: "HTTP_429",
          errorKind: "rate_limited",
          retryable: true,
          note:
            result.retryAfterMs !== undefined
              ? `Rate limited (HTTP 429). Wait ${Math.ceil(result.retryAfterMs / 1000)}s (Retry-After) before retrying. Do not clear cookies.`
              : "Rate limited (HTTP 429). Back off before retrying. Do not clear cookies.",
        };
      }
      if (status === 401 || status === 403) {
        const c403 = classifyHttp401Or403({
          status,
          url: result.url || url,
          title: result.title,
          error: result.error,
          challengeDetected: result.challengeDetected,
        });
        return {
          ...formatBrowserResult(result),
          ok: false,
          httpStatusStatus,
          error: result.error || `HTTP ${status} (${result.url || url})`,
          errorCode: c403.errorCode,
          errorKind: c403.errorKind,
          retryable: c403.retryable,
          note: c403.note,
        };
      }
      if (status >= 500) {
        return {
          ...formatBrowserResult(result),
          ok: false,
          httpStatusStatus,
          error: result.error || `HTTP ${status} Server Error (${result.url || url})`,
          errorCode: `HTTP_${status}`,
          errorKind: "server_error",
          retryable: true,
        };
      }
      return {
        ...formatBrowserResult(result),
        ok: false,
        httpStatusStatus,
        error: result.error || `HTTP ${status} (${result.url || url})`,
        errorCode: `HTTP_${status}`,
        errorKind: "http_error",
        retryable: false,
      };
    }
    return formatBrowserResult(result);
  } catch (error) {
    context.signal.throwIfAborted();
    const rawMsg = error instanceof Error ? error.message : String(error);
    const isNxdomain =
      rawMsg.includes("ERR_NAME_NOT_RESOLVED") ||
      rawMsg.includes("ERR_NAME_RESOLUTION_FAILED") ||
      rawMsg.includes("ENOTFOUND");
    if (isNxdomain) {
      const hostname = parsed.hostname;
      let suggestions: string[] | undefined;
      if (options?.findVerifiedUrls && options.spaceId) {
        const keyword =
          hostname
            .toLowerCase()
            .split(/[.-]/)
            .find((tok) => tok.length > 2 && !["www", "com", "net", "org", "co", "th", "ac"].includes(tok)) ??
          hostname;
        const found = await options.findVerifiedUrls(options.spaceId, keyword).catch(() => []);
        if (found.length > 0) suggestions = found;
      }
      return {
        ok: false,
        url,
        hostname,
        error: rawMsg,
        errorCode: "NXDOMAIN",
        errorKind: "nxdomain",
        retryable: false,
        ...(suggestions ? { suggestions } : {}),
        note: formatThaiDnsFailureMessage({ hostname, suggestions }),
      };
    }
    return {
      error: rawMsg,
      fallback: "computer_act" as const,
    };
  }
}

export async function browserSnapshotFromTool(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  args: Record<string, unknown>,
) {
  void args;
  try {
    const result = await browser.snapshot(computer, { signal: context.signal }, context);
    return formatBrowserResult(result);
  } catch (error) {
    context.signal.throwIfAborted();
    return {
      error: error instanceof Error ? error.message : String(error),
      fallback: "computer_act" as const,
    };
  }
}

export async function browserActFromTool(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  args: Record<string, unknown>,
  options: { resolveSecretFill?: ResolveSecretFill; redactions?: () => string[] } = {},
) {
  try {
    const actions: BrowserActStep[] = [];
    // Resolve every saved login before acting, so a missing one cannot leave a half-filled form.
    for (const step of parseBrowserActions(args.actions)) {
      if (step.kind !== "fill_secret") {
        actions.push(step);
        continue;
      }
      const resolved = options.resolveSecretFill
        ? await options.resolveSecretFill(step as never)
        : { error: "Saved logins are unavailable here." };
      if ("error" in resolved) return { ok: false, completed: 0, error: resolved.error };
      actions.push({ kind: "fill", ref: step.ref, text: resolved.text, origin: resolved.origin });
    }
    const result = await browser.act(computer, { actions, signal: context.signal }, context);
    return redactConnectorPayload(formatBrowserResult(result), options.redactions?.() ?? []);
  } catch (error) {
    context.signal.throwIfAborted();
    const rawError = error instanceof Error ? error.message : String(error);
    const safeError = (
      redactConnectorPayload({ error: rawError }, options.redactions?.() ?? []) as {
        error?: unknown;
      }
    ).error;
    return {
      ok: false,
      uncertain: true,
      error: typeof safeError === "string" ? safeError : rawError,
      fallback: "computer_act" as const,
    };
  }
}

export function parseBrowserClearOriginStorageRequest(
  args: Record<string, unknown>,
): Omit<BrowserClearOriginStorageRequest, "signal"> {
  const rawOrigin = String(args.origin ?? "").trim();
  if (!rawOrigin) {
    throw new Error("browser_clear_origin_storage requires an HTTP(S) origin");
  }
  let parsed: URL;
  try {
    parsed = new URL(rawOrigin);
  } catch {
    throw new Error("browser_clear_origin_storage requires a valid HTTP(S) origin");
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname) {
    throw new Error("browser_clear_origin_storage requires an HTTP(S) origin without credentials");
  }
  const origin = parsed.origin;
  let storageKey: string | undefined;
  if (args.storageKey !== undefined) {
    const trimmedKey = String(args.storageKey).trim();
    if (!trimmedKey) {
      throw new Error("browser_clear_origin_storage storageKey must be non-empty when provided");
    }
    storageKey = trimmedKey;
  }
  let storageTypes: BrowserStorageType[] | undefined;
  if (args.storageTypes !== undefined) {
    if (!Array.isArray(args.storageTypes) || args.storageTypes.length === 0) {
      throw new Error("browser_clear_origin_storage storageTypes must be a non-empty array");
    }
    storageTypes = args.storageTypes.map((item) => {
      const value = String(item ?? "").trim() as BrowserStorageType;
      if (!ALLOWED_STORAGE_TYPES.has(value)) {
        throw new Error(`Unsupported browser storage type: ${value}`);
      }
      return value;
    });
  }
  return {
    origin,
    ...(storageKey !== undefined ? { storageKey } : {}),
    ...(storageTypes !== undefined ? { storageTypes } : {}),
    ...(args.includeSessionStorage === true ? { includeSessionStorage: true } : {}),
    ...(args.includeSubdomainSharedCookies === true ? { includeSubdomainSharedCookies: true } : {}),
  };
}

export async function browserClearOriginStorageFromTool(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  args: Record<string, unknown>,
) {
  let request: Omit<BrowserClearOriginStorageRequest, "signal">;
  try {
    request = parseBrowserClearOriginStorageRequest(args);
  } catch (error) {
    return {
      ok: false,
      origin: String(args.origin ?? ""),
      clearedStorageTypes: [] as BrowserStorageType[],
      deletedCookies: 0,
      failedBeforeDispatch: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!browser.clearOriginStorage) {
    return {
      ok: false,
      origin: request.origin,
      clearedStorageTypes: [] as BrowserStorageType[],
      deletedCookies: 0,
      error: "Scoped origin storage clearing is unavailable on this browser provider",
      fallback: "computer_act" as const,
    };
  }
  try {
    const result = await browser.clearOriginStorage(
      computer,
      { ...request, signal: context.signal },
      context,
    );
    return formatBrowserResult(result);
  } catch (error) {
    context.signal.throwIfAborted();
    return {
      ok: false,
      origin: request.origin,
      clearedStorageTypes: [] as BrowserStorageType[],
      deletedCookies: 0,
      error: error instanceof Error ? error.message : String(error),
      fallback: "computer_act" as const,
    };
  }
}

export function parseBrowserActions(value: unknown): BrowserActInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("browser_act requires at least one action");
  }
  if (value.length > MAX_BROWSER_ACTIONS) {
    throw new Error(`browser_act accepts at most ${MAX_BROWSER_ACTIONS} actions`);
  }
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`browser_act action ${index} must be an object`);
    }
    const action = raw as Record<string, unknown>;
    const kind = String(action.kind ?? "") as BrowserActKind | "fill_secret";
    if (kind !== "click" && kind !== "fill" && kind !== "type" && kind !== "fill_secret") {
      throw new Error(`browser_act action ${index} has unsupported kind`);
    }
    const ref = String(action.ref ?? "").trim();
    if (!ref) throw new Error(`browser_act action ${index} requires ref`);
    if (kind === "fill_secret") {
      const field = action.field;
      if (field !== "username" && field !== "password" && field !== "totp") {
        throw new Error("browser_act fill_secret field must be username or password (or totp)");
      }
      if (action.secret !== undefined) {
        const secret = String(action.secret).trim();
        if (!secret) {
          throw new Error("browser_act fill_secret requires non-empty secret");
        }
        return { kind, ref, secret, field };
      }
      return { kind, ref, field };
    }
    if (kind === "fill" || kind === "type") {
      if (typeof action.text !== "string") {
        throw new Error(`browser_act ${kind} requires text`);
      }
      return { kind, ref, text: String(action.text) };
    }
    return { kind, ref };
  });
}

function formatBrowserResult<T extends { fallback?: "computer_act"; error?: string }>(result: T) {
  if (result.fallback === "computer_act") {
    return {
      ...result,
      note: "Page browser could not complete this step. Inspect the current state before continuing with computer_act if available, otherwise request_takeover. Do not replay completed or uncertain actions.",
    };
  }
  return result;
}

export async function browserTabListFromTool(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  _args: Record<string, unknown>,
) {
  if (browser.tabList) {
    try {
      const res = await browser.tabList(computer, context);
      return res;
    } catch (error) {
      context.signal.throwIfAborted();
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { ok: false, error: "tabList not supported by browser provider" };
}

export async function browserTabCloseFromTool(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  args: Record<string, unknown>,
) {
  if (browser.tabClose) {
    try {
      const res = await browser.tabClose(
        computer,
        {
          targetId: typeof args.targetId === "string" ? args.targetId : undefined,
          urlIncludes: typeof args.urlIncludes === "string" ? args.urlIncludes : undefined,
          titleIncludes: typeof args.titleIncludes === "string" ? args.titleIncludes : undefined,
          allowLastTab: typeof args.allowLastTab === "boolean" ? args.allowLastTab : undefined,
        },
        context,
      );
      return res;
    } catch (error) {
      context.signal.throwIfAborted();
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { ok: false, error: "tabClose not supported by browser provider" };
}

