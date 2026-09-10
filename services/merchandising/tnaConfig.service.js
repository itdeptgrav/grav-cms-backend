// services/merchandising/tnaConfig.service.js
//
// THE PROCESS ITSELF — T&A templates, their versions, and working calendars.
//
// This is configuration, and it is deliberately not a navigation destination.
// A merchandiser does not open "settings" to do their job; an owner reaches
// this from Time & Action when the process needs changing, which is rare and
// deliberate.
//
// ── PUBLISHING IS THE ONE-WAY DOOR ──────────────────────────────────────────
// A draft version can be edited freely. Publishing validates the whole graph,
// closes the previous version's effective window, and freezes this one for
// ever. From then on, changing the process means publishing another version —
// and every plan already running keeps the version it was created with.
//
// That is the difference between a commitment and a suggestion: a baseline
// computed from version 6 must still be reproducible from version 6 in a
// year's time, and it cannot be if version 6 is still editable.
//
// ── AND SELECTION IS SCORED, NOT GUESSED ────────────────────────────────────
// Several versions may be published at once — a company default, a buyer's
// variation, a factory's. Resolution scores each by how specifically it
// matches the file and takes the highest. A TIE IS REFUSED, naming both: a
// process that depended on which version somebody happened to configure first
// would be unexplainable the first time it surprised anybody.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const {
  TnaTemplate, TnaTemplateVersion, VERSION_STATE,
  OWNER_DEPARTMENT, COMPLETION_AUTHORITY, ANCHOR, MILESTONE_SCOPE,
} = require("../../models/CMS_Models/Merchandising/TnaTemplate");
const {
  WorkingCalendar, WorkingCalendarVersion,
} = require("../../models/CMS_Models/Merchandising/WorkingCalendar");
const { TnaReasonCode } = require("../../models/CMS_Models/Merchandising/TnaPlan");
const graph = require("./tnaGraph");
const cal = require("./tnaCalendar");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function assertContext(ctx) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
}

const mintRef = (prefix, bytes = 5) => `${prefix}-${crypto.randomBytes(bytes).toString("hex")}`;

/* ═══ TEMPLATES ════════════════════════════════════════════════════════════ */

const templateView = (t) => ({
  id: str(t._id),
  templateRef: str(t.templateRef),
  name: str(t.name),
  description: str(t.description),
  isActive: t.isActive !== false,
  createdByName: str(t.createdBy?.name),
  createdAt: t.createdAt,
});

const milestoneView = (m) => ({
  milestoneCode: str(m.milestoneCode),
  name: str(m.name),
  ownerDepartment: str(m.ownerDepartment),
  completionAuthority: str(m.completionAuthority),
  sourceEventKinds: (m.sourceEventKinds || []).map(str),
  anchor: str(m.anchor),
  offsetWorkingDays: m.offsetWorkingDays ?? 0,
  scope: str(m.scope),
  criticalPathCandidate: m.criticalPathCandidate === true,
  sortOrder: m.sortOrder ?? 0,
});

const versionView = (v, { full = true } = {}) => ({
  id: str(v._id),
  templateId: str(v.templateId),
  versionNo: v.versionNo,
  state: str(v.state),
  effectiveFrom: v.effectiveFrom || null,
  effectiveTo: v.effectiveTo || null,
  selectors: {
    buyerRefs: (v.selectors?.buyerRefs || []).map(str),
    brandRefs: (v.selectors?.brandRefs || []).map(str),
    productCategoryRefs: (v.selectors?.productCategoryRefs || []).map(str),
    factoryRefs: (v.selectors?.factoryRefs || []).map(str),
  },
  milestoneCount: (v.milestones || []).length,
  dependencyCount: (v.dependencies || []).length,
  defaultCalendarId: v.defaultCalendarId ? str(v.defaultCalendarId) : null,
  publishedByName: str(v.publishedBy?.name),
  publishedAt: v.publishedAt || null,
  retiredAt: v.retiredAt || null,
  ...(full
    ? {
      milestones: (v.milestones || []).map(milestoneView),
      dependencies: (v.dependencies || []).map((d) => ({
        dependencyRef: str(d.dependencyRef),
        predecessorCode: str(d.predecessorCode),
        successorCode: str(d.successorCode),
        type: str(d.type),
        lagWorkingDays: d.lagWorkingDays ?? 0,
      })),
    }
    : {}),
});

async function listTemplates(ctx) {
  assertContext(ctx);
  const rows = await TnaTemplate.find({ companyId: ctx.companyId }).sort({ name: 1 }).lean();
  return { templates: rows.map(templateView) };
}

async function createTemplate(ctx, { body = {}, actor = null } = {}) {
  assertContext(ctx);
  const name = str(body.name);
  if (!name) throw fail("VALIDATION", "A template needs a name.", { field: "name" });
  const [doc] = await TnaTemplate.create([{
    companyId: ctx.companyId,
    templateRef: mintRef("TPL"),
    name,
    description: str(body.description).slice(0, 2000),
    createdBy: actor || undefined,
  }]);
  return { template: templateView(doc) };
}

async function loadTemplate(ctx, templateId) {
  assertContext(ctx);
  if (!isId(templateId)) throw fail("TNA_TEMPLATE_NOT_FOUND", "That template does not exist.");
  const t = await TnaTemplate.findOne({ _id: templateId, companyId: ctx.companyId });
  if (!t) throw fail("TNA_TEMPLATE_NOT_FOUND", "That template does not exist.");
  return t;
}

async function listVersions(ctx, { templateId } = {}) {
  const t = await loadTemplate(ctx, templateId);
  const rows = await TnaTemplateVersion
    .find({ companyId: ctx.companyId, templateId: t._id })
    .sort({ versionNo: -1 }).lean();
  return { template: templateView(t), versions: rows.map((v) => versionView(v, { full: false })) };
}

/* ── The shape a caller may state on a version ─────────────────────────── */

const VERSION_FIELDS = Object.freeze([
  "effectiveFrom", "selectors", "milestones", "dependencies", "defaultCalendarId",
]);
const MILESTONE_FIELDS = Object.freeze([
  "milestoneCode", "name", "ownerDepartment", "completionAuthority", "sourceEventKinds",
  "anchor", "offsetWorkingDays", "scope", "criticalPathCandidate", "sortOrder",
]);

/**
 * Fields that would let a template carry another department's operational
 * fact. A milestone says WHEN something must happen, never what it costs or
 * how much of it there is.
 */
const REFUSED_FIELDS = Object.freeze({
  assignee: "a person — a milestone is a date on an order, not somebody's task",
  assignedTo: "a person — a milestone is a date on an order, not somebody's task",
  owner: "a person — use ownerDepartment, which names the department",
  checklist: "a checklist — that is the Tasks app",
  subtasks: "subtasks — that is the Tasks app",
  reminder: "a reminder — that is a notification preference, not a company record",
  snooze: "a snooze — that is the Tasks app",
  todo: "a to-do — that is the Tasks app",
  rate: "a rate — Supply Chain owns it",
  cost: "a cost — Costing owns it",
  quantity: "a quantity — Product Development and Store own quantities",
  capacity: "capacity — PPC owns it",
  stock: "stock — Store owns it",
});

function assertShape(body, allowed, label) {
  for (const key of Object.keys(body || {})) {
    const refused = REFUSED_FIELDS[key];
    if (refused) {
      throw fail("FIELD_NOT_ACCEPTED", `${label} cannot carry ${refused}.`, { field: key });
    }
    if (!allowed.includes(key)) {
      throw fail("FIELD_NOT_ACCEPTED", `"${key}" is not part of ${label}.`, { field: key });
    }
  }
}

/**
 * Validate one milestone definition.
 *
 * ── THE PAIRING THAT IS REFUSED ────────────────────────────────────────────
 * A milestone owned by Quality with `completionAuthority: MERCHANDISING` would
 * let a merchandiser mark somebody else's inspection passed. That is the exact
 * fabrication the whole ownership model exists to prevent, so it is refused at
 * publish — where a person is looking — with the department named.
 */
function shapeMilestone(raw, index) {
  assertShape(raw, MILESTONE_FIELDS, "a milestone definition");

  const milestoneCode = str(raw.milestoneCode).toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{2,39}$/.test(milestoneCode)) {
    throw fail("VALIDATION",
      `Milestone ${index + 1} needs a code of A–Z, 0–9 and underscores, three characters or more.`,
      { field: "milestoneCode", index });
  }
  const name = str(raw.name);
  if (!name) throw fail("VALIDATION", `Milestone ${milestoneCode} needs a name.`, { field: "name", index });

  const ownerDepartment = str(raw.ownerDepartment).toUpperCase();
  if (!Object.values(OWNER_DEPARTMENT).includes(ownerDepartment)) {
    throw fail("VALIDATION",
      `Say which department owns ${milestoneCode}: ${Object.values(OWNER_DEPARTMENT).join(", ")}.`,
      { field: "ownerDepartment", index });
  }
  const completionAuthority = str(raw.completionAuthority).toUpperCase()
    || COMPLETION_AUTHORITY.SOURCE_EVENT;
  if (!Object.values(COMPLETION_AUTHORITY).includes(completionAuthority)) {
    throw fail("VALIDATION",
      `${milestoneCode} needs a completion authority of MERCHANDISING or SOURCE_EVENT.`,
      { field: "completionAuthority", index });
  }
  if (completionAuthority === COMPLETION_AUTHORITY.MERCHANDISING
    && ownerDepartment !== OWNER_DEPARTMENT.MERCHANDISING) {
    throw fail("VALIDATION",
      `${milestoneCode} is owned by ${ownerDepartment}, so Merchandising cannot be the one to mark it done. `
      + "Merchandising coordinates visibility; it cannot mark another department ready. "
      + "Use SOURCE_EVENT and name the event kinds that may complete it.",
      { field: "completionAuthority", index, ownerDepartment });
  }

  const anchor = str(raw.anchor).toUpperCase() || ANCHOR.PLAN_START;
  if (!Object.values(ANCHOR).includes(anchor)) {
    throw fail("VALIDATION", `${milestoneCode} needs a known anchor.`, { field: "anchor", index });
  }
  const offsetWorkingDays = Number(raw.offsetWorkingDays ?? 0);
  if (!Number.isInteger(offsetWorkingDays)) {
    throw fail("VALIDATION",
      `${milestoneCode}'s offset must be a whole number of working days.`,
      { field: "offsetWorkingDays", index });
  }
  const scope = str(raw.scope).toUpperCase() || MILESTONE_SCOPE.FILE;
  if (!Object.values(MILESTONE_SCOPE).includes(scope)) {
    throw fail("VALIDATION", `${milestoneCode} needs a known scope.`, { field: "scope", index });
  }

  return {
    milestoneCode, name, ownerDepartment, completionAuthority,
    sourceEventKinds: [...new Set((Array.isArray(raw.sourceEventKinds) ? raw.sourceEventKinds : [])
      .map(str).filter(Boolean))],
    anchor, offsetWorkingDays, scope,
    criticalPathCandidate: raw.criticalPathCandidate === true,
    sortOrder: Number(raw.sortOrder ?? index),
  };
}

function shapeVersionBody(body) {
  assertShape(body, VERSION_FIELDS, "a template version");

  const milestones = (Array.isArray(body.milestones) ? body.milestones : []).map(shapeMilestone);
  const codes = milestones.map((m) => m.milestoneCode);
  if (new Set(codes).size !== codes.length) {
    throw fail("VALIDATION", "Two milestones share one code.", { field: "milestones" });
  }

  const dependencies = (Array.isArray(body.dependencies) ? body.dependencies : []).map((d, i) => ({
    dependencyRef: str(d.dependencyRef) || mintRef("DEP", 4),
    predecessorCode: str(d.predecessorCode).toUpperCase(),
    successorCode: str(d.successorCode).toUpperCase(),
    type: "FINISH_TO_START",
    lagWorkingDays: Number(d.lagWorkingDays ?? 0),
    _index: i,
  })).map(({ _index, ...d }) => d);

  const out = { milestones, dependencies };
  if (body.effectiveFrom !== undefined) out.effectiveFrom = cal.assertDate(body.effectiveFrom, "effectiveFrom");
  if (body.defaultCalendarId !== undefined) {
    out.defaultCalendarId = isId(body.defaultCalendarId)
      ? new mongoose.Types.ObjectId(str(body.defaultCalendarId)) : null;
  }
  if (body.selectors !== undefined) {
    const s = body.selectors || {};
    out.selectors = {
      buyerRefs: (s.buyerRefs || []).map(str).filter(Boolean),
      brandRefs: (s.brandRefs || []).map(str).filter(Boolean),
      productCategoryRefs: (s.productCategoryRefs || []).map(str).filter(Boolean),
      factoryRefs: (s.factoryRefs || []).map(str).filter(Boolean),
    };
  }
  return out;
}

async function createVersion(ctx, { templateId, body = {}, actor = null } = {}) {
  const t = await loadTemplate(ctx, templateId);
  const shaped = shapeVersionBody(body);

  const existing = await TnaTemplateVersion.findOne({
    companyId: ctx.companyId, templateId: t._id, state: VERSION_STATE.DRAFT,
  }).lean();
  if (existing) {
    throw fail("TNA_STATE_CONFLICT",
      `Version ${existing.versionNo} is already an open draft. Publish or edit it.`,
      { versionNo: existing.versionNo });
  }
  const [highest] = await TnaTemplateVersion
    .find({ companyId: ctx.companyId, templateId: t._id }).sort({ versionNo: -1 }).limit(1).lean();

  const [doc] = await TnaTemplateVersion.create([{
    companyId: ctx.companyId,
    templateId: t._id,
    versionNo: (highest ? highest.versionNo : 0) + 1,
    state: VERSION_STATE.DRAFT,
    ...shaped,
    createdBy: actor || undefined,
  }]);
  return { version: versionView(doc) };
}

async function loadVersion(ctx, templateId, versionNo) {
  const t = await loadTemplate(ctx, templateId);
  const no = Number(versionNo);
  if (!Number.isInteger(no) || no < 1) {
    throw fail("TNA_TEMPLATE_NOT_FOUND", "That template version does not exist.");
  }
  const v = await TnaTemplateVersion.findOne({
    companyId: ctx.companyId, templateId: t._id, versionNo: no,
  });
  if (!v) throw fail("TNA_TEMPLATE_NOT_FOUND", "That template version does not exist.");
  return { template: t, version: v };
}

async function getVersion(ctx, { templateId, versionNo } = {}) {
  const { template, version } = await loadVersion(ctx, templateId, versionNo);
  return { template: templateView(template), version: versionView(version) };
}

async function updateVersion(ctx, { templateId, versionNo, body = {}, actor = null } = {}) {
  const { version } = await loadVersion(ctx, templateId, versionNo);
  if (version.state !== VERSION_STATE.DRAFT) {
    throw fail("TNA_TEMPLATE_IMMUTABLE",
      `Version ${version.versionNo} is ${version.state.toLowerCase()} and cannot be edited. `
      + "Publish a new version instead.",
      { versionNo: version.versionNo, state: version.state });
  }
  const shaped = shapeVersionBody(body);
  version.set(shaped);
  version.set("updatedBy", actor || undefined);
  await version.save();
  return { version: versionView(version) };
}

/**
 * PUBLISH — validate the whole graph, close the previous window, freeze.
 *
 * The graph is validated HERE as well as at baseline, because a configurer
 * fixing a cycle should learn about it while they are looking at the template,
 * not when a merchandiser tries to plan a file three weeks later.
 */
async function publishVersion(ctx, { templateId, versionNo, actor = null } = {}) {
  const { version } = await loadVersion(ctx, templateId, versionNo);
  if (version.state !== VERSION_STATE.DRAFT) {
    throw fail("TNA_STATE_CONFLICT", `Version ${version.versionNo} is already ${version.state.toLowerCase()}.`);
  }
  if (!(version.milestones || []).length) {
    throw fail("VALIDATION", "A template version needs at least one milestone before it can be published.");
  }
  if (!version.effectiveFrom) {
    throw fail("VALIDATION", "Say from which date this version applies.", { field: "effectiveFrom" });
  }
  /* Refuses a cycle, an unknown code, a self-edge and a duplicate pair — and
     names the loop rather than reporting "invalid graph". */
  graph.rank(version.milestones.map((m) => m.milestoneCode), version.dependencies);

  const now = new Date();
  const previous = await TnaTemplateVersion.findOne({
    companyId: ctx.companyId, templateId: version.templateId,
    state: VERSION_STATE.PUBLISHED, effectiveTo: null,
  });

  version.state = VERSION_STATE.PUBLISHED;
  version.publishedBy = actor || undefined;
  version.publishedAt = now;
  await version.save();

  /* ── CLOSING THE PREVIOUS WINDOW CHANGES NO PLAN ───────────────────────
     It changes which version a NEW plan resolves to, and nothing else. Every
     running plan pinned its version at creation. */
  if (previous && String(previous._id) !== String(version._id)) {
    previous.effectiveTo = version.effectiveFrom;
    await previous.save();
  }
  return { version: versionView(version), closedPreviousVersionNo: previous ? previous.versionNo : null };
}

async function retireVersion(ctx, { templateId, versionNo, actor = null } = {}) {
  const { version } = await loadVersion(ctx, templateId, versionNo);
  if (version.state !== VERSION_STATE.PUBLISHED) {
    throw fail("TNA_STATE_CONFLICT", "Only a published version can be retired.");
  }
  version.state = VERSION_STATE.RETIRED;
  version.retiredAt = new Date();
  await version.save();
  return { version: versionView(version), retiredBy: str(actor?.name) };
}

/* ═══ RESOLUTION ═══════════════════════════════════════════════════════════ */

/** How specifically a version matches a file. Empty selectors score zero. */
function scoreVersion(version, facts) {
  const s = version.selectors || {};
  const groups = [
    ["buyerRefs", facts.buyerRef],
    ["brandRefs", facts.brandRef],
    ["productCategoryRefs", facts.productCategoryRef],
    ["factoryRefs", facts.factoryRefs],
  ];
  let score = 0;
  for (const [key, value] of groups) {
    const list = (s[key] || []).map(str).filter(Boolean);
    if (!list.length) continue;                       // unstated: matches all
    const candidates = Array.isArray(value) ? value.map(str) : [str(value)];
    if (!candidates.some((c) => c && list.includes(c))) return null;   // stated and unmatched
    score += 1;
  }
  return score;
}

/**
 * Which template version a file would get on a date, and why.
 *
 * Returns every candidate with its score, because a merchandiser who cannot
 * see why a file got version 4 will assume the system is wrong.
 */
async function resolveTemplateVersion(ctx, { facts, onDate, templateId = null } = {}) {
  assertContext(ctx);
  const date = cal.assertDate(onDate, "onDate");

  const query = {
    companyId: ctx.companyId,
    state: VERSION_STATE.PUBLISHED,
    effectiveFrom: { $lte: date },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gt: date } }],
  };
  if (templateId) query.templateId = new mongoose.Types.ObjectId(str(templateId));

  const candidates = await TnaTemplateVersion.find(query).lean();
  const scored = candidates
    .map((v) => ({ version: v, score: scoreVersion(v, facts || {}) }))
    .filter((c) => c.score !== null);

  if (!scored.length) {
    throw fail("TNA_TEMPLATE_NOT_FOUND",
      `No published T&A template version applies to this file on ${date}. `
      + "Publish one, or widen an existing version's selectors.",
      { onDate: date, searched: { buyerRef: facts?.buyerRef, factoryRefs: facts?.factoryRefs } });
  }

  const best = Math.max(...scored.map((c) => c.score));
  const winners = scored.filter((c) => c.score === best);
  if (winners.length > 1) {
    throw fail("TNA_TEMPLATE_AMBIGUOUS",
      `Two template versions match this file equally well: `
      + winners.map((w) => `version ${w.version.versionNo}`).join(" and ")
      + ". Make one more specific — the process must not depend on which was configured first.",
      { candidates: winners.map((w) => ({ versionNo: w.version.versionNo, score: w.score })) },
    );
  }

  return {
    version: winners[0].version,
    score: best,
    candidates: scored
      .sort((a, b) => b.score - a.score)
      .map((c) => ({
        id: str(c.version._id),
        versionNo: c.version.versionNo,
        score: c.score,
        effectiveFrom: c.version.effectiveFrom,
        effectiveTo: c.version.effectiveTo || null,
        selected: String(c.version._id) === String(winners[0].version._id),
      })),
  };
}

/* ═══ CALENDARS ════════════════════════════════════════════════════════════ */

const calendarView = (c) => ({
  id: str(c._id),
  calendarRef: str(c.calendarRef),
  name: str(c.name),
  timezone: str(c.timezone),
  isActive: c.isActive !== false,
});

const calendarVersionView = (v, { full = true } = {}) => ({
  id: str(v._id),
  calendarId: str(v.calendarId),
  versionNo: v.versionNo,
  state: str(v.state),
  effectiveFrom: v.effectiveFrom || null,
  effectiveTo: v.effectiveTo || null,
  horizonTo: v.horizonTo || null,
  weekPattern: (v.weekPattern || []).map(Boolean),
  exceptionCount: (v.exceptions || []).length,
  publishedAt: v.publishedAt || null,
  ...(full
    ? {
      exceptions: (v.exceptions || []).map((e) => ({
        date: e.date, working: e.working === true, reason: str(e.reason),
      })),
    }
    : {}),
});

async function listCalendars(ctx) {
  assertContext(ctx);
  const rows = await WorkingCalendar.find({ companyId: ctx.companyId }).sort({ name: 1 }).lean();
  return { calendars: rows.map(calendarView) };
}

async function createCalendar(ctx, { body = {}, actor = null } = {}) {
  assertContext(ctx);
  const name = str(body.name);
  if (!name) throw fail("VALIDATION", "A working calendar needs a name.", { field: "name" });
  const timezone = str(body.timezone) || "Asia/Kolkata";
  if (!cal.isKnownTimezone(timezone)) {
    throw fail("VALIDATION",
      `"${timezone}" is not a timezone this system recognises. Use an IANA name such as Asia/Kolkata.`,
      { field: "timezone" });
  }
  const [doc] = await WorkingCalendar.create([{
    companyId: ctx.companyId, calendarRef: mintRef("CAL"), name, timezone,
    createdBy: actor || undefined,
  }]);
  return { calendar: calendarView(doc) };
}

async function loadCalendar(ctx, calendarId) {
  assertContext(ctx);
  if (!isId(calendarId)) throw fail("NOT_FOUND", "That working calendar does not exist.");
  const c = await WorkingCalendar.findOne({ _id: calendarId, companyId: ctx.companyId });
  if (!c) throw fail("NOT_FOUND", "That working calendar does not exist.");
  return c;
}

async function listCalendarVersions(ctx, { calendarId } = {}) {
  const c = await loadCalendar(ctx, calendarId);
  const rows = await WorkingCalendarVersion
    .find({ companyId: ctx.companyId, calendarId: c._id }).sort({ versionNo: -1 }).lean();
  return { calendar: calendarView(c), versions: rows.map((v) => calendarVersionView(v, { full: false })) };
}

const CALENDAR_VERSION_FIELDS = Object.freeze([
  "effectiveFrom", "weekPattern", "exceptions", "horizonTo",
]);

function shapeCalendarBody(body) {
  assertShape(body, CALENDAR_VERSION_FIELDS, "a working calendar version");
  const out = {};
  if (body.effectiveFrom !== undefined) out.effectiveFrom = cal.assertDate(body.effectiveFrom, "effectiveFrom");
  if (body.horizonTo !== undefined) out.horizonTo = cal.assertDate(body.horizonTo, "horizonTo");
  if (body.weekPattern !== undefined) {
    const week = Array.isArray(body.weekPattern) ? body.weekPattern.map(Boolean) : [];
    if (week.length !== 7) {
      throw fail("VALIDATION", "A week pattern has seven days, Monday first.", { field: "weekPattern" });
    }
    if (!week.some(Boolean)) {
      throw fail("VALIDATION", "A working calendar needs at least one working day.", { field: "weekPattern" });
    }
    out.weekPattern = week;
  }
  if (body.exceptions !== undefined) {
    const seen = new Set();
    out.exceptions = (Array.isArray(body.exceptions) ? body.exceptions : []).map((e, i) => {
      const date = cal.assertDate(e?.date, "exceptions.date");
      if (seen.has(date)) {
        throw fail("VALIDATION", `${date} is listed twice in the exceptions.`, { field: "exceptions", index: i });
      }
      seen.add(date);
      if (typeof e.working !== "boolean") {
        throw fail("VALIDATION",
          `Say whether ${date} is worked or not — an exception works in both directions.`,
          { field: "exceptions.working", index: i });
      }
      return { date, working: e.working, reason: str(e.reason).slice(0, 200) };
    });
  }
  return out;
}

async function createCalendarVersion(ctx, { calendarId, body = {}, actor = null } = {}) {
  const c = await loadCalendar(ctx, calendarId);
  const shaped = shapeCalendarBody(body);
  const open = await WorkingCalendarVersion.findOne({
    companyId: ctx.companyId, calendarId: c._id, state: VERSION_STATE.DRAFT,
  }).lean();
  if (open) {
    throw fail("TNA_STATE_CONFLICT",
      `Version ${open.versionNo} is already an open draft.`, { versionNo: open.versionNo });
  }
  const [highest] = await WorkingCalendarVersion
    .find({ companyId: ctx.companyId, calendarId: c._id }).sort({ versionNo: -1 }).limit(1).lean();
  const [doc] = await WorkingCalendarVersion.create([{
    companyId: ctx.companyId, calendarId: c._id,
    versionNo: (highest ? highest.versionNo : 0) + 1,
    state: VERSION_STATE.DRAFT,
    ...shaped,
    createdBy: actor || undefined,
  }]);
  return { version: calendarVersionView(doc) };
}

async function loadCalendarVersion(ctx, calendarId, versionNo) {
  const c = await loadCalendar(ctx, calendarId);
  const no = Number(versionNo);
  const v = await WorkingCalendarVersion.findOne({
    companyId: ctx.companyId, calendarId: c._id, versionNo: no,
  });
  if (!v) throw fail("NOT_FOUND", "That calendar version does not exist.");
  return { calendar: c, version: v };
}

async function updateCalendarVersion(ctx, { calendarId, versionNo, body = {} } = {}) {
  const { version } = await loadCalendarVersion(ctx, calendarId, versionNo);
  if (version.state !== VERSION_STATE.DRAFT) {
    throw fail("TNA_TEMPLATE_IMMUTABLE",
      `Calendar version ${version.versionNo} is published and cannot be edited. `
      + "A holiday added now must not move a baseline computed in March — publish a new version.",
      { versionNo: version.versionNo });
  }
  version.set(shapeCalendarBody(body));
  await version.save();
  return { version: calendarVersionView(version) };
}

async function publishCalendarVersion(ctx, { calendarId, versionNo, actor = null } = {}) {
  const { version } = await loadCalendarVersion(ctx, calendarId, versionNo);
  if (version.state !== VERSION_STATE.DRAFT) {
    throw fail("TNA_STATE_CONFLICT", `Version ${version.versionNo} is already ${version.state.toLowerCase()}.`);
  }
  if (!version.effectiveFrom) {
    throw fail("VALIDATION", "Say from which date this calendar applies.", { field: "effectiveFrom" });
  }
  if (!version.horizonTo) {
    throw fail("VALIDATION",
      "Say the last date this calendar can answer for. Without a horizon it would quietly "
      + "assume this company's holidays are known for ever.",
      { field: "horizonTo" });
  }
  if (version.horizonTo <= version.effectiveFrom) {
    throw fail("VALIDATION", "The horizon must be after the date the calendar starts applying.",
      { field: "horizonTo" });
  }

  const previous = await WorkingCalendarVersion.findOne({
    companyId: ctx.companyId, calendarId: version.calendarId,
    state: VERSION_STATE.PUBLISHED, effectiveTo: null,
  });
  version.state = VERSION_STATE.PUBLISHED;
  version.publishedBy = actor || undefined;
  version.publishedAt = new Date();
  await version.save();
  if (previous && String(previous._id) !== String(version._id)) {
    previous.effectiveTo = version.effectiveFrom;
    await previous.save();
  }
  return { version: calendarVersionView(version) };
}

/** The resolved day-by-day answer — the only honest way to check a calendar. */
async function workingDays(ctx, { calendarId, versionNo, from, to } = {}) {
  const { calendar, version } = await loadCalendarVersion(ctx, calendarId, versionNo);
  return {
    calendar: calendarView(calendar),
    versionNo: version.versionNo,
    days: cal.explainRange(from, to, version),
  };
}

/** The published calendar version in force on a date. */
async function resolveCalendarVersion(ctx, { calendarId, onDate } = {}) {
  assertContext(ctx);
  const date = cal.assertDate(onDate, "onDate");
  const query = {
    companyId: ctx.companyId,
    state: VERSION_STATE.PUBLISHED,
    effectiveFrom: { $lte: date },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gt: date } }],
  };
  if (calendarId) query.calendarId = new mongoose.Types.ObjectId(str(calendarId));
  const rows = await WorkingCalendarVersion.find(query).sort({ effectiveFrom: -1 }).limit(2).lean();
  if (!rows.length) {
    throw fail("TNA_TEMPLATE_NOT_FOUND",
      `No published working calendar applies on ${date}. Publish one before planning.`,
      { onDate: date });
  }
  return rows[0];
}

/* ═══ REASON CODES ═════════════════════════════════════════════════════════ */

async function listReasonCodes(ctx, { kind } = {}) {
  assertContext(ctx);
  const query = { companyId: ctx.companyId, isActive: true };
  if (str(kind)) query.kind = str(kind).toUpperCase();
  const rows = await TnaReasonCode.find(query).sort({ kind: 1, label: 1 }).lean();
  return {
    reasonCodes: rows.map((r) => ({
      code: str(r.code), label: str(r.label), kind: str(r.kind),
    })),
  };
}

async function upsertReasonCode(ctx, { body = {} } = {}) {
  assertContext(ctx);
  const code = str(body.code).toUpperCase();
  const label = str(body.label);
  const kind = str(body.kind).toUpperCase();
  if (!code || !label) throw fail("VALIDATION", "A reason code needs a code and a label.", { field: "code" });
  if (!["BLOCK", "RESCHEDULE"].includes(kind)) {
    throw fail("VALIDATION", "A reason code is for BLOCK or RESCHEDULE.", { field: "kind" });
  }
  const doc = await TnaReasonCode.findOneAndUpdate(
    { companyId: ctx.companyId, code, kind },
    { $set: { label, isActive: body.isActive !== false } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
  return { reasonCode: { code: str(doc.code), label: str(doc.label), kind: str(doc.kind) } };
}

module.exports = {
  DEFAULT_LIMIT, MAX_LIMIT, VERSION_FIELDS, MILESTONE_FIELDS, REFUSED_FIELDS,
  templateView, versionView, calendarView, calendarVersionView,
  listTemplates, createTemplate, listVersions, createVersion, getVersion,
  updateVersion, publishVersion, retireVersion,
  scoreVersion, resolveTemplateVersion,
  listCalendars, createCalendar, listCalendarVersions, createCalendarVersion,
  updateCalendarVersion, publishCalendarVersion, workingDays, resolveCalendarVersion,
  listReasonCodes, upsertReasonCode,
};
