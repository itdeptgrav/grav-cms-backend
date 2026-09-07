// test/project-manager/work-order-planning-state.test.js
//
// Chunk 4B.1. The additive planning axis and its new-record invariant.
//
// ── WHAT THIS SLICE IS ──────────────────────────────────────────────────────
// Decision 1 of docs/decisions/project-manager-work-order-planning-lifecycle.md
// (decisions 1-14 approved 3 Sep 2026): `planningState` is a SECOND axis, added
// alongside `WorkOrder.status` rather than carved out of it. `status` conflates
// planning progress with execution progress; this field answers only "how far
// has this been planned". Every stored `status` byte is preserved.
//
// ── WHY THERE IS NO SCHEMA DEFAULT ──────────────────────────────────────────
// A Mongoose default was MEASURED against a legacy record during the 4A audit
// and it masks absence: `findOne()` hydrates the default while `.lean()` shows
// no stored field. Every legacy record would then read as `not_started` - a
// positive claim that planning had not begun, which nothing in those records
// supports. So absence is interpreted as `unknown` on READ, and the invariant
// below assigns `not_started` only where `isNew` makes that claim true by
// construction.
//
// The tests assert against PERSISTED documents (`.lean()` / raw collection
// reads), not in-memory objects, because that distinction is the whole point:
// an in-memory read cannot tell a stored value from a hydrated default.
//
// Out of scope for 4B.1 and deliberately untested here: derived facts, schedule
// or scan-ledger lookups, transitions, guards, routes, response shape, the
// legacy backfill (blocked on decision 15 - no owner named).
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || "grav_clothing_secret_key";

const mongoose = require("mongoose");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const {
  PLANNING_STATES,
  normalizePlanningState,
} = require("../../constants/workOrderPlanningState");

const base = (over = {}) => ({ quantity: 5, customerRequestId: new mongoose.Types.ObjectId(), ...over });

/** Read the document as MongoDB actually holds it - no schema, no defaults. */
const raw = (id) => mongoose.connection.db.collection("workorders").findOne({ _id: id });

/* ═══ 1 · THE SCHEMA ══════════════════════════════════════════════════════ */

describe("the planning axis is declared exactly as decided", () => {
  const path = () => WorkOrder.schema.path("planningState");

  test("the field exists and is a String", () => {
    expect(path()).toBeDefined();
    expect(path().instance).toBe("String");
  });

  test("the enum is exactly the five decided values, in order", () => {
    expect(path().enumValues).toEqual([
      "unknown", "not_started", "in_progress", "complete", "released",
    ]);
    expect(PLANNING_STATES).toEqual(path().enumValues);
  });

  test("there is NO schema default", () => {
    // The load-bearing assertion. A default here would resurrect the masking
    // behaviour the 4A audit measured.
    expect(path().defaultValue).toBeUndefined();
    expect(path().options.default).toBeUndefined();
  });

  test("the field is not required, so a legacy record can still be saved", () => {
    expect(path().isRequired).toBeFalsy();
  });

  test("`status` is untouched - same enum, same default", () => {
    const status = WorkOrder.schema.path("status");
    expect(status.defaultValue).toBe("pending");
    expect(status.enumValues).toEqual([
      "pending", "planned", "scheduled", "ready_to_start",
      "in_progress", "paused", "completed", "cancelled",
      "delayed", "partial_allocation", "forwarded",
    ]);
  });
});

/* ═══ 2 · THE NEW-RECORD INVARIANT ════════════════════════════════════════ */

describe("every genuinely new work order is persisted as not_started", () => {
  test("new WorkOrder().save()", async () => {
    const wo = new WorkOrder(base());
    await wo.save();
    expect((await raw(wo._id)).planningState).toBe("not_started");
  });

  test("WorkOrder.create()", async () => {
    const wo = await WorkOrder.create(base());
    expect((await raw(wo._id)).planningState).toBe("not_started");
  });

  test("WorkOrder.create([...]) - every record in the array", async () => {
    const made = await WorkOrder.create([base(), base(), base()]);
    for (const wo of made) {
      expect((await raw(wo._id)).planningState).toBe("not_started");
    }
  });

  test("WorkOrder.insertMany() - which runs NO save middleware at all", async () => {
    // This is why the invariant lives on `validate` rather than `save`.
    const made = await WorkOrder.insertMany([base(), base()]);
    for (const wo of made) {
      expect((await raw(wo._id)).planningState).toBe("not_started");
    }
  });

  test("it does not disturb the canonical workOrderNumber invariant", async () => {
    const wo = await WorkOrder.create(base());
    const stored = await raw(wo._id);
    expect(stored.workOrderNumber).toBe(`WO-${wo._id}`);
    expect(stored.planningState).toBe("not_started");
  });
});

/* ═══ 3 · EXPLICIT VALUES ═════════════════════════════════════════════════ */

describe("an explicitly supplied planning state is preserved, never overwritten", () => {
  test.each(["unknown", "in_progress", "complete", "released"])("%s survives creation", async (value) => {
    const wo = await WorkOrder.create(base({ planningState: value }));
    expect((await raw(wo._id)).planningState).toBe(value);
  });

  test("an invalid value fails validation rather than being silently replaced", async () => {
    // The invariant must not paper over a bad value by assigning a default.
    await expect(WorkOrder.create(base({ planningState: "planned" })))
      .rejects.toThrow(mongoose.Error.ValidationError);
  });
});

/* ═══ 4 · LEGACY RECORDS ══════════════════════════════════════════════════ */

describe("a legacy record has no planning state and never gains one by accident", () => {
  /** Insert straight through the driver: no schema, no hooks, no invariant. */
  async function insertLegacy(over = {}) {
    const _id = new mongoose.Types.ObjectId();
    await mongoose.connection.db.collection("workorders").insertOne({
      _id,
      workOrderNumber: `WO-LEGACY-${_id}`,
      quantity: 5,
      status: "in_progress",
      ...over,
    });
    return _id;
  }

  test("it is physically absent in MongoDB", async () => {
    const stored = await raw(await insertLegacy());
    expect("planningState" in stored).toBe(false);
  });

  test("it stays absent when hydrated - no default fills it in", async () => {
    const id = await insertLegacy();
    const hydrated = await WorkOrder.findById(id);
    expect(hydrated.planningState).toBeUndefined();
    // And the lean read agrees, which is exactly what a default would break.
    expect("planningState" in (await WorkOrder.findById(id).lean())).toBe(false);
  });

  test("an UNRELATED save does not add the field", async () => {
    const id = await insertLegacy();
    const wo = await WorkOrder.findById(id);
    wo.quantity = 9;
    await wo.save();

    const stored = await raw(id);
    expect(stored.quantity).toBe(9);          // the edit landed
    expect("planningState" in stored).toBe(false);  // and nothing else did
  });

  test("an unrelated save does not rewrite `status` either", async () => {
    const id = await insertLegacy({ status: "partial_allocation" });
    const wo = await WorkOrder.findById(id);
    wo.quantity = 11;
    await wo.save();
    expect((await raw(id)).status).toBe("partial_allocation");
  });
});

/* ═══ 5 · READ-SIDE NORMALIZATION ═════════════════════════════════════════ */

describe("absence is interpreted as unknown on read, and reading writes nothing", () => {
  test("a stored valid value maps to itself", () => {
    for (const value of PLANNING_STATES) {
      expect(normalizePlanningState(value)).toBe(value);
    }
  });

  test.each([undefined, null, "", "planned", 3, {}])("%p maps to unknown", (value) => {
    expect(normalizePlanningState(value)).toBe("unknown");
  });

  test("normalizing a legacy record does NOT persist unknown", async () => {
    const _id = new mongoose.Types.ObjectId();
    await mongoose.connection.db.collection("workorders").insertOne({
      _id, workOrderNumber: `WO-LEGACY-${_id}`, quantity: 5, status: "pending",
    });

    const projected = normalizePlanningState((await WorkOrder.findById(_id).lean()).planningState);
    expect(projected).toBe("unknown");

    // The whole point: interpretation is a read, not a write.
    expect("planningState" in (await raw(_id))).toBe(false);
  });
});
