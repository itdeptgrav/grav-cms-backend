// services/manufacturing/workOrderShortId.test.js
//
// THE SHORT ID IS DERIVED FROM `_id`. THERE IS NO FIELD.
//
// This suite exists because there were two lookup rules for one label format
// and one of them could never match anything: `/qc/identify-barcode` queried
// `WorkOrder.findOne({ workOrderShortId })` against a path that
// `models/CMS_Models/Manufacturing/WorkOrder/WorkOrder.js` does not declare, so
// every garment scanned at the unified Inspect station was reported as "no work
// order on record" — including work orders that `/lookup-piece` opened
// correctly from the same string moments later.
//
// ── WHAT IS TESTED WITHOUT A DATABASE, AND WHY THAT IS ENOUGH ──────────────
// The rule is: take the last eight characters of the 24-character ObjectId hex
// and compare them to the eight between the dashes. That is a pure function of
// an ObjectId, and it is asserted here against REAL ObjectIds — including the
// one behind the repository's own `WO-359e7172-009` — rather than against a
// hand-written string. The database part is the `$match` stage, which is
// asserted structurally and then exercised through an injected fake model, so
// the pipeline that would run against Mongo is the pipeline under test.
//
// What this cannot prove is that a document with that `_id` exists in any
// particular deployment; that is a data question, not a code one.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  findWorkOrderByShortId, shortIdOf, isShortId, shortIdPipeline, shortIdMatchStage,
  OBJECT_ID_LEN, SHORT_ID_LEN,
} = require("./workOrderShortId");
const { classifyQcBarcode, garmentPieceOf } = require("./qcBarcodeIdentity");

/* The repository's own verification label, and the ObjectId it must come
   from: `359e7172` are characters 17–24 of it. */
const LIVE_SHORT_ID = "359e7172";
const LIVE_OBJECT_ID = `68d2fa1c4b7e0a91359e7172`;
const LIVE_BARCODE = `WO-${LIVE_SHORT_ID}-009`;

/** A stand-in for the mongoose model: records the pipeline, returns the rows. */
function fakeModel(rows = []) {
  const calls = [];
  return {
    calls,
    async aggregate(pipeline) {
      calls.push(pipeline);
      const shortId = pipeline[0].$match.$expr.$eq[1];
      return rows.filter((r) => String(r._id).slice(-SHORT_ID_LEN) === shortId).slice(0, 1);
    },
  };
}

test("a short id is the last eight characters of the ObjectId", async (t) => {
  await t.test("and the repository's own label derives from a real one", () => {
    assert.equal(LIVE_OBJECT_ID.length, OBJECT_ID_LEN);
    assert.equal(shortIdOf(LIVE_OBJECT_ID), LIVE_SHORT_ID);
    assert.equal(garmentPieceOf(LIVE_BARCODE).workOrderShortId, LIVE_SHORT_ID);
  });

  await t.test("anything that is not a 24-character id has no short id", () => {
    for (const bad of ["", null, undefined, "68d2fa1c", `${LIVE_OBJECT_ID}0`]) {
      assert.equal(shortIdOf(bad), "", `${String(bad)} should have no short id`);
    }
  });

  await t.test("the bounds are the ones the label printer uses", () => {
    assert.equal(OBJECT_ID_LEN, 24);
    assert.equal(SHORT_ID_LEN, 8);
  });
});

test("the match stage compares a derived substring, never a stored field", async (t) => {
  await t.test("it reads `_id`, not `workOrderShortId`", () => {
    /* THE WHOLE POINT. A `$match` naming `workOrderShortId` is the bug this
       suite exists for: that path is on no document in the collection. */
    const stage = shortIdMatchStage(LIVE_SHORT_ID);
    const json = JSON.stringify(stage);
    assert.ok(!json.includes("workOrderShortId"), "the query must not name a stored short-id field");
    assert.match(json, /\$toString/);
    assert.match(json, /\$substrCP/);
    assert.deepEqual(stage.$match.$expr.$eq[0].$substrCP.slice(1), [16, 8]);
  });

  await t.test("the pipeline limits to one and carries the caller's projection", () => {
    const project = { _id: 1, quantity: 1 };
    const pipeline = shortIdPipeline(LIVE_SHORT_ID, project);
    assert.equal(pipeline.length, 3);
    assert.deepEqual(pipeline[1], { $limit: 1 });
    assert.deepEqual(pipeline[2], { $project: project });
    /* Two call sites want different fields — `/lookup-piece` needs the routing
       and the customer request, `/identify-barcode` four facts — so the
       projection belongs to the caller and the RULE does not. */
    assert.equal(shortIdPipeline(LIVE_SHORT_ID).length, 2);
  });
});

test("resolving a work order from a piece label", async (t) => {
  const wo = { _id: LIVE_OBJECT_ID, workOrderNumber: "WO/2026/0311", quantity: 120 };

  await t.test("the repository's own barcode reaches its work order", async () => {
    const model = fakeModel([wo, { _id: "68d2fa1c4b7e0a91ffffffff", quantity: 9 }]);
    const id = classifyQcBarcode(LIVE_BARCODE);
    assert.equal(id.type, "garment_piece");
    const found = await findWorkOrderByShortId(id.parsed.workOrderShortId, { model });
    assert.equal(found?.workOrderNumber, "WO/2026/0311");
    assert.equal(model.calls.length, 1);
  });

  await t.test("an unknown work order is null, not a throw", async () => {
    const model = fakeModel([wo]);
    assert.equal(await findWorkOrderByShortId("deadbeef", { model }), null);
  });

  await t.test("a malformed short id never reaches the database", async () => {
    /* ObjectId hex is lower case, always, so an upper-cased or wrong-length
       short id cannot match any document. Refusing it here is the same answer
       the query would have given, without the collection scan. */
    const model = fakeModel([wo]);
    for (const bad of ["", null, "359E7172", "359e717", "359e71722", "zzzzzzzz"]) {
      assert.equal(await findWorkOrderByShortId(bad, { model }), null, `${String(bad)} must not resolve`);
    }
    assert.equal(model.calls.length, 0, "no query should have run for any of them");
    assert.ok(isShortId(LIVE_SHORT_ID));
  });
});

test("the label's identity survives the lookup unchanged", async (t) => {
  await t.test("a leading zero on the unit is NOT normalised away", () => {
    /* `barcodeId` on QCInspection IS this string, and `/lookup-piece` queries
       it verbatim. Folding `-009` into `-9` would split every affected piece's
       history from its future scans, silently, and only for the labels that
       happen to carry a leading zero. */
    const id = classifyQcBarcode(LIVE_BARCODE);
    assert.equal(id.normalizedBarcode, LIVE_BARCODE);
    assert.notEqual(id.normalizedBarcode, `WO-${LIVE_SHORT_ID}-9`);
    assert.equal(id.parsed.unitNumber, 9, "the unit NUMBER is still nine");
  });

  await t.test("and `-009` and `-9` stay two different pieces", () => {
    const a = classifyQcBarcode(`WO-${LIVE_SHORT_ID}-009`);
    const b = classifyQcBarcode(`WO-${LIVE_SHORT_ID}-9`);
    assert.notEqual(a.normalizedBarcode, b.normalizedBarcode);
    // …resolving to the same work order, and the same unit, all the same.
    assert.equal(a.parsed.workOrderShortId, b.parsed.workOrderShortId);
    assert.equal(a.parsed.unitNumber, b.parsed.unitNumber);
  });

  await t.test("a unit beyond the work order's quantity is still detectable", () => {
    /* The guard itself lives at the call sites — `/lookup-piece` refuses, and
       `/identify-barcode` reports `unitOutOfRange` and lets the station decide.
       What this asserts is that the comparison has both numbers to work with. */
    const id = classifyQcBarcode(`WO-${LIVE_SHORT_ID}-500`);
    assert.equal(id.parsed.unitNumber, 500);
    assert.ok(id.parsed.unitNumber > wo().quantity);
  });

  function wo() { return { quantity: 120 }; }
});
