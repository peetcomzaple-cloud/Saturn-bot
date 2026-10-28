/**
 * Structured output contract detection, validation, and bounded repair.
 * Enforces JSON object / schema requirements when explicitly requested in prompts.
 */

export interface OutputContract {
  requireObject: boolean;
  allowArray: boolean;
  strictJsonOnly: boolean;
  requiredFields?: string[];
  fieldTypes?: Record<string, "string" | "boolean" | "number" | "object" | "array" | "any">;
  arrayItemSchema?: {
    requiredFields?: string[];
    fieldTypes?: Record<string, "string" | "boolean" | "number" | "object" | "array" | "any">;
  };
}

export type ContractFailureCode =
  | "EMPTY_TEXT"
  | "NO_JSON_FOUND"
  | "PARSE_ERROR"
  | "MISSING_REQUIRED_FIELD"
  | "TYPE_MISMATCH"
  | "INVARIANT_VIOLATION"
  | "CONTRADICTION"
  | "TOOL_EVIDENCE_MISMATCH"
  | "INVALID_DECISION";

export interface OutputContractValidationResult {
  ok: boolean;
  code?: ContractFailureCode;
  error?: string;
  data?: unknown;
  rawJson?: string;
  repaired?: boolean;
  repairReason?: string;
  isStrictJsonFinal?: boolean;
  extractedExplanation?: string;
}

export interface ValidationOptions {
  trustedToolEvidence?: unknown;
  taskPrompt?: string;
  allowRepair?: boolean;
}

function extractOutermostBraces(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start + 1, i);
      }
    }
  }
  return null;
}

function splitTopLevelEntries(text: string): string[] {
  const result: string[] = [];
  let current = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "{" || char === "[" || char === "(") {
      depth++;
      current += char;
    } else if (char === "}" || char === "]" || char === ")") {
      depth = Math.max(0, depth - 1);
      current += char;
    } else if (char === "," && depth === 0) {
      if (current.trim()) result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

/**
 * Detect whether the user's task prompt specifies a structured output contract.
 * Only triggers when the prompt explicitly requests JSON output; does not force JSON on normal chats.
 */
export function detectOutputContract(prompt: string): OutputContract | undefined {
  if (!prompt) return undefined;

  // 1. Negative intent: "ไม่ต้องคืน JSON", "ห้ามคืน JSON", "don't return json", etc.
  if (/(?:ไม่ต้อง|ไม่ต้องการ|ห้าม|อย่า|no|not|don't|do not)\s*(?:คืน|return)?\s*json/i.test(prompt)) {
    return undefined;
  }

  // 2. Pure informational questions about JSON (e.g. "JSON คืออะไร", "what is JSON?")
  if (/json\s*คืออะไร/i.test(prompt) || /what\s*is\s*json/i.test(prompt)) {
    const hasImperativeAction = /(?:แสดง|คืน|ส่ง|return|output)\s+json/i.test(prompt);
    if (!hasImperativeAction) {
      return undefined;
    }
  }

  const lower = prompt.toLowerCase();
  const mentionsJson =
    lower.includes("json") ||
    lower.includes("คืน json") ||
    lower.includes("return json") ||
    lower.includes("แสดง json");

  if (!mentionsJson) return undefined;

  // Strict object intent: user wants ONLY JSON and no prose
  const strictObjectExplicit =
    prompt.includes("JSON object เท่านั้น") ||
    prompt.includes("json object only") ||
    prompt.includes("JSON object only") ||
    prompt.includes("คืน JSON เพียง {") ||
    prompt.includes("คืน JSON เพียง") ||
    prompt.includes("JSON เท่านั้น") ||
    /คืน\s+JSON\s+เพียง\s*\{/i.test(prompt) ||
    /json\s+object\s+เท่านั้น/i.test(prompt);

  // Explanation intent: user explicitly requests explanation along with JSON
  const requestsExplanation =
    prompt.includes("และคำอธิบาย") ||
    prompt.includes("พร้อมคำอธิบาย") ||
    prompt.includes("อธิบายไทยสั้น") ||
    prompt.includes("with explanation") ||
    /คำอธิบาย(?:ไทย)?สั้น\s*ๆ/i.test(prompt) ||
    /อธิบาย(?:ไทย)?สั้น\s*ๆ\s*นอก/i.test(prompt);

  const strictJsonOnly = strictObjectExplicit && !requestsExplanation;

  // Array / list intent
  const arrayExplicit =
    prompt.includes("เป็นรายการ") ||
    prompt.includes("json array") ||
    prompt.includes("array of") ||
    /decisions\s+เป็นรายการ/i.test(prompt) ||
    /คืน\s+JSON\s+.*เป็นรายการ/i.test(prompt);

  let requiredFields: string[] | undefined;
  const fieldTypes: Record<string, "string" | "boolean" | "number" | "object" | "array" | "any"> = {};

  // Extract outermost balanced braces: {field1, field2:boolean, orders:[{...}]}
  const curlyContent = extractOutermostBraces(prompt);
  if (curlyContent !== null) {
    const rawContent = curlyContent.trim();
    const entries = splitTopLevelEntries(rawContent);
    const fields: string[] = [];
    for (const entry of entries) {
      // Check for array like: orders:[{...}] or orders:[...]
      const arrayMatch = entry.match(/^([a-zA-Z0-9_]+)\s*:\s*\[/);
      if (arrayMatch?.[1]) {
        fields.push(arrayMatch[1]);
        fieldTypes[arrayMatch[1]] = "array";
        continue;
      }
      // Check for colon types like: field:boolean, field:number|null, field: ALLOW หรือ DENY
      const colonMatch = entry.match(/^([a-zA-Z0-9_]+)\s*:\s*(.+)$/);
      if (colonMatch?.[1] && colonMatch[2]) {
        const fieldName = colonMatch[1];
        const typePart = colonMatch[2].toLowerCase();
        fields.push(fieldName);
        // Collection type wins over the primitive name inside it (number[], Array<number>).
        if (typePart.includes("array") || typePart.includes("[")) {
          fieldTypes[fieldName] = "array";
        } else if (typePart.includes("boolean")) {
          fieldTypes[fieldName] = "boolean";
        } else if (typePart.includes("number")) {
          fieldTypes[fieldName] = "number";
        } else if (typePart.includes("object") || typePart.includes("{")) {
          fieldTypes[fieldName] = "object";
        } else {
          fieldTypes[fieldName] = "string";
        }
        continue;
      }
      // Check for typed field in parentheses like: name (string)
      const parenTypeMatch = entry.match(/^([a-zA-Z0-9_]+)\s*\(\s*(string|boolean|number|object|array)\b/i);
      if (parenTypeMatch?.[1] && parenTypeMatch[2]) {
        fields.push(parenTypeMatch[1]);
        fieldTypes[parenTypeMatch[1]] = parenTypeMatch[2].toLowerCase() as any;
        continue;
      }
      // Simple identifier
      const cleanName = entry.replace(/\([^)]*\)/g, "").trim();
      if (/^[a-zA-Z0-9_]+$/.test(cleanName)) {
        fields.push(cleanName);
      }
    }
    if (fields.length > 0) {
      requiredFields = fields;
    }
  }

  // Also check for colon notation: คืน JSON: release (string), failed_check (string)...
  const colonListMatch = prompt.match(/(?:คืน|แสดง)\s+JSON\s*:\s*([a-zA-Z0-9_,\s():]+?)(?:และ|\r|\n|$)/i);
  if (colonListMatch?.[1] && (!requiredFields || requiredFields.length === 0)) {
    const fields = colonListMatch[1]
      .split(",")
      .map((s) => (s.replace(/\([^)]*\)/g, "").split(":")[0] ?? "").trim())
      .filter((s) => /^[a-zA-Z0-9_]+$/.test(s));
    if (fields.length > 0) {
      requiredFields = fields;
    }
  }

  // Match typed field patterns elsewhere in prompt like: field (boolean)
  const typedFieldRegex = /([a-zA-Z0-9_]+)\s*\(\s*(string|boolean|number|object|array)[^)]*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = typedFieldRegex.exec(prompt)) !== null) {
    const fieldName = match[1];
    const typeName = match[2]?.toLowerCase() as
      | "string"
      | "boolean"
      | "number"
      | "object"
      | "array"
      | undefined;
    if (fieldName && typeName && !fieldTypes[fieldName]) {
      fieldTypes[fieldName] = typeName;
    }
  }

  if (!requiredFields && Object.keys(fieldTypes).length > 0) {
    requiredFields = Object.keys(fieldTypes);
  }

  // If prompt is just asking what is JSON without requesting any contract or structure
  if (!strictObjectExplicit && !arrayExplicit && !requiredFields && Object.keys(fieldTypes).length === 0) {
    return undefined;
  }

  let arrayItemSchema: OutputContract["arrayItemSchema"] = undefined;
  if (arrayExplicit && requiredFields && requiredFields.length > 0) {
    arrayItemSchema = {
      requiredFields: [...requiredFields],
      fieldTypes: { ...fieldTypes },
    };
  }

  return {
    requireObject: strictObjectExplicit || (!arrayExplicit && curlyContent !== null),
    allowArray: arrayExplicit,
    strictJsonOnly,
    requiredFields: requiredFields && requiredFields.length > 0 ? requiredFields : undefined,
    fieldTypes: Object.keys(fieldTypes).length > 0 ? fieldTypes : undefined,
    arrayItemSchema,
  };
}

/**
 * Clean and attempt bounded repair on JSON text.
 * Fixes trailing commas, unescaped raw newlines inside strings, and unescaped quotes.
 */
export function attemptJsonTextRepair(raw: string): string {
  let out = "";
  let inString = false;
  let escape = false;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];

    if (inString) {
      if (escape) {
        escape = false;
        out += c;
        continue;
      }

      if (c === "\\") {
        escape = true;
        out += c;
        continue;
      }

      if (c === '"') {
        inString = false;
        out += c;
        continue;
      }

      // Literal newline inside string is invalid in JSON; escape it
      if (c === "\n") {
        out += "\\n";
        continue;
      }
      if (c === "\r") {
        continue;
      }

      out += c;
      continue;
    }

    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }

    if (c === ",") {
      // Look ahead to see if next non-whitespace character is } or ]
      let nextIdx = i + 1;
      while (nextIdx < raw.length && /\s/.test(raw[nextIdx] ?? "")) {
        nextIdx++;
      }
      if (nextIdx < raw.length && (raw[nextIdx] === "}" || raw[nextIdx] === "]")) {
        // Skip trailing comma
        continue;
      }
    }

    out += c;
  }

  return out;
}

export function extractOuterJsonSubstring(
  text: string,
  openChar: "{" | "[",
  closeChar: "}" | "]",
): string | null {
  const startIdx = text.indexOf(openChar);
  if (startIdx === -1) return null;
  const endIdx = text.lastIndexOf(closeChar);
  if (endIdx === -1 || endIdx <= startIdx) return null;
  return text.substring(startIdx, endIdx + 1);
}

/**
 * Validate and optionally repair policy decision items.
 * Detects internal claim/reasoning contradictions (e.g. decision: ALLOW while reason concludes DENY).
 */
export function validatePolicyDecisions(
  items: Array<Record<string, unknown>>,
  options?: { allowRepair?: boolean; expectedPersons?: string[] },
): { ok: boolean; data: Array<Record<string, unknown>>; error?: string; repaired?: boolean; repairReason?: string } {
  const repairedItems: Array<Record<string, unknown>> = [];
  let wasRepaired = false;
  const repairReasons: string[] = [];

  const foundPersons = new Set<string>();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (typeof item !== "object" || item === null) {
      return { ok: false, data: items, error: `Decision item at index ${i} is not an object` };
    }

    const person = String(item.person ?? "").trim();
    let decision = String(item.decision ?? "").trim().toUpperCase();
    const reason = String(item.reason ?? "").trim();
    const sourceFile = String(item.source_file ?? item.source ?? "").trim();
    const section = String(item.section ?? item.rule ?? "").trim();

    if (!person) {
      return { ok: false, data: items, error: `Decision item at index ${i} missing person` };
    }
    foundPersons.add(person);

    // Contradiction detection: decision says ALLOW but reason explicitly concludes DENY/prohibited/expired
    const reasonLower = reason.toLowerCase();
    const reasonConcludesDeny =
      /(?:thus|therefore|so|hence)\s*,?\s*(?:the\s+access\s+should\s+be\s+)?deny\b/i.test(reason) ||
      /\bshould be deny\b/i.test(reason) ||
      /\bmust be deny\b/i.test(reason) ||
      /\baccess is prohibited\b/i.test(reason) ||
      /\boverride has expired\b/i.test(reason) ||
      /สรุป(?:ว่า)?\s*(?:ปฏิเสธ|ไม่อนุมัติ|deny)/i.test(reason) ||
      /หมดอายุ/i.test(reason);

    if (decision === "ALLOW" && reasonConcludesDeny) {
      if (options?.allowRepair !== false) {
        decision = "DENY";
        wasRepaired = true;
        repairReasons.push(`Repaired ${person} decision from ALLOW to DENY due to explicit concluding reasoning`);
      } else {
        return {
          ok: false,
          data: items,
          error: `Contradiction for person ${person}: decision is ALLOW but reason states ${reason.slice(0, 100)}...`,
        };
      }
    }

    if (decision !== "ALLOW" && decision !== "DENY") {
      return { ok: false, data: items, error: `Invalid decision "${decision}" for person ${person}: must be ALLOW or DENY` };
    }

    repairedItems.push({
      person,
      decision,
      reason,
      source_file: sourceFile,
      section,
    });
  }

  if (options?.expectedPersons) {
    for (const exp of options.expectedPersons) {
      if (!foundPersons.has(exp)) {
        return { ok: false, data: repairedItems, error: `Missing decision for expected person: ${exp}` };
      }
    }
  }

  return {
    ok: true,
    data: repairedItems,
    repaired: wasRepaired,
    repairReason: repairReasons.join("; "),
  };
}

/**
 * Validate and coerce fields against an OutputContract.
 */
function validateAndCoerce(
  data: unknown,
  contract: OutputContract,
  options?: ValidationOptions,
): OutputContractValidationResult {
  if (Array.isArray(data)) {
    if (contract.requireObject && !contract.allowArray) {
      if (data.length === 1 && typeof data[0] === "object" && data[0] !== null && !Array.isArray(data[0])) {
        const singleResult = validateAndCoerce(data[0], contract, options);
        return {
          ...singleResult,
          repaired: true,
          repairReason: "Unwrapped single-item array into target JSON object",
        };
      }
      return { ok: false, code: "FORMAT_MISMATCH" as any, error: "Expected JSON object but got array", data };
    }

    // Array is allowed; validate array item schema if present
    if (contract.arrayItemSchema) {
      const items = data as Array<Record<string, unknown>>;
      const itemFields = contract.arrayItemSchema.requiredFields;
      if (itemFields && itemFields.includes("decision") && itemFields.includes("person")) {
        const policyCheck = validatePolicyDecisions(items, { allowRepair: options?.allowRepair });
        if (!policyCheck.ok) {
          return { ok: false, code: "CONTRADICTION", error: policyCheck.error, data };
        }
        return {
          ok: true,
          data: policyCheck.data,
          repaired: policyCheck.repaired,
          repairReason: policyCheck.repairReason,
        };
      }
    }

    return { ok: true, data };
  }

  if (typeof data !== "object" || data === null) {
    return { ok: false, code: "FORMAT_MISMATCH" as any, error: "Expected JSON object", data };
  }

  const obj = { ...(data as Record<string, unknown>) };

  // If object contains decisions array
  if (Array.isArray(obj.decisions) && contract.arrayItemSchema) {
    const policyCheck = validatePolicyDecisions(obj.decisions as Array<Record<string, unknown>>, {
      allowRepair: options?.allowRepair,
    });
    if (!policyCheck.ok) {
      return { ok: false, code: "CONTRADICTION", error: policyCheck.error, data: obj };
    }
    obj.decisions = policyCheck.data;
  }

  // Field type coercion and validation
  if (contract.fieldTypes) {
    for (const [key, expectedType] of Object.entries(contract.fieldTypes)) {
      if (key in obj) {
        const val = obj[key];
        if (expectedType === "boolean") {
          if (typeof val === "boolean") {
            // Valid
          } else if (typeof val === "string") {
            const lower = val.trim().toLowerCase();
            if (lower === "true") obj[key] = true;
            else if (lower === "false") obj[key] = false;
            else if (val === "" || lower === "null") obj[key] = null;
            else {
              return { ok: false, code: "TYPE_MISMATCH", error: `Invalid boolean for field ${key}: ${val}`, data: obj };
            }
          } else if (val === null) {
            // null permitted
          } else {
            return { ok: false, code: "TYPE_MISMATCH", error: `Field ${key} expected boolean, got ${typeof val}`, data: obj };
          }
        } else if (expectedType === "number") {
          if (typeof val === "number" && Number.isFinite(val)) {
            // Valid
          } else if (typeof val === "string") {
            const trimmedVal = val.trim();
            if (trimmedVal !== "" && !isNaN(Number(trimmedVal))) {
              obj[key] = Number(trimmedVal);
            } else {
              obj[key] = null;
            }
          } else if (val === null) {
            // null permitted
          } else {
            return { ok: false, code: "TYPE_MISMATCH", error: `Field ${key} expected number, got ${typeof val}`, data: obj };
          }
        } else if (expectedType === "array") {
          if (!Array.isArray(val)) {
            return { ok: false, code: "TYPE_MISMATCH", error: `Field ${key} expected array`, data: obj };
          }
        }
      }
    }
  }

  // Required fields check
  if (contract.requiredFields) {
    for (const field of contract.requiredFields) {
      if (!(field in obj) || obj[field] === undefined) {
        return { ok: false, code: "MISSING_REQUIRED_FIELD", error: `Missing required field: ${field}`, data: obj };
      }
    }
  }

  // Invariant verification for tabular reconciliation
  if (
    "input_rows" in obj &&
    "unique_orders" in obj &&
    "duplicate_rows" in obj &&
    "gross_thb" in obj &&
    "refund_thb" in obj &&
    "net_thb" in obj
  ) {
    const inputRows = Number(obj.input_rows);
    const uniqueOrders = Number(obj.unique_orders);
    const dupRows = Number(obj.duplicate_rows);
    const gross = Number(obj.gross_thb);
    const refund = Number(obj.refund_thb);
    const net = Number(obj.net_thb);

    if (Number.isFinite(inputRows) && Number.isFinite(uniqueOrders) && Number.isFinite(dupRows)) {
      if (inputRows !== uniqueOrders + dupRows) {
        return {
          ok: false,
          code: "INVARIANT_VIOLATION",
          error: `Invariant violation: input_rows (${inputRows}) != unique_orders (${uniqueOrders}) + duplicate_rows (${dupRows})`,
          data: obj,
        };
      }
    }

    if (Number.isFinite(gross) && Number.isFinite(refund) && Number.isFinite(net)) {
      if (net !== gross - refund) {
        return {
          ok: false,
          code: "INVARIANT_VIOLATION",
          error: `Invariant violation: net_thb (${net}) != gross_thb (${gross}) - refund_thb (${refund})`,
          data: obj,
        };
      }
    }

    // Compare against trusted tool evidence if available
    if (options?.trustedToolEvidence && typeof options.trustedToolEvidence === "object") {
      const trusted = options.trustedToolEvidence as Record<string, unknown>;
      const numericKeys = [
        "input_rows",
        "unique_orders",
        "duplicate_rows",
        "cancelled_orders",
        "paid_orders",
        "gross_thb",
        "refund_thb",
        "net_thb",
        "orphan_refunds",
      ];
      for (const k of numericKeys) {
        if (k in trusted && k in obj) {
          if (Number(obj[k]) !== Number(trusted[k])) {
            return {
              ok: false,
              code: "TOOL_EVIDENCE_MISMATCH",
              error: `Field ${k} value ${obj[k]} mismatches trusted tool evidence ${trusted[k]}`,
              data: obj,
            };
          }
        }
      }
    }
  }

  // Compare single-file aggregation against trusted tool evidence if available
  if ("row_count" in obj && "total_amount" in obj && options?.trustedToolEvidence && typeof options.trustedToolEvidence === "object") {
    const trusted = options.trustedToolEvidence as Record<string, unknown>;
    for (const k of ["row_count", "total_amount", "last_id", "last_amount"]) {
      if (k in trusted && k in obj) {
        if (String(obj[k]) !== String(trusted[k])) {
          return {
            ok: false,
            code: "TOOL_EVIDENCE_MISMATCH",
            error: `Field ${k} value ${obj[k]} mismatches trusted aggregation evidence ${trusted[k]}`,
            data: obj,
          };
        }
      }
    }
  }

  return { ok: true, data: obj };
}

/**
 * Validate assistant text against an OutputContract and return structured, typed results.
 */
export function validateOutputContract(
  text: string,
  contract: OutputContract,
  options?: ValidationOptions,
): OutputContractValidationResult {
  const trimmed = text ? text.trim() : "";
  if (!trimmed) {
    return { ok: false, code: "EMPTY_TEXT", error: "Empty output text" };
  }

  // 1. Try direct parse
  try {
    const parsed = JSON.parse(trimmed);
    const val = validateAndCoerce(parsed, contract, options);
    if (val.ok) {
      return {
        ...val,
        rawJson: JSON.stringify(val.data, null, 2),
        isStrictJsonFinal: true,
      };
    }
    return val;
  } catch {
    // Fall through to extraction and repair
  }

  // 2. Try markdown fenced code block
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let lastFenceMatch: string | null = null;
  let fencePreamble = "";
  let m: RegExpExecArray | null;
  while ((m = fenceRegex.exec(trimmed)) !== null) {
    lastFenceMatch = (m[1] ?? "").trim();
    fencePreamble = trimmed.slice(0, m.index).trim();
  }

  if (lastFenceMatch) {
    try {
      const parsed = JSON.parse(lastFenceMatch);
      const val = validateAndCoerce(parsed, contract, options);
      if (val.ok) {
        return {
          ...val,
          rawJson: JSON.stringify(val.data, null, 2),
          isStrictJsonFinal: !contract.strictJsonOnly ? false : true,
          extractedExplanation: fencePreamble,
        };
      }
    } catch {
      const repaired = attemptJsonTextRepair(lastFenceMatch);
      try {
        const parsed = JSON.parse(repaired);
        const val = validateAndCoerce(parsed, contract, options);
        if (val.ok) {
          return {
            ...val,
            rawJson: JSON.stringify(val.data, null, 2),
            repaired: true,
            repairReason: "Repaired malformed JSON syntax in fenced block",
            isStrictJsonFinal: !contract.strictJsonOnly ? false : true,
            extractedExplanation: fencePreamble,
          };
        }
      } catch {}
    }
  }

  // 3. Try outermost JSON object
  const objectMatch = extractOuterJsonSubstring(trimmed, "{", "}");
  if (objectMatch) {
    try {
      const parsed = JSON.parse(objectMatch);
      const val = validateAndCoerce(parsed, contract, options);
      if (val.ok) {
        return {
          ...val,
          rawJson: JSON.stringify(val.data, null, 2),
          isStrictJsonFinal: !contract.strictJsonOnly ? false : true,
        };
      }
    } catch {
      const repaired = attemptJsonTextRepair(objectMatch);
      try {
        const parsed = JSON.parse(repaired);
        const val = validateAndCoerce(parsed, contract, options);
        if (val.ok) {
          return {
            ...val,
            rawJson: JSON.stringify(val.data, null, 2),
            repaired: true,
            repairReason: "Repaired syntax in outer JSON object",
            isStrictJsonFinal: !contract.strictJsonOnly ? false : true,
          };
        }
      } catch {}
    }
  }

  // 4. Try outermost JSON array if array is permitted
  const arrayMatch = extractOuterJsonSubstring(trimmed, "[", "]");
  if (arrayMatch && (contract.allowArray || contract.requireObject)) {
    try {
      const parsed = JSON.parse(arrayMatch);
      const val = validateAndCoerce(parsed, contract, options);
      if (val.ok) {
        return {
          ...val,
          rawJson: JSON.stringify(val.data, null, 2),
          isStrictJsonFinal: !contract.strictJsonOnly ? false : true,
        };
      }
    } catch {
      const repaired = attemptJsonTextRepair(arrayMatch);
      try {
        const parsed = JSON.parse(repaired);
        const val = validateAndCoerce(parsed, contract, options);
        if (val.ok) {
          return {
            ...val,
            rawJson: JSON.stringify(val.data, null, 2),
            repaired: true,
            repairReason: "Repaired syntax in outer JSON array",
            isStrictJsonFinal: !contract.strictJsonOnly ? false : true,
          };
        }
      } catch {}
    }
  }

  return {
    ok: false,
    code: "NO_JSON_FOUND",
    error: "No valid JSON structure found matching contract",
  };
}

/**
 * Clean and attempt bounded repair on assistant text to produce valid JSON matching the contract.
 * Backwards compatible with existing executor calls that expect a string return.
 */
export function enforceOutputContract(
  text: string,
  contract: OutputContract,
  options?: ValidationOptions,
): string {
  const result = validateOutputContract(text, contract, options);
  if (result.ok && result.rawJson) {
    if (contract.strictJsonOnly || !result.extractedExplanation) {
      return result.rawJson;
    }
    // If user requested explanation with JSON and text had explanation, keep explanation
    return text.replace(/```(?:json)?\s*[\s\S]*?```/gi, `\`\`\`json\n${result.rawJson}\n\`\`\``);
  }

  return `Output contract validation failed: [${result.code ?? "UNKNOWN"}] ${result.error ?? "invalid format"}`;
}
