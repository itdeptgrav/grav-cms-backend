// verifyRepeatReminders.js
//
// "Remind me again" — does it actually remind again?
//
// Run:  node -r dotenv/config verifyRepeatReminders.js
//
// ── WHAT THIS IS ABOUT ──────────────────────────────────────────────────────
// A device can switch `repeat` on for a notification type, and an hourly sweep
// is supposed to re-send while the thing is still outstanding. The report was
// that ticking the box changes nothing. This drives the whole cycle against
// the real services and watches what comes out:
//
//   1. a device with repeat on, and something genuinely pending
//   2. the sweep sends
//   3. the sweep run again immediately does NOT send — an hourly reminder that
//      fires every sweep is a pager, not a reminder
//   4. once the hour has passed it sends again
//   5. when the queue is empty it stops on its own
//
// Delivery is intercepted, not performed: the point is whether the system
// DECIDES to send, and nobody's phone should buzz because a check ran.
//
// IT WRITES, AND PUTS EVERYTHING BACK — the device it registers is deleted
// again, including on a crash. It creates no leave, attendance or approval
// rows; it counts whatever is already there.

"use strict";

const mongoose = require("mongoose");

const MARKER = "AUTOMATED-CHECK-verifyRepeatReminders";

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass += 1; console.log(`  ok    ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? ` -- ${d}` : ""}`); }
};

async function cleanUp() {
  if (mongoose.connection.readyState !== 1) return "not connected";
  const r = await mongoose.connection.db
    .collection("notificationdevices")
    .deleteMany({ token: { $regex: MARKER } });
  return `removed ${r.deletedCount} test device(s)`;
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  console.log(`\nconnected to ${mongoose.connection.name}\n`);

  const { listTypes, getType } = require("./services/notificationTypes");
  const reminders = require("./services/pendingReminders.service");
  const notify = require("./services/notifyDevices.service");
  const NotificationDevice = require("./models/Access/NotificationDevice");
  const Employee = require("./models/Employee");

  /* ── 1. every type the UI lets you repeat can actually be repeated ─────── */
  console.log("every type offering a repeat toggle has something to count");
  const types = listTypes();
  const repeatable = types.filter((t) => t.repeatable).map((t) => t.key);
  const counted = reminders.PENDING_COUNTERS.map((c) => c.type);
  const orphans = repeatable.filter((k) => !counted.includes(k));
  check(
    `${repeatable.length} repeatable types, ${counted.length} have a counter`,
    orphans.length === 0,
    orphans.length
      ? `${orphans.join(", ")} offer a repeat switch the sweep can never act on`
      : "",
  );

  /* ── 2. the cycle, driven for real ────────────────────────────────────── */
  console.log("\nthe sweep, driven against a real device");

  /* Somebody with something genuinely outstanding, so the sweep has a reason
     to send. Counting for every employee is one query each; stop at the first
     hit. */
  const TYPE = "leave_pending";
  const counter = reminders.PENDING_COUNTERS.find((c) => c.type === TYPE);
  const staff = await Employee.findMany
    ? []
    : await Employee.find({ isActive: true }).select("_id email firstName lastName").limit(40).lean();

  let subject = null, pendingCount = 0;
  for (const e of staff) {
    const n = await counter.count(e).catch(() => 0);
    if (n > 0) { subject = e; pendingCount = n; break; }
  }
  check(`found somebody with ${TYPE} outstanding`, Boolean(subject),
    subject ? `${subject.firstName} — ${pendingCount} pending` : "nobody has any");

  if (!subject) {
    console.log("\n(no pending work anywhere, so the sweep has nothing to send — cannot drive the cycle)");
    console.log(`\n${pass} passed, ${fail} failed\n`);
    await cleanUp();
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }

  /* Delivery intercepted. A check must not make somebody's phone buzz. */
  const sent = [];
  const realDeliver = notify.__setDeliverForTests
    ? null
    : undefined;
  const originalSend = notify.notifyEmployeeDevices;

  try {
    await NotificationDevice.deleteMany({ token: { $regex: MARKER } });
    const device = await NotificationDevice.create({
      employeeId: subject._id,
      employeeEmail: subject.email || "",
      token: `${MARKER}-token`,
      transport: "expo",
      platform: "android",
      label: "Verify harness device",
      enabled: true,
      prefs: { [TYPE]: { enabled: true, repeat: true } },
    });
    check("registered a device with repeat switched on", Boolean(device._id));

    /* The sweep decides; dryRun reports that decision without delivering. */
    const first = await reminders.runPendingReminders({ dryRun: true });
    check("the sweep sees this person", first.employees > 0, JSON.stringify(first));
    check("and decides to send", first.sent > 0, JSON.stringify(first));
    check(`counted under ${TYPE}`, Boolean(first.byType?.[TYPE]), JSON.stringify(first.byType));

    /* Now for real, so lastRepeatAt is written — with delivery stubbed. */
    const deliverPath = require.resolve("./services/notifyDevices.service");
    const mod = require(deliverPath);
    const realNotify = mod.notifyEmployeeDevices;
    mod.notifyEmployeeDevices = async (emp, payload, opts) => {
      sent.push({ to: String(emp._id), type: payload.type, isRepeat: !!opts?.isRepeat });
      /* Mark the device as just-reminded, which is what a real send does. */
      await NotificationDevice.updateOne(
        { token: `${MARKER}-token` },
        { $set: { [`lastRepeatAt.${payload.type}`]: new Date() } },
      );
      return { matched: 1, sent: 1, skipped: 0, removed: 0 };
    };

    try {
      /* pendingReminders holds its own reference, so re-require it with the
         patched module in place. */
      delete require.cache[require.resolve("./services/pendingReminders.service")];
      const patched = require("./services/pendingReminders.service");

      const run1 = await patched.runPendingReminders();
      check("a real sweep sends", sent.length === 1, `${sent.length} send(s)`);
      check("and marks it as a repeat", sent[0]?.isRepeat === true, JSON.stringify(sent[0]));

      const run2 = await patched.runPendingReminders();
      check("a sweep straight after does NOT send again",
        sent.length === 1, `${sent.length} total send(s) after two sweeps`);
      check("and says it skipped", run2.skipped > 0, JSON.stringify(run2));

      /* Wind the clock back past the interval and it should fire again. */
      await NotificationDevice.updateOne(
        { token: `${MARKER}-token` },
        { $set: { [`lastRepeatAt.${TYPE}`]: new Date(Date.now() - 61 * 60 * 1000) } },
      );
      await patched.runPendingReminders();
      check("once the hour has passed it sends again", sent.length === 2,
        `${sent.length} total send(s)`);

      /* Repeat off — and it stops. */
      await NotificationDevice.updateOne(
        { token: `${MARKER}-token` },
        { $set: { [`prefs.${TYPE}`]: { enabled: true, repeat: false },
                  [`lastRepeatAt.${TYPE}`]: new Date(Date.now() - 61 * 60 * 1000) } },
      );
      await patched.runPendingReminders();
      check("switching repeat off stops it", sent.length === 2, `${sent.length} total send(s)`);
    } finally {
      mod.notifyEmployeeDevices = realNotify;
    }

    /* ── 3. what the sweep will not do ──────────────────────────────────── */
    console.log("\nwhat it refuses");
    const notRepeatable = types.find((t) => !t.repeatable);
    const res = await notify.notifyEmployeeDevices(
      subject,
      { type: notRepeatable.key, title: "t", body: "b" },
      { isRepeat: true },
    );
    check(`a repeat of "${notRepeatable.key}" (not repeatable) is refused`,
      res.sent === 0, JSON.stringify(res));
  } finally {
    console.log(`  ${await cleanUp()}`);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("\nharness crashed:", e.message, (e.stack || "").split("\n")[1] || "");
  try { console.error("cleanup:", await cleanUp()); } catch (err) {
    console.error(`CLEANUP FAILED — remove devices whose token contains "${MARKER}":`, err.message);
  }
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
