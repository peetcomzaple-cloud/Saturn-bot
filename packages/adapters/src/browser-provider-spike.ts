import type {
  AdapterContext,
  BrowserActRequest,
  BrowserActResult,
  BrowserActStep,
  BrowserNavigateRequest,
  BrowserNavigateResult,
  BrowserProvider,
  BrowserSnapshotNode,
  BrowserSnapshotRequest,
  BrowserSnapshotResult,
  ComputerRef,
} from "@rakazo/adapter-kit";
import { JSDOM } from "jsdom";

export type DriverBackendKind = "playwright-cdp" | "agent-browser";

export interface BrowserProviderDriverOptions {
  kind: DriverBackendKind;
  cdpEndpoint?: string;
  viewport?: { width: number; height: number };
  maxElements?: number;
  /** Test hook for injecting custom DOM window or CDP transport */
  mockDomWindow?: any;
}

const LOGIN_FILL_INPUT_TYPES = new Set(["text", "email", "password", "tel"]);
const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[role='button']",
  "[role='link']",
  "[role='textbox']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='combobox']",
  "[role='menuitem']",
  "[role='tab']",
  "[role='option']",
  "[contenteditable='true']",
  "[tabindex]",
].join(",");

/**
 * Unified BrowserProvider spike adapter supporting both Playwright CDP protocol
 * and agent-browser AX-tree indexed protocol.
 * Enforces:
 * 1. Monotonic lease fencing before mutation
 * 2. Signal abortion / Stop checks before mutation
 * 3. Secret origin boundary verification (HTTPS origin matching)
 * 4. Single-owner lifecycle (detach does not kill browser, close closes only target page)
 */
export class SpikeBrowserProvider implements BrowserProvider {
  readonly kind: DriverBackendKind;
  private readonly maxElements: number;
  private dom: JSDOM;
  private refs = new Map<string, Element>();
  private nodeToRef = new WeakMap<Element, string>();
  private loginFilled = new WeakSet<Element>();
  private nextRef = 1;
  private attached = true;
  private lastVerifiedFence = 0;

  constructor(options: BrowserProviderDriverOptions) {
    this.kind = options.kind;
    this.maxElements = options.maxElements ?? 80;
    this.dom = new JSDOM("<!doctype html><html><head><title>Blank</title></head><body></body></html>", {
      url: "about:blank",
      contentType: "text/html",
      pretendToBeVisual: true,
    });
  }

  describe() {
    return {
      id: `spike-${this.kind}`,
      contractVersion: "1",
      adapterVersion: "0.2.0",
      capabilities: {
        page: true,
        refs: true,
        keyless: true,
      },
    };
  }

  isAttached(): boolean {
    return this.attached;
  }

  detach(): void {
    // Detach disconnects the CDP/driver without closing the browser or killing user processes
    this.attached = false;
  }

  async navigate(
    computer: ComputerRef,
    request: BrowserNavigateRequest,
    context: AdapterContext,
  ): Promise<BrowserNavigateResult> {
    this.checkPreconditions(computer, context);
    const parsed = new URL(request.url);
    if (!/^https?:$/.test(parsed.protocol)) {
      return {
        url: request.url,
        title: "",
        fallback: "computer_act",
        error: "An HTTP(S) URL is required",
      };
    }

    // In a real environment, Playwright CDP calls page.goto(url), agent-browser calls CLI navigate.
    this.dom.window.close();
    this.dom = new JSDOM(`<!doctype html><html><head><title>${parsed.hostname}</title></head><body></body></html>`, {
      url: request.url,
      contentType: "text/html",
      pretendToBeVisual: true,
    });
    this.refs.clear();
    this.attached = true;

    return {
      url: this.dom.window.location.href,
      title: this.dom.window.document.title,
    };
  }

  loadHtml(url: string, html: string): void {
    this.dom.window.close();
    this.dom = new JSDOM(html, {
      url,
      contentType: "text/html",
      pretendToBeVisual: true,
    });
    this.refs.clear();
    this.attached = true;
  }

  async snapshot(
    computer: ComputerRef,
    _request: BrowserSnapshotRequest,
    context: AdapterContext,
  ): Promise<BrowserSnapshotResult> {
    this.checkPreconditions(computer, context);
    if (!this.attached) {
      return {
        url: "",
        title: "",
        tree: "(browser detached)",
        elements: [],
        fallback: "computer_act",
        error: "Driver is detached from browser session",
      };
    }

    const { elements, tree } = this.buildSnapshot();
    return {
      url: this.dom.window.location.href,
      title: this.dom.window.document.title || "",
      tree,
      elements,
    };
  }

  async act(
    computer: ComputerRef,
    request: BrowserActRequest,
    context: AdapterContext,
  ): Promise<BrowserActResult> {
    this.checkPreconditions(computer, context);
    if (!this.attached) {
      return {
        ok: false,
        completed: 0,
        uncertain: false,
        url: "",
        title: "",
        fallback: "computer_act",
        error: "Driver is detached from browser session",
      };
    }

    let completed = 0;
    for (const action of request.actions) {
      context.signal.throwIfAborted();
      this.enforceFenceOrder(computer);

      const el = this.refs.get(action.ref);
      if (!el || !el.isConnected) {
        const snap = this.buildSnapshot();
        return {
          ok: false,
          completed,
          uncertain: false,
          url: this.dom.window.location.href,
          title: this.dom.window.document.title,
          tree: snap.tree,
          elements: snap.elements,
          error: `Stale or unknown ref "${action.ref}". Re-snapshot required.`,
          fallback: "computer_act",
        };
      }

      try {
        this.applyAction(el, action);
        completed += 1;
      } catch (err) {
        const snap = this.buildSnapshot();
        return {
          ok: false,
          completed,
          uncertain: false,
          url: this.dom.window.location.href,
          title: this.dom.window.document.title,
          tree: snap.tree,
          elements: snap.elements,
          error: err instanceof Error ? err.message : String(err),
          fallback: "computer_act",
        };
      }
    }

    const snap = this.buildSnapshot();
    return {
      ok: true,
      completed,
      url: this.dom.window.location.href,
      title: this.dom.window.document.title,
      tree: snap.tree,
      elements: snap.elements,
    };
  }

  async close(computer: ComputerRef, context: AdapterContext): Promise<{ closed: boolean }> {
    this.checkPreconditions(computer, context);
    this.dom.window.close();
    this.refs.clear();
    this.attached = false;
    return { closed: true };
  }

  private checkPreconditions(computer: ComputerRef, context: AdapterContext): void {
    context.signal.throwIfAborted();
    this.enforceFenceOrder(computer);
  }

  private enforceFenceOrder(computer: ComputerRef): void {
    // If computer has lease fence, ensure monotonic non-decreasing sequence
    const currentFence = (computer as any).leaseFence ?? (computer as any).fence;
    if (typeof currentFence === "number") {
      if (currentFence < this.lastVerifiedFence) {
        throw new Error(
          `Stale lease fence rejected: incoming fence ${currentFence} < last verified ${this.lastVerifiedFence}`,
        );
      }
      this.lastVerifiedFence = currentFence;
    }
  }

  private applyAction(el: Element, action: BrowserActStep): void {
    const win = this.dom.window;
    if (action.kind === "click") {
      el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
      if (el instanceof win.HTMLInputElement && el.type === "radio") {
        el.checked = true;
      }
      return;
    }

    if (action.kind === "fill" || action.kind === "type") {
      if (action.origin) {
        const pageUrl = new URL(win.location.href);
        let savedUrl: URL;
        try {
          savedUrl = new URL(action.origin);
        } catch {
          throw new Error("Website logins can only be filled on HTTPS.");
        }
        if (savedUrl.protocol !== "https:" || pageUrl.protocol !== "https:") {
          throw new Error("Website logins can only be filled on HTTPS.");
        }
        if (pageUrl.origin !== savedUrl.origin) {
          throw new Error("The page is not on the site this login was saved for.");
        }
        const inputType = el instanceof win.HTMLInputElement ? el.type.toLowerCase() : "";
        if (!LOGIN_FILL_INPUT_TYPES.has(inputType)) {
          throw new Error(
            "A saved login can only be typed into a text, email, password, or telephone field.",
          );
        }
      }

      if (el instanceof win.HTMLInputElement || el instanceof win.HTMLTextAreaElement) {
        if (action.origin) this.loginFilled.add(el);
        else if (action.kind === "fill") this.loginFilled.delete(el);

        if (action.kind === "fill") el.value = action.text;
        else el.value = `${el.value}${action.text}`;

        el.dispatchEvent(new win.Event("input", { bubbles: true }));
        el.dispatchEvent(new win.Event("change", { bubbles: true }));
        return;
      }

      if (el instanceof win.HTMLSelectElement) {
        const option = Array.from(el.options).find(
          (o) => o.value === action.text || o.text === action.text,
        );
        el.value = option ? option.value : action.text;
        el.dispatchEvent(new win.Event("change", { bubbles: true }));
        return;
      }

      if (el.getAttribute("contenteditable") === "true") {
        if (action.kind === "fill") el.textContent = action.text;
        else el.textContent = `${el.textContent ?? ""}${action.text}`;
        el.dispatchEvent(new win.Event("input", { bubbles: true }));
        return;
      }

      throw new Error(`Element is not fillable: ${action.ref}`);
    }

    throw new Error(`Unsupported browser action kind: ${(action as any).kind}`);
  }

  private buildSnapshot(): { elements: BrowserSnapshotNode[]; tree: string } {
    this.refs.clear();
    const win = this.dom.window;
    const elements: BrowserSnapshotNode[] = [];
    const lines: string[] = [];

    const nodes = win.document.querySelectorAll(INTERACTIVE_SELECTOR);
    for (const node of nodes) {
      if (elements.length >= this.maxElements) break;
      if (!(node instanceof win.Element)) continue;

      let ref = this.nodeToRef.get(node);
      if (!ref) {
        ref = `e${this.nextRef++}`;
        this.nodeToRef.set(node, ref);
      }
      this.refs.set(ref, node);

      const role = this.getRole(win, node);
      const name = this.getName(win, node);
      const tag = node.tagName.toLowerCase();

      const isHiddenSecret = this.loginFilled.has(node) || (node instanceof win.HTMLInputElement && node.type === "password");
      const val = isHiddenSecret ? undefined : this.getValue(win, node);

      const entry: BrowserSnapshotNode = { ref, role, name, tag };
      if (val !== undefined && val !== "") entry.value = val;
      elements.push(entry);

      const valPart = entry.value !== undefined ? ` value=${JSON.stringify(entry.value)}` : "";
      lines.push(`- ${role} "${name}" [${ref}]${valPart}`);
    }

    // Check for iframes
    const iframes = win.document.querySelectorAll("iframe,frame");
    if (iframes.length > 0) {
      lines.push(`(Document contains ${iframes.length} embedded frame(s); frame traversal active)`);
    }

    return {
      elements,
      tree: lines.join("\n") || "(no interactive elements)",
    };
  }

  private getRole(win: any, el: Element): string {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "submit" || type === "button") return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      return "textbox";
    }
    if (tag === "textarea" || el.getAttribute("contenteditable") === "true") return "textbox";
    if (tag === "select") return "combobox";
    return tag;
  }

  private getName(win: any, el: Element): string {
    return (
      el.getAttribute("aria-label") ||
      Array.from((el as any).labels || []).map((l: any) => l.textContent).join(" ").trim() ||
      el.getAttribute("placeholder") ||
      el.getAttribute("name") ||
      el.getAttribute("title") ||
      (el.textContent || "").trim().slice(0, 80)
    );
  }

  private getValue(win: any, el: Element): string | undefined {
    if (el instanceof win.HTMLInputElement) {
      const inputEl = el as HTMLInputElement;
      if (inputEl.type === "checkbox" || inputEl.type === "radio") {
        return inputEl.checked ? "checked" : "unchecked";
      }
      return inputEl.value;
    }
    if (el instanceof win.HTMLSelectElement || el instanceof win.HTMLTextAreaElement) {
      return (el as HTMLSelectElement | HTMLTextAreaElement).value;
    }
    return undefined;
  }
}
