// services/centralCosting/familyApplicability.service.js
//
// WHICH COST FAMILIES DO NOT APPLY TO THIS ORDER — READ FROM THEIR OWNERS.
//
// ── WHAT THIS REPLACED ──────────────────────────────────────────────────────
// `technicalAcknowledgements` — a list of `{key, reason}` the browser sent with
// a calculation, letting whoever was costing a garment declare a whole family
// irrelevant. It was careful about the things a payload can be careful about:
// the reason was compulsory, the vocabulary was fixed, and the decision was
// frozen with its author's name on the version.
//
// It was still the wrong desk. Whether the customer supplies the packaging is
// Merchandising's fact; whether anything is sent outside is Production's;
// whether the goods are imported is Store's; whether this order is financed is
// Sales'. A person costing a garment has none of that in front of them, and
// the reason they typed was their best guess at somebody else's answer.
//
// So Costing reads. Every decision below already lives in the record its owner
// works in, and this file resolves their PRESENCE — it writes nothing, creates
// no second copy, and cannot itself decide anything.
//
// ── AND MISSING IS NEVER "NOT APPLICABLE" ───────────────────────────────────
// The one mistake worth designing against, in each of the four resolvers: an
// empty list, an absent sub-document or a failed read must never come back as
// an answer. Absent stays absent, the family stays outstanding, and the costing
// stays incomplete — which is the true statement.
//
// ── WHAT LEAVES THIS FILE ───────────────────────────────────────────────────
// A state, a reason somebody wrote, who wrote it and when, and the record it
// came from. No rate, no supplier, no quotation, no policy value.
"use strict";

const styleApplicability = require("../styleApplicability");
const sourcingEvidence = require("../storePurchase/sourcingEvidence.service");

const str = (v) => String(v ?? "").trim();

/* ── WHO MAY DECIDE A FAMILY DOES NOT APPLY, AND WHERE ──────────────────────
 *
 * The audit that opened this task, encoded. A family absent from this table
 * can NEVER be inapplicable — no record answers it, and offering an escape
 * would be the acknowledgement back under another name.
 *
 * `materials`   a garment is made of something. A style with no bill of
 *               materials is an unfinished record, not a free garment.
 * `operations`  a blank route is missing Production work. Fully outsourced
 *               manufacture would be a manufacturing-method decision plus the
 *               external service requirement to match, and this repository
 *               records neither — so it is not offered as though it did.
 * `overhead`    the Board's rate, including an approved zero. An operational
 *               user cannot declare the company has no overhead.
 * `freight`     Sales' arrangement already produces a RECORDED ZERO line for
 *               a customer who collects, which is an ANSWER and needs no
 *               family decision. A delivered order therefore has no escape.
 * `financing`   the same shape: Sales' stated not-applicable condition already
 *               produces a nil line with its reason on it.
 */
const APPLICABILITY_OWNER = Object.freeze({
  packaging: {
    department: "Merchandising",
    recordedIn: "Style · Packaging components",
    /* The words a Costing reader is shown when it is unanswered. Names the
       desk and the screen; carries no fact of theirs. */
    unansweredMessage: "Merchandising has not said whether this style is packed.",
  },
  services: {
    department: "Production",
    recordedIn: "Style · Outside processes",
    unansweredMessage: "Production has not said whether anything on this style is sent outside.",
  },
  development: {
    department: "Merchandising",
    recordedIn: "Style · Development and tooling",
    unansweredMessage: "Merchandising has not said whether this style needs development or tooling work.",
  },
  duty: {
    department: "Store / Purchase",
    recordedIn: "Supplier quotations · sourcing origin",
    unansweredMessage: "Store has not said whether these materials are bought in India or imported.",
  },
});

/** Can this family ever be declared inapplicable by anybody? */
const canBeInapplicable = (familyKey) => Boolean(APPLICABILITY_OWNER[str(familyKey)]);

/** One resolved decision, in the shape `costCoverage` reads. */
function decision(familyKey, { reason, decidedByName = "", decidedByActorId = null, decidedAt = null, basis }) {
  const owner = APPLICABILITY_OWNER[familyKey];
  return {
    key: familyKey,
    reason,
    decidedByName,
    decidedByActorId,
    decidedAt,
    /* Where the decision was made, so a frozen version says which record
       answered rather than "marked not applicable on this version". */
    basis,
    ownerDepartment: owner?.department || null,
    recordedIn: owner?.recordedIn || null,
  };
}

/**
 * The three decisions a style carries, from the departments that own them.
 *
 * Reads the NARROW PROJECTION `technicalSource.readStyleFacts` publishes —
 * `{ packaging, outsideProcesses, development }`, each already reduced to a
 * state, a reason and a signature — rather than the stored document. One read
 * of the style, one place that knows where on it these three fields live.
 *
 * A raw style is accepted too, for the one caller that has the document and
 * not the facts.
 *
 * Pure: no database, no context, exported so every branch is exercisable
 * without a live registry. A rule reachable only through a route is a rule
 * nobody checks.
 */
function styleDecisions(source) {
  const out = {};
  if (!source) return out;
  /* Either shape, resolved once. `decisionView` is idempotent on its own
     output, so a projection passes through unchanged. */
  const style = source.applicability || source;
  const raw = {
    packaging: style.packaging ?? source.materials?.packagingDecision,
    outsideProcesses: style.outsideProcesses ?? source.sample?.outsideProcessDecision,
    development: style.development ?? source.sample?.developmentDecision,
  };

  const pack = styleApplicability.decisionView(raw.packaging);
  if (pack.state === styleApplicability.DECISION.NOT_REQUIRED) {
    out.packaging = decision("packaging", {
      reason: pack.reason,
      decidedByName: pack.decidedByName,
      decidedByActorId: pack.decidedByActorId,
      decidedAt: pack.decidedAt,
      basis: "Merchandising recorded that this style needs no packaging",
    });
  }

  const outside = styleApplicability.decisionView(raw.outsideProcesses);
  if (outside.state === styleApplicability.DECISION.NOT_REQUIRED) {
    out.services = decision("services", {
      reason: outside.reason,
      decidedByName: outside.decidedByName,
      decidedByActorId: outside.decidedByActorId,
      decidedAt: outside.decidedAt,
      basis: "Production recorded that nothing on this style is sent outside",
    });
  }

  const dev = styleApplicability.decisionView(raw.development);
  if (dev.state === styleApplicability.DECISION.NOT_REQUIRED) {
    out.development = decision("development", {
      reason: dev.reason,
      decidedByName: dev.decidedByName,
      decidedByActorId: dev.decidedByActorId,
      decidedAt: dev.decidedAt,
      basis: "Merchandising recorded that this style needs no development or tooling",
    });
  }

  return out;
}

/**
 * CUSTOMS DUTY — AND ONLY THE CUSTOMS HALF OF IT.
 *
 * ── TWO QUESTIONS SHARE THIS FAMILY, AND ONE DECISION ANSWERS ONE ───────────
 * `duty` gates `DUTY` and `NON_RECOVERABLE_TAX`. Store stating that every
 * material is bought in India settles the first: there is no customs entry, so
 * there is no duty. It says nothing whatever about GST.
 *
 * The GST half is answered elsewhere and is left there: the company policy
 * states whether input GST is recoverable, and each quotation carries its own
 * rate and basis. A company that has not stated a treatment already blocks per
 * line — so this requires the treatment to be PRESENT before the family may
 * close, or a domestic style would quietly clear a tax question nobody
 * answered.
 *
 * ── AND A FAILED READ IS NOT A DOMESTIC SUPPLY ──────────────────────────────
 * `evidenceForItems` throwing, or returning nothing, resolves to no decision
 * at all. The family stays outstanding, which is what "we could not check"
 * honestly is.
 */
async function dutyDecision(ctx, { itemIds = [], policySnapshot = {} } = {}) {
  const ids = [...new Set((itemIds || []).map(str).filter(Boolean))];
  if (!ids.length) return null;
  /* The company's answer to the OTHER question in this family. Absent means
     nobody has stated it, and it blocks per line already. */
  if (!str(policySnapshot.inputGstTreatment)) return null;

  let rows = [];
  try {
    const ev = await sourcingEvidence.evidenceForItems(
      { companyId: ctx?.companyId }, { itemIds: ids },
    );
    rows = ev?.items || [];
  } catch (e) {
    return null;
  }
  if (!rows.length) return null;

  const roll = sourcingEvidence.rollUp(rows);
  if (roll.state !== sourcingEvidence.EVIDENCE.NOT_APPLICABLE) return null;

  return decision("duty", {
    reason: `Every material on this style is bought in India, so there is no customs entry. `
      + `Input GST is treated as ${str(policySnapshot.inputGstTreatment).toLowerCase().replace("_", "-")} `
      + "and is applied per line from the quotation.",
    basis: "Store recorded domestic sourcing on every material's quotation",
    /* No actor: this is a roll-up of many quotations, each signed by whoever
       recorded it. Naming one of them would be a signature nobody gave. */
  });
}

/**
 * EVERY SOURCE-OWNED APPLICABILITY DECISION FOR ONE COSTING.
 *
 * @param {object} ctx              company scope
 * @param {object} opts
 * @param {object|null} opts.style  the SampleStyle, already proved to belong
 *   to this company by the caller. Never re-fetched here: a second read is a
 *   second ownership rule that can drift from the first.
 * @param {string[]} opts.itemIds   the style's material items, for Store
 * @param {object} opts.policySnapshot  the company policy this costing uses
 */
async function resolve(ctx, { style = null, itemIds = [], policySnapshot = {} } = {}) {
  const decisions = styleDecisions(style);
  const duty = await dutyDecision(ctx, { itemIds, policySnapshot });
  if (duty) decisions.duty = duty;
  return decisions;
}

module.exports = {
  APPLICABILITY_OWNER, canBeInapplicable,
  styleDecisions, dutyDecision, resolve,
};
