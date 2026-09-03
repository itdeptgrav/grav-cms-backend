// services/notifyDevices.service.js
//
// Send a notification to a person, on every device that still wants it.
//
// ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
// `messaging.send({ token: employee.fcmToken })` — one token, so one device,
// so a person signed in on both their phone and the office browser heard about
// it on whichever registered last. This fans out across their devices and
// filters each one by its own answers.
//
// ── IT FAILS QUIETLY, ON PURPOSE ────────────────────────────────────────────
// A notification is how somebody FINDS OUT. It is worth a lot and it is worth
// nothing next to the thing it is about: a leave approval that succeeded must
// not be rolled back because a push failed. Nothing here throws, and callers
// are not expected to await it.
//
// ── DEAD TOKENS ARE PRUNED, NOT ACCUMULATED ─────────────────────────────────
// An uninstalled app or a cleared browser leaves a token the transport rejects
// forever. Each rejection increments a counter and the third removes the row —
// third rather than first, so one network blip does not cost somebody their
// registration.

"use strict";

const NotificationDevice = require("../models/Access/NotificationDevice");
const { getType, defaultPrefs } = require("./notificationTypes");

const DEFAULTS = defaultPrefs();
let expoClient = null;
/** Rejections before a device is dropped. */
const MAX_FAILURES = 3;

/** Firebase messaging, or null when it is not configured. */
function messaging() {
  try {
    const { getMessaging } = require("../config/firebaseAdmin");
    return getMessaging();
  } catch {
    return null;
  }
}

/**
 * This device's answer for this type.
 *
 * Falls back to the registry default rather than to "on", so a type added after
 * a device registered behaves the way the registry says it should — which for
 * `repeat` means OFF, and an hourly notification nobody asked for is exactly
 * the thing that would get the whole channel muted.
 */
function prefFor(device, typeKey) {
  const stored = device.prefs?.get?.(typeKey) || device.prefs?.[typeKey];
  const fallback = DEFAULTS[typeKey] || { enabled: true, repeat: false };
  return {
    enabled: stored?.enabled ?? fallback.enabled,
    repeat: stored?.repeat ?? fallback.repeat,
  };
}

/** Is the token dead, as opposed to a transient failure? */
function isDeadToken(err) {
  const code = String(err?.errorInfo?.code || err?.code || err?.message || "");
  return /not-registered|invalid-registration|invalid-argument|InvalidRegistration|NotRegistered/i.test(
    code,
  );
}

async function deliverFcm(device, payload) {
  const m = messaging();
  if (!m) return { ok: false, dead: false, reason: "messaging_unavailable" };
  try {
    await m.send({
      token: device.token,
      /* Data-only, as every existing sender does: the service worker draws it,
         which is what keeps one appearance across web and Android. */
      data: {
        title: String(payload.title || ""),
        body: String(payload.body || ""),
        type: String(payload.type || ""),
        url: String(payload.url || ""),
        timestamp: String(Date.now()),
      },
      webpush: { headers: { Urgency: "high", TTL: "600" } },
    });
    return { ok: true, dead: false };
  } catch (err) {
    return { ok: false, dead: isDeadToken(err), reason: err.message };
  }
}

async function deliverExpo(device, payload) {
  /* Straight to the Expo push service. This used to call utils/sendExpoPush
     with the TOKEN — but that helper takes employee ids and looks the tokens
     up itself, so the call matched nobody and nothing was ever delivered on a
     phone through the registry. It is also the function that now consults the
     registry first, so calling it from here would loop. */
  try {
    const { Expo } = require("expo-server-sdk");
    if (!Expo.isExpoPushToken(device.token)) {
      return { ok: false, dead: true, reason: "not_an_expo_token" };
    }
    if (!expoClient) expoClient = new Expo();
    const [ticket] = await expoClient.sendPushNotificationsAsync([
      {
        to: device.token,
        title: payload.title,
        body: payload.body,
        sound: "default",
        ...(payload.channelId ? { channelId: payload.channelId } : {}),
        ...(payload.categoryId ? { categoryId: payload.categoryId } : {}),
        /* The legacy senders' data (kind, screen, id) rides through untouched
           so the app's tap handler keeps deep-linking; the registry type sits
           beside it under its own name rather than overwriting `type`, which
           older app builds read as the domain tag. */
        data: { ...(payload.data || {}), notificationType: payload.type, url: payload.url },
      },
    ]);
    if (ticket?.status === "error") {
      const code = ticket.details?.error || ticket.message || "";
      return { ok: false, dead: /DeviceNotRegistered/i.test(code), reason: code };
    }
    return { ok: true, dead: false };
  } catch (err) {
    return { ok: false, dead: isDeadToken(err), reason: err.message };
  }
}

async function deliver(device, payload) {
  if (device.transport === "expo") return deliverExpo(device, payload);
  return deliverFcm(device, payload);
}

/**
 * Notify one employee on every device that wants this type.
 *
 * @param {string|object} employee  id, or a doc carrying _id (and ideally email)
 * @param {object} payload
 * @param {string} payload.type   a key from services/notificationTypes
 * @param {string} payload.title
 * @param {string} payload.body
 * @param {string} [payload.url]
 * @param {object} [opts]
 * @param {boolean} [opts.isRepeat]  only reach devices that opted INTO repeats,
 *                                   and stamp when they were last repeated
 * @returns {Promise<{matched:number, sent:number, skipped:number, removed:number}>}
 *   `matched` is how many devices the person HAS. Zero means the registry does
 *   not know them, and a caller with an older single-token path may use that.
 */
async function notifyEmployeeDevices(employee, payload, { isRepeat = false } = {}) {
  const result = { matched: 0, sent: 0, skipped: 0, removed: 0 };
  try {
    const employeeId = employee?._id || employee;
    if (!employeeId || !payload?.type) return result;

    /* Matched by id OR by email. A browser signed in to the CMS carries the
       DEPARTMENT user's id in its session, not the Employee _id, so a row it
       registers is keyed by an id no HR sender will ever pass. The email is
       the one identity both sides share. */
    let email = String(employee?.email || "").toLowerCase();
    if (!email) {
      try {
        const Employee = require("../models/Employee");
        const doc = await Employee.findById(employeeId).select("email").lean();
        email = String(doc?.email || "").toLowerCase();
      } catch {
        /* id only, then */
      }
    }

    const typeDef = getType(payload.type);
    /* An unknown type is a bug in the caller, not a reason to withhold. It is
       delivered, because somebody wrote it deliberately, but it cannot be
       repeated: repeating something the registry does not describe is how an
       unbounded hourly loop starts. */
    if (isRepeat && !typeDef?.repeatable) return result;

    const devices = await NotificationDevice.find({
      enabled: true,
      $or: [{ employeeId }, ...(email ? [{ employeeEmail: email }] : [])],
    });
    result.matched = devices.length;

    for (const device of devices) {
      const pref = prefFor(device, payload.type);
      if (!pref.enabled) { result.skipped += 1; continue; }
      if (isRepeat && !pref.repeat) { result.skipped += 1; continue; }

      const url = payload.url || typeDef?.url || "";
      const outcome = await deliver(device, { ...payload, url });

      if (outcome.ok) {
        result.sent += 1;
        const update = { $set: { failureCount: 0, lastSeenAt: new Date() } };
        if (isRepeat) update.$set[`lastRepeatAt.${payload.type}`] = new Date();
        await NotificationDevice.updateOne({ _id: device._id }, update);
        continue;
      }

      if (outcome.dead || device.failureCount + 1 >= MAX_FAILURES) {
        await NotificationDevice.deleteOne({ _id: device._id });
        result.removed += 1;
      } else {
        await NotificationDevice.updateOne(
          { _id: device._id },
          { $inc: { failureCount: 1 } },
        );
        result.skipped += 1;
      }
    }
  } catch (err) {
    console.warn("[notify-devices]", err.message);
  }
  return result;
}

/**
 * Register or refresh a device.
 *
 * Upsert on the token: a person signing in again on the same browser updates
 * the row they already have rather than collecting a second one. Preferences
 * already set on that device are LEFT ALONE — re-registering must not silently
 * switch somebody's notifications back on.
 */
async function registerDevice({ employeeId, employeeEmail, token, transport, platform, label }) {
  if (!employeeId || !token || !transport) return null;
  const now = new Date();
  return NotificationDevice.findOneAndUpdate(
    { token: String(token) },
    {
      $set: {
        employeeId,
        employeeEmail: String(employeeEmail || "").toLowerCase(),
        transport,
        platform: platform || "unknown",
        lastSeenAt: now,
        failureCount: 0,
        ...(label ? { label } : {}),
      },
      $setOnInsert: {
        enabled: true,
        prefs: new Map(Object.entries(DEFAULTS)),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

/**
 * The registry rows that belong to this person, by either identity — the
 * same rule notifyEmployeeDevices uses, so "Manage notifications" lists every
 * device that a send would reach and none it would not.
 */
function ownerFilter({ id, email }) {
  const e = String(email || "").toLowerCase();
  return { $or: [{ employeeId: id }, ...(e ? [{ employeeEmail: e }] : [])] };
}

module.exports = { notifyEmployeeDevices, registerDevice, ownerFilter, prefFor, MAX_FAILURES };
