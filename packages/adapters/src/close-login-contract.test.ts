import { describe, expect, it } from "vitest";
import {
  classifyCloseTarget,
  isAutonomousLoginCompletionTask,
  isClickTask,
  isLoginFormTask,
  isWindowCloseTask,
  parseObservedBrowserTabs,
  verifyWebGoal,
  type WebGoalState,
} from "./web-goal-verification.js";

const MAIN = { targetId: "MAIN-1", openerTargetId: null, url: "https://docs.example.net/editor", active: true };
const POPUP = { targetId: "POP-2", openerTargetId: "MAIN-1", url: "https://docs.example.net/help", active: false };

describe("close target scope contract (requested target)", () => {
  it.each([
    "ห้ามใช้ browser tool หรือ kill โปรแกรม",
    "อย่าใช้ Ctrl+W หรือปิดหน้าต่าง Chromium",
    "do not use the browser tool or kill the application",
  ])("asks before acting on non-adjacent/list negation: %s", (prompt) => {
    expect(classifyCloseTarget(prompt).requiresClarification).toBe(true);
    expect(isWindowCloseTask(prompt)).toBe(false);
  });
  it("classifies OS window/app closes", () => {
    for (const p of [
      "ช่วยปิดหน้าต่างเบราว์เซอร์ Chromium ให้หน่อยครับ",
      "ปิดโปรแกรม terminal ที่ค้างอยู่",
      "please quit the browser",
      "close window",
      "ปิดหน้าต่างนี้",
      "ปิดหน้าต่าง Chromium ที่เปิดหน้าเว็บ",
    ]) {
      expect(classifyCloseTarget(p).scope, p).toBe("os_window_or_app");
      expect(isWindowCloseTask(p), p).toBe(true);
    }
  });

  it("classifies browser tab/popup closes and records a protected main target", () => {
    const p =
      "เปิด https://crm.example.org/board แล้วปิดเฉพาะแท็บรายงานที่เด้งขึ้นมาโดยอย่าปิดหน้ากระดานหลัก";
    const intent = classifyCloseTarget(p);
    expect(intent.scope).toBe("browser_tab_or_popup");
    expect(intent.protectsMainTarget).toBe(true);
    expect(isWindowCloseTask(p)).toBe(false);
    const en = classifyCloseTarget("Close the popup window that opened, but don't close the main tab");
    expect(en.scope).toBe("browser_tab_or_popup");
    expect(en.protectsMainTarget).toBe(true);
  });

  it("classifies in-page overlays (dialogs, notices, cookie banners) as page scope", () => {
    for (const p of [
      "เข้าไปที่ https://news.example.org/article/105 กดปุ่ม 'ปิดหน้าต่างประกาศ (Dismiss Announcement Dialog)' แล้วอ่านย่อหน้าแรก",
      "Go to https://shop.example.com and dismiss the cookie banner, then read the price",
      "คลิกปุ่ม 'ปิดหน้าต่าง' บนกล่องข้อความแจ้งเตือนแล้วอ่านเนื้อหา",
    ]) {
      expect(classifyCloseTarget(p).scope, p).toBe("in_page_overlay");
      expect(isWindowCloseTask(p), p).toBe(false);
    }
  });

  it("does not treat open/negated/unrelated phrases as close requests", () => {
    for (const p of [
      "เปิดเว็บ https://example.com",
      "อย่าปิดเบราว์เซอร์นะ แค่อ่านหัวข้อข่าวให้หน่อย",
      "don't close anything, just summarize the page",
      "this store is close to the station, find opening hours",
    ]) {
      expect(classifyCloseTarget(p).scope, p).toBe("none");
      expect(isWindowCloseTask(p), p).toBe(false);
    }
  });

  it("returns the most destructive affirmative scope when several are requested", () => {
    const p = "ปิดป๊อปอัปคุกกี้ที่บังอยู่ แล้วปิดเบราว์เซอร์ Chromium ให้ด้วย";
    expect(classifyCloseTarget(p).scope).toBe("os_window_or_app");
  });
});

describe("tab/popup close verification (observed identity)", () => {
  const prompt = "ปิดเฉพาะหน้าต่างป๊อปอัปวิธีใช้งานโดยห้ามปิดหน้างานหลัก แล้วอ่านสถานะเอกสารหลัก";
  const base: WebGoalState = { actionsAttempted: 2, lastActionOk: true, lastActionVerified: true };

  it("passes when the observed popup target is gone and the main tab remains", () => {
    const res = verifyWebGoal(prompt, {
      ...base,
      browserTabs: [MAIN],
      observedPopupTargetIds: ["POP-2"],
      mainTargetId: "MAIN-1",
    });
    expect(res.ok).toBe(true);
  });

  it("fails when the popup tab is still open (2 tabs)", () => {
    const res = verifyWebGoal(prompt, {
      ...base,
      browserTabs: [MAIN, POPUP],
      observedPopupTargetIds: ["POP-2"],
      mainTargetId: "MAIN-1",
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("POP-2");
  });

  it("fails when the protected main tab was closed", () => {
    const res = verifyWebGoal(prompt, {
      ...base,
      browserTabs: [{ targetId: "OTHER-3", openerTargetId: null }],
      observedPopupTargetIds: ["POP-2"],
      mainTargetId: "MAIN-1",
    });
    expect(res.ok).toBe(false);
  });

  it("fails when every tab was closed (whole browser closed to pass)", () => {
    const res = verifyWebGoal(prompt, {
      ...base,
      browserTabs: [],
      observedPopupTargetIds: ["POP-2"],
      mainTargetId: "MAIN-1",
    });
    expect(res.ok).toBe(false);
  });

  it("fails closed when tab identity was never observed (UNKNOWN)", () => {
    const res = verifyWebGoal(prompt, { ...base });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("UNKNOWN");
  });

  it("does not require the Chromium OS window to disappear for a popup close", () => {
    const res = verifyWebGoal(prompt, {
      ...base,
      browserTabs: [MAIN],
      observedPopupTargetIds: ["POP-2"],
      mainTargetId: "MAIN-1",
      windowsRemaining: [{ id: "0x1", wmClass: "chromium.Chromium", title: "Editor" }],
      targetWindowClosed: false,
    });
    expect(res.ok).toBe(true);
  });

  it("an in-page 'popup' with no popup target needs the overlay gone", () => {
    const stillBlocked = verifyWebGoal(prompt, {
      ...base,
      browserTabs: [MAIN],
      mainTargetId: "MAIN-1",
      activeModal: "Help overlay",
    });
    expect(stillBlocked.ok).toBe(false);
    const dismissed = verifyWebGoal(prompt, {
      ...base,
      browserTabs: [MAIN],
      mainTargetId: "MAIN-1",
      domStateChanged: true,
    });
    expect(dismissed.ok).toBe(true);
  });
});

describe("in-page overlay verification", () => {
  const prompt = "Go to https://shop.example.com and dismiss the cookie banner, then read the price";
  it("fails while the overlay is still active and passes once it is gone", () => {
    expect(
      verifyWebGoal(prompt, { actionsAttempted: 1, lastActionOk: true, activeModal: "Cookie consent" }).ok,
    ).toBe(false);
    expect(
      verifyWebGoal(prompt, { actionsAttempted: 1, lastActionOk: true, lastActionVerified: true, browserTabs: [MAIN] }).ok,
    ).toBe(true);
  });
  it("fails when the page tab itself was closed instead of the overlay", () => {
    expect(
      verifyWebGoal(prompt, { actionsAttempted: 1, lastActionOk: true, lastActionVerified: true, browserTabs: [] }).ok,
    ).toBe(false);
  });
});

describe("login: human handoff vs autonomous completion", () => {
  it("treats provider/SSO click-through to completion as an autonomous click flow (non-fixture provider)", () => {
    const p =
      "เข้าไปที่ https://portal.enterprise-example.org/auth/begin คลิก SIGN IN WITH OKTA SSO แล้วดำเนินการเข้าสู่ระบบให้หน่อยครับ";
    expect(isAutonomousLoginCompletionTask(p)).toBe(true);
    expect(isLoginFormTask(p)).toBe(false);
    expect(isClickTask(p)).toBe(true);
    const en = "Open https://app.example.io/login, click Continue with Google and approve until you reach the dashboard";
    expect(isLoginFormTask(en)).toBe(false);
  });

  it("keeps genuine handoff requests as login-form pauses even if SSO is mentioned", () => {
    for (const p of [
      "ช่วยเปิดหน้าเข้าสู่ระบบที่ https://portal.example-corp.org/account/signin ไว้ให้หน่อย เดี๋ยวผมกรอกรหัสผ่านเองทางแชท",
      "เปิดหน้า login ของ https://intranet.example.com ที่ใช้ SSO แล้วรอผมกรอกเอง",
      "open the sign in page at https://hr.example.com and wait for me to type my password",
    ]) {
      expect(isAutonomousLoginCompletionTask(p), p).toBe(false);
      expect(isLoginFormTask(p), p).toBe(true);
    }
  });

  it("does not treat article reading on a site as login", () => {
    const p =
      "ช่วยเข้าไปที่เว็บ https://docs.example-gov.org/ แล้วเปิดอ่านบทความ 'มาตรการภาษีคาร์บอน 2570' (/policy/carbon-tax-2027) ดึงข้อมูลอัตราภาษีและรหัสเอกสารให้ด้วยครับ";
    expect(isLoginFormTask(p)).toBe(false);
  });
});

describe("parseObservedBrowserTabs", () => {
  it("returns undefined for missing/malformed tab metadata (UNKNOWN)", () => {
    expect(parseObservedBrowserTabs(undefined)).toBeUndefined();
    expect(parseObservedBrowserTabs([{ url: "x" }])).toBeUndefined();
    expect(parseObservedBrowserTabs([MAIN, POPUP])?.length).toBe(2);
  });
});
