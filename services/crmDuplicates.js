// services/crmDuplicates.js
//
// "Show possible matches before final save" — the spec's duplicate policy is a
// WARNING, never an auto-merge. These helpers compute candidate matches for an
// account or a contact and label each with WHAT matched and a confidence, so a
// route can surface them and let an authorized user proceed anyway. Pure and
// database-driven so they unit test against an in-memory Mongo.

"use strict";

/* ── DUPLICATE DETECTION COMPARES WITHIN ONE COMPANY ────────────────────────
 * These helpers take the model as a parameter (they are unit-tested against an
 * in-memory Mongo) and now also take a service context. Matching across
 * companies would answer "is this a duplicate?" by revealing that ANOTHER
 * company has a customer with the same name, phone or GST number — which is
 * the disclosure, not the answer. */
const { serviceFilter } = require("./companyContext/serviceScope.service");

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
async function findAccountDuplicates(Account, ctx, candidate = {}, excludeId = null) {
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

  // `isActive: { $ne: false }` rather than `=== true`: accounts created before
  // the flag existed have no such field, and an exact match would hide them.
  const query = { $or: or, isActive: { $ne: false } };
  if (excludeId) query._id = { $ne: excludeId };

  const rows = await Account.find(serviceFilter(ctx, query))
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
async function findContactDuplicates(Contact, ctx, candidate = {}, excludeId = null) {
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

  const rows = await Contact.find(serviceFilter(ctx, query))
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
async function findLeadDuplicates(Lead, ctx, candidate = {}, excludeId = null) {
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

  const rows = await Lead.find(serviceFilter(ctx, query))
    .select("leadId firstName lastName company email phone normalizedCompany emailDomain normalizedPhone websiteDomain qualificationState assignedToName captureStatus")
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
      /* Carried so callers can route to the right screen — a Lead still in
         capture lives at /prospects, not /leads. Without it the unified path
         sent every company-name match to the Lead screen. */
      captureStatus: r.captureStatus,
      assignedToName: r.assignedToName,
      matchedOn,
      confidence: strong ? "high" : "medium",
    };
  }).filter((m) => m.matchedOn.length > 0);
}


/* ══ EVERY PERSON ON A PROSPECT, NOT JUST THE MIRRORED ONE ═════════════════
 * `findLeadDuplicates` matches the Lead's top-level identity, which is the
 * PRIMARY contact's mirror. A Prospect with four people on it therefore had
 * three of them invisible to duplicate detection — the merchandiser could
 * already exist on another Lead, or as a real Contact under an Account, and
 * nothing said so.
 *
 * This checks each embedded contact against three collections and reports
 * WHICH of our people matched WHICH existing record, on WHICH identity. A
 * flattened record-level "possible duplicate" cannot be acted on: the useful
 * sentence is "Ramesh Sharma's phone matches LEAD-2026-0042", not "this
 * Prospect may be a duplicate".
 *
 * ── BOUNDED AND BATCHED ────────────────────────────────────────────────────
 * Three queries total, whatever the contact count: one per collection, with
 * every identity in a single `$or`. Never one query per contact — a Prospect
 * with eight people would otherwise cost 24 round trips to render a warning.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Where a Lead lives on screen. One helper, because a Lead still in capture
 *  is a Prospect and lives under a different route — and a duplicate warning
 *  that opens the wrong screen is worse than none. Declared here so both the
 *  contact-aware and the record-level paths use the same rule. */
const leadHref = (r) => `/sales/dashboard/${r.captureStatus === "draft" ? "prospects" : "leads"}/${r._id}`;

/** The identities one embedded contact carries, normalised for comparison. */
function contactIdentities(c = {}) {
  const out = [];
  const email = String(c.normalizedEmail || c.email || "").trim().toLowerCase();
  if (email) out.push({ kind: "email", value: email });
  for (const [kind, raw] of [["phone", c.normalizedPhone || c.phone], ["whatsapp", c.normalizedWhatsapp || c.whatsapp]]) {
    const v = normalizePhone(raw);
    if (v.length === 10) out.push({ kind, value: v });
  }
  return out;
}

/* A number typed as "+91 98000 00000" does not end with "9800000000", so raw
   fields need a digit-tolerant pattern. Records saved since the normalised
   fields existed are matched exactly and cheaply; this is the fallback that
   keeps older rows visible without waiting for somebody to edit them. */
const looseDigits = (tail) => new RegExp(`${tail.split("").join("\\D*")}$`);
const exactTail = (tail) => new RegExp(`${esc(tail)}$`);

/** `high` for an identity that means "the same person or desk"; `medium` for a
 *  company/domain coincidence. A name on its own never reaches either — a
 *  shared surname is not a duplicate, and crying wolf teaches people to click
 *  past the warning that matters. */
const confidenceFor = (matchedOn) =>
  (matchedOn.some((m) => ["email", "phone", "whatsapp"].includes(m.kind)) ? "high" : "medium");

/**
 * Possible duplicates for every contact on a Prospect.
 *
 * @param {{Lead, Contact, Account}} models
 * @param {object} ctx      the caller's company service context
 * @param {object} lead     the Lead, with `contacts[]`
 * @returns {Promise<Array>} one entry per (our contact × existing record) pair
 */
async function findProspectContactDuplicates({ Lead, Contact, Account }, ctx, lead = {}) {
  /* An unsaved Quick Capture row has no `_id` yet, and it is exactly the row a
     salesperson most needs warned about — before the duplicate is created. Fall
     back to a positional key so those participate too. */
  const ours = (lead.contacts || []).filter(Boolean).map((c, i) => ({ ...c, __key: String(c._id || `new:${i}`) }));
  if (!ours.length) return [];

  /* Every identity across every contact, with the people who hold it — so one
     query answers for all of them and the results map back to a person. */
  const byIdentity = new Map();
  for (const c of ours) {
    for (const { kind, value } of contactIdentities(c)) {
      const key = `${kind}:${value}`;
      if (!byIdentity.has(key)) byIdentity.set(key, { kind, value, contacts: [] });
      byIdentity.get(key).contacts.push(c);
    }
  }
  if (!byIdentity.size) return [];

  /* A contact we ourselves promoted to a real CRMContact is not a duplicate of
     itself — it is the same person, one step further along. */
  const promoted = new Set(ours.map((c) => c.promotedContactId).filter(Boolean).map(String));

  const emails = [...byIdentity.values()].filter((i) => i.kind === "email").map((i) => i.value);
  const tails = [...new Set([...byIdentity.values()].filter((i) => i.kind !== "email").map((i) => i.value))];

  const leadOr = [];
  const contactOr = [];
  const accountOr = [];
  if (emails.length) {
    leadOr.push({ email: { $in: emails } }, { "contacts.normalizedEmail": { $in: emails } }, { "contacts.email": { $in: emails } });
    contactOr.push({ email: { $in: emails } }, { alternateEmail: { $in: emails } });
    accountOr.push({ primaryEmail: { $in: emails } });
  }
  for (const tail of tails) {
    const tight = exactTail(tail);
    const loose = looseDigits(tail);
    leadOr.push(
      { normalizedPhone: tight }, { normalizedWhatsapp: tight },
      { phone: loose }, { whatsapp: loose },
      { "contacts.normalizedPhone": tight }, { "contacts.normalizedWhatsapp": tight },
      { "contacts.phone": loose }, { "contacts.whatsapp": loose },
    );
    contactOr.push({ phone: loose }, { mobile: loose }, { whatsapp: loose }, { alternatePhone: loose });
    accountOr.push({ primaryPhone: loose });
  }

  /* Three queries, in parallel — not one per contact. */
  const [leadRows, contactRows, accountRows] = await Promise.all([
    leadOr.length
      ? Lead.find(serviceFilter(ctx, { $or: leadOr, isActive: true, _id: { $ne: lead._id } }))
        .select("leadId firstName lastName company email phone whatsapp contacts qualificationState captureStatus")
        .limit(25).lean()
      : [],
    contactOr.length
      ? Contact.find(serviceFilter(ctx, {
        $or: contactOr,
        isActive: true,
        archivedAt: null,
        ...(promoted.size ? { _id: { $nin: [...promoted] } } : {}), // Mongoose casts these strings
      }))
        .select("contactId firstName lastName email alternateEmail phone mobile whatsapp alternatePhone accountId")
        .limit(25).lean()
      : [],
    accountOr.length
      ? Account.find(serviceFilter(ctx, { $or: accountOr, isActive: true }))
        .select("accountId companyName primaryEmail primaryPhone").limit(25).lean()
      : [],
  ]);

  /* ── A PERSON IS NOT A CUSTOMER RECORD ───────────────────────────────────
     A CRMContact match used to be returned as `recordType: "contact"` with the
     contact's own id and an Account href — a contract that disagreed with
     itself, and that made every consumer guess. The duplicate workflow links a
     Prospect to a surviving Lead or Account; a CRMContact is a person INSIDE
     an Account, so the match is reported as that Account, with the person
     carried as the matched-contact context.

     One extra bounded query for the parents of whatever the contact query
     returned — four fixed queries rather than three, because a self-consistent
     contract matters more than the smaller number. */
  const parentIds = [...new Set(contactRows.map((r) => r.accountId).filter(Boolean).map(String))];
  const parents = new Map();
  if (parentIds.length) {
    const rows = await Account.find(serviceFilter(ctx, { _id: { $in: parentIds }, isActive: { $ne: false } }))
      .select("accountId companyName").lean();
    for (const a of rows) parents.set(String(a._id), a);
  }

  /* Which of OUR contacts an existing record's identities correspond to. */
  const emailHits = (values) => {
    const found = [];
    for (const v of values.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean)) {
      const hit = byIdentity.get(`email:${v}`);
      if (hit) found.push({ identity: hit, matched: { kind: "email", value: v } });
    }
    return found;
  };
  /* `kind` is THEIR field — the one the number was actually read from — and it
     is what the reason is named for. Both of OUR channel buckets are still
     searched, because their landline can legitimately be the number we saved
     as somebody's WhatsApp and that is a real match either way.

     Defaulting the kind (as this used to) reported an Account's primaryPhone
     as a WhatsApp match and a Lead's WhatsApp as a phone match — a reason the
     record does not support. Both reasons now appear only when both of their
     fields genuinely hold the number. */
  const phoneHits = (values, kind) => {
    const found = [];
    for (const raw of values) {
      const v = normalizePhone(raw);
      if (v.length !== 10) continue;
      for (const ourKind of ["phone", "whatsapp"]) {
        const hit = byIdentity.get(`${ourKind}:${v}`);
        if (hit) found.push({ identity: hit, matched: { kind, value: v } });
      }
    }
    return found;
  };

  /* Keyed by (their record × OUR person), because a record can be reached by
     two routes at once: their top-level identity is their PRIMARY contact's
     mirror, so a match on their primary arrives twice — once as the record and
     once as the embedded row. Two warnings for one person reads as two
     problems. Where both arrive, the row naming their contact wins. */
  const results = new Map();
  const push = (record, hits, theirContact) => {
    const byOurContact = new Map();
    for (const { identity, matched } of hits) {
      for (const c of identity.contacts) {
        if (!byOurContact.has(c.__key)) byOurContact.set(c.__key, { contact: c, matchedOn: [] });
        const bucket = byOurContact.get(c.__key).matchedOn;
        if (!bucket.some((m) => m.kind === matched.kind && m.value === matched.value)) bucket.push(matched);
      }
    }
    for (const { contact, matchedOn } of byOurContact.values()) {
      if (!matchedOn.length) continue;
      const key = `${record.recordType}:${record.recordId}:${contact.__key}`;
      const seen = results.get(key);
      if (seen) {
        for (const m of matchedOn) {
          if (!seen.matchedOn.some((x) => x.kind === m.kind && x.value === m.value)) seen.matchedOn.push(m);
        }
        /* Their named contact beats the anonymous record-level mirror. If two
           DIFFERENT of their people match the same person of ours, the first
           named one is kept — the record and the reasons are still complete. */
        if (theirContact?.id && !seen.matchedContactId) {
          seen.matchedContactId = theirContact.id;
          seen.matchedContactName = theirContact.name || seen.matchedContactName;
          seen.matchedContactReference = theirContact.reference || seen.matchedContactReference;
        }
        seen.confidence = confidenceFor(seen.matchedOn);
        continue;
      }
      results.set(key, {
        ...record,
        contactId: contact._id ? String(contact._id) : null,
        contactKey: contact.__key,
        contactName: contact.name,
        matchedContactId: theirContact?.id || null,
        matchedContactName: theirContact?.name || null,
        matchedContactReference: theirContact?.reference || null,
        matchedOn,
        confidence: confidenceFor(matchedOn),
      });
    }
  };

  for (const r of leadRows) {
    /* Their top-level identity is their primary's mirror; their embedded
       contacts are everybody else. Both are checked, and the result says which
       of THEIR people it was where we can tell. */
    push(
      { recordType: "lead", recordId: String(r._id), reference: r.leadId, recordName: r.company || `${r.firstName || ""} ${r.lastName || ""}`.trim(), href: leadHref(r) },
      [...emailHits([r.email]), ...phoneHits([r.phone], "phone"), ...phoneHits([r.whatsapp], "whatsapp")],
      { id: null, name: `${r.firstName || ""} ${r.lastName || ""}`.trim() || null },
    );
    for (const tc of r.contacts || []) {
      push(
        { recordType: "lead", recordId: String(r._id), reference: r.leadId, recordName: r.company || `${r.firstName || ""} ${r.lastName || ""}`.trim(), href: leadHref(r) },
        [
          ...emailHits([tc.normalizedEmail, tc.email]),
          ...phoneHits([tc.normalizedPhone, tc.phone], "phone"),
          ...phoneHits([tc.normalizedWhatsapp, tc.whatsapp], "whatsapp"),
        ],
        { id: String(tc._id), name: tc.name },
      );
    }
  }
  for (const r of contactRows) {
    const parent = r.accountId ? parents.get(String(r.accountId)) : null;
    /* A contact with no Account — or whose Account is inactive or outside this
       company — has no customer record a Prospect could be linked to, so there
       is nothing here anybody could act on. Skipped rather than reported as an
       unusable row. See the limitation noted in the task document. */
    if (!parent) continue;
    push(
      {
        recordType: "account",
        recordId: String(parent._id),
        reference: parent.accountId,
        recordName: parent.companyName,
        href: `/sales/dashboard/accounts/${parent._id}`,
      },
      [
        ...emailHits([r.email, r.alternateEmail]),
        ...phoneHits([r.phone, r.mobile, r.alternatePhone], "phone"),
        ...phoneHits([r.whatsapp], "whatsapp"),
      ],
      { id: String(r._id), name: `${r.firstName || ""} ${r.lastName || ""}`.trim(), reference: r.contactId },
    );
  }
  for (const r of accountRows) {
    push(
      { recordType: "account", recordId: String(r._id), reference: r.accountId, recordName: r.companyName, href: `/sales/dashboard/accounts/${r._id}` },
      [...emailHits([r.primaryEmail]), ...phoneHits([r.primaryPhone], "phone")],
      null,
    );
  }

  /* Strongest first — a phone match is what somebody needs to see. */
  const rank = { high: 0, medium: 1 };
  return [...results.values()].sort((a, b) =>
    (rank[a.confidence] - rank[b.confidence]) || String(a.contactName).localeCompare(String(b.contactName)));
}

/* ══ ONE CONTRACT, SO EVERY SURFACE SAYS THE SAME THING ════════════════════
 * Quick Capture, readiness, the Contacts section, duplicate review and the
 * Lead duplicate picker each used to read a differently-shaped object, so the
 * same underlying match was described four different ways. `findProspectDup-
 * licates` is the one entry point: it runs the record-level finders (company,
 * website domain — signals that belong to the organisation, not a person) and
 * the per-contact finder, then folds both into a single row shape.
 *
 * `contactId: null` is meaningful, not missing data — it marks a match that
 * IS record-level: "the company name matches", which no individual person
 * owns. A row with a contactId names the person.
 * ═══════════════════════════════════════════════════════════════════════════ */

/* ── WHAT LEAVES THE SERVER ────────────────────────────────────────────────
 * The panel says "phone matches Lakeview Hotels". It never needs the number to
 * say that, and a duplicate warning is one of the few payloads that would
 * otherwise hand a caller a list of identities belonging to records they may
 * not otherwise be entitled to read in full. So the raw value stays internal
 * to matching and only a masked tail travels — enough to tell two of a
 * person's numbers apart, not enough to be a contact list.
 *
 * The reason kind and the confidence are untouched: those are what the warning
 * is FOR. */
function maskIdentity(kind, value) {
  const v = String(value || "");
  if (!v) return null;
  if (kind === "email") {
    const [local, domain] = v.split("@");
    if (!domain) return null;
    return `${local.slice(0, 1)}…@${domain}`;
  }
  return v.length > 4 ? `…${v.slice(-4)}` : null;
}

const HUMAN_IDENTITY = { email: "email", phone: "phone", whatsapp: "WhatsApp", company: "company name", name: "company name", domain: "web domain" };

/** One match, in the shape every caller reads. */
const dupRow = (r) => ({
  recordType: r.recordType,               // "lead" | "account" — never a person
  recordId: String(r.recordId),
  reference: r.reference || null,         // LEAD-2026-0042 — what a person quotes
  recordName: r.recordName || null,
  contactId: r.contactId || null,         // OUR contact; null ⇒ record-level match
  contactKey: r.contactKey || null,       // positional stand-in for an unsaved row
  contactName: r.contactName || null,
  matchedContactId: r.matchedContactId || null,   // THEIR contact, where known
  matchedContactName: r.matchedContactName || null,
  matchedContactReference: r.matchedContactReference || null,
  matchedOn: (r.matchedOn || []).map((m) => (typeof m === "string"
    ? { kind: m, label: HUMAN_IDENTITY[m] || m }
    : { kind: m.kind, label: HUMAN_IDENTITY[m.kind] || m.kind, masked: maskIdentity(m.kind, m.value) })),
  confidence: r.confidence,
  href: r.href || null,
  status: r.status || null,               // their lifecycle state, for context
});

/**
 * Every possible duplicate for a Prospect: record-level and per-contact.
 * @returns {Promise<{matches: Array, hasMatches: boolean, hasStrong: boolean, leadMatches: Array, accountMatches: Array}>}
 */
async function findProspectDuplicates({ Lead, Contact, Account }, ctx, lead = {}) {
  const candidate = { company: lead.company, email: lead.email, phone: lead.phone, website: lead.website };
  const [leadMatches, accountMatches, contactMatches] = await Promise.all([
    findLeadDuplicates(Lead, ctx, candidate, lead._id || null),
    findAccountDuplicates(Account, ctx, { companyName: lead.company, website: lead.website, primaryEmail: lead.email, primaryPhone: lead.phone }, null),
    findProspectContactDuplicates({ Lead, Contact, Account }, ctx, lead),
  ]);

  const rows = [
    ...leadMatches.map((m) => dupRow({
      recordType: "lead", recordId: m._id, reference: m.leadId, recordName: m.company || m.name,
      matchedOn: m.matchedOn, confidence: m.confidence, status: m.qualificationState,
      href: leadHref(m),
    })),
    ...accountMatches.map((m) => dupRow({
      recordType: "account", recordId: m._id, reference: m.accountId, recordName: m.companyName || m.name,
      matchedOn: m.matchedOn, confidence: m.confidence, status: m.status,
      href: `/sales/dashboard/accounts/${m._id}`,
    })),
    ...contactMatches.map(dupRow),
  ];

  /* The same record reached by two routes (company name AND a contact's phone)
     is ONE row per person, carrying both reasons — otherwise the panel repeats
     the same organisation and reads as several separate problems. */
  const merged = new Map();
  for (const row of rows) {
    const key = `${row.recordType}:${row.recordId}:${row.contactKey || ""}`;
    const seen = merged.get(key);
    if (!seen) { merged.set(key, row); continue; }
    for (const m of row.matchedOn) {
      if (!seen.matchedOn.some((x) => x.kind === m.kind && x.value === m.value)) seen.matchedOn.push(m);
    }
    if (row.confidence === "high") seen.confidence = "high";
    seen.matchedContactId = seen.matchedContactId || row.matchedContactId;
    seen.matchedContactName = seen.matchedContactName || row.matchedContactName;
  }

  const rank = { high: 0, medium: 1 };
  const matches = [...merged.values()].sort((a, b) => rank[a.confidence] - rank[b.confidence]);
  return {
    matches,
    hasMatches: matches.length > 0,
    hasStrong: matches.some((m) => m.confidence === "high"),
    leadMatches,      // unchanged shape — existing callers keep working
    accountMatches,
  };
}


module.exports = {
  normalizeName,
  domainOf,
  normalizePhone,
  findAccountDuplicates,
  findContactDuplicates,
  findLeadDuplicates,
  contactIdentities,
  findProspectContactDuplicates,
  findProspectDuplicates,
};
