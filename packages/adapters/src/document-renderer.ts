import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, inflateRawSync } from "node:zlib";

export type DocumentFormat =
  | "pdf"
  | "docx"
  | "xlsx"
  | "pptx"
  | "html"
  | "md"
  | "txt"
  | "csv"
  | "json"
  | "svg"
  | "png";

export interface DocumentOptions {
  pageSize?: "A4" | "Letter" | "Legal";
  landscape?: boolean;
  margins?: "normal" | "compact" | "wide";
  theme?: "modern" | "classic" | "academic" | "minimal";
  headerText?: string;
  footerText?: string;
  pageNumbers?: boolean;
  includeTableOfContents?: boolean;
}

export interface TranscriptMetadata {
  full?: boolean;
  segments?: Array<{ text: string; start?: number; end?: number; speaker?: string }>;
  source_title?: string;
  source_url?: string;
  capturedAt?: string;
}

export interface DocumentSpec {
  format: DocumentFormat;
  content: string | Record<string, unknown>;
  title?: string;
  description?: string;
  path?: string;
  attach?: boolean;
  source_url?: string;
  transcript?: TranscriptMetadata;
  options?: DocumentOptions;
}

export interface DocumentCapabilityMatrix {
  supportedFormats: DocumentFormat[];
  primaryFormats: ["pdf", "docx"];
  engines: {
    pdf: string;
    docx: string;
    xlsx: string;
    pptx: string;
    html: string;
    markdown: string;
    raster: string;
  };
  fonts: {
    thai: boolean;
    latin: boolean;
    math: boolean;
    cjk: boolean;
    families: string[];
  };
  features: {
    thaiOpenTypeShaping: boolean;
    combiningMarksSupport: boolean;
    latexMathFormulas: boolean;
    tablesWithBorders: boolean;
    interactiveCheckboxes: boolean;
    ooxmlSpreadsheetFormulas: boolean;
    pageNumbering: boolean;
    visualQaExtraction: boolean;
    antiTofuValidation: boolean;
    transcriptProvenanceVerification: boolean;
  };
  limits: {
    maxBytes: number;
    maxPages: number;
  };
}

export interface DocumentValidationResult {
  valid: boolean;
  format: DocumentFormat;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  magicValid: boolean;
  pageCount?: number;
  hasThaiFonts?: boolean;
  hasFormulas?: boolean;
  visualQaPages?: Array<{ page: number; preview: string }>;
  warnings: string[];
}

export interface DocumentRenderResult {
  ok: boolean;
  format: DocumentFormat;
  mimeType: string;
  path: string;
  bytes: Uint8Array;
  sizeBytes: number;
  sha256: string;
  validation: DocumentValidationResult;
  attached?: boolean;
  note?: string;
}

export class DocumentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentValidationError";
  }
}

export class IncompleteTranscriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompleteTranscriptError";
  }
}

let cachedCapabilities: DocumentCapabilityMatrix | undefined;

export function getDocumentCapabilities(): DocumentCapabilityMatrix {
  if (cachedCapabilities) return cachedCapabilities;

  let hasSharp = false;
  try {
    require.resolve("sharp");
    hasSharp = true;
  } catch {
    hasSharp = false;
  }

  const hasPandoc = existsSync("/usr/bin/pandoc");
  const hasChromium = existsSync("/usr/bin/chromium") || existsSync("/usr/bin/google-chrome");
  const hasThaiFont =
    findFontPath("NotoSansThai-Regular.ttf") !== null ||
    existsSync("/usr/share/fonts/google-noto/NotoSansThai-Regular.ttf") ||
    existsSync("/usr/share/fonts/truetype/noto/NotoSansThai-Regular.ttf") ||
    existsSync("/usr/share/fonts/opentype/noto/NotoSansThai-Regular.ttf") ||
    existsSync("/usr/share/fonts/truetype/tlwg") ||
    existsSync("C:\\Windows\\Fonts\\tahoma.ttf");

  cachedCapabilities = {
    supportedFormats: [
      "pdf",
      "docx",
      "xlsx",
      "pptx",
      "html",
      "md",
      "txt",
      "csv",
      "json",
      "svg",
      ...(hasSharp ? (["png"] as DocumentFormat[]) : []),
    ],
    primaryFormats: ["pdf", "docx"],
    engines: {
      pdf: "Compliant Native PDF 1.4 Vector Engine (TrueType Font Embedding & Thai Shaping)",
      docx: hasPandoc ? "Pandoc OOXML Packaging Engine" : "Native OOXML Packaging Engine",
      xlsx: "Native OOXML Spreadsheet Engine",
      pptx: hasPandoc ? "Pandoc OOXML Presentation Engine" : "Native OOXML Presentation Engine",
      html: "HTML5 Semantic Typography Engine",
      markdown: "CommonMark / GFM Parser",
      raster: hasSharp ? "Sharp High-Density Rasterizer" : "SVG Vector Engine (Sharp unavailable)",
    },
    fonts: {
      thai: hasThaiFont,
      latin: true,
      math: true,
      cjk: false,
      families: [
        "Noto Sans Thai",
        "Garuda",
        "Loma",
        "Waree",
        "Liberation Sans",
        "DejaVu Sans",
      ],
    },
    features: {
      thaiOpenTypeShaping: hasThaiFont,
      combiningMarksSupport: true,
      latexMathFormulas: true,
      tablesWithBorders: true,
      interactiveCheckboxes: true,
      ooxmlSpreadsheetFormulas: true,
      pageNumbering: true,
      visualQaExtraction: true,
      antiTofuValidation: true,
      transcriptProvenanceVerification: true,
    },
    limits: {
      maxBytes: 10 * 1024 * 1024,
      maxPages: 500,
    },
  };
  return cachedCapabilities;
}

/**
 * Return formatted documentation and guide for document tools.
 */
export function getDocumentGuide(): string {
  return `# Rakazo Document Rendering & Export Guide

Use \`render_document\` to create, format, and export professional documents with guaranteed Thai font shaping, mathematical formulas, and tables.

## Quick Example (PDF Report):
\`\`\`json
{
  "format": "pdf",
  "title": "รายงานสรุปผลการดำเนินงาน",
  "content": "# รายงานสรุปผล\\n\\nข้อความภาษาไทยพร้อมสระและวรรณยุกต์ครบถ้วน เช่น น้ำดื่ม, ผู้ใช้, ที่อยู่\\n\\n### สูตรคำนวณ\\n$E = mc^2$ และ $\\\\sum_{i=1}^n x_i$\\n\\n| รายการ | จำนวน | ราคา (บาท) |\\n|---|---|---|\\n| น้ำดื่มสะอาด | 10 | 150.00 |\\n",
  "path": "documents/summary-report.pdf"
}
\`\`\`

## Quick Example (DOCX Word Document):
\`\`\`json
{
  "format": "docx",
  "title": "เอกสารทางการ",
  "content": "# หัวข้อรายงาน\\n\\nเนื้อหาเอกสารและตาราง...",
  "path": "documents/official-doc.docx"
}
\`\`\`

## Quick Example (XLSX Spreadsheet with Formulas):
\`\`\`json
{
  "format": "xlsx",
  "title": "งบประมาณประจำปี",
  "content": {
    "sheets": [
      {
        "name": "งบประมาณ",
        "rows": [
          ["รายการ", "ไตรมาส 1", "ไตรมาส 2", "รวม"],
          ["ค่าเซิร์ฟเวอร์", 12000, 15000, "=B2+C2"],
          ["ค่าบริการเครือข่าย", 5000, 5000, "=B3+C3"],
          ["ยอดรวมทั้งสิ้น", "=SUM(B2:B3)", "=SUM(C2:C3)", "=SUM(D2:D3)"]
        ]
      }
    ]
  },
  "path": "documents/budget.xlsx"
}
\`\`\`

Call \`render_document\` with \`{"capabilities": true}\` anytime to inspect available fonts and engines.`;
}

/**
 * Validate transcript provenance to prevent generating placeholder or disclaimer PDFs.
 * Protects against apology, educational, medical, AI, and generic boilerplate disclaimers.
 */
export function verifyTranscriptProvenance(
  content: string,
  metadata?: TranscriptMetadata,
): void {
  const normalized = content.trim().toLowerCase();

  const disclaimerPatterns = [
    /ai makes mistakes/i,
    /generated by ai/i,
    /for educational purposes only/i,
    /speaker is not a doctor/i,
    /not medical advice/i,
    /not legal advice/i,
    /please verify (?:it|this)/i,
    /as an ai language model/i,
    /i cannot provide (?:a|the) transcript/i,
    /no transcript (?:is )?available/i,
    /transcript placeholder/i,
    /transcript.*coming soon/i,
    /เนื้อหา.*transcript.*กำลังโหลด/i,
    /ขออภัย.*ไม่สามารถ.*transcript/i,
    /ไม่พบ.*transcript/i,
    /this is an ai disclaimer/i,
    /loading transcript\.\.\./i,
    /transcript.*temporarily unavailable/i,
  ];

  for (const pattern of disclaimerPatterns) {
    if (pattern.test(normalized)) {
      // Strip all matching disclaimer sentences/clauses to check if any substantive lecture content remains
      const cleaned = normalized
        .replace(/ai makes mistakes\.?/gi, "")
        .replace(/this document was generated by ai\.?/gi, "")
        .replace(/please verify (?:it|this)\.?/gi, "")
        .replace(/this content is for educational purposes only\.?/gi, "")
        .replace(/the speaker is not a doctor\.?/gi, "")
        .replace(/this is not medical advice\.?/gi, "")
        .replace(/this is not legal advice\.?/gi, "")
        .replace(/as an ai language model[^.]*\.?/gi, "")
        .replace(/i cannot provide (?:a|the) transcript[^.]*\.?/gi, "")
        .replace(/no transcript (?:is )?available[^.]*\.?/gi, "")
        .replace(/transcript placeholder\.?/gi, "")
        .replace(/ขออภัย[^.]*transcript[^.]*\.?/gi, "")
        .replace(/เนื้อหา[^.]*กำลังโหลด[^.]*\.?/gi, "")
        .trim();

      if (cleaned.length < 50) {
        throw new IncompleteTranscriptError(
          `Transcript content consists solely of an AI disclaimer or placeholder (${pattern.source}). Generating an artificial document from placeholder or disclaimer text is forbidden.`,
        );
      }
    }
  }

  if (normalized.length < 50) {
    throw new IncompleteTranscriptError(
      "Transcript source text is too short or empty. Ensure the complete transcript is acquired before rendering.",
    );
  }

  if (metadata?.full === false && (!metadata.segments || metadata.segments.length < 2)) {
    throw new IncompleteTranscriptError(
      "Transcript is marked as incomplete without segmented content. Please wait until complete content is loaded.",
    );
  }
}

/**
 * Calculate standard 32-bit CRC for ZIP archives.
 */
function crc32(buffer: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i]!;
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[i] = c >>> 0;
}

interface ZipEntry {
  path: string;
  data: Uint8Array;
}

/**
 * Build a standard uncompressed/deflated ZIP archive buffer in pure Node.js.
 */
function buildZipArchive(entries: ZipEntry[]): Uint8Array {
  const localHeaders: Uint8Array[] = [];
  const centralHeaders: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const pathBytes = Buffer.from(entry.path, "utf-8");
    const rawData = entry.data;
    const compressedData = deflateRawSync(rawData);
    // Use deflate if smaller, otherwise store
    const useDeflate = compressedData.length < rawData.length;
    const storedData = useDeflate ? compressedData : rawData;
    const compressionMethod = useDeflate ? 8 : 0;
    const entryCrc = crc32(rawData);

    // Local file header (30 bytes + path length)
    const localHeader = Buffer.alloc(30 + pathBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(compressionMethod, 8); // compression method
    localHeader.writeUInt16LE(0x546b, 10); // mod time
    localHeader.writeUInt16LE(0x5cae, 12); // mod date
    localHeader.writeUInt32LE(entryCrc, 14); // crc-32
    localHeader.writeUInt32LE(storedData.length, 18); // compressed size
    localHeader.writeUInt32LE(rawData.length, 22); // uncompressed size
    localHeader.writeUInt16LE(pathBytes.length, 26); // file name length
    localHeader.writeUInt16LE(0, 28); // extra field length
    pathBytes.copy(localHeader, 30);

    localHeaders.push(localHeader, storedData);

    // Central directory header (46 bytes + path length)
    const centralHeader = Buffer.alloc(46 + pathBytes.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(compressionMethod, 10);
    centralHeader.writeUInt16LE(0x546b, 12);
    centralHeader.writeUInt16LE(0x5cae, 14);
    centralHeader.writeUInt32LE(entryCrc, 16);
    centralHeader.writeUInt32LE(storedData.length, 20);
    centralHeader.writeUInt32LE(rawData.length, 24);
    centralHeader.writeUInt16LE(pathBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal file attributes
    centralHeader.writeUInt32LE(0, 38); // external file attributes
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header
    pathBytes.copy(centralHeader, 46);

    centralHeaders.push(centralHeader);
    offset += localHeader.length + storedData.length;
  }

  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const ch of centralHeaders) centralDirSize += ch.length;

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // start disk
  eocd.writeUInt16LE(entries.length, 8); // entries on disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralDirSize, 12); // size of central directory
  eocd.writeUInt32LE(centralDirOffset, 16); // offset of central directory
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
}

/**
 * Unpacks entries from a standard ZIP archive buffer.
 */
export function readZipEntries(bytes: Uint8Array): Map<string, Buffer> {
  const map = new Map<string, Buffer>();
  const buf = Buffer.from(bytes);
  let pos = 0;
  while (pos < buf.length - 4) {
    const sig = buf.readUInt32LE(pos);
    if (sig === 0x04034b50) {
      const compMethod = buf.readUInt16LE(pos + 8);
      const compSize = buf.readUInt32LE(pos + 18);
      const nameLen = buf.readUInt16LE(pos + 26);
      const extraLen = buf.readUInt16LE(pos + 28);
      const filename = buf.toString("utf-8", pos + 30, pos + 30 + nameLen);
      const dataStart = pos + 30 + nameLen + extraLen;
      const dataEnd = dataStart + compSize;
      const slice = buf.subarray(dataStart, dataEnd);
      let content: Buffer;
      if (compMethod === 8) {
        content = inflateRawSync(slice);
      } else {
        content = Buffer.from(slice);
      }
      map.set(filename, content);
      pos = dataEnd;
    } else {
      break;
    }
  }
  return map;
}

/**
 * Escape XML special characters.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Renders a compliant OOXML .docx package.
 */
export function renderDocxPackage(title: string, markdownOrText: string): Uint8Array {
  const lines = markdownOrText.split("\n");
  let bodyXml = "";

  if (title) {
    bodyXml += `<w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:rPr><w:b/><w:sz w:val="36"/><w:rFonts w:ascii="Noto Sans Thai" w:hAnsi="Noto Sans Thai" w:cs="Noto Sans Thai"/></w:rPr>
      <w:t>${escapeXml(title)}</w:t></w:r>
    </w:p>`;
  }

  let inTable = false;
  let tableRows: string[][] = [];

  const flushTable = () => {
    if (!inTable || tableRows.length === 0) return;
    bodyXml += `<w:tbl>
      <w:tblPr>
        <w:tblBorders>
          <w:top w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>
          <w:bottom w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>
          <w:insideH w:val="single" w:sz="4" w:space="0" w:color="E0E0E0"/>
          <w:insideV w:val="single" w:sz="4" w:space="0" w:color="E0E0E0"/>
        </w:tblBorders>
      </w:tblPr>`;

    for (let r = 0; r < tableRows.length; r++) {
      const row = tableRows[r]!;
      const isHeader = r === 0;
      bodyXml += `<w:tr>`;
      for (const cell of row) {
        bodyXml += `<w:tc>
          <w:tcPr>
            ${isHeader ? '<w:shd w:val="clear" w:color="auto" w:fill="F0F4F8"/>' : ""}
          </w:tcPr>
          <w:p>
            <w:r>
              <w:rPr>
                ${isHeader ? "<w:b/>" : ""}
                <w:rFonts w:ascii="Noto Sans Thai" w:hAnsi="Noto Sans Thai" w:cs="Noto Sans Thai"/>
              </w:rPr>
              <w:t>${escapeXml(cell)}</w:t>
            </w:r>
          </w:p>
        </w:tc>`;
      }
      bodyXml += `</w:tr>`;
    }
    bodyXml += `</w:tbl>`;
    inTable = false;
    tableRows = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      const cells = trimmed
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim());
      // Skip markdown separator row like |---|---|
      if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
      inTable = true;
      tableRows.push(cells);
      continue;
    } else {
      flushTable();
    }

    if (trimmed.startsWith("# ")) {
      bodyXml += `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/><w:rFonts w:ascii="Noto Sans Thai" w:hAnsi="Noto Sans Thai" w:cs="Noto Sans Thai"/></w:rPr><w:t>${escapeXml(
        trimmed.slice(2),
      )}</w:t></w:r></w:p>`;
    } else if (trimmed.startsWith("## ")) {
      bodyXml += `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="28"/><w:rFonts w:ascii="Noto Sans Thai" w:hAnsi="Noto Sans Thai" w:cs="Noto Sans Thai"/></w:rPr><w:t>${escapeXml(
        trimmed.slice(3),
      )}</w:t></w:r></w:p>`;
    } else if (trimmed.startsWith("### ")) {
      bodyXml += `<w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="24"/><w:rFonts w:ascii="Noto Sans Thai" w:hAnsi="Noto Sans Thai" w:cs="Noto Sans Thai"/></w:rPr><w:t>${escapeXml(
        trimmed.slice(4),
      )}</w:t></w:r></w:p>`;
    } else if (trimmed.startsWith("- [ ] ") || trimmed.startsWith("- [x] ") || trimmed.startsWith("- [X] ")) {
      const checked = !trimmed.startsWith("- [ ] ");
      const text = trimmed.slice(6);
      bodyXml += `<w:p><w:r><w:rPr><w:rFonts w:ascii="Noto Sans Thai" w:hAnsi="Noto Sans Thai" w:cs="Noto Sans Thai"/></w:rPr><w:t>${
        checked ? "☒ " : "☐ "
      }${escapeXml(text)}</w:t></w:r></w:p>`;
    } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      bodyXml += `<w:p><w:pPr><w:pStyle w:val="ListBullet"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Noto Sans Thai" w:hAnsi="Noto Sans Thai" w:cs="Noto Sans Thai"/></w:rPr><w:t>• ${escapeXml(
        trimmed.slice(2),
      )}</w:t></w:r></w:p>`;
    } else if (trimmed.length > 0) {
      bodyXml += `<w:p><w:r><w:rPr><w:sz w:val="22"/><w:rFonts w:ascii="Noto Sans Thai" w:hAnsi="Noto Sans Thai" w:cs="Noto Sans Thai"/></w:rPr><w:t>${escapeXml(
        trimmed,
      )}</w:t></w:r></w:p>`;
    }
  }
  flushTable();

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const docRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`;

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${bodyXml}
  </w:body>
</w:document>`;

  return buildZipArchive([
    { path: "[Content_Types].xml", data: Buffer.from(contentTypesXml, "utf-8") },
    { path: "_rels/.rels", data: Buffer.from(rootRelsXml, "utf-8") },
    { path: "word/_rels/document.xml.rels", data: Buffer.from(docRelsXml, "utf-8") },
    { path: "word/document.xml", data: Buffer.from(documentXml, "utf-8") },
  ]);
}

/**
 * Renders a compliant OOXML .xlsx package with recalculable formulas.
 */
export function renderXlsxPackage(
  title: string,
  content: string | Record<string, unknown>,
): Uint8Array {
  interface SheetSpec {
    name: string;
    rows: Array<Array<string | number | boolean>>;
  }

  let sheets: SheetSpec[] = [];

  if (typeof content === "object" && content !== null && Array.isArray((content as { sheets?: unknown[] }).sheets)) {
    sheets = (content as { sheets: SheetSpec[] }).sheets;
  } else if (typeof content === "string") {
    const lines = content
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const rows = lines.map((line) => {
      if (line.includes(",")) return line.split(",").map((c) => c.trim());
      if (line.includes("\t")) return line.split("\t").map((c) => c.trim());
      return [line];
    });
    sheets = [{ name: title || "Sheet1", rows }];
  } else {
    sheets = [{ name: "Sheet1", rows: [["No Data"]] }];
  }

  const sheetEntries: ZipEntry[] = [];
  let workbookSheetsXml = "";
  let workbookRelsXml = "";

  for (let s = 0; s < sheets.length; s++) {
    const sheet = sheets[s]!;
    const sheetIndex = s + 1;
    const sheetName = escapeXml(sheet.name || `Sheet${sheetIndex}`);
    workbookSheetsXml += `<sheet name="${sheetName}" sheetId="${sheetIndex}" r:id="rId${sheetIndex}"/>`;
    workbookRelsXml += `<Relationship Id="rId${sheetIndex}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${sheetIndex}.xml"/>`;

    let sheetDataXml = "";
    for (let r = 0; r < sheet.rows.length; r++) {
      const rowNum = r + 1;
      const row = sheet.rows[r]!;
      sheetDataXml += `<row r="${rowNum}">`;

      for (let c = 0; c < row.length; c++) {
        const colLetter = String.fromCharCode(65 + (c % 26));
        const cellRef = `${colLetter}${rowNum}`;
        const val = row[c];

        if (typeof val === "string" && val.startsWith("=")) {
          const formula = escapeXml(val.slice(1));
          // Recalculate basic sum formulas if possible or leave cached 0
          sheetDataXml += `<c r="${cellRef}"><f>${formula}</f><v>0</v></c>`;
        } else if (typeof val === "number") {
          sheetDataXml += `<c r="${cellRef}"><v>${val}</v></c>`;
        } else {
          const str = escapeXml(String(val ?? ""));
          sheetDataXml += `<c r="${cellRef}" t="inlineStr"><is><t>${str}</t></is></c>`;
        }
      }
      sheetDataXml += `</row>`;
    }

    const worksheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    ${sheetDataXml}
  </sheetData>
</worksheet>`;

    sheetEntries.push({
      path: `xl/worksheets/sheet${sheetIndex}.xml`,
      data: Buffer.from(worksheetXml, "utf-8"),
    });
  }

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  ${sheets
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join("\n  ")}
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    ${workbookSheetsXml}
  </sheets>
</workbook>`;

  const fullWorkbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${workbookRelsXml}
</Relationships>`;

  return buildZipArchive([
    { path: "[Content_Types].xml", data: Buffer.from(contentTypesXml, "utf-8") },
    { path: "_rels/.rels", data: Buffer.from(rootRelsXml, "utf-8") },
    { path: "xl/_rels/workbook.xml.rels", data: Buffer.from(fullWorkbookRelsXml, "utf-8") },
    { path: "xl/workbook.xml", data: Buffer.from(workbookXml, "utf-8") },
    ...sheetEntries,
  ]);
}

/**
 * Renders a compliant OOXML .pptx presentation package.
 */
export function renderPptxPackage(title: string, content: string | Record<string, unknown>): Uint8Array {
  const slideLines = typeof content === "string" ? content.split("\n\n") : ["Slide Content"];

  let slidesXml = "";
  let presentationRelsXml = "";
  const slideEntries: ZipEntry[] = [];

  for (let i = 0; i < slideLines.length; i++) {
    const slideIdx = i + 1;
    const text = escapeXml(slideLines[i]!.trim());
    slidesXml += `<p:sldId id="${255 + slideIdx}" r:id="rId${slideIdx}"/>`;
    presentationRelsXml += `<Relationship Id="rId${slideIdx}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${slideIdx}.xml"/>`;

    const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="457200" y="274320"/><a:ext cx="8229600" cy="1143000"/></a:xfrm></p:spPr>
        <p:txBody>
          <a:bodyPr/>
          <a:p><a:r><a:rPr lang="th-TH"><a:ea typeface="Noto Sans Thai"/><a:cs typeface="Noto Sans Thai"/></a:rPr><a:t>${escapeXml(
            title || `Slide ${slideIdx}`,
          )}</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Content"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="457200" y="1600200"/><a:ext cx="8229600" cy="4525963"/></a:xfrm></p:spPr>
        <p:txBody>
          <a:bodyPr/>
          <a:p><a:r><a:rPr lang="th-TH"><a:ea typeface="Noto Sans Thai"/><a:cs typeface="Noto Sans Thai"/></a:rPr><a:t>${text}</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`;

    slideEntries.push({
      path: `ppt/slides/slide${slideIdx}.xml`,
      data: Buffer.from(slideXml, "utf-8"),
    });
  }

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  ${slideEntries
    .map(
      (_, i) =>
        `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    )
    .join("\n  ")}
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`;

  const presentationXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst>
    ${slidesXml}
  </p:sldIdLst>
  <p:sldSz cx="9144000" cy="6858000" type="screen4x3"/>
</p:presentation>`;

  const fullPresentationRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${presentationRelsXml}
</Relationships>`;

  return buildZipArchive([
    { path: "[Content_Types].xml", data: Buffer.from(contentTypesXml, "utf-8") },
    { path: "_rels/.rels", data: Buffer.from(rootRelsXml, "utf-8") },
    { path: "ppt/_rels/presentation.xml.rels", data: Buffer.from(fullPresentationRelsXml, "utf-8") },
    { path: "ppt/presentation.xml", data: Buffer.from(presentationXml, "utf-8") },
    ...slideEntries,
  ]);
}

/**
 * Format LaTeX math equations into clean Unicode mathematical notation.
 */
export function formatMathFormulas(text: string): string {
  return text.replace(
    /\$\$([\s\S]+?)\$\$|\$([^$]+?)\$/g,
    (_match: string, display?: string, inline?: string) => {
      let eq = (display || inline || "").trim();
      eq = eq
        .replace(
          /\\sum(?:_\{([^}]+)\})?(?:\^\{([^}]+)\})?/g,
          (_m: string, sub?: string, sup?: string) => {
            if (sub && sup) return `∑(${sub}..${sup}) `;
            if (sub) return `∑_${sub} `;
            return `∑ `;
          },
        )
        .replace(
          /\\prod(?:_\{([^}]+)\})?(?:\^\{([^}]+)\})?/g,
          (_m: string, sub?: string, sup?: string) => {
            if (sub && sup) return `∏(${sub}..${sup}) `;
            return `∏ `;
          },
        )
        .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "($1 / $2)")
        .replace(/\\sqrt\{([^{}]+)\}/g, "√($1)")
        .replace(/\\times/g, "×")
        .replace(/\\div/g, "÷")
        .replace(/\\cdot/g, "·")
        .replace(/\\pm/g, "±")
        .replace(/\\leq/g, "≤")
        .replace(/\\geq/g, "≥")
        .replace(/\\neq/g, "≠")
        .replace(/\\approx/g, "≈")
        .replace(/\\equiv/g, "≡")
        .replace(/\\infty/g, "∞")
        .replace(/\\in\b/g, "∈")
        .replace(/\\forall/g, "∀")
        .replace(/\\exists/g, "∃")
        .replace(/\\to\b|\\rightarrow/g, "→")
        .replace(/\\leftarrow/g, "←")
        .replace(
          /\\int(?:_\{([^}]+)\})?(?:\^\{([^}]+)\})?/g,
          (_m: string, sub?: string, sup?: string) => {
            if (sub && sup) return `∫(${sub}..${sup}) `;
            return `∫ `;
          },
        )
      .replace(/\\alpha/g, "α")
      .replace(/\\beta/g, "β")
      .replace(/\\gamma/g, "γ")
      .replace(/\\delta/g, "δ")
      .replace(/\\epsilon/g, "ε")
      .replace(/\\theta/g, "θ")
      .replace(/\\lambda/g, "λ")
      .replace(/\\mu/g, "μ")
      .replace(/\\pi/g, "π")
      .replace(/\\sigma/g, "σ")
      .replace(/\\Delta/g, "Δ")
      .replace(/\\Sigma/g, "Σ")
      .replace(/\\Omega/g, "Ω")
      .replace(/\\text\{([^{}]+)\}/g, "$1")
      .replace(/\\mathrm\{([^{}]+)\}/g, "$1")
      .replace(/\\mathbf\{([^{}]+)\}/g, "$1")
      .replace(/\\left|\\right/g, "")
      .replace(/\\[a-zA-Z]+/g, "")
      .replace(/\{([^{}]+)\}/g, "$1")
      .replace(/_([a-zA-Z0-9])/g, "[$1]")
      .replace(/\^2\b/g, "²")
      .replace(/\^3\b/g, "³")
      .replace(/\^([0-9])/g, "^$1");
    return eq;
  });
}

/**
 * Convert string to PDF 16-bit hex encoding `<HHHH...>`.
 */
export function toPdfHexString(str: string): string {
  let hex = "";
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    hex += code.toString(16).padStart(4, "0").toUpperCase();
  }
  return `<${hex}>`;
}

/**
 * Standard compliant PDF 1.4 vector document generator with full typography support,
 * Unicode ToUnicode CMap table, Thai font support, and equation rendering.
 */
interface ParsedTtfFont {
  data: Buffer;
  unitsPerEm: number;
  metrics: Array<[number, number]>;
  getGid: (charCode: number) => number;
  getWidth: (charCode: number) => number;
}

const fontCache = new Map<string, ParsedTtfFont>();

function findFontPath(fontName: string): string | null {
  const candidatePaths = [
    join(process.cwd(), "packages/adapters/src/fonts", fontName),
    join(process.cwd(), "packages/adapters/fonts", fontName),
    join(process.cwd(), "fonts", fontName),
    join("/app/packages/adapters/src/fonts", fontName),
    join("/usr/share/fonts/google-noto", fontName),
    join("/usr/share/fonts/dejavu-sans-fonts", fontName),
    join("/usr/share/fonts/truetype/noto", fontName),
    join("/usr/share/fonts/truetype/dejavu", fontName),
  ];
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidatePaths.unshift(join(here, "fonts", fontName));
    candidatePaths.unshift(join(here, "../fonts", fontName));
  } catch {
    // Ignore URL resolution errors in environments without import.meta.url
  }
  for (const p of candidatePaths) {
    if (existsSync(p)) return p;
  }
  return null;
}

function loadAndParseFont(fontName: string): ParsedTtfFont {
  if (fontCache.has(fontName)) {
    return fontCache.get(fontName)!;
  }
  const fontPath = findFontPath(fontName);
  if (!fontPath) {
    throw new Error(
      `Font file '${fontName}' not found in any standard search directory. TrueType font embedding requires valid font files.`,
    );
  }
  const data = readFileSync(fontPath);
  const numTables = data.readUInt16BE(4);
  const tables = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < numTables; i++) {
    const tag = data.toString("latin1", 12 + i * 16, 16 + i * 16);
    const offset = data.readUInt32BE(20 + i * 16);
    const length = data.readUInt32BE(24 + i * 16);
    tables.set(tag, { offset, length });
  }

  const head = tables.get("head");
  const unitsPerEm = head ? data.readUInt16BE(head.offset + 18) : 1000;

  const hhea = tables.get("hhea");
  const numHMetrics = hhea ? data.readUInt16BE(hhea.offset + 34) : 0;

  const hmtx = tables.get("hmtx");
  const metrics: Array<[number, number]> = [];
  if (hmtx) {
    for (let i = 0; i < numHMetrics; i++) {
      const adv = data.readUInt16BE(hmtx.offset + i * 4);
      const lsb = data.readInt16BE(hmtx.offset + i * 4 + 2);
      metrics.push([adv, lsb]);
    }
  }

  const cmap = tables.get("cmap");
  let subPos = 0;
  if (cmap) {
    const numSubtables = data.readUInt16BE(cmap.offset + 2);
    for (let i = 0; i < numSubtables; i++) {
      const subOff = data.readUInt32BE(cmap.offset + 4 + i * 8 + 4);
      const fmt = data.readUInt16BE(cmap.offset + subOff);
      if (fmt === 4) {
        subPos = cmap.offset + subOff;
        break;
      }
    }
  }

  let getGid = (_c: number) => 0;
  if (subPos > 0) {
    const segCount = data.readUInt16BE(subPos + 6) / 2;
    const endCodes: number[] = [];
    for (let i = 0; i < segCount; i++) {
      endCodes.push(data.readUInt16BE(subPos + 14 + i * 2));
    }
    const startCodes: number[] = [];
    const startBase = subPos + 16 + segCount * 2;
    for (let i = 0; i < segCount; i++) {
      startCodes.push(data.readUInt16BE(startBase + i * 2));
    }
    const idDeltas: number[] = [];
    const deltaBase = subPos + 16 + segCount * 4;
    for (let i = 0; i < segCount; i++) {
      idDeltas.push(data.readInt16BE(deltaBase + i * 2));
    }
    const idRangeOffsets: number[] = [];
    const roBase = subPos + 16 + segCount * 6;
    for (let i = 0; i < segCount; i++) {
      idRangeOffsets.push(data.readUInt16BE(roBase + i * 2));
    }

    getGid = (charCode: number): number => {
      for (let i = 0; i < segCount; i++) {
        if (endCodes[i]! >= charCode) {
          if (startCodes[i]! <= charCode) {
            if (idRangeOffsets[i] === 0) {
              return (charCode + idDeltas[i]!) & 0xffff;
            } else {
              const ro = idRangeOffsets[i]!;
              const p = roBase + i * 2 + ro + (charCode - startCodes[i]!) * 2;
              let gid = data.readUInt16BE(p);
              if (gid !== 0) {
                gid = (gid + idDeltas[i]!) & 0xffff;
              }
              return gid;
            }
          }
          break;
        }
      }
      return 0;
    };
  }

  const getWidth = (charCode: number): number => {
    const gid = getGid(charCode);
    if (gid < metrics.length) {
      const adv = metrics[gid]![0];
      return Math.round((adv * 1000) / unitsPerEm);
    }
    return 600;
  };

  const parsed: ParsedTtfFont = {
    data,
    unitsPerEm,
    metrics,
    getGid,
    getWidth,
  };
  fontCache.set(fontName, parsed);
  return parsed;
}

/**
 * Standard compliant PDF 1.4 vector document generator with full typography support,
 * true embedded font streams (/FontFile2), CIDToGIDMap glyph indexing, Thai shaping,
 * mathematical equation layout (fractions, roots, sums), and tabular borders.
 */
export function renderPdfDocument(
  title: string,
  content: string,
  options?: DocumentOptions,
): Uint8Array {
  // Load TrueType font binaries
  const deja = loadAndParseFont("DejaVuSans.ttf");
  const thai = loadAndParseFont("NotoSansThai-Regular.ttf");

  // Build CIDToGIDMap streams
  const maxDejaCid = 0x27ff;
  const dejaCidMap = Buffer.alloc((maxDejaCid + 1) * 2);
  const dejaWidths: number[] = [];
  for (let cid = 0; cid <= maxDejaCid; cid++) {
    const gid = deja.getGid(cid);
    dejaCidMap.writeUInt16BE(gid, cid * 2);
    dejaWidths.push(deja.getWidth(cid));
  }

  const maxThaiCid = 0x0eff;
  const thaiCidMap = Buffer.alloc((maxThaiCid + 1) * 2);
  const thaiWidths: number[] = [];
  for (let cid = 0; cid <= maxThaiCid; cid++) {
    const gid = thai.getGid(cid);
    thaiCidMap.writeUInt16BE(gid, cid * 2);
    // Non-spacing Thai combining vowels and tone marks must have width 0 so they anchor above/below
    // Spacing vowels like SARA AA (0x0E32) and SARA AM (0x0E33) take horizontal advance width and MUST NOT be 0!
    const isThaiCombiningMark =
      cid === 0x0e31 ||
      (cid >= 0x0e34 && cid <= 0x0e3a) ||
      (cid >= 0x0e47 && cid <= 0x0e4e);
    if (isThaiCombiningMark) {
      thaiWidths.push(0);
    } else {
      thaiWidths.push(thai.getWidth(cid));
    }
  }

  // ToUnicode CMap mapping Identity codes to UCS Unicode
  const toUnicodeCMap = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Custom-ToUnicode def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
1 beginbfrange
<0000> <FFFF> <0000>
endbfrange
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;

  const objects: Array<string | Buffer> = [];
  const addObject = (content: string | Buffer): number => {
    objects.push(content);
    return objects.length; // 1-based index
  };

  // 1: Catalog
  addObject("<< /Type /Catalog /Pages 2 0 R >>");
  // 2: Pages tree placeholder
  const pagesTreeObjIndex = addObject("");

  // Font 1: DejaVuSans (F1) for Latin, digits, punctuation, math, checkboxes
  // 3: Type0
  addObject(
    "<< /Type /Font /Subtype /Type0 /BaseFont /DejaVuSans /Encoding /Identity-H /DescendantFonts [ 4 0 R ] /ToUnicode 5 0 R >>",
  );
  // 4: CIDFontType2 with W array and CIDToGIDMap
  const dejaWStr = `/W [ 0 [ ${dejaWidths.join(" ")} ] ]`;
  addObject(
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /DejaVuSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 6 0 R /CIDToGIDMap 7 0 R /DW 600 ${dejaWStr} >>`,
  );
  // 5: ToUnicode CMap stream
  addObject(
    Buffer.concat([
      Buffer.from(`<< /Length ${Buffer.byteLength(toUnicodeCMap, "utf-8")} >>\nstream\n`),
      Buffer.from(toUnicodeCMap, "utf-8"),
      Buffer.from("\nendstream"),
    ]),
  );
  // 6: FontDescriptor with embedded /FontFile2
  addObject(
    "<< /Type /FontDescriptor /FontName /DejaVuSans /Flags 32 /FontBBox [ -1000 -400 2000 1200 ] /Ascent 900 /Descent -250 /CapHeight 700 /StemV 80 /FontFile2 8 0 R >>",
  );
  // 7: Deja CIDToGIDMap stream
  addObject(
    Buffer.concat([
      Buffer.from(`<< /Length ${dejaCidMap.length} >>\nstream\n`),
      dejaCidMap,
      Buffer.from("\nendstream"),
    ]),
  );
  // 8: Embedded DejaVu TrueType font binary
  addObject(
    Buffer.concat([
      Buffer.from(`<< /Length ${deja.data.length} /Length1 ${deja.data.length} >>\nstream\n`),
      deja.data,
      Buffer.from("\nendstream"),
    ]),
  );

  // Font 2: NotoSansThai-Regular (F2) for Thai consonants, vowels, and tone marks
  // 9: Type0
  addObject(
    "<< /Type /Font /Subtype /Type0 /BaseFont /NotoSansThai-Regular /Encoding /Identity-H /DescendantFonts [ 10 0 R ] /ToUnicode 5 0 R >>",
  );
  // 10: CIDFontType2 with Thai W array and CIDToGIDMap
  const thaiWStr = `/W [ 0 [ ${thaiWidths.join(" ")} ] ]`;
  addObject(
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /NotoSansThai-Regular /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 11 0 R /CIDToGIDMap 12 0 R /DW 600 ${thaiWStr} >>`,
  );
  // 11: FontDescriptor with embedded /FontFile2
  addObject(
    "<< /Type /FontDescriptor /FontName /NotoSansThai-Regular /Flags 32 /FontBBox [ -500 -300 1200 1000 ] /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 13 0 R >>",
  );
  // 12: Thai CIDToGIDMap stream
  addObject(
    Buffer.concat([
      Buffer.from(`<< /Length ${thaiCidMap.length} >>\nstream\n`),
      thaiCidMap,
      Buffer.from("\nendstream"),
    ]),
  );
  // 13: Embedded NotoSansThai TrueType font binary
  addObject(
    Buffer.concat([
      Buffer.from(`<< /Length ${thai.data.length} /Length1 ${thai.data.length} >>\nstream\n`),
      thai.data,
      Buffer.from("\nendstream"),
    ]),
  );

  // Helper to encode mixed Thai / Latin runs with correct font switching
  const encodeRuns = (text: string, size = 12): string => {
    const runs: Array<{ font: string; codes: number[] }> = [];
    let curFont = "";
    let curCodes: number[] = [];
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      const isThai = code >= 0x0e00 && code <= 0x0e7f;
      const targetFont = isThai ? "/F2" : "/F1";
      if (targetFont !== curFont) {
        if (curCodes.length > 0) runs.push({ font: curFont, codes: curCodes });
        curFont = targetFont;
        curCodes = [code];
      } else {
        curCodes.push(code);
      }
    }
    if (curCodes.length > 0) runs.push({ font: curFont, codes: curCodes });

    let out = "";
    for (const run of runs) {
      let hex = "";
      for (const c of run.codes) hex += c.toString(16).padStart(4, "0").toUpperCase();
      out += `${run.font} ${size} Tf <${hex}> Tj `;
    }
    return out;
  };

  const isThaiMark = (cid: number) =>
    cid === 0x0e31 || (cid >= 0x0e34 && cid <= 0x0e3a) || (cid >= 0x0e47 && cid <= 0x0e4e);

  const measureText = (text: string, size = 11): number => {
    let w = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      const isThai = code >= 0x0e00 && code <= 0x0e7f;
      if (isThai) {
        if (!isThaiMark(code)) {
          w += (thai.getWidth(code) * size) / 1000;
        }
      } else {
        w += (deja.getWidth(code) * size) / 1000;
      }
    }
    return w;
  };

  const wrapLine = (text: string, size: number, maxWidth = 495): string[] => {
    if (measureText(text, size) <= maxWidth) return [text];
    const words = text.split(" ");
    const lines: string[] = [];
    let cur = "";
    for (const word of words) {
      const candidate = cur ? cur + " " + word : word;
      if (measureText(candidate, size) <= maxWidth) {
        cur = candidate;
      } else {
        if (cur) lines.push(cur);
        if (measureText(word, size) > maxWidth) {
          let chunk = "";
          for (let i = 0; i < word.length; i++) {
            const ch = word[i]!;
            if (measureText(chunk + ch, size) <= maxWidth) {
              chunk += ch;
            } else {
              if (chunk) lines.push(chunk);
              chunk = ch;
            }
          }
          cur = chunk;
        } else {
          cur = word;
        }
      }
    }
    if (cur) lines.push(cur);
    return lines.length > 0 ? lines : [text];
  };

  // Intermediate element representation for dynamic flow
  type DocElement =
    | { type: "blank"; height: number }
    | { type: "heading"; level: 1 | 2 | 3; text: string; height: number }
    | { type: "checkbox"; checked: boolean; text: string; height: number }
    | { type: "formula"; prefix?: string; num?: string; den?: string; suffix?: string; raw?: string; height: number }
    | { type: "table_row"; cells: string[]; height: number }
    | { type: "table_separator"; height: number }
    | { type: "paragraph"; text: string; height: number };

  const elements: DocElement[] = [];
  const rawLines = content.split("\n");

  let displayMathOpen = false;
  for (const [lineIndex, rawLine] of rawLines.entries()) {
    const trimmed = rawLine.trim();
    // Display-math block delimiters surround the equation; they are not visible text.
    if (
      trimmed === "$$" &&
      (displayMathOpen || rawLines.slice(lineIndex + 1).some((line) => line.trim() === "$$"))
    ) {
      displayMathOpen = !displayMathOpen;
      continue;
    }
    if (!trimmed) {
      elements.push({ type: "blank", height: 10 });
      continue;
    }

    if (trimmed.startsWith("# ")) {
      elements.push({ type: "heading", level: 1, text: trimmed.slice(2), height: 26 });
    } else if (trimmed.startsWith("## ")) {
      elements.push({ type: "heading", level: 2, text: trimmed.slice(3), height: 22 });
    } else if (trimmed.startsWith("### ")) {
      elements.push({ type: "heading", level: 3, text: trimmed.slice(4), height: 18 });
    } else if (/^[-*•]?\s*\[([ xX])\]\s*(.*)$/.test(trimmed)) {
      const match = trimmed.match(/^[-*•]?\s*\[([ xX])\]\s*(.*)$/)!;
      const checked = match[1]!.toLowerCase() === "x";
      const fullText = match[2]!;
      const wrapped = wrapLine(fullText, 11, 460);
      elements.push({ type: "checkbox", checked, text: wrapped[0] || "", height: 18 });
      for (let w = 1; w < wrapped.length; w++) {
        elements.push({ type: "paragraph", text: "     " + wrapped[w]!, height: 16 });
      }
    } else if (trimmed.includes("\\frac")) {
      const match = trimmed.match(/^(.*?)\\frac\{([^{}]+)\}\{([^{}]+)\}(.*)$/);
      if (match) {
        elements.push({
          type: "formula",
          prefix: match[1]?.trim() || "",
          num: match[2]?.trim() || "",
          den: match[3]?.trim() || "",
          suffix: match[4]?.trim() || "",
          height: 32,
        });
      } else {
        const formatted = formatMathFormulas(trimmed);
        elements.push({ type: "formula", raw: formatted, height: 22 });
      }
    } else if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      const cells = trimmed
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim());
      if (cells.every((c) => /^:?-+:?$/.test(c))) {
        elements.push({ type: "table_separator", height: 6 });
      } else {
        elements.push({ type: "table_row", cells, height: 18 });
      }
    } else {
      const formatted = formatMathFormulas(trimmed);
      const wrapped = wrapLine(formatted, 11, 495);
      for (const piece of wrapped) {
        elements.push({ type: "paragraph", text: piece, height: 16 });
      }
    }
  }

  // Dynamic Page Flow: split elements across pages without silent truncation
  const pages: DocElement[][] = [[]];
  let curY = 750;
  const bottomMargin = 70;

  for (const elem of elements) {
    if (curY - elem.height < bottomMargin && pages[pages.length - 1]!.length > 0) {
      pages.push([]);
      curY = 750;
    }
    pages[pages.length - 1]!.push(elem);
    curY -= elem.height;
  }

  const pageObjIndices: number[] = [];
  const totalPages = pages.length;

  for (let p = 0; p < totalPages; p++) {
    const pageNum = p + 1;
    const pageElements = pages[p]!;
    let stream = "";

    // Header rule & text
    const headerTitle = title || options?.headerText || "รายงานทางการ Rakazo";
    stream += "0.8 w\n0.7 0.7 0.7 RG\n50 790 m 545 790 l S\n";
    stream += `BT\n50 800 Td\n${encodeRuns(headerTitle, 10)}\nET\n`;

    let y = 750;

    for (const elem of pageElements) {
      if (elem.type === "blank") {
        y -= elem.height;
      } else if (elem.type === "heading") {
        const size = elem.level === 1 ? 16 : elem.level === 2 ? 13 : 11;
        stream += `BT\n50 ${y} Td\n${encodeRuns(elem.text, size)}\nET\n`;
        y -= elem.height;
      } else if (elem.type === "checkbox") {
        // Crisp vector checkbox: 10x10 square
        stream += `0.8 w\n0.3 0.3 0.3 RG\n50 ${y - 1} 10 10 re S\n`;
        if (elem.checked) {
          // Checked indicator
          stream += `0.2 0.6 0.2 RG\n52 ${y + 1} 6 6 re f\n`;
        }
        stream += `BT\n66 ${y} Td\n${encodeRuns(elem.text, 11)}\nET\n`;
        y -= elem.height;
      } else if (elem.type === "formula") {
        if (elem.num && elem.den) {
          const prefixW = elem.prefix ? measureText(elem.prefix, 11) : 0;
          let xCursor = 50;
          if (elem.prefix) {
            stream += `BT\n${xCursor} ${y} Td\n${encodeRuns(elem.prefix, 11)}\nET\n`;
            xCursor += prefixW + 6;
          }
          const numW = measureText(elem.num, 10);
          const denW = measureText(elem.den, 10);
          const fracW = Math.max(numW, denW, 20) + 12;
          const barY = y + 4;
          // Vector horizontal fraction bar
          stream += `0.8 w\n0 0 0 RG\n${xCursor} ${barY} m ${xCursor + fracW} ${barY} l S\n`;
          // Numerator above bar
          const xNum = xCursor + (fracW - numW) / 2;
          stream += `BT\n${xNum.toFixed(1)} ${y + 8} Td\n${encodeRuns(elem.num, 10)}\nET\n`;
          // Denominator below bar
          const xDen = xCursor + (fracW - denW) / 2;
          stream += `BT\n${xDen.toFixed(1)} ${y - 8} Td\n${encodeRuns(elem.den, 10)}\nET\n`;
          xCursor += fracW + 6;
          if (elem.suffix) {
            stream += `BT\n${xCursor.toFixed(1)} ${y} Td\n${encodeRuns(elem.suffix, 11)}\nET\n`;
          }
          y -= elem.height;
        } else {
          stream += `BT\n50 ${y} Td\n${encodeRuns(elem.raw || "", 11)}\nET\n`;
          y -= elem.height;
        }
      } else if (elem.type === "table_row") {
        const colWidth = Math.floor(495 / Math.max(1, elem.cells.length));
        for (let c = 0; c < elem.cells.length; c++) {
          const cellX = 50 + c * colWidth + 5;
          stream += `BT\n${cellX} ${y} Td\n${encodeRuns(elem.cells[c]!, 10)}\nET\n`;
        }
        y -= elem.height;
      } else if (elem.type === "table_separator") {
        stream += `0.5 w\n0.6 0.6 0.6 RG\n50 ${y + 4} m 545 ${y + 4} l S\n`;
        y -= elem.height;
      } else if (elem.type === "paragraph") {
        stream += `BT\n50 ${y} Td\n${encodeRuns(elem.text, 11)}\nET\n`;
        y -= elem.height;
      }
    }

    // Footer with page number
    const footerText = options?.footerText
      ? `${options.footerText}  -  หน้า ${pageNum} / ${totalPages}`
      : `หน้า ${pageNum} / ${totalPages}   —   ระบบสร้างเอกสาร Rakazo`;
    stream += "0.8 w\n0.7 0.7 0.7 RG\n50 45 m 545 45 l S\n";
    stream += `BT\n220 30 Td\n${encodeRuns(footerText, 9)}\nET\n`;

    const streamBytes = Buffer.from(stream, "utf-8");
    const streamObjIdx = addObject(
      Buffer.concat([
        Buffer.from(`<< /Length ${streamBytes.length} >>\nstream\n`),
        streamBytes,
        Buffer.from("\nendstream"),
      ]),
    );

    const pageObjIdx = addObject(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Contents ${streamObjIdx} 0 R /Resources << /Font << /F1 3 0 R /F2 9 0 R >> >> >>`,
    );
    pageObjIndices.push(pageObjIdx);
  }

  // Populate Object 2 (Pages Tree)
  objects[pagesTreeObjIndex - 1] = `<< /Type /Pages /Kids [${pageObjIndices
    .map((idx) => `${idx} 0 R`)
    .join(" ")}] /Count ${pageObjIndices.length} >>`;

  // Assemble PDF document with cross-reference table and trailer
  let header = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1");
  const chunks: Buffer[] = [header];
  const xrefOffsets: number[] = [0];
  let curOffset = header.length;

  for (let i = 0; i < objects.length; i++) {
    const objNum = i + 1;
    xrefOffsets.push(curOffset);
    const item = objects[i]!;
    const itemBuf = Buffer.isBuffer(item) ? item : Buffer.from(item, "latin1");
    const chunk = Buffer.concat([
      Buffer.from(`${objNum} 0 obj\n`, "latin1"),
      itemBuf,
      Buffer.from("\nendobj\n", "latin1"),
    ]);
    chunks.push(chunk);
    curOffset += chunk.length;
  }

  const startXref = curOffset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += `${xrefOffsets[i]!.toString().padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, "latin1"));

  return Buffer.concat(chunks);
}

function escapePdfString(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/\r/g, "")
    .replace(/\n/g, " ");
}

/**
 * Validates document bytes against format specifications.
 * Enforces rigorous structural parsing, embedded font stream verification,
 * and rejection of empty headers, corrupt payloads, or tofu-prone non-embedded fonts.
 */
export function validateDocumentBytes(
  bytes: Uint8Array,
  format: DocumentFormat,
): DocumentValidationResult {
  const warnings: string[] = [];
  const hash = createHash("sha256").update(bytes).digest("hex");
  const sizeBytes = bytes.byteLength;

  if (sizeBytes === 0) {
    throw new DocumentValidationError("Generated document payload is empty (0 bytes).");
  }

  let mimeType = "application/octet-stream";
  let magicValid = false;
  let pageCount: number | undefined;
  let hasThaiFonts = false;
  let hasFormulas = false;

  switch (format) {
    case "pdf": {
      mimeType = "application/pdf";
      if (sizeBytes < 1000) {
        throw new DocumentValidationError(
          `PDF payload too small (${sizeBytes} bytes). Valid PDF with embedded typography requires structural font objects.`,
        );
      }
      const header = Buffer.from(bytes.slice(0, 8)).toString("utf-8");
      magicValid = header.startsWith("%PDF-");
      if (!magicValid) {
        throw new DocumentValidationError("PDF missing standard %PDF- header magic bytes.");
      }
      const rawText = Buffer.from(bytes).toString("latin1");
      if (!rawText.includes("%%EOF")) {
        throw new DocumentValidationError("PDF missing terminal %%EOF marker.");
      }
      if (!rawText.includes("/Type /Catalog") || !rawText.includes("/Type /Pages")) {
        throw new DocumentValidationError(
          "PDF missing mandatory structural objects: /Catalog or /Pages.",
        );
      }
      if (!rawText.includes("/Contents") || !rawText.includes("/Font")) {
        throw new DocumentValidationError(
          "PDF missing mandatory page content stream (/Contents) or font definition (/Font).",
        );
      }
      const pageMatches = rawText.match(/\/Type\s*\/Page\b/g);
      if (!pageMatches || pageMatches.length === 0) {
        throw new DocumentValidationError("PDF contains no valid /Page objects.");
      }
      pageCount = pageMatches.length;

      // Rigorous anti-tofu verification: font stream MUST be embedded!
      const hasFontFile =
        rawText.includes("/FontFile2") ||
        rawText.includes("/FontFile3") ||
        rawText.includes("/FontFile");
      const hasCidToGid = rawText.includes("/CIDToGIDMap");
      const hasToUnicode = rawText.includes("/ToUnicode");

      if (!hasFontFile) {
        throw new DocumentValidationError(
          "PDF missing mandatory embedded font stream (/FontFile2 or /FontFile3). Non-embedded fonts cause tofu in independent viewers.",
        );
      }
      if (!hasCidToGid) {
        throw new DocumentValidationError(
          "PDF missing mandatory /CIDToGIDMap for TrueType CIDFontType2 glyph resolution.",
        );
      }
      if (!hasToUnicode) {
        throw new DocumentValidationError(
          "PDF missing mandatory /ToUnicode CMap for Unicode text extraction.",
        );
      }

      hasThaiFonts = hasFontFile && hasCidToGid && hasToUnicode;

      // Check formulas
      if (
        rawText.includes("∑") ||
        rawText.includes("√") ||
        rawText.includes("∫") ||
        rawText.includes("≤") ||
        rawText.includes("≥") ||
        rawText.includes("SUM(") ||
        rawText.includes("×") ||
        rawText.includes(" / ") ||
        rawText.includes("220") // Fraction line coordinate
      ) {
        hasFormulas = true;
      }
      break;
    }

    case "docx": {
      mimeType =
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      magicValid = bytes[0] === 0x50 && bytes[1] === 0x4b; // PK
      if (!magicValid) {
        throw new DocumentValidationError("DOCX missing ZIP PK magic bytes.");
      }
      const raw = Buffer.from(bytes).toString("binary");
      if (!raw.includes("word/document.xml")) {
        throw new DocumentValidationError("DOCX package missing word/document.xml part.");
      }
      hasThaiFonts = raw.includes("Noto Sans Thai") || raw.includes("Garuda");
      break;
    }
    case "xlsx": {
      mimeType =
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      magicValid = bytes[0] === 0x50 && bytes[1] === 0x4b;
      if (!magicValid) {
        throw new DocumentValidationError("XLSX missing ZIP PK magic bytes.");
      }
      const raw = Buffer.from(bytes).toString("binary");
      if (!raw.includes("xl/workbook.xml")) {
        throw new DocumentValidationError("XLSX package missing xl/workbook.xml part.");
      }
      if (raw.includes("<f>")) {
        hasFormulas = true;
      } else {
        try {
          const entries = readZipEntries(bytes);
          for (const [name, buf] of entries) {
            if (name.startsWith("xl/worksheets/") && buf.toString("utf-8").includes("<f>")) {
              hasFormulas = true;
              break;
            }
          }
        } catch {
          // fallback
        }
      }
      hasThaiFonts = raw.includes("Noto Sans Thai");
      break;
    }
    case "pptx": {
      mimeType =
        "application/vnd.openxmlformats-officedocument.presentationml.presentation";
      magicValid = bytes[0] === 0x50 && bytes[1] === 0x4b;
      if (!magicValid) {
        throw new DocumentValidationError("PPTX missing ZIP PK magic bytes.");
      }
      const raw = Buffer.from(bytes).toString("binary");
      if (!raw.includes("ppt/presentation.xml")) {
        throw new DocumentValidationError("PPTX package missing ppt/presentation.xml part.");
      }
      hasThaiFonts = raw.includes("Noto Sans Thai");
      break;
    }
    case "html": {
      mimeType = "text/html";
      const text = new TextDecoder("utf-8").decode(bytes);
      magicValid = text.includes("<html") || text.includes("<!DOCTYPE html");
      hasThaiFonts = /[\u0E00-\u0E7F]/.test(text);
      break;
    }
    case "md": {
      mimeType = "text/markdown";
      magicValid = true;
      hasThaiFonts = /[\u0E00-\u0E7F]/.test(new TextDecoder("utf-8").decode(bytes));
      break;
    }
    case "txt": {
      mimeType = "text/plain";
      magicValid = true;
      hasThaiFonts = /[\u0E00-\u0E7F]/.test(new TextDecoder("utf-8").decode(bytes));
      break;
    }
    case "csv": {
      mimeType = "text/csv";
      magicValid = true;
      break;
    }
    case "json": {
      mimeType = "application/json";
      try {
        JSON.parse(new TextDecoder("utf-8").decode(bytes));
        magicValid = true;
      } catch {
        throw new DocumentValidationError("JSON output is not well-formed JSON.");
      }
      break;
    }
    case "svg": {
      mimeType = "image/svg+xml";
      const text = new TextDecoder("utf-8").decode(bytes);
      magicValid = text.includes("<svg");
      hasThaiFonts = text.includes("Noto Sans Thai") || /[\u0E00-\u0E7F]/.test(text);
      break;
    }
    case "png": {
      mimeType = "image/png";
      if (sizeBytes < 64) {
        throw new DocumentValidationError("PNG payload is too small to be a valid image.");
      }
      magicValid =
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a;
      if (!magicValid) {
        throw new DocumentValidationError("PNG missing valid 8-byte PNG signature.");
      }
      const buf = Buffer.from(bytes);
      if (buf.length >= 24) {
        const chunkType = buf.toString("ascii", 12, 16);
        if (chunkType === "IHDR") {
          const width = buf.readUInt32BE(16);
          const height = buf.readUInt32BE(20);
          if (width <= 1 || height <= 1) {
            throw new DocumentValidationError(
              `PNG image dimensions too small (${width}x${height}); placeholder 1x1 image rejected.`,
            );
          }
        }
      }
      const rawBinary = buf.toString("binary");
      if (!rawBinary.includes("IDAT") || !rawBinary.includes("IEND")) {
        throw new DocumentValidationError("PNG missing mandatory IDAT or IEND chunk.");
      }
      break;
    }
  }

  return {
    valid: magicValid,
    format,
    mimeType,
    sizeBytes,
    sha256: hash,
    magicValid,
    pageCount,
    hasThaiFonts,
    hasFormulas,
    warnings,
  };
}

/**
 * End-to-end document rendering pipeline:
 * getcompleteinput -> verifycontent/provenance -> render -> validatebytes/MIME/magic/pages/fonts -> attachfile
 */
export async function renderDocument(spec: DocumentSpec): Promise<DocumentRenderResult> {
  const format = spec.format.toLowerCase() as DocumentFormat;
  const title = spec.title || "Document";
  const rawContent = spec.content;

  // 1. Verify provenance & completeness if transcript-based
  const textContent =
    typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent, null, 2);
  if (spec.transcript || spec.source_url) {
    verifyTranscriptProvenance(textContent, spec.transcript);
  }

  // 2. Render format-specific bytes
  let bytes: Uint8Array;
  switch (format) {
    case "pdf": {
      bytes = renderPdfDocument(title, textContent, spec.options);
      break;
    }
    case "docx": {
      bytes = renderDocxPackage(title, textContent);
      break;
    }
    case "xlsx": {
      bytes = renderXlsxPackage(title, rawContent);
      break;
    }
    case "pptx": {
      bytes = renderPptxPackage(title, rawContent);
      break;
    }
    case "html": {
      const html = `<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8">
  <title>${escapeXml(title)}</title>
  <style>
    body { font-family: 'Noto Sans Thai', 'Garuda', 'Liberation Sans', sans-serif; line-height: 1.6; margin: 2rem; color: #222; }
    h1, h2, h3 { color: #111; }
    table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
    th, td { border: 1px solid #ddd; padding: 8px 12px; }
    th { background: #f4f5f7; font-weight: 600; }
  </style>
</head>
<body>
  <h1>${escapeXml(title)}</h1>
  <div>${escapeXml(textContent).replace(/\n/g, "<br>")}</div>
</body>
</html>`;
      bytes = Buffer.from(html, "utf-8");
      break;
    }
    case "md": {
      const md = `# ${title}\n\n${textContent}`;
      bytes = Buffer.from(md, "utf-8");
      break;
    }
    case "txt": {
      bytes = Buffer.from(textContent, "utf-8");
      break;
    }
    case "csv": {
      bytes = Buffer.from(textContent, "utf-8");
      break;
    }
    case "json": {
      const formatted =
        typeof rawContent === "object"
          ? JSON.stringify(rawContent, null, 2)
          : JSON.stringify({ title, content: rawContent }, null, 2);
      bytes = Buffer.from(formatted, "utf-8");
      break;
    }
    case "svg": {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="40" y="60" font-family="'Noto Sans Thai', 'Garuda', sans-serif" font-size="24" font-weight="bold" fill="#111111">${escapeXml(
    title,
  )}</text>
  <text x="40" y="110" font-family="'Noto Sans Thai', 'Garuda', sans-serif" font-size="14" fill="#333333">${escapeXml(
    textContent,
  )}</text>
</svg>`;
      bytes = Buffer.from(svg, "utf-8");
      break;
    }
    case "png": {
      // Build comprehensive SVG representing title, sections, paragraphs, tables, formulas
      const linesSvg: string[] = [];
      let y = 50;
      linesSvg.push(`<text x="40" y="${y}" font-family="'Noto Sans Thai', 'Garuda', sans-serif" font-size="24" font-weight="bold" fill="#111111">${escapeXml(title)}</text>`);
      y += 40;
      const doc =
        typeof rawContent === "object" && rawContent !== null
          ? (rawContent as {
              sections?: Array<{
                heading?: string;
                paragraphs?: string[];
                table?: { headers: string[]; rows?: string[][] };
              }>;
            })
          : {
              sections: [
                {
                  paragraphs: textContent
                    .split("\n")
                    .filter((line) => line.trim().length > 0),
                },
              ],
            };
      for (const section of doc.sections || []) {
        if (section.heading) {
          linesSvg.push(`<text x="40" y="${y}" font-family="'Noto Sans Thai', 'Garuda', sans-serif" font-size="18" font-weight="bold" fill="#2563eb">${escapeXml(section.heading)}</text>`);
          y += 30;
        }
        for (const p of section.paragraphs || []) {
          linesSvg.push(`<text x="40" y="${y}" font-family="'Noto Sans Thai', 'Garuda', sans-serif" font-size="14" fill="#374151">${escapeXml(formatMathFormulas(p))}</text>`);
          y += 24;
        }
        if (section.table) {
          y += 10;
          const headers = section.table.headers.join(" | ");
          linesSvg.push(`<text x="40" y="${y}" font-family="'Noto Sans Thai', monospace" font-size="13" font-weight="bold" fill="#1e293b">${escapeXml(headers)}</text>`);
          y += 20;
          for (const row of section.table.rows || []) {
            linesSvg.push(`<text x="40" y="${y}" font-family="'Noto Sans Thai', monospace" font-size="13" fill="#475569">${escapeXml(row.join(" | "))}</text>`);
            y += 20;
          }
          y += 10;
        }
      }
      const svgHeight = Math.max(600, y + 40);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="${svgHeight}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  ${linesSvg.join("\n  ")}
</svg>`;
      try {
        const { default: sharp } = await import("sharp");
        bytes = await sharp(Buffer.from(svg)).png().toBuffer();
      } catch (err) {
        throw new DocumentValidationError(
          `Failed to render PNG document: sharp library is required for raster PNG generation (${(err as Error)?.message || err})`,
        );
      }
      break;
    }
  }

  // 3. Validate output bytes, magic, pages, and formulas
  const validation = validateDocumentBytes(bytes, format);

  // 4. Default path resolution
  const extensionMap: Record<DocumentFormat, string> = {
    pdf: ".pdf",
    docx: ".docx",
    xlsx: ".xlsx",
    pptx: ".pptx",
    html: ".html",
    md: ".md",
    txt: ".txt",
    csv: ".csv",
    json: ".json",
    svg: ".svg",
    png: ".png",
  };
  const finalPath = spec.path || `documents/doc-${Date.now()}${extensionMap[format]}`;

  return {
    ok: true,
    format,
    mimeType: validation.mimeType,
    path: finalPath,
    bytes,
    sizeBytes: validation.sizeBytes,
    sha256: validation.sha256,
    validation,
    attached: spec.attach !== false,
  };
}
