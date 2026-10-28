import { catalogImageCapability } from "./model-vision.js";

// Legacy tier helpers are no longer used by Auto. Their visual path must still
// require known vision rather than mistaking orphan eligibility for proof.
const modelAcceptsImageInput = (provider: string, id: string) =>
  catalogImageCapability(provider, id) === "vision";

export type TaskModelTiers = {
  read: { provider: string; id: string };
  strong: { provider: string; id: string };
};

/** Account model selections take precedence over the deployment's strong fallback. */
export function taskStrongModel(
  tiers: TaskModelTiers,
  selected: { provider: string; defaultModel: string | null } | null,
  escalatingRead = false,
  requiresVision = false,
) {
  const provider = selected?.provider.trim();
  const id = selected?.defaultModel?.trim();
  if (
    provider &&
    id &&
    (!escalatingRead || provider !== tiers.read.provider || id !== tiers.read.id) &&
    (!requiresVision || modelAcceptsImageInput(provider, id))
  )
    return { provider, id };
  if (!requiresVision || modelAcceptsImageInput(tiers.strong.provider, tiers.strong.id)) {
    return tiers.strong;
  }
  return tiers.read;
}

export function taskModelTiersFromEnv(
  env: Record<string, string | undefined>,
): TaskModelTiers | undefined {
  const fields = [
    env.TASK_READ_MODEL_PROVIDER,
    env.TASK_READ_MODEL_ID,
    env.TASK_STRONG_MODEL_PROVIDER,
    env.TASK_STRONG_MODEL_ID,
  ].map((value) => value?.trim());
  if (fields.every((value) => !value)) return undefined;
  if (fields.some((value) => !value))
    throw new Error("Configure both task model tiers with provider and model ID.");
  return {
    read: { provider: fields[0]!, id: fields[1]! },
    strong: { provider: fields[2]!, id: fields[3]! },
  };
}

export function taskModelTier(
  tiers: TaskModelTiers | undefined,
  prompt: string,
  pinned = false,
  hasImages = false,
) {
  if (!tiers || pinned) return undefined;
  if (hasImages) {
    if (!modelAcceptsImageInput(tiers.strong.provider, tiers.strong.id)) {
      return "read" as const;
    }
  }
  const positive = prompt
    .replace(/\b(?:do not|don't|never|avoid)\s+[^.!\n]*/gi, "")
    .replace(/(?:ห้าม|อย่า)[^\n.!]*/g, "");
  const read =
    /\blist[_ ]files\b|\blist\b.{0,50}\b(?:files|workspace)\b|\bread[_ ]file\b|\bread\b.{0,30}\bfile\b|ลิสต์ไฟล์|รายการไฟล์|อ่านไฟล์/i.test(
      positive,
    );
  const edit =
    /\b(?:edit|modify|overwrite|write|create|delete|remove|patch|fix)\b|แก้ไข|แก้ไฟล์|เขียนไฟล์|ลบไฟล์|สร้างไฟล์/i.test(
      positive,
    );
  const complex =
    /\b(?:reconcil|calculate|computation|aggregate|formula|analysis|analyze|sum|count|diff|join|math)\b|กระทบยอด|คำนวณ|ประมวลผล|วิเคราะห์|สรุปยอด|ยอดรวม|ผลรวม|หักลบ|เปรียบเทียบ|นับจำนวน|แปลงสกุลเงิน/i.test(
      positive,
    );
  return read && !edit && !complex ? ("read" as const) : ("strong" as const);
}

export function readToolFailed(name: string, result: unknown, failure?: unknown): boolean {
  if (name !== "list_files" && name !== "read_file") return false;
  if (failure !== undefined) return true;
  if (!result || typeof result !== "object") return false;
  const record = result as Record<string, unknown>;
  const details =
    record.details && typeof record.details === "object"
      ? (record.details as Record<string, unknown>)
      : record;
  return Boolean(record.isError || details.error);
}
