const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const assignedStockItemSchema = new mongoose.Schema(
  {
    stockItemId: { type: mongoose.Schema.Types.ObjectId, ref: "StockItem", required: true },
    stockItemName: { type: String, trim: true },
    stockItemReference: { type: String, trim: true },
    assignedAt: { type: Date, default: Date.now },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: "SalesDepartment" },
    assignedByName: { type: String, trim: true },
    notes: { type: String, trim: true },
  },
  { _id: true }
);

// ── Bank details ─────────────────────────────────────────────────────────
const bankDetailsSchema = new mongoose.Schema(
  {
    accountHolderName: { type: String, trim: true, default: "" },
    accountNumber:     { type: String, trim: true, default: "" },
    ifscCode:          { type: String, trim: true, uppercase: true, default: "" },
    bankName:          { type: String, trim: true, default: "" },
    branchName:        { type: String, trim: true, default: "" },
    upiId:             { type: String, trim: true, default: "" },
  },
  { _id: false }
);

// ── Business info ────────────────────────────────────────────────────────
const businessInfoSchema = new mongoose.Schema(
  {
    businessType:    { type: String, trim: true, default: "" }, // Manufacturer, Retailer, Wholesaler, Distributor, Other
    industryType:    { type: String, trim: true, default: "" }, // Garments, Textiles, Fashion, etc.
    website:         { type: String, trim: true, default: "" },
    yearEstablished: { type: Number, default: null },
    employeeCount:   { type: String, trim: true, default: "" }, // "1-10", "11-50", "51-200", "200+"
  },
  { _id: false }
);

const customerSchema = new mongoose.Schema(
  {
    // ── Auto ID ─────────────────────────────────────────────────────────
    customerId: { type: String },

    // ── Basic Info ───────────────────────────────────────────────────────
    name: { type: String, required: [true, "Name is required"], trim: true },
    email: {
      type: String,
      required: [true, "Email is required"],
      lowercase: true,
      trim: true,
      match: [/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/, "Please enter a valid email"],
    },
    phone:          { type: String, trim: true },
    alternatePhone: { type: String, trim: true, default: "" },

    // ── Auth ─────────────────────────────────────────────────────────────
    password: { type: String, select: false },
    isPhoneVerified: { type: Boolean, default: true },
    isEmailVerified: { type: Boolean, default: false },
    isActive:  { type: Boolean, default: true },
    lastLogin: { type: Date },

    // ── GST (top-level for easy querying) ────────────────────────────────
    gstNumber: { type: String, trim: true, uppercase: true, default: "" },

    // ── Profile ───────────────────────────────────────────────────────────
    profile: {
      avatar:      { type: String, default: null },
      companyName: { type: String, trim: true },
      gstNumber:   { type: String, trim: true },   // kept for backward compat
      address: {
        street:   { type: String, default: null },
        city:     { type: String, default: null },
        state:    { type: String, default: null },
        country:  { type: String, default: "India" },
        pincode:  { type: String, default: null },
        landmark: { type: String, default: null },
      },
      measurements: {
        chest:    { type: Number, default: null },
        waist:    { type: Number, default: null },
        hips:     { type: Number, default: null },
        height:   { type: Number, default: null },
        shoulder: { type: Number, default: null },
        sleeve:   { type: Number, default: null },
      },
      preferences: {
        whatsappNotifications: { type: Boolean, default: true },
        emailNotifications:    { type: Boolean, default: true },
        exclusiveAccess:       { type: Boolean, default: true },
      },
    },

    // ── Bank details (new) ────────────────────────────────────────────────
    bankDetails: { type: bankDetailsSchema, default: () => ({}) },

    // ── Business info (new) ───────────────────────────────────────────────
    businessInfo: { type: businessInfoSchema, default: () => ({}) },

    // ── Sales-side control ────────────────────────────────────────────────
    assignedStockItems: [assignedStockItemSchema],

    passwordResetOTP: {
      hash:      { type: String, default: null, select: false },
      expiresAt: { type: Date, default: null },
      attempts:  { type: Number, default: 0 },
    },

    createdBySales:    { type: Boolean, default: false },
    salesAssignedBy:   { type: mongoose.Schema.Types.ObjectId, ref: "SalesDepartment" },
    salesAssignedByName: { type: String, trim: true },

    // ── Source tracking ───────────────────────────────────────────────────
    leadSource: { type: String, trim: true, default: "self_signup" }, // self_signup, sales_created, referral

    // ── Linked data ───────────────────────────────────────────────────────
    orders:    [{ type: mongoose.Schema.Types.ObjectId, ref: "Order" }],
    cart: [
      {
        product:       { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
        quantity:      { type: Number, default: 1 },
        customization: { type: Map, of: String },
      },
    ],
    favorites: [{ type: mongoose.Schema.Types.ObjectId, ref: "Product" }],
  },
  { timestamps: true }
);

// ── Auto-generate customerId ──────────────────────────────────────────────
customerSchema.pre("save", async function (next) {
  if (!this.customerId) {
    const count = await mongoose.model("Customer").countDocuments();
    this.customerId = `CUST-${String(count + 1).padStart(4, "0")}`;
  }
  if (this.isModified("password") && this.password) {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
  }
  next();
});

customerSchema.methods.comparePassword = async function (candidatePassword) {
  if (!this.password) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

customerSchema.methods.generateAuthToken = function () {
  return jwt.sign(
    { id: this._id, phone: this.phone, email: this.email, name: this.name, role: "customer" },
    process.env.JWT_SECRET || "grav_clothing_secret_key",
    { expiresIn: "7d" }
  );
};

customerSchema.methods.getProfile = function () {
  const profile = this.toObject();
  delete profile.__v;
  delete profile.password;
  delete profile.cart;
  delete profile.orders;
  delete profile.favorites;
  return profile;
};

module.exports = mongoose.model("Customer", customerSchema);