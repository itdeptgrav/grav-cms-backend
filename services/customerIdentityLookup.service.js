"use strict";
// services/customerIdentityLookup.service.js
//
// Extracted out of routes/CMS_Routes/Sales/callRecordings.js (21 Aug 2026) so
// the new call-events route can reuse it without duplicating ~60 lines — DB
// access on purpose, unlike services/callRecordingMatch.service.js, which
// stays pure by design (its own header comment explains why: models/CallEvent.js
// requires `phoneKey` from it, so a require back into a model-touching file
// would cycle). This file has no such constraint.

const Account = require("../models/CMS_Models/Sales/Account");
const Contact = require("../models/CMS_Models/Sales/Contact");
const Customer = require("../models/Customer_Models/Customer");
const Lead = require("../models/CMS_Models/Sales/Lead");

/**
 * Collect every phone number and name that identifies a customer, from any
 * of the three "customer" models Sales runs on:
 *
 *   • CRMAccount   — the organisation (Customer Hub). Its own numbers, plus
 *                    every contact person at it, because the call almost always
 *                    goes to a person, not to a company switchboard.
 *   • Customer     — the portal/e-commerce account.
 *   • Lead         — a Prospect/Active Lead, before it is anything else. Its
 *                    own phone/whatsapp plus every stakeholder in `contacts[]`
 *                    — a lead often has more than one number on file before it
 *                    converts to an Account with real Contacts.
 *
 * Returns null when the id resolves to nothing.
 */
async function identityFor({ accountId, customerId, leadId }) {
  if (leadId) {
    const lead = await Lead.findById(leadId)
      .select("company firstName lastName phone whatsapp contacts")
      .lean();
    if (!lead) return null;

    const personName = [lead.firstName, lead.lastName].filter(Boolean).join(" ");
    return {
      label: lead.company || personName || "This lead",
      phones: [
        lead.phone,
        lead.whatsapp,
        ...(lead.contacts || []).map((c) => c.phone),
      ],
      names: [lead.company],
      // "whole phrase only" — a stakeholder's first name alone is not a safe match key.
      personNames: [personName, ...(lead.contacts || []).map((c) => c.name)],
    };
  }

  if (accountId) {
    const account = await Account.findById(accountId)
      .select("companyName displayName legalName brandName primaryPhone alternatePhone")
      .lean();
    if (!account) return null;

    const contacts = await Contact.find({ accountId })
      .select("firstName lastName phone mobile whatsapp alternatePhone")
      .lean();

    return {
      label: account.displayName || account.companyName,
      phones: [
        account.primaryPhone,
        account.alternatePhone,
        ...contacts.flatMap((c) => [c.phone, c.mobile, c.whatsapp, c.alternatePhone]),
      ],
      names: [account.companyName, account.displayName, account.legalName, account.brandName],
      // Kept apart from the org names: a person's name is matched only as a
      // whole phrase, never by its leading word. "Rahul" is not an identity.
      personNames: contacts.map((c) => [c.firstName, c.lastName].filter(Boolean).join(" ")),
    };
  }

  const customer = await Customer.findById(customerId)
    .select("name phone alternatePhone profile.companyName")
    .lean();
  if (!customer) return null;

  return {
    label: customer.name,
    phones: [customer.phone, customer.alternatePhone],
    names: [customer.name, customer.profile?.companyName],
    personNames: [],
  };
}

module.exports = { identityFor };
