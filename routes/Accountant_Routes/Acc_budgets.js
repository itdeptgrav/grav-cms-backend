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
const control = require("../../services/budgetControl.service");

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

/**
 * Which company's postings a budget's actuals must be summed from.
 *
 * ── THE LEAK THIS CLOSES ────────────────────────────────────────────────────
 * `evaluate()` used to pass `budget.companyId` straight through. For a LEGACY
 * row — one written before the field existed — that is `undefined`, and
 * `movementByLedger` applies a company filter only `if (cid)`. So the
 * aggregation ran unscoped and summed posted vouchers from EVERY company.
 * Verified before the fix: company A opening a legacy budget read ₹7,77,777
 * of company B's postings as its own actuals.
 *
 * Note this was a leak in the NUMBERS, not in record access — Chunk 1A's
 * guard already governs who may open the row. A budget can be legitimately
 * visible (the legacy compatibility rule) and still have no business showing
 * another company's spend inside it.
 *
 * ── THE ORDER, AND WHY IT IS THIS WAY ROUND ─────────────────────────────────
 * The budget's OWN company wins when it has one: those are the books the
 * budget belongs to, and that is true regardless of who is looking. The
 * request's selected company is the fallback, used only for a legacy row that
 * names no company of its own.
 *
 * After Chunk 1A the two can never actually disagree on a by-id route —
 * `scopeFilter` only matches a budget whose companyId equals the selected one
 * or is absent — so this order is about stating the intent correctly rather
 * than resolving a live conflict. The one case where `budget.companyId` is
 * neither is when NO company is selected at all, and there its own company is
 * plainly the right answer.
 *
 * Returns undefined only when neither has one, which preserves the existing
 * unscoped behaviour rather than silently inventing a scope. See the summary's
 * remaining risks: that path is reachable only when no company is selected,
 * which is already how the LIST behaves, and narrowing it belongs with that
 * decision rather than here.
 */
function actualsCompanyFor(budget, req) {
  return budget?.companyId ?? companyOf(req) ?? undefined;
}

/**
 * Recompute a budget's derived figures. Shared by the detail and list reads.
 *
 * `req` is required so the actuals can be scoped for a legacy row — see
 * actualsCompanyFor above. It is deliberately a positional argument rather
 * than an option: an evaluate() that can be called without it is an
 * evaluate() that can silently go back to aggregating every company.
 */
async function evaluate(budget, req, { asOf } = {}) {
  const lines = await actuals.hydrateLines({
    companyId: actualsCompanyFor(budget, req),
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

    const hydrated = await Promise.all(budgets.map((b) => evaluate(b, req)));
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

/* ── DASHBOARD ───────────────────────────────────────────────────────────────
 * "Which departments and heads are over budget, under budget, on pace, or at
 * risk?" — read-only, across every budget the caller's filters select.
 *
 * MUST be declared before `/:id`, or Express hands "dashboard" to the detail
 * route as a budget id and this endpoint becomes a 404 that looks like a
 * missing record.
 *
 * This route invents no arithmetic. Every figure comes out of
 * budgetVariance.service.js through the same `evaluate()` the list and detail
 * routes use, so a number here can never disagree with the same number on the
 * budget it came from. Where a total is needed that the service does not
 * itself produce (spend remaining, revenue still to go), it is SUMMED from the
 * per-line values the service returned rather than re-derived — the per-line
 * `toGo` is clamped at zero and a re-derived version would not be.
 *
 * COST: one aggregation pair per budget, because `evaluate()` hydrates against
 * each budget's own date window and each budget's own company (a legacy row
 * falls back to the caller's, which is the whole point of actualsCompanyFor).
 * Budgets are tens per financial year, not thousands, and correctness across
 * legacy rows matters more here than saving round trips. MAX_BUDGETS caps the
 * work and `truncated` says so out loud when it bites.
 */

/* Mirrors the `warnAtPct` default in budgetVariance.service.js. A line at or
 * above it has consumed enough of its number to be worth a manager's eye even
 * when the pace maths says it is fine. */
const HIGH_UTILIZATION_PCT = 90;

/* A dashboard is a screen, not an export. */
const MAX_BUDGETS = 200;

/** Worst severity across a set of evaluated lines. `worseOf` is the service's
 *  own combining rule: signals combine by taking the worst, never by
 *  averaging, because an averaged alarm is one that fails to ring. */
function worstSeverity(lines = []) {
  return lines.reduce((acc, l) => variance.worseOf(acc, l.severity || "info"), "info");
}

const sumOf = (lines, field) =>
  lines.reduce((s, l) => s + (variance.money(l[field]) ?? 0), 0);

/** Enough of a line to act on it, without shipping the whole document. */
function attentionLine(line, budget) {
  return {
    budgetId: budget._id,
    budgetName: budget.name,
    ledgerId: line.ledgerId || null,
    ledgerName: line.ledgerName || null,
    groupName: line.groupName || null,
    department: line.department || null,
    nature: line.nature,
    allocated: line.allocated,
    actual: line.actual,
    expectedToDate: line.expectedToDate,
    remaining: line.remaining,
    toGo: line.toGo,
    variance: line.variance,
    utilizationPct: line.utilizationPct,
    pace: line.pace,
    severity: line.severity,
  };
}

router.get("/dashboard", async (req, res) => {
  try {
    const { financialYear, status, period, department } = req.query;

    const periodError = invalidEnumField(Acc_Budget, "period", period);
    if (periodError) return res.status(400).json({ success: false, message: periodError });
    const statusError = invalidEnumField(Acc_Budget, "status", status);
    if (statusError) return res.status(400).json({ success: false, message: statusError });

    let asOf;
    if (req.query.asOf) {
      asOf = new Date(req.query.asOf);
      if (Number.isNaN(asOf.getTime())) {
        return res.status(400).json({ success: false, message: "asOf must be a valid date" });
      }
    }

    /* The SAME filter the list endpoint builds, legacy clause included. A
     * dashboard scoped differently from the list would report totals for
     * budgets the list refuses to show you. */
    const filter = {};
    if (financialYear) filter.financialYear = financialYear;
    if (status) filter.status = status;
    if (period) filter.period = period;
    if (department) filter["items.department"] = department;

    const companyId = companyOf(req);
    if (companyId) {
      const cid = actuals.oid(companyId);
      if (cid) filter.$or = [{ companyId: cid }, { companyId: { $exists: false } }, { companyId: null }];
    }

    const matched = await Acc_Budget.countDocuments(filter);
    const budgets = await Acc_Budget.find(filter).sort({ createdAt: -1 }).limit(MAX_BUDGETS).lean();
    const evaluated = await Promise.all(budgets.map((b) => evaluate(b, req, { asOf })));

    /* `department` selects which BUDGETS are in scope (any line naming it),
     * exactly as the list route does. Once a budget is in scope the dashboard
     * shows only that department's lines — otherwise asking about Logistics
     * returns Logistics-shaped totals padded with every other department that
     * happens to share the budget. */
    const linesOf = (b) =>
      department ? (b.items || []).filter((l) => l.department === department) : b.items || [];

    const allLines = evaluated.flatMap(linesOf);
    const expenseLines = allLines.filter((l) => l.nature === "expense");
    const revenueLines = allLines.filter((l) => l.nature === "revenue");

    /* ── 1. Overall ─────────────────────────────────────────────────────── */
    const totals = {
      ...variance.rollUp(allLines),
      /* Named for what a manager asks for, and summed from the service's own
       * per-line figures rather than re-derived here. */
      expenseRemaining: sumOf(expenseLines, "remaining"),
      revenueToGo: sumOf(revenueLines, "toGo"),
      budgetCount: evaluated.length,
      lineCount: allLines.length,
    };

    /* ── 2. By department ───────────────────────────────────────────────── */
    const linesByDept = new Map();
    for (const l of allLines) {
      const k = l.department || "Unassigned";
      if (!linesByDept.has(k)) linesByDept.set(k, []);
      linesByDept.get(k).push(l);
    }
    const byDepartment = variance.groupBy(allLines, "department").map((d) => {
      const group = linesByDept.get(d.name) || [];
      return {
        ...d,
        department: d.name,
        expenseRemaining: sumOf(group.filter((l) => l.nature === "expense"), "remaining"),
        revenueToGo: sumOf(group.filter((l) => l.nature === "revenue"), "toGo"),
        severity: worstSeverity(group),
      };
    });

    /* ── 3. By head ─────────────────────────────────────────────────────────
     * One row per ledger head, across budgets. The same head budgeted twice is
     * one management question, not two — but the allocations still have to add
     * up, so the contributing budgets are named. An unbound legacy line has no
     * head to merge on and keeps its own row. */
    const heads = new Map();
    for (const b of evaluated) {
      for (const l of linesOf(b)) {
        const key = l.ledgerId ? String(l.ledgerId) : `unbound:${b._id}:${l._id}`;
        if (!heads.has(key)) {
          heads.set(key, {
            ledgerId: l.ledgerId || null,
            ledgerName: l.ledgerName || null,
            groupName: l.groupName || null,
            department: l.department || null,
            nature: l.nature,
            unbound: !!l.unbound,
            budgets: [],
            _lines: [],
          });
        }
        const head = heads.get(key);
        head._lines.push(l);
        head.budgets.push({ _id: b._id, name: b.name });
        /* Two budgets can name different departments for one head. Say so
         * rather than silently keeping whichever was read first. */
        if (!head.department) head.department = l.department || null;
        else if (l.department && head.department !== l.department) head.department = "Multiple";
      }
    }

    const byHead = [...heads.values()]
      .map(({ _lines, ...head }) => {
        const allocated = sumOf(_lines, "allocated");
        const actual = sumOf(_lines, "actual");

        /* Each line's expectation is already computed against its OWN budget
         * window, so the sum is meaningful — but only if every line has one.
         * A partial sum would understate the expectation and make the head
         * look ahead of pace when it is not. */
        const expectedToDate = _lines.every((l) => l.expectedToDate !== null)
          ? sumOf(_lines, "expectedToDate")
          : null;

        /* Date-independent arithmetic (remaining / toGo / variance /
         * utilisation) comes from the service on the merged figures. Pace and
         * severity do NOT: pace is re-derived from the summed expectation via
         * the service's own paceState, and severity takes the worst of the
         * lines, each of which judged itself against its own period. */
        const v = variance.evaluateLine({ allocated, actual, nature: head.nature, asOf });

        return {
          ...head,
          allocated,
          actual,
          expectedToDate,
          remaining: v.remaining,
          toGo: v.toGo,
          variance: v.variance,
          variancePct: v.variancePct,
          utilizationPct: v.utilizationPct,
          pace: variance.paceState({
            kind: head.nature,
            alloc: allocated,
            act: actual,
            expected: expectedToDate,
          }),
          severity: worstSeverity(_lines),
          lineCount: _lines.length,
        };
      })
      .sort((a, b) => b.allocated - a.allocated);

    /* ── 4. Attention ───────────────────────────────────────────────────── */
    const overBudget = [];
    const revenueBehind = [];
    const highUtilization = [];
    const unbound = [];
    const noAllocations = [];

    for (const b of evaluated) {
      for (const l of linesOf(b)) {
        if (l.unbound) unbound.push(attentionLine(l, b));

        if (l.nature === "expense") {
          if (l.pace === "over_budget") overBudget.push(attentionLine(l, b));
          else if (l.utilizationPct !== null && l.utilizationPct >= HIGH_UTILIZATION_PCT) {
            /* `else`: a line already over budget is reported once, in the
             * louder list. Two entries for one line reads as two problems. */
            highUtilization.push(attentionLine(l, b));
          }
        } else if (l.pace === "behind" || l.pace === "not_started") {
          /* `not_started` too: paceState reports it instead of "behind" when
           * nothing at all has been earned, and a revenue head still at zero
           * halfway through its period is the most behind a line can be.
           * Matching only "behind" hid exactly the worst case. */
          revenueBehind.push(attentionLine(l, b));
        }
      }

      /* Deliberately the budget's FULL line list, not the department-filtered
       * one: having no approved allocations is a fact about the budget, and a
       * department filter must not manufacture it. */
      if (!(b.items || []).length) {
        /* Nothing approved here. With requests against it, that is finance
         * owing departments an answer; without, it is a budget nobody has
         * filled in. The counts tell the two apart. */
        const requests = b.budgetRequests || [];
        noAllocations.push({
          _id: b._id,
          name: b.name,
          status: b.status,
          period: b.period,
          financialYear: b.financialYear,
          requestCount: requests.length,
          pendingRequestCount: requests.filter((r) => r.state !== "agreed" && r.state !== "defaulted").length,
        });
      }
    }

    /* Biggest problem first in each list — nobody scrolls a dashboard. */
    overBudget.sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));
    revenueBehind.sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));
    highUtilization.sort((a, b) => (b.utilizationPct ?? 0) - (a.utilizationPct ?? 0));

    const attention = {
      overBudget,
      revenueBehind,
      highUtilization,
      unbound,
      noAllocations,
      count:
        overBudget.length +
        revenueBehind.length +
        highUtilization.length +
        unbound.length +
        noAllocations.length,
    };

    /* ── 5. Budget list ─────────────────────────────────────────────────── */
    const budgetList = evaluated.map((b) => {
      const lines = linesOf(b);
      return {
        _id: b._id,
        budgetId: b.budgetId,
        name: b.name,
        status: b.status,
        period: b.period,
        financialYear: b.financialYear,
        startDate: b.startDate,
        endDate: b.endDate,
        totals: variance.rollUp(lines),
        lineCount: lines.length,
        requestCount: (b.budgetRequests || []).length,
        severity: worstSeverity(lines),
      };
    });

    res.json({
      success: true,
      asOf: evaluated[0]?.asOf || asOf || new Date(),
      filters: {
        financialYear: financialYear || null,
        status: status || null,
        period: period || null,
        department: department || null,
      },
      totals,
      byDepartment,
      byHead,
      attention,
      budgets: budgetList,
      /* Never truncate silently — a dashboard that quietly dropped budgets
       * would read as "this is everything". */
      truncated: matched > budgets.length ? { matched, returned: budgets.length } : null,
    });
  } catch (error) {
    console.error("[budgets] dashboard error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── AVAILABILITY CHECK ──────────────────────────────────────────────────────
 * "Is there budget for this, and what happens to the budget if I post it?"
 *
 * Read-only and side-effect free, so a voucher form can call it on every
 * change without committing to anything. The routes that actually post money
 * call the same service directly — see requireBudgetClearance in
 * Acc_vouchers.js — so the warning a user sees before submitting and the
 * refusal they get on submit cannot come from different arithmetic.
 *
 * Declared before /:id, like /dashboard. */
router.post("/check-availability", async (req, res) => {
  try {
    const body = req.body || {};
    const result = await control.checkBudgetAvailability({
      companyId: body.companyId || companyOf(req),
      voucherDate: body.voucherDate,
      ledgerEntries: body.ledgerEntries || [],
      department: body.department || body.costCentre || null,
      excludeVoucherId: body.excludeVoucherId || null,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    /* A bad date is the caller's mistake, not a server fault. */
    if (/voucherDate/.test(error.message || "")) {
      return res.status(400).json({ success: false, message: error.message });
    }
    console.error("[budgets] check-availability error:", error);
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
    res.json({ success: true, budget: await evaluate(budget, req, { asOf }) });
  } catch (error) {
    console.error("[budgets] detail error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/** Just enough of the line for the drilldown to caption itself. */
function lineSummary(item, meta) {
  return {
    _id: item._id,
    ledgerId: item.ledgerId || null,
    ledgerName: (meta && meta.ledgerName) || item.ledgerName || null,
    groupName: (meta && meta.groupName) || item.groupName || null,
    /* An unbound legacy line has no ledgerName; `category` is the only thing
     * naming it, and the variance tables already fall back to it. Without it
     * here the drilldown captions itself "Unnamed line" for a row the table
     * behind it calls "Marketing & Advertising". */
    category: item.category || null,
    nature: (meta && meta.nature) || item.nature || "expense",
    department: item.department || null,
    allocatedAmount: item.allocatedAmount || 0,
  };
}

/* ── LINE DRILLDOWN ──────────────────────────────────────────────────────────
 * Which posted vouchers make up one line's actual.
 *
 * A budget that reports ₹8,20,000 spent and cannot say where it went is a
 * number people either trust blindly or ignore; neither is what a budget is
 * for. This is the "show your working" read.
 *
 * Every scoping decision here is deliberately the SAME one evaluate() makes —
 * actualsCompanyFor for the company (so a legacy row falls back to the
 * caller's books rather than aggregating everyone's), the budget's own
 * start/end as the default window, natureByLedger for the sign. Anything that
 * drifted would produce a list that does not add up to the figure above it.
 * There is a test asserting the two agree.
 */
router.get("/:id/items/:itemId/vouchers", async (req, res) => {
  try {
    if (!isUsableId(req.params.id)) {
      return res.status(404).json({ success: false, message: "Budget not found" });
    }
    const budget = await Acc_Budget.findOne(scopeFilter(req, req.params.id)).lean();
    if (!budget) return res.status(404).json({ success: false, message: "Budget not found" });

    const item = (budget.items || []).find((i) => String(i._id) === String(req.params.itemId));
    if (!item) {
      return res.status(404).json({ success: false, message: "Budget line not found" });
    }

    /* The window defaults to the budget's own period — the same bounds the
     * line's actual was computed over. `from`/`to` narrow it; they cannot
     * widen it past the budget, because spend outside the period was never
     * part of this number. */
    const budgetFrom = budget.startDate;
    const budgetTo = budget.endDate;
    const parseBound = (raw, fallback) => {
      if (!raw) return fallback;
      const d = new Date(raw);
      return Number.isNaN(d.getTime()) ? null : d;
    };
    const from = parseBound(req.query.from, budgetFrom);
    const to = parseBound(req.query.to, budgetTo);
    if (from === null || to === null) {
      return res.status(400).json({ success: false, message: "from and to must be valid dates" });
    }
    const clampedFrom = budgetFrom && from < budgetFrom ? budgetFrom : from;
    const clampedTo = budgetTo && to > budgetTo ? budgetTo : to;

    /* An unbound legacy line has no head to match on. It reads zero in the
     * variance tables for exactly this reason, and saying so plainly beats
     * an empty list that looks like "nothing was spent". */
    if (!item.ledgerId) {
      return res.json({
        success: true,
        unbound: true,
        line: lineSummary(item, null),
        vouchers: [],
        totals: { debit: 0, credit: 0, signed: 0, actual: 0, voucherCount: 0 },
        window: { from: clampedFrom, to: clampedTo },
        page: 1,
        limit: 0,
        pageCount: 0,
      });
    }

    /* The ledger tree is the authority on nature, not the snapshot on the row
     * — see natureByLedger. A head re-parented from expenses to revenue must
     * flip the sign here exactly as it does in the actuals. */
    const natures = await actuals.natureByLedger([item.ledgerId]);
    const meta = natures.get(String(item.ledgerId)) || {};
    const nature = meta.nature || item.nature || "expense";

    const { rows, totals, page, limit, pageCount } = await actuals.voucherMovementsForLedger({
      companyId: actualsCompanyFor(budget, req),
      ledgerId: item.ledgerId,
      from: clampedFrom,
      to: clampedTo,
      page: req.query.page,
      limit: req.query.limit,
    });

    /* actualFrom is the one place the nature rule lives. Applying it per row
     * and again to the window totals means a row's contribution and the total
     * cannot use different sign conventions. */
    const vouchers = rows.map((r) => ({
      ...r,
      actualContribution: actuals.actualFrom(r, nature),
    }));

    res.json({
      success: true,
      unbound: false,
      line: lineSummary(item, { ...meta, nature }),
      vouchers,
      totals: { ...totals, actual: actuals.actualFrom(totals, nature) },
      window: { from: clampedFrom, to: clampedTo },
      page,
      limit,
      pageCount,
    });
  } catch (error) {
    console.error("[budgets] line vouchers error:", error);
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

/* ═══════════════════════════════════════════════════════════════════════════
 * DEPARTMENT BUDGET REQUESTS (Chunk 2)
 *
 * A department asking for an amount against a specific head, with a stated
 * purpose and priority. An INPUT to finance review — deliberately NOT an
 * allocation: nothing here writes to `items[]`. Converting an agreed request
 * into a budget line is its own step, and doing it implicitly here would mean
 * a department could allocate its own budget by asking for it.
 * ══════════════════════════════════════════════════════════════════════════ */

/* Requests are an input to a budget still being built. Once a budget is
 * `active` the allocations are the agreed number and a new ask is a
 * supplementary request, not an edit to this cycle — a different product
 * object. `review` is excluded too: finance is deciding on what it already
 * has, and a request arriving mid-review changes the thing being reviewed. */
const REQUESTABLE_STATES = ["draft", "collecting"];

/** Who is acting, for the audit fields. Server-derived, never client-supplied. */
function actorOf(req) {
  return req.user?.email || req.user?.name || req.user?.id || null;
}

/**
 * Resolve a ledger for a request, enforcing company and nature.
 *
 * Returns `{ ok: true, ledger }` or `{ ok: false, status, message }`.
 *
 * The GROUP is the authority on nature, not `Acc_Ledger.nature` — the ledger's
 * own field carries no enum and the group's does, and budgetActuals.service
 * already resolves nature this way for exactly that reason. Budgeting against
 * an asset or liability head is meaningless (you do not budget Sundry
 * Debtors), which is the same rule /ledger-options applies when it offers only
 * revenue and expense heads.
 */
async function resolveRequestLedger({ ledgerId, companyId }) {
  const lid = actuals.oid(ledgerId);
  if (!lid) return { ok: false, status: 400, message: "ledgerId is not a valid id" };

  const filter = { _id: lid };
  // Only scope by company where there IS company context, matching how every
  // other read in this file treats an absent selection.
  const cid = actuals.oid(companyId);
  if (cid) filter.companyId = cid;

  const ledger = await Acc_Ledger.findOne(filter).select("_id name groupId groupName").lean();
  if (!ledger) {
    // 404-flavoured wording even at 400: a cross-company ledger id must not be
    // distinguishable from one that does not exist.
    return { ok: false, status: 400, message: "Ledger not found for this company" };
  }

  const group = ledger.groupId
    ? await Acc_Group.findById(ledger.groupId).select("_id name nature").lean()
    : null;
  const nature = group?.nature || null;
  if (nature !== "revenue" && nature !== "expense") {
    return {
      ok: false,
      status: 400,
      message: "A budget request must target a revenue or expense head",
    };
  }

  return {
    ok: true,
    ledger: {
      ledgerId: ledger._id,
      ledgerName: ledger.name,
      groupName: ledger.groupName || group?.name || null,
      nature,
    },
  };
}

/**
 * Validate the caller-supplied half of a request.
 *
 * `partial` is for PUT, where an untouched field is absent rather than being
 * an instruction to clear it.
 */
function validateRequestBody(body = {}, { partial = false } = {}) {
  const errors = [];

  const has = (k) => body[k] !== undefined && body[k] !== null && String(body[k]).trim() !== "";

  if (!partial || body.department !== undefined) {
    if (!has("department")) errors.push("department is required");
  }
  if (!partial || body.ledgerId !== undefined) {
    if (!has("ledgerId")) errors.push("ledgerId is required");
  }

  if (!partial || body.requestedAmount !== undefined) {
    const amount = variance.money(body.requestedAmount);
    if (amount === null) errors.push("requestedAmount must be a number");
    else if (amount < 0) errors.push("requestedAmount must be ≥ 0");
  }

  /* Purpose OR justification — a request with neither is a number nobody can
   * review, and finance declining it would have nothing to answer. On a PUT
   * this is only re-checked when the caller touches one of them, so an edit
   * that just changes the amount is not forced to restate the reason. */
  if (!partial) {
    if (!has("purpose") && !has("justification")) {
      errors.push("either purpose or justification is required");
    }
  } else if (body.purpose !== undefined || body.justification !== undefined) {
    const purpose = body.purpose !== undefined ? body.purpose : undefined;
    const justification = body.justification !== undefined ? body.justification : undefined;
    const stillHasOne =
      (purpose !== undefined && String(purpose).trim() !== "") ||
      (justification !== undefined && String(justification).trim() !== "");
    if (!stillHasOne) errors.push("either purpose or justification is required");
  }

  // `state` is deliberately absent: it is not settable through this path at
  // all (see the finance-fields refusal in PUT), so validating it here would
  // imply it were.
  for (const [field, allowed] of [
    ["priority", ["low", "normal", "high", "critical"]],
  ]) {
    if (body[field] !== undefined && !allowed.includes(body[field])) {
      errors.push(`${field} must be one of: ${allowed.join(", ")}`);
    }
  }

  if (body.expectedMonth !== undefined && body.expectedMonth !== null && body.expectedMonth !== "") {
    const m = Number(body.expectedMonth);
    if (!Number.isInteger(m) || m < 1 || m > 12) {
      errors.push("expectedMonth must be a whole number between 1 and 12");
    }
  }

  for (const f of ["counterAmount", "agreedAmount"]) {
    if (body[f] !== undefined && body[f] !== null && body[f] !== "") {
      const v = variance.money(body[f]);
      if (v === null || v < 0) errors.push(`${f} must be a number ≥ 0`);
    }
  }

  return errors;
}

/**
 * Load a budget for a REQUEST operation: in company scope, and in a state that
 * still accepts requests. Shared so read and write cannot drift apart.
 */
async function budgetForRequests(req, { mutating }) {
  if (!isUsableId(req.params.id)) {
    return { error: { status: 404, message: "Budget not found" } };
  }
  const budget = await Acc_Budget.findOne(scopeFilter(req, req.params.id));
  if (!budget) return { error: { status: 404, message: "Budget not found" } };

  if (mutating && !REQUESTABLE_STATES.includes(budget.status)) {
    return {
      error: {
        status: 409,
        message: `This budget is ${budget.status}; it is no longer collecting requests.`,
      },
    };
  }
  return { budget };
}

/* ── LIST REQUESTS ───────────────────────────────────────────────────────── */
router.get("/:id/requests", async (req, res) => {
  try {
    const { budget, error } = await budgetForRequests(req, { mutating: false });
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    let requests = budget.budgetRequests || [];
    // Cheap, obvious filters. Anything richer belongs in a query layer, not here.
    if (req.query.department) {
      requests = requests.filter((r) => r.department === req.query.department);
    }
    if (req.query.state) {
      requests = requests.filter((r) => r.state === req.query.state);
    }

    res.json({ success: true, requests, budgetStatus: budget.status });
  } catch (error) {
    console.error("[budgets] list requests error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── CREATE REQUEST ──────────────────────────────────────────────────────── */
router.post("/:id/requests", async (req, res) => {
  try {
    const { budget, error } = await budgetForRequests(req, { mutating: true });
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    const errors = validateRequestBody(req.body);
    if (errors.length) {
      return res.status(400).json({ success: false, message: errors.join("; "), errors });
    }

    const resolved = await resolveRequestLedger({
      ledgerId: req.body.ledgerId,
      companyId: companyOf(req),
    });
    if (!resolved.ok) {
      return res.status(resolved.status).json({ success: false, message: resolved.message });
    }

    const now = new Date();
    /* Built field by field rather than spreading req.body: a spread would let
     * a caller set agreedAmount or submittedBy on their own request, which is
     * finance's side of the exchange and the server's respectively. */
    budget.budgetRequests.push({
      department: String(req.body.department).trim(),
      ...resolved.ledger,
      requestedAmount: variance.money(req.body.requestedAmount),
      priority: req.body.priority || "normal",
      purpose: req.body.purpose,
      justification: req.body.justification,
      expectedMonth: req.body.expectedMonth || undefined,
      expectedFrom: req.body.expectedFrom || undefined,
      expectedTo: req.body.expectedTo || undefined,
      note: req.body.note,
      state: "submitted",
      submittedAt: now,
      submittedBy: actorOf(req),
    });

    await budget.save();
    const created = budget.budgetRequests[budget.budgetRequests.length - 1];
    res.status(201).json({ success: true, request: created, requests: budget.budgetRequests });
  } catch (error) {
    console.error("[budgets] create request error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── UPDATE REQUEST ──────────────────────────────────────────────────────── */
router.put("/:id/requests/:requestId", async (req, res) => {
  try {
    const { budget, error } = await budgetForRequests(req, { mutating: true });
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    if (!isUsableId(req.params.requestId)) {
      return res.status(404).json({ success: false, message: "Request not found" });
    }
    const row = budget.budgetRequests.id(req.params.requestId);
    if (!row) return res.status(404).json({ success: false, message: "Request not found" });

    /* ── FINANCE FIELDS ARE NOT EDITABLE HERE (closes the Chunk 2 risk) ──
     * Chunk 2 left `state`, `agreedAmount`, `counterAmount` and `financeNote`
     * in this endpoint's assignable list, so a requester could mark their own
     * request `agreed`. It granted no money then, because nothing read those
     * fields — but this chunk makes `agreed` create a real allocation, and the
     * same request would now allocate budget to whoever asked for it.
     *
     * REFUSED rather than silently dropped: a caller who sends `state` and
     * gets 200 back has every reason to believe it took effect. Nothing in
     * this repo round-trips a whole request object through PUT, so there is no
     * well-behaved client to break — unlike budget PUT's companyId, which is
     * dropped quietly for exactly that reason. */
    const financeOnly = ["state", "agreedAmount", "counterAmount", "financeNote"];
    const attempted = financeOnly.filter((f) => req.body[f] !== undefined);
    if (attempted.length) {
      return res.status(403).json({
        success: false,
        message:
          `${attempted.join(", ")} ${attempted.length === 1 ? "is" : "are"} set by finance review, ` +
          `not by editing the request. Use the agree or counter action.`,
      });
    }

    /* An agreed request is a settled decision with an allocation behind it.
     * Editing its amount here would leave the request and the budget line it
     * created disagreeing — so it must be reopened first, which withdraws the
     * allocation deliberately rather than as a side effect. */
    if (row.state === "agreed") {
      return res.status(409).json({
        success: false,
        message: "This request is agreed. Reopen it before editing.",
      });
    }

    const errors = validateRequestBody(req.body, { partial: true });
    if (errors.length) {
      return res.status(400).json({ success: false, message: errors.join("; "), errors });
    }

    // Re-resolve only when the head is actually being changed — an edit to the
    // amount must not silently re-derive nature from a ledger that has since
    // been re-parented.
    if (req.body.ledgerId !== undefined) {
      const resolved = await resolveRequestLedger({
        ledgerId: req.body.ledgerId,
        companyId: companyOf(req),
      });
      if (!resolved.ok) {
        return res.status(resolved.status).json({ success: false, message: resolved.message });
      }
      Object.assign(row, resolved.ledger);
    }

    // The requester's own content, and nothing else. Finance's fields are
    // refused above and written only by the review actions.
    const assignable = [
      "department", "requestedAmount", "priority", "purpose", "justification",
      "expectedMonth", "expectedFrom", "expectedTo", "note",
    ];
    for (const key of assignable) {
      if (req.body[key] !== undefined) row[key] = req.body[key];
    }

    row.updatedAt = new Date();
    row.updatedBy = actorOf(req);

    await budget.save();
    res.json({ success: true, request: row, requests: budget.budgetRequests });
  } catch (error) {
    console.error("[budgets] update request error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── DELETE REQUEST ──────────────────────────────────────────────────────────
 * Only while the budget still collects, and only for a request finance has not
 * yet settled. Withdrawing your own un-negotiated ask is housekeeping; deleting
 * one that has been countered or agreed would erase finance's side of a
 * conversation, and that needs a decision, not a DELETE. */
router.delete("/:id/requests/:requestId", async (req, res) => {
  try {
    const { budget, error } = await budgetForRequests(req, { mutating: true });
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    if (!isUsableId(req.params.requestId)) {
      return res.status(404).json({ success: false, message: "Request not found" });
    }
    const row = budget.budgetRequests.id(req.params.requestId);
    if (!row) return res.status(404).json({ success: false, message: "Request not found" });

    if (["countered", "agreed"].includes(row.state)) {
      return res.status(409).json({
        success: false,
        message: `This request is ${row.state}; it can no longer be withdrawn.`,
      });
    }

    row.deleteOne();
    await budget.save();
    res.json({ success: true, requests: budget.budgetRequests });
  } catch (error) {
    console.error("[budgets] delete request error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * FINANCE REVIEW (Chunk 3)
 *
 * Finance's side of the conversation, and the ONLY way `state`,
 * `agreedAmount`, `counterAmount` and `financeNote` are ever written. The
 * ordinary request PUT refuses them outright.
 *
 * Agreeing is the moment an ask becomes money: it writes an approved
 * allocation into `items[]`, which is what the actuals, variance and totals
 * all read. Everything else here stops short of that on purpose.
 * ══════════════════════════════════════════════════════════════════════════ */

/* Finance may review while the budget is still being built AND while it is
 * under review — that last state is the whole point of the review step, and
 * excluding it would make the status unusable. Past it (active/closed/
 * exceeded) the allocations are settled and a change is a supplementary
 * budget, not a late review. */
const REVIEWABLE_STATES = ["draft", "collecting", "review"];

/**
 * Load a budget + one request for a FINANCE action.
 *
 * Kept separate from budgetForRequests because the allowed states genuinely
 * differ — a department may not add a request during `review`, but finance
 * must be able to act on one. Sharing a helper and passing a flag would hide
 * that difference rather than state it.
 */
async function budgetAndRequestForReview(req) {
  if (!isUsableId(req.params.id)) {
    return { error: { status: 404, message: "Budget not found" } };
  }
  const budget = await Acc_Budget.findOne(scopeFilter(req, req.params.id));
  if (!budget) return { error: { status: 404, message: "Budget not found" } };

  if (!REVIEWABLE_STATES.includes(budget.status)) {
    return {
      error: {
        status: 409,
        message: `This budget is ${budget.status}; its requests are no longer under review.`,
      },
    };
  }

  if (!isUsableId(req.params.requestId)) {
    return { error: { status: 404, message: "Request not found" } };
  }
  const request = budget.budgetRequests.id(req.params.requestId);
  if (!request) return { error: { status: 404, message: "Request not found" } };

  return { budget, request };
}

/**
 * Make `items[]` reflect an agreed request — create the line, or update the
 * one this request already produced.
 *
 * The link is `sourceRequestId`, not department+head. Two requests from the
 * same department against the same head are legitimately separate asks, and
 * merging them on those fields would silently collapse two decisions into one.
 * Agreeing the SAME request twice must update, though, or a revision from 3L
 * to 4L would leave 7L allocated.
 */
function syncAllocationFromRequest(budget, request) {
  const existing = (budget.items || []).find(
    (i) => i.sourceRequestId && String(i.sourceRequestId) === String(request._id),
  );

  /* Carried across because they explain the line after the request scrolls
   * out of view. `submittedBy` becomes the owner only when it actually looks
   * like an address — the field is `ownerEmail`, and putting a display name
   * or a user id in it would make it lie. */
  const owner =
    typeof request.submittedBy === "string" && request.submittedBy.includes("@")
      ? request.submittedBy
      : undefined;
  const why = request.purpose || request.justification || undefined;

  const shape = {
    sourceRequestId: request._id,
    ledgerId: request.ledgerId,
    ledgerName: request.ledgerName,
    groupName: request.groupName,
    nature: request.nature,
    department: request.department,
    allocatedAmount: variance.money(request.agreedAmount) ?? 0,
  };

  if (existing) {
    Object.assign(existing, shape);
    // Do not clobber a note or owner finance has since edited on the line
    // itself; fill them only where the line has nothing.
    if (!existing.notes && why) existing.notes = why;
    if (!existing.ownerEmail && owner) existing.ownerEmail = owner;
    return { item: existing, created: false };
  }

  budget.items.push({ ...shape, notes: why, ownerEmail: owner });
  return { item: budget.items[budget.items.length - 1], created: true };
}

/** Re-run the document's cached roll-ups after items change. */
function recacheBudgetTotals(budget) {
  const cached = cacheTotals({ items: budget.items || [] });
  budget.totalRevenueAllocated = cached.totalRevenueAllocated;
  budget.totalExpenseAllocated = cached.totalExpenseAllocated;
  budget.totalAllocated = cached.totalAllocated;
}

/* ── AGREE ───────────────────────────────────────────────────────────────────
 * The ask becomes an approved allocation. Omitting `agreedAmount` agrees the
 * amount that was requested, which is the common case and saves finance
 * retyping a number it already accepted. */
router.post("/:id/requests/:requestId/agree", async (req, res) => {
  try {
    const { budget, request, error } = await budgetAndRequestForReview(req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    const raw =
      req.body?.agreedAmount !== undefined && req.body?.agreedAmount !== null && req.body?.agreedAmount !== ""
        ? req.body.agreedAmount
        : request.requestedAmount;
    const amount = variance.money(raw);
    if (amount === null || amount < 0) {
      return res
        .status(400)
        .json({ success: false, message: "agreedAmount must be a number ≥ 0" });
    }

    request.agreedAmount = amount;
    request.state = "agreed";
    if (req.body?.financeNote !== undefined) request.financeNote = req.body.financeNote;
    request.updatedAt = new Date();
    request.updatedBy = actorOf(req);

    const { item, created } = syncAllocationFromRequest(budget, request);
    recacheBudgetTotals(budget);
    await budget.save();

    res.json({
      success: true,
      request,
      item,
      created,
      totals: {
        totalAllocated: budget.totalAllocated,
        totalRevenueAllocated: budget.totalRevenueAllocated,
        totalExpenseAllocated: budget.totalExpenseAllocated,
      },
    });
  } catch (error) {
    console.error("[budgets] agree request error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── COUNTER ─────────────────────────────────────────────────────────────────
 * Finance offering a different number. Explicitly does NOT allocate: a counter
 * is an open question, and money must not move on one side of a conversation.
 * The department answers by editing the request, or finance agrees the
 * countered figure. */
router.post("/:id/requests/:requestId/counter", async (req, res) => {
  try {
    const { budget, request, error } = await budgetAndRequestForReview(req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    const amount = variance.money(req.body?.counterAmount);
    if (amount === null || amount < 0) {
      return res
        .status(400)
        .json({ success: false, message: "counterAmount must be a number ≥ 0" });
    }

    request.counterAmount = amount;
    request.state = "countered";
    if (req.body?.financeNote !== undefined) request.financeNote = req.body.financeNote;
    request.updatedAt = new Date();
    request.updatedBy = actorOf(req);

    await budget.save();
    res.json({ success: true, request });
  } catch (error) {
    console.error("[budgets] counter request error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── REOPEN ──────────────────────────────────────────────────────────────────
 * Undo an agreement. This MUST withdraw the allocation it created, or the
 * budget keeps money allocated against a request that is no longer agreed —
 * a number nobody approved, sitting in the totals. Reopening is the only
 * supported way to edit an agreed request, which is why it exists. */
router.post("/:id/requests/:requestId/reopen", async (req, res) => {
  try {
    const { budget, request, error } = await budgetAndRequestForReview(req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    const before = (budget.items || []).length;
    budget.items = (budget.items || []).filter(
      (i) => !(i.sourceRequestId && String(i.sourceRequestId) === String(request._id)),
    );
    const withdrew = before - budget.items.length;

    request.state = "submitted";
    request.agreedAmount = undefined;
    if (req.body?.financeNote !== undefined) request.financeNote = req.body.financeNote;
    request.updatedAt = new Date();
    request.updatedBy = actorOf(req);

    recacheBudgetTotals(budget);
    await budget.save();

    res.json({
      success: true,
      request,
      withdrewAllocations: withdrew,
      totals: {
        totalAllocated: budget.totalAllocated,
        totalRevenueAllocated: budget.totalRevenueAllocated,
        totalExpenseAllocated: budget.totalExpenseAllocated,
      },
    });
  } catch (error) {
    console.error("[budgets] reopen request error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * ADJUSTMENTS — supplementary budget and revisions (Chunk 7)
 *
 * Chunk 6 made over-budget spend require a written override. That was the
 * point, but an override is meant to be EXCEPTIONAL: a team that needs more
 * money every week writes the same excuse every week, and a control everyone
 * routinely waves through has stopped being a control. This is the path that
 * fixes the number instead of excusing the breach.
 *
 * Not a transfer. Nothing here moves money BETWEEN heads — every adjustment
 * changes exactly one line, up or down, on its own terms.
 * ═══════════════════════════════════════════════════════════════════════════ */

/* When an allocation may still be adjusted. Deliberately the live statuses,
 * NOT the ones under which requests are collected: the whole point is that
 * this is how you change a budget that is already running. `exceeded` is
 * included because a blown budget is the single most likely thing anyone
 * needs to adjust — refusing there would force the override path we are
 * trying to replace. */
const ADJUSTABLE_STATES = ["review", "active", "exceeded"];

/** Resolve budget + adjustment for a review action, with the same 404/409
 *  vocabulary the request-review helpers use. */
async function budgetAndAdjustment(req, { mutating = true } = {}) {
  if (!isUsableId(req.params.id)) {
    return { error: { status: 404, message: "Budget not found" } };
  }
  const budget = await Acc_Budget.findOne(scopeFilter(req, req.params.id));
  if (!budget) return { error: { status: 404, message: "Budget not found" } };

  if (mutating && !ADJUSTABLE_STATES.includes(budget.status)) {
    return {
      error: {
        status: 409,
        message: `This budget is ${budget.status}; its allocations can no longer be adjusted.`,
      },
    };
  }

  if (req.params.adjustmentId !== undefined) {
    if (!isUsableId(req.params.adjustmentId)) {
      return { error: { status: 404, message: "Adjustment not found" } };
    }
    const adjustment = budget.adjustments.id(req.params.adjustmentId);
    if (!adjustment) return { error: { status: 404, message: "Adjustment not found" } };
    return { budget, adjustment };
  }

  return { budget };
}

/**
 * Both shapes, resolved to both numbers.
 *
 * A supplementary states a delta, a revision states a destination — but a
 * reader should never have to know which to answer "what does this become?",
 * so whichever was given, the other is derived from the snapshot and both are
 * stored. Returns `{ ok }` or `{ ok: false, message }`.
 */
function resolveAmounts({ type, currentAllocatedAmount, requestedDeltaAmount, requestedNewAmount }) {
  const current = variance.money(currentAllocatedAmount) ?? 0;

  if (type === "supplementary") {
    const delta = variance.money(requestedDeltaAmount);
    if (delta === null) {
      return { ok: false, message: "requestedDeltaAmount must be a number" };
    }
    /* A supplementary is by definition MORE. A negative one is a revision
     * downward wearing the wrong label, and letting it through would mean two
     * names for one operation and a list nobody can read at a glance. */
    if (delta <= 0) {
      return {
        ok: false,
        message: "requestedDeltaAmount must be greater than 0 — to reduce an allocation, request a revision instead",
      };
    }
    return { ok: true, delta, next: current + delta };
  }

  const next = variance.money(requestedNewAmount);
  if (next === null) return { ok: false, message: "requestedNewAmount must be a number" };
  if (next < 0) return { ok: false, message: "requestedNewAmount must be ≥ 0" };
  return { ok: true, delta: next - current, next };
}

/* ── LIST ──────────────────────────────────────────────────────────────── */
router.get("/:id/adjustments", async (req, res) => {
  try {
    const { budget, error } = await budgetAndAdjustment(req, { mutating: false });
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    res.json({
      success: true,
      adjustments: budget.adjustments || [],
      budgetStatus: budget.status,
      adjustable: ADJUSTABLE_STATES.includes(budget.status),
    });
  } catch (error) {
    console.error("[budgets] list adjustments error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── SUBMIT ────────────────────────────────────────────────────────────────
 * Asking changes nothing. The allocation moves on approval and only there —
 * a request that quietly raised the number would make the review meaningless
 * and let anyone with the endpoint spend whatever they liked. */
router.post("/:id/adjustments", async (req, res) => {
  try {
    const { budget, error } = await budgetAndAdjustment(req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    const body = req.body || {};
    const type = body.type;
    if (!["supplementary", "revision"].includes(type)) {
      return res.status(400).json({
        success: false,
        message: 'type must be "supplementary" or "revision"',
      });
    }

    if (!isUsableId(body.targetItemId)) {
      return res.status(404).json({ success: false, message: "Budget line not found" });
    }
    const item = budget.items.id(body.targetItemId);
    if (!item) {
      return res.status(404).json({ success: false, message: "Budget line not found" });
    }

    const current = variance.money(item.allocatedAmount) ?? 0;
    const amounts = resolveAmounts({
      type,
      currentAllocatedAmount: current,
      requestedDeltaAmount: body.requestedDeltaAmount,
      requestedNewAmount: body.requestedNewAmount,
    });
    if (!amounts.ok) {
      return res.status(400).json({ success: false, message: amounts.message });
    }

    if (!String(body.reason || "").trim() && !String(body.justification || "").trim()) {
      return res.status(400).json({
        success: false,
        message: "either reason or justification is required",
      });
    }

    const priorityError = invalidEnumField(Acc_Budget, "adjustments.priority", body.priority);
    if (priorityError) return res.status(400).json({ success: false, message: priorityError });

    /* Built field by field rather than spread from the body. Everything below
     * is either derived from the TARGET LINE or stamped by the server; a
     * request that could name its own approvedNewAmount, state or reviewedBy
     * would be a request that approves itself. */
    budget.adjustments.push({
      type,
      targetItemId: item._id,
      sourceRequestId: item.sourceRequestId || undefined,
      department: item.department || null,
      ledgerId: item.ledgerId || undefined,
      ledgerName: item.ledgerName || null,
      groupName: item.groupName || null,
      nature: item.nature || "expense",
      currentAllocatedAmount: current,
      requestedDeltaAmount: amounts.delta,
      requestedNewAmount: amounts.next,
      reason: body.reason,
      justification: body.justification,
      priority: body.priority || "normal",
      state: "submitted",
      requestedAt: new Date(),
      requestedBy: actorOf(req),
    });

    await budget.save();
    const created = budget.adjustments[budget.adjustments.length - 1];
    res.status(201).json({ success: true, adjustment: created });
  } catch (error) {
    console.error("[budgets] create adjustment error:", error);
    res.status(400).json({ success: false, message: error.message });
  }
});

/* ── APPROVE ───────────────────────────────────────────────────────────────
 * The one operation here that moves money.
 *
 * `appliedAt` is the idempotency key. A double-click, a retried request or a
 * flaky connection must not add the same ₹5L twice — and unlike a voucher,
 * there is no ledger to reconcile against that would ever reveal it. */
router.post("/:id/adjustments/:adjustmentId/approve", async (req, res) => {
  try {
    const { budget, adjustment, error } = await budgetAndAdjustment(req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    if (adjustment.appliedAt) {
      return res.status(409).json({
        success: false,
        message: "This adjustment has already been applied.",
        adjustment,
      });
    }
    if (adjustment.state === "rejected" || adjustment.state === "cancelled") {
      return res.status(409).json({
        success: false,
        message: `This adjustment is ${adjustment.state} and cannot be approved.`,
      });
    }

    /* The line may have moved since the request was raised — another
     * adjustment approved in between, or an edit. Re-read it, and re-derive
     * from what is TRUE NOW rather than from the snapshot: a supplementary
     * means "₹5L more than whatever it is", and applying it against a stale
     * base would grant an amount nobody decided on. */
    const item = budget.items.id(adjustment.targetItemId);
    if (!item) {
      return res.status(409).json({
        success: false,
        message: "The budget line this adjustment targets no longer exists.",
      });
    }
    const liveCurrent = variance.money(item.allocatedAmount) ?? 0;

    /* Finance may grant something other than what was asked, stated the same
     * way the request was. Omitting both approves the request as it stands. */
    const amounts = resolveAmounts({
      type: adjustment.type,
      currentAllocatedAmount: liveCurrent,
      requestedDeltaAmount:
        req.body?.approvedDeltaAmount !== undefined && req.body?.approvedDeltaAmount !== null && req.body?.approvedDeltaAmount !== ""
          ? req.body.approvedDeltaAmount
          : adjustment.requestedDeltaAmount,
      requestedNewAmount:
        req.body?.approvedNewAmount !== undefined && req.body?.approvedNewAmount !== null && req.body?.approvedNewAmount !== ""
          ? req.body.approvedNewAmount
          : adjustment.requestedNewAmount,
    });
    if (!amounts.ok) {
      return res.status(400).json({ success: false, message: amounts.message });
    }

    item.allocatedAmount = amounts.next;

    adjustment.approvedDeltaAmount = amounts.delta;
    adjustment.approvedNewAmount = amounts.next;
    adjustment.currentAllocatedAmount = liveCurrent;
    adjustment.state = "approved";
    adjustment.appliedAt = new Date();
    adjustment.reviewedAt = new Date();
    adjustment.reviewedBy = actorOf(req);
    if (req.body?.financeNote !== undefined) adjustment.financeNote = req.body.financeNote;

    recacheBudgetTotals(budget);
    await budget.save();

    res.json({
      success: true,
      adjustment,
      item,
      totals: {
        totalAllocated: budget.totalAllocated,
        totalRevenueAllocated: budget.totalRevenueAllocated,
        totalExpenseAllocated: budget.totalExpenseAllocated,
      },
    });
  } catch (error) {
    console.error("[budgets] approve adjustment error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── REJECT ────────────────────────────────────────────────────────────────
 * Answers the request without touching a rupee. */
router.post("/:id/adjustments/:adjustmentId/reject", async (req, res) => {
  try {
    const { budget, adjustment, error } = await budgetAndAdjustment(req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    if (adjustment.appliedAt) {
      return res.status(409).json({
        success: false,
        message: "This adjustment has already been applied and cannot be rejected.",
      });
    }

    adjustment.state = "rejected";
    adjustment.reviewedAt = new Date();
    adjustment.reviewedBy = actorOf(req);
    if (req.body?.financeNote !== undefined) adjustment.financeNote = req.body.financeNote;

    await budget.save();
    res.json({ success: true, adjustment });
  } catch (error) {
    console.error("[budgets] reject adjustment error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── CANCEL ────────────────────────────────────────────────────────────────
 * The requester withdrawing their own ask. Distinct from `rejected`, which is
 * finance's answer — collapsing the two would lose who decided. */
router.post("/:id/adjustments/:adjustmentId/cancel", async (req, res) => {
  try {
    const { budget, adjustment, error } = await budgetAndAdjustment(req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    if (adjustment.appliedAt) {
      return res.status(409).json({
        success: false,
        message: "This adjustment has already been applied and cannot be cancelled.",
      });
    }
    if (adjustment.state !== "submitted") {
      return res.status(409).json({
        success: false,
        message: `Only a submitted adjustment can be withdrawn (this one is ${adjustment.state}).`,
      });
    }

    adjustment.state = "cancelled";
    adjustment.reviewedAt = new Date();
    adjustment.reviewedBy = actorOf(req);

    await budget.save();
    res.json({ success: true, adjustment });
  } catch (error) {
    console.error("[budgets] cancel adjustment error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * TRANSFERS — moving approved amount between lines (Chunk 8)
 *
 * Not extra money. A supplementary raises what the company has committed; a
 * transfer leaves the total exactly where it was and changes only who may
 * spend it. Separate from adjustments because finance signs the two off on
 * different grounds — "can we afford more?" versus "is Admin really not going
 * to use this?" — and one list mixing them would hide that.
 *
 * THE INVARIANT: you cannot move money that has already been spent. `allocated`
 * alone is not availability. A line with ₹1L allocated and ₹90k consumed has
 * ₹10k to give; transferring against the allocation would leave the source
 * instantly over budget through no act of its own, and the first thing anyone
 * would notice is the dashboard turning red on a department that did nothing.
 *
 * Availability is therefore computed from EVALUATED actuals — the same posted
 * vouchers every other figure in this module reads — and re-checked at approve
 * time, because spend keeps arriving between the ask and the decision.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Same live-enough-to-change rule as adjustments. */
const TRANSFERABLE_STATES = ADJUSTABLE_STATES;

/**
 * What one line can actually give away, right now.
 *
 * Returns the line's evaluated actual and `remaining` = allocated − actual,
 * floored at zero: a line already over budget has nothing to give, and a
 * negative "available" would let an overspent line fund another one.
 *
 * Revenue lines are included for completeness but a transfer between natures
 * is refused below — moving a sales target into a freight budget is not a
 * thing that means anything.
 */
async function availabilityFor(budget, req, items) {
  const hydrated = await actuals.hydrateLines({
    companyId: actualsCompanyFor(budget, req),
    lines: items.map((i) => ({
      _id: i._id,
      ledgerId: i.ledgerId,
      nature: i.nature,
      allocatedAmount: i.allocatedAmount,
    })),
    from: budget.startDate,
    to: budget.endDate,
  });

  return new Map(
    hydrated.map((h) => {
      const allocated = variance.money(h.allocatedAmount) ?? 0;
      const actual = variance.money(h.actual) ?? 0;
      return [
        String(h._id),
        { allocated, actual, remaining: Math.max(0, allocated - actual) },
      ];
    }),
  );
}

/** Both sides of a transfer, resolved and validated. */
async function resolveTransferSides(budget, req, { fromItemId, toItemId }) {
  if (!isUsableId(fromItemId) || !isUsableId(toItemId)) {
    return { error: { status: 404, message: "Budget line not found" } };
  }
  if (String(fromItemId) === String(toItemId)) {
    return {
      error: { status: 400, message: "A transfer needs two different lines." },
    };
  }

  const from = budget.items.id(fromItemId);
  const to = budget.items.id(toItemId);
  if (!from || !to) {
    return { error: { status: 404, message: "Budget line not found" } };
  }

  /* Expense and revenue are not the same currency of decision. Moving a sales
   * target into a freight budget would make both numbers meaningless and the
   * net figure silently wrong. */
  const fromNature = from.nature === "revenue" ? "revenue" : "expense";
  const toNature = to.nature === "revenue" ? "revenue" : "expense";
  if (fromNature !== toNature) {
    return {
      error: {
        status: 400,
        message: `Cannot transfer between a ${fromNature} line and a ${toNature} one — they are different kinds of number.`,
      },
    };
  }

  const avail = await availabilityFor(budget, req, [from, to]);
  return { from, to, avail };
}

const snapshotOf = (item, a) => ({
  department: item.department || null,
  ledgerId: item.ledgerId || undefined,
  ledgerName: item.ledgerName || null,
  groupName: item.groupName || null,
  nature: item.nature || "expense",
  allocatedAmount: a.allocated,
  actual: a.actual,
  remaining: a.remaining,
});

/** Budget + transfer for a review action. */
async function budgetAndTransfer(req, { mutating = true } = {}) {
  if (!isUsableId(req.params.id)) {
    return { error: { status: 404, message: "Budget not found" } };
  }
  const budget = await Acc_Budget.findOne(scopeFilter(req, req.params.id));
  if (!budget) return { error: { status: 404, message: "Budget not found" } };

  if (mutating && !TRANSFERABLE_STATES.includes(budget.status)) {
    return {
      error: {
        status: 409,
        message: `This budget is ${budget.status}; its allocations can no longer be moved.`,
      },
    };
  }

  if (req.params.transferId !== undefined) {
    if (!isUsableId(req.params.transferId)) {
      return { error: { status: 404, message: "Transfer not found" } };
    }
    const transfer = budget.transfers.id(req.params.transferId);
    if (!transfer) return { error: { status: 404, message: "Transfer not found" } };
    return { budget, transfer };
  }

  return { budget };
}

/* ── LIST ──────────────────────────────────────────────────────────────── */
router.get("/:id/transfers", async (req, res) => {
  try {
    const { budget, error } = await budgetAndTransfer(req, { mutating: false });
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    res.json({
      success: true,
      transfers: budget.transfers || [],
      budgetStatus: budget.status,
      transferable: TRANSFERABLE_STATES.includes(budget.status),
    });
  } catch (error) {
    console.error("[budgets] list transfers error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── AVAILABILITY ──────────────────────────────────────────────────────────
 * What each line could give away, so the form can show it before anyone
 * types a number they cannot have. Read-only. */
router.get("/:id/transfers/available", async (req, res) => {
  try {
    const { budget, error } = await budgetAndTransfer(req, { mutating: false });
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    const avail = await availabilityFor(budget, req, budget.items || []);
    res.json({
      success: true,
      lines: (budget.items || []).map((i) => {
        const a = avail.get(String(i._id)) || { allocated: 0, actual: 0, remaining: 0 };
        return {
          _id: i._id,
          ledgerId: i.ledgerId || null,
          ledgerName: i.ledgerName || null,
          groupName: i.groupName || null,
          department: i.department || null,
          nature: i.nature || "expense",
          ...a,
        };
      }),
    });
  } catch (error) {
    console.error("[budgets] transfer availability error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── SUBMIT ────────────────────────────────────────────────────────────────
 * Asking moves nothing, exactly as with adjustments. Availability is checked
 * here too, but only to refuse an obviously impossible ask early and to
 * record what was true when the case was made — approve re-checks, because
 * spend keeps arriving in between and that check is the authoritative one. */
router.post("/:id/transfers", async (req, res) => {
  try {
    const { budget, error } = await budgetAndTransfer(req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    const body = req.body || {};
    const sides = await resolveTransferSides(budget, req, body);
    if (sides.error) {
      return res.status(sides.error.status).json({ success: false, message: sides.error.message });
    }
    const { from, to, avail } = sides;

    const amount = variance.money(body.amount);
    if (amount === null || amount <= 0) {
      return res.status(400).json({ success: false, message: "amount must be greater than 0" });
    }

    const fromAvail = avail.get(String(from._id));
    if (amount > fromAvail.remaining) {
      return res.status(400).json({
        success: false,
        message: `${from.ledgerName || "That line"} has only ₹${Math.round(fromAvail.remaining).toLocaleString("en-IN")} left to give — ₹${Math.round(fromAvail.actual).toLocaleString("en-IN")} of its ₹${Math.round(fromAvail.allocated).toLocaleString("en-IN")} is already spent.`,
        available: fromAvail,
      });
    }

    if (!String(body.reason || "").trim()) {
      return res.status(400).json({ success: false, message: "reason is required" });
    }

    /* Built field by field. A body that could set state, appliedAt or
     * reviewedBy would be a transfer that approves itself. */
    budget.transfers.push({
      fromItemId: from._id,
      toItemId: to._id,
      amount,
      reason: body.reason,
      state: "submitted",
      fromSnapshot: snapshotOf(from, fromAvail),
      toSnapshot: snapshotOf(to, avail.get(String(to._id))),
      requestedAt: new Date(),
      requestedBy: actorOf(req),
    });

    await budget.save();
    res.status(201).json({
      success: true,
      transfer: budget.transfers[budget.transfers.length - 1],
    });
  } catch (error) {
    console.error("[budgets] create transfer error:", error);
    res.status(400).json({ success: false, message: error.message });
  }
});

/* ── APPROVE ───────────────────────────────────────────────────────────────
 * The money moves here and nowhere else. Both sides change in one save, so a
 * transfer can never half-happen and leave the budget's total wrong. */
router.post("/:id/transfers/:transferId/approve", async (req, res) => {
  try {
    const { budget, transfer, error } = await budgetAndTransfer(req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    if (transfer.appliedAt) {
      return res.status(409).json({
        success: false,
        message: "This transfer has already been applied.",
        transfer,
      });
    }
    if (transfer.state === "rejected" || transfer.state === "cancelled") {
      return res.status(409).json({
        success: false,
        message: `This transfer is ${transfer.state} and cannot be approved.`,
      });
    }

    const from = budget.items.id(transfer.fromItemId);
    const to = budget.items.id(transfer.toItemId);
    if (!from || !to) {
      return res.status(409).json({
        success: false,
        message: "A budget line this transfer refers to no longer exists.",
      });
    }

    /* Re-checked against what is TRUE NOW, not against the snapshot. Spend
     * arrives between the ask and the decision, and approving a week-old
     * "₹1L unused" that has since been consumed is exactly how a source line
     * ends up over budget without spending anything new. */
    const avail = await availabilityFor(budget, req, [from, to]);
    const fromAvail = avail.get(String(from._id));
    const amount = variance.money(transfer.amount) ?? 0;

    if (amount > fromAvail.remaining) {
      return res.status(409).json({
        success: false,
        message: `${from.ledgerName || "The source line"} no longer has ₹${Math.round(amount).toLocaleString("en-IN")} to give — ₹${Math.round(fromAvail.remaining).toLocaleString("en-IN")} is left after ₹${Math.round(fromAvail.actual).toLocaleString("en-IN")} of spend.`,
        available: fromAvail,
      });
    }

    from.allocatedAmount = (variance.money(from.allocatedAmount) ?? 0) - amount;
    to.allocatedAmount = (variance.money(to.allocatedAmount) ?? 0) + amount;

    /* Belt and braces on rule 10. The availability check above already makes
     * this impossible, but an allocation that went negative would poison
     * every roll-up that touches it, so it is asserted rather than assumed. */
    if (from.allocatedAmount < 0) {
      return res.status(409).json({
        success: false,
        message: "That transfer would take the source line below zero.",
      });
    }

    transfer.state = "approved";
    transfer.appliedAt = new Date();
    transfer.reviewedAt = new Date();
    transfer.reviewedBy = actorOf(req);
    if (req.body?.financeNote !== undefined) transfer.financeNote = req.body.financeNote;

    recacheBudgetTotals(budget);
    await budget.save();

    res.json({
      success: true,
      transfer,
      from,
      to,
      totals: {
        totalAllocated: budget.totalAllocated,
        totalRevenueAllocated: budget.totalRevenueAllocated,
        totalExpenseAllocated: budget.totalExpenseAllocated,
      },
    });
  } catch (error) {
    console.error("[budgets] approve transfer error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── REJECT ────────────────────────────────────────────────────────────── */
router.post("/:id/transfers/:transferId/reject", async (req, res) => {
  try {
    const { budget, transfer, error } = await budgetAndTransfer(req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    if (transfer.appliedAt) {
      return res.status(409).json({
        success: false,
        message: "This transfer has already been applied and cannot be rejected.",
      });
    }

    transfer.state = "rejected";
    transfer.reviewedAt = new Date();
    transfer.reviewedBy = actorOf(req);
    if (req.body?.financeNote !== undefined) transfer.financeNote = req.body.financeNote;

    await budget.save();
    res.json({ success: true, transfer });
  } catch (error) {
    console.error("[budgets] reject transfer error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── CANCEL ────────────────────────────────────────────────────────────────
 * The requester withdrawing. Distinct from rejected, which is finance's
 * answer — collapsing them would lose who decided. */
router.post("/:id/transfers/:transferId/cancel", async (req, res) => {
  try {
    const { budget, transfer, error } = await budgetAndTransfer(req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    if (transfer.appliedAt) {
      return res.status(409).json({
        success: false,
        message: "This transfer has already been applied and cannot be cancelled.",
      });
    }
    if (transfer.state !== "submitted") {
      return res.status(409).json({
        success: false,
        message: `Only a submitted transfer can be withdrawn (this one is ${transfer.state}).`,
      });
    }

    transfer.state = "cancelled";
    transfer.reviewedAt = new Date();
    transfer.reviewedBy = actorOf(req);

    await budget.save();
    res.json({ success: true, transfer });
  } catch (error) {
    console.error("[budgets] cancel transfer error:", error);
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
