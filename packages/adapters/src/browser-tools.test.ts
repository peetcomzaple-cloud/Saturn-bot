import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import {
  browserActFromTool,
  browserClearOriginStorageFromTool,
  browserNavigateFromTool,
  browserSnapshotFromTool,
  parseBrowserActions,
  parseBrowserClearOriginStorageRequest,
} from "./browser-tools.js";
import { filterPageBrowserTools, PAGE_BROWSER_TOOL_NAMES } from "./executor.js";
import { FakeBrowserProvider } from "./fake-browser.js";

const context: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const computer: ComputerRef = {
  id: "c1",
  botId: "b1",
  kind: "fake",
  providerRef: "c1",
};

describe("browser tools", () => {
  it("parses click/fill/type actions and rejects bad batches", () => {
    expect(
      parseBrowserActions([
        { kind: "fill", ref: "e1", text: "hi" },
        { kind: "click", ref: "e2" },
      ]),
    ).toEqual([
      { kind: "fill", ref: "e1", text: "hi" },
      { kind: "click", ref: "e2" },
    ]);
    expect(() => parseBrowserActions([])).toThrow(/at least one/i);
    expect(() => parseBrowserActions([{ kind: "click" }])).toThrow(/ref/i);
    expect(() => parseBrowserActions([{ kind: "fill", ref: "e1" }])).toThrow(/text/i);
  });

  it("rejects URL credentials before invoking the browser", async () => {
    const browser = new FakeBrowserProvider();
    browser.navigateError = new Error("must not invoke browser");
    for (const scheme of ["http", "https"]) {
      expect(
        await browserNavigateFromTool(browser, computer, context, {
          url: `${scheme}://example:fake-password@example.test`,
        }),
      ).toMatchObject({ error: expect.stringContaining("credentials") });
    }
  });

  it("navigates, snapshots, and acts through the tool helpers", async () => {
    const browser = new FakeBrowserProvider({
      pages: {
        "https://example.test/x": {
          title: "Demo",
          html: `<!doctype html><html><head><title>Demo</title></head><body>
            <input aria-label="Name" />
            <button>Save</button>
          </body></html>`,
        },
      },
    });
    const navigated = await browserNavigateFromTool(browser, computer, context, {
      url: "https://example.test/x",
    });
    expect(navigated).toMatchObject({ title: "Demo" });
    expect("fallback" in navigated && navigated.fallback).toBeFalsy();

    const snap = await browserSnapshotFromTool(browser, computer, context, {});
    expect(snap).toMatchObject({ title: "Demo" });
    expect(String((snap as { tree?: string }).tree)).toMatch(/\[e\d+\]/);

    const nameRef = (snap as { elements: Array<{ ref: string; name: string }> }).elements.find(
      (el) => el.name.includes("Name"),
    )!.ref;
    const acted = await browserActFromTool(browser, computer, context, {
      actions: [{ kind: "fill", ref: nameRef, text: "Ada" }],
    });
    expect(acted).toMatchObject({ ok: true, completed: 1 });
  });

  it("parses fill_secret without a value and rejects unknown fields", () => {
    expect(
      parseBrowserActions([
        { kind: "fill_secret", ref: "e1", secret: "site_login", field: "password" },
      ]),
    ).toEqual([{ kind: "fill_secret", ref: "e1", secret: "site_login", field: "password" }]);
    expect(() =>
      parseBrowserActions([{ kind: "fill_secret", ref: "e1", secret: "site_login", field: "pin" }]),
    ).toThrow(/username or password/);
    expect(() =>
      parseBrowserActions([{ kind: "fill_secret", ref: "e1", secret: "", field: "password" }]),
    ).toThrow(/secret/);
  });

  describe("saved login fills", () => {
    const loginPage = (url: string) =>
      new FakeBrowserProvider({
        pages: {
          [url]: {
            title: "Sign in",
            html: `<!doctype html><html><head><title>Sign in</title></head><body>
              <input aria-label="Email" />
              <input aria-label="Password" type="password" />
            </body></html>`,
          },
        },
      });
    async function refs(browser: FakeBrowserProvider, url: string) {
      await browserNavigateFromTool(browser, computer, context, { url });
      const snap = (await browserSnapshotFromTool(browser, computer, context, {})) as {
        elements: Array<{ ref: string; name: string }>;
      };
      const ref = (name: string) => snap.elements.find((el) => el.name.includes(name))!.ref;
      return { email: ref("Email"), password: ref("Password") };
    }
    const values = { username: "fake-user@example.test", password: "fake-password-1" };
    const resolveSecretFill = async (step: { field: "username" | "password" }) => ({
      text: values[step.field],
      origin: "https://login.example.test",
    });

    it("types saved values on the saved origin and redacts them from the result", async () => {
      const browser = loginPage("https://login.example.test/signin");
      const { email, password } = await refs(browser, "https://login.example.test/signin");
      const acted = await browserActFromTool(
        browser,
        computer,
        context,
        {
          actions: [
            { kind: "fill_secret", ref: email, secret: "site_login", field: "username" },
            { kind: "fill_secret", ref: password, secret: "site_login", field: "password" },
          ],
        },
        { resolveSecretFill, redactions: () => [values.username, values.password] },
      );
      expect(acted).toMatchObject({ ok: true, completed: 2 });
      expect(JSON.stringify(acted)).not.toContain(values.username);
      expect(JSON.stringify(acted)).not.toContain(values.password);
    });

    it("never reports a login-filled field's value, even when too short to redact", async () => {
      const browser = loginPage("https://login.example.test/signin");
      const { email } = await refs(browser, "https://login.example.test/signin");
      const shortName = async () => ({ text: "ada", origin: "https://login.example.test" });
      const acted = await browserActFromTool(
        browser,
        computer,
        context,
        { actions: [{ kind: "fill_secret", ref: email, secret: "site_login", field: "username" }] },
        { resolveSecretFill: shortName },
      );
      expect(acted).toMatchObject({ ok: true });
      expect(JSON.stringify(acted)).not.toContain("ada");
      const snap = await browserSnapshotFromTool(browser, computer, context, {});
      expect(JSON.stringify(snap)).not.toContain("ada");
    });

    it("keeps a login-filled field hidden after ordinary typing appends to it", async () => {
      const browser = loginPage("https://login.example.test/signin");
      const { email } = await refs(browser, "https://login.example.test/signin");
      // Each result carries a fresh snapshot, whose refs replace the previous ones.
      const emailRef = (result: unknown) =>
        (result as { elements: Array<{ ref: string; name: string }> }).elements.find((el) =>
          el.name.includes("Email"),
        )!.ref;
      const filled = await browserActFromTool(
        browser,
        computer,
        context,
        { actions: [{ kind: "fill_secret", ref: email, secret: "site_login", field: "username" }] },
        { resolveSecretFill: async () => ({ text: "ada", origin: "https://login.example.test" }) },
      );
      const typed = await browserActFromTool(browser, computer, context, {
        actions: [{ kind: "type", ref: emailRef(filled), text: "!" }],
      });
      expect(typed).toMatchObject({ ok: true });
      expect(JSON.stringify(typed)).not.toContain("ada");
      const replaced = await browserActFromTool(browser, computer, context, {
        actions: [{ kind: "fill", ref: emailRef(typed), text: "visible-now" }],
      });
      expect(JSON.stringify(replaced)).toContain("visible-now");
    });

    it("refuses to type a saved login into editable page content", async () => {
      const browser = new FakeBrowserProvider({
        pages: {
          "https://login.example.test/notes": {
            title: "Notes",
            html: `<!doctype html><html><head><title>Notes</title></head><body>
              <div contenteditable="true" aria-label="Notes"></div>
            </body></html>`,
          },
        },
      });
      await browserNavigateFromTool(browser, computer, context, {
        url: "https://login.example.test/notes",
      });
      const snap = (await browserSnapshotFromTool(browser, computer, context, {})) as {
        elements: Array<{ ref: string; name: string }>;
      };
      const notes = snap.elements.find((el) => el.name.includes("Notes"))!.ref;
      const acted = await browserActFromTool(
        browser,
        computer,
        context,
        { actions: [{ kind: "fill_secret", ref: notes, secret: "site_login", field: "username" }] },
        { resolveSecretFill },
      );
      expect(acted).toMatchObject({ ok: false, completed: 0 });
      expect(JSON.stringify(acted)).toMatch(/text, email, password, or telephone/);
    });

    it("refuses to type a saved login into a textarea or a non-login input type", async () => {
      const browser = new FakeBrowserProvider({
        pages: {
          "https://login.example.test/signin": {
            title: "Sign in",
            html: `<!doctype html><html><head><title>Sign in</title></head><body>
              <textarea aria-label="Username"></textarea>
              <input aria-label="Query" type="search" />
              <input aria-label="Website" type="url" />
              <input aria-label="Pin" type="number" />
              <input aria-label="Phone" type="tel" />
            </body></html>`,
          },
        },
      });
      await browserNavigateFromTool(browser, computer, context, {
        url: "https://login.example.test/signin",
      });
      const ref = async (name: string) => {
        const snap = (await browserSnapshotFromTool(browser, computer, context, {})) as {
          elements: Array<{ ref: string; name: string }>;
        };
        return snap.elements.find((el) => el.name.includes(name))!.ref;
      };
      for (const name of ["Username", "Query", "Website", "Pin"]) {
        const acted = await browserActFromTool(
          browser,
          computer,
          context,
          {
            actions: [
              {
                kind: "fill_secret",
                ref: await ref(name),
                secret: "site_login",
                field: "username",
              },
            ],
          },
          { resolveSecretFill },
        );
        expect(acted, name).toMatchObject({ ok: false, completed: 0 });
        expect(JSON.stringify(acted), name).toMatch(/text, email, password, or telephone/);
      }
      const phone = await browserActFromTool(
        browser,
        computer,
        context,
        {
          actions: [
            {
              kind: "fill_secret",
              ref: await ref("Phone"),
              secret: "site_login",
              field: "username",
            },
          ],
        },
        { resolveSecretFill },
      );
      expect(phone).toMatchObject({ ok: true, completed: 1 });
    });

    it("refuses to type a saved login on a private-LAN HTTP origin", async () => {
      const origin = "http://192.168.2.10:8080";
      const browser = new FakeBrowserProvider({
        pages: {
          [`${origin}/signin`]: {
            title: "Sign in",
            html: `<!doctype html><html><head><title>Sign in</title></head><body>
              <input aria-label="Email" />
            </body></html>`,
          },
        },
      });
      await browserNavigateFromTool(browser, computer, context, { url: `${origin}/signin` });
      const snap = (await browserSnapshotFromTool(browser, computer, context, {})) as {
        elements: Array<{ ref: string; name: string }>;
      };
      const email = snap.elements.find((el) => el.name.includes("Email"))!.ref;
      const acted = await browserActFromTool(
        browser,
        computer,
        context,
        { actions: [{ kind: "fill_secret", ref: email, secret: "site_login", field: "username" }] },
        { resolveSecretFill: async () => ({ text: values.username, origin }) },
      );
      expect(acted).toMatchObject({ ok: false, completed: 0 });
      expect(JSON.stringify(acted)).toMatch(/HTTPS/);
      expect(JSON.stringify(acted)).not.toContain(values.username);
    });

    it("refuses to type a saved login on another origin", async () => {
      const browser = loginPage("https://phish.example.test/signin");
      const { email } = await refs(browser, "https://phish.example.test/signin");
      const acted = await browserActFromTool(
        browser,
        computer,
        context,
        { actions: [{ kind: "fill_secret", ref: email, secret: "site_login", field: "username" }] },
        { resolveSecretFill },
      );
      expect(acted).toMatchObject({ ok: false, completed: 0 });
      expect(JSON.stringify(acted)).toMatch(/not on the site/);
    });

    it("acts on nothing when a saved login cannot be resolved", async () => {
      const browser = loginPage("https://login.example.test/signin");
      const { email, password } = await refs(browser, "https://login.example.test/signin");
      const acted = await browserActFromTool(browser, computer, context, {
        actions: [
          { kind: "fill", ref: email, text: "typed-before" },
          { kind: "fill_secret", ref: password, secret: "site_login", field: "password" },
        ],
      });
      expect(acted).toEqual({
        ok: false,
        completed: 0,
        error: "Saved logins are unavailable here.",
      });
      const snap = await browserSnapshotFromTool(browser, computer, context, {});
      expect(JSON.stringify(snap)).not.toContain("typed-before");
    });
  });

  it("toggles checkboxes via click without undoing activation", async () => {
    const browser = new FakeBrowserProvider({
      pages: {
        "https://example.test/form": {
          title: "Form",
          html: `<!doctype html><html><head><title>Form</title></head><body>
            <label><input type="checkbox" aria-label="Agree" /> Agree</label>
          </body></html>`,
        },
      },
    });
    await browserNavigateFromTool(browser, computer, context, { url: "https://example.test/form" });
    const before = await browserSnapshotFromTool(browser, computer, context, {});
    const agree = (
      before as { elements: Array<{ ref: string; name: string; value?: string }> }
    ).elements.find((el) => el.name.includes("Agree"))!;
    expect(agree.value).toMatch(/unchecked|false|^$/i);
    const acted = await browserActFromTool(browser, computer, context, {
      actions: [{ kind: "click", ref: agree.ref }],
    });
    expect(acted).toMatchObject({ ok: true });
    const after = await browserSnapshotFromTool(browser, computer, context, {});
    const toggled = (after as { elements: Array<{ name: string; value?: string }> }).elements.find(
      (el) => el.name.includes("Agree"),
    )!;
    expect(toggled.value).toMatch(/checked|true/i);
  });

  it("falls back to computer_act for link navigation the in-process page cannot load", async () => {
    const browser = new FakeBrowserProvider({
      pages: {
        "https://example.test/start": {
          title: "Start",
          html: `<!doctype html><html><head><title>Start</title></head><body>
            <a href="https://example.test/next">Next</a>
          </body></html>`,
        },
      },
    });
    await browserNavigateFromTool(browser, computer, context, {
      url: "https://example.test/start",
    });
    const snap = await browserSnapshotFromTool(browser, computer, context, {});
    const link = (snap as { elements: Array<{ ref: string; name: string }> }).elements.find((el) =>
      el.name.includes("Next"),
    )!;
    const acted = await browserActFromTool(browser, computer, context, {
      actions: [{ kind: "click", ref: link.ref }],
    });
    expect(acted).toMatchObject({
      ok: false,
      fallback: "computer_act",
      error: expect.stringMatching(/cannot navigate links|computer_act/i),
    });
  });

  it("surfaces computer_act fallback from the tool layer", async () => {
    const browser = new FakeBrowserProvider();
    browser.forceFallback = "cannot attach to page";
    const result = await browserNavigateFromTool(browser, computer, context, {
      url: "https://example.test",
    });
    expect(result).toMatchObject({
      fallback: "computer_act",
      note: expect.stringMatching(/computer_act/i),
    });
  });

  it("hides page browser tools when the computer is not graphical", () => {
    const tools = [...PAGE_BROWSER_TOOL_NAMES].map((name) => ({ name }));
    expect(filterPageBrowserTools(tools, true)).toHaveLength(PAGE_BROWSER_TOOL_NAMES.size);
    expect(filterPageBrowserTools(tools, false)).toEqual([]);
    expect(filterPageBrowserTools([{ name: "computer_act" }, ...tools], false)).toEqual([
      { name: "computer_act" },
    ]);
  });

  it("validates and executes browser_clear_origin_storage scoped to one origin", async () => {
    expect(() => parseBrowserClearOriginStorageRequest({ origin: "ftp://bad.test" })).toThrow(
      /HTTP\(S\) origin/i,
    );
    expect(() =>
      parseBrowserClearOriginStorageRequest({
        origin: "https://user:pass@example.test",
      }),
    ).toThrow(/credentials/i);
    expect(() =>
      parseBrowserClearOriginStorageRequest({
        origin: "https://example.test",
        storageTypes: ["unknown_storage"],
      }),
    ).toThrow(/Unsupported browser storage type/i);

    const browser = new FakeBrowserProvider();
    const res = await browserClearOriginStorageFromTool(browser, computer, context, {
      origin: "https://example.test/some/path?query=1",
      storageTypes: ["cookies", "local_storage"],
    });
    expect(res).toMatchObject({
      ok: true,
      origin: "https://example.test",
      clearedStorageTypes: ["cookies", "local_storage"],
    });
  });

  it("propagates main-document HTTP status and classifies 400/429/5xx in browserNavigateFromTool", async () => {
    const browser = new FakeBrowserProvider();
    browser.navigate = async () => ({
      url: "https://example.test/rate-limit",
      title: "Too Many Requests",
      httpStatus: 429,
      httpStatusStatus: "known",
      redirected: false,
      retryAfterMs: 15_000,
    });
    const res429 = await browserNavigateFromTool(browser, computer, context, {
      url: "https://example.test/rate-limit",
    });
    expect(res429).toMatchObject({
      ok: false,
      httpStatus: 429,
      httpStatusStatus: "known",
      retryAfterMs: 15_000,
      errorCode: "HTTP_429",
      errorKind: "rate_limited",
      retryable: true,
    });

    browser.navigate = async () => ({
      url: "https://example.test/bad-cookie",
      title: "Bad Request",
      httpStatus: 400,
      httpStatusStatus: "known",
    });
    const res400 = await browserNavigateFromTool(browser, computer, context, {
      url: "https://example.test/bad-cookie",
    });
    expect(res400).toMatchObject({
      ok: false,
      httpStatus: 400,
      httpStatusStatus: "known",
      errorCode: "FLOW_STATE_INVALID",
      errorKind: "flow_state_invalid",
      retryable: true,
      note: expect.stringContaining("browser_clear_origin_storage"),
    });
  });

  it("supports totp field in fill_secret and verifies RFC 6238 TOTP, URI validation, redaction, and multi-origin SSO allowlists", async () => {
    const { generateTotpCode, isOriginAllowedForLogin } = await import("./bot-secrets.js");
    expect(
      parseBrowserActions([{ kind: "fill_secret", ref: "e1", secret: "site_login", field: "totp" }]),
    ).toEqual([{ kind: "fill_secret", ref: "e1", secret: "site_login", field: "totp" }]);

    // RFC 6238 Appendix B SHA1 test vectors for ASCII "12345678901234567890"
    const rfcSeed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(generateTotpCode(rfcSeed, 59_000)).toBe("287082");
    expect(generateTotpCode(rfcSeed, 1_111_111_109_000)).toBe("081804");

    // Base32 and valid otpauth://totp URI parity
    const code1 = generateTotpCode("JBSWY3DPEHPK3PXP", 59_000);
    const code2 = generateTotpCode(
      "otpauth://totp/Example:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example&algorithm=SHA1&digits=6&period=30",
      59_000,
    );
    expect(code1).toMatch(/^\d{6}$/);
    expect(code1).toBe(code2);

    // Rejects unsupported OTP URI types, missing secret, and unsupported algorithm/digits/period
    expect(() =>
      generateTotpCode("otpauth://hotp/Example:alice?secret=JBSWY3DPEHPK3PXP", 59_000),
    ).toThrow(/only totp is supported/i);
    expect(() =>
      generateTotpCode("otpauth://totp/Example:alice?issuer=Example", 59_000),
    ).toThrow(/Missing secret/i);
    expect(() =>
      generateTotpCode(
        "otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&algorithm=SHA256",
        59_000,
      ),
    ).toThrow(/Unsupported TOTP algorithm/i);
    expect(() =>
      generateTotpCode("otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&digits=8", 59_000),
    ).toThrow(/Unsupported TOTP digits/i);
    expect(() =>
      generateTotpCode("otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&period=60", 59_000),
    ).toThrow(/Unsupported TOTP period/i);

    // Redacts both seed and generated code from browserActFromTool results
    const browser = new FakeBrowserProvider({
      pages: {
        "https://login.example.test/mfa": {
          title: "MFA",
          html: `<!doctype html><html><head><title>MFA</title></head><body>
            <input aria-label="One-time code" type="text" />
          </body></html>`,
        },
      },
    });
    await browserNavigateFromTool(browser, computer, context, {
      url: "https://login.example.test/mfa",
    });
    const snap = (await browserSnapshotFromTool(browser, computer, context, {})) as {
      elements: Array<{ ref: string; name: string }>;
    };
    const otpRef = snap.elements.find((el) => el.name.includes("One-time"))!.ref;
    const activeRedactions = ["JBSWY3DPEHPK3PXP", code1];
    const acted = await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "fill_secret", ref: otpRef, secret: "site_login", field: "totp" }] },
      {
        resolveSecretFill: async () => ({
          text: code1,
          origin: "https://login.example.test",
        }),
        redactions: () => activeRedactions,
      },
    );
    expect(acted).toMatchObject({ ok: true, completed: 1 });
    expect(JSON.stringify(acted)).not.toContain(code1);
    expect(JSON.stringify(acted)).not.toContain("JBSWY3DPEHPK3PXP");

    // Multi-origin SSO allowlist check
    expect(
      isOriginAllowedForLogin(
        "https://teams.microsoft.com",
        "https://login.microsoftonline.com",
        ["https://login.microsoftonline.com", "https://login.live.com"],
      ),
    ).toBe("https://login.microsoftonline.com");
    expect(
      isOriginAllowedForLogin(
        "https://teams.microsoft.com",
        "https://evil.example.test",
        ["https://login.microsoftonline.com"],
      ),
    ).toBeNull();
    // Rejects non-HTTPS in allowedOrigins
    expect(
      isOriginAllowedForLogin(
        "https://teams.microsoft.com",
        "http://insecure.example.test",
        ["http://insecure.example.test"],
      ),
    ).toBeNull();
  });
});


