/**
 * GRAV-CMS-BACKEND/services/budgetProposals.service.js
 *
 * What a DEPARTMENT may see and do with budget requests.
 *
 * ── WHY THIS IS NOT JUST THE FINANCE ROUTES WITH A FILTER ───────────────────
 * The finance budget router answers "show me the budget", and its reads are
 * built for someone entitled to the whole company: every department's lines,
 * every voucher, the dashboard. Adding a department filter to those would
 * leave the entitlement question spread across a 2,800-line file, where the
 * next read added is one that forgot.
 *
 * So the department surface is a separate, deliberately small vocabulary:
 * open cycles, my requests, my approved total. Everything here takes the
 * caller's ALLOWED DEPARTMENT SLUGS as an argument and can express nothing
 * outside them — a projection built to be incapable of leaking rather than
 * one trusted not to.
 *
 * The rule throughout: an empty allowed-set means SEE NOTHING and WRITE
 * NOTHING. Never "see everything".
 */

const { Acc_Budget } = require("../models/Accountant_model/Acc_OperationalModels");
const departments = require("./budgetDepartment.service");
const actuals = require("./budgetActuals.service");
const variance = require("./budgetVariance.service");

/* The states a department may still submit into. Mirrors REQUESTABLE_STATES in
 * the finance router — a cycle that has moved to review or active has closed
 * collection, and a department writing into it would be changing a budget
 * finance considers settled. */
const OPEN_STATES = ["draft", "collecting"];

/** The safe shape of a cycle: enough to choose one, nothing about its money. */
function publicCycle(budget) {
  return {
    _id: budget._id,
    name: budget.name,
    financialYear: budget.financialYear,
    period: budget.period,
    quarter: budget.quarter ?? null,
    status: budget.status,
    startDate: budget.startDate,
    endDate: budget.endDate,
    /* Deliberately absent: totals, items, other departments' requests, the
     * company's allocation. A department choosing where to submit does not
     * need to know what the company has already committed. */
  };
}

/**
 * The safe shape of ONE request — the department's own words, plus finance's
 * answer to it. `counterAmount`, `financeNote` and `agreedAmount` are included
 * because they are a reply TO THIS DEPARTMENT; withholding them would mean a
 * counter nobody could respond to.
 */
function publicRequest(r, budget) {
  return {
    _id: r._id,
    budgetId: budget._id,
    budgetName: budget.name,
    budgetStatus: budget.status,
    financialYear: budget.financialYear,
    department: r.department,
    ledgerId: r.ledgerId,
    ledgerName: r.ledgerName,
    groupName: r.groupName,
    nature: r.nature,
    requestedAmount: r.requestedAmount,
    priority: r.priority,
    purpose: r.purpose,
    justification: r.justification,
    expectedMonth: r.expectedMonth ?? null,
    expectedFrom: r.expectedFrom ?? null,
    expectedTo: r.expectedTo ?? null,
    note: r.note,
    state: r.state,
    financeNote: r.financeNote,
    counterAmount: r.counterAmount ?? null,
    agreedAmount: r.agreedAmount ?? null,
    submittedAt: r.submittedAt,
    submittedBy: r.submittedBy,
    updatedAt: r.updatedAt,
    /* `updatedBy` is withheld: it names the finance user who last touched the
     * row, which is not this department's business. */
    editable: OPEN_STATES.includes(budget.status) && EDITABLE_STATES.includes(r.state),
  };
}

/* A department may revise its own ask while the answer is still open. Once
 * finance has AGREED it, the figure is an allocation line on the company
 * budget and editing the request would silently disagree with money that has
 * already been committed. */
const EDITABLE_STATES = ["submitted", "countered", "awaiting"];

/** Does this request belong to one of the caller's departments? */
function ownedBy(request, allowedSlugs) {
  const slug = departments.slugify(request?.department);
  return !!slug && allowedSlugs.includes(slug);
}

/**
 * Cycles a department may submit into.
 *
 * Scoped to the company and to OPEN_STATES only. A closed or active cycle is
 * not listed at all rather than listed-and-refused: offering a choice that
 * cannot be taken is how a form produces an error nobody understands.
 */
async function openCycles({ companyId, allowedSlugs = [] }) {
  const cid = actuals.oid(companyId);
  if (!cid || !allowedSlugs.length) return [];

  const rows = await Acc_Budget.find({
    companyId: cid,
    status: { $in: OPEN_STATES },
  })
    .select("_id name financialYear period quarter status startDate endDate")
    .sort({ startDate: -1 })
    .lean();

  return rows.map(publicCycle);
}

/**
 * Every request the caller's departments have made, newest cycle first.
 *
 * Reads whole budgets because requests are subdocuments, then projects hard:
 * only rows whose department is in the allowed set survive, and each is passed
 * through publicRequest rather than spread.
 */
async function myRequests({ companyId, allowedSlugs = [], financialYear }) {
  const cid = actuals.oid(companyId);
  if (!cid || !allowedSlugs.length) return { requests: [], summary: emptySummary() };

  const filter = { companyId: cid };
  if (financialYear) filter.financialYear = financialYear;

  const budgets = await Acc_Budget.find(filter)
    .select("_id name financialYear period status startDate endDate budgetRequests")
    .sort({ startDate: -1 })
    .lean();

  const requests = [];
  for (const b of budgets) {
    for (const r of b.budgetRequests || []) {
      if (!ownedBy(r, allowedSlugs)) continue;
      requests.push(publicRequest(r, b));
    }
  }
  return { requests, summary: summarise(requests) };
}

function emptySummary() {
  return { requested: 0, agreed: 0, countered: 0, pending: 0, counts: { total: 0, pending: 0, agreed: 0, countered: 0 } };
}

/**
 * The department's own position, from its own rows.
 *
 * `requested` counts only asks still open — an agreed one is money, and adding
 * it to "what we asked for" would double it against `agreed`.
 */
function summarise(requests) {
  const out = emptySummary();
  for (const r of requests) {
    out.counts.total += 1;
    if (r.state === "agreed") {
      out.agreed += variance.money(r.agreedAmount ?? r.requestedAmount) ?? 0;
      out.counts.agreed += 1;
    } else if (r.state !== "defaulted") {
      out.requested += variance.money(r.requestedAmount) ?? 0;
      if (r.state === "countered") {
        out.countered += variance.money(r.counterAmount) ?? 0;
        out.counts.countered += 1;
      }
      if (r.state === "submitted" || r.state === "countered" || r.state === "awaiting") {
        out.pending += variance.money(r.requestedAmount) ?? 0;
        out.counts.pending += 1;
      }
    }
  }
  return out;
}

/**
 * May this caller write this department?
 *
 * Returns a REASON rather than a boolean so the route can say which rule was
 * hit — "not your department" and "that cycle is closed" send someone to very
 * different places.
 */
function canSubmitFor({ department, allowedSlugs = [], budget }) {
  const slug = departments.slugify(department);
  if (!slug) return { ok: false, status: 400, message: "A department is required." };
  if (!allowedSlugs.includes(slug)) {
    /* Deliberately does not name the departments the caller MAY use — that
     * would turn a refusal into a directory of the company's departments. */
    return { ok: false, status: 403, message: "You cannot submit budget for that department." };
  }
  if (!budget) return { ok: false, status: 404, message: "Budget cycle not found." };
  if (!OPEN_STATES.includes(budget.status)) {
    return {
      ok: false,
      status: 409,
      message: `This cycle is ${budget.status}; it is no longer collecting requests.`,
    };
  }
  return { ok: true };
}

module.exports = {
  OPEN_STATES,
  EDITABLE_STATES,
  publicCycle,
  publicRequest,
  ownedBy,
  openCycles,
  myRequests,
  summarise,
  canSubmitFor,
};
