// middleware/bandwidthTracker.test.js
//
// Guards the four things this meter has to get right for its numbers to mean
// anything. Each assertion below corresponds to a way the previous
// implementation was silently wrong.
//
//   npm test

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const express = require("express");
const compression = require("compression");
const bw = require("./bandwidthTracker");

bw.instrumentOutbound();

function buildApp() {
  const app = express();
  app.use(bw.middleware);
  app.use(compression({ threshold: 1024 }));

  const router = express.Router();

  router.get("/items", (_req, res) => {
    res.json(
      Array.from({ length: 2000 }, (_, i) => ({
        _id: String(i).padStart(24, "0"),
        name: "Cotton poplin shirting 44 inch",
        qty: i,
      })),
    );
  });

  // Ends with no chunk, which is how every piped Drive/PDF download in this
  // codebase finishes. Random bytes so gzip cannot flatter the result.
  router.get("/:id/download", (_req, res) => {
    res.setHeader("Content-Type", "application/octet-stream");
    for (let i = 0; i < 10; i++) res.write(crypto.randomBytes(100_000));
    res.end();
  });

  router.get("/proxy", async (_req, res) => {
    await new Promise((done) => {
      require("https")
        .get("https://example.com", (r) => { r.resume(); r.on("end", done); })
        .on("error", done);
    });
    res.json({ ok: true });
  });

  // Guards the one dangerous thing about mounting the meter above the body
  // parser: if it ever consumes the request stream, every POST in the ERP
  // silently loses its body.
  app.use(express.json());
  app.post("/api/cms/store/echo", (req, res) => res.json({ got: req.body }));

  app.use("/api/cms/store", router);
  return app;
}

test("bandwidth meter", async (t) => {
  const server = buildApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  await fetch(`${base}/api/cms/store/items`).then((r) => r.arrayBuffer());
  await fetch(`${base}/api/cms/store/6712abcdef0123456789abcd/download`).then((r) => r.arrayBuffer());
  await fetch(`${base}/api/cms/store/proxy`).then((r) => r.json()).catch(() => {});
  await new Promise((r) => setTimeout(r, 200));

  const snap = bw.snapshot();
  const routes = Object.fromEntries(snap.scopes.route.map((r) => [r.key, r]));

  await t.test("keys rows by the express route pattern, not the raw URL", () => {
    assert.ok(routes["GET /api/cms/store/:id/download"], Object.keys(routes).join(", "));
  });

  await t.test("counts bytes written to a stream that ends with no chunk", () => {
    // The old middleware only read res.end()'s argument and scored this 0.
    assert.ok(routes["GET /api/cms/store/:id/download"].bytesOut > 900_000);
  });

  await t.test("records wire bytes post-gzip and raw bytes pre-gzip", () => {
    const r = routes["GET /api/cms/store/items"];
    assert.ok(r.bytesRaw > 150_000, `raw ${r.bytesRaw}`);
    assert.ok(r.bytesOut < r.bytesRaw / 4, `wire ${r.bytesOut} vs raw ${r.bytesRaw}`);
  });

  await t.test("does not consume the request stream ahead of the body parser", async () => {
    const r = await fetch(`${base}/api/cms/store/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world", n: 42 }),
    }).then((x) => x.json());
    assert.deepStrictEqual(r.got, { hello: "world", n: 42 });
  });

  await t.test("attributes outbound bytes to both the host and the calling route", () => {
    const host = snap.scopes.outbound.find((r) => r.key.includes("example.com"));
    if (!host) return t.skip("no network");
    assert.ok(host.outBytesDown > 0);
    assert.ok(routes["GET /api/cms/store/proxy"].outBytesDown > 0);
  });

  server.close();
});
