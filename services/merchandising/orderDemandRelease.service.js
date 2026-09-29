// services/merchandising/orderDemandRelease.service.js
//
// RELEASING APPROVED MATERIAL DEMAND FOR A CONFIRMED ORDER LINE.
//
// ── THE RULE THIS ENFORCES ──────────────────────────────────────────────────
// An approved costing says a price MAY BE QUOTED. It does not say the company
// has an order, and it must not cause anything to be bought. Nor does a
// customer approving a quotation: that is the buyer's half of a conversation
// Sales has not finished. Demand becomes eligible only when a genuine
// confirmed order exists, for a known style and a known quantity, priced by a
// costing somebody approved, against requirements that were frozen when it was.
//
// Until now the only way to raise it was a button in the Costing app, gated on
// nothing more than "this costing has an approved version" — which is to say,
// on a price being quotable. That is the gap this closes.
//
// ── WHOSE DECISION IT IS ────────────────────────────────────────────────────
// Sales confirms the order. Merchandising receives the confirmed handover and
// owns turning its approved requirement into demand. Store/Procurement
// receives that demand and owns sourcing. So the capability is Merchandising's
// and it is NOT held by Sales at any rank: confirming an order and deciding to
// commit the company's money against it are different acts.
//
// ── AND IT IS AN EXPLICIT COMMAND ───────────────────────────────────────────
// Nothing calls this as a side effect. Issuing a Merchandising handover does
// not release demand, approving a costing does not, and a customer approving a
// quotation does not. Each of those is asserted in the suite, because a side
// effect is exactly how the previous arrangement went wrong.
//
// ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
// It creates no purchase order, chooses no supplier, reserves no stock and
// places no order. It produces the same DRAFT spend requests the existing
// handoff has always produced, through the same authority — this module owns
// the PRECONDITIONS, not the arithmetic.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const { fail } = require("../storePurchase/errors");
const { CAPABILITY, ROLE_CAPABILITIES } = require("./access.service");
const projectionHandoff = require("../centralCosting/projectionHandoff.service");
const approvedOutput = require("../centralCosting/approvedOutput.service");
const quotationPricing = require("../centralCosting/quotationPricing.service");
const costingDemand = require("../requests/costingDemand.service");
const unitOfWork = require("../storePurchase/unitOfWork.service");
/* The Sales producer owns what "confirmed" means AND how an order's company is
   proved. Both are imported rather than restated — a second copy of either
   would be a second answer, and the weaker one would be the one that replied. */
const handover = require("../sales/merchandisingHandover.service");

const str = (v) => String(v ?? "").trim();
const model = (name, path) => (mongoose.models[name] || require(path));
const CustomerRequest = () => model("CustomerRequest", "../../models/Customer_Models/CustomerRequest");
const CostingVersion = () => model("CostingVersion", "../../models/CMS_Models/Costing/CostingVersion");
const Costing = () => model("Costing", "../../models/CMS_Models/Costing/Costing");
const SampleStyle = () => model("SampleStyle", "../../models/CMS_Models/Sales/SampleStyle");
const DemandRelease = () => require("../../models/CMS_Models/Merchandising/DemandRelease");

/**
 * The Sales statuses that ARE commercial confirmation.
 *
 * ── READ FROM THE PRODUCER, NOT RESTATED ────────────────────────────────────
 * `merchandisingHandover` already defines what "confirmed" means, and it is
 * the authority on it. A second list here would be a second definition, and
 * the day Sales added a status one of them would be wrong. Imported so there
 * is one answer.
 */
const { CONFIRMED_STATUSES } = handover;

const CODES = Object.freeze({
  FORBIDDEN: "DEMAND_RELEASE_FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  NOT_ELIGIBLE: "DEMAND_RELEASE_NOT_ELIGIBLE",
  RECOST_REQUIRED: "DEMAND_RELEASE_RECOST_REQUIRED",
  IDENTITY_REQUIRED: "DEMAND_RELEASE_IDENTITY_REQUIRED",
  RECONCILIATION_REQUIRED: "DEMAND_RELEASE_RECONCILIATION_REQUIRED",
});

/** Why a confirmed order line cannot yet become demand. */
const BLOCKED = Object.freeze({
  ORDER_NOT_CONFIRMED: "ORDER_NOT_CONFIRMED",
  LINE_NOT_FOUND: "LINE_NOT_FOUND",
  NO_ORDERED_QUANTITY: "NO_ORDERED_QUANTITY",
  NO_COSTING_SOURCE: "NO_COSTING_SOURCE",
  COSTING_MISMATCH: "COSTING_MISMATCH",
  COSTING_NOT_APPROVED: "COSTING_NOT_APPROVED",
  HISTORICAL_CONTRACT: "HISTORICAL_CONTRACT",
  STYLE_MISMATCH: "STYLE_MISMATCH",
  REQUIREMENTS_NOT_APPROVED: "REQUIREMENTS_NOT_APPROVED",
  QUANTITY_NOT_COSTED: "QUANTITY_NOT_COSTED",
  NOT_A_CUSTOMER_ORDER: "NOT_A_CUSTOMER_ORDER",
  /* The frozen provenance disagrees with the records it names. Each is its
     own reason so a tampered field is nameable rather than "invalid". */
  QUANTITY_MISMATCH: "QUANTITY_MISMATCH",
  SCENARIO_MISMATCH: "SCENARIO_MISMATCH",
  PRICE_MISMATCH: "PRICE_MISMATCH",
  FINGERPRINT_MISMATCH: "FINGERPRINT_MISMATCH",
  /* Demand released earlier is still operational, so a successor would let
     Store buy the same order line twice. */
  PRIOR_DEMAND_ACTIVE: "PRIOR_DEMAND_ACTIVE",
  CURRENCY_MISMATCH: "CURRENCY_MISMATCH",
  FINGERPRINT_MISSING: "FINGERPRINT_MISSING",
  /* The source could not be checked at all — never the same as "it is fine". */
  SOURCE_UNVERIFIABLE: "SOURCE_UNVERIFIABLE",
  /* A prior request could not be read, so prior demand is unaccounted for. */
  PRIOR_DEMAND_UNVERIFIABLE: "PRIOR_DEMAND_UNVERIFIABLE",
});

/* ══ THE SUBJECT, PROVED FROM RECORDS ════════════════════════════════════ */

const refuse = (reason, message, details = {}) =>
  fail(CODES.NOT_ELIGIBLE, message, { reason, ...details });

/**
 * Resolve and prove every identity this release rests on.
 *
 * ── COMPANY FIRST, THEN THE RECORD, ALWAYS ──────────────────────────────────
 * Every read is scoped to the caller's own company. A record belonging to
 * another company answers exactly as one that never existed — a
 * distinguishable refusal is an oracle for orders the caller may not see.
 */
/**
 * The three identifiers, and nothing else.
 *
 * Separated from `subjectFor` because recovery needs them checked WITHOUT
 * touching a live commercial source: a committed claim is recovered by
 * identity, not by re-proving today's facts.
 */
function assertIdentifiers({ orderId, lineRef, costingVersionId }) {
  if (!isId(orderId) || !str(lineRef) || !isId(costingVersionId)) {
    throw fail(
      CODES.IDENTITY_REQUIRED,
      "Name the confirmed order, its line reference and the approved costing version.",
      { reason: "IDENTITY_REQUIRED", fields: ["orderId", "lineRef", "costingVersionId"] },
    );
  }
}

async function subjectFor(ctx, { orderId, lineRef, costingVersionId }) {
  assertIdentifiers({ orderId, lineRef, costingVersionId });

  /* ── OWNERSHIP FIRST, BEFORE ANY BUSINESS FACT ───────────────────────
     `loadOwnedRequest` proves the whole order belongs to this company —
     through its lines' styles, which is the one company chain a
     CustomerRequest has — and answers NOT_FOUND if it does not.

     It runs before status, line, quantity or costing source is looked at,
     because every one of those refusals CONFIRMS THE ORDER EXISTS. Telling a
     stranger "that order is not confirmed yet" is telling them there is an
     order. Missing and foreign must be the same answer, and that is only
     true if ownership is proved first. */
  const { request: order } = await handover.loadOwnedRequest({ companyId: ctx.companyId }, orderId);

  /* ── A GENUINE CONFIRMATION, FROM THE EXISTING AUTHORITATIVE SET ──────
     Customer approval is not confirmation: `quotation_customer_approved`
     still awaits Sales' own sign-off, and releasing on it would buy against
     a promise Sales has not finished making. */
  if (!CONFIRMED_STATUSES.includes(str(order.status))) {
    throw refuse(
      BLOCKED.ORDER_NOT_CONFIRMED,
      "This order is not commercially confirmed, so nothing may be bought against it.",
      { status: str(order.status) },
    );
  }
  /* An in-house sample carries no buyer commitment. */
  if (str(order.orderOrigin || "customer") !== "customer") {
    throw refuse(
      BLOCKED.NOT_A_CUSTOMER_ORDER,
      "Only a confirmed customer order can release procurement demand.",
    );
  }

  const line = (order.items || []).find((i) => str(i.lineRef) === str(lineRef)) || null;
  if (!line) throw refuse(BLOCKED.LINE_NOT_FOUND, "That order line was not found on this order.");

  const orderedQuantity = str(line.totalQuantity);
  if (!(Number(orderedQuantity) > 0)) {
    throw refuse(BLOCKED.NO_ORDERED_QUANTITY, "This line has no positive confirmed quantity.");
  }

  const lineStyleId = str(line.sampleStyleId);
  if (!lineStyleId) {
    throw refuse(BLOCKED.STYLE_MISMATCH, "This order line has no selected style.");
  }

  /* ── THE QUOTATION LINE THAT PRICED THIS ORDER LINE ───────────────────
     The approved decision lives on the quotation, joined to the order line
     by `sampleStyleId` — which exists on a quotation item for exactly this
     purpose, because matching on product name, SKU text, amount or array
     position would each silently repoint the price. */
  const { line: priced, quotation } = pricedLineFor(order, lineStyleId);
  if (!priced) {
    throw refuse(
      BLOCKED.NO_COSTING_SOURCE,
      "This line was not priced from an approved costing, so there is no approved requirement to release.",
    );
  }
  const src = priced.costingSource;

  /* ── AND IT MUST BE THE EXACT SOURCE, NOT MERELY A COMPATIBLE ONE ─────
     Every identity on the frozen provenance is checked against the records
     it claims. A version that happens to contain a scenario at the ordered
     quantity is NOT enough: if the quotation was priced from a different
     scenario, releasing against this one would buy for a run size nobody
     quoted. Each mismatch is its own refusal so the wrong one is nameable. */
  if (str(src.sampleStyleId) !== lineStyleId) {
    throw refuse(BLOCKED.STYLE_MISMATCH,
      "The approved price on this line was taken for a different style.");
  }
  if (String(src.costingVersionId) !== String(costingVersionId)) {
    throw refuse(BLOCKED.COSTING_MISMATCH,
      "This line was priced from a different costing version than the one named.",
      { lineCostingVersionId: String(src.costingVersionId) });
  }
  if (str(src.priceTier) !== "floor") {
    throw refuse(BLOCKED.HISTORICAL_CONTRACT,
      "This line was priced under the retired margin band. Recost it before releasing demand.",
      { priceTier: str(src.priceTier) });
  }
  if (!sameQuantity(src.quantity, orderedQuantity)) {
    throw refuse(BLOCKED.QUANTITY_MISMATCH,
      "The confirmed quantity is not the quantity this line's price was approved for.",
      { orderedQuantity, approvedFor: str(src.quantity) });
  }

  const version = await CostingVersion().findOne({
    _id: costingVersionId, companyId: ctx.companyId,
  }).lean();
  if (!version) throw fail(CODES.NOT_FOUND, "That order was not found.");

  if (str(version.status) !== "APPROVED") {
    throw refuse(BLOCKED.COSTING_NOT_APPROVED,
      "That costing version is not approved, so no demand may be released from it.",
      { status: str(version.status) });
  }
  if (String(version.costingId) !== String(src.costingId)) {
    throw refuse(BLOCKED.COSTING_MISMATCH,
      "The named version does not belong to the costing this line was priced from.");
  }

  const costing = await Costing().findOne({
    _id: version.costingId, companyId: ctx.companyId,
  }).lean();
  if (!costing) throw fail(CODES.NOT_FOUND, "That order was not found.");

  const style = await SampleStyle().findById(lineStyleId)
    .select("_id styleCode productName journeyId enquiryId").lean();
  if (!style) throw fail(CODES.NOT_FOUND, "That order was not found.");

  /* ── THE SCENARIO THE QUOTATION NAMED, NOT ANY MATCHING ONE ───────────
     Both must agree: the frozen `scenarioKey` must exist on the version AND
     its quantity must be the ordered one. Taking whichever scenario happens
     to carry the ordered quantity would release against figures the
     quotation was not priced from. */
  const scenarios = version.scenarios || [];
  const scenario = scenarios.find((s) => str(s.key) === str(src.scenarioKey)) || null;
  if (!scenario) {
    throw refuse(BLOCKED.SCENARIO_MISMATCH,
      "The scenario this line was priced from is not on the named costing version.",
      { scenarioKey: str(src.scenarioKey) });
  }
  if (!sameQuantity(scenario.quantity, orderedQuantity)) {
    throw fail(
      CODES.RECOST_REQUIRED,
      "This costing was not approved for the ordered quantity. Recost for the ordered quantity, then release.",
      {
        reason: BLOCKED.QUANTITY_NOT_COSTED,
        orderedQuantity,
        pricedScenarioQuantity: str(scenario.quantity),
        approvedQuantities: scenarios.map((s) => str(s.quantity)).filter(Boolean),
      },
    );
  }

  /* A floor-priced scenario, proved on the version and not only claimed by
     the quotation's tier. */
  if (!scenario.floor) {
    throw refuse(BLOCKED.HISTORICAL_CONTRACT,
      "This costing was priced under the retired margin band. Recost it before releasing demand.");
  }

  /* ── THE PRICE, AND THE FINGERPRINT OVER IT ───────────────────────────
     The saved line must still be the line that was stamped: its price is the
     approved one, and the canonical fingerprint over the six identities
     still reproduces what was stored. A tampered figure or a repointed id
     changes the hash, and this is where that shows. */
  const savedPrice = Number(src.unitPriceMinor);
  if (!Number.isFinite(savedPrice) || savedPrice !== Number(scenario.floor.floorPriceMinor)) {
    throw refuse(BLOCKED.PRICE_MISMATCH,
      "The price saved on this quotation line is not the approved floor price it names.");
  }

  /* ── AND THE PRICE THE QUOTATION ACTUALLY SHOWS ───────────────────────
     `costingSource.unitPriceMinor` is the provenance; `unitPrice` is the
     figure on the line a customer was quoted. `quotationPricing` writes both
     together, so they agree — unless somebody edited one afterwards, which
     is exactly the case worth catching. Compared through that module's own
     `toMajor`, so the two never disagree about rounding. */
  const quotedMajor = Number(priced.unitPrice);
  if (!Number.isFinite(quotedMajor) || quotedMajor !== quotationPricing.toMajor(savedPrice)) {
    throw refuse(BLOCKED.PRICE_MISMATCH,
      "The price on this quotation line has been edited away from the approved price it names.",
      { quoted: Number.isFinite(quotedMajor) ? quotedMajor : null });
  }

  /* ── ONE CURRENCY ACROSS ALL THREE RECORDS ────────────────────────────
     The costing's base currency, the provenance, and the quotation. A line
     priced in one currency and quoted in another is not a conversion — it is
     the same number wearing two meanings. */
  const versionCurrency = str(version.baseCurrency);
  const sourceCurrency = str(src.currency);
  const quotationCurrency = str(quotation?.currency) || sourceCurrency;
  if (!sourceCurrency || sourceCurrency !== versionCurrency || quotationCurrency !== sourceCurrency) {
    throw refuse(BLOCKED.CURRENCY_MISMATCH,
      "The currency on this line does not agree with the costing it was priced from.",
      { sourceCurrency, versionCurrency, quotationCurrency });
  }

  /* ── THE FINGERPRINT IS REQUIRED, NOT MERELY CHECKED IF PRESENT ───────
     Treating an absent fingerprint as acceptable made it optional evidence:
     anybody able to write the provenance could omit the one field that
     proves the rest of it, and the check would politely skip itself. Every
     line `quotationPricing` stamps carries one. */
  const stored = str(src.fingerprint);
  if (!stored) {
    throw refuse(BLOCKED.FINGERPRINT_MISSING,
      "This line's approved-price provenance carries no fingerprint, so it cannot be verified.");
  }
  const expected = approvedOutput.fingerprintOf({
    costingId: String(src.costingId),
    versionId: String(src.costingVersionId),
    scenarioKey: str(src.scenarioKey),
    tier: str(src.priceTier),
    priceMinor: savedPrice,
    currency: sourceCurrency,
  });
  if (stored !== expected) {
    throw refuse(BLOCKED.FINGERPRINT_MISMATCH,
      "The approved price provenance on this line no longer matches the facts it records.");
  }

  /* ── AND THE CANONICAL SUPERSESSION CHECK ─────────────────────────────
     `approvedOutput.supersessionFor` is the authority on whether a saved
     line's approved source is still the current one. Asked rather than
     reimplemented — and an unanswered check is NOT a pass, for the same
     reason `quotationPricing.verifyBeforeSend` refuses one. */
  let supersession;
  try {
    supersession = await approvedOutput.supersessionFor(ctx, src);
  } catch {
    throw fail(CODES.RECONCILIATION_REQUIRED,
      "Whether this line's approved costing is still current could not be checked. Try again.",
      { reason: BLOCKED.SOURCE_UNVERIFIABLE, retryable: true });
  }
  if (!supersession.checked || supersession.unknown) {
    throw fail(CODES.RECONCILIATION_REQUIRED,
      "Whether this line's approved costing is still current could not be checked. Try again.",
      { reason: BLOCKED.SOURCE_UNVERIFIABLE, retryable: true });
  }
  if (supersession.superseded) {
    throw refuse(BLOCKED.COSTING_MISMATCH,
      "A newer costing version has been approved since this line was priced. Reprice it, then release.",
      { currentApprovedVersionId: supersession.currentApprovedVersionId });
  }

  /* ── THE FROZEN REQUIREMENTS, AND THEIR GATES ─────────────────────────
     Read from the version's own frozen source references: the technical
     revision as it was when the costing was approved, with both approval
     gates recorded. */
  const requirement = requirementRevisionOf(version);
  if (!requirement.approved) {
    throw refuse(
      BLOCKED.REQUIREMENTS_NOT_APPROVED,
      "The technical requirements behind this costing were not frozen as approved.",
      { requirement: { technicalRevision: requirement.technicalRevision } },
    );
  }

  return {
    order, line, orderedQuantity,
    version, costing, style,
    scenarioKey: str(scenario.key),
    requirement,
  };
}

/**
 * The quotation line that priced one order line, by style.
 *
 * ── THE CURRENT QUOTATION, NOT AN ARCHIVED REVISION ─────────────────────────
 * `quotations` holds the live revision and `quotationRevisions` the archive. A
 * superseded revision priced something the company is no longer offering.
 */
function pricedLineFor(order, styleId) {
  const quotations = order.quotations || [];
  for (let i = quotations.length - 1; i >= 0; i -= 1) {
    const line = (quotations[i].items || []).find((qi) => str(qi.sampleStyleId) === str(styleId)
      && str(qi.costingSource?.source) === "APPROVED_COSTING"
      && qi.costingSource?.costingVersionId);
    if (line) return { line, quotation: quotations[i] };
  }
  return { line: null, quotation: null };
}

const isId = (v) => Boolean(v) && mongoose.Types.ObjectId.isValid(String(v));

/** Two quantities are the same run size, compared as numbers not strings. */
const sameQuantity = (a, b) => {
  const x = Number(str(a));
  const y = Number(str(b));
  return Number.isFinite(x) && Number.isFinite(y) && x === y;
};

/**
 * The approved technical revision this version froze, and its gates.
 *
 * Read off the version's own `sourceReferences` — the snapshot taken when it
 * was calculated — never from the style as it reads today. R&D approving a
 * newer revision does not retroactively change what this costing was built on.
 */
function requirementRevisionOf(version) {
  /* ── THE STORED PATH, NOT THE SERIALISED ONE ─────────────────────────
     `cost.sourceReferences` is the name `visibility.js` gives this block in
     an API response. The document has always called it `sourceReferences`,
     and this reads documents. Both are accepted, stored first, because the
     same mistake has been made three times in this domain. */
  const refs = version.sourceReferences || version.cost?.sourceReferences || [];
  const bom = refs.find((r) => str(r.sourceType) === "BOM"
    && (r.snapshot || []).some((f) => str(f.key) === "styleCode")) || null;
  const snap = Object.fromEntries((bom?.snapshot || []).map((f) => [str(f.key), f.text ?? f.num]));

  const bomApprovalStatus = str(snap.bomApprovalStatus);
  const sampleStatus = str(snap.sampleStatus);
  return {
    technicalRevision: str(snap.bomApprovalRound ?? snap.technicalRevision ?? ""),
    bomApprovalStatus,
    sampleStatus,
    /* Both gates, as the costing recorded them. */
    approved: bomApprovalStatus === "approved" && sampleStatus === "approved",
  };
}

/**
 * The six facts that decide whether a second request is the same decision.
 *
 * Any one of them changing is a DIFFERENT subject, and therefore a successor
 * rather than a retry — which is what makes "the buyer raised the quantity"
 * produce a new release instead of silently rewriting the old one.
 */
const releaseKeyFor = ({ companyId, orderId, lineRef, costingVersionId, requirement, orderedQuantity }) =>
  crypto.createHash("sha256").update(JSON.stringify([
    String(companyId), String(orderId), str(lineRef), String(costingVersionId),
    str(requirement.technicalRevision), str(requirement.bomApprovalStatus), str(requirement.sampleStatus),
    Number(str(orderedQuantity)),
  ])).digest("hex");

/* ══ READ ════════════════════════════════════════════════════════════════ */

/* ── THE ACTIVE SLOT: ONE QUERY, TWO READERS ────────────────────────────────
   `release` needs the whole row — it supersedes it, links to it, reads its
   frozen command. A caller outside this file needs almost none of that. Both
   ask the SAME question through this builder, so a change to what "active"
   means cannot land in one reader and not the other. */
const ACTIVE_STATES = Object.freeze(["PENDING", "RELEASED"]);
const activeQuery = (ctx, orderId, lineRef) => ({
  companyId: ctx.companyId,
  orderId,
  lineRef: str(lineRef),
  state: { $in: [...ACTIVE_STATES] },
});

/**
 * THE DURABLE RELEASE IN FORCE ON ONE ORDER LINE, AS A NARROW READ.
 *
 * ── WHY THIS IS EXPORTED ────────────────────────────────────────────────────
 * A caller addressing this authority by something other than the three
 * identities — the Execution File, for one — has to know which costing version
 * a started command was frozen against BEFORE it can decide what to send. The
 * alternative is that it joins today's quotation to find out, which is exactly
 * the reasoning this service abandoned: once a claim has committed, the
 * durable row outranks today's provenance for an exact retry.
 *
 * It returns identities and states. No frozen command, no demand references,
 * no actor — a caller that needed those would be taking a decision that
 * belongs here.
 */
async function activeReleaseFor(ctx, { orderId, lineRef } = {}) {
  if (!isId(orderId) || !str(lineRef)) return null;
  const row = await DemandRelease().findOne(activeQuery(ctx, orderId, lineRef)).lean();
  if (!row) return null;
  return {
    releaseId: String(row._id),
    state: str(row.state),
    costingVersionId: String(row.costingVersionId),
    costingVersionNumber: row.costingVersionNumber ?? null,
  };
}

/** Whether this line may be released, and what has been released already. */
async function stateFor(ctx, { orderId, lineRef, costingVersionId } = {}) {
  let subject = null;
  let blocked = null;
  try {
    subject = await subjectFor(ctx, { orderId, lineRef, costingVersionId });
  } catch (err) {
    if (!err?.code) throw err;
    blocked = { code: err.code, reason: err.details?.reason || null, message: err.message };
  }

  const history = isId(orderId)
    ? await DemandRelease().find({ companyId: ctx.companyId, orderId, lineRef: str(lineRef) })
      .sort({ releasedAt: 1 }).lean()
    : [];

  const current = history.find((r) => r.state === "RELEASED") || null;
  const pending = history.find((r) => r.state === "PENDING") || null;

  /* ── A RELEASED PREDECESSOR IS NOT THE END OF THE LINE ──────────────────
     It used to be: any current release made this ineligible, full stop. But a
     line whose price has moved to a NEW approved version has a legitimate
     successor waiting, and refusing to say so left the screen with no way to
     offer it — the very flow `release()` already implements.

     So a successor is offered when the version asked about is not the one
     already released, the subject verifies in full, and the SAME
     reconciliation rule the command applies says the earlier demand is closed.
     Asked, not restated: `priorDemandVerdict` is the command's own rule. */
  let eligible = Boolean(subject) && !current;
  let successor = null;
  if (subject && current && !pending
    && String(current.costingVersionId) !== String(costingVersionId)) {
    const verdict = await priorDemandVerdict(ctx, current);
    eligible = verdict.ok;
    successor = verdict.ok
      ? { supersedes: String(current._id) }
      : null;
    if (!verdict.ok && !blocked) {
      blocked = {
        code: CODES.RECONCILIATION_REQUIRED,
        reason: verdict.reason,
        message: verdict.message,
      };
    }
  }

  return {
    eligible,
    /* What this release would replace, when it is a replacement. */
    supersedes: successor?.supersedes || null,
    blocked,
    /* ── IDENTITIES AND QUANTITIES ONLY ───────────────────────────────
       No cost, no floor, no markup, no supplier, no rate, no policy. None
       of it is read, so none of it can leak. */
    subject: subject
      ? {
        orderId: String(subject.order._id),
        orderNumber: str(subject.order.requestNumber),
        lineRef: str(lineRef),
        sampleStyleId: String(subject.style._id),
        styleCode: str(subject.style.styleCode),
        productName: str(subject.style.productName),
        orderedQuantity: subject.orderedQuantity,
        scenarioKey: subject.scenarioKey,
        costingVersionId: String(subject.version._id),
        costingVersionNumber: subject.version.versionNumber,
        requirementRevision: subject.requirement.technicalRevision,
      }
      : null,
    releases: history.map((r) => ({
      releaseId: String(r._id),
      state: r.state,
      orderedQuantity: r.orderedQuantity,
      costingVersionNumber: r.costingVersionNumber,
      requirementRevision: r.requirementRevision?.technicalRevision || "",
      releasedAt: r.releasedAt,
      releasedByName: str(r.releasedByActorName),
      supersedesReleaseId: r.supersedesReleaseId ? String(r.supersedesReleaseId) : null,
      supersededByReleaseId: r.supersededByReleaseId ? String(r.supersededByReleaseId) : null,
      demand: {
        spendRequestIds: (r.demand?.spendRequestIds || []).map(String),
        requirementCount: r.demand?.requirementCount || 0,
      },
    })),
    permitted: { release: eligible && holdsRelease(ctx) },
  };
}

/**
 * Does this context hold the release grant?
 *
 * Two shapes are accepted because a route and a direct caller build the
 * context differently: a `capabilities` Set, or the resolved Merchandising
 * `role` the access ladder already returns. Both consult the SAME
 * `ROLE_CAPABILITIES` table, so there is one answer and no second ladder.
 */
const holdsRelease = (ctx) => {
  if (ctx?.capabilities?.has?.(CAPABILITY.PROCUREMENT_RELEASE) === true) return true;
  const role = str(ctx?.role);
  return Boolean(role && ROLE_CAPABILITIES[role]?.has(CAPABILITY.PROCUREMENT_RELEASE));
};

/* ══ THE COMMAND ═════════════════════════════════════════════════════════ */

/**
 * RELEASE THE APPROVED DEMAND FOR ONE CONFIRMED ORDER LINE.
 *
 * @param {object} ctx   `{ companyId, capabilities:Set, actorId, actorName }`
 */
async function release(ctx, { orderId, lineRef, costingVersionId, actor = {} } = {}) {
  if (!holdsRelease(ctx)) {
    throw fail(CODES.FORBIDDEN, "You do not have permission to release procurement demand.", {
      reason: "NOT_GRANTED", required: CAPABILITY.PROCUREMENT_RELEASE,
    });
  }

  assertIdentifiers({ orderId, lineRef, costingVersionId });

  /* ══ 1 · A COMMITTED ROW OUTRANKS TODAY'S SOURCES ══════════════════════
     Looked up BEFORE any live commercial fact is read, and scoped to this
     company, so another company's release is never seen — a foreign order
     falls through to `subjectFor` and answers NOT_FOUND exactly as a missing
     one does.

     ── WHY THIS CANNOT COME AFTER `subjectFor` ─────────────────────────
     Once a claim has committed, the command has STARTED: requests may exist
     under its idempotency key. From that moment the durable row is the
     authority for finishing it. Verifying live sources first meant a change
     to the order's status, its quantity, the quotation provenance or the
     current approved costing could refuse the retry before it ever reached
     the frozen claim — stranding a half-run command that nothing else can
     complete, and whose demand nothing else can account for.

     A NEW attempt still runs the whole of `subjectFor`. Recovery is the
     narrow case of an identifier triple that already names a live row. */
  const active = await DemandRelease().findOne(activeQuery(ctx, orderId, lineRef)).lean();

  if (active && String(active.costingVersionId) === String(costingVersionId)) {
    if (active.state === "PENDING") {
      /* The frozen command, replayed under the frozen identity. No selection,
         no revalidation, no second claim. */
      return finishPending(ctx, { pending: active, orderId, lineRef, costingVersionId });
    }
    /* ── AND A COMPLETED RELEASE IS ANSWERED FROM ITS OWN RECORD ──────
       An exact retry after success reports what was released. It does not
       ask whether today's quotation still says the same thing: the demand
       was raised, and re-deriving the answer could refuse to describe work
       that has already happened. A crash between "this row is RELEASED" and
       "the previous one is SUPERSEDED" is finished here, idempotently. */
    await supersedePredecessor(ctx, active);
    return {
      outcome: "ALREADY_RELEASED",
      releaseId: String(active._id),
      ...(await stateFor(ctx, { orderId, lineRef, costingVersionId })),
    };
  }

  if (active && active.state === "PENDING") {
    /* ── A CLAIM CANNOT BE HIJACKED BY NAMING ANOTHER VERSION ─────────
       Exact-version identity is what makes recovery safe, so a different
       version is not a recovery — and it cannot start either, because the
       line's one active slot is taken. Fail closed. */
    throw fail(
      CODES.RECONCILIATION_REQUIRED,
      "Another release for this order line is already in progress. Wait for it to finish, then decide against its result.",
      {
        reason: BLOCKED.PRIOR_DEMAND_ACTIVE,
        concurrent: true,
        inProgressReleaseId: String(active._id),
      },
    );
  }

  /* ══ 2 · A NEW ATTEMPT IS VERIFIED IN FULL ════════════════════════════ */
  const subject = await subjectFor(ctx, { orderId, lineRef, costingVersionId });

  const releaseKey = releaseKeyFor({
    companyId: ctx.companyId,
    orderId,
    lineRef,
    costingVersionId,
    requirement: subject.requirement,
    orderedQuantity: subject.orderedQuantity,
  });

  /* ══ 3 · THE SAME SIX FACTS ARE THE SAME DECISION ══════════════════════
     A row whose release key matches but which has already been SUPERSEDED:
     the decision was taken and then replaced. Re-pressing the same button
     reports it rather than raising the demand a second time. (The ACTIVE
     cases — PENDING and RELEASED for this line — were answered above, by
     identity, before any live source was read.) */
  const settled = await DemandRelease().findOne({
    companyId: ctx.companyId, releaseKey, state: { $in: ["RELEASED", "SUPERSEDED"] },
  }).lean();
  if (settled) {
    await supersedePredecessor(ctx, settled);
    return {
      outcome: "ALREADY_RELEASED",
      releaseId: String(settled._id),
      ...(await stateFor(ctx, { orderId, lineRef, costingVersionId })),
    };
  }

  /* ══ 4 · EARLIER DEMAND MUST BE FULLY ACCOUNTED FOR ════════════════════ */
  const prior = await DemandRelease().findOne({
    companyId: ctx.companyId, orderId, lineRef: str(lineRef), state: "RELEASED",
  }).sort({ releasedAt: -1 }).lean();

  if (prior) await assertPriorSettled(ctx, prior);

  /* ══ 4 · THE COMMAND IS RESOLVED BEFORE ANY ROW MOVES ═════════════════
     Selection happens HERE, while it is still answerable: no requests exist
     for these requirements yet, so `prepare` reports them selectable. After
     the handoff runs they read as spoken for, and re-deriving would produce
     an empty list — which is why the resolved ids are frozen onto the claim
     rather than recomputed on recovery.

     It also happens BEFORE the predecessor is touched. A refusal here — no
     approved requirements, nothing left selectable — must leave the line
     exactly as it was found, with its existing release still RELEASED. */
  const command = await resolveCommand(ctx, subject, releaseKey, actor);

  const doc = {
    companyId: ctx.companyId,
    orderId,
    orderNumber: str(subject.order.requestNumber),
    lineRef: str(lineRef),
    orderStatusAtRelease: str(subject.order.status),
    sampleStyleId: subject.style._id,
    styleCode: str(subject.style.styleCode),
    productName: str(subject.style.productName),
    orderedQuantity: subject.orderedQuantity,
    scenarioKey: subject.scenarioKey,
    costingId: subject.costing._id,
    costingVersionId: subject.version._id,
    costingVersionNumber: subject.version.versionNumber ?? null,
    pricingContract: "MARKUP_FLOOR_V2",
    requirementRevision: {
      technicalRevision: subject.requirement.technicalRevision,
      bomApprovalStatus: subject.requirement.bomApprovalStatus,
      sampleStatus: subject.requirement.sampleStatus,
    },
    releaseKey,
    handoffCommand: command,
    state: "PENDING",
    supersedesReleaseId: prior?._id || null,
    releasedByActorId: str(actor.id),
    releasedByActorName: str(actor.name),
    releasedAt: new Date(),
  };

  /* ══ 5 · THE SLOT CHANGES HANDS IN ONE STEP ═══════════════════════════ */
  let claim;
  try {
    claim = prior ? await replaceAtomically(ctx, prior, doc) : await DemandRelease().create(doc);
  } catch (err) {
    if (err?.code === 11000) return onClaimRace(ctx, { releaseKey, orderId, lineRef, costingVersionId, err });
    throw err;
  }

  const created = await replayCommand(ctx, claim);
  return completeRelease(ctx, { claim, created, orderId, lineRef, costingVersionId });
}

/**
 * HAND THE ONE ACTIVE SLOT FROM THE PREDECESSOR TO ITS SUCCESSOR, OR NEITHER.
 *
 * ── WHY THIS CANNOT BE TWO WRITES ───────────────────────────────────────────
 * One active release per order line is enforced by a partial unique index over
 * PENDING and RELEASED rows, so the predecessor must leave that set before the
 * successor may enter it. Doing that as two statements opens a window: if the
 * process stops between them the line is left with a SUPERSEDED predecessor
 * and no successor at all, and the next attempt — finding nothing RELEASED —
 * writes a successor with `supersedesReleaseId: null`. The chain is then gone,
 * and nothing in the record says it ever existed.
 *
 * So the two writes are one unit. Either the predecessor is superseded AND the
 * successor's claim exists, or the line is exactly as it was found.
 *
 * ── AND THE CONDITION IS THE CONCURRENCY CONTROL ────────────────────────────
 * The vacate names the exact row and the exact state it was validated in. A
 * second replacement racing this one finds nothing to move — its predecessor
 * has already gone — and is refused rather than superseding a row twice or
 * raising a second set of actionable demand. The unique index remains as the
 * backstop for the case the condition cannot see: two FIRST releases, neither
 * of which has a predecessor to move.
 *
 * The back-pointer is still not written here. The successor's id exists by the
 * time this commits, but naming it on the predecessor before the handoff has
 * run would assert a completed succession that may yet fail. It is written at
 * completion, conditioned on being empty, and is therefore healable on retry.
 */
async function replaceAtomically(ctx, prior, doc) {
  /* ── FAIL CLOSED, BEFORE EITHER ROW MOVES ─────────────────────────────
     A deployment that cannot give a transaction cannot give this guarantee.
     Refusing here costs a release; doing it anyway costs the chain. */
  if (!(await unitOfWork.transactionsAvailable())) {
    throw fail(
      "MERCHANDISING_TRANSACTION_REQUIRED",
      "This deployment cannot replace the existing release atomically, so the earlier release has been left "
      + "exactly as it was. Ask an operator — the database needs a replica set.",
      { reason: BLOCKED.PRIOR_DEMAND_UNVERIFIABLE, priorReleaseId: String(prior._id), retryable: true },
    );
  }

  const session = await mongoose.startSession();
  try {
    let claim = null;
    await session.withTransaction(async () => {
      /* `withTransaction` re-runs this body after a write conflict, so it
         starts from nothing every time rather than from the last attempt. */
      claim = null;

      const vacated = await DemandRelease().updateOne(
        { _id: prior._id, state: "RELEASED" },
        { $set: { state: "SUPERSEDED", supersededAt: new Date() } },
        { session },
      );
      if (vacated.modifiedCount !== 1) {
        throw fail(
          CODES.RECONCILIATION_REQUIRED,
          "Another release for this order line was decided while this one was being prepared. "
          + "Read the current release, then decide against its result.",
          { reason: BLOCKED.PRIOR_DEMAND_ACTIVE, priorReleaseId: String(prior._id), concurrent: true },
        );
      }

      const [row] = await DemandRelease().create([doc], { session });
      claim = row;
    });
    return claim;
  } finally {
    await session.endSession().catch(() => {});
  }
}

/**
 * Two different races land on the unique indexes, and they mean different
 * things.
 */
async function onClaimRace(ctx, { releaseKey, orderId, lineRef, costingVersionId, err }) {
  /* Same six facts: somebody else's identical press won. Their row is the
     answer, finished if they were interrupted. */
  const same = await DemandRelease().findOne({ companyId: ctx.companyId, releaseKey }).lean();
  if (same) {
    return same.state === "PENDING"
      ? finishPending(ctx, { pending: same, orderId, lineRef, costingVersionId })
      : {
        outcome: "ALREADY_RELEASED",
        releaseId: String(same._id),
        ...(await stateFor(ctx, { orderId, lineRef, costingVersionId })),
      };
  }

  /* ── DIFFERENT FACTS, SAME ORDER LINE ──────────────────────────────────
     Two concurrent successors — different quantities, or different costing
     versions — each with its own release key. The key could not separate
     them; the one-active-slot index does. Whichever committed second is
     refused here rather than producing a second set of actionable demand. */
  if (String(err?.message || "").includes("one_active_release_per_line")
    || String(err?.keyPattern && Object.keys(err.keyPattern).join(",")) === "companyId,orderId,lineRef") {
    throw fail(
      CODES.RECONCILIATION_REQUIRED,
      "Another release for this order line is already in progress. Wait for it to finish, then decide against its result.",
      { reason: BLOCKED.PRIOR_DEMAND_ACTIVE, concurrent: true },
    );
  }
  throw err;
}

/**
 * Is the earlier release's demand fully accounted for AND closed?
 *
 * ── THREE ANSWERS, AND ONLY ONE OF THEM ALLOWS A SUCCESSOR ──────────────────
 * Every referenced request found and closed; some still active; or some
 * missing or unreadable. The third is not "nothing is active" — it is not
 * knowing, and a successor raised on it could double the demand for one order
 * line without anybody seeing it happen.
 */
/**
 * THE VERDICT ON EARLIER DEMAND, AS A READ.
 *
 * ── WHY THIS IS NOT JUST `assertPriorSettled` ───────────────────────────────
 * A read model has to answer the same question the command answers — may a
 * successor be raised over this line? — and a function that throws cannot be
 * asked. Splitting the verdict out means the screen and the command consult ONE
 * rule. Restating "which request statuses count as open" in a presentation
 * layer would be a second answer, and the second answer is the one that drifts.
 *
 * Three outcomes, and only one of them allows a successor: every reference
 * found and closed; some still active; or some missing or unreadable. The third
 * is not "nothing is active" — it is not knowing, and a successor raised on it
 * could double the demand for one order line without anybody seeing it happen.
 */
async function priorDemandVerdict(ctx, prior) {
  const ids = prior?.demand?.spendRequestIds || [];
  const state = await costingDemand.stateOfRequests(ctx, ids);
  const priorReleaseId = String(prior?._id || prior?.releaseId || "");

  if (state.unreadable) {
    return {
      ok: false,
      reason: BLOCKED.PRIOR_DEMAND_UNVERIFIABLE,
      message: "Whether the demand released earlier is still open could not be checked. Try again.",
      details: { priorReleaseId, retryable: true },
    };
  }
  if (!state.accounted) {
    return {
      ok: false,
      reason: BLOCKED.PRIOR_DEMAND_UNVERIFIABLE,
      message: "Some of the demand released earlier for this line cannot be found, so it cannot be shown to be "
        + "closed. Account for it in Requests before releasing again.",
      details: {
        priorReleaseId,
        missingRequestCount: (state.missing || []).length,
        remedy: "CLOSE_IN_REQUESTS",
      },
    };
  }
  if (state.anyActive) {
    return {
      ok: false,
      reason: BLOCKED.PRIOR_DEMAND_ACTIVE,
      message: "Demand released earlier for this line is still open. Close or reject it in Requests before "
        + "releasing again, so the same order line is not bought twice.",
      details: {
        priorReleaseId,
        priorOrderedQuantity: prior.orderedQuantity,
        openRequests: (state.active || []).map((r) => ({
          requestNumber: r.requestNumber, requestType: r.requestType, status: r.status,
        })),
        /* Merchandising does not close them. A request is cancelled through
           its own workflow by whoever owns it. */
        remedy: "CLOSE_IN_REQUESTS",
      },
    };
  }
  return { ok: true, reason: null, message: "", details: { priorReleaseId } };
}

/** The same verdict, as the command's refusal. */
async function assertPriorSettled(ctx, prior) {
  const verdict = await priorDemandVerdict(ctx, prior);
  if (verdict.ok) return;
  throw fail(CODES.RECONCILIATION_REQUIRED, verdict.message, {
    reason: verdict.reason, ...verdict.details,
  });
}

/**
 * Resolve and validate the requirements this release is for.
 *
 * Run once, before the claim, while selection still has an answer.
 */
async function resolveCommand(ctx, subject, releaseKey, actor) {
  const prepared = await projectionHandoff.prepare(handoffCtxOf(ctx, actor), {
    costingId: subject.costing._id, scenarioKey: subject.scenarioKey,
  });
  if (!prepared.available) {
    throw refuse(BLOCKED.REQUIREMENTS_NOT_APPROVED, prepared.message, { reason: prepared.reason });
  }

  const selectable = (prepared.requirements || []).filter((r) => r.selectable);
  if (!selectable.length) {
    throw refuse(
      BLOCKED.REQUIREMENTS_NOT_APPROVED,
      "There is nothing left to request for this quantity — every requirement is already spoken for or blocked.",
    );
  }

  return {
    scenarioKey: subject.scenarioKey,
    requirementIds: selectable.map((r) => r.requirementId),
    /* Derived from the release facts rather than minted, so the handoff's own
       bookkeeping and this claim agree about what ONE attempt is. */
    idempotencyKey: `demand-release:${releaseKey.slice(0, 32)}`,
    purpose: `Confirmed order ${str(subject.order.requestNumber) || String(subject.order._id)} line ${str(subject.line.lineRef)}`,
  };
}

const handoffCtxOf = (ctx, actor) => ({
  companyId: ctx.companyId,
  actorId: str(actor.id),
  actorName: str(actor.name),
  capabilitySet: new Set(),
});

/**
 * Send the frozen command to the handoff.
 *
 * ── NO SELECTION LOGIC RUNS HERE ────────────────────────────────────────────
 * The requirement ids and the idempotency key are the ones the claim froze.
 * The handoff recognises the key and either performs the work or replays the
 * answer it already gave — so an interrupted attempt returns the SAME
 * requests rather than a second set.
 */
function replayCommand(ctx, claim) {
  const command = claim.handoffCommand || {};
  /* ── AND UNDER THE IDENTITY THAT STARTED IT ───────────────────────────
     The claim froze who pressed the button. A colleague who retries an
     interrupted release is finishing THAT person's action, not taking it
     over: replaying under the retrying user would author the Spend Requests
     to them while the release row still named the initiator, and the two
     records would disagree about who committed the company to buy.

     The retrying user still has to hold the release grant — that is checked
     on the way in. Holding it lets them finish the command; it does not make
     them its author. */
  const initiator = { id: str(claim.releasedByActorId), name: str(claim.releasedByActorName) };
  return projectionHandoff.handoff(handoffCtxOf(ctx, initiator), {
    costingId: claim.costingId,
    costingVersionId: String(claim.costingVersionId),
    scenarioKey: str(command.scenarioKey) || claim.scenarioKey,
    requirementIds: command.requirementIds || [],
    purpose: str(command.purpose),
    idempotencyKey: str(command.idempotencyKey),
  });
}

/** Finish a claim whose handoff may or may not already have run. */
async function finishPending(ctx, { pending, orderId, lineRef, costingVersionId }) {
  const created = await replayCommand(ctx, pending);
  return completeRelease(ctx, {
    claim: pending, created, orderId, lineRef, costingVersionId, recovered: true,
  });
}

/** Link a completed release back to whatever it supersedes. Idempotent. */
async function supersedePredecessor(ctx, claim) {
  if (!claim.supersedesReleaseId) return null;
  const prior = await DemandRelease().findById(claim.supersedesReleaseId).lean();
  if (!prior) return null;

  /* Vacating the slot happens before the claim; naming the successor happens
     here, once it exists. Conditioned on the pointer still being empty, so a
     retry after a crash between the two completes the link and a retry after
     a completed one changes nothing. */
  await DemandRelease().updateOne(
    { _id: prior._id, supersededByReleaseId: null },
    { $set: { state: "SUPERSEDED", supersededByReleaseId: claim._id, supersededAt: prior.supersededAt || new Date() } },
  );
  return prior;
}

/**
 * Stamp the demand onto the claim, then supersede its predecessor.
 *
 * ── EVERY STEP IS SAFE TO REPEAT ────────────────────────────────────────────
 * The stamp is conditioned on the row still being PENDING and the supersede on
 * the predecessor still being RELEASED, so a retry after a crash between them
 * completes the chain rather than doubling it or undoing it.
 */
async function completeRelease(ctx, { claim, created, orderId, lineRef, costingVersionId, recovered = false }) {
  const drafts = created.drafts || [];
  /* ── THE REQUESTS DOMAIN NAMES ITS OWN ROWS `requestId` ───────────────
     `createDraftsFromCosting` returns `{requestId, requestNumber, ...}`
     summaries, not mongoose documents. Reading `_id` alone stored an empty
     list — the release row then claimed to reference nothing while two real
     requests existed, and the reconciliation check that guards a successor
     would have found nothing to account for. */
  const ids = drafts
    .map((d) => d.requestId || d._id || d.id)
    .filter(Boolean)
    .map(String);

  await DemandRelease().updateOne(
    { _id: claim._id, state: "PENDING" },
    {
      $set: {
        state: "RELEASED",
        demand: {
          spendRequestIds: ids,
          productRequestId: created.productRequest?.requestId
            || created.productRequest?._id || null,
          serviceRequestId: created.serviceRequest?.requestId
            || created.serviceRequest?._id || null,
          requirementCount: ids.length,
        },
      },
    },
  );

  /* The predecessor's own demand references stay exactly as they were: those
     requests were really raised, and the history of what was asked for must
     survive. By this point they are all closed — an active or unaccounted one
     refused the successor before the claim was written. */
  const prior = await supersedePredecessor(ctx, claim);

  return {
    outcome: recovered ? "RECOVERED" : (prior ? "RELEASED_SUPERSEDING" : "RELEASED"),
    releaseId: String(claim._id),
    supersededReleaseId: prior ? String(prior._id) : null,
    ...(await stateFor(ctx, { orderId, lineRef, costingVersionId })),
  };
}

module.exports = {
  CODES, BLOCKED, CONFIRMED_STATUSES,
  subjectFor, requirementRevisionOf, releaseKeyFor, sameQuantity, pricedLineFor,
  stateFor, release,
  /* Read helpers for callers that address this authority by something other
     than the three identities. Neither decides anything. */
  activeReleaseFor, holdsRelease, priorDemandVerdict,
};
