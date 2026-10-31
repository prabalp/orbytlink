import { createApp } from "./app.js";
import { createServer as createHttpServer } from "node:http";
const { app, store } = createApp();
const http = createHttpServer(app);
const serveFrontend = process.env.WORKSTATION_API_ONLY !== "true";
if (serveFrontend && process.env.NODE_ENV !== "production") {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: { middlewareMode: true, hmr: { server: http } },
    appType: "spa",
  });
  app.use(vite.middlewares);
} else if (serveFrontend) {
  const express = (await import("express")).default;
  app.use(express.static("dist"));
  app.get("/{*path}", (_req, res) => res.sendFile("index.html", { root: "dist" }));
}
const port = Number(process.env.PORT || 3100);
http.on("error", (error: NodeJS.ErrnoException) => {
  console.error(
    `OrbytLink could not listen on ${process.env.HOST || "127.0.0.1"}:${port}: ${error.code || error.message}`,
  );
  process.exit(1);
});
http.listen(port, process.env.HOST || "127.0.0.1", () =>
  console.log(`OrbytLink gateway http://127.0.0.1:${port} · MCP at /mcp`),
);
process.on("unhandledRejection", (error) =>
  console.error(`[${new Date().toISOString()}] Unhandled rejection`, error),
);
// Docker sends SIGTERM on stop/deploy: finish in-flight requests (tool calls run up to two
// minutes), then close the database cleanly. A second signal, or 130s, forces the exit.
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`OrbytLink stopping (${signal})…`);
    setTimeout(() => process.exit(1), 130_000).unref();
    http.close(() => {
      store.db.close();
      process.exit(0);
    });
    http.closeIdleConnections();
  });
