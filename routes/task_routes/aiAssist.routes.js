/**
 * routes/task_routes/aiAssist.routes.js
 *
 * REGISTER in server.js:
 *   app.use("/cowork", require("./routes/task_routes/aiAssist.routes"));
 *
 * ENDPOINT:
 *   POST /cowork/ai/assist
 *   Auth: Bearer <Firebase ID token>, same convention as every other
 *   `/cowork` route (see Middlewear/coworkAuth.js).
 *
 *   Body: {
 *     surface: "docs" | "sheets",
 *     instruction: string,
 *     context: { summary: string },
 *     history?: { role: "user" | "assistant", text: string }[]
 *   }
 *
 * This route authenticates the caller, validates the shape of the request,
 * and asks `services/aiAssist.service.js` to talk to Gemini. What it returns
 * is a PROPOSAL — a tool name and arguments, or a plain-text reply — never a
 * write to any store. The frontend is the only thing that ever turns a
 * returned action into an actual document or sheet change, through the real
 * editor APIs, after its own validation and (for anything destructive) a
 * confirmation step. This route could be completely wrong about what it
 * proposes and nothing in Cowork's data would move.
 */

const express = require("express");
const router = express.Router();
const { verifyCoworkToken, verifyEmployeeToken } = require("../../Middlewear/coworkAuth");
const { assist, isConfigured, MODEL } = require("../../services/aiAssist.service");

const MAX_INSTRUCTION_LENGTH = 1500;
/* The context summary is built by the frontend from the selection and a small
   amount of surrounding material — see the frontend's `lib/rules/workspace/ai`.
   Bounded here too, independently, because a route must not trust a client's
   own claim about how much it sent. */
const MAX_CONTEXT_LENGTH = 12_000;
const MAX_HISTORY_TURNS = 6;

router.get("/ai/assist/status", verifyCoworkToken, verifyEmployeeToken, (req, res) => {
  res.json({ configured: isConfigured(), model: MODEL });
});

router.post("/ai/assist", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const body = req.body || {};

    const surface = body.surface;
    if (surface !== "docs" && surface !== "sheets") {
      return res.status(400).json({ error: 'surface must be "docs" or "sheets".' });
    }

    const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
    if (!instruction) {
      return res.status(400).json({ error: "An instruction is required." });
    }
    if (instruction.length > MAX_INSTRUCTION_LENGTH) {
      return res.status(400).json({ error: `Keep the instruction under ${MAX_INSTRUCTION_LENGTH} characters.` });
    }

    const contextSummary =
      body.context && typeof body.context.summary === "string" ? body.context.summary : "";
    if (contextSummary.length > MAX_CONTEXT_LENGTH) {
      return res.status(400).json({
        error: "That is too much context for the assistant. Select a smaller range and try again.",
      });
    }

    const history = Array.isArray(body.history)
      ? body.history
          .filter(
            (t) =>
              t &&
              (t.role === "user" || t.role === "assistant") &&
              typeof t.text === "string" &&
              t.text.length <= MAX_INSTRUCTION_LENGTH,
          )
          .slice(-MAX_HISTORY_TURNS)
      : [];

    const outcome = await assist({ surface, instruction, contextSummary, history });

    if (!outcome.ok) {
      const status =
        outcome.reason === "not_configured" ? 503 : outcome.reason === "quota" ? 429 : 502;
      return res.status(status).json({ error: outcome.message, reason: outcome.reason });
    }

    return res.json(outcome);
  } catch (e) {
    console.error("[aiAssist] Error:", e.message);
    return res.status(500).json({ error: "The assistant request failed." });
  }
});

module.exports = router;
