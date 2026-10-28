import { extractExplicitUrls } from "./verified-urls.js";
import { classifyHttp401Or403 } from "./browser-recovery.js";

export function isHttpBarrierReportTask(prompt: string): boolean {
  // A reported requirement is not a command to carry it out. Do not remove
  // subsequent explicit commands such as "แล้วเข้าสู่ระบบ".
  const commands = prompt
    .replace(/(?:ให้)?รายงาน(?:สถานะ)?ว่า(?:ต้อง|จำเป็นต้อง)เข้าสู่ระบบ(?:ใหม่)?(?:ที่\s*\/[A-Za-z0-9/_?.=&%#-]+)?/gi, "รายงานข้อจำกัด")
    .replace(/\breport\s+(?:that\s+)?(?:login|log\s*in|authentication)\s+(?:is\s+)?required\b(?:\s+at\s+\/[A-Za-z0-9/_?.=&%#-]+)?/gi, "report the barrier")
    .replace(/https?:\/\/[^\s"'`<>]+/gi, " ")
    .replace(/(?:ห้าม|อย่า|ไม่ต้อง|งด)\s*(?:ล้าง|ล็อกอิน|เข้าสู่ระบบ|คลิก|กรอก|ส่งฟอร์ม)/g, " ");
  return extractExplicitUrls(prompt).length === 1 &&
    /รายงาน|\breport\b/i.test(prompt) &&
    /(?:HTTP\s*(?:401|403)|เซสชันหมดอายุ|ข้อจำกัดสิทธิ์)|\b(?:session expired|insufficient permission)\b/i.test(prompt) &&
    !/\b(?:curl|shell|terminal|web_fetch|web_search|browser_inspect)\b/i.test(commands) &&
    !/(?:แก้ไข|แก้ให้|ซ่อม|กู้คืน|ลองใหม่|จนสำเร็จ|ให้สำเร็จ|ล็อกอิน|เข้าสู่ระบบ|กดปุ่ม|คลิก|กรอก|ส่งฟอร์ม|(?<!เ)ปิด|ค้นหา|ดาวน์โหลด|อ่านข้อมูล|ดึงข้อมูล|ดูยอด|แสดงยอด|แล้วเปิด|แล้วไป|จากนั้นเปิด|จากนั้นไป|และเปิด|และไป)|\b(?:fix|repair|recover|retry|authenticate|login|click|submit|fill|close|search|download|retrieve|fetch|read|transfer|pay|purchase)\b|\b(?:log|sign)\s*in\b|\b(?:then|and|afterwards)\s+(?:open|go|navigate|visit|access)\b/i.test(commands);
}

export function isErrorReportTask(prompt: string): boolean {
  return isApiErrorReportTask(prompt) || isHttpBarrierReportTask(prompt) || isNetworkErrorReportTask(prompt);
}

/** Reporting a browser transport failure does not request opening its content. */
export function isNetworkErrorReportTask(prompt: string): boolean {
  const commands = prompt.replace(/https?:\/\/[^\s"'`<>]+/gi, " ")
    .replace(/(?:ห้าม|อย่า|ไม่ต้อง)\s*(?:ข้ามคำเตือน(?:หรือปิดการตรวจสอบใบรับรอง)?|ปิดการตรวจสอบใบรับรอง|เดาเนื้อหาเว็บ)/g, " ")
    .replace(/\b(?:do not|don't|never|without)\s+(?:bypass(?:ing)?\s+(?:the\s+)?(?:certificate\s+)?warnings?|disabl(?:e|ing)\s+certificate\s+verification)\b/gi, " ");
  return extractExplicitUrls(prompt).length === 1 &&
    /รายงาน|\breport\b/i.test(commands) &&
    /\b(?:TLS|SSL|DNS)\b|ใบรับรอง|เปิดไม่ได้|\b(?:certificate|name resolution|navigation failure)\b/i.test(commands) &&
    !/(?:แก้ไข|ซ่อม|กู้คืน|ลองใหม่|จนสำเร็จ|ให้สำเร็จ|ล็อกอิน|เข้าสู่ระบบ|กด|คลิก|กรอก|ส่งฟอร์ม|(?<!เ)ปิด|ข้ามคำเตือน|ค้นหา|ดาวน์โหลด|อ่าน|ดูเนื้อหา|สรุปเนื้อหา|สรุปหน้า|ดึงข้อมูล|แล้วเปิด|แล้วไป|จากนั้นเปิด|จากนั้นไป|และเปิด|และไป)|\b(?:fix|repair|recover|retry|authenticate|login|click|press|submit|fill|close|search|download|retrieve|fetch|read|summarize|summarise|extract|transfer|pay|purchase|bypass|disable|curl|shell|terminal|openssl)\b|\b(?:then|and|afterwards)\s+(?:open|go|navigate|visit|access)\b/i.test(commands);
}

/** A report-only access-barrier task authorizes observation, not remediation. */
export function httpBarrierToolRefusal(prompt: string, name: string, args: Record<string, unknown>, observation: ApiErrorInspection): string | undefined {
  if (!isHttpBarrierReportTask(prompt) && !isNetworkErrorReportTask(prompt)) return undefined;
  if (isNetworkErrorReportTask(prompt) && !["browser_navigate", "browser_snapshot", "computer_observe", "request_takeover"].includes(name)) {
    return "Only report the actual browser navigation failure. Do not change browser state, bypass warnings, run shell probes or retrieve destination content.";
  }
  if (["shell", "web_fetch", "web_search", "browser_inspect", "computer_act", "browser_act", "browser_tab_close", "browser_clear_origin_storage", "list_secrets", "request_secret", "secret_request"].includes(name)) {
    return "Only an observed access-barrier report was requested. Use browser_snapshot and report the actual response; do not run commands, change browser state, initiate authentication or seek credentials.";
  }
  if (name === "browser_navigate") {
    const requested = extractExplicitUrls(prompt)[0];
    if (observation.hasObservedResponse() || url(args.url ?? requested) !== url(requested)) {
      return "The requested error response has already been observed, or this is a different URL. Do not repeat the request or open Login; use browser_snapshot and report the observed barrier.";
    }
  }
  return undefined;
}

/** Inspection is a different goal from making a failed request succeed. */
export function isApiErrorReportTask(prompt: string): boolean {
  // Reading a rendered page's explanation of a failed dependency does not ask
  // for that page itself to be a failed JSON API response.
  const pageTextInspection =
    /(?:ตรวจสอบ|อ่าน|ดู)\s*(?:ข้อความ|เนื้อหา)(?:ใน|บน|ของ)?\s*(?:หน้าเว็บ|หน้า|เว็บไซต์)|\b(?:inspect|read|check)\s+(?:the\s+)?(?:text|content)\s+(?:shown\s+|displayed\s+|rendered\s+)?(?:on|in)\s+(?:the\s+)?(?:page|webpage|dashboard)\b/i;
  const directResponseInspection =
    /(?:ตรวจสอบ|อ่าน|เรียก|เปิด)\s*(?:API|endpoint)|(?:ตรวจสอบ|อ่าน|ดู)\s*(?:การตอบกลับ|ผลตอบกลับ|สถานะ|response|status|body)\s*(?:ของ|จาก)?\s*API|\b(?:inspect|read|check|call|request|open)\s+(?:the\s+)?(?:raw\s+)?(?:API|endpoint)\b|\braw\s+(?:JSON|response)\b|\b(?:JSON|response)\s+body\b|(?:เนื้อหา|ข้อมูล|ตอบกลับ)\s*(?:JSON|ดิบ)/i;
  if (pageTextInspection.test(prompt) && !directResponseInspection.test(prompt)) return false;
  const actionText = prompt
    .replace(/https?:\/\/[^\s"'`<>]+/gi, " ")
    .replace(/(?:ห้าม|อย่า|ไม่ต้อง|งด)\s*(?:แก้ไข|แก้ให้|ซ่อม|กู้คืน|ลองใหม่|ล็อกอิน|เข้าสู่ระบบ|กดปุ่ม|คลิก|กรอก|ส่งฟอร์ม|(?<!เ)ปิด|ค้นหา|ดาวน์โหลด)/g, " ")
    .replace(/\b(?:do not|don't|never|without)\s+(?:fix|repair|recover|retry|authenticate|login|click|submit|fill|log\s*in|close|search|download)\b/gi, " ");
  if (/(?:แก้ไข|แก้ให้|ซ่อม|กู้คืน|ลองใหม่|จนสำเร็จ|ให้สำเร็จ|ล็อกอิน|เข้าสู่ระบบ|กดปุ่ม|คลิก|กรอก|ส่งฟอร์ม|(?<!เ)ปิด|ค้นหา|ดาวน์โหลด)|\b(?:fix|repair|recover|retry|authenticate|login|click|submit|fill|close|search|download)\b|\blog\s*in\b/i.test(actionText)) return false;
  return /\bapi\b|endpoint/i.test(prompt) &&
    /(?:รายงาน|แจ้ง|บอกประเภท)|\b(?:report|describe)\b/i.test(prompt) &&
    /(?:ข้อผิดพลาด|ตอบกลับ)|\b(?:error|response|status)\b/i.test(prompt) &&
    extractExplicitUrls(prompt).length === 1;
}

type Observation = {
  url: string; status: number; frameId: string; loaderId: string;
  targetId?: string; errorType?: string; errorMessage?: string; errorDocumentObserved?: boolean;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
function url(value: unknown): string | undefined {
  try {
    const u = new URL(String(value));
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) return undefined;
    u.hash = "";
    return u.href;
  } catch { return undefined; }
}

/** Run-local state. Navigation or a potential mutation invalidates the prior document. */
export class ApiErrorInspection {
  private observation?: Observation;
  private navigationError?: { url: string; code: string };
  private responseReceived = false;
  hasObservedResponse(): boolean { return this.responseReceived; }
  reset(): void { this.invalidate(); this.responseReceived = false; }
  invalidate(): void { this.observation = undefined; this.navigationError = undefined; }
  navigate(requestedUrl: unknown, value: unknown): void {
    this.invalidate();
    const r = record(value);
    // The tool's explicit failure is evidence of that failure itself. No page
    // content, HTTP response, diagnosis or successful navigation is implied.
    if (r.ok !== true && r.httpStatus === undefined && r.httpStatusStatus !== "known" &&
        typeof r.error === "string" && /^(?:net::)?(?:ERR_CERT_[A-Z_]+|ERR_SSL_[A-Z_]+|ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED)$/.test(r.error) &&
        url(requestedUrl) && url(requestedUrl) === url(r.url)) {
      this.navigationError = { url: url(r.url)!, code: r.error };
      this.responseReceived = true;
    }
    if (r.httpStatusStatus === "known" && typeof r.httpStatus === "number" &&
        r.httpStatus >= 100 && r.httpStatus <= 599 && url(requestedUrl) === url(r.url) && url(r.url)) {
      this.responseReceived = true;
    }
    const apiError = r.httpStatus === 400 && r.errorKind === "api_bad_request";
    const barrier = (r.httpStatus === 401 || r.httpStatus === 403) &&
      ["auth_expired", "insufficient_permission", "auth_or_forbidden", "waf_denied"].includes(String(r.errorKind));
    if ((!apiError && !barrier) || r.httpStatusStatus !== "known" || r.challengeDetected ||
        !r.frameId || !r.loaderId || url(requestedUrl) !== url(r.url) || !url(r.url)) return;
    this.observation = { url: url(r.url)!, status: Number(r.httpStatus),
      frameId: String(r.frameId), loaderId: String(r.loaderId) };
  }
  snapshot(value: unknown): void {
    const r = record(value), o = this.observation;
    if (this.navigationError && (r.error || r.ok === false || url(r.url) !== this.navigationError.url)) {
      this.navigationError = undefined;
    }
    if (!o) return;
    if (r.error || r.ok === false || r.challengeDetected || !r.targetId ||
        r.frameId !== o.frameId || r.loaderId !== o.loaderId || url(r.url) !== o.url ||
        (o.targetId && o.targetId !== r.targetId)) { this.invalidate(); return; }
    o.targetId = String(r.targetId);
    if ((o.status === 401 || o.status === 403) && typeof r.errorDocumentText === "string" &&
        classifyHttp401Or403({status:o.status, url:o.url, title:r.errorDocumentText}).errorKind === "challenge") {
      this.invalidate();
      return;
    }
    // Only the selected document's JSON body; never the prompt, title or tab list.
    o.errorType = undefined;
    o.errorMessage = undefined;
    o.errorDocumentObserved = typeof r.errorDocumentText === "string" && Boolean(r.errorDocumentText.trim()) && r.errorDocumentStatus === o.status;
    try {
      const body = JSON.parse(String(r.responseBodyText));
      if (typeof body?.error?.type === "string" && body.error.type.trim()) {
        o.errorType = body.error.type;
        if (typeof body.error.message === "string") o.errorMessage = body.error.message;
      }
    } catch { /* Unknown body is not evidence of an error type. */ }
  }
  qualifies(prompt: string, currentUrl: unknown): boolean {
    if (isNetworkErrorReportTask(prompt) && this.navigationError) {
      return url(extractExplicitUrls(prompt)[0]) === this.navigationError.url && url(currentUrl) === this.navigationError.url;
    }
    const o = this.observation;
    const reportObserved = o?.status === 400
      ? isApiErrorReportTask(prompt) && Boolean(o.errorType)
      : isHttpBarrierReportTask(prompt) && Boolean(o?.errorDocumentObserved);
    return Boolean(reportObserved && o?.targetId &&
      url(extractExplicitUrls(prompt)[0]) === o.url && url(currentUrl) === o.url);
  }
}

export const API_ERROR_REPORT_GUIDANCE =
  "When asked only to report a browser TLS/SSL/DNS failure, report the explicit navigation tool error and stop; do not click Advanced, bypass warnings, run shell probes or invent destination content. A transport failure has no HTTP response or site body to inspect. When asked only to inspect an HTTP/API error or access barrier and report what was received, observe the response and same-document body, report the observed status/type/message, and stop. Reporting that login or a higher role is required does not authorize navigating to Login, clicking its form, listing credentials or asking for credentials. A403 alone proves denial, not session expiry or a particular cause; use the actual document text and state uncertainty. Do not invent response fields from the prompt. An observed error can complete an inspection without making the request succeed. Do not add parameter/method probes, storage changes or unrelated navigation unless requested. POST returning404 does not establish GET-only support; finite failed probes do not prove all formats fail or identify a server bug. Separate observations from hypotheses.";
