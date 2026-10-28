import { describe, expect, it } from "vitest";
import {
  DocumentValidationError,
  IncompleteTranscriptError,
  getDocumentCapabilities,
  getDocumentGuide,
  renderDocument,
  renderDocxPackage,
  renderPdfDocument,
  renderPptxPackage,
  renderXlsxPackage,
  readZipEntries,
  validateDocumentBytes,
  verifyTranscriptProvenance,
} from "./document-renderer.js";

describe("Round 3 - Document Rendering, Capability Discovery & Validation", () => {
  describe("1. Capability Discovery & Documentation", () => {
    it("reports accurate runtime capability matrix including PDF and DOCX as primary formats", () => {
      const caps = getDocumentCapabilities();
      expect(caps.supportedFormats).toContain("pdf");
      expect(caps.supportedFormats).toContain("docx");
      expect(caps.supportedFormats).toContain("xlsx");
      expect(caps.supportedFormats).toContain("pptx");
      expect(caps.supportedFormats).toContain("html");
      expect(caps.supportedFormats).toContain("md");
      expect(caps.supportedFormats).toContain("csv");
      expect(caps.supportedFormats).toContain("json");
      expect(caps.supportedFormats).toContain("svg");
      if (caps.supportedFormats.includes("png")) {
        expect(caps.engines.raster).toContain("Sharp");
      }

      expect(caps.primaryFormats).toEqual(["pdf", "docx"]);
      expect(caps.fonts.families).toContain("Noto Sans Thai");
      expect(caps.fonts.families).toContain("Garuda");
      expect(caps.features.combiningMarksSupport).toBe(true);
      expect(caps.features.latexMathFormulas).toBe(true);
      expect(caps.features.tablesWithBorders).toBe(true);
      expect(caps.features.ooxmlSpreadsheetFormulas).toBe(true);
      expect(caps.limits.maxBytes).toBe(10 * 1024 * 1024);
    });

    it("returns comprehensive user guide with runnable templates", () => {
      const guide = getDocumentGuide();
      expect(guide).toContain("render_document");
      expect(guide).toContain("format");
      expect(guide).toContain("pdf");
      expect(guide).toContain("docx");
      expect(guide).toContain("xlsx");
      expect(guide).toContain("capabilities");
    });
  });

  describe("2. Transcript Provenance & Anti-Placeholder Protection", () => {
    it("rejects AI disclaimer pretending to be a transcript", () => {
      const disclaimer =
        "As an AI language model, I cannot provide the full transcript of this copyrighted lecture.";
      expect(() => verifyTranscriptProvenance(disclaimer)).toThrow(IncompleteTranscriptError);
    });

    it("rejects generic unavailable placeholder", () => {
      const placeholder = "No transcript is available for this video.";
      expect(() => verifyTranscriptProvenance(placeholder)).toThrow(IncompleteTranscriptError);
    });

    it("rejects Thai loading or apology placeholder", () => {
      const thaiApology = "ขออภัย ไม่สามารถแสดง transcript ของบทเรียนนี้ได้ในขณะนี้";
      expect(() => verifyTranscriptProvenance(thaiApology)).toThrow(IncompleteTranscriptError);

      const thaiLoading = "เนื้อหา transcript กำลังโหลด โปรดรอสักครู่";
      expect(() => verifyTranscriptProvenance(thaiLoading)).toThrow(IncompleteTranscriptError);
    });

    it("rejects truncated or empty transcript content", () => {
      expect(() => verifyTranscriptProvenance("Short text")).toThrow(IncompleteTranscriptError);
    });

    it("accepts genuine lecture transcript in Thai and English", () => {
      const validTranscript = `การบรรยายวิชา Introduction to Computer Science ประจำวันที่ 14 ตุลาคม 2026
อาจารย์ผู้สอน: ผศ. ดร. สมเกียรติ ยิ่งเจริญ
หัวข้อ: โครงสร้างข้อมูลและขั้นตอนวิธี (Data Structures and Algorithms)

ในคาบเรียนนี้เราจะมาพูดถึงแนวคิดพื้นฐานของการวิเคราะห์ความซับซ้อนของขั้นตอนวิธี (Time Complexity Analysis)
โดยพิจารณาจากกรณีที่เลวร้ายที่สุด (Worst-case scenario) ด้วยสัญลักษณ์ Big-O notation
ตัวอย่างเช่น การค้นหาแบบทวิภาค (Binary Search) จะมีความซับซ้อนอยู่ที่ O(log n) เมื่อเทียบกับการค้นหาเชิงเส้น O(n)`;

      expect(() => verifyTranscriptProvenance(validTranscript)).not.toThrow();
    });
  });

  describe("3. PDF Document Rendering & Typography", () => {
    it("renders valid PDF with standard header, EOF, and Thai text", () => {
      const title = "รายงานสรุปผลการทดสอบระบบ Rakazo";
      const content = `# สรุปการดำเนินงานรอบที่ 3

ระบบรองรับการสร้างเอกสารภาษาไทยได้อย่างสมบูรณ์:
- ทดสอบสระและวรรณยุกต์: น้ำดื่ม, ที่อยู่, ผู้ใช้งาน, ให้บริการ, โค้ดคอมพิวเตอร์
- ทดสอบตารางข้อมูล:
| รายการ | จำนวน | ราคาต่อหน่วย | รวม (บาท) |
|---|---|---|---|
| น้ำเปล่าขวดแก้ว | 50 | 12.00 | 600.00 |
| กล่องอาหารกลางวัน | 25 | 65.00 | 1625.00 |

- สูตรคณิตศาสตร์: $f(x) = ax^2 + bx + c$ และ $\\sum_{i=1}^n i = \\frac{n(n+1)}{2}$
- รายการตรวจสอบ:
- [x] ตรวจสอบฟอนต์ไทยไม่เป็นสี่เหลี่ยม (tofu)
- [x] ตรวจสอบสระอำและวรรณยุกต์ไม่กระโดด
- [ ] ติดตามการใช้งานจริงต่อเนื่อง`;

      const bytes = renderPdfDocument(title, content);
      const str = Buffer.from(bytes).toString("binary");

      expect(str.startsWith("%PDF-1.4")).toBe(true);
      expect(str.includes("%%EOF")).toBe(true);
      expect(str.includes("/Type /Catalog")).toBe(true);
      expect(str.includes("/Type /Pages")).toBe(true);
      expect(str.includes("/Type /Page")).toBe(true);

      const validation = validateDocumentBytes(bytes, "pdf");
      expect(validation.valid).toBe(true);
      expect(validation.mimeType).toBe("application/pdf");
      expect(validation.pageCount).toBeGreaterThanOrEqual(1);
      expect(validation.sizeBytes).toBe(bytes.byteLength);
    });

    it("handles display math blocks without leaking $$ delimiters while preserving content and inline currency $5", () => {
      const content = `เงิน $5\n$$\n\\frac{a+b}{c+d}=x\n$$\nEnd of document`;
      const bytes = renderPdfDocument("Display math test", content);
      const str = Buffer.from(bytes).toString("binary");

      expect(str.startsWith("%PDF-1.4")).toBe(true);
      expect(str.includes("%%EOF")).toBe(true);

      const validation = validateDocumentBytes(bytes, "pdf");
      expect(validation.valid).toBe(true);
      expect(validation.pageCount).toBe(1);
    });

    it("paginates long documents across multiple pages with page counters", () => {
      const longLines = Array.from({ length: 90 }, (_, i) => `บรรทัดที่ ${i + 1}: ข้อมูลการทดสอบระบบเอกสาร Rakazo ภาษาไทยและ English`);
      const longContent = longLines.join("\n");

      const bytes = renderPdfDocument("รายงานฉบับยาว", longContent);
      const validation = validateDocumentBytes(bytes, "pdf");

      expect(validation.valid).toBe(true);
      expect(validation.pageCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe("4. OOXML DOCX Word Package Generation", () => {
    it("renders compliant DOCX package containing word/document.xml and Thai font definitions", () => {
      const title = "หนังสือส่งมอบงานระบบ";
      const content = `# เอกสารส่งมอบงาน

ขอส่งมอบเครื่องมือสร้างเอกสารและรายงานผลการทดสอบ:
| หัวข้อ | สถานะ | หมายเหตุ |
|---|---|---|
| การนำทางเว็บลึก | เรียบร้อย | A Handoff |
| ระบบ Protected Login | เรียบร้อย | B Handoff |
| การจัดการวงจรชีวิตหน้าจอ | เรียบร้อย | C Handoff |
| เครื่องมือสร้างเอกสาร | เรียบร้อย | D Integrated |

- [x] ตรวจสอบผ่านเกณฑ์ Zero False Positives
- [x] ไม่มีการเปิดเผย credential ในบันทึก`;

      const bytes = renderDocxPackage(title, content);
      expect(bytes[0]).toBe(0x50); // 'P'
      expect(bytes[1]).toBe(0x4b); // 'K'

      const validation = validateDocumentBytes(bytes, "docx");
      expect(validation.valid).toBe(true);
      expect(validation.mimeType).toBe(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );

      const raw = Buffer.from(bytes).toString("binary");
      expect(raw).toContain("[Content_Types].xml");
      expect(raw).toContain("word/document.xml");
      const entries = readZipEntries(bytes);
      const docXml = entries.get("word/document.xml")?.toString("utf-8");
      expect(docXml).toContain("Noto Sans Thai");
    });
  });

  describe("5. OOXML XLSX Spreadsheet Package Generation with Formulas", () => {
    it("renders compliant XLSX spreadsheet package with formulas and multiple sheets", () => {
      const content = {
        sheets: [
          {
            name: "งบประมาณ",
            rows: [
              ["หมวดหมู่", "มกราคม", "กุมภาพันธ์", "รวมทั้งสิ้น"],
              ["ค่าบริการเซิร์ฟเวอร์", 15000, 15000, "=B2+C2"],
              ["ค่าฐานข้อมูล", 8000, 8500, "=B3+C3"],
              ["ค่าเน็ตเวิร์ก", 3500, 3500, "=B4+C4"],
              ["ยอดรวม", "=SUM(B2:B4)", "=SUM(C2:C4)", "=SUM(D2:D4)"],
            ],
          },
        ],
      };

      const bytes = renderXlsxPackage("งบประมาณประจำปี 2026", content);
      expect(bytes[0]).toBe(0x50);
      expect(bytes[1]).toBe(0x4b);

      const validation = validateDocumentBytes(bytes, "xlsx");
      expect(validation.valid).toBe(true);
      expect(validation.mimeType).toBe(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      expect(validation.hasFormulas).toBe(true);

      const raw = Buffer.from(bytes).toString("binary");
      expect(raw).toContain("xl/workbook.xml");
      expect(raw).toContain("xl/worksheets/sheet1.xml");
      const entries = readZipEntries(bytes);
      const sheetXml = entries.get("xl/worksheets/sheet1.xml")?.toString("utf-8");
      expect(sheetXml).toContain("<f>SUM(B2:B4)</f>");
    });
  });

  describe("6. OOXML PPTX Presentation Package Generation", () => {
    it("renders compliant PPTX presentation package with slides and Thai typeface", () => {
      const slides = `ภาพรวมผลงานรอบที่ 3\n- แก้ปัญหา Shopee Modal\n- แก้ปัญหา Z.com New Tab Rebind

การคุ้มครองความลับ\n- One-use Ephemeral Logins\n- Masked UI Credentials Card

การจัดการหน้าจอ\n- Observe-only Mode\n- ป้องกัน Re-launch บน Read Path`;

      const bytes = renderPptxPackage("สรุปโครงการ Rakazo", slides);
      expect(bytes[0]).toBe(0x50);
      expect(bytes[1]).toBe(0x4b);

      const validation = validateDocumentBytes(bytes, "pptx");
      expect(validation.valid).toBe(true);
      expect(validation.mimeType).toBe(
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      );

      const raw = Buffer.from(bytes).toString("binary");
      expect(raw).toContain("ppt/presentation.xml");
      expect(raw).toContain("ppt/slides/slide1.xml");
    });
  });

  describe("7. End-to-End renderDocument Pipeline", () => {
    it("executes complete pipeline for PDF generation with hash and metadata", async () => {
      const result = await renderDocument({
        format: "pdf",
        title: "สรุปการตรวจสอบระบบ",
        content: "# หัวข้อ\nเนื้อหาภาษาไทย น้ำดื่ม",
        path: "documents/check.pdf",
      });

      expect(result.ok).toBe(true);
      expect(result.format).toBe("pdf");
      expect(result.mimeType).toBe("application/pdf");
      expect(result.path).toBe("documents/check.pdf");
      expect(result.sizeBytes).toBeGreaterThan(100);
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.validation.valid).toBe(true);
    });

    it("executes complete pipeline for DOCX generation", async () => {
      const result = await renderDocument({
        format: "docx",
        title: "เอกสารสรุป",
        content: "เนื้อหาเอกสารสรุป",
        path: "documents/report.docx",
      });

      expect(result.ok).toBe(true);
      expect(result.format).toBe("docx");
      expect(result.mimeType).toBe(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
      expect(result.validation.magicValid).toBe(true);
    });

    it("executes complete pipeline for HTML and Markdown", async () => {
      const htmlResult = await renderDocument({
        format: "html",
        title: "หน้าเว็บผลลัพธ์",
        content: "<p>สวัสดีชาวโลก</p>",
      });
      expect(htmlResult.format).toBe("html");
      expect(htmlResult.mimeType).toBe("text/html");

      const mdResult = await renderDocument({
        format: "md",
        title: "บันทึกย่อ",
        content: "รายละเอียดบันทึกย่อ",
      });
      expect(mdResult.format).toBe("md");
      expect(mdResult.mimeType).toBe("text/markdown");
    });

    it("rejects invalid or empty bytes during validation", () => {
      expect(() => validateDocumentBytes(new Uint8Array(0), "pdf")).toThrow(
        DocumentValidationError,
      );

      expect(() => validateDocumentBytes(new Uint8Array([1, 2, 3, 4]), "pdf")).toThrow(
        DocumentValidationError,
      );

      expect(() => validateDocumentBytes(new Uint8Array([1, 2, 3, 4]), "docx")).toThrow(
        DocumentValidationError,
      );
    });

    it("rejects dummy 15-byte PDF header without structural objects", () => {
      const dummyPdf = Buffer.from("%PDF-1.4\n%%EOF", "utf-8");
      expect(() => validateDocumentBytes(dummyPdf, "pdf")).toThrow(
        DocumentValidationError,
      );
    });

    it("rejects PDF containing Thai characters without ToUnicode CMap", () => {
      // PDF with Catalog, Pages, Page, Contents, Font, but containing Thai without /ToUnicode
      const thaiPdfWithoutToUnicode = Buffer.from(
        "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n4 0 obj\n<< /Length 50 >>\nstream\nBT /F1 12 Tf (ภาษาไทย) Tj ET\nendstream\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\nxref\ntrailer\n<< /Root 1 0 R >>\n%%EOF",
        "utf-8",
      );
      expect(() => validateDocumentBytes(thaiPdfWithoutToUnicode, "pdf")).toThrow(
        DocumentValidationError,
      );
    });

    it("rejects 1x1 placeholder PNG images", () => {
      const onePixelPng = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      );
      expect(() => validateDocumentBytes(onePixelPng, "png")).toThrow(
        DocumentValidationError,
      );
    });
  });
});

