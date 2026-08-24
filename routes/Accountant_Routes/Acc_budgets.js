// routes/Accountant_Routes/Acc_budgets.js
//
// Budgets — revenue AND expense.
//
// The arithmetic lives in services/budgetVariance.service.js and the actuals in
// services/budgetActuals.service.js. This file is transport: it decides what a
// caller may see and hands the numbers over. Two rules it enforces that the
// pure services cannot:
//
//   • Actuals are ALWAYS recomputed from posted vouchers on read. The cached
//     spentAmount/variance on the document are for exports and list views only.
//     A cached figure that can drift is how a budget ends up disagreeing with
//     the P&L, and the P&L is the one that is right.
//   • A budget is scoped to a company. Without that filter one company's
//     postings land in another's actuals.

const express = require("express");
const router = express.Router();
const AccountantAuthMiddleware = require("../../Middlewear/AccountantAuthMiddleware");
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");
const { Acc_Ledger, Acc_Group } = require("../../models/Accountant_model/Acc_MasterModels");
const variance = require("../../services/budgetVariance.service");
const actuals = require("../../services/budgetActuals.service");

router.use(AccountantAuthMiddleware.accountantAuth);

/**
 * period/status must agree with the schema's own enum, read live off the
 * model rather than copied into a second literal list here. This file used
 * to trust Mongoose's generic ValidationError to catch a bad value, which
 * surfaced as a bare 500 — and the frontend's own copy of these two lists had
 * quietly drifted from the schema (`"annual"` where the model says
 * `"yearly"`, an `"expired"` status the model has never had). Reading the
 * enum straight from the schema means this check can never drift from it
 * again the way the frontend's hand-copied list did.
 */
function invalidEnumField(model, field, value) {
  if (value === undefined) return null;
  const allowed = model.schema.path(field).enumValues;
  if (allowed.includes(value)) return null;
  return `${field} must be one of: ${allowed.join(", ")} (got "${value}")`;
}

/** The company whose books this request is about. Header wins, then query. */
function companyOf(req) {
  return (
    req.headers["x-company-id"] ||
    req.query.companyId ||
    (req.user && req.user.companyId) ||
    null
  );
}

/** Recompute a budget's derived figures. Shared by the detail and list reads. */
async function evaluate(budget, { asOf } = {}) {
  const lines = await actuals.hydrateLines({
    companyId: budget.companyId,
    lines: budget.items || [],
    from: budget.startDate,
    to: budget.endDate,
  });

  const when = asOf || new Date();
  const evaluated = lines.map((line) => {
    const v = variance.evaluateLine({
      allocated: line.allocatedAmount,
      actual: line.actual,
      nature: line.nature,
      startDate: budget.startDate,
      endDate: budget.endDate,
      asOf: when,
      phasing: line.phasing,
    });
    return { ...line, ...v, _id: line._id, department: line.department || null };
  });

  return {
    ...budget,
    items: evaluated,
    totals: variance.rollUp(evaluated),
    byDepartment: variance.groupBy(evaluated, "department"),
    byNature: {
      revenue: evaluated.filter((l) => l.nature === "revenue"),
      expense: evaluated.filter((l) => l.nature === "expense"),
    },
    asOf: when,
  };
}

/** Keep the cached roll-ups on the document in step with the lines. */
function cacheTotals(data) {
  const items = data.items || [];
  const sum = (pred) =>
    items.filter(pred).reduce((s, i) => s + (Number(i.allocatedAmount) || 0), 0);
  data.totalRevenueAllocated = sum((i) => i.nature === "revenue");
  data.totalExpenseAllocated = sum((i) => i.nature !== "revenue");
  data.totalAllocated = data.totalRevenueAllocated + data.totalExpenseAllocated;
  return data;
}

/* ── LIST ────────────────────────────────────────────────────────────────── */
router.get("/", async (req, res) => {
  try {
    const { financialYear, status, period, department, withTotals } = req.query;
    const filter = {};
    if (financialYear) filter.financialYear = financialYear;
    if (status) filter.status = status;
    if (period) filter.period = period;
    if (department) filter["items.department"] = department;

    const companyId = companyOf(req);
    if (companyId) {
      const cid = actuals.oid(companyId);
      // Rows written before companyId existed must stay visible to their books.
      if (cid) filter.$or = [{ companyId: cid }, { companyId: { $exists: false } }, { companyId: null }];
    }

    const budgets = await Acc_Budget.find(filter).sort({ createdAt: -1 }).lean();

    // The list is a list. Computing every budget's actuals here would run one
    // aggregation per row; opt in when the caller actually needs the figures.
    if (String(withTotals) !== "true") {
      return res.json({ success: true, budgets });
    }

    const hydrated = await Promise.all(budgets.map((b) => evaluate(b)));
    res.json({ success: true, budgets: hydrated });
  } catch (error) {
    console.error("[budgets] list error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── LEDGER PICKER ───────────────────────────────────────────────────────────
 * The heads a budget line may bind to: revenue and expense only. An asset or a
 * liability head is not something you budget against, and offering the whole
 * chart is how people end up budgeting against Sundry Debtors. */
router.get("/ledger-options", async (req, res) => {
  try {
    const companyId = actuals.oid(companyOf(req));
    const groupFilter = { nature: { $in: ["revenue", "expense"] } };
    if (companyId) groupFilter.companyId = companyId;

    const groups = await Acc_Group.find(groupFilter).select("_id name nature").lean();
    const byId = new Map(groups.map((g) => [String(g._id), g]));

    const ledgerFilter = { groupId: { $in: groups.map((g) => g._id) } };
    if (companyId) ledgerFilter.companyId = companyId;

    const ledgers = await Acc_Ledger.find(ledgerFilter)
      .select("_id name groupId groupName isActive")
      .sort({ name: 1 })
      .lean();

    res.json({
      success: true,
      options: ledgers
        .filter((l) => l.isActive !== false)
        .map((l) => {
          const g = byId.get(String(l.groupId));
          return {
            ledgerId: l._id,
            ledgerName: l.name,
            groupName: l.groupName || (g && g.name) || null,
            nature: (g && g.nature) || "expense",
          };
        }),
    });
  } catch (error) {
    console.error("[budgets] ledger-options error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── DETAIL ──────────────────────────────────────────────────────────────── */
router.get("/:id", async (req, res) => {
  try {
    const budget = await Acc_Budget.findById(req.params.id).lean();
    if (!budget) return res.status(404).json({ success: false, message: "Budget not found" });
    const asOf = req.query.asOf ? new Date(req.query.asOf) : undefined;
    res.json({ success: true, budget: await evaluate(budget, { asOf }) });
  } catch (error) {
    console.error("[budgets] detail error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── CREATE ──────────────────────────────────────────────────────────────── */
router.post("/", async (req, res) => {
  try {
    const periodError = invalidEnumField(Acc_Budget, "period", req.body?.period);
    if (periodError) return res.status(400).json({ success: false, message: periodError });
    const statusError = invalidEnumField(Acc_Budget, "status", req.body?.status);
    if (statusError) return res.status(400).json({ success: false, message: statusError });

    const data = cacheTotals({ ...req.body });
    data.createdBy = req.user.id;
    const cid = actuals.oid(companyOf(req));
    if (cid && !data.companyId) data.companyId = cid;

    const budget = await Acc_Budget.create(data);
    res.status(201).json({ success: true, budget });
  } catch (error) {
    console.error("[budgets] create error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── UPDATE ──────────────────────────────────────────────────────────────── */
router.put("/:id", async (req, res) => {
  try {
    const periodError = invalidEnumField(Acc_Budget, "period", req.body?.period);
    if (periodError) return res.status(400).json({ success: false, message: periodError });
    const statusError = invalidEnumField(Acc_Budget, "status", req.body?.status);
    if (statusError) return res.status(400).json({ success: false, message: statusError });

    const data = { ...req.body };
    if (data.items) cacheTotals(data);
    const budget = await Acc_Budget.findByIdAndUpdate(req.params.id, data, {
      new: true,
      runValidators: true,
    });
    if (!budget) return res.status(404).json({ success: false, message: "Budget not found" });
    res.json({ success: true, budget });
  } catch (error) {
    console.error("[budgets] update error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── DEPARTMENT SUBMISSION ───────────────────────────────────────────────────
 * One department answering the envelope it was given. There is no REJECT: the
 * only moves are submit and counter, and the only exit is agreement — the same
 * rule the time-budget negotiation already runs on, for the same reason. A
 * refusal that ends the conversation leaves a budget one side never accepted,
 * which is the state this is here to make impossible. */
router.post("/:id/submissions", async (req, res) => {
  try {
    const { department, requestedAmount, note } = req.body || {};
    if (!department) {
      return res.status(400).json({ success: false, message: "department is required" });
    }
    const amount = variance.money(requestedAmount);
    if (amount === null || amount < 0) {
      return res.status(400).json({ success: false, message: "requestedAmount must be a number ≥ 0" });
    }

    const budget = await Acc_Budget.findById(req.params.id);
    if (!budget) return res.status(404).json({ success: false, message: "Budget not found" });
    if (["closed", "active"].includes(budget.status)) {
      return res.status(409).json({
        success: false,
        message: `This budget is ${budget.status}; submissions are closed.`,
      });
    }

    const row = (budget.submissions || []).find((s) => s.department === department);
    if (row) {
      row.requestedAmount = amount;
      row.state = "submitted";
      row.submittedAt = new Date();
      row.submittedBy = req.user?.email || req.user?.id || null;
      if (note !== undefined) row.note = note;
    } else {
      budget.submissions.push({
        department,
        requestedAmount: amount,
        state: "submitted",
        submittedAt: new Date(),
        submittedBy: req.user?.email || req.user?.id || null,
        note,
      });
    }
    await budget.save();
    res.json({ success: true, submissions: budget.submissions });
  } catch (error) {
    console.error("[budgets] submission error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── CLOSE THE COLLECTION ────────────────────────────────────────────────────
 * Finance closes with whatever arrived. Departments that never answered are
 * marked `defaulted` and keep their envelope — recorded as not having replied,
 * rather than silently inheriting a number nobody argued about. One silent
 * department must not be able to stall the company's budget indefinitely. */
router.post("/:id/close-collection", async (req, res) => {
  try {
    const budget = await Acc_Budget.findById(req.params.id);
    if (!budget) return res.status(404).json({ success: false, message: "Budget not found" });

    let defaulted = 0;
    for (const s of budget.submissions || []) {
      if (s.state === "awaiting") {
        s.state = "defaulted";
        s.agreedAmount = variance.money(s.envelopeAmount) ?? 0;
        defaulted += 1;
      } else if (s.state === "submitted") {
        s.agreedAmount = variance.money(s.requestedAmount) ?? 0;
        s.state = "agreed";
      }
    }
    budget.status = "review";
    await budget.save();
    res.json({ success: true, defaulted, submissions: budget.submissions, status: budget.status });
  } catch (error) {
    console.error("[budgets] close-collection error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── DELETE ──────────────────────────────────────────────────────────────── */
router.delete("/:id", async (req, res) => {
  try {
    const budget = await Acc_Budget.findByIdAndDelete(req.params.id);
    if (!budget) return res.status(404).json({ success: false, message: "Budget not found" });
    res.json({ success: true, message: "Budget deleted" });
  } catch (error) {
    console.error("[budgets] delete error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
