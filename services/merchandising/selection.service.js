// services/merchandising/selection.service.js
//
// WHAT MERCHANDISING HAS SELECTED, AND WHO AGREED TO IT.
//
// The Execution File's two selection families — Materials & Trims, and
// Packaging — from the first empty draft to an approved, frozen, printable
// revision, and the transitional data that can be adopted into one.
//
// ── ONE LIFECYCLE, WRITTEN ONCE ─────────────────────────────────────────────
// Both families move DRAFT → SUBMITTED → APPROVED, and an approved revision
// becomes SUPERSEDED when a later one is approved. A submitted revision can be
// sent back with a recorded reason, which returns it to DRAFT rather than
// inventing a fourth state: it is once again the thing somebody is editing.
//
// The families differ in exactly one thing — the shape of a row — so they
// differ in exactly one place: the FAMILIES registry below. Everything else,
// from version numbering to maker/checker separation to the audit vocabulary,
// is written once. Two copies of a state machine is two state machines.
//
// ── WHAT THIS SERVICE REFUSES TO KNOW ───────────────────────────────────────
// A rate, a price, a supplier, a quotation, a purchase order, stock, a lot, a
// reservation, an ordered/received/issued quantity, a consumption figure, a
// wastage allowance, a laboratory result. Those are Supply Chain's, Store's,
// Product Development's and Quality's. The row schema has nowhere to put one
// and `assertRowShape` refuses it by name at the door, so a caller learns
// which desk owns the field rather than watching it vanish.
//
// A row may REFERENCE an authorised catalogue item. Referencing is not owning:
// what is stored is an identity and a source version, never an operational
// figure that would then have two homes.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const {
  REVISION_FAMILY, REVISION_STATE, COMPONENT_GROUP, PACKAGING_GROUP,
  DEVELOPMENT_TYPE, SOURCE_APPLICATION,
  MaterialTrimRevision, PackagingRevision, DevelopmentRevision,
} = require("../../models/CMS_Models/Merchandising/SelectionRevision");
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const ExecutionUnit = require("../../models/CMS_Models/Merchandising/ExecutionUnit");
const {
  MerchandisingAuditEvent, MerchandisingOutboxEvent, MerchandisingCommandLedger,
  OUTBOX_KIND,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));
const lower = (v) => str(v).toLowerCase();

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/* ═══ WHAT MAY NEVER ARRIVE ════════════════════════════════════════════════ */

/**
 * Fields that name another department's fact, and the desk that owns each.
 *
 * Named rather than merely dropped: a caller who sends `rate` has misunderstood
 * where a rate lives, and "Supply Chain owns a rate" teaches that in one
 * response. Silence would let them keep sending it.
 */
const REFUSED_FIELDS = Object.freeze({
  rate: "a rate — Supply Chain owns it",
  unitRate: "a rate — Supply Chain owns it",
  price: "a price — Supply Chain owns it",
  unitPrice: "a price — Supply Chain owns it",
  cost: "a cost — Costing owns it",
  amount: "an amount — Costing owns it",
  currency: "a currency amount — Costing owns it",
  supplier: "a supplier — Supply Chain owns it",
  supplierId: "a supplier — Supply Chain owns it",
  vendor: "a supplier — Supply Chain owns it",
  quotation: "a quotation — Supply Chain owns it",
  quotationId: "a quotation — Supply Chain owns it",
  purchaseOrder: "a purchase order — Supply Chain owns it",
  purchaseOrderId: "a purchase order — Supply Chain owns it",
  leadTime: "a lead time — Supply Chain owns it",
  stock: "stock — Store owns it",
  stockQuantity: "stock — Store owns it",
  lot: "a lot — Store owns it",
  lotNumber: "a lot — Store owns it",
  reservation: "a reservation — Store owns it",
  receipt: "a receipt — Store owns it",
  orderedQuantity: "an ordered quantity — Supply Chain owns it",
  receivedQuantity: "a received quantity — Store owns it",
  issuedQuantity: "an issued quantity — Store owns it",
  quantity: "a quantity — Product Development measures consumption, Store holds stock",
  consumption: "consumption — Product Development owns it",
  wastage: "wastage — Product Development owns it",
  basis: "a consumption basis — Product Development owns it",
  evidence: "consumption evidence — Product Development owns it",
  labResult: "a laboratory result — Quality owns it",
  laboratoryResult: "a laboratory result — Quality owns it",
  testResult: "a test result — Quality owns it",
  /* Server-owned identity and lifecycle: a caller states none of these. */
  companyId: "a company stamp",
  fileId: "an execution file stamp",
  revisionNo: "a revision number",
  state: "a revision state",
  approvedBy: "an approval",
  approvedAt: "an approval",
});

/* ═══ THE TWO FAMILIES ═════════════════════════════════════════════════════ */

/** The fields a caller may state on a row, per family. */
const MATERIAL_TRIM_ROW_FIELDS = Object.freeze([
  "group", "componentCode", "componentName", "internalRef", "buyerRef",
  "colourOrShade", "finish", "placement", "sizeOrDimension", "specification",
  "notes", "appliesToAllUnits", "unitRefs", "catalogueRef",
]);
const PACKAGING_ROW_FIELDS = Object.freeze([
  "group", "componentCode", "componentName", "buyerRef", "colourOrShade",
  "placement", "sizeOrDimension", "specification", "notes",
  "appliesToAllUnits", "unitRefs", "catalogueRef",
]);
const INSTRUCTION_FIELDS = Object.freeze([
  "foldingMethod", "assortmentInstruction", "ratioDescription",
  "cartonMarks", "additionalInstruction",
]);
const CATALOGUE_REF_FIELDS = Object.freeze(["app", "recordType", "recordId", "recordRef", "sourceVersion"]);
/* M4. A requirement states WHAT is needed and BY WHEN — never how it is made. */
const DEVELOPMENT_ROW_FIELDS = Object.freeze([
  "requirementType", "requirementCode", "title", "brief", "requiredByDate",
  "responsibleApplication", "approvedReferenceExpected", "coordinationNote",
  "appliesToAllUnits", "unitRefs",
]);

const FAMILIES = Object.freeze({
  [REVISION_FAMILY.MATERIAL_TRIM]: {
    key: REVISION_FAMILY.MATERIAL_TRIM,
    model: MaterialTrimRevision,
    label: "Materials & Trims",
    /* What the approved revision is CALLED when it is printed. */
    documentName: "Digital Trim Card",
    rowPrefix: "MTR",
    rowFields: MATERIAL_TRIM_ROW_FIELDS,
    groups: COMPONENT_GROUP,
    hasInstructions: false,
    outbox: {
      submitted: OUTBOX_KIND.MATERIAL_TRIM_SUBMITTED,
      approved: OUTBOX_KIND.MATERIAL_TRIM_APPROVED,
      superseded: OUTBOX_KIND.MATERIAL_TRIM_SUPERSEDED,
    },
  },
  [REVISION_FAMILY.PACKAGING]: {
    key: REVISION_FAMILY.PACKAGING,
    model: PackagingRevision,
    label: "Packaging",
    documentName: "Packaging Specification",
    rowPrefix: "PKG",
    rowFields: PACKAGING_ROW_FIELDS,
    groups: PACKAGING_GROUP,
    hasInstructions: true,
    outbox: {
      submitted: OUTBOX_KIND.PACKAGING_SUBMITTED,
      approved: OUTBOX_KIND.PACKAGING_APPROVED,
      superseded: OUTBOX_KIND.PACKAGING_SUPERSEDED,
    },
  },
  /* ── M4: WHAT DEVELOPMENT THIS ORDER REQUIRES ─────────────────────────
     A third family, and deliberately not a third implementation. What
     Merchandising asks to be developed changes over a season exactly as its
     trims and its packing do, and "what did we ask for in March" has to stay
     answerable — which is the same versioned, approved, superseded record
     the other two already are. It inherits every guarantee: one draft, one
     approved, stable row identity, maker/checker, idempotency, the audit
     vocabulary and the transaction. Only the row shape differs. */
  [REVISION_FAMILY.DEVELOPMENT]: {
    key: REVISION_FAMILY.DEVELOPMENT,
    model: DevelopmentRevision,
    label: "Development Requirements",
    documentName: "Development Requirement Schedule",
    rowPrefix: "DEV",
    rowFields: DEVELOPMENT_ROW_FIELDS,
    /* The row's own identity field is `rowRef` in storage for all three
       families; this family calls it `requirementRef`, which is what a person
       reading a development schedule would call it. */
    rowRefName: "requirementRef",
    normaliseRow: normaliseDevelopmentRow,
    rowView: developmentRowView,
    hasInstructions: false,
    outbox: {
      submitted: OUTBOX_KIND.DEVELOPMENT_SUBMITTED,
      approved: OUTBOX_KIND.DEVELOPMENT_APPROVED,
      superseded: OUTBOX_KIND.DEVELOPMENT_SUPERSEDED,
    },
  },
});

/** The family named in a URL, or a 404 — never a guess. */
function familyOf(name) {
  const found = FAMILIES[str(name).toUpperCase()];
  if (!found) throw fail("NOT_FOUND", "That is not a selection family this file keeps.");
  return found;
}

/* ═══ TRANSACTIONS AND IDENTITY ════════════════════════════════════════════ */

/** One transaction or a 503 — a decision, its audit and its announcement
 *  commit together or the decision did not happen. */
async function withTxn(fn) {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => { out = await fn(session); });
    return out;
  } catch (err) {
    if (/Transaction numbers|replica set|transactions are not supported/i.test(str(err?.message))) {
      throw fail("MERCHANDISING_TRANSACTION_REQUIRED",
        "This deployment cannot record the decision atomically. Ask an operator — the database needs a replica set.");
    }
    throw err;
  } finally {
    session.endSession();
  }
}

/** A row's permanent, opaque name. Minted once and carried by every clone. */
const mintRowRef = (prefix) => `${prefix}-${crypto.randomBytes(6).toString("hex")}`;

/** A fingerprint that does not change when a client reorders its JSON. */
function hashRequest(value) {
  const canonical = (v) => {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) return v.map(canonical);
    if (typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) {
        if (k === "idempotencyKey") continue;
        out[k] = canonical(v[k]);
      }
      return out;
    }
    return v;
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

/**
 * Run a retry-sensitive command once.
 *
 * Same key and same request → the original answer, replayed. Same key and a
 * DIFFERENT request → refused, because that is a client bug and replaying an
 * unrelated answer would hide it. The unique index does the deciding, so two
 * requests racing with one key cannot both act.
 */
async function once(ctx, { scope, idempotencyKey, request }, run) {
  const key = str(idempotencyKey);
  if (!key) {
    throw fail("IDEMPOTENCY_KEY_REQUIRED",
      "Send an idempotency key with this command, so a retry cannot take the decision twice.",
      { field: "idempotencyKey" });
  }
  const requestHash = hashRequest(request);
  const held = await MerchandisingCommandLedger.findOne({
    companyId: ctx.companyId, scope, idempotencyKey: key,
  }).lean();
  if (held) {
    if (held.requestHash !== requestHash) {
      throw fail("IDEMPOTENCY_KEY_REUSED",
        "That idempotency key was already used for a different request.", { field: "idempotencyKey" });
    }
    return { replayed: true, ledger: held.result };
  }

  const result = await run();
  try {
    await MerchandisingCommandLedger.create([{
      companyId: ctx.companyId, scope, idempotencyKey: key, requestHash,
      result: {
        revisionId: result?.revision?.id || null,
        revisionNo: result?.revision?.revisionNo ?? null,
        state: str(result?.revision?.state),
        note: str(result?.note),
      },
      at: new Date(),
    }]);
  } catch (err) {
    /* Somebody else recorded the same key first. The command already ran, so
       the honest answer is theirs, not a failure. */
    if (err?.code !== 11000) throw err;
  }
  return { replayed: false, ...result };
}

/* ═══ THE FILE THIS BELONGS TO ═════════════════════════════════════════════ */

function assertContext(ctx) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
}

/**
 * The Execution File, proved to be this company's.
 *
 * A file belonging to somebody else reads exactly like one that does not
 * exist. A refusal that distinguished them would be a way to ask whether a
 * competitor's order number is real.
 */
async function loadFile(ctx, fileId, session = null) {
  assertContext(ctx);
  if (!isId(fileId)) throw fail("NOT_FOUND", "Execution file not found.");
  const query = ExecutionFile.findOne({ _id: fileId, companyId: ctx.companyId });
  const file = session ? await query.session(session) : await query;
  if (!file) throw fail("NOT_FOUND", "Execution file not found.");
  return file;
}

/**
 * The execution units a row may name, as a set of discriminators.
 *
 * Read from THIS file, so naming a unit of another file — or of another
 * company's file — cannot succeed however the reference was obtained.
 */
async function unitRefsOf(file, session = null) {
  const query = ExecutionUnit.find({ fileId: file._id, companyId: file.companyId })
    .select("unitDiscriminator active");
  const units = session ? await query.session(session) : await query;
  return new Set(units.map((u) => str(u.unitDiscriminator)));
}

/* ═══ ROW SHAPE ════════════════════════════════════════════════════════════ */

/** Refuse any field this door does not accept, by name. */
function assertRowShape(family, body) {
  for (const key of Object.keys(body || {})) {
    const refused = REFUSED_FIELDS[key];
    if (refused) {
      throw fail("FIELD_NOT_ACCEPTED",
        `A selection row states what is required, not ${refused}.`, { field: key });
    }
    if (!family.rowFields.includes(key)) {
      throw fail("FIELD_NOT_ACCEPTED", `"${key}" is not part of a ${family.label} row.`, { field: key });
    }
  }
  for (const key of Object.keys(body?.catalogueRef || {})) {
    if (REFUSED_FIELDS[key]) {
      throw fail("FIELD_NOT_ACCEPTED",
        `A catalogue reference names an item. It cannot carry ${REFUSED_FIELDS[key]}.`, { field: key });
    }
    if (!CATALOGUE_REF_FIELDS.includes(key)) {
      throw fail("FIELD_NOT_ACCEPTED", `"${key}" is not part of a catalogue reference.`, { field: key });
    }
  }
}

/**
 * A development requirement, validated.
 *
 * Applicability is shared with the other families, so it is normalised by the
 * same code — a requirement that applies to one colourway is the same kind of
 * statement as a trim that does.
 */
function normaliseDevelopmentRow(family, body, { known, rowRef }) {
  assertRowShape(family, body);

  const requirementType = str(body.requirementType).toUpperCase();
  if (!Object.values(DEVELOPMENT_TYPE).includes(requirementType)) {
    throw fail("VALIDATION",
      `Choose what kind of development this is: ${Object.values(DEVELOPMENT_TYPE).join(", ")}.`,
      { field: "requirementType" });
  }
  const title = str(body.title);
  if (!title) throw fail("VALIDATION", "A requirement needs a short title.", { field: "title" });

  const responsibleApplication = str(body.responsibleApplication).toUpperCase()
    || SOURCE_APPLICATION.PRODUCT_DEVELOPMENT;
  if (!Object.values(SOURCE_APPLICATION).includes(responsibleApplication)) {
    throw fail("VALIDATION",
      `Say whose work this is: ${Object.values(SOURCE_APPLICATION).join(", ")}.`,
      { field: "responsibleApplication" });
  }

  let requiredByDate = null;
  if (body.requiredByDate) {
    requiredByDate = new Date(body.requiredByDate);
    if (Number.isNaN(requiredByDate.getTime())) {
      throw fail("VALIDATION", "That required-by date is not a date.", { field: "requiredByDate" });
    }
  }

  const { appliesToAllUnits, unitRefs } = normaliseApplicability(body, known);
  return {
    rowRef,
    requirementType,
    requirementCode: str(body.requirementCode).slice(0, 80),
    title,
    brief: str(body.brief).slice(0, 4000),
    requiredByDate,
    responsibleApplication,
    approvedReferenceExpected: body.approvedReferenceExpected !== false,
    coordinationNote: str(body.coordinationNote).slice(0, 2000),
    appliesToAllUnits,
    unitRefs,
  };
}

/** What anybody may be told about one development requirement. */
function developmentRowView(row) {
  return {
    requirementRef: str(row.rowRef),
    rowRef: str(row.rowRef),
    requirementType: str(row.requirementType),
    requirementCode: str(row.requirementCode),
    title: str(row.title),
    brief: str(row.brief),
    requiredByDate: row.requiredByDate || null,
    responsibleApplication: str(row.responsibleApplication),
    approvedReferenceExpected: row.approvedReferenceExpected !== false,
    coordinationNote: str(row.coordinationNote),
    appliesToAllUnits: row.appliesToAllUnits !== false,
    unitRefs: (row.unitRefs || []).map(str),
    sourceRef: row.sourceRef?.recordId || row.sourceRef?.recordRef
      ? {
        app: str(row.sourceRef.app),
        recordType: str(row.sourceRef.recordType),
        recordRef: str(row.sourceRef.recordRef),
        sourceVersion: str(row.sourceRef.sourceVersion),
        sourceState: str(row.sourceRef.sourceState),
      }
      : null,
  };
}

/** "All units", or these units — proved against THIS file, for any family. */
function normaliseApplicability(body, known) {
  const appliesToAllUnits = body.appliesToAllUnits !== false;
  if (appliesToAllUnits) return { appliesToAllUnits: true, unitRefs: [] };
  const unitRefs = [...new Set((Array.isArray(body.unitRefs) ? body.unitRefs : []).map(str).filter(Boolean))];
  if (!unitRefs.length) {
    throw fail("VALIDATION",
      "Say which execution units this applies to, or mark it as applying to all of them.",
      { field: "unitRefs" });
  }
  for (const ref of unitRefs) {
    if (!known.has(ref)) {
      throw fail("SELECTION_UNIT_UNKNOWN",
        `"${ref}" is not an execution unit of this file.`, { field: "unitRefs", value: ref });
    }
  }
  return { appliesToAllUnits: false, unitRefs };
}

/** Validate and normalise one row's stated fields. */
function normaliseRow(family, body, { known, rowRef }) {
  if (family.normaliseRow) return family.normaliseRow(family, body, { known, rowRef });
  assertRowShape(family, body);

  const group = str(body.group).toUpperCase();
  if (!Object.values(family.groups).includes(group)) {
    throw fail("VALIDATION",
      `Choose which kind of component this is: ${Object.values(family.groups).join(", ")}.`,
      { field: "group" });
  }
  const componentName = str(body.componentName);
  if (!componentName) {
    throw fail("VALIDATION", "A row needs the component's name.", { field: "componentName" });
  }

  /* ── APPLICABILITY ─────────────────────────────────────────────────────
     "All units" and "these units" are different statements, and an empty
     list is neither. A row that applies to nothing would be a selection
     nobody executes. */
  const appliesToAllUnits = body.appliesToAllUnits !== false;
  let unitRefs = [];
  if (!appliesToAllUnits) {
    unitRefs = [...new Set((Array.isArray(body.unitRefs) ? body.unitRefs : []).map(str).filter(Boolean))];
    if (!unitRefs.length) {
      throw fail("VALIDATION",
        "Say which execution units this row applies to, or mark it as applying to all of them.",
        { field: "unitRefs" });
    }
    for (const ref of unitRefs) {
      if (!known.has(ref)) {
        throw fail("SELECTION_UNIT_UNKNOWN",
          `"${ref}" is not an execution unit of this file.`, { field: "unitRefs", value: ref });
      }
    }
  }

  const text = (key, max = 2000) => str(body[key]).slice(0, max);
  const out = {
    rowRef,
    group,
    componentName,
    componentCode: text("componentCode", 80),
    buyerRef: text("buyerRef", 120),
    colourOrShade: text("colourOrShade", 120),
    placement: text("placement", 200),
    sizeOrDimension: text("sizeOrDimension", 200),
    specification: text("specification"),
    notes: text("notes"),
    appliesToAllUnits,
    unitRefs,
  };
  if (family.rowFields.includes("internalRef")) out.internalRef = text("internalRef", 120);
  if (family.rowFields.includes("finish")) out.finish = text("finish", 200);

  if (body.catalogueRef && Object.keys(body.catalogueRef).length) {
    const ref = body.catalogueRef;
    out.catalogueRef = {
      app: str(ref.app) || "inventory",
      recordType: str(ref.recordType) || "raw_item",
      ...(isId(ref.recordId) ? { recordId: new mongoose.Types.ObjectId(str(ref.recordId)) } : {}),
      recordRef: str(ref.recordRef),
      sourceVersion: str(ref.sourceVersion),
    };
  }
  return out;
}

/** The packing instructions, refused field by field like everything else. */
function normaliseInstructions(body) {
  for (const key of Object.keys(body || {})) {
    if (REFUSED_FIELDS[key]) {
      throw fail("FIELD_NOT_ACCEPTED",
        `A packing instruction cannot carry ${REFUSED_FIELDS[key]}.`, { field: key });
    }
    if (!INSTRUCTION_FIELDS.includes(key)) {
      throw fail("FIELD_NOT_ACCEPTED", `"${key}" is not a packing instruction.`, { field: key });
    }
  }
  const out = {};
  for (const key of INSTRUCTION_FIELDS) {
    out[key] = str(body?.[key]).slice(0, key === "additionalInstruction" ? 4000 : 2000);
  }
  return out;
}

/* ═══ VIEWS ════════════════════════════════════════════════════════════════ */

function rowView(row) {
  return {
    rowRef: str(row.rowRef),
    group: str(row.group),
    componentCode: str(row.componentCode),
    componentName: str(row.componentName),
    internalRef: str(row.internalRef),
    buyerRef: str(row.buyerRef),
    colourOrShade: str(row.colourOrShade),
    finish: str(row.finish),
    placement: str(row.placement),
    sizeOrDimension: str(row.sizeOrDimension),
    specification: str(row.specification),
    notes: str(row.notes),
    appliesToAllUnits: row.appliesToAllUnits !== false,
    unitRefs: (row.unitRefs || []).map(str),
    catalogueRef: row.catalogueRef?.recordId || row.catalogueRef?.recordRef
      ? {
        app: str(row.catalogueRef.app),
        recordType: str(row.catalogueRef.recordType),
        recordRef: str(row.catalogueRef.recordRef),
        sourceVersion: str(row.catalogueRef.sourceVersion),
      }
      : null,
    sourceRef: row.sourceRef?.recordId || row.sourceRef?.recordRef
      ? {
        app: str(row.sourceRef.app),
        recordType: str(row.sourceRef.recordType),
        recordRef: str(row.sourceRef.recordRef),
        sourceVersion: str(row.sourceRef.sourceVersion),
        sourceState: str(row.sourceRef.sourceState),
      }
      : null,
  };
}

/** What anybody may be told about one revision. Allowlisted, field by field. */
function revisionView(family, doc, { rows = true } = {}) {
  if (!doc) return null;
  return {
    id: str(doc._id),
    family: family.key,
    revisionNo: doc.revisionNo,
    state: str(doc.state),
    rowCount: (doc.rows || []).length,
    ...(rows ? { rows: (doc.rows || []).map(family.rowView || rowView) } : {}),
    ...(family.hasInstructions
      ? {
        instructions: {
          foldingMethod: str(doc.instructions?.foldingMethod),
          assortmentInstruction: str(doc.instructions?.assortmentInstruction),
          ratioDescription: str(doc.instructions?.ratioDescription),
          cartonMarks: str(doc.instructions?.cartonMarks),
          additionalInstruction: str(doc.instructions?.additionalInstruction),
        },
      }
      : {}),
    createdByName: str(doc.createdBy?.name),
    submittedByName: str(doc.submittedBy?.name),
    submittedAt: doc.submittedAt || null,
    approvedByName: str(doc.approvedBy?.name),
    approvedAt: doc.approvedAt || null,
    changesRequired: doc.changesRequired?.at
      ? {
        reason: str(doc.changesRequired.reason),
        byName: str(doc.changesRequired.by?.name),
        at: doc.changesRequired.at,
      }
      : null,
    clonedFromRevisionId: doc.clonedFromRevisionId ? str(doc.clonedFromRevisionId) : null,
    supersedesRevisionId: doc.supersedesRevisionId ? str(doc.supersedesRevisionId) : null,
    supersededByRevisionId: doc.supersededByRevisionId ? str(doc.supersededByRevisionId) : null,
    supersededAt: doc.supersededAt || null,
    adoption: doc.adoption?.adoptedAt
      ? {
        batchId: str(doc.adoption.batchId),
        sourceRecordType: str(doc.adoption.sourceRecordType),
        adoptedAt: doc.adoption.adoptedAt,
        adoptedByName: str(doc.adoption.adoptedBy?.name),
      }
      : null,
    revision: doc.revision,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/* ═══ READS ════════════════════════════════════════════════════════════════ */

const WORKING_STATES = [REVISION_STATE.DRAFT, REVISION_STATE.SUBMITTED];

async function findWorking(family, file, session = null) {
  const q = family.model.findOne({
    companyId: file.companyId, fileId: file._id, state: { $in: WORKING_STATES },
  });
  return session ? q.session(session) : q;
}

async function findApproved(family, file, session = null) {
  const q = family.model.findOne({
    companyId: file.companyId, fileId: file._id, state: REVISION_STATE.APPROVED,
  });
  return session ? q.session(session) : q;
}

/**
 * The family's whole position on one file: what is in force, what is being
 * worked on, and how many revisions have gone before.
 */
async function getCurrent(ctx, { fileId, family: familyName } = {}) {
  const family = familyOf(familyName);
  const file = await loadFile(ctx, fileId);
  const [approved, working, total, units] = await Promise.all([
    findApproved(family, file),
    findWorking(family, file),
    family.model.countDocuments({ companyId: file.companyId, fileId: file._id }),
    ExecutionUnit.find({ fileId: file._id, companyId: file.companyId, active: true })
      .select("unitDiscriminator dropRef sizeRange attributes quantity").lean(),
  ]);
  return {
    family: family.key,
    label: family.label,
    documentName: family.documentName,
    approved: revisionView(family, approved),
    working: revisionView(family, working),
    revisionCount: total,
    /* The applicability vocabulary, so a screen can offer real units rather
       than a free-text box that invents them. */
    units: units.map((u) => ({
      unitDiscriminator: str(u.unitDiscriminator),
      dropRef: str(u.dropRef),
      sizeRange: str(u.sizeRange),
      attributes: (u.attributes || []).map((a) => ({ name: str(a.name), value: str(a.value) })),
      quantity: u.quantity,
    })),
  };
}

/** One specific revision, frozen or not. */
async function getRevision(ctx, { fileId, family: familyName, revisionNo } = {}) {
  const family = familyOf(familyName);
  const file = await loadFile(ctx, fileId);
  const no = Number(revisionNo);
  if (!Number.isInteger(no) || no < 1) {
    throw fail("SELECTION_REVISION_NOT_FOUND", "That revision does not exist.");
  }
  const doc = await family.model.findOne({
    companyId: file.companyId, fileId: file._id, revisionNo: no,
  });
  if (!doc) throw fail("SELECTION_REVISION_NOT_FOUND", "That revision does not exist.");
  return { family: family.key, revision: revisionView(family, doc) };
}

/** The revision history, newest first, paged. */
async function listRevisions(ctx, { fileId, family: familyName, cursor, limit } = {}) {
  const family = familyOf(familyName);
  const file = await loadFile(ctx, fileId);

  const asked = limit === undefined || limit === null || limit === "" ? DEFAULT_LIMIT : Number(limit);
  if (!Number.isInteger(asked) || asked < 1) {
    throw fail("VALIDATION", "Ask for a whole number of revisions.", { field: "limit" });
  }
  const size = Math.min(asked, MAX_LIMIT);

  const query = { companyId: file.companyId, fileId: file._id };
  if (str(cursor)) {
    const before = Number(cursor);
    if (!Number.isInteger(before) || before < 1) {
      throw fail("VALIDATION", "That page marker is not one this list issued.", { field: "cursor" });
    }
    query.revisionNo = { $lt: before };
  }
  const rows = await family.model.find(query).sort({ revisionNo: -1 }).limit(size + 1);
  const page = rows.slice(0, size);
  return {
    family: family.key,
    revisions: page.map((r) => revisionView(family, r, { rows: false })),
    cursor: rows.length > size ? String(page[page.length - 1].revisionNo) : null,
  };
}

/* ═══ COMMANDS ═════════════════════════════════════════════════════════════ */

const scopeFor = (fileId, family, command) => `${command}:${family.key}:${str(fileId)}`;

/** The next number this family has ever used on this file, plus one. */
async function nextRevisionNo(family, file, session) {
  const [highest] = await family.model.find({ companyId: file.companyId, fileId: file._id })
    .sort({ revisionNo: -1 }).limit(1).session(session);
  return (highest ? highest.revisionNo : 0) + 1;
}

/** The audit row every command writes, with only its own details differing. */
function auditRow({ file, family, doc, action, actor, at, correlationId, previousState, resultingState, reason, details }) {
  return {
    companyId: file.companyId,
    recordType: "SELECTION_REVISION",
    recordId: doc._id,
    recordRevision: doc.revisionNo,
    action,
    actor: actor || undefined,
    source: "merchandising",
    at,
    reason: str(reason).slice(0, 1000),
    correlationId,
    previousState: str(previousState),
    resultingState: str(resultingState),
    details: { family: family.key, fileNumber: str(file.fileNumber), revisionNo: doc.revisionNo, ...(details || {}) },
  };
}

/** An outbox announcement of a decision another application must eventually
 *  learn. Nothing consumes these in M3 — that is a later milestone's worker. */
function outboxRow({ file, family, doc, kind, correlationId, superseded = null }) {
  return {
    companyId: file.companyId,
    kind,
    payload: {
      executionFileId: file._id,
      family: family.key,
      revisionId: doc._id,
      revisionNo: doc.revisionNo,
      ...(superseded
        ? { supersededRevisionId: superseded._id, supersededRevisionNo: superseded.revisionNo }
        : {}),
    },
    correlationId,
  };
}

/**
 * CREATE A DRAFT — empty, or cloned from an existing revision.
 *
 * Cloning carries every row's permanent reference forward, which is what makes
 * "this label moved at revision 4" a sentence somebody can write. A row the
 * new draft withdraws simply is not in it; the revision it was approved in
 * still has it, for ever.
 */
async function createDraft(ctx, { fileId, family: familyName, body = {}, actor = null, idempotencyKey } = {}) {
  const family = familyOf(familyName);
  const file = await loadFile(ctx, fileId);
  const from = body?.fromRevisionNo === undefined || body?.fromRevisionNo === null || body?.fromRevisionNo === ""
    ? null : Number(body.fromRevisionNo);
  if (from !== null && (!Number.isInteger(from) || from < 1)) {
    throw fail("VALIDATION", "Say which revision to start from, or none at all.", { field: "fromRevisionNo" });
  }

  return once(ctx, {
    scope: scopeFor(file._id, family, "draft"),
    idempotencyKey,
    request: { fromRevisionNo: from },
  }, async () => withTxn(async (session) => {
    const working = await findWorking(family, file, session);
    if (working) {
      throw fail("SELECTION_DRAFT_EXISTS",
        working.state === REVISION_STATE.DRAFT
          ? `Revision ${working.revisionNo} is already open as a draft.`
          : `Revision ${working.revisionNo} is submitted and awaiting a decision.`,
        { revisionNo: working.revisionNo, state: working.state });
    }

    let source = null;
    if (from !== null) {
      source = await family.model.findOne({
        companyId: file.companyId, fileId: file._id, revisionNo: from,
      }).session(session);
      if (!source) throw fail("SELECTION_REVISION_NOT_FOUND", "That revision does not exist.");
    } else {
      /* No source named: continue from what is in force, if anything is. */
      source = await findApproved(family, file, session);
    }

    const at = new Date();
    const correlationId = crypto.randomUUID();
    const revisionNo = await nextRevisionNo(family, file, session);

    const [doc] = await family.model.create([{
      companyId: file.companyId,
      fileId: file._id,
      revisionNo,
      state: REVISION_STATE.DRAFT,
      rows: source ? source.rows.map((r) => ({ ...r.toObject() })) : [],
      ...(family.hasInstructions
        ? { instructions: source ? { ...source.instructions?.toObject?.() || source.instructions } : {} }
        : {}),
      clonedFromRevisionId: source ? source._id : null,
      createdBy: actor || undefined,
      updatedBy: actor || undefined,
    }], { session });

    await MerchandisingAuditEvent.create([auditRow({
      file, family, doc, action: "SELECTION_DRAFT_CREATED", actor, at, correlationId,
      resultingState: REVISION_STATE.DRAFT,
      details: { clonedFromRevisionNo: source ? source.revisionNo : null, rowCount: doc.rows.length },
    })], { session, ordered: true });

    return { revision: revisionView(family, doc), clonedFromRevisionNo: source ? source.revisionNo : null };
  }));
}

/**
 * The draft a mutation may touch, with its expected revision proved.
 *
 * A submitted or approved revision is never editable: submitted is waiting for
 * somebody's decision and editing it under them would make that decision about
 * something they did not read, and approved is history.
 */
async function loadDraftForEdit(ctx, { fileId, family, expectedRevision }, session) {
  const file = await loadFile(ctx, fileId, session);
  const working = await findWorking(family, file, session);
  if (!working) {
    throw fail("SELECTION_STATE_CONFLICT",
      `There is no open ${family.label} draft on this file. Create one first.`);
  }
  if (working.state !== REVISION_STATE.DRAFT) {
    throw fail("SELECTION_STATE_CONFLICT",
      `Revision ${working.revisionNo} is submitted and awaiting a decision. Ask for changes to reopen it.`,
      { revisionNo: working.revisionNo, state: working.state });
  }
  const expected = Number(expectedRevision);
  if (!Number.isInteger(expected)) {
    throw fail("VALIDATION", "Say which revision of the draft you are changing.", { field: "expectedRevision" });
  }
  if (expected !== working.revision) {
    throw fail("SELECTION_REVISION_CONFLICT",
      "Somebody changed this draft while you were editing. Re-read it and try again.",
      { expected, actual: working.revision });
  }
  return { file, draft: working };
}

/** ADD A ROW to the open draft. */
async function addRow(ctx, { fileId, family: familyName, body = {}, actor = null } = {}) {
  const family = familyOf(familyName);
  const { expectedRevision, ...row } = body || {};
  return withTxn(async (session) => {
    const { file, draft } = await loadDraftForEdit(ctx, { fileId, family, expectedRevision }, session);
    const known = await unitRefsOf(file, session);
    const shaped = normaliseRow(family, row, { known, rowRef: mintRowRef(family.rowPrefix) });

    draft.rows.push(shaped);
    draft.revision += 1;
    draft.updatedBy = actor || undefined;
    await draft.save({ session });

    await MerchandisingAuditEvent.create([auditRow({
      file, family, doc: draft, action: "SELECTION_ROW_ADDED", actor,
      at: new Date(), correlationId: crypto.randomUUID(),
      previousState: REVISION_STATE.DRAFT, resultingState: REVISION_STATE.DRAFT,
      details: { rowRef: shaped.rowRef, componentName: shaped.componentName, group: shaped.group },
    })], { session, ordered: true });

    return { revision: revisionView(family, draft), rowRef: shaped.rowRef };
  });
}

/** EDIT A ROW of the open draft, keeping its permanent reference. */
async function updateRow(ctx, { fileId, family: familyName, rowRef, body = {}, actor = null } = {}) {
  const family = familyOf(familyName);
  const { expectedRevision, ...row } = body || {};
  return withTxn(async (session) => {
    const { file, draft } = await loadDraftForEdit(ctx, { fileId, family, expectedRevision }, session);
    const index = draft.rows.findIndex((r) => str(r.rowRef) === str(rowRef));
    if (index < 0) throw fail("SELECTION_ROW_NOT_FOUND", "That row is not in this draft.");

    const known = await unitRefsOf(file, session);
    const shaped = normaliseRow(family, row, { known, rowRef: str(rowRef) });
    const before = draft.rows[index].toObject();
    draft.rows.set(index, shaped);
    draft.revision += 1;
    draft.updatedBy = actor || undefined;
    await draft.save({ session });

    await MerchandisingAuditEvent.create([auditRow({
      file, family, doc: draft, action: "SELECTION_ROW_UPDATED", actor,
      at: new Date(), correlationId: crypto.randomUUID(),
      previousState: REVISION_STATE.DRAFT, resultingState: REVISION_STATE.DRAFT,
      details: {
        rowRef: shaped.rowRef,
        componentName: shaped.componentName,
        previousComponentName: str(before.componentName),
      },
    })], { session, ordered: true });

    return { revision: revisionView(family, draft), rowRef: shaped.rowRef };
  });
}

/**
 * WITHDRAW A ROW from the open draft.
 *
 * The row leaves the DRAFT, which is not history — it is the thing being
 * written. Every revision it was approved in still carries it, unchanged and
 * readable, which is what "removed rows remain visible in historical
 * revisions" means. Nothing approved is ever edited or deleted.
 */
async function removeRow(ctx, { fileId, family: familyName, rowRef, body = {}, actor = null } = {}) {
  const family = familyOf(familyName);
  return withTxn(async (session) => {
    const { file, draft } = await loadDraftForEdit(
      ctx, { fileId, family, expectedRevision: body?.expectedRevision }, session,
    );
    const index = draft.rows.findIndex((r) => str(r.rowRef) === str(rowRef));
    if (index < 0) throw fail("SELECTION_ROW_NOT_FOUND", "That row is not in this draft.");

    const removed = draft.rows[index].toObject();
    draft.rows.splice(index, 1);
    draft.revision += 1;
    draft.updatedBy = actor || undefined;
    await draft.save({ session });

    await MerchandisingAuditEvent.create([auditRow({
      file, family, doc: draft, action: "SELECTION_ROW_WITHDRAWN", actor,
      at: new Date(), correlationId: crypto.randomUUID(),
      reason: body?.reason,
      previousState: REVISION_STATE.DRAFT, resultingState: REVISION_STATE.DRAFT,
      details: { rowRef: str(removed.rowRef), componentName: str(removed.componentName) },
    })], { session, ordered: true });

    return { revision: revisionView(family, draft), rowRef: str(removed.rowRef) };
  });
}

/** RESTATE THE PACKING INSTRUCTIONS on the open draft. */
async function updateInstructions(ctx, { fileId, family: familyName, body = {}, actor = null } = {}) {
  const family = familyOf(familyName);
  if (!family.hasInstructions) {
    throw fail("NOT_FOUND", `${family.label} has no packing instructions.`);
  }
  const { expectedRevision, ...instructions } = body || {};
  return withTxn(async (session) => {
    const { file, draft } = await loadDraftForEdit(ctx, { fileId, family, expectedRevision }, session);
    draft.instructions = normaliseInstructions(instructions);
    draft.revision += 1;
    draft.updatedBy = actor || undefined;
    await draft.save({ session });

    await MerchandisingAuditEvent.create([auditRow({
      file, family, doc: draft, action: "SELECTION_INSTRUCTIONS_UPDATED", actor,
      at: new Date(), correlationId: crypto.randomUUID(),
      previousState: REVISION_STATE.DRAFT, resultingState: REVISION_STATE.DRAFT,
    })], { session, ordered: true });

    return { revision: revisionView(family, draft) };
  });
}

/** SUBMIT the draft for a decision. */
async function submit(ctx, { fileId, family: familyName, body = {}, actor = null, idempotencyKey } = {}) {
  const family = familyOf(familyName);
  const file = await loadFile(ctx, fileId);

  return once(ctx, {
    scope: scopeFor(file._id, family, "submit"),
    idempotencyKey,
    request: { expectedRevision: body?.expectedRevision },
  }, async () => withTxn(async (session) => {
    const { draft } = await loadDraftForEdit(
      ctx, { fileId, family, expectedRevision: body?.expectedRevision }, session,
    );
    if (!draft.rows.length) {
      throw fail("SELECTION_STATE_CONFLICT",
        `A ${family.label} revision needs at least one row before it can be submitted.`);
    }
    const at = new Date();
    const correlationId = crypto.randomUUID();

    draft.state = REVISION_STATE.SUBMITTED;
    draft.submittedBy = actor || undefined;
    draft.submittedAt = at;
    draft.revision += 1;
    await draft.save({ session });

    await MerchandisingAuditEvent.create([auditRow({
      file, family, doc: draft, action: "SELECTION_SUBMITTED", actor, at, correlationId,
      previousState: REVISION_STATE.DRAFT, resultingState: REVISION_STATE.SUBMITTED,
      details: { rowCount: draft.rows.length },
    })], { session, ordered: true });
    await MerchandisingOutboxEvent.create([outboxRow({
      file, family, doc: draft, kind: family.outbox.submitted, correlationId,
    })], { session, ordered: true });

    return { revision: revisionView(family, draft) };
  }));
}

/**
 * REQUEST CHANGES — a recorded decision that returns the revision to DRAFT.
 *
 * The reason is mandatory and is kept ON the revision, so the person who
 * reopens it reads why without going to the history. Nothing about the rows is
 * touched: the approver is asking for a change, not making one.
 */
async function requestChanges(ctx, { fileId, family: familyName, body = {}, actor = null, idempotencyKey } = {}) {
  const family = familyOf(familyName);
  const file = await loadFile(ctx, fileId);
  const reason = str(body?.reason);
  if (!reason) {
    throw fail("VALIDATION", "Say what needs to change before sending it back.", { field: "reason" });
  }

  return once(ctx, {
    scope: scopeFor(file._id, family, "changes"),
    idempotencyKey,
    request: { reason, expectedRevision: body?.expectedRevision },
  }, async () => withTxn(async (session) => {
    const working = await findWorking(family, file, session);
    if (!working || working.state !== REVISION_STATE.SUBMITTED) {
      throw fail("SELECTION_STATE_CONFLICT",
        `There is no submitted ${family.label} revision to decide on.`);
    }
    const expected = Number(body?.expectedRevision);
    if (Number.isInteger(expected) && expected !== working.revision) {
      throw fail("SELECTION_REVISION_CONFLICT",
        "This revision moved while you were reading it. Re-read it and try again.",
        { expected, actual: working.revision });
    }
    const at = new Date();
    const correlationId = crypto.randomUUID();

    working.state = REVISION_STATE.DRAFT;
    working.changesRequired = { reason: reason.slice(0, 1000), by: actor || undefined, at };
    working.submittedBy = undefined;
    working.submittedAt = null;
    working.revision += 1;
    await working.save({ session });

    await MerchandisingAuditEvent.create([auditRow({
      file, family, doc: working, action: "SELECTION_CHANGES_REQUESTED", actor, at, correlationId,
      reason, previousState: REVISION_STATE.SUBMITTED, resultingState: REVISION_STATE.DRAFT,
    })], { session, ordered: true });

    return { revision: revisionView(family, working) };
  }));
}

/**
 * APPROVE — the submitted revision becomes the one in force.
 *
 * ── MAKER AND CHECKER ARE DIFFERENT PEOPLE ────────────────────────────────
 * The approver may not be the person who authored the revision, nor the one
 * who submitted it. An owner is not an exception: seniority is authority to
 * decide, never permission to decide about your own work, and the whole point
 * of a second signature is that it belongs to a second person.
 *
 * ── AND THE PREVIOUS TRUTH STEPS DOWN FIRST ───────────────────────────────
 * At most one approved revision may exist per file and family, and the
 * database enforces it with a partial unique index checked as each write
 * lands. So the outgoing revision is marked SUPERSEDED before the incoming
 * one is promoted — both inside one transaction, so the file is never
 * momentarily without a truth and never briefly has two.
 */
async function approve(ctx, { fileId, family: familyName, body = {}, actor = null, idempotencyKey } = {}) {
  const family = familyOf(familyName);
  const file = await loadFile(ctx, fileId);

  return once(ctx, {
    scope: scopeFor(file._id, family, "approve"),
    idempotencyKey,
    request: { expectedRevision: body?.expectedRevision },
  }, async () => withTxn(async (session) => {
    const working = await findWorking(family, file, session);
    if (!working || working.state !== REVISION_STATE.SUBMITTED) {
      throw fail("SELECTION_STATE_CONFLICT",
        `There is no submitted ${family.label} revision to approve.`);
    }
    const expected = Number(body?.expectedRevision);
    if (Number.isInteger(expected) && expected !== working.revision) {
      throw fail("SELECTION_REVISION_CONFLICT",
        "This revision moved while you were reading it. Re-read it and try again.",
        { expected, actual: working.revision });
    }

    const approver = { id: str(actor?.id), email: lower(actor?.email) };
    const isSamePerson = (who) => Boolean(
      (approver.email && lower(who?.email) === approver.email)
      || (approver.id && str(who?.id) === approver.id),
    );
    if (isSamePerson(working.createdBy) || isSamePerson(working.submittedBy)) {
      throw fail("SELECTION_APPROVAL_SEPARATION",
        "A revision is approved by somebody other than the person who wrote or submitted it.",
        {
          revisionNo: working.revisionNo,
          authoredByYou: isSamePerson(working.createdBy),
          submittedByYou: isSamePerson(working.submittedBy),
        });
    }

    const at = new Date();
    const correlationId = crypto.randomUUID();
    const audits = [];
    const outbox = [];

    /* The outgoing truth steps down first — the index is checked per write. */
    const previous = await findApproved(family, file, session);
    if (previous) {
      previous.state = REVISION_STATE.SUPERSEDED;
      previous.supersededByRevisionId = working._id;
      previous.supersededAt = at;
      await previous.save({ session });
      audits.push(auditRow({
        file, family, doc: previous, action: "SELECTION_SUPERSEDED", actor, at, correlationId,
        previousState: REVISION_STATE.APPROVED, resultingState: REVISION_STATE.SUPERSEDED,
        details: { supersededByRevisionNo: working.revisionNo },
      }));
      outbox.push(outboxRow({
        file, family, doc: previous, kind: family.outbox.superseded, correlationId,
      }));
    }

    working.state = REVISION_STATE.APPROVED;
    working.approvedBy = actor || undefined;
    working.approvedAt = at;
    working.supersedesRevisionId = previous ? previous._id : null;
    working.revision += 1;
    await working.save({ session });

    audits.push(auditRow({
      file, family, doc: working, action: "SELECTION_APPROVED", actor, at, correlationId,
      previousState: REVISION_STATE.SUBMITTED, resultingState: REVISION_STATE.APPROVED,
      details: { rowCount: working.rows.length, supersededRevisionNo: previous ? previous.revisionNo : null },
    }));
    outbox.push(outboxRow({
      file, family, doc: working, kind: family.outbox.approved, correlationId, superseded: previous,
    }));

    await MerchandisingAuditEvent.create(audits, { session, ordered: true });
    await MerchandisingOutboxEvent.create(outbox, { session, ordered: true });

    return {
      revision: revisionView(family, working),
      supersededRevisionNo: previous ? previous.revisionNo : null,
    };
  }));
}

/* ═══ THE FROZEN CARD ══════════════════════════════════════════════════════ */

/**
 * A revision as a document somebody prints and takes to a factory.
 *
 * ── WHY THIS IS NOT JUST `getRevision` WITH A STYLESHEET ──────────────────
 * A printed card leaves the application. Nobody holding it can click into the
 * file to see which order it belongs to, whether it is still in force, or who
 * agreed to it — so the sheet has to carry that itself: the company, the file
 * number, the order, the buyer, the style, the revision number, its state and
 * its approver. A card that says only "Navy, chest, woven" is a card that
 * cannot be checked against anything.
 *
 * ── AND WHY IT SAYS WHEN IT IS NO LONGER TRUE ─────────────────────────────
 * A superseded revision is still printable, because a card that was on a
 * factory floor last month is a thing people need to read back. It is marked
 * as superseded and names what replaced it, so a sheet found on a table can
 * never be mistaken for the current instruction. `frozen` is true for anything
 * that can no longer change — approved or superseded — and a draft is
 * deliberately NOT printable: an unapproved sheet in a factory is worse than
 * no sheet.
 */
async function printableRevision(ctx, { fileId, family: familyName, revisionNo } = {}) {
  const family = familyOf(familyName);
  const file = await loadFile(ctx, fileId);
  const no = Number(revisionNo);
  if (!Number.isInteger(no) || no < 1) {
    throw fail("SELECTION_REVISION_NOT_FOUND", "That revision does not exist.");
  }
  const doc = await family.model.findOne({
    companyId: file.companyId, fileId: file._id, revisionNo: no,
  });
  if (!doc) throw fail("SELECTION_REVISION_NOT_FOUND", "That revision does not exist.");

  if (![REVISION_STATE.APPROVED, REVISION_STATE.SUPERSEDED].includes(doc.state)) {
    throw fail("SELECTION_STATE_CONFLICT",
      `Revision ${doc.revisionNo} has not been approved. Only an approved revision can be printed.`,
      { revisionNo: doc.revisionNo, state: doc.state });
  }

  const projection = file.currentExecutionProjection || {};
  const companyName = await companyNameFor(file.companyId);
  const total = await family.model.countDocuments({ companyId: file.companyId, fileId: file._id });

  return {
    documentName: family.documentName,
    family: family.key,
    /* Everything a sheet must carry to be checkable away from the screen. */
    header: {
      companyName,
      fileNumber: str(file.fileNumber),
      orderRef: str(projection.orderRef) || str(file.handoverRef),
      orderLineRef: str(file.handoverLineRef),
      buyerDisplayLabel: str(projection.buyerDisplayLabel),
      productName: str(projection.productName),
      styleRef: str(projection.styleRef),
      buyerStyleRef: str(projection.buyerStyleRef),
      totalQuantity: projection.totalQuantity ?? null,
    },
    revisionNo: doc.revisionNo,
    state: str(doc.state),
    frozen: true,
    superseded: doc.state === REVISION_STATE.SUPERSEDED,
    supersededAt: doc.supersededAt || null,
    approvedByName: str(doc.approvedBy?.name),
    approvedAt: doc.approvedAt || null,
    submittedByName: str(doc.submittedBy?.name),
    createdByName: str(doc.createdBy?.name),
    rows: (doc.rows || []).map(family.rowView || rowView),
    ...(family.hasInstructions
      ? {
        instructions: {
          foldingMethod: str(doc.instructions?.foldingMethod),
          assortmentInstruction: str(doc.instructions?.assortmentInstruction),
          ratioDescription: str(doc.instructions?.ratioDescription),
          cartonMarks: str(doc.instructions?.cartonMarks),
          additionalInstruction: str(doc.instructions?.additionalInstruction),
        },
      }
      : {}),
    /* So a reader can ask for the history without guessing the address. */
    revisionHistoryRef: { fileId: str(file._id), family: family.key, revisionCount: total },
    printedAt: new Date(),
  };
}

/** The company's own display name, for a sheet that leaves the screen. */
async function companyNameFor(companyId) {
  try {
    const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
    const row = await Acc_Company.findById(companyId).select("companyName").lean();
    return str(row?.companyName);
  } catch {
    /* A missing display name must not stop a card printing — the file number
       and the order reference already identify it unambiguously. */
    return "";
  }
}

/* ═══ WHAT THE FILE'S SUMMARY MAY SAY ══════════════════════════════════════ */

/**
 * Both families' position on one file, for the Summary tab.
 *
 * Deliberately its own read rather than a field kept up to date on the file:
 * a denormalised status is a second place for the truth to live and a first
 * place for it to go stale. It reports what the revisions actually say, and a
 * family with no revision at all says so rather than reading as complete.
 */
async function fileSelectionStatus(ctx, { fileId } = {}) {
  const file = await loadFile(ctx, fileId);
  const out = {};
  for (const family of Object.values(FAMILIES)) {
    const [approved, working] = await Promise.all([
      findApproved(family, file),
      findWorking(family, file),
    ]);
    out[family.key] = {
      family: family.key,
      label: family.label,
      documentName: family.documentName,
      approvedRevisionNo: approved ? approved.revisionNo : null,
      approvedAt: approved ? approved.approvedAt : null,
      approvedRowCount: approved ? (approved.rows || []).length : 0,
      workingRevisionNo: working ? working.revisionNo : null,
      workingState: working ? str(working.state) : null,
      /* One word for a register: what is true of this family right now. */
      status: approved
        ? (working ? "APPROVED_WITH_DRAFT" : "APPROVED")
        : (working ? str(working.state) : "NOT_STARTED"),
    };
  }
  return { fileId: str(file._id), selections: out };
}

module.exports = {
  REVISION_FAMILY, REVISION_STATE, COMPONENT_GROUP, PACKAGING_GROUP,
  FAMILIES, REFUSED_FIELDS, MATERIAL_TRIM_ROW_FIELDS, PACKAGING_ROW_FIELDS,
  INSTRUCTION_FIELDS, DEFAULT_LIMIT, MAX_LIMIT,
  familyOf, revisionView, rowView, hashRequest,
  getCurrent, getRevision, listRevisions,
  createDraft, addRow, updateRow, removeRow, updateInstructions,
  submit, requestChanges, approve,
  printableRevision, fileSelectionStatus,
};
