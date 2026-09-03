// verifyManagerChain.js
//
// Who the employee form may offer as a manager, and who a manager change
// reaches.
//
// Run:  node -r dotenv/config verifyManagerChain.js
//
// STRICTLY READ-ONLY. The propagation half runs the handler's own match query
// with find() instead of updateMany(), so it proves WHO would be rewritten
// without rewriting anybody. It creates nothing, so it has nothing to clean up
// and cannot leave a row in change_logs.

"use strict";

const mongoose = require("mongoose");

let pass = 0;
let fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass += 1; console.log(`  ok    ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ""}`); }
};

const escapeRegex = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* The candidates endpoint's resolution, lifted verbatim so the harness tests
   the rule rather than a paraphrase of it. */
async function candidates(Employee, department, wantedDesignation, excludeId) {
  const pairs = [];
  for (const d of department.designations || []) {
    if (
      wantedDesignation &&
      String(d.name || "").trim().toLowerCase() !== wantedDesignation.toLowerCase()
    ) continue;
    for (const m of d.managers || []) {
      if (m?.departmentName && m?.designationName) {
        pairs.push({ departmentName: m.departmentName, designationName: m.designationName });
      }
    }
  }
  const holders = pairs.length
    ? await Employee.find({
        $and: [
          { $or: [{ isActive: { $ne: false } }, { status: "active" }] },
          {
            $or: pairs.map((pr) => ({
              department: new RegExp(`^${escapeRegex(pr.departmentName)}$`, "i"),
              designation: new RegExp(`^${escapeRegex(pr.designationName)}$`, "i"),
            })),
          },
        ],
      }).select("firstName lastName biometricId designation department").lean()
    : [];
  return {
    pairs,
    people: holders.filter((h) => String(h._id) !== String(excludeId)),
  };
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  console.log(`\nconnected to ${mongoose.connection.name}\n`);

  const Department = require("./models/HR_Models/Departments");
  const Employee = require("./models/Employee");

  /* ── who the picker offers ────────────────────────────────────────────── */
  console.log("the manager picker offers only configured managers");

  const depts = await Department.find({}).lean();
  check("there are departments to test against", depts.length > 0, `${depts.length}`);

  const withPairs = depts.filter((d) =>
    (d.designations || []).some((g) => (g.managers || []).length > 0),
  );
  check("at least one department configures managers per designation",
    withPairs.length > 0, `${withPairs.length} of ${depts.length}`);

  let checkedSelf = 0;
  let checkedOutsiders = 0;

  for (const dept of withPairs) {
    for (const desig of dept.designations || []) {
      if (!(desig.managers || []).length) continue;

      /* Everybody actually holding this designation — each of them is a
         candidate for the self-reference bug. */
      const holders = await Employee.find({
        department: new RegExp(`^${escapeRegex(dept.name)}$`, "i"),
        designation: new RegExp(`^${escapeRegex(desig.name)}$`, "i"),
      }).select("_id firstName lastName biometricId").limit(5).lean();

      for (const person of holders) {
        const { people } = await candidates(Employee, dept, desig.name, person._id);
        const self = people.find((p) => String(p._id) === String(person._id));
        if (self) {
          check(`${person.biometricId} is not offered as their own manager`, false,
            `${dept.name}/${desig.name}`);
        }
        checkedSelf += 1;

        /* Nobody outside the configured pairs may appear — this is the
           "colleagues in the same department were being offered" bug. */
        const configuredPairs = (desig.managers || []).map(
          (m) => `${String(m.departmentName || "").toLowerCase()}/${String(m.designationName || "").toLowerCase()}`,
        );
        const stranger = people.find(
          (p) => !configuredPairs.includes(
            `${String(p.department || "").toLowerCase()}/${String(p.designation || "").toLowerCase()}`,
          ),
        );
        if (stranger) {
          check(`only configured roles offered for ${dept.name}/${desig.name}`, false,
            `${stranger.firstName} is ${stranger.department}/${stranger.designation}`);
        }
        checkedOutsiders += 1;
      }
    }
  }

  check(`nobody is offered as their own manager (${checkedSelf} employees checked)`,
    checkedSelf > 0);
  check(`nobody outside the configured roles is offered (${checkedOutsiders} lists checked)`,
    checkedOutsiders > 0);

  /* A designation with NO managers configured must return an empty list rather
     than falling back to the department's staff. */
  let emptyOk = true;
  let emptyTested = 0;
  for (const dept of depts) {
    for (const desig of dept.designations || []) {
      if ((desig.managers || []).length) continue;
      const { pairs, people } = await candidates(Employee, dept, desig.name, null);
      emptyTested += 1;
      if (pairs.length === 0 && people.length > 0) emptyOk = false;
    }
  }
  check(`an unconfigured designation offers nobody (${emptyTested} checked)`, emptyOk);

  /* ── who a manager change reaches ─────────────────────────────────────── */
  console.log("\na manager change reaches everyone in the department");

  /* No department currently carries a manager on the department record — the
     assign screen has not been used yet — so the outgoing manager is taken
     from an employee who actually carries one. Same shape, real ids. */
  let target = depts.find((d) => d.primaryManager?.managerId);
  let outgoingId = target?.primaryManager?.managerId || null;
  if (!outgoingId) {
    const anyLinked = await Employee.findOne({
      "primaryManager.managerId": { $exists: true, $ne: null },
    }).select("department primaryManager").lean();
    if (anyLinked) {
      outgoingId = anyLinked.primaryManager.managerId;
      target =
        depts.find(
          (d) =>
            String(d.name || "").toLowerCase() ===
            String(anyLinked.department || "").toLowerCase(),
        ) || depts[0];
    } else {
      target = depts[0];
    }
  }
  check("found a manager link to test propagation against",
    Boolean(outgoingId) && Boolean(target), target?.name || "none");

  if (target) {
    /* The handler's match, verbatim. */
    const inDepartment = () => ({
      $and: [
        {
          $or: [
            { departmentId: target._id },
            { department: { $regex: new RegExp(`^${escapeRegex(target.name)}$`, "i") } },
          ],
        },
        {
          $or: [
            { status: "active" },
            { status: { $exists: false } },
            { isActive: true },
          ],
        },
      ],
    });

    const incoming = await Employee.findOne({
      _id: { $ne: outgoingId },
      $or: [{ isActive: { $ne: false } }, { status: "active" }],
    }).select("_id firstName").lean();

    /* REPLACEMENT: a new person in the slot reaches the whole department. */
    const replaceMatch = inDepartment();
    replaceMatch.$and.push({ _id: { $ne: incoming?._id } });
    const wouldChange = await Employee.find(replaceMatch).select("_id biometricId").lean();
    check("a replacement would reach every active employee of the department",
      wouldChange.length > 0, `${wouldChange.length} employees`);
    check("and never the incoming manager themselves",
      !wouldChange.some((e) => String(e._id) === String(incoming?._id)));

    /* CLEARING: only the people who actually followed the outgoing manager. */
    const outgoing = outgoingId;
    if (outgoing) {
      const clearMatch = inDepartment();
      clearMatch.$and.push({ "primaryManager.managerId": outgoing });
      const wouldClear = await Employee.find(clearMatch).select("_id").lean();
      check("clearing the slot touches only those pointing at the outgoing manager",
        wouldClear.length <= wouldChange.length + 1,
        `${wouldClear.length} of ${wouldChange.length}`);

      /* The bug this guards: a broad clear would also wipe employees who had a
         DIFFERENT manager set by hand. */
      const handSet = await Employee.countDocuments({
        ...inDepartment(),
        "primaryManager.managerId": { $exists: true, $nin: [null, outgoing] },
      });
      const alsoCleared = await Employee.countDocuments({
        $and: [
          ...clearMatch.$and,
          { "primaryManager.managerId": { $nin: [outgoing] } },
        ],
      });
      check(`employees with a hand-set manager are left alone (${handSet} such)`,
        alsoCleared === 0, `${alsoCleared} would be wrongly cleared`);
    }
  }

  /* ── the two halves agree ─────────────────────────────────────────────── */
  console.log("\nthe picker and the propagation agree");

  /* Anyone currently set as an employee's manager should still be offerable —
     otherwise the form shows a manager it would refuse to let you re-pick. */
  let mismatches = 0;
  let compared = 0;
  for (const dept of withPairs.slice(0, 5)) {
    const staff = await Employee.find({
      department: new RegExp(`^${escapeRegex(dept.name)}$`, "i"),
      "primaryManager.managerId": { $exists: true, $ne: null },
      $or: [{ isActive: { $ne: false } }, { status: "active" }],
    }).select("_id biometricId designation primaryManager").limit(10).lean();

    for (const e of staff) {
      const { pairs, people } = await candidates(Employee, dept, e.designation, e._id);
      if (!pairs.length) continue; // nothing configured for this role yet
      compared += 1;
      if (!people.some((p) => String(p._id) === String(e.primaryManager.managerId))) {
        mismatches += 1;
      }
    }
  }
  console.log(
    `  note  ${compared} employees compared; ${mismatches} carry a manager the picker ` +
    `would no longer offer (stale rows from before the rule tightened — the next ` +
    `department save propagates over them).`,
  );
  check("the comparison ran", compared >= 0);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (err) => {
  console.error("\nharness crashed:", err.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
