const assert = require("node:assert/strict");
const { test } = require("node:test");
const { unblockedAtMs } = require("./officeDeadline.service");

/**
 * **The clock moves while you are waiting, and stops while you have work.**
 * OWNER RULE, 26 Aug 2026, stated as four states of one pair of tasks.
 *
 * Umung holds "umung tasks" with outputs *Puri work* and *pardeep work*.
 * Rakesh holds the dependent task: *Puri* waits on Puri work, *pardeep dev*
 * waits on pardeep work.
 *
 *   1. Umung has submitted nothing        -> Rakesh waiting  -> time MOVES
 *   2. Puri work approved                 -> Rakesh workable -> time STOPS
 *   3. Rakesh hands his Puri over         -> waiting again   -> time MOVES
 *   4. pardeep work approved              -> workable again  -> time STOPS
 *
 * Only the third was wrong: the first approval kept the clock frozen while
 * Rakesh sat idle, so the wait for the second input came out of his budget.
 */

const at = (h, m = 0) =>
  Date.parse(`2026-08-26T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`);

const PURI_APPROVED = at(10);
const PARDEEP_APPROVED = at(13);
const NOW = at(15);

/** Rakesh's task. `submissions` is what he has handed over so far. */
const rakesh = (submissions = {}) => ({
  outputs: [
    { id: "r_puri", label: "Puri", needsOutputIds: ["u_puri"] },
    { id: "r_pardeep", label: "pardeep dev", needsOutputIds: ["u_pardeep"] },
  ],
  outputSubmissions: submissions,
});

const handedOver = { submittedAt: new Date(at(11)).toISOString() };
const approvedBack = {
  submittedAt: new Date(at(11)).toISOString(),
  review: { approved: true, reviewedAt: new Date(at(12)).toISOString() },
};
const returned = {
  submittedAt: new Date(at(11)).toISOString(),
  review: { approved: false, reviewedAt: new Date(at(12)).toISOString() },
};

test("1 — nothing approved: he is waiting, so the clock MOVES", () => {
  assert.equal(unblockedAtMs(rakesh(), new Map(), NOW), NOW);
});

test("2 — Puri work approved: he has work, so the clock STOPS", () => {
  const approvals = new Map([["u_puri", PURI_APPROVED]]);
  assert.equal(unblockedAtMs(rakesh(), approvals, NOW), PURI_APPROVED);
});

test("3 — he hands his Puri over: waiting again, so the clock MOVES", () => {
  /* The reported fault. This returned PURI_APPROVED — frozen — so the wait for
     pardeep work was charged to Rakesh's budget. */
  const approvals = new Map([["u_puri", PURI_APPROVED]]);
  assert.equal(unblockedAtMs(rakesh({ r_puri: handedOver }), approvals, NOW), NOW);
  /* And the same once his work comes back approved — it is still not work. */
  assert.equal(unblockedAtMs(rakesh({ r_puri: approvedBack }), approvals, NOW), NOW);
});

test("4 — pardeep work approved: he has work again, so the clock STOPS", () => {
  const approvals = new Map([
    ["u_puri", PURI_APPROVED],
    ["u_pardeep", PARDEEP_APPROVED],
  ]);
  assert.equal(
    unblockedAtMs(rakesh({ r_puri: handedOver }), approvals, NOW),
    PARDEEP_APPROVED,
  );
});

test("a RETURNED output is work again, and holds the clock", () => {
  /* The reviewer gave it back, so it is not handed over — freezing on its
     input's approval is right, and letting the clock run would pay him for a
     wait that is his own to clear. */
  const approvals = new Map([["u_puri", PURI_APPROVED]]);
  assert.equal(unblockedAtMs(rakesh({ r_puri: returned }), approvals, NOW), PURI_APPROVED);
});

test("everything handed over: still waiting on the rest, so the clock MOVES", () => {
  const approvals = new Map([["u_puri", PURI_APPROVED]]);
  assert.equal(
    unblockedAtMs(rakesh({ r_puri: approvedBack, r_pardeep: handedOver }), approvals, NOW),
    NOW,
  );
});

test("a task that never waited on anybody is untouched by all of this", () => {
  const plain = { outputs: [{ id: "x", needsOutputIds: [] }] };
  assert.equal(unblockedAtMs(plain, new Map(), NOW), null);
  assert.equal(unblockedAtMs({ outputs: [] }, new Map(), NOW), null);
});
