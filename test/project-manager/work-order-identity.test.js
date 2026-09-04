// test/project-manager/work-order-identity.test.js
//
// Chunk 4A.2. Every work order gets a number before its first write.
//
// ── THE DEFECT ──────────────────────────────────────────────────────────────
// `workOrderNumber` is declared `unique` on a non-sparse index, and NOT ONE
// production creation path assigned it:
//
//   routes/CMS_Routes/Sales/quotationRoutes.js:1868        (Sales generator A)
//   routes/CMS_Routes/Sales/quotationRoutes.js:2768        (Sales generator B)
//   routes/CMS_Routes/Manufacturing/Return/returnRequestRoutes.js:340  (return)
//   routes/CMS_Routes/Manufacturing/Return/returnRequestRoutes.js:375  (rework)
//
// There is no pre-save hook and no counter. So the first numberless work order
// stores `null` and the second collides with E11000 — work-order creation
// itself is capped at one numberless document.
//
// Chunk 4A.1 patched the split path alone. This chunk moves the rule to the
// MODEL, so a creation path added tomorrow cannot reintroduce the defect.
//
// ── THE FORMAT ──────────────────────────────────────────────────────────────
// `WO-<full 24-character ObjectId>`. The eight-character form some readers
// display is a presentation fallback, not an identity: it keeps 32 bits, and
// 32 bits is not a uniqueness mechanism for a unique index. The full id is
// unique wherever ObjectIds are, needs no counter, and is known before the
// first write.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || "grav_clothing_secret_key";

const mongoose = require("mongoose");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");

const CANONICAL = /^WO-[0-9a-f]{24}$/;
const base = (over = {}) => ({ quantity: 5, customerRequestId: new mongoose.Types.ObjectId(), ...over });

/* ═══ 1 · THE INVARIANT ═══════════════════════════════════════════════════ */

describe("every new work order gets a canonical number", () => {
  test("two numberless work orders can both be created", async () => {
    // The exact collision: before the invariant, the second threw
    // E11000 duplicate key … workOrderNumber: null.
    const a = await WorkOrder.create(base());
    const b = await WorkOrder.create(base());

    expect(a.workOrderNumber).toMatch(CANONICAL);
    expect(b.workOrderNumber).toMatch(CANONICAL);
    expect(a.workOrderNumber).not.toBe(b.workOrderNumber);
  });

  test("many numberless work orders can be created, all distinct", async () => {
    const made = [];
    for (let i = 0; i < 25; i++) made.push(await WorkOrder.create(base()));

    const numbers = made.map((w) => w.workOrderNumber);
    expect(new Set(numbers).size).toBe(25);
    for (const n of numbers) expect(n).toMatch(CANONICAL);
  });

  test("the number is derived from the document's own full ObjectId", async () => {
    const wo = await WorkOrder.create(base());
    expect(wo.workOrderNumber).toBe(`WO-${wo._id.toString()}`);
    // The whole id, not the last eight characters.
    expect(wo.workOrderNumber.slice(3)).toHaveLength(24);
  });

  test("it is assigned before the first write, not after", async () => {
    // Readable on the in-memory document, so a route that reports it in its
    // response does not need to re-read the record.
    const wo = new WorkOrder(base());
    await wo.save();
    expect(wo.workOrderNumber).toBe(`WO-${wo._id.toString()}`);

    const stored = await WorkOrder.findById(wo._id).lean();
    expect(stored.workOrderNumber).toBe(wo.workOrderNumber);
  });

  test("the shared static exposes the same rule", async () => {
    const id = new mongoose.Types.ObjectId();
    expect(WorkOrder.canonicalNumber(id)).toBe(`WO-${id.toString()}`);
    expect(WorkOrder.canonicalNumber(id)).toMatch(CANONICAL);
  });
});

/* ═══ 2 · EXPLICIT NUMBERS ARE NEVER OVERWRITTEN ══════════════════════════ */

describe("an explicit number is preserved", () => {
  test("a supplied number survives byte-for-byte", async () => {
    const wo = await WorkOrder.create(base({ workOrderNumber: "WO-2026-000123" }));
    expect(wo.workOrderNumber).toBe("WO-2026-000123");
  });

  test("a legacy short-form number is left alone", async () => {
    const wo = await WorkOrder.create(base({ workOrderNumber: "WO-abcd1234" }));
    expect(wo.workOrderNumber).toBe("WO-abcd1234");
  });

  test("a number with no WO- prefix at all is still left alone", async () => {
    // The invariant supplies an identity; it does not impose a house style on
    // numbers somebody else already owns.
    const wo = await WorkOrder.create(base({ workOrderNumber: "LEGACY/77" }));
    expect(wo.workOrderNumber).toBe("LEGACY/77");
  });

  test("a whitespace-only number is treated as absent", async () => {
    // The schema trims, so "   " is stored as "" — an empty identity, which is
    // exactly the case the invariant exists to prevent.
    const wo = await WorkOrder.create(base({ workOrderNumber: "   " }));
    expect(wo.workOrderNumber).toBe(`WO-${wo._id.toString()}`);
  });

  test("an empty string is treated as absent", async () => {
    const wo = await WorkOrder.create(base({ workOrderNumber: "" }));
    expect(wo.workOrderNumber).toMatch(CANONICAL);
  });
});

/* ═══ 3 · EXISTING RECORDS ARE NEVER RENAMED ══════════════════════════════ */

describe("existing records are not touched", () => {
  test("a persisted legacy numberless record is not renamed by an unrelated save", async () => {
    // Written straight through the driver so it bypasses the invariant — this
    // is what a pre-existing production row looks like.
    const id = new mongoose.Types.ObjectId();
    await WorkOrder.collection.insertOne({ _id: id, quantity: 5, status: "pending" });

    const doc = await WorkOrder.findById(id);
    doc.status = "planned";
    await doc.save();

    const after = await WorkOrder.findById(id).lean();
    expect(after.status).toBe("planned");
    expect(after.workOrderNumber).toBeUndefined();   // still numberless, not renamed
  });

  test("a persisted numbered record keeps its number across saves", async () => {
    const wo = await WorkOrder.create(base({ workOrderNumber: "WO-KEEP-1" }));
    wo.status = "planned";
    await wo.save();
    wo.priority = "high";
    await wo.save();

    expect((await WorkOrder.findById(wo._id).lean()).workOrderNumber).toBe("WO-KEEP-1");
  });

  test("_id and workOrderNumber are both stable after creation", async () => {
    const wo = await WorkOrder.create(base());
    const id0 = String(wo._id), n0 = wo.workOrderNumber;

    wo.status = "scheduled";
    await wo.save();

    const after = await WorkOrder.findById(wo._id).lean();
    expect(String(after._id)).toBe(id0);
    expect(after.workOrderNumber).toBe(n0);
  });
});

/* ═══ 4 · EVERY CREATION API USED IN THIS REPOSITORY ══════════════════════ */

describe("the invariant covers every persistence method in use", () => {
  // The production paths use `new WorkOrder(...)` + `.save()`; the split path
  // and tests use `WorkOrder.create(...)`. insertMany is exercised too, so a
  // future bulk writer is covered rather than silently exempt.

  test("new WorkOrder(...).save() — the Sales and return generators", async () => {
    const wo = new WorkOrder(base());
    await wo.save();
    expect(wo.workOrderNumber).toMatch(CANONICAL);
  });

  test("WorkOrder.create(...)", async () => {
    const wo = await WorkOrder.create(base());
    expect(wo.workOrderNumber).toMatch(CANONICAL);
  });

  test("WorkOrder.create([...]) with several documents", async () => {
    const made = await WorkOrder.create([base(), base(), base()]);
    const numbers = made.map((w) => w.workOrderNumber);
    expect(new Set(numbers).size).toBe(3);
    for (const n of numbers) expect(n).toMatch(CANONICAL);
  });

  test("WorkOrder.insertMany(...)", async () => {
    const made = await WorkOrder.insertMany([base(), base(), base()]);
    const numbers = made.map((w) => w.workOrderNumber);
    expect(new Set(numbers).size).toBe(3);
    for (const n of numbers) expect(n).toMatch(CANONICAL);

    const stored = await WorkOrder.find({ _id: { $in: made.map((m) => m._id) } }).lean();
    for (const s of stored) expect(s.workOrderNumber).toBe(`WO-${s._id.toString()}`);
  });

  test("the real Sales generator shape gets a number", async () => {
    // The field set from routes/CMS_Routes/Sales/quotationRoutes.js:1868 and
    // :2768 — neither of which mentions workOrderNumber.
    const wo = new WorkOrder({
      customerRequestId: new mongoose.Types.ObjectId(),
      stockItemId: new mongoose.Types.ObjectId(),
      stockItemName: "Shirt", stockItemReference: "SH-1",
      variantId: String(new mongoose.Types.ObjectId()), variantAttributes: [],
      quantity: 12, customerId: new mongoose.Types.ObjectId(), customerName: "Acme",
      priority: "medium", status: "pending", operations: [], rawMaterials: [],
      timeline: { plannedStartDate: null, plannedEndDate: null, actualStartDate: null,
        actualEndDate: null, scheduledStartDate: null, scheduledEndDate: null },
      specialInstructions: [], estimatedCost: 0, actualCost: 0,
      createdBy: new mongoose.Types.ObjectId(),
    });
    await wo.save();

    expect(wo.workOrderNumber).toBe(`WO-${wo._id.toString()}`);
  });

  test("the real return/rework generator shape gets a number", async () => {
    // The field set from routes/CMS_Routes/Manufacturing/Return/
    // returnRequestRoutes.js:340 and :375.
    const wo = new WorkOrder({
      customerRequestId: new mongoose.Types.ObjectId(),
      stockItemId: new mongoose.Types.ObjectId(),
      stockItemName: "Shirt", stockItemReference: "SH-1",
      variantId: "", variantAttributes: [],
      quantity: 3, customerId: new mongoose.Types.ObjectId(), customerName: "Acme",
      priority: "high", status: "pending", operations: [], rawMaterials: [],
      estimatedCost: 0, actualCost: 0, createdBy: null,
    });
    await wo.save();

    expect(wo.workOrderNumber).toBe(`WO-${wo._id.toString()}`);
  });

  test("two return-shaped work orders in one request both save", async () => {
    // returnRequestRoutes creates one per stock item in a loop — the exact
    // shape that used to collide on the second save.
    const shape = () => new WorkOrder({
      customerRequestId: new mongoose.Types.ObjectId(),
      quantity: 2, priority: "high", status: "pending",
      operations: [], rawMaterials: [], createdBy: null,
    });
    const a = shape(); const b = shape();
    await a.save();
    await b.save();

    expect(a.workOrderNumber).not.toBe(b.workOrderNumber);
    expect(await WorkOrder.countDocuments({ _id: { $in: [a._id, b._id] } })).toBe(2);
  });

  test("the unique index is still enforced", async () => {
    await WorkOrder.syncIndexes();
    await WorkOrder.create(base({ workOrderNumber: "WO-DUPLICATE" }));
    await expect(WorkOrder.create(base({ workOrderNumber: "WO-DUPLICATE" }))).rejects.toThrow(/duplicate key/i);
  });
});

/* ═══ 5 · BARCODE AND PARSER COMPATIBILITY ════════════════════════════════ */

describe("compatibility with the barcode and short-id subsystem", () => {
  /** The parser every scan consumer shares (10 identical copies, e.g.
   *  workOrderRoutes.js:66, productionCompletionRoutes.js:14). */
  const parseBarcode = (barcodeId) => {
    const parts = String(barcodeId).split("-");
    if (parts.length >= 3 && parts[0] === "WO") {
      return { success: true, woShortId: parts[1], unitNumber: parseInt(parts[2], 10) };
    }
    return { success: false };
  };

  test("the bare work-order number is never mistaken for a unit scan", async () => {
    const wo = await WorkOrder.create(base());
    // "WO" + one id segment = two parts; the guard needs three.
    expect(wo.workOrderNumber.split("-")).toHaveLength(2);
    expect(parseBarcode(wo.workOrderNumber).success).toBe(false);
  });

  test("appending the existing unit suffix still parses", async () => {
    const wo = await WorkOrder.create(base());
    const parsed = parseBarcode(`${wo.workOrderNumber}-001`);

    expect(parsed.success).toBe(true);
    expect(parsed.unitNumber).toBe(1);
    expect(parsed.woShortId).toBe(wo._id.toString());   // the whole id, intact
  });

  test("appending the unit+operation suffix still parses", async () => {
    const wo = await WorkOrder.create(base());
    const parsed = parseBarcode(`${wo.workOrderNumber}-007-3`);

    expect(parsed.success).toBe(true);
    expect(parsed.woShortId).toBe(wo._id.toString());
    expect(parsed.unitNumber).toBe(7);
  });

  test("no parser assumes exactly eight hex characters", async () => {
    // The guard is `parts.length >= 3 && parts[0] === "WO"` — a length rule
    // appears nowhere. A 24-character segment passes exactly as an 8-character
    // one does.
    const wo = await WorkOrder.create(base());
    for (const segment of [wo._id.toString(), wo._id.toString().slice(-8), "abcd1234"]) {
      expect(parseBarcode(`WO-${segment}-001`).success).toBe(true);
    }
  });

  test("the scan subsystem's own barcodes are unchanged by this rule", async () => {
    // Every scan barcode in the codebase is built from `_id.slice(-8)` and
    // resolved the same way — packagingRoutes.js:1249,
    // productionCompletionRoutes.js:331, embroideryRoutes.js:42,
    // manufacturingOrderRoutes.js:113, markAsDoneRoutes.js:113. None reads
    // workOrderNumber, so none of them moves.
    const wo = await WorkOrder.create(base());
    const shortId = wo._id.toString().slice(-8);
    const scanBarcode = `WO-${shortId}-001`;

    expect(parseBarcode(scanBarcode).woShortId).toBe(shortId);
    // …and that short id still resolves the work order the way the resolvers do.
    const all = await WorkOrder.find({}).lean();
    expect(all.find((w) => w._id.toString().slice(-8) === shortId)._id.toString()).toBe(wo._id.toString());
  });

  test("legacy and explicitly numbered records still read exactly as before", async () => {
    const legacy = await WorkOrder.create(base({ workOrderNumber: "WO-abcd1234" }));
    const explicit = await WorkOrder.create(base({ workOrderNumber: "WO-2026-000123" }));

    expect(parseBarcode(`${legacy.workOrderNumber}-001`).woShortId).toBe("abcd1234");
    expect(parseBarcode(legacy.workOrderNumber).success).toBe(false);
    // An explicitly numbered record with internal hyphens parses as it always
    // has — unchanged by this chunk, quirks included.
    expect(explicit.workOrderNumber).toBe("WO-2026-000123");
  });

  test("the cutting normaliser leaves a canonical number alone", async () => {
    // bulkCuttingRoutes.js:136 — `if (!woNumber.startsWith("WO-")) woNumber = \`WO-${woNumber}\``
    const wo = await WorkOrder.create(base());
    const normalise = (n) => (n.startsWith("WO-") ? n : `WO-${n}`);
    expect(normalise(wo.workOrderNumber)).toBe(wo.workOrderNumber);
  });

  test("lookup by number finds the record", async () => {
    const wo = await WorkOrder.create(base());
    const found = await WorkOrder.findOne({ workOrderNumber: wo.workOrderNumber }).lean();
    expect(String(found._id)).toBe(String(wo._id));
  });
});
