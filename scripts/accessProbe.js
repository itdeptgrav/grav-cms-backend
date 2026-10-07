#!/usr/bin/env node
"use strict";
/**
 * scripts/accessProbe.js — who is refused what, across EVERY application.
 *
 *     npm run verify:access            # against http://localhost:5000
 *     PROBE_BASE=http://host:5000 npm run verify:access
 *
 * Why it exists (6 Oct 2026): "you do not have permission to do this" kept
 * turning up one page at a time, in one application after another — HR, the
 * accountant, the store — even for the CEO. Fixing them one report at a time
 * meant finding each one by being refused. This finds them all at once.
 *
 * WHAT IT DOES
 *   1. Reads every `app.use(prefix, router)` in server.js and walks each real
 *      Express router (router.stack, the same technique as
 *      services/access/hrMountRegistry.js) to list every GET route the server
 *      actually serves.
 *   2. Signs a session for each real person who holds an application role, in
 *      EXACTLY the shape routes/auth/deptAuth.js issues at login: the CEO's
 *      platform-admin account through the exported buildTokenPayload, and every
 *      employee per application they hold a role in, through the same literal
 *      canonicalSession builds.
 *   3. Calls every GET route as each of them and records every 401 / 403 with
 *      the server's own code and message.
 *
 * READ-ONLY BY CONSTRUCTION: it sends GET requests only, and skips any GET
 * whose path says it changes something (sync, backfill, send, import, migrate,
 * seed, reset, …). Path parameters get a well-formed id that matches nothing,
 * so a route that reaches its handler answers 404 — which is a PASS here: the
 * question is only whether the access layers let the person through.
 *
 * READING THE RESULT
 *   • The CEO (platform administrator) must be refused NOTHING. Every CEO
 *     refusal is a defect.
 *   • Anybody else being refused inside an application they hold a role in is
 *     worth reading; being refused in an application they hold no role in is
 *     the system working.
 */

require("dotenv").config();
/* Walking the routes means REQUIRING every router, and several register their
   schedules at require time — an early run of this probe started the C4
   presence credit pass and the accounting backup scheduler against the live
   database. This process is a reader: no job may start in it. Set after
   dotenv so a .env value cannot turn them back on. */
process.env.BACKGROUND_JOBS = "off";
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const ROOT = path.join(__dirname, "..");
const BASE = process.env.PROBE_BASE || "http://localhost:5000";
const CONCURRENCY = Number(process.env.PROBE_CONCURRENCY || 10);
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 20000);
const ONLY = process.env.PROBE_ONLY || ""; // e.g. "ceo@grav.in"

/* A GET that writes is a defect of its own, but it is not this tool's to
   trigger: anything whose path says it acts is left out. */
const UNSAFE = /(sync|backfill|send|email|notify|push|seed|migrat|reset|cron|trigger|\/run\b|import|recalc|repair|rebuild|regenerate|logout|callback|webhook|oauth|test-|debug|socket|stream|purge|cleanup|approve|reject|resend|apply|refresh-token|impersonat)/i;

/* ── 1. every mounted GET route ─────────────────────────────────────────── */

function mountsFromServer() {
  const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const requireOf = new Map();
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*["']([^"']+)["']\s*\)(\.[A-Za-z_$][\w$]*)?/g)) {
    requireOf.set(m[1], { file: m[2], prop: m[3] ? m[3].slice(1) : null });
  }
  const mounts = [];
  for (const m of src.matchAll(/app\.use\(\s*["'](\/[^"']*)["']\s*,([\s\S]*?)\);/g)) {
    const prefix = m[1];
    const args = m[2].split(",").map((s) => s.trim()).filter(Boolean);
    const last = args[args.length - 1] || "";
    const inline = last.match(/^require\(\s*["']([^"']+)["']\s*\)(?:\.([A-Za-z_$][\w$]*))?$/);
    if (inline) mounts.push({ prefix, file: inline[1], prop: inline[2] || null });
    else if (requireOf.has(last)) mounts.push({ prefix, ...requireOf.get(last) });
  }
  return mounts.filter((m) => m.file.startsWith("."));
}

function walkRoutes(mounts) {
  const out = [];
  const mountPathOf = (layer) => {
    if (layer.path) return layer.path === "/" ? "" : layer.path;
    const src = layer.regexp?.source || "";
    const m = src.match(/^\^\\\/(?:\?\()?([A-Za-z0-9_\-\/\\.]*)/);
    return m && m[1] ? "/" + m[1].replace(/\\/g, "") : "";
  };
  const walk = (stack, prefix, mount) => {
    for (const layer of stack || []) {
      if (layer.route) {
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const p of paths) {
          if (typeof p !== "string") continue;
          if (!layer.route.methods?.get) continue;
          const full = `${prefix}${p === "/" ? "" : p}`.replace(/\/+$/, "") || "/";
          out.push({ path: full, mount });
        }
        continue;
      }
      const sub = layer.handle;
      if (sub && typeof sub === "function" && Array.isArray(sub.stack)) walk(sub.stack, `${prefix}${mountPathOf(layer)}`, mount);
    }
  };
  const loadErrors = [];
  for (const m of mounts) {
    let mod;
    try {
      mod = require(path.join(ROOT, m.file));
    } catch (err) {
      loadErrors.push(`${m.prefix} ${m.file}: ${err.message.split("\n")[0]}`);
      continue;
    }
    const router = m.prop ? mod?.[m.prop] : mod?.router && !mod.stack ? mod.router : mod;
    if (router?.stack) walk(router.stack, m.prefix === "/" ? "" : m.prefix, m.prefix);
  }
  const seen = new Set();
  return {
    routes: out.filter((r) => (seen.has(r.path) ? false : (seen.add(r.path), true))),
    loadErrors,
  };
}

/* Path parameters: well-formed values that match nothing. */
function concrete(p) {
  return p.replace(/:([A-Za-z_]\w*)\??/g, (_, name) => {
    const n = name.toLowerCase();
    if (/yearmonth|month|period/.test(n)) return "2026-09";
    if (/date|day/.test(n)) return "2026-09-01";
    if (/year/.test(n)) return "2026";
    if (/slug|stage|department|dept|type|kind|section|status|mode|app/.test(n)) return "zz-probe";
    if (/biometric|bid|code|uin/.test(n)) return "ZZPROBE0";
    return "000000000000000000000000";
  }).replace(/\*\w*/g, "x");
}

/* ── 2. sessions shaped exactly like routes/auth/deptAuth.js issues them ─── */

async function sessions(db) {
  const { buildTokenPayload, signToken } = require(path.join(ROOT, "routes/auth/deptAuth"));
  const apps = await db.collection("access_departments").find({ isActive: true }).toArray();
  const bySlug = new Map(apps.map((a) => [a.slug, a]));
  const out = [];

  for (const u of await db.collection("dept_users").find({ isActive: true }).toArray()) {
    const home = apps.find((a) => String(a._id) === String(u.departmentId));
    if (!home) continue;
    out.push({ who: u.email, as: `${home.slug} (dept user${u.isAdmin ? ", platform admin" : ""})`, app: home.slug, admin: !!u.isAdmin, token: signToken(buildTokenPayload(u, home)) });
  }

  const roles = await db.collection("department_roles").find({ isActive: true }).toArray();
  for (const g of roles) {
    const app = bySlug.get(g.departmentSlug);
    if (!app) continue;
    const rec = await db.collection("employees").findOne({ email: g.email });
    if (!rec || rec.isActive === false || rec.status === "inactive") continue;
    const payload = {
      v: 2, id: String(rec._id), role: app.legacyRole || app.slug, userType: app.legacyUserType || app.slug,
      deptId: String(app._id), deptSlug: app.slug, employeeId: rec.biometricId || "",
      name: `${rec.firstName || ""} ${rec.lastName || ""}`.trim(), email: rec.email || "",
      isAdmin: false, subject: "employee", tv: 0,
    };
    out.push({ who: g.email, as: `${g.departmentSlug} ${g.role}`, app: g.departmentSlug, admin: false, token: signToken(payload) });
  }
  /* Accounting answers only an ORGANISATION session. The accountant app gets
     one by trading the CMS session at /api/accountant/auth/sync-legacy, which
     finds the person's Acc_User row and signs it. Do the same here, read-only
     (sync-legacy also stamps lastLoginAt; this does not), so /api/accountant
     is judged as the app sees it. No row = what the app shows: no grant. */
  const { signOrgToken } = require(path.join(ROOT, "Middlewear/AccountantOrgAuthMiddleware"));
  for (const s of out) {
    const esc = s.who.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const acc = await db.collection("acc_users").findOne({ email: new RegExp(`^${esc}$`, "i"), isActive: { $ne: false } });
    if (acc) s.accToken = signOrgToken(acc, "30m");
  }
  return ONLY ? out.filter((s) => s.who === ONLY) : out;
}
const ACCOUNTING = /^\/api\/accountant(\/|$)/;

/* ── Each person only against THEIR application (the default since 6 Oct
   2026; PROBE_SCOPE=all tries everybody against every route, where a Store
   approver is refused HR, PPC and the CEO pages — correctly, and loudly). ──
   The CEO is probed against everything. Everybody else only against the routes
   of the application their role is in, plus the plumbing every signed-in
   person uses. One person per (application, role) — eight sales approvers are
   one answer, not eight. */
const APP_ROUTES = {
  hr: /^\/(api\/hr|hr|api\/employees|api\/ceo\/hr)(\/|$)/,
  sales: /^\/api\/(cms\/(sales|crm|marketing)|sales)(\/|$)/,
  marketing: /^\/api\/cms\/marketing(\/|$)/,
  store: /^\/api\/(cms\/(store|inventory|mrf|warehouses|purchase|sourcing)|requests)(\/|$)/,
  merchandiser: /^\/api\/cms\/merchandising(\/|$)/,
  "project-manager": /^\/api\/cms\/(production|manufacturing|ppc)(\/|$)/,
  ppc: /^\/api\/cms\/(ppc|production)(\/|$)/,
  qc: /^\/api\/cms\/(manufacturing\/qc|qc)/,
  accountant: /^\/api\/accountant(\/|$)/,
};
/* /api/google is the platform administrators' panel (one shared company
   token), so it is not "plumbing every signed-in person uses". */
const COMMON = /^\/api\/(auth|change-requests|notifications|feature-flags|files|requests|access)(\/|$)/;
function scoped(session, routes) {
  if (process.env.PROBE_SCOPE === "all" || session.admin) return routes;
  const mine = APP_ROUTES[session.app];
  return routes.filter((r) => COMMON.test(r.path) || (mine && mine.test(r.path)));
}
function oneEach(people) {
  if (process.env.PROBE_SCOPE === "all") return people;
  const seen = new Set();
  return people.filter((p) => (seen.has(p.as) ? false : (seen.add(p.as), true)));
}

/* ── 3. ask ────────────────────────────────────────────────────────────── */

async function probe(session, routes) {
  const refused = [];
  /* Not a refusal and not a pass: the server was unreachable or slow. A
     restart mid-run (nodemon, after an edit) used to read as "0 refused",
     which is the most misleading answer this tool could give. */
  refused.unreachable = 0;
  let i = 0;
  const worker = async () => {
    while (i < routes.length) {
      const r = routes[i++];
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(BASE + concrete(r.path), {
          headers: { Authorization: `Bearer ${ACCOUNTING.test(r.path) && session.accToken ? session.accToken : session.token}`, Accept: "application/json" },
          signal: ctrl.signal,
        });
        if (res.status === 401 || res.status === 403) {
          let body = {};
          try { body = await res.json(); } catch { /* not JSON */ }
          refused.push({ path: r.path, status: res.status, code: body.code || "", message: String(body.message || body.error || "").slice(0, 140) });
        } else {
          await res.arrayBuffer().catch(() => {});
        }
      } catch (err) {
        /* A timeout is a slow route, not a dead server — say which. */
        if (err?.name === "AbortError") { (refused.slow ||= []).push(r.path); continue; }
        /* The FIRST failure names the request in flight when the server
           stopped answering — with PROBE_CONCURRENCY=1, the one that took it
           down. A GET that crashes the process is a denial of service any
           signed-in user can trigger, so it is worth naming. */
        if (!refused.unreachable++) refused.firstDown = { path: r.path, url: concrete(r.path), after: refused.lastOk || null };
      } finally {
        refused.lastOk = refused.unreachable ? refused.lastOk : r.path;
        clearTimeout(t);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return refused;
}

/* Refusals the CEO SHOULD get — each a different kind of session, not a
   missing grant. Anything else refused to the platform admin is a defect and
   fails the run. Add to this list only with the reason beside it. */
const EXPECTED_FOR_ADMIN = [
  [/^\/api\/customer\//, "customer portal — a customer's own session"],
  [/^\/(api\/)?cowork\//, "cowork — Firebase ID tokens, not a CMS session"],
  [/^\/api\/cctv\/internal\//, "CCTV service — a machine key, not a person"],
  [/product-requests/, "legacy MRF records — answered only with ?scope=legacy"],
  [/^\/api\/cms\/inventory\/landed-costs\//, "called only from the accountant app, whose session is upgraded on sign-in"],
  [/^\/api\/vendor\//, "vendor portal — a vendor's own session"],
  [/^\/api\/employee\/auth\//, "employee mobile app sign-in — an app token"],
  [/^\/api\/employee\/(leave-applications|regularizations|overtime)\/manager\//, "mobile app 'my team' — the caller's OWN reports; a dept login has none"],
  [/^\/api\/employee\/payslip\//, "mobile app 'my payslip' — self-service; HR pages serve the CEO"],
];
const expectedWhy = (p) => (EXPECTED_FOR_ADMIN.find(([re]) => re.test(p)) || [])[1] || null;

(async () => {
  const mounts = mountsFromServer();
  const { routes, loadErrors } = walkRoutes(mounts);
  const safe = routes.filter((r) => !UNSAFE.test(r.path));
  console.log(`mounts ${mounts.length} · GET routes ${routes.length} · probed ${safe.length} (skipped ${routes.length - safe.length} that act)`);
  if (loadErrors.length) console.log(`routers that would not load here: ${loadErrors.length}\n  ${loadErrors.slice(0, 5).join("\n  ")}`);

  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const people = oneEach(await sessions(mongoose.connection.db));
  await mongoose.disconnect();

  const report = [];
  for (const s of people) {
    if (process.env.PROBE_SKIP_ADMIN && s.admin) continue;
    const mine = scoped(s, safe);
    const refused = await probe(s, mine);
    report.push({ who: s.who, as: s.as, admin: s.admin, refused, probed: mine.length, unreachable: refused.unreachable || 0 });
    console.log(`\n${s.who} — ${s.as}: ${refused.length} refused of ${mine.length}${refused.unreachable ? ` — ${refused.unreachable} UNREACHABLE (server down or slow): this result is incomplete` : ""}`);
    if (refused.slow) console.log(`   slower than ${TIMEOUT_MS} ms (not judged): ${refused.slow.join(", ")}`);
    if (refused.firstDown) console.log(`   server stopped answering at ${refused.firstDown.url} (last answered: ${refused.firstDown.after})`);
    const byCode = {};
    for (const r of refused) (byCode[`${r.status} ${r.code || r.message.slice(0, 50)}`] ||= []).push(r.path);
    for (const [k, paths] of Object.entries(byCode).sort((a, b) => b[1].length - a[1].length)) {
      console.log(`   ${String(paths.length).padStart(4)} × ${k}`);
      for (const p of paths.slice(0, s.admin ? 12 : 4)) console.log(`          ${p}`);
    }
  }
  const file = path.join(process.env.PROBE_OUT || require("os").tmpdir(), "access-probe.json");
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), base: BASE, routes: safe.length, report }, null, 2));
  console.log(`\nfull report: ${file}`);
  const admin = report.filter((r) => r.admin);
  const defects = admin.flatMap((r) => r.refused.filter((x) => !expectedWhy(x.path)));
  const unreachable = report.reduce((n, r) => n + r.unreachable, 0);
  console.log(`\nplatform admin: ${defects.length} unexpected refusal(s)${unreachable ? `, ${unreachable} unreachable` : ""}`);
  for (const d of defects) console.log(`   ✖ ${d.status} ${d.path} — ${d.code || d.message}`);
  /* Exit explicitly: the routers walked above start cron timers and pools at
     require time, so the process would otherwise never end. */
  process.exit(defects.length || unreachable ? 1 : 0);
})().catch((err) => {
  console.error("probe failed:", err.stack || err.message);
  process.exit(2);
});
