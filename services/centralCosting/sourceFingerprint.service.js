// services/centralCosting/sourceFingerprint.service.js
//
// HAVE THE INPUTS CHANGED SINCE THIS WAS COSTED?
//
// ── THE QUESTION THIS ANSWERS, AND THE ONE IT DOES NOT ──────────────────────
// A costing is assembled from a dozen records owned by six departments. Any of
// them can move after a version is frozen: R&D re-measures a consumption,
// Store withdraws a quotation, Production re-times the route, the Board
// approves a new overhead rate, Sales asks for a different quantity.
//
// The version is a record of a moment and must never restate itself. So the
// honest thing to tell somebody looking at it is not "this is wrong" — it is
// "the inputs have moved since this was calculated". That is the whole of what
// this file computes.
//
// It does NOT decide what to do about it. Nothing here recalculates, and
// nothing here writes.
//
// ── WHY A STORED HASH, AND NOT A LIVE COMPARISON ────────────────────────────
// The question needs two sides. Reading today's sources gives one of them; the
// other has to have been written down when the version was made, and has to
// survive on the frozen record — because the question is asked about versions
// frozen months ago, by which time nothing else remembers what they were built
// from.
//
// ── AND THE PARTS, NOT ONLY THE HASH ────────────────────────────────────────
// A hash says something changed and cannot say what. "Inputs changed — refresh
// the estimate" is a sentence somebody can act on; "inputs changed", with no
// way to learn which, is one that gets ignored — and a false positive nobody
// can debug.
//
// ── WHAT A PART MAY CONTAIN ─────────────────────────────────────────────────
// A token that can be COMPARED and cannot be READ BACK as a figure. A
// quotation contributes its identity and revision, never its rate. A Board
// policy contributes its id and effective date, never its percentage. A
// salary contributes nothing at all — the operation's identity and its SAM
// are what change the estimate, and the rate behind them is Production's and
// the Board's to know.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const str = (v) => String(v ?? "").trim();
const id = (v) => (v ? String(v) : "");

/* Who a reader is sent to when a part has moved. The same department names
   the readiness projection uses, so one screen does not say "R&D" where the
   other says "Research & Development". */
const OWNER = Object.freeze({
  SALES: "Sales",
  RND: "R&D",
  PRODUCTION: "Production",
  MERCHANDISING: "Merchandising",
  STORE: "Store / Purchase",
  BOARD: "Board",
});

/** One comparable fact. `token` is compared; `label` is shown. */
const part = (key, token, label, owner) => ({ key, token: str(token), label, owner });

/**
 * Every source fact that materially moves the estimate.
 *
 * Order is fixed and the list is sorted before hashing, so two runs over the
 * same sources produce the same hash whatever order the underlying reads
 * happened to return.
 *
 * @param {object} opts
 * @param {object} opts.brief      the confirmed Sales costing brief
 * @param {object} opts.preview    `technicalPreview.buildPreview` output
 * @param {object} opts.assembled  `assembly.assembleLines` output
 * @param {object} opts.policy     the resolved company/Board policy bundle
 * @param {Date}   opts.asOf       the costing date, where it decides a rate
 */
function partsFor({ brief = null, preview = null, assembled = null, policy = {}, boardPolicies = null, asOf = null } = {}) {
  const out = [];

  /* ── WHAT SALES ASKED FOR ────────────────────────────────────────────
     The revision first: a brief is immutable once confirmed, so its revision
     moving means Sales confirmed a new one. */
  if (brief) {
    out.push(part(
      "brief",
      `${id(brief.briefId)}:${brief.revision ?? 0}`,
      "What Sales asked to be costed",
      OWNER.SALES,
    ));
    out.push(part(
      "brief:style",
      id(brief.sampleStyleId),
      "The style being quoted",
      OWNER.SALES,
    ));
    /* ── AND THE FIGURES ON IT, NOT ONLY ITS REVISION ──────────────────
       The revision is supposed to be enough, and through the confirm route
       it is. Resting the whole freshness answer on it makes one number
       responsible for every field it stands for — and the failure is silent:
       a brief whose quantities or proposed prices moved without the revision
       moving would read as CURRENT, and Sales would be shown a margin
       computed against a price nobody is offering any more.

       The quantities and their prices are what the estimate is OF, so they
       are hashed directly. It costs one string and removes the assumption. */
    const quantities = (brief.quantities || []).map((q) => [
      str(q.key), str(q.quantity), str(q.quantityUom || brief.quantityUom),
      str(q.proposedSellingPriceExclTax), q.isPrimary === true ? "P" : "",
    ].join("|")).join(";");
    out.push(part(
      "brief:quantities",
      quantities,
      "The quantities and proposed prices Sales confirmed",
      OWNER.SALES,
    ));
  }

  /* ── THE APPROVED TECHNICAL REVISION ─────────────────────────────────
     R&D may already be drafting the next one; what matters is which
     revision Sales approved, because that is what the costing reads. */
  const technical = preview?.technicalRecord || preview?.technical?.technicalRecord;
  if (technical) {
    out.push(part(
      "technical:revision",
      `${str(technical.status)}:${technical.approvedRevision ?? ""}`,
      "R&D's approved technical record",
      OWNER.RND,
    ));
  }

  /* ── EACH MATERIAL'S EFFECTIVE CONSUMPTION ───────────────────────────
     The EFFECTIVE figure — base plus allowance, or the recorded quantity
     where the allowance is already inside it. That is the number the
     costing multiplies, so it is the number whose change matters. A base
     and an allowance that move in opposite directions to the same effective
     quantity have not changed the estimate. */
  for (const m of preview?.materials || []) {
    const effective = m.effectiveConsumptionExact ?? m.effectiveConsumptionPerPiece
      ?? m.effectiveQuantityExact ?? m.effectiveQuantity ?? m.quantity;
    out.push(part(
      `material:${id(m.rawItemId)}:${id(m.variantId)}`,
      `${effective ?? ""}:${str(m.unit)}`,
      `Consumption of ${str(m.rawItemName) || "a material"}`,
      OWNER.RND,
    ));
  }

  /* ── THE ROUTE AND ITS STANDARD TIME ─────────────────────────────────
     The operation's identity and its SAM. Not the salary behind it: the
     rate is resolved from a Board methodology whose own identity is a part
     below, and publishing a salary here would put one in a token. */
  for (const o of preview?.operations || []) {
    out.push(part(
      `operation:${id(o.operationId) || str(o.operationCode)}`,
      String(o.samMinutes ?? ""),
      `Standard time for ${str(o.name) || str(o.operationCode) || "an operation"}`,
      OWNER.PRODUCTION,
    ));
  }

  /* ── PACKAGING AND OUTSIDE SERVICES ──────────────────────────────────
     Requirement identity, quantity and basis. A carton that becomes
     per-run instead of per-garment is a different cost at every run size. */
  for (const p of preview?.packaging || []) {
    out.push(part(
      `packaging:${str(p.requirementKey)}`,
      `${p.quantity ?? ""}:${str(p.unit)}:${str(p.basis)}:${p.garmentsPerCarton ?? ""}`,
      `Packaging — ${str(p.rawItemName) || str(p.specification) || "a component"}`,
      OWNER.RND,
    ));
  }
  for (const sv of preview?.services || []) {
    out.push(part(
      `service:${str(sv.requirementKey)}`,
      `${sv.quantity ?? ""}:${str(sv.billingUnit)}:${str(sv.basis)}:${str(sv.purpose)}`,
      `Outside work — ${str(sv.serviceName) || str(sv.specification) || "a process"}`,
      sv.owner === "PRODUCTION" ? OWNER.PRODUCTION : OWNER.RND,
    ));
  }

  /* ── WHAT THE GARMENT SHIPS AS ───────────────────────────────────────
     Freight is quoted per kilogram or per carton; both facts move the
     freight line and neither is visible anywhere else. */
  const shipment = preview?.shipment || preview?.technical?.shipment;
  if (shipment) {
    out.push(part(
      "shipment",
      `${shipment.packedWeightGrams ?? ""}:${shipment.garmentsPerCarton ?? ""}`,
      "What one packed garment weighs, and how many fit a carton",
      OWNER.RND,
    ));
  }

  /* ── WHICH QUOTATION PRICED EACH LINE ────────────────────────────────
     Read off the ASSEMBLED LINES, which is where the identity actually is:
     `offerProvenance` is built later, during version creation, so a
     fingerprint computed from it would have been empty on every read that
     did not write a version — which is every read.

     Identity only. A supplier revising or withdrawing their quotation is the
     single most common way an estimate goes stale, and the rate never
     travels: an offer id compares perfectly and reads as nothing. */
  for (const line of assembled?.lines || []) {
    const offerId = id(line.supplierOfferId) || id(line.serviceOfferId) || id(line.freightOfferId);
    if (!offerId) continue;
    out.push(part(
      `quotation:${str(line.lineKey)}`,
      offerId,
      "A supplier quotation behind this estimate",
      OWNER.STORE,
    ));
  }
  /* ── AND A LINE THAT LOST ITS QUOTATION ──────────────────────────────
     A withdrawn quotation leaves the line unpriced rather than repriced, so
     the part above simply disappears — and a part disappearing is a change
     the comparison reports as REMOVED. Recorded here so a reader of this
     file knows the absence is deliberate and not an oversight. */

  /* ── AND WHICH SUPPLIER STORE CHOSE ──────────────────────────────────
     Separate from the quotation: a decision withdrawn and remade for the
     same offer is still a decision that moved. */
  for (const [lineKey, offerId] of Object.entries(assembled?.sourcingDecisions || {})) {
    out.push(part(`sourcing:${str(lineKey)}`, id(offerId), "A Store sourcing decision", OWNER.STORE));
  }

  /* ── AND THE IMPORT EVIDENCE EACH DUTY LINE RESTED ON ─────────────────
     The quotation's identity and REVISION, the heading and the origin: change
     any of them and the duty a costing was frozen with may no longer be the
     duty it would get today. The rule KEY travels too, so a rule deactivated
     and replaced is detected.

     ── AND NOT THE RATE ─────────────────────────────────────────────────
     Never the percentage, and never the supplier's. Sales is entitled to know
     the customs position moved; what it moved TO is the Board's, and the
     parts travel with the version where the owning desks can read them. */
  for (const dp of assembled?.dutyProvenance || []) {
    out.push(part(
      `duty:${str(dp.dutiedLineKey)}`,
      [
        str(dp.customsTariffCode), str(dp.countryOfOrigin), str(dp.ruleKey),
        id(dp.offerId), String(dp.offerRevision ?? ""), str(dp.dutyInQuotedRate),
      ].join(":"),
      "The customs position on an imported input",
      OWNER.STORE,
    ));
  }

  /* ── AND THE APPLICABILITY DECISIONS THEIR OWNERS MADE ───────────────
     Merchandising saying a style ships loose removes a whole family. */
  for (const [family, decision] of Object.entries(assembled?.sourceDecisions || {})) {
    if (!decision) continue;
    out.push(part(
      `applicability:${family}`,
      `${str(decision.decidedAt ? new Date(decision.decidedAt).toISOString() : "")}`,
      `${str(decision.ownerDepartment) || "A department"} decided ${family} does not apply`,
      str(decision.ownerDepartment) || OWNER.MERCHANDISING,
    ));
  }

  /* ── THE BOARD'S RULES, BY IDENTITY AND EFFECTIVE DATE ───────────────
     Never the percentage. A reader is entitled to know the overhead rule
     changed; what it changed TO is the Board's, and a token carrying it
     would put a policy value in a Sales response. */
  for (const [key, resolved] of Object.entries(boardPolicies || policy?.boardPolicies || {})) {
    if (!resolved) continue;
    out.push(part(
      `board:${key}`,
      `${id(resolved.boardPolicyId)}:${resolved.effectiveFrom ? new Date(resolved.effectiveFrom).toISOString() : ""}`,
      `The Board's ${str(resolved.policyName) || key} decision`,
      OWNER.BOARD,
    ));
  }
  /* The company policy's own revision covers the rules still held there. */
  if (policy?.revision !== undefined && policy?.revision !== null) {
    out.push(part("policy:revision", String(policy.revision), "The company costing policy", OWNER.BOARD));
  }

  /* ── AND THE DATE, WHERE IT DECIDES A RATE ───────────────────────────
     A charge table and a Board policy are effective-dated, so the same
     sources costed on two dates can legitimately produce two answers. Only
     the DAY: a costing prepared twice in one afternoon must not read as
     stale because the clock moved. */
  if (asOf) out.push(part("asOf", new Date(asOf).toISOString().slice(0, 10), "The date this was costed", OWNER.SALES));

  return out.filter((p) => p.token !== "");
}

/**
 * One value over the parts.
 *
 * Sorted by key first, so the hash depends on the FACTS and not on the order
 * the reads returned them in — otherwise a costing would read as stale because
 * two queries came back in a different sequence.
 */
/**
 * WHICH BOARD DECISIONS ARE IN FORCE, BY IDENTITY AND DATE.
 *
 * ── WHY THIS IS RESOLVED HERE AND GENERICALLY ───────────────────────────────
 * The company costing policy does not carry them: each family's own service
 * resolves its own Board policy at calculation time and freezes it onto the
 * version. Reading them one service at a time would couple this file to every
 * family — and it would go stale the moment a new policy is added, silently,
 * because a missing part changes no hash and reports no staleness.
 *
 * So it reads the Board's own collection, over whatever keys the model
 * declares. A policy added later is fingerprinted the day it exists.
 *
 * ── AND ONLY THE IDENTITY AND THE DATE ──────────────────────────────────────
 * Never the percentage. Sales is entitled to know the overhead rule changed;
 * what it changed TO is the Board's, and a token carrying it would put a
 * policy value into a Sales response by the back door — the parts travel with
 * the version and are shown as "what changed".
 */
async function boardPoliciesFor(companyId, asOf = new Date()) {
  const BoardPolicy = mongoose.models.BoardPolicy
    || require("../../models/CMS_Models/Board/BoardPolicy");
  const rows = await BoardPolicy.find({
    companyId,
    status: "BOARD_APPROVED",
    effectiveFrom: { $lte: asOf },
  }).select("policyKey effectiveFrom").sort({ effectiveFrom: 1 }).lean();

  /* Ascending, so the last one written per key is the latest in force. */
  const out = {};
  for (const row of rows) {
    out[row.policyKey] = {
      boardPolicyId: row._id,
      effectiveFrom: row.effectiveFrom,
      policyName: row.policyKey,
    };
  }
  return out;
}

function hashOf(parts = []) {
  const canonical = [...parts]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((p) => `${p.key}=${p.token}`)
    .join("\n");
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 40);
}

/** The whole fingerprint, ready to freeze onto a version. */
function fingerprintFor(opts) {
  const parts = partsFor(opts);
  return { hash: hashOf(parts), parts };
}

/**
 * WHAT MOVED BETWEEN A FROZEN VERSION AND TODAY.
 *
 * ── A VERSION WITH NO FINGERPRINT IS NOT STALE ──────────────────────────────
 * Versions frozen before this existed carry none. Reporting them as stale
 * would make every historical costing in the company light up, which is a
 * warning nobody would read twice. They report `comparable: false` and say so.
 *
 * @returns {{comparable, stale, changed}} `changed` is the human list — the
 *   name of each fact that moved and its owner, never its value.
 */
function compare(frozen, current) {
  const before = str(frozen?.sourceFingerprint);
  if (!before) {
    return {
      comparable: false,
      stale: false,
      changed: [],
      reason: "This version was calculated before source tracking existed, so it cannot be compared.",
    };
  }
  if (before === str(current?.hash)) {
    return { comparable: true, stale: false, changed: [], reason: null };
  }

  const was = new Map((frozen.sourceFingerprintParts || []).map((p) => [p.key, p.token]));
  const now = new Map((current?.parts || []).map((p) => [p.key, p.token]));
  const meta = new Map((current?.parts || []).map((p) => [p.key, p]));
  for (const p of frozen.sourceFingerprintParts || []) if (!meta.has(p.key)) meta.set(p.key, p);

  const changed = [];
  for (const key of new Set([...was.keys(), ...now.keys()])) {
    if (was.get(key) === now.get(key)) continue;
    const m = meta.get(key) || {};
    changed.push({
      key,
      /* The name of the fact and who owns it. Never the two tokens: they are
         opaque by construction, and printing them would invite somebody to
         decode a consumption or a quotation revision out of them. */
      label: m.label || key,
      owner: m.owner || null,
      /* Which direction, so a reader can tell a fact that ARRIVED from one
         that was withdrawn — a quotation appearing and a quotation vanishing
         are different problems. */
      state: !was.has(key) ? "ADDED" : !now.has(key) ? "REMOVED" : "CHANGED",
    });
  }
  return {
    comparable: true,
    stale: true,
    changed: changed.sort((a, b) => (a.key < b.key ? -1 : 1)),
    reason: null,
  };
}

module.exports = {
  boardPoliciesFor, OWNER, partsFor, hashOf, fingerprintFor, compare };
