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

/* ══ AN INTERRUPTED IMPORT IS NOT A FINISHED ONE ══════════════════════════ */

// The defect: the row loop caught each failure into `skipped` and carried on, and
// the stamp went on afterwards regardless. An import that lost three rows therefore
// recorded `importedRevisionNo`, and the next retry answered "already imported into
// this order. Nothing was changed." The three rows were never coming, the drafts
// were quietly short, and the one operation that could have fixed it was the one
// that refused to run.
//
// Completion is now `present === intended`: every row this revision means to bring
// across is in the order's draft, whether this call added it or an earlier
// interrupted run did.

describe("an import interrupted part-way", () => {
  let dev, accepted;
  const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");

  /** Import through the real command, with one named development row made to fail. */
  const importFailing = async (rowRef) => {
    const real = selection.addRow;
    const spy = jest.spyOn(selection, "addRow").mockImplementation(async (c, args) => {
      if (str(args?.sourceRef?.recordRef || "").endsWith(`· ${rowRef}`)) {
        throw new Error(`row store unavailable for ${rowRef}`);
      }
      return real.call(selection, c, args);
    });
    try {
      return await adoption.adopt(ctx(), { fileId: accepted.file.id, actor });
    } finally {
      spy.mockRestore();
    }
  };

  const refOf = (r) => String(r.sourceRef?.recordRef || "");
  const str = (v) => String(v ?? "");

  beforeEach(async () => {
    dev = await seedDevelopment();
    const handover = await seedHandover({ dev });
    /* Accepted WITHOUT the import, so this suite drives it deliberately. */
    const spy = jest.spyOn(adoption, "adopt").mockResolvedValue({ status: "SKIPPED" });
    accepted = await execution.acceptHandover(ctx(), { id: String(handover._id), actor });
    spy.mockRestore();
  });

  test("a failed middle row leaves the import INCOMPLETE and unstamped", async () => {
    const out = await importFailing("DR-btn");

    expect(out.status).toBe("INCOMPLETE");
    expect(out.complete).toBe(false);
    expect(out.retryable).toBe(true);
    expect(out.intended).toBe(5);
    expect(out.present).toBe(4);
    /* Named the way a person would ask about it — the internal row reference is
       there, but nobody has to translate it to know what is missing. */
    expect(out.missing).toEqual([{
      family: "MATERIAL_TRIM",
      familyLabel: "Materials and trims",
      rowRef: "DR-btn",
      componentName: "Dark navy four-hole buttons",
      componentCode: "TRM-BTN-14L",
      reason: expect.stringMatching(/row store unavailable/),
    }]);
    /* And nothing about supplier, rate or cost rides along. */
    expect(JSON.stringify(out.missing)).not.toMatch(/price|rate|supplier|vendor|cost/i);
    /* It says what to do, in those words. */
    expect(out.note).toMatch(/NOT recorded as done/);
    expect(out.importedAt).toBeNull();

    /* And the file does NOT claim the revision was imported. */
    const file = await ExecutionFile.findById(accepted.file.id).lean();
    expect(file.developmentReference.importedRevisionNo ?? null).toBeNull();
    expect(file.developmentReference.importedAt ?? null).toBeNull();
    expect(file.developmentReference.importedRowCount ?? null).toBeNull();
    /* The LINEAGE is recorded either way — which development job this order draws
       on is true as soon as it has been read, and is a different fact from "the
       rows arrived". */
    expect(file.developmentReference.bomRevisionNo).toBe(1);
  });

  test("the retry adds only the missing row, and nothing twice", async () => {
    await importFailing("DR-btn");
    const before = await rowsOf(accepted.file.id, "MATERIAL_TRIM");
    expect(before.rows).toHaveLength(3);

    const retry = await adoption.adopt(ctx(), { fileId: accepted.file.id, actor });

    expect(retry.status).toBe("COMPLETE");
    expect(retry.complete).toBe(true);
    /* One row added by THIS call; five present in total. The stored count is the
       total, not the latest call's additions. */
    expect(retry.adopted).toBe(1);
    expect(retry.present).toBe(5);
    expect(retry.missing).toEqual([]);

    const after = await rowsOf(accepted.file.id, "MATERIAL_TRIM");
    expect(after.rows).toHaveLength(4);
    /* Exactly once each — the presence check is on the lineage reference this
       import writes, so a retry cannot re-add what an earlier run added. */
    const refs = after.rows.map(refOf);
    expect(new Set(refs).size).toBe(refs.length);
    expect(refs.some((r) => r.endsWith("· DR-btn"))).toBe(true);
    /* And the same draft, not a second one. */
    expect(after.revisionNo).toBe(before.revisionNo);
  });

  test("every intended row exists exactly once across both families", async () => {
    await importFailing("DR-rib");
    await adoption.adopt(ctx(), { fileId: accepted.file.id, actor });

    const materials = await rowsOf(accepted.file.id, "MATERIAL_TRIM");
    const packaging = await rowsOf(accepted.file.id, "PACKAGING");
    const refs = [...materials.rows, ...packaging.rows].map(refOf);

    expect(refs).toHaveLength(DEV_ROWS.length);
    expect(new Set(refs).size).toBe(DEV_ROWS.length);
    for (const row of DEV_ROWS) {
      expect(refs.filter((r) => r.endsWith(`· ${row.rowRef}`))).toHaveLength(1);
    }

    /* The stored count is what is there. */
    const file = await ExecutionFile.findById(accepted.file.id).lean();
    expect(file.developmentReference.importedRowCount).toBe(DEV_ROWS.length);
    expect(file.developmentReference.importedRevisionNo).toBe(1);
  });

  test("and the replay after that changes nothing", async () => {
    await importFailing("DR-thr");
    await adoption.adopt(ctx(), { fileId: accepted.file.id, actor });

    const before = await rowsOf(accepted.file.id, "MATERIAL_TRIM");
    const fileBefore = await ExecutionFile.findById(accepted.file.id).lean();

    const replay = await adoption.adopt(ctx(), { fileId: accepted.file.id, actor });
    expect(replay.status).toBe("REPLAYED");
    expect(replay.replayed).toBe(true);
    expect(replay.adopted).toBe(0);
    /* What is THERE, which is what a replay reports. The two used to be one number
       and a reader could not tell an import from a replay of one. */
    expect(replay.present).toBe(DEV_ROWS.length);

    const after = await rowsOf(accepted.file.id, "MATERIAL_TRIM");
    expect(after.rows).toHaveLength(before.rows.length);
    expect(after.revisionNo).toBe(before.revisionNo);
    const fileAfter = await ExecutionFile.findById(accepted.file.id).lean();
    expect(String(fileAfter.developmentReference.importedAt))
      .toBe(String(fileBefore.developmentReference.importedAt));
  });

  test("a whole family that cannot take rows is reported as missing, not skipped over", async () => {
    /* A family whose revision is awaiting a decision cannot take rows. The old code
       recorded the family in `skipped` and stamped the import as done anyway. */
    const real = selection.createDraft;
    const spy = jest.spyOn(selection, "createDraft").mockImplementation(async (c, args) => {
      if (args?.family === "PACKAGING") throw new Error("packaging revision is awaiting a decision");
      return real.call(selection, c, args);
    });
    const out = await adoption.adopt(ctx(), { fileId: accepted.file.id, actor });
    spy.mockRestore();

    expect(out.complete).toBe(false);
    expect(out.missing.map((m) => m.family)).toEqual(["PACKAGING"]);
    const file = await ExecutionFile.findById(accepted.file.id).lean();
    expect(file.developmentReference.importedRevisionNo ?? null).toBeNull();

    /* And the retry finishes it. */
    const retry = await adoption.adopt(ctx(), { fileId: accepted.file.id, actor });
    expect(retry.complete).toBe(true);
    expect((await rowsOf(accepted.file.id, "PACKAGING")).rows).toHaveLength(1);
  });
});

/* ══ TWO IMPORTS AT ONCE ══════════════════════════════════════════════════ */

// The realistic cause is not malice: acceptance runs the import, a message is
// redelivered, and the manual "Import development selections" button is pressed by
// somebody who cannot see that it is already running. Both calls read what is
// already in the draft before either has added anything, so both can decide the
// same row is missing.
//
// What must hold afterwards is simple and is the whole point of the presence check:
// every intended row exists EXACTLY ONCE. Not "roughly once", and not "once unless
// two people were unlucky".

describe("two imports running at the same time", () => {
  let dev, accepted;
  const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
  const refOf = (r) => String(r.sourceRef?.recordRef || "");

  beforeEach(async () => {
    dev = await seedDevelopment();
    const handover = await seedHandover({ dev });
    /* Accepted WITHOUT the import, so this suite drives it deliberately. */
    const spy = jest.spyOn(adoption, "adopt").mockResolvedValue({ status: "SKIPPED" });
    accepted = await execution.acceptHandover(ctx(), { id: String(handover._id), actor });
    spy.mockRestore();
  });

  const allRefs = async () => {
    const materials = await rowsOf(accepted.file.id, "MATERIAL_TRIM");
    const packaging = await rowsOf(accepted.file.id, "PACKAGING");
    return [...(materials?.rows || []), ...(packaging?.rows || [])].map(refOf);
  };

  test("every intended row exists exactly once", async () => {
    const [a, b] = await Promise.allSettled([
      adoption.adopt(ctx(), { fileId: accepted.file.id, actor }),
      adoption.adopt(ctx(), { fileId: accepted.file.id, actor }),
    ]);
    /* One of them may legitimately fail — two callers writing the same draft race on
       its revision, and losing that race is a refusal, not a duplicate. What is not
       allowed is a row arriving twice. */
    const refs = await allRefs();
    for (const row of DEV_ROWS) {
      expect(refs.filter((r) => r.endsWith(`· ${row.rowRef}`))).toHaveLength(1);
    }
    expect(new Set(refs).size).toBe(refs.length);
    expect([a.status, b.status].some((s) => s === "fulfilled")).toBe(true);
  });

  test("and an honest retry afterwards completes it, still exactly once", async () => {
    await Promise.allSettled([
      adoption.adopt(ctx(), { fileId: accepted.file.id, actor }),
      adoption.adopt(ctx(), { fileId: accepted.file.id, actor }),
    ]);

    /* Whatever the race left behind, the retry finishes the job — that is what
       retry-safety means here, and it is the promise made in place of atomicity. */
    const retry = await adoption.adopt(ctx(), { fileId: accepted.file.id, actor });
    expect(["COMPLETE", "REPLAYED"]).toContain(retry.status);

    const refs = await allRefs();
    expect(refs).toHaveLength(DEV_ROWS.length);
    expect(new Set(refs).size).toBe(DEV_ROWS.length);
    for (const row of DEV_ROWS) {
      expect(refs.filter((r) => r.endsWith(`· ${row.rowRef}`))).toHaveLength(1);
    }

    const file = await ExecutionFile.findById(accepted.file.id).lean();
    expect(file.developmentReference.importedRowCount).toBe(DEV_ROWS.length);
    expect(file.developmentReference.importedRevisionNo).toBe(1);
  });

  test("five simultaneous imports still leave one of each", async () => {
    await Promise.allSettled(Array.from({ length: 5 }, () =>
      adoption.adopt(ctx(), { fileId: accepted.file.id, actor })));
    await adoption.adopt(ctx(), { fileId: accepted.file.id, actor });

    const refs = await allRefs();
    expect(new Set(refs).size).toBe(DEV_ROWS.length);
    expect(refs).toHaveLength(DEV_ROWS.length);
  });
});
