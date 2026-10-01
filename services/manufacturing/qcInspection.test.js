// services/manufacturing/qcInspection.test.js
//
// The unified QC Inspect workflow's three pure decisions:
//   1. WHAT was scanned  — qcBarcodeIdentity.classifyQcBarcode
//   2. WHO may inspect it — qcActor.mayInspect
//   3. WHOSE material is it — qcRawItemOrders.labelSource / orderSource
//
// Each is the kind of rule that is silently wrong rather than loudly broken: a
// mis-classified scan records a real verdict against the wrong thing, a
// mis-resolved capability offers a page that will refuse the person, and an
// ownership test used as an eligibility gate hides half the factory's work —
// which is exactly what happened and what this change undoes.
//
// Run by `npm test` (node --test "services/**/*.test.js"). No database: the
// order-resolution join is exercised against live data by the route.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyQcBarcode, garmentPieceOf, rawMaterialIdOf } = require("./qcBarcodeIdentity");
const { mayInspect } = require("./qcActor");
const { labelSource, orderSource, SOURCE } = require("./qcRawItemOrders");

/* ── 1. WHAT WAS SCANNED ──────────────────────────────────────────────────── */

test("a garment piece is recognised, and its key is never rewritten", async (t) => {
  await t.test("the canonical form", () => {
    const r = classifyQcBarcode("WO-A1B2C3D4-17");
    assert.equal(r.type, "garment_piece");
    assert.deepEqual(r.parsed, { workOrderShortId: "A1B2C3D4", unitNumber: 17 });
  });

  await t.test("`normalizedBarcode` is the trimmed scan VERBATIM", () => {
    /* `barcodeId` on QCInspection IS this string; `/lookup-piece` queries with
       it and qcStages.pieceProgress keys on it. Rebuilding it as
       `WO-${shortId}-${unitNumber}` would fold WO-X-017 into WO-X-17 and split
       every existing piece's history from its future scans — silently, and only
       for the labels that carry a leading zero. */
    assert.equal(classifyQcBarcode("  WO-A1B2C3D4-017  ").normalizedBarcode, "WO-A1B2C3D4-017");
    assert.equal(classifyQcBarcode("WO-A1B2C3D4-17").normalizedBarcode, "WO-A1B2C3D4-17");
    assert.notEqual(
      classifyQcBarcode("WO-A1B2C3D4-017").normalizedBarcode,
      classifyQcBarcode("WO-A1B2C3D4-17").normalizedBarcode,
    );
  });

  await t.test("`WO` is case-sensitive, because both existing parsers are", () => {
    /* `parseBarcode` in qcRoutes.js tests `parts[0] !== "WO"`, and so does the
       frontend's `parseBarcodeClientSide`. Accepting `wo-…` here would admit a
       scan the lookup it feeds would still refuse. */
    assert.equal(classifyQcBarcode("wo-a1b2c3d4-17").type, "unknown");
    assert.match(classifyQcBarcode("wo-a1b2c3d4-17").refusal, /in capitals/);
  });

  await t.test("a malformed piece code is refused BY NAME, not as gibberish", () => {
    for (const bad of ["WO-A1B2C3D4", "WO-A1B2C3D4-0", "WO-A1B2C3D4-x", "WO--7"]) {
      const r = classifyQcBarcode(bad);
      assert.equal(r.type, "unknown", bad);
      assert.match(r.refusal || "", /work-order code/, bad);
    }
  });

  await t.test("garmentPieceOf rejects a zero or negative unit", () => {
    assert.equal(garmentPieceOf("WO-X-0"), null);
    assert.equal(garmentPieceOf("WO-X--1"), null);
    assert.deepEqual(garmentPieceOf("WO-X-1"), { workOrderShortId: "X", unitNumber: 1 });
  });
});

test("a raw-material label is recognised in all four of its forms", async (t) => {
  const ID = "507f1f77bcf86cd799439011";

  await t.test("bare id, itemid= and the legacy RawItem=", () => {
    for (const form of [ID, `itemid=${ID}`, `RawItem=${ID}`, `ITEMID=${ID.toUpperCase()}`]) {
      const r = classifyQcBarcode(form);
      assert.equal(r.type, "raw_material", form);
      assert.equal(r.normalizedBarcode, ID, form);
    }
  });

  await t.test("THE URL FORM, which is what every current label encodes", () => {
    /* `itemQrPayload` in the frontend's lib/barcodeSticker.js prints
       `<origin>/store/dashboard/item-info?itemid=<id>`. A wedge scanner types the
       whole URL and a phone camera hands over the whole URL, and the backend's
       old `stickerIdOf` accepted only the three forms above — so camera-scanning
       a modern label into raw-material QC was refused as "not a raw item label".
       This is the regression test for that. */
    for (const form of [
      `https://cms.grav.in/store/dashboard/item-info?itemid=${ID}`,
      `http://localhost:3001/store/dashboard/item-info?itemid=${ID}`,
      `https://cms.grav.in/store/dashboard/item-info?itemid=${ID}&from=qc`,
      `https://cms.grav.in/x?a=1&itemid=${ID}`,
    ]) {
      const r = classifyQcBarcode(form);
      assert.equal(r.type, "raw_material", form);
      assert.equal(r.normalizedBarcode, ID, form);
    }
  });

  await t.test("the id is lower-cased, because it is a lookup key and hex is hex", () => {
    assert.equal(classifyQcBarcode(`itemid=${ID.toUpperCase()}`).normalizedBarcode, ID);
  });

  await t.test("a URL with no usable itemid is not a raw-material label", () => {
    assert.equal(classifyQcBarcode("https://cms.grav.in/store/dashboard/item-info").type, "unknown");
    assert.equal(classifyQcBarcode("https://cms.grav.in/x?itemid=nothex").type, "unknown");
  });

  await t.test("rawMaterialIdOf rejects a near-miss id length", () => {
    assert.equal(rawMaterialIdOf(`itemid=${ID.slice(0, 23)}`), null);
    assert.equal(rawMaterialIdOf(`${ID}0`), null);
  });
});

test("a barcode from a third family is refused, never guessed", async (t) => {
  await t.test("a Store LOCATION label is named", () => {
    /* It is on the shelf the roll came off, so it gets scanned into QC by
       mistake regularly. Falling through to whichever branch is tested first
       would record a verdict against the wrong subject. */
    for (const form of ["loc=LOC-A1B2C3D4", "https://cms.grav.in/store/dashboard/locations/scan?loc=LOC-A1B2C3D4"]) {
      const r = classifyQcBarcode(form);
      assert.equal(r.type, "unknown", form);
      assert.match(r.refusal, /Store location label \(LOC-A1B2C3D4\)/, form);
    }
  });

  await t.test("an empty scan says so rather than reporting a bad barcode", () => {
    for (const blank of ["", "   ", null, undefined]) {
      const r = classifyQcBarcode(blank);
      assert.equal(r.type, "unknown");
      assert.equal(r.refusal, "Nothing was scanned.");
    }
  });

  await t.test("something unrecognisable is unknown with no invented reason", () => {
    for (const junk of ["hello", "12345", "EMP-4412"]) {
      const r = classifyQcBarcode(junk);
      assert.equal(r.type, "unknown", junk);
      assert.equal(r.refusal, null, junk);
      /* The value survives so the screen can quote it back. */
      assert.equal(r.scanned, junk);
    }
  });

  await t.test("the two families cannot collide", () => {
    /* A 24-hex id can never start with `WO-`, and a `WO-` code can never be 24
       hex, so no input is both. Asserted rather than assumed because the whole
       design rests on it. */
    const both = ["WO-A1B2C3D4-17", "507f1f77bcf86cd799439011"].map((v) => classifyQcBarcode(v).type);
    assert.deepEqual(both, ["garment_piece", "raw_material"]);
  });
});

/* ── 2. WHO MAY INSPECT IT ────────────────────────────────────────────────── */

test("permission is decided per barcode type, by the server", async (t) => {
  const actor = (o) => ({ owner: false, rawCheck: false, productCheck: false, ...o });

  await t.test("the owner may inspect both books", () => {
    const a = actor({ owner: true, rawCheck: true, productCheck: true });
    assert.equal(mayInspect(a, "garment_piece").permitted, true);
    assert.equal(mayInspect(a, "raw_material").permitted, true);
  });

  await t.test("a garment-only inspector is refused a raw-material label, with a way forward", () => {
    const a = actor({ productCheck: true });
    assert.equal(mayInspect(a, "garment_piece").permitted, true);
    const no = mayInspect(a, "raw_material");
    assert.equal(no.permitted, false);
    assert.equal(no.code, "NOT_A_RAW_ITEM_CHECKER");
    /* A refusal that only says "not permitted" sends the person to find somebody
       to ask what it meant. */
    assert.match(no.message, /Setup › Raw-material QC/);
    assert.match(no.message, /Garment inspection is unaffected/);
  });

  await t.test("a raw-only checker is refused a garment piece, with a way forward", () => {
    const a = actor({ rawCheck: true });
    assert.equal(mayInspect(a, "raw_material").permitted, true);
    const no = mayInspect(a, "garment_piece");
    assert.equal(no.permitted, false);
    assert.equal(no.code, "NOT_A_PRODUCT_CHECKER");
    assert.match(no.message, /Setup › Raw-material QC/);
  });

  await t.test("an unknown barcode is not an access refusal", () => {
    /* There is no branch to open, so the screen's own "not recognised" message
       is the right answer; stacking a permission error on top of it would say
       the scan failed for two reasons when it failed for one. */
    assert.equal(mayInspect(actor({}), "unknown").permitted, true);
  });

  await t.test("somebody with neither capability is refused both, separately", () => {
    const a = actor({});
    assert.equal(mayInspect(a, "garment_piece").permitted, false);
    assert.equal(mayInspect(a, "raw_material").permitted, false);
    assert.notEqual(mayInspect(a, "garment_piece").code, mayInspect(a, "raw_material").code);
  });
});

/* ── 3. WHOSE MATERIAL IS IT — CONTEXT, NOT A GATE ───────────────────────── */

test("material ownership is described and never gates eligibility", async (t) => {
  await t.test("a label's source is read off the label", () => {
    assert.equal(labelSource({ customerMaterial: { lotId: "x" } }).source, SOURCE.CUSTOMER);
    assert.equal(labelSource({ customerMaterial: { orderRef: "MO-9" } }).source, SOURCE.CUSTOMER);
    assert.equal(labelSource({ purchaseOrderNumber: "PO-88" }).source, SOURCE.FACTORY);
    assert.equal(labelSource({ vendorName: "Shree Textiles" }).source, SOURCE.FACTORY);
  });

  await t.test("unknown provenance says unavailable rather than assuming the factory's", () => {
    assert.equal(labelSource({ rawItemName: "Cotton" }).source, SOURCE.UNAVAILABLE);
    assert.equal(labelSource(null).source, SOURCE.UNAVAILABLE);
    assert.equal(labelSource(undefined).sourceLabel, "Unavailable");
  });

  await t.test("the owner's name travels with the source where there is one", () => {
    assert.equal(labelSource({ customerMaterial: { customerLabel: "Acme Retail" } }).owner, "Acme Retail");
    assert.equal(labelSource({ vendorName: "Shree Textiles" }).owner, "Shree Textiles");
  });

  await t.test("an order's source reads BOTH signals and reports each", () => {
    /* They can disagree: material can arrive for an order Sales never marked,
       and an order can be marked before anything arrives. Neither is an error,
       and the screen should be able to say which happened. */
    const marked = orderSource({ fulfilmentModel: "JOB_WORK" });
    assert.equal(marked.source, SOURCE.CUSTOMER);
    assert.equal(marked.salesSaysJobWork, true);
    assert.equal(marked.hasCustomerMaterial, false);

    const arrived = orderSource({ fulfilmentModel: "REGULAR" }, { hasCustomerMaterial: true });
    assert.equal(arrived.source, SOURCE.CUSTOMER);
    assert.equal(arrived.salesSaysJobWork, false);
    assert.equal(arrived.hasCustomerMaterial, true);
  });

  await t.test("one job-work LINE makes the order's material customer-supplied", () => {
    const mixed = orderSource({ items: [{ fulfilmentModel: "REGULAR" }, { fulfilmentModel: "JOB_WORK" }] });
    assert.equal(mixed.salesSaysJobWork, true);
  });

  await t.test("a regular order is factory-procured and is still a real source", () => {
    const plain = orderSource({ fulfilmentModel: "REGULAR", items: [{}] });
    assert.equal(plain.source, SOURCE.FACTORY);
    assert.equal(plain.sourceLabel, "Factory procured");
    /* THE POINT OF THE WHOLE CHANGE: this order has a source like any other, and
       nothing in `orderSource` says whether it may be inspected. Eligibility is
       `eligibleOrders`, which asks whether the order NEEDS material. */
    assert.ok(!("eligible" in plain), "orderSource must not carry an eligibility verdict");
  });
});
