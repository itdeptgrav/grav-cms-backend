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

/* ── THE FAMILIES, IN WORDS ────────────────────────────────────────────────
   `MATERIAL_TRIM` is storage's name for it. A person reading why a row did not
   arrive should not have to translate. */
const FAMILY_WORD = Object.freeze({
  MATERIAL_TRIM: "Materials and trims",
  PACKAGING: "Packaging",
});

/**
 * One transaction, or an honest refusal.
 *
 * The same shape `selection.service.js` uses, and here for the same reason: a
 * command that writes a record AND the audit row describing it must not be able to
 * write one without the other. A deployment that cannot do that is told so rather
 * than quietly doing half the work.
 */
async function withTxn(fn) {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => { out = await fn(session); });
    return out;
  } catch (err) {
    if (/Transaction numbers|replica set|transactions are not supported/i.test(str(err?.message))) {
      throw fail("MERCHANDISING_TRANSACTION_REQUIRED",
        "This deployment cannot record the decision atomically. Ask an operator — the database "
        + "needs a replica set.");
    }
    throw err;
  } finally {
    session.endSession();
  }
}
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
  /* ── THE SAME RESOLUTION THE IMAGES USE, AND THE SAME REFUSAL ────────────
     This used to sort candidates by `updatedAt` and take the newest one that had
     an approved revision. Nothing enforces one Development File per style, and two
     files for one style is a legitimate state — two journey product lines, one
     style — so "newest" could import another product line's approved BOM into this
     order. Silently, with a result nobody would question.

     The style-code fallback stays HERE and only here: files created before styles
     carried a stable identity are adoptable by their display code, which is how
     this path has always worked. The ambiguity refusal applies to it too. */
  const found = await developmentFileFor(ctx, {
    projection: file.currentExecutionProjection || {},
    allowStyleRefFallback: true,
  });
  if (!found.devFile) return null;

  /* Only an APPROVED revision may be adopted, and where a development file has
     been revised the latest approved one is what the order takes. A file whose
     selection was never approved is not a source — the order selects for itself,
     which is the honest outcome. */
  const revision = await DevelopmentBomRevision.findOne({
    companyId: ctx.companyId, developmentFileId: found.devFile._id, state: BOM_STATE.APPROVED,
  }).sort({ revisionNo: -1 }).lean();
  return revision ? { devFile: found.devFile, revision } : null;
}

/** Why a lineage cannot be resolved — each one a different thing to do about it. */
const LINEAGE = Object.freeze({
  NO_STABLE_STYLE_IDENTITY: "NO_STABLE_STYLE_IDENTITY",
  NO_DEVELOPMENT_RECORD: "NO_DEVELOPMENT_RECORD",
  AMBIGUOUS: "AMBIGUOUS_DEVELOPMENT_LINEAGE",
  MISSING: "DEVELOPMENT_RECORD_MISSING",
  NO_SALES_REQUEST: "NO_SALES_REQUEST",
});

/**
 * THE EXACT KEY, WHERE SALES' OWN RECORDS CAN PRODUCE IT.
 *
 * A Development File is unique per `{companyId, journeyId, productLineRef}` — the
 * database says so. `sampleStyleId` is NOT unique across files: one style may be
 * developed on two journey product lines, which is ordinary and legitimate.
 *
 * Both halves of the exact key are Sales-owned and stable:
 *   `productLineRef`  the order line's own product-line reference
 *   `journeyId`       the SampleStyle's journey
 *
 * So Merchandising derives the key from Sales' records and looks up its own file
 * with it. Nothing about this gives Sales a handle on a Merchandising id, which is
 * the constraint that ruled out the obvious fix of letting Sales stamp the link.
 */
async function preciseKeyFor(ctx, { projection, version }) {
  const styleId = projection?.sampleStyleId;
  if (!isId(styleId)) return null;

  const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
  const style = await (SampleStyle.findById ? SampleStyle : SampleStyle())
    .findById(styleId).select("journeyId").lean();
  const journeyId = style?.journeyId;
  if (!isId(journeyId)) return null;

  /* The line's product-line reference, from the order Sales issued this version
     against. `sourceRecord.recordId` where the version is to hand — it names the
     exact CustomerRequest — otherwise the order reference it carries. */
  const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
  const model = CustomerRequest.findOne ? CustomerRequest : CustomerRequest();
  const orderId = version?.sourceRecord?.recordId;
  const order = isId(orderId)
    ? await model.findById(orderId).select("items").lean()
    : await model.findOne({ requestId: str(projection?.orderRef) }).select("items").lean();
  if (!order) return null;

  const line = (order.items || []).find((i) => str(i.lineRef) === str(projection?.orderLineRef));
  const productLineRef = str(line?.productLineRef);
  if (!productLineRef) return null;

  return { journeyId, productLineRef };
}

/**
 * WHICH DEVELOPMENT RECORD IS THIS ORDER'S — ONE ANSWER, OR AN HONEST REFUSAL.
 *
 * ── WHY NEWEST WAS THE WRONG ANSWER ─────────────────────────────────────────
 * This used to `find({ sampleStyleId })`, sort by `updatedAt` and take the first.
 * Nothing in the database enforces one Development File per style, so "newest" is
 * not authority — it is whichever file somebody happened to touch most recently.
 * Two files for one style is a legitimate state (two journey product lines, one
 * style), and picking by recency would attach one buyer's pictures, and one
 * development BOM, to the other buyer's order. Silently, and with a plausible
 * result nobody would question.
 *
 * So: the exact key first, and where that cannot be built, the style with the
 * ambiguity REFUSED rather than broken by a tiebreak.
 */
async function developmentFileFor(ctx, { projection, version = null, allowStyleRefFallback = false } = {}) {
  const SELECT = "developmentNumber productName styleRef currentRequestId releaseReference "
    + "journeyId productLineRef updatedAt";

  /* 1 · The unique key, where Sales' records can produce it. */
  const exact = await preciseKeyFor(ctx, { projection, version });
  if (exact) {
    const devFile = await DevelopmentFile.findOne({
      companyId: ctx.companyId,
      journeyId: exact.journeyId,
      productLineRef: exact.productLineRef,
    }).select(SELECT).lean();
    /* One by construction — the collection's own unique index guarantees it. */
    if (devFile) return { devFile, reason: "", key: "JOURNEY_PRODUCT_LINE" };
  }

  /* 2 · The stable style identity, with no tiebreak. */
  const styleId = projection?.sampleStyleId;
  const styleRef = str(projection?.styleRef);
  const query = { companyId: ctx.companyId };
  if (isId(styleId)) query.sampleStyleId = styleId;
  else if (allowStyleRefFallback && styleRef) query.styleRef = styleRef;
  else return { devFile: null, reason: LINEAGE.NO_STABLE_STYLE_IDENTITY };

  const candidates = await DevelopmentFile.find(query).select(SELECT).lean();
  if (!candidates.length) return { devFile: null, reason: LINEAGE.NO_DEVELOPMENT_RECORD };
  if (candidates.length > 1) {
    return {
      devFile: null,
      reason: LINEAGE.AMBIGUOUS,
      /* Named, so a person can go and look at both and say which one this order
         came from. Nothing here decides it for them. */
      candidates: candidates.map((c) => ({
        developmentFileId: str(c._id),
        developmentNumber: str(c.developmentNumber),
        productName: str(c.productName),
        styleRef: str(c.styleRef),
        productLineRef: str(c.productLineRef),
      })),
    };
  }
  return { devFile: candidates[0], reason: "", key: isId(styleId) ? "SAMPLE_STYLE" : "STYLE_REF" };
}

/**
 * Record the link once, so the next read is a fact and not a join.
 *
 * Never overwritten: a file already pointing at a Development record keeps
 * pointing at it. Re-resolving later could silently move an accepted order onto a
 * different development record, which is exactly the kind of quiet change an
 * immutable order must not make.
 */
async function recordDevelopmentFileLink(ctx, file, devFile, {
  session = null, bomRevisionNo = null,
} = {}) {
  if (!file?._id || !devFile?._id) return { recorded: false, reason: "NOTHING_TO_RECORD" };
  if (str(file.developmentReference?.developmentFileId)) {
    return { recorded: false, reason: "ALREADY_LINKED" };
  }

  const res = await ExecutionFile.updateOne(
    {
      _id: file._id, companyId: ctx.companyId,
      /* Never overwritten: a file already pointing at a Development record keeps
         pointing at it. Re-resolving later could move an accepted order onto a
         different record, which is exactly the quiet change an immutable order
         must not make. */
      $or: [
        { "developmentReference.developmentFileId": null },
        { "developmentReference.developmentFileId": { $exists: false } },
      ],
    },
    {
      $set: {
        "developmentReference.developmentFileId": devFile._id,
        "developmentReference.developmentNumber": str(devFile.developmentNumber),
        ...(Number.isFinite(Number(bomRevisionNo))
          ? { "developmentReference.bomRevisionNo": Number(bomRevisionNo) } : {}),
        ...(str(devFile.releaseReference)
          ? { "developmentReference.releaseReference": str(devFile.releaseReference) }
          : {}),
      },
    },
    session ? { session } : {},
  );
  /* ── NOT SWALLOWED ────────────────────────────────────────────────────────
     This ended in `.catch(() => {})`, on the reasoning that a failed write was
     not a failed answer because the next read would resolve it again. That
     reasoning died with the read-only change: the link is now recorded once, at
     acceptance, and a failure to record it means the file has no lineage and
     nobody was told. It throws, inside the acceptance transaction, so the
     acceptance either carries its link or does not happen. */
  if (!res.matchedCount) {
    /* Somebody linked it between the read and here. Not an error — the file has
       a link, which is the outcome this was for. */
    return { recorded: false, reason: "ALREADY_LINKED" };
  }
  return {
    recorded: true,
    developmentFileId: str(devFile._id),
    developmentNumber: str(devFile.developmentNumber),
  };
}

/**
 * THE BUYER'S PRODUCT REFERENCES, through the recorded link.
 *
 * Read from the Sales Development Request that the Development file was built
 * from — never copied into the order, so there is one editable original and every
 * screen shows the same pictures. Sales changes them in one place.
 *
 * Takes the file when there is one (an accepted order) and falls back to the
 * projection alone (a handover still being reviewed, which has no file yet).
 */
async function referenceImagesFor(ctx, { file = null, projection = null, version = null } = {}) {
  const shape = projection || file?.currentExecutionProjection || null;
  let devFileId = str(file?.developmentReference?.developmentFileId);
  let devNumber = str(file?.developmentReference?.developmentNumber);

  if (!devFileId) {
    /* ── A READ RESOLVES; IT DOES NOT RECORD ──────────────────────────────
       This used to WRITE the link it had just resolved, so opening an order — or
       refreshing it — mutated business data. Wrong twice over: a GET is not where
       a decision about an order's lineage belongs, and the write was swallowed
       with `.catch(() => {})`, so a failure to record it was invisible.

       The link is stamped AT ACCEPTANCE now, inside that transaction and audited
       with it. A file accepted before that existed is repaired by an explicit
       command — `repairDevelopmentLink` — not by somebody looking at it. */
    const found = await developmentFileFor(ctx, { projection: shape, version });
    if (!found.devFile) {
      return {
        images: [], reason: found.reason,
        ...(found.candidates ? { candidates: found.candidates } : {}),
      };
    }
    devFileId = str(found.devFile._id);
    devNumber = str(found.devFile.developmentNumber);
  }

  const devFile = await DevelopmentFile.findOne({ _id: devFileId, companyId: ctx.companyId })
    .select("currentRequestId developmentNumber").lean();
  if (!devFile) return { images: [], reason: LINEAGE.MISSING };
  if (!devFile.currentRequestId) return { images: [], reason: LINEAGE.NO_SALES_REQUEST };

  const SalesDevelopmentRequest = require("../../models/CMS_Models/Sales/DevelopmentRequest")
    .SalesDevelopmentRequest;
  const request = await SalesDevelopmentRequest.findOne({
    _id: devFile.currentRequestId, companyId: ctx.companyId,
  }).select("referenceImages requestRef versionNo").lean();
  if (!request) return { images: [], reason: LINEAGE.NO_SALES_REQUEST };

  const label = devNumber || str(devFile.developmentNumber);
  return {
    reason: "",
    source: {
      app: "sales", recordType: "development_request",
      recordId: str(request._id), recordRef: str(request.requestRef),
      sourceVersion: String(request.versionNo ?? ""),
      developmentNumber: label,
    },
    images: (request.referenceImages || [])
      .filter((image) => str(image?.url))
      .map((image) => ({
        url: str(image.url),
        caption: str(image.caption),
        referenceType: str(image.referenceType) || "PRODUCT",
        /* Attributed, because every image is somebody's. */
        source: label ? `Development file ${label}` : "Linked Development file",
      })),
  };
}

/**
 * REPAIR A FILE'S DEVELOPMENT LINK — DELIBERATELY, AND ONCE.
 *
 * Files accepted before the link was stamped at acceptance carry none. They stay
 * perfectly readable — every reader falls back to resolving the lineage for the
 * answer it needs — but nothing records it, so every read re-derives it.
 *
 * This is the command that settles them. It is a COMMAND: somebody asks for it,
 * it says what it did, and a failure to write is a failure that is reported. The
 * alternative — repairing on read — is what this replaced, and it put a decision
 * about an order's lineage inside a GET.
 *
 * Idempotent: a file that already has a link is left exactly as it is, and says so.
 * Ambiguity is refused here as everywhere — a repair that guessed would be worse
 * than the gap it filled, because nobody would know it had guessed.
 */
async function repairDevelopmentLink(ctx, { fileId, actor = null } = {}) {
  assertContext(ctx);
  if (!isId(fileId)) throw fail("NOT_FOUND", "Execution file not found.");

  /* ── RESOLVED BEFORE THE TRANSACTION, DECIDED INSIDE IT ───────────────────
     Reading which Development record this order came from is several queries and
     no writes, so it does not belong inside a transaction holding a write lock.
     What happens inside is the pair that must not come apart: the link and the
     audit row describing it. */
  const before = await ExecutionFile.findOne({ _id: fileId, companyId: ctx.companyId }).lean();
  if (!before) throw fail("NOT_FOUND", "Execution file not found.");

  const alreadyLinked = (f) => ({
    repaired: false, reason: "ALREADY_LINKED",
    developmentNumber: str(f.developmentReference?.developmentNumber),
    sentence: "This order already records the Development job it came from.",
  });
  if (str(before.developmentReference?.developmentFileId)) return alreadyLinked(before);

  const SalesHandoverVersion = require("../../models/CMS_Models/Sales/SalesHandoverVersion");
  const version = before.currentHandoverVersionId
    ? await SalesHandoverVersion.findOne({
      _id: before.currentHandoverVersionId, companyId: ctx.companyId,
    }).lean()
    : null;

  const found = await developmentFileFor(ctx, {
    projection: before.currentExecutionProjection || {}, version,
  });
  if (!found.devFile) {
    /* Neither a link nor an audit row. Nothing happened, so nothing is recorded as
       having happened — an audit trail of attempted repairs would be noise that
       buries the one entry that matters. */
    return {
      repaired: false, reason: found.reason,
      ...(found.candidates ? { candidates: found.candidates } : {}),
      sentence: found.reason === LINEAGE.AMBIGUOUS
        ? "More than one Development job matches this order's style. Nothing was linked — say "
          + "which one it came from rather than letting this choose."
        : "No Development job could be identified for this order, so there is nothing to link.",
    };
  }

  return withTxn(async (session) => {
    /* Re-read INSIDE the transaction. Between the resolution above and here
       somebody may have accepted a newer version, or another repair may have won —
       and a repair that wrote a link over one that already existed would move an
       order's lineage without a word. */
    const file = await ExecutionFile
      .findOne({ _id: fileId, companyId: ctx.companyId }).session(session).lean();
    if (!file) throw fail("NOT_FOUND", "Execution file not found.");
    if (str(file.developmentReference?.developmentFileId)) {
      /* The idempotent answer, and NO audit row: nothing was repaired, so a row
         saying it was would be a false entry in the one record somebody consults
         to find out what happened to this order. */
      return alreadyLinked(file);
    }

    const linked = await recordDevelopmentFileLink(ctx, file, found.devFile, { session });
    if (!linked.recorded) {
      return {
        repaired: false, reason: linked.reason,
        sentence: "Somebody linked this order while the repair was running. Nothing was changed.",
      };
    }

    /* ── THE AUDIT ROW IS PART OF THE REPAIR, NOT A FOLLOW-UP ───────────────
       Same session. This used to be a separate write after the update had already
       committed, so a failure here left the file linked with nothing recording who
       linked it or why — a change to an order's lineage that the trail denies ever
       happened. Now the pair commits together or neither does. */
    await MerchandisingAuditEvent.create([{
      companyId: ctx.companyId, recordType: "EXECUTION_FILE",
      recordId: file._id, recordRevision: file.revision,
      action: "FILE_UPDATED", actor: actor || undefined, source: "merchandising",
      at: new Date(), correlationId: crypto.randomUUID(),
      resultingState: str(file.lifecycleStatus),
      details: {
        change: "repaired the Development record link on a file accepted before it was stamped",
        developmentNumber: str(found.devFile.developmentNumber),
        resolvedBy: str(found.key),
      },
    }], { session, ordered: true });

    return {
      repaired: true,
      developmentFileId: str(found.devFile._id),
      developmentNumber: str(found.devFile.developmentNumber),
      resolvedBy: str(found.key),
      sentence: `Linked to Development job ${str(found.devFile.developmentNumber)}.`,
    };
  });
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

  /* ── AND THIS DOES NOT RECORD EITHER ──────────────────────────────────────
     It used to write the link here, which made `preview` — a GET — mutate the
     order it was previewing. Same defect as the image read had, same reason it is
     wrong: reading an order must not decide its lineage. The link is stamped at
     acceptance, inside that transaction. `adopt` stamps the revision it imported —
     and that is NOT one transaction: it adds the rows one at a time through the
     selection service, each in its own, and writes the stamp after them. It is
     retry-safe rather than atomic, which is a different promise and is described
     where it is made, at the end of `adopt`. */
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
/**
 * A ROW THAT DID NOT ARRIVE, DESCRIBED THE WAY A PERSON WOULD ASK ABOUT IT.
 *
 * `rowRef` alone — "DR-btn" — is the development revision's internal name for the
 * row. Putting only that on screen asks a merchandiser to go and translate it
 * before they can even tell whether the missing thing matters. The component's own
 * name and code are already crossing into the order on every row that DID arrive,
 * so naming them here discloses nothing new; what is deliberately absent is
 * anything about supplier, rate, cost or consumption, which never cross at all.
 */
function missingEntry(family, row, err) {
  return {
    family,
    familyLabel: FAMILY_WORD[family] || family,
    rowRef: str(row?.rowRef),
    /* What a person reads on a trim card, and the SKU beside it. */
    componentName: str(row?.rawItemName) || str(row?.rawItemSku) || "Unnamed selection",
    componentCode: str(row?.rawItemSku),
    reason: str(err?.message),
  };
}

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
      status: "REPLAYED",
      complete: true,
      retryable: false,
      replayed: true,
      families: [], skipped: [], missing: [],
      adopted: 0,
      /* What is THERE, which is what a replay is reporting. `adopted` is 0 because
         this call added nothing — the two used to be the same number and a reader
         could not tell an import from a replay of one. */
      present: Number(already.importedRowCount) || 0,
      intended: Number(already.importedRowCount) || 0,
      developmentNumber: shown.developmentNumber,
      bomRevisionNo: shown.bomRevisionNo,
      importedAt: already.importedAt || null,
      note: `Development ${shown.developmentNumber} revision ${shown.bomRevisionNo} `
        + "was already imported into this order. Nothing was changed.",
    };
  }
  const at = new Date();
  const correlationId = crypto.randomUUID();
  /* `intended` is every row this revision means to bring across; `present` is how
     many of them are now in the order's draft, whether this call added them or an
     earlier interrupted run did. Completeness is `present === intended`, and
     nothing else. */
  const outcome = {
    families: [], adopted: 0, present: 0, intended: 0, skipped: [], missing: [],
  };

  for (const [family, rows] of [
    ["MATERIAL_TRIM", shown.materialTrimRows],
    ["PACKAGING", shown.packagingRows],
  ]) {
    if (!rows.length) continue;

    /* ── THE DRAFT THIS FAMILY ALREADY HAS, OR A NEW ONE ──────────────────
       A retry after an interrupted import finds a draft the interrupted run
       created. Creating one refuses — correctly, one draft per family — and the
       old code caught that refusal, recorded the whole family as "skipped" and
       moved on. So the rows the first run never managed to add were never added
       by any run, and the file was stamped as imported anyway.

       So: use the open draft where there is one. Adopting into somebody's work in
       progress is still not something this does blindly — it adds only rows that
       are NOT already there, matched on the exact lineage reference it writes, so
       a row somebody edited or removed on purpose is not silently reinstated by a
       retry of a different operation. */
    let draft = null;
    let existingRefs = new Set();
    try {
      const current = await selection.getCurrent(ctx, { fileId: str(fileId), family });
      const open = current?.working && str(current.working.state) === "DRAFT" ? current.working : null;
      /* Rows already representing this revision — in the open draft, and in an
         approved revision, because a row that reached approval is certainly
         represented and must not be added a second time. */
      for (const source of [open, current?.approved]) {
        for (const r of (source?.rows || [])) {
          const ref = str(r.sourceRef?.recordRef);
          if (ref) existingRefs.add(ref);
        }
      }
      draft = open
        ? { revision: open }
        : await selection.createDraft(ctx, {
          fileId: str(fileId), family, body: {}, actor,
          idempotencyKey: `${str(idempotencyKey) || crypto.randomUUID()}-${family}`,
        });
    } catch (err) {
      /* A family that genuinely cannot take rows — a cancelled file, a submitted
         revision awaiting a decision. Recorded as missing, and the import is
         therefore INCOMPLETE rather than done. */
      for (const row of rows) outcome.missing.push(missingEntry(family, row, err));
      outcome.families.push({
        family, familyLabel: FAMILY_WORD[family] || family,
        revisionNo: null, intended: rows.length, present: 0, added: 0,
        blocked: str(err?.message),
      });
      /* Counted as intended even though none arrived — otherwise a family that
         could not take a single row would leave `present === intended` and the
         import would call itself complete, which is the whole defect. */
      outcome.intended += rows.length;
      continue;
    }

    let added = 0;
    let present = 0;
    let revision = draft?.revision?.revision ?? 0;
    for (const row of rows) {
      const recordRef = `${shown.developmentNumber} · Revision ${shown.bomRevisionNo} · ${row.rowRef}`;
      if (existingRefs.has(recordRef)) {
        /* Already imported, by an earlier run of this same import. Not added, not
           counted as an addition, and counted as PRESENT — which is what
           completeness is actually about. */
        present += 1;
        continue;
      }
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
            recordRef,
            sourceVersion: String(shown.bomRevisionNo),
            sourceState: shown.revisionState,
          },
        });
        revision = res?.revision?.revision ?? revision + 1;
        added += 1;
        present += 1;
      } catch (err) {
        /* A row that did not arrive. `skipped` is kept for the existing readers,
           and `missing` is what completeness is decided on — the old code had only
           the first, which is why a partial import could be stamped as done. */
        outcome.skipped.push({ family, rowRef: row.rowRef, reason: str(err?.message) });
        outcome.missing.push(missingEntry(family, row, err));
      }
    }
    outcome.families.push({
      family, familyLabel: FAMILY_WORD[family] || family,
      revisionNo: draft?.revision?.revisionNo ?? null,
      adopted: added, intended: rows.length, present, added,
    });
    outcome.adopted += added;
    outcome.present += present;
    outcome.intended += rows.length;
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

  /* ── AN IMPORT IS DONE WHEN EVERY ROW IS THERE, AND NOT BEFORE ───────────
     This is the correction. The stamp used to go on unconditionally, after a loop
     that caught each row's failure into `skipped` and carried on — so an import
     that lost three rows recorded `importedRevisionNo` anyway, and the next retry
     answered "already imported into this order. Nothing was changed." The three
     rows were never coming.

     Completion is now `present === intended`: every row this revision means to
     bring across is in the order's draft, whether this call added it or an earlier
     interrupted run did. Short of that, the three completion fields are NOT
     written, so a retry runs again and finishes the job.

     ── WHAT IS STAMPED EITHER WAY ─────────────────────────────────────────
     The LINEAGE — which development job and which revision this order draws on.
     That is true as soon as it has been read, it is what the images and the BOM
     both resolve through, and it is a different fact from "the rows arrived".

     ── AND THIS IS NOT ONE TRANSACTION ────────────────────────────────────
     Said plainly, because a comment here once claimed it was. The rows are added
     one at a time through the selection service, each in its own transaction, and
     the stamp is a fourth write after them. It cannot be one transaction without
     the selection service taking a session, which is a larger change than this
     correction. What makes it SAFE is not atomicity but the completion rule above
     plus the presence check per row: an interrupted run leaves the file unstamped
     and its rows individually identifiable, so a retry adds exactly what is
     missing and no row can arrive twice. */
  const complete = outcome.intended > 0 && outcome.present === outcome.intended;

  const stamped = await ExecutionFile.updateOne(
    { _id: file._id, companyId: ctx.companyId },
    {
      $set: {
        ...(str(file.developmentReference?.developmentFileId)
          ? {}
          : {
            "developmentReference.developmentFileId": shown.developmentFileId,
            "developmentReference.developmentNumber": shown.developmentNumber,
          }),
        "developmentReference.bomRevisionNo": shown.bomRevisionNo,
        ...(complete
          ? {
            "developmentReference.importedRevisionNo": shown.bomRevisionNo,
            "developmentReference.importedAt": at,
            /* The total that is THERE, not the number this call happened to add —
               a retry that added the last two rows of nine imported nine. */
            "developmentReference.importedRowCount": outcome.present,
            ...(actor ? { "developmentReference.importedBy": actor } : {}),
          }
          : {}),
      },
    },
  );
  if (!stamped.matchedCount) {
    throw fail("NOT_FOUND",
      "The execution file was not found when recording what was imported. The rows were added; "
      + "re-read the file before importing again.",
      { reason: "IMPORT_STAMP_FAILED" });
  }

  /* ── THREE OUTCOMES, TOLD APART ───────────────────────────────────────────
     A caller — and a screen — has to know which of these happened, because the
     right next step differs: nothing, retry, or review and approve. The old
     response said `replayed: false` and a count, which could not distinguish
     "finished" from "lost three rows and stopped". */
  return {
    ...outcome,
    status: complete ? "COMPLETE" : "INCOMPLETE",
    complete,
    retryable: !complete,
    replayed: false,
    developmentNumber: shown.developmentNumber,
    bomRevisionNo: shown.bomRevisionNo,
    importedAt: complete ? at : null,
    note: complete
      ? `${outcome.present} identity(ies) adopted into draft revisions. Nothing is approved — `
        + "review them against this order and approve on each tab."
      : `${outcome.present} of ${outcome.intended} identity(ies) are in this order's drafts; `
        + `${outcome.missing.length} did not arrive. The import is NOT recorded as done — run it `
        + "again and it will add only what is missing.",
  };
}

module.exports = {
  LINEAGE,
  resolveDevelopmentFor, developmentFileFor, preciseKeyFor, recordDevelopmentFileLink,
  repairDevelopmentLink,
  referenceImagesFor,
  GROUP_FOR, FAMILY_FOR, sourceFor, preview, adopt };
