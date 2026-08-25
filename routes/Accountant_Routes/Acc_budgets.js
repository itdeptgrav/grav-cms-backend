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
const { Acc_Ledger, Acc_Group, Acc_CostCentre } = require("../../models/Accountant_model/Acc_MasterModels");
const variance = require("../../services/budgetVariance.service");
const actuals = require("../../services/budgetActuals.service");
const overlap = require("../../services/budgetOverlap.service");
const control = require("../../services/budgetControl.service");
const departments = require("../../services/budgetDepartment.service");

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

/* ═══════════════════════════════════════════════════════════════════════════
 * AUTHORIZATION
 *
 * Until now every authenticated accountant could do everything on this router
 * — raise a request AND agree it, ask for extra budget AND approve it. The
 * review steps built in Chunks 3, 7 and 8 were procedure, not control.
 *
 * ── WHAT THE TOKEN ACTUALLY SUPPORTS ────────────────────────────────────────
 * `permissions` is derived from the role by AccountantAuthMiddleware and is
 * reliable:
 *     owner              canEdit + canApprove
 *     approver           canEdit + canApprove
 *     editor             canEdit
 *     viewer             neither
 *     legacy admin /
 *     accountant         canEdit + canApprove   ← existing admins keep working
 *
 * So "who may spend" and "who may sign off" can be separated properly today.
 *
 * ── WHAT IT DOES NOT SUPPORT ────────────────────────────────────────────────
 * There is no DEPARTMENT on the token. A department REGISTRY now exists
 * (Acc_BudgetDepartment), so "Logistics" is finally one department rather than
 * three spellings — but knowing which departments exist is not the same as
 * knowing which one the person signing in belongs to, and nothing on the token
 * says. "Logistics may only raise Logistics requests" therefore still cannot
 * be enforced: it needs a membership model, and a check built on data nobody
 * maintains is worse than a documented gap, because it reads as protection
 * while enforcing nothing.
 *
 * What CAN be enforced without that data is four-eyes: you may not sign off
 * your own ask. That is the same rule Acc_approvals.js already applies to
 * voucher approvals, owner-exempt for the same reason (one owner per org, so
 * requiring a second pair would deadlock a small team).
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Gate for anything that WRITES a budget, a request, or an ask. */
function requireEdit(req, res) {
  if (req.user?.permissions?.canEdit) return false;
  res.status(403).json({
    success: false,
    message: "Your accounting role is read-only, so this change was not saved.",
  });
  return true;
}

/**
 * Gate for a FINANCE DECISION — agreeing a request, approving an adjustment,
 * approving a transfer. `author` is whoever raised the thing being decided;
 * pass it and the four-eyes rule applies.
 */
function requireFinance(req, res, author) {
  if (!req.user?.permissions?.canApprove) {
    res.status(403).json({
      success: false,
      message: "Only finance can approve budget changes.",
    });
    return true;
  }

  if (author && req.user?.role !== "owner" && sameActor(author, req)) {
    res.status(403).json({
      success: false,
      message:
        "You cannot approve your own request. Ask another approver or the owner.",
    });
    return true;
  }

  return false;
}

/**
 * Is `author` the person making this request?
 *
 * `requestedBy`/`submittedBy` store whatever actorOf() produced — email, then
 * name, then id — so the comparison has to try all three rather than assume
 * one. A mismatch here fails OPEN (the action is allowed), which is the right
 * side to err on: refusing a legitimate approver because their token carries a
 * name and the record carries an email would block finance entirely.
 */
function sameActor(author, req) {
  const a = String(author || "").trim().toLowerCase();
  if (!a) return false;
  return [req.user?.email, req.user?.name, req.user?.id]
    .filter(Boolean)
    .some((v) => String(v).trim().toLowerCase() === a);
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
async function evaluate(budget, req, { asOf, resolver } = {}) {
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
    /* Only present on project budgets — see attributionOf. Null everywhere
     * else, so company and department budgets are byte-identical to before. */
    attribution: attributionOf(budget, evaluated),
    totals: variance.rollUp(evaluated),
    /* Grouped by identity when a resolver is in hand, so a budget carrying
     * both "Logistics" and "logistics" shows one row rather than two. Falls
     * back to plain slug grouping without one, which still folds case and
     * spacing — the registry sharpens this, it is not required for it. */
    byDepartment: groupLinesByDepartment(evaluated, resolver).map(({ _lines, ...d }) => d),
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

/**
 * Roll lines up by department IDENTITY rather than by the string on the line.
 *
 * Grouped by string, "Logistics", "logistics" and "LOGISTICS " were three rows
 * each holding a third of the answer. Used by the dashboard AND by a single
 * budget's own breakdown, so one department can never read as two on either.
 *
 * The row is labelled with the registry's name when the department is
 * registered, and otherwise with the spelling the most lines actually use —
 * labelling it with the first one encountered would make the heading depend on
 * which budget happened to be created first.
 */
function groupLinesByDepartment(lines, resolver) {
  const groups = new Map();
  for (const l of lines) {
    if (!l) continue;
    const hit = resolver ? resolver.resolve(l.department) : null;
    const slug = hit ? hit.slug : departments.slugify(l.department);
    if (!groups.has(slug)) {
      /* Only a REGISTERED department supplies the label. An unregistered one
       * resolves to its own raw text, and taking that would label the group
       * with whichever line happened to be read first — which is exactly the
       * first-seen behaviour the commonest-spelling rule below exists to
       * avoid. */
      groups.set(slug, {
        slug,
        known: !!hit?.known,
        name: hit?.known ? hit.name : null,
        spellings: new Map(),
        lines: [],
      });
    }
    const g = groups.get(slug);
    g.lines.push(l);
    if (l.department) {
      const raw = departments.displayOf(l.department);
      g.spellings.set(raw, (g.spellings.get(raw) || 0) + 1);
    }
  }

  return [...groups.values()]
    .map((g) => {
      const commonest = [...g.spellings.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      )[0];
      /* "Unassigned" is not a department — it is the absence of one, and it
       * has always been the label for lines carrying none. */
      const name = g.slug === "" ? "Unassigned" : g.name || commonest?.[0] || g.slug;
      return {
        ...variance.rollUp(g.lines),
        /* What this department IS, read off its own lines. Nobody declares it:
         * only expense lines make a cost centre, only revenue a revenue
         * centre, both a contribution centre, and none at all is an absence
         * rather than a classification. See variance.centreOf. */
        centre: variance.centreOf(g.lines),
        /* `name` and `department` stay the display string every existing
         * consumer already reads; `departmentSlug` is the identity, for a
         * caller that wants to filter without guessing the spelling. */
        name,
        department: name,
        departmentSlug: g.slug || null,
        registered: g.known,
        /* Said out loud when one department is on screen under more than one
         * spelling: the row now adds up correctly, but the underlying data is
         * still inconsistent and someone should tidy it. */
        spellings: g.spellings.size > 1 ? [...g.spellings.keys()].sort() : undefined,
        /* `lines` is the count groupBy has always returned under this name;
         * `lineCount` is the same number said clearly. */
        lines: g.lines.length,
        lineCount: g.lines.length,
        _lines: g.lines,
      };
    })
    .sort(
      (a, b) =>
        b.revenue.allocated + b.expense.allocated - (a.revenue.allocated + a.expense.allocated) ||
        a.name.localeCompare(b.name),
    );
}

/**
 * The budgets that name a department, whichever way it is spelled.
 *
 * Takes the slug of what the caller asked for and compares it against the slug
 * of every line, so `?department=logistics`, `?department=Logistics` and a
 * registered alias all select the same set. Done in JS deliberately: an
 * equality match in the query would answer only for the exact spelling stored,
 * which is the defect this chunk exists to remove.
 */
async function filterByDepartment(budgets, department, req) {
  const resolver = await departments.departmentResolver({ companyId: companyOf(req) });
  const wanted = resolver.resolve(department);
  if (!wanted) return budgets;
  return budgets.filter((b) =>
    (b.items || []).some((l) => resolver.resolve(l.department)?.slug === wanted.slug),
  );
}

/* ── LIST ────────────────────────────────────────────────────────────────── */
router.get("/", async (req, res) => {
  try {
    const { financialYear, status, period, department, scope, withTotals } = req.query;
    const filter = {};
    if (financialYear) filter.financialYear = financialYear;
    if (status) filter.status = status;
    if (period) filter.period = period;
    /* Rows written before the field existed have no `scope` at all, and they
     * are company budgets — so filtering for company has to include them, or
     * every pre-existing budget disappears the moment someone uses the filter. */
    if (scope === "company") filter.$and = [{ $or: [{ scope: "company" }, { scope: { $exists: false } }, { scope: null }] }];
    else if (scope) filter.scope = scope;

    const companyId = companyOf(req);
    if (companyId) {
      const cid = actuals.oid(companyId);
      // Rows written before companyId existed must stay visible to their books.
      if (cid) filter.$or = [{ companyId: cid }, { companyId: { $exists: false } }, { companyId: null }];
    }

    const found = await Acc_Budget.find(filter).sort({ createdAt: -1 }).lean();

    /* The department filter is applied HERE rather than in the query, because
     * Mongo would have to match one exact string and the whole problem is that
     * one department is written several ways. `logistics`, `Logistics` and the
     * registry's own slug all select the same budgets. */
    const budgets = department
      ? await filterByDepartment(found, department, req)
      : found;

    // The list is a list. Computing every budget's actuals here would run one
    // aggregation per row; opt in when the caller actually needs the figures.
    if (String(withTotals) !== "true") {
      return res.json({ success: true, budgets });
    }

    const listResolver = await departments.departmentResolver({ companyId: companyOf(req) });
    const hydrated = await Promise.all(
      budgets.map((b) => evaluate(b, req, { resolver: listResolver })),
    );
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

/**
 * What is waiting on finance for one budget.
 *
 * "Pending" means submitted and undecided. An agreed request, a rejected
 * adjustment and a cancelled transfer are all ANSWERED — counting them would
 * make the number grow forever and stop meaning "there is work here".
 */
function pendingCounts(budget) {
  const requests = (budget.budgetRequests || []).filter(
    (r) => r.state === "submitted" || r.state === "awaiting" || r.state === "countered",
  ).length;
  const adjustments = (budget.adjustments || []).filter((a) => a.state === "submitted").length;
  const transfers = (budget.transfers || []).filter((t) => t.state === "submitted").length;
  return { requests, adjustments, transfers, total: requests + adjustments + transfers };
}

/** Worst severity across a set of evaluated lines. `worseOf` is the service's
 *  own combining rule: signals combine by taking the worst, never by
 *  averaging, because an averaged alarm is one that fails to ring. */
function worstSeverity(lines = []) {
  return lines.reduce((acc, l) => variance.worseOf(acc, l.severity || "info"), "info");
}

const sumOf = (lines, field) =>
  lines.reduce((s, l) => s + (variance.money(l[field]) ?? 0), 0);

/**
 * Actual revenue and expense per calendar month, for the dashboard chart.
 *
 * `allLines` is already department-filtered, and `linesOf` is the dashboard's
 * own selector, so the chart narrows with the rest of the screen rather than
 * quietly showing everything — and narrows by exactly the same rule.
 *
 * Returns [] when there is nothing to draw — an empty array renders as an
 * empty state, whereas a series of zeroes draws a flat line along the axis
 * and reads as "we spent nothing", which is a different and wrong claim.
 */
async function monthlySeries(evaluated, allLines, req, linesOf) {
  const ledgerIds = [...new Set(allLines.map((l) => l.ledgerId).filter(Boolean).map(String))];
  if (!ledgerIds.length || !evaluated.length) return [];

  /* The union of every in-scope budget's period. */
  const from = evaluated.reduce((min, b) => (!min || b.startDate < min ? b.startDate : min), null);
  const to = evaluated.reduce((max, b) => (!max || b.endDate > max ? b.endDate : max), null);

  /* Nature per head, from the ledger tree — the same authority the actuals
   * use, so a re-parented head moves sides here too. */
  const natures = await actuals.natureByLedger(ledgerIds);

  const rows = await actuals.monthlyMovement({
    companyId: actualsCompanyFor(evaluated[0], req),
    ledgerIds,
    from,
    to,
  });

  const byMonth = new Map();
  const bucket = (key) => {
    if (!byMonth.has(key)) {
      byMonth.set(key, { key, revenue: 0, expense: 0, plannedExpense: 0, plannedRevenue: 0 });
    }
    return byMonth.get(key);
  };

  for (const r of rows) {
    const nature = natures.get(String(r.ledgerId))?.nature || "expense";
    const b = bucket(r.key);
    const amount = actuals.actualFrom(r, nature);
    if (nature === "revenue") b.revenue += amount;
    else b.expense += amount;
  }

  /* ── WHAT WAS PLANNED FOR EACH MONTH ──────────────────────────────────────
   * The line a manager actually reads the curve against: not "did we spend",
   * but "did we spend faster than the plan allowed".
   *
   * A budget states one number for a period, not twelve. Spreading it evenly
   * across the months it covers is the same assumption expectedToDate already
   * makes for every variance figure in this module — so the chart's plan line
   * and a line's `expectedToDate` cannot tell different stories. It is an
   * ASSUMPTION, not a fact: a budget with a real seasonal shape is not flat,
   * which is what `phasing` exists for, and a line carrying it is spread by
   * its own weights instead.
   *
   * Drawn as a hatched band rather than a solid one throughout the UI, for
   * exactly this reason — it is the plan, not money that moved. */
  for (const b of evaluated) {
    const months = monthsCovered(b.startDate, b.endDate);
    if (!months.length) continue;

    for (const item of linesOf(b)) {
      const alloc = variance.money(item.allocatedAmount) ?? 0;
      if (!(alloc > 0)) continue;
      const isRevenue = item.nature === "revenue";
      const weights = monthWeights(item.phasing, months.length);

      months.forEach((key, i) => {
        const share = alloc * weights[i];
        const target = bucket(key);
        if (isRevenue) target.plannedRevenue += share;
        else target.plannedExpense += share;
      });
    }
  }

  /* Every month in the window, including the ones nothing happened in — a
   * chart that skipped empty months would compress the gaps and misdraw the
   * shape of the year.
   *
   * The keys are built in IST, matching how the aggregation bucketed them.
   * Generating them from the server's local clock instead would drift by a
   * month at the boundary on any host not running IST — and the boundary is
   * 1 April, which is where every Indian financial year starts. */
  const out = [];
  const seen = new Set();
  /* Stepped in days rather than months so `setMonth` cannot skip February
     from a 31st, and clamped so a corrupt date range cannot spin. */
  const cursor = new Date(from);
  const end = new Date(to);
  while (cursor <= end && out.length < 120) {
    const key = istKey(cursor);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(byMonth.get(key) || { key, revenue: 0, expense: 0 });
    }
    cursor.setUTCDate(cursor.getUTCDate() + 15);
  }
  /* The final month can be missed when the window ends inside it. */
  const lastKey = istKey(end);
  if (!seen.has(lastKey)) out.push(byMonth.get(lastKey) || { key: lastKey, revenue: 0, expense: 0 });

  /* Empty months INSIDE the range stay — a quiet quarter is part of the shape
   * of the year. Empty months at the ENDS are trimmed: an old closed budget in
   * scope stretches the union across financial years, and two thirds of the
   * axis showing nothing tells the reader less than the same chart drawn over
   * the months that actually have movement. */
  const active = (m) =>
    m.revenue !== 0 || m.expense !== 0 || m.plannedExpense !== 0 || m.plannedRevenue !== 0;
  const first = out.findIndex(active);
  if (first === -1) return [];
  let last = out.length - 1;
  while (last > first && !active(out[last])) last--;
  return out.slice(first, last + 1);
}

/** "2026-04" for a date, in IST. Shared so every month bucket in this file
 *  is keyed the same way — see monthlySeries for why IST and not UTC. */
const istKey = (d) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
  }).format(d);

/** Every IST month key a period touches, in order. */
function monthsCovered(start, end) {
  if (!start || !end) return [];
  const out = [];
  const seen = new Set();
  const cursor = new Date(start);
  const last = new Date(end);
  while (cursor <= last && out.length < 120) {
    const key = istKey(cursor);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 15);
  }
  const endKey = istKey(last);
  if (!seen.has(endKey)) out.push(endKey);
  return out;
}

/**
 * How one line's allocation divides across the months it covers.
 *
 * Flat unless the line carries `phasing`, in which case those weights are
 * resampled onto the month count — the same weights expectedToDate uses, so
 * the plan line and the per-line expectation agree.
 */
function monthWeights(phasing, monthCount) {
  const raw = Array.isArray(phasing)
    ? phasing.map((w) => variance.money(w)).filter((w) => w !== null && w >= 0)
    : [];
  const total = raw.reduce((s, w) => s + w, 0);
  if (!raw.length || total <= 0) return Array(monthCount).fill(1 / monthCount);

  /* Buckets are equal slices of the period; map each month onto the slice it
   * sits in so a four-bucket phasing spreads sensibly over twelve months. */
  return Array.from({ length: monthCount }, (_, i) => {
    const idx = Math.min(raw.length - 1, Math.floor((i / monthCount) * raw.length));
    return raw[idx] / total / (monthCount / raw.length);
  });
}

/* ── OVERLAP DEDUPLICATION ───────────────────────────────────────────────────
 * A head budgeted in two overlapping budgets had its spend counted once per
 * budget, so the dashboard headline read double. See budgetOverlap.service.js
 * for the rule and for why allocations are deliberately NOT deduplicated.
 *
 * This runs on the dashboard only. Opening a single budget still shows the
 * actuals of that budget's own lines — that figure answers "what has been
 * spent against this head in this period", which is true of both budgets and
 * is what someone reading one budget is asking. It is the SUM across budgets
 * that cannot count the same payment twice.
 */

/* One aggregation row per (contested head, voucher). A dashboard is a screen:
 * past this the honest move is to publish the un-deduplicated figure and say
 * so, rather than a half-corrected one nobody can reconcile. */
/* Read per request rather than captured at module load, so the truncation
 * branch can be exercised in a test — it changes a headline figure, and an
 * untested branch that does that is the kind that is found in production. */
const maxDedupeRows = () => Number(process.env.BUDGET_MAX_DEDUPE_ROWS) || 20000;

/**
 * Recompute every line's actual so each voucher is counted exactly once.
 *
 * Takes the evaluated budgets and returns a NEW array with contested lines
 * re-evaluated against their won share. Uncontested lines are returned
 * untouched — their hydrated actual is already exclusive, and re-deriving it
 * would risk drift for no gain.
 *
 * `contestSet` is deliberately WIDER than `evaluated`: it drops the department
 * filter, because `department` is the one filter that slices INSIDE a budget
 * rather than deciding whether a budget is in force. Asking "what did
 * Logistics spend" must not hand Logistics a payment that Admin's budget
 * actually won just because Admin was filtered off the screen — the same line
 * would then report different actuals depending on what the reader was
 * looking at. It only needs each budget's window, scope, createdAt and line
 * heads, so it is a plain find() with no aggregation behind it.
 *
 * The other filters (financialYear, status, period, scope) DO narrow the
 * contest, and that is intended: they select which budgets the reader is
 * treating as in force, and a budget excluded from that set is not competing
 * for the money.
 */
async function dedupeOverlappingActuals(evaluated, contestSet, req, asOf) {
  const empty = {
    evaluated,
    overlap: {
      dedupeApplied: false,
      contestedHeads: 0,
      contestedMovements: 0,
      ambiguousMovements: 0,
      duplicateExpense: 0,
      duplicateRevenue: 0,
      reason: "no overlapping heads",
    },
  };
  if (!evaluated.length) return empty;

  /* Candidates grouped by the company their actuals are read from — a legacy
   * row falls back to the caller's, exactly as evaluate() does. Two budgets in
   * different companies are never in contest: they read different vouchers. */
  const groups = new Map();

  for (const b of contestSet) {
    const key = String(actualsCompanyFor(b, req) ?? "__any__");
    if (!groups.has(key)) groups.set(key, { companyId: actualsCompanyFor(b, req), candidates: [] });
    for (const line of b.items || []) {
      const c = overlap.candidateFrom(b, line);
      if (c) groups.get(key).candidates.push(c);
    }
  }

  const cap = maxDedupeRows();
  const won = new Map();
  const stats = { contestedHeads: 0, contestedMovements: 0, ambiguousMovements: 0, duplicateSigned: 0 };
  let touchedAny = false;

  for (const { companyId, candidates } of groups.values()) {
    const contested = overlap.contestedLedgers(candidates);
    if (!contested.length) continue;

    /* Only the lines on contested heads take part. A head claimed once is
     * already exclusive, and querying its vouchers would cost a round trip to
     * arrive back at the number it already has. */
    const inPlay = candidates.filter((c) => contested.includes(c.ledgerId));
    const from = new Date(Math.min(...inPlay.map((c) => c.startMs)));
    const to = new Date(Math.max(...inPlay.map((c) => c.endMs)));

    const { rows, truncated } = await actuals.voucherMovementsByLedgers({
      companyId,
      ledgerIds: contested,
      from,
      to,
      limit: cap,
    });

    /* Half a deduplication is wrong in a newer and less traceable way than the
     * double-count it replaces. Publish the old figure and say why. */
    if (truncated) {
      return {
        ...empty,
        overlap: {
          ...empty.overlap,
          contestedHeads: contested.length,
          reason: `more than ${cap} contested voucher movements`,
        },
      };
    }

    const assigned = overlap.assignMovements({ candidates: inPlay, movements: rows });
    for (const [key, value] of assigned.won) won.set(key, value);

    stats.contestedHeads += contested.length;
    stats.contestedMovements += assigned.stats.contestedMovements;
    stats.ambiguousMovements += assigned.stats.ambiguousMovements;
    stats.duplicateSigned += assigned.stats.duplicateSigned;
    touchedAny = true;
  }

  if (!touchedAny) return empty;

  /* Re-evaluate only the lines whose actual moved. Everything derived from an
   * actual — remaining, variance, pace, severity, utilisation — comes back out
   * of the same evaluateLine the rest of the module uses, against the line's
   * OWN budget window, so a deduplicated line is judged exactly as an
   * untouched one is. */
  let duplicateExpense = 0;
  let duplicateRevenue = 0;

  const out = evaluated.map((b) => {
    const items = (b.items || []).map((line) => {
      const key = `${b._id}:${line._id}`;
      const share = won.get(key);
      if (!share) return line;

      const deduped = actuals.actualFrom(
        { debit: share.debit, credit: share.credit, signed: share.debit - share.credit },
        line.nature,
      );
      const removed = (variance.money(line.actual) ?? 0) - deduped;
      if (line.nature === "revenue") duplicateRevenue += removed;
      else duplicateExpense += removed;

      const v = variance.evaluateLine({
        allocated: line.allocatedAmount,
        actual: deduped,
        nature: line.nature,
        startDate: b.startDate,
        endDate: b.endDate,
        asOf: asOf || b.asOf,
        phasing: line.phasing,
      });
      return {
        ...line,
        ...v,
        _id: line._id,
        department: line.department || null,
        voucherCount: share.voucherCount,
        /* So a surprising figure can be traced without re-deriving the rule:
         * this line's actual is its won share, not everything on the head. */
        dedupedActual: true,
      };
    });

    return { ...b, items, totals: variance.rollUp(items) };
  });

  return {
    evaluated: out,
    overlap: {
      dedupeApplied: true,
      contestedHeads: stats.contestedHeads,
      contestedMovements: stats.contestedMovements,
      ambiguousMovements: stats.ambiguousMovements,
      /* How much the headline used to overstate by. Kept because the first
       * question on seeing the number change is "by how much, and where". */
      duplicateExpense,
      duplicateRevenue,
      reason: null,
    },
  };
}

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
    const { financialYear, status, period, department, scope } = req.query;

    const scopeError = invalidEnumField(Acc_Budget, "scope", scope);
    if (scopeError) return res.status(400).json({ success: false, message: scopeError });
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
    /* Same legacy-inclusive rule as the list: an unset scope IS company. */
    if (scope === "company") {
      filter.$and = [{ $or: [{ scope: "company" }, { scope: { $exists: false } }, { scope: null }] }];
    } else if (scope) {
      filter.scope = scope;
    }

    const companyId = companyOf(req);
    if (companyId) {
      const cid = actuals.oid(companyId);
      if (cid) filter.$or = [{ companyId: cid }, { companyId: { $exists: false } }, { companyId: null }];
    }

    const resolver = await departments.departmentResolver({ companyId });
    /* One spelling to compare every line against. Null when no department
     * filter is in play, which every helper below reads as "no filter". */
    const wantedDepartment = department ? resolver.resolve(department) : null;

    const matched = await Acc_Budget.countDocuments(filter);
    /* The whole in-scope set, BEFORE any department narrowing. It is both the
     * contest set the overlap dedupe needs (which must ignore the department
     * filter — see dedupeOverlappingActuals) and the set the filter is applied
     * to, so the two cannot select differently. */
    const inScope = await Acc_Budget.find(filter).sort({ createdAt: -1 }).limit(MAX_BUDGETS).lean();

    /* Department narrowing happens here rather than in the query: Mongo can
     * only match the exact string stored, and one department is written
     * several ways. Applied BEFORE evaluate() so the budgets it excludes cost
     * nothing to exclude. */
    const budgets = wantedDepartment
      ? inScope.filter((b) =>
          (b.items || []).some((l) => resolver.resolve(l.department)?.slug === wantedDepartment.slug),
        )
      : inScope;

    const raw = await Promise.all(budgets.map((b) => evaluate(b, req, { asOf, resolver })));

    /* Each budget's own figures are right; their SUM was not, because a head
     * budgeted twice had its spend counted twice. Every surface below reads
     * `evaluated`, so correcting the lines here corrects the totals, the
     * department roll-up, the head roll-up, the attention lists and the
     * per-budget summaries together — they cannot drift apart. */
    /* Every in-scope budget, department filter or not — see
     * dedupeOverlappingActuals for why ownership of a voucher must not depend
     * on what the reader is looking at. Since the filter is now applied in JS
     * to this same list, the wider set is already in hand and costs nothing. */
    const { evaluated, overlap: overlapMeta } = await dedupeOverlappingActuals(
      raw,
      wantedDepartment ? inScope : raw,
      req,
      asOf,
    );

    /* `department` selects which BUDGETS are in scope (any line naming it),
     * exactly as the list route does. Once a budget is in scope the dashboard
     * shows only that department's lines — otherwise asking about Logistics
     * returns Logistics-shaped totals padded with every other department that
     * happens to share the budget. */
    const linesOf = (b) =>
      wantedDepartment
        ? (b.items || []).filter(
            (l) => resolver.resolve(l.department)?.slug === wantedDepartment.slug,
          )
        : b.items || [];

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
      /* Across everything in scope, so the strip can say "6 waiting" without
       * the caller re-adding the per-budget numbers. */
      pending: evaluated.reduce(
        (acc, b) => {
          const p = pendingCounts(b);
          return {
            requests: acc.requests + p.requests,
            adjustments: acc.adjustments + p.adjustments,
            transfers: acc.transfers + p.transfers,
            total: acc.total + p.total,
          };
        },
        { requests: 0, adjustments: 0, transfers: 0, total: 0 },
      ),
    };

    /* ── 2. By department ─────────────────────────────────────────────────
     * Grouped on the department's SLUG, not the string on the line. Grouped by
     * string, "Logistics", "logistics" and "LOGISTICS " were three rows on the
     * Departments tab, each holding a third of the answer.
     *
     * The row is labelled with the registry's name when the department is
     * registered, and otherwise with the spelling most lines actually use —
     * picking the first one encountered would make the label depend on which
     * budget happened to be created first. */
    const byDepartment = groupLinesByDepartment(allLines, resolver).map(({ _lines, ...d }) => ({
      ...d,
      expenseRemaining: sumOf(_lines.filter((l) => l.nature === "expense"), "remaining"),
      revenueToGo: sumOf(_lines.filter((l) => l.nature === "revenue"), "toGo"),
      severity: worstSeverity(_lines),
    }));

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
            department: null,
            departmentSlug: null,
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
         * rather than silently keeping whichever was read first — but compare
         * IDENTITY, or "Logistics" and "logistics" on one head would report as
         * "Multiple" when they are the same department twice. */
        if (!head.department) {
          head.department = l.department ? resolver.resolve(l.department).name : null;
          head.departmentSlug = l.department ? resolver.resolve(l.department).slug : null;
        } else if (l.department) {
          const slug = resolver.resolve(l.department).slug;
          if (head.departmentSlug && slug !== head.departmentSlug) {
            head.department = "Multiple";
            head.departmentSlug = null;
          }
        }
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
          /* A head the chart of accounts calls an asset or a liability is
           * neither a spend limit nor a target. Marked so the UI can stop
           * drawing it as an ordinary budget. */
          supported: head.nature === "expense" || head.nature === "revenue",
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

    /* Budgets with something sitting on finance's desk. Deliberately its own
     * list rather than folded into the others: everything above is a problem
     * with the NUMBERS, this is a queue with someone waiting at the end of
     * it — and until now a budget with three unanswered supplementaries
     * looked identical to one with none unless you opened it. */
    const pendingChanges = evaluated
      .map((b) => ({
        _id: b._id,
        name: b.name,
        status: b.status,
        financialYear: b.financialYear,
        scope: b.scope || "company",
        department: b.department || null,
        costCentreName: b.costCentreName || null,
        ...pendingCounts(b),
      }))
      .filter((p) => p.total > 0)
      .sort((a, b) => b.total - a.total);

    const attention = {
      overBudget,
      revenueBehind,
      highUtilization,
      unbound,
      noAllocations,
      pendingChanges,
      count:
        overBudget.length +
        revenueBehind.length +
        highUtilization.length +
        unbound.length +
        noAllocations.length +
        pendingChanges.length,
    };

    /* ── 4b. Monthly series ──────────────────────────────────────────────
     * The page's one large graphic: what actually came in and went out, month
     * by month, across the whole span the filtered budgets cover.
     *
     * Drawn from the SAME posted vouchers as every figure above it — a chart
     * that disagreed with the totals printed beside it would be worse than no
     * chart. Bucketed in IST, so a 1-April voucher lands in April rather than
     * in the previous financial year.
     *
     * One aggregation for the whole set, not one per budget: the heads are
     * unioned and the window is the union of the periods, so this costs a
     * single round trip however many budgets are in scope. */
    /* Handed the dashboard's OWN line selector rather than the department
     * string, so the chart's plan line and the figures printed beside it
     * cannot select different lines. */
    const monthly = await monthlySeries(evaluated, allLines, req, linesOf);

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
        /* An unset scope on a pre-existing row IS company — normalised here so
         * no consumer has to know that. */
        scope: b.scope || "company",
        department: b.department || null,
        costCentreName: b.costCentreName || null,
        startDate: b.startDate,
        endDate: b.endDate,
        totals: variance.rollUp(lines),
        lineCount: lines.length,
        /* How many departments actually have a section in this cycle. Counted
         * on the resolved slug, not the stored string, so one department
         * spelled two ways is one section — the same rule byDepartment groups
         * on. Derived per read; nothing is stored. */
        departmentCount: new Set(
          lines
            .map((l) => resolver.resolve(l.department)?.slug)
            .filter(Boolean),
        ).size,
        requestCount: (b.budgetRequests || []).length,
        pending: pendingCounts(b),
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
      monthly,
      byDepartment,
      byHead,
      attention,
      budgets: budgetList,
      /* Says out loud whether the figures above count each voucher once, and
       * how much the old roll-up was overstating by. `dedupeApplied: false`
       * with a reason means the totals are the un-deduplicated ones — better
       * to publish that plainly than to imply a correction that did not run. */
      overlap: overlapMeta,
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
    const resolver = await departments.departmentResolver({
      companyId: budget.companyId || actuals.oid(companyOf(req)),
    });
    res.json({ success: true, budget: await evaluate(budget, req, { asOf, resolver }) });
  } catch (error) {
    console.error("[budgets] detail error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * Normalise a purpose for duplicate comparison.
 *
 * Case, surrounding space and runs of whitespace are noise — "Peak  freight "
 * and "peak freight" are the same ask typed twice, usually because a submit
 * button was pressed twice or two people in a department raised it
 * independently. Punctuation is deliberately NOT stripped: "Q2 freight" and
 * "Q2, freight" being treated as one would start guessing, and a false
 * duplicate blocks legitimate work with a message that makes no sense.
 */
function normalisePurpose(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/* A request that is still live enough to make a second one a duplicate. Once
 * finance has said no — or the department withdrew it — asking again is a new
 * conversation, not a mistake. */
const OPEN_REQUEST_STATES = ["awaiting", "submitted", "countered", "agreed"];

/**
 * The request this one would duplicate, if any.
 *
 * Same budget + department + head + same purpose text. Deliberately NOT just
 * department + head: one department legitimately raises several asks against
 * one head for different reasons, and collapsing those would make the module
 * unusable for exactly the teams that plan carefully.
 */
function duplicateRequest(budget, { department, ledgerId, purpose, justification }, ignoreId) {
  const text = normalisePurpose(purpose) || normalisePurpose(justification);
  if (!text) return null;

  return (budget.budgetRequests || []).find((r) => {
    if (ignoreId && String(r._id) === String(ignoreId)) return false;
    if (!OPEN_REQUEST_STATES.includes(r.state)) return false;
    if (String(r.department || "").trim().toLowerCase() !== String(department || "").trim().toLowerCase()) return false;
    if (String(r.ledgerId || "") !== String(ledgerId || "")) return false;
    const theirs = normalisePurpose(r.purpose) || normalisePurpose(r.justification);
    return theirs === text;
  });
}

/**
 * Turn a lost optimistic-concurrency race into an honest answer.
 *
 * The budget schema runs with `optimisticConcurrency`, so a document read by
 * two requests and saved by both fails the second save rather than letting it
 * overwrite the first. That is the behaviour we want — approving two transfers
 * at once must not apply one and silently drop the other — but a VersionError
 * surfacing as a 500 would read like a server fault when it is really "someone
 * else got there first, look again".
 *
 * Returns true when it handled the error, so callers can `if (...) return;`
 * before their own catch turns it into a 500.
 */
function handledVersionConflict(error, res) {
  const isVersionError =
    error?.name === "VersionError" || /No matching document found for id/.test(error?.message || "");
  if (!isVersionError) return false;

  res.status(409).json({
    success: false,
    code: "BUDGET_CHANGED",
    message:
      "This budget changed while you were working on it — someone else saved first. Reload and try again.",
  });
  return true;
}

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
      /* A bound line's drilldown must explain the bound line's number — see
       * voucherMovementsForLedger. Null for every other line, which is the
       * behaviour every existing budget already has. */
      costCentreId: item.costCentreId || null,
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

/**
 * Validate and normalise the scope trio on a create or update body.
 *
 * Returns `{ error }` to refuse, or `{ patch }` of fields to apply.
 *
 * ── WHY THIS NORMALISES RATHER THAN ONLY VALIDATING ─────────────────────────
 * Switching a budget from department scope to company scope has to CLEAR the
 * department, not leave it behind. A stale owner on a company budget is the
 * kind of field that later reads as authoritative — the card would lead with a
 * department the budget no longer belongs to — so the transition is handled
 * here rather than trusted to the caller.
 *
 * ── WHY THE PROJECT CASE DOES NOT REQUIRE AN ID ─────────────────────────────
 * `Acc_CostCentre` exists but nothing is seeded: zero cost centres, zero
 * vouchers tagging one. Demanding a real reference would make project scope
 * unusable on day one. A name is enough to identify the budget now; the id can
 * arrive later without a second migration. Deliberately permissive, and the
 * reason is that the data is not there yet — not that the reference does not
 * matter.
 */
/**
 * Store each line's department the registry's way.
 *
 * Only the SPELLING changes, and only for departments the registry knows —
 * a line naming an unregistered department keeps exactly what was typed. So
 * this can never lose a value, only settle on one of its forms.
 */
function canonicaliseLineDepartments(items, resolver) {
  if (!Array.isArray(items) || !resolver) return items;
  return items.map((item) => {
    if (!item || item.department === undefined || item.department === null) return item;
    const name = resolver.canonicalName(item.department);
    return name === null ? item : { ...item, department: name };
  });
}

/**
 * Whether a budget's actuals can be trusted as a PROJECT figure, and if not,
 * exactly why.
 *
 * ── WHY THIS IS REPORTED RATHER THAN ASSUMED ────────────────────────────────
 * A project budget can be wrong in two quiet ways, and both look like a
 * healthy number on screen:
 *
 *   unbound lines   the line has no cost centre, so it claims every rupee
 *                   spent on that head company-wide. The actual reads far too
 *                   HIGH and looks like overspend on a project that may not
 *                   have started.
 *
 *   nothing tagged  the line is bound correctly, but no voucher carries the
 *                   tag, so the actual reads ZERO while real money moved on
 *                   the head. That reads like an underspend and is the one
 *                   the module's own brief warned about: a number that looks
 *                   like a control and is not one.
 *
 * Returned as data rather than rendered into a string here, so the drawer can
 * decide how loudly to say it.
 */
function attributionOf(budget, lines = []) {
  if ((budget.scope || "company") !== "project") return null;

  const bound = lines.filter((l) => l && l.costCentreId);
  const unbound = lines.filter((l) => l && l.ledgerId && !l.costCentreId);

  /* Only meaningful for lines that ARE bound — an unbound line has no
   * attribution to be missing. */
  const unattributed = bound.reduce((sum, l) => sum + (variance.money(l.unattributed) ?? 0), 0);
  const attributed = bound.reduce((sum, l) => sum + (variance.money(l.actual) ?? 0), 0);

  return {
    costCentreId: budget.costCentreId || null,
    costCentreName: budget.costCentreName || null,
    lineCount: lines.length,
    boundLineCount: bound.length,
    /* Lines claiming everything on their head. Each is an inflated figure. */
    unboundLines: unbound.map((l) => ({
      _id: l._id,
      ledgerId: l.ledgerId || null,
      ledgerName: l.ledgerName || null,
      allocated: l.allocated,
      actual: l.actual,
    })),
    /* Spend on the bound heads that nobody attributed to this project. Large
     * beside a small `attributed` means the tagging is not happening, and the
     * project's actual is understated by roughly this much. */
    unattributed,
    attributed,
    /* The honest headline: is this budget's actual a project figure yet? */
    trustworthy: unbound.length === 0 && (attributed > 0 || unattributed === 0),
  };
}

/**
 * Bind each line to a cost centre, and refuse ids that are not this company's.
 *
 * ── WHY A PROJECT BUDGET'S LINES INHERIT ────────────────────────────────────
 * A line with no cost centre matches spend on ledger + company + date, so it
 * claims every rupee on that head across every project. On a COMPANY budget
 * that is exactly right. On a project budget it is the defect this whole chunk
 * exists to close, and it would be invisible: the line would simply report a
 * number several times too large.
 *
 * So a project-scope budget's lines inherit the budget's own cost centre when
 * they name none. A line may still name a DIFFERENT one — a project budget
 * that tracks a sub-project is a real thing — but it cannot silently end up
 * unbound.
 *
 * Company and department budgets are untouched: their lines bind only if
 * someone explicitly asks, and nothing about them changes by default.
 */
async function bindLineCostCentres(items, { companyId, scope, defaultCostCentreId }) {
  if (!Array.isArray(items)) return { items };

  const inherit = scope === "project" ? actuals.oid(defaultCostCentreId) : null;

  const wanted = [
    ...new Set(
      items
        .map((i) => i && i.costCentreId)
        .filter(Boolean)
        .map(String),
    ),
  ];
  if (inherit) wanted.push(String(inherit));

  const cid = actuals.oid(companyId);
  const known = new Map();
  if (wanted.length && cid) {
    const rows = await Acc_CostCentre.find({
      _id: { $in: [...new Set(wanted)].map(actuals.oid).filter(Boolean) },
      companyId: cid,
    })
      .select("_id name")
      .lean();
    for (const r of rows) known.set(String(r._id), r.name);
  }

  const out = [];
  for (const item of items) {
    if (!item) {
      out.push(item);
      continue;
    }
    const raw = item.costCentreId ? actuals.oid(item.costCentreId) : null;

    if (item.costCentreId && !raw) {
      return { error: "A budget line's cost centre is not a valid id." };
    }
    /* Refused rather than dropped. A cost centre from another company would
     * bind the line to spend it can never see, and the line would read zero
     * forever with nothing on screen explaining why. */
    if (raw && !known.has(String(raw))) {
      return { error: "A budget line names a cost centre that does not belong to this company." };
    }

    const bound = raw || inherit || null;
    if (!bound) {
      out.push(item);
      continue;
    }
    out.push({
      ...item,
      costCentreId: bound,
      /* Snapshotted, so a renamed or deleted cost centre still reads on an old
       * budget — the same reason ledgerName sits beside ledgerId. */
      costCentreName: known.get(String(bound)) || item.costCentreName || null,
    });
  }

  return { items: out };
}

function scopePatch(body, existing, resolver = null) {
  if (body.scope === undefined && existing === undefined) return { patch: {} };

  const scope = body.scope !== undefined ? body.scope : existing?.scope || "company";

  const scopeError = invalidEnumField(Acc_Budget, "scope", scope);
  if (scopeError) return { error: scopeError };

  const dept = (body.department !== undefined ? body.department : existing?.department) || "";
  const ccName = (body.costCentreName !== undefined ? body.costCentreName : existing?.costCentreName) || "";
  const ccId = body.costCentreId !== undefined ? body.costCentreId : existing?.costCentreId;

  if (scope === "department" && !String(dept).trim()) {
    return { error: "A department-scope budget needs a department." };
  }
  if (scope === "project" && !String(ccName).trim() && !actuals.oid(ccId)) {
    return { error: "A project-scope budget needs a project or cost centre name." };
  }

  /* The department is stored the registry's way when the registry knows it,
   * so a budget owned by "logistics" and one owned by "Logistics" are one
   * department from the moment they are saved rather than only once something
   * downstream normalises them. An unregistered department is stored as
   * typed — inventing a canonical spelling for it would be worse. */
  const ownerName =
    scope === "department"
      ? (resolver ? resolver.canonicalName(dept) : departments.displayOf(dept))
      : undefined;

  /* Only the owner the scope actually uses survives. */
  return {
    patch: {
      scope,
      department: scope === "department" ? ownerName : undefined,
      costCentreName: scope === "project" ? String(ccName).trim() : undefined,
      costCentreId: scope === "project" ? actuals.oid(ccId) || undefined : undefined,
    },
  };
}

/* ── CREATE ──────────────────────────────────────────────────────────────── */
router.post("/", async (req, res) => {
  try {
    if (requireEdit(req, res)) return;
    const periodError = invalidEnumField(Acc_Budget, "period", req.body?.period);
    if (periodError) return res.status(400).json({ success: false, message: periodError });
    const statusError = invalidEnumField(Acc_Budget, "status", req.body?.status);
    if (statusError) return res.status(400).json({ success: false, message: statusError });

    const cidForDepartments = actuals.oid(companyOf(req)) || actuals.oid(req.body?.companyId);
    const resolver = await departments.departmentResolver({ companyId: cidForDepartments });

    const scoped = scopePatch(req.body || {}, undefined, resolver);
    if (scoped.error) return res.status(400).json({ success: false, message: scoped.error });

    const data = cacheTotals({ ...req.body, ...scoped.patch });
    data.items = canonicaliseLineDepartments(data.items, resolver);

    const bound = await bindLineCostCentres(data.items, {
      companyId: cidForDepartments,
      scope: scoped.patch.scope,
      defaultCostCentreId: scoped.patch.costCentreId,
    });
    if (bound.error) return res.status(400).json({ success: false, message: bound.error });
    data.items = bound.items;
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
    if (requireEdit(req, res)) return;
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

    /* Scope is validated against the STORED row, not the payload alone: a PUT
     * that changes only the department must be checked against the scope the
     * budget already has. `$unset` clears the owner the new scope does not
     * use — `undefined` in a findOneAndUpdate payload is dropped, not applied,
     * so switching department → company would otherwise leave the old
     * department behind and the card would keep leading with it. */
    const current = await Acc_Budget.findOne(scopeFilter(req, req.params.id)).lean();
    if (!current) return res.status(404).json({ success: false, message: "Budget not found" });

    const resolver = await departments.departmentResolver({
      companyId: current.companyId || actuals.oid(companyOf(req)),
    });

    const scoped = scopePatch(req.body || {}, current, resolver);
    if (scoped.error) return res.status(400).json({ success: false, message: scoped.error });

    if (data.items) data.items = canonicaliseLineDepartments(data.items, resolver);

    const unset = {};
    for (const key of ["department", "costCentreName", "costCentreId"]) {
      if (scoped.patch[key] === undefined) {
        delete data[key];
        if (current[key] !== undefined && current[key] !== null) unset[key] = "";
      } else {
        data[key] = scoped.patch[key];
      }
    }
    data.scope = scoped.patch.scope;

    if (data.items) {
      const bound = await bindLineCostCentres(data.items, {
        companyId: current.companyId || actuals.oid(companyOf(req)),
        scope: scoped.patch.scope,
        defaultCostCentreId: scoped.patch.costCentreId,
      });
      if (bound.error) return res.status(400).json({ success: false, message: bound.error });
      data.items = bound.items;
      cacheTotals(data);
    }

    const budget = await Acc_Budget.findOneAndUpdate(
      scopeFilter(req, req.params.id),
      Object.keys(unset).length ? { $set: data, $unset: unset } : data,
      { new: true, runValidators: true },
    );
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
    if (requireEdit(req, res)) return;
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
    if (requireFinance(req, res)) return;
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
    if (requireEdit(req, res)) return;
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

    /* ── DUPLICATE GUARD ────────────────────────────────────────────────
     * The same department asking for the same head for the same stated
     * reason, twice, while the first is still live. Almost always a double
     * submit or two people in one team raising it independently — and the
     * cost of letting it through is that finance agrees both and allocates
     * the money twice.
     *
     * Scoped to the PURPOSE, not just the head: one department legitimately
     * raises several asks against one head for different reasons, and
     * collapsing those would break the module for exactly the teams that
     * plan carefully. The existing request is named in the response so the
     * caller can go look at it rather than guess. */
    const clash = duplicateRequest(budget, {
      department: req.body.department,
      ledgerId: resolved.ledger.ledgerId,
      purpose: req.body.purpose,
      justification: req.body.justification,
    });
    if (clash) {
      return res.status(409).json({
        success: false,
        message: `${clash.department} has already requested this head for the same reason — that request is ${clash.state}.`,
        duplicateOf: {
          _id: clash._id,
          state: clash.state,
          requestedAmount: clash.requestedAmount,
          submittedBy: clash.submittedBy,
          submittedAt: clash.submittedAt,
        },
      });
    }

    const now = new Date();
    /* Built field by field rather than spreading req.body: a spread would let
     * a caller set agreedAmount or submittedBy on their own request, which is
     * finance's side of the exchange and the server's respectively. */
    /* The asking department is stored canonically too, or "logistics" and
     * "Logistics" would be two departments in the same collection round and
     * close-collection would default one of them. */
    const requestResolver = await departments.departmentResolver({
      companyId: budget.companyId || actuals.oid(companyOf(req)),
    });

    budget.budgetRequests.push({
      department:
        requestResolver.canonicalName(req.body.department) ||
        departments.displayOf(req.body.department),
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
    if (requireEdit(req, res)) return;
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
    if (requireEdit(req, res)) return;
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
    if (requireFinance(req, res, request.submittedBy)) return;

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
    if (handledVersionConflict(error, res)) return;
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
    if (requireFinance(req, res, request.submittedBy)) return;

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
    if (handledVersionConflict(error, res)) return;
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
    if (requireFinance(req, res)) return;

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
    if (handledVersionConflict(error, res)) return;
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
    if (requireEdit(req, res)) return;
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
    if (handledVersionConflict(error, res)) return;
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
    if (requireFinance(req, res, adjustment.requestedBy)) return;

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
    if (handledVersionConflict(error, res)) return;
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
    if (requireFinance(req, res, adjustment.requestedBy)) return;

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
    if (handledVersionConflict(error, res)) return;
    console.error("[budgets] reject adjustment error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── CANCEL ────────────────────────────────────────────────────────────────
 * The requester withdrawing their own ask. Distinct from `rejected`, which is
 * finance's answer — collapsing the two would lose who decided. */
router.post("/:id/adjustments/:adjustmentId/cancel", async (req, res) => {
  try {
    if (requireEdit(req, res)) return;
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
    if (handledVersionConflict(error, res)) return;
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
    if (requireEdit(req, res)) return;
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
    if (handledVersionConflict(error, res)) return;
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
    if (requireFinance(req, res, transfer.requestedBy)) return;

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
    if (handledVersionConflict(error, res)) return;
    console.error("[budgets] approve transfer error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── REJECT ────────────────────────────────────────────────────────────── */
router.post("/:id/transfers/:transferId/reject", async (req, res) => {
  try {
    const { budget, transfer, error } = await budgetAndTransfer(req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });
    if (requireFinance(req, res, transfer.requestedBy)) return;

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
    if (handledVersionConflict(error, res)) return;
    console.error("[budgets] reject transfer error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── CANCEL ────────────────────────────────────────────────────────────────
 * The requester withdrawing. Distinct from rejected, which is finance's
 * answer — collapsing them would lose who decided. */
router.post("/:id/transfers/:transferId/cancel", async (req, res) => {
  try {
    if (requireEdit(req, res)) return;
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
    if (handledVersionConflict(error, res)) return;
    console.error("[budgets] cancel transfer error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ── DELETE ──────────────────────────────────────────────────────────────── */
router.delete("/:id", async (req, res) => {
  try {
    if (requireEdit(req, res)) return;
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
