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

/**
 * The company-ownership filter for a BY-ID budget operation.
 *
 * ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
 * The list endpoint has always been company-scoped, but every by-id route
 * below used a bare `findById`/`findByIdAndUpdate`/`findByIdAndDelete`. So a
 * budget was invisible in another company's list yet fully readable,
 * editable and deletable by anyone who had its id — and ids are not secrets:
 * they appear in URLs, exports and logs. Scoping the read is what makes the
 * list's scoping mean anything.
 *
 * ── WHY THIS MIRRORS THE LIST RULE EXACTLY, INCLUDING ITS PERMISSIVENESS ────
 * The rule is deliberately the SAME `$or` the list builds, legacy clause and
 * all: a row whose `companyId` is missing or null predates the field and must
 * stay reachable by the books that own it, exactly as it stays visible in
 * their list. Anything stricter here would produce a budget a company can SEE
 * in its list but gets a 404 for when it clicks — a worse failure than the one
 * being fixed, and one that would look like data loss to the person using it.
 *
 * It also inherits the list's behaviour when NO company is selected (no
 * scoping at all) and when the selected company is malformed (`oid()` returns
 * null → no scoping). Both are the pre-existing list semantics; diverging from
 * them here would leave list and detail disagreeing about what is visible.
 * They are recorded as a known remaining risk rather than silently changed,
 * because tightening them is a change to what the LIST shows, which is outside
 * this guard's scope.
 *
 * ── 404, NOT 403 ────────────────────────────────────────────────────────────
 * A cross-company id is answered "not found", matching how the rest of this
 * module already refuses out-of-scope records (Acc_parties' credit-terms
 * route, Acc_recurringItems, Acc_billTerms all 404 rather than 403). A 403
 * would confirm that a budget with that id exists in some other company,
 * which is precisely what a caller probing ids is trying to learn.
 */
function scopeFilter(req, id) {
  const filter = { _id: id };
  const cid = actuals.oid(companyOf(req));
  if (cid) {
    // Rows written before companyId existed must stay reachable by their books.
    filter.$or = [{ companyId: cid }, { companyId: { $exists: false } }, { companyId: null }];
  }
  return filter;
}

/**
 * Is this a usable ObjectId?
 *
 * A malformed `:id` previously reached Mongoose and surfaced as a CastError →
 * bare 500. It was never a security hole (nothing can match it), but it left
 * one by-id path answering differently from the rest. Answering 404 keeps
 * every "you cannot have this record" outcome identical, whatever the reason.
 */
function isUsableId(id) {
  return !!actuals.oid(id);
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
    if (!isUsableId(req.params.id)) {
      return res.status(404).json({ success: false, message: "Budget not found" });
    }
    const budget = await Acc_Budget.findOne(scopeFilter(req, req.params.id)).lean();
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

    if (!isUsableId(req.params.id)) {
      return res.status(404).json({ success: false, message: "Budget not found" });
    }

    const data = { ...req.body };
    if (data.items) cacheTotals(data);

    // `companyId` is scope, not an editable field. Without this, scoping the
    // LOOKUP would still leave a way to move a budget between companies: read
    // a legacy (companyId-less) row — which the rule above deliberately
    // allows — and PUT a companyId onto it, or re-tenant your own row into
    // somebody else's books. Dropping the key means an update can never
    // change which company owns a budget.
    //
    // Dropped silently rather than refused, on purpose: the existing
    // frontend round-trips the whole budget object back on save, so its
    // payload legitimately carries the row's CURRENT companyId. Refusing that
    // would break saving with no security gain, since ignoring it is already
    // a no-op for the only value a well-behaved client sends. Adopting a
    // legacy row into a company is a real (and deliberate) operation that
    // would need its own endpoint.
    delete data.companyId;

    const budget = await Acc_Budget.findOneAndUpdate(scopeFilter(req, req.params.id), data, {
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

    // Same ownership guard as detail/update/delete. Not named in this task's
    // brief, but it is the identical hole on a route that WRITES: an
    // unguarded submission lets anyone holding an id enter a requested amount
    // into another company's budget negotiation. Fixing three by-id routes
    // and leaving this one would have looked complete while still being open.
    if (!isUsableId(req.params.id)) {
      return res.status(404).json({ success: false, message: "Budget not found" });
    }
    const budget = await Acc_Budget.findOne(scopeFilter(req, req.params.id));
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
    // As with submissions above: the same guard, on a route that mutates
    // every submission's agreed amount and moves the budget to `review`.
    if (!isUsableId(req.params.id)) {
      return res.status(404).json({ success: false, message: "Budget not found" });
    }
    const budget = await Acc_Budget.findOne(scopeFilter(req, req.params.id));
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
    if (!isUsableId(req.params.id)) {
      return res.status(404).json({ success: false, message: "Budget not found" });
    }
    const budget = await Acc_Budget.findOneAndDelete(scopeFilter(req, req.params.id));
    if (!budget) return res.status(404).json({ success: false, message: "Budget not found" });
    res.json({ success: true, message: "Budget deleted" });
  } catch (error) {
    console.error("[budgets] delete error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
