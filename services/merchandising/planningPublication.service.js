// services/merchandising/planningPublication.service.js
//
// WHAT MERCHANDISING PUBLISHES TO A PLANNING DEPARTMENT, AND NOTHING ELSE.
//
// ── WHY THIS FILE, AND WHY IT LIVES HERE ────────────────────────────────────
// PPC needs to know which confirmed order lines exist, which Execution Pack is
// current, which Pre-Production Meeting minutes were issued, and what other
// departments have said about the order. All four facts are Merchandising's to
// state, so the contract that states them belongs in Merchandising's namespace
// — not in `services/ppc/`, where it would be PPC deciding what Merchandising
// means, and not as a query PPC writes against `execution_files` directly.
//
// The difference is not stylistic. A reader that queries another
// application's collections is coupled to its SCHEMA: a renamed path, a new
// lifecycle value or an added sub-document silently changes what the reader
// believes, and nothing fails until a screen shows the wrong thing. A reader
// that calls a published method is coupled to its CONTRACT, and the contract
// is a file somebody owns, with a test.
//
// ── IDENTITY AND STATE ONLY ─────────────────────────────────────────────────
// Every method here returns references, versions, states and the handful of
// display labels a register has to print. None returns a pack's CONTENTS, a
// file's draft, a selection, a milestone, a merchandiser's assignment history
// or a Merchandising audit trail. A planning department needs to know THAT a
// pack was accepted at version 4, not what is inside it.
//
// ── AND NO COMMERCIAL DATA CAN CROSS ────────────────────────────────────────
// The order-line projection published below is built from
// `currentExecutionProjection`, whose schema — `models/Sales/executionProjection.js`
// — has no field that could hold a price, cost, margin, quotation, payment
// term or currency amount. So this contract cannot leak one even by mistake,
// and a test asserts the published shape against that claim rather than
// trusting this comment.
//
// ── WHAT THIS FILE DELIBERATELY DOES NOT DO ─────────────────────────────────
// It does not decide readiness. It reports states; whether a given combination
// means a department may begin planning is that department's rule, kept in that
// department's code. Merchandising publishing "ACCEPTED" is not Merchandising
// telling PPC it may plan.
"use strict";

const mongoose = require("mongoose");

const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const { ExecutionPack, PACK_STATE } = require("../../models/CMS_Models/Merchandising/ExecutionPack");
const {
  PreProductionMeeting, PPM_STATE,
} = require("../../models/CMS_Models/Merchandising/PreProductionMeeting");
const {
  DepartmentStatusProjection,
} = require("../../models/CMS_Models/Merchandising/DepartmentStatusProjection");
const { AVAILABILITY } = require("./departmentStatus.contract");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));
const oid = (v) => new mongoose.Types.ObjectId(str(v));

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * The snapshot contract version from which a meeting records WHICH engineering
 * release was reviewed, by record id.
 *
 * At or above it, an absent reviewed release is a positive statement: the
 * meeting looked and there was none. Below it — including the null that means
 * "issued before the contract was versioned" — an absence says only that this
 * record was never able to carry the answer.
 *
 * It is a number the capture side stamps (`preProductionMeeting.service`'s
 * `SOURCES_CONTRACT_VERSION`) and this side reads. Deliberately not imported
 * from there: this is the threshold at which a READER changes its mind, and it
 * must keep meaning what it means here even if the capture side moves on.
 */
const RELEASE_IDENTITY_CONTRACT = 2;

function assertContext(ctx) {
  if (!ctx?.companyId) {
    throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  }
}

/**
 * The lifecycle values that mean "this order line is real and confirmed".
 *
 * An Execution File exists only as the consequence of accepting a versioned
 * Sales confirmation, so its mere existence is the confirmation. CANCELLED is
 * excluded because Sales withdrew the commitment; the others all describe a
 * live order, including ON_HOLD — a held order is still an order, and a
 * planning department that could not see it would be planning around a gap.
 */
const CONFIRMED_LIFECYCLE = Object.freeze(["OPEN", "ON_HOLD", "CLOSED", "HANDED_OVER"]);

/* ══ 1. THE CONFIRMED ORDER LINES ═════════════════════════════════════════ */

/**
 * One published order line — the identity a planning department joins on, plus
 * the few facts a register has to print.
 *
 * `orderLineRef` is the PERMANENT line reference: the Sales handover line ref,
 * which is the CustomerRequest item's own `lineRef`. It is not the style, not
 * the product name and not a position in an array — a style may legitimately
 * appear on two commercial lines of one order, and two lines may carry the
 * same colourway name. Anything that joins on a name will silently merge them.
 */
function publishedLine(file) {
  const p = file.currentExecutionProjection || {};
  const deliveries = Array.isArray(p.deliveries) ? p.deliveries : [];

  /* The earliest committed date is the one a register sorts and warns on. The
     whole set travels too, because a line with three drops has three dates and
     collapsing them into one would be Merchandising deciding which matters. */
  const dates = deliveries
    .map((d) => (d.committedDeliveryDate ? new Date(d.committedDeliveryDate) : null))
    .filter((d) => d && !Number.isNaN(d.getTime()))
    .sort((a, b) => a - b);

  /* A nominated factory is a Sales/Merchandising fact where it exists, and
     absent otherwise. Never guessed, and never defaulted to a first option. */
  const nominated = [...new Set(deliveries
    .map((d) => str(d.nominatedFactoryRef))
    .filter(Boolean))];

  return {
    companyId: String(file.companyId),

    /* ── THE PERMANENT IDENTITY ──────────────────────────────────────── */
    orderRef: str(p.orderRef) || str(file.handoverRef),
    orderLineRef: str(file.handoverLineRef),
    handoverRef: str(file.handoverRef),

    /* Merchandising's own coordination record for this line. */
    executionFileId: String(file._id),
    executionFileRef: str(file.fileNumber),
    executionFileLifecycle: str(file.lifecycleStatus),
    executionPhase: str(file.executionPhase),

    /* ── STYLE IDENTITY ──────────────────────────────────────────────── */
    styleRef: str(p.styleRef),
    buyerStyleRef: str(p.buyerStyleRef),
    productName: str(p.productName),
    /* The record, not the display code — a renamed style code must not break a
       downstream join. Null on handover versions issued before it existed. */
    sampleStyleId: p.sampleStyleId ? String(p.sampleStyleId) : null,

    /* ── DISPLAY LABELS ──────────────────────────────────────────────── */
    buyerDisplayLabel: str(p.buyerDisplayLabel),
    brandDisplayLabel: str(p.brandDisplayLabel),

    /* ── THE CONFIRMED COMMITMENT ────────────────────────────────────── */
    confirmedQuantity: Number.isFinite(p.totalQuantity) ? p.totalQuantity : null,
    earliestDeliveryDate: dates.length ? dates[0].toISOString() : null,
    deliveryDates: dates.map((d) => d.toISOString()),
    deliveryCount: deliveries.length,
    nominatedFactoryRefs: nominated,
    /* The file's own factory field, where Merchandising recorded one. */
    factoryRef: str(file.factoryRef),

    /* ── THE COLOURWAYS, BY THEIR OWN SPLIT REFERENCES ───────────────── */
    colourways: (Array.isArray(p.breakdown) ? p.breakdown : []).map((b) => ({
      lineSplitRef: str(b.lineSplitRef),
      sizeRange: str(b.sizeRange),
      quantity: Number.isFinite(b.quantity) ? b.quantity : null,
      attributes: (Array.isArray(b.attributes) ? b.attributes : [])
        .map((a) => ({ name: str(a.name), value: str(a.value) })),
    })),

    /* Requirements a planner reads as constraints. Text Sales wrote, copied. */
    packingRequirement: str(p.packingRequirement),
    testingRequirement: str(p.testingRequirement),
    deliveryRequirement: str(p.deliveryRequirement),

    /* What Merchandising's own downstream handover says, for context. */
    currentPackVersionNo: Number.isFinite(file.currentPackVersionNo)
      ? file.currentPackVersionNo : null,
    sourceUpdatedAt: file.updatedAt ? new Date(file.updatedAt).toISOString() : null,
  };
}

/**
 * Every confirmed order line in one company, newest first, cursor-paginated.
 *
 * Cancelled orders are excluded and archived files are excluded; nothing else
 * is. A line with no pack, no minutes and no engineering release is still a
 * confirmed order line and still published — deciding what to do about its
 * missing inputs is the reader's job, and a contract that hid incomplete rows
 * would make "nothing is waiting" indistinguishable from "nothing is ready".
 */
async function publishConfirmedOrderLines(ctx, {
  cursor = "", limit = DEFAULT_LIMIT, search = "", executionFileIds = null,
} = {}) {
  assertContext(ctx);
  const size = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  const query = {
    companyId: oid(ctx.companyId),
    lifecycleStatus: { $in: CONFIRMED_LIFECYCLE },
    archived: { $ne: true },
  };

  if (Array.isArray(executionFileIds)) {
    const ids = executionFileIds.filter(isId).map(oid);
    if (!ids.length) return { lines: [], nextCursor: null, hasMore: false };
    query._id = { $in: ids };
  }

  const term = str(search);
  if (term) {
    /* Escaped, because a register's search box is user input and a `(` must
       search for a bracket rather than open a group. */
    const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    query.$or = [
      { fileNumber: rx },
      { handoverRef: rx },
      { handoverLineRef: rx },
      { "currentExecutionProjection.orderRef": rx },
      { "currentExecutionProjection.styleRef": rx },
      { "currentExecutionProjection.productName": rx },
      { "currentExecutionProjection.buyerDisplayLabel": rx },
    ];
  }

  /* Keyset pagination on `_id`, which is monotonic and unique — an offset
     would skip or repeat a row whenever a file is created mid-read. */
  if (cursor) {
    if (!isId(cursor)) throw fail("PPC_ORDER_BOOK_CURSOR_INVALID", "That page marker is not readable.");
    query._id = { ...(query._id || {}), $lt: oid(cursor) };
  }

  const docs = await ExecutionFile.find(query)
    .sort({ _id: -1 })
    .limit(size + 1)
    .lean();

  const hasMore = docs.length > size;
  const page = hasMore ? docs.slice(0, size) : docs;
  return {
    lines: page.map(publishedLine),
    nextCursor: hasMore ? String(page[page.length - 1]._id) : null,
    hasMore,
  };
}

/** One line by its permanent identity. Null when this company has no such line. */
async function publishConfirmedOrderLine(ctx, { orderLineRef, executionFileId } = {}) {
  assertContext(ctx);
  const query = { companyId: oid(ctx.companyId), archived: { $ne: true } };
  if (executionFileId) {
    if (!isId(executionFileId)) return null;
    query._id = oid(executionFileId);
  } else {
    const ref = str(orderLineRef);
    if (!ref) return null;
    query.handoverLineRef = ref;
  }
  const doc = await ExecutionFile.findOne(query).lean();
  if (!doc) return null;
  if (!CONFIRMED_LIFECYCLE.includes(str(doc.lifecycleStatus))) return null;
  return publishedLine(doc);
}

/* ══ 2. THE CURRENT EXECUTION PACK ════════════════════════════════════════ */

/**
 * The CURRENT pack for each file — the highest version that is not a draft.
 *
 * A draft is Merchandising's workspace and is never published: a planning
 * department reading a draft would be reading an intention as though it were a
 * statement. Everything from SUBMITTED onward is a statement, including the
 * ones that went wrong (withdrawn, superseded), because a reader has to be
 * able to tell "no pack was ever sent" from "the pack that was sent has been
 * withdrawn", and those are different facts about the same order.
 */
async function publishCurrentExecutionPacks(ctx, executionFileIds = []) {
  assertContext(ctx);
  const ids = (executionFileIds || []).filter(isId).map(oid);
  if (!ids.length) return new Map();

  const docs = await ExecutionPack.find({
    companyId: oid(ctx.companyId),
    fileId: { $in: ids },
    state: { $ne: PACK_STATE.DRAFT },
  })
    .sort({ fileId: 1, packVersionNo: -1 })
    .lean();

  const byFile = new Map();
  for (const d of docs) {
    const key = String(d.fileId);
    if (byFile.has(key)) continue;          // the first is the highest version
    byFile.set(key, {
      packId: String(d._id),
      executionFileId: key,
      packVersionNo: d.packVersionNo,
      state: str(d.state),
      submittedAt: d.submittedAt ? new Date(d.submittedAt).toISOString() : null,
      supersedesPackVersionNo: d.supersedesPackVersionNo ?? null,
      supersededByPackVersionNo: d.supersededByPackVersionNo ?? null,
      /* Whether the pack's own gates all passed — a completeness verdict
         Merchandising computed, published as a boolean and not as the gate
         list, because the individual gates are Merchandising's business. */
      allGatesPassed: d.completeness?.allPassed === true,
    });
  }
  return byFile;
}

/* ══ 3. THE ISSUED PRE-PRODUCTION MEETING MINUTES ═════════════════════════ */

/**
 * The current ISSUED minutes for each file, and nothing weaker.
 *
 * Minutes become evidence when they are issued; a draft or a conducted-but-
 * unissued meeting is not minutes anybody may rely on. Superseded issues are
 * published too, with what superseded them, so a reader can see that the
 * minutes it froze are no longer the current ones.
 *
 * Only the reference, the version and the state cross. Not the attendance, not
 * the observations, not the decisions and not the action owners — a planning
 * department needs to know minutes were issued, and reads them in
 * Merchandising's own screen if it needs their content.
 *
 * ── WITH ONE EXCEPTION: WHICH ENGINEERING RELEASE WAS ON THE TABLE ─────────
 * PPC freezes an IE release into its planning file and plans against it. The
 * meeting reviewed an IE release too, and NOTHING CHECKED THAT THEY WERE THE
 * SAME ONE — so an order could be planned against engineering nobody had met
 * about, and the minutes would still read as satisfied.
 *
 * The fact that settles it is Merchandising's own: the meeting's frozen source
 * snapshot already records which release was reviewed. So it is published
 * here, as identity only — the record id and the version number — and PPC
 * compares it with what PPC itself froze. Publishing it is not Merchandising
 * telling PPC whether it may plan; the comparison, and what to do about a
 * disagreement, are PPC's, in PPC's own code.
 *
 * `reviewedIeRelease` is null when the issued minutes established no readable
 * release, and a reader must treat that as "not established" rather than as
 * agreement. The reference travels to be READ and never matched on: a renamed
 * release is the same release, a reused code is not, and only the id can tell
 * them apart.
 *
 * ── WHICH CONTRACT CAPTURED IT, PUBLISHED BESIDE IT ────────────────────────
 * A null `reviewedIeRelease` has two meanings that look identical in the data
 * and are opposites: minutes that were taken before the release was captured
 * at all, and minutes that captured it and found there was none. The first is
 * a gap in what the record could ever say; the second is a positive statement.
 * A reader that could not tell them apart would either fail every historical
 * plan or wave through an order nobody reviewed engineering for.
 *
 * So `evidenceContract` carries the version the snapshot was taken under, as
 * the meeting itself stamped it, and `capturesReviewedRelease` says plainly
 * whether a reader may treat this record's silence as a statement. Neither is
 * inferred here — not from a date, not from a null, not from which fields are
 * populated — and no historical record is rewritten to acquire one.
 */
/**
 * The engineering release one issued minute recorded as reviewed — identity
 * only, read from the meeting's own frozen snapshot.
 *
 * Taken from the snapshot and nowhere else. Asking IE what the style's current
 * release is would answer a different question — what is in force TODAY — and
 * would make a newer release silently rewrite what an old meeting reviewed.
 * A source row that is not `PRESENT` establishes nothing, and says so by
 * returning null rather than by returning an empty identity.
 */
function reviewedIeRelease(meeting) {
  const row = (meeting.sourceReferences || []).find((s) => str(s.key) === "IE_RELEASE");
  if (!row || str(row.availability) !== "PRESENT") return null;
  /* A row captured under the legacy contract names no record, so it
     establishes nothing whatever it prints. It is reported through
     `evidenceContract` below, not as a half-identity here. */
  return {
    /* Null on minutes issued before the id was recorded. A reader treats that
       as "not established", never as a match. */
    releaseId: row.recordId ? String(row.recordId) : null,
    versionNo: Number.isFinite(row.versionNo) ? row.versionNo : null,
    /* To print beside the id, never to compare on. */
    releaseRef: str(row.reference),
    state: str(row.state),
    reviewedAt: meeting.sourcesCapturedAt ? new Date(meeting.sourcesCapturedAt).toISOString() : null,
  };
}

/**
 * Which snapshot contract these minutes were captured under.
 *
 * Read from the meeting's own stamp and from nothing else. `version` is null
 * on every record issued before the stamp existed, and that null is the
 * answer, not a gap to be filled: it says this record could not have captured
 * a reviewed release, so its silence about one is not a statement.
 */
function evidenceContract(meeting) {
  const version = Number.isFinite(meeting.sourcesContractVersion)
    ? meeting.sourcesContractVersion : null;
  return {
    version,
    /* The one question a reader actually asks of the version number. */
    capturesReviewedRelease: version !== null && version >= RELEASE_IDENTITY_CONTRACT,
  };
}

async function publishIssuedMeetingMinutes(ctx, executionFileIds = []) {
  assertContext(ctx);
  const ids = (executionFileIds || []).filter(isId).map(oid);
  if (!ids.length) return new Map();

  const docs = await PreProductionMeeting.find({
    companyId: oid(ctx.companyId),
    fileId: { $in: ids },
    state: { $in: [PPM_STATE.ISSUED, PPM_STATE.SUPERSEDED] },
  })
    .sort({ fileId: 1, versionNo: -1 })
    .lean();

  const byFile = new Map();
  for (const d of docs) {
    const key = String(d.fileId);
    if (byFile.has(key)) continue;
    byFile.set(key, {
      meetingId: String(d._id),
      executionFileId: key,
      versionNo: d.versionNo,
      state: str(d.state),
      issuedAt: d.issuedAt ? new Date(d.issuedAt).toISOString() : null,
      supersededAt: d.supersededAt ? new Date(d.supersededAt).toISOString() : null,
      supersededByVersionNo: d.supersededByVersionNo ?? null,
      evidenceContract: evidenceContract(d),
      reviewedIeRelease: reviewedIeRelease(d),
    });
  }
  return byFile;
}

/* ══ 4. WHAT OTHER DEPARTMENTS HAVE SAID ══════════════════════════════════ */

/**
 * The current department-status projections for each file, as CONTEXT.
 *
 * Published with the four-state availability vocabulary intact — see
 * `departmentStatus.contract.js` for why "not reported", "reported as
 * nothing", "the source app does not talk to us" and "does not apply" have to
 * stay four different answers. Collapsing them is how a blank cell starts
 * reading as fine.
 *
 * A reader may show these. A reader must not turn them into its own gate:
 * Store saying nothing is Store saying nothing, and a planning department that
 * blocked on silence would be inventing a requirement no department agreed.
 */
async function publishDepartmentStatusContext(ctx, executionFileIds = [], departments = null) {
  assertContext(ctx);
  const ids = (executionFileIds || []).filter(isId).map(oid);
  if (!ids.length) return new Map();

  const query = {
    companyId: oid(ctx.companyId),
    fileId: { $in: ids },
    isCurrent: true,
  };
  if (Array.isArray(departments) && departments.length) {
    query.department = { $in: departments.map(str).filter(Boolean) };
  }

  const docs = await DepartmentStatusProjection.find(query)
    .sort({ fileId: 1, department: 1, sourceObservedAt: -1 })
    .lean();

  const byFile = new Map();
  for (const d of docs) {
    const key = String(d.fileId);
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push({
      department: str(d.department),
      statusCode: str(d.statusCode),
      statusLabel: str(d.statusLabel),
      availability: str(d.availability) || AVAILABILITY.UNKNOWN,
      unitDiscriminator: str(d.unitDiscriminator),
      sourceApp: str(d.sourceApp),
      sourceRecordRef: str(d.sourceRecordRef),
      sourceRecordVersion: d.sourceRecordVersion ?? null,
      sourceObservedAt: d.sourceObservedAt
        ? new Date(d.sourceObservedAt).toISOString() : null,
    });
  }
  return byFile;
}

module.exports = {
  DEFAULT_LIMIT, MAX_LIMIT, CONFIRMED_LIFECYCLE,
  publishConfirmedOrderLines, publishConfirmedOrderLine,
  publishCurrentExecutionPacks,
  publishIssuedMeetingMinutes,
  publishDepartmentStatusContext,
};
