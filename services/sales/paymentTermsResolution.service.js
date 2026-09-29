// services/sales/paymentTermsResolution.service.js
//
// SALES — WHEN THIS ORDER GETS PAID, AS A FACT A COSTING CAN READ.
//
// ── WHY THE EXISTING RESOLVER IS NOT THIS ───────────────────────────────────
// `services/paymentTerms.js` already resolves Account → PO and gates
// production on the advance. It is unchanged and still does exactly that. But
// it answers at the PO stage — long after a costing is calculated — and the
// only duration it produces is a display string built from free text
// (`negotiatedTerms`, `paymentTermsCode`). A financing cost cannot be worked
// out from prose.
//
// So this answers the same question one record earlier and structurally: what
// did Sales agree for THIS enquiry, in numbers, and has anybody confirmed it.
//
// ── COPIED AT CONFIRMATION, NEVER READ THROUGH ──────────────────────────────
// The Account is the DEFAULT. Its values are copied onto the enquiry when
// Sales confirms them, and never resolved live afterwards — a customer
// renegotiating in November must not silently restate what an order costed in
// March was quoted on. Before confirmation the account's terms are offered as
// a suggestion and labelled as one; after it, the enquiry speaks for itself.
//
// ── AND UNANSWERED IS NEVER CASH ────────────────────────────────────────────
// The single mistake worth designing against: an enquiry nobody has answered
// reading as an order paid up front, therefore costing nothing to finance.
// "Paid up front" is `advancePercent: 100`, which somebody states. Silence is
// `not_started`, and the two are different states here.
//
// ── A PLAN, WHERE THERE IS ONE ──────────────────────────────────────────────
// What Sales agrees is a PLAN — "60% on order confirmation, 20% on dispatch,
// 20% 45 days after the invoice" — and the two figures below (`advancePercent`
// and `creditDays`) can hold exactly one advance and one balance. They are
// what every record written before plans existed has, they are priced exactly
// as they always were, and they are not written for a record that has a plan:
// one agreement, in one place, never a figure and a plan disagreeing about
// the same order.
//
// The plan carries the whole answer, tranche by tranche, and the financing
// service prices each tranche on its own.
//
// ── NO MONEY LEAVES THIS FILE ───────────────────────────────────────────────
// No financing rate, no financing amount, no margin. The rate and the
// methodology are the Board's; this publishes the DURATION and the advance,
// which is what the Board's rule has been missing.
"use strict";

const { PAYMENT_DUE_FROM, PAYMENT_TERM_SHAPE_CODES } = require("../../constants/crm");
const plans = require("./paymentPlan.service");

const DUE_FROM_CODES = Object.freeze(PAYMENT_DUE_FROM.map((p) => p.code));
const DUE_FROM_LABEL = Object.freeze(
  Object.fromEntries(PAYMENT_DUE_FROM.map((p) => [p.code, p.label])),
);

const str = (v) => String(v ?? "").trim();

/**
 * THE SHAPE A SET OF FIGURES DESCRIBES.
 *
 * Every record written before shapes existed still has to read as the
 * agreement it is, so the shape is derived from the figures whenever one was
 * not stored. Only the combinations that have ONE honest name are named; a
 * part advance that also runs a credit period is a real agreement with no
 * short name, and it is `CUSTOM` rather than a shape that flatters it.
 *
 * Pure, and exported so the form and the server derive identically.
 */
function deriveShape(terms = {}) {
  const advance = usablePercent(terms.advancePercent);
  const days = usableDays(terms.creditDays);
  const from = str(terms.creditDaysFrom);
  if (advance === null && days === null) return null;
  if (advance === 100 && (days === null || days === 0)) return "FULL_ADVANCE";
  /* A balance that runs for a period is a credit term, and only when nothing
     was taken up front — otherwise it is two agreements at once. */
  if (days !== null && days > 0) {
    if (advance !== null && advance > 0) return "CUSTOM";
    if (from === "INVOICE") return "CREDIT_INVOICE";
    if (from === "DISPATCH") return "CREDIT_DISPATCH";
    if (from === "BILL_OF_LADING") return "CREDIT_BILL_OF_LADING";
    return "CUSTOM";
  }
  /* A balance due at a milestone: zero days, measured from the event. */
  if (advance !== null && advance >= 0 && advance < 100) {
    if (from === "DELIVERY") return "PART_ON_DELIVERY";
    if (from === "DISPATCH") return "PART_ON_DISPATCH";
    return "CUSTOM";
  }
  return "CUSTOM";
}

/**
 * A percent that can actually be used. 0 is valid and means "no advance".
 *
 * The null/"" check is not redundant: `Number(null)` and `Number("")` are both
 * 0, so an UNSET field would otherwise read as a deliberate "0% agreed" — and
 * the whole contract turns on those two being different answers. Mirrors
 * `services/paymentTerms.js::usablePercent` deliberately, so the enquiry and
 * the PO cannot disagree about what an empty field means.
 */
function usablePercent(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/** A whole number of days, or null. 0 is "due immediately", which is an answer. */
function usableDays(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 3650 ? n : null;
}

/* ── FIVE STATES, AND THREE OF THEM ARE ANSWERS ─────────────────────────────
 *
 * `NOT_APPLICABLE` is reachable ONLY through an explicit stated condition —
 * never from silence, and never from a 100% advance, which is a financing
 * duration of zero rather than an absence of financing. */
const TERMS = Object.freeze({
  CONFIRMED: "CONFIRMED",
  NOT_APPLICABLE: "NOT_APPLICABLE",
  DRAFT: "DRAFT",
  NOT_STARTED: "NOT_STARTED",
});

/**
 * The Account's standing terms, reduced to what is usable.
 *
 * `paymentTermsCode` and `negotiatedTerms` are deliberately NOT read for
 * numbers. They are prose a person wrote — "NET30 subject to inspection" — and
 * parsing days out of them would be a guess presented as an agreement.
 */
/** Is this one of the eight agreements this system speaks? */
const knownShape = (v) => PAYMENT_TERM_SHAPE_CODES.includes(str(v));

/* ── ONE RULE FOR THE SHAPE, AND IT IS NOT "BEST EFFORT" ────────────────────
 *
 *   ABSENT  — a record written before shapes existed. Derived from its own
 *             figures, because it describes a real agreement either way.
 *   KNOWN   — stored as sent.
 *   UNKNOWN — refused, by name. A code this system does not speak cannot be
 *             quietly replaced with one it does: the caller believes they
 *             saved "PAY_WHEN_YOU_CAN" and the record would say something
 *             else, which is a worse outcome than a refusal.
 */
function resolveShape(input, terms) {
  if (!("shape" in (input || {})) || !str(input.shape)) return { ok: true, shape: deriveShape(terms) };
  if (!knownShape(input.shape)) {
    return {
      ok: false, field: "shape",
      message: "That is not a payment term this system recognises. Choose one of the listed terms.",
    };
  }
  return { ok: true, shape: str(input.shape) };
}

function accountDefaults(account) {
  const from = str(account?.creditDaysFrom);
  return {
    advancePercent: usablePercent(account?.advancePercent),
    creditDays: usableDays(account?.creditDays),
    /* The customer's usual anchor. The Account carried no such field until
       Account-level commercial defaults were added, which is why the
       suggestion below used to leave it blank and make Sales re-answer it on
       every enquiry. An account that still has none is unchanged: blank, and
       Sales answers it here. */
    creditDaysFrom: DUE_FROM_CODES.includes(from) ? from : null,
    /* Carried for display so a screen can show what the customer's paper
       says beside the structured figures. Never parsed. */
    paymentTermsCode: str(account?.paymentTermsCode),
    negotiatedTerms: str(account?.negotiatedTerms),
  };
}

/**
 * WHAT IS STILL MISSING FROM THIS ENQUIRY'S TERMS.
 *
 * Pure and exported, so every branch is exercised without a database.
 */
function gaps(terms = {}) {
  const out = [];
  /* ── A PLAN IS ITS OWN COMPLETENESS ──────────────────────────────────
     Every row names its share, its event and its offset, and the shares add
     to exactly 100% — the plan service refuses anything less before it is
     ever stored. So there is nothing further to demand, and demanding the
     old advance/credit-days pair as well would be asking for the same
     agreement a second time in a form that cannot hold it. */
  if (Array.isArray(terms.plan) && terms.plan.length) {
    const checked = plans.validate(terms.plan);
    if (!checked.ok) out.push({ field: checked.field, message: checked.message });
    return out;
  }
  if (terms.notApplicable) {
    if (!str(terms.notApplicableReason)) {
      out.push({ field: "notApplicableReason", message: "Say why financing does not apply to this order." });
    }
    return out;
  }
  if (usablePercent(terms.advancePercent) === null) {
    out.push({
      field: "advancePercent",
      message: "Say what advance is agreed. No advance is 0% — an empty field is not an answer.",
    });
  }
  /* ── A FULL ADVANCE NEEDS NO BALANCE TERM ─────────────────────────────
     100% received before production leaves nothing outstanding, so there is
     no duration to measure and asking for one would be a field whose only
     honest answer is "not applicable". Anything less does have a balance. */
  if (usablePercent(terms.advancePercent) !== 100) {
    if (usableDays(terms.creditDays) === null) {
      out.push({
        field: "creditDays",
        message: "Say how long the balance is outstanding. Due immediately is 0 days.",
      });
    } else if (usableDays(terms.creditDays) > 0 && !DUE_FROM_CODES.includes(str(terms.creditDaysFrom))) {
      /* Only a non-zero duration needs an anchor. "0 days from the invoice"
         and "0 days from dispatch" are the same term. */
      out.push({
        field: "creditDaysFrom",
        message: "Say what the days are counted from — thirty days from the invoice and from the "
          + "bill of lading differ by the whole shipping time.",
      });
    }
  }

  /* ── AND A CUSTOM AGREEMENT SAYS WHAT IS CUSTOM ABOUT IT ──────────────
     "Custom" is the choice for everything the seven named terms cannot
     describe, which makes it the one that can be confirmed meaning nothing.
     Its figures are owed above like every other agreement's; what is owed
     here is whichever of the two ways of saying it is missing — the wording
     it was agreed in, or figures that themselves describe an agreement no
     named term covers. So "45 days after invoice" filed as Custom is asked
     what is custom about it, and so is a bare 0% / 0 days.

     Records written before shapes existed derive as CUSTOM precisely BECAUSE
     their figures describe something the named terms do not. They are never
     asked for wording — a sentence demanded now would turn a confirmed
     agreement from March into a draft — and this is the same rule the form
     applies, in the same words. */
  const figuresSayIt = deriveShape(terms) === "CUSTOM"
    && (usablePercent(terms.advancePercent) > 0 || usableDays(terms.creditDays) > 0);
  if (str(terms.shape) === "CUSTOM" && !out.length && !str(terms.note) && !figuresSayIt) {
    out.push({
      field: "note",
      message: "Write the custom terms as the customer agreed them. These figures on their own do not say "
        + "what makes this agreement custom.",
    });
  }
  return out;
}

/** Has anybody put these terms in force? */
function stateOf(terms = {}) {
  const started = terms.notApplicable
    || (Array.isArray(terms.plan) && terms.plan.length > 0)
    || usablePercent(terms.advancePercent) !== null
    || usableDays(terms.creditDays) !== null
    || Boolean(str(terms.creditDaysFrom))
    || Boolean(str(terms.note));
  if (!started) return TERMS.NOT_STARTED;
  if (gaps(terms).length) return TERMS.DRAFT;
  if (!terms.confirmedAt) return TERMS.DRAFT;
  return terms.notApplicable ? TERMS.NOT_APPLICABLE : TERMS.CONFIRMED;
}

/**
 * WHAT SALES IS OFFERED WHEN THEY OPEN AN UNANSWERED ENQUIRY.
 *
 * A suggestion drawn from the Account, clearly labelled as one. It is NOT
 * written anywhere until somebody confirms — a default silently saved is a
 * default nobody agreed to, and it would read afterwards as an agreement.
 */
function suggestionFor(account) {
  const d = accountDefaults(account);
  /* The agreement the customer usually makes, stored or — for an account
     recorded before shapes existed — derived from its own figures, so the
     enquiry inherits a named term rather than three loose numbers. */
  const shape = knownShape(account?.paymentTermsShape)
    ? str(account.paymentTermsShape)
    : deriveShape({
      advancePercent: d.advancePercent, creditDays: d.creditDays, creditDaysFrom: d.creditDaysFrom,
    });
  /* A recorded agreement is an answer even when its figures are settled deal
     by deal — "we always work on a part advance, the percentage depends". */
  const has = d.advancePercent !== null || d.creditDays !== null || Boolean(shape)
    || (Array.isArray(account?.paymentPlan) && account.paymentPlan.length > 0);
  return {
    available: has,
    advancePercent: d.advancePercent,
    creditDays: d.creditDays,
    /* Carried when the customer has an agreed anchor, and left blank when
       they do not — never invented, because "30 days" from the invoice and
       from the bill of lading are different agreements. */
    creditDaysFrom: d.creditDaysFrom,
    shape,
    /* The customer's standing plan, offered whole. An enquiry copies these
       rows and resolves them against its own order's dates; it never reads
       them again afterwards. */
    plan: Array.isArray(account?.paymentPlan) && account.paymentPlan.length
      ? account.paymentPlan.map((r) => ({
        name: str(r.name), percentage: r.percentage, dueEvent: str(r.dueEvent),
        offsetDirection: str(r.offsetDirection) || "ON", offsetDays: r.offsetDays || 0,
      }))
      : [],
    planSummary: Array.isArray(account?.paymentPlan) && account.paymentPlan.length
      ? plans.summarise(account.paymentPlan) : "",
    paymentTermsCode: d.paymentTermsCode,
    negotiatedTerms: d.negotiatedTerms,
    label: has ? "The customer's standing terms" : null,
  };
}

/**
 * VALIDATE AND NORMALISE A SUBMITTED SET OF TERMS.
 *
 * Refuses rather than repairs. A save that quietly corrects half of what it
 * was sent is a save nobody can reason about — and here it would be a save
 * that records terms the customer never agreed.
 *
 * @returns {{ok: true, terms: object} | {ok: false, field: string, message: string}}
 */
function validate(input = {}, { account = null, confirm = false, actor = null, existing = null, dates = null } = {}) {
  const notApplicable = input.notApplicable === true;

  if (notApplicable) {
    const reason = str(input.notApplicableReason);
    if (!reason) {
      return { ok: false, field: "notApplicableReason", message: "Say why financing does not apply to this order." };
    }
    return {
      ok: true,
      terms: {
        notApplicable: true,
        notApplicableReason: reason.slice(0, 500),
        note: str(input.note).slice(0, 1000),
        source: "ENQUIRY",
        ...(confirm ? { confirmedAt: new Date(), confirmedBy: actor || undefined } : {}),
      },
    };
  }

  /* ── THE PLAN, WHEN ONE IS SENT ───────────────────────────────────────
     It is the whole agreement, so it is settled before the old pair is even
     looked at. Sending `plan: []` clears it and hands the record back to the
     figures — which is how a plan is removed without a second endpoint. */
  const sendingPlan = "plan" in input;
  let plan = null;
  if (sendingPlan) {
    const checked = plans.validate(input.plan);
    if (!checked.ok) return { ok: false, field: checked.field, message: checked.message };
    plan = checked.plan;
  } else if (Array.isArray(existing?.plan) && existing.plan.length) {
    /* An edit that says nothing about the plan keeps the one already agreed:
       a save of the note must not quietly drop the instalments. */
    plan = existing.plan.map((r) => ({
      name: str(r.name), percentage: r.percentage, dueEvent: str(r.dueEvent),
      offsetDirection: str(r.offsetDirection) || "ON", offsetDays: r.offsetDays || 0,
    }));
  }

  /* ── EACH FIELD IS REFUSED BY NAME ────────────────────────────────────
     "Invalid payment terms" tells somebody nothing about which box to fix. */
  const advanceRaw = input.advancePercent;
  if (advanceRaw !== undefined && advanceRaw !== null && advanceRaw !== "" && usablePercent(advanceRaw) === null) {
    return { ok: false, field: "advancePercent", message: "An advance is a percentage between 0 and 100." };
  }
  const daysRaw = input.creditDays;
  if (daysRaw !== undefined && daysRaw !== null && daysRaw !== "" && usableDays(daysRaw) === null) {
    return { ok: false, field: "creditDays", message: "Credit days is a whole number of days, not negative." };
  }
  const from = str(input.creditDaysFrom);
  if (from && !DUE_FROM_CODES.includes(from)) {
    return { ok: false, field: "creditDaysFrom", message: "Choose what the days are counted from." };
  }

  const advancePercent = usablePercent(advanceRaw);
  const creditDays = usableDays(daysRaw);

  /* ── THE INCOMPATIBLE COMBINATION ─────────────────────────────────────
     A full advance leaves no balance, so a credit period against it is two
     statements that contradict each other. Refused rather than silently
     dropped: somebody who typed both meant one of them. */
  if (advancePercent === 100 && creditDays !== null && creditDays > 0) {
    return {
      ok: false, field: "creditDays",
      message: "A 100% advance leaves no balance outstanding. Clear the credit period, or reduce the advance.",
    };
  }

  const hasPlan = Array.isArray(plan) && plan.length > 0;
  const terms = {
    notApplicable: false,
    notApplicableReason: "",
    /* ── ONE AGREEMENT, IN ONE PLACE ────────────────────────────────
       A plan says everything the pair says and more, so the pair is not
       also written: two records of one agreement is one of them waiting to
       be wrong. A record that has no plan keeps its figures exactly as it
       always did. */
    /* Explicitly cleared, not merely omitted: the route MERGES these terms
       onto the record it already has, so an advance left over from before
       the plan would survive beside it — two records of one agreement, and
       the older one still readable. */
    ...(hasPlan ? { advancePercent: undefined, creditDays: undefined, creditDaysFrom: undefined } : {
      ...(advancePercent !== null ? { advancePercent } : {}),
      ...(creditDays !== null ? { creditDays } : {}),
      /* An anchor is meaningless without days, and a zero duration needs none. */
      ...(from && creditDays !== null && creditDays > 0 ? { creditDaysFrom: from } : {}),
    }),
    note: str(input.note).slice(0, 1000),
  };
  if (hasPlan) {
    /* Dated against THIS order, as far as this order knows. An event it has
       not dated leaves the row with no expected date rather than one counted
       forward from today. */
    terms.plan = plans.resolvePlan(plan, dates || {}).map((row) => ({
      name: row.name,
      percentage: row.percentage,
      dueEvent: row.dueEvent,
      offsetDirection: row.offsetDirection,
      offsetDays: row.offsetDays,
      ...(row.expectedDate ? { expectedDate: row.expectedDate } : {}),
    }));
  } else if (sendingPlan) {
    /* Explicitly cleared. */
    terms.plan = [];
  }
  /* ── THE SHAPE IS RECORDED, NEVER PARSED FOR FIGURES ─────────────────
     What the customer called the agreement, stored beside what it means. */
  if (hasPlan) {
    /* Read OUT of the rows, never stored beside them as a second answer:
       the name of an agreement and the agreement itself cannot be allowed to
       drift, and the rows are the record. */
    const named = plans.shapeOf(plan);
    if (named) terms.shape = named;
  } else {
    const chosen = resolveShape(input, terms);
    if (!chosen.ok) return { ok: false, field: chosen.field, message: chosen.message };
    if (chosen.shape) terms.shape = chosen.shape;
  }

  if (confirm) {
    const remaining = gaps(terms);
    if (remaining.length) {
      return { ok: false, field: remaining[0].field, message: remaining[0].message };
    }
    const d = accountDefaults(account);
    /* ── WHERE THESE NUMBERS CAME FROM ──────────────────────────────────
       `ACCOUNT` only when they match the standing terms exactly. Re-typing
       the customer's own figures is agreement, not deviation — flagging it
       as an override would make the flag meaningless, which is the same
       reasoning `services/paymentTerms.js` already applies to the PO. */
    const samePlan = hasPlan && Array.isArray(account?.paymentPlan)
      && account.paymentPlan.length === plan.length
      && account.paymentPlan.every((r, i) => str(r.name) === plan[i].name
        && Number(r.percentage) === plan[i].percentage
        && str(r.dueEvent) === plan[i].dueEvent
        && (str(r.offsetDirection) || "ON") === plan[i].offsetDirection
        && Number(r.offsetDays || 0) === plan[i].offsetDays);
    const matchesAccount = hasPlan ? samePlan : d.advancePercent !== null
      && d.advancePercent === (terms.advancePercent ?? null)
      && d.creditDays === (terms.creditDays ?? null)
      /* An account that records no anchor cannot be departed from on one:
         Sales answering the question the customer never answered is still
         the customer's terms. */
      && (d.creditDaysFrom === null || d.creditDaysFrom === (terms.creditDaysFrom ?? null));
    terms.source = matchesAccount ? "ACCOUNT" : "ENQUIRY";
    /* Snapshotted so an override stays auditable as a DIFFERENCE after the
       Account moves again. */
    terms.accountDefaultAtConfirmation = {
      ...(d.advancePercent !== null ? { advancePercent: d.advancePercent } : {}),
      ...(d.creditDays !== null ? { creditDays: d.creditDays } : {}),
      ...(d.creditDaysFrom ? { creditDaysFrom: d.creditDaysFrom } : {}),
      /* The customer's agreement as it read THEN, so an override stays legible
         as a difference after the account has moved again. */
      ...(knownShape(account?.paymentTermsShape) ? { shape: str(account.paymentTermsShape) } : {}),
      /* And the plan it stood on, row for row, so an override reads as a
         difference from what the customer usually agrees rather than as an
         agreement with no history. */
      ...(Array.isArray(account?.paymentPlan) && account.paymentPlan.length
        ? { plan: account.paymentPlan.map((r) => ({
          name: str(r.name), percentage: r.percentage, dueEvent: str(r.dueEvent),
          offsetDirection: str(r.offsetDirection) || "ON", offsetDays: r.offsetDays || 0,
        })) }
        : {}),
    };
    terms.confirmedAt = new Date();
    terms.confirmedBy = actor || undefined;
  } else if (existing?.confirmedAt) {
    /* An edit after confirmation re-opens the terms rather than keeping the
       old confirmation against new numbers. Confirming is a deliberate act
       and has to be repeated. */
    terms.confirmedAt = undefined;
    terms.confirmedBy = undefined;
    terms.source = undefined;
  }

  return { ok: true, terms };
}

/**
 * THE PROJECTION CENTRAL COSTING READS.
 *
 * Read-only, and carries no rate, no amount and no margin. What it publishes
 * is the DURATION and the advance — the two facts the Board's financing rule
 * has never had.
 *
 * ── AND IT IS ONLY EVER THE ENQUIRY'S OWN ───────────────────────────────────
 * No account fallback. An unconfirmed enquiry is unanswered, full stop: the
 * point of confirmation is that somebody looked at the standing terms and said
 * they apply to this order, and reading through would make that act
 * decorative.
 */
function projectionFor(enquiry) {
  const t = enquiry?.paymentTerms || {};
  const state = stateOf(t);
  const confirmed = state === TERMS.CONFIRMED;
  const advancePercent = usablePercent(t.advancePercent);
  const creditDays = usableDays(t.creditDays);

  return {
    state,
    /* Money is out from the moment the company spends until the customer
       pays. Published as the agreed terms; turning them into a number of
       financed days is the Board's methodology, not Sales' to assert. */
    advancePercent: confirmed ? advancePercent : null,
    creditDays: confirmed ? creditDays : null,
    creditDaysFrom: confirmed && creditDays > 0 ? (str(t.creditDaysFrom) || null) : null,
    creditDaysFromLabel: confirmed && creditDays > 0
      ? (DUE_FROM_LABEL[str(t.creditDaysFrom)] || null) : null,
    /* Display only. The plan below — or, for a record written before plans
       existed, the duration and the advance above — is what a financing cost
       is worked out from. Never this, and never the note. */
    shape: str(t.shape) || plans.shapeOf(t.plan) || deriveShape(t),
    /* ── THE AGREEMENT, TRANCHE BY TRANCHE ──────────────────────────
       Published only once confirmed, exactly like the figures: a draft plan
       is somebody's working note and pricing an order from one would make a
       quotation out of a conversation.

       Each row carries what was agreed (share, event, offset) and, where
       this order has dated that event, when it is expected to fall. The
       financing service charges from the OFFSET; the date is for the person
       reading it and for the customer's own document. */
    plan: confirmed && Array.isArray(t.plan) && t.plan.length
      ? t.plan.map((r) => ({
        name: str(r.name),
        percentage: r.percentage,
        dueEvent: str(r.dueEvent),
        offsetDirection: str(r.offsetDirection) || "ON",
        offsetDays: r.offsetDays || 0,
        expectedDate: r.expectedDate || null,
      }))
      : [],
    /* "60% due on order confirmation; 40% due 30 days after invoice date." */
    planSummary: confirmed && Array.isArray(t.plan) && t.plan.length ? plans.summarise(t.plan) : "",
    /* Which arithmetic prices this order, named rather than inferred from
       which fields happen to be filled in. */
    method: Array.isArray(t.plan) && t.plan.length ? "TRANCHE" : "LEGACY_SIMPLE",
    /* The events this order has not dated yet. A tranche hanging off one is
       still priced — its offset is agreed — but nobody can say WHEN it lands,
       and a document must not print a date nobody set. */
    undatedEvents: Array.isArray(t.plan) && t.plan.length
      ? [...new Set(t.plan.filter((r) => !r.expectedDate).map((r) => str(r.dueEvent)))]
      : [],
    notApplicable: state === TERMS.NOT_APPLICABLE,
    notApplicableReason: state === TERMS.NOT_APPLICABLE ? str(t.notApplicableReason) : "",
    /* Provenance, so a costing can say whether these were the customer's
       standing terms or something agreed for this order. */
    source: confirmed || state === TERMS.NOT_APPLICABLE ? (str(t.source) || null) : null,
    overridden: confirmed && str(t.source) === "ENQUIRY"
      && (t.accountDefaultAtConfirmation?.advancePercent !== undefined
        || t.accountDefaultAtConfirmation?.creditDays !== undefined),
    accountDefaultAtConfirmation: confirmed && t.accountDefaultAtConfirmation
      ? {
        advancePercent: usablePercent(t.accountDefaultAtConfirmation.advancePercent),
        creditDays: usableDays(t.accountDefaultAtConfirmation.creditDays),
      }
      : null,
    confirmedAt: confirmed || state === TERMS.NOT_APPLICABLE ? (t.confirmedAt || null) : null,
    confirmedByName: confirmed || state === TERMS.NOT_APPLICABLE ? str(t.confirmedBy?.name) : "",
    /* What is still missing, named by field, for a screen that has to say so. */
    gaps: state === TERMS.CONFIRMED || state === TERMS.NOT_APPLICABLE ? [] : gaps(t),
  };
}

module.exports = {
  TERMS,
  deriveShape,
  knownShape,
  resolveShape, DUE_FROM_CODES, DUE_FROM_LABEL,
  usablePercent, usableDays, accountDefaults,
  gaps, stateOf, suggestionFor, validate, projectionFor,
};
