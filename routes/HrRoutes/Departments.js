const express = require("express");
const router = express.Router();
const Department = require("../../models/HR_Models/Departments");
const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");

// ✅ GET all departments with designations for dropdown
router.get("/with-designations", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const departments = await Department.find({ status: "active" })
      .select("name designations")
      .lean();

    const formattedData = departments.map((dept) => ({
      id: dept._id,
      name: dept.name,
      designations: dept.designations
        .filter((des) => des.isActive)
        .map((des) => des.name),
    }));

    res.status(200).json({
      success: true,
      data: formattedData,
    });
  } catch (error) {
    console.error("Get departments with designations error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching departments",
    });
  }
});

// The GET single department route to include employee data
router.get("/:id/with-employees", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const department = await Department.findById(id).select("-__v").lean();

    if (!department) {
      return res.status(404).json({
        success: false,
        message: "Department not found",
      });
    }

    // Fetch employees for each designation
    const designationsWithEmployees = await Promise.all(
      department.designations.map(async (designation) => {
        // Find employees with this department and designation
        const employees = await Employee.find({
          departmentId: id,
          designation: designation.name,
          status: "active",
          isActive: true,
        })
          .select("firstName lastName employeeId email department designation")
          .lean();

        return {
          ...designation,
          employees: employees.map((emp) => ({
            id: emp._id,
            employeeId: emp.employeeId,
            name: `${emp.firstName} ${emp.lastName}`,
            email: emp.email,
            department: emp.department,
            designation: emp.designation,
          })),
        };
      }),
    );

    const departmentWithEmployees = {
      ...department,
      designations: designationsWithEmployees,
    };

    res.status(200).json({
      success: true,
      data: departmentWithEmployees,
    });
  } catch (error) {
    console.error("Get department with employees error:", error);

    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid department ID",
      });
    }

    res.status(500).json({
      success: false,
      message: "Error fetching department with employees",
    });
  }
});

router.post("/", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { user } = req;
    const departmentData = req.body;

    // Check duplicate department name
    const existingDepartment = await Department.findOne({
      name: { $regex: new RegExp(`^${departmentData.name}$`, "i") },
    });

    if (existingDepartment) {
      return res.status(400).json({
        success: false,
        message: "Department name already exists",
      });
    }

    // Validate managers for each designation
    if (departmentData.designations && departmentData.designations.length > 0) {
      for (const designation of departmentData.designations) {
        if (designation.managers && designation.managers.length > 0) {
          // Verify all referenced departments exist
          const managerDepartmentIds = designation.managers
            .map((mgr) => mgr.departmentId)
            .filter((id) => id);

          const existingDepartments = await Department.find({
            _id: { $in: managerDepartmentIds },
          }).select("_id name designations");

          const existingDepartmentMap = new Map(
            existingDepartments.map((dept) => [dept._id.toString(), dept]),
          );

          // Validate each manager for this designation
          for (const manager of designation.managers) {
            const dept = existingDepartmentMap.get(manager.departmentId);
            if (!dept) {
              return res.status(400).json({
                success: false,
                message: `Referenced department not found: ${manager.departmentId}`,
              });
            }

            // Check if designation exists in the referenced department
            const designationExists = dept.designations.some(
              (des) => des.name === manager.designationName && des.isActive,
            );

            if (!designationExists) {
              return res.status(400).json({
                success: false,
                message: `Designation '${manager.designationName}' not found in department '${dept.name}'`,
              });
            }

            // Add department name to manager object
            manager.departmentName = dept.name;
          }
        }
      }
    }

    // Add createdBy and updatedBy
    departmentData.createdBy = user.id;
    departmentData.updatedBy = user.id;

    const newDepartment = new Department(departmentData);
    await newDepartment.save();

    res.status(201).json({
      success: true,
      message: "Department created successfully",
      data: newDepartment,
    });
  } catch (error) {
    console.error("Create department error:", error);

    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((err) => err.message);
      return res.status(400).json({
        success: false,
        message: "Validation error",
        errors,
      });
    }

    res.status(500).json({
      success: false,
      message: "Error creating department",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// ✅ UPDATE department
router.put("/:id", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const updateData = req.body;

    // Check if department exists
    const existingDepartment = await Department.findById(id);
    if (!existingDepartment) {
      return res.status(404).json({
        success: false,
        message: "Department not found",
      });
    }

    // Check duplicate department name (if name is being updated)
    if (updateData.name && updateData.name !== existingDepartment.name) {
      const duplicateDepartment = await Department.findOne({
        name: { $regex: new RegExp(`^${updateData.name}$`, "i") },
        _id: { $ne: id },
      });

      if (duplicateDepartment) {
        return res.status(400).json({
          success: false,
          message: "Department name already exists",
        });
      }
    }

    // Validate managers for each designation if being updated
    if (updateData.designations && updateData.designations.length > 0) {
      for (const designation of updateData.designations) {
        if (designation.managers && designation.managers.length > 0) {
          // Verify all referenced departments exist
          const managerDepartmentIds = designation.managers
            .map((mgr) => mgr.departmentId)
            .filter((id) => id);

          const existingDepartments = await Department.find({
            _id: { $in: managerDepartmentIds },
          }).select("_id name designations");

          const existingDepartmentMap = new Map(
            existingDepartments.map((dept) => [dept._id.toString(), dept]),
          );

          // Validate each manager for this designation
          for (const manager of designation.managers) {
            const dept = existingDepartmentMap.get(manager.departmentId);
            if (!dept) {
              return res.status(400).json({
                success: false,
                message: `Referenced department not found: ${manager.departmentId}`,
              });
            }

            // Check if designation exists in the referenced department
            const designationExists = dept.designations.some(
              (des) => des.name === manager.designationName && des.isActive,
            );

            if (!designationExists) {
              return res.status(400).json({
                success: false,
                message: `Designation '${manager.designationName}' not found in department '${dept.name}'`,
              });
            }

            // Add department name to manager object
            manager.departmentName = dept.name;
          }
        }
      }
    }

    // Add updatedBy
    updateData.updatedBy = user.id;
    updateData.updatedAt = new Date();

    const updatedDepartment = await Department.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true },
    ).select("-__v");

    res.status(200).json({
      success: true,
      message: "Department updated successfully",
      data: updatedDepartment,
    });
  } catch (error) {
    console.error("Update department error:", error);

    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((err) => err.message);
      return res.status(400).json({
        success: false,
        message: "Validation error",
        errors,
      });
    }

    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid department ID",
      });
    }

    res.status(500).json({
      success: false,
      message: "Error updating department",
    });
  }
});

// ✅ GET all departments (for dropdown suggestions)
router.get("/suggestions", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const departments = await Department.find({ status: "active" })
      .select("name")
      .lean();

    const departmentNames = departments.map((dept) => dept.name);

    res.status(200).json({
      success: true,
      data: departmentNames,
    });
  } catch (error) {
    console.error("Get department suggestions error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching department suggestions",
    });
  }
});

// ✅ GET all departments
router.get("/", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const departments = await Department.find({ status: "active" })
      .sort({ name: 1 })
      .select("-__v")
      .lean();

    res.status(200).json({
      success: true,
      data: departments,
      count: departments.length,
    });
  } catch (error) {
    console.error("Get departments error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching departments",
    });
  }
});

// ✅ GET single department by ID
router.get("/:id", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const department = await Department.findById(id).select("-__v").lean();

    if (!department) {
      return res.status(404).json({
        success: false,
        message: "Department not found",
      });
    }

    res.status(200).json({
      success: true,
      data: department,
    });
  } catch (error) {
    console.error("Get department error:", error);

    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid department ID",
      });
    }

    res.status(500).json({
      success: false,
      message: "Error fetching department",
    });
  }
});

// ✅ DELETE department (soft delete)
router.delete("/:id", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const department = await Department.findById(id);
    if (!department) {
      return res.status(404).json({
        success: false,
        message: "Department not found",
      });
    }

    // Soft delete by setting status to inactive
    department.status = "inactive";
    department.updatedAt = new Date();
    await department.save();

    res.status(200).json({
      success: true,
      message: "Department deactivated successfully",
    });
  } catch (error) {
    console.error("Delete department error:", error);

    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid department ID",
      });
    }

    res.status(500).json({
      success: false,
      message: "Error deleting department",
    });
  }
});

module.exports = router;
