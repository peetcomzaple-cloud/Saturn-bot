import { readFile } from "node:fs/promises";
import vm from "node:vm";
import type { DesktopEngineCapacity } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";

/** Run the actual setup renderer startup against its existing bridge contract. */
async function renderCapacity(capacity: DesktopEngineCapacity | undefined) {
  const nodes = new Map<string, ReturnType<typeof element>>();
  function element() {
    return {
      textContent: "",
      hidden: false,
      checked: false,
      disabled: false,
      style: { width: "" },
      value: "new",
      scrollTop: 0,
      scrollHeight: 0,
      setAttribute() {},
      removeAttribute() {},
      addEventListener() {},
      focus() {},
      querySelector: () => ({ value: "new" }),
      querySelectorAll: () => [],
    };
  }
  const get = (id: string) => {
    let node = nodes.get(id);
    if (!node) {
      node = element();
      nodes.set(id, node);
    }
    return node;
  };
  const renderer = await readFile(new URL("./setup.js", import.meta.url), "utf8");
  vm.runInNewContext(renderer, {
    document: { documentElement: { dataset: {} }, getElementById: get },
    window: {
      rakazoSetup: {
        platform: "linux",
        state: async () => ({ defaultLocalUrl: "http://localhost:3000", saved: null }),
        stack: {
          onChange() {},
          state: async () => ({
            phase: "ready",
            message: null,
            output: [],
            layerBytes: {},
            capacity,
          }),
        },
      },
    },
  });
  await vi.waitFor(() => expect(get("stack-phase").textContent).toBe("Saturn bot is ready."));
  return get("stack-detail").textContent;
}

describe("setup capacity disclosure", () => {
  it("discloses missing CPUs when memory alone was observed", async () => {
    expect(await renderCapacity({ status: "known", memoryMb: 16384, cpus: null })).toBe(
      "Docker CPU capacity was not reported.",
    );
  });
  it("discloses missing memory when CPUs alone were observed", async () => {
    expect(await renderCapacity({ status: "known", memoryMb: null, cpus: 8 })).toBe(
      "Docker memory capacity was not reported.",
    );
  });
  it("keeps fully unknown capacity explicit", async () => {
    expect(await renderCapacity({ status: "unknown", reason: "engine-query-failed" })).toContain(
      "limits were not checked",
    );
  });
  it("does not warn when both dimensions were observed", async () => {
    expect(await renderCapacity({ status: "known", memoryMb: 16384, cpus: 8 })).toBe("");
  });
  it("does not invent a check before capacity is available", async () => {
    expect(await renderCapacity(undefined)).toBe("");
  });
});
