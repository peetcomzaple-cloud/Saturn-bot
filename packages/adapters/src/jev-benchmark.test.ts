import { describe, expect, it } from "vitest";
import { runJevBenchmark } from "./jev-benchmark.js";
import * as fs from "node:fs";
import * as path from "node:path";

describe("Jev Benchmark & Case Results Generator", () => {
  it("executes JEV-SELECTOR (J01-J14) and JEV-UI-ACTOR (1-5) scenarios and writes JEV_CASE_RESULTS.json", async () => {
    const payload = await runJevBenchmark();

    expect(payload.results.length).toBe(19); // 14 selector + 5 actor cases
    expect(payload.summary.selectorPassed).toBe(14);
    expect(payload.summary.uiActorPassed).toBe(5);

    const outputPath = "C:/Users/User/Documents/Codex/2026-10-13/antigravity-chat-d-2-2/outputs/strategy-implementation-results/JEV_CASE_RESULTS.json";
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf-8");

    expect(fs.existsSync(outputPath)).toBe(true);
    const content = fs.readFileSync(outputPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.results.length).toBe(19);
  });
});
