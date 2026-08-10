// models/CMS_Models/Sales/Address.js
//
// CRMAddress — a postal address for an account, optionally tied to a site. An
// account can hold MANY addresses of different types (registered, office,
// billing, shipping, sampling, inspection) and billing must never be assumed
// identical to shipping — so this is a separate record with one primary per
// (account, type).
const mongoose = require("mongoose");
const { ADDRESS_TYPE_CODES } = require("../../../constants/crm");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
});

const addressSchema = new mongoose.Schema(
  {
    addressId: { type: String, unique: true },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMAccount", required: true, index: true },
    siteId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMSite" },

    addressType: { type: String, enum: ADDRESS_TYPE_CODES, default: "office" },
    recipient: { type: String, trim: true }, // recipient / company line
    addressLine1: { type: String, trim: true },
    addressLine2: { type: String, trim: true },
    city: { type: String, trim: true },
    region: { type: String, trim: true },
    postalCode: { type: String, trim: true },
    country: { type: String, trim: true, default: "India" },
    countryCode: { type: String, trim: true },
    phone: { type: String, trim: true },
    deliveryInstructions: { type: String, trim: true },

    // Only populated if the product already uses maps — kept optional.
    latitude: { type: Number },
    longitude: { type: Number },

    isPrimaryForType: { type: Boolean, default: false },

    createdBy: actorRef(),
    updatedBy: actorRef(),
    archivedAt: { type: Date },
    archivedBy: actorRef(),
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

addressSchema.index({ accountId: 1, addressType: 1, isActive: 1 });

addressSchema.pre("save", async function (next) {
  if (!this.addressId) {
    const count = await mongoose.model("CRMAddress").countDocuments();
    this.addressId = `ADDR-${String(count + 1).padStart(4, "0")}`;
  }
  next();
});

module.exports = mongoose.model("CRMAddress", addressSchema);
