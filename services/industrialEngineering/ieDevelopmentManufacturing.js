// services/industrialEngineering/ieDevelopmentManufacturing.js
//
// WHAT IE WAS GIVEN TO ENGINEER FROM — the manufacturing facts, read only.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// The development detail endpoint published statuses, images and documents. A
// factory engineer opening Inputs & Handoff could see that R&D had approved
// something and that four files were attached, and could not see what the
// garment is: what it is cut from, what is embroidered where, what each metre
// is consumed at, whether anything goes outside, what tooling it needs, how it
// is packed, or which operations somebody has already written down. All of it
// was stored upstream; none of it crossed.
//
// ── IT PUBLISHES FACTS, NOT A SECOND OPINION ────────────────────────────────
// Every value here is copied from the record that owns it and attributed to the
// desk that owns that record. Nothing is derived into a verdict, nothing is
// re-judged, and nothing is written. Where two desks store the same-sounding
// number, this names which one it published — Merchandising's pack
// configuration rather than R&D's working note, R&D's engineered consumption
// rather than the merchandiser's pick.
//
// ── THE THREE WORDS ─────────────────────────────────────────────────────────
// Each group answers REQUIRED, NOT_REQUIRED or UNKNOWN, and an empty list is
// never an answer by itself. Three families carry a signed decision —
// outside processes (Production's), development tooling and packaging
// (Merchandising's) — read through the one shared helper so an absent decision
// can never read as "no". The other families have no decision in the schema at
// all, so they say UNKNOWN and name the desk that would have to answer.
//
// ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
//   · money of every kind: there is none in these records, and the two places
//     adjacent to it — an operation's payroll-derived salary on the SAMPLE
//     observation rows, and the free-text "item — vendor" material list — are
//     the two things this module drops on purpose;
//   · the service register's own ids and the development charge key, which are
//     the buying side of a process requirement rather than the making side;
//   · the buyer, the account, the order quantity, the delivery date and the
//     work orders, which are commercial facts about an order, not inputs to
//     engineering a garment;
//   · a measurement chart and a construction drawing, because NEITHER EXISTS
//     as a stored record. Measurements live inside the uploaded technical pack
//     as unread bytes. The endpoint already says so in `evidence.unavailable`,
//     and this module repeats the absence rather than inventing a shape.
"use strict";

const applicability = require("../styleApplicability");
const technicalRecord = require("../centralCosting/technicalRecord.service");

/* The desks, in this department's existing vocabulary. */
const OWNER = Object.freeze({
  SALES: "SALES",
  MERCHANDISING: "MERCHANDISING",
  RESEARCH_DEVELOPMENT: "RESEARCH_DEVELOPMENT",
  PRODUCTION: "PRODUCTION",
});

/* REQUIRED / NOT_REQUIRED / UNKNOWN, in the words the decision helper uses so
   the two can never drift. UNKNOWN is `DECISION.UNANSWERED` renamed for a
   reader: "still not decided" is what a person needs to see. */
const APPLICABILITY = Object.freeze({
  REQUIRED: "REQUIRED",
  NOT_REQUIRED: "NOT_REQUIRED",
  UNKNOWN: "UNKNOWN",
});

/* Which record a group's figures came from. A draft is published as a draft —
   never silently in place of an approved revision. */
const BASIS = Object.freeze({
  APPROVED_TECHNICAL_PACK: "APPROVED_TECHNICAL_PACK",
  DRAFT_TECHNICAL_RECORD: "DRAFT_TECHNICAL_RECORD",
  CUSTOMER_BRIEF: "CUSTOMER_BRIEF",
  MERCHANDISING_SELECTION: "MERCHANDISING_SELECTION",
  SAMPLE_OBSERVATION: "SAMPLE_OBSERVATION",
  NONE: "NONE",
});

const str = (v) => String(v ?? "").trim();
/* Absent is null, never 0 — the same rule the endpoint's own `num` follows,
   and the rule half these records were written to preserve. */
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const when = (v) => (v ? new Date(v).toISOString() : null);
const has = (v) => v !== null && v !== undefined && v !== "";
const list = (v) => (Array.isArray(v) ? v : []);

/**
 * A published picture: a name and an address a browser can open.
 *
 * The media store's own handles — `publicId`, `fileId`, `storageRef` — stay
 * behind. That is this endpoint's existing rule (its evidence block drops them
 * and a test walks every key path to prove it), and a second block publishing
 * them would reopen the boundary through a different door. A picture with no
 * absolute http(s) address is not published at all rather than published as a
 * broken one.
 */
const safeUrl = (v) => {
  const url = str(v);
  return /^https?:\/\//i.test(url) ? url : "";
};
const picture = (img) => {
  const url = safeUrl(img?.url);
  if (!url) return null;
  return { name: str(img?.name), url };
};
const pictures = (arr) => list(arr).map(picture).filter(Boolean);

/**
 * A family's standing, from its signed decision.
 *
 * `decisionView` answers a state every time, so nothing here has to interpret
 * an absent sub-document — which is exactly where "absent reads as no" gets
 * reintroduced. The rows are carried beside it: REQUIRED with no rows is work
 * outstanding, and NOT_REQUIRED with rows cannot happen (the writers refuse it).
 */
function decided(stored, owner) {
  const view = applicability.decisionView(stored);
  return {
    state: view.state === applicability.DECISION.UNANSWERED ? APPLICABILITY.UNKNOWN : view.state,
    reason: str(view.reason),
    decidedByName: str(view.decidedByName),
    decidedAt: when(view.decidedAt),
    owner,
  };
}

/**
 * A family with NO decision in the schema.
 *
 * Decoration, the garment brief and the materials list have no "is this
 * needed?" record anywhere. An empty list therefore means nobody has written
 * one down, which is UNKNOWN — and the desk that would answer is named so the
 * screen can ask somebody rather than print a blank.
 */
const undecided = (owner, rows = 0) => ({
  state: rows > 0 ? APPLICABILITY.REQUIRED : APPLICABILITY.UNKNOWN,
  reason: "",
  decidedByName: "",
  decidedAt: null,
  owner,
});

/* ── 1. THE GARMENT, AS THE CUSTOMER ASKED FOR IT ────────────────────────────
   Sales' snapshot of the enquiry line. Every field is free text and optional;
   the asked QUANTITY is deliberately not here — it is a commercial fact about
   an order, not an instruction for making one garment. */
function garmentBrief(style) {
  const brief = style?.brief || {};
  const specs = list(brief.customSpecs)
    .map((s) => ({ label: str(s?.label), value: str(s?.value) }))
    .filter((s) => s.label || s.value);
  const facts = {
    productName: str(style?.productName),
    variantLabel: str(style?.variantLabel),
    fit: str(brief.fit),
    sizeRange: str(brief.sizeRange),
    colour: str(brief.colour),
    fabricPreference: str(brief.fabricPreference),
    fabricComposition: str(brief.fabricComposition),
    gsm: str(brief.gsm),
    gender: str(brief.gender),
    trims: str(brief.trims),
    specialConstruction: str(brief.specialConstruction),
    /* "the uniform they wear today" — the reference garment this one has to
       sit beside. Named plainly rather than as a reference id. */
    existingUniform: str(brief.existingUniform),
    note: str(brief.note),
    /* The customer's own extra lines. Not called "customer specs": the key
       paths of this payload are scanned for buyer-shaped words. */
    statedSpecs: specs,
    references: pictures(brief.images),
  };
  const stated = Object.entries(facts)
    .filter(([k]) => k !== "productName" && k !== "variantLabel")
    .filter(([, v]) => (Array.isArray(v) ? v.length : has(v))).length;
  return {
    owner: OWNER.SALES,
    basis: BASIS.CUSTOMER_BRIEF,
    applicability: undecided(OWNER.SALES, stated),
    statedCount: stated,
    ...facts,
  };
}

/* ── 2. DECORATION, AND WHOSE WORDS IT IS ────────────────────────────────────
   `brief.brandingRequirements[]` is the customer's ASK. There is no approved
   decoration record anywhere in the schema: no approver, no digitised artwork,
   no per-row decision. `artworkOrigin` says so on every row rather than
   leaving a screen to infer it from a field name — and there is no decoration
   applicability decision either, so an empty list is UNKNOWN and Sales is the
   desk that would have to answer. */
function decoration(style) {
  const brief = style?.brief || {};
  const rows = list(brief.brandingRequirements).map((r, i) => ({
    key: str(r?.ref) || `branding-${i + 1}`,
    kind: str(r?.type),
    placement: str(r?.placement),
    width: num(r?.width),
    height: num(r?.height),
    unit: str(r?.unit),
    colourNotes: str(r?.colourNotes),
    notes: str(r?.notes),
    /* Free text upstream, with no enum and no default — published as stored
       and never mapped onto a vocabulary this module invented. */
    artworkState: str(r?.artworkState),
    artwork: pictures(r?.artwork),
    /* True when the row was projected from the old logo/printing/embroidery
       booleans rather than authored as a requirement. */
    fromLegacyFlag: Boolean(r?.legacy),
  }));
  /* One global flag, default true, and the schema's instruction is to read it
     rather than assume: nothing in `artwork` has been digitised, colour
     separated or approved for production. */
  const approvedForProduction = brief.artworkIsCustomerReference === false;
  return {
    owner: OWNER.SALES,
    basis: BASIS.CUSTOMER_BRIEF,
    applicability: undecided(OWNER.SALES, rows.length),
    artworkOrigin: approvedForProduction ? "PRODUCTION_APPROVED" : "CUSTOMER_REFERENCE",
    artworkApproved: approvedForProduction,
    /* The pre-structured booleans, carried as the weak signals they are: each
       defaults to false, so a false proves nothing and is never published as
       "not required". */
    flagged: {
      printing: Boolean(brief.printing),
      embroidery: Boolean(brief.embroidery),
      logo: Boolean(brief.logo),
    },
    rows,
  };
}

/* ── 3. MATERIALS, AT THE CONSUMPTION R&D ENGINEERED ─────────────────────────
   Merchandising selects WHICH material; R&D establishes WHAT EACH CONSUMES.
   Both halves live on the technical record's rows, so this publishes those —
   from the approved frozen revision when one exists, and from the draft only
   with the draft named. `allowancePercent` keeps its null: not stated and none
   are different answers and the schema went to some trouble to keep them apart. */
function materialRow(m, i) {
  return {
    key: `${str(m?.rawItemId) || "row"}-${str(m?.variantId) || i}`,
    name: str(m?.rawItemName),
    code: str(m?.rawItemSku),
    specification: str(m?.specification),
    consumptionPerPiece: num(m?.consumptionPerPiece),
    unit: str(m?.unit),
    allowancePercent: num(m?.allowancePercent),
    appliesToAllVariants: m?.appliesToAllVariants !== false,
    appliesToVariantLabels: list(m?.appliesToVariantLabels).map(str).filter(Boolean),
    /* Sent back to Merchandising, with the reason, and the row stays. */
    returnedForCorrection: m?.returnedToMaterials
      ? { reason: str(m.returnedToMaterials.reason), at: when(m.returnedToMaterials.at) }
      : null,
  };
}

function materials(style, development, approved) {
  const technical = style?.techSheet?.technical || {};
  const rows = approved
    ? list(approved.materials).map(materialRow)
    : list(technical.materials).map(materialRow);
  return {
    owner: OWNER.RESEARCH_DEVELOPMENT,
    basis: approved ? BASIS.APPROVED_TECHNICAL_PACK
      : rows.length ? BASIS.DRAFT_TECHNICAL_RECORD : BASIS.NONE,
    revision: approved ? num(approved.revision) : null,
    /* There is no materials decision anywhere in the schema, so an empty BOM
       is UNKNOWN. It is never "this garment needs no materials". */
    applicability: undecided(OWNER.MERCHANDISING, rows.length),
    /* The revision Sales RELEASED, which is what R&D worked against — not the
       one Merchandising has moved on to since. */
    releasedMaterialsPack: num(development?.releasedBomRevisionNo),
    materialsPackInProgress: num(development?.currentBomRevisionNo),
    returnedCount: rows.filter((r) => r.returnedForCorrection).length,
    rows,
  };
}

/* ── 4. CONSTRUCTION, AND THE ONE DOCUMENT THERE IS ──────────────────────────
   The technical pack is a single uploaded file. Its contents are never parsed,
   so measurements and construction drawings are stated as ABSENT rather than
   implied — the same two absences the endpoint's `unavailable` list already
   names, repeated here so a reader of this block alone cannot be misled. */
function construction(style, approved) {
  const techSheet = style?.techSheet || {};
  const file = approved?.file || techSheet.file || null;
  return {
    owner: OWNER.RESEARCH_DEVELOPMENT,
    basis: approved ? BASIS.APPROVED_TECHNICAL_PACK
      : file ? BASIS.DRAFT_TECHNICAL_RECORD : BASIS.NONE,
    revision: approved ? num(approved.revision) : null,
    pack: file && str(file.url)
      ? { name: str(file.name), url: str(file.url), at: when(file.uploadedAt) }
      : null,
    specialConstruction: str(style?.brief?.specialConstruction),
    /* Said in the payload, because a screen that drew an empty "measurements"
       panel would be claiming a record exists. */
    notStored: [
      { kind: "MEASUREMENT_CHART", owner: OWNER.RESEARCH_DEVELOPMENT,
        message: "Measurements are inside the technical pack document; no separate chart is stored." },
      { kind: "CONSTRUCTION_DRAWING", owner: OWNER.RESEARCH_DEVELOPMENT,
        message: "No construction drawing is stored apart from the technical pack document." },
    ],
  };
}

/* ── 5 & 6. OUTSIDE PROCESSES AND DEVELOPMENT TOOLING ────────────────────────
   One stored array, two purposes, two owners, two decisions. The service
   register's id, code and charge key stay behind: a process requirement's
   NAME is a factory fact, and its position in the buying catalogue is not. */
function requirementRow(r, i) {
  return {
    key: str(r?.rowId) || `requirement-${i + 1}`,
    name: str(r?.serviceName),
    specification: str(r?.specification),
    quantity: num(r?.quantity),
    unit: str(r?.billingUnit),
    basis: str(r?.basis) || "PER_GARMENT",
    included: r?.included !== false,
    excludedReason: str(r?.excludedReason),
    notes: str(r?.notes),
    /* Absent evidence reads as planned and can never become measured on its
       own, so the weaker reading is published rather than a blank. */
    evidence: str(r?.evidence) || "BOM_PLANNED",
  };
}

const requirementsOf = (style, purpose) =>
  list(style?.sample?.serviceRequirements)
    .filter((r) => (str(r?.purpose) || "OUTSIDE_PROCESS") === purpose)
    .map(requirementRow);

function outsideProcesses(style) {
  const rows = requirementsOf(style, "OUTSIDE_PROCESS");
  return {
    owner: OWNER.PRODUCTION,
    basis: rows.length ? BASIS.MERCHANDISING_SELECTION : BASIS.NONE,
    applicability: decided(style?.sample?.outsideProcessDecision, OWNER.PRODUCTION),
    rows,
  };
}

function tooling(style) {
  const rows = requirementsOf(style, "DEVELOPMENT_TOOLING");
  return {
    owner: OWNER.MERCHANDISING,
    basis: rows.length ? BASIS.MERCHANDISING_SELECTION : BASIS.NONE,
    applicability: decided(style?.sample?.developmentDecision, OWNER.MERCHANDISING),
    rows,
  };
}

/* ── 7. WHAT THE SAMPLE PROVED ───────────────────────────────────────────────
   Evidence, not a standard. The operations observed while making a sample are
   somebody's stopwatch on one garment; they are published as observations so
   IE can read them, and they are never a bulletin. The payroll figures those
   rows also carry are dropped here and do not cross. */
function sampleProof(style) {
  const sample = style?.sample || {};
  const rounds = list(sample.rounds).map((r) => ({
    key: str(r?._id) || `round-${num(r?.roundNo) ?? ""}`,
    roundNo: num(r?.roundNo),
    kind: str(r?.type),
    outcome: str(r?.outcome) || "pending",
    feedback: str(r?.feedback),
    at: when(r?.madeAt),
    photographs: pictures(r?.images).length,
  }));
  /* There is no accepted-round pointer in the schema and no guarantee of
     exactly one, so every accepted round is named rather than one being
     picked. */
  const accepted = rounds.filter((r) => r.outcome === "accepted").map((r) => r.roundNo);
  const consumed = list(sample.consumptionRawItems).map((c, i) => ({
    key: `${str(c?.rawItemId) || "consumed"}-${i}`,
    name: str(c?.rawItemName),
    quantity: num(c?.quantity),
    unit: str(c?.unit),
    allowancePercent: num(c?.allowancePercent),
  }));
  const observed = list(sample.operations).map((o, i) => ({
    key: `${str(o?.operationCode) || "observed"}-${i}`,
    description: str(o?.type),
    operationCode: str(o?.operationCode),
    machineType: str(o?.machineType),
    minutes: num(o?.minutes),
    seconds: num(o?.seconds),
  }));
  return {
    owner: OWNER.RESEARCH_DEVELOPMENT,
    basis: observed.length || consumed.length || rounds.length
      ? BASIS.SAMPLE_OBSERVATION : BASIS.NONE,
    status: str(sample.status) || "not_started",
    acceptedRounds: accepted,
    rounds,
    photographs: pictures(sample.photos).length,
    consumed,
    /* Named `observed`, and the screen says so: watching a sample being made
       proves what happened once, not what the standard is. */
    observedOperations: observed,
  };
}

/* ── 8. PACKING, ONLY WHERE IT REACHES AN OPERATION ──────────────────────────
   What is packed, at what basis, and how many go in a carton. PER_CARTON is
   not a synonym for FIXED_PER_RUN and is published as stored. The versioned
   pack configuration is the one published; R&D's working note is not, because
   two answers to one question is how a floor ends up packing to the wrong one. */
function packaging(style) {
  const materialsBlock = style?.materials || {};
  const sample = style?.sample || {};
  const components = list(materialsBlock.packagingSelections)
    .filter((p) => str(p?.status) !== "withdrawn")
    .map((p, i) => ({
      key: str(p?.rowId) || `component-${i + 1}`,
      name: str(p?.rawItemName),
      code: str(p?.rawItemSku),
      specification: str(p?.specification),
      status: str(p?.status) || "proposed",
    }));
  const byRow = new Map(components.map((c) => [c.key, c]));
  const rows = list(sample.packagingRequirements).map((r, i) => {
    const linked = byRow.get(str(r?.sourceSelectionRowId));
    return {
      key: str(r?.rowId) || `packing-${i + 1}`,
      name: str(r?.rawItemName) || linked?.name || "",
      specification: str(r?.specification) || linked?.specification || "",
      quantity: num(r?.quantity),
      unit: str(r?.unit),
      basis: str(r?.basis) || "PER_GARMENT",
      included: r?.included !== false,
      excludedReason: str(r?.excludedReason),
      evidence: str(r?.evidence) || "BOM_PLANNED",
    };
  });
  const config = materialsBlock.packingConfiguration || {};
  return {
    owner: OWNER.MERCHANDISING,
    basis: rows.length || components.length ? BASIS.MERCHANDISING_SELECTION : BASIS.NONE,
    applicability: decided(materialsBlock.packagingDecision, OWNER.MERCHANDISING),
    garmentsPerCarton: num(config.garmentsPerCarton),
    packConfigurationRevision: num(config.revision),
    components,
    rows,
  };
}

/* ── 9. THE ROUTE SOMEBODY HAS ALREADY WRITTEN DOWN ──────────────────────────
   Production owns this record and this door; IE reads it. Sequence is the
   array's own order and SAM is derived at read time by Production's own
   helper, both exactly as Production's screens derive them — a second
   arithmetic here is how two screens come to disagree about one route. */
function productionRoute(style, approved) {
  const technical = style?.techSheet?.technical || {};
  const source = approved ? list(approved.operations) : list(technical.operations);
  const rows = source.map((o, i) => ({
    key: `${str(o?.operationId) || "operation"}-${i}`,
    sequence: i + 1,
    operationCode: str(o?.operationCode),
    name: str(o?.name),
    machineType: str(o?.machineType),
    standardMinutes: num(o?.samMinutes) ?? technicalRecord.samMinutesOf(o),
    notes: str(o?.notes),
    /* A row written before the operation register existed. It is published as
       it stands; what it cannot do is be matched to a registered operation. */
    unregistered: !has(o?.operationId),
  }));
  return {
    owner: OWNER.PRODUCTION,
    basis: approved ? BASIS.APPROVED_TECHNICAL_PACK
      : rows.length ? BASIS.DRAFT_TECHNICAL_RECORD : BASIS.NONE,
    revision: approved ? num(approved.revision) : null,
    applicability: undecided(OWNER.PRODUCTION, rows.length),
    totalStandardMinutes: rows.reduce((t, r) => t + (r.standardMinutes || 0), 0) || null,
    rows,
  };
}

/* ── WHAT IE RECEIVED, IN SIX WORDS ──────────────────────────────────────────
   The strip above the fold. Each item is READY, MISSING, NOT_REQUIRED or
   NEEDS_CLARIFICATION, derived from the groups below it and from nothing else,
   so the strip and the cards can never disagree. */
const RECEIVED = Object.freeze({
  READY: "READY",
  MISSING: "MISSING",
  NOT_REQUIRED: "NOT_REQUIRED",
  NEEDS_CLARIFICATION: "NEEDS_CLARIFICATION",
});

const receivedFrom = (group, ready, clarify = false) => {
  if (group.applicability?.state === APPLICABILITY.NOT_REQUIRED) return RECEIVED.NOT_REQUIRED;
  if (clarify) return RECEIVED.NEEDS_CLARIFICATION;
  return ready ? RECEIVED.READY : RECEIVED.MISSING;
};

function receivedStrip(groups) {
  const { garment, decoration: deco, materials: mats, construction: cons, processes, sample } = groups;
  return [
    { key: "garment", label: "Garment brief", owner: garment.owner,
      state: receivedFrom(garment, garment.statedCount >= 3) },
    { key: "materials", label: "Materials", owner: mats.owner,
      state: receivedFrom(mats, mats.rows.length > 0 && mats.basis === BASIS.APPROVED_TECHNICAL_PACK,
        mats.returnedCount > 0) },
    { key: "construction", label: "Technical pack", owner: cons.owner,
      state: receivedFrom(cons, Boolean(cons.pack) && cons.basis === BASIS.APPROVED_TECHNICAL_PACK) },
    { key: "decoration", label: "Decoration", owner: deco.owner,
      /* Rows exist, and none of them is production-approved artwork: that is
         not "ready", it is something to settle with Sales before engineering
         a placement. */
      state: receivedFrom(deco, deco.rows.length > 0 && deco.artworkApproved,
        deco.rows.length > 0 && !deco.artworkApproved) },
    { key: "processes", label: "Outside processes", owner: processes.owner,
      state: receivedFrom(processes, processes.rows.some((r) => r.included)) },
    { key: "sample", label: "Approved sample", owner: sample.owner,
      state: receivedFrom(sample, sample.status === "approved" && sample.acceptedRounds.length > 0) },
  ];
}

/* The SampleStyle fields this projection needs, added to the DETAIL read only.
   The list endpoint's projection is untouched. */
const MANUFACTURING_DETAIL_PROJECTION = [
  "brief.note", "brief.gender", "brief.colour", "brief.fabricPreference",
  "brief.fabricComposition", "brief.gsm", "brief.fit", "brief.sizeRange",
  "brief.trims", "brief.specialConstruction", "brief.existingUniform",
  "brief.logo", "brief.embroidery", "brief.printing", "brief.customSpecs",
  "brief.artworkIsCustomerReference",
  "techSheet.file", "techSheet.technical.materials", "techSheet.technical.operations",
  "techSheet.technicalRevisions.snapshot", "techSheet.technicalRevisions.file",
  "sample.rounds", "sample.photos", "sample.consumptionRawItems", "sample.operations",
  "sample.serviceRequirements", "sample.packagingRequirements",
  "sample.outsideProcessDecision", "sample.developmentDecision",
  "materials.packagingSelections", "materials.packingConfiguration", "materials.packagingDecision",
].join(" ");

/**
 * The manufacturing inputs for one style, from records already loaded.
 *
 * Pure: it issues no query, holds no clock beyond the dates it copies, and
 * writes nothing. The caller has already proved the company owns this style.
 *
 * @param {object} p
 * @param {object} p.style        the SampleStyle, read under the detail projection
 * @param {object|null} p.development  Merchandising's development file, or null
 */
function manufacturingInputsFor({ style, development = null } = {}) {
  /* The approved frozen revision, by the owning service's own rule: only when
     the record is approved, and then the HIGHEST approved revision rather than
     the last one in the array. A draft is never substituted for it silently —
     each group publishes the `basis` it used. */
  const approvedRevision = technicalRecord.approvedRevisionOf(style?.techSheet || {});
  const approved = approvedRevision?.snapshot || null;
  const revisionNo = approvedRevision ? num(approvedRevision.revision) : null;
  const frozen = approved ? { ...approved, revision: num(approved.revision) ?? revisionNo } : null;

  const groups = {
    garment: garmentBrief(style),
    decoration: decoration(style),
    materials: materials(style, development, frozen),
    construction: construction(style, frozen),
    processes: outsideProcesses(style),
    tooling: tooling(style),
    sample: sampleProof(style),
    packaging: packaging(style),
    route: productionRoute(style, frozen),
  };

  return {
    ...groups,
    received: receivedStrip(groups),
    /* Said once, at the top: which record the engineered figures came from. */
    approvedTechnicalPack: revisionNo,
  };
}

module.exports = {
  OWNER, APPLICABILITY, BASIS, RECEIVED,
  MANUFACTURING_DETAIL_PROJECTION,
  manufacturingInputsFor,
  /* Exported for the tests, which assert each group independently. */
  garmentBrief, decoration, materials, construction,
  outsideProcesses, tooling, sampleProof, packaging, productionRoute, receivedStrip,
};
