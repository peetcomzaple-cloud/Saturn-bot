import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { encodeLoginSecret } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@rakazo/db", () => ({
  withTransactionRetry: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock("./remote-mcp.js", () => ({
  createPrivateNetworkFetch: vi.fn(),
  createSafeRemoteFetch: vi.fn(),
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {},
}));

vi.mock("@earendil-works/pi-ai", () => ({
  clampThinkingLevel: vi.fn(),
  Type: {
    Object: vi.fn(() => ({})),
    String: vi.fn(() => ({})),
    Boolean: vi.fn(() => ({})),
    Array: vi.fn(() => ({})),
    Optional: vi.fn(() => ({})),
  },
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: {},
}));

vi.mock("@earendil-works/pi-ai/compat", () => ({
  getEnvApiKey: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/utils/event-stream", () => ({
  AssistantMessageEventStream: class {},
}));

type PrismaClient = any;

import {
  resolveLoginFill,
  resolveRequestSecretDestination,
} from "./bot-secrets.js";
import {
  browserActFromTool,
  parseBrowserActions,
} from "./browser-tools.js";
import { FakeBrowserProvider } from "./fake-browser.js";
import { prepareRequestSecretArguments } from "./pi-runtime.js";
import { EncryptedSecretStore } from "./secrets.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const scope = { userId: "user-1", spaceId: "space-1", botId: "bot-1", id: "run-1" };
const secretStore = new EncryptedSecretStore("test-round3-encryption-key");
const fakeCreds = {
  username: "fake-test-admin",
  password: "fake-test-password-1234",
};

const context: AdapterContext = {
  operationId: "run-1",
  traceId: "run-1",
  spaceId: "space-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

const computer: ComputerRef = {
  id: "c1",
  botId: "bot-1",
  kind: "fake",
  providerRef: "c1",
};

describe("round3-login-flow: schema preparation and parameter normalization", () => {
  it("normalizes question/prompt/message to label in prepareRequestSecretArguments", () => {
    const fromQuestion = prepareRequestSecretArguments({ question: "Enter credentials", purpose: "login" });
    expect(fromQuestion.label).toBe("Enter credentials");

    const fromPrompt = prepareRequestSecretArguments({ prompt: "Please sign in", purpose: "login" });
    expect(fromPrompt.label).toBe("Please sign in");

    const fromMessage = prepareRequestSecretArguments({ message: "Provide login", purpose: "login" });
    expect(fromMessage.label).toBe("Provide login");
  });

  it("handles purpose 'login' with one-use HTTPS origin pinning", () => {
    const prepared = prepareRequestSecretArguments({
      purpose: "login",
      origin: "https://auth.example.test/login",
      label: "Log in to portal",
    });
    expect(prepared.purpose).toBe("login");
    expect(prepared.origin).toBe("https://auth.example.test");
  });

  it("ignores non-HTTPS origin for one-use login in argument preparation", () => {
    const prepared = prepareRequestSecretArguments({
      label: "Log in",
      purpose: "login",
      origin: "http://insecure.example.test",
    });
    expect(prepared.purpose).toBe("login");
    expect(prepared.origin).toBeUndefined();
  });
});

describe("round3-login-flow: destination resolution (one-use vs saved reuse)", () => {
  it("resolves one-use login destination with valid HTTPS origin", () => {
    const res = resolveRequestSecretDestination({
      purpose: "login",
      origin: "https://secure.example.test",
    });
    expect(res).toEqual({
      oneUse: true,
      origin: "https://secure.example.test",
    });
  });

  it("resolves one-use password destination without credential object", () => {
    const res = resolveRequestSecretDestination({
      purpose: "password",
    });
    expect(res).toEqual({
      oneUse: true,
      origin: undefined,
    });
  });

  it("rejects plain HTTP origin for one-use login destination", () => {
    const res = resolveRequestSecretDestination({
      purpose: "login",
      origin: "http://example.test",
    });
    expect(res).toEqual({
      error: "Website logins can only be filled on an HTTPS origin.",
    });
  });

  it("rejects empty destination when purpose is not login or password", () => {
    const res = resolveRequestSecretDestination({
      purpose: "api_key",
    });
    expect(res).toEqual({
      error: "Provide either a reusable credential destination or a connectionId.",
    });
  });

  it("resolves reusable saved login destination", () => {
    const res = resolveRequestSecretDestination({
      credential: {
        name: "my_site_login",
        origin: "https://app.example.test",
        auth: { type: "login" },
      },
    });
    expect(res).toEqual({
      destination: {
        name: "my_site_login",
        origin: "https://app.example.test",
        auth: { type: "login" },
      },
    });
  });
});

describe("round3-login-flow: resolveLoginFill for one-use and saved logins", () => {
  it("resolves one-use ephemeral secret for runId bound to HTTPS origin", async () => {
    const plaintext = encodeLoginSecret(fakeCreds);
    const encrypted = await secretStore.put(
      plaintext,
      { ...scope, operationId: "op-1", traceId: "tr-1", signal: new AbortController().signal },
      { recordId: "secret-one-use-1" },
    );

    const secretRow = {
      id: "secret-one-use-1",
      userId: scope.userId,
      spaceId: scope.spaceId,
      kind: `run-secret:${scope.id}`,
      ciphertext: encrypted.ciphertext,
      createdAt: new Date(),
    };

    const effectRow = {
      id: "eff-1",
      runId: scope.id,
      spaceId: scope.spaceId,
      kind: "request_secret",
      status: "approved",
      result: { oneUse: true, origin: "https://portal.example.test" },
      createdAt: new Date(),
    };

    const prisma = {
      botSecret: { findFirst: vi.fn().mockResolvedValue(null) },
      secret: { findFirst: vi.fn().mockResolvedValue(secretRow) },
      externalEffect: { findFirst: vi.fn().mockResolvedValue(effectRow) },
    } as unknown as PrismaClient;

    const resolvedUser = await resolveLoginFill({
      prisma,
      secretStore,
      scope,
      runId: scope.id,
      field: "username",
    });

    expect(resolvedUser).toEqual({
      text: fakeCreds.username,
      origin: "https://portal.example.test",
      redactions: expect.arrayContaining([fakeCreds.username, fakeCreds.password]),
    });

    const resolvedPass = await resolveLoginFill({
      prisma,
      secretStore,
      scope,
      runId: scope.id,
      field: "password",
    });

    expect(resolvedPass).toEqual({
      text: fakeCreds.password,
      origin: "https://portal.example.test",
      redactions: expect.arrayContaining([fakeCreds.username, fakeCreds.password]),
    });
  });

  it("refuses one-use login when bound origin is not HTTPS", async () => {
    const plaintext = encodeLoginSecret(fakeCreds);
    const encrypted = await secretStore.put(
      plaintext,
      { ...scope, operationId: "op-1", traceId: "tr-1", signal: new AbortController().signal },
      { recordId: "secret-insecure-1" },
    );

    const secretRow = {
      id: "secret-insecure-1",
      userId: scope.userId,
      spaceId: scope.spaceId,
      kind: `run-secret:${scope.id}`,
      ciphertext: encrypted.ciphertext,
      createdAt: new Date(),
    };

    const effectRow = {
      id: "eff-2",
      runId: scope.id,
      spaceId: scope.spaceId,
      kind: "request_secret",
      status: "approved",
      result: { oneUse: true, origin: "http://insecure.example.test" },
      createdAt: new Date(),
    };

    const prisma = {
      botSecret: { findFirst: vi.fn().mockResolvedValue(null) },
      secret: { findFirst: vi.fn().mockResolvedValue(secretRow) },
      externalEffect: { findFirst: vi.fn().mockResolvedValue(effectRow) },
    } as unknown as PrismaClient;

    const res = await resolveLoginFill({
      prisma,
      secretStore,
      scope,
      runId: scope.id,
      field: "username",
    });

    expect(res).toEqual({ error: "Website logins can only be filled on an HTTPS origin." });
  });

  it("returns error when no login secret is available", async () => {
    const prisma = {
      botSecret: { findFirst: vi.fn().mockResolvedValue(null) },
      secret: { findFirst: vi.fn().mockResolvedValue(null) },
      externalEffect: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;

    const res = await resolveLoginFill({
      prisma,
      secretStore,
      scope,
      runId: scope.id,
      field: "password",
    });

    expect(res).toEqual({ error: "Login is unavailable. Use request_secret to save it first." });
  });
});

describe("round3-login-flow: browserActFromTool action parsing and safe secret injection", () => {
  it("parses fill_secret with optional secret argument for one-use logins", () => {
    const steps = parseBrowserActions([
      { kind: "fill_secret", ref: "e1", field: "username" },
      { kind: "fill_secret", ref: "e2", field: "password" },
      { kind: "fill_secret", ref: "e3", secret: "saved_login", field: "password" },
    ]);
    expect(steps).toEqual([
      { kind: "fill_secret", ref: "e1", field: "username" },
      { kind: "fill_secret", ref: "e2", field: "password" },
      { kind: "fill_secret", ref: "e3", secret: "saved_login", field: "password" },
    ]);
  });

  it("rejects invalid field for fill_secret", () => {
    expect(() =>
      parseBrowserActions([{ kind: "fill_secret", ref: "e1", field: "token" }]),
    ).toThrow(/field must be username or password/i);
  });

  it("fills one-use secrets and preserves Owner A metadata", async () => {
    const browser = new FakeBrowserProvider();
    let filledActions: unknown[] = [];
    browser.act = vi.fn(async (_comp, req) => {
      filledActions = req.actions;
      return {
        ok: true,
        completed: req.actions.length,
        url: "https://portal.example.test/welcome",
        title: "Welcome",
        dispatched: true,
        applied: true,
        verified: true,
        failedBeforeDispatch: false,
        retryable: false,
      };
    });

    const resolveSecretFill = vi.fn(async (step: { field: "username" | "password" }) => ({
      text: fakeCreds[step.field],
      origin: "https://portal.example.test",
    }));

    const result = await browserActFromTool(
      browser,
      computer,
      context,
      {
        actions: [
          { kind: "fill_secret", ref: "e-user", field: "username" },
          { kind: "fill_secret", ref: "e-pass", field: "password" },
          { kind: "click", ref: "e-btn" },
        ],
      },
      {
        resolveSecretFill,
        redactions: () => [fakeCreds.password, fakeCreds.username],
      },
    );

    expect(result).toMatchObject({
      ok: true,
      completed: 3,
      dispatched: true,
      applied: true,
      verified: true,
      failedBeforeDispatch: false,
      retryable: false,
    });
    expect(filledActions).toEqual([
      { kind: "fill", ref: "e-user", text: fakeCreds.username, origin: "https://portal.example.test" },
      { kind: "fill", ref: "e-pass", text: fakeCreds.password, origin: "https://portal.example.test" },
      { kind: "click", ref: "e-btn" },
    ]);
  });

  it("redacts secret values from error output if browser.act throws an error containing the secret", async () => {
    const browser = new FakeBrowserProvider();
    browser.act = vi.fn(async () => {
      throw new Error(`Failed to type sensitive value: ${fakeCreds.password}`);
    });

    const resolveSecretFill = vi.fn(async () => ({
      text: fakeCreds.password,
      origin: "https://portal.example.test",
    }));

    const result = (await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "fill_secret", ref: "e-pass", field: "password" }] },
      {
        resolveSecretFill,
        redactions: () => [fakeCreds.password],
      },
    )) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("[redacted]");
    expect(result.error).not.toContain(fakeCreds.password);
  });
});
