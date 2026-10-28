import type {
  AdapterContext,
  BrowserActRequest,
  BrowserActResult,
  BrowserClearOriginStorageRequest,
  BrowserClearOriginStorageResult,
  BrowserNavigateRequest,
  BrowserNavigateResult,
  BrowserProvider,
  BrowserSnapshotRequest,
  BrowserSnapshotResult,
  BrowserStorageType,
  ComputerRef,
} from "@rakazo/adapter-kit";
import { getTakeoverControlGate } from "./action-barrier.js";
import { PageBrowserSessionStore, pageBrowserSessionKey } from "./page-browser-session.js";
import { fetchSafeWebText } from "./web-ssrf.js";

const DEFAULT_BROWSER_STORAGE_TYPES: BrowserStorageType[] = [
  "cookies",
  "local_storage",
  "indexeddb",
  "cache_storage",
  "service_workers",
];

export interface FakeBrowserProviderOptions {
  /** Inject HTML for a URL without hitting the network (offline tests). */
  pages?: Record<string, { title?: string; html: string }>;
  /** Optional fetch override for navigate. */
  fetch?: typeof globalThis.fetch;
}

/**
 * In-process page browser for offline tests and keyless core. Not a hosted
 * browser vendor: sessions are keyed by computer id so tools stay computer-scoped.
 */
export class FakeBrowserProvider implements BrowserProvider {
  readonly sessions = new PageBrowserSessionStore();
  private readonly pages: Record<string, { title?: string; html: string }>;
  private readonly fetchImpl?: typeof globalThis.fetch;
  navigateError?: Error;
  snapshotError?: Error;
  actError?: Error;
  /** When set, every method returns computer_act fallback (fallback-path tests). */
  forceFallback?: string;

  constructor(options: FakeBrowserProviderOptions = {}) {
    this.pages = options.pages ?? {};
    this.fetchImpl = options.fetch;
  }

  describe() {
    return {
      id: "fake",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        page: true,
        refs: true,
        keyless: true,
      },
    };
  }

  async navigate(
    computer: ComputerRef,
    request: BrowserNavigateRequest,
    context: AdapterContext,
  ): Promise<BrowserNavigateResult> {
    if (this.forceFallback) {
      return {
        url: request.url,
        title: "",
        fallback: "computer_act",
        error: this.forceFallback,
      };
    }
    if (this.navigateError) throw this.navigateError;
    const url = request.url.trim();
    if (!url) {
      return { url: "", title: "", fallback: "computer_act", error: "url is required" };
    }
    const session = this.sessions.get(pageBrowserSessionKey(computer, context), {
      takeoverGate: computer.id ? getTakeoverControlGate(computer.id) : undefined,
    });
    const seeded = this.pages[url] ?? this.pages[stripHash(url)];
    if (seeded) {
      const html = seeded.title ? ensureTitle(seeded.html, seeded.title) : seeded.html;
      return session.load(url, html);
    }
    try {
      const { url: finalUrl, body } = await fetchSafeWebText(url, {
        fetch: this.fetchImpl,
        signal: request.signal ?? context.signal,
      });
      return session.load(finalUrl, body);
    } catch (error) {
      return {
        url,
        title: "",
        fallback: "computer_act",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async snapshot(
    computer: ComputerRef,
    _request: BrowserSnapshotRequest,
    context: AdapterContext,
  ): Promise<BrowserSnapshotResult> {
    if (this.forceFallback) {
      return {
        url: "",
        title: "",
        tree: "",
        elements: [],
        fallback: "computer_act",
        error: this.forceFallback,
      };
    }
    if (this.snapshotError) throw this.snapshotError;
    return this.sessions
      .get(pageBrowserSessionKey(computer, context), {
        takeoverGate: computer.id ? getTakeoverControlGate(computer.id) : undefined,
      })
      .snapshot();
  }

  async act(
    computer: ComputerRef,
    request: BrowserActRequest,
    context: AdapterContext,
  ): Promise<BrowserActResult> {
    if (this.forceFallback) {
      return {
        ok: false,
        completed: 0,
        url: "",
        title: "",
        fallback: "computer_act",
        error: this.forceFallback,
      };
    }
    if (this.actError) throw this.actError;
    const session = this.sessions.get(pageBrowserSessionKey(computer, context), {
      takeoverGate: computer.id ? getTakeoverControlGate(computer.id) : undefined,
    });
    if (!request.actions?.length) {
      return {
        ok: false,
        completed: 0,
        url: session.url,
        title: session.title,
        error: "actions is required",
        fallback: "computer_act",
      };
    }
    return session.act(request.actions);
  }

  async clearOriginStorage(
    _computer: ComputerRef,
    request: BrowserClearOriginStorageRequest,
    _context: AdapterContext,
  ): Promise<BrowserClearOriginStorageResult> {
    if (this.forceFallback) {
      return {
        ok: false,
        origin: request.origin,
        fallback: "computer_act",
        error: this.forceFallback,
      };
    }
    let parsed: URL;
    try {
      parsed = new URL(request.origin);
    } catch {
      return {
        ok: false,
        origin: request.origin,
        fallback: "computer_act",
        error: "origin must be a valid HTTP(S) origin",
      };
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      (parsed.pathname !== "" && parsed.pathname !== "/") ||
      parsed.search ||
      parsed.hash
    ) {
      return {
        ok: false,
        origin: request.origin,
        fallback: "computer_act",
        error: "origin must be an HTTP(S) origin without path, query, fragment, or credentials",
      };
    }
    return {
      ok: true,
      origin: parsed.origin,
      ...(request.storageKey ? { storageKey: request.storageKey } : {}),
      clearedStorageTypes: request.storageTypes
        ? [...request.storageTypes]
        : [...DEFAULT_BROWSER_STORAGE_TYPES],
      clearedSessionStorage: request.includeSessionStorage === true,
      includeSubdomainSharedCookies: request.includeSubdomainSharedCookies === true,
      deletedCookies: 0,
    };
  }
}

function stripHash(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return url;
  }
}

function ensureTitle(html: string, title: string): string {
  if (/<title[\s>]/i.test(html)) {
    return html.replace(/<title[^>]*>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);
  }
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1><title>${escapeHtml(title)}</title>`);
  }
  return `<!doctype html><html><head><title>${escapeHtml(title)}</title></head><body>${html}</body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
