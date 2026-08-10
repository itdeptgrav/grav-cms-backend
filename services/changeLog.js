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

"use strict";

const ChangeLog = require("../models/Access/ChangeLog");

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
    actorName: u.name || "",
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

/**
 * Record one change. Never throws, never blocks — see the note above.
 *
 * @param req      the request, for the actor
 * @param entry    { departmentSlug, entity, entityId, entityLabel, action,
 *                   summary, before, after }
 */
async function recordChange(req, entry = {}) {
  try {
    const { before, after } = entry;
    const d =
      before || after
        ? diff(before, after)
        : { before: undefined, after: undefined, changed: [] };

    // Nothing actually changed — an "update" that updated nothing is noise.
    if ((entry.action === "update" || !entry.action) && before && after && d.changed.length === 0) {
      return null;
    }

    return await ChangeLog.create({
      departmentSlug: entry.departmentSlug,
      entity: entry.entity,
      entityId: entry.entityId ? String(entry.entityId) : undefined,
      entityLabel: entry.entityLabel || "",
      action: entry.action || "update",
      summary: entry.summary || "",
      before: ChangeLog.sanitise(d.before),
      after: ChangeLog.sanitise(d.after),
      ...actorFrom(req),
    });
  } catch (err) {
    console.error("[change-log] could not record:", err.message);
    return null;
  }
}

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

module.exports = { recordChange, historyFor, historyForWithChildren, recentFor, diff, actorFrom };
