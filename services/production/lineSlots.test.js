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
  assert.deepEqual(problemsOf(lines, known), ["One machine is in two places: Line 1 L01 and Line 2 R04."]);
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

test("a line's QC table is a register machine standing nowhere else", () => {
  const ok = normaliseLines([{ id: "1", name: "Line 1", qcMachineId: A, slots: [{ side: "L", index: 1, machineId: B }] }]);
  assert.equal(ok[0].qcMachineId, A);
  assert.deepEqual(problemsOf(ok, known), []);
  assert.deepEqual(machineIdsOf(ok).sort(), [A, B], "the QC machine is looked up too");

  const inSlot = normaliseLines([{ id: "1", name: "Line 1", qcMachineId: A, slots: [{ side: "L", index: 1, machineId: A }] }]);
  assert.deepEqual(problemsOf(inSlot, known), ["One machine is in two places: Line 1 QC table and Line 1 L01."]);

  const twoLines = normaliseLines([{ id: "1", name: "Line 1", qcMachineId: A }, { id: "2", name: "Line 2", qcMachineId: A }]);
  assert.deepEqual(problemsOf(twoLines, known), ["One machine is at two stations: Line 1 QC table and Line 2 QC table."]);

  const gone = normaliseLines([{ id: "1", name: "Line 1", qcMachineId: GONE }]);
  assert.deepEqual(problemsOf(gone, known), ["Line 1 QC table names a machine that is not in the machine register."]);
});

test("a cell has an embroidery station; a row has one side, no table and no QC", () => {
  const [cell, row] = normaliseLines([
    { id: "c", name: "Finishing cell", kind: "cell", slotsPerSide: 3, headMachineId: A, qcMachineId: "" },
    { id: "r", name: "Iron tables", kind: "row", slotsPerSide: 3, tableWidth: 120, qcMachineId: B,
      slots: [{ side: "L", index: 1, machineId: B }, { side: "R", index: 1, machineId: A }] },
  ]);
  assert.equal(cell.kind, "cell");
  assert.equal(cell.headMachineId, A);
  assert.equal(row.tableWidth, 0, "a row has no table");
  assert.equal(row.qcMachineId, null, "nor a QC table (null, never \"\", which no ObjectId accepts)");
  assert.deepEqual(row.slots.map((s) => s.side), ["L"], "only its one side");
  assert.deepEqual(problemsOf([cell, row], known), []);
  const both = normaliseLines([{ id: "c", name: "Cell", kind: "cell", headMachineId: A, qcMachineId: A }]);
  assert.deepEqual(problemsOf(both, known), ["One machine is at two stations: Cell final QC table and Cell embroidery station."]);
  assert.deepEqual(machineIdsOf([cell]), [A], "the head machine is looked up");
});

test("an empty station id is null, so the database can store it", () => {
  const [l] = normaliseLines([{ id: "1", name: "Line 1", qcMachineId: "", headMachineId: "" }]);
  assert.equal(l.qcMachineId, null);
  assert.equal(l.headMachineId, null);
});

test("a side can stack its slots in rows: cols along the line, bounded by the slots a side", () => {
  const [cell, plain, silly] = normaliseLines([
    { id: "c", name: "Cell", kind: "cell", slotsPerSide: 4, cols: 2, qcDepth: 180, tableWidth: 0 },
    { id: "l", name: "Line", slotsPerSide: 13 },
    { id: "s", name: "Silly", slotsPerSide: 3, cols: 9, qcDepth: 9999 },
  ]);
  assert.deepEqual([cell.cols, cell.qcDepth, cell.tableWidth], [2, 180, 0], "a cell may have no table");
  assert.deepEqual([plain.cols, plain.qcDepth], [13, 90], "one row, the usual QC table");
  assert.deepEqual([silly.cols, silly.qcDepth], [3, LIMITS.qcDepth.max]);
});

test("a line may set how deep its slots are; 0 keeps its kind's own", () => {
  const [fusing, plain, deep] = normaliseLines([
    { id: "f", name: "Fusing machines", kind: "row", slotsPerSide: 2, slotDepth: 220 },
    { id: "l", name: "Line" },
    { id: "d", name: "Deep", slotDepth: 9999 },
  ]);
  assert.deepEqual([fusing.slotDepth, plain.slotDepth, deep.slotDepth], [220, 0, LIMITS.slotDepth.max]);
});
