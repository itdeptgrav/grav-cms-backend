// services/ppc/departmentPlan.service.js — READ AND SAVE ONE DEPARTMENT'S PLAN
//
// The department plan (16 Oct 2026) is PPC planning ONE department across
// EVERY order: the work orders still open there, grouped by order, on the
// same day/hour grid the order plan uses. Saving turns the grid into each
// order's ordinary target — its share — through the one door every target
// goes through (orderTargets.service.setTarget, with all of checkTarget's
// rules), stamped planSource "department" and with a shared `layKey` on each
// entry. Nothing new is stored and no collection is added.
//
//   read  → work orders open here (with order, product, photo, colour, size,
//           balance), the grid as the active targets hold it, targets planned
//           some other way, IE's figures for the department
//   save  → every order's share checked first (nothing is written while any
//           order is refused), then written; an order the plan no longer
//           includes loses the department-plan target it had
"use strict";

const PpcOrderTarget = require("../../models/CMS_Models/PPC/PpcOrderTarget");
const orders = require("./control/orders.service");
const ledger = require("./control/ledger.service");
const targets = require("./orderTargets.service");
const standards = require("../industrialEngineering/departmentStandards.service");
const plan = require("./departmentPlan");

const { DEPARTMENTS, DEPARTMENT_META } = ledger;

function fail(status, message, errors) {
  const e = new targets.TargetError(status, message);
  if (errors) e.errors = errors;
  return e;
}

/** The work orders still open at `department`, with what PPC needs to plan them. */
function openWorkOrders(snap, department) {
  const done = new Map();
  for (const e of snap.events.get(department) || []) if (!e.beyond && e.woId) done.set(String(e.woId), (done.get(String(e.woId)) || 0) + (Number(e.qty) || 0));
  const out = [];
  for (const w of snap.index.list) {
    if (w.status === "cancelled" || !w.moId) continue;
    const h = snap.headers.get(w.moId);
    if (!h) continue;
    const d = done.get(w.id) || 0;
    const left = Math.max(0, (w.quantity || 0) - d);
    if (!left) continue;
    out.push({
      id: w.id, number: w.number, moId: w.moId, moNumber: h.moNumber || "", customer: h.customerName || w.customerName || "",
      delivery: h.deliveryDate ? new Date(h.deliveryDate).toISOString().slice(0, 10) : "",
      product: w.product, image: w.image || null, colour: w.colour || "", size: w.size || "", variant: w.variant || "",
      quantity: w.quantity || 0, done: d, left,
    });
  }
  /* by delivery, then order, then colour and size — the grid's row order */
  return out.sort((a, b) => (a.delivery || "9999").localeCompare(b.delivery || "9999") || a.moNumber.localeCompare(b.moNumber) || a.colour.localeCompare(b.colour) || a.size.localeCompare(b.size, undefined, { numeric: true }));
}

/* Each work order's fabric (departmentPlan.fabricOf) — what lets PPC put
   pieces of several orders on one lay: the same fabric is one lay. Read for
   the open work orders only; a work order whose bill of material names no
   fabric carries `fabric: null` and the screen falls back to its colour. */
async function attachFabrics(workOrders) {
  if (!workOrders.length) return workOrders;
  const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
  const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
  const docs = await WorkOrder.find({ _id: { $in: workOrders.map((w) => w.id) } })
    .select("_id rawMaterials.rawItemId rawMaterials.name rawMaterials.rawItemVariantId rawMaterials.rawItemVariantCombination rawMaterials.quantityRequired").lean();
  const ids = [...new Set(docs.flatMap((d) => (d.rawMaterials || []).map((r) => String(r.rawItemId))))];
  const items = ids.length ? await RawItem.find({ _id: { $in: ids } }).select("_id category").lean() : [];
  const categoryOf = new Map(items.map((i) => [String(i._id), i.category || ""]));
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  for (const w of workOrders) w.fabric = plan.fabricOf(byId.get(w.id)?.rawMaterials, categoryOf);
  return workOrders;
}

async function read(companyId, department) {
  if (!DEPARTMENTS.includes(department)) throw fail(404, "No such department.");
  const snap = await orders.snapshot(companyId);
  const workOrders = await attachFabrics(openWorkOrders(snap, department));
  const active = (snap.targets || []).filter((t) => t.department === department && t.status === "active");
  const { cells, other } = plan.cellsFromTargets(active, department);
  const std = await standards.standardFor(companyId, department).catch(() => null);
  const otherRows = other.map((o) => {
    const t = active.find((x) => String(x._id) === o.targetId);
    return { ...o, moNumber: snap.headers.get(o.moId)?.moNumber || "", description: t ? require("./orderTargets.evaluate").describeTarget(t) : "" };
  });
  /* order-page proposals waiting on this plan, each with its cells */
  const proposals = (snap.proposals || []).filter((t) => t.department === department)
    .map((t) => ({
      targetId: String(t._id), moId: String(t.manufacturingOrderId), moNumber: snap.headers.get(String(t.manufacturingOrderId))?.moNumber || t.moNumber || "",
      customer: snap.headers.get(String(t.manufacturingOrderId))?.customerName || t.customerName || "",
      cells: plan.cellsFromTargets([{ ...t, status: "active" }], department).cells,
      pieces: (t.dayPlan || []).reduce((a, e) => a + (Number(e.pieces) || 0), 0) || t.pieces || 0,
      from: t.from, to: t.to, by: t.assignedBy?.name || "", at: t.assignedAt || null, note: t.note || "",
      description: require("./orderTargets.evaluate").describeTarget(t),
      paced: !(t.dayPlan || []).some((e) => e.workOrderId),
    }))
    .sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
  return {
    department, label: DEPARTMENT_META[department]?.label || department, asOfDay: snap.asOfDay,
    workOrders, cells, otherTargets: otherRows, proposals,
    standard: std ? {
      capacityPerDay: std.capacity?.perDay ?? null, capacityPerHour: std.capacity?.perHour ?? null,
      batch: standards.batchOf(std, department),
    } : null,
  };
}

/**
 * body: { entries: [{ workOrderId, slot, pieces }], note? }
 * Every order on the plan is checked before anything is written.
 */
async function save(companyId, department, body, actor) {
  if (!DEPARTMENTS.includes(department)) throw fail(404, "No such department.");
  const snap = await orders.snapshot(companyId);
  const open = department === "cutting" ? await attachFabrics(openWorkOrders(snap, department)) : openWorkOrders(snap, department);
  const woById = new Map(open.map((w) => [w.id, w]));
  const std = await standards.standardFor(companyId, department).catch(() => null);
  const perBatch = standards.batchOf(std, department)?.perBatch || 0;
  const { orders: byOrder, problems } = plan.plansFromCells(body?.entries, woById, { department, perBatch });

  /* a cutting lay is one fabric (plan.layMix): an hour holding lays of
     fabrics no lay can mix is refused, naming the hour */
  if (department === "cutting") {
    const bySlot = new Map();
    for (const e of body?.entries || []) {
      const w = woById.get(String(e.workOrderId));
      if (!w || !/T\d{2}:\d{2}$/.test(String(e.slot)) || !(Number(e.pieces) > 0)) continue;
      if (!bySlot.has(e.slot)) bySlot.set(e.slot, []);
      bySlot.get(e.slot).push({ fabric: w.fabric, product: w.product, pieces: Number(e.pieces) });
    }
    for (const [slot, parts] of bySlot) {
      const total = parts.reduce((a, x) => a + x.pieces, 0);
      const lays = perBatch > 0 ? Math.max(1, Math.ceil(total / perBatch)) : 1;
      const mix = plan.layMix(parts, lays);
      if (mix.level === "error") problems.push(`${slot.slice(0, 10)} ${slot.slice(11)}: ${mix.text}. Move one of them to another hour.`);
    }
  }
  if (problems.length) throw fail(409, problems.join(" "), problems);

  const label = DEPARTMENT_META[department]?.label || department;
  const note = String(body?.note || "").trim().slice(0, 500) || `Planned on PPC's ${label} plan, across orders.`;
  const bodies = [...byOrder.entries()].map(([moId, o]) => [moId, {
    department, kind: "total", planSource: "department", note,
    dayPlan: o.dayPlan, allocations: o.allocations,
    pieces: o.dayPlan.reduce((n, e) => n + e.pieces, 0),
    from: o.dayPlan[0].date, to: o.dayPlan[o.dayPlan.length - 1].date, workingDays: [0, 1, 2, 3, 4, 5, 6],
  }]);

  /* check every order first — a plan is saved whole or not at all */
  const refusals = [];
  const checks = await Promise.all(bodies.map(async ([moId, b]) => [moId, await targets.previewTarget(companyId, moId, b).catch((err) => ({ errors: [err.message] }))]));
  for (const [moId, c] of checks) for (const e of c.errors || []) refusals.push(`${snap.headers.get(moId)?.moNumber || moId}: ${e}`);
  if (refusals.length) throw fail(409, refusals.join(" "), refusals);

  const saved = [];
  for (const [moId, b] of bodies) {
    const out = await targets.setTarget(companyId, moId, b, actor);
    saved.push({ moId, moNumber: snap.headers.get(moId)?.moNumber || "", targetId: String(out.target._id), description: out.description });
  }

  /* the proposals PPC TOOK into this plan (body.acceptedProposals) are
     answered: accepted, pointing at the order's new target. A proposal not
     taken stays waiting — its order being on the plan is not an answer. */
  const now = new Date();
  const taken = (Array.isArray(body?.acceptedProposals) ? body.acceptedProposals : []).map(String).filter(targets.isId);
  for (const id of taken) {
    const p = await PpcOrderTarget.findOne({ _id: id, companyId, department, status: "proposed" }).select("manufacturingOrderId").lean();
    if (!p) continue;
    const mine = saved.find((x) => String(x.moId) === String(p.manufacturingOrderId));
    await PpcOrderTarget.updateOne({ _id: id }, { $set: { status: "accepted", replacedById: mine ? mine.targetId : null, endedAt: now, endedBy: actor, endReason: `Taken into PPC's ${label} plan` } });
  }

  /* any other department-plan target still standing for these orders, or for
     an order the plan no longer includes, ends here */
  const keep = new Set(saved.map((x) => x.targetId));
  const stale = await PpcOrderTarget.find({ companyId, department, status: "active", planSource: "department", _id: { $nin: [...keep] } }).select("_id manufacturingOrderId").lean();
  for (const t of stale) await targets.cancelTarget(companyId, String(t._id), actor, `Replaced by PPC's ${label} plan.`);
  if (stale.length) orders.invalidateSnapshots(companyId);

  return { saved, ended: stale.map((t) => String(t._id)), orders: saved.length };
}

module.exports = { read, save, openWorkOrders };
