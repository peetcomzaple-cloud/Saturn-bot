import { inflateSync } from "node:zlib";
import type { AgentRunRequest, AgentRuntime, AdapterContext } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  createImageChallenge,
  isMovingModelAlias,
  modelEndpointKey,
  modelImageCapabilityStore,
  probeModelImages,
  selectImageModel,
  scheduleImageProbe,
} from "./model-image-capability.js";
import { catalogImageCapability } from "./model-vision.js";
import { classifyModelError, createTypeSafeErrorClassifier } from "./model-error-classifier.js";

function readGrid(bytes: Uint8Array) {
  const png = Buffer.from(bytes);
  const parts: Buffer[] = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    if (png.toString("ascii", offset + 4, offset + 8) === "IDAT")
      parts.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const pixels = inflateSync(Buffer.concat(parts));
  let answer = "";
  for (let row = 0; row < 4; row++)
    for (let col = 0; col < 4; col++) {
      const pos = (row * 48 + 24) * (192 * 3 + 1) + 1 + (col * 48 + 24) * 3;
      const rgb = [...pixels.subarray(pos, pos + 3)].join(",");
      answer += (
        { "255,0,0": "R", "0,180,0": "G", "0,0,255": "B", "255,230,0": "Y" } as Record<
          string,
          string
        >
      )[rgb];
    }
  return answer;
}
const context = {
  signal: new AbortController().signal,
  operationId: "probe",
  traceId: "probe",
  userId: "user",
  spaceId: "space",
} as AdapterContext;
const model = { provider: "custom", id: "new-v2", apiKey: "not-real" };

describe("model image groups", () => {
  it("requires separate evidence for a custom endpoint reusing a catalog model ID", async () => {
    const store = modelImageCapabilityStore(
      {
        modelImageCapability: { findUnique: vi.fn().mockResolvedValue(null) },
      } as unknown as PrismaClient,
      "owner",
    );
    expect(
      await store.read({
        provider: "openrouter",
        id: "openai/gpt-4o",
        baseUrl: "https://custom.invalid/v1",
      }),
    ).toBe("orphan");
  });
  it("does not count a timed-out attempt as a mismatch and can pass the next challenge", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    try {
      let calls = 0;
      const runtime = {
        async *run(request: AgentRunRequest, ctx: AdapterContext) {
          calls++;
          if (calls === 1)
            await new Promise<void>((_resolve, reject) =>
              ctx.signal.addEventListener("abort", () => reject(new Error("timeout")), {
                once: true,
              }),
            );
          yield { type: "text", text: readGrid(request.currentTurnImages![0]!.data) } as const;
        },
      } as AgentRuntime;
      const result = probeModelImages({
        runtime,
        model,
        request: { botId: "bot", threadId: "thread", runId: "run" },
        context,
      });
      await vi.advanceTimersByTimeAsync(30_001);
      expect(await result).toEqual({ capability: "vision", evidence: "pixel_challenge_pass" });
      expect(calls).toBe(2);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });
  it("persists transient cooldown and fences a stale probe completion", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      modelImageCapability: {
        upsert: vi.fn(),
        findUnique: vi.fn().mockResolvedValue({ probeFailures: 2 }),
        updateMany,
      },
    } as unknown as PrismaClient;
    const store = modelImageCapabilityStore(prisma, "owner");
    const token = await store.claimProbe(model, now);
    expect(token).toEqual(expect.any(String));
    expect(updateMany.mock.calls[0]![0].where).toMatchObject({
      capability: "orphan",
      nextProbeAt: { lte: now },
      OR: [{ probeLeaseUntil: null }, { probeLeaseUntil: { lte: now } }],
    });
    await store.finishProbe(
      model,
      token!,
      { capability: "orphan", evidence: "probe_unavailable" },
      now,
    );
    expect(updateMany.mock.calls[1]![0]).toMatchObject({
      where: { capability: "orphan", probeLeaseToken: token },
      data: {
        probeFailures: 3,
        probeLeaseToken: null,
        nextProbeAt: new Date(now.getTime() + 4 * 3_600_000),
      },
    });
  });
  it("does not schedule a cooling or leased orphan, and creates a tool-free background job when due", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      capability: "orphan",
      nextProbeAt: new Date(Date.now() + 86_400_000),
      probeLeaseUntil: null,
    });
    const prisma = { modelImageCapability: { findUnique } } as unknown as PrismaClient;
    const jobs = { enqueue: vi.fn(), cancel: vi.fn(), close: vi.fn() };
    await scheduleImageProbe({ prisma, jobs, userId: "owner", spaceId: "space", model });
    expect(jobs.enqueue).not.toHaveBeenCalled();
    findUnique.mockResolvedValue({
      capability: "orphan",
      nextProbeAt: new Date(0),
      probeLeaseUntil: new Date(Date.now() + 60_000),
    });
    await scheduleImageProbe({ prisma, jobs, userId: "owner", spaceId: "space", model });
    expect(jobs.enqueue).not.toHaveBeenCalled();
    findUnique.mockResolvedValue(null);
    await scheduleImageProbe({ prisma, jobs, userId: "owner", spaceId: "space", model });
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "model.image-probe",
        maxAttempts: 1,
        payload: { userId: "owner", spaceId: "space", provider: "custom", modelId: "new-v2" },
      }),
    );
  });
  it("keeps new/provider-specific versions orphaned and isolates endpoints", () => {
    expect(catalogImageCapability("unregistered", "future-v3")).toBe("orphan");
    expect(modelEndpointKey("https://a.invalid/v1/")).toBe(
      modelEndpointKey("https://a.invalid/v1"),
    );
    expect(modelEndpointKey("https://a.invalid/v1")).not.toBe(
      modelEndpointKey("https://b.invalid/v1"),
    );
    expect(isMovingModelAlias("vendor/model-latest")).toBe(true);
    for (const id of ["auto", "openrouter/auto", "openrouter/free", "openrouter/bodybuilder"]) {
      expect(isMovingModelAlias(id)).toBe(true);
    }
    expect(isMovingModelAlias("vendor/vision-v3:free")).toBe(false);
    expect(isMovingModelAlias("vendor/model-v3-20261014")).toBe(false);
  });
  it("reads and persists exact provider/version/endpoint/user keys", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const upsert = vi.fn();
    const store = modelImageCapabilityStore(
      { modelImageCapability: { findUnique, upsert } } as unknown as PrismaClient,
      "owner",
    );
    const ref = { provider: "custom", id: "new-v2", baseUrl: "https://models.invalid/v1" };
    expect(await store.read(ref)).toBe("orphan");
    await store.record(ref, "text", "image_rejected");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          userId: "owner",
          provider: "custom",
          modelId: "new-v2",
          endpointKey: modelEndpointKey(ref.baseUrl),
          capability: "text",
        }),
      }),
    );
    findUnique.mockResolvedValueOnce({ capability: "text" });
    expect(await store.read(ref)).toBe("text");
    expect(await store.read({ ...ref, id: "new-v3" })).toBe("orphan");
  });
  it("puts the random answer only in pixels, with independently decoded PNG evidence", () => {
    const challenge = createImageChallenge(Buffer.from(Array.from({ length: 16 }, (_, i) => i)));
    expect(challenge.answer).toBe("RGBYRGBYRGBYRGBY");
    expect(readGrid(challenge.image.data)).toBe(challenge.answer);
    expect(challenge.prompt).not.toContain(challenge.answer);
    expect(challenge.image.name).toBe("capability.png");
  });
  it("probes an orphan without task tools/history and verifies pixels, not claimed capability", async () => {
    let request: AgentRunRequest | undefined;
    const runtime = {
      async *run(r: AgentRunRequest) {
        request = r;
        yield { type: "text", text: readGrid(r.currentTurnImages![0]!.data) } as const;
        yield { type: "done" } as const;
      },
    } as AgentRuntime;
    expect(
      await probeModelImages({
        runtime,
        model,
        request: { botId: "bot", threadId: "thread", runId: "run" },
        context,
      }),
    ).toEqual({ capability: "vision", evidence: "pixel_challenge_pass" });
    expect(request?.tools).toEqual([]);
    expect(request?.history).toEqual([]);
    expect(request?.usageOperationKind).toBe("setup");
    const blind = {
      async *run() {
        yield { type: "text", text: "I can see the screen" } as const;
      },
    } as AgentRuntime;
    expect(
      (
        await probeModelImages({
          runtime: blind,
          model,
          request: { botId: "bot", threadId: "thread", runId: "run" },
          context,
        })
      ).capability,
    ).toBe("text");
  });
  it.each([
    ["model does not support image input", "text"],
    ["429 quota exhausted", "orphan"],
    ["network timeout", "orphan"],
  ] as const)("does not learn blindness from transient error %s", async (message, expected) => {
    const runtime = {
      async *run() {
        throw new Error(message);
        yield { type: "done" } as const;
      },
    } as AgentRuntime;
    expect(
      (
        await probeModelImages({
          runtime,
          model,
          request: { botId: "bot", threadId: "thread", runId: "run" },
          context,
        })
      ).capability,
    ).toBe(expected);
  });
  it("accepts a fully correct fifth answer after four mismatches and stops immediately on success", async () => {
    let calls = 0;
    const runtime = {
      async *run(r: AgentRunRequest) {
        calls++;
        yield {
          type: "text",
          text: calls === 5 ? readGrid(r.currentTurnImages![0]!.data) : "wrong",
        } as const;
      },
    } as AgentRuntime;
    expect(
      await probeModelImages({
        runtime,
        model,
        request: { botId: "bot", threadId: "thread", runId: "run" },
        context,
      }),
    ).toEqual({ capability: "vision", evidence: "pixel_challenge_pass" });
    expect(calls).toBe(5);
    calls = 4;
    await probeModelImages({
      runtime,
      model,
      request: { botId: "bot", threadId: "thread", runId: "run" },
      context,
    });
    expect(calls).toBe(5);
  });
  it("requires five answered mismatches, never an empty response, to learn text", async () => {
    let calls = 0;
    const runtime = {
      async *run() {
        calls++;
        yield { type: "text", text: calls === 3 ? "" : "wrong" } as const;
      },
    } as AgentRuntime;
    expect(
      await probeModelImages({
        runtime,
        model,
        request: { botId: "bot", threadId: "thread", runId: "run" },
        context,
      }),
    ).toEqual({ capability: "orphan", evidence: "probe_inconclusive" });
    expect(calls).toBe(5);
    const blind = {
      async *run() {
        yield { type: "text", text: "wrong" } as const;
      },
    } as AgentRuntime;
    expect(
      await probeModelImages({
        runtime: blind,
        model,
        request: { botId: "bot", threadId: "thread", runId: "run" },
        context,
      }),
    ).toEqual({ capability: "text", evidence: "pixel_challenge_mismatch_5" });
  });
  it("uses only verified vision and queues an orphan without trying a user's task", async () => {
    const resolve = vi.fn(async (x) => ({ ...x, apiKey: "fake" }));
    const scheduleProbe = vi.fn();
    const chosen = await selectImageModel({
      candidates: [
        { provider: "p", id: "new-latest" },
        { provider: "p", id: "text-v1" },
        { provider: "p", id: "orphan-v1" },
        { provider: "p", id: "vision-v1" },
      ],
      resolve,
      scheduleProbe,
      capability: async (x) =>
        x.id === "text-v1" ? "text" : x.id === "orphan-v1" ? "orphan" : "vision",
    });
    expect(chosen?.id).toBe("vision-v1");
    expect(resolve.mock.calls.map(([x]) => x.id)).toEqual(["text-v1", "orphan-v1", "vision-v1"]);
    expect(scheduleProbe).toHaveBeenCalledOnce();
    expect(scheduleProbe).toHaveBeenCalledWith(expect.objectContaining({ id: "orphan-v1" }));
  });
});

describe("optional error decision adapter", () => {
  it("is off with no key and never calls a classifier for recognized errors", async () => {
    const fetch = vi.fn();
    expect(createTypeSafeErrorClassifier({ enabled: true, fetch })).toBeUndefined();
    expect(
      createTypeSafeErrorClassifier({ enabled: false, apiKey: "fake", fetch }),
    ).toBeUndefined();
    const classifier = vi.fn();
    expect(await classifyModelError("Images are not supported by this model", classifier)).toBe(
      "image_unsupported",
    );
    expect(await classifyModelError("image size too large", classifier)).toBe("other");
    expect(await classifyModelError("429 quota", classifier)).toBe("rate_limit_or_quota");
    expect(classifier).not.toHaveBeenCalled();
  });
  it("uses pinned Jev Choice with only error text and rejects alias/low-confidence/malformed responses", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "jev-1.14.0",
          answers: {
            category: { type: "choice", choice: "image_unsupported", confidence: 0.99 },
          },
        }),
      ),
    );
    const classify = createTypeSafeErrorClassifier({ enabled: true, apiKey: "fake", fetch })!;
    expect(await classify("unknown provider code")).toBe("image_unsupported");
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    const body = JSON.parse(options.body);
    expect(body.model).toBe("jev-1.14.0");
    expect(body.questions.category.type).toBe("choice");
    expect(body.state).toEqual({ error: "unknown provider code" });
    expect(body).not.toHaveProperty("assets");
    for (const response of [
      {
        model: "jev-latest",
        answers: { category: { type: "choice", choice: "image_unsupported", confidence: 1 } },
      },
      {
        model: "jev-1.14.0",
        answers: { category: { type: "choice", choice: "image_unsupported", confidence: 0.5 } },
      },
      {},
    ]) {
      fetch.mockResolvedValueOnce(new Response(JSON.stringify(response)));
      expect(await classify("unknown")).toBe("other");
    }
  });
});
