// routes/CMS_Routes/PPC/ieReleasesRoute.js
//
// PPC'S SECOND INBOUND QUEUE: ISSUED INDUSTRIAL-ENGINEERING RELEASES.
//
// Mounted beside `inboundPacksRoute` under `/api/cms/ppc`, and built to the
// same four shapes for the same reason: a department that receives two kinds of
// handover should not have to learn two kinds of surface.
//
//   GET  /ie-releases?view=pending|decided|all&cursor=&limit=
//   GET  /ie-releases/:releaseId
//   POST /ie-releases/:releaseId/accept
//   POST /ie-releases/:releaseId/clarify
//
// ── AND THERE IS DELIBERATELY NO REJECT ─────────────────────────────────────
// No fifth route, and no state a fifth route could write — the receipt enum
// holds PPC's two answers and nothing else. PPC may ask for clarification;
// refusing an engineering standard outright is not PPC's call.
//
// ── WHAT THE REQUEST SETTLES, AND WHAT THE BODY MAY NOT ─────────────────────
// The company comes from the actor's own membership, the person from the
// verified session, the release from the path and the idempotency key from the
// header. None of the four is readable from a body, and the service refuses a
// body that tries.
"use strict";

const express = require("express");

const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const { handle, fail, sendError } = require("../../../services/storePurchase/errors");
const { ppcCapability, requirePpcCapability, CAPABILITY } = require("../../../services/ppc/access.service");
const {
  merchandisingCompanyMiddleware,
} = require("../../../services/companyContext/merchandisingScope.service");
const {
  listMembershipCompanies,
} = require("../../../services/companyContext/companyMembership.service");
const ack = require("../../../services/ppc/ieReleaseAck.service");

const router = express.Router();
router.use(EmployeeAuthMiddleware);

/* The same shared resolver the inbound-pack route uses: it answers which of the
   actor's OWN company memberships they are acting in, which has nothing to do
   with department authority. Never inferred from a body or from a release. */
const requireCompany = merchandisingCompanyMiddleware({ domainLabel: "PPC" });

/** Seeing what IE has handed down. PPC `viewer`. */
const canRead = ppcCapability(CAPABILITY.INBOUND_READ);

/**
 * Committing PPC to an engineering standard. PPC `approver`.
 *
 * The capability is the one PPC already has, but the refusal is re-coded: an
 * acknowledgement refused for want of PPC authority is a different fact from a
 * pack refused for the same reason, and `IE_RELEASE_ACKNOWLEDGEMENT_FORBIDDEN`
 * is what a caller holding an IE grant — of any level, including approver — is
 * told. Issuing is IE's and answering is PPC's, and neither role reaches the
 * other's verb.
 */
const canDecide = async (req, res, next) => {
  try {
    req.ppcRole = await requirePpcCapability(req, CAPABILITY.INBOUND_DECIDE);
    return next();
  } catch (err) {
    if (err?.code === "FORBIDDEN") {
      return sendError(res, fail("IE_RELEASE_ACKNOWLEDGEMENT_FORBIDDEN",
        "Answering an engineering release commits PPC to it, and that needs a PPC role "
        + "that allows it. An Industrial Engineering role does not.",
        err.details));
    }
    return sendError(res, err);
  }
};

const actor = (req) => (req.user?.id
  ? { id: req.user.id, name: req.user.name || "", email: req.user.email || "" }
  : null);

/* Header only. A body field could be replayed verbatim by a client that
   believed it was retrying, which is the one thing a key must never be. */
const idempotencyKey = (req) => String(req.get("Idempotency-Key") || "").trim();

/* ══ COMPANY DISCOVERY ═════════════════════════════════════════════════════
 *
 * WHICH COMPANIES THIS PERSON COULD OPEN A QUEUE FOR.
 *
 * ── WHY IT IS REGISTERED FIRST, AND WITHOUT `requireCompany` ───────────────
 * Every other route on this router resolves an acting company before it does
 * anything. This one CANNOT: it exists to supply the choices from which an
 * acting company is picked, so requiring one would make it answerable only to
 * somebody who already had the answer. A multi-company PPC user would be locked
 * out of the very list that would let them in.
 *
 * ── AND WHY IT STILL SITS BEHIND PPC'S OWN GRANT ───────────────────────────
 * Not requiring a company is not the same as not requiring authority. The list
 * is behind `ppc.inbound.read`, the same capability the queue itself is behind,
 * because "which companies could I do PPC work in" is a PPC question. An IE,
 * Merchandising, Production or platform-administrator identity with no PPC
 * grant learns nothing here — `access.service.js` already refuses each of them,
 * and `isAdmin` grants nothing.
 *
 * ── THE ANSWER IS THE ACTOR'S OWN MEMBERSHIPS, AND NOTHING ELSE ────────────
 * `listMembershipCompanies` is the shared rule every domain uses, reused rather
 * than re-implemented: a PPC copy of the membership query is a second place for
 * the rule to drift. It returns the actor's ACTIVE memberships, deduplicated by
 * company and ordered by display name, carrying exactly `companyId` and
 * `displayName`. No address, no tax registration, no books date, no
 * configuration and no membership internals — a chooser needs a name and an id.
 *
 * Nothing narrows it: an `X-Costing-Company` header is not read here, no
 * company is accepted from a body or query, and no company is chosen on the
 * caller's behalf. Selecting is the person's act, and it happens next.
 */
router.get("/companies", canRead, handle(async (req, res) => {
  const { companies } = await listMembershipCompanies(req.user);
  return res.json({ success: true, companies });
}));

/** The queue — what IE has issued to this company, and what PPC has said. */
router.get("/ie-releases", requireCompany, canRead, handle(async (req, res) => {
  const out = await ack.listReleases(req.merchandising, {
    view: req.query.view, cursor: req.query.cursor, limit: req.query.limit,
  });
  return res.json({ success: true, ...out });
}));

/** One release, as an allowlisted handover — never as IE's workspace. */
router.get("/ie-releases/:releaseId", requireCompany, canRead, handle(async (req, res) => {
  const out = await ack.readRelease(req.merchandising, { releaseId: req.params.releaseId });
  return res.json({ success: true, ...out });
}));

/** ACCEPT — PPC commits to the standard as issued. Takes no business fields. */
router.post("/ie-releases/:releaseId/accept", requireCompany, canDecide, handle(async (req, res) => {
  const out = await ack.accept(req.merchandising, {
    releaseId: req.params.releaseId, body: req.body || {},
    actor: actor(req), idempotencyKey: idempotencyKey(req),
  });
  return res.json({ success: true, ...out });
}));

/** CLARIFY — a category and a reason an industrial engineer can act on. */
router.post("/ie-releases/:releaseId/clarify", requireCompany, canDecide, handle(async (req, res) => {
  const out = await ack.requestClarification(req.merchandising, {
    releaseId: req.params.releaseId, body: req.body || {},
    actor: actor(req), idempotencyKey: idempotencyKey(req),
  });
  return res.json({ success: true, ...out });
}));

module.exports = router;
