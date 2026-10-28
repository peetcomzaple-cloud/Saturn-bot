import { describe, expect, it } from "vitest";
import { ApiErrorInspection, isApiErrorReportTask } from "./api-error-inspection.js";
import { verifyWebGoal } from "./web-goal-verification.js";

const endpoint = "https://service.example.test/api/users?limit=3";
const prompt = `ตรวจสอบ API endpoint ${endpoint} เมื่อพบว่า API ตอบกลับ HTTP400 ข้อผิดพลาด invalid_request_error ห้ามล้างคุกกี้หรือ storage ของเบราว์เซอร์เด็ดขาด ให้รายงานประเภทข้อผิดพลาดของ API ที่ได้รับตามจริงครับ`;
const nav = { url: endpoint, httpStatus: 400, httpStatusStatus: "known", errorKind: "api_bad_request", frameId: "frame-a", loaderId: "document-a" };
const snap = { url: endpoint, targetId: "target-a", frameId: "frame-a", loaderId: "document-a", responseBodyText: JSON.stringify({error: {type: "observed_schema_error", message: "field is missing"}}) };
function ready(): ApiErrorInspection {
  const tracker = new ApiErrorInspection();
  tracker.navigate(endpoint, nav);
  tracker.snapshot(snap);
  return tracker;
}
describe("API error reporting is an observation goal, not a repair goal", () => {
  it("permits a bound observation despite the HTTP action remaining failed", () => {
    expect(isApiErrorReportTask(prompt)).toBe(true);
    expect(verifyWebGoal(prompt, {actionsAttempted: 1, lastActionOk: false, currentUrl: endpoint, apiErrorInspection: ready()})).toEqual({ok: true});
  });
  it("also handles an unseen endpoint without any fixture marker", () => {
    const other = "https://payments.example.test/api/check?currency=EUR";
    const tracker = new ApiErrorInspection();
    tracker.navigate(other, {...nav, url: other});
    tracker.snapshot({...snap, url: other});
    expect(tracker.qualifies(`Inspect the API response at ${other} and report its error type`, other)).toBe(true);
  });
  it.each([
    " แล้วแก้ไขให้สำเร็จ", " แล้วลองใหม่จนสำเร็จ", " and fix it", " and retry until successful",
    " then click Save", " แล้วเข้าสู่ระบบ", " and submit the form",
    " ห้ามล้างคุกกี้ แล้วแก้ไขให้สำเร็จ",
    " then close the browser window", " แล้วปิดแท็บ", " and search for a report", " and download the report",
  ])("does not exempt requested actions: %s", suffix => {
    expect(isApiErrorReportTask(prompt + suffix)).toBe(false);
    expect(verifyWebGoal(prompt + suffix, {actionsAttempted: 1, lastActionOk: false, currentUrl: endpoint, apiErrorInspection: ready()}).ok).toBe(false);
  });
  it("does not mistake a forbidden Login for a requested action", () => {
    expect(isApiErrorReportTask(prompt + " อย่าล็อกอิน")).toBe(true);
  });
  it("does not bypass an explicit uncompleted window close", () => {
    expect(verifyWebGoal(prompt + " then close the browser window", {
      actionsAttempted: 1, lastActionOk: false, currentUrl: endpoint,
      apiErrorInspection: ready(), targetWindowClosed: false,
    }).ok).toBe(false);
  });
  it.each([
    {httpStatus: undefined}, {httpStatusStatus: "unknown"}, {httpStatus: 200},
    {errorKind: "login_flow_bad_request"}, {frameId: undefined}, {loaderId: undefined},
    {challengeDetected: true}, {url: endpoint + "&other=1"},
  ])("rejects unknown or unrelated navigation evidence %j", change => {
    const tracker = new ApiErrorInspection();
    tracker.navigate(endpoint, {...nav, ...change});
    tracker.snapshot(snap);
    expect(tracker.qualifies(prompt, endpoint)).toBe(false);
  });
  it.each([
    {frameId: "other"}, {loaderId: "reloaded"}, {url: endpoint + "&other=1"},
    {targetId: undefined}, {error: "disconnected"}, {ok: false}, {responseBodyText: undefined},
    {responseBodyText: "not JSON"}, {responseBodyText: '{"error":{"message":"missing type"}}'},
  ])("rejects stale, unknown or missing response body %j", change => {
    const tracker = new ApiErrorInspection();
    tracker.navigate(endpoint, nav);
    tracker.snapshot({...snap, ...change});
    expect(tracker.qualifies(prompt, endpoint)).toBe(false);
  });
  it("never accepts the prompt's error type as a substitute for a body", () => {
    const tracker = new ApiErrorInspection();
    tracker.navigate(endpoint, nav);
    tracker.snapshot({...snap, responseBodyText: "", tree: prompt, title: "invalid_request_error"});
    expect(verifyWebGoal(prompt, {actionsAttempted: 1, lastActionOk: true, currentUrl: endpoint, apiErrorInspection: tracker}).ok).toBe(false);
  });
  it("invalidates on another target, navigation or potential mutation", () => {
    const tracker = ready();
    tracker.snapshot({...snap, targetId: "other-target"});
    expect(tracker.qualifies(prompt, endpoint)).toBe(false);
    const next = ready(); next.navigate(endpoint, {...nav, httpStatus: 200});
    expect(next.qualifies(prompt, endpoint)).toBe(false);
    const mutated = ready(); mutated.invalidate();
    expect(mutated.qualifies(prompt, endpoint)).toBe(false);
    expect(ready().qualifies(prompt, "https://service.example.test/")).toBe(false);
  });
  it("does not bypass tool exhaustion, CAPTCHA or requested screenshot proof", () => {
    const state = {actionsAttempted: 1, lastActionOk: false, currentUrl: endpoint, apiErrorInspection: ready()};
    expect(verifyWebGoal(prompt, {...state, toolLimitExceeded: true}).ok).toBe(false);
    expect(verifyWebGoal(prompt, {...state, challengeDetected: true}).ok).toBe(false);
    expect(verifyWebGoal(prompt + " พร้อมภาพหน้าจอ", state).ok).toBe(false);
  });
});
