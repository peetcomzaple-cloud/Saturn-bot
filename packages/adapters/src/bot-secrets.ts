import { createHmac, randomBytes } from "node:crypto";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { BotSecretDestination } from "@rakazo/contracts";
import {
  BotSecretAuth,
  BotSecretName,
  botSecretDestinationSchema,
  commandVariableName,
  commandVariableProblem,
  decodeLoginSecret,
  isPrivateNetworkHost,
  SecretHttpRequest,
} from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { withTransactionRetry } from "@rakazo/db";
import { combineSignals, redactConnectorPayload } from "./connector-safety.js";
import type { RemoteTransportDependencies } from "./remote-mcp.js";
import { createPrivateNetworkFetch, createSafeRemoteFetch } from "./remote-mcp.js";
import { persistPreparedSecret } from "./secret-persistence.js";
import { readBodyCapped, withAbort } from "./web-ssrf.js";

export type BotSecretScope = { userId: string; spaceId: string; botId: string };
function scopeFields({ userId, spaceId, botId }: BotSecretScope): BotSecretScope {
  return { userId, spaceId, botId };
}

const metadata = { name: true, origin: true, auth: true } as const;

const UNUSABLE_CREDENTIAL = "Credential cannot be used with this authentication method";

/** `encodeURIComponent` throws on an unpaired surrogate. */
function percentEncoded(value: string): string | undefined {
  try {
    return encodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function commandRedactionForms(value: string): string[] {
  const forms = [value, Buffer.from(value).toString("base64")];
  const encoded = percentEncoded(value);
  if (encoded !== undefined) forms.push(encoded);
  return forms;
}

export function commandCredentialRedactions(environment: Record<string, string>): string[] {
  return [...new Set(Object.values(environment).flatMap(commandRedactionForms))];
}

function credentialHeader(destination: BotSecretDestination, plaintext: string) {
  // A login is only typed into its site, and a command variable only reaches shell commands.
  if (destination.auth.type === "login" || destination.auth.type === "command") {
    throw new Error("Credential cannot be used with this authentication method");
  }
  const name = destination.auth.type === "header" ? destination.auth.name : "Authorization";
  const value =
    destination.auth.type === "bearer"
      ? `Bearer ${plaintext}`
      : destination.auth.type === "basic"
        ? `Basic ${Buffer.from(`${destination.auth.username}:${plaintext}`).toString("base64")}`
        : plaintext;
  try {
    const headers = new Headers({ [name]: value });
    if (headers.get(name) !== value) throw new Error("Header value was normalized");
  } catch {
    throw new Error("Credential cannot be used with this authentication method");
  }
  return { name, value };
}

/** Owner escape enabling plain-HTTP origins on private LAN hosts (see #907). */
export function allowPrivateHttpSecretOrigins(): boolean {
  return process.env.RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP === "1";
}

export function normalizeSecretDestination(value: unknown): BotSecretDestination {
  const parsed = botSecretDestinationSchema({
    allowPrivateHttpOrigin: allowPrivateHttpSecretOrigins(),
  }).safeParse(value);
  if (!parsed.success) {
    // Surface the actual failing field: models (and people) supply all three
    // parts and still fail on a name character or an origin rule, and a
    // generic "specify name, origin, auth" error sends them retrying blind.
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "credential"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid credential destination — ${detail}`);
  }
  if (parsed.data.auth.type === "command") return parsed.data;
  return { ...parsed.data, origin: new URL(parsed.data.origin).origin };
}

function isCommandCredential(auth: unknown): boolean {
  const parsed = BotSecretAuth.safeParse(auth);
  return parsed.success && parsed.data.type === "command";
}

/**
 * What the bot's tools show for a saved credential. A command variable has no site, so it is
 * listed with the environment variable its shell commands read instead.
 */
export function botSecretToolView(row: { name: string; origin: string; auth: unknown }) {
  if (!isCommandCredential(row.auth)) return row;
  const variable = commandVariableName(row.name);
  const problem = commandVariableProblem(variable);
  if (problem === undefined) return { name: row.name, auth: row.auth, variable };
  const reason =
    problem === "reserved"
      ? `$${variable} is reserved and is not exported.`
      : `$${variable} is not a valid environment variable name and is not exported.`;
  return {
    name: row.name,
    auth: row.auth,
    error: `${reason} Remove it and save it under another name.`,
  };
}

/**
 * Decrypt this bot's command variables for one shell command. Loaded per command so an added,
 * replaced, or removed value applies to the next command. The values must never be logged or
 * returned; callers register them for redaction before the command runs.
 */
export async function loadBotCommandEnvironment(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  scope: BotSecretScope,
  unsetVariables?: Set<string>,
): Promise<Record<string, string>> {
  const rows = await prisma.botSecret.findMany({
    where: scopeFields(scope),
    select: { id: true, name: true, auth: true, ciphertext: true },
    orderBy: { name: "asc" },
    take: 100,
  });
  const environment: Record<string, string> = {};
  for (const row of rows) {
    if (!isCommandCredential(row.auth)) continue;
    const variable = commandVariableName(row.name);
    if (commandVariableProblem(variable)) continue;
    let value: string;
    try {
      value = await secretStore.load(row.ciphertext, row.id);
    } catch {
      // One unreadable value must not stop every shell command; the variable is left unset.
      unsetVariables?.add(variable);
      continue;
    }
    if (value && !value.includes("\0")) environment[variable] = value;
  }
  return environment;
}

/**
 * The environment for one shell command: the space variables, with this bot's command variables
 * loaded fresh over them (the bot's own value wins a name clash). The bot's values are handed to
 * `registerRedactions` before this returns, so the command's output is redacted.
 */
export async function shellCommandEnvironment(input: {
  prisma: PrismaClient;
  secretStore: Pick<SecretStore, "load">;
  scope: BotSecretScope;
  spaceEnvironment: Record<string, string>;
  registerRedactions: (values: string[]) => void;
}): Promise<{ env: Record<string, string>; unsetEnv: string[] }> {
  const unsetVariables = new Set<string>();
  const botEnvironment = await loadBotCommandEnvironment(
    input.prisma,
    input.secretStore,
    input.scope,
    unsetVariables,
  );
  // Encoded forms too, as secret_request does, so an accidental `base64` or URL-encoding of a
  // value is still redacted from command output.
  input.registerRedactions(commandCredentialRedactions(botEnvironment));
  const environment = { ...input.spaceEnvironment, ...botEnvironment };
  // A failed bot credential still shadows the space credential with the same name.
  for (const variable of unsetVariables) delete environment[variable];
  return { env: environment, unsetEnv: [...unsetVariables] };
}

/** Another command credential of this bot that is exported as the same variable. */
export async function findCommandVariableConflict(
  client: PrismaClient | Prisma.TransactionClient,
  scope: BotSecretScope,
  destination: BotSecretDestination,
): Promise<string | undefined> {
  if (destination.auth.type !== "command") return undefined;
  const variable = commandVariableName(destination.name);
  const rows = await client.botSecret.findMany({
    where: { ...scopeFields(scope), name: { not: destination.name } },
    select: { name: true, auth: true },
    take: 100,
  });
  return rows.find(
    (row) => isCommandCredential(row.auth) && commandVariableName(row.name) === variable,
  )?.name;
}

export type RequestSecretDestinationResult = {
  /** Metadata only. The protected value is never part of this result. */
  destination?: BotSecretDestination;
  connectionId?: string;
  oneUse?: boolean;
  origin?: string;
  error?: string;
};

/**
 * The model-facing schema is one object, so a credential often arrives beside
 * `connectionId`, as a JSON string, or as top-level `name` / `origin` / `auth`
 * instead of a nested `credential`. A destination that normalizes is the masked
 * reusable path. `connectionId` applies only when no credential was supplied.
 */
export function resolveRequestSecretDestination(
  args: Record<string, unknown>,
): RequestSecretDestinationResult {
  const purpose = typeof args.purpose === "string" ? args.purpose.trim() : "";
  const hasCredentialObject =
    (Object.hasOwn(args, "credential") && args.credential != null && args.credential !== "") ||
    (Object.hasOwn(args, "auth") && args.auth != null);
  const hasName = typeof args.name === "string" && args.name.trim().length > 0;

  if ((purpose === "login" || purpose === "password") && !hasCredentialObject && (!hasName || !args.auth)) {
    if (args.origin != null && String(args.origin).trim()) {
      try {
        const url = new URL(String(args.origin));
        if (url.protocol !== "https:") {
          return { error: "Website logins can only be filled on an HTTPS origin." };
        }
        return { oneUse: true, origin: url.origin };
      } catch {
        return { error: "Website logins can only be filled on an HTTPS origin." };
      }
    }
    return { oneUse: true, origin: undefined };
  }

  const credential = credentialArgument(args);
  if (credential !== undefined) {
    try {
      return { destination: normalizeSecretDestination(credential) };
    } catch (error) {
      return {
        error:
          error instanceof Error && error.message.startsWith("Invalid credential destination")
            ? error.message
            : "Specify a credential name, HTTPS origin, and auth method.",
      };
    }
  }
  const connectionId = connectionIdArgument(args.connectionId);
  if (connectionId) return { connectionId };
  return { error: "Provide either a reusable credential destination or a connectionId." };
}

const destinationFields = ["name", "origin", "auth"] as const;

/**
 * Credential object from `credential`, a JSON string of that object, or top-level fields.
 * Only destination metadata is returned. A partial `name` / `origin` / `auth` set is still
 * a credential attempt so it cannot fall through to `connectionId`.
 */
export function credentialArgument(args: Record<string, unknown>): unknown {
  if (Object.hasOwn(args, "credential") && args.credential != null && args.credential !== "") {
    return parsedCredentialObject(args.credential);
  }
  if (destinationFields.some((key) => Object.hasOwn(args, key))) {
    return destinationMetadata(args);
  }
  return undefined;
}

export function connectionIdArgument(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null" || trimmed === "undefined") return undefined;
  return trimmed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * `{ name, origin, auth }` only. Secret fields must not survive, including ones nested in
 * `auth` or carried in an origin string. The effect request is this object, and destination
 * parsing strips extras only from its own copy.
 */
function destinationMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const key of destinationFields) {
    if (!Object.hasOwn(record, key)) continue;
    if (key === "auth") {
      const auth = authMetadata(record.auth);
      if (auth !== undefined) metadata.auth = auth;
      continue;
    }
    if (key === "origin") {
      const origin = originMetadata(record.origin);
      if (origin !== undefined) metadata.origin = origin;
      continue;
    }
    if (typeof record.name === "string") {
      // Keep a real name. Anything else is replaced so a secret in that string is not recorded,
      // while destination validation still reports the name pattern.
      metadata.name = BotSecretName.safeParse(record.name).success ? record.name : "Invalid Name";
    }
  }
  return metadata;
}

/**
 * Parsed auth, or a stand-in that fails the same way. The stand-in does not copy the
 * original fields: an invalid method or header can still carry a secret, and the effect
 * row is written before destination validation.
 */
function authMetadata(value: unknown): unknown {
  const parsed = BotSecretAuth.safeParse(value);
  if (parsed.success) return parsed.data;
  if (!isPlainObject(value)) return undefined;
  if (value.type === "header") {
    if (typeof value.name !== "string") return { type: "header" };
    const header = BotSecretAuth.safeParse({ type: "header", name: value.name });
    const unsupported =
      !header.success &&
      header.error.issues.some((issue) => issue.message === "Unsupported credential header");
    return { type: "header", name: unsupported ? "Cookie" : "bad header" };
  }
  if (value.type === "basic") {
    if (typeof value.username !== "string") return { type: "basic" };
    return { type: "basic", username: ":" };
  }
  return { type: "invalid" };
}

/**
 * Keep a bare origin. Never return the raw string: `new URL` resolves `..`, so the raw
 * path can still hold a secret while the parsed path is `/`. Userinfo, query, fragment,
 * and a real path are removed. A placeholder keeps the origin error when no bare origin remains.
 */
function originMetadata(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "") return "";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "invalid-origin";
  }
  const bare = !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
  if (bare) return url.origin;
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.pathname === "/" ? url.origin : `${url.origin}/path`;
}

function parsedCredentialObject(value: unknown): unknown {
  if (typeof value !== "string") {
    // Not metadata. Keep the attempt, but do not forward the raw value into the effect.
    return isPlainObject(value) ? destinationMetadata(value) : {};
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isPlainObject(parsed)) return destinationMetadata(parsed);
  } catch {
    return {};
  }
  return {};
}

export function sameSecretDestination(
  left: BotSecretDestination,
  right: BotSecretDestination,
): boolean {
  return (
    left.name === right.name &&
    left.origin === right.origin &&
    JSON.stringify(left.auth) === JSON.stringify(right.auth)
  );
}

export async function findBotSecret(prisma: PrismaClient, scope: BotSecretScope, name: string) {
  const row = await prisma.botSecret.findFirst({
    where: { ...scopeFields(scope), name },
    select: metadata,
  });
  return row ? normalizeSecretDestination(row) : null;
}

export async function prepareBotSecret(input: {
  prisma: PrismaClient;
  secretStore: SecretStore;
  scope: BotSecretScope;
  destination: BotSecretDestination;
  plaintext: string;
}) {
  const { prisma, secretStore, scope, plaintext } = input;
  if (!plaintext || plaintext.length > 16_384) throw new Error("Invalid credential length");
  const destination = normalizeSecretDestination(input.destination);
  if (destination.auth.type === "login") decodeLoginSecret(plaintext);
  else if (destination.auth.type === "command") {
    // NUL cannot be an environment value. An unpaired surrogate cannot be percent-encoded
    // later, and that throw would abort every subsequent shell command for this bot.
    if (plaintext.includes("\0") || percentEncoded(plaintext) === undefined) {
      throw new Error(UNUSABLE_CREDENTIAL);
    }
  } else credentialHeader(destination, plaintext);
  const existing = await prisma.botSecret.findFirst({
    where: { ...scopeFields(scope), name: destination.name },
  });
  function validate(row: typeof existing, count: number) {
    if (row && !sameSecretDestination(normalizeSecretDestination(row), destination))
      throw new Error("Remove the existing credential before changing its destination");
    if (!row && count >= 100) throw new Error("Credential limit reached");
  }
  validate(existing, await prisma.botSecret.count({ where: scopeFields(scope) }));
  const id = existing?.id ?? randomBytes(12).toString("hex");
  const stored = await secretStore.put(
    plaintext,
    {
      operationId: id,
      traceId: id,
      userId: scope.userId,
      spaceId: scope.spaceId,
      signal: new AbortController().signal,
    },
    { recordId: id },
  );
  return {
    id,
    ciphertext: stored.ciphertext,
    async store(tx: Prisma.TransactionClient) {
      await tx.$queryRaw`SELECT id FROM bots WHERE id = ${scope.botId} FOR UPDATE`;
      const current = await tx.botSecret.findFirst({
        where: { ...scopeFields(scope), name: destination.name },
      });
      validate(current, await tx.botSecret.count({ where: scopeFields(scope) }));
      const conflict = await findCommandVariableConflict(tx, scope, destination);
      if (conflict) {
        throw new Error(
          `Invalid credential destination — name: ${conflict} is already exported as $${commandVariableName(destination.name)}`,
        );
      }
      if (current?.id !== existing?.id)
        throw Object.assign(new Error("Credential changed while saving; retry"), { code: "P2034" });
      if (current)
        await tx.botSecret.update({ where: { id }, data: { ciphertext: stored.ciphertext } });
      else
        await tx.botSecret.create({
          data: { id, ...scopeFields(scope), ...destination, ciphertext: stored.ciphertext },
        });
    },
  };
}

export async function storeBotSecret(input: Parameters<typeof prepareBotSecret>[0]) {
  return withTransactionRetry(async () => {
    const prepared = await prepareBotSecret(input);
    return persistPreparedSecret(input.prisma, input.secretStore, prepared, () =>
      input.prisma.$transaction(async (tx) => {
        await prepared.store(tx);
        return getBotSecretMetadata(tx, input.scope, input.destination.name);
      }),
    );
  });
}

export async function listBotSecrets(prisma: PrismaClient, scope: BotSecretScope) {
  const rows = await prisma.botSecret.findMany({
    where: scopeFields(scope),
    select: metadata,
    orderBy: { name: "asc" },
    take: 100,
  });
  return rows.map(botSecretToolView);
}

// Owner-facing view: destination and timestamps only, never the row id or ciphertext.
const ownerMetadata = { ...metadata, createdAt: true, updatedAt: true } as const;

export function listBotSecretMetadata(prisma: PrismaClient, scope: BotSecretScope) {
  return prisma.botSecret.findMany({
    where: scopeFields(scope),
    select: ownerMetadata,
    orderBy: { name: "asc" },
    take: 100,
  });
}

export function getBotSecretMetadata(
  client: PrismaClient | Prisma.TransactionClient,
  scope: BotSecretScope,
  name: string,
) {
  return client.botSecret.findFirst({
    where: { ...scopeFields(scope), name },
    select: ownerMetadata,
  });
}

export async function forgetBotSecret(prisma: PrismaClient, scope: BotSecretScope, name: string) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM bots WHERE id = ${scope.botId} FOR UPDATE`;
    await tx.botSecret.deleteMany({ where: { ...scopeFields(scope), name } });
  });
  return { removed: true };
}

/** Credentials are resolved only inside this destination-bound HTTP boundary. */
export async function requestWithBotSecret(input: {
  prisma: PrismaClient;
  secretStore: SecretStore;
  scope: BotSecretScope;
  request: unknown;
  signal: AbortSignal;
  remote?: RemoteTransportDependencies;
  registerRedactions?: (values: string[]) => void;
}): Promise<unknown> {
  const request = SecretHttpRequest.parse(input.request);
  const row = await input.prisma.botSecret.findFirst({
    where: { ...scopeFields(input.scope), name: request.name },
  });
  if (!row) return { error: "Credential is unavailable. Use request_secret to save it first." };
  const destination = normalizeSecretDestination(row);
  if (destination.auth.type === "login") {
    return { error: "Website logins can only be filled into their site with browser_act." };
  }
  if (destination.auth.type === "command") {
    return {
      error: `${UNUSABLE_CREDENTIAL}. Command variables are only available to shell commands, as $${commandVariableName(destination.name)}.`,
    };
  }
  const url = new URL(request.url);
  if (url.origin !== destination.origin || url.username || url.password || url.hash) {
    return { error: "This credential cannot be sent to that destination." };
  }
  const controller = new AbortController();
  const signal = combineSignals(input.signal, controller.signal, AbortSignal.timeout(30_000));
  const plaintext = await input.secretStore.load(row.ciphertext, {
    recordId: row.id,
    signal,
  });
  const headers = new Headers({ accept: "application/json", "content-type": request.contentType });
  const { name: headerName, value: headerValue } = credentialHeader(destination, plaintext);
  const redactions = [
    ...new Set([
      plaintext,
      headerValue,
      Buffer.from(plaintext).toString("base64"),
      encodeURIComponent(plaintext),
      headerValue.replace(/^Basic /, ""),
    ]),
  ].filter(Boolean);
  input.registerRedactions?.(redactions);
  // The safe fetch refuses plain-HTTP and private hosts outright. A credential
  // saved under the owner's private-HTTP opt-in was validated against exactly
  // those rules at save time, and the request URL is pinned to its origin, so
  // deliver it through the inverted transport instead — it re-checks that every
  // resolved address is private (metadata endpoints stay blocked) and pins the
  // connection to the validated answer.
  const privateHttpDestination =
    allowPrivateHttpSecretOrigins() &&
    url.protocol === "http:" &&
    isPrivateNetworkHost(url.hostname);
  const fetch = privateHttpDestination
    ? createPrivateNetworkFetch(input.remote?.fetch, input.remote?.resolveHostname)
    : createSafeRemoteFetch(input.remote?.fetch, input.remote?.resolveHostname);
  try {
    headers.set(headerName, headerValue);
    const response = await withAbort(
      fetch(url, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
        signal,
      }),
      signal,
    );
    const bytes = await readBodyCapped(response, 1_000_000, signal);
    const text = new TextDecoder().decode(bytes);
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* Plain text responses are supported. */
    }
    // Redact before truncating, so an output boundary cannot expose part of a value.
    const safe = JSON.stringify(redactConnectorPayload(body, redactions));
    return {
      status: response.status,
      body: safe.length > 20_000 ? safe.slice(0, 20_000) : JSON.parse(safe),
      truncated: safe.length > 20_000,
    };
  } catch {
    return { error: "Authenticated request failed. Check the destination and credential." };
  } finally {
    controller.abort();
    await withAbort(fetch.close(), AbortSignal.timeout(1000)).catch(() => undefined);
  }
}

export type LoginField = "username" | "password" | "totp";
const MIN_REDACTED_USERNAME = 6;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function parseOtpauthTotpUri(input: string): {
  secret: string;
  algorithm: "SHA1";
  digits: 6;
  period: 30;
} {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new Error("Invalid otpauth:// URI");
  }
  const type = (parsed.hostname || parsed.host || parsed.pathname.split("/").filter(Boolean)[0] || "").toLowerCase();
  if (parsed.protocol.toLowerCase() !== "otpauth:" || type !== "totp") {
    throw new Error(`Unsupported OTP URI type: ${type || "unknown"} (only totp is supported)`);
  }
  const secret = parsed.searchParams.get("secret")?.trim() ?? "";
  if (!secret) {
    throw new Error("Missing secret parameter in otpauth:// URI");
  }
  const rawAlg = parsed.searchParams.get("algorithm")?.trim();
  if (rawAlg && rawAlg.toUpperCase() !== "SHA1") {
    throw new Error(`Unsupported TOTP algorithm: ${rawAlg}`);
  }
  const rawDigits = parsed.searchParams.get("digits")?.trim();
  if (rawDigits && rawDigits !== "6") {
    throw new Error(`Unsupported TOTP digits: ${rawDigits}`);
  }
  const rawPeriod = parsed.searchParams.get("period")?.trim();
  if (rawPeriod && rawPeriod !== "30") {
    throw new Error(`Unsupported TOTP period: ${rawPeriod}`);
  }
  return { secret, algorithm: "SHA1", digits: 6, period: 30 };
}

export function decodeBase32Secret(input: string): Buffer {
  let raw = input.trim();
  if (raw.toLowerCase().startsWith("otpauth://")) {
    raw = parseOtpauthTotpUri(raw).secret;
  }
  const cleaned = raw.toUpperCase().replace(/[\s\-=]+/g, "");
  if (!cleaned) throw new Error("Empty TOTP secret");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(cleaned[i]!);
    if (idx < 0) throw new Error("Invalid Base32 character in TOTP secret");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (bytes.length === 0) throw new Error("Empty TOTP secret");
  return Buffer.from(bytes);
}

/**
 * Generates an RFC 6238 TOTP code (6 digits, 30s period, HMAC-SHA1) from a Base32 seed or otpauth:// URI.
 */
export function generateTotpCode(
  secretInput: string,
  timestampMs: number = Date.now(),
  periodSec = 30,
  digits = 6,
): string {
  if (!Number.isInteger(periodSec) || periodSec !== 30) {
    throw new Error(`Unsupported TOTP period: ${periodSec}`);
  }
  if (!Number.isInteger(digits) || digits !== 6) {
    throw new Error(`Unsupported TOTP digits: ${digits}`);
  }
  if (!Number.isFinite(timestampMs) || timestampMs < 0) {
    throw new Error("Invalid TOTP timestamp");
  }
  const key = decodeBase32Secret(secretInput);
  const counter = BigInt(Math.floor(timestampMs / 1000 / periodSec));
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counter, 0);
  const hmac = createHmac("sha1", key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  const mod = 10 ** digits;
  return String(binary % mod).padStart(digits, "0");
}

export function isOriginAllowedForLogin(
  primaryOrigin: string,
  currentOrigin: string,
  allowedOrigins?: string[],
): string | null {
  try {
    const cur = new URL(currentOrigin);
    if (cur.protocol !== "https:") return null;
    if (cur.origin === primaryOrigin) return cur.origin;
    if (Array.isArray(allowedOrigins)) {
      for (const candidate of allowedOrigins) {
        try {
          const parsed = new URL(candidate);
          if (parsed.protocol === "https:" && parsed.origin === cur.origin) {
            return cur.origin;
          }
        } catch {
          /* ignore malformed candidate */
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve one field of a saved website login for a page fill. The caller must pass `origin` to
 * the page browser, which refuses to fill unless the page is still on that origin.
 */
export async function resolveLoginFill(input: {
  prisma: PrismaClient;
  secretStore: SecretStore;
  scope: BotSecretScope;
  name?: string;
  runId?: string;
  field: LoginField;
  currentOrigin?: string;
}): Promise<{ text: string; origin: string; redactions: string[] } | { error: string }> {
  if (input.name) {
    const row = await input.prisma.botSecret.findFirst({
      where: { ...scopeFields(input.scope), name: input.name },
    });
    if (row) {
      if (isCommandCredential(row.auth)) {
        return {
          error: `${UNUSABLE_CREDENTIAL}. Command variables are only available to shell commands.`,
        };
      }
      // Checked on the stored origin itself, so the private-LAN HTTP allowance cannot widen a login.
      let storedOrigin: URL;
      try {
        storedOrigin = new URL(row.origin);
      } catch {
        return { error: "Website logins can only be filled on an HTTPS origin." };
      }
      if (storedOrigin.protocol !== "https:") {
        return { error: "Website logins can only be filled on an HTTPS origin." };
      }
      const destination = normalizeSecretDestination(row);
      if (destination.auth.type !== "login") {
        return { error: "This credential is not a website login." };
      }
      if (destination.origin !== storedOrigin.origin) {
        return { error: "Website logins can only be filled on an HTTPS origin." };
      }
      if (input.field !== "username" && input.field !== "password" && input.field !== "totp") {
        return { error: "field unavailable" };
      }
      const login = decodeLoginSecret(await input.secretStore.load(row.ciphertext, row.id));
      let effectiveOrigin = destination.origin;
      if (input.currentOrigin) {
        const matched = isOriginAllowedForLogin(
          destination.origin,
          input.currentOrigin,
          login.allowedOrigins,
        );
        if (!matched) return { error: "origin mismatch" };
        effectiveOrigin = matched;
      }
      const totpRedactions: string[] = [];
      if (login.totpSecret) {
        totpRedactions.push(login.totpSecret, encodeURIComponent(login.totpSecret));
        if (login.totpSecret.trim().toLowerCase().startsWith("otpauth://")) {
          try {
            const rawSeed = parseOtpauthTotpUri(login.totpSecret).secret;
            totpRedactions.push(rawSeed, encodeURIComponent(rawSeed));
          } catch {
            /* handled below when field === "totp" */
          }
        }
      }
      const baseRedactions = [
        ...new Set(
          [login.password, encodeURIComponent(login.password)]
            .concat(
              login.username.length >= MIN_REDACTED_USERNAME
                ? [login.username, encodeURIComponent(login.username)]
                : [],
            )
            .concat(totpRedactions),
        ),
      ];
      if (input.field === "totp") {
        if (!login.totpSecret) {
          return { error: "TOTP secret is not configured for this login." };
        }
        try {
          const code = generateTotpCode(login.totpSecret);
          return {
            text: code,
            origin: effectiveOrigin,
            redactions: [...new Set([...baseRedactions, code])],
          };
        } catch {
          return { error: "Invalid TOTP secret configured for this login." };
        }
      }
      return {
        text: login[input.field],
        origin: effectiveOrigin,
        // Redaction is substring replacement, so a short username would mangle unrelated text.
        redactions: baseRedactions,
      };
    }
  }

  // Fallback to one-use ephemeral secret for active run
  const runId = input.runId ?? (input.scope as any).id;
  if (runId) {
    const secretRow = await (input.prisma as any).secret?.findFirst?.({
      where: {
        spaceId: input.scope.spaceId,
        userId: input.scope.userId,
        kind: `run-secret:${runId}`,
      },
    });
    if (secretRow) {
      const effectRow = await (input.prisma as any).externalEffect?.findFirst?.({
        where: {
          spaceId: input.scope.spaceId,
          runId,
          kind: "request_secret",
          status: { in: ["approved", "completed", "executing"] },
        },
        orderBy: { createdAt: "desc" },
      });
      const resultObj =
        effectRow?.result && typeof effectRow.result === "object"
          ? (effectRow.result as Record<string, unknown>)
          : undefined;
      const argsObj =
        effectRow?.args && typeof effectRow.args === "object"
          ? (effectRow.args as Record<string, unknown>)
          : undefined;
      const originVal = resultObj?.origin ?? argsObj?.origin;
      if (!originVal || typeof originVal !== "string") {
        return { error: "Website logins can only be filled on an HTTPS origin." };
      }
      let storedOrigin: URL;
      try {
        storedOrigin = new URL(originVal);
      } catch {
        return { error: "Website logins can only be filled on an HTTPS origin." };
      }
      if (storedOrigin.protocol !== "https:") {
        return { error: "Website logins can only be filled on an HTTPS origin." };
      }
      if (input.field !== "username" && input.field !== "password" && input.field !== "totp") {
        return { error: "field unavailable" };
      }
      const plaintext = await input.secretStore.load(secretRow.ciphertext, secretRow.id);
      const login = decodeLoginSecret(plaintext);
      let effectiveOrigin = storedOrigin.origin;
      if (input.currentOrigin) {
        const matched = isOriginAllowedForLogin(
          storedOrigin.origin,
          input.currentOrigin,
          login.allowedOrigins,
        );
        if (!matched) return { error: "origin mismatch" };
        effectiveOrigin = matched;
      }
      const totpRedactions: string[] = [];
      if (login.totpSecret) {
        totpRedactions.push(login.totpSecret, encodeURIComponent(login.totpSecret));
        if (login.totpSecret.trim().toLowerCase().startsWith("otpauth://")) {
          try {
            const rawSeed = parseOtpauthTotpUri(login.totpSecret).secret;
            totpRedactions.push(rawSeed, encodeURIComponent(rawSeed));
          } catch {
            /* handled below when field === "totp" */
          }
        }
      }
      const baseRedactions = [
        ...new Set(
          [login.password, encodeURIComponent(login.password)]
            .concat(
              login.username.length >= MIN_REDACTED_USERNAME
                ? [login.username, encodeURIComponent(login.username)]
                : [],
            )
            .concat(totpRedactions),
        ),
      ];
      if (input.field === "totp") {
        if (!login.totpSecret) {
          return { error: "TOTP secret is not configured for this login." };
        }
        try {
          const code = generateTotpCode(login.totpSecret);
          return {
            text: code,
            origin: effectiveOrigin,
            redactions: [...new Set([...baseRedactions, code])],
          };
        } catch {
          return { error: "Invalid TOTP secret configured for this login." };
        }
      }
      return {
        text: login[input.field],
        origin: effectiveOrigin,
        redactions: baseRedactions,
      };
    }
  }

  return { error: "Login is unavailable. Use request_secret to save it first." };
}

