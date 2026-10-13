"use strict";
/**
 * routes/ai/storeCommandSearch.js — the command palette's Store endpoint.
 *
 * ── WHY IT IS ITS OWN DOOR ────────────────────────────────────────────────
 * The assistant's endpoint can reach a language model; this one cannot. They
 * answer different questions and must be impossible to confuse: a palette
 * request that fell through to the assistant would be exactly the dependence
 * on Qwen this endpoint exists to remove.
 *
 * Authentication is the same middleware every other CMS route uses. The
 * company, the capabilities and the field projection are resolved INSIDE the
 * service, from the database — never from anything the browser sent.
 */

const express = require("express");

const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");
const commandSearch = require("../../services/ai/storeCommandSearch.service");

/* ── THE OPTIONAL ROUTER ─────────────────────────────────────────────────
   Off unless STORE_COMMAND_ROUTER is set, and then consulted only for words
   the grammar could not place (see `routeUnplaced` in the service). Loaded
   here, not in the service, so the deterministic path never requires a
   model; with the variable unset this endpoint is exactly what it was. */
const wordsRouter = process.env.STORE_COMMAND_ROUTER
  // eslint-disable-next-line global-require
  ? require("../../services/ai/storeCommandRouter").routerFromEnv()
  : null;

const router = express.Router();


router.post("/store/command-search", EmployeeAuthMiddleware, async (req, res) => {
  const user = req.user;
  if (!user || !user.id) {
    /* The middleware already guarantees this. Failing closed regardless. */
    return res.status(401).json({ success: false, message: "Authentication required." });
  }

  const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  if (!query) return res.status(400).json({ success: false, message: "A query is required." });
  if (query.length > commandSearch.MAX_QUERY) {
    return res.status(400).json({
      success: false,
      message: `That search is too long. Keep it under ${commandSearch.MAX_QUERY} characters.`,
    });
  }

  /* A selection carries the identity the person picked, never a route, a
     field or a filter. Anything else in the body is ignored. */
  /* ── A SELECTION CARRIES CANONICAL IDENTITY ONLY ──────────────────────
     The capability, the concept, the entity type and the record's own id.
     No label, no route, no field list, no filter — the server re-derives
     everything else, and re-authorises all of it. */
  const resolution = req.body?.resolution && typeof req.body.resolution === "object"
    ? {
      tool: String(req.body.resolution.tool || "").slice(0, 80),
      concept: String(req.body.resolution.concept || "").slice(0, 160) || null,
      entityType: String(req.body.resolution.entityType || "").slice(0, 80) || null,
      recordId: String(req.body.resolution.recordId || "").slice(0, 100),
    }
    : null;

  try {
    const out = resolution?.recordId
      ? await commandSearch.resolveChoice({ user, resolution })
      : await commandSearch.search({ user, query, router: wordsRouter });

    if (out.state === "unauthorised") {
      /* Said plainly rather than as an empty result: "nothing matched" and
         "you may not read this" are different facts. */
      return res.status(403).json({
        success: false,
        state: "unauthorised",
        message: "You do not have Store access.",
      });
    }
    /* The closed response contract the browser validates: a state, an
       optional sentence, and the groups. Nothing else crosses. */
    return res.json({
      success: true,
      state: out.state,
      note: out.note || null,
      groups: Array.isArray(out.groups) ? out.groups : [],
    });
  } catch (err) {
    console.error("[store command-search]", err);
    return res.status(500).json({
      success: false,
      message: "That search could not be completed.",
    });
  }
});

module.exports = router;
