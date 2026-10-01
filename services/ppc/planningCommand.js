// services/ppc/planningCommand.js
//
// THE PLANNING FILE'S IDEMPOTENCY PROTOCOL — THE EFFECT AND ITS LEDGER ROW
// COMMIT TOGETHER.
//
// `commandOnce.js` is left exactly as the pack and IE-release receipts accepted
// it. Its ledger is written after the command, and it says plainly that two
// concurrent callers with one key both reach the command; those two flows are
// safe because each serialises on its own unique index. A planning lifecycle
// command has no such index, so it gets this protocol instead:
//
//   1. no key is refused, and a key already held for a DIFFERENT request is
//      refused (`IDEMPOTENCY_KEY_REUSED`) — the request hash includes the
//      revision the caller read, so a key cannot be re-aimed at a later state;
//   2. a key already held for THIS request replays the stored envelope — the
//      exact public answer the first request gave, not a re-projection of the
//      record as it is now;
//   3. otherwise the command runs inside a transaction, and its ledger row is
//      inserted in that SAME transaction. Command and ledger cannot disagree:
//      both commit or neither does;
//   4. when two requests with one key race, the second's write conflicts with
//      the first's, the driver retries it, and it then finds the record moved
//      and fails — at which point the committed ledger row is read and replayed.
//      One business effect, one audit event, and both callers get the same
//      answer (the second marked `replayed`).
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const { PpcPlanningCommand } = require("../../models/CMS_Models/PPC/PpcPlanningCommand");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();

const hashRequest = (req) => crypto.createHash("sha256")
  .update(JSON.stringify(req ?? null)).digest("hex");

const TRANSACTIONS_UNAVAILABLE = /Transaction numbers|replica set|transactions are not supported/i;

/**
 * @param {object} ctx       must carry `companyId`
 * @param {object} args
 * @param {string} args.scope           e.g. `ppc:planning:cmd:<planningFileId>`
 * @param {string} args.command         what this is, for the ledger row
 * @param {string} args.idempotencyKey  from the header
 * @param {*}      args.request         the normalised request, hashed
 * @param {function(ClientSession): Promise<object>} run  returns the public envelope
 */
async function planningCommand(ctx, { scope, command, idempotencyKey, request }, run) {
  const key = str(idempotencyKey);
  if (!key) {
    throw fail("IDEMPOTENCY_KEY_REQUIRED",
      "Send an idempotency key with this decision, so a retry cannot take it twice.",
      { field: "idempotencyKey" });
  }
  const companyId = new mongoose.Types.ObjectId(str(ctx.companyId));
  const requestHash = hashRequest(request);

  const replay = async () => {
    const held = await PpcPlanningCommand.findOne({ companyId, scope, idempotencyKey: key }).lean();
    if (!held) return null;
    if (held.requestHash !== requestHash) {
      throw fail("IDEMPOTENCY_KEY_REUSED",
        "That idempotency key was already used for a different request.", { field: "idempotencyKey" });
    }
    return { ...held.envelope, replayed: true };
  };

  const earlier = await replay();
  if (earlier) return earlier;

  const session = await mongoose.startSession();
  try {
    let envelope;
    await session.withTransaction(async () => {
      envelope = await run(session);
      await PpcPlanningCommand.create([{
        companyId, scope, idempotencyKey: key, requestHash, command,
        planningFileId: envelope?.planningFile?.planningFileId || null,
        envelope,
        at: new Date(),
      }], { session });
    });
    return { ...envelope, replayed: false };
  } catch (err) {
    /* Whatever went wrong, a request with this key may have committed first —
       a concurrent twin, or the attempt whose answer was lost. If so, ITS
       answer is this request's answer. A key held for a different request is
       still refused, from inside `replay`. */
    const held = await replay();
    if (held) return held;
    if (TRANSACTIONS_UNAVAILABLE.test(str(err?.message))) {
      throw fail("PPC_PLANNING_TRANSACTION_REQUIRED",
        "This deployment cannot record a planning decision and its ledger together. Nothing was written.",
        { requires: "MONGODB_TRANSACTIONS", wrote: "NOTHING" });
    }
    throw err;
  } finally {
    await session.endSession();
  }
}

module.exports = { planningCommand, hashRequest };
