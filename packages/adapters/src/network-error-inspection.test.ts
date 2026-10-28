import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { expect, it } from "vitest";
import { ApiErrorInspection, httpBarrierToolRefusal, isNetworkErrorReportTask } from "./api-error-inspection.js";
import { browserNavigateFromTool } from "./browser-tools.js";
import { ComputerBrowserProvider } from "./computer-browser.js";
import { verifyWebGoal } from "./web-goal-verification.js";

const url = "https://portal.example.test:18443/";
const thai = `เปิดเว็บไซต์ทดสอบ ${url} แล้วรายงานข้อผิดพลาดใบรับรอง TLS ตามที่เบราว์เซอร์พบจริง ห้ามข้ามคำเตือนหรือปิดการตรวจสอบใบรับรองครับ`;
const english = `Open ${url} and report the certificate error without bypassing warnings`;
const failure = {url,error:"net::ERR_CERT_AUTHORITY_INVALID",tree:"Privacy error",fallback:"computer_act" as const};
function ready(value: unknown = failure) {
  const tracker = new ApiErrorInspection();
  tracker.navigate(url,value);
  return tracker;
}
function goal(prompt = thai, tracker = ready(), currentUrl = url) {
  return verifyWebGoal(prompt,{actionsAttempted:1,lastActionOk:false,lastActionVerified:false,currentUrl,apiErrorInspection:tracker});
}

it("carries the helper's real error-only shape through the production provider and tool",async () => {
  const provider = new ComputerBrowserProvider({liveDriver:async () => failure});
  const computer: ComputerRef = {id:"c1",botId:"b1",kind:"docker",providerRef:"c1"};
  const context: AdapterContext = {operationId:"report",traceId:"trace",spaceId:"space",userId:"user",signal:new AbortController().signal};
  const result = await browserNavigateFromTool(provider,computer,context,{url});
  expect(result).toMatchObject({url,error:failure.error});
  expect(goal(thai,ready(result)).ok).toBe(true);
});

it.each([thai,english,`Open ${url} and report the DNS failure`])("allows reporting the actual invocation failure: %s",prompt => {
  expect(isNetworkErrorReportTask(prompt)).toBe(true);
  expect(goal(prompt).ok).toBe(true);
});
it("supports an actual name-resolution error",() => {
  expect(goal(`Open ${url} and report the DNS failure`,ready({...failure,error:"net::ERR_NAME_NOT_RESOLVED"})).ok).toBe(true);
});
it.each([
  {...failure,url:"https://other.example.test/"},
  {...failure,error:undefined},
  {...failure,error:"invented ERR_CERT_AUTHORITY_INVALID"},
  {...failure,error:"ERR_UNKNOWN"},
  {...failure,ok:true},
  {...failure,httpStatus:200,httpStatusStatus:"known"},
  {...failure,httpStatus:403},
  {url,tree:"net::ERR_CERT_AUTHORITY_INVALID"},
])("does not qualify absent, conflicting or unbound failures: %o",value => {
  expect(goal(thai,ready(value)).ok).toBe(false);
});
it.each([" แล้วคลิก Advanced"," แล้วดาวน์โหลดรายงาน"," แล้วอ่านข้อมูลในหน้าเว็บ"," แล้วเปิดเว็บไซต์ต่อ",
  " แล้วอ่านเนื้อหาในหน้าเว็บ"," และเปิดเว็บไซต์ต่อ"," แล้วดูเนื้อหาเว็บ"," แล้วสรุปเนื้อหาในหน้าเว็บ",
  " then summarize the page"," then repair the certificate"," and read the page"," then retry"," then click Advanced"," and run openssl"]) (
  "does not turn a second goal into report-only: %s",suffix => {
    expect(isNetworkErrorReportTask(thai+suffix)).toBe(false);
    expect(goal(thai+suffix).ok).toBe(false);
  });
it("does not infer network-error intent from a URL alone",() => {
  expect(isNetworkErrorReportTask("Open https://tls.example.test/ and report its sales metrics")).toBe(false);
});
it("invalidates failures when navigation, snapshot context, mutation or reset changes the state",() => {
  for (const change of [
    (t: ApiErrorInspection) => t.navigate(url,{ok:true,url}),
    (t: ApiErrorInspection) => t.snapshot({ok:true,url:"chrome-error://chromewebdata/",tree:failure.error}),
    (t: ApiErrorInspection) => t.snapshot({ok:true,url:"https://other.example.test/"}),
    (t: ApiErrorInspection) => t.invalidate(),
    (t: ApiErrorInspection) => t.reset(),
  ]) {
    const tracker = ready(); change(tracker);
    expect(goal(thai,tracker).ok).toBe(false);
  }
  expect(goal(thai,ready(),"https://other.example.test/").ok).toBe(false);
});
it("prevents state changes and probes before dispatch, but permits the first requested navigation",() => {
  expect(httpBarrierToolRefusal(thai,"browser_navigate",{url},new ApiErrorInspection())).toBeUndefined();
  expect(httpBarrierToolRefusal(thai,"browser_navigate",{url:"https://other.example.test/"},new ApiErrorInspection())).toBeTruthy();
  for (const tool of ["browser_act","computer_act","shell","web_fetch","browser_inspect","browser_clear_origin_storage","browser_tab_close","request_secret"]) {
    expect(httpBarrierToolRefusal(thai,tool,{},ready())).toBeTruthy();
  }
  expect(httpBarrierToolRefusal(thai,"browser_navigate",{url},ready())).toBeTruthy();
  expect(httpBarrierToolRefusal(thai,"computer_observe",{},ready())).toBeUndefined();
});
