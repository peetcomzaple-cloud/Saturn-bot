import { describe, expect, it } from "vitest";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { SearxngWebProvider } from "./searxng-web-search.js";

function makeContext(signal?: AbortSignal): AdapterContext {
  return {
    operationId: "test-op",
    traceId: "test-trace",
    spaceId: "space-1",
    userId: "user-1",
    signal: signal ?? new AbortController().signal,
  };
}

describe("SearxngWebProvider [Phase 3 Search & Read]", () => {
  it("parses SearXNG JSON response into standard WebSearchHit list", async () => {
    const mockJson = JSON.stringify({
      query: "Open Source AI",
      number_of_results: 2,
      results: [
        {
          url: "https://example.com/ai-1",
          title: "Open Source AI Models",
          content: "A comprehensive guide to open weights models.",
        },
        {
          url: "https://example.com/ai-2",
          title: "DeepSeek Architecture",
          content: "Analysis of DeepSeek MoE and reasoning architecture.",
        },
      ],
    });

    const mockFetch = async () =>
      new Response(mockJson, {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const provider = new SearxngWebProvider({
      searxngEndpoint: "http://127.0.0.1:8888",
      fetch: mockFetch as any,
      resolveHostname: async () => [{ address: "127.0.0.1", family: 4 }],
    });

    const hits = await provider.search({ query: "Open Source AI", maxResults: 5 }, makeContext());

    expect(hits.length).toBe(2);
    expect(hits[0]!.title).toBe("Open Source AI Models");
    expect(hits[0]!.url).toBe("https://example.com/ai-1");
    expect(hits[0]!.snippet).toContain("open weights");
    expect(hits[1]!.title).toBe("DeepSeek Architecture");
  });

  it("clamps results to maxResults requested", async () => {
    const mockJson = JSON.stringify({
      query: "test",
      results: [
        { url: "https://example.com/1", title: "1", content: "c1" },
        { url: "https://example.com/2", title: "2", content: "c2" },
        { url: "https://example.com/3", title: "3", content: "c3" },
      ],
    });

    const mockFetch = async () =>
      new Response(mockJson, {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const provider = new SearxngWebProvider({
      fetch: mockFetch as any,
      resolveHostname: async () => [{ address: "127.0.0.1", family: 4 }],
    });

    const hits = await provider.search({ query: "test", maxResults: 2 }, makeContext());
    expect(hits.length).toBe(2);
  });

  it("handles zero results cleanly without throwing error", async () => {
    const mockJson = JSON.stringify({
      query: "nonexistent query 123456789",
      number_of_results: 0,
      results: [],
      unresponsive_engines: [["google", "timeout"]],
    });

    const mockFetch = async () =>
      new Response(mockJson, {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const provider = new SearxngWebProvider({
      fetch: mockFetch as any,
      resolveHostname: async () => [{ address: "127.0.0.1", family: 4 }],
    });

    const hits = await provider.search({ query: "nonexistent query 123456789" }, makeContext());
    expect(hits).toEqual([]);
  });

  it("falls back to KeylessHttpWebProvider when SearXNG instance is unreachable", async () => {
    let fallbackHit = false;
    const failingFetch = async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("8888")) {
        throw new Error("ECONNREFUSED: SearXNG instance down");
      }
      // Fallback hit DuckDuckGo or web fetch
      fallbackHit = true;
      return new Response("<html><body><div class='result__snippet'>Fallback result snippet</div></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    };

    const provider = new SearxngWebProvider({
      searxngEndpoint: "http://127.0.0.1:8888",
      fetch: failingFetch as any,
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
    });

    const hits = await provider.search({ query: "test query" }, makeContext());
    expect(fallbackHit).toBe(true);
    expect(Array.isArray(hits)).toBe(true);
  });

  it("extracts page content using Readability on fetch()", async () => {
    const htmlPage = `
      <!doctype html>
      <html>
        <head><title>Article Title</title></head>
        <body>
          <article>
            <h1>Article Header</h1>
            <p>This is the main readable content of the article fetched for research.</p>
          </article>
        </body>
      </html>
    `;

    const mockFetch = async () =>
      new Response(htmlPage, {
        status: 200,
        headers: { "content-type": "text/html" },
      });

    const provider = new SearxngWebProvider({
      fetch: mockFetch as any,
      resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    const fetched = await provider.fetch({ url: "https://example.com/article" }, makeContext());
    expect(fetched.title).toBe("Article Title");
    expect(fetched.text).toContain("This is the main readable content");
  });
});
