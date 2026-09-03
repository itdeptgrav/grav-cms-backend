// verifyNotificationSettings.js
//
// A person's devices are separate, their settings are honoured, and an hourly
// repeat only reaches somebody who asked for one.
//
// Run:  node -r dotenv/config verifyNotificationSettings.js
//
// WHAT THIS IS ABOUT
// Push tokens used to be two single strings on the employee record, so a person
// signed in on their phone AND the office browser had whichever registered
// last — and "on for Android, off for web" was not expressible at all. This
// checks the registry that replaced them.
//
// It WRITES: it registers throwaway devices for a real employee, then deletes
// exactly those. On crash too. It never sends a real notification — delivery is
// stubbed, so nobody's phone buzzes.
//
// SECOND PASS — the registry now sits IN FRONT of the old single-token path:
// every HR sender funnels through utils/sendExpoPush, which asks the registry
// first and reads Employee.pushToken/fcmToken only for a person it has never
// seen. A browser signed in to the CMS carries the department user's id, not
// the Employee _id, so rows are matched by email as well. Both are pinned
// below, and so is the bug that made the first pass a fiction on Android:
// deliverExpo handed a TOKEN to a helper that takes EMPLOYEE IDS.

"use strict";

const mongoose = require("mongoose");

const MARK = "verify-harness-token-";
let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass += 1; console.log(`  ok    ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? ` -- ${d}` : ""}`); }
};

async function cleanup() {
  const NotificationDevice = require("./models/Access/NotificationDevice");
  return (await NotificationDevice.deleteMany({ token: new RegExp(`^${MARK}`) })).deletedCount;
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  console.log(`\nconnected to ${mongoose.connection.name}\n`);

  const NotificationDevice = require("./models/Access/NotificationDevice");
  const Employee = require("./models/Employee");
  const { registerDevice, notifyEmployeeDevices } = require("./services/notifyDevices.service");
  const { listTypes, defaultPrefs, isRepeatable } = require("./services/notificationTypes");
  const { runPendingReminders } = require("./services/pendingReminders.service");

  await cleanup();

  const employee = await Employee.findOne({ email: { $ne: "" } }).select("_id email").lean();
  check("found an employee to register devices for", Boolean(employee), employee?.email);
  if (!employee) { console.log(`\n${pass} passed, ${fail} failed\n`); process.exit(1); }

  /* Delivery is stubbed. This harness must never make a real phone buzz. */
  const svc = require("./services/notifyDevices.service");
  const sentTo = [];
  const firebase = require("./config/firebaseAdmin");
  const realGetMessaging = firebase.getMessaging;
  firebase.getMessaging = () => ({
    send: async (msg) => { sentTo.push(msg.token); return "stub"; },
  });

  console.log("the catalogue");
  const types = listTypes();
  check("every type has a key, a label and a group",
    types.every((t) => t.key && t.label && t.group));
  check("outcomes are not repeatable",
    !isRepeatable("request_decided") && !isRepeatable("payroll"));
  check("things waiting on somebody are repeatable",
    isRepeatable("leave_pending") && isRepeatable("regularization_pending"));
  const d = defaultPrefs();
  check("every type defaults to ON", Object.values(d).every((p) => p.enabled === true));
  check("and every repeat defaults to OFF", Object.values(d).every((p) => p.repeat === false));

  console.log("\ntwo devices, one person");
  const web = await registerDevice({
    employeeId: employee._id, employeeEmail: employee.email,
    token: MARK + "web", transport: "fcm", platform: "web", label: "Chrome on Windows",
  });
  const android = await registerDevice({
    employeeId: employee._id, employeeEmail: employee.email,
    token: MARK + "android", transport: "fcm", platform: "android", label: "Pixel",
  });
  check("both registered and neither replaced the other",
    Boolean(web?._id) && Boolean(android?._id) && String(web._id) !== String(android._id));
  check("this person now has exactly two devices",
    (await NotificationDevice.countDocuments({ employeeId: employee._id, token: new RegExp(`^${MARK}`) })) === 2);

  /* Re-registering the same token must not add a second row, and must not
     reset preferences somebody has already set. */
  await NotificationDevice.updateOne(
    { _id: web._id },
    { $set: { "prefs.leave_pending": { enabled: false, repeat: false } } },
  );
  await registerDevice({
    employeeId: employee._id, employeeEmail: employee.email,
    token: MARK + "web", transport: "fcm", platform: "web", label: "Chrome on Windows",
  });
  const reRegistered = await NotificationDevice.findById(web._id);
  check("re-registering the same token does not duplicate it",
    (await NotificationDevice.countDocuments({ token: MARK + "web" })) === 1);
  check("and does not switch a preference back on",
    reRegistered.prefs.get("leave_pending").enabled === false);

  console.log("\nsettings are honoured, per device");
  sentTo.length = 0;
  await notifyEmployeeDevices(employee, {
    type: "leave_pending", title: "t", body: "b",
  });
  check("the device that switched this type off is not sent to",
    !sentTo.includes(MARK + "web"), sentTo.join(", "));
  check("the device that left it on is", sentTo.includes(MARK + "android"));

  console.log("\nan hourly repeat reaches only those who asked");
  sentTo.length = 0;
  await notifyEmployeeDevices(
    employee, { type: "leave_pending", title: "t", body: "b" }, { isRepeat: true },
  );
  check("with every repeat off, a repeat reaches nobody", sentTo.length === 0, sentTo.join(", "));

  await NotificationDevice.updateOne(
    { _id: android._id },
    { $set: { "prefs.leave_pending": { enabled: true, repeat: true } } },
  );
  sentTo.length = 0;
  await notifyEmployeeDevices(
    employee, { type: "leave_pending", title: "t", body: "b" }, { isRepeat: true },
  );
  check("once one device opts in, only that device gets it",
    sentTo.length === 1 && sentTo[0] === MARK + "android", sentTo.join(", "));

  console.log("\nan outcome can never be made to repeat");
  sentTo.length = 0;
  await NotificationDevice.updateOne(
    { _id: android._id },
    { $set: { "prefs.payroll": { enabled: true, repeat: true } } },
  );
  await notifyEmployeeDevices(
    employee, { type: "payroll", title: "t", body: "b" }, { isRepeat: true },
  );
  check("a non-repeatable type is refused even if a device claims repeat",
    sentTo.length === 0, sentTo.join(", "));

  console.log("\nthe hourly sweep");
  const dry = await runPendingReminders({ dryRun: true });
  check("the sweep runs and reports", typeof dry.sent === "number",
    JSON.stringify(dry));
  console.log(`        ${dry.employees} person(s) have repeats on; ${dry.sent} reminder(s) would go out`);

  console.log("\nthe registry reports how many devices a person has");
  sentTo.length = 0;
  const rep = await notifyEmployeeDevices(employee, { type: "payroll", title: "t", body: "b" });
  check("matched counts the person's devices", rep.matched === 2, JSON.stringify(rep));
  check("and both were sent to (payroll is on everywhere by default)",
    rep.sent === 2 && sentTo.includes(MARK + "web") && sentTo.includes(MARK + "android"));

  console.log("\na browser signed in to the CMS is found by email, not only by id");
  /* The CMS session's id is the DEPARTMENT user's, so a row it registers is
     keyed by an id no HR sender will ever pass. Simulate one. */
  const otherId = new mongoose.Types.ObjectId();
  await registerDevice({
    employeeId: otherId, employeeEmail: employee.email,
    token: MARK + "cms-browser", transport: "fcm", platform: "web", label: "Edge on Windows",
  });
  sentTo.length = 0;
  const byId = await notifyEmployeeDevices(String(employee._id), { type: "payroll", title: "t", body: "b" });
  check("a send addressed by Employee _id alone reaches the browser registered under another id",
    sentTo.includes(MARK + "cms-browser"), sentTo.join(", "));
  check("matched now counts all three", byId.matched === 3, JSON.stringify(byId));
  const { ownerFilter } = svc;
  check("the settings screen's owner filter lists the same three",
    (await NotificationDevice.countDocuments({ ...ownerFilter({ id: employee._id, email: employee.email }), token: new RegExp(`^${MARK}`) })) === 3);
  check("an email is lower-cased before it is compared",
    JSON.stringify(ownerFilter({ id: "x", email: "A@B.COM" })).includes('"a@b.com"'));

  console.log("\nevery HR sender now goes through the registry first");
  const { sendExpoPush } = require("./utils/sendExpoPush");
  const stored = await Employee.findById(employee._id).select("pushToken fcmToken").lean();
  sentTo.length = 0;
  const fan = await sendExpoPush(employee._id, {
    title: "t", body: "b",
    data: { kind: "leave", type: "leave", notificationType: "leave_pending" },
  });
  check("sendExpoPush reports a registry pass", fan.registry && typeof fan.registry.sent === "number", JSON.stringify(fan));
  check("the device with leave_pending OFF is skipped, the other two get it",
    !sentTo.includes(MARK + "web") && sentTo.includes(MARK + "android") && sentTo.includes(MARK + "cms-browser"),
    sentTo.join(", "));
  check("a registered person's OLD stored token is NOT also sent to (no double ring)",
    !stored?.fcmToken || !sentTo.includes(stored.fcmToken));
  check("and the legacy web counter stays at zero for them", fan.web.sent === 0, JSON.stringify(fan.web));

  /* Somebody the registry has never seen, and who holds no token either — so
     the legacy path is taken and provably sends nothing to anyone. */
  const nobody = await Employee.findOne({
    _id: { $ne: employee._id },
    $and: [{ $or: [{ pushToken: null }, { pushToken: "" }, { pushToken: { $exists: false } }] },
           { $or: [{ fcmToken: null }, { fcmToken: "" }, { fcmToken: { $exists: false } }] }],
  }).select("_id").lean();
  if (nobody) {
    sentTo.length = 0;
    const cold = await sendExpoPush(nobody._id, { title: "t", body: "b", data: { notificationType: "payroll" } });
    check("an unregistered person falls through to the old path without a registry send",
      cold.registry.sent === 0 && sentTo.length === 0, JSON.stringify(cold));
  } else {
    check("(no token-less employee in this database to test the fallback on)", true);
  }

  console.log("\nthe legacy senders name a registry type");
  const { notifyEmployeeNow } = require("./utils/notifyEmployee");
  sentTo.length = 0;
  await notifyEmployeeNow(employee._id, { title: "t", body: "b", kind: "leave", type: "leave_pending", screen: "Leave" });
  check("a pending leave carries leave_pending, so the device that muted it is skipped",
    !sentTo.includes(MARK + "web") && sentTo.includes(MARK + "android"), sentTo.join(", "));
  sentTo.length = 0;
  await notifyEmployeeNow(employee._id, { title: "t", body: "b", kind: "leave", screen: "Leave" });
  check("a plain 'leave' kind defaults to the OUTCOME type, which that device still wants",
    sentTo.includes(MARK + "web") && sentTo.includes(MARK + "android"), sentTo.join(", "));

  console.log("\nthe Expo path no longer calls the helper that takes employee ids");
  const svcSrc = require("fs").readFileSync(require.resolve("./services/notifyDevices.service"), "utf8");
  check("deliverExpo talks to expo-server-sdk directly",
    svcSrc.includes('require("expo-server-sdk")') && !svcSrc.includes('require("../utils/sendExpoPush")'));

  console.log("\nthe catalogue and the mount");
  check("documents are a type, and not repeatable",
    types.some((t) => t.key === "document") && !isRepeatable("document"));
  const cms = require("./routes/Access/changeRequests");
  const { handlers } = require("./routes/Employee_Routes/notificationSettings");
  check("the app router exports the handlers", typeof handlers === "function");
  /* Identity, not a path regexp: the layer's handle IS the exported router.
     That is true whichever path-to-regexp this Express ships. */
  check("and the CMS router mounts those same handlers",
    cms.stack.some((l) => l.handle === handlers));

  console.log("\na dead token is pruned rather than retried forever");
  firebase.getMessaging = () => ({
    send: async () => { const e = new Error("registration-token-not-registered"); throw e; },
  });
  await notifyEmployeeDevices(employee, { type: "attendance_alert", title: "t", body: "b" });
  check("a token the transport rejects is removed",
    (await NotificationDevice.countDocuments({ token: MARK + "android" })) === 0);

  firebase.getMessaging = realGetMessaging;

  console.log("\ncleanup");
  /* Reported, not asserted on a count. By this point the dead-token test has
     already pruned both devices — which is the behaviour under test — so a
     cleanup that removes nothing is success, not failure. The state is what
     matters, and that is the check below. */
  const removed = await cleanup();
  console.log(`        ${removed} row(s) left for cleanup to remove`);
  check("nothing of this harness is left behind",
    (await NotificationDevice.countDocuments({ token: new RegExp(`^${MARK}`) })) === 0);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("\nharness crashed:", e.message, e.stack?.split("\n")[1] || "");
  try {
    console.error(`cleaned up ${await cleanup()} device(s).`);
    await mongoose.disconnect();
  } catch { console.error("CLEANUP FAILED — remove notification_devices with a verify-harness token."); }
  process.exit(1);
});
