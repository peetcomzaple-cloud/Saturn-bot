import { describe, expect, it } from "vitest";
import { ApiErrorInspection, httpBarrierToolRefusal, isErrorReportTask, isHttpBarrierReportTask } from "./api-error-inspection.js";
import { isClickTask, verifyWebGoal } from "./web-goal-verification.js";

const url = "https://portal.example.test/BillingPortal";
const prompt = `เปิดหน้า ${url} เมื่อพบข้อความปฏิเสธการเข้าถึง HTTP403 เนื่องจากเซสชันหมดอายุ (Session Expired) ให้รายงานสถานะว่าต้องเข้าสู่ระบบใหม่ที่ /login ห้ามวนซ้ำหน้าเดิมหรือแอบอ้างว่าเข้าถึงข้อมูลได้ครับ`;
const nav = {url, httpStatus:403, httpStatusStatus:"known", errorKind:"auth_expired", frameId:"f", loaderId:"l"};
const snap = {url, targetId:"t", frameId:"f", loaderId:"l", errorDocumentStatus:403, errorDocumentText:"403 Forbidden — Session Expired. Reauthentication required."};
function ready(): ApiErrorInspection {
  const result = new ApiErrorInspection(); result.navigate(url, nav); result.snapshot(snap); return result;
}
describe("reporting an access barrier does not request authentication", () => {
  it("recognizes the actual report-only intent without inventing a click goal", () => {
    expect(isErrorReportTask(prompt)).toBe(true);
    expect(isHttpBarrierReportTask(prompt)).toBe(true);
    expect(isClickTask(prompt)).toBe(false);
    expect(verifyWebGoal(prompt,{actionsAttempted:1,lastActionOk:false,currentUrl:url,apiErrorInspection:ready(),browserClickAttempted:false}).ok).toBe(true);
  });
  it.each([" แล้วเข้าสู่ระบบ", " แล้วเปิดหน้า /login", " แล้วอ่านข้อมูลใบแจ้งหนี้", " then login and retrieve billing data", " then close the window", " and click Next"])("retains explicit mixed actions %s", suffix => {
    expect(isHttpBarrierReportTask(prompt+suffix)).toBe(false);
    expect(ready().qualifies(prompt+suffix,url)).toBe(false);
  });
  it.each(["แล้วเข้าสู่ระบบ", "แล้วคลิกNext"])("does not swallow unspaced Thai commands after the reported path: %s", suffix => {
    const p=`เปิดหน้า ${url} เมื่อพบ HTTP403 ให้รายงานสถานะว่าต้องเข้าสู่ระบบใหม่ที่ /login${suffix}`;
    expect(isHttpBarrierReportTask(p)).toBe(false);
    expect(ready().qualifies(p,url)).toBe(false);
  });
  it.each([" and sign in", " and visit /account", " แล้วไปหน้า /account"])("retains other navigation/authentication commands %s", suffix => {
    expect(isHttpBarrierReportTask(prompt+suffix)).toBe(false);
  });
  it("supports a different permission denial without copying the prompt's subtype", () => {
    const p=`Open ${url} and report HTTP403 insufficient permission`;
    const tracker=new ApiErrorInspection();
    tracker.navigate(url,{...nav,errorKind:"insufficient_permission"});
    tracker.snapshot({...snap,errorDocumentText:"Insufficient Permission: role viewer needs admin"});
    expect(tracker.qualifies(p,url)).toBe(true);
  });
  it.each([
    {errorDocumentText:undefined},{errorDocumentText:""},{errorDocumentStatus:200},
    {loaderId:"other"},{frameId:"other"},{targetId:undefined},{challengeDetected:true},
  ])("requires current response and document evidence %j", change=>{
    const tracker=new ApiErrorInspection();tracker.navigate(url,nav);tracker.snapshot({...snap,...change});
    expect(tracker.qualifies(prompt,url)).toBe(false);
  });
  it("does not derive an expired session from the prompt or tab title",()=>{
    const tracker=new ApiErrorInspection();tracker.navigate(url,nav);
    tracker.snapshot({...snap,errorDocumentText:undefined,title:"Session Expired",tree:prompt});
    expect(tracker.qualifies(prompt,url)).toBe(false);
  });
  it("does not exempt a CAPTCHA403 or unknown response status",()=>{
    for(const change of [{errorKind:"challenge",challengeDetected:true},{httpStatusStatus:"unknown"}]){
      const tracker=new ApiErrorInspection();tracker.navigate(url,{...nav,...change});tracker.snapshot(snap);
      expect(tracker.qualifies(prompt,url)).toBe(false);
    }
    expect(verifyWebGoal(prompt,{actionsAttempted:1,lastActionOk:false,currentUrl:url,apiErrorInspection:ready(),challengeDetected:true}).ok).toBe(false);
  });
  it("retains observed generic denial when no subtype is present, without requiring login",()=>{
    const tracker=new ApiErrorInspection();tracker.navigate(url,{...nav,errorKind:"auth_or_forbidden"});
    tracker.snapshot({...snap,errorDocumentText:"403 Forbidden"});
    expect(tracker.qualifies(prompt,url)).toBe(true);
  });
  it("does not accept a challenge introduced into the same document after navigation",()=>{
    const tracker=new ApiErrorInspection();tracker.navigate(url,nav);
    tracker.snapshot({...snap,errorDocumentText:"Verify you are human — Turnstile challenge"});
    expect(tracker.qualifies(prompt,url)).toBe(false);
  });
  it("refuses real repeated requests and remediation before dispatch without destroying observed evidence",()=>{
    const tracker=new ApiErrorInspection();
    expect(httpBarrierToolRefusal(prompt,"browser_navigate",{url},tracker)).toBeUndefined();
    tracker.navigate(url,nav);tracker.snapshot(snap);
    for(const name of ["shell","web_fetch","web_search","browser_inspect","computer_act","browser_act","browser_clear_origin_storage","list_secrets","request_secret","secret_request","browser_navigate"]){
      expect(httpBarrierToolRefusal(prompt,name,{url},tracker)).toBeTruthy();
      // A refusal happens before the dispatcher's mutation invalidation.
      expect(tracker.qualifies(prompt,url)).toBe(true);
    }
    expect(httpBarrierToolRefusal(prompt,"browser_snapshot",{},tracker)).toBeUndefined();
    expect(httpBarrierToolRefusal(prompt,"computer_observe",{},tracker)).toBeUndefined();
  });
  it("retains no-repeat memory after losing body evidence, and clears it only for a newly authorized intent",()=>{
    const tracker=ready();
    tracker.snapshot({...snap,loaderId:"changed"});
    expect(tracker.qualifies(prompt,url)).toBe(false);
    expect(httpBarrierToolRefusal(prompt,"browser_navigate",{url},tracker)).toBeTruthy();
    tracker.reset();
    expect(tracker.qualifies(prompt,url)).toBe(false);
    expect(httpBarrierToolRefusal(prompt,"browser_navigate",{url},tracker)).toBeUndefined();
  });
  it("does not navigate to another URL even before a barrier has been observed",()=>{
    expect(httpBarrierToolRefusal(prompt,"browser_navigate",{url:"https://portal.example.test/login"},new ApiErrorInspection())).toBeTruthy();
  });
  it("does not impose report-only tool restrictions on explicitly requested authentication or CLI work",()=>{
    expect(httpBarrierToolRefusal(prompt+" แล้วเข้าสู่ระบบ","browser_act",{},ready())).toBeUndefined();
    const cli=`Use curl in shell to inspect ${url} and report HTTP403`;
    expect(isHttpBarrierReportTask(cli)).toBe(false);
    expect(httpBarrierToolRefusal(cli,"shell",{},new ApiErrorInspection())).toBeUndefined();
  });
});
