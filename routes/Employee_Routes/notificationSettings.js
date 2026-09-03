// routes/Employee_Routes/notificationSettings.js
//
// "Manage notifications" — read and write, per device.
//
// Mounted for the mobile app and the browser alike; they are the same person
// with different devices, and that is the whole point. A device identifies
// itself by its push token, which is the only thing both platforms already
// have and the only thing the transport actually addresses.

"use strict";

const express = require("express");
/* The handlers, with no session reader of their own: mounted below behind
   the app's middleware, and by routes/Access/changeRequests behind the CMS
   session. Both set req.user = { id, email }, which is all these read. */
const handlers = express.Router();

const AllEmployeeAppMiddleware = require("../../Middlewear/AllEmployeeAppMiddleware");
const NotificationDevice = require("../../models/Access/NotificationDevice");
const { listTypes, getType, defaultPrefs } = require("../../services/notificationTypes");
const { registerDevice, ownerFilter } = require("../../services/notifyDevices.service");

const DEFAULTS = defaultPrefs();

/** The stored answers merged over the registry's defaults. */
function shapePrefs(device) {
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const stored = device?.prefs?.get?.(key);
    out[key] = {
      enabled: stored?.enabled ?? fallback.enabled,
      repeat: stored?.repeat ?? fallback.repeat,
    };
  }
  return out;
}

function shapeDevice(d, currentToken) {
  return {
    id: String(d._id),
    platform: d.platform,
    transport: d.transport,
    label: d.label || "",
    enabled: d.enabled !== false,
    prefs: shapePrefs(d),
    lastSeenAt: d.lastSeenAt,
    /* So the screen can say "this device" instead of listing three identical
       rows and leaving somebody to guess which one they are holding. */
    isThisDevice: Boolean(currentToken) && d.token === currentToken,
  };
}

/**
 * POST /register — this device would like to receive notifications.
 *
 * Idempotent on the token. Re-registering refreshes the row and never resets
 * preferences: signing in again must not silently switch somebody's
 * notifications back on.
 */
handlers.post("/register", async (req, res) => {
  try {
    const { token, transport, platform, label } = req.body || {};
    if (!token || !transport) {
      return res.status(400).json({
        success: false,
        message: "A push token and its transport are both required.",
      });
    }
    const device = await registerDevice({
      employeeId: req.user.id,
      employeeEmail: req.user.email,
      token,
      transport,
      platform,
      label,
    });
    res.json({ success: true, data: shapeDevice(device, token) });
  } catch (err) {
    console.error("[notification-settings] register:", err.message);
    res.status(500).json({ success: false, message: "Could not register this device." });
  }
});

/**
 * GET / — the settings screen's whole payload.
 *
 * The catalogue of types AND this person's devices, so the screen renders
 * without a second round trip and cannot show a toggle for something that is
 * not sent.
 */
handlers.get("/", async (req, res) => {
  try {
    const currentToken = String(req.query.token || "");
    const devices = await NotificationDevice.find(ownerFilter(req.user))
      .sort({ lastSeenAt: -1 })
      .lean({ getters: false });

    /* `.lean()` gives plain objects, so the Map is a plain object too — shape
       it through the same merge either way. */
    const shaped = devices.map((d) => ({
      ...shapeDevice({ ...d, prefs: { get: (k) => d.prefs?.[k] } }, currentToken),
    }));

    res.json({
      success: true,
      types: listTypes(),
      devices: shaped,
      /* Named so the screen can explain the default rather than leaving
         somebody to wonder why nothing repeats. */
      repeatIntervalHours: 1,
    });
  } catch (err) {
    console.error("[notification-settings] get:", err.message);
    res.status(500).json({ success: false, message: "Could not load your notification settings." });
  }
});

/**
 * PUT /:deviceId — change one device's answers.
 *
 * Scoped to the caller's own devices. A device id is not a secret, and without
 * the ownership check one person could mute another's phone.
 */
handlers.put("/:deviceId", async (req, res) => {
  try {
    const device = await NotificationDevice.findOne({
      _id: req.params.deviceId,
      ...ownerFilter(req.user),
    });
    if (!device) {
      return res.status(404).json({ success: false, message: "That device is not yours." });
    }

    if (typeof req.body?.enabled === "boolean") device.enabled = req.body.enabled;

    const incoming = req.body?.prefs;
    if (incoming && typeof incoming === "object") {
      for (const [key, value] of Object.entries(incoming)) {
        const typeDef = getType(key);
        /* Unknown keys are dropped rather than stored: the settings screen can
           only offer what the registry describes, so anything else is either a
           stale client or somebody probing. */
        if (!typeDef) continue;
        const current = device.prefs.get(key) || DEFAULTS[key];
        device.prefs.set(key, {
          enabled:
            typeof value?.enabled === "boolean" ? value.enabled : current.enabled,
          /* A type that cannot repeat cannot be made to. Enforced here and not
             only in the UI, because "every hour, forever, about something that
             already happened" is the one setting nobody would want and nobody
             could explain afterwards. */
          repeat: typeDef.repeatable
            ? typeof value?.repeat === "boolean" ? value.repeat : current.repeat
            : false,
        });
      }
      device.markModified("prefs");
    }

    await device.save();
    res.json({ success: true, data: shapeDevice(device, req.query.token) });
  } catch (err) {
    console.error("[notification-settings] put:", err.message);
    res.status(500).json({ success: false, message: "Could not save those settings." });
  }
});

/** DELETE /:deviceId — stop notifications to a device entirely. */
handlers.delete("/:deviceId", async (req, res) => {
  try {
    const gone = await NotificationDevice.deleteOne({
      _id: req.params.deviceId,
      ...ownerFilter(req.user),
    });
    if (!gone.deletedCount) {
      return res.status(404).json({ success: false, message: "That device is not yours." });
    }
    res.json({ success: true, message: "That device will not be notified again." });
  } catch (err) {
    console.error("[notification-settings] delete:", err.message);
    res.status(500).json({ success: false, message: "Could not remove that device." });
  }
});

const router = express.Router();
router.use(AllEmployeeAppMiddleware, handlers);

module.exports = router;
module.exports.handlers = handlers;
