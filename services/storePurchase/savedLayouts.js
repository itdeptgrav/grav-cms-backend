// services/storePurchase/savedLayouts.js
//
// A WAREHOUSE CAN HOLD MORE THAN ONE LAYOUT (30 Sep 2026).
//
// The store map always had exactly one arrangement: the room in `floorPlan`
// (outline, walls, doors, entrance, grid) and each root location's position
// in its own `layout`. The Store asked for a way to start a NEW layout and to
// switch between it and the previous one.
//
// ── THE LIVE LAYOUT STAYS WHERE IT ALWAYS WAS ──────────────────────────────
// Everything that reads the map — the 3D room, the walkthrough, the locator's
// "Open in 3D", world boxes, the dashboard's "unplaced" figure — reads
// `floorPlan` and `locations[].layout`. So the ACTIVE layout keeps living
// there, untouched in shape, and nothing downstream had to learn about
// layouts at all. The other layouts are SNAPSHOTS in `warehouse.layouts[]`:
// a copy of the plan and of every root location's position.
//
// Switching is therefore a swap, in ONE document update under the layout
// version: the live arrangement is copied into its own entry, the target's
// copy is written back as live, and `floorPlan.activeLayoutId` names it. The
// swap is what "switching makes it live" means — the Store chose that.
//
// ── ONLY ROOT LOCATIONS ARE ARRANGED ───────────────────────────────────────
// A shelf's position is RELATIVE to its rack, set by the rack wizard; it is
// the rack's construction, not the room's arrangement. A layout therefore
// stores and restores roots only, and a rack's shelves follow it wherever
// a layout puts it.
//
// ── A ROOT A LAYOUT DOES NOT MENTION IS NOT ON IT ──────────────────────────
// A rack created while layout B was live has no position in layout A. Rather
// than invent one, it comes back `placed: false` — the flag that has always
// meant "never positioned by anybody" — and the map lists it as not on this
// layout. Its size is kept, so placing it later needs no re-entry.
//
// ── A NEW LAYOUT IS A BLANK ROOM ───────────────────────────────────────────
// No outline, no walls, no doors, no entrance, and every root unplaced. The
// height and the grid are kept: they describe the building and the builder's
// habit, not an arrangement.
//
// No I/O here. The route reads the warehouse, asks this module for the
// update, and writes it guarded; `savedLayouts.test.js` covers the rules.
"use strict";

const mongoose = require("mongoose");
const { fail } = require("./errors");

const MAX_LAYOUTS = 20;
const NAME_MAX = 60;
const ORIGINAL_NAME = "Original layout";
/* The parts of `floorPlan` that ARE the arrangement. Not the version stamps,
   not `activeLayoutId` — those describe the live slot, not what is in it. */
const PLAN_FIELDS = Object.freeze(["room", "widthCm", "depthCm", "heightCm", "gridCm", "walls", "fixtures", "entranceId", "notes"]);
const LAYOUT_KEYS = Object.freeze(["x", "y", "z", "w", "h", "d", "rotation", "color", "placed"]);

const idOf = (v) => (v === null || v === undefined ? "" : String(v));
const isRoot = (l) => l && !l.parent && l.status !== "Archived";
const mintId = () => new mongoose.Types.ObjectId();
const clean = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** A location's layout with only the arrangement keys it actually carries. */
function pickLayout(layout) {
  const out = {};
  if (!layout || typeof layout !== "object") return out;
  for (const k of LAYOUT_KEYS) if (layout[k] !== undefined && layout[k] !== null) out[k] = layout[k];
  return out;
}

/** The arrangement parts of a floor plan, copied. */
function planOf(floorPlan) {
  const fp = floorPlan || {};
  const out = {};
  for (const k of PLAN_FIELDS) if (fp[k] !== undefined) out[k] = clean(fp[k]);
  return out;
}

/** An empty room: the building's height and the builder's grid, nothing else. */
function blankPlan(floorPlan) {
  const fp = floorPlan || {};
  const heightCm = Number(fp.room?.heightCm) || Number(fp.heightCm) || 300;
  return {
    room: { shape: "RECTANGLE", points: [], heightCm },
    widthCm: 0,
    depthCm: 0,
    heightCm,
    gridCm: Number(fp.gridCm) || 25,
    walls: [],
    fixtures: [],
    entranceId: "",
    notes: "",
  };
}

/** What the live slot holds right now, as a snapshot a layout entry can keep.
    `placed` is written as the map READ it — only an explicit false is off the
    plan — because a record older than the flag carries none, and a snapshot
    without it would be restored under the blank layout's `false`. */
function snapshotOf(w) {
  return {
    floorPlan: planOf(w?.floorPlan),
    positions: (w?.locations || []).filter(isRoot).map((l) => ({ locationId: l._id, layout: { ...pickLayout(l.layout), placed: l.layout?.placed !== false } })),
  };
}

const activeIdOf = (w) => idOf(w?.floorPlan?.activeLayoutId);

/** How many roots a layout puts on the floor — live for the active one. */
function placedCount(w, entry, active) {
  const roots = (w?.locations || []).filter(isRoot);
  if (active) return roots.filter((l) => l.layout?.placed).length;
  const alive = new Set(roots.map((l) => idOf(l._id)));
  return (entry?.positions || []).filter((p) => alive.has(idOf(p.locationId)) && p.layout?.placed).length;
}

/**
 * The layouts a page can offer, active one flagged. A warehouse that has never
 * had a second layout has no entries on disk; it is offered as one implicit
 * layout (id "") so the list is never empty and nothing needed a migration.
 */
function listOf(w) {
  const saved = Array.isArray(w?.layouts) ? w.layouts : [];
  const activeId = activeIdOf(w);
  if (!saved.length || !saved.some((s) => idOf(s._id) === activeId)) {
    const implicit = { id: "", name: ORIGINAL_NAME, active: true, saved: false, placed: placedCount(w, null, true), createdAt: null, activatedAt: null };
    return [implicit, ...saved.map((s) => rowOf(w, s, false))];
  }
  return saved.map((s) => rowOf(w, s, idOf(s._id) === activeId));
}
const rowOf = (w, s, active) => ({ id: idOf(s._id), name: s.name, active, saved: true, placed: placedCount(w, s, active), createdAt: s.createdAt || null, activatedAt: s.activatedAt || null });

/** A layout name: required, one line, at most 60 characters, unique in the warehouse. */
function validateName(raw, others = [], field = "name") {
  const name = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!name) throw fail("VALIDATION", "Give the layout a name.", { reason: "LAYOUT_NAME_REQUIRED", field });
  if (name.length > NAME_MAX) throw fail("VALIDATION", `A layout name is at most ${NAME_MAX} characters.`, { reason: "LAYOUT_NAME_TOO_LONG", field });
  const taken = others.some((o) => String(o?.name || "").trim().toLowerCase() === name.toLowerCase());
  if (taken) throw fail("VALIDATION", `This warehouse already has a layout called "${name}".`, { reason: "LAYOUT_NAME_TAKEN", field });
  return name;
}

/**
 * The $set that makes `plan` + `positions` the live arrangement. Every root is
 * written: the snapshot's position where it has one, otherwise the root's own
 * size with `placed: false`.
 */
function liveSet(w, { plan, positions }) {
  const $set = {};
  const arrayFilters = [];
  for (const k of PLAN_FIELDS) if (plan[k] !== undefined) $set[`floorPlan.${k}`] = plan[k];
  const byId = new Map((positions || []).map((p) => [idOf(p.locationId), p.layout || {}]));
  let n = 0;
  for (const l of (w?.locations || []).filter(isRoot)) {
    const key = `r${n++}`;
    const own = pickLayout(l.layout);
    const saved = byId.get(idOf(l._id));
    /* A position the layout kept is on it unless it says otherwise; one it
       does not mention is off it. */
    $set[`locations.$[${key}].layout`] = saved ? { ...own, ...pickLayout(saved), placed: saved.placed !== false } : { ...own, placed: false };
    arrayFilters.push({ [`${key}._id`]: l._id });
  }
  return { $set, arrayFilters };
}

/* The entry the live slot belongs to, found or — for a warehouse still on its
   one implicit layout — minted, and given the live snapshot. Returns the new
   layouts array and that entry's id. */
function withLiveSaved(w, { now, actorId, currentName, newId, reserved = [] }) {
  const layouts = (Array.isArray(w?.layouts) ? w.layouts : []).map((s) => ({ ...s }));
  const activeId = activeIdOf(w);
  let entry = layouts.find((s) => idOf(s._id) === activeId);
  if (!entry) {
    const name = validateName(currentName || ORIGINAL_NAME, [...layouts, ...reserved], "currentName");
    entry = { _id: newId(), name, createdAt: now, createdBy: actorId || null, activatedAt: null };
    layouts.unshift(entry);
  }
  const snap = snapshotOf(w);
  entry.floorPlan = snap.floorPlan;
  entry.positions = snap.positions;
  entry.savedAt = now;
  return { layouts, liveId: entry._id };
}

/**
 * Start a new, blank layout and make it live. The arrangement that was live is
 * kept as its own layout (named `currentName`, or "Original layout", if it had
 * never been named).
 */
function planCreate(w, { name, currentName, actorId = null, now = new Date(), newId = mintId } = {}) {
  const existing = Array.isArray(w?.layouts) ? w.layouts : [];
  const wantsOriginal = !existing.some((s) => idOf(s._id) === activeIdOf(w));
  if (existing.length + (wantsOriginal ? 2 : 1) > MAX_LAYOUTS) throw fail("VALIDATION", `A warehouse can hold at most ${MAX_LAYOUTS} layouts.`, { reason: "TOO_MANY_LAYOUTS" });
  const cleanName = validateName(name, existing);
  const { layouts } = withLiveSaved(w, { now, actorId, currentName, newId, reserved: [{ name: cleanName }] });
  const id = newId();
  layouts.push({ _id: id, name: cleanName, floorPlan: null, positions: [], createdAt: now, createdBy: actorId, activatedAt: now, savedAt: null });
  const { $set, arrayFilters } = liveSet(w, { plan: blankPlan(w?.floorPlan), positions: [] });
  $set.layouts = layouts;
  $set["floorPlan.activeLayoutId"] = id;
  return { $set, arrayFilters, layoutId: id, name: cleanName };
}

/** Make a saved layout the live one; the one that was live is kept. */
function planActivate(w, layoutId, { actorId = null, now = new Date(), newId = mintId } = {}) {
  const target = (Array.isArray(w?.layouts) ? w.layouts : []).find((s) => idOf(s._id) === idOf(layoutId));
  if (!target || !idOf(layoutId)) throw fail("NOT_FOUND", "That layout is not in this warehouse.", { reason: "LAYOUT_NOT_FOUND" });
  if (idOf(layoutId) === activeIdOf(w)) return { noop: true, layoutId: target._id, name: target.name };
  const { layouts } = withLiveSaved(w, { now, actorId, newId });
  const t = layouts.find((s) => idOf(s._id) === idOf(layoutId));
  const plan = t.floorPlan ? planOf(t.floorPlan) : blankPlan(w?.floorPlan);
  const { $set, arrayFilters } = liveSet(w, { plan, positions: t.positions || [] });
  /* It is live now: the live slot is its only copy, so the snapshot is dropped
     rather than left to go stale beside it. */
  t.floorPlan = null;
  t.positions = [];
  t.activatedAt = now;
  $set.layouts = layouts;
  $set["floorPlan.activeLayoutId"] = t._id;
  return { $set, arrayFilters, layoutId: t._id, name: t.name };
}

/** Rename a layout. The implicit one (id "") becomes a saved entry on rename. */
function planRename(w, layoutId, name, { actorId = null, now = new Date(), newId = mintId } = {}) {
  const layouts = (Array.isArray(w?.layouts) ? w.layouts : []).map((s) => ({ ...s }));
  const activeId = activeIdOf(w);
  const implicit = !layouts.some((s) => idOf(s._id) === activeId);
  if (!idOf(layoutId)) {
    if (!implicit) throw fail("NOT_FOUND", "That layout is not in this warehouse.", { reason: "LAYOUT_NOT_FOUND" });
    const named = validateName(name, layouts);
    const id = newId();
    layouts.unshift({ _id: id, name: named, floorPlan: null, positions: [], createdAt: now, createdBy: actorId, activatedAt: null, savedAt: null });
    return { $set: { layouts, "floorPlan.activeLayoutId": id }, layoutId: id, name: named };
  }
  const entry = layouts.find((s) => idOf(s._id) === idOf(layoutId));
  if (!entry) throw fail("NOT_FOUND", "That layout is not in this warehouse.", { reason: "LAYOUT_NOT_FOUND" });
  entry.name = validateName(name, layouts.filter((s) => s !== entry));
  return { $set: { layouts }, layoutId: entry._id, name: entry.name };
}

module.exports = {
  MAX_LAYOUTS, NAME_MAX, ORIGINAL_NAME, PLAN_FIELDS,
  pickLayout, planOf, blankPlan, snapshotOf, listOf, validateName, liveSet,
  planCreate, planActivate, planRename,
};
