import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../../infra/sandboxes/computer/rakazo-page-browser", import.meta.url), "utf8");
const helpers = source.match(/EVAL_HELPERS\s*=\s*r?"""([\s\S]*?)"""/)![1];

function createPage(html: string) {
  const dom = new JSDOM(`<!doctype html><html><head><title>Test Page</title></head><body>${html}</body></html>`, {
    url: "https://example.test/",
    runScripts: "outside-only",
  });
  const win = dom.window as any;
  win.Element.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30, toJSON() {} };
  };
  win.Element.prototype.scrollIntoView = () => {};
  win.document.elementFromPoint = () => null;
  win.eval(helpers);
  return { dom, api: win.__rakazoPageBrowser, win };
}

describe("round2-page-browser composed tree and control regressions", () => {
  it("keeps valid ref clickable after observe()", () => {
    let clicked = false;
    const { dom, api } = createPage('<button id="b1">Click Me</button>');
    dom.window.document.getElementById("b1")!.addEventListener("click", () => {
      clicked = true;
    });
    try {
      const snap = api.snapshot();
      expect(snap.elements).toHaveLength(1);
      const ref = snap.elements[0].ref;

      // Non-destructive observe must not clear or mutate refMap
      const obs = api.observe();
      expect(obs.url).toBe("https://example.test/");
      expect(api.resolve(ref)).toBe(dom.window.document.getElementById("b1"));

      api.click(ref);
      expect(clicked).toBe(true);
    } finally {
      dom.window.close();
    }
  });

  it("invalidates old refs on fresh snapshot, navigation, or replaced nodes", () => {
    const { dom, api } = createPage('<button id="btn1">Button 1</button><button id="btn2">Button 2</button>');
    try {
      const snap1 = api.snapshot();
      const oldRef = snap1.elements[0].ref;

      // Fresh snapshot invalidates previous refs
      const snap2 = api.snapshot();
      expect(api.resolve(oldRef)).toBeNull();
      const currentRef = snap2.elements[0].ref;
      expect(api.resolve(currentRef)).not.toBeNull();

      // Node replacement / removal invalidates ref before dispatch
      const b1 = dom.window.document.getElementById("btn1")!;
      const replacement = dom.window.document.createElement("button");
      replacement.id = "btn1-new";
      replacement.textContent = "Replaced Button";
      b1.replaceWith(replacement);

      expect(api.resolve(currentRef)).toBeNull();
    } finally {
      dom.window.close();
    }
  });

  it("finds native button inside open shadow DOM, deduplicates host, and resolves correctly", () => {
    const { dom, api } = createPage('<ion-button id="host">Sign in with DocChula</ion-button>');
    const host = dom.window.document.getElementById("host")!;
    const shadow = host.attachShadow({ mode: "open" });
    const innerBtn = dom.window.document.createElement("button");
    innerBtn.className = "button-native";
    innerBtn.type = "button";
    innerBtn.innerHTML = "<slot></slot>";
    shadow.appendChild(innerBtn);

    let hostClicked = false;
    let buttonClicked = false;
    host.addEventListener("click", () => { hostClicked = true; });
    innerBtn.addEventListener("click", () => { buttonClicked = true; });

    try {
      const snap = api.snapshot();
      // Host and control must be deduplicated: exactly 1 interactive button emitted
      expect(snap.elements).toHaveLength(1);
      const el = snap.elements[0];
      expect(el.role).toBe("button");
      expect(el.name).toBe("Sign in with DocChula");
      expect(el.tag).toBe("button");

      // Ref must resolve to the exact native node in shadow DOM
      const resolved = api.resolve(el.ref);
      expect(resolved).toBe(innerBtn);

      // Clicking must succeed and bubble to host without occlusion error
      api.click(el.ref);
      expect(buttonClicked).toBe(true);
      expect(hostClicked).toBe(true);
    } finally {
      dom.window.close();
    }
  });

  it("traverses nested open shadow DOM components", () => {
    const { dom, api } = createPage('<outer-card id="outer"></outer-card>');
    const outer = dom.window.document.getElementById("outer")!;
    const outerShadow = outer.attachShadow({ mode: "open" });

    const innerComp = dom.window.document.createElement("inner-panel");
    outerShadow.appendChild(innerComp);
    const innerShadow = innerComp.attachShadow({ mode: "open" });

    const nestedBtn = dom.window.document.createElement("button");
    nestedBtn.id = "nested-btn";
    nestedBtn.textContent = "Confirm Order";
    innerShadow.appendChild(nestedBtn);

    let clicked = false;
    nestedBtn.addEventListener("click", () => { clicked = true; });

    try {
      const snap = api.snapshot();
      expect(snap.elements).toHaveLength(1);
      expect(snap.elements[0].name).toBe("Confirm Order");
      expect(snap.elements[0].role).toBe("button");

      api.click(snap.elements[0].ref);
      expect(clicked).toBe(true);
    } finally {
      dom.window.close();
    }
  });

  it("handles slotted controls inside custom elements", () => {
    const { dom, api } = createPage(`
      <custom-card id="card">
        <button id="slotted-btn" slot="actions">Proceed to Next Step</button>
      </custom-card>
    `);
    const card = dom.window.document.getElementById("card")!;
    const shadow = card.attachShadow({ mode: "open" });
    shadow.innerHTML = '<div class="wrapper"><slot name="actions"></slot></div>';

    let clicked = false;
    dom.window.document.getElementById("slotted-btn")!.addEventListener("click", () => {
      clicked = true;
    });

    try {
      const snap = api.snapshot();
      expect(snap.elements).toHaveLength(1);
      expect(snap.elements[0].name).toBe("Proceed to Next Step");
      api.click(snap.elements[0].ref);
      expect(clicked).toBe(true);
    } finally {
      dom.window.close();
    }
  });

  it("computes accessible names from aria-labelledby across tree scopes", () => {
    const { dom, api } = createPage(`
      <span id="title-part1">Accept</span>
      <span id="title-part2">Terms</span>
      <button aria-labelledby="title-part1 title-part2"></button>
    `);
    try {
      const snap = api.snapshot();
      expect(snap.elements).toHaveLength(1);
      expect(snap.elements[0].name).toBe("Accept Terms");
    } finally {
      dom.window.close();
    }
  });

  it("tracks duplicate text buttons by unique exact node references", () => {
    const { dom, api } = createPage(`
      <button id="btn-a">Save</button>
      <button id="btn-b">Save</button>
    `);
    let clickedA = false;
    let clickedB = false;
    dom.window.document.getElementById("btn-a")!.addEventListener("click", () => { clickedA = true; });
    dom.window.document.getElementById("btn-b")!.addEventListener("click", () => { clickedB = true; });

    try {
      const snap = api.snapshot();
      expect(snap.elements).toHaveLength(2);
      expect(snap.elements[0].ref).not.toBe(snap.elements[1].ref);
      expect(snap.elements[0].name).toBe("Save");
      expect(snap.elements[1].name).toBe("Save");

      // Clicking ref for second button must click exactly btn-b, not re-query and hit btn-a
      api.click(snap.elements[1].ref);
      expect(clickedA).toBe(false);
      expect(clickedB).toBe(true);

      api.click(snap.elements[0].ref);
      expect(clickedA).toBe(true);
    } finally {
      dom.window.close();
    }
  });

  it("detects disabled controls including shadow host ancestry", () => {
    const { dom, api } = createPage(`
      <button id="direct-disabled" disabled>Direct</button>
      <custom-widget id="host-disabled" disabled></custom-widget>
    `);
    const host = dom.window.document.getElementById("host-disabled")!;
    const shadow = host.attachShadow({ mode: "open" });
    const innerBtn = dom.window.document.createElement("button");
    innerBtn.textContent = "Inside Disabled Host";
    shadow.appendChild(innerBtn);

    try {
      const snap = api.snapshot();
      expect(snap.elements).toHaveLength(2);
      expect(snap.elements[0].disabled).toBe(true);
      expect(snap.elements[1].disabled).toBe(true);

      expect(() => api.resolve(snap.elements[0].ref)).toThrow(/Element is disabled/);
      expect(() => api.resolve(snap.elements[1].ref)).toThrow(/Element is disabled/);
    } finally {
      dom.window.close();
    }
  });

  it("detects overlay occlusion and throws detailed error", () => {
    const { dom, api } = createPage(`
      <button id="target-btn">Clickable Target</button>
      <div id="modal-backdrop">Overlay</div>
    `);
    const overlay = dom.window.document.getElementById("modal-backdrop")!;
    // Mock elementFromPoint to return the overlay covering the button
    dom.window.document.elementFromPoint = () => overlay;

    try {
      const snap = api.snapshot();
      expect(snap.elements).toHaveLength(1);
      expect(() => api.click(snap.elements[0].ref)).toThrow(/Element is occluded by overlay: div#modal-backdrop/);
    } finally {
      dom.window.close();
    }
  });

  it("reports coverage < 1.0, fallback notes, and no fabricated refs for closed shadow DOM and iframes", () => {
    const { dom, api } = createPage(`
      <div id="closed-container"></div>
      <iframe src="about:blank"></iframe>
    `);
    const container = dom.window.document.getElementById("closed-container")!;
    container.attachShadow({ mode: "closed" });

    try {
      const snap = api.snapshot();
      expect(snap.hasFrames).toBe(true);
      expect(snap.hasClosedShadow).toBe(true);
      expect(snap.coverage).toBeLessThan(1.0);
      expect(snap.tree).toContain("Embedded frames require desktop tools");
      expect(snap.tree).toContain("Closed Shadow DOM components require desktop tools");
      // Must not fabricate any refs
      expect(snap.elements).toHaveLength(0);
    } finally {
      dom.window.close();
    }
  });

  it("maintains versioned initialization, expires old refs on upgrade, and preserves saved login redaction", () => {
    const { dom, api, win } = createPage(`
      <input type="password" id="pwd" value="secret" />
      <input type="text" id="usr" value="user1" />
    `);
    try {
      expect(api.version).toBe("3.0.0");
      const snap1 = api.snapshot();
      const pwdRef = snap1.elements[0].ref;

      // Fill a saved login to mark it in loginFilled WeakSet
      const pwdEl = dom.window.document.getElementById("pwd") as HTMLInputElement;
      api.fill(pwdRef, "secret-pass", "https://example.test");
      expect(api._loginFilled.has(pwdEl)).toBe(true);

      // Re-evaluating same version is a no-op that keeps refs
      win.eval(helpers);
      expect(win.__rakazoPageBrowser.version).toBe("3.0.0");
      expect(win.__rakazoPageBrowser.resolve(pwdRef)).toBe(pwdEl);

      // Simulate a version upgrade by changing the version property on existing instance
      win.__rakazoPageBrowser.version = "2.2.0";
      // Re-evaluate current helper (3.0.0)
      win.eval(helpers);

      // 1. Version is updated
      expect(win.__rakazoPageBrowser.version).toBe("3.0.0");
      // 2. Saved login redaction WeakSet is retained across version upgrade
      expect(win.__rakazoPageBrowser._loginFilled.has(pwdEl)).toBe(true);
      // 3. Old refs are expired so failed-before-dispatch occurs instead of ghost execution
      expect(win.__rakazoPageBrowser.resolve(pwdRef)).toBeNull();

      // Fresh snapshot works with new version
      const freshSnap = win.__rakazoPageBrowser.snapshot();
      expect(freshSnap.elements).toHaveLength(2);
      expect(freshSnap.elements[0].value).toBeUndefined(); // redacted password
    } finally {
      dom.window.close();
    }
  });

  it("does not overwrite helper while an action is actively dispatching", () => {
    const { dom, api, win } = createPage('<button id="b">Button</button>');
    try {
      api._isDispatching = true;
      const originalRefMap = api._refMap;
      // Re-evaluating while isDispatching is true must return immediately without touching helper
      win.eval(helpers);
      expect(win.__rakazoPageBrowser._refMap).toBe(originalRefMap);
      api._isDispatching = false;
    } finally {
      dom.window.close();
    }
  });
});
