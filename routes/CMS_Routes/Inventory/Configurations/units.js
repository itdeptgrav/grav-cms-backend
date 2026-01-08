// routes/Cms_routes/Inventory/Configurations/units.js

const express = require("express");
const router = express.Router();
const Unit = require("../../../../models/CMS_Models/Inventory/Configurations/Unit");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

// Common GST UQC codes for clothing industry
const GST_UQC_CODES = [
  "BAG", "BAL", "BDL", "BKL", "BOU", "BOX", "BTL", "BUN", "CAN", "CBM", 
  "CCM", "CMS", "CTN", "DOZ", "DRM", "GGK", "GMS", "GRS", "GYD", "KGS", 
  "KLR", "KME", "LTR", "MLT", "MTR", "MTS", "NOS", "OTH", "PAC", "PCS", 
  "PRS", "QTL", "ROL", "SET", "SQF", "SQM", "SQY", "TBS", "TGM", "THD", 
  "TON", "TUB", "UGS", "UNT", "YDS"
];

// Apply auth middleware to all routes
router.use(EmployeeAuthMiddleware);

// ✅ GET all units with optional search/filter
router.get("/", async (req, res) => {
  try {
    const { search = "", status } = req.query;
    
    let filter = {};
    
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { gstUqc: { $regex: search, $options: "i" } }
      ];
    }
    
    if (status && ["Active", "Inactive"].includes(status)) {
      filter.status = status;
    }
    
    const units = await Unit.find(filter)
      .populate("baseUnit", "name gstUqc")
      .populate("createdBy", "name email")
      .sort({ createdAt: -1 });
    
    // Get stats
    const total = await Unit.countDocuments();
    const totalActive = await Unit.countDocuments({ status: "Active" });
    const totalBaseUnits = await Unit.countDocuments({ baseUnit: null });
    
    res.json({
      success: true,
      units,
      stats: { total, totalActive, totalBaseUnits }
    });
    
  } catch (error) {
    console.error("Error fetching units:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error" 
    });
  }
});

// ✅ GET all base units (for dropdown)
router.get("/base-units", async (req, res) => {
  try {
    const baseUnits = await Unit.find({ 
      baseUnit: null,
      status: "Active"
    }).select("name gstUqc _id");
    
    res.json({
      success: true,
      baseUnits
    });
    
  } catch (error) {
    console.error("Error fetching base units:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error" 
    });
  }
});

// ✅ GET GST UQC codes
router.get("/gst-uqc-codes", async (req, res) => {
  res.json({
    success: true,
    codes: GST_UQC_CODES
  });
});

// ✅ GET unit by ID
router.get("/:id", async (req, res) => {
  try {
    const unit = await Unit.findById(req.params.id)
      .populate("baseUnit", "name gstUqc _id")
      .populate("createdBy", "name email");
    
    if (!unit) {
      return res.status(404).json({
        success: false,
        message: "Unit not found"
      });
    }
    
    res.json({ success: true, unit });
    
  } catch (error) {
    console.error("Error fetching unit:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error" 
    });
  }
});

// ✅ CREATE new unit
router.post("/", async (req, res) => {
  try {
    const { name, gstUqc, quantity, baseUnit, isBaseUnit } = req.body;
    
    // Validation
    if (!name || !gstUqc || !quantity) {
      return res.status(400).json({
        success: false,
        message: "Name, GST UQC, and quantity are required"
      });
    }
    
    if (isNaN(quantity) || parseFloat(quantity) <= 0) {
      return res.status(400).json({
        success: false,
        message: "Quantity must be a positive number"
      });
    }
    
    // Check if unit already exists
    const existingUnit = await Unit.findOne({
      $or: [
        { name: new RegExp(`^${name}$`, "i") },
        { gstUqc: gstUqc.toUpperCase() }
      ]
    });
    
    if (existingUnit) {
      return res.status(400).json({
        success: false,
        message: "Unit with this name or GST UQC already exists"
      });
    }
    
    // Handle base unit (can be ObjectId or string name)
    let baseUnitId = null;
    if (baseUnit && baseUnit !== "") {
      if (baseUnit.match(/^[0-9a-fA-F]{24}$/)) {
        // It's an ObjectId
        baseUnitId = baseUnit;
      } else {
        // It's a string name, find or create
        const foundBaseUnit = await Unit.findOne({
          name: new RegExp(`^${baseUnit}$`, "i"),
          baseUnit: null
        });
        
        if (!foundBaseUnit) {
          return res.status(400).json({
            success: false,
            message: "Invalid base unit"
          });
        }
        baseUnitId = foundBaseUnit._id;
      }
    }
    
    // Create new unit
    const newUnit = new Unit({
      name: name.trim(),
      gstUqc: gstUqc.toUpperCase().trim(),
      quantity: parseFloat(quantity),
      baseUnit: isBaseUnit ? null : baseUnitId,
      createdBy: req.user.id,
      status: "Active"
    });
    
    await newUnit.save();
    
    const populatedUnit = await Unit.findById(newUnit._id)
      .populate("baseUnit", "name gstUqc")
      .populate("createdBy", "name email");
    
    res.status(201).json({
      success: true,
      message: "Unit created successfully",
      unit: populatedUnit
    });
    
  } catch (error) {
    console.error("Error creating unit:", error);
    
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "Unit with this name or GST UQC already exists"
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: "Server error" 
    });
  }
});

// ✅ UPDATE unit
router.put("/:id", async (req, res) => {
  try {
    const { name, gstUqc, quantity, baseUnit, status, isBaseUnit } = req.body;
    
    const unit = await Unit.findById(req.params.id);
    if (!unit) {
      return res.status(404).json({
        success: false,
        message: "Unit not found"
      });
    }
    
    // Check for duplicate name or GST UQC (excluding current unit)
    if (name || gstUqc) {
      const duplicateFilter = {
        _id: { $ne: req.params.id }
      };
      
      if (name) {
        duplicateFilter.name = new RegExp(`^${name}$`, "i");
      }
      if (gstUqc) {
        duplicateFilter.gstUqc = gstUqc.toUpperCase();
      }
      
      const duplicateUnit = await Unit.findOne(duplicateFilter);
      if (duplicateUnit) {
        return res.status(400).json({
          success: false,
          message: "Another unit with this name or GST UQC already exists"
        });
      }
    }
    
    // Handle base unit
    let baseUnitId = unit.baseUnit;
    if (isBaseUnit === true) {
      baseUnitId = null;
    } else if (baseUnit && baseUnit !== "") {
      if (baseUnit.match(/^[0-9a-fA-F]{24}$/)) {
        baseUnitId = baseUnit;
      } else {
        const foundBaseUnit = await Unit.findOne({
          name: new RegExp(`^${baseUnit}$`, "i"),
          baseUnit: null
        });
        
        if (!foundBaseUnit) {
          return res.status(400).json({
            success: false,
            message: "Invalid base unit"
          });
        }
        baseUnitId = foundBaseUnit._id;
      }
    }
    
    // Update fields
    if (name) unit.name = name.trim();
    if (gstUqc) unit.gstUqc = gstUqc.toUpperCase().trim();
    if (quantity) unit.quantity = parseFloat(quantity);
    unit.baseUnit = baseUnitId;
    if (status) unit.status = status;
    
    unit.updatedBy = req.user.id;
    await unit.save();
    
    const updatedUnit = await Unit.findById(unit._id)
      .populate("baseUnit", "name gstUqc")
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email");
    
    res.json({
      success: true,
      message: "Unit updated successfully",
      unit: updatedUnit
    });
    
  } catch (error) {
    console.error("Error updating unit:", error);
    
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "Unit with this name or GST UQC already exists"
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: "Server error" 
    });
  }
});

// ✅ DELETE unit (soft delete)
router.delete("/:id", async (req, res) => {
  try {
    const unit = await Unit.findById(req.params.id);
    if (!unit) {
      return res.status(404).json({
        success: false,
        message: "Unit not found"
      });
    }
    
    // Check if unit is used as base unit
    const isUsedAsBase = await Unit.exists({ baseUnit: unit._id });
    if (isUsedAsBase) {
      return res.status(400).json({
        success: false,
        message: "Cannot delete: Unit is used as base unit for other units"
      });
    }
    
    // Soft delete
    unit.status = "Inactive";
    unit.updatedBy = req.user.id;
    await unit.save();
    
    res.json({
      success: true,
      message: "Unit marked as inactive"
    });
    
  } catch (error) {
    console.error("Error deleting unit:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error" 
    });
  }
});

module.exports = router;