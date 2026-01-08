// routes/Cms_routes/Inventory/Configurations/machines.js

const express = require("express");
const router = express.Router();
const Machine = require("../../../../models/CMS_Models/Inventory/Configurations/Machine");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

// Common machine types for clothing industry
const MACHINE_TYPES = [
  "Sewing Machine",
  "Embroidery Machine", 
  "Cutting Machine",
  "Overlock Machine",
  "Buttonhole Machine",
  "Bar Tack Machine",
  "Heavy Duty Sewing",
  "Multi-head Embroidery",
  "Flatlock Machine",
  "Chain Stitch Machine",
  "Button Sewing Machine",
  "Label Sewing Machine",
  "Fusing Machine",
  "Ironing Machine",
  "Pressing Machine",
  "Washing Machine",
  "Drying Machine",
  "Pattern Making Machine",
  "Quilting Machine"
];

// Common locations in clothing factory
const FACTORY_LOCATIONS = [
  "Sewing Section A",
  "Sewing Section B", 
  "Cutting Section",
  "Embroidery Unit",
  "Finishing Section",
  "Quality Control",
  "Washing Unit",
  "Pressing Unit",
  "Packaging Section",
  "Maintenance Room",
  "Storage Room"
];

// Apply auth middleware to all routes
router.use(EmployeeAuthMiddleware);

// ✅ GET all machines with optional search/filter
router.get("/", async (req, res) => {
  try {
    const { search = "", status, type, location } = req.query;
    
    let filter = {};
    
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { model: { $regex: search, $options: "i" } },
        { serialNumber: { $regex: search, $options: "i" } }
      ];
    }
    
    if (status) {
      filter.status = status;
    }
    
    if (type) {
      filter.type = type;
    }
    
    if (location) {
      filter.location = location;
    }
    
    const machines = await Machine.find(filter)
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email")
      .sort({ createdAt: -1 });
    
    // Get statistics
    const total = await Machine.countDocuments();
    const operational = await Machine.countDocuments({ status: "Operational" });
    const maintenanceNeeded = await Machine.countDocuments({ 
      $or: [
        { status: "Under Maintenance" },
        { status: "Repair Needed" }
      ]
    });
    
    // Calculate total power
    let totalPower = 0;
    machines.forEach(machine => {
      const wattage = parseInt(machine.powerConsumption) || 0;
      totalPower += wattage;
    });
    
    res.json({
      success: true,
      machines,
      stats: { 
        total, 
        operational, 
        maintenanceNeeded,
        totalPower: `${totalPower}W`
      },
      filters: {
        types: MACHINE_TYPES,
        locations: FACTORY_LOCATIONS,
        statuses: ["Operational", "Under Maintenance", "Idle", "Repair Needed"]
      }
    });
    
  } catch (error) {
    console.error("Error fetching machines:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error while fetching machines" 
    });
  }
});

// ✅ GET machine types
router.get("/types", async (req, res) => {
  res.json({
    success: true,
    types: MACHINE_TYPES
  });
});

// ✅ GET factory locations
router.get("/locations", async (req, res) => {
  res.json({
    success: true,
    locations: FACTORY_LOCATIONS
  });
});

// ✅ GET machine by ID
router.get("/:id", async (req, res) => {
  try {
    const machine = await Machine.findById(req.params.id)
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email");
    
    if (!machine) {
      return res.status(404).json({
        success: false,
        message: "Machine not found"
      });
    }
    
    res.json({ success: true, machine });
    
  } catch (error) {
    console.error("Error fetching machine:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error while fetching machine" 
    });
  }
});

// ✅ CREATE new machine
router.post("/", async (req, res) => {
  try {
    const { 
      name, 
      type, 
      model, 
      serialNumber, 
      powerConsumption, 
      location, 
      lastMaintenance, 
      nextMaintenance,
      description,
      status
    } = req.body;
    
    // Validation
    if (!name || !type || !model || !serialNumber || !powerConsumption || !location || !lastMaintenance || !nextMaintenance) {
      return res.status(400).json({
        success: false,
        message: "All required fields must be filled"
      });
    }
    
    // Validate power consumption format
    if (!/^\d+W$/.test(powerConsumption.trim())) {
      return res.status(400).json({
        success: false,
        message: "Power consumption format: Number followed by W (e.g., 750W)"
      });
    }
    
    // Check if serial number already exists
    const existingMachine = await Machine.findOne({ 
      serialNumber: serialNumber.toUpperCase().trim() 
    });
    
    if (existingMachine) {
      return res.status(400).json({
        success: false,
        message: "Machine with this serial number already exists"
      });
    }
    
    // Validate dates
    const lastMaintenanceDate = new Date(lastMaintenance);
    const nextMaintenanceDate = new Date(nextMaintenance);
    
    if (isNaN(lastMaintenanceDate.getTime()) || isNaN(nextMaintenanceDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid date format"
      });
    }
    
    if (nextMaintenanceDate <= lastMaintenanceDate) {
      return res.status(400).json({
        success: false,
        message: "Next maintenance date must be after last maintenance date"
      });
    }
    
    // Create new machine
    const newMachine = new Machine({
      name: name.trim(),
      type: type.trim(),
      model: model.trim(),
      serialNumber: serialNumber.toUpperCase().trim(),
      powerConsumption: powerConsumption.trim(),
      location: location.trim(),
      lastMaintenance: lastMaintenanceDate,
      nextMaintenance: nextMaintenanceDate,
      description: description ? description.trim() : "",
      status: status || "Operational",
      createdBy: req.user.id
    });
    
    await newMachine.save();
    
    res.status(201).json({
      success: true,
      message: "Machine registered successfully",
      machine: newMachine
    });
    
  } catch (error) {
    console.error("Error creating machine:", error);
    
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "Machine with this serial number already exists"
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: "Server error while creating machine" 
    });
  }
});

// ✅ UPDATE machine
router.put("/:id", async (req, res) => {
  try {
    const { 
      name, 
      type, 
      model, 
      serialNumber, 
      powerConsumption, 
      location, 
      lastMaintenance, 
      nextMaintenance,
      description,
      status
    } = req.body;
    
    const machine = await Machine.findById(req.params.id);
    if (!machine) {
      return res.status(404).json({
        success: false,
        message: "Machine not found"
      });
    }
    
    // Check for duplicate serial number (excluding current machine)
    if (serialNumber && serialNumber.toUpperCase().trim() !== machine.serialNumber) {
      const existingMachine = await Machine.findOne({ 
        serialNumber: serialNumber.toUpperCase().trim(),
        _id: { $ne: req.params.id }
      });
      
      if (existingMachine) {
        return res.status(400).json({
          success: false,
          message: "Another machine with this serial number already exists"
        });
      }
    }
    
    // Validate power consumption format if provided
    if (powerConsumption && !/^\d+W$/.test(powerConsumption.trim())) {
      return res.status(400).json({
        success: false,
        message: "Power consumption format: Number followed by W (e.g., 750W)"
      });
    }
    
    // Validate dates if provided
    if (lastMaintenance || nextMaintenance) {
      const lastDate = lastMaintenance ? new Date(lastMaintenance) : machine.lastMaintenance;
      const nextDate = nextMaintenance ? new Date(nextMaintenance) : machine.nextMaintenance;
      
      if (isNaN(lastDate.getTime()) || isNaN(nextDate.getTime())) {
        return res.status(400).json({
          success: false,
          message: "Invalid date format"
        });
      }
      
      if (nextDate <= lastDate) {
        return res.status(400).json({
          success: false,
          message: "Next maintenance date must be after last maintenance date"
        });
      }
    }
    
    // Update fields if provided
    if (name) machine.name = name.trim();
    if (type) machine.type = type.trim();
    if (model) machine.model = model.trim();
    if (serialNumber) machine.serialNumber = serialNumber.toUpperCase().trim();
    if (powerConsumption) machine.powerConsumption = powerConsumption.trim();
    if (location) machine.location = location.trim();
    if (lastMaintenance) machine.lastMaintenance = new Date(lastMaintenance);
    if (nextMaintenance) machine.nextMaintenance = new Date(nextMaintenance);
    if (description !== undefined) machine.description = description ? description.trim() : "";
    if (status) machine.status = status;
    
    machine.updatedBy = req.user.id;
    await machine.save();
    
    const updatedMachine = await Machine.findById(machine._id)
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email");
    
    res.json({
      success: true,
      message: "Machine updated successfully",
      machine: updatedMachine
    });
    
  } catch (error) {
    console.error("Error updating machine:", error);
    
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "Machine with this serial number already exists"
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: "Server error while updating machine" 
    });
  }
});

// ✅ DELETE machine
router.delete("/:id", async (req, res) => {
  try {
    const machine = await Machine.findById(req.params.id);
    if (!machine) {
      return res.status(404).json({
        success: false,
        message: "Machine not found"
      });
    }
    
    await machine.deleteOne();
    
    res.json({
      success: true,
      message: "Machine deleted successfully"
    });
    
  } catch (error) {
    console.error("Error deleting machine:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error while deleting machine" 
    });
  }
});

// ✅ UPDATE machine status only
router.patch("/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    
    if (!["Operational", "Under Maintenance", "Idle", "Repair Needed"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status value"
      });
    }
    
    const machine = await Machine.findById(req.params.id);
    if (!machine) {
      return res.status(404).json({
        success: false,
        message: "Machine not found"
      });
    }
    
    machine.status = status;
    machine.updatedBy = req.user.id;
    await machine.save();
    
    res.json({
      success: true,
      message: `Machine status updated to ${status}`,
      machine
    });
    
  } catch (error) {
    console.error("Error updating machine status:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error while updating machine status" 
    });
  }
});

// ✅ GET maintenance schedule
router.get("/maintenance/schedule", async (req, res) => {
  try {
    const { upcomingDays = 30 } = req.query;
    
    const today = new Date();
    const futureDate = new Date();
    futureDate.setDate(today.getDate() + parseInt(upcomingDays));
    
    const upcomingMaintenance = await Machine.find({
      nextMaintenance: {
        $gte: today,
        $lte: futureDate
      },
      status: { $ne: "Repair Needed" }
    })
    .sort({ nextMaintenance: 1 })
    .select("name type serialNumber nextMaintenance status location");
    
    const overdueMaintenance = await Machine.find({
      nextMaintenance: { $lt: today },
      status: { $ne: "Repair Needed" }
    })
    .sort({ nextMaintenance: 1 })
    .select("name type serialNumber nextMaintenance status location");
    
    res.json({
      success: true,
      upcoming: upcomingMaintenance,
      overdue: overdueMaintenance,
      upcomingDays: parseInt(upcomingDays)
    });
    
  } catch (error) {
    console.error("Error fetching maintenance schedule:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error while fetching maintenance schedule" 
    });
  }
});

module.exports = router;