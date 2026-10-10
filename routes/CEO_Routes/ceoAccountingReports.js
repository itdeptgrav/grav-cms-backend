// routes/CEO_Routes/ceoAccountingReports.js
// ============================================================================
// CEO / admin READ-ONLY view of the accountant's financial reports.
//
// DESIGN GUARANTEE — "matches the accountant side exactly":
//   These endpoints do NOT recompute anything. Each one proxies to the SAME
//   accountant endpoint the accountant pages use, so the numbers are identical
//   by construction and a newly accepted entry appears here the instant it
//   appears for the accountant. No accountant file is modified.
//
// AUTH: ceoAuth (cookie auth_token, role ceo/admin). For the internal proxy
//   call only, a short-lived (2 min) server-side-only accountant token is
//   minted; it never reaches the browser and can only GET reports.
//
// READ-ONLY: every route is a GET.
//
// NOTE: requires Node 18+ (global fetch).
// ============================================================================

const express = require("express");
const jwt = require("jsonwebtoken");
const router = express.Router();
const {
  Acc_Company,
} = require("../../models/Accountant_model/Acc_MasterModels");

const { SECRET } = require("../../config/jwt"); // SEC-0: configured secret only

const SELF_BASE =
  process.env.SELF_API_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  "http://localhost:5000";

const ACC_REPORTS = "/api/accountant/tally/reports";
const ACC_COA = "/api/accountant/chart-of-accounts";
const ACC_RECON = "/api/accountant/bank-recon";
const ACC_OPS_REPORTS = "/api/accountant/reports";

// ── CEO auth (identical to the other CEO routes) ───────────────────────────
function ceoAuth(req, res, next) {
  try {
    let token = req.cookies?.auth_token;
    if (!token && req.headers.authorization?.startsWith("Bearer "))
      token = req.headers.authorization.split(" ")[1];
    if (!token && req.headers.cookie) {
      const m = req.headers.cookie.match(/auth_token=([^;]+)/);
      if (m) token = m[1];
    }
    if (!token)
      return res
        .status(401)
        .json({
          success: false,
          message: "Authentication required. Please log in.",
        });
    const decoded = jwt.verify(token, SECRET);
    if (!["ceo", "admin"].includes(decoded.role))
      return res
        .status(403)
        .json({ success: false, message: "CEO/admin access required." });
    req.ceoUser = decoded;
    next();
  } catch {
    return res
      .status(401)
      .json({ success: false, message: "Invalid or expired session." });
  }
}

async function resolveCompanyId(req) {
  if (req.query.companyId) return String(req.query.companyId);
  const co = await Acc_Company.findOne({ isActive: true })
    .sort({ isPrimary: -1, createdAt: -1 })
    .select("_id")
    .lean();
  return co ? String(co._id) : null;
}

/* ── THE CEO READS AS THEIR OWN ACCOUNTING ACCOUNT (6 Oct 2026) ──────────────
   This used to sign the internal request with a hand-made token in the OLD
   CMS shape — `role: "accountant"`, no organisation. Accounting was then
   hardened (Middlewear/AccountantOrgAuthMiddleware.js) to give that shape no
   access at all, answering 401 ACCOUNTING_SESSION_UPGRADE_REQUIRED, and the
   proxy passed that straight back: every CEO accounting page was refused.

   Now it signs as the signed-in person's OWN accounting account (Acc_User,
   matched by the email on their CEO session), with accounting's own
   organisation-aware token — so accounting's permissions, company scoping
   and revocation apply to the CEO exactly as to anybody else. Somebody with
   no accounting account is told so, instead of being shown an upgrade
   error about a session they never had. Short-lived; never leaves the
   server. */
async function mintReadToken(req) {
  const { Acc_User } = require("../../models/Accountant_model/Acc_OrgModels");
  const { signOrgToken } = require("../../Middlewear/AccountantOrgAuthMiddleware");
  const email = String(req.ceoUser?.email || "").toLowerCase().trim();
  if (!email) return null;
  const user = await Acc_User.findOne({ email, isActive: { $ne: false } }).lean();
  return user ? signOrgToken(user, "2m") : null;
}

// Forward a GET to an internal endpoint with the minted token; pass JSON through.
async function passThrough(url, res, req) {
  try {
    const token = await mintReadToken(req);
    if (!token) {
      return res.status(403).json({
        success: false,
        code: "NO_ACCOUNTING_ACCOUNT",
        message: `${req.ceoUser?.email || "This account"} has no accounting account. Ask the accounting owner to add it (Accounting › Settings › Users).`,
      });
    }
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await r.text();
    res.status(r.status);
    try {
      return res.json(JSON.parse(text));
    } catch {
      return res.send(text);
    }
  } catch (e) {
    return res
      .status(502)
      .json({ success: false, message: `Could not load report: ${e.message}` });
  }
}

// Proxy a company-scoped report, forwarding the params the endpoints understand.
async function proxyReport(reportPath, req, res) {
  const companyId = await resolveCompanyId(req);
  if (!companyId)
    return res
      .status(404)
      .json({
        success: false,
        message: "No active company found in the accounting system.",
      });

  const params = new URLSearchParams({ companyId });
  for (const k of [
    "asOf",
    "from",
    "to",
    "dateFrom",
    "dateTo",
    "endDate",
    "startDate",
    "page",
    "limit",
    "year",
    "fyMode",
    "bankLedgerId",
    "skip",
    "type",
    "cache",
    "returnType",
    "amountTolerance",
    "dateTolerance",
    "section",
  ]) {
    if (req.query[k] !== undefined && req.query[k] !== "")
      params.set(k, req.query[k]);
  }

  return passThrough(`${SELF_BASE}${reportPath}?${params.toString()}`, res, req);
}

// ── Which company (for the page header) ────────────────────────────────────
router.get("/company", ceoAuth, async (req, res) => {
  try {
    const co = await Acc_Company.findOne({ isActive: true })
      .sort({ isPrimary: -1, createdAt: -1 })
      .lean();
    res.json({ success: true, company: co || null });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── Core financial statements (mirror the accountant report set) ───────────
router.get("/trial-balance", ceoAuth, (req, res) =>
  proxyReport(`${ACC_COA}/trial-balance`, req, res),
);
router.get("/balance-sheet", ceoAuth, (req, res) =>
  proxyReport(`${ACC_REPORTS}/balance-sheet`, req, res),
);
router.get("/profit-loss", ceoAuth, (req, res) =>
  proxyReport(`${ACC_REPORTS}/profit-loss`, req, res),
);
router.get("/day-book", ceoAuth, (req, res) =>
  proxyReport(`${ACC_REPORTS}/day-book`, req, res),
);
router.get("/cash-flow", ceoAuth, (req, res) =>
  proxyReport(`${ACC_REPORTS}/cash-flow`, req, res),
);
router.get("/gst", ceoAuth, (req, res) =>
  proxyReport(`${ACC_REPORTS}/gst-summary`, req, res),
);
router.get("/data-range", ceoAuth, (req, res) =>
  proxyReport(`${ACC_REPORTS}/data-range`, req, res),
);

// ── Receivables / Payables aging (operational PO + sales-order pipeline) ───
router.get("/receivables-aging", ceoAuth, (req, res) =>
  proxyReport(`${ACC_OPS_REPORTS}/receivables-aging`, req, res),
);
router.get("/payables-aging", ceoAuth, (req, res) =>
  proxyReport(`${ACC_OPS_REPORTS}/payables-aging`, req, res),
);

// ── GST reconciliation (GSTR-2B vs books) — read-only ──────────────────────
router.get("/gst-recon/periods", ceoAuth, (req, res) =>
  proxyReport("/api/accountant/gstr2b/periods", req, res),
);
router.get("/gst-recon/:period", ceoAuth, (req, res) =>
  proxyReport(
    `/api/accountant/gstr2b/${encodeURIComponent(req.params.period)}/recon`,
    req,
    res,
  ),
);

// ── Bank reconciliation (read-only): history + monthly/annual rollup ───────
router.get("/bank-recon/sessions", ceoAuth, (req, res) =>
  proxyReport(`${ACC_RECON}/sessions`, req, res),
);
router.get("/bank-recon/annual-summary", ceoAuth, (req, res) =>
  proxyReport(`${ACC_RECON}/annual-summary`, req, res),
);
router.get("/bank-recon/bank-ledgers", ceoAuth, (req, res) =>
  proxyReport(`${ACC_RECON}/bank-ledgers`, req, res),
);
router.get("/bank-recon/session/:id", ceoAuth, (req, res) =>
  passThrough(
    `${SELF_BASE}${ACC_RECON}/sessions/${encodeURIComponent(req.params.id)}`,
    res,
    req,
  ),
);

// ── Ledger drill-down (read-only): full statement for one ledger ───────────
router.get("/ledger/:id/statement", ceoAuth, async (req, res) => {
  const params = new URLSearchParams();
  for (const k of ["startDate", "endDate", "from", "to"]) {
    if (req.query[k]) params.set(k, req.query[k]);
  }
  return passThrough(
    `${SELF_BASE}${ACC_COA}/ledgers/${encodeURIComponent(
      req.params.id,
    )}/statement?${params.toString()}`,
    res,
    req,
  );
});

// ── Ledger list (read-only) — for a "jump to ledger" picker if needed ──────
router.get("/ledgers", ceoAuth, async (req, res) => {
  const companyId = await resolveCompanyId(req);
  if (!companyId)
    return res
      .status(404)
      .json({ success: false, message: "No active company found." });
  const params = new URLSearchParams({
    companyId,
    limit: req.query.limit || "1000",
  });
  return passThrough(
    `${SELF_BASE}${ACC_COA}/ledgers?${params.toString()}`,
    res,
    req,
  );
});

module.exports = router;
