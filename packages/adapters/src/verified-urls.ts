import type { PrismaClient } from "@rakazo/db";

const URL_REGEX = /https?:\/\/[^\s"'`<>]+/gi;

/**
 * Extracts explicit HTTP(S) URLs from text.
 */
export function extractExplicitUrls(text: string): string[] {
  if (!text) return [];
  const matches = text.match(URL_REGEX) || [];
  return Array.from(
    new Set(
      matches
        .map((u) => {
          try {
            const parsed = new URL(u);
            return parsed.toString();
          } catch {
            return "";
          }
        })
        .filter((u): u is string => Boolean(u)),
    ),
  );
}

/**
 * Finds URLs with confirmed evidence in the given space:
 * 1. URLs explicitly provided by the user in user messages (role: "user").
 * 2. URLs that were successfully navigated to in completed external effects (kind: "browser_navigate").
 * Models' unconfirmed statements are strictly excluded.
 */
export async function findVerifiedUrlsForSpace(
  prisma: PrismaClient,
  spaceId: string,
  keyword?: string,
): Promise<string[]> {
  const verifiedUrls = new Set<string>();
  const kw = keyword ? keyword.toLowerCase().trim() : undefined;

  // 1. Successful navigations from external effects
  try {
    const effects = await prisma.externalEffect.findMany({
      where: {
        spaceId,
        kind: "browser_navigate",
        status: "completed",
      },
      select: { request: true, result: true },
      take: 100,
      orderBy: { createdAt: "desc" },
    });

    for (const effect of effects) {
      const res = effect.result as Record<string, unknown> | null;
      if (!res || res.error || res.ok === false) continue;
      const req = effect.request as Record<string, unknown> | null;
      const urlCandidate =
        (typeof res.url === "string" ? res.url : undefined) ||
        (typeof req?.url === "string" ? req.url : undefined);
      if (urlCandidate && /^https?:\/\//i.test(urlCandidate)) {
        try {
          const parsed = new URL(urlCandidate);
          verifiedUrls.add(parsed.origin + (parsed.pathname === "/" ? "/" : parsed.pathname));
        } catch {
          // ignore invalid URLs
        }
      }
    }
  } catch {
    // If table or query unavailable, continue to messages
  }

  // 2. User-confirmed URLs explicitly provided in user messages
  try {
    const userMessages = await prisma.message.findMany({
      where: {
        thread: { spaceId },
        role: "user",
      },
      select: { blocks: true },
      take: 100,
      orderBy: { createdAt: "desc" },
    });

    for (const msg of userMessages) {
      const blocks = Array.isArray(msg.blocks) ? msg.blocks : [];
      for (const block of blocks) {
        if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
          const urls = extractExplicitUrls(block.text);
          for (const u of urls) {
            try {
              const parsed = new URL(u);
              verifiedUrls.add(parsed.origin + (parsed.pathname === "/" ? "/" : parsed.pathname));
            } catch {
              // ignore
            }
          }
        }
      }
    }
  } catch {
    // ignore
  }

  const results = Array.from(verifiedUrls);
  if (!kw) return results;

  // Filter by keyword if provided (e.g. "flick" or "docchula")
  return results.filter((url) => {
    try {
      const parsed = new URL(url);
      return (
        parsed.hostname.toLowerCase().includes(kw) ||
        parsed.pathname.toLowerCase().includes(kw) ||
        url.toLowerCase().includes(kw)
      );
    } catch {
      return url.toLowerCase().includes(kw);
    }
  });
}

/**
 * Checks whether a user prompt is specifically asking to probe/inspect whether a URL is reachable.
 * (e.g. "ตรวจว่า URL นี้เข้าได้ไหม", "เช็กว่าโดเมนเข้าได้ไหม", "verify if URL is reachable")
 */
export function isProbeOrInspectionTask(prompt?: string): boolean {
  if (!prompt) return false;
  const p = prompt.toLowerCase();
  const thaiCheck =
    /(ตรวจ|เช็ค|เช็ก|ทดสอบ|ดูว่า|ลองดูว่า).*?(เข้าได้|ใช้ได้|เปิดได้|ล่ม|ดับ|ออนไลน์|ทำงาน)/i.test(
      prompt,
    );
  const thaiQuestion = /(เข้าได้ไหม|เปิดได้ไหม|ใช้ได้ไหม|ล่มไหม|ดับไหม)/i.test(prompt);
  const engCheck =
    /\b(check|test|probe|verify|inspect|ping)\b.*?\b(reach|access|up|down|online|work|valid)/i.test(
      p,
    );
  const engQuestion = /\b(is|can)\b.*?\b(reachable|accessible|up|working|open)\b/i.test(p);
  return thaiCheck || thaiQuestion || engCheck || engQuestion;
}

/**
 * Formats a clear Thai message when a navigation failure occurs.
 */
export function formatThaiDnsFailureMessage(options: {
  hostname: string;
  suggestions?: string[];
}): string {
  const { hostname, suggestions } = options;
  const hostTokens = hostname
    .toLowerCase()
    .split(/[.-]/)
    .filter((t) => t.length > 2 && !["com", "net", "org", "co", "th", "ac", "www", "http", "https"].includes(t));
  const cleanSuggestions = (suggestions ?? []).filter((s) => {
    if (!s || s.includes(hostname)) return false;
    try {
      const sHost = new URL(s).hostname.toLowerCase();
      return hostTokens.some((tok) => sHost.includes(tok));
    } catch {
      return false;
    }
  });
  if (cleanSuggestions.length > 0) {
    return `เปิด ${hostname} ไม่ได้ เพราะตรวจไม่พบชื่อโดเมนใน DNS
คอมพิวเตอร์บอตยังเข้าเว็บไซต์อื่นได้ตามปกติ
มี URL ที่เคยเปิดสำเร็จคือ ${cleanSuggestions.join(", ")}
ต้องการเปิด URL นี้หรือระบุ URL อื่น?`;
  }
  return `เปิด ${hostname} ไม่ได้ เพราะตรวจไม่พบชื่อโดเมนใน DNS
คอมพิวเตอร์บอตยังเข้าเว็บไซต์อื่นได้ตามปกติ
กรุณาตรวจสอบชื่อโดเมนหรือระบุ URL ที่ถูกต้อง`;
}

/**
 * Formats Thai browser failure message for run errors.
 */
export function formatThaiBrowserFailureMessage(blocked: {
  error?: unknown;
  errorCode?: unknown;
  hostname?: unknown;
  suggestions?: unknown;
  note?: unknown;
  challengeDetected?: unknown;
  challengeType?: unknown;
}): string {
  if (blocked.challengeDetected) {
    return `ยังทำงานไม่สำเร็จ: ตรวจพบแบบทดสอบความปลอดภัย (${blocked.challengeType || "CAPTCHA"}) ต้องให้ผู้ใช้ช่วยดำเนินการบนหน้าจอ`;
  }
  if (blocked.errorCode === "FLOW_STATE_INVALID") {
    return `ยังทำงานไม่สำเร็จ: หน้าเว็บส่งกลับข้อผิดพลาด HTTP 400 (flow state ไม่ถูกต้อง) ควรนำทางกลับไปยังหน้าเริ่มต้นของบริการ`;
  }
  if (blocked.errorCode === "CDP_DISCONNECTED") {
    return "ยังทำงานไม่สำเร็จ: การเชื่อมต่อเบราว์เซอร์ขัดข้อง (CDP disconnected) กรุณาเชื่อมต่อเบราว์เซอร์อีกครั้ง";
  }
  if (
    blocked.note &&
    typeof blocked.note === "string" &&
    /[\u0E00-\u0E7F]/.test(blocked.note)
  ) {
    return `ยังทำงานไม่สำเร็จ: ${blocked.note}`;
  }
  if (blocked.errorCode === "NXDOMAIN") {
    const host = String(blocked.hostname || "เว็บไซต์");
    const suggestions = Array.isArray(blocked.suggestions)
      ? (blocked.suggestions as string[])
      : [];
    return `ยังทำงานไม่สำเร็จ: ${formatThaiDnsFailureMessage({
      hostname: host,
      suggestions,
    })}`;
  }
  const detail = String(blocked.error || "เครื่องมือคลิกหน้าเว็บล้มเหลว");
  return `ยังทำงานไม่สำเร็จ: ไม่สามารถคลิกหรือสั่งการบนหน้าเว็บได้ (${detail}) ต้องตรวจหน้าจอแล้วดำเนินการต่อ`;
}

/**
 * Formats prompt guidance for verified URLs.
 */
export function formatVerifiedUrlsInstruction(verifiedUrls?: readonly string[]): string {
  if (!verifiedUrls || verifiedUrls.length === 0) return "";
  return `Verified URLs from earlier confirmed history in this workspace: ${verifiedUrls.slice(0, 5).join(", ")}. When the user refers to recent or previously opened websites without typing the full URL, use these confirmed URLs directly.`;
}
