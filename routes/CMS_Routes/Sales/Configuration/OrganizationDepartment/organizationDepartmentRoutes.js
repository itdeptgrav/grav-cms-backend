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
    
    // Validate stock items exist
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
        }
      }
    }
    
    // Check if organization department exists
    let organizationDepartment = await OrganizationDepartment.findOne({
      customerId: customerId,
      status: "active"
    });
    
    if (organizationDepartment) {
      // Update existing
      organizationDepartment.departments = departments.map(dept => ({
        name: dept.name,
        description: dept.description || "",
        status: dept.status || "active",
        designations: dept.designations?.map(designation => ({
          name: designation.name,
          description: designation.description || "",
          status: designation.status || "active",
          assignedStockItems: designation.assignedStockItems?.map(item => ({
            stockItemId: item.stockItemId,
            quantity: item.quantity || 1
          })) || []
        })) || []
      }));
    } else {
      // Create new
      organizationDepartment = new OrganizationDepartment({
        customerId: customer._id,
        customerName: customer.name,
        customerEmail: customer.email,
        customerPhone: customer.phone,
        departments: departments.map(dept => ({
          name: dept.name,
          description: dept.description || "",
          status: dept.status || "active",
          designations: dept.designations?.map(designation => ({
            name: designation.name,
            description: designation.description || "",
            status: designation.status || "active",
            assignedStockItems: designation.assignedStockItems?.map(item => ({
              stockItemId: item.stockItemId,
              quantity: item.quantity || 1
            })) || []
          })) || []
        }))
      });
    }
    
    await organizationDepartment.save();
    
    res.json({
      success: true,
      message: "Organization departments saved successfully",
      organizationDepartment
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

module.exports = router;