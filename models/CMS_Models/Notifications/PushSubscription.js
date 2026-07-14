// models/CMS_Models/Notifications/PushSubscription.js
const mongoose = require("mongoose");

const pushSubscriptionSchema = new mongoose.Schema(
  {
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth:   { type: String, required: true },
    },
    // Who this browser belongs to
    userRef:   { type: mongoose.Schema.Types.ObjectId, default: null },
    userName:  { type: String, default: "" },
    // Role decides broadcast targeting: "projectManager", "store", "admin", "employee", …
    role:      { type: String, default: "", index: true },
    userAgent: { type: String, default: "" },
    lastUsedAt:{ type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.PushSubscription ||
  mongoose.model("PushSubscription", pushSubscriptionSchema);