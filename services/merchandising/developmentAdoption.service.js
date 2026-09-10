// services/merchandising/developmentAdoption.service.js
//
// THE ORDER ADOPTS WHAT DEVELOPMENT SETTLED — DELIBERATELY, AND NEVER
// AUTOMATICALLY.
//
// When a confirmed order comes out of a development job, its Materials &
// Trims and Packaging almost always start from what was sampled. Retyping
// forty rows is how transcription errors get into a factory instruction, so
// this brings them across in one act.
//
// ── AND WHY IT DOES NOT APPROVE ─────────────────────────────────────────────
// This is the whole point of the boundary. A development selection was
// approved to be SAMPLED: it says "these are the materials we should make a
// sample from, so it can be costed and shown to the buyer". A confirmed
// order's Materials & Trims revision is an INSTRUCTION TO A FACTORY, approved
// on the strength of a commercial commitment that did not exist when the
// development selection was made.
//
// Between the two, the buyer usually changes something — a colourway, a trim,
// a label — and the quantity changes what is worth sourcing. So adoption
// produces a DRAFT that a merchandiser reviews and puts through M3's own
// maker/checker. Auto-approving would carry a sample decision into a factory
// as though somebody had checked it against the order, and nobody would have.
//
// ── AND IT NEVER TOUCHES THE DEVELOPMENT REVISION ───────────────────────────
// The approved development BOM is read. Row references are carried onto the
// order rows as LINEAGE, so "this trim came from development revision 3, row
// DR-a1b2" stays answerable — but nothing is written back, and the development
// file's own history is untouched.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const {
  DevelopmentFile, DevelopmentBomRevision, BOM_STATE, ROW_CATEGORY,
} = require("../../models/CMS_Models/Merchandising/Development");
const {
  MerchandisingAuditEvent,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

/**
 * Which M3 family each development category lands in.
 *
 * Sample packaging becomes a PACKAGING draft row and everything else becomes
 * Materials & Trims — the two families M3 already keeps, so adoption produces
 * ordinary revisions of records that already exist rather than a third kind.
 */
/**
 * Which M3 GROUP an adopted row lands in.
 *
 * The four material categories map one-to-one, because M3's material groups
 * and the development categories are the same vocabulary for the same thing.
 *
 * Sample packaging does not: a development row says "polybag 300x400" as an
 * identity and M3's packaging groups are POLYBAG, CARTON, TAG, STICKER,
 * TISSUE_OR_INSERT and OTHER. Guessing from the name would be right most of
 * the time and silently wrong the rest, so it arrives as OTHER and the
 * merchandiser classifies it in the draft — which they have to open anyway,
 * because the draft still needs approving.
 */
const GROUP_FOR = Object.freeze({
  [ROW_CATEGORY.FABRIC]: "FABRIC",
  [ROW_CATEGORY.TRIM]: "TRIM",
  [ROW_CATEGORY.LABEL]: "LABEL",
  [ROW_CATEGORY.ACCESSORY]: "ACCESSORY",
  [ROW_CATEGORY.SAMPLE_PACKAGING]: "OTHER",
});

const FAMILY_FOR = Object.freeze({
  [ROW_CATEGORY.FABRIC]: "MATERIAL_TRIM",
  [ROW_CATEGORY.TRIM]: "MATERIAL_TRIM",
  [ROW_CATEGORY.LABEL]: "MATERIAL_TRIM",
  [ROW_CATEGORY.ACCESSORY]: "MATERIAL_TRIM",
  [ROW_CATEGORY.SAMPLE_PACKAGING]: "PACKAGING",
});

function assertContext(ctx) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
}

/**
 * FINDING THE DEVELOPMENT THIS ORDER CAME FROM.
 *
 * `developmentReference` is the recorded answer and is read first. It was,
 * until this was written, the ONLY answer — the field was declared on both the
 * handover version and the execution file, `sourceFor` read it, and nothing in
 * the application ever wrote it. So every real order answered "this order did
 * not come from a development job", the whole adoption path was unreachable in
 * production, and nothing failed: a preview that is allowed to say "nothing to
 * adopt" cannot tell that apart from a broken link.
 *
 * ── WHY MERCHANDISING RESOLVES IT, AND NOT SALES ────────────────────────────
 * The obvious fix was for Sales to stamp the reference when it issues the
 * handover. Sales does know the Journey and the product line — and giving Sales
 * a Development File id would hand Sales a handle on a Merchandising record,
 * which is the one thing ADR-005 decision 2 exists to prevent. Both records
 * here are Merchandising's, so Merchandising joins its own two.
 *
 * ── AND WHY IT IS RECORDED THE FIRST TIME IT IS USED ────────────────────────
 * Resolving on every read would be a join that quietly changes its answer when
 * somebody edits a style code. So the first resolution is WRITTEN to the file,
 * and every read after it is the recorded fact. That also makes files created
 * before the development flow existed work without a backfill: the link
 * appears the first time anybody looks for it, and is fixed from then on.
 */
async function resolveDevelopmentFor(ctx, file) {
  const projection = file.currentExecutionProjection || {};
  const styleId = projection.sampleStyleId;
  const styleRef = str(projection.styleRef);

  /* The style id is the stable join. `styleRef` is a display code somebody can
     edit, so it is the fallback rather than the key. */
  const query = { companyId: ctx.companyId };
  if (isId(styleId)) query.sampleStyleId = styleId;
  else if (styleRef) query.styleRef = styleRef;
  else return null;

  const candidates = await DevelopmentFile.find(query)
    .select("developmentNumber productName styleRef").sort({ updatedAt: -1 }).lean();
  if (!candidates.length) return null;

  /* Only an APPROVED revision may be adopted, and where a development file has
     been revised the latest approved one is what the order takes. A file whose
     selection was never approved is not a source — the order selects for
     itself, which is the honest outcome. */
  for (const devFile of candidates) {
    const revision = await DevelopmentBomRevision.findOne({
      companyId: ctx.companyId, developmentFileId: devFile._id, state: BOM_STATE.APPROVED,
    }).sort({ revisionNo: -1 }).lean();
    if (revision) return { devFile, revision };
  }
  return null;
}

/** The approved development selection behind one execution file, if any. */
async function sourceFor(ctx, file) {
  const ref = file.developmentReference || {};

  if (ref.developmentFileId && ref.bomRevisionNo) {
    const [devFile, revision] = await Promise.all([
      DevelopmentFile.findOne({ _id: ref.developmentFileId, companyId: ctx.companyId })
        .select("developmentNumber productName styleRef").lean(),
      DevelopmentBomRevision.findOne({
        companyId: ctx.companyId,
        developmentFileId: ref.developmentFileId,
        revisionNo: Number(ref.bomRevisionNo),
      }).lean(),
    ]);
    if (!devFile || !revision) return null;
    return { devFile, revision };
  }

  const found = await resolveDevelopmentFor(ctx, file);
  if (!found) return null;

  /* Record it, so this is the last time it is a join. A failure to write is
     not a failure to answer: the caller still gets the source it asked for and
     the next read resolves it again. */
  await ExecutionFile.updateOne(
    { _id: file._id, companyId: ctx.companyId },
    {
      $set: {
        "developmentReference.developmentFileId": found.devFile._id,
        "developmentReference.developmentNumber": str(found.devFile.developmentNumber),
        "developmentReference.bomRevisionNo": found.revision.revisionNo,
      },
    },
  ).catch(() => {});

  return found;
}

/**
 * PREVIEW — what adoption would bring across, writing nothing.
 *
 * Idempotent and repeatable. Somebody must be able to see what would land
 * without creating a record to find out.
 */
async function preview(ctx, { fileId } = {}) {
  assertContext(ctx);
  if (!isId(fileId)) throw fail("NOT_FOUND", "Execution file not found.");
  const file = await ExecutionFile.findOne({ _id: fileId, companyId: ctx.companyId }).lean();
  if (!file) throw fail("NOT_FOUND", "Execution file not found.");

  const source = await sourceFor(ctx, file);
  if (!source) {
    return {
      available: false,
      /* Not a failure. Plenty of orders never went through development. */
      sentence: "This order did not come from a development job, so there is nothing to adopt. "
        + "Select the materials for the order directly.",
      rows: [],
    };
  }

  const { devFile, revision } = source;
  const rows = (revision.rows || []).map((r) => ({
    rowRef: str(r.rowRef),
    category: str(r.category),
    family: FAMILY_FOR[str(r.category)] || "MATERIAL_TRIM",
    rawItemId: r.rawItemId ? str(r.rawItemId) : null,
    rawItemName: str(r.rawItemName),
    rawItemSku: str(r.rawItemSku),
    variantId: r.variantId ? str(r.variantId) : null,
    colourOrShade: str(r.colourOrShade),
    finish: str(r.finish),
    placement: str(r.placement),
    appliesTo: str(r.appliesTo),
    selectionNote: str(r.selectionNote),
  }));

  return {
    available: revision.state === BOM_STATE.APPROVED || revision.state === BOM_STATE.SUPERSEDED,
    developmentNumber: str(devFile.developmentNumber),
    bomRevisionNo: revision.revisionNo,
    revisionState: str(revision.state),
    materialTrimRows: rows.filter((r) => r.family === "MATERIAL_TRIM"),
    packagingRows: rows.filter((r) => r.family === "PACKAGING"),
    rows,
    /* Said in the payload, so no client can render adoption as approval. */
    sentence: `Development ${devFile.developmentNumber} revision ${revision.revisionNo} settled `
      + `${rows.length} material identity(ies). Adopting starts DRAFT revisions for this order — `
      + "it approves nothing, because a sample selection is not a factory instruction.",
    note: "Nothing has been changed.",
  };
}

/**
 * ADOPT — start order-stage drafts from the development selection.
 *
 * Calls M3's own draft and row commands, so every guard, every audit row and
 * every immutability rule those already enforce applies here too. This service
 * writes no selection revision itself.
 */
async function adopt(ctx, { fileId, actor = null, idempotencyKey } = {}) {
  assertContext(ctx);
  const selection = require("./selection.service");
  const shown = await preview(ctx, { fileId });
  if (!shown.available) {
    throw fail("DEVELOPMENT_NOT_APPROVED", shown.sentence, {});
  }

  const file = await ExecutionFile.findOne({ _id: fileId, companyId: ctx.companyId }).lean();
  const at = new Date();
  const correlationId = crypto.randomUUID();
  const outcome = { families: [], adopted: 0, skipped: [] };

  for (const [family, rows] of [
    ["MATERIAL_TRIM", shown.materialTrimRows],
    ["PACKAGING", shown.packagingRows],
  ]) {
    if (!rows.length) continue;

    /* A family that already has a draft is left alone: adopting into
       somebody's work in progress would overwrite decisions they had already
       made about this order. */
    let draft;
    try {
      draft = await selection.createDraft(ctx, {
        fileId: str(fileId), family, body: {}, actor,
        idempotencyKey: `${str(idempotencyKey) || crypto.randomUUID()}-${family}`,
      });
    } catch (err) {
      outcome.skipped.push({ family, reason: str(err?.message) });
      continue;
    }

    let added = 0;
    let revision = draft?.revision?.revision ?? 0;
    for (const row of rows) {
      try {
        const res = await selection.addRow(ctx, {
          fileId: str(fileId), family,
          body: {
            group: GROUP_FOR[str(row.category)] || "OTHER",
            componentName: row.rawItemName || row.rawItemSku || "Adopted material",
            /* ── THE CATALOGUE ITEM, AS A REFERENCE ─────────────────────
               An M3 selection row has no `rawItemId` field and never did —
               it references the inventory catalogue through `catalogueRef`,
               which carries an identity and a source version and nothing
               operational. Sending `rawItemId` was refused by name on every
               single row, so every adoption reported success and adopted
               nothing: `families` said `revisionNo: 1`, `adopted` said 0,
               and the drafts it created were empty.

               `componentCode` carries the SKU because that is what a person
               reads on a trim card; the id is the machine's copy. */
            ...(row.rawItemSku ? { componentCode: str(row.rawItemSku).slice(0, 120) } : {}),
            ...(row.rawItemId ? {
              catalogueRef: {
                app: "inventory",
                recordType: "RAW_ITEM",
                recordId: row.rawItemId,
                recordRef: str(row.rawItemSku),
              },
            } : {}),
            ...(row.colourOrShade ? { colourOrShade: str(row.colourOrShade).slice(0, 200) } : {}),
            ...(family === "MATERIAL_TRIM" && row.finish
              ? { finish: str(row.finish).slice(0, 200) } : {}),
            ...(row.placement ? { placement: str(row.placement).slice(0, 200) } : {}),
            specification: [row.colourOrShade, row.finish, row.placement]
              .filter(Boolean).join(" · ").slice(0, 500),
            /* `notes`, plural — the field both row shapes actually declare. */
            notes: [
              row.selectionNote,
              /* ── LINEAGE ──────────────────────────────────────────────
                 Which development revision and row this came from, so the
                 order can always be traced back to what was sampled. */
              `Adopted from development ${shown.developmentNumber} revision `
              + `${shown.bomRevisionNo}, row ${row.rowRef}.`,
            ].filter(Boolean).join(" ").slice(0, 1000),
            expectedRevision: revision,
          },
          actor,
        });
        revision = res?.revision?.revision ?? revision + 1;
        added += 1;
      } catch (err) {
        outcome.skipped.push({ family, rowRef: row.rowRef, reason: str(err?.message) });
      }
    }
    outcome.families.push({ family, revisionNo: draft?.revision?.revisionNo ?? null, adopted: added });
    outcome.adopted += added;
  }

  await MerchandisingAuditEvent.create([{
    companyId: ctx.companyId,
    recordType: "EXECUTION_FILE",
    recordId: file._id,
    fileId: file._id,
    fileNumber: str(file.fileNumber),
    action: "DEVELOPMENT_BOM_ADOPTED_INTO_ORDER",
    actor: actor || undefined,
    source: "merchandising",
    at,
    correlationId,
    details: {
      developmentNumber: shown.developmentNumber,
      bomRevisionNo: shown.bomRevisionNo,
      adoptedCount: outcome.adopted,
      families: outcome.families.map((f) => f.family),
    },
  }]);

  return {
    ...outcome,
    developmentNumber: shown.developmentNumber,
    bomRevisionNo: shown.bomRevisionNo,
    /* Said again on the way out. Nothing here approved anything. */
    note: `${outcome.adopted} identity(ies) adopted into draft revisions. Nothing is approved — `
      + "review them against this order and approve on each tab.",
  };
}

module.exports = {
  resolveDevelopmentFor, GROUP_FOR, FAMILY_FOR, sourceFor, preview, adopt };
