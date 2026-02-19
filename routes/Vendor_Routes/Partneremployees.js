const express = require("express");
const router = express.Router();
const PartnerEmployee = require("../../models/Vendor_Models/PartnerEmployee");
const VendorAuthMiddleware = require("../../Middlewear/VendorAuthMiddleware");

// CREATE new operator
router.post("/", VendorAuthMiddleware, async (req, res) => {
  try {
    const { vendor } = req;
    const { name, email, phone, gender, biometricId, identityId } = req.body;

    // Validate required fields
    if (!name || !email || !phone || !gender || !biometricId) {
      return res.status(400).json({
        success: false,
        message: "Name, email, phone, gender, and biometric ID are required",
      });
    }

    // Create new operator
    const newOperator = new PartnerEmployee({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      phone: phone.trim(),
      gender,
      biometricId: biometricId.trim(),
      identityId: identityId ? identityId.trim() : undefined,
      createdBy: vendor.id,
    });

    await newOperator.save();

    res.status(201).json({
      success: true,
      message: "Operator created successfully",
      data: newOperator,
    });
  } catch (error) {
    console.error("Create operator error:", error);

    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(400).json({
        success: false,
        message: `${field === "biometricId" ? "Biometric ID" : field === "email" ? "Email" : field} already exists`,
      });
    }

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
      message: "Error creating operator",
    });
  }
});

// GET all operators
router.get("/", VendorAuthMiddleware, async (req, res) => {
  try {
    const { vendor } = req;
    const { page = 1, limit = 10, search, status } = req.query;

    // Build filter
    const filter = { createdBy: vendor.id };

    if (status && status !== "all") {
      filter.isActive = status === "active";
    }

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { biometricId: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (page - 1) * limit;

    const [operators, total] = await Promise.all([
      PartnerEmployee.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      PartnerEmployee.countDocuments(filter),
    ]);

    const totalPages = Math.ceil(total / limit);

    res.status(200).json({
      success: true,
      data: {
        operators,
        pagination: {
          currentPage: parseInt(page),
          totalPages,
          totalOperators: total,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
      },
    });
  } catch (error) {
    console.error("Get operators error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching operators",
    });
  }
});

// GET single operator by ID
router.get("/:id", VendorAuthMiddleware, async (req, res) => {
  try {
    const { vendor } = req;
    const { id } = req.params;

    const operator = await PartnerEmployee.findOne({
      _id: id,
      createdBy: vendor.id,
    })
      .populate("createdBy", "name email")
      .lean();

    if (!operator) {
      return res.status(404).json({
        success: false,
        message: "Operator not found",
      });
    }

    res.status(200).json({
      success: true,
      data: operator,
    });
  } catch (error) {
    console.error("Get operator error:", error);

    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid operator ID",
      });
    }

    res.status(500).json({
      success: false,
      message: "Error fetching operator",
    });
  }
});

// UPDATE operator
router.put("/:id", VendorAuthMiddleware, async (req, res) => {
  try {
    const { vendor } = req;
    const { id } = req.params;
    const { name, email, phone, gender, biometricId, identityId } = req.body;

    // Find operator and verify ownership
    const operator = await PartnerEmployee.findOne({
      _id: id,
      createdBy: vendor.id,
    });

    if (!operator) {
      return res.status(404).json({
        success: false,
        message: "Operator not found",
      });
    }

    // Update fields
    if (name) operator.name = name.trim();
    if (email) operator.email = email.toLowerCase().trim();
    if (phone) operator.phone = phone.trim();
    if (gender) operator.gender = gender;
    if (biometricId) operator.biometricId = biometricId.trim();
    if (identityId !== undefined)
      operator.identityId = identityId ? identityId.trim() : undefined;

    await operator.save();

    res.status(200).json({
      success: true,
      message: "Operator updated successfully",
      data: operator,
    });
  } catch (error) {
    console.error("Update operator error:", error);

    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(400).json({
        success: false,
        message: `${field === "biometricId" ? "Biometric ID" : field === "email" ? "Email" : field} already exists`,
      });
    }

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
      message: "Error updating operator",
    });
  }
});

// DELETE operator (soft delete)
router.delete("/:id", VendorAuthMiddleware, async (req, res) => {
  try {
    const { vendor } = req;
    const { id } = req.params;

    const operator = await PartnerEmployee.findOne({
      _id: id,
      createdBy: vendor.id,
    });

    if (!operator) {
      return res.status(404).json({
        success: false,
        message: "Operator not found",
      });
    }

    operator.isActive = false;
    await operator.save();

    res.status(200).json({
      success: true,
      message: "Operator deactivated successfully",
    });
  } catch (error) {
    console.error("Delete operator error:", error);

    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid operator ID",
      });
    }

    res.status(500).json({
      success: false,
      message: "Error deleting operator",
    });
  }
});

// ACTIVATE operator
router.patch("/:id/activate", VendorAuthMiddleware, async (req, res) => {
  try {
    const { vendor } = req;
    const { id } = req.params;

    const operator = await PartnerEmployee.findOne({
      _id: id,
      createdBy: vendor.id,
    });

    if (!operator) {
      return res.status(404).json({
        success: false,
        message: "Operator not found",
      });
    }

    operator.isActive = true;
    await operator.save();

    res.status(200).json({
      success: true,
      message: "Operator activated successfully",
      data: operator,
    });
  } catch (error) {
    console.error("Activate operator error:", error);
    res.status(500).json({
      success: false,
      message: "Error activating operator",
    });
  }
});

module.exports = router;