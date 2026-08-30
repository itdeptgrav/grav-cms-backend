/**
 * GRAV-CMS-BACKEND/services/budgetControl.service.js
 *
 * Is there budget for this spend, and what happens to the budget if we post it?
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
 * Chunks 1–5 made the budget observable: allocations are real, actuals come
 * from posted vouchers, and every figure can be drilled to the vouchers behind
 * it. All of that is retrospective. This is the first piece that looks at
 * money BEFORE it moves — the check that runs when Accounts is about to post
 * spend and asks whether the head it is charging has room.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 * It does not block. It reports. The decision to refuse a post and demand an
 * override reason belongs to the route, because only the route knows whether
 * this call is a draft being saved or money actually being committed, and a
 * service that threw would take that judgement away from it.
 *
 * ── EXPENSE ONLY ────────────────────────────────────────────────────────────
 * A revenue budget is a TARGET, not a cap. Beating it is the point. Revenue
 * lines are evaluated and returned for context but can never produce a status
 * that demands an override — treating a sales head like a spend limit would
 * block the company for succeeding.
 */

const { Acc_Budget } = require("../models/Accountant_model/Acc_OperationalModels");
const actuals = require("./budgetActuals.service");
const departments = require("./budgetDepartment.service");
const variance = require("./budgetVariance.service");
const escalation = require("./budgetEscalation.service");

/**
 * Which budgets are live enough to control spend.
 *
 * `exceeded` is deliberately included alongside `active`. A budget that has
 * already been blown is exactly the one that most needs the next voucher
 * checked against it; dropping it here would mean the control silently
 * switches OFF the moment it starts to matter.
 *
 * draft/collecting/review are not yet in force, and closed is over.
 */
const CONTROLLING_STATUSES = ["active", "exceeded"];

/* Mirrors `warnAtPct` in budgetVariance.service.js — the point at which a
 * head has consumed enough of its number to be worth saying so. */
const WARN_AT_PCT = 90;

const STATUS_RANK = {
  ok: 0,
  unscoped: 1,
  missing_budget: 2,
  warning_near_limit: 3,
  /* The head IS budgeted, but only under a project, and this voucher says
   * nothing about which project. Ranked above missing_budget because it is a
   * more specific and more fixable complaint: there is money, and the user is
   * one field away from reaching it. */
  needs_cost_centre: 4,
  over_budget: 5,
};

/** The louder of two statuses. Same rule as severity: worst wins, never an
 *  average — an averaged warning is one that fails to fire. */
function worstStatus(a, b) {
  return (STATUS_RANK[b] ?? 0) > (STATUS_RANK[a] ?? 0) ? b : a;
}

/** Statuses that a human has to answer for before money moves. */
function needsOverride(status) {
  return (
    status === "over_budget" ||
    status === "missing_budget" ||
    /* Overridable rather than a hard refusal, deliberately. Someone genuinely
     * may need to book spend against a project-budgeted head before the cost
     * centre exists, and a control nobody can get past in an emergency is one
     * that gets switched off. The override is recorded like any other. */
    status === "needs_cost_centre"
  );
}

/**
 * Are this voucher's cost-centre allocations arithmetically possible?
 *
 * Returns a list of human-readable problems; empty means fine.
 *
 * ── WHY THIS IS A HARD REFUSAL AND NOT A WARNING ────────────────────────────
 * An allocation says "this much of this entry belongs to that project".
 * Allocating more than the entry holds does not mean anything, and if it were
 * stored the project's actual would exceed what was actually spent on the head
 * — a budget reporting more spend than the ledger, which is the one direction
 * an accounting figure must never be wrong in.
 *
 * Under-allocating IS allowed: an entry can be partly attributed and partly
 * not, and the remainder is simply untagged spend.
 */
function validateCostCentreAllocations(ledgerEntries = []) {
  const problems = [];

  ledgerEntries.forEach((e, i) => {
    if (!e) return;
    const allocations = Array.isArray(e.costCentreAllocations) ? e.costCentreAllocations : [];
    if (!allocations.length) return;

    const label = e.ledgerName || `line ${i + 1}`;
    const amount = variance.money(e.amount) ?? 0;
    let total = 0;
    const seen = new Set();

    for (const a of allocations) {
      if (!a) continue;
      if (!a.costCentreId) {
        problems.push(`${label}: a cost-centre allocation has no cost centre.`);
        continue;
      }
      const amt = variance.money(a.amount);
      if (amt === null || amt < 0) {
        problems.push(`${label}: a cost-centre allocation has an invalid amount.`);
        continue;
      }
      /* Two rows for one project on one entry is almost always a UI double
       * submit, and it would silently double that project's actual. */
      const key = String(a.costCentreId);
      if (seen.has(key)) {
        problems.push(
          `${label}: ${a.costCentreName || "a cost centre"} is allocated twice on one line.`,
        );
      }
      seen.add(key);
      total += amt;
    }

    /* A rounding tolerance, matching the one Acc_Voucher.balanceOf uses for
     * Dr/Cr — the same class of problem and the same reason. */
    if (total - amount > 0.01) {
      problems.push(
        `${label}: cost-centre allocations total ₹${Math.round(total).toLocaleString("en-IN")}, ` +
          `more than the line's ₹${Math.round(amount).toLocaleString("en-IN")}.`,
      );
    }
  });

  return problems;
}

/**
 * Collapse a voucher's entries to one proposed movement per ledger head PER
 * COST-CENTRE SCOPE.
 *
 * A voucher can charge the same head twice (a split allocation), and checking
 * each entry separately would compare two half-amounts against the same
 * remaining balance and clear both — the classic way an over-budget voucher
 * passes a per-line check. So amounts are summed per head first.
 *
 * ── WHY THE COST CENTRE SPLITS THE PROPOSAL ─────────────────────────────────
 * A project budget's allocation authorises spend ON THAT PROJECT. Checking a
 * whole entry against it would let a project budget authorise money booked to
 * a different project — the mirror image of the actuals defect that made
 * project budgets a label rather than a control.
 *
 * So a 1,00,000 entry tagged 60,000 to a project yields TWO proposals: 60,000
 * scoped to that cost centre, and 40,000 scoped to none. Each is checked
 * against the lines that actually apply to it.
 *
 * A voucher that tags nothing — which is every voucher in the books today —
 * yields exactly one untagged proposal per head, identical to what this
 * function has always returned.
 */
function proposedByLedger(ledgerEntries = []) {
  const out = new Map();

  const bucket = (ledgerId, costCentreId, costCentreName) => {
    const key = `${ledgerId}::${costCentreId || ""}`;
    if (!out.has(key)) {
      out.set(key, {
        ledgerId,
        costCentreId: costCentreId || null,
        costCentreName: costCentreName || null,
        debit: 0,
        credit: 0,
        department: null,
      });
    }
    return out.get(key);
  };

  for (const e of ledgerEntries) {
    if (!e || !e.ledgerId) continue;
    const amount = variance.money(e.amount) ?? 0;
    const side = e.type === "Cr" ? "credit" : "debit";

    const allocations = Array.isArray(e.costCentreAllocations) ? e.costCentreAllocations : [];
    let tagged = 0;
    for (const a of allocations) {
      if (!a || !a.costCentreId) continue;
      const amt = variance.money(a.amount) ?? 0;
      if (!(amt > 0)) continue;
      tagged += amt;
      bucket(String(e.ledgerId), String(a.costCentreId), a.costCentreName || null)[side] += amt;
    }

    /* Whatever is left over is untagged, and is checked against the budgets
     * that do not care which project it was for. Clamped at zero so an
     * over-allocated entry cannot manufacture negative untagged spend — the
     * over-allocation itself is refused by the caller's validation. */
    const untagged = Math.max(0, amount - tagged);
    if (untagged > 0 || !allocations.length) {
      const b = bucket(String(e.ledgerId), null, null);
      b[side] += untagged;
      /* An entry may name its own department. The first one wins; a head
       * charged to two departments on one voucher is checked against the head
       * as a whole, which is the safer reading.
       *
       * NOTE: `ledgerEntrySchema` has no `department` field and is strict, so
       * this is only ever set by a caller passing an unsaved entry object.
       * Left as-is rather than "fixed" — adding the field would change how
       * every existing company and department budget is matched, which is out
       * of scope here. */
      if (!b.department && e.department) b.department = e.department;
    }
  }

  return [...out.values()];
}

/**
 * Budget availability for a proposed voucher.
 *
 * @param {object}  args
 * @param {*}       args.companyId      books this voucher belongs to
 * @param {Date|string} args.voucherDate the date the spend lands on
 * @param {Array}   args.ledgerEntries  [{ ledgerId, type: "Dr"|"Cr", amount, department? }]
 * @param {string}  [args.department]   voucher-level department, if the form has one
 * @param {*}       [args.excludeVoucherId] a voucher already posted whose own
 *        movement must not be double-counted when re-checking it (edit flow)
 *
 * @returns {{ overallStatus, requiredOverride, results, message, checkedAt }}
 */
async function checkBudgetAvailability({
  companyId,
  voucherDate,
  ledgerEntries = [],
  department = null,
  excludeVoucherId = null,
  /* The commitment this voucher will discharge, when there is one. Excluded
     from the pressure figure below — see attachCommitmentContext. Passed in
     rather than resolved here so this stays one query's worth of work for
     callers that have already looked it up. */
  releasingCommitment = null,
} = {}) {
  const checkedAt = new Date();
  const proposed = proposedByLedger(ledgerEntries);

  /* No company context means the actuals cannot be scoped, and an unscoped
   * check would compare this company's spend against every company's postings.
   * Say so rather than returning a confident wrong answer. */
  if (!actuals.oid(companyId)) {
    return {
      overallStatus: "unscoped",
      requiredOverride: false,
      results: [],
      message: "No company selected, so budget availability could not be checked.",
      checkedAt,
    };
  }

  if (!proposed.length) {
    return {
      overallStatus: "ok",
      requiredOverride: false,
      results: [],
      message: "Nothing to check.",
      checkedAt,
    };
  }

  const when = voucherDate ? new Date(voucherDate) : new Date();
  if (Number.isNaN(when.getTime())) {
    throw new Error("voucherDate must be a valid date");
  }

  /* The nature of each head, from the ledger tree rather than any snapshot —
   * the same authority budgetActuals uses. */
  const natures = await actuals.natureByLedger(proposed.map((p) => p.ledgerId));

  const cid = actuals.oid(companyId);
  /* Departments are compared on identity, not spelling — see the match loop
   * below. Loaded once for the whole check rather than per line. */
  const resolver = await departments.departmentResolver({ companyId: cid });
  const budgets = await Acc_Budget.find({
    status: { $in: CONTROLLING_STATUSES },
    startDate: { $lte: when },
    endDate: { $gte: when },
    /* Same legacy clause as every other budget read: a row written before
     * companyId existed still belongs to whoever is looking at it. */
    $or: [{ companyId: cid }, { companyId: { $exists: false } }, { companyId: null }],
  })
    .select("_id name status period financialYear startDate endDate companyId items")
    .lean();

  const results = [];

  for (const p of proposed) {
    const meta = natures.get(String(p.ledgerId)) || {};
    /* NO DEFAULT TO "expense". A ledger whose nature cannot be resolved is
     * not silently treated as spend — see the asset/liability skip below for
     * why that default was actively dangerous. */
    const nature = meta.nature || null;
    const signed = p.debit - p.credit;
    const thisVoucher = actuals.actualFrom({ signed }, nature);
    const lineDepartment = p.department || department || null;

    const base = {
      ledgerId: p.ledgerId,
      ledgerName: meta.ledgerName || null,
      groupName: meta.groupName || null,
      nature,
      department: lineDepartment,
      /* Which slice of this head's spend the row is about. Null on every
       * voucher that tags nothing, which is how this endpoint has always
       * behaved. */
      costCentreId: p.costCentreId || null,
      costCentreName: p.costCentreName || null,
      debit: p.debit,
      credit: p.credit,
      thisVoucher,
    };

    /* ── ONLY EXPENSE HEADS ARE BUDGET-CONTROLLED ───────────────────────
     * Nearly every voucher has a funding leg — the bank it was paid from,
     * the vendor it is owed to, the cash it came out of. Those are assets
     * and liabilities, not spend, and no budget is ever written against
     * them. An earlier draft of this defaulted an unresolved nature to
     * "expense", which meant the bank leg of a perfectly ordinary payment
     * came back "HDFC Current has no approved allocation" and the voucher
     * was refused. That is not a strict control; it is a control that
     * blocks everything, which people would (rightly) have switched off.
     *
     * A head whose nature cannot be resolved at all lands here too, and
     * that is the correct side to fail on: refusing spend because a ledger
     * is mis-parented punishes the wrong person. The budget screens will
     * still show the overspend afterwards. */
    if (nature !== "expense" && nature !== "revenue") {
      results.push({
        ...base,
        status: "ok",
        note: nature
          ? `${nature} head — not budget-controlled.`
          : "Head has no resolved nature — not budget-controlled.",
        allocated: null,
        actual: null,
        projectedActual: null,
        remainingAfter: null,
        budgets: [],
      });
      continue;
    }

    /* A revenue head is a target. Reported for context, never a cap — see the
     * file header. It is also why this returns before any allocation lookup:
     * "no revenue budget for this head" is not a finding. */
    if (nature === "revenue") {
      results.push({
        ...base,
        status: "ok",
        note: "Revenue head — budgets are targets, not spend limits.",
        allocated: null,
        actual: null,
        projectedActual: null,
        remainingAfter: null,
        budgets: [],
      });
      continue;
    }

    /* Every allocation for this head across the live budgets covering the
     * date. Matched on department when the voucher named one; when it did
     * not, the head's TOTAL approved allocation is the cap, because that is
     * genuinely what has been approved for the head. Both sets of lines are
     * named in `budgets` so the caller can show which.
     *
     * The department comparison is on IDENTITY, not on the stored string. A
     * voucher tagged "logistics" against a line reading "Logistics" used to
     * miss, and a miss here is not a small thing: with no matching line the
     * spend reads as UNBUDGETED, and the posting is refused or forced through
     * an override for a budget that exists and has room. */
    const wanted = lineDepartment ? resolver.resolve(lineDepartment) : null;
    const matches = [];
    /* Lines on this head that ARE project-bound but to some other project (or
     * to any project, when this spend is untagged). Not matches — but the
     * reason a head can look unbudgeted while money is sitting right there,
     * so they are collected to say so. */
    const costCentreOnly = [];

    for (const b of budgets) {
      for (const item of b.items || []) {
        if (!item.ledgerId || String(item.ledgerId) !== String(p.ledgerId)) continue;
        if (wanted && item.department) {
          const itemDept = resolver.resolve(item.department);
          if (itemDept && itemDept.slug !== wanted.slug) continue;
        }

        /* ── COST-CENTRE MATCHING ──────────────────────────────────────────
         * A line bound to a project authorises spend ON THAT PROJECT and
         * nothing else. Letting it clear untagged spend would make a project
         * budget authorise every rupee on the head — the same defect on the
         * control side that cost-centre-aware actuals just closed on the
         * reporting side.
         *
         * A line with no cost centre keeps authorising the head as a whole,
         * which is what every company and department budget does today. */
        if (item.costCentreId) {
          if (!p.costCentreId || String(item.costCentreId) !== String(p.costCentreId)) {
            costCentreOnly.push({ budget: b, item });
            continue;
          }
        }
        matches.push({ budget: b, item });
      }
    }

    if (!matches.length && costCentreOnly.length && !p.costCentreId) {
      /* There IS approved budget for this head — it just belongs to a project,
       * and this voucher has not said which project the spend is for. Saying
       * "no approved allocation" here would be false and would send the user
       * looking for a budget that already exists. */
      const projects = [
        ...new Set(costCentreOnly.map((m) => m.item.costCentreName).filter(Boolean)),
      ];
      results.push({
        ...base,
        status: "needs_cost_centre",
        allocated: null,
        actual: null,
        projectedActual: null,
        remainingAfter: null,
        /* Named so the form can offer them directly rather than making the
         * user go and look the project up. */
        costCentreOptions: costCentreOnly.map((m) => ({
          budgetId: m.budget._id,
          budgetName: m.budget.name,
          costCentreId: m.item.costCentreId,
          costCentreName: m.item.costCentreName || null,
          allocated: variance.money(m.item.allocatedAmount) ?? 0,
        })),
        note: projects.length
          ? `Budgeted under ${projects.join(", ")} — tag this spend to a project.`
          : "Budgeted under a project — tag this spend to a project.",
        budgets: [],
      });
      continue;
    }

    if (!matches.length) {
      results.push({
        ...base,
        status: "missing_budget",
        allocated: 0,
        actual: null,
        projectedActual: null,
        remainingAfter: null,
        budgets: [],
        note: lineDepartment
          ? `No approved allocation for this head in ${lineDepartment} on a live budget covering ${when.toISOString().slice(0, 10)}.`
          : `No approved allocation for this head on a live budget covering ${when.toISOString().slice(0, 10)}.`,
      });
      continue;
    }

    /* Actuals over the WIDEST window the matched allocations span. Using each
     * budget's own window and summing would double-count spend that falls in
     * two overlapping budgets. */
    const from = matches.reduce(
      (min, m) => (!min || m.budget.startDate < min ? m.budget.startDate : min),
      null,
    );
    const to = matches.reduce(
      (max, m) => (!max || m.budget.endDate > max ? m.budget.endDate : max),
      null,
    );

    /* Posted vouchers only — movementByLedger's own filter. Drafts and
     * pending-approval vouchers are not money yet, and Tally's optional
     * entries never were. Same source as every other actual in the module,
     * which is the only way this check can agree with the budget screen. */
    const movements = await actuals.movementByLedger({
      companyId: m_companyFor(matches, companyId),
      ledgerIds: [p.ledgerId],
      from,
      to,
      /* Re-checking a voucher that is ALREADY posted (an edit) would otherwise
       * find its own movement in the actual and then add the proposal on top,
       * reporting double what the voucher really does. */
      excludeVoucherId,
    });
    const actual = actuals.actualFrom(movements.get(String(p.ledgerId)), nature);

    const allocated = matches.reduce(
      (s, m) => s + (variance.money(m.item.allocatedAmount) ?? 0),
      0,
    );
    const projectedActual = actual + thisVoucher;
    const remainingAfter = allocated - projectedActual;
    const projectedPct = allocated > 0 ? (projectedActual / allocated) * 100 : null;

    let status = "ok";
    if (allocated <= 0) status = "missing_budget";
    else if (remainingAfter < 0) status = "over_budget";
    else if (projectedPct !== null && projectedPct >= WARN_AT_PCT) status = "warning_near_limit";

    results.push({
      ...base,
      status,
      allocated,
      actual,
      projectedActual,
      remainingAfter,
      projectedPct,
      overBy: remainingAfter < 0 ? -remainingAfter : 0,
      budgets: matches.map((m) => ({
        _id: m.budget._id,
        name: m.budget.name,
        status: m.budget.status,
        /* Which year's envelope this is. Denormalised onto the match because
           every consumer that records a match wants to say WHICH cycle it
           was, and re-reading the budget to find out would be a second query
           for a string already in hand. `budgetCommitment.matchFor` reads it
           — it always did, and until now it was always undefined, so every
           spend request raised through classification recorded a budget line
           with no year against it. */
        financialYear: m.budget.financialYear || null,
        itemId: m.item._id,
        department: m.item.department || null,
        allocatedAmount: m.item.allocatedAmount || 0,
      })),
    });
  }

  /* Advisory only, and attached AFTER every status is settled — so the two
     lines below cannot be influenced by it however this evolves. */
  await attachCommitmentContext({ results, releasingCommitment }).catch((e) => {
    /* A commitment read that fails must not cost finance the availability
       check. The screen shows the gate's answer without the extra context. */
    console.error("[budget] commitment context failed, omitting it:", e.message);
  });

  const overallStatus = results.reduce((acc, r) => worstStatus(acc, r.status), "ok");
  const requiredOverride = results.some((r) => needsOverride(r.status));

  return {
    overallStatus,
    requiredOverride,
    results,
    message: messageFor(overallStatus, results),
    /* The heads carrying promises, so a screen can say something without
       walking the results. Empty when nothing is committed anywhere. */
    commitmentWarnings: results
      .filter((r) => r.commitment)
      .map((r) => ({
        ledgerId: r.ledgerId ? String(r.ledgerId) : null,
        ledgerName: r.ledgerName || null,
        ...r.commitment,
      })),
    checkedAt,
  };
}

/**
 * A legacy budget carries no companyId, so its actuals fall back to the
 * caller's books — the same rule actualsCompanyFor applies on every other
 * budget read. When the matched allocations disagree, the caller's company
 * wins: it is the one whose books this voucher is being posted to.
 */
function m_companyFor(matches, companyId) {
  const owned = matches.find((m) => m.budget.companyId);
  return owned ? owned.budget.companyId : companyId;
}

function messageFor(status, results) {
  const worst = results.filter((r) => r.status === status);
  switch (status) {
    case "over_budget": {
      const r = worst[0];
      return `${r.ledgerName || "This head"} would go over budget by ₹${Math.round(r.overBy).toLocaleString("en-IN")}.`;
    }
    case "missing_budget": {
      const r = worst[0];
      return `${r.ledgerName || "This head"} has no approved allocation on a live budget for this date.`;
    }
    case "needs_cost_centre": {
      const r = worst[0];
      return r.note || `${r.ledgerName || "This head"} is budgeted under a project — tag this spend to a project.`;
    }
    case "warning_near_limit": {
      const r = worst[0];
      return `${r.ledgerName || "This head"} would reach ${Math.round(r.projectedPct)}% of its allocation.`;
    }
    case "unscoped":
      return "No company selected, so budget availability could not be checked.";
    default:
      return "Within budget.";
  }
}

/**
 * The one gate every posting path goes through.
 *
 * Returns `{ blocked: true, payload }` when the caller must stop and make
 * somebody answer for the spend, or `{ blocked: false, override }` with the
 * metadata to stamp on the voucher.
 *
 * NEVER throws for a budget reason. A control that can crash the posting path
 * is worse than no control at all — it would stop the books over a bug in a
 * warning. An unexpected failure logs and lets the voucher through; the
 * budget screens will still show the overspend afterwards.
 */
/**
 * ── A REASON IS NO LONGER ENOUGH ────────────────────────────────────────────
 * This used to let anything through the moment somebody typed a sentence. But
 * posting vouchers is the accounts job and every role that does it may post
 * directly, so the person spending past the budget was always the person
 * allowed to wave it through. It read like an approval and was a log.
 *
 * Now an overspend needs two signatures, one of them the CEO's — see
 * budgetEscalation.service. `clearanceFor` blocks until it has both, and
 * because every gate in the app already refuses on `blocked`, all five of them
 * inherit the rule without knowing it exists.
 *
 * `signatures` are the ones already collected on this voucher. A reason from
 * somebody who may sign counts as THEIR signature, so finance writing "here is
 * why" is finance approving it and not a separate click.
 */
async function clearanceFor({
  voucher,
  overrideReason,
  department = null,
  user = null,
  signatures = null,
  /* True when this call IS somebody approving, rather than a check on the way
     past. Approving is signing, so it collects a signature whether or not a
     sentence came with it — the second signer is allowed to add nothing, and
     it is the escalation service that decides the FIRST one must speak. */
  signing = false,
} = {}) {
  const reason = String(overrideReason || "").trim();
  const held = signatures || voucher?.budgetOverride?.signatures || [];
  try {
    /* Whatever this voucher will release, so the warning does not count money
       the posting itself removes. The same resolver that does the releasing —
       one rule, so the two cannot disagree. */
    let releasingCommitment = null;
    try {
      releasingCommitment = await require("./budgetCommitment.service").commitmentForVoucher(voucher);
    } catch (e) {
      console.error("[budget] could not resolve the voucher's commitment:", e.message);
    }

    const check = await checkBudgetAvailability({
      releasingCommitment,
      companyId: voucher.companyId,
      voucherDate: voucher.voucherDate,
      ledgerEntries: (voucher.ledgerEntries || []).map((e) => ({
        ledgerId: e.ledgerId,
        type: e.type,
        amount: e.amount,
        department: e.department || null,
      })),
      department: department || voucher.department || null,
      /* A voucher that is ALREADY posted must not find its own movement in
       * the actual and count it twice. Harmless on the create/post/approve
       * paths, where it is not posted yet. */
      excludeVoucherId: voucher.status === "posted" ? voucher._id : null,
    });

    if (check.requiredOverride) {
      /* A reason from somebody who may sign is their signature. From anybody
         else it is the case they are making, and it travels on the voucher
         for the two who do have to sign. */
      let collected = held;
      let signatureError = null;
      if ((signing || reason) && escalation.maySign(user)) {
        const added = escalation.addSignature(held, { user, reason });
        if (added.signatures) collected = added.signatures;
        /* Kept rather than swallowed: somebody clicking approve a second time
           has to be told they are the same person, not handed the same
           "waiting for the CEO" they saw a moment ago. */
        else signatureError = added;
      }

      if (!escalation.isComplete(collected)) {
        return {
          blocked: true,
          check,
          signatures: collected,
          signatureError,
          payload: {
            error: signatureError?.error || check.message,
            /* The old code is kept alongside the new one. Clients written
               before this still recognise the refusal; the new one tells them
               it is now a queue rather than a prompt for a sentence. */
            code: "BUDGET_OVERRIDE_REQUIRED",
            escalation: {
              required: true,
              code: signatureError?.code || "BUDGET_ESCALATION_REQUIRED",
              waitingOn: escalation.waitingOn(collected),
              message: escalation.describe(collected),
              signatures: collected,
            },
            budgetCheck: check,
          },
        };
      }
      /* Both signatures are in — fall through and let it post. */
      return { blocked: false, check, signatures: collected, override: overrideRecord(check, collected) };
    }

    /* Within budget: nothing to record. */
    return { blocked: false, check, override: null };
  } catch (e) {
    console.error("[budgetControl] check failed, allowing post:", e.message);
    return { blocked: false, check: null, override: null };
  }
}

/**
 * What a posted-over-budget voucher permanently carries.
 *
 * The named fields stay as they were — everything written before signatures
 * existed still reads the same way — and are filled from the completed set:
 * the CEO is the one recorded as having overridden it, and the case made by
 * whoever signed first is the reason. The full set travels alongside, so the
 * record shows both names rather than only the last.
 */
function overrideRecord(check, signatures = []) {
  const ceo = signatures.find((s) => s.slot === escalation.CEO);
  const stated = signatures.find((s) => s.reason);
  return {
    required: true,
    reason: stated?.reason || "",
    status: check.overallStatus,
    checkedAt: check.checkedAt,
    overriddenBy: ceo?.userId || signatures[signatures.length - 1]?.userId,
    overriddenByName: ceo?.name || signatures[signatures.length - 1]?.name || "",
    signatures,
    results: (check.results || [])
      .filter((r) => r.status !== "ok")
      .map((r) => ({
        ledgerId: r.ledgerId,
        ledgerName: r.ledgerName,
        department: r.department,
        status: r.status,
        allocated: r.allocated,
        actual: r.actual,
        thisVoucher: r.thisVoucher,
        projectedActual: r.projectedActual,
        remainingAfter: r.remainingAfter,
      })),
  };
}

/**
 * Thrown by `assertClearance` when spend needs an override and none was given.
 *
 * Carries the SAME payload the HTTP gates return, because the callers that
 * need this are executors with no `res` to write to — the approvals engine
 * applies an approved edit deep inside a transaction. Without a typed error
 * its caller would flatten the whole budget check into
 * "Execution failed: <string>" and the approver would be told they are over
 * budget with no idea by how much or on which head.
 */
class BudgetOverrideRequiredError extends Error {
  constructor(payload) {
    super(payload.error);
    this.name = "BudgetOverrideRequiredError";
    this.code = "BUDGET_OVERRIDE_REQUIRED";
    this.payload = payload;
  }
}

/**
 * The shape to run a check against for a voucher that is being EDITED.
 *
 * An edit is checked on what it will BECOME, not what it is: the incoming
 * body's entries and date where it supplies them, the stored ones where it
 * does not. `status` is forced to the stored status so `clearanceFor` decides
 * the self-exclusion correctly — a posted voucher's own movement is already
 * in the actuals, and counting it again would report an edit as roughly
 * double its real impact.
 */
function proposedVoucher(existing, body = {}) {
  return {
    _id: existing._id,
    companyId: existing.companyId,
    status: existing.status,
    voucherDate: body.voucherDate || existing.voucherDate,
    ledgerEntries: Array.isArray(body.ledgerEntries)
      ? body.ledgerEntries
      : existing.ledgerEntries,
    department: body.department || existing.department || null,
  };
}

/**
 * Can this edit change what the budget sees?
 *
 * Only two things move a budget: WHICH heads are charged and for how much, and
 * WHEN — the date decides which budget period applies. An edit that touches
 * neither cannot change the answer, so re-checking a narration change would
 * be two aggregations to confirm nothing happened.
 *
 * Deliberately conservative: an absent `ledgerEntries` means "not editing the
 * entries", and anything else present is assumed to matter only if it is one
 * of these two.
 */
function affectsBudget(body = {}) {
  return Array.isArray(body.ledgerEntries) || body.voucherDate !== undefined;
}

/**
 * `clearanceFor`, for callers that cannot return an HTTP response.
 *
 * Throws BudgetOverrideRequiredError instead of returning `{ blocked: true }`.
 * Returns the override metadata to stamp, or null.
 */
async function assertClearance(args) {
  const clearance = await clearanceFor(args);
  if (clearance.blocked) throw new BudgetOverrideRequiredError(clearance.payload);
  return clearance.override;
}

/* ── COMMITMENTS INFORM; THEY DO NOT BLOCK ───────────────────────────────────
 * The gate above stops a voucher on ACTUAL posted spend and nothing else. That
 * policy is unchanged here and deliberately so: a commitment is a promise
 * finance made, not an obligation the company has incurred, and blocking a real
 * invoice because of a stale promise is worse than the reverse.
 *
 * But finance posting a bill against a head that already carries ₹40,000 of
 * approved requests is deciding with half the picture. Every other screen in
 * this module — the head picker, the submissions desk, the cash-flow forecast —
 * subtracts commitments, and the posting screen was the only one that did not
 * even mention them.
 *
 * So: say it, and let them post. Nothing below can change a status, set
 * `requiredOverride`, or produce an error.
 */
const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;

/**
 * What the commitments on one head amount to, and how loudly to say it.
 *
 * Pure, so the wording and the thresholds are testable without a database.
 * `severity` is advisory throughout — the caller attaches it beside a status it
 * never touches.
 *
 *   null    nothing committed; the screen says nothing rather than "₹0 committed"
 *   info    committed money exists and there is room for all of it
 *   near    the head is close to spoken for once promises are counted
 *   high    promises plus this voucher exceed the allocation
 */
function commitmentNote({ ledgerName, allocated, projectedActual, openCommitments }) {
  const committed = variance.money(openCommitments) ?? 0;
  if (!(committed > 0)) return null;

  const alloc = variance.money(allocated) ?? 0;
  const projected = variance.money(projectedActual) ?? 0;
  /* Everything spoken for: what will have been posted once this voucher lands,
     plus what has been promised and not yet billed. */
  const pressure = Math.round((projected + committed) * 100) / 100;
  const pressurePct = alloc > 0 ? (pressure / alloc) * 100 : null;

  const severity =
    alloc > 0 && pressure > alloc
      ? "high"
      : pressurePct !== null && pressurePct >= WARN_AT_PCT
        ? "near"
        : "info";

  const head = ledgerName || "This head";
  const headline =
    severity === "high"
      ? "Including approved requests, this head will be over budget. Posting is still allowed unless actual spend crosses the budget rule."
      : "Approved requests already use part of this budget head.";

  /* The figures, in one sentence, naming the head — a voucher can touch four
     heads and a merged message would tell finance about none of them. */
  const detail =
    `${head} already has ${inr(committed)} committed through approved requests. ` +
    (alloc > 0
      ? `After this voucher, ${inr(pressure)} of ${inr(alloc)} will be spoken for including commitments.`
      : `After this voucher, ${inr(pressure)} will be spoken for including commitments.`);

  return {
    committed,
    pressure,
    pressurePct: pressurePct === null ? null : Math.round(pressurePct * 10) / 10,
    /* Both readings, because they answer different questions: the first is what
       the gate uses, the second is what a person should know. */
    availableExcludingCommitments: Math.round((alloc - projected) * 100) / 100,
    availableIncludingCommitments: Math.round((alloc - pressure) * 100) / 100,
    severity,
    headline,
    detail,
    /* Never a blocker. Stated on the object so no caller has to infer it. */
    blocking: false,
  };
}

/**
 * Attach commitment context to an availability result set.
 *
 * ── WHAT IS DELIBERATELY EXCLUDED ───────────────────────────────────────────
 * The commitment THIS voucher is about to release. A bill raised against an
 * approved request discharges its own promise the moment it posts, so counting
 * it as still-open pressure would warn finance about money the voucher itself
 * removes — the same ₹40,000 twice.
 *
 * Which commitment that is comes from `commitmentForVoucher`, the same function
 * that decides what actually gets released. Using a second rule here would let
 * the warning and the release disagree, which is the only way this can be
 * wrong. It matches on explicit links only — the commitment id, the spend
 * request id, or the order reference the company itself generated — and never
 * on amount, vendor or date.
 */
async function attachCommitmentContext({ results, releasingCommitment = null }) {
  /* ── RAW IDS, NOT STRINGS ────────────────────────────────────────────────
     `committedByLine` matches inside an aggregation pipeline, and an
     aggregation does not cast against the schema the way a query does — a
     string never matches a stored ObjectId, and the failure is silent: every
     head reports zero committed and the warning simply never appears. */
  /* Every result carries the key, so a screen never has to tell "no
     commitments" apart from "the field is missing". */
  for (const r of results || []) r.commitment = null;

  const lineIds = [];
  for (const r of results || []) {
    for (const b of r.budgets || []) if (b.itemId) lineIds.push(b.itemId);
  }
  if (!lineIds.length) return results;

  const commitments = require("./budgetCommitment.service");
  const byLine = await commitments.committedByLine(lineIds).catch(() => new Map());

  const releasedLine = releasingCommitment?.budgetLineId
    ? String(releasingCommitment.budgetLineId)
    : null;
  const releasedAmount = variance.money(releasingCommitment?.amount) ?? 0;
  /* Only a live promise is released by posting. One already released is not
     being counted anyway. */
  const releasing = releasingCommitment?.status === "committed" ? releasedAmount : 0;

  for (const r of results || []) {
    const lines = (r.budgets || []).map((b) => String(b.itemId)).filter(Boolean);
    let open = lines.reduce((sum, id) => sum + (byLine.get(id) || 0), 0);
    if (releasedLine && lines.includes(releasedLine)) open -= releasing;
    open = Math.round(Math.max(0, open) * 100) / 100;

    r.commitment = commitmentNote({
      ledgerName: r.ledgerName,
      allocated: r.allocated,
      projectedActual: r.projectedActual,
      openCommitments: open,
    });
  }
  return results;
}

module.exports = {
  commitmentNote,
  attachCommitmentContext,
  validateCostCentreAllocations,
  CONTROLLING_STATUSES,
  WARN_AT_PCT,
  worstStatus,
  needsOverride,
  proposedByLedger,
  checkBudgetAvailability,
  clearanceFor,
  assertClearance,
  overrideRecord,
  proposedVoucher,
  affectsBudget,
  BudgetOverrideRequiredError,
};
