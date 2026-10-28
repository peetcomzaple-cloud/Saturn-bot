import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { encodeLoginSecret } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { resolveLoginFill, resolveRequestSecretDestination } from "./bot-secrets.js";
import { EncryptedSecretStore } from "./secrets.js";

type PrismaClient = any;

const secretStore = new EncryptedSecretStore("test-round4-encryption-key-origin-lifecycle");
const fakeCreds = {
  username: "test-admin-user",
  password: "super-secure-password-9876",
};

describe("round4-login-origin: login context and lifecycle preservation", () => {
  it("resolves one-use ephemeral secret for runId bound to HTTPS origin across 'completed' status", async () => {
    const scope = { userId: "user-4", spaceId: "space-4", botId: "bot-4", id: "run-4" };
    const plaintext = encodeLoginSecret(fakeCreds);
    const encrypted = await secretStore.put(
      plaintext,
      { ...scope, operationId: "op-4", traceId: "tr-4", signal: new AbortController().signal },
      { recordId: "secret-round4-one-use" },
    );

    const secretRow = {
      id: "secret-round4-one-use",
      userId: scope.userId,
      spaceId: scope.spaceId,
      kind: `run-secret:${scope.id}`,
      ciphertext: encrypted.ciphertext,
      createdAt: new Date(),
    };

    // Note: status is "completed", mimicking the real incident transition!
    const effectRow = {
      id: "eff-completed-1",
      runId: scope.id,
      spaceId: scope.spaceId,
      kind: "request_secret",
      status: "completed",
      result: { ok: true, submitted: true, oneUse: true, origin: "https://auth.company.test" },
      createdAt: new Date(),
    };

    const prisma = {
      botSecret: { findFirst: vi.fn().mockResolvedValue(null) },
      secret: { findFirst: vi.fn().mockResolvedValue(secretRow) },
      externalEffect: { findFirst: vi.fn().mockResolvedValue(effectRow) },
    } as unknown as PrismaClient;

    // Step 1: Fill username on correct origin
    const resolvedUser = await resolveLoginFill({
      prisma,
      secretStore,
      scope,
      runId: scope.id,
      field: "username",
      currentOrigin: "https://auth.company.test",
    });

    expect(resolvedUser).toEqual({
      text: fakeCreds.username,
      origin: "https://auth.company.test",
      redactions: expect.arrayContaining([fakeCreds.username, fakeCreds.password]),
    });

    // Step 2: Fill password on correct origin in subsequent step of same run
    const resolvedPass = await resolveLoginFill({
      prisma,
      secretStore,
      scope,
      runId: scope.id,
      field: "password",
      currentOrigin: "https://auth.company.test",
    });

    expect(resolvedPass).toEqual({
      text: fakeCreds.password,
      origin: "https://auth.company.test",
      redactions: expect.arrayContaining([fakeCreds.username, fakeCreds.password]),
    });
  });

  it("detects origin mismatch when current page origin does not match stored origin", async () => {
    const scope = { userId: "user-4", spaceId: "space-4", botId: "bot-4", id: "run-4" };
    const plaintext = encodeLoginSecret(fakeCreds);
    const encrypted = await secretStore.put(
      plaintext,
      { ...scope, operationId: "op-4", traceId: "tr-4", signal: new AbortController().signal },
      { recordId: "secret-round4-origin-check" },
    );

    const secretRow = {
      id: "secret-round4-origin-check",
      userId: scope.userId,
      spaceId: scope.spaceId,
      kind: `run-secret:${scope.id}`,
      ciphertext: encrypted.ciphertext,
      createdAt: new Date(),
    };

    const effectRow = {
      id: "eff-completed-2",
      runId: scope.id,
      spaceId: scope.spaceId,
      kind: "request_secret",
      status: "completed",
      result: { ok: true, submitted: true, oneUse: true, origin: "https://auth.company.test" },
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
      field: "password",
      currentOrigin: "https://attacker.evil.test",
    });

    expect(res).toEqual({ error: "origin mismatch" });
  });

  it("rejects non-HTTPS origin in effect metadata", async () => {
    const scope = { userId: "user-4", spaceId: "space-4", botId: "bot-4", id: "run-4" };
    const plaintext = encodeLoginSecret(fakeCreds);
    const encrypted = await secretStore.put(
      plaintext,
      { ...scope, operationId: "op-4", traceId: "tr-4", signal: new AbortController().signal },
      { recordId: "secret-round4-http" },
    );

    const secretRow = {
      id: "secret-round4-http",
      userId: scope.userId,
      spaceId: scope.spaceId,
      kind: `run-secret:${scope.id}`,
      ciphertext: encrypted.ciphertext,
      createdAt: new Date(),
    };

    const effectRow = {
      id: "eff-completed-3",
      runId: scope.id,
      spaceId: scope.spaceId,
      kind: "request_secret",
      status: "completed",
      result: { ok: true, submitted: true, oneUse: true, origin: "http://insecure.site.test" },
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
      field: "password",
    });

    expect(res).toEqual({ error: "Website logins can only be filled on an HTTPS origin." });
  });

  it("enforces runId isolation: cannot read one-use secret from another run", async () => {
    const scope = { userId: "user-4", spaceId: "space-4", botId: "bot-4", id: "run-4" };

    const prisma = {
      botSecret: { findFirst: vi.fn().mockResolvedValue(null) },
      // Mock findFirst checking runId: only returns row for "run-different"
      secret: {
        findFirst: vi.fn().mockImplementation(async ({ where }) => {
          if (where.kind === "run-secret:run-different") {
            return { id: "secret-other", ciphertext: "encrypted-val" };
          }
          return null;
        }),
      },
      externalEffect: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;

    const res = await resolveLoginFill({
      prisma,
      secretStore,
      scope,
      runId: scope.id,
      field: "username",
    });

    expect(res).toEqual({ error: "Login is unavailable. Use request_secret to save it first." });
  });

  it("returns field unavailable when field is not username or password", async () => {
    const scope = { userId: "user-4", spaceId: "space-4", botId: "bot-4", id: "run-4" };
    const plaintext = encodeLoginSecret(fakeCreds);
    const encrypted = await secretStore.put(
      plaintext,
      { ...scope, operationId: "op-4", traceId: "tr-4", signal: new AbortController().signal },
      { recordId: "secret-round4-field" },
    );

    const secretRow = {
      id: "secret-round4-field",
      userId: scope.userId,
      spaceId: scope.spaceId,
      kind: `run-secret:${scope.id}`,
      ciphertext: encrypted.ciphertext,
      createdAt: new Date(),
    };

    const effectRow = {
      id: "eff-completed-4",
      runId: scope.id,
      spaceId: scope.spaceId,
      kind: "request_secret",
      status: "completed",
      result: { ok: true, submitted: true, oneUse: true, origin: "https://auth.company.test" },
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
      field: "token" as any,
    });

    expect(res).toEqual({ error: "field unavailable" });
  });
});
