const express = require("express");
const router = express.Router();
const Vendor = require("../../models/Vendor_Models/vendor");
const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");
const VendorAuthMiddleware = require("../../Middlewear/VendorAuthMiddleware");

// Apply authentication middleware to all routes
router.use(EmployeeAuthMiddleware);

// Helper function to generate password
const generatePassword = (email) => {
  if (!email) {
    // Generate random password if no email
    const randomStr = Math.random().toString(36).slice(-8);
    return `${randomStr}@grav.vendor`;
  }

  // Take first 3 characters of email + @grav.vendor
  const emailPrefix = email.split("@")[0].toLowerCase();
  const firstThree = emailPrefix.slice(0, 3);
  return `${firstThree}@grav.vendor`;
};

// ✅ GET all vendors with filtering
router.get("/", async (req, res) => {
  try {
    const {
      search,
      status,
      category,
      page = 1,
      limit = 10,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    // Build query
    const query = {};

    // Search filter
    if (search) {
      const searchRegex = new RegExp(search, "i");
      query.$or = [
        { name: searchRegex },
        { contactPerson: searchRegex },
        { email: searchRegex },
        { phone: searchRegex },
        { gstNumber: searchRegex },
        { vendorCode: searchRegex },
      ];
    }

    // Status filter
    if (status && status !== "all") {
      query.status = status;
    }

    // Category filter
    if (category && category !== "all") {
      query.category = category;
    }

    // Calculate pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Execute query with pagination
    const vendors = await Vendor.find(query)
      .sort({ [sortBy]: sortOrder === "desc" ? -1 : 1 })
      .skip(skip)
      .limit(parseInt(limit))
      .select("-password -__v")
      .lean();

    // Get total count for pagination
    const total = await Vendor.countDocuments(query);

    // Get stats
    const stats = await Vendor.aggregate([
      { $match: query },
      {
        $group: {
          _id: null,
          totalVendors: { $sum: 1 },
          activeVendors: {
            $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] },
          },
          totalOrders: { $sum: "$totalOrders" },
          avgRating: { $avg: "$rating" },
        },
      },
    ]);

    res.status(200).json({
      success: true,
      data: vendors,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
      stats: stats[0] || {
        totalVendors: 0,
        activeVendors: 0,
        totalOrders: 0,
        avgRating: 0,
      },
    });
  } catch (error) {
    console.error("Error fetching vendors:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching vendors",
    });
  }
});

// ✅ GET single vendor by ID
router.get("/:id", async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id)
      .select("-password -__v")
      .lean();

    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    res.status(200).json({
      success: true,
      data: vendor,
    });
  } catch (error) {
    console.error("Error fetching vendor:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching vendor",
    });
  }
});

// ✅ CREATE new vendor
router.post("/", async (req, res) => {
  try {
    const vendorData = req.body;

    // Check if vendor already exists with same GST or PAN or email
    if (vendorData.gstNumber) {
      const existingByGST = await Vendor.findOne({
        gstNumber: vendorData.gstNumber,
      });
      if (existingByGST) {
        return res.status(400).json({
          success: false,
          message: "Vendor with this GST number already exists",
        });
      }
    }

    if (vendorData.email) {
      const existingByEmail = await Vendor.findOne({
        email: vendorData.email.toLowerCase(),
      });
      if (existingByEmail) {
        return res.status(400).json({
          success: false,
          message: "Vendor with this email already exists",
        });
      }
    }

    // Generate password automatically
    const generatedPassword = generatePassword(vendorData.email);

    // Create vendor with auto-generated password
    const vendor = new Vendor({
      ...vendorData,
      password: generatedPassword, // Auto-generated password
      username: vendorData.email ? vendorData.email.split("@")[0] : undefined,
    });

    await vendor.save();

    // Return vendor without password
    const vendorResponse = await Vendor.findById(vendor._id)
      .select("-password -__v")
      .lean();

    res.status(201).json({
      success: true,
      message: "Vendor created successfully",
      data: vendorResponse,
      credentials: {
        username: vendor.email || vendor.username,
        password: generatedPassword,
        note: "Auto-generated password. Vendor should change it on first login.",
      },
    });
  } catch (error) {
    console.error("Error creating vendor:", error);

    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(400).json({
        success: false,
        message: `${field} already exists`,
      });
    }

    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((err) => err.message);
      return res.status(400).json({
        success: false,
        message: "Validation error",
        errors: messages,
      });
    }

    res.status(500).json({
      success: false,
      message: "Server error while creating vendor",
    });
  }
});

// ✅ UPDATE vendor
router.put("/:id", async (req, res) => {
  try {
    const vendorId = req.params.id;
    const updateData = req.body;

    // Check if vendor exists
    const existingVendor = await Vendor.findById(vendorId);
    if (!existingVendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    // Check for duplicates (excluding current vendor)
    if (updateData.email && updateData.email !== existingVendor.email) {
      const duplicateEmail = await Vendor.findOne({
        email: updateData.email.toLowerCase(),
        _id: { $ne: vendorId },
      });
      if (duplicateEmail) {
        return res.status(400).json({
          success: false,
          message: "Another vendor with this email already exists",
        });
      }
    }

    if (
      updateData.gstNumber &&
      updateData.gstNumber !== existingVendor.gstNumber
    ) {
      const duplicateGST = await Vendor.findOne({
        gstNumber: updateData.gstNumber,
        _id: { $ne: vendorId },
      });
      if (duplicateGST) {
        return res.status(400).json({
          success: false,
          message: "Another vendor with this GST number already exists",
        });
      }
    }

    // Update vendor
    const updatedVendor = await Vendor.findByIdAndUpdate(
      vendorId,
      { ...updateData, updatedAt: Date.now() },
      { new: true, runValidators: true },
    ).select("-password -__v");

    res.status(200).json({
      success: true,
      message: "Vendor updated successfully",
      data: updatedVendor,
    });
  } catch (error) {
    console.error("Error updating vendor:", error);

    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(400).json({
        success: false,
        message: `${field} already exists`,
      });
    }

    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((err) => err.message);
      return res.status(400).json({
        success: false,
        message: "Validation error",
        errors: messages,
      });
    }

    res.status(500).json({
      success: false,
      message: "Server error while updating vendor",
    });
  }
});

// ✅ DELETE vendor (soft delete)
router.delete("/:id", async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id);

    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    // Soft delete by marking as deleted
    vendor.isDeleted = true;
    await vendor.save();

    res.status(200).json({
      success: true,
      message: "Vendor deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting vendor:", error);
    res.status(500).json({
      success: false,
      message: "Server error while deleting vendor",
    });
  }
});

// ✅ Quick add vendor (basic info only)
router.post("/quick-add", async (req, res) => {
  try {
    const { name, contactPerson, phone, email, category } = req.body;

    if (!name || !contactPerson || !phone) {
      return res.status(400).json({
        success: false,
        message: "Name, contact person, and phone are required",
      });
    }

    // Check for existing vendor with same email
    if (email) {
      const existingVendor = await Vendor.findOne({
        email: email.toLowerCase(),
      });
      if (existingVendor) {
        return res.status(400).json({
          success: false,
          message: "Vendor with this email already exists",
        });
      }
    }

    // Generate password
    const generatedPassword = generatePassword(email);

    const vendorData = {
      name,
      contactPerson,
      phone,
      email: email || "",
      category: category || "Other",
      status: "active",
      notes: "Added via quick add",
      password: generatedPassword,
      username: email ? email.split("@")[0] : undefined,
    };

    const vendor = new Vendor(vendorData);
    await vendor.save();

    // Return without password
    const vendorResponse = await Vendor.findById(vendor._id)
      .select("-password -__v")
      .lean();

    res.status(201).json({
      success: true,
      message: "Vendor added successfully via quick add",
      data: vendorResponse,
      credentials: {
        username: vendor.email || vendor.username,
        password: generatedPassword,
      },
    });
  } catch (error) {
    console.error("Error in quick add vendor:", error);

    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "Vendor with this email already exists",
      });
    }

    res.status(500).json({
      success: false,
      message: "Server error while adding vendor",
    });
  }
});

// ✅ GET vendor dashboard statistics
router.get("/dashboard/stats", async (req, res) => {
  try {
    const stats = await Vendor.aggregate([
      {
        $group: {
          _id: null,
          totalVendors: { $sum: 1 },
          activeVendors: {
            $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] },
          },
          inactiveVendors: {
            $sum: { $cond: [{ $eq: ["$status", "inactive"] }, 1, 0] },
          },
          pendingVendors: {
            $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] },
          },
          totalOrders: { $sum: "$totalOrders" },
          avgRating: { $avg: "$rating" },
        },
      },
    ]);

    // Get category distribution
    const categoryStats = await Vendor.aggregate([
      { $group: { _id: "$category", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    // Get recent activity
    const recentVendors = await Vendor.find({})
      .sort({ createdAt: -1 })
      .limit(5)
      .select("name createdAt status")
      .lean();

    res.status(200).json({
      success: true,
      data: {
        ...(stats[0] || {
          totalVendors: 0,
          activeVendors: 0,
          inactiveVendors: 0,
          pendingVendors: 0,
          totalOrders: 0,
          avgRating: 0,
        }),
        categories: categoryStats,
        recent: recentVendors,
        lastUpdated: new Date(),
      },
    });
  } catch (error) {
    console.error("Error fetching vendor stats:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching vendor statistics",
    });
  }
});

module.exports = router;
