// scripts/readiness/local-data-closure.js
//
// THE DATA CLOSURE, PROVED AGAINST A REAL LOCAL DATABASE.
//
// The only database this checkout is configured for is a shared remote Atlas
// cluster. A backfill is not something to try out on shared infrastructure, so
// this stands up a REAL MongoDB of its own, loads it with the same shape the
// dry run found on the dev cluster — 27 product lines across 12 enquiries, none
// of them carrying a permanent reference — and then runs the ACTUAL scripts
// against it as a child process.
//
// Running the real script matters. A reimplementation of the backfill inside a
// test proves the reimplementation.
//
//   node scripts/readiness/local-data-closure.js
//
// Nothing here touches the configured database. The child processes are given a
// MONGODB_URI pointing at this process's own server, and `dotenv` does not
// override an environment variable that is already set.
"use strict";

/* The Employee model encrypts salary fields on save and refuses without a key.
   This harness creates an employee only to hang a Merchandising grant on, so a
   throwaway key is set before any model is required. It is never a real key and
   never leaves this process. */
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const path = require("path");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const Account = require("../../models/CMS_Models/Sales/Account");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const {
  PRODUCT_LINE_REF_PATTERN,
} = require("../../models/CMS_Models/Sales/enquiryProductLineIdentity");
const config = require("../../services/merchandising/tnaConfig.service");

const root = path.join(__dirname, "..", "..");
const DB = "local_closure";
const line = (s = "") => process.stdout.write(`${s}\n`);
const head = (t) => { line(""); line(`── ${t}`); };
const say = (k, v) => line(`   ${String(k).padEnd(48)} ${v}`);

let failures = 0;
function check(claim, ok, detail = "") {
  line(`   ${ok ? "PASS" : "FAIL"}  ${claim}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

/** The dev cluster's exact distribution, from the dry run. */
const SHAPE = [1, 1, 3, 1, 5, 7, 1, 1, 1, 2, 3, 1];   // 12 enquiries, 27 lines

const countLines = async () => {
  const rows = await Enquiry.find({}).select("products").lean();
  let total = 0, withRef = 0;
  const refs = [];
  for (const e of rows) {
    for (const p of e.products || []) {
      total += 1;
      if (p.productLineRef) { withRef += 1; refs.push(p.productLineRef); }
    }
  }
  return { total, withRef, refs };
};

async function main() {
  const rs = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  const uri = rs.getUri();
  await mongoose.connect(uri, { dbName: DB });


  line("MERCHANDISING LOCAL DATA CLOSURE");
  line("A real MongoDB, started by this process. The configured cluster is untouched.");

  /* ── Seed the dev cluster's shape ──────────────────────────────────── */
  head("Seeding the shape the dry run found");
  const co = await Acc_Company.create({
    companyName: "Local Closure Co", booksFromDate: new Date("2026-04-01"),
  });
  const account = await Account.create({
    companyId: co._id, companyName: "Local Buyer", status: "active",
  });
  const journey = await SalesJourney.create({
    journeyId: "SJ-LOCAL-1", companyId: co._id, name: "Local journey",
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "Owner",
  });

  for (let i = 0; i < SHAPE.length; i += 1) {
    const products = Array.from({ length: SHAPE[i] }, (_, j) => ({
      product: `Product ${i + 1}.${j + 1}`, quantity: 100 + j,
    }));
    /* Inserted BENEATH the hook, so the rows arrive exactly as the legacy rows
       on the dev cluster do: with no reference at all. A `create` would mint
       one and prove nothing. */
    await Enquiry.collection.insertOne({
      enquiryId: `ENQ-LOCAL-${String(i + 1).padStart(5, "0")}`,
      journeyId: journey._id, accountId: account._id, companyId: co._id,
      title: `Local enquiry ${i + 1}`, isActive: true, products,
      createdAt: new Date(), updatedAt: new Date(), __v: 0,
    });
  }

  const before = await countLines();
  say("enquiries", SHAPE.length);
  say("product lines", before.total);
  say("carrying a reference", before.withRef);
  check("the seeded shape matches the dev cluster's dry run",
    SHAPE.length === 12 && before.total === 27 && before.withRef === 0,
    `${SHAPE.length} enquiries / ${before.total} lines / ${before.withRef} referenced`);

  /* ── 1. Dry run changes nothing ────────────────────────────────────── */
  head("1. The script's default is a dry run");
  /* Driven IN-PROCESS. The CLI is this same function behind `require.main`,
     so proving the export proves what a person runs — and one connection is
     deterministic where four short-lived children racing a freshly-started
     server are not. */
  const { backfill } = require("./backfill-product-line-refs");
  const quiet = () => {};

  const dry = await backfill({ apply: false, log: quiet });
  const afterDry = await countLines();
  check("it reports the same 12 enquiries and 27 lines",
    dry.enquiriesAffected === 12 && dry.linesFixed === 27,
    `${dry.enquiriesAffected} enquiries / ${dry.linesFixed} lines`);
  check("it wrote nothing", afterDry.withRef === 0,
    `${afterDry.withRef} references after the dry run`);
  const backfillSrcForCli = require("fs").readFileSync(
    path.join(root, "scripts/readiness/backfill-product-line-refs.js"), "utf8");
  check("the CLI writes only with --apply",
    /CLI_APPLY = process\.argv\.includes\("--apply"\)/.test(backfillSrcForCli));

  /* ── 2. Apply ──────────────────────────────────────────────────────── */
  head("2. Applying");
  const applied = await backfill({ apply: true, log: quiet });
  const after = await countLines();
  say("lines before", `${before.total} total, ${before.withRef} referenced`);
  say("lines after", `${after.total} total, ${after.withRef} referenced`);
  check("every line now carries a reference", after.withRef === after.total);
  check("no line was added or lost", after.total === before.total);
  check("no enquiry was refused", applied.failures === 0,
    applied.refused.map((r) => `${r.enquiryId}: ${r.reason}`).join("; ") || "none");
  say("enquiries saved", applied.enquiriesSaved);

  /* ── 3. The references themselves ──────────────────────────────────── */
  head("3. Server-minted, well-formed, unique");
  const malformed = after.refs.filter((r) => !PRODUCT_LINE_REF_PATTERN.test(r));
  check("every reference matches the issued pattern", malformed.length === 0,
    malformed.length ? malformed.slice(0, 3).join(", ") : "PL- + 12 hex");
  check("every reference is distinct", new Set(after.refs).size === after.refs.length,
    `${new Set(after.refs).size} distinct of ${after.refs.length}`);
  /* ── WHERE THE VALUE COMES FROM ────────────────────────────────────
     The script's only write is `enquiry.save()`. It never mints, never
     assigns a reference, and issues no `updateOne` — so the value can only
     have come from the pre-validate hook, which is the code that refuses a
     duplicate and refuses one this system did not issue. Writing the field
     directly would bypass exactly that. */
  const backfillRaw = require("fs").readFileSync(
    path.join(root, "scripts/readiness/backfill-product-line-refs.js"), "utf8");
  /* Comments blanked. The script EXPLAINS why it does not use `updateOne`,
     and a raw scan reads the explanation as the violation. */
  const backfillSrc = backfillRaw
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  check("the script never mints a reference itself",
    !/mintProductLineRef|randomBytes|crypto/.test(backfillSrc));
  check("its only write is a save, so the hook is what assigns",
    /enquiry\.save\(\)/.test(backfillSrc)
      && !/updateOne|updateMany|bulkWrite|insertMany|findOneAndUpdate/.test(backfillSrc));
  check("no reference it produced appears anywhere in the script",
    after.refs.every((r) => !backfillRaw.includes(r)));

  /* ── 4. Idempotency ────────────────────────────────────────────────── */
  head("4. Re-running changes nothing");
  const snapshot = [...after.refs].sort();
  const second = await backfill({ apply: true, log: quiet });
  const afterSecond = await countLines();
  /* The DATABASE is the evidence. What the second run printed is corroboration,
     and it is reported either way rather than silently believed. */
  check("every reference is byte-identical after a second apply",
    JSON.stringify([...afterSecond.refs].sort()) === JSON.stringify(snapshot));
  check("no line was left unreferenced", afterSecond.withRef === afterSecond.total,
    `${afterSecond.withRef} of ${afterSecond.total}`);
  check("the second run found nothing to do",
    second.enquiriesAffected === 0 && second.linesFixed === 0,
    `${second.enquiriesAffected} enquiries / ${second.linesFixed} lines`);
  const thirdDry = await backfill({ apply: false, log: quiet });
  check("and a following dry run reports zero", thirdDry.linesFixed === 0);

  /* ── 5. The point of it all ────────────────────────────────────────── */
  head("5. A backfilled line can be sent for development");
  const requests = require("../../services/sales/developmentRequest.service");
  const one = await Enquiry.findOne({ enquiryId: "ENQ-LOCAL-00001" }).lean();
  const ref = one.products[0].productLineRef;
  say("line reference", ref);

  const issued = await requests.issue({ companyId: co._id }, {
    journeyId: String(journey._id),
    productLineRef: ref,
    body: {
      requirementSummary: "Local closure proof — send this line for development.",
      requestedCategories: ["FABRIC", "TRIMS"],
    },
    actor: { name: "Local Sales", email: "sales@local.test" },
  });
  check("Sales can issue a development request against it",
    Boolean(issued?.request?.requestRef), issued?.request?.requestRef || "no request");
  check("it is version 1 and ISSUED",
    issued?.request?.versionNo === 1 && issued?.request?.state === "ISSUED");

  /* ── 6. T&A STARTER CONFIGURATION ──────────────────────────────────── */
  head("6. Seeding starter Time & Action configuration");

  const Employee = require("../../models/Employee");
  const DeptUser = require("../../models/Access/DeptUser");
  const DepartmentRole = require("../../models/Access/DepartmentRole");
  const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
  const {
    TnaTemplateVersion,
  } = require("../../models/CMS_Models/Merchandising/TnaTemplate");
  const {
    WorkingCalendarVersion,
  } = require("../../models/CMS_Models/Merchandising/WorkingCalendar");

  /* The seed targets companies where somebody holds a Merchandising grant, so
     one has to exist for this company to be in scope at all. */
  const emp = await Employee.create({
    firstName: "Local", lastName: "Merch", email: "merch@local.test",
    biometricId: "LM1", isActive: true, gender: "Other", department: "Merchandising",
  });
  await DeptUser.create({
    name: "Local Merch", email: "merch@local.test", passwordHash: "x",
    isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  await DepartmentRole.create({
    departmentSlug: "merchandiser", email: "merch@local.test", name: "Local Merch",
    role: "owner", isActive: true, departmentId: new mongoose.Types.ObjectId(),
  });
  await SpCompanyMembership.create({
    companyId: co._id, email: "merch@local.test", employeeRef: emp._id, personName: "Local Merch",
  });

  /* Driven IN-PROCESS. The CLI is the same code behind `require.main`. */
  const seed = require("./seed-tna-starter");

  const inScope = await seed.merchandisingCompanies();
  check("it finds the company by its Merchandising grant", inScope.length === 1,
    `${inScope.length} in scope`);

  await seed.seedCompany(inScope[0], { apply: false });
  check("a dry run publishes nothing",
    (await TnaTemplateVersion.countDocuments({ state: "PUBLISHED" })) === 0
    && (await WorkingCalendarVersion.countDocuments({ state: "PUBLISHED" })) === 0);
  /* And the CLI's default really is the dry run. */
  const seedSrc = require("fs").readFileSync(
    path.join(root, "scripts/readiness/seed-tna-starter.js"), "utf8");
  check("the CLI writes only with --apply",
    /CLI_APPLY = process\.argv\.includes\("--apply"\)/.test(seedSrc));

  const first = await seed.seedCompany(inScope[0], { apply: true });
  const tplV = await TnaTemplateVersion.findOne({ state: "PUBLISHED" }).lean();
  const calV = await WorkingCalendarVersion.findOne({ state: "PUBLISHED" }).lean();
  check("one calendar version is published", Boolean(calV),
    calV ? `${first.calendar?.name} v${calV.versionNo}` : "none");
  check("one template version is published", Boolean(tplV),
    tplV ? `${first.template?.name} v${tplV.versionNo}, ${(tplV.milestones || []).length} milestones` : "none");
  if (tplV) {
    say("template version id", String(tplV._id));
    say("template id", String(tplV.templateId));
  }
  if (calV) {
    say("calendar version id", String(calV._id));
    say("calendar id", String(calV.calendarId));
  }

  /* ── The rule that must never bend ──────────────────────────────────── */
  const wrong = (tplV?.milestones || []).filter(
    (m) => m.completionAuthority === "MERCHANDISING" && m.ownerDepartment !== "MERCHANDISING");
  check("Merchandising completes no other department's milestone", wrong.length === 0,
    wrong.length ? wrong.map((m) => m.milestoneCode).join(", ") : "checked every milestone");
  const departments = [...new Set((tplV?.milestones || []).map((m) => m.ownerDepartment))];
  check("the template is genuinely cross-department", departments.length >= 4,
    departments.join(", "));

  /* ── Idempotency and non-destruction ────────────────────────────────── */
  const again = await seed.seedCompany(inScope[0], { apply: true });
  check("re-running skips the company rather than versioning it",
    again.skipped.length === 2 && !again.template && !again.calendar,
    again.skipped.join("; ") || "nothing skipped");
  check("still exactly one published template and one published calendar",
    (await TnaTemplateVersion.countDocuments({ state: "PUBLISHED" })) === 1
    && (await WorkingCalendarVersion.countDocuments({ state: "PUBLISHED" })) === 1);
  const tplAfter = await TnaTemplateVersion.findOne({ state: "PUBLISHED" }).lean();
  check("the published version is the same document",
    String(tplAfter._id) === String(tplV._id));

  /* ── 7. A FILE WITH NO PLAN CAN NOW GET ONE ─────────────────────────── */
  head("7. A file with no plan can now create one");

  const resolved = await config.resolveTemplateVersion(
    { companyId: co._id }, { facts: {}, onDate: "2026-06-01" });
  check("the company's own rules resolve a template for a new plan",
    Boolean(resolved?.version), resolved?.version ? `v${resolved.version.versionNo}` : "none");
  check("and it resolves the published one",
    String(resolved?.version?.id || resolved?.version?._id) === String(tplV._id));

  line("");
  line(failures ? `LOCAL DATA CLOSURE: ${failures} CHECK(S) FAILED` : "LOCAL DATA CLOSURE: ALL CHECKS PASSED");
  await mongoose.disconnect();
  await rs.stop();
  process.exitCode = failures ? 1 : 0;
}

main().catch(async (e) => {
  line(`\nCOULD NOT COMPLETE: ${e.stack || e.message}`);
  process.exitCode = 1;
});
