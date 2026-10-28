import { describe, expect, it, vi } from "vitest";
import { orderModelGroups, ProviderPriceCache } from "./model-price-order.js";

describe("Auto model price ordering", () => {
  it("orders inside each group, excludes unknown prices and never ranks by confidence", () => {
    const models = [
      {
        provider: "p",
        id: "expensive",
        capability: "vision" as const,
        cost: { input: 5, output: 15 },
      },
      {
        provider: "p",
        id: "cheap",
        capability: "vision" as const,
        cost: { input: 0.1, output: 0.2 },
      },
      { provider: "p", id: "text", capability: "text" as const, cost: { input: 1, output: 2 } },
      { provider: "p", id: "unknown-price", capability: "vision" as const },
      { provider: "p", id: "new", capability: "orphan" as const, cost: { input: 0, output: 0 } },
    ];
    const groups = orderModelGroups(models);
    expect(groups.vision.map((model) => model.id)).toEqual(["cheap", "expensive"]);
    expect(groups.text.map((model) => model.id)).toEqual(["text"]);
    expect(groups.orphan.map((model) => model.id)).toEqual(["new"]);
  });
  it("reads provider token pricing in catalog units, coalesces requests and rejects invalid prices", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "new", pricing: { prompt: "0.0000001", completion: "0.0000002" } },
            { id: "free", pricing: { prompt: "0", completion: "0" } },
            { id: "negative", pricing: { prompt: "-1", completion: "0" } },
            { id: "missing", pricing: { prompt: "", completion: "0" } },
          ],
        }),
      ),
    );
    const cache = new ProviderPriceCache(fetch);
    const [a, b] = await Promise.all([cache.openRouter(), cache.openRouter()]);
    expect(a).toBe(b);
    expect(a.get("new")?.input).toBeCloseTo(0.1);
    expect(a.get("new")?.output).toBeCloseTo(0.2);
    expect(a.get("free")).toEqual({ input: 0, output: 0 });
    expect(a.has("negative")).toBe(false);
    expect(a.has("missing")).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![0]).toBe("https://openrouter.ai/api/v1/models");
  });
  it("backs off unavailable metadata instead of repeatedly fetching or inventing prices", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("network"));
    const cache = new ProviderPriceCache(fetch);
    expect((await cache.openRouter()).size).toBe(0);
    await cache.openRouter();
    expect(fetch).toHaveBeenCalledOnce();
  });
});
