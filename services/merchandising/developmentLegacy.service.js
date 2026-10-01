// services/merchandising/developmentLegacy.service.js
//
// WHAT THE OLD MATERIALS FORM WROTE, BROUGHT ACROSS DELIBERATELY.
//
// Before the Development workflow existed, a merchandiser picked materials
// through a Sales-authenticated form that wrote `SampleStyle.materials`
// directly. Those selections are real work on real styles, and several of them
// are the only record of what a live sample was built from. They are not
// deleted, not rewritten, and not silently migrated.
//
// ── PREVIEW, THEN ADOPT, AND NEVER AUTOMATICALLY ────────────────────────────
// A legacy selection was made under different rules: no version, no
// maker/checker, no request behind it, and in several cases by somebody whose
// grant has since changed. Treating it as an approved Development BOM would
// launder an unreviewed record into an approved one.
//
// So adoption produces a DRAFT, with every row marked `LEGACY_STYLE_PICK` and
// carrying the moment it was observed. A merchandiser reads it, corrects what
// the buyer has since changed, and puts it through maker/checker like any
// other selection.
//
// ── AND THE LEGACY RECORD IS NEVER TOUCHED ──────────────────────────────────
// `materials.rawItems` is read. Nothing here writes it, unsets it or marks it
// migrated — the old style pages still read it, and the compatibility reads
// stay until a verified migration gate says otherwise. Adopting twice is
// harmless: already-adopted identities are skipped.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const {
  DevelopmentFile, DevelopmentBomRevision, BOM_STATE, ROW_CATEGORY,
} = require("../../models/CMS_Models/Merchandising/Development");
const {
  MerchandisingAuditEvent,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

function assertContext(ctx) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
}

/**
 * What the legacy form left on this file's style, and why each row would or
 * would not come across.
 *
 * Reads and computes; writes nothing at all. Every excluded row says WHY —
 * a migration that silently dropped rows would leave somebody comparing two
 * screens and counting.
 */
async function preview(ctx, { fileId } = {}) {
  assertContext(ctx);
  if (!isId(fileId)) throw fail("DEVELOPMENT_FILE_NOT_FOUND", "Development file not found.");
  const file = await DevelopmentFile.findOne({ _id: fileId, companyId: ctx.companyId }).lean();
  if (!file) throw fail("DEVELOPMENT_FILE_NOT_FOUND", "Development file not found.");

  if (!file.sampleStyleId) {
    return {
      available: false,
      sentence: "This development file is not attached to a sample style, so there is no legacy "
        + "selection to bring across.",
      rows: [], excluded: [],
    };
  }

  const style = await SampleStyle.findById(file.sampleStyleId)
    .select("styleCode materials").lean().catch(() => null);
  const legacy = Array.isArray(style?.materials?.rawItems) ? style.materials.rawItems : [];

  if (!legacy.length) {
    return {
      available: false,
      sentence: "The old materials form left nothing on this style. Select the materials directly.",
      rows: [], excluded: [],
    };
  }

  /* What is already in the draft — adopting twice must add nothing. */
  const draft = await DevelopmentBomRevision.findOne({
    companyId: ctx.companyId, developmentFileId: file._id, state: BOM_STATE.DRAFT,
  }).lean();
  const held = new Set((draft?.rows || []).map((r) => `${str(r.rawItemId)}::${str(r.variantId)}`));

  const rows = [];
  const excluded = [];
  for (const [i, r] of legacy.entries()) {
    const name = str(r.rawItemName) || str(r.name);
    const key = `${str(r.rawItemId)}::${str(r.variantId)}`;
    if (!str(r.rawItemId) && !name) {
      /* A row with neither a catalogue item nor a name says nothing about
         what was selected, and importing it would put a blank line into a
         record R&D reads. */
      excluded.push({ index: i, reason: "The row names neither a catalogue item nor a material." });
      continue;
    }
    if (held.has(key)) {
      excluded.push({ index: i, name, reason: "Already in this draft." });
      continue;
    }
    held.add(key);
    rows.push({
      rawItemId: str(r.rawItemId) || null,
      rawItemName: name,
      rawItemSku: str(r.rawItemSku) || str(r.sku),
      variantId: str(r.variantId) || null,
      variantCombination: Array.isArray(r.variantCombination)
        ? r.variantCombination.map(str).filter(Boolean) : [],
      /* Identity only. The legacy rows carry a quantity on some styles; it is
         not R&D's engineered consumption for this style and does not cross. */
      colourOrShade: str(r.colour) || str(r.shade),
    });
  }

  return {
    available: rows.length > 0,
    styleCode: str(style?.styleCode),
    selectedAt: style?.materials?.selectedAt || null,
    selectedByName: str(style?.materials?.selectedBy?.name),
    legacyStatus: str(style?.materials?.status),
    rows,
    excluded,
    sentence: `The old materials form recorded ${legacy.length} row(s) on `
      + `${str(style?.styleCode) || "this style"}`
      + (style?.materials?.selectedAt
        ? `, selected ${new Date(style.materials.selectedAt).toISOString().slice(0, 10)}` : "")
      + ". Adopting starts a DRAFT — it approves nothing, and the old record is left exactly as "
      + "it is.",
    note: "Nothing has been changed.",
  };
}

/**
 * Bring the legacy identities into the draft.
 *
 * Idempotent: a row already in the draft is skipped, so running it twice adds
 * nothing. Every adopted row is marked `LEGACY_STYLE_PICK` with the moment it
 * was observed, so a reader can always see which part of a selection came from
 * a record made under the old rules.
 */
async function adopt(ctx, { fileId, body = {}, actor = null } = {}) {
  const shown = await preview(ctx, { fileId });
  if (!shown.available) {
    throw fail("DEVELOPMENT_BOM_EMPTY", shown.sentence, {});
  }

  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => {
      const file = await DevelopmentFile.findOne({
        _id: fileId, companyId: ctx.companyId,
      }).session(session);
      const draft = await DevelopmentBomRevision.findOne({
        companyId: ctx.companyId, developmentFileId: file._id, state: BOM_STATE.DRAFT,
      }).session(session);
      if (!draft) {
        throw fail("DEVELOPMENT_BOM_NOT_FOUND",
          "There is no draft selection on this file. Start one before adopting.");
      }
      if (body?.expectedRevision !== undefined
        && Number(body.expectedRevision) !== Number(draft.revision ?? 0)) {
        throw fail("REVISION_CONFLICT",
          "Somebody else changed this draft while you were working. Reload and try again.",
          { expected: Number(body.expectedRevision), actual: Number(draft.revision ?? 0) });
      }

      const at = new Date();
      let added = 0;
      for (const r of shown.rows) {
        draft.rows.push({
          rowRef: `DR-${crypto.randomBytes(5).toString("hex")}`,
          /* Landed as FABRIC unless a merchandiser says otherwise: the legacy
             record does not carry Merchandising's category, and guessing one
             per row would be inventing a fact. */
          category: ROW_CATEGORY.FABRIC,
          rawItemId: isId(r.rawItemId) ? r.rawItemId : null,
          rawItemName: r.rawItemName,
          rawItemSku: r.rawItemSku,
          variantId: isId(r.variantId) ? r.variantId : null,
          variantCombination: r.variantCombination,
          colourOrShade: r.colourOrShade,
          source: {
            kind: "LEGACY_STYLE_PICK",
            reference: shown.styleCode,
            /* Both times kept: when the legacy selection was made, and when
               we read it. */
            observedAt: shown.selectedAt || at,
          },
        });
        added += 1;
      }
      draft.revision += 1;
      await draft.save({ session });

      await MerchandisingAuditEvent.create([{
        companyId: ctx.companyId,
        recordType: "DEVELOPMENT_BOM",
        recordId: draft._id,
        developmentFileId: file._id,
        developmentNumber: str(file.developmentNumber),
        action: "DEVELOPMENT_BOM_ADOPTED",
        actor: actor || undefined,
        source: "merchandising",
        at,
        correlationId: crypto.randomUUID(),
        details: {
          revisionNo: draft.revisionNo,
          adoptedCount: added,
          excludedCount: shown.excluded.length,
          legacySource: "LEGACY_STYLE_PICK",
          styleCode: shown.styleCode,
          legacySelectedAt: shown.selectedAt,
        },
      }], { session, ordered: true });

      out = {
        revisionNo: draft.revisionNo,
        adopted: added,
        excluded: shown.excluded,
        rowCount: draft.rows.length,
        note: `${added} legacy identity(ies) adopted into the draft. Nothing is approved, and the `
          + "old record on the style is untouched.",
      };
    });
    return out;
  } finally { session.endSession(); }
}

module.exports = { preview, adopt };
