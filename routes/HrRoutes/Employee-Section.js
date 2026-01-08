const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const Employee = require("../../models/Employee");
const EmployeeAuthMiddlewear = require("../../Middlewear/EmployeeAuthMiddlewear");
const emailService = require("../../services/emailService");

require('dotenv').config();


router.post("/create", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    const employeeData = req.body;

    // Check duplicate employeeId
    if (employeeData.employeeId) {
      const existingEmployeeId = await Employee.findOne({ employeeId: employeeData.employeeId });
      if (existingEmployeeId) {
        return res.status(400).json({
          success: false,
          message: "Employee ID already exists"
        });
      }
    }

    // Check duplicate email
    if (employeeData.email) {
      const existingEmail = await Employee.findOne({
        email: employeeData.email.toLowerCase()
      });

      if (existingEmail) {
        return res.status(400).json({
          success: false,
          message: "Email already exists"
        });
      }

      // Auto-generate password
      const emailPrefix = employeeData.email.slice(0, 3); // first 3 letters
      const temporaryPassword = emailPrefix + "@2025";
      employeeData.password = temporaryPassword;

      // Store the temporary password for email
      employeeData.temporaryPassword = temporaryPassword;
    }

    employeeData.createdBy = user.id;

    const newEmployee = new Employee(employeeData);
    await newEmployee.save();

    // Send welcome email asynchronously (don't await to keep API response fast)
    if (process.env.ENABLE_EMAILS === 'true' && employeeData.email) {
      try {
        // Prepare employee data for email
        const emailData = {
          name: employeeData.name || employeeData.firstName + ' ' + employeeData.lastName,
          email: employeeData.email,
          employeeId: employeeData.employeeId,
          department: employeeData.department,
          position: employeeData.position
        };

        // Send email in background
        emailService.sendWelcomeEmail(emailData, employeeData.temporaryPassword)
          .then(result => {
            console.log(`✅ Welcome email sent successfully to ${employeeData.email}`);

            // Optional: Update employee record with email sent status
            Employee.findByIdAndUpdate(newEmployee._id, {
              $set: { welcomeEmailSent: true, emailSentAt: new Date() }
            }, { new: true }).catch(updateErr => {
              console.error('Error updating email status:', updateErr);
            });
          })
          .catch(emailError => {
            console.error(`❌ Failed to send email to ${employeeData.email}:`, emailError.message);

            // Log the error but don't fail the employee creation
            Employee.findByIdAndUpdate(newEmployee._id, {
              $set: {
                welcomeEmailSent: false,
                emailError: emailError.message
              }
            }, { new: true }).catch(updateErr => {
              console.error('Error updating email error status:', updateErr);
            });
          });
      } catch (emailError) {
        console.error('Error in email sending process:', emailError);
        // Don't throw error - employee should still be created
      }
    }

    // Remove sensitive data from response
    const employeeResponse = newEmployee.toObject();
    delete employeeResponse.password;
    delete employeeResponse.temporaryPassword;

    res.status(201).json({
      success: true,
      message: "Employee created successfully. Welcome email has been dispatched.",
      data: employeeResponse,
      emailSent: process.env.ENABLE_EMAILS === 'true'
    });

  } catch (error) {
    console.error("Create employee error:", error);

    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: "Validation error",
        errors
      });
    }

    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(400).json({
        success: false,
        message: `${field} already exists`
      });
    }

    res.status(500).json({
      success: false,
      message: "Error creating employee",
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});


// Get all employees (with pagination and filters)
router.get("/all", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    const {
      page = 1,
      limit = 10,
      department,
      status,
      search
    } = req.query;

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
        { jobTitle: { $regex: search, $options: "i" } }
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
      { $sort: { count: -1 } }
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
          hasPrevPage: page > 1
        },
        stats: {
          total,
          departmentStats
        }
      }
    });

  } catch (error) {
    console.error("Get employees error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching employees"
    });
  }
});

// Get single employee by ID
router.get("/:id", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { id } = req.params;

    const employee = await Employee.findById(id)
      .select("-__v")
      .lean();

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found"
      });
    }

    res.status(200).json({
      success: true,
      data: employee
    });

  } catch (error) {
    console.error("Get employee error:", error);

    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid employee ID"
      });
    }

    res.status(500).json({
      success: false,
      message: "Error fetching employee"
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
        message: "Only HR managers can update employees"
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
        _id: { $ne: id }
      });
      if (existingEmail) {
        return res.status(400).json({
          success: false,
          message: "Email already exists"
        });
      }
    }

    const updatedEmployee = await Employee.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    ).select("-__v");

    if (!updatedEmployee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found"
      });
    }

    res.status(200).json({
      success: true,
      message: "Employee updated successfully",
      data: updatedEmployee
    });

  } catch (error) {
    console.error("Update employee error:", error);

    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: "Validation error",
        errors
      });
    }

    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "Duplicate key error"
      });
    }

    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid employee ID"
      });
    }

    res.status(500).json({
      success: false,
      message: "Error updating employee"
    });
  }
});

// Delete employee (soft delete)
router.delete("/:id", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;

    // Check if user has HR role
    if (user.role !== "hr_manager") {
      return res.status(403).json({
        success: false,
        message: "Only HR managers can delete employees"
      });
    }

    const employee = await Employee.findById(id);

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found"
      });
    }

    // Soft delete by setting isActive to false
    employee.isActive = false;
    employee.status = "inactive";
    await employee.save();

    res.status(200).json({
      success: true,
      message: "Employee deactivated successfully"
    });

  } catch (error) {
    console.error("Delete employee error:", error);

    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid employee ID"
      });
    }

    res.status(500).json({
      success: false,
      message: "Error deleting employee"
    });
  }
});



module.exports = router;