"use strict";

const Vendor = require("../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const { includesTerm } = require("./ai/semanticCatalogue");
const { FIELD_CONTRACT } = require("./storeSupplierContract");
const tenantContext = require("./storePurchase/tenantContext.service");

const IDENTITY_PROJECTION = "companyName supplierCode email phone alternatePhone contactPerson gstNumber";

function identityTerms(supplier) {
  return [
    supplier.supplierCode,
    supplier.gstNumber,
    supplier.email,
    supplier.phone,
    supplier.alternatePhone,
    supplier.companyName,
    supplier.contactPerson,
  ].filter((value) => String(value || "").trim());
}

async function resolveSupplier({ user, message }) {
  const ctx = user?.storePurchaseAccess;
  if (!ctx?.companyId) return { found: false, ambiguous: false, matches: [] };
  const filter = tenantContext.tenantFilter(ctx);
  const winners = [];
  let longest = 0;
  const cursor = Vendor.find(filter).select(IDENTITY_PROJECTION).lean().cursor();
  for await (const supplier of cursor) {
    const matches = identityTerms(supplier).filter((term) => includesTerm(message, term));
    if (!matches.length) continue;
    const length = Math.max(...matches.map((term) => String(term).length));
    if (length > longest) {
      longest = length;
      winners.length = 0;
      winners.push(supplier);
    } else if (length === longest) {
      winners.push(supplier);
    }
  }
  if (!winners.length) return { found: false, ambiguous: false, matches: [] };
  if (winners.length !== 1) {
    return {
      found: false,
      ambiguous: true,
      matches: winners.slice(0, 5).map((row) => ({ companyName: row.companyName, supplierCode: row.supplierCode })),
    };
  }
  const record = await Vendor.findOne({ $and: [filter, { _id: winners[0]._id }] })
    .select(FIELD_CONTRACT.projection())
    .lean();
  if (!record) return { found: false, ambiguous: false, matches: [] };
  return { found: true, ambiguous: false, record };
}

module.exports = { resolveSupplier };
