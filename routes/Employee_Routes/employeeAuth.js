// Alll data after login like fetching user data based on token

const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const Employee = require("../../models/Employee");
const EmployeeAuthMiddleware = require("../../middleware/EmployeeAuthMiddleware");

// Get employee profile
router.get("/profile", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const employee = await Employee.findById(req.user.id)
      .select("-password -temporaryPassword -__v")
      .populate(
        "primaryManager.managerId",
        "firstName lastName email employeeId",
      )
      .populate(
        "secondaryManager.managerId",
        "firstName lastName email employeeId",
      );

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
    console.error("Get profile error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching profile",
    });
  }
});

// Update employee profile (self-update)
router.put("/profile", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { user } = req;
    const updateData = req.body;

    // Remove restricted fields
    const restrictedFields = [
      "password",
      "employeeId",
      "biometricId",
      "email",
      "department",
      "role",
      "createdBy",
      "createdAt",
    ];

    restrictedFields.forEach((field) => {
      delete updateData[field];
    });

    // Update employee
    const updatedEmployee = await Employee.findByIdAndUpdate(
      user.id,
      updateData,
      {
        new: true,
        runValidators: true,
      },
    ).select("-password -temporaryPassword -__v");

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

// Change password
router.put("/change-password", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { user } = req;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Current password and new password are required",
      });
    }

    // Get employee with password
    const employee = await Employee.findById(user.id).select("+password");

    // Verify current password
    const isPasswordValid = await bcrypt.compare(
      currentPassword,
      employee.password,
    );

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: "Current password is incorrect",
      });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    // Update password
    employee.password = hashedPassword;
    await employee.save();

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

// Get team members (for managers)
router.get("/team", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { user } = req;

    const teamMembers = await Employee.find({
      $or: [
        { "primaryManager.managerId": user.id },
        { "secondaryManager.managerId": user.id },
      ],
      isActive: true,
    })
      .select(
        "firstName lastName email employeeId department jobTitle profilePhoto",
      )
      .sort({ firstName: 1 });

    res.status(200).json({
      success: true,
      data: teamMembers,
      count: teamMembers.length,
    });
  } catch (error) {
    console.error("Get team error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching team members",
    });
  }
});

// Get dashboard statistics
router.get("/dashboard", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { user } = req;

    // Get employee details
    const employee = await Employee.findById(user.id)
      .select("firstName lastName department jobTitle dateOfJoining")
      .lean();

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

      tenure = `${years} years, ${months} months`;
    }

    // Get upcoming birthdays (within next 30 days)
    const today = new Date();
    const nextMonth = new Date(today);
    nextMonth.setDate(today.getDate() + 30);

    const upcomingBirthdays = await Employee.find({
      dateOfBirth: {
        $gte: today,
        $lte: nextMonth,
      },
      isActive: true,
    })
      .select("firstName lastName dateOfBirth profilePhoto")
      .limit(5)
      .sort({ dateOfBirth: 1 });

    res.status(200).json({
      success: true,
      data: {
        employee: {
          name: `${employee.firstName} ${employee.lastName}`,
          department: employee.department,
          jobTitle: employee.jobTitle,
          tenure: tenure,
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

module.exports = router;
