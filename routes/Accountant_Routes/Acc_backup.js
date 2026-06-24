// routes/Accountant_Routes/Acc_backup.js
//
// Mounted at: /api/accountant/backup
//
// Endpoints
//   POST /cron?secret=...      — PUBLIC (secret-gated). Runs a backup if one
//                                is due. Point an external cron service here
//                                for reliable scheduling on sleepy hosts.
//   --- everything below requires accountantAuth + canManageSettings ---
//   GET  /config               — schedule + last-run status + recent history
//   PUT  /config               — set frequency / retentionCount
//   POST /run                  — back up now (manual)
//   GET  /records              — backup history
//   GET  /drive-files          — backup files listed straight from Drive
//                                (works even if the DB is empty)
//   GET  /download/:fileId     — stream a backup file for offline keeping
//   POST /restore              — restore a backup (gated by confirm text;
//                                takes a pre-restore safety snapshot first)
//   POST /test                 — verify the Drive service account works
//
// AUTH CHOICE
//   Uses the legacy `accountantAuth`, which verifies the JWT WITHOUT a DB
//   lookup. That matters: restore must work even when the database has been
//   wiped (orgAuth would fail because it reads the user from Mongo).
//
// The scheduler self-starts the first time this file is required.

const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");

const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");
const backupService = require("../../services/accountantBackup.service");
const backupScheduler = require("../../services/accountantBackupScheduler");
const {
  Acc_BackupConfig,
  Acc_BackupRecord,
} = require("../../models/Accountant_model/Acc_BackupModels");

// Start the in-process scheduler once (best-effort automatic backups).
try {
  backupScheduler.start();
} catch (e) {
  console.error("[backup] scheduler failed to start:", e.message);
}

// ─────────────────────────────────────────────────────────────────────────
// PUBLIC — external cron trigger (secret-gated). Defined BEFORE the auth
// middleware so it isn't blocked. Same pattern as the Setu /webhook route.
// ─────────────────────────────────────────────────────────────────────────
router.post("/cron", async (req, res) => {
  try {
    const secret = req.query.secret || req.get("x-backup-secret");
    const expected = process.env.BACKUP_CRON_SECRET;
    if (!expected) {
      return res.status(503).json({
        success: false,
        message: "BACKUP_CRON_SECRET is not configured on the server.",
      });
    }
    if (secret !== expected) {
      return res.status(401).json({ success: false, message: "Bad secret." });
    }
    // `force=1` runs unconditionally; otherwise only if the schedule says due.
    const force = req.query.force === "1" || req.query.force === "true";
    const result = await backupScheduler.checkAndRun({
      force,
      trigger: "cron",
    });
    res.json({ success: true, ...result });
  } catch (e) {
    console.error("[backup/cron]", e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PUBLIC — Google OAuth callback. Google redirects the browser here after the
// user authorises. It's authorised by the signed `state` token (a top-level
// redirect can't carry a login header), so it's defined BEFORE the auth
// middleware, same as /cron. On success it stores the refresh token and tells
// the popup to close.
// ─────────────────────────────────────────────────────────────────────────
const STATE_SECRET = process.env.JWT_SECRET || "grav-backup-oauth-state";

function closePopupHtml(message) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>GRAV Backup</title></head>
<body style="font-family:system-ui,sans-serif;padding:2rem;color:#0f172a">
<p>${message}</p>
<script>
  try { window.close(); } catch (e) {}
  setTimeout(function(){ document.body.innerHTML += '<p style="color:#64748b">You can close this window and return to Settings.</p>'; }, 400);
</script>
</body></html>`;
}

router.get("/google/callback", async (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const { code, state, error } = req.query;
  try {
    if (error) return res.send(closePopupHtml("Google sign-in was cancelled."));
    if (!code || !state) {
      return res.send(closePopupHtml("Missing authorization code."));
    }
    let decoded;
    try {
      decoded = jwt.verify(String(state), STATE_SECRET);
    } catch (_e) {
      return res.send(
        closePopupHtml("This sign-in link expired. Please connect again."),
      );
    }

    const { tokens, email } = await backupService.exchangeCodeForTokens(
      String(code),
    );

    const cfg = await Acc_BackupConfig.getSingleton();
    if (tokens.refresh_token) cfg.googleRefreshToken = tokens.refresh_token;
    if (!cfg.googleRefreshToken) {
      // No refresh token returned and none stored before — can't run
      // unattended. Happens if the user previously authorised without
      // revoking; they must remove access then reconnect.
      return res.send(
        closePopupHtml(
          "Google didn't return a refresh token. Remove this app under your Google Account → Security → Third-party access, then connect again.",
        ),
      );
    }
    cfg.googleEmail = email || cfg.googleEmail;
    cfg.googleConnected = true;
    cfg.driveMode = "oauth";
    cfg.googleConnectedAt = new Date();
    cfg.googleConnectedByName = decoded?.by || "";
    await cfg.save();

    return res.send(
      closePopupHtml(
        "Connected! Your backups will now be saved to your Google Drive.",
      ),
    );
  } catch (e) {
    console.error("[backup/google/callback]", e.message);
    return res.send(
      closePopupHtml("Couldn't connect Google Drive: " + e.message),
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────
router.use(accountantAuth);

function requireManageSettings(req, res) {
  if (!req.user?.permissions?.canManageSettings) {
    res.status(403).json({
      success: false,
      message: "Only an owner/admin can manage backups.",
    });
    return false;
  }
  return true;
}

// Never send the Google refresh token to the browser.
function safeConfig(cfg) {
  const c = cfg.toObject ? cfg.toObject() : { ...cfg };
  delete c.googleRefreshToken;
  return c;
}

// ── GET /config ──────────────────────────────────────────────────────────
router.get("/config", async (req, res) => {
  try {
    if (!requireManageSettings(req, res)) return;
    const config = await Acc_BackupConfig.getSingleton();
    const records = await Acc_BackupRecord.find({})
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({ success: true, config: safeConfig(config), records });
  } catch (e) {
    console.error("[backup/config GET]", e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── PUT /config ──────────────────────────────────────────────────────────
router.put("/config", async (req, res) => {
  try {
    if (!requireManageSettings(req, res)) return;
    const { frequency, retentionCount, driveMode } = req.body || {};
    const config = await Acc_BackupConfig.getSingleton();

    if (frequency !== undefined) {
      if (!["off", "daily", "weekly"].includes(frequency)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid frequency." });
      }
      config.frequency = frequency;
    }
    if (retentionCount !== undefined) {
      const n = Number(retentionCount);
      if (!Number.isFinite(n) || n < 0 || n > 1000) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid retention count." });
      }
      config.retentionCount = Math.floor(n);
    }
    if (driveMode !== undefined) {
      if (!["service", "oauth"].includes(driveMode)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid backup destination." });
      }
      if (driveMode === "oauth" && !config.googleConnected) {
        return res.status(400).json({
          success: false,
          message: "Connect a Google account first.",
        });
      }
      config.driveMode = driveMode;
    }
    config.updatedByName = req.user?.name || "";
    await config.save();
    res.json({ success: true, config: safeConfig(config) });
  } catch (e) {
    console.error("[backup/config PUT]", e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST /run — back up now ──────────────────────────────────────────────
router.post("/run", async (req, res) => {
  try {
    if (!requireManageSettings(req, res)) return;
    const record = await backupService.runBackup({
      trigger: "manual",
      byName: req.user?.name || "",
    });
    res.json({ success: true, record: record.toObject() });
  } catch (e) {
    console.error("[backup/run]", e.message);
    res.status(500).json({
      success: false,
      message:
        "Backup failed: " +
        e.message +
        " — check the Google Drive service-account configuration.",
    });
  }
});

// ── GET /records — history ───────────────────────────────────────────────
router.get("/records", async (req, res) => {
  try {
    if (!requireManageSettings(req, res)) return;
    const records = await Acc_BackupRecord.find({})
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    res.json({ success: true, records });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /drive-files — list backup files directly from Drive ─────────────
// Works even when the database is empty (records gone). This is the list to
// restore from after a wipe.
router.get("/drive-files", async (req, res) => {
  try {
    if (!requireManageSettings(req, res)) return;
    const files = await backupService.listDriveBackups();
    res.json({ success: true, files });
  } catch (e) {
    console.error("[backup/drive-files]", e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /download/:fileId — stream a backup for offline keeping ──────────
router.get("/download/:fileId", async (req, res) => {
  try {
    if (!requireManageSettings(req, res)) return;
    const { fileId } = req.params;
    const { stream, meta } = await backupService.streamDriveFile(fileId);

    const safeName = String(meta.name || "backup.json.gz").replace(
      /["\r\n]/g,
      "",
    );
    res.setHeader("Content-Type", meta.mimeType || "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    if (meta.size) res.setHeader("Content-Length", meta.size);

    stream.on("error", (err) => {
      console.error("[backup/download] stream error:", err.message);
      if (!res.headersSent) res.status(500).json({ error: err.message });
      else res.end();
    });
    stream.pipe(res);
  } catch (e) {
    console.error("[backup/download]", e.message);
    if (!res.headersSent)
      res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST /restore — restore a backup ─────────────────────────────────────
// Body: { fileId, mode, confirm }
//   mode = "merge"   → upsert by _id (safe). confirm must equal "RESTORE".
//   mode = "replace" → wipe each collection then reinsert (destructive).
//                      confirm must equal "REPLACE-EVERYTHING".
// A pre-restore safety snapshot is taken first (without pruning), so the
// current state is captured before anything changes.
router.post("/restore", async (req, res) => {
  try {
    if (!requireManageSettings(req, res)) return;
    const { fileId, mode = "merge", confirm } = req.body || {};

    if (!fileId) {
      return res
        .status(400)
        .json({ success: false, message: "fileId is required." });
    }
    if (!["merge", "replace"].includes(mode)) {
      return res.status(400).json({ success: false, message: "Invalid mode." });
    }
    const need = mode === "replace" ? "REPLACE-EVERYTHING" : "RESTORE";
    if (confirm !== need) {
      return res.status(400).json({
        success: false,
        message: `Confirmation text must be exactly "${need}".`,
        requiredConfirm: need,
      });
    }

    // 1) Safety snapshot of the CURRENT state first (no pruning, so we never
    //    delete the file we're about to restore).
    let snapshot = null;
    try {
      snapshot = await backupService.runBackup({
        trigger: "pre-restore",
        byName: req.user?.name || "",
        prune: false,
      });
    } catch (snapErr) {
      return res.status(500).json({
        success: false,
        message:
          "Aborted: couldn't take a safety snapshot before restoring (" +
          snapErr.message +
          "). Nothing was changed.",
      });
    }

    // 2) Restore.
    const result = await backupService.restoreFromDrive(fileId, { mode });

    res.json({
      success: true,
      result,
      safetySnapshotFileId: snapshot?.fileId || null,
    });
  } catch (e) {
    console.error("[backup/restore]", e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST /test — verify Drive connectivity ───────────────────────────────
router.post("/test", async (req, res) => {
  try {
    if (!requireManageSettings(req, res)) return;
    const out = await backupService.testDriveConnection();
    res.json({ success: true, ...out });
  } catch (e) {
    console.error("[backup/test]", e.message);
    res.status(500).json({
      success: false,
      message:
        "Drive connection failed: " +
        e.message +
        " — check GOOGLE_SERVICE_ACCOUNT_KEY.",
    });
  }
});

// ── GET /google/auth-url — start the Connect-your-Google-Drive flow ──────
router.get("/google/auth-url", async (req, res) => {
  try {
    if (!requireManageSettings(req, res)) return;
    const state = jwt.sign(
      { p: "backup-oauth", by: req.user?.name || "" },
      STATE_SECRET,
      { expiresIn: "10m" },
    );
    const url = backupService.buildAuthUrl(state);
    res.json({ success: true, url });
  } catch (e) {
    console.error("[backup/google/auth-url]", e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST /google/disconnect — drop the connected account ─────────────────
router.post("/google/disconnect", async (req, res) => {
  try {
    if (!requireManageSettings(req, res)) return;
    const config = await Acc_BackupConfig.getSingleton();
    const oldToken = config.googleRefreshToken;
    config.googleConnected = false;
    config.googleEmail = "";
    config.googleRefreshToken = "";
    config.googleConnectedByName = "";
    config.googleConnectedAt = null;
    config.driveMode = "service"; // fall back to the server account
    await config.save();
    // Best-effort revoke at Google's end.
    backupService.revokeGoogleToken(oldToken).catch(() => {});
    res.json({ success: true, config: safeConfig(config) });
  } catch (e) {
    console.error("[backup/google/disconnect]", e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
