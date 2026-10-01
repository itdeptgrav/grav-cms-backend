// services/storePurchase/warehouseSetupTransfer.service.js
//
// EXPORT / IMPORT OF THE WAREHOUSE SETUP (1 Oct 2026, owner's request).
//
// The warehouse design — racks, shelves, bins, their codes, kinds, QR tokens,
// the layout boxes and the floor plan — is built once on the local database
// and has to exist on the hosted one too. Re-registering every rack by hand
// is what this replaces: one file out, one file in, "within a minute".
//
// ── WHAT TRAVELS, AND WHAT NEVER DOES ──────────────────────────────────────
//   travels   the warehouse master (name, code, address, contact, capacity,
//             description, status), its floor plan, its saved layouts, and
//             every non-archived location with its code, name, type, kind,
//             sequence, parent, QR token, layout box, capacity and status.
//   never     stock. No LocationBalance, no LocationMovement, no RawItem, no
//             label. A setup file describes WHERE things can sit, never what
//             sits there, so importing it can never invent or move stock.
//
// ── IDENTITIES ARE KEPT WHERE THEY ARE FREE ─────────────────────────────────
// Warehouse and location `_id`s are exported and re-used on import when the
// target database does not already hold them, so a `?focus=<id>` link, a
// bookmarked location page and a printed location label (`loc=LOC-…`, the
// token) all mean the same thing on both databases. An id that is already
// taken by SOMETHING ELSE is re-minted and parents are remapped; a QR token
// already carried by another warehouse's location is re-minted and reported,
// because two labels must never resolve to two places.
//
// ── IMPORT IS A MERGE, NEVER A DELETE ───────────────────────────────────────
// A warehouse is matched by its code within the company. Missing → created
// (with its locations). Present → its master fields and floor plan are
// updated, missing locations are added, present ones (matched by token, then
// by code) have their shape updated; nothing is removed or archived, and a
// location that already holds stock keeps its id. Re-running the same file is
// therefore harmless. `dryRun` returns the plan without writing.
"use strict";

const mongoose = require("mongoose");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const SpActionHistory = require("../../models/CMS_Models/StorePurchase/SpActionHistory");
const tenantContext = require("./tenantContext.service");
const { fail } = require("./errors");
const { mintQrToken } = require("./storeLocations.service");

const FORMAT = "grav.warehouse-setup";
const VERSION = 1;
const ENTITY = "WAREHOUSE";

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const idOf = (v) => (v === null || v === undefined ? "" : String(v));
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const LOCATION_KINDS = Warehouse.LOCATION_KINDS || ["AREA", "ZONE", "AISLE", "RACK", "BAY", "LEVEL", "SHELF", "DRAWER", "BIN", "SLOT", "FLOOR"];
const LOCATION_TYPES = Warehouse.LOCATION_TYPES || [];
const LIFECYCLE = ["Active", "Inactive", "Archived"];
const CODE_RE = /^[A-Z0-9][A-Z0-9-]{0,15}$/;

/* ── EXPORT ──────────────────────────────────────────────────────────────── */

const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

function exportLocation(l) {
  return {
    id: idOf(l._id),
    code: str(l.code), name: str(l.name), type: str(l.type),
    kind: str(l.kind) || "AREA",
    sequence: typeof l.sequence === "number" ? l.sequence : 0,
    parent: l.parent ? idOf(l.parent) : null,
    qrToken: str(l.qrToken),
    layout: plain(l.layout) || {},
    capacity: plain(l.capacity) || {},
    barcode: str(l.barcode), description: str(l.description),
    status: str(l.status) || "Active",
  };
}

function exportWarehouse(w) {
  const floorPlan = plain(w.floorPlan) || {};
  /* Saved layouts travel without who saved them — a person on one database
     is nobody on another. The active one stays named by its id. */
  const layouts = (w.layouts || []).map((ly) => ({
    id: idOf(ly._id), name: str(ly.name), floorPlan: plain(ly.floorPlan),
    positions: (ly.positions || []).map((p) => ({ locationId: idOf(p.locationId), layout: plain(p.layout) || {} })),
    createdAt: ly.createdAt || null, activatedAt: ly.activatedAt || null, savedAt: ly.savedAt || null,
  }));
  return {
    id: idOf(w._id),
    code: str(w.shortName), name: str(w.name), status: str(w.status) || "Active",
    address: str(w.address), addressDetail: plain(w.addressDetail) || {},
    contactPerson: plain(w.contactPerson) || {},
    capacityDetail: plain(w.capacityDetail) || {},
    description: str(w.description),
    floorPlan,
    layouts,
    locations: (w.locations || []).filter((l) => str(l.status) !== "Archived").map(exportLocation),
  };
}

/**
 * Every warehouse of this company (archived ones only when named by id).
 */
async function exportSetup(tenant, { ids = [] } = {}) {
  const wanted = (ids || []).filter(isId).map(oid);
  const filter = { $and: [tenantContext.tenantFilter(tenant), wanted.length ? { _id: { $in: wanted } } : { status: { $ne: "Archived" } }] };
  const rows = await Warehouse.find(filter).sort({ shortName: 1 }).lean();
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    exportedFrom: { companyId: tenant?.companyId ? idOf(tenant.companyId) : null },
    contents: "warehouse-setup-only",
    note: "Warehouses, their floor plans and their locations (racks, shelves, bins, codes, kinds, QR tokens, layout boxes, capacities). No stock, movements, items or labels.",
    warehouses: rows.map(exportWarehouse),
  };
}

/* ── VALIDATION ──────────────────────────────────────────────────────────── */

function assertSetup(file) {
  if (!file || typeof file !== "object") throw fail("VALIDATION", "That is not a warehouse setup file.", { reason: "SETUP_FILE_INVALID" });
  if (file.format !== FORMAT) {
    throw fail("VALIDATION", `That file is not a warehouse setup export (format "${str(file.format) || "unknown"}").`, { reason: "SETUP_FORMAT_MISMATCH" });
  }
  if (Number(file.version) !== VERSION) {
    throw fail("VALIDATION", `That setup file is version ${str(file.version) || "?"}; this system reads version ${VERSION}.`, { reason: "SETUP_VERSION_UNSUPPORTED" });
  }
  if (!Array.isArray(file.warehouses) || !file.warehouses.length) {
    throw fail("VALIDATION", "The setup file names no warehouse.", { reason: "SETUP_EMPTY" });
  }
  const codes = new Set();
  for (const w of file.warehouses) {
    const code = str(w.code).toUpperCase();
    if (!CODE_RE.test(code)) throw fail("VALIDATION", `Warehouse code "${str(w.code)}" is not valid.`, { reason: "SETUP_WAREHOUSE_CODE", code: str(w.code) });
    if (codes.has(code)) throw fail("VALIDATION", `Warehouse code ${code} appears twice in the file.`, { reason: "SETUP_DUPLICATE_WAREHOUSE", code });
    codes.add(code);
    if (!str(w.name)) throw fail("VALIDATION", `Warehouse ${code} has no name.`, { reason: "SETUP_WAREHOUSE_NAME", code });
    const locs = Array.isArray(w.locations) ? w.locations : [];
    const locCodes = new Set();
    const ids = new Set(locs.map((l) => idOf(l.id)).filter(Boolean));
    for (const l of locs) {
      const lc = str(l.code).toUpperCase();
      if (!lc) throw fail("VALIDATION", `A location in ${code} has no code.`, { reason: "SETUP_LOCATION_CODE", warehouse: code });
      if (locCodes.has(lc)) throw fail("VALIDATION", `Location code ${lc} appears twice in ${code}.`, { reason: "SETUP_DUPLICATE_LOCATION", warehouse: code, code: lc });
      locCodes.add(lc);
      if (!str(l.name)) throw fail("VALIDATION", `Location ${lc} in ${code} has no name.`, { reason: "SETUP_LOCATION_NAME", warehouse: code, code: lc });
      if (!LOCATION_TYPES.includes(str(l.type))) throw fail("VALIDATION", `Location ${lc} in ${code} has an unknown type "${str(l.type)}".`, { reason: "SETUP_LOCATION_TYPE", warehouse: code, code: lc });
      if (l.kind && !LOCATION_KINDS.includes(str(l.kind))) throw fail("VALIDATION", `Location ${lc} in ${code} has an unknown kind "${str(l.kind)}".`, { reason: "SETUP_LOCATION_KIND", warehouse: code, code: lc });
      if (l.status && !LIFECYCLE.includes(str(l.status))) throw fail("VALIDATION", `Location ${lc} in ${code} has an unknown status "${str(l.status)}".`, { reason: "SETUP_LOCATION_STATUS", warehouse: code, code: lc });
      if (l.parent && !ids.has(idOf(l.parent))) throw fail("VALIDATION", `Location ${lc} in ${code} names a parent that is not in the file.`, { reason: "SETUP_PARENT_MISSING", warehouse: code, code: lc });
    }
    /* No cycles: walk every parent chain. */
    const parentOf = new Map(locs.map((l) => [idOf(l.id), l.parent ? idOf(l.parent) : null]));
    for (const l of locs) {
      let cur = idOf(l.id); const seen = new Set();
      while (cur) { if (seen.has(cur)) throw fail("VALIDATION", `Locations in ${code} form a loop of parents.`, { reason: "SETUP_PARENT_CYCLE", warehouse: code }); seen.add(cur); cur = parentOf.get(cur) || null; }
    }
  }
}

/* ── PLAN ────────────────────────────────────────────────────────────────── */

function locationFields(l, actor) {
  return {
    code: str(l.code).toUpperCase(), name: str(l.name), type: str(l.type),
    kind: LOCATION_KINDS.includes(str(l.kind)) ? str(l.kind) : "AREA",
    sequence: Number.isFinite(Number(l.sequence)) ? Number(l.sequence) : 0,
    layout: l.layout && typeof l.layout === "object" ? l.layout : {},
    capacity: l.capacity && typeof l.capacity === "object" ? l.capacity : {},
    barcode: str(l.barcode), description: str(l.description),
    status: LIFECYCLE.includes(str(l.status)) ? str(l.status) : "Active",
    ...(actor ? { updatedBy: actor } : {}),
  };
}

function masterFields(w) {
  const cd = w.capacityDetail && typeof w.capacityDetail === "object" ? w.capacityDetail : {};
  return {
    name: str(w.name),
    address: str(w.address),
    addressDetail: {
      line1: str(w.addressDetail?.line1), line2: str(w.addressDetail?.line2), city: str(w.addressDetail?.city),
      state: str(w.addressDetail?.state), postalCode: str(w.addressDetail?.postalCode), country: str(w.addressDetail?.country),
    },
    contactPerson: { name: str(w.contactPerson?.name), phone: str(w.contactPerson?.phone), email: str(w.contactPerson?.email) },
    capacityDetail: {
      value: Number.isFinite(Number(cd.value)) && cd.value !== null && cd.value !== "" ? Number(cd.value) : null,
      unit: str(cd.unit), dimension: ["AREA", "VOLUME", "POSITIONS", "UNKNOWN"].includes(str(cd.dimension)) ? str(cd.dimension) : "UNKNOWN",
    },
    description: str(w.description),
  };
}

/**
 * What an import WOULD do, warehouse by warehouse. Pure against the rows it
 * is given, so the dry run and the real run read the same plan.
 */
async function planImport(tenant, file) {
  assertSetup(file);
  const scope = tenantContext.tenantFilter(tenant);
  const codes = file.warehouses.map((w) => str(w.code).toUpperCase());
  const existing = await Warehouse.find({ $and: [scope, { shortName: { $in: codes } }] }).lean();
  const byCode = new Map(existing.map((w) => [str(w.shortName).toUpperCase(), w]));

  /* Ids and tokens already in use ANYWHERE in this database (any company):
     an id or a token must mean one place. */
  const fileWarehouseIds = file.warehouses.map((w) => idOf(w.id)).filter(isId).map(oid);
  const fileLocationIds = file.warehouses.flatMap((w) => (w.locations || []).map((l) => idOf(l.id))).filter(isId).map(oid);
  const fileTokens = file.warehouses.flatMap((w) => (w.locations || []).map((l) => str(l.qrToken))).filter(Boolean);
  const [idHolders, tokenHolders] = await Promise.all([
    Warehouse.find({ $or: [{ _id: { $in: fileWarehouseIds } }, { "locations._id": { $in: fileLocationIds } }] }).select("_id shortName locations._id locations.qrToken").lean(),
    fileTokens.length ? Warehouse.find({ "locations.qrToken": { $in: fileTokens } }).select("_id shortName locations._id locations.qrToken").lean() : [],
  ]);
  const warehouseIdTaken = new Map(idHolders.map((w) => [idOf(w._id), w]));
  const locationIdTaken = new Map();
  for (const w of idHolders) for (const l of w.locations || []) locationIdTaken.set(idOf(l._id), w);
  const tokenTaken = new Map();
  for (const w of tokenHolders) for (const l of w.locations || []) if (str(l.qrToken)) tokenTaken.set(str(l.qrToken), { warehouseId: idOf(w._id), locationId: idOf(l._id) });

  const plans = file.warehouses.map((w) => {
    const code = str(w.code).toUpperCase();
    const current = byCode.get(code) || null;
    const warnings = [];
    const locs = Array.isArray(w.locations) ? w.locations : [];

    /* The warehouse id: kept when free, else re-minted. */
    let warehouseId;
    if (current) warehouseId = current._id;
    else if (isId(w.id) && !warehouseIdTaken.has(idOf(w.id))) warehouseId = oid(w.id);
    else { warehouseId = new mongoose.Types.ObjectId(); if (isId(w.id)) warnings.push(`The warehouse id in the file is already used here; ${code} gets a new id.`); }

    /* Locations: match an existing one by token, then by code. */
    const currentLocs = current ? (current.locations || []) : [];
    const byToken = new Map(currentLocs.filter((l) => str(l.qrToken)).map((l) => [str(l.qrToken), l]));
    const byLocCode = new Map(currentLocs.map((l) => [str(l.code).toUpperCase(), l]));
    const idMap = new Map(); // file location id → target id
    const adds = []; const updates = [];
    let reIdCount = 0;
    for (const l of locs) {
      const token = str(l.qrToken);
      const match = (token && byToken.get(token)) || byLocCode.get(str(l.code).toUpperCase()) || null;
      if (match) {
        idMap.set(idOf(l.id), match._id);
        updates.push({ file: l, target: match });
        continue;
      }
      let locId;
      const fileId = idOf(l.id);
      if (isId(fileId) && !locationIdTaken.has(fileId)) locId = oid(fileId);
      else { locId = new mongoose.Types.ObjectId(); if (isId(fileId)) reIdCount++; }
      idMap.set(fileId, locId);
      adds.push({ file: l, targetId: locId });
    }

    if (reIdCount) warnings.push(`${reIdCount} location id${reIdCount === 1 ? " in the file is" : "s in the file are"} already used here; ${reIdCount === 1 ? "it gets a new id" : "they get new ids"} (links that named the old ids will not match).`);

    /* Tokens, decided NOW so the dry run shows the same warnings the write
       acts on: a token already carried by a location that is not the matched
       one is re-minted — two labels must never point at two places. A
       location with no token gets one, so its label can be printed at once. */
    const tokens = new Map(); // file location key → token to store
    const tokenKey = (l) => `${idOf(l.id)}|${str(l.code)}`;
    let remintCount = 0;
    const decideToken = (l, matchedId, existingToken = "") => {
      const token = str(l.qrToken);
      if (!token) return str(existingToken) || mintQrToken();
      const holder = tokenTaken.get(token);
      if (holder && (!matchedId || idOf(holder.locationId) !== idOf(matchedId))) { remintCount++; return mintQrToken(); }
      return token;
    };
    for (const { file: l, target } of updates) tokens.set(tokenKey(l), decideToken(l, target._id, target.qrToken));
    for (const { file: l } of adds) tokens.set(tokenKey(l), decideToken(l, null));
    if (remintCount) warnings.push(`${remintCount} label token${remintCount === 1 ? " is" : "s are"} already carried by other locations here; new tokens are minted for ${remintCount === 1 ? "that location" : "those locations"}, so their printed location labels must be reprinted.`);

    return {
      code, name: str(w.name), action: current ? "update" : "create",
      warehouseId, current, file: w, idMap, adds, updates, tokens, tokenKey, warnings,
      summary: {
        locationsInFile: locs.length,
        locationsToAdd: adds.length,
        locationsToUpdate: updates.length,
        floorPlan: Boolean(w.floorPlan && Object.keys(w.floorPlan).length),
        layouts: Array.isArray(w.layouts) ? w.layouts.length : 0,
      },
    };
  });

  return {
    warehouses: plans.map((p) => ({ code: p.code, name: p.name, action: p.action, ...p.summary, warnings: p.warnings })),
    totals: {
      warehouses: plans.length,
      toCreate: plans.filter((p) => p.action === "create").length,
      toUpdate: plans.filter((p) => p.action === "update").length,
      locationsToAdd: plans.reduce((n, p) => n + p.adds.length, 0),
      locationsToUpdate: plans.reduce((n, p) => n + p.updates.length, 0),
    },
    _plans: plans,
  };
}

/* ── APPLY ───────────────────────────────────────────────────────────────── */

function remapFloorPlan(fp, idMap) {
  const out = fp && typeof fp === "object" ? JSON.parse(JSON.stringify(fp)) : {};
  if (out.activeLayoutId !== undefined) out.activeLayoutId = isId(out.activeLayoutId) ? out.activeLayoutId : null;
  return out;
}

function remapLayouts(layouts, idMap) {
  return (Array.isArray(layouts) ? layouts : []).map((ly) => ({
    ...(isId(ly.id) ? { _id: oid(ly.id) } : {}),
    name: str(ly.name) || "Layout",
    floorPlan: ly.floorPlan && typeof ly.floorPlan === "object" ? ly.floorPlan : null,
    positions: (ly.positions || [])
      .map((p) => ({ locationId: idMap.get(idOf(p.locationId)) || (isId(p.locationId) ? oid(p.locationId) : null), layout: p.layout && typeof p.layout === "object" ? p.layout : {} }))
      .filter((p) => p.locationId),
    createdAt: ly.createdAt ? new Date(ly.createdAt) : null,
    activatedAt: ly.activatedAt ? new Date(ly.activatedAt) : null,
    savedAt: ly.savedAt ? new Date(ly.savedAt) : null,
  }));
}

/**
 * Import a setup file: the plan, then — unless `dryRun` — the writes, one
 * warehouse at a time, with one history row each.
 */
async function importSetup(tenant, file, { actor = null, actorName = "", dryRun = false, requestId = "", idempotencyKey = "" } = {}) {
  const plan = await planImport(tenant, file);
  if (dryRun) {
    const { _plans, ...visible } = plan;
    return { dryRun: true, plan: visible };
  }
  const stamp = tenantContext.stamp(tenant);
  const results = [];
  for (const p of plan._plans) {
    const at = new Date();
    const fileLocs = Array.isArray(p.file.locations) ? p.file.locations : [];
    const parentFor = (l) => (l.parent ? (p.idMap.get(idOf(l.parent)) || null) : null);
    let result;
    if (p.action === "create") {
      const locations = fileLocs.map((l) => {
        const targetId = p.idMap.get(idOf(l.id));
        return { _id: targetId, ...locationFields(l, actor), parent: parentFor(l), qrToken: tokenFor(p, l), createdBy: actor };
      });
      const [created] = await Warehouse.create([{
        _id: p.warehouseId,
        ...stamp,
        shortName: p.code,
        ...masterFields(p.file),
        status: LIFECYCLE.includes(str(p.file.status)) && str(p.file.status) !== "Archived" ? str(p.file.status) : "Active",
        locations,
        floorPlan: remapFloorPlan(p.file.floorPlan, p.idMap),
        layouts: remapLayouts(p.file.layouts, p.idMap),
        structureVersion: 1,
        createdBy: actor,
      }]);
      result = { code: p.code, action: "created", warehouseId: idOf(created._id), locationsAdded: locations.length, locationsUpdated: 0 };
    } else {
      const doc = await Warehouse.findById(p.current._id);
      if (!doc) throw fail("NOT_FOUND", `Warehouse ${p.code} disappeared while importing.`, { reason: "WAREHOUSE_NOT_FOUND", code: p.code });
      Object.assign(doc, masterFields(p.file));
      /* Present locations: shape updated, identity kept. */
      for (const { file: l, target } of p.updates) {
        const sub = doc.locations.id(target._id);
        if (!sub) continue;
        Object.assign(sub, locationFields(l, actor));
        sub.parent = parentFor(l);
        const token = tokenFor(p, l);
        if (token) sub.qrToken = token;
      }
      /* Missing locations: added, parents remapped onto this warehouse's ids. */
      for (const { file: l, targetId } of p.adds) {
        doc.locations.push({ _id: targetId, ...locationFields(l, actor), parent: parentFor(l), qrToken: tokenFor(p, l), createdBy: actor });
      }
      const fp = remapFloorPlan(p.file.floorPlan, p.idMap);
      if (Object.keys(fp).length) {
        const prevVersion = Number(doc.floorPlan?.layoutVersion) || 0;
        doc.floorPlan = { ...fp, layoutVersion: prevVersion + 1 };
      }
      const layouts = remapLayouts(p.file.layouts, p.idMap);
      if (layouts.length) {
        const have = new Set((doc.layouts || []).map((ly) => idOf(ly._id)));
        for (const ly of layouts) if (!ly._id || !have.has(idOf(ly._id))) doc.layouts.push(ly);
      }
      doc.structureVersion = (Number(doc.structureVersion) || 0) + 1;
      if (actor) doc.updatedBy = actor;
      await doc.save();
      result = { code: p.code, action: "updated", warehouseId: idOf(doc._id), locationsAdded: p.adds.length, locationsUpdated: p.updates.length };
    }
    try {
      await SpActionHistory.create({
        companyId: tenant.companyId, siteId: tenant.siteId || null,
        entityType: ENTITY, entityId: result.warehouseId, documentNumber: p.code,
        action: "WAREHOUSE_SETUP_IMPORTED",
        actorId: str(actor) || str(tenant.actorId) || "system", actorName: str(actorName || tenant.actorName),
        at, resultingState: result.action === "created" ? "Active" : null,
        requestId: str(requestId), idempotencyKey: str(idempotencyKey),
        metadata: { ...result, warnings: p.warnings, exportedAt: file.exportedAt || null, exportedFrom: file.exportedFrom || null },
      });
    } catch (e) {
      /* The setup is in; an audit row that would not write is said, never a
         reason to roll a warehouse back out. */
      result.historyWarning = e?.message || "history row not written";
    }
    results.push({ ...result, warnings: p.warnings });
  }
  const { _plans, ...visible } = plan;
  return {
    dryRun: false,
    plan: visible,
    results,
    totals: {
      created: results.filter((r) => r.action === "created").length,
      updated: results.filter((r) => r.action === "updated").length,
      locationsAdded: results.reduce((n, r) => n + r.locationsAdded, 0),
      locationsUpdated: results.reduce((n, r) => n + r.locationsUpdated, 0),
    },
  };
}

/* The token the plan decided for this file location. */
function tokenFor(plan, l) {
  return plan.tokens.get(plan.tokenKey(l)) ?? str(l.qrToken);
}

module.exports = { FORMAT, VERSION, exportSetup, assertSetup, planImport, importSetup, exportWarehouse, exportLocation };
