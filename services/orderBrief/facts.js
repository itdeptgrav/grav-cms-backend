"use strict";
/**
 * services/orderBrief/facts.js
 * ───────────────────────────────────────────────────────────────────────────
 * THE VOCABULARY OF THE ORDER BRIEF, AND THE ONE RULE THAT PICKS A SOURCE.
 *
 * Every line of the brief is a FACT with a status and an authority, and the
 * two are deliberately separate questions:
 *
 *   status     — can this be relied on?   confirmed · draft · missing · not_applicable
 *   authority  — who stands behind it?    the buyer · Merchandising · the Sales
 *                                         handover · R&D · the order record …
 *
 * Collapsing them is how a brief lies. "Confirmed" alone lets a reader assume
 * the BUYER approved a tech pack that only R&D approved (this system records
 * no buyer approval for tech packs at all), or treat an account's standing
 * AQL default as this order's agreed inspection level. Keeping the authority
 * on every fact means the brief can say exactly who confirmed what, and the
 * reader decides whether that is enough.
 *
 * Pure: no database, no clock except the one passed in. The assembler and the
 * tests both build on this.
 */

const crypto = require("crypto");

const STATUS = Object.freeze({
  CONFIRMED: "confirmed",
  DRAFT: "draft",
  MISSING: "missing",
  NOT_APPLICABLE: "not_applicable",
});

/* Who stands behind a fact. Order is NOT precedence — precedence is decided
   per field by the candidate list the caller builds, because "Merchandising
   beats the handover" is true for packaging and meaningless for a PO. */
const AUTHORITY = Object.freeze({
  BUYER: "buyer",
  MERCHANDISING: "merchandising",
  SALES_HANDOVER: "sales_handover",
  RND: "rnd",
  SALES: "sales",
  ORDER_RECORD: "order_record",
  ENQUIRY: "enquiry",
  BUYER_DEFAULT: "buyer_default",
});

/* ── WHY NOT_APPLICABLE OUTRANKS DRAFT ─────────────────────────────────────
 * "Not applicable" is only ever set from an explicit decision in a source —
 * Sales waiving a sample, R&D marking a tech sheet unnecessary. A decision
 * that something does not apply is a firmer answer than a draft of it.
 * `missing` is last because it is the absence of every other answer. */
const STATUS_RANK = Object.freeze({
  [STATUS.CONFIRMED]: 0,
  [STATUS.NOT_APPLICABLE]: 1,
  [STATUS.DRAFT]: 2,
  [STATUS.MISSING]: 3,
});

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const iso = (d) => {
  if (!d) return null;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
};

/** Where a fact came from. Every field optional; nulls rather than absences so
 *  the client can render one shape. */
function source({ kind, ref = null, version = null, at = null, by = null } = {}) {
  return {
    kind: kind || null,
    ref: ref === null ? null : str(ref) || null,
    version: version === null || version === undefined ? null : version,
    at: iso(at),
    by: str(by) || null,
  };
}

/** One candidate answer for a field. */
function candidate({
  status, value = null, authority = null, source: src = null, note = "",
  comparable = undefined, claim = "value", needsReconfirmation = false,
}) {
  if (!Object.values(STATUS).includes(status)) {
    throw new Error(`Unknown fact status "${status}"`);
  }
  /* ── RECONFIRMATION IS A KIND OF DRAFT, NOT A FIFTH STATUS ───────────────
     A value the buyer once agreed that has since been edited — or that can no
     longer be shown to be the version they agreed — is not confirmed. It is
     also not an ordinary draft: somebody has to go back to the buyer. That is
     a flag on a draft, so the four-label vocabulary every surface already
     renders stays the vocabulary, and a confirmed fact can never carry it. */
  if (needsReconfirmation && status !== STATUS.DRAFT) {
    throw new Error("Only a draft can need reconfirmation");
  }
  return {
    status,
    value,
    authority,
    source: src,
    note: note || "",
    /* What two candidates are compared on when they disagree. Defaults to the
       whole value; a field overrides it when only part of the value is a claim
       (a PO's number, not its upload time). */
    comparable: comparable === undefined ? value : comparable,
    needsReconfirmation: needsReconfirmation === true,
    /* ── WHAT KIND OF STATEMENT THIS IS ─────────────────────────────────
       Two candidates can only contradict each other if they are answering
       the same question. Merchandising's approved trim list for THIS order
       and R&D's approved specification of the STYLE are both confirmed, and
       they differ — because one refines the other, not because either is
       wrong. Comparing them demoted a perfectly agreed fabric to draft.
       Candidates that make a different kind of claim are never compared. */
    claim,
  };
}

/** Stable JSON: keys sorted, so equal values serialise equally. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  return JSON.stringify(value === undefined ? null : value);
}

const sameClaim = (a, b) => canonical(a) === canonical(b);

/**
 * Pick the fact for one field from its candidates.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 * Status first, then the caller's order. A CONFIRMED answer from a weaker
 * source beats a DRAFT from a stronger one: Merchandising's packaging revision
 * still in draft does not outrank the packing requirement Sales issued in the
 * handover — until Merchandising approves it, the handover is the instruction.
 *
 * ── AND THE EXCEPTION THAT KEEPS IT HONEST ─────────────────────────────────
 * If another CONFIRMED candidate disagrees with the chosen one, the field is
 * NOT confirmed. Two authorities that have each signed off on different
 * numbers have not agreed on anything, and picking the higher-ranked one
 * silently would present a live contradiction as a settled fact. The field
 * drops to draft and the note names both.
 *
 * Draft or default candidates that disagree do not demote anything — an
 * account's default AQL differing from the handover's agreed level is the
 * normal case, not a conflict. They are kept in `alsoOnRecord` so nothing a
 * source says is hidden.
 */
function resolve({ key, label, candidates = [], missingNote = "" }) {
  const present = candidates.filter(Boolean);

  if (!present.length) {
    return {
      key,
      label,
      status: STATUS.MISSING,
      value: null,
      authority: null,
      source: null,
      note: missingNote || "No source record holds this yet.",
      needsReconfirmation: false,
      alsoOnRecord: [],
      conflicts: [],
    };
  }

  /* Stable: the caller's order breaks ties within a status. */
  const ranked = present
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (STATUS_RANK[a.c.status] - STATUS_RANK[b.c.status]) || (a.i - b.i))
    .map((x) => x.c);

  const chosen = ranked[0];
  let status = chosen.status;
  let note = chosen.note;

  const conflicts = [];
  if (chosen.status === STATUS.CONFIRMED) {
    for (const other of ranked.slice(1)) {
      if (other.status !== STATUS.CONFIRMED) continue;
      if (other.claim !== chosen.claim) continue;
      if (!sameClaim(other.comparable, chosen.comparable)) {
        conflicts.push({ authority: other.authority, source: other.source, value: other.value });
      }
    }
    if (conflicts.length) {
      status = STATUS.DRAFT;
      const names = conflicts.map((c) => AUTHORITY_LABEL[c.authority] || c.authority).join(", ");
      note = [
        `${AUTHORITY_LABEL[chosen.authority] || chosen.authority} and ${names} have each confirmed a different value, so neither can be treated as agreed.`,
        note,
      ].filter(Boolean).join(" ");
    }
  }

  return {
    key,
    label,
    status,
    value: chosen.value,
    authority: chosen.authority,
    source: chosen.source,
    note,
    /* Set only by the candidate that won, and only while it is a draft — a
       field demoted by a conflict is a disagreement to settle, not a single
       value awaiting the buyer. */
    needsReconfirmation: status === STATUS.DRAFT && chosen.needsReconfirmation === true,
    alsoOnRecord: ranked.slice(1).map((c) => ({
      status: c.status,
      needsReconfirmation: c.needsReconfirmation === true,
      authority: c.authority,
      source: c.source,
      value: c.value,
      note: c.note,
    })),
    conflicts,
  };
}

/* The words the UI and the notes use. Kept beside the codes so a note can
   never name an authority the client would render differently. */
const AUTHORITY_LABEL = Object.freeze({
  [AUTHORITY.BUYER]: "the buyer",
  [AUTHORITY.MERCHANDISING]: "Merchandising",
  [AUTHORITY.SALES_HANDOVER]: "the Sales handover",
  [AUTHORITY.RND]: "R&D",
  [AUTHORITY.SALES]: "Sales",
  [AUTHORITY.ORDER_RECORD]: "the order record",
  [AUTHORITY.ENQUIRY]: "the enquiry",
  [AUTHORITY.BUYER_DEFAULT]: "the buyer's account defaults",
});

/** How many facts sit in each state — the one-line summary. */
function tally(facts) {
  const out = { confirmed: 0, draft: 0, missing: 0, not_applicable: 0, needsReconfirmation: 0 };
  for (const f of facts) {
    if (!f || out[f.status] === undefined) continue;
    out[f.status] += 1;
    /* Counted INSIDE draft as well as on its own: a reconfirmation is a
       draft, and the four status counts must still add up to the facts. */
    if (f.needsReconfirmation) out.needsReconfirmation += 1;
  }
  return out;
}

/**
 * A fingerprint of what the brief currently CONFIRMS.
 *
 * Values only — not sources or timestamps — so re-issuing identical content
 * leaves it unchanged and any change to an agreed value moves it. Nothing is
 * stored: it is returned so a caller (or a future handover issue) can compare
 * two readings without re-deriving the whole brief.
 */
function fingerprintOf(entries) {
  const confirmed = entries
    .filter((e) => e.fact && e.fact.status === STATUS.CONFIRMED)
    .map((e) => ({ scope: e.scope, key: e.fact.key, value: e.fact.value }))
    .sort((a, b) => (a.scope + a.key).localeCompare(b.scope + b.key));
  return crypto.createHash("sha256").update(canonical(confirmed)).digest("hex");
}

module.exports = {
  STATUS,
  AUTHORITY,
  AUTHORITY_LABEL,
  STATUS_RANK,
  source,
  candidate,
  resolve,
  tally,
  fingerprintOf,
  canonical,
  sameClaim,
  str,
  iso,
};
