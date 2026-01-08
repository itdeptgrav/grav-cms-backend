// routes/Cms_routes/Inventory/Configurations/warehouses.js

const express = require("express");
const router = express.Router();
const Warehouse = require("../../../../models/CMS_Models/Inventory/Configurations/Warehouse");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

// Common warehouse capacity units
const CAPACITY_UNITS = [
  "sq ft",
  "sq m",
  "sq yards",
  "cubic ft",
  "cubic m",
  "pallets",
  "racks",
  "shelves"
];

// Common warehouse types/suggestions
const WAREHOUSE_TYPES = [
  "Main Warehouse",
  "Production Warehouse",
  "Raw Material Storage",
  "Finished Goods Warehouse",
  "Cold Storage",
  "Distribution Center",
  "Regional Warehouse",
  "Transit Warehouse",
  "Retail Storage",
  "Seasonal Storage"
];

// Apply auth middleware to all routes
router.use(EmployeeAuthMiddleware);

// ✅ GET all warehouses with optional search/filter
router.get("/", async (req, res) => {
  try {
    const { search = "", status } = req.query;
    
    let filter = {};
    
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { shortName: { $regex: search, $options: "i" } },
        { address: { $regex: search, $options: "i" } }
      ];
    }
    
    if (status) {
      filter.status = status;
    }
    
    const warehouses = await Warehouse.find(filter)
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email")
      .sort({ createdAt: -1 });
    
    // Get statistics
    const total = await Warehouse.countDocuments();
    const active = await Warehouse.countDocuments({ status: "Active" });
    const totalItems = await Warehouse.aggregate([
      { $group: { _id: null, total: { $sum: "$itemsCount" } } }
    ]);
    
    res.json({
      success: true,
      warehouses,
      stats: { 
        total, 
        active, 
        totalItems: totalItems[0]?.total || 0 
      }
    });
    
  } catch (error) {
    console.error("Error fetching warehouses:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error while fetching warehouses" 
    });
  }
});

// ✅ GET warehouse by ID
router.get("/:id", async (req, res) => {
  try {
    const warehouse = await Warehouse.findById(req.params.id)
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email");
    
    if (!warehouse) {
      return res.status(404).json({
        success: false,
        message: "Warehouse not found"
      });
    }
    
    res.json({ success: true, warehouse });
    
  } catch (error) {
    console.error("Error fetching warehouse:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error while fetching warehouse" 
    });
  }
});

// ✅ GET capacity units
router.get("/capacity/units", async (req, res) => {
  res.json({
    success: true,
    units: CAPACITY_UNITS
  });
});

// ✅ GET warehouse types
router.get("/types/suggestions", async (req, res) => {
  res.json({
    success: true,
    types: WAREHOUSE_TYPES
  });
});

// ✅ CREATE new warehouse
router.post("/", async (req, res) => {
  try {
    const { 
      name, 
      shortName, 
      address, 
      capacity, 
      description,
      contactPerson
    } = req.body;
    
    // Validation
    if (!name || !shortName || !address) {
      return res.status(400).json({
        success: false,
        message: "Name, short name, and address are required"
      });
    }
    
    if (name.trim().length < 3) {
      return res.status(400).json({
        success: false,
        message: "Warehouse name must be at least 3 characters"
      });
    }
    
    if (shortName.trim().length < 2) {
      return res.status(400).json({
        success: false,
        message: "Short name must be at least 2 characters"
      });
    }
    
    if (address.trim().length < 10) {
      return res.status(400).json({
        success: false,
        message: "Please provide a complete address"
      });
    }
    
    // Check if short name already exists
    const existingWarehouse = await Warehouse.findOne({ 
      shortName: shortName.toUpperCase().trim() 
    });
    
    if (existingWarehouse) {
      return res.status(400).json({
        success: false,
        message: "Warehouse with this short name already exists"
      });
    }
    
    // Create new warehouse
    const newWarehouse = new Warehouse({
      name: name.trim(),
      shortName: shortName.toUpperCase().trim(),
      address: address.trim(),
      capacity: capacity || "0 sq ft",
      description: description ? description.trim() : "",
      contactPerson: contactPerson || null,
      status: "Active",
      itemsCount: 0,
      createdBy: req.user.id
    });
    
    await newWarehouse.save();
    
    res.status(201).json({
      success: true,
      message: "Warehouse created successfully",
      warehouse: newWarehouse
    });
    
  } catch (error) {
    console.error("Error creating warehouse:", error);
    
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "Warehouse with this short name already exists"
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: "Server error while creating warehouse" 
    });
  }
});

// ✅ UPDATE warehouse
router.put("/:id", async (req, res) => {
  try {
    const { 
      name, 
      shortName, 
      address, 
      capacity, 
      description,
      contactPerson,
      status
    } = req.body;
    
    const warehouse = await Warehouse.findById(req.params.id);
    if (!warehouse) {
      return res.status(404).json({
        success: false,
        message: "Warehouse not found"
      });
    }
    
    // Check for duplicate short name (excluding current warehouse)
    if (shortName && shortName.toUpperCase().trim() !== warehouse.shortName) {
      const existingWarehouse = await Warehouse.findOne({ 
        shortName: shortName.toUpperCase().trim(),
        _id: { $ne: req.params.id }
      });
      
      if (existingWarehouse) {
        return res.status(400).json({
          success: false,
          message: "Another warehouse with this short name already exists"
        });
      }
    }
    
    // Update fields if provided
    if (name) {
      if (name.trim().length < 3) {
        return res.status(400).json({
          success: false,
          message: "Warehouse name must be at least 3 characters"
        });
      }
      warehouse.name = name.trim();
    }
    
    if (shortName) {
      if (shortName.trim().length < 2) {
        return res.status(400).json({
          success: false,
          message: "Short name must be at least 2 characters"
        });
      }
      warehouse.shortName = shortName.toUpperCase().trim();
    }
    
    if (address) {
      if (address.trim().length < 10) {
        return res.status(400).json({
          success: false,
          message: "Please provide a complete address"
        });
      }
      warehouse.address = address.trim();
    }
    
    if (capacity) warehouse.capacity = capacity;
    if (description !== undefined) warehouse.description = description ? description.trim() : "";
    if (contactPerson !== undefined) warehouse.contactPerson = contactPerson;
    if (status) warehouse.status = status;
    
    warehouse.updatedBy = req.user.id;
    await warehouse.save();
    
    const updatedWarehouse = await Warehouse.findById(warehouse._id)
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email");
    
    res.json({
      success: true,
      message: "Warehouse updated successfully",
      warehouse: updatedWarehouse
    });
    
  } catch (error) {
    console.error("Error updating warehouse:", error);
    
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "Warehouse with this short name already exists"
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: "Server error while updating warehouse" 
    });
  }
});

// ✅ DELETE warehouse
router.delete("/:id", async (req, res) => {
  try {
    const warehouse = await Warehouse.findById(req.params.id);
    if (!warehouse) {
      return res.status(404).json({
        success: false,
        message: "Warehouse not found"
      });
    }
    
    // Check if warehouse has items
    if (warehouse.itemsCount > 0) {
      return res.status(400).json({
        success: false,
        message: "Cannot delete warehouse that contains items"
      });
    }
    
    await warehouse.deleteOne();
    
    res.json({
      success: true,
      message: "Warehouse deleted successfully"
    });
    
  } catch (error) {
    console.error("Error deleting warehouse:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error while deleting warehouse" 
    });
  }
});

// ✅ UPDATE warehouse status
router.patch("/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    
    if (!["Active", "Inactive"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status value"
      });
    }
    
    const warehouse = await Warehouse.findById(req.params.id);
    if (!warehouse) {
      return res.status(404).json({
        success: false,
        message: "Warehouse not found"
      });
    }
    
    warehouse.status = status;
    warehouse.updatedBy = req.user.id;
    await warehouse.save();
    
    res.json({
      success: true,
      message: `Warehouse status updated to ${status}`,
      warehouse
    });
    
  } catch (error) {
    console.error("Error updating warehouse status:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error while updating warehouse status" 
    });
  }
});

// ✅ UPDATE warehouse capacity
router.patch("/:id/capacity", async (req, res) => {
  try {
    const { capacity } = req.body;
    
    if (!capacity || capacity.trim() === "") {
      return res.status(400).json({
        success: false,
        message: "Capacity is required"
      });
    }
    
    const warehouse = await Warehouse.findById(req.params.id);
    if (!warehouse) {
      return res.status(404).json({
        success: false,
        message: "Warehouse not found"
      });
    }
    
    warehouse.capacity = capacity.trim();
    warehouse.updatedBy = req.user.id;
    await warehouse.save();
    
    res.json({
      success: true,
      message: "Warehouse capacity updated",
      warehouse
    });
    
  } catch (error) {
    console.error("Error updating warehouse capacity:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error while updating warehouse capacity" 
    });
  }
});

module.exports = router;