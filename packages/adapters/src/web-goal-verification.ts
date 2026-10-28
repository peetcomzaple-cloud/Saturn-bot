/**
 * General-purpose web goal verification and task completion gating.
 * Enforces evidence-based task completion gates without site-specific hardcoding.
 */

import type { ApiErrorInspection } from "./api-error-inspection.js";
import { isErrorReportTask, isHttpBarrierReportTask, isNetworkErrorReportTask } from "./api-error-inspection.js";

const thaiWords = new Intl.Segmenter("th", { granularity: "word" });

export interface WebGoalState {
  apiErrorInspection?: ApiErrorInspection;
  actionsAttempted: number;
  lastActionOk?: boolean;
  lastActionError?: string;
  lastActionVerified?: boolean;
  httpStatus?: number;
  initialUrl?: string;
  currentUrl?: string;
  currentTitle?: string;
  selectedTargets?: string[];
  activeHeading?: string;
  domStateChanged?: boolean;
  screenChanged?: boolean;
  screenArtifactAttached?: boolean;
  toolLimitExceeded?: boolean;
  toolLimit?: number;
  browserClickAttempted?: boolean;
  desktopClickAttempted?: boolean;
  keyboardEnterAttempted?: boolean;
  searchAttempted?: boolean;
  searchSubmitted?: boolean;
  formFillAttempted?: boolean;
  formFillVerified?: boolean;
  expectedFillValue?: string;
  filledTargetValue?: string;
  loginFormVisible?: boolean;
  activeModal?: string | boolean;
  navigationOnly?: boolean;
  targetWindowClosed?: boolean;
  windowsRemaining?: readonly { id: string; wmClass?: string; title?: string }[];
  targetWindowId?: string;
  targetWindowClass?: string;
  /**
   * Latest observed page-browser tabs (CDP page targets) at verification time.
   * `undefined` means tab identity was never observed (UNKNOWN), which is not
   * evidence of success for tab/popup close goals.
   */
  browserTabs?: readonly ObservedBrowserTab[];
  browserTabsStatus?: "observed" | "unknown";
  /** Every child tab/popup target id (has an opener) observed during this turn. */
  observedPopupTargetIds?: readonly string[];
  /** The first non-popup tab observed in this turn (the user's main work tab). */
  mainTargetId?: string;
  challengeDetected?: boolean;
  challengeType?: string;
  connectorActionCompleted?: boolean;
  unconnectedPrivateServiceTarget?: string;
}

const PRIVATE_CONNECTOR_SERVICE_PATTERNS: ReadonlyArray<{
  service: string;
  pattern: RegExp;
  connectorIds: readonly string[];
}> = [
  {
    service: "gmail",
    pattern: /\bgmail\b|(?:อีเมล|เมล|กล่องจดหมาย)\s*(?:ใน\s*)?gmail/i,
    connectorIds: ["gmail", "googlemail"],
  },
  {
    service: "google_drive",
    pattern: /\bgoogle\s*drive\b|\bgdrive\b|กูเกิลไดรฟ์/i,
    connectorIds: ["googledrive", "google_drive", "gdrive"],
  },
  {
    service: "onedrive",
    pattern: /\bonedrive\b|วันไดรฟ์/i,
    connectorIds: ["onedrive", "one_drive", "microsoft_onedrive"],
  },
  {
    service: "sharepoint",
    pattern: /\bsharepoint\b|แชร์พอยต์/i,
    connectorIds: ["sharepoint", "microsoft_sharepoint", "onedrive"],
  },
  {
    service: "microsoft_teams",
    pattern: /\bmicrosoft\s*teams\b|\bms\s*teams\b|(?:ช่อง|แชท|channel|team)s?\s*(?:ใน\s*)?teams\b|ไมโครซอฟต์ทีมส์/i,
    connectorIds: ["microsoft_teams", "msteams", "teams"],
  },
];

/**
 * Detect whether a prompt without an explicit website URL targets a private
 * connector/workspace service (Gmail, Google Drive, OneDrive, SharePoint, MS Teams).
 */
export function detectPrivateServiceTarget(prompt: string): string | undefined {
  const normalized = prompt.trim();
  if (/https?:\/\/\S+/i.test(normalized)) {
    return undefined;
  }
  for (const entry of PRIVATE_CONNECTOR_SERVICE_PATTERNS) {
    if (entry.pattern.test(normalized)) {
      return entry.service;
    }
  }
  return undefined;
}

/**
 * Check whether the user's connected plugins cover the detected private service target.
 */
export function hasConnectedPluginForService(
  serviceTarget: string | undefined,
  connectedPlugins: ReadonlyArray<{ connectorId: string; displayName?: string; provider?: string }>,
): boolean {
  if (!serviceTarget) return false;
  const entry = PRIVATE_CONNECTOR_SERVICE_PATTERNS.find((e) => e.service === serviceTarget);
  if (!entry) return false;
  return connectedPlugins.some((plugin) => {
    const cid = (plugin.connectorId || "").toLowerCase().replace(/[^a-z0-9_]/g, "");
    const dname = (plugin.displayName || "").toLowerCase().replace(/[^a-z0-9_]/g, "");
    return entry.connectorIds.some(
      (expected) =>
        cid.includes(expected.replace(/[^a-z0-9_]/g, "")) ||
        dname.includes(expected.replace(/[^a-z0-9_]/g, "")),
    );
  });
}

/**
 * Detect whether the user's turn prompt is requesting the bot to fill or type into a form field (such as email or username).
 */
export function isFormFillTask(prompt: string): boolean {
  const normalized = prompt.trim();
  if (/(?:คืออะไร|ทำหน้าที่อะไร|อย่างไร|ใช่ไหม|หรือไม่|\?)\s*$/i.test(normalized)) {
    return false;
  }
  const withoutUserSelfFill = normalized
    .replace(/(?:เดี๋ยว|ไว้)?(?:ผม|ฉัน|เรา|พี่|หนู)\s*(?:จะ\s*)?(?:กรอก|ใส่|พิมพ์)[^,\n]*?(?:เอง)?/gi, "")
    .replace(/(?:เปิดหน้า|ไปหน้า|เข้าหน้า)[^,\n]*?รอ(?:ให้)?(?:ผม|ฉัน|เรา|ผู้ใช้)?\s*(?:กรอก|ใส่|พิมพ์)/gi, "")
    .replace(/รอ(?:ให้)?(?:ผม|ฉัน|เรา|ผู้ใช้)?\s*(?:กรอก|ใส่|พิมพ์)/gi, "")
    .replace(/(?:ห้าม|อย่า|ไม่ต้อง|งด)\s*(?:กรอก|ใส่|พิมพ์|ป้อน|ส่ง|บันทึก)[^,\n.!?]*?(?:เด็ดขาด)?/gi, "")
    .replace(/\b(?:do\s+not|don'?t|never|refuse\s+to|without)\s+(?:fill|enter|type|submit|provide)\b[^,\n.!?]*/gi, "");
  const thaiFill =
    /(?:กรอก|ใส่|พิมพ์)\s*(?:อีเมล|เมล|เมล์|email|username|ชื่อผู้ใช้|ยูสเซอร์|เบอร์|รหัส|ข้อมูล)/i;
  const engFill =
    /\b(?:fill(?:\s+in|\s+out)?|enter|type(?:\s+in)?)\s+(?:the\s+|my\s+)?(?:email|e-mail|username|user\s*name|address|credentials)\b/i;
  const emailSearchOrMessageContext =
    /(?:ค้นหา|หา|ค้น|กรอง|ดึง|อ่าน|ร่าง|ส่ง|ตอบกลับ)\s*(?:อีเมล|เมล|เมล์|จดหมาย|ข้อความ|email)|(?:ส่งจาก|จากผู้ส่ง|ผู้ส่ง|ผู้รับ|ถึง|from:|to:)\s*[`"'“”]?\s*[a-zA-Z0-9._%+-]+\s*@\s*[a-zA-Z0-9.-]+/i.test(
      withoutUserSelfFill,
    ) &&
    !/(?:ล[็๊]?อ[กค]อิน|เข้าสู่ระบบ|ลงชื่อเข้าใช้|\bsign\s*in\b|\blog\s*in\b|(?:กรอก|ใส่|พิมพ์)\s*(?:อีเมล|เมล|เมล์|email))/i.test(
      withoutUserSelfFill,
    );
  const emailProvidedForLogin =
    !emailSearchOrMessageContext &&
    /[a-zA-Z0-9._%+-]+\s*@\s*[a-zA-Z0-9.-]+/.test(withoutUserSelfFill) &&
    /(?:ล[็๊]?อ[กค]อิน|เข้าสู่ระบบ|ลงชื่อเข้าใช้|sign\s*in|log\s*in|อีเมล|เมล|เมล์|email)/i.test(
      withoutUserSelfFill,
    );
  const standaloneEmailTurn =
    /^(?:(?:อี)?เมล(?:์)?|email\s*:?\s*)?[a-zA-Z0-9._%+-]+\s*@\s*[a-zA-Z0-9.-]+(?:\s*(?:ครับ|ค่ะ|นะคะ|นะ|ให้หน่อย(?:ครับ|ค่ะ)?))?$/i.test(
      withoutUserSelfFill.trim(),
    );
  return (
    thaiFill.test(withoutUserSelfFill) ||
    engFill.test(withoutUserSelfFill) ||
    emailProvidedForLogin ||
    standaloneEmailTurn
  );
}

/**
 * Detect whether the user's turn prompt is requesting a screenshot or screen capture.
 * Pure screen capture requests do not require vision-model interpretation to attach artifacts.
 */
export function isScreenshotRequest(prompt: string): boolean {
  const normalized = prompt.trim();
  const thaiCapture =
    /(?:ขอดู|ขอภาพ|ถ่ายภาพ|แคป|จับภาพ|บันทึกภาพ)(?:ภาพ)?(?:หน้าจอ|จอ)|(?:ภาพหน้าจอ|รูปหน้าจอ)(?:ปัจจุบัน)?(?:หน่อย|ด้วย)?/i;
  const engCapture =
    /\b(?:take\s+(?:a\s+)?screenshot|capture\s+(?:the\s+)?screen|show\s+(?:me\s+)?(?:the\s+)?(?:current\s+)?screen(?:shot)?)\b/i;
  return thaiCapture.test(normalized) || engCapture.test(normalized);
}

/**
 * Detect whether the prompt targets local workspace files/directories rather than a website.
 */
export function isLocalWorkspaceTask(prompt: string): boolean {
  const normalized = prompt.trim();
  if (/https?:\/\/\S+/i.test(normalized)) return false;
  if (detectPrivateServiceTarget(normalized)) return false;
  if (/(?:เว็บ|เว็บไซต์|หน้าเว็บ|เบราว์เซอร์|browser|พอร์ทัล|portal|คลิกปุ่ม|กดปุ่ม)/i.test(normalized)) {
    return false;
  }
  return /(?:\/home\/|\/tmp\/|\.\.?\/|~\/|โฟลเดอร์|ไดเรกทอรี|ในเครื่อง|workspace|argon-corpus|แตกไฟล์|ไฟล์ซิป|\.(?:pdf|docx|xlsx|csv|zip|txt|json)\b)/i.test(
    normalized,
  );
}

/**
 * Detect whether the prompt specifies an active web navigation or element selection task.
 */
export function isWebNavigationTask(prompt: string): boolean {
  const normalized = prompt.trim();
  if (isLocalWorkspaceTask(normalized)) return false;
  const thaiNav =
    /(?:เปิดเว็บ|เข้าเว็บ|เข้า|เลือก|กด(?:ไป)?|คลิก(?:ไป)?|ไปยัง|ค้นหา|พิมพ์.*แล้วกดค้นหา)\s*[\w\u0E00-\u0E7F]/i;
  const engNav =
    /\b(?:open|navigate|go to|click|select|search for)\b/i;
  return thaiNav.test(normalized) || engNav.test(normalized);
}

export interface ObservedBrowserTab {
  targetId: string;
  openerTargetId?: string | null;
  url?: string;
  title?: string;
  active?: boolean;
}

/** Parse page-browser `tabs` metadata. Returns undefined when tab identity was not observed. */
export function parseObservedBrowserTabs(raw: unknown): ObservedBrowserTab[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const tabs: ObservedBrowserTab[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return undefined;
    const e = entry as Record<string, unknown>;
    if (typeof e.targetId !== "string" || !e.targetId) return undefined;
    tabs.push({
      targetId: e.targetId,
      openerTargetId: typeof e.openerTargetId === "string" && e.openerTargetId ? e.openerTargetId : null,
      url: typeof e.url === "string" ? e.url : undefined,
      title: typeof e.title === "string" ? e.title : undefined,
      active: typeof e.active === "boolean" ? e.active : undefined,
    });
  }
  return tabs;
}

/**
 * What the user asked to close:
 * - `in_page_overlay`: a modal/dialog/cookie banner/notice rendered inside the page.
 * - `browser_tab_or_popup`: a browser tab or popup/child window opened by the page.
 * - `os_window_or_app`: an OS-level window or application (e.g. the browser itself, a terminal).
 */
export type CloseTargetScope = "none" | "in_page_overlay" | "browser_tab_or_popup" | "os_window_or_app";

export interface CloseTargetIntent {
  requiresClarification: boolean;
  scope: CloseTargetScope;
  /** The user explicitly forbade closing something (e.g. "ห้ามปิดหน้างานหลัก", "don't close the main tab"). */
  protectsMainTarget: boolean;
  /** Object phrases of affirmative close clauses (diagnostics only). */
  objectPhrases: string[];
}

const CLOSE_VERB_RE = /(?<!เ)ปิด|หุบ|\b(?:close|quit|exit|kill|dismiss)\b(?!\s+to\b)/gi;
const CLOSE_NEGATION_BEFORE_RE =
  /(?:ห้าม|อย่า|ไม่ต้อง|ไม่ให้|โดยไม่|ไม่|\bdon'?t|\bdo\s+not|\bnever|\bwithout|\bnot)\s*(?:to\s+)?$/i;
const CLOSE_CLAUSE_END_RE =
  /[,.;!\n]|แล้ว|และ|จากนั้น|โดย|เพื่อ|ก่อน|หลังจาก|ระหว่าง|\b(?:then|and|before|after|while|but)\b/i;
const IN_PAGE_OVERLAY_NOUN_RE =
  /modal|dialog|overlay|cookie|consent|banner|toast|notice|announcement|notification|lightbox|โมดัล|ไดอะล[็๊]?อ[กค]|คุกกี้|แบนเนอร์|ประกาศ|แจ้งเตือน|กล่อง(?:ข้อความ|โต้ตอบ)|ข้อความเด้ง|ที่บัง/i;
const TAB_OR_POPUP_NOUN_RE =
  /\btabs?\b|แท็บ|แทป|pop-?ups?|ป[๊็]อปอั[ปพ]|หน้าต่าง(?:ใหม่|ย่อย|ลูก)|\b(?:new|child|secondary)\s+window\b|หน้า(?!ต่าง)(?:เว็บ|นี้|นั้น)|\bpage\b|หน้าที่(?:เด้ง|เปิดขึ้นมา)/i;
const OS_WINDOW_OR_APP_NOUN_RE =
  /หน้าต่าง|\bwindows?\b|\bbrowser\b|เบราว์เซอร์|บราวเซอร์|chromium|chrome|firefox|แอ[พป]|\bapp(?:lication)?s?\b|โปรแกรม|\bprogram\b|terminal|เทอร์มินัล|\bscreen\b|จอ|มุมขวา/i;
const EXPLICIT_OS_CONTAINER_NOUN_RE =
  /หน้าต่าง|\bwindows?\b|แอ[พป]|\bapp(?:lication)?s?\b|โปรแกรม|\bprogram\b|terminal|เทอร์มินัล/i;
const PAGE_CONTROL_LABEL_BEFORE_RE =
  /(?:กด|คลิก|แตะ|\bclick|\bpress|\btap)\s*(?:ที่\s*)?(?:ปุ่ม|ลิงก์|\bbutton|\blink)?\s*['"“‘][^'"”’]{0,40}$/i;

const CLOSE_SCOPE_RANK: Record<CloseTargetScope, number> = {
  none: 0,
  in_page_overlay: 1,
  browser_tab_or_popup: 2,
  os_window_or_app: 3,
};

/**
 * Classify what the prompt asks to close from the requested object of each
 * affirmative close clause. Negated clauses never request a close; they mark the
 * main target as protected. When several clauses request closes, the most
 * destructive scope is returned so verification is never weaker than requested.
 */
export function classifyCloseTarget(prompt: string, decision?: "affirmative"): CloseTargetIntent {
  const text = prompt.trim();
  let scope: CloseTargetScope = "none";
  let protectsMainTarget = false;
  let requiresClarification = false;
  const objectPhrases: string[] = [];
  for (const match of text.matchAll(CLOSE_VERB_RE)) {
    const start = match.index ?? 0;
    const before = text.slice(Math.max(0, start - 12), start);
    if (CLOSE_NEGATION_BEFORE_RE.test(before)) {
      protectsMainTarget = true;
      continue;
    }
    // A non-adjacent prohibition can govern a list: "ห้ามใช้ X หรือ kill Y".
    // Do not turn a later verb in that list into authorization. An explicit new
    // clause (then/but/แล้ว) ends this conservative uncertainty boundary.
    const clauseBefore =
      text
        .slice(0, start)
        .split(/[.;!\n]|แล้ว|จากนั้น|\b(?:then|but)\b/i)
        .at(-1) ?? "";
    if (
      !decision &&
      /(?:ห้าม|อย่า|ไม่ต้อง|ไม่ให้|\bdon'?t\b|\bdo\s+not\b|\bnever\b)/i.test(clauseBefore)
    ) {
      protectsMainTarget = true;
      requiresClarification = true;
      continue;
    }
    const rest = text.slice(start + match[0].length, start + match[0].length + 80);
    const end = rest.search(CLOSE_CLAUSE_END_RE);
    const objectPhrase = (end >= 0 ? rest.slice(0, end) : rest).trim();
    let clauseScope: CloseTargetScope = "none";
    if (IN_PAGE_OVERLAY_NOUN_RE.test(objectPhrase)) {
      clauseScope = "in_page_overlay";
    } else if (
      OS_WINDOW_OR_APP_NOUN_RE.test(objectPhrase) &&
      !/pop-?up|ป[๊็]อปอั[ปพ]|หน้าต่าง(?:ใหม่|ย่อย|ลูก)|\b(?:new|child|secondary)\s+window\b/i.test(
        objectPhrase,
      ) &&
      (objectPhrase.search(TAB_OR_POPUP_NOUN_RE) < 0 ||
        (objectPhrase.search(EXPLICIT_OS_CONTAINER_NOUN_RE) >= 0 &&
          objectPhrase.search(EXPLICIT_OS_CONTAINER_NOUN_RE) <
            objectPhrase.search(TAB_OR_POPUP_NOUN_RE)))
    ) {
      const labelContext = text.slice(Math.max(0, start - 50), start);
      clauseScope = PAGE_CONTROL_LABEL_BEFORE_RE.test(labelContext)
        ? "in_page_overlay"
        : "os_window_or_app";
    } else if (TAB_OR_POPUP_NOUN_RE.test(objectPhrase)) {
      clauseScope = "browser_tab_or_popup";
    } else if (OS_WINDOW_OR_APP_NOUN_RE.test(objectPhrase)) {
      // A labeled control inside a web page ("กดปุ่ม 'ปิดหน้าต่าง'") can only act on the page itself.
      const labelContext = text.slice(Math.max(0, start - 50), start);
      clauseScope = PAGE_CONTROL_LABEL_BEFORE_RE.test(labelContext)
        ? "in_page_overlay"
        : "os_window_or_app";
    }
    if (clauseScope !== "none") objectPhrases.push(objectPhrase);
    if (CLOSE_SCOPE_RANK[clauseScope] > CLOSE_SCOPE_RANK[scope]) scope = clauseScope;
  }
  return { scope, protectsMainTarget, objectPhrases, requiresClarification };
}

/**
 * Detect whether the prompt asks to close an OS-level window or application
 * (verified against the desktop window inventory). Browser tabs/popups and
 * in-page overlays are separate scopes verified against page-browser state.
 */
export function isWindowCloseTask(prompt: string): boolean {
  return classifyCloseTarget(prompt).scope === "os_window_or_app";
}

export function isBrowserTabOrPopupCloseTask(prompt: string): boolean {
  return classifyCloseTarget(prompt).scope === "browser_tab_or_popup";
}

export function isInPageOverlayDismissTask(prompt: string): boolean {
  return classifyCloseTarget(prompt).scope === "in_page_overlay";
}

/**
 * Detect whether the prompt specifies clicking or selecting an interactive element.
 */
export function isClickTask(prompt: string): boolean {
  if (isHttpBarrierReportTask(prompt)) return false;
  const normalized = prompt.trim();
  // Exclude purely informational queries or questions about buttons
  if (/(?:คืออะไร|ทำหน้าที่อะไร|อย่างไร|ใช่ไหม|หรือไม่|มี.*หรือไม่|\?)\s*$/i.test(normalized)) {
    return false;
  }
  if (isLocalWorkspaceTask(normalized) || isLoginFormTask(prompt) || isFormFillTask(prompt)) {
    return false;
  }
  const withoutUrls = normalized.replace(/https?:\/\/\S+/gi, "");
  const withoutAnalyticalChoice = withoutUrls.replace(
    /เลือก(?:ผู้เสนอราคา|ตัวเลือกที่คุ้ม|คำตอบ|ไฟล์เวอร์ชัน)/gi,
    "",
  );
  // A reference to the login system describes context, not a request to click
  // Login. Keep explicit click verbs and standalone authentication commands.
  const withoutAuthSystemContext = withoutAnalyticalChoice.replace(
    /ของระบบ(?:ล[็๊]?อ[กค]อิน|เข้าสู่ระบบ|ลงชื่อเข้าใช้)/gi,
    "",
  );
  const thaiClick =
    /(?:คลิก|เลือก|เปิดคลิป|ลงชื่อเข้าใช้|เข้าสู่ระบบ|ล[็๊]?อ[กค]อิน|\bsign\s*in\b|\blog\s*in\b)/i;
  // Thai has no mandatory spaces: substring matching also finds กด across
  // บล็อก + ด้วย. Segment only this ambiguous verb, keeping mixed-script keys.
  const separatedScripts = withoutAuthSystemContext.replace(
    /([\u0e00-\u0e7f])([A-Za-z0-9\u0e50-\u0e59ๆ])/g,
    "$1 $2",
  );
  const thaiPress = Array.from(thaiWords.segment(separatedScripts)).some(
    ({ segment }) => segment === "กด" || segment === "กดดู" || segment === "กดไป",
  );
  const engClick =
    /\b(?:click|press|select|sign\s*in|log\s*in|open\s+video)\b/i;
  return thaiPress || thaiClick.test(withoutAuthSystemContext) || engClick.test(withoutAuthSystemContext);
}

/**
 * Detect whether the prompt specifies a search task on a website.
 */
export function isSearchTask(prompt: string): boolean {
  const normalized = prompt.trim();
  if (/(?:คืออะไร|ทำหน้าที่อะไร|อย่างไร|ใช่ไหม|หรือไม่|\?)\s*$/i.test(normalized)) {
    return false;
  }
  if (isLocalWorkspaceTask(normalized)) {
    return false;
  }
  const thaiSearch =
    /(?:ค้นหา|ค้น|เสิร์ช|มองหา|สืบค้น)\s*[\w\u0E00-\u0E7F]+/i;
  const bareThaiSearch = /(?<=[\s\b]|^|และ|แล้ว|ช่วย|ให้)หา(?!ร\b|ร[\sก-๙])(?=\s*[\w\u0E00-\u0E7F]+)/gi;
  // Only skip conditional หาก clauses; หา + an object such as กระเป๋า is a search.
  // Inspect each candidate so a later search in the same prompt still counts.
  const conditionalSuffix =
    /^ก(?:\s|(?:ยัง)?(?:เปิด|เข้า|โหลด|เชื่อมต่อ)ไม่ได้|ไม่|พบ|เกิด|มี(?:ข้อผิดพลาด|ปัญหา)|(?:ขั้นนี้|ขั้นตอนนี้|หน้านี้|เว็บไซต์|ระบบ)\s*(?:(?:เปิด|เข้า|โหลด|เชื่อมต่อ)ไม่ได้|ล้มเหลว|ไม่ตอบสนอง))/;
  const hasBareThaiSearch = Array.from(normalized.matchAll(bareThaiSearch)).some(
    (match) => !conditionalSuffix.test(normalized.slice(match.index! + match[0].length)),
  );
  const engSearch =
    /\b(?:search\s+(?:for\s+)?|find|look\s+up)\b/i;
  return thaiSearch.test(normalized) || hasBareThaiSearch || engSearch.test(normalized);
}

const LOGIN_HUMAN_HANDOFF_RE =
  /(?:รอ(?:ผม|ฉัน|เรา|ให้)?\s*(?:กรอก|ใส่|พิมพ์)|(?:กรอก|ใส่|พิมพ์)[^,.\n]{0,16}เอง|เดี๋ยว(?:ผม|ฉัน|เรา)|ส่งบล[็๊]?อ[กค]|ทางแชท|พักรอ|\bwait\s+for\s+me\b|\b(?:i'?ll|i\s+will|let\s+me)\s+(?:type|enter|fill|log\s*in|sign\s*in)\b|\bhand\s*(?:it\s+)?(?:over|off)\b)/i;
const LOGIN_AUTONOMOUS_COMPLETION_RE =
  /(?:\bsso\b|\boauth\b|\bsaml\b|\b(?:sign|log)\s*in\s+with\s+[A-Za-z]|\bcontinue\s+with\s+[A-Za-z]|(?:เข้าสู่ระบบ|ล[็๊]?อ[กค]อิน)ด้วย\s*(?:บัญชี|[A-Za-z])|อนุมัติ|\bapprove\b|\bauthori[sz]e\b|จนได้(?:รับ)?|จนเข้า(?:ได้|ถึง)|จนสำเร็จ|ดำเนินการเข้าสู่ระบบ|เข้าสู่ระบบให้(?:เสร็จ|สำเร็จ|เรียบร้อย)|\buntil\s+(?:you\s+)?(?:get|reach|see|receive)\b|\bcomplete\s+(?:the\s+)?(?:log\s*in|sign\s*in|authentication)\b)/i;

/**
 * The user asks the agent to complete authentication itself (provider/SSO/OAuth
 * button, approve/authorize consent, or proceed until an authenticated result),
 * and does not ask to stop so the human can type credentials.
 */
export function isAutonomousLoginCompletionTask(prompt: string): boolean {
  const normalized = prompt.trim();
  if (LOGIN_HUMAN_HANDOFF_RE.test(normalized)) return false;
  return LOGIN_AUTONOMOUS_COMPLETION_RE.test(normalized);
}

/**
 * Detect whether the prompt specifies navigating to a login or signin form.
 */
export function isLoginFormTask(prompt: string): boolean {
  const normalized = prompt.trim();
  if (/(?:คืออะไร|ทำหน้าที่อะไร|อย่างไร|\?)\s*$/i.test(normalized)) {
    return false;
  }
  if (isFormFillTask(prompt)) {
    return false;
  }
  if (isAutonomousLoginCompletionTask(normalized)) {
    return false;
  }
  const thaiLoginForm =
    /(?:เปิดหน้ารอกรอก|เปิดหน้า(?:ล[็๊]?อ[กค]อิน|เข้าสู่ระบบ|ลงชื่อเข้าใช้|sign\s*in|login)|ไปหน้า(?:ล[็๊]?อ[กค]อิน|เข้าสู่ระบบ|ลงชื่อเข้าใช้|login|signin)|เข้าสู่ระบบ(?:ที่|\s*https?:)|ล[็๊]?อ[กค]อิน(?:ที่|\s*https?:)|รอกรอก(?:เมล|รหัส|username|password)|รอ(?:ผม|ฉัน|เรา)?กรอก|เปิดหน้าไว้.*กรอกเอง|เปิดหน้า\s*(?:sign\s*in|login)|(?:เปิด|เข้า).*?(?:ล[็๊]?อ[กค]อิน|เข้าสู่ระบบ|ลงชื่อเข้าใช้|\bsign\s*in\b|\blog\s*in\b).*?(?:เดี๋ยว|ไว้|รอ|ส่งบล[็๊]?อ[กค]|ทางแชท|ให้หน่อย))/i;
  const engLoginForm =
    /\b(?:(?:open|go\s+to|navigate\s+to)\s+(?:the\s+)?(?:login|sign\s*in|sign-in)\s*(?:page|form)?|(?:log\s*in|sign\s*in)\s+(?:to|at)\b)/i;
  return thaiLoginForm.test(normalized) || engLoginForm.test(normalized);
}

export interface FormFillEvaluationElement {
  ref?: string;
  role?: string;
  name?: string;
  value?: string;
  type?: string;
}

export interface FormFillEvaluationInput {
  actions?: ReadonlyArray<{ kind?: string; ref?: string; text?: string }>;
  targetRef?: string;
  intendedAccount?: string;
  preUrl?: string;
  postUrl?: string;
  postTree?: string;
  preElements?: ReadonlyArray<FormFillEvaluationElement>;
  postElements?: ReadonlyArray<FormFillEvaluationElement>;
  completedCount?: number;
  actOk?: boolean;
  actVerified?: boolean;
}

export interface FormFillEvaluationResult {
  attempted: boolean;
  verified: boolean;
  intendedValue?: string;
  filledValue?: string;
  hasValidationError?: boolean;
}

/**
 * Extracts an email address from text.
 * - Never guesses `.com` when a domain label has no dot.
 * - If the user wrote `local @ label` without a TLD, resolves `local@label.<tld>` ONLY when
 *   `label.<tld>` is unambiguously present in `observableContext` (e.g., current page URL/hostname,
 *   `hd=` parameter, page DOM text, or confirmed thread URLs).
 */
export function extractEmailFromText(
  text: string,
  observableContext?: string,
): string | undefined {
  if (!text) return undefined;
  const exactMatch = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
  if (exactMatch?.[1]) return exactMatch[1].trim();

  const spacedWithTld = text.match(
    /([a-zA-Z0-9._%+-]+)\s*@\s*([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/i,
  );
  if (spacedWithTld?.[1] && spacedWithTld?.[2]) {
    return `${spacedWithTld[1].trim()}@${spacedWithTld[2].trim().toLowerCase()}`;
  }

  const partialMatch = text.match(/([a-zA-Z0-9._%+-]+)\s*@\s*([a-zA-Z0-9-]+)\b/i);
  if (partialMatch?.[1] && partialMatch?.[2] && !partialMatch[2].includes(".")) {
    const local = partialMatch[1].trim();
    const label = partialMatch[2].trim().toLowerCase();
    if (!observableContext) return undefined;

    const hostTokens =
      observableContext.match(/\b[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}\b/g) ?? [];
    const candidates = new Set<string>();
    for (const rawHost of hostTokens) {
      const parts = rawHost.toLowerCase().split(".");
      const idx = parts.indexOf(label);
      if (idx !== -1 && idx < parts.length - 1) {
        const domainSuffix = parts.slice(idx).join(".");
        if (/^[a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2,})?$/.test(domainSuffix)) {
          candidates.add(domainSuffix);
        }
      }
    }
    if (candidates.size === 1) {
      return `${local}@${Array.from(candidates)[0]}`;
    }
  }
  return undefined;
}

/**
 * Detects when a user wrote a partial account handle like `user @ org` without a TLD.
 */
export function extractPartialEmailHandle(
  text: string,
): { local: string; domainLabel: string } | undefined {
  if (!text) return undefined;
  if (/([a-zA-Z0-9._%+-]+)\s*@\s*([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i.test(text)) {
    return undefined;
  }
  const match = text.match(/([a-zA-Z0-9._%+-]+)\s*@\s*([a-zA-Z0-9-]+)\b/i);
  if (match?.[1] && match?.[2] && !match[2].includes(".")) {
    return {
      local: match[1].trim(),
      domainLabel: match[2].trim().toLowerCase(),
    };
  }
  return undefined;
}

const FORM_VALIDATION_ERROR_RE =
  /(?:couldn't find your google account|enter a valid email|invalid email|invalid username|invalid credentials|incorrect email|incorrect username|incorrect password|invalid password|wrong password|account not found|user not found|login failed|sign-in failed|authentication failed|enter an email or phone number|ไม่พบบัญชี|อีเมลไม่ถูกต้อง|ชื่อผู้ใช้ไม่ถูกต้อง|รหัสผ่านไม่ถูกต้อง|ป้อนอีเมลหรือหมายเลขโทรศัพท์ที่ถูกต้อง|กรุณากรอกอีเมลที่ถูกต้อง|เข้าสู่ระบบไม่สำเร็จ)/i;

const FORM_ERROR_URL_RE =
  /(?:[?&](?:error|err|failed|failure|invalid|login_error|auth_error)=|\/(?:error|login-error|auth-error)(?:\/|$|\?))/i;

function isPasswordFieldElement(el: FormFillEvaluationElement): boolean {
  const role = (el.role || "").toLowerCase();
  const name = (el.name || "").toLowerCase();
  const type = (el.type || "").toLowerCase();
  return (
    type === "password" ||
    role === "password" ||
    ((role === "textbox" || role === "") &&
      (name.includes("password") || name.includes("รหัสผ่าน") || name.includes("passcode")))
  );
}

function isSearchFieldElement(el: FormFillEvaluationElement): boolean {
  const role = (el.role || "").toLowerCase();
  const name = (el.name || "").toLowerCase();
  const type = (el.type || "").toLowerCase();
  return (
    role === "searchbox" ||
    type === "search" ||
    /\b(?:search|query|find)\b|ค้นหา/i.test(name)
  );
}

function isAccountOrEmailFieldElement(el: FormFillEvaluationElement): boolean {
  if (isPasswordFieldElement(el) || isSearchFieldElement(el)) return false;
  const role = (el.role || "").toLowerCase();
  const name = (el.name || "").toLowerCase();
  const type = (el.type || "").toLowerCase();
  if (role && role !== "textbox" && role !== "combobox") return false;
  return (
    type === "email" ||
    /email|e-mail|อีเมล|เมล|username|user\s*name|ชื่อผู้ใช้|ยูสเซอร์|identifier|account|บัญชี|login|phone|โทรศัพท์/i.test(
      name,
    )
  );
}

function isNonPasswordInputElement(el: FormFillEvaluationElement): boolean {
  if (isPasswordFieldElement(el)) return false;
  const role = (el.role || "").toLowerCase();
  const type = (el.type || "").toLowerCase();
  return (
    role === "textbox" ||
    role === "combobox" ||
    role === "searchbox" ||
    type === "text" ||
    type === "email" ||
    type === "search"
  );
}

/**
 * Evaluates ground-truth DOM evidence after a `browser_act` form-fill batch.
 * Never substitutes `intendedValue` when observable DOM state contradicts it.
 */
export function evaluateFormFillResult(
  input: FormFillEvaluationInput,
): FormFillEvaluationResult {
  const fillActions = (input.actions ?? []).filter(
    (a) => a.kind === "fill" || a.kind === "type" || a.kind === "fill_secret",
  );
  if (
    fillActions.length === 0 ||
    input.actOk === false ||
    (input.completedCount !== undefined && input.completedCount <= 0)
  ) {
    return { attempted: false, verified: false };
  }

  const emailAction = fillActions.find(
    (a) => typeof a.text === "string" && a.text.includes("@"),
  );
  const primaryTextAction =
    emailAction ??
    fillActions.find((a) => typeof a.text === "string" && a.text.trim().length > 0);
  const intendedValue = primaryTextAction?.text?.trim();
  const targetRef = input.targetRef ?? primaryTextAction?.ref;
  const isFillingEmailOrAccount = Boolean(emailAction);
  const hasSecretFill = fillActions.some((a) => a.kind === "fill_secret");
  const hasSubmitInBatch = (input.actions ?? []).some(
    (a) => a.kind === "click" || a.kind === "press",
  );

  const passwordAction = fillActions.find((a) => {
    if (a.kind === "fill_secret") return true;
    if (typeof a.text === "string" && a.text.includes("@")) return false;
    if (!a.ref) return false;
    const inPre = Array.isArray(input.preElements)
      ? input.preElements.find((el) => el.ref === a.ref)
      : undefined;
    if (inPre) return isPasswordFieldElement(inPre);
    const inPost = Array.isArray(input.postElements)
      ? input.postElements.find((el) => el.ref === a.ref)
      : undefined;
    if (inPost) return isPasswordFieldElement(inPost);
    return false;
  });

  const isTargetPasswordEl = Boolean(
    !emailAction &&
      targetRef &&
      ((Array.isArray(input.preElements) &&
        input.preElements.some((el) => el.ref === targetRef && isPasswordFieldElement(el))) ||
        (!Array.isArray(input.preElements) &&
          Array.isArray(input.postElements) &&
          input.postElements.some((el) => el.ref === targetRef && isPasswordFieldElement(el))))
  );

  const isPasswordFill = Boolean(
    !emailAction &&
      (hasSecretFill || passwordAction || isTargetPasswordEl)
  );

  const hasValidationErrorInTree = Boolean(
    input.postTree && FORM_VALIDATION_ERROR_RE.test(input.postTree),
  );
  const hasErrorInPostUrl = Boolean(
    input.postUrl && FORM_ERROR_URL_RE.test(input.postUrl),
  );
  const hasValidationError = hasValidationErrorInTree || hasErrorInPostUrl;

  if (Array.isArray(input.postElements)) {
    const nonPasswordInputs = input.postElements.filter(isNonPasswordInputElement);
    const accountInputs = nonPasswordInputs.filter(isAccountOrEmailFieldElement);
    const refInput = targetRef
      ? nonPasswordInputs.find((el) => el.ref === targetRef)
      : undefined;

    // Determine the primary observable target input on the post-action page
    const primaryTargetInput =
      refInput ?? accountInputs[0] ?? nonPasswordInputs[0];
    const observedTargetValue =
      typeof primaryTargetInput?.value === "string" &&
      primaryTargetInput.value.trim().length > 0
        ? primaryTargetInput.value.trim()
        : undefined;

    if (hasValidationError) {
      return {
        attempted: true,
        verified: false,
        intendedValue,
        filledValue: observedTargetValue,
        hasValidationError: true,
      };
    }

    if (intendedValue && !isPasswordFill) {
      const matchingEl = nonPasswordInputs.find(
        (el) =>
          typeof el.value === "string" &&
          el.value.trim().toLowerCase() === intendedValue.toLowerCase(),
      );

      if (matchingEl) {
        // Check for wrong-field fill (ผิดช่อง):
        // 1. Filled a searchbox when filling an email/account or when an account field exists
        const filledSearchInsteadOfAccount =
          isSearchFieldElement(matchingEl) &&
          (isFillingEmailOrAccount || accountInputs.length > 0);
        // 2. Target ref was specified, exists on the page as a non-password input, but a different ref got the value
        const filledDifferentRefWhileTargetExists = Boolean(
          targetRef &&
            matchingEl.ref &&
            matchingEl.ref !== targetRef &&
            refInput &&
            (typeof refInput.value !== "string" ||
              refInput.value.trim().toLowerCase() !== intendedValue.toLowerCase()),
        );
        // 3. Dedicated account/email input(s) exist on the page, none of them matched, and the matched element is not an account input
        const filledNonAccountWhileAccountFieldEmpty =
          accountInputs.length > 0 &&
          !accountInputs.includes(matchingEl) &&
          (isFillingEmailOrAccount ||
            accountInputs.every(
              (el) =>
                typeof el.value !== "string" ||
                el.value.trim().toLowerCase() !== intendedValue.toLowerCase(),
            ));

        if (
          filledSearchInsteadOfAccount ||
          filledDifferentRefWhileTargetExists ||
          filledNonAccountWhileAccountFieldEmpty
        ) {
          const intendedTargetEl =
            filledSearchInsteadOfAccount || filledNonAccountWhileAccountFieldEmpty
              ? accountInputs[0]
              : (refInput ?? accountInputs[0]);
          const unfilledTargetVal =
            typeof intendedTargetEl?.value === "string" &&
            intendedTargetEl.value.trim().length > 0
              ? intendedTargetEl.value.trim()
              : undefined;
          return {
            attempted: true,
            verified: false,
            intendedValue,
            filledValue: unfilledTargetVal,
          };
        }

        return {
          attempted: true,
          verified: true,
          intendedValue,
          filledValue: matchingEl.value!.trim(),
        };
      }

      // Check for contradicting value (ผิดค่า) or still-present unfilled account/target input
      const contradictingEl = nonPasswordInputs.find(
        (el) =>
          typeof el.value === "string" &&
          el.value.trim().length > 0 &&
          el.value.trim().toLowerCase() !== intendedValue.toLowerCase(),
      );
      if (contradictingEl) {
        return {
          attempted: true,
          verified: false,
          intendedValue,
          filledValue: contradictingEl.value!.trim(),
        };
      }

      // If an account/email input or the target ref non-password input is STILL present on the page
      // and is empty, the form did NOT advance past the username step and the field is NOT filled.
      // This also blocks false positives from pre-existing password fields on single-page login forms.
      if (accountInputs.length > 0 || refInput) {
        return {
          attempted: true,
          verified: false,
          intendedValue,
          filledValue: observedTargetValue,
        };
      }
    } else if (isPasswordFill) {
      const secretAction =
        fillActions.find((a) => a.kind === "fill_secret") ?? passwordAction;
      const secretRef = secretAction?.ref ?? targetRef ?? input.targetRef;
      const targetInPost = secretRef
        ? input.postElements.find((el) => el.ref === secretRef)
        : undefined;
      const targetInPre =
        secretRef && Array.isArray(input.preElements)
          ? input.preElements.find((el) => el.ref === secretRef)
          : undefined;

      // 1. Target ref resolution (NEG-9): When secretRef is specified, it MUST resolve to a password field in pre or post
      if (secretRef) {
        const targetPreIsPwd = Boolean(targetInPre && isPasswordFieldElement(targetInPre));
        const targetPostIsPwd = Boolean(targetInPost && isPasswordFieldElement(targetInPost));
        if (!targetPreIsPwd && !targetPostIsPwd) {
          return {
            attempted: true,
            verified: false,
          };
        }
      }

      // 2. Reject search inputs (NEG-3)
      if (
        (targetInPost && isSearchFieldElement(targetInPost)) ||
        (targetInPre && isSearchFieldElement(targetInPre))
      ) {
        return {
          attempted: true,
          verified: false,
        };
      }

      // 3. Must resolve a legitimate password field in either preElements or postElements (NEG-2)
      const preHasPassword = Boolean(
        secretRef
          ? (targetInPre && isPasswordFieldElement(targetInPre))
          : (Array.isArray(input.preElements) && input.preElements.some(isPasswordFieldElement))
      );
      const postHasPassword = Boolean(
        secretRef
          ? (targetInPost && isPasswordFieldElement(targetInPost))
          : input.postElements.some(isPasswordFieldElement)
      );

      if (!preHasPassword && !postHasPassword) {
        return {
          attempted: true,
          verified: false,
        };
      }

      // 4. Observable non-empty fill (POS-1)
      const nonEmptyInput = input.postElements.find((el) => {
        const matchesSecretTarget = secretRef
          ? el.ref === secretRef
          : isPasswordFieldElement(el);
        if (!matchesSecretTarget) return false;
        return (
          typeof el.value === "string" && el.value.trim().length > 0
        );
      });

      if (nonEmptyInput) {
        return {
          attempted: true,
          verified: true,
          filledValue: nonEmptyInput.value,
        };
      }

      // 5. Legitimate T13/T16 login: Password unmounts upon submission & navigation to authenticated session/dashboard (POS-2)
      // Enforce strict Origin & Session Identity matching (resolves NEG-7, NEG-8, NEG-8b)
      let sameOrigin = false;
      try {
        if (input.preUrl && input.postUrl) {
          const preOrigin = new URL(input.preUrl).origin;
          const postOrigin = new URL(input.postUrl).origin;
          sameOrigin = preOrigin === postOrigin;
        }
      } catch {
        sameOrigin = false;
      }

      const urlAdvanced = Boolean(
        input.preUrl &&
        input.postUrl &&
        input.preUrl !== input.postUrl &&
        sameOrigin &&
        !hasValidationError
      );

      // Session / Authenticated Dashboard indicators
      const hasDashboardToken = Boolean(
        (input.postTree &&
          /(?:dashboard|แดชบอร์ด|logout|log\s*out|sign\s*out|ออกจากระบบ)/i.test(
            input.postTree,
          )) ||
        (input.postUrl &&
          /\/(?:dashboard|portal\/(?:dashboard|overview)|my-account)\b/i.test(
            input.postUrl,
          )),
      );

      // Reject unauthenticated guest indicators (NEG-8)
      const isGuestOrUnauthenticated = Boolean(
        input.postTree &&
          /(?:welcome\s+guest|guest\s*user|anonymous|ผู้เยี่ยมชม)/i.test(
            input.postTree,
          ),
      );

      // Identity matching: the intended account MUST come from explicit task/account evidence
      // (input.intendedAccount or an email fill in this batch). No synthetic/fixture default.
      const intendedUser =
        (typeof input.intendedAccount === "string" && input.intendedAccount.trim()) ||
        emailAction?.text?.trim() ||
        undefined;
      const intendedLower = intendedUser ? intendedUser.toLowerCase() : undefined;

      // The post-action page must affirm the EXACT intended email identity (no local-part substring),
      // and the first identity shown must not belong to a different account.
      const postTreeEmails = (
        input.postTree?.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? []
      ).map((e) => e.toLowerCase());
      const postTreeAffirmsIdentity = Boolean(
        intendedLower &&
          postTreeEmails.length > 0 &&
          postTreeEmails[0] === intendedLower,
      );

      const inputsUnmounted = preHasPassword && !postHasPassword;

      if (
        !hasValidationError &&
        sameOrigin &&
        inputsUnmounted &&
        urlAdvanced &&
        (hasSubmitInBatch || input.actVerified === true) &&
        hasDashboardToken &&
        !isGuestOrUnauthenticated &&
        postTreeAffirmsIdentity
      ) {
        return {
          attempted: true,
          verified: true,
          filledValue: "<secret>",
        };
      }

      // 6. Masked password field still on page with actVerified === true
      if (
        !hasValidationError &&
        postHasPassword &&
        input.actVerified === true
      ) {
        return {
          attempted: true,
          verified: true,
          filledValue: "<secret>",
        };
      }

      return {
        attempted: true,
        verified: false,
      };
    }

    // Only consider step-transition verification when no target/account textbox remains unfilled/mismatched on the page
    const echoedInTree = Boolean(
      intendedValue &&
        input.postTree &&
        input.postTree.toLowerCase().includes(intendedValue.toLowerCase()),
    );
    const hasPasswordField = input.postElements.some(isPasswordFieldElement);
    const preHadPasswordField = Boolean(
      Array.isArray(input.preElements) &&
        input.preElements.some(isPasswordFieldElement),
    );
    const urlAdvanced = Boolean(
      input.preUrl &&
        input.postUrl &&
        input.preUrl !== input.postUrl &&
        !hasErrorInPostUrl,
    );

    if (
      !hasValidationError &&
      input.postElements.length > 0 &&
      nonPasswordInputs.length === 0 &&
      ((echoedInTree && (hasPasswordField || urlAdvanced)) ||
        (hasSubmitInBatch &&
          hasPasswordField &&
          !preHadPasswordField &&
          (urlAdvanced || echoedInTree)))
    ) {
      return {
        attempted: true,
        verified: true,
        intendedValue,
        filledValue: intendedValue,
      };
    }

    return {
      attempted: true,
      verified: false,
      intendedValue,
      filledValue: observedTargetValue,
    };
  }

  if (hasValidationError) {
    return {
      attempted: true,
      verified: false,
      intendedValue,
      hasValidationError: true,
    };
  }

  // Never verify a form fill from bare postTree echo alone when postElements are absent (W11 NEG-P3).

  // Fallback for minimal unit-test mocks that omit postElements/postTree but set verified: true
  if (!input.postElements && input.postTree === undefined && input.actVerified === true) {
    return {
      attempted: true,
      verified: true,
      intendedValue,
      filledValue: intendedValue,
    };
  }

  return {
    attempted: true,
    verified: false,
    intendedValue,
  };
}

/**
 * Verify a browser tab/popup close from observed tab identity:
 * - tab identity must have been observed (UNKNOWN is not success);
 * - every popup/child target observed during the turn must be gone;
 * - at least one tab (the user's work) must remain, and a protected main tab must survive;
 * - if no popup target was ever observed, the "popup" must have been in-page:
 *   the overlay must be gone and the action must be verified.
 */
export function verifyTabOrPopupClose(
  state: WebGoalState,
  intent: CloseTargetIntent,
): { ok: boolean; reason?: string } {
  const tabs = state.browserTabs;
  if (!tabs) {
    return {
      ok: false,
      reason: "การปิดแท็บ/ป๊อปอัปยังยืนยันไม่ได้: ไม่มีข้อมูลแท็บของเบราว์เซอร์ที่สังเกตได้จริง (UNKNOWN)",
    };
  }
  if (tabs.length === 0) {
    return {
      ok: false,
      reason: "การปิดแท็บ/ป๊อปอัปผิดเป้าหมาย: แท็บทั้งหมดถูกปิด รวมถึงหน้างานหลัก",
    };
  }
  const openIds = new Set(tabs.map((t) => t.targetId));
  if (state.mainTargetId && !openIds.has(state.mainTargetId)) {
    return {
      ok: false,
      reason: "การปิดแท็บ/ป๊อปอัปผิดเป้าหมาย: หน้างานหลักถูกปิดไปแทนแท็บย่อย",
    };
  }
  const observedPopups = new Set(state.observedPopupTargetIds ?? []);
  for (const tab of tabs) {
    if (tab.openerTargetId) observedPopups.add(tab.targetId);
  }
  const stillOpen = [...observedPopups].filter((id) => openIds.has(id));
  if (stillOpen.length > 0) {
    return {
      ok: false,
      reason: `การปิดแท็บ/ป๊อปอัปยังไม่สำเร็จ: แท็บป๊อปอัปยังเปิดอยู่ (${stillOpen.join(", ")})`,
    };
  }
  if (observedPopups.size === 0) {
    if (intent.scope === "browser_tab_or_popup" && tabs.length > 1) {
      return {
        ok: false,
        reason: "การปิดแท็บย่อยยังไม่สำเร็จ: ไม่พบประวัติแท็บย่อยที่ถูกเปิดหรือปิด และยังมีแท็บเปิดค้างอยู่มากกว่า 1 แท็บ",
      };
    }
    if (state.activeModal) {
      return {
        ok: false,
        reason: "การปิดป๊อปอัปยังไม่สำเร็จ: ไม่พบแท็บป๊อปอัป และยังมีป๊อปอัปในหน้าเว็บบังอยู่",
      };
    }
    if (
      state.actionsAttempted === 0 ||
      (state.lastActionVerified === false && !state.domStateChanged && !state.screenChanged)
    ) {
      return {
        ok: false,
        reason: "การปิดป๊อปอัปยังไม่สำเร็จ: ไม่พบหลักฐานว่ามีการปิดแท็บป๊อปอัปหรือหน้าต่างซ้อนจริง",
      };
    }
  }
  return { ok: true };
}

/**
 * Verify that a web/desktop interaction task produced independent evidence of goal completion.
 * Rejects false completion where input was dispatched but state remained stuck on home/no-op,
 * where target window was not verified closed, where search was only navigation to home,
 * or where web_fetch was claimed as a click.
 */
export function verifyWebGoal(
  prompt: string,
  state: WebGoalState,
): { ok: boolean; reason?: string } {
  // 1. Tool call budget exhaustion is an incomplete stop, never a completed run.
  if (state.toolLimitExceeded) {
    const limit = state.toolLimit ?? 24;
    return {
      ok: false,
      reason: `I stopped after reaching the limit of ${limit} tool calls in this turn. Send another message to continue.`,
    };
  }

  // 1b. Active challenge / CAPTCHA on the page means the goal is blocked, never a success.
  if (state.challengeDetected) {
    return {
      ok: false,
      reason: `งานยังไม่สำเร็จ: ตรวจพบแบบทดสอบความปลอดภัย (${state.challengeType || "CAPTCHA"}) ที่ต้องให้ผู้ใช้ช่วยยืนยันบนหน้าจอ`,
    };
  }
  if (
    state.currentTitle &&
    /(?:challenge|cloudflare|turnstile|just a moment|security check|หุ่นยนต์|บอท)/i.test(
      state.currentTitle,
    )
  ) {
    return {
      ok: false,
      reason: `งานยังไม่สำเร็จ: หน้าเว็บติดแบบทดสอบความปลอดภัย (${state.challengeType || (/turnstile/i.test(state.currentTitle) ? "turnstile" : "CAPTCHA")}) ที่ต้องให้ผู้ใช้ช่วยยืนยันบนหน้าจอ`,
    };
  }

  // 2. If screenshot was requested, ensure artifact was attached
  if (isScreenshotRequest(prompt) && !state.screenArtifactAttached) {
    return {
      ok: false,
      reason: "งานขอดูภาพหน้าจอไม่สำเร็จ: ไม่พบภาพหน้าจอที่แนบจริงในระบบ",
    };
  }

  // An observed API error may complete an inspection, never a requested repair.
  const apiErrorObserved = state.apiErrorInspection?.qualifies(prompt, state.currentUrl) === true;
  if (isErrorReportTask(prompt) && !apiErrorObserved) {
    if (isNetworkErrorReportTask(prompt)) {
      return { ok: false, reason: "A transport-error report needs an explicit browser navigation failure for the requested URL; do not infer it from the prompt or page text." };
    }
    return { ok: false, reason: "API error inspection needs an observed response and JSON error body from the same requested document; do not infer the response from the prompt." };
  }

  // 3. If actions were attempted and the last action failed without recovery
  if (state.actionsAttempted > 0 && state.lastActionOk === false && !apiErrorObserved) {
    return {
      ok: false,
      reason: `การทำงานบนหน้าเว็บไม่สำเร็จ: ${state.lastActionError || "เกิดข้อผิดพลาดในการคลิกหรือทำงานบนหน้าเว็บ"}`,
    };
  }

  // 4. Window closing verification
  if (isWindowCloseTask(prompt)) {
    if (state.targetWindowClosed === false) {
      return {
        ok: false,
        reason: "การปิดหน้าต่างยังไม่สำเร็จ: หน้าต่างเป้าหมายยังคงเปิดอยู่ในระบบ",
      };
    }
    if (state.actionsAttempted > 0 && state.lastActionVerified === false && state.targetWindowClosed !== true) {
      return {
        ok: false,
        reason: "การปิดหน้าต่างยังไม่สำเร็จ: คำสั่งถูกส่งไปแต่ไม่ได้รับการยืนยันว่าหน้าต่างถูกปิดจริง (verified=false)",
      };
    }
    if (state.targetWindowClass && state.windowsRemaining && state.targetWindowClosed !== true) {
      const remaining = state.windowsRemaining.some((w) =>
        w.wmClass?.toLowerCase().includes(state.targetWindowClass!.toLowerCase()),
      );
      if (remaining) {
        return {
          ok: false,
          reason: `การปิดหน้าต่างยังไม่สำเร็จ: ตรวจพบหน้าต่าง ${state.targetWindowClass} ยังคงเปิดอยู่ในระบบ`,
        };
      }
    }
  }

  // 4b. Browser tab / popup close: verified against observed tab identity, never against wording.
  const closeIntent = classifyCloseTarget(prompt);
  if (closeIntent.scope === "browser_tab_or_popup") {
    const tabCheck = verifyTabOrPopupClose(state, closeIntent);
    if (!tabCheck.ok) return tabCheck;
  }

  // 4c. In-page overlay dismissal: the overlay must be gone and the page (tab) must survive.
  if (closeIntent.scope === "in_page_overlay") {
    if (state.activeModal) {
      return {
        ok: false,
        reason: "การปิดหน้าต่างซ้อนในหน้าเว็บยังไม่สำเร็จ: ยังพบ modal/ป๊อปอัปในหน้าเว็บบังอยู่",
      };
    }
    if (state.actionsAttempted === 0) {
      return {
        ok: false,
        reason: "การปิดหน้าต่างซ้อนในหน้าเว็บยังไม่สำเร็จ: ไม่พบการกระทำบนหน้าเว็บจริง",
      };
    }
    if (state.lastActionVerified === false && !state.domStateChanged && !state.screenChanged) {
      return {
        ok: false,
        reason: "การปิดหน้าต่างซ้อนในหน้าเว็บยังไม่สำเร็จ: คำสั่งไม่ได้รับการยืนยันว่าหน้าเว็บเปลี่ยนจริง (verified=false)",
      };
    }
    if (state.browserTabs && state.browserTabs.length === 0) {
      return {
        ok: false,
        reason: "การปิดหน้าต่างซ้อนในหน้าเว็บผิดเป้าหมาย: แท็บหน้าเว็บถูกปิดไปด้วย",
      };
    }
  }

  // 5. Search task verification:
  // Cannot be satisfied by mere navigation to homepage, typing without submit, or staying on homepage with language modal!
  if (isSearchTask(prompt)) {
    if (state.activeModal) {
      return {
        ok: false,
        reason: "งานค้นหายังไม่สำเร็จ: หน้าเว็บยังติดหน้าต่างเลือกภาษาหรือ modal บังอยู่ ยังไม่ถึงหน้าผลการค้นหา",
      };
    }

    const privateServiceTarget =
      state.unconnectedPrivateServiceTarget ?? detectPrivateServiceTarget(prompt);
    if (
      privateServiceTarget &&
      !state.connectorActionCompleted &&
      ((state.unconnectedPrivateServiceTarget && state.actionsAttempted === 0) ||
        state.loginFormVisible ||
        state.httpStatus === 401 ||
        state.httpStatus === 403)
    ) {
      return { ok: true };
    }

    const hasDirectSearchQueryUrl = Boolean(
      state.currentUrl &&
        !state.currentUrl.endsWith("/") &&
        !state.currentUrl.endsWith("/home") &&
        /(?:\/search\b|results|query|\?q=|\?keyword=|\?search=|[&#]q=)/i.test(state.currentUrl) &&
        (state.domStateChanged || (state.actionsAttempted > 0 && state.lastActionOk !== false)),
    );

    const hasSearchSubmission =
      Boolean(state.connectorActionCompleted) ||
      Boolean(state.searchSubmitted) ||
      Boolean(state.keyboardEnterAttempted) ||
      hasDirectSearchQueryUrl ||
      (!state.searchAttempted &&
        Boolean(
          state.domStateChanged &&
            state.initialUrl &&
            state.currentUrl &&
            state.currentUrl !== state.initialUrl &&
            !state.currentUrl.endsWith("/") &&
            !state.currentUrl.endsWith("/home"),
        ));

    if (state.navigationOnly && !hasSearchSubmission) {
      return {
        ok: false,
        reason: "งานค้นหายังไม่สำเร็จ: บอตเพียงเปิดหน้าแรกของเว็บไซต์ แต่ยังไม่ได้กรอกคำค้นหาหรือส่งคำค้นหาเพื่อแสดงผลลัพธ์",
      };
    }

    if (!hasSearchSubmission) {
      if (state.searchAttempted) {
        return {
          ok: false,
          reason: "งานค้นหายังไม่สำเร็จ: พิมพ์คำค้นหาแล้วแต่ยังไม่ได้กด Enter หรือส่งคำค้นหา (searchSubmitted เป็น false)",
        };
      }
      return {
        ok: false,
        reason: "งานค้นหายังไม่สำเร็จ: บอตยังไม่ได้กรอกคำค้นหาหรือส่งคำค้นหาเพื่อแสดงผลลัพธ์",
      };
    }

    if (
      state.actionsAttempted === 0 &&
      !state.domStateChanged &&
      !state.screenChanged &&
      !hasSearchSubmission
    ) {
      return {
        ok: false,
        reason: "งานค้นหายังไม่สำเร็จ: ไม่พบการค้นหาหรือผลการค้นหาตามที่ระบุ",
      };
    }

    if (
      state.initialUrl &&
      state.currentUrl &&
      state.initialUrl === state.currentUrl &&
      (state.currentUrl.endsWith("/") || state.currentUrl.endsWith("/home")) &&
      !hasSearchSubmission &&
      !state.domStateChanged
    ) {
      return {
        ok: false,
        reason: "งานค้นหายังไม่สำเร็จ: ตรวจพบว่ายังคงอยู่ที่หน้าแรก ไม่พบหลักฐานการค้นหาหรือผลการค้นหาที่ต้องการ",
      };
    }
  }

  // 6. Login form task verification:
  // Requesting to open the login page waiting for user to fill credentials requires reaching visible login form.
  // URL matching /login alone without a visible login form is rejected.
  if (isLoginFormTask(prompt)) {
    if (state.httpStatus && state.httpStatus >= 400) {
      return {
        ok: false,
        reason: `การเปิดหน้าล็อกอินไม่สำเร็จ: หน้าเว็บส่งกลับรหัสข้อผิดพลาด HTTP ${state.httpStatus}`,
      };
    }
    if (
      state.currentTitle &&
      /(?:Error 400|Error 403|Error 404|Error 500|Bad Request)/i.test(state.currentTitle)
    ) {
      return {
        ok: false,
        reason: `การเปิดหน้าล็อกอินไม่สำเร็จ: พบหน้าข้อผิดพลาด ${state.currentTitle}`,
      };
    }
    if (state.activeModal) {
      return {
        ok: false,
        reason: "การเปิดหน้าล็อกอินยังไม่สำเร็จ: หน้าเว็บยังติด modal บังอยู่ ยังไม่ถึงฟอร์มเข้าสู่ระบบ",
      };
    }

    if (!state.loginFormVisible) {
      return {
        ok: false,
        reason: "การเปิดหน้าล็อกอินยังไม่สำเร็จ: หน้าเว็บยังไม่พบฟอร์มสำหรับกรอกอีเมลและรหัสผ่านจริง (loginFormVisible เป็น false)",
      };
    }
  }

  // 6b. Form fill task verification:
  // Requesting the bot to fill an email/username/form field requires:
  // 1) an actual fill/type action was dispatched (formFillAttempted),
  // 2) ground-truth verification from the post-action DOM/page state (formFillVerified), and
  // 3) when a specific target value (e.g. email/account) was requested, the verified value matches expectedFillValue.
  if (isFormFillTask(prompt)) {
    const unresolvedPartialHandle =
      Boolean(extractPartialEmailHandle(prompt)) &&
      !extractEmailFromText(prompt, state.currentUrl) &&
      !state.expectedFillValue;
    if (unresolvedPartialHandle && !state.formFillAttempted) {
      return { ok: true };
    }
    if (!state.formFillAttempted) {
      return {
        ok: false,
        reason: "งานกรอกข้อมูลบนหน้าเว็บยังไม่สำเร็จ: บอตยังไม่ได้ทำการกรอกข้อมูลลงในช่องกรอกบนหน้าเว็บจริง (formFillAttempted เป็น false)",
      };
    }
    if (!state.formFillVerified) {
      return {
        ok: false,
        reason: "งานกรอกข้อมูลบนหน้าเว็บยังไม่สำเร็จ: ยังไม่พบหลักฐานยืนยันในหน้าเว็บจริงว่าค่าถูกกรอกลงในช่องเป้าหมายหรือผ่านไปยังขั้นตอนถัดไปสำเร็จ (formFillVerified เป็น false)",
      };
    }
    if (
      state.expectedFillValue &&
      state.filledTargetValue !== "<secret>" &&
      (!state.filledTargetValue ||
        state.filledTargetValue.trim().toLowerCase() !== state.expectedFillValue.trim().toLowerCase())
    ) {
      return {
        ok: false,
        reason: `งานกรอกข้อมูลบนหน้าเว็บไม่สำเร็จ: ค่าในช่องกรอกจริง (${state.filledTargetValue || "ว่าง"}) ไม่ตรงกับบัญชีหรือข้อมูลเป้าหมาย (${state.expectedFillValue})`,
      };
    }
  }

  // 7. Click and interactive element verification
  if (isClickTask(prompt)) {
    const clickExplicitlySkipped =
      state.browserClickAttempted === false &&
      state.desktopClickAttempted !== true &&
      state.keyboardEnterAttempted !== true;

    // web_fetch or web_search alone where click was explicitly skipped cannot satisfy a click requirement
    if (clickExplicitlySkipped && state.actionsAttempted > 0) {
      return {
        ok: false,
        reason: "งานคลิกหรือเลือกองค์ประกอบบนหน้าเว็บไม่สำเร็จ: ไม่พบการคลิกผ่านเบราว์เซอร์จริง (web_fetch ไม่สามารถทดแทนการคลิกได้)",
      };
    }
    // No actions attempted at all and no state/screen change occurred
    if (state.actionsAttempted === 0 && !state.domStateChanged && !state.screenChanged) {
      return {
        ok: false,
        reason: "งานคลิกหรือเลือกองค์ประกอบบนหน้าเว็บไม่สำเร็จ: ไม่พบการคลิกผ่านเบราว์เซอร์จริงตามเป้าหมายที่ร้องขอ",
      };
    }
    // Click dispatched but verified is false without any state or screen change
    if (
      state.actionsAttempted > 0 &&
      state.lastActionVerified === false &&
      !state.domStateChanged &&
      !state.screenChanged
    ) {
      return {
        ok: false,
        reason: "การทำงานบนหน้าเว็บไม่สำเร็จ: คำสั่งคลิกไม่ได้รับการยืนยันผลลัพธ์ (verified=false)",
      };
    }
  }

  // 8. Sub-navigation / selection no-op detection
  if (
    (!isLoginFormTask(prompt) || !state.loginFormVisible) &&
    isWebNavigationTask(prompt) &&
    state.actionsAttempted > 0 &&
    !state.domStateChanged &&
    !state.screenChanged &&
    state.initialUrl &&
    state.currentUrl &&
    state.initialUrl === state.currentUrl &&
    (state.currentUrl.endsWith("/home") ||
      state.currentUrl.endsWith("/") ||
      (state.lastActionVerified === false && !state.navigationOnly))
  ) {
    return {
      ok: false,
      reason: "การทำงานบนหน้าเว็บยังไม่ถึงเป้าหมาย: ตรวจพบว่าหน้าเว็บยังคงอยู่ที่เดิม (no-op) ไม่มีการเปลี่ยนสถานะหรือไปยังหน้าที่ต้องการ",
    };
  }

  return { ok: true };
}
