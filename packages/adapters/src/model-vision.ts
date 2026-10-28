import type { Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { DEFAULT_OPENROUTER_MODEL_ID } from "./deployment-model.js";
import { supplementPiModels } from "./pi-current-models.js";
import { registerLocalProvider } from "./pi-local-provider.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  registerOpenAiCompatibleCatalog,
} from "./pi-openai-compatible-provider.js";

/** Computer tools whose results include screenshots for the model. */
export const IMAGE_RETURNING_COMPUTER_TOOLS = new Set([
  "computer_observe",
  "computer_act",
  "open_path",
  "launch_app",
]);

export const MODEL_CANNOT_SEE_MESSAGE = "This bot's model cannot see; pick a vision-capable model.";

/** Return whether a model id is explicitly enabled for image input on a connection. */
export function modelIdSupportsImages(
  modelIds: readonly string[] | undefined,
  modelId: string | null | undefined,
): boolean {
  const normalizedModelId = modelId?.trim();
  return Boolean(
    normalizedModelId && modelIds?.some((candidate) => candidate.trim() === normalizedModelId),
  );
}

/** Update the explicit per-model image capability without disturbing other model ids. */
export function updateModelImageCapabilities(
  modelIds: readonly string[] | undefined,
  modelId: string | null | undefined,
  supportsImages: boolean | undefined,
): string[] {
  const next = new Set(
    (modelIds ?? [])
      .map((candidate) => candidate.trim())
      .filter((candidate) => candidate.length > 0),
  );
  const normalizedModelId = modelId?.trim();
  if (normalizedModelId && supportsImages !== undefined) {
    if (supportsImages) next.add(normalizedModelId);
    else next.delete(normalizedModelId);
  }
  return [...next];
}

let catalogModelsCache: Models | undefined;

function catalogModels(): Models {
  // Same catalog the runtime calls, including models added ahead of the bundled library.
  catalogModelsCache ??= registerOpenAiCompatibleCatalog(
    registerLocalProvider(supplementPiModels(builtinModels())),
  );
  return catalogModelsCache;
}

/**
 * Mirror Pi's scripted placeholder resolution so vision checks use the same
 * model the runtime will actually call.
 */
export function resolveModelRefForVisionCheck(
  provider: string,
  modelId: string,
): { provider: string; id: string } {
  const normalizedProvider = provider.trim();
  const normalizedId = modelId.trim();
  if (normalizedProvider === "scripted" || normalizedId === "scripted") {
    return {
      provider: "openrouter",
      id: process.env.PI_DEFAULT_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL_ID,
    };
  }
  return { provider: normalizedProvider, id: normalizedId };
}

/**
 * Whether the selected model accepts image input, per the Pi model catalog's
 * declared `input` modalities. Unknown models remain eligible as orphans;
 * Auto verifies them with a tool-free pixel challenge before visual work.
 * The `scripted` placeholder is resolved the same way Pi does (env default /
 * GPT-5.6 Luna fallback) before the catalog check. An explicit connection capability
 * override is honored for OpenAI-compatible models.
 */
export function modelAcceptsImageInput(
  provider: string,
  modelId: string,
  acceptsImages?: boolean,
): boolean {
  if (acceptsImages !== undefined) return acceptsImages;
  return catalogImageCapability(provider, modelId) !== "text";
}

export function catalogImageCapability(
  provider: string,
  modelId: string,
): "vision" | "text" | "orphan" {
  const resolved = resolveModelRefForVisionCheck(provider, modelId);
  if (!resolved.provider || !resolved.id) return "orphan";

  const models = catalogModels();
  const model = models.getModel(resolved.provider, resolved.id);
  if (!model || resolved.provider === OPENAI_COMPATIBLE_PROVIDER_ID) return "orphan";
  return model.input.includes("image") ? "vision" : "text";
}

export function filterImageReturningComputerTools<T extends { name: string }>(
  tools: T[],
  acceptsImages: boolean,
): T[] {
  if (acceptsImages) return tools;
  return tools.filter((tool) => !IMAGE_RETURNING_COMPUTER_TOOLS.has(tool.name));
}
