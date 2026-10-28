import { describe, expect, it } from "vitest";
import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { SpikeBrowserProvider, type DriverBackendKind } from "./browser-provider-spike.js";

function makeContext(signal?: AbortSignal): AdapterContext {
  return {
    operationId: "test-op",
    traceId: "test-trace",
    spaceId: "space-1",
    userId: "user-1",
    signal: signal ?? new AbortController().signal,
  };
}

function makeComputer(fence?: number): ComputerRef {
  return {
    id: "test-computer-1",
    botId: "bot-1",
    kind: "docker",
    scope: "dedicated",
    leaseFence: fence,
  } as any;
}

const DRIVER_KINDS: DriverBackendKind[] = ["playwright-cdp", "agent-browser"];

describe.each(DRIVER_KINDS)("SpikeBrowserProvider [%s]", (driverKind) => {
  it("F1: builds snapshot with interactive elements, roles, names, and stable refs", async () => {
    const provider = new SpikeBrowserProvider({ kind: driverKind });
    provider.loadHtml(
      "https://example.com/form",
      `
      <!doctype html>
      <html>
        <head><title>Form Example</title></head>
        <body>
          <header><a href="/home">Home</a></header>
          <main>
            <h1>Test Title</h1>
            <label for="uname">Username</label>
            <input id="uname" type="text" value="existing_user" />
            <button id="btn-submit">Submit Form</button>
          </main>
        </body>
      </html>
      `,
    );

    const ctx = makeContext();
    const comp = makeComputer(1);
    const snap = await provider.snapshot(comp, {}, ctx);

    expect(snap.url).toBe("https://example.com/form");
    expect(snap.title).toBe("Form Example");
    expect(snap.elements.length).toBe(3); // link, input, button

    const link = snap.elements.find((e) => e.role === "link");
    expect(link).toBeDefined();
    expect(link?.name).toBe("Home");

    const input = snap.elements.find((e) => e.role === "textbox");
    expect(input).toBeDefined();
    expect(input?.value).toBe("existing_user");

    const btn = snap.elements.find((e) => e.role === "button");
    expect(btn).toBeDefined();
    expect(btn?.name).toBe("Submit Form");
  });

  it("F2: disambiguates elements with identical labels using unique refs", async () => {
    const provider = new SpikeBrowserProvider({ kind: driverKind });
    provider.loadHtml(
      "https://example.com/products",
      `
      <html>
        <body>
          <div class="card">
            <h2>Item A</h2>
            <button class="buy">Add to Cart</button>
          </div>
          <div class="card">
            <h2>Item B</h2>
            <button class="buy">Add to Cart</button>
          </div>
        </body>
      </html>
      `,
    );

    const ctx = makeContext();
    const comp = makeComputer(1);
    const snap = await provider.snapshot(comp, {}, ctx);

    const buttons = snap.elements.filter((e) => e.name === "Add to Cart");
    expect(buttons.length).toBe(2);
    expect(buttons[0]!.ref).not.toBe(buttons[1]!.ref);
  });

  it("F3: clicks and selects combobox options correctly", async () => {
    const provider = new SpikeBrowserProvider({ kind: driverKind });
    provider.loadHtml(
      "https://example.com/select",
      `
      <html>
        <body>
          <select id="country">
            <option value="th">Thailand</option>
            <option value="jp">Japan</option>
            <option value="us">United States</option>
          </select>
          <input type="checkbox" id="terms" />
          <label for="terms">Accept terms</label>
        </body>
      </html>
      `,
    );

    const ctx = makeContext();
    const comp = makeComputer(1);
    const snap1 = await provider.snapshot(comp, {}, ctx);

    const selectEl = snap1.elements.find((e) => e.role === "combobox");
    const checkEl = snap1.elements.find((e) => e.role === "checkbox");
    expect(selectEl).toBeDefined();
    expect(checkEl).toBeDefined();

    // Select Japan and check terms
    const actResult = await provider.act(
      comp,
      {
        actions: [
          { kind: "fill", ref: selectEl!.ref, text: "Japan" },
          { kind: "click", ref: checkEl!.ref },
        ],
      },
      ctx,
    );

    expect(actResult.ok).toBe(true);
    expect(actResult.completed).toBe(2);

    const snap2 = await provider.snapshot(comp, {}, ctx);
    const updatedSelect = snap2.elements.find((e) => e.role === "combobox");
    const updatedCheck = snap2.elements.find((e) => e.role === "checkbox");
    expect(updatedSelect?.value).toBe("jp");
    expect(updatedCheck?.value).toBe("checked");
  });

  it("F4: enforces secret origin boundaries and redacts credentials from snapshots", async () => {
    const provider = new SpikeBrowserProvider({ kind: driverKind });
    provider.loadHtml(
      "https://login.example.com/signin",
      `
      <html>
        <body>
          <form>
            <input id="u" type="text" placeholder="Username" />
            <input id="p" type="password" placeholder="Password" />
          </form>
        </body>
      </html>
      `,
    );

    const ctx = makeContext();
    const comp = makeComputer(1);
    const snap1 = await provider.snapshot(comp, {}, ctx);

    const uInput = snap1.elements.find((e) => e.name === "Username");
    const pInput = snap1.elements.find((e) => e.name === "Password");
    expect(uInput).toBeDefined();
    expect(pInput).toBeDefined();

    // 1. Rejects wrong origin
    const wrongOriginRes = await provider.act(
      comp,
      {
        actions: [
          {
            kind: "fill",
            ref: pInput!.ref,
            text: "secret-pass-123",
            origin: "https://attacker.example.com",
          },
        ],
      },
      ctx,
    );
    expect(wrongOriginRes.ok).toBe(false);
    expect(wrongOriginRes.error).toContain("The page is not on the site this login was saved for");

    // 2. Rejects HTTP (non-secure) origin
    const httpOriginRes = await provider.act(
      comp,
      {
        actions: [
          {
            kind: "fill",
            ref: pInput!.ref,
            text: "secret-pass-123",
            origin: "http://login.example.com",
          },
        ],
      },
      ctx,
    );
    expect(httpOriginRes.ok).toBe(false);
    expect(httpOriginRes.error).toContain("Website logins can only be filled on HTTPS");

    // 3. Fills on valid origin
    const validFillRes = await provider.act(
      comp,
      {
        actions: [
          {
            kind: "fill",
            ref: uInput!.ref,
            text: "admin",
            origin: "https://login.example.com",
          },
          {
            kind: "fill",
            ref: pInput!.ref,
            text: "secret-pass-123",
            origin: "https://login.example.com",
          },
        ],
      },
      ctx,
    );
    expect(validFillRes.ok).toBe(true);
    expect(validFillRes.completed).toBe(2);

    // 4. In subsequent snapshot, password and origin-filled values MUST be undefined
    const snap2 = await provider.snapshot(comp, {}, ctx);
    const uAfter = snap2.elements.find((e) => e.name === "Username");
    const pAfter = snap2.elements.find((e) => e.name === "Password");
    expect(uAfter?.value).toBeUndefined();
    expect(pAfter?.value).toBeUndefined();
    expect(snap2.tree).not.toContain("secret-pass-123");
  });

  it("F5: rejects stale refs when DOM is re-rendered and prompts re-snapshot", async () => {
    const provider = new SpikeBrowserProvider({ kind: driverKind });
    provider.loadHtml(
      "https://example.com/dynamic",
      `
      <html>
        <body>
          <div id="container">
            <button id="b1">Step 1</button>
          </div>
        </body>
      </html>
      `,
    );

    const ctx = makeContext();
    const comp = makeComputer(1);
    const snap1 = await provider.snapshot(comp, {}, ctx);
    const oldRef = snap1.elements[0]!.ref;

    // Simulate SPA DOM replacement
    provider.loadHtml(
      "https://example.com/dynamic",
      `
      <html>
        <body>
          <div id="container">
            <button id="b2">Step 2</button>
          </div>
        </body>
      </html>
      `,
    );

    // Trying to use oldRef from previous DOM must fail safely
    const actResult = await provider.act(
      comp,
      {
        actions: [{ kind: "click", ref: oldRef }],
      },
      ctx,
    );

    expect(actResult.ok).toBe(false);
    expect(actResult.completed).toBe(0);
    expect(actResult.error).toContain("Stale or unknown ref");
  });

  it("F6: detects iframes and includes notice in tree", async () => {
    const provider = new SpikeBrowserProvider({ kind: driverKind });
    provider.loadHtml(
      "https://example.com/frames",
      `
      <html>
        <body>
          <button>Main Button</button>
          <iframe src="https://example.com/nested"></iframe>
        </body>
      </html>
      `,
    );

    const ctx = makeContext();
    const comp = makeComputer(1);
    const snap = await provider.snapshot(comp, {}, ctx);

    expect(snap.tree.toLowerCase()).toContain("embedded frame(s)");
  });

  it("F7: rejects stale lease fence and aborted signals before mutation", async () => {
    const provider = new SpikeBrowserProvider({ kind: driverKind });
    provider.loadHtml("https://example.com", "<html><body><button>Click</button></body></html>");

    const ctx = makeContext();
    // 1. Observe with fence 10
    const compFence10 = makeComputer(10);
    const snap = await provider.snapshot(compFence10, {}, ctx);
    const ref = snap.elements[0]!.ref;

    // 2. Incoming delayed request with stale fence 9
    const compFence9 = makeComputer(9);
    await expect(
      provider.act(compFence9, { actions: [{ kind: "click", ref }] }, ctx),
    ).rejects.toThrow(/Stale lease fence rejected/);

    // 3. Aborted signal (Stop/Takeover)
    const abortCtrl = new AbortController();
    abortCtrl.abort();
    const abortedCtx = makeContext(abortCtrl.signal);
    await expect(
      provider.act(compFence10, { actions: [{ kind: "click", ref }] }, abortedCtx),
    ).rejects.toThrow();
  });

  it("F8: detach does not destroy browser; close shuts down target session", async () => {
    const provider = new SpikeBrowserProvider({ kind: driverKind });
    provider.loadHtml("https://example.com", "<html><body><button>Click</button></body></html>");

    const ctx = makeContext();
    const comp = makeComputer(1);

    // Detach
    provider.detach();
    expect(provider.isAttached()).toBe(false);
    const detachedSnap = await provider.snapshot(comp, {}, ctx);
    expect(detachedSnap.error).toContain("Driver is detached");

    // Close
    const closeRes = await provider.close(comp, ctx);
    expect(closeRes.closed).toBe(true);
  });
});
