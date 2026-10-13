"use strict";
/**
 * routes/ai/commandSearchMisses.js — a search Cmd/Ctrl K could not answer.
 *
 * ── WHY IT IS ITS OWN DOOR ────────────────────────────────────────────────
 * The palette's search endpoint (routes/ai/storeCommandSearch.js) is
 * read-only, and a test holds it to exactly one read route. This one WRITES —
 * a row in the anonymous misses list — so it lives apart, where the write is
 * the whole of what it does and nobody can mistake it for part of a search.
 *
 * Sent by the browser when somebody leaves the palette without choosing after
 * a search that found nothing. Only the words arrive; the search is run AGAIN
 * here as this person and kept only if it still finds nothing, so the list
 * cannot be written to by claiming a miss. Nothing about the person is
 * stored — see models/CMS_Models/AI/CommandSearchMiss.js. Always 204: it is a
 * note, and the palette never waits for it.
 */

const express = require("express");

const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");
const commandSearch = require("../../services/ai/storeCommandSearch.service");
const { recordIfMiss } = require("../../services/ai/commandSearchMisses");

const router = express.Router();

router.post("/store/command-search/miss", EmployeeAuthMiddleware, async (req, res) => {
  const query = typeof req.body?.query === "string" ? req.body.query : "";
  if (req.user?.id && query.trim()) {
    try {
      await recordIfMiss({
        app: "store",
        query,
        search: ({ query: q }) => commandSearch.search({ user: req.user, query: q }),
      });
    } catch (err) {
      console.error("[store command-search miss]", err?.message || err);
    }
  }
  return res.status(204).end();
});

/* ── THE SAME NOTE, FROM THE BOOKS ──────────────────────────────────────
   Accounting's palette runs on the accounting session, so its misses come
   through the accounting door: the org session (`orgAuth`), the right to READ
   (`canView` — saving the words someone typed is not editing the books, and a
   viewer's misses count too), and the company check. The search is re-run as
   this person, for this company, and kept only if it still finds nothing.
   Same anonymous list, `app: "accounting"`. */
const accOrgAuth = require("../../Middlewear/AccountantOrgAuthMiddleware");
const { requireCapability } = require("../../Middlewear/AccountantAuthMiddleware");
const accountingSearch = require("../../services/ai/accountingCommandSearch.service");

router.post(
  "/accounting/command-search/miss",
  (req, res, next) => accOrgAuth.orgAuth(req, res, next),
  requireCapability("canView"),
  (req, res, next) => accOrgAuth.requireCompanyScope(req, res, next),
  async (req, res) => {
    const query = typeof req.body?.query === "string" ? req.body.query : "";
    if (req.user?.id && req.companyId && query.trim()) {
      try {
        await recordIfMiss({
          app: "accounting",
          query,
          search: ({ query: q }) => accountingSearch.search({ companyId: req.companyId, query: q }),
        });
      } catch (err) {
        console.error("[accounting command-search miss]", err?.message || err);
      }
    }
    return res.status(204).end();
  },
);

/* ── AND FROM HR ──────────────────────────────────────────────────────────
   HR's palette runs on the CMS session, but HR decides who is HR — so its
   misses come through HR's own check: the session read the way hrContract
   reads it (`seedIdentity`, which keeps the token's subject type the legacy
   HR login needs), and `hr.access` resolved from the database. The search is
   re-run with this person's HR capabilities and kept only if it still finds
   nothing. Same anonymous list, `app: "hr"`. Not under /api/hr: there, a POST
   is a write the department's approval queue would hold. */
const { seedIdentity, requireHrCapability } = require("../../Middlewear/hrContract");
const { resolveHrActor } = require("../../services/access/hrAuthorization");
const { CAPABILITIES: HR } = require("../../services/access/hrCapabilities");
const hrSearch = require("../../services/ai/hrCommandSearch.service");

router.post(
  "/hr/command-search/miss",
  (req, res, next) => { seedIdentity(req); next(); },
  requireHrCapability(HR.HR_ACCESS),
  async (req, res) => {
    const query = typeof req.body?.query === "string" ? req.body.query : "";
    if (query.trim()) {
      try {
        const actor = await resolveHrActor(req.user);
        await recordIfMiss({
          app: "hr",
          query,
          search: ({ query: q }) => hrSearch.search({ capabilities: actor.capabilities, query: q }),
        });
      } catch (err) {
        console.error("[hr command-search miss]", err?.message || err);
      }
    }
    return res.status(204).end();
  },
);

module.exports = router;
