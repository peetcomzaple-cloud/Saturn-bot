export type ConversationLocale = "th" | "en" | "auto";

const THAI_CHAR_REGEX = /[\u0E00-\u0E7F]/;

/**
 * Detects an explicit user instruction in the current turn to switch or set
 * the response language to English ("en") or Thai ("th").
 *
 * Care is taken not to trigger "en" when the user merely mentions reading an
 * English document or English source text (e.g. "อ่านเอกสารภาษาอังกฤษแล้วสรุปเป็นภาษาไทย").
 */
export function detectExplicitLanguageOverride(text: string): "th" | "en" | undefined {
  if (!text) return undefined;
  const cleaned = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .trim();
  if (!cleaned) return undefined;

  const explicitThaiPatterns: RegExp[] = [
    /\b(?:please\s+)?(?:reply|respond|answer|write|explain|summarize|speak)\s+(?:to\s+me\s+)?in\s+thai\b/i,
    /\b(?:in\s+thai\s+(?:only|please)|thai\s+language\s+only|switch\s+(?:language\s+|back\s+)?to\s+thai|use\s+thai\s+language)\b/i,
    /(?:ช่วย|กรุณา|ขอให้|ให้)?\s*(?:ตอบ|อธิบาย|สรุป|เขียน|พูด|รายงาน|สื่อสาร|กลับมาตอบ|เปลี่ยน(?:ภาษา)?(?:กลับ)?(?:มา)?(?:เป็น)?)\s*(?:กลับ)?(?:มา)?(?:เป็น)?\s*ภาษาไทย(?:เท่านั้น|เหมือนเดิม|ด้วย|นะ|ครับ|ค่ะ)?/i,
    /ตอบ(?:เป็น)?ไทย(?:เท่านั้น|เหมือนเดิม|ด้วย|นะ|ครับ|ค่ะ)?/i,
  ];

  const explicitEnglishPatterns: RegExp[] = [
    /\b(?:please\s+)?(?:reply|respond|answer|write|explain|summarize|speak)\s+(?:to\s+me\s+)?in\s+english\b/i,
    /\b(?:in\s+english\s+(?:only|please)|english\s+only|switch\s+(?:language\s+|back\s+)?to\s+english|use\s+english(?:\s+language)?(?:\s+only)?)\b/i,
    /(?:ช่วย|กรุณา|ขอให้|ให้)?\s*(?:ตอบ|อธิบาย|สรุป|เขียน|พูด|รายงาน|สื่อสาร|เปลี่ยน(?:ภาษา)?(?:เป็น)?)\s*(?:กลับ)?(?:มา)?(?:เป็น)?\s*ภาษาอังกฤษ(?:เท่านั้น|ด้วย|นะ|ครับ|ค่ะ)?/i,
    /(?:ตอบ|สรุป|อธิบาย|เขียน)เป็นอังกฤษ(?:เท่านั้น|ด้วย|นะ|ครับ|ค่ะ)?/i,
    /ภาษาอังกฤษเท่านั้น/i,
  ];

  // Check if both appear (e.g. "อ่านไฟล์ภาษาอังกฤษแล้วตอบเป็นภาษาไทย" or "ไม่ต้องตอบเป็นภาษาไทย ให้ตอบเป็นภาษาอังกฤษ")
  let lastThaiIdx = -1;
  for (const pat of explicitThaiPatterns) {
    const match = pat.exec(cleaned);
    if (match && match.index > lastThaiIdx) {
      // Ignore negated Thai like "ไม่ต้องตอบเป็นภาษาไทย" / "ห้ามตอบเป็นภาษาไทย" / "do not reply in Thai"
      const prefix = cleaned.slice(Math.max(0, match.index - 24), match.index);
      if (!/(?:ไม่ต้อง|ห้าม|อย่า|ไม่ต้อง|not|don't|do\s+not)\s*$/i.test(prefix.trim())) {
        lastThaiIdx = match.index;
      }
    }
  }

  let lastEnIdx = -1;
  for (const pat of explicitEnglishPatterns) {
    const match = pat.exec(cleaned);
    if (match && match.index > lastEnIdx) {
      const prefix = cleaned.slice(Math.max(0, match.index - 24), match.index);
      if (!/(?:ไม่ต้อง|ห้าม|อย่า|แม้ต้นทางจะเป็น|แม้เอกสารจะเป็น|not|don't|do\s+not)\s*$/i.test(prefix.trim())) {
        lastEnIdx = match.index;
      }
    }
  }

  if (lastEnIdx >= 0 && lastEnIdx > lastThaiIdx) return "en";
  if (lastThaiIdx >= 0 && lastThaiIdx > lastEnIdx) return "th";
  return undefined;
}

const SYSTEM_PLACEHOLDER_PROMPTS = new Set([
  "respond to the user's steering context.",
  "continue the original task from the latest tool result.",
]);

/**
 * Returns true if the turn consists only of language-neutral tokens such as:
 * - email addresses (`user@domain.com`) or partial handles (`user @ company`),
 * - URLs (`https://...`),
 * - filenames / file paths (`report-v2.pdf`, `qa-real-20261013-a/brief.md`),
 * - short continuation / confirmation tokens (`ok`, `next`, `yes`, `v2`, `1`, `2`),
 * - or system continuation placeholders (`Respond to the user's steering context.`).
 */
export function isLanguageNeutralTurn(text: string): boolean {
  if (!text) return true;
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (SYSTEM_PLACEHOLDER_PROMPTS.has(trimmed.toLowerCase())) return true;
  if (THAI_CHAR_REGEX.test(trimmed)) return false;
  if (detectExplicitLanguageOverride(trimmed) !== undefined) return false;

  // Strip fenced/inline code, URLs, emails, partial email handles, file paths, versions, numbers, punctuation
  const stripped = trimmed
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/https?:\/\/[^\s"'<>]+/gi, " ")
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, " ")
    .replace(/[a-zA-Z0-9._%+-]+\s*@\s*[a-zA-Z0-9._-]+/g, " ")
    .replace(/(?:\/|[a-zA-Z]:\\)[^\s"'<>]+/g, " ")
    .replace(/\b[\w.-]+\.(?:md|txt|csv|tsv|json|jsonl|yaml|yml|pdf|docx|xlsx|pptx|py|ts|tsx|js|mjs|cjs|sh|sql|html|css|png|jpg|jpeg|webp|zip|log)\b/gi, " ")
    .replace(/\b(?:v\d+(?:\.\d+)*|q[1-4]|ns\d+|year\d+|step\s*\d+|#\d+)\b/gi, " ")
    .replace(/[^a-zA-Z]+/g, " ")
    .trim();

  if (!stripped) return true;

  const tokens = stripped.toLowerCase().split(/\s+/).filter(Boolean);
  const neutralShortTokens = new Set([
    "ok",
    "okay",
    "k",
    "yes",
    "yep",
    "no",
    "next",
    "continue",
    "done",
    "go",
    "proceed",
    "resume",
    "retry",
    "stop",
    "cancel",
    "skip",
    "confirm",
    "approve",
    "approved",
    "use",
    "instead",
    "file",
    "url",
    "email",
    "login",
  ]);
  if (tokens.length <= 3 && tokens.every((t) => neutralShortTokens.has(t) || t.length <= 2)) {
    return true;
  }
  return false;
}

/**
 * Resolves the active conversation locale across multi-turn threads.
 *
 * Priority order:
 * 1. Explicit language override in the current turn (`detectExplicitLanguageOverride(prompt)`).
 * 2. Current turn Thai script (`[\u0E00-\u0E7F]`).
 * 3. Prior user turns in the thread (`recentUserTexts`, ordered newest-to-oldest):
 *    - If an earlier turn had an explicit override ("en" or "th"), honor it unless a newer turn overrode it.
 *    - If an earlier turn was conducted in Thai, persist `"th"` across email-only, URL-only,
 *      filename/code-only, short continuation, and takeover resume turns.
 * 4. Bot instructions containing Thai script.
 */
export function resolveConversationLocale(
  prompt: string,
  recentUserTexts: readonly string[] = [],
  instructions = "",
): ConversationLocale {
  // Strip injected system notes (e.g. [Language Requirement: ...], [Current Time: ...]) when inspecting user prompt
  const userOnlyPrompt = (prompt ?? "")
    .replace(/\[(?:Language Requirement|Form Fill[^\]]*|Login Form[^\]]*|Web Browser[^\]]*|Current Time[^\]]*):[\s\S]*?\]/gi, " ")
    .trim();

  const currentOverride = detectExplicitLanguageOverride(userOnlyPrompt);
  if (currentOverride) return currentOverride;

  if (THAI_CHAR_REGEX.test(userOnlyPrompt)) return "th";

  for (const rawTurn of recentUserTexts) {
    if (!rawTurn) continue;
    const turn = rawTurn.trim();
    if (!turn) continue;
    const override = detectExplicitLanguageOverride(turn);
    if (override) return override;
    if (THAI_CHAR_REGEX.test(turn)) return "th";
  }

  if (instructions && THAI_CHAR_REGEX.test(instructions)) {
    // Only treat instructions as Thai when they are not our own injected language instruction
    const withoutInjected = instructions.replace(/ผู้ใช้สื่อสารเป็นภาษาไทย:[^\n]*/g, "");
    if (THAI_CHAR_REGEX.test(withoutInjected)) return "th";
  }

  return "auto";
}

export function isThaiConversation(
  prompt: string,
  recentUserTexts: readonly string[] = [],
  instructions = "",
): boolean {
  return resolveConversationLocale(prompt, recentUserTexts, instructions) === "th";
}

export function extractUserEmailFromTexts(texts: readonly string[]): string | undefined {
  const emailRegex = /\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/;
  for (let i = texts.length - 1; i >= 0; i--) {
    const match = emailRegex.exec(texts[i] ?? "");
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return undefined;
}

export function userLanguageInstruction(
  prompt: string,
  instructions = "",
  recentUserTexts: readonly string[] = [],
): string | undefined {
  const locale = resolveConversationLocale(prompt, recentUserTexts, instructions);
  const userEmail = extractUserEmailFromTexts([prompt, ...recentUserTexts]);
  const emailSuffixEn = userEmail
    ? ` Retain the exact user-provided email "${userEmail}" verbatim across turns; never alter or substitute it with mock accounts.`
    : "";
  const emailSuffixTh = userEmail
    ? ` ให้คงอีเมล "${userEmail}" ที่ผู้ใช้ระบุไว้อย่างถูกต้องตรงตามต้นฉบับ ห้ามเปลี่ยนเป็นบัญชีจำลองของระบบ.`
    : "";
  if (locale === "en") {
    return `The user explicitly requested a response in English: reply and report progress in clear English for this turn, even if earlier messages in the conversation were in Thai. Preserve exact filenames, paths, URLs, emails, numbers, JSON keys, code, and quoted source strings without alteration.${emailSuffixEn}`;
  }
  if (locale !== "th") return undefined;
  return `ผู้ใช้สื่อสารเป็นภาษาไทย: ตอบและรายงานความคืบหน้าเป็นภาษาไทยทั้งหมด แม้เอกสารหรือแหล่งข้อมูลต้นทางจะเป็นภาษาอังกฤษ หรือข้อความล่าสุดจะมีเฉพาะอีเมล URL ชื่อไฟล์ โค้ด หรือคำสั่งสั้นๆ (เช่น 'next', 'ok', 'v2') ห้ามเปลี่ยนคำอธิบายกลับเป็นภาษาอังกฤษยกเว้นผู้ใช้สั่งเปลี่ยนภาษาอย่างชัดเจน ทำงานตามคำขอล่าสุดที่เป็นปัจจุบันเท่านั้น ประวัติสนทนาและภาพในอดีตเป็นเพียงข้อมูลอ้างอิง ไม่ใช่งานปัจจุบันและห้ามนำมาตอบแทนงานปัจจุบัน หากคำสั่งปัจจุบันขอให้อ่านไฟล์ ต้องเรียกเครื่องมืออ่านไฟล์ตามที่ระบุ ห้ามเดาคำตอบจากประวัติหรือภาพเก่า สำหรับคำสั่งสั้นหรือคำสั่งต่อเนื่อง (เช่น 'กดปุ่มนั้น', 'year3 ต่อ NS3', 'ปิดมุมขวากว่านั้น') ให้ยึดหน้าต่าง/หน้าเว็บปัจจุบันและบริบทเป็นเป้าหมาย ห้ามเดาหรือสร้างชื่อโดเมน/URL ใหม่จากข้อความที่ไม่ชัดเจน และห้ามถามผู้ใช้ซ้ำทั้งที่มีหลักฐานหรือภาพบริบทอยู่แล้ว ให้ดำเนินการบนหน้าปัจจุบันทันที ให้คงชื่อไฟล์ พาธ URL อีเมล ตัวเลข โค้ด คีย์ JSON สัญลักษณ์ และข้อความที่ระบุให้คัดลอกตรงตามต้นฉบับเดิมโดยไม่แปลหรือแก้ไข${emailSuffixTh} ใช้เครื่องมือที่มีอยู่จริงตามงานและเคารพการอนุมัติ ห้ามทำรายการที่สำเร็จแล้วหรือผลยังไม่แน่นอนซ้ำ และห้ามบอกว่างานสำเร็จโดยไม่มีหลักฐาน`;
}

/**
 * Safe, bounded repair of English explanation phrases, leaked reasoning blocks,
 * and raw stack traces in Thai-requested turns.
 * Only touches natural language explanation text; preserves code fences, inline code snippets,
 * JSON blocks, quoted source values, URLs, emails, numbers, artifacts, and secrets.
 */
export function repairThaiExplanation(
  text: string,
  isThaiPrompt: boolean,
  userSuppliedEmail?: string,
): string {
  if (!isThaiPrompt || !text) return text;

  // 1. If the whole text is valid JSON, do NOT modify it
  try {
    JSON.parse(text);
    return text;
  } catch {}

  // 2. Identify protected spans (fenced code blocks, code expressions, valid JSON blocks)
  const protectedSpans: Array<{ start: number; end: number }> = [];

  // Fenced code blocks ```...```
  const fenceRegex = /```[\s\S]*?```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRegex.exec(text)) !== null) {
    protectedSpans.push({ start: m.index, end: m.index + m[0].length });
  }

  // Inline code snippets that contain code statements/tokens (e.g. `const ...`, `;`, `=`)
  const codeInlineRegex = /`[^`\n]*(?:[=;{}()]|const|let|var|function|return)[^`\n]*`/g;
  while ((m = codeInlineRegex.exec(text)) !== null) {
    if (!protectedSpans.some((s) => m!.index >= s.start && m!.index < s.end)) {
      protectedSpans.push({ start: m.index, end: m.index + m[0].length });
    }
  }

  // Find JSON objects {...} that parse cleanly and protect them
  const openBraceIndices: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") openBraceIndices.push(i);
  }
  for (const start of openBraceIndices) {
    if (protectedSpans.some((s) => start >= s.start && start < s.end)) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = start; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
      } else if (c === "{") {
        depth++;
      } else if (c === "}") {
        depth--;
        if (depth === 0) {
          const sub = text.slice(start, j + 1);
          try {
            JSON.parse(sub);
            protectedSpans.push({ start, end: j + 1 });
          } catch {}
          break;
        }
      }
    }
  }

  // Find JSON arrays [...] that parse cleanly and protect them
  const openBracketIndices: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "[") openBracketIndices.push(i);
  }
  for (const start of openBracketIndices) {
    if (protectedSpans.some((s) => start >= s.start && start < s.end)) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = start; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
      } else if (c === "[") {
        depth++;
      } else if (c === "]") {
        depth--;
        if (depth === 0) {
          const sub = text.slice(start, j + 1);
          try {
            JSON.parse(sub);
            protectedSpans.push({ start, end: j + 1 });
          } catch {}
          break;
        }
      }
    }
  }

  protectedSpans.sort((a, b) => a.start - b.start);

  // Replacements for leaked reasoning tags, raw stack traces, and common English boilerplate
  const replacements: [RegExp, string][] = [
    // Strip leaked <think>...</think> or <thinking>...</thinking> blocks outside code fences
    [/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/gi, ""],
    [
      /^(?:Thought|Thinking Process|Internal Reasoning)\s*:\s*[^\n]+\r?\n+/gim,
      "",
    ],
    // Strip raw multi-line V8/Node/Python stack frames leaked outside code blocks
    [/(?:\r?\n[ \t]+at [^\r\n]+){2,}/g, ""],
    [
      /Traceback \(most recent call last\):\r?\n(?:[ \t]+File [^\r\n]+\r?\n(?:[ \t]+[^\r\n]+\r?\n)?)+/g,
      "",
    ],
    // Handoff / Takeover prefixes
    [
      /\[Ready for Input\]\s*Reached login form at (\S+)\.(?:\s+|$)/gi,
      "[พร้อมกรอกข้อมูล] เปิดหน้าเข้าสู่ระบบที่ $1 เรียบร้อยแล้ว ",
    ],
    [
      /\[Blocker \/ HTTP Error\]\s*Reached error page \(([^)]+)\) at (\S+)\.(?:\s+|$)/gi,
      "[พบข้อผิดพลาด HTTP] หน้าเว็บแสดงข้อผิดพลาด ($1) ที่ $2 ",
    ],
    [
      /\[Blocker \/ Incomplete Navigation\]\s*Login form not reached on current page \(([^)]+)\)\.(?:\s+|$)/gi,
      "[ยังไม่ถึงฟอร์มเข้าสู่ระบบ] ยังไม่พบช่องกรอกเข้าสู่ระบบบนหน้าปัจจุบัน ($1) ",
    ],
    [
      /\[Blocker \/ Security Challenge\]\s*/gi,
      "[พบการตรวจสอบความปลอดภัย] ",
    ],
    [
      /Here are the files in the `?([^`\n]+)`? directory:/gi,
      "พบไฟล์ต่อไปนี้ในโฟลเดอร์ `$1`:",
    ],
    [
      /Here are the files in `?([^`\n]+)`?:/gi,
      "พบไฟล์ต่อไปนี้ใน `$1`:",
    ],
    [
      /Here are the files found in `?([^`\n]+)`?:/gi,
      "พบไฟล์ต่อไปนี้ใน `$1`:",
    ],
    [
      /The following files were found in the `?([^`\n]+)`? directory:/gi,
      "พบไฟล์ต่อไปนี้ในโฟลเดอร์ `$1`:",
    ],
    [
      /The following files were found in `?([^`\n]+)`?:/gi,
      "พบไฟล์ต่อไปนี้ใน `$1`:",
    ],
    [
      /The files in the `?([^`\n]+)`? directory are:/gi,
      "ไฟล์ในโฟลเดอร์ `$1` มีดังนี้:",
    ],
    [
      /The files in `?([^`\n]+)`? are:/gi,
      "ไฟล์ใน `$1` มีดังนี้:",
    ],
    [
      /Here is the list of files in the `?([^`\n]+)`? directory:/gi,
      "รายการไฟล์ในโฟลเดอร์ `$1` มีดังนี้:",
    ],
    [
      /Here is the list of files in `?([^`\n]+)`?:/gi,
      "รายการไฟล์ใน `$1` มีดังนี้:",
    ],
    [
      /Below are the files in `?([^`\n]+)`?:/gi,
      "รายการไฟล์ใน `$1` มีดังนี้:",
    ],
    [
      /I have found the following files in the `?([^`\n]+)`? directory:/gi,
      "พบไฟล์ต่อไปนี้ในโฟลเดอร์ `$1`:",
    ],
    [
      /I have found the following files in `?([^`\n]+)`?:/gi,
      "พบไฟล์ต่อไปนี้ใน `$1`:",
    ],
    [
      /I will now read the specified files to gather the information needed to make the decisions\./gi,
      "กำลังอ่านไฟล์ที่ระบุเพื่อรวบรวมข้อมูลประกอบการตัดสินใจ",
    ],
    [
      /I will now read the specified files[^.\n]*\./gi,
      "กำลังอ่านไฟล์ที่ระบุ",
    ],
    [
      /I have read all the specified files\./gi,
      "ได้อ่านไฟล์ที่ระบุทั้งหมดเรียบร้อยแล้ว",
    ],
    [
      /I have read the file `?([^`\n]+)`?\./gi,
      "ได้อ่านไฟล์ `$1` เรียบร้อยแล้ว",
    ],
    [
      /I have read the `?([^`\n]+)`? file\./gi,
      "ได้อ่านไฟล์ `$1` เรียบร้อยแล้ว",
    ],
    [
      /Here are the decisions based on `?([^`\n]+)`?/gi,
      "ผลการตัดสินตาม `$1`",
    ],
    [
      /Based on the content and the current date\/time(\s*\([^)]*\))?\s*:/gi,
      "จากเนื้อหาและวันเวลาปัจจุบัน$1:",
    ],
    [
      /Based on the content(\s*\([^)]*\))?\s*:/gi,
      "จากเนื้อหา$1:",
    ],
    [
      /Here is the JSON output:/gi,
      "ผลลัพธ์ JSON มีดังนี้:",
    ],
    [
      /Here is the extracted dispatch information:/gi,
      "ข้อมูล dispatch ที่ดึงมามีดังนี้:",
    ],
    [
      /Here is the extracted information:/gi,
      "ข้อมูลที่ดึงมามีดังนี้:",
    ],
    [
      /Here is the summary:/gi,
      "สรุปผลได้ดังนี้:",
    ],
    [
      /No files found\./gi,
      "ไม่พบไฟล์",
    ],
    [
      /All tasks completed successfully\./gi,
      "ดำเนินการทุกขั้นตอนเรียบร้อยแล้ว",
    ],
  ];

  function applyReplacements(segment: string): string {
    let res = segment;
    for (const [pattern, replacement] of replacements) {
      res = res.replace(pattern, replacement);
    }
    return res;
  }

  if (protectedSpans.length === 0) {
    return applyReplacements(text);
  }

  let result = "";
  let cursor = 0;
  for (const span of protectedSpans) {
    if (span.start > cursor) {
      result += applyReplacements(text.slice(cursor, span.start));
    }
    result += text.slice(span.start, span.end);
    cursor = span.end;
  }
  if (cursor < text.length) {
    result += applyReplacements(text.slice(cursor));
  }

  if (userSuppliedEmail && /@argon-fixture\.local/i.test(result) && !result.includes(userSuppliedEmail)) {
    result = result.replace(/[a-zA-Z0-9._%+-]+@argon-fixture\.local/gi, userSuppliedEmail);
  }

  return result;
}

export function formatThaiToolActivity(activityText: string): string {
  if (!activityText) return activityText;
  const text = activityText.trim();
  // Exact matches first
  if (text === "Reading the page") return "กำลังอ่านข้อมูลหน้าเว็บ";
  if (text === "Using the page") return "กำลังทำงานบนหน้าเว็บ";
  if (text === "Operating the computer") return "กำลังสั่งการบนหน้าจอ";
  if (text === "Looking at the screen") return "กำลังตรวจดูหน้าจอ";
  if (text === "Rendering a chart") return "กำลังสร้างแผนภูมิ";
  if (text === "Rendering a document") return "กำลังสร้างเอกสาร";
  if (text === "Saving a note to memory") return "กำลังบันทึกความจำ";
  if (text === "Waiting for your answer") return "รอคำตอบเพิ่มเติมจากคุณ";
  if (text === "Sending progress update") return "กำลังส่งความคืบหน้า";
  if (text === "Clearing site data") return "กำลังล้างข้อมูลเว็บไซต์";
  if (text === "Searching conversation history") return "กำลังค้นหาประวัติสนทนา";
  if (text === "Reading conversation history") return "กำลังอ่านประวัติสนทนา";

  // Specific prefix matches
  if (text.startsWith("Opening page: ")) {
    const target = text.slice(14);
    if (/gmail|mail\.google/i.test(target)) return "กำลังเปิดอีเมล";
    return `กำลังเปิดหน้าเว็บ: ${target}`;
  }
  if (text.startsWith("Provider unavailable. Switched to backup model ")) {
    const modelId = text.slice("Provider unavailable. Switched to backup model ".length).replace(/\.$/, "");
    return `ระบบสลับไปใช้โมเดลสำรอง ${modelId} อัตโนมัติ`;
  }
  if (text.startsWith("Running: ")) return `กำลังรันคำสั่ง: ${text.slice(9)}`;
  if (text.startsWith("Reading page: ")) return `กำลังอ่านหน้าเว็บ: ${text.slice(14)}`;
  if (text.startsWith("Reading skill: ")) return `กำลังอ่านทักษะ: ${text.slice(15)}`;
  if (text.startsWith("Creating skill: ")) return `กำลังสร้างทักษะ: ${text.slice(16)}`;
  if (text.startsWith("Updating skill: ")) return `กำลังอัปเดตทักษะ: ${text.slice(16)}`;
  if (text.startsWith("Deleting skill: ")) return `กำลังลบทักษะ: ${text.slice(16)}`;
  if (text.startsWith("Reading ")) return `กำลังอ่าน: ${text.slice(8)}`;
  if (text.startsWith("Writing ")) return `กำลังบันทึก: ${text.slice(8)}`;
  if (text.startsWith("Listing ")) return `กำลังสำรวจ: ${text.slice(8)}`;
  if (text.startsWith("Attaching ")) return `กำลังแนบ: ${text.slice(10)}`;
  if (text.startsWith("Opening ")) return `กำลังเปิด: ${text.slice(8)}`;
  if (text.startsWith("Connecting MCP server: ")) return `กำลังเชื่อมต่อ MCP: ${text.slice(23)}`;
  if (text.startsWith("Delegating to helper: ")) return `กำลังส่งต่อให้บอตผู้ช่วย: ${text.slice(22)}`;
  if (text.startsWith("Creating space: ")) return `กำลังสร้างสเปซ: ${text.slice(16)}`;
  if (text.startsWith("Saving shared memory: ")) return `กำลังบันทึกความจำร่วม: ${text.slice(22)}`;
  if (text.startsWith("Searching the web: ")) return `กำลังค้นหาข้อมูล: ${text.slice(19)}`;
  if (text.startsWith("Using ")) return `กำลังใช้งาน: ${text.slice(6)}`;
  return text;
}
