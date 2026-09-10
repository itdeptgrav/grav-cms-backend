// verifyPartyLinkSafety.js
//
// A merge must not hand one party's CRM link to another party's ledger.
//
// Run:  node -r dotenv/config verifyPartyLinkSafety.js
//
// WHAT THIS IS ABOUT
// Merging ledger A into ledger B used to copy A's linkedCustomerId onto B
// whenever B had none. The customer page resolves its ledger through that
// field, so a mismatched merge made one customer's page display another
// customer's invoices, receipts and balance — under the wrong name, with
// nothing on screen to suggest it. It happened here: a ledger linked to
// "MAYFAIR CORPORATE BBSR" was merged into "MAYFAIR World Cup Village,
// Rourkela", and BBSR's page then showed Rourkela's books.
//
// The guard must do BOTH jobs. Refusing everything would be safe and useless:
// merging a CRM duplicate into the Tally ledger that holds the trade is the
// whole point of the feature, and that link MUST transfer. So the pairs below
// are the real ones out of this database, both kinds.
//
// READ-ONLY. No database writes; the live pairs are only read.

"use strict";

const mongoose = require("mongoose");
const { sameParty, inheritablePartyLinks } = require("./services/partyLinkSafety");

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass += 1; console.log(`  ok    ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? ` -- ${d}` : ""}`); }
};

(async () => {
  console.log("\nthe pair that caused this");
  check('"MAYFAIR World Cup Village, Rourkela" is NOT "MAYFAIR CORPORATE BBSR"',
    sameParty("MAYFAIR World Cup Village, Rourkela", "MAYFAIR CORPORATE BBSR") === false);

  console.log("\nreal duplicates still inherit — the feature must keep working");
  for (const [a, b] of [
    ["MAYFAIR Lake Resort Raipur", "Mayfair Lake Resort (Raipur)"],
    ["MAYFAIR Spa & Casino Gangtok", "Mayfair Spa Resort and Casino (Gangtok)"],
    ["MAYFAIR Tea Resort Siliguri", "Mayfair Tea Resorts (Siliguri)"],
    ["MAYFAIR Corporate", "M/s Mayfair Hotels & Resorts Ltd.(CORPORATE)"],
    ["MAYFAIR Sanctuary", "MAYFAIR SANCTUARY BBSR"],
    ["MAYFAIR Hill Resort Darjeeling", "Mayfair Darjeeling"],
    ["MAYFAIR On Sea Gopalpur", "MAYFAIR HOTELS & RESORTS (GOPALPUR)"],
    ["Mayfair garden", "Mayfair Garden, Rourkela"],
    ["[MERGED] Acme Ltd", "Acme Limited"],
    ["Sharma Traders", "Sharma Trading Co"],
  ]) check(`"${a}" ~ "${b}"`, sameParty(a, b) === true);

  console.log("\ndifferent parties are refused, including near-misses");
  for (const [a, b] of [
    ["MAYFAIR Convention", "MAYFAIR Lagoon"],
    ["Indian Bank", "HDFC Bank Current A/c"],
    ["Sharma Traders", "Verma Traders"],
    ["MAYFAIR Bay Resort Paradeep", "MAYFAIR Oasis Jharsuguda"],
  ]) check(`"${a}" is not "${b}"`, sameParty(a, b) === false);

  console.log("\nthe brand alone never proves identity");
  check('two different MAYFAIR hotels do not match on "mayfair"',
    sameParty("MAYFAIR Lagoon", "MAYFAIR Convention") === false);
  check("nor do two ledgers made only of noise words",
    sameParty("Hotels Ltd", "Resorts Pvt Ltd") === false);

  console.log("\nwhat the merge is allowed to copy");
  const src = { name: "MAYFAIR Corporate", linkedCustomerId: "C1" };
  const dstOk = { name: "M/s Mayfair Hotels & Resorts Ltd.(CORPORATE)" };
  const okRes = inheritablePartyLinks(src, dstOk);
  check("a true duplicate carries its customer link over",
    okRes.$set.linkedCustomerId === "C1" && okRes.skipped.length === 0);

  const dstBad = { name: "MAYFAIR World Cup Village, Rourkela" };
  const badRes = inheritablePartyLinks(
    { name: "MAYFAIR CORPORATE BBSR", linkedCustomerId: "C1" }, dstBad);
  check("a mismatched merge copies nothing", !("linkedCustomerId" in badRes.$set));
  check("and says why, rather than failing silently",
    badRes.skipped.length === 1 && /same party/i.test(badRes.skipped[0]),
    JSON.stringify(badRes.skipped));

  const dstHas = { name: "Mayfair Lake Resort (Raipur)", linkedCustomerId: "KEEP" };
  const keep = inheritablePartyLinks(
    { name: "MAYFAIR Lake Resort Raipur", linkedCustomerId: "C9" }, dstHas);
  check("a destination's own link is never overwritten",
    !("linkedCustomerId" in keep.$set));

  console.log("\nboth merge routes use the guard");
  const fs = require("fs");
  for (const f of ["routes/Accountant_Routes/Acc_chartOfAccounts.js",
                   "routes/Accountant_Routes/Acc_approvals.js"]) {
    const src2 = fs.readFileSync(f, "utf8");
    check(`${f.split("/").pop()} calls inheritablePartyLinks`,
      /inheritablePartyLinks\(source, dest\)/.test(src2));
    check(`${f.split("/").pop()} no longer copies the link unguarded`,
      !/source\.linkedCustomerId && !dest\.linkedCustomerId/.test(src2));
  }

  console.log("\nagainst the live ledgers: is any surviving link mismatched?");
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  const db = mongoose.connection.db;
  const linked = await db.collection("acc_ledgers")
    .find({ linkedCustomerId: { $ne: null } })
    .project({ name: 1, linkedCustomerId: 1 }).toArray();
  const custs = db.collection("customers");
  const bad = [];
  for (const l of linked) {
    const c = await custs.findOne({ _id: l.linkedCustomerId }, { projection: { name: 1, companyName: 1 } });
    if (!c) continue;
    if (!sameParty(l.name, c.name || c.companyName)) bad.push(`"${l.name}" -> "${c.name || c.companyName}"`);
  }
  check(`no ledger is linked to a different party (${linked.length} links checked)`,
    bad.length === 0, bad.join(" | "));
  if (bad.length) console.log("        (data, not code — the guard stops NEW ones; these predate it)");

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("\nharness crashed:", e.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
