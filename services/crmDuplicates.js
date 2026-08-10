// services/crmDuplicates.js
//
// "Show possible matches before final save" — the spec's duplicate policy is a
// WARNING, never an auto-merge. These helpers compute candidate matches for an
// account or a contact and label each with WHAT matched and a confidence, so a
// route can surface them and let an authorized user proceed anyway. Pure and
// database-driven so they unit test against an in-memory Mongo.

"use strict";

/** Lowercase, collapse whitespace, drop punctuation — for name comparison. */
function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Bare domain from an email or a URL, else "". */
function domainOf(value) {
  if (!value) return "";
  const v = String(value).trim().toLowerCase();
  const at = v.indexOf("@");
  if (at >= 0) return v.slice(at + 1).replace(/\/.*$/, "");
  return v
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

/** Digits only — so "+91 98765 43210" and "098765-43210" compare equal-ish. */
function normalizePhone(s) {
  const d = String(s || "").replace(/\D+/g, "");
  return d.length > 10 ? d.slice(-10) : d; // last 10 digits ignores country code
}

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Candidate account duplicates. Matches on any of: normalized name, tax/GST or
 * registration number, website/email domain, phone, or external reference.
 * Confidence is "high" for an exact identifier (tax/registration/external ref
 * or exact normalized name), else "medium".
 *
 * @returns {Promise<Array<{_id,accountId,companyName,matchedOn:string[],confidence:string}>>}
 */
async function findAccountDuplicates(Account, candidate = {}, excludeId = null) {
  const name = normalizeName(candidate.companyName || candidate.displayName);
  const domain = domainOf(candidate.website) || domainOf(candidate.primaryEmail);
  const phone = normalizePhone(candidate.primaryPhone);
  const tax = String(candidate.gstNumber || candidate.taxRegistrationNumber || "").trim();
  const reg = String(candidate.registrationNumber || "").trim();
  const ext = String(candidate.externalReference || "").trim();

  const or = [];
  if (name) or.push({ normalizedName: name });
  if (tax) or.push({ gstNumber: tax }, { taxRegistrationNumber: tax });
  if (reg) or.push({ registrationNumber: reg });
  if (ext) or.push({ externalReference: ext });
  if (phone) or.push({ primaryPhone: new RegExp(esc(phone) + "$") });
  if (domain) {
    or.push({ website: new RegExp(esc(domain), "i") }, { primaryEmail: new RegExp("@" + esc(domain) + "$", "i") });
  }
  if (!or.length) return [];

  const query = { $or: or };
  if (excludeId) query._id = { $ne: excludeId };

  const rows = await Account.find(query)
    .select("accountId companyName displayName normalizedName website primaryEmail primaryPhone gstNumber taxRegistrationNumber registrationNumber externalReference")
    .limit(25)
    .lean();

  return rows.map((r) => {
    const matchedOn = [];
    if (name && r.normalizedName === name) matchedOn.push("name");
    if (tax && (r.gstNumber === tax || r.taxRegistrationNumber === tax)) matchedOn.push("tax number");
    if (reg && r.registrationNumber === reg) matchedOn.push("registration number");
    if (ext && r.externalReference === ext) matchedOn.push("external reference");
    if (phone && normalizePhone(r.primaryPhone) === phone) matchedOn.push("phone");
    if (domain && (domainOf(r.website) === domain || domainOf(r.primaryEmail) === domain)) matchedOn.push("domain");
    const strong = matchedOn.some((m) => ["tax number", "registration number", "external reference"].includes(m)) || matchedOn.includes("name");
    return {
      _id: r._id,
      accountId: r.accountId,
      companyName: r.companyName,
      matchedOn,
      confidence: strong ? "high" : "medium",
    };
  }).filter((m) => m.matchedOn.length > 0);
}

/**
 * Candidate contact duplicates. Email is a WARNING not a block (shared/agency
 * mailboxes legitimately repeat), so we match on email, phone/mobile, or the
 * normalized name within the same account.
 */
async function findContactDuplicates(Contact, candidate = {}, excludeId = null) {
  const email = String(candidate.email || "").trim().toLowerCase();
  const phone = normalizePhone(candidate.mobile || candidate.phone);
  const name = normalizeName(`${candidate.firstName || ""} ${candidate.lastName || ""}`);

  const or = [];
  if (email) or.push({ email });
  if (phone) {
    or.push({ phone: new RegExp(esc(phone) + "$") }, { mobile: new RegExp(esc(phone) + "$") });
  }
  if (name && candidate.accountId) or.push({ normalizedName: name, accountId: candidate.accountId });
  if (!or.length) return [];

  const query = { $or: or };
  if (excludeId) query._id = { $ne: excludeId };

  const rows = await Contact.find(query)
    .select("contactId firstName lastName email phone mobile normalizedName accountId")
    .limit(25)
    .lean();

  return rows.map((r) => {
    const matchedOn = [];
    if (email && r.email === email) matchedOn.push("email");
    if (phone && (normalizePhone(r.phone) === phone || normalizePhone(r.mobile) === phone)) matchedOn.push("phone");
    if (name && r.normalizedName === name) matchedOn.push("name");
    return {
      _id: r._id,
      contactId: r.contactId,
      name: `${r.firstName || ""} ${r.lastName || ""}`.trim(),
      email: r.email,
      matchedOn,
      confidence: matchedOn.includes("email") ? "high" : "medium",
    };
  }).filter((m) => m.matchedOn.length > 0);
}

/**
 * Candidate LEAD duplicates (Lead Capture chunk — §6 of the task). Matches
 * on the Lead model's own pre-save-computed normalized fields
 * (normalizedCompany/normalizedPhone/emailDomain/websiteDomain — see
 * models/CMS_Models/Sales/Lead.js), using ITS static normalizers
 * (Lead.normalizeCompany/normalizeEmailDomain/normalizeWebsiteDomain) to
 * normalize the candidate — NOT this file's own normalizeName/domainOf,
 * which are tuned for CRMAccount/CRMContact's differently-shaped stored
 * fields and do not produce the same output. Matching against the wrong
 * normalizer silently returns zero results instead of an error, so company/
 * email/domain stay an EXACT comparison against exactly what Lead's own
 * pre-save hook stores.
 *
 * Phone is the one signal that stays a SUFFIX match rather than exact:
 * Lead's own normalizedPhone keeps whatever digits were typed (it does not
 * strip a country code — see models/CMS_Models/Sales/Lead.js), so
 * "9876543210" and "+91 98765 43210" store as "9876543210" and
 * "919876543210" respectively. Comparing the last 10 digits catches that
 * without changing what Lead.js itself stores for existing records.
 *
 * Confidence is "high" for an exact email or phone match (the two
 * identifiers that most reliably mean "same person/desk"), else "medium" for
 * a company/domain-only match — deliberately softer than
 * findAccountDuplicates's name-match confidence, since a common company name
 * with no other signal is a much weaker duplicate hint at Lead-capture time.
 *
 * @returns {Promise<Array<{_id,leadId,name,company,qualificationState,assignedToName,matchedOn:string[],confidence:string}>>}
 */
async function findLeadDuplicates(Lead, candidate = {}, excludeId = null) {
  const company = Lead.normalizeCompany(candidate.company);
  const phoneDigits = Lead.normalizePhoneDigits(candidate.phone);
  const phone = phoneDigits.length > 10 ? phoneDigits.slice(-10) : phoneDigits;
  const email = String(candidate.email || "").trim().toLowerCase();
  const domain = Lead.normalizeWebsiteDomain(candidate.website) || Lead.normalizeEmailDomain(candidate.email);

  const or = [];
  if (company) or.push({ normalizedCompany: company });
  if (phone) or.push({ normalizedPhone: new RegExp(esc(phone) + "$") });
  if (email) or.push({ email });
  if (domain) or.push({ emailDomain: domain }, { websiteDomain: domain });
  if (!or.length) return [];

  const query = { $or: or, isActive: true };
  if (excludeId) query._id = { $ne: excludeId };

  const rows = await Lead.find(query)
    .select("leadId firstName lastName company email phone normalizedCompany emailDomain normalizedPhone websiteDomain qualificationState assignedToName")
    .limit(25)
    .lean();

  return rows.map((r) => {
    const matchedOn = [];
    if (email && r.email === email) matchedOn.push("email");
    if (phone && r.normalizedPhone && r.normalizedPhone.endsWith(phone)) matchedOn.push("phone");
    if (company && r.normalizedCompany === company) matchedOn.push("company");
    if (domain && (r.emailDomain === domain || r.websiteDomain === domain)) matchedOn.push("domain");
    const strong = matchedOn.includes("email") || matchedOn.includes("phone");
    return {
      _id: r._id,
      leadId: r.leadId,
      name: `${r.firstName || ""} ${r.lastName || ""}`.trim(),
      company: r.company,
      qualificationState: r.qualificationState,
      assignedToName: r.assignedToName,
      matchedOn,
      confidence: strong ? "high" : "medium",
    };
  }).filter((m) => m.matchedOn.length > 0);
}

module.exports = {
  normalizeName,
  domainOf,
  normalizePhone,
  findAccountDuplicates,
  findContactDuplicates,
  findLeadDuplicates,
};
