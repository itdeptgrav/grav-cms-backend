// services/merchandising/departmentStatus.contract.js
//
// WHAT EACH DEPARTMENT IS ALLOWED TO SAY ABOUT ITSELF, AND NOTHING ELSE.
//
// One frozen map. A status code outside its department's list is refused at
// intake and recorded as a NOOP with the reason — never stored as free text.
//
// ── WHY AN ALLOWLIST AND NOT A FREE STRING ──────────────────────────────────
// A projection is another application's statement travelling into a screen
// Merchandising renders. If the wire could carry any string, the register
// would display whatever a producer happened to send — a typo, a debug value,
// a sentence — with Merchandising's chrome around it, and a reader would
// reasonably take it as vetted. The list is the vetting, and it is the only
// vetting: Merchandising does not translate, rank or interpret these values.
//
// ── THESE ARE STATUS NAMES, NOT PERMISSIONS ─────────────────────────────────
// `RELEASED_TO_PRODUCTION` in this file is Merchandising OBSERVING that PPC
// said so. It is not Merchandising releasing anything, and there is no route
// anywhere in this module that writes one of these values. The absence is the
// guarantee; the list is only what may be displayed once somebody else says it.
//
// ── AND WHY THE FOUR AVAILABILITY STATES ARE HERE TOO ───────────────────────
// "Not reported" is a real answer, and it has to be a different answer from
// "reported as nothing", "the source app does not talk to us", and "this
// department does not apply to this order". Collapsing them produces the one
// thing the plan forbids: guessed readiness. A blank cell reads as fine; a
// zero reads as measured; a green tick reads as approved. None of those is
// what silence means.
"use strict";

/** The eight source departments. Merchandising is not one — it is the reader. */
const DEPARTMENT = Object.freeze({
  PRODUCT_DEVELOPMENT: "PRODUCT_DEVELOPMENT",
  SUPPLY_CHAIN: "SUPPLY_CHAIN",
  STORE: "STORE",
  IE: "IE",
  PPC: "PPC",
  QUALITY: "QUALITY",
  PRODUCTION: "PRODUCTION",
  LOGISTICS: "LOGISTICS",
});

const DEPARTMENTS = Object.freeze(Object.values(DEPARTMENT));

/** How each department is named on a screen and in a refusal — one vocabulary. */
const DEPARTMENT_WORDS = Object.freeze({
  PRODUCT_DEVELOPMENT: "Product Development",
  SUPPLY_CHAIN: "Supply Chain",
  STORE: "Store",
  IE: "Industrial Engineering",
  PPC: "PPC",
  QUALITY: "Quality",
  PRODUCTION: "Production",
  LOGISTICS: "Logistics",
});

/**
 * The four honest answers to "what does this department say".
 *
 * `UNKNOWN` is the DEFAULT for every department with no row — see the header.
 */
const AVAILABILITY = Object.freeze({
  AVAILABLE: "AVAILABLE",
  UNKNOWN: "UNKNOWN",
  UNAVAILABLE: "UNAVAILABLE",
  NOT_APPLICABLE: "NOT_APPLICABLE",
});

/**
 * The sentence each availability state renders as when there is no status.
 *
 * Written here rather than on the screen so the API and the UI cannot drift
 * into saying different things about the same silence, and so a second client
 * gets the honest wording for free.
 */
function availabilitySentence(department, availability) {
  const who = DEPARTMENT_WORDS[department] || department;
  if (availability === AVAILABILITY.UNKNOWN) return `Not yet reported by ${who}`;
  if (availability === AVAILABILITY.UNAVAILABLE) return `${who} is not reporting to Merchandising yet`;
  if (availability === AVAILABILITY.NOT_APPLICABLE) return "Not applicable";
  return "";
}

/* ── THE ALLOWLIST ────────────────────────────────────────────────────────── */

const ALLOWED_STATUS = Object.freeze({
  PRODUCT_DEVELOPMENT: Object.freeze([
    "TECHPACK_ISSUED", "PATTERN_READY", "SAMPLE_IN_PROGRESS",
    "SAMPLE_SUBMITTED", "SAMPLE_APPROVED", "SAMPLE_REJECTED",
  ]),
  SUPPLY_CHAIN: Object.freeze([
    "SOURCING_STARTED", "PO_PLACED", "SUPPLIER_CONFIRMED", "IN_TRANSIT", "SOURCING_BLOCKED",
  ]),
  STORE: Object.freeze([
    "AWAITING_RECEIPT", "PARTIALLY_RECEIVED", "RECEIVED", "ISSUED", "SHORTAGE_RECORDED",
  ]),
  IE: Object.freeze(["ROUTE_DRAFT", "ROUTE_RELEASED", "SAM_PUBLISHED"]),
  PPC: Object.freeze(["PLAN_PENDING", "CAPACITY_BOOKED", "LINE_ALLOCATED", "RELEASED_TO_PRODUCTION"]),
  QUALITY: Object.freeze([
    "TEST_PENDING", "TEST_PASSED", "TEST_FAILED",
    "INSPECTION_PASSED", "INSPECTION_FAILED", "ON_HOLD",
  ]),
  PRODUCTION: Object.freeze(["NOT_STARTED", "CUTTING", "SEWING", "FINISHING", "COMPLETED"]),
  LOGISTICS: Object.freeze(["BOOKING_PENDING", "BOOKED", "DOCUMENTS_READY", "DISPATCHED"]),
});

const isDepartment = (d) => DEPARTMENTS.includes(String(d ?? "").trim().toUpperCase());

const isAllowedStatus = (department, statusCode) => Boolean(
  ALLOWED_STATUS[String(department ?? "").trim().toUpperCase()]
    ?.includes(String(statusCode ?? "").trim().toUpperCase()),
);

/* ── WHICH EVENT COMES FROM WHICH DEPARTMENT ──────────────────────────────
   The receiver's whole routing table. A kind that is not here is not
   consumed — Merchandising listens to a declared list, never to whatever
   arrives, so a new producer cannot start writing into this register by
   choosing a name. */
const SOURCE_EVENT = Object.freeze({
  "product_development.sample.status_changed": DEPARTMENT.PRODUCT_DEVELOPMENT,
  "supply_chain.sourcing.status_changed": DEPARTMENT.SUPPLY_CHAIN,
  "store.material.status_changed": DEPARTMENT.STORE,
  "ie.route.released": DEPARTMENT.IE,
  "ppc.plan.status_changed": DEPARTMENT.PPC,
  "quality.result.recorded": DEPARTMENT.QUALITY,
  "production.progress.recorded": DEPARTMENT.PRODUCTION,
  "logistics.shipment.status_changed": DEPARTMENT.LOGISTICS,
});

const CONSUMED_KINDS = Object.freeze(Object.keys(SOURCE_EVENT));
const departmentForKind = (kind) => SOURCE_EVENT[String(kind ?? "").trim()] || null;

/* ── WHICH APPS ACTUALLY REPORT TODAY ─────────────────────────────────────
   NONE of them. No application in this repository publishes any of the eight
   kinds above yet, so every department reads `UNKNOWN` until one does — and
   `UNKNOWN` is displayed as "Not yet reported by <department>", which is the
   truth rather than a gap.
   
   This list is what separates UNKNOWN from UNAVAILABLE. A department in it is
   expected to report and has not; a department outside it has no integration
   at all, and saying "not yet reported" about an app that cannot report would
   suggest somebody is late when nobody is.

   Deliberately empty, and deliberately not a guess: add a slug here in the
   same change that makes that app publish, never in advance. */
const REPORTING_APPS = Object.freeze([]);

/**
 * Whether a department is expected to report at all.
 *
 * Every department is EXPECTED (so its silence is `UNKNOWN`, a thing somebody
 * can chase) but none is INTEGRATED yet (so its silence is `UNAVAILABLE`, a
 * thing nobody can chase). Both sentences are written above; this decides
 * which one a reader is told.
 */
const isIntegrated = (department) => REPORTING_APPS.includes(String(department ?? "").toUpperCase());

/* ── FRESHNESS ────────────────────────────────────────────────────────────
   Derived at read time, never stored: a stored freshness would be wrong the
   day after it was written. */
const FRESHNESS = Object.freeze({ FRESH: "FRESH", AGEING: "AGEING", STALE: "STALE" });
const FRESH_DAYS = 3;
const AGEING_DAYS = 14;

/**
 * How old a source's statement is, in whole days.
 *
 * `STALE` is DISPLAYED, never acted on. A stale status is still the source's
 * status — Merchandising does not expire another department's fact, and a row
 * that quietly reverted to "unknown" after a fortnight would be Merchandising
 * deciding the statement had stopped being true.
 */
function freshnessOf(observedAt, now = new Date()) {
  if (!observedAt) return null;
  const then = new Date(observedAt);
  if (Number.isNaN(then.getTime())) return null;
  const days = Math.floor((now.getTime() - then.getTime()) / 86400000);
  if (days <= FRESH_DAYS) return FRESHNESS.FRESH;
  if (days <= AGEING_DAYS) return FRESHNESS.AGEING;
  return FRESHNESS.STALE;
}

module.exports = {
  DEPARTMENT, DEPARTMENTS, DEPARTMENT_WORDS,
  AVAILABILITY, availabilitySentence,
  ALLOWED_STATUS, isDepartment, isAllowedStatus,
  SOURCE_EVENT, CONSUMED_KINDS, departmentForKind,
  REPORTING_APPS, isIntegrated,
  FRESHNESS, FRESH_DAYS, AGEING_DAYS, freshnessOf,
};
