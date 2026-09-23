// services/merchandising/packagingAdoption.service.js
//
// TAKING THE TRANSITIONAL PACKAGING WORK INTO A PERMANENT DRAFT.
//
// Before the Execution File existed, a merchandiser's packaging choices were
// recorded on the SampleStyle — `materials.packagingSelections[]`, a row per
// component with a hand-minted `rowId`, a specification and an approval
// status. That work is real and somebody did it. It is also on the wrong
// record: the SampleStyle is a SHARED R&D document with no company of its own,
// which Sales and Product Development also write, and one style can be
// executed on two order lines with different packing.
//
// So it is adopted, not migrated in place, and never the other way round.
//
// ── WHAT IS PRESERVED, AND WHAT IS DELIBERATELY NOT ─────────────────────────
// Preserved on every adopted row: the source record, the source row's own
// reference, when it was selected, and the decision state it was in. A person
// reading revision 1 six months later can see that a row came from the old
// card and that it had only been PROPOSED there.
//
// NOT preserved, because it was never Merchandising's: quantity, unit, basis,
// evidence, inclusion — the consumption fields, which live on a DIFFERENT
// array (`sample.packagingRequirements[]`) owned by Product Development. This
// service does not read that array at all, which is a stronger guarantee than
// filtering it.
//
// ── ADOPTION NEVER APPROVES ─────────────────────────────────────────────────
// Everything lands in a DRAFT. The legacy `approved` status was an approval of
// a different record under a different rule by a person who was not asked
// about this one, and carrying it across would manufacture an approval nobody
// gave. A merchandiser reviews the draft and submits it; somebody else
// approves it. That is the whole point of M3.
//
// ── AND IT NEVER HAPPENS TWICE ──────────────────────────────────────────────
// A source style adopted into a file's packaging family is recorded on the
// revision, and every legacy row already taken in is remembered by its own
// reference. Running the command again adopts nothing and says so.
//
// Nothing here deletes, edits or marks the legacy record. It is read-only at
// the source, for ever: the old screens keep working and the deep links keep
// resolving until a named retirement gate says otherwise.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const {
  REVISION_FAMILY, REVISION_STATE, PACKAGING_GROUP, DEVELOPMENT_TYPE, SOURCE_APPLICATION,
  PackagingRevision, DevelopmentRevision,
} = require("../../models/CMS_Models/Merchandising/SelectionRevision");
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const SalesHandoverVersion = require("../../models/CMS_Models/Sales/SalesHandoverVersion");
const {
  MerchandisingAuditEvent, MerchandisingCommandLedger,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

const model = (name, path) => (mongoose.models[name] || require(path));
const CustomerRequest = () => model("CustomerRequest", "../../models/Customer_Models/CustomerRequest");
const SampleStyle = () => model("SampleStyle", "../../models/CMS_Models/Sales/SampleStyle");

/**
 * The legacy statuses, restated here rather than imported.
 *
 * `services/sales/packagingBom.service.js` owns these values today, together
 * with the R&D consumption fields and the merge that produces them. Importing
 * it would put the Sales/R&D module — and its `RND_FIELDS` list — into the
 * permanent M3 dependency graph, which is exactly the coupling M3 is supposed
 * to end. Three strings are a smaller price than that, and the adoption tests
 * pin them against the source so a change there cannot pass unnoticed.
 */
const LEGACY_STATUS = Object.freeze({
  PROPOSED: "proposed",
  APPROVED: "approved",
  WITHDRAWN: "withdrawn",
});

/** Why one legacy row, or one whole source, cannot be adopted. */
const EXCLUSION = Object.freeze({
  NO_HANDOVER_VERSION: "This file has no accepted handover version to trace a style through.",
  NO_SOURCE_ORDER: "The order this file came from could not be read.",
  NO_ORDER_LINE: "The order line this file came from is no longer on the order.",
  NO_SELECTED_STYLE: "That order line names no style, so there is no transitional card to adopt.",
  NO_LEGACY_RECORD: "The style this file came from has no transitional packaging card.",
  NO_LEGACY_SELECTIONS: "The transitional card has no packaging components on it.",
  WITHDRAWN: "This component was withdrawn on the transitional card.",
  NO_COMPONENT_NAME: "This component has no name on the transitional card, so it cannot be stated truthfully.",
  ALREADY_ADOPTED: "This component has already been adopted into this file.",
});

/* ═══ THE CHAIN FROM A FILE TO ITS TRANSITIONAL CARD ═══════════════════════ */

/**
 * The SampleStyle behind an Execution File, through the records that actually
 * connect them: the accepted handover version names the CustomerRequest, the
 * order line names the style.
 *
 * Every link is proved rather than assumed, and a broken one is REPORTED
 * rather than worked around. A file whose order line has since been removed
 * has no truthful transitional card, and inventing one from the style code on
 * the projection would be matching on a display label.
 */
async function traceLegacySource(file, { select = "materials.packagingSelections" } = {}) {
  const version = await SalesHandoverVersion.findOne({
    _id: file.currentHandoverVersionId, companyId: file.companyId,
  }).select("sourceRecord handoverLineRef").lean();
  if (!version?.sourceRecord?.recordId) {
    return { blocked: "NO_HANDOVER_VERSION" };
  }

  const request = await CustomerRequest().findById(version.sourceRecord.recordId)
    .select("requestId items updatedAt").lean();
  if (!request) return { blocked: "NO_SOURCE_ORDER" };

  const line = (request.items || []).find((i) => str(i.lineRef) === str(file.handoverLineRef));
  if (!line) return { blocked: "NO_ORDER_LINE" };
  if (!isId(line.sampleStyleId)) return { blocked: "NO_SELECTED_STYLE" };

  const style = await SampleStyle().findById(line.sampleStyleId)
    .select(`sampleStyleId styleCode productName ${select} updatedAt`).lean();
  if (!style) return { blocked: "NO_LEGACY_RECORD" };

  return { request, line, style };
}

/** One legacy row, as it would land — or the reason it will not. */
function mapLegacyRow(selection, { adoptedRefs }) {
  const sourceRowId = str(selection.rowId);
  const status = str(selection.status) || LEGACY_STATUS.PROPOSED;
  const componentName = str(selection.rawItemName);

  if (status === LEGACY_STATUS.WITHDRAWN) {
    return { excluded: "WITHDRAWN", sourceRowId, componentName };
  }
  if (!componentName) {
    return { excluded: "NO_COMPONENT_NAME", sourceRowId, componentName: "" };
  }
  if (sourceRowId && adoptedRefs.has(sourceRowId)) {
    return { excluded: "ALREADY_ADOPTED", sourceRowId, componentName };
  }

  return {
    excluded: null,
    sourceRowId,
    componentName,
    row: {
      /* ── THE GROUP IS NOT GUESSED ────────────────────────────────────
         The transitional card has no component class at all — it names a
         raw item and nothing more. Reading "polybag" out of a product name
         would be inference dressed as data, and it would be wrong for every
         item somebody named differently. So everything arrives as OTHER and
         the preview says so; classifying it is a decision a person makes in
         the draft, before anybody is asked to approve it. */
      group: PACKAGING_GROUP.OTHER,
      componentName,
      componentCode: str(selection.rawItemSku),
      specification: str(selection.specification).slice(0, 2000),
      /* The legacy card knew nothing about execution units. */
      appliesToAllUnits: true,
      unitRefs: [],
      catalogueRef: {
        app: "inventory",
        recordType: "raw_item",
        ...(isId(selection.rawItemId)
          ? { recordId: new mongoose.Types.ObjectId(str(selection.rawItemId)) } : {}),
        recordRef: str(selection.rawItemSku),
      },
      sourceRef: {
        app: "merchandising",
        recordType: "sample_style_packaging_selection",
        recordRef: sourceRowId,
        sourceVersion: selection.selectedAt ? new Date(selection.selectedAt).toISOString() : "",
        sourceState: status,
      },
    },
  };
}

/** Every legacy row this file's packaging family has already taken in. */
async function adoptedRefsFor(file, session = null) {
  const q = PackagingRevision.find({ companyId: file.companyId, fileId: file._id })
    .select("rows.sourceRef.recordRef");
  const revisions = session ? await q.session(session) : await q;
  const refs = new Set();
  for (const rev of revisions) {
    for (const row of rev.rows || []) {
      const ref = str(row.sourceRef?.recordRef);
      if (ref) refs.add(ref);
    }
  }
  return refs;
}

/* ═══ THE READ-ONLY PREVIEW ════════════════════════════════════════════════ */

/**
 * What adoption would do, without doing any of it.
 *
 * The report a person reads before authorising anything: which components
 * would arrive, which would not and exactly why, and whether this source has
 * been taken in before. It writes nothing — not a draft, not a ledger row, not
 * an audit event — so it can be run as often as anybody likes.
 */
async function previewLegacyPackaging(ctx, { fileId } = {}) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  if (!isId(fileId)) throw fail("NOT_FOUND", "Execution file not found.");
  const file = await ExecutionFile.findOne({ _id: fileId, companyId: ctx.companyId });
  if (!file) throw fail("NOT_FOUND", "Execution file not found.");

  const traced = await traceLegacySource(file);
  if (traced.blocked) {
    return {
      eligible: false,
      reason: traced.blocked,
      message: EXCLUSION[traced.blocked],
      source: null,
      adoptable: [],
      excluded: [],
    };
  }

  const selections = traced.style.materials?.packagingSelections || [];
  const adoptedRefs = await adoptedRefsFor(file);
  const mapped = selections.map((sel) => mapLegacyRow(sel, { adoptedRefs }));
  const adoptable = mapped.filter((m) => !m.excluded);
  const excluded = mapped.filter((m) => m.excluded).map((m) => ({
    sourceRowId: m.sourceRowId,
    componentName: m.componentName,
    reason: m.excluded,
    message: EXCLUSION[m.excluded],
  }));

  const working = await PackagingRevision.findOne({
    companyId: file.companyId, fileId: file._id,
    state: { $in: [REVISION_STATE.DRAFT, REVISION_STATE.SUBMITTED] },
  }).select("revisionNo state").lean();

  return {
    eligible: adoptable.length > 0,
    reason: adoptable.length ? null : (selections.length ? "ALREADY_ADOPTED" : "NO_LEGACY_SELECTIONS"),
    message: adoptable.length
      ? null
      : (selections.length ? "Every component on the transitional card has already been adopted." : EXCLUSION.NO_LEGACY_SELECTIONS),
    source: {
      recordType: "sample_style_packaging_selection",
      styleRef: str(traced.style.styleCode) || str(traced.style.sampleStyleId),
      productName: str(traced.style.productName),
      orderRef: str(traced.request.requestId),
      selectionCount: selections.length,
      sourceUpdatedAt: traced.style.updatedAt || null,
    },
    /* What each would become — the group included, so nobody is surprised
       that a component arrives unclassified. */
    adoptable: adoptable.map((m) => ({
      sourceRowId: m.sourceRowId,
      componentName: m.componentName,
      componentCode: str(m.row.componentCode),
      specification: str(m.row.specification),
      group: m.row.group,
      sourceState: str(m.row.sourceRef.sourceState),
    })),
    excluded,
    /* Where the rows would go, so the answer is not a surprise either. */
    target: working
      ? { revisionNo: working.revisionNo, state: str(working.state), willCreateDraft: false }
      : { revisionNo: null, state: null, willCreateDraft: true },
    /* Said plainly, because the legacy card has approvals on it. */
    note: "Adopted components arrive in a draft. Nothing is approved by adopting it.",
  };
}

/* ═══ THE WRITE ════════════════════════════════════════════════════════════ */

/**
 * Adopt the eligible transitional components into a packaging DRAFT.
 *
 * Idempotent twice over: the command ledger replays a repeated key, and every
 * legacy row already taken in is skipped by its own reference — so a second
 * run with a fresh key still adopts nothing and reports it.
 */
async function adoptLegacyPackaging(ctx, { fileId, actor = null, idempotencyKey } = {}) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  if (!isId(fileId)) throw fail("NOT_FOUND", "Execution file not found.");
  const key = str(idempotencyKey);
  if (!key) {
    throw fail("IDEMPOTENCY_KEY_REQUIRED",
      "Send an idempotency key with this command, so a retry cannot adopt the same rows twice.",
      { field: "idempotencyKey" });
  }

  const file = await ExecutionFile.findOne({ _id: fileId, companyId: ctx.companyId });
  if (!file) throw fail("NOT_FOUND", "Execution file not found.");

  const scope = `adopt:PACKAGING:${str(file._id)}`;
  const held = await MerchandisingCommandLedger.findOne({
    companyId: ctx.companyId, scope, idempotencyKey: key,
  }).lean();
  if (held) {
    return { replayed: true, revisionNo: held.result?.revisionNo ?? null, adoptedCount: 0, note: held.result?.note || "" };
  }

  const preview = await previewLegacyPackaging(ctx, { fileId });
  if (!preview.eligible) {
    throw fail("SELECTION_ADOPTION_NOT_ELIGIBLE",
      preview.message || "There is nothing on the transitional card that can be adopted.",
      { reason: preview.reason, excluded: preview.excluded });
  }

  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => {
      const at = new Date();
      const correlationId = crypto.randomUUID();
      const batchId = `adopt-${at.toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;

      let draft = await PackagingRevision.findOne({
        companyId: file.companyId, fileId: file._id,
        state: { $in: [REVISION_STATE.DRAFT, REVISION_STATE.SUBMITTED] },
      }).session(session);

      if (draft && draft.state !== REVISION_STATE.DRAFT) {
        throw fail("SELECTION_STATE_CONFLICT",
          `Revision ${draft.revisionNo} is submitted and awaiting a decision. Ask for changes before adopting into it.`,
          { revisionNo: draft.revisionNo, state: draft.state });
      }

      const traced = await traceLegacySource(file);
      const adoptedRefs = await adoptedRefsFor(file, session);
      const mapped = (traced.style?.materials?.packagingSelections || [])
        .map((sel) => mapLegacyRow(sel, { adoptedRefs }))
        .filter((m) => !m.excluded);

      if (!mapped.length) {
        throw fail("SELECTION_ADOPTION_NOT_ELIGIBLE",
          "Every component on the transitional card has already been adopted.",
          { reason: "ALREADY_ADOPTED" });
      }

      let created = false;
      if (!draft) {
        const [highest] = await PackagingRevision
          .find({ companyId: file.companyId, fileId: file._id })
          .sort({ revisionNo: -1 }).limit(1).session(session);
        const approved = await PackagingRevision.findOne({
          companyId: file.companyId, fileId: file._id, state: REVISION_STATE.APPROVED,
        }).session(session);
        const [made] = await PackagingRevision.create([{
          companyId: file.companyId,
          fileId: file._id,
          revisionNo: (highest ? highest.revisionNo : 0) + 1,
          state: REVISION_STATE.DRAFT,
          rows: approved ? approved.rows.map((r) => ({ ...r.toObject() })) : [],
          instructions: approved ? { ...approved.instructions?.toObject?.() || approved.instructions } : {},
          clonedFromRevisionId: approved ? approved._id : null,
          createdBy: actor || undefined,
        }], { session });
        draft = made;
        created = true;
      }

      for (const m of mapped) {
        draft.rows.push({ ...m.row, rowRef: `PKG-${crypto.randomBytes(6).toString("hex")}` });
      }
      draft.adoption = {
        batchId,
        sourceRecordType: "sample_style_packaging_selection",
        sourceRecordId: traced.style._id,
        sourceUpdatedAt: traced.style.updatedAt || null,
        adoptedAt: at,
        adoptedBy: actor || undefined,
      };
      draft.revision += 1;
      draft.updatedBy = actor || undefined;
      await draft.save({ session });

      const audits = [];
      if (created) {
        audits.push(auditRow(file, draft, "SELECTION_DRAFT_CREATED", actor, at, correlationId, {
          clonedFromRevisionNo: null, rowCount: draft.rows.length,
        }));
      }
      audits.push(auditRow(file, draft, "SELECTION_LEGACY_ADOPTED", actor, at, correlationId, {
        batchId,
        adoptedCount: mapped.length,
        sourceRecordType: "sample_style_packaging_selection",
        sourceRowIds: mapped.map((m) => m.sourceRowId).filter(Boolean),
      }));
      await MerchandisingAuditEvent.create(audits, { session, ordered: true });

      out = {
        replayed: false,
        created,
        revisionNo: draft.revisionNo,
        revisionId: str(draft._id),
        adoptedCount: mapped.length,
        excluded: preview.excluded,
        batchId,
        note: "Adopted into a draft. Nothing has been approved.",
      };
    });

    try {
      await MerchandisingCommandLedger.create([{
        companyId: ctx.companyId, scope, idempotencyKey: key,
        requestHash: crypto.createHash("sha256").update(str(fileId)).digest("hex"),
        result: { revisionId: out.revisionId, revisionNo: out.revisionNo, state: REVISION_STATE.DRAFT, note: out.note },
        at: new Date(),
      }]);
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
    return out;
  } catch (err) {
    if (/Transaction numbers|replica set|transactions are not supported/i.test(str(err?.message))) {
      throw fail("MERCHANDISING_TRANSACTION_REQUIRED",
        "This deployment cannot adopt atomically. Ask an operator — the database needs a replica set.");
    }
    throw err;
  } finally {
    session.endSession();
  }
}

function auditRow(file, doc, action, actor, at, correlationId, details) {
  return {
    companyId: file.companyId,
    recordType: "SELECTION_REVISION",
    recordId: doc._id,
    recordRevision: doc.revisionNo,
    action,
    actor: actor || undefined,
    source: "merchandising",
    at,
    correlationId,
    resultingState: REVISION_STATE.DRAFT,
    details: { family: REVISION_FAMILY.PACKAGING, fileNumber: str(file.fileNumber), revisionNo: doc.revisionNo, ...details },
  };
}

/* ═══ M4 — THE TRANSITIONAL DEVELOPMENT REQUIREMENTS ═══════════════════════
 *
 * The same argument as packaging, one array over. Before the Execution File
 * existed, what development a style needed was recorded on
 * `SampleStyle.sample.serviceRequirements[]` with `purpose: DEVELOPMENT_TOOLING`
 * — Merchandising's half of an array whose other half Production owns.
 *
 * ── WHAT IS DELIBERATELY LEFT BEHIND ────────────────────────────────────────
 * `quantity`, `billingUnit`, `basis`, `owner`, `evidence`, `included` and
 * `excludedReason`. Those are costing and consumption facts: how much of the
 * thing, how it is billed, on what basis, measured how. They belong to
 * Costing and Product Development, they are read by the costing engine from
 * that array, and copying any of them here would give them two homes. What
 * crosses is the REQUIREMENT — what work is needed and what it is for.
 *
 * The legacy row also has no requirement TYPE. A charge key called
 * "pattern-development" is a costing key, not a statement that this is a fit
 * sample; mapping one to the other would be inference. Everything arrives as
 * OTHER and a person classifies it in the draft. */
const DEV_EXCLUSION = Object.freeze({
  NOT_DEVELOPMENT: "This row is not a development or tooling requirement.",
  EXCLUDED_AT_SOURCE: "This requirement was excluded on the transitional card.",
  NO_TITLE: "This requirement has no name on the transitional card, so it cannot be stated truthfully.",
  ALREADY_ADOPTED: "This requirement has already been adopted into this file.",
  NO_LEGACY_SELECTIONS: "The transitional card has no development requirements on it.",
});

const isDevelopmentRow = (r) => str(r?.purpose) === "DEVELOPMENT_TOOLING";

/** One legacy development row, as it would land — or why it will not. */
function mapLegacyDevelopmentRow(req, { adoptedRefs }) {
  const sourceRowId = str(req.rowId);
  const title = str(req.serviceName) || str(req.developmentChargeKey);

  if (!isDevelopmentRow(req)) return { excluded: "NOT_DEVELOPMENT", sourceRowId, title };
  if (req.included === false) return { excluded: "EXCLUDED_AT_SOURCE", sourceRowId, title };
  if (!title) return { excluded: "NO_TITLE", sourceRowId, title: "" };
  if (sourceRowId && adoptedRefs.has(sourceRowId)) {
    return { excluded: "ALREADY_ADOPTED", sourceRowId, title };
  }

  return {
    excluded: null,
    sourceRowId,
    title,
    row: {
      /* Not guessed from a costing key — see the header. */
      requirementType: DEVELOPMENT_TYPE.OTHER,
      requirementCode: str(req.developmentChargeKey),
      title,
      brief: str(req.specification).slice(0, 4000),
      requiredByDate: null,
      responsibleApplication: SOURCE_APPLICATION.PRODUCT_DEVELOPMENT,
      approvedReferenceExpected: true,
      coordinationNote: str(req.notes).slice(0, 2000),
      appliesToAllUnits: true,
      unitRefs: [],
      sourceRef: {
        app: "merchandising",
        recordType: "sample_style_service_requirement",
        recordRef: sourceRowId,
        sourceVersion: "",
        /* The source's own inclusion decision, preserved as a STATE. Upper
           case so it cannot be mistaken for the legacy `included` field —
           which is a costing flag and is deliberately not copied. */
        sourceState: req.included === false ? "EXCLUDED" : "INCLUDED",
      },
    },
  };
}

async function adoptedDevelopmentRefs(file, session = null) {
  const q = DevelopmentRevision.find({ companyId: file.companyId, fileId: file._id })
    .select("rows.sourceRef.recordRef");
  const revisions = session ? await q.session(session) : await q;
  const refs = new Set();
  for (const rev of revisions) {
    for (const row of rev.rows || []) {
      const ref = str(row.sourceRef?.recordRef);
      if (ref) refs.add(ref);
    }
  }
  return refs;
}

/** What adopting the transitional development card would do — and nothing else. */
async function previewLegacyDevelopment(ctx, { fileId } = {}) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  if (!isId(fileId)) throw fail("NOT_FOUND", "Execution file not found.");
  const file = await ExecutionFile.findOne({ _id: fileId, companyId: ctx.companyId });
  if (!file) throw fail("NOT_FOUND", "Execution file not found.");

  const traced = await traceLegacySource(file, { select: "sample.serviceRequirements" });
  if (traced.blocked) {
    return {
      eligible: false, reason: traced.blocked, message: EXCLUSION[traced.blocked],
      source: null, adoptable: [], excluded: [],
    };
  }

  const requirements = traced.style.sample?.serviceRequirements || [];
  const adoptedRefs = await adoptedDevelopmentRefs(file);
  const mapped = requirements.map((r) => mapLegacyDevelopmentRow(r, { adoptedRefs }));
  const adoptable = mapped.filter((m) => !m.excluded);
  const excluded = mapped.filter((m) => m.excluded).map((m) => ({
    sourceRowId: m.sourceRowId, title: m.title,
    reason: m.excluded, message: DEV_EXCLUSION[m.excluded],
  }));

  const working = await DevelopmentRevision.findOne({
    companyId: file.companyId, fileId: file._id,
    state: { $in: [REVISION_STATE.DRAFT, REVISION_STATE.SUBMITTED] },
  }).select("revisionNo state").lean();

  return {
    eligible: adoptable.length > 0,
    reason: adoptable.length ? null : (requirements.length ? "ALREADY_ADOPTED" : "NO_LEGACY_SELECTIONS"),
    message: adoptable.length ? null
      : (requirements.length
        ? "Every development requirement on the transitional card has already been adopted, or is not one."
        : DEV_EXCLUSION.NO_LEGACY_SELECTIONS),
    source: {
      recordType: "sample_style_service_requirement",
      styleRef: str(traced.style.styleCode) || str(traced.style.sampleStyleId),
      productName: str(traced.style.productName),
      orderRef: str(traced.request.requestId),
      selectionCount: requirements.length,
      sourceUpdatedAt: traced.style.updatedAt || null,
    },
    adoptable: adoptable.map((m) => ({
      sourceRowId: m.sourceRowId, title: m.title,
      requirementCode: str(m.row.requirementCode),
      brief: str(m.row.brief),
      requirementType: m.row.requirementType,
    })),
    excluded,
    target: working
      ? { revisionNo: working.revisionNo, state: str(working.state), willCreateDraft: false }
      : { revisionNo: null, state: null, willCreateDraft: true },
    note: "Adopted requirements arrive in a draft, unclassified and undated. "
      + "No quantity, basis or costing figure is copied, and nothing is approved.",
  };
}

/** Adopt the eligible transitional development requirements into a DRAFT. */
async function adoptLegacyDevelopment(ctx, { fileId, actor = null, idempotencyKey } = {}) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  if (!isId(fileId)) throw fail("NOT_FOUND", "Execution file not found.");
  const key = str(idempotencyKey);
  if (!key) {
    throw fail("IDEMPOTENCY_KEY_REQUIRED",
      "Send an idempotency key with this command, so a retry cannot adopt the same rows twice.",
      { field: "idempotencyKey" });
  }

  const file = await ExecutionFile.findOne({ _id: fileId, companyId: ctx.companyId });
  if (!file) throw fail("NOT_FOUND", "Execution file not found.");

  const scope = `adopt:DEVELOPMENT:${str(file._id)}`;
  const held = await MerchandisingCommandLedger.findOne({
    companyId: ctx.companyId, scope, idempotencyKey: key,
  }).lean();
  if (held) {
    return { replayed: true, revisionNo: held.result?.revisionNo ?? null, adoptedCount: 0, note: held.result?.note || "" };
  }

  const preview = await previewLegacyDevelopment(ctx, { fileId });
  if (!preview.eligible) {
    throw fail("SELECTION_ADOPTION_NOT_ELIGIBLE",
      preview.message || "There is nothing on the transitional card that can be adopted.",
      { reason: preview.reason, excluded: preview.excluded });
  }

  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => {
      const at = new Date();
      const correlationId = crypto.randomUUID();
      const batchId = `adopt-dev-${at.toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;

      let draft = await DevelopmentRevision.findOne({
        companyId: file.companyId, fileId: file._id,
        state: { $in: [REVISION_STATE.DRAFT, REVISION_STATE.SUBMITTED] },
      }).session(session);
      if (draft && draft.state !== REVISION_STATE.DRAFT) {
        throw fail("SELECTION_STATE_CONFLICT",
          `Revision ${draft.revisionNo} is submitted and awaiting a decision. Ask for changes before adopting into it.`,
          { revisionNo: draft.revisionNo, state: draft.state });
      }

      const traced = await traceLegacySource(file, { select: "sample.serviceRequirements" });
      const adoptedRefs = await adoptedDevelopmentRefs(file, session);
      const mapped = (traced.style?.sample?.serviceRequirements || [])
        .map((r) => mapLegacyDevelopmentRow(r, { adoptedRefs }))
        .filter((m) => !m.excluded);
      if (!mapped.length) {
        throw fail("SELECTION_ADOPTION_NOT_ELIGIBLE",
          "Every development requirement on the transitional card has already been adopted.",
          { reason: "ALREADY_ADOPTED" });
      }

      let created = false;
      if (!draft) {
        const [highest] = await DevelopmentRevision
          .find({ companyId: file.companyId, fileId: file._id })
          .sort({ revisionNo: -1 }).limit(1).session(session);
        const approved = await DevelopmentRevision.findOne({
          companyId: file.companyId, fileId: file._id, state: REVISION_STATE.APPROVED,
        }).session(session);
        const [made] = await DevelopmentRevision.create([{
          companyId: file.companyId, fileId: file._id,
          revisionNo: (highest ? highest.revisionNo : 0) + 1,
          state: REVISION_STATE.DRAFT,
          rows: approved ? approved.rows.map((r) => ({ ...r.toObject() })) : [],
          clonedFromRevisionId: approved ? approved._id : null,
          createdBy: actor || undefined,
        }], { session });
        draft = made;
        created = true;
      }

      for (const m of mapped) {
        draft.rows.push({ ...m.row, rowRef: `DEV-${crypto.randomBytes(6).toString("hex")}` });
      }
      draft.adoption = {
        batchId,
        sourceRecordType: "sample_style_service_requirement",
        sourceRecordId: traced.style._id,
        sourceUpdatedAt: traced.style.updatedAt || null,
        adoptedAt: at,
        adoptedBy: actor || undefined,
      };
      draft.revision += 1;
      draft.updatedBy = actor || undefined;
      await draft.save({ session });

      const audits = [];
      if (created) {
        audits.push(devAudit(file, draft, "SELECTION_DRAFT_CREATED", actor, at, correlationId, {
          clonedFromRevisionNo: null, rowCount: draft.rows.length,
        }));
      }
      audits.push(devAudit(file, draft, "SELECTION_LEGACY_ADOPTED", actor, at, correlationId, {
        batchId, adoptedCount: mapped.length,
        sourceRecordType: "sample_style_service_requirement",
        sourceRowIds: mapped.map((m) => m.sourceRowId).filter(Boolean),
      }));
      await MerchandisingAuditEvent.create(audits, { session, ordered: true });

      out = {
        replayed: false, created,
        revisionNo: draft.revisionNo, revisionId: str(draft._id),
        adoptedCount: mapped.length, excluded: preview.excluded, batchId,
        note: "Adopted into a draft. Nothing has been approved, and no costing figure was copied.",
      };
    });

    try {
      await MerchandisingCommandLedger.create([{
        companyId: ctx.companyId, scope, idempotencyKey: key,
        requestHash: crypto.createHash("sha256").update(str(fileId)).digest("hex"),
        result: { revisionId: out.revisionId, revisionNo: out.revisionNo, state: REVISION_STATE.DRAFT, note: out.note },
        at: new Date(),
      }]);
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
    return out;
  } catch (err) {
    if (/Transaction numbers|replica set|transactions are not supported/i.test(str(err?.message))) {
      throw fail("MERCHANDISING_TRANSACTION_REQUIRED",
        "This deployment cannot adopt atomically. Ask an operator — the database needs a replica set.");
    }
    throw err;
  } finally {
    session.endSession();
  }
}

function devAudit(file, doc, action, actor, at, correlationId, details) {
  return {
    companyId: file.companyId,
    recordType: "SELECTION_REVISION",
    recordId: doc._id,
    recordRevision: doc.revisionNo,
    action,
    actor: actor || undefined,
    source: "merchandising",
    at,
    correlationId,
    resultingState: REVISION_STATE.DRAFT,
    details: { family: REVISION_FAMILY.DEVELOPMENT, fileNumber: str(file.fileNumber), revisionNo: doc.revisionNo, ...details },
  };
}

module.exports = {
  LEGACY_STATUS, EXCLUSION, DEV_EXCLUSION,
  traceLegacySource, mapLegacyRow, mapLegacyDevelopmentRow,
  previewLegacyPackaging, adoptLegacyPackaging,
  previewLegacyDevelopment, adoptLegacyDevelopment,
};
