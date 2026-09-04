// models/Access/NotificationDevice.js
//
// One row per DEVICE somebody receives notifications on.
//
// ── WHY THIS HAD TO EXIST BEFORE ANY SETTING COULD ──────────────────────────
// Push tokens lived as two single strings on the employee record —
// `fcmToken` and `pushToken`. One string cannot hold two devices, so a person
// signed in on their phone and on the office browser had whichever registered
// LAST; the other silently stopped receiving anything. Nobody noticed, because
// a notification that does not arrive looks exactly like a notification that
// was never sent.
//
// That also made per-platform settings impossible. "Turn this off on web but
// keep it on my phone" needs somewhere to record a per-device answer, and there
// was one field for the whole person. A setting that cannot be honoured is
// worse than no setting: it is a promise the system quietly breaks, which is
// precisely the failure to avoid here.
//
// So: a row per device, carrying its own preferences. Sends fan out across a
// person's devices; each one is filtered by its own answers.
//
// ── THE TOKEN IS THE IDENTITY ───────────────────────────────────────────────
// A device is identified by its push token, which is what the transport
// actually addresses. Tokens rotate — an app reinstall, a browser clearing site
// data — so a rotated token is simply a new device, and the old one falls away
// when the transport reports it dead. `lastSeenAt` is what distinguishes "a
// device somebody still uses" from "a token nobody has cleaned up".

"use strict";

const mongoose = require("mongoose");
const { defaultPrefs } = require("../../services/notificationTypes");

/** One type's answer on one device. */
const prefSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: true },
    /* Send it again every hour while the thing is still outstanding. Default
       false everywhere — see the note in services/notificationTypes. */
    repeat: { type: Boolean, default: false },
  },
  { _id: false },
);

const notificationDeviceSchema = new mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
      index: true,
    },
    /* Denormalised so a send can filter without a join, and so the row still
       says who it belonged to if the employee record is later removed. */
    employeeEmail: { type: String, default: "", lowercase: true, index: true },

    /* What the transport addresses. Unique: the same token can only ever be one
       device, and a re-registration updates the row rather than adding one. */
    token: { type: String, required: true, unique: true, index: true },

    /* HOW to reach it. `fcm` covers both the browser (via the service worker)
       and the Android build; `expo` is the Expo push service; `webpush` is the
       raw VAPID path. Kept explicit rather than inferred from the token's
       shape, which is a format that changes without warning. */
    transport: {
      type: String,
      enum: ["fcm", "expo", "webpush"],
      required: true,
    },

    /* WHICH PLATFORM, which is what makes "on for Android, off for web" a real
       answer rather than a hope. */
    platform: {
      type: String,
      enum: ["web", "android", "ios", "unknown"],
      default: "unknown",
      index: true,
    },

    /* Something a person recognises in a list of their own devices — "Chrome on
       Windows", "Pixel 7". Without it a settings screen shows three identical
       rows and nobody can tell which one to switch off. */
    label: { type: String, default: "" },

    /* The device's master switch. Off means send nothing here, whatever the
       per-type answers say. */
    enabled: { type: Boolean, default: true },

    /* type key -> { enabled, repeat }. A Map rather than a fixed shape so a new
       notification type does not need a migration; anything absent falls back
       to the registry's defaults at read time. */
    prefs: {
      type: Map,
      of: prefSchema,
      default: () => new Map(Object.entries(defaultPrefs())),
    },

    lastSeenAt: { type: Date, default: Date.now },
    /* When a repeat was last sent to this device, per type. Stops an hourly
       job from sending twice in an hour after a restart, and is what makes
       "every hour" mean every hour rather than every tick. */
    lastRepeatAt: { type: Map, of: Date, default: () => new Map() },

    /* Consecutive delivery failures. A token the transport rejects is dead;
       counting rather than deleting on the first failure avoids dropping a
       device over one network blip. */
    failureCount: { type: Number, default: 0 },
  },
  { timestamps: true, collection: "notification_devices" },
);

/* The query every send makes: this person's live devices. */
notificationDeviceSchema.index({ employeeId: 1, enabled: 1 });

module.exports =
  mongoose.models.NotificationDevice ||
  mongoose.model("NotificationDevice", notificationDeviceSchema, "notification_devices");
