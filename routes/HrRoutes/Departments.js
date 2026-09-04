const express = require("express");
const router = express.Router();
const Department = require("../../models/HR_Models/Departments");
const Employee = require("../../models/Employee");
const mongoose = require("mongoose");
const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");
const { recordChange } = require("../../services/changeLog");

/* Department names are free text and reach Mongo as anchored regexes in three
   places here. Escaped once, centrally, because a name holding "(" is a
   crashing regex and a name holding "." silently matches the wrong row. */
const escapeRegex = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

// ✅ MANAGER CANDIDATES for one department (optionally one designation)
//
// GET /:id/manager-candidates?designation=Graphic%20Designer&exclude=<employeeId>
//
// WHO IS A MANAGER IS ALREADY CONFIGURED — THIS ONLY RESOLVES IT TO PEOPLE
// -----------------------------------------------------------------------
// A designation carries `managers`: a list of (department, designation) PAIRS
// saying who manages that role — "Graphic Designer in Designing is managed by
// CEO in Corporate". So the answer to "who may manage this employee" is not a
// search over staff, it is a lookup of the people currently holding those
// configured roles, plus the department's own primary/secondary if set.
//
// Nothing else is offered. Earlier this widened to "everyone in the
// department" when no configuration matched, which put the employee's own
// colleagues — and the employee themselves — in the list. An empty list is the
// honest answer to "no manager has been configured for this role": it sends
// somebody to the Departments page to say who the manager is, which is the
// thing that then propagates to everyone.
//
// `exclude` is the employee being edited. Nobody manages themselves, and the
// form was offering exactly that (GR0124 listed as their own primary manager)
// because the old list was department-wide.
router.get("/:id/manager-candidates", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const esc = escapeRegex;

    const department = mongoose.Types.ObjectId.isValid(id)
      ? await Department.findById(id).lean()
      : await Department.findOne({ name: new RegExp(`^${esc(id)}$`, "i") }).lean();
    if (!department) {
      return res.status(404).json({ success: false, message: "Department not found" });
    }

    const wantedDesignation = String(req.query.designation || "").trim();
    const excludeId = String(req.query.exclude || "");

    /* The (department, designation) pairs configured as managers. When a
       designation is named, only its own pairs; otherwise every pair the
       department configures, so the picker still works before a designation is
       chosen. */
    const pairs = [];
    for (const d of department.designations || []) {
      if (
        wantedDesignation &&
        String(d.name || "").trim().toLowerCase() !== wantedDesignation.toLowerCase()
      ) {
        continue;
      }
      for (const m of d.managers || []) {
        if (m?.departmentName && m?.designationName) {
          pairs.push({ departmentName: m.departmentName, designationName: m.designationName });
        }
      }
    }

    /* Resolve each pair to the people actually holding that role now. This is
       what makes a manager replacement propagate: nobody is stored here, so
       whoever holds the role today is who the picker offers. */
    const holders = pairs.length
      ? await Employee.find({
          $and: [
            { $or: [{ isActive: { $ne: false } }, { status: "active" }] },
            {
              $or: pairs.map((pr) => ({
                department: new RegExp(`^${esc(pr.departmentName)}$`, "i"),
                designation: new RegExp(`^${esc(pr.designationName)}$`, "i"),
              })),
            },
          ],
        })
          .select("firstName lastName biometricId designation department")
          .sort({ firstName: 1 })
          .lean()
      : [];

    const out = [];
    const seen = new Set();
    const push = (e, why) => {
      const key = String(e._id || e.managerId);
      if (!key || key === excludeId || seen.has(key)) return;
      seen.add(key);
      out.push({
        id: key,
        fullName:
          e.fullName ||
          [e.firstName, e.lastName].filter(Boolean).join(" ").trim() ||
          e.managerName ||
          "",
        biometricId: e.biometricId || "",
        designation: e.designation || "",
        department: e.department || department.name,
        why,
      });
    };

    /* The department's own choices lead — they are the most explicit statement
       of who is in charge here. */
    for (const slot of ["primaryManager", "secondaryManager"]) {
      const m = department[slot];
      if (!m?.managerId) continue;
      const full = await Employee.findById(m.managerId)
        .select("firstName lastName biometricId designation department")
        .lean();
      push(
        full || { _id: m.managerId, fullName: m.managerName, designation: m.designation },
        slot === "primaryManager" ? "department primary" : "department secondary",
      );
    }
    for (const h of holders) {
      push(h, `manages ${wantedDesignation || "this department"}`);
    }

    res.json({
      success: true,
      department: { _id: department._id, name: department.name },
      designation: wantedDesignation || null,
      /* Told rather than implied, so the form can say WHY the list is empty
         instead of showing a blank box that reads as a loading failure. */
      configured: pairs.length > 0 || Boolean(department.primaryManager?.managerId),
      data: out,
    });
  } catch (error) {
    console.error("Manager candidates error:", error);
    res.status(500).json({ success: false, message: "Server error" });
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
    const secondaryRaw = await resolveManager(secondaryManagerId);
    if (primary === undefined || secondaryRaw === undefined) {
      return res
        .status(400)
        .json({ success: false, message: "Selected manager not found" });
    }

    /* NOBODY IS LEFT WITHOUT A LEAD. A department left with only a secondary —
       the primary resigned, say — promotes that person rather than leaving
       every employee with an empty primary slot and an approval chain that
       stops. The vacated secondary is not back-filled from thin air; one real
       manager in the right slot beats two slots pointing at one person. */
    const promoted = !primary && Boolean(secondaryRaw);
    const effectivePrimary = primary || secondaryRaw;
    const effectiveSecondary = promoted ? null : secondaryRaw;

    const beforeSnap = {
      primaryManager: department.primaryManager?.managerName || "",
      secondaryManager: department.secondaryManager?.managerName || "",
    };
    /* Read BEFORE the department is overwritten: clearing a slot has to know
       who used to be in it to clear exactly the employees who followed them. */
    const beforeIds = {
      primary: department.primaryManager?.managerId || null,
      secondary: department.secondaryManager?.managerId || null,
    };

    department.primaryManager = effectivePrimary || {
      managerId: null,
      managerName: "",
      designation: "",
    };
    department.secondaryManager = effectiveSecondary || {
      managerId: null,
      managerName: "",
      designation: "",
    };
    department.updatedBy = user.id;
    await department.save();

    /* PROPAGATE TO EVERYONE ALREADY IN THE DEPARTMENT.
       This is the half that makes "the manager was replaced" a one-place edit:
       each employee row carries its own primaryManager/secondaryManager, so
       without this a replacement would only change the department header and
       leave every employee still reporting to somebody who has left.

       Matched by departmentId OR by the department name string, because older
       employee rows only carry the string. The new manager is excluded from
       their own slot so nobody becomes their own manager. */
    const inDepartment = () => ({
      $and: [
        {
          $or: [
            { departmentId: department._id },
            {
              department: {
                $regex: new RegExp(`^${escapeRegex(department.name)}$`, "i"),
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
    });

    let updatedEmployees = 0;
    if (applyToExisting) {
      const touched = new Set();

      /* A slot that now HAS somebody is pushed to the whole department — that
         is the replacement case, and it is what makes one edit reach everyone.
         A slot that has been EMPTIED is cleared only on the employees actually
         pointing at the person who left: withdrawing the department's choice
         must not wipe a manager somebody set by hand on one employee. */
      const slots = [
        ["primaryManager", effectivePrimary, beforeIds.primary],
        ["secondaryManager", effectiveSecondary, beforeIds.secondary],
      ];

      for (const [field, next, previousId] of slots) {
        const match = inDepartment();
        let set;

        if (next) {
          set = {
            [field]: { managerId: next.managerId, managerName: next.managerName },
          };
          match.$and.push({ _id: { $ne: next.managerId } });
        } else if (previousId) {
          set = { [field]: { managerId: null, managerName: "" } };
          match.$and.push({ [`${field}.managerId`]: previousId });
        } else {
          continue; // empty before, empty after — nothing to say
        }

        /* Who is affected is read before the write, because after it the match
           for a cleared slot no longer selects anybody. */
        const affected = await Employee.find(match).select("_id").lean();
        for (const doc of affected) touched.add(String(doc._id));

        set.updatedAt = new Date();
        set.updatedBy = user.id;
        /* Plain $set is safe here: no salary field is touched, so bypassing the
           pre-save hook (which recalculates + re-encrypts salary) is fine. */
        await Employee.updateMany(match, { $set: set });
      }

      /* Counted as PEOPLE, not as writes — a run that changes both slots on the
         same twelve employees affected twelve people, and reporting
         twenty-four would overstate what happened. */
      updatedEmployees = touched.size;
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
        primaryManager: effectivePrimary?.managerName || "",
        secondaryManager: effectiveSecondary?.managerName || "",
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
