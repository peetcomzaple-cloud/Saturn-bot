import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { expect, it } from "vitest";
import { ApiErrorInspection } from "./api-error-inspection.js";
import { browserNavigateFromTool, browserSnapshotFromTool } from "./browser-tools.js";
import { ComputerBrowserProvider } from "./computer-browser.js";
import { verifyWebGoal } from "./web-goal-verification.js";

it("carries a live-driver response identity and selected JSON body through provider/tool boundaries", async () => {
  const url = "https://example.test/api/inspect?sample=2";
  const prompt = `Inspect API response at ${url} and report its error type`;
  const commands: string[] = [];
  const provider = new ComputerBrowserProvider({liveDriver: async (_computer, request) => {
    commands.push(request.command);
    return request.command === "navigate"
      ? {ok: false, url, title: "", httpStatus: 400, httpStatusStatus: "known", frameId: "frame-1", loaderId: "loader-1", error: "HTTP400", fallback: "computer_act"}
      : {ok: true, url, title: "", tree: "JSON", elements: [], frameId: "frame-1", loaderId: "loader-1", targetId: "target-1", responseBodyText: '{"error":{"type":"schema_error","message":"missing field"}}'};
  }});
  const computer: ComputerRef = {id: "c1", botId: "b1", kind: "docker", providerRef: "c1"};
  const context: AdapterContext = {operationId: "inspect-operation", traceId: "trace", spaceId: "space", userId: "user", signal: new AbortController().signal};
  const tracker = new ApiErrorInspection();
  const navigation = await browserNavigateFromTool(provider, computer, context, {url});
  expect(navigation).toMatchObject({ok: false, httpStatus: 400, errorKind: "api_bad_request", frameId: "frame-1", loaderId: "loader-1"});
  tracker.navigate(url, navigation);
  expect(tracker.qualifies(prompt, url)).toBe(false);
  const snapshot = await browserSnapshotFromTool(provider, computer, context, {});
  tracker.snapshot(snapshot);
  expect(tracker.qualifies(prompt, url)).toBe(true);
  expect(verifyWebGoal(prompt, {actionsAttempted: 1, lastActionOk: false, currentUrl: url, apiErrorInspection: tracker})).toEqual({ok: true});
  expect(commands).toEqual(["navigate", "snapshot"]);
});

it("forwards only observed HTML403 evidence for a report-only barrier", async () => {
  const url = "https://example.test/BillingPortal";
  const prompt = `Open ${url} and report HTTP403 session expired`;
  const provider = new ComputerBrowserProvider({liveDriver: async (_computer, request) => request.command === "navigate"
    ? {ok:false,url,title:"Session Expired",httpStatus:403,httpStatusStatus:"known",frameId:"f",loaderId:"l",fallback:"computer_act",error:"403 Session Expired"}
    : {ok:true,url,title:"Session Expired",tree:"Session Expired",elements:[],frameId:"f",loaderId:"l",targetId:"t",errorDocumentStatus:403,errorDocumentText:"Session Expired"}});
  const computer: ComputerRef = {id:"c1",botId:"b1",kind:"docker",providerRef:"c1"};
  const context: AdapterContext = {operationId:"report",traceId:"trace",spaceId:"space",userId:"user",signal:new AbortController().signal};
  const tracker = new ApiErrorInspection();
  tracker.navigate(url,await browserNavigateFromTool(provider,computer,context,{url}));
  tracker.snapshot(await browserSnapshotFromTool(provider,computer,context,{}));
  expect(tracker.qualifies(prompt,url)).toBe(true);
  expect(verifyWebGoal(prompt,{actionsAttempted:1,lastActionOk:false,currentUrl:url,apiErrorInspection:tracker}).ok).toBe(true);
});
