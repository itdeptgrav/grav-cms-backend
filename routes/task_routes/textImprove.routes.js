/**
 * routes/task_routes/textImprove.routes.js
 *
 * REGISTER in server.js:
 *   app.use("/cowork", require("./routes/task_routes/textImprove.routes"));
 *
 * ENDPOINT:
 *   POST /cowork/ai/improve-text
 *   Auth: Bearer <Firebase ID token>, same convention as every other
 *   `/cowork` route (see Middlewear/coworkAuth.js).
 *
 *   Body: {
 *     text: string,          // required for every mode except "custom", where an
 *                             // empty string means "write this for me from scratch"
 *     mode: "grammar" | "rephrase" | "shorten" | "lengthen" | "custom",
 *     instruction?: string,  // required, non-empty when mode === "custom"
 *     surface?: "mail-subject" | "mail-body" | "task-title" | "task-description" | "task-criterion",
 *                             // what the text actually is, so an email body gets a real structure
 *                             // (greeting/paragraphs/sign-off) instead of the same treatment as a
 *                             // one-line task title. Falls back to a generic framing when omitted.
 *   }
 *   Response: { ok: true, text: string, model: string }
 *
 * Used by the small "improve with AI" popup on plain task-form text fields
 * (title, description, acceptance criteria) — distinct from `/cowork/ai/assist`,
 * which drives the Docs/Sheets tool-calling assistant.
 */

const express = require("express");
const router = express.Router();
const { verifyCoworkToken, verifyEmployeeToken } = require("../../Middlewear/coworkAuth");
const { improveText, isConfigured, MODEL } = require("../../services/textAssist.service");

const MAX_TEXT_LENGTH = 4000;
const MAX_INSTRUCTION_LENGTH = 300;
const MODES = ["grammar", "rephrase", "shorten", "lengthen", "custom"];
const SURFACES = ["mail-subject", "mail-body", "task-title", "task-description", "task-criterion"];

router.post("/ai/improve-text", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const body = req.body || {};

    const mode = body.mode;
    if (!MODES.includes(mode)) {
      return res.status(400).json({ error: `mode must be one of: ${MODES.join(", ")}.` });
    }

    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text && mode !== "custom") {
      return res.status(400).json({ error: "Text is required." });
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return res.status(400).json({ error: `Keep the text under ${MAX_TEXT_LENGTH} characters.` });
    }

    let instruction;
    if (mode === "custom") {
      instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
      if (!instruction) {
        return res.status(400).json({ error: "An instruction is required for custom mode." });
      }
      if (instruction.length > MAX_INSTRUCTION_LENGTH) {
        return res.status(400).json({ error: `Keep the instruction under ${MAX_INSTRUCTION_LENGTH} characters.` });
      }
    }

    const surface = SURFACES.includes(body.surface) ? body.surface : undefined;

    const outcome = await improveText({ text, mode, instruction, surface });

    if (!outcome.ok) {
      /* `bad_key` joins `not_configured` at 503: a rejected credential is this
         server being misconfigured, not the upstream being broken, and 502
         told the browser console the opposite. */
      const status =
        outcome.reason === "not_configured" || outcome.reason === "bad_key"
          ? 503
          : outcome.reason === "quota"
            ? 429
            : 502;
      return res.status(status).json({ error: outcome.message, reason: outcome.reason });
    }

    return res.json(outcome);
  } catch (e) {
    console.error("[textImprove] Error:", e.message);
    return res.status(500).json({ error: "The assistant request failed." });
  }
});

router.get("/ai/improve-text/status", verifyCoworkToken, verifyEmployeeToken, (req, res) => {
  res.json({ configured: isConfigured(), model: MODEL });
});

module.exports = router;
