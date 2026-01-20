const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const Employee = require("../../models/Employee");
const EmployeeAuthMiddlewear = require("../../Middlewear/EmployeeAuthMiddlewear");
const emailService = require("../../services/emailService");

require("dotenv").config();

// CREATE new employee - UPDATED
router.post("/", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    const employeeData = req.body;

    // Add the new fields
    const newEmployee = new Employee({
      ...employeeData,
      departmentId: employeeData.departmentId,
      designation: employeeData.designation,
      primaryManager: employeeData.primaryManager,
      secondaryManager: employeeData.secondaryManager,
      createdBy: user.id,
    });

    await newEmployee.save();

    // Send welcome email asynchronously (don't await to keep API response fast)
    if (process.env.ENABLE_EMAILS === "true" && employeeData.email) {
      try {
        // Prepare employee data for email
        const emailData = {
          name:
            employeeData.name ||
            employeeData.firstName + " " + employeeData.lastName,
          email: employeeData.email,
          employeeId: employeeData.employeeId,
          department: employeeData.department,
          position: employeeData.position,
        };

        // Send email in background
        emailService
          .sendWelcomeEmail(emailData, employeeData.temporaryPassword)
          .then((result) => {
            console.log(
              `✅ Welcome email sent successfully to ${employeeData.email}`,
            );

            // Optional: Update employee record with email sent status
            Employee.findByIdAndUpdate(
              newEmployee._id,
              {
                $set: { welcomeEmailSent: true, emailSentAt: new Date() },
              },
              { new: true },
            ).catch((updateErr) => {
              console.error("Error updating email status:", updateErr);
            });
          })
          .catch((emailError) => {
            console.error(
              `❌ Failed to send email to ${employeeData.email}:`,
              emailError.message,
            );

            // Log the error but don't fail the employee creation
            Employee.findByIdAndUpdate(
              newEmployee._id,
              {
                $set: {
                  welcomeEmailSent: false,
                  emailError: emailError.message,
                },
              },
              { new: true },
            ).catch((updateErr) => {
              console.error("Error updating email error status:", updateErr);
            });
          });
      } catch (emailError) {
        console.error("Error in email sending process:", emailError);
        // Don't throw error - employee should still be created
      }
    }

    // Remove sensitive data from response
    const employeeResponse = newEmployee.toObject();
    delete employeeResponse.password;
    delete employeeResponse.temporaryPassword;

    res.status(201).json({
      success: true,
      message:
        "Employee created successfully. Welcome email has been dispatched.",
      data: employeeResponse,
      emailSent: process.env.ENABLE_EMAILS === "true",
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
        message: `${field} already exists`,
      });
    }

    res.status(500).json({
      success: false,
      message: "Error creating employee",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// Get all employees (with pagination and filters)
router.get("/all", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    const { page = 1, limit = 10, department, status, search } = req.query;

    // Build filter query
    let filter = {};

    if (department && department !== "all") {
      filter.department = department;
    }

    if (status && status !== "all") {
      filter.status = status;
    }

    if (search) {
      filter.$or = [
        { firstName: { $regex: search, $options: "i" } },
        { lastName: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { employeeId: { $regex: search, $options: "i" } },
        { jobTitle: { $regex: search, $options: "i" } },
      ];
    }

    // Calculate pagination
    const skip = (page - 1) * limit;

    // Get employees with pagination
    const employees = await Employee.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .select("-__v")
      .lean();

    // Get total count for pagination
    const total = await Employee.countDocuments(filter);
    const totalPages = Math.ceil(total / limit);

    // Get department statistics
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
        stats: {
          total,
          departmentStats,
        },
      },
    });
  } catch (error) {
    console.error("Get employees error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching employees",
    });
  }
});

router.get("/:id", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { id } = req.params;

    const employee = await Employee.findById(id).select("-__v").lean();

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found",
      });
    }

    // If employee has departmentId, fetch department details
    if (employee.departmentId) {
      try {
        const department = await Department.findById(employee.departmentId)
          .select("name designations")
          .lean();

        if (department) {
          employee.departmentDetails = department;
        }
      } catch (deptError) {
        console.error("Error fetching department details:", deptError);
      }
    }

    res.status(200).json({
      success: true,
      data: employee,
    });
  } catch (error) {
    console.error("Get employee error:", error);

    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid employee ID",
      });
    }

    res.status(500).json({
      success: false,
      message: "Error fetching employee",
    });
  }
});

// Update employee
router.put("/:id", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const updateData = req.body;

    // Check if user has HR role
    if (user.role !== "hr_manager") {
      return res.status(403).json({
        success: false,
        message: "Only HR managers can update employees",
      });
    }

    // Remove fields that shouldn't be updated
    delete updateData.employeeId;
    delete updateData.email;
    delete updateData.createdBy;
    delete updateData.createdAt;

    // Check if new email already exists (if email is being updated)
    if (updateData.email) {
      const existingEmail = await Employee.findOne({
        email: updateData.email.toLowerCase(),
        _id: { $ne: id },
      });
      if (existingEmail) {
        return res.status(400).json({
          success: false,
          message: "Email already exists",
        });
      }
    }

    const updatedEmployee = await Employee.findByIdAndUpdate(id, updateData, {
      new: true,
      runValidators: true,
    }).select("-__v");

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
        message: "Duplicate key error",
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

router.get("/:id", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { id } = req.params;

    const employee = await Employee.findById(id)
      .select("-__v -password -temporaryPassword")
      .lean();

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found",
      });
    }

    res.status(200).json({
      success: true,
      data: employee,
    });
  } catch (error) {
    console.error("Get employee error:", error);

    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid employee ID",
      });
    }

    res.status(500).json({
      success: false,
      message: "Error fetching employee",
    });
  }
});

// Get single employee with detailed information
router.get("/:id/details", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { id } = req.params;

    // Fetch employee with detailed information
    const employee = await Employee.findById(id)
      .select("-__v -password -temporaryPassword")
      .populate("departmentId", "name designations managers")
      .populate(
        "primaryManager.managerId",
        "firstName lastName employeeId department jobTitle",
      )
      .populate(
        "secondaryManager.managerId",
        "firstName lastName employeeId department jobTitle",
      )
      .populate("createdBy", "name email")
      .lean();

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found",
      });
    }

    // Fetch related data (managers, team members, etc.)
    const [teamMembers, managerHierarchy, recentActivities] = await Promise.all(
      [
        // Get team members reporting to this employee
        Employee.find({
          $or: [
            { "primaryManager.managerId": id },
            { "secondaryManager.managerId": id },
          ],
        })
          .select("firstName lastName employeeId department jobTitle status")
          .limit(5)
          .lean(),

        // Get manager hierarchy
        getManagerHierarchy(id),

        // Get recent activities (you can integrate with activity log system)
        getRecentActivities(id),
      ],
    );

    // Format the response
    const formattedEmployee = {
      // Basic Information
      basicInfo: {
        id: employee._id,
        employeeId: employee.employeeId,
        firstName: employee.firstName,
        lastName: employee.lastName,
        fullName: `${employee.firstName} ${employee.lastName}`,
        email: employee.email,
        phone: employee.phone,
        alternatePhone: employee.alternatePhone || "Not Provided",
        dateOfBirth: employee.dateOfBirth
          ? new Date(employee.dateOfBirth).toLocaleDateString()
          : "Not Provided",
        age: employee.dateOfBirth ? calculateAge(employee.dateOfBirth) : null,
        gender: employee.gender
          ? employee.gender.charAt(0).toUpperCase() + employee.gender.slice(1)
          : "Not Provided",
        maritalStatus: employee.maritalStatus
          ? employee.maritalStatus.charAt(0).toUpperCase() +
            employee.maritalStatus.slice(1)
          : "Not Provided",
      },

      // Work Information
      workInfo: {
        department: employee.department,
        departmentId: employee.departmentId,
        designation: employee.designation || employee.jobPosition,
        jobTitle: employee.jobTitle,
        employeeId: employee.employeeId,
        dateOfJoining: employee.dateOfJoining
          ? new Date(employee.dateOfJoining).toLocaleDateString()
          : "Not Provided",
        tenure: employee.dateOfJoining
          ? calculateTenure(employee.dateOfJoining)
          : null,
        employmentType: formatEmploymentType(employee.employmentType),
        workLocation: employee.workLocation || "GRAV Clothing",
        status: employee.status
          ? employee.status.charAt(0).toUpperCase() + employee.status.slice(1)
          : "Active",
        isActive: employee.isActive ? "Yes" : "No",
      },

      // Managers Information
      managers: {
        primary: employee.primaryManager
          ? {
              managerId: employee.primaryManager.managerId?._id,
              name:
                employee.primaryManager.managerName ||
                (employee.primaryManager.managerId
                  ? `${employee.primaryManager.managerId.firstName} ${employee.primaryManager.managerId.lastName}`
                  : employee.primaryManager.managerName),
              employeeId: employee.primaryManager.managerId?.employeeId,
              department: employee.primaryManager.managerId?.department,
              jobTitle: employee.primaryManager.managerId?.jobTitle,
            }
          : null,
        secondary: employee.secondaryManager
          ? {
              managerId: employee.secondaryManager.managerId?._id,
              name:
                employee.secondaryManager.managerName ||
                (employee.secondaryManager.managerId
                  ? `${employee.secondaryManager.managerId.firstName} ${employee.secondaryManager.managerId.lastName}`
                  : employee.secondaryManager.managerName),
              employeeId: employee.secondaryManager.managerId?.employeeId,
              department: employee.secondaryManager.managerId?.department,
              jobTitle: employee.secondaryManager.managerId?.jobTitle,
            }
          : null,
      },

      // Salary Information
      salaryInfo: {
        basic: employee.salary?.basic
          ? `₹${employee.salary.basic.toLocaleString("en-IN")}`
          : "Not Provided",
        allowances: employee.salary?.allowances
          ? `₹${employee.salary.allowances.toLocaleString("en-IN")}`
          : "₹0",
        deductions: employee.salary?.deductions
          ? `₹${employee.salary.deductions.toLocaleString("en-IN")}`
          : "₹0",
        netSalary: employee.salary?.netSalary
          ? `₹${employee.salary.netSalary.toLocaleString("en-IN")}`
          : "Not Provided",
        monthlyTakeHome: employee.salary?.netSalary
          ? `₹${employee.salary.netSalary.toLocaleString("en-IN")}`
          : "Not Provided",
      },

      // Bank Details
      bankDetails: {
        bankName: employee.bankDetails?.bankName || "Not Provided",
        accountNumber: employee.bankDetails?.accountNumber
          ? `XXXX${employee.bankDetails.accountNumber.slice(-4)}`
          : "Not Provided",
        ifscCode: employee.bankDetails?.ifscCode || "Not Provided",
      },

      // Documents
      documents: {
        aadharNumber: employee.documents?.aadharNumber || "Not Provided",
        panNumber: employee.documents?.panNumber || "Not Provided",
        uanNumber: employee.documents?.uanNumber || "Not Provided",
        aadharFile: employee.documents?.aadharFile,
        panFile: employee.documents?.panFile,
        resumeFile: employee.documents?.resumeFile,
      },

      // Address Information
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

      // System Information
      systemInfo: {
        createdBy: employee.createdBy?.name || "HR System",
        createdAt: employee.createdAt
          ? new Date(employee.createdAt).toLocaleDateString()
          : "Not Available",
        updatedAt: employee.updatedAt
          ? new Date(employee.updatedAt).toLocaleDateString()
          : "Not Available",
        lastLogin: "Today", // You can add login tracking later
      },

      // Related Data
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

    res.status(200).json({
      success: true,
      data: formattedEmployee,
    });
  } catch (error) {
    console.error("Get employee details error:", error);

    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid employee ID",
      });
    }

    res.status(500).json({
      success: false,
      message: "Error fetching employee details",
    });
  }
});

// Helper function to calculate age
const calculateAge = (dateOfBirth) => {
  const today = new Date();
  const birthDate = new Date(dateOfBirth);
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();

  if (
    monthDiff < 0 ||
    (monthDiff === 0 && today.getDate() < birthDate.getDate())
  ) {
    age--;
  }

  return age;
};

// Helper function to calculate tenure
const calculateTenure = (dateOfJoining) => {
  const today = new Date();
  const joiningDate = new Date(dateOfJoining);

  let years = today.getFullYear() - joiningDate.getFullYear();
  let months = today.getMonth() - joiningDate.getMonth();

  if (months < 0) {
    years--;
    months += 12;
  }

  return { years, months };
};

// Helper function to format employment type
const formatEmploymentType = (type) => {
  const types = {
    full_time: "Full Time",
    part_time: "Part Time",
    contract: "Contract",
    intern: "Intern",
  };
  return types[type] || type || "Not Provided";
};

// Helper function to get manager hierarchy
const getManagerHierarchy = async (employeeId) => {
  try {
    const hierarchy = [];
    let currentEmployee = await Employee.findById(employeeId)
      .select("primaryManager secondaryManager")
      .populate(
        "primaryManager.managerId",
        "firstName lastName employeeId department",
      )
      .populate(
        "secondaryManager.managerId",
        "firstName lastName employeeId department",
      )
      .lean();

    let visited = new Set();

    while (currentEmployee && !visited.has(currentEmployee._id.toString())) {
      visited.add(currentEmployee._id.toString());

      // Add current employee to hierarchy
      hierarchy.push({
        id: currentEmployee._id,
        name: `${currentEmployee.firstName || ""} ${currentEmployee.lastName || ""}`.trim(),
        employeeId: currentEmployee.employeeId,
        department: currentEmployee.department,
        level: hierarchy.length + 1,
      });

      // Move to primary manager if exists
      if (currentEmployee.primaryManager?.managerId) {
        currentEmployee = await Employee.findById(
          currentEmployee.primaryManager.managerId._id,
        )
          .select(
            "primaryManager secondaryManager firstName lastName employeeId department",
          )
          .populate(
            "primaryManager.managerId",
            "firstName lastName employeeId department",
          )
          .lean();
      } else {
        break;
      }
    }

    return hierarchy.reverse(); // Return from top to bottom
  } catch (error) {
    console.error("Error fetching manager hierarchy:", error);
    return [];
  }
};

// Helper function to get recent activities
const getRecentActivities = async (employeeId) => {
  // This is a placeholder - integrate with your activity logging system
  return [
    { id: 1, activity: "Profile updated", date: "2024-01-15", type: "update" },
    {
      id: 2,
      activity: "Login from new device",
      date: "2024-01-14",
      type: "security",
    },
    { id: 3, activity: "Salary credited", date: "2024-01-10", type: "salary" },
  ];
};

// Delete employee (soft delete)
router.delete("/:id", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;

    // Check if user has HR role
    if (user.role !== "hr_manager") {
      return res.status(403).json({
        success: false,
        message: "Only HR managers can delete employees",
      });
    }

    const employee = await Employee.findById(id);

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found",
      });
    }

    // Soft delete by setting isActive to false
    employee.isActive = false;
    employee.status = "inactive";
    await employee.save();

    res.status(200).json({
      success: true,
      message: "Employee deactivated successfully",
    });
  } catch (error) {
    console.error("Delete employee error:", error);

    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid employee ID",
      });
    }

    res.status(500).json({
      success: false,
      message: "Error deleting employee",
    });
  }
});

module.exports = router;
