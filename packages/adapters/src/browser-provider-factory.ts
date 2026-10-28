import type { BrowserProvider, SandboxProvider } from "@rakazo/adapter-kit";
import { EmulatorBrowserProvider } from "./browser-emulator.js";
import { ComputerBrowserProvider } from "./computer-browser.js";
import { FakeBrowserProvider, type FakeBrowserProviderOptions } from "./fake-browser.js";
import { SpikeBrowserProvider } from "./browser-provider-spike.js";

export type CreateBrowserProviderOptions = FakeBrowserProviderOptions & {
  sandbox?: SandboxProvider;
};

/**
 * Resolve the deployment page-browser provider.
 *
 * Production default is always `computer` (live CDP on the bot computer via
 * ComputerBrowserProvider). Fake and emulator are selected only when
 * BROWSER_PROVIDER=fake or emulator for offline conformance. Real computers
 * never report detached DOM success; they use the live page path or return
 * computer_act fallback. This slot is not Playwright/Puppeteer as a product.
 */
export function resolveBrowserProviderKind(source: NodeJS.ProcessEnv = process.env): string {
  const raw = source.BROWSER_PROVIDER?.trim().toLowerCase();
  if (!raw || raw === "computer" || raw === "sandbox") return "computer";
  if (raw === "fake") return "fake";
  if (raw === "emulator") return "emulator";
  if (raw === "playwright" || raw === "playwright-cdp" || raw === "spike-playwright") return "playwright-cdp";
  if (raw === "agent-browser" || raw === "spike-agent-browser") return "agent-browser";
  return raw;
}

export function createBrowserProvider(
  kind?: string,
  options?: CreateBrowserProviderOptions,
): BrowserProvider {
  const resolved = (kind ?? resolveBrowserProviderKind()).trim() || resolveBrowserProviderKind();
  switch (resolved) {
    case "computer":
    case "sandbox":
    case "":
      return new ComputerBrowserProvider(options);
    case "fake":
      return new FakeBrowserProvider(options);
    case "emulator":
      return new EmulatorBrowserProvider(options);
    case "playwright":
    case "playwright-cdp":
    case "spike-playwright":
      return new SpikeBrowserProvider({ kind: "playwright-cdp" });
    case "agent-browser":
    case "spike-agent-browser":
      return new SpikeBrowserProvider({ kind: "agent-browser" });
    default:
      throw new Error(`Unknown browser provider "${resolved}"`);
  }
}
