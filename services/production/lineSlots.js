// services/production/lineSlots.js
//
// THE SEWING LINES' SLOTS — the rules a save must pass (2 Oct 2026).
//
// The floor has two sewing lines. Each is ONE long table with a row of slots
// down its LEFT side and a row down its RIGHT side — 13 a side — and
// the Production Supervisor puts a machine in a slot as the product needs it.
// The geometry (where a slot is on the floor) is the frontend's
// `tracker/factory/lines.js`; this file only decides whether a set of lines is
// one the floor can actually have:
//
//   · a slot holds at most one machine, and a machine stands in at most ONE
//     slot — the same machine in two places is a plan nobody can follow;
//   · a machine in a slot is one from the machine register ("machine assigned
//     can be from our list only") — an id that is not a machine is refused,
//     never stored as a ghost;
//   · a slot may instead hold a plain WORK TABLE ({ item: "table" }) — not a
//     register item, so as many as are wanted and nothing to look up;
//   · the shape is bounded, so a typo cannot make a line of 4,000 slots.
//
// Pure: `normaliseLines` reads, `problemsOf` judges against the register's ids.
// The route does the one query and calls both.

const SIDES = ["L", "R"];
const TABLE_ITEM = "table";

const LIMITS = Object.freeze({
  slotsPerSide: { min: 1, max: 40, fallback: 13 },
  pitch: { min: 60, max: 600, fallback: 175 }, // cm along the line per slot
  tableWidth: { min: 30, max: 400, fallback: 120 }, // cm across the table
});

const HEX24 = /^[a-f0-9]{24}$/i;

const bounded = (v, { min, max, fallback }) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const finite = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/**
 * The lines as they will be stored. Unknown fields are dropped, numbers are
 * bounded, empty slots are not stored (an absent slot IS an empty slot), and
 * slots past the line's length are dropped with the line — never kept as
 * unreachable assignments.
 */
function normaliseLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines.map((l, i) => {
    const slotsPerSide = Math.round(bounded(l?.slotsPerSide, LIMITS.slotsPerSide));
    const slots = (Array.isArray(l?.slots) ? l.slots : [])
      .map((s) => {
        const side = String(s?.side || "").toUpperCase();
        const index = Math.round(finite(s?.index, 0));
        return s?.item === TABLE_ITEM
          ? { side, index, item: TABLE_ITEM }
          : { side, index, item: "machine", machineId: s?.machineId ? String(s.machineId) : "" };
      })
      .filter((s) => (s.item === TABLE_ITEM || s.machineId) && SIDES.includes(s.side) && s.index >= 1 && s.index <= slotsPerSide);
    return {
      id: String(l?.id || `line-${i + 1}`),
      name: String(l?.name || `Line ${i + 1}`).slice(0, 60),
      x: finite(l?.x),
      y: finite(l?.y),
      rotation: ((finite(l?.rotation) % 360) + 360) % 360,
      slotsPerSide,
      pitch: bounded(l?.pitch, LIMITS.pitch),
      tableWidth: bounded(l?.tableWidth, LIMITS.tableWidth),
      slots,
    };
  });
}

const slotName = (line, s) => `${line.name} ${s.side}${String(s.index).padStart(2, "0")}`;

/**
 * Why these lines cannot be saved — an empty list when they can.
 *
 * @param {Array} lines       normalised lines
 * @param {Set<string>} known the ids of every machine in the register
 */
function problemsOf(lines, known) {
  const problems = [];
  const lineIds = new Set();
  const where = new Map(); // machineId → the slot it was first seen in

  for (const line of lines) {
    if (lineIds.has(line.id)) problems.push(`Two lines share the id "${line.id}".`);
    lineIds.add(line.id);

    const taken = new Set();
    for (const s of line.slots) {
      const slot = `${s.side}${s.index}`;
      if (taken.has(slot)) {
        problems.push(`${slotName(line, s)} is given two things.`);
        continue;
      }
      taken.add(slot);
      if (s.item === TABLE_ITEM) continue; // a work table names no machine

      if (!HEX24.test(s.machineId)) {
        problems.push(`${slotName(line, s)} names "${s.machineId}", which is not a machine id.`);
        continue;
      }
      if (!known.has(s.machineId)) {
        problems.push(`${slotName(line, s)} names a machine that is not in the machine register.`);
        continue;
      }
      const first = where.get(s.machineId);
      if (first) {
        problems.push(`One machine is in two slots: ${first} and ${slotName(line, s)}.`);
        continue;
      }
      where.set(s.machineId, slotName(line, s));
    }
  }
  return problems;
}

/** Every machine id the lines name — what the route asks the register about. */
const machineIdsOf = (lines) => [...new Set(lines.flatMap((l) => l.slots.map((s) => s.machineId)).filter((id) => HEX24.test(id || "")))];

module.exports = { SIDES, TABLE_ITEM, LIMITS, normaliseLines, problemsOf, machineIdsOf };
