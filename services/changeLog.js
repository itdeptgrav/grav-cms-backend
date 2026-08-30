// services/changeLog.js
//
// Recording who changed what, from anywhere.
//
// Two things matter about how this is used, and both are why it is a helper
// rather than a mongoose middleware:
//
// 1. IT MUST NEVER BREAK THE THING IT IS LOGGING. Every write here is wrapped
//    and swallowed. A failed log entry is a gap in history; a failed save
//    because the log failed is lost work. The gap is the better outcome and it
//    is a deliberate trade.
//
// 2. IT NEEDS THE ACTOR, which only the request knows. A model hook sees the
//    document and not the person, so a hook-based log can only ever say what
//    changed — which is the half we already had.
//
// WHAT WAS ADDED FOR PER-PAGE HISTORY
// -----------------------------------
// The original version stored a shallow patch and a summary the caller wrote by
// hand. Two things were missing for a history a person can actually read:
//
//   * a DEEP diff. A shallow one reports `punches` as "an array changed to a
//     different array", which is not an answer. `fieldDiff` walks into objects
//     and arrays and reports `punches.1.inTime: 09:14 → 09:02`.
//   * ATTRIBUTION FOR HELD CHANGES. When an editor's write is approved it is
//     replayed by services/changeRequests over loopback, as the editor. That
//     replay carries the approver in headers, so the entry it writes can say
//     "changed by the editor, approved by the owner" — otherwise the approval
//     is invisible in the history and the two roles collapse into one name.
//
// `diff()` and the shallow `before`/`after` fields are deliberately UNCHANGED:
// the CRM writes ~170 entries through them and the existing readers index into
// `after[key]` directly. The deep detail is additive, in `fields[]`.

"use strict";

const ChangeLog = require("../models/Access/ChangeLog");
const { sectionLabel, fieldLabel } = require("./auditSections");

/**
 * Who is making this request, from whichever middleware populated it.
 *
 * The identity lands on `req` under different names depending on the path a
 * request came in by — the CMS guard, the accounting org guard, or the legacy
 * accountant guard. Reading all of them here keeps every caller from having to
 * know which one applies to its own route.
 */
function actorFrom(req) {
  const u = req?.user || req?.admin || req?.dept || {};
  return {
    actorId: u._id || u.id || undefined,
    actorName: u.name || [u.firstName, u.lastName].filter(Boolean).join(" ") || "",
    actorEmail: u.email || "",
    actorRole: u.role || u.departmentRole || "",
  };
}

/**
 * Only the fields that actually differ. Passing whole documents produces a log
 * nobody reads; passing the diff produces one that answers a question.
 */
function diff(before = {}, after = {}) {
  const changedBefore = {};
  const changedAfter = {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    const a = before?.[k];
    const b = after?.[k];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    changedBefore[k] = a;
    changedAfter[k] = b;
  }
  return { before: changedBefore, after: changedAfter, changed: Object.keys(changedAfter) };
}

/* ------------------------------------------------------------------ */
/* Deep diff                                                           */
/* ------------------------------------------------------------------ */

/** Values a diff should treat as "nothing was there". */
function isBlank(v) {
  return v === undefined || v === null || v === "";
}

/**
 * Compare as the database would, not as JavaScript does.
 *
 * An ObjectId and its string, a Date and its ISO string, and 5 and "5" are all
 * the same value as far as the person reading the history is concerned — and
 * mongoose hands back whichever it feels like depending on whether the document
 * came from `.lean()`. Reporting those as changes would fill every entry with
 * edits that never happened, which is the fastest way to make a history useless.
 */
function sameValue(a, b) {
  if (a === b) return true;
  if (isBlank(a) && isBlank(b)) return true;
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : new Date(a).getTime();
    const tb = b instanceof Date ? b.getTime() : new Date(b).getTime();
    if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta === tb;
  }
  if (a && b && typeof a === "object" && typeof b === "object") return false;
  return String(a) === String(b);
}

/** Depth cap: below this a value is reported whole rather than walked into. */
const MAX_DEPTH = 4;
/** Beyond this many changed fields the entry stops being readable anyway. */
const MAX_FIELDS = 120;

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
}

/**
 * Every leaf that differs, as dotted paths.
 *
 * Arrays are compared BY INDEX. Comparing them as sets would be smarter for a
 * reordered list, but wrong for the lists this actually sees: punches, salary
 * components and leave entitlements are positional, and "row 2's in-time moved"
 * is the truth an index comparison tells.
 */
function fieldDiff(before, after, { prefix = "", depth = 0, out = [] } = {}) {
  if (out.length >= MAX_FIELDS) return out;

  const bothObjects =
    depth < MAX_DEPTH &&
    ((isPlainObject(before) || isPlainObject(after)) ||
      (Array.isArray(before) || Array.isArray(after)));

  if (bothObjects) {
    if (Array.isArray(before) || Array.isArray(after)) {
      const a = Array.isArray(before) ? before : [];
      const b = Array.isArray(after) ? after : [];
      const len = Math.max(a.length, b.length);
      for (let i = 0; i < len && out.length < MAX_FIELDS; i += 1) {
        fieldDiff(a[i], b[i], { prefix: prefix ? `${prefix}.${i}` : String(i), depth: depth + 1, out });
      }
      return out;
    }

    const a = isPlainObject(before) ? before : {};
    const b = isPlainObject(after) ? after : {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (out.length >= MAX_FIELDS) break;
      fieldDiff(a[k], b[k], { prefix: prefix ? `${prefix}.${k}` : k, depth: depth + 1, out });
    }
    return out;
  }

  if (sameValue(before, after)) return out;

  out.push({
    path: prefix || "value",
    from: before,
    to: after,
    kind: isBlank(before) ? "added" : isBlank(after) ? "removed" : "changed",
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Writing the summary                                                 */
/* ------------------------------------------------------------------ */

const ACTION_VERB = {
  create: "Created",
  update: "Updated",
  delete: "Deleted",
  approve: "Approved",
  reject: "Rejected",
  import: "Imported",
  export: "Exported",
  other: "Changed",
};

/** A value as it should read inside a sentence. */
function fmt(v) {
  if (v === undefined || v === null || v === "") return "empty";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const s = JSON.stringify(v);
    return s.length > 60 ? `${s.slice(0, 60)}…` : s;
  }
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/.test(s)) return s.slice(0, 10);
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

/**
 * The sentence shown in the history list.
 *
 * Written from the diff rather than by the caller because a hand-written
 * summary drifts the moment the route changes what it saves, and a summary that
 * disagrees with the fields underneath it is worse than none. Callers may still
 * pass their own when they know something the diff cannot see ("Approved 4
 * pending regularisations"), and that one wins.
 */
function buildSummary({ action, entity, entityLabel, fields, section }) {
  const verb = ACTION_VERB[action] || ACTION_VERB.other;
  const what = [entity, entityLabel && `“${entityLabel}”`].filter(Boolean).join(" ");
  const head = what ? `${verb} ${what}` : verb;

  if (!fields || fields.length === 0) return head;
  if (action === "create") {
    return `${head} with ${fields.length} field${fields.length === 1 ? "" : "s"} set`;
  }
  if (action === "delete") return head;

  // Three named changes, then a count. Naming all of them turns a bulk save
  // into a paragraph nobody reads, and the full list is one click away in the
  // entry itself.
  const named = fields.slice(0, 3).map((f) => {
    const label = f.label || fieldLabel(section, f.path);
    if (f.kind === "added") return `${label} set to ${fmt(f.to)}`;
    if (f.kind === "removed") return `${label} cleared (was ${fmt(f.from)})`;
    return `${label} ${fmt(f.from)} → ${fmt(f.to)}`;
  });
  const rest = fields.length - named.length;
  return `${head}: ${named.join("; ")}${rest > 0 ? ` and ${rest} more change${rest === 1 ? "" : "s"}` : ""}`;
}

/* ------------------------------------------------------------------ */
/* Approval attribution                                                */
/* ------------------------------------------------------------------ */

/**
 * Headers set by services/changeRequests on an approved replay.
 *
 * Read here rather than passed by each route because the route has no idea it
 * is being replayed — that is the point of the loopback design. Every route
 * that logs a change therefore gets approval attribution for free, and one that
 * is added later gets it without anybody remembering to wire it.
 */
function approvalFrom(req) {
  const h = req?.headers || {};
  const id = h["x-grav-change-request"];
  if (!id) return null;
  return {
    changeRequestId: String(id),
    approvedById: String(h["x-grav-approver-id"] || ""),
    approvedByName: String(h["x-grav-approver-name"] || ""),
    approvedByEmail: String(h["x-grav-approver-email"] || ""),
    approvedAt: new Date(),
    decisionNote: String(h["x-grav-decision-note"] || ""),
  };
}

/* ------------------------------------------------------------------ */
/* Recording                                                           */
/* ------------------------------------------------------------------ */

/**
 * Record one change. Never throws, never blocks — see the note at the top.
 *
 * @param req      the request, for the actor and for approval headers
 * @param entry    { departmentSlug, section, entity, entityId, entityLabel,
 *                   action, summary, before, after, fields, origin, note }
 *
 * `fields` may be passed explicitly by a caller that knows the change better
 * than a diff can — a bulk approval, say, where before/after are per-row and
 * the meaningful record is "these 12 rows, this decision". Otherwise it is
 * derived from before/after.
 */
async function recordChange(req, entry = {}) {
  try {
    // Tells Middlewear/auditTrail to stand down for this request. Set on the
    // CALL, not on a successful write: a route that looked at the change and
    // decided nothing happened has made a judgement the fallback cannot
    // improve on, and letting the net fire anyway would append "updated 5
    // fields" underneath a deliberate silence.
    if (req && typeof req === "object") req.__auditLogged = true;

    const { before, after, section } = entry;
    const d =
      before || after
        ? diff(before, after)
        : { before: undefined, after: undefined, changed: [] };

    const deep = Array.isArray(entry.fields)
      ? entry.fields
      : before || after
        ? fieldDiff(before, after)
        : [];

    // Nothing actually changed — an "update" that updated nothing is noise.
    // Checked against the DEEP diff: a shallow comparison of two objects that
    // are equal field-for-field but not identical references reports a change
    // that did not happen, and those were the entries making the log unreadable.
    if (
      (entry.action === "update" || !entry.action) &&
      before &&
      after &&
      deep.length === 0 &&
      !entry.summary
    ) {
      return null;
    }

    const fields = deep.slice(0, MAX_FIELDS).map((f) => ({
      path: f.path,
      label: f.label || fieldLabel(section, f.path),
      from: ChangeLog.sanitiseValue(f.path, f.from),
      to: ChangeLog.sanitiseValue(f.path, f.to),
      kind: f.kind || "changed",
    }));

    const approval = approvalFrom(req);

    return await ChangeLog.create({
      departmentSlug: entry.departmentSlug,
      section: section || "",
      sectionLabel: entry.sectionLabel || (section ? sectionLabel(section) : ""),
      entity: entry.entity,
      entityId: entry.entityId ? String(entry.entityId) : undefined,
      entityLabel: entry.entityLabel || "",
      action: entry.action || "update",
      summary:
        entry.summary ||
        buildSummary({
          action: entry.action || "update",
          entity: entry.entity,
          entityLabel: entry.entityLabel,
          fields,
          section,
        }),
      before: ChangeLog.sanitise(d.before),
      after: ChangeLog.sanitise(d.after),
      fields,
      origin: entry.origin || (approval ? "approval" : "direct"),
      requestMethod: req?.method || "",
      requestPath: req?.originalUrl || req?.url || "",
      ...actorFrom(req),
      ...(approval || {}),
    });
  } catch (err) {
    console.error("[change-log] could not record:", err.message);
    return null;
  }
}

/**
 * A recorder with the department and section already filled in.
 *
 *   const audit = auditFor(req, { departmentSlug: "hr", section: "hr:leaves" });
 *   await audit({ entity: "leave", entityId: id, action: "approve", ... });
 *
 * Exists because the alternative — repeating two constants in every one of the
 * ninety-odd HR write handlers — is exactly the kind of repetition that ends
 * with half of them filed under the wrong section.
 */
function auditFor(req, defaults = {}) {
  return (entry) => recordChange(req, { ...defaults, ...entry });
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/** History for one record, newest first. */
async function historyFor(entity, entityId, limit = 50) {
  return ChangeLog.find({ entity, entityId: String(entityId) })
    .sort({ createdAt: -1 })
    .limit(Math.min(limit, 200))
    .lean();
}

/** Recent activity in one department. */
async function recentFor(departmentSlug, limit = 50) {
  return ChangeLog.find({ departmentSlug })
    .sort({ createdAt: -1 })
    .limit(Math.min(limit, 200))
    .lean();
}

/**
 * The query behind every history view: one page's entries, filtered.
 *
 * Returns a page plus the total, because a history without a count cannot tell
 * the reader whether they are looking at everything or at the first fifty of
 * four thousand — and that distinction is the difference between "nothing was
 * changed" and "nothing was changed recently".
 */
async function listChanges({
  departmentSlug,
  section,
  sections,
  entity,
  entityId,
  entityIds,
  action,
  actorEmail,
  origin,
  from,
  to,
  q,
  page = 1,
  limit = 50,
} = {}) {
  const filter = {};
  if (departmentSlug) filter.departmentSlug = String(departmentSlug).toLowerCase();
  if (section) filter.section = section;
  else if (Array.isArray(sections) && sections.length) filter.section = { $in: sections };
  if (entity) filter.entity = entity;
  if (entityId) filter.entityId = String(entityId);
  else if (Array.isArray(entityIds) && entityIds.length) {
    filter.entityId = { $in: entityIds.map(String) };
  }
  if (action) filter.action = Array.isArray(action) ? { $in: action } : action;
  if (actorEmail) filter.actorEmail = String(actorEmail).toLowerCase();
  if (origin) filter.origin = origin;

  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to) {
      // An inclusive end date: "to 2026-08-30" means the whole of the 30th, not
      // its first instant, which is what a bare date parses to.
      const end = new Date(to);
      if (!Number.isNaN(end.getTime()) && String(to).length <= 10) {
        end.setHours(23, 59, 59, 999);
      }
      filter.createdAt.$lte = end;
    }
  }

  if (q) {
    // Escaped: an operator typed into a search box must not become part of the
    // pattern — "(" alone would otherwise throw and the page would show an error
    // rather than no results.
    const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [
      { entityLabel: rx },
      { summary: rx },
      { actorName: rx },
      { actorEmail: rx },
      { approvedByName: rx },
      { "fields.label": rx },
    ];
  }

  const perPage = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * perPage;

  const [items, total] = await Promise.all([
    ChangeLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(perPage).lean(),
    ChangeLog.countDocuments(filter),
  ]);

  return { items, total, page: Math.max(Number(page) || 1, 1), limit: perPage };
}

/**
 * History for a PARENT record plus everything logged against its children —
 * e.g. an account's own field edits AND the contacts/sites/relationships/team/
 * activities created or changed underneath it. Those sub-entity log rows don't
 * carry the parent's id as `entityId` (that's the sub-record's own id), so the
 * parent id is matched inside the stored `before`/`after` snapshot instead —
 * both as a string and as an ObjectId, since Mixed fields don't auto-cast.
 *
 * @param {string} parentEntity        e.g. "crm-account"
 * @param {string} parentId
 * @param {string[]} childEntities     e.g. ["crm-contact", "crm-site", ...]
 * @param {string|string[]} parentKeys the field name(s) on the child that hold
 *                                      the parent id — most children use one
 *                                      key ("accountId"), but a relationship
 *                                      is symmetric and needs to match on
 *                                      either "fromAccountId" or "toAccountId".
 */
async function historyForWithChildren(parentEntity, parentId, childEntities, parentKeys, limit = 100) {
  const mongoose = require("mongoose");
  let oid = null;
  try { oid = new mongoose.Types.ObjectId(parentId); } catch { /* not a valid ObjectId string */ }

  const parentMatch = { entity: parentEntity, entityId: String(parentId) };
  const keys = Array.isArray(parentKeys) ? parentKeys : [parentKeys];
  const childKeyMatches = [];
  for (const key of keys) {
    childKeyMatches.push({ [`after.${key}`]: String(parentId) }, { [`before.${key}`]: String(parentId) });
    if (oid) childKeyMatches.push({ [`after.${key}`]: oid }, { [`before.${key}`]: oid });
  }
  const childMatch = { entity: { $in: childEntities }, $or: childKeyMatches };

  return ChangeLog.find({ $or: [parentMatch, childMatch] })
    .sort({ createdAt: -1 })
    .limit(Math.min(limit, 200))
    .lean();
}

module.exports = {
  recordChange,
  auditFor,
  historyFor,
  historyForWithChildren,
  recentFor,
  listChanges,
  diff,
  fieldDiff,
  actorFrom,
  buildSummary,
};
