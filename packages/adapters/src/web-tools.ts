import type { AdapterContext, WebFetchProvider, WebSearchProvider } from "@rakazo/adapter-kit";
import { clampMaxChars, clampMaxResults } from "./web-limits.js";

export async function webSearchFromTool(
  search: WebSearchProvider,
  context: AdapterContext,
  args: Record<string, unknown>,
) {
  const query = String(args.query ?? "").trim();
  if (!query) return { error: "query is required" };
  try {
    const results = await search.search(
      {
        query,
        maxResults: clampMaxResults(args.maxResults),
        signal: context.signal,
      },
      context,
    );
    return { results };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const MAX_BATCH_FETCH_URLS = 10;
const MAX_BATCH_TOTAL_CHARS = 50_000;

export async function webFetchFromTool(
  fetchProvider: WebFetchProvider,
  context: AdapterContext,
  args: Record<string, unknown>,
) {
  context.signal.throwIfAborted();
  const maxChars = clampMaxChars(args.maxChars);
  if (Array.isArray(args.urls)) {
    const rawUrls = args.urls
      .map((u) => String(u ?? "").trim())
      .filter((u) => u.length > 0)
      .slice(0, MAX_BATCH_FETCH_URLS);
    if (rawUrls.length === 0) return { error: "urls must contain at least one non-empty URL" };
    const perPageMaxChars = Math.max(
      100,
      Math.min(maxChars, Math.floor(MAX_BATCH_TOTAL_CHARS / rawUrls.length)),
    );
    const pages = await Promise.all(
      rawUrls.map(async (targetUrl) => {
        context.signal.throwIfAborted();
        try {
          return await fetchProvider.fetch(
            {
              url: targetUrl,
              maxChars: perPageMaxChars,
              signal: context.signal,
            },
            context,
          );
        } catch (error) {
          context.signal.throwIfAborted();
          return {
            url: targetUrl,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    return { pages };
  }
  const url = String(args.url ?? "").trim();
  if (!url) return { error: "url is required" };
  try {
    const result = await fetchProvider.fetch(
      {
        url,
        maxChars,
        signal: context.signal,
      },
      context,
    );
    return result;
  } catch (error) {
    context.signal.throwIfAborted();
    return { error: error instanceof Error ? error.message : String(error) };
  }
}


