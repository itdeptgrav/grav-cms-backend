// test/merchandising/development-import-on-acceptance.test.js
//
// THE ORDER STARTS FROM WHAT DEVELOPMENT SETTLED.
//
// Materials are chosen during development. An order that came out of one used
// to open with an empty Materials & Trims tab reading "Nothing selected yet"
// and a button asking the merchandiser to start a draft — so the commonest
// path through that screen was retyping a selection the company had already
// approved, which is exactly how a transcription error reaches a factory.
//
// Acceptance now imports it. What this proves, against the real services and
// a real database:
//
//   1  accepting a linked order creates ONE populated draft, not an empty one;
//   2  every identity, colour, finish and placement comes across;
//   3  the draft is DRAFT — a sample selection is not a factory instruction;
//   4  the development revision and the catalogue are untouched;
//   5  the lineage is structured, and a CLIENT cannot forge it;
//   6  running it again — a retry, a second click, a backfill — changes
//      nothing and creates no duplicate draft and no duplicate row;
//   7  an order with no approved development revision is not broken by it.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const SalesHandoverVersion = require("../../models/CMS_Models/Sales/SalesHandoverVersion");
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const {
  DevelopmentFile, DevelopmentBomRevision,
} = require("../../models/CMS_Models/Merchandising/Development");
const execution = require("../../services/merchandising/execution.service");
const selection = require("../../services/merchandising/selection.service");
const adoption = require("../../services/merchandising/developmentAdoption.service");

let companyId;
const actor = { name: "Aisha Demo", email: "merch.demo@grav.local" };
const ctx = () => ({ companyId, role: { canRead: true, canCoordinate: true, canDecide: true, canWriteSelection: true } });

/* The five selections the approved sample was made from. */
const DEV_ROWS = [
  { rowRef: "DR-body", category: "FABRIC", rawItemName: "Navy cotton-piqué body fabric",
    rawItemSku: "FAB-PIQ-NAVY", colourOrShade: "Deep navy", finish: "Enzyme wash",
    placement: "Main body" },
  { rowRef: "DR-rib", category: "TRIM", rawItemName: "Matching navy rib collar and cuff",
    rawItemSku: "TRM-RIB-NAVY", colourOrShade: "Deep navy", placement: "Collar and sleeve cuff" },
  { rowRef: "DR-btn", category: "TRIM", rawItemName: "Dark navy four-hole buttons",
    rawItemSku: "TRM-BTN-14L", colourOrShade: "Dark navy", placement: "Front placket buttons" },
  { rowRef: "DR-thr", category: "ACCESSORY", rawItemName: "White and sky-blue embroidery thread",
    rawItemSku: "ACC-THR-EMB", colourOrShade: "White / sky blue", placement: "Chest embroidery" },
  { rowRef: "DR-bag", category: "SAMPLE_PACKAGING", rawItemName: "Recyclable individual polybag",
    rawItemSku: "PKG-BAG-REC", placement: "Individual packing",
    /* Development states a finish on it; a packaging row has no such field. */
    finish: "Recycled LDPE" },
];

/* `test/setup.js` owns the database and clears every collection after each
   test, so the world is built per test rather than once for the file. */
let seq = 0;

beforeEach(async () => {
  const company = await Acc_Company.create({
    companyName: "GRAV Demo", booksFromDate: new Date("2026-04-01"),
  });
  companyId = company._id;
});

/** A development file with one APPROVED revision of the five rows. */
async function seedDevelopment() {
  const n = ++seq;
  const file = await DevelopmentFile.create({
    companyId, developmentNumber: `MDF-${n}`, productName: "Performance embroidered polo",
    styleRef: `STYLE-${n}`, lifecycleStatus: "ACTIVE",
    productLineRef: `PL-${n}`, journeyId: new mongoose.Types.ObjectId(),
  });
  const revision = await DevelopmentBomRevision.create({
    companyId, developmentFileId: file._id, revisionNo: 1, state: "APPROVED",
    rows: DEV_ROWS.map((r) => ({ ...r })),
    approvedBy: { name: "Rahul Demo", email: "merch.approver@grav.local" },
    approvedAt: new Date(),
  });
  return { file, revision };
}

/** A confirmed Sales handover, optionally linked to a development revision. */
async function seedHandover({ dev = null } = {}) {
  const n = ++seq;
  return SalesHandoverVersion.create({
    companyId,
    handoverRef: `ORD-${n}`, handoverLineRef: `LN-${n}`, versionNo: 1,
    publication: { state: "CURRENT" },
    sourceRecord: {
      app: "sales", recordType: "customer_request", recordId: new mongoose.Types.ObjectId(),
      sourceVersion: "1", issuedAt: new Date(),
    },
    executionProjection: {
      orderRef: `ORD-${n}`, orderLineRef: `LN-${n}`, styleRef: `STYLE-${n}`,
      productName: "Performance embroidered polo", buyerDisplayLabel: "Harbor & Co",
      totalQuantity: 600,
      deliveries: [{ dropRef: "D1", committedDeliveryDate: "2026-11-20", quantity: 600,
        nominatedFactoryRef: "GRAV Unit 01" }],
    },
    ...(dev ? {
      developmentReference: {
        developmentFileId: dev.file._id,
        developmentNumber: dev.file.developmentNumber,
        bomRevisionNo: dev.revision.revisionNo,
      },
    } : {}),
  });
}

const rowsOf = async (fileId, family) => {
  const live = await selection.getCurrent(ctx(), { fileId, family });
  return live.working || live.approved || null;
};

describe("accepting a linked order imports the development selection", () => {
  let dev, accepted;

  beforeEach(async () => {
    dev = await seedDevelopment();
    const handover = await seedHandover({ dev });
    accepted = await execution.acceptHandover(ctx(), { id: String(handover._id), actor });
  });

  test("one populated draft, and the screen never has to say 'nothing selected'", async () => {
    const materials = await rowsOf(accepted.file.id, "MATERIAL_TRIM");
    const packaging = await rowsOf(accepted.file.id, "PACKAGING");
    expect(materials).toBeTruthy();
    expect(packaging).toBeTruthy();
    /* Four materials and trims, one packaging item — the revision's own split
       by category, not a number this test chose. */
    expect(materials.rows).toHaveLength(4);
    expect(packaging.rows).toHaveLength(1);
    expect(materials.revisionNo).toBe(1);
  });

  test("the identities, colours and placements all came across", async () => {
    const materials = await rowsOf(accepted.file.id, "MATERIAL_TRIM");
    expect(materials.rows.map((r) => r.componentName)).toEqual([
      "Navy cotton-piqué body fabric",
      "Matching navy rib collar and cuff",
      "Dark navy four-hole buttons",
      "White and sky-blue embroidery thread",
    ]);
    const body = materials.rows[0];
    expect(body.colourOrShade).toBe("Deep navy");
    expect(body.finish).toBe("Enzyme wash");
    /* "Used for", which is what a merchandiser reads. */
    expect(body.placement).toBe("Main body");
    expect(body.componentCode).toBe("FAB-PIQ-NAVY");
  });

  test("it is a DRAFT — importing is not approving", async () => {
    const materials = await rowsOf(accepted.file.id, "MATERIAL_TRIM");
    expect(materials.state).toBe("DRAFT");
    expect(materials.approvedAt == null || materials.approvedAt === undefined).toBe(true);
    const live = await selection.getCurrent(ctx(), { fileId: accepted.file.id, family: "MATERIAL_TRIM" });
    expect(live.approved).toBeFalsy();
  });

  test("the lineage is structured, and points at the revision it came from", async () => {
    const materials = await rowsOf(accepted.file.id, "MATERIAL_TRIM");
    const body = materials.rows[0];
    expect(body.sourceRef.recordType).toBe("DEVELOPMENT_BOM_ROW");
    expect(body.sourceRef.recordRef).toBe(`${dev.file.developmentNumber} · Revision 1 · DR-body`);
    expect(body.sourceRef.sourceVersion).toBe("1");
    expect(body.sourceRef.sourceState).toBe("APPROVED");
  });

  test("a client cannot claim a row came from a revision that never mentioned it", async () => {
    /* `sourceRef` is a server-only parameter of `addRow` and is in neither
       family's accepted body fields. A row that could stamp its own
       provenance could claim an approval nobody gave it. */
    expect(selection.MATERIAL_TRIM_ROW_FIELDS).not.toContain("sourceRef");
    expect(selection.PACKAGING_ROW_FIELDS).not.toContain("sourceRef");
    const before = await rowsOf(accepted.file.id, "MATERIAL_TRIM");
    /* Refused by NAME, which is stronger than being quietly dropped: the
       caller is told the field is not theirs to state. */
    await expect(selection.addRow(ctx(), {
      fileId: accepted.file.id, family: "MATERIAL_TRIM",
      body: {
        group: "TRIM", componentName: "Order-only hangtag",
        sourceRef: { app: "merchandising", recordType: "DEVELOPMENT_BOM_ROW", recordRef: "forged" },
        expectedRevision: before.revision,
      },
      actor,
    })).rejects.toThrow(/sourceRef/);

    /* And the same row without it is an ordinary order-only addition. */
    await selection.addRow(ctx(), {
      fileId: accepted.file.id, family: "MATERIAL_TRIM",
      body: { group: "TRIM", componentName: "Order-only hangtag", expectedRevision: before.revision },
      actor,
    });
    const after = await rowsOf(accepted.file.id, "MATERIAL_TRIM");
    const added = after.rows.find((r) => r.componentName === "Order-only hangtag");
    expect(added).toBeTruthy();
    expect(added.sourceRef).toBeFalsy();
  });

  test("the development revision and its rows are exactly as they were", async () => {
    const after = await DevelopmentBomRevision.findById(dev.revision._id).lean();
    expect(after.state).toBe("APPROVED");
    expect(after.rows).toHaveLength(DEV_ROWS.length);
    expect(after.rows.map((r) => r.rowRef)).toEqual(DEV_ROWS.map((r) => r.rowRef));
    expect(after.rows[0].colourOrShade).toBe("Deep navy");
  });

  test("running it again creates no second draft and no second set of rows", async () => {
    const before = await rowsOf(accepted.file.id, "MATERIAL_TRIM");
    const replay = await adoption.adopt(ctx(), { fileId: accepted.file.id, actor });
    expect(replay.replayed).toBe(true);
    expect(replay.families).toEqual([]);

    const after = await rowsOf(accepted.file.id, "MATERIAL_TRIM");
    expect(after.revisionNo).toBe(before.revisionNo);
    expect(after.rows).toHaveLength(before.rows.length);
    const packaging = await rowsOf(accepted.file.id, "PACKAGING");
    expect(packaging.rows).toHaveLength(1);
  });

  test("the file records which revision it imported, when, and by whom", async () => {
    const file = await ExecutionFile.findById(accepted.file.id).lean();
    const ref = file.developmentReference;
    expect(ref.importedRevisionNo).toBe(1);
    expect(ref.importedAt).toBeTruthy();
    expect(ref.importedBy.email).toBe(actor.email);
    expect(ref.importedRowCount).toBe(5);
  });

  test("the preview says where the order has got to, not just what development settled", async () => {
    const before = await rowsOf(accepted.file.id, "MATERIAL_TRIM");
    await selection.addRow(ctx(), {
      fileId: accepted.file.id, family: "MATERIAL_TRIM",
      body: { group: "TRIM", componentName: "Order-only hangtag", expectedRevision: before.revision },
      actor,
    });
    const shown = await adoption.preview(ctx(), { fileId: accepted.file.id });
    expect(shown.imported.revisionNo).toBe(1);
    expect(shown.imported.rowCount).toBe(5);
    expect(shown.imported.system).toBe(false);

    /* Every imported row is CARRIED; the one this test added on the order is
       ADDED. Neither is computed in a browser. */
    const carried = shown.orderRows.filter((r) => r.status === "CARRIED");
    const added = shown.orderRows.filter((r) => r.status === "ADDED");
    expect(carried).toHaveLength(5);
    expect(added.map((r) => r.name)).toEqual(["Order-only hangtag"]);
    expect(carried[0].usedFor).toBe("Main body");
    expect(carried[0].developmentSource).toContain("Revision 1");
    /* ── A FIELD THE TARGET ROW DOES NOT HAVE IS NOT A CHANGE ────────
       A packaging row has no `finish`; the import never carried one.
       Comparing it against a development row that stated one marked every
       imported packaging item "changed for this order" — a claim about a
       decision nobody made. */
    const bag = shown.orderRows.find((r) => r.family === "PACKAGING");
    expect(bag.status).toBe("CARRIED");
    expect(bag.changes).toEqual([]);
  });

  test("changing a colour for this order is marked as changed, and development is not", async () => {
    const live = await rowsOf(accepted.file.id, "MATERIAL_TRIM");
    const body = live.rows.find((r) => r.componentName === "Navy cotton-piqué body fabric");
    await selection.updateRow(ctx(), {
      fileId: accepted.file.id, family: "MATERIAL_TRIM", rowRef: body.rowRef,
      body: {
        group: body.group, componentName: body.componentName,
        colourOrShade: "Midnight navy", expectedRevision: live.revision,
      },
      actor,
    });

    const shown = await adoption.preview(ctx(), { fileId: accepted.file.id });
    const changed = shown.orderRows.find((r) => r.name === "Navy cotton-piqué body fabric");
    expect(changed.status).toBe("CHANGED");
    expect(changed.changes).toContain("Colour");

    const dev1 = await DevelopmentBomRevision.findById(dev.revision._id).lean();
    expect(dev1.rows.find((r) => r.rowRef === "DR-body").colourOrShade).toBe("Deep navy");
  });

  test("a development row nobody carried across is reported, not silently dropped", async () => {
    const live = await rowsOf(accepted.file.id, "MATERIAL_TRIM");
    const button = live.rows.find((r) => r.componentName === "Dark navy four-hole buttons");
    await selection.removeRow(ctx(), {
      fileId: accepted.file.id, family: "MATERIAL_TRIM", rowRef: button.rowRef,
      body: { expectedRevision: live.revision }, actor,
    });
    const shown = await adoption.preview(ctx(), { fileId: accepted.file.id });
    expect(shown.removedFromDevelopment.map((r) => r.rowRef)).toEqual(["DR-btn"]);
  });
});

describe("an order with no approved development revision", () => {
  test("is accepted normally, and the import neither runs nor breaks it", async () => {
    const handover = await seedHandover();
    const accepted = await execution.acceptHandover(ctx(), { id: String(handover._id), actor });
    expect(accepted.file.id).toBeTruthy();

    const file = await ExecutionFile.findById(accepted.file.id).lean();
    expect(file.developmentReference?.importedRevisionNo ?? null).toBeNull();

    const shown = await adoption.preview(ctx(), { fileId: accepted.file.id });
    expect(shown.available).toBe(false);
    expect(shown.sentence).toMatch(/did not come from a development job/);
  });

  test("a development file whose selection was never approved is not a source", async () => {
    const n = ++seq;
    const file = await DevelopmentFile.create({
      companyId, developmentNumber: `MDF-draft-${n}`, productName: "Unapproved polo",
      styleRef: `STYLE-${n}`, lifecycleStatus: "ACTIVE",
      productLineRef: `PL-${n}`, journeyId: new mongoose.Types.ObjectId(),
    });
    const revision = await DevelopmentBomRevision.create({
      companyId, developmentFileId: file._id, revisionNo: 1, state: "DRAFT",
      rows: DEV_ROWS.map((r) => ({ ...r })),
    });
    const handover = await seedHandover({ dev: { file, revision } });
    const accepted = await execution.acceptHandover(ctx(), { id: String(handover._id), actor });

    const shown = await adoption.preview(ctx(), { fileId: accepted.file.id });
    expect(shown.available).toBe(false);
    const stamped = await ExecutionFile.findById(accepted.file.id).lean();
    expect(stamped.developmentReference?.importedRevisionNo ?? null).toBeNull();
  });
});
