// models/Accountant_model/Acc_BackupModels.js
//
// Backup subsystem models. Two collections:
//
//   acc_backup_config   — a SINGLETON holding the schedule + last-run status.
//                         One row for the whole deployment (mirrors the
//                         Acc_Settings.getSingleton() pattern already used
//                         elsewhere).
//
//   acc_backup_records  — history. One row per backup attempt, with the
//                         Google Drive file id so the file can be downloaded
//                         or restored later.
//
// Both are deliberately small and self-contained — the backup feature does
// not touch the Organization / Settings schemas.

const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────
// Acc_BackupConfig — singleton schedule + status
// ─────────────────────────────────────────────────────────────────────────
const backupConfigSchema = new mongoose.Schema(
  {
    // Always "global" — there is exactly one config row.
    singletonKey: {
      type: String,
      default: "global",
      unique: true,
      index: true,
    },

    // off     → no automatic backups (manual "Back up now" still works)
    // daily   → roughly every 24h (best-effort, see scheduler)
    // weekly  → roughly every 7 days
    frequency: {
      type: String,
      enum: ["off", "daily", "weekly"],
      default: "off",
    },

    // How many backup files to keep in Drive. Older ones are pruned after a
    // successful new backup. 0 = keep everything.
    retentionCount: { type: Number, default: 14 },

    lastRunAt: { type: Date },
    lastStatus: {
      type: String,
      enum: ["success", "failed", "never"],
      default: "never",
    },
    lastError: { type: String, default: "" },
    lastFileId: { type: String, default: "" },

    // ── Backup destination ────────────────────────────────────────────────
    // "service" → the server's own service account (GOOGLE_SERVICE_ACCOUNT_KEY)
    // "oauth"   → the user's OWN Google account, connected via the Connect
    //             button. Files land in THEIR Drive, owned by THEM.
    driveMode: {
      type: String,
      enum: ["service", "oauth"],
      default: "service",
    },
    googleConnected: { type: Boolean, default: false },
    googleEmail: { type: String, default: "" },
    // The Google refresh token. NOTE: deliberately excluded from backups (see
    // accountantBackup.service.js) so it never lands inside a backup file.
    googleRefreshToken: { type: String, default: "" },
    googleConnectedByName: { type: String, default: "" },
    googleConnectedAt: { type: Date },

    updatedByName: { type: String, default: "" },
  },
  { timestamps: true, collection: "acc_backup_config" },
);

backupConfigSchema.statics.getSingleton = async function () {
  let cfg = await this.findOne({ singletonKey: "global" });
  if (!cfg) {
    cfg = await this.create({ singletonKey: "global" });
  }
  return cfg;
};

// ─────────────────────────────────────────────────────────────────────────
// Acc_BackupRecord — one row per backup attempt
// ─────────────────────────────────────────────────────────────────────────
const backupRecordSchema = new mongoose.Schema(
  {
    fileId: { type: String, default: "" }, // Google Drive file id
    fileName: { type: String, default: "" },
    sizeBytes: { type: Number, default: 0 },
    totalDocs: { type: Number, default: 0 },
    collections: [
      {
        name: { type: String },
        count: { type: Number },
        _id: false,
      },
    ],

    // manual      → owner clicked "Back up now"
    // scheduled   → in-process scheduler fired
    // cron        → external cron hit the /cron endpoint
    // pre-restore → automatic safety snapshot taken right before a restore
    trigger: {
      type: String,
      enum: ["manual", "scheduled", "cron", "pre-restore"],
      default: "manual",
    },

    status: {
      type: String,
      enum: ["success", "failed"],
      default: "success",
    },
    error: { type: String, default: "" },
    createdByName: { type: String, default: "" },
  },
  { timestamps: true, collection: "acc_backup_records" },
);

backupRecordSchema.index({ createdAt: -1 });

const Acc_BackupConfig =
  mongoose.models.Acc_BackupConfig ||
  mongoose.model("Acc_BackupConfig", backupConfigSchema);

const Acc_BackupRecord =
  mongoose.models.Acc_BackupRecord ||
  mongoose.model("Acc_BackupRecord", backupRecordSchema);

module.exports = { Acc_BackupConfig, Acc_BackupRecord };
