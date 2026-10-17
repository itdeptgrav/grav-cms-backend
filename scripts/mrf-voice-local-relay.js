"use strict";

/* A deliberately narrow development relay for a remote LiveKit worker. It
 * exposes only the worker-secret MRF endpoints, never the CMS API. */
require("dotenv").config();
const crypto = require("crypto");
const http = require("http");

const secret = String(process.env.MRF_VOICE_WORKER_SECRET || "");
const port = Number(process.env.MRF_VOICE_RELAY_PORT || 5061);
// Use the hostname form so Node follows the same IPv4/IPv6 loopback selection
// as the local CMS. On macOS the dev server may bind only to ::1, in which
// case a hard-coded 127.0.0.1 target makes remote workers appear to hang.
const target = new URL(process.env.MRF_VOICE_RELAY_TARGET || "http://[::1]:5050");
const allowedPath = /^\/api\/cms\/mrf-voice-approvals\/worker\/[a-f\d]{24}\/(context|turn|no-answer|speech|dialog)$/i;

function authorized(header) {
  const supplied = String(header || "").replace(/^Bearer\s+/i, "");
  return Boolean(secret && supplied.length === secret.length
    && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(secret)));
}

const server = http.createServer((req, res) => {
  const path = String(req.url || "").split("?", 1)[0];
  const action = path.match(allowedPath)?.[1];
  const methodAllowed = action === "context" ? req.method === "GET" : req.method === "POST";
  if (!action || !methodAllowed || !authorized(req.headers.authorization)) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end('{"success":false,"message":"Not found"}');
  }

  let received = 0;
  req.on("data", (chunk) => {
    received += chunk.length;
    if (received > 16 * 1024) req.destroy();
  });

  const upstream = http.request({
    hostname: target.hostname.replace(/^\[|\]$/g, ""),
    port: target.port,
    method: req.method,
    path,
    headers: {
      authorization: req.headers.authorization,
      "content-type": "application/json",
    },
  }, (upstreamResponse) => {
    res.writeHead(upstreamResponse.statusCode || 502, {
      "content-type": upstreamResponse.headers["content-type"] || "application/json",
    });
    upstreamResponse.pipe(res);
  });
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end('{"success":false,"message":"Local backend unavailable"}');
  });
  req.pipe(upstream);
});

if (!secret) throw new Error("MRF_VOICE_WORKER_SECRET is required");
server.listen(port, "127.0.0.1", () => {
  console.log(`MRF voice worker relay listening on http://127.0.0.1:${port}`);
});
