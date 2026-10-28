import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../../infra/sandboxes/computer/rakazo-page-browser", import.meta.url), "utf8");
const helpers = source.match(/EVAL_HELPERS\s*=\s*r?"""([\s\S]*?)"""/)![1]!;

function page() {
  const dom = new JSDOM('<body><button id="noop">No change</button><button id="change">Continue</button></body>', {
    url: "https://example.test/", runScripts: "outside-only",
  });
  const win = dom.window;
  win.Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30, toJSON() {} });
  win.Element.prototype.scrollIntoView = () => {};
  win.document.elementFromPoint = () => null;
  win.document.getElementById("change")!.addEventListener("click", () => { win.document.title = "Next page"; });
  win.eval(helpers);
  return { dom, api: (win as any).__rakazoPageBrowser };
}

describe("actual embedded page-browser helper", () => {
  it("keeps a snapshot ref usable during pre-action observation", () => {
    const { dom, api } = page();
    try {
      const ref = api.snapshot().elements[0].ref;
      api.observe();
      expect(api.resolve(ref)).toBe(dom.window.document.getElementById("noop"));
      api.click(ref);
    } finally { dom.window.close(); }
  });

  it("compares semantic state without counting regenerated refs as progress", () => {
    const { dom, api } = page();
    try {
      const first = api.snapshot();
      const before = api.observe();
      api.click(first.elements[0].ref);
      const second = api.snapshot();
      expect(second.elements[0].ref).not.toBe(first.elements[0].ref);
      expect(api.observe()).toEqual(before);
      api.click(second.elements[1].ref);
      expect(api.observe()).not.toEqual(before);
    } finally { dom.window.close(); }
  });

  it("still invalidates old refs on an explicit snapshot and removed nodes", () => {
    const { dom, api } = page();
    try {
      const old = api.snapshot().elements[0].ref;
      const current = api.snapshot().elements[0].ref;
      expect(api.resolve(old)).toBeNull();
      dom.window.document.getElementById("noop")!.remove();
      expect(api.resolve(current)).toBeNull();
    } finally { dom.window.close(); }
  });
});
