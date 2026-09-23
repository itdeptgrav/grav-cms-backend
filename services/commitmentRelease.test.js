"use strict";
/**
 * services/commitmentRelease.test.js
 *
 * Which part of a promise a bill discharges. Pure — the arithmetic is where
 * this goes wrong quietly, and none of it is visible from a route test.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const svc = require("./commitmentRelease.service");

const entry = (over = {}) => ({ _id: "e1", amount: 1000, taxAmount: 180, ...over });
const alloc = (over = {}) => ({
  spendLineId: "l1", amount: 1180, releasedAmount: 0, status: "committed", ...over,
});
const commitment = (allocations) => ({ _id: "c1", amount: 0, allocations });
const voucher = (over = {}) => ({ _id: "v1", voucherNumber: "PUR-1", grandTotal: null, ...over });

/* ══ WHAT A BILL LINE BILLS ════════════════════════════════════════════════ */

test("a line's gross is its amount plus its tax", () => {
  assert.equal(svc.lineGrossPaise(entry({ amount: 1000, taxAmount: 180 })), 118000);
  assert.equal(svc.lineGrossPaise(entry({ amount: 1000, taxAmount: 0 })), 100000);
});

test("only lines carrying a request line are mapped", () => {
  const out = svc.attributeByLine({ entries: [
    entry({ _id: "a", spendLineId: "l1" }),
    entry({ _id: "b" }),
  ] });
  assert.equal(out.lines.length, 1);
  assert.equal(out.lines[0].spendLineId, "l1");
  /* An unrelated charge line must never silently release a request line. */
  assert.equal(out.unmappedCount, 1);
  assert.equal(out.unmappedAmount, 1180);
});

test("two bill lines on one request line aggregate", () => {
  const out = svc.attributeByLine({ entries: [
    entry({ _id: "a", spendLineId: "l1", amount: 600, taxAmount: 0 }),
    entry({ _id: "b", spendLineId: "l1", amount: 400, taxAmount: 0 }),
  ] });
  assert.equal(out.lines.length, 1);
  assert.equal(out.lines[0].amount, 1000);
  assert.deepEqual(out.lines[0].voucherLineIds, ["a", "b"]);
});

test("a genuine voucher adjustment is spread over the mapped lines", () => {
  const out = svc.attributeByLine({
    entries: [
      entry({ _id: "a", spendLineId: "l1", amount: 600, taxAmount: 0 }),
      entry({ _id: "b", spendLineId: "l2", amount: 400, taxAmount: 0 }),
    ],
    /* A ₹10 round-off belonging to no line. */
    grandTotal: 990,
  });
  assert.deepEqual(out.lines.map((l) => l.amount), [594, 396]);
  assert.equal(out.lines.reduce((t, l) => t + Math.round(l.amount * 100), 0), 99000);
});

test("an unmapped charge is not an adjustment", () => {
  const out = svc.attributeByLine({
    entries: [
      entry({ _id: "a", spendLineId: "l1", amount: 1000, taxAmount: 0 }),
      entry({ _id: "b", amount: 200, taxAmount: 0 }),
    ],
    grandTotal: 1200,
  });
  /* Treating the ₹200 freight as an adjustment would inflate what the mapped
     line discharges to ₹1,200 — money nobody billed against that request line. */
  assert.equal(out.lines[0].amount, 1000);
  assert.equal(out.unmappedAmount, 200);
});

test("the adjustment remainder is deterministic", () => {
  const args = {
    entries: [
      entry({ _id: "a", spendLineId: "l1", amount: 100, taxAmount: 0 }),
      entry({ _id: "b", spendLineId: "l2", amount: 100, taxAmount: 0 }),
      entry({ _id: "c", spendLineId: "l3", amount: 100, taxAmount: 0 }),
    ],
    grandTotal: 300.1,
  };
  const first = svc.attributeByLine(args);
  const again = svc.attributeByLine(args);
  assert.deepEqual(first.lines.map((l) => l.amount), again.lines.map((l) => l.amount));
  assert.equal(first.lines.reduce((t, l) => t + Math.round(l.amount * 100), 0), 30010);
});

/* ══ WHAT IT RELEASES ══════════════════════════════════════════════════════ */

test("a legacy commitment with no allocations keeps whole-document release", () => {
  assert.equal(svc.planRelease({ commitment: { _id: "c1" }, voucher: voucher() }).mode,
    "whole_document");
  assert.equal(svc.planRelease({ commitment: commitment([]), voucher: voucher() }).mode,
    "whole_document");
});

test("only the billed line releases", () => {
  const c = commitment([
    alloc({ spendLineId: "l1", amount: 1180 }),
    alloc({ spendLineId: "l2", amount: 5000 }),
    alloc({ spendLineId: "l3", amount: 2000 }),
    alloc({ spendLineId: "l4", amount: 3000 }),
  ]);
  const plan = svc.planRelease({
    commitment: c,
    voucher: voucher(),
    entries: [entry({ spendLineId: "l1" })],
  });
  assert.equal(plan.decisions.length, 1);
  assert.equal(plan.decisions[0].spendLineId, "l1");
  assert.equal(plan.decisions[0].amount, 1180);
  /* The other three heads were never billed and stay promised. */
  assert.equal(plan.matchedAllocations, 1);
});

test("one voucher covering lines from several heads releases each", () => {
  const c = commitment([
    alloc({ spendLineId: "l1", amount: 6000 }),
    alloc({ spendLineId: "l2", amount: 4000 }),
  ]);
  const plan = svc.planRelease({
    commitment: c,
    voucher: voucher(),
    entries: [
      entry({ _id: "a", spendLineId: "l1", amount: 6000, taxAmount: 0 }),
      entry({ _id: "b", spendLineId: "l2", amount: 4000, taxAmount: 0 }),
    ],
  });
  assert.deepEqual(plan.decisions.map((d) => d.amount), [6000, 4000]);
});

test("a partial bill releases only what it billed", () => {
  const c = commitment([alloc({ spendLineId: "l1", amount: 10000 })]);
  const plan = svc.planRelease({
    commitment: c,
    voucher: voucher(),
    entries: [entry({ spendLineId: "l1", amount: 4000, taxAmount: 0 })],
  });
  assert.equal(plan.decisions[0].amount, 4000);
  assert.equal(plan.decisions[0].remainingAfter, 6000);
});

test("a second partial bill releases the rest, progressively", () => {
  const c = commitment([
    alloc({ spendLineId: "l1", amount: 10000, releasedAmount: 4000, status: "partially_released" }),
  ]);
  const plan = svc.planRelease({
    commitment: c,
    voucher: voucher({ _id: "v2" }),
    entries: [entry({ spendLineId: "l1", amount: 6000, taxAmount: 0 })],
  });
  assert.equal(plan.decisions[0].amount, 6000);
  assert.equal(plan.decisions[0].remainingAfter, 0);
});

test("over-billing exhausts the promise and never goes negative", () => {
  const c = commitment([alloc({ spendLineId: "l1", amount: 6000 })]);
  const plan = svc.planRelease({
    commitment: c,
    voucher: voucher(),
    entries: [entry({ spendLineId: "l1", amount: 9000, taxAmount: 0 })],
  });
  /* The extra ₹3,000 is real spending the voucher records. It is not a promise
     anybody made, so there is nothing more here to discharge — and a negative
     remaining would give the head money it never had. */
  assert.equal(plan.decisions[0].amount, 6000);
  assert.equal(plan.decisions[0].remainingAfter, 0);
  assert.equal(plan.decisions[0].overBilled, true);
});

test("an already fully released line releases nothing more", () => {
  const c = commitment([
    alloc({ spendLineId: "l1", amount: 6000, releasedAmount: 6000, status: "released" }),
  ]);
  const plan = svc.planRelease({
    commitment: c,
    voucher: voucher({ _id: "v9" }),
    entries: [entry({ spendLineId: "l1", amount: 6000, taxAmount: 0 })],
  });
  assert.equal(plan.decisions.length, 0);
});

test("the same voucher never releases twice", () => {
  const c = commitment([alloc({
    spendLineId: "l1", amount: 6000, releasedAmount: 6000,
    releases: [{ voucherId: "v1", amount: 6000 }],
  })]);
  const plan = svc.planRelease({
    commitment: c,
    voucher: voucher({ _id: "v1" }),
    entries: [entry({ spendLineId: "l1", amount: 6000, taxAmount: 0 })],
  });
  assert.equal(plan.mode, "already_released");
  assert.equal(plan.decisions.length, 0);
});

test("a different voucher is not mistaken for the same one", () => {
  const c = commitment([alloc({
    spendLineId: "l1", amount: 10000, releasedAmount: 4000,
    releases: [{ voucherId: "v1", amount: 4000 }],
  })]);
  const plan = svc.planRelease({
    commitment: c,
    voucher: voucher({ _id: "v2" }),
    entries: [entry({ spendLineId: "l1", amount: 6000, taxAmount: 0 })],
  });
  assert.equal(plan.mode, "line_wise");
  assert.equal(plan.decisions[0].amount, 6000);
});

/* ══ WHAT IT REFUSES TO GUESS ══════════════════════════════════════════════ */

test("a line-wise commitment with no mapped lines releases nothing, and says why", () => {
  const c = commitment([alloc({ spendLineId: "l1", amount: 6000 })]);
  const plan = svc.planRelease({
    commitment: c,
    voucher: voucher(),
    entries: [entry({ _id: "a" })],
  });
  /* NOT whole-document. Releasing because the mapping was missing is the
     behaviour being removed, and here it would free money with no evidence
     anybody had billed for it. */
  assert.notEqual(plan.mode, "whole_document");
  assert.equal(plan.decisions.length, 0);
  assert.match(plan.warning, /No line on this bill carries a request line/i);
});

test("a bill whose lines match no allocation says so", () => {
  const c = commitment([alloc({ spendLineId: "l1", amount: 6000 })]);
  const plan = svc.planRelease({
    commitment: c,
    voucher: voucher(),
    entries: [entry({ spendLineId: "SOMETHING-ELSE" })],
  });
  assert.equal(plan.decisions.length, 0);
  assert.match(plan.warning, /do not match any allocation/i);
});

test("a partly mapped bill warns about the lines that mapped to nothing", () => {
  const c = commitment([alloc({ spendLineId: "l1", amount: 6000 })]);
  const plan = svc.planRelease({
    commitment: c,
    voucher: voucher(),
    entries: [
      entry({ _id: "a", spendLineId: "l1", amount: 6000, taxAmount: 0 }),
      entry({ _id: "b", amount: 500, taxAmount: 0 }),
    ],
  });
  assert.equal(plan.decisions.length, 1);
  assert.match(plan.warning, /carry no request line/i);
});

test("nothing is matched by name, amount or position", () => {
  const c = commitment([
    alloc({ spendLineId: "l1", amount: 1180 }),
    alloc({ spendLineId: "l2", amount: 1180 }),
  ]);
  /* Same name, same amount, same order — and no ids. */
  const plan = svc.planRelease({
    commitment: c,
    voucher: voucher(),
    entries: [
      entry({ _id: "a", stockItemName: "Fabric", amount: 1000, taxAmount: 180 }),
      entry({ _id: "b", stockItemName: "Fabric", amount: 1000, taxAmount: 180 }),
    ],
  });
  assert.equal(plan.decisions.length, 0);
});

/* ══ APPLY AND RESTORE ═════════════════════════════════════════════════════ */

/** A minimal document stand-in: the engine only calls `save()`. */
const doc = (allocations, over = {}) => ({
  _id: "c1", amount: allocations.reduce((t, a) => t + a.amount, 0),
  allocations, status: "committed", saved: 0,
  async save() { this.saved += 1; },
  ...over,
});

test("applying writes a release row and leaves the approved amount alone", async () => {
  const c = doc([alloc({ spendLineId: "l1", amount: 10000 })]);
  await svc.applyRelease({
    commitment: c, voucher: voucher({ voucherNumber: "PUR-7" }),
    actor: { name: "Asha", email: "a@x" },
    entries: [entry({ spendLineId: "l1", amount: 4000, taxAmount: 0 })],
  });

  const a = c.allocations[0];
  /* What was reserved stays what was reserved. */
  assert.equal(a.amount, 10000);
  assert.equal(a.releasedAmount, 4000);
  assert.equal(a.remainingAmount, 6000);
  assert.equal(a.status, "partially_released");
  assert.equal(a.releases.length, 1);
  assert.equal(a.releases[0].voucherNumber, "PUR-7");
  assert.equal(a.releases[0].byName, "Asha");
  /* The document is not done while anything remains. */
  assert.equal(c.status, "partially_released");
});

test("the document is released only when every allocation is", async () => {
  const c = doc([
    alloc({ spendLineId: "l1", amount: 6000 }),
    alloc({ spendLineId: "l2", amount: 4000 }),
  ]);
  await svc.applyRelease({
    commitment: c, voucher: voucher(), actor: {},
    entries: [entry({ spendLineId: "l1", amount: 6000, taxAmount: 0 })],
  });
  /* One of two heads billed — three-quarters of the old bug in one line. */
  assert.equal(c.status, "partially_released");
  assert.equal(c.allocations[1].status, "committed");
  assert.equal(c.allocations[1].remainingAmount, 4000);

  await svc.applyRelease({
    commitment: c, voucher: voucher({ _id: "v2" }), actor: {},
    entries: [entry({ spendLineId: "l2", amount: 4000, taxAmount: 0 })],
  });
  assert.equal(c.status, "released");
});

test("an unbudgeted allocation keeps its word but gets a billing lifecycle", async () => {
  const c = doc([
    alloc({ spendLineId: "l1", amount: 6000 }),
    alloc({ spendLineId: "l2", amount: 4000, status: "unbudgeted", budgetLineId: null }),
  ]);
  await svc.applyRelease({
    commitment: c, voucher: voucher(), actor: {},
    entries: [entry({ spendLineId: "l1", amount: 6000, taxAmount: 0 })],
  });

  /* The WORD is fixed: nothing downstream may mistake it for spendable, and
     it stays out of every availability figure. */
  assert.equal(c.allocations[1].status, "unbudgeted");
  /* The FIGURES move like any other row, because finance still needs to know
     whether it has been billed. */
  assert.equal(c.allocations[1].remainingAmount, 4000);
  assert.equal(c.allocations[1].releasedAmount, 0);

  /* ── AND IT HOLDS THE DOCUMENT OPEN ──────────────────────────────────────
     It reduces no budget, but the company still owes the money. Reporting the
     commitment complete while part of it is unbilled is a false statement
     about what is outstanding. */
  assert.equal(c.status, "partially_released");
});

test("a mixed commitment closes only when the unbudgeted line is billed too", async () => {
  const c = doc([
    alloc({ spendLineId: "l1", amount: 6000 }),
    alloc({ spendLineId: "l2", amount: 4000, status: "unbudgeted", budgetLineId: null }),
  ]);
  await svc.applyRelease({
    commitment: c, voucher: voucher({ _id: "v1" }), actor: {},
    entries: [entry({ spendLineId: "l1", amount: 6000, taxAmount: 0 })],
  });
  assert.equal(c.status, "partially_released");

  await svc.applyRelease({
    commitment: c, voucher: voucher({ _id: "v2" }), actor: {},
    entries: [entry({ spendLineId: "l2", amount: 4000, taxAmount: 0 })],
  });

  assert.equal(c.status, "released");
  assert.equal(c.allocations[1].remainingAmount, 0);
  assert.equal(c.allocations[1].releasedAmount, 4000);
  /* Still not spendable, and still not a budget release. */
  assert.equal(c.allocations[1].status, "unbudgeted");
});

test("several bill lines on one request line keep every contribution", async () => {
  const c = doc([alloc({ spendLineId: "l1", amount: 10000 })]);
  await svc.applyRelease({
    commitment: c, voucher: voucher(), actor: {},
    entries: [
      entry({ _id: "a", spendLineId: "l1", amount: 4000, taxAmount: 0 }),
      entry({ _id: "b", spendLineId: "l1", amount: 3000, taxAmount: 0 }),
    ],
  });

  const rel = c.allocations[0].releases[0];
  assert.equal(rel.amount, 7000);
  /* Storing only the first line left the second with no audit evidence, and a
     cancellation could not say what it was reversing. */
  assert.equal(rel.contributions.length, 2);
  assert.deepEqual(rel.contributions.map((x) => x.amount), [4000, 3000]);
  assert.deepEqual(rel.contributions.map((x) => x.voucherLineId), ["a", "b"]);
  /* The parts sum to the release. */
  assert.equal(rel.contributions.reduce((t, x) => t + x.amount, 0), rel.amount);
});

test("a capped release scales its contributions down with it", async () => {
  const c = doc([alloc({ spendLineId: "l1", amount: 6000 })]);
  await svc.applyRelease({
    commitment: c, voucher: voucher(), actor: {},
    entries: [
      entry({ _id: "a", spendLineId: "l1", amount: 6000, taxAmount: 0 }),
      entry({ _id: "b", spendLineId: "l1", amount: 3000, taxAmount: 0 }),
    ],
  });

  const rel = c.allocations[0].releases[0];
  assert.equal(rel.amount, 6000);
  /* ₹9,000 billed against a ₹6,000 promise: the parts must still sum to what
     was actually released, not to what was billed. */
  assert.equal(rel.contributions.reduce((t, x) => t + x.amount, 0), 6000);
});

test("cancelling one voucher restores only its own amount", async () => {
  const c = doc([alloc({ spendLineId: "l1", amount: 10000 })]);
  await svc.applyRelease({
    commitment: c, voucher: voucher({ _id: "v1" }), actor: {},
    entries: [entry({ spendLineId: "l1", amount: 4000, taxAmount: 0 })],
  });
  await svc.applyRelease({
    commitment: c, voucher: voucher({ _id: "v2" }), actor: {},
    entries: [entry({ spendLineId: "l1", amount: 3000, taxAmount: 0 })],
  });
  assert.equal(c.allocations[0].releasedAmount, 7000);

  await svc.restoreVoucher({ commitment: c, voucher: voucher({ _id: "v1" }) });

  /* v2 is still posted, and its discharge stands. */
  assert.equal(c.allocations[0].releasedAmount, 3000);
  assert.equal(c.allocations[0].remainingAmount, 7000);
  assert.equal(c.allocations[0].releases.length, 1);
  assert.equal(String(c.allocations[0].releases[0].voucherId), "v2");
  assert.equal(c.status, "partially_released");
});

test("restoring the only release returns the commitment to committed", async () => {
  const c = doc([alloc({ spendLineId: "l1", amount: 10000 })]);
  await svc.applyRelease({
    commitment: c, voucher: voucher(), actor: {},
    entries: [entry({ spendLineId: "l1", amount: 10000, taxAmount: 0 })],
  });
  assert.equal(c.status, "released");

  await svc.restoreVoucher({ commitment: c, voucher: voucher() });

  assert.equal(c.status, "committed");
  assert.equal(c.allocations[0].releasedAmount, 0);
  assert.equal(c.allocations[0].remainingAmount, 10000);
  assert.equal(c.allocations[0].releases, undefined);
  /* The whole-document release fields described a completion that has not
     happened any more. */
  assert.equal(c.releasedByVoucherId, undefined);
});

test("re-posting after cancellation writes exactly one set of rows", async () => {
  const c = doc([alloc({ spendLineId: "l1", amount: 10000 })]);
  const v = voucher();
  const entries = [entry({ spendLineId: "l1", amount: 4000, taxAmount: 0 })];

  await svc.applyRelease({ commitment: c, voucher: v, actor: {}, entries });
  await svc.restoreVoucher({ commitment: c, voucher: v });
  await svc.applyRelease({ commitment: c, voucher: v, actor: {}, entries });

  assert.equal(c.allocations[0].releases.length, 1);
  assert.equal(c.allocations[0].releasedAmount, 4000);

  /* And a fourth call — the same voucher saved again — adds nothing. */
  await svc.applyRelease({ commitment: c, voucher: v, actor: {}, entries });
  assert.equal(c.allocations[0].releases.length, 1);
});

test("restoring a voucher that released nothing here changes nothing", async () => {
  const c = doc([alloc({ spendLineId: "l1", amount: 10000 })]);
  await svc.applyRelease({
    commitment: c, voucher: voucher({ _id: "v1" }), actor: {},
    entries: [entry({ spendLineId: "l1", amount: 4000, taxAmount: 0 })],
  });
  const before = c.allocations[0].releasedAmount;

  const out = await svc.restoreVoucher({ commitment: c, voucher: voucher({ _id: "vX" }) });

  assert.equal(out.restored, false);
  assert.equal(c.allocations[0].releasedAmount, before);
});

test("a legacy commitment is refused by both, not silently half-handled", async () => {
  const legacy = doc([]);
  legacy.allocations = undefined;
  assert.equal((await svc.applyRelease({ commitment: legacy, voucher: voucher() })).why,
    "legacy_whole_document");
  assert.equal((await svc.restoreVoucher({ commitment: legacy, voucher: voucher() })).why,
    "legacy_whole_document");
});
