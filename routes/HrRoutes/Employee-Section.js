const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const Employee = require("../../models/Employee");
const EmployeeAuthMiddlewear = require("../../Middlewear/EmployeeAuthMiddlewear");
const emailService = require("../../services/emailService");

require("dotenv").config();

// CREATE new employee - No required field validation, accept whatever is provided
router.post("/", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    const employeeData = req.body;

    // Generate a temporary password for the employee
    const temporaryPassword = Math.random().toString(36).slice(-8);

    // Create employee with whatever data was provided
    const newEmployee = new Employee({
      ...employeeData,
      password: temporaryPassword,
      temporaryPassword: temporaryPassword,
      createdBy: user.id,
      createdAt: new Date(),
    });

    await newEmployee.save();

    // Send welcome email asynchronously (only if email service is enabled)
    if (process.env.ENABLE_EMAILS === "true" && employeeData.email) {
      try {
        const emailData = {
          name: `${employeeData.firstName || ""} ${employeeData.lastName || ""}`.trim() || "Employee",
          email: employeeData.email,
          employeeId: employeeData.biometricId,
          department: employeeData.department,
          designation: employeeData.designation || employeeData.jobPosition,
          temporaryPassword: temporaryPassword,
        };

        emailService
          .sendWelcomeEmail(emailData)
          .then(() => {
            console.log(`✅ Welcome email sent to ${employeeData.email}`);
            Employee.findByIdAndUpdate(newEmployee._id, {
              $set: { welcomeEmailSent: true, emailSentAt: new Date(), temporaryPassword: null },
            }).catch((err) => console.error("Error updating email status:", err));
          })
          .catch((emailError) => {
            console.error(`❌ Failed to send email to ${employeeData.email}:`, emailError.message);
            Employee.findByIdAndUpdate(newEmployee._id, {
              $set: { welcomeEmailSent: false, emailError: emailError.message },
            }).catch((err) => console.error("Error updating email error status:", err));
          });
      } catch (emailError) {
        console.error("Error in email sending process:", emailError);
      }
    }

    const employeeResponse = newEmployee.toObject();
    delete employeeResponse.password;
    delete employeeResponse.temporaryPassword;
    delete employeeResponse.__v;

    res.status(201).json({
      success: true,
      message: "Employee created successfully",
      data: employeeResponse,
    });
  } catch (error) {
    console.error("Create employee error:", error);

    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((err) => err.message);
      return res.status(400).json({
        success: false,
        message: "Validation error",
        errors,
      });
    }

    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(400).json({
        success: false,
        message: `${field} already exists. Please use a different value.`,
      });
    }

    res.status(500).json({
      success: false,
      message: "Error creating employee",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// UPDATE employee
router.put("/:id", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const updateData = req.body;

    const canUpdate = user.role === "hr_manager" || user.id === id;
    if (!canUpdate) {
      return res.status(403).json({
        success: false,
        message: "You don't have permission to update this employee",
      });
    }

    // Clean up base64 profile photo
    if (
      updateData.profilePhoto &&
      typeof updateData.profilePhoto === "string" &&
      updateData.profilePhoto.startsWith("data:image")
    ) {
      delete updateData.profilePhoto;
    }

    // Clean up base64 document files
    if (updateData.documents) {
      ["aadharFile", "panFile", "resumeFile"].forEach((field) => {
        if (
          updateData.documents[field] &&
          typeof updateData.documents[field] === "string" &&
          updateData.documents[field].startsWith("data:image")
        ) {
          delete updateData.documents[field];
        }
      });

      if (updateData.documents.additionalDocuments) {
        updateData.documents.additionalDocuments = updateData.documents.additionalDocuments.filter(
          (doc) => !(doc.url && typeof doc.url === "string" && doc.url.startsWith("data:image"))
        );
      }
    }

    // Fields that should not be updated via this endpoint
    const restrictedFields = ["email", "password", "temporaryPassword", "createdBy", "createdAt"];
    restrictedFields.forEach((field) => delete updateData[field]);

    const updatedEmployee = await Employee.findByIdAndUpdate(id, updateData, {
      new: true,
      runValidators: false, // Don't run validators on update to allow partial data
    }).select("-password -temporaryPassword -__v");

    if (!updatedEmployee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Employee updated successfully",
      data: updatedEmployee,
    });
  } catch (error) {
    console.error("Update employee error:", error);

    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((err) => err.message);
      return res.status(400).json({
        success: false,
        message: "Validation error",
        errors,
      });
    }

    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "Duplicate key error - a value you entered already exists",
      });
    }

    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid employee ID",
      });
    }

    res.status(500).json({
      success: false,
      message: "Error updating employee",
    });
  }
});

// UPDATE EMPLOYEE DOCUMENTS ONLY
router.patch("/:id/documents", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const { documents } = req.body;

    const canUpdate = user.role === "hr_manager" || user.id === id;
    if (!canUpdate) {
      return res.status(403).json({ success: false, message: "You don't have permission to update documents" });
    }

    const cleanDocuments = { ...documents };
    ["aadharFile", "panFile", "resumeFile"].forEach((field) => {
      if (cleanDocuments[field] && typeof cleanDocuments[field] === "string" && cleanDocuments[field].startsWith("data:image")) {
        delete cleanDocuments[field];
      }
    });
    if (cleanDocuments.additionalDocuments) {
      cleanDocuments.additionalDocuments = cleanDocuments.additionalDocuments.filter(
        (doc) => !(doc.url && typeof doc.url === "string" && doc.url.startsWith("data:image"))
      );
    }

    const updatedEmployee = await Employee.findByIdAndUpdate(
      id,
      { $set: { documents: cleanDocuments } },
      { new: true, runValidators: false }
    ).select("documents firstName lastName employeeId");

    if (!updatedEmployee) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }

    res.status(200).json({ success: true, message: "Documents updated successfully", data: updatedEmployee.documents });
  } catch (error) {
    console.error("Update documents error:", error);
    res.status(500).json({ success: false, message: "Error updating documents" });
  }
});

// UPDATE PROFILE PHOTO ONLY
router.patch("/:id/profile-photo", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const { profilePhoto } = req.body;

    const canUpdate = user.role === "hr_manager" || user.id === id;
    if (!canUpdate) {
      return res.status(403).json({ success: false, message: "You don't have permission to update profile photo" });
    }

    if (!profilePhoto || !profilePhoto.url || !profilePhoto.publicId) {
      return res.status(400).json({ success: false, message: "Valid profile photo with URL and publicId is required" });
    }

    if (typeof profilePhoto.url === "string" && profilePhoto.url.startsWith("data:image")) {
      return res.status(400).json({ success: false, message: "Profile photo must be uploaded to Cloudinary first" });
    }

    const updatedEmployee = await Employee.findByIdAndUpdate(
      id,
      { $set: { profilePhoto } },
      { new: true, runValidators: false }
    ).select("profilePhoto firstName lastName employeeId");

    if (!updatedEmployee) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }

    res.status(200).json({ success: true, message: "Profile photo updated successfully", data: updatedEmployee.profilePhoto });
  } catch (error) {
    console.error("Update profile photo error:", error);
    res.status(500).json({ success: false, message: "Error updating profile photo" });
  }
});

// Get all employees (with pagination and filters)
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
        { email: { $regex: search, $options: "i" } },
        { employeeId: { $regex: search, $options: "i" } },
        { jobTitle: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (page - 1) * limit;
    const employees = await Employee.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .select("-password -temporaryPassword -__v")
      .lean();

    const total = await Employee.countDocuments(filter);
    const totalPages = Math.ceil(total / limit);

    const departmentStats = await Employee.aggregate([
      { $group: { _id: "$department", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    res.status(200).json({
      success: true,
      data: {
        employees,
        pagination: {
          currentPage: parseInt(page),
          totalPages,
          totalEmployees: total,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
        stats: { total, departmentStats },
      },
    });
  } catch (error) {
    console.error("Get employees error:", error);
    res.status(500).json({ success: false, message: "Error fetching employees" });
  }
});

// Get single employee
router.get("/:id", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { id } = req.params;
    const employee = await Employee.findById(id).select("-password -temporaryPassword -__v").lean();
    if (!employee) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }
    res.status(200).json({ success: true, data: employee });
  } catch (error) {
    console.error("Get employee error:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ success: false, message: "Invalid employee ID" });
    }
    res.status(500).json({ success: false, message: "Error fetching employee" });
  }
});

// Get single employee with detailed information
router.get("/:id/details", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { id } = req.params;

    const employee = await Employee.findById(id)
      .select("-password -temporaryPassword -__v")
      .populate("departmentId", "name designations managers")
      .populate("primaryManager.managerId", "firstName lastName employeeId department jobTitle")
      .populate("secondaryManager.managerId", "firstName lastName employeeId department jobTitle")
      .populate("createdBy", "name email")
      .lean();

    if (!employee) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }

    const [teamMembers, managerHierarchy, recentActivities] = await Promise.all([
      Employee.find({
        $or: [{ "primaryManager.managerId": id }, { "secondaryManager.managerId": id }],
      })
        .select("firstName lastName employeeId department jobTitle status")
        .limit(5)
        .lean(),
      getManagerHierarchy(id),
      getRecentActivities(id),
    ]);

    const formattedEmployee = {
      basicInfo: {
        id: employee._id,
        biometricId: employee.biometricId,
        identityId: employee.identityId,
        firstName: employee.firstName,
        lastName: employee.lastName,
        fullName: `${employee.firstName || ""} ${employee.lastName || ""}`.trim(),
        email: employee.email,
        phone: employee.phone,
        alternatePhone: employee.alternatePhone || "Not Provided",
        dateOfBirth: employee.dateOfBirth ? new Date(employee.dateOfBirth).toLocaleDateString() : "Not Provided",
        age: employee.dateOfBirth ? calculateAge(employee.dateOfBirth) : null,
        gender: employee.gender ? employee.gender.charAt(0).toUpperCase() + employee.gender.slice(1) : "Not Provided",
        maritalStatus: employee.maritalStatus ? employee.maritalStatus.charAt(0).toUpperCase() + employee.maritalStatus.slice(1) : "Not Provided",
        profilePhoto: employee.profilePhoto,
      },
      workInfo: {
        department: employee.department,
        departmentId: employee.departmentId,
        designation: employee.designation || employee.jobPosition,
        jobTitle: employee.jobTitle,
        biometricId: employee.biometricId,
        identityId: employee.identityId,
        needsToOperate: employee.needsToOperate || false,
        dateOfJoining: employee.dateOfJoining ? new Date(employee.dateOfJoining).toLocaleDateString() : "Not Provided",
        tenure: employee.dateOfJoining ? calculateTenure(employee.dateOfJoining) : null,
        employmentType: formatEmploymentType(employee.employmentType),
        workLocation: employee.workLocation || "GRAV Clothing",
        status: employee.status ? employee.status.charAt(0).toUpperCase() + employee.status.slice(1) : "Active",
        isActive: employee.isActive ? "Yes" : "No",
      },
      managers: {
        primary: employee.primaryManager
          ? {
              managerId: employee.primaryManager.managerId?._id,
              name: employee.primaryManager.managerName || (employee.primaryManager.managerId ? `${employee.primaryManager.managerId.firstName} ${employee.primaryManager.managerId.lastName}` : ""),
              employeeId: employee.primaryManager.managerId?.employeeId,
              department: employee.primaryManager.managerId?.department,
              jobTitle: employee.primaryManager.managerId?.jobTitle,
            }
          : null,
        secondary: employee.secondaryManager
          ? {
              managerId: employee.secondaryManager.managerId?._id,
              name: employee.secondaryManager.managerName || (employee.secondaryManager.managerId ? `${employee.secondaryManager.managerId.firstName} ${employee.secondaryManager.managerId.lastName}` : ""),
              employeeId: employee.secondaryManager.managerId?.employeeId,
              department: employee.secondaryManager.managerId?.department,
              jobTitle: employee.secondaryManager.managerId?.jobTitle,
            }
          : null,
      },
      salaryInfo: {
        basic: employee.salary?.basic ? `₹${employee.salary.basic.toLocaleString("en-IN")}` : "Not Provided",
        allowances: employee.salary?.allowances ? `₹${employee.salary.allowances.toLocaleString("en-IN")}` : "₹0",
        deductions: employee.salary?.deductions ? `₹${employee.salary.deductions.toLocaleString("en-IN")}` : "₹0",
        netSalary: employee.salary?.netSalary ? `₹${employee.salary.netSalary.toLocaleString("en-IN")}` : "Not Provided",
      },
      bankDetails: {
        bankName: employee.bankDetails?.bankName || "Not Provided",
        accountNumber: employee.bankDetails?.accountNumber ? `XXXX${employee.bankDetails.accountNumber.slice(-4)}` : "Not Provided",
        ifscCode: employee.bankDetails?.ifscCode || "Not Provided",
      },
      documents: {
        aadharNumber: employee.documents?.aadharNumber || "Not Provided",
        panNumber: employee.documents?.panNumber || "Not Provided",
        uanNumber: employee.documents?.uanNumber || "Not Provided",
        aadharFile: employee.documents?.aadharFile,
        panFile: employee.documents?.panFile,
        resumeFile: employee.documents?.resumeFile,
        additionalDocuments: employee.documents?.additionalDocuments || [],
      },
      address: {
        current: {
          street: employee.address?.current?.street || "Not Provided",
          city: employee.address?.current?.city || "Not Provided",
          state: employee.address?.current?.state || "Not Provided",
          pincode: employee.address?.current?.pincode || "Not Provided",
          country: employee.address?.current?.country || "India",
        },
        permanent: {
          street: employee.address?.permanent?.street || "Same as Current",
          city: employee.address?.permanent?.city || "Same as Current",
          state: employee.address?.permanent?.state || "Same as Current",
          pincode: employee.address?.permanent?.pincode || "Same as Current",
          country: employee.address?.permanent?.country || "India",
        },
      },
      systemInfo: {
        createdBy: employee.createdBy?.name || "HR System",
        createdAt: employee.createdAt ? new Date(employee.createdAt).toLocaleDateString() : "Not Available",
        updatedAt: employee.updatedAt ? new Date(employee.updatedAt).toLocaleDateString() : "Not Available",
      },
      relatedData: {
        teamMembers: teamMembers.map((member) => ({
          id: member._id,
          name: `${member.firstName} ${member.lastName}`,
          employeeId: member.employeeId,
          department: member.department,
          jobTitle: member.jobTitle,
          status: member.status,
        })),
        managerHierarchy,
        recentActivities,
      },
    };

    res.status(200).json({ success: true, data: formattedEmployee });
  } catch (error) {
    console.error("Get employee details error:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ success: false, message: "Invalid employee ID" });
    }
    res.status(500).json({ success: false, message: "Error fetching employee details" });
  }
});

// Get employees by department and designation (for manager selection)
router.get("/department/employees", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { departmentId, designation } = req.query;

    if (!departmentId || !designation) {
      return res.status(400).json({ success: false, message: "Department ID and designation are required" });
    }

    const employees = await Employee.find({
      departmentId: departmentId,
      designation: designation,
      status: "active",
      isActive: true,
    })
      .select("firstName lastName employeeId email phone department designation jobTitle profilePhoto")
      .sort({ firstName: 1 })
      .lean();

    const formattedEmployees = employees.map((emp) => ({
      id: emp._id,
      employeeId: emp.employeeId || emp.biometricId,
      name: `${emp.firstName || ""} ${emp.lastName || ""}`.trim(),
      fullName: `${emp.firstName || ""} ${emp.lastName || ""}`.trim(),
      email: emp.email,
      phone: emp.phone,
      department: emp.department,
      designation: emp.designation,
      jobTitle: emp.jobTitle,
      profilePhoto: emp.profilePhoto,
    }));

    res.status(200).json({ success: true, data: formattedEmployees, count: formattedEmployees.length });
  } catch (error) {
    console.error("Get department employees error:", error);
    res.status(500).json({ success: false, message: "Error fetching employees" });
  }
});

// Delete employee (soft delete)
router.delete("/:id", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;

    if (user.role !== "hr_manager") {
      return res.status(403).json({ success: false, message: "Only HR managers can delete employees" });
    }

    const employee = await Employee.findById(id);
    if (!employee) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }

    employee.isActive = false;
    employee.status = "inactive";
    await employee.save();

    res.status(200).json({ success: true, message: "Employee deactivated successfully" });
  } catch (error) {
    console.error("Delete employee error:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ success: false, message: "Invalid employee ID" });
    }
    res.status(500).json({ success: false, message: "Error deleting employee" });
  }
});

// Helper functions
const calculateAge = (dateOfBirth) => {
  const today = new Date();
  const birthDate = new Date(dateOfBirth);
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) age--;
  return age;
};

const calculateTenure = (dateOfJoining) => {
  const today = new Date();
  const joiningDate = new Date(dateOfJoining);
  let years = today.getFullYear() - joiningDate.getFullYear();
  let months = today.getMonth() - joiningDate.getMonth();
  if (months < 0) { years--; months += 12; }
  return { years, months };
};

const formatEmploymentType = (type) => {
  const types = { full_time: "Full Time", part_time: "Part Time", contract: "Contract", intern: "Intern" };
  return types[type] || type || "Not Provided";
};

const getManagerHierarchy = async (employeeId) => {
  try {
    const hierarchy = [];
    let currentEmployee = await Employee.findById(employeeId)
      .select("primaryManager secondaryManager firstName lastName employeeId department")
      .populate("primaryManager.managerId", "firstName lastName employeeId department")
      .lean();
    let visited = new Set();
    while (currentEmployee && !visited.has(currentEmployee._id.toString())) {
      visited.add(currentEmployee._id.toString());
      hierarchy.push({
        id: currentEmployee._id,
        name: `${currentEmployee.firstName || ""} ${currentEmployee.lastName || ""}`.trim(),
        employeeId: currentEmployee.employeeId,
        department: currentEmployee.department,
        level: hierarchy.length + 1,
      });
      if (currentEmployee.primaryManager?.managerId) {
        currentEmployee = await Employee.findById(currentEmployee.primaryManager.managerId._id)
          .select("primaryManager secondaryManager firstName lastName employeeId department")
          .populate("primaryManager.managerId", "firstName lastName employeeId department")
          .lean();
      } else {
        break;
      }
    }
    return hierarchy.reverse();
  } catch (error) {
    console.error("Error fetching manager hierarchy:", error);
    return [];
  }
};

const getRecentActivities = async (employeeId) => {
  return [
    { id: 1, activity: "Profile updated", date: "2024-01-15", type: "update" },
    { id: 2, activity: "Login from new device", date: "2024-01-14", type: "security" },
    { id: 3, activity: "Salary credited", date: "2024-01-10", type: "salary" },
  ];
};

module.exports = router;