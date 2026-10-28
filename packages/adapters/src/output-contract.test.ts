import { describe, expect, it } from "vitest";
import {
  detectOutputContract,
  enforceOutputContract,
  validateOutputContract,
  validatePolicyDecisions,
} from "./output-contract.js";

describe("output-contract", () => {
  it.each(["number[]", "boolean[]", "string[]", "object[]", "Array<number>"])(
    "detects a collection before its primitive item type: %s",
    (type) => {
      const contract = detectOutputContract(`คืน JSON object เท่านั้น {ordered_attempts:${type}}`);
      expect(contract?.fieldTypes?.ordered_attempts).toBe("array");
      expect(validateOutputContract('{"ordered_attempts":[]}', contract!).ok).toBe(true);
      expect(validateOutputContract('{"ordered_attempts":1}', contract!).ok).toBe(false);
    },
  );
  it("detects strict JSON object contract from prompt", () => {
    const prompt =
      "อ่าน qa-other-20261012/source.html คืน JSON เพียง {ticket,status,region} จากเนื้อหา dispatch ใน main";
    const contract = detectOutputContract(prompt);
    expect(contract).toBeDefined();
    expect(contract?.requireObject).toBe(true);
    expect(contract?.strictJsonOnly).toBe(true);
    expect(contract?.requiredFields).toEqual(["ticket", "status", "region"]);
  });

  it("detects vision JSON object contract with types", () => {
    const prompt =
      "คืน JSON object เท่านั้น: release (string), failed_check (string), approval_enabled (boolean), blocking_reason (คำอธิบายภาษาไทย)";
    const contract = detectOutputContract(prompt);
    expect(contract).toBeDefined();
    expect(contract?.requireObject).toBe(true);
    expect(contract?.strictJsonOnly).toBe(true);
    expect(contract?.fieldTypes?.approval_enabled).toBe("boolean");
    expect(contract?.requiredFields).toContain("release");
    expect(contract?.requiredFields).toContain("approval_enabled");
  });

  it("detects union types with null such as number|null and boolean|null", () => {
    const prompt =
      "อ่าน qa-real-20261013-a/empty-number.json แล้วคืน JSON object เท่านั้น {total:number|null,approved:boolean|null,reason_thai}";
    const contract = detectOutputContract(prompt);
    expect(contract).toBeDefined();
    expect(contract?.requireObject).toBe(true);
    expect(contract?.strictJsonOnly).toBe(true);
    expect(contract?.fieldTypes?.total).toBe("number");
    expect(contract?.fieldTypes?.approved).toBe("boolean");
    expect(contract?.requiredFields).toEqual(["total", "approved", "reason_thai"]);
  });

  it("does not force JSON contract on informational questions about JSON", () => {
    const prompt = "อธิบายสั้น ๆ เป็นภาษาไทยว่า JSON คืออะไร ไม่ต้องคืน JSON ไม่ใช้เครื่องมือและไม่ทำงานเก่าต่อ";
    expect(detectOutputContract(prompt)).toBeUndefined();

    const whatIsJson = "JSON คืออะไร และใช้งานอย่างไร?";
    expect(detectOutputContract(whatIsJson)).toBeUndefined();
  });

  it("does not force JSON contract on ordinary chat prompts", () => {
    const prompt = "สวัสดี ช่วยเล่าประวัติศาสตร์คอมพิวเตอร์ให้ฟังหน่อย";
    expect(detectOutputContract(prompt)).toBeUndefined();
  });

  it("distinguishes explanation + JSON from strict JSON only", () => {
    const prompt =
      "แสดง JSON: input_rows, unique_orders, duplicate_rows, cancelled_orders, paid_orders, gross_thb, refund_thb, net_thb, orphan_refunds และคำอธิบายไทยสั้น ๆ บอกชื่อไฟล์ต้นทางสามไฟล์";
    const contract = detectOutputContract(prompt);
    expect(contract).toBeDefined();
    expect(contract?.strictJsonOnly).toBe(false);
    expect(contract?.requiredFields).toContain("input_rows");
    expect(contract?.requiredFields).toContain("gross_thb");
  });

  it("detects decision array schema in policy prompts", () => {
    const prompt =
      "ตอบไทยและคืน JSON decisions เป็นรายการ {person, decision: ALLOW หรือ DENY, reason, source_file, section} ครบ Mali, Niran, Ben, Dao อ้างไฟล์และข้อกำหนดที่ใช้จริง";
    const contract = detectOutputContract(prompt);
    expect(contract).toBeDefined();
    expect(contract?.allowArray).toBe(true);
    expect(contract?.strictJsonOnly).toBe(false);
    expect(contract?.arrayItemSchema?.requiredFields).toContain("person");
    expect(contract?.arrayItemSchema?.requiredFields).toContain("decision");
    expect(contract?.arrayItemSchema?.requiredFields).toContain("reason");
  });

  it("detects and repairs claim/reason contradiction in policy decisions", () => {
    const items = [
      {
        person: "Mali",
        decision: "ALLOW", // Contradicts reasoning!
        reason:
          "The override OVR-MALI has expired on 2026-10-10. Today is 2026-10-13. Mali fails V2-EMP because device is unmanaged. Thus, DENY.",
        source_file: "qa-real-20261013-a/policy-v2.md",
        section: "V2-EMP",
      },
      {
        person: "Niran",
        decision: "DENY",
        reason: "Training incomplete.",
        source_file: "qa-real-20261013-a/policy-v2.md",
        section: "V2-EMP",
      },
    ];

    const result = validatePolicyDecisions(items);
    expect(result.ok).toBe(true);
    expect(result.repaired).toBe(true);
    expect(result.data[0]!.decision).toBe("DENY"); // Repaired to DENY!
  });

  it("metamorphic policy validation works with arbitrary people and dates without hardcoding fixture names", () => {
    const items = [
      {
        person: "Alice",
        decision: "ALLOW",
        reason: "Override is active and valid until 2026-10-30.",
        source_file: "overrides-new.md",
        section: "SEC-A",
      },
      {
        person: "Bob",
        decision: "DENY",
        reason: "Access is prohibited without manager approval. Thus, DENY.",
        source_file: "policy-v3.md",
        section: "V3-EXT",
      },
    ];

    const result = validatePolicyDecisions(items, { expectedPersons: ["Alice", "Bob"] });
    expect(result.ok).toBe(true);
    expect(result.data[0]!.decision).toBe("ALLOW");
    expect(result.data[1]!.decision).toBe("DENY");
  });

  it("returns typed failure when required field is missing", () => {
    const contract = {
      requireObject: true,
      allowArray: false,
      strictJsonOnly: true,
      requiredFields: ["ticket", "missing_required_key"],
    };
    const input = '{"ticket": "123"}';
    const validation = validateOutputContract(input, contract);
    expect(validation.ok).toBe(false);
    expect(validation.code).toBe("MISSING_REQUIRED_FIELD");
    expect(validation.error).toContain("missing_required_key");

    const strResult = enforceOutputContract(input, contract);
    expect(strResult).toContain("Output contract validation failed: [MISSING_REQUIRED_FIELD]");
  });

  it("validates mathematical invariants and reports INVARIANT_VIOLATION", () => {
    const contract = {
      requireObject: true,
      allowArray: false,
      strictJsonOnly: true,
      requiredFields: ["input_rows", "unique_orders", "duplicate_rows", "gross_thb", "refund_thb", "net_thb"],
    };
    const input = JSON.stringify({
      input_rows: 100,
      unique_orders: 80,
      duplicate_rows: 10, // 80 + 10 != 100
      gross_thb: 5000,
      refund_thb: 1000,
      net_thb: 4000,
    });
    const result = validateOutputContract(input, contract);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("INVARIANT_VIOLATION");
  });

  it("checks trusted tool evidence and catches mismatches", () => {
    const contract = {
      requireObject: true,
      allowArray: false,
      strictJsonOnly: true,
      requiredFields: ["input_rows", "unique_orders", "duplicate_rows", "gross_thb", "refund_thb", "net_thb"],
    };
    const modelOutput = JSON.stringify({
      input_rows: 130,
      unique_orders: 120,
      duplicate_rows: 10,
      gross_thb: 171607,
      refund_thb: 2340,
      net_thb: 169267,
    });
    const trustedEvidence = {
      input_rows: 130,
      unique_orders: 120,
      duplicate_rows: 10,
      gross_thb: 999999, // Tool calculated differently!
      refund_thb: 2340,
      net_thb: 997659,
    };
    const result = validateOutputContract(modelOutput, contract, { trustedToolEvidence: trustedEvidence });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("TOOL_EVIDENCE_MISMATCH");
    expect(result.error).toContain("gross_thb");
  });

  it("repairs prose preamble with array into single JSON object when single object is requested", () => {
    const contract = {
      requireObject: true,
      allowArray: false,
      strictJsonOnly: true,
      requiredFields: ["ticket", "status", "region"],
    };
    const input = `I have read the qa-other-20261012/source.html file.

Here is the extracted dispatch information:
\`\`\`json
[
  {
    "ticket": "RZ-184",
    "status": "ready",
    "region": "west"
  }
]
\`\`\``;
    const output = enforceOutputContract(input, contract);
    const parsed = JSON.parse(output);
    expect(parsed).toEqual({
      ticket: "RZ-184",
      status: "ready",
      region: "west",
    });
    expect(Array.isArray(parsed)).toBe(false);
  });

  it("handles malformed JSON with trailing commas and unescaped newlines in strings", () => {
    const contract = {
      requireObject: true,
      allowArray: false,
      strictJsonOnly: true,
      requiredFields: ["ticket", "notes"],
    };
    const input = `{"ticket": "RZ-184", "notes": "line 1
line 2",}`;
    const output = enforceOutputContract(input, contract);
    const parsed = JSON.parse(output);
    expect(parsed.ticket).toBe("RZ-184");
    expect(parsed.notes).toContain("line 1");
    expect(parsed.notes).toContain("line 2");
  });

  it("preserves apostrophes in trailing comma repair", () => {
    const contract = {
      requireObject: true,
      allowArray: false,
      strictJsonOnly: true,
      requiredFields: ["note", "ok"],
    };
    const input = '{"note":"O\'Reilly\'s account","ok":true,}';
    const output = enforceOutputContract(input, contract);
    expect(JSON.parse(output).note).toBe("O'Reilly's account");
  });

  it("coerces boolean as string to boolean", () => {
    const contract = {
      requireObject: true,
      allowArray: false,
      strictJsonOnly: true,
      requiredFields: ["approval_enabled"],
      fieldTypes: { approval_enabled: "boolean" } as const,
    };
    const input = '{"approval_enabled": "false"}';
    const output = enforceOutputContract(input, contract);
    expect(JSON.parse(output).approval_enabled).toBe(false);
  });
});
