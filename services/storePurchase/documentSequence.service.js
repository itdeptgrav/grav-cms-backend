// services/storePurchase/documentSequence.service.js
//
// Store & Purchase — Chunk 1. ONE NUMBER, ONCE.
//
// Chunk 0 catalogued four numbering schemes in this domain and every one of
// them can mint a duplicate under concurrency:
//   · `PO<yy><mm><rand4>` — random, checked for existence, retried ten times
//   · a settings counter read into JS, incremented, and saved back
//   · regex-sort the collection, parse the last number, add one
// None retries on the duplicate-key error that follows, so the loser of a
// race gets a 500 and the user gets nothing.
//
// The fix is not a better retry loop. It is to let the DATABASE do the
// incrementing: one atomic findOneAndUpdate against a unique key.
"use strict";

const SpDocumentSequence = require("../../models/CMS_Models/StorePurchase/SpDocumentSequence");
const { fail } = require("./errors");

/** Server-owned formats. A client never supplies a final number. */
const DOCUMENT_TYPES = Object.freeze({
  PURCHASE_ORDER: { prefix: "PO", pad: 4, perSite: false },
  REQUISITION: { prefix: "REQ", pad: 4, perSite: false },
  GOODS_RECEIPT: { prefix: "GRN", pad: 4, perSite: false },
  STOCK_ISSUE: { prefix: "ISS", pad: 4, perSite: false },
  STOCK_ADJUSTMENT: { prefix: "ADJ", pad: 4, perSite: false },
  SUPPLIER_RETURN: { prefix: "SRT", pad: 4, perSite: false },
  /* Material requests. Company-scoped like the rest: two companies numbering
     their own requests independently is the point, and the old global
     read-last-plus-one could not express that. */
  MATERIAL_REQUEST: { prefix: "MRF", pad: 4, perSite: false },
  /* The Service Master's internal code. A master record is not a document, so
     the financial year in the number reads as "registered in 2026-27" rather
     than as a document date — deliberate, because the alternative is a second
     numbering scheme that races exactly the way this service exists to stop. */
  SERVICE: { prefix: "SVC", pad: 4, perSite: false },
  /* Service ORDERS — the operational document, numbered per company/FY like
     every other. Distinct from the Service master code (`SERVICE`/`SVC`
     above), which is Lane A's and left exactly as it is. */
  SERVICE_ORDER: { prefix: "SVO", pad: 4, perSite: false },
});

/**
 * The Indian financial year a date falls in: April 1 – March 31, rendered
 * "2026-27". The same shape `Acc_Budget.financialYear` already uses, so a
 * number and a budget cycle can be read side by side.
 *
 * The clock is an argument. A sequence that reads `new Date()` internally
 * cannot be tested across a year boundary without moving the machine clock.
 */
function fiscalYearOf(date = new Date()) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) throw fail("VALIDATION", "An invalid date has no financial year.");
  const year = d.getFullYear();
  const month = d.getMonth(); // 0 = January
  const startYear = month >= 3 ? year : year - 1; // April is month 3
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/**
 * Allocate the next number for one key.
 *
 * @returns {Promise<{number: string, sequence: number, fiscalYear: string}>}
 */
async function allocate({ companyId, documentType, at = new Date(), siteId = null, session = null }) {
  if (!companyId) throw fail("VALIDATION", "A document number needs a company.");
  const spec = DOCUMENT_TYPES[documentType];
  if (!spec) throw fail("VALIDATION", `Unknown document type "${documentType}".`);

  const fiscalYear = fiscalYearOf(at);
  /* Site is part of the key only where the type's policy says so — otherwise
     null, so a company-numbered type cannot accidentally fork per site. */
  const keySiteId = spec.perSite ? siteId || null : null;

  const query = { companyId, documentType, fiscalYear, siteId: keySiteId };

  /* THE atomic step. `upsert` creates the counter on first use; `$inc`
     returns a value no other caller can also receive. */
  const doc = await SpDocumentSequence.findOneAndUpdate(
    query,
    { $inc: { next: 1 }, $set: { lastAllocatedAt: new Date(at) } },
    { new: true, upsert: true, setDefaultsOnInsert: true, ...(session ? { session } : {}) },
  );

  const sequence = doc.next;
  return {
    number: format({ documentType, fiscalYear, sequence }),
    sequence,
    fiscalYear,
  };
}

/** Deterministic, server-owned rendering. Grows past the pad rather than
 *  wrapping — a five-digit year is a real sequence, not an error. */
function format({ documentType, fiscalYear, sequence }) {
  const spec = DOCUMENT_TYPES[documentType];
  if (!spec) throw fail("VALIDATION", `Unknown document type "${documentType}".`);
  return `${spec.prefix}/${fiscalYear}/${String(sequence).padStart(spec.pad, "0")}`;
}

/**
 * Read a counter without moving it. For administration screens only — a
 * caller that "peeks" and then writes the number it saw has reinvented the
 * race this service exists to remove.
 */
async function peek({ companyId, documentType, at = new Date(), siteId = null }) {
  const spec = DOCUMENT_TYPES[documentType];
  if (!spec) throw fail("VALIDATION", `Unknown document type "${documentType}".`);
  const fiscalYear = fiscalYearOf(at);
  const doc = await SpDocumentSequence.findOne({
    companyId, documentType, fiscalYear, siteId: spec.perSite ? siteId || null : null,
  }).lean();
  return { fiscalYear, issued: doc?.next || 0 };
}

module.exports = { DOCUMENT_TYPES, fiscalYearOf, allocate, format, peek };
