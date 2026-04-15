const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const Employee = require("../../models/Employee");
const SalaryConfig = require("../../models/Salaryconfig");
const EmployeeAuthMiddlewear = require("../../Middlewear/EmployeeAuthMiddlewear");
const emailService = require("../../services/emailService");

require("dotenv").config();

// ─── SALARY CALCULATION HELPER ───────────────────────────────────────────────
function recalculateSalary(salary = {}, cfg = {}) {
  const basicPct = (cfg.basicPct ?? 50) / 100;
  const hraPct = (cfg.hraPct ?? 50) / 100;
  const eepfPct = (cfg.eepfPct ?? 12) / 100;
  const epfCapAmount = cfg.epfCapAmount ?? 1800;
  const edliPct = (cfg.edliPct ?? 0.5) / 100;
  const edliCapAmount = cfg.edliCapAmount ?? 15000;
  const adminPct = (cfg.adminChargesPct ?? 0.5) / 100;
  const esiWageLimit = cfg.esiWageLimit ?? 21000;
  const eeEsicPct = (cfg.eeEsicPct ?? 0.75) / 100;
  const erEsicPct = (cfg.erEsicPct ?? 3.25) / 100;
  const foodAllowance = cfg.foodAllowance ?? 1600;

  const gross = salary.gross || 0;
  const basic = Math.round(gross * basicPct);
  const hra = Math.round(gross * hraPct);

  // EPF: ROUND(MIN(basic * 12%, epfCapAmount)) — rupee cap of 1,800/mo
  const epf = Math.round(Math.min(basic * eepfPct, epfCapAmount));

  // EDLI & Admin — respect HR override
  const edli = salary.edliOverride
    ? (salary.edli || 0)
    : Math.round(Math.min(basic * edliPct, edliCapAmount));
  const adminCharges = salary.adminOverride
    ? (salary.adminCharges || 0)
    : Math.round(basic * adminPct);

  // ESI — calculated on Basic, applies when Basic <= esiWageLimit
  const esiApplicable = basic <= esiWageLimit;
  const eeesic = esiApplicable ? Math.ceil(basic * eeEsicPct) : 0;
  const erEsic = esiApplicable ? Math.ceil(basic * erEsicPct) : 0;

  // CTC = Gross + EPF + ESIC(ER) + Food Allowance
  const employerCost = gross + epf + erEsic + foodAllowance;

  // Employee deductions = EPF + ESIC(EE)
  const totalDeduction = epf + eeesic;
  const netSalary = Math.max(gross - totalDeduction, 0);

  return {
    gross, basic, hra,
    epf, edli, adminCharges,
    edliOverride: salary.edliOverride || false,
    adminOverride: salary.adminOverride || false,
    eeesic, erEsic, foodAllowance, employerCost,
    totalDeduction, netSalary,
    allowances: hra, deductions: totalDeduction,
  };
}

// ─── SALARY CONFIG — GET ──────────────────────────────────────────────────────
// Using /config/salary so it never collides with the /:id param routes
router.get("/config/salary", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const config = await SalaryConfig.getSingleton();
    res.json({ success: true, data: config });
  } catch (err) {
    console.error("Salary config GET error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch salary config" });
  }
});

// ─── SALARY CONFIG — UPDATE ───────────────────────────────────────────────────
router.put("/config/salary", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;

    const allowed = [
      "basicPct", "hraPct",
      "eepfPct", "epfCapAmount", "foodAllowance",
      "edliPct", "edliCapAmount", "adminChargesPct",
      "esiWageLimit", "eeEsicPct", "erEsicPct",
    ];

    const updates = {};
    allowed.forEach((k) => {
      if (req.body[k] !== undefined) updates[k] = Number(req.body[k]);
    });
    updates.updatedBy = user.id;
    updates.updatedAt = new Date();

    const config = await SalaryConfig.findOneAndUpdate(
      {},
      { $set: updates },
      { new: true, upsert: true, runValidators: true }
    );

    res.json({ success: true, message: "Salary config updated", data: config });
  } catch (err) {
    console.error("Salary config PUT error:", err);
    if (err.name === "ValidationError") {
      const errors = Object.values(err.errors).map((e) => e.message);
      return res.status(400).json({ success: false, message: "Validation error", errors });
    }
    res.status(500).json({ success: false, message: "Failed to update salary config" });
  }
});


// ─── CREATE new employee ──────────────────────────────────────────────────────
router.post("/", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    const employeeData = req.body;

    // Sanitize fields that are ObjectId references — empty string causes a BSONError cast fail
    const OBJECTID_FIELDS = ["departmentId", "primaryManager.managerId", "secondaryManager.managerId"];
    OBJECTID_FIELDS.forEach((path) => {
      const [top, nested] = path.split(".");
      if (nested) {
        if (employeeData[top] && employeeData[top][nested] === "") {
          delete employeeData[top][nested];
        }
      } else {
        if (employeeData[top] === "" || employeeData[top] === null) {
          delete employeeData[top];
        }
      }
    });

    // Also strip any other empty-string values that map to typed fields to avoid cast errors
    if (employeeData.primaryManager && !employeeData.primaryManager.managerId) {
      delete employeeData.primaryManager;
    }
    if (employeeData.secondaryManager && !employeeData.secondaryManager.managerId) {
      delete employeeData.secondaryManager;
    }

    const temporaryPassword = Math.random().toString(36).slice(-8);
    console.log("Generated temporary password:", temporaryPassword);

    const newEmployee = new Employee({
      ...employeeData,
      password: temporaryPassword,
      temporaryPassword: temporaryPassword,
      createdBy: user.id,
      createdAt: new Date(),
    });

    await newEmployee.save();
    console.log("Employee saved with ID:", newEmployee._id);

    // Send welcome email asynchronously
    if (process.env.ENABLE_EMAILS === "true" && employeeData.email) {
      try {
        const emailData = {
          name: [employeeData.firstName, employeeData.lastName].filter(Boolean).join(" ") || "Employee",
          email: employeeData.email,
          employeeId: employeeData.biometricId,
          department: employeeData.department,
          designation: employeeData.designation || employeeData.jobPosition,
          // Don't include temporaryPassword here since it's passed separately
        };

        console.log("Sending welcome email with data:", emailData);
        console.log("With password:", temporaryPassword);

        emailService.sendWelcomeEmail(emailData, temporaryPassword)
          .then(() => {
            console.log("Welcome email sent successfully for employee:", newEmployee._id);
            Employee.findByIdAndUpdate(newEmployee._id, {
              $set: { welcomeEmailSent: true, emailSentAt: new Date() },
              $unset: { temporaryPassword: 1, emailError: 1 }
            }).catch(console.error);
          })
          .catch((err) => {
            console.error("Welcome email failed:", err);
            Employee.findByIdAndUpdate(newEmployee._id, {
              $set: {
                welcomeEmailSent: false,
                emailError: err.message
              }
            }).catch(console.error);
          });
      } catch (e) {
        console.error("Email error:", e);
      }
    } else {
      console.log("Emails disabled or no email provided");
    }

    const resp = newEmployee.toObject();
    delete resp.password;
    delete resp.temporaryPassword;
    delete resp.__v;

    res.status(201).json({ success: true, message: "Employee created successfully", data: resp });
  } catch (error) {
    console.error("Create employee error:", error);
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ success: false, message: "Validation error", errors });
    }
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(400).json({ success: false, message: `${field} already exists.` });
    }
    res.status(500).json({ success: false, message: "Error creating employee" });
  }
});

// ─── UPDATE employee ──────────────────────────────────────────────────────────
router.put("/:id", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const updateData = req.body;

    const canUpdate = user.role === "hr_manager" || user.id === id;
    if (!canUpdate) {
      return res.status(403).json({ success: false, message: "Permission denied" });
    }

    // Strip base64 blobs (should have been uploaded to Cloudinary before hitting this endpoint)
    if (updateData.profilePhoto && typeof updateData.profilePhoto === "string" && updateData.profilePhoto.startsWith("data:image")) {
      delete updateData.profilePhoto;
    }
    if (updateData.documents) {
      ["aadharFile", "panFile", "resumeFile", "offerLetterFile", "appointmentLetterFile"].forEach((f) => {
        if (updateData.documents[f] && typeof updateData.documents[f] === "string" && updateData.documents[f].startsWith("data:image")) {
          delete updateData.documents[f];
        }
      });
      if (updateData.documents.additionalDocuments) {
        updateData.documents.additionalDocuments = updateData.documents.additionalDocuments.filter(
          (doc) => !(doc.url && typeof doc.url === "string" && doc.url.startsWith("data:image"))
        );
      }
    }

    // Restricted fields
    ["password", "temporaryPassword", "createdBy", "createdAt"].forEach((f) => delete updateData[f]);

    // Sanitize empty-string ObjectId fields to prevent BSONError cast failures
    if (updateData.departmentId === "" || updateData.departmentId === null) {
      delete updateData.departmentId;
    }
    if (updateData.primaryManager && !updateData.primaryManager.managerId) {
      delete updateData.primaryManager;
    }
    if (updateData.secondaryManager && !updateData.secondaryManager.managerId) {
      delete updateData.secondaryManager;
    }

    // Recalculate all salary fields from gross using current config rates
    if (updateData.salary) {
      const cfg = await SalaryConfig.getSingleton();
      updateData.salary = recalculateSalary(updateData.salary, cfg.toObject());
    }

    const updated = await Employee.findByIdAndUpdate(id, updateData, {
      new: true, runValidators: false,
    }).select("-password -temporaryPassword -__v");

    if (!updated) return res.status(404).json({ success: false, message: "Employee not found" });

    res.status(200).json({ success: true, message: "Employee updated successfully", data: updated });
  } catch (error) {
    console.error("Update employee error:", error);
    if (error.code === 11000) return res.status(400).json({ success: false, message: "Duplicate value error" });
    if (error.name === "CastError") return res.status(400).json({ success: false, message: "Invalid employee ID" });
    res.status(500).json({ success: false, message: "Error updating employee" });
  }
});

// ─── UPDATE DOCUMENTS ONLY ────────────────────────────────────────────────────
router.patch("/:id/documents", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const { documents } = req.body;

    if (user.role !== "hr_manager" && user.id !== id) {
      return res.status(403).json({ success: false, message: "Permission denied" });
    }

    const clean = { ...documents };
    ["aadharFile", "panFile", "resumeFile"].forEach((f) => {
      if (clean[f] && typeof clean[f] === "string" && clean[f].startsWith("data:image")) delete clean[f];
    });
    if (clean.additionalDocuments) {
      clean.additionalDocuments = clean.additionalDocuments.filter(
        (d) => !(d.url && typeof d.url === "string" && d.url.startsWith("data:image"))
      );
    }

    const updated = await Employee.findByIdAndUpdate(
      id, { $set: { documents: clean } }, { new: true, runValidators: false }
    ).select("documents firstName lastName biometricId");

    if (!updated) return res.status(404).json({ success: false, message: "Employee not found" });

    res.status(200).json({ success: true, message: "Documents updated successfully", data: updated.documents });
  } catch (error) {
    console.error("Update documents error:", error);
    res.status(500).json({ success: false, message: "Error updating documents" });
  }
});

// ─── UPDATE PROFILE PHOTO ONLY ────────────────────────────────────────────────
router.patch("/:id/profile-photo", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const { profilePhoto } = req.body;

    if (user.role !== "hr_manager" && user.id !== id) {
      return res.status(403).json({ success: false, message: "Permission denied" });
    }

    if (!profilePhoto?.url || !profilePhoto?.publicId) {
      return res.status(400).json({ success: false, message: "Valid profilePhoto with url and publicId required" });
    }

    if (typeof profilePhoto.url === "string" && profilePhoto.url.startsWith("data:image")) {
      return res.status(400).json({ success: false, message: "Upload to Cloudinary first" });
    }

    const updated = await Employee.findByIdAndUpdate(
      id, { $set: { profilePhoto } }, { new: true, runValidators: false }
    ).select("profilePhoto firstName lastName biometricId");

    if (!updated) return res.status(404).json({ success: false, message: "Employee not found" });

    res.status(200).json({ success: true, message: "Profile photo updated successfully", data: updated.profilePhoto });
  } catch (error) {
    console.error("Update profile photo error:", error);
    res.status(500).json({ success: false, message: "Error updating profile photo" });
  }
});

// ─── GET ALL employees (paginated, filterable) ─────────────────────────────────
router.get("/all", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { page = 1, limit = 10, department, status, search } = req.query;

    let filter = {};
    if (department && department !== "all") filter.department = department;
    if (status && status !== "all") filter.status = status;
    if (search) {
      filter.$or = [
        { firstName: { $regex: search, $options: "i" } },
        { lastName: { $regex: search, $options: "i" } },
        { middleName: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { biometricId: { $regex: search, $options: "i" } },
        { identityId: { $regex: search, $options: "i" } },
        { jobTitle: { $regex: search, $options: "i" } },
        { designation: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [employees, total, deptStats] = await Promise.all([
      Employee.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .select("-password -temporaryPassword -__v")
        .lean(),
      Employee.countDocuments(filter),
      Employee.aggregate([
        { $group: { _id: "$department", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
    ]);

    const totalPages = Math.ceil(total / parseInt(limit));

    res.status(200).json({
      success: true,
      data: {
        employees,
        pagination: {
          currentPage: parseInt(page),
          totalPages,
          totalEmployees: total,
          hasNextPage: parseInt(page) < totalPages,
          hasPrevPage: parseInt(page) > 1,
        },
        stats: { total, departmentStats: deptStats },
      },
    });
  } catch (error) {
    console.error("Get employees error:", error);
    res.status(500).json({ success: false, message: "Error fetching employees" });
  }
});

// ─── GET single employee ──────────────────────────────────────────────────────
router.get("/:id", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const employee = await Employee.findById(req.params.id)
      .select("-password -temporaryPassword -__v")
      .lean();
    if (!employee) return res.status(404).json({ success: false, message: "Employee not found" });
    res.status(200).json({ success: true, data: employee });
  } catch (error) {
    console.error("Get employee error:", error);
    if (error.name === "CastError") return res.status(400).json({ success: false, message: "Invalid employee ID" });
    res.status(500).json({ success: false, message: "Error fetching employee" });
  }
});

// ─── GET employee DETAILS (full formatted) ────────────────────────────────────
router.get("/:id/details", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { id } = req.params;

    const employee = await Employee.findById(id)
      .select("-password -temporaryPassword -__v")
      .populate("departmentId", "name designations managers")
      .populate("primaryManager.managerId", "firstName lastName biometricId department jobTitle")
      .populate("secondaryManager.managerId", "firstName lastName biometricId department jobTitle")
      .populate("createdBy", "name email")
      .lean();

    if (!employee) return res.status(404).json({ success: false, message: "Employee not found" });

    const [teamMembers, managerHierarchy, recentActivities] = await Promise.all([
      Employee.find({
        $or: [
          { "primaryManager.managerId": id },
          { "secondaryManager.managerId": id },
        ],
      })
        .select("firstName lastName biometricId department jobTitle status")
        .limit(10)
        .lean(),
      getManagerHierarchy(id),
      getRecentActivities(id),
    ]);

    const fullName = [employee.firstName, employee.middleName, employee.lastName].filter(Boolean).join(" ").trim();

    const formatted = {
      basicInfo: {
        id: employee._id,
        biometricId: employee.biometricId,
        identityId: employee.identityId,
        title: employee.title || "",
        firstName: employee.firstName,
        middleName: employee.middleName || "",
        lastName: employee.lastName,
        fullName,
        nickName: employee.nickName || "",
        email: employee.email,
        personalEmail: employee.personalEmail || "",
        phone: employee.phone,
        alternatePhone: employee.alternatePhone || "Not Provided",
        extension: employee.extension || "",
        dateOfBirth: employee.dateOfBirth ? new Date(employee.dateOfBirth).toLocaleDateString("en-IN") : "Not Provided",
        age: employee.dateOfBirth ? calculateAge(employee.dateOfBirth) : null,
        gender: employee.gender ? capitalize(employee.gender) : "Not Provided",
        bloodGroup: employee.bloodGroup || "Not Provided",
        maritalStatus: employee.maritalStatus ? capitalize(employee.maritalStatus) : "Not Provided",
        marriageDate: employee.marriageDate ? new Date(employee.marriageDate).toLocaleDateString("en-IN") : null,
        spouseName: employee.spouseName || null,
        spouseDOB: employee.spouseDOB ? new Date(employee.spouseDOB).toLocaleDateString("en-IN") : null,
        nationality: employee.nationality || "Not Provided",
        religion: employee.religion || "Not Provided",
        placeOfBirth: employee.placeOfBirth || "Not Provided",
        countryOfOrigin: employee.countryOfOrigin || "Not Provided",
        residentialStatus: employee.residentialStatus || "Not Provided",
        fatherName: [employee.fatherFirstName, employee.fatherMiddleName, employee.fatherLastName].filter(Boolean).join(" ") || "Not Provided",
        fatherDateOfBirth: employee.fatherDateOfBirth ? new Date(employee.fatherDateOfBirth).toLocaleDateString("en-IN") : null,
        motherName: [employee.motherFirstName, employee.motherMiddleName, employee.motherLastName].filter(Boolean).join(" ") || "Not Provided",
        isDirector: employee.isDirector ? "Yes" : "No",
        isInternational: employee.isInternational ? "Yes" : "No",
        isPhysicallyChallenged: employee.isPhysicallyChallenged ? "Yes" : "No",
        profilePhoto: employee.profilePhoto,
        customFields: employee.personalCustomFields || [],
      },
      workInfo: {
        department: employee.department,
        departmentId: employee.departmentId,
        designation: employee.designation || employee.jobPosition,
        jobTitle: employee.jobTitle,
        biometricId: employee.biometricId,
        identityId: employee.identityId,
        needsToOperate: employee.needsToOperate || false,
        dateOfJoining: employee.dateOfJoining ? new Date(employee.dateOfJoining).toLocaleDateString("en-IN") : "Not Provided",
        confirmationDate: employee.confirmationDate ? new Date(employee.confirmationDate).toLocaleDateString("en-IN") : null,
        probationPeriod: employee.probationPeriod ? `${employee.probationPeriod} months` : null,
        tenure: employee.dateOfJoining ? calculateTenure(employee.dateOfJoining) : null,
        employmentType: formatEmploymentType(employee.employmentType),
        workLocation: employee.workLocation || "GRAV Clothing",
        shift: employee.shift || "Not Assigned",
        status: employee.status ? capitalize(employee.status) : "Active",
        isActive: employee.isActive ? "Yes" : "No",
        customFields: employee.workCustomFields || [],
      },
      managers: {
        primary: employee.primaryManager
          ? {
            managerId: employee.primaryManager.managerId?._id,
            name: employee.primaryManager.managerName ||
              [employee.primaryManager.managerId?.firstName, employee.primaryManager.managerId?.lastName].filter(Boolean).join(" "),
            employeeId: employee.primaryManager.managerId?.biometricId,
            department: employee.primaryManager.managerId?.department,
            jobTitle: employee.primaryManager.managerId?.jobTitle,
          }
          : null,
        secondary: employee.secondaryManager
          ? {
            managerId: employee.secondaryManager.managerId?._id,
            name: employee.secondaryManager.managerName ||
              [employee.secondaryManager.managerId?.firstName, employee.secondaryManager.managerId?.lastName].filter(Boolean).join(" "),
            employeeId: employee.secondaryManager.managerId?.biometricId,
            department: employee.secondaryManager.managerId?.department,
            jobTitle: employee.secondaryManager.managerId?.jobTitle,
          }
          : null,
      },
      salaryInfo: {
        gross: employee.salary?.gross ? `₹${employee.salary.gross.toLocaleString("en-IN")}` : "Not Provided",
        // Legacy fields
        basic: employee.salary?.basic ? `₹${employee.salary.basic.toLocaleString("en-IN")}` : null,
        netSalary: employee.salary?.netSalary ? `₹${employee.salary.netSalary.toLocaleString("en-IN")}` : null,
        customFields: employee.salaryCustomFields || [],
      },
      bankDetails: {
        bankName: employee.bankDetails?.bankName || "Not Provided",
        accountNumber: employee.bankDetails?.accountNumber ? `XXXX${employee.bankDetails.accountNumber.slice(-4)}` : "Not Provided",
        ifscCode: employee.bankDetails?.ifscCode || "Not Provided",
        accountType: employee.bankDetails?.accountType ? capitalize(employee.bankDetails.accountType) : "Not Provided",
        branchName: employee.bankDetails?.branchName || "Not Provided",
      },
      documents: {
        aadharNumber: employee.documents?.aadharNumber ? maskId(employee.documents.aadharNumber) : "Not Provided",
        panNumber: employee.documents?.panNumber || "Not Provided",
        uanNumber: employee.documents?.uanNumber || "Not Provided",
        passportNumber: employee.documents?.passportNumber || "Not Provided",
        voterIdNumber: employee.documents?.voterIdNumber || "Not Provided",
        drivingLicenseNumber: employee.documents?.drivingLicenseNumber || "Not Provided",
        esicNumber: employee.documents?.esicNumber || "Not Provided",
        pfNumber: employee.documents?.pfNumber || "Not Provided",
        aadharFile: employee.documents?.aadharFile,
        panFile: employee.documents?.panFile,
        resumeFile: employee.documents?.resumeFile,
        offerLetterFile: employee.documents?.offerLetterFile,
        appointmentLetterFile: employee.documents?.appointmentLetterFile,
        additionalDocuments: employee.documents?.additionalDocuments || [],
        customFields: employee.documentCustomFields || [],
      },
      address: {
        current: {
          street: employee.address?.current?.street || "Not Provided",
          city: employee.address?.current?.city || "Not Provided",
          state: employee.address?.current?.state || "Not Provided",
          pincode: employee.address?.current?.pincode || "Not Provided",
          country: employee.address?.current?.country || "India",
          ownershipType: employee.address?.current?.ownershipType || "Not Provided",
        },
        permanent: {
          street: employee.address?.permanent?.street || "Same as Current",
          city: employee.address?.permanent?.city || "Same as Current",
          state: employee.address?.permanent?.state || "Same as Current",
          pincode: employee.address?.permanent?.pincode || "Same as Current",
          country: employee.address?.permanent?.country || "India",
          ownershipType: employee.address?.permanent?.ownershipType || "Not Provided",
        },
        customFields: employee.addressCustomFields || [],
      },
      systemInfo: {
        createdBy: employee.createdBy?.name || "HR System",
        createdAt: employee.createdAt ? new Date(employee.createdAt).toLocaleDateString("en-IN") : "N/A",
        updatedAt: employee.updatedAt ? new Date(employee.updatedAt).toLocaleDateString("en-IN") : "N/A",
      },
      relatedData: {
        teamMembers: teamMembers.map((m) => ({
          id: m._id,
          name: [m.firstName, m.lastName].filter(Boolean).join(" "),
          employeeId: m.biometricId,
          department: m.department,
          jobTitle: m.jobTitle,
          status: m.status,
        })),
        managerHierarchy,
        recentActivities,
      },
    };

    res.status(200).json({ success: true, data: formatted });
  } catch (error) {
    console.error("Get employee details error:", error);
    if (error.name === "CastError") return res.status(400).json({ success: false, message: "Invalid employee ID" });
    res.status(500).json({ success: false, message: "Error fetching employee details" });
  }
});

// ─── GET employees by dept + designation (manager picker) ─────────────────────
router.get("/department/employees", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { departmentId, designation } = req.query;
    if (!departmentId || !designation) {
      return res.status(400).json({ success: false, message: "departmentId and designation required" });
    }

    const employees = await Employee.find({
      departmentId, designation, status: "active", isActive: true,
    })
      .select("firstName middleName lastName biometricId identityId email phone department designation jobTitle profilePhoto")
      .sort({ firstName: 1 })
      .lean();

    const formatted = employees.map((emp) => ({
      id: emp._id,
      employeeId: emp.biometricId || emp.identityId,
      biometricId: emp.biometricId,
      name: [emp.firstName, emp.lastName].filter(Boolean).join(" ").trim(),
      fullName: [emp.firstName, emp.middleName, emp.lastName].filter(Boolean).join(" ").trim(),
      email: emp.email,
      phone: emp.phone,
      department: emp.department,
      designation: emp.designation,
      jobTitle: emp.jobTitle,
      profilePhoto: emp.profilePhoto,
    }));

    res.status(200).json({ success: true, data: formatted, count: formatted.length });
  } catch (error) {
    console.error("Get dept employees error:", error);
    res.status(500).json({ success: false, message: "Error fetching employees" });
  }
});

// ─── SOFT DELETE ──────────────────────────────────────────────────────────────
router.delete("/:id", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    if (user.role !== "hr_manager") {
      return res.status(403).json({ success: false, message: "Only HR managers can delete employees" });
    }

    const employee = await Employee.findById(req.params.id);
    if (!employee) return res.status(404).json({ success: false, message: "Employee not found" });

    employee.isActive = false;
    employee.status = "inactive";
    await employee.save();

    res.status(200).json({ success: true, message: "Employee deactivated successfully" });
  } catch (error) {
    console.error("Delete employee error:", error);
    if (error.name === "CastError") return res.status(400).json({ success: false, message: "Invalid employee ID" });
    res.status(500).json({ success: false, message: "Error deleting employee" });
  }
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const capitalize = (str) =>
  str ? str.charAt(0).toUpperCase() + str.slice(1) : str;

const maskId = (id) => {
  if (!id || id.length < 4) return id;
  return "XXXX XXXX " + id.slice(-4);
};

const calculateAge = (dob) => {
  const today = new Date();
  const birth = new Date(dob);
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
};

const calculateTenure = (dateOfJoining) => {
  const today = new Date();
  const joining = new Date(dateOfJoining);
  let years = today.getFullYear() - joining.getFullYear();
  let months = today.getMonth() - joining.getMonth();
  if (months < 0) { years--; months += 12; }
  return { years, months };
};

const formatEmploymentType = (type) => {
  const map = {
    full_time: "Full Time",
    part_time: "Part Time",
    contract: "Contract",
    intern: "Intern",
  };
  return map[type] || type || "Not Provided";
};

const getManagerHierarchy = async (employeeId) => {
  try {
    const hierarchy = [];
    let current = await Employee.findById(employeeId)
      .select("primaryManager firstName lastName biometricId department")
      .populate("primaryManager.managerId", "firstName lastName biometricId department")
      .lean();
    const visited = new Set();
    while (current && !visited.has(current._id.toString())) {
      visited.add(current._id.toString());
      hierarchy.push({
        id: current._id,
        name: [current.firstName, current.lastName].filter(Boolean).join(" ").trim(),
        employeeId: current.biometricId,
        department: current.department,
        level: hierarchy.length + 1,
      });
      if (current.primaryManager?.managerId) {
        current = await Employee.findById(current.primaryManager.managerId._id)
          .select("primaryManager firstName lastName biometricId department")
          .populate("primaryManager.managerId", "firstName lastName biometricId department")
          .lean();
      } else break;
    }
    return hierarchy.reverse();
  } catch (e) {
    console.error("Manager hierarchy error:", e);
    return [];
  }
};

const getRecentActivities = async (employeeId) => {
  // Placeholder – integrate with an audit log collection if available
  return [
    { id: 1, activity: "Profile updated", date: new Date().toLocaleDateString("en-IN"), type: "update" },
  ];
};

module.exports = router;