const test = require("node:test");
const assert = require("node:assert/strict");
const { resolvePaymentTerms, advanceGate } = require("./paymentTerms");

const acct = (o = {}) => ({ advancePercent: 30, paymentTermsCode: "NET30", ...o });
const po = (advancePercent, balanceTerms) => ({ paymentTerms: { advancePercent, balanceTerms } });

/* ── Which terms apply ───────────────────────────────────────────────────── */

test("a journey with no terms of its own inherits the account's", () => {
  const t = resolvePaymentTerms(acct(), {});
  assert.equal(t.advancePercent, 30);
  assert.equal(t.source, "account");
  assert.equal(t.overridden, false);
});

test("the journey's own figure wins, and is marked as an override", () => {
  const t = resolvePaymentTerms(acct(), po(50));
  assert.equal(t.advancePercent, 50);
  assert.equal(t.source, "journey");
  assert.equal(t.accountPercent, 30);
  assert.equal(t.overridden, true);
});

test("re-stating the account's own figure is agreement, NOT an override", () => {
  // Otherwise every PO that confirms the standing terms reads as an exception,
  // and the flag stops meaning anything.
  const t = resolvePaymentTerms(acct(), po(30));
  assert.equal(t.advancePercent, 30);
  assert.equal(t.overridden, false);
});

test("0% on the journey is a real answer that overrides a 30% account", () => {
  // "This one goes out with nothing up front" has to be expressible, and must
  // not fall through to the account's 30%.
  const t = resolvePaymentTerms(acct(), po(0));
  assert.equal(t.advancePercent, 0);
  assert.equal(t.source, "journey");
  assert.equal(t.overridden, true);
});

test("no terms anywhere is 'none', not a guess", () => {
  const t = resolvePaymentTerms({ paymentTermsCode: "NET30" }, {});
  assert.equal(t.advancePercent, null);
  assert.equal(t.source, "none");
  assert.equal(t.overridden, false);
});

test("a missing account does not throw", () => {
  const t = resolvePaymentTerms(null, null);
  assert.equal(t.advancePercent, null);
  assert.equal(t.source, "none");
});

test("nonsense percents are ignored rather than enforced", () => {
  for (const bad of ["abc", -5, 140, null, undefined, NaN]) {
    assert.equal(resolvePaymentTerms({ advancePercent: bad }, {}).advancePercent, null, String(bad));
  }
});

test("balance terms: the journey's words beat the account's", () => {
  assert.equal(resolvePaymentTerms(acct({ negotiatedTerms: "NET45" }), po(30, "60/40 against BL")).balanceTerms, "60/40 against BL");
});

test("balance terms fall back to the account's code and credit days", () => {
  assert.equal(resolvePaymentTerms({ paymentTermsCode: "NET30", creditDays: 30 }, {}).balanceTerms, "NET30 · 30 days");
});

/* ── Whether the advance clears ──────────────────────────────────────────── */

const T = (p) => ({ advancePercent: p });

test("no advance agreed: nothing to satisfy, order is free to proceed", () => {
  const g = advanceGate(T(null), { orderValue: 100000, received: 0 });
  assert.equal(g.required, false);
  assert.equal(g.cleared, true);
});

test("an explicit 0% is also free to proceed", () => {
  const g = advanceGate(T(0), { orderValue: 100000, received: 0 });
  assert.equal(g.required, false);
  assert.equal(g.cleared, true);
});

test("30% of 100000 needs 30000 — 0 received does not clear", () => {
  const g = advanceGate(T(30), { orderValue: 100000, received: 0 });
  assert.equal(g.required, true);
  assert.equal(g.cleared, false);
  assert.equal(g.amountRequired, 30000);
  assert.equal(g.shortfall, 30000);
});

test("part payment still does not clear, and reports what is short", () => {
  const g = advanceGate(T(30), { orderValue: 100000, received: 25000 });
  assert.equal(g.cleared, false);
  assert.equal(g.shortfall, 5000);
});

test("exactly the required amount clears", () => {
  assert.equal(advanceGate(T(30), { orderValue: 100000, received: 30000 }).cleared, true);
});

test("overpayment clears and never reports a negative shortfall", () => {
  const g = advanceGate(T(30), { orderValue: 100000, received: 45000 });
  assert.equal(g.cleared, true);
  assert.equal(g.shortfall, 0);
});

test("a sub-rupee float remainder still clears", () => {
  // 33.333% of 100000 = 33333.0000000001 against 33333 received. That is a
  // paid advance, and must not be a gate nobody on earth could clear.
  const g = advanceGate(T(33.333), { orderValue: 100000, received: 33333 });
  assert.equal(g.cleared, true);
});

test("an order with no value cannot be gated, and says why", () => {
  // Blocking here would name the wrong problem — the advance is unknown
  // because the ORDER has no value, not because the customer has not paid.
  const g = advanceGate(T(30), { orderValue: 0, received: 0 });
  assert.equal(g.required, false);
  assert.equal(g.cleared, true);
  assert.match(g.reason, /no value yet/);
});

test("currency is carried through for the message", () => {
  assert.equal(advanceGate(T(30), { orderValue: 1000, received: 0, currency: "USD" }).currency, "USD");
  assert.equal(advanceGate(T(30), { orderValue: 1000, received: 0 }).currency, "INR");
});

test("end to end: account terms alone can block a journey that never set any", () => {
  const terms = resolvePaymentTerms(acct({ advancePercent: 40 }), {});
  const gate = advanceGate(terms, { orderValue: 250000, received: 50000 });
  assert.equal(gate.required, true);
  assert.equal(gate.cleared, false);
  assert.equal(gate.amountRequired, 100000);
  assert.equal(gate.shortfall, 50000);
});
