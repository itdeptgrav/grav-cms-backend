const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const vendorSchema = new mongoose.Schema(
  {
    // Basic Information
    name: {
      type: String,
      required: [true, "Vendor name is required"],
      trim: true,
    },
    contactPerson: {
      type: String,
      required: [true, "Contact person is required"],
      trim: true,
    },
    firmType: {
      type: String,
      enum: ["Proprietor", "Partnership", "LLP", "Pvt Ltd", "Other"],
      default: "Proprietor",
    },
    category: {
      type: String,
      enum: [
        "Fabric Supplier",
        "Stitching Unit",
        "Accessory Supplier",
        "Logistics Partner",
        "Printing & Embroidery",
        "Washing & Finishing",
        "Other",
      ],
    },
    productsHandled: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
    },
    phone: {
      type: String,
      required: [true, "Phone number is required"],
      trim: true,
    },
    alternatePhone: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ["active", "inactive", "pending"],
      default: "active",
    },
    rating: {
      type: Number,
      min: 0,
      max: 5,
      default: 0,
    },
    notes: {
      type: String,
      trim: true,
    },

    // Login credentials
    password: {
      type: String,
      required: [true, "Password is required"],
    },
    username: {
      type: String,
      unique: true,
      trim: true,
    },
    vendorCode: {
      type: String,
      unique: true,
      trim: true,
    },

    // Legal & Compliance
    gstNumber: {
      type: String,
      trim: true,
    },
    panNumber: {
      type: String,
      trim: true,
    },
    udyamNumber: {
      type: String,
      trim: true,
    },
    labourLicense: {
      type: String,
      trim: true,
    },
    factoryRegistration: {
      type: String,
      trim: true,
    },
    ownerName: {
      type: String,
      trim: true,
    },
    directorNames: {
      type: String,
      trim: true,
    },
    registeredAddress: {
      type: String,
      trim: true,
    },
    factoryAddress: {
      type: String,
      trim: true,
    },
    lastAudit: Date,
    qualityControl: {
      type: Boolean,
      default: false,
    },
    recordSystem: {
      type: String,
      enum: ["Manual", "Computer", "Hybrid", ""],
    },

    // Factory Details
    factorySize: {
      type: String,
      trim: true,
    },
    productionLines: {
      type: Number,
      min: 0,
    },
    lineLayoutAvailable: {
      type: Boolean,
      default: false,
    },
    cuttingFacility: {
      type: Boolean,
      default: false,
    },
    pressingFacility: {
      type: Boolean,
      default: false,
    },
    packingFacility: {
      type: Boolean,
      default: false,
    },
    totalMachines: {
      type: Number,
      min: 0,
    },
    machineBreakup: {
      type: String,
      trim: true,
    },
    specialMachines: {
      type: String,
      trim: true,
    },
    machineCondition: {
      type: String,
      enum: ["New", "Average", "Old", ""],
    },

    // Manpower & Production
    totalOperators: {
      type: Number,
      min: 0,
    },
    skilledOperators: {
      type: Number,
      min: 0,
    },
    supervisors: {
      type: Number,
      min: 0,
    },
    helpers: {
      type: Number,
      min: 0,
    },
    absenteeismRate: {
      type: String,
      trim: true,
    },
    shifts: {
      type: Number,
      min: 0,
    },
    workingHours: {
      type: String,
      trim: true,
    },
    weeklyOff: {
      type: String,
      trim: true,
    },
    avgProductionPerMachine: {
      type: Number,
      min: 0,
    },
    monthlyProduction: {
      type: Number,
      min: 0,
    },
    rejectionRate: {
      type: String,
      trim: true,
    },
    reworkRate: {
      type: String,
      trim: true,
    },
    overtimeRequired: {
      type: String,
      enum: ["Low", "Medium", "High", ""],
    },
    highestComplexity: {
      type: String,
      trim: true,
    },
    sampleTime: {
      type: String,
      trim: true,
    },
    majorCustomers: {
      type: String,
      trim: true,
    },

    // SAM Capacity
    avgSAM: {
      type: Number,
      min: 0,
    },
    totalMonthlySAM: {
      type: Number,
      min: 0,
    },
    comfortableWorkload: {
      type: Number,
      min: 0,
    },
    maxWorkload: {
      type: Number,
      min: 0,
    },

    // Financial Details
    yearlyTurnover: {
      type: String,
      trim: true,
    },
    monthlyFixedExpenses: {
      type: String,
      trim: true,
    },
    monthlySalaryPayout: {
      type: String,
      trim: true,
    },
    workingCapital: {
      type: String,
      trim: true,
    },
    sustainabilityMonths: {
      type: Number,
      min: 0,
    },
    existingLoans: {
      type: String,
      trim: true,
    },
    workingCapitalPosition: {
      type: String,
      enum: ["Good", "Average", "Tight", ""],
    },
    pastDefaults: {
      type: String,
      trim: true,
    },

    // Business Terms
    leadTime: {
      type: String,
      trim: true,
    },
    paymentTerms: {
      type: String,
      enum: ["Net 15", "Net 30", "Net 45", "Net 60", "COD", ""],
      default: "Net 30",
    },
    bankName: {
      type: String,
      trim: true,
    },
    accountNumber: {
      type: String,
      trim: true,
    },
    ifscCode: {
      type: String,
      trim: true,
    },
    accountHolderName: {
      type: String,
      trim: true,
    },
    address: {
      type: String,
      trim: true,
    },
    city: {
      type: String,
      trim: true,
    },
    state: {
      type: String,
      trim: true,
    },
    pincode: {
      type: String,
      trim: true,
    },

    // Documents (Cloudinary URLs)
    documents: {
      // Document numbers
      aadharNumber: {
        type: String,
        trim: true,
      },
      aadharFile: {
        url: String,
        publicId: String,
      },
      panFile: {
        url: String,
        publicId: String,
      },
      gstCertificate: {
        url: String,
        publicId: String,
      },
      udyamCertificate: {
        url: String,
        publicId: String,
      },
      labourLicenseCopy: {
        url: String,
        publicId: String,
      },
      bankCheque: {
        url: String,
        publicId: String,
      },
      profileImage: {
        url: String,
        publicId: String,
      },
      additionalDocuments: [
        {
          title: String,
          url: String,
          publicId: String,
          uploadedAt: {
            type: Date,
            default: Date.now,
          },
        },
      ],
    },

    // Performance Metrics
    totalOrders: {
      type: Number,
      default: 0,
    },
    lastOrder: Date,
    averageOrderValue: {
      type: Number,
      default: 0,
    },
    onTimeDelivery: {
      type: Number, // percentage
      min: 0,
      max: 100,
      default: 0,
    },

    // Timestamps
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  },
);

// Generate vendor code before saving
vendorSchema.pre("save", function (next) {
  if (!this.vendorCode) {
    const prefix = "VEND";
    const randomNum = Math.floor(1000 + Math.random() * 9000);
    const year = new Date().getFullYear().toString().slice(-2);
    this.vendorCode = `${prefix}${year}${randomNum}`;
  }

  if (!this.username && this.email) {
    // Generate username from email (first part before @)
    this.username = this.email.split("@")[0];
  }

  next();
});

// Hash password before saving
vendorSchema.pre("save", async function (next) {
  // Only hash the password if it has been modified (or is new)
  if (!this.isModified("password")) return next();

  try {
    // Generate salt
    const salt = await bcrypt.genSalt(10);
    // Hash password
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Method to compare password
vendorSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Indexes for better query performance
vendorSchema.index({ name: 1 });
vendorSchema.index({ category: 1 });
vendorSchema.index({ status: 1 });
vendorSchema.index({ gstNumber: 1 });
vendorSchema.index({ vendorCode: 1 });
vendorSchema.index({ email: 1 });
vendorSchema.index({ createdAt: -1 });

// Soft delete middleware
vendorSchema.pre(/^find/, function (next) {
  if (!this.getOptions().includeDeleted) {
    this.where({ isDeleted: false });
  }
  next();
});

module.exports = mongoose.model("VendorDetails", vendorSchema);
