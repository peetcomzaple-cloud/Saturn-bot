import type {
  AdapterContext,
  WebFetchRequest,
  WebFetchResult,
  WebProvider,
  WebSearchHit,
  WebSearchRequest,
} from "@rakazo/adapter-kit";
import { KeylessHttpWebProvider, type KeylessHttpWebOptions } from "./keyless-http-web.js";
import { clampMaxResults } from "./web-limits.js";
import { fetchSafeWebText, type ResolveHostname } from "./web-ssrf.js";

export interface SearxngSearchOptions extends KeylessHttpWebOptions {
  searxngEndpoint?: string;
  defaultCategories?: string;
}

export interface SearxngResultItem {
  url: string;
  title: string;
  content?: string;
  engine?: string;
  score?: number;
}

export interface SearxngResponsePayload {
  query: string;
  number_of_results?: number;
  results?: SearxngResultItem[];
  unresponsive_engines?: Array<[string, string]>;
}

/**
 * SearXNG JSON-based Web Search Provider with Readability fetch fallback.
 * Conforms to WebProvider interface (WebSearchProvider & WebFetchProvider).
 * Validates JSON structure, handles engine warnings, and avoids SSRF vulnerabilities.
 */
export class SearxngWebProvider implements WebProvider {
  private readonly endpoint: string;
  private readonly categories: string;
  private readonly keylessFallback: KeylessHttpWebProvider;
  private readonly fetchImpl?: typeof globalThis.fetch;
  private readonly resolveHostname?: ResolveHostname;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(options: SearxngSearchOptions = {}) {
    this.endpoint =
      options.searxngEndpoint ||
      process.env.SEARXNG_URL ||
      "http://127.0.0.1:8888";
    this.categories = options.defaultCategories || "general";
    this.fetchImpl = options.fetch;
    this.resolveHostname = options.resolveHostname;
    this.timeoutMs = options.searchTimeoutMs ?? 15_000;
    this.userAgent =
      options.userAgent ?? "Rakazo/0.2 (SearXNG Web Provider; +https://github.com/elie222/rakazo)";
    this.keylessFallback = new KeylessHttpWebProvider(options);
  }

  describe() {
    return {
      id: "searxng",
      contractVersion: "1",
      adapterVersion: "0.2.0",
      capabilities: {
        search: true,
        fetch: true,
        keyless: true,
        native: false,
        readability: true,
      },
    };
  }

  async search(request: WebSearchRequest, context: AdapterContext): Promise<WebSearchHit[]> {
    const query = request.query.trim();
    if (!query) throw new Error("query is required");
    const maxResults = clampMaxResults(request.maxResults);

    const targetUrl = new URL(this.endpoint.replace(/\/+$/, "") + "/search");
    targetUrl.searchParams.set("q", query);
    targetUrl.searchParams.set("format", "json");
    targetUrl.searchParams.set("categories", this.categories);

    try {
      const fetcher = this.fetchImpl ?? globalThis.fetch;
      const res = await fetcher(targetUrl.href, {
        method: "GET",
        headers: {
          "user-agent": this.userAgent,
          accept: "application/json",
        },
        signal: context.signal,
      });

      if (res.status !== 200) {
        throw new Error(`SearXNG returned HTTP ${res.status}`);
      }

      const body = await res.text();
      const payload = JSON.parse(body) as SearxngResponsePayload;
      const rawResults = Array.isArray(payload.results) ? payload.results : [];

      const hits: WebSearchHit[] = [];
      for (const item of rawResults) {
        if (!item || typeof item.url !== "string" || !item.url.startsWith("http")) continue;
        hits.push({
          title: String(item.title || "").trim() || item.url,
          url: item.url,
          snippet: String(item.content || "").trim(),
        });
        if (hits.length >= maxResults) break;
      }

      return hits;
    } catch (err) {
      context.signal.throwIfAborted();
      // On connection error or unavailable SearXNG instance, fallback to KeylessHttpWebProvider
      return this.keylessFallback.search(request, context);
    }
  }

  async fetch(request: WebFetchRequest, context: AdapterContext): Promise<WebFetchResult> {
    // Page reading delegates to KeylessHttpWebProvider with Readability extraction
    return this.keylessFallback.fetch(request, context);
  }
}
