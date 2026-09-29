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
// materials. There is no write in this file at all, and no row reference or
// editing handle leaves it. A Sales screen holding one of these projections
// can render every question its user has, and can do nothing to the
// development file with it.
//
// ── THE ONE IDENTIFIER THAT DOES LEAVE, AND WHY ─────────────────────────────
// `resolveReleaseBinding` at the foot of this file returns the development
// file's id. That is a deliberate narrowing of the rule above, not an
// oversight. Sales' release has to name the exact approved revision it
// authorised — `{companyId, developmentFileId, revisionNo}` is the only
// identity that says so without ambiguity, and a release recorded against a
// journey and a line alone silently re-points itself the moment Merchandising
// approves a newer revision. The id is recorded, never acted on: there is
// still no Merchandising route that accepts one from Sales.
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
  /* ── WHY THIS ONE ──────────────────────────────────────────────────
     The merchandiser's own sentence about the choice — "the buyer asked for
     the heavier weight", "closest match to the approved lab dip". Sales is
     being asked to approve this selection against a customer requirement,
     and the reason it was chosen is the part of it that answers that
     question. It is Merchandising's text about Merchandising's decision, so
     it crosses with the rest of the identity. */
  selectionNote: str(r.selectionNote),
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
/**
 * IS THE RELEASE STILL THE ANSWER?
 *
 * Derived, every time, from two numbers on the same file document: the
 * revision Sales released, and the revision Merchandising currently has
 * approved. Nothing stores "stale".
 *
 * That is deliberate. A stored flag needs a writer on every approval, every
 * reopen and every supersession, and the first one anybody forgets leaves a
 * superseded selection reading as current — which is the exact failure this
 * whole chunk exists to prevent. Two numbers cannot drift from each other.
 *
 * Both numbers come from ONE file, so there is no cross-file or cross-company
 * comparison to get wrong: a revision number from another company's file is
 * not reachable from here, because it is never read from here.
 *
 *   NOT_RELEASED  Sales has not released anything yet. The ordinary review
 *                 gates apply and nothing downstream is authorised by a
 *                 release, because there is none.
 *   CURRENT       The released revision is still the approved one. A DRAFT
 *                 may well be open — somebody is working on a successor — and
 *                 that does not make the release stale. Only an APPROVED
 *                 successor does, because only that replaces what R&D reads.
 *   STALE         Merchandising has approved a revision newer than the one
 *                 Sales released. The release stays on the record as the
 *                 decision it was; it just no longer describes the selection
 *                 in force, so it cannot authorise anything new.
 */
function materialApprovalOf(file, approved) {
  const released = Number(file?.releasedBomRevisionNo);
  const current = Number(approved?.revisionNo ?? file?.currentBomRevisionNo);

  if (!Number.isInteger(released) || released < 1) {
    return {
      state: "NOT_RELEASED",
      releasedRevisionNo: null,
      currentRevisionNo: Number.isInteger(current) ? current : null,
      stale: false,
    };
  }
  const stale = Number.isInteger(current) && current !== released;
  return {
    state: stale ? "STALE" : "CURRENT",
    releasedRevisionNo: released,
    currentRevisionNo: Number.isInteger(current) ? current : null,
    stale,
  };
}

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
    /* ── WHO STOOD BEHIND IT, INSIDE MERCHANDISING ────────────────────
       Sales is approving somebody else's technical work against a customer
       requirement. "Prepared by X, submitted by Y, approved by Z" is what
       makes that a review of a named department's decision rather than a
       button on an anonymous list — and it shows Sales that Merchandising's
       own maker/checker has already run. Names and dates only: no actor id,
       nothing to act on. */
    preparedByName: str(approved?.createdBy?.name),
    submittedByName: str(approved?.submittedBy?.name),
    submittedAt: approved?.submittedAt || null,
    approvedRevisionClonedFrom: approved?.clonedFromRevisionNo ?? null,
    workingRevisionNo: working ? working.revisionNo : null,
    workingState: working ? str(working.state) : "",
    /* The reason attached to the revision being worked on, whoever asked for
       it. Merchandising's own returns already set it; a Sales request for
       changes sets it too, and `workingChangeRequestedByName` is what tells
       the two apart on screen. */
    workingChangeReason: str(working?.changeReason),
    workingChangeRequestedByName: str(working?.changesRequestedBy?.name),
    workingChangeRequestedAt: working?.changesRequestedAt || null,
    workingChangeRequestedSource: str(working?.changesRequestedSource) || null,

    selectedMaterials: publishedRows(approved),

    releasedToRndAt: file?.releasedToRndAt || null,
    releasedByName: str(file?.releasedBy?.name),
    releaseReference: str(file?.releaseReference),
    /* What Sales actually released, which is NOT the same fact as what is
       approved now. Published beside the approved revision rather than
       instead of it, because the screen has to show both to say anything
       useful about either. */
    releasedBomRevisionNo: file?.releasedBomRevisionNo ?? null,
    materialApproval: materialApprovalOf(file, approved),

    /* A statement about the RECORD, not about the reader: "this development is
       in a state where a release would be accepted". Whether this particular
       person may authorise it is the Sales router's question, answered against
       the live Sales grant, and this flag never stands in for that. */
    releaseAwaitingSales: Boolean(file && file.lifecycleStatus === LIFECYCLE.APPROVED),
    /* A release that has been overtaken. The screen must not offer this as a
       finished state, and must not offer the older release as current. */
    materialApprovalOutOfDate: materialApprovalOf(file, approved).stale,

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

/* ═══ THE RELEASE BINDING ══════════════════════════════════════════════════

   Still a read — there is no write in this file — but a narrower question
   than `project()` asks. `project()` describes; this one answers "is this line
   releasable right now, and is the revision Sales has been reading still the
   approved one?", and it answers it at the moment of the click rather than at
   the moment of the page load.

   It is the only thing here that returns a document id, and it returns it for
   exactly one purpose: so that the release Sales records can name the revision
   it bound, permanently and unambiguously. It is not a handle Sales can act
   with — there is still no Merchandising route that accepts one — and the rest
   of this module's rule is unchanged. */

/**
 * RESOLVE AND VERIFY WHAT A SALES RELEASE WOULD BIND.
 *
 * `expectedBomRevisionNo` arrives from a browser and is treated as an
 * ASSERTION, never as an instruction: nothing is ever looked up by it. The
 * file is found from the company and from the journey and product line the
 * authorised request already carries, and the number is only compared against
 * what Merchandising's own records say. A caller who sends a revision
 * belonging to someone else's file therefore does not reach it — they are
 * refused against their own.
 *
 * @returns {{developmentFileId: string, bomRevisionNo: number,
 *            developmentNumber: string}}
 */
async function resolveReleaseBinding(scope, {
  journeyId, productLineRef, expectedBomRevisionNo,
} = {}) {
  assertScope(scope);

  /* Sent as a number or not at all. An absent assertion cannot be waved
     through: releasing without naming a revision is the behaviour this whole
     binding exists to end. */
  const expected = Number(expectedBomRevisionNo);
  if (!Number.isInteger(expected) || expected < 1) {
    throw fail("DEVELOPMENT_BOM_REVISION_REQUIRED",
      "A release has to name the approved revision it is releasing. Reload the development panel and try again.",
      { expectedBomRevisionNo: expectedBomRevisionNo ?? null });
  }

  const file = await DevelopmentFile.findOne({
    companyId: scope.companyId,
    journeyId: str(journeyId),
    productLineRef: str(productLineRef),
  }).select("_id companyId developmentNumber lifecycleStatus currentBomRevisionNo").lean();
  if (!file) {
    throw fail("DEVELOPMENT_FILE_NOT_FOUND",
      "Merchandising has no development file for this product line.");
  }

  /* The same state `project()` publishes as `releaseAwaitingSales`, asked of
     the record rather than of a projection the browser may have been holding
     for a while. A file already RELEASED_TO_RND lands here too, which is the
     honest answer: there is nothing left for Sales to authorise. */
  if (str(file.lifecycleStatus) !== LIFECYCLE.APPROVED) {
    throw fail("DEVELOPMENT_NOT_AWAITING_SALES",
      `${file.developmentNumber} is ${str(file.lifecycleStatus).toLowerCase().replace(/_/g, " ")}, `
      + "so it is not waiting for a Sales release.",
      { developmentNumber: str(file.developmentNumber), lifecycleStatus: str(file.lifecycleStatus) });
  }

  /* ── A MISSING APPROVED REVISION IS A READINESS ANSWER ─────────────────
     Not an exception. An APPROVED file with no approved revision behind it is
     a record inconsistency, and the person clicking the button needs to be
     told what is missing rather than handed a 500. Both halves are checked:
     the file's pointer, and a revision actually in that state. */
  const approved = file.currentBomRevisionNo
    ? await DevelopmentBomRevision.findOne({
      companyId: file.companyId,
      developmentFileId: file._id,
      revisionNo: file.currentBomRevisionNo,
      state: BOM_STATE.APPROVED,
    }).select("revisionNo").lean()
    : null;
  if (!approved) {
    throw fail("DEVELOPMENT_NOT_APPROVED",
      `${file.developmentNumber} has no approved material revision to release. `
      + "Merchandising has to approve the selection first.",
      { developmentNumber: str(file.developmentNumber) });
  }

  /* ── THE ONE COMPARISON THE WHOLE BINDING RESTS ON ─────────────────────
     Sales read revision N and decided about revision N. If Merchandising has
     approved a newer one since the panel loaded, the decision in front of us
     answers a question nobody asked — so nothing is released and the reader is
     sent back to look at what is actually approved now. */
  if (approved.revisionNo !== expected) {
    throw fail("DEVELOPMENT_BOM_REVISION_CHANGED",
      `Merchandising approved revision ${approved.revisionNo} while you were reading revision ${expected}. `
      + "Nothing was released — reload and review the current selection.",
      {
        developmentNumber: str(file.developmentNumber),
        expectedBomRevisionNo: expected,
        currentBomRevisionNo: approved.revisionNo,
      });
  }

  return {
    developmentFileId: str(file._id),
    bomRevisionNo: approved.revisionNo,
    developmentNumber: str(file.developmentNumber),
  };
}

/**
 * RESOLVE WHAT A POST-RELEASE REOPEN WOULD BIND.
 *
 * `resolveReleaseBinding` answers "may Sales decide about this?" and requires
 * the file to be waiting for that decision. This answers a different
 * question — "may Sales take back a decision they already made?" — and so it
 * requires the opposite state: the file must be RELEASED_TO_RND, and the
 * revision named must be the one actually released.
 *
 * It exists because the materials at that point are not Merchandising's own
 * business any more. R&D is building against them and the customer's approval
 * rests on them, so reopening is a commercial decision with downstream cost.
 * Merchandising's own route is refused (`assertNotReleased`); this is the way
 * through, and it is Sales'.
 *
 * Nothing is looked up by the caller's number here either — it is compared
 * against what the FILE says it released.
 */
async function resolveReopenBinding(scope, {
  journeyId, productLineRef, expectedBomRevisionNo,
} = {}) {
  assertScope(scope);

  const expected = Number(expectedBomRevisionNo);
  if (!Number.isInteger(expected) || expected < 1) {
    throw fail("DEVELOPMENT_BOM_REVISION_REQUIRED",
      "Say which released revision is being reopened. Reload the development panel and try again.",
      { expectedBomRevisionNo: expectedBomRevisionNo ?? null });
  }

  const file = await DevelopmentFile.findOne({
    companyId: scope.companyId,
    journeyId: str(journeyId),
    productLineRef: str(productLineRef),
  }).select("_id companyId developmentNumber lifecycleStatus currentBomRevisionNo releasedBomRevisionNo")
    .lean();
  if (!file) {
    throw fail("DEVELOPMENT_FILE_NOT_FOUND",
      "Merchandising has no development file for this product line.");
  }

  if (str(file.lifecycleStatus) !== LIFECYCLE.RELEASED_TO_RND) {
    /* Not released, so there is nothing to take back — the ordinary review
       decision applies instead, and says so. */
    throw fail("DEVELOPMENT_NOT_RELEASED",
      `${file.developmentNumber} has not been released to R&D, so there is nothing to reopen. `
      + "Use the ordinary review decision on the approved revision.",
      { developmentNumber: str(file.developmentNumber), lifecycleStatus: str(file.lifecycleStatus) });
  }

  const releasedNo = Number(file.releasedBomRevisionNo);
  if (!Number.isInteger(releasedNo) || releasedNo < 1) {
    throw fail("DEVELOPMENT_NOT_APPROVED",
      `${file.developmentNumber} is released but does not record which revision was released, `
      + "so it cannot be reopened against one.",
      { developmentNumber: str(file.developmentNumber) });
  }
  if (releasedNo !== expected) {
    throw fail("DEVELOPMENT_BOM_REVISION_CHANGED",
      `Revision ${releasedNo} is the one released to R&D, not revision ${expected}. `
      + "Nothing was reopened — reload and try again.",
      {
        developmentNumber: str(file.developmentNumber),
        expectedBomRevisionNo: expected,
        currentBomRevisionNo: releasedNo,
      });
  }

  /* The released revision must still be the approved one. If it is not, a
     successor has already been approved and the line is STALE rather than
     released-and-settled — that is the review decision's business, not this
     one's. */
  const approved = await DevelopmentBomRevision.findOne({
    companyId: file.companyId,
    developmentFileId: file._id,
    revisionNo: releasedNo,
    state: BOM_STATE.APPROVED,
  }).select("revisionNo").lean();
  if (!approved) {
    throw fail("DEVELOPMENT_BOM_REVISION_CHANGED",
      `Revision ${releasedNo} is no longer the approved selection on ${file.developmentNumber}. `
      + "Reload — a newer revision is waiting for your review.",
      {
        developmentNumber: str(file.developmentNumber),
        expectedBomRevisionNo: expected,
        currentBomRevisionNo: file.currentBomRevisionNo ?? null,
      });
  }

  return {
    developmentFileId: str(file._id),
    bomRevisionNo: releasedNo,
    developmentNumber: str(file.developmentNumber),
  };
}

module.exports = {
  forJourney, project, publishedRows, positionSentence, assertScope,
  resolveReleaseBinding, resolveReopenBinding, materialApprovalOf,
};
