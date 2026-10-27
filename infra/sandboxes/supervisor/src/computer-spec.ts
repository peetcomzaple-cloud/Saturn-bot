import { createHash } from "node:crypto";
import path from "node:path";
import { MAX_DESKTOP_DISPLAY, screenPorts } from "@rakazo/core/node/desktop-runtime";
import type Docker from "dockerode";

export const COMPUTER_IMAGE = "rakazo-computer:local";
export const COMPUTER_UID = 1000;
export const COMPUTER_GID = 1000;
export const COMPUTER_USER = `${COMPUTER_UID}:${COMPUTER_GID}`;

export { screenPorts };
export const COMPUTER_CONTROL_PORT = 7070;
export const SCREEN_HOST = process.env.SANDBOX_SCREEN_HOST ?? "127.0.0.1";
export type ScreenNetworkMode = "published" | "internal" | "isolated";

export function resolveTeamScreenLimit(value = process.env.SANDBOX_TEAM_SCREEN_LIMIT): number {
  if (value === undefined || value.trim() === "" || isUnlimited(value)) return MAX_DESKTOP_DISPLAY;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error(
      "SANDBOX_TEAM_SCREEN_LIMIT must be a positive integer, or 0 for no configured cap",
    );
  }
  return Math.min(limit, MAX_DESKTOP_DISPLAY);
}

export function resolveSpaceComputerLimit(
  value = process.env.SANDBOX_MAX_COMPUTERS_PER_SPACE,
): number {
  if (value === undefined || value.trim() === "" || isUnlimited(value)) return 0;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error(
      "SANDBOX_MAX_COMPUTERS_PER_SPACE must be a positive integer, or 0 for no configured cap",
    );
  }
  return limit;
}

function isUnlimited(value: string): boolean {
  return value.trim() === "0" || value.trim().toLowerCase() === "unlimited";
}
