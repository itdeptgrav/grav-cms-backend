// scripts/backfill-customer-request-line-refs.js
//
// GIVE EVERY EXISTING ORDER LINE ITS PERMANENT SALES LINE REFERENCE.
//
// New and edited order lines get one automatically — the CustomerRequest
// pre-validate hook mints for any line that has none, and every writer in the
// repository persists through `.save()`. Records that have not been touched
// since the field was added still have lines with no reference, and those
// lines cannot be handed to Merchandising until they do.
//
// This is the one utility in this work that genuinely writes. It writes a
// Sales-owned field on Sales-owned records, one bounded value per line, and
// nothing else: no handover, no Execution File, no status change, no
// reordering, no content edit.
//
// ── DRY RUN BY DEFAULT, AND APPLY MEANS APPLY ───────────────────────────────
//   node scripts/backfill-customer-request-line-refs.js
//       inspects and reports; writes nothing.
//
//   node scripts/backfill-customer-request-line-refs.js --apply \
//        --authorized-by="<who authorised this>"
//       assigns a reference to every line that has none.
//
// `--apply` without `--authorized-by` is refused. The name is stamped on every
// batch so the run can be attributed afterwards. Do not run `--apply` against
// user data without that authorization actually existing.
//
// ── IDEMPOTENT, AND REFUSES RATHER THAN REPAIRS ─────────────────────────────
// Running it twice changes nothing the second time: a line that already has a
// reference is left exactly alone, and the report says how many those were.
//
// A request whose lines carry DUPLICATE references, or a reference that this
// system did not issue, is refused and reported — never silently rewritten.
// Both conditions mean something wrote a line reference that should not have,
// and quietly re-minting would destroy the evidence of it along with whatever
// was already pointing at the duplicate.
//
// ── ROLLBACK ────────────────────────────────────────────────────────────────
// Every line assigned in a run is stamped with that run's batch identity in
// `lineRefBackfill`, on the request. To undo a run completely:
//
//   node scripts/backfill-customer-request-line-refs.js --rollback <batchId>
//
// It unsets `lineRef` on exactly the lines that batch assigned, and only
// while nothing points at them: a line whose reference is already named by a
// handover version is left in place and reported, because withdrawing an
// identity something else is using is not a rollback, it is a break.
//
// Usage:
//   node scripts/backfill-customer-request-line-refs.js
//   node scripts/backfill-customer-request-line-refs.js --json
//   node scripts/backfill-customer-request-line-refs.js --apply --authorized-by="R Ray"
//   node scripts/backfill-customer-request-line-refs.js --rollback <batchId> --apply --authorized-by="R Ray"

"use strict";

require("dotenv").config();
const crypto = require("crypto");
const mongoose = require("mongoose");

const CustomerRequest = require("../models/Customer_Models/CustomerRequest");
const SalesHandoverVersion = require("../models/CMS_Models/Sales/SalesHandoverVersion");
const {
  LINE_REF_PATTERN, mintLineRef,
} = require("../models/Customer_Models/customerRequestLineIdentity");

const str = (v) => String(v ?? "").trim();

function parseArgs(argv) {
  const args = { apply: false, json: false, authorizedBy: "", rollback: "" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--json") args.json = true;
    else if (a === "--authorized-by") args.authorizedBy = str(argv[++i]);
    else if (a.startsWith("--authorized-by=")) args.authorizedBy = str(a.slice(16));
    else if (a === "--rollback") args.rollback = str(argv[++i]);
    else if (a.startsWith("--rollback=")) args.rollback = str(a.slice(11));
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

/** A run identity that is also the rollback identity. */
function newBatchId() {
  return `linerefs-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * What is wrong with this request's existing references, if anything.
 *
 * A refusal is per REQUEST, not per line: the uniqueness that matters is
 * within one order, and half-assigning an order whose other lines are corrupt
 * would leave it in a state neither this tool nor a person can reason about.
 */
function corruption(request) {
  const held = (request.items || []).map((i) => str(i.lineRef)).filter(Boolean);
  const malformed = held.filter((v) => !LINE_REF_PATTERN.test(v));
  if (malformed.length) {
    return `carries ${malformed.length} line reference(s) this system did not issue`;
  }
  if (new Set(held).size !== held.length) {
    return "carries the same line reference on more than one line";
  }
  return null;
}

async function runBackfill(args, out) {
  const batchId = newBatchId();
  out.batchId = batchId;
  out.rollbackWith = `node scripts/backfill-customer-request-line-refs.js --rollback ${batchId} --apply --authorized-by="..."`;

  const cursor = CustomerRequest.find({}).cursor();

  for await (const request of cursor) {
    out.requestsInspected += 1;
    const items = request.items || [];
    out.linesInspected += items.length;

    const bad = corruption(request);
    if (bad) {
      out.requestsRefused += 1;
      out.refusals.push({ requestRef: str(request.requestId), because: bad });
      continue;
    }

    const missing = items.filter((i) => !str(i.lineRef));
    out.linesAlreadyValid += items.length - missing.length;
    if (!missing.length) continue;

    out.requestsNeedingWork += 1;
    out.linesMissing += missing.length;

    if (!args.apply) continue;

    /* Content and order are untouched: only the empty identity is filled. */
    const seen = new Set(items.map((i) => str(i.lineRef)).filter(Boolean));
    const assigned = [];
    for (const item of missing) {
      let minted = mintLineRef();
      while (seen.has(minted)) minted = mintLineRef();
      seen.add(minted);
      item.set("lineRef", minted);
      assigned.push(minted);
    }
    request.set("lineRefBackfill", {
      batchId, at: new Date(), authorizedBy: args.authorizedBy, assigned,
    });
    await request.save({ validateBeforeSave: true });
    out.linesAssigned += assigned.length;
  }
}

/**
 * Undo one batch — but only where the identity is genuinely unused.
 *
 * A line reference that a handover version already names is left exactly
 * where it is, and reported. Withdrawing it would leave that version pointing
 * at a line that no longer answers to the name, which is a worse state than
 * the one the rollback was trying to reach.
 */
async function runRollback(args, out) {
  out.batchId = args.rollback;
  const cursor = CustomerRequest.find({ "lineRefBackfill.batchId": args.rollback }).cursor();

  for await (const request of cursor) {
    out.requestsInspected += 1;
    const assigned = new Set((request.lineRefBackfill?.assigned || []).map(str));
    if (!assigned.size) continue;

    const inUse = new Set(
      (await SalesHandoverVersion.find({
        handoverRef: str(request.requestId),
        handoverLineRef: { $in: [...assigned] },
      }).select("handoverLineRef").lean()).map((v) => str(v.handoverLineRef)),
    );

    /* Only the lines this batch assigned, and only those nothing points at.
       Everything else on the order is left exactly as it is. */
    const clearable = new Set();
    for (const item of request.items || []) {
      const held = str(item.lineRef);
      if (!assigned.has(held)) continue;
      if (inUse.has(held)) {
        out.linesRetained += 1;
        out.refusals.push({
          requestRef: str(request.requestId), lineRef: held,
          because: "a handover version already names this line",
        });
        continue;
      }
      clearable.add(held);
    }
    out.linesCleared += clearable.size;

    if (args.apply && clearable.size) {
      /* ── THE ONE WRITE THAT GOES AROUND THE HOOK ──────────────────────
         The pre-validate hook mints a reference for any line that has none,
         so saving this document would immediately hand back new identities —
         the exact opposite of a rollback. So the lines are rewritten through
         an update, which does not run document middleware, and this is the
         only place in the system that does that deliberately. */
      const items = (request.items || []).map((i) => {
        const o = i.toObject();
        if (clearable.has(str(o.lineRef))) delete o.lineRef;
        return o;
      });
      await CustomerRequest.updateOne(
        { _id: request._id },
        { $set: { items }, $unset: { lineRefBackfill: "" } },
      );
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.apply && !args.authorizedBy) {
    console.error(
      "--apply refused: this writes to Sales order records and needs explicit authorization.\n"
      + 'Pass --authorized-by="<person who authorised this run>" — and do not run --apply\n'
      + "against user data without that authorization actually existing.",
    );
    process.exit(2);
  }

  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");

  const out = {
    mode: args.rollback ? "rollback" : "backfill",
    applied: args.apply,
    authorizedBy: args.authorizedBy || null,
    batchId: null,
    rollbackWith: null,
    requestsInspected: 0,
    requestsNeedingWork: 0,
    requestsRefused: 0,
    linesInspected: 0,
    linesAlreadyValid: 0,
    linesMissing: 0,
    linesAssigned: 0,
    linesCleared: 0,
    linesRetained: 0,
    refusals: [],
  };

  if (args.rollback) await runRollback(args, out);
  else await runBackfill(args, out);

  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`\nCustomer request line references — ${out.mode}`
      + `${args.apply ? ` (APPLIED, authorised by ${args.authorizedBy})` : " (dry run — nothing written)"}`);
    console.log(`  Requests inspected     : ${out.requestsInspected}`);
    console.log(`  Lines inspected        : ${out.linesInspected}`);
    if (args.rollback) {
      console.log(`  Batch                  : ${out.batchId}`);
      console.log(`  References ${args.apply ? "cleared     " : "clearable   "}: ${out.linesCleared}`);
      console.log(`  Retained (in use)      : ${out.linesRetained}`);
    } else {
      console.log(`  Already had one        : ${out.linesAlreadyValid}`);
      console.log(`  Missing one            : ${out.linesMissing}`);
      console.log(`  ${args.apply ? "Assigned this run      " : "Would be assigned      "}: ${args.apply ? out.linesAssigned : out.linesMissing}`);
      console.log(`  Requests refused       : ${out.requestsRefused}`);
      if (args.apply && out.batchId) {
        console.log(`\n  Batch identity: ${out.batchId}`);
        console.log(`  To undo:        ${out.rollbackWith}`);
      }
    }
    for (const r of out.refusals.slice(0, 20)) {
      console.log(`    refused: ${r.requestRef}${r.lineRef ? ` / ${r.lineRef}` : ""} — ${r.because}`);
    }
    if (out.refusals.length > 20) console.log(`    ... and ${out.refusals.length - 20} more (use --json for all)`);
    console.log("");
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Backfill failed:", err?.message || err);
  process.exit(1);
});
