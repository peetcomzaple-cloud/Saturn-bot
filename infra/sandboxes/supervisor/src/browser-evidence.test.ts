import { expect, it } from "vitest";
import { browserEvidenceContext, consumeBrowserEvidence, decodeBrowserExecutionId } from "./browser-evidence.js";

const expected = browserEvidenceContext("run-one", "execution-one");
const envelope = () => ({
  version: 1, runId: "run-one", executionId: "execution-one", command: "snapshot",
  startedAt: 1000, completedAt: 1002, complete: true,
  events: [{ at: 1001, method: "helper.selected", sessionId: "session-one", targetId: "target-one" }],
});

it.each(["net::ERR_NAME_NOT_RESOLVED", "net::ERR_NAME_RESOLUTION_FAILED"])(
  "preserves a known DNS failure from the helper while keeping the model response separate: %s",errorCode => {
    const capture = { ...envelope(), command:"navigate", events:[{at:1001,method:"Network.loadingFailed",
      sessionId:"session-one",targetId:"target-one",requestId:"request-one",urlSha256:"a".repeat(64),requestMethod:"GET",errorCode}] };
    const output = consumeBrowserEvidence({error:errorCode,_browserEvidence:capture},expected,"navigate");
    expect(output.evidence).toMatchObject({complete:true,events:[{errorCode}]});
    expect(output.result).toEqual({error:errorCode});
    const invalid = consumeBrowserEvidence({_browserEvidence:{...capture,events:[{...capture.events[0],errorCode:"private arbitrary error"}]}},expected,"navigate");
    expect(invalid.evidence).toMatchObject({complete:false,captureError:"INVALID_OR_MISSING_CAPTURE"});
    expect(JSON.stringify(invalid.evidence)).not.toContain("private");
  },
);

it("roundtrips the actual Pi JSON execution identity without renaming it", () => {
  const execution = JSON.stringify(["pi-tool", "main", "call-1"]);
  const decoded = decodeBrowserExecutionId(Buffer.from(execution).toString("base64url"));
  expect(decoded).toBe(execution);
  const context = browserEvidenceContext("run-one", decoded);
  const capture = { ...envelope(), executionId: execution };
  expect(consumeBrowserEvidence({ _browserEvidence: capture }, context, "snapshot").evidence)
    .toMatchObject({ executionId: execution, complete: true });
  for (const invalid of ["=", "eA==", "_w", "a".repeat(2732)]) {
    expect(() => decodeBrowserExecutionId(invalid)).toThrow();
  }
});

it("keeps private evidence out of the browser/model response and binds the actual operation", () => {
  const output = consumeBrowserEvidence({ ok: true, title: "Visible", _browserEvidence: envelope() }, expected, "snapshot");
  expect(output.result).toEqual({ ok: true, title: "Visible" });
  expect(output.evidence).toMatchObject({ runId: "run-one", executionId: "execution-one", complete: true });
});

it("does not infer an execution identity from missing context", () => {
  expect(browserEvidenceContext()).toBeUndefined();
  expect(() => browserEvidenceContext("run-one")).toThrow();
  expect(() => browserEvidenceContext("run-one", "bad\nvalue")).toThrow();
  const output = consumeBrowserEvidence({ ok: true, _browserEvidence: envelope() }, undefined, "snapshot");
  expect(output).toEqual({ result: { ok: true }, evidence: undefined });
});

it.each([
  { runId: "another-run" }, { executionId: "another-execution" }, { command: "act" },
  { startedAt: 1003 }, { completedAt: 1000 }, { events: [{ at: 999, method: "helper.selected" }] },
])("records a missing/invalid capture instead of qualifying mismatched evidence: %j", (patch) => {
  const output = consumeBrowserEvidence({ ok: true, _browserEvidence: { ...envelope(), ...patch } }, expected, "snapshot");
  expect(output.result).toEqual({ ok: true });
  expect(output.evidence).toMatchObject({ complete: false, captureError: "INVALID_OR_MISSING_CAPTURE" });
});

it.each(["url", "headers", "postData", "body", "tree", "title", "error"]) (
  "rejects capture with an unapproved private field: %s", (field) => {
    const capture = envelope();
    const output = consumeBrowserEvidence({ ok: true, _browserEvidence: { ...capture,
      events: [{ ...capture.events[0], [field]: "SECRET-MUST-NOT-BE-LOGGED" }] } }, expected, "snapshot");
    expect(output.evidence).toMatchObject({ complete: false });
    expect(JSON.stringify(output.evidence)).not.toContain("SECRET");
  },
);

it("preserves explicit capture incompleteness and rejects oversized journals", () => {
  const incomplete = consumeBrowserEvidence({ _browserEvidence: { ...envelope(), complete: false } }, expected, "snapshot");
  expect(incomplete.evidence).toMatchObject({ complete: false });
  const large = consumeBrowserEvidence({ _browserEvidence: { ...envelope(), events: Array(161).fill(envelope().events[0]) } }, expected, "snapshot");
  expect(large.evidence).toMatchObject({ complete: false, captureError: "INVALID_OR_MISSING_CAPTURE" });
});
