// services/houseSamplingCustomer.service.js
//
// THE STANDING "GRAV SAMPLING ORDER" ACCOUNT.
//
// An in-house sample has no customer. But everything downstream of an approved
// sample — the production run, the Manufacturing Order, the work orders — is
// built on `CustomerRequest`, and that requires a real `Customer` document
// (`sampleStyles.js`'s production/submit refuses without one). So sampling
// borrows a single standing house account rather than inventing a throwaway
// customer per sample, which would fill the Customers list with noise and make
// "how many customers do we have" a meaningless number.
//
// Explicit request, 31 Aug 2026: "the customer company name and all you can put
// as like Grav Sampling Order.. (so if not created the customer account then
// create or else just use that)".
//
// ── WHAT THIS DELIBERATELY IS NOT ────────────────────────────────────────
// It is NOT a login. The account is created with no password and
// `isActive: false`, so nothing about it can be used to sign in to the customer
// portal. It exists to satisfy a foreign key and to give the sampling orders a
// consistent, recognisable name on every screen — not to represent a person.
//
// ── IDENTITY ─────────────────────────────────────────────────────────────
// The email from Sales Settings is the identity key: it is the field the sales
// customer routes already treat as unique, and the one a DB-level unique index
// is most likely to exist on. Look-up is by email, so:
//   • changing the NAME or PHONE in settings updates the existing account
//   • changing the EMAIL points sampling at a different account, leaving the
//     old one (and every order already attached to it) untouched
// That second behaviour is intentional — rewriting the email in place would
// silently re-label every historical sampling order.
"use strict";

const Customer = require("../models/Customer_Models/Customer");
const SalesSettings = require("../models/CMS_Models/Sales/SalesSettings");

/** Fall back to the schema defaults if settings has never been saved. */
const DEFAULTS = {
  name: "Grav Sampling Order",
  email: "sampling@grav.in",
  phone: "0000000000",
  address: "In-house sampling — no customer address",
  city: "Bhubaneswar",
  postalCode: "",
};

/** The configured identity, with every blank healed to its default. */
async function houseCustomerConfig() {
  let cfg = {};
  try {
    const settings = await SalesSettings.findOne({}).select("houseSamplingCustomer").lean();
    cfg = settings?.houseSamplingCustomer || {};
  } catch {
    /* Settings unreadable — the defaults below still give a working account. */
  }
  const out = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    const set = String(cfg[k] ?? "").trim();
    out[k] = set || v;
  }
  out.email = out.email.toLowerCase();
  return out;
}

/**
 * The house sampling Customer, created on first use.
 *
 * @returns {Promise<object>} a Customer mongoose document
 */
async function resolveHouseSamplingCustomer() {
  const cfg = await houseCustomerConfig();

  const existing = await Customer.findOne({ email: cfg.email });
  if (existing) {
    // Keep the display fields in step with settings, so renaming the house
    // account in Sales Settings actually shows up on the MO screens. The email
    // is NOT rewritten here — it is the identity we just looked up by.
    let dirty = false;
    for (const k of ["name", "phone", "address", "city", "postalCode"]) {
      if (cfg[k] && existing[k] !== cfg[k]) { existing[k] = cfg[k]; dirty = true; }
    }
    if (dirty) await existing.save();
    return existing;
  }

  try {
    return await Customer.create({
      name: cfg.name,
      email: cfg.email,
      phone: cfg.phone,
      address: cfg.address,
      city: cfg.city,
      postalCode: cfg.postalCode,
      // Not a login — see the header. No password is set at all.
      isActive: false,
      isEmailVerified: false,
      createdBySales: true,
      leadSource: "sales_created",
    });
  } catch (err) {
    // Two samples submitted at once both missed the find and raced to create.
    // The unique index refused the loser, whose document now certainly exists.
    if (err?.code === 11000) {
      const won = await Customer.findOne({ email: cfg.email });
      if (won) return won;
    }
    throw err;
  }
}

module.exports = { resolveHouseSamplingCustomer, houseCustomerConfig, HOUSE_CUSTOMER_DEFAULTS: DEFAULTS };
