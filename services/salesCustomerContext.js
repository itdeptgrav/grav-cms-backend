"use strict";

const Customer = require("../models/Customer_Models/Customer");
const { scopedFilter } = require("./companyContext/salesScope.service");
const { includesTerm } = require("./ai/semanticCatalogue");
const { FIELD_CONTRACT } = require("./salesCustomerContract");

const IDENTITY_PROJECTION = "name customerId email phone alternatePhone profile.companyName";

function identityTerms(customer) {
  return [
    customer.customerId,
    customer.email,
    customer.phone,
    customer.alternatePhone,
    customer.name,
    customer.profile?.companyName,
  ].filter((value) => String(value || "").trim());
}

async function resolveCustomer({ user, message }) {
  const req = { user };
  const filter = await scopedFilter(req, {});
  const winners = [];
  let longest = 0;
  const cursor = Customer.find(filter).select(IDENTITY_PROJECTION).lean().cursor();
  for await (const customer of cursor) {
    const matches = identityTerms(customer).filter((term) => includesTerm(message, term));
    if (!matches.length) continue;
    const length = Math.max(...matches.map((term) => String(term).length));
    if (length > longest) {
      longest = length;
      winners.length = 0;
      winners.push(customer);
    } else if (length === longest) {
      winners.push(customer);
    }
  }
  if (!winners.length) return { found: false, ambiguous: false, matches: [] };
  if (winners.length !== 1) {
    return {
      found: false,
      ambiguous: true,
      matches: winners.slice(0, 5).map((row) => ({ name: row.name, customerId: row.customerId })),
    };
  }
  const record = await Customer.findOne(await scopedFilter(req, { _id: winners[0]._id }))
    .select(FIELD_CONTRACT.projection())
    .lean();
  if (!record) return { found: false, ambiguous: false, matches: [] };
  return { found: true, ambiguous: false, record };
}

module.exports = { resolveCustomer };
