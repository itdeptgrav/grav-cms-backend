// services/customerRequestPo.js
//
// THE CUSTOMER'S PO NUMBER, READ AND WRITTEN IN ONE PLACE (26 Sep 2026).
//
// Sales records the customer's purchase order on the QUOTATION it approves:
// `quotations[].poProof.{poNumber, poDate, poValue, url…}`, written when the
// PO document is uploaded. There is no `poProof` at the root of a
// CustomerRequest — yet Packaging's carton label, the carton list, the carton
// report and the dispatch overview all read `mo.poProof.poNumber` at the
// root, so they printed "not recorded" even for an order whose PO Sales had
// filed. PPC read the quotation and was right. One reader now, and one
// writer, so that a PO recorded here (PPC's "Record PO" on the order) lands
// exactly where Sales' upload would have put it and every screen agrees.

"use strict";

/** The fields a query must select for `poOf` to answer. */
const PO_SELECT = "quotations.poProof quotations.quotationNumber quotations.salesApproval quotations.status poProof";

/** The PO from wherever Sales put it: the quotation that carries one first,
 *  then a root-level copy (older records), else blanks. */
function poOf(mo) {
  const qs = [...(mo?.quotations || [])];
  const withPo = qs.find((q) => q?.poProof?.poNumber) || null;
  const q = withPo || qs.find((q) => q?.salesApproval?.approvedAt) || qs[0] || null;
  const root = mo?.poProof || null;
  const src = withPo?.poProof || (root?.poNumber ? root : null);
  return {
    poNumber: String(src?.poNumber || "").trim(),
    poDate: src?.poDate || null,
    poValue: src?.poValue ?? null,
    poUrl: src?.url || "",
    quotationNumber: q?.quotationNumber || "",
    salesApprovedAt: q?.salesApproval?.approvedAt || null,
  };
}

/**
 * Record (or correct, or clear with "") the PO number on a CustomerRequest
 * DOCUMENT (not lean). It goes on the quotation Sales approved, else the
 * latest quotation, else the root — the same place the upload writes, so the
 * PO document itself can still be attached there later.
 */
function recordPo(mo, { poNumber, poDate = null, poValue = null }) {
  const number = String(poNumber || "").trim().slice(0, 80);
  const qs = mo.quotations || [];
  const target = qs.find((q) => q?.poProof?.poNumber) || qs.find((q) => q?.salesApproval?.approvedAt) || qs[qs.length - 1] || null;
  const proof = target ? (target.poProof || (target.poProof = {})) : (mo.poProof || (mo.poProof = {}));
  proof.poNumber = number;
  if (poDate !== undefined) proof.poDate = poDate ? new Date(poDate) : null;
  if (poValue !== undefined && poValue !== null && poValue !== "") proof.poValue = Number(poValue);
  if (target) mo.markModified("quotations"); else mo.markModified("poProof");
  return { poNumber: number, on: target ? target.quotationNumber || "quotation" : "order" };
}

module.exports = { PO_SELECT, poOf, recordPo };
