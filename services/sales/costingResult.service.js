// services/sales/costingResult.service.js
//
// WHAT SALES MAY SEE OF AN ESTIMATE.
//
// ── THE RULE, AND WHY IT IS A SERVER RULE ───────────────────────────────────
// Sales is entitled to the commercial answer: what to quote, where a proposed
// price sits against the company's own guidance, and whether it needs
// approval. Sales is not entitled to what the garment is made of, who supplies
// it, what that supplier charges, what an operator earns, or what percentage
// the Board set.
//
// Shaping that on the client would be a decision about confidentiality taken
// in a place anybody can read. This builds the response field by field, so a
// field that is not written cannot leak — and a field ADDED to a version later
// does not silently start travelling.
//
// ── AND IT DOES NOT WIDEN THE EXISTING BOUNDARY ─────────────────────────────
// `visibility.js` already decides what each capability may read. This does not
// grant anything: it takes the caller's own capability set and publishes a
// subset of what that set already permits. A Sales reader with no
// `costing.cost.read` gets no cost figure here either.
"use strict";

const { CAPABILITIES, hasAll } = require("../centralCosting/capabilities");
const profitBridge = require("../centralCosting/profitBridge");

const C = CAPABILITIES;
const str = (v) => String(v ?? "").trim();
const num = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * WHICH PRICING CONTRACT PRICED THIS SCENARIO.
 *
 * ── READ FROM THE VERSION, NEVER FROM THE COMPANY'S POLICY TODAY ────────────
 * A frozen version records how IT was priced. Asking today's policy instead
 * would relabel every historical version the moment management changed the
 * rule — and a costing approved under the band would start claiming a floor it
 * was never judged against.
 *
 * The two subdocuments are mutually exclusive by construction: the engine
 * writes `floor` under the markup contract and `prices` under the retired
 * band. Neither means the scenario was never priced.
 */
const CONTRACT = Object.freeze({
  MARKUP_FLOOR_V2: "MARKUP_FLOOR_V2",
  MARGIN_BAND_V1: "MARGIN_BAND_V1",
});

function contractOf(s) {
  if (s?.floor) return CONTRACT.MARKUP_FLOOR_V2;
  if (s?.prices?.minimum) return CONTRACT.MARGIN_BAND_V1;
  return null;
}

/**
 * WHERE A PROPOSED PRICE SITS AGAINST THE FLOOR, IN SALES' WORDS.
 *
 * Three states and no fourth. `POLICY_MISSING` is emphatically not "fine": a
 * price cannot clear a floor that does not exist, and saying nothing would let
 * it read as approval.
 */
const FLOOR_STATUS = Object.freeze({
  AT_OR_ABOVE_FLOOR: "AT_OR_ABOVE_FLOOR",
  BELOW_FLOOR: "BELOW_FLOOR",
  UNAVAILABLE: "UNAVAILABLE",
});

const FLOOR_STATUS_LABEL = Object.freeze({
  [FLOOR_STATUS.AT_OR_ABOVE_FLOOR]: "At or above floor",
  [FLOOR_STATUS.BELOW_FLOOR]: "Below floor — management approval required",
  [FLOOR_STATUS.UNAVAILABLE]: "Floor unavailable / inputs incomplete",
});

/** The retired band standings, kept so a frozen version still reads back. */
const BAND_STANDINGS = Object.freeze(["BELOW_MINIMUM", "WITHIN_POLICY", "MEETS_TARGET", "NO_POLICY"]);

/** Words Sales uses. Never "costing workspace", and never an engine term. */
const WORDS = Object.freeze({
  awaitingInputs: "Awaiting inputs",
  estimateReady: "Estimate ready",
  inputsChanged: "Inputs changed",
  approvalRequired: "Approval required",
  prepare: "Prepare estimate",
  refresh: "Refresh estimate",
});

/**
 * ONE SCENARIO, AS SALES MAY READ IT.
 *
 * ── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────────────
 * No line, no material, no supplier, no quotation reference, no rate, no
 * salary, no cost-per-minute, no policy percentage, no tax working, no
 * contingency figure, no other department's evidence. None of it is filtered
 * out — it is never read in the first place.
 *
 * @param {object} s     one frozen scenario off the version
 * @param {Set}    caps  the caller's own capability set
 */
function scenarioFor(s, caps, { currency = "INR" } = {}) {
  const out = {
    key: str(s.key),
    label: str(s.label) || str(s.key),
    quantity: str(s.quantity),
    quantityUom: str(s.quantityUom) || null,
    currency,
  };

  /* ── WHAT IT COSTS TO MAKE, ONLY WHERE ALREADY PERMITTED ────────────
     `costing.cost.read` is the existing gate on internal cost. A Sales
     reader who does not hold it sees the price guidance and no cost, which
     is a complete and useful answer — the guidance is what they quote
     against. */
  if (hasAll(caps, C.COST_READ)) {
    out.unitCostMinor = num(s.unitCostMinor);
    out.totalCostMinor = num(s.totalCostMinor);
  }

  /* ── AND WHAT TO QUOTE ──────────────────────────────────────────────
     One number under the current contract, three under the retired one, and
     never a mixture. Which it is comes from the version itself — a scenario
     that was priced by a markup HAS a `floor` subdocument and a scenario
     priced by the old band HAS `prices` — so a reader never has to infer the
     contract from which fields happen to be null. */
  if (hasAll(caps, C.OUTPUT_READ) || hasAll(caps, C.MARGIN_READ)) {
    const contract = contractOf(s);
    out.pricingContract = contract;

    if (contract === CONTRACT.MARKUP_FLOOR_V2) {
      /* ── THE FLOOR, ALONE ─────────────────────────────────────────
         The lowest price this quantity may be sold at. Deliberately the
         only figure: `floorMarkupPercent`, `trueUnitCostMinor` and
         `markupAmountMinor` sit on the same subdocument and none of them
         is read here. Publishing the markup would disclose the Board's
         decision; publishing the cost, or the markup AMOUNT beside the
         floor, would disclose the cost by subtraction. */
      out.floorPriceMinor = num(s.floor?.floorPriceMinor);
      /* ── AND NO FALLBACK TO THE RETIRED TIERS ─────────────────────
         Not even when `floorPriceMinor` is null. A floor-priced version
         that could not be priced has NO price to quote, and answering
         with a minimum from a band it was never judged by would be a
         number nobody approved. */
      out.guidance = null;
    } else if (contract === CONTRACT.MARGIN_BAND_V1) {
      /* ── HISTORY, READ BACK EXACTLY AS FROZEN ─────────────────────
         A version that froze three prices keeps showing three prices. It
         is never recomputed into a floor: the band it was judged by was
         the company's policy on the day it was approved, and restating it
         under today's markup would rewrite what was actually decided. */
      out.guidance = {
        minimumPriceMinor: num(s.prices?.minimum?.priceMinor),
        targetPriceMinor: num(s.prices?.target?.priceMinor),
        preferredPriceMinor: num(s.prices?.preferred?.priceMinor),
      };
      out.floorPriceMinor = null;
    } else {
      /* Priced by neither — an uncalculated or blocked scenario. Both are
         published as absent rather than as zero. */
      out.floorPriceMinor = null;
      out.guidance = null;
    }

    /* Prepaid freight recovered at cost, beside the prices rather than
       inside them: a margin on somebody's own reimbursement is not a margin
       anybody agreed to. The AMOUNT crosses; the transporter does not. */
    out.separateFreightMinor = num(s.recoveredSeparatelyMinor) || 0;
  }

  return out;
}

/**
 * WHERE A PROPOSED PRICE SITS, AND WHETHER IT NEEDS APPROVAL.
 *
 * ── THE STANDING, NOT THE BAND ──────────────────────────────────────────────
 * `BELOW_MINIMUM` tells Sales they need approval. The percentage they fell
 * short by, and the percentage the Board requires, are the Board's — and a
 * reader who learns "you are 3% under a 22% floor" has learned the floor.
 *
 * Read from the frozen bridge where the version has one, so what Sales is told
 * matches what was actually judged rather than a recomputation that could
 * disagree with it.
 */
function marginFor(version, scenarioKey, {
  floorPriceMinor = null, proposedPriceMinor = null, pricingContract = null,
} = {}) {
  /* ── THE BRIDGE LIVES AT `commercial.bridge` ─────────────────────────
     Not `margin.bridge`. That is the SERIALISED name `visibility.js` gives
     it for an API response; the stored document has always called it
     `commercial`. This function was reading the serialised path while its
     caller passed the raw version, so it matched nothing and every scenario
     came back `priced: false` — a standing that never appeared, and a test
     that passed because it hand-built the shape it was looking for.

     Both are accepted now, raw first, so the function works on whichever
     shape a caller genuinely has. */
  const rows = version?.commercial?.bridge
    || version?.margin?.bridge?.scenarios
    || [];
  const row = rows.find((x) => str(x.scenarioKey) === str(scenarioKey)) || null;

  const frozenStanding = row ? (str(row.standing) || null) : null;
  const frozenFloor = row ? num(row.floorPriceMinor) : null;
  const proposed = proposedPriceMinor === null || proposedPriceMinor === undefined
    ? (row ? num(row.proposedPriceExclTaxMinor) : null)
    : num(proposedPriceMinor);
  const floor = floorPriceMinor === null || floorPriceMinor === undefined
    ? frozenFloor
    : num(floorPriceMinor);

  /* ── A HISTORICAL BAND VERSION IS NOT JUDGED IN FLOOR WORDS ──────────
     `BELOW_MINIMUM` and `BELOW_FLOOR` are different business rules, decided
     under different policies. Reporting the first as the second would claim
     a version was measured against a markup floor that did not exist when it
     was approved — and `WITHIN_POLICY` or `MEETS_TARGET` would read as
     clearing a floor nobody ever applied to them.

     So the floor vocabulary is reserved for `MARKUP_FLOOR_V2` entirely. A
     band version keeps its own standing and its own sentence, carries no
     floor status at all, and cannot raise the new approval indicator: the
     exception it might once have needed was an exception to a band, and that
     policy is retired. It is marked historical so a screen can say so rather
     than presenting a superseded judgement as current. */
  const isBandStanding = BAND_STANDINGS.includes(frozenStanding);
  if (isBandStanding || pricingContract === CONTRACT.MARGIN_BAND_V1) {
    return {
      priced: Boolean(row),
      /* Said explicitly, so nothing downstream has to infer it from the
         absence of a floor status. */
      historical: true,
      standing: frozenStanding,
      /* The sentence written when the decision was taken, unchanged. */
      standingLabel: profitBridge.STANDING_LABEL?.[frozenStanding]
        || (row ? str(row.standingLabel) || null : null),
      floorStatus: null,
      floorStatusLabel: null,
      /* ── AND NEVER THE NEW INDICATOR ─────────────────────────────
         Management approval against a floor cannot be required by a
         version that was never judged against one. */
      approvalRequired: false,
    };
  }

  /* ── THE FROZEN VERDICT FIRST, ALWAYS ────────────────────────────────
     Where the engine judged this price under the CURRENT contract, Sales is
     told what it judged. A second opinion computed here could disagree with
     the record — and the record is what was actually decided. */
  let status = null;
  if (frozenStanding === "AT_OR_ABOVE_FLOOR") status = FLOOR_STATUS.AT_OR_ABOVE_FLOOR;
  else if (frozenStanding === "BELOW_FLOOR") status = FLOOR_STATUS.BELOW_FLOOR;
  else if (frozenStanding === "POLICY_MISSING") status = FLOOR_STATUS.UNAVAILABLE;
  else if (proposed !== null && floor !== null) {
    /* ── AND ONLY THEN, THE COMPARISON ───────────────────────────────
       Sales has proposed a price the engine has not yet judged — they typed
       one after the last calculation. Comparing two published figures is
       not a re-costing: no rate is re-read and no policy is applied.

       EQUAL COUNTS AS AT OR ABOVE. The floor is the lowest price the
       company will sell at, so selling exactly at it is permitted; `>`
       would demand a price strictly above the floor and send perfectly
       good quotations for approval. */
    status = proposed >= floor ? FLOOR_STATUS.AT_OR_ABOVE_FLOOR : FLOOR_STATUS.BELOW_FLOOR;
  } else if (proposed !== null) {
    /* A price with nothing to judge it against. */
    status = FLOOR_STATUS.UNAVAILABLE;
  }

  return {
    priced: Boolean(row) || proposed !== null,
    historical: false,
    /* The engine's own word, unchanged. */
    standing: frozenStanding,
    standingLabel: profitBridge.STANDING_LABEL?.[frozenStanding]
      || (row ? str(row.standingLabel) || null : null),
    /* ── WHAT SALES ACTS ON ──────────────────────────────────────────
       One of three states, and the sentence for it. Never the percentage
       they fell short by, never the markup, and never the cost — a reader
       told "3% under a 20% floor" has learned the floor AND the markup. */
    floorStatus: status,
    floorStatusLabel: status ? FLOOR_STATUS_LABEL[status] : null,
    /* Below the floor cannot be quoted without management agreeing. An
       unavailable floor is NOT approval-required: there is nothing to
       approve an exception to, and it belongs to whoever configures the
       policy. */
    approvalRequired: status === FLOOR_STATUS.BELOW_FLOOR,
  };
}

/**
 * The quantity Sales has confirmed, read off the brief the commercial line drives.
 *
 * ── WHY THE BRIEF AND NOT A SECOND LOOKUP ───────────────────────────────────
 * Confirming a commercial quantity writes a single-quantity confirmed brief on
 * Sales' behalf, and `commercialLine.costingQuantityFor` reads exactly this
 * primary quantity to decide whether a costing is in sync. Reading it here
 * from the same place keeps one answer to "how many are we pricing"; a second
 * derivation is the one that drifts.
 */
function confirmedQuantityOf(brief) {
  const qs = brief?.quantities || [];
  const primary = qs.find((q) => q?.isPrimary === true) || qs[0] || null;
  const n = Number(str(primary?.quantity));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Does this version carry a priced scenario for that quantity? */
function pricesQuantity(version, quantity) {
  if (!version || quantity === null) return false;
  return (version.scenarios || []).some((s) => Number(str(s?.quantity)) === quantity);
}

/**
 * THE WHOLE SALES-FACING RESULT.
 *
 * @param {object} opts.resolved   `costingPreparation.resolve` output
 * @param {Set}    opts.caps       the caller's own capability set
 */
function resultFor({ resolved, caps } = {}) {
  const version = resolved?.latestVersion || null;
  const approved = resolved?.approvedVersion || null;

  /* ── THE VERSION MUST PRICE THE QUANTITY SALES CONFIRMED ─────────────
     This read `approved || version`, so an APPROVED version always won. That
     is right when both price the same order and wrong the moment the
     commercial quantity moves: after a revision from 500 to 750, version 2
     is approved for 500 and version 3 is calculated for 750, and the screen
     showed version 2 — the ₹599 floor for an order nobody is placing, while
     reporting "no floor calculated" for the 750 that had in fact been
     calculated.

     So the version is chosen by the quantity first and its approval second.
     Approved still wins BETWEEN versions that price the confirmed quantity;
     it no longer wins over the quantity itself. Where neither prices it,
     nothing has changed — the old choice stands and the reader is told the
     costing has not caught up. */
  const confirmedQuantity = confirmedQuantityOf(resolved?.brief);
  const shown = pricesQuantity(approved, confirmedQuantity) ? approved
    : pricesQuantity(version, confirmedQuantity) ? version
      : (approved || version);

  /* ── AND ONLY THAT QUANTITY'S SCENARIOS TRAVEL ───────────────────────
     The frozen version keeps every scenario it was calculated with — the
     historical record is not edited. What Sales is SHOWN is the order they
     are quoting, so a superseded 500-piece floor cannot appear beside a
     confirmed 750. Filtered only where the shown version actually prices
     the confirmed quantity; a historical costing with no commercial line
     behind it publishes everything it always did. */
  const forConfirmed = pricesQuantity(shown, confirmedQuantity);
  const sourceScenarios = forConfirmed
    ? (shown.scenarios || []).filter((s) => Number(str(s?.quantity)) === confirmedQuantity)
    : (shown?.scenarios || []);

  const scenarios = sourceScenarios.map((s) => {
    const view = scenarioFor(s, caps, { currency: str(shown.baseCurrency) || "INR" });
    /* Sales' own proposal, read back from the frozen commercial block. */
    const proposed = num(
      (shown.commercial?.proposedPrices || []).find((p) => str(p.scenarioKey) === str(s.key))?.priceExclTaxMinor,
    );
    return {
      ...view,
      proposedSellingPriceExclTax: proposed,
      /* ── THE COMPARISON GETS BOTH FIGURES ────────────────────────────
         The floor comes from the scenario Sales is being shown, not from
         the bridge alone, so a price proposed since the last calculation is
         still judged against the floor that IS published rather than
         silently reported as unjudgeable. Where the engine has already
         judged it, its verdict wins — see `marginFor`. */
      margin: marginFor(shown, s.key, {
        floorPriceMinor: view.floorPriceMinor ?? null,
        proposedPriceMinor: proposed,
        /* Which contract priced THIS scenario, so the floor vocabulary is
           applied only where a floor was actually the rule. */
        pricingContract: view.pricingContract ?? null,
      }),
    };
  });

  return {
    state: resolved?.state || null,
    /* ── THE QUANTITY EVERYTHING HERE IS ABOUT ────────────────────────
       Published so a screen states it rather than deriving it, and so a
       reader can tell "the floor for 750" from "a floor". Null where no
       commercial quantity has been confirmed. */
    confirmedQuantity,
    /* ── THE ESTIMATE'S OWN IDENTITY ──────────────────────────────────
       A version number, a date and a status. Not the costing's internal
       history, not who edited it, and not how many drafts there have
       been. */
    estimate: shown
      ? {
        versionNumber: shown.versionNumber,
        status: shown.status,
        calculatedAt: shown.calculation?.calculatedAt || shown.provenance?.createdAt || null,
        currency: str(shown.baseCurrency) || "INR",
        isApproved: shown.status === "APPROVED",
        /* Whether what is shown reflects today's sources. */
        current: !resolved?.freshness?.stale,
      }
      : null,
    scenarios,
    /* ── AND WHY IT CANNOT BE PREPARED, IF IT CANNOT ──────────────────
       Grouped by the desk that answers it, with the destination where a real
       screen exists. Never a manual workaround. */
    blockers: (resolved?.blockers || []).map((b) => ({
      key: b.key,
      owner: b.owner,
      ownerApp: b.ownerApp,
      message: b.message,
      action: b.action || null,
      blocking: b.blocking === true,
    })),
    /* Which facts moved, by NAME. Never their values — the fingerprint's
       tokens are opaque by construction and never leave the server. */
    changed: (resolved?.freshness?.changed || []).map((c) => ({
      label: c.label, owner: c.owner, state: c.state,
    })),
    approvalRequired: scenarios.some((s) => s.margin?.approvalRequired),
    /* ── WHAT THIS READER MAY DO, NOT ONLY WHAT THEY MAY SEE ──────────
       Published so a screen can stop OFFERING an action the server would
       refuse. It is not the security control and must never be mistaken for
       one — the route and the preparation service both check the same
       capability, and a client that ignored this would meet
       `COSTING_PREPARE_FORBIDDEN` rather than a version.

       It is here because the alternative is worse than useless: a Sales
       viewer who may legitimately read the approved price would be shown a
       live "Prepare estimate" button, press it, and be told no. A control
       that always fails teaches people that refusals are noise. */
    permissions: {
      canPrepare: hasAll(caps, CAPABILITIES.PREPARE),
    },
  };
}

module.exports = {
  WORDS, CONTRACT, FLOOR_STATUS, FLOOR_STATUS_LABEL,
  contractOf, scenarioFor, marginFor, resultFor,
};
