import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { FakeWebProvider } from "./fake-web.js";
import {
  extractReadableText,
  KeylessHttpWebProvider,
  parseDuckDuckGoResults,
} from "./keyless-http-web.js";
import { clampMaxChars, clampMaxResults } from "./web-limits.js";
import { createWebProvider, resolveWebProviderKind } from "./web-provider-factory.js";
import { webFetchFromTool, webSearchFromTool } from "./web-tools.js";

const ctx: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const publicResolver = async () => [{ address: "203.0.113.10", family: 4 as const }];

describe("web provider factory", () => {
  it("defaults to keyless-http", () => {
    expect(resolveWebProviderKind({})).toBe("keyless-http");
    expect(createWebProvider().describe().id).toBe("keyless-http");
    expect(createWebProvider("fake").describe().id).toBe("fake");
  });
});

describe("keyless HTTP web provider", () => {
  it("searches via the HTML backend without a vendor API key", async () => {
    const html = `
      <div class="result">
        <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.test%2Fa">Alpha</a>
        <a class="result__snippet">Snippet A</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://example.test/b">Beta</a>
        <div class="result__snippet">Snippet B</div>
      </div>
    `;
    const fetchMock: typeof fetch = async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    const provider = new KeylessHttpWebProvider({
      fetch: fetchMock,
      resolveHostname: publicResolver,
    });
    const results = await provider.search({ query: "alpha", maxResults: 5 }, ctx);
    expect(results).toEqual([
      { title: "Alpha", url: "https://example.test/a", snippet: "Snippet A" },
      { title: "Beta", url: "https://example.test/b", snippet: "Snippet B" },
    ]);
  });

  it("fetches readable page text with truncation", async () => {
    const long = "word ".repeat(100);
    const html = `<html><head><title>Doc</title></head><body><article><p>${long}</p></article></body></html>`;
    const fetchMock: typeof fetch = async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    const provider = new KeylessHttpWebProvider({
      fetch: fetchMock,
      resolveHostname: publicResolver,
    });
    const result = await provider.fetch({ url: "https://example.test/doc", maxChars: 120 }, ctx);
    expect(result.title).toBeTruthy();
    expect(result.url).toBe("https://example.test/doc");
    expect(result.truncated).toBe(true);
    expect(result.text.endsWith("[Content truncated]")).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(120 + "\n\n[Content truncated]".length);
  });

  it("falls back to HTML strip when Readability finds nothing", () => {
    const extracted = extractReadableText(
      "<html><title>Plain</title><body><div>just text here</div></body></html>",
      "https://example.test/",
    );
    expect(extracted.title).toBe("Plain");
    expect(extracted.text).toContain("just text here");
  });

  it("parses HTML search results with a cap", () => {
    const html = Array.from({ length: 12 }, (_, i) => {
      return `<div class="result"><a class="result__a" href="https://example.test/${i}">T${i}</a><div class="result__snippet">S${i}</div></div>`;
    }).join("");
    expect(parseDuckDuckGoResults(html, 3)).toHaveLength(3);
  });
});

describe("web tool apply with fake provider", () => {
  it("returns injected search and fetch results", async () => {
    const fake = new FakeWebProvider();
    fake.searchHits = [
      { title: "One", url: "https://example.test/1", snippet: "s1" },
      { title: "Two", url: "https://example.test/2", snippet: "s2" },
    ];
    fake.fetchResult = {
      url: "https://example.test/1",
      title: "One",
      text: "Body text",
      truncated: false,
    };

    await expect(webSearchFromTool(fake, ctx, { query: "q", maxResults: 1 })).resolves.toEqual({
      results: [{ title: "One", url: "https://example.test/1", snippet: "s1" }],
    });
    expect(fake.lastSearch?.query).toBe("q");

    await expect(
      webFetchFromTool(fake, ctx, { url: "https://example.test/1", maxChars: 100 }),
    ).resolves.toEqual({
      url: "https://example.test/1",
      title: "One",
      text: "Body text",
      truncated: false,
    });
  });

  it("surfaces provider errors as tool errors", async () => {
    const fake = new FakeWebProvider();
    fake.searchError = new Error("boom");
    await expect(webSearchFromTool(fake, ctx, { query: "q" })).resolves.toEqual({
      error: "boom",
    });
  });

  it("fetches multiple URLs concurrently via batch urls parameter, isolates mixed failures, enforces output cap, and honours abort", async () => {
    const { builtinAgentTools } = await import("./builtin-tools.js");
    const webFetchTool = builtinAgentTools.find((t) => t.name === "web_fetch");
    expect(webFetchTool?.inputSchema).toMatchObject({
      properties: {
        url: { type: "string" },
        urls: { type: "array", maxItems: 10 },
      },
      anyOf: [{ required: ["url"] }, { required: ["urls"] }],
    });

    const browserActTool = builtinAgentTools.find((t) => t.name === "browser_act");
    const actionProps = (
      browserActTool?.inputSchema as {
        properties?: { actions?: { items?: { properties?: { field?: { enum?: string[] } } } } };
      }
    )?.properties?.actions?.items?.properties?.field?.enum;
    expect(actionProps).toEqual(["username", "password", "totp"]);

    const seenMaxChars: number[] = [];
    const mixedProvider = {
      describe: () => ({ id: "mixed", contractVersion: "1", adapterVersion: "1", capabilities: {} }),
      fetch: async (req: { url: string; maxChars?: number }) => {
        seenMaxChars.push(req.maxChars ?? 0);
        if (req.url.includes("fail")) {
          throw new Error("upstream 502");
        }
        return {
          url: req.url,
          title: "Batch Page",
          text: "Parallel content",
          truncated: false,
        };
      },
    };
    const res = await webFetchFromTool(mixedProvider as never, ctx, {
      urls: [
        "https://example.test/1",
        "https://example.test/fail",
        "https://example.test/3",
        "https://example.test/4",
        "https://example.test/5",
      ],
      maxChars: 50_000,
    });
    expect(res).toEqual({
      pages: [
        { url: "https://example.test/1", title: "Batch Page", text: "Parallel content", truncated: false },
        { url: "https://example.test/fail", error: "upstream 502" },
        { url: "https://example.test/3", title: "Batch Page", text: "Parallel content", truncated: false },
        { url: "https://example.test/4", title: "Batch Page", text: "Parallel content", truncated: false },
        { url: "https://example.test/5", title: "Batch Page", text: "Parallel content", truncated: false },
      ],
    });
    // 50,000 total budget across 5 URLs clamps per-page maxChars to 10,000
    expect(seenMaxChars.every((c) => c === 10_000)).toBe(true);

    const abortController = new AbortController();
    abortController.abort(new Error("user cancelled"));
    await expect(
      webFetchFromTool(
        mixedProvider as never,
        { ...ctx, signal: abortController.signal },
        { urls: ["https://example.test/1"] },
      ),
    ).rejects.toThrow(/user cancelled/);
  });
});

describe("web tool clamps", () => {
  it("clamps maxResults and maxChars", () => {
    expect(clampMaxResults(undefined)).toBe(5);
    expect(clampMaxResults(100)).toBe(10);
    expect(clampMaxResults(0)).toBe(1);
    expect(clampMaxChars(undefined)).toBe(8_000);
    expect(clampMaxChars(10)).toBe(100);
    expect(clampMaxChars(999_999)).toBe(50_000);
  });
});

