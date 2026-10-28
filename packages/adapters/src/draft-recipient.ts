/**
 * Reconciles draft recipient metadata with the user's latest explicit intent.
 * Prevents document-internal "To:" headers from silently hijacking draft targets.
 */

export interface ExplicitDraftTarget {
  name?: string;
  email?: string;
}

/**
 * Extracts explicit user recipient intent from a task prompt or steering instruction.
 * Recognizes patterns in Thai and English, handles corrections, negations, and multi-word contact names.
 */
export function extractExplicitRecipientTarget(prompt: string): ExplicitDraftTarget | undefined {
  if (!prompt) return undefined;

  const negationRegex = /(?:ห้ามส่งให้|ห้ามส่ง|ไม่ส่งให้|ไม่ส่ง|ยกเลิก|ยกเลิกแล้ว|cancel(?:ed|led)?|do not send to|prohibited)/i;
  const correctionRegex = /(?:correction:?|แก้ไข:?|แก้ไขคำสั่ง(?:ล่าสุด)?:?|เปลี่ยน(?:เป็น)?:?|instead of|updated to)/i;

  const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const emails: Array<{ email: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = emailPattern.exec(prompt)) !== null) {
    emails.push({ email: m[0].toLowerCase(), index: m.index });
  }

  if (emails.length === 0) return undefined;

  const candidates: Array<{
    name?: string;
    email: string;
    negated: boolean;
    isCorrection: boolean;
    index: number;
  }> = [];

  let prevEmailEnd = 0;
  for (const item of emails) {
    const segmentBefore = prompt.slice(prevEmailEnd, item.index);
    const segmentAfter = prompt.slice(item.index + item.email.length, Math.min(prompt.length, item.index + item.email.length + 80));
    prevEmailEnd = item.index + item.email.length;

    const isCorrection = correctionRegex.test(segmentBefore);

    // If this candidate was introduced as a correction, following phrases like "แทน First" or "ผู้รับตามคำสั่งแรกยกเลิกแล้ว"
    // refer to the replaced prior target, NOT this candidate!
    let isNegated = false;
    if (!isCorrection) {
      isNegated =
        negationRegex.test(segmentBefore) ||
        /^[^\n.,;]*\b(?:ยกเลิกแล้ว|ห้ามส่ง|cancelled|do not send)\b/i.test(segmentAfter);
    }

    // Multi-word name in Thai: ให้ <name> ที่ <email> or ร่างอีเมลให้ <name> ที่ <email>
    let name: string | undefined;
    const thaiNameMatch = segmentBefore.match(/(?:ให้|ร่างอีเมลให้|ส่งให้)\s+([A-Za-zก-๙0-9_.\s]+?)\s+ที่\s*$/);
    if (thaiNameMatch?.[1]) {
      name = thaiNameMatch[1].trim();
    }
    // Multi-word name in English: to <name> at <email> or draft to <name> at <email>
    const engNameMatch = segmentBefore.match(/(?:\bto|\bdraft to)\s+([A-Za-z0-9_.\s]+?)\s+at\s*$/i);
    if (engNameMatch?.[1]) {
      name = engNameMatch[1].trim();
    }

    candidates.push({
      name,
      email: item.email,
      negated: isNegated,
      isCorrection,
      index: item.index,
    });
  }

  // If a candidate is explicitly a correction, any preceding candidates are superseded
  const correctionIndex = candidates.findIndex((c) => c.isCorrection);
  if (correctionIndex !== -1) {
    for (let i = 0; i < correctionIndex; i++) {
      const prior = candidates[i];
      if (prior) prior.negated = true;
    }
  }

  // Also check if any candidate's name or order was explicitly cancelled in the prompt
  const firstEmailIndex = emails[0]?.index;
  for (const c of candidates) {
    if (c.name && new RegExp(`(?:ยกเลิก\\s*${c.name}|${c.name}\\s*ยกเลิกแล้ว|cancel(?:led)?\\s*${c.name}|${c.name}\\s*is\\s*cancel(?:led)?)`, "i").test(prompt)) {
      c.negated = true;
    }
    if (firstEmailIndex !== undefined && c.index === firstEmailIndex && /ผู้รับตามคำสั่งแรกยกเลิกแล้ว|คำสั่งแรกยกเลิก/i.test(prompt)) {
      c.negated = true;
    }
  }

  const valid = candidates.filter((c) => !c.negated);
  if (valid.length === 0) return undefined;

  // Prefer correction if present, otherwise latest valid candidate
  const chosen = valid.find((c) => c.isCorrection) ?? valid[valid.length - 1];
  if (!chosen) return undefined;

  return {
    name: chosen.name,
    email: chosen.email,
  };
}

/**
 * Reconciles recipient field in JSON response with explicit user target.
 * When the user specifies an explicit target (e.g. "ให้ Alex ที่ alex@example.test"),
 * but the model captured the source email's header To: instead, this updates the
 * recipient field in the JSON data to match the explicit user target.
 */
export function reconcileDraftRecipientInJson(
  jsonText: string,
  userPrompt: string,
): string {
  const target = extractExplicitRecipientTarget(userPrompt);
  if (!target || !target.email) return jsonText;

  // Try direct parse first
  try {
    const data = JSON.parse(jsonText);
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      let modified = false;
      if ("recipient" in data && typeof data.recipient === "string") {
        if (data.recipient.toLowerCase() !== target.email.toLowerCase()) {
          data.recipient = target.email;
          modified = true;
        }
      }

      // Ensure draft greeting matches the target if name is present
      if (target.name && typeof data.draft_thai === "string") {
        const greetingRegex = /^(สวัสดี\s+)([^\s,]+)([,.]?)/;
        const m = data.draft_thai.match(greetingRegex);
        if (m && m[2].toLowerCase() !== target.name.toLowerCase()) {
          data.draft_thai = data.draft_thai.replace(greetingRegex, `$1${target.name}$3`);
          modified = true;
        }
      }

      return modified ? JSON.stringify(data, null, 2) : jsonText;
    }
  } catch {}

  // If jsonText contains embedded JSON (e.g. within prose or code fences)
  const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const data = JSON.parse(jsonMatch[0]);
      if (typeof data === "object" && data !== null && !Array.isArray(data)) {
        let modified = false;
        if ("recipient" in data && typeof data.recipient === "string") {
          if (data.recipient.toLowerCase() !== target.email.toLowerCase()) {
            data.recipient = target.email;
            modified = true;
          }
        }
        if (target.name && typeof data.draft_thai === "string") {
          const greetingRegex = /^(สวัสดี\s+)([^\s,]+)([,.]?)/;
          const m = data.draft_thai.match(greetingRegex);
          if (m && m[2].toLowerCase() !== target.name.toLowerCase()) {
            data.draft_thai = data.draft_thai.replace(greetingRegex, `$1${target.name}$3`);
            modified = true;
          }
        }
        if (modified) {
          const updatedJson = JSON.stringify(data, null, 2);
          return jsonText.replace(jsonMatch[0], updatedJson);
        }
      }
    } catch {}
  }

  return jsonText;
}

/**
 * Checks whether the prompt specifies draft-only behavior (no send/messaging tools permitted).
 */
export function isDraftOnlyTask(prompt: string): boolean {
  if (!prompt) return false;
  return (
    prompt.includes("ร่างคำตอบภาษาไทยในแชตเท่านั้น") ||
    prompt.includes("ในแชตเท่านั้น") ||
    prompt.includes("draft only in chat") ||
    prompt.includes("draft-only") ||
    prompt.includes("ห้ามส่งอีเมล") ||
    prompt.includes("ไม่ต้องส่งเมล") ||
    prompt.includes("ไม่ต้องเชื่อม Gmail หรือส่งเมล") ||
    prompt.includes("อย่าเพิ่งส่ง") ||
    prompt.includes("ร่างไว้ก่อน") ||
    prompt.includes("เตรียมร่าง") ||
    prompt.includes("ไม่ส่งจริง") ||
    prompt.includes("ห้ามส่งจริง") ||
    prompt.includes("draft first") ||
    prompt.includes("do not send") ||
    /ร่าง.*อย่าเพิ่งส่ง/.test(prompt)
  );
}
