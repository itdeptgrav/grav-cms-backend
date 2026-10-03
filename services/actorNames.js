// services/actorNames.js
//
// WHO DID IT, BY NAME (3 Oct 2026).
//
// `performedBy` on a stock issuance and on a raw item's stockTransactions is
// declared `ref: "Employee"`, but since v2 department sign-in the id written
// there is a `dept_users` row (the signed-in store person), and the CEO has no
// `employees` row at all. A populate against Employee found nothing, and every
// screen printed "System" for work a named person had done.
//
// This is the one place that turns those ids into names. It looks the id up
// in both registers, prefers the name the record itself carries
// (`performedByName`, written at the time of the action from the session), and
// never says "System" for an id it simply could not resolve.

const mongoose = require("mongoose");

function employeeName(e) {
  if (!e) return "";
  const full = [e.firstName, e.middleName, e.lastName].filter(Boolean).join(" ").trim();
  return full || e.name || e.email || "";
}

/** ids (ObjectId | string | populated doc | null)[] → Map<id, name> */
async function resolveActorNames(ids) {
  const out = new Map();
  const want = new Set();
  for (const v of ids || []) {
    if (!v) continue;
    const id = typeof v === "object" && v._id ? String(v._id) : String(v);
    if (typeof v === "object" && (v.name || v.firstName)) { out.set(id, employeeName(v)); continue; }
    if (mongoose.Types.ObjectId.isValid(id)) want.add(id);
  }
  if (!want.size) return out;
  const oids = [...want].map((s) => new mongoose.Types.ObjectId(s));
  const Employee = mongoose.models.Employee || require("../models/Employee");
  const DeptUser = mongoose.models.DeptUser || require("../models/Access/DeptUser");
  const [emps, depts] = await Promise.all([
    Employee.find({ _id: { $in: oids } }).select("firstName middleName lastName name email").lean().catch(() => []),
    DeptUser.find({ _id: { $in: oids } }).select("name email").lean().catch(() => []),
  ]);
  for (const e of emps) { const n = employeeName(e); if (n) out.set(String(e._id), n); }
  for (const d of depts) { const n = d.name || d.email || ""; if (n && !out.has(String(d._id))) out.set(String(d._id), n); }
  return out;
}

/**
 * Rewrites `doc[field]` on each lean doc to `{ _id, name }` (or null), using the
 * record's own `performedByName` first, then the registers.
 * `rows` may be nested: pass a getter to reach them (e.g. item.stockTransactions).
 */
async function attachActorNames(rows, field = "performedBy") {
  const list = (rows || []).filter(Boolean);
  const names = await resolveActorNames(list.map((r) => r[field]));
  for (const r of list) {
    const raw = r[field];
    const id = raw ? String(raw._id || raw) : "";
    const name = r[`${field}Name`] || (id && names.get(id)) || (raw && typeof raw === "object" ? employeeName(raw) : "");
    r[field] = id || name ? { _id: id || null, name: name || "" } : null;
  }
  return list;
}

/** The name to print for a resolved row: the person, else a stated fallback. */
function actorLabel(doc, field = "performedBy", fallback = "Not recorded") {
  const v = doc?.[field];
  if (v && typeof v === "object" && v.name) return v.name;
  if (doc?.[`${field}Name`]) return doc[`${field}Name`];
  return fallback;
}

/** What to stamp at write time, from the session. */
function actorStamp(req, field = "performedBy") {
  const u = req?.user || {};
  return { [field]: u.id || null, [`${field}Name`]: u.name || u.email || "" };
}

module.exports = { resolveActorNames, attachActorNames, actorLabel, actorStamp, employeeName };
