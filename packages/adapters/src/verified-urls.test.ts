import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import {
  extractExplicitUrls,
  findVerifiedUrlsForSpace,
  formatThaiBrowserFailureMessage,
  formatThaiDnsFailureMessage,
  formatVerifiedUrlsInstruction,
  isProbeOrInspectionTask,
} from "./verified-urls.js";

describe("verified URLs extraction and Thai message formatting", () => {
  it("extracts explicit URLs and deduplicates them", () => {
    const text =
      "Please visit https://flick.docchula.com/ and also check http://example.com/test as well as https://flick.docchula.com/";
    const urls = extractExplicitUrls(text);
    expect(urls).toEqual(["https://flick.docchula.com/", "http://example.com/test"]);
  });

  it("finds verified URLs from externalEffect and user messages but excludes unconfirmed model texts", async () => {
    const mockPrisma = {
      externalEffect: {
        findMany: async () => [
          {
            request: { url: "https://flick.docchula.com/" },
            result: { ok: true, url: "https://flick.docchula.com/" },
          },
          // Failed navigation should not be included as verified
          {
            request: { url: "https://flick.mdcu.ac.th/" },
            result: { ok: false, error: "net::ERR_NAME_NOT_RESOLVED" },
          },
        ],
      },
      message: {
        findMany: async () => [
          {
            blocks: [{ type: "text", text: "Here is the portal: https://flick.docchula.com/" }],
          },
        ],
      },
    } as unknown as PrismaClient;

    const urls = await findVerifiedUrlsForSpace(mockPrisma, "space-1", "flick");
    expect(urls).toEqual(["https://flick.docchula.com/"]);
    expect(urls).not.toContain("https://flick.mdcu.ac.th/");
  });

  it("detects probe / inspection tasks vs action tasks in Thai and English", () => {
    expect(isProbeOrInspectionTask("ตรวจว่า URL นี้เข้าได้ไหม")).toBe(true);
    expect(isProbeOrInspectionTask("เช็กว่า flick.mdcu.ac.th ล่มไหม")).toBe(true);
    expect(isProbeOrInspectionTask("ทดสอบว่าระบบยังออนไลน์อยู่ไหม")).toBe(true);
    expect(isProbeOrInspectionTask("verify if website is reachable")).toBe(true);
    expect(isProbeOrInspectionTask("is https://example.com up?")).toBe(true);

    // Action tasks should NOT be treated as probe tasks
    expect(
      isProbeOrInspectionTask("เข้าเว็บ flick mdcu ให้หน่อยแล้วเปิดเข้าหน้า NS3รอที่รายการเลือกคลิป"),
    ).toBe(false);
    expect(isProbeOrInspectionTask("ไปที่หน้าหลักแล้วกดปุ่ม Save")).toBe(false);
    expect(isProbeOrInspectionTask("login to the portal and submit form")).toBe(false);
  });

  it("formats Thai DNS failure message with verified URL suggestions", () => {
    const msgWithSuggestions = formatThaiDnsFailureMessage({
      hostname: "flick.mdcu.ac.th",
      suggestions: ["https://flick.docchula.com/"],
    });
    expect(msgWithSuggestions).toContain("เปิด flick.mdcu.ac.th ไม่ได้ เพราะตรวจไม่พบชื่อโดเมนใน DNS");
    expect(msgWithSuggestions).toContain("คอมพิวเตอร์บอตยังเข้าเว็บไซต์อื่นได้ตามปกติ");
    expect(msgWithSuggestions).toContain("มี URL ที่เคยเปิดสำเร็จคือ https://flick.docchula.com/");
    expect(msgWithSuggestions).toContain("ต้องการเปิด URL นี้หรือระบุ URL อื่น?");

    const msgWithoutSuggestions = formatThaiDnsFailureMessage({
      hostname: "flick.mdcu.ac.th",
    });
    expect(msgWithoutSuggestions).toContain("กรุณาตรวจสอบชื่อโดเมนหรือระบุ URL ที่ถูกต้อง");

    const msgUnrelatedHistory = formatThaiDnsFailureMessage({
      hostname: "notfound-random-corp.example",
      suggestions: ["https://private-admin.internal/keys", "https://secret-dashboard.company/"],
    });
    expect(msgUnrelatedHistory).not.toContain("private-admin");
    expect(msgUnrelatedHistory).not.toContain("secret-dashboard");
    expect(msgUnrelatedHistory).toContain("กรุณาตรวจสอบชื่อโดเมนหรือระบุ URL ที่ถูกต้อง");
  });

  it("formats Thai browser failure message for runs", () => {
    const blockedNxdomain = {
      errorCode: "NXDOMAIN",
      hostname: "flick.mdcu.ac.th",
      suggestions: ["https://flick.docchula.com/"],
    };
    const formatted = formatThaiBrowserFailureMessage(blockedNxdomain);
    expect(formatted).toContain("ยังทำงานไม่สำเร็จ:");
    expect(formatted).toContain("เปิด flick.mdcu.ac.th ไม่ได้ เพราะตรวจไม่พบชื่อโดเมนใน DNS");
    expect(formatted).toContain("มี URL ที่เคยเปิดสำเร็จคือ https://flick.docchula.com/");
  });

  it("does not leak English developer guidance note into Thai failure message", () => {
    const blockedAction = {
      error: "Page actions paused after a browser failure: Stale element ref",
      fallback: "computer_act",
      note: "Do not retry browser_act or request another approval for it in this run.",
    };
    const formatted = formatThaiBrowserFailureMessage(blockedAction);
    expect(formatted).toContain("ยังทำงานไม่สำเร็จ:");
    expect(formatted).not.toContain("Do not retry browser_act");
    expect(formatted).toContain("ไม่สามารถคลิกหรือสั่งการบนหน้าเว็บได้");
  });

  it("proactively injects verified URLs into page instructions", () => {
    const instructions = formatVerifiedUrlsInstruction(["https://flick.docchula.com/"]);

    expect(instructions).toContain("Verified URLs from earlier confirmed history in this workspace: https://flick.docchula.com/");
    expect(instructions).toContain("When the user refers to recent or previously opened websites without typing the full URL, use these confirmed URLs directly.");
  });
});
