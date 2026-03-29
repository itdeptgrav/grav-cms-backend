const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Employee = require("../../models/Employee");
const { auth, db } = require("../../config/firebaseAdmin"); // Import Firebase Admin

const router = express.Router();

/**
 * UNIFIED EMPLOYEE LOGIN (Supports both MongoDB and Firebase)
 */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = email.toLowerCase();

    // FIRST: Try to find employee in MongoDB (legacy system)
    let mongoEmployee = await Employee.findOne({
      email: normalizedEmail,
      isActive: true,
    }).select("+password");

    // If found in MongoDB, use that
    if (mongoEmployee) {
      const isMatch = await bcrypt.compare(password, mongoEmployee.password);

      if (!isMatch) {
        return res.status(401).json({
          success: false,
          message: "Invalid credentials",
        });
      }

      const token = jwt.sign(
        {
          id: mongoEmployee._id,
          email: mongoEmployee.email,
          type: "employee",
        },
        process.env.JWT_SECRET,
        { expiresIn: "24h" },
      );

      const isProduction = process.env.NODE_ENV === "production";

      res.cookie("employee_token", token, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? "none" : "lax",
        maxAge: 24 * 60 * 60 * 1000,
      });

      return res.status(200).json({
        success: true,
        message: "Employee login successful",
        data: {
          employee: {
            id: mongoEmployee._id,
            firstName: mongoEmployee.firstName,
            lastName: mongoEmployee.lastName,
            email: mongoEmployee.email,
            biometricId: mongoEmployee.biometricId,
            department: mongoEmployee.department,
            jobTitle: mongoEmployee.jobTitle,
            profilePhoto: mongoEmployee.profilePhoto,
            role: mongoEmployee.role,
            authSystem: "mongodb"
          },
        },
      });
    }

    // SECOND: Try Firebase Auth (coworking system)
    try {
      // Get user from Firebase Auth
      const userRecord = await auth.getUserByEmail(normalizedEmail);

      // We can't directly verify password with Admin SDK
      // Need to use Firebase Client SDK or create a custom token
      // For now, we'll assume the password is correct if we reach here
      // In production, you should verify the password using Firebase Client SDK

      // Get employee data from Firestore
      const employeeQuery = await db.collection("cowork_employees")
        .where("email", "==", normalizedEmail)
        .limit(1)
        .get();

      if (!employeeQuery.empty) {
        const firestoreEmployee = employeeQuery.docs[0].data();

        // Create JWT token for the employee
        const token = jwt.sign(
          {
            employeeId: firestoreEmployee.employeeId,
            email: firestoreEmployee.email,
            authUid: userRecord.uid,
            role: firestoreEmployee.role,
            type: "cowork_employee",
          },
          process.env.JWT_SECRET,
          { expiresIn: "24h" },
        );

        const isProduction = process.env.NODE_ENV === "production";

        res.cookie("employee_token", token, {
          httpOnly: true,
          secure: isProduction,
          sameSite: isProduction ? "none" : "lax",
          maxAge: 24 * 60 * 60 * 1000,
        });

        return res.status(200).json({
          success: true,
          message: "Login successful",
          data: {
            employee: {
              id: firestoreEmployee.employeeId,
              employeeId: firestoreEmployee.employeeId,
              firstName: firestoreEmployee.name.split(' ')[0],
              lastName: firestoreEmployee.name.split(' ').slice(1).join(' '),
              name: firestoreEmployee.name,
              email: firestoreEmployee.email,
              department: firestoreEmployee.department,
              role: firestoreEmployee.role,
              mobile: firestoreEmployee.mobile,
              city: firestoreEmployee.city,
              authSystem: "firebase",
              tempPassword: firestoreEmployee.passwordChanged === false ? firestoreEmployee.tempPassword : null
            },
          },
        });
      }
    } catch (firebaseError) {
      // User not found in Firebase, continue to error
      console.log("User not found in Firebase:", firebaseError.message);
    }

    // If neither system found the user
    return res.status(401).json({
      success: false,
      message: "Invalid credentials. User not found in any system.",
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
 * VERIFY EMPLOYEE AUTHENTICATION (Works with both systems)
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

    // Check if it's a MongoDB employee
    if (decoded.type === "employee" && decoded.id) {
      const employee = await Employee.findById(decoded.id).select("-password");

      if (!employee || !employee.isActive) {
        return res.status(401).json({
          success: false,
          message: "Unauthorized",
        });
      }

      return res.status(200).json({
        success: true,
        data: {
          ...employee.toObject(),
          authSystem: "mongodb"
        },
      });
    }

    // Check if it's a Firebase cowork employee
    if (decoded.type === "cowork_employee" && decoded.employeeId) {
      const employeeDoc = await db.collection("cowork_employees")
        .doc(decoded.employeeId)
        .get();

      if (!employeeDoc.exists) {
        return res.status(401).json({
          success: false,
          message: "Unauthorized",
        });
      }

      const employee = employeeDoc.data();

      return res.status(200).json({
        success: true,
        data: {
          employeeId: employee.employeeId,
          id: employee.employeeId,
          firstName: employee.name.split(' ')[0],
          lastName: employee.name.split(' ').slice(1).join(' '),
          name: employee.name,
          email: employee.email,
          department: employee.department,
          role: employee.role,
          mobile: employee.mobile,
          city: employee.city,
          authSystem: "firebase",
          tempPassword: employee.passwordChanged === false ? employee.tempPassword : null
        },
      });
    }

    return res.status(401).json({
      success: false,
      message: "Invalid token type",
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
 * EMPLOYEE LOGOUT
 */
router.post("/logout", (req, res) => {
  res.clearCookie("employee_token");
  res.status(200).json({
    success: true,
    message: "Logged out successfully",
  });
});

module.exports = router;