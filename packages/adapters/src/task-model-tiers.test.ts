import { describe, expect, it } from "vitest";
import {
  readToolFailed,
  taskModelTier,
  taskModelTiersFromEnv,
  taskStrongModel,
} from "./task-model-tiers.js";

const tiers = {
  read: { provider: "example", id: "small" },
  strong: { provider: "example", id: "large" },
};

describe("environment task model tiers", () => {
  it("keeps each account's selected model ahead of the deployment strong model", () => {
    expect(
      taskStrongModel(tiers, { provider: "account-provider", defaultModel: "chosen-model" }),
    ).toEqual({ provider: "account-provider", id: "chosen-model" });
    expect(taskStrongModel(tiers, { provider: "example", defaultModel: "small" })).toEqual(
      tiers.read,
    );
  });
  it("escalates failed reads to the account model without retrying the same small model", () => {
    expect(
      taskStrongModel(tiers, { provider: "account-provider", defaultModel: "chosen-model" }, true),
    ).toEqual({ provider: "account-provider", id: "chosen-model" });
    expect(taskStrongModel(tiers, { provider: "example", defaultModel: "small" }, true)).toEqual(
      tiers.strong,
    );
  });
  it("uses the environment strong model when no account model is selected", () => {
    expect(taskStrongModel(tiers, null)).toEqual(tiers.strong);
    expect(taskStrongModel(tiers, { provider: "example", defaultModel: " " })).toEqual(
      tiers.strong,
    );
  });
  it("leaves native model settings in control when absent or explicitly pinned", () => {
    expect(taskModelTiersFromEnv({})).toBeUndefined();
    expect(taskModelTier(undefined, "list files")).toBeUndefined();
    expect(taskModelTier(tiers, "list files", true)).toBeUndefined();
  });
  it("rejects partial configuration instead of silently spending on another model", () => {
    expect(() => taskModelTiersFromEnv({ TASK_READ_MODEL_ID: "small" })).toThrow(
      /both task model tiers/,
    );
  });
  it("uses provider-neutral identifiers without accepting or reading keys", () => {
    expect(
      taskModelTiersFromEnv({
        TASK_READ_MODEL_PROVIDER: "example",
        TASK_READ_MODEL_ID: "small",
        TASK_STRONG_MODEL_PROVIDER: "example",
        TASK_STRONG_MODEL_ID: "large",
        API_KEY: "unused",
      }),
    ).toEqual(tiers);
  });
  it.each([
    "list files",
    "Use list_files with path empty. Do not write files.",
    "Read file notes.txt",
    "อ่านไฟล์ notes.txt ห้ามเขียนไฟล์",
    "แสดงรายการไฟล์",
  ])("uses the read tier for %s", (prompt) => {
    expect(taskModelTier(tiers, prompt)).toBe("read");
  });
  it.each([
    "Edit notes.txt",
    "list files then write a summary file",
    "อ่านไฟล์แล้วแก้ไข",
    "Open https://example.com",
    "ทดสอบอ่านและกระทบยอดข้อมูลจริงใน qa-heavy-20261012 ห้ามเขียนไฟล์",
    "อ่านไฟล์แล้วคำนวณยอดรวมแปลงสกุลเงิน",
    "read files and calculate reconciliation",
  ])("uses the strong tier for %s", (prompt) => {
    expect(taskModelTier(tiers, prompt)).toBe("strong");
  });
  it("escalates read-tool failures without reacting to successful reads or write/approval results", () => {
    expect(readToolFailed("list_files", { details: { error: "not found" } })).toBe(true);
    expect(readToolFailed("read_file", undefined, new Error("read failed"))).toBe(true);
    expect(readToolFailed("read_file", { details: { content: "hello" } })).toBe(false);
    expect(readToolFailed("browser_act", { error: "approval needed" })).toBe(false);
    expect(readToolFailed("write_file", { error: "denied" })).toBe(false);
  });
  it("routes tasks with images to a vision-capable tier when strong tier is text-only", () => {
    const mixedTiers = {
      read: { provider: "openrouter", id: "google/gemini-2.5-flash-lite" },
      strong: { provider: "openrouter", id: "deepseek/deepseek-v4-flash-0731" },
    };
    expect(taskModelTier(mixedTiers, "describe this complex image", false, true)).toBe("read");
    expect(
      taskStrongModel(mixedTiers, { provider: "openrouter", defaultModel: "deepseek/deepseek-v4-flash-0731" }, false, true),
    ).toEqual(mixedTiers.read);
  });
});
