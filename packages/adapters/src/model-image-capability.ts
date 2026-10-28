import { createHash, randomBytes, randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import type {
  AgentRunModel,
  AgentRunRequest,
  AgentRuntime,
  AdapterContext,
  JobPublisher,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { classifyModelError } from "./model-error-classifier.js";
import type { ModelErrorClassifier } from "./model-error-classifier.js";
import { catalogImageCapability } from "./model-vision.js";

export type ModelImageCapability = "vision" | "text" | "orphan";
export function imageProbeJob(input: {
  userId: string;
  spaceId: string;
  provider: string;
  modelId: string;
  endpointKey?: string;
}) {
  return {
    name: "model.image-probe" as const,
    maxAttempts: 1,
    replaceKey: `model.image-probe:${createHash("sha256")
      .update(
        JSON.stringify([
          input.userId,
          input.spaceId,
          input.provider,
          input.modelId,
          input.endpointKey ?? "",
        ]),
      )
      .digest("hex")}`,
    payload: {
      userId: input.userId,
      spaceId: input.spaceId,
      provider: input.provider,
      modelId: input.modelId,
    },
  };
}
export async function learnedImageCatalog<
  T extends { provider: string; id: string; imageCapability?: ModelImageCapability },
>(
  prisma: PrismaClient,
  userId: string,
  catalog: T[],
): Promise<Array<T & { imageCapability: ModelImageCapability }>> {
  const rows = await prisma.modelImageCapability.findMany({ where: { userId, endpointKey: "" } });
  const learned = new Map(
    rows.map((row) => [JSON.stringify([row.provider, row.modelId]), row.capability]),
  );
  return catalog.map((entry) => ({
    ...entry,
    imageCapability:
      (learned.get(JSON.stringify([entry.provider, entry.id])) as
        | ModelImageCapability
        | undefined) ??
      entry.imageCapability ??
      "orphan",
  }));
}
export function modelEndpointKey(baseUrl?: string): string {
  return baseUrl
    ? createHash("sha256").update(baseUrl.trim().replace(/\/+$/, "")).digest("hex")
    : "";
}
export function isMovingModelAlias(id: string): boolean {
  return (
    /(?:^|[-/:])latest(?:$|[-/:])/i.test(id) ||
    /^(?:openrouter\/)?(?:auto|free|bodybuilder)$/i.test(id.trim())
  );
}
export function modelImageCapabilityStore(prisma: PrismaClient, userId: string) {
  const key = (model: Pick<AgentRunModel, "provider" | "id" | "baseUrl">) => ({
    userId,
    provider: model.provider,
    modelId: model.id,
    endpointKey: modelEndpointKey(model.baseUrl),
  });
  return {
    async claimProbe(model: Pick<AgentRunModel, "provider" | "id" | "baseUrl">, now = new Date()) {
      if (isMovingModelAlias(model.id)) return undefined;
      await prisma.modelImageCapability.upsert({
        where: { userId_provider_modelId_endpointKey: key(model) },
        create: { ...key(model), capability: "orphan", evidence: "discovered" },
        update: {},
      });
      const token = randomUUID();
      const claimed = await prisma.modelImageCapability.updateMany({
        where: {
          ...key(model),
          capability: "orphan",
          nextProbeAt: { lte: now },
          OR: [{ probeLeaseUntil: null }, { probeLeaseUntil: { lte: now } }],
        },
        data: { probeLeaseToken: token, probeLeaseUntil: new Date(now.getTime() + 180_000) },
      });
      return claimed.count === 1 ? token : undefined;
    },
    async finishProbe(
      model: Pick<AgentRunModel, "provider" | "id" | "baseUrl">,
      token: string,
      result: { capability: ModelImageCapability; evidence: string },
      now = new Date(),
    ) {
      const row = await prisma.modelImageCapability.findUnique({
        where: { userId_provider_modelId_endpointKey: key(model) },
      });
      const failures = result.capability === "orphan" ? (row?.probeFailures ?? 0) + 1 : 0;
      await prisma.modelImageCapability.updateMany({
        // Never overwrite a concurrent authoritative image rejection or a newer lease.
        where: { ...key(model), capability: "orphan", probeLeaseToken: token },
        data: {
          ...result,
          probeFailures: failures,
          probeLeaseToken: null,
          probeLeaseUntil: null,
          nextProbeAt: new Date(
            now.getTime() + Math.min(7 * 86_400_000, 3_600_000 * 2 ** Math.min(failures - 1, 8)),
          ),
        },
      });
    },
    async read(
      model: Pick<AgentRunModel, "provider" | "id" | "baseUrl">,
    ): Promise<ModelImageCapability> {
      const row = await prisma.modelImageCapability.findUnique({
        where: { userId_provider_modelId_endpointKey: key(model) },
      });
      if (row && ["vision", "text", "orphan"].includes(row.capability))
        return row.capability as ModelImageCapability;
      // A custom endpoint has its own identity even when it reuses a catalog ID.
      return model.baseUrl ? "orphan" : catalogImageCapability(model.provider, model.id);
    },
    async record(
      model: Pick<AgentRunModel, "provider" | "id" | "baseUrl">,
      capability: ModelImageCapability,
      evidence: string,
    ) {
      await prisma.modelImageCapability.upsert({
        where: { userId_provider_modelId_endpointKey: key(model) },
        create: { ...key(model), capability, evidence },
        update: capability === "text" ? { capability, evidence } : {},
      });
      if (capability !== "text")
        await prisma.modelImageCapability.updateMany({
          where: {
            ...key(model),
            capability: capability === "orphan" ? "orphan" : { not: "text" },
          },
          data: { capability, evidence },
        });
    },
  };
}

/** Queue discovery without ever sending a user's task to an unverified model. */
export async function scheduleImageProbe(input: {
  prisma: PrismaClient;
  jobs: JobPublisher;
  userId: string;
  spaceId: string;
  model: Pick<AgentRunModel, "provider" | "id" | "baseUrl">;
}): Promise<void> {
  if (isMovingModelAlias(input.model.id)) return;
  const store = modelImageCapabilityStore(input.prisma, input.userId);
  if ((await store.read(input.model)) !== "orphan") return;
  const row = await input.prisma.modelImageCapability.findUnique({
    where: {
      userId_provider_modelId_endpointKey: {
        userId: input.userId,
        provider: input.model.provider,
        modelId: input.model.id,
        endpointKey: modelEndpointKey(input.model.baseUrl),
      },
    },
  });
  if (
    row &&
    (row.nextProbeAt > new Date() || (row.probeLeaseUntil && row.probeLeaseUntil > new Date()))
  )
    return;
  await input.jobs.enqueue(
    imageProbeJob({
      userId: input.userId,
      spaceId: input.spaceId,
      provider: input.model.provider,
      modelId: input.model.id,
      endpointKey: modelEndpointKey(input.model.baseUrl),
    }),
  );
}

function pngChunk(type: string, bytes: Buffer): Buffer {
  const content = Buffer.concat([Buffer.from(type), bytes]);
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, content, trailer]);
}

/** A fresh answer exists only in pixel bytes; no answer appears in metadata/text. */
export function createImageChallenge(entropy = randomBytes(16)) {
  if (entropy.length !== 16) throw new Error("Image challenge requires 16 random bytes");
  const colors = [
    [255, 0, 0],
    [0, 180, 0],
    [0, 0, 255],
    [255, 230, 0],
  ];
  const letters = "RGBY";
  const width = 192;
  const raw = Buffer.alloc((width * 3 + 1) * width, 255);
  for (let y = 0; y < width; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const border = x % 48 < 4 || y % 48 < 4 || x % 48 > 43 || y % 48 > 43;
      const color = border
        ? [255, 255, 255]
        : colors[entropy[Math.floor(y / 48) * 4 + Math.floor(x / 48)]! % 4]!;
      for (let channel = 0; channel < 3; channel++)
        raw[y * (width * 3 + 1) + 1 + x * 3 + channel] = color[channel]!;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(width, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return {
    answer: [...entropy].map((value) => letters[value % 4]).join(""),
    image: {
      name: "capability.png",
      mimeType: "image/png" as const,
      data: Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk("IHDR", ihdr),
        pngChunk("IDAT", deflateSync(raw)),
        pngChunk("IEND", Buffer.alloc(0)),
      ]),
    },
    prompt:
      "Read the attached 4 by 4 color grid, left to right, top to bottom. Output exactly 16 letters: R for red, G for green, B for blue, Y for yellow. Ignore white borders. No explanation.",
  };
}

export async function probeModelImages(input: {
  runtime: AgentRuntime;
  model: AgentRunModel;
  request: Pick<AgentRunRequest, "botId" | "threadId" | "runId" | "onUsage">;
  context: AdapterContext;
  classify?: ModelErrorClassifier;
}): Promise<{ capability: ModelImageCapability; evidence: string }> {
  let mismatches = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const challenge = createImageChallenge();
    let text = "";
    let failure: string | undefined;
    const probeSignal = AbortSignal.any([input.context.signal, AbortSignal.timeout(30_000)]);
    // A separate tool-free request can never replay an effect from the actual task.
    try {
      for await (const event of input.runtime.run(
        {
          ...input.request,
          threadId: `image-probe:${randomUUID()}`,
          runId: `${input.request.runId}:image-probe:${randomBytes(6).toString("hex")}`,
          usageOperationKind: "setup",
          prompt: challenge.prompt,
          instructions: "Return only the requested grid letters.",
          history: [],
          currentTurnImages: [challenge.image],
          tools: [],
          model: { ...input.model, acceptsImages: true, maxTokens: 1024, thinkingLevel: "off" },
        },
        {
          ...input.context,
          operationId: `${input.context.operationId}:image-probe`,
          signal: probeSignal,
        },
      )) {
        if (event.type === "text") text += event.text;
        else if (event.type === "reset_text") text = "";
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (input.context.signal?.aborted) throw new Error("Image capability probe aborted");
    if (probeSignal.aborted) continue;
    if (failure) {
      const classification = await classifyModelError(
        failure,
        input.classify,
        input.context.signal,
      );
      if (classification === "image_unsupported")
        return { capability: "text", evidence: "image_rejected" };
      // Quota/network failures are not blindness. Stop this batch rather than
      // spending its remaining attempts on the same unavailable provider.
      return { capability: "orphan", evidence: "probe_unavailable" };
    }
    if (text.replace(/[\s`"']/g, "").toUpperCase() === challenge.answer)
      return { capability: "vision", evidence: "pixel_challenge_pass" };
    if (text.trim()) mismatches++;
  }
  return mismatches === 5
    ? { capability: "text", evidence: "pixel_challenge_mismatch_5" }
    : { capability: "orphan", evidence: "probe_inconclusive" };
}

/** Caller supplies price order; an orphan is queued, never tried on this task. */
export async function selectImageModel<
  T extends Pick<AgentRunModel, "provider" | "id" | "baseUrl">,
>(input: {
  candidates: readonly T[];
  resolve: (candidate: T) => Promise<AgentRunModel>;
  capability: (model: AgentRunModel) => Promise<ModelImageCapability>;
  scheduleProbe: (model: AgentRunModel) => Promise<void>;
  signal?: AbortSignal;
}): Promise<AgentRunModel | undefined> {
  const seen = new Set<string>();
  for (const candidate of input.candidates) {
    if (input.signal?.aborted) throw new Error("Image model selection aborted");
    const key = JSON.stringify([candidate.provider, candidate.id]);
    if (seen.has(key) || isMovingModelAlias(candidate.id)) continue;
    seen.add(key);
    let model: AgentRunModel;
    try {
      model = await input.resolve(candidate);
    } catch {
      continue;
    }
    const capability = await input.capability(model);
    if (capability === "orphan") {
      await input.scheduleProbe(model);
    }
    if (capability === "vision") return { ...model, acceptsImages: true };
  }
  return undefined;
}
