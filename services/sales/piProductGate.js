// services/sales/piProductGate.js
//
// WHICH PRODUCTS THE PROFORMA INVOICE FORM OFFERS (7 Oct 2026, owner).
//
// The PI form used to offer only the products assigned to the customer AND
// approved by them in Style & Sample (`GET /customers/:id/assigned-items
// ?customerApprovedOnly=1`). The owner asked for that to be a switch:
//
//   SALES_PI_ALL_PRODUCTS unset / 1 / true   → every product in the register
//                                              (the shipped default)
//   SALES_PI_ALL_PRODUCTS=0 / false          → only the customer's approved
//                                              products, as before
//
// It is an environment switch, not a stored setting, read fresh on every call
// so a change needs only a restart. Exposed to the CMS on /api/feature-flags
// as `flag.piAllProducts`.
//
// What it does NOT change: the production release still requires every order
// line to name an approved style (`workOrderStyleLink.service`), because the
// style is how a work order proves which company's product it makes. A line
// raised from a product nobody sampled is invoiced fine and refused at release
// with that rule's own message until its style is linked in Sales.
"use strict";

const OFF = new Set(["0", "false", "no", "off"]);

function piAllProducts() {
  const raw = String(process.env.SALES_PI_ALL_PRODUCTS ?? "").trim().toLowerCase();
  return !OFF.has(raw);
}

module.exports = { piAllProducts };
