// routes/CMS_Routes/Inventory/Operations/mrfRoutes.js
// Mount: app.use("/api/cms/inventory/mrf", mrfRoutes)

const express  = require("express");
const router   = express.Router();
const mongoose = require("mongoose");
const MRF      = require("../../../../models/CMS_Models/Inventory/Operations/MRF");
const RawItem  = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const Unit     = require("../../../../models/CMS_Models/Inventory/Configurations/Unit");
const Employee = require("../../../../models/Employee");
const EmployeeAuth = require("../../../../Middlewear/EmployeeAuthMiddlewear");

router.use(EmployeeAuth);

// ── helpers ───────────────────────────────────────────────────────────────────
function buildFullName(emp) {
  if (!emp) return "";
  return [emp.firstName, emp.middleName, emp.lastName]
    .filter(Boolean).join(" ").trim() || emp.email || emp.name || "";
}

// EmployeeAuthMiddleware sets req.user._id (ObjectId) on the store/PM side.
// On the cowork/employee side it may set req.user.id as a string.
// Always prefer _id for ObjectId fields.
function getActorId(req) {
  return req.user._id || req.user.id;
}

async function convertQty(qty, fromUnit, toUnit) {
  if (!fromUnit || !toUnit || fromUnit === toUnit) return qty;
  try {
    const fromDoc = await Unit.findOne({ name: fromUnit })
      .populate("conversions.toUnit", "name").lean();
    if (fromDoc) {
      const d = (fromDoc.conversions || []).find(c => (c.toUnit?.name || c.toUnit) === toUnit);
      if (d?.quantity) return qty * d.quantity;
    }
    const toDoc = await Unit.findOne({ name: toUnit })
      .populate("conversions.toUnit", "name").lean();
    if (toDoc) {
      const r = (toDoc.conversions || []).find(c => (c.toUnit?.name || c.toUnit) === fromUnit);
      if (r?.quantity) return qty / r.quantity;
    }
    return qty;
  } catch { return qty; }
}

async function adjustStock(rawItemId, variantId, variantCombination, delta, txnMeta) {
  const raw = await RawItem.findById(rawItemId);
  if (!raw) throw new Error(`RawItem ${rawItemId} not found`);
  const prevQty = raw.quantity || 0;

  let matchedVariant = null;
  if (variantId && raw.variants?.length) matchedVariant = raw.variants.id(variantId);
  if (!matchedVariant && variantCombination?.length && raw.variants?.length) {
    matchedVariant = raw.variants.find(v =>
      v.combination?.length === variantCombination.length &&
      v.combination.every((val, i) => val === variantCombination[i])
    );
  }
  if (matchedVariant) {
    matchedVariant.quantity = Math.max(0, (matchedVariant.quantity || 0) + delta);
    matchedVariant.status =
      matchedVariant.quantity === 0 ? "Out of Stock" :
      matchedVariant.quantity <= (matchedVariant.minStock || raw.minStock || 0) ? "Low Stock" : "In Stock";
  }

  raw.quantity = Math.max(0, prevQty + delta);
  raw.status =
    raw.quantity === 0 ? "Out of Stock" :
    raw.quantity <= (raw.minStock || 0) ? "Low Stock" : "In Stock";

  raw.stockTransactions.push({
    ...txnMeta,
    previousQuantity: prevQty,
    newQuantity: raw.quantity,
    ...(matchedVariant ? { variantId, variantCombination } : {}),
  });
  await raw.save();
}

async function buildUnitConversions() {
  const units = await Unit.find({}).populate("conversions.toUnit", "name").lean();
  const map = {};
  units.forEach(u => {
    if (!map[u.name]) map[u.name] = [];
    (u.conversions || []).forEach(c => {
      const toName = c.toUnit?.name || c.toUnit;
      if (toName && c.quantity > 0) {
        map[u.name].push({ name: toName, factor: c.quantity });
        if (!map[toName]) map[toName] = [];
        if (!map[toName].some(x => x.name === u.name))
          map[toName].push({ name: u.name, factor: +(1 / c.quantity).toFixed(8) });
      }
    });
  });
  return map;
}

async function buildMrfItems(items) {
  const built = [];
  for (const it of items) {
    if (!it.rawItemId || !it.requestedQty || parseFloat(it.requestedQty) <= 0) continue;
    const raw = await RawItem.findById(it.rawItemId)
      .select("name sku unit customUnit").lean();
    if (!raw) continue;
    const baseUnit = raw.customUnit || raw.unit || "unit";
    built.push({
      rawItem:            raw._id,
      rawItemName:        raw.name,
      rawItemSku:         raw.sku || "",
      variantId:          it.variantId || null,
      variantCombination: it.variantCombination || [],
      requestedQty:       parseFloat(it.requestedQty),
      unit:               it.unit || baseUnit,
      baseUnit,
      itemStatus:         "PENDING",
    });
  }
  return built;
}

function markOverdue(mrfs) {
  const now = new Date();
  mrfs.forEach(mrf => {
    if (mrf.requestType === "TIME_BASED" && mrf.deadline && new Date(mrf.deadline) < now) {
      mrf.items.forEach(item => {
        if (item.itemStatus === "ISSUED") item.itemStatus = "OVERDUE";
      });
    }
  });
}

// ── GET /data/raw-items ───────────────────────────────────────────────────────
router.get("/data/raw-items", async (req, res) => {
  try {
    const { search = "" } = req.query;
    const filter = search
      ? { $or: [{ name: { $regex: search, $options: "i" } }, { sku: { $regex: search, $options: "i" } }] }
      : {};
    const items = await RawItem.find(filter)
      .select("name sku unit customUnit quantity variants")
      .sort({ name: 1 }).limit(50).lean();
    const unitMap = await buildUnitConversions();
    const formatted = items.map(item => {
      const baseUnit = item.customUnit || item.unit || "unit";
      return {
        _id: item._id, name: item.name, sku: item.sku, baseUnit,
        quantity: item.quantity || 0,
        conversions: unitMap[baseUnit] || [],
        variants: (item.variants || []).map(v => ({
          _id: v._id, combination: v.combination || [],
          quantity: v.quantity || 0, sku: v.sku || "", status: v.status || "Out of Stock",
        })),
      };
    });
    res.json({ success: true, rawItems: formatted });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET /data/employees ───────────────────────────────────────────────────────
router.get("/data/employees", async (req, res) => {
  try {
    const { search = "" } = req.query;
    if (!search.trim()) return res.json({ success: true, employees: [] });
    const s = search.trim();
    const filter = {
      $or: [
        { firstName:   { $regex: s, $options: "i" } },
        { middleName:  { $regex: s, $options: "i" } },
        { lastName:    { $regex: s, $options: "i" } },
        { biometricId: { $regex: s, $options: "i" } },
        { identityId:  { $regex: s, $options: "i" } },
        { email:       { $regex: s, $options: "i" } },
        { name:        { $regex: s, $options: "i" } },  // fallback for single-field name
        {
          $expr: {
            $regexMatch: {
              input: { $trim: { input: { $concat: [
                { $ifNull: ["$firstName",""] }, " ",
                { $ifNull: ["$middleName",""] }, " ",
                { $ifNull: ["$lastName",""] }
              ]}}},
              regex: s, options: "i"
            }
          }
        }
      ],
      isActive: { $ne: false },
    };
    const employees = await Employee.find(filter)
      .select("firstName middleName lastName name biometricId identityId email department designation")
      .limit(20).lean();
    res.json({
      success: true,
      employees: employees.map(e => ({
        _id:         e._id,
        fullName:    buildFullName(e),
        biometricId: e.biometricId || e.identityId || "",
        department:  e.department || "",
        email:       e.email || "",
        designation: e.designation || "",
      })),
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET / — list MRFs ─────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const {
      status, requestType, creationMode, priority,
      page = 1, limit = 20, search = ""
    } = req.query;

    // Simple rule: only scope to own MRFs if role is explicitly "employee"
    // All other roles (projectManager, admin, store, ceo, etc.) see everything
    const filter = {};
    if (req.user.role === "employee") {
      filter.requestedFor = req.user.id;
    }

    if (status)       filter.status       = status;
    if (requestType)  filter.requestType  = requestType;
    if (creationMode) filter.creationMode = creationMode;
    if (priority)     filter.priority     = priority;
    if (search) {
      filter.$or = [
        { mrfNumber:        { $regex: search, $options: "i" } },
        { requestedForName: { $regex: search, $options: "i" } },
        { requestedForId:   { $regex: search, $options: "i" } },
        { reason:           { $regex: search, $options: "i" } },
        { costCentre:       { $regex: search, $options: "i" } },
        { projectReference: { $regex: search, $options: "i" } },
      ];
    }

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await MRF.countDocuments(filter);
    const mrfs  = await MRF.find(filter)
      .sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit))
      .populate("requestedFor", "firstName middleName lastName biometricId identityId name department")
      .populate("approvedBy",   "firstName lastName name")
      .populate("rejectedBy",   "firstName lastName name")
      .lean();

    mrfs.forEach(mrf => {
      if (mrf.requestedFor && typeof mrf.requestedFor === "object") {
        mrf.requestedFor._fullName = buildFullName(mrf.requestedFor);
      }
    });
    markOverdue(mrfs);

    // Stats — no filter, always global counts for the store dashboard
    const statsAgg = await MRF.aggregate([
      { $group: {
        _id: null,
        total:    { $sum: 1 },
        pending:  { $sum: { $cond: [{ $eq: ["$status","PENDING"]  }, 1, 0] } },
        approved: { $sum: { $cond: [{ $eq: ["$status","APPROVED"] }, 1, 0] } },
        issued:   { $sum: { $cond: [{ $in: ["$status",["ISSUED","PARTIALLY_ISSUED"]] }, 1, 0] } },
        bypass:   { $sum: { $cond: [{ $eq: ["$creationMode","BYPASS"] }, 1, 0] } },
      }},
    ]);
    const stats = statsAgg[0] || { total:0, pending:0, approved:0, issued:0, bypass:0 };
    delete stats._id;

    res.json({
      success: true, mrfs, stats,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(total/parseInt(limit)) },
    });
  } catch (e) { console.error("[MRF GET /]", e); res.status(500).json({ success: false, message: e.message }); }
});

// ── GET /:id ──────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const mrf = await MRF.findById(req.params.id)
      .populate("requestedFor", "firstName middleName lastName biometricId identityId name department email designation")
      .populate("approvedBy",   "firstName lastName name")
      .populate("rejectedBy",   "firstName lastName name")
      .lean();
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });
    if (mrf.requestedFor && typeof mrf.requestedFor === "object")
      mrf.requestedFor._fullName = buildFullName(mrf.requestedFor);
    markOverdue([mrf]);
    res.json({ success: true, mrf });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── POST / — employee creates own MRF ────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const { requestType, deadline, reason="", priority="NORMAL", costCentre="", projectReference="", items } = req.body;
    if (!["TIME_BASED","USES_BASED"].includes(requestType))
      return res.status(400).json({ success: false, message: "Invalid requestType" });
    if (requestType === "TIME_BASED" && !deadline)
      return res.status(400).json({ success: false, message: "Deadline required for TIME_BASED" });
    if (!items?.length)
      return res.status(400).json({ success: false, message: "At least one item required" });

    const builtItems = await buildMrfItems(items);
    if (!builtItems.length)
      return res.status(400).json({ success: false, message: "No valid items found" });

    const actorId = getActorId(req);
    const employee = await Employee.findOne({
      $or: [{ _id: actorId }, { biometricId: req.user.id }, { identityId: req.user.id }]
    }).select("firstName middleName lastName name biometricId identityId department").lean();

    const fullName    = buildFullName(employee) || req.user.name || "";
    const biometricId = employee?.biometricId || employee?.identityId || "";

    const mrf = new MRF({
      requestedFor:     employee?._id || actorId,
      requestedForName: fullName,
      requestedForDept: employee?.department || "",
      requestedForId:   biometricId,
      creationMode:     "SELF",
      createdByRef:     employee?._id || actorId,
      createdByModel:   "Employee",
      createdByName:    fullName,
      requestType,
      deadline: requestType === "TIME_BASED" ? new Date(deadline) : null,
      reason, priority, costCentre, projectReference,
      status: "PENDING",
      items:  builtItems,
    });
    await mrf.save();
    res.status(201).json({ success: true, message: "MRF created", mrf });
  } catch (e) { console.error("[MRF POST /]", e); res.status(500).json({ success: false, message: e.message }); }
});

// ── POST /bypass ──────────────────────────────────────────────────────────────
// Frontend sends: { employeeMongoId, requestType, deadline?, reason, priority?, items }
router.post("/bypass", async (req, res) => {
  try {
    const {
      employeeMongoId,   // ← frontend sends this (MongoDB _id of the employee)
      requestType, deadline, reason="",
      priority="NORMAL", costCentre="", projectReference="", items,
    } = req.body;

    if (!employeeMongoId)
      return res.status(400).json({ success: false, message: "employeeMongoId is required" });
    if (!["TIME_BASED","USES_BASED"].includes(requestType))
      return res.status(400).json({ success: false, message: "Invalid requestType" });
    if (requestType === "TIME_BASED" && !deadline)
      return res.status(400).json({ success: false, message: "Deadline required for TIME_BASED" });
    if (!items?.length)
      return res.status(400).json({ success: false, message: "At least one item required" });

    const employee = await Employee.findById(employeeMongoId)
      .select("firstName middleName lastName name biometricId identityId email department designation").lean();
    if (!employee)
      return res.status(404).json({ success: false, message: "Employee not found" });

    const builtItems = await buildMrfItems(items);
    if (!builtItems.length)
      return res.status(400).json({ success: false, message: "No valid items found" });

    const actorId     = getActorId(req);
    const empFullName = buildFullName(employee);
    const biometricId = employee.biometricId || employee.identityId || "";

    const mrf = new MRF({
      requestedFor:     employee._id,
      requestedForName: empFullName,
      requestedForDept: employee.department || "",
      requestedForId:   biometricId,
      creationMode:     "BYPASS",
      createdByRef:     actorId,           // ← PM's ObjectId, not a string
      createdByModel:   "ProjectManager",
      createdByName:    req.user.name || "",
      requestType,
      deadline: requestType === "TIME_BASED" ? new Date(deadline) : null,
      reason, priority, costCentre, projectReference,
      status:     "APPROVED",
      items:      builtItems.map(i => ({ ...i, itemStatus: "APPROVED" })),
      approvedBy: actorId,
      approvedAt: new Date(),
      storeNotes: `Bypass MRF raised by ${req.user.name || "Store"}`,
    });
    await mrf.save();
    res.status(201).json({ success: true, message: "Bypass MRF created & auto-approved", mrf });
  } catch (e) { console.error("[MRF POST /bypass]", e); res.status(500).json({ success: false, message: e.message }); }
});

// ── PATCH /:id/approve ────────────────────────────────────────────────────────
router.patch("/:id/approve", async (req, res) => {
  try {
    const mrf = await MRF.findById(req.params.id);
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });
    if (mrf.status !== "PENDING")
      return res.status(400).json({ success: false, message: `Cannot approve — status is ${mrf.status}` });

    const { storeNotes, itemApprovals } = req.body;
    if (storeNotes) mrf.storeNotes = storeNotes;

    if (itemApprovals && typeof itemApprovals === "object") {
      mrf.items.forEach(item => {
        const decision = itemApprovals[String(item._id)];
        item.itemStatus = decision === "REJECTED" ? "REJECTED" : "APPROVED";
      });
    } else {
      mrf.items.forEach(item => { item.itemStatus = "APPROVED"; });
    }

    if (mrf.items.every(i => i.itemStatus === "REJECTED"))
      return res.status(400).json({ success: false, message: "At least one item must be approved." });

    mrf.status     = "APPROVED";
    mrf.approvedBy = getActorId(req);
    mrf.approvedAt = new Date();
    await mrf.save();
    res.json({ success: true, message: "MRF approved", mrf });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── PATCH /:id/reject ─────────────────────────────────────────────────────────
router.patch("/:id/reject", async (req, res) => {
  try {
    const mrf = await MRF.findById(req.params.id);
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });
    if (!["PENDING","APPROVED"].includes(mrf.status))
      return res.status(400).json({ success: false, message: `Cannot reject — status is ${mrf.status}` });

    mrf.status        = "REJECTED";
    mrf.rejectedBy    = getActorId(req);
    mrf.rejectedAt    = new Date();
    mrf.rejectionNote = req.body.rejectionNote || "";
    mrf.items.forEach(i => { if (i.itemStatus !== "ISSUED") i.itemStatus = "REJECTED"; });
    await mrf.save();
    res.json({ success: true, message: "MRF rejected", mrf });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── PATCH /:id/cancel ─────────────────────────────────────────────────────────
router.patch("/:id/cancel", async (req, res) => {
  try {
    const mrf = await MRF.findById(req.params.id);
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });
    if (!["PENDING","APPROVED"].includes(mrf.status))
      return res.status(400).json({ success: false, message: "Only PENDING or APPROVED MRFs can be cancelled" });

    mrf.status           = "CANCELLED";
    mrf.cancelledBy      = getActorId(req);
    mrf.cancelledByModel = req.user.role === "employee" ? "Employee" : "ProjectManager";
    mrf.cancelledAt      = new Date();
    mrf.cancellationNote = req.body.cancellationNote || "";
    mrf.items.forEach(i => { if (i.itemStatus !== "ISSUED") i.itemStatus = "REJECTED"; });
    await mrf.save();
    res.json({ success: true, message: "MRF cancelled", mrf });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── POST /:id/issue ───────────────────────────────────────────────────────────
router.post("/:id/issue", async (req, res) => {
  try {
    const { items=[], storeNotes="" } = req.body;
    const mrf = await MRF.findById(req.params.id);
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });
    if (!["APPROVED","PARTIALLY_ISSUED"].includes(mrf.status))
      return res.status(400).json({ success: false, message: `Cannot issue — status is ${mrf.status}` });

    for (const line of items) {
      const mrfItem   = mrf.items.id(line.itemId);
      if (!mrfItem) continue;
      const issuedQty = parseFloat(line.issuedQty) || 0;
      if (issuedQty <= 0) continue;

      const deductQty = await convertQty(issuedQty, mrfItem.unit, mrfItem.baseUnit);
      await adjustStock(
        mrfItem.rawItem, mrfItem.variantId, mrfItem.variantCombination, -deductQty,
        {
          type:        mrfItem.variantId ? "VARIANT_REDUCE" : "REDUCE",
          quantity:    deductQty,
          reason:      `MRF Issue — ${mrf.mrfNumber}`,
          notes:       `Issued to ${mrf.requestedForName} (${mrf.requestedForDept}). MRF: ${mrf.mrfNumber}`,
          performedBy: getActorId(req),
        }
      );
      mrfItem.issuedQty   += issuedQty;
      mrfItem.consumedQty  = mrfItem.issuedQty - mrfItem.returnedQty;
      mrfItem.itemStatus   = "ISSUED";
      if (line.storeNotes) mrfItem.storeNotes = line.storeNotes;
    }

    if (storeNotes) mrf.storeNotes = storeNotes;
    const allIssued  = mrf.items.every(i => ["ISSUED","REJECTED"].includes(i.itemStatus));
    const someIssued = mrf.items.some(i => i.itemStatus === "ISSUED");
    mrf.status = allIssued ? "ISSUED" : someIssued ? "PARTIALLY_ISSUED" : mrf.status;
    await mrf.save();
    res.json({ success: true, message: "Materials issued", mrf });
  } catch (e) { console.error("[MRF issue]", e); res.status(500).json({ success: false, message: e.message }); }
});

// ── POST /:id/items/:itemId/return ────────────────────────────────────────────
router.post("/:id/items/:itemId/return", async (req, res) => {
  try {
    const { returnedQty, notes="" } = req.body;
    const qty = parseFloat(returnedQty) || 0;
    if (qty <= 0) return res.status(400).json({ success: false, message: "returnedQty must be > 0" });

    const mrf = await MRF.findById(req.params.id);
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });
    const mrfItem = mrf.items.id(req.params.itemId);
    if (!mrfItem) return res.status(404).json({ success: false, message: "Item not found in MRF" });

    const maxReturn = mrfItem.issuedQty - mrfItem.returnedQty;
    if (qty > maxReturn + 0.001)
      return res.status(400).json({ success: false, message: `Cannot return ${qty} — max returnable is ${maxReturn.toFixed(3)} ${mrfItem.unit}` });

    const creditQty = await convertQty(qty, mrfItem.unit, mrfItem.baseUnit);
    await adjustStock(
      mrfItem.rawItem, mrfItem.variantId, mrfItem.variantCombination, +creditQty,
      {
        type:        mrfItem.variantId ? "VARIANT_ADD" : "ADD",
        quantity:    creditQty,
        reason:      `MRF Return — ${mrf.mrfNumber}`,
        notes:       notes || `Return from ${mrf.requestedForName}. MRF: ${mrf.mrfNumber}`,
        performedBy: getActorId(req),
      }
    );

    mrfItem.returnedQty += qty;
    mrfItem.consumedQty  = mrfItem.issuedQty - mrfItem.returnedQty;
    mrfItem.returnHistory.push({
      returnedQty: qty, notes,
      recordedBy: getActorId(req), recordedByModel: "ProjectManager",
    });

    const fullyReturned = mrfItem.returnedQty >= mrfItem.issuedQty - 0.001;
    mrfItem.itemStatus  = fullyReturned ? "RETURNED" : "PARTIALLY_RETURNED";

    const allReturned  = mrf.items.every(i => ["RETURNED","REJECTED"].includes(i.itemStatus));
    const someReturned = mrf.items.some(i => ["RETURNED","PARTIALLY_RETURNED"].includes(i.itemStatus));
    mrf.status = allReturned ? "COMPLETED" : someReturned ? "PARTIALLY_RETURNED" : mrf.status;

    await mrf.save();
    res.json({ success: true, message: `${qty} ${mrfItem.unit} returned & stock credited`, mrf });
  } catch (e) { console.error("[MRF return]", e); res.status(500).json({ success: false, message: e.message }); }
});


router.get("/:id/stock-check", async (req, res) => {
  try {
    const mrf = await MRF.findById(req.params.id)
      .populate(
        "requestedFor",
        "firstName middleName lastName name biometricId identityId department designation email phone"
      )
      .populate("approvedBy", "firstName lastName name")
      .lean();
 
    if (!mrf) return res.status(404).json({ success: false, message: "MRF not found" });
 
    // Attach resolved full name
    if (mrf.requestedFor && typeof mrf.requestedFor === "object") {
      mrf.requestedFor._fullName = buildFullName(mrf.requestedFor);
    }
 
    // Mark overdue flag (reuse existing helper)
    markOverdue([mrf]);
 
    // ── Live stock lookup for each item ──────────────────────────────────
    const rawItemIds = [
      ...new Set(mrf.items.map(i => i.rawItem?.toString()).filter(Boolean)),
    ];
 
    const rawDocs = rawItemIds.length
      ? await RawItem.find({ _id: { $in: rawItemIds } })
          .select("name quantity unit customUnit variants minStock")
          .lean()
      : [];
 
    const rawDocMap = new Map(rawDocs.map(r => [r._id.toString(), r]));
 
    const itemsWithStock = mrf.items.map(item => {
      const doc = rawDocMap.get(item.rawItem?.toString());
      let available = null;
      let minStock  = 0;
 
      if (doc) {
        // Variant-level stock first
        if (item.variantId && Array.isArray(doc.variants)) {
          const v = doc.variants.find(
            vv => vv._id?.toString() === item.variantId?.toString()
          );
          if (v) {
            available = v.quantity ?? 0;
            minStock  = v.minStock ?? doc.minStock ?? 0;
          }
        }
        // Fall back to product-level stock
        if (available === null) {
          available = doc.quantity ?? 0;
          minStock  = doc.minStock ?? 0;
        }
      }
 
      const requestedQty     = item.requestedQty || 0;
      const issuedQty        = item.issuedQty    || 0;
      const returnedQty      = item.returnedQty  || 0;
      const shortfall        = available !== null ? Math.max(0, requestedQty - available) : null;
      const remainingToIssue = Math.max(0, requestedQty - issuedQty);
 
      let stockStatus = "unknown";
      if (available !== null) {
        if (available <= 0)              stockStatus = "out_of_stock";
        else if (shortfall > 0)          stockStatus = "shortage";
        else if (available - requestedQty <= minStock) stockStatus = "low";
        else                             stockStatus = "ok";
      }
 
      return {
        ...item,
        // Live stock fields appended
        available,
        shortfall,
        minStock,
        stockStatus,
        remainingToIssue,
        returnedQty,
      };
    });
 
    return res.json({
      success: true,
      mrf,
      itemsWithStock,
    });
  } catch (err) {
    console.error("MRF stock-check error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;