import { describe, expect, it } from "vitest";
import {
  detectExplicitLanguageOverride,
  formatThaiToolActivity,
  isLanguageNeutralTurn,
  isThaiConversation,
  repairThaiExplanation,
  resolveConversationLocale,
  userLanguageInstruction,
} from "./run-language.js";

describe("run-language", () => {
  it("detects Thai prompts and returns focused instruction without old task baggage", () => {
    const instruction = userLanguageInstruction("list files ใน qa-real-20261013-a เท่านั้น");
    expect(instruction).toBeDefined();
    expect(instruction).toContain("ผู้ใช้สื่อสารเป็นภาษาไทย");
    // Should NOT contain task-specific baggage from old incidents or tools
    expect(instruction).not.toContain("attempt 1, 2, 3, 4");
    expect(instruction).not.toContain("browser_navigate");
    expect(instruction).not.toContain("DNS resolution");
    expect(instruction).toContain("ให้คงชื่อไฟล์ พาธ URL อีเมล ตัวเลข โค้ด คีย์ JSON");
  });

  it("leaves English prompts undefined", () => {
    expect(userLanguageInstruction("list files in workspace")).toBeUndefined();
  });

  it("persists Thai conversation locale across email-only, URL-only, filename-only, short continuation, and takeover resume turns (T37a/b)", () => {
    const thaiHistory = [
      "ช่วยเปิดหน้าล็อกอินแล้วกรอกอีเมลให้หน่อย",
    ];
    // Email-only follow-up
    expect(resolveConversationLocale("somchai.dev@example.co.th", thaiHistory)).toBe("th");
    expect(isThaiConversation("somchai.dev@example.co.th", thaiHistory)).toBe(true);
    expect(userLanguageInstruction("somchai.dev@example.co.th", "", thaiHistory)).toContain(
      "ผู้ใช้สื่อสารเป็นภาษาไทย",
    );

    // URL-only follow-up after email-only
    const afterEmailHistory = ["somchai.dev@example.co.th", ...thaiHistory];
    expect(resolveConversationLocale("https://portal.example.co.th/login", afterEmailHistory)).toBe(
      "th",
    );
    expect(isThaiConversation("https://portal.example.co.th/login", afterEmailHistory)).toBe(true);

    // Short continuation / version / filename follow-ups
    const afterUrlHistory = ["https://portal.example.co.th/login", ...afterEmailHistory];
    for (const token of ["next", "ok", "v2", "report-v2.csv", "Respond to the user's steering context."]) {
      expect(isLanguageNeutralTurn(token)).toBe(true);
      expect(resolveConversationLocale(token, afterUrlHistory)).toBe("th");
      expect(isThaiConversation(token, afterUrlHistory)).toBe(true);
    }
  });

  it("switches to English when the user explicitly requests English, even with Thai script or Thai history (T37c)", () => {
    const thaiHistory = ["ช่วยสรุปไฟล์ brief.md ให้หน่อย"];
    expect(detectExplicitLanguageOverride("Please reply in English: summarize brief.md")).toBe("en");
    expect(detectExplicitLanguageOverride("ช่วยตอบเป็นภาษาอังกฤษเท่านั้นครับ")).toBe("en");
    expect(
      resolveConversationLocale("ช่วยตอบเป็นภาษาอังกฤษเท่านั้นครับ", thaiHistory),
    ).toBe("en");
    expect(isThaiConversation("ช่วยตอบเป็นภาษาอังกฤษเท่านั้นครับ", thaiHistory)).toBe(false);

    const enInstruction = userLanguageInstruction(
      "ช่วยตอบเป็นภาษาอังกฤษเท่านั้นครับ",
      "",
      thaiHistory,
    );
    expect(enInstruction).toBeDefined();
    expect(enInstruction).toContain("explicitly requested a response in English");
    expect(enInstruction).not.toContain("ห้ามเปลี่ยนคำอธิบายกลับเป็นภาษาอังกฤษ");

    // Do NOT false-positive on "อ่านเอกสารภาษาอังกฤษแล้วสรุปเป็นภาษาไทย"
    expect(
      detectExplicitLanguageOverride("อ่านเอกสารภาษาอังกฤษใน brief.md แล้วสรุปเป็นภาษาไทย"),
    ).toBe("th");
    expect(
      isThaiConversation("อ่านเอกสารภาษาอังกฤษใน brief.md แล้วสรุปเป็นภาษาไทย", thaiHistory),
    ).toBe(true);
  });

  it("repairs 'Here are the files in the `...` directory:' into Thai", () => {
    const input =
      "Here are the files in the `qa-real-20261013-a` directory:\n- `qa-real-20261013-a/base-policy.md`\n- `qa-real-20261013-a/brief.md`";
    const output = repairThaiExplanation(input, true);
    expect(output).not.toContain("Here are the files");
    expect(output).toContain("พบไฟล์ต่อไปนี้ในโฟลเดอร์ `qa-real-20261013-a`:");
    // Preserves paths and inline code
    expect(output).toContain("- `qa-real-20261013-a/base-policy.md`");
    expect(output).toContain("- `qa-real-20261013-a/brief.md`");
  });

  it("repairs various list file English preambles into Thai", () => {
    const v1 = "Here is the list of files in `qa-real-20261013-a`:\n- `test.txt`";
    expect(repairThaiExplanation(v1, true)).toContain("รายการไฟล์ใน `qa-real-20261013-a` มีดังนี้:");

    const v2 = "The files in `qa-real-20261013-a` are:\n- `test.txt`";
    expect(repairThaiExplanation(v2, true)).toContain("ไฟล์ใน `qa-real-20261013-a` มีดังนี้:");
  });

  it("repairs English boilerplate progress phrases into Thai", () => {
    const input =
      "I have found the following files in the `qa-other-20261012` directory:\n- `brief.md`\nI will now read the specified files to gather the information needed to make the decisions.";
    const output = repairThaiExplanation(input, true);
    expect(output).not.toContain("I have found");
    expect(output).not.toContain("I will now read");
    expect(output).toContain("พบไฟล์ต่อไปนี้ในโฟลเดอร์ `qa-other-20261012`:");
    expect(output).toContain("กำลังอ่านไฟล์ที่ระบุเพื่อรวบรวมข้อมูลประกอบการตัดสินใจ");
  });

  it("strips leaked <think> blocks, English reasoning headers, and unfenced stack traces while preserving code/URLs/emails", () => {
    const leaked =
      "<think>\nI need to inspect /home/rakazo/report-v2.csv first.\n</think>\nThought: Let me read the file first.\nสรุปข้อมูลสำหรับ `ops.user@example.co.th` ที่ https://portal.example.co.th/login เรียบร้อยแล้ว\n    at Object.execute (/app/packages/adapters/src/executor.ts:100:12)\n    at processTicksAndRejections (node:internal/process/task_queues:95:5)";
    const output = repairThaiExplanation(leaked, true);
    expect(output).not.toContain("<think>");
    expect(output).not.toContain("I need to inspect");
    expect(output).not.toContain("Thought:");
    expect(output).not.toContain("at Object.execute");
    expect(output).toContain("ops.user@example.co.th");
    expect(output).toContain("https://portal.example.co.th/login");
  });

  it("localizes English takeover handoff prefixes and tool activities into Thai", () => {
    const takeoverText =
      "[Ready for Input] Reached login form at https://accounts.google.com/signin. กรุณากรอกรหัสผ่านของคุณ";
    const repaired = repairThaiExplanation(takeoverText, true);
    expect(repaired).not.toContain("[Ready for Input]");
    expect(repaired).toContain("[พร้อมกรอกข้อมูล]");
    expect(repaired).toContain("https://accounts.google.com/signin");

    expect(formatThaiToolActivity("Waiting for your answer")).toBe("รอคำตอบเพิ่มเติมจากคุณ");
    expect(formatThaiToolActivity("Rendering a document")).toBe("กำลังสร้างเอกสาร");
    expect(formatThaiToolActivity("Searching conversation history")).toBe("กำลังค้นหาประวัติสนทนา");
  });

  it("preserves inline code, code fences, and verbatim strings untouched", () => {
    const input =
      'คืนโค้ด JavaScript ด้านล่างตรงต้นฉบับ:\n```js\nconst note = "I have read all the specified files.";\n```\nและตัวแปร `note_id`';
    const output = repairThaiExplanation(input, true);
    expect(output).toContain('const note = "I have read all the specified files.";');
    expect(output).toContain("`note_id`");
  });

  it("preserves JSON array and object blocks untouched", () => {
    const arrayInput =
      'ผลลัพธ์:\n[\n  {"person": "Mali", "decision": "DENY", "note": "Here are the files"}\n]';
    const output = repairThaiExplanation(arrayInput, true);
    expect(output).toContain('"Here are the files"');

    const objInput =
      'ผลลัพธ์:\n{\n  "status": "ready",\n  "message": "Here are the files"\n}';
    const objOutput = repairThaiExplanation(objInput, true);
    expect(objOutput).toContain('"Here are the files"');
  });

  it("leaves non-Thai turns untouched", () => {
    const input = "Here are the files in the `test` directory:";
    expect(repairThaiExplanation(input, false)).toBe(input);
  });
});
