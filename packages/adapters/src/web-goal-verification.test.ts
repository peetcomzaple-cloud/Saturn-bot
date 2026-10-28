import { describe, expect, it } from "vitest";
import {
  evaluateFormFillResult,
  extractEmailFromText,
  isFormFillTask,
  isLoginFormTask,
  isScreenshotRequest,
  isWebNavigationTask,
  isWindowCloseTask,
  verifyWebGoal,
} from "./web-goal-verification.js";

describe("web goal verification", () => {
  it("detects screenshot requests accurately in Thai and English", () => {
    expect(isScreenshotRequest("ขอดูภาพหน้าจอปัจจุบันหน่อย")).toBe(true);
    expect(isScreenshotRequest("ขอภาพหน้าจอ")).toBe(true);
    expect(isScreenshotRequest("ถ่ายภาพหน้าจอ")).toBe(true);
    expect(isScreenshotRequest("ขอดูหน้าจอหน่อย")).toBe(true);
    expect(isScreenshotRequest("take a screenshot")).toBe(true);
    expect(isScreenshotRequest("show me the screen")).toBe(true);

    expect(isScreenshotRequest("JSON คืออะไร")).toBe(false);
    expect(isScreenshotRequest("เปิดเว็บ https://example.com")).toBe(false);
  });

  it("distinguishes window close from open requests (Thai เปิด vs ปิด)", () => {
    expect(isWindowCloseTask("ปิดหน้าต่างนี้")).toBe(true);
    expect(isWindowCloseTask("ปิด chromium")).toBe(true);
    expect(isWindowCloseTask("ปิดมุมขวากว่านั้น")).toBe(true);
    expect(isWindowCloseTask("close window")).toBe(true);
    expect(isWindowCloseTask("quit browser")).toBe(true);

    // เปิด (open) must NEVER match as ปิด (close)
    expect(isWindowCloseTask("เปิดเบราว์เซอร์ไปที่ https://example.com")).toBe(false);
    expect(isWindowCloseTask("เปิดเว็บ https://example.com")).toBe(false);
    expect(isWindowCloseTask("เปิด example.com")).toBe(false);
    expect(isWindowCloseTask("เปิดคลิป NS3")).toBe(false);
  });

  it("detects navigation requests", () => {
    expect(isWebNavigationTask("เปิด flick mdcu แล้วเข้า year3 แล้วเลือก NS3")).toBe(true);
    expect(isWebNavigationTask("กด More information ในเว็บเมื่อกี้")).toBe(true);
    expect(isWebNavigationTask("พิมพ์ กรุงเทพ ในช่องค้นหา แล้วกดค้นหา")).toBe(true);
    expect(isWebNavigationTask("JSON คืออะไร ตอบสั้น ๆ")).toBe(false);
  });

  it("fails verification when screenshot was requested but no artifact attached", () => {
    const res = verifyWebGoal("ขอดูภาพหน้าจอปัจจุบันหน่อย", {
      actionsAttempted: 1,
      screenArtifactAttached: false,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("ไม่พบภาพหน้าจอที่แนบจริง");
  });

  it("passes verification when screenshot was requested and artifact was attached", () => {
    const res = verifyWebGoal("ขอดูภาพหน้าจอปัจจุบันหน่อย", {
      actionsAttempted: 1,
      screenArtifactAttached: true,
    });
    expect(res.ok).toBe(true);
  });

  it("fails verification when web action failed without recovery", () => {
    const res = verifyWebGoal("กด new", {
      actionsAttempted: 1,
      lastActionOk: false,
      lastActionError: "Stale element ref",
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("Stale element ref");
  });

  it("fails verification on no-op clicks that remain stranded on /home", () => {
    const res = verifyWebGoal("เปิด flick mdcu แล้วเข้า year3 แล้วเลือก NS3", {
      actionsAttempted: 2,
      lastActionOk: true,
      initialUrl: "https://example.com/home",
      currentUrl: "https://example.com/home",
      domStateChanged: false,
      screenChanged: false,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("ตรวจพบว่าหน้าเว็บยังคงอยู่ที่เดิม (no-op)");
  });

  it("passes verification when URL changed", () => {
    const res = verifyWebGoal("กด new", {
      actionsAttempted: 1,
      lastActionOk: true,
      initialUrl: "https://news.ycombinator.com/",
      currentUrl: "https://news.ycombinator.com/newest",
      domStateChanged: true,
    });
    expect(res.ok).toBe(true);
  });

  it("passes verification on direct deep-path navigation for T01 article reading without forcing login click", () => {
    const t01Prompt =
      "ช่วยเข้าไปที่เว็บ http://portal.argon-fixture.local:18080/ แล้วเปิดอ่านบทความ 'นโยบายส่งเสริมยานยนต์ไฟฟ้า 2569' (/articles/ev-policy-2026) ดึงข้อมูล 2 ข้อคือ 1) จำนวนเงินอุดหนุนต่อคัน และ 2) รหัสอ้างอิงบทความ พร้อมระบุ URL ที่เปิดอ่านให้ด้วยครับ";
    expect(isLoginFormTask(t01Prompt)).toBe(false);
    expect(isFormFillTask(t01Prompt)).toBe(false);
    const res = verifyWebGoal(t01Prompt, {
      actionsAttempted: 1,
      lastActionOk: true,
      lastActionVerified: true,
      navigationOnly: true,
      initialUrl: "http://portal.argon-fixture.local:18080/articles/ev-policy-2026",
      currentUrl: "http://portal.argon-fixture.local:18080/articles/ev-policy-2026",
      domStateChanged: false,
      screenChanged: false,
      loginFormVisible: false,
      browserClickAttempted: false,
    });
    expect(res.ok).toBe(true);
  });

  it("passes verification on SPA when DOM state changed even if URL is same", () => {
    const res = verifyWebGoal("เลือกแท็บประวัติ", {
      actionsAttempted: 1,
      lastActionOk: true,
      initialUrl: "https://app.test/dashboard",
      currentUrl: "https://app.test/dashboard",
      domStateChanged: true,
    });
    expect(res.ok).toBe(true);
  });

  it("fails verification when tool limit was exceeded (evidence: เทสๆ 24 calls)", () => {
    const res = verifyWebGoal("เปิด flick แล้วกด sign in", {
      actionsAttempted: 24,
      toolLimitExceeded: true,
      toolLimit: 24,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("limit of 24 tool calls");
  });

  it("fails verification when closing a window but target window is still present (Chief incident)", () => {
    const res = verifyWebGoal("ปิด chromium", {
      actionsAttempted: 1,
      lastActionOk: true,
      lastActionVerified: false,
      targetWindowClosed: false,
      targetWindowClass: "chromium",
      windowsRemaining: [
        { id: "0x00600003", wmClass: "chromium.Chromium", title: "MDCU Lecture - Chromium" },
      ],
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("หน้าต่างเป้าหมายยังคงเปิดอยู่");
  });

  it("fails verification when closing a window action had verified=false", () => {
    const res = verifyWebGoal("ปิดมุมขวากว่านั้น", {
      actionsAttempted: 1,
      lastActionOk: true,
      lastActionVerified: false,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("verified=false");
  });

  it("passes verification when window close was verified", () => {
    const res = verifyWebGoal("ปิด chromium", {
      actionsAttempted: 1,
      lastActionOk: true,
      lastActionVerified: true,
      targetWindowClosed: true,
      targetWindowClass: "chromium",
      windowsRemaining: [{ id: "0x01800001", wmClass: "xterm.XTerm", title: "Terminal" }],
    });
    expect(res.ok).toBe(true);
  });

  it("fails verification when click was requested but only web_fetch was used (suite-d-3 incident)", () => {
    const res = verifyWebGoal("คลิกปุ่ม Array", {
      actionsAttempted: 1,
      browserClickAttempted: false,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("web_fetch ไม่สามารถทดแทนการคลิกได้");
  });

  it("fails verification when click was dispatched but verified=false without state change", () => {
    const res = verifyWebGoal("กดปุ่ม SIGN IN", {
      actionsAttempted: 1,
      lastActionOk: true,
      lastActionVerified: false,
      browserClickAttempted: true,
      domStateChanged: false,
      screenChanged: false,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("verified=false");
  });

  it("fails verification when click was requested but 0 clicks attempted (no button found / snapshot only)", () => {
    const res = verifyWebGoal("กด More information", {
      actionsAttempted: 0,
      browserClickAttempted: false,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("ไม่พบการคลิกผ่านเบราว์เซอร์จริงตามเป้าหมายที่ร้องขอ");
  });

  it("does not treat informational inquiries about buttons as click tasks", () => {
    const res = verifyWebGoal("ถ้ากดปุ่มนี้แล้วจะเป็นอย่างไร?", {
      actionsAttempted: 0,
      browserClickAttempted: false,
    });
    expect(res.ok).toBe(true);
  });

  it("distinguishes login form requests from generic open/navigate prompts", () => {
    expect(isLoginFormTask("open the login page")).toBe(true);
    expect(isLoginFormTask("navigate to sign in form")).toBe(true);
    expect(isLoginFormTask("เปิดหน้าล็อกอินแล้วรอผมกรอก")).toBe(true);
    expect(isLoginFormTask("เข้าเว็บ portal ล๊อคอินให้หน่อยครับเดี๋ยวผมใส่รหัสเอง")).toBe(true);
    expect(
      isLoginFormTask("เปิดเมลผมแล้วส่งบล๊อคมาให้ผมล๊อคอินทางแชทด้วยอีเมลใหม่ด้วยครับ"),
    ).toBe(true);

    expect(isLoginFormTask("Open Multi-Origin Enterprise Portal")).toBe(false);
    expect(isLoginFormTask("navigate to https://example.com/dashboard")).toBe(false);
    expect(
      verifyWebGoal(
        "rakazo-record-playlist --urls https://localhost:18443/dashboard https://localhost:18443/sso/login",
        { actionsAttempted: 0, browserClickAttempted: false },
      ).ok,
    ).toBe(true);
  });

  it("detects form-fill requests while ignoring self-fill clauses", () => {
    expect(isFormFillTask("กรอก เมล student1 @ orgportal ให้หน่อยครับเดี๋ยวผมใส่รหัสเอง")).toBe(true);
    expect(isFormFillTask("กรอกเมลที่ผมบอกไปให้หน่อสครับเดี๋ยวผมใส่รหัสเอง")).toBe(true);
    expect(isFormFillTask("ล็อกอินเมล testuser@example.com")).toBe(true);
    expect(isFormFillTask("testuser@example.com")).toBe(true);
    expect(isFormFillTask("เปิดหน้าล็อกอินแล้วรอผมกรอก")).toBe(false);
    expect(isFormFillTask("เข้าเว็บ portal แล้วเดี๋ยวผมใส่รหัสเอง")).toBe(false);
    expect(isFormFillTask("ช่วยตรวจสอบหน้าดังกล่าวโดยห้ามกรอกรหัสผ่านเด็ดขาด แล้วรายงานคำเตือนความปลอดภัยที่พบในหน้านั้นครับ")).toBe(false);
    expect(isFormFillTask("Please check that link, do not enter password, report security warnings")).toBe(false);
  });

  it("fails verification when form-fill was requested but formFillAttempted is false", () => {
    const res = verifyWebGoal("กรอกเมลที่ผมบอกไปให้หน่อสครับเดี๋ยวผมใส่รหัสเอง", {
      actionsAttempted: 1,
      lastActionOk: true,
      formFillAttempted: false,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("ยังไม่ได้ทำการกรอกข้อมูลลงในช่องกรอกบนหน้าเว็บจริง");
  });

  it("fails verification when formFillAttempted is true but formFillVerified is false", () => {
    const res = verifyWebGoal("กรอก เมล student1 @ orgportal ให้หน่อยครับเดี๋ยวผมใส่รหัสเอง", {
      actionsAttempted: 2,
      lastActionOk: true,
      formFillAttempted: true,
      formFillVerified: false,
      domStateChanged: true,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("formFillVerified เป็น false");
  });

  it("fails verification when filledTargetValue does not match expectedFillValue", () => {
    const res = verifyWebGoal("testuser@example.com", {
      actionsAttempted: 2,
      lastActionOk: true,
      formFillAttempted: true,
      formFillVerified: true,
      expectedFillValue: "testuser@example.com",
      filledTargetValue: "wrong@example.com",
      domStateChanged: true,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("ไม่ตรงกับบัญชีหรือข้อมูลเป้าหมาย");
  });

  it("passes verification when formFillAttempted, formFillVerified, and target value match", () => {
    const res = verifyWebGoal("กรอก เมล student1 @ orgportal ให้หน่อยครับเดี๋ยวผมใส่รหัสเอง", {
      actionsAttempted: 2,
      lastActionOk: true,
      formFillAttempted: true,
      formFillVerified: true,
      expectedFillValue: "student1@orgportal.com",
      filledTargetValue: "student1@orgportal.com",
      domStateChanged: true,
    });
    expect(res.ok).toBe(true);
  });

  it("never guesses .com for partial email handles unless observable context confirms the domain", () => {
    expect(extractEmailFromText("กรอก เมล student1 @ orgportal ให้หน่อย")).toBeUndefined();
    expect(
      extractEmailFromText(
        "กรอก เมล student1 @ orgportal ให้หน่อย",
        "https://portal.orgportal.com/login",
      ),
    ).toBe("student1@orgportal.com");
    expect(
      extractEmailFromText(
        "somchai @ uniportal",
        "https://library.uniportal.ac.th/",
      ),
    ).toBe("somchai@uniportal.ac.th");
  });

  it("evaluates ground-truth DOM form fill outcome from postElements and postTree", () => {
    // Positive control 1: Verified via live target textbox value
    const directFill = evaluateFormFillResult({
      actions: [{ kind: "fill", ref: "e1", text: "testuser@example.com" }],
      postElements: [
        { ref: "e1", role: "textbox", name: "Email or phone", value: "testuser@example.com" },
        { ref: "e2", role: "textbox", name: "Password", type: "password", value: "" },
      ],
      completedCount: 1,
      actOk: true,
    });
    expect(directFill.verified).toBe(true);
    expect(directFill.filledValue).toBe("testuser@example.com");

    // Positive control 2: Verified via genuine username-first transition to password step
    const pwdStep = evaluateFormFillResult({
      actions: [
        { kind: "fill", ref: "e1", text: "student1@orgportal.com" },
        { kind: "click", ref: "e3" },
      ],
      preUrl: "https://accounts.example.com/v3/signin/identifier",
      postUrl: "https://accounts.example.com/v3/signin/challenge/pwd",
      postTree: "Welcome student1@orgportal.com Enter your password",
      preElements: [{ ref: "e1", role: "textbox", name: "Email or phone", value: "" }],
      postElements: [{ ref: "e1", role: "textbox", name: "Enter your password", type: "password", value: "" }],
      completedCount: 2,
      actOk: true,
    });
    expect(pwdStep.verified).toBe(true);
    expect(pwdStep.filledValue).toBe("student1@orgportal.com");

    // Negative 1 (Codex exact probe): Contradicting postElements value + error URL redirect
    // Must NEVER substitute intendedValue for filledValue or return verified: true
    const codexProbe = evaluateFormFillResult({
      actions: [
        { kind: "fill", ref: "e1", text: "expected@example.test" },
        { kind: "click", ref: "e2" },
      ],
      preUrl: "https://example.test/login",
      postUrl: "https://example.test/login?error=1",
      postTree: "Email form",
      postElements: [
        { ref: "e1", role: "textbox", name: "Email", value: "wrong@example.test" },
      ],
      completedCount: 2,
      actOk: true,
    });
    expect(codexProbe.attempted).toBe(true);
    expect(codexProbe.verified).toBe(false);
    expect(codexProbe.intendedValue).toBe("expected@example.test");
    expect(codexProbe.filledValue).toBe("wrong@example.test");
    expect(codexProbe.hasValidationError).toBe(true);

    // Negative 2 (ผิดค่า / Wrong value without error URL, even with urlAdvanced + password field):
    const wrongValueWithUrlChange = evaluateFormFillResult({
      actions: [
        { kind: "fill", ref: "e1", text: "expected@example.test" },
        { kind: "click", ref: "e2" },
      ],
      preUrl: "https://example.test/login",
      postUrl: "https://example.test/login/step",
      postTree: "Sign in form",
      postElements: [
        { ref: "e1", role: "textbox", name: "Email", value: "wrong@example.test" },
        { ref: "e2", role: "textbox", name: "Password", type: "password", value: "" },
      ],
      completedCount: 2,
      actOk: true,
    });
    expect(wrongValueWithUrlChange.verified).toBe(false);
    expect(wrongValueWithUrlChange.filledValue).toBe("wrong@example.test");

    // Negative 3 (ผิดช่อง / Wrong field - filled searchbox instead of email input):
    const wrongFieldSearch = evaluateFormFillResult({
      actions: [{ kind: "fill", ref: "e1", text: "expected@example.test" }],
      postElements: [
        { ref: "e1", role: "searchbox", name: "Search site", value: "expected@example.test" },
        { ref: "e2", role: "textbox", name: "Email address", value: "" },
      ],
      completedCount: 1,
      actOk: true,
    });
    expect(wrongFieldSearch.verified).toBe(false);
    expect(wrongFieldSearch.filledValue).toBeUndefined();

    // Negative 4 (ผิดช่อง / Wrong ref - filled unrelated textbox while target email textbox is empty):
    const wrongFieldOtherTextbox = evaluateFormFillResult({
      actions: [{ kind: "fill", ref: "e2", text: "expected@example.test" }],
      postElements: [
        { ref: "e1", role: "textbox", name: "Invite code", value: "expected@example.test" },
        { ref: "e2", role: "textbox", name: "Email address", value: "" },
      ],
      completedCount: 1,
      actOk: true,
    });
    expect(wrongFieldOtherTextbox.verified).toBe(false);

    // Negative 5 (รหัสผ่านที่มีอยู่ก่อนแล้ว / Pre-existing password field on single-page login form where email is still empty):
    const preExistingPasswordUnfilledEmail = evaluateFormFillResult({
      actions: [
        { kind: "fill", ref: "e1", text: "expected@example.test" },
        { kind: "click", ref: "e3" },
      ],
      preUrl: "https://example.test/login",
      postUrl: "https://example.test/login",
      preElements: [
        { ref: "e1", role: "textbox", name: "Email", value: "" },
        { ref: "e2", role: "textbox", name: "Password", type: "password", value: "" },
      ],
      postElements: [
        { ref: "e1", role: "textbox", name: "Email", value: "" },
        { ref: "e2", role: "textbox", name: "Password", type: "password", value: "" },
      ],
      completedCount: 2,
      actOk: true,
    });
    expect(preExistingPasswordUnfilledEmail.verified).toBe(false);
    expect(preExistingPasswordUnfilledEmail.filledValue).toBeUndefined();

    // Negative 6: Pre-existing password field where postElements only has password field (no progression)
    const preExistingPasswordOnly = evaluateFormFillResult({
      actions: [
        { kind: "fill", ref: "e1", text: "expected@example.test" },
        { kind: "click", ref: "e2" },
      ],
      preUrl: "https://example.test/login",
      postUrl: "https://example.test/login#submit",
      preElements: [
        { ref: "e1", role: "textbox", name: "Password", type: "password", value: "" },
      ],
      postElements: [
        { ref: "e1", role: "textbox", name: "Password", type: "password", value: "" },
      ],
      completedCount: 2,
      actOk: true,
    });
    expect(preExistingPasswordOnly.verified).toBe(false);

    // Negative 7: Rejected when provider returns account validation error in tree
    const invalidAccount = evaluateFormFillResult({
      actions: [
        { kind: "fill", ref: "e1", text: "nobody@orgportal.com" },
        { kind: "click", ref: "e3" },
      ],
      postTree: "Sign in Couldn't find your Google Account",
      postElements: [{ ref: "e1", role: "textbox", name: "Email or phone", value: "nobody@orgportal.com" }],
      completedCount: 2,
      actOk: true,
    });
    expect(invalidAccount.verified).toBe(false);
    expect(invalidAccount.hasValidationError).toBe(true);

    // Positive control 3: Password fill with kind: "fill" (Live T13/T16 bot pattern) navigating to dashboard with authenticated session
    const pwdFillDashTransition = evaluateFormFillResult({
      intendedAccount: "researcher@argon-lab.org",
      actions: [
        { kind: "fill", ref: "p1", text: "ArgonPass!2026" },
        { kind: "click", ref: "sub1" },
      ],
      preUrl: "http://portal.argon-fixture.local:18080/login",
      postUrl: "http://portal.argon-fixture.local:18080/portal/dashboard",
      postTree: "Dashboard Welcome researcher@argon-lab.org Logout PRJ-AUTH-2026-5521",
      preElements: [
        { ref: "p1", role: "textbox", name: "Password", type: "password", value: "" },
        { ref: "sub1", role: "button", name: "Sign in" },
      ],
      postElements: [
        { ref: "dash1", role: "button", name: "Logout" },
      ],
      completedCount: 2,
      actOk: true,
      actVerified: true,
    });
    expect(pwdFillDashTransition.verified).toBe(true);
    expect(pwdFillDashTransition.filledValue).toBe("<secret>");

    // Positive control 4: Password fill with kind: "fill" observable in postElements
    const pwdFillObservable = evaluateFormFillResult({
      actions: [{ kind: "fill", ref: "p1", text: "ArgonPass!2026" }],
      preElements: [{ ref: "p1", role: "textbox", name: "Password", type: "password" }],
      postElements: [{ ref: "p1", role: "textbox", name: "Password", type: "password", value: "ArgonPass!2026" }],
      completedCount: 1,
      actOk: true,
    });
    expect(pwdFillObservable.verified).toBe(true);

    // Negative control 8: Password fill with kind: "fill" landing on different/unauthorized account identity
    const pwdFillWrongAccount = evaluateFormFillResult({
      actions: [
        { kind: "fill", ref: "p1", text: "ArgonPass!2026" },
        { kind: "click", ref: "sub1" },
      ],
      preUrl: "http://portal.argon-fixture.local:18080/login",
      postUrl: "http://portal.argon-fixture.local:18080/portal/dashboard",
      postTree: "Dashboard Welcome intruder@evil.org Logout",
      preElements: [
        { ref: "p1", role: "textbox", name: "Password", type: "password" },
        { ref: "sub1", role: "button", name: "Sign in" },
      ],
      postElements: [
        { ref: "dash1", role: "button", name: "Logout" },
      ],
      intendedAccount: "researcher@argon-lab.org",
      completedCount: 2,
      actOk: true,
      actVerified: true,
    });
    expect(pwdFillWrongAccount.verified).toBe(false);
  });

  it("passes T01 direct deep-path article navigation without misclassifying as login or no-op", () => {
    const t01Prompt =
      "ช่วยเข้าไปที่เว็บ http://portal.argon-fixture.local:18080/ แล้วเปิดอ่านบทความ 'นโยบายส่งเสริมยานยนต์ไฟฟ้า 2569' (/articles/ev-policy-2026) ดึงข้อมูล 2 ข้อคือ 1) จำนวนเงินอุดหนุนต่อคัน และ 2) รหัสอ้างอิงบทความ พร้อมระบุ URL ที่เปิดอ่านให้ด้วยครับ";
    expect(isLoginFormTask(t01Prompt)).toBe(false);
    expect(isFormFillTask(t01Prompt)).toBe(false);
    const res = verifyWebGoal(t01Prompt, {
      actionsAttempted: 1,
      lastActionOk: true,
      lastActionVerified: false,
      navigationOnly: true,
      initialUrl: "http://portal.argon-fixture.local:18080/articles/ev-policy-2026",
      currentUrl: "http://portal.argon-fixture.local:18080/articles/ev-policy-2026",
      domStateChanged: false,
      screenChanged: false,
    });
    expect(res.ok).toBe(true);
  });

  it("does not misclassify in-page modal dismissal or SSO approval completion as desktop window-close or login-form pause", () => {
    const t39dPrompt =
      "ในเซสชันใหม่นี้ ให้เข้าไปที่ http://portal.argon-fixture.local:18080/modal-article กดปุ่ม 'ยอมรับคุกกี้และปิดหน้าต่าง (Accept & Close Modal)' เพื่อปิดหน้าต่างป๊อปอัปที่บังอยู่ แล้วกดปุ่ม 'แสดงรหัสผลการทดลองลับ (Reveal Secret Data)' จากนั้นไปที่ http://portal.argon-fixture.local:18080/sso/start คลิก SIGN IN WITH ARGON SSO แล้วกดอนุมัติเข้าสู่ระบบจนได้รับรหัสยืนยันสิทธิ์ SSO แล้วสรุปทั้งรหัสผลการทดลองลับและรหัสยืนยันสิทธิ์ SSO พร้อมอีเมลผู้ใช้งานให้ครบครับ";
    expect(isWindowCloseTask(t39dPrompt)).toBe(false);
    expect(isLoginFormTask(t39dPrompt)).toBe(false);
  });
});
