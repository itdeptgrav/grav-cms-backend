// routes/CMS_Routes/Inventory/Configurations/operations.js
//
// Mount in server.js:
//   const operationsRoutes = require("./routes/CMS_Routes/Inventory/Configurations/operations")
//   app.use("/api/cms", operationsRoutes)

const express = require("express")
const router = express.Router()
const Operation      = require("../../../../models/CMS_Models/Inventory/Configurations/Operation")
const OperationCode  = require("../../../../models/CMS_Models/Inventory/Configurations/OperationCode")
const OperationGroup = require("../../../../models/CMS_Models/Inventory/Configurations/OperationGroup")
const MachineType    = require("../../../../models/CMS_Models/Inventory/Configurations/MachineType")
const StockItem      = require("../../../../models/CMS_Models/Inventory/Products/StockItem")
const Employee       = require("../../../../models/Employee")
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear")
const { recordChange } = require("../../../../services/changeLog")
// Reused rather than duplicated — see stockItems.js's own module.exports for
// why (26 Aug 2026: "assign the operation group to the product category...
// overwrite the operations with that operation group" — every product in the
// category needs the same cost recompute pass a normal Operations-tab save
// already runs).
const {
  updateStockItemAggregates,
  recomputeVariantCostsFromBom,
  STOCK_ITEM_CATEGORIES,
} = require("../Products/stockItems")

router.use(EmployeeAuthMiddleware)

/* ─────────────────────────────────────────────────────────────────────────────
   HELPER — after saving an operation, check every group's keyword and
   auto-assign this operation if its code starts with that keyword letter.
───────────────────────────────────────────────────────────────────────────── */
async function autoAssignToGroups(operation) {
  if (!operation.operationCode) return          // no code → nothing to match
  const code = operation.operationCode.toUpperCase()

  // Find all groups that have a keyword and whose keyword is a prefix of the code
  const groups = await OperationGroup.find({ keyword: { $ne: "" } })
  for (const group of groups) {
    if (!group.keyword) continue
    if (code.startsWith(group.keyword.toUpperCase())) {
      // Add only if not already in the list
      if (!group.operations.map(id => id.toString()).includes(operation._id.toString())) {
        group.operations.push(operation._id)
        await group.save()
      }
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   OPERATIONS
═══════════════════════════════════════════════════════════════════════════ */

// GET all operations
router.get("/operations", async (req, res) => {
  try {
    const operations = await Operation.find().sort({ createdAt: -1 })
    res.json({ success: true, operations })
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to fetch operations" })
  }
})

// GET single operation
router.get("/operations/:id", async (req, res) => {
  try {
    const op = await Operation.findById(req.params.id)
    if (!op) return res.status(404).json({ success: false, message: "Operation not found" })
    res.json({ success: true, operation: op })
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to fetch operation" })
  }
})

// POST create single operation
router.post("/operations", async (req, res) => {
  try {
    const { name, operationCode, totalSam, durationSeconds, machineType } = req.body
    if (!name || totalSam == null || !machineType) {
      return res.status(400).json({ success: false, message: "name, totalSam, and machineType are required" })
    }

    const codeUpper = (operationCode || "").trim().toUpperCase()

    const op = new Operation({
      name: name.trim(),
      operationCode: codeUpper,
      totalSam: parseFloat(totalSam),
      durationSeconds: durationSeconds ?? Math.round(parseFloat(totalSam) * 60),
      machineType: machineType.trim(),
      createdBy: req.user.id,
    })
    await op.save()

    // Auto-register machine type if not exists
    await MachineType.findOneAndUpdate(
      { name: machineType.trim() },
      { name: machineType.trim(), createdBy: req.user.id },
      { upsert: true, new: true }
    )

    // Auto-register operation code if provided and not exists
    if (codeUpper) {
      await OperationCode.findOneAndUpdate(
        { code: codeUpper },
        { code: codeUpper, createdBy: req.user.id },
        { upsert: true }
      )
    }

    // Auto-assign to matching groups
    await autoAssignToGroups(op)

    res.status(201).json({ success: true, message: "Operation created", operation: op })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "Failed to create operation" })
  }
})

// PUT update operation
router.put("/operations/:id", async (req, res) => {
  try {
    const { name, operationCode, totalSam, durationSeconds, machineType } = req.body
    const op = await Operation.findById(req.params.id)
    if (!op) return res.status(404).json({ success: false, message: "Operation not found" })

    if (name !== undefined) op.name = name.trim()
    if (operationCode !== undefined) op.operationCode = operationCode.trim().toUpperCase()
    if (totalSam != null) {
      op.totalSam = parseFloat(totalSam)
      op.durationSeconds = durationSeconds ?? Math.round(parseFloat(totalSam) * 60)
    }
    if (machineType) {
      op.machineType = machineType.trim()
      await MachineType.findOneAndUpdate(
        { name: machineType.trim() },
        { name: machineType.trim() },
        { upsert: true }
      )
    }

    // Auto-register updated code
    if (op.operationCode) {
      await OperationCode.findOneAndUpdate(
        { code: op.operationCode },
        { code: op.operationCode },
        { upsert: true }
      )
    }

    op.updatedBy = req.user.id
    await op.save()

    // Re-run auto-assign in case code changed
    await autoAssignToGroups(op)

    res.json({ success: true, message: "Operation updated", operation: op })
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to update operation" })
  }
})

// DELETE operation
router.delete("/operations/:id", async (req, res) => {
  try {
    const op = await Operation.findById(req.params.id)
    if (!op) return res.status(404).json({ success: false, message: "Operation not found" })
    await op.deleteOne()
    // Remove from all groups
    await OperationGroup.updateMany(
      { operations: req.params.id },
      { $pull: { operations: req.params.id } }
    )
    res.json({ success: true, message: "Operation deleted" })
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to delete operation" })
  }
})

// POST bulk import via CSV  (also handles the multi-row save from the UI)
router.post("/operations/import", async (req, res) => {
  try {
    const { operations } = req.body
    if (!Array.isArray(operations) || operations.length === 0) {
      return res.status(400).json({ success: false, message: "No operations provided" })
    }

    const inserted = []
    for (const row of operations) {
      if (!row.name || row.totalSam == null) continue
      const codeUpper = (row.operationCode || "").trim().toUpperCase()
      const op = new Operation({
        name: row.name.trim(),
        operationCode: codeUpper,
        totalSam: parseFloat(row.totalSam),
        durationSeconds: row.durationSeconds ?? Math.round(parseFloat(row.totalSam) * 60),
        machineType: (row.machineType || "").trim(),
        createdBy: req.user.id,
      })
      await op.save()
      inserted.push(op)

      // Auto-register machine type
      if (row.machineType && row.machineType.trim()) {
        await MachineType.findOneAndUpdate(
          { name: row.machineType.trim() },
          { name: row.machineType.trim(), createdBy: req.user.id },
          { upsert: true }
        )
      }

      // Auto-register operation code
      if (codeUpper) {
        await OperationCode.findOneAndUpdate(
          { code: codeUpper },
          { code: codeUpper, createdBy: req.user.id },
          { upsert: true }
        )
      }

      // Auto-assign to matching groups
      await autoAssignToGroups(op)
    }

    res.status(201).json({
      success: true,
      message: `${inserted.length} operations imported`,
      count: inserted.length,
    })
  } catch (err) {
    res.status(500).json({ success: false, message: "Import failed: " + err.message })
  }
})

/* ═══════════════════════════════════════════════════════════════════════════
   OPERATION CODES
═══════════════════════════════════════════════════════════════════════════ */

// GET all operation codes
router.get("/operation-codes", async (req, res) => {
  try {
    const operationCodes = await OperationCode.find().sort({ code: 1 })
    res.json({ success: true, operationCodes })
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to fetch operation codes" })
  }
})

// GET single operation code
router.get("/operation-codes/:id", async (req, res) => {
  try {
    const code = await OperationCode.findById(req.params.id)
    if (!code) return res.status(404).json({ success: false, message: "Operation code not found" })
    res.json({ success: true, operationCode: code })
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to fetch operation code" })
  }
})

// POST create operation code
router.post("/operation-codes", async (req, res) => {
  try {
    const { code, description } = req.body
    if (!code || !code.trim()) {
      return res.status(400).json({ success: false, message: "Code is required" })
    }
    const existing = await OperationCode.findOne({ code: code.trim().toUpperCase() })
    if (existing) {
      return res.status(400).json({ success: false, message: "Operation code already exists" })
    }
    const opCode = new OperationCode({
      code: code.trim().toUpperCase(),
      description: (description || "").trim(),
      createdBy: req.user.id,
    })
    await opCode.save()
    res.status(201).json({ success: true, message: "Operation code created", operationCode: opCode })
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: "Operation code already exists" })
    }
    res.status(500).json({ success: false, message: err.message || "Failed to create operation code" })
  }
})

// PUT update operation code
router.put("/operation-codes/:id", async (req, res) => {
  try {
    const { code, description } = req.body
    const opCode = await OperationCode.findById(req.params.id)
    if (!opCode) return res.status(404).json({ success: false, message: "Operation code not found" })

    if (code !== undefined) opCode.code = code.trim().toUpperCase()
    if (description !== undefined) opCode.description = description.trim()
    opCode.updatedBy = req.user.id
    await opCode.save()
    res.json({ success: true, message: "Operation code updated", operationCode: opCode })
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: "Operation code already exists" })
    }
    res.status(500).json({ success: false, message: "Failed to update operation code" })
  }
})

// DELETE operation code
router.delete("/operation-codes/:id", async (req, res) => {
  try {
    const opCode = await OperationCode.findById(req.params.id)
    if (!opCode) return res.status(404).json({ success: false, message: "Operation code not found" })
    await opCode.deleteOne()
    res.json({ success: true, message: "Operation code deleted" })
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to delete operation code" })
  }
})

// POST bulk import operation codes via CSV
router.post("/operation-codes/import", async (req, res) => {
  try {
    const { codes } = req.body
    if (!Array.isArray(codes) || codes.length === 0) {
      return res.status(400).json({ success: false, message: "No codes provided" })
    }

    let inserted = 0, skipped = 0
    for (const row of codes) {
      if (!row.code || !row.code.trim()) { skipped++; continue }
      const result = await OperationCode.findOneAndUpdate(
        { code: row.code.trim().toUpperCase() },
        { code: row.code.trim().toUpperCase(), description: (row.description || "").trim(), createdBy: req.user.id },
        { upsert: true, new: true }
      )
      if (result) inserted++
    }

    res.status(201).json({
      success: true,
      message: `${inserted} operation codes imported (${skipped} skipped)`,
      count: inserted,
    })
  } catch (err) {
    res.status(500).json({ success: false, message: "Import failed: " + err.message })
  }
})

/* ═══════════════════════════════════════════════════════════════════════════
   OPERATION GROUPS
═══════════════════════════════════════════════════════════════════════════ */

// GET all groups
router.get("/operation-groups", async (req, res) => {
  try {
    const groups = await OperationGroup.find()
      .populate("operations", "name operationCode totalSam durationSeconds machineType")
      .sort({ createdAt: -1 })
    res.json({ success: true, groups })
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to fetch groups" })
  }
})

// POST create group
// Body: { name, keyword, operations }
// keyword: single letter prefix — any existing & future operations whose code
//          starts with this letter are auto-assigned.
router.post("/operation-groups", async (req, res) => {
  try {
    const { name, keyword, operations } = req.body
    if (!name) {
      return res.status(400).json({ success: false, message: "Group name is required" })
    }
    const existing = await OperationGroup.findOne({ name: name.trim() })
    if (existing) {
      return res.status(400).json({ success: false, message: "Group with this name already exists" })
    }

    const keywordUpper = (keyword || "").trim().toUpperCase()

    // Start with manually selected operations
    let opIds = Array.isArray(operations) ? [...operations] : []

    // If a keyword is given, also find all existing operations that match
    if (keywordUpper) {
      const matched = await Operation.find({
        operationCode: { $regex: `^${keywordUpper}`, $options: "i" }
      }).select("_id")
      matched.forEach(op => {
        if (!opIds.includes(op._id.toString())) {
          opIds.push(op._id)
        }
      })
    }

    const group = new OperationGroup({
      name: name.trim(),
      keyword: keywordUpper,
      operations: opIds,
      createdBy: req.user.id,
    })
    await group.save()

    const populated = await OperationGroup.findById(group._id)
      .populate("operations", "name operationCode totalSam durationSeconds machineType")
    res.status(201).json({ success: true, message: "Group created", group: populated })
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to create group: " + err.message })
  }
})

// PUT update group
router.put("/operation-groups/:id", async (req, res) => {
  try {
    const { name, keyword, operations } = req.body
    const group = await OperationGroup.findById(req.params.id)
    if (!group) return res.status(404).json({ success: false, message: "Group not found" })

    if (name) group.name = name.trim()

    const keywordUpper = keyword !== undefined
      ? (keyword || "").trim().toUpperCase()
      : group.keyword

    group.keyword = keywordUpper

    let opIds = Array.isArray(operations) ? [...operations] : group.operations.map(id => id.toString())

    // Re-apply keyword matching against current operations DB
    if (keywordUpper) {
      const matched = await Operation.find({
        operationCode: { $regex: `^${keywordUpper}`, $options: "i" }
      }).select("_id")
      matched.forEach(op => {
        if (!opIds.map(id => id.toString()).includes(op._id.toString())) {
          opIds.push(op._id)
        }
      })
    }

    group.operations = opIds
    group.updatedBy = req.user.id
    await group.save()

    const populated = await OperationGroup.findById(group._id)
      .populate("operations", "name operationCode totalSam durationSeconds machineType")
    res.json({ success: true, message: "Group updated", group: populated })
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to update group: " + err.message })
  }
})

// DELETE group
router.delete("/operation-groups/:id", async (req, res) => {
  try {
    const group = await OperationGroup.findById(req.params.id)
    if (!group) return res.status(404).json({ success: false, message: "Group not found" })
    await group.deleteOne()
    res.json({ success: true, message: "Group deleted" })
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to delete group" })
  }
})

// GET the product categories a group can be applied to — the same fixed list
// the stock-item create form offers (26 Aug 2026).
router.get("/operation-groups/categories", async (req, res) => {
  res.json({ success: true, categories: STOCK_ITEM_CATEGORIES })
})

// POST apply a group's operations to every product in a category — the
// GROUP → CATEGORY assignment feature (26 Aug 2026, explicit request:
// "the user can assign the operation group to the product category...
// select the product category... it will inherit all the product(stock
// item) with that category in order to overwrite the operations with that
// operation group").
//
// This OVERWRITES `operations` on every matching StockItem — not merges —
// same as picking a group from the Operations tab's own group picker on a
// single product, just applied to a whole category at once. Each product's
// costs are recomputed the same way a normal per-product Operations save
// does (recomputeVariantCostsFromBom + updateStockItemAggregates), and each
// gets its own change-log entry so the bulk edit is auditable per product,
// not just as one opaque event.
router.post("/operation-groups/:id/apply-to-category", async (req, res) => {
  try {
    const { category } = req.body || {}
    if (!category || !STOCK_ITEM_CATEGORIES.includes(category)) {
      return res.status(400).json({ success: false, message: "A valid product category is required" })
    }

    const group = await OperationGroup.findById(req.params.id)
      .populate("operations", "name operationCode totalSam durationSeconds machineType")
    if (!group) return res.status(404).json({ success: false, message: "Operation group not found" })
    if (!group.operations?.length) {
      return res.status(400).json({ success: false, message: `Group "${group.name}" has no operations yet` })
    }

    // Same operator-salary estimate the stock-item create form uses (line
    // ~700 of stockItems.js) — averaged over active Operator-department
    // employees, since a bulk apply has no single product's own dept/desig
    // context to price against.
    const operators = await Employee.find({ department: "Operator", status: "active" }).select("salary")
    const averageSalary = operators.length > 0
      ? operators.reduce((sum, emp) => sum + (emp.salary?.netSalary || 0), 0) / operators.length
      : 0
    const MINUTES_PER_MONTH = 26 * 8 * 60 // 26 work days × 8 hours — matches the frontend's own constant

    const templateOperations = group.operations.map(op => {
      const duration = op.durationSeconds || 0
      const minutes = Math.floor(duration / 60)
      const seconds = duration % 60
      return {
        type: op.name || "",
        operationCode: op.operationCode || "",
        machine: "",
        machineType: op.machineType || "",
        minutes,
        seconds,
        totalSeconds: duration,
        operatorSalary: Math.round(averageSalary),
        operatorCost: Math.round(((averageSalary / MINUTES_PER_MONTH) * (minutes + seconds / 60)) * 100) / 100,
        salaryDept: "",
        salaryDesig: "",
      }
    })

    const items = await StockItem.find({ category })
    if (!items.length) {
      return res.status(404).json({ success: false, message: `No products found in category "${category}"` })
    }

    let updatedCount = 0
    for (const item of items) {
      item.operations = templateOperations.map(op => ({ ...op }))
      recomputeVariantCostsFromBom(item)
      updateStockItemAggregates(item)
      item.updatedBy = req.user.id
      await item.save()
      updatedCount++

      await recordChange(req, {
        departmentSlug: "inventory",
        entity: "stock-item",
        entityId: item._id,
        entityLabel: item.name,
        action: "update",
        summary: `Operations replaced from group "${group.name}" (bulk-applied to category "${category}")`,
        before: {},
        after: {
          changes: [`Operations overwritten with ${templateOperations.length} operation(s) from group "${group.name}" — applied to every product in category "${category}"`],
        },
      })
    }

    res.json({
      success: true,
      message: `Applied "${group.name}" to ${updatedCount} product(s) in "${category}"`,
      updatedCount,
    })
  } catch (err) {
    console.error("apply-to-category error:", err)
    res.status(500).json({ success: false, message: "Failed to apply group to category: " + err.message })
  }
})

/* ═══════════════════════════════════════════════════════════════════════════
   MACHINE TYPES
═══════════════════════════════════════════════════════════════════════════ */

// GET all machine types
router.get("/machine-types", async (req, res) => {
  try {
    const machineTypes = await MachineType.find().sort({ name: 1 })
    res.json({ success: true, machineTypes })
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to fetch machine types" })
  }
})

// POST create machine type
router.post("/machine-types", async (req, res) => {
  try {
    const { name } = req.body
    if (!name) return res.status(400).json({ success: false, message: "Name is required" })
    const existing = await MachineType.findOne({ name: name.trim() })
    if (existing) return res.status(400).json({ success: false, message: "Machine type already exists" })
    const mt = new MachineType({ name: name.trim(), createdBy: req.user.id })
    await mt.save()
    res.status(201).json({ success: true, message: "Machine type created", machineType: mt })
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to create machine type" })
  }
})

// PUT update machine type
router.put("/machine-types/:id", async (req, res) => {
  try {
    const { name } = req.body
    const mt = await MachineType.findById(req.params.id)
    if (!mt) return res.status(404).json({ success: false, message: "Machine type not found" })
    if (name) mt.name = name.trim()
    mt.updatedBy = req.user.id
    await mt.save()
    res.json({ success: true, message: "Machine type updated", machineType: mt })
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to update machine type" })
  }
})

// DELETE machine type
router.delete("/machine-types/:id", async (req, res) => {
  try {
    const mt = await MachineType.findById(req.params.id)
    if (!mt) return res.status(404).json({ success: false, message: "Machine type not found" })
    await mt.deleteOne()
    res.json({ success: true, message: "Machine type deleted" })
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to delete machine type" })
  }
})

// POST bulk import machine types via CSV
router.post("/machine-types/import", async (req, res) => {
  try {
    const { machineTypes } = req.body
    if (!Array.isArray(machineTypes) || machineTypes.length === 0) {
      return res.status(400).json({ success: false, message: "No machine types provided" })
    }

    let inserted = 0, skipped = 0
    for (const row of machineTypes) {
      if (!row.name || !row.name.trim()) { skipped++; continue }
      const result = await MachineType.findOneAndUpdate(
        { name: row.name.trim() },
        { name: row.name.trim(), createdBy: req.user.id },
        { upsert: true, new: true }
      )
      if (result) inserted++
    }

    res.status(201).json({
      success: true,
      message: `${inserted} machine types imported (${skipped} skipped)`,
      count: inserted,
    })
  } catch (err) {
    res.status(500).json({ success: false, message: "Import failed: " + err.message })
  }
})

module.exports = router