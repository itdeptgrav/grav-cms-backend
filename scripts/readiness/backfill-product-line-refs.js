// scripts/readiness/backfill-product-line-refs.js
//
// GIVE EVERY EXISTING JOURNEY PRODUCT LINE ITS PERMANENT NAME.
//
// New enquiry lines get a reference from the pre-validate hook on
// `Enquiry.products`. Lines saved before that hook existed have none, and a
// line without one cannot be sent for development — the Sales panel offers no
// button for it, deliberately, because sending against a name or a position is
// exactly what the reference exists to prevent.
//
// This is the one backfill the closure needs.
//
//   node -r dotenv/config scripts/readiness/backfill-product-line-refs.js
//   node -r dotenv/config scripts/readiness/backfill-product-line-refs.js --apply
//
// WITHOUT `--apply` it changes nothing and prints what it would do. That is
// the default on purpose: a script that writes when you forget a flag is a
// script somebody runs against production while reading its help.
//
// ── WHY IT IS A SAVE AND NOT AN UPDATE ──────────────────────────────────────
// The hook is what mints and validates a reference — it refuses duplicates and
// refuses one this system did not issue. Writing the field with `updateOne`
// would bypass exactly the code that makes the value trustworthy. So each
// affected enquiry is loaded, marked modified and saved, and the hook does the
// work it was written to do.
//
// It is safe to run repeatedly: the hook never reissues a reference a line
// already has, so a second run reports zero.
"use strict";

const mongoose = require("mongoose");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");

const CLI_APPLY = process.argv.includes("--apply");
const line = (s = "") => process.stdout.write(`${s}\n`);

/**
 * The backfill itself, on an already-open connection.
 *
 * Exported so a harness can drive it in-process. The CLI below is the same code
 * with a connection around it — one implementation, so proving the export
 * proves what a person runs.
 */
async function backfill({ apply = false, log = line } = {}) {
  const affected = await Enquiry.find({
    products: { $elemMatch: { $or: [{ productLineRef: { $exists: false } }, { productLineRef: "" }] } },
  });

  let linesFixed = 0, enquiriesSaved = 0, failures = 0;
  const refused = [];
  for (const enquiry of affected) {
    const missing = (enquiry.products || []).filter((p) => !p.productLineRef).length;
    if (!missing) continue;

    log(`${enquiry.enquiryId || enquiry._id}  ${missing} line(s) without a reference`);
    linesFixed += missing;

    if (!apply) continue;
    try {
      /* The hook runs on validate, and it only runs if mongoose believes the
         array changed. Saying so explicitly is what makes this deterministic
         rather than dependent on whether anything else touched the document. */
      enquiry.markModified("products");
      await enquiry.save();
      enquiriesSaved += 1;
    } catch (err) {
      failures += 1;
      refused.push({ enquiryId: String(enquiry.enquiryId || enquiry._id), reason: err.message });
      log(`   REFUSED: ${err.message}`);
    }
  }

  return { enquiriesAffected: affected.length, linesFixed, enquiriesSaved, failures, refused };
}

async function main() {
  const APPLY = CLI_APPLY;
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  line(APPLY
    ? "BACKFILL — APPLYING. Enquiries will be saved."
    : "BACKFILL — DRY RUN. Nothing will be written. Pass --apply to write.");
  line(`database: ${mongoose.connection.name}`);
  line("");

  const res = await backfill({ apply: APPLY });

  line("");
  line(`enquiries affected      ${res.enquiriesAffected}`);
  line(`lines without one       ${res.linesFixed}`);
  if (APPLY) {
    line(`enquiries saved         ${res.enquiriesSaved}`);
    line(`refused                 ${res.failures}`);
    line("");
    line(res.failures
      ? "Some enquiries were refused. They are unchanged; read the reason above."
      : "Done. Re-run without --apply to confirm nothing is left.");
  } else {
    line("");
    line("Nothing was written. Re-run with --apply to perform the backfill.");
  }

  await mongoose.disconnect();
}

module.exports = { backfill };

/* Required by the closure harness, run by a person. Only the second connects. */
if (require.main === module) {
  main().catch(async (e) => {
    line(`\nBACKFILL COULD NOT COMPLETE: ${e.message}`);
    await mongoose.disconnect().catch(() => {});
    process.exitCode = 1;
  });
}
