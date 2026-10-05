// services/production/lineSlots.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { normaliseLines, problemsOf, machineIdsOf, LIMITS } = require("./lineSlots");

const A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbb";
const GONE = "cccccccccccccccccccccccc";
const known = new Set([A, B]);

test("a line is stored with its shape bounded and only its filled slots", () => {
  const [line] = normaliseLines([
    {
      id: "line-1",
      name: "Line 1",
      x: "-988",
      y: -950,
      rotation: -90,
      slotsPerSide: 13,
      pitch: 10,
      tableWidth: 9999,
      slots: [
        { side: "l", index: 1, machineId: A },
        { side: "R", index: 3, machineId: "" },
        { side: "R", index: 14, machineId: B },
        { side: "X", index: 2, machineId: B },
      ],
      junk: true,
    },
  ]);
  assert.equal(line.x, -988);
  assert.equal(line.rotation, 270);
  assert.equal(line.pitch, LIMITS.pitch.min);
  assert.equal(line.tableWidth, LIMITS.tableWidth.max);
  assert.deepEqual(line.slots, [{ side: "L", index: 1, item: "machine", machineId: A }], "an empty slot, one past the end and a bad side are not stored");
  assert.equal("junk" in line, false);
});

test("good lines have no problems", () => {
  const lines = normaliseLines([
    { id: "1", name: "Line 1", slots: [{ side: "L", index: 1, machineId: A }] },
    { id: "2", name: "Line 2", slots: [{ side: "R", index: 13, machineId: B }] },
  ]);
  assert.deepEqual(problemsOf(lines, known), []);
  assert.deepEqual(machineIdsOf(lines).sort(), [A, B]);
});

test("a machine in two slots is refused, naming both", () => {
  const lines = normaliseLines([
    { id: "1", name: "Line 1", slots: [{ side: "L", index: 1, machineId: A }] },
    { id: "2", name: "Line 2", slots: [{ side: "R", index: 4, machineId: A }] },
  ]);
  assert.deepEqual(problemsOf(lines, known), ["One machine is in two slots: Line 1 L01 and Line 2 R04."]);
});

test("a slot given two machines is refused", () => {
  const lines = normaliseLines([
    { id: "1", name: "Line 1", slots: [{ side: "L", index: 2, machineId: A }, { side: "L", index: 2, machineId: B }] },
  ]);
  assert.deepEqual(problemsOf(lines, known), ["Line 1 L02 is given two things."]);
});

test("only machines from the register: an unknown id or a non-id is refused", () => {
  const lines = normaliseLines([
    { id: "1", name: "Line 1", slots: [{ side: "L", index: 1, machineId: GONE }, { side: "L", index: 2, machineId: "SNLS3" }] },
  ]);
  assert.deepEqual(problemsOf(lines, known), [
    "Line 1 L01 names a machine that is not in the machine register.",
    'Line 1 L02 names "SNLS3", which is not a machine id.',
  ]);
});

test("two lines may not share an id", () => {
  const lines = normaliseLines([{ id: "1", name: "A" }, { id: "1", name: "B" }]);
  assert.deepEqual(problemsOf(lines, known), ['Two lines share the id "1".']);
});

test("a slot may hold a work table: no machine, no register lookup, as many as wanted", () => {
  const lines = normaliseLines([
    { id: "1", name: "Line 1", slots: [
      { side: "L", index: 1, item: "table" },
      { side: "L", index: 2, item: "table", machineId: A }, // a stray id on a table is dropped
      { side: "R", index: 1, machineId: B },
    ] },
  ]);
  assert.deepEqual(lines[0].slots.map((s) => s.item), ["table", "table", "machine"]);
  assert.equal(lines[0].slots[1].machineId, undefined);
  assert.deepEqual(problemsOf(lines, known), []);
  assert.deepEqual(machineIdsOf(lines), [B], "only the machine is looked up");
});
