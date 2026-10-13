// services/maintenance/maintenance.service.js
//
// THE MACHINES THE MAINTENANCE TEAM LOOKS AFTER — the register's sewing
// machines and the permanent barcode on each. Orders (service and product),
// history and the overview are services/maintenance/maintenanceOrders.service.js.
//
// ── THE RULES THIS FILE EXISTS TO KEEP ──────────────────────────────────────
//   · It never creates a machine. It reads the Machine register, and the only
//     write it ever makes to a machine is the tag, once (`issueTag`).
//   · A tag belongs to one existing machine for ever. Issuing is idempotent:
//     a machine that already has one gets the same one back.
//   · A scan is a READ (`resolveTag`). Scanning a label a hundred times reads
//     the same machine a hundred times and writes nothing.
//   · Who did something comes from the session, never from the request body.
"use strict";

const mongoose = require("mongoose");

const Machine = require("../../models/CMS_Models/Inventory/Configurations/Machine");
const MaintenanceOrder = require("../../models/CMS_Models/Maintenance/MaintenanceOrder");
const { MACHINE_MAINTENANCE_TAG_WRITE_OPTION } = require("../../models/CMS_Models/Inventory/Configurations/machineMaintenanceTag.schema");
const { sewingFamilyOf } = require("./sewingMachines");
const { mintTagCode, readScannedCode } = require("./machineTag");
const flow = require("./maintenanceOrderFlow");
const storage = require("./maintenanceStorage");

const NOT_FOUND = "Sewing Machine Not Found";
const MINT_ATTEMPTS = 5;

class MaintenanceError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "MaintenanceError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const notFound = (reason, details = {}) =>
  new MaintenanceError(404, "SEWING_MACHINE_NOT_FOUND", NOT_FOUND, { reason, ...details });

/* What the register holds that is worth showing. Nothing is invented: the
   register has no brand or department field, so none is shown. */
const MACHINE_FIELDS =
  "name type model serialNumber status powerConsumption location lastMaintenance nextMaintenance description createdAt updatedAt +maintenanceTag";
const LIST_FIELDS = "name type model serialNumber status location +maintenanceTag";

/** The session's identity, as a record stores it. */
function actorOf(user) {
  const id = user?.id && mongoose.isValidObjectId(String(user.id)) ? new mongoose.Types.ObjectId(String(user.id)) : null;
  return { id, name: String(user?.name || "").trim(), email: String(user?.email || "").trim().toLowerCase() };
}

function tagView(tag) {
  if (!tag?.code) return null;
  return { code: tag.code, issuedAt: tag.issuedAt, issuedBy: tag.issuedBy?.name || tag.issuedBy?.email || "" };
}

function machineView(m) {
  const family = sewingFamilyOf(m.type);
  return {
    id: String(m._id),
    name: m.name,
    /* The register has no separate machine-number field: its serial number
       (e.g. JUK-2026-425) is the identity the floor uses, unique per machine. */
    machineId: m.serialNumber,
    serialNumber: m.serialNumber,
    type: m.type,
    family: family?.label || null,
    isSewing: Boolean(family),
    model: m.model ?? null,
    status: m.status ?? null,
    location: m.location ?? null,
    powerConsumption: m.powerConsumption ?? null,
    lastMaintenance: m.lastMaintenance ?? null,
    nextMaintenance: m.nextMaintenance ?? null,
    description: m.description || "",
    registeredAt: m.createdAt ?? null,
    updatedAt: m.updatedAt ?? null,
    tag: tagView(m.maintenanceTag),
  };
}

const naturally = (a, b) => String(a || "").localeCompare(String(b || ""), undefined, { numeric: true, sensitivity: "base" });

/** A machine the Maintenance app may open: a sewing machine, or one already tagged. */
async function loadMachine(id) {
  if (!mongoose.isValidObjectId(String(id || ""))) throw notFound("That is not a machine reference.");
  const m = await Machine.findById(id).select(MACHINE_FIELDS).lean();
  if (!m) throw notFound("No machine with this reference is in the register.");
  /* A tag, once issued, keeps resolving even if somebody later retypes the
     machine — the label on the machine must not start lying. */
  if (!sewingFamilyOf(m.type) && !m.maintenanceTag?.code) throw notFound("This machine is not a sewing machine.");
  return m;
}

/* ─── The list ──────────────────────────────────────────────────────────── */

/** Per machine: open orders, and repairs done. Empty until storage exists. */
async function ordersByMachine() {
  if (!(await storage.orderStorageReady())) return new Map();
  /* With their old stored names, so a job not yet converted still counts. */
  const open = flow.storedAsAny(flow.OPEN.service);
  const repaired = flow.storedAsAny(flow.REPAIRED.service);
  const rows = await MaintenanceOrder.aggregate([
    { $match: { "subject.machine": { $ne: null } } },
    { $group: {
      _id: "$subject.machine",
      open: { $sum: { $cond: [{ $in: ["$status", open] }, 1, 0] } },
      repairs: { $sum: { $cond: [{ $in: ["$status", repaired] }, 1, 0] } },
      lastRepairedAt: { $max: "$workDoneAt" },
    } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r]));
}

async function listSewingMachines({ search = "" } = {}) {
  const [all, orders] = await Promise.all([Machine.find({}).select(LIST_FIELDS).lean(), ordersByMachine()]);
  const needle = String(search || "").trim().toLowerCase();
  const machines = all
    .filter((m) => sewingFamilyOf(m.type))
    .map((m) => {
      const v = machineView(m);
      const o = orders.get(v.id);
      return { ...v, openOrders: o?.open || 0, repairs: o?.repairs || 0, lastRepairedAt: o?.lastRepairedAt || null };
    })
    .filter((v) => !needle || [v.name, v.machineId, v.type, v.family, v.location, v.model, v.tag?.code]
      .some((f) => String(f || "").toLowerCase().includes(needle)))
    .sort((a, b) => naturally(a.name, b.name));
  return {
    machines,
    counts: {
      sewing: all.filter((m) => sewingFamilyOf(m.type)).length,
      shown: machines.length,
      tagged: all.filter((m) => sewingFamilyOf(m.type) && m.maintenanceTag?.code).length,
      openOrders: [...orders.values()].reduce((n, o) => n + (o.open || 0), 0),
    },
  };
}

/* ─── The tag ───────────────────────────────────────────────────────────── */

/**
 * The machine's tag — issued now if it has none, otherwise the one it has.
 * `{ created, tag }`. Never creates a machine and never replaces a tag.
 */
async function issueTag(id, user) {
  /* loadMachine admits only a sewing machine or an already-tagged one, so an
     untagged machine past this line is a sewing machine. */
  const m = await loadMachine(id);
  if (m.maintenanceTag?.code) return { created: false, tag: tagView(m.maintenanceTag), machine: machineView(m) };

  /* The database's own guarantee that one code is never on two machines. */
  await storage.ensureTagIndex();

  const issuedBy = actorOf(user);
  for (let attempt = 1; attempt <= MINT_ATTEMPTS; attempt += 1) {
    const tag = { code: mintTagCode(), issuedAt: new Date(), issuedBy };
    try {
      const updated = await Machine.findOneAndUpdate(
        /* "No tag yet" is part of the write itself, so two people pressing
           Generate at the same moment cannot both win: the second matches
           nothing and is handed the first one's tag below. */
        { _id: m._id, "maintenanceTag.code": { $exists: false } },
        { $set: { maintenanceTag: tag } },
        { new: true, timestamps: false, [MACHINE_MAINTENANCE_TAG_WRITE_OPTION]: true },
      ).select(MACHINE_FIELDS).lean();
      if (updated) return { created: true, tag: tagView(updated.maintenanceTag), machine: machineView(updated) };
      break; // matched nothing: tagged meanwhile, or deleted
    } catch (err) {
      /* A code another machine already carries. Astronomically rare; mint again. */
      if (err?.code === 11000 && attempt < MINT_ATTEMPTS) continue;
      throw err;
    }
  }

  const now = await Machine.findById(m._id).select(MACHINE_FIELDS).lean();
  if (!now) throw notFound("The machine was removed from the register.");
  if (!now.maintenanceTag?.code) {
    throw new MaintenanceError(503, "TAG_NOT_ISSUED", "The tag could not be issued. Try again.");
  }
  return { created: false, tag: tagView(now.maintenanceTag), machine: machineView(now) };
}

/**
 * Which machine a scanned machine tag belongs to. A READ: it writes nothing,
 * so a hundred scans are a hundred identical answers.
 */
async function resolveTag(raw) {
  const read = readScannedCode(raw);
  if (!read.ok) throw notFound(read.reason, { kind: read.kind });
  const m = await Machine.findOne({ "maintenanceTag.code": read.code })
    .select("name serialNumber type +maintenanceTag")
    .lean();
  if (!m) {
    throw notFound("No machine carries this tag. It may have been removed from the register.", {
      kind: "unknown-tag", code: read.code,
    });
  }
  return { machineId: String(m._id), name: m.name, serialNumber: m.serialNumber, code: read.code };
}

module.exports = {
  NOT_FOUND,
  MACHINE_FIELDS,
  MaintenanceError,
  actorOf,
  machineView,
  loadMachine,
  listSewingMachines,
  issueTag,
  resolveTag,
};
