// backfill_account_groups.js
//
// One-off. Gives the group spine the links that were only ever recorded as
// labels.
//
// Before 22 Aug 2026, picking "Parent Of" / "Subsidiary Of" in Related
// Organizations wrote a CRMAccountRelationship row and nothing else —
// `Account.parentAccountId`, the field the hierarchy actually walks, was never
// set by any UI. So every group entered that way exists as a label and is
// invisible to the Group card, the hierarchy endpoint and anything that rolls
// up. Going forward the route keeps the two in step (services/crmGroupLink.js);
// this catches up what was entered before it did.
//
// SAFE BY DEFAULT: prints what it would do and writes nothing. Pass --apply to
// commit. Idempotent — a second run reports every row as already correct.
//
//   node -r dotenv/config backfill_account_groups.js            # dry run
//   node -r dotenv/config backfill_account_groups.js --apply    # commit
//
// CONFLICTS ARE REPORTED, NEVER RESOLVED. An account has exactly one parent; if
// two active rows claim different ones, or a row would close a cycle, this
// prints it and skips it. Which parent is right is a business question, so it
// is left to a person and the Related Organizations UI.

"use strict";

const mongoose = require("mongoose");
const Account = require("./models/CMS_Models/Sales/Account");
const Relationship = require("./models/CMS_Models/Sales/AccountRelationship");
const { resolveGroupEdge, isHierarchyType } = require("./services/crmGroupLink");
const { assertNoAccountCycle } = require("./services/crmHierarchy");

const APPLY = process.argv.includes("--apply");

async function main() {
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing";
  await mongoose.connect(uri);
  console.log(`connected: ${uri.replace(/\/\/[^@]+@/, "//***@")}\n`);

  const rows = await Relationship.find({
    isActive: true,
    relationshipType: { $in: ["parent_of", "subsidiary_of"] },
  }).lean();

  console.log(`${rows.length} active hierarchy relationship${rows.length === 1 ? "" : "s"} found.\n`);

  // Group the proposed edges by child first, so an account claimed by two
  // different parents is reported once as a conflict rather than written twice
  // with the last row silently winning.
  const byChild = new Map();
  for (const r of rows) {
    if (!isHierarchyType(r.relationshipType)) continue;
    const edge = resolveGroupEdge(r);
    if (!edge) continue;
    if (!byChild.has(edge.childId)) byChild.set(edge.childId, []);
    byChild.get(edge.childId).push({ ...edge, relationshipId: r.relationshipId || String(r._id) });
  }

  const name = async (id) => {
    const a = await Account.findById(id).select("companyName accountId").lean();
    return a ? `${a.companyName}${a.accountId ? ` (${a.accountId})` : ""}` : `<missing ${id}>`;
  };

  let willSet = 0, already = 0, conflicts = 0, skipped = 0;

  for (const [childId, edges] of byChild) {
    const child = await Account.findById(childId).select("companyName accountId parentAccountId").lean();
    if (!child) {
      console.log(`SKIP    child account ${childId} no longer exists`);
      skipped += 1;
      continue;
    }

    const parents = [...new Set(edges.map((e) => e.parentId))];
    if (parents.length > 1) {
      const names = await Promise.all(parents.map(name));
      console.log(`CONFLICT ${await name(childId)} is claimed by ${parents.length} parents: ${names.join(" / ")} — left untouched`);
      conflicts += 1;
      continue;
    }

    const parentId = parents[0];
    const current = child.parentAccountId ? String(child.parentAccountId) : null;

    if (current === parentId) {
      already += 1;
      continue;
    }
    if (current && current !== parentId) {
      console.log(`CONFLICT ${await name(childId)} already sits under ${await name(current)}, relationship says ${await name(parentId)} — left untouched`);
      conflicts += 1;
      continue;
    }

    try {
      await assertNoAccountCycle(Account, childId, parentId);
    } catch (e) {
      console.log(`CONFLICT ${await name(childId)} → ${await name(parentId)} would create a cycle — left untouched`);
      conflicts += 1;
      continue;
    }

    console.log(`${APPLY ? "SET     " : "WOULD SET"} ${await name(childId)} → ${await name(parentId)}`);
    if (APPLY) await Account.findByIdAndUpdate(childId, { parentAccountId: parentId });
    willSet += 1;
  }

  console.log(
    `\n${APPLY ? "Set" : "Would set"}: ${willSet}   already correct: ${already}   conflicts: ${conflicts}   skipped: ${skipped}`,
  );
  if (!APPLY && willSet > 0) console.log("\nNothing was written. Re-run with --apply to commit.");

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect();
  process.exit(1);
});
