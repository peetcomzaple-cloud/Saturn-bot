import type { Socket } from "node:net";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";

loadRootEnv();

const originalFetch = globalThis.fetch;
globalThis.fetch = async function(input, init) {
  let url = "";
  if (typeof input === "string") url = input;
  else if (input instanceof URL) url = input.href;
  else if (input instanceof Request) url = input.url;

  if (url.includes("127.0.0.1:16080")) {
    if (input instanceof Request) {
      input.headers.set("Origin", "http://127.0.0.1:16080");
      input.headers.set("Referer", "http://127.0.0.1:16080/");
      input.headers.set("Sec-Fetch-Site", "same-origin");
    } else {
      init = init || {};
      const headers = new Headers(init.headers);
      headers.set("Origin", "http://127.0.0.1:16080");
      headers.set("Referer", "http://127.0.0.1:16080/");
      headers.set("Sec-Fetch-Site", "same-origin");
      init.headers = headers;
    }
  }
  return originalFetch.apply(this, [input, init]);
};

import { serve } from "@hono/node-server";
import { SERVICE_NAMES } from "@rakazo/logging";
import { createRootLogger } from "@rakazo/logging/axiom";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";

const logger = createRootLogger(SERVICE_NAMES.api);

try {
  const env = loadEnv();
  const { app, stop } = await createApp({ ...env, logger });
  const server = serve({ fetch: app.fetch, port: env.port, hostname: env.apiHost }, () => {
    logger.info("api listening", { "http.host": env.apiHost, "http.port": env.port });
  });

  // Long-lived connections (threads.subscribe SSE streams) never end on their
  // own, so server.close() alone waits forever for them. Track sockets and
  // force-close any still open after a short grace period for in-flight
  // requests, or every restart/shutdown hangs until something force-kills it.
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    const grace = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
    }, 2_000);
    await closed;
    clearTimeout(grace);
    await stop();
    await logger.flush({ timeoutMs: 2_000 });
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
} catch (error) {
  logger.error("api startup failed", error);
  await logger.flush({ timeoutMs: 2_000 });
  process.exit(1);
}
