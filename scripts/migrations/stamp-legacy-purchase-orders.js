// scripts/migrations/stamp-legacy-purchase-orders.js
//
// STAMP THE PURCHASE ORDERS THAT PREDATE THE MATERIAL-REQUEST RULE.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// From A2, a material purchase order must prove why it exists, and carries a
// policy stamp recording the rules it was raised under. Orders raised before
// that rule have none of it, and they are not wrong for that — they predate it.
//
// Classification is something a record CARRIES, never something inferred from a
// date: inference fails OPEN, so an order with a missing or unreadable
// `createdAt` would be treated as historical and inherit every allowance.
// After this has run, every purchase order is in one of three states, and only
// the first two may act:
//
//   LEGACY_PRE_MRF_V1   historical, migrated, keeps its old rules
//   MRF_REQUIRED_V1     governed, carries its full chain
//   unstamped           unproven — refused from acting, still readable
//
// ── THE CUTOVER IS A DEPLOYMENT FACT, NOT A CONSTANT ────────────────────────
// It must be the instant enforcement actually went live in THIS environment.
// A constant compiled into the code cannot know that: orders raised between an
// arbitrary start-of-day and the real deployment would be left unstamped and
// unissuable — legitimate drafts, stranded. So it is supplied explicitly and
// recorded in the report.
//
// ── ROLLOUT ORDER ──────────────────────────────────────────────────────────
//   1. Deploy the enforcing code. From this instant every NEW order is stamped
//      MRF_REQUIRED_V1 as it is created, so the set below stops growing.
//   2. Note that instant. It is the cutover.
//   3. Run this DRY (no --apply) with --cutover=<that instant>. It reports
//      exactly which ids it would stamp, and lists any it will not.
//   4. Resolve the undated ones deliberately — see --ids below.
//   5. Re-run with --apply.
//
// Running the migration BEFORE step 1 leaves a window in which unstamped,
// unissuable orders are still being created. Running it after step 1 is safe at
// any time, and re-running is idempotent: it only ever touches orders that
// carry no policy at all.
//
// ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
// It invents no material request, no purchase request, no department, no budget
// head and no approval. It records one fact — "this order predates the rule" —
// and only for orders that demonstrably do.
//
// Usage:
//   node scripts/migrations/stamp-legacy-purchase-orders.js --cutover=2026-09-28T14:05:00Z
//   node scripts/migrations/stamp-legacy-purchase-orders.js --cutover=… --apply
//   node scripts/migrations/stamp-legacy-purchase-orders.js --object-ids=<_id>,<_id> --apply
"use strict";

require("dotenv").config();
const mongoose = require("mongoose");

const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const governed = require("../../services/storePurchase/governedPurchaseOrder.service");

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const APPLY = process.argv.includes("--apply");

/** Orders with no policy at all — the only ones this may ever touch. */
const UNSTAMPED = Object.freeze({ provenancePolicy: { $in: [null, ""] } });

/**
 * The cutover, from the operator, because only they know when enforcement
 * actually went live here.
 *
 * `SP_PROVENANCE_CUTOVER` is accepted so a deployment pipeline can supply it
 * once rather than a person retyping it between the dry run and the apply.
 */
function cutover() {
  const raw = arg("cutover") || process.env.SP_PROVENANCE_CUTOVER;
  if (!raw) {
    throw new Error(
      "--cutover=<ISO instant> is required: the moment enforcement went live in THIS environment.\n"
      + "Deploy the enforcing code first, note that instant, then pass it here. A guessed cutover\n"
      + "strands every order raised between the guess and the real deployment.",
    );
  }
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) throw new Error(`--cutover is not a readable instant: ${raw}`);
  if (at > new Date()) throw new Error("--cutover is in the future; enforcement cannot have gone live yet.");
  return at;
}

/**
 * What an explicit `--object-ids` run would stamp. Writes nothing.
 *
 * ── EVERY ID IS CHECKED BEFORE ANYTHING IS WRITTEN ──────────────────────────
 * A malformed or unknown id stops the whole run rather than being skipped. An
 * operator who mistyped one of five ids needs to be told that, not to discover
 * afterwards that four were stamped and one was not.
 */
async function planExplicit(ids) {
  const bad = ids.filter((x) => !mongoose.isValidObjectId(x));
  if (bad.length) {
    throw new Error(`Not valid purchase-order ids: ${bad.join(", ")}. Nothing was written.`);
  }

  const all = await PurchaseOrder.find({ _id: { $in: ids } })
    .select("_id poNumber companyId createdAt provenancePolicy").lean();
  const byId = new Map(all.map((d) => [String(d._id), d]));

  const missing = ids.filter((x) => !byId.has(x));
  if (missing.length) {
    throw new Error(`No purchase order with these ids: ${missing.join(", ")}. Nothing was written.`);
  }

  const already = all.filter((d) => d.provenancePolicy);
  const eligible = all.filter((d) => !d.provenancePolicy);
  return { eligible, already, targets: eligible.map((d) => d._id) };
}

/**
 * What an ordinary cutover run would stamp, and what it refuses to.
 *
 * Unstamped AND created before the cutover, with a date that can be read. An
 * order with no usable `createdAt` cannot demonstrate that it predates the
 * rule, so it is listed rather than swept up.
 */
async function planByCutover(at) {
  const eligibleFilter = { ...UNSTAMPED, createdAt: { $type: "date", $lt: at } };
  const undatedFilter = {
    ...UNSTAMPED,
    $or: [{ createdAt: { $exists: false } }, { createdAt: null }, { createdAt: { $not: { $type: "date" } } }],
  };
  /* Unstamped, dated, and created AFTER the cutover: these should not exist,
     because everything raised after enforcement went live is stamped as it is
     created. If any appear, enforcement was not live when it was believed. */
  const afterFilter = { ...UNSTAMPED, createdAt: { $type: "date", $gte: at } };

  const [eligible, undated, after, governedCount, already] = await Promise.all([
    PurchaseOrder.find(eligibleFilter).select("_id poNumber companyId createdAt").lean(),
    PurchaseOrder.find(undatedFilter).select("_id poNumber companyId").limit(500).lean(),
    PurchaseOrder.find(afterFilter).select("_id poNumber createdAt").limit(500).lean(),
    PurchaseOrder.countDocuments({ provenancePolicy: governed.PROVENANCE_POLICY }),
    PurchaseOrder.countDocuments({ provenancePolicy: governed.LEGACY_POLICY }),
  ]);
  return {
    at, eligible, undated, after, governedCount, already,
    targets: eligible.map((d) => d._id),
  };
}

/**
 * The one write.
 *
 * Idempotent by construction: the filter matches only orders carrying no
 * policy, so a second run stamps nothing and a governed order can never be
 * caught even by a mistyped id.
 */
function applyStamp(ids) {
  if (!ids.length) return Promise.resolve({ modifiedCount: 0 });
  return PurchaseOrder.updateMany(
    { ...UNSTAMPED, _id: { $in: ids } },
    {
      $set: {
        provenancePolicy: governed.LEGACY_POLICY,
        provenanceMigratedAt: new Date(),
      },
    },
  );
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error("MONGODB_URI is not set.");

  /* ── EXPLICIT TARGETS ARE MONGO IDS, NEVER PO NUMBERS ──────────────────
     A PO number is unique only WITHIN a company, so `poNumber: { $in: [...] }`
     can match one document per tenant and stamp several companies when the
     operator meant one. There is no safe way to disambiguate a bare number on
     a command line, so the option takes immutable `_id` values, which identify
     exactly one document and cannot be re-used or renumbered.

     `--ids` is refused outright rather than silently reinterpreted: an
     operator typing it believes it works, and a script that quietly changed
     meaning between versions is worse than one that stops. */
  if (arg("ids")) {
    throw new Error(
      "--ids is not supported: a PO number is unique only within a company, so it can match one\n"
      + "document per tenant and stamp several companies at once. Use --object-ids=<_id>,<_id>\n"
      + "with the immutable ids the dry run prints.",
    );
  }
  const explicitIds = (arg("object-ids") || "").split(",").map((x) => x.trim()).filter(Boolean);
  const at = explicitIds.length && !arg("cutover") && !process.env.SP_PROVENANCE_CUTOVER
    ? null
    : cutover();

  await mongoose.connect(uri);

  if (explicitIds.length) {
    const plan = await planExplicit(explicitIds);

    console.log(`explicit ids requested  ${explicitIds.length}`);
    console.log(`eligible (unstamped)    ${plan.eligible.length}`);
    for (const po of plan.eligible) {
      console.log(`  _id=${po._id}  ${po.poNumber || "(no number)"}  company=${po.companyId || "none"}  created=${po.createdAt || "none"}`);
    }
    if (plan.already.length) {
      /* Reported separately: already-stamped is not an error, and lumping it
         in with "not found" hides which of the two happened. */
      console.log("Already stamped — will not be touched:");
      for (const po of plan.already) console.log(`  _id=${po._id}  ${po.poNumber || ""}  policy=${po.provenancePolicy}`);
    }

    if (!APPLY) { console.log("\nDry run. Nothing written. Re-run with --apply."); return; }

    const res = await applyStamp(plan.targets);
    console.log(`\nstamped ${res.modifiedCount} order(s) as ${governed.LEGACY_POLICY}.`);
    return;
  }

  /* ── THE ORDINARY RUN ──────────────────────────────────────────────────
     Unstamped AND created before the cutover, with a date that can actually be
     read. An order with no usable `createdAt` is deliberately excluded: it
     cannot demonstrate that it predates the rule, and stamping it would be the
     same fail-open guess this whole mechanism replaces. */
  /* The same planner the tests drive, so the report and the write describe
     the same set. */
  const { eligible, undated, after, governedCount, already } = await planByCutover(at);

  console.log("── ROLLOUT REPORT ──────────────────────────────────────────────");
  console.log(`cutover (enforcement live)  ${at.toISOString()}`);
  console.log(`already stamped legacy      ${already}`);
  console.log(`governed (A2 or later)      ${governedCount}`);
  console.log(`eligible to stamp           ${eligible.length}`);
  console.log(`undated, NOT stamped        ${undated.length}`);
  console.log(`unstamped AFTER cutover     ${after.length}`);

  if (eligible.length) {
    console.log("\nWill stamp:");
    for (const po of eligible) {
      /* `_id` first: it is what `--object-ids` takes, and what the apply uses. */
      console.log(`  _id=${po._id}  ${po.poNumber || "(no number)"}  company=${po.companyId || "none"}  created=${new Date(po.createdAt).toISOString()}`);
    }
  }
  if (undated.length) {
    /* Named, not swept up. Each needs a person to say whether it is a real
       historical order or a bad row — this migration cannot know. */
    console.log("\nNo usable creation date — will NOT be stamped. Resolve each deliberately:");
    for (const po of undated) console.log(`  _id=${po._id}  ${po.poNumber || "(no number)"}  company=${po.companyId || "none"}`);
    console.log("  Stamp the genuine ones with:  --object-ids=<_id,_id> --apply");
    console.log("  Raise the rest again from their material request.");
  }
  if (after.length) {
    console.log("\nWARNING — unstamped orders created AFTER the cutover:");
    for (const po of after) console.log(`  ${po.poNumber || po._id}  created=${new Date(po.createdAt).toISOString()}`);
    console.log("  These should not exist: everything raised after enforcement went live is");
    console.log("  stamped as it is created. Either the cutover given here is too early, or");
    console.log("  enforcement was not live when it was believed to be. Check before applying.");
  }

  if (!APPLY) {
    console.log("\nDry run. Nothing was written. Re-run with --apply to stamp the list above.");
    return;
  }
  if (after.length) {
    throw new Error("Refusing to apply while unstamped orders exist after the cutover — see the warning above.");
  }

  const res = await applyStamp(eligible.map((d) => d._id));
  console.log(`\nstamped ${res.modifiedCount} order(s) as ${governed.LEGACY_POLICY}.`);
  console.log("Re-running is safe: only orders carrying no policy are ever touched.");
}

/* ── THE PARTS TESTS CAN DRIVE ──────────────────────────────────────────────
 * `planExplicit` and `planByCutover` decide WHAT would be stamped and write
 * nothing; `applyStamp` performs the one write. They are exported so a test
 * exercises the real code rather than a copy of it — a defect in a duplicated
 * helper passes while the script itself is broken, which is the whole reason
 * this split exists.
 *
 * The CLI is unchanged: `main()` still parses the same arguments, prints the
 * same report and runs only when this file is executed directly. Requiring it
 * connects to nothing. */
module.exports = {
  planExplicit, planByCutover, applyStamp, cutover,
  UNSTAMPED, LEGACY: governed.LEGACY_POLICY,
};

if (require.main === module) {
  main()
    .catch((e) => { console.error(String(e.message || e)); process.exitCode = 1; })
    /* Always disconnects — a failure that leaves the connection open hangs the
       process and hides the error behind a timeout. */
    .finally(() => mongoose.disconnect());
}
