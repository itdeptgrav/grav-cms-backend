/**
 * GET /cowork/link-preview?url=... — unfurl a URL for the chat composer.
 *
 * Behind `verifyCoworkToken`/`verifyEmployeeToken` like every other `/cowork`
 * route: unlike the media proxy (`mediaUpload.js`'s `/media/view/:fileId`,
 * which an `<img src>` calls and so cannot carry an Authorization header),
 * this is always called from application JS via `fetch`, which can — so
 * there is no reason to leave it open. Gating it also means the per-employee
 * rate limit below actually limits a PERSON rather than an IP shared by an
 * office full of them.
 *
 * Answers 200 with `{ ok:false, ... }` for every failure short of a bad or
 * missing `url` — a broken link is not a server error, and treating it as
 * one would make the composer's fetch throw instead of just finding nothing
 * to show.
 */

const express = require("express");
const router = express.Router();
const { verifyCoworkToken, verifyEmployeeToken } = require("../../Middlewear/coworkAuth");
const { getLinkPreview } = require("../../services/linkPreview.service");

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 30;
const hits = new Map(); // employeeId -> timestamps[]

const sweeper = setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [id, arr] of hits) {
    const live = arr.filter((t) => t > cutoff);
    if (live.length) hits.set(id, live);
    else hits.delete(id);
  }
}, 5 * 60 * 1000);
if (typeof sweeper.unref === "function") sweeper.unref();

function rateLimited(employeeId) {
  const now = Date.now();
  const arr = (hits.get(employeeId) || []).filter((t) => t > now - WINDOW_MS);
  arr.push(now);
  hits.set(employeeId, arr);
  return arr.length > MAX_PER_WINDOW;
}

router.get("/link-preview", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  const { url } = req.query;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ ok: false, error: "url required" });
  }
  if (rateLimited(req.coworkUser.employeeId)) {
    return res.status(429).json({ ok: false, error: "Too many preview requests. Try again in a moment." });
  }
  try {
    const preview = await getLinkPreview(url);
    res.json(preview);
  } catch (e) {
    console.error("[link-preview]", e.message);
    res.json({ ok: false, url, domain: null, reason: "server_error" });
  }
});

module.exports = router;
