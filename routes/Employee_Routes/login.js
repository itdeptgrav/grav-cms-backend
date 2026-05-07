const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Employee = require("../../models/Employee");

const router = express.Router();

// ── Helper: Extract token from cookie OR Bearer header (iOS fix) ──
function extractToken(req, cookieName = "employee_token") {
  // 1. Cookie (Android/Windows/desktop)
  let token = req.cookies?.[cookieName];
  // 2. Bearer token (iOS Safari — cookies blocked)
  if (!token && req.headers.authorization?.startsWith("Bearer ")) {
    token = req.headers.authorization.split(" ")[1];
  }
  // 3. Manual cookie parse fallback
  if (!token && req.headers.cookie) {
    const match = req.headers.cookie.match(new RegExp(`${cookieName}=([^;]+)`));
    if (match) token = match[1];
  }
  return token || null;
}

const extractDateComponents = (dateOfBirth) => {
  if (!dateOfBirth) return null;
  let date =
    typeof dateOfBirth === "string" ? new Date(dateOfBirth) : dateOfBirth;
  if (isNaN(date.getTime())) return null;
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
};

// Default password = employee's mobile number
const generateDefaultPassword = (phone) => {
  if (!phone) return null;
  return phone.trim();
};

// Helper: populate and format employee response
async function getFormattedEmployee(employeeId) {
  const employee = await Employee.findById(employeeId)
    .select("-password -temporaryPassword -__v")
    .populate(
      "primaryManager.managerId",
      "firstName lastName email phone biometricId",
    )
    .populate(
      "secondaryManager.managerId",
      "firstName lastName email phone biometricId",
    );

  if (!employee || !employee.isActive) return null;

  const responseData = employee.toObject();
  responseData.phoneNumber = employee.phone || "";
  responseData.phone = employee.phone || "";
  responseData.fullName =
    `${employee.firstName || ""} ${employee.lastName || ""}`.trim();
  if (employee.dateOfJoining)
    responseData.formattedDateOfJoining = new Date(
      employee.dateOfJoining,
    ).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  if (employee.dateOfBirth)
    responseData.formattedDateOfBirth = new Date(
      employee.dateOfBirth,
    ).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  responseData.designation =
    employee.designation || employee.jobTitle || "Not Assigned";
  responseData.jobTitle =
    employee.jobTitle || employee.designation || "Not Assigned";
  responseData.email = employee.email || "";
  if (!responseData.profilePhoto)
    responseData.profilePhoto = { url: null, publicId: null };

  return responseData;
}

/**
 * EMPLOYEE LOGIN
 */
router.post("/login", async (req, res) => {
  try {
    const { phoneNumber, password, rememberMe } = req.body;

    if (!phoneNumber || phoneNumber.length !== 10)
      return res.status(400).json({
        success: false,
        message: "Valid 10-digit phone number is required",
      });
    if (!password)
      return res
        .status(400)
        .json({ success: false, message: "Password is required" });

    const employee = await Employee.findOne({
      phone: phoneNumber,
      isActive: true,
    }).select("+password");
    if (!employee)
      return res
        .status(401)
        .json({ success: false, message: "Invalid phone number or password" });

    let isMatch = false;
    if (employee.password) {
      if (employee.password.startsWith("$2"))
        isMatch = await bcrypt.compare(password, employee.password);
      else isMatch = password === employee.password;
    }
    if (!isMatch && employee.phone) {
      const defaultPassword = generateDefaultPassword(employee.phone);
      if (defaultPassword && password === defaultPassword) {
        isMatch = true;
        const salt = await bcrypt.genSalt(10);
        employee.password = await bcrypt.hash(defaultPassword, salt);
        await employee.save();
      }
    }
    if (!isMatch)
      return res
        .status(401)
        .json({ success: false, message: "Invalid phone number or password" });

    const expiresIn = rememberMe ? "30d" : "7d";
    const maxAge = rememberMe
      ? 30 * 24 * 60 * 60 * 1000
      : 7 * 24 * 60 * 60 * 1000;

    const token = jwt.sign(
      {
        id: employee._id,
        phoneNumber: employee.phone,
        email: employee.email || "",
        type: "employee",
      },
      process.env.JWT_SECRET,
      { expiresIn },
    );

    const isProduction = process.env.NODE_ENV === "production";
    res.cookie("employee_token", token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
      maxAge,
    });

    res.status(200).json({
      success: true,
      message: "Employee login successful",
      data: {
        employee: {
          id: employee._id,
          _id: employee._id,
          firstName: employee.firstName,
          lastName: employee.lastName,
          email: employee.email,
          phoneNumber: employee.phone,
          phone: employee.phone,
          biometricId: employee.biometricId,
          department: employee.department,
          jobTitle: employee.jobTitle,
          designation: employee.designation || employee.jobTitle,
          profilePhoto: employee.profilePhoto?.url || null,
          role: employee.role || "employee",
        },
        token,
      },
    });
  } catch (err) {
    console.error("Employee login error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/**
 * VERIFY — now checks Bearer token too (iOS fix)
 */
router.get("/verify", async (req, res) => {
  try {
    const token = extractToken(req);
    if (!token)
      return res
        .status(401)
        .json({ success: false, message: "Not authenticated" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const responseData = await getFormattedEmployee(decoded.id);
    if (!responseData)
      return res.status(401).json({ success: false, message: "Unauthorized" });

    return res.status(200).json({ success: true, data: responseData });
  } catch (error) {
    console.error("Verify error:", error.message);
    return res
      .status(401)
      .json({ success: false, message: "Invalid or expired token" });
  }
});

/**
 * GET PROFILE — now checks Bearer token too (iOS fix)
 */
router.get("/profile", async (req, res) => {
  try {
    const token = extractToken(req);
    if (!token)
      return res
        .status(401)
        .json({ success: false, message: "Not authenticated" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const responseData = await getFormattedEmployee(decoded.id);
    if (!responseData)
      return res
        .status(401)
        .json({ success: false, message: "Employee not found or inactive" });

    return res.status(200).json({ success: true, data: responseData });
  } catch (error) {
    console.error("Profile fetch error:", error.message);
    return res
      .status(401)
      .json({ success: false, message: "Invalid or expired token" });
  }
});

/**
 * LOGOUT
 */
router.post("/logout", (req, res) => {
  res.clearCookie("employee_token");
  res.status(200).json({ success: true, message: "Logged out successfully" });
});

/**
 * CHANGE PASSWORD — now checks Bearer token too (iOS fix)
 */
router.post("/change-password", async (req, res) => {
  try {
    const token = extractToken(req);
    if (!token)
      return res
        .status(401)
        .json({ success: false, message: "Not authenticated" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { oldPassword, newPassword, currentPassword } = req.body;
    const oldPw = oldPassword || currentPassword;

    if (!oldPw || !newPassword)
      return res.status(400).json({
        success: false,
        message: "Both old and new passwords are required",
      });

    const employee = await Employee.findById(decoded.id).select(
      "+password firstName dateOfBirth",
    );
    if (!employee)
      return res
        .status(404)
        .json({ success: false, message: "Employee not found" });

    let isValid = false;
    if (employee.password) {
      if (employee.password.startsWith("$2"))
        isValid = await bcrypt.compare(oldPw, employee.password);
      else isValid = oldPw === employee.password;
    }
    if (!isValid && employee.firstName && employee.dateOfBirth) {
      const defaultPassword = generateDefaultPassword(
        employee.firstName,
        employee.dateOfBirth,
      );
      isValid = oldPw === defaultPassword;
    }
    if (!isValid)
      return res
        .status(401)
        .json({ success: false, message: "Current password is incorrect" });

    const salt = await bcrypt.genSalt(10);
    employee.password = await bcrypt.hash(newPassword, salt);
    await employee.save();

    res
      .status(200)
      .json({ success: true, message: "Password changed successfully" });
  } catch (error) {
    console.error("Change password error:", error.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
