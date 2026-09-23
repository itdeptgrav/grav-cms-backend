"use strict";
// services/merchandising/developmentPublication.service.js
//
// WHAT MERCHANDISING PUBLISHES ABOUT A DEVELOPMENT TO THE DEPARTMENT THAT
// ASKED FOR IT.
//
// Sales asks for a product to be developed and then has to know how it went:
// was the ask accepted, is anything unclear, has a selection been approved,
// and what was chosen. None of that is Sales' record to hold, and none of it
// is Sales' record to change.
//
// So this module is the one door. It reads Merchandising's own records and
// returns STATEMENTS — the state, the version, the words, the chosen
// materials. It returns no document identifier a caller could act on, no
// revision handle, no row reference, and there is no write in this file at
// all. A Sales screen holding one of these projections can render every
// question its user has, and can do nothing to the development file with it.
//
// ── WHY IT IS NOT A READ ON THE SALES SIDE ──────────────────────────────────
// The alternative was for the Sales service to query the Merchandising
// collections itself. That works exactly once. The second time somebody
// changes what a development file means, the change lands here and the Sales
// copy of the query keeps answering the old question — silently, because a
// stale join returns rows rather than an error. Merchandising says what it has
// done; it does not leave its meaning lying around for another department to
// reconstruct.
//
// ── AND WHY IT NEEDS NO MERCHANDISING GRANT ─────────────────────────────────
// This is a PUBLICATION. The caller has already been authorised by its own
// department for its own act — the Sales router gates on the live Sales
// grant — and what comes back is what Merchandising has chosen to say to the
// asker. Requiring a Merchandising grant on top would mean a salesperson could
// not see the answer to their own question unless somebody also gave them a
// seat in Merchandising, which is not what either department wants.
//
// Company scope is still absolute: everything below is filtered by companyId,
// and a caller with no company gets an error rather than a cross-company read.

const { fail } = require("../storePurchase/errors");
const {
  DevelopmentFile, DevelopmentBomRevision, DevelopmentRequestReceipt,
  BOM_STATE, LIFECYCLE, RECEIPT_STATE,
} = require("../../models/CMS_Models/Merchandising/Development");

const str = (v) => (v === null || v === undefined ? "" : String(v));

function assertScope(scope) {
  if (!scope?.companyId) {
    throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  }
}

/**
 * What Merchandising is doing about this line, in one sentence that names
 * WHOSE MOVE IT IS.
 *
 * Sales reads this to answer one question — "can I get on with it, or am I
 * waiting on somebody?" — so every branch names a department. None of them
 * says "in progress", which is what the reader already knows.
 */
function positionSentence(file, receipt, approved, working) {
  if (!file) return "Merchandising has not opened a development file for this line yet.";
  if (file.lifecycleStatus === LIFECYCLE.CANCELLED) {
    return "The request was cancelled, so Merchandising has stopped work on it.";
  }
  if (file.lifecycleStatus === LIFECYCLE.CLOSED) return "Merchandising has closed this development.";
  if (file.lifecycleStatus === LIFECYCLE.ON_HOLD) {
    return `Merchandising has put this development on hold${
      str(file.lifecycleReason) ? `: ${str(file.lifecycleReason)}` : "."}`;
  }
  if (!receipt || receipt.state === RECEIPT_STATE.CLARIFICATION_REQUESTED) {
    return receipt
      ? "Merchandising has asked a question about this request and is waiting on Sales."
      : "Merchandising has not answered this request yet.";
  }
  if (file.lifecycleStatus === LIFECYCLE.RELEASED_TO_RND) {
    return `Sales authorised the release. R&D is developing against approved revision ${
      approved ? approved.revisionNo : "—"}.`;
  }
  if (file.lifecycleStatus === LIFECYCLE.APPROVED && approved) {
    return `Merchandising has approved revision ${approved.revisionNo}. `
      + "It is waiting on Sales to authorise the release to R&D.";
  }
  if (working && working.state === BOM_STATE.SUBMITTED) {
    return `Merchandising has submitted revision ${working.revisionNo} for internal approval.`;
  }
  if (working) return "Merchandising is choosing the materials.";
  return "Merchandising has accepted the request and has not started a selection yet.";
}

/**
 * The approved selection, as a list a person can read.
 *
 * IDENTITY ONLY, and only from an APPROVED revision. A draft is Merchandising
 * working; publishing one would let Sales quote a fabric that nobody has
 * agreed to. There is no quantity, allowance, rate, cost or supplier in this
 * shape, because none of those has been decided at this point by anybody —
 * they are R&D's, Costing's and Supply Chain's, later.
 */
const publishedRows = (bom) => (bom?.rows || []).map((r) => ({
  category: str(r.category),
  name: str(r.rawItemName),
  reference: str(r.rawItemSku),
  colourOrShade: str(r.colourOrShade),
  finish: str(r.finish),
  placement: str(r.placement),
  appliesTo: str(r.appliesTo),
}));

/**
 * One line's development position.
 *
 * `requestRef` is here because Sales issued it and already holds it — it is
 * the address Sales cancels and authorises against. The development file's own
 * identifier is published as a NUMBER for a person to quote, never as a
 * document id: there is no Merchandising route that takes one from Sales, and
 * publishing one would only invite somebody to try.
 */
function project(file, receipt, boms) {
  const approved = boms.find((b) => b.state === BOM_STATE.APPROVED) || null;
  const working = boms.find((b) => b.state === BOM_STATE.SUBMITTED)
    || boms.find((b) => b.state === BOM_STATE.DRAFT) || null;

  return {
    developmentNumber: str(file?.developmentNumber),
    lifecycleStatus: str(file?.lifecycleStatus),
    lifecycleReason: str(file?.lifecycleReason),
    responsibleMerchandiserName: str(file?.responsibleMerchandiser?.name),

    /* The answer to the ask. PENDING is computed and never stored, so a file
       that exists with no receipt says "not answered" rather than nothing. */
    receiptState: receipt ? str(receipt.state) : (file ? "PENDING" : ""),
    clarification: receipt?.clarification?.category ? {
      category: str(receipt.clarification.category),
      reason: str(receipt.clarification.reason),
    } : null,
    answeredByName: str(receipt?.decidedBy?.name),
    answeredAt: receipt?.decidedAt || null,

    /* Where the selection has got to. Two numbers, because "revision 3 is
       being written" and "revision 2 is what is agreed" are both true and
       Sales needs to tell them apart. */
    approvedRevisionNo: approved ? approved.revisionNo : null,
    approvedByName: str(approved?.approvedBy?.name),
    approvedAt: approved?.approvedAt || null,
    workingRevisionNo: working ? working.revisionNo : null,
    workingState: working ? str(working.state) : "",

    selectedMaterials: publishedRows(approved),

    releasedToRndAt: file?.releasedToRndAt || null,
    releasedByName: str(file?.releasedBy?.name),
    releaseReference: str(file?.releaseReference),

    /* A statement about the RECORD, not about the reader: "this development is
       in a state where a release would be accepted". Whether this particular
       person may authorise it is the Sales router's question, answered against
       the live Sales grant, and this flag never stands in for that. */
    releaseAwaitingSales: Boolean(file && file.lifecycleStatus === LIFECYCLE.APPROVED),

    position: positionSentence(file, receipt, approved, working),
  };
}

/** Every product line on one Journey that Merchandising has a file for. */
async function forJourney(scope, { journeyId } = {}) {
  assertScope(scope);
  if (!str(journeyId)) return { lines: {} };

  const files = await DevelopmentFile.find({
    companyId: scope.companyId, journeyId: str(journeyId),
  }).lean();
  if (!files.length) return { lines: {} };

  const ids = files.map((f) => f._id);
  const [boms, receipts] = await Promise.all([
    DevelopmentBomRevision.find({
      companyId: scope.companyId, developmentFileId: { $in: ids },
      state: { $in: [BOM_STATE.DRAFT, BOM_STATE.SUBMITTED, BOM_STATE.APPROVED] },
    }).lean(),
    DevelopmentRequestReceipt.find({
      companyId: scope.companyId, developmentFileId: { $in: ids },
    }).sort({ createdAt: -1 }).lean(),
  ]);

  const bomsByFile = new Map();
  for (const b of boms) {
    const key = str(b.developmentFileId);
    if (!bomsByFile.has(key)) bomsByFile.set(key, []);
    bomsByFile.get(key).push(b);
  }
  /* The newest receipt per file wins — a superseded request leaves its answer
     behind, and the answer Sales needs is the one to the version it is
     looking at. */
  const receiptByFile = new Map();
  for (const r of receipts) {
    const key = str(r.developmentFileId);
    if (!receiptByFile.has(key)) receiptByFile.set(key, r);
  }

  const lines = {};
  for (const f of files) {
    lines[str(f.productLineRef)] = project(
      f, receiptByFile.get(str(f._id)) || null, bomsByFile.get(str(f._id)) || [],
    );
  }
  return { lines };
}

module.exports = { forJourney, project, publishedRows, positionSentence, assertScope };
