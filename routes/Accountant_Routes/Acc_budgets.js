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
