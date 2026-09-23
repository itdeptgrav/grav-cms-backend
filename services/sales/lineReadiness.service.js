// services/sales/lineReadiness.service.js
//
// IS THIS COMMERCIAL LINE READY TO BE QUOTED?
//
// ── ONE AUTHORITY, SEVERAL DOORS ────────────────────────────────────────────
// Three commands need the same answer before they may act: setting a selling
// price, raising a proforma, and pricing a quotation line. Each had its own
// version of it, and they disagreed — the selling-price gate accepted ANY floor
// on the approved version, so a floor calculated for 500 satisfied a line
// confirmed at 750.
//
// The question is one question: has somebody confirmed a quantity for this
// exact line, is the costing running for that quantity, and has a version
// produced a floor FOR THAT QUANTITY. This answers it once.
//
// ── AND IT FAILS CLOSED ─────────────────────────────────────────────────────
// Unreadable is not ready. Missing is not ready. Ambiguous is not ready. Every
// outcome except a single valid in-sync line with a matching floor is a typed
// refusal, because a check that answers "probably" is not a check.
"use strict";

const commercialLine = require("./commercialLine.service");
/* Required lazily inside the function would be tidier for a cycle; there is
   none — `commercialReview` does not require this module. */
const commercialReview = require("./commercialReview.service");
const preparation = require("./costingPreparation.service");

const str = (v) => String(v ?? "").trim();

const REASON = Object.freeze({
  LINE_NOT_FOUND: "LINE_NOT_FOUND",
  LINE_AMBIGUOUS: "LINE_AMBIGUOUS",
  QUANTITY_NOT_CONFIRMED: "QUANTITY_NOT_CONFIRMED",
  COSTING_NOT_IN_SYNC: "COSTING_NOT_IN_SYNC",
  FLOOR_NOT_AVAILABLE: "FLOOR_NOT_AVAILABLE",

  /* ── ISSUANCE ONLY ─────────────────────────────────────────────────────
     Reading an estimate and ISSUING a document against it are different
     questions with different answers, so they have different reasons. A
     calculated draft may legitimately be shown; it may never invoice. */
  COSTING_NOT_APPROVED: "COSTING_NOT_APPROVED",
  APPROVED_FOR_ANOTHER_QUANTITY: "APPROVED_FOR_ANOTHER_QUANTITY",
  SELLING_PRICE_NOT_SET: "SELLING_PRICE_NOT_SET",
  SELLING_PRICE_CHANGED: "SELLING_PRICE_CHANGED",
  REVIEW_INCOMPLETE: "REVIEW_INCOMPLETE",
  REVIEW_NOT_REVIEWABLE: "REVIEW_NOT_REVIEWABLE",
  EXCEPTION_REQUIRED: "EXCEPTION_REQUIRED",
});

const MESSAGE = Object.freeze({
  [REASON.LINE_NOT_FOUND]: "No commercial quantity has been confirmed for this product line.",
  [REASON.LINE_AMBIGUOUS]: "This enquiry has more than one line for that product. "
    + "Name the product line and the style.",
  [REASON.QUANTITY_NOT_CONFIRMED]: "Confirm the commercial quantity before quoting this line.",
  [REASON.COSTING_NOT_IN_SYNC]: "The costing for the confirmed quantity has not completed.",
  [REASON.FLOOR_NOT_AVAILABLE]: "No floor price has been calculated for the confirmed quantity yet.",

  [REASON.COSTING_NOT_APPROVED]: "The costing for this line has not been approved. "
    + "A calculated estimate can be read, but it cannot be invoiced.",
  [REASON.APPROVED_FOR_ANOTHER_QUANTITY]: "The approved costing was calculated for a different "
    + "quantity than the one confirmed. Re-prepare and approve it for the confirmed quantity.",
  [REASON.SELLING_PRICE_NOT_SET]: "No selling price has been set for this line, "
    + "so there is nothing approved to invoice.",
  /* ── THE SENTENCE NAMES THE NEXT ACTION, NOT THE EVENTUAL ONE ──────
     "has to be reviewed" is true and unhelpful: while the estimate is out
     of date the review permits nothing, so a reader sent to ask for an
     approval finds no control and no explanation. The estimate is refreshed
     first; the approval follows it. */
  [REASON.SELLING_PRICE_CHANGED]: "The selling price changed after approval. "
    + "Refresh the estimate and obtain executive approval before invoicing.",
  [REASON.REVIEW_INCOMPLETE]: "This price is waiting for a commercial decision before it "
    + "can be invoiced.",
  [REASON.REVIEW_NOT_REVIEWABLE]: "This costing cannot be commercially reviewed, "
    + "so there is no decision to invoice against.",
  [REASON.EXCEPTION_REQUIRED]: "This price is below the company's floor and has no completed "
    + "executive exception recorded against it.",
});

/**
 * THE COMMERCIAL LINE, BY ITS KEY — NEVER BY A PRODUCT NAME.
 *
 * One enquiry legitimately carries the same garment twice in two colourways, so
 * a name matches two lines. Given the pair the answer is exact; given only a
 * name, a SINGLE match is still answerable and anything else is refused rather
 * than resolved by taking the first.
 */
function lineOn(enquiry, { productLineRef = "", sampleStyleId = "", productName = "" } = {}) {
  const lines = enquiry?.commercialLines || [];
  const ref = str(productLineRef);
  const styleId = str(sampleStyleId);

  if (ref && styleId) {
    const exact = lines.filter((l) => str(l.productLineRef) === ref
      && String(l.sampleStyleId || "") === styleId);
    return { line: exact.length === 1 ? exact[0] : null, ambiguous: exact.length > 1 };
  }

  const byName = lines.filter((l) => str(l.productName) === str(productName)
    || (enquiry?.products || []).some((p) => str(p.product) === str(productName)
      && str(p.productLineRef) === str(l.productLineRef)));
  return { line: byName.length === 1 ? byName[0] : null, ambiguous: byName.length > 1 };
}

/**
 * Is there an approved floor for THIS quantity?
 *
 * ── THE QUANTITY IS PART OF THE QUESTION ────────────────────────────────────
 * The previous check asked only whether the approved version carried any floor
 * at all. After a revision from 500 to 750 the approved version still prices
 * 500, so that answered yes for an order nobody had costed. The scenario's own
 * quantity is compared, and a version that prices a different run size is not a
 * floor for this one.
 */
function floorForQuantity(version, quantity) {
  return (version?.scenarios || []).some((sc) => Number(sc?.floor?.floorPriceMinor) > 0
    && Number(str(sc?.quantity)) === Number(quantity));
}

/**
 * WHICH APPROVAL A PRICE NEEDS — ORDINARY, OR THE EXECUTIVE EXCEPTION.
 *
 * ── WHY THE BROWSER MAY NOT WORK THIS OUT ───────────────────────────────────
 * It is a comparison of two numbers, which is exactly why it looks safe to do
 * on a screen. It is not: the floor is the company's own minimum, the rule for
 * being under it is a Board policy, and a screen that decided "ordinary
 * approval" for a below-floor price would offer a door the server refuses —
 * or, worse, one it accepts for a decision nobody with the authority took.
 *
 * Stated here, once, beside the refusal it explains.
 *
 * @returns {"EXECUTIVE"|"COMMERCIAL"|null} null when there is nothing to judge
 */
function approvalKindFor(floorPriceMinor, sellingPriceMinor) {
  const floor = Number(floorPriceMinor);
  const price = Number(sellingPriceMinor);
  if (!Number.isFinite(floor) || !Number.isFinite(price) || price <= 0) return null;
  /* Equal counts as at-or-above: the floor is the lowest price the company
     will sell at, so selling exactly at it is permitted. */
  return price < floor ? "EXECUTIVE" : "COMMERCIAL";
}

/**
 * @param {object} ctx        `{companyId}`
 * @param {object} enquiry    the company-owned enquiry document
 * @param {object} key        `{productLineRef, sampleStyleId}`, or `{productName}`
 * @returns {Promise<{ok: true, quantity: number, line: object}
 *   | {ok: false, reason: string, message: string}>}
 */
async function readinessFor(ctx, enquiry, key = {}) {
  const { line, ambiguous } = lineOn(enquiry, key);
  if (ambiguous) {
    return { ok: false, reason: REASON.LINE_AMBIGUOUS, message: MESSAGE[REASON.LINE_AMBIGUOUS] };
  }
  if (!line) {
    return { ok: false, reason: REASON.LINE_NOT_FOUND, message: MESSAGE[REASON.LINE_NOT_FOUND] };
  }

  const quantity = Number(line.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return {
      ok: false, reason: REASON.QUANTITY_NOT_CONFIRMED, message: MESSAGE[REASON.QUANTITY_NOT_CONFIRMED],
    };
  }

  /* Asked of the commercial-line authority, which is what decides whether a
     costing is running for the confirmed number. A second definition here
     would be a second answer, and the second answer is the one that drifts. */
  const costingQuantity = commercialLine.costingQuantityFor(enquiry, line.sampleStyleId);
  if (costingQuantity === null || Number(costingQuantity) !== quantity) {
    /* The quantity is a settled fact even while the costing is not. A card
       that showed it as unknown here would report a confirmed number as
       unconfirmed, which is a statement about a different thing. */
    return {
      ok: false, reason: REASON.COSTING_NOT_IN_SYNC, message: MESSAGE[REASON.COSTING_NOT_IN_SYNC],
      quantity, line,
    };
  }

  let resolved = null;
  try {
    resolved = await preparation.resolve(
      { companyId: enquiry.companyId },
      {
        enquiryId: String(enquiry._id),
        product: str(line.productName) || str(key.productName),
        productLineRef: str(line.productLineRef),
        sampleStyleId: String(line.sampleStyleId || ""),
      },
    );
  } catch {
    /* Unreadable is not ready. A retryable phrasing, because the next attempt
       may well reach it — unlike every other refusal here. */
    return {
      ok: false,
      reason: REASON.FLOOR_NOT_AVAILABLE,
      retryable: true,
      message: "Whether a floor price is available could not be checked just now. Try again.",
    };
  }

  /* The APPROVED version is what may be quoted; a calculated one is what the
     estimate currently says. Either is a floor for this quantity only if its
     own scenario names that quantity. */
  const hasFloor = floorForQuantity(resolved?.approvedVersion, quantity)
    || floorForQuantity(resolved?.latestVersion, quantity);
  if (!hasFloor) {
    return {
      ok: false, reason: REASON.FLOOR_NOT_AVAILABLE, message: MESSAGE[REASON.FLOOR_NOT_AVAILABLE],
      quantity, line,
    };
  }

  return { ok: true, quantity, line };
}

/**
 * MAY THIS LINE BE INVOICED, AND AT WHAT?
 *
 * ── WHY THIS IS NOT `readinessFor` ──────────────────────────────────────────
 * `readinessFor` answers "is there a floor for the confirmed quantity" — the
 * question a screen asks before it offers a price editor, and one a CALCULATED
 * draft can legitimately answer yes to. Issuing a proforma is a different act:
 * it commits a figure to a customer-facing document, so it needs the APPROVED
 * version, the price that version was approved WITH, and the decision that
 * approved it.
 *
 * Sharing one function between the two is what let a draft authorise an invoice.
 *
 * ── EVERY VALUE IS RESOLVED, NONE IS RECEIVED ───────────────────────────────
 * The caller identifies a line — `productLineRef` and `sampleStyleId` — and
 * nothing else. Quantity, price, floor, standing, version and provenance are
 * all read here. A body cannot contribute to any of them, so there is no
 * submitted figure to compare against and no chance of trusting one.
 *
 * ── AND THERE IS NO SECOND FLOOR COMPARISON ─────────────────────────────────
 * Whether the price clears the floor was decided by the engine when the version
 * was calculated, frozen as `commercial.bridge[].standing`, and read back by
 * `commercialReview.subjectOf`. This asks that authority; it does not re-derive
 * the verdict from today's figures, which is how a policy change would silently
 * relabel a historical decision.
 *
 * @returns {Promise<{ok: true, quantity, unitPriceMinor, ...provenance}
 *   | {ok: false, reason, message, retryable?}>}
 */
async function issuanceFor(ctx, enquiry, key = {}) {
  /* The same line resolution, so issuance and readiness can never disagree
     about WHICH line is being talked about. */
  const base = await readinessFor(ctx, enquiry, key);
  if (!base.ok) return base;

  const { quantity, line } = base;

  let resolved = null;
  try {
    resolved = await preparation.resolve(
      { companyId: enquiry.companyId },
      {
        enquiryId: String(enquiry._id),
        product: str(line.productName) || str(key.productName),
        productLineRef: str(line.productLineRef),
        sampleStyleId: String(line.sampleStyleId || ""),
      },
    );
  } catch {
    return {
      ok: false, reason: REASON.FLOOR_NOT_AVAILABLE, retryable: true,
      message: "Whether this line may be invoiced could not be checked just now. Try again.",
    };
  }

  /* ── THE APPROVED VERSION, AND ONLY IT ────────────────────────────────
     Never `approvedVersion || latestVersion`. A calculated draft carrying a
     floor is an estimate somebody may read; authorising an invoice with it
     means invoicing figures nobody signed. */
  /* The facts a card shows are settled before any of these refusals: the
     quantity is confirmed, and where a version has priced it there is a
     floor. Carried on every outcome so the collapsed summary is the same
     in every state. */
  const ledgerNow = commercialLine.sellingPriceFor(
    enquiry, str(line.productLineRef), String(line.sampleStyleId || ""),
  );
  const priceNow = ledgerNow === null ? null : Math.round(ledgerNow * 100);
  const floorOnAny = (v) => {
    const sc = (v?.scenarios || []).find((x) => Number(str(x.quantity)) === Number(quantity));
    const f = Number(sc?.floor?.floorPriceMinor);
    return Number.isFinite(f) ? f : null;
  };
  const knownFloor = floorOnAny(resolved?.approvedVersion) ?? floorOnAny(resolved?.latestVersion);
  const base3 = {
    quantity,
    floorPriceMinor: knownFloor,
    sellingPriceMinor: priceNow,
    requiredApproval: approvalKindFor(knownFloor, priceNow),
  };

  const version = resolved?.approvedVersion || null;
  if (!version) {
    return {
      ok: false, reason: REASON.COSTING_NOT_APPROVED,
      message: MESSAGE[REASON.COSTING_NOT_APPROVED], ...base3,
    };
  }
  if (str(version.status) !== "APPROVED") {
    return {
      ok: false, reason: REASON.COSTING_NOT_APPROVED,
      message: MESSAGE[REASON.COSTING_NOT_APPROVED], ...base3,
    };
  }

  /* ── APPROVED FOR THIS QUANTITY, ON ITS PRIMARY SCENARIO ──────────────
     `floorForQuantity` would accept a version whose THIRD scenario happens to
     name the confirmed number — but the price and the standing a review
     decided on are the PRIMARY scenario's. Requiring the primary to be the
     confirmed quantity is what keeps the figure being stamped and the figure
     that was judged the same figure. */
  const scenarios = version.scenarios || [];
  const primary = scenarios.find((sc) => sc.isPrimary) || scenarios[0] || null;
  if (!primary || Number(str(primary.quantity)) !== Number(quantity)) {
    return {
      ok: false, reason: REASON.APPROVED_FOR_ANOTHER_QUANTITY,
      message: MESSAGE[REASON.APPROVED_FOR_ANOTHER_QUANTITY], ...base3,
    };
  }

  /* ── WHAT THE REVIEW WAS ABOUT ────────────────────────────────────────
     One authority, asked. It yields the frozen floor, the frozen proposed
     price, the engine's own standing and whether an exception was needed. */
  const subject = commercialReview.subjectOf(version);
  if (!subject.ok) {
    /* No price on the version at all: the card still needs the quantity and
       the floor, which are facts about the costing rather than the price. */
    const reason = subject.reason === commercialReview.BLOCKED.NO_PROPOSED_PRICE
      ? REASON.SELLING_PRICE_NOT_SET
      : REASON.REVIEW_NOT_REVIEWABLE;
    return { ok: false, reason, message: MESSAGE[reason], blockedReason: subject.reason, ...base3 };
  }

  /* ── THE DECISION ITSELF, NOT AN INFERENCE FROM THE FIGURES ───────────
     A version reaches `APPROVED` only through `commercialReview.approve` or
     `approveException`, both of which stamp the lifecycle. Reading the stamp
     is reading the decision; reading the standing alone would be guessing
     that one was taken. */
  const lc = version.lifecycle || {};
  if (!lc.approvedAt) {
    const priceMinor = Number(subject.proposedPriceMinor);
    return {
      ok: false, reason: REASON.REVIEW_INCOMPLETE, message: MESSAGE[REASON.REVIEW_INCOMPLETE],
      quantity, floorPriceMinor: Number(subject.floorPriceMinor), sellingPriceMinor: priceMinor,
      requiredApproval: approvalKindFor(subject.floorPriceMinor, priceMinor),
    };
  }

  /* ── A BELOW-FLOOR PRICE NEEDS THE EXCEPTION, RECORDED ────────────────
     Ordinary approval refuses a below-floor standing by name, so an approved
     version whose standing is `BELOW_FLOOR` went through the executive door —
     and that door requires a reason, which is the durable record of the
     exception. Its absence means the stamp cannot be accounted for, and an
     unaccountable approval is not one. */
  if (subject.needsException && !str(lc.approvalNote)) {
    return {
      ok: false, reason: REASON.EXCEPTION_REQUIRED, message: MESSAGE[REASON.EXCEPTION_REQUIRED],
      quantity, floorPriceMinor: Number(subject.floorPriceMinor),
      sellingPriceMinor: Number(subject.proposedPriceMinor), requiredApproval: "EXECUTIVE",
    };
  }

  /* ── AND THE PRICE ON THE LEDGER MUST STILL BE THE APPROVED ONE ───────
     The version froze what was reviewed. If Sales has typed a different
     figure since, the approval no longer covers what would be invoiced. The
     re-brief on a price change normally makes this state unreachable; it is
     checked anyway, because a check that only holds while another one works
     is not a check. */
  const ledgerPrice = commercialLine.sellingPriceFor(
    enquiry, str(line.productLineRef), String(line.sampleStyleId || ""),
  );
  const floorPriceMinor = Number(subject.floorPriceMinor);

  if (ledgerPrice === null) {
    return {
      ok: false, reason: REASON.SELLING_PRICE_NOT_SET, message: MESSAGE[REASON.SELLING_PRICE_NOT_SET],
      quantity, floorPriceMinor, sellingPriceMinor: null, requiredApproval: null,
    };
  }

  const sellingPriceMinor = Math.round(ledgerPrice * 100);
  if (sellingPriceMinor !== Number(subject.proposedPriceMinor)) {
    /* ── HAS THE ESTIMATE ALREADY CAUGHT UP? ──────────────────────────
       The comparison above is against the APPROVED version, which is the
       right question for issuing. It is the wrong reason to report once a
       fresh estimate carrying this very price exists and is simply waiting
       for a decision: telling somebody to refresh an estimate they have
       just refreshed leaves them pressing a button that changes nothing.

       So where the LATEST version is current and already proposes this
       price, the line is not out of date — it is undecided, which is a
       different sentence and a different next action. Issuance still
       refuses either way; only the reason and the action change. */
    const latest = resolved?.latestVersion || null;
    const latestPrice = Number(
      (latest?.commercial?.proposedPrices || [])
        .find((x) => str(x.scenarioKey) === str(subject.scenarioKey)
          || (latest.scenarios || []).some((sc) => sc.isPrimary && str(sc.key) === str(x.scenarioKey)))
        ?.priceExclTaxMinor,
    );
    if (latest && !resolved?.freshness?.stale && latestPrice === sellingPriceMinor) {
      const latestFloor = floorOnAny(latest);
      return {
        ok: false, reason: REASON.REVIEW_INCOMPLETE, message: MESSAGE[REASON.REVIEW_INCOMPLETE],
        quantity,
        floorPriceMinor: latestFloor ?? floorPriceMinor,
        sellingPriceMinor,
        requiredApproval: approvalKindFor(latestFloor ?? floorPriceMinor, sellingPriceMinor),
      };
    }

    /* ── THE APPROVAL BELONGS TO THE OLD PRICE ────────────────────────
       The version froze what was reviewed. A figure typed since is not
       covered by that decision, whatever the review's stored state says —
       so the refusal carries the approval the NEW price would need, which
       is the only thing left to do about it. */
    return {
      ok: false, reason: REASON.SELLING_PRICE_CHANGED, message: MESSAGE[REASON.SELLING_PRICE_CHANGED],
      quantity, floorPriceMinor, sellingPriceMinor,
      requiredApproval: approvalKindFor(floorPriceMinor, sellingPriceMinor),
      approvedPriceMinor: Number(subject.proposedPriceMinor),
    };
  }

  return {
    ok: true,
    quantity,
    line,
    sellingPriceMinor,
    requiredApproval: null,
    /* ── THE STAMP ────────────────────────────────────────────────────
       The price is the APPROVED one, in minor units, off the version. Not
       the ledger's copy, not the catalogue's, and not the body's. */
    unitPriceMinor: Number(subject.proposedPriceMinor),
    floorPriceMinor: Number(subject.floorPriceMinor),
    standing: subject.standing,
    wasException: Boolean(subject.needsException),
    /* Which door the approval came through. A price cleared under the floor
       was an executive exception, and a screen saying only "approved" would
       hide the one fact that makes it unusual. */
    approvedByException: Boolean(subject.needsException),
    scenarioKey: str(subject.scenarioKey),
    costingId: String(version.costingId || ""),
    costingVersionId: String(version._id),
    costingVersionNumber: version.versionNumber ?? null,
    approvedAt: lc.approvedAt || null,
    approvedByName: str(lc.approvedByName) || null,
    decisionReason: str(lc.approvalNote) || null,
  };
}

/**
 * WHAT THE SCREEN MAY KNOW ABOUT ONE LINE'S READINESS TO INVOICE.
 *
 * ── ONE AUTHORITY, NOT A SECOND OPINION ─────────────────────────────────────
 * This asks `issuanceFor` — the same function the proforma command itself
 * calls — and reshapes the answer. It applies no rule of its own, so the
 * summary a person reads and the gate that refuses them cannot disagree. A
 * screen that computed its own readiness is exactly how "everything it needs
 * is in place" came to sit above a command that refuses.
 *
 * ── AND IT PUBLISHES FIELD BY FIELD ─────────────────────────────────────────
 * Built explicitly rather than spread, so a field added to the issuance result
 * later cannot start travelling to a browser by accident. No cost, no markup,
 * no supplier, no fingerprint, no version id, no scenario key: the floor and
 * the selling price are commercial answers Sales acts on, and the rest is the
 * costing's own business.
 *
 * @returns {Promise<object>} one presentation-safe verdict
 */
async function issuanceProjection(ctx, enquiry, key = {}) {
  const verdict = await issuanceFor(ctx, enquiry, key);

  /* The review's own permissions, read from the same service the controls
     read. Never inferred here: what a person may press is the server's
     answer, and a screen that guessed would offer a refused door. */
  let permitted = { submit: false, approve: false, return: false, approveException: false };
  try {
    const state = await commercialReview.stateFor(ctx, {
      enquiryId: String(enquiry._id),
      product: str(verdict.line?.productName) || str(key.productName),
      productLineRef: str(key.productLineRef),
      sampleStyleId: str(key.sampleStyleId),
    });
    permitted = state?.permitted || permitted;
  } catch {
    /* Unreadable permissions are NO permissions. A control offered on a
       failed read is a control that fails when pressed. */
  }

  return {
    productLineRef: str(key.productLineRef),
    sampleStyleId: str(key.sampleStyleId),
    /* The one word the card branches on. */
    readiness: verdict.ok ? "READY" : "BLOCKED",
    blocker: verdict.ok ? null : {
      code: str(verdict.reason),
      /* The server's own sentence, so the screen states the reason rather
         than inventing a second wording for it. */
      message: str(verdict.message),
      ...(verdict.retryable ? { retryable: true } : {}),
    },
    confirmedQuantity: verdict.quantity ?? null,
    floorPriceMinor: verdict.floorPriceMinor ?? null,
    sellingPriceMinor: verdict.sellingPriceMinor ?? null,
    /* ── THE APPROVAL THIS PRICE NEEDS, DECIDED HERE ────────────────────
       "COMMERCIAL", "EXECUTIVE" or null. The browser never compares the
       price to the floor to work this out. */
    requiredApproval: verdict.requiredApproval ?? null,
    /* True where the approval that cleared this price was a below-floor
       executive exception. Stated by the server, never inferred from a
       price-versus-floor comparison in a browser. */
    approvedByException: verdict.approvedByException === true,
    permitted: {
      submit: permitted.submit === true,
      approve: permitted.approve === true,
      return: permitted.return === true,
      approveException: permitted.approveException === true,
    },
  };
}

module.exports = {
  REASON, MESSAGE, lineOn, floorForQuantity, readinessFor, issuanceFor,
  approvalKindFor, issuanceProjection,
};
