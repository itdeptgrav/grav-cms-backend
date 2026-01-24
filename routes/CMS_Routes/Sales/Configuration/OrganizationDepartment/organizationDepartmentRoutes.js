// routes/CMS_Routes/Sales/Configuration/OrganizationDepartment/organizationDepartmentRoutes.js

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../../Middlewear/EmployeeAuthMiddlewear");
const OrganizationDepartment = require("../../../../../models/CMS_Models/Configuration/OrganizationDepartment");
const Customer = require("../../../../../models/Customer_Models/Customer");
const StockItem = require("../../../../../models/CMS_Models/Inventory/Products/StockItem");

router.use(EmployeeAuthMiddleware);

// GET all organizations (customers) with department counts
router.get("/organizations", async (req, res) => {
  try {
    const { search = "" } = req.query;
    
    let customerQuery = {};
    
    if (search) {
      customerQuery.$or = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } }
      ];
    }
    
    // Get all customers
    const customers = await Customer.find(customerQuery)
      .select("_id name email phone createdAt")
      .sort({ name: 1 })
      .limit(100)
      .lean();
    
    // Get department counts for each customer
    const organizationDepartments = await OrganizationDepartment.aggregate([
      {
        $match: {
          customerId: { $in: customers.map(c => c._id) },
          status: "active"
        }
      },
      {
        $project: {
          customerId: 1,
          totalDepartments: { $size: "$departments" },
          activeDepartments: {
            $size: {
              $filter: {
                input: "$departments",
                as: "dept",
                cond: { $eq: ["$$dept.status", "active"] }
              }
            }
          },
          totalDesignations: {
            $reduce: {
              input: "$departments",
              initialValue: 0,
              in: { $add: ["$$value", { $size: "$$this.designations" }] }
            }
          }
        }
      }
    ]);
    
    // Map department counts to customers
    const departmentMap = new Map();
    organizationDepartments.forEach(org => {
      departmentMap.set(org.customerId.toString(), {
        totalDepartments: org.totalDepartments,
        activeDepartments: org.activeDepartments,
        totalDesignations: org.totalDesignations
      });
    });
    
    const organizations = customers.map(customer => ({
      ...customer,
      departmentStats: departmentMap.get(customer._id.toString()) || {
        totalDepartments: 0,
        activeDepartments: 0,
        totalDesignations: 0
      }
    }));
    
    res.json({
      success: true,
      organizations,
      stats: {
        totalOrganizations: organizations.length,
        organizationsWithDepartments: organizations.filter(o => o.departmentStats.totalDepartments > 0).length
      }
    });
    
  } catch (error) {
    console.error("Error fetching organizations:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching organizations"
    });
  }
});

// GET departments for a specific organization
router.get("/organization/:customerId", async (req, res) => {
  try {
    const { customerId } = req.params;
    
    // Get customer details
    const customer = await Customer.findById(customerId)
      .select("_id name email phone")
      .lean();
    
    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Customer not found"
      });
    }
    
    // Get organization departments
    const organizationDepartment = await OrganizationDepartment.findOne({
      customerId: customerId,
      status: "active"
    })
    .populate("departments.designations.assignedStockItems.stockItemId", "name reference category")
    .lean();
    
    res.json({
      success: true,
      customer,
      organizationDepartment: organizationDepartment || {
        customerId: customer._id,
        customerName: customer.name,
        customerEmail: customer.email,
        customerPhone: customer.phone,
        departments: []
      }
    });
    
  } catch (error) {
    console.error("Error fetching organization departments:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching organization departments"
    });
  }
});

// CREATE/UPDATE organization departments
router.post("/organization/:customerId/departments", async (req, res) => {
  try {
    const { customerId } = req.params;
    const { departments } = req.body;
    
    // Get customer details
    const customer = await Customer.findById(customerId)
      .select("_id name email phone")
      .lean();
    
    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Customer not found"
      });
    }
    
    // Validate stock items exist and get variant names if needed
    for (const department of departments || []) {
      for (const designation of department.designations || []) {
        for (const stockItem of designation.assignedStockItems || []) {
          const stockItemExists = await StockItem.findById(stockItem.stockItemId);
          if (!stockItemExists) {
            return res.status(400).json({
              success: false,
              message: `Stock item with ID ${stockItem.stockItemId} not found`
            });
          }
          
          // If variantId is provided, validate it exists
          if (stockItem.variantId) {
            const variant = stockItemExists.variants.id(stockItem.variantId);
            if (!variant) {
              return res.status(400).json({
                success: false,
                message: `Variant with ID ${stockItem.variantId} not found in stock item ${stockItemExists.name}`
              });
            }
          }
        }
      }
    }
    
    // Check if organization department exists
    let organizationDepartment = await OrganizationDepartment.findOne({
      customerId: customerId,
      status: "active"
    });
    
    // Process departments with variant names
    const processedDepartments = await Promise.all(
      departments.map(async (dept) => {
        const processedDesignations = await Promise.all(
          (dept.designations || []).map(async (designation) => {
            const processedStockItems = await Promise.all(
              (designation.assignedStockItems || []).map(async (item) => {
                const stockItem = await StockItem.findById(item.stockItemId);
                let variantName = "Default";
                
                if (item.variantId && stockItem) {
                  const variant = stockItem.variants.id(item.variantId);
                  if (variant) {
                    variantName = variant.attributes?.map(a => a.value).join(" • ") || "Default";
                  }
                }
                
                return {
                  stockItemId: item.stockItemId,
                  quantity: item.quantity || 1,
                  variantId: item.variantId || null,
                  variantName: variantName
                };
              })
            );
            
            return {
              name: designation.name,
              description: designation.description || "",
              status: designation.status || "active",
              assignedStockItems: processedStockItems
            };
          })
        );
        
        return {
          name: dept.name,
          description: dept.description || "",
          status: dept.status || "active",
          designations: processedDesignations
        };
      })
    );
    
    if (organizationDepartment) {
      // Update existing
      organizationDepartment.departments = processedDepartments;
    } else {
      // Create new
      organizationDepartment = new OrganizationDepartment({
        customerId: customer._id,
        customerName: customer.name,
        customerEmail: customer.email,
        customerPhone: customer.phone,
        departments: processedDepartments
      });
    }
    
    await organizationDepartment.save();
    
    // Populate for response
    const populatedOrg = await OrganizationDepartment.findById(organizationDepartment._id)
      .populate("departments.designations.assignedStockItems.stockItemId", "name reference category");
    
    res.json({
      success: true,
      message: "Organization departments saved successfully",
      organizationDepartment: populatedOrg
    });
    
  } catch (error) {
    console.error("Error saving organization departments:", error);
    res.status(500).json({
      success: false,
      message: "Server error while saving organization departments"
    });
  }
});

// DELETE organization department
router.delete("/organization/:customerId", async (req, res) => {
  try {
    const { customerId } = req.params;
    
    const organizationDepartment = await OrganizationDepartment.findOneAndUpdate(
      { customerId: customerId },
      { status: "inactive" },
      { new: true }
    );
    
    if (!organizationDepartment) {
      return res.status(404).json({
        success: false,
        message: "Organization departments not found"
      });
    }
    
    res.json({
      success: true,
      message: "Organization departments deactivated successfully"
    });
    
  } catch (error) {
    console.error("Error deleting organization departments:", error);
    res.status(500).json({
      success: false,
      message: "Server error while deleting organization departments"
    });
  }
});

// GET stock items for autocomplete WITH VARIANTS
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
      .select("_id name reference category status variants")
      .limit(20)
      .lean();
    
    // Process stock items to include variant information
    const processedStockItems = stockItems.map(item => ({
      _id: item._id,
      name: item.name,
      reference: item.reference,
      category: item.category || "Uncategorized",
      status: item.status,
      variants: item.variants || []
    }));
    
    res.json({
      success: true,
      stockItems: processedStockItems
    });
    
  } catch (error) {
    console.error("Error searching stock items:", error);
    res.status(500).json({
      success: false,
      message: "Server error while searching stock items"
    });
  }
});

// ACTIVATE organization departments
router.post("/organization/:customerId/activate", async (req, res) => {
  try {
    const { customerId } = req.params;
    
    const organizationDepartment = await OrganizationDepartment.findOneAndUpdate(
      { customerId: customerId },
      { status: "active" },
      { new: true }
    );
    
    if (!organizationDepartment) {
      return res.status(404).json({
        success: false,
        message: "Organization departments not found"
      });
    }
    
    res.json({
      success: true,
      message: "Organization departments activated successfully"
    });
    
  } catch (error) {
    console.error("Error activating organization departments:", error);
    res.status(500).json({
      success: false,
      message: "Server error while activating organization departments"
    });
  }
});

// Add this new route after the existing routes:

// UPDATE single department (for individual department editing)
// PUT route for updating a specific department (for the new single department edit mode)
router.put("/organization/:customerId/departments/single", async (req, res) => {
  try {
    const { customerId } = req.params;
    const { department } = req.body;
    
    console.log("PUT request received for department:", department);
    
    // Get customer details
    const customer = await Customer.findById(customerId)
      .select("_id name email phone")
      .lean();
    
    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Customer not found"
      });
    }
    
    // Validate department data
    if (!department) {
      return res.status(400).json({
        success: false,
        message: "Department data is required"
      });
    }
    
    if (!department.name || !department.name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Department name is required"
      });
    }
    
    // If department has _id, it's an update, otherwise it's an error
    if (!department._id) {
      return res.status(400).json({
        success: false,
        message: "Department ID is required for update"
      });
    }
    
    // Validate designations
    for (const designation of department.designations || []) {
      if (!designation.name || !designation.name.trim()) {
        return res.status(400).json({
          success: false,
          message: "Designation name is required"
        });
      }
      
      // Validate stock items if they exist
      
    }
    
    // Get existing organization department
    let organizationDepartment = await OrganizationDepartment.findOne({
      customerId: customerId,
      status: "active"
    });
    
    if (!organizationDepartment) {
      // Create new organization department if it doesn't exist
      organizationDepartment = new OrganizationDepartment({
        customerId: customer._id,
        customerName: customer.name,
        customerEmail: customer.email,
        customerPhone: customer.phone,
        departments: []
      });
    }
    
    // Find the department index by _id
    const departmentIndex = organizationDepartment.departments.findIndex(
      dept => dept._id && dept._id.toString() === department._id
    );
    
    // Process the department
    const processedDepartment = await (async () => {
      const processedDesignations = await Promise.all(
        (department.designations || []).map(async (designation) => {
          const processedStockItems = await Promise.all(
            (designation.assignedStockItems || []).map(async (item) => {
              const stockItem = await StockItem.findById(item.stockItemId);
              let variantName = "Default";
              
              if (item.variantId && stockItem) {
                const variant = stockItem.variants.id(item.variantId);
                if (variant) {
                  variantName = variant.attributes?.map(a => a.value).join(" • ") || "Default";
                }
              }
              
              return {
                stockItemId: item.stockItemId,
                quantity: item.quantity || 1,
                variantId: item.variantId || null,
                variantName: variantName
              };
            })
          );
          
          return {
            name: designation.name.trim(),
            description: (designation.description || "").trim(),
            status: designation.status || "active",
            assignedStockItems: processedStockItems
          };
        })
      );
      
      return {
        _id: department._id, // Preserve the original _id
        name: department.name.trim(),
        description: (department.description || "").trim(),
        status: department.status || "active",
        designations: processedDesignations
      };
    })();
    
    if (departmentIndex !== -1) {
      // Update existing department
      organizationDepartment.departments[departmentIndex] = processedDepartment;
    } else {
      // Add as new department (this shouldn't happen for PUT, but handle it)
      organizationDepartment.departments.push(processedDepartment);
    }
    
    await organizationDepartment.save();
    
    // Populate for response
    const populatedOrg = await OrganizationDepartment.findById(organizationDepartment._id)
      .populate("departments.designations.assignedStockItems.stockItemId", "name reference category");
    
    res.json({
      success: true,
      message: departmentIndex !== -1 ? "Department updated successfully" : "Department added successfully",
      organizationDepartment: populatedOrg
    });
    
  } catch (error) {
    console.error("Error updating department:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating department"
    });
  }
});


// POST route for creating a new department
router.post("/organization/:customerId/departments/single", async (req, res) => {
  try {
    const { customerId } = req.params;
    const { department } = req.body;
    
    console.log("POST request received for new department:", department);
    
    // Get customer details
    const customer = await Customer.findById(customerId)
      .select("_id name email phone")
      .lean();
    
    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Customer not found"
      });
    }
    
    // Validate department data
    if (!department) {
      return res.status(400).json({
        success: false,
        message: "Department data is required"
      });
    }
    
    if (!department.name || !department.name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Department name is required"
      });
    }
    
    // Validate designations
    for (const designation of department.designations || []) {
      if (!designation.name || !designation.name.trim()) {
        return res.status(400).json({
          success: false,
          message: "Designation name is required"
        });
      }
      
      // Validate stock items if they exist
      
    }
    
    // Get existing organization department or create new
    let organizationDepartment = await OrganizationDepartment.findOne({
      customerId: customerId,
      status: "active"
    });
    
    if (!organizationDepartment) {
      organizationDepartment = new OrganizationDepartment({
        customerId: customer._id,
        customerName: customer.name,
        customerEmail: customer.email,
        customerPhone: customer.phone,
        departments: []
      });
    }
    
    // Process the new department
    const processedDepartment = await (async () => {
      const processedDesignations = await Promise.all(
        (department.designations || []).map(async (designation) => {
          const processedStockItems = await Promise.all(
            (designation.assignedStockItems || []).map(async (item) => {
              const stockItem = await StockItem.findById(item.stockItemId);
              let variantName = "Default";
              
              if (item.variantId && stockItem) {
                const variant = stockItem.variants.id(item.variantId);
                if (variant) {
                  variantName = variant.attributes?.map(a => a.value).join(" • ") || "Default";
                }
              }
              
              return {
                stockItemId: item.stockItemId,
                quantity: item.quantity || 1,
                variantId: item.variantId || null,
                variantName: variantName
              };
            })
          );
          
          return {
            name: designation.name.trim(),
            description: (designation.description || "").trim(),
            status: designation.status || "active",
            assignedStockItems: processedStockItems
          };
        })
      );
      
      return {
        name: department.name.trim(),
        description: (department.description || "").trim(),
        status: department.status || "active",
        designations: processedDesignations
      };
    })();
    
    // Add new department
    organizationDepartment.departments.push(processedDepartment);
    
    await organizationDepartment.save();
    
    // Populate for response
    const populatedOrg = await OrganizationDepartment.findById(organizationDepartment._id)
      .populate("departments.designations.assignedStockItems.stockItemId", "name reference category");
    
    res.json({
      success: true,
      message: "Department created successfully",
      organizationDepartment: populatedOrg
    });
    
  } catch (error) {
    console.error("Error creating department:", error);
    res.status(500).json({
      success: false,
      message: "Server error while creating department"
    });
  }
});

module.exports = router;