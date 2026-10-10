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

function envAllProducts() {
  const raw = String(process.env.SALES_PI_ALL_PRODUCTS ?? "").trim().toLowerCase();
  return !OFF.has(raw);
}

/* ── A STORED SETTING SINCE 8 Oct 2026 (owner) ─────────────────────────────
   `SalesSettings.piProductScope` ("all" | "approved") is set on the Sales
   settings page and wins; the environment switch stands only while the
   setting is absent. Cached for a few seconds — the flags endpoint is hit on
   every page paint. */
const CACHE_MS = 5000;
let cached = { at: 0, value: null };
async function piAllProducts() {
  if (Date.now() - cached.at < CACHE_MS && cached.value !== null) return cached.value;
  let value = envAllProducts();
  try {
    const SalesSettings = require("../../models/CMS_Models/Sales/SalesSettings");
    const s = await SalesSettings.findOne().select("piProductScope").lean();
    if (s?.piProductScope === "approved") value = false;
    else if (s?.piProductScope === "all") value = true;
  } catch (err) {
    console.error("[piProductGate] settings read failed, using the environment:", err?.message || err);
  }
  cached = { at: Date.now(), value };
  return value;
}
const forget = () => { cached = { at: 0, value: null }; };

module.exports = { piAllProducts, envAllProducts, forgetPiProductScope: forget };
