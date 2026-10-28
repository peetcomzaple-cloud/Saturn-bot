import { type ToolCallStreak, trackToolCallStreak } from "@rakazo/core";

// Same tool, same arguments, this many times in a row means the agent is stuck, not paginating.
const MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS = 6;

export interface ExtendedToolCallStreak extends ToolCallStreak {
  lastOutput?: string;
}

export type ToolCallStreakWithOutput = ExtendedToolCallStreak;

function normalizeToolOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output ?? "");
}

export function recordToolResult(
  streak: ExtendedToolCallStreak,
  output: unknown,
): ExtendedToolCallStreak {
  const serialized = normalizeToolOutput(output);
  if (streak.lastOutput !== undefined && streak.lastOutput !== serialized) {
    return {
      ...streak,
      count: 0,
      lastOutput: serialized,
    };
  }
  return {
    ...streak,
    lastOutput: serialized,
  };
}

export function advanceToolCallLoopGuard(
  streak: ExtendedToolCallStreak,
  name: string,
  args: unknown,
  output?: unknown,
): { streak: ExtendedToolCallStreak; stuck: boolean } {
  let next = trackToolCallStreak(streak, name, args) as ExtendedToolCallStreak;
  if (output !== undefined) {
    next = recordToolResult({ ...next, lastOutput: streak.lastOutput }, output);
  }
  return {
    streak: next,
    stuck: next.count >= MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS,
  };
}

