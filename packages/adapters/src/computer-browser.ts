import type {
  AdapterContext,
  BrowserActRequest,
  BrowserActResult,
  BrowserClearOriginStorageRequest,
  BrowserClearOriginStorageResult,
  BrowserNavigateRequest,
  BrowserNavigateResult,
  BrowserProvider,
  BrowserSnapshotNode,
  BrowserSnapshotRequest,
  BrowserSnapshotResult,
  ComputerRef,
  PageBrowserCommand,
  PageBrowserResult,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { FakeBrowserProvider, type FakeBrowserProviderOptions } from "./fake-browser.js";

const DETACHED_MESSAGE =
  "Page browser is not attached to this computer's Chrome. Use computer_act on the desktop browser instead.";

type LivePayload = Partial<PageBrowserResult>;

export type LivePageBrowserDriver = (
  computer: ComputerRef,
  request: PageBrowserCommand,
  context: AdapterContext,
) => Promise<LivePayload>;

function extractSnapshotMetadata(live?: LivePayload): Record<string, unknown> {
  if (!live || typeof live !== "object") return {};
  const raw = live as Record<string, unknown>;
  const extra: Record<string, unknown> = {};
  for (const key of [
    "isModal",
    "activeModal",
    "hasFrames",
    "hasClosedShadow",
    "coverage",
    "targetId",
    "openerTargetId",
    "frameId",
    "loaderId",
    "responseBodyText",
    "errorDocumentText",
    "errorDocumentStatus",
    "snapshotGeneration",
    "domGeneration",
    "tabs",
    "truncated",
    "totalTextLength",
    "scrollY",
    "scrollHeight",
    "viewportHeight",
    "readyState",
    "contentStatus",
    "httpStatus",
    "errorCode",
    "staleRefRejections",
  ]) {
    if (raw[key] !== undefined) {
      extra[key] = raw[key];
    }
  }
  return extra;
}

function extractNavigateMetadata(live?: LivePayload): Partial<BrowserNavigateResult> {
  if (!live || typeof live !== "object") return {};
  const meta: Partial<BrowserNavigateResult> = {};
  if (typeof live.httpStatus === "number" && Number.isInteger(live.httpStatus) && live.httpStatus > 0) {
    meta.httpStatus = live.httpStatus;
  }
  if (live.httpStatusStatus === "known" || live.httpStatusStatus === "unknown") {
    meta.httpStatusStatus = live.httpStatusStatus;
  }
  if (typeof live.loaderId === "string" && live.loaderId) meta.loaderId = live.loaderId;
  if (typeof live.frameId === "string" && live.frameId) meta.frameId = live.frameId;
  if (typeof live.redirected === "boolean") meta.redirected = live.redirected;
  if (Array.isArray(live.redirectChain)) meta.redirectChain = live.redirectChain;
  if (typeof live.challengeDetected === "boolean") meta.challengeDetected = live.challengeDetected;
  if (typeof live.challengeType === "string" && live.challengeType) {
    meta.challengeType = live.challengeType;
  }
  if (typeof live.retryAfterMs === "number" && Number.isFinite(live.retryAfterMs) && live.retryAfterMs >= 0) {
    meta.retryAfterMs = live.retryAfterMs;
  }
  return meta;
}

/**
 * Production page-browser adapter for the bot computer.
 *
 * Fake computers (and the fake sandbox) use the in-process DOM session.
 * Real computers drive the live Chrome already on the graphical display via
 * CDP (`rakazo-page-browser`). If that path cannot operate, return
 * `fallback: "computer_act"` — never report success against a detached DOM.
 */
export class ComputerBrowserProvider implements BrowserProvider {
  private readonly fake: FakeBrowserProvider;
  private readonly sandbox?: SandboxProvider;
  private readonly liveDriver?: LivePageBrowserDriver;

  constructor(
    options: FakeBrowserProviderOptions & {
      sandbox?: SandboxProvider;
      /** Test seam for the live CDP helper. */
      liveDriver?: LivePageBrowserDriver;
    } = {},
  ) {
    const { sandbox, liveDriver, ...fakeOptions } = options;
    this.sandbox = sandbox;
    this.liveDriver = liveDriver;
    this.fake = new FakeBrowserProvider(fakeOptions);
  }

  describe() {
    return {
      id: "computer",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        page: Boolean(
          this.liveDriver || this.sandbox?.pageBrowser || this.sandbox?.describe().id === "fake",
        ),
        refs: true,
        keyless: true,
      },
    };
  }

  async navigate(
    computer: ComputerRef,
    request: BrowserNavigateRequest,
    context: AdapterContext,
  ): Promise<BrowserNavigateResult> {
    if (this.canUseInProcess(computer)) {
      return this.fake.navigate(computer, request, context);
    }
    const live = await this.runLive(computer, { command: "navigate", url: request.url }, context);
    const extra = extractNavigateMetadata(live);
    if (live?.ok !== true || live.fallback === "computer_act") {
      return {
        url: typeof live?.url === "string" && live.url ? live.url : request.url,
        title: typeof live?.title === "string" ? live.title : "",
        ...extra,
        fallback: "computer_act",
        error: live?.error || DETACHED_MESSAGE,
      };
    }
    return {
      url: typeof live.url === "string" ? live.url : request.url,
      title: typeof live.title === "string" ? live.title : "",
      ...extra,
    };
  }

  async snapshot(
    computer: ComputerRef,
    request: BrowserSnapshotRequest,
    context: AdapterContext,
  ): Promise<BrowserSnapshotResult> {
    if (this.canUseInProcess(computer)) {
      return this.fake.snapshot(computer, request, context);
    }
    const live = await this.runLive(computer, { command: "snapshot" }, context);
    if (live?.ok !== true || live.fallback === "computer_act") {
      return {
        url: "",
        title: "",
        tree: "",
        elements: [],
        fallback: "computer_act",
        error: live?.error || DETACHED_MESSAGE,
      };
    }
    const elements = Array.isArray(live.elements) ? live.elements : [];
    const extraSnap = extractSnapshotMetadata(live);
    return {
      url: typeof live.url === "string" ? live.url : "",
      title: typeof live.title === "string" ? live.title : "",
      tree: typeof live.tree === "string" ? live.tree : formatTree(elements),
      elements,
      ...extraSnap,
    };
  }

  async act(
    computer: ComputerRef,
    request: BrowserActRequest,
    context: AdapterContext,
  ): Promise<BrowserActResult> {
    if (this.canUseInProcess(computer)) {
      return this.fake.act(computer, request, context);
    }
    const live = await this.runLive(
      computer,
      { command: "act", actions: request.actions },
      context,
    );
    const extraAct = extractSnapshotMetadata(live);
    if (live?.ok !== true || live.fallback === "computer_act") {
      return {
        ok: false,
        completed: typeof live?.completed === "number" ? live.completed : 0,
        uncertain: live?.uncertain ?? true,
        url: typeof live?.url === "string" ? live.url : "",
        title: typeof live?.title === "string" ? live.title : "",
        ...extraAct,
        fallback: "computer_act",
        error: live?.error || DETACHED_MESSAGE,
      };
    }
    const elements = Array.isArray(live.elements) ? live.elements : undefined;
    const downloads = Array.isArray(live.downloads) ? live.downloads : undefined;
    return {
      ok: true,
      completed: typeof live.completed === "number" ? live.completed : request.actions.length,
      url: typeof live.url === "string" ? live.url : "",
      title: typeof live.title === "string" ? live.title : "",
      tree: typeof live.tree === "string" ? live.tree : elements ? formatTree(elements) : undefined,
      elements,
      ...(downloads ? { downloads } : {}),
      ...extraAct,
    };
  }

  async clearOriginStorage(
    computer: ComputerRef,
    request: BrowserClearOriginStorageRequest,
    context: AdapterContext,
  ): Promise<BrowserClearOriginStorageResult> {
    let normalizedOrigin = request.origin;
    try {
      normalizedOrigin = new URL(request.origin).origin;
    } catch {
      // Keep raw origin if not parseable here; live helper or caller validates
    }
    const normalizedRequest: BrowserClearOriginStorageRequest = {
      ...request,
      origin: normalizedOrigin,
    };
    if (this.canUseInProcess(computer)) {
      return this.fake.clearOriginStorage(computer, normalizedRequest, context);
    }
    const live = await this.runLive(
      computer,
      {
        command: "clear_origin_storage",
        origin: normalizedOrigin,
        ...(request.storageKey !== undefined ? { storageKey: request.storageKey } : {}),
        ...(request.storageTypes !== undefined ? { storageTypes: request.storageTypes } : {}),
        ...(request.includeSessionStorage !== undefined
          ? { includeSessionStorage: request.includeSessionStorage }
          : {}),
        ...(request.includeSubdomainSharedCookies !== undefined
          ? { includeSubdomainSharedCookies: request.includeSubdomainSharedCookies }
          : {}),
      },
      context,
    );
    if (live?.ok !== true || live.fallback === "computer_act") {
      return {
        ok: false,
        origin: normalizedOrigin,
        fallback: "computer_act",
        error: live?.error || DETACHED_MESSAGE,
      };
    }
    const clearedTypes = Array.isArray(live.clearedStorageTypes)
      ? live.clearedStorageTypes
      : Array.isArray((live as { storageTypes?: BrowserClearOriginStorageResult["clearedStorageTypes"] }).storageTypes)
        ? (live as { storageTypes?: BrowserClearOriginStorageResult["clearedStorageTypes"] }).storageTypes
        : request.storageTypes;
    return {
      ok: true,
      origin: typeof live.origin === "string" ? live.origin : normalizedOrigin,
      ...(typeof live.storageKey === "string" ? { storageKey: live.storageKey } : {}),
      ...(clearedTypes !== undefined ? { clearedStorageTypes: clearedTypes } : {}),
      ...(typeof live.clearedSessionStorage === "boolean"
        ? { clearedSessionStorage: live.clearedSessionStorage }
        : {}),
      ...(typeof live.includeSubdomainSharedCookies === "boolean"
        ? { includeSubdomainSharedCookies: live.includeSubdomainSharedCookies }
        : {}),
      ...(typeof live.deletedCookies === "number" ? { deletedCookies: live.deletedCookies } : {}),
    };
  }

  async tabList(
    computer: ComputerRef,
    context: AdapterContext,
  ): Promise<Record<string, unknown>> {
    if (this.canUseInProcess(computer)) {
      return { ok: true, tabs: [] };
    }
    const live = await this.runLive(computer, { command: "tab_list" }, context);
    return live as Record<string, unknown>;
  }

  async tabClose(
    computer: ComputerRef,
    request: {
      targetId?: string;
      urlIncludes?: string;
      titleIncludes?: string;
      allowLastTab?: boolean;
    },
    context: AdapterContext,
  ): Promise<Record<string, unknown>> {
    if (this.canUseInProcess(computer)) {
      return { ok: true, closedTargetId: request.targetId, tabs: [] };
    }
    const live = await this.runLive(
      computer,
      {
        command: "tab_close",
        targetId: request.targetId,
        urlIncludes: request.urlIncludes,
        titleIncludes: request.titleIncludes,
        allowLastTab: request.allowLastTab,
      },
      context,
    );
    return live as Record<string, unknown>;
  }

  private canUseInProcess(computer: ComputerRef): boolean {
    return computer.kind === "fake";
  }

  private async runLive(
    computer: ComputerRef,
    request: PageBrowserCommand,
    context: AdapterContext,
  ): Promise<LivePayload> {
    context.signal.throwIfAborted();
    try {
      const result = this.liveDriver
        ? await this.liveDriver(computer, request, context)
        : this.sandbox?.pageBrowser
          ? await this.sandbox.pageBrowser(computer, request, context)
          : {
              ok: false,
              error: DETACHED_MESSAGE,
              fallback: "computer_act" as const,
              uncertain: false,
            };
      if (result?.ok === true) {
        if (
          ["navigate", "snapshot", "act"].includes(request.command) &&
          (typeof result.url !== "string" || typeof result.title !== "string")
        ) {
          throw new Error("Incomplete page browser response");
        }
        if (request.command === "tab_list" || request.command === "tab_close") {
          if (!Array.isArray(result.tabs)) throw new Error("Incomplete browser tab inventory");
          if (request.command === "tab_close" &&
              (typeof result.closedTargetId !== "string" || !result.closedTargetId ||
               (request.targetId && result.closedTargetId !== request.targetId) ||
               result.tabs.some((tab) => !tab || typeof tab !== "object" ||
                 (tab as { targetId?: unknown }).targetId === result.closedTargetId))) {
            throw new Error("Unconfirmed browser tab close");
          }
        }
        if (
          request.command === "clear_origin_storage" &&
          typeof result.origin !== "string"
        ) {
          throw new Error("Incomplete origin storage response");
        }
        if (
          request.command === "snapshot" &&
          (typeof result.tree !== "string" || !Array.isArray(result.elements))
        ) {
          throw new Error("Incomplete page snapshot");
        }
        if (
          request.command === "act" &&
          (!Number.isInteger(result.completed) ||
            result.completed !== request.actions.length ||
            result.uncertain)
        ) {
          throw new Error("Unconfirmed page actions");
        }
      }
      return result;
    } catch (error) {
      context.signal.throwIfAborted();
      return {
        uncertain:
          (request.command === "act" || request.command === "tab_close") &&
          !(
            error &&
            typeof error === "object" &&
            "failedBeforeDispatch" in error &&
            error.failedBeforeDispatch === true
          ),
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        fallback: "computer_act",
      };
    }
  }
}

function formatTree(elements: BrowserSnapshotNode[]): string {
  if (elements.length === 0) return "(no interactive elements)";
  return elements
    .map((el) => {
      const value =
        el.value !== undefined && el.value !== "" ? ` value=${JSON.stringify(el.value)}` : "";
      return `- ${el.role} "${el.name}" [${el.ref}]${value}`;
    })
    .join("\n");
}
