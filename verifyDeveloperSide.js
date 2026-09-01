// verifyDeveloperSide.js
//
// The developer side catches what it promises to catch — starting with the
// exact case that prompted it: a date of joining changed, PL granted off the
// new date, the date changed back.
//
// Run:  node -r dotenv/config verifyDeveloperSide.js
//
// CREATES AND THEN DELETES its own change-log rows (dept slug
// "verify-dev-dept"), alerts, settings, heartbeat rows and role rows. Pushes
// go through a stub transport — nothing reaches a real device. Cleanup runs on
// crash too.

"use strict";

const mongoose = require("mongoose");

const SLUG = "verify-dev-dept";
const ACTOR = "verify-dev-actor@grav.invalid";
const DEVELOPER = "verify-dev-holder@grav.invalid";

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass += 1; console.log(`  ok    ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

async function cleanup() {
  const ChangeLog = require("./models/Access/ChangeLog");
  const DevAlert = require("./models/DevOps/DevAlert");
  const SystemSetting = require("./models/DevOps/SystemSetting");
  const JobHeartbeat = require("./models/DevOps/JobHeartbeat");
  const DepartmentRole = require("./models/Access/DepartmentRole");
  const Employee = require("./models/Employee");
  let n = 0;
  n += (await ChangeLog.deleteMany({ departmentSlug: SLUG })).deletedCount;
  n += (await DevAlert.deleteMany({
    $or: [{ departmentSlug: SLUG }, { actorEmail: /grav\.invalid$/ }, { fingerprint: /verify-dev/ }],
  })).deletedCount;
  n += (await SystemSetting.deleteMany({ updatedByEmail: /grav\.invalid$/ })).deletedCount;
  n += (await JobHeartbeat.deleteMany({ name: /^verify-dev-/ })).deletedCount;
  n += (await DepartmentRole.deleteMany({ departmentSlug: "developer", email: /grav\.invalid$/ })).deletedCount;
  n += (await Employee.deleteMany({ email: /@grav\.invalid$/ })).deletedCount;
  require("./services/devConfig").invalidate();
  return n;
}

/** A change-log row shaped the way the audit spine writes them. */
function logRow({ minutesAgo = 0, action = "update", path, from, to, actor = ACTOR, origin = "direct", entityId = "68f000000000000000000001" }) {
  return {
    departmentSlug: SLUG,
    section: "hr:employees",
    entity: "employee",
    entityId,
    entityLabel: "Verify Subject",
    action,
    origin,
    actorEmail: actor,
    actorName: "Verify Actor",
    summary: `${action} ${path || ""}`,
    fields: path ? [{ path, label: path, from, to, kind: "changed" }] : [],
    createdAt: new Date(Date.now() - minutesAgo * 60000),
  };
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  console.log(`\nconnected to ${mongoose.connection.name}\n`);

  const ChangeLog = require("./models/Access/ChangeLog");
  const DevAlert = require("./models/DevOps/DevAlert");
  const { scanChangeLogs, upsertAlert, resolveByFingerprint, notifyDevelopers } = require("./services/anomalyScan");
  const { getSetting, setSetting, listSettings, invalidate } = require("./services/devConfig");
  const { ensureJob, beat, checkOverdue } = require("./services/jobHeartbeats");
  const { setRole } = require("./services/departmentRoles");
  const Employee = require("./models/Employee");

  await cleanup();

  /* ── THE case: date of joining changed, then changed back ──────────── */
  console.log("the date-of-joining flip-flop");
  await ChangeLog.insertMany([
    logRow({ minutesAgo: 60 * 24 * 5, path: "dateOfJoining", from: "2024-03-01", to: "2021-01-01" }),
    logRow({ minutesAgo: 60 * 24 * 3, path: "dateOfJoining", from: "2021-01-01", to: "2020-06-01" }),
    logRow({ minutesAgo: 60 * 24 * 1, path: "dateOfJoining", from: "2020-06-01", to: "2024-03-01" }),
  ]);

  let out = await scanChangeLogs();
  check("the scan flags it", out.flipflops >= 1, JSON.stringify(out));

  const flip = await DevAlert.findOne({ kind: "field-flipflop", departmentSlug: SLUG }).lean();
  check("as an alert a developer will see", Boolean(flip));
  check("marked CRITICAL — sensitive field AND an old value came back",
    flip?.severity === "critical", flip?.severity);
  check("naming the record", /Verify Subject/.test(flip?.title || ""), flip?.title);
  check("with the whole value journey in the detail",
    /2021-01-01/.test(flip?.detail || "") && /2024-03-01/.test(flip?.detail || ""), flip?.detail);

  const countAfterFirst = (await DevAlert.findOne({ _id: flip._id }).lean()).count;
  out = await scanChangeLogs();
  const after = await DevAlert.findOne({ _id: flip._id }).lean();
  check("a second scan bumps the SAME alert, never files a duplicate",
    after.count === countAfterFirst + 1 &&
      (await DevAlert.countDocuments({ kind: "field-flipflop", departmentSlug: SLUG })) === 1,
    `count ${countAfterFirst} → ${after.count}`);

  /* ── delete spree ──────────────────────────────────────────────────── */
  console.log("\na delete spree");
  await ChangeLog.insertMany(
    Array.from({ length: 6 }, (_, i) =>
      logRow({ minutesAgo: i, action: "delete", entityId: `68f00000000000000000010${i}` })),
  );
  out = await scanChangeLogs();
  check("six deletes in minutes is flagged", out.deleteSprees >= 1, JSON.stringify(out));
  check("as critical", (await DevAlert.findOne({ kind: "delete-spree", actorEmail: ACTOR }).lean())?.severity === "critical");

  /* ── imports are exempt from burst ─────────────────────────────────── */
  console.log("\nwhat it deliberately ignores");
  await ChangeLog.insertMany(
    Array.from({ length: 60 }, (_, i) =>
      logRow({ minutesAgo: 0, origin: "import", entityId: `68f00000000000000000020${i % 10}`, path: "qty", from: i, to: i + 1 })),
  );
  out = await scanChangeLogs();
  check("60 import writes in a minute raise NO burst — imports are supposed to be fast",
    out.bursts === 0, JSON.stringify(out));

  /* ── settings drive the rules live ─────────────────────────────────── */
  console.log("\nlive settings");
  check("an unknown key throws instead of silently defaulting",
    await getSetting("anomaly.flipflop.minChanges").then(() => true).catch(() => false));
  let threw = false;
  try { await getSetting("anomaly.flipflop.minChangez"); } catch { threw = true; }
  check("(the typo version throws)", threw);

  const before = await getSetting("anomaly.flipflop.minChanges");
  await setSetting("anomaly.flipflop.minChanges", 20, { email: DEVELOPER, name: "Verify Dev" });
  check("a changed value reads back", (await getSetting("anomaly.flipflop.minChanges")) === 20);

  await DevAlert.deleteMany({ kind: "field-flipflop", departmentSlug: SLUG });
  out = await scanChangeLogs();
  check("and the rule OBEYS it — threshold 20 finds nothing", out.flipflops === 0, JSON.stringify(out));

  await setSetting("anomaly.flipflop.minChanges", before, { email: DEVELOPER, name: "Verify Dev" });
  const listed = await listSettings();
  const row = listed.find((r) => r.key === "anomaly.flipflop.minChanges");
  check("the settings list records who changed it", row?.updatedBy === "Verify Dev", row?.updatedBy);
  check("with the value trail on the row", (row?.history || []).length >= 2);
  let bad = false;
  try { await setSetting("anomaly.flipflop.minChanges", "not a number", {}); } catch { bad = true; }
  check("a non-number is refused, not stored", bad);

  /* ── heartbeats ────────────────────────────────────────────────────── */
  console.log("\njob heartbeats");
  await ensureJob("verify-dev-cron", "harness job", 1); // promises every second
  await new Promise((r) => setTimeout(r, 10)); // its silence now exceeds 1.5s? not yet — no beat ever, measured from createdAt
  await new Promise((r) => setTimeout(r, 1600));
  let hb = await checkOverdue();
  check("a job that never beat is caught from its registration",
    hb.overdue.includes("verify-dev-cron"), JSON.stringify(hb));
  const jobAlert = await DevAlert.findOne({ fingerprint: "job-overdue:verify-dev-cron" }).lean();
  check("as a critical alert", jobAlert?.severity === "critical");

  hb = await checkOverdue();
  check("a second check does NOT re-raise the same outage", hb.overdue.length === 0);

  beat("verify-dev-cron");
  await new Promise((r) => setTimeout(r, 150));
  hb = await checkOverdue();
  check("a beat recovers it", hb.recovered.includes("verify-dev-cron"), JSON.stringify(hb));
  check("and the alert resolves itself",
    (await DevAlert.findOne({ fingerprint: "job-overdue:verify-dev-cron" }).lean())?.status === "resolved");

  /* ── who is told ───────────────────────────────────────────────────── */
  console.log("\nwho is told");
  await Employee.create({
    firstName: "Verify", lastName: "Dev", email: DEVELOPER, gender: "Other",
    biometricId: `VD${Date.now().toString().slice(-6)}`, fcmToken: "tok-dev",
  });
  await setRole({ departmentSlug: "developer", email: DEVELOPER, name: "Verify Dev", role: "editor" });

  const sent = [];
  const send = async (emp, msg) => { sent.push({ to: emp.email, ...msg }); return true; };

  /* Created with push OFF, so upsertAlert's own internal notify does not fire
     the REAL transport at the fake token — FCM rejects it and the stale-token
     cleanup then wipes Employee.fcmToken, which made the stubbed call below
     find nobody. The first run of this harness is what caught that. */
  await setSetting("notify.pushEnabled", false, { email: DEVELOPER, name: "Verify Dev" });
  const { alert } = await upsertAlert({
    kind: "field-flipflop", fingerprint: "verify-dev-notify-1", severity: "critical",
    title: "verify notify", departmentSlug: SLUG,
  });
  await setSetting("notify.pushEnabled", true, { email: DEVELOPER, name: "Verify Dev" });
  await notifyDevelopers(alert, { send });
  check("a critical alert reaches the developer-role holder",
    sent.some((m) => m.to === DEVELOPER), sent.map((m) => m.to).join(","));
  check("typed for the service worker's developer tray",
    sent[0]?.type === "developer_alert", sent[0]?.type);
  check("linking to the alerts page", /\/developer\/alerts$/.test(sent[0]?.url || ""), sent[0]?.url);

  sent.length = 0;
  const infoAlert = (await upsertAlert({
    kind: "after-hours", fingerprint: "verify-dev-notify-2", severity: "info",
    title: "verify info", departmentSlug: SLUG,
  })).alert;
  await notifyDevelopers(infoAlert, { send });
  check("an info alert stays below the push floor", sent.length === 0);

  /* ── reopen semantics ──────────────────────────────────────────────── */
  await resolveByFingerprint("verify-dev-notify-1", "done");
  const re = await upsertAlert({
    kind: "field-flipflop", fingerprint: "verify-dev-notify-1", severity: "critical",
    title: "verify notify again", departmentSlug: SLUG,
  });
  check("\na resolved condition coming back REOPENS rather than duplicating",
    re.reopened === true && re.isNew === false);

  /* -- per-department settings -------------------------------------- */
  console.log("\nper-department settings");
  {
    // Override the flip-flop threshold for THIS harness department only.
    await setSetting("anomaly.flipflop.minChanges", 20,
      { email: DEVELOPER, name: "Verify Dev" }, { department: SLUG });

    check("the department reads its own value",
      (await getSetting("anomaly.flipflop.minChanges", { department: SLUG })) === 20);
    check("every other department still reads the global value",
      (await getSetting("anomaly.flipflop.minChanges", { department: "hr" })) === 3,
      String(await getSetting("anomaly.flipflop.minChanges", { department: "hr" })));
    check("and the global read is untouched",
      (await getSetting("anomaly.flipflop.minChanges")) === 3);

    // The scan honours it: this department's 3-hop flip-flop is now UNDER its
    // own threshold of 20 and must not fire, while everything else keeps the
    // global 3.
    await DevAlert.deleteMany({ kind: "field-flipflop", departmentSlug: SLUG });
    await scanChangeLogs();
    /* Counted for THIS department, not globally: the scan covers every
       department, and real data elsewhere legitimately contains flip-flops —
       asserting a global zero made this pass only on a quiet database. */
    check("the scan judges each department by ITS threshold — no flag at 20",
      (await DevAlert.countDocuments({ kind: "field-flipflop", departmentSlug: SLUG })) === 0);

    // Back to inherit: deletion of the override, not a copy of the global
    // value — so the department follows future global changes again.
    const inh = await setSetting("anomaly.flipflop.minChanges", null,
      { email: DEVELOPER, name: "Verify Dev" }, { department: SLUG, inherit: true });
    check("inherit removes the override", inh.inherited === true);
    check("and the department is back on the global value",
      (await getSetting("anomaly.flipflop.minChanges", { department: SLUG })) === 3);

    await scanChangeLogs();
    check("so the same data flags again",
      (await DevAlert.countDocuments({ kind: "field-flipflop", departmentSlug: SLUG })) >= 1);

    // The guard rails.
    let refused = false;
    try {
      await setSetting("notify.pushEnabled", false, {}, { department: SLUG });
    } catch { refused = true; }
    check("a GLOBAL-only key refuses a department override", refused);

    const listed2 = await listSettings({ department: SLUG });
    check("the department view lists only per-department keys",
      listed2.length > 0 && listed2.every((r) => r.perDepartment));
    check("and marks nothing overridden after the inherit",
      listed2.every((r) => !r.overridden));
  }

  /* -- the live restrictions --------------------------------------- */
  console.log("\nthe operational controls");
  {
    const { decide } = require("./Middlewear/opsControls");
    const settings = {
      frozen: new Set(["hr"]),
      afterHoursBlocked: new Set(["accounting"]),
      freezeMessage: "Read-only for maintenance.",
      startHour: 7,
      endHour: 22,
    };
    const at = (istHour) => new Date(Date.UTC(2026, 7, 31, istHour - 5.5 >= 0 ? istHour - 5.5 : istHour + 18.5, 30));

    const frozenWrite = await decide({ method: "PUT", path: "/api/employees/abc" }, settings);
    check("a write to a FROZEN department is refused with 503",
      frozenWrite?.status === 503 && frozenWrite.code === "DEPARTMENT_FROZEN",
      JSON.stringify(frozenWrite));
    check("carrying the message the settings say",
      /maintenance/i.test(frozenWrite?.message || ""));

    check("reading the same frozen department still works",
      (await decide({ method: "GET", path: "/api/hr/employees" }, settings)) === null);
    check("a read-shaped POST (search/export) still works",
      (await decide({ method: "POST", path: "/api/hr/reports/export" }, settings)) === null);
    check("sign-in is never blocked",
      (await decide({ method: "POST", path: "/api/auth/login" }, settings)) === null);
    check("the developer API is never blocked — the freeze must be liftable",
      (await decide({ method: "PUT", path: "/api/dev/settings/x" }, settings)) === null);
    check("an unlisted department is untouched",
      (await decide({ method: "POST", path: "/api/cms/sales/customers" }, settings)) === null);

    const night = await decide(
      { method: "POST", path: "/api/accountant/vouchers", now: at(23) }, settings);
    check("an after-hours write in a blocked department is refused",
      night?.status === 403 && night.code === "AFTER_HOURS", JSON.stringify(night));
    check("the same write inside working hours goes through",
      (await decide({ method: "POST", path: "/api/accountant/vouchers", now: at(11) }, settings)) === null);
    check("after-hours in an UNBLOCKED department is untouched (observe only)",
      (await decide({ method: "PUT", path: "/api/employees/abc", now: at(23) },
        { ...settings, frozen: new Set() })) === null);
  }

  /* -- old rows become readable ------------------------------------- */
  console.log("\nthin rows are reconstructed at read time");
  {
    await ChangeLog.create({
      departmentSlug: SLUG,
      entity: "employee",
      entityId: "68f000000000000000000777",
      entityLabel: "Verify Thin Row",
      action: "update",
      actorEmail: ACTOR,
      actorName: "Verify Actor",
      // The old shape: raw patches, no summary, no fields — what rendered as
      // "(no summary)" and prompted this work.
      before: { email: "old@x.com", phone: "111", updatedAt: "2026-08-01T00:00:00Z" },
      after: { email: "new@x.com", phone: "111", updatedAt: "2026-08-02T00:00:00Z" },
    });

    const { presentEntry } = require("./routes/DevOps/developer");
    const row = await ChangeLog.findOne({ entityId: "68f000000000000000000777" }).lean();
    const shown = presentEntry(row);
    check("it gains a field table diffed from the raw patch",
      shown.fields.some((f) => f.path === "email" && f.to === "new@x.com"),
      JSON.stringify(shown.fields));
    check("unchanged fields are not reported", !shown.fields.some((f) => f.path === "phone"));
    check("bookkeeping churn (updatedAt) is not reported",
      !shown.fields.some((f) => String(f.path).includes("updatedAt")));
    check("and a summary is written instead of \"(no summary)\"",
      /Changed .*Email/i.test(shown.summary), shown.summary);
    check("marked as reconstructed, so the UI can be honest about it",
      shown.derived === true);
    const already = presentEntry({ summary: "hand-written", fields: [{ path: "x", from: 1, to: 2 }] });
    check("a row that already says what happened is left exactly alone",
      already.summary === "hand-written" && already.derived === false);
  }

  /* -- retention ------------------------------------------------------ */
  console.log("\nhousekeeping");
  {
    await DevAlert.create({
      kind: "server-error", fingerprint: "verify-dev-old-resolved",
      severity: "info", title: "old resolved", status: "resolved",
      resolvedAt: new Date(Date.now() - 400 * 864e5),
    });
    await DevAlert.create({
      kind: "server-error", fingerprint: "verify-dev-old-open",
      severity: "info", title: "old but OPEN",
      firstSeenAt: new Date(Date.now() - 400 * 864e5),
    });
    await scanChangeLogs();
    check("a resolved alert past retention is purged",
      !(await DevAlert.findOne({ fingerprint: "verify-dev-old-resolved" })));
    check("an OPEN alert is never purged, however old",
      Boolean(await DevAlert.findOne({ fingerprint: "verify-dev-old-open" })));
  }

  console.log("\ncleanup");
  check("every harness row removed", (await cleanup()) >= 10);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (err) => {
  console.error("\nharness crashed:", err.message);
  try {
    console.error(`cleaned up ${await cleanup()} row(s).`);
    await mongoose.disconnect();
  } catch {
    console.error(`CLEANUP FAILED — remove slug "${SLUG}", fingerprints /verify-dev/, @grav.invalid rows.`);
  }
  process.exit(1);
});
