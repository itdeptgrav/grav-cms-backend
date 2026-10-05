"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { departmentNameOf, syncDepartmentName } = require("./employeeDepartment");

/* A stand-in for the Department model. No mongoose, no database — the rules
   here are about which of two values wins, and a real connection would only
   make that slower to check. */
function fakeDepartments(rows) {
  return {
    findById: (id) => ({
      select: () => ({
        lean: async () => rows.find((r) => String(r._id) === String(id)) || null,
      }),
    }),
    find: (query) => ({
      select: () => ({
        limit: (n) => ({
          lean: async () => {
            const src = query.name.$regex;
            const re = new RegExp(src, query.name.$options);
            return rows.filter((r) => re.test(r.name)).slice(0, n);
          },
        }),
      }),
    }),
  };
}

/* The real pair this was written for. Both exist in the live database. */
const DEPTS = [
  { _id: "6a9bbee189968e06ef8862ec", name: "R&D" },
  { _id: "6a9e5fef42b58db5fa7cb640", name: "R & D" },
  { _id: "69eb4bdf65548d6f04c5228a", name: "CUTTING" },
];

test("the populated department's name wins over a stale stored one", () => {
  /* The exact live record: the view printed SAMPLING while the editor showed
     R&D, and both were reading what they had been handed. */
  const drifted = {
    department: "SAMPLING",
    departmentId: { _id: "6a9bbee189968e06ef8862ec", name: "R&D" },
  };
  assert.equal(departmentNameOf(drifted), "R&D");
});

test("an unpopulated reference is not a name, and is not stringified into the UI", () => {
  const e = { department: "CUTTING", departmentId: "69eb4bdf65548d6f04c5228a" };
  assert.equal(departmentNameOf(e), "CUTTING");
});

test("no department at all is empty, never undefined or [object Object]", () => {
  assert.equal(departmentNameOf({}), "");
  assert.equal(departmentNameOf(null), "");
  assert.equal(departmentNameOf({ departmentId: {} }), "");
});

test("a write carrying a departmentId re-derives the name", async () => {
  const data = { departmentId: "6a9bbee189968e06ef8862ec", department: "SAMPLING" };
  const r = await syncDepartmentName(data, fakeDepartments(DEPTS));
  assert.equal(data.department, "R&D");
  assert.equal(r.changed, true);
});

test("the client does not get a vote when it names one department and references another", async () => {
  const data = { departmentId: "69eb4bdf65548d6f04c5228a", department: "R&D" };
  await syncDepartmentName(data, fakeDepartments(DEPTS));
  assert.equal(data.department, "CUTTING");
});

test("an already-correct payload is left alone and reports no change", async () => {
  const data = { departmentId: "6a9bbee189968e06ef8862ec", department: "R&D" };
  const r = await syncDepartmentName(data, fakeDepartments(DEPTS));
  assert.equal(r.changed, false);
  assert.equal(data.department, "R&D");
});

test("a departmentId that resolves to nothing never blanks the stored name", async () => {
  const data = { departmentId: "000000000000000000000000", department: "CUTTING" };
  const r = await syncDepartmentName(data, fakeDepartments(DEPTS));
  assert.equal(data.department, "CUTTING");
  assert.equal(r.changed, false);
  assert.match(r.reason, /does not resolve/);
});

test("a name alone fills in the id when exactly one department matches", async () => {
  const data = { department: "  cutting " };
  const r = await syncDepartmentName(data, fakeDepartments(DEPTS));
  assert.equal(String(data.departmentId), "69eb4bdf65548d6f04c5228a");
  assert.equal(r.changed, true);
});

test('"R&D" does not match "R & D" — punctuation is escaped, not a pattern', async () => {
  const data = { department: "R&D" };
  await syncDepartmentName(data, fakeDepartments(DEPTS));
  assert.equal(String(data.departmentId), "6a9bbee189968e06ef8862ec");
});

test("an ambiguous name is left as it came in rather than guessed", async () => {
  const rows = [
    { _id: "aaa", name: "R&D" },
    { _id: "bbb", name: "r&d" },
  ];
  const data = { department: "R&D" };
  const r = await syncDepartmentName(data, fakeDepartments(rows));
  assert.equal(data.departmentId, undefined);
  assert.equal(r.changed, false);
  assert.match(r.reason, /more than one/);
});

test("a name no department has is left as it came in", async () => {
  const data = { department: "SAMPLING" };
  const r = await syncDepartmentName(data, fakeDepartments(DEPTS));
  assert.equal(data.departmentId, undefined);
  assert.equal(data.department, "SAMPLING");
  assert.match(r.reason, /no department/);
});

test("a payload mentioning no department is untouched", async () => {
  const data = { jobTitle: "FASHION DESIGNER" };
  const r = await syncDepartmentName(data, fakeDepartments(DEPTS));
  assert.deepEqual(data, { jobTitle: "FASHION DESIGNER" });
  assert.equal(r.changed, false);
});
