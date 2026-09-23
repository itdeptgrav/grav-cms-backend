// services/centralCosting/sourceAppRequirements.service.js
//
// LANE B — WHAT MY DEPARTMENT STILL OWES COSTING, ON THIS STYLE OR ENQUIRY.
//
// ── WHY THIS IS A READ AND NOTHING ELSE ─────────────────────────────────────
// Every fact below already lives in somebody's record: the BOM on the style,
// the consumption on the technical record, the delivery terms on the enquiry,
// the quotation in Store's register, the rate in the company policy. This
// service resolves their PRESENCE and reports it. It creates no task, no
// checklist row, no duplicate BOM and no shadow quotation — a second copy of a
// fact is a second thing to keep in step, and the one nobody updates is the one
// the screen reads.
//
// ── COMPANY FIRST, THEN DEPARTMENT ──────────────────────────────────────────
// A style is proved to belong to the caller's company through
// `technicalSource.ownershipProofFor` — the module's own exported rule, reused
// rather than reimplemented, because a second ownership check is a second thing
// that can drift and only one of them would be audited. An enquiry carries its
// own `companyId` and is queried with it, never filtered after the fact.
//
// A department then sees only the app it holds a grant in. Holding no grant is
// not an empty list — it is a refusal, because an empty list reads as "nothing
// is outstanding" and that is a different and untrue statement.
//
// ── AND IT PUBLISHES NO MONEY ───────────────────────────────────────────────
// No rate, no quoted amount, no supplier name, no policy value, no margin, no
// cost. A quotation is reported as EXISTING or NOT EXISTING, and a policy as IN
// FORCE or NOT IN FORCE. That is everything the owner of a gap needs, and it is
// the most that can be said without handing one department another's evidence.
//
// ── PACKAGING IS LANE A'S ───────────────────────────────────────────────────
// No packaging selection, no packaging requirement, no carton capacity is read
// or reported here. `sourceApps.js` names none, and the family filter below
// drops the key even if one were ever added by accident.
"use strict";

const mongoose = require("mongoose");

const {
  SOURCE_APP, SUBJECT, STATUS, STATUS_LABEL, BLOCKING_STATUSES, SCOPE,
  SOURCE_FORM, BLOCKER, BOARD_POLICIES, EXCLUDED_FAMILIES,
  requirementsFor, appsForGrants, APP_GRANT,
} = require("./sourceApps");
/* Exported by that module precisely so a second caller proves a style's
   company the same way rather than growing a rule that could drift from it. */
const { ownershipProofFor } = require("./technicalSource.service");
/* Store's own sourcing facts, reduced to completeness. It computes no duty and
   holds no rate — the table that would is the Board's, and does not exist. */
const sourcingEvidence = require("../storePurchase/sourcingEvidence.service");
/* Sales' structured payment terms — the duration half of financing. */
const paymentTermsResolution = require("../sales/paymentTermsResolution.service");
/* The three-field shape the departments write their applicability answers in.
   Read here, never written: this whole file is a read. */
const styleApplicability = require("../styleApplicability");
/* The Board's own lifecycle. Required lazily like the models below, so a pure
   test of this file's rules does not need a live mongoose registry. */
const boardPolicyService = () => require("../board/boardPolicy.service");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const present = (v) => v !== null && v !== undefined && v !== "";
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

/* Models resolved lazily, the way the rest of this folder does it: requiring a
   model at module load couples every consumer of this file to a live mongoose
   registry, which a pure test does not have. */
const model = (name, path) => (mongoose.models[name] || require(path));
const SampleStyle = () => model("SampleStyle", "../../models/CMS_Models/Sales/SampleStyle");
const Enquiry = () => model("Enquiry", "../../models/CMS_Models/Sales/Enquiry");
const SupplierOffer = () => model("SupplierOffer", "../../models/CMS_Models/Inventory/Sourcing/SupplierOffer");
const ServiceSupplierOffer = () => model("ServiceSupplierOffer", "../../models/CMS_Models/Inventory/Sourcing/ServiceSupplierOffer");
const FreightOffer = () => model("FreightOffer", "../../models/CMS_Models/Inventory/Sourcing/FreightOffer");
const Operation = () => model("Operation", "../../models/CMS_Models/Inventory/Configurations/Operation");
const CostingPolicy = () => model("CostingPolicy", "../../models/CMS_Models/Costing/CostingPolicy");

/* ══ GATHERING THE FACTS ═══════════════════════════════════════════════════
 *
 * One pass per subject, then every requirement is resolved from the same
 * snapshot. Reading per requirement would ask the same collection five times
 * and — worse — could answer two requirements from two different moments. */

/** What the style records, reduced to presence. No specification text, no note. */
function styleFacts(style) {
  if (!style) return { present: false };
  const technical = style.techSheet?.technical || {};
  /* Merchandising's chosen components. The `rawItems` shortlist is the
     structured BOM; `items` is the legacy free-text list and is counted only
     as evidence that somebody started. */
  const bomRows = (style.materials?.rawItems || []).filter((r) => r && r.rawItemId);
  const legacyBomNames = (style.materials?.items || []).filter(Boolean);

  const technicalMaterials = (technical.materials || []).map((m) => ({
    rawItemId: str(m.rawItemId),
    name: str(m.rawItemName),
    /* Measured, or not. A zero IS a measurement somebody made; absent is not. */
    measured: present(m.consumptionPerPiece) && Number.isFinite(Number(m.consumptionPerPiece)),
    unit: str(m.unit),
    returned: Boolean(m.returnedToMaterials?.at),
  }));

  const operations = (technical.operations || []).map((o) => ({
    operationId: str(o.operationId),
    code: str(o.operationCode),
    name: str(o.name),
    timed: Number(o.minutes || 0) > 0 || Number(o.seconds || 0) > 0,
  }));

  /* ── AND THE TWO DEPARTMENT-OWNED APPLICABILITY DECISIONS ─────────────
     Production's "nothing goes outside" and Merchandising's "no development
     work". A state and nothing else: the reason belongs to the department
     that wrote it and is published on their own screen, not on somebody
     else's readiness list. */
  const outsideProcessDecision = styleApplicability.decisionView(style.sample?.outsideProcessDecision);
  const developmentDecision = styleApplicability.decisionView(style.sample?.developmentDecision);

  /* Only the two non-packaging purposes. A row with no purpose is an outside
     process, which is what every row written before the field existed was. */
  const serviceRows = (style.sample?.serviceRequirements || []).map((s) => ({
    rowId: str(s.rowId),
    purpose: str(s.purpose) || "OUTSIDE_PROCESS",
    serviceId: str(s.serviceId),
    name: str(s.serviceName) || str(s.description),
    /* Which of the two sources a development row names. Carried so the
       readiness can tell "bought outside, service chosen" from "done
       in-house, charge chosen" from "nobody has said which". No amount and
       no rate: the charge is named by its KEY, which is not a value. */
    developmentSource: str(s.developmentSource),
    developmentChargeKey: str(s.developmentChargeKey),
    included: s.included !== false,
  })).filter((s) => s.included);

  return {
    present: true,
    id: str(style._id),
    reference: str(style.styleCode) || str(style.sampleStyleId) || str(style.productName),
    label: [str(style.productName), str(style.variantLabel)].filter(Boolean).join(" — ")
      || str(style.styleCode) || "Untitled style",
    enquiryId: str(style.enquiryId),
    journeyId: str(style.journeyId),
    bomCount: bomRows.length,
    bomItemIds: bomRows.map((r) => str(r.rawItemId)).filter(Boolean),
    legacyBomOnly: bomRows.length === 0 && legacyBomNames.length > 0,
    technicalStatus: str(technical.status) || "not_started",
    technicalMaterials,
    operations,
    services: serviceRows.filter((s) => s.purpose === "OUTSIDE_PROCESS"),
    outsideProcessDecision,
    developmentDecision,
    development: serviceRows.filter((s) => s.purpose === "DEVELOPMENT_TOOLING"),
    packedWeightGrams: style.sample?.shipment?.packedWeightGrams ?? null,
  };
}

/** The enquiry's commercial terms, reduced to presence. No customer detail. */
function enquiryFacts(enquiry) {
  if (!enquiry) return { present: false };
  const f = enquiry.freight || {};
  return {
    present: true,
    id: str(enquiry._id),
    /* Filled in by the caller, which knows the product and can read the
       fingerprint. Reduced to a STATE and an identity — never the
       quantities, the unit or the proposed price, which are Sales' own and
       are read from their own screen. */
    costingBrief: enquiry.__costingBrief || { state: "NONE" },
    /* The business number a person quotes, not the ObjectId. `enquiryId` is
       the immutable human reference on the record; `_id` is the database's. */
    reference: str(enquiry.enquiryId) || str(enquiry._id),
    journeyId: str(enquiry.journeyId),
    arrangement: str(f.arrangement),
    mode: str(f.mode),
    shippingAddressId: str(f.shippingAddressId),
    originWarehouseId: str(f.originWarehouseId),
    prepaidTreatment: str(f.prepaidTreatment),
    /* Structured payment terms, as Sales confirmed them. Carries the
       duration and the advance — never a financing rate or amount, which
       are the Board's and are not a departmental readiness fact. */
    paymentTerms: paymentTermsResolution.projectionFor(enquiry),
  };
}

/**
 * Which of these items and services have an ACTIVE quotation.
 *
 * `distinct` rather than `find`: it returns ids and nothing else, so there is
 * no path by which a rate, a supplier or a reference could reach this payload
 * even by mistake. Expiry is deliberately not applied — an expired quotation is
 * a Store decision to revise, not an absence, and reporting it as absent would
 * send Store to create a duplicate of one they already have.
 */
async function storeFacts(companyId, { itemIds = [], serviceIds = [], originWarehouseId = null } = {}) {
  const out = { quotedItemIds: new Set(), quotedServiceIds: new Set(), freightLaneOffers: 0 };

  if (itemIds.length) {
    const ids = await SupplierOffer().distinct("itemId", {
      companyId, status: "ACTIVE", itemId: { $in: itemIds.filter(isId) },
    }).catch(() => []);
    for (const i of ids) out.quotedItemIds.add(str(i));
  }
  if (serviceIds.length) {
    const ids = await ServiceSupplierOffer().distinct("serviceId", {
      companyId, status: "ACTIVE", serviceId: { $in: serviceIds.filter(isId) },
    }).catch(() => []);
    for (const i of ids) out.quotedServiceIds.add(str(i));
  }
  if (isId(originWarehouseId)) {
    out.freightLaneOffers = await FreightOffer().countDocuments({
      companyId, status: "ACTIVE", originWarehouseId,
    }).catch(() => 0);
  }
  return out;
}

/** Registered operations whose salary basis is unset. Codes and names only. */
async function operationMasterFacts(companyId, operations = []) {
  const ids = operations.map((o) => o.operationId).filter(isId);
  if (!ids.length) return { unset: [], checked: false };
  /* ── THE OPERATION MASTER HAS NO COMPANY ──────────────────────────────
     `Operation` carries no `companyId`; it is a global register today. This
     filtered on one, which matched NOTHING — so every style reported "every
     operation has a salary basis" whether or not any did, which is exactly
     the false-ready this whole module exists to prevent. Filtered by id only,
     and the missing tenancy is recorded in the Lane B input map rather than
     faked here. */
  const rows = await Operation()
    .find({ _id: { $in: ids } })
    .select("name operationCode salaryDept salaryDesig")
    .lean()
    .catch(() => []);
  return {
    checked: true,
    unset: rows
      .filter((r) => !str(r.salaryDept) && !str(r.salaryDesig))
      .map((r) => str(r.name) || str(r.operationCode))
      .filter(Boolean),
  };
}

/**
 * WHICH POLICIES ARE IN FORCE — and not one of their values.
 *
 * The whole point of the boundary: a merchandiser reading "overhead: in force"
 * learns that costing can proceed. A merchandiser reading "overhead: 8%" has
 * learnt the company's overhead, which is Finance's and the Board's.
 */
async function policyFacts(companyId) {
  const policy = await CostingPolicy().findOne({ companyId }).lean().catch(() => null);
  const configured = {};
  /* ── DATING, PER POLICY, BECAUSE THEY ARE NOT ALL THE SAME NOW ────────
     Five have real Board records with an approval and an effective date —
     financing, overhead, labour, input GST and the development charge
     catalogue. The contingency rule and the margin band are still fields on
     the mutable `CostingPolicy` row, which can say whether a value is filled
     in and nothing about whether anybody approved it. Reporting one answer
     for both would either invent an effective date the older ones do not
     hold, or throw away the ones the migrated policies genuinely have. */
  const dated = {};

  for (const p of BOARD_POLICIES) {
    if (p.boardPolicyKey) {
      /* ── FOUR ANSWERS, NOT A BOOLEAN ───────────────────────────────
         "Not in force" covers four situations a department needs to tell
         apart, and only one of them means somebody has to make a decision:

           EFFECTIVE    in force for this date;
           FUTURE_ONLY  approved, its date has not arrived — nobody need act;
           DRAFT_ONLY   written and awaiting an APPROVER, not an author;
           NONE         nothing exists.

         Collapsed into one flag, a department chasing "the Board has not
         decided" would be wrong in two of the four cases. */
      const resolved = await boardPolicyService()
        .resolveState(companyId, p.boardPolicyKey, new Date())
        .catch(() => null);
      configured[p.key] = resolved?.state === "EFFECTIVE";
      dated[p.key] = {
        /* ── PRESENCE AND DATES ONLY, NEVER THE RULE ────────────────
           No rate, no basis, no methodology, for any caller. A department
           needs to know whether the company has decided and who to ask; what
           the company decided is not theirs to read from a requirements
           list. */
        state: resolved?.state || "NONE",
        effectiveFrom: resolved?.effectiveFrom || null,
        boardApproved: resolved?.state === "EFFECTIVE",
        approvedAt: resolved?.approvedAt || null,
        /* The approver's NAME, not the methodology. Who stands behind the
           company's rule is not commercial information; the rate is. */
        approvedByName: resolved?.approvedByName || "",
        /* What is queued, so a screen can say "changing on 1 April" without
           saying what it changes to. */
        nextEffectiveFrom: resolved?.nextEffectiveFrom || null,
        awaitingApproval: (resolved?.draftCount || 0) > 0,
      };
      continue;
    }
    if (!p.policyField) { configured[p.key] = false; continue; }
    const raw = policy?.[p.policyField];
    configured[p.key] = Array.isArray(raw)
      ? raw.length > 0
      : (Array.isArray(raw?.definitions) ? raw.definitions.length > 0 : present(raw));
  }

  return {
    /* A revision number is not a rate. It is published so a screen can say
       "checked against revision 4" without saying what revision 4 contains. */
    revision: policy?.revision ?? null,
    /* Unknown for the policies that are still fields on `CostingPolicy`:
       claiming an effective date the record does not hold is worse than
       saying it is not recorded. `dated` carries the real answer for the ones
       that have a Board record. */
    effectiveFrom: null,
    boardApproved: null,
    dated,
    configured,
  };
}

/* ══ RESOLVING ONE REQUIREMENT ═════════════════════════════════════════════ */

const answer = (status, reason, extra = {}) => ({ status, reason, ...extra });

/**
 * Status for one requirement, from the gathered facts.
 *
 * Pure and exported, so every branch is exercised without a database. A rule
 * that can only be reached through a route is a rule nobody checks.
 */
function resolveRequirement(requirement, facts) {
  const style = facts.style || { present: false };
  const enq = facts.enquiry || { present: false };
  const store = facts.store || { quotedItemIds: new Set(), quotedServiceIds: new Set(), freightLaneOffers: 0 };
  const ops = facts.operationMaster || { unset: [], checked: false };

  /* ── A FACT WITH NO FORM IS BLOCKED, WHATEVER THE DATA SAYS ────────────
     Reported before anything is evaluated: the answer is "there is nowhere to
     record this", and dressing it as "not started" would send somebody to look
     for a screen that does not exist. */
  if (requirement.sourceForm === SOURCE_FORM.MISSING) {
    return answer(STATUS.BLOCKED, requirement.blocker?.message || "There is no form for this yet.");
  }

  switch (requirement.key) {
    /* ── MERCHANDISING ─────────────────────────────────────────────── */
    case "MATERIAL_BOM_IDENTITY": {
      if (!style.present) return answer(STATUS.NOT_STARTED, "No style record yet.");
      if (style.bomCount > 0) {
        return answer(STATUS.READY, `${style.bomCount} material${style.bomCount === 1 ? "" : "s"} chosen.`);
      }
      if (style.legacyBomOnly) {
        /* Names typed as free text. Real work, and not a BOM a costing can
           resolve to an item master — so in progress, not ready. */
        return answer(STATUS.IN_PROGRESS,
          "Materials are recorded as free text. Costing needs each one chosen from the item master.");
      }
      return answer(STATUS.NOT_STARTED, "No materials have been chosen for this style.");
    }

    /* ── R&D ───────────────────────────────────────────────────────── */
    case "MATERIAL_CONSUMPTION": {
      if (!style.present) return answer(STATUS.NOT_STARTED, "No style record yet.");
      if (style.bomCount === 0) {
        /* The single most useful thing this whole projection does: R&D cannot
           measure a component nobody has chosen, and telling them "missing"
           sends them to a form that cannot accept the answer. */
        return answer(STATUS.AWAITING_OTHER_DEPARTMENT,
          "Nothing to measure yet — the bill of materials has not been chosen.",
          { waitingOn: { app: SOURCE_APP.MERCHANDISING, department: "Merchandising" } });
      }
      const rows = style.technicalMaterials;
      if (!rows.length) return answer(STATUS.NOT_STARTED, "No consumption has been recorded yet.");
      const unmeasured = rows.filter((r) => !r.measured);
      if (unmeasured.length) {
        const names = unmeasured.map((r) => r.name).filter(Boolean).slice(0, 4);
        return answer(STATUS.IN_PROGRESS,
          `${unmeasured.length} of ${rows.length} materials have no consumption yet`
          + (names.length ? `: ${names.join(", ")}.` : "."));
      }
      const noUnit = rows.filter((r) => !r.unit);
      if (noUnit.length) {
        return answer(STATUS.IN_PROGRESS,
          `${noUnit.length} material${noUnit.length === 1 ? " has" : "s have"} a quantity with no unit.`);
      }
      return answer(STATUS.READY, `All ${rows.length} materials measured.`);
    }

    case "TECHNICAL_SPECIFICATION": {
      if (!style.present) return answer(STATUS.NOT_STARTED, "No style record yet.");
      const s = style.technicalStatus;
      if (s === "approved") return answer(STATUS.READY, "Approved. Costing reads this revision.");
      if (s === "submitted") {
        return answer(STATUS.AWAITING_OTHER_DEPARTMENT,
          "Submitted and waiting on Sales to approve it.",
          { waitingOn: { app: SOURCE_APP.SALES, department: "Sales" } });
      }
      if (s === "rework") return answer(STATUS.IN_PROGRESS, "Sent back for rework.");
      if (s === "draft") return answer(STATUS.IN_PROGRESS, "Still a draft. Costing reads an approved revision.");
      return answer(STATUS.NOT_STARTED, "The technical record has not been started.");
    }

    case "SHIPMENT_PACKED_WEIGHT": {
      if (!style.present) return answer(STATUS.NOT_STARTED, "No style record yet.");
      /* ── NOT NEEDED UNLESS THE COMPANY IS PAYING ──────────────────
         A customer who collects makes the packed weight irrelevant to this
         order's cost. Asking R&D to weigh a garment for a shipment the
         company will never book is how a readiness list loses its meaning. */
      if (enq.present && (enq.arrangement === "ex_works" || enq.arrangement === "to_pay")) {
        return answer(STATUS.NOT_APPLICABLE,
          `The customer bears the delivery on this order (${enq.arrangement.replace("_", " ")}), `
          + "so no freight is costed and no weight is needed.");
      }
      if (present(style.packedWeightGrams)) {
        return answer(STATUS.READY, `${style.packedWeightGrams} g per packed garment.`);
      }
      return answer(STATUS.NOT_STARTED, "No packed weight has been recorded.");
    }

    /* ── PRODUCTION ────────────────────────────────────────────────── */
    case "OPERATION_ROUTE_AND_SAM": {
      if (!style.present) return answer(STATUS.NOT_STARTED, "No style record yet.");
      const ops = style.operations;
      if (!ops.length) {
        return answer(STATUS.NOT_STARTED,
          "No operations are on this style yet. An unrouted style prices its labour at nothing.");
      }
      const untimed = ops.filter((o) => !o.timed);
      if (untimed.length) {
        const names = untimed.map((o) => o.name || o.code).filter(Boolean).slice(0, 4);
        return answer(STATUS.IN_PROGRESS,
          `${untimed.length} of ${ops.length} operations have no standard time`
          + (names.length ? `: ${names.join(", ")}.` : "."));
      }
      const unregistered = ops.filter((o) => !o.operationId);
      if (unregistered.length) {
        /* A legacy row, kept and readable, that names no registered
           operation. It cannot be costed and it is not silently dropped. */
        return answer(STATUS.IN_PROGRESS,
          `${unregistered.length} operation${unregistered.length === 1 ? "" : "s"} do not name a `
          + "registered operation. Choose them from the register.");
      }
      return answer(STATUS.READY, `${ops.length} operations, all timed.`);
    }

    /* ── MERCHANDISING ─────────────────────────────────────────────── */
    case "DEVELOPMENT_REQUIREMENT_IDENTITY": {
      if (!style.present) return answer(STATUS.NOT_STARTED, "No style record yet.");
      const rows = style.development;
      if (!rows.length) {
        /* ── AND SILENCE IS NOT "NONE NEEDED" ────────────────────────
           A style that genuinely needs no pattern, screen or tooling work is
           a normal case, and it is answered by saying so on the Development
           section — not by leaving it empty. An empty section reads as
           "nobody has looked", which is exactly what it is.

           There is now a place to say it, and saying it is an ANSWER: the
           family closes, and this requirement closes with it. */
        if (style.developmentDecision?.state === styleApplicability.DECISION.NOT_REQUIRED) {
          return answer(STATUS.NOT_APPLICABLE,
            "Merchandising recorded that this style needs no development or tooling work.");
        }
        return answer(STATUS.NOT_STARTED,
          "Nobody has said whether this style needs pattern, tooling or setup work.");
      }
      /* Identified means the row names WHERE the work comes from: a
         registered service when it is bought outside, or a configured
         company charge when the company does it itself. Never both. */
      const unidentified = rows.filter((r) => (
        r.developmentSource === "COMPANY_POLICY" ? !r.developmentChargeKey : !r.serviceId
      ));
      if (unidentified.length) {
        const names = unidentified.map((r) => r.name).filter(Boolean).slice(0, 3);
        return answer(STATUS.IN_PROGRESS,
          `${unidentified.length} of ${rows.length} requirements do not say where the work comes from`
          + (names.length ? `: ${names.join(", ")}.` : "."));
      }
      return answer(STATUS.READY,
        `${rows.length} development requirement${rows.length === 1 ? "" : "s"} recorded.`);
    }

    case "OPERATION_SALARY_BASIS": {
      if (!style.present) return answer(STATUS.NOT_STARTED, "No style record yet.");
      if (!style.operations.length) {
        return answer(STATUS.AWAITING_OTHER_DEPARTMENT,
          "No operations are on this style yet, so there is no salary basis to check.",
          { waitingOn: { app: SOURCE_APP.PRODUCTION, department: "Production" } });
      }
      if (!ops.checked) {
        return answer(STATUS.IN_PROGRESS,
          "The operations on this style are not linked to a registered operation, so their salary basis cannot be checked.");
      }
      if (ops.unset.length) {
        return answer(STATUS.NOT_STARTED,
          `${ops.unset.length} operation${ops.unset.length === 1 ? "" : "s"} have no salary basis: ${ops.unset.slice(0, 4).join(", ")}.`);
      }
      return answer(STATUS.READY, "Every operation on this style has a salary basis.");
    }

    /* ── SALES ─────────────────────────────────────────────────────── */
    /* ── WHAT SALES ASKED TO BE COSTED ────────────────────────────────
       A CALCULATION prerequisite: without it there is no style, no run size
       and no unit for any family to be priced at.

       Seven states, and the distinctions are the point. "No brief" and "a
       draft brief" are both blocking and are different work; "confirmed" and
       "confirmed but the style is no longer eligible" look identical on the
       record and mean opposite things. */
    case "SALES_COSTING_BRIEF": {
      if (!enq.present) return answer(STATUS.NOT_STARTED, "No enquiry record yet.");
      const b = enq.costingBrief || { state: "NONE" };
      switch (b.state) {
        case "NONE":
          return answer(STATUS.NOT_STARTED,
            "Nobody has said what to cost. Central Costing prices a confirmed brief and nothing else.");
        case "DRAFT":
          /* ── AND A DRAFT IS NOT AN ANSWER ───────────────────────────
             Sales is still deciding. Treating it as one would cost a request
             nobody has made. */
          return answer(STATUS.IN_PROGRESS,
            "A costing brief is saved but not confirmed. Central Costing reads a confirmed brief.");
        case "SUPERSEDED":
          return answer(STATUS.IN_PROGRESS,
            "The brief for this product was superseded and no replacement has been confirmed.");
        case "STYLE_INELIGIBLE":
          /* The style was approved when the brief was confirmed and is not
             now — a returned technical record, a new revision in draft. */
          return answer(STATUS.AWAITING_OTHER_DEPARTMENT,
            "The style this quotation names no longer has an approved technical record, "
            + "so there is nothing to cost it from.",
            { waitingOn: { app: SOURCE_APP.RND, department: "R&D" } });
        case "STALE":
          /* Confirmed, costed, and the sources have moved since. A real
             answer exists; it is simply out of date. */
          return answer(STATUS.IN_PROGRESS,
            "The estimate was prepared before some of its inputs changed. Refresh it to price "
            + "the current facts.");
        case "CURRENT":
          return answer(STATUS.READY, "Confirmed, and the estimate is current.");
        case "CONFIRMED":
        default:
          return answer(STATUS.READY, "Confirmed. Central Costing can price this.");
      }
    }

    case "PAYMENT_TERMS_DURATION": {
      if (!enq.present) return answer(STATUS.NOT_STARTED, "No enquiry record yet.");
      const pt = enq.paymentTerms || {};
      switch (pt.state) {
        case "NOT_APPLICABLE":
          /* ── THE ONLY ROUTE TO NOT-APPLICABLE ────────────────────────
             A stated commercial condition with a reason — a sample billed
             at cost, an intercompany transfer. Never silence, and never a
             100% advance, which is a financing duration of zero rather
             than an absence of financing. */
          return answer(STATUS.NOT_APPLICABLE,
            pt.notApplicableReason || "Financing does not apply to this order.");
        case "CONFIRMED": {
          const advance = pt.advancePercent;
          const days = pt.creditDays;
          const tail = days > 0 && pt.creditDaysFromLabel
            ? `, ${days} days from ${String(pt.creditDaysFromLabel).toLowerCase()}`
            : (days === 0 ? ", balance due immediately" : "");
          return answer(STATUS.READY, `${advance}% advance${tail}.`);
        }
        case "DRAFT": {
          const names = (pt.gaps || []).map((g) => g.message);
          return answer(STATUS.IN_PROGRESS,
            names.length ? names[0] : "The payment terms are recorded but not confirmed.");
        }
        default:
          /* ── AND AN UNANSWERED ORDER IS NOT A CASH ORDER ─────────────
             "Paid up front" is an advance of 100%, which somebody states.
             Silence is silence, and financing is never costed at nil
             because nobody was asked. */
          return answer(STATUS.NOT_STARTED,
            "Nobody has agreed when this order gets paid. An unanswered question is not a cash sale.");
      }
    }

    case "FREIGHT_ARRANGEMENT": {
      if (!enq.present) return answer(STATUS.NOT_STARTED, "No enquiry record yet.");
      if (!enq.arrangement) {
        return answer(STATUS.NOT_STARTED,
          "Nobody has said who bears the delivery on this order. It is never assumed and never costed at nil.");
      }
      return answer(STATUS.READY, `Recorded as ${enq.arrangement.replace("_", " ")}.`);
    }

    case "FREIGHT_DESTINATION": {
      if (!enq.present) return answer(STATUS.NOT_STARTED, "No enquiry record yet.");
      if (enq.arrangement === "ex_works" || enq.arrangement === "to_pay") {
        return answer(STATUS.NOT_APPLICABLE, "The customer arranges collection, so no lane is priced.");
      }
      if (!enq.shippingAddressId) {
        return answer(STATUS.NOT_STARTED,
          "No shipping address is chosen. The billing address is a different record and is never substituted.");
      }
      if (!enq.originWarehouseId) {
        return answer(STATUS.IN_PROGRESS, "The destination is set; the dispatch warehouse is not.");
      }
      if (!enq.mode) return answer(STATUS.IN_PROGRESS, "The lane is set; how it travels is not.");
      return answer(STATUS.READY, "Origin, destination and mode are recorded.");
    }

    case "FREIGHT_RECOVERY_DECISION": {
      if (!enq.present) return answer(STATUS.NOT_STARTED, "No enquiry record yet.");
      if (enq.arrangement !== "prepaid") {
        return answer(STATUS.NOT_APPLICABLE,
          enq.arrangement
            ? "Only a prepaid arrangement raises this question."
            : "Not asked until the delivery arrangement is recorded.");
      }
      if (!enq.prepaidTreatment) {
        return answer(STATUS.NOT_STARTED,
          "Prepaid says the company pays the carrier and nothing about recovering it. The two readings "
          + "differ by the whole freight amount.");
      }
      return answer(STATUS.READY,
        enq.prepaidTreatment === "IN_PRICE"
          ? "Absorbed into the garment price."
          : "Billed on to the customer at cost.");
    }

    /* ── STORE ─────────────────────────────────────────────────────── */
    case "SOURCING_ORIGIN_EVIDENCE": {
      if (!style.present) return answer(STATUS.NOT_STARTED, "No style record yet.");
      if (!style.bomItemIds.length) {
        return answer(STATUS.AWAITING_OTHER_DEPARTMENT,
          "Nothing to classify yet — the bill of materials has not been chosen.",
          { waitingOn: { app: SOURCE_APP.MERCHANDISING, department: "Merchandising" } });
      }
      const ev = facts.sourcing;
      if (!ev) {
        /* The read failed. Not the same fact as "nothing is recorded", and
           answering as though it were would turn a database blip into a
           customs statement. */
        return answer(STATUS.IN_PROGRESS, "The sourcing records could not be read just now.");
      }
      const roll = sourcingEvidence.rollUp(ev.items);
      switch (roll.state) {
        case sourcingEvidence.EVIDENCE.NOT_APPLICABLE:
          /* ── THE ONLY ROUTE TO NOT-APPLICABLE ────────────────────────
             Every material was stated DOMESTIC by Store, on a quotation.
             A decision somebody made and can be traced — never silence
             read as "no duty". */
          return answer(STATUS.NOT_APPLICABLE,
            "Every material on this style is bought in India, so there is no customs entry.");
        case sourcingEvidence.EVIDENCE.READY:
          return answer(STATUS.READY,
            `All ${ev.items.length} materials have their origin and classification recorded.`);
        case sourcingEvidence.EVIDENCE.NO_QUOTATION:
          return answer(STATUS.AWAITING_OTHER_DEPARTMENT,
            "There is no active quotation yet to record sourcing against.",
            { waitingOn: { app: SOURCE_APP.STORE, department: "Store / Purchase" } });
        case sourcingEvidence.EVIDENCE.IN_PROGRESS: {
          const names = [...new Set(roll.missing.map((m) => m.itemName).filter(Boolean))].slice(0, 3);
          return answer(STATUS.IN_PROGRESS,
            `${roll.missing.length} sourcing fact${roll.missing.length === 1 ? " is" : "s are"} still missing`
            + (names.length ? `: ${names.join(", ")}.` : "."));
        }
        default:
          return answer(STATUS.NOT_STARTED,
            "Nobody has said whether these materials are bought in India or imported. "
            + "An unanswered question is not a domestic supply.");
      }
    }

    case "MATERIAL_QUOTATION": {
      if (!style.present) return answer(STATUS.NOT_STARTED, "No style record yet.");
      if (!style.bomItemIds.length) {
        return answer(STATUS.AWAITING_OTHER_DEPARTMENT,
          "Nothing to quote yet — the bill of materials has not been chosen.",
          { waitingOn: { app: SOURCE_APP.MERCHANDISING, department: "Merchandising" } });
      }
      const missing = style.bomItemIds.filter((id) => !store.quotedItemIds.has(id));
      if (missing.length) {
        return answer(STATUS.NOT_STARTED,
          `${missing.length} of ${style.bomItemIds.length} materials have no active quotation.`);
      }
      return answer(STATUS.READY, `All ${style.bomItemIds.length} materials have an active quotation.`);
    }

    case "SERVICE_QUOTATION": {
      if (!style.present) return answer(STATUS.NOT_STARTED, "No style record yet.");
      const wanted = style.services.map((s) => s.serviceId).filter(Boolean);
      if (!style.services.length) {
        /* ── AND AN EMPTY LIST IS NOT "NOTHING GOES OUTSIDE" ─────────
           This used to answer NOT_APPLICABLE on an empty array, which read a
           style nobody had considered as a style that is finished entirely
           in-house. They are different facts and only one of them is an
           answer. Production states which, on their own outside-processes
           screen, and that statement is what closes this. */
        if (style.outsideProcessDecision?.state === styleApplicability.DECISION.NOT_REQUIRED) {
          return answer(STATUS.NOT_APPLICABLE, "Production recorded that nothing on this style is sent outside.");
        }
        return answer(STATUS.AWAITING_OTHER_DEPARTMENT,
          "Nobody has said whether anything on this style is sent outside. An unanswered question is not an in-house garment.",
          { waitingOn: { app: SOURCE_APP.PRODUCTION, department: "Production" } });
      }
      if (!wanted.length) {
        return answer(STATUS.AWAITING_OTHER_DEPARTMENT,
          "The outside processes on this style do not name a registered service yet.",
          { waitingOn: { app: SOURCE_APP.PRODUCTION, department: "Production" } });
      }
      const missing = wanted.filter((id) => !store.quotedServiceIds.has(id));
      if (missing.length) {
        return answer(STATUS.NOT_STARTED,
          `${missing.length} of ${wanted.length} outside processes have no active quotation.`);
      }
      return answer(STATUS.READY, `All ${wanted.length} outside processes are quoted.`);
    }

    case "FREIGHT_QUOTATION": {
      if (!enq.present) return answer(STATUS.NOT_STARTED, "No enquiry record yet.");
      if (enq.arrangement === "ex_works" || enq.arrangement === "to_pay") {
        return answer(STATUS.NOT_APPLICABLE, "The customer bears the delivery, so no lane is quoted.");
      }
      if (!enq.originWarehouseId || !enq.shippingAddressId) {
        return answer(STATUS.AWAITING_OTHER_DEPARTMENT,
          "The lane is not settled yet — a rate is quoted for an origin and a destination.",
          { waitingOn: { app: SOURCE_APP.SALES, department: "Sales" } });
      }
      if (!store.freightLaneOffers) {
        return answer(STATUS.NOT_STARTED, "No active freight quotation dispatches from this warehouse.");
      }
      return answer(STATUS.READY,
        `${store.freightLaneOffers} active freight quotation${store.freightLaneOffers === 1 ? "" : "s"} from this warehouse.`);
    }

    default:
      /* An unknown requirement is not "ready". Reporting it as one would be the
         "absent section reads as none needed" defect in a new place. */
      return answer(STATUS.NOT_STARTED, "This requirement has no resolver yet.");
  }
}

/**
 * THE BRIEF, AS ONE STATE.
 *
 * ── SEVEN ANSWERS, AND THE DISTINCTIONS ARE THE POINT ───────────────────────
 * `NONE` and `DRAFT` are both blocking and are different work — one needs
 * somebody to write a brief, the other needs somebody to press Confirm.
 * `CONFIRMED` and `STYLE_INELIGIBLE` look identical on the record and mean
 * opposite things. `CURRENT` and `STALE` both have an answer, and only one of
 * them is worth quoting.
 *
 * ── AND IT PUBLISHES NO COMMERCIAL FACT ─────────────────────────────────────
 * A state, the brief's identity and its revision. Not the quantities, not the
 * unit, not the proposed price: those are Sales' and are read on Sales' own
 * screen. A readiness list that carried them would hand every department the
 * customer's pricing.
 */
async function briefStateFor(ctx, enquiry, sf) {
  const costingBrief = require("../sales/costingBrief.service");
  const product = str(sf?.productName) || "";

  const all = (enquiry.costingBriefs || []);
  if (!all.length) return { state: "NONE" };

  const mine = product ? all.filter((b) => str(b.productName) === product) : all;
  if (!mine.length) return { state: "NONE" };

  const confirmed = mine.filter((b) => str(b.state) === "CONFIRMED");
  if (!confirmed.length) {
    /* A draft is a different fact from a superseded one: one is unfinished
       work, the other is a decision that was made and then changed. */
    if (mine.some((b) => str(b.state) === "DRAFT")) return { state: "DRAFT" };
    return { state: "SUPERSEDED" };
  }

  const brief = costingBrief.briefView(confirmed[0]);
  const base = { state: "CONFIRMED", briefId: brief.briefId, revision: brief.revision };

  /* ── IS THE STYLE STILL QUOTABLE? ─────────────────────────────────────
     It was when the brief was confirmed. A returned technical record or a
     new revision in draft can take that away afterwards, and a costing then
     has nothing to read. */
  const style = await SampleStyle().findById(brief.sampleStyleId)
    .select("techSheet.status techSheet.technical.status techSheet.technicalRevisions").lean()
    .catch(() => null);
  if (!style || !costingBrief.approvalStateOf(style).quotable) {
    return { ...base, state: "STYLE_INELIGIBLE" };
  }

  return base;
}

/* ══ THE PROJECTION ════════════════════════════════════════════════════════ */

/** Board policies that block a family this app owns, as named blockers. */
function boardBlockersFor(sourceApp, policy) {
  const families = new Set(
    requirementsFor(sourceApp)
      .map((r) => r.family)
      .filter(Boolean)
      .filter((f) => !EXCLUDED_FAMILIES.includes(f)),
  );
  return BOARD_POLICIES
    .filter((p) => p.families.some((f) => families.has(f)))
    .filter((p) => policy.configured[p.key] !== true)
    .map((p) => ({
      code: BLOCKER.BOARD_POLICY_REQUIRED,
      key: p.key,
      policyName: p.policyName,
      families: [...p.families],
      why: p.why,
      /* Scope and dating, said as they actually stand. Claiming an effective
         date the record does not hold would be worse than saying it is not
         recorded — see the Board lifecycle note in sourceApps.js. */
      companyScope: policy.companyScope || null,
      /* A policy with its own Board record says when it takes effect and who
         approved it; one that is still a field on the costing policy says it
         cannot. Both are the truth about that particular rule. */
      effectiveFrom: policy.dated?.[p.key]?.effectiveFrom ?? policy.effectiveFrom,
      boardApproved: policy.dated?.[p.key]?.boardApproved ?? policy.boardApproved,
      approvedByName: policy.dated?.[p.key]?.approvedByName || "",
      hasBoardRecord: Boolean(p.boardPolicyKey),
      /* Which of the four it is, so the message a department reads can be the
         true one rather than the most common one. */
      policyState: policy.dated?.[p.key]?.state || null,
      awaitingApproval: policy.dated?.[p.key]?.awaitingApproval ?? null,
      nextEffectiveFrom: policy.dated?.[p.key]?.nextEffectiveFrom ?? null,
      policyRevision: policy.revision,
      message: `${p.policyName} is not in force for this company, so costing cannot complete `
        + `${p.families.join(" and ")}. It is a Board decision, not something entered here.`,
    }));
}

/**
 * One department's Costing requirements for one style or enquiry.
 *
 * @param {object} ctx  `{ companyId }` — proved by the caller's own membership,
 *   never taken from the request body.
 * @param {object} opts
 * @param {string} opts.sourceApp  the app being rendered. The caller must hold
 *   its department grant; the route enforces that before reaching here.
 * @param {string} [opts.styleId]
 * @param {string} [opts.enquiryId]
 */
async function projectFor(ctx, { sourceApp, styleId = null, enquiryId = null } = {}) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  if (!APP_GRANT[sourceApp]) throw fail("VALIDATION", "Unknown source app.");
  if (!isId(styleId) && !isId(enquiryId)) {
    throw fail("VALIDATION", "A style or an enquiry is needed to answer this.");
  }

  const companyId = ctx.companyId;

  /* ── THE STYLE, AND ITS COMPANY PROVED ────────────────────────────────
     A foreign style is NOT FOUND, not forbidden: telling somebody a style
     exists in another company is itself a disclosure. */
  let style = null;
  if (isId(styleId)) {
    const doc = await SampleStyle().findById(styleId).lean().catch(() => null);
    if (!doc) throw fail("NOT_FOUND", "That style was not found.");
    const owned = await ownershipProofFor(doc, companyId);
    if (!owned) throw fail("NOT_FOUND", "That style was not found.");
    style = doc;
  }

  const sf = styleFacts(style);

  /* The enquiry: asked for directly, or reached through the style. Either way
     the query carries `companyId`, so a foreign one never loads. */
  const wantEnquiryId = isId(enquiryId) ? str(enquiryId) : sf.enquiryId;
  let enquiry = null;
  if (isId(wantEnquiryId)) {
    enquiry = await Enquiry().findOne({ _id: wantEnquiryId, companyId })
      .select("_id enquiryId journeyId freight companyId paymentTerms costingBriefs")
      .lean().catch(() => null);
    if (!enquiry && isId(enquiryId)) throw fail("NOT_FOUND", "That enquiry was not found.");
  }
  /* ── WHAT SALES ASKED TO BE COSTED, REDUCED TO A STATE ────────────────
     Resolved once, here, so the requirement resolver stays pure and the
     brief's own contents — the quantities, the unit, the proposed price —
     never enter this projection at all. Only the state and the identity do,
     which is all any department needs to know about somebody else's ask. */
  if (enquiry) {
    enquiry = {
      ...enquiry,
      __costingBrief: await briefStateFor({ companyId }, enquiry, sf).catch(() => ({ state: "NONE" })),
    };
  }
  const ef = enquiryFacts(enquiry);

  const mine = requirementsFor(sourceApp);

  /* Only what THIS app's requirements actually need. A merchandiser's panel
     does not query the freight register. */
  const needsStore = mine.some((r) => ["MATERIAL_QUOTATION", "SERVICE_QUOTATION", "FREIGHT_QUOTATION"].includes(r.key));
  const needsSourcing = mine.some((r) => r.key === "SOURCING_ORIGIN_EVIDENCE");
  const needsOps = mine.some((r) => r.key === "OPERATION_SALARY_BASIS");

  const [store, operationMaster, policy] = await Promise.all([
    needsStore
      ? storeFacts(companyId, {
        itemIds: sf.bomItemIds || [],
        serviceIds: (sf.services || []).map((s) => s.serviceId).filter(Boolean),
        originWarehouseId: ef.originWarehouseId,
      })
      : Promise.resolve({ quotedItemIds: new Set(), quotedServiceIds: new Set(), freightLaneOffers: 0 }),
    needsOps ? operationMasterFacts(companyId, sf.operations || []) : Promise.resolve({ unset: [], checked: false }),
    policyFacts(companyId),
  ]);
  policy.companyScope = str(companyId);

  /* ── WHERE THE BOM'S MATERIALS COME FROM ──────────────────────────────
     Read only when Store's own list is being rendered. Presence and
     completeness only — the projection carries no rate and no supplier. */
  const sourcing = needsSourcing && (sf.bomItemIds || []).length
    ? await sourcingEvidence.evidenceForItems({ companyId }, { itemIds: sf.bomItemIds })
      .catch(() => null)
    : null;

  const facts = { style: sf, enquiry: ef, store, operationMaster, sourcing };

  const requirements = mine
    /* ── A CALCULATION PREREQUISITE HAS NO FAMILY TO EXCLUDE ──────────
       `EXCLUDED_FAMILIES` names the families another lane owns. A
       requirement with no family cannot be one of them, and filtering on
       `undefined` would silently drop it. */
    .filter((r) => r.scope === SCOPE.CALCULATION || !EXCLUDED_FAMILIES.includes(r.family))
    .map((r) => {
      const resolved = resolveRequirement(r, facts);
      return {
        key: r.key,
        /* Null for a calculation prerequisite. A consumer grouping by family
           skips it rather than bucketing it under a cost that does not
           exist. */
        family: r.family || null,
        scope: r.scope,
        label: r.label,
        why: r.why,
        subject: r.subject,
        status: resolved.status,
        statusLabel: STATUS_LABEL[resolved.status],
        reason: resolved.reason,
        blocking: BLOCKING_STATUSES.includes(resolved.status),
        /* Another department, by NAME. Never their record, never their rate. */
        waitingOn: resolved.waitingOn || null,
        /* A LOCAL section of the screen this panel is on — never a URL, and
           never the costing workspace. Offered only where a form exists and
           only where something is actually outstanding. */
        action: (r.sourceForm === SOURCE_FORM.PRESENT
          && resolved.status !== STATUS.READY
          && resolved.status !== STATUS.NOT_APPLICABLE
          && resolved.status !== STATUS.AWAITING_OTHER_DEPARTMENT)
          ? { ...r.action }
          : null,
        blocker: resolved.status === STATUS.BLOCKED && r.blocker ? { ...r.blocker } : null,
      };
    });

  const outstanding = requirements.filter((r) => r.blocking);

  return {
    subject: {
      kind: isId(styleId) ? SUBJECT.STYLE : SUBJECT.ENQUIRY,
      styleId: sf.present ? sf.id : null,
      enquiryId: ef.present ? ef.id : null,
      /* What a person calls it. Enough to be sure they are looking at the
         right thing, and nothing commercial. */
      reference: sf.present ? sf.reference : ef.reference,
      label: sf.present ? sf.label : ef.reference,
      enquiryReference: ef.present ? ef.reference : null,
    },
    sourceApp,
    requirements,
    /* Board policy blocks the same families and is entered nowhere near here.
       Named and unactionable, with its values withheld from everybody. */
    boardPolicy: boardBlockersFor(sourceApp, policy),
    completion: {
      total: requirements.length,
      ready: requirements.filter((r) => r.status === STATUS.READY).length,
      notApplicable: requirements.filter((r) => r.status === STATUS.NOT_APPLICABLE).length,
      outstanding: outstanding.length,
      blocked: requirements.filter((r) => r.status === STATUS.BLOCKED).length,
      waiting: requirements.filter((r) => r.status === STATUS.AWAITING_OTHER_DEPARTMENT).length,
      complete: outstanding.length === 0,
    },
  };
}

module.exports = {
  projectFor, resolveRequirement,
  styleFacts, enquiryFacts, boardBlockersFor,
  appsForGrants,
};
