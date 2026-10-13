"use strict";

const http = require("http");

const HOST = "127.0.0.1";
const PORT = Number(process.env.GRAV_VOICE_PLIVO_PROXY_PORT || 5052);
const TARGET_BASE = "http://127.0.0.1:5050";
const PATHS = new Set([
  "/api/cms/voice/plivo/inbound",
  "/api/cms/voice/plivo/inbound/status",
]);
const MAX_BODY_BYTES = 32 * 1024;

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (!PATHS.has(requestUrl.pathname) || !["GET", "POST"].includes(req.method)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }

  let size = 0;
  const chunks = [];
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) req.destroy();
    else chunks.push(chunk);
  });
  req.on("end", async () => {
    if (size > MAX_BODY_BYTES) {
      res.writeHead(413, { "content-type": "text/plain; charset=utf-8" });
      return res.end("Request too large");
    }
    try {
      const targetUrl = `${TARGET_BASE}${requestUrl.pathname}${requestUrl.search}`;
      const forwardedHeaders = {
        "content-type": req.headers["content-type"] || "application/x-www-form-urlencoded",
        "x-forwarded-host": req.headers["x-forwarded-host"] || req.headers.host || "",
        "x-forwarded-proto": req.headers["x-forwarded-proto"] || "https",
      };
      for (const name of ["x-plivo-signature-v3", "x-plivo-signature-ma-v3", "x-plivo-signature-v3-nonce"]) {
        if (req.headers[name]) forwardedHeaders[name] = req.headers[name];
      }
      const upstream = await fetch(targetUrl, {
        method: req.method,
        headers: forwardedHeaders,
        body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") || "text/plain; charset=utf-8",
        "content-length": String(body.length),
        "cache-control": "no-store",
      });
      return res.end(body);
    } catch (error) {
      console.error("[plivo-local-proxy]", error?.message || error);
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      return res.end("Local Voice backend unavailable");
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[plivo-local-proxy] only Plivo inbound webhook paths are available on http://${HOST}:${PORT}`);
});

function stop() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
