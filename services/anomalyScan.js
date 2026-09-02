// services/anomalyScan.js
//
// Patterns in the change log that a human should look at, found by machine.
//
// THE PROBLEM THIS SOLVES
// -----------------------
// The change log records everything, and that is exactly why nobody watches
// it. The failure that prompted this side existed IN the log the whole time:
// an employee's date of joining edited, PL granted off the new date, the date
// edited again — every step recorded, and the pattern invisible until payroll
// broke and somebody spent an evening in MongoDB working backwards. Logging
// answers "what happened"; this answers "what happened that shouldn't".
//
// THE RULES (each with its thresholds live-tunable in /developer/settings)
//
//   field-flipflop   the same field on the same record changed N+ times in a
//                    window — the date-of-joining case, generalised. Critical
//                    when the field is sensitive AND an old value came back:
//                    A→B→A is someone undoing themselves around a side effect.
//   delete-spree     one account deleting M+ records in a window.
//   write-burst      one account writing far faster than a person works.
//                    Imports are exempt — they are SUPPOSED to be fast.
//   after-hours      edits outside the working window (IST), flagged per
//                    person per day so a late night is one row, not forty.
//
// Everything found becomes a fingerprinted DevAlert (see the model for why),
// and NEW fingerprints are pushed to everyone holding a role in the developer
// department. The scan reads the log and writes alerts; it never touches the
// records themselves — observation, not intervention.

"use strict";

const ChangeLog = require("../models/Access/ChangeLog");
const DevAlert = require("../models/DevOps/DevAlert");
const DepartmentRole = require("../models/Access/DepartmentRole");
const Employee = require("../models/Employee");

const SEVERITY_RANK = { info: 0, warn: 1, critical: 2 };

const APP_URL = (process.env.FRONTEND_URL || "https://cms.grav.in").replace(/\/+$/, "");

/* ------------------------------------------------------------------ */
/* Alerts                                                              */
/* ------------------------------------------------------------------ */

/**
 * Record one observation of a condition.
 *
 * New fingerprint → created and (severity permitting) pushed. Seen before →
 * count bumped, no push. Previously RESOLVED → reopened and pushed again: the
 * condition coming back is news in a way its tenth repeat is not.
 *
 * @returns {{alert, isNew: boolean, reopened: boolean}}
 */
async function upsertAlert({ kind, fingerprint, severity = "warn", title, detail = "", evidence = [], ...where }) {
  const existing = await DevAlert.findOne({ fingerprint });

  if (!existing) {
    const alert = await DevAlert.create({
      kind, fingerprint, severity, title, detail,
      evidence: evidence.slice(0, 20),
      ...where,
    });
    await notifyDevelopers(alert).catch(() => {});
    return { alert, isNew: true, reopened: false };
  }

  const reopened = existing.status === "resolved";
  existing.count += 1;
  existing.lastSeenAt = new Date();
  existing.title = title; // the numbers in it move with the condition
  existing.detail = detail || existing.detail;
  if (SEVERITY_RANK[severity] > SEVERITY_RANK[existing.severity]) existing.severity = severity;
  if (reopened) {
    existing.status = "open";
    existing.resolvedAt = undefined;
    existing.resolutionNote = "";
  }
  await existing.save();
  if (reopened) await notifyDevelopers(existing).catch(() => {});
  return { alert: existing, isNew: false, reopened };
}

async function resolveByFingerprint(fingerprint, note = "") {
  await DevAlert.updateOne(
    { fingerprint, status: { $ne: "resolved" } },
    { $set: { status: "resolved", resolvedAt: new Date(), resolutionNote: note } },
  );
}

/**
 * Push to every registered browser of everyone with a role in `developer`.
 *
 * The transport is a parameter for the same reason it is in
 * departmentApprovalNotifications: who gets told is the behaviour worth
 * verifying, and a path only reachable through FCM cannot be.
 */
async function notifyDevelopers(alert, { send } = {}) {
  const { getSetting } = require("./devConfig");
  if (!(await getSetting("notify.pushEnabled"))) return 0;
  const min = await getSetting("notify.minSeverity");
  if (SEVERITY_RANK[alert.severity] < SEVERITY_RANK[min]) return 0;

  const holders = await DepartmentRole.find({ departmentSlug: "developer" })
    .select("email")
    .lean();
  if (!holders.length) return 0;

  const people = await Employee.find({
    email: { $in: holders.map((h) => String(h.email).toLowerCase()) },
    fcmToken: { $nin: [null, ""] },
  })
    .select("email fcmToken")
    .lean();

  const transport =
    send ||
    require("./departmentApprovalNotifications.service").sendPush;

  let sent = 0;
  for (const p of people) {
    const ok = await transport(p, {
      title: `[${alert.severity}] ${alert.kind}`,
      body: alert.title,
      url: `${APP_URL}/developer/alerts`,
      type: "developer_alert",
    });
    if (ok) sent += 1;
  }
  if (sent) await DevAlert.updateOne({ _id: alert._id }, { $set: { notifiedAt: new Date() } });
  return sent;
}

/* ------------------------------------------------------------------ */
/* The scan                                                            */
/* ------------------------------------------------------------------ */

const sameish = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Run every rule over the recent change log.
 *
 * `now` is injectable so the harness can pin time. Reads are capped: the rules
 * are about recent behaviour, and a scan that could load a year of history is
 * a scan that falls over the day it is most needed.
 */
async function scanChangeLogs({ now = new Date() } = {}) {
  const { getSetting, sensitiveWords } = require("./devConfig");

  const out = { flipflops: 0, deleteSprees: 0, bursts: 0, afterHours: 0, raised: 0, reopened: 0 };
  if (!(await getSetting("anomaly.enabled"))) return { ...out, skipped: true };

  const tally = (r) => {
    if (r.isNew) out.raised += 1;
    if (r.reopened) out.reopened += 1;
  };

  /* Every threshold is resolved PER DEPARTMENT — HR's tolerance for repeated
     edits is not Sales', and one number for both is whichever department's
     wrong answer. Memoised: departments repeat far more than they vary, and
     the settings cache underneath is only refreshed every 30s anyway. */
  const memo = new Map();
  const deptSetting = async (key, dept) => {
    const k = `${key}|${dept || ""}`;
    if (!memo.has(k)) memo.set(k, await getSetting(key, { department: dept }));
    return memo.get(k);
  };
  const sensitiveMemo = new Map();
  const isSensitive = async (path, dept) => {
    const dk = dept || "";
    if (!sensitiveMemo.has(dk)) sensitiveMemo.set(dk, await sensitiveWords(dept));
    const words = sensitiveMemo.get(dk);
    const low = String(path).toLowerCase();
    return words.some((w) => low.includes(w));
  };

  /* ── housekeeping: purge old RESOLVED alerts ───────────────────────── */
  // Only resolved: an open alert nobody has looked at is precisely the thing
  // that must not quietly disappear, however old it gets.
  try {
    const days = await getSetting("alerts.retentionDays");
    const cutoff = new Date(now.getTime() - days * 864e5);
    const purged = await DevAlert.deleteMany({ status: "resolved", resolvedAt: { $lt: cutoff } });
    out.purged = purged.deletedCount;
  } catch (err) {
    console.warn("[anomaly-scan] purge skipped:", err.message);
  }

  /* ── field-flipflop ────────────────────────────────────────────────── */
  {
    /* The QUERY window is the GLOBAL value — one read bounds every
       department. Known limit, stated rather than hidden: a department whose
       override widens its window past the global one is clipped to the global
       read; per-department windows narrow, they do not extend. Thresholds,
       sensitivity and hours are fully per-department below. */
    const windowDays = await getSetting("anomaly.flipflop.windowDays");
    const since = new Date(now.getTime() - windowDays * 864e5);

    const rows = await ChangeLog.find({
      createdAt: { $gte: since },
      action: { $in: ["update", "approve"] },
      "fields.0": { $exists: true },
      entityId: { $nin: ["", null] },
    })
      .select("departmentSlug entity entityId entityLabel fields createdAt actorEmail actorName")
      .sort({ createdAt: 1 })
      .limit(20000)
      .lean();

    // dept|entity|id|path -> ordered list of {from,to,at,actor}
    const byField = new Map();
    for (const row of rows) {
      for (const f of row.fields || []) {
        if (!f?.path) continue;
        const key = `${row.departmentSlug}|${row.entity}|${row.entityId}|${f.path}`;
        if (!byField.has(key)) byField.set(key, { row, path: f.path, hops: [] });
        byField.get(key).hops.push({
          from: f.from, to: f.to, at: row.createdAt,
          actor: row.actorName || row.actorEmail || "unknown",
        });
      }
    }

    for (const [key, g] of byField) {
      const minChanges = await deptSetting("anomaly.flipflop.minChanges", g.row.departmentSlug);
      if (g.hops.length < minChanges) continue;
      // Did a value come back? That is the tell of somebody gaming a side
      // effect — change it, let the system react, change it back. The list of
      // seen values is SEEDED with the first hop's FROM: the archetypal case
      // is original → temp → original, where "original" never appears as a
      // `to` until the final restoring edit — checking only the `to`s missed
      // exactly the date-of-joining scenario this rule exists for.
      const seen = [g.hops[0].from];
      let revisited = false;
      for (const h of g.hops) {
        if (seen.some((v) => sameish(v, h.to))) { revisited = true; break; }
        seen.push(h.to);
      }
      const hot = await isSensitive(g.path, g.row.departmentSlug);
      tally(await upsertAlert({
        kind: "field-flipflop",
        fingerprint: `flipflop:${key}`,
        severity: hot && revisited ? "critical" : hot || revisited ? "warn" : "info",
        title:
          `"${g.path}" on ${g.row.entity} ${g.row.entityLabel || g.row.entityId} ` +
          `changed ${g.hops.length}× in ${windowDays} days` +
          (revisited ? " — and returned to an earlier value" : ""),
        detail:
          `Values: ${g.hops.map((h) => JSON.stringify(h.to)).join(" → ")}. ` +
          `By: ${[...new Set(g.hops.map((h) => h.actor))].join(", ")}.` +
          (hot ? ` "${g.path}" is on the sensitive list.` : ""),
        departmentSlug: g.row.departmentSlug,
        entity: g.row.entity,
        entityId: g.row.entityId,
        entityLabel: g.row.entityLabel,
        evidence: g.hops.slice(-10),
      }));
      out.flipflops += 1;
    }
  }

  /* ── delete-spree & write-burst ────────────────────────────────────── */
  {
    /* Global windows bound the query; each (actor, department) pair is then
       judged by that department's own thresholds. */
    const delWindow = await getSetting("anomaly.deleteSpree.windowMinutes");
    const burstWindow = await getSetting("anomaly.burst.windowMinutes");
    const since = new Date(now.getTime() - Math.max(delWindow, burstWindow) * 60000);

    const rows = await ChangeLog.find({
      createdAt: { $gte: since },
      actorEmail: { $nin: ["", null] },
      origin: { $nin: ["import", "system"] },
    })
      .select("actorEmail actorName action createdAt departmentSlug entity entityLabel")
      .limit(20000)
      .lean();

    /* Actor AND department: sixty legitimate Sales edits must not trip HR's
       tighter threshold, and a spree split across two departments is two
       questions with possibly two different answers. */
    const byActor = new Map();
    for (const r of rows) {
      const k = `${r.actorEmail}|${r.departmentSlug || ""}`;
      if (!byActor.has(k)) byActor.set(k, []);
      byActor.get(k).push(r);
    }

    const dayKey = now.toISOString().slice(0, 10);
    for (const [actorKey, list] of byActor) {
      const email = actorKey.split("|")[0];
      const dept = list[0].departmentSlug || "";
      const maxDeletes = await deptSetting("anomaly.deleteSpree.maxDeletes", dept);
      const maxWrites = await deptSetting("anomaly.burst.maxWrites", dept);
      const deletes = list.filter(
        (r) => r.action === "delete" && r.createdAt >= new Date(now.getTime() - delWindow * 60000),
      );
      if (deletes.length >= maxDeletes) {
        tally(await upsertAlert({
          kind: "delete-spree",
          fingerprint: `delete-spree:${email}:${dept}:${dayKey}`,
          severity: "critical",
          title: `${list[0].actorName || email} deleted ${deletes.length} records in ${delWindow} minutes`,
          detail: deletes.slice(0, 10).map((d) => `${d.entity} ${d.entityLabel || ""}`.trim()).join("; "),
          actorEmail: email,
          actorName: list[0].actorName || "",
          departmentSlug: deletes[0].departmentSlug,
          evidence: deletes.slice(0, 10),
        }));
        out.deleteSprees += 1;
      }

      const burst = list.filter((r) => r.createdAt >= new Date(now.getTime() - burstWindow * 60000));
      if (burst.length > maxWrites) {
        tally(await upsertAlert({
          kind: "write-burst",
          fingerprint: `write-burst:${email}:${dept}:${dayKey}`,
          severity: "warn",
          title: `${list[0].actorName || email} made ${burst.length} changes in ${burstWindow} minutes`,
          detail: "Faster than a person normally works. A script, a stuck retry loop, or a shared login.",
          actorEmail: email,
          actorName: list[0].actorName || "",
          departmentSlug: burst[0].departmentSlug,
        }));
        out.bursts += 1;
      }
    }
  }

  /* ── after-hours ───────────────────────────────────────────────────── */
  {
    const since = new Date(now.getTime() - 864e5);

    const rows = await ChangeLog.find({
      createdAt: { $gte: since },
      actorEmail: { $nin: ["", null] },
      origin: { $nin: ["import", "system"] },
    })
      .select("actorEmail actorName createdAt departmentSlug entity entityLabel fields")
      .limit(20000)
      .lean();

    const offenders = new Map();
    for (const r of rows) {
      const dept = r.departmentSlug || "";
      if (!(await deptSetting("anomaly.afterHours.enabled", dept))) continue;
      const startHour = await deptSetting("anomaly.afterHours.startHour", dept);
      const endHour = await deptSetting("anomaly.afterHours.endHour", dept);
      // IST, the codebase's own convention: shift by 5.5h and read UTC parts.
      const ist = new Date(new Date(r.createdAt).getTime() + 5.5 * 3600 * 1000);
      const hour = ist.getUTCHours();
      if (hour >= startHour && hour < endHour) continue;
      const day = ist.toISOString().slice(0, 10);
      const key = `${r.actorEmail}:${dept}:${day}`;
      if (!offenders.has(key)) offenders.set(key, { r, day, startHour, endHour, count: 0, sensitive: 0 });
      const o = offenders.get(key);
      o.count += 1;
      for (const f of r.fields || []) {
        if (await isSensitive(f?.path || "", dept)) { o.sensitive += 1; break; }
      }
    }

    for (const [key, o] of offenders) {
      tally(await upsertAlert({
        kind: "after-hours",
        fingerprint: `after-hours:${key}`,
        severity: o.sensitive > 0 ? "warn" : "info",
        title:
          `${o.r.actorName || o.r.actorEmail} made ${o.count} change${o.count === 1 ? "" : "s"} ` +
          `outside ${o.startHour}:00–${o.endHour}:00 IST on ${o.day}` +
          (o.sensitive ? `, ${o.sensitive} touching sensitive fields` : ""),
        actorEmail: o.r.actorEmail,
        actorName: o.r.actorName || "",
        departmentSlug: o.r.departmentSlug,
      }));
      out.afterHours += 1;
    }
  }

  return out;
}

module.exports = { scanChangeLogs, upsertAlert, resolveByFingerprint, notifyDevelopers };
