const express = require("express");
const router = express.Router();
const Department = require("../../models/HR_Models/Departments");
const Employee = require("../../models/Employee");
const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");
const { recordChange } = require("../../services/changeLog");

// Every department edit, in the Departments page history.
const auditDept = (req, entry) =>
  recordChange(req, { departmentSlug: "hr", section: "hr:departments", ...entry });

/**
 * A department's designations, flattened so a diff can name the one that moved.
 *
 * Designations are the part of a department people actually edit, and comparing
 * the raw arrays reports "designations changed" for a single renamed job title.
 * Keyed by name so adding one at the top does not read as every row changing.
 */
function designationMap(dept) {
  const out = {};
  for (const d of dept?.designations || []) {
    if (!d?.name) continue;
    out[d.name] = {
      active: d.isActive !== false,
      manager: d.managerName || d.manager || "",
      level: d.level ?? "",
    };
  }
  return out;
}

// "FIRSTNAME LASTNAME (GR0045)" — the same label format employee docs already
// store in primaryManager.managerName (see leave approval flow).
function managerLabel(emp) {
  const name = [emp.firstName, emp.lastName].filter(Boolean).join(" ").trim();
  return emp.biometricId ? `${name} (${emp.biometricId})` : name;
}

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

// ✅ GET designations by department ID
router.get(
  "/:id/designations-list",
  EmployeeAuthMiddleware,
  async (req, res) => {
    try {
      const { id } = req.params;

      const department = await Department.findById(id)
        .select("name designations")
        .lean();

      if (!department) {
        return res.status(404).json({
          success: false,
          message: "Department not found",
        });
      }

      const activeDesignations = department.designations
        .filter((des) => des.isActive)
        .map((des) => des.name);

      res.status(200).json({
        success: true,
        data: {
          departmentName: department.name,
          designations: activeDesignations,
        },
      });
    } catch (error) {
      console.error("Get designations list error:", error);

      if (error.name === "CastError") {
        return res.status(400).json({
          success: false,
          message: "Invalid department ID",
        });
      }

      res.status(500).json({
        success: false,
        message: "Error fetching designations",
      });
    }
  },
);

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

    await auditDept(req, {
      entity: "department",
      entityId: String(newDepartment._id),
      entityLabel: newDepartment.name,
      action: "create",
      summary:
        `Created department “${newDepartment.name}”` +
        `${newDepartment.code ? ` (${newDepartment.code})` : ""} with ` +
        `${newDepartment.designations?.length || 0} designation(s)` +
        `${newDepartment.designations?.length ? `: ${newDepartment.designations.map((d) => d.name).join(", ")}` : ""}.`,
      after: {
        name: newDepartment.name,
        code: newDepartment.code || "",
        description: newDepartment.description || "",
        status: newDepartment.status,
        designations: designationMap(newDepartment),
      },
    });

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

// ✅ ASSIGN department managers (+ optional propagation to existing employees)
//
// Body: {
//   primaryManagerId:   ObjectId | null,   // null/"" clears the slot
//   secondaryManagerId: ObjectId | null,
//   applyToExisting:    boolean            // default true — push onto every
// }                                        // active employee of this department
//
// New employees inherit these automatically at creation (Employee-Section POST).
router.put("/:id/managers", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { user } = req;
    if (user.role !== "hr_manager") {
      return res.status(403).json({
        success: false,
        message: "Only HR can assign department managers",
      });
    }
    const { id } = req.params;
    const {
      primaryManagerId,
      secondaryManagerId,
      applyToExisting = true,
    } = req.body;

    const department = await Department.findById(id);
    if (!department) {
      return res
        .status(404)
        .json({ success: false, message: "Department not found" });
    }

    // Resolve the chosen people once; names are denormalised onto both the
    // department and every propagated employee.
    const resolveManager = async (managerId) => {
      if (!managerId) return null;
      const emp = await Employee.findById(managerId)
        .select("firstName lastName biometricId designation")
        .lean();
      if (!emp) return undefined; // requested but not found → error
      return {
        managerId: emp._id,
        managerName: managerLabel(emp),
        designation: emp.designation || "",
      };
    };

    const primary = await resolveManager(primaryManagerId);
    const secondary = await resolveManager(secondaryManagerId);
    if (primary === undefined || secondary === undefined) {
      return res
        .status(400)
        .json({ success: false, message: "Selected manager not found" });
    }

    const beforeSnap = {
      primaryManager: department.primaryManager?.managerName || "",
      secondaryManager: department.secondaryManager?.managerName || "",
    };

    department.primaryManager = primary || {
      managerId: null,
      managerName: "",
      designation: "",
    };
    department.secondaryManager = secondary || {
      managerId: null,
      managerName: "",
      designation: "",
    };
    department.updatedBy = user.id;
    await department.save();

    // Propagate to everyone already in the department. Matches by departmentId
    // OR by the department name string, because older employee rows only carry
    // the string. The managers themselves are excluded so nobody becomes their
    // own manager. Slots without a chosen person are left untouched on the
    // employees (clearing the department slot never mass-wipes employees).
    let updatedEmployees = 0;
    if (applyToExisting && (primary || secondary)) {
      const set = { updatedAt: new Date(), updatedBy: user.id };
      if (primary)
        set.primaryManager = {
          managerId: primary.managerId,
          managerName: primary.managerName,
        };
      if (secondary)
        set.secondaryManager = {
          managerId: secondary.managerId,
          managerName: secondary.managerName,
        };
      const excludeIds = [primary?.managerId, secondary?.managerId].filter(
        Boolean,
      );
      const match = {
        $and: [
          {
            $or: [
              { departmentId: department._id },
              {
                department: {
                  $regex: new RegExp(
                    `^${department.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
                    "i",
                  ),
                },
              },
            ],
          },
          {
            $or: [
              { status: "active" },
              { status: { $exists: false } },
              { isActive: true },
            ],
          },
        ],
      };
      if (excludeIds.length) match.$and.push({ _id: { $nin: excludeIds } });
      // Plain $set is safe here: no salary field is touched, so bypassing the
      // pre-save hook (which recalculates + re-encrypts salary) is fine.
      const result = await Employee.updateMany(match, { $set: set });
      updatedEmployees = result.modifiedCount || 0;
    }

    recordChange(req, {
      departmentSlug: "hr",
      section: "hr:departments",
      entity: "department",
      entityId: id,
      entityLabel: department.name,
      action: "update",
      summary: `Department managers set${applyToExisting ? ` (applied to ${updatedEmployees} employees)` : ""}`,
      before: beforeSnap,
      after: {
        primaryManager: primary?.managerName || "",
        secondaryManager: secondary?.managerName || "",
      },
    });

    res.status(200).json({
      success: true,
      message: `Managers saved${applyToExisting ? ` — applied to ${updatedEmployees} employee${updatedEmployees === 1 ? "" : "s"}` : ""}`,
      data: {
        primaryManager: department.primaryManager,
        secondaryManager: department.secondaryManager,
        updatedEmployees,
      },
    });
  } catch (error) {
    console.error("Assign department managers error:", error);
    if (error.name === "CastError") {
      return res
        .status(400)
        .json({ success: false, message: "Invalid ID" });
    }
    res.status(500).json({
      success: false,
      message: "Error assigning department managers",
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

    // `existingDepartment` was read at the top of the handler, before the
    // write — which is the only reason this can report a real before/after.
    await auditDept(req, {
      entity: "department",
      entityId: String(id),
      entityLabel: updatedDepartment?.name || existingDepartment.name,
      action: "update",
      before: {
        name: existingDepartment.name,
        code: existingDepartment.code || "",
        description: existingDepartment.description || "",
        status: existingDepartment.status,
        designations: designationMap(existingDepartment),
      },
      after: {
        name: updatedDepartment?.name,
        code: updatedDepartment?.code || "",
        description: updatedDepartment?.description || "",
        status: updatedDepartment?.status,
        designations: designationMap(updatedDepartment),
      },
    });

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
    const previousStatus = department.status;
    department.status = "inactive";
    department.updatedAt = new Date();
    await department.save();

    // Logged as a delete even though the row survives: "deactivated" is what
    // the button says and what the reader means, and calling it an update
    // would file the most consequential change on the page alongside a
    // description edit.
    await auditDept(req, {
      entity: "department",
      entityId: String(id),
      entityLabel: department.name,
      action: "delete",
      summary:
        `Deactivated department “${department.name}”. The record was kept and its ` +
        `${department.designations?.length || 0} designation(s) are unchanged — only its status moved to inactive.`,
      before: { status: previousStatus },
      after: { status: "inactive" },
    });

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
