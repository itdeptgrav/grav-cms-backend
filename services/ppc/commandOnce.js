// services/ppc/commandOnce.js
//
// PPC'S IDEMPOTENCY PROTOCOL — ONE HELPER, TWO CALLERS.
//
// This is `once()` exactly as `inboundPack.service.js` has always run it,
// lifted out so the IE-release acknowledgement in `ieReleaseAck.service.js`
// uses the SAME protocol rather than a second, incompatible one:
//
//   · the key is scoped `{ companyId, scope, idempotencyKey }`, unique in the
//     database, so a key is never global and two different commands may
//     legitimately share one;
//   · a `requestHash` is stored beside it, so the same key re-sent with a
//     DIFFERENT request is refused (`IDEMPOTENCY_KEY_REUSED`) rather than
//     silently replaying somebody else's answer;
//   · a missing key is refused outright (`IDEMPOTENCY_KEY_REQUIRED`);
//   · the ledger stores "enough to rebuild the reply, never a copy of the
//     record" — the schema's own words.
//
// ── WHAT IS NEW, AND WHY IT CHANGES NOTHING FOR INBOUND PACKS ───────────────
// Two optional hooks, `project` and `rebuild`. Omit both and the behaviour is
// byte-for-byte what it was: the pack projection is the default, and a replay
// returns `{ replayed: true, ...held.result }`.
//
// `rebuild` exists because an IE-release acknowledgement's reply is a projected
// receipt, not three scalars — and the honest way to replay it is to REBUILD it
// from the stored receipt, which is exactly what the ledger schema's comment
// says the row is for. Widening the ledger's `result` subdocument to hold a
// whole envelope would have changed what inbound-pack replays return, and that
// is an observable change to an accepted surface.
//
// ── ONE THING THIS HELPER DOES NOT DO ───────────────────────────────────────
// The read-then-run below is not itself concurrency-safe: two simultaneous
// requests carrying one key both miss the ledger and both reach `run`. That is
// deliberate and it always was — the ledger is the FAST path, and the caller's
// own unique index is the truth. `inboundPack` serialises on the pack's state
// inside a transaction; `ieReleaseAck` serialises on the receipt's unique
// `{companyId, releaseRef, releaseVersionNo}` index. A caller with no such
// index must not use this helper.
"use strict";

const crypto = require("crypto");

const {
  MerchandisingCommandLedger,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();

const hashRequest = (req) => crypto.createHash("sha256")
  .update(JSON.stringify(req ?? null)).digest("hex");

/** What inbound-pack decisions have always stored. Unchanged. */
const defaultProject = (result) => ({
  revisionNo: result?.packVersionNo ?? null,
  state: str(result?.state),
  note: str(result?.note),
});

/**
 * @param {object} ctx           must carry `companyId`
 * @param {object} args
 * @param {string} args.scope    one command on one record, e.g. `ppc:pack:<id>`
 * @param {string} args.idempotencyKey
 * @param {*}      args.request  the normalised request, hashed for comparison
 * @param {function} [args.project]  result → the ledger's `result` subdocument
 * @param {function} [args.rebuild]  ledger row → the replayed envelope
 * @param {function} run         the command itself, run at most once per key
 */
async function once(ctx, {
  scope, idempotencyKey, request, project = defaultProject, rebuild = null,
}, run) {
  const key = str(idempotencyKey);
  if (!key) {
    throw fail("IDEMPOTENCY_KEY_REQUIRED",
      "Send an idempotency key with this decision, so a retry cannot take it twice.",
      { field: "idempotencyKey" });
  }
  const requestHash = hashRequest(request);
  const held = await MerchandisingCommandLedger.findOne({
    companyId: ctx.companyId, scope, idempotencyKey: key,
  }).lean();
  if (held) {
    if (held.requestHash !== requestHash) {
      throw fail("IDEMPOTENCY_KEY_REUSED",
        "That idempotency key was already used for a different request.", { field: "idempotencyKey" });
    }
    return rebuild
      ? { replayed: true, ...(await rebuild(held)) }
      : { replayed: true, ...held.result };
  }
  const result = await run();
  try {
    await MerchandisingCommandLedger.create([{
      companyId: ctx.companyId, scope, idempotencyKey: key, requestHash,
      result: project(result),
      at: new Date(),
    }]);
  } catch (err) { if (err?.code !== 11000) throw err; }
  /* `result` is spread LAST so a command that resolved its own replay — a lost
     race, say — can say so and be believed. */
  return { replayed: false, ...result };
}

module.exports = { once, hashRequest, defaultProject };
