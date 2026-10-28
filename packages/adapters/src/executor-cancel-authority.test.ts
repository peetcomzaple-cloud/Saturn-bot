import { describe, expect, it } from "vitest";
import { shouldCancelComputerAttemptWork } from "./executor.js";

type Input = Parameters<typeof shouldCancelComputerAttemptWork>[0];

function validCancellation(): Input {
  return {
    currentRun: {
      id: "run", botId: "bot", spaceId: "space", status: "cancelled",
      leaseOwner: null, leaseFence: 4,
      attempts: [{ id: "attempt", runId: "run", fence: 4, status: "cancelled" }],
    },
    currentLease: { computerId: "computer", botId: "bot", runId: "run", fence: 8 },
    ownedLease: { computerId: "computer", botId: "bot", runId: "run", fence: 8 },
    runId: "run", botId: "bot", spaceId: "space", attemptId: "attempt",
    fence: 4, workerId: "worker",
  };
}

const cases: Array<[string, (input: Input) => void, boolean]> = [
  ["allows exact durable cancelled attempt and original computer lease tombstone", () => {}, true],
  ["allows cancellation retaining the original worker", (p) => { p.currentRun!.leaseOwner = "worker"; }, true],
  ...["running", "leased", "queued", "waiting_takeover", "completed", "failed"].map(
    (status): [string, (input: Input) => void, boolean] => [
      `rejects lease loss while run is ${status}`,
      (p) => { p.currentRun!.status = status; }, false,
    ],
  ),
  ["rejects stale attempt after successor acquired and cancelled the same run", (p) => {
    p.currentRun!.leaseFence = 5;
    p.currentRun!.attempts = [{ id: "next", runId: "run", fence: 5, status: "cancelled" }];
  }, false],
  ["rejects another attempt even with matching run fence", (p) => { p.currentRun!.attempts[0]!.id = "other"; }, false],
  ["rejects an attempt without durable cancellation", (p) => { p.currentRun!.attempts[0]!.status = "running"; }, false],
  ["rejects foreign attempt run", (p) => { p.currentRun!.attempts[0]!.runId = "other"; }, false],
  ["rejects foreign attempt fence", (p) => { p.currentRun!.attempts[0]!.fence = 3; }, false],
  ["protects successor computer execution lease fence", (p) => { p.currentLease!.fence = 9; }, false],
  ["protects successor computer execution run", (p) => { p.currentLease!.runId = "next"; }, false],
  ["rejects another worker owner", (p) => { p.currentRun!.leaseOwner = "other"; }, false],
  ["rejects foreign bot", (p) => { p.currentRun!.botId = "other"; }, false],
  ["rejects foreign space", (p) => { p.currentRun!.spaceId = "other"; }, false],
  ["rejects foreign computer", (p) => { p.currentLease!.computerId = "other"; }, false],
  ["rejects missing durable run", (p) => { p.currentRun = null; }, false],
  ["rejects missing current computer lease", (p) => { p.currentLease = null; }, false],
  ["rejects missing original computer lease", (p) => { p.ownedLease = null; }, false],
  ["rejects missing exact attempt", (p) => { p.currentRun!.attempts = []; }, false],
];

describe("cancelled computer attempt authority", () => {
  it.each(cases)("%s", (_name, mutate, expected) => {
    const input = validCancellation();
    mutate(input);
    expect(shouldCancelComputerAttemptWork(input)).toBe(expected);
  });
});
