import type { ModelImageCapability } from "./model-image-capability.js";

export interface ModelPrice {
  /** USD per million tokens, matching pi-ai catalog units. */
  input: number;
  output: number;
}

function validPrice(price?: ModelPrice): price is ModelPrice {
  return Boolean(
    price &&
      Number.isFinite(price.input) &&
      price.input >= 0 &&
      Number.isFinite(price.output) &&
      price.output >= 0,
  );
}

/** Equal input/output weighting is deterministic; missing prices are never free. */
export function orderModelGroups<
  T extends { provider: string; id: string; capability: ModelImageCapability; cost?: ModelPrice },
>(models: readonly T[]) {
  const byPrice = (a: T, b: T) =>
    a.cost!.input + a.cost!.output - (b.cost!.input + b.cost!.output) ||
    a.provider.localeCompare(b.provider) ||
    a.id.localeCompare(b.id);
  return {
    vision: models
      .filter((model) => model.capability === "vision" && validPrice(model.cost))
      .sort(byPrice),
    text: models
      .filter((model) => model.capability === "text" && validPrice(model.cost))
      .sort(byPrice),
    orphan: models.filter((model) => model.capability === "orphan"),
  };
}

/** Public metadata only; no key, task text or caller-controlled URL is sent. */
export class ProviderPriceCache {
  private prices = new Map<string, ModelPrice>();
  private nextRefreshAt = 0;
  private refreshing?: Promise<void>;
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}
  async openRouter(signal?: AbortSignal): Promise<ReadonlyMap<string, ModelPrice>> {
    if (Date.now() >= this.nextRefreshAt && !this.refreshing) {
      this.nextRefreshAt = Date.now() + 15 * 60_000;
      this.refreshing = (async () => {
        try {
          const response = await this.fetchImpl("https://openrouter.ai/api/v1/models", {
            redirect: "error",
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(5_000)])
              : AbortSignal.timeout(5_000),
          });
          if (!response.ok) return;
          const body = (await response.json()) as {
            data?: Array<{ id?: unknown; pricing?: { prompt?: unknown; completion?: unknown } }>;
          };
          if (!Array.isArray(body.data)) return;
          const prices = new Map<string, ModelPrice>();
          for (const model of body.data) {
            if (
              typeof model.id !== "string" ||
              typeof model.pricing?.prompt !== "string" ||
              typeof model.pricing.completion !== "string" ||
              !model.pricing.prompt.trim() ||
              !model.pricing.completion.trim()
            )
              continue;
            const price = {
              input: Number(model.pricing.prompt) * 1_000_000,
              output: Number(model.pricing.completion) * 1_000_000,
            };
            if (validPrice(price)) prices.set(model.id, price);
          }
          this.prices = prices;
        } catch {
          /* Unavailable metadata must not invent a free price. */
        }
      })().finally(() => {
        this.refreshing = undefined;
      });
    }
    await this.refreshing;
    return this.prices;
  }
}
