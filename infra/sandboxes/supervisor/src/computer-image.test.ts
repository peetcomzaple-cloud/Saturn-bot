import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveComputerImage } from "./computer-spec.js";

describe("computer image selection", () => {
  beforeEach(() => {
    vi.stubEnv("RAKAZO_COMPUTER_IMAGE", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("preserves the default for unset and blank configuration", () => {
    for (const value of [undefined, "", " ", "\t\n"]) {
      expect(resolveComputerImage(value)).toBe("saturn-bot/computer:local");
    }
  });

  it("accepts named references, digests, and immutable local IDs", () => {
    const digest = "a".repeat(64);
    for (const image of [
      "computer:local",
      "localhost/computer:reviewed",
      "registry.example:5000/team/computer:reviewed",
      "[fd00::1]:5000/team/computer:local",
      `registry.example/team/computer@sha256:${digest}`,
      `sha256:${digest}`,
      digest,
    ]) {
      expect(resolveComputerImage(image)).toBe(image);
      expect(resolveComputerImage(`  ${image}  `)).toBe(image);
    }
  });

  it("rejects embedded whitespace and control or shell syntax", () => {
    for (const value of [
      "computer:local extra",
      "computer\n:local",
      "computer\t:local",
      "computer\0:local",
      "computer;other",
      "$(command)",
      "computer|other",
    ]) {
      expect(() => resolveComputerImage(value)).toThrow(/RAKAZO_COMPUTER_IMAGE/);
    }
  });

  it("selects the configured immutable image during module initialization", async () => {
    const digest = "b".repeat(64);
    vi.stubEnv("RAKAZO_COMPUTER_IMAGE", digest);
    vi.resetModules();
    const configured = await import("./computer-spec.js");
    expect(configured.COMPUTER_IMAGE).toBe(digest);
  });
});
