// test/store-purchase/unit-of-work-transaction.test.js
//
// Store & Purchase — the TRANSACTIONAL half of the unit of work.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// Every route test in this suite runs against mongodb-memory-server, which is
// a STANDALONE. `transactionsAvailable()` therefore answers false and every
// one of those tests exercises the MARKED path. The transactional branch —
// the one a production replica set actually takes — had no coverage at all,
// and "the tests pass" was quietly saying nothing about it.
//
// ── WHAT THIS IS, AND IS NOT ────────────────────────────────────────────────
// This is NOT a replica-set integration test. No replica set is started and
// none is required. It drives the branch deterministically by settling the
// support flag and substituting a session, then asserts the four properties
// that make the branch worth having:
//
//   1. the mutation is handed the session;
//   2. the history write and the effect marker are handed THE SAME session;
//   3. a history failure aborts the transaction;
//   4. nothing is reported as succeeded after that failure.
//
// A real replica set would additionally prove the server honours the abort.
// That is a deployment property, and this file does not claim it.
"use strict";

const mongoose = require("mongoose");

const unitOfWork = require("../../services/storePurchase/unitOfWork.service");
const actionHistory = require("../../services/storePurchase/actionHistory.service");
const idempotency = require("../../services/storePurchase/idempotency.service");

const ctx = { companyId: new mongoose.Types.ObjectId(), actorId: "actor-1" };
const record = { _id: new mongoose.Types.ObjectId() };

/** A session that behaves as `withTransaction` does: commit, or abort and rethrow. */
function fakeSession() {
  const calls = { committed: 0, aborted: 0, ended: 0 };
  const session = {
    id: "session-under-test",
    calls,
    async withTransaction(fn) {
      try {
        const out = await fn();
        calls.committed += 1;
        return out;
      } catch (err) {
        calls.aborted += 1;
        throw err;
      }
    },
    async abortTransaction() { calls.aborted += 1; },
    async endSession() { calls.ended += 1; },
  };
  return session;
}

let session;
let startSession;

beforeEach(() => {
  session = fakeSession();
  /* Settled, so the probe never runs and the branch is not left to chance. */
  unitOfWork.__setTransactionSupport(true);
  startSession = jest.spyOn(mongoose, "startSession").mockResolvedValue(session);
});

afterEach(() => {
  jest.restoreAllMocks();
  /* Leave the module as the rest of the suite expects to find it. */
  unitOfWork.__setTransactionSupport(null);
});

describe("the transactional path", () => {
  test("the mutation, the history write and the effect marker all receive the SAME session", async () => {
    const seen = {};
    const history = jest.spyOn(actionHistory, "record").mockResolvedValue(undefined);
    const mark = jest.spyOn(idempotency, "markEffectApplied").mockResolvedValue(undefined);

    const goodReceipt = {
      v: 2, action: "WAREHOUSE_UPDATED", entityType: "WAREHOUSE",
      entityId: record._id, documentNumber: "WH-1",
      occurredAt: new Date(), previousState: "Active", resultingState: "Active",
    };
    const { result, mode } = await unitOfWork.run(ctx, {
      idempotencyRecord: record,
      /* The receipt is prepared and passed by the CALLER, before the unit of
         work runs — never returned from `mutate`. */
      recoveryReceipt: goodReceipt,
      mutate: async (s) => {
        seen.mutate = s;
        return {
          entityType: "WAREHOUSE",
          entityId: record._id,
          entry: { action: "WAREHOUSE_UPDATED" },
          result: { ok: true },
        };
      },
    });

    expect(mode).toBe("TRANSACTIONAL");
    expect(result).toEqual({ ok: true });

    /* 1. The mutation was handed the session — not null, and not a new one. */
    expect(seen.mutate).toBe(session);

    /* 2. And so were both of the writes that must commit with it. Passing a
          DIFFERENT session, or none, would put them outside the transaction
          while the code still reported TRANSACTIONAL. */
    expect(history).toHaveBeenCalledTimes(1);
    expect(history.mock.calls[0][2]).toEqual({ session });
    /* Recorded as a full guarantee, because it is one on this path. */
    expect(history.mock.calls[0][1].atomicityDegraded).toBe(false);

    expect(mark).toHaveBeenCalledTimes(1);
    expect(mark.mock.calls[0][0].session).toBe(session);
    /* The EXACT validated receipt travels with the marker, inside the same
       transaction — not a second one reconstructed from `mutate`. */
    expect(mark.mock.calls[0][0].receipt).toMatchObject({
      v: 2, action: "WAREHOUSE_UPDATED", entityType: "WAREHOUSE",
    });

    expect(session.calls.committed).toBe(1);
    expect(session.calls.aborted).toBe(0);
    expect(session.calls.ended).toBe(1);
  });

  test("a history failure aborts the transaction and no effect marker is written", async () => {
    jest.spyOn(actionHistory, "record").mockRejectedValue(new Error("audit down"));
    const mark = jest.spyOn(idempotency, "markEffectApplied").mockResolvedValue(undefined);
    const mutate = jest.fn(async (s) => ({
      entityType: "WAREHOUSE",
      entityId: record._id,
      entry: { action: "WAREHOUSE_UPDATED" },
      result: { ok: true },
    }));

    await expect(unitOfWork.run(ctx, { idempotencyRecord: record, mutate }))
      .rejects.toThrow("audit down");

    /* 3. The transaction was aborted, so the mutation is rolled back with it
          — which is why this path needs no recovery at all. */
    expect(session.calls.aborted).toBe(1);
    expect(session.calls.committed).toBe(0);
    expect(session.calls.ended).toBe(1);

    /* 4. And nothing downstream was told the action succeeded. The marker in
          particular must NOT exist: on this path there is nothing to recover,
          and a marker would send a retry into a recovery for a change that
          was rolled away. */
    expect(mark).not.toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  test("a failing mutation never reaches history or the marker", async () => {
    const history = jest.spyOn(actionHistory, "record").mockResolvedValue(undefined);
    const mark = jest.spyOn(idempotency, "markEffectApplied").mockResolvedValue(undefined);

    await expect(unitOfWork.run(ctx, {
      idempotencyRecord: record,
      mutate: async () => { throw new Error("conflict"); },
    })).rejects.toThrow("conflict");

    expect(history).not.toHaveBeenCalled();
    expect(mark).not.toHaveBeenCalled();
    expect(session.calls.aborted).toBe(1);
    expect(session.calls.ended).toBe(1);
  });

  test("the session is opened once and always ended, success or failure", async () => {
    jest.spyOn(actionHistory, "record").mockResolvedValue(undefined);
    jest.spyOn(idempotency, "markEffectApplied").mockResolvedValue(undefined);

    await unitOfWork.run(ctx, {
      idempotencyRecord: null,
      mutate: async () => ({
        entityType: "WAREHOUSE", entityId: record._id,
        entry: { action: "X" }, result: 1,
      }),
    });
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(session.calls.ended).toBe(1);
  });

  test("without an idempotency record the transaction still runs, and marks nothing", async () => {
    jest.spyOn(actionHistory, "record").mockResolvedValue(undefined);
    const mark = jest.spyOn(idempotency, "markEffectApplied").mockResolvedValue(undefined);

    const { mode } = await unitOfWork.run(ctx, {
      idempotencyRecord: null,
      mutate: async () => ({
        entityType: "WAREHOUSE", entityId: record._id,
        entry: { action: "X" }, result: 1,
      }),
    });
    expect(mode).toBe("TRANSACTIONAL");
    expect(mark).not.toHaveBeenCalled();
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * DEFECT 1 — THE RECEIPT IS VALIDATED BEFORE THE BUSINESS MUTATION
 *
 * The unsafe ordering was: mutate → cast/store receipt → history. If the
 * receipt cast failed at step 2, the mutation had landed with no effect
 * marker, and a retry could run it again. The receipt must be validated
 * BEFORE the transaction probe and BEFORE `mutate`.
 * ═════════════════════════════════════════════════════════════════════════ */

describe("a recovery receipt is validated before anything else runs", () => {
  const {
    buildRecoveryReceipt, RECOVERY_RECEIPT_VERSION,
  } = require("../../models/CMS_Models/StorePurchase/SpIdempotencyRecord");

  const validInput = () => ({
    action: "WAREHOUSE_UPDATED",
    entityType: "WAREHOUSE",
    entityId: new mongoose.Types.ObjectId(),
    documentNumber: "WH-9",
    occurredAt: new Date(),
    previousState: "Active",
    resultingState: "Active",
    fields: ["name"],
  });

  test("a malformed receipt calls neither the probe, nor mutate, nor markEffectApplied", async () => {
    unitOfWork.__setTransactionSupport(null); // force the probe to be reachable
    const probe = jest.spyOn(mongoose, "startSession");
    const mutate = jest.fn();
    const mark = jest.spyOn(idempotency, "markEffectApplied").mockResolvedValue(undefined);
    const history = jest.spyOn(actionHistory, "record").mockResolvedValue(undefined);

    await expect(unitOfWork.run(ctx, {
      idempotencyRecord: record,
      /* No occurredAt, wrong version, unknown key — any of these is fatal. */
      recoveryReceipt: { v: 999, action: "", entityType: "", entityId: "not-an-id" },
      mutate,
    })).rejects.toThrow();

    /* ── THE ORDERING CLAIM ─────────────────────────────────────────────────
       Nothing downstream of validation ran. The mutation never happened, so
       there is no un-marked effect for a retry to repeat. */
    expect(mutate).not.toHaveBeenCalled();
    expect(mark).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  test("the builder rejects an invalid receipt outright", () => {
    expect(() => buildRecoveryReceipt({ ...validInput(), occurredAt: undefined })).toThrow();
    expect(() => buildRecoveryReceipt({ ...validInput(), v: 1 })).not.toThrow(); // v is set by builder
    expect(() => buildRecoveryReceipt({ ...validInput(), entityId: "nope" })).toThrow();
    expect(() => buildRecoveryReceipt({ ...validInput(), action: "" })).toThrow();
    expect(() => buildRecoveryReceipt({ ...validInput(), entityType: "" })).toThrow();
  });

  test("the exact validated receipt — not one from mutate — reaches markEffectApplied", async () => {
    unitOfWork.__setTransactionSupport(true);
    jest.spyOn(actionHistory, "record").mockResolvedValue(undefined);
    const mark = jest.spyOn(idempotency, "markEffectApplied").mockResolvedValue(undefined);

    const receipt = buildRecoveryReceipt(validInput());
    await unitOfWork.run(ctx, {
      idempotencyRecord: record,
      recoveryReceipt: receipt,
      mutate: async () => ({
        entityType: "WAREHOUSE", entityId: receipt.entityId,
        entry: { action: "WAREHOUSE_UPDATED" }, result: 1,
        /* A receipt returned here MUST be ignored — retaining it is the unsafe
           ordering this defect removes. */
        receipt: { v: RECOVERY_RECEIPT_VERSION, action: "TAMPERED", entityType: "WAREHOUSE", entityId: receipt.entityId, occurredAt: new Date() },
      }),
    });

    expect(mark).toHaveBeenCalledTimes(1);
    /* The receipt the marker stores is the one the unit of work validated from
       the caller's input — deep-equal to it — and NOT the tampered one the
       mutation tried to return. */
    expect(mark.mock.calls[0][0].receipt).toStrictEqual(receipt);
    expect(mark.mock.calls[0][0].receipt.action).toBe("WAREHOUSE_UPDATED"); // not TAMPERED
  });

  test("existing callers that omit a receipt are unaffected", async () => {
    unitOfWork.__setTransactionSupport(true);
    jest.spyOn(actionHistory, "record").mockResolvedValue(undefined);
    const mark = jest.spyOn(idempotency, "markEffectApplied").mockResolvedValue(undefined);

    const { mode } = await unitOfWork.run(ctx, {
      idempotencyRecord: record,
      mutate: async () => ({
        entityType: "WAREHOUSE", entityId: record._id,
        entry: { action: "X" }, result: 1,
      }),
    });
    expect(mode).toBe("TRANSACTIONAL");
    expect(mark).toHaveBeenCalledTimes(1);
    expect(mark.mock.calls[0][0].receipt).toBeUndefined();
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * DEFECTS 2 & 5 — THE SHARED RECEIPT IS DOMAIN-NEUTRAL, CLOSED AND BOUNDED
 * ═════════════════════════════════════════════════════════════════════════ */

describe("the shared recovery receipt contract", () => {
  const {
    buildRecoveryReceipt, RECEIPT_LIMITS, RECOVERY_RECEIPT_VERSION,
  } = require("../../models/CMS_Models/StorePurchase/SpIdempotencyRecord");

  const base = () => ({
    action: "SOMETHING_HAPPENED",
    entityType: "WIDGET",
    entityId: new mongoose.Types.ObjectId(),
    occurredAt: new Date(),
  });

  test("it has no domain-specific fields — a subject, not a location", () => {
    const r = buildRecoveryReceipt({
      ...base(),
      subjectType: "LOCATION",
      subjectId: new mongoose.Types.ObjectId(),
      subjectCode: "BIN1",
    });
    /* Generic names, so any domain — Supplier included — maps onto them. */
    expect(r).toHaveProperty("subjectId");
    expect(r).toHaveProperty("subjectCode");
    expect(r).not.toHaveProperty("locationId");
    expect(r).not.toHaveProperty("locationCode");
    expect(r.entityType).toBe("WIDGET");
    expect(r.v).toBe(RECOVERY_RECEIPT_VERSION);
  });

  test("unknown keys are stripped deterministically, never stored", () => {
    const r = buildRecoveryReceipt({
      ...base(),
      bankAccount: "12345678",
      addressDetail: { line1: "Plot 4" },
      contactPerson: { phone: "999" },
      arbitrary: { nested: { deep: true } },
    });
    const asText = JSON.stringify(r);
    for (const leak of ["12345678", "Plot 4", "999", "arbitrary", "bankAccount", "addressDetail", "contactPerson"]) {
      expect(asText).not.toContain(leak);
    }
  });

  test("contact/address/bank-shaped data cannot be stored even inside facts", () => {
    /* Facts take a key and a small scalar — never a nested object. */
    expect(() => buildRecoveryReceipt({
      ...base(),
      facts: [{ key: "bank", value: { account: "123", ifsc: "X" } }],
    })).toThrow();
  });

  test("the builder is idempotent — validating a built receipt (facts included) is a no-op", () => {
    /* markEffectApplied re-validates as a second defence, so building a
       receipt that was already built must not throw or change it. */
    const once = buildRecoveryReceipt({
      ...base(),
      facts: [{ key: "assessmentScore", value: 87 }, { key: "grade", value: "A" }],
      fields: ["rating"], reason: "ok",
    });
    const twice = buildRecoveryReceipt(once);
    expect(twice).toStrictEqual(once);
  });

  test("a small typed fact — e.g. an assessment score — is allowed and bounded", () => {
    const r = buildRecoveryReceipt({
      ...base(),
      facts: [{ key: "assessmentScore", value: 87 }, { key: "grade", value: "A" }],
    });
    expect(r.facts).toHaveLength(2);
    /* Over the fact cap is refused. */
    const many = Array.from({ length: RECEIPT_LIMITS.MAX_FACTS + 1 }, (_, i) => ({ key: `k${i}`, value: i }));
    expect(() => buildRecoveryReceipt({ ...base(), facts: many })).toThrow();
  });

  test("every scalar is length-bounded and the field list is count-bounded", () => {
    expect(() => buildRecoveryReceipt({ ...base(), action: "A".repeat(RECEIPT_LIMITS.ACTION + 1) })).toThrow();
    expect(() => buildRecoveryReceipt({ ...base(), documentNumber: "D".repeat(RECEIPT_LIMITS.DOCUMENT_NUMBER + 1) })).toThrow();
    expect(() => buildRecoveryReceipt({ ...base(), reason: "R".repeat(RECEIPT_LIMITS.REASON + 1) })).toThrow();
    expect(() => buildRecoveryReceipt({ ...base(), resultingState: "S".repeat(RECEIPT_LIMITS.STATE + 1) })).toThrow();
    const tooMany = Array.from({ length: RECEIPT_LIMITS.MAX_FIELDS + 1 }, (_, i) => `f${i}`);
    expect(() => buildRecoveryReceipt({ ...base(), fields: tooMany })).toThrow();
    expect(() => buildRecoveryReceipt({ ...base(), fields: ["x".repeat(RECEIPT_LIMITS.FIELD_NAME + 1)] })).toThrow();
  });

  test("a receipt with no valid event time is refused", () => {
    expect(() => buildRecoveryReceipt({ ...base(), occurredAt: undefined })).toThrow();
    expect(() => buildRecoveryReceipt({ ...base(), occurredAt: "not-a-date" })).toThrow();
    expect(() => buildRecoveryReceipt({ ...base(), occurredAt: new Date("nope") })).toThrow();
  });
});
