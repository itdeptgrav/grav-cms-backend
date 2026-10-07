#!/usr/bin/env node
"use strict";
/**
 * scripts/pageSweep.js — open EVERY CMS page as a real person and report what
 * they would see go wrong.
 *
 *   npm run verify:pages                          # as ceo@grav.in
 *   SWEEP_AS=someone@grav.in npm run verify:pages # as anybody with a login/grant
 *   SWEEP_ONLY=/accountant npm run verify:pages   # pages under a prefix
 *
 * Why this exists next to scripts/accessProbe.js: that one calls every API
 * route with a placeholder id and looks for 401/403. It cannot see what a PAGE
 * does — a page that forgets to send `companyId` gets a 400 the probe never
 * asks for, and the person gets an alert box (6 Oct 2026, a posted journal
 * voucher: "companyId is required for this request."). This drives the real
 * frontend in headless Chromium, so whatever the person would meet, it meets.
 *
 * Per page it records:
 *   • every alert/confirm/prompt the page raised (alerts are how most of these
 *     pages report a failed request);
 *   • every API response >= 400, with the server's own message;
 *   • every uncaught page error (a crash the person sees as a blank screen);
 *   • permission wording rendered on the page ("do not have permission",
 *     "access denied", "not authorised", "required for this request").
 *
 * READ-ONLY. Every POST/PUT/PATCH/DELETE to the backend is BLOCKED in the
 * browser before it leaves, except the session bootstrap calls listed in
 * WRITE_ALLOW (they only refresh a login). A blocked write is reported as
 * such, never as a failure. Confirm dialogs are dismissed ("Cancel").
 *
 * Pages with an id in the address are visited with REAL ids: each one found as
 * a link on a page already visited is opened once per route shape.
 *
 * Needs the backend (BACKEND, default http://localhost:5000) and the frontend
 * (FRONTEND, default http://localhost:3001) running, and this repo's .env (the
 * session is signed exactly as the server signs it).
 */

require("dotenv").config({ quiet: true });
process.env.BACKGROUND_JOBS = "off";

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const ROOT = path.join(__dirname, "..");
const FRONTEND = process.env.FRONTEND || "http://localhost:3001";
const BACKEND = process.env.BACKEND || "http://localhost:5000";
const APP_DIR = process.env.SWEEP_APP_DIR || path.join(ROOT, "..", "grav-cms", "app");
const AS = (process.env.SWEEP_AS || "ceo@grav.in").toLowerCase();
const ONLY = process.env.SWEEP_ONLY || "";
const CONCURRENCY = Number(process.env.SWEEP_CONCURRENCY || 3);
const SETTLE_MS = Number(process.env.SWEEP_SETTLE_MS || 2500);
const NAV_TIMEOUT = Number(process.env.SWEEP_TIMEOUT_MS || 60000);
const OUT = process.env.SWEEP_OUT || path.join(require("os").tmpdir(), "page-sweep.json");

const WRITE_ALLOW = [/\/api\/accountant\/auth\/sync-legacy$/, /\/api\/auth\/(verify|refresh|session)/, /socket\.io/];
const WORDS = /(do(?:es)? not have permission|don't have permission|access denied|not authori[sz]ed|permission denied|required for this request|you are not allowed)/i;

/* Pages that are not for a signed-in person, or that would act on load. */
const SKIP = [
  /^\/(login|logout|coworking-login|accountant\/login)(\/|$)/,
  /^\/face-enroll/, /^\/preview(\/|$)/, /^\/testodia/, /^\/barcode-scanner-device/,
  /^\/project-manager(\/|$)/, // catch-all forwarder
];

/* ── routes from the app directory ─────────────────────────────────────── */
function routesFrom(dir, base = "") {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory()) {
      if (/^page\.(js|jsx|tsx|ts)$/.test(ent.name)) out.push(base || "/");
      continue;
    }
    const n = ent.name;
    if (n.startsWith("_") || n === "api" || n.startsWith("@")) continue;
    const seg = /^\(.*\)$/.test(n) ? "" : `/${n}`; // route groups add nothing
    out.push(...routesFrom(path.join(dir, n), base + seg));
  }
  return out;
}
const isDynamic = (r) => /\[/.test(r);
const shapeRe = (r) =>
  new RegExp("^" + r.replace(/\/\[\[\.\.\.[^\]]+\]\]/g, "(?:/.*)?").replace(/\[\.\.\.[^\]]+\]/g, ".+").replace(/\[[^\]]+\]/g, "[^/]+") + "/?$");

/* ── the session, signed as the server signs it ────────────────────────── */
async function session(db) {
  const { buildTokenPayload, signToken } = require(path.join(ROOT, "routes/auth/deptAuth"));
  const deptUser = await db.collection("dept_users").findOne({ email: AS, isActive: { $ne: false } });
  if (deptUser) {
    const dept = await db.collection("access_departments").findOne({ _id: deptUser.departmentId });
    return { token: signToken(buildTokenPayload(deptUser, dept)), home: dept?.homePath || "/ceo/dashboard" };
  }
  const grant = await db.collection("department_roles").findOne({ email: AS, isActive: true });
  const rec = await db.collection("employees").findOne({ email: AS });
  if (!grant || !rec) throw new Error(`No login or grant for ${AS}`);
  const app = await db.collection("access_departments").findOne({ slug: grant.departmentSlug });
  const token = signToken({
    v: 2, id: String(rec._id), role: app.legacyRole || app.slug, userType: app.legacyUserType || app.slug,
    deptId: String(app._id), deptSlug: app.slug, employeeId: rec.biometricId || "",
    name: `${rec.firstName || ""} ${rec.lastName || ""}`.trim(), email: rec.email, isAdmin: false, subject: "employee", tv: 0,
  });
  return { token, home: app.homePath || "/" };
}

/* ── real ids for pages with an id in the address ──────────────────────────
   Most lists open a row by click, not by link, so link discovery alone reaches
   few of them. Each entry names where that page's id comes from: a literal, or
   { c: collection, q: filter, f: field (default _id) } — one real record. A
   page whose seed finds nothing is listed as not visited, never guessed. */
const MO = { c: "customerrequests", q: { status: { $nin: ["draft", "cancelled", "rejected"] } } };
const WO = { c: "workorders" };
const SEEDS = {
  financialYear: "2026-27", month: "2026-10", type: "journal", app: "hr", stage: "enquiry",
  "/accountant/budgets/fy/[financialYear]/departments/[department]": { department: { c: "acc_budget_departments", f: "code" } },
  "/accountant/budgets/fy/[financialYear]/heads/[ledgerId]": { ledgerId: { c: "acc_ledgers" } },
  "/accountant/budgets/fy/[financialYear]/requests/[requestId]": { requestId: { c: "acc_budgets" } },
  "/accountant/chart-of-accounts/group/[id]": { id: { c: "acc_groups" } },
  "/accountant/contra-vouchers/[id]/edit": { id: { c: "acc_vouchers", q: { voucherType: /contra/i } } },
  "/accountant/credit-notes/[id]/edit": { id: { c: "acc_credit_debit_notes", q: { noteType: /credit/i } } },
  "/accountant/debit-notes/[id]/edit": { id: { c: "acc_credit_debit_notes", q: { noteType: /debit/i } } },
  "/accountant/customers/[id]": { id: { c: "acc_ledgers", q: { partyType: /customer/i } } },
  "/accountant/departments/[dept]": { dept: { c: "acc_budget_departments", f: "code" } },
  "/accountant/invoices/[id]": { id: { c: "acc_invoices" } },
  "/accountant/invoices/[id]/print": { id: { c: "acc_invoices" } },
  "/accountant/ledger/[id]": { id: { c: "acc_ledgers" } },
  "/accountant/payables/spend-approvals/[id]": { id: { c: "spendrequests" } },
  "/accountant/proforma-invoices/[id]": { id: { c: "acc_proforma_invoices" } },
  "/accountant/purchase-vouchers/[id]/landed-costs": { id: { c: "acc_vouchers", q: { voucherType: /purchase/i, status: "posted" } } },
  "/accountant/vouchers/view/[id]": { id: { c: "acc_vouchers", q: { voucherType: /journal/i, status: "posted" } } },
  "/budget/heads/[ledgerId]": { ledgerId: { c: "acc_ledgers" } },
  "/ceo/dashboard/accounting/bank-reconciliation/[id]": { id: { c: "acc_bank_recon_sessions" } },
  "/ceo/dashboard/accounting/ledger/[id]": { id: { c: "acc_ledgers" } },
  "/ceo/dashboard/inventory/vendors/[id]": { id: { c: "vendors" } },
  "/costing/[id]": { id: { c: "costings" } },
  "/cutting-master/dashboard/assigned-work/[moId]": { moId: MO },
  "/employee/[identityID]": { identityID: { c: "employees", q: { identityId: { $exists: true, $ne: null } }, f: "identityId" } },
  "/files/view/[fileId]": { fileId: { c: "doc_files" } },
  "/hr/dashboard/departments/[id]": { id: { c: "departments" } },
  "/hr/dashboard/departments/[id]/edit": { id: { c: "departments" } },
  "/hr/dashboard/employees/[id]": { id: { c: "employees", q: { status: { $ne: "inactive" } } } },
  "/hr/dashboard/employees/view-employee/[id]": { id: { c: "employees", q: { status: { $ne: "inactive" } } } },
  "/hr/dashboard/recruitment/[id]": { id: { c: "jobpostings" } },
  "/hr/dashboard/recruitment/[id]/new-candidate": { id: { c: "jobpostings" } },
  "/hr/dashboard/vendors/edit/[id]": { id: { c: "vendordetails" } },
  "/hr/dashboard/vendors/view/[id]": { id: { c: "vendordetails" } },
  "/industrial-engineering/development/[styleId]": { styleId: { c: "samplestyles" } },
  "/industrial-engineering/machines/add-edit-machine/[id]": { id: { c: "machines" } },
  "/industrial-engineering/orders/[orderId]": { orderId: MO },
  "/merchandiser/customer-requests/[id]": { id: MO },
  "/merchandiser/customers/[id]": { id: { c: "customers" } },
  "/merchandiser/development/[fileId]": { fileId: { c: "merchandising_development_files" } },
  "/merchandiser/products/stock-item-view/[id]": { id: { c: "stockitems" } },
  "/merchandiser/products/new-stock-item/[id]": { id: { c: "stockitems" } },
  "/merchandiser/styles/[id]": { id: { c: "samplestyles" } },
  "/packaging-dispatch/dashboard/cartons/[cartonNumber]": { cartonNumber: { c: "packingcartons", f: "cartonNumber" } },
  "/packaging-dispatch/dashboard/manufacturing-orders/[id]": { id: MO },
  "/ppc/departments/[department]": { department: "cutting" },
  "/ppc/orders/[moId]": { moId: MO },
  "/ppc/planning/orders/[id]": { id: MO },
  "/ppc/planning/work-orders/[id]": { id: WO },
  "/ppc/planning/work-orders/[id]/plan": { id: WO },
  "/ppc/work-orders/[woId]": { woId: WO },
  "/production-supervisor/dashboard/orders/[moId]": { moId: MO },
  "/production-supervisor/products/stock-item-view/[id]": { id: { c: "stockitems" } },
  "/qc/dashboard/checkpoint/[id]": { id: { c: "qc_stages" } },
  "/qc/dashboard/orders/[moId]": { moId: MO },
  "/qc/dashboard/raw-items/orders/[moId]": { moId: MO },
  "/research-development/styles/[id]": { id: { c: "samplestyles" } },
  "/sales/dashboard/accounts/[id]": { id: { c: "crmaccounts" } },
  "/sales/dashboard/customer-requests/[id]": { id: MO },
  "/sales/dashboard/customers/[id]": { id: { c: "customers" } },
  "/sales/dashboard/journeys/[journeyId]": { journeyId: { c: "salesjourneys", q: { companyId: { $ne: null }, deletedAt: null } } },
  "/sales/dashboard/leads/[id]": { id: { c: "leads" } },
  "/sales/dashboard/leads/[id]/edit": { id: { c: "leads" } },
  "/sales/dashboard/prospects/[id]": { id: { c: "leads" } },
  "/sales/dashboard/raw-items/raw-items-view/[id]": { id: { c: "rawitems" } },
  "/sales/dashboard/stock-items/stock-item-view/[id]": { id: { c: "stockitems" } },
  "/store/dashboard/operations/customer-materials/[id]": { id: { c: "goodsreceipts", q: { receiptType: /customer/i } } },
  "/store/dashboard/operations/goods-receipts/[id]": { id: { c: "goodsreceipts" } },
  "/store/dashboard/operations/purchase-order/[id]": { id: { c: "purchaseorders" } },
  "/store/dashboard/operations/purchase-order/[id]/receive": { id: { c: "purchaseorders", q: { status: { $in: ["ISSUED", "PARTIALLY_RECEIVED"] } } } },
  "/store/dashboard/operations/purchase-order/new-edit-purchase-order/[id]": { id: { c: "purchaseorders", q: { status: "DRAFT" } } },
  "/store/dashboard/operations/service-orders/[id]": { id: { c: "serviceorders" } },
  "/store/dashboard/order-requests/[id]": { id: { c: "intakerequests" } },
  "/store/dashboard/raw-items/raw-items-view/[id]": { id: { c: "rawitems" } },
  "/store/dashboard/raw-items/add-edit-raw-item/[id]": { id: { c: "rawitems" } },
  "/store/dashboard/supplier-offers/[id]": { id: { c: "supplieroffers" } },
  "/store/dashboard/supplier-offers/services/[id]": { id: { c: "servicesupplieroffers" } },
  "/store/dashboard/vendors-buyer/vendors/view/[id]": { id: { c: "vendors" } },
  "/store/dashboard/vendors-buyer/vendors/add-edit-vendor/[id]": { id: { c: "vendors" } },
  "/embroidery/dashboard/orders/[id]": { id: MO },
  "/printing/dashboard/orders/[id]": { id: MO },
  "/washing/dashboard/orders/[id]": { id: MO },
  "/trimming/dashboard/orders/[id]": { id: MO },
  "/ironing/dashboard/orders/[id]": { id: MO },
};

async function seedPath(db, route) {
  const spec = SEEDS[route] || {};
  let out = route;
  for (const [, name] of route.matchAll(/\[([^\]]+)\]/g)) {
    const s = spec[name] ?? SEEDS[name];
    if (s == null) return null;
    let v = s;
    if (typeof s === "object") {
      const doc = await db.collection(s.c).find(s.q || {}).sort({ _id: -1 }).limit(1).next().catch(() => null);
      v = doc && doc[s.f || "_id"];
      if (v == null || v === "") return null;
    }
    out = out.replace(`[${name}]`, encodeURIComponent(String(v)));
  }
  return out;
}

/* ── one page ──────────────────────────────────────────────────────────── */
async function visit(browser, token, url) {
  const page = await browser.newPage();
  const found = { url, alerts: [], failed: [], errors: [], words: [], blockedWrites: [] };
  await page.evaluateOnNewDocument((t) => {
    try { localStorage.setItem("acc_token", t); } catch {}
  }, token);
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const u = req.url();
    const m = req.method();
    if (u.startsWith(BACKEND) && !["GET", "HEAD", "OPTIONS"].includes(m) && !WRITE_ALLOW.some((re) => re.test(u.split("?")[0]))) {
      found.blockedWrites.push(`${m} ${u.replace(BACKEND, "")}`);
      return req.abort("blockedbyclient");
    }
    req.continue();
  });
  page.on("dialog", async (d) => {
    found.alerts.push(`${d.type()}: ${d.message()}`);
    await d.dismiss().catch(() => {});
  });
  page.on("pageerror", (e) => found.errors.push(String(e?.message || e).slice(0, 300)));
  const okLater = new Set();
  page.on("response", async (res) => {
    const u = res.url();
    if (!u.startsWith(BACKEND)) return;
    if (res.status() < 400) { okLater.add(`${res.request().method()} ${u.split("?")[0]}`); return; }
    let msg = "";
    try { const j = await res.json(); msg = j.code ? `${j.code} ${j.message || ""}` : j.message || j.error || ""; } catch {}
    found.failed.push(`${res.status()} ${res.request().method()} ${u.replace(BACKEND, "").split("?")[0]} — ${String(msg).slice(0, 160)}`);
  });

  let links = [];
  try {
    await page.goto(url, { waitUntil: "load", timeout: NAV_TIMEOUT });
    /* Scan screens and live boards poll for ever, so "network idle" may never
       come. Wait for it a while; a page that keeps polling is not a failure. */
    await page.waitForNetworkIdle({ idleTime: 800, timeout: 20000 }).catch(() => { found.neverIdle = true; });
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const text = await page.evaluate(() => document.body?.innerText || "");
    const m = text.match(new RegExp(WORDS.source, "gi"));
    if (m) found.words = [...new Set(m)];
    found.finalPath = new URL(page.url()).pathname;
    links = await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")));
  } catch (err) {
    found.errors.push(`navigation: ${err.message}`);
  }
  await page.close().catch(() => {});
  /* A request refused and then retried successfully (the accounting session
     upgrade does exactly that) is not something the person saw. */
  found.failed = found.failed.filter((f) => {
    const [, method, p] = f.match(/^\d+ (\w+) (\S+)/) || [];
    return !okLater.has(`${method} ${BACKEND}${p}`);
  });
  return { found, links };
}

(async () => {
  const puppeteer = require("puppeteer");
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const { token } = await session(mongoose.connection.db);

  const all = [...new Set(routesFrom(APP_DIR))].filter((r) => !SKIP.some((re) => re.test(r)) && r.startsWith(ONLY || "/"));
  const statics = all.filter((r) => !isDynamic(r));
  const dynamics = all.filter(isDynamic).map((r) => ({ route: r, re: shapeRe(r), done: false }));
  for (const d of dynamics) {
    const p = await seedPath(mongoose.connection.db, d.route);
    if (p) { statics.push(p); d.done = true; }
  }
  await mongoose.disconnect();
  console.log(`as ${AS} · ${statics.length} pages + ${dynamics.length} page shapes with an id (visited when a real link is found)`);

  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  /* The backend's session cookie, set on the backend host exactly as login does. */
  const { hostname } = new URL(BACKEND);
  const ctx = browser.defaultBrowserContext();
  await ctx.setCookie({ name: "auth_token", value: token, domain: hostname, path: "/", httpOnly: true });

  const queue = statics.map((r) => FRONTEND + r);
  const seen = new Set(queue);
  const results = [];
  let n = 0;
  const worker = async () => {
    while (queue.length) {
      const url = queue.shift();
      const { found, links } = await visit(browser, token, url);
      results.push(found);
      if (++n % 25 === 0) console.log(`  ${n} visited, ${queue.length} queued`);
      for (const href of links) {
        if (!href || !href.startsWith("/")) continue;
        const p = href.split(/[?#]/)[0];
        const shape = dynamics.find((d) => !d.done && d.re.test(p));
        if (!shape) continue;
        shape.done = true;
        const full = FRONTEND + href;
        if (!seen.has(full)) { seen.add(full); queue.push(full); }
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await browser.close();

  const bad = results.filter((r) => r.alerts.length || r.failed.length || r.errors.length || r.words.length);
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), as: AS, visited: results.length, unvisitedShapes: dynamics.filter((d) => !d.done).map((d) => d.route), results }, null, 2));
  console.log(`\nvisited ${results.length} pages · ${bad.length} with a problem\n`);
  for (const r of bad) {
    console.log(r.url.replace(FRONTEND, "") + (r.finalPath && r.finalPath !== new URL(r.url).pathname ? `  → ${r.finalPath}` : ""));
    for (const a of r.alerts) console.log(`   ALERT   ${a}`);
    for (const f of [...new Set(r.failed)]) console.log(`   FAILED  ${f}`);
    for (const e of [...new Set(r.errors)]) console.log(`   CRASH   ${e}`);
    if (r.words.length) console.log(`   SHOWS   ${r.words.join(" | ")}`);
  }
  console.log(`\nfull report: ${OUT}`);
  process.exit(bad.length ? 1 : 0);
})().catch((err) => {
  console.error("sweep failed:", err.stack || err.message);
  process.exit(2);
});
