// services/sales/paymentPlan.service.js
//
// WHEN EACH PART OF THE MONEY FALLS DUE, AND WHAT THAT COSTS.
//
// A payment plan is a list of tranches. Each one says how much, against which
// event, and how far from it: "60% on order confirmation", "20% on dispatch",
// "20% 45 days after the invoice". Three sentences a customer agreed, and
// three dates an order will actually see.
//
// ── WHAT THIS REPLACES ─────────────────────────────────────────────────────
// A row of a NAME and a PERCENTAGE — "Advance Payment 60% / Final Payment
// 40%" — held on the customer record and printed on documents. Read as a
// commercial agreement it is unusable, because it never says WHEN. "Final
// Payment 40%" is 40% before dispatch, or on delivery, or 30 days after the
// invoice; those are three different agreements costing three different
// amounts to finance, and nothing in the row tells them apart.
//
// ── THE TRANCHES ARE NOT COLLAPSED ─────────────────────────────────────────
// The obvious shortcut is to reduce a plan to one advance percentage and one
// weighted-average credit period, which is what `advancePercent` and
// `creditDays` are. It is also a lie with money on it: a plan of 60% at order
// confirmation, 20% at dispatch and 20% at invoice + 45 days is THREE sums,
// each financed for its own number of days, and a single average explains
// none of them to the person who has to defend the price.
//
// So financing is worked out tranche by tranche and added up
// (`services/centralCosting/financing.service.js`). The old pair survives for
// records written before plans existed, whose calculation is marked
// LEGACY_SIMPLE and says so on the version.
//
// ── AND THE PLAN IS RELATIVE UNTIL AN ORDER MAKES IT REAL ──────────────────
// A customer's standing plan carries events and offsets, never dates. Dates
// are resolved against ONE order's canonical dates, on the enquiry, and are
// resolved as far as that order actually knows: an event nobody has dated yet
// produces a tranche with no expected date rather than a date invented from
// today. What cannot be dated cannot be financed, and says so.
"use strict";

const {
  PAYMENT_DUE_EVENTS, PAYMENT_DUE_EVENT_CODES,
  PAYMENT_OFFSET_DIRECTION_CODES,
  PAYMENT_TERM_SHAPE_CODES,
} = require("../../constants/crm");

const str = (v) => String(v ?? "").trim();
const EVENT_LABEL = Object.freeze(Object.fromEntries(PAYMENT_DUE_EVENTS.map((e) => [e.code, e.label])));

/** A percentage a plan can hold: 0 < p <= 100, at most two decimals. */
function usableShare(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return null;
  return Math.round(n * 100) / 100;
}

/** A whole number of days, never negative. */
function usableOffset(v) {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

const known = (list, code) => list.includes(str(code));

/**
 * ONE TRANCHE, AS IT IS STORED.
 *
 * Returns `{ ok, row }` or `{ ok: false, field, message }`. The field names
 * are the row's own, so a screen can put the message under the box that is
 * wrong rather than over the whole plan.
 */
function normaliseRow(input = {}, index = 0) {
  const at = (field) => `plan[${index}].${field}`;
  const name = str(input.name).slice(0, 80);
  if (!name) {
    return { ok: false, field: at("name"), message: "Give this payment step a name — it is what the customer sees." };
  }
  const percentage = usableShare(input.percentage);
  if (percentage === null) {
    return { ok: false, field: at("percentage"), message: `“${name}” needs a share of the order value, above 0 and at most 100.` };
  }
  if (!known(PAYMENT_DUE_EVENT_CODES, input.dueEvent)) {
    return {
      ok: false,
      field: at("dueEvent"),
      message: `Say what “${name}” is due against — an amount with no event is not a payment term.`,
    };
  }
  const direction = str(input.offsetDirection) || "ON";
  if (!known(PAYMENT_OFFSET_DIRECTION_CODES, direction)) {
    return { ok: false, field: at("offsetDirection"), message: "Say whether it falls due before, on, or after that event." };
  }
  const offsetDays = usableOffset(input.offsetDays);
  if (offsetDays === null) {
    return { ok: false, field: at("offsetDays"), message: `“${name}” needs a whole number of days, not negative.` };
  }
  /* ── "ON" CARRIES NO DAYS ────────────────────────────────────────────
     Not corrected silently: "on dispatch, 30 days" is two answers, and the
     one that was meant is the typist's to say. */
  if (direction === "ON" && offsetDays > 0) {
    return {
      ok: false,
      field: at("offsetDays"),
      message: `“${name}” is due ON that event, so it cannot also be ${offsetDays} days from it. `
        + "Choose before or after, or clear the days.",
    };
  }
  return {
    ok: true,
    row: { name, percentage, dueEvent: str(input.dueEvent), offsetDirection: direction, offsetDays: direction === "ON" ? 0 : offsetDays },
  };
}

/**
 * A WHOLE PLAN.
 *
 * The one rule beyond the rows themselves: the shares add up to exactly 100%.
 * A plan that adds to 95 leaves 5% of the order with no agreed moment to be
 * paid in, and a plan that adds to 105 promises more than the order is worth.
 */
function validate(rows) {
  if (!Array.isArray(rows)) {
    return { ok: false, field: "plan", message: "A payment plan is a list of steps." };
  }
  const kept = rows.filter((r) => r && (str(r.name) || r.percentage !== "" || r.dueEvent));
  if (!kept.length) return { ok: true, plan: [] };
  if (kept.length > 12) {
    return { ok: false, field: "plan", message: "A payment plan of more than twelve steps is a schedule, not a term." };
  }

  const plan = [];
  for (let i = 0; i < kept.length; i += 1) {
    const checked = normaliseRow(kept[i], i);
    if (!checked.ok) return checked;
    plan.push(checked.row);
  }
  const total = Math.round(plan.reduce((sum, r) => sum + r.percentage, 0) * 100) / 100;
  if (total !== 100) {
    return {
      ok: false,
      field: "plan",
      message: `The steps add up to ${total}% of the order. They have to add up to exactly 100% — `
        + `${total < 100 ? "part of the order has no agreed moment to be paid in" : "the plan promises more than the order is worth"}.`,
    };
  }
  return { ok: true, plan };
}

/* ── THE EIGHT NAMED TERMS, AS PLANS ───────────────────────────────────────
   The chooser is a PRESET: picking "part advance, balance on dispatch" writes
   the rows it means, and the rows are then the record. The shape is read back
   OUT of the rows (`shapeOf`), so the name and the plan can never disagree —
   which is the whole reason the rows are not a second editor beside it. */
const BALANCE = "Balance";
const ADVANCE = "Advance payment";

function planForShape(shape, { advancePercent = null, creditDays = null } = {}) {
  const advance = usableShare(advancePercent);
  const days = creditDays === null || creditDays === undefined || creditDays === "" ? null : Number(creditDays);
  const after = (event, d) => ({ dueEvent: event, offsetDirection: d > 0 ? "AFTER" : "ON", offsetDays: d > 0 ? d : 0 });

  switch (str(shape)) {
    case "FULL_ADVANCE":
      return [{ name: "Advance with order", percentage: 100, dueEvent: "ORDER_CONFIRMATION", offsetDirection: "ON", offsetDays: 0 }];
    case "PART_BEFORE_DISPATCH":
    case "PART_ON_DISPATCH":
    case "PART_ON_DELIVERY": {
      if (advance === null || advance >= 100) return [];
      const event = str(shape) === "PART_ON_DELIVERY" ? "DELIVERY" : "DISPATCH";
      const direction = str(shape) === "PART_BEFORE_DISPATCH" ? "BEFORE" : "ON";
      return [
        { name: ADVANCE, percentage: advance, dueEvent: "ORDER_CONFIRMATION", offsetDirection: "ON", offsetDays: 0 },
        { name: BALANCE, percentage: Math.round((100 - advance) * 100) / 100, dueEvent: event, offsetDirection: direction, offsetDays: 0 },
      ];
    }
    case "CREDIT_INVOICE":
    case "CREDIT_DISPATCH":
    case "CREDIT_BILL_OF_LADING": {
      if (days === null || !Number.isFinite(days) || days < 0) return [];
      const event = str(shape) === "CREDIT_INVOICE" ? "INVOICE"
        : str(shape) === "CREDIT_DISPATCH" ? "DISPATCH" : "BILL_OF_LADING";
      const rows = [];
      if (advance !== null && advance > 0) {
        rows.push({ name: ADVANCE, percentage: advance, dueEvent: "ORDER_CONFIRMATION", offsetDirection: "ON", offsetDays: 0 });
      }
      const balance = advance !== null && advance > 0 ? Math.round((100 - advance) * 100) / 100 : 100;
      rows.push({ name: rows.length ? BALANCE : "Payment", percentage: balance, ...after(event, days) });
      return rows;
    }
    default:
      /* CUSTOM, and anything this system does not name, has no preset: it is
         the choice for the plans the seven named terms cannot describe, so
         there is nothing to fill in and the rows are written by hand. */
      return [];
  }
}

/**
 * THE NAME OF THE AGREEMENT THESE ROWS DESCRIBE.
 *
 * Derived, never stored beside the rows as a second answer. Anything the
 * seven named terms cannot describe is Custom — which is exactly what Custom
 * is for, and is not a failure.
 */
function shapeOf(plan) {
  const rows = Array.isArray(plan) ? plan : [];
  if (!rows.length) return "";
  const upfront = (r) => r.dueEvent === "ORDER_CONFIRMATION" || r.dueEvent === "PROFORMA";

  if (rows.length === 1) {
    const [only] = rows;
    if (only.percentage !== 100) return "CUSTOM";
    if (upfront(only) && only.offsetDirection === "ON") return "FULL_ADVANCE";
    if (only.offsetDirection === "AFTER") {
      if (only.dueEvent === "INVOICE") return "CREDIT_INVOICE";
      if (only.dueEvent === "DISPATCH") return "CREDIT_DISPATCH";
      if (only.dueEvent === "BILL_OF_LADING") return "CREDIT_BILL_OF_LADING";
    }
    return "CUSTOM";
  }
  if (rows.length !== 2) return "CUSTOM";

  const [first, second] = rows;
  if (!upfront(first) || first.offsetDirection !== "ON") return "CUSTOM";
  if (second.offsetDays > 0) {
    if (second.offsetDirection !== "AFTER") return "CUSTOM";
    if (second.dueEvent === "INVOICE") return "CREDIT_INVOICE";
    if (second.dueEvent === "DISPATCH") return "CREDIT_DISPATCH";
    if (second.dueEvent === "BILL_OF_LADING") return "CREDIT_BILL_OF_LADING";
    return "CUSTOM";
  }
  if (second.dueEvent === "DISPATCH") return second.offsetDirection === "BEFORE" ? "PART_BEFORE_DISPATCH" : "PART_ON_DISPATCH";
  if (second.dueEvent === "DELIVERY" && second.offsetDirection === "ON") return "PART_ON_DELIVERY";
  return "CUSTOM";
}

/** How one tranche reads in a sentence: "40% 45 days after the invoice date". */
function phraseFor(row) {
  const event = EVENT_LABEL[str(row?.dueEvent)] || "";
  const share = `${row.percentage}%`;
  if (!event) return share;
  if (row.offsetDirection === "ON" || !row.offsetDays) return `${share} on ${event.toLowerCase()}`;
  const days = `${row.offsetDays} day${row.offsetDays === 1 ? "" : "s"}`;
  return `${share} ${days} ${row.offsetDirection === "BEFORE" ? "before" : "after"} ${event.toLowerCase()}`;
}

/**
 * The plan as one line, for a preview and for a document.
 * "60% due on order confirmation; 40% due 30 days after invoice date."
 */
function summarise(plan) {
  const rows = Array.isArray(plan) ? plan : [];
  if (!rows.length) return "";
  return `${rows.map((r) => phraseFor(r).replace("% ", "% due ")).join("; ")}.`;
}

/**
 * THE ORDER'S OWN DATES, EVENT BY EVENT.
 *
 * Whatever the enquiry actually knows, and nothing else. An event with no
 * date is not guessed from today: a tranche hanging off it has no expected
 * date, is not financed, and says which date is missing.
 *
 * @param {object} dates  `{ ORDER_CONFIRMATION: Date|null, ... }`
 */
function resolvePlan(plan, dates = {}) {
  const rows = Array.isArray(plan) ? plan : [];
  return rows.map((row) => {
    const anchor = dates[str(row.dueEvent)];
    const at = anchor ? new Date(anchor) : null;
    if (!at || Number.isNaN(at.getTime())) {
      return { ...row, expectedDate: null, unknownDate: str(row.dueEvent) };
    }
    const shift = row.offsetDirection === "BEFORE" ? -row.offsetDays : row.offsetDays;
    const due = new Date(at.getTime());
    due.setUTCDate(due.getUTCDate() + shift);
    return { ...row, expectedDate: due, unknownDate: null };
  });
}

/* ── EVENTS THAT HAPPEN BEFORE THE COMPANY SPENDS ──────────────────────────
   Money agreed against any of these is in hand before production starts,
   which is the one thing the pipeline can enforce: an order does not enter
   production until the agreed advance has been received. */
const UPFRONT_EVENTS = Object.freeze(["ORDER_CONFIRMATION", "PROFORMA", "PRODUCTION_START"]);

/**
 * How much of the order is agreed before production may start.
 *
 * DERIVED from the plan, never typed beside it — this is what
 * `advancePercent` has always meant, and keeping it in step with the rows is
 * how the production gate goes on working for a customer whose terms are now
 * a three-tranche plan. A tranche due AFTER production starts is not an
 * advance however early in the order it sits.
 */
function upfrontShare(plan) {
  const rows = Array.isArray(plan) ? plan : [];
  if (!rows.length) return null;
  const total = rows.reduce((sum, r) => {
    if (!UPFRONT_EVENTS.includes(str(r.dueEvent))) return sum;
    if (r.offsetDirection === "AFTER" && r.offsetDays > 0) return sum;
    return sum + Number(r.percentage || 0);
  }, 0);
  return Math.round(total * 100) / 100;
}

/** Which events a plan needs dated before every tranche can be financed. */
function undatedEvents(resolved) {
  return [...new Set((resolved || []).map((r) => r.unknownDate).filter(Boolean))];
}

module.exports = {
  EVENT_LABEL,
  usableShare,
  usableOffset,
  normaliseRow,
  validate,
  planForShape,
  shapeOf,
  phraseFor,
  summarise,
  resolvePlan,
  undatedEvents,
  upfrontShare,
  UPFRONT_EVENTS,
  SHAPE_CODES: PAYMENT_TERM_SHAPE_CODES,
};
