// services/merchandising/tnaSourceEvents.js
//
// WHICH SOURCE EVENTS TIME & ACTION CAN ACTUALLY BE CLOSED BY — the one list.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// A milestone declared `SOURCE_EVENT` cannot be completed by hand: the whole
// point is that its date is the date the thing happened, taken from the record
// that happened. That is right when a producer exists. When one does not, the
// milestone is unreachable — nobody can tick it and nothing will ever close
// it — and until now a template could name any string at all and publish
// happily. The audit of 27 Sep 2026 found most source-owned milestones in
// exactly that state, counted as ordinary work somebody had failed to do.
//
// So there is one registry, on the server, and three answers:
//
//   INTEGRATED      a real producer publishes this and T&A consumes it.
//   MANUAL          no source event; an authorised person completes it.
//   NOT_INTEGRATED  the template intends it to be automatic and NOTHING in
//                   this repository publishes it. A milestone waiting on one
//                   is not late; it is disconnected, and it says so.
//
// ── AND IT IS NOT DUPLICATED IN A BROWSER ───────────────────────────────────
// The frontend gets this through the API. A second array in a React file is
// how a screen ends up promising an integration that was removed three months
// ago, and is explicitly refused by `tnaIntegration.test.mjs`.
//
// ── ADDING A PRODUCER ───────────────────────────────────────────────────────
// Move the kind from `PLANNED` to `SUPPORTED` in the same change that makes
// the producer publish it and the consumer accept it. Never before: a kind
// listed here as integrated is a promise that a milestone naming it will
// close on its own.
"use strict";

const { OUTBOX_KIND } = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");

/* ── WHAT IS WIRED, TODAY ──────────────────────────────────────────────────
   Each of these has a producer in this repository that writes the event to
   the Merchandising outbox, and `tnaIntake` consumes it. */
const SUPPORTED = Object.freeze([
  {
    kind: OUTBOX_KIND.MATERIAL_TRIM_APPROVED,
    label: "Materials & trims approved",
    producer: "Merchandising — selection approval",
    /* Where the milestone's traceable source reference comes from, per kind.
       Read by `tnaIntake.applyEvent`, so a new producer states its own shape
       here rather than teaching the consumer about itself. */
    reference: { type: "family", ref: "revisionId", version: "revisionNo" },
  },
  {
    kind: OUTBOX_KIND.PACKAGING_APPROVED,
    label: "Packaging approved",
    producer: "Merchandising — selection approval",
    reference: { type: "family", ref: "revisionId", version: "revisionNo" },
  },
  {
    kind: OUTBOX_KIND.DEVELOPMENT_APPROVED,
    label: "Development requirements approved",
    producer: "Merchandising — selection approval",
    reference: { type: "family", ref: "revisionId", version: "revisionNo" },
  },
  {
    kind: OUTBOX_KIND.PPM_ISSUED,
    label: "Pre-production meeting issued",
    producer: "Merchandising — pre-production meeting",
    /* The minutes, not the meeting: a conducted meeting is not evidence. */
    reference: { type: "recordType", ref: "ppmRef", version: "versionNo" },
  },
  {
    kind: OUTBOX_KIND.PACK_SUBMITTED,
    label: "Execution pack submitted",
    producer: "Merchandising — execution pack",
    /* The pack's own id is what its payload carries — it has no separate
       human reference — and the version is what makes "which pack closed
       this" answerable after a successor supersedes it. */
    reference: { type: "recordType", ref: "packId", version: "packVersionNo" },
  },
]);

/* ── WHAT A TEMPLATE MAY ASK FOR AND NOT GET ───────────────────────────────
   Named, because "unknown event" and "event whose producer has not been
   built yet" are different answers to a template author. Each of these is a
   real intention from the durable plan; none has a producer anywhere in this
   repository, which is why a milestone naming one is disconnected rather
   than late.

   These are NOT accepted on a new template version. They are recognised so
   that plans already running on a legacy template can be described honestly
   instead of appearing as work somebody is sitting on. */
const PLANNED = Object.freeze([
  { kind: "source.pp_sample.approved", label: "PP sample approved", owner: "Product Development" },
  { kind: "source.quality.test_passed", label: "Quality test passed", owner: "Quality" },
  { kind: "source.quality.inspection_passed", label: "Final inspection passed", owner: "Quality" },
  { kind: "source.store.material_received", label: "Material received", owner: "Store" },
  { kind: "source.store.material_issued", label: "Material issued", owner: "Store" },
  { kind: "source.ppc.production_planned", label: "Production planned", owner: "PPC" },
  { kind: "source.production.cutting_started", label: "Cutting started", owner: "Production" },
  { kind: "source.production.sewing_completed", label: "Sewing completed", owner: "Production" },
  { kind: "source.production.ex_factory", label: "Goods left the factory", owner: "Production" },
  { kind: "source.logistics.shipment_booked", label: "Shipment booked", owner: "Logistics" },
  { kind: "source.buyer.approval_received", label: "Buyer approval received", owner: "Sales" },

  /* ── NAMED FOR THE MILESTONE LIBRARY, 27 Sep 2026 ─────────────────────
     A milestone definition may only point at a kind named here, so a kind
     has to exist before the company's list can refer to the work. These six
     were added with their milestones and have no producer yet, which is
     exactly what PLANNED means — every one shows as "Not integrated" until
     its owning application publishes.

     Fabric and trims are two kinds rather than one `material_received`
     deliberately: one event kind shared by two milestones would close both
     the moment either material arrived. */
  { kind: "source.store.fabric_in_house", label: "Fabric in house", owner: "Store" },
  { kind: "source.store.trims_in_house", label: "Trims in house", owner: "Store" },
  { kind: "source.production.sewing_started", label: "Sewing started", owner: "Production" },
  { kind: "source.product_development.print_approved", label: "Print approved", owner: "Product Development" },
  { kind: "source.product_development.embroidery_approved", label: "Embroidery approved", owner: "Product Development" },
  { kind: "source.product_development.wash_approved", label: "Wash approved", owner: "Product Development" },
]);

const INTEGRATION = Object.freeze({
  INTEGRATED: "INTEGRATED",
  MANUAL: "MANUAL",
  NOT_INTEGRATED: "NOT_INTEGRATED",
});

const str = (v) => String(v ?? "").trim();

const byKind = new Map(SUPPORTED.map((e) => [e.kind, e]));
const plannedByKind = new Map(PLANNED.map((e) => [e.kind, e]));

/** The kinds `tnaIntake` listens for. Derived, never a second list. */
const supportedKinds = () => SUPPORTED.map((e) => e.kind);

const isSupported = (kind) => byKind.has(str(kind));

/**
 * Every kind this product has a NAME for — wired now, or named and waiting for
 * its owning application. A milestone definition may point at either: one is
 * closed automatically today, the other shows as "Not integrated" until its
 * producer is built. What a definition may NOT point at is a key nobody has
 * ever written down, which is what a free-text field produces.
 */
const knownKinds = () => [...SUPPORTED, ...PLANNED].map((e) => e.kind);

const isKnown = (kind) => byKind.has(str(kind)) || plannedByKind.has(str(kind));

/** How one source-event kind stands, with words a template author can act on. */
function stateOf(kind) {
  const k = str(kind);
  const wired = byKind.get(k);
  if (wired) {
    return {
      kind: k,
      integration: INTEGRATION.INTEGRATED,
      label: wired.label,
      producer: wired.producer,
      sentence: `${wired.label} — published by ${wired.producer}.`,
    };
  }
  const planned = plannedByKind.get(k);
  return {
    kind: k,
    integration: INTEGRATION.NOT_INTEGRATED,
    label: planned?.label || k,
    producer: null,
    owner: planned?.owner || null,
    sentence: planned
      ? `${planned.label} — no application publishes this yet. ${planned.owner} owns the record it would come from.`
      : `Nothing in GRAV publishes "${k}", so a milestone waiting for it can never complete.`,
  };
}

/**
 * HOW ONE MILESTONE DEFINITION STANDS.
 *
 * A milestone is integrated when it is source-owned and at least one of the
 * kinds it names has a producer. It is NOT_INTEGRATED when it is source-owned
 * and none of them does — including a source-owned milestone that names no
 * kind at all, which is the quietest way to be unreachable.
 */
function milestoneIntegration(milestone) {
  const authority = str(milestone?.completionAuthority);
  if (authority !== "SOURCE_EVENT") {
    return { integration: INTEGRATION.MANUAL, kinds: [], unsupported: [] };
  }
  const kinds = (milestone?.sourceEventKinds || []).map(str).filter(Boolean);
  const wired = kinds.filter(isSupported);
  if (wired.length) {
    return { integration: INTEGRATION.INTEGRATED, kinds, unsupported: kinds.filter((k) => !isSupported(k)) };
  }
  return {
    integration: INTEGRATION.NOT_INTEGRATED,
    kinds,
    unsupported: kinds,
    /* One sentence, from the server, so every surface says the same thing. */
    sentence: "This milestone cannot update automatically because its source "
      + "application is not connected yet.",
  };
}

/** True when a milestone can never close on its own and nobody may close it. */
const isNotIntegrated = (milestone) =>
  milestoneIntegration(milestone).integration === INTEGRATION.NOT_INTEGRATED;

/**
 * WHAT A TEMPLATE VERSION MAY NOT BE PUBLISHED WITH.
 *
 * Returns the offending milestones, by code and by kind, so the error names
 * each one rather than reporting "invalid template".
 */
/**
 * WHICH MILESTONES OF A VERSION ABOUT TO BE PUBLISHED CANNOT BE COMPLETED.
 *
 * ── THE RULE, AND THE TWO DIFFERENT QUESTIONS IT SEPARATES ────────────────
 * A `SOURCE_EVENT` milestone cannot be completed by hand — that is the point of
 * it — so one whose event nothing publishes is unreachable: nobody may tick it
 * and nothing will ever arrive. The 27 Sep audit found most source-owned
 * milestones in exactly that state, counted as ordinary work somebody had
 * failed to do.
 *
 * Reading such a milestone and CREATING one are different questions:
 *
 *   • A version already published, and every plan built from it, keeps its
 *     milestones exactly as stored. They read as "Not integrated" and are kept
 *     out of every overdue, at-risk and next-action figure. Nothing here
 *     touches them — this runs at publish, on a DRAFT.
 *   • A version being published now may not contain one at all. A named-but-
 *     unbuilt event is an intention, and a schedule is a commitment; committing
 *     to a date nothing can ever satisfy is the defect, whether the event is a
 *     typo or a plan for next quarter.
 *
 * So a kind must be in `SUPPORTED` — a real producer, publishing today. An
 * empty `sourceEventKinds` is refused for the same reason and is worse: it is
 * unreachable AND unnameable, so there is not even a department to ask.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────
 * It does not offer Merchandising as a way out. `shapeMilestone` refuses
 * `MERCHANDISING` authority on another department's milestone, and rightly:
 * Merchandising coordinates visibility, it cannot declare Quality's inspection
 * passed. The honest consequence is that another department's milestone is not
 * schedulable until that department publishes its event — which is the
 * pressure this gate is for.
 */
function unsupportedInVersion(milestones = []) {
  const offenders = [];
  for (const m of milestones) {
    if (str(m?.completionAuthority) !== "SOURCE_EVENT") continue;
    const kinds = (m?.sourceEventKinds || []).map(str).filter(Boolean);
    if (kinds.length && kinds.every(isSupported)) continue;

    /* Every kind that cannot close it — a planned one, or an invented one. */
    const blocking = kinds.filter((k) => !isSupported(k));
    offenders.push({
      milestoneCode: str(m?.milestoneCode),
      name: str(m?.name),
      kinds: blocking,
      /* Named so the message can say which application owes the producer. */
      owed: blocking.map((k) => stateOf(k).owner || null).filter(Boolean),
      reasons: blocking.length
        ? blocking.map((k) => stateOf(k).sentence)
        : ["It is completed by a system action but names none, so nothing can ever close it."],
    });
  }
  return offenders;
}

/**
 * THE SAME RULE, EXPRESSIBLE IN A QUERY.
 *
 * The counts a merchandiser reads — overdue, at risk, what needs attention —
 * are aggregated in the database over tens of thousands of milestones, not
 * fetched and filtered in Node. So the rule has to exist twice in FORM and
 * once in FACT: this builds the Mongo predicate from the very same
 * `SUPPORTED` list `milestoneIntegration` reads, rather than a hand-written
 * `$nin` elsewhere that would quietly disagree the day a producer is added.
 *
 * `sourceEventKinds: { $nin: [...] }` on an array field means "holds none of
 * these", which also matches a source-owned milestone naming no kind at all —
 * unreachable for the quietest possible reason, and excluded for it.
 */
function excludeUnintegrated() {
  return {
    $nor: [{
      completionAuthority: "SOURCE_EVENT",
      sourceEventKinds: { $nin: supportedKinds() },
    }],
  };
}

/** Its complement: the disconnected milestones, for an integration-gap count. */
function onlyUnintegrated() {
  return {
    completionAuthority: "SOURCE_EVENT",
    sourceEventKinds: { $nin: supportedKinds() },
  };
}

/** The catalogue a template-authoring screen shows. One read, one truth. */
function catalogue() {
  return {
    supported: SUPPORTED.map((e) => ({
      kind: e.kind, label: e.label, producer: e.producer,
      integration: INTEGRATION.INTEGRATED,
    })),
    planned: PLANNED.map((e) => ({
      kind: e.kind, label: e.label, owner: e.owner,
      integration: INTEGRATION.NOT_INTEGRATED,
    })),
    /* Said in the payload so no client has to infer the rule from the lists. */
    note: "A template version may only be published with source events that have a "
      + "producer. Plans already running on an older template keep their milestones; "
      + "those with no producer are shown as not integrated and are excluded from "
      + "overdue, at-risk and next-action figures.",
  };
}

/** Where a closed milestone's traceable reference comes from, per kind. */
function referenceFor(kind, payload = {}) {
  const wired = byKind.get(str(kind));
  if (!wired) return { sourceRecordType: "", sourceRecordRef: "", sourceRecordVersion: null };
  const shape = wired.reference;
  const version = Number(payload?.[shape.version]);
  return {
    sourceRecordType: shape.type === "family"
      ? str(payload?.family)
      : str(wired.label),
    sourceRecordRef: str(payload?.[shape.ref]),
    sourceRecordVersion: Number.isFinite(version) ? version : null,
  };
}

module.exports = {
  INTEGRATION, SUPPORTED, PLANNED,
  supportedKinds, knownKinds, isSupported, isKnown, stateOf,
  milestoneIntegration, isNotIntegrated, unsupportedInVersion,
  catalogue, referenceFor,
  excludeUnintegrated, onlyUnintegrated,
};
