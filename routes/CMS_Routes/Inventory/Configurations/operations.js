// routes/CMS_Routes/Inventory/Configurations/operations.js

const express = require("express")
const router = express.Router()
const Operation = require("../../../../models/CMS_Models/Inventory/Configurations/Operation")
const OperationGroup = require("../../../../models/CMS_Models/Inventory/Configurations/OperationGroup")
const MachineType = require("../../../../models/CMS_Models/Inventory/Configurations/MachineType")
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear")

router.use(EmployeeAuthMiddleware)

/* ─── OPERATIONS ─────────────────────────────────────────────────────────── */

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

// POST create operation
router.post("/operations", async (req, res) => {
  try {
    const { name, totalSam, durationSeconds, machineType } = req.body
    if (!name || totalSam == null || !machineType) {
      return res.status(400).json({ success: false, message: "name, totalSam, and machineType are required" })
    }
    const op = new Operation({
      name: name.trim(),
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

    res.status(201).json({ success: true, message: "Operation created", operation: op })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "Failed to create operation" })
  }
})

// PUT update operation
router.put("/operations/:id", async (req, res) => {
  try {
    const { name, totalSam, durationSeconds, machineType } = req.body
    const op = await Operation.findById(req.params.id)
    if (!op) return res.status(404).json({ success: false, message: "Operation not found" })

    if (name) op.name = name.trim()
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
    op.updatedBy = req.user.id
    await op.save()
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
    // Remove from groups
    await OperationGroup.updateMany({ operations: req.params.id }, { $pull: { operations: req.params.id } })
    res.json({ success: true, message: "Operation deleted" })
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to delete operation" })
  }
})

// POST bulk import via CSV
router.post("/operations/import", async (req, res) => {
  try {
    const { operations } = req.body
    if (!Array.isArray(operations) || operations.length === 0) {
      return res.status(400).json({ success: false, message: "No operations provided" })
    }

    const inserted = []
    for (const row of operations) {
      if (!row.name || row.totalSam == null) continue
      const op = new Operation({
        name: row.name.trim(),
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
    }

    res.status(201).json({ success: true, message: `${inserted.length} operations imported`, count: inserted.length })
  } catch (err) {
    res.status(500).json({ success: false, message: "Import failed: " + err.message })
  }
})

/* ─── OPERATION GROUPS ───────────────────────────────────────────────────── */

// GET all groups
router.get("/operation-groups", async (req, res) => {
  try {
    const groups = await OperationGroup.find()
      .populate("operations", "name totalSam durationSeconds machineType")
      .sort({ createdAt: -1 })
    res.json({ success: true, groups })
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to fetch groups" })
  }
})

// POST create group
router.post("/operation-groups", async (req, res) => {
  try {
    const { name, operations } = req.body
    if (!name || !Array.isArray(operations) || operations.length === 0) {
      return res.status(400).json({ success: false, message: "Group name and at least one operation are required" })
    }
    const existing = await OperationGroup.findOne({ name: name.trim() })
    if (existing) {
      return res.status(400).json({ success: false, message: "Group with this name already exists" })
    }
    const group = new OperationGroup({ name: name.trim(), operations, createdBy: req.user.id })
    await group.save()
    const populated = await OperationGroup.findById(group._id).populate("operations", "name totalSam durationSeconds machineType")
    res.status(201).json({ success: true, message: "Group created", group: populated })
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to create group" })
  }
})

// PUT update group
router.put("/operation-groups/:id", async (req, res) => {
  try {
    const { name, operations } = req.body
    const group = await OperationGroup.findById(req.params.id)
    if (!group) return res.status(404).json({ success: false, message: "Group not found" })

    if (name) group.name = name.trim()
    if (Array.isArray(operations)) group.operations = operations
    group.updatedBy = req.user.id
    await group.save()
    const populated = await OperationGroup.findById(group._id).populate("operations", "name totalSam durationSeconds machineType")
    res.json({ success: true, message: "Group updated", group: populated })
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to update group" })
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

/* ─── MACHINE TYPES ──────────────────────────────────────────────────────── */

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

module.exports = router