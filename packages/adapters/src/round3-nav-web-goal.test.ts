import { describe, expect, it } from "vitest";
import {
  isClickTask,
  isLoginFormTask,
  isSearchTask,
  isWebNavigationTask,
  verifyWebGoal,
  type WebGoalState,
} from "./web-goal-verification.js";

describe("round3-nav-web-goal verification regressions", () => {
  it("detects search tasks accurately in Thai and English", () => {
    expect(isSearchTask("คุณเข้า shopee และหาน้ำเปล่าให้หน่อย")).toBe(true);
    expect(isSearchTask("หาน้ำเปล่า")).toBe(true);
    expect(isSearchTask("ค้นหาน้ำดื่ม")).toBe(true);
    expect(isSearchTask("search for bottled water")).toBe(true);
    expect(isSearchTask("find shoes")).toBe(true);

    expect(isSearchTask("คำค้นหาคืออะไร?")).toBe(false);
    expect(isSearchTask("ขอดูภาพหน้าจอ")).toBe(false);
  });

  it("detects login form requests accurately in Thai and English", () => {
    expect(isLoginFormTask("เปิดหน้ารอกรอกเมลและรหัส")).toBe(true);
    expect(isLoginFormTask("ไปหน้าล็อกอินรอผมกรอก")).toBe(true);
    expect(isLoginFormTask("เปิดหน้า sign in รอใส่รหัส")).toBe(true);
    expect(isLoginFormTask("navigate to the login form")).toBe(true);

    expect(isLoginFormTask("ปุ่มล็อกอินอยู่ตรงไหน?")).toBe(false);
  });

  it("fails Shopee search task when bot only navigates to homepage (Shopee incident cmv74wtml00942kr1wizff503)", () => {
    const state: WebGoalState = {
      actionsAttempted: 0,
      navigationOnly: true,
      initialUrl: "https://shopee.co.th/",
      currentUrl: "https://shopee.co.th/",
      currentTitle: "Shopee Thailand",
      domStateChanged: false,
      searchAttempted: false,
      searchSubmitted: false,
    };
    const res = verifyWebGoal("คุณเข้า shopee และหาน้ำเปล่าให้หน่อย", state);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("งานค้นหายังไม่สำเร็จ");
    expect(res.reason).toContain("บอตเพียงเปิดหน้าแรกของเว็บไซต์");
  });

  it("fails Shopee search task when language modal is still blocking (evidence image check)", () => {
    const state: WebGoalState = {
      actionsAttempted: 1,
      navigationOnly: false,
      initialUrl: "https://shopee.co.th/",
      currentUrl: "https://shopee.co.th/",
      activeModal: "เลือกภาษา / Select Language",
      searchAttempted: false,
      searchSubmitted: false,
      domStateChanged: false,
    };
    const res = verifyWebGoal("คุณเข้า shopee และหาน้ำเปล่าให้หน่อย", state);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("หน้าเว็บยังติดหน้าต่างเลือกภาษาหรือ modal บังอยู่");
  });

  it("passes Shopee search task when search was submitted and results reached", () => {
    const state: WebGoalState = {
      actionsAttempted: 2,
      lastActionOk: true,
      lastActionVerified: true,
      initialUrl: "https://shopee.co.th/",
      currentUrl: "https://shopee.co.th/search?keyword=%E0%B8%99%E0%B9%89%E0%B8%B3%E0%B9%80%E0%B8%9B%E0%B8%A5%E0%B9%88%E0%B8%B2",
      currentTitle: "ค้นหา น้ำเปล่า | Shopee Thailand",
      domStateChanged: true,
      searchAttempted: true,
      searchSubmitted: true,
    };
    const res = verifyWebGoal("คุณเข้า shopee และหาน้ำเปล่าให้หน่อย", state);
    expect(res.ok).toBe(true);
  });

  it("fails Z.com login form task when bot stays on landing page with unrelated DOM change (Z.com incident cmv74ruyl008k2kr1nbd7icfx)", () => {
    const state: WebGoalState = {
      actionsAttempted: 1,
      lastActionOk: true,
      initialUrl: "https://z.com/sg/",
      currentUrl: "https://z.com/sg/",
      currentTitle: "Z.com Singapore",
      domStateChanged: true, // Unrelated DOM change (e.g. banner slider)
      loginFormVisible: false,
    };
    const res = verifyWebGoal("เปิดหน้ารอกรอกเมลและรหัส", state);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("การเปิดหน้าล็อกอินยังไม่สำเร็จ");
    expect(res.reason).toContain("ยังไม่พบฟอร์มสำหรับกรอกอีเมลและรหัสผ่านจริง");
  });

  it("passes Z.com login form task when visible login fields are reached after redirect/new tab", () => {
    const state: WebGoalState = {
      actionsAttempted: 2,
      lastActionOk: true,
      lastActionVerified: true,
      initialUrl: "https://z.com/sg/",
      currentUrl: "https://cloud.z.com/th/signin/",
      currentTitle: "เข้าสู่ระบบ - Z.com Cloud",
      loginFormVisible: true,
      domStateChanged: true,
    };
    const res = verifyWebGoal("เปิดหน้ารอกรอกเมลและรหัส", state);
    expect(res.ok).toBe(true);
  });

  it("accepts normalized desktop click from C interface without false negative", () => {
    const state: WebGoalState = {
      actionsAttempted: 1,
      lastActionOk: true,
      lastActionVerified: true,
      browserClickAttempted: false, // browser_act was not used
      desktopClickAttempted: true,  // computer_act pointer.type=click was used
      domStateChanged: true,
      currentUrl: "https://example.com/details",
    };
    const res = verifyWebGoal("คลิกไปที่เมนูถัดไป", state);
    expect(res.ok).toBe(true);
  });

  it("accepts keyboard Enter as search submission without forcing browser click", () => {
    const state: WebGoalState = {
      actionsAttempted: 1,
      lastActionOk: true,
      lastActionVerified: true,
      browserClickAttempted: false,
      keyboardEnterAttempted: true,
      searchSubmitted: true,
      domStateChanged: true,
      currentUrl: "https://shopee.co.th/search?keyword=water",
    };
    const res = verifyWebGoal("ค้นหาน้ำเปล่า", state);
    expect(res.ok).toBe(true);
  });

  it("rejects stranded no-op on home page", () => {
    const state: WebGoalState = {
      actionsAttempted: 2,
      lastActionOk: true,
      initialUrl: "https://shopee.co.th/",
      currentUrl: "https://shopee.co.th/",
      domStateChanged: false,
      screenChanged: false,
    };
    const res = verifyWebGoal("เข้าเว็บ shopee แล้วเข้า year3 แล้วเลือก NS3", state);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("no-op");
  });

  it("fails search task when typing occurred but search was not submitted (searchAttempted=true, searchSubmitted=false)", () => {
    const state: WebGoalState = {
      actionsAttempted: 1,
      lastActionOk: true,
      initialUrl: "https://shopee.co.th/",
      currentUrl: "https://shopee.co.th/",
      domStateChanged: false,
      searchAttempted: true,
      searchSubmitted: false,
      keyboardEnterAttempted: false,
    };
    const res = verifyWebGoal("ค้นหาน้ำดื่ม", state);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("พิมพ์คำค้นหาแล้วแต่ยังไม่ได้กด Enter หรือส่งคำค้นหา");
  });

  it("fails login task when URL contains /login but loginFormVisible is false (empty or fake login page)", () => {
    const state: WebGoalState = {
      actionsAttempted: 1,
      lastActionOk: true,
      initialUrl: "https://example.com/",
      currentUrl: "https://example.com/login",
      currentTitle: "Login Page",
      loginFormVisible: false,
    };
    const res = verifyWebGoal("เปิดหน้ารอกรอกเมลและรหัส", state);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("ยังไม่พบฟอร์มสำหรับกรอกอีเมลและรหัสผ่านจริง");
  });
});
