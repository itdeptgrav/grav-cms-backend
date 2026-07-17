// routes/CMS_Routes/Inventory/Operations/coworkMrfRoutes.js
// ──────────────────────────────────────────────────────────────────────────────
// MRF endpoints for the COWORK side (employee-facing).
// Uses verifyCoworkToken (Firebase) instead of EmployeeAuthMiddleware.
//
// Mount in your main Express app:
//   const { verifyCoworkToken, verifyEmployeeToken } = require("./Middlewear/coworkAuth");
//   app.use("/api/cowork/mrf", require("./routes/CMS_Routes/Inventory/Operations/coworkMrfRoutes"));
//
// req.coworkUser = { employeeId, role, name, authUid, employeeData }
//   employeeId = biometricId string (e.g. "GR022")
//   role       = "employee" | "tl" | "ceo"
// ──────────────────────────────────────────────────────────────────────────────

const express  = require("express")
const router   = express.Router()
const mongoose = require("mongoose")
const MRF      = require("../../../../models/CMS_Models/Inventory/Operations/MRF")
const RawItem  = require("../../../../models/CMS_Models/Inventory/Products/RawItem")
const Unit     = require("../../../../models/CMS_Models/Inventory/Configurations/Unit")
const Employee = require("../../../../models/Employee")
const NotificationService = require("../../../../services/NotificationService")
const RawItemAddRequest = require("../../../../models/CMS_Models/Inventory/Operations/RawItemAddRequest")


const {
  verifyCoworkToken,
  verifyEmployeeToken,
} = require("../../../../Middlewear/coworkAuth")

router.use(verifyCoworkToken)
router.use(verifyEmployeeToken)

// ── Normalise coworkUser → standard user shape used by helpers ────────────────
// Attach req.user so all helpers below work identically to the store-side routes
router.use((req, _res, next) => {
  req.user = {
    id:   req.coworkUser.employeeId,  // biometricId string
    role: req.coworkUser.role,
    name: req.coworkUser.name,
  }
  next()
})

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (copied from mrfRoutes.js — keeping them local avoids coupling)
// ─────────────────────────────────────────────────────────────────────────────

function buildFullName(emp) {
  if (!emp) return ""
  return [emp.firstName, emp.middleName, emp.lastName]
    .filter(Boolean).join(" ").trim() || emp.email || ""
}

async function convertQty(qty, fromUnit, toUnit) {
  if (!fromUnit || !toUnit || fromUnit === toUnit) return qty
  try {
    const fromDoc = await Unit.findOne({ name: fromUnit }).populate("conversions.toUnit","name").lean()
    if (fromDoc) {
      const d = (fromDoc.conversions||[]).find(c=>(c.toUnit?.name||c.toUnit)===toUnit)
      if (d?.quantity) return qty * d.quantity
    }
    const toDoc = await Unit.findOne({ name: toUnit }).populate("conversions.toUnit","name").lean()
    if (toDoc) {
      const r = (toDoc.conversions||[]).find(c=>(c.toUnit?.name||c.toUnit)===fromUnit)
      if (r?.quantity) return qty / r.quantity
    }
    return qty
  } catch { return qty }
}

async function adjustStock(rawItemId, variantId, variantCombination, delta, txnMeta) {
  const raw = await RawItem.findById(rawItemId)
  if (!raw) throw new Error(`RawItem ${rawItemId} not found`)
  const prevQty = raw.quantity || 0

  let matchedVariant = null
  if (variantId && raw.variants?.length) matchedVariant = raw.variants.id(variantId)
  if (!matchedVariant && variantCombination?.length && raw.variants?.length) {
    matchedVariant = raw.variants.find(v =>
      v.combination?.length === variantCombination.length &&
      v.combination.every((val,i) => val === variantCombination[i])
    )
  }
  if (matchedVariant) {
    matchedVariant.quantity = Math.max(0,(matchedVariant.quantity||0)+delta)
    matchedVariant.status   =
      matchedVariant.quantity===0 ? "Out of Stock" :
      matchedVariant.quantity<=(matchedVariant.minStock||raw.minStock||0) ? "Low Stock" : "In Stock"
  }
  raw.quantity = Math.max(0, prevQty+delta)
  raw.status   = raw.quantity===0 ? "Out of Stock" : raw.quantity<=(raw.minStock||0) ? "Low Stock" : "In Stock"
  raw.stockTransactions.push({
    ...txnMeta,
    previousQuantity: prevQty, newQuantity: raw.quantity,
    ...(matchedVariant ? {variantId, variantCombination} : {}),
  })
  await raw.save()
}

async function buildUnitConversions() {
  const units = await Unit.find({}).populate("conversions.toUnit","name").lean()
  const map = {}
  // Pass 1 — forward
  units.forEach(u => {
    if (!map[u.name]) map[u.name] = []
    ;(u.conversions||[]).forEach(c => {
      const toName = c.toUnit?.name || c.toUnit
      if (toName && c.quantity>0) map[u.name].push({ name:toName, factor:c.quantity })
    })
  })
  // Pass 2 — reverse (e.g. 1 packet=10pcs → pcs→0.1packet)
  units.forEach(u => {
    ;(u.conversions||[]).forEach(c => {
      const toName = c.toUnit?.name || c.toUnit
      if (!toName || !c.quantity || c.quantity<=0) return
      if (!map[toName]) map[toName] = []
      if (!map[toName].some(x=>x.name===u.name))
        map[toName].push({ name:u.name, factor:+(1/c.quantity).toFixed(8) })
    })
  })
  return map
}

async function buildMrfItems(items) {
  const built = []
  for (const it of items) {
    if (!it.rawItemId || !it.requestedQty || parseFloat(it.requestedQty)<=0) continue
    const raw = await RawItem.findById(it.rawItemId).select("name sku unit customUnit").lean()
    if (!raw) continue
    const baseUnit = raw.customUnit || raw.unit || "unit"
    built.push({
      rawItem:            raw._id,
      rawItemName:        raw.name,
      rawItemSku:         raw.sku || "",
      variantId:          it.variantId || null,
      variantCombination: it.variantCombination || [],
      requestedQty:       parseFloat(it.requestedQty),
      unit:               it.unit || baseUnit,
      baseUnit,
      itemStatus: "PENDING",
    })
  }
  return built
}

function markOverdue(mrfs) {
  const now = new Date()
  mrfs.forEach(mrf => {
    if (mrf.requestType==="TIME_BASED" && mrf.deadline && new Date(mrf.deadline)<now) {
      mrf.items.forEach(item => { if (item.itemStatus==="ISSUED") item.itemStatus="OVERDUE" })
    }
  })
}

// Resolve biometricId string → MongoDB Employee _id
async function resolveEmployeeId(biometricId) {
  const emp = await Employee.findOne({
    $or: [{ biometricId }, { identityId: biometricId }]
  }).select("_id firstName middleName lastName department biometricId identityId").lean()
  return emp
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /data/raw-items
// ─────────────────────────────────────────────────────────────────────────────
router.get("/data/categories", async (req, res) => {
  try {
    const categories = await RawItem.distinct("category")
    res.json({ success: true, categories: categories.filter(Boolean).sort() })
  } catch (err) { res.status(500).json({ success: false, message: err.message }) }
})

router.get("/data/units", async (req, res) => {
  try {
    const units = await Unit.distinct("name")
    res.json({ success: true, units: units.filter(Boolean).sort() })
  } catch (err) { res.status(500).json({ success: false, message: err.message }) }
})

router.get("/data/raw-items", async (req, res) => {
  try {
    const { search="" } = req.query
    const filter = search
      ? { $or:[{name:{$regex:search,$options:"i"}},{sku:{$regex:search,$options:"i"}}] }
      : {}
    const items = await RawItem.find(filter)
      .select("name sku unit customUnit quantity variants")
      .sort({name:1}).limit(50).lean()
    const unitMap = await buildUnitConversions()
    const formatted = items.map(item => {
      const baseUnit = item.customUnit || item.unit || "unit"
      return {
        _id:         item._id,
        name:        item.name,
        sku:         item.sku,
        baseUnit,
        quantity:    item.quantity||0,
        conversions: unitMap[baseUnit] || [],
        variants:    (item.variants||[]).map(v=>({
          _id:         v._id,
          combination: v.combination||[],
          quantity:    v.quantity||0,
          sku:         v.sku||"",
          status:      v.status||"Out of Stock",
        })),
      }
    })
    res.json({ success:true, rawItems:formatted })
  } catch(err) {
    res.status(500).json({ success:false, message:err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /  — employee sees only their own MRFs
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const { status, requestType, priority, page=1, limit=20 } = req.query

    // Always scope to this employee — resolve biometricId → _id
    const emp = await resolveEmployeeId(req.user.id)
    if (!emp) return res.json({ success:true, mrfs:[], stats:{total:0,pending:0,approved:0,issued:0}, pagination:{total:0,page:1,totalPages:1} })

    const filter = { requestedFor: emp._id }
    if (status)      filter.status      = status
    if (requestType) filter.requestType = requestType
    if (priority)    filter.priority    = priority

    const skip   = (parseInt(page)-1)*parseInt(limit)
    const total  = await MRF.countDocuments(filter)
    const mrfs   = await MRF.find(filter)
      .sort({ createdAt:-1 }).skip(skip).limit(parseInt(limit))
      .lean()

    markOverdue(mrfs)

    const statsAgg = await MRF.aggregate([
      { $match: { requestedFor: emp._id } },
      { $group: {
        _id:null,
        total:    {$sum:1},
        pending:  {$sum:{$cond:[{$eq:["$status","PENDING"]},1,0]}},
        approved: {$sum:{$cond:[{$eq:["$status","APPROVED"]},1,0]}},
        issued:   {$sum:{$cond:[{$in:["$status",["ISSUED","PARTIALLY_ISSUED"]]},1,0]}},
      }},
    ])
    const stats = statsAgg[0] || {total:0,pending:0,approved:0,issued:0}
    delete stats._id

    res.json({ success:true, mrfs, stats, pagination:{total,page:parseInt(page),limit:parseInt(limit),totalPages:Math.ceil(total/parseInt(limit))} })
  } catch(err) {
    console.error("[CoworkMRF GET /]", err)
    res.status(500).json({ success:false, message:err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /  — employee creates their own MRF
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const { requestType, deadline, reason="", priority="NORMAL", items } = req.body

    if (!["TIME_BASED","USES_BASED"].includes(requestType))
      return res.status(400).json({ success:false, message:"Invalid requestType" })
    if (requestType==="TIME_BASED" && !deadline)
      return res.status(400).json({ success:false, message:"Deadline required for TIME_BASED" })
    if (!items?.length)
      return res.status(400).json({ success:false, message:"At least one item required" })

    const builtItems = await buildMrfItems(items)
    if (!builtItems.length)
      return res.status(400).json({ success:false, message:"No valid items found" })

    // Resolve employee identity
    const emp = await resolveEmployeeId(req.user.id)
    if (!emp) return res.status(404).json({ success:false, message:"Your HR record not found. Contact HR." })

    const fullName    = buildFullName(emp)
    const biometricId = emp.biometricId || emp.identityId || req.user.id

    const mrf = new MRF({
      requestedFor:     emp._id,
      requestedForName: fullName || req.user.name || "",
      requestedForDept: emp.department || "",
      requestedForId:   biometricId,
      creationMode:     "SELF",
      createdByRef:     emp._id,
      createdByModel:   "Employee",
      createdByName:    fullName || req.user.name || "",
      requestType,
      deadline: requestType==="TIME_BASED" ? new Date(deadline) : null,
      reason, priority,
      status: "PENDING",
      items:  builtItems,
    })

    await mrf.save()

    NotificationService.sendToRole(["project_manager", "store_manager", "admin"], {
      title: "New Material Request",
      body: `${mrf.mrfNumber} — ${fullName || req.user.name} requested ${builtItems.length} item(s)`,
      type: "request",
      url: "/project-manager/dashboard/requests",
      tag: `mrf-${mrf._id}`,
    }).catch(() => {})

    res.status(201).json({ success:true, message:"MRF created", mrf })
  } catch(err) {
    console.error("[CoworkMRF POST /]", err)
    res.status(500).json({ success:false, message:err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /:id/cancel — employee cancels their own PENDING MRF
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/:id/cancel", async (req, res) => {
  try {
    const emp = await resolveEmployeeId(req.user.id)
    const mrf = await MRF.findOne({ _id:req.params.id, requestedFor:emp?._id })
    if (!mrf) return res.status(404).json({ success:false, message:"MRF not found" })
    if (mrf.status !== "PENDING")
      return res.status(400).json({ success:false, message:"Only PENDING requests can be cancelled" })

    mrf.status           = "CANCELLED"
    mrf.cancelledBy      = emp._id
    mrf.cancelledByModel = "Employee"
    mrf.cancelledAt      = new Date()
    mrf.cancellationNote = req.body.cancellationNote || "Cancelled by employee"
    mrf.items.forEach(i => { if (i.itemStatus!=="ISSUED") i.itemStatus="REJECTED" })
    await mrf.save()
    res.json({ success:true, message:"MRF cancelled", mrf })
  } catch(err) {
    res.status(500).json({ success:false, message:err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /product-requests — employee's own raw-item add requests
// ─────────────────────────────────────────────────────────────────────────────
router.get("/product-requests", async (req, res) => {
  try {
    const emp = await resolveEmployeeId(req.user.id)
    if (!emp) return res.json({ success: true, requests: [] })
    const requests = await RawItemAddRequest.find({ requestedBy: emp._id })
      .sort({ createdAt: -1 }).lean()
    res.json({ success: true, requests })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /product-requests — request the store to register new raw item(s)
// Body: { products: [{ itemName, category, unit, notes, variants: [{attributes:[{name,value}]}] }] }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/product-requests", async (req, res) => {
  try {
    const { products } = req.body
    if (!Array.isArray(products) || !products.length)
      return res.status(400).json({ success: false, message: "At least one product is required" })

    const cleaned = products
      .filter(p => p.itemName?.trim())
      .map(p => ({
        itemName: p.itemName.trim(),
        category: p.category?.trim() || "",
        unit:     p.unit?.trim() || "",
        notes:    p.notes?.trim() || "",
        variants: Array.isArray(p.variants)
          ? p.variants
              .filter(v => Array.isArray(v.attributes) && v.attributes.some(a => a.name?.trim() && a.value?.trim()))
              .map(v => ({ attributes: v.attributes.filter(a => a.name?.trim() && a.value?.trim()) }))
          : [],
      }))
    if (!cleaned.length)
      return res.status(400).json({ success: false, message: "No valid product entries found" })

    const emp = await resolveEmployeeId(req.user.id)
    if (!emp) return res.status(404).json({ success: false, message: "Your HR record not found. Contact HR." })

    const reqDoc = new RawItemAddRequest({
      requestedBy:     emp._id,
      requestedByName: buildFullName(emp) || req.user.name || "",
      requestedByDept: emp.department || "",
      products:        cleaned,
    })
    await reqDoc.save()

    NotificationService.sendToRole(["store_manager", "admin"], {
      title: "New Product Registration Request",
      body: `${reqDoc.requestedByName} requested ${cleaned.length} new item(s) be added to inventory`,
      type: "request",
      url: "/store/dashboard/product-requests",
      tag: `product-request-${reqDoc._id}`,
    }).catch(() => {})

    res.status(201).json({ success: true, message: "Request sent to store", request: reqDoc })
  } catch (err) {
    console.error("[CoworkMRF product-requests POST]", err)
    res.status(500).json({ success: false, message: err.message })
  }
})

router.get("/product-requests", async (req, res) => {
  try {
    const emp = await resolveEmployeeId(req.user.id)
    if (!emp) return res.json({ success: true, requests: [] })
    const requests = await RawItemAddRequest.find({ requestedBy: emp._id })
      .sort({ createdAt: -1 }).lean()
    res.json({ success: true, requests })
  } catch (err) { res.status(500).json({ success: false, message: err.message }) }
})

// Body: { products: [{ itemName, category, unit, notes, attributes:[{name,values:[]}] }] }
router.post("/product-requests", async (req, res) => {
  try {
    const { products } = req.body
    if (!Array.isArray(products) || !products.length)
      return res.status(400).json({ success: false, message: "At least one product is required" })

    const cleaned = products
      .filter(p => p.itemName?.trim())
      .map(p => ({
        itemName: p.itemName.trim(),
        category: p.category?.trim() || "",
        unit:     p.unit?.trim() || "",
        notes:    p.notes?.trim() || "",
        attributes: Array.isArray(p.attributes)
          ? p.attributes
              .filter(a => a.name?.trim() && Array.isArray(a.values) && a.values.some(v => v?.trim()))
              .map(a => ({ name: a.name.trim(), values: a.values.filter(v => v?.trim()) }))
          : [],
      }))
    if (!cleaned.length)
      return res.status(400).json({ success: false, message: "No valid product entries found" })

    const emp = await resolveEmployeeId(req.user.id)
    if (!emp) return res.status(404).json({ success: false, message: "Your HR record not found. Contact HR." })

    const reqDoc = new RawItemAddRequest({
      requestedBy:     emp._id,
      requestedByName: buildFullName(emp) || req.user.name || "",
      requestedByDept: emp.department || "",
      products:        cleaned,
    })
    await reqDoc.save()

    NotificationService.sendToRole(["store_manager", "admin"], {
      title: "New Product Registration Request",
      body: `${reqDoc.requestedByName} requested ${cleaned.length} new item(s) be added to inventory`,
      type: "request",
      url: "/store/dashboard/product-requests",
      tag: `product-request-${reqDoc._id}`,
    }).catch(() => {})

    res.status(201).json({ success: true, message: "Request sent to store", request: reqDoc })
  } catch (err) {
    console.error("[CoworkMRF product-requests POST]", err)
    res.status(500).json({ success: false, message: err.message })
  }
})

module.exports = router