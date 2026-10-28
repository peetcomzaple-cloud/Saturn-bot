import { describe, expect, it } from "vitest";
import { formatThaiToolActivity } from "./run-language.js";
import { taskModelTier, taskStrongModel, type TaskModelTiers } from "./task-model-tiers.js";

describe("round4-auto-routing-thai: capability-first selection & Thai status", () => {
  const tiers: TaskModelTiers = {
    read: { provider: "google", id: "gemini-2.5-flash-lite" }, // Has vision
    strong: { provider: "deepseek", id: "deepseek-chat" },     // Text-only, powerful coding/orchestration
  };

  it("selects strong tier for complex DOM tasks without downgrading simply due to screen presence", () => {
    const complexDomPrompt = "คุณเข้า shopee และค้นหาน้ำเปล่าแล้วเลือกขวดที่ราคาดีที่สุด";

    // Task is not read-only: requires complex navigation and decision
    // hasImages is false for DOM tasks even if computer has graphical screen
    const tier = taskModelTier(tiers, complexDomPrompt, false, false);
    expect(tier).toBe("strong");

    // taskStrongModel without requiresVision returns the strong tier (DeepSeek)
    const model = taskStrongModel(tiers, null, true, false);
    expect(model).toEqual(tiers.strong);
    expect(model.provider).toBe("deepseek");
  });

  it("selects vision-capable model when task truly has input images", () => {
    const visionPrompt = "ดูภาพนี้แล้วบอกว่าปุ่มอยู่ตรงไหน";
    // hasImages is true because user attached an image
    const tier = taskModelTier(tiers, visionPrompt, false, true);
    // Since strong has no vision, it routes to read tier which accepts images
    expect(tier).toBe("read");

    const model = taskStrongModel(tiers, null, true, true);
    expect(model).toEqual(tiers.read);
    expect(model.provider).toBe("google");
  });

  it("formats tool activities into single-line concise Thai without altering URLs or paths", () => {
    expect(formatThaiToolActivity("Opening page: https://mail.google.com/mail/u/0/")).toBe(
      "กำลังเปิดอีเมล",
    );

    expect(formatThaiToolActivity("Opening page: https://shopee.co.th/search?keyword=water")).toBe(
      "กำลังเปิดหน้าเว็บ: https://shopee.co.th/search?keyword=water",
    );

    expect(formatThaiToolActivity("Reading the page")).toBe("กำลังอ่านข้อมูลหน้าเว็บ");
    expect(formatThaiToolActivity("Using the page")).toBe("กำลังทำงานบนหน้าเว็บ");
    expect(formatThaiToolActivity("Operating the computer")).toBe("กำลังสั่งการบนหน้าจอ");
    expect(formatThaiToolActivity("Reading notes/config.json")).toBe("กำลังอ่าน: notes/config.json");
    expect(formatThaiToolActivity("Connecting MCP server: Linear")).toBe("กำลังเชื่อมต่อ MCP: Linear");
    expect(formatThaiToolActivity("Searching the web: rakazo docs")).toBe("กำลังค้นหาข้อมูล: rakazo docs");
  });

  it("preserves non-activity strings and doesn't mangle codes", () => {
    const codeSnippet = 'const token = "XYZ123";';
    expect(formatThaiToolActivity(codeSnippet)).toBe(codeSnippet);
  });
});
