// test/costing/sales-payment-terms.test.js
//
// SALES OWNS WHEN THIS ORDER GETS PAID.
//
// The claim everything hangs off: **an unanswered order is not a cash order.**
// "Paid up front" is an advance of 100%, which somebody states. Silence is
// silence, and financing is never costed at nil because nobody was asked.
//
// Also pinned: the Account is a DEFAULT that is copied at confirmation and
// never read through, so a customer renegotiating later cannot restate what a
// confirmed enquiry was quoted on; an override is auditable as a difference;
// zero advance and an unanswered advance are different answers; and no
// financing rate or amount is anywhere in the projection.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const svc = require("../../services/sales/paymentTermsResolution.service");
const { TERMS } = svc;

const account = (over = {}) => ({
  advancePercent: 30, creditDays: 45,
  paymentTermsCode: "NET45", negotiatedTerms: "", ...over,
});

const confirmed = (over = {}) => ({
  advancePercent: 30, creditDays: 45, creditDaysFrom: "INVOICE",
  source: "ACCOUNT", confirmedAt: new Date("2026-09-01"),
  confirmedBy: { name: "R. Menon" },
  accountDefaultAtConfirmation: { advancePercent: 30, creditDays: 45 },
  ...over,
});

/* ══ SILENCE IS NOT A CASH SALE ════════════════════════════════════════════ */

describe("an unanswered enquiry is unanswered", () => {
  test("nothing recorded is NOT_STARTED, and publishes no figures", () => {
    const p = svc.projectionFor({ paymentTerms: {} });
    expect(p.state).toBe(TERMS.NOT_STARTED);
    /* Null, never 0 and never 100. A costing reading either would be costing
       an assumption nobody made. */
    expect(p.advancePercent).toBeNull();
    expect(p.creditDays).toBeNull();
    expect(p.notApplicable).toBe(false);
  });

  test("an enquiry with no payment terms at all reads the same", () => {
    expect(svc.projectionFor({}).state).toBe(TERMS.NOT_STARTED);
    expect(svc.projectionFor(null).state).toBe(TERMS.NOT_STARTED);
  });

  test("zero advance and an unanswered advance are different answers", () => {
    /* `Number(null)` and `Number("")` are both 0, which is exactly how an
       unset field becomes a deliberate "0% agreed" if nobody checks. */
    expect(svc.usablePercent(0)).toBe(0);
    expect(svc.usablePercent(null)).toBeNull();
    expect(svc.usablePercent("")).toBeNull();
    expect(svc.usablePercent(undefined)).toBeNull();

    const zero = svc.projectionFor({
      paymentTerms: confirmed({ advancePercent: 0, accountDefaultAtConfirmation: {} }),
    });
    expect(zero.state).toBe(TERMS.CONFIRMED);
    expect(zero.advancePercent).toBe(0);

    const unanswered = svc.projectionFor({ paymentTerms: { creditDays: 45 } });
    expect(unanswered.state).toBe(TERMS.DRAFT);
    expect(unanswered.advancePercent).toBeNull();
    expect(unanswered.gaps.map((g) => g.field)).toContain("advancePercent");
  });

  test("a 100% advance is a duration of zero, never 'no financing'", () => {
    const p = svc.projectionFor({
      paymentTerms: confirmed({ advancePercent: 100, creditDays: undefined, creditDaysFrom: undefined }),
    });
    expect(p.state).toBe(TERMS.CONFIRMED);
    expect(p.advancePercent).toBe(100);
    /* Not `notApplicable`: the money is simply out for no time. Conflating
       them would let a full-advance order and an exempt one report alike. */
    expect(p.notApplicable).toBe(false);
  });
});

/* ══ THE ACCOUNT IS A DEFAULT, NOT A LIVE INPUT ════════════════════════════ */

describe("Account defaults", () => {
  test("are offered as a labelled suggestion, and written nowhere", () => {
    const s = svc.suggestionFor(account());
    expect(s.available).toBe(true);
    expect(s.advancePercent).toBe(30);
    expect(s.creditDays).toBe(45);
    /* The Account records no anchor — `creditDays` predates the question —
       so the suggestion leaves it for Sales rather than inventing one the
       customer never agreed. */
    expect(s.creditDaysFrom).toBeNull();
    expect(s.label).toBe("The customer's standing terms");
  });

  test("an account with nothing structured offers nothing", () => {
    const s = svc.suggestionFor({ paymentTermsCode: "NET30", negotiatedTerms: "60% against BL" });
    expect(s.available).toBe(false);
    /* Free text is carried for a person to read and never parsed for days:
       "NET30 subject to inspection" is prose, and a duration guessed out of
       it would be presented as an agreement. */
    expect(s.paymentTermsCode).toBe("NET30");
    expect(s.advancePercent).toBeNull();
    expect(s.creditDays).toBeNull();
  });

  test("confirming the account's own figures records ACCOUNT, not an override", () => {
    const r = svc.validate(
      { advancePercent: 30, creditDays: 45, creditDaysFrom: "INVOICE" },
      { account: account(), confirm: true, actor: { name: "R. Menon" } },
    );
    expect(r.ok).toBe(true);
    /* Re-typing the standing terms is agreement, not deviation. Flagging it
       would make the override flag meaningless — the same reasoning
       services/paymentTerms.js already applies to the PO. */
    expect(r.terms.source).toBe("ACCOUNT");
    expect(r.terms.accountDefaultAtConfirmation).toEqual({ advancePercent: 30, creditDays: 45 });
  });

  test("a later Account change cannot restate a confirmed enquiry", () => {
    const enquiry = { paymentTerms: confirmed() };
    const before = svc.projectionFor(enquiry);
    /* The customer renegotiates to 50/60. The Account moves; the enquiry
       does not, because its figures were COPIED at confirmation rather than
       read through. */
    const after = svc.projectionFor(enquiry);
    expect(after).toEqual(before);
    expect(after.advancePercent).toBe(30);
    expect(after.creditDays).toBe(45);
    /* And the projection takes no account argument at all — there is no
       parameter through which a later default could reach it. */
    expect(svc.projectionFor.length).toBe(1);
  });
});

/* ══ AN OVERRIDE IS EXPLICIT AND AUDITABLE ═════════════════════════════════ */

describe("Enquiry overrides", () => {
  test("different figures record ENQUIRY and snapshot what they differ from", () => {
    const r = svc.validate(
      { advancePercent: 50, creditDays: 30, creditDaysFrom: "BILL_OF_LADING" },
      { account: account(), confirm: true, actor: { name: "R. Menon" } },
    );
    expect(r.terms.source).toBe("ENQUIRY");
    /* Snapshotted, so the deviation stays auditable as a DIFFERENCE after
       the Account moves again. */
    expect(r.terms.accountDefaultAtConfirmation).toEqual({ advancePercent: 30, creditDays: 45 });

    const p = svc.projectionFor({ paymentTerms: r.terms });
    expect(p.source).toBe("ENQUIRY");
    expect(p.overridden).toBe(true);
    expect(p.accountDefaultAtConfirmation).toEqual({ advancePercent: 30, creditDays: 45 });
  });

  test("an account with no standing terms makes every enquiry its own source", () => {
    const r = svc.validate(
      { advancePercent: 40, creditDays: 30, creditDaysFrom: "INVOICE" },
      { account: {}, confirm: true },
    );
    expect(r.terms.source).toBe("ENQUIRY");
    /* Nothing to differ FROM, so nothing is claimed as a deviation. */
    expect(svc.projectionFor({ paymentTerms: r.terms }).overridden).toBe(false);
  });

  test("editing confirmed terms re-opens them rather than keeping the old signature", () => {
    const r = svc.validate(
      { advancePercent: 50, creditDays: 30, creditDaysFrom: "INVOICE" },
      { account: account(), confirm: false, existing: confirmed() },
    );
    /* A confirmation is a deliberate act about specific numbers. Carrying it
       across an edit would leave somebody's name against figures they never
       saw. */
    expect(r.terms.confirmedAt).toBeUndefined();
    expect(r.terms.source).toBeUndefined();
    expect(svc.projectionFor({ paymentTerms: { ...confirmed(), ...r.terms } }).state).toBe(TERMS.DRAFT);
  });
});

/* ══ VALIDATION ════════════════════════════════════════════════════════════ */

describe("what the server refuses", () => {
  test.each([
    ["advancePercent", { advancePercent: 101 }],
    ["advancePercent", { advancePercent: -1 }],
    ["advancePercent", { advancePercent: "half" }],
    ["creditDays", { creditDays: -5 }],
    ["creditDays", { creditDays: 12.5 }],
    ["creditDaysFrom", { creditDaysFrom: "WHENEVER" }],
  ])("refuses a bad %s by name", (field, patch) => {
    const r = svc.validate({ advancePercent: 30, creditDays: 45, ...patch }, { account: account() });
    expect(r.ok).toBe(false);
    expect(r.field).toBe(field);
  });

  test("a 100% advance with a credit period is refused as a contradiction", () => {
    const r = svc.validate(
      { advancePercent: 100, creditDays: 30, creditDaysFrom: "INVOICE" },
      { account: account() },
    );
    expect(r.ok).toBe(false);
    expect(r.field).toBe("creditDays");
    expect(r.message).toMatch(/leaves no balance/);
  });

  test("a 100% advance with zero credit days is fine", () => {
    const r = svc.validate({ advancePercent: 100, creditDays: 0 }, { account: account(), confirm: true });
    expect(r.ok).toBe(true);
    expect(r.terms.advancePercent).toBe(100);
  });

  test("confirming an incomplete set is refused, naming the first gap", () => {
    const r = svc.validate({ advancePercent: 30 }, { account: account(), confirm: true });
    expect(r.ok).toBe(false);
    expect(r.field).toBe("creditDays");
  });

  test("a non-zero duration needs its anchor; a zero one does not", () => {
    expect(svc.gaps({ advancePercent: 30, creditDays: 45 }).map((g) => g.field)).toEqual(["creditDaysFrom"]);
    expect(svc.gaps({ advancePercent: 30, creditDays: 0 })).toEqual([]);
    /* "0 days from the invoice" and "0 days from dispatch" are the same term,
       so asking would be a field with no wrong answer. */
    const r = svc.validate({ advancePercent: 30, creditDays: 0 }, { account: account(), confirm: true });
    expect(r.ok).toBe(true);
    expect(r.terms.creditDaysFrom).toBeUndefined();
  });

  test("an anchor with no duration is not stored", () => {
    const r = svc.validate({ advancePercent: 100, creditDaysFrom: "INVOICE" }, { account: account() });
    expect(r.ok).toBe(true);
    expect(r.terms.creditDaysFrom).toBeUndefined();
  });
});

/* ══ NOT APPLICABLE IS A STATED CONDITION ══════════════════════════════════ */

describe("not applicable", () => {
  test("needs a reason, and is refused without one", () => {
    const r = svc.validate({ notApplicable: true }, { account: account() });
    expect(r.ok).toBe(false);
    expect(r.field).toBe("notApplicableReason");
  });

  test("with a reason it is an answer, and does not block", () => {
    const r = svc.validate(
      { notApplicable: true, notApplicableReason: "Intercompany transfer, billed at cost." },
      { account: account(), confirm: true, actor: { name: "R. Menon" } },
    );
    expect(r.ok).toBe(true);
    const p = svc.projectionFor({ paymentTerms: r.terms });
    expect(p.state).toBe(TERMS.NOT_APPLICABLE);
    expect(p.notApplicable).toBe(true);
    expect(p.notApplicableReason).toMatch(/Intercompany/);
    expect(p.gaps).toEqual([]);
  });

  test("it is never reachable from silence", () => {
    for (const terms of [{}, { advancePercent: 30 }, { creditDays: 45 }, { note: "tbd" }]) {
      expect(svc.projectionFor({ paymentTerms: terms }).notApplicable).toBe(false);
    }
  });
});

/* ══ READINESS TRANSITIONS ═════════════════════════════════════════════════ */

describe("the states, in order", () => {
  test("not started → draft → confirmed", () => {
    expect(svc.stateOf({})).toBe(TERMS.NOT_STARTED);
    expect(svc.stateOf({ advancePercent: 30 })).toBe(TERMS.DRAFT);
    expect(svc.stateOf({ advancePercent: 30, creditDays: 45, creditDaysFrom: "INVOICE" })).toBe(TERMS.DRAFT);
    expect(svc.stateOf(confirmed())).toBe(TERMS.CONFIRMED);
  });

  test("complete but unconfirmed is still a draft — confirming is the act", () => {
    const complete = { advancePercent: 30, creditDays: 45, creditDaysFrom: "INVOICE" };
    expect(svc.gaps(complete)).toEqual([]);
    expect(svc.stateOf(complete)).toBe(TERMS.DRAFT);
    /* And a costing reads it as unanswered, because nobody has said these
       terms apply to this order. */
    expect(svc.projectionFor({ paymentTerms: complete }).advancePercent).toBeNull();
  });

  test("a note alone starts the record without completing it", () => {
    expect(svc.stateOf({ note: "Waiting on the buyer" })).toBe(TERMS.DRAFT);
  });
});

/* ══ NO MONEY LEAVES THE PROJECTION ════════════════════════════════════════ */

describe("what may not cross this boundary", () => {
  test("no financing rate, amount or margin is published", () => {
    const p = svc.projectionFor({ paymentTerms: confirmed() });
    const s = JSON.stringify(p);
    expect(s).not.toMatch(/financingRate|ratePercent|Minor|amount|margin|₹/i);
    expect(p.financingRatePercent).toBeUndefined();
    expect(p.financingCost).toBeUndefined();
    /* What IS published is the agreement: the advance, the duration and
       what it runs from. */
    expect(p.advancePercent).toBe(30);
    expect(p.creditDays).toBe(45);
    expect(p.creditDaysFrom).toBe("INVOICE");
    expect(p.creditDaysFromLabel).toBe("Invoice date");
  });

  test("and the service names no rate anywhere in its own source", () => {
    const source = require("fs").readFileSync(
      require.resolve("../../services/sales/paymentTermsResolution.service"), "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    /* The rate and the methodology that turn a duration into a cost of
       capital are the Board's. Nothing here stands in for either. */
    expect(source).not.toMatch(/financingRate|interestRate|annualised|costOfCapital/i);
  });

  test("confirmation provenance is published; the confirmer's identity is a name only", () => {
    const p = svc.projectionFor({ paymentTerms: confirmed() });
    expect(p.confirmedByName).toBe("R. Menon");
    expect(p.confirmedAt).toEqual(new Date("2026-09-01"));
    /* No employee id, no email — a readiness panel needs to know somebody
       signed it, not who they are in the HR system. */
    expect(JSON.stringify(p)).not.toMatch(/employeeId|email|_id/);
  });
});
