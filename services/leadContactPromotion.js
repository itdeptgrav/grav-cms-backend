// services/leadContactPromotion.js
//
// THE PEOPLE ON A LEAD BECOME THE PEOPLE ON A CUSTOMER.
//
// A Prospect collects four people — merchandiser, purchase manager, admin
// head, whoever signs — inside `lead.contacts[]`. Those are embedded rows, not
// CRM records: they cannot be linked to an Opportunity, cannot own a site, and
// disappear from view the moment work moves to the Account.
//
// Promotion is where they become real. It happens ONCE a genuine Account
// exists — created or selected — and never at Prospect → Lead conversion,
// because there is no customer to attach anybody to yet.
//
// ── WHY ONE SERVICE ────────────────────────────────────────────────────────
// Two paths reached this point and did different things. `POST /:id/account`
// created an Account with no people at all. Sales Journey seeded exactly ONE
// contact, chosen by a "decision-maker, else the first one" rule, and only if
// the Account had none — so the other three were silently dropped and the
// salesperson re-typed people they already had. Both now call this.
//
// ── RESOLUTION ORDER, AND WHY IT STOPS WHERE IT DOES ───────────────────────
//   1. an existing `promotedContactId` that really belongs to this Account
//   2. a unique exact normalized EMAIL match inside this Account
//   3. a unique exact normalized PHONE or WHATSAPP match inside this Account
//   4. otherwise create
//
// Name is never a match. Two people called Ramesh Sharma is a Tuesday, and
// merging them would silently fuse two humans into one record — the one
// mistake here that cannot be undone by editing a field afterwards.
//
// Ambiguity is never guessed. If two CRM Contacts under the Account carry the
// same number, or two Lead contacts resolve to the same CRM Contact, the whole
// promotion is refused with a conflict naming both sides. Picking one would be
// a coin toss recorded as fact.
//
// ── ARCHIVED CONTACTS ARE NOT ABSENT ONES ──────────────────────────────────
// A CRM Contact with `isActive: false` was ARCHIVED on purpose (the delete
// route sets isActive false, status "archived", archivedAt). Loading only
// active contacts made two lies possible: a `promotedContactId` pointing at an
// archived contact under THIS Account was reported as belonging to a different
// one, and an archived person's email or number produced a brand-new second
// contact carrying the same identity. Archived contacts are therefore loaded
// too, and matching one is a conflict asking for reactivation — reusing it
// silently would resurrect a record somebody deliberately removed.
//
// ── ALL OR NOTHING ─────────────────────────────────────────────────────────
// Every match is resolved BEFORE anything is written, so a conflict on the
// fourth person cannot leave the first three half-promoted. The deployment's
// Mongo is not guaranteed to be a replica set (the test harness is standalone
// and the Store & Purchase unit-of-work exists precisely because of that), so
// this does not pretend to be transactional: it preflights, writes, and on
// failure compensates — deleting what it created and restoring what it
// changed. The compensation is tested, not asserted.
//
// The caller gets that same compensation back as `undo()`, because promotion
// is rarely the last thing a request does. A Sales Journey promotes contacts
// and then keeps working; if the Journey insert loses a race, the contacts and
// the `promotedContactId` values written a moment earlier are just as wrong as
// a half-finished promotion. `undo()` is what makes those failures recoverable
// rather than merely reported.
"use strict";

const { CONTACT_ROLE_CODES } = require("../constants/crm");

/** A refusal the caller should surface as a 400, with the detail attached. */
class ContactPromotionError extends Error {
  constructor(message, conflicts = []) {
    super(message);
    this.name = "ContactPromotionError";
    this.status = 400;
    this.conflicts = conflicts;
  }
}

/* Identity, compared the way both sides store it. Lead contacts derive
   `normalizedEmail`/`normalizedPhone`/`normalizedWhatsapp`; CRM Contacts do
   not, so theirs are computed here with the SAME rules — a comparison against
   a differently-normalised value silently returns zero matches instead of an
   error, which is the worst possible failure for a merge decision. */
const emailKey = (v) => String(v || "").trim().toLowerCase();
const phoneKey = (v) => {
  const d = String(v || "").replace(/\D+/g, "");
  return d.length > 10 ? d.slice(-10) : d;
};

/** "Ramesh Sharma" → first/last, because CRMContact stores them apart. */
function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: "", lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/* The Lead's `preferredChannel` vocabulary is the CRM's own, so it copies
   across untouched. `preferredContact` is the older three-value field still on
   CRMContact; it is filled only where the newer value has an equivalent —
   `portal` and `none` have none, and inventing one would put a preference in
   the record that nobody expressed. */
const LEGACY_PREFERRED = { email: "email", phone: "phone", messaging: "whatsapp" };

/** Everything one embedded contact has to say, in CRMContact's own shape. */
function contactFieldsFrom(c) {
  const { firstName, lastName } = splitName(c.name);
  const roles = [];
  if (c.roleCode && CONTACT_ROLE_CODES.includes(c.roleCode)) roles.push(c.roleCode);
  /* The legacy decision-maker flag is a ROLE in the CRM's vocabulary, so it
     survives as one rather than being dropped for lack of a boolean column. */
  if (c.isDecisionMaker && !roles.includes("decision_maker")) roles.push("decision_maker");

  return {
    firstName,
    lastName,
    /* Free-text `role` is not an enum value and never becomes one. It is the
       best available job title when nobody typed a real one. */
    jobTitle: c.jobTitle || c.role || undefined,
    department: c.department || undefined,
    roles,
    email: c.email || undefined,
    phone: c.phone || undefined,
    whatsapp: c.whatsapp || undefined,
    preferredChannel: c.preferredChannel || undefined,
    preferredContact: LEGACY_PREFERRED[c.preferredChannel] || undefined,
    preferredLanguage: c.preferredLanguage || undefined,
    /* Same enum on both sides, so the person's real state travels: somebody
       who has left the organisation arrives marked as having left, rather than
       as a fresh active contact somebody will try to call. */
    status: c.status || undefined,
    notes: c.notes || undefined,
  };
}

/** Fields safe to fill on a contact that already exists. */
const FILLABLE = [
  "jobTitle", "department", "email", "phone", "whatsapp",
  "preferredChannel", "preferredContact", "preferredLanguage",
];

const isBlank = (v) => v === undefined || v === null || String(v).trim() === "";

/* Who may hold the primary flag. Someone who has left, is blocked, is archived
   or is marked do-not-contact must never become the face of the Account — that
   is how a customer ends up with a primary nobody may call. `doNotContact` is
   a separate flag from `status` on CRMContact, so checking status alone let a
   suppressed person through while looking like it had been considered. */
const canBePrimary = (c) => Boolean(c)
  && c.isActive !== false
  && (!c.status || c.status === "active")
  && c.doNotContact !== true;

/**
 * Promote a Lead's embedded contacts into real CRM Contacts under an Account.
 *
 * Pure of HTTP: the caller supplies the company scope it already resolved, the
 * ownership stamp for new records, and the actor. Nothing is re-resolved here,
 * so the Account, the Lead and the Contacts cannot end up owned by three
 * different answers to "which company is this?".
 *
 * @returns {Promise<{created:number, matched:number, linked:number, skipped:number,
 *                    conflicts:Array, contacts:Array, primaryContactId:?string}>}
 */
async function promoteLeadContacts({ Contact, Lead }, { lead, account, scopeClause = {}, ownership = {}, actor = null }) {
  const accountId = String(account._id);
  const rows = (lead.contacts || []).filter((c) => c && String(c.name || "").trim());

  /* Every contact already under this Account, ARCHIVED ONES INCLUDED, in ONE
     query. Matching in memory from here: an Account's contact list is small,
     and a query per Lead contact would turn a four-person promotion into a
     dozen round trips. */
  const underAccount = await Contact.find({
    $and: [scopeClause, { accountId: account._id }],
  }).lean();
  const existing = underAccount.filter((c) => c.isActive !== false);

  const byEmail = new Map();
  const byPhone = new Map();
  for (const e of underAccount) {
    const em = emailKey(e.email);
    if (em) (byEmail.get(em) || byEmail.set(em, []).get(em)).push(e);
    for (const raw of [e.phone, e.mobile, e.whatsapp, e.alternatePhone]) {
      const p = phoneKey(raw);
      if (p.length === 10) {
        const bucket = byPhone.get(p) || byPhone.set(p, []).get(p);
        if (!bucket.some((x) => String(x._id) === String(e._id))) bucket.push(e);
      }
    }
  }

  // ── PREFLIGHT: decide everything, write nothing ──────────────────────────
  const conflicts = [];
  const plan = [];
  const claimed = new Map();   // existing contact id → the Lead contact taking it

  for (const c of rows) {
    const label = c.name;
    let target = null;
    let how = null;

    if (c.promotedContactId) {
      /* A pointer is only worth what it points AT. One from another Account or
         another company is not a stale link to tidy up — it is a claim that
         this person is already somebody else's contact, and accepting it would
         attach this Account's work to a record it does not own. */
      const linked = underAccount.find((e) => String(e._id) === String(c.promotedContactId));
      if (linked && linked.isActive === false) {
        /* Under the right Account, but archived. Not foreign, and not something
           to quietly resurrect — somebody removed this person deliberately. */
        conflicts.push({
          leadContactId: String(c._id), contactName: label, reason: "inactive_link",
          message: `${label} is linked to an archived contact on this customer — reactivate them, or clear the link.`,
          contactId: String(linked._id),
        });
        continue;
      }
      if (linked) {
        target = linked;
        how = "linked";
      } else {
        const foreign = await Contact.findById(c.promotedContactId).select("accountId companyId isActive").lean();
        if (foreign) {
          conflicts.push({
            leadContactId: String(c._id), contactName: label, reason: "foreign_link",
            message: `${label} is already linked to a contact under a different account.`,
            contactId: String(foreign._id),
          });
          continue;
        }
        // The contact was deleted outright: the pointer means nothing, re-resolve.
      }
    }

    if (!target) {
      const em = emailKey(c.normalizedEmail || c.email);
      const candidates = em ? (byEmail.get(em) || []) : [];
      if (candidates.length > 1) {
        conflicts.push({
          leadContactId: String(c._id), contactName: label, reason: "ambiguous_email",
          message: `${label} matches ${candidates.length} existing contacts on email — link them by hand.`,
          contactIds: candidates.map((x) => String(x._id)),
        });
        continue;
      }
      if (candidates.length === 1) {
        if (candidates[0].isActive === false) {
          conflicts.push({
            leadContactId: String(c._id), contactName: label, reason: "inactive_match",
            message: `${label}'s email already belongs to an archived contact on this customer — reactivate them, or change the address.`,
            contactId: String(candidates[0]._id),
          });
          continue;
        }
        target = candidates[0];
        how = "matched";
      }
    }

    if (!target) {
      const found = new Map();
      for (const raw of [c.normalizedPhone || c.phone, c.normalizedWhatsapp || c.whatsapp]) {
        const p = phoneKey(raw);
        if (p.length !== 10) continue;
        for (const e of byPhone.get(p) || []) found.set(String(e._id), e);
      }
      if (found.size > 1) {
        conflicts.push({
          leadContactId: String(c._id), contactName: label, reason: "ambiguous_phone",
          message: `${label} matches ${found.size} existing contacts on a phone or WhatsApp number — link them by hand.`,
          contactIds: [...found.keys()],
        });
        continue;
      }
      if (found.size === 1) {
        const [only] = [...found.values()];
        if (only.isActive === false) {
          conflicts.push({
            leadContactId: String(c._id), contactName: label, reason: "inactive_match",
            message: `${label}'s number already belongs to an archived contact on this customer — reactivate them, or change the number.`,
            contactId: String(only._id),
          });
          continue;
        }
        target = only;
        how = "matched";
      }
    }

    if (target) {
      /* Two of our people resolving to ONE of theirs means the identities
         disagree with the names, and merging either way loses somebody. */
      const already = claimed.get(String(target._id));
      if (already) {
        conflicts.push({
          leadContactId: String(c._id), contactName: label, reason: "duplicate_target",
          message: `${label} and ${already} both match the same existing contact — link them by hand.`,
          contactId: String(target._id),
        });
        continue;
      }
      claimed.set(String(target._id), label);
    }

    plan.push({ row: c, target, how: how || "created" });
  }

  if (conflicts.length) {
    throw new ContactPromotionError(
      conflicts.length === 1 ? conflicts[0].message : `${conflicts.length} contacts could not be linked automatically.`,
      conflicts,
    );
  }

  // ── PRIMARY: the Account's own answer wins, and nobody is demoted ────────
  const accountPrimary = existing.find((e) => e.isPrimary && canBePrimary(e));
  /* Only when the Account has no primary of its own does the Lead's primary
     take the role — and only if that person is actually contactable. */
  const leadPrimaryRow = accountPrimary
    ? null
    : plan.find((p) => p.row.isPrimary && canBePrimary(p.row));

  // ── WRITE, with a way back ───────────────────────────────────────────────
  const createdIds = [];
  /* [{_id, set, unset, pullLead}] — everything this promotion changed about a
     contact that already existed. A field that was ABSENT cannot be restored
     with `$set: undefined`: Mongoose drops undefined keys, so the value we
     wrote would survive the rollback. It needs `$unset`, which is the
     difference between undoing a change and only appearing to.

     `pullLead` records that WE added this Lead to `linkedLeads`. Undoing that
     has to be conditional: a Lead already listed there was not put there by
     this promotion, and pulling it would delete somebody else's link. */
  const restore = [];
  /* What THIS promotion wrote onto each Lead row, and what was there before.
     Only rows it actually changed are listed — see `undo()` for why that
     matters. */
  const written = [];
  const result = { created: 0, matched: 0, linked: 0, skipped: rows.length - plan.length, conflicts: [], contacts: [] };
  let primaryContactId = accountPrimary ? String(accountPrimary._id) : null;

  try {
    for (const step of plan) {
      const fields = contactFieldsFrom(step.row);
      const isPrimaryHere = leadPrimaryRow === step;

      if (!step.target) {
        const doc = await Contact.create({
          ...fields,
          ...ownership,
          accountId: account._id,
          isPrimary: isPrimaryHere,
          isActive: true,
          assignedTo: lead.assignedTo || undefined,
          assignedToName: lead.assignedToName || undefined,
          /* The bridge back. Activities stay Lead-owned in this chunk, so the
             link from a person to their history runs Lead contact →
             promotedContactId → CRM Contact, and this is the other end of it. */
          linkedLeads: [lead._id],
          createdBy: actor || undefined,
          updatedBy: actor || undefined,
        });
        createdIds.push(doc._id);
        step.contactId = doc._id;
        result.created += 1;
        if (isPrimaryHere) primaryContactId = String(doc._id);
      } else {
        /* An existing Account contact is authoritative about itself. Only
           genuinely empty fields are filled — never a value somebody at this
           customer already corrected — and status, ownership, assignment and
           the primary flag are left exactly as they are. */
        const $set = {};
        const undoSet = {};
        const undoUnset = {};
        const remember = (key) => {
          if (isBlank(step.target[key]) && step.target[key] === undefined) undoUnset[key] = "";
          else undoSet[key] = step.target[key];
        };
        for (const key of FILLABLE) {
          if (!isBlank(fields[key]) && isBlank(step.target[key])) {
            $set[key] = fields[key];
            remember(key);
          }
        }
        const roles = [...new Set([...(step.target.roles || []), ...fields.roles])];
        if (roles.length !== (step.target.roles || []).length) {
          $set.roles = roles;
          undoSet.roles = step.target.roles || [];
        }
        if (Object.keys($set).length) {
          if (actor) { $set.updatedBy = actor; remember("updatedBy"); }
          restore.push({ _id: step.target._id, set: undoSet, unset: undoUnset });
          await Contact.updateOne({ _id: step.target._id }, { $set });
        }
        /* Additive and idempotent — the Lead this person came from, recorded
           without disturbing any other lead they are already linked to. Noted
           for the undo ONLY when it was genuinely absent before, so rolling
           back cannot remove a link that predates this request. */
        const alreadyLinked = (step.target.linkedLeads || []).some((l) => String(l) === String(lead._id));
        if (!alreadyLinked) {
          await Contact.updateOne({ _id: step.target._id }, { $addToSet: { linkedLeads: lead._id } });
          const entry = restore.find((r) => String(r._id) === String(step.target._id));
          if (entry) entry.pullLead = true;
          else restore.push({ _id: step.target._id, set: {}, unset: {}, pullLead: true });
        }
        step.contactId = step.target._id;
        result[step.how] += 1;
        if (isPrimaryHere && !primaryContactId) primaryContactId = String(step.target._id);
      }

      written.push({
        rowId: step.row._id,
        wrote: step.contactId,
        previous: step.row.promotedContactId || null,
      });
      step.row.promotedContactId = step.contactId;
      result.contacts.push({
        leadContactId: String(step.row._id),
        contactId: String(step.contactId),
        name: step.row.name,
        action: step.how,
      });
    }

    lead.markModified("contacts");
    if (actor) lead.updatedBy = actor;
    await lead.save();
  } catch (err) {
    await undo();
    throw err;
  }

  result.primaryContactId = primaryContactId;
  return { summary: result, undo };

  /* ── PUTTING IT BACK ──────────────────────────────────────────────────────
     Everything promotion touched, in reverse: contacts it created, fields it
     filled, roles it added, the `updatedBy` it stamped, the `linkedLeads`
     entry it added, and the `promotedContactId` it wrote onto each Lead row.

     Best effort by design — there may be no transaction here. A failure inside
     compensation is never swallowed into a misleading success: the caller's
     original error is what surfaces. */
  async function undo() {
    for (const id of createdIds) await Contact.deleteOne({ _id: id }).catch(() => {});
    for (const r of restore) {
      const ops = {};
      if (Object.keys(r.set).length) ops.$set = r.set;
      if (Object.keys(r.unset).length) ops.$unset = r.unset;
      if (r.pullLead) ops.$pull = { linkedLeads: lead._id };
      if (Object.keys(ops).length) await Contact.updateOne({ _id: r._id }, ops).catch(() => {});
    }
    /* ── THE LEAD IS PUT BACK WITH A SCALPEL, NOT A SAVE ──────────────────
       `lead.save()` here was a live hazard. The document in hand was loaded
       before promotion and carries the WHOLE record — qualification state,
       conversion, account link, every contact field. In a Journey race the
       other request may have converted this Lead in the meantime; saving this
       copy would write `readyToConvert` back over the winner's `converted`
       and silently undo their conversion, along with any other change made
       since the load.

       So compensation touches exactly the fields it wrote, addressed by the
       embedded contact's stable `_id`, and only while the stored value is
       STILL the one this promotion put there. If another request has since
       repointed that contact, the filter does not match and the newer value
       stands. That condition also makes `undo()` idempotent: a second call
       matches nothing. */
    const filters = [];
    const $set = {};
    const $unset = {};
    written.forEach(({ rowId, wrote, previous }, i) => {
      const id = `c${i}`;
      filters.push({ [`${id}._id`]: rowId, [`${id}.promotedContactId`]: wrote });
      if (previous) $set[`contacts.$[${id}].promotedContactId`] = previous;
      else $unset[`contacts.$[${id}].promotedContactId`] = "";
    });
    if (filters.length && Lead) {
      const ops = {};
      if (Object.keys($set).length) ops.$set = $set;
      if (Object.keys($unset).length) ops.$unset = $unset;
      await Lead.updateOne({ _id: lead._id }, ops, { arrayFilters: filters }).catch(() => {});
    }
    /* The in-memory document is corrected too, so a caller still holding it is
       not looking at links that no longer exist in the database. */
    for (const { rowId, previous } of written) {
      const row = (lead.contacts || []).find((c) => String(c._id) === String(rowId));
      if (row) row.promotedContactId = previous || undefined;
    }
  }
}

module.exports = { promoteLeadContacts, ContactPromotionError, contactFieldsFrom, splitName };
