// services/centralCosting/approvedTechnicalSource.service.js
//
// THE APPROVED FACTS A COSTING MAY BE BUILT FROM — BOUND BY IDENTITY, OR REFUSED.
//
// ── THE AUTHORITY CHAIN, AND WHY IT IS NOT A CHAIN OF APPROVALS ─────────────
// Central Costing joins facts owned by four desks. They are not one linear
// approval queue, and building one would mean every Merchandising click waited
// on Industrial Engineering:
//
//   · MERCHANDISING owns SELECTION — which fabric, trim or packaging item.
//   · R&D owns the TECHNICAL PROPOSAL — specification, consumption, allowance.
//   · IE CONFIRMS the R&D-derived manufacturing facts by approving the exact
//     frozen revision it reviewed, and authors the operation route and SAM.
//   · STORE owns COMMERCIAL SOURCING — supplier, rate, taxes, validity.
//
// Costing calculates. It decides none of those, and it may read none of them
// before the desk that owns it has approved it.
//
// ── WHAT THIS FILE REPLACES ─────────────────────────────────────────────────
// `technicalSource.service.js` read R&D directly:
// `approvedRevisionOf(style.techSheet)` for materials, and — when that carried
// no route — `style.sample.operations` as a silent fallback. Packaging,
// services and shipment came straight off the live `style.sample`. R&D could
// therefore move a number into a price with nobody having confirmed it, and a
// style whose approved revision had no route was costed from a sample run
// nobody engineered.
//
// No R&D value is costable here except through the CURRENT IE-APPROVED
// bulletin version's frozen snapshot. That is the whole of the rule.
//
// ── ONE APPROVED VERSION, NOT "THE LATEST APPROVED" ─────────────────────────
// `approvedStandard.service.js` already answers "which version is the
// standard" by the file's own pointer — a decision two people took — rather
// than by a query for the newest approved row. This reuses it rather than
// asking the question a second way.
//
// ── AND MERCHANDISING HAS TWO FORMS, BOTH GENUINELY ITS OWN ─────────────────
// `SelectionRevision` is keyed `{companyId, fileId}` on an `ExecutionFile`, and
// an execution file exists only as the consequence of accepting a Sales
// handover — that is, after an order. An enquiry line has none, and enquiry
// lines are what Sales quotes from.
//
// So the selection authority is stated in two forms and never falls back
// between them:
//
//   · BOM_APPROVAL      — pre-order. `SampleStyle.materials` gated on
//                         `bomApproval.status === "approved"`, identified by
//                         its round and decision date. A real approval with an
//                         actor and a rotating token.
//   · SELECTION_REVISION — post-order. The approved revision for the style's
//                         execution file, identified by file and revision
//                         number.
//
// Which form answered is recorded, so a costing can say what it bound to.
//
// ── EVERY REFUSAL IS NAMED, AND NOTHING IS SUBSTITUTED ──────────────────────
// A missing authority is a readiness gap with an owner, never a zero, never an
// empty list, and never the live record it was supposed to replace.
"use strict";

const mongoose = require("mongoose");

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const iso = (v) => (v ? new Date(v).toISOString() : null);

/* Lazy, like the rest of this lane: a costing that never asks for technical
   data should not pay to load the Sales, IE and Merchandising graphs. */
const SampleStyle = () => require("../../models/CMS_Models/Sales/SampleStyle");
const IeBulletinVersion = () => require("../../models/CMS_Models/IndustrialEngineering/IeBulletinVersion");
const ExecutionFile = () => require("../../models/CMS_Models/Merchandising/ExecutionFile");
const SelectionRevision = () => require("../../models/CMS_Models/Merchandising/SelectionRevision");
const approvedStandard = () => require("../industrialEngineering/approvedStandard.service");
const bulletinVersions = () => require("../industrialEngineering/ieBulletinVersion.service");
const technicalRecord = () => require("./technicalRecord.service");
const technicalSource = () => require("./technicalSource.service");

/* ═══ THE VOCABULARY ═══════════════════════════════════════════════════════ */

/**
 * Where a style's approved facts stand. Exactly one of these, always.
 *
 * Stable strings: they are stored in frozen provenance, shown on a Sales
 * screen, and routed to a department. Renaming one is a migration.
 */
const BINDING_STATE = Object.freeze({
  /* Every authority proved and in agreement. The only costable state. */
  BOUND: "BOUND",

  /* Merchandising has not approved what the style is made of. */
  AWAITING_MERCHANDISING_SELECTION: "AWAITING_MERCHANDISING_SELECTION",

  /* R&D has submitted nothing for IE to review. The only state R&D owns —
     once a revision is in the IE chain, the answer belongs to IE. */
  AWAITING_RND_TECHNICAL_SUBMISSION: "AWAITING_RND_TECHNICAL_SUBMISSION",

  /* R&D's record is approved and IE has not confirmed it: no engineering
     file, no approved version, or one in review or returned. */
  AWAITING_IE_TECHNICAL_CONFIRMATION: "AWAITING_IE_TECHNICAL_CONFIRMATION",

  /* IE confirmed an OLDER R&D revision than the one R&D has since approved.
     The confirmation stands as a record; it is not the current technical
     basis, and costing from it would quote a garment nobody is making. */
  IE_TECHNICAL_APPROVAL_STALE: "IE_TECHNICAL_APPROVAL_STALE",

  /* The approved version exists but does not belong to this style, this
     company, or the file that points at it. Reported, never followed. */
  TECHNICAL_SOURCE_MISMATCH: "TECHNICAL_SOURCE_MISMATCH",

  /* IE confirmed a material Merchandising's approved selection does not
     contain. Neither side is overruled: the two records disagree about what
     the garment is made of, and Merchandising owns that question. */
  SELECTION_MISMATCH: "SELECTION_MISMATCH",
});

/** Who resolves each state. One spelling, shared with the readiness projection. */
const OWNER = Object.freeze({
  MERCHANDISING: { department: "Merchandising", departmentSlug: "merchandiser", minimumRole: "approver" },
  RND: { department: "R&D", departmentSlug: "research-development", minimumRole: "editor" },
  IE: { department: "Industrial Engineering", departmentSlug: "ie", minimumRole: "approver" },
  STORE: { department: "Store / Purchase", departmentSlug: "store", minimumRole: "editor" },
});

const STATE_OWNER = Object.freeze({
  [BINDING_STATE.AWAITING_MERCHANDISING_SELECTION]: OWNER.MERCHANDISING,
  [BINDING_STATE.AWAITING_RND_TECHNICAL_SUBMISSION]: OWNER.RND,
  [BINDING_STATE.AWAITING_IE_TECHNICAL_CONFIRMATION]: OWNER.IE,
  [BINDING_STATE.IE_TECHNICAL_APPROVAL_STALE]: OWNER.IE,
  [BINDING_STATE.TECHNICAL_SOURCE_MISMATCH]: OWNER.IE,
  [BINDING_STATE.SELECTION_MISMATCH]: OWNER.MERCHANDISING,
});

const MESSAGE = Object.freeze({
  [BINDING_STATE.AWAITING_MERCHANDISING_SELECTION]:
    "Merchandising has not approved what this style is made of, so there is nothing to cost yet.",
  [BINDING_STATE.AWAITING_RND_TECHNICAL_SUBMISSION]:
    "R&D has not submitted an approved technical record for this style.",
  [BINDING_STATE.AWAITING_IE_TECHNICAL_CONFIRMATION]:
    "Industrial Engineering has not confirmed this style's technical record. Nothing R&D recorded "
    + "can be priced until the exact revision has been reviewed and approved.",
  [BINDING_STATE.IE_TECHNICAL_APPROVAL_STALE]:
    "Industrial Engineering confirmed an earlier technical revision, and R&D has approved a newer "
    + "one since. The confirmation stands as a record but is not the current technical basis.",
  [BINDING_STATE.TECHNICAL_SOURCE_MISMATCH]:
    "The approved engineering version does not belong to this style, so it cannot be treated as "
    + "its technical basis.",
  [BINDING_STATE.SELECTION_MISMATCH]:
    "The confirmed technical record describes a material that is not in Merchandising's approved "
    + "selection for this style. The two records disagree about what the garment is made of.",
});

/** The two forms Merchandising's PACKAGING authority takes. Never mixed. */
const PACKAGING_FORM = Object.freeze({
  /* Pre-order: the approved rows of `materials.packagingSelections`, with
     `materials.packagingDecision` as the approving act. */
  PACKAGING_SELECTION: "PACKAGING_SELECTION",
  /* Post-order: the in-force PACKAGING revision on the Execution File. */
  PACKAGING_REVISION: "PACKAGING_REVISION",
});

/**
 * The named states of the three facts that are NOT part of the technical basis.
 *
 * Each one blocks its own family and nothing else. A style with no approved
 * packaging still has a costable garment; it just has no packaging cost, and
 * saying which is missing is the whole point of naming them separately.
 */
const FAMILY_STATE = Object.freeze({
  PACKAGING_BOUND: "PACKAGING_BOUND",
  AWAITING_MERCHANDISING_PACKAGING: "AWAITING_MERCHANDISING_PACKAGING",
  PACKAGING_SELECTION_UNAPPROVED: "PACKAGING_SELECTION_UNAPPROVED",
  AWAITING_RND_PACKING_MEASUREMENT: "AWAITING_RND_PACKING_MEASUREMENT",
  AWAITING_MERCHANDISING_PACK_CONFIGURATION: "AWAITING_MERCHANDISING_PACK_CONFIGURATION",
});

const FAMILY_MESSAGE = Object.freeze({
  [FAMILY_STATE.AWAITING_MERCHANDISING_PACKAGING]:
    "Merchandising has not approved a packaging specification for this style. What the garment is "
    + "packed in, and how it is packed, is Merchandising's decision — a costing cannot assume it is "
    + "packed in nothing.",
  [FAMILY_STATE.PACKAGING_SELECTION_UNAPPROVED]:
    "R&D has measured packaging that Merchandising has not approved for this style. The measurement "
    + "stands as a record; it is not a cost until the component it answers is approved.",
  [FAMILY_STATE.AWAITING_RND_PACKING_MEASUREMENT]:
    "No approved packed weight is recorded for this style. A per-kilogram freight rate cannot be "
    + "applied to a garment nobody has weighed, and a weight nobody approved can change after a "
    + "costing is built from it.",
  [FAMILY_STATE.AWAITING_MERCHANDISING_PACK_CONFIGURATION]:
    "Merchandising has not approved how many garments a carton holds. Per-carton freight and "
    + "per-carton packaging are both charged by the carton, so this decides the cost.",
});

/**
 * Merchandising's approved packaging, joined to R&D's measurement of it.
 *
 * ── WHY THIS IS NOT IN THE TECHNICAL SNAPSHOT ───────────────────────────────
 * Packaging used to be read off the IE-frozen R&D snapshot, under a key that
 * snapshot has never carried. It is two departments' facts and neither is IE's:
 *
 *   · Merchandising approves WHICH components the style is packed in and the
 *     buyer-facing specification for each — identity and instruction;
 *   · R&D measures HOW MUCH of each, on which basis, from the physical sample;
 *   · Store quotes what each one costs, separately, from its own record.
 *
 * So the approved Merchandising record is the authority for what may be costed,
 * and R&D's row supplies the quantity for each component that authority names.
 * A measurement of something Merchandising never approved is kept as a record
 * and is not a cost — which is the same rule the materials side already runs.
 *
 * Returns `{ form, provenance, rows, unapproved, state }`, or a state naming
 * Merchandising when there is no approved packaging at all. Never `[]` standing
 * in for "this style is packed in nothing": only Merchandising's applicability
 * decision may say that, and it has its own field.
 */
async function packagingSourceFor(companyId, style) {
  const measured = Array.isArray(style.sample?.packagingRequirements)
    ? style.sample.packagingRequirements
    : [];

  const file = await ExecutionFile()
    .findOne({ companyId, "commercial.sampleStyleId": style._id })
    .select("_id")
    .lean();

  let approvedRows = null;
  let provenance = null;
  let form = null;
  let garmentsPerCarton = null;

  if (file) {
    const { PackagingRevision } = SelectionRevision();
    const revision = await PackagingRevision
      .findOne({ companyId, fileId: file._id, state: "APPROVED" })
      .select("_id revisionNo approvedAt approvedBy rows packingInstruction")
      .lean();
    if (!revision) {
      return { form: null, provenance: null, rows: null, unapproved: [], state: FAMILY_STATE.AWAITING_MERCHANDISING_PACKAGING };
    }
    form = PACKAGING_FORM.PACKAGING_REVISION;
    provenance = {
      form,
      executionFileId: String(file._id),
      packagingRevisionId: String(revision._id),
      revisionNo: revision.revisionNo,
      approvedAt: iso(revision.approvedAt),
      decidedAt: null,
    };
    garmentsPerCarton = Number(revision.packingInstruction?.garmentsPerCarton) || null;
    approvedRows = (revision.rows || []).map((r) => ({
      selectionRowId: str(r.rowRef),
      rawItemId: str(r.catalogueRef?.recordId || r.sourceRef?.recordId),
      rawItemName: str(r.componentName),
      rawItemSku: str(r.componentCode),
      variantId: "",
      variantLabel: str(r.colourOrShade),
      specification: str(r.specification),
    }));
  } else {
    const selections = Array.isArray(style.materials?.packagingSelections)
      ? style.materials.packagingSelections.filter((r) => str(r.status) === "approved")
      : [];
    const decision = style.materials?.packagingDecision || {};
    if (!selections.length) {
      return { form: null, provenance: null, rows: null, unapproved: [], state: FAMILY_STATE.AWAITING_MERCHANDISING_PACKAGING };
    }
    form = PACKAGING_FORM.PACKAGING_SELECTION;
    provenance = {
      form,
      executionFileId: null,
      packagingRevisionId: null,
      /* ── THE PACK-OUT'S REVISION DOES NOT BELONG IN THIS IDENTITY ────
         This carried `packingConfiguration.revision`, so re-deciding how many
         garments a carton holds also reported the packaging SPECIFICATION as
         changed. They are two decisions and they get two fingerprint parts;
         the pre-order specification has no revision number of its own, and its
         identity is the approving act — the same shape the BOM approval uses,
         for the same reason. */
      revisionNo: null,
      approvedAt: iso(decision.decidedAt),
      decidedAt: iso(decision.decidedAt),
    };
    garmentsPerCarton = Number(style.materials?.packingConfiguration?.garmentsPerCarton) || null;
    approvedRows = selections.map((r) => ({
      selectionRowId: str(r.rowId),
      rawItemId: str(r.rawItemId),
      rawItemName: str(r.rawItemName),
      rawItemSku: str(r.rawItemSku),
      variantId: str(r.variantId),
      variantLabel: str(r.variantLabel),
      specification: str(r.specification),
    }));
  }

  /* ── THE JOIN: MERCHANDISING NAMES IT, R&D MEASURES IT ─────────────────
     By ROW, never by item: two approved components may legitimately name the
     same poly bag — an inner and an outer — and joining on the item would
     merge them into one cost. */
  const byRow = new Map(approvedRows.map((r) => [r.selectionRowId, r]));
  const rows = [];
  const unapproved = [];
  for (const m of measured) {
    const approved = byRow.get(str(m.sourceSelectionRowId));
    if (!approved) {
      unapproved.push({ rowId: str(m.rowId), rawItemName: str(m.rawItemName) });
      continue;
    }
    rows.push({
      ...m,
      /* Identity and specification are MERCHANDISING's: R&D's copies are
         snapshots taken when the row was written, and the approved record is
         what the buyer agreed to. */
      rawItemId: approved.rawItemId || str(m.rawItemId),
      rawItemName: approved.rawItemName || str(m.rawItemName),
      rawItemSku: approved.rawItemSku || str(m.rawItemSku),
      variantId: approved.variantId || str(m.variantId),
      variantLabel: approved.variantLabel || str(m.variantLabel),
      specification: approved.specification || str(m.specification),
    });
  }

  return {
    form,
    provenance,
    rows,
    unapproved,
    garmentsPerCarton,
    state: FAMILY_STATE.PACKAGING_BOUND,
  };
}

/**
 * The two frozen facts a freight line is built from, each from its owner.
 *
 * `sample.shipment` is R&D's WORKING record and is not versioned, so a costing
 * that read it froze a figure that could change underneath it with nothing
 * recording that it had. These come from records that carry a revision:
 *
 *   · `sample.packingMeasurement` — R&D's approved weighing;
 *   · `materials.packingConfiguration`, or the in-force PACKAGING revision —
 *     Merchandising's approved pack-out.
 *
 * Absent is absent. Neither is defaulted and neither falls back to the working
 * record: freight that priced an unapproved weight is the failure being fixed.
 */
function packingFactsFor(style, { garmentsPerCarton = null } = {}) {
  const measurement = style.sample?.packingMeasurement || {};
  const approvedWeight = measurement.approvedAt && Number(measurement.packedWeightGrams) > 0
    ? Number(measurement.packedWeightGrams)
    : null;

  const gaps = [];
  if (approvedWeight === null) gaps.push(FAMILY_STATE.AWAITING_RND_PACKING_MEASUREMENT);
  if (garmentsPerCarton === null) gaps.push(FAMILY_STATE.AWAITING_MERCHANDISING_PACK_CONFIGURATION);

  return {
    packedWeightGrams: approvedWeight,
    garmentsPerCarton,
    provenance: {
      packingMeasurementRevision: Number(measurement.revision ?? 0) || null,
      packingMeasurementApprovedAt: iso(measurement.approvedAt),
      packConfigurationRevision: Number(style.materials?.packingConfiguration?.revision ?? 0) || null,
      packConfigurationDecidedAt: iso(style.materials?.packingConfiguration?.decidedAt),
    },
    gaps,
  };
}

/** The two forms Merchandising's selection authority takes. Never mixed. */
const SELECTION_FORM = Object.freeze({
  BOM_APPROVAL: "BOM_APPROVAL",
  SELECTION_REVISION: "SELECTION_REVISION",
});

/* ═══ THE PARTS ════════════════════════════════════════════════════════════ */

/**
 * The frozen requirement rows of one family, or null when none were frozen.
 *
 * `null` and `[]` are different answers and the difference is load-bearing: a
 * revision that froze no requirements at all has said nothing, while an empty
 * list after filtering means R&D recorded some and none were of this family —
 * which is a real "none of these".
 */
function requirementsOfFamily(snapshot, family) {
  if (!Array.isArray(snapshot?.requirements)) return null;
  return snapshot.requirements.filter((r) => str(r?.family) === family);
}

const unbound = (state, detail = {}) => ({
  state,
  bound: false,
  message: MESSAGE[state] || "",
  owner: STATE_OWNER[state] || null,
  ...detail,
  /* Nulls, never zeroes or empty lists: "not confirmed" is not "a style of no
     materials and no operations". */
  technical: null,
  selection: null,
});

/**
 * Merchandising's approved selection for this style, in whichever form applies.
 *
 * Post-order first, because an execution file is the more specific record: once
 * one exists, its approved revision is what Merchandising maintains and the BOM
 * approval behind it is history. Pre-order there is no file, and the approved
 * BOM is the decision.
 *
 * Returns `null` when neither is approved — never a guess, and never the
 * unapproved draft of either.
 */
async function approvedSelectionFor(companyId, style) {
  const file = await ExecutionFile()
    .findOne({ companyId, "commercial.sampleStyleId": style._id })
    .select("_id handoverRef handoverLineRef")
    .lean();

  if (file) {
    const { MaterialTrimRevision } = SelectionRevision();
    const revision = await MaterialTrimRevision
      .findOne({ companyId, fileId: file._id, state: "APPROVED" })
      .select("_id revisionNo approvedAt approvedBy rows")
      .lean();
    if (!revision) return null;
    return {
      form: SELECTION_FORM.SELECTION_REVISION,
      executionFileId: String(file._id),
      selectionRevisionId: String(revision._id),
      revisionNo: revision.revisionNo,
      approvedAt: iso(revision.approvedAt),
      /* ── IDENTITIES ONLY, AND IN THE FORM THIS RECORD ACTUALLY HOLDS ──
         A selection row's identity is its `rowRef`; `catalogueRef.recordId`
         names the Inventory item where one was chosen from the catalogue, and
         is absent for a row described free-hand. Both are published because
         they answer different questions, and neither is invented.

         What a row COSTS is Store's and how much is used is IE's — this
         record states neither. */
      rowRefs: (revision.rows || []).map((r) => str(r.rowRef)).filter(Boolean),
      itemIds: (revision.rows || [])
        .map((r) => str(r.catalogueRef?.recordId || r.sourceRef?.recordId))
        .filter(Boolean),
      bomApprovalRound: null,
    };
  }

  const bom = style.materials?.bomApproval || style.bomApproval || {};
  if (str(bom.status) !== "approved") return null;
  return {
    form: SELECTION_FORM.BOM_APPROVAL,
    executionFileId: null,
    selectionRevisionId: null,
    revisionNo: null,
    approvedAt: iso(bom.decidedAt),
    /* The BOM speaks Inventory ids directly, which is the same vocabulary the
       IE snapshot's material rows use — so this form CAN be cross-checked
       item for item, and `materialsAgree` below does. */
    rowRefs: [],
    itemIds: (style.materials?.rawItems || []).map((r) => str(r.rawItemId)).filter(Boolean),
    bomApprovalRound: Number(bom.round ?? 0),
  };
}

/* ═══ THE BINDING ══════════════════════════════════════════════════════════ */

/**
 * The approved facts for one style, or the named reason there are none.
 *
 * Every identity is proved against the SAME style and the SAME company. A
 * version reached through a file that points elsewhere, a snapshot recorded
 * against another style, or an approval of a revision R&D has since replaced
 * are each their own refusal, and none of them is followed.
 */
async function bindFor(ctx, { styleId } = {}) {
  if (!ctx?.companyId) throw new Error("A company context is required to bind a technical source.");
  if (!isId(styleId)) return unbound(BINDING_STATE.TECHNICAL_SOURCE_MISMATCH, { styleId: null });

  const style = await SampleStyle().findById(styleId)
    /* `bomApproval` is a TOP-LEVEL field on SampleStyle, beside `materials` —
       not inside it. Both spellings are read below because older records and
       some writers use the nested one. */
    /* `materials` whole, because Merchandising's selection, its packaging
       selection, its applicability decision and its pack configuration all
       live under it. `sample.shipment` is still read so the working record can
       be REPORTED beside the approved one, never costed from. */
    .select("journeyId enquiryId techSheet materials bomApproval production.stockItemId "
      + "sample.shipment sample.packagingRequirements sample.packingMeasurement")
    .lean();
  if (!style) return unbound(BINDING_STATE.TECHNICAL_SOURCE_MISMATCH, { styleId: str(styleId) });

  /* Whose style it is, proved through its own Sales parents — the one
     ownership rule this lane has. */
  const owned = await technicalSource().ownershipProofFor(style, ctx.companyId);
  if (!owned) return unbound(BINDING_STATE.TECHNICAL_SOURCE_MISMATCH, { styleId: str(styleId) });

  /* ── 1 · MERCHANDISING: WHAT WAS SELECTED ──────────────────────────────── */
  const selection = await approvedSelectionFor(ctx.companyId, style);
  if (!selection) return unbound(BINDING_STATE.AWAITING_MERCHANDISING_SELECTION, { styleId: str(styleId) });

  /* ── 2 · R&D: IS THERE ANYTHING FOR IE TO HAVE CONFIRMED ───────────────── */
  const rndApproved = technicalRecord().approvedRevisionOf(style.techSheet || {});

  /* ── 3 · IE: THE CURRENT APPROVED VERSION, BY THE FILE'S OWN POINTER ───── */
  const standards = await approvedStandard().approvedStandardsFor(ctx.companyId, [String(styleId)]);
  const standard = standards.get(String(styleId));
  if (!standard || !standard.available) {
    /* R&D having submitted nothing is R&D's; anything else is IE's. Once a
       revision is in the IE chain, R&D is no longer the owner of the wait. */
    const state = rndApproved
      ? BINDING_STATE.AWAITING_IE_TECHNICAL_CONFIRMATION
      : BINDING_STATE.AWAITING_RND_TECHNICAL_SUBMISSION;
    return unbound(state, {
      styleId: str(styleId),
      ieState: standard ? standard.state : null,
      ieGaps: standard ? standard.gaps : [],
    });
  }

  const version = await IeBulletinVersion()
    .findOne({ _id: standard.bulletinVersionId, companyId: ctx.companyId })
    .lean();
  if (!version) {
    return unbound(BINDING_STATE.TECHNICAL_SOURCE_MISMATCH, {
      styleId: str(styleId), bulletinVersionId: standard.bulletinVersionId,
    });
  }

  /* ── 4 · THE VERSION MUST BE THIS STYLE'S, AND SAY SO ITSELF ───────────── */
  if (String(version.sampleStyleId) !== String(styleId)) {
    return unbound(BINDING_STATE.TECHNICAL_SOURCE_MISMATCH, {
      styleId: str(styleId), bulletinVersionId: String(version._id),
    });
  }

  /* A version approved before the frozen source existed confirms no revision.
     Absent is not revision 0, and it is not costable. */
  const frozen = version.technicalSource || null;
  if (!frozen || !str(frozen.technicalRevisionKey)) {
    return unbound(BINDING_STATE.AWAITING_IE_TECHNICAL_CONFIRMATION, {
      styleId: str(styleId), bulletinVersionId: String(version._id),
      reason: "NO_FROZEN_TECHNICAL_SOURCE",
    });
  }
  if (String(frozen.sampleStyleId) !== String(styleId)) {
    return unbound(BINDING_STATE.TECHNICAL_SOURCE_MISMATCH, {
      styleId: str(styleId), bulletinVersionId: String(version._id),
    });
  }

  /* ── 5 · AND IT MUST CONFIRM THE REVISION R&D CURRENTLY STANDS BEHIND ──── */
  if (!rndApproved) {
    /* R&D withdrew or reworked the record IE confirmed. The confirmation is
       still a record; it is not a current technical basis. */
    return unbound(BINDING_STATE.IE_TECHNICAL_APPROVAL_STALE, {
      styleId: str(styleId), confirmedRevision: frozen.technicalRevision, currentRevision: null,
    });
  }
  const currentKey = bulletinVersions().technicalRevisionKeyOf({
    revision: rndApproved.revision,
    submittedAt: rndApproved.submittedAt,
    decidedAt: rndApproved.decidedAt,
    outcome: "approved",
  });
  if (currentKey !== str(frozen.technicalRevisionKey)) {
    /* ── THE NUMBER IS NOT THE IDENTITY ────────────────────────────────
       A revision re-approved under the same number is a different decision,
       and the key is what catches it. */
    return unbound(BINDING_STATE.IE_TECHNICAL_APPROVAL_STALE, {
      styleId: str(styleId),
      confirmedRevision: frozen.technicalRevision,
      currentRevision: rndApproved.revision,
    });
  }

  /* ── 6 · THE SELECTION AND THE CONFIRMED TECHNICAL RECORD MUST AGREE ───
     Only where both sides speak the same vocabulary. The BOM form names
     Inventory ids, which is exactly what the IE snapshot's material rows
     carry, so every confirmed material must be one Merchandising selected. A
     `SELECTION_REVISION` row identifies itself by `rowRef` and names an
     Inventory id only when it was chosen from the catalogue — so the
     comparison is made over the rows that DO name one, and a revision naming
     none is reported as uncheckable rather than silently passed.

     A selection that has moved on without the technical record following it is
     Merchandising's to resolve: they selected something the confirmed record
     does not describe. */
  const snapshot = frozen.snapshot || {};
  const confirmedIds = (Array.isArray(snapshot.materials) ? snapshot.materials : [])
    .map((m) => str(m.rawItemId)).filter(Boolean);
  const selectedIds = new Set(selection.itemIds);
  const comparable = selectedIds.size > 0 && confirmedIds.length > 0;
  const unselected = comparable ? confirmedIds.filter((id) => !selectedIds.has(id)) : [];

  if (unselected.length) {
    return unbound(BINDING_STATE.SELECTION_MISMATCH, {
      styleId: str(styleId),
      bulletinVersionId: String(version._id),
      unselectedMaterialIds: unselected,
      selectionForm: selection.form,
    });
  }
  /* ── THE FACTS THAT ARE NOT THE TECHNICAL BASIS, FROM THEIR OWNERS ─────
     Resolved here so one read of the style serves all three, and published
     BESIDE the technical basis rather than inside it: each carries its own
     provenance, so moving one stales one binding. */
  const packagingSource = await packagingSourceFor(ctx.companyId, style);
  const packingFacts = packingFactsFor(style, {
    garmentsPerCarton: packagingSource.garmentsPerCarton ?? null,
  });

  return {
    state: BINDING_STATE.BOUND,
    bound: true,
    message: "",
    owner: null,
    styleId: str(styleId),

    /* Merchandising's approved packaging, joined to R&D's measurement of it. */
    packagingSource,
    /* The packed weight and the carton capacity, each approved by its owner. */
    packingFacts,

    /* What Central Costing may read, and the identities it must freeze. */
    technical: {
      ieStyleFileId: standard.styleFileId,
      bulletinVersionId: String(version._id),
      bulletinVersionNo: version.versionNo,
      technicalRevision: frozen.technicalRevision,
      technicalRevisionKey: str(frozen.technicalRevisionKey),
      approvedAt: iso(version.approvedAt),
      approvedByName: str(version.approvedByName),

      /* R&D's content, readable ONLY because it arrived through an approved
         version. Null where the snapshot carried nothing — never an empty
         array standing in for "nobody recorded any". */
      materials: Array.isArray(snapshot.materials) ? snapshot.materials : null,
      requirements: Array.isArray(snapshot.requirements) ? snapshot.requirements : null,

      /* ── OUTSIDE SERVICES AND DEVELOPMENT, FROM THE FROZEN REQUIREMENTS ──
         These read `snapshot.services`, a key `technicalRecord.snapshotOf`
         has never written — so they were populated for fixture-built styles
         and null for every real one. They ARE part of the frozen technical
         basis, and the basis states them as `requirements` rows under the two
         families R&D may record: `SERVICE` and `DEVELOPMENT_TOOLING`.

         Split into two lists because they are two costing families with
         different bases — an outside process recurs per garment, tooling is
         one-time — and `null`, not `[]`, when the revision froze no
         requirements at all: an empty list is a claim that nothing is needed,
         and only R&D may make it. */
      services: requirementsOfFamily(snapshot, "SERVICE"),
      development: requirementsOfFamily(snapshot, "DEVELOPMENT_TOOLING"),

      /* ── PACKAGING AND SHIPMENT ARE NOT IN HERE, DELIBERATELY ───────────
         `packaging` and `shipment` were read off this snapshot too, and
         neither has ever been part of it. Neither is IE's to confirm and
         neither is R&D's alone to state:

           · packaging identity and the buyer-facing packing specification are
             MERCHANDISING's approved, versioned record;
           · the packed weight is R&D's measured evidence;
           · how many garments a carton holds is Merchandising's approved pack
             configuration;
           · booking the shipment is Logistics'.

         Each is bound from its own owner with its own provenance, so moving
         one stales one binding rather than all of them. */

      /* IE's own authored content: the route and the times two people signed. */
      operations: (version.rows || []).map((r) => ({
        rowId: r.rowId,
        sequence: r.sequence,
        ieOperationId: str(r.ieOperationId),
        ieOperationRevision: r.ieOperationRevision,
        operationCode: str(r.operationCode),
        operationName: str(r.operationName),
        machineType: str(r.machineType),
        /* The APPROVED standard time, not the proposal. Null stays null. */
        standardTimeMinutes: r.standardTimeMinutes ?? null,
        methodStudyId: r.methodStudyId ? String(r.methodStudyId) : null,
      })),
      garmentSamMinutes: standard.garmentSamMinutes,
      operationCount: standard.operationCount,
      digests: standard.digests,
    },

    selection: {
      ...selection,
      /* Stated, never implied: a costing's provenance should say whether the
         selection and the confirmed record were actually compared. */
      materialsCompared: comparable,
    },
  };
}

module.exports = {
  BINDING_STATE,
  PACKAGING_FORM,
  FAMILY_STATE,
  FAMILY_MESSAGE, SELECTION_FORM, OWNER, STATE_OWNER, MESSAGE,
  bindFor, approvedSelectionFor,
};
