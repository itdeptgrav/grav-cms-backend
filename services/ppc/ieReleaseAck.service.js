// services/ppc/ieReleaseAck.service.js
//
// PPC'S SIDE OF THE IE HANDOVER. PPC WRITES; IE DOES NOT.
//
// Industrial Engineering issues an immutable release into `ie_releases`. That
// document's presence, with the acting company's id and `state: "ISSUED"`, IS
// the delivery — there is no outbox, no delivery row, no worker and no copy of
// a release inside PPC. The queue below is a company-scoped query over IE's own
// collection, exactly as `inboundPack.service.listInbound` queries
// `ExecutionPack`. A release read twice is the same document twice.
//
// ── THE ONE WRITE THIS SERVICE MAKES ────────────────────────────────────────
// A row in `ppc_ie_release_receipts`, and nothing else. Unlike the Merchandising
// direction there is no mirror: PPC's decision does NOT move the IE release,
// does not touch the style file, and writes nothing into Production or a work
// order. A release's state is IE's alone, and a receipt beside it is PPC's
// alone; `effectiveState` joins the two at read time and is never persisted.
//
// ── AND THERE IS NO REJECT ──────────────────────────────────────────────────
// The receipt enum has no such member and no route offers one. PPC may ask for
// clarification, which tells IE what to fix and leaves the release exactly as
// issued.
//
// ── HOW EXACTLY-ONCE IS ACTUALLY ACHIEVED ───────────────────────────────────
// Not by a transaction, and not by the ledger. The decision is ONE insert of
// ONE document, and `{companyId, releaseRef, releaseVersionNo}` is unique. Two
// concurrent decisions therefore produce one row and one loser, and the loser
// re-reads the winning row and classifies itself from the key and request hash
// stored on it:
//
//   · my key, my request  → this was my own retry; replay the 200
//   · my key, another request → IDEMPOTENCY_KEY_REUSED
//   · another key            → IE_RELEASE_ALREADY_ACKNOWLEDGED
//
// No duplicate-key error ever reaches the caller and no path returns a 500.
// `once()` (shared with the inbound-pack queue) still runs the ledger in front
// of all this, which is what makes the ordinary sequential retry a single read.
"use strict";

const mongoose = require("mongoose");

const IeRelease = require("../../models/CMS_Models/IndustrialEngineering/IeRelease");
const {
  IeReleaseReceipt, RECEIPT_STATE, CLARIFICATION_CATEGORY, EFFECTIVE_STATE,
  MIN_REASON, MAX_REASON,
} = require("../../models/CMS_Models/PPC/IeReleaseReceipt");
const { once, hashRequest } = require("./commandOnce");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
/* Whitespace normalised before it is validated, stored OR hashed — so
   "  A   reason  " and "A reason" are one request, not two. */
const norm = (v) => str(v).replace(/\s+/g, " ");
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));
const iso = (d) => (d ? new Date(d).toISOString() : null);

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const VIEWS = Object.freeze(["pending", "decided", "all"]);

/** The queue covers what IE has handed over. A withdrawn release has not. */
const QUEUE_STATES = Object.freeze([IeRelease.STATE.ISSUED, IeRelease.STATE.SUPERSEDED]);

function assertContext(ctx) {
  if (!ctx?.companyId) {
    throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  }
}

/* A foreign company's release, a deleted one and a malformed id are ONE answer.
   Anything else lets a caller probe which release ids exist elsewhere. */
const notFound = () => fail("IE_RELEASE_NOT_FOUND", "That engineering release does not exist.");

/* ═══ THE DERIVED STATE ════════════════════════════════════════════════════
   Computed from the release's current state and the presence of a receipt.
   Never stored, never written back, and the only place the two halves meet. */
function effectiveStateOf(releaseState, receipt) {
  if (releaseState === IeRelease.STATE.WITHDRAWN) return EFFECTIVE_STATE.WITHDRAWN;
  const superseded = releaseState === IeRelease.STATE.SUPERSEDED;
  if (!receipt) {
    return superseded ? EFFECTIVE_STATE.SUPERSEDED_UNDECIDED : EFFECTIVE_STATE.PENDING;
  }
  if (receipt.state === RECEIPT_STATE.ACCEPTED) {
    return superseded ? EFFECTIVE_STATE.ACCEPTED_SUPERSEDED : EFFECTIVE_STATE.ACCEPTED;
  }
  return superseded
    ? EFFECTIVE_STATE.CLARIFICATION_REQUESTED_SUPERSEDED
    : EFFECTIVE_STATE.CLARIFICATION_REQUESTED;
}

const publishReceipt = (r) => (r ? {
  state: r.state,
  decidedByName: str(r.decidedBy?.name),
  decidedAt: iso(r.decidedAt),
  clarification: r.clarification?.category
    ? { category: r.clarification.category, reason: str(r.clarification.reason) }
    : null,
} : null);

/* ═══ THE CURSOR ═══════════════════════════════════════════════════════════
   A keyset over the exact sort key, not over `_id` alone: the list is ordered
   by `issuedAt` first, and a cursor that carried only an id would skip or
   repeat rows wherever two releases share an instant. `{companyId, state,
   issuedAt: -1, _id: -1}` on `ie_releases` serves both halves. */
const encodeCursor = (row) => Buffer
  .from(`${new Date(row.issuedAt).toISOString()}|${row._id}`, "utf8").toString("base64url");

function decodeCursor(raw) {
  const text = str(raw);
  if (!text) return null;
  let at;
  let id;
  try {
    [at, id] = Buffer.from(text, "base64url").toString("utf8").split("|");
  } catch { at = null; }
  const when = at ? new Date(at) : null;
  if (!when || Number.isNaN(when.getTime()) || !isId(id)) {
    throw fail("VALIDATION", "That page marker is not one this list issued.", { field: "cursor" });
  }
  return {
    $or: [
      { issuedAt: { $lt: when } },
      { issuedAt: when, _id: { $lt: new mongoose.Types.ObjectId(id) } },
    ],
  };
}

/* ═══ LIST INPUTS, ANSWERED RATHER THAN GUESSED ════════════════════════════
   A silently-corrected query is worse than a refused one: the caller gets a
   page that answers a question they did not ask and has no way to tell. So an
   unknown view and an unusable limit are typed refusals that name the field and
   the allowed values, and only ONE correction is made silently — a limit above
   the maximum, which is a cap the caller can see in the reply rather than a
   different question.

   And one of these is not merely cosmetic: `$limit` must be a whole number, so
   a fractional limit reaching Mongo is a 500 on a GET that a caller can trigger
   from a query string. */
function chosenView(view) {
  if (view === undefined || view === null || str(view) === "") return "pending";
  const chosen = str(view);
  if (!VIEWS.includes(chosen)) {
    throw fail("VALIDATION", "That is not one of the views this queue offers.",
      { field: "view", allowed: [...VIEWS] });
  }
  return chosen;
}

function pageSize(limit) {
  if (limit === undefined || limit === null || str(limit) === "") return DEFAULT_LIMIT;
  /* `?limit[]=2` arrives as an array and `?limit[a]=2` as an object; `Number()`
     would quietly unwrap the first and hand the second a NaN. Neither is a page
     size somebody meant to ask for, so both are refused rather than guessed. */
  if (typeof limit === "object") {
    throw fail("VALIDATION", "A page size is a single whole number.",
      { field: "limit", minimum: 1, maximum: MAX_LIMIT });
  }
  const asked = Number(limit);
  if (!Number.isInteger(asked) || asked < 1) {
    throw fail("VALIDATION", "A page size is a whole number of rows, at least one.",
      { field: "limit", minimum: 1, maximum: MAX_LIMIT });
  }
  /* Capped, not refused: asking for more than the page maximum is a reasonable
     thing to do, and the reply says how many were actually returned. */
  return Math.min(asked, MAX_LIMIT);
}

/* ═══ THE QUEUE ════════════════════════════════════════════════════════════ */

/**
 * What IE has issued to this company, and what PPC has said about it.
 *
 * ── FILTERING HAPPENS BEFORE PAGINATION ────────────────────────────────────
 * `pending` and `decided` are questions about a row in ANOTHER collection, so
 * the obvious implementation — take a page of releases, then drop the ones with
 * the wrong receipt — is wrong twice over: it returns short pages, and every
 * dropped row is a release that will never appear on any page. So the receipt
 * is joined inside the pipeline, the view is matched on the joined result, and
 * only then is the page taken. `$limit` sits after `$match`, deliberately.
 */
async function listReleases(ctx, { view, cursor, limit } = {}) {
  assertContext(ctx);
  const chosen = chosenView(view);
  const size = pageSize(limit);

  const match = { companyId: ctx.companyId, state: { $in: [...QUEUE_STATES] } };
  const after = decodeCursor(cursor);
  const pipeline = [
    { $match: after ? { $and: [match, after] } : match },
    { $sort: { issuedAt: -1, _id: -1 } },
    {
      $lookup: {
        from: IeReleaseReceipt.collection.name,
        let: { co: "$companyId", ref: "$releaseRef", v: "$versionNo" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$companyId", "$$co"] },
                  { $eq: ["$releaseRef", "$$ref"] },
                  { $eq: ["$releaseVersionNo", "$$v"] },
                ],
              },
            },
          },
          { $limit: 1 },
        ],
        as: "receiptRows",
      },
    },
    { $addFields: { receipt: { $arrayElemAt: ["$receiptRows", 0] } } },
  ];

  if (chosen === "pending") {
    /* A superseded release with no receipt is NOT pending: it can no longer be
       decided, and offering it in a queue of work would be an invitation to a
       409. It is `SUPERSEDED_UNDECIDED` in `all`, which states the fact without
       asking anybody to act on it. */
    pipeline.push({ $match: { receipt: null, state: IeRelease.STATE.ISSUED } });
  } else if (chosen === "decided") {
    pipeline.push({ $match: { receipt: { $ne: null } } });
  }

  pipeline.push({ $limit: size + 1 });
  pipeline.push({
    $project: {
      releaseRef: 1,
      versionNo: 1,
      state: 1,
      issuedAt: 1,
      issuedByName: 1,
      supersededByVersionNo: 1,
      ieStyleFileId: 1,
      "source.bulletinVersionNo": 1,
      "source.garmentSamMinutes": 1,
      "source.lineLayout.metrics.stationCount": 1,
      "source.capacityStandard.inputs.plannedOperatorCount": 1,
      "source.capacityStandard.calculation.wholePieceDailyTarget": 1,
      "source.capacityStandard.readiness.state": 1,
      "receipt.state": 1,
      "receipt.decidedAt": 1,
      "receipt.decidedBy.name": 1,
      "receipt.clarification.category": 1,
    },
  });

  const found = await IeRelease.aggregate(pipeline);
  const page = found.slice(0, size);

  return {
    view: chosen,
    views: [...VIEWS],
    /* The size actually applied, so a caller who asked for more can see the cap
       rather than infer it from a short page. */
    limit: size,
    maxLimit: MAX_LIMIT,
    rows: page.map((r) => ({
      releaseId: String(r._id),
      releaseRef: r.releaseRef,
      versionNo: r.versionNo,
      releaseState: r.state,
      styleFileId: String(r.ieStyleFileId),
      issuedAt: iso(r.issuedAt),
      issuedByName: str(r.issuedByName),
      supersededByVersionNo: r.supersededByVersionNo ?? null,
      bulletinVersionNo: r.source?.bulletinVersionNo ?? null,
      garmentSamMinutes: r.source?.garmentSamMinutes ?? null,
      stationCount: r.source?.lineLayout?.metrics?.stationCount ?? null,
      plannedOperatorCount: r.source?.capacityStandard?.inputs?.plannedOperatorCount ?? null,
      wholePieceDailyTarget: r.source?.capacityStandard?.calculation?.wholePieceDailyTarget ?? null,
      readinessState: str(r.source?.capacityStandard?.readiness?.state) || null,
      effectiveState: effectiveStateOf(r.state, r.receipt),
      decidedAt: iso(r.receipt?.decidedAt),
      decidedByName: str(r.receipt?.decidedBy?.name),
      clarificationCategory: r.receipt?.clarification?.category || null,
    })),
    nextCursor: found.length > size ? encodeCursor(page[page.length - 1]) : null,
    hasMore: found.length > size,
  };
}

/* ═══ ONE RELEASE, IN FULL ═════════════════════════════════════════════════ */

/* ── THE ALLOWLIST ────────────────────────────────────────────────────────
   Every projection below names its fields. Nothing is spread from a stored
   document, because a spread turns every field IE adds later into something
   PPC receives without anybody deciding it should.

   What PPC gets is the frozen handover: the bulletin rows and their standard
   times, the garment SAM, the line layout and its balance metrics, the capacity
   figures and their stated inputs, the frozen ramp, the readiness verdict with
   its gaps, and the calendar limitation in full.

   What PPC does NOT get, and a test proves recursively: IE drafts and working
   records, the style file's history, method-study ids, observations or cycles,
   any allowance breakdown beyond the frozen standard time, any Sales, customer
   or costing field, and internal service or model fields (`_id`, `__v`,
   `revision`, `history`, `sampleStyleId`). */

const publicRow = (r) => ({
  rowId: r.rowId,
  /* ── STABLE IDENTITY, NOT A DISPLAY LABEL ──────────────────────────────
     `operationCode` and `operationName` are mutable labels: two operations can
     legitimately share a code, and either can be renamed after this release was
     frozen. PPC and everything downstream of it must be able to say WHICH
     operation a row is, exactly, and at which revision — otherwise later work
     falls back to code matching and the barcode/scan continuity the Chunk 8A
     audit pinned stops holding. The id and the revision are that answer, and
     they are the frozen ones. */
  ieOperationId: r.ieOperationId ? String(r.ieOperationId) : null,
  ieOperationRevision: r.ieOperationRevision ?? null,
  sequence: r.sequence,
  operationCode: str(r.operationCode),
  operationName: str(r.operationName),
  machineType: str(r.machineType),
  /* The APPROVED standard time as frozen — one number, already inclusive of
     whatever allowance policy IE applied. The breakdown behind it is IE's
     working record and is deliberately absent. */
  standardTimeMinutes: r.standardTimeMinutes,
  standardTimeSource: str(r.standardTimeSource),
  /* ── THE FROZEN REQUIREMENT EVIDENCE ───────────────────────────────────
     What the operation needed WHEN THE BULLETIN VERSION WAS APPROVED, copied
     into the release and never read back from the operation library. It carries
     its own `capturedAt` and `ieOperationRevision` so a reader can see which
     moment and which revision it is evidence of — a live lookup would silently
     re-answer an approved handover with today's configuration.

     Null where the row froze no evidence: an absence, never an empty list that
     would read as "this operation needs no machine". */
  requirementSnapshot: r.requirementSnapshot ? {
    capturedAt: iso(r.requirementSnapshot.capturedAt),
    ieOperationRevision: r.requirementSnapshot.ieOperationRevision ?? null,
    requirementsConfigured: Boolean(r.requirementSnapshot.requirementsConfigured),
    machineTypes: (r.requirementSnapshot.machineTypes || [])
      .map((m) => ({ machineType: str(m.machineType), quantity: m.quantity })),
  } : null,
});

const publicStation = (s) => ({
  stationId: s.stationId,
  sequence: s.sequence,
  label: str(s.label),
  plannedMachineTypes: (s.plannedMachineTypes || [])
    .map((m) => ({ machineType: str(m.machineType), quantity: m.quantity })),
  assignments: (s.assignments || []).map((a) => ({
    rowId: a.rowId,
    sequence: a.sequence,
    operationCode: str(a.operationCode),
    standardTimeMinutes: a.standardTimeMinutes,
  })),
});

/* The capacity figures, named exactly as `capacityCalculation.js` produces
   them — including `available` and `unavailableReasons`, because a target that
   could not be computed must arrive as a stated absence and never as a zero. */
const publicCalculation = (c) => (c ? {
  netMinutesPerShift: c.netMinutesPerShift ?? null,
  availableOperatorMinutesPerShift: c.availableOperatorMinutesPerShift ?? null,
  garmentSamMinutes: c.garmentSamMinutes ?? null,
  targetEfficiencyPercent: c.targetEfficiencyPercent ?? null,
  shiftsPerDay: c.shiftsPerDay ?? null,
  targetPiecesPerHour: c.targetPiecesPerHour ?? null,
  theoreticalPiecesPerShift: c.theoreticalPiecesPerShift ?? null,
  theoreticalPiecesPerDay: c.theoreticalPiecesPerDay ?? null,
  wholePieceShiftTarget: c.wholePieceShiftTarget ?? null,
  wholePieceDailyTarget: c.wholePieceDailyTarget ?? null,
  rounding: str(c.rounding),
  wholePiecePolicy: str(c.wholePiecePolicy),
  available: c.available !== false,
  unavailableReasons: [...(c.unavailableReasons || [])],
} : null);

const publicGap = (g) => ({
  code: str(g?.code),
  owner: str(g?.owner),
  action: str(g?.action),
  message: str(g?.message),
});

function publicRelease(doc, receipt) {
  const src = doc.source || {};
  const layout = src.lineLayout || {};
  const cap = src.capacityStandard || {};
  const ramp = src.ramp || null;
  return {
    releaseId: String(doc._id),
    releaseRef: doc.releaseRef,
    versionNo: doc.versionNo,
    styleFileId: String(doc.ieStyleFileId),
    releaseState: doc.state,
    /* ── NO INTEGRITY HASHES HERE ───────────────────────────────────────
       `aggregateFingerprint` and the bulletin's `sourceFingerprint` stay stored
       on the immutable release and stay in use internally — they are how IE
       detects a moved aggregate and refuses a duplicate issue. They are server
       mechanism, not an operational fact PPC acts on, and publishing them would
       invite a consumer to treat a deduplication hash as a business key. */
    issuedAt: iso(doc.issuedAt),
    issuedByName: str(doc.issuedByName),
    supersededByVersionNo: doc.supersededByVersionNo ?? null,
    note: str(doc.note),
    frozenAt: iso(src.capturedAt),

    bulletin: {
      versionNo: src.bulletinVersionNo ?? null,
      garmentSamMinutes: src.garmentSamMinutes ?? null,
      samRowCount: src.samRowCount ?? null,
      samDerivation: str(src.samDerivation),
      rows: (src.rows || []).map(publicRow),
    },

    lineLayout: {
      stationCount: layout.stationCount ?? null,
      stations: (layout.stations || []).map(publicStation),
      metrics: {
        totalWorkContentMinutes: layout.metrics?.totalWorkContentMinutes ?? null,
        stationCount: layout.metrics?.stationCount ?? null,
        pitchMinutes: layout.metrics?.pitchMinutes ?? null,
        bottleneckMinutes: layout.metrics?.bottleneckMinutes ?? null,
        balanceEfficiencyPercent: layout.metrics?.balanceEfficiencyPercent ?? null,
        balanceLossPercent: layout.metrics?.balanceLossPercent ?? null,
        rounding: str(layout.metrics?.rounding),
      },
    },

    capacity: {
      inputs: {
        availableShiftMinutes: cap.inputs?.availableShiftMinutes ?? null,
        breakMinutes: cap.inputs?.breakMinutes ?? null,
        shiftsPerDay: cap.inputs?.shiftsPerDay ?? null,
        plannedOperatorCount: cap.inputs?.plannedOperatorCount ?? null,
        plannedHelperCount: cap.inputs?.plannedHelperCount ?? null,
        helperUsage: str(cap.inputs?.helperUsage),
        targetEfficiencyPercent: cap.inputs?.targetEfficiencyPercent ?? null,
        efficiencyUnit: str(cap.inputs?.efficiencyUnit),
        effectiveFrom: cap.inputs?.effectiveFrom ?? null,
        effectiveTo: cap.inputs?.effectiveTo ?? null,
      },
      calculation: publicCalculation(cap.calculation),
      /* The ramp stage's own target, from the SAME calculator — carried
         separately so a first-week number is never read as a steady-state one. */
      rampCalculation: publicCalculation(cap.rampCalculation),
    },

    /* ── THE FROZEN RAMP, SAID PLAINLY ──────────────────────────────────
       Carried because a first-week target that looks like a steady-state one
       is the single most expensive thing PPC could misread. `basis` and
       `describesActuals` travel with it for exactly that reason. */
    ramp: ramp ? {
      rampProfileName: str(ramp.rampProfileName),
      stageLabel: str(ramp.stageLabel),
      stageSequence: ramp.stageSequence ?? null,
      fromProductionDay: ramp.fromProductionDay ?? null,
      toProductionDay: ramp.toProductionDay ?? null,
      targetEfficiencyPercent: ramp.targetEfficiencyPercent ?? null,
      efficiencyUnit: str(ramp.efficiencyUnit),
      basis: str(ramp.basis),
      describesActuals: ramp.describesActuals === true,
    } : null,

    /* ── HOW THE WORKING TIME IS KNOWN, AND WHAT IT IS NOT ───────────────
       Copied in full, gaps and all. IE approved a stated assumption; it proved
       no calendar, and a handover must not be the place that quietly says
       otherwise. */
    workingTime: {
      source: {
        kind: str(cap.workingTimeSource?.kind),
        calendarId: cap.workingTimeSource?.calendarId || null,
        calendarVersionNo: cap.workingTimeSource?.calendarVersionNo ?? null,
        calendarRef: str(cap.workingTimeSource?.calendarRef),
        note: str(cap.workingTimeSource?.note),
      },
      calendarLinkage: {
        state: str(cap.calendarLinkage?.state),
        reason: str(cap.calendarLinkage?.reason),
        message: str(cap.calendarLinkage?.message),
        rejectedSources: [...(cap.calendarLinkage?.rejectedSources || [])],
        requiredUpstreamContract: str(cap.calendarLinkage?.requiredUpstreamContract),
      },
    },

    readiness: {
      state: str(cap.readiness?.state),
      ready: cap.readiness?.ready === true,
      gaps: (cap.readiness?.gaps || []).map(publicGap),
    },

    retiredOperationOverrides: (doc.retiredOperationOverrides || []).map((o) => ({
      operationCode: str(o.operationCode),
      operationName: str(o.operationName),
      retiredAt: iso(o.retiredAt),
      reason: str(o.reason),
      overriddenByName: str(o.overriddenByName),
      overriddenAt: iso(o.overriddenAt),
    })),

    receipt: publishReceipt(receipt),
    effectiveState: effectiveStateOf(doc.state, receipt),
    /* Stated rather than inferred, so a screen never offers a control the
       endpoint will refuse. */
    decidable: doc.state === IeRelease.STATE.ISSUED && !receipt,
    clarificationCategories: [...CLARIFICATION_CATEGORY],
    /* A release hands a plan over. Acknowledging it books nothing and writes
       nothing into Production — those are later chunks and other departments. */
    booksCapacity: false,
    writesProduction: false,
  };
}

async function readRelease(ctx, { releaseId } = {}) {
  assertContext(ctx);
  if (!isId(releaseId)) throw notFound();
  const release = await IeRelease.findOne({ _id: releaseId, companyId: ctx.companyId }).lean();
  if (!release) throw notFound();
  const receipt = await IeReleaseReceipt.findOne({
    companyId: ctx.companyId, ieReleaseId: release._id,
  }).lean();
  return { release: publicRelease(release, receipt) };
}

/* ═══ THE DECISION ═════════════════════════════════════════════════════════ */

const SCOPE = (releaseId) => `ppc:ie-release:${releaseId}`;
/* Never read from a body. Listed so the refusal can name them. */
const BODY_FORBIDDEN = Object.freeze([
  "actor", "actorId", "decidedBy", "decidedAt", "companyId", "actingCompanyId",
  "state", "effectiveState", "idempotencyKey", "releaseId", "releaseVersionNo",
]);

function normaliseBody(decision, body) {
  const supplied = Object.keys(body || {});
  const forbidden = supplied.filter((k) => BODY_FORBIDDEN.includes(k));
  if (forbidden.length) {
    throw fail("VALIDATION",
      "Who is deciding, for which company, on which release and under which key are all "
      + "settled by the request itself — they are not fields.",
      { fields: forbidden });
  }
  if (decision === "accept") {
    /* An acceptance is the absence of a qualification. A body carrying
       business fields would be silently discarded, and a caller who believed
       they had attached a condition would be wrong about what they agreed. */
    if (supplied.length) {
      throw fail("VALIDATION",
        "Accepting an engineering release takes no fields. To qualify it, ask for clarification.",
        { fields: supplied });
    }
    return { decision, category: "", reason: "" };
  }
  const category = norm(body?.category).toUpperCase();
  const reason = norm(body?.reason);
  if (!CLARIFICATION_CATEGORY.includes(category)) {
    throw fail("VALIDATION", "Say what part of the release this clarification is about.",
      { field: "category", allowed: [...CLARIFICATION_CATEGORY] });
  }
  if (reason.length < MIN_REASON) {
    throw fail("VALIDATION",
      "A clarification goes back to an industrial engineer who has to act on it, so say enough to act on.",
      { field: "reason", minimum: MIN_REASON });
  }
  if (reason.length > MAX_REASON) {
    throw fail("VALIDATION", "That clarification is longer than this field holds.",
      { field: "reason", maximum: MAX_REASON });
  }
  return { decision, category, reason };
}

const envelope = (release, receipt, { replayed = false } = {}) => ({
  ...(replayed ? { replayed: true } : {}),
  releaseId: String(release._id),
  releaseRef: release.releaseRef,
  versionNo: release.versionNo,
  releaseState: release.state,
  receipt: publishReceipt(receipt),
  effectiveState: effectiveStateOf(release.state, receipt),
  /* Said here as well as on the read, so nothing about an acknowledgement can
     be mistaken for a booking. */
  booksCapacity: false,
  writesProduction: false,
});

/** The version PPC should be looking at instead, when this one has moved on. */
async function currentVersionOf(ctx, release) {
  if (release.supersededByVersionNo) return release.supersededByVersionNo;
  const latest = await IeRelease.findOne({
    companyId: ctx.companyId, ieStyleFileId: release.ieStyleFileId,
    state: IeRelease.STATE.ISSUED,
  }).sort({ versionNo: -1 }).select("versionNo").lean();
  return latest?.versionNo ?? null;
}

async function decide(ctx, {
  releaseId, decision, body = {}, actor = null, idempotencyKey,
} = {}) {
  assertContext(ctx);
  if (!isId(releaseId)) throw notFound();
  if (!actor?.id) {
    throw fail("UNAUTHENTICATED", "Sign in again — this decision has to be attributable.");
  }
  const request = normaliseBody(decision, body);
  const requestHash = hashRequest(request);

  /* ── MY OWN RETRY, OR SOMEBODY ELSE'S ANSWER ────────────────────────────
     Two questions, deliberately separated, because their ANSWERS sit on
     opposite sides of the lifecycle check below.

     `mine()` is asked first and unconditionally: a caller holding the key that
     wrote the receipt is retrying a decision that was already taken, and a
     retry must keep returning what it returned the first time however the
     release has moved since. This matters because the receipt is written
     BEFORE the command ledger is bound — if that ledger write is lost, the
     ledger's own replay in `once()` never fires, and this is the only thing
     standing between a successful decision and a 409 on its retry.

     `alreadyAnswered()` is a different person arriving second, and it is asked
     only after the lifecycle has had its say — so a NEW decision on a
     superseded or withdrawn release is refused as superseded or withdrawn,
     never quietly reclassified. */
  const mine = (existing) => str(existing.idempotencyKey) === str(idempotencyKey);

  const sameKeyAnswer = (release, existing) => {
    if (existing.requestHash !== requestHash) {
      throw fail("IDEMPOTENCY_KEY_REUSED",
        "That idempotency key was already used for a different request.", { field: "idempotencyKey" });
    }
    /* Replayed against the world as it is NOW: the stored decision is restated
       byte for byte, and `effectiveState` honestly says `ACCEPTED_SUPERSEDED`
       if the version has since been replaced. Nothing stored changes. */
    return { ...envelope(release, existing), replayed: true };
  };

  const alreadyAnswered = (release, existing) => {
    throw fail("IE_RELEASE_ALREADY_ACKNOWLEDGED",
      `Version ${release.versionNo} was already answered: `
      + `${existing.state === RECEIPT_STATE.ACCEPTED ? "accepted" : "sent back for clarification"}`
      + `${existing.decidedBy?.name ? ` by ${existing.decidedBy.name}` : ""}. `
      + "A release version is answered once.",
      {
        releaseVersionNo: release.versionNo,
        receiptState: existing.state,
        decidedAt: iso(existing.decidedAt),
      });
  };

  const result = await once(ctx, {
    scope: SCOPE(str(releaseId)),
    idempotencyKey,
    request,
    /* "Enough to rebuild the reply, never a copy of the record" — the ledger
       schema's own words, and a receipt is exactly what it is rebuilt from. */
    project: (out) => ({
      revisionNo: out?.versionNo ?? null,
      state: str(out?.receipt?.state),
      note: str(out?.releaseRef),
    }),
    rebuild: async () => {
      const release = await IeRelease.findOne({
        _id: releaseId, companyId: ctx.companyId,
      }).lean();
      if (!release) throw notFound();
      const existing = await IeReleaseReceipt.findOne({
        companyId: ctx.companyId, ieReleaseId: release._id,
      }).lean();
      /* The stored decision is restated exactly as PPC gave it. `effectiveState`
         is derived against the world as it is NOW, so a replay after the version
         was superseded honestly says `ACCEPTED_SUPERSEDED` rather than
         pretending nothing moved. Nothing stored changes either way. */
      return envelope(release, existing);
    },
  }, async () => {
    const release = await IeRelease.findOne({
      _id: releaseId, companyId: ctx.companyId,
    }).lean();
    if (!release) throw notFound();

    const already = await IeReleaseReceipt.findOne({
      companyId: ctx.companyId, ieReleaseId: release._id,
    }).lean();

    /* ── MY OWN RETRY OUTRANKS THE LIFECYCLE ────────────────────────────
       A decision that succeeded stays succeeded. Retrying it is not a new
       decision and must not be judged as one — otherwise the single sequence
       this service cannot otherwise survive (receipt written, ledger write
       lost, release superseded, caller retries) turns a completed 200 into a
       409 and the caller is told their decision failed when it did not. */
    if (already && mine(already)) return sameKeyAnswer(release, already);

    /* ── THEN THE LIFECYCLE ─────────────────────────────────────────────
       Everything reaching here is a NEW decision, from a key that has never
       decided this version — and a version that has moved on can never be
       newly accepted or clarified, answered or not. */
    if (release.state === IeRelease.STATE.WITHDRAWN) {
      throw fail("IE_RELEASE_WITHDRAWN",
        `Release ${release.releaseRef} version ${release.versionNo} was withdrawn and cannot be answered.`,
        { releaseRef: release.releaseRef, versionNo: release.versionNo });
    }
    if (release.state === IeRelease.STATE.SUPERSEDED) {
      const currentVersionNo = await currentVersionOf(ctx, release);
      throw fail("IE_RELEASE_VERSION_SUPERSEDED",
        `Version ${release.versionNo} has been superseded`
        + `${currentVersionNo ? ` by version ${currentVersionNo}` : ""}. `
        + "Answer the current version instead.",
        { versionNo: release.versionNo, currentVersionNo },
      );
    }

    /* A live release that somebody else has already answered. */
    if (already) alreadyAnswered(release, already);

    try {
      const [receipt] = await IeReleaseReceipt.create([{
        companyId: ctx.companyId,
        releaseRef: release.releaseRef,
        releaseVersionNo: release.versionNo,
        ieReleaseId: release._id,
        ieStyleFileId: release.ieStyleFileId,
        state: request.decision === "accept"
          ? RECEIPT_STATE.ACCEPTED : RECEIPT_STATE.CLARIFICATION_REQUESTED,
        clarification: request.decision === "accept"
          ? undefined : { category: request.category, reason: request.reason },
        decidedBy: { id: actor.id, name: str(actor.name), email: str(actor.email) },
        decidedAt: new Date(),
        idempotencyKey: str(idempotencyKey),
        requestHash,
      }]);
      /* ── AND THE IE RELEASE IS NOT TOUCHED ────────────────────────────
         No update, no event, no mirror. A release's state is IE's; this row is
         PPC's; `effectiveState` joins them at read time and stores nothing. */
      return envelope(release, receipt.toObject());
    } catch (err) {
      if (err?.code !== 11000) throw err;
      /* ── THE LOST RACE ────────────────────────────────────────────────
         The unique index did what the pre-read could not: it serialised two
         simultaneous decisions. The winner's row says whose it was. */
      const winner = await IeReleaseReceipt.findOne({
        companyId: ctx.companyId, ieReleaseId: release._id,
      }).lean();
      if (!winner) throw err;
      /* The release was ISSUED a moment ago, so the only two answers left are
         "this was my own retry" and "somebody else got there first". */
      if (mine(winner)) return sameKeyAnswer(release, winner);
      return alreadyAnswered(release, winner);
    }
  });

  /* `once()` reports `replayed: false` for anything it ran; a run that resolved
     its own replay through the index says otherwise, and is believed. */
  return result;
}

const accept = (ctx, args) => decide(ctx, { ...args, decision: "accept" });
const requestClarification = (ctx, args) => decide(ctx, { ...args, decision: "clarify" });

/**
 * WHAT PPC PUBLISHES ABOUT ITS ANSWER TO ONE ENGINEERING RELEASE.
 *
 * A Pre-Production Meeting records whether PPC has taken the release on, and
 * that is PPC's fact. Merchandising asks; it does not read PPC's collection
 * and decide for itself what a missing row means.
 *
 * `PENDING` is a real answer and the common one: a release PPC has not decided
 * yet is not an error, and it is emphatically not an acceptance.
 */
async function receiptStateFor(ctx, { releaseRef, versionNo } = {}) {
  assertContext(ctx);
  const ref = str(releaseRef);
  const version = Number(versionNo);
  if (!ref || !Number.isFinite(version)) return null;

  const receipt = await IeReleaseReceipt.findOne({
    companyId: ctx.companyId, releaseRef: ref, versionNo: version,
  }).select("state decidedAt decidedByName clarification updatedAt").lean();

  if (!receipt) {
    return {
      releaseRef: ref, versionNo: version,
      state: "PENDING",
      decidedAt: null, decidedByName: "",
      clarificationCategory: "", updatedAt: null,
    };
  }
  return {
    releaseRef: ref, versionNo: version,
    state: str(receipt.state),
    decidedAt: receipt.decidedAt || null,
    decidedByName: str(receipt.decidedByName),
    clarificationCategory: str(receipt.clarification?.category),
    updatedAt: receipt.updatedAt || null,
  };
}

module.exports = {
  DEFAULT_LIMIT, MAX_LIMIT, VIEWS, QUEUE_STATES, CLARIFICATION_CATEGORY,
  receiptStateFor,
  effectiveStateOf, publicRelease,
  listReleases, readRelease, decide, accept, requestClarification,
};
