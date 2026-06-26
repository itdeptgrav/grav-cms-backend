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

const SECRET = process.env.JWT_SECRET || "grav_clothing_secret_key";

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

function mintReadToken() {
  return jwt.sign(
    {
      id: "ceo-readonly-proxy",
      role: "accountant",
      userType: "accountant",
      name: "CEO Read-Only",
      _ceoProxy: true,
    },
    SECRET,
    { expiresIn: "2m" },
  );
}

// Forward a GET to an internal endpoint with the minted token; pass JSON through.
async function passThrough(url, res) {
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${mintReadToken()}` },
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

  return passThrough(`${SELF_BASE}${reportPath}?${params.toString()}`, res);
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
  );
});

module.exports = router;
