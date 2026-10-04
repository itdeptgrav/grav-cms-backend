// services/maintenance/maintenanceOrders.service.js
//
// MAINTENANCE ORDERS — Service Orders (MSO) and Product Orders (MPO), the
// machines and items they are about, their history and the overview.
// The states and steps are maintenanceOrderFlow.js; this file applies them.
//
// ── THE RULES THIS FILE EXISTS TO KEEP ──────────────────────────────────────
//   · An order POINTS at an existing machine (Machine register) or an existing
//     item (the Store's Item Master). Nothing here creates, edits or copies a
//     machine, an item or a barcode. A scan or a search only FINDS one.
//   · A Store sticker is followed read-only to its item, and the item must be
//     of a type Maintenance Settings allows. Machines are always allowed: a
//     machine is an asset, and Asset can never be switched off.
//   · Every order is its own record. A finished order is never reopened; the
//     next problem on the same machine is a new order with a new number.
//   · Every step is ONE conditional write keyed on the current status, so two
//     people pressing the same button cannot both move the order.
//   · The repair clock is two stored timestamps; the minutes are derived from
//     them at the moment the clock stops.
//   · Who did what comes from the session, never from the request body.
"use strict";

const mongoose = require("mongoose");

const Machine = require("../../models/CMS_Models/Inventory/Configurations/Machine");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Barcode = require("../../models/CMS_Models/Inventory/Operations/Barcode");
const Employee = require("../../models/Employee");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const MaintenanceOrder = require("../../models/CMS_Models/Maintenance/MaintenanceOrder");
const MachineMaintenanceRecord = require("../../models/CMS_Models/Maintenance/MachineMaintenanceRecord");
const machines = require("./maintenance.service");
const flow = require("./maintenanceOrderFlow");
const storage = require("./maintenanceStorage");
const settings = require("./maintenanceSettings");
const items = require("./maintenanceItems");
const { sewingFamilyOf } = require("./sewingMachines");
const serviceTerms_ = require("./maintenanceServiceTerms");
const { readScannedCode } = require("./machineTag");

const { MaintenanceError, actorOf } = machines;

const LIMITS = Object.freeze({
  TEXT_MIN: 3, PROBLEM_MAX: 2000, REPORT_MAX: 4000, KEY_MIN: 8, KEY_MAX: 100, PARTS_MAX: 50, TITLE_MAX: 160, CATEGORY_MAX: 80,
  ATTACH_PER_CALL: 20, ATTACH_PER_ORDER: 60,
});
const LIST_MAX = 100;
const HISTORY_MAX = 500;

/* ─── Numbers ───────────────────────────────────────────────────────────── */

/* The counter lives in `crm_sequences`, beside the carton and journey
   counters, namespaced by key — the cluster has no room for a counter
   collection of its own (see services/packingCartonRef.js). Byte-for-byte
   the schema those modules register, so whichever loads first wins. */
const counterSchema = new mongoose.Schema(
  { key: { type: String, required: true, unique: true, index: true }, seq: { type: Number, default: 0 } },
  { timestamps: true, collection: "crm_sequences" },
);
const Counter = mongoose.models.CRMSequence || mongoose.model("CRMSequence", counterSchema);

async function nextOrderNumber(type) {
  const doc = await Counter.findOneAndUpdate(
    { key: `maintenance:${flow.PREFIX[type]}` },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return flow.formatOrderNumber(type, doc.seq);
}

/* ─── Small helpers ─────────────────────────────────────────────────────── */

const text = (v) => (typeof v === "string" ? v.trim() : "");
const fail = (status, code, message, details) => new MaintenanceError(status, code, message, details);
const isId = (v) => mongoose.isValidObjectId(String(v || ""));

async function requireOrderStorage() {
  if (await storage.orderStorageReady()) return;
  throw fail(503, "MAINTENANCE_STORAGE_NOT_READY",
    "Maintenance orders cannot be saved yet: their database collection has not been set up.",
    { action: "An administrator runs scripts/migrations/machine-maintenance-storage.js --apply (on Atlas, after freeing a collection slot)." });
}

/* ─── Subjects: an existing machine or an existing item ────────────────── */

const SUBJECT_NOT_FOUND = (reason, extra = {}) => fail(404, "SUBJECT_NOT_FOUND", "Machine or Product Not Found", { reason, ...extra });

async function machineSubject(id) {
  let m;
  try { m = await machines.loadMachine(id); } catch (err) {
    if (err instanceof MaintenanceError) throw SUBJECT_NOT_FOUND(err.details?.reason || "No such machine.");
    throw err;
  }
  const v = machines.machineView(m);
  return {
    kind: "machine", id: v.id, name: v.name, code: v.machineId, type: v.family ? `${v.type} · ${v.family}` : v.type,
    category: "Asset", location: v.location || "", status: v.status || "", barcode: v.tag?.code || "",
    machine: v,
  };
}

async function itemSubject(id, visible) {
  const allowed = visible || await settings.getVisibleItemTypes();
  const raw = await items.visibleItem(id, allowed);
  if (!raw) {
    throw SUBJECT_NOT_FOUND("No item with this reference is selectable by Maintenance. Its type may not be allowed in Maintenance Settings.");
  }
  const locations = await items.locationsOf(raw._id).catch(() => []);
  const detail = items.itemDetailView(raw, allowed, locations);
  return {
    kind: "item", id: detail.id, name: detail.name, code: detail.sku, type: detail.type === settings.NOT_CLASSIFIED ? "Not classified" : detail.type,
    category: detail.category, location: locations.map((l) => l.code).filter(Boolean).join(", "), status: detail.status, barcode: "",
    item: detail,
  };
}

async function subjectFor(kind, id) {
  if (!isId(id)) throw SUBJECT_NOT_FOUND("That is not a valid reference.");
  if (kind === "machine") return machineSubject(id);
  if (kind === "item") return itemSubject(id);
  throw SUBJECT_NOT_FOUND("Choose a machine or a product.");
}

/* A Store sticker, read the way the Store reads it: `itemid=<id>`, the
   item-info URL, or the bare 24-hex sticker id. Read-only; never imported
   from the Store, so a change there cannot change what Maintenance does. */
function stickerIdOf(raw) {
  const s = String(raw || "").trim();
  let id = null;
  if (/^https?:\/\//i.test(s)) {
    try { id = new URL(s).searchParams.get("itemid"); } catch { /* not a URL */ }
  }
  const m = /^(?:itemid|rawitem)=([0-9a-f]{24})$/i.exec(s);
  if (m) id = m[1];
  if (!id && /^[0-9a-f]{24}$/i.test(s)) id = s;
  return id && /^[0-9a-f]{24}$/i.test(id) ? id.toLowerCase() : null;
}

/**
 * What a scanned barcode identifies — always an EXISTING machine or item.
 * A READ: nothing is created, whatever is scanned, however often.
 */
async function resolveCode(raw) {
  const scanned = String(raw ?? "").trim();
  if (!scanned) throw SUBJECT_NOT_FOUND("Nothing was scanned.", { kind: "empty" });

  const tag = readScannedCode(scanned);
  if (tag.ok) {
    const m = await Machine.findOne({ "maintenanceTag.code": tag.code }).select("_id").lean();
    if (!m) throw SUBJECT_NOT_FOUND("No machine carries this barcode. It may have been removed from the register.", { kind: "unknown-tag" });
    const subject = await machineSubject(m._id);
    return { ...subject, scanned: { code: tag.code, kind: "machine-tag" } };
  }

  const stickerId = stickerIdOf(scanned);
  if (stickerId) {
    const label = await Barcode.findById(stickerId).select("rawItem variantId variantCombination identityState").lean();
    if (!label) throw SUBJECT_NOT_FOUND("No Store label carries this code.", { kind: "unknown-sticker" });
    if (label.identityState === "VOIDED") throw SUBJECT_NOT_FOUND("This Store label was voided and no longer identifies an item.", { kind: "voided-sticker" });
    const visible = await settings.getVisibleItemTypes();
    const item = await items.visibleItem(label.rawItem, visible);
    if (!item) {
      const exists = await RawItem.findById(label.rawItem).select("name productType").lean();
      if (!exists) throw SUBJECT_NOT_FOUND("The item on this label is no longer in the Item Master.", { kind: "missing-item" });
      throw fail(409, "TYPE_NOT_ALLOWED", "Item Not Allowed for Maintenance", {
        reason: `${exists.name} is ${exists.productType ? `a ${exists.productType}` : "not classified"}, which Maintenance Settings do not allow. Asset is always allowed; other types are switched on in Settings.`,
        kind: "type-not-allowed",
      });
    }
    const subject = await itemSubject(item._id, visible);
    return {
      ...subject,
      variant: label.variantId ? { id: String(label.variantId), combination: (label.variantCombination || []).join(" · ") } : null,
      scanned: { code: stickerId, kind: "store-sticker" },
    };
  }

  /* Anything else is named, never guessed. */
  throw SUBJECT_NOT_FOUND(tag.kind === "unknown" ? "This code is not a machine barcode or a Store item label." : tag.reason, { kind: tag.kind });
}

/** Machines and allowed items matching a search, for "Search / Select". */
async function searchSubjects(q) {
  const needle = String(q || "").trim();
  const visible = await settings.getVisibleItemTypes();
  const [machineList, itemList] = await Promise.all([
    machines.listSewingMachines({ search: needle }),
    items.listItems(visible, { search: needle }),
  ]);
  return {
    machines: machineList.machines.slice(0, 25).map((m) => ({
      kind: "machine", id: m.id, name: m.name, code: m.machineId, type: m.family || m.type, category: "Asset",
      location: m.location || "", status: m.status || "", barcode: m.tag?.code || "", openOrders: m.openOrders,
    })),
    items: itemList.items.slice(0, 25).map((i) => ({
      kind: "item", id: i.id, name: i.name, code: i.sku, type: i.type === settings.NOT_CLASSIFIED ? "Not classified" : i.type,
      category: i.category, location: "", status: i.status, barcode: "",
    })),
    allowedTypes: visible,
  };
}

/* ─── Order views ───────────────────────────────────────────────────────── */

const who = (a) => (a ? { name: a.name || a.email || "", email: a.email || "" } : null);

/* Orders raised before the details existed have none: every fact is then
   its empty value, never invented. */
function detailsView(d) {
  return {
    priority: d?.priority || "normal",
    maintenanceType: d?.maintenanceType || "",
    specification: d?.specification || "",
    department: d?.department || "",
    targetDate: d?.targetDate || null,
    estimatedCost: Number.isFinite(d?.estimatedCost) ? d.estimatedCost : null,
    provider: { kind: d?.provider?.kind || "in-house", name: d?.provider?.name || "", contact: d?.provider?.contact || "" },
    conditionReceived: d?.conditionReceived || "",
    accessories: d?.accessories || "",
    handedOverBy: d?.handedOverBy || "",
    notes: d?.notes || "",
  };
}

function orderView(o) {
  const repairMinutes = Number.isFinite(o.repairMinutes) ? o.repairMinutes
    : flow.minutesBetween(o.workStartedAt, o.workDoneAt);
  const s = o.subject || {};
  const info = o.serviceInfo ? {
    title: o.serviceInfo.title || "", category: o.serviceInfo.category || "",
    description: o.serviceInfo.description || "", location: o.serviceInfo.location || "",
  } : null;
  return {
    id: String(o._id),
    orderType: o.orderType,
    orderNumber: o.orderNumber,
    /* A job stored before the statuses were simplified is read as its new one. */
    status: flow.normalizeStatus(o.status),
    statusLabel: flow.STATUS_LABEL[flow.normalizeStatus(o.status)] || o.status,
    isOpen: (flow.OPEN[o.orderType] || []).includes(flow.normalizeStatus(o.status)),
    /* What the job is called: the typed title, else the machine or item. */
    title: info?.title || o.subjectAtOpen?.name || "",
    service: info,
    /* The Store service form's vendor-side terms — only on outside work. */
    serviceTerms: serviceTerms_.termsView(o.serviceTerms),
    details: detailsView(o.details),
    attachments: (o.attachments || []).map((a) => ({
      fileId: a.fileId, name: a.name, mimeType: a.mimeType || "", size: Number.isFinite(a.size) ? a.size : null,
      stage: a.stage || "raised", uploadedAt: a.uploadedAt, uploadedBy: a.uploadedBy?.name || a.uploadedBy?.email || "",
    })),
    subject: {
      kind: s.kind, id: String(s.machine || s.item || ""), barcode: s.barcode || "", barcodeKind: s.barcodeKind || "",
      variantId: s.variantId ? String(s.variantId) : null,
      name: o.subjectAtOpen?.name || "", code: o.subjectAtOpen?.code || "", type: o.subjectAtOpen?.type || "", location: o.subjectAtOpen?.location || "",
    },
    problem: o.problem,
    openedAt: o.openedAt,
    openedBy: who(o.openedBy),
    assignedTo: who(o.assignedTo),
    inMaintenanceAt: o.inMaintenanceAt || null,
    inMaintenanceBy: who(o.inMaintenanceBy),
    workStartedAt: o.workStartedAt || null,
    workStartedBy: who(o.workStartedBy),
    workDoneAt: o.workDoneAt || null,
    workDoneBy: who(o.workDoneBy),
    repairMinutes: Number.isFinite(repairMinutes) ? repairMinutes : null,
    repairDuration: flow.formatDuration(repairMinutes),
    report: o.report ? { diagnosis: o.report.diagnosis || "", workPerformed: o.report.workPerformed || "", notes: o.report.notes || "" } : null,
    partsUsed: (o.partsUsed || []).map((p) => ({ item: p.item ? String(p.item) : null, name: p.name, quantity: p.quantity, unit: p.unit || "" })),
    closedAt: o.closedAt || null,
    closedBy: who(o.closedBy),
    cancelledAt: o.cancelledAt || null,
    cancelledBy: who(o.cancelledBy),
    cancelReason: o.cancelReason || "",
    events: (o.events || []).map((e) => ({ at: e.at, by: e.by?.name || e.by?.email || "", action: e.action, from: e.from, to: e.to, note: e.note || "" })),
    actions: flow.availableActions(o.orderType, flow.normalizeStatus(o.status)),
  };
}

/* The V1 breakdown reports, read-only, in the same history. */
function legacyView(r, subjectName = "") {
  return {
    id: String(r._id),
    entryType: "report",
    orderType: null,
    orderNumber: null,
    status: r.status === "completed" ? "DONE" : "OPEN",
    statusLabel: r.status === "completed" ? "Done" : "Open",
    subject: { kind: r.machine ? "machine" : "item", id: String(r.machine || r.item), name: subjectName },
    title: r.kind === "breakdown" ? "Breakdown report" : "Maintenance report",
    problem: r.problem,
    openedAt: r.reportedAt,
    openedBy: who(r.reportedBy),
    workDoneAt: r.completion?.at || null,
    summary: r.completion?.notes || "",
    repairMinutes: null,
    repairDuration: null,
  };
}

const historyEntry = (o) => ({ ...orderView(o), entryType: "order", summary: o.report?.workPerformed || "" });

/* ─── Staff: who an order can be assigned to ────────────────────────────── */

async function maintenanceStaff(user) {
  const grants = await DepartmentRole.find({ departmentSlug: "maintenance", isActive: true }).select("email name").lean();
  const emails = grants.map((g) => String(g.email || "").toLowerCase()).filter(Boolean);
  const employees = await Employee.find({
    $or: [{ department: /maintenance/i }, ...(emails.length ? [{ email: { $in: emails } }] : [])],
  }).select("firstName lastName email").limit(200).lean();
  const people = new Map();
  for (const e of employees) {
    people.set(String(e._id), { id: String(e._id), name: `${e.firstName || ""} ${e.lastName || ""}`.trim() || e.email, email: e.email || "" });
  }
  const me = actorOf(user);
  if (me.id && !people.has(String(me.id))) people.set(String(me.id), { id: String(me.id), name: me.name || me.email, email: me.email, isMe: true });
  else if (me.id) people.get(String(me.id)).isMe = true;
  return [...people.values()].sort((a, b) => Number(Boolean(b.isMe)) - Number(Boolean(a.isMe)) || a.name.localeCompare(b.name));
}

/** The person an order is assigned to: an employee by id, or the caller. */
async function assigneeFrom(assignedToId, user) {
  if (!assignedToId) return null;
  const me = actorOf(user);
  if (me.id && String(me.id) === String(assignedToId)) return me;
  if (!isId(assignedToId)) throw fail(400, "INVALID_ASSIGNEE", "Choose who the order is assigned to from the list.");
  const e = await Employee.findById(assignedToId).select("firstName lastName email").lean();
  if (!e) throw fail(400, "INVALID_ASSIGNEE", "That person is not an employee.");
  return { id: e._id, name: `${e.firstName || ""} ${e.lastName || ""}`.trim() || e.email || "", email: String(e.email || "").toLowerCase() };
}

/* ─── Create ────────────────────────────────────────────────────────────── */

function validateCreate(type, body) {
  const errors = [];
  if (!flow.isOrderType(type)) errors.push({ field: "orderType", message: "Unknown order type." });
  const problem = text(body?.problem);
  const idempotencyKey = text(body?.idempotencyKey);
  /* A Service Maintenance job is the Store's service form, whose only
     required field is the name; its description stands in for a problem. */
  if (type !== "service" && problem.length < LIMITS.TEXT_MIN) errors.push({ field: "problem", message: "Describe the problem." });
  if (type === "service" && problem && problem.length < LIMITS.TEXT_MIN) errors.push({ field: "problem", message: "Describe the problem." });
  if (problem.length > LIMITS.PROBLEM_MAX) errors.push({ field: "problem", message: `Keep it under ${LIMITS.PROBLEM_MAX} characters.` });
  if (idempotencyKey.length < LIMITS.KEY_MIN || idempotencyKey.length > LIMITS.KEY_MAX) {
    errors.push({ field: "idempotencyKey", message: "The form did not identify this submission. Reload and try again." });
  }
  /* A Product order is about an exact existing machine or item. A Service
     order is typed free-form; linking a machine or item is optional. */
  const s = body?.subject || {};
  const linked = ["machine", "item"].includes(s.kind) && isId(s.id);
  const sent = s.kind && s.kind !== "none";
  if (type === "product" && !linked) errors.push({ field: "subject", message: "Choose the machine or product first." });
  if (type === "service" && sent && !linked) errors.push({ field: "subject", message: "That machine or product could not be linked. Choose it again or remove it." });

  /* The service form itself is checked in createOrder (serviceTerms.checkServiceForm):
     it reads the Store's suppliers and Finance's heads, so it is async. */
  let service = null;
  if (type === "service") {
    service = body?.service && typeof body.service === "object" ? body.service : {};
    if (text(service.location).length > LIMITS.TITLE_MAX) errors.push({ field: "service.location", message: `Keep the location under ${LIMITS.TITLE_MAX} characters.` });
  }
  const { details, errors: detailErrors } = detailsFrom(type, body?.details);
  errors.push(...detailErrors);
  if (errors.length) throw fail(400, "INVALID_ORDER", errors[0].message, { errors });
  return {
    problem, idempotencyKey, service, details,
    subject: linked ? { kind: s.kind, id: String(s.id) } : null,
    scanned: linked ? body?.scanned || null : null,
  };
}

const subjectIdOf = (o) => String(o.subject?.machine || o.subject?.item || "");

/* The optional planning facts. Unknown values are refused in words, never
   quietly dropped: a priority the server did not understand is a mistake. */
function detailsFrom(type, raw = {}) {
  const errors = [];
  const d = raw && typeof raw === "object" ? raw : {};
  const cap = (field, value, max, label) => {
    const v = text(value);
    if (v.length > max) errors.push({ field: `details.${field}`, message: `Keep the ${label} under ${max} characters.` });
    return v.slice(0, max);
  };
  const priority = text(d.priority) || "normal";
  if (!MaintenanceOrder.PRIORITIES.includes(priority)) errors.push({ field: "details.priority", message: "Choose a priority from the list." });
  const maintenanceType = text(d.maintenanceType);
  if (maintenanceType && !MaintenanceOrder.MAINTENANCE_TYPES.includes(maintenanceType)) {
    errors.push({ field: "details.maintenanceType", message: "Choose a maintenance type from the list." });
  }
  let targetDate;
  if (d.targetDate) {
    const t = new Date(d.targetDate);
    if (Number.isNaN(t.getTime())) errors.push({ field: "details.targetDate", message: "The target date is not a date." });
    else targetDate = t;
  }
  let estimatedCost;
  if (d.estimatedCost !== undefined && d.estimatedCost !== null && String(d.estimatedCost).trim() !== "") {
    estimatedCost = Number(d.estimatedCost);
    if (!Number.isFinite(estimatedCost) || estimatedCost < 0) errors.push({ field: "details.estimatedCost", message: "The estimated cost must be a number, zero or more." });
  }
  const p = d.provider && typeof d.provider === "object" ? d.provider : {};
  const providerKind = text(p.kind) || "in-house";
  if (!["in-house", "outside"].includes(providerKind)) errors.push({ field: "details.provider.kind", message: "Say whether the work is in-house or by an outside vendor." });
  const details = {
    priority, maintenanceType,
    specification: cap("specification", d.specification, 2000, "specification"),
    department: cap("department", d.department, 120, "department"),
    ...(targetDate ? { targetDate } : {}),
    ...(Number.isFinite(estimatedCost) && estimatedCost >= 0 ? { estimatedCost } : {}),
    provider: {
      kind: providerKind,
      name: providerKind === "outside" ? cap("provider.name", p.name, 160, "vendor name") : "",
      contact: providerKind === "outside" ? cap("provider.contact", p.contact, 160, "vendor contact") : "",
    },
    conditionReceived: type === "product" ? cap("conditionReceived", d.conditionReceived, 1000, "condition") : "",
    accessories: type === "product" ? cap("accessories", d.accessories, 500, "accessories") : "",
    handedOverBy: type === "product" ? cap("handedOverBy", d.handedOverBy, 160, "handed-over-by") : "",
    notes: cap("notes", d.notes, 2000, "notes"),
  };
  return { details, errors };
}

/* Drive references from the browser's upload. Only the reference is kept. */
const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;
function attachmentsFrom(raw, user, stage) {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length > LIMITS.ATTACH_PER_CALL) {
    return { attachments: [], errors: [{ field: "attachments", message: `Attach at most ${LIMITS.ATTACH_PER_CALL} files at a time.` }] };
  }
  const now = new Date();
  const actor = actorOf(user);
  const errors = [];
  const attachments = [];
  for (const a of list) {
    const fileId = text(a?.fileId);
    const name = text(a?.name).slice(0, 200);
    if (!DRIVE_ID.test(fileId) || !name) { errors.push({ field: "attachments", message: "A file did not finish uploading. Remove it and add it again." }); continue; }
    const size = Number(a?.size);
    attachments.push({
      fileId, name, mimeType: text(a?.mimeType).slice(0, 120),
      ...(Number.isFinite(size) && size >= 0 ? { size } : {}),
      stage, uploadedAt: now, uploadedBy: actor,
    });
  }
  return { attachments, errors };
}

/**
 * A new order on an existing machine or item. `{ created, order }` — a
 * resubmitted form is answered with the order it already made.
 * Product orders may be put into maintenance in the same act
 * Both kinds are born Open. A product job is handed over by being registered,
 * so it records when (inMaintenanceAt); `putIntoMaintenance` is no longer a
 * separate step and is ignored if an older screen still sends it.
 */
async function createOrder(type, body, user) {
  const input = validateCreate(type, body);
  const { attachments, errors: attachErrors } = attachmentsFrom(body?.attachments, user, "raised");
  if (attachErrors.length) throw fail(400, "INVALID_ATTACHMENT", attachErrors[0].message, { errors: attachErrors });
  await requireOrderStorage();
  const subject = input.subject ? await subjectFor(input.subject.kind, input.subject.id) : null;

  /* Service Maintenance: the Store's service form, checked the Store's way.
     With a linked machine a blank name and location are the machine's own. */
  let serviceInfo;
  let serviceTerms;
  let details = input.details;
  let problem = input.problem;
  if (type === "service") {
    const form = await serviceTerms_.checkServiceForm(
      { ...input.service, doneBy: input.service.doneBy ?? input.details.provider.kind },
      { linkedName: subject?.name || "" },
    );
    if (!form.ok) throw fail(400, "INVALID_ORDER", form.errors[0].message, { errors: form.errors });
    serviceInfo = {
      title: form.identity.title,
      category: form.identity.category,
      description: form.identity.description,
      location: (text(input.service.location) || subject?.location || "").slice(0, LIMITS.TITLE_MAX),
    };
    serviceTerms = form.terms || undefined;
    details = {
      ...details,
      provider: form.doneBy === "outside"
        ? { kind: "outside", name: form.terms?.preferredVendorName || details.provider.name, contact: details.provider.contact }
        : { kind: "in-house", name: "", contact: "" },
    };
    problem = problem || form.identity.description.slice(0, LIMITS.PROBLEM_MAX) || form.identity.title;
  }

  /* Product Maintenance by an outside vendor carries the same Store service
     terms, checked the same way (owner, 3 Oct 2026). Its "service name" is the
     machine or item itself. */
  if (type === "product") {
    const raw = body?.terms && typeof body.terms === "object" ? body.terms : {};
    const doneBy = text(raw.doneBy) || details.provider.kind;
    if (doneBy === "outside") {
      const form = await serviceTerms_.checkServiceForm({ ...raw, name: subject.name, doneBy: "outside" }, { linkedName: subject.name });
      if (!form.ok) throw fail(400, "INVALID_ORDER", form.errors[0].message, { errors: form.errors });
      serviceTerms = form.terms;
      details = { ...details, provider: { kind: "outside", name: form.terms.preferredVendorName || details.provider.name, contact: details.provider.contact } };
    } else if (doneBy !== "in-house") {
      throw fail(400, "INVALID_ORDER", "Say whether the work is in-house or by an outside vendor.");
    } else {
      details = { ...details, provider: { kind: "in-house", name: "", contact: "" } };
    }
  }

  /* A submission sent again (a double click, a retry after a dropped reply)
     is answered BEFORE a number is taken — otherwise every replay would use up
     a number and the register would skip (MSO-0001, MSO-0003). The unique
     index below still settles two copies racing in at the same instant. */
  const already = await MaintenanceOrder.findOne({ idempotencyKey: input.idempotencyKey }).lean();
  if (already) {
    if (subjectIdOf(already) === (subject?.id || "") && already.orderType === type) {
      return { created: false, order: orderView(already) };
    }
    throw fail(409, "IDEMPOTENCY_KEY_REUSED", "This submission was already used for another order. Reload and try again.");
  }

  /* The barcode the order was raised from — only one that really belongs to
     this subject is recorded (a machine's own tag, or a Store sticker whose
     item this is, re-verified here). */
  let barcode = "";
  let barcodeKind = "";
  let variantId;
  const scannedCode = text(input.scanned?.code);
  if (subject && scannedCode) {
    const again = await resolveCode(scannedCode).catch(() => null);
    if (again && again.kind === subject.kind && again.id === subject.id) {
      barcode = again.scanned.code;
      barcodeKind = again.scanned.kind;
      if (again.variant?.id) variantId = new mongoose.Types.ObjectId(again.variant.id);
    }
  }
  if (!barcode && subject?.kind === "machine" && subject.barcode) { barcode = subject.barcode; barcodeKind = "machine-tag"; }

  const now = new Date();
  const actor = actorOf(user);
  const assignedTo = await assigneeFrom(body?.assignedToId, user);
  const status = flow.INITIAL[type];
  const handedOver = type === "product";
  const events = [{ at: now, by: actor, action: "created", from: "", to: status, note: "" }];

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const orderNumber = await nextOrderNumber(type);
    try {
      const doc = await MaintenanceOrder.create({
        orderType: type,
        orderNumber,
        subject: subject ? {
          kind: subject.kind,
          ...(subject.kind === "machine" ? { machine: subject.id } : { item: subject.id }),
          ...(variantId ? { variantId } : {}),
          barcode, barcodeKind,
        } : { kind: "none", barcode: "", barcodeKind: "" },
        subjectAtOpen: subject
          ? { name: subject.name, code: subject.code, type: subject.type, location: subject.location }
          : { name: serviceInfo.title, code: "", type: serviceInfo.category, location: serviceInfo.location },
        ...(serviceInfo ? { serviceInfo } : {}),
        ...(serviceTerms ? { serviceTerms } : {}),
        details,
        attachments,
        problem,
        openedAt: now,
        openedBy: actor,
        status,
        ...(assignedTo ? { assignedTo } : {}),
        ...(handedOver ? { inMaintenanceAt: now, inMaintenanceBy: actor } : {}),
        events,
        idempotencyKey: input.idempotencyKey,
      });
      return { created: true, order: orderView(doc.toObject()) };
    } catch (err) {
      if (err?.code !== 11000) throw err;
      if (err?.keyPattern?.orderNumber) continue; // the counter was behind a taken number: take the next
      const prior = await MaintenanceOrder.findOne({ idempotencyKey: input.idempotencyKey }).lean();
      if (prior && subjectIdOf(prior) === (subject?.id || "") && prior.orderType === type) {
        return { created: false, order: orderView(prior) };
      }
      throw fail(409, "IDEMPOTENCY_KEY_REUSED", "This submission was already used for another order. Reload and try again.");
    }
  }
  throw fail(503, "ORDER_NUMBER_UNAVAILABLE", "An order number could not be allocated. Try again.");
}

/* ─── Steps ─────────────────────────────────────────────────────────────── */

function partsFrom(raw) {
  const list = Array.isArray(raw) ? raw.slice(0, LIMITS.PARTS_MAX) : [];
  return list.map((p) => ({
    item: isId(p?.item) ? new mongoose.Types.ObjectId(String(p.item)) : null,
    name: text(p?.name).slice(0, 200),
    quantity: Number.isFinite(Number(p?.quantity)) && Number(p.quantity) >= 0 ? Number(p.quantity) : 1,
    unit: text(p?.unit).slice(0, 40),
  })).filter((p) => p.name);
}

async function loadOrder(id) {
  if (!isId(id)) throw fail(404, "ORDER_NOT_FOUND", "That maintenance order does not exist.");
  const o = await MaintenanceOrder.findById(id).lean();
  if (!o) throw fail(404, "ORDER_NOT_FOUND", "That maintenance order does not exist.");
  return o;
}

/** One step of an order's lifecycle. Forward only, once, atomically. */
async function stepOrder(id, action, body, user) {
  await requireOrderStorage();
  const order = await loadOrder(id);
  const check = flow.stepFor(order.orderType, order.status, action);
  if (!check.ok) throw fail(409, "INVALID_STEP", check.reason, { currentStatus: order.status, order: orderView(order) });
  const step = check.step;
  action = check.action; // an old step name ("solve", "complete-repair"…) read as the new one

  const now = new Date();
  const actor = actorOf(user);
  const set = { status: step.to };
  let proof = [];
  let note = text(body?.note);

  if (step.clock === "start") {
    set.workStartedAt = now;
    set.workStartedBy = actor;
    if (!order.assignedTo?.name) set.assignedTo = actor; // whoever starts it, unless someone was named
  }
  if (step.clock === "stop") {
    const workPerformed = text(body?.workPerformed);
    if (workPerformed.length < LIMITS.TEXT_MIN) throw fail(400, "REPORT_REQUIRED", "Write what was done.");
    const diagnosis = text(body?.diagnosis);
    const notes = text(body?.notes);
    for (const [k, v] of Object.entries({ diagnosis, workPerformed, notes })) {
      if (v.length > LIMITS.REPORT_MAX) throw fail(400, "REPORT_TOO_LONG", `Keep the ${k} under ${LIMITS.REPORT_MAX} characters.`);
    }
    set.workDoneAt = now;
    set.workDoneBy = actor;
    set.repairMinutes = flow.minutesBetween(order.workStartedAt, now) ?? 0;
    set.report = { diagnosis, workPerformed, notes };
    const parts = partsFrom(body?.partsUsed);
    if (parts.length) set.partsUsed = parts;
    /* Proof of the work — any document or photo — kept with the job. */
    const { attachments, errors } = attachmentsFrom(body?.attachments, user, "proof");
    if (errors.length) throw fail(400, "INVALID_ATTACHMENT", errors[0].message, { errors });
    if ((order.attachments || []).length + attachments.length > LIMITS.ATTACH_PER_ORDER) {
      throw fail(409, "TOO_MANY_ATTACHMENTS", `A job keeps at most ${LIMITS.ATTACH_PER_ORDER} files.`);
    }
    proof = attachments;
  }
  if (action === "close") { set.closedAt = now; set.closedBy = actor; }
  if (action === "cancel") {
    const reason = text(body?.reason);
    if (reason.length < LIMITS.TEXT_MIN) throw fail(400, "REASON_REQUIRED", "Say why this order is being cancelled.");
    set.cancelledAt = now;
    set.cancelledBy = actor;
    set.cancelReason = reason;
    note = reason;
  }

  const updated = await MaintenanceOrder.findOneAndUpdate(
    { _id: order._id, status: order.status },
    { $set: set, $push: {
      events: { at: now, by: actor, action, from: order.status, to: step.to, note: proof.length ? `${note ? `${note} · ` : ""}proof: ${proof.map((a) => a.name).join(", ")}`.slice(0, 2000) : note },
      ...(proof.length ? { attachments: { $each: proof } } : {}),
    } },
    { new: true },
  ).lean();
  if (!updated) {
    const fresh = await loadOrder(id);
    throw fail(409, "INVALID_STEP", `This job moved on while you were working: it is now ${flow.STATUS_LABEL[flow.normalizeStatus(fresh.status)] || fresh.status}.`,
      { currentStatus: fresh.status, order: orderView(fresh) });
  }
  return { order: orderView(updated) };
}

/**
 * Add photos or documents to a job, at any stage — a vendor's invoice after
 * it is closed is as much a part of the job as a photo of the fault. Appended
 * in one write; nothing is ever removed.
 */
async function addAttachments(id, body, user) {
  await requireOrderStorage();
  const order = await loadOrder(id);
  const { attachments, errors } = attachmentsFrom(body?.attachments, user, "later");
  if (errors.length) throw fail(400, "INVALID_ATTACHMENT", errors[0].message, { errors });
  if (!attachments.length) throw fail(400, "INVALID_ATTACHMENT", "Choose at least one file.");
  const now = new Date();
  const updated = await MaintenanceOrder.findOneAndUpdate(
    /* The count is part of the write, so two people adding at once cannot pass the cap together. */
    { _id: order._id, [`attachments.${LIMITS.ATTACH_PER_ORDER - attachments.length}`]: { $exists: false } },
    {
      $push: {
        attachments: { $each: attachments },
        events: { at: now, by: actorOf(user), action: "attached", from: order.status, to: order.status, note: attachments.map((a) => a.name).join(", ").slice(0, 2000) },
      },
    },
    { new: true },
  ).lean();
  if (!updated) throw fail(409, "TOO_MANY_ATTACHMENTS", `A job keeps at most ${LIMITS.ATTACH_PER_ORDER} files.`);
  return { order: orderView(updated) };
}

/** Re-assign an open order. Recorded in its events. */
async function assignOrder(id, assignedToId, user) {
  await requireOrderStorage();
  const order = await loadOrder(id);
  const current = flow.normalizeStatus(order.status);
  if (!(flow.OPEN[order.orderType] || []).includes(current) && current !== "DONE") {
    throw fail(409, "ORDER_FINISHED", "A finished order keeps who did it; it cannot be re-assigned.");
  }
  const assignee = await assigneeFrom(assignedToId, user);
  if (!assignee) throw fail(400, "INVALID_ASSIGNEE", "Choose who the order is assigned to.");
  const now = new Date();
  const updated = await MaintenanceOrder.findOneAndUpdate(
    { _id: order._id, status: order.status },
    { $set: { assignedTo: assignee }, $push: { events: { at: now, by: actorOf(user), action: "assigned", from: order.status, to: order.status, note: assignee.name } } },
    { new: true },
  ).lean();
  if (!updated) throw fail(409, "INVALID_STEP", "This order moved on while you were working. Reload it.");
  return { order: orderView(updated) };
}

/* ─── Reading ───────────────────────────────────────────────────────────── */

async function orderDetail(id) {
  const o = await loadOrder(id);
  /* A free-form job is about no register record: no "now", no repair figures. */
  if (o.subject.kind === "none") return { order: orderView(o), subjectNow: null, subjectStats: null };
  /* The subject as it is NOW (the order keeps how it was when raised). */
  const now = await subjectFor(o.subject.kind, subjectIdOf(o)).catch(() => null);
  const history = await subjectOrders(o.subject.kind, subjectIdOf(o));
  return {
    order: orderView(o),
    subjectNow: now ? { kind: now.kind, id: now.id, name: now.name, code: now.code, type: now.type, location: now.location, status: now.status, barcode: now.barcode } : null,
    subjectStats: flow.repairStats(history),
  };
}

async function subjectOrders(kind, id) {
  if (!isId(id)) return [];
  const field = kind === "machine" ? "subject.machine" : "subject.item";
  return MaintenanceOrder.find({ [field]: new mongoose.Types.ObjectId(id) }).sort({ openedAt: -1, _id: -1 }).limit(HISTORY_MAX).lean();
}

/** A machine or item, its combined maintenance history, and its repair figures. */
async function subjectDetail(kind, id) {
  const subject = await subjectFor(kind, id);
  const [orders, legacy] = await Promise.all([
    subjectOrders(kind, id),
    MachineMaintenanceRecord.find(kind === "machine" ? { machine: id } : { item: id }).sort({ reportedAt: -1 }).lean(),
  ]);
  const history = [...orders.map(historyEntry), ...legacy.map((r) => legacyView(r, subject.name))]
    .sort((a, b) => new Date(b.openedAt) - new Date(a.openedAt));
  const stats = flow.repairStats(orders);
  return {
    subject,
    history,
    stats: {
      ...stats,
      lastRepairDuration: flow.formatDuration(stats.lastRepairMinutes),
      averageRepairDuration: flow.formatDuration(stats.averageRepairMinutes),
    },
    storage: { ordersReady: await storage.orderStorageReady() },
  };
}

/* Today, as the floor's calendar has it (India): the UTC midnight of today's
   IST date. A target or expected-back date is stored as the UTC midnight of
   the day picked, so "before today" is a plain comparison. */
function todayIST(now = new Date()) {
  const ist = new Date(now.getTime() + 330 * 60000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

/* Overdue: still open or in progress, and its target / expected-back day has passed. */
const overdueFilter = (now) => ({ status: { $in: flow.storedAsAny(flow.OPEN.service) }, "details.targetDate": { $lt: todayIST(now) } });

function orderFilter({ type = "", status = "", search = "", subjectKind = "", due = "" } = {}) {
  const filter = {};
  if (flow.isOrderType(type)) filter.orderType = type;
  if (status === "open") filter.status = { $in: flow.storedAsAny(flow.OPEN.service) };
  else if (status) filter.status = { $in: flow.storedAs(flow.normalizeStatus(String(status).toUpperCase())) };
  if (due === "overdue") Object.assign(filter, overdueFilter());
  if (["machine", "item", "none"].includes(subjectKind)) filter["subject.kind"] = subjectKind;
  const needle = String(search || "").trim();
  if (needle) {
    const rx = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [
      { orderNumber: rx }, { problem: rx }, { "subjectAtOpen.name": rx }, { "subjectAtOpen.code": rx },
      { "serviceInfo.title": rx }, { "serviceInfo.category": rx }, { "serviceInfo.location": rx }, { "serviceInfo.description": rx },
      { "serviceTerms.preferredVendorName": rx }, { "serviceTerms.billingUnit": rx },
      { "subject.barcode": rx }, { "assignedTo.name": rx }, { "openedBy.name": rx }, { "report.workPerformed": rx },
    ];
  }
  return filter;
}

/** The register of one order type: paged, newest first, with counts per status. */
async function listOrders({ type, status = "", search = "", due = "", page = 1, limit = 20 } = {}) {
  if (!flow.isOrderType(type)) throw fail(400, "INVALID_ORDER_TYPE", "Choose service or product orders.");
  const ready = await storage.orderStorageReady();
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(LIST_MAX, Math.max(1, parseInt(limit, 10) || 20));
  if (!ready) {
    return { orders: [], pagination: { page: 1, limit: l, total: 0, totalPages: 1 }, counts: {}, overdue: 0, storage: { ordersReady: false } };
  }
  const filter = orderFilter({ type, status, search, due });
  const [total, rows, counts, overdue] = await Promise.all([
    MaintenanceOrder.countDocuments(filter),
    MaintenanceOrder.find(filter).sort({ openedAt: -1, _id: -1 }).skip((p - 1) * l).limit(l).lean(),
    MaintenanceOrder.aggregate([{ $match: { orderType: type } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    MaintenanceOrder.countDocuments({ orderType: type, ...overdueFilter() }),
  ]);
  return {
    orders: rows.map(orderView),
    pagination: { page: p, limit: l, total, totalPages: Math.max(1, Math.ceil(total / l)) },
    /* Counted under the new words, an unconverted job with its new status. */
    counts: counts.reduce((acc, c) => {
      const key = flow.normalizeStatus(c._id);
      acc[key] = (acc[key] || 0) + c.n;
      return acc;
    }, {}),
    /* Open or in progress past its target / expected-back day. */
    overdue,
    storage: { ordersReady: true },
  };
}

/** Everything that happened, both order types and the V1 reports, newest first. */
async function history({ type = "", status = "", search = "", subjectKind = "" } = {}) {
  const ready = await storage.orderStorageReady();
  const orders = ready ? await MaintenanceOrder.find(orderFilter({ type, status, search, subjectKind })).sort({ openedAt: -1 }).limit(HISTORY_MAX).lean() : [];
  let legacy = [];
  /* The first version's reports were always about a machine or an item. */
  if (!type && !status && subjectKind !== "none") {
    const rows = await MachineMaintenanceRecord.find(subjectKind === "machine" ? { machine: { $ne: null } } : subjectKind === "item" ? { item: { $ne: null } } : {})
      .sort({ reportedAt: -1 }).limit(HISTORY_MAX).lean();
    const machineNames = new Map((await Machine.find({ _id: { $in: rows.filter((r) => r.machine).map((r) => r.machine) } }).select("name").lean()).map((m) => [String(m._id), m.name]));
    const needle = String(search || "").trim().toLowerCase();
    legacy = rows.map((r) => legacyView(r, machineNames.get(String(r.machine)) || ""))
      .filter((r) => !needle || [r.subject.name, r.problem, r.summary].some((f) => String(f || "").toLowerCase().includes(needle)));
  }
  const entries = [...orders.map(historyEntry), ...legacy].sort((a, b) => new Date(b.openedAt) - new Date(a.openedAt));
  return { entries, storage: { ordersReady: ready } };
}

/** The dashboard's figures. */
async function overview() {
  const ready = await storage.orderStorageReady();
  const since = new Date(Date.now() - 30 * 86400000);
  const [machineList, visible] = await Promise.all([machines.listSewingMachines(), settings.getVisibleItemTypes()]);
  const base = {
    machines: { sewing: machineList.counts.sewing, tagged: machineList.counts.tagged },
    allowedTypes: visible,
    storage: { ordersReady: ready },
  };
  if (!ready) return { ...base, service: {}, product: {}, overdue: { service: 0, product: 0 }, repairs30: { count: 0, averageMinutes: null, averageDuration: null }, inMaintenance: [], recent: [] };
  const [byStatus, done30, inMaintenance, recent, overdueService, overdueProduct] = await Promise.all([
    MaintenanceOrder.aggregate([{ $group: { _id: { t: "$orderType", s: "$status" }, n: { $sum: 1 } } }]),
    MaintenanceOrder.find({ workDoneAt: { $gte: since } }).select("repairMinutes").lean(),
    MaintenanceOrder.find({ $or: [
      { status: { $in: flow.storedAs("IN_PROGRESS") } },
      { orderType: "product", status: { $in: flow.storedAs("OPEN") } },
    ] }).sort({ openedAt: -1 }).limit(20).lean(),
    MaintenanceOrder.find({}).sort({ updatedAt: -1 }).limit(8).lean(),
    /* 4 Oct 2026: the overview's "Overdue" card — the register's own rule. */
    MaintenanceOrder.countDocuments({ orderType: "service", ...overdueFilter() }),
    MaintenanceOrder.countDocuments({ orderType: "product", ...overdueFilter() }),
  ]);
  const service = {};
  const product = {};
  for (const r of byStatus) {
    const into = r._id.t === "service" ? service : product;
    const key = flow.normalizeStatus(r._id.s);
    into[key] = (into[key] || 0) + r.n;
  }
  const minutes = done30.map((o) => o.repairMinutes).filter((m) => Number.isFinite(m));
  const avg = minutes.length ? Math.round(minutes.reduce((a, b) => a + b, 0) / minutes.length) : null;
  return {
    ...base,
    service,
    product,
    overdue: { service: overdueService, product: overdueProduct },
    repairs30: { count: done30.length, averageMinutes: avg, averageDuration: flow.formatDuration(avg) },
    inMaintenance: inMaintenance.map(orderView),
    recent: recent.map(orderView),
  };
}

module.exports = {
  LIMITS,
  stickerIdOf,
  resolveCode,
  searchSubjects,
  subjectFor,
  subjectDetail,
  maintenanceStaff,
  createOrder,
  stepOrder,
  assignOrder,
  addAttachments,
  orderDetail,
  listOrders,
  history,
  overview,
};
