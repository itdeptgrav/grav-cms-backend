// services/merchandising/tnaPlan.service.js
//
// THE PLAN, AND EVERY CONTROLLED MOVE ON IT.
//
// Creating a plan from a resolved template version, approving the baseline it
// commits to, moving forecasts, blocking, completing, rescheduling and revising
// the baseline — the whole operational answer to "which milestone threatens the
// committed delivery date, and what is being done about it".
//
// ── THE ONE RULE EVERYTHING ELSE PROTECTS ───────────────────────────────────
// `baselineDate` has exactly two writers: `approveBaseline` and
// `reviseBaseline`. Forecasting, blocking, completing and approving a
// reschedule are all forbidden from touching it, and the baseline DOCUMENT is
// frozen after saving. If a forecast could overwrite a baseline, "are we late"
// would have no answer — the question the whole milestone exists to answer.
//
// ── AND THE ONE IT REFUSES TO BREAK ─────────────────────────────────────────
// A milestone owned by Quality is completed by Quality's event, not by a
// merchandiser. `completeMilestone` refuses a SOURCE_EVENT milestone naming the
// department whose event is required. Merchandising may FORECAST anything —
// that is coordination, and it is the whole job — but it may not assert that
// somebody else's work is finished.
//
// ── WHY A RESCHEDULE IS PREVIEWED BEFORE IT IS APPROVED ─────────────────────
// Moving one date moves everything downstream, sometimes through a committed
// delivery. An approver has to see that before they agree to it, and has to be
// agreeing to what they saw: if the plan moved underneath, approval is refused
// and the requester previews again. An approver who approves a recomputation is
// approving something nobody showed them.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const ExecutionUnit = require("../../models/CMS_Models/Merchandising/ExecutionUnit");
const {
  TnaPlan, TnaMilestone, TnaBaseline, TnaReschedule, TnaReasonCode,
  PLAN_STATE, MILESTONE_STATUS, SCOPE_KIND,
} = require("../../models/CMS_Models/Merchandising/TnaPlan");
const { TnaTemplateVersion, COMPLETION_AUTHORITY, OWNER_DEPARTMENT } = require("../../models/CMS_Models/Merchandising/TnaTemplate");
const { WorkingCalendar, WorkingCalendarVersion } = require("../../models/CMS_Models/Merchandising/WorkingCalendar");
const {
  MerchandisingAuditEvent, MerchandisingOutboxEvent, MerchandisingCommandLedger, OUTBOX_KIND,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const config = require("./tnaConfig.service");
const graph = require("./tnaGraph");
const cal = require("./tnaCalendar");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));
const lower = (v) => str(v).toLowerCase();

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
/** How far ahead counts as "due soon", in working days. */
const DUE_SOON_WINDOW = 7;

function assertContext(ctx) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
}

async function withTxn(fn) {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => { out = await fn(session); });
    return out;
  } catch (err) {
    if (/Transaction numbers|replica set|transactions are not supported/i.test(str(err?.message))) {
      throw fail("MERCHANDISING_TRANSACTION_REQUIRED",
        "This deployment cannot record the change atomically. Ask an operator — the database needs a replica set.");
    }
    throw err;
  } finally {
    session.endSession();
  }
}

/** Same contract as M3/M4: one key, one decision, replayed on retry. */
async function once(ctx, { scope, idempotencyKey, request }, run) {
  const key = str(idempotencyKey);
  if (!key) {
    throw fail("IDEMPOTENCY_KEY_REQUIRED",
      "Send an idempotency key with this command, so a retry cannot take the decision twice.",
      { field: "idempotencyKey" });
  }
  const requestHash = crypto.createHash("sha256")
    .update(JSON.stringify(request ?? null)).digest("hex");
  const held = await MerchandisingCommandLedger.findOne({
    companyId: ctx.companyId, scope, idempotencyKey: key,
  }).lean();
  if (held) {
    if (held.requestHash !== requestHash) {
      throw fail("IDEMPOTENCY_KEY_REUSED",
        "That idempotency key was already used for a different request.", { field: "idempotencyKey" });
    }
    return { replayed: true, ...held.result };
  }
  const result = await run();
  try {
    await MerchandisingCommandLedger.create([{
      companyId: ctx.companyId, scope, idempotencyKey: key, requestHash,
      result: {
        revisionId: result?.planId ? new mongoose.Types.ObjectId(str(result.planId)) : null,
        revisionNo: result?.baselineNo ?? null,
        state: str(result?.state),
        note: str(result?.note),
      },
      at: new Date(),
    }]);
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }
  return { replayed: false, ...result };
}

/* ═══ LOADING ══════════════════════════════════════════════════════════════ */

async function loadFile(ctx, fileId, session = null) {
  assertContext(ctx);
  if (!isId(fileId)) throw fail("NOT_FOUND", "Execution file not found.");
  const q = ExecutionFile.findOne({ _id: fileId, companyId: ctx.companyId });
  const file = session ? await q.session(session) : await q;
  if (!file) throw fail("NOT_FOUND", "Execution file not found.");
  return file;
}

async function loadPlan(ctx, fileId, session = null) {
  const file = await loadFile(ctx, fileId, session);
  const q = TnaPlan.findOne({ companyId: ctx.companyId, fileId: file._id });
  const plan = session ? await q.session(session) : await q;
  if (!plan) {
    throw fail("TNA_PLAN_NOT_FOUND",
      "This file has no Time & Action plan yet.", { fileId: str(file._id) });
  }
  return { file, plan };
}

/** The calendar version a plan was pinned to. Read once per operation. */
async function planCalendar(plan, session = null) {
  const q = WorkingCalendarVersion.findById(plan.calendarVersionId);
  const version = session ? await q.session(session) : await q;
  if (!version) {
    throw fail("TNA_STATE_CONFLICT",
      "The working calendar this plan was built on could not be read.");
  }
  return cal.compile(version);
}

/** The template version a plan was pinned to — for its dependency graph. */
async function planTemplate(plan, session = null) {
  const q = TnaTemplateVersion.findById(plan.templateVersionId);
  const version = session ? await q.session(session) : await q;
  if (!version) {
    throw fail("TNA_STATE_CONFLICT",
      "The template version this plan was built on could not be read.");
  }
  return version;
}

/* ═══ STATUS ═══════════════════════════════════════════════════════════════ */

/**
 * A milestone's status, derived from its own three dates.
 *
 * Stored as well as derived, so the cross-file register can index and sort on
 * it rather than computing twenty thousand rows in memory. Recomputed on every
 * write that could change it.
 *
 * `BLOCKED` overrides everything for display: a blocked milestone is the thing
 * somebody must act on, whatever its dates say. It still forecasts — blocking
 * states a fact, it does not stop arithmetic.
 */
function deriveStatus(milestone, today, calendarVersion) {
  if (milestone.status === MILESTONE_STATUS.NOT_APPLICABLE) return MILESTONE_STATUS.NOT_APPLICABLE;
  if (milestone.actualDate) return MILESTONE_STATUS.COMPLETED;
  if (milestone.blocked && milestone.blocked.reasonCode) return MILESTONE_STATUS.BLOCKED;

  const forecast = milestone.forecastDate;
  if (!forecast) return MILESTONE_STATUS.PENDING;
  if (forecast < today) return MILESTONE_STATUS.OVERDUE;

  /* Late against the commitment, even if not yet past today. */
  if (milestone.baselineDate && forecast > milestone.baselineDate) {
    return MILESTONE_STATUS.FORECAST_LATE;
  }
  let dueSoonEdge = null;
  try {
    dueSoonEdge = cal.addWorkingDays(today, DUE_SOON_WINDOW, calendarVersion);
  } catch {
    /* Past the calendar horizon: "due soon" is unanswerable, which is not a
       reason to mislabel the row. */
    dueSoonEdge = null;
  }
  if (dueSoonEdge && forecast <= dueSoonEdge) return MILESTONE_STATUS.DUE_SOON;
  return MILESTONE_STATUS.PENDING;
}

/* ═══ VIEWS ════════════════════════════════════════════════════════════════ */

/**
 * What a person may be told about one milestone.
 *
 * `awaitingSource` is the honest state for a milestone whose owner publishes no
 * event this system can read: not "outstanding", which would imply somebody is
 * working on it, and not a blank, which reads as fine.
 */
/** How a department is named — in a refusal, and on a screen.
 *  ONE vocabulary, so the sentence a person is refused with and the label they
 *  read in the register are the same words. */
const DEPARTMENT_WORDS = Object.freeze({
  MERCHANDISING: "Merchandising",
  SALES: "Sales",
  PRODUCT_DEVELOPMENT: "Product Development",
  QUALITY: "Quality",
  STORE_SUPPLY_CHAIN: "Store / Supply Chain",
  IE_PPC_PRODUCTION: "IE / PPC / Production",
  LOGISTICS: "Logistics",
});

function milestoneView(m) {
  const sourceOwned = m.completionAuthority === COMPLETION_AUTHORITY.SOURCE_EVENT;
  return {
    milestoneRef: str(m.milestoneRef),
    milestoneCode: str(m.milestoneCode),
    name: str(m.name),
    ownerDepartment: str(m.ownerDepartment),
    ownerDepartmentLabel: DEPARTMENT_WORDS[str(m.ownerDepartment)] || str(m.ownerDepartment),
    completionAuthority: str(m.completionAuthority),
    /* The screen uses this to decide whether a completion control could ever
       be offered — and for a source-owned milestone the answer is never. */
    merchandisingMayComplete: m.completionAuthority === COMPLETION_AUTHORITY.MERCHANDISING,
    awaitingSource: Boolean(sourceOwned && !m.actualDate),
    sourceEventKinds: (m.sourceEventKinds || []).map(str),
    scopeKind: str(m.scopeKind),
    dropRef: str(m.dropRef),
    unitDiscriminator: str(m.unitDiscriminator),
    sequenceRank: m.sequenceRank ?? 0,
    baselineDate: m.baselineDate || null,
    forecastDate: m.forecastDate || null,
    actualDate: m.actualDate || null,
    /* Working days the forecast has slipped past the commitment. Rendered
       beside the forecast, never instead of the baseline. */
    slipDays: m.baselineDate && m.forecastDate && m.forecastDate > m.baselineDate
      ? null : 0,
    status: str(m.status),
    blocked: m.blocked?.reasonCode
      ? {
        reasonCode: str(m.blocked.reasonCode),
        note: str(m.blocked.note),
        byName: str(m.blocked.by?.name),
        at: m.blocked.at || null,
      }
      : null,
    completion: m.completion?.recordedVia
      ? {
        recordedVia: str(m.completion.recordedVia),
        sourceApp: str(m.completion.sourceApp),
        sourceEventKind: str(m.completion.sourceEventKind),
        sourceRecordType: str(m.completion.sourceRecordType),
        sourceRecordRef: str(m.completion.sourceRecordRef),
        observedAt: m.completion.observedAt || null,
        byName: str(m.completion.actor?.name),
      }
      : null,
    revision: m.revision ?? 0,
  };
}

/** Slip in working days, computed where a calendar is available. */
function withSlip(view, calendarVersion) {
  if (view.baselineDate && view.forecastDate && view.forecastDate > view.baselineDate) {
    try {
      view.slipDays = cal.workingDaysBetween(view.baselineDate, view.forecastDate, calendarVersion);
    } catch {
      view.slipDays = null;
    }
  }
  return view;
}

const planView = (plan) => ({
  id: str(plan._id),
  fileId: str(plan.fileId),
  state: str(plan.state),
  planStartDate: plan.planStartDate || null,
  templateName: str(plan.templateName),
  templateVersionNo: plan.templateVersionNo,
  calendarName: str(plan.calendarName),
  calendarVersionNo: plan.calendarVersionNo,
  timezone: str(plan.timezone),
  currentBaselineNo: plan.currentBaselineNo ?? null,
  completedAt: plan.completedAt || null,
  cancelledAt: plan.cancelledAt || null,
  revision: plan.revision ?? 0,
  createdAt: plan.createdAt,
  updatedAt: plan.updatedAt,
});

const baselineView = (b) => ({
  id: str(b._id),
  baselineNo: b.baselineNo,
  state: str(b.state),
  planStartDate: b.planStartDate,
  entryCount: (b.entries || []).length,
  entries: (b.entries || []).map((e) => ({
    milestoneRef: str(e.milestoneRef),
    milestoneCode: str(e.milestoneCode),
    baselineDate: e.baselineDate,
  })),
  approvedByName: str(b.approvedBy?.name),
  approvedAt: b.approvedAt || null,
  supersededByBaselineNo: b.supersededByBaselineNo ?? null,
  supersededAt: b.supersededAt || null,
  revisionReason: b.revisionReason?.reasonCode
    ? {
      reasonCode: str(b.revisionReason.reasonCode),
      note: str(b.revisionReason.note),
      rescheduleRef: str(b.revisionReason.rescheduleRef),
    }
    : null,
});

/* ═══ THE FILE'S OWN FACTS ═════════════════════════════════════════════════ */

/**
 * What the plan is anchored to, read from the file's accepted Sales handover.
 *
 * These are Sales' committed dates. M5 reads them and never writes them; a
 * milestone that anchors to an ex-factory date Sales never stated simply has
 * no anchor, and says so.
 */
function fileAnchors(file) {
  const projection = file.currentExecutionProjection || {};
  const deliveries = (projection.deliveries || []).map((d) => ({
    dropRef: str(d.dropRef),
    committedDeliveryDate: d.committedDeliveryDate
      ? new Date(d.committedDeliveryDate).toISOString().slice(0, 10) : null,
    targetExFactoryDate: d.targetExFactoryDate
      ? new Date(d.targetExFactoryDate).toISOString().slice(0, 10) : null,
    nominatedFactoryRef: str(d.nominatedFactoryRef),
  }));
  const dates = deliveries.map((d) => d.committedDeliveryDate).filter(Boolean).sort();
  return {
    deliveries,
    /* The earliest committed delivery is what a FILE-scoped milestone counts
       back from: the first promise is the one that constrains. */
    deliveryDate: dates[0] || null,
    exFactoryDate: deliveries.map((d) => d.targetExFactoryDate).filter(Boolean).sort()[0] || null,
    committedDeliveryDates: dates,
    buyerRef: str(projection.buyerDisplayLabel),
    factoryRefs: deliveries.map((d) => d.nominatedFactoryRef).filter(Boolean),
  };
}

/* ═══ CREATING THE PLAN ════════════════════════════════════════════════════ */

/**
 * Instantiate a template version's milestones for one file.
 *
 * A `FILE` milestone happens once. A `PER_DELIVERY` one happens per committed
 * drop, and a `PER_UNIT` one per active execution unit — because "fabric
 * in-house" for a November drop is a different control point from the same
 * milestone for a February one, and collapsing them would hide a late drop
 * behind an early one.
 */
function instantiate(templateVersion, { anchors, units }) {
  const rows = [];
  for (const def of templateVersion.milestones || []) {
    const base = {
      milestoneCode: def.milestoneCode,
      name: def.name,
      ownerDepartment: def.ownerDepartment,
      completionAuthority: def.completionAuthority,
      sourceEventKinds: (def.sourceEventKinds || []).map(str),
      anchor: def.anchor,
      offsetWorkingDays: def.offsetWorkingDays ?? 0,
    };
    if (def.scope === "PER_DELIVERY" && anchors.deliveries.length) {
      for (const d of anchors.deliveries) {
        rows.push({
          ...base,
          scopeKind: SCOPE_KIND.DELIVERY,
          dropRef: d.dropRef,
          unitDiscriminator: "",
          milestoneRef: `${def.milestoneCode}::DROP:${d.dropRef}`,
        });
      }
    } else if (def.scope === "PER_UNIT" && units.length) {
      for (const u of units) {
        rows.push({
          ...base,
          scopeKind: SCOPE_KIND.UNIT,
          dropRef: str(u.dropRef),
          unitDiscriminator: str(u.unitDiscriminator),
          milestoneRef: `${def.milestoneCode}::UNIT:${u.unitDiscriminator}`,
        });
      }
    } else {
      /* A per-delivery milestone on a file with no stated drops falls back to
         one file-scoped instance rather than vanishing. */
      rows.push({
        ...base,
        scopeKind: SCOPE_KIND.FILE,
        dropRef: "",
        unitDiscriminator: "",
        milestoneRef: def.milestoneCode,
      });
    }
  }
  return rows;
}

/** Per-instance anchor facts: a drop's own delivery date beats the file's. */
function anchorContextFor(row, anchors) {
  if (row.scopeKind === SCOPE_KIND.DELIVERY) {
    const d = anchors.deliveries.find((x) => x.dropRef === row.dropRef);
    if (d) {
      return {
        deliveryDate: d.committedDeliveryDate || anchors.deliveryDate,
        exFactoryDate: d.targetExFactoryDate || anchors.exFactoryDate,
      };
    }
  }
  return { deliveryDate: anchors.deliveryDate, exFactoryDate: anchors.exFactoryDate };
}

/** Compute every forecast for a set of milestone rows, honouring per-drop anchors. */
function forecastAll(rows, dependencies, anchors, planStartDate, calendarVersion) {
  const perRow = new Map();
  for (const row of rows) {
    const ctxFor = anchorContextFor(row, anchors);
    perRow.set(row.milestoneRef, graph.anchorDate(row, {
      planStartDate, ...ctxFor,
    }, calendarVersion));
  }
  /* Handed to the graph as each row's floor, so it applies INSIDE the ranked
     pass and reaches that milestone's successors. Merging it over the result
     afterwards would leave every downstream milestone computing from nothing —
     see `anchorDate`. */
  const withAnchor = rows.map((r) => {
    /* ── TWO FLOORS, AND THE LATER ONE WINS ────────────────────────────
       The template's anchor says the earliest the process allows. A
       merchandiser's stated forecast says what they actually expect. Neither
       may be silently discarded, and a propagation pass that recomputed over
       the stated date would make `updateForecast` do nothing at all for any
       milestone that has a predecessor. So both are floors, and the later of
       them is the milestone's starting point; a predecessor slipping past it
       still pushes it later, which is the one thing that SHOULD move it. */
    const floors = [perRow.get(r.milestoneRef), r.manualForecastDate].filter(Boolean).sort();
    return { ...r, __anchor: floors.length ? floors[floors.length - 1] : null };
  });
  return graph.computeForecasts(withAnchor, dependencies, { planStartDate }, calendarVersion);
}

/**
 * CREATE A PLAN — resolve, instantiate, forecast. No baseline yet.
 *
 * A plan starts as a DRAFT with forecasts and no commitments: nobody has
 * agreed to these dates. Approving baseline 1 is the separate, deliberate act
 * that turns an expectation into a promise.
 */
async function createPlan(ctx, { fileId, body = {}, actor = null, idempotencyKey } = {}) {
  const file = await loadFile(ctx, fileId);
  const anchors = fileAnchors(file);

  const planStartDate = body.planStartDate
    ? cal.assertDate(body.planStartDate, "planStartDate")
    : cal.todayInZone("Asia/Kolkata");

  return once(ctx, {
    scope: `tna:plan:${str(file._id)}`,
    idempotencyKey,
    request: { planStartDate, templateId: str(body.templateId) },
  }, async () => {
    const existing = await TnaPlan.findOne({ companyId: ctx.companyId, fileId: file._id }).lean();
    if (existing) {
      throw fail("TNA_PLAN_EXISTS",
        "This file already has a Time & Action plan.", { planId: str(existing._id) });
    }

    const resolved = await config.resolveTemplateVersion(ctx, {
      facts: { buyerRef: anchors.buyerRef, factoryRefs: anchors.factoryRefs },
      onDate: planStartDate,
      templateId: body.templateId || null,
    });
    const templateVersion = resolved.version;

    const calendarVersion = await config.resolveCalendarVersion(ctx, {
      calendarId: templateVersion.defaultCalendarId || body.calendarId || null,
      onDate: planStartDate,
    });
    const calendarDoc = await WorkingCalendar.findById(calendarVersion.calendarId).lean();
    const compiled = cal.compile(calendarVersion);

    const template = await mongoose.model("TnaTemplate")
      .findById(templateVersion.templateId).lean();
    const units = await ExecutionUnit
      .find({ fileId: file._id, companyId: ctx.companyId, active: true })
      .select("unitDiscriminator dropRef").lean();

    const rows = instantiate(templateVersion, { anchors, units });
    if (!rows.length) {
      throw fail("VALIDATION", "That template version defines no milestones.");
    }
    const ranks = graph.rank(
      templateVersion.milestones.map((m) => m.milestoneCode),
      templateVersion.dependencies,
    );
    for (const row of rows) row.sequenceRank = ranks.get(row.milestoneCode) ?? 0;
    const forecasts = forecastAll(
      rows, templateVersion.dependencies, anchors, planStartDate, compiled,
    );

    const today = cal.todayInZone(calendarDoc?.timezone || "Asia/Kolkata");

    return withTxn(async (session) => {
      const [plan] = await TnaPlan.create([{
        companyId: ctx.companyId,
        fileId: file._id,
        templateId: templateVersion.templateId,
        templateVersionId: templateVersion._id,
        templateVersionNo: templateVersion.versionNo,
        templateName: str(template?.name),
        calendarId: calendarVersion.calendarId,
        calendarVersionId: calendarVersion._id,
        calendarVersionNo: calendarVersion.versionNo,
        calendarName: str(calendarDoc?.name),
        timezone: str(calendarDoc?.timezone) || "Asia/Kolkata",
        state: PLAN_STATE.DRAFT,
        planStartDate,
        createdBy: actor || undefined,
      }], { session });

      const docs = rows.map((row) => {
        const forecastDate = forecasts.get(row.milestoneRef) || null;
        const shaped = {
          companyId: ctx.companyId,
          planId: plan._id,
          fileId: file._id,
          ...row,
          baselineDate: null,
          forecastDate,
          actualDate: null,
        };
        shaped.status = deriveStatus(shaped, today, compiled);
        return shaped;
      });
      await TnaMilestone.create(docs, { session, ordered: true });

      await MerchandisingAuditEvent.create([audit(file, plan, "TNA_PLAN_CREATED", actor, {
        templateVersionNo: templateVersion.versionNo,
        calendarVersionNo: calendarVersion.versionNo,
        milestoneCount: docs.length,
        planStartDate,
      })], { session, ordered: true });

      return {
        planId: str(plan._id),
        state: plan.state,
        milestoneCount: docs.length,
        templateVersionNo: templateVersion.versionNo,
        note: "Forecast only. Nothing is committed until baseline 1 is approved.",
      };
    });
  });
}

/* ═══ READS ════════════════════════════════════════════════════════════════ */

async function getPlan(ctx, { fileId } = {}) {
  const file = await loadFile(ctx, fileId);
  const plan = await TnaPlan.findOne({ companyId: ctx.companyId, fileId: file._id });
  if (!plan) {
    /* Not an error: most files have no plan, and the tab says so plainly
       rather than inventing baselines nobody committed to. */
    return { plan: null, milestones: [], baseline: null, anchors: fileAnchors(file) };
  }
  const compiled = await planCalendar(plan);
  const [milestones, baseline] = await Promise.all([
    TnaMilestone.find({ companyId: ctx.companyId, planId: plan._id })
      .sort({ sequenceRank: 1, milestoneRef: 1 }).lean(),
    TnaBaseline.findOne({ companyId: ctx.companyId, planId: plan._id, state: "ACTIVE" }).lean(),
  ]);
  return {
    plan: planView(plan),
    milestones: milestones.map((m) => withSlip(milestoneView(m), compiled)),
    baseline: baseline ? baselineView(baseline) : null,
    anchors: fileAnchors(file),
    today: cal.todayInZone(plan.timezone),
  };
}

async function listMilestones(ctx, { fileId, status, owner, cursor, limit } = {}) {
  const { plan } = await loadPlan(ctx, fileId);
  const compiled = await planCalendar(plan);
  const size = boundedLimit(limit);

  const query = { companyId: ctx.companyId, planId: plan._id };
  if (str(status)) query.status = str(status).toUpperCase();
  if (str(owner)) query.ownerDepartment = str(owner).toUpperCase();
  if (str(cursor)) {
    const rank = Number(cursor);
    if (!Number.isFinite(rank)) {
      throw fail("VALIDATION", "That page marker is not one this list issued.", { field: "cursor" });
    }
    query.sequenceRank = { $gt: rank };
  }
  const rows = await TnaMilestone.find(query)
    .sort({ sequenceRank: 1, milestoneRef: 1 }).limit(size + 1).lean();
  const page = rows.slice(0, size);
  return {
    rows: page.map((m) => withSlip(milestoneView(m), compiled)),
    nextCursor: rows.length > size ? String(page[page.length - 1].sequenceRank) : null,
    hasMore: rows.length > size,
  };
}

function boundedLimit(limit) {
  const asked = limit === undefined || limit === null || limit === "" ? DEFAULT_LIMIT : Number(limit);
  if (!Number.isInteger(asked) || asked < 1) {
    throw fail("VALIDATION", "Ask for a whole number of rows.", { field: "limit" });
  }
  return Math.min(asked, MAX_LIMIT);
}

async function getDependencies(ctx, { fileId } = {}) {
  const { plan } = await loadPlan(ctx, fileId);
  const templateVersion = await planTemplate(plan);
  const compiled = await planCalendar(plan);
  const milestones = await TnaMilestone
    .find({ companyId: ctx.companyId, planId: plan._id })
    .sort({ sequenceRank: 1 }).lean();

  /* The critical path ends at the latest-forecast incomplete milestone: that
     is the one setting the delivery date, which is what "what is holding this
     up" actually asks. */
  const open = milestones.filter((m) => !m.actualDate && m.forecastDate);
  const target = open.sort((a, b) => (a.forecastDate < b.forecastDate ? 1 : -1))[0]
    || milestones[milestones.length - 1];
  const chain = target
    ? graph.criticalPath(milestones, templateVersion.dependencies, target.milestoneRef)
    : [];

  return {
    dependencies: (templateVersion.dependencies || []).map((d) => ({
      dependencyRef: str(d.dependencyRef),
      predecessorCode: str(d.predecessorCode),
      successorCode: str(d.successorCode),
      lagWorkingDays: d.lagWorkingDays ?? 0,
    })),
    criticalPath: chain.map((m) => withSlip(milestoneView(m), compiled)),
  };
}

async function listBaselines(ctx, { fileId } = {}) {
  const { plan } = await loadPlan(ctx, fileId);
  const rows = await TnaBaseline
    .find({ companyId: ctx.companyId, planId: plan._id }).sort({ baselineNo: -1 }).lean();
  return { baselines: rows.map(baselineView) };
}

async function getBaseline(ctx, { fileId, baselineNo } = {}) {
  const { plan } = await loadPlan(ctx, fileId);
  const b = await TnaBaseline.findOne({
    companyId: ctx.companyId, planId: plan._id, baselineNo: Number(baselineNo),
  }).lean();
  if (!b) throw fail("TNA_BASELINE_REQUIRED", "That baseline does not exist.");
  return { baseline: baselineView(b) };
}

/* ═══ AUDIT AND OUTBOX HELPERS ═════════════════════════════════════════════ */

function audit(file, plan, action, actor, details, extra = {}) {
  return {
    companyId: plan.companyId,
    recordType: "TNA_PLAN",
    recordId: plan._id,
    recordRevision: plan.revision ?? 0,
    action,
    actor: actor || undefined,
    source: extra.source || "merchandising",
    at: extra.at || new Date(),
    reason: str(extra.reason).slice(0, 1000),
    correlationId: extra.correlationId || crypto.randomUUID(),
    previousState: str(extra.previousState),
    resultingState: str(extra.resultingState),
    details: { fileNumber: str(file?.fileNumber), ...details },
  };
}

function outbox(plan, kind, payload, correlationId) {
  return {
    companyId: plan.companyId,
    kind,
    payload: { executionFileId: plan.fileId, planId: plan._id, ...payload },
    correlationId,
  };
}

/* ═══ RECOMPUTING THE PLAN ═════════════════════════════════════════════════
 *
 * One ordered pass over the milestones, writing only what actually moved.
 * Every command that can change a date ends here, so propagation is written
 * once and cannot drift between the six ways a date can move.
 */
async function repropagate({ ctx, plan, file, session, actor = null }) {
  const templateVersion = await planTemplate(plan, session);
  const compiled = await planCalendar(plan, session);
  const anchors = fileAnchors(file);
  const today = cal.todayInZone(plan.timezone);

  const milestones = await TnaMilestone
    .find({ companyId: ctx.companyId, planId: plan._id })
    .sort({ sequenceRank: 1 }).session(session);

  const rows = milestones.map((m) => ({
    milestoneRef: m.milestoneRef,
    milestoneCode: m.milestoneCode,
    anchor: (templateVersion.milestones || [])
      .find((d) => d.milestoneCode === m.milestoneCode)?.anchor || "PLAN_START",
    offsetWorkingDays: (templateVersion.milestones || [])
      .find((d) => d.milestoneCode === m.milestoneCode)?.offsetWorkingDays ?? 0,
    scopeKind: m.scopeKind,
    dropRef: m.dropRef,
    unitDiscriminator: m.unitDiscriminator,
    sequenceRank: m.sequenceRank,
    actualDate: m.actualDate,
    forecastDate: m.forecastDate,
    /* What a person stated for this milestone, if anybody has. Applied as a
       floor inside the pass — see `forecastAll`. */
    manualForecastDate: m.manualForecastDate || null,
  }));

  const forecasts = forecastAll(
    rows, templateVersion.dependencies, anchors, plan.planStartDate, compiled,
  );

  const moved = [];
  for (const m of milestones) {
    const next = forecasts.get(m.milestoneRef) || null;
    const before = m.forecastDate || null;
    const beforeStatus = m.status;

    if (next !== before) m.forecastDate = next;
    const status = deriveStatus(m, today, compiled);
    if (status !== m.status) m.status = status;

    if (m.isModified()) {
      m.revision += 1;
      await m.save({ session });
      if (next !== before) {
        moved.push({
          milestoneRef: m.milestoneRef, milestoneCode: m.milestoneCode, name: m.name,
          beforeForecast: before, afterForecast: next,
          baselineDate: m.baselineDate || null, beforeStatus, status: m.status,
        });
      }
    }
  }
  return { moved, milestones, compiled, today, templateVersion, anchors };
}

/**
 * A plan becomes ACTIVE the moment somebody acts on it, and COMPLETED when
 * every milestone has actually happened.
 *
 * Both are consequences, not commands: nobody presses "activate", and a plan
 * that is finished should not wait for somebody to say so.
 */
async function settlePlanState({ plan, session, file, actor, correlationId, outboxRows }) {
  if (plan.state === PLAN_STATE.CANCELLED) return plan.state;

  if (plan.state === PLAN_STATE.BASELINED) {
    plan.state = PLAN_STATE.ACTIVE;
  }
  if (plan.state === PLAN_STATE.ACTIVE) {
    const open = await TnaMilestone.countDocuments({
      companyId: plan.companyId, planId: plan._id,
      actualDate: null, status: { $ne: MILESTONE_STATUS.NOT_APPLICABLE },
    }).session(session);
    if (open === 0) {
      plan.state = PLAN_STATE.COMPLETED;
      plan.completedAt = new Date();
      outboxRows.push(outbox(plan, OUTBOX_KIND.TNA_PLAN_COMPLETED, {}, correlationId));
    }
  }
  return plan.state;
}

/** Optimistic concurrency, stated once. */
function assertExpected(record, expectedRevision, label) {
  const expected = Number(expectedRevision);
  if (!Number.isInteger(expected)) {
    throw fail("VALIDATION", `Say which revision of the ${label} you are changing.`,
      { field: "expectedRevision" });
  }
  if (expected !== (record.revision ?? 0)) {
    throw fail("TNA_STATE_CONFLICT",
      `Somebody changed this ${label} while you were reading it. Re-read it and try again.`,
      { expected, actual: record.revision ?? 0 });
  }
}

async function loadMilestone(ctx, plan, milestoneRef, session) {
  const m = await TnaMilestone.findOne({
    companyId: ctx.companyId, planId: plan._id, milestoneRef: str(milestoneRef),
  }).session(session);
  if (!m) throw fail("TNA_MILESTONE_NOT_FOUND", "That milestone is not on this plan.");
  return m;
}

/** A reason code has to be one the company approved. */
async function assertReasonCode(ctx, code, kind, session) {
  const value = str(code).toUpperCase();
  if (!value) {
    throw fail("TNA_REASON_REQUIRED", "Choose a reason.", { field: "reasonCode" });
  }
  const row = await TnaReasonCode.findOne({
    companyId: ctx.companyId, code: value, kind, isActive: true,
  }).session(session || null);
  if (!row) {
    throw fail("TNA_REASON_REQUIRED",
      `"${value}" is not an approved ${kind.toLowerCase()} reason for this company.`,
      { field: "reasonCode", code: value });
  }
  return value;
}

/* ═══ BASELINE ═════════════════════════════════════════════════════════════ */

/**
 * APPROVE BASELINE 1 — the moment a forecast becomes a promise.
 *
 * Writes `baselineDate` on every milestone from its current forecast, once,
 * and stores the same set as an immutable `TnaBaseline`. From here on nothing
 * but a baseline revision may change those dates.
 */
async function approveBaseline(ctx, { fileId, body = {}, actor = null, idempotencyKey } = {}) {
  const { file, plan } = await loadPlan(ctx, fileId);

  return once(ctx, {
    scope: `tna:baseline:${str(plan._id)}`,
    idempotencyKey,
    request: { expectedRevision: body?.expectedRevision },
  }, async () => withTxn(async (session) => {
    const live = await TnaPlan.findById(plan._id).session(session);
    assertExpected(live, body?.expectedRevision, "plan");
    if (live.state !== PLAN_STATE.DRAFT) {
      throw fail("TNA_BASELINE_EXISTS",
        `This plan is already ${live.state.toLowerCase()}. Revise the baseline instead of approving a first one.`,
        { state: live.state, currentBaselineNo: live.currentBaselineNo });
    }

    const milestones = await TnaMilestone
      .find({ companyId: ctx.companyId, planId: live._id })
      .sort({ sequenceRank: 1 }).session(session);

    const unplaceable = milestones.filter((m) => !m.forecastDate);
    if (unplaceable.length) {
      throw fail("TNA_BASELINE_REQUIRED",
        `${unplaceable.length} milestone(s) have no date yet — `
        + unplaceable.slice(0, 3).map((m) => m.milestoneCode).join(", ")
        + ". A milestone anchored to a date Sales has not stated cannot be committed to.",
        { milestoneRefs: unplaceable.map((m) => m.milestoneRef) });
    }

    const at = new Date();
    const correlationId = crypto.randomUUID();
    const entries = milestones.map((m) => ({
      milestoneRef: m.milestoneRef,
      milestoneCode: m.milestoneCode,
      baselineDate: m.forecastDate,
    }));

    const [baseline] = await TnaBaseline.create([{
      companyId: ctx.companyId,
      planId: live._id,
      fileId: live.fileId,
      baselineNo: 1,
      state: "ACTIVE",
      templateVersionId: live.templateVersionId,
      calendarVersionId: live.calendarVersionId,
      planStartDate: live.planStartDate,
      entries,
      approvedBy: actor || undefined,
      approvedAt: at,
    }], { session });

    const compiled = await planCalendar(live, session);
    const today = cal.todayInZone(live.timezone);
    for (const m of milestones) {
      m.baselineDate = m.forecastDate;
      m.status = deriveStatus(m, today, compiled);
      m.revision += 1;
      await m.save({ session });
    }

    live.state = PLAN_STATE.BASELINED;
    live.currentBaselineNo = 1;
    live.revision += 1;
    live.updatedBy = actor || undefined;
    await live.save({ session });

    await MerchandisingAuditEvent.create([audit(file, live, "TNA_BASELINE_APPROVED", actor, {
      baselineNo: 1, milestoneCount: entries.length,
    }, { at, correlationId, previousState: PLAN_STATE.DRAFT, resultingState: PLAN_STATE.BASELINED })],
    { session, ordered: true });

    await MerchandisingOutboxEvent.create([outbox(live, OUTBOX_KIND.TNA_PLAN_BASELINED, {
      baselineNo: 1, milestoneCount: entries.length,
    }, correlationId)], { session, ordered: true });

    return {
      planId: str(live._id), baselineNo: 1, state: live.state,
      milestoneCount: entries.length,
      note: "Baseline 1 approved. These dates are now the commitment.",
    };
  }));
}

/* ═══ FORECAST, BLOCK, COMPLETE ════════════════════════════════════════════ */

/**
 * UPDATE A FORECAST — and let it cascade.
 *
 * Merchandising may forecast ANY milestone, whoever owns the work. That is
 * coordination and it is the whole job. What it may not do is assert that
 * somebody else's work is finished, which is a different command entirely.
 */
async function updateForecast(ctx, { fileId, milestoneRef, body = {}, actor = null } = {}) {
  const { file, plan } = await loadPlan(ctx, fileId);
  const forecastDate = cal.assertDate(body?.forecastDate, "forecastDate");

  return withTxn(async (session) => {
    const live = await TnaPlan.findById(plan._id).session(session);
    if (live.state === PLAN_STATE.CANCELLED) {
      throw fail("TNA_STATE_CONFLICT", "This plan was cancelled with its order.");
    }
    const m = await loadMilestone(ctx, live, milestoneRef, session);
    assertExpected(m, body?.expectedRevision, "milestone");
    if (m.actualDate) {
      throw fail("TNA_STATE_CONFLICT",
        `${m.name} already happened on ${m.actualDate}. Reopen it before forecasting it again.`,
        { milestoneRef: m.milestoneRef });
    }

    const at = new Date();
    const correlationId = crypto.randomUUID();
    const before = m.forecastDate;
    m.forecastDate = forecastDate;
    /* Kept, so the next propagation pass does not quietly overwrite what a
       person just said. */
    m.manualForecastDate = forecastDate;
    m.lastForecastAt = at;
    m.lastForecastBy = actor || undefined;
    m.revision += 1;
    await m.save({ session });

    /* Everything downstream moves with it, in one ordered pass. */
    const { moved, compiled } = await repropagate({ ctx, plan: live, file, session, actor });

    const outboxRows = [];
    const anchors = fileAnchors(file);
    /* Only a committed date being crossed is another application's business.
       Forecast chatter is Merchandising's working state. */
    const atRisk = anchors.deliveryDate && forecastDate > anchors.deliveryDate;
    if (atRisk) {
      outboxRows.push(outbox(live, OUTBOX_KIND.TNA_MILESTONE_AT_RISK, {
        milestoneRef: m.milestoneRef,
        milestoneCode: m.milestoneCode,
        daysLate: (() => {
          try { return cal.workingDaysBetween(anchors.deliveryDate, forecastDate, compiled); }
          catch { return null; }
        })(),
      }, correlationId));
    }

    await settlePlanState({ plan: live, session, file, actor, correlationId, outboxRows });
    live.revision += 1;
    live.updatedBy = actor || undefined;
    await live.save({ session });

    await MerchandisingAuditEvent.create([audit(file, live, "TNA_FORECAST_UPDATED", actor, {
      milestoneRef: m.milestoneRef, milestoneCode: m.milestoneCode,
      beforeForecast: before, afterForecast: forecastDate,
      cascadedTo: moved.length,
    }, { at, correlationId, reason: body?.note })], { session, ordered: true });

    if (outboxRows.length) {
      await MerchandisingOutboxEvent.create(outboxRows, { session, ordered: true });
    }

    return {
      milestoneRef: m.milestoneRef,
      forecastDate,
      cascaded: moved.map((x) => ({
        milestoneRef: x.milestoneRef, name: x.name,
        beforeForecast: x.beforeForecast, afterForecast: x.afterForecast,
      })),
      planState: live.state,
    };
  });
}

/** BLOCK — a fact, recorded. It does not stop the arithmetic. */
async function blockMilestone(ctx, { fileId, milestoneRef, body = {}, actor = null } = {}) {
  const { file, plan } = await loadPlan(ctx, fileId);
  const note = str(body?.note);
  if (note.length < 10) {
    throw fail("TNA_REASON_REQUIRED",
      "Say what is blocking this, in a sentence somebody else can act on.",
      { field: "note" });
  }

  return withTxn(async (session) => {
    const live = await TnaPlan.findById(plan._id).session(session);
    const reasonCode = await assertReasonCode(ctx, body?.reasonCode, "BLOCK", session);
    const m = await loadMilestone(ctx, live, milestoneRef, session);
    assertExpected(m, body?.expectedRevision, "milestone");

    const at = new Date();
    const correlationId = crypto.randomUUID();
    const compiled = await planCalendar(live, session);
    const today = cal.todayInZone(live.timezone);

    m.blocked = { reasonCode, note: note.slice(0, 2000), by: actor || undefined, at };
    m.status = deriveStatus(m, today, compiled);
    m.revision += 1;
    await m.save({ session });

    await settlePlanState({ plan: live, session, file, actor, correlationId, outboxRows: [] });
    live.revision += 1;
    await live.save({ session });

    await MerchandisingAuditEvent.create([audit(file, live, "TNA_MILESTONE_BLOCKED", actor, {
      milestoneRef: m.milestoneRef, milestoneCode: m.milestoneCode,
      ownerDepartment: m.ownerDepartment, reasonCode,
    }, { at, correlationId, reason: note })], { session, ordered: true });

    await MerchandisingOutboxEvent.create([outbox(live, OUTBOX_KIND.TNA_MILESTONE_BLOCKED, {
      milestoneRef: m.milestoneRef, milestoneCode: m.milestoneCode,
      ownerDepartment: m.ownerDepartment, reasonCode,
    }, correlationId)], { session, ordered: true });

    return { milestoneRef: m.milestoneRef, status: m.status, blocked: true };
  });
}

async function unblockMilestone(ctx, { fileId, milestoneRef, body = {}, actor = null } = {}) {
  const { file, plan } = await loadPlan(ctx, fileId);
  return withTxn(async (session) => {
    const live = await TnaPlan.findById(plan._id).session(session);
    const m = await loadMilestone(ctx, live, milestoneRef, session);
    assertExpected(m, body?.expectedRevision, "milestone");
    if (!m.blocked?.reasonCode) {
      throw fail("TNA_STATE_CONFLICT", `${m.name} is not blocked.`, { milestoneRef: m.milestoneRef });
    }
    const at = new Date();
    const correlationId = crypto.randomUUID();
    const previous = str(m.blocked.reasonCode);
    const compiled = await planCalendar(live, session);

    m.blocked = null;
    m.status = deriveStatus(m, cal.todayInZone(live.timezone), compiled);
    m.revision += 1;
    await m.save({ session });

    await MerchandisingAuditEvent.create([audit(file, live, "TNA_MILESTONE_UNBLOCKED", actor, {
      milestoneRef: m.milestoneRef, milestoneCode: m.milestoneCode, previousReasonCode: previous,
    }, { at, correlationId, reason: body?.note })], { session, ordered: true });

    return { milestoneRef: m.milestoneRef, status: m.status, blocked: false };
  });
}

/**
 * COMPLETE — and the refusal that is the feature.
 *
 * Only a milestone Merchandising OWNS can be completed by a merchandiser.
 * Everything else waits for its department's own event, and the refusal names
 * that department rather than saying "forbidden": the person reading it needs
 * to know who to ask, not that they were wrong to try.
 */
async function completeMilestone(ctx, { fileId, milestoneRef, body = {}, actor = null } = {}) {
  const { file, plan } = await loadPlan(ctx, fileId);
  const actualDate = cal.assertDate(body?.actualDate, "actualDate");

  return withTxn(async (session) => {
    const live = await TnaPlan.findById(plan._id).session(session);
    if (live.state === PLAN_STATE.CANCELLED) {
      throw fail("TNA_STATE_CONFLICT", "This plan was cancelled with its order.");
    }
    const m = await loadMilestone(ctx, live, milestoneRef, session);
    assertExpected(m, body?.expectedRevision, "milestone");

    if (m.completionAuthority !== COMPLETION_AUTHORITY.MERCHANDISING) {
      throw fail("TNA_SOURCE_OWNED",
        `${m.name} is ${DEPARTMENT_WORDS[m.ownerDepartment] || m.ownerDepartment}'s to report. `
        + "Merchandising coordinates the date; it cannot record that another department's work is finished. "
        + "It completes when their system says so.",
        {
          milestoneRef: m.milestoneRef,
          ownerDepartment: m.ownerDepartment,
          sourceEventKinds: (m.sourceEventKinds || []).map(str),
        });
    }
    if (m.actualDate) {
      throw fail("TNA_STATE_CONFLICT",
        `${m.name} is already recorded as done on ${m.actualDate}.`, { milestoneRef: m.milestoneRef });
    }

    const at = new Date();
    const correlationId = crypto.randomUUID();
    m.actualDate = actualDate;
    m.completion = {
      recordedVia: "MERCHANDISING_ENTRY",
      sourceApp: "merchandising",
      observedAt: at,
      actor: actor || undefined,
    };
    m.blocked = null;
    m.revision += 1;
    await m.save({ session });

    const { moved } = await repropagate({ ctx, plan: live, file, session, actor });
    const outboxRows = [];
    await settlePlanState({ plan: live, session, file, actor, correlationId, outboxRows });
    live.revision += 1;
    await live.save({ session });

    await MerchandisingAuditEvent.create([audit(file, live, "TNA_MILESTONE_COMPLETED", actor, {
      milestoneRef: m.milestoneRef, milestoneCode: m.milestoneCode, actualDate,
      cascadedTo: moved.length,
    }, { at, correlationId })], { session, ordered: true });

    if (outboxRows.length) {
      await MerchandisingOutboxEvent.create(outboxRows, { session, ordered: true });
    }
    return {
      milestoneRef: m.milestoneRef, actualDate, planState: live.state,
      cascaded: moved.length,
    };
  });
}

/** REOPEN — the previous actual is kept in the audit trail, not lost. */
async function reopenMilestone(ctx, { fileId, milestoneRef, body = {}, actor = null } = {}) {
  const { file, plan } = await loadPlan(ctx, fileId);
  const reason = str(body?.reason);
  if (reason.length < 10) {
    throw fail("TNA_REASON_REQUIRED", "Say why this is being reopened.", { field: "reason" });
  }
  return withTxn(async (session) => {
    const live = await TnaPlan.findById(plan._id).session(session);
    const m = await loadMilestone(ctx, live, milestoneRef, session);
    assertExpected(m, body?.expectedRevision, "milestone");
    if (!m.actualDate) {
      throw fail("TNA_STATE_CONFLICT", `${m.name} has not been completed.`);
    }
    const at = new Date();
    const correlationId = crypto.randomUUID();
    const previousActual = m.actualDate;
    const previousCompletion = m.completion ? m.completion.toObject() : null;

    m.actualDate = null;
    m.completion = null;
    m.revision += 1;
    await m.save({ session });

    await repropagate({ ctx, plan: live, file, session, actor });
    if (live.state === PLAN_STATE.COMPLETED) {
      live.state = PLAN_STATE.ACTIVE;
      live.completedAt = null;
      live.reopenedAt = at;
    }
    live.revision += 1;
    await live.save({ session });

    await MerchandisingAuditEvent.create([audit(file, live, "TNA_MILESTONE_REOPENED", actor, {
      milestoneRef: m.milestoneRef, milestoneCode: m.milestoneCode,
      /* Preserved here rather than silently lost. */
      previousActualDate: previousActual,
      previousRecordedVia: str(previousCompletion?.recordedVia),
    }, { at, correlationId, reason })], { session, ordered: true });

    return { milestoneRef: m.milestoneRef, actualDate: null, planState: live.state };
  });
}

/* ═══ RESCHEDULE ═══════════════════════════════════════════════════════════ */

/**
 * PREVIEW — pure computation, plus one PREVIEWED row and nothing else.
 *
 * Simulates the move against a copy of the plan's dates: what every affected
 * milestone becomes, and whether a committed delivery date breaks. The result
 * is frozen onto the request, because an approver must approve the impact they
 * were SHOWN.
 */
async function previewReschedule(ctx, { fileId, body = {}, actor = null } = {}) {
  const { file, plan } = await loadPlan(ctx, fileId);
  const proposedDate = cal.assertDate(body?.proposedDate, "proposedDate");
  const milestoneRef = str(body?.milestoneRef);
  const reasonNote = str(body?.reasonNote);
  if (reasonNote.length < 15) {
    throw fail("TNA_REASON_REQUIRED",
      "A reschedule needs a reason somebody else can act on — at least a sentence.",
      { field: "reasonNote", minimum: 15 });
  }
  const reasonCode = await assertReasonCode(ctx, body?.reasonCode, "RESCHEDULE");

  const templateVersion = await planTemplate(plan);
  const compiled = await planCalendar(plan);
  const anchors = fileAnchors(file);
  const milestones = await TnaMilestone
    .find({ companyId: ctx.companyId, planId: plan._id }).sort({ sequenceRank: 1 }).lean();

  const target = milestones.find((m) => m.milestoneRef === milestoneRef);
  if (!target) throw fail("TNA_MILESTONE_NOT_FOUND", "That milestone is not on this plan.");

  /* Simulated in memory. Nothing below writes a milestone. */
  const simulated = milestones.map((m) => ({
    ...m,
    forecastDate: m.milestoneRef === milestoneRef ? proposedDate : m.forecastDate,
  }));
  const after = forecastAll(
    simulated.map((m) => ({
      ...m,
      anchor: (templateVersion.milestones || [])
        .find((d) => d.milestoneCode === m.milestoneCode)?.anchor || "PLAN_START",
      offsetWorkingDays: (templateVersion.milestones || [])
        .find((d) => d.milestoneCode === m.milestoneCode)?.offsetWorkingDays ?? 0,
    })),
    templateVersion.dependencies, anchors, plan.planStartDate, compiled,
  );
  /* The moved milestone holds the date the requester asked for; everything
     else is what the graph makes of it. */
  after.set(milestoneRef, proposedDate);

  const affected = [];
  for (const m of milestones) {
    const before = m.forecastDate || null;
    const next = after.get(m.milestoneRef) || null;
    if (before === next) continue;
    let daysMoved = 0;
    try {
      if (before && next) daysMoved = cal.workingDaysBetween(before, next, compiled);
    } catch { daysMoved = 0; }
    affected.push({
      milestoneRef: m.milestoneRef, milestoneCode: m.milestoneCode, name: m.name,
      beforeForecast: before, afterForecast: next,
      baselineDate: m.baselineDate || null, daysMoved,
    });
  }

  /* ── DOES THIS BREAK A PROMISE? ────────────────────────────────────────
     The question that decides whether this is a forecast change or a
     re-commitment, and the one the approver most needs answered. */
  let breaches = false;
  let deliveryDaysLate = 0;
  for (const row of affected) {
    if (row.baselineDate && row.afterForecast && row.afterForecast > row.baselineDate) {
      breaches = true;
    }
  }
  if (anchors.deliveryDate) {
    const latest = affected.map((r) => r.afterForecast).filter(Boolean).sort().pop();
    if (latest && latest > anchors.deliveryDate) {
      breaches = true;
      try {
        deliveryDaysLate = cal.workingDaysBetween(anchors.deliveryDate, latest, compiled);
      } catch { deliveryDaysLate = 0; }
    }
  }

  const [doc] = await TnaReschedule.create([{
    companyId: ctx.companyId,
    planId: plan._id,
    fileId: file._id,
    rescheduleRef: `RS-${crypto.randomBytes(5).toString("hex")}`,
    state: "PREVIEWED",
    scope: "MILESTONE",
    milestoneRef,
    reasonCode,
    reasonNote: reasonNote.slice(0, 2000),
    proposedDate,
    impact: {
      affected,
      breachesCommittedDelivery: breaches,
      committedDeliveryDates: anchors.committedDeliveryDates,
      deliveryDaysLate,
      /* What the preview was computed against, so a stale approval is
         detectable rather than silently applying to a changed plan. */
      planRevision: plan.revision ?? 0,
      milestoneRevisions: Object.fromEntries(milestones.map((m) => [m.milestoneRef, m.revision ?? 0])),
    },
    createsBaselineRevision: breaches,
    requestedBy: actor || undefined,
    requestedAt: new Date(),
  }]);

  await MerchandisingAuditEvent.create([audit(file, plan, "TNA_RESCHEDULE_REQUESTED", actor, {
    rescheduleRef: doc.rescheduleRef, milestoneRef, proposedDate,
    affectedCount: affected.length, createsBaselineRevision: breaches,
  }, { reason: reasonNote })]);

  return { reschedule: rescheduleView(doc) };
}

const rescheduleView = (r) => ({
  rescheduleRef: str(r.rescheduleRef),
  state: str(r.state),
  milestoneRef: str(r.milestoneRef),
  reasonCode: str(r.reasonCode),
  reasonNote: str(r.reasonNote),
  proposedDate: r.proposedDate,
  createsBaselineRevision: r.createsBaselineRevision === true,
  impact: {
    affected: (r.impact?.affected || []).map((a) => ({
      milestoneRef: str(a.milestoneRef), milestoneCode: str(a.milestoneCode), name: str(a.name),
      beforeForecast: a.beforeForecast || null, afterForecast: a.afterForecast || null,
      baselineDate: a.baselineDate || null, daysMoved: a.daysMoved ?? 0,
    })),
    breachesCommittedDelivery: r.impact?.breachesCommittedDelivery === true,
    committedDeliveryDates: (r.impact?.committedDeliveryDates || []),
    deliveryDaysLate: r.impact?.deliveryDaysLate ?? 0,
  },
  requestedByName: str(r.requestedBy?.name),
  requestedAt: r.requestedAt || null,
  decidedByName: str(r.decidedBy?.name),
  decidedAt: r.decidedAt || null,
  decisionNote: str(r.decisionNote),
});

async function listReschedules(ctx, { fileId, state } = {}) {
  const { plan } = await loadPlan(ctx, fileId);
  const query = { companyId: ctx.companyId, planId: plan._id };
  if (str(state)) query.state = str(state).toUpperCase();
  const rows = await TnaReschedule.find(query).sort({ createdAt: -1 }).limit(100).lean();
  return { reschedules: rows.map(rescheduleView) };
}

/**
 * APPROVE — apply the impact that was shown, or refuse.
 *
 * Two refusals matter here. The plan may have moved since the preview, in
 * which case the approver would be agreeing to something nobody showed them.
 * And where the move breaks a commitment, the person who asked for it may not
 * be the person who grants it — the same maker/checker rule M4's selection
 * approval follows, for the same reason.
 */
async function approveReschedule(ctx, { fileId, rescheduleRef, body = {}, actor = null, idempotencyKey } = {}) {
  const { file, plan } = await loadPlan(ctx, fileId);

  return once(ctx, {
    scope: `tna:reschedule:${str(plan._id)}:${str(rescheduleRef)}`,
    idempotencyKey,
    request: { rescheduleRef: str(rescheduleRef) },
  }, async () => withTxn(async (session) => {
    const live = await TnaPlan.findById(plan._id).session(session);
    const request = await TnaReschedule.findOne({
      companyId: ctx.companyId, planId: live._id, rescheduleRef: str(rescheduleRef),
    }).session(session);
    if (!request) throw fail("NOT_FOUND", "That reschedule request does not exist.");
    if (request.state !== "PREVIEWED") {
      throw fail("TNA_STATE_CONFLICT",
        `That request was already ${request.state.toLowerCase()}.`, { state: request.state });
    }

    /* Maker and checker — only where a commitment is being changed. */
    if (request.createsBaselineRevision) {
      const same = (who) => Boolean(
        (str(actor?.email) && lower(who?.email) === lower(actor?.email))
        || (str(actor?.id) && str(who?.id) === str(actor?.id)),
      );
      if (same(request.requestedBy)) {
        throw fail("TNA_SELF_APPROVAL",
          "This reschedule moves a committed date, so it is approved by somebody other than "
          + "the person who asked for it.",
          { rescheduleRef: request.rescheduleRef });
      }
    }

    /* Has the plan moved underneath the preview? */
    if ((request.impact?.planRevision ?? 0) !== (live.revision ?? 0)) {
      throw fail("TNA_IMPACT_STALE",
        "The plan changed after this impact was calculated. Preview it again so the decision "
        + "is made on what is actually there.",
        { previewedAtRevision: request.impact?.planRevision ?? 0, currentRevision: live.revision ?? 0 });
    }

    const at = new Date();
    const correlationId = crypto.randomUUID();
    const target = await loadMilestone(ctx, live, request.milestoneRef, session);
    target.forecastDate = request.proposedDate;
    /* ── THE FLOOR, NOT JUST THE DATE ──────────────────────────────────
       `repropagate` below recomputes every forecast from its anchor, and it
       honours exactly two floors: the predecessor chain, and the stated
       `manualForecastDate`. Setting only `forecastDate` here meant the
       recompute put the milestone straight back where it started — so a
       reschedule could be requested, previewed, approved by a second person
       and recorded as APPROVED while the date never moved at all.

       `updateForecast` had this line from the start; this path did not, which
       is why the defect only ever showed on the reviewed route. */
    target.manualForecastDate = request.proposedDate;
    target.lastForecastAt = at;
    target.lastForecastBy = actor || undefined;
    target.revision += 1;
    await target.save({ session });

    await repropagate({ ctx, plan: live, file, session, actor });

    const outboxRows = [];
    let newBaselineNo = null;
    if (request.createsBaselineRevision) {
      newBaselineNo = await writeBaselineRevision({
        ctx, plan: live, file, session, actor, at, correlationId,
        reasonCode: request.reasonCode, note: request.reasonNote,
        rescheduleRef: request.rescheduleRef, outboxRows,
      });
    }

    request.state = "APPROVED";
    request.decidedBy = actor || undefined;
    request.decidedAt = at;
    request.decisionNote = str(body?.note).slice(0, 2000);
    await request.save({ session });

    await settlePlanState({ plan: live, session, file, actor, correlationId, outboxRows });
    live.revision += 1;
    await live.save({ session });

    await MerchandisingAuditEvent.create([audit(file, live, "TNA_RESCHEDULE_APPROVED", actor, {
      rescheduleRef: request.rescheduleRef, milestoneRef: request.milestoneRef,
      proposedDate: request.proposedDate,
      affectedCount: (request.impact?.affected || []).length,
      baselineNo: newBaselineNo,
    }, { at, correlationId, reason: request.reasonNote })], { session, ordered: true });

    if (outboxRows.length) {
      await MerchandisingOutboxEvent.create(outboxRows, { session, ordered: true });
    }
    return {
      rescheduleRef: request.rescheduleRef, state: "APPROVED",
      baselineNo: newBaselineNo, planState: live.state,
      note: newBaselineNo
        ? `Applied, and baseline ${newBaselineNo} now records the new commitment.`
        : "Applied. The commitment is unchanged.",
    };
  }));
}

async function rejectReschedule(ctx, { fileId, rescheduleRef, body = {}, actor = null } = {}) {
  const { file, plan } = await loadPlan(ctx, fileId);
  const note = str(body?.note);
  if (note.length < 10) {
    throw fail("TNA_REASON_REQUIRED", "Say why this reschedule is being refused.", { field: "note" });
  }
  const request = await TnaReschedule.findOne({
    companyId: ctx.companyId, planId: plan._id, rescheduleRef: str(rescheduleRef),
  });
  if (!request) throw fail("NOT_FOUND", "That reschedule request does not exist.");
  if (request.state !== "PREVIEWED") {
    throw fail("TNA_STATE_CONFLICT", `That request was already ${request.state.toLowerCase()}.`);
  }
  request.state = "REJECTED";
  request.decidedBy = actor || undefined;
  request.decidedAt = new Date();
  request.decisionNote = note.slice(0, 2000);
  await request.save();

  await MerchandisingAuditEvent.create([audit(file, plan, "TNA_RESCHEDULE_REJECTED", actor, {
    rescheduleRef: request.rescheduleRef, milestoneRef: request.milestoneRef,
  }, { reason: note })]);
  return { rescheduleRef: request.rescheduleRef, state: "REJECTED" };
}

/** WITHDRAW — the requester's own to take back, and nobody else's. */
async function withdrawReschedule(ctx, { fileId, rescheduleRef, actor = null } = {}) {
  const { plan } = await loadPlan(ctx, fileId);
  const request = await TnaReschedule.findOne({
    companyId: ctx.companyId, planId: plan._id, rescheduleRef: str(rescheduleRef),
  });
  if (!request) throw fail("NOT_FOUND", "That reschedule request does not exist.");
  if (request.state !== "PREVIEWED") {
    throw fail("TNA_STATE_CONFLICT", `That request was already ${request.state.toLowerCase()}.`);
  }
  const same = (str(actor?.email) && lower(request.requestedBy?.email) === lower(actor?.email))
    || (str(actor?.id) && str(request.requestedBy?.id) === str(actor?.id));
  if (!same) {
    throw fail("FORBIDDEN", "A reschedule is withdrawn by the person who asked for it.");
  }
  request.state = "WITHDRAWN";
  request.decidedAt = new Date();
  await request.save();
  return { rescheduleRef: request.rescheduleRef, state: "WITHDRAWN" };
}

/* ═══ BASELINE REVISION ════════════════════════════════════════════════════ */

/**
 * Supersede the live baseline and write the next one.
 *
 * The ONLY way a `baselineDate` ever changes — and it changes by writing a new
 * immutable document, never by editing the old one. The superseded baseline is
 * kept for the life of the file, because "what did we originally commit to"
 * must stay answerable.
 */
async function writeBaselineRevision({
  ctx, plan, file, session, actor, at, correlationId, reasonCode, note, rescheduleRef, outboxRows,
}) {
  const previous = await TnaBaseline.findOne({
    companyId: ctx.companyId, planId: plan._id, state: "ACTIVE",
  }).session(session);
  if (!previous) {
    throw fail("TNA_BASELINE_REQUIRED",
      "This plan has no approved baseline to revise. Approve baseline 1 first.");
  }

  const milestones = await TnaMilestone
    .find({ companyId: ctx.companyId, planId: plan._id }).sort({ sequenceRank: 1 }).session(session);

  /* Step down first: the partial unique index allows exactly one ACTIVE
     baseline and is checked as each write lands — the same ordering the
     handover version's supersession follows. */
  previous.state = "SUPERSEDED";
  previous.supersededByBaselineNo = previous.baselineNo + 1;
  previous.supersededAt = at;
  await previous.save({ session });

  const entries = milestones.map((m) => ({
    milestoneRef: m.milestoneRef,
    milestoneCode: m.milestoneCode,
    baselineDate: m.actualDate || m.forecastDate || m.baselineDate,
  })).filter((e) => e.baselineDate);

  const [next] = await TnaBaseline.create([{
    companyId: ctx.companyId,
    planId: plan._id,
    fileId: plan.fileId,
    baselineNo: previous.baselineNo + 1,
    state: "ACTIVE",
    templateVersionId: plan.templateVersionId,
    calendarVersionId: plan.calendarVersionId,
    planStartDate: plan.planStartDate,
    entries,
    approvedBy: actor || undefined,
    approvedAt: at,
    revisionReason: {
      reasonCode: str(reasonCode),
      note: str(note).slice(0, 2000),
      rescheduleRef: str(rescheduleRef),
    },
  }], { session });

  const byRef = new Map(entries.map((e) => [e.milestoneRef, e.baselineDate]));
  const compiled = await planCalendar(plan, session);
  const today = cal.todayInZone(plan.timezone);
  for (const m of milestones) {
    const date = byRef.get(m.milestoneRef);
    if (!date || date === m.baselineDate) continue;
    m.baselineDate = date;
    m.status = deriveStatus(m, today, compiled);
    m.revision += 1;
    await m.save({ session });
  }

  plan.currentBaselineNo = next.baselineNo;
  outboxRows.push(outbox(plan, OUTBOX_KIND.TNA_PLAN_REBASELINED, {
    baselineNo: next.baselineNo,
    previousBaselineNo: previous.baselineNo,
    reasonCode: str(reasonCode),
    milestoneCount: entries.length,
  }, correlationId));

  await MerchandisingAuditEvent.create([audit(file, plan, "TNA_BASELINE_REVISED", actor, {
    baselineNo: next.baselineNo, previousBaselineNo: previous.baselineNo,
    reasonCode: str(reasonCode), milestoneCount: entries.length,
  }, { at, correlationId, reason: note })], { session, ordered: true });

  return next.baselineNo;
}

/** A baseline revision asked for directly, outside a reschedule. */
async function reviseBaseline(ctx, { fileId, body = {}, actor = null, idempotencyKey } = {}) {
  const { file, plan } = await loadPlan(ctx, fileId);
  const note = str(body?.note);
  if (note.length < 15) {
    throw fail("TNA_REASON_REQUIRED",
      "A commitment does not move without a recorded reason — at least a sentence.",
      { field: "note", minimum: 15 });
  }
  const reasonCode = await assertReasonCode(ctx, body?.reasonCode, "RESCHEDULE");

  return once(ctx, {
    scope: `tna:rebaseline:${str(plan._id)}`,
    idempotencyKey,
    request: { reasonCode, note },
  }, async () => withTxn(async (session) => {
    const live = await TnaPlan.findById(plan._id).session(session);
    assertExpected(live, body?.expectedRevision, "plan");
    if (![PLAN_STATE.BASELINED, PLAN_STATE.ACTIVE].includes(live.state)) {
      throw fail("TNA_STATE_CONFLICT",
        `A ${live.state.toLowerCase()} plan has no live baseline to revise.`);
    }
    const at = new Date();
    const correlationId = crypto.randomUUID();
    const outboxRows = [];
    const baselineNo = await writeBaselineRevision({
      ctx, plan: live, file, session, actor, at, correlationId,
      reasonCode, note, rescheduleRef: "", outboxRows,
    });
    live.revision += 1;
    await live.save({ session });
    await MerchandisingOutboxEvent.create(outboxRows, { session, ordered: true });
    return { planId: str(live._id), baselineNo, state: live.state };
  }));
}

/* ═══ HISTORY ══════════════════════════════════════════════════════════════ */

async function planHistory(ctx, { fileId, cursor, limit } = {}) {
  const { plan } = await loadPlan(ctx, fileId);
  const size = boundedLimit(limit);
  const query = { companyId: ctx.companyId, recordId: plan._id, recordType: "TNA_PLAN" };
  if (str(cursor)) {
    const at = new Date(Number(cursor));
    if (Number.isNaN(at.getTime())) {
      throw fail("VALIDATION", "That page marker is not one this list issued.", { field: "cursor" });
    }
    query.at = { $lt: at };
  }
  const rows = await MerchandisingAuditEvent.find(query)
    .sort({ at: -1, _id: -1 }).limit(size + 1).lean();
  const page = rows.slice(0, size);
  return {
    rows: page.map((e) => ({
      id: str(e._id), action: str(e.action), at: e.at,
      actorName: str(e.actor?.name), source: str(e.source), reason: str(e.reason),
      details: e.details && typeof e.details === "object" ? e.details : null,
    })),
    nextCursor: rows.length > size ? String(new Date(page[page.length - 1].at).getTime()) : null,
    hasMore: rows.length > size,
  };
}

module.exports = {
  DEFAULT_LIMIT, MAX_LIMIT, DUE_SOON_WINDOW,
  withTxn, once, loadFile, loadPlan, planCalendar, planTemplate,
  deriveStatus, milestoneView, withSlip, planView, baselineView, fileAnchors,
  assertContext, str, isId, lower, boundedLimit, audit, outbox,
  instantiate, anchorContextFor, forecastAll,
  createPlan, getPlan, listMilestones, getDependencies, listBaselines, getBaseline,
  repropagate, settlePlanState, assertExpected, loadMilestone, assertReasonCode,
  DEPARTMENT_WORDS,
  approveBaseline, updateForecast, blockMilestone, unblockMilestone,
  completeMilestone, reopenMilestone,
  previewReschedule, listReschedules, approveReschedule, rejectReschedule,
  withdrawReschedule, writeBaselineRevision, reviseBaseline, rescheduleView, planHistory,
};
