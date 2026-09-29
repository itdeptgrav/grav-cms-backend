// services/centralCosting/financing.service.js
//
// WHAT IT COSTS THIS COMPANY TO WAIT TO BE PAID FOR THIS ORDER.
//
// ── THE TWO HALVES, AND WHY NEITHER ALONE IS A COST ─────────────────────────
// The Board says what money costs and how a duration becomes a figure. Sales
// says how long this order's money is out. Until this file existed the company
// had only the first half, and applied it as a flat percentage of a subtotal —
// which is a number with the same units as a cost of capital and none of its
// meaning. Two orders with the same materials and payment terms ninety days
// apart carried identical financing.
//
//     financing = basis × financed share × annual rate × days ÷ day count
//
// Every term on the right is a recorded decision with an owner. Nothing here
// supplies a default for any of them.
//
// ── FIVE ANSWERS, AND ONLY TWO OF THEM ARE A CALCULATION ────────────────────
//   CALCULATED      a rate, a share and a duration — a figure.
//   RECORDED_ZERO   the money is out for no time. Paid in full up front, or
//                   due immediately. That is an ANSWER somebody gave, and it
//                   is frozen with the terms that produced it.
//   NOT_APPLICABLE  Sales stated a reason financing does not apply.
//   TERMS_MISSING   nobody has agreed when this order gets paid.
//   POLICY_MISSING  the Board has not decided what money costs.
//
// The last two produce NO LINE. Not a zero — a zero here is the claim that
// this order costs nothing to finance, which is exactly what an unanswered
// question is not. `RECORDED_ZERO` and `TERMS_MISSING` both total nil and are
// different statements; keeping them apart is most of the point of this file.
//
// ── AND NOTHING IS PARSED FROM PROSE ────────────────────────────────────────
// `NET30`, "60% against BL" and `Enquiry.balanceTerms` are read by people. The
// duration used here comes from the structured, confirmed terms Sales records
// and from nowhere else.
//
// ── ONE SUM PER TRANCHE, NEVER ONE AVERAGE ──────────────────────────────────
// Sales records a PLAN: "60% on order confirmation, 20% on dispatch, 20% 45
// days after the invoice". The tempting shortcut is to reduce it to one
// advance percentage and one weighted-average credit period — the old pair —
// and it is a lie with money on it, because it explains none of the three
// sums to the person who has to defend the price.
//
//     financing = Σ basis × tranche share × annual rate × financed days ÷ day count
//
// Each tranche is worked out on its own and the results are added. The old
// single-pair arithmetic is the one-tranche case of exactly this formula, so
// an order priced before plans existed prices the same today — its
// calculation is marked LEGACY_SIMPLE and says so on the version.
//
// ── WHERE "FINANCED DAYS" COMES FROM ────────────────────────────────────────
// From the CALENDAR.
//
//     financed days = tranche due date − financing start date
//
// An offset says how to DERIVE a due date; it is not a duration. "45 days
// after the invoice" on an order invoiced in March is money outstanding from
// whenever the company's own money went out until the middle of April, and
// how long that is depends entirely on when it went out. Two orders on
// identical terms, one committing fabric in January and one in March, do not
// cost the same to finance, and an offset cannot tell them apart.
//
// The start is the BOARD'S: `financing.startEvent` names the operational
// event the company's money goes out at — material commitment, production
// start, dispatch or invoice. It has no default. A policy that has not stated
// it cannot be approved, and a costing under one is blocked rather than
// estimated, because the alternative is this file choosing a methodology on
// the Board's behalf.
//
// A tranche due on or before that date is money in hand before the company
// needs it: its financed days are nil under the Board's advance treatment,
// and never negative — a payment arriving early is not finance income unless
// somebody decides it is, and nobody has.
//
// ── SO DATES MOVE PRICES, AND THAT IS THE POINT ─────────────────────────────
// Dispatch slipping a month makes an order more expensive to finance. The
// fingerprint carries the timeline, so the costing built on the old dates
// goes stale and is recalculated rather than quietly standing.
"use strict";

const { Decimal } = require("./decimal");
const boardPolicy = require("../board/boardPolicy.service");
const paymentTerms = require("../sales/paymentTermsResolution.service");
const orderSchedule = require("../sales/orderSchedule.service");

/** Whose gap it is. Matches the vocabulary the assembly already reports with. */
const OWNER = Object.freeze({
  BOARD: { department: "Board", system: "Company financing policy" },
  SALES: { department: "Sales", system: "Enquiry payment terms" },
});

const STATE = Object.freeze({
  CALCULATED: "CALCULATED",
  RECORDED_ZERO: "RECORDED_ZERO",
  NOT_APPLICABLE: "NOT_APPLICABLE",
  TERMS_MISSING: "TERMS_MISSING",
  POLICY_MISSING: "POLICY_MISSING",
});

const CODES = Object.freeze({
  POLICY_MISSING: "FINANCING_POLICY_MISSING",
  TERMS_MISSING: "PAYMENT_TERMS_MISSING",
  /* The Board named a start event this order has not reached a date for. */
  START_DATE_MISSING: "FINANCING_START_DATE_MISSING",
  /* A tranche is due against an event nobody has dated. */
  DUE_DATE_MISSING: "PAYMENT_DUE_DATE_MISSING",
});

const LINE_KEY = "policy:financing";

/* Which arithmetic produced the figure. Frozen on the version, because "40%
   for 45 days" and "one tranche of 40% for 45 days" are the same number and
   not the same statement about what was agreed. */
const METHOD = Object.freeze({
  /* Every tranche priced on the calendar, from the Board's start event to
     that tranche's own due date. */
  TIMELINE_TRANCHES: "TIMELINE_TRANCHES",
  /* One advance and one credit period, the duration taken from Sales' own
     anchor. What every record written before plans existed carries, priced
     exactly as it always was. The two are NOT the same methodology and agree
     only where the old anchor happens to fall on the Board's start event. */
  LEGACY_SIMPLE: "LEGACY_SIMPLE",
});

const rate0 = (v) => new Decimal(String(v)).toFixed();

const enquiryModel = () => require("../../models/CMS_Models/Sales/Enquiry");

/**
 * The share of the order the company is actually financing.
 *
 * ── THE ONE PLACE THE ADVANCE IS ALLOWED TO MATTER ──────────────────────────
 * And only because the Board said so. `REDUCES_FINANCED_AMOUNT` is the common
 * answer — money already received is not money being financed — but a company
 * financing its whole working-capital cycle at a blended rate may deliberately
 * charge the full order, and both produce a defensible garment cost. Hard-
 * coding either would be this code making a Board decision.
 */
function financedShare({ advanceTreatment, advancePercent }) {
  if (advanceTreatment !== "REDUCES_FINANCED_AMOUNT") return new Decimal(1);
  const advance = advancePercent === null || advancePercent === undefined
    ? new Decimal(0)
    : new Decimal(String(advancePercent));
  const share = new Decimal(100).minus(advance).dividedBy(100);
  return share.isLessThan(0) ? new Decimal(0) : share;
}

/**
 * The days one tranche's money is out: due date minus financing start.
 *
 * Never negative. A tranche falling due before the company's money goes out
 * is money in hand before it is needed — nil financed time under every
 * treatment the Board has defined, and emphatically not finance income,
 * which would be this file inventing a policy nobody approved.
 */
function financedDaysFor({ dueDate, startDate }) {
  const days = orderSchedule.daysBetween(startDate, dueDate);
  if (days === null) return null;
  return days > 0 ? new Decimal(String(days)) : new Decimal(0);
}

/**
 * THE ORDER'S FINANCING TIMELINE: one start, and a due date per tranche.
 *
 * Every date comes from the order's own schedule. What is missing is
 * REPORTED, by event and by owner — Store commits the fabric, Production
 * schedules the line, Accounts raises the invoice — and nothing is estimated
 * on their behalf.
 *
 * @param {object} input
 * @param {object[]} input.plan     the confirmed tranches
 * @param {string} input.startEvent the Board's chosen start
 * @param {object} input.dates      the order's canonical dates, by event
 */
function timelineFor({ plan, startEvent, dates = {} }) {
  const startDate = dates[String(startEvent ?? "").trim()] || null;
  const missing = [];

  if (!startDate) {
    const gap = orderSchedule.gapFor(startEvent);
    missing.push({
      code: CODES.START_DATE_MISSING,
      owner: gap.owner,
      message: `Financing on this order is measured from ${orderSchedule.labelFor(startEvent).toLowerCase()}, `
        + `and that date is not recorded. ${gap.message}`,
    });
  }

  const tranches = plan.map((row) => {
    const anchor = dates[String(row.dueEvent ?? "").trim()] || null;
    if (!anchor) return { dueDate: null, undatedEvent: row.dueEvent };
    /* The agreed offset says how to DERIVE the date; it is not the duration. */
    const shift = row.offsetDirection === "BEFORE" ? -row.offsetDays : row.offsetDays;
    const due = new Date(anchor.getTime());
    due.setUTCDate(due.getUTCDate() + (row.offsetDirection === "ON" ? 0 : shift));
    return { dueDate: due, undatedEvent: null };
  });

  for (const event of [...new Set(tranches.filter((t) => t.undatedEvent).map((t) => t.undatedEvent))]) {
    const gap = orderSchedule.gapFor(event);
    missing.push({
      code: CODES.DUE_DATE_MISSING,
      owner: gap.owner,
      message: `Part of this order is due against ${orderSchedule.labelFor(event).toLowerCase()}, `
        + `so when it falls cannot be worked out. ${gap.message}`,
    });
  }

  return { startEvent: String(startEvent ?? "").trim(), startDate, tranches, missing };
}

/**
 * THE PLAN, PRICED TRANCHE BY TRANCHE.
 *
 * Returns the effective percent of the basis, and the whole working — one row
 * per tranche, each with its own share, days and contribution, so the total
 * can be checked by hand and every part of it explained on its own.
 *
 * `advanceTreatment` still belongs to the Board and still decides one thing:
 * whether money received before the company waits reduces what is financed.
 *   REDUCES_FINANCED_AMOUNT  each tranche finances only its own share.
 *   CHARGES_FULL_ORDER       the whole order is financed until the last
 *                            tranche lands — the blended working-capital
 *                            reading, applied to the plan's own end.
 */
function priceTranches({ plan, financing, timeline }) {
  const rate = new Decimal(String(financing.annualRatePercent));
  const dayCount = new Decimal(String(financing.dayCountBasis));
  const startDate = timeline.startDate;

  const tranches = plan.map((row, i) => {
    const share = new Decimal(String(row.percentage)).dividedBy(100);
    const at = timeline.tranches[i] || {};
    const days = at.dueDate ? financedDaysFor({ dueDate: at.dueDate, startDate }) : null;
    return {
      name: row.name,
      percentage: String(row.percentage),
      dueEvent: row.dueEvent,
      offsetDirection: row.offsetDirection,
      offsetDays: row.offsetDays,
      /* The date this tranche falls due on THIS order: its event's date,
         plus or minus its agreed offset. */
      dueDate: at.dueDate || null,
      financedDays: days === null ? null : days.toFixed(),
      effectivePercent: days === null ? null : rate.times(share).times(days).dividedBy(dayCount).toFixed(6),
    };
  });

  if (financing.advanceTreatment !== "REDUCES_FINANCED_AMOUNT") {
    /* ── THE BOARD IGNORES THE ADVANCE ────────────────────────────────
       The whole order is financed for as long as any of it is outstanding:
       a company funding its working-capital cycle at a blended rate charges
       the order, not the instalment. Still one calendar distance, from the
       same start to the last date money arrives. */
    const longest = tranches.reduce(
      (most, t) => (t.financedDays !== null && new Decimal(t.financedDays).isGreaterThan(most)
        ? new Decimal(t.financedDays) : most),
      new Decimal(0),
    );
    return {
      effective: rate.times(longest).dividedBy(dayCount),
      tranches: tranches.map((t) => ({ ...t, effectivePercent: null })),
      financedSharePercent: "100",
      longestFinancedDays: longest.toFixed(),
    };
  }

  const effective = tranches.reduce((sum, t) => sum.plus(new Decimal(t.effectivePercent || "0")), new Decimal(0));
  /* What proportion of the order is financed at all — the tranches that wait,
     added up. The old `financedSharePercent` said the same thing about the
     single balance, and a reader of a frozen version expects to find it. */
  const financedShareSum = tranches.reduce(
    (sum, t) => (t.financedDays === null || new Decimal(t.financedDays).isZero()
      ? sum : sum.plus(new Decimal(t.percentage))),
    new Decimal(0),
  );
  return {
    effective,
    tranches,
    financedSharePercent: financedShareSum.toFixed(),
    longestFinancedDays: null,
  };
}

/**
 * THE METHODOLOGY, APPLIED. Pure — no database, no clock, no context.
 *
 * Exported and tested directly, because a rule that can only be reached
 * through a costing is a rule nobody checks. Everything it needs is passed in:
 * the Board's approved methodology and Sales' confirmed projection.
 *
 * @param {object|null} policy  the effective `BoardPolicy` document, or null
 * @param {object|null} terms   `paymentTermsResolution.projectionFor(enquiry)`
 * @returns {object} `{ state, percent, basis, working, missing }` — `percent`
 *   is the EFFECTIVE percent for this order, as a decimal string, or null.
 */
function compute({ policy = null, terms = null, dates = null } = {}) {
  const missing = [];

  /* ── SALES FIRST, BECAUSE IT CAN END THE QUESTION ──────────────────────
     "Financing does not apply to this order" is a commercial condition with
     a stated reason. It is an answer, and it stands whether or not the Board
     has published a rate — asking the Board to decide something before an
     intercompany transfer can be recorded as unfinanced would be asking the
     wrong person about the wrong order. */
  if (terms?.notApplicable) {
    return {
      state: STATE.NOT_APPLICABLE,
      percent: null,
      basis: policy?.financing?.basis || null,
      working: {
        reason: terms.notApplicableReason || "",
        confirmedAt: terms.confirmedAt || null,
        confirmedByName: terms.confirmedByName || "",
      },
      missing,
    };
  }

  const haveTerms = Boolean(terms) && terms.state === paymentTerms.TERMS.CONFIRMED;
  /* `startEvent` is part of a COMPLETE methodology now: a rate and a
     day-count say what a day of waiting costs and nothing about when the
     waiting began. A policy approved before this existed does not state it,
     and a plan cannot be priced under one. */
  const havePolicy = Boolean(policy?.financing?.annualRatePercent && policy?.financing?.basis
    && policy?.financing?.advanceTreatment && policy?.financing?.dayCountBasis);

  /* ── BOTH GAPS ARE REPORTED, NOT THE FIRST ────────────────────────────
     They have different owners. Reporting only the Board's would leave Sales
     believing their half was done, and reporting only Sales' would leave a
     costing that never completes for a reason nobody was told. */
  if (!havePolicy) {
    missing.push({
      code: CODES.POLICY_MISSING,
      owner: OWNER.BOARD,
      message: policy
        ? "The Board's financing policy in force does not state a complete methodology, so financing cannot be calculated."
        : "The Board has not approved a financing policy for this company, so the cost of money on this order cannot be calculated. It is not nil.",
    });
  }
  if (!haveTerms) {
    missing.push({
      code: CODES.TERMS_MISSING,
      owner: OWNER.SALES,
      message: "Nobody has confirmed when this order gets paid, so there is no duration to finance. "
        + "An unanswered question is not a cash sale.",
    });
  }

  if (!havePolicy || !haveTerms) {
    return {
      state: havePolicy ? STATE.TERMS_MISSING : STATE.POLICY_MISSING,
      percent: null,
      basis: policy?.financing?.basis || null,
      working: null,
      missing,
    };
  }

  const f = policy.financing;

  /* ── THE PLAN, WHEN THERE IS ONE ──────────────────────────────────────
     A confirmed plan is priced tranche by tranche. A record written before
     plans existed has only the old pair, is priced exactly as it always was,
     and its calculation says which of the two it was — so a reader of a
     frozen version is never left wondering whether a single figure was the
     whole agreement or an average of one. */
  const plan = Array.isArray(terms.plan) ? terms.plan : [];
  if (plan.length) {
    /* ── THE BOARD HAS TO HAVE SAID WHERE THE WAITING STARTS ────────
       A policy approved before the start event existed states a rate, a
       basis and a day-count and still cannot price a plan: there is no
       "from". It is a gap with the Board's name on it, not a reason to pick
       an event on their behalf. */
    if (!f.startEvent) {
      missing.push({
        code: CODES.POLICY_MISSING,
        owner: OWNER.BOARD,
        message: "The Board's financing policy does not say when the company's money goes out, so the "
          + "days this order is financed for cannot be measured. It is not nil.",
      });
      return { state: STATE.POLICY_MISSING, percent: null, basis: f.basis || null, working: null, missing };
    }

    const timeline = timelineFor({ plan, startEvent: f.startEvent, dates: dates || {} });
    /* ── AND THE ORDER HAS TO HAVE THE DATES ────────────────────────
       Every one is somebody's to record. Reported with their name on it and
       never estimated: a financing figure on an invented date is a price
       the company cannot defend, and falling back to the offsets would be
       this file quietly applying the methodology that was replaced. */
    if (timeline.missing.length) {
      missing.push(...timeline.missing);
      return {
        state: STATE.TERMS_MISSING,
        percent: null,
        basis: f.basis,
        working: { method: METHOD.TIMELINE_TRANCHES, startEvent: f.startEvent, startDate: null, tranches: null },
        missing,
      };
    }

    const priced = priceTranches({ plan, financing: f, timeline });
    const planWorking = {
      method: METHOD.TIMELINE_TRANCHES,
      annualRatePercent: rate0(f.annualRatePercent),
      advanceTreatment: f.advanceTreatment,
      /* The Board's start, and the date this order reached it. */
      startEvent: f.startEvent,
      startDate: timeline.startDate,
      financedSharePercent: priced.financedSharePercent,
      dayCountBasis: f.dayCountBasis,
      tranches: priced.tranches,
      ...(priced.longestFinancedDays === null ? {} : { longestFinancedDays: priced.longestFinancedDays }),
      effectivePercent: priced.effective.toFixed(6),
      formula: f.advanceTreatment === "REDUCES_FINANCED_AMOUNT"
        ? "sum over tranches of: basis x tranche share x annual rate x (tranche due date - financing start date) / day-count basis"
        : "basis x annual rate x (last due date - financing start date) / day-count basis",
    };
    if (priced.effective.isZero()) {
      /* Every tranche in hand before the money went out. An answer, not an
         absence — and not finance income either. */
      return { state: STATE.RECORDED_ZERO, percent: "0", basis: f.basis, working: planWorking, missing };
    }
    return { state: STATE.CALCULATED, percent: planWorking.effectivePercent, basis: f.basis, working: planWorking, missing };
  }

  const share = financedShare({
    advanceTreatment: f.advanceTreatment,
    advancePercent: terms.advancePercent,
  });
  /* A confirmed 100% advance records no credit period at all — Sales refuses
     the pair as a contradiction — so its duration is nil rather than absent.
     Reading it as absent here would turn "paid in full up front" into
     "unanswered", which is the opposite of what happened. */
  const days = new Decimal(String(terms.creditDays ?? 0));
  const rate = new Decimal(String(f.annualRatePercent));
  const dayCount = new Decimal(String(f.dayCountBasis));

  const effective = rate.times(share).times(days).dividedBy(dayCount);

  const working = {
    /* Priced from the old advance/credit-days pair, because that is all this
       record has. Named so a version never reads as a tranche plan. */
    method: METHOD.LEGACY_SIMPLE,
    annualRatePercent: rate.toFixed(),
    advanceTreatment: f.advanceTreatment,
    advancePercent: terms.advancePercent === null || terms.advancePercent === undefined
      ? null : String(terms.advancePercent),
    financedSharePercent: share.times(100).toFixed(),
    creditDays: terms.creditDays ?? 0,
    creditDaysFrom: terms.creditDaysFrom || null,
    creditDaysFromLabel: terms.creditDaysFromLabel || null,
    dayCountBasis: f.dayCountBasis,
    /* Six places, kept rather than rounded to two: the effective percent is an
       intermediate, and rounding an intermediate to the precision of a
       displayed rate loses money on every large basis. The engine rounds once,
       at the end, in the company's own mode. */
    effectivePercent: effective.toFixed(6),
    /* The arithmetic in words, so the figure can be checked by hand a year
       later without anybody having to find this file. */
    formula: "basis x financed share x annual rate x credit days / day-count basis",
  };

  /* ── A DURATION OF NOTHING IS AN ANSWER ───────────────────────────────
     Zero credit days, or a full advance the Board's methodology removes from
     the financed amount. The company waits for no money and that is a fact
     somebody recorded, so it is a line with a zero on it rather than an
     absent family. */
  if (effective.isZero()) {
    return {
      state: STATE.RECORDED_ZERO,
      percent: "0",
      basis: f.basis,
      working,
      missing,
    };
  }

  return { state: STATE.CALCULATED, percent: working.effectivePercent, basis: f.basis, working, missing };
}

/**
 * The two records this order's financing rests on, read.
 *
 * The Board policy is resolved against the COSTING'S OWN DATE, never against
 * now: a costing dated in March is calculated at March's methodology, and a
 * policy approved since — even one backdated — is simply not the one this
 * query selects.
 */
async function readFinancingSource(ctx, { enquiryId = null, asOf = new Date() } = {}) {
  const [policy, enquiry] = await Promise.all([
    boardPolicy.resolveEffective(ctx.companyId, "FINANCING", asOf).catch(() => null),
    enquiryId
      /* The model module, not `mongoose.model("Enquiry")` — a name lookup
         throws synchronously when the model has not been registered yet, and
         it would throw out of this function before any `.catch` could see it.
         Required lazily like the rest of this folder does it, so a pure test
         of `compute` needs no mongoose registry at all. */
      ? enquiryModel()
        .findOne({ _id: enquiryId, companyId: ctx.companyId })
        /* The schedule too: a plan is priced on the calendar, and the dates
           are the order's own. */
        .select("paymentTerms enquiryId schedule expectedOrderDate expectedClosingDate requirementDeadline")
        .lean()
        .catch(() => null)
      : null,
  ]);

  return {
    policy: policy || null,
    /* Sales' own projection, not a second reading of the enquiry. One
       interpretation of confirmed terms, shared by the screen that shows a
       department its gaps and the engine that prices them. */
    terms: enquiry ? paymentTerms.projectionFor(enquiry) : null,
    /* Resolved once, here, so the figure and the screen that explains it read
       one timeline. */
    dates: enquiry ? orderSchedule.scheduleFor(enquiry).dates : {},
    enquiryRef: enquiry?.enquiryId ? String(enquiry.enquiryId) : "",
  };
}

/**
 * What gets frozen onto the version.
 *
 * ── EVERY DECISION THE FIGURE RESTED ON, BY VALUE ───────────────────────────
 * Not a pointer to the Board policy: a reference would be re-read, and re-
 * reading is how a later approval silently restates an old costing. The
 * version keeps the id so the decision can be FOUND, and the values so it can
 * be CHECKED without finding it.
 */
function freeze({ result, policy, terms, enquiryRef = "", asOf = new Date() }) {
  const f = policy?.financing || {};
  return {
    lineKey: LINE_KEY,
    state: result.state,
    /* The Board decision, identified and copied. */
    boardPolicyId: policy?._id || null,
    policyKey: policy?.policyKey || "FINANCING",
    policyEffectiveFrom: policy?.effectiveFrom || null,
    policyApprovedAt: policy?.approvedAt || null,
    policyApprovedByName: policy?.approvedByActorName || "",
    annualRatePercent: f.annualRatePercent ?? null,
    basis: result.basis || null,
    advanceTreatment: f.advanceTreatment || null,
    dayCountBasis: f.dayCountBasis ?? null,
    /* The Sales facts, copied for the same reason. */
    enquiryRef,
    termsState: terms?.state || null,
    advancePercent: terms?.advancePercent === null || terms?.advancePercent === undefined
      ? null : String(terms.advancePercent),
    creditDays: terms?.creditDays ?? null,
    creditDaysFrom: terms?.creditDaysFrom || null,
    termsSource: terms?.source || null,
    termsConfirmedAt: terms?.confirmedAt || null,
    termsConfirmedByName: terms?.confirmedByName || "",
    notApplicableReason: result.state === STATE.NOT_APPLICABLE
      ? (terms?.notApplicableReason || "") : "",
    /* And the arithmetic, so nobody has to reconstruct it. */
    method: result.working?.method || null,
    /* ── THE TIMELINE THE FIGURE RESTED ON ────────────────────────────
       The Board's start event and the date this order reached it, frozen by
       value. Without them a reader can see the financed days but not why
       they are those days, and re-deriving them would read today's schedule
       against a figure priced on last month's. */
    startEvent: result.working?.startEvent || null,
    startDate: result.working?.startDate || null,
    /* Every tranche, by value: its share, the event it was agreed against,
       the days it was financed for and what it contributed. This is the whole
       answer to "why is the financing this much", a year later, without
       anybody re-reading the enquiry — which would by then have moved. */
    tranches: result.working?.tranches || null,
    financedSharePercent: result.working?.financedSharePercent ?? null,
    effectivePercent: result.percent ?? null,
    formula: result.working?.formula || null,
    asOf,
  };
}

module.exports = {
  OWNER, STATE, CODES, LINE_KEY, METHOD,
  financedShare, financedDaysFor, timelineFor, priceTranches, compute, readFinancingSource, freeze,
};
