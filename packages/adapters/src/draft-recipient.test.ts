import { describe, expect, it } from "vitest";
import {
  extractExplicitRecipientTarget,
  isDraftOnlyTask,
  reconcileDraftRecipientInJson,
} from "./draft-recipient.js";

describe("draft-recipient", () => {
  it("extracts explicit recipient from Thai instruction", () => {
    const prompt =
      "อ่าน mail-thread.eml ร่างคำตอบภาษาไทยในแชตเท่านั้นให้ Alex ที่ alex@example.test โดยใช้ข้อความล่าสุด";
    const target = extractExplicitRecipientTarget(prompt);
    expect(target).toEqual({ name: "Alex", email: "alex@example.test" });
  });

  it("extracts explicit recipient from English instruction", () => {
    const prompt = "Please draft a response in chat to Sarah at sarah@company.test";
    const target = extractExplicitRecipientTarget(prompt);
    expect(target).toEqual({ name: "Sarah", email: "sarah@company.test" });
  });

  it("reconciles JSON recipient when model picked source message To header instead of explicit user target", () => {
    const userPrompt = "ร่างคำตอบภาษาไทยในแชตเท่านั้นให้ Alex ที่ alex@example.test";
    const modelJson = JSON.stringify({
      recipient: "qa@example.test",
      draft_thai: "สวัสดี Alex,\n\nได้รับข้อความแล้ว",
    });

    const reconciled = reconcileDraftRecipientInJson(modelJson, userPrompt);
    const parsed = JSON.parse(reconciled);
    expect(parsed.recipient).toBe("alex@example.test");
  });

  it("honors latest user instruction when recipient changes", () => {
    const initialPrompt = "ร่างให้ Bob ที่ bob@example.test";
    const updatedPrompt = "เปลี่ยนเป็นส่งให้ Charlie ที่ charlie@example.test แทน";
    const modelJson = JSON.stringify({
      recipient: "bob@example.test",
      draft_thai: "สวัสดี Bob",
    });

    const reconciled = reconcileDraftRecipientInJson(modelJson, updatedPrompt);
    const parsed = JSON.parse(reconciled);
    expect(parsed.recipient).toBe("charlie@example.test");
    expect(parsed.draft_thai).toBe("สวัสดี Charlie");
  });

  it("identifies draft-only task and forbids send tools", () => {
    const prompt =
      "อ่าน qa-other-20261012/mail-thread.eml จริง เป็นอีเมลจำลองในไฟล์ ไม่ต้องเชื่อม Gmail หรือส่งเมล ร่างคำตอบภาษาไทยในแชตเท่านั้นให้ Alex ที่ alex@example.test ห้ามส่งอีเมล";
    expect(isDraftOnlyTask(prompt)).toBe(true);
  });

  it("extracts multiword names in Thai and English", () => {
    const thai = extractExplicitRecipientTarget("ร่างอีเมลให้ Alex Smith ที่ alex@example.test");
    expect(thai).toEqual({ name: "Alex Smith", email: "alex@example.test" });

    const eng = extractExplicitRecipientTarget("Draft to Alex Smith at alex@example.test");
    expect(eng).toEqual({ name: "Alex Smith", email: "alex@example.test" });
  });

  it("ignores negated prohibited recipient and prefers correction", () => {
    const negated = extractExplicitRecipientTarget("ห้ามส่งให้ old@example.test ให้ new@example.test");
    expect(negated?.email).toBe("new@example.test");

    const corrected = extractExplicitRecipientTarget(
      "Draft to First at first@example.test. Correction: draft to Second at second@example.test.",
    );
    expect(corrected?.email).toBe("second@example.test");
  });

  it("recognizes draft first / do not send intent", () => {
    expect(isDraftOnlyTask("ร่างอีเมลไว้ก่อน อย่าเพิ่งส่ง")).toBe(true);
    expect(isDraftOnlyTask("เตรียมร่าง ไม่ส่งจริง")).toBe(true);
  });
});
