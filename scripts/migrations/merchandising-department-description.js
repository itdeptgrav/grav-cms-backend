// scripts/migrations/merchandising-department-description.js
//
// Correct the Merchandising department's seeded description, and nothing else.
//
// ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
// The department was registered with the description
//
//   "Purchase orders & PI, customers, and products & BOM."
//
// which described the pages Merchandising had BORROWED from Sales and Store —
// not the work it owns. Purchase orders and customers are Sales'; the
// downstream product record is Inventory's. `services/ensureAccessDepartments.js`
// now seeds the truthful wording for a fresh database:
//
//   "Style execution, component selection and development coordination."
//
// Every database seeded before that keeps the old sentence, because the seeder
// is STRICTLY ADDITIVE and must stay that way. Turning it into an unconditional
// updater would fix this one string and, on the very same restart, silently
// overwrite every description an administrator had edited — including the ones
// they edited precisely because the seeded text was wrong.
//
// So the correction is this: a one-off, idempotent, narrowly targeted update.
//
// ── THE RULE IT REFUSES TO BREAK ────────────────────────────────────────────
// It rewrites ONE row, matched on `key: "merchandiser"`, and only when that
// row's description is EXACTLY the old system-supplied sentence. Any other
// value is an administrator's own words and is left untouched and reported.
// Running it twice changes nothing the second time, because after the first run
// the description no longer matches.
//
// It does not touch the name, the slug, the dashboard path, the sort order, the
// active flag, any other department, or any login.
//
// ── IT HAS NOT BEEN RUN ─────────────────────────────────────────────────────
// Not against production, not against staging. It defaults to a DRY RUN and
// needs `--apply` to write anything.
//
//   node scripts/migrations/merchandising-department-description.js           # dry run
//   node scripts/migrations/merchandising-department-description.js --apply   # writes
//
// Requires MONGODB_URI in the environment, as every other script here does.
"use strict";

const DEPARTMENT_KEY = "merchandiser";

/** The exact sentence the seeder used to supply. Nothing else is a match. */
const OLD_DEFAULT = "Purchase orders & PI, customers, and products & BOM.";

/** The sentence the seeder supplies now — kept in step by a test. */
const NEW_DEFAULT = "Style execution, component selection and development coordination.";

/**
 * Decide what this migration would do, without doing it.
 *
 * Separated from the CLI so the decision — not just the effect — is testable:
 * "the old default changes" and "a custom value remains" are two claims about
 * this function, and neither needs a process to prove.
 *
 * @param {import("mongoose").Model} AccessDepartment
 * @returns {Promise<{outcome: string, found: boolean, before: string|null}>}
 *   `outcome` is one of ABSENT, ALREADY_CORRECT, CUSTOMISED, WILL_UPDATE.
 */
async function planDescriptionFix(AccessDepartment) {
  const row = await AccessDepartment.findOne({ key: DEPARTMENT_KEY })
    .select("_id description").lean();

  if (!row) return { outcome: "ABSENT", found: false, before: null };

  const before = String(row.description ?? "");
  if (before === NEW_DEFAULT) return { outcome: "ALREADY_CORRECT", found: true, before };
  if (before !== OLD_DEFAULT) return { outcome: "CUSTOMISED", found: true, before };
  return { outcome: "WILL_UPDATE", found: true, before };
}

/**
 * Apply the correction, if the plan says there is one to apply.
 *
 * The write repeats the match on the old value, so two runs racing each other
 * cannot both claim to have changed the row, and a description edited between
 * the plan and the write is left alone rather than overwritten.
 *
 * @returns {Promise<{outcome: string, updated: number, before: string|null}>}
 */
async function applyDescriptionFix(AccessDepartment) {
  const plan = await planDescriptionFix(AccessDepartment);
  if (plan.outcome !== "WILL_UPDATE") return { ...plan, updated: 0 };

  const res = await AccessDepartment.updateOne(
    { key: DEPARTMENT_KEY, description: OLD_DEFAULT },
    { $set: { description: NEW_DEFAULT } },
  );
  return { ...plan, outcome: "UPDATED", updated: res.modifiedCount || 0 };
}

/** What a person running this should read on their terminal. */
function describe(plan, { applied }) {
  switch (plan.outcome) {
    case "ABSENT":
      return "No Merchandising department row exists on this database. Nothing to do.";
    case "ALREADY_CORRECT":
      return "The Merchandising description is already the corrected wording. Nothing to do.";
    case "CUSTOMISED":
      return "REFUSING: the Merchandising description is not the old system default — somebody "
        + `has edited it. Leaving it exactly as it is:\n  "${plan.before}"`;
    case "UPDATED":
      return `Updated ${plan.updated} row.\n  was: "${OLD_DEFAULT}"\n  now: "${NEW_DEFAULT}"`;
    case "WILL_UPDATE":
      return applied
        ? "The row moved underneath this run and was left alone."
        : `DRY RUN — would update 1 row.\n  was: "${plan.before}"\n  would be: "${NEW_DEFAULT}"\n`
          + "Re-run with --apply to write it.";
    default:
      return `Unrecognised outcome: ${plan.outcome}`;
  }
}

async function main() {
  require("dotenv").config();
  const mongoose = require("mongoose");
  const APPLY = process.argv.includes("--apply");

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is not set. Refusing to guess a database.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  try {
    const AccessDepartment = require("../../models/Access/AccessDepartment");
    const result = APPLY
      ? await applyDescriptionFix(AccessDepartment)
      : await planDescriptionFix(AccessDepartment);
    console.log(describe(result, { applied: APPLY }));
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  DEPARTMENT_KEY, OLD_DEFAULT, NEW_DEFAULT,
  planDescriptionFix, applyDescriptionFix, describe,
};
