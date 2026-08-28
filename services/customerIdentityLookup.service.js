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
 * Normalise a list of email addresses into match keys (27 Aug 2026, for Gmail
 * thread matching).
 *
 * Lowercased and de-duplicated, because the same address is stored with
 * whatever capitalisation somebody typed, while Gmail reports its own. The
 * `Name <addr@x.com>` form is unwrapped too — that shape reaches us from mail
 * headers, and comparing a display-name-wrapped address against a bare one
 * silently never matches.
 *
 * Deliberately NOT doing gmail-style dot/plus normalisation: that is correct
 * for @gmail.com and wrong for most corporate domains, so applying it
 * everywhere would merge two genuinely different people at the same company.
 */
const emailsOf = (list) => [
  ...new Set(
    (list || [])
      .map((e) => {
        const raw = String(e || "").trim().toLowerCase();
        const angled = raw.match(/<([^>]+)>/);
        return (angled ? angled[1] : raw).trim();
      })
      .filter((e) => e.includes("@")),
  ),
];

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
      .select("company firstName lastName phone whatsapp email contacts")
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
      // Added 27 Aug 2026 for Gmail matching, alongside the phones this has
      // always returned. Same principle: the lead's own address PLUS every
      // stakeholder's, because a thread usually runs with a person at the
      // company rather than a generic company mailbox. Normalised and
      // de-duplicated by emailsOf() below, so callers get clean match keys.
      emails: emailsOf([lead.email, ...(lead.contacts || []).map((c) => c.email)]),
      names: [lead.company],
      // "whole phrase only" — a stakeholder's first name alone is not a safe match key.
      personNames: [personName, ...(lead.contacts || []).map((c) => c.name)],
    };
  }

  if (accountId) {
    const account = await Account.findById(accountId)
      .select("companyName displayName legalName brandName primaryPhone alternatePhone primaryEmail")
      .lean();
    if (!account) return null;

    const contacts = await Contact.find({ accountId })
      .select("firstName lastName phone mobile whatsapp alternatePhone email")
      .lean();

    return {
      label: account.displayName || account.companyName,
      phones: [
        account.primaryPhone,
        account.alternatePhone,
        ...contacts.flatMap((c) => [c.phone, c.mobile, c.whatsapp, c.alternatePhone]),
      ],
      emails: emailsOf([account.primaryEmail, ...contacts.map((c) => c.email)]),
      names: [account.companyName, account.displayName, account.legalName, account.brandName],
      // Kept apart from the org names: a person's name is matched only as a
      // whole phrase, never by its leading word. "Rahul" is not an identity.
      personNames: contacts.map((c) => [c.firstName, c.lastName].filter(Boolean).join(" ")),
    };
  }

  const customer = await Customer.findById(customerId)
    .select("name phone alternatePhone email profile.companyName")
    .lean();
  if (!customer) return null;

  return {
    label: customer.name,
    phones: [customer.phone, customer.alternatePhone],
    emails: emailsOf([customer.email]),
    names: [customer.name, customer.profile?.companyName],
    personNames: [],
  };
}

module.exports = { identityFor, emailsOf };
