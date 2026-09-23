// services/centralCosting/visibility.js
//
// Central Costing — Chunk 1. ONE PLACE THAT DECIDES WHAT LEAVES THE SERVER.
//
// ── WHY EXACTLY ONE ─────────────────────────────────────────────────────────
// `services/crmCostVisibility.js` opens with the reason: "hiding a column in
// React while the endpoint still serves the rows is theatre". The failure mode
// it does not defend against is subtler and is the one this file is built to
// stop — a SECOND serializer. The moment two routes each shape their own
// response, one of them eventually forgets a field, and the field it forgets
// is a supplier's price.
//
// So every costing payload, on every endpoint, is produced here. A route may
// choose WHICH object to serialize; it may not choose what a version looks
// like on the wire.
//
// ── BLOCKS, NOT FIELDS ──────────────────────────────────────────────────────
// Confidential content is grouped into named blocks, and each block is keyed
// to exactly ONE capability:
//
//   output  → costing.output.read   the approved commercial number
//   cost    → costing.cost.read     build-up, source snapshots, supplier prices
//   margin  → costing.margin.read   margin and margin-sensitive output
//
// Holding one grants nothing about another. In particular COST does not imply
// MARGIN: a costing clerk may need the build-up and have no business knowing
// what the company adds to it.
//
// ── OMITTED, NOT NULLED ─────────────────────────────────────────────────────
// A withheld block is ABSENT from the payload. Nulling it would say "this
// costing has no cost", which is a different and untrue statement — the same
// reasoning crmCostVisibility gives for deleting `cost` rather than zeroing
// it. `visibility.withheld` names the blocks that were removed, so a client
// can render "you do not have access to this" instead of "not costed yet",
// and it names BLOCKS only: it never leaks a value or a count.
//
// ── AND MISSING IS STILL NOT ZERO ───────────────────────────────────────────
// A block the caller MAY see but which has not been calculated is present with
// `calculated: false` and no totals. Chunk 1 has no calculator, so that is
// every version. A zero would be a claim nobody has made.
"use strict";

const { CAPABILITIES, hasAll, hasAny } = require("./capabilities");
const { formatMinor } = require("./money");
/* Lane B — what a non-packaging family needs, who owns it, and where they
   record it. Pure, and reads only the frozen version handed to it. */
const inputReadiness = require("./inputReadiness");

const C = CAPABILITIES;

/** Which capability unlocks which block. One capability, one block. */
const BLOCK_CAPABILITY = Object.freeze({
  output: C.OUTPUT_READ,
  cost: C.COST_READ,
  margin: C.MARGIN_READ,
});

/**
 * May this caller know that a costing with no approved version EXISTS?
 *
 * ── WHY A SALES-ONLY READER GETS A 404 FOR A DRAFT ──────────────────────────
 * `costing.output.read` is permission to read the APPROVED commercial output.
 * A draft has none. Serving the envelope anyway — an id, a context label, a
 * "version 1, DRAFT" — would tell Sales that somebody is costing the Acme
 * blazer and how many times they have revised it, which is internal
 * information the capability was never meant to carry.
 *
 * So the answer for a draft, to a caller holding only OUTPUT_READ, is the
 * same one a missing costing gets. Nothing distinguishes them.
 */
function canSeeInternalRecord(ctx) {
  return hasAny(ctx?.capabilitySet, [C.COST_READ, C.DRAFT_WRITE, C.APPROVE, C.MARGIN_READ]);
}

/** Does this costing have anything an output-only reader may see? */
const hasApprovedOutput = (versions = []) =>
  versions.some((v) => v && v.status === "APPROVED");

/**
 * The one question every read route asks before answering.
 *
 * @returns {boolean} false ⇒ answer exactly as if the record did not exist
 */
function mayRead(ctx, { versions = [] } = {}) {
  if (canSeeInternalRecord(ctx)) return true;
  if (hasAll(ctx?.capabilitySet, C.OUTPUT_READ)) return hasApprovedOutput(versions);
  return false;
}

const idOf = (v) => (v === null || v === undefined ? null : String(v));

/** The costing handle. Nothing here is confidential; the blocks are. */
function serializeCosting(costing, ctx) {
  const doc = costing?.toObject ? costing.toObject() : costing;
  if (!doc) return null;
  return {
    id: idOf(doc._id),
    companyId: idOf(doc.companyId),
    status: doc.status,
    context: {
      type: doc.context?.type || null,
      primaryId: idOf(doc.context?.primaryId),
      secondaryId: idOf(doc.context?.secondaryId),
      externalKey: doc.context?.externalKey ?? null,
    },
    /* The frozen display copy — deliberately not a live lookup, so a version
       from March still reads as it did in March. */
    contextSnapshot: {
      label: doc.contextSnapshot?.label || "",
      facts: (doc.contextSnapshot?.facts || []).map((f) => ({ key: f.key, value: f.value })),
      capturedAt: doc.contextSnapshot?.capturedAt || null,
    },
    /* ── "CURRENT" IS AN INTERNAL FACT ──────────────────────────────────
       It names the newest WORKING version, so publishing it to an
       output-only reader discloses that a version 3 exists and that somebody
       is editing — which is exactly the draft existence the boundary is
       meant to withhold. It survived the versions array being narrowed,
       because it lives on the costing rather than in it.

       Omitted rather than blanked: a `currentVersion` of null would still be
       a field saying "there is a working version and you may not see it". */
    ...(canSeeInternalRecord(ctx) ? {
      currentVersion: {
        id: idOf(doc.currentVersionId),
        number: doc.currentVersionNumber ?? 0,
      },
    } : {}),
    /* ── THE APPROVED VERSION IS A DIFFERENT ANSWER (Chunk 6A) ──────────
       `currentVersion` is the newest working one and moves whenever somebody
       recalculates. This is what Sales may quote, and it must not move when a
       draft is created — so it is a separate field rather than a second
       meaning for the same one. Null until something is approved. */
    approvedVersion: {
      id: idOf(doc.approvedVersionId),
      number: doc.approvedVersionNumber ?? 0,
      at: doc.approvedAt || null,
    },
    /* ── SAID ON THE RECORD, NOT INFERRED FROM THE TYPE ─────────────────
       An ADHOC costing's inputs were typed rather than read from the
       technical record, the quotation register and the policy. It stays
       readable forever; what it cannot do is move. Every reader is told
       which kind of costing they are looking at, rather than having to know
       that "ADHOC" means "nobody could build this today". */
    ...(doc.context?.type === "ADHOC" ? {
      historical: {
        label: "Historical manual costing",
        readOnly: true,
        reason: "Its inputs were typed rather than read from the technical record, the supplier quotations and the company policy.",
      },
    } : {}),
    createdBy: { actorId: doc.createdByActorId || "", name: doc.createdByActorName || "" },
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
    archived: {
      isArchived: Boolean(doc.isArchived),
      at: doc.archivedAt || null,
      reason: doc.archiveReason || "",
    },
  };
}

/** One snapshotted source fact, with money rendered from its minor units. */
const serializeFact = (f) => {
  const out = { key: f.key };
  if (f.text !== undefined && f.text !== null) out.text = f.text;
  if (f.num !== undefined && f.num !== null) out.num = f.num;
  if (f.money) {
    out.money = {
      amountMinor: f.money.amountMinor,
      currency: f.money.currency,
      /* Display only, derived at the edge. The stored value is the integer. */
      display: formatMinor(f.money),
    };
  }
  return out;
};

/**
 * A version, reduced to what this caller may have.
 *
 * @param {object} version   a CostingVersion document or lean object
 * @param {object} ctx       the resolved costing context
 * @param {string[]} withheld  collected block names, appended to in place
 */
function serializeVersion(version, ctx, withheld) {
  const v = version?.toObject ? version.toObject() : version;
  if (!v) return null;

  const caps = ctx?.capabilitySet;
  const calculated = Boolean(v.calculation?.engineVersion) && (v.scenarios || []).some((s) => s.unitCostMinor !== undefined);

  const internal = canSeeInternalRecord(ctx);

  /* ── WHO SUBMITTED IT AND WHO APPROVED IT ───────────────────────────────
     Internal detail. An output-only reader gets the approved PRICE and no
     part of the argument that produced it — not the submitter, not the
     approver's reason, not that a review ever happened. */
  const lifecycle = internal && v.lifecycle ? {
    submittedByName: v.lifecycle.submittedByName || "",
    submittedAt: v.lifecycle.submittedAt || null,
    submissionNote: v.lifecycle.submissionNote || "",
    approvedByName: v.lifecycle.approvedByName || "",
    approvedAt: v.lifecycle.approvedAt || null,
    approvalNote: v.lifecycle.approvalNote || "",
    policyRevisionAtApproval: v.lifecycle.policyRevisionAtApproval ?? null,
    supersededByVersionNumber: v.lifecycle.supersededByVersionNumber ?? null,
    supersededAt: v.lifecycle.supersededAt || null,
  } : null;

  /* ── WHAT THIS READER MAY DO NEXT ───────────────────────────────────────
     Derived from the capability AND the state, server-side. A client that
     worked it out itself would be a second copy of the rule, and the two
     would disagree the first time either changed — with the client's copy
     being the one people saw. */
  const actions = internal ? {
    canSubmitForReview: hasAll(caps, C.DRAFT_WRITE) && v.status === "DRAFT",
    canApprove: hasAll(caps, C.APPROVE) && v.status === "IN_REVIEW",
    /* Said explicitly, so an editor waiting for somebody else sees a reason
       rather than an absent button. */
    awaitingOtherApprover: v.status === "IN_REVIEW" && !hasAll(caps, C.APPROVE),
  } : null;

  const out = {
    id: idOf(v._id),
    costingId: idOf(v.costingId),
    versionNumber: v.versionNumber,
    ...(lifecycle ? { lifecycle } : {}),
    ...(actions ? { actions } : {}),
    status: v.status,
    baseCurrency: v.baseCurrency,
    calculationSchemaVersion: v.calculationSchemaVersion ?? 0,
    calculated,
    provenance: {
      origin: v.provenance?.origin || "MANUAL",
      createdAt: v.provenance?.createdAt || v.createdAt || null,
      createdByName: v.provenance?.createdByActorName || "",
      supersedesVersionNumber: v.provenance?.supersedesVersionNumber ?? null,
      note: v.provenance?.note || "",
    },
    /* ── THE SHAPE OF THE COSTING, WITHOUT ITS NUMBERS ──────────────────
       How many pieces each scenario is for is not a cost, a supplier price or
       a margin — it is the question being asked. The answers live in the
       gated blocks below. */
    scenarios: (v.scenarios || []).map((s) => ({
      key: s.key,
      label: s.label || "",
      quantity: s.quantity ?? null,
      quantityUom: s.quantityUom ?? null,
      isPrimary: Boolean(s.isPrimary),
    })),
    /* Data-quality notes. A reader who cannot see the cost still has to know
       the cost was built on provisional inputs — that is the roadmap's
       "label provisional inputs honestly", and hiding it would make an
       imported guess look like a verified rate. The LINE KEYS are cost detail
       and are stripped below. */
    warnings: (v.calculation?.warnings || []).map((w) => ({
      code: w.code,
      message: w.message || "",
      ...(hasAll(caps, C.COST_READ) && w.lineKeys ? { lineKeys: w.lineKeys } : {}),
    })),
    /* Not confidential: how many inputs a version has is not what any of them
       said. The inputs themselves live in the `cost` block. */
    sourceReferenceCount: (v.sourceReferences || []).length,
    inputCount: (v.inputs || []).length,
  };

  /* ── COST ──────────────────────────────────────────────────────────────
     The build-up: what was put in, what each line came to, what the totals
     are. Supplier rates live here and nowhere else. */
  if (hasAll(caps, C.COST_READ)) {
    out.cost = {
      calculated,
      calculationSchemaVersion: v.calculationSchemaVersion ?? 0,
      engineVersion: v.calculation?.engineVersion ?? 0,
      calculatedAt: v.calculation?.calculatedAt || null,
      /* The cost-shaping half of the policy. The MARGIN half is in its own
         block: a costing clerk may need the overhead rate and have no
         business knowing what the company adds on top. */
      policy: v.policySnapshot ? {
        revision: v.policySnapshot.revision ?? 0,
        baseCurrency: v.policySnapshot.baseCurrency,
        roundingMode: v.policySnapshot.roundingMode,
        sellingPriceIncrementMinor: v.policySnapshot.sellingPriceIncrementMinor,
        overheadBasis: v.policySnapshot.overheadBasis ?? null,
        overheadRatePercent: v.policySnapshot.overheadRatePercent ?? null,
      } : null,
      /* What the version was built FROM, as it read then — Chunk 1's typed
         source snapshots, which carry supplier prices and therefore belong
         here rather than on the envelope. Unchanged by Chunk 2: the new
         `inputs` below are the cost lines, which is a different question. */
      sourceReferences: (v.sourceReferences || []).map((sr) => ({
        sourceType: sr.sourceType,
        sourceId: idOf(sr.sourceId),
        sourceKey: sr.sourceKey ?? null,
        label: sr.label || "",
        confidence: sr.confidence,
        capturedAt: sr.capturedAt || null,
        snapshot: (sr.snapshot || []).map(serializeFact),
      })),
      /* ── THE FROZEN COMMERCIAL EVIDENCE (Chunk 3.2) ───────────────────
         Inside the COST block, because a supplier's quoted rate is supplier
         pricing — the thing `costing.cost.read` gates. An output-only reader
         sees the approved selling price and no part of what it was built
         from, which is the boundary Chunk 1 drew and this does not widen. */
      /* ── WHAT THE COMPANY CHARGED FOR ITS OWN WORK ─────────────────
         Inside the COST block with the quotations: a development charge IS
         a cost figure, and an output-only reader who could see it would have
         the cost by another route. */
      /* ── THE FREIGHT WORKING, FOR WHOEVER MAY SEE COST ────────────
         Inside the `cost` block, so it is withheld by exactly the rule that
         withholds every other build-up figure: a reader who may see an
         approved price but not the internal cost does not see the
         transporter's rate either. */
      ...(v.freightProvenance ? {
        freightProvenance: {
          lineKey: v.freightProvenance.lineKey,
          state: v.freightProvenance.state,
          arrangement: v.freightProvenance.arrangement || null,
          arrangementSource: v.freightProvenance.arrangementSource || null,
          prepaidTreatment: v.freightProvenance.prepaidTreatment || null,
          recovery: v.freightProvenance.recovery || null,
          recoveryMarkup: v.freightProvenance.recoveryMarkup || null,
          enquiryRef: v.freightProvenance.enquiryRef || null,
          origin: v.freightProvenance.originWarehouseId ? {
            warehouseId: String(v.freightProvenance.originWarehouseId),
            name: v.freightProvenance.originName || null,
            city: v.freightProvenance.originCity || null,
          } : null,
          destination: v.freightProvenance.destinationAddressId ? {
            addressId: String(v.freightProvenance.destinationAddressId),
            label: v.freightProvenance.destinationLabel || null,
            city: v.freightProvenance.destinationCity || null,
            region: v.freightProvenance.destinationRegion || null,
            country: v.freightProvenance.destinationCountry || null,
          } : null,
          mode: v.freightProvenance.mode || null,
          supplierId: v.freightProvenance.supplierId ? String(v.freightProvenance.supplierId) : null,
          supplierName: v.freightProvenance.supplierName || null,
          offerId: v.freightProvenance.offerId ? String(v.freightProvenance.offerId) : null,
          offerRevision: v.freightProvenance.offerRevision ?? null,
          quotationReference: v.freightProvenance.quotationReference || null,
          quotationDate: v.freightProvenance.quotationDate || null,
          effectiveFrom: v.freightProvenance.effectiveFrom || null,
          validUntil: v.freightProvenance.validUntil || null,
          basis: v.freightProvenance.basis || null,
          rateMinor: v.freightProvenance.rateMinor ?? null,
          currency: v.freightProvenance.currency || null,
          minimumChargeMinor: v.freightProvenance.minimumChargeMinor ?? null,
          taxTreatment: v.freightProvenance.taxTreatment || null,
          gstRatePercent: v.freightProvenance.gstRatePercent ?? null,
          packedWeightGrams: v.freightProvenance.packedWeightGrams ?? null,
          garmentsPerCarton: v.freightProvenance.garmentsPerCarton ?? null,
          deliveryCount: v.freightProvenance.deliveryCount ?? null,
          scenarios: (v.freightProvenance.scenarios || []).map((sc) => ({
            scenarioKey: sc.scenarioKey,
            quantity: sc.quantity || null,
            chargeableUnit: sc.chargeableUnit || null,
            chargeable: sc.chargeable || null,
            working: sc.working || null,
            beforeMinimumMinor: sc.beforeMinimumMinor ?? null,
            minimumChargeApplied: Boolean(sc.minimumChargeApplied),
            freightMinor: sc.freightMinor ?? null,
          })),
          asOf: v.freightProvenance.asOf || null,
        },
      } : {}),
      /* ── AND WHAT IT COST TO WAIT TO BE PAID ──────────────────────
         Inside the `cost` block with the rest of the build-up. The Board's
         approved rate is company financial information and the customer's
         payment terms are commercial, so a reader who may see an approved
         selling price but not the internal cost sees neither.

         Published from the version's own frozen record, never re-resolved:
         the whole reason it is frozen is that a policy approved since, or a
         customer who has renegotiated since, must not restate it. */
      /* ── AND WHAT THE COMPANY ADDED TO COVER RUNNING ITSELF ───────
         Inside the `cost` block with the rest of the build-up. The Board's
         approved rate is company financial information, so a reader who may
         see an approved selling price but not the internal cost does not see
         it — nor the subtotal it was applied to, which would give the cost by
         another route.

         Published from the version's own frozen record, never re-resolved. */
      /* ── AND WHAT A MINUTE OF AN OPERATOR'S TIME COST ─────────────
         Inside the `cost` block with the rest of the build-up: the Board's
         methodology is company financial information, and the per-operation
         workings carry salaries. A reader who may see an approved selling
         price but not the internal cost sees neither. */
      /* ── WHO DECIDED THE TAX TREATMENT ON EVERY PURCHASED LINE ────
         Inside the `cost` block: it is a company financial decision, and a
         reader who may see an approved price but not the internal cost sees
         neither it nor the per-line tax it produced. */
      ...(v.gstProvenance ? {
        gstProvenance: {
          state: v.gstProvenance.state,
          boardPolicyId: v.gstProvenance.boardPolicyId ? String(v.gstProvenance.boardPolicyId) : null,
          policyKey: v.gstProvenance.policyKey || null,
          policyEffectiveFrom: v.gstProvenance.policyEffectiveFrom || null,
          policyApprovedAt: v.gstProvenance.policyApprovedAt || null,
          policyApprovedByName: v.gstProvenance.policyApprovedByName || "",
          inputGstTreatment: v.gstProvenance.inputGstTreatment || null,
          asOf: v.gstProvenance.asOf || null,
        },
      } : {}),
      ...(v.labourProvenance ? {
        labourProvenance: {
          state: v.labourProvenance.state,
          boardPolicyId: v.labourProvenance.boardPolicyId
            ? String(v.labourProvenance.boardPolicyId) : null,
          policyKey: v.labourProvenance.policyKey || null,
          policyEffectiveFrom: v.labourProvenance.policyEffectiveFrom || null,
          policyApprovedAt: v.labourProvenance.policyApprovedAt || null,
          policyApprovedByName: v.labourProvenance.policyApprovedByName || "",
          productiveBasis: v.labourProvenance.productiveBasis || null,
          productiveMinutesPerMonth: v.labourProvenance.productiveMinutesPerMonth ?? null,
          labourEfficiencyPercent: v.labourProvenance.labourEfficiencyPercent ?? null,
          productiveMinutesResolved: v.labourProvenance.productiveMinutesResolved ?? null,
          employerBurdenPercent: v.labourProvenance.employerBurdenPercent ?? null,
          machineBurdenTreatment: v.labourProvenance.machineBurdenTreatment || null,
          machineExclusionReason: v.labourProvenance.machineExclusionReason || "",
          dependencies: (v.labourProvenance.dependencies || []).map((d) => ({
            code: d.code, message: d.message,
          })),
          operations: (v.labourProvenance.operations || []).map((o) => ({
            lineKey: o.lineKey,
            label: o.label || "",
            samMinutes: o.samMinutes ?? null,
            netSalaryPerMonth: o.netSalaryPerMonth ?? null,
            employerCostPerMonth: o.employerCostPerMonth ?? null,
            productiveMinutesPerMonth: o.productiveMinutesPerMonth ?? null,
            productiveBasisLabel: o.productiveBasisLabel || "",
            costPerMinute: o.costPerMinute ?? null,
            amountMinor: o.amountMinor ?? null,
          })),
          asOf: v.labourProvenance.asOf || null,
        },
      } : {}),
      /* ── WHETHER A CONTINGENCY WAS ADDED, AND WHOSE DECISION THAT WAS ─
         Inside the `cost` block with every other build-up figure, so it is
         withheld by exactly the rule that withholds the rest: a reader who may
         see an approved price but not the internal cost does not learn the
         company's contingency posture either. */
      ...(v.contingencyProvenance ? {
        contingencyProvenance: {
          state: v.contingencyProvenance.state,
          mode: v.contingencyProvenance.mode || null,
          boardPolicyId: v.contingencyProvenance.boardPolicyId
            ? String(v.contingencyProvenance.boardPolicyId) : null,
          policyKey: v.contingencyProvenance.policyKey || null,
          policyEffectiveFrom: v.contingencyProvenance.policyEffectiveFrom || null,
          policyApprovedAt: v.contingencyProvenance.policyApprovedAt || null,
          policyApprovedByName: v.contingencyProvenance.policyApprovedByName || "",
          /* Published because for a `NONE` decision it IS the evidence — the
             thing a reader has instead of a line. */
          rationale: v.contingencyProvenance.rationale || "",
          ratePercent: v.contingencyProvenance.ratePercent || null,
          basis: v.contingencyProvenance.basis || null,
          scenarios: (v.contingencyProvenance.scenarios || []).map((x) => ({
            scenarioKey: x.scenarioKey,
            basisAmountMinor: x.basisAmountMinor ?? null,
            contingencyMinor: x.contingencyMinor ?? null,
          })),
        },
      } : {}),
      ...(v.overheadProvenance ? {
        overheadProvenance: {
          lineKey: v.overheadProvenance.lineKey,
          state: v.overheadProvenance.state,
          boardPolicyId: v.overheadProvenance.boardPolicyId
            ? String(v.overheadProvenance.boardPolicyId) : null,
          policyKey: v.overheadProvenance.policyKey || null,
          policyEffectiveFrom: v.overheadProvenance.policyEffectiveFrom || null,
          policyApprovedAt: v.overheadProvenance.policyApprovedAt || null,
          policyApprovedByName: v.overheadProvenance.policyApprovedByName || "",
          ratePercent: v.overheadProvenance.ratePercent ?? null,
          basis: v.overheadProvenance.basis || null,
          scenarios: (v.overheadProvenance.scenarios || []).map((sc) => ({
            scenarioKey: sc.scenarioKey || null,
            quantity: sc.quantity ?? null,
            basisAmountMinor: sc.basisAmountMinor ?? null,
            overheadMinor: sc.overheadMinor ?? null,
            perUnitMinor: sc.perUnitMinor ?? null,
          })),
          asOf: v.overheadProvenance.asOf || null,
        },
      } : {}),
      ...(v.financingProvenance ? {
        financingProvenance: {
          lineKey: v.financingProvenance.lineKey,
          state: v.financingProvenance.state,
          boardPolicyId: v.financingProvenance.boardPolicyId
            ? String(v.financingProvenance.boardPolicyId) : null,
          policyKey: v.financingProvenance.policyKey || null,
          policyEffectiveFrom: v.financingProvenance.policyEffectiveFrom || null,
          policyApprovedAt: v.financingProvenance.policyApprovedAt || null,
          policyApprovedByName: v.financingProvenance.policyApprovedByName || "",
          annualRatePercent: v.financingProvenance.annualRatePercent ?? null,
          basis: v.financingProvenance.basis || null,
          advanceTreatment: v.financingProvenance.advanceTreatment || null,
          dayCountBasis: v.financingProvenance.dayCountBasis ?? null,
          enquiryRef: v.financingProvenance.enquiryRef || "",
          termsState: v.financingProvenance.termsState || null,
          advancePercent: v.financingProvenance.advancePercent ?? null,
          creditDays: v.financingProvenance.creditDays ?? null,
          creditDaysFrom: v.financingProvenance.creditDaysFrom || null,
          termsSource: v.financingProvenance.termsSource || null,
          termsConfirmedAt: v.financingProvenance.termsConfirmedAt || null,
          termsConfirmedByName: v.financingProvenance.termsConfirmedByName || "",
          notApplicableReason: v.financingProvenance.notApplicableReason || "",
          financedSharePercent: v.financingProvenance.financedSharePercent ?? null,
          effectivePercent: v.financingProvenance.effectivePercent ?? null,
          formula: v.financingProvenance.formula || null,
          asOf: v.financingProvenance.asOf || null,
        },
      } : {}),
      policyProvenance: (v.policyProvenance || []).map((p) => ({
        lineKey: p.lineKey,
        state: p.state || "COMPANY_POLICY",
        chargeKey: p.chargeKey || null,
        chargeLabel: p.chargeLabel || null,
        /* How the total was arrived at, not only what it is — a figure a
           reader cannot re-derive is a figure they have to take on trust. */
        calculation: p.calculation || null,
        unit: p.unit || null,
        quantity: p.quantity ?? null,
        unitAmountMinor: p.unitAmountMinor ?? null,
        amountMinor: p.amountMinor ?? null,
        currency: p.currency || null,
        basis: p.basis || null,
        requirementKey: p.requirementKey || null,
        evidence: p.evidence || null,
        effectiveFrom: p.effectiveFrom || null,
        effectiveTo: p.effectiveTo || null,
        policyRevision: p.policyRevision ?? null,
        asOf: p.asOf || null,
      })),
      offerProvenance: (v.offerProvenance || []).map((p) => ({
        lineKey: p.lineKey,
        state: p.state,
        /* Whether the quoted material rate already delivered to our
           warehouse. Absent is unanswered, not landed and not zero. */
        freightTerms: p.freightTerms || null,
        incoterm: p.incoterm || null,
        selectionRule: p.selectionRule || null,
        variantSpecific: p.variantSpecific === true,
        offerId: idOf(p.offerId),
        offerRevision: p.offerRevision ?? null,
        supplierName: p.supplierName || "",
        supplierItemCode: p.supplierItemCode || null,
        supplierItemName: p.supplierItemName || null,
        itemName: p.itemName || null,
        itemSku: p.itemSku || null,
        variantLabel: p.variantLabel || null,
        variantSku: p.variantSku || null,
        document: p.document && (p.document.label || p.document.url || p.document.storedAt)
          ? { label: p.document.label || "", url: p.document.url || "", storedAt: p.document.storedAt || "" }
          : null,
        quotationReference: p.quotationReference || null,
        /* The date on the supplier's own paper. Distinct from `asOf`, which is
           the date the costing was resolved AT — a reader comparing them can
           see how old the quotation was when it was used. */
        quotationDate: p.quotationDate || null,
        asOf: p.asOf || null,
        currency: p.currency,
        quotedAmountMinor: p.quotedAmountMinor ?? null,
        priceBasis: p.priceBasis || null,
        /* Null stays null — a blank rate is not a zero rate. */
        gstRatePercent: p.gstRecorded ? (p.gstRatePercent ?? null) : null,
        gstRecorded: Boolean(p.gstRecorded),
        /* ── THE TAX POSITION, WHOLE ───────────────────────────────────
           The rate alone does not say whether the company got that GST back,
           and that is the difference between the tax being cost and not being
           cost. A version that showed only a rate could not be re-read.

           `hsnCode` comes from the quotation because the item master carries
           none — showing it here, sourced from the offer, keeps that visible
           rather than implying a classification the master never held. */
        gstTreatment: p.gstTreatment || null,
        hsnCode: p.hsnCode || null,
        gstAmountMinor: p.gstAmountMinor ?? null,
        grossRateMinor: p.grossRateMinor ?? null,
        /* Which rule produced the rounded figures, so they can be checked. */
        roundingMode: p.roundingMode || null,
        netRateMinor: p.netRateMinor ?? null,
        netRateDerived: Boolean(p.netRateDerived),
        purchaseUom: p.purchaseUom || null,
        consumptionUom: p.consumptionUom || null,
        conversionFactor: p.conversionFactor || null,
        conversionPath: p.conversionPath || null,
        priceSource: p.priceSource || null,
        tierMinQuantity: p.tierMinQuantity ?? null,
        /* Null is an open-ended band, not a missing ceiling. */
        tierMaxQuantity: p.tierMaxQuantity ?? null,
        /* The supplier quantity the tier was judged on, and how each
           scenario reached it. */
        quantityPerUnit: p.quantityPerUnit || null,
        appliedPurchaseQuantity: p.appliedPurchaseQuantity || null,
        /* ── PACKAGING'S BASIS, AND THE SERVICE REGISTER'S OWN FACTS ────
           A carton bought for the ORDER has no per-piece consumption, so the
           field that was actually used is named rather than left to be
           inferred from a zero. A service adds a master of its own, a
           billing unit with no conversion, and a minimum charge that floors
           the line total — none of which a material line has to say. */
        behaviour: p.behaviour || null,
        quantityPerRun: p.quantityPerRun || null,
        fixedAmountMinor: p.fixedAmountMinor ?? null,
        family: p.family || null,
        serviceId: idOf(p.serviceId),
        serviceCode: p.serviceCode || null,
        serviceName: p.serviceName || null,
        supplierServiceCode: p.supplierServiceCode || null,
        supplierServiceName: p.supplierServiceName || null,
        sacCode: p.sacCode || null,
        billingUnit: p.billingUnit || null,
        requestedUnit: p.requestedUnit || null,
        basis: p.basis || null,
        /* Measured on the sample, or planned for production. */
        evidence: p.evidence || null,
        minimumChargeMinor: p.minimumChargeMinor ?? null,
        minimumChargeApplied: Boolean(p.minimumChargeApplied),
        appliedServiceQuantity: p.appliedServiceQuantity || null,
        scenarioQuantities: (p.scenarioQuantities || []).map((sq) => ({
          outputQuantity: sq.outputQuantity,
          purchaseQuantity: sq.purchaseQuantity,
        })),
        /* ── WHAT EACH QUANTITY REACHED (Chunk 5A) ─────────────────────
           Inside the COST block with everything else here: a quoted tier IS
           supplier pricing, and an economies-of-scale explanation that named
           the rate would hand an output-only reader the cost by another
           route. Absent on versions written before this chunk, and absence
           means one rate applied to every scenario. */
        scenarios: (p.scenarios || []).map((sc) => ({
          scenarioKey: sc.scenarioKey,
          outputQuantity: sc.outputQuantity || null,
          purchaseQuantity: sc.purchaseQuantity || null,
          purchaseUom: sc.purchaseUom || null,
          priceSource: sc.priceSource || null,
          tierMinQuantity: sc.tierMinQuantity ?? null,
          tierMaxQuantity: sc.tierMaxQuantity ?? null,
          quotedAmountMinor: sc.quotedAmountMinor ?? null,
          netRateMinor: sc.netRateMinor ?? null,
          netRateDerived: Boolean(sc.netRateDerived),
          gstAmountMinor: sc.gstAmountMinor ?? null,
          grossRateMinor: sc.grossRateMinor ?? null,
          effectiveRateMinor: sc.effectiveRateMinor ?? null,
          conversionFactor: sc.conversionFactor || null,
          taxTreatment: sc.taxTreatment || null,
          /* Both figures, so a reader can see the floor doing its work. */
          serviceQuantity: sc.serviceQuantity || null,
          billingUnit: sc.billingUnit || null,
          lineNetBeforeMinimumMinor: sc.lineNetBeforeMinimumMinor ?? null,
          lineNetMinor: sc.lineNetMinor ?? null,
          minimumChargeApplied: Boolean(sc.minimumChargeApplied),
        })),
        moq: p.moq ?? null,
        orderMultiple: p.orderMultiple ?? null,
        leadTimeDays: p.leadTimeDays ?? null,
        effectiveFrom: p.effectiveFrom || null,
        validUntil: p.validUntil || null,
      })),
      inputs: (v.inputs || []).map((l) => ({
        lineKey: l.lineKey,
        category: l.category,
        label: l.label || "",
        behaviour: l.behaviour,
        confidence: l.confidence,
        note: l.note || "",
        ...(l.unitRate ? { unitRate: { amountMinor: l.unitRate.amountMinor, currency: l.unitRate.currency, display: formatMinor(l.unitRate) } } : {}),
        ...(l.quantityPerUnit !== undefined ? { quantityPerUnit: l.quantityPerUnit } : {}),
        ...(l.quantityUom ? { quantityUom: l.quantityUom } : {}),
        ...(l.amount ? { amount: { amountMinor: l.amount.amountMinor, currency: l.amount.currency, display: formatMinor(l.amount) } } : {}),
        ...(l.basis ? { basis: l.basis, percent: l.percent } : {}),
        tax: { treatment: l.tax?.treatment || "NONE", ratePercent: l.tax?.ratePercent ?? null },
      })),
      scenarios: (v.scenarios || []).map((s) => ({
        key: s.key,
        quantity: s.quantity,
        totalCostMinor: s.totalCostMinor ?? null,
        unitCostMinor: s.unitCostMinor ?? null,
        fixedTotalMinor: s.fixedTotalMinor ?? null,
        fixedPerUnitMinor: s.fixedPerUnitMinor ?? null,
        variableTotalMinor: s.variableTotalMinor ?? null,
        variablePerUnitMinor: s.variablePerUnitMinor ?? null,
        /* Named rather than hidden: unit × quantity does not always equal the
           total, and a reader comparing them deserves the difference. */
        roundingAdjustmentMinor: s.roundingAdjustmentMinor ?? 0,
        /* Funded by the buyer, reclaimed by the company, never part of cost. */
        recoverableTaxMinor: s.recoverableTaxMinor ?? 0,
        /* The customer's own freight, at cost, on its own line — and the cost
           the garment's price was actually derived from. */
        recoveredSeparatelyMinor: s.recoveredSeparatelyMinor ?? 0,
        recoveredSeparatelyPerUnitMinor: s.recoveredSeparatelyPerUnitMinor ?? 0,
        pricedUnitCostMinor: s.pricedUnitCostMinor ?? null,
        categorySubtotals: s.categorySubtotals || [],
        lines: s.lines || [],
        /* ── WHY THE UNIT COST MOVED, WITH ITS CAUSES ───────────────────
           Fixed-cost dilution and — since Chunk 5A — supplier quantity tiers,
           each attributed to the line it came from. Inside the COST block
           deliberately: an explanation naming a quoted rate hands an
           output-only reader the supplier's price by another route, which is
           the disclosure the block gate exists to prevent. */
        comparedToPrimary: s.comparedToPrimary || null,
      })),
    };
    /* ── WAS EVERY COST FAMILY ADDRESSED? (Chunk 4C) ──────────────────
       In the COST block, because it is a statement about the cost build and
       carries cost amounts. Null on a version frozen before this existed —
       and the screen says "not recorded", never "complete". */
    out.cost.completeness = v.completeness ? {
      recorded: true,
      costComplete: v.completeness.costComplete === true,
      assessedAt: v.completeness.assessedAt || null,
      coverageSchemaVersion: v.completeness.coverageSchemaVersion ?? 1,
      scenarioKey: v.completeness.scenarioKey || null,
      families: (v.completeness.families || []).map((f) => ({
        key: f.key,
        label: f.label || f.key,
        state: f.state,
        /* Null, never 0, for a family with no amount. */
        totalMinor: f.totalMinor ?? null,
        perUnitMinor: f.perUnitMinor ?? null,
        basis: f.basis || null,
        /* AUTOMATIC and POLICY families are fixed at their source; only a
           family with no source anywhere takes a hand-entered figure. The
           screen cannot tell which without this. */
        authority: f.authority || null,
        owner: (f.ownerDepartment || f.ownerSystem)
          ? { department: f.ownerDepartment || null, system: f.ownerSystem || null }
          : null,
        reason: f.reason || null,
        /* ── AND WHOSE DECISION IT WAS ────────────────────────────────
           A not-applicable family is answered in the owning department's own
           record. Published so a reader can go and check it — the difference
           between a reason taken on trust and one that can be verified.
           Absent on versions frozen while Costing owned the decision. */
        decidedByDepartment: f.decidedByDepartment || null,
        decidedIn: f.decidedIn || null,
        decidedByName: f.decidedByName || null,
        decidedAt: f.decidedAt || null,
      })),
    } : {
      recorded: false,
      /* NOT false, and not true. Unassessed is its own answer, and rendering
         it as either would be a claim nobody made. */
      costComplete: null,
      families: [],
    };

    /* ── AND WHERE EACH ONE GETS ANSWERED (Lane B) ────────────────────
       The coverage assessment says WHETHER a family was answered. This says
       what is missing, which desk owns it, and where that person records it —
       so a gap stops being a chip that does nothing.

       Derived from the FROZEN version only (see inputReadiness.js): a
       supplier revising a quotation or Finance publishing a new rate cannot
       change what an already frozen version says about itself.

       In the COST block because it repeats the family's basis and amounts;
       an output-only reader sees the approved commercial figure and none of
       this. Packaging is excluded — it is Lane A's family. */
    out.cost.inputReadiness = inputReadiness.forVersion({
      completeness: out.cost.completeness,
      version: out.cost,
      policySnapshot: v.policySnapshot || null,
    });
  } else {
    withheld.add("cost");
  }

  /* ── MARGIN ────────────────────────────────────────────────────────────
     The band the company set, and what each rounded price actually realises.
     Gated separately from cost on purpose: COST does not imply MARGIN. */
  if (hasAll(caps, C.MARGIN_READ)) {
    out.margin = {
      calculated,
      /* ── THE PRICING RULE THIS VERSION WAS CALCULATED UNDER ────────
         One markup on a version priced by the floor policy; the three band
         figures on one frozen under the retired model. Both are read off the
         snapshot, so a version reports what it was actually calculated with
         rather than what the company's policy says today. */
      band: v.policySnapshot ? {
        policyRevision: v.policySnapshot.revision ?? 0,
        pricingContract: v.policySnapshot.pricingContract
          ?? (v.policySnapshot.minimumMarginPercent ? "MARGIN_BAND_V1" : null),
        floorMarkupPercent: v.policySnapshot.floorMarkupPercent ?? null,
        minimumMarginPercent: v.policySnapshot.minimumMarginPercent,
        targetMarginPercent: v.policySnapshot.targetMarginPercent,
        preferredMarginPercent: v.policySnapshot.preferredMarginPercent,
        approvalThresholdMarginPercent: v.policySnapshot.approvalThresholdMarginPercent ?? null,
        /* The company's own estimate, as it stood when this version froze.
           Null, never 0 — no rate configured and a rate of nil are different
           answers, and only the second is a decision. */
        estimatedIncomeTaxRatePercent: v.policySnapshot.estimatedIncomeTaxRatePercent ?? null,
      } : null,
      /* ── AND WHOSE DECISION THAT BAND WAS ─────────────────────────────
         Inside the MARGIN block, so it is withheld by exactly the rule that
         withholds the band itself: a reader entitled to see what a garment
         costs is not thereby entitled to see what the company is prepared to
         sell it for, nor who decided that.

         The values are the same ones the snapshot above carries — repeated
         here with their identity rather than referenced, so a reader has the
         decision and its provenance in one place instead of having to trust
         that two blocks agree. */
      provenance: v.marginProvenance ? {
        state: v.marginProvenance.state,
        boardPolicyId: v.marginProvenance.boardPolicyId
          ? String(v.marginProvenance.boardPolicyId) : null,
        policyKey: v.marginProvenance.policyKey || null,
        policyEffectiveFrom: v.marginProvenance.policyEffectiveFrom || null,
        policyApprovedAt: v.marginProvenance.policyApprovedAt || null,
        policyApprovedByName: v.marginProvenance.policyApprovedByName || "",
        rationale: v.marginProvenance.rationale || "",
        minimumMarginPercent: v.marginProvenance.minimumMarginPercent || null,
        targetMarginPercent: v.marginProvenance.targetMarginPercent || null,
        preferredMarginPercent: v.marginProvenance.preferredMarginPercent || null,
        approvalThresholdMarginPercent: v.marginProvenance.approvalThresholdMarginPercent || null,
        /* Published with the number, because the number alone would imply an
           approval step that does not exist. */
        approvalThresholdEnforced: v.marginProvenance.approvalThresholdEnforced === true,
        estimatedIncomeTaxRatePercent: v.marginProvenance.estimatedIncomeTaxRatePercent || null,
      } : null,
      scenarios: (v.scenarios || []).map((s) => ({
        key: s.key,
        /* ── THE FLOOR, AND THE RULE THAT PRODUCED IT ──────────────────
           `margin.read` is the COMMERCIAL right: the price, the markup the
           Board approved, and the method. It is NOT the cost right.

           ── AND THE TWO FIELDS THAT ARE COST IN DISGUISE ───────────────
           `trueUnitCostMinor` is the unit cost outright, and
           `markupAmountMinor` gives it away by subtraction — floor minus
           markup IS the cost. Publishing either here would hand a
           margin-only reader the build-up that `cost.read` exists to gate,
           through a block named after a different permission. So both are
           held back unless the reader also holds cost. */
        floor: s.floor ? {
          floorMarkupPercent: s.floor.floorMarkupPercent,
          calculationMethod: s.floor.calculationMethod || "MARKUP_ON_TRUE_COST",
          floorPriceMinor: s.floor.floorPriceMinor,
          roundingIncrementMinor: s.floor.roundingIncrementMinor ?? 1,
          roundingUpliftMinor: s.floor.roundingUpliftMinor ?? 0,
          realisedReturnOnPricePercent: s.floor.realisedReturnOnPricePercent ?? null,
          ...(hasAll(caps, C.COST_READ) ? {
            trueUnitCostMinor: s.floor.trueUnitCostMinor,
            markupAmountMinor: s.floor.markupAmountMinor,
          } : {}),
        } : null,
        /* Empty on a floor-priced version rather than absent, because this
           key has always been an object and a consumer iterating it should
           find nothing rather than crash. */
        effective: ["minimum", "target", "preferred"].reduce((acc, tier) => {
          const p = s.prices?.[tier];
          if (p) acc[tier] = { requestedMarginPercent: p.requestedMarginPercent, effectiveMarginPercent: p.effectiveMarginPercent };
          return acc;
        }, {}),
      })),
      /* ── THE COST-TO-PROFIT BRIDGE (Chunk 4B) ─────────────────────────
         What somebody proposed to sell at, and what that leaves before and
         after estimated income tax. Behind MARGIN_READ, not COST_READ: what
         a price earns is commercial information, and a reader entitled to
         see what a garment costs is not thereby entitled to see what the
         company makes on it.

         Absent, not empty, on a costing nobody has proposed a price for. */
      bridge: v.commercial ? {
        currency: v.commercial.currency || null,
        estimatedIncomeTaxRatePercent: v.commercial.estimatedIncomeTaxRatePercent ?? null,
        incomeTaxRateSource: v.commercial.incomeTaxRateSource || null,
        /* Said in the response, not only in the UI: every figure below is an
           estimate, and the tax one is not a statutory liability. */
        basis: "PRE_PRODUCTION_ESTIMATE",
        capturedAt: v.commercial.capturedAt || null,
        scenarios: (v.commercial.bridge || []).map((b) => ({
          scenarioKey: b.scenarioKey,
          proposedPriceExclTaxMinor: b.proposedPriceExclTaxMinor,
          proposedRevenueTotalMinor: b.proposedRevenueTotalMinor ?? null,
          /* The floor the standing was judged against, so a reader sees the
             comparison and not only its verdict. */
          floorPriceMinor: b.floorPriceMinor ?? null,
          unitCostMinor: b.unitCostMinor,
          totalCostMinor: b.totalCostMinor,
          preTaxProfitUnitMinor: b.preTaxProfitUnitMinor,
          preTaxProfitTotalMinor: b.preTaxProfitTotalMinor,
          markupPercent: b.markupPercent ?? null,
          marginPercent: b.marginPercent ?? null,
          standing: b.standing || null,
          estimatedIncomeTaxUnitMinor: b.estimatedIncomeTaxUnitMinor ?? null,
          estimatedIncomeTaxTotalMinor: b.estimatedIncomeTaxTotalMinor ?? null,
          afterTaxProfitUnitMinor: b.afterTaxProfitUnitMinor ?? null,
          afterTaxProfitTotalMinor: b.afterTaxProfitTotalMinor ?? null,
        })),
      } : null,
    };
  } else {
    withheld.add("margin");
  }

  /* ── OUTPUT ────────────────────────────────────────────────────────────
     The commercial number Sales may quote. It exists only for an APPROVED
     version, and Chunk 6 owns approval — so in this chunk it is always
     `approved: false`, and a caller holding only `costing.output.read` never
     reaches a draft at all (see `mayRead`). Wiring the gate now means Chunk 6
     switches a status rather than remembering to add a guard. */
  if (hasAll(caps, C.OUTPUT_READ)) {
    out.output = v.status === "APPROVED"
      ? {
          approved: true,
          calculated,
          currency: v.baseCurrency,
          quantityBreaks: (v.scenarios || []).map((s) => ({
            key: s.key,
            label: s.label || "",
            quantity: s.quantity,
            /* ── ONE FLOOR PRICE, AND NOTHING THAT BUILT IT ───────────
               The lowest price this quantity may be sold at. Deliberately
               ALONE: `floorMarkupPercent`, `trueUnitCostMinor` and
               `markupAmountMinor` sit on the same subdocument and none of
               them crosses this boundary. A reader entitled to quote a price
               is not thereby entitled to the company's cost, nor to what the
               Board marks it up by — either would let a customer-facing
               conversation disclose both. */
            floorPriceMinor: s.floor?.floorPriceMinor ?? null,
            /* Which contract priced it, so a consumer can tell a one-floor
               version from a historical three-tier one without guessing from
               which fields happen to be null. */
            pricingContract: s.floor
              ? "MARKUP_FLOOR_V2"
              : (s.prices?.minimum ? "MARGIN_BAND_V1" : null),
            /* ── THE RETIRED TIERS, ON HISTORICAL VERSIONS ONLY ───────
               Null on every version priced by a markup. They are not
               recomputed and not synthesised: a version that never had them
               does not get them invented, and one that has them keeps
               showing exactly what it froze. */
            minimumPriceMinor: s.prices?.minimum?.priceMinor ?? null,
            targetPriceMinor: s.prices?.target?.priceMinor ?? null,
            preferredPriceMinor: s.prices?.preferred?.priceMinor ?? null,
            /* ── FREIGHT THE CUSTOMER IS BILLED SEPARATELY ────────────
               Prepaid freight recovered at cost. It is NOT in the prices
               above — a margin on somebody's own reimbursement is not a
               margin anybody agreed to — so it travels beside them, as the
               approved figure to put on its own quotation line.

               The AMOUNT crosses; the transporter's rate, their name and the
               quotation reference do not. Those are internal cost, behind
               `cost.read`, and this block is what a Sales reader may see. */
            separateFreightMinor: s.recoveredSeparatelyMinor || 0,
            separateFreightPerUnitMinor: s.recoveredSeparatelyPerUnitMinor || 0,
          })),
          /* Said once, so nobody has to infer it from two figures that
             happen to match: the recovery carries no markup. */
          separateFreightBasis: (v.scenarios || []).some((s) => s.recoveredSeparatelyMinor)
            ? "AT_COST" : null,
        }
      : { approved: false, reason: "NO_APPROVED_VERSION" };
  } else {
    withheld.add("output");
  }

  return out;
}

/**
 * The whole envelope, and the only shape any costing endpoint returns.
 *
 * `visibility` is part of the contract rather than a debugging extra: without
 * it a client cannot tell "there is no cost yet" from "you may not see the
 * cost", and it would guess — which is how a screen ends up implying a costing
 * is empty when it is merely confidential.
 */
function serialize({ costing, versions = [], ctx }) {
  const withheld = new Set();
  const list = versions.map((v) => serializeVersion(v, ctx, withheld));
  return {
    costing: serializeCosting(costing, ctx),
    versions: list,
    visibility: {
      capabilities: [...(ctx?.capabilitySet || [])].sort(),
      withheld: [...withheld].sort(),
      /* Which company and by what strength of proof. A client that shows more
         than one company needs it, and an operator diagnosing a fail-closed
         refusal needs it more. */
      companyId: idOf(ctx?.companyId),
      membershipSource: ctx?.membershipSource || null,
    },
  };
}

module.exports = {
  BLOCK_CAPABILITY, canSeeInternalRecord, hasApprovedOutput, mayRead,
  serializeCosting, serializeVersion, serialize,
};
