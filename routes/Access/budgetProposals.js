// routes/Access/budgetProposals.js
//
// The department-facing budget surface: /api/budget-proposals
//
// A Sales or Production head needs to propose budget and see finance's answer.
// They must not need — or get — the accounting module to do it.
//
// ── THREE FACTS THAT DECIDED THE SHAPE ──────────────────────────────────────
//
// 1. It cannot live under /api/accountant. The frontend attaches the CMS
//    department token through lib/authFetch.js, which deliberately SKIPS
//    /api/accountant/* so a department session never reaches the books. A
//    proposals route mounted there would arrive unauthenticated.
//
// 2. There is no department-portal auth middleware to mount in front of it.
//    SalesAuthMiddlewear and EmployeeAuthMiddlewear — which guard essentially
//    every department API route — strip the department claims off the token
//    entirely. So this router authenticates itself, exactly as
//    routes/Access/changeRequests.js does and for the same reason.
//
// 3. requireDepartmentRole and changeRequests' canRead both FAIL OPEN when a
//    department has no role rows assigned, which today is every department
//    except accounting. That rule is right for a migration; it is wrong for a
//    money boundary. Nothing here fails open: an unmapped caller sees an empty
//    list and can write nothing.
//
// ── HOW A CALLER IS MAPPED TO A BUDGET DEPARTMENT ───────────────────────────
// The token's `deptSlug` says which PORTAL they signed into ("sales"). That is
// not a budget department — Acc_BudgetDepartment holds cost departments
// ("Logistics", "Admin"), a different vocabulary on purpose. The link is the
// explicit `accessSlug` field on the registry, read from the database on every
// request rather than trusted from the token: the claim says who they are, the
// database says what that entitles them to.
//
// A portal with no linked department maps to NOTHING. Never to everything.

const express = require("express");
const jwt = require("jsonwebtoken");
const router = express.Router();

const { SECRET, LEGACY_SECRETS, readToken } = require("../../config/jwt");
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");
const { Acc_Company, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_BudgetDepartment } = require("../../models/Accountant_model/Acc_BudgetDepartment");
const departments = require("../../services/budgetDepartment.service");
const proposals = require("../../services/budgetProposals.service");
const actuals = require("../../services/budgetActuals.service");
const variance = require("../../services/budgetVariance.service");

/** Same self-authentication as changeRequests: this router sits outside every
 *  department's middleware, so it reads and verifies the session itself. */
function authenticate(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ success: false, message: "Not authenticated" });

  const verify = () => {
    try {
      return jwt.verify(token, SECRET);
    } catch (err) {
      for (const legacy of LEGACY_SECRETS) {
        try {
          return jwt.verify(token, legacy);
        } catch {
          /* try the next */
        }
      }
      throw err;
    }
  };

  try {
    const decoded = verify();
    req.user = {
      id: decoded.id,
      email: String(decoded.email || "").toLowerCase(),
      name: decoded.name || "",
      isAdmin: Boolean(decoded.isAdmin),
      /* The portal they signed into. NOT a budget department — see the header.
       * `role` is deliberately not read: a platform admin browsing into Sales
       * carries role:"sales", so role cannot answer either "who is this" or
       * "which department". */
      deptSlug: String(decoded.deptSlug || "").toLowerCase(),
    };
    next();
  } catch {
    res.status(401).json({ success: false, message: "Invalid or expired session" });
  }
}

router.use(authenticate);

/**
 * The budget departments this caller may act for, in one company.
 *
 * Re-read from the database every request. The token says which portal; the
 * registry says which cost departments that portal owns, and an administrator
 * can revoke that by clearing one field without waiting for a token to expire.
 */
async function allowedFor(req, companyId) {
  if (!req.user.deptSlug) return [];
  const rows = await departments.departmentsForAccessSlug({
    companyId,
    accessSlug: req.user.deptSlug,
  });
  return rows;
}

const slugsOf = (rows) => rows.map((r) => r.slug);

/** Company scope must be explicit, and must be one the caller is mapped in. */
async function scope(req, res) {
  const companyId = actuals.oid(req.query.companyId || req.body?.companyId);
  if (!companyId) {
    res.status(400).json({ success: false, message: "A company is required." });
    return null;
  }
  const allowed = await allowedFor(req, companyId);
  if (!allowed.length) {
    /* 200 with nothing rather than 403: a department that has simply not been
     * linked yet is not doing anything wrong, and a refusal here would read as
     * a bug to whoever is trying to submit a budget. The write paths DO
     * refuse — see canSubmitFor. */
    return { companyId, allowed, slugs: [] };
  }
  return { companyId, allowed, slugs: slugsOf(allowed) };
}

/* ── CONTEXT ─────────────────────────────────────────────────────────────────
 * Where a department user starts: which companies they may propose in, and as
 * which department. Returns only companies where THIS portal is mapped, so it
 * is not a directory of the group's books. */
router.get("/context", async (req, res) => {
  try {
    if (!req.user.deptSlug) {
      return res.json({ success: true, portal: null, companies: [] });
    }
    const rows = await Acc_BudgetDepartment.find({
      accessSlug: req.user.deptSlug,
      isActive: { $ne: false },
    })
      .select("_id companyId slug name")
      .lean();

    const byCompany = new Map();
    for (const r of rows) {
      const k = String(r.companyId);
      if (!byCompany.has(k)) byCompany.set(k, []);
      byCompany.get(k).push({ slug: r.slug, name: r.name });
    }

    const companies = await Acc_Company.find({ _id: { $in: [...byCompany.keys()] } })
      .select("_id companyName")
      .lean();

    res.json({
      success: true,
      portal: req.user.deptSlug,
      companies: companies.map((c) => ({
        _id: c._id,
        name: c.companyName,
        departments: byCompany.get(String(c._id)) || [],
      })),
    });
  } catch (error) {
    console.error("[budget-proposals] context error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── OPEN CYCLES ─────────────────────────────────────────────────────────── */
router.get("/open-cycles", async (req, res) => {
  try {
    const s = await scope(req, res);
    if (!s) return;
    res.json({
      success: true,
      cycles: await proposals.openCycles({ companyId: s.companyId, allowedSlugs: s.slugs }),
      departments: s.allowed,
    });
  } catch (error) {
    console.error("[budget-proposals] open-cycles error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── MY REQUESTS ─────────────────────────────────────────────────────────── */
router.get("/my-requests", async (req, res) => {
  try {
    const s = await scope(req, res);
    if (!s) return;
    const { requests, summary } = await proposals.myRequests({
      companyId: s.companyId,
      allowedSlugs: s.slugs,
      financialYear: req.query.financialYear,
    });
    res.json({ success: true, requests, summary, departments: s.allowed });
  } catch (error) {
    console.error("[budget-proposals] my-requests error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── HEADS A DEPARTMENT MAY ASK AGAINST ──────────────────────────────────────
 * The company's expense/revenue ledgers, so the form can offer a real head.
 * Names and natures only — no balances, no budget figures. */
router.get("/heads", async (req, res) => {
  try {
    const s = await scope(req, res);
    if (!s) return;
    if (!s.slugs.length) return res.json({ success: true, heads: [] });

    const heads = await Acc_Ledger.find({ companyId: s.companyId })
      .select("_id name groupName nature")
      .sort({ name: 1 })
      .limit(500)
      .lean();

    res.json({
      success: true,
      heads: heads
        .filter((l) => l.nature === "expense" || l.nature === "revenue")
        .map((l) => ({
          ledgerId: l._id,
          ledgerName: l.name,
          groupName: l.groupName || null,
          nature: l.nature,
        })),
    });
  } catch (error) {
    console.error("[budget-proposals] heads error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/** The fields a department may set. Built key by key rather than spread: a
 *  spread would let a caller set state, agreedAmount or submittedBy — finance's
 *  side of the exchange and the server's respectively. */
function proposalFields(body, resolver) {
  return {
    requestedAmount: variance.money(body.requestedAmount),
    priority: ["low", "normal", "high", "critical"].includes(body.priority)
      ? body.priority
      : "normal",
    purpose: body.purpose ? String(body.purpose).trim() : undefined,
    justification: body.justification ? String(body.justification).trim() : undefined,
    expectedMonth: body.expectedMonth || undefined,
    expectedFrom: body.expectedFrom || undefined,
    expectedTo: body.expectedTo || undefined,
    note: body.note ? String(body.note).trim() : undefined,
  };
}

/* ── SUBMIT ──────────────────────────────────────────────────────────────── */
router.post("/:budgetId/requests", async (req, res) => {
  try {
    const s = await scope(req, res);
    if (!s) return;

    const budget = await Acc_Budget.findOne({
      _id: req.params.budgetId,
      companyId: s.companyId,
    });

    const gate = proposals.canSubmitFor({
      department: req.body?.department,
      allowedSlugs: s.slugs,
      budget,
    });
    if (!gate.ok) return res.status(gate.status).json({ success: false, message: gate.message });

    const amount = variance.money(req.body?.requestedAmount);
    if (amount === null || amount < 0) {
      return res.status(400).json({ success: false, message: "requestedAmount must be a number ≥ 0" });
    }
    if (!req.body?.purpose && !req.body?.justification) {
      return res
        .status(400)
        .json({ success: false, message: "Say what the money is for — a purpose or a justification." });
    }

    const ledger = await Acc_Ledger.findOne({
      _id: req.body?.ledgerId,
      companyId: s.companyId,
    })
      .select("_id name groupName nature")
      .lean();
    if (!ledger) {
      return res.status(400).json({ success: false, message: "Pick a budget head." });
    }

    /* Stored under the registry's spelling, so the department that submits and
     * the section finance sees are the same one. */
    const canonical =
      s.allowed.find((d) => d.slug === departments.slugify(req.body.department))?.name ||
      departments.displayOf(req.body.department);

    budget.budgetRequests.push({
      department: canonical,
      ledgerId: ledger._id,
      ledgerName: ledger.name,
      groupName: ledger.groupName,
      nature: ledger.nature === "revenue" ? "revenue" : "expense",
      ...proposalFields(req.body),
      state: "submitted",
      submittedAt: new Date(),
      /* Server-derived. A department naming its own submitter would let one
       * person file as another. */
      submittedBy: req.user.email || req.user.name || req.user.id,
    });

    await budget.save();
    const created = budget.budgetRequests[budget.budgetRequests.length - 1];
    res.status(201).json({ success: true, request: proposals.publicRequest(created, budget) });
  } catch (error) {
    console.error("[budget-proposals] submit error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── REVISE OWN REQUEST ──────────────────────────────────────────────────────
 * A department may change its own ask while the answer is still open —
 * including answering a counter. Once finance has AGREED it, the figure is an
 * allocation line on the company budget, and editing the request behind it
 * would silently disagree with money already committed. */
router.put("/:budgetId/requests/:requestId", async (req, res) => {
  try {
    const s = await scope(req, res);
    if (!s) return;

    const budget = await Acc_Budget.findOne({
      _id: req.params.budgetId,
      companyId: s.companyId,
    });
    if (!budget) return res.status(404).json({ success: false, message: "Budget cycle not found." });

    const row = budget.budgetRequests.id(req.params.requestId);
    if (!row) return res.status(404).json({ success: false, message: "Request not found." });

    /* Ownership first, and phrased so a refusal cannot be used to discover
     * another department's request ids. */
    if (!proposals.ownedBy(row, s.slugs)) {
      return res.status(404).json({ success: false, message: "Request not found." });
    }
    if (!proposals.OPEN_STATES.includes(budget.status)) {
      return res.status(409).json({
        success: false,
        message: `This cycle is ${budget.status}; it is no longer collecting requests.`,
      });
    }
    if (!proposals.EDITABLE_STATES.includes(row.state)) {
      return res.status(409).json({
        success: false,
        message: `This request is ${row.state} and can no longer be changed.`,
      });
    }

    const patch = proposalFields(req.body);
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined && v !== null) row[k] = v;
    }
    /* Answering a counter puts the ball back in finance's court. */
    if (row.state === "countered") row.state = "submitted";
    row.updatedAt = new Date();

    await budget.save();
    res.json({ success: true, request: proposals.publicRequest(row, budget) });
  } catch (error) {
    console.error("[budget-proposals] update error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
