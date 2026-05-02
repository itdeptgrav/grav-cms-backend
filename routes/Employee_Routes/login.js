const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Employee = require("../../models/Employee");

const router = express.Router();

// Helper function to extract date components without timezone issues
const extractDateComponents = (dateOfBirth) => {
  if (!dateOfBirth) return null;

  let date;
  if (typeof dateOfBirth === 'string') {
    date = new Date(dateOfBirth);
  } else {
    date = dateOfBirth;
  }

  if (isNaN(date.getTime())) return null;

  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();

  return { year, month, day };
};

// Helper function to generate default password
const generateDefaultPassword = (firstName, dateOfBirth) => {
  if (!firstName || !dateOfBirth) return null;

  const formattedFirstName = firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();
  const dateComponents = extractDateComponents(dateOfBirth);

  if (!dateComponents) return null;

  const { year, month, day } = dateComponents;
  const monthStr = String(month).padStart(2, '0');
  const dayStr = String(day).padStart(2, '0');
  const yearStr = String(year);
  const dobString = `${monthStr}${dayStr}${yearStr}`;

  return `${formattedFirstName}@${dobString}`;
};

/**
 * EMPLOYEE LOGIN - Using Phone Number
 */
router.post("/login", async (req, res) => {
  try {
    const { phoneNumber, password, rememberMe } = req.body;

    // Validate phone number
    if (!phoneNumber || phoneNumber.length !== 10) {
      return res.status(400).json({
        success: false,
        message: "Valid 10-digit phone number is required",
      });
    }

    if (!password) {
      return res.status(400).json({
        success: false,
        message: "Password is required",
      });
    }

    // Find employee by phone number
    const employee = await Employee.findOne({
      phone: phoneNumber,
      isActive: true,
    }).select("+password");

    if (!employee) {
      return res.status(401).json({
        success: false,
        message: "Invalid phone number or password",
      });
    }

    // Check password
    let isMatch = false;

    // Check stored password
    if (employee.password) {
      if (employee.password.startsWith('$2')) {
        isMatch = await bcrypt.compare(password, employee.password);
      } else {
        isMatch = (password === employee.password);
      }
    }

    // Check default password if needed
    if (!isMatch && employee.firstName && employee.dateOfBirth) {
      const defaultPassword = generateDefaultPassword(
        employee.firstName,
        employee.dateOfBirth
      );

      if (defaultPassword && password === defaultPassword) {
        isMatch = true;

        // Hash the default password for future use
        const salt = await bcrypt.genSalt(10);
        employee.password = await bcrypt.hash(defaultPassword, salt);
        await employee.save();
      }
    }

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid phone number or password",
      });
    }

    // Set token expiry based on remember me
    const expiresIn = rememberMe ? "30d" : "7d";
    const maxAge = rememberMe ? 30 * 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;

    // Create token
    const token = jwt.sign(
      {
        id: employee._id,
        phoneNumber: employee.phone,
        email: employee.email || "",
        type: "employee",
      },
      process.env.JWT_SECRET,
      { expiresIn: expiresIn },
    );

    const isProduction = process.env.NODE_ENV === "production";

    // Set cookie
    res.cookie("employee_token", token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
      maxAge: maxAge,
    });

    res.status(200).json({
      success: true,
      message: "Employee login successful",
      data: {
        employee: {
          id: employee._id,
          firstName: employee.firstName,
          lastName: employee.lastName,
          email: employee.email,
          phoneNumber: employee.phone,
          biometricId: employee.biometricId,
          department: employee.department,
          jobTitle: employee.jobTitle,
          profilePhoto: employee.profilePhoto?.url || null,
          role: employee.role || "employee",
        },
        token,
      },
    });
  } catch (err) {
    console.error("Employee login error:", err);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

/**
 * VERIFY EMPLOYEE AUTHENTICATION
 */
router.get("/verify", async (req, res) => {
  try {
    const token = req.cookies.employee_token;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Not authenticated",
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const employee = await Employee.findById(decoded.id)
      .select("-password -temporaryPassword -__v")
      .populate(
        "primaryManager.managerId",
        "firstName lastName email phone biometricId",
      )
      .populate(
        "secondaryManager.managerId",
        "firstName lastName email phone biometricId",
      );

    if (!employee || !employee.isActive) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    // Convert to object and add computed fields
    const responseData = employee.toObject();

    // Add phone number field for consistency
    responseData.phoneNumber = employee.phone || "";
    responseData.phone = employee.phone || "";

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

    // Add default values for missing fields
    responseData.designation = employee.designation || employee.jobTitle || "Not Assigned";
    responseData.jobTitle = employee.jobTitle || employee.designation || "Not Assigned";

    // Ensure email is returned
    responseData.email = employee.email || "";

    // Ensure profile photo is handled correctly
    if (!responseData.profilePhoto) {
      responseData.profilePhoto = { url: null, publicId: null };
    }

    return res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    console.error("Verify error:", error);
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
});

/**
 * GET EMPLOYEE PROFILE - Updated to return ALL fields
 */
router.get("/profile", async (req, res) => {
  try {
    const token = req.cookies.employee_token;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Not authenticated",
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const employee = await Employee.findById(decoded.id)
      .select("-password -temporaryPassword -__v")
      .populate(
        "primaryManager.managerId",
        "firstName lastName email phone biometricId",
      )
      .populate(
        "secondaryManager.managerId",
        "firstName lastName email phone biometricId",
      );

    if (!employee || !employee.isActive) {
      return res.status(401).json({
        success: false,
        message: "Employee not found or inactive",
      });
    }

    // Convert to object and add computed fields
    const responseData = employee.toObject();

    // Add phone number field for consistency
    responseData.phoneNumber = employee.phone || "";
    responseData.phone = employee.phone || "";

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

    // Add default values for missing fields
    responseData.designation = employee.designation || employee.jobTitle || "Not Assigned";
    responseData.jobTitle = employee.jobTitle || employee.designation || "Not Assigned";

    // Ensure email is returned
    responseData.email = employee.email || "";

    // Ensure profile photo is handled correctly
    if (!responseData.profilePhoto) {
      responseData.profilePhoto = { url: null, publicId: null };
    }

    return res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    console.error("Profile fetch error:", error);
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
});

/**
 * EMPLOYEE LOGOUT
 */
router.post("/logout", (req, res) => {
  res.clearCookie("employee_token");
  res.status(200).json({
    success: true,
    message: "Logged out successfully",
  });
});

/**
 * CHANGE PASSWORD
 */
router.post("/change-password", async (req, res) => {
  try {
    const token = req.cookies.employee_token;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Not authenticated",
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Both old and new passwords are required",
      });
    }

    const employee = await Employee.findById(decoded.id).select("+password");

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found",
      });
    }

    // Verify old password
    let isValid = false;

    if (employee.password) {
      if (employee.password.startsWith('$2')) {
        isValid = await bcrypt.compare(oldPassword, employee.password);
      } else {
        isValid = (oldPassword === employee.password);
      }
    }

    if (!isValid && employee.firstName && employee.dateOfBirth) {
      const defaultPassword = generateDefaultPassword(
        employee.firstName,
        employee.dateOfBirth
      );
      isValid = (oldPassword === defaultPassword);
    }

    if (!isValid) {
      return res.status(401).json({
        success: false,
        message: "Current password is incorrect",
      });
    }

    // Hash and save new password
    const salt = await bcrypt.genSalt(10);
    employee.password = await bcrypt.hash(newPassword, salt);
    await employee.save();

    res.status(200).json({
      success: true,
      message: "Password changed successfully",
    });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

module.exports = router;