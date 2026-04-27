// All data after login like fetching user data based on token

const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const Employee = require("../../models/Employee");
const AllEmployeeAppMiddleware = require("../../Middlewear/AllEmployeeAppMiddleware");
const {
  decryptSalaryFields,
} = require("../../utils/salaryEncryption");

// Helper function to generate default password (must match login route)
const generateDefaultPassword = (firstName, dateOfBirth) => {
  if (!firstName || !dateOfBirth) return null;

  const formattedFirstName = firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();

  let date;
  if (typeof dateOfBirth === 'string') {
    date = new Date(dateOfBirth);
  } else {
    date = dateOfBirth;
  }

  if (isNaN(date.getTime())) return null;

  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const dobString = `${month}${day}${year}`;

  return `${formattedFirstName}@${dobString}`;
};

// Get employee profile - COMPLETE VERSION with all fields
router.get("/profile", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const employee = await Employee.findById(req.user.id)
      .select("-password -temporaryPassword -__v")
      .populate(
        "primaryManager.managerId",
        "firstName lastName email phone biometricId",
      )
      .populate(
        "secondaryManager.managerId",
        "firstName lastName email phone biometricId",
      );

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found",
      });
    }

    // Convert to object and add computed fields
    const responseData = employee.toObject();

    // Add phone number field for consistency
    responseData.phoneNumber = employee.phone || "";

    // Add full name
    responseData.fullName = `${employee.firstName || ''} ${employee.lastName || ''}`.trim();

    // Format date of joining if exists
    if (employee.dateOfJoining) {
      responseData.formattedDateOfJoining = new Date(employee.dateOfJoining).toLocaleDateString('en-IN', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      });
    }

    // Format date of birth if exists
    if (employee.dateOfBirth) {
      responseData.formattedDateOfBirth = new Date(employee.dateOfBirth).toLocaleDateString('en-IN', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      });
    }

    // Add default values for missing fields to prevent frontend errors
    responseData.designation = employee.jobTitle || employee.designation || "Not Assigned";
    responseData.jobPosition = employee.jobPosition || employee.jobTitle || "Not Assigned";

    // Ensure email is returned
    responseData.email = employee.email || "";

    // Ensure phone is returned
    responseData.phone = employee.phone || "";

    // Ensure profile photo is handled correctly
    if (!responseData.profilePhoto) {
      responseData.profilePhoto = { url: null, publicId: null };
    }

    res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    console.error("Get profile error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching profile",
    });
  }
});

// Get employee profile for editing (returns all editable fields)
router.get("/profile/edit", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const employee = await Employee.findById(req.user.id)
      .select("-password -temporaryPassword -__v");

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found",
      });
    }

    // Return all fields that can be edited
    const editableData = {
      // Personal Information
      firstName: employee.firstName || "",
      middleName: employee.middleName || "",
      lastName: employee.lastName || "",
      nickName: employee.nickName || "",
      title: employee.title || "",
      dateOfBirth: employee.dateOfBirth || null,
      gender: employee.gender || "",
      bloodGroup: employee.bloodGroup || "",
      maritalStatus: employee.maritalStatus || "",
      marriageDate: employee.marriageDate || null,
      spouseName: employee.spouseName || "",
      spouseDOB: employee.spouseDOB || null,
      nationality: employee.nationality || "",
      religion: employee.religion || "",
      placeOfBirth: employee.placeOfBirth || "",
      countryOfOrigin: employee.countryOfOrigin || "",
      residentialStatus: employee.residentialStatus || "",

      // Contact Information
      email: employee.email || "",
      phone: employee.phone || "",
      alternatePhone: employee.alternatePhone || "",
      personalEmail: employee.personalEmail || "",
      extension: employee.extension || "",

      // Work Information
      department: employee.department || "",
      jobTitle: employee.jobTitle || "",
      designation: employee.designation || "",
      workLocation: employee.workLocation || "",
      shift: employee.shift || "",
      dateOfJoining: employee.dateOfJoining || null,
      confirmationDate: employee.confirmationDate || null,
      probationPeriod: employee.probationPeriod || 0,
      employmentType: employee.employmentType || "",

      // Bank Details
      bankDetails: {
        bankName: employee.bankDetails?.bankName || "",
        accountNumber: employee.bankDetails?.accountNumber || "",
        ifscCode: employee.bankDetails?.ifscCode || "",
        accountType: employee.bankDetails?.accountType || "",
        branchName: employee.bankDetails?.branchName || "",
      },

      // Address
      address: {
        current: {
          street: employee.address?.current?.street || "",
          city: employee.address?.current?.city || "",
          state: employee.address?.current?.state || "",
          pincode: employee.address?.current?.pincode || "",
          country: employee.address?.current?.country || "India",
          ownershipType: employee.address?.current?.ownershipType || "",
        },
        permanent: {
          street: employee.address?.permanent?.street || "",
          city: employee.address?.permanent?.city || "",
          state: employee.address?.permanent?.state || "",
          pincode: employee.address?.permanent?.pincode || "",
          country: employee.address?.permanent?.country || "India",
          ownershipType: employee.address?.permanent?.ownershipType || "",
        },
      },

      // Emergency Contact
      emergencyContact: employee.emergencyContact || {},

      // Documents (only metadata, not actual files)
      documents: {
        aadharNumber: employee.documents?.aadharNumber || "",
        panNumber: employee.documents?.panNumber || "",
        uanNumber: employee.documents?.uanNumber || "",
        passportNumber: employee.documents?.passportNumber || "",
        voterIdNumber: employee.documents?.voterIdNumber || "",
        drivingLicenseNumber: employee.documents?.drivingLicenseNumber || "",
        esicNumber: employee.documents?.esicNumber || "",
        pfNumber: employee.documents?.pfNumber || "",
      },
    };

    res.status(200).json({
      success: true,
      data: editableData,
    });
  } catch (error) {
    console.error("Get profile edit error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching profile data",
    });
  }
});

// Update employee profile (self-update)
router.put("/profile", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const { user } = req;
    const updateData = req.body;

    // Remove restricted fields that employees shouldn't change
    const restrictedFields = [
      "password",
      "employeeId",
      "biometricId",
      "email",
      "phone",
      "phoneNumber",
      "department",
      "role",
      "createdBy",
      "createdAt",
      "isActive",
      "dateOfJoining",
      "primaryManager",
      "secondaryManager",
      "biometricId",
      "identityId",
    ];

    restrictedFields.forEach((field) => {
      delete updateData[field];
    });

    // Also remove any field that starts with $ (MongoDB operators)
    Object.keys(updateData).forEach(key => {
      if (key.startsWith('$')) {
        delete updateData[key];
      }
    });

    // Update employee
    const updatedEmployee = await Employee.findByIdAndUpdate(
      user.id,
      updateData,
      {
        new: true,
        runValidators: true,
      }
    ).select("-password -temporaryPassword -__v");

    if (!updatedEmployee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      data: updatedEmployee,
    });
  } catch (error) {
    console.error("Update profile error:", error);

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
      message: "Error updating profile",
    });
  }
});

// Change password - Updated to support default password
router.put("/change-password", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const { user } = req;
    const { currentPassword, newPassword } = req.body;

    // Validation
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Current password and new password are required",
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 6 characters long",
      });
    }

    // Find employee with password
    const employee = await Employee.findById(user.id).select("+password firstName dateOfBirth");
    if (!employee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found",
      });
    }

    // Verify current password - Check multiple methods
    let isPasswordValid = false;

    // Method 1: Check with stored hashed password
    if (employee.password) {
      if (employee.password.startsWith('$2')) {
        isPasswordValid = await bcrypt.compare(currentPassword, employee.password);
      } else {
        isPasswordValid = (currentPassword === employee.password);
      }
    }

    // Method 2: Check with default password format
    if (!isPasswordValid && employee.firstName && employee.dateOfBirth) {
      const defaultPassword = generateDefaultPassword(
        employee.firstName,
        employee.dateOfBirth
      );
      isPasswordValid = (currentPassword === defaultPassword);
    }

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: "Current password is incorrect",
      });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    // Update password in database
    await Employee.findByIdAndUpdate(user.id, {
      password: hashedPassword,
      updatedAt: Date.now(),
    });

    res.status(200).json({
      success: true,
      message: "Password changed successfully",
    });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({
      success: false,
      message: "Error changing password",
    });
  }
});

// Get dashboard statistics
router.get("/dashboard", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const { user } = req;

    // Get employee details
    const employee = await Employee.findById(user.id)
      .select("firstName lastName department jobTitle dateOfJoining phone email designation")
      .lean();

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found",
      });
    }

    // Get team count (if manager)
    const teamCount = await Employee.countDocuments({
      $or: [
        { "primaryManager.managerId": user.id },
        { "secondaryManager.managerId": user.id },
      ],
      isActive: true,
    });

    // Calculate tenure
    let tenure = "";
    if (employee.dateOfJoining) {
      const today = new Date();
      const joinDate = new Date(employee.dateOfJoining);
      const years = today.getFullYear() - joinDate.getFullYear();
      const months = today.getMonth() - joinDate.getMonth();

      tenure = `${years} year${years !== 1 ? 's' : ''}, ${months} month${months !== 1 ? 's' : ''}`;
    }

    // Get upcoming birthdays (within next 30 days)
    const today = new Date();
    const nextMonth = new Date(today);
    nextMonth.setDate(today.getDate() + 30);

    // Get birthdays considering month and day only
    const upcomingBirthdays = await Employee.aggregate([
      {
        $match: {
          isActive: true,
          dateOfBirth: { $exists: true, $ne: null }
        }
      },
      {
        $addFields: {
          birthdayThisYear: {
            $dateFromParts: {
              year: today.getFullYear(),
              month: { $month: "$dateOfBirth" },
              day: { $dayOfMonth: "$dateOfBirth" }
            }
          }
        }
      },
      {
        $match: {
          $expr: {
            $and: [
              { $gte: ["$birthdayThisYear", today] },
              { $lte: ["$birthdayThisYear", nextMonth] }
            ]
          }
        }
      },
      {
        $sort: { birthdayThisYear: 1 }
      },
      {
        $limit: 5
      },
      {
        $project: {
          firstName: 1,
          lastName: 1,
          dateOfBirth: 1,
          "profilePhoto.url": 1
        }
      }
    ]);

    res.status(200).json({
      success: true,
      data: {
        employee: {
          name: `${employee.firstName} ${employee.lastName}`,
          department: employee.department || "Not Assigned",
          jobTitle: employee.jobTitle || employee.designation || "Not Assigned",
          tenure: tenure || "Just joined",
          phoneNumber: employee.phone || "Not provided",
          email: employee.email || "Not provided",
        },
        stats: {
          teamCount,
        },
        upcomingBirthdays,
      },
    });
  } catch (error) {
    console.error("Dashboard error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching dashboard data",
    });
  }
});

// Get employee salary breakdown (decrypted)
router.get("/salary", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const employee = await Employee.findById(req.user.id)
      .select("salary firstName lastName biometricId phone")
      .lean();

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found"
      });
    }

    // Decrypt AES-encrypted salary fields into plain numbers
    const sal = decryptSalaryFields(employee.salary || {});

    res.status(200).json({
      success: true,
      data: {
        gross: sal.gross || 0,
        basic: sal.basic || 0,
        hra: sal.hra || 0,
        netSalary: sal.netSalary || 0,
        epf: sal.epf || 0,
        eeesic: sal.eeesic || 0,
        totalDeduction: sal.totalDeduction || 0,
        employerCost: sal.employerCost || 0,
        foodAllowance: sal.foodAllowance || 0,
        edli: sal.edli || 0,
        adminCharges: sal.adminCharges || 0,
        erEsic: sal.erEsic || 0,
      },
    });
  } catch (error) {
    console.error("Get salary error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching salary"
    });
  }
});

// Get employee basic info for header/navbar
router.get("/basic-info", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const employee = await Employee.findById(req.user.id)
      .select("firstName lastName profilePhoto.url role department phone email designation jobTitle")
      .lean();

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found",
      });
    }

    res.status(200).json({
      success: true,
      data: {
        name: `${employee.firstName || ''} ${employee.lastName || ''}`.trim(),
        firstName: employee.firstName,
        lastName: employee.lastName,
        profilePhoto: employee.profilePhoto?.url || null,
        role: employee.role || "employee",
        department: employee.department || "Not Assigned",
        designation: employee.designation || employee.jobTitle || "Not Assigned",
        phoneNumber: employee.phone || "Not provided",
        email: employee.email || "Not provided",
      },
    });
  } catch (error) {
    console.error("Get basic info error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching employee info",
    });
  }
});


module.exports = router;