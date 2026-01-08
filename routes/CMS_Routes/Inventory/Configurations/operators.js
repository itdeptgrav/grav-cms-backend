const express = require("express");
const router = express.Router();
const Employee = require("../../../../models/Employee");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

// ✅ GET all operator department employees
router.get("/", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { search = "", department = "", status = "" } = req.query;
    
    let filter = { 
      department: "Operator" // Only show Operator department employees
    };
    
    // Additional filters
    if (search) {
      filter.$or = [
        { firstName: { $regex: search, $options: "i" } },
        { lastName: { $regex: search, $options: "i" } },
        { employeeId: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { jobTitle: { $regex: search, $options: "i" } },
        { jobPosition: { $regex: search, $options: "i" } }
      ];
    }
    
    if (department && department !== "all") {
      filter.department = department;
    }
    
    if (status && status !== "all") {
      filter.status = status;
    }
    
    // Get operators with pagination
    const operators = await Employee.find(filter)
      .select("-password -__v -createdBy -updatedAt")
      .sort({ firstName: 1 })
      .lean();
    
    // Calculate statistics
    const total = operators.length;
    const active = operators.filter(e => e.status === "active").length;
    const onLeave = operators.filter(e => e.status === "on_leave").length;
    const trainee = operators.filter(e => e.status === "draft").length;
    
    // Get department distribution
    const departmentStats = {};
    operators.forEach(emp => {
      if (emp.department) {
        departmentStats[emp.department] = (departmentStats[emp.department] || 0) + 1;
      }
    });
    
    res.json({
      success: true,
      employees: operators,
      stats: {
        total,
        active,
        onLeave,
        trainee,
        departmentStats
      }
    });
    
  } catch (error) {
    console.error("Error fetching operators:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error while fetching operators" 
    });
  }
});

// ✅ GET single operator by ID
router.get("/:id", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const operator = await Employee.findById(req.params.id)
      .select("-password -__v")
      .lean();
    
    if (!operator) {
      return res.status(404).json({
        success: false,
        message: "Operator not found"
      });
    }
    
    // Check if employee is from Operator department
    if (operator.department !== "Operator") {
      return res.status(403).json({
        success: false,
        message: "Employee is not from Operator department"
      });
    }
    
    res.json({ 
      success: true, 
      data: operator 
    });
    
  } catch (error) {
    console.error("Error fetching operator:", error);
    
    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid operator ID"
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: "Server error while fetching operator" 
    });
  }
});

// ✅ GET departments for operator employees
router.get("/departments/list", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const departments = await Employee.distinct("department", { 
      department: { $ne: null },
      department: { $ne: "Operator" } // Exclude the main Operator department
    });
    
    res.json({
      success: true,
      departments: departments.sort()
    });
    
  } catch (error) {
    console.error("Error fetching departments:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error while fetching departments" 
    });
  }
});

module.exports = router;