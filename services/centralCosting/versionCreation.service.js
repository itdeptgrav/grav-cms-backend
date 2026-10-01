// services/centralCosting/versionCreation.service.js
//
// Central Costing — Chunk 2. A NEW VERSION, NUMBERED SAFELY, POINTED AT SAFELY.
//
// ── THE THREE THINGS THAT CAN GO WRONG ──────────────────────────────────────
//
// 1. TWO VERSIONS WITH THE SAME NUMBER. "Read the maximum and add one" is a
//    read-then-write race: two requests both read 3, both write 4, and a
//    costing has two version 4s with different numbers in them. The unique
//    index `{companyId, costingId, versionNumber}` makes that IMPOSSIBLE
//    rather than unlikely — one insert loses — and the loser retries against
//    a freshly read maximum instead of failing the user.
//
// 2. THE PARENT POINTER GOING BACKWARDS. Two versions land, 4 then 5, and 4's
//    pointer update arrives last: the costing then says its current version is
//    4 while 5 exists. The update is therefore CONDITIONAL — it only moves the
//    pointer forward — so a late writer simply does not win.
//
// 3. A RETRY MAKING A SECOND VERSION. The same failure Chunk 1's hardening
//    closed for the parent costing, and closed the same way: a durable
//    creation claim written in the same insert as the version, defended by a
//    unique index, and looked up before creating rather than after.
//
// ── AND ONE THING THAT MUST NEVER HAPPEN ────────────────────────────────────
// A previous version being touched. Nothing in this file updates, replaces or
// deletes a version — the model refuses all three anyway — and a correction is
// version N+1 naming the one it supersedes.
"use strict";

const mongoose = require("mongoose");

const Costing = require("../../models/CMS_Models/Costing/Costing");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const CostingClaim = require("../../models/CMS_Models/Costing/CostingClaim");
const { transactionsAvailable } = require("../storePurchase/unitOfWork.service");
const { fail } = require("../storePurchase/errors");
const { calculate, ENGINE_VERSION, CALCULATION_SCHEMA_VERSION, CostingEngineError } = require("./engine");
const policyService = require("./policy.service");
/* The Board's overhead rule, for the provenance a version freezes. */
const overheadPolicy = require("./overheadPolicy.service");
/* The Board's labour methodology, and the arithmetic it feeds. */
const labourPolicy = require("./labourPolicy.service");
const gstPolicy = require("./gstPolicy.service");
const developmentChargePolicy = require("./developmentChargePolicy.service");
const contingencyPolicy = require("./contingencyPolicy.service");
const marginPolicy = require("./marginPolicy.service");
const labourCost = require("./labourCost");
const technicalPreview = require("./technicalPreview.service");
const technicalBinding = require("./technicalBinding.service");
const profitBridge = require("./profitBridge");
const costCoverage = require("./costCoverage");
const technicalSource = require("./technicalSource.service");
const offerPricing = require("./offerPricing.service");
const servicePricing = require("./servicePricing.service");

/** How many times a lost numbering race is retried before giving up. */
const NUMBERING_ATTEMPTS = 5;

/** Was this insert refused by a specific unique index? */
function violated(err, path) {
  if (err?.code !== 11000) return false;
  const keys = Object.keys(err.keyPattern || err.keyValue || {});
  return keys.some((k) => k === path || k.endsWith(path));
}

/**
 * Run the engine and turn its output into a version document body.
 *
 * Separated from the write so the whole calculation can be exercised — and
 * refused — without a database in sight.
 */
/* ══ PRICING QUOTATION-BACKED LINES BEFORE THE ENGINE RUNS ═══════════════════
 *
 * Chunk 3.2. A line that names a `supplierOfferId` arrives with no rate — the
 * server derives one from the Store register and hands the engine an ordinary
 * `unitRate`. The engine is unchanged and knows nothing about offers: it takes
 * rates and produces costs, which is the contract every other line already
 * uses.
 *
 * ── AND THE PROVENANCE IS FROZEN BESIDE IT ──────────────────────────────────
 * Whatever Store does to that quotation afterwards — revise it, withdraw it,
 * let it expire — this version keeps saying which one produced its rate, at
 * what tier, through what conversion. It is a snapshot, not a reference.
 */
/**
 * Price every quotation-backed SERVICE line, per scenario.
 *
 * The same shape as `priceQuotationLines` and deliberately separate: a service
 * is priced from a different register, in a unit that has no conversion, with
 * a minimum charge a material has not got. Folding the two into one function
 * would mean a chain of conditionals on every line of it.
 */
async function priceServiceLines(ctx, input, { policy, asOf = new Date() }) {
  const quoted = (input.lines || []).filter((l) => l.serviceOfferId);
  if (!quoted.length) return { lines: input.lines, provenance: [], warnings: [] };

  const scenarioQuantities = (input.scenarios || [])
    .map((s_) => ({ key: s_.key, quantity: Number(s_.quantity) }))
    .filter((s_) => s_.key && Number.isFinite(s_.quantity) && s_.quantity > 0);

  const provenance = [];
  const warnings = [];
  const byKey = new Map();

  for (const line of quoted) {
    const resolved = await servicePricing.resolveServiceRate(ctx, {
      serviceOfferId: line.serviceOfferId,
      serviceId: line.serviceId,
      requestedUnit: line.serviceUnit || line.quantityUom,
      basis: line.behaviour === "FIXED_PER_RUN" ? "FIXED_PER_RUN" : "PER_GARMENT",
      quantityPerUnit: line.quantityPerUnit,
      quantityPerRun: line.quantityPerRun,
      evidence: line.technicalEvidence || null,
      scenarioQuantities,
      asOf,
      costingCurrency: policy.baseCurrency,
      roundingMode: policy.roundingMode,
      taxTreatment: line.tax?.treatment,
    });
    byKey.set(line.lineKey, resolved);
    provenance.push({ lineKey: line.lineKey, ...resolved.provenance });
    for (const w of resolved.warnings) warnings.push({ ...w, lineKeys: [line.lineKey] });
  }

  const lines = (input.lines || []).map((l) => {
    const hit = byKey.get(l.lineKey);
    if (!hit) return l;
    return {
      ...l,
      ...(hit.fixedAmountMinor !== undefined
        ? { amount: { amountMinor: hit.fixedAmountMinor, currency: hit.currency } }
        : {
          unitRate: { amountMinor: hit.rateMinor, currency: hit.currency },
          ...(hit.ratesByScenario ? { unitRateByScenario: hit.ratesByScenario } : {}),
        }),
      /* Not provisional — unless the QUANTITY was only planned. A dated
         quotation multiplied by a figure no sample demonstrated is not a
         verified line; see the material pass above. */
      confidence: l.evidenceProvisional ? "PROVISIONAL" : "SUPPLIER_QUOTATION",
      tax: hit.tax,
    };
  });

  return { lines, provenance, warnings };
}

async function priceQuotationLines(ctx, input, { policy, asOf = new Date() }) {
  const quoted = (input.lines || []).filter((l) => l.supplierOfferId);
  if (!quoted.length) return { lines: input.lines, provenance: [], warnings: [] };

  /* ── KEYED, NOT ORDERED (Chunk 5A) ────────────────────────────────────
     Each scenario gets its own rate now, so the rate has to come back keyed
     to the scenario it belongs to. An index would silently mis-assign the
     moment scenarios were reordered. */
  const scenarioQuantities = (input.scenarios || [])
    .map((s) => ({ key: s.key, quantity: Number(s.quantity) }))
    .filter((s) => s.key && Number.isFinite(s.quantity) && s.quantity > 0);

  const provenance = [];
  const warnings = [];
  const byKey = new Map();

  for (const line of quoted) {
    const resolved = await offerPricing.resolveLineRate(ctx, {
      supplierOfferId: line.supplierOfferId,
      itemId: line.itemId,
      variantId: line.variantId || null,
      consumptionUom: line.consumptionUom,
      /* The line's own shape and consumption — the supplier quantity, and
         therefore the tier, cannot be worked out without them. */
      category: line.category,
      behaviour: line.behaviour,
      quantityPerUnit: line.quantityPerUnit,
      /* A fixed packaging line quotes the RUN's quantity, not the piece's —
         see `offerPricing.assertEligible`. Carried through so the two cannot
         disagree about which field holds the number. */
      quantityPerRun: line.quantityPerRun,
      /* How many garments one carton holds, for a PER_CARTON line. Read
         SERVER-SIDE off the style's shipment record and carried on the line
         by the assembly — never from the request, where a supplied carton
         count would change the money. */
      garmentsPerCarton: line.garmentsPerCarton,
      evidence: line.technicalEvidence || null,
      scenarioQuantities,
      asOf,
      costingCurrency: policy.baseCurrency,
      roundingMode: policy.roundingMode,
      /* Only the RECOVERABILITY comes from the line — whether the company gets
         this GST back is a Finance decision the quotation cannot state. The
         RATE is taken from the offer and the line's is discarded. */
      taxTreatment: line.tax?.treatment,
    });

    byKey.set(line.lineKey, resolved);
    provenance.push({ lineKey: line.lineKey, ...resolved.provenance });
    for (const w of resolved.warnings) {
      warnings.push({ ...w, lineKeys: [line.lineKey] });
    }
  }

  const lines = (input.lines || []).map((l) => {
    const hit = byKey.get(l.lineKey);
    if (!hit) return l;
    return {
      ...l,
      /* The engine's ordinary shape, and — where the quotation's tiers make
         the rate depend on the run size — one rate per scenario beside it.
         `unitRate` stays as the fallback and as what every version written
         before Chunk 5A means, so nothing already stored changes. */
      /* ── A FIXED LINE CARRIES A TOTAL, AND NO RATE ────────────────────
         The engine reads `amount` for FIXED_PER_RUN and `unitRate` for
         PER_UNIT. Sending both would leave two numbers for one line and the
         parser choosing between them. */
      ...(hit.fixedAmountMinor !== undefined
        ? {
          amount: { amountMinor: hit.fixedAmountMinor, currency: hit.currency },
          /* A carton line's total steps with the run size, so each scenario
             carries its own. The engine reads this in preference to the
             single `amount` above, which is only the primary scenario's. */
          ...(hit.amountsByScenario ? { amountByScenario: hit.amountsByScenario } : {}),
        }
        : {
          unitRate: { amountMinor: hit.rateMinor, currency: hit.currency },
          ...(hit.ratesByScenario ? { unitRateByScenario: hit.ratesByScenario } : {}),
        }),
      /* ── A QUOTATION-BACKED LINE IS NOT PROVISIONAL ────────────────────
         The parser marks every client-supplied line PROVISIONAL because a
         typed rate is somebody's recollection. This rate was not typed: the
         server read it from a dated, referenced quotation. Labelling it
         provisional would make the reliable path look exactly like the
         unreliable one, which is the whole distinction this chunk exists to
         draw.

         ── UNLESS THE QUANTITY WAS ONLY PLANNED ─────────────────────────
         A line is as good as its weaker half. A verified rate multiplied by
         a quantity nobody demonstrated on a sample is not a verified line,
         and calling it one would hide exactly the difference the evidence
         field exists to record. */
      confidence: l.evidenceProvisional ? "PROVISIONAL" : "SUPPLIER_QUOTATION",
      quantityUom: l.consumptionUom || l.quantityUom,
      /* ── THE TAX POSITION IS THE SERVER'S, NOT THE REQUEST'S ──────────
         Whatever rate the browser sent is replaced by the quotation's own,
         with the treatment the line stated. A submitted rate is a number
         nobody quoted, and the engine would otherwise cost — or exempt — the
         line by it and freeze the result as evidence. */
      tax: hit.tax,
    };
  });

  return { lines, provenance, warnings };
}

/**
 * Freeze what the technical record said, for the lines that came from it.
 *
 * ── ONE REFERENCE PER IMPORTED LINE, PLUS ONE FOR THE STYLE ────────────────
 * The style reference carries the identity and both approval gates — which
 * round of the BOM sign-off, which sample round, and when each was decided —
 * because "imported from style SC-J14-02" without those is a pointer, not
 * evidence. Each line then carries what ITS row said: the quantity, unit and
 * allowance actually used, and whether that came from the planned pick or the
 * approved sample.
 *
 * A line whose key no longer matches anything on the style is frozen as such
 * rather than dropped: the version must be able to say that it imported a row
 * the style has since removed.
 */
function freezeTechnicalSource(input, preview, styleId) {
  const claiming = (input.lines || []).filter((l) => l.technicalKey);
  /* ── THE SAME READ THE LINES WERE BOUND AGAINST ───────────────────────
     Handed in rather than fetched again. A second read could return a source
     that changed in between, and the version would then be CALCULATED from
     one answer and PROVENANCED with another — which is the exact defect the
     binding step exists to close, reintroduced two lines later. */
  if (!styleId || !claiming.length || !preview) return { sourceReferences: [] };

  const materials = new Map(preview.materials.map((m) => [m.sourceKey, m]));
  const operations = new Map(preview.operations.map((o) => [o.sourceKey, o]));
  const { style, approval } = preview;

  const fact = (key, value, kind = "text") => {
    if (value === null || value === undefined || value === "") return null;
    if (kind === "num") return Number.isFinite(Number(value)) ? { key, num: Number(value) } : null;
    return { key, text: String(value).slice(0, 300) };
  };
  const facts = (list) => list.filter(Boolean).slice(0, 40);

  const refs = [{
    sourceType: "BOM",
    sourceId: style.styleId,
    sourceKey: style.sampleStyleId || style.styleCode || undefined,
    label: [style.styleCode || style.sampleStyleId, style.productName, style.variantLabel]
      .filter(Boolean).join(" — ").slice(0, 300),
    /* VERIFIED only where a gate actually signed the technical data off.
       Everything else is provisional, and says so. */
    confidence: approval.sample.approved || approval.bom.approved ? "VERIFIED" : "PROVISIONAL",
    capturedAt: preview.capturedAt,
    snapshot: facts([
      fact("styleCode", style.styleCode),
      fact("sampleStyleId", style.sampleStyleId),
      fact("productName", style.productName),
      fact("variantLabel", style.variantLabel),
      fact("ownershipProof", style.ownershipProof),
      fact("bomApprovalStatus", approval.bom.status),
      fact("bomApprovalRound", approval.bom.round, "num"),
      fact("bomApprovalDecidedAt", approval.bom.decidedAt && new Date(approval.bom.decidedAt).toISOString()),
      fact("bomApprovalDecidedBy", approval.bom.decidedByName),
      fact("techSheetStatus", approval.techSheet.status),
      fact("sampleStatus", approval.sample.status),
      fact("sampleRoundCount", approval.sample.roundCount, "num"),
      fact("sampleRoundNo", approval.sample.latestRound?.roundNo, "num"),
      fact("sampleRoundType", approval.sample.latestRound?.type),
      fact("sampleApprovedAt", approval.sample.approvedAt && new Date(approval.sample.approvedAt).toISOString()),
      fact("capturedAt", new Date(preview.capturedAt).toISOString()),
    ]),
  }];

  for (const line of claiming) {
    const m = materials.get(line.technicalKey);
    if (m) {
      refs.push({
        sourceType: "BOM",
        sourceId: m.rawItemId || undefined,
        sourceKey: line.lineKey,
        label: [m.rawItemName, m.variantLabel].filter(Boolean).join(" — ").slice(0, 300),
        confidence: m.basis === technicalSource.BASIS.CONFIRMED
          || (m.chosenFrom === "SAMPLE_MEASURED" && approval.sample.approved)
          ? "VERIFIED" : "PROVISIONAL",
        capturedAt: preview.capturedAt,
        snapshot: facts([
          fact("technicalKey", m.sourceKey),
          fact("itemName", m.rawItemName),
          fact("itemSku", m.rawItemSku),
          fact("variantLabel", m.variantLabel),
          fact("quantity", m.quantity, "num"),
          fact("unit", m.unit),
          /* Which of the two pieces of evidence priced this line. */
          fact("evidence", m.chosenFrom),
          fact("quantityBasis", m.basis),

          /* ── THE PRICED QUANTITY, REPRODUCIBLE ────────────────────────
             This recorded `m.measured?.allowancePercent` and an
             `allowanceInQuantity` derived from the evidence being
             SAMPLE_MEASURED. Both were about the legacy path only: an
             ENGINEERED row carrying a real 5% allowance froze the allowance
             as absent and the flag as "none recorded", which was false, and
             left a reader unable to tell whether the quantity beside it had
             the allowance in it.

             All four facts are frozen now, from the chosen row, so the priced
             quantity can be reproduced without guessing:

               base x (1 + allowance/100) = effective, unless already included
               effective x run quantity   = what is bought

             `allowanceInQuantity` keeps three answers, not two: `yes` for a
             legacy row where R&D typed the consumed amount, `no` where the
             allowance was applied here, and `none recorded` where R&D left it
             blank — which `materialGaps` treats as a legitimate answer. An
             explicit 0% is a fourth thing again, and reads as `0`. */
          fact("baseConsumptionPerPiece", m.consumptionPerPiece ?? m.quantity, "num"),
          fact("allowancePercent", m.allowancePercent, "num"),
          fact("allowanceInQuantity", m.allowanceAlreadyInQuantity === true
            ? "yes"
            : (m.allowancePercent === null || m.allowancePercent === undefined
              ? "none recorded" : "no")),
          fact("effectiveConsumptionPerPiece",
            m.effectiveConsumptionPerPiece ?? m.effectiveQuantity ?? m.quantity, "num"),

          fact("plannedQuantity", m.planned?.quantity, "num"),
          fact("measuredQuantity", m.measured?.quantity, "num"),
        ]),
      });
      continue;
    }
    const o = operations.get(line.technicalKey);
    if (o) {
      refs.push({
        sourceType: "OPERATION",
        sourceKey: line.lineKey,
        label: [o.name, o.operationCode].filter(Boolean).join(" — ").slice(0, 300),
        confidence: approval.sample.approved ? "VERIFIED" : "PROVISIONAL",
        capturedAt: preview.capturedAt,
        snapshot: facts([
          fact("technicalKey", o.sourceKey),
          fact("operationCode", o.operationCode),
          fact("operationName", o.name),
          fact("machine", o.machine || o.machineType),
          fact("samMinutes", o.samMinutes, "num"),
          fact("totalSeconds", o.totalSeconds, "num"),
          fact("rateBasis", o.rateBasis),
          fact("operatorSalary", o.operatorSalary, "num"),
          fact("operatorCost", o.operatorCost, "num"),
          fact("costBasis", o.costBasis),
        ]),
      });
      continue;
    }
    /* ── UNREACHABLE, AND DELIBERATELY KEPT ───────────────────────────
       `bindTechnicalLines` refuses a line whose row the record no longer
       carries, so nothing gets here. It stays because the alternative — a
       silent `continue` — would mean a future change to the binding rules
       could start dropping references without anything saying so. */
    refs.push({
      sourceType: "BOM",
      sourceKey: line.lineKey,
      label: (line.label || line.lineKey).slice(0, 300),
      confidence: "PROVISIONAL",
      capturedAt: preview.capturedAt,
      snapshot: facts([
        fact("technicalKey", line.technicalKey),
        fact("status", "The technical record no longer carries this row."),
      ]),
    });
  }


  return { sourceReferences: refs };
}

/**
 * The unresolved groups somebody decided do not apply here.
 *
 * ── INDEPENDENT OF THE IMPORT, DELIBERATELY ────────────────────────────────
 * The groups are a fixed vocabulary — outside services, embellishment,
 * packaging, development — not something a style derives. A costing that
 * imported nothing still has packaging to answer for, and gating this behind a
 * technical import would leave the only honest answer unavailable to exactly
 * the costings that most need it. It lived inside `freezeTechnicalSource`,
 * which returns early when nothing was imported, so those decisions were
 * silently dropped.
 *
 * Frozen as decisions, with who said why. A missing cost that becomes a zero
 * because a panel was dismissed is the failure this prevents; one that becomes
 * a zero because somebody wrote down a reason is a judgement anybody can later
 * read and disagree with.
 */
/* ── `freezeOverrides` IS GONE ──────────────────────────────────────────────
 *
 * It froze each hand-entered figure as a `MANUAL_ENTRY` source reference —
 * the line it answered, the cost family, the reason, and the actor and time
 * stamped from the SESSION rather than parsed, because an actor a client
 * could name is an actor a client could name as somebody else. Always
 * `PROVISIONAL`, and deliberately never `SUPPLIER_QUOTATION` or `VERIFIED`.
 *
 * That contract did its job: a reader of one of these versions can still see
 * exactly who typed what and why, and those references are untouched. What
 * changed is that no new one can be produced — an override is refused at the
 * request contract and again at the assembly — so the freezer had nothing
 * left to freeze.
 *
 * Deleted rather than left calling `.filter(l => l.override)` over an array
 * that can no longer contain one: a writer standing ready for input nothing
 * can supply is an invitation to supply it.
 */

/**
 * THE APPLICABILITY DECISIONS THIS VERSION WAS COSTED UNDER, FROZEN.
 *
 * ── WHAT THIS REPLACED ──────────────────────────────────────────────────────
 * `freezeAcknowledgements` — the same job for the decisions the BROWSER sent,
 * frozen as `MANUAL_ENTRY` source references with `PROVISIONAL` confidence,
 * which is exactly what they were: somebody in Costing writing down a reason
 * on another department's behalf.
 *
 * These are read from that department's record, so they freeze as what they
 * are — a decision, taken in a named system, by a named person, on a date.
 * `sourceKey` still begins `not-applicable:` so a reader of an old version and
 * a reader of a new one recognise the same kind of fact.
 *
 * Historical `MANUAL_ENTRY` acknowledgements on versions frozen before this
 * are untouched and go on rendering with their actor, timestamp and reason.
 */
function freezeApplicabilityDecisions(sourceDecisions) {
  const capturedAt = new Date();
  return Object.values(sourceDecisions || {}).filter(Boolean).map((d) => ({
    /* Not MANUAL_ENTRY: nobody typed this into a costing. It came from a
       departmental record, and the reference says which. */
    sourceType: "DEPARTMENT_DECISION",
    sourceKey: `not-applicable:${d.key}`,
    label: `Does not apply — ${d.basis || d.key}`.slice(0, 300),
    /* Still their judgement rather than a measured fact — but a judgement
       made by the desk that owns it, which is the whole change. */
    confidence: "PROVISIONAL",
    capturedAt,
    snapshot: [
      { key: "family", text: d.key },
      { key: "decision", text: "NOT_APPLICABLE" },
      { key: "reason", text: String(d.reason || "").slice(0, 300) },
      { key: "decidedBy", text: String(d.decidedByName || "").slice(0, 120) },
      { key: "department", text: String(d.ownerDepartment || "").slice(0, 120) },
      { key: "recordedIn", text: String(d.recordedIn || "").slice(0, 200) },
    ].filter((f) => f.text),
  }));
}

/**
 * The proposed prices, the tax assumption, and what they imply.
 *
 * ── ESTIMATES, AND SAID TO BE ──────────────────────────────────────────────
 * Every number here rests on two assumptions the company made: that the cost
 * build-up is complete, and that its estimated effective income-tax rate is
 * about right. Neither is a fact about this order, and the block records which
 * is which so no screen has to guess.
 */
function buildCommercial({ input, calculated, policy, snapshot }) {
  const priced = input.scenarios.filter((s) => s.proposedSellingPriceExclTax);
  const rate = snapshot.estimatedIncomeTaxRatePercent;
  /* Nothing proposed and no rate configured: no commercial block at all,
     rather than an empty one that reads as a considered blank. */
  if (!priced.length && !rate) return undefined;

  const priceByKey = {};
  for (const s of priced) priceByKey[s.key] = s.proposedSellingPriceExclTax.amountMinor;

  return {
    currency: policy.baseCurrency,
    /* From the SNAPSHOT, not the live policy — the two are the same object
       here, and taking it from the snapshot is what makes that true later
       as well. */
    estimatedIncomeTaxRatePercent: rate ?? undefined,
    incomeTaxRateSource: rate ? "COMPANY_COSTING_POLICY" : undefined,
    capturedAt: new Date(),
    proposedPrices: priced.map((s) => ({
      scenarioKey: s.key,
      /* Excluding GST. Tax collected from a customer is not revenue. */
      priceExclTaxMinor: s.proposedSellingPriceExclTax.amountMinor,
      currency: s.proposedSellingPriceExclTax.currency,
    })),
    /* ── JUDGED AGAINST THE FLOOR, WHICH EACH SCENARIO CARRIES ────────
       The band names are still passed for a historical scenario that has no
       floor; a scenario WITH one is measured against its own published floor
       and never against a band. See `profitBridge.bridgeFor`. */
    bridge: profitBridge.bridgeAll(calculated.scenarios, priceByKey, {
      minimumMarginPercent: policy.minimumMarginPercent,
      targetMarginPercent: policy.targetMarginPercent,
      estimatedIncomeTaxRatePercent: rate,
    }, { roundingMode: policy.roundingMode })
      /* A scenario nobody priced contributes no row. Its absence is the
         answer; a row of nulls would be a claim about a decision nobody made. */
      .filter((b) => b.available)
      .map((b) => ({
        scenarioKey: b.scenarioKey,
        proposedPriceExclTaxMinor: b.proposedPriceMinor,
        proposedRevenueTotalMinor: b.proposedRevenueTotalMinor,
        unitCostMinor: b.unitCostMinor,
        totalCostMinor: b.totalCostMinor,
        preTaxProfitUnitMinor: b.preTaxProfitUnitMinor,
        preTaxProfitTotalMinor: b.preTaxProfitTotalMinor,
        markupPercent: b.markupPercent ?? undefined,
        marginPercent: b.marginPercent ?? undefined,
        floorPriceMinor: b.floorPriceMinor ?? null,
        standing: b.standing,
        estimatedIncomeTaxUnitMinor: b.estimatedIncomeTaxUnitMinor ?? undefined,
        estimatedIncomeTaxTotalMinor: b.estimatedIncomeTaxTotalMinor ?? undefined,
        afterTaxProfitUnitMinor: b.afterTaxProfitUnitMinor ?? undefined,
        afterTaxProfitTotalMinor: b.afterTaxProfitTotalMinor ?? undefined,
      })),
  };
}

/**
 * The frozen coverage assessment.
 *
 * ── ASSESSED AGAINST THE PRIMARY SCENARIO ──────────────────────────────────
 * Which families are answered does not vary by quantity — only the amounts do,
 * and a family costed at 500 pieces is costed at 2,000. The primary scenario's
 * subtotals are the ones the states are read from, and the panel shows the
 * amounts for whichever scenario the reader is looking at.
 *
 * The ACTOR on a not-applicable decision is stamped from the request, never
 * from the body: a justification attributed to somebody who did not make it is
 * worse than an unattributed one.
 */
function buildCompleteness({ calculated, snapshot, sourceDecisions = {} }) {
  const primary = calculated.scenarios.find((s) => s.isPrimary) || calculated.scenarios[0];
  if (!primary) return undefined;

  const at = new Date();
  /* ── THE SIGNATURE IS THEIRS, NOT THE CALCULATOR'S ────────────────────
     This used to stamp `ctx.actorId` and `ctx.actorAt` onto every decision:
     whoever pressed Calculate became the author of every exclusion on the
     version. The decision now carries the actor who actually made it, in the
     app that owns it, on the day they made it — so a version frozen months
     later still names the right person and the right date. */
  const assessed = costCoverage.assess({
    scenario: primary,
    policySnapshot: snapshot,
    sourceDecisions,
    warnings: calculated.warnings,
  });

  return {
    scenarioKey: assessed.scenarioKey,
    costComplete: assessed.costComplete,
    assessedAt: at,
    coverageSchemaVersion: 1,
    families: assessed.families.map((f) => {
      const decided = sourceDecisions?.[f.key] || null;
      return {
        key: f.key,
        label: f.label,
        state: f.state,
        /* Omitted where there is no amount, rather than stored as zero. */
        ...(f.totalMinor === null || f.totalMinor === undefined ? {} : { totalMinor: f.totalMinor }),
        ...(f.perUnitMinor === null || f.perUnitMinor === undefined ? {} : { perUnitMinor: f.perUnitMinor }),
        /* What kind of answer this family takes, and whose it is — so the
           screen offers the fix that fits rather than a blank box. */
        ...(f.authority ? { authority: f.authority } : {}),
        ...(f.owner?.department ? { ownerDepartment: f.owner.department } : {}),
        ...(f.owner?.system ? { ownerSystem: f.owner.system } : {}),
        ...(f.basis ? { basis: f.basis } : {}),
        ...(f.reason ? { reason: f.reason } : {}),
        ...(f.state === costCoverage.STATE.NOT_APPLICABLE && decided ? {
          decidedByActorId: decided.decidedByActorId || undefined,
          decidedByName: decided.decidedByName || undefined,
          /* Which department, and which of their records. A reason on its own
             has to be taken on trust; a named record can be checked. */
          decidedByDepartment: decided.ownerDepartment || undefined,
          decidedIn: decided.recordedIn || undefined,
          /* The date the department decided, not the date this was costed.
             Falling back to `at` would date a decision to whenever somebody
             happened to press Calculate. */
          decidedAt: decided.decidedAt || undefined,
        } : {}),
      };
    }),
  };
}

/**
 * The freight working, flattened for the record.
 *
 * ── IDENTITIES AND SNAPSHOTS, BOTH ──────────────────────────────────────────
 * The id so the warehouse, address, transporter and quotation can be found
 * again; the words so the line stays readable when a warehouse is renamed or
 * an address is edited. A version that carried only ids would be a version
 * nobody could read; one that carried only names would be one nobody could
 * verify.
 */
function freezeFreight(line) {
  const p = line.freightProvenance || {};
  const offer = p.offer || {};
  return {
    lineKey: line.lineKey,
    state: p.state,
    arrangement: p.arrangement || null,
    arrangementSource: p.arrangementSource || null,
    prepaidTreatment: p.prepaidTreatment || null,
    recovery: p.recovery || null,
    recoveryMarkup: p.recoveryMarkup || null,
    enquiryRef: p.enquiryRef || "",

    originWarehouseId: p.origin?.warehouseId || null,
    originName: p.origin?.name || "",
    originCity: p.origin?.city || "",
    destinationAddressId: p.destination?.addressId || null,
    destinationLabel: p.destination?.label || "",
    destinationCity: p.destination?.city || "",
    destinationRegion: p.destination?.region || "",
    destinationCountry: p.destination?.country || "",
    mode: p.mode || null,

    supplierId: offer.supplierId || null,
    supplierName: offer.supplierName || "",
    offerId: offer.offerId || null,
    offerRevision: offer.revision ?? null,
    quotationReference: offer.quotationReference || "",
    quotationDate: offer.quotationDate || null,
    effectiveFrom: offer.effectiveFrom || null,
    validUntil: offer.validUntil || null,

    basis: offer.basis || null,
    rateMinor: offer.rateMinor ?? null,
    currency: offer.currency || null,
    minimumChargeMinor: offer.minimumChargeMinor ?? null,
    taxTreatment: line.tax?.treatment || null,
    gstRatePercent: offer.gstRatePercent ?? null,
    sacCode: offer.sacCode || null,

    packedWeightGrams: p.shipment?.packedWeightGrams ?? null,
    garmentsPerCarton: p.shipment?.garmentsPerCarton ?? null,
    deliveryCount: p.deliveryCount ?? null,

    scenarios: Object.values(p.scenarios || {}).map((sc) => ({
      scenarioKey: sc.scenarioKey,
      quantity: sc.quantity,
      chargeableUnit: sc.chargeableUnit,
      /* The number the rate was multiplied by — kilograms, or cartons. */
      chargeable: sc.working?.chargeableKg || sc.working?.cartons || sc.working?.consignments || null,
      working: sc.working,
      beforeMinimumMinor: sc.beforeMinimumMinor ?? null,
      minimumChargeApplied: Boolean(sc.minimumChargeApplied),
      freightMinor: sc.freightMinor ?? null,
    })),
    asOf: p.asOf || null,
  };
}

/**
 * Every operation's labour working, off the lines being frozen.
 *
 * ── WHY THIS HAS TO BE ON THE VERSION ───────────────────────────────────────
 * The assembly has always computed these and the preview has always shown
 * them; no version has ever kept one. So "₹3.54 for this operation" could only
 * be checked by re-reading the sample, the operation master and the policy —
 * and once any of the three had moved, not at all.
 *
 * Read off the lines rather than recomputed, for the same reason every other
 * provenance block is: a second calculation is a second answer.
 */
function operationWorkings(lines = []) {
  const out = (lines || [])
    .filter((l) => l.category === "OPERATION" && l.labourWorkings)
    .map((l) => ({
      lineKey: l.lineKey,
      label: l.label || "",
      samMinutes: l.labourWorkings.samMinutes ?? null,
      netSalaryPerMonth: l.labourWorkings.netSalaryPerMonth ?? null,
      employerCostPerMonth: l.labourWorkings.employerCostPerMonth ?? null,
      productiveMinutesPerMonth: l.labourWorkings.productiveMinutesPerMonth ?? null,
      productiveBasisLabel: l.labourWorkings.productiveBasisLabel || "",
      costPerMinute: l.labourWorkings.costPerMinute ?? null,
      amountMinor: l.unitRate?.amountMinor ?? null,
    }));
  return out.length ? out : undefined;
}

function buildVersionBody({ ctx, costing, input, policyBundle, meta }) {
  const snapshot = policyService.snapshotOf(policyBundle);

  let calculated;
  try {
    calculated = calculate({
      lines: input.lines,
      /* ── THE ENGINE NEVER SEES A PROPOSED PRICE (Chunk 4B) ────────────
         Stripped here rather than trusted to be ignored. Cost answers what
         the product is estimated to cost; a selling price is a commercial
         decision taken afterwards, and the one guarantee that keeps the two
         honest is that no cost figure can move when a price changes. Passing
         it in and relying on the engine not to read it would make that
         guarantee a convention instead of a fact. */
      scenarios: input.scenarios.map(({ proposedSellingPriceExclTax, ...s }) => s),
      policy: policyBundle.policy,
    });
  } catch (err) {
    if (err instanceof CostingEngineError) {
      /* The engine's refusals are the caller's to fix — a missing rate, a
         circular basis, a duplicate key — so they surface as validation
         rather than as a server fault. `details` carries the machine reason
         and, for incomplete inputs, EVERY missing line at once. */
      throw fail("VALIDATION", err.message, err.details);
    }
    throw err;
  }

  return {
    body: {
      companyId: ctx.companyId,
      costingId: costing._id,
      status: "DRAFT",
      baseCurrency: calculated.currency,
      calculationSchemaVersion: CALCULATION_SCHEMA_VERSION,
      provenance: {
        origin: meta.origin || "MANUAL",
        createdByActorId: ctx.actorId,
        createdByActorName: ctx.actorName || "",
        createdAt: new Date(),
        requestId: meta.requestId || "",
        idempotencyKey: meta.idempotencyKey || "",
        supersedesVersionNumber: null, // filled in once the number is known
        note: input.note || "",
        ...(meta.claim?.claimId
          ? {
              creationClaimId: meta.claim.claimId,
              creationRequestHash: meta.claim.requestHash || "",
              creationClaimTarget: meta.claim.target || "",
            }
          : {}),
        ...(meta.legacyImportKey ? { legacyImportKey: meta.legacyImportKey } : {}),
        /* ── WHAT THIS WAS CALCULATED FROM, AS ONE COMPARABLE VALUE ────
           Frozen here rather than derived on read, because "have the inputs
           changed since?" needs what they WERE, and nothing else remembers.
           Absent on versions made before this existed, and on the legacy
           importer, which builds from a sheet rather than from sources. */
        ...(meta.sourceFingerprint?.hash
          ? {
            sourceFingerprint: meta.sourceFingerprint.hash,
            sourceFingerprintParts: meta.sourceFingerprint.parts || [],
          }
          : {}),
      },
      sourceReferences: meta.sourceReferences || [],
      inputs: input.lines,
      /* ── FROZEN COMMERCIAL EVIDENCE (Chunk 3.2) ────────────────────────
         One entry per quotation-backed line. A later revision of the offer
         affects only a later version; this one keeps saying what it used. */
      ...(meta.offerProvenance?.length ? { offerProvenance: meta.offerProvenance } : {}),
      /* ── AND FROZEN POLICY EVIDENCE ────────────────────────────────────
         One entry per line priced from the company's own development charge
         table. Kept apart from the quotations because it claims something
         different: no supplier, no reference, no tier — a charge Finance
         published, and the window it was in force for. */
      ...(meta.policyProvenance?.length ? { policyProvenance: meta.policyProvenance } : {}),
      ...(meta.freightProvenance ? { freightProvenance: meta.freightProvenance } : {}),
      ...(meta.financingProvenance ? { financingProvenance: meta.financingProvenance } : {}),
      /* ── OVERHEAD, WITH WHAT IT WAS A PERCENTAGE OF ────────────────
         Frozen only where the Board's rule actually produced a line. The
         per-scenario amounts come off the engine's own result — read, never
         recomputed — so the figure on the record is the figure that was
         calculated. */
      /* ── THE LABOUR METHODOLOGY, AND EVERY OPERATION'S WORKING ─────
         Frozen only where the Board's rule actually produced rates. The
         per-operation workings come off the lines the engine was handed —
         read, never recomputed — so what is on the record is what was
         calculated. */
      ...(meta.gstResolved && meta.gstResolved.state === gstPolicy.STATE.APPLIED
        ? { gstProvenance: gstPolicy.freeze({ resolved: meta.gstResolved, asOf: meta.asOf || new Date() }) }
        : {}),
      /* ── AND THE BAND THE PRICE BREAKS WERE SOLVED FROM ──────────────
         The band VALUES are already in `policySnapshot` and are what the
         engine used. What no version could say is which approved decision they
         came from. Frozen only where a band actually applied — with none, no
         version exists at all, because the guard above refused it. */
      ...(meta.marginResolved && meta.marginResolved.state === marginPolicy.STATE.APPLIED
        ? { marginProvenance: marginPolicy.freeze({ resolved: meta.marginResolved, asOf: meta.asOf || new Date() }) }
        : {}),
      /* ── AND WHETHER A STANDARD CONTINGENCY WAS ADDED ────────────────
         Frozen for a `DECIDED_NONE` decision as well as an `APPLIED` one —
         the only provenance block here that records the absence of a cost.
         A version with no contingency line cannot otherwise say whether the
         company decided against one or nobody had asked, and those are
         different things to be reading a year later.

         Not frozen when NO policy is in force: there is no decision to
         record, and a block saying "state: POLICY_MISSING" on every version
         of every company that has not reached this migration would be noise
         standing in for evidence. The readiness contract reports that case,
         which is where an unanswered question belongs. */
      ...(meta.contingencyResolved
        && meta.contingencyResolved.state !== contingencyPolicy.STATE.POLICY_MISSING
        ? {
          contingencyProvenance: contingencyPolicy.freeze({
            resolved: meta.contingencyResolved,
            /* Read off the engine's own result, never recomputed. */
            scenarios: contingencyPolicy.workingsFrom(calculated, meta.contingencyResolved),
            asOf: meta.asOf || new Date(),
          }),
        }
        : {}),
      /* ── AND WHICH CATALOGUE THE DEVELOPMENT CHARGES WERE READ FROM ──
         Frozen whenever a catalogue applied, whether or not this costing
         happened to use a charge from it: "the catalogue in force said
         nothing about this" is an answer a reader may need, and it cannot be
         reconstructed later from a version that recorded nothing. */
      ...(meta.developmentResolved
        && meta.developmentResolved.state === developmentChargePolicy.STATE.APPLIED
        ? {
          developmentProvenance: developmentChargePolicy.freeze({
            resolved: meta.developmentResolved, asOf: meta.asOf || new Date(),
          }),
        }
        : {}),
      ...(meta.labourResolved && meta.labourResolved.state === labourPolicy.STATE.APPLIED
        ? {
          labourProvenance: {
            ...labourPolicy.freeze({
              resolved: meta.labourResolved,
              productiveMinutesResolved: meta.labourBasis?.ok
                ? meta.labourBasis.minutes.toFixed(2) : null,
              dependencies: meta.labourDependencies || [],
              asOf: meta.asOf || new Date(),
            }),
            operations: operationWorkings(input.lines),
          },
        }
        : {}),
      ...(meta.overheadResolved && meta.overheadResolved.state === overheadPolicy.STATE.APPLIED
        ? {
          overheadProvenance: overheadPolicy.freeze({
            resolved: meta.overheadResolved,
            calculated,
            asOf: meta.asOf || new Date(),
          }),
        }
        : {}),
      policySnapshot: snapshot,
      scenarios: calculated.scenarios,
      /* ── THE COMMERCIAL ANSWER, FROZEN APART FROM THE COST ────────────
         Built from the calculated cost and the proposed prices, never the
         other way round. It lives in its own block so a later reader can see
         at a glance which figures are what the product is estimated to cost
         and which are what somebody proposed to sell it for. */
      commercial: buildCommercial({ input, calculated, policy: policyBundle.policy, snapshot }),
      /* ── WAS EVERY COST FAMILY ADDRESSED? (Chunk 4C) ──────────────────
         Derived HERE, from the calculated result and the decisions actually
         submitted — never taken from the request. A costing that could
         declare itself complete is a costing whose completeness means
         nothing, and the browser is exactly the party with a reason to say
         yes. */
      completeness: buildCompleteness({ calculated, snapshot, sourceDecisions: meta.sourceDecisions || {} }),
      calculation: {
        engineVersion: ENGINE_VERSION,
        calculatedAt: new Date(),
        warnings: [...calculated.warnings, ...(meta.offerWarnings || [])],
      },
    },
    calculated,
  };
}

/**
 * Insert the next version of a costing.
 *
 * @param {object} ctx      resolved costing context — company and actor
 * @param {object} costing  the parent, ALREADY loaded under the company scope
 * @param {object} input    `parseCalculationRequest`'s output
 * @param {object} meta     `{requestId, idempotencyKey, claim, origin, legacyImportKey, sourceReferences}`
 */
/* ── AN EXCLUDED QUOTATION'S OWN REASON, AS A COSTING REFUSAL ──────────────
 * `offerApplicability` and the costing error table already agree about these
 * situations; this is the mapping between their two vocabularies, kept in one
 * place so a new exclusion cannot silently arrive as a generic gap.
 */
const EXCLUSION_REFUSAL = Object.freeze({
  BELOW_MOQ: "COSTING_OFFER_BELOW_MOQ",
  NOT_AN_ORDER_MULTIPLE: "COSTING_OFFER_NOT_AN_ORDER_MULTIPLE",
  NO_QUANTITY_TIER: "COSTING_OFFER_NO_QUANTITY_TIER",
  INACTIVE_SUPPLIER: "COSTING_OFFER_INACTIVE_SUPPLIER",
  INCOMPATIBLE_UOM: "COSTING_OFFER_CONVERSION_NOT_CONFIGURED",
  WRONG_ITEM: "COSTING_OFFER_SUBJECT_MISMATCH",
  WRONG_VARIANT: "COSTING_OFFER_SUBJECT_MISMATCH",
  WRONG_COMPANY: "COSTING_OFFER_NOT_USABLE",
  NOT_PUBLISHED: "COSTING_OFFER_NOT_USABLE",
  WITHDRAWN: "COSTING_OFFER_NOT_USABLE",
  SUPERSEDED: "COSTING_OFFER_NOT_USABLE",
  NOT_YET_EFFECTIVE: "COSTING_OFFER_NOT_USABLE",
  EXPIRED: "COSTING_OFFER_NOT_USABLE",
  INACTIVE_ITEM: "COSTING_OFFER_NOT_USABLE",
  QUANTITY_NOT_STATED: "COSTING_OFFER_SCENARIO_QUANTITY_REQUIRED",
});

/**
 * Refuse a version whose assembly still has something blocking on it.
 *
 * The FIRST blocking gap decides the refusal, and where every quotation for
 * that gap was excluded for one reason, that reason's own code and message are
 * used — so "the quotation expired" stays "the quotation expired" instead of
 * becoming "a value is missing". Mixed reasons stay generic: picking one of
 * several would name a cause the assembly did not establish.
 */
function assertNoBlockingGap(assembled) {
  const blocking = (assembled.missing || []).filter((m) => m.blocking);
  if (!blocking.length) return;

  /* An outage first, whichever order the gaps came in: "could not be read" is
     not one problem among several, it is the reason the rest are unknown. */
  const gap = blocking.find((m) => m.outage) || blocking[0];
  if (gap.outage) {
    throw fail("COSTING_SOURCE_UNAVAILABLE", gap.message, {
      reason: "SOURCE_UNAVAILABLE", key: gap.key, lineKey: gap.lineKey || null,
      owner: gap.owner || null, retryable: true,
    });
  }
  const excluded = gap.excluded || [];
  const reasons = [...new Set(excluded.map((e) => e.reason).filter(Boolean))];
  const only = reasons.length === 1 && !(gap.candidates || []).length
    ? excluded.find((e) => e.reason === reasons[0]) : null;
  /* A company that has not stated its input-GST treatment is not a quotation
     problem — it is the one field on the policy that answers it, and the
     costing error table already names that situation. */
  const single = gap.key === "policy-input-gst"
    ? "COSTING_OFFER_TAX_TREATMENT_REQUIRED"
    : (only ? EXCLUSION_REFUSAL[only.reason] : null);

  throw fail(
    single || "COSTING_ASSEMBLY_BLOCKED",
    (only && only.message) || gap.message,
    {
      reason: only ? only.reason : (single ? gap.key : "ASSEMBLY_BLOCKED"),
      key: gap.key,
      lineKey: gap.lineKey || null,
      owner: gap.owner || null,
      /* The numbers the verdict is about, and the run it was reached at —
         "below the supplier's minimum" is not actionable without the minimum,
         the quantity, the unit and which scenario asked for it. */
      ...(only
        ? {
          purchaseQuantity: only.purchaseQuantity ?? null,
          purchaseUom: only.purchaseUom ?? null,
          moq: only.moq ?? null,
          orderMultiple: only.orderMultiple ?? null,
          ...(only.tiers ? { tiers: only.tiers } : {}),
        }
        : {}),
      offerId: only?.offerId || null,
      supplierId: only?.supplierId || null,
      scenarios: only && gap.judgedAt
        ? [{
          scenarioKey: gap.judgedAt.scenarioKey,
          outputQuantity: gap.judgedAt.outputQuantity,
          purchaseQuantity: only.purchaseQuantity ?? null,
          code: only.reason,
          message: only.message,
        }]
        : [],
      /* Everything blocking, not only the one that named the refusal — being
         told about the quotation, fixing it, and then being told about the
         policy is how a save takes five attempts. */
      blocking: blocking.map((m) => ({
        key: m.key, message: m.message, lineKey: m.lineKey || null, owner: m.owner || null,
      })),
      candidates: gap.candidates || [],
      excluded,
    },
  );
}

async function createNextVersion(ctx, costing, input, meta = {}) {
  /* ── THE COSTING'S OWN DATE, NOT NOW ──────────────────────────────────
     The company rules that are effective-dated — today, the Board's overhead
     methodology — are resolved for the date this version is being made FOR.
     A costing dated in March is calculated at March's overhead rate, and a
     policy approved since (even one backdated) is simply not the version that
     query selects. `getPolicy` does the resolution so there is one place it
     happens; everything downstream reads `policyBundle.policy` as before. */
  const policyBundle = await policyService.getPolicy(ctx, { asOf: meta.asOf || new Date() });
  /* The authoritative guard, on the far side of every route: an unconfigured
     company cannot produce a priced, frozen version. Refused BEFORE anything
     is written, so no version exists, the parent pointer does not move, and
     the idempotency claim is released by the route's error path. */
  policyService.assertConfigured(policyBundle);
  /* ── AND AN APPROVED MARGIN BAND, BY NAME ─────────────────────────────
     The engine would refuse this anyway — it reads all three band figures as
     required — but its refusal names a field nobody can set any more. This
     names the Board decision, the desk that owns it and the screen, and it is
     raised here for the same reason as the guard above: before anything is
     written. */
  marginPolicy.assertApproved(policyBundle.margin, { fail });
  /* ── QUOTATION-BACKED LINES ARE PRICED FIRST ──────────────────────────
     Before the engine, so it receives ordinary rates and stays unaware of
     supplier offers entirely. A refusal here — an expired quotation, a
     missing conversion, a currency with no contract — stops the version
     before anything is written. */
  /* ── IMPORTED LINES ARE BOUND TO THEIR SOURCE FIRST ───────────────────
     Before pricing and before the engine. Chunk 4A snapshotted provenance and
     calculated from whatever the browser posted, so a real technical key
     could sit beside a different consumption and produce an immutable costing
     that contradicted its own evidence. This proves the style belongs to THIS
     costing's enquiry product, and that every imported line still matches
     what the record says — refusing, never silently substituting.

     It returns the preview it checked against, and the freeze below reuses
     it: reading the source twice would let a change land between them, and
     the version would be calculated from one answer and provenanced with
     another. */
  /* ── THE SERVER BUILDS THE LINES, NOT THE BROWSER ─────────────────────
     A source-backed costing's material and operation rows are generated here
     from the technical record, at SAVE time, from a live read. The browser
     sends decisions — which style, which quantities, what does not apply,
     what is being overridden and why — and never an authoritative row.

     This used to calculate whatever `input.lines` contained, which meant the
     server could describe a technical record and still needed the client to
     reconstruct it before anything was costed. A stale client then produced a
     stale costing, and nothing said so. */
  const assembly = require("./assembly.service");
  /* ── THE PRECISE REFUSAL RUNS FIRST ───────────────────────────────────
     A style in ANOTHER company is a non-disclosing 404, and the assembly
     produces exactly that. A style in THIS company for a different product is
     a 409 that says so — the caller can see both records, and "not found"
     would send them looking for one sitting in front of them. The assembly
     collapses both into the safe answer, which is right for a lookup and
     wrong here, so the specific check goes ahead of it. */
  if (input.technicalStyleId) {
    await technicalBinding.assertStyleBelongsToCosting(ctx, costing, input.technicalStyleId);
  }
  /* ── THE LEGACY SALES SHEET IS NOT A TYPED LINE ───────────────────────
     `POST /versions/legacy-import` builds a version from the costing sheet
     already recorded on the enquiry. That is an authoritative Sales record,
     not somebody reconstructing a technical one — and it predates technical
     records entirely, so demanding a SampleStyle would make historical
     enquiries permanently un-importable.

     The block below is about the MANUAL calculator, which is the path a stale
     or hostile client uses to type its way past a missing record. */
  const assembledInput = meta.legacyImportKey
    ? { state: "LEGACY_IMPORT", lines: input.lines, generated: [], missing: [] }
    : await assembly.assembleLines(ctx, costing, {
      styleId: input.technicalStyleId || null,
      clientLines: input.lines || [],
      policy: policyBundle.policy,
    /* The run sizes decide which quotation can supply the order, and which
       tier each scenario reaches. */
      scenarios: input.scenarios || [],
      asOf: meta.asOf || new Date(),
      /* ── AND STORE'S SOURCING DECISIONS ARE LOADED, NOT PASSED ────────
         `quotationChoices: input.quotationChoices` stood here — the browser's
         map, threaded from the request. The assembly reads the decisions
         Store recorded now, so there is nothing to thread, and the request
         contract refuses a caller that still tries. Every one is still
         re-read and revalidated per scenario below. */
    });
  /* ── A BLOCKING GAP IS REFUSED WHERE ITS REASON IS STILL KNOWN ────────
     The assembly reports every gap it found, and the quotation gaps carry
     each excluded quotation with the reason it was excluded — expired,
     withdrawn, below the supplier's minimum, off their order multiple, wrong
     item, no configured unit conversion.

     None of that reached the caller. A material with no usable quotation
     simply arrived at the engine with no rate, and the engine said what it
     truthfully could: "1 cost input is missing a value." Somebody reading
     that has no way to learn that their quotation expired in March, which
     supplier it was, or that raising the run to 500 metres would fix it — and
     the information was sitting in the assembly the whole time.

     So the refusal happens here, while the reason survives, and it carries
     the same code the per-offer path used to raise. */
  /* ── THE SERVER KNOWS WHICH STYLE IT ASSEMBLED FROM ───────────────────
     `bindTechnicalLines` refuses a line carrying a `technicalKey` unless the
     request names the style. That was right when the BROWSER produced those
     lines. It produces none now — the assembly does, from a style it resolved
     itself — so demanding the client echo the id back is the same "reconstruct
     the sources" defect in its last hiding place.

     A client-supplied id still wins, and is still proved against this
     costing's own candidates; this only fills in what the server already
     decided. */
  const sourcedInput = {
    ...input,
    lines: assembledInput.lines,
    technicalStyleId: input.technicalStyleId || assembledInput.styleId || "",
  };

  /* Still run: it re-reads the style and REVALIDATES every generated row
     against it, so a version is frozen from what the record says now rather
     than from what a preview said an hour ago. */
  const bound = await technicalBinding.bindTechnicalLines(ctx, costing, sourcedInput, {
    asOf: meta.asOf || new Date(),
    currency: policyBundle.policy.baseCurrency,
    /* The company's own labour assumptions, so the rate binding derives is
       the one the assembly showed — not the sample's legacy figure. */
    policy: policyBundle.policy,
  });

  /* ── AFTER THE BINDING, WHICH COMPLAINS MORE PRECISELY ────────────────
     A submitted row that no longer matches the record is refused by name and
     says which field drifted. Checking the assembly's gaps first would answer
     a request like that with the gap instead, which is true but less useful:
     the caller has a row they can fix, and would be told about a rate nobody
     had asked them for yet. */
  assertNoBlockingGap(assembledInput);

  const priced = await priceQuotationLines(ctx, { ...sourcedInput, lines: bound.lines }, {
    policy: policyBundle.policy,
    asOf: meta.asOf || new Date(),
  });

  /* Services, from their own register, onto the lines the material pass just
     returned. Their provenance joins the same frozen list — one place a reader
     looks for "which quotation produced this figure", whatever was bought. */
  const servicePriced = await priceServiceLines(ctx, { ...sourcedInput, lines: priced.lines }, {
    policy: policyBundle.policy,
    asOf: meta.asOf || new Date(),
  });

  /* ── AND THE COMPANY'S OWN DEVELOPMENT CHARGES ────────────────────────
     Priced by the assembly from the policy in force at the costing date, and
     already on the line. What happens HERE is the freezing: the entry, its
     amount and the window it applied in are lifted onto the version's
     provenance, so a costing stays explicable after Finance publishes next
     quarter's charge. */
  const developmentProvenance = (servicePriced.lines || [])
    .filter((l) => l.policyProvenance)
    .map((l) => ({ lineKey: l.lineKey, ...l.policyProvenance }));

  /* ── AND WHAT CUSTOMS CHARGED ON THE IMPORTED PARTS ───────────────────
     Lifted off the duty lines the assembly built, for the same reason: a
     costing has to stay explicable after the Board publishes a new rate or
     Store revises the quotation the origin was recorded on. */
  const dutyProvenance = (servicePriced.lines || [])
    .filter((l) => l.dutyProvenance)
    .map((l) => ({ ...l.dutyProvenance }));

  /* ── AND HOW THE FINISHED ORDER GETS TO THE CUSTOMER ──────────────────
     The lane, the shipment and the transporter's quotation, flattened onto
     the version. A recorded zero is frozen with the arrangement that
     produced it, because "the customer collects" is an answer and has to
     stay readable as one after the account's standing terms change. */
  const freightLine = (servicePriced.lines || []).find((l) => l.freightProvenance) || null;
  const freightProvenance = freightLine ? freezeFreight(freightLine) : undefined;

  /* ── AND WHAT IT COST TO WAIT TO BE PAID FOR IT ───────────────────────
     The Board's approved methodology and the payment terms Sales confirmed,
     both copied by value onto the version. `financing.service` built this
     when it priced the line; what happens here is the FREEZING — so that a
     policy approved next quarter, a customer renegotiating their standing
     terms, or a backdated Board decision cannot restate a costing that was
     calculated before any of it happened.

     Lifted off the line rather than rebuilt, for the same reason the freight
     block is: a second read is a second answer, and the version would be
     provenanced with one and calculated from the other. */
  const financingLine = (servicePriced.lines || []).find((l) => l.financingProvenance) || null;
  const financingProvenance = financingLine ? financingLine.financingProvenance : undefined;

  /* ── AND WHAT THE COMPANY ADDED TO COVER RUNNING ITSELF ───────────────
     The Board's approved rate and the subtotal it applies to, copied by value
     off the resolution `getPolicy` already made — not resolved a second time,
     because a second read is a second answer and the version would be
     provenanced with one and calculated from the other.

     The per-scenario workings are filled in below, once the engine has
     produced them: a rate and a basis NAME cannot be checked a year later
     without the amount the percentage was applied to. */
  const overheadResolved = policyBundle.overhead || null;

  /* ── AND WHAT A MINUTE OF AN OPERATOR'S TIME COST ─────────────────────
     The Board's methodology, off the resolution `getPolicy` already made —
     not resolved a second time, because a second read is a second answer and
     the version would be provenanced with one and calculated with the other.

     `productiveBasis` is asked of `labourCost` rather than recomputed here:
     it is the module that turned the efficiency into minutes for the rate, so
     asking it again is the only way the frozen denominator is guaranteed to
     be the one the arithmetic used. */
  /* ── AND WHETHER THE TAX ON EVERY PURCHASE WAS COST ───────────────────
     Off the resolution `getPolicy` already made, never resolved a second
     time. The per-line workings are frozen by the engine and the offer
     provenance; what this adds is the company decision behind them. */
  const gstResolved = policyBundle.gst || null;

  /* ── AND WHICH DEVELOPMENT CHARGE CATALOGUE APPLIED ───────────────────
     Off the same resolution, for the same reason: `applyDevelopmentCharges`
     priced the lines from this catalogue, and resolving it again here could
     answer differently between the calculation and the record of it.

     Named `developmentResolved` because `developmentProvenance` below is a
     different thing — the per-LINE charge workings, which are frozen into
     `policyProvenance`. One is what each charge came to; this is which
     approved catalogue they were read from. */
  const developmentResolved = policyBundle.development || null;

  /* ── AND WHETHER A STANDARD CONTINGENCY WAS ADDED ─────────────────────
     Off the same resolution. Carried even when the answer is NONE: a version
     that recorded nothing could not later say whether the company had decided
     against a contingency or nobody had asked. */
  const contingencyResolved = policyBundle.contingency || null;

  /* ── AND THE BAND EVERY PRICE BREAK WAS SOLVED FROM ───────────────────
     Off the same resolution. Frozen so a version can say which approved
     decision set the price it published, and who stands behind it. */
  const marginResolved = policyBundle.margin || null;

  const labourResolved = policyBundle.labour || null;
  const labourBasis = labourResolved && labourResolved.state === labourPolicy.STATE.APPLIED
    ? labourCost.productiveBasis(policyBundle.policy)
    : null;
  /* Whether the overhead half of `IN_OVERHEAD` is actually in force, so a
     dependency the Board's decision leaves open is frozen as it stood. */
  const labourDependencies = labourResolved
    ? labourPolicy.dependenciesOf(labourResolved, {
      overheadInForce: (policyBundle.overhead || {}).state === overheadPolicy.STATE.APPLIED,
    })
    : [];

  /* ── AND A POLICY-BACKED LINE IS NOT PROVISIONAL EITHER ────────────────
     It never passes a pricing function — there is no supplier to read — so
     without this it kept the parser's default and every internally developed
     pattern read as somebody's typed guess. It is not: the amount came from
     a dated entry Finance published, which is as authoritative as a
     quotation.

     Still only as good as its weaker half: a requirement that was PLANNED
     rather than confirmed on the sample stays provisional however good the
     charge behind it. */
  const withPolicyConfidence = (servicePriced.lines || []).map((l) => (
    l.policyProvenance && !l.evidenceProvisional
      ? { ...l, confidence: "VERIFIED" }
      : l
  ));

  /* ── FROZEN TECHNICAL EVIDENCE (Chunk 4A) ─────────────────────────────
     Built from `bound.preview` — the SAME server read the lines were bound
     against a moment ago, handed along rather than fetched again. Not from
     the request either way: what the client previewed is what the client saw,
     not what is true.

     One read, deliberately. A second would let the style change in between,
     and the version would be CALCULATED from one answer and PROVENANCED with
     another — the exact contradiction the binding step exists to prevent.

     What is frozen is a snapshot, never a reference: renaming the style,
     revising its BOM or re-costing its operations tomorrow cannot change what
     this version says it was built from. */
  const technical = freezeTechnicalSource(
    { ...sourcedInput, lines: bound.lines }, bound.preview, bound.styleId,
  );

  const { body, calculated } = buildVersionBody({
    ctx, costing,
    input: { ...sourcedInput, lines: withPolicyConfidence },
    policyBundle,
    meta: {
      ...meta,
      /* ── THE APPLICABILITY DECISIONS THE ASSEMBLY READ ────────────────
         Taken from the assembly rather than re-resolved, so the coverage
         assessment, the frozen provenance and the lines that were priced all
         describe the same moment. A second read could catch a department
         changing its mind mid-save and freeze a version whose families and
         whose evidence disagree. */
      sourceDecisions: assembledInput.sourceDecisions || {},
      /* One frozen list, whatever was bought. A reader asking "which
         quotation produced this figure" should not have to know first whether
         the line was a material or a process. */
      offerProvenance: [...priced.provenance, ...servicePriced.provenance],
      /* Its own list: a policy charge has no supplier, no quotation reference
         and no tier, and putting it among the quotations would leave a reader
         looking for evidence that was never claimed. */
      policyProvenance: developmentProvenance,
      /* Its own list again, and for a sharper reason: duty is a different
         charge on a different event under a different classification, levied
         by a different authority. Folding it in with the supplier quotations
         or the company charges would lose exactly that. */
      ...(dutyProvenance.length ? { dutyProvenance } : {}),
      ...(freightProvenance ? { freightProvenance } : {}),
      ...(financingProvenance ? { financingProvenance } : {}),
      ...(overheadResolved ? { overheadResolved } : {}),
      ...(labourResolved ? { labourResolved, labourBasis, labourDependencies } : {}),
      ...(gstResolved ? { gstResolved } : {}),
      ...(developmentResolved ? { developmentResolved } : {}),
      ...(contingencyResolved ? { contingencyResolved } : {}),
      ...(marginResolved ? { marginResolved } : {}),
      offerWarnings: [...priced.warnings, ...servicePriced.warnings],
      sourceReferences: [
        ...(meta.sourceReferences || []),
        /* Always — a decision that a family does not apply stands whether or
           not this version imported anything from a style. */
        ...freezeApplicabilityDecisions(assembledInput.sourceDecisions),
        ...technical.sourceReferences,
      ],
    },
  });

  /* The unique indexes ARE the guarantees below. On a fresh deployment
     mongoose builds them in the background, and until they exist every
     "duplicate" insert succeeds — so the first call of the process waits for
     them rather than racing them. Cached no-op afterwards. */
  await CostingVersion.init();

  const transactional = await transactionsAvailable();
  let lastErr = null;

  for (let attempt = 0; attempt < NUMBERING_ATTEMPTS; attempt += 1) {
    /* Read the highest number that exists RIGHT NOW. Not the parent's cached
       pointer: the pointer is a convenience and could be stale, while the
       version collection is the authority on what versions there are. */
    const highest = await CostingVersion.findOne({
      companyId: ctx.companyId, costingId: costing._id,
    })
      .sort({ versionNumber: -1 })
      .select("versionNumber")
      .lean();

    const previousNumber = highest?.versionNumber ?? 0;
    const versionNumber = previousNumber + 1;
    const doc = {
      ...body,
      versionNumber,
      provenance: {
        ...body.provenance,
        /* A correction names what it replaces; version 1 replaces nothing. */
        supersedesVersionNumber: previousNumber || null,
      },
    };

    try {
      const version = transactional
        ? await insertTransactionally(ctx, costing, doc)
        : await insertCompensated(ctx, costing, doc);
      return { version, calculated, policySnapshot: body.policySnapshot, attempts: attempt + 1 };
    } catch (err) {
      if (violated(err, "versionNumber")) {
        /* Somebody else took this number between the read and the write.
           That is the index doing its job; read again and take the next one. */
        lastErr = err;
        continue;
      }
      if (violated(err, "creationClaimId")) {
        const conflict = new Error("This version was already created by the same request.");
        conflict.name = "CostingVersionClaimAlreadyUsed";
        throw conflict;
      }
      if (violated(err, "legacyImportKey")) {
        const conflict = new Error("That legacy costing sheet has already been imported in this state.");
        conflict.name = "CostingVersionLegacyAlreadyImported";
        throw conflict;
      }
      throw err;
    }
  }

  throw fail("CONFLICT", "This costing is being revised by somebody else. Try again in a moment.", {
    reason: "VERSION_NUMBERING_CONTENDED", attempts: NUMBERING_ATTEMPTS, cause: lastErr?.message || "",
  });
}

/** Both writes commit together, or neither does. */
async function insertTransactionally(ctx, costing, doc) {
  const session = await mongoose.startSession();
  try {
    let created;
    await session.withTransaction(async () => {
      const [version] = await CostingVersion.create([doc], { session });
      await movePointerForward(ctx, costing, version, session);
      created = version;
    });
    return created;
  } finally {
    await session.endSession().catch(() => {});
  }
}

/**
 * No transaction available: insert the version, then move the pointer.
 *
 * ── WHY THIS ORDER IS THE SAFE ONE ──────────────────────────────────────────
 * The version is the record; the pointer is a cache of "which is newest". A
 * crash between the two leaves a real version that every version-list read
 * still returns, and a parent whose pointer is one behind — visibly stale, and
 * repaired by the next successful write, because the pointer update is
 * conditional and idempotent. The other order would leave a costing pointing
 * at a version that does not exist.
 */
async function insertCompensated(ctx, costing, doc) {
  const [version] = await CostingVersion.create([doc]);
  await movePointerForward(ctx, costing, version, null);
  return version;
}

/**
 * Point the costing at its newest version — forward only.
 *
 * The `$lt` guard is the whole point: with two versions in flight, the one
 * that finishes second is not necessarily the higher-numbered one, and an
 * unconditional `$set` would let a late writer drag the pointer backwards so
 * the costing claimed version 4 while 5 existed.
 */
function movePointerForward(ctx, costing, version, session) {
  return Costing.updateOne(
    {
      _id: costing._id,
      companyId: ctx.companyId,
      currentVersionNumber: { $lt: version.versionNumber },
    },
    {
      $set: {
        currentVersionId: version._id,
        currentVersionNumber: version.versionNumber,
      },
    },
    session ? { session } : {},
  );
}

/**
 * The version this exact user action already created, if it did.
 *
 * ── COMPANY-SCOPED, NOT COSTING-SCOPED, DELIBERATELY ────────────────────────
 * Scoping this to the costing in the URL was the bug: the same key aimed at a
 * second costing found nothing here, went on to create, and then lost the
 * company-wide unique index on the claim — surfacing as a 500 for what is
 * really a client reusing a key. Looking the claim up across the company finds
 * it wherever it was spent, and the CALLER compares the target and answers
 * 409. The unique index and this lookup now agree about scope.
 */
function findByCreationClaim(ctx, claimId) {
  if (!ctx?.companyId || !claimId) return Promise.resolve(null);
  return CostingVersion.findOne({
    companyId: ctx.companyId,
    "provenance.creationClaimId": String(claimId),
  });
}

/**
 * Bring the parent's pointer up to a version that already exists.
 *
 * ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
 * Without a transaction the version is inserted first and the pointer moved
 * second — the safe order, because a crash between them leaves a real version
 * and a merely stale pointer rather than a pointer to nothing. But "stale
 * until the next successful write" was too weak a promise: a recovered retry
 * returned the version while `GET /api/costings/:id` still showed the previous
 * one as current, so the same costing read two different ways.
 *
 * Recovery therefore repairs it. Same forward-only guard as an ordinary write,
 * so this can only ever move the pointer up: a repair for version 4 arriving
 * after version 5 landed matches nothing and changes nothing.
 */
async function repairPointer(ctx, costing, version) {
  if (!version?.versionNumber) return { moved: false };
  const res = await movePointerForward(ctx, costing, version, null);
  return { moved: (res?.modifiedCount ?? 0) > 0 };
}

/** The version a given legacy sheet, in a given state, was imported into. */
function findByLegacyImportKey(ctx, importKey) {
  if (!ctx?.companyId || !importKey) return Promise.resolve(null);
  return CostingVersion.findOne({
    companyId: ctx.companyId,
    "provenance.legacyImportKey": String(importKey),
  });
}

/**
 * Does a spent claim belong to THIS request, or was the key reused?
 *
 * @returns {string|null} the machine reason for a refusal, or null to recover
 *
 * ── THREE FACTS ARE COMPARED, AND ONE OF THEM MAY BE ABSENT ─────────────────
 * `costingId` is the load-bearing one and has always been checked. The stored
 * `creationClaimTarget` is now written too, and is compared as well — but only
 * WHEN IT IS PRESENT.
 *
 * Versions created before this fix carry no target, and treating that absence
 * as a mismatch would turn every one of them into a permanent 409. So an empty
 * stored target falls back to the company-scoped `costingId` comparison, which
 * is exactly as strict about the thing that matters: an old claim can still
 * only ever recover its OWN costing, and can never authorise another.
 */
function claimMismatch(existing, costing, claim) {
  if (String(existing.costingId) !== String(costing._id)) return "DIFFERENT_COSTING";

  /* Two shapes reach here and both are read the same way: a VERSION, whose
     claim lives under `provenance`, and a claim RECEIPT, which is the same
     three facts flat. Normalising here rather than at each call site means the
     comparison cannot drift between the two. */
  const storedTarget = existing.provenance?.creationClaimTarget ?? existing.target ?? "";
  const storedHash = existing.provenance?.creationRequestHash ?? existing.requestHash ?? "";
  /* Both spellings, because the route holds it as `claimTarget` on
     `req.idempotent` and the services pass a `claim` object whose field is
     `target`. One comparison, either shape. */
  const wantedTarget = claim?.target || claim?.claimTarget || "";
  if (storedTarget && wantedTarget && storedTarget !== wantedTarget) return "DIFFERENT_TARGET";

  if ((storedHash || "") !== (claim?.requestHash || "")) return "DIFFERENT_PAYLOAD";
  return null;
}

/**
 * Everything this claim has already been spent on, from either durable record.
 *
 * ── TWO RECORDS, BECAUSE THEY FAIL DIFFERENTLY ──────────────────────────────
 * The version-embedded claim is written in the SAME INSERT as the version, so
 * there is no window in which a created version lacks it — that is what makes
 * it trustworthy after a crash. The receipt is a second write and can fail;
 * what it buys is the case the first cannot express, where a key resolves to a
 * version somebody else's key created and there is no immutable document it
 * may be appended to.
 *
 * So both are consulted, receipt first (it is the more specific statement, and
 * the only one that exists for an alias), and the version-embedded claim as
 * the backstop that survives a failed receipt write.
 *
 * @returns {Promise<{version, costingId, target, requestHash, source}|null>}
 */
async function resolveClaim(ctx, claimId) {
  if (!ctx?.companyId || !claimId) return null;

  const receipt = await CostingClaim.findOne({
    companyId: ctx.companyId, claimId: String(claimId),
  }).lean();

  if (receipt) {
    /* The version is loaded under the caller's own company scope: the receipt
       names it, it never authorises it. A receipt whose version has since gone
       is treated as no receipt at all rather than as a dangling promise. */
    const version = await CostingVersion.findOne({
      companyId: ctx.companyId, _id: receipt.versionId,
    });
    if (version) {
      return {
        version,
        costingId: receipt.costingId,
        target: receipt.target || "",
        requestHash: receipt.requestHash || "",
        source: "RECEIPT",
      };
    }
  }

  const version = await findByCreationClaim(ctx, claimId);
  if (!version) return null;
  return {
    version,
    costingId: version.costingId,
    target: version.provenance?.creationClaimTarget || "",
    requestHash: version.provenance?.creationRequestHash || "",
    source: "VERSION",
  };
}

/**
 * Does an existing receipt say the same thing this one would?
 *
 * ── WHY A DUPLICATE KEY IS NOT AUTOMATICALLY AN AGREEMENT ───────────────────
 * `11000` means only "that claim id is already taken". It says nothing about
 * WHAT it was taken for. Treating every duplicate as an idempotent success —
 * which the first version of this did — would accept a receipt that points at
 * a different version, a different costing or a different payload, and call
 * the key bound when it is bound to something else entirely.
 *
 * So the existing row is read and compared field by field. Everything agrees →
 * the write was genuinely redundant. Anything differs → the key has been spent
 * on something else and this is a reuse, not a retry.
 *
 * @returns {string|null} the machine reason for a refusal, or null if identical
 */
function receiptConflict(existing, intended) {
  if (String(existing.companyId) !== String(intended.companyId)) return "DIFFERENT_COMPANY";
  if (String(existing.costingId) !== String(intended.costingId)) return "DIFFERENT_COSTING";
  if (String(existing.versionId) !== String(intended.versionId)) return "DIFFERENT_VERSION";
  if ((existing.target || "") !== (intended.target || "")) return "DIFFERENT_TARGET";
  if ((existing.requestHash || "") !== (intended.requestHash || "")) return "DIFFERENT_PAYLOAD";
  if ((existing.operation || "") !== (intended.operation || "")) return "DIFFERENT_OPERATION";
  return null;
}

/**
 * Record that a key resolved to a version.
 *
 * ── TWO CALLERS, TWO DIFFERENT STAKES ───────────────────────────────────────
 * A key that CREATED the version is already bound by the version's own
 * `provenance`, written in the same insert — so a failed receipt costs a
 * uniform lookup and nothing else, and the operation may proceed.
 *
 * A key that ALIASED an existing version has no such record and can never have
 * one: the version is frozen and belongs to another key. The receipt IS its
 * binding. If that write fails and the request reports success anyway, the
 * temporary idempotency row is completed, expires thirty days later, and the
 * key is loose again — which is exactly the hole receipts were introduced to
 * close. A durable guarantee cannot rest on a best-effort write.
 *
 * Hence `mandatory`. It is not a severity dial; it is the difference between
 * "this record is a convenience" and "this record is the guarantee".
 *
 * @param {boolean} [opts.mandatory]  throw rather than return on write failure
 * @throws 409 when a duplicate claim id disagrees about what it was spent on
 * @throws 503 COSTING_CLAIM_PERSISTENCE_FAILED when a mandatory write fails
 */
async function recordClaimReceipt(ctx, {
  claim, operation, costing, version, resolution = "CREATED", mandatory = false,
} = {}) {
  if (!ctx?.companyId || !claim?.claimId || !version?._id) return { recorded: false, reason: "NOT_APPLICABLE" };

  const intended = {
    companyId: ctx.companyId,
    claimId: String(claim.claimId),
    operation: operation || "",
    costingId: costing._id,
    target: claim.target || claim.claimTarget || "",
    requestHash: claim.requestHash || "",
    versionId: version._id,
    versionNumber: version.versionNumber,
    resolution,
  };

  try {
    await CostingClaim.create(intended);
    return { recorded: true, reason: "WRITTEN" };
  } catch (err) {
    if (err?.code === 11000) {
      /* Company-scoped, like every other read in this domain. */
      const existing = await CostingClaim.findOne({
        companyId: ctx.companyId, claimId: intended.claimId,
      }).lean();

      if (!existing) {
        /* The row lost the index and then vanished — a TTL or a delete at
           exactly the wrong moment. Nothing is proved either way, so a
           mandatory caller must not report success on it. */
        if (!mandatory) return { recorded: false, reason: "VANISHED" };
        throw fail(
          "COSTING_CLAIM_PERSISTENCE_FAILED",
          "That import could not be recorded just now. Send it again in a moment; it will not be duplicated.",
          { reason: "CLAIM_RECEIPT_VANISHED", operation: intended.operation },
        );
      }

      const conflict = receiptConflict(existing, intended);
      if (conflict) {
        throw fail(
          "IDEMPOTENCY_KEY_REUSED",
          "This request key was already used for a different request. Start the action again.",
          { operation: intended.operation, reason: conflict },
        );
      }
      /* Identical in every compared field: the write was redundant, and the
         binding this caller needed is already in place. */
      return { recorded: true, reason: "ALREADY_RECORDED" };
    }

    console.error(
      `[centralCosting] could not record the claim receipt for ${intended.operation}:`,
      err?.message || err,
    );

    if (!mandatory) {
      /* The embedded claim on the version is this key's binding; the receipt
         was only going to make the lookup uniform. Recovery still works. */
      return { recorded: false, reason: "WRITE_FAILED" };
    }

    /* ── NO RECEIPT, NO SUCCESS ──────────────────────────────────────────
       Refused with a retryable code rather than reported as done. The domain
       work is not repeated by the retry: the version already exists and the
       retry finds it by content, then finishes the record that failed. */
    throw fail(
      "COSTING_CLAIM_PERSISTENCE_FAILED",
      "That import could not be recorded just now. Send it again in a moment; it will not be duplicated.",
      { reason: "CLAIM_RECEIPT_WRITE_FAILED", operation: intended.operation },
    );
  }
}

module.exports = {
  NUMBERING_ATTEMPTS, claimMismatch, resolveClaim, recordClaimReceipt, receiptConflict,
  buildVersionBody, createNextVersion, findByCreationClaim, findByLegacyImportKey,
  repairPointer,
  /* ── EXPORTED SO A REFUSAL CAN BE READ WITHOUT WRITING ─────────────────
     It is what turns an assembly's first blocking gap into the typed refusal
     a caller acts on — "the quotation expired", "below the supplier's
     minimum" — rather than a generic "something is missing". `createNextVersion`
     calls it on the way to a write; nothing else could ask it anything
     without also attempting one. Sales' own projection deliberately does NOT
     use it: the specialised codes it derives read the excluded offers, and an
     excluded offer names its supplier and its rate. */
  assertNoBlockingGap,
};
