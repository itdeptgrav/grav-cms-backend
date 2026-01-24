// routes/CMS_Routes/Configuration/Department/departmentRoutes.js

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const Department = require("../../../../models/CMS_Models/Configuration/OrganizationDepartment");
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");

router.use(EmployeeAuthMiddleware);

// GET all departments
router.get("/", async (req, res) => {
  try {
    const { search = "", status = "" } = req.query;

    let query = {};

    if (search) {
      query.name = { $regex: search, $options: "i" };
    }

    if (status) {
      query.status = status;
    }

    const departments = await Department.find(query)
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email")
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      departments
    });

  } catch (error) {
    console.error("Error fetching departments:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching departments"
    });
  }
});

// GET single department
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const department = await Department.findById(id)
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email")
      .populate("designations.assignedStockItems.stockItemId", "name reference category")
      .lean();

    if (!department) {
      return res.status(404).json({
        success: false,
        message: "Department not found"
      });
    }

    res.json({
      success: true,
      department
    });

  } catch (error) {
    console.error("Error fetching department:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching department"
    });
  }
});

// CREATE department
router.post("/", async (req, res) => {
  try {
    const { name, description, designations } = req.body;
    const userId = req.user.id;

    // Check if department already exists
    const existingDepartment = await Department.findOne({ name });
    if (existingDepartment) {
      return res.status(400).json({
        success: false,
        message: "Department with this name already exists"
      });
    }

    // Validate stock items exist
    for (const designation of designations || []) {
      for (const stockItem of designation.assignedStockItems || []) {
        const stockItemExists = await StockItem.findById(stockItem.stockItemId);
        if (!stockItemExists) {
          return res.status(400).json({
            success: false,
            message: `Stock item with ID ${stockItem.stockItemId} not found`
          });
        }
      }
    }

    const department = new Department({
      name,
      description,
      designations: designations?.map(designation => ({
        name: designation.name,
        description: designation.description,
        assignedStockItems: designation.assignedStockItems?.map(item => ({
          stockItemId: item.stockItemId,
          assignedBy: userId
        })) || [],
        createdBy: userId
      })) || [],
      createdBy: userId
    });

    await department.save();

    res.json({
      success: true,
      message: "Department created successfully",
      department
    });

  } catch (error) {
    console.error("Error creating department:", error);
    res.status(500).json({
      success: false,
      message: "Server error while creating department"
    });
  }
});

// UPDATE department - Modified to be less strict about variants
router.put("/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const { name, description, designations } = req.body;
        const userId = req.user.id;
        
        const department = await Department.findById(id);
        if (!department) {
            return res.status(404).json({
                success: false,
                message: "Department not found"
            });
        }
        
        // Check if name is being changed and if it already exists
        if (name && name !== department.name) {
            const existingDepartment = await Department.findOne({ name });
            if (existingDepartment) {
                return res.status(400).json({
                    success: false,
                    message: "Department with this name already exists"
                });
            }
            department.name = name;
        }
        
        if (description !== undefined) {
            department.description = description;
        }
        
        // Update designations if provided
        if (designations) {
            // Validate stock items exist (but don't validate variants strictly)
            for (const designation of designations) {
                for (const stockItem of designation.assignedStockItems || []) {
                    const stockItemExists = await StockItem.findById(stockItem.stockItemId);
                    if (!stockItemExists) {
                        return res.status(400).json({
                            success: false,
                            message: `Stock item with ID ${stockItem.stockItemId} not found`
                        });
                    }
                    
                    // Only validate variant if it's provided AND we want to check
                    // Comment out strict validation for now
                    /*
                    if (stockItem.variantId) {
                        const variantExists = stockItemExists.variants?.some(v => 
                            v._id.toString() === stockItem.variantId
                        );
                        if (!variantExists) {
                            return res.status(400).json({
                                success: false,
                                message: `Variant with ID ${stockItem.variantId} not found for stock item ${stockItemExists.name}`
                            });
                        }
                    }
                    */
                }
            }
            
            // Update designations
            department.designations = designations.map(designation => {
                // Check if designation already exists
                const existingDesignation = designation._id ? 
                    department.designations.id(designation._id) : null;
                
                if (existingDesignation) {
                    // Update existing designation
                    existingDesignation.name = designation.name;
                    existingDesignation.description = designation.description;
                    existingDesignation.status = designation.status || "active";
                    
                    // Update assigned stock items with variants (accept any variant ID)
                    existingDesignation.assignedStockItems = designation.assignedStockItems?.map(item => ({
                        stockItemId: item.stockItemId,
                        variantId: item.variantId || null, // Accept whatever variant ID is sent
                        quantity: item.quantity || 1, // Make sure quantity is included
                        assignedBy: userId
                    })) || [];
                    
                    existingDesignation.updatedBy = userId;
                    return existingDesignation;
                } else {
                    // Create new designation
                    return {
                        name: designation.name,
                        description: designation.description,
                        status: designation.status || "active",
                        assignedStockItems: designation.assignedStockItems?.map(item => ({
                            stockItemId: item.stockItemId,
                            variantId: item.variantId || null,
                            quantity: item.quantity || 1,
                            assignedBy: userId
                        })) || [],
                        createdBy: userId
                    };
                }
            });
        }
        
        department.updatedBy = userId;
        department.updatedAt = Date.now();
        await department.save();
        
        res.json({
            success: true,
            message: "Department updated successfully",
            department
        });
        
    } catch (error) {
        console.error("Error updating department:", error);
        res.status(500).json({
            success: false,
            message: "Server error while updating department"
        });
    }
});

// DELETE department
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const department = await Department.findById(id);
    if (!department) {
      return res.status(404).json({
        success: false,
        message: "Department not found"
      });
    }

    // Soft delete by marking as inactive
    department.status = "inactive";
    department.updatedBy = req.user.id;
    await department.save();

    res.json({
      success: true,
      message: "Department deactivated successfully"
    });

  } catch (error) {
    console.error("Error deleting department:", error);
    res.status(500).json({
      success: false,
      message: "Server error while deleting department"
    });
  }
});

// GET stock items for autocomplete
router.get("/stock-items/search", async (req, res) => {
  try {
    const { search = "" } = req.query;

    let query = {};

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { reference: { $regex: search, $options: "i" } }
      ];
    }

    const stockItems = await StockItem.find(query)
      .select("_id name reference category status")
      .limit(20)
      .lean();

    res.json({
      success: true,
      stockItems
    });

  } catch (error) {
    console.error("Error searching stock items:", error);
    res.status(500).json({
      success: false,
      message: "Server error while searching stock items"
    });
  }
});

// ACTIVATE department
router.post("/:id/activate", async (req, res) => {
  try {
    const { id } = req.params;

    const department = await Department.findById(id);
    if (!department) {
      return res.status(404).json({
        success: false,
        message: "Department not found"
      });
    }

    department.status = "active";
    department.updatedBy = req.user.id;
    await department.save();

    res.json({
      success: true,
      message: "Department activated successfully"
    });

  } catch (error) {
    console.error("Error activating department:", error);
    res.status(500).json({
      success: false,
      message: "Server error while activating department"
    });
  }
});

module.exports = router;