// routes/accountant.routes.js
//
// Single mounting point for the entire accountant module.
// Just `require` this once from server.js — see SETUP_INSTRUCTIONS.md.
//
// Why a wrapper file?
// Importing 17 routes manually in server.js is fragile (one typo and the whole
// module 404s). This file does it once, in the right order, with a sanity-check
// log. server.js calls `app.use("/api/accountant", require("./routes/accountant.routes"))`
// and that's it.

const express = require("express");
const router = express.Router();

// === health probe — open in browser to verify mounting ===
// http://localhost:5000/api/accountant/_health
router.get("/_health", (req, res) => {
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    message: "Accountant module is mounted ✓",
    routes: [
      "GET  /dashboard",
      "GET  /customers",
      "GET  /vendors",
      "GET  /invoices",
      "GET  /expenses",
      "GET  /bank-transactions",
      "GET  /tax-filings",
      "GET  /budgets",
      "GET  /journal-entries",
      "GET  /payroll/runs",
      "GET  /settings",
      "GET  /tally/companies",
      "GET  /chart-of-accounts/tree?companyId=...",
      "GET  /vouchers?companyId=...&voucherType=sales",
      "GET  /tally/import/sessions?companyId=...",
      "GET  /tally/reports/trial-balance?companyId=...",
      "GET  /reports/gst",
    ],
  });
});

// === routes that use AccountantAuthMiddleware.accountantAuth (existing files) ===
const mounts = [
  // /auth must be reachable without a prior login — its middleware is
  // self-contained (login/bootstrap/accept-invite are public, the others
  // gate themselves with orgAuth internally).
  ["/auth", "./Accountant_Routes/accountantAuthRoutes"],

  // /team — sub-account management. Requires orgAuth (mounted internally).
  ["/team", "./Accountant_Routes/teamRoutes"],

  // /approvals — pending change queue. Requires orgAuth (mounted internally).
  ["/approvals", "./Accountant_Routes/approvalRoutes"],

  ["/dashboard", "./Accountant_Routes/dashboard"],
  ["/expenses", "./Accountant_Routes/expenses"],
  ["/invoices", "./Accountant_Routes/invoices"],
  ["/vendors", "./Accountant_Routes/vendors"],
  ["/customers", "./Accountant_Routes/customersRoutes"],
  ["/journal-entries", "./Accountant_Routes/journalEntries"],
  ["/payroll", "./Accountant_Routes/payroll"],
  ["/reports", "./Accountant_Routes/reports"],
  ["/settings", "./Accountant_Routes/settings"],
  ["/tax-filings", "./Accountant_Routes/taxFilings"],
  ["/bank-transactions", "./Accountant_Routes/bankTransactions"],
  ["/budgets", "./Accountant_Routes/budgets"],

  // === books / vouchers / import (new files) ===
  ["/chart-of-accounts", "./Accountant_Routes/tallyChartOfAccounts"],
  ["/tally/companies", "./Accountant_Routes/tallyCompanies"],
  ["/tally/import", "./Accountant_Routes/tallyImport"],
  ["/tally/reports", "./Accountant_Routes/tallyReports"],
  ["/vouchers", "./Accountant_Routes/tallyVouchers"],
];

let mounted = 0;
let failed = [];

for (const [path, modulePath] of mounts) {
  try {
    router.use(path, require(modulePath));
    mounted++;
  } catch (err) {
    failed.push({ path, modulePath, error: err.message });
    console.error(`❌ [accountant] failed to mount ${path}:`, err.message);
  }
}

// === Setu AA — special handling: this module exports BOTH a public router
//   (for Setu webhook callbacks, no auth) and a protected router (for our
//   own UI calls). We mount the public one first so its /webhook route is
//   reachable without the accountant auth middleware blocking Setu. ===
try {
  const setuMod = require("./Accountant_Routes/setuAA");
  // Public webhook lives at /setu-aa/webhook — mount the public router at /setu-aa
  router.use("/setu-aa", setuMod.publicRouter);
  // Then mount the auth-protected routes on top of the same path. Express
  // matches in order, so the webhook handler above hits first for /webhook
  // and the protected handlers catch everything else.
  router.use("/setu-aa", setuMod.router);
  mounted++;
  console.log(
    "✓ [accountant] mounted /setu-aa (public webhook + protected routes)",
  );
} catch (err) {
  failed.push({
    path: "/setu-aa",
    modulePath: "./Accountant_Routes/setuAA",
    error: err.message,
  });
  console.error("❌ [accountant] failed to mount /setu-aa:", err.message);
}

console.log(`✓ [accountant] mounted ${mounted}/${mounts.length} routes`);
if (failed.length > 0) {
  console.error(
    `⚠️  [accountant] ${failed.length} routes failed to load — see above`,
  );
}

module.exports = router;
