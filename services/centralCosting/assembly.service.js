"use strict";
/**
 * services/centralCosting/assembly.service.js
 *
 * WHERE A COSTING'S INPUTS COME FROM — ONE ANSWER, FOR BOTH READERS.
 *
 * ── THE PROBLEM THIS EXISTS TO REMOVE ───────────────────────────────────────
 * A costing was assembled twice. The preview route stitched the technical
 * record, the quotations and the policy together one way; version creation
 * stitched them together another. Both were careful and neither was the other,
 * so "what the screen showed" and "what was saved" were two calculations of the
 * same thing — and the only way to find out they disagreed was to notice a
 * number change on save.
 *
 * This is that stitching, once. The preview calls it and renders; creation
 * calls it and freezes. A test asserts they call the same function.
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
 * It is not a new engine and it does not price anything itself. Every figure
 * still comes from the service that owns it: `technicalSource` for what R&D
 * measured, `offerPricing` for what Store quoted, `policy.service` for what
 * Finance set. This decides WHICH of them to ask and reports what is missing
 * with the name of whoever owns it.
 *
 * ── AND THE PRODUCT BOM IS NOT A SOURCE ─────────────────────────────────────
 * Deliberately absent, and stated so it stays absent. The product BOM is
 * downstream of an approved sample: it is what manufacturing will build, and
 * it inherits from the SampleStyle rather than the other way round. Costing
 * from it would cost the record the technical record produced, one step
 * removed and with the allowance already flattened out of it. R&D's
 * `SampleStyle` is the authority.
 */

const technicalSource = require("./technicalSource.service");
const technicalPreview = require("./technicalPreview.service");
const policyService = require("./policy.service");
const costCoverage = require("./costCoverage");
const labourCost = require("./labourCost");
const { fail } = require("../storePurchase/errors");
/* Material quantities are never computed in floating point — a tier
   boundary reached by luck is a rate nobody quoted. */
const mongoose = require("mongoose");
const { dec, Decimal, roundMinor } = require("./decimal");
const familyApplicability = require("./familyApplicability.service");
/* The company's own charge table: one adapter and one resolver, shared with
   the policy service so the table Finance writes and the table the engine
   reads can never become two readings of it. */
const { REASON, adaptTable, selectPeriod, chargeTotalMinor } = require("./developmentCharges");
/* Outbound freight: the delivery terms, the lane, and the transporter's own
   dated quotation. Nothing inbound is read through any of them. */
const freight = require("./freight.service");
const freightSource = require("./freightSource.service");
const freightOfferRead = require("../storePurchase/freightOfferRead.service");
const financing = require("./financing.service");
const sampleStyleModel = () => require("../../models/CMS_Models/Sales/SampleStyle");

/* ── THE WORKFLOW STATES A PERSON CAN ACT ON ────────────────────────────────
 * Each names what is wrong AND who owns it. "Add a manual line" is not an
 * answer to any of them — it is what somebody does when the screen has failed
 * to say that R&D has not submitted the technical record yet. */
const STATE = Object.freeze({
  /* Assembled: a single technical record resolved and its inputs read. */
  ASSEMBLED: "ASSEMBLED",
  /* No SampleStyle exists for this enquiry product. R&D owns this. */
  AWAITING_RND_TECHNICAL_DATA: "AWAITING_RND_TECHNICAL_DATA",
  /* Several exist. Refused rather than settled by ordering — picking the
     first would cost a poplin order against a twill sample. */
  SEVERAL_TECHNICAL_RECORDS: "SEVERAL_TECHNICAL_RECORDS",
  /* An ad-hoc costing references no enquiry product, so there is nothing to
     assemble FROM. Not an error: it is the honest shape of hand-built work. */
  NOT_SOURCE_BACKED: "NOT_SOURCE_BACKED",
});

const OWNER = Object.freeze({
  RND: { department: "R&D", system: "SampleStyle technical record" },
  STORE: { department: "Store", system: "Supplier quotation register" },
  PRODUCTION: { department: "Production", system: "Operation master salary basis" },
  /* Packaging and outside services each have TWO owners, and a gap belongs to
     exactly one of them. A missing consumption is R&D's row to finish; a
     missing quotation is Store's to negotiate. Naming the wrong desk is how a
     costing sits still for a fortnight. */
  RND_PACKAGING: { department: "R&D", system: "SampleStyle packaging requirement" },
  RND_SERVICE: { department: "R&D / Production", system: "SampleStyle service requirement" },
  STORE_SERVICE: { department: "Store / Purchase", system: "Service quotation register" },
  FINANCE: { department: "Finance", system: "Company costing policy" },
  /* ── AND THE TWO HALVES OF FINANCING ──────────────────────────────────
     The Board decides what money costs and how a duration becomes a figure;
     Sales records how long this order's money is out. Two owners, two
     desks — naming "Finance" for both would send somebody to a screen that
     cannot answer either.

     The Board's system is named generically because it now owns several: the
     financing methodology, overhead, labour, input GST and the development
     charge catalogue are separate approved policies on one application, and a
     gap that named only the first would send a reader to the wrong one. */
  BOARD: { department: "Board", system: "Board policies" },
  SALES_FINANCING: { department: "Sales", system: "Enquiry payment terms" },
});

/**
 * Everything this costing can be assembled from, and everything it cannot.
 *
 * `styleId` names which technical record to use where several exist. It is
 * validated against the candidate list rather than trusted: a style id from
 * outside it is refused exactly as a foreign one is.
 */
async function assemble(ctx, costing, { styleId = null, lines = [] } = {}) {
  /* `contingency` is the Board's resolved DECISION, carried so the readiness
     note below can tell "the Board decided none" from "nobody has decided".
     Resolved once by `getPolicy`, never a second time here. */
  const { policy, configured, doc, contingency } = await policyService.getPolicy(ctx);

  /* ── AD-HOC WORK HAS NO SOURCE, AND THAT IS NOT A FAULT ────────────────
     A costing raised against no enquiry product has nothing to assemble
     from. It still gets its policy and its coverage assessment — the company
     rules apply to hand-built work too. */
  if (costing?.context?.type !== "ENQUIRY_STYLE") {
    return {
      state: STATE.NOT_SOURCE_BACKED,
      technical: null,
      candidates: [],
      styleId: null,
      policy: policySection(policy, configured, contingency),
      coverage: coverageOf(ctx, { lines, policy, technical: null, sourceDecisions: {} }),
      missing: policyMissing(policy, configured, contingency),
    };
  }

  /* ── THE COMPANY AND THE PRODUCT ARE THE SERVER'S ──────────────────────
     Read from the stored costing, never from a request: a client that could
     name the enquiry could name somebody else's. `findCandidates` scopes to
     `ctx.companyId` and proves the enquiry through the Sales Journey. */
  const { candidates } = await technicalSource.findCandidates(ctx, {
    enquiryId: costing.context.primaryId,
    productName: costing.context.externalKey,
  });

  /* ── A NAMED STYLE IS PROVED BEFORE ANYTHING ELSE IS SAID ──────────────
     The candidate list IS the company scope: it is built from enquiries this
     company owns, through the Sales Journey. A style named from outside it —
     another company's, or one that does not exist — gets the one
     indistinguishable refusal, and gets it BEFORE any workflow state is
     reported. Answering "awaiting R&D technical record" for a foreign id
     would confirm that this costing has no record of its own, which is a
     fact about our data offered to somebody asking about theirs. */
  if (styleId && !candidates.some((c) => String(c.styleId) === String(styleId))) {
    throw fail(technicalSource.CODES.NOT_FOUND,
      "No technical record was found for this costing.",
      { reason: "TECHNICAL_SOURCE_NOT_FOUND" });
  }

  if (!candidates.length) {
    return {
      state: STATE.AWAITING_RND_TECHNICAL_DATA,
      technical: null,
      candidates: [],
      styleId: null,
      policy: policySection(policy, configured, contingency),
      coverage: coverageOf(ctx, { lines, policy, technical: null, sourceDecisions: {} }),
      missing: [
        {
          key: "technical",
          /* Named, with its owner. "No technical data" would send somebody to
             type consumption figures they would be guessing at. */
          message: "Awaiting R&D technical record for this product.",
          owner: OWNER.RND,
          blocking: true,
        },
        ...policyMissing(policy, configured, contingency),
      ],
    };
  }

  /* One candidate is unambiguous and is used. Several is a question only a
     person can answer, and it is asked rather than settled by ordering. */
  let chosen = styleId || (candidates.length === 1 ? candidates[0].styleId : null);
  if (!chosen) {
    return {
      state: STATE.SEVERAL_TECHNICAL_RECORDS,
      technical: null,
      candidates,
      styleId: null,
      policy: policySection(policy, configured, contingency),
      coverage: coverageOf(ctx, { lines, policy, technical: null, sourceDecisions: {} }),
      missing: [
        {
          key: "technical-choice",
          message: "This product has more than one technical record. Choose which one this costing is for.",
          owner: OWNER.RND,
          blocking: true,
        },
        ...policyMissing(policy, configured, contingency),
      ],
    };
  }

  const preview = await technicalPreview.buildPreview(ctx, chosen);

  /* ── WHICH FAMILIES THEIR OWNERS SAY DO NOT APPLY ─────────────────────────
     Read, never received. Three of them come from the style's own record —
     published by the same read that built the preview, so the assembly and
     the decision cannot come from two different moments — and the fourth from
     Store's sourcing evidence on the materials this style actually names.

     A read that fails resolves to no decision, which leaves the family
     outstanding. That is the honest answer to "we could not check", and it is
     the opposite of the one this used to give. */
  const sourceDecisions = await familyApplicability.resolve(ctx, {
    style: preview,
    itemIds: (preview?.materials || []).map((m) => m.rawItemId).filter(Boolean),
    policySnapshot: policy || {},
  });

  return {
    state: STATE.ASSEMBLED,
    technical: preview,
    candidates,
    styleId: String(chosen),
    policy: policySection(policy, configured, contingency),
    sourceDecisions,
    coverage: coverageOf(ctx, { lines, policy, technical: preview, sourceDecisions }),
    missing: [
      ...technicalMissing(preview),
      ...policyMissing(policy, configured, contingency),
    ],
    /* The policy document, for the caller that has to freeze it. Returned
       rather than re-read, so the assembly a version is built from and the
       snapshot it records cannot come from two different reads. */
    policyBundle: { policy, configured, doc },
  };
}

/** The company rules, as inputs with a source rather than as settings. */
/**
 * The contingency row, which has three answers where every other rule has two.
 *
 * `VERIFIED` when a rate is in force, `NOT_APPLICABLE` when the Board decided
 * the company adds none — an ANSWER, not an omission — and `MISSING` only when
 * nobody has decided. A screen that showed the middle case as MISSING would be
 * asking a company to configure something it has deliberately settled.
 */
function contingencyRule(policy, contingency) {
  const state = contingency?.state || "POLICY_MISSING";
  if (state === "DECIDED_NONE") {
    return {
      key: "contingency",
      label: "Contingency",
      value: "None",
      basis: null,
      state: "NOT_APPLICABLE",
      owner: OWNER.BOARD,
      note: "The Board has decided this company does not add a standard contingency.",
    };
  }
  return {
    key: "contingency",
    label: "Contingency",
    value: present(policy.contingencyRatePercent) ? `${policy.contingencyRatePercent}%` : null,
    basis: policy.contingencyBasis || null,
    state: present(policy.contingencyRatePercent) && policy.contingencyBasis ? "VERIFIED" : "MISSING",
    owner: OWNER.BOARD,
  };
}

function policySection(policy, configured, contingency = null) {
  const rule = (key, label, rate, basis) => ({
    key, label,
    value: present(rate) ? `${rate}%` : null,
    basis: basis || null,
    state: present(rate) && basis ? "VERIFIED" : "MISSING",
    owner: OWNER.FINANCE,
  });
  return {
    configured,
    currency: policy.baseCurrency,
    roundingMode: policy.roundingMode,
    rules: [
      rule("overhead", "Factory and administrative overhead", policy.overheadRatePercent, policy.overheadBasis),
      /* Financing is deliberately absent: it is no longer one rate the
         company applies to everything. What it costs to wait to be paid
         depends on THIS order's terms, so it is a cost line with its own
         provenance rather than a standing rule to display here. */
      /* ── CONTINGENCY IS THE BOARD'S RULE NOW, AND HAS THREE STATES ───
         `policy.contingencyRatePercent` is filled from the Board's approved
         decision, so a rate shown here is one somebody approved. What the
         two-state `rule()` helper cannot say is the difference between "the
         Board decided none" and "nobody has decided", so this row says it
         itself — the same distinction the readiness note below makes, and the
         reason the legacy rate is no longer consulted at all. */
      contingencyRule(policy, contingency),
    ],
    margin: {
      /* Absent is absent. A margin band of 0/0/0 is what an unconfigured
         policy reads as, and `configured` is what tells the two apart. */
      minimum: policy.minimumMarginPercent,
      target: policy.targetMarginPercent,
      preferred: policy.preferredMarginPercent,
      state: configured ? "VERIFIED" : "MISSING",
      owner: OWNER.FINANCE,
    },
  };
}

const present = (v) => v !== null && v !== undefined && v !== "";

/** Company rules that are not set, named with the department that sets them. */
function policyMissing(policy, configured, contingency = null) {
  const out = [];
  if (!configured) {
    out.push({
      key: "policy",
      message: "Company costing policy is not configured.",
      owner: OWNER.FINANCE,
      blocking: true,
    });
    return out;
  }
  if (!present(policy.overheadRatePercent) || !policy.overheadBasis) {
    out.push({
      key: "policy-overhead",
      message: "Company overhead policy is not configured.",
      owner: OWNER.FINANCE,
      /* Not blocking: a costing without overhead is incomplete, not
         uncalculable, and saying so is more useful than refusing. */
      blocking: false,
    });
  }
  /* ── FINANCING IS NOT REPORTED HERE ANY MORE ──────────────────────────
     It stopped being a company setting that is either configured or not. It
     is a Board decision with an effective date combined with the payment
     terms Sales confirmed on this order, and either half can be the one that
     is missing. `applyFinancing` reports whichever it is, with the department
     that owns it; repeating a "policy is not configured" note here would name
     Finance for a gap that is often Sales'. */
  /* ── CONTINGENCY: AN OPEN QUESTION, NOT A MISSING SETTING ────────────
     Reported only when the BOARD has not decided. A company whose Board
     decided it does not add a standard contingency has answered this, and
     going on telling it the policy "is not configured" would be telling it to
     fix something it has already settled — which is precisely what the old
     rate-presence check did, because an absent rate was the only way to
     express both.

     Still non-blocking, and deliberately: a contingency is a cushion ON a
     cost, not an input TO one. Every figure in the costing is correct without
     it; what is unstated is the company's risk posture. Making it blocking
     would refuse costings a company can legitimately raise.

     `null` here means the resolution was not passed — an older caller — and
     nothing is claimed rather than guessed from the legacy field, which is no
     longer read into the calculation at all. */
  if (contingency && contingency.state === "POLICY_MISSING") {
    out.push({
      key: "policy-contingency",
      message: "The Board has not said whether this company adds a standard contingency. This costing "
        + "carries none, which is not the same as the company having decided not to.",
      owner: OWNER.BOARD,
      blocking: false,
    });
  }
  return out;
}

/**
 * What the technical record could not answer, with whose record it is.
 *
 * ── BLOCKING, BECAUSE THE ROW IS SIMPLY ABSENT OTHERWISE ────────────────────
 * A row that cannot be imported is not carried into `generated` — correctly,
 * since there is nothing to carry. Reported as a NON-blocking note, that made
 * the whole thing a silent omission: a consumption row R&D had left at zero,
 * or one naming no item, dropped out of the costing and the garment was
 * costed without its fabric. Nothing on the version said a material was
 * missing; the cost was simply lower than the garment.
 *
 * A costing whose claim is that its materials come from the technical record
 * cannot leave one out and still be that costing. So an unimportable row
 * blocks the save, and names the row, the reason and whose record it is.
 */
function technicalMissing(preview) {
  const out = [];
  for (const m of preview?.materials || []) {
    if (m.importable) continue;
    out.push({
      key: `material:${m.sourceKey}`,
      message: `${m.rawItemName || "A material on the technical record"}: ${(m.blockers || [])[0]?.message || "this material cannot be imported from the technical record."}`,
      owner: OWNER.RND,
      blocking: true,
    });
  }
  /* ── AND THE TWO NEW FAMILIES, ON THE SAME TERMS ────────────────────────
     A packaging or service row that cannot be imported is not carried into
     the assembled lines — correctly, since there is nothing to carry. Left
     out of THIS list it would be a silent omission: the garment costed as
     though it shipped unpacked, or with a wash nobody paid for, and nothing
     on the version saying a row had been dropped. */
  for (const p of preview?.packaging || []) {
    if (p.importable) continue;
    out.push({
      key: `packaging:${p.requirementKey}`,
      message: `${p.rawItemName || p.specification || "A packaging requirement"}: ${(p.blockers || [])[0]?.message || "this packaging requirement cannot be costed."}`,
      owner: OWNER.RND_PACKAGING,
      blocking: true,
    });
  }
  for (const sv of preview?.services || []) {
    if (sv.importable) continue;
    out.push({
      key: `service:${sv.requirementKey}`,
      /* The REQUIREMENT is R&D's or Production's; a quotation gap is Store's.
         Naming the wrong desk is how a costing sits still for a fortnight. */
      message: `${sv.serviceName || sv.specification || "A required process"}: ${(sv.blockers || [])[0]?.message || "this service requirement cannot be costed."}`,
      owner: sv.owner === "PRODUCTION" ? OWNER.PRODUCTION : OWNER.RND_SERVICE,
      blocking: true,
    });
  }
  for (const o of preview?.operations || []) {
    if (o.importable) continue;
    out.push({
      key: `operation:${o.sourceKey}`,
      /* The SAM is R&D's; the RATE is Production's. An operation that priced
         at nothing because no salary basis is set is Production's to fix, and
         saying "no technical data" would send somebody to the wrong desk. */
      message: (o.blockers || [])[0]?.message || "This operation has no resolved production rate.",
      owner: OWNER.PRODUCTION,
      blocking: true,
    });
  }
  return out;
}

/** The coverage assessment, with each family's owning source attached. */
function coverageOf(ctx, { lines, policy, technical, sourceDecisions = {} }) {
  /* `assess` reads a CALCULATED scenario. There is none before the engine
     runs, so a draft assembly gets the family list with nothing costed —
     which is exactly the right answer for "what has nobody addressed yet". */
  const assessed = costCoverage.assess({
    scenario: {},
    sourceDecisions: sourceDecisions || {},
    policySnapshot: policy || {},
  });
  return {
    ...assessed,
    /* Every family already carries its authority and owner from the audit
       table; this only records whether a technical record was available to
       answer the two families that depend on one. */
    technicalAvailable: Boolean(technical),
  };
}

/* ══ TURNING SOURCES INTO COSTING LINES ══════════════════════════════════════
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 * The previous pass produced a preview CONTRACT and stopped there:
 * `bindTechnicalLines` returned immediately unless the browser had already
 * submitted rows carrying `technicalKey`, and version creation calculated
 * whatever the browser sent. So the server could describe a technical record
 * beautifully and still required the client to reconstruct it as cost lines
 * before anything was costed. That is not assembly; it is a preview beside a
 * spreadsheet.
 *
 * These build the lines. The browser submits DECISIONS — which style, which
 * quantities, what does not apply, what is being overridden and why — and the
 * server produces every authoritative row itself.
 */

/**
 * Attach the one quotation that unambiguously applies to each material line.
 *
 * ── WHY "EXACTLY ONE" AND NOT "THE CHEAPEST" ────────────────────────────────
 * Choosing between two live quotations is a sourcing decision: lead time,
 * payment terms, quality history and who the company actually wants to buy
 * from all bear on it, and none of them is in a rate. An assembly that picked
 * the lower number would be making that decision silently, in a screen nobody
 * was looking at, and freezing it as evidence.
 *
 * So one applicable quotation is used and several is reported as a choice.
 * Nothing is interpolated and no offer is preferred.
 */
/**
 * The tax position an assembled material line carries.
 *
 * ── A NON-TAXABLE QUOTATION HAS NOTHING TO RECOVER ──────────────────────────
 * Recoverability is a company answer and comes from policy — but it is an
 * answer about GST, and a non-taxable supply has none. Applying the policy
 * value regardless made `offerPricing.taxPositionFor()` refuse the line with
 * TAX_TREATMENT_NOT_ALLOWED, so a company whose input GST is recoverable
 * could not cost a non-taxable material at all. NONE here is a stated nil,
 * which is what that quotation actually says.
 *
 * Silence still means silence: with no policy the line carries no treatment
 * and the pricing refuses it by name, rather than guessing in either
 * direction.
 */
const taxTreatmentFor = (offer, gstTreatment) => {
  if (offer && offer.priceBasis === "NON_TAXABLE") return { tax: { treatment: "NONE" } };
  return gstTreatment ? { tax: { treatment: gstTreatment } } : {};
};

async function attachQuotations(ctx, lines, {
  scenarios = [], asOf = new Date(), gstTreatment = null, choices = {},
} = {}) {
  const offerRead = require("../storePurchase/supplierOfferRead.service");
  const quantities = (scenarios || [])
    .map((s) => Number(s.quantity))
    .filter((n) => Number.isFinite(n) && n > 0);
  /* The largest run is the one whose supplier quantity has to be satisfiable;
     a quotation that cannot supply it cannot price the costing. */
  const largest = quantities.length ? Math.max(...quantities) : null;
  /* The run the verdict is ABOUT. A quotation excluded for a minimum, a
     multiple or an uncovered band was excluded at a particular run size, and
     a refusal that does not say which one leaves the reader guessing which of
     their scenarios to re-quote. */
  const judgedAt = largest === null ? null : {
    scenarioKey: (scenarios || []).find((sc) => Number(sc.quantity) === largest)?.key || null,
    outputQuantity: String(largest),
  };

  const missing = [];
  const out = [];
  for (const line of lines) {
    /* ── PACKAGING IS BOUGHT THE SAME WAY A MATERIAL IS ────────────────
       Same item master, same quotation register, same per-scenario
       revalidation. It joins here rather than gaining a second attach
       function that would drift from this one. */
    if (!["MATERIAL", "PACKAGING"].includes(line.category)
      || !line.itemId || line.supplierOfferId || line.unitRate || line.amount) {
      out.push(line);
      continue;
    }
    /* ── AND A FIXED ROW DOES NOT SCALE ────────────────────────────────
       Thirteen cartons for the order are thirteen cartons at every run size.
       Multiplying by the run would ask the supplier for 6,500 of them and
       judge the tiers on that. */
    const fixed = line.behaviour === "FIXED_PER_RUN";
    const stated = fixed ? line.quantityPerRun : line.quantityPerUnit;
    /* ── IN EXACT DECIMAL, NOT FLOATING POINT ───────────────────────────
       This was `Number(stated) * largest`. The quantity it produces is what
       the supplier is asked for, and therefore what the minimum-order check
       and the tier boundary are judged against — so a run landing on a tier
       edge could fall the wrong side of it because 1.47 x 500 is
       734.9999999999999 in binary floating point.

       `quantityPerUnit` carries the EFFECTIVE consumption now, allowance
       included, which is the quantity that will actually be bought. */
    const required = stated && (fixed || largest)
      ? (fixed
        ? dec(stated, { field: "quantityPerRun" }).toFixed()
        : dec(stated, { field: "quantityPerUnit" })
          .multipliedBy(dec(largest, { field: "runQuantity" })).toFixed())
      : null;

    let applicable = [];
    let excluded = [];

    /* ── A PREVIEW DOES NOT YET KNOW THE RUN SIZE ─────────────────────────
       Applicability depends on quantity — MOQ, order multiple and which tier
       is reached. Before any scenario exists there is nothing to judge those
       against, so the candidates are the quotations that are CURRENT for this
       item and the quantity check happens at save, per scenario.

       Reporting "no applicable quotation" here would be false: nothing has
       been ruled out, nothing has been asked. */
    if (!required) {
      try {
        const current = await offerRead.currentOffersForItem(
          { companyId: ctx.companyId, actorId: ctx.actorId, reason: "costing_assembly" },
          line.itemId, { variantId: line.variantId || null, asOf },
        );
        out.push(line);
        /* ── A DECISION ALREADY TAKEN IS NOT AN OPEN ONE ──────────────────
           Store may choose before anybody has costed a run size, and this
           branch is exactly that moment: there is no quantity yet, so nothing
           can be judged against a minimum or a tier. Reporting the gap anyway
           would leave the requirement in Store's queue for ever — decided,
           and still asking.

           The choice is not APPLIED here either. Applicability is a question
           about a quantity, and there isn't one; it is judged at calculation,
           where the run sizes exist and where a decision that no longer holds
           comes back as unresolved. */
        if (choices[line.lineKey]
          && current.some((c) => String(c.offerId) === String(choices[line.lineKey]))) {
          continue;
        }
        missing.push({
          key: `quotation:${line.lineKey}`,
          message: current.length
            ? `${line.label}: choose which quotation this costing uses. Applicability is checked against each run size when the version is calculated.`
            : `${line.label} has no current Store quotation.`,
          owner: OWNER.STORE,
          blocking: true,
          lineKey: line.lineKey,
          sourcingSubject: {
            kind: line.category === "PACKAGING" ? "PACKAGING" : "MATERIAL",
            label: line.label || line.lineKey,
            itemId: line.itemId || null,
            variantId: line.variantId || null,
            quantity: null,
            uom: line.consumptionUom || line.quantityUom || "",
            asOf,
          },
          candidates: current.map((c) => ({
            offerId: c.offerId,
            supplierName: c.supplierName,
            quotationReference: c.quotationReference,
            revision: c.revision,
            purchaseUom: c.purchaseUom,
            currency: c.currency,
            appliedUnitPriceMinor: c.unitPriceMinor,
            priceSource: null,
            tierMinQuantity: null,
            tierMaxQuantity: null,
            moq: c.moq,
            orderMultiple: c.orderMultiple,
            leadTimeDays: c.leadTimeDays,
            validUntil: c.validUntil,
            purchaseQuantity: null,
          })),
          excluded: [],
        });
      } catch {
        out.push(line);
        missing.push({
          key: `quotation:${line.lineKey}`,
          message: `Supplier quotations for ${line.label} could not be read just now.`,
          owner: OWNER.STORE,
          blocking: false,
          lineKey: line.lineKey,
          candidates: [],
        });
      }
      continue;
    }

    try {
      const res = await offerRead.applicableOffersForItem(
        { companyId: ctx.companyId, actorId: ctx.actorId, reason: "costing_assembly" },
        {
          itemId: line.itemId,
          variantId: line.variantId || null,
          quantity: required,
          requestedUom: line.consumptionUom || line.quantityUom,
          asOf,
        },
      );
      applicable = res.applicable || [];
      excluded = res.excluded || [];
    } catch (err) {
      /* ── AN OUTAGE IS NOT "NO QUOTATION", AND NOT A SOFT NOTE EITHER ────
         Reported as unknown so nobody reads a database blip as a supplier
         having nothing on file. It used to be non-blocking, which let the
         save carry on to a rateless line and answer "1 cost input is missing
         a value" — the register's silence rendered as the costing's own
         incompleteness. A preview can show this softly; a save cannot freeze
         a version around a record it could not read. */
      out.push(line);
      missing.push({
        key: `quotation:${line.lineKey}`,
        message: `Supplier quotations for ${line.label} could not be read just now.`,
        owner: OWNER.STORE,
        blocking: true,
        outage: true,
        lineKey: line.lineKey,
      });
      continue;
    }

    /* ── A DECISION THE PERSON MAKES, KEYED TO THE ASSEMBLED LINE ────────
       `quotationChoices` is `{ [lineKey]: offerId }` — a selection, not a
       reconstructed cost line. The browser sends the identity it was shown
       and nothing else; the offer is re-read and revalidated per scenario at
       save time by the existing contract. A choice naming an offer that is
       not applicable is refused rather than honoured. */
    const chosen = choices[line.lineKey];
    if (chosen) {
      const hit = applicable.find((a) => String(a.offerId) === String(chosen));
      if (!hit) {
        out.push(line);
        missing.push({
          key: `quotation:${line.lineKey}`,
          message: `The quotation chosen for ${line.label} no longer applies at these quantities. Choose again.`,
          owner: OWNER.STORE,
          blocking: true,
          candidates: applicable,
          lineKey: line.lineKey,
        });
        continue;
      }
      out.push({
        ...line,
        supplierOfferId: hit.offerId,
        /* Carried so the inbound-freight question can be asked of the
           quotation this line actually got, rather than re-read. */
        offerFacts: {
          freightTerms: hit.freightTerms || null, incoterm: hit.incoterm || null,
          /* And where the goods came from, for the customs question below. */
          sourcing: hit.sourcing || null, offerRevision: hit.revision ?? null,
          offerReference: hit.quotationReference || hit.reference || null,
        },
        ...taxTreatmentFor(hit, gstTreatment),
      });
      continue;
    }

    if (applicable.length === 1) {
      out.push({
        ...line,
        supplierOfferId: applicable[0].offerId,
        offerFacts: {
          freightTerms: applicable[0].freightTerms || null,
          incoterm: applicable[0].incoterm || null,
          sourcing: applicable[0].sourcing || null,
          offerRevision: applicable[0].revision ?? null,
          offerReference: applicable[0].quotationReference || applicable[0].reference || null,
        },
        /* ── RECOVERABILITY IS THE COMPANY'S ANSWER, NOT THE ROW'S ──────
           The quotation states a GST rate; it cannot state whether this
           company gets that GST back. Same answer on every material line, so
           it comes from policy — and where policy is silent the line carries
           no treatment and the pricing refuses it by name, which is the
           honest outcome rather than a guess in either direction. */
        ...taxTreatmentFor(applicable[0], gstTreatment),
      });
      if (!gstTreatment && applicable[0].priceBasis !== "NON_TAXABLE") {
        missing.push({
          key: "policy-input-gst",
          message: "Company input-GST treatment is not configured, so quotation-backed materials cannot be costed.",
          owner: OWNER.FINANCE,
          blocking: true,
        });
      }
      continue;
    }
    out.push(line);
    missing.push({
      key: `quotation:${line.lineKey}`,
      message: applicable.length === 0
        ? `${line.label} has no applicable Store quotation.`
        : `${line.label} has ${applicable.length} applicable quotations. Choose which supplier this costing uses.`,
      owner: OWNER.STORE,
      /* Blocking: the engine refuses a rateless line, so saying it politely
         and then failing on it would be two messages for one problem. */
      blocking: true,
      /* ── AND THE CHOICE ITSELF ────────────────────────────────────────
         A blocking state with nothing to act on is a dead end. The candidates
         travel with it — supplier, rate, unit, validity, MOQ, multiple, lead
         time and reference — so the screen can offer a real decision instead
         of sending somebody to the ad-hoc editor. Never ordered by price:
         choosing the cheapest is a sourcing decision with a person's name on
         it, and lead time and quality history are not in a rate. */
      lineKey: line.lineKey,
      judgedAt,
      /* ── WHAT STORE NEEDS TO RECORD A DECISION ABOUT THIS ────────────
         The subject, from the line the gap is about. Store's decision is
         stored against a requirement, and a requirement identified by
         slicing an id out of a line key is an id nobody checked. Attached
         here, once, where the line is in hand. */
      sourcingSubject: {
        kind: line.category === "PACKAGING" ? "PACKAGING" : "MATERIAL",
        label: line.label || line.lineKey,
        itemId: line.itemId || null,
        variantId: line.variantId || null,
        quantity: required,
        uom: line.consumptionUom || line.quantityUom || "",
        asOf,
      },
      candidates: applicable.map((a) => ({
        offerId: a.offerId,
        supplierName: a.supplierName,
        quotationReference: a.quotationReference,
        revision: a.revision,
        purchaseUom: a.purchaseUom,
        currency: a.currency,
        appliedUnitPriceMinor: a.appliedUnitPriceMinor,
        priceSource: a.priceSource,
        tierMinQuantity: a.tierMinQuantity,
        tierMaxQuantity: a.tierMaxQuantity,
        moq: a.moq,
        orderMultiple: a.orderMultiple,
        leadTimeDays: a.leadTimeDays,
        validUntil: a.validUntil,
        purchaseQuantity: a.purchaseQuantity,
      })),
      /* Why the ones that did NOT apply are absent — a person choosing needs
         to know their expected supplier was considered and excluded. */
      excluded: (excluded || []).map((e) => ({
        offerId: e.offerId, supplierId: e.supplierId, supplierName: e.supplierName,
        quotationReference: e.quotationReference, reason: e.code, message: e.message,
        /* The numbers the reason is ABOUT — the minimum, the multiple, the
           quantity asked for, the tiers on file. `offerApplicability` spreads
           them onto the exclusion itself. Dropped in the first cut, so "below
           the supplier's minimum" arrived without saying what the minimum was
           or how far short the run fell. */
        purchaseQuantity: e.purchaseQuantity ?? null,
        purchaseUom: e.purchaseUom ?? null,
        moq: e.moq ?? null,
        orderMultiple: e.orderMultiple ?? null,
        tiers: e.tiers ?? null,
      })),
    });
  }
  return { lines: out, missing };
}

/** A stable line key, derived from the source identity rather than an index. */
const keyFor = (prefix, sourceKey) =>
  `${prefix}:${String(sourceKey).replace(/[^a-zA-Z0-9:_-]/g, "-")}`.slice(0, 120);

/**
 * One costing line from one technical MATERIAL row.
 *
 * ── THE RATE IS DELIBERATELY ABSENT ─────────────────────────────────────────
 * The technical record says how much is used, never what it costs. The line is
 * emitted complete except for its price and waits visibly for a quotation —
 * rather than arriving at a plausible zero, which is the one thing a costing
 * must never do with a missing input.
 */
function lineFromMaterial(m) {
  /* ── THE QUANTITY IS THE EFFECTIVE ONE, EVERYWHERE ──────────────────────
     `quantityPerUnit` used to be the BASE consumption, and the allowance R&D
     recorded beside it was carried as information and never applied. The
     company was buying 1.47 metres a garment and costing 1.40 — and the
     understatement did not stop at the total: this same field is what the
     applicability check multiplies by the run size, so the minimum-order test
     and the quantity tier were both judged on a quantity nobody was going to
     buy. A run that reached a cheaper tier at 1.47 was priced at the dearer
     one, or passed an MOQ it did not actually meet.
     
     One field, one number, computed once in `technicalSource` — see
     `effectiveConsumption` for why the legacy path is not multiplied again. */
  const effective = m.effectiveConsumptionExact ?? m.effectiveQuantityExact
    ?? (m.effectiveConsumptionPerPiece ?? m.effectiveQuantity);
  const quantity = effective === null || effective === undefined
    ? (m.quantity === null || m.quantity === undefined ? undefined : String(m.quantity))
    : String(effective);
  return {
    lineKey: keyFor("mat", m.sourceKey),
    category: "MATERIAL",
    behaviour: "PER_UNIT",
    label: [m.rawItemName, m.variantLabel].filter(Boolean).join(" — ").slice(0, 300),
    itemId: m.rawItemId || undefined,
    variantId: m.variantId || undefined,
    quantityPerUnit: quantity,
    quantityUom: m.unit || "",
    consumptionUom: m.unit || "",
    technicalKey: m.sourceKey,
    technicalEvidence: m.chosenFrom,
    /* ── AND THE WORKING TRAVELS WITH IT ────────────────────────────────
       Carried on the line so the freeze can record what the priced quantity
       was arrived at from, and the screen can show it. A reader who can see
       only 1.47 cannot tell whether the allowance is in it. */
    consumption: {
      basePerPiece: m.consumptionPerPiece ?? m.quantity ?? null,
      allowancePercent: m.allowancePercent ?? null,
      allowanceAlreadyInQuantity: m.allowanceAlreadyInQuantity === true,
      effectivePerPiece: effective ?? null,
      uom: m.unit || "",
    },
  };
}

/**
 * One costing line from one PACKAGING requirement.
 *
 * ── THE SAME SHAPE AS A MATERIAL, PLUS A BASIS ──────────────────────────────
 * A poly bag is a material the company buys from a supplier who quoted it, so
 * it is priced through exactly the same register and the same per-scenario
 * revalidation. What it adds is `basis`: a bag is one per garment and scales
 * with the run, and a master carton is bought for the order and dilutes across
 * it. Two different numbers, and neither is derivable from the item.
 *
 * The rate is absent here for the same reason a material's is: the technical
 * record says how much, never what it costs.
 */
function lineFromPackaging(p) {
  const fixed = p.basis === "FIXED_PER_RUN";
  /* ── A CARTON IS ITS OWN SHAPE ─────────────────────────────────────────
     Not PER_UNIT (it does not scale smoothly) and not FIXED_PER_RUN (it is
     not the same money at every run size). The pricing pass computes one
     total per scenario from the carton count, and the engine takes them as
     `amountByScenario` — the mechanism freight already uses for a run total
     that steps. */
  const carton = p.basis === "PER_CARTON";
  return {
    lineKey: keyFor("pkg", p.requirementKey),
    category: "PACKAGING",
    behaviour: carton ? "PER_CARTON" : fixed ? "FIXED_PER_RUN" : "PER_UNIT",
    /* Carried onto the line so the pricing pass can count cartons without
       re-reading the style. Read only on a carton line. */
    ...(carton ? { garmentsPerCarton: p.garmentsPerCarton } : {}),
    label: [p.rawItemName, p.variantLabel].filter(Boolean).join(" — ").slice(0, 300)
      || p.specification.slice(0, 300) || "Packaging",
    itemId: p.rawItemId || undefined,
    variantId: p.variantId || undefined,
    /* Whichever field the behaviour actually reads. A fixed line with a
       per-piece consumption would be multiplied by the run size and order
       thirteen cartons five hundred times. */
    /* A carton line's quantity is per CARTON, which is the "per one of the
       thing this is counted in" field — the behaviour decides how many of
       that thing a run holds. */
    ...(fixed
      ? { quantityPerRun: p.quantity === null || p.quantity === undefined ? undefined : String(p.quantity) }
      : { quantityPerUnit: p.quantity === null || p.quantity === undefined ? undefined : String(p.quantity) }),
    quantityUom: p.unit || "",
    consumptionUom: p.unit || "",
    technicalKey: p.requirementKey,
    technicalEvidence: p.evidence,
    /* ── A PLANNED QUANTITY IS NOT A MEASURED ONE ──────────────────────────
       The RATE may be perfectly verified — a dated, referenced quotation —
       while the QUANTITY it is multiplied by was specified for production and
       never demonstrated by a sample. The line is only as good as its weaker
       half, so the pricing pass reads this and keeps such a line PROVISIONAL
       rather than letting the quotation's confidence speak for both. */
    evidenceProvisional: p.evidence !== "SAMPLE_MEASURED",
    /* Carried so the presentation can show what R&D actually specified beside
       the item's own name — "printed poly bag, 300x400mm" is the requirement;
       "Poly Bag" is the master. */
    specification: p.specification || "",
  };
}

/**
 * One costing line from one required outside SERVICE.
 *
 * Priced from the service quotation register rather than the material one —
 * different register, same discipline: dated, referenced, per-scenario
 * revalidated, and never `Service.defaultRate`.
 */
/**
 * One costing line from one required piece of DEVELOPMENT or TOOLING.
 *
 * ── WHY IT IS NOT A SERVICE LINE ────────────────────────────────────────────
 * Making the screens to print with is bought ONCE and diluted across the run;
 * printing with them is bought per garment and scales with it. The same
 * Service master answers both, which is exactly why the requirement has to say
 * which it is — and why this emits `FIXED_SETUP` with the basis forced rather
 * than read.
 *
 * The rate is absent here, as everywhere: it comes from the supplier's own
 * quotation, or from the charge Finance has published for work the company
 * does itself.
 */
function lineFromDevelopment(sv) {
  const internal = sv.developmentSource === "COMPANY_POLICY";
  return {
    lineKey: keyFor("dev", sv.requirementKey),
    category: "FIXED_SETUP",
    /* One-time by definition. The engine adds it whole to the run and divides
       for the per-garment figure; nothing multiplies it. */
    behaviour: "FIXED_PER_RUN",
    label: (internal
      ? sv.developmentChargeLabel || sv.developmentChargeKey
      : [sv.serviceName, sv.serviceCode].filter(Boolean).join(" — "))
      .slice(0, 300) || sv.specification.slice(0, 300) || "Development and tooling",
    ...(internal
      ? { developmentChargeKey: sv.developmentChargeKey }
      : { serviceId: sv.serviceId || undefined }),
    developmentSource: internal ? "COMPANY_POLICY" : "SUPPLIER_QUOTATION",
    quantityPerRun: sv.quantity === null || sv.quantity === undefined ? undefined : String(sv.quantity),
    quantityUom: sv.billingUnit || "",
    serviceUnit: sv.billingUnit || "",
    technicalKey: sv.requirementKey,
    technicalEvidence: sv.evidence,
    evidenceProvisional: sv.evidence !== "SAMPLE_MEASURED",
    specification: sv.specification || "",
    requirementOwner: sv.owner,
  };
}

function lineFromService(sv) {
  const fixed = sv.basis === "FIXED_PER_RUN";
  return {
    lineKey: keyFor("svc", sv.requirementKey),
    category: "SERVICE",
    behaviour: fixed ? "FIXED_PER_RUN" : "PER_UNIT",
    label: [sv.serviceName, sv.serviceCode].filter(Boolean).join(" — ").slice(0, 300)
      || sv.specification.slice(0, 300) || "Outside service",
    /* Not `itemId`: a service is not an item, and the material pricing path
       must not be able to pick this line up by accident. */
    serviceId: sv.serviceId || undefined,
    ...(fixed
      ? { quantityPerRun: sv.quantity === null || sv.quantity === undefined ? undefined : String(sv.quantity) }
      : { quantityPerUnit: sv.quantity === null || sv.quantity === undefined ? undefined : String(sv.quantity) }),
    quantityUom: sv.billingUnit || "",
    serviceUnit: sv.billingUnit || "",
    technicalKey: sv.requirementKey,
    technicalEvidence: sv.evidence,
    /* ── A PLANNED QUANTITY IS NOT A MEASURED ONE ──────────────────────────
       The RATE may be perfectly verified — a dated, referenced quotation —
       while the QUANTITY it is multiplied by was specified for production and
       never demonstrated by a sample. The line is only as good as its weaker
       half, so the pricing pass reads this and keeps such a line PROVISIONAL
       rather than letting the quotation's confidence speak for both. */
    evidenceProvisional: sv.evidence !== "SAMPLE_MEASURED",
    specification: sv.specification || "",
    requirementOwner: sv.owner,
  };
}

/**
 * One costing line from one technical OPERATION row.
 *
 * `operatorCost` is rupees for this operation on ONE finished piece — a monthly
 * salary over the minutes in a month, times the SAM. Its meaning is already per
 * finished unit, so it is a PER_UNIT rate with a quantity of one and the SAM is
 * not multiplied in again.
 *
 * ── AND IT IS NOT A VERIFIED RATE ───────────────────────────────────────────
 * See `productionAssumptions` below. Until the company has said what fraction
 * of a paid minute is productive, what the employer burden is, and where
 * machine cost sits, this figure is an arithmetic result rather than a costed
 * one — so it is emitted PROVISIONAL and the assembly says why.
 */
function lineFromOperation(o, { policy = {}, roundingMode = "HALF_UP" } = {}) {
  /* ── THE COMPANY'S OWN ASSUMPTIONS, WHERE IT HAS STATED THEM ───────────
     `operatorCost` on the sample is `net salary / 12,480 x SAM` — the
     stock-item editor's formula, which assumes every paid minute is
     productive and that an operator costs their take-home pay. Once the
     company has stated its productive basis, its employer burden and where
     machine cost sits, the rate is recomputed from those and the sample's own
     salary and SAM. Until then the old figure stands and the line is reported
     PROVISIONAL rather than presented as costed. */
  const costed = labourCost.labourCostPerGarment({
    samMinutes: o.samMinutes,
    netSalaryPerMonth: o.operatorSalary,
    policy,
    roundingMode,
  });
  const minor = costed.ok ? costed.amountMinor : rupeesToMinor(o.operatorCost);
  return {
    lineKey: keyFor("op", o.sourceKey),
    category: "OPERATION",
    behaviour: "PER_UNIT",
    label: [o.name, o.operationCode].filter(Boolean).join(" — ").slice(0, 300),
    ...(minor === null ? {} : { unitRate: { amountMinor: minor } }),
    quantityPerUnit: "1",
    quantityUom: "pc",
    technicalKey: o.sourceKey,
    technicalEvidence: "OPERATION",
    /* Carried so the version can freeze HOW the rate was reached, and so the
       screen can tell a policy-costed rate from the legacy one. */
    ...(costed.ok ? { labourWorkings: costed.workings } : {}),
  };
}

/**
 * Rupees to integer minor units, or null.
 *
 * Null, never 0: `costOperations` returns 0 when it could resolve no salary
 * basis, and a garment's stitching costed at nothing is worse than one nobody
 * costed. The two are told apart by the operation's own `rateResolved`, which
 * the preview already carries as a blocker.
 */
function rupeesToMinor(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const [major, minor = ""] = n.toFixed(2).split(".");
  return Number(major) * 100 + Number(minor.padEnd(2, "0"));
}

/**
 * Whether an operation rate means anything yet.
 *
 * Three assumptions have to be stated before a salary-derived figure is a
 * labour cost rather than a division: how much of a paid month is productive,
 * what the employer's burden adds, and whether machine cost is inside the rate.
 * A company at 55% efficiency and one at 85% have labour costs a third apart,
 * so none of them can be defaulted.
 */
function productionAssumptions(policy) {
  /* One definition, in `labourCost` — the same one the rate itself is built
     from, so the screen cannot report an assumption as present while the
     calculation refuses it. */
  const gaps = labourCost.assumptionGaps(policy || {});
  return {
    configured: gaps.length === 0,
    gaps,
    missing: gaps.map((g) => g.message),
  };
}

/* ── AN OVERRIDE MAY NOT STAND BESIDE A SOURCED LINE, OR ANYWHERE ELSE ──────
 *
 * `mergeOverrides` lived here. It placed a hand-entered figure into the
 * assembled set — as a SUPPLEMENT to a family no source answered, or as a
 * declared REPLACEMENT of an assembled line, which had to name what it
 * replaced. Anything ambiguous was refused, because an override that silently
 * sat beside an assembled material would double the garment's fabric cost and
 * one that silently displaced it would hide a Store quotation behind a typed
 * number.
 *
 * It also refused `freight` by name, once that family got a source of its own.
 *
 * That last refusal is now the rule for every family. No route accepts a
 * hand-entered cost line, so there is no override to merge, and a merger that
 * nothing can reach is a door left in a wall — the next person to need a
 * figure finds the function before they find the reason it stopped being
 * called.
 *
 * `assembleLines` refuses one outright below. The request contract refuses it
 * a layer earlier, in `calculationInput.parseLine`, so a caller learns at the
 * edge rather than after the sources have been read.
 */
function refuseOverrides(overrides) {
  if (!overrides.length) return;
  const first = overrides[0];
  const owner = costCoverage.ownerOf({
    family: first.override?.family || "",
    category: first.category || "",
  });
  throw fail(
    "COSTING_MANUAL_INPUT_RETIRED",
    owner?.department
      ? `${owner.label} cannot be entered in Costing. ${owner.department} records it in ${owner.recordedIn}, and the costing reads it from there.`
      : "A cost figure cannot be entered in Costing. Every cost is read from the record of the department that owns it.",
    {
      reason: "MANUAL_OVERRIDE_RETIRED",
      lineKeys: overrides.map((l) => l.lineKey),
      family: owner?.family || first.override?.family || null,
      owner: owner ? { department: owner.department, recordedIn: owner.recordedIn } : null,
      awaitingMessage: owner?.awaitingMessage || null,
    },
  );
}

/**
 * The lines this costing is made of, built by the SERVER.
 *
 * `clientLines` may contain ONLY overrides for a source-backed costing. An
 * ad-hoc costing keeps every line it is given — hand-built work is what that
 * context is for, and historical manual versions must go on calculating.
 */
/**
 * Attach the one service quotation that unambiguously applies to each required
 * process.
 *
 * ── THE SAME RULE AS MATERIALS, AND FOR THE SAME REASON ─────────────────────
 * One applicable quotation is attached. Several is reported as a CHOICE, never
 * settled by price or by database order: lead time, capacity, quality history
 * and who the company actually wants to send work to all bear on it, and none
 * of them is in a rate. None is a named gap owned by Store.
 *
 * In both of the last two cases the line stays rateless and the assembly says
 * which — the engine then refuses it, rather than a plausible zero reaching a
 * frozen version.
 */
async function attachServiceQuotations(ctx, lines, {
  scenarios = [], asOf = new Date(), gstTreatment = null, choices = {},
} = {}) {
  const serviceOfferRead = require("../storePurchase/serviceOfferRead.service");
  const quantities = (scenarios || [])
    .map((sc) => Number(sc.quantity))
    .filter((n) => Number.isFinite(n) && n > 0);
  /* The largest run is the one whose service quantity has to be satisfiable;
     a quotation that cannot take it cannot price the costing. */
  const largest = quantities.length ? Math.max(...quantities) : null;
  const judgedAt = largest === null ? null : {
    scenarioKey: (scenarios || []).find((sc) => Number(sc.quantity) === largest)?.key || null,
    outputQuantity: String(largest),
  };

  const missing = [];
  const out = [];
  for (const line of lines) {
    /* Externally quoted development work is bought exactly as an outside
       process is — same register, same per-scenario revalidation — so it
       joins here rather than gaining a second attach function that would
       drift from this one. An INTERNAL charge has no supplier and is priced
       from the policy instead. */
    const quotable = line.category === "SERVICE"
      || (line.category === "FIXED_SETUP" && line.developmentSource === "SUPPLIER_QUOTATION");
    if (!quotable || !line.serviceId || line.serviceOfferId || line.unitRate || line.amount) {
      out.push(line);
      continue;
    }

    const fixed = line.behaviour === "FIXED_PER_RUN";
    const stated = fixed ? line.quantityPerRun : line.quantityPerUnit;
    /* Exact decimal, for the reason the material path states above: this
       quantity decides a minimum lot and a tier, and a boundary reached by a
       float is a boundary reached by luck. A service carries no allowance —
       an allowance is a property of a material being cut, not of a process
       being performed — so nothing is added here. */
    const required = stated && (fixed || largest)
      ? (fixed
        ? dec(stated, { field: "quantityPerRun" }).toFixed()
        : dec(stated, { field: "quantityPerUnit" })
          .multipliedBy(dec(largest, { field: "runQuantity" })).toFixed())
      : null;

    /* A preview with no run size yet cannot judge a minimum lot or a tier, so
       the candidates are what is CURRENT and the quantity check happens at
       save. Reporting "no applicable quotation" here would be false: nothing
       has been ruled out because nothing has been asked. */
    if (!required) {
      let current = [];
      try {
        current = await serviceOfferRead.currentOffersForService(
          { companyId: ctx.companyId, actorId: ctx.actorId, reason: "costing_assembly" },
          line.serviceId, { asOf },
        );
      } catch {
        out.push(line);
        missing.push({
          key: `service-quotation:${line.lineKey}`,
          message: `Service quotations for ${line.label} could not be read just now.`,
          owner: OWNER.STORE_SERVICE,
          blocking: true,
          outage: true,
          lineKey: line.lineKey,
        });
        continue;
      }
      out.push(line);
      missing.push({
        key: `service-quotation:${line.lineKey}`,
        message: current.length
          ? `${line.label}: choose which service quotation this costing uses. Applicability is checked against each run size when the version is calculated.`
          : `${line.label} has no current service quotation.`,
        owner: OWNER.STORE_SERVICE,
        blocking: true,
        lineKey: line.lineKey,
        judgedAt,
        candidates: current.map((c) => serviceCandidate(c)),
        excluded: [],
      });
      continue;
    }

    let applicable = [];
    let excluded = [];
    try {
      const res = await serviceOfferRead.applicableOffersForService(
        { companyId: ctx.companyId, actorId: ctx.actorId, reason: "costing_assembly" },
        { serviceId: line.serviceId, quantity: required, requestedUnit: line.serviceUnit || line.quantityUom, asOf },
      );
      applicable = res.applicable || [];
      excluded = res.excluded || [];
    } catch (err) {
      /* An outage is not "no quotation", and it is not a soft note either — a
         save must not freeze a version around a register it could not read. */
      out.push(line);
      missing.push({
        key: `service-quotation:${line.lineKey}`,
        message: `Service quotations for ${line.label} could not be read just now.`,
        owner: OWNER.STORE_SERVICE,
        blocking: true,
        outage: true,
        lineKey: line.lineKey,
      });
      continue;
    }

    /* The person's own decision, keyed to the assembled line. A choice naming
       a quotation that is not applicable is refused rather than honoured. */
    const chosen = choices[line.lineKey];
    if (chosen) {
      const hit = applicable.find((a) => String(a.offerId) === String(chosen));
      if (!hit) {
        out.push(line);
        missing.push({
          key: `service-quotation:${line.lineKey}`,
          message: `The quotation chosen for ${line.label} no longer applies at these quantities. Choose again.`,
          owner: OWNER.STORE_SERVICE,
          blocking: true,
          lineKey: line.lineKey,
          judgedAt,
          candidates: applicable.map(serviceCandidate),
          excluded: excluded.map(serviceExclusion),
        });
        continue;
      }
      out.push({ ...line, serviceOfferId: hit.offerId, ...serviceTaxFor(hit, gstTreatment) });
      continue;
    }

    if (applicable.length === 1) {
      out.push({ ...line, serviceOfferId: applicable[0].offerId, ...serviceTaxFor(applicable[0], gstTreatment) });
      if (!gstTreatment && applicable[0].priceBasis !== "NON_TAXABLE") {
        missing.push({
          key: "policy-input-gst",
          message: "Company input-GST treatment is not configured, so quotation-backed services cannot be costed.",
          owner: OWNER.FINANCE,
          blocking: true,
        });
      }
      continue;
    }

    out.push(line);
    missing.push({
      key: `service-quotation:${line.lineKey}`,
      message: applicable.length === 0
        ? `${line.label} has no applicable service quotation.`
        : `${line.label} has ${applicable.length} applicable quotations. Choose which supplier this costing uses.`,
      owner: OWNER.STORE_SERVICE,
      blocking: true,
      lineKey: line.lineKey,
      judgedAt,
      /* Development work bought outside is priced from this same register and
         reaches this same gap; it is named apart because it dilutes across
         the run rather than scaling with it, and a reader choosing a supplier
         for it is answering a different question from a per-piece service. */
      sourcingSubject: {
        kind: line.category === "FIXED_SETUP" ? "DEVELOPMENT" : "SERVICE",
        label: line.label || line.lineKey,
        serviceId: line.serviceId || null,
        quantity: required,
        uom: line.serviceUnit || line.quantityUom || "",
        asOf,
      },
      /* The candidates travel with the gap so the screen can offer a real
         decision. Never ordered by price. */
      candidates: applicable.map(serviceCandidate),
      excluded: excluded.map(serviceExclusion),
    });
  }
  return { lines: out, missing };
}

/** One selectable service quotation, as the picker renders it. */
const serviceCandidate = (c) => ({
  offerId: c.offerId,
  supplierName: c.supplierName,
  quotationReference: c.quotationReference,
  revision: c.revision,
  billingUnit: c.billingUnit,
  currency: c.currency,
  appliedUnitPriceMinor: c.appliedUnitPriceMinor ?? c.unitPriceMinor ?? null,
  priceSource: c.priceSource ?? null,
  tierMinQuantity: c.tierMinQuantity ?? null,
  tierMaxQuantity: c.tierMaxQuantity ?? null,
  minimumChargeMinor: c.minimumChargeMinor ?? null,
  minimumChargeApplied: c.minimumChargeApplied ?? null,
  moq: c.minQuantity ?? null,
  orderMultiple: c.orderMultiple ?? null,
  leadTimeDays: c.leadTimeDays ?? null,
  validUntil: c.validUntil ?? null,
  purchaseQuantity: c.serviceQuantity ?? null,
});

/** And why one that did not apply is absent. */
const serviceExclusion = (e) => ({
  offerId: e.offerId, supplierId: e.supplierId, supplierName: e.supplierName,
  quotationReference: e.quotationReference, reason: e.code, message: e.message,
  purchaseQuantity: e.purchaseQuantity ?? null,
  purchaseUom: e.purchaseUom ?? e.billingUnit ?? null,
  moq: e.moq ?? null,
  orderMultiple: e.orderMultiple ?? null,
  tiers: e.tiers ?? null,
});

/* A non-taxable service has no GST to recover, so the policy's answer does not
   apply to it — the same correction the material path carries. */
const serviceTaxFor = (offer, gstTreatment) => {
  if (offer && offer.priceBasis === "NON_TAXABLE") return { tax: { treatment: "NONE" } };
  return gstTreatment ? { tax: { treatment: gstTreatment } } : {};
};

/**
 * Price every INTERNAL development line from the company's own charge table.
 *
 * ── WHY THIS IS NOT A QUOTATION ─────────────────────────────────────────────
 * Nobody quoted for it: the company's own pattern room did the work. What
 * exists is a standing charge Finance published, and the honest provenance is
 * the policy entry — its key, its label, its amount, and the window it was in
 * force for.
 *
 * ── EFFECTIVE-DATED, JUDGED AT THE COSTING DATE ─────────────────────────────
 * Against the costing's own `asOf`, never against whenever this happens to
 * run: a costing dated in March uses the charge that was in force in March,
 * and Finance publishing next quarter's must not re-price it.
 */
/**
 * Outbound freight: what it costs to deliver the finished order, or an
 * authoritative statement that it costs the company nothing.
 *
 * ── THREE ANSWERS, AND ONLY ONE OF THEM IS A CALCULATION ────────────────────
 * `ex_works` and `to_pay` produce a RECORDED ZERO — a line with a zero amount,
 * the arrangement on it and the source of that arrangement frozen beside it.
 * That is an answer somebody gave, and the completeness model reads it as one.
 * `delivered` is priced from a quotation. `prepaid` is a question nobody in
 * this codebase has answered and is asked of Sales.
 *
 * ── AND NOTHING INBOUND IS ADDED HERE ───────────────────────────────────────
 * Freight to bring materials in is part of what the material cost. A material
 * quotation that says it is landed already contains it; one that says it is
 * excluded is reported as an unpriced gap rather than being solved with an
 * OUTBOUND rate, which is a different lane, a different carrier and a
 * different direction.
 */
/**
 * CUSTOMS DUTY ON THE IMPORTED PARTS, AND ONLY THOSE.
 *
 * ── WHY A SEPARATE LINE AND NOT AN ADDITION TO THE MATERIAL ─────────────────
 * Non-recoverable GST is added onto the line it sits on, because it is the
 * same charge on the same supply. Duty is a different charge on a different
 * event — a customs entry — levied by a different authority under a different
 * classification. Folding it into the material rate would make "what did duty
 * cost us" unanswerable, and putting it under `MISC` would hide a named cost
 * behind an unnamed one. It gets the `DUTY` category the engine already has.
 *
 * ── AND WHY A PER-SCENARIO RUN TOTAL ────────────────────────────────────────
 * Duty is a percentage of a purchase amount, and the purchase amount scales
 * with the run. Computing it per garment and multiplying would round once per
 * unit; computing it on each scenario's own total rounds once. Same discipline
 * as the rest of the engine.
 *
 * ── THE BASE, AND WHAT IT IS NOT ────────────────────────────────────────────
 * The quotation-backed purchase amount of the imported line. NOT the statutory
 * CIF assessable value — this system records no inbound freight, no insurance
 * and no exchange rate, so CIF cannot be computed. Every frozen version says
 * which base it used. See `dutyPolicy.service` for the full statement.
 */
async function applyCustomsDuty(ctx, lines, { scenarios = [], asOf = new Date(), policy = {} } = {}) {
  const dutyPolicy = require("./dutyPolicy.service");
  const missing = [];
  const out = [];

  /* Only quotation-backed material and packaging inputs can be imported: a
     line with no supplier has no customs entry behind it. */
  const dutiable = lines.filter((l) => (
    (l.category === "MATERIAL" || l.category === "PACKAGING")
    && l.supplierOfferId && l.offerFacts
  ));
  if (!dutiable.length) return { lines, missing };

  const resolved = await dutyPolicy.resolveFor(ctx, { asOf }).catch(() => null);
  const roundingMode = policy.roundingMode || "HALF_UP";

  /* ── THE CLASSIFICATION IS THE ITEM'S, READ HERE ──────────────────────
     `RawItem.customsTariffCode`, not the HSN on the quotation and not the
     item's category. Read once for the lines that could need it, scoped to
     this company — a heading belongs to the goods, so it is the same whichever
     supplier quoted them. */
  const RawItem = mongoose.models.RawItem
    || require("../../models/CMS_Models/Inventory/Products/RawItem");
  const itemIds = [...new Set(dutiable.map((l) => String(l.itemId || "")).filter(Boolean))];
  const tariffByItem = new Map();
  if (itemIds.length) {
    const docs = await RawItem
      .find({ companyId: ctx.companyId, _id: { $in: itemIds } })
      .select("_id customsTariffCode").lean().catch(() => []);
    for (const d of docs) tariffByItem.set(String(d._id), String(d.customsTariffCode || "").toUpperCase());
  }

  for (const line of lines) {
    out.push(line);
    if (!dutiable.includes(line)) continue;

    const sourcing = line.offerFacts.sourcing || {};
    const position = dutyPolicy.positionFor({
      sourcingType: sourcing.type,
      countryOfOrigin: sourcing.countryOfOrigin,
      dutyInQuotedRate: sourcing.dutyInQuotedRate,
      /* The heading is the ITEM's — never the quotation's HSN. */
      customsTariffCode: tariffByItem.get(String(line.itemId || "")) || "",
      quotation: {
        offerId: line.supplierOfferId,
        reference: line.offerFacts.offerReference,
        revision: line.offerFacts.offerRevision,
      },
    }, resolved?.policy || null, { asOf });

    if (position.blocking) {
      /* The line stays, and no duty line is invented. The gap names the desk
         that holds the missing fact — Store for the evidence, the Board for
         the rate — because "customs is not configured" sends everybody to the
         wrong screen. */
      missing.push({
        key: `customs-duty:${line.lineKey}`,
        lineKey: line.lineKey,
        message: `${line.label || "This imported input"}: ${position.message}`,
        owner: position.owner,
        blocking: true,
        dutyState: position.state,
        ...(position.candidateKeys ? { candidateKeys: position.candidateKeys } : {}),
      });
      continue;
    }

    /* Domestic, or a rate that already carries the duty. An answer, and no
       line — recorded on the material line so a reader can see customs was
       considered rather than skipped. */
    if (position.state === dutyPolicy.STATE.NOT_APPLICABLE) {
      out[out.length - 1] = {
        ...line,
        customsPosition: { state: position.state, message: position.message },
        /* ── AND WHEN THE RATE ALREADY CARRIES IT, THAT IS FROZEN ──────
           An absent duty line has two very different explanations: the goods
           were bought in India, or they were imported at a price that already
           includes the duty. The second is a customs position somebody took
           on a specific quotation, and a version that merely omitted the line
           would leave a later reader unable to tell it from an oversight — or
           from a costing done before the rule existed.

           So it is written down, with no amount, because none was charged.
           Domestic needs no such record: the quotation itself says so, and
           writing a row for every locally-bought input would bury the one
           case that is actually a decision. */
        ...(position.dutyInQuotedRate === "INCLUDED" ? {
          dutyProvenance: {
            ...dutyPolicy.freeze({
              resolved, position,
              evidence: { quotation: {
                offerId: line.supplierOfferId,
                reference: line.offerFacts.offerReference,
                revision: line.offerFacts.offerRevision,
              } },
              scenarios: [],
              asOf,
            }),
            dutiedLineKey: line.lineKey,
          },
        } : {}),
      };
      continue;
    }

    /* ── ONE RULE MATCHED ─────────────────────────────────────────────
       Including an explicit 0%, which produces a real line of nil. That is a
       different record from no line at all, and the state on the provenance
       says which. */
    const amountByScenario = {};
    const workings = [];
    for (const sc of scenarios) {
      const basis = lineRunTotalMinor(line, sc);
      if (basis === null) continue;
      const duty = dutyPolicy.dutyMinorOn(basis, position.ratePercent, { roundingMode });
      amountByScenario[sc.key] = { amountMinor: duty, currency: policy.baseCurrency || "INR" };
      workings.push({ scenarioKey: sc.key, basisAmountMinor: basis, dutyMinor: duty });
    }

    /* The primary scenario's figure as the plain `amount`, exactly as freight
       does it: the engine reads that as the fallback, and it is what a version
       frozen before per-scenario amounts existed would mean. */
    const primary = scenarios.find((sc) => sc.isPrimary) || scenarios[0] || null;
    const fallback = primary ? amountByScenario[primary.key] : null;

    out.push({
      lineKey: `duty:${line.lineKey}`,
      category: "DUTY",
      behaviour: "FIXED_PER_RUN",
      label: `Customs duty — ${line.label || line.lineKey}`,
      ...(fallback ? { amount: fallback } : {}),
      ...(Object.keys(amountByScenario).length ? { amountByScenario } : {}),
      confidence: "VERIFIED",
      /* "Estimated", said on the line itself: this is a costing figure charged
         on the quotation's purchase amount, not what customs will assess on a
         bill of entry. */
      note: `Estimated customs duty for costing — the Board's approved rate of `
        + `${position.ratePercent}% on this line's purchase amount.`,
      dutyProvenance: {
        ...dutyPolicy.freeze({
          resolved, position,
          evidence: { quotation: {
            offerId: line.supplierOfferId,
            reference: line.offerFacts.offerReference,
            revision: line.offerFacts.offerRevision,
          } },
          scenarios: workings,
          asOf,
        }),
        dutiedLineKey: line.lineKey,
      },
    });
  }

  return { lines: out, missing };
}

/**
 * One line's purchase amount for one scenario, in minor units.
 *
 * Read off the line the engine will price, so the base duty is charged on is
 * the same figure the material line contributes — not a second derivation that
 * could disagree with it.
 */
function lineRunTotalMinor(line, scenario) {
  const qty = Number(scenario?.quantity);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  if (line.behaviour === "PER_UNIT" && line.unitRate?.amountMinor !== undefined) {
    const per = new Decimal(line.unitRate.amountMinor)
      .times(new Decimal(String(line.quantityPerUnit ?? "1")));
    return roundMinor(per.times(qty), "HALF_UP");
  }
  if (line.amount?.amountMinor !== undefined) return line.amount.amountMinor;
  return null;
}

async function applyFreight(ctx, lines, {
  costing, styleId = null, policy = {}, scenarios = [], asOf = new Date(),
  choices = {},
} = {}) {
  const missing = [];
  /* Only a source-backed enquiry costing has delivery terms to read. */
  if (costing?.context?.type !== "ENQUIRY_STYLE") return { lines, missing };

  const style = styleId
    ? await sampleStyleModel().findById(styleId).select("sample.shipment").lean()
    : null;

  const source = await freightSource.readFreightSource(ctx, {
    enquiryId: costing.context.primaryId, style, asOf,
  });

  const lineKey = "freight:outbound";
  const base = {
    lineKey,
    category: "FREIGHT",
    /* Charged for the RUN in every basis. A per-kg total scales with the
       order and a per-carton one steps with it, but neither is a per-garment
       rate that gets multiplied — the engine is handed the run total for
       each scenario. */
    behaviour: "FIXED_PER_RUN",
    label: "Outbound freight",
    freightArrangement: source.arrangement,
    freightArrangementSource: source.arrangementSource,
  };

  /* ── WHAT BLOCKS, AND WHAT MERELY IS NOT ANSWERED YET ───────────────
     Once an arrangement SAYS the company bears the freight, every fact the
     price needs is required: we know money is owed and cannot say how much,
     and calculating anyway would understate the garment by the whole amount.
     The same holds for a prepaid order, where money is certainly moving and
     only its treatment is open.

     An arrangement nobody has stated is different. Nothing yet says freight
     is owed at all, and refusing to calculate would stop every costing in
     the company until Sales had been round every open enquiry. So it is a
     coverage gap owned by Sales — the family reads as needing input, the
     costing cannot be complete, and the draft still calculates. */
  for (const m of source.missing) {
    const blocking = m.code !== freight.CODES.ARRANGEMENT_MISSING;
    missing.push({
      key: `freight:${m.code}`, message: m.message, owner: m.owner,
      blocking, lineKey, code: m.code,
    });
  }
  /* No arrangement means no line at all — not a zero, which would be an
     answer nobody gave. */
  if (!source.arrangement) return { lines, missing };
  if (source.missing.length) return { lines: [...lines, base], missing };

  /* ── AND THERE IS NO LONGER ANYTHING TO REFUSE HERE ─────────────────
     This used to catch a costing-side "freight does not apply" sent against a
     DELIVERED order — somebody declaring away a cost the company had agreed
     to bear. The guard is gone because the thing it guarded against is: no
     payload carries an applicability decision, and `familyApplicability` gives
     freight no owner at all, so no record anywhere can excuse this family.

     Sales' arrangement is still the whole answer. `ex_works` and `to_pay`
     produce the RECORDED ZERO below — an answer, with the arrangement on it —
     and a delivered order has to be priced from a quotation or reported as an
     unpriced gap owned by Store. There is no third outcome.

     The refusal itself moved to the request contract, where it belongs and
     where a stale browser meets it: COSTING_APPLICABILITY_DECISION_MOVED. */

  /* ── AN ANSWER OF NIL, RECORDED AS ONE ──────────────────────────────── */
  if (source.treatment === "RECORDED_ZERO") {
    return {
      lines: [...lines, {
        ...base,
        label: source.arrangement === "ex_works"
          ? "Outbound freight — customer collects"
          : "Outbound freight — customer pays the carrier",
        amount: { amountMinor: 0, currency: policy.baseCurrency || "INR" },
        confidence: "VERIFIED",
        freightProvenance: {
          state: "RECORDED_ZERO",
          arrangement: source.arrangement,
          arrangementSource: source.arrangementSource,
          enquiryRef: source.enquiryRef,
          asOf,
        },
      }],
      missing,
    };
  }

  /* ── OR A LANE, A QUOTATION AND A SHIPMENT ──────────────────────────── */
  const lane = {
    originWarehouseId: source.origin.warehouseId,
    destination: source.destination,
    mode: source.mode,
  };
  const { applicable, excluded } = await freightOfferRead.applicableOffers(
    { companyId: ctx.companyId, actorId: ctx.actorId, reason: "costing_freight" },
    { ...lane, asOf },
  );

  const chosenId = String(choices[lineKey] || "");
  let offer = null;
  if (chosenId) {
    offer = applicable.find((o) => o.offerId === chosenId) || null;
    if (!offer) {
      missing.push({
        key: `freight:${freight.CODES.NO_OFFER}`, lineKey, blocking: true,
        owner: freight.OWNER.STORE_PURCHASE,
        message: "The freight quotation chosen for this costing does not apply to this lane, or is no longer live.",
        candidates: applicable, excluded,
      });
      return { lines: [...lines, base], missing };
    }
  } else if (applicable.length === 1) {
    [offer] = applicable;
  } else if (applicable.length > 1) {
    /* ── SEVERAL CARRIERS IS A DECISION, NOT AN ORDERING ──────────────
       Never the cheapest by default: transit time, claims history and who
       actually has capacity are not in this database, and picking on price
       would be making a sourcing decision with none of the information the
       person making it has. */
    missing.push({
      key: `freight-quotation:${lineKey}`, lineKey, blocking: true,
      owner: freight.OWNER.STORE_PURCHASE,
      message: `${applicable.length} freight quotations apply to this lane. Choose which one this costing uses.`,
      /* A freight requirement is identified by its LANE, not by an item or a
         service — see `FreightOffer` for why that cannot be flattened into a
         name. So the decision records where it starts, where it ends and how
         it travels, and a changed lane makes the decision stale rather than
         quietly repricing a different journey. */
      sourcingSubject: {
        kind: "FREIGHT",
        label: `${source.origin.name || "Origin"} → ${source.destination.city || source.destination.label || "Destination"}`,
        originWarehouseId: source.origin.warehouseId || null,
        destinationAddressId: source.destination.addressId || null,
        destinationLabel: source.destination.city || source.destination.label || "",
        mode: source.mode || "",
        asOf,
      },
      candidates: applicable.map((o) => ({
        offerId: o.offerId, supplierName: o.supplierName, mode: o.mode,
        basis: o.basis, rateMinor: o.rateMinor, currency: o.currency,
        quotationReference: o.quotationReference, selected: false,
      })),
      excluded,
    });
    return { lines: [...lines, base], missing };
  } else {
    missing.push({
      key: `freight:${freight.CODES.NO_OFFER}`, lineKey, blocking: true,
      owner: freight.OWNER.STORE_PURCHASE,
      message: `No freight quotation covers ${source.origin.name || "this origin"} to ${source.destination.city || "this destination"} by ${String(source.mode).toLowerCase()}.`,
      excluded,
    });
    return { lines: [...lines, base], missing };
  }

  /* ── SPLITTING THE ORDER CHANGES MORE THAN A MULTIPLIER ─────────────
     A delivery count above one is not a number to multiply by. Nothing here
     records how many garments go in each consignment, and without that:

       · a FIXED charge is per consignment, so the total depends on how many
         there are — which is known — but also on whether the quotation was
         given for one or for the lot, which is not;
       · a PER-CARTON total is a CEILING, and ceilings do not add up. 250
         garments at 40 a carton is 7 cartons in one load, but 4 + 4 = 8
         across two loads of 125. An aggregate rounding is simply the wrong
         number, and which way it is wrong depends on the split;
       · a MINIMUM CHARGE applies to each consignment, so one order of 210 kg
         at a ₹4,000 minimum is ₹7,350, and three loads of 70 kg is ₹12,000.
         Applying the minimum once understates it by the whole difference.

     PER_KG with no minimum is the one case that survives: it is linear in
     total weight, and total weight does not depend on how the weight is
     divided. Everything else is a schedule Sales has to record. */
  const split = source.deliveryCount !== null && source.deliveryCount > 1;
  if (split) {
    const why = offer.basis === "FIXED_PER_CONSIGNMENT"
      ? `this quotation is a fixed charge for one consignment, and a fixed charge applies to each of the ${source.deliveryCount}`
      : offer.basis === "PER_CARTON"
        ? "this quotation is per carton, and cartons are rounded up per consignment — the total depends on how the garments are split, which nothing here records"
        : offer.minimumChargeMinor
          ? `this quotation has a minimum charge, which applies to each of the ${source.deliveryCount} consignments and not once to the order`
          : null;
    if (why) {
      missing.push({
        key: `freight:${freight.CODES.MULTI_DELIVERY}`, lineKey, blocking: true,
        owner: freight.OWNER.SALES,
        message: `This order is recorded as ${source.deliveryCount} deliveries and ${why}. Record the delivery schedule — how many garments go in each — rather than splitting the order evenly, which nothing here knows to be true.`,
        basis: offer.basis,
        deliveryCount: source.deliveryCount,
      });
      return { lines: [...lines, base], missing };
    }
  }

  /* One run total per scenario: more garments is more kilograms, and more
     cartons — a per-carton total steps rather than scaling. */
  const amountByScenario = {};
  const perScenario = {};
  let tax = null;
  let firstWorking = null;

  for (const scenario of scenarios) {
    const priced = freight.priceScenario(offer, {
      quantity: scenario.quantity,
      shipment: source.shipment,
      roundingMode: policy.roundingMode || "HALF_UP",
      gstTreatment: policy.inputGstTreatment || null,
    });
    if (priced.missing) {
      missing.push({
        key: `freight:${priced.missing.code}`, lineKey, blocking: true,
        owner: priced.missing.owner,
        message: priced.missing.code === freight.CODES.WEIGHT_MISSING
          ? "This freight is quoted per kilogram and the sample records no packed weight. A garment of no weight would ship for nothing."
          : "This freight is quoted per carton and the sample does not say how many garments a carton holds.",
      });
      return { lines: [...lines, base], missing };
    }
    amountByScenario[scenario.key] = {
      amountMinor: priced.totalMinor, currency: offer.currency,
    };
    perScenario[scenario.key] = {
      scenarioKey: scenario.key,
      quantity: String(scenario.quantity),
      chargeableUnit: priced.unit,
      working: priced.working,
      beforeMinimumMinor: priced.beforeMinimumMinor,
      minimumChargeApplied: priced.minimumApplied,
      freightMinor: priced.totalMinor,
    };
    tax = priced.tax;
    firstWorking = firstWorking || priced;
  }

  /* A preview has no scenarios yet; it still shows the lane, the supplier and
     the basis, and says the amount arrives with a run size. */
  const primary = scenarios.find((s) => s.isPrimary) || scenarios[0] || null;
  const fallback = primary ? amountByScenario[primary.key] : null;

  return {
    lines: [...lines, {
      ...base,
      label: source.treatment === "RECOVERED_SEPARATELY"
        ? `Outbound freight — ${offer.supplierName || "transporter"} (recovered from the customer)`
        : `Outbound freight — ${offer.supplierName || "transporter"}`,
      /* ── PAID BY US, BILLED TO THEM, AT COST ──────────────────────
         It stays a company cost — the money leaves — and it comes out of the
         GARMENT's price basis, because a margin on somebody's own
         reimbursement is not a margin anybody agreed to. */
      ...(source.treatment === "RECOVERED_SEPARATELY" ? { recoveredSeparately: true } : {}),
      ...(fallback ? { amount: fallback } : {}),
      ...(Object.keys(amountByScenario).length ? { amountByScenario } : {}),
      freightOfferId: offer.offerId,
      ...(tax ? { tax } : {}),
      confidence: "SUPPLIER_QUOTATION",
      freightProvenance: {
        state: "SUPPLIER_QUOTATION",
        arrangement: source.arrangement,
        arrangementSource: source.arrangementSource,
        prepaidTreatment: source.prepaidTreatment,
        /* `COMPANY_BEARS` or `RECOVERED_SEPARATELY` — the accounting outcome,
           frozen, because the same arrangement produced both. */
        recovery: source.treatment,
        /* No markup is taken on a recovery, and the rule is recorded rather
           than left to be inferred from two figures that happen to match. */
        recoveryMarkup: source.treatment === "RECOVERED_SEPARATELY" ? "AT_COST" : null,
        enquiryRef: source.enquiryRef,
        origin: source.origin,
        destination: source.destination,
        mode: source.mode,
        offer,
        shipment: source.shipment,
        /* How many consignments the order was recorded as, frozen — a per-kg
           total is only split-proof because there is no minimum, and a reader
           has to be able to see both facts together. */
        deliveryCount: source.deliveryCount,
        scenarios: perScenario,
        asOf,
      },
    }],
    missing,
  };
}

/**
 * Whether each priced material's own quotation says it was delivered here.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 * It is not an inbound freight PRICE. Nothing in this system quotes inbound
 * freight for a future order: there is no inbound rate register, the outbound
 * one is for a different lane and a different carrier, and the two actual
 * records that exist — a purchase order's shipping charge and a landed-cost
 * allocation — are what was paid on a real receipt for a different order.
 *
 * So an EXCLUSIVE rate is reported as an incomplete acquisition cost and an
 * unrecorded term as an unanswered question. Both are blockers owned by
 * Store, and both stay blockers until somebody records the inbound source.
 * Guessing either way would be the same error in opposite directions.
 */
function inboundFreightGaps(lines) {
  const out = [];
  for (const line of lines) {
    if (line.category !== "MATERIAL" && line.category !== "PACKAGING") continue;
    /* Only a line that actually got a rate: one still waiting for a quotation
       has its own gap, and two gaps for one missing quotation is noise. */
    if (!line.supplierOfferId || !line.offerFacts) continue;
    const terms = line.offerFacts.freightTerms || null;
    if (terms === "INCLUSIVE_LANDED") continue;
    out.push({
      key: `inbound-freight:${line.lineKey}`,
      lineKey: line.lineKey,
      owner: OWNER.STORE,
      blocking: true,
      message: terms === "EXCLUSIVE"
        ? `The quotation for "${line.label}" excludes delivery to our warehouse, so its landed cost is incomplete. Nothing here forecasts inbound freight — the outbound register is a different lane and a different carrier.`
        : `The quotation for "${line.label}" does not say whether its rate includes delivery to our warehouse. Ask the supplier and record it: a rate that excludes inbound freight understates the material on every metre.`,
      freightTerms: terms,
      remedy: "RECORD_SUPPLIER_FREIGHT_TERMS",
    });
  }
  return out;
}

function applyDevelopmentCharges(lines, { policy = {}, asOf = new Date() } = {}) {
  /* ── WHERE THIS TABLE COMES FROM NOW ─────────────────────────────────
     The Board's approved catalogue for this costing's date, filled into this
     one field by `policy.service`. Nothing about the selection, the two
     calculations or the rounding changes — only who decided the amounts, and
     that they are dated and attributed.

     Adapted, so a charge carried over from before rate periods existed is
     read as the one period it always was rather than being invisible here. */
  const table = adaptTable(policy.developmentCharges);
  /* ── A CATALOGUE NOBODY APPROVED IS NOT AN EMPTY ONE ──────────────────
     `undefined` means the Board has not decided what the company charges for
     its own work. `[]` means it decided, and the answer is none — which is a
     real answer for a company that buys all its setup outside. The two are
     fixed in different places and must not read alike. */
  const noPolicy = !Array.isArray(policy.developmentCharges);
  const missing = [];
  const out = [];

  for (const line of lines) {
    if (line.category !== "FIXED_SETUP" || line.developmentSource !== "COMPANY_POLICY"
      || line.amount || line.unitRate) {
      out.push(line);
      continue;
    }

    const key = String(line.developmentChargeKey || "");
    const entry = table.find((c) => String(c.key) === key);
    const when = asOf instanceof Date ? asOf : new Date(asOf);
    const on = when.toISOString().slice(0, 10);

    /* ── THE ONE RATE IN FORCE ON THIS COSTING'S DATE ────────────────
       Not the latest one. A costing dated in September is calculated at the
       September rate for ever, and Finance publishing October's adds a
       period beside it rather than replacing it. */
    const { period, reason: periodReason } = entry
      ? selectPeriod(entry, when)
      : { period: null, reason: null };

    /* And what it comes to for THIS requirement — once, for the run. Four
       screens at ₹2,000 is ₹8,000 whether the order is 100 or 1,000. */
    const priced = entry && period
      ? chargeTotalMinor(entry, period, {
        quantity: line.quantityPerRun,
        roundingMode: policy.roundingMode || "HALF_UP",
      })
      : { totalMinor: null, quantity: null, reason: null };

    /* Each refusal names what is actually wrong, because they are fixed in
       different places: a missing entry is Finance configuring one, an
       inactive entry is Finance reinstating it, a date with no rate is
       Finance publishing the current one, and a missing quantity is R&D
       saying how many. */
    let why = null;
    if (!entry) {
      if (table.length) why = `No company development charge is configured under "${key}".`;
      else if (noPolicy) {
        why = "The Board has not approved a development charge catalogue, so work the company does "
          + "itself has no cost source. It is not free.";
      } else {
        why = "The company's approved development charge catalogue is empty, so this work has no "
          + "cost source.";
      }
    } else if (entry.active === false) {
      why = `The "${entry.label}" development charge is no longer active.`;
    } else if (periodReason === REASON.NO_PERIOD) {
      why = `No rate for the "${entry.label}" development charge was in force on ${on}.`;
    } else if (periodReason === REASON.AMBIGUOUS) {
      /* Two rates on one day is a table contradicting itself, and picking
         one would make "which rate did this costing use" unanswerable. */
      why = `Two rates for the "${entry.label}" development charge apply on ${on}, so this costing cannot say which one it used.`;
    } else if (priced.reason === REASON.NO_QUANTITY) {
      why = `"${entry.label}" is charged per ${entry.unit || "unit"}, so this requirement has to say how many.`;
    }

    if (why) {
      /* The line stays, rateless — never a plausible zero — and the gap says
         who can close it. */
      out.push(line);
      missing.push({
        key: `development-policy:${line.lineKey}`,
        message: why,
        /* A missing quantity is R&D's row to finish; everything else about
           the catalogue is the BOARD's to approve — no department can settle
           what the company charges for its own capability. */
        owner: priced.reason === REASON.NO_QUANTITY ? OWNER.RND : OWNER.BOARD,
        blocking: true,
        lineKey: line.lineKey,
        chargeKey: key,
        /* What IS configured, so somebody can see whether they meant another
           one rather than being told only that this is wrong. No amounts: a
           gap message is not a rate card. */
        candidates: table
          .filter((c) => c.active !== false)
          .map((c) => ({
            key: c.key, label: c.label,
            calculation: c.calculation, unit: c.unit || null,
          })),
      });
      continue;
    }

    out.push({
      ...line,
      /* The engine's shape for a one-time charge: an amount for the run. */
      amount: { amountMinor: priced.totalMinor, currency: period.currency || "INR" },
      /* ── NAMED BY THE CHARGE, NOT BY ITS KEY ────────────────────────
         An internal row names no service, so the only label it arrives with
         is the key R&D chose it by — and "pattern" on a cost line is a
         database value on a page a person is meant to read. The charge's own
         label is what Finance published it as. R&D's words about THIS style
         are the specification, and are untouched. */
      label: entry.label || line.label,
      developmentChargeLabel: entry.label,
      /* ── FROZEN AS POLICY, NOT AS A QUOTATION ────────────────────────
         It carries no supplier and no quotation reference, and labelling it
         SUPPLIER_QUOTATION would claim evidence that does not exist. */
      policyProvenance: {
        state: "COMPANY_POLICY",
        chargeKey: entry.key,
        chargeLabel: entry.label,
        /* ── HOW THE FIGURE WAS ARRIVED AT, NOT ONLY WHAT IT IS ────
           "₹8,000" a year later cannot be checked. "Four screens at ₹2,000,
           under the rate in force from 1 April" can be — against a table
           whose later revisions did not touch this version. */
        calculation: entry.calculation,
        unit: entry.unit || null,
        quantity: priced.quantity,
        unitAmountMinor: period.amountMinor,
        amountMinor: priced.totalMinor,
        currency: period.currency || "INR",
        basis: "FIXED_PER_RUN",
        /* The SELECTED period's window, not the definition's — that is the
           thing a reader has to be able to find again. */
        effectiveFrom: period.effectiveFrom || null,
        effectiveTo: period.effectiveTo || null,
        policyRevision: policy.revision ?? null,
        asOf: when,
        /* Which row on which style asked for it, and whether the sample
           demonstrated it. */
        requirementKey: line.technicalKey || null,
        evidence: line.technicalEvidence || null,
      },
    });
  }

  return { lines: out, missing };
}

/**
 * WHAT IT COSTS TO WAIT TO BE PAID FOR THIS ORDER.
 *
 * ── WHY THIS IS NOT A POLICY PERCENTAGE ANY MORE ────────────────────────────
 * The engine used to synthesise this line from `CostingPolicy.financingRate
 * Percent` — one company number, applied to every costing regardless of what
 * had been agreed with the buyer. Two orders with the same materials and
 * payment terms ninety days apart carried identical financing, which is not a
 * cost of capital; it is a surcharge with a cost of capital's name on it.
 *
 * The rate and the methodology are now a Board decision with an effective
 * date, and the duration is a Sales fact confirmed on the enquiry. This
 * combines them and does nothing else — see `financing.service.js` for the
 * arithmetic, which is pure and tested on its own.
 *
 * ── WHAT IS A LINE AND WHAT IS A GAP ────────────────────────────────────────
 * A figure, and a recorded nil, are lines. An unanswered enquiry or an
 * undecided Board is a GAP with the department named — no line, because a
 * zero here is the claim that this order costs nothing to finance, and that
 * is exactly what nobody has said.
 *
 * ── AND WHY THE GAPS DO NOT BLOCK THE SAVE ──────────────────────────────────
 * The same reason a missing freight arrangement does not: a draft that cannot
 * be calculated at all stops every costing in the company until somebody has
 * been round every open enquiry and the Board has met. The family reads as
 * outstanding, completeness cannot be reached, and the draft still calculates
 * — which is a costing that is honestly incomplete rather than one that is
 * silently wrong.
 */
async function applyFinancing(ctx, lines, { costing, policy = {}, asOf = new Date() } = {}) {
  const missing = [];
  /* Only an enquiry costing has payment terms to read. An ad-hoc costing
     references no commercial agreement, so there is no duration to finance
     and inventing one would be worse than the flat percentage this replaced. */
  if (costing?.context?.type !== "ENQUIRY_STYLE") return { lines, missing };

  const source = await financing.readFinancingSource(ctx, {
    enquiryId: costing.context.primaryId,
    asOf,
  });
  const result = financing.compute({ policy: source.policy, terms: source.terms });

  for (const m of result.missing) {
    missing.push({
      key: `financing:${m.code}`,
      code: m.code,
      message: m.message,
      owner: m.owner,
      blocking: false,
      lineKey: financing.LINE_KEY,
    });
  }

  /* Nothing decided by either side yet — no line at all. */
  if (result.state === financing.STATE.POLICY_MISSING || result.state === financing.STATE.TERMS_MISSING) {
    return { lines, missing };
  }

  const provenance = financing.freeze({
    result, policy: source.policy, terms: source.terms, enquiryRef: source.enquiryRef, asOf,
  });

  /* ── SALES SAID IT DOES NOT APPLY ─────────────────────────────────────
     A stated commercial condition — an intercompany transfer, a sample at
     cost. Recorded as a nil line with the reason on it rather than as an
     absent family, because "somebody decided this is unfinanced" and "nobody
     has looked" must not read the same on the version. */
  if (result.state === financing.STATE.NOT_APPLICABLE) {
    return {
      lines: [...lines, {
        lineKey: financing.LINE_KEY,
        category: "FINANCING",
        behaviour: "FIXED_PER_RUN",
        label: "Financing — does not apply to this order",
        amount: { amountMinor: 0, currency: policy.baseCurrency || "INR" },
        confidence: "VERIFIED",
        note: result.working?.reason || "Sales recorded that financing does not apply.",
        financingProvenance: provenance,
      }],
      missing,
    };
  }

  /* ── OR A DURATION, PRICED ────────────────────────────────────────────
     Including a duration of nothing. A full advance and a nil credit period
     both come out here at 0%, as a line somebody's answer produced — which is
     what `RECORDED_ZERO` means everywhere else in this domain. */
  return {
    lines: [...lines, {
      lineKey: financing.LINE_KEY,
      category: "FINANCING",
      behaviour: "PERCENT_OF_BASIS",
      basis: result.basis,
      percent: result.percent,
      label: `Financing (${result.working.creditDays} days at ${result.working.annualRatePercent}% a year)`,
      confidence: "VERIFIED",
      note: "Board financing policy applied to this order's confirmed payment terms.",
      financingProvenance: provenance,
    }],
    missing,
  };
}

async function assembleLines(ctx, costing, {
  styleId = null, clientLines = [], policy,
  scenarios = [], asOf = new Date(),
  /* ── WHY THIS IS NOT A PARAMETER ANY MORE ───────────────────────────────
     It was `quotationChoices`, and the browser filled it in. Which supplier
     the company buys from is Store's decision — lead time, capacity, quality
     history and terms are all Store's to weigh, and none of them is in a
     rate. Costing was merely the screen where the ambiguity became visible.

     So the decisions are LOADED, from the record Store writes them to, and no
     caller can supply one. A parameter that still accepted them would be the
     old path with a new name: a stale browser, or anything holding the
     endpoint, could name the supplier a costing is priced from.

     `sourcingDecisionsFor` is an injection point for tests and for the Store
     queue — which asks what is still OPEN and therefore deliberately reads
     none. It is never reachable from a request. */
  sourcingDecisionsFor = null,
} = {}) {
  const overrides = (clientLines || []).filter((l) => l.override);
  const plain = (clientLines || []).filter((l) => !l.override);

  /* ── STORE'S DECISIONS, RE-READ ON EVERY ASSEMBLY ────────────────────────
     Loaded fresh rather than carried, because a decision is only as good as
     the quotation behind it and that quotation lives in a register somebody
     else can withdraw. Each one is revalidated against the live candidates
     below by exactly the check that used to revalidate the browser's map — a
     decision naming a quotation that no longer applies comes back as an
     unresolved gap owned by Store, never as a substitution. */
  const quotationChoices = sourcingDecisionsFor
    ? await sourcingDecisionsFor(ctx, costing)
    : await require("../storePurchase/sourcingDecision.service")
      .decisionsFor(ctx, costing?._id);

  const assembledView = await assemble(ctx, costing, {
    styleId, lines: clientLines,
  });

  /* ── AD-HOC AND HISTORICAL WORK IS UNCHANGED ──────────────────────────── */
  if (assembledView.state === STATE.NOT_SOURCE_BACKED) {
    return { ...assembledView, lines: clientLines, generated: [] };
  }
  if (assembledView.state !== STATE.ASSEMBLED) {
    /* ── AND THE BYPASS THAT WAS LEFT OPEN ────────────────────────────────
       This used to return the client's own lines with a note that nothing had
       been assembled — reasoned as "refusing them would make an awaiting-R&D
       costing unusable". That reasoning was backwards. An awaiting-R&D costing
       SHOULD be unusable: the whole claim of a source-backed costing is that
       its consumption came from the sample, and a version calculated from
       typed lines while that record is missing is a manual costing wearing an
       enquiry product's name.

       Worse, it was reachable by a stale screen and by anyone with the
       endpoint: post lines, get a frozen version, and nothing on it says the
       technical record never existed.

       So it refuses, and names what R&D has to complete. Ad-hoc costings are
       untouched — they are the manual workflow, and it is still there. */
    throw fail("COSTING_AWAITING_SOURCE",
      assembledView.state === STATE.SEVERAL_TECHNICAL_RECORDS
        ? "This product has more than one technical record. Choose which one this costing is for before calculating."
        : "This costing is raised against an enquiry product with no R&D technical record yet. Its materials and operations come from that record, so it cannot be calculated from typed lines.",
      {
        reason: assembledView.state,
        state: assembledView.state,
        /* Who has to act, and on what. */
        owner: assembledView.state === STATE.SEVERAL_TECHNICAL_RECORDS ? null : OWNER.RND,
        candidates: assembledView.candidates || [],
        missing: assembledView.missing,
      });
  }

  const preview = assembledView.technical;
  const generated = [
    ...(preview.materials || []).filter((m) => m.importable).map(lineFromMaterial),
    ...(preview.operations || []).filter((o) => o.importable)
      .map((o) => lineFromOperation(o, { policy: policy || {}, roundingMode: (policy || {}).roundingMode })),
    /* Unimportable rows are NOT here and are not dropped either: they arrive
       as blocking gaps from `technicalMissing`, named and owned. A packaging
       row R&D left without a quantity blocks the save; it never becomes a
       garment that ships unpacked for free. */
    ...(preview.packaging || []).filter((p) => p.importable).map(lineFromPackaging),
    /* Split by what the requirement SAYS it is. A tooling row costed as a
       recurring service would be multiplied by the run size. */
    ...(preview.services || []).filter((sv) => sv.importable && sv.purpose !== "DEVELOPMENT_TOOLING")
      .map(lineFromService),
    ...(preview.services || []).filter((sv) => sv.importable && sv.purpose === "DEVELOPMENT_TOOLING")
      .map(lineFromDevelopment),
  ];

  /* ── A CLIENT NEED NOT ECHO THE RECORD, AND GAINS NOTHING BY DOING SO ──
     Zero client lines is the normal case now: the server produces every
     technical row itself. A client that still sends them — an older build, or
     one that opened the picker — has its row kept for the SAME technical key
     rather than duplicated, because `bindTechnicalLines` then revalidates that
     row against the live record and refuses any drift in consumption, unit or
     evidence. Keeping the client's row is therefore the STRICTER path, not the
     laxer one: the generated row would be trusted by construction, and the
     submitted one has to prove itself.

     A submitted row whose technical key the record no longer carries is not
     silently dropped either — the binding step refuses it by name. */
  const echoed = new Map(
    plain.filter((l) => l.technicalKey).map((l) => [String(l.technicalKey), l]),
  );
  const reconciled = generated.map((g) => echoed.get(String(g.technicalKey)) || g);
  for (const [key, line] of echoed) {
    if (!generated.some((g) => String(g.technicalKey) === key)) reconciled.push(line);
  }

  /* ── AND EACH MATERIAL'S QUOTATION, WHERE ONE UNAMBIGUOUSLY APPLIES ────
     The technical record says how much is used; the Store register says what
     it costs. A material with exactly ONE applicable quotation is attached to
     it and priced per scenario by the existing contract — 500 at the base
     rate and 3,000 at whatever tier it reaches.

     Several applicable quotations is a SOURCING decision with a person's name
     on it, not something to settle by ordering or by price. None is a named
     missing input owned by Store. In both cases the line stays rateless and
     the assembly says which — never a plausible zero. */
  const withQuotations = await attachQuotations(ctx, reconciled, {
    scenarios, asOf,
    gstTreatment: (policy || {}).inputGstTreatment || null,
    choices: quotationChoices || {},
  });

    /* ── AND EACH REQUIRED SERVICE'S QUOTATION ─────────────────────────────
     Same discipline as materials, a different register: exactly one
     applicable quotation is attached, several is a sourcing decision with a
     person's name on it, and none is a named gap owned by Store. The line
     stays rateless in the last two cases — never a plausible zero. */
  const withServices = await attachServiceQuotations(ctx, withQuotations.lines, {
    scenarios, asOf,
    gstTreatment: (policy || {}).inputGstTreatment || null,
    choices: quotationChoices || {},
  });

  /* ── AND THE COMPANY'S OWN DEVELOPMENT CHARGES ─────────────────────────
     Work the company does itself has no supplier and no quotation. What it
     has is a charge Finance published, effective-dated, which the engine
     reads at calculation time. A charge that is not configured, not active,
     or outside its window is a BLOCKING gap owned by Finance — never a guess
     and never a zero. */
  const withDevelopment = applyDevelopmentCharges(withServices.lines, {
    policy: policy || {}, asOf,
  });

  /* ── AND WHETHER THE MATERIAL RATES INCLUDED GETTING THEM HERE ─────────
     Inbound freight is part of what a material COST, and belongs in its rate
     — never in the outbound family, which prices delivery of the finished
     order on a different lane to a different carrier.

     What this reports is whether each material's own quotation says so. It
     does not PRICE inbound freight: there is no inbound rate register, and
     the outbound one is not a substitute. `PurchaseOrder.shippingCharges` and
     `LandedCostAllocation` are records of what was actually paid on a real
     receipt, and one historical PO is not a forecast for this enquiry. So an
     excluded or unanswered term is an honest blocker, owned by Store. */
  const inboundMissing = inboundFreightGaps(withDevelopment.lines);

  /* ── AND WHAT CUSTOMS CHARGES TO BRING THE IMPORTED PARTS IN ──────────
     Only the lines Store recorded as imported, and only where all three
     desks have answered: Store on origin, the item master on the heading,
     and the Board on the rate. Anything short of that is a named blocker
     rather than a line, because a missing duty is never a duty of nil. */
  const withDuty = await applyCustomsDuty(ctx, withDevelopment.lines, {
    scenarios, asOf, policy: policy || {},
  });

  /* ── AND GETTING THE FINISHED ORDER TO THE CUSTOMER ────────────────────
     Outbound only. Freight paid to bring fabric IN belongs in the material's
     rate and is not added a second time here — see `freight.service`.

     Who bears it is a commercial fact on the enquiry, not a calculation: an
     ex-works order costs the company nothing to deliver and that is recorded
     as an answer, with the arrangement on the record, rather than as a line
     nobody wrote. */
  const withFreight = await applyFreight(ctx, withDuty.lines, {
    costing, styleId: assembledView.styleId, style: assembledView.styleDoc || null,
    policy: policy || {}, scenarios, asOf,
    choices: quotationChoices || {},
  });

  /* ── AND WHAT IT COSTS TO WAIT TO BE PAID FOR IT ──────────────────────
     Last, because it is charged on a subtotal that includes everything above
     — the materials, the labour, the freight and the overhead the engine adds
     — and because it is the only family whose rate depends on what Sales
     agreed rather than on what anything costs. */
  const withFinancing = await applyFinancing(ctx, withFreight.lines, {
    costing, policy: policy || {}, asOf,
  });

  /* ── AND NOTHING TYPED JOINS THEM ─────────────────────────────────────
     The merge that used to happen here is a refusal. Second layer: the
     request contract already rejects an override, and this catches an
     internal caller that built one without going through it. */
  refuseOverrides(overrides);

  /* ── AN UNDECLARED MANUAL LINE IS REFUSED ─────────────────────────────
     This used to carry every plain client row through, reasoned as backward
     compatibility. It was a trust path: any row with no technical key was
     accepted, so a request could be made to succeed simply by leaving the key
     off. A supplement nobody declared also double-counts silently — an extra
     "fabric" row sits beside the assembled one and the garment carries its
     material twice.

     For a source-backed costing the browser sends DECISIONS ONLY: which
     style, which quotation, which quantities, and what does not apply and
     why. It sends no figure of any kind.

     Historical versions are not recognised from a row shape — a browser can
     produce any shape. They are recognised by the server-side legacy-import
     path, which is exempted in `versionCreation` and stamps its own
     provenance. */
  /* ── AND THE REMEDY IS NO LONGER "DECLARE IT AN OVERRIDE" ─────────────
     It was, and that was the honest answer while five cost families had no
     record behind them. Every family has an owning application now, so the
     refusal names the department and the record instead of offering a way to
     type the figure here after all.

     `unresolvedGroup` is still not a licence to carry money: it is a string
     the browser sets, it names a family and carries nothing that makes a
     figure checkable. It is reported separately below because a row tagged
     with a family is the case most likely to have looked deliberate. */
  const undeclared = plain.filter((l) => !l.technicalKey);
  if (undeclared.length) {
    const first = undeclared[0];
    const owner = costCoverage.ownerOf({
      family: first.unresolvedGroup || "",
      category: first.category || "",
    });
    throw fail("COSTING_MANUAL_LINE_REFUSED",
      owner?.department
        ? `This costing is assembled from its technical record, quotations and policy. ${owner.label} cannot be entered here — ${owner.department} records it in ${owner.recordedIn}.`
        : "This costing is assembled from its technical record, quotations and policy. A cost figure cannot be entered here; it is read from the record of the department that owns it.",
      {
        reason: "UNDECLARED_MANUAL_LINE",
        lineKeys: undeclared.map((l) => l.lineKey),
        taggedWithoutOverride: undeclared.filter((l) => l.unresolvedGroup).map((l) => l.lineKey),
        /* Where the fact belongs, named rather than implied — and never a
           route back into this screen. */
        family: owner?.family || first.unresolvedGroup || null,
        owner: owner ? { department: owner.department, recordedIn: owner.recordedIn } : null,
        remedy: "RECORD_IN_OWNING_APPLICATION",
      });
  }

  /* Nothing is carried. Every legitimate row is assembled by the server, and
     they are all already in `withFinancing.lines`. */
  const carried = [];

  const assumptions = productionAssumptions(policy || {});

  /* ── AND THE PRESENTED ROWS ARE THE PRICED ONES ────────────────────────
     `generated` above is the row set as the technical record describes it,
     before any register or charge table was read. Returning THAT to the
     screen meant the preview could never show a quotation as selected or a
     development charge's amount: every one of those rows read as MISSING
     while the save went on to freeze a real figure.

     Which is the same defect the presentation contract exists to close, one
     step later. So the row SET stays the server's — no override and no
     client row joins it — but each row is the priced one that will be
     frozen. A row the client legitimately echoed under its own key keeps its
     unpriced form rather than borrowing another row's money. */
  const pricedByKey = new Map(withFinancing.lines.map((l) => [l.lineKey, l]));
  const generatedPriced = generated.map((g) => pricedByKey.get(g.lineKey) || g);
  /* Freight has no technical row behind it — it comes from the enquiry's own
     delivery terms — so it joins the presented set here rather than being
     invisible on the screen that shows what the version will contain. */
  for (const line of withFinancing.lines) {
    if ((line.category === "FREIGHT" || line.category === "FINANCING")
      && !generatedPriced.some((g) => g.lineKey === line.lineKey)) {
      generatedPriced.push(line);
    }
  }

  return {
    ...assembledView,
    lines: [...withFinancing.lines, ...carried],
    /* What the SERVER produced, before any client row was reconciled into it
       — the answer to "what would this cost with no browser involved". */
    generated: generatedPriced,
    productionAssumptions: assumptions,
    missing: [
      ...assembledView.missing,
      ...withQuotations.missing,
      ...withServices.missing,
      ...withDevelopment.missing,
      ...withDuty.missing,
      ...inboundMissing,
      ...withFreight.missing,
      ...withFinancing.missing,
      /* ── THE LABOUR ASSUMPTIONS, NOW THE BOARD'S ──────────────────────
         The gap itself is unchanged — `labourCost.assumptionGaps` is still the
         one definition, and the rate is still provisional until the company
         has answered. What changed is the desk: how much of a paid month is
         productive, the employer burden and where machine cost sits are an
         approved Board methodology now, so pointing at Finance would send
         somebody to a screen that refuses the write. */
      ...(generated.some((l) => l.category === "OPERATION") && !assumptions.configured
        ? [{
          key: "policy-production-assumptions",
          message: `Operation rates are provisional. ${assumptions.missing.join(" ")}`,
          owner: OWNER.BOARD,
          blocking: false,
        }]
        : []),
    ],
  };
}

/* ══ WHAT THE SCREEN IS GIVEN ════════════════════════════════════════════════
 *
 * ── THE MISMATCH THIS CLOSES ────────────────────────────────────────────────
 * The preview returned `assembled.technical` — the RAW sample facts — and
 * dropped `assembled.generated`, the rows the assembly actually built. So the
 * screen read `operations[].operatorCost`, the sample's legacy
 * `salary / 12,480 x SAM`, and displayed ₹2.16 as verified while version
 * creation went on to freeze the policy-derived ₹3.54.
 *
 * Two numbers for one operation, one on screen and one in the record, and
 * nothing anywhere said they were different. A person could read a costing,
 * approve it, and quote a figure the frozen version does not contain.
 *
 * So the presentation is built from the SAME generated rows the version is
 * built from. The screen computes nothing: every figure here is the one that
 * will be saved, for the same sources and the same decisions.
 */
function presentAssembly(assembled) {
  const generated = assembled.generated || [];
  const byKey = new Map(generated.map((l) => [l.lineKey, l]));
  const preview = assembled.technical || null;
  const missing = assembled.missing || [];
  const gapFor = (lineKey) =>
    missing.find((m) => m.lineKey === lineKey && String(m.key || "").startsWith("quotation:"));

  /* The technical facts, keyed so a generated row can find the record it came
     from without the screen matching on names. */
  const materialFacts = new Map((preview?.materials || []).map((m) => [m.sourceKey, m]));
  const operationFacts = new Map((preview?.operations || []).map((o) => [o.sourceKey, o]));

  const materials = generated
    .filter((l) => l.category === "MATERIAL")
    .map((l) => {
      const fact = materialFacts.get(l.technicalKey) || {};
      const gap = gapFor(l.lineKey);
      return {
        lineKey: l.lineKey,
        description: l.label,
        /* The EFFECTIVE consumption — the number this costing prices, and the
           number the supplier is asked for. */
        quantity: l.quantityPerUnit ?? null,
        unit: l.quantityUom || null,
        /* ── AND WHAT IT WAS ARRIVED AT FROM ────────────────────────────
           A reader shown only 1.47 cannot tell whether the allowance is in
           it. Shown 1.40 and 5% beside it, they can check the third number —
           which is the whole difference between a figure and a working.

           Omitted where there is nothing to explain: a row with no allowance
           recorded prints one quantity, not a sum with a zero in it. */
        consumptionWorking: l.consumption && l.consumption.allowanceAlreadyInQuantity !== true
          && l.consumption.allowancePercent !== null && l.consumption.allowancePercent !== undefined
          ? {
            basePerPiece: l.consumption.basePerPiece,
            allowancePercent: l.consumption.allowancePercent,
            effectivePerPiece: l.consumption.effectivePerPiece,
            uom: l.consumption.uom,
          }
          : null,
        /* Legacy rows say so rather than looking like rows with no allowance:
           what R&D typed was already the consumed amount. */
        allowanceAlreadyInQuantity: l.consumption?.allowanceAlreadyInQuantity === true,
        owner: "R&D",
        source: fact.basisLabel || "Sample technical record",
        evidence: l.technicalEvidence || null,
        /* Present only where a quotation was attached — the rate itself is
           per scenario and is resolved at calculation. */
        quotation: l.supplierOfferId
          ? { offerId: l.supplierOfferId, state: "SELECTED" }
          : null,
        state: gap ? "MISSING" : (l.supplierOfferId ? "VERIFIED" : "MISSING"),
        note: gap?.message || null,
      };
    });

  const operations = generated
    .filter((l) => l.category === "OPERATION")
    .map((l) => {
      const fact = operationFacts.get(l.technicalKey) || {};
      /* ── THE RATE THAT WILL BE SAVED, NOT THE SAMPLE'S ─────────────────
         `l.unitRate` is what `lineFromOperation` produced from the company's
         own assumptions. `fact.operatorCost` is the legacy figure and is
         returned only so a reader can SEE the two differ — never as the
         displayed rate. */
      const policyDerived = Boolean(l.labourWorkings);
      return {
        lineKey: l.lineKey,
        description: l.label,
        samMinutes: fact.samMinutes ?? null,
        rateMinor: l.unitRate?.amountMinor ?? null,
        rateBasis: policyDerived ? "COMPANY_POLICY" : "LEGACY_SAMPLE_RATE",
        workings: l.labourWorkings || null,
        owner: "Production",
        source: fact.rateBasis || "Operation master salary basis",
        /* Never VERIFIED on the legacy figure: a different number will be
           frozen the moment the company configures its assumptions. */
        state: policyDerived ? "VERIFIED" : "PROVISIONAL",
        note: policyDerived
          ? null
          : "Company production assumptions are not configured, so this is the sample's own figure and is provisional.",
        legacyRateMinor: rupeesToMinor(fact.operatorCost),
      };
    });

  /* ── PACKAGING, AS ITS OWN SOURCE GROUP ────────────────────────────────
     Not folded into materials. They come from different rows of the technical
     record, they are owned differently once something is wrong, and packaging
     carries a basis that materials do not — a reader who cannot see that a
     carton is per RUN cannot check the number. */
  const packagingFacts = new Map((preview?.packaging || []).map((p) => [p.requirementKey, p]));
  const packaging = generated
    .filter((l) => l.category === "PACKAGING")
    .map((l) => {
      const fact = packagingFacts.get(l.technicalKey) || {};
      const gap = missing.find((m) => m.lineKey === l.lineKey);
      const fixed = l.behaviour === "FIXED_PER_RUN";
      return {
        lineKey: l.lineKey,
        description: l.label,
        specification: l.specification || null,
        quantity: (fixed ? l.quantityPerRun : l.quantityPerUnit) ?? null,
        unit: l.quantityUom || null,
        /* Said plainly rather than left to be inferred from a behaviour code
           the screen would have to translate. */
        basis: fixed ? "FIXED_PER_RUN" : "PER_GARMENT",
        basisLabel: fixed ? "for the run" : "per garment",
        owner: "R&D",
        source: "SampleStyle packaging requirement",
        evidence: l.technicalEvidence || null,
        quotation: l.supplierOfferId ? { offerId: l.supplierOfferId, state: "SELECTED" } : null,
        taxTreatment: l.tax?.treatment || null,
        /* ── MEASURED, OR ONLY PLANNED ──────────────────────────────────
           Shown, not inferred. A quantity specified for production and never
           demonstrated by a sample is a weaker claim than one measured off
           it, and it is the reason the row below can read PROVISIONAL with a
           perfectly good quotation behind it. */
        evidence: l.technicalEvidence || null,
        evidenceLabel: l.evidenceProvisional ? "Planned for production" : "Measured on the sample",
        state: gap
          ? "MISSING"
          : (l.supplierOfferId ? (l.evidenceProvisional ? "PROVISIONAL" : "VERIFIED") : "MISSING"),
        /* Whose gap it is — R&D's row or Store's quotation. */
        missingOwner: gap?.owner || null,
        note: gap?.message
          || (l.evidenceProvisional && l.supplierOfferId
            ? "The rate is quoted; the quantity was planned rather than measured on the sample."
            : null),
        itemInRegister: fact.itemInRegister ?? null,
      };
    });

  /* ── AND OUTSIDE SERVICES ──────────────────────────────────────────────
     Separately again: a different register behind it, a different desk when
     it is wrong, and a minimum charge that has no material equivalent. */
  const serviceFactsByKey = new Map((preview?.services || []).map((sv) => [sv.requirementKey, sv]));
  const services = generated
    .filter((l) => l.category === "SERVICE")
    .map((l) => {
      const fact = serviceFactsByKey.get(l.technicalKey) || {};
      const gap = missing.find((m) => m.lineKey === l.lineKey);
      const fixed = l.behaviour === "FIXED_PER_RUN";
      return {
        lineKey: l.lineKey,
        description: l.label,
        specification: l.specification || null,
        serviceCode: fact.serviceCode || null,
        quantity: (fixed ? l.quantityPerRun : l.quantityPerUnit) ?? null,
        unit: l.quantityUom || null,
        basis: fixed ? "FIXED_PER_RUN" : "PER_GARMENT",
        basisLabel: fixed ? "for the run" : "per garment",
        /* Which desk stated the requirement — R&D or Production. */
        owner: l.requirementOwner === "PRODUCTION" ? "Production" : "R&D",
        source: "SampleStyle service requirement",
        evidence: l.technicalEvidence || null,
        quotation: l.serviceOfferId ? { offerId: l.serviceOfferId, state: "SELECTED" } : null,
        taxTreatment: l.tax?.treatment || null,
        evidence: l.technicalEvidence || null,
        evidenceLabel: l.evidenceProvisional ? "Planned for production" : "Run on the sample",
        state: gap
          ? "MISSING"
          : (l.serviceOfferId ? (l.evidenceProvisional ? "PROVISIONAL" : "VERIFIED") : "MISSING"),
        missingOwner: gap?.owner || null,
        note: gap?.message
          || (l.evidenceProvisional && l.serviceOfferId
            ? "The rate is quoted; the quantity was planned rather than run on the sample."
            : null),
        serviceInRegister: fact.serviceInRegister ?? null,
      };
    });

  /* ── DEVELOPMENT AND TOOLING, AS ITS OWN GROUP ─────────────────────────
     Separately from outside services, because the two are the opposite kind
     of cost: one scales with the run and one dilutes across it. A reader who
     cannot see which is which cannot check either number. */
  const development = generated
    .filter((l) => l.category === "FIXED_SETUP" && l.developmentSource)
    .map((l) => {
      const fact = serviceFactsByKey.get(l.technicalKey) || {};
      const gap = missing.find((m) => m.lineKey === l.lineKey);
      const internal = l.developmentSource === "COMPANY_POLICY";
      return {
        lineKey: l.lineKey,
        description: l.label,
        specification: l.specification || null,
        /* Where the money comes from — a supplier who quoted, or a charge the
           company published. Never both. */
        sourceType: l.developmentSource,
        sourceLabel: internal ? "Company development charge" : "Supplier quotation",
        serviceCode: fact.serviceCode || null,
        chargeKey: l.developmentChargeKey || null,
        chargeLabel: l.developmentChargeLabel || null,
        quantity: l.quantityPerRun ?? null,
        unit: l.quantityUom || null,
        /* ── HOW THE TOTAL WAS ARRIVED AT ─────────────────────────────
           "₹8,000" is a figure a reader has to take on trust. "4 Screen at
           ₹2,000" is one they can check — and the difference matters most on
           exactly the line nobody typed. */
        calculation: l.policyProvenance?.calculation || null,
        unitAmountMinor: l.policyProvenance?.unitAmountMinor ?? null,
        /* One-time by definition — said plainly, because it is the whole
           difference between this family and outside services. */
        basis: "FIXED_PER_RUN",
        basisLabel: "for the run",
        /* The fixed total for the run, where a source produced one. The
           per-garment figure is the engine's, per scenario. */
        fixedTotalMinor: l.amount?.amountMinor ?? null,
        owner: internal ? "Finance" : (l.requirementOwner === "PRODUCTION" ? "Production" : "R&D"),
        source: internal ? "Company costing policy" : "SampleStyle development requirement",
        evidence: l.technicalEvidence || null,
        evidenceLabel: l.evidenceProvisional ? "Planned for production" : "Confirmed on the sample",
        quotation: l.serviceOfferId ? { offerId: l.serviceOfferId, state: "SELECTED" } : null,
        taxTreatment: l.tax?.treatment || null,
        state: gap
          ? "MISSING"
          : ((l.amount || l.serviceOfferId)
            ? (l.evidenceProvisional ? "PROVISIONAL" : "VERIFIED")
            : "MISSING"),
        missingOwner: gap?.owner || null,
        note: gap?.message
          || (l.evidenceProvisional && (l.amount || l.serviceOfferId)
            ? "The charge is authoritative; the requirement was planned rather than confirmed on the sample."
            : null),
      };
    });

  /* ── DELIVERING THE FINISHED ORDER ─────────────────────────────────────
     Its own group, because it is the only cost here that is about the ORDER
     rather than the garment: the lane, the carrier and the working that
     produced the figure. Read-only — there is no manual freight row to
     render, and a reader checking the number needs the lane to check it
     against. */
  const freightRows = generated
    .filter((l) => l.category === "FREIGHT")
    .map((l) => {
      const p = l.freightProvenance || {};
      const gap = missing.find((m) => m.lineKey === l.lineKey);
      const zero = p.state === "RECORDED_ZERO";
      return {
        lineKey: l.lineKey,
        description: l.label,
        arrangement: l.freightArrangement || p.arrangement || null,
        arrangementSource: l.freightArrangementSource || p.arrangementSource || null,
        origin: p.origin ? [p.origin.name, p.origin.city].filter(Boolean).join(" — ") : null,
        destination: p.destination ? p.destination.label || p.destination.city : null,
        mode: p.mode || null,
        supplierName: p.offer?.supplierName || null,
        quotationReference: p.offer?.quotationReference || null,
        basis: p.offer?.basis || null,
        basisLabel: zero ? "no company cost" : "for the run",
        /* The run total is per scenario; a preview has no run size, so the
           working is what it shows rather than one scenario's answer. */
        fixedTotalMinor: zero ? 0 : null,
        owner: "Sales, R&D and Store",
        source: zero
          ? `Delivery arrangement on the ${l.freightArrangementSource === "ACCOUNT" ? "customer's account" : "enquiry"}`
          : "Freight quotation register",
        taxTreatment: l.tax?.treatment || null,
        state: gap ? "MISSING" : (zero || p.offer ? "VERIFIED" : "MISSING"),
        missingOwner: gap?.owner || null,
        note: gap?.message
          || (zero ? "The customer bears the delivery, so the company carries no freight cost." : null),
      };
    });

  /* One entry per material, packaging row or service that still needs a
     supplier chosen. Both registers use the same decision shape, so the
     screen renders one control rather than two that drift apart. */
  const quotationDecisions = missing
    .filter((m) => (String(m.key || "").startsWith("quotation:")
      || String(m.key || "").startsWith("service-quotation:")
      || String(m.key || "").startsWith("freight-quotation:")) && m.lineKey)
    .map((m) => ({
      lineKey: m.lineKey,
      description: byKey.get(m.lineKey)?.label || m.lineKey,
      message: m.message,
      owner: m.owner || OWNER.STORE,
      candidates: m.candidates || [],
      excluded: m.excluded || [],
    }));

  return {
    state: assembled.state,
    styleId: assembled.styleId || null,
    style: preview?.style || null,
    candidates: assembled.candidates || [],
    rows: { materials, operations, packaging, services, development, freight: freightRows },
    quotationDecisions,
    missing,
    productionAssumptions: assembled.productionAssumptions || { configured: false, missing: [] },
    coverage: assembled.coverage || null,
    policy: assembled.policy || null,
    /* The raw technical read, kept for the panels that legitimately show what
       the record SAYS rather than what the costing will use. */
    technical: preview,
  };
}

module.exports = {
  /* `mergeOverrides` is not here: nothing produces an override to merge, and
     `refuseOverrides` is internal because no caller has a reason to ask. */
  assemble, assembleLines, presentAssembly, productionAssumptions,
  lineFromMaterial, lineFromOperation, lineFromPackaging, lineFromService,
  lineFromDevelopment, applyDevelopmentCharges, applyCustomsDuty, applyFreight, rupeesToMinor,
  /* Exported so the contingency contract's three-state reporting can be
     exercised directly: whether a company that DECIDED to add none still gets
     told its policy is unconfigured is a rule, and a rule reachable only
     through a whole assembled costing is a rule nobody checks. */
  policyMissing, policySection,
  STATE, OWNER,
};
