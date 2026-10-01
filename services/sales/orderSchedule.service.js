// services/sales/orderSchedule.service.js
//
// THIS ORDER'S CANONICAL DATES, AND WHO OWNS EACH ONE.
//
// A payment plan is relative — "20% 45 days after the invoice" — and a
// financing cost is a number of days. Between the two sits this: the dates
// this particular order expects each operational event to happen on.
//
//     financed days = tranche due date − financing start date
//
// The financing start is the Board's choice of event (fabric committed,
// production started, dispatched, invoiced); the due dates come from the
// plan's own events and offsets. Both are resolved here, from one schedule,
// so a costing and a customer's proforma cannot be reading two different
// timelines for the same order.
//
// ── NOTHING IS INVENTED, AND SILENCE IS NOT A DATE ─────────────────────────
// An event nobody has dated resolves to NOTHING. Not today, not today plus a
// lead time somebody once typed, not the enquiry date — a financing figure
// built on an invented date is a price the company cannot defend, and a due
// date built on one is a promise nobody made.
//
// What an undated event produces instead is a GAP with an owner's name on it,
// because the fix is somebody's job and the costing screen is where they will
// be told. Store commits the fabric, Production schedules the line, Accounts
// raises the invoice; the costing waits for them rather than guessing on
// their behalf.
"use strict";

const { PAYMENT_DUE_EVENTS, PAYMENT_DUE_EVENT_CODES } = require("../../constants/crm");

/* Who records each date, in the vocabulary the assembly already reports gaps
   in. A gap nobody owns is a gap nobody fixes. */
const OWNER = Object.freeze({
  SALES: { department: "Sales", system: "Enquiry schedule" },
  STORE: { department: "Store / Purchase", system: "Material commitment" },
  PRODUCTION: { department: "Production", system: "Production schedule" },
  DISPATCH: { department: "Packaging & Dispatch", system: "Dispatch schedule" },
  ACCOUNTS: { department: "Accounts", system: "Invoicing" },
});

/**
 * Every event this system can date, what it is called, who owns the date and
 * where it is read from. One table, because the alternative is the same
 * mapping written out four times and disagreeing by the third.
 */
const EVENTS = Object.freeze({
  ORDER_CONFIRMATION: {
    owner: OWNER.SALES,
    label: "Order confirmation",
    missing: "Set the expected order date on this enquiry.",
  },
  PROFORMA: {
    owner: OWNER.SALES,
    label: "Proforma invoice",
    missing: "No proforma date is recorded for this order.",
  },
  MATERIAL_COMMITMENT: {
    owner: OWNER.STORE,
    label: "Material commitment",
    missing: "Nobody has dated the material commitment for this order — the day the company's money "
      + "goes out on fabric and trims.",
  },
  PRODUCTION_START: {
    owner: OWNER.PRODUCTION,
    label: "Production start",
    missing: "Production has not been scheduled for this order yet.",
  },
  DISPATCH: {
    owner: OWNER.DISPATCH,
    label: "Dispatch from our warehouse",
    missing: "Nobody has dated dispatch for this order yet.",
  },
  BILL_OF_LADING: {
    owner: OWNER.DISPATCH,
    label: "Bill of lading / shipment",
    missing: "There is no shipment date for this order yet.",
  },
  INVOICE: {
    owner: OWNER.ACCOUNTS,
    label: "Invoice date",
    missing: "No invoice date is expected for this order yet.",
  },
  DELIVERY: {
    owner: OWNER.SALES,
    label: "Delivery to the customer",
    missing: "Set the date the customer needs this by.",
  },
});

/* The Board's four choices of where financing starts are all in the table
   above; this is the guard that says so, rather than a comment hoping it. */
const FINANCING_START_EVENTS = Object.freeze(["MATERIAL_COMMITMENT", "PRODUCTION_START", "DISPATCH", "INVOICE"]);
for (const code of FINANCING_START_EVENTS) {
  if (!EVENTS[code]) throw new Error(`orderSchedule: financing can start at ${code}, which no event dates`);
}

const date = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * THE SCHEDULE, EVENT BY EVENT.
 *
 * @param {object} enquiry  the enquiry document (lean is fine)
 * @param {object} [extra]  dates a later stage knows that an enquiry cannot —
 *   the real dispatch date once it has shipped, the invoice once it is
 *   raised. Passed in by the caller that has them rather than read here, so
 *   this service knows the MAPPING and not every model in the system.
 * @returns {{dates: object, known: string[], unknown: string[]}}
 */
function scheduleFor(enquiry = {}, extra = {}) {
  const planned = enquiry.schedule || {};
  const dates = {
    /* What the customer has agreed to buy, when they say they will confirm
       it. `expectedClosingDate` is the same moment asked a different way and
       is a fallback rather than a second answer. */
    ORDER_CONFIRMATION: date(planned.orderConfirmation)
      || date(enquiry.expectedOrderDate) || date(enquiry.expectedClosingDate),
    PROFORMA: date(planned.proforma),
    MATERIAL_COMMITMENT: date(planned.materialCommitment),
    PRODUCTION_START: date(planned.productionStart),
    DISPATCH: date(planned.dispatch),
    BILL_OF_LADING: date(planned.billOfLading),
    INVOICE: date(planned.invoice),
    /* The date the customer said they need the goods — the one delivery date
       an enquiry genuinely holds without anybody scheduling anything. */
    DELIVERY: date(planned.delivery) || date(enquiry.requirementDeadline),
  };

  /* Whatever the caller knows better: an order that has actually shipped
     beats the date somebody expected it to. Unknown keys are ignored rather
     than stored — a date against an event nothing resolves would sit there
     looking answered. */
  for (const [event, value] of Object.entries(extra || {})) {
    if (!PAYMENT_DUE_EVENT_CODES.includes(event) && !EVENTS[event]) continue;
    const parsed = date(value);
    if (parsed) dates[event] = parsed;
  }

  const codes = Object.keys(EVENTS);
  return {
    dates,
    known: codes.filter((e) => dates[e]),
    unknown: codes.filter((e) => !dates[e]),
  };
}

/** What a screen says about an event nobody has dated, and who can fix it. */
function gapFor(event) {
  const known = EVENTS[String(event ?? "").trim()];
  if (!known) {
    return {
      event: String(event ?? ""),
      owner: OWNER.SALES,
      message: "This order has not dated that event yet.",
    };
  }
  return { event: String(event).trim(), owner: known.owner, message: known.missing };
}

const labelFor = (event) => (EVENTS[String(event ?? "").trim()] || {}).label || String(event ?? "");

/** Whole days between two dates, positive when the second is later. */
function daysBetween(from, to) {
  const a = date(from);
  const b = date(to);
  if (!a || !b) return null;
  const DAY = 24 * 60 * 60 * 1000;
  return Math.round((Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate())
    - Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate())) / DAY);
}

/* Every payment event a plan can name must be datable, or a tranche could be
   agreed against something this service can never resolve. */
for (const { code } of PAYMENT_DUE_EVENTS) {
  if (!EVENTS[code]) throw new Error(`orderSchedule: a tranche may be due at ${code}, which no event dates`);
}

module.exports = {
  EVENTS, OWNER, FINANCING_START_EVENTS,
  scheduleFor, gapFor, labelFor, daysBetween,
};
