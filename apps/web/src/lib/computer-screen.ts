import { errorText } from "./user-error";

export interface ComputerScreenResult {
  url: string | null;
  error: string | null;
}

/** Only the latest request for the visible computer may replace its screen or error. */
export async function loadComputerScreen(options: {
  load: () => Promise<{ url: string | null }>;
  isCurrent: () => boolean;
  commit: (result: ComputerScreenResult) => void;
  fallbackError: string;
}): Promise<string | null> {
  let result: ComputerScreenResult;
  try {
    const screen = await options.load();
    result = { url: screen.url, error: null };
  } catch (error) {
    result = {
      url: null,
      error: errorText(error, options.fallbackError),
    };
  }
  if (!options.isCurrent()) return null;
  options.commit(result);
  return result.url;
}

export function embeddableScreenUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, window.location.href);
    const page = new URL(window.location.href);
    const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    const pagePort = page.port || (page.protocol === "https:" ? "443" : "80");
    if (local && parsed.port && parsed.port !== pagePort) {
      return null;
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function screenIframeSandbox(url: string | null) {
  if (!url) return undefined;
  try {
    return new URL(url, window.location.href).pathname.startsWith("/novnc/")
      ? "allow-scripts allow-pointer-lock"
      : undefined;
  } catch {
    return undefined;
  }
}

export function isSameScreenGeneration(
  a: { display?: string; generation?: number; computerId?: string } | undefined,
  b: { display?: string; generation?: number; computerId?: string } | undefined,
): boolean {
  if (!a || !b) return false;
  return (
    a.display === b.display &&
    a.generation === b.generation &&
    a.computerId === b.computerId
  );
}

export function sanitizeWebScreenIdentity<T extends Record<string, unknown>>(
  identity: T | undefined,
): Omit<T, "viewToken" | "controlToken" | "token"> | undefined {
  if (!identity || typeof identity !== "object") return undefined;
  const { viewToken, controlToken, token, ...rest } = identity as Record<string, unknown>;
  return rest as Omit<T, "viewToken" | "controlToken" | "token">;
}
