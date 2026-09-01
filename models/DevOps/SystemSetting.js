// models/DevOps/SystemSetting.js
//
// One tunable value, changeable from /developer/settings without a deploy.
//
// This exists because "change a little thing" kept meaning "edit code, restart
// the server": an anomaly threshold, a working-hours window, a feature that
// needed switching off for a day. The catalogue of keys — what exists, its
// type, its default — lives in code (services/devConfig.js DEFINITIONS), so a
// setting cannot be invented from the UI; only its VALUE lives here. A store
// whose keys are also data is a store full of typos that read as defaults.
//
// Every change carries who and when, and the last few values ride along on the
// row itself — enough to answer "who turned this off" without a join, while
// the full trail still goes through change_logs like any other edit.

"use strict";

const mongoose = require("mongoose");

const systemSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: mongoose.Schema.Types.Mixed },

    updatedByEmail: { type: String, default: "", lowercase: true },
    updatedByName: { type: String, default: "" },

    // Newest first, capped at 20 by the writer — a convenience trail, not the
    // audit record.
    history: {
      type: [
        {
          _id: false,
          at: Date,
          byEmail: String,
          byName: String,
          from: mongoose.Schema.Types.Mixed,
          to: mongoose.Schema.Types.Mixed,
        },
      ],
      default: [],
    },
  },
  { timestamps: true, collection: "system_settings" },
);

module.exports =
  mongoose.models.SystemSetting ||
  mongoose.model("SystemSetting", systemSettingSchema, "system_settings");
