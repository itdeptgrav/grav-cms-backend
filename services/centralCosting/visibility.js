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
    currentVersion: {
      id: idOf(doc.currentVersionId),
      number: doc.currentVersionNumber ?? 0,
    },
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
  const out = {
    id: idOf(v._id),
    costingId: idOf(v.costingId),
    versionNumber: v.versionNumber,
    status: v.status,
    baseCurrency: v.baseCurrency,
    calculationSchemaVersion: v.calculationSchemaVersion ?? 0,
    provenance: {
      origin: v.provenance?.origin || "MANUAL",
      createdAt: v.provenance?.createdAt || v.createdAt || null,
      createdByName: v.provenance?.createdByActorName || "",
      supersedesVersionNumber: v.provenance?.supersedesVersionNumber ?? null,
      note: v.provenance?.note || "",
    },
    /* Reserved for Chunk 2. Present and empty is the truth: the container
       exists, no scenario has been calculated. */
    scenarios: (v.scenarios || []).map((s) => ({
      key: s.key,
      label: s.label || "",
      quantity: s.quantity ?? null,
      quantityUom: s.quantityUom ?? null,
      isPrimary: Boolean(s.isPrimary),
    })),
    /* Not confidential: how many inputs a version has is not what any of them
       said. The inputs themselves live in the `cost` block. */
    sourceReferenceCount: (v.sourceReferences || []).length,
  };

  /* ── COST ──────────────────────────────────────────────────────────────
     Source snapshots carry supplier prices and internal rates, so they belong
     here and not on the envelope. In Chunk 1 there is no calculated total, so
     `calculated` is false and `totals` is absent rather than zero. */
  if (hasAll(caps, C.COST_READ)) {
    out.cost = {
      calculated: false,
      calculationSchemaVersion: v.calculationSchemaVersion ?? 0,
      sourceReferences: (v.sourceReferences || []).map((s) => ({
        sourceType: s.sourceType,
        sourceId: idOf(s.sourceId),
        sourceKey: s.sourceKey ?? null,
        label: s.label || "",
        confidence: s.confidence,
        capturedAt: s.capturedAt || null,
        snapshot: (s.snapshot || []).map(serializeFact),
      })),
    };
  } else {
    withheld.add("cost");
  }

  /* ── MARGIN ────────────────────────────────────────────────────────────
     Reserved for Chunk 2, and gated now so the gate is not something a later
     chunk has to remember to add once there is finally something behind it. */
  if (hasAll(caps, C.MARGIN_READ)) {
    out.margin = { calculated: false };
  } else {
    withheld.add("margin");
  }

  /* ── OUTPUT ────────────────────────────────────────────────────────────
     The approved commercial number. A DRAFT has none, and saying so is not a
     disclosure: a caller who reached this point already knows the costing
     exists. */
  if (hasAll(caps, C.OUTPUT_READ)) {
    out.output = v.status === "APPROVED"
      ? { approved: true, calculated: false }
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
