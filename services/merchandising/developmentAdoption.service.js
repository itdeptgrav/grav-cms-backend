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

  /* ── AND WHERE THE ORDER HAS GOT TO WITH IT ───────────────────────────
     The screen has to answer two things at once: what development settled,
     and what this order has done with it since. Both come from here, so a
     client cannot draw one without the other and cannot compute "changed"
     from a guess. */
  const ref = file.developmentReference || {};
  const imported = ref.importedRevisionNo
    ? {
      revisionNo: Number(ref.importedRevisionNo),
      at: ref.importedAt || null,
      by: ref.importedBy?.name ? { name: str(ref.importedBy.name), email: str(ref.importedBy.email) } : null,
      rowCount: Number(ref.importedRowCount) || 0,
      /* Acceptance runs it with the accepting merchandiser as the actor. A
         backfill over an order accepted before the import existed has no
         actor at all, and says so rather than naming somebody. */
      system: !ref.importedBy?.name,
    }
    : null;

  const current = await orderState(ctx, fileId, rows);

  return {
    available: revision.state === BOM_STATE.APPROVED || revision.state === BOM_STATE.SUPERSEDED,
    developmentFileId: str(devFile._id),
    developmentNumber: str(devFile.developmentNumber),
    bomRevisionNo: revision.revisionNo,
    revisionState: str(revision.state),
    materialTrimRows: rows.filter((r) => r.family === "MATERIAL_TRIM"),
    packagingRows: rows.filter((r) => r.family === "PACKAGING"),
    rows,
    imported,
    ...current,
    /* Said in the payload, so no client can render adoption as approval. */
    sentence: `Development ${devFile.developmentNumber} revision ${revision.revisionNo} settled `
      + `${rows.length} material identity(ies). Adopting starts DRAFT revisions for this order — `
      + "it approves nothing, because a sample selection is not a factory instruction.",
    note: "Nothing has been changed.",
  };
}

/**
 * WHAT THE ORDER'S OWN SELECTION LOOKS LIKE AGAINST WHAT IT IMPORTED.
 *
 * ── THE COMPARISON IS MADE HERE, NOT IN A BROWSER ─────────────────────────
 * "Carried from development" and "Changed for this order" are claims about
 * two records, one of which is immutable. Computing them in a client would
 * mean shipping the development revision to every screen that wants a badge,
 * and two clients would drift. The development row is read live, so a badge
 * cannot go stale against a revision that never changes anyway.
 *
 * ── AND A ROW IS NEVER DROPPED FOR BEING UNRESOLVABLE ─────────────────────
 * An imported row whose catalogue item has since been deactivated keeps its
 * development reference and is marked as needing a replacement. Omitting it
 * would silently shorten a factory instruction.
 */
async function orderState(ctx, fileId, devRows) {
  const selection = require("./selection.service");
  const byDevRow = new Map(devRows.map((r) => [r.rowRef, r]));
  const families = [];
  const orderRows = [];

  for (const family of ["MATERIAL_TRIM", "PACKAGING"]) {
    let live = null;
    try {
      live = await selection.getCurrent(ctx, { fileId: str(fileId), family });
    } catch { live = null; }
    /* `working` is the draft or submitted revision somebody is editing;
       `approved` is what is in force. The order's live selection is the
       working one where it exists, because that is what a merchandiser is
       reviewing — and the approved one once there is nothing open. */
    const revision = live?.working || live?.approved || null;
    families.push({
      family,
      revisionNo: revision?.revisionNo ?? null,
      state: str(revision?.state),
      rowCount: (revision?.rows || []).length,
    });

    for (const row of revision?.rows || []) {
      const fromRef = row?.sourceRef?.recordType === "DEVELOPMENT_BOM_ROW"
        ? str(row.sourceRef.recordRef) : "";
      /* The reference ends with the development row it came from. */
      const devRowRef = fromRef ? fromRef.split("·").pop().trim() : "";
      const dev = devRowRef ? byDevRow.get(devRowRef) : null;

      orderRows.push({
        family,
        rowRef: str(row.rowRef),
        name: str(row.componentName),
        code: str(row.componentCode),
        group: str(row.group),
        colourOrShade: str(row.colourOrShade),
        finish: str(row.finish),
        /* "Used for" — the development row's own placement, carried across
           by the import and editable on the order afterwards. */
        usedFor: str(row.placement),
        catalogueRef: row.catalogueRef?.recordRef ? str(row.catalogueRef.recordRef) : "",
        developmentSource: fromRef,
        /* `changedFrom` answers with a LIST, and an empty list is truthy —
           which made every carried row read as changed. */
        status: !dev
          ? (fromRef ? "CARRIED" : "ADDED")
          : changedFrom(dev, row, family).length ? "CHANGED" : "CARRIED",
        changes: dev ? changedFrom(dev, row, family) : [],
      });
    }
  }

  /* A development row nobody carried across — removed for this order, and
     said rather than left as a gap somebody has to notice. */
  const carried = new Set(orderRows
    .map((r) => (r.developmentSource ? r.developmentSource.split("·").pop().trim() : ""))
    .filter(Boolean));
  const removed = devRows.filter((r) => !carried.has(r.rowRef)).map((r) => ({
    rowRef: r.rowRef,
    name: r.rawItemName || r.rawItemSku,
    usedFor: r.placement,
    status: "REMOVED",
  }));

  return { families, orderRows, removedFromDevelopment: removed };
}

/**
 * WHICH FIELDS THIS ORDER STATES DIFFERENTLY FROM WHAT IT IMPORTED.
 *
 * ── ONLY FIELDS THE TARGET ROW ACTUALLY HAS ────────────────────────────────
 * A packaging row has no `finish` — the field is not in its schema and the
 * import never carried one. Comparing it against a development row that did
 * state one marked every imported packaging item "changed for this order",
 * which is a claim about a decision nobody made.
 */
function changedFrom(dev, row, family) {
  const differs = [];
  const same = (a, b) => str(a).toLowerCase() === str(b).toLowerCase();
  if (!same(dev.rawItemName || dev.rawItemSku, row.componentName)) differs.push("Material");
  if (!same(dev.colourOrShade, row.colourOrShade)) differs.push("Colour");
  if (family === "MATERIAL_TRIM" && !same(dev.finish, row.finish)) differs.push("Finish");
  if (!same(dev.placement, row.placement)) differs.push("Used for");
  return differs;
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

  /* ── ONE IMPORT PER REVISION, AND THE SECOND CALL IS A NO-OP ──────────
     The import now runs on acceptance, which means it runs wherever an
     acceptance is retried: a replayed message, a double click, a backfill
     over a file that already has it. The stamp on the file is what makes
     the second run answer instead of writing. Families were already
     skipped when a draft existed, which stopped a duplicate DRAFT — it did
     not stop a second set of rows landing in somebody's open one. */
  const already = file?.developmentReference || {};
  if (Number(already.importedRevisionNo) === Number(shown.bomRevisionNo)) {
    return {
      replayed: true,
      families: [], skipped: [],
      adopted: Number(already.importedRowCount) || 0,
      developmentNumber: shown.developmentNumber,
      bomRevisionNo: shown.bomRevisionNo,
      importedAt: already.importedAt || null,
      note: `Development ${shown.developmentNumber} revision ${shown.bomRevisionNo} `
        + "was already imported into this order. Nothing was changed.",
    };
  }
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
            /* `notes`, plural — the field both row shapes actually declare.
               The development's own selection note, and nothing else: the
               lineage sentence that used to be appended here is now
               STRUCTURED, on `sourceRef` below, where a screen can render
               it as a reference and a test can assert it. */
            ...(row.selectionNote ? { notes: str(row.selectionNote).slice(0, 1000) } : {}),
            expectedRevision: revision,
          },
          actor,
          /* ── LINEAGE, AS A REFERENCE RATHER THAN AS PROSE ─────────────
             Which revision and which row this came from. Server-only — see
             `addRow` — because a row that could claim its own provenance
             could claim an approval nobody gave it. */
          sourceRef: {
            app: "merchandising",
            recordType: "DEVELOPMENT_BOM_ROW",
            recordId: shown.developmentFileId,
            recordRef: `${shown.developmentNumber} · Revision ${shown.bomRevisionNo} · ${row.rowRef}`,
            sourceVersion: String(shown.bomRevisionNo),
            sourceState: shown.revisionState,
          },
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

  /* Stamped after the rows are in, so a run that fell over halfway is
     retried rather than recorded as done. */
  await ExecutionFile.updateOne(
    { _id: file._id, companyId: ctx.companyId },
    {
      $set: {
        "developmentReference.importedRevisionNo": shown.bomRevisionNo,
        "developmentReference.importedAt": at,
        "developmentReference.importedRowCount": outcome.adopted,
        ...(actor ? { "developmentReference.importedBy": actor } : {}),
      },
    },
  ).catch(() => {});

  return {
    ...outcome,
    replayed: false,
    developmentNumber: shown.developmentNumber,
    bomRevisionNo: shown.bomRevisionNo,
    importedAt: at,
    /* Said again on the way out. Nothing here approved anything. */
    note: `${outcome.adopted} identity(ies) adopted into draft revisions. Nothing is approved — `
      + "review them against this order and approve on each tab.",
  };
}

module.exports = {
  resolveDevelopmentFor, GROUP_FOR, FAMILY_FOR, sourceFor, preview, adopt };
