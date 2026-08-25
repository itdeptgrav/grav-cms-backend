/**
 * GRAV-CMS-BACKEND/services/budgetVariance.service.js
 *
 * Budget arithmetic — revenue AND expense.
 *
 * ── WHY THIS IS NOT `allocated - actual` ────────────────────────────────────
 * A budget module that treats every line the same way is wrong half the time.
 * For an expense line, coming in under the number is GOOD. For a revenue line,
 * coming in under the number is the whole problem. The sign of "variance" has
 * to follow the nature of the account, or the colour on the screen tells the
 * reader the opposite of the truth — and a red figure that should be green is
 * worse than no figure, because people act on it.
 *
 * So every function here takes `nature` ("revenue" | "expense") and the one
 * rule is:
 *
 *     expense:  favourable when actual <  allocated   (variance = alloc - act)
 *     revenue:  favourable when actual >= allocated   (variance = act - alloc)
 *
 * ── WHY PACING ──────────────────────────────────────────────────────────────
 * "You have used 50% of the budget" means nothing on its own. In month six of
 * twelve it is exactly on plan; in month two it is a fire. Without an
 * expected-to-date figure a budget only becomes informative on the last day of
 * the year, by which point it is a post-mortem rather than a control. Every
 * line therefore carries what it SHOULD be at `asOf`, and the pace state is
 * derived from the gap.
 *
 * Pure module: no Mongoose, no Firestore, no clock of its own. `asOf` is always
 * passed in. That keeps it testable and keeps the maths honest.
 */

/* ── Tolerant readers ───────────────────────────────────────────────────────
 * `Number(null)` is 0 and `new Date(null)` is the epoch. Both have bitten this
 * codebase before: an unset field read as a deliberate zero. Everything that
 * can be absent is checked for absence first, and absence stays absent. */

/** A finite, non-negative money figure, or null when there isn't one. */
function money(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Milliseconds, or null. Never the epoch by accident. */
function time(v) {
  if (v === null || v === undefined || v === "") return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/* ── THE THREE THINGS A BUDGET LINE CAN BE ───────────────────────────────────
 * "other" is new, and it exists because the ledger tree has five natures —
 * asset, liability, equity, revenue, expense — and only two of them are a
 * budget. A line on a bank account or a loan used to be normalised to
 * "expense" and quietly added to the company's spend, which is a figure nobody
 * could reconcile against the P&L.
 *
 * It is NOT a fourth kind of budget. It is a line the module cannot control,
 * kept visible and kept out of the totals. */
const NATURES = new Set(["revenue", "expense", "other"]);

/** The ledger natures that are not a budget at all. */
const UNSUPPORTED = new Set(["asset", "liability", "equity"]);

/**
 * Normalise whatever the caller has into "revenue" or "expense".
 * Ledger groups carry `nature` directly; older budget rows may only carry the
 * `isRevenue` flag or nothing at all. Expense is the default because that is
 * what every pre-existing row in this system is.
 */
function natureOf(source = {}) {
  const raw = typeof source === "string" ? source : source.nature;
  if (NATURES.has(raw)) return raw;
  /* A head the chart of accounts calls an asset or a liability is not spend.
   * Saying so is the whole point; the old fallthrough said "expense". */
  if (UNSUPPORTED.has(raw)) return "other";
  if (source && source.isRevenue === true) return "revenue";
  /* Still expense for a line that says nothing at all — a legacy row with no
   * ledger and no snapshot. That is a guess, but it is the guess the module
   * has always made and the one the snapshot on the row implies. */
  return "expense";
}

/**
 * How far through the period we are at `asOf`, as a 0..1 fraction.
 * Clamped at both ends: before the start is 0, after the end is 1, and a
 * zero-length or unreadable period is treated as complete rather than dividing
 * by zero.
 */
function elapsedFraction({ startDate, endDate, asOf }) {
  const s = time(startDate);
  const e = time(endDate);
  const a = time(asOf);
  if (s === null || e === null || a === null) return 1;
  if (e <= s) return 1;
  if (a <= s) return 0;
  if (a >= e) return 1;
  return (a - s) / (e - s);
}

/**
 * What this line is expected to have reached by `asOf`.
 *
 * `phasing` is an optional array of monthly weights (any scale — they are
 * normalised). Seasonal businesses need it: a garment exporter does not earn
 * one twelfth of its revenue in each month, and straight-lining a Diwali-heavy
 * year makes every month until October look like a miss. With no phasing the
 * line straight-lines, which is the right default and what most rows will use.
 */
function expectedToDate({ allocated, startDate, endDate, asOf, phasing }) {
  const alloc = money(allocated);
  if (alloc === null) return null;

  const weights = Array.isArray(phasing)
    ? phasing.map((w) => money(w)).filter((w) => w !== null && w >= 0)
    : [];
  const totalWeight = weights.reduce((s, w) => s + w, 0);

  const f = elapsedFraction({ startDate, endDate, asOf });
  if (weights.length === 0 || totalWeight <= 0) return alloc * f;

  /* Phased: walk whole buckets, then take the part-bucket we are inside.
     Buckets are equal slices of the period, so this works for a 12-month year
     and an arbitrary quarter alike. */
  const exact = f * weights.length;
  const whole = Math.floor(exact);
  const within = exact - whole;
  let cum = 0;
  for (let i = 0; i < whole && i < weights.length; i += 1) cum += weights[i];
  if (whole < weights.length) cum += weights[whole] * within;
  return (cum / totalWeight) * alloc;
}

/**
 * The full picture for one budget line.
 *
 * `variance` is always signed so that POSITIVE MEANS GOOD, whatever the
 * nature. Callers can colour on the sign alone and be right every time, which
 * is the entire point of doing this here rather than in each screen.
 */
function evaluateLine({
  allocated,
  actual,
  nature,
  startDate,
  endDate,
  asOf,
  phasing,
  warnAtPct = 90,
  criticalAtPct = 100,
} = {}) {
  const kind = natureOf({ nature });
  const alloc = money(allocated) ?? 0;
  const act = money(actual) ?? 0;

  const variance = kind === "revenue" ? act - alloc : alloc - act;
  const favourable = variance >= 0;

  /* Utilisation is "how much of the number has been used/earned". It is the
     same ratio for both natures — only its desirability differs. */
  const utilizationPct = alloc > 0 ? (act / alloc) * 100 : null;

  const expected = expectedToDate({ allocated: alloc, startDate, endDate, asOf, phasing });
  const paceGap = expected === null ? null : kind === "revenue" ? act - expected : expected - act;
  const elapsed = elapsedFraction({ startDate, endDate, asOf });

  return {
    nature: kind,
    allocated: alloc,
    actual: act,
    /* `remaining` is only meaningful for expense — money still available. For
       revenue the equivalent question is "how much left to earn", which is the
       same subtraction but must never be read as headroom, so it is named for
       what it is rather than shared. */
    remaining: kind === "expense" ? alloc - act : null,
    toGo: kind === "revenue" ? Math.max(0, alloc - act) : null,
    variance,
    variancePct: alloc > 0 ? (variance / alloc) * 100 : null,
    favourable,
    utilizationPct,
    expectedToDate: expected,
    paceGap,
    pace: paceState({ kind, alloc, act, expected }),
    severity: severityFor({ kind, utilizationPct, expected, act, elapsed, warnAtPct, criticalAtPct }),
  };
}

/**
 * Where this line stands against where it should be.
 *
 * Deliberately coarse — four words a person can act on, not a percentage they
 * have to interpret. A 2% band around the expectation stops every line from
 * flickering between "ahead" and "behind" on rounding.
 */
function paceState({ kind, alloc, act, expected }) {
  if (!(alloc > 0)) return "no_budget";
  if (expected === null) return "unknown";

  /* Overspend / overachievement against the FULL number is a different fact
     from being off pace, and it outranks it. */
  if (kind === "expense" && act > alloc) return "over_budget";
  if (kind === "revenue" && act >= alloc) return "target_met";

  if (act === 0 && expected > 0) return "not_started";

  const band = alloc * 0.02;
  if (Math.abs(act - expected) <= band) return "on_track";

  if (kind === "expense") return act > expected ? "overspending" : "underspending";
  return act > expected ? "ahead" : "behind";
}

/**
 * Alert severity for a line. Expense escalates on consumption; revenue
 * escalates on SHORTFALL, which is why the two cannot share a threshold.
 */
const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 };

/** The louder of two severities. Signals combine by taking the worst, never by
 *  averaging — an averaged alarm is one that fails to ring. */
function worseOf(a, b) {
  return (SEVERITY_RANK[b] ?? 0) > (SEVERITY_RANK[a] ?? 0) ? b : a;
}

const PACE_SIGNAL_FLOOR = 0.1;

function severityFor({ kind, utilizationPct, expected, act, elapsed, warnAtPct, criticalAtPct }) {
  if (utilizationPct === null) return "info";

  /* Expense escalates on absolute consumption — having spent the whole year's
     budget in week one is critical on its own terms, whatever the pace maths
     says, so this half needs no warm-up.
     
     But consumption ALONE under-reports: 96% consumed in month twelve is a
     budget landing on target, while the same 96% in month six is a line that
     will overrun by half a year's spend. The two signals are therefore taken
     together and the worse one wins. Pace-based escalation still respects the
     warm-up floor, for the same noise reason as revenue. */
  if (kind === "expense") {
    let bySpend = "info";
    if (utilizationPct >= criticalAtPct) bySpend = "critical";
    else if (utilizationPct >= warnAtPct) bySpend = "warning";

    let byPace = "info";
    const warmedUp = !(typeof elapsed === "number" && elapsed < PACE_SIGNAL_FLOOR);
    if (warmedUp && expected !== null && expected > 0) {
      const overrun = act / expected;
      if (overrun >= 1.5) byPace = "critical";
      else if (overrun >= 1.2) byPace = "warning";
    }
    return worseOf(bySpend, byPace);
  }

  /* Revenue is measured against what should have arrived by now rather than
     against the year-end number — a January line is not failing for being at
     8% of an annual target.
     
     But a ratio against a tiny expectation is noise: seven days into a year the
     expected figure is a rounding error, one invoice swings attainment by
     hundreds of percent, and a module that shouts on day seven is one nobody
     reads by day thirty. Pace severity therefore stays quiet until a tenth of
     the period has actually run. The variance and pace fields are still
     computed throughout — this suppresses the ALARM, not the information. */
  if (expected === null || !(expected > 0)) return "info";
  if (typeof elapsed === "number" && elapsed < PACE_SIGNAL_FLOOR) return "info";

  const attainment = (act / expected) * 100;
  if (attainment < 75) return "critical";
  if (attainment < 90) return "warning";
  return "info";
}

/**
 * Consolidate many evaluated lines into the three figures a manager reads
 * first: what we expect to earn, what we expect to spend, and what that leaves.
 *
 * Budgeted net and actual net are both returned because the interesting number
 * is the gap between them — that is the profit surprise, and it is the one
 * figure a flat expense-only budget can never produce.
 */
function rollUp(lines = []) {
  const seed = () => ({ allocated: 0, actual: 0, variance: 0, count: 0 });
  const revenue = seed();
  const expense = seed();
  /* Counted so the line is not lost, but deliberately outside both totals and
   * outside net: a budget line on a bank account is not revenue, is not spend,
   * and adding it to either produces a figure that cannot be reconciled. */
  const other = seed();

  for (const l of lines) {
    if (!l) continue;
    const kind = natureOf(l);
    const bucket = kind === "revenue" ? revenue : kind === "other" ? other : expense;
    bucket.allocated += money(l.allocated) ?? 0;
    bucket.actual += money(l.actual) ?? 0;
    bucket.variance += money(l.variance) ?? 0;
    bucket.count += 1;
  }

  const budgetedNet = revenue.allocated - expense.allocated;
  const actualNet = revenue.actual - expense.actual;

  return {
    revenue,
    expense,
    other,
    /* What each side actually has, so a caller can ask "is there a revenue
     * side at all" without inferring it from a zero — a company with no
     * revenue targets and a company whose targets are all met both total
     * zero, and they are not the same thing. */
    hasRevenue: revenue.count > 0,
    hasExpense: expense.count > 0,
    budgetedNet,
    actualNet,
    netVariance: actualNet - budgetedNet,
    /* Margin only means something when there is revenue to divide by. */
    budgetedMarginPct: revenue.allocated > 0 ? (budgetedNet / revenue.allocated) * 100 : null,
    actualMarginPct: revenue.actual > 0 ? (actualNet / revenue.actual) * 100 : null,
  };
}

/**
 * What a department IS, read off the lines it owns rather than declared.
 *
 * Nobody should be asked "is HR a revenue department". The chart of accounts
 * already knows: a department with only expense lines is a cost centre, only
 * revenue lines a revenue centre, both a contribution centre. No lines yet is
 * not a classification, it is an absence — and saying "unclassified" is more
 * honest than defaulting it to cost centre and printing ₹0 earned.
 */
function centreOf(lines = []) {
  let rev = 0;
  let exp = 0;
  for (const l of lines) {
    if (!l) continue;
    const kind = natureOf(l);
    if (kind === "revenue") rev += 1;
    else if (kind === "expense") exp += 1;
  }
  if (rev && exp) return "contribution";
  if (rev) return "revenue";
  if (exp) return "cost";
  return "unclassified";
}

/** The same consolidation, split by whatever key each line carries. */
function groupBy(lines = [], key = "department") {
  const out = new Map();
  for (const l of lines) {
    if (!l) continue;
    const k = l[key] || "Unassigned";
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(l);
  }
  return [...out.entries()]
    .map(([name, group]) => ({ name, ...rollUp(group), lines: group.length }))
    .sort((a, b) => b.revenue.allocated + b.expense.allocated - (a.revenue.allocated + a.expense.allocated));
}

module.exports = {
  natureOf,
  centreOf,
  UNSUPPORTED,
  worseOf,
  money,
  elapsedFraction,
  expectedToDate,
  evaluateLine,
  paceState,
  severityFor,
  rollUp,
  groupBy,
};
