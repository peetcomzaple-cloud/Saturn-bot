import { describe, expect, it } from "vitest";
import { isSearchTask, verifyWebGoal } from "./web-goal-verification.js";

describe("Thai conditional search classification", () => {
  it("preserves the existing local-workspace exclusion", () => {
    expect(isSearchTask("ค้นหาไฟล์ในโฟลเดอร์ /tmp/documents")).toBe(false);
    expect(isSearchTask("ค้นหาคู่มือบนเว็บไซต์ https://example.test")).toBe(true);
  });

  it.each([
    "หากขั้นนี้เปิดไม่ได้ให้รายงานข้อผิดพลาด",
    "หากเปิดไม่ได้ให้หยุด",
    "หากระบบไม่ตอบสนองให้รอ",
    "หากเกิดข้อผิดพลาดให้รายงานตามจริง",
    "หากมีข้อผิดพลาดให้รายงาน",
    "หากยังเปิดไม่ได้ให้รอ",
    "หาก หน้านี้โหลดไม่ได้ให้หยุด",
  ])("does not require search submission for a conditional: %s", (prompt) => {
    expect(isSearchTask(prompt)).toBe(false);
  });

  it.each([
    "หากระเป๋า",
    "ช่วยหากุญแจ",
    "หา กุญแจ",
    "หากเปิดไม่ได้ให้ค้นหาสาเหตุ",
    "หากขั้นนี้ล้มเหลว แล้วหาคู่มือ",
    "หากระบบไม่ตอบสนอง search for alternatives",
  ])("preserves search commands alongside conditionals: %s", (prompt) => {
    expect(isSearchTask(prompt)).toBe(true);
    expect(verifyWebGoal(prompt, { actionsAttempted: 1, navigationOnly: true }).ok).toBe(false);
  });

  it("does not impose a search requirement on navigation recovery instructions", () => {
    const prompt = "เปิด https://example.test/timeout ถ้าเปิดไม่ได้ให้รายงานข้อผิดพลาดตามจริง " +
      "แล้วเปิด https://example.test/offline หากขั้นนี้เปิดไม่ได้ ให้รายงานข้อผิดพลาดตามจริง " +
      "รออย่างน้อย 12 วินาที จากนั้นเปิด https://example.test/recovered และคัดลอกรหัสยืนยันที่ปรากฏครับ " +
      "ห้ามล้างคุกกี้หรือข้อมูลเว็บ ห้ามข้ามขั้นตอน และห้ามเปิดแท็บใหม่";
    expect(isSearchTask(prompt)).toBe(false);
    expect(verifyWebGoal(prompt, {
      actionsAttempted: 3,
      lastActionOk: true,
      navigationOnly: true,
      initialUrl: "https://example.test/timeout",
      currentUrl: "https://example.test/recovered",
      domStateChanged: true,
    }).ok).toBe(true);
    expect(verifyWebGoal(prompt, {
      actionsAttempted: 3,
      lastActionOk: false,
      lastActionError: "net::ERR_INTERNET_DISCONNECTED",
    }).ok).toBe(false);
  });

});
