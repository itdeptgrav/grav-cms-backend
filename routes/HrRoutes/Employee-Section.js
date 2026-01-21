const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const Employee = require("../../models/Employee");
const EmployeeAuthMiddlewear = require("../../Middlewear/EmployeeAuthMiddlewear");
const emailService = require("../../services/emailService");

require("dotenv").config();

// CREATE new employee - UPDATED for Cloudinary URLs from frontend
router.post("/", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    const employeeData = req.body;

    console.log("Received employee data with Cloudinary URLs:", {
      hasProfilePhoto: !!employeeData.profilePhoto,
      profilePhotoType: employeeData.profilePhoto?.url
        ? "Cloudinary URL"
        : "Other",
      hasDocuments: !!employeeData.documents,
      additionalDocsCount:
        employeeData.documents?.additionalDocuments?.length || 0,
    });

    // Clean up profile photo data if it's a base64 string (from older clients)
    if (
      employeeData.profilePhoto &&
      typeof employeeData.profilePhoto === "string" &&
      employeeData.profilePhoto.startsWith("data:image")
    ) {
      console.log(
        "Warning: Received base64 profile photo. Frontend should upload to Cloudinary.",
      );
      delete employeeData.profilePhoto; // Remove base64 data
    }

    // Clean up document URLs if they contain base64 data
    if (employeeData.documents) {
      // Clean Aadhar file
      if (
        employeeData.documents.aadharFile &&
        typeof employeeData.documents.aadharFile === "string" &&
        employeeData.documents.aadharFile.startsWith("data:image")
      ) {
        console.log(
          "Warning: Received base64 Aadhar file. Frontend should upload to Cloudinary.",
        );
        delete employeeData.documents.aadharFile;
      }

      // Clean PAN file
      if (
        employeeData.documents.panFile &&
        typeof employeeData.documents.panFile === "string" &&
        employeeData.documents.panFile.startsWith("data:image")
      ) {
        console.log(
          "Warning: Received base64 PAN file. Frontend should upload to Cloudinary.",
        );
        delete employeeData.documents.panFile;
      }

      // Clean resume file
      if (
        employeeData.documents.resumeFile &&
        typeof employeeData.documents.resumeFile === "string" &&
        employeeData.documents.resumeFile.startsWith("data:image")
      ) {
        console.log(
          "Warning: Received base64 resume file. Frontend should upload to Cloudinary.",
        );
        delete employeeData.documents.resumeFile;
      }

      // Clean additional documents
      if (employeeData.documents.additionalDocuments) {
        employeeData.documents.additionalDocuments =
          employeeData.documents.additionalDocuments.filter((doc) => {
            if (
              doc.url &&
              typeof doc.url === "string" &&
              doc.url.startsWith("data:image")
            ) {
              console.log(
                "Warning: Filtered out base64 additional document:",
                doc.title,
              );
              return false; // Remove base64 documents
            }
            return true; // Keep valid documents with Cloudinary URLs
          });
      }
    }

    // Generate a temporary password for the employee
    const temporaryPassword = Math.random().toString(36).slice(-8);
    const hashedPassword = await bcrypt.hash(temporaryPassword, 10);

    // Create employee with the new fields
    const newEmployee = new Employee({
      ...employeeData,
      // Add password for login
      password: hashedPassword,
      temporaryPassword: temporaryPassword, // Store temporary password for email

      // Ensure all fields are properly structured
      departmentId: employeeData.departmentId,
      designation: employeeData.designation || employeeData.jobPosition,

      // Handle managers properly
      primaryManager: employeeData.primaryManager || undefined,
      secondaryManager: employeeData.secondaryManager || undefined,

      // Set default values
      status: employeeData.status || "active",
      isActive:
        employeeData.isActive !== undefined ? employeeData.isActive : true,

      // Track creator
      createdBy: user.id,
      createdAt: new Date(),
    });

    await newEmployee.save();

    // Send welcome email asynchronously (only if email service is enabled)
    if (process.env.ENABLE_EMAILS === "true" && employeeData.email) {
      try {
        const emailData = {
          name: `${employeeData.firstName} ${employeeData.lastName}`,
          email: employeeData.email,
          employeeId: employeeData.employeeId,
          department: employeeData.department,
          designation: employeeData.designation || employeeData.jobPosition,
          temporaryPassword: temporaryPassword,
        };

        // Send email in background
        emailService
          .sendWelcomeEmail(emailData)
          .then((result) => {
            console.log(
              `✅ Welcome email sent successfully to ${employeeData.email}`,
            );

            // Update employee record with email sent status
            Employee.findByIdAndUpdate(
              newEmployee._id,
              {
                $set: {
                  welcomeEmailSent: true,
                  emailSentAt: new Date(),
                  temporaryPassword: null, // Clear temporary password after email is sent
                },
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

// UPDATE employee - UPDATED for Cloudinary URLs from frontend
router.put("/:id", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const updateData = req.body;

    console.log("Updating employee with Cloudinary URLs:", {
      employeeId: id,
      hasProfilePhoto: !!updateData.profilePhoto,
      profilePhotoType: updateData.profilePhoto?.url
        ? "Cloudinary URL"
        : "Other",
    });

    // Check if user has HR role or is updating their own profile
    const canUpdate = user.role === "hr_manager" || user.id === id;
    if (!canUpdate) {
      return res.status(403).json({
        success: false,
        message: "You don't have permission to update this employee",
      });
    }

    // Clean up profile photo data if it's a base64 string
    if (
      updateData.profilePhoto &&
      typeof updateData.profilePhoto === "string" &&
      updateData.profilePhoto.startsWith("data:image")
    ) {
      console.log(
        "Warning: Received base64 profile photo in update. Frontend should upload to Cloudinary.",
      );
      delete updateData.profilePhoto;
    }

    // Clean up document URLs if they contain base64 data
    if (updateData.documents) {
      // Clean Aadhar file
      if (
        updateData.documents.aadharFile &&
        typeof updateData.documents.aadharFile === "string" &&
        updateData.documents.aadharFile.startsWith("data:image")
      ) {
        console.log("Warning: Received base64 Aadhar file in update.");
        delete updateData.documents.aadharFile;
      }

      // Clean PAN file
      if (
        updateData.documents.panFile &&
        typeof updateData.documents.panFile === "string" &&
        updateData.documents.panFile.startsWith("data:image")
      ) {
        console.log("Warning: Received base64 PAN file in update.");
        delete updateData.documents.panFile;
      }

      // Clean resume file
      if (
        updateData.documents.resumeFile &&
        typeof updateData.documents.resumeFile === "string" &&
        updateData.documents.resumeFile.startsWith("data:image")
      ) {
        console.log("Warning: Received base64 resume file in update.");
        delete updateData.documents.resumeFile;
      }

      // Clean additional documents
      if (updateData.documents.additionalDocuments) {
        updateData.documents.additionalDocuments =
          updateData.documents.additionalDocuments.filter((doc) => {
            if (
              doc.url &&
              typeof doc.url === "string" &&
              doc.url.startsWith("data:image")
            ) {
              console.log(
                "Warning: Filtered out base64 additional document in update:",
                doc.title,
              );
              return false;
            }
            return true;
          });
      }
    }

    // Fields that should not be updated via this endpoint
    const restrictedFields = [
      "employeeId",
      "email",
      "password",
      "temporaryPassword",
      "createdBy",
      "createdAt",
    ];

    // Remove restricted fields
    restrictedFields.forEach((field) => {
      delete updateData[field];
    });

    // Preserve existing password if not provided
    if (updateData.password) {
      // Only allow password updates through dedicated endpoint
      delete updateData.password;
    }

    const updatedEmployee = await Employee.findByIdAndUpdate(id, updateData, {
      new: true,
      runValidators: true,
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

// UPDATE EMPLOYEE DOCUMENTS ONLY (for adding/updating documents separately)
router.patch("/:id/documents", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const { documents } = req.body;

    // Check permissions
    const canUpdate = user.role === "hr_manager" || user.id === id;
    if (!canUpdate) {
      return res.status(403).json({
        success: false,
        message: "You don't have permission to update documents",
      });
    }

    // Clean base64 data from documents
    const cleanDocuments = { ...documents };

    if (
      cleanDocuments.aadharFile &&
      typeof cleanDocuments.aadharFile === "string" &&
      cleanDocuments.aadharFile.startsWith("data:image")
    ) {
      delete cleanDocuments.aadharFile;
    }

    if (
      cleanDocuments.panFile &&
      typeof cleanDocuments.panFile === "string" &&
      cleanDocuments.panFile.startsWith("data:image")
    ) {
      delete cleanDocuments.panFile;
    }

    if (
      cleanDocuments.resumeFile &&
      typeof cleanDocuments.resumeFile === "string" &&
      cleanDocuments.resumeFile.startsWith("data:image")
    ) {
      delete cleanDocuments.resumeFile;
    }

    if (cleanDocuments.additionalDocuments) {
      cleanDocuments.additionalDocuments =
        cleanDocuments.additionalDocuments.filter((doc) => {
          return !(
            doc.url &&
            typeof doc.url === "string" &&
            doc.url.startsWith("data:image")
          );
        });
    }

    const updatedEmployee = await Employee.findByIdAndUpdate(
      id,
      { $set: { documents: cleanDocuments } },
      {
        new: true,
        runValidators: true,
      },
    ).select("documents firstName lastName employeeId");

    if (!updatedEmployee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Documents updated successfully",
      data: updatedEmployee.documents,
    });
  } catch (error) {
    console.error("Update documents error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating documents",
    });
  }
});

// UPDATE PROFILE PHOTO ONLY
router.patch("/:id/profile-photo", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const { profilePhoto } = req.body;

    // Check permissions
    const canUpdate = user.role === "hr_manager" || user.id === id;
    if (!canUpdate) {
      return res.status(403).json({
        success: false,
        message: "You don't have permission to update profile photo",
      });
    }

    // Validate profile photo is a Cloudinary URL object
    if (!profilePhoto || !profilePhoto.url || !profilePhoto.publicId) {
      return res.status(400).json({
        success: false,
        message: "Valid profile photo with URL and publicId is required",
      });
    }

    // Ensure it's not base64
    if (
      typeof profilePhoto.url === "string" &&
      profilePhoto.url.startsWith("data:image")
    ) {
      return res.status(400).json({
        success: false,
        message: "Profile photo must be uploaded to Cloudinary first",
      });
    }

    const updatedEmployee = await Employee.findByIdAndUpdate(
      id,
      { $set: { profilePhoto } },
      {
        new: true,
        runValidators: true,
      },
    ).select("profilePhoto firstName lastName employeeId");

    if (!updatedEmployee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Profile photo updated successfully",
      data: updatedEmployee.profilePhoto,
    });
  } catch (error) {
    console.error("Update profile photo error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating profile photo",
    });
  }
});

// Get all employees (with pagination and filters) - REMAINS THE SAME
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
      .select("-password -temporaryPassword -__v")
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

// Get single employee
router.get("/:id", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { id } = req.params;

    const employee = await Employee.findById(id)
      .select("-password -temporaryPassword -__v")
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

// Get single employee with detailed information - REMAINS THE SAME
router.get("/:id/details", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { id } = req.params;

    // Fetch employee with detailed information
    const employee = await Employee.findById(id)
      .select("-password -temporaryPassword -__v")
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
        profilePhoto: employee.profilePhoto,
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

      // Documents (now with Cloudinary URLs)
      documents: {
        aadharNumber: employee.documents?.aadharNumber || "Not Provided",
        panNumber: employee.documents?.panNumber || "Not Provided",
        uanNumber: employee.documents?.uanNumber || "Not Provided",
        aadharFile: employee.documents?.aadharFile,
        panFile: employee.documents?.panFile,
        resumeFile: employee.documents?.resumeFile,
        additionalDocuments: employee.documents?.additionalDocuments || [],
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

// Get employees by department and designation (for manager selection) - REMAINS THE SAME
router.get(
  "/department/employees",
  EmployeeAuthMiddlewear,
  async (req, res) => {
    try {
      const { departmentId, designation } = req.query;

      if (!departmentId || !designation) {
        return res.status(400).json({
          success: false,
          message: "Department ID and designation are required",
        });
      }

      // Find employees with matching department and designation
      const employees = await Employee.find({
        departmentId: departmentId,
        designation: designation,
        status: "active",
        isActive: true,
      })
        .select(
          "firstName lastName employeeId email phone department designation jobTitle profilePhoto",
        )
        .sort({ firstName: 1 })
        .lean();

      // Format the response
      const formattedEmployees = employees.map((emp) => ({
        id: emp._id,
        employeeId: emp.employeeId,
        name: `${emp.firstName} ${emp.lastName}`,
        fullName: `${emp.firstName} ${emp.lastName}`,
        email: emp.email,
        phone: emp.phone,
        department: emp.department,
        designation: emp.designation,
        jobTitle: emp.jobTitle,
        profilePhoto: emp.profilePhoto,
      }));

      res.status(200).json({
        success: true,
        data: formattedEmployees,
        count: formattedEmployees.length,
      });
    } catch (error) {
      console.error("Get department employees error:", error);
      res.status(500).json({
        success: false,
        message: "Error fetching employees",
      });
    }
  },
);

// Delete employee (soft delete) - REMAINS THE SAME
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

// Helper functions - REMAIN THE SAME
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

const formatEmploymentType = (type) => {
  const types = {
    full_time: "Full Time",
    part_time: "Part Time",
    contract: "Contract",
    intern: "Intern",
  };
  return types[type] || type || "Not Provided";
};

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

module.exports = router;
