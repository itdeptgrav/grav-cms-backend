// test/merchandising/tna-configuration-collection.test.js
//
// TWO KINDS OF CONFIGURATION RECORD, ONE COLLECTION, NO BLEED.
//
// The cluster is at its 500-collection cap, so the milestone library lives in
// `merchandising_tna_reason_codes` beside the reason codes — as a Mongoose
// discriminator on `kind`, which every existing document already carries. See
// `models/CMS_Models/Merchandising/TnaConfiguration.js` for why that key and
// why reason codes are not themselves a discriminator.
//
// Sharing a collection is only safe if it is invisible from both sides. What
// this proves:
//
//   1  reason codes read, write and validate exactly as before, and a milestone
//      can never be returned as one — however the query is written;
//   2  a milestone is never returned as a reason code, and the reason-code
//      service cannot reach one;
//   3  the collection's EXISTING unique index gives company-scoped
//      milestone-code uniqueness, with no new index for it;
//   4  the one new index — normalised milestone name, partial — constrains
//      milestones only and leaves every reason code alone;
//   5  a reason code and a milestone may share a code, because they are
//      different kinds of thing;
//   6  company isolation holds for both.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const { TnaReasonCode } = require("../../models/CMS_Models/Merchandising/TnaPlan");
const {
  TnaConfiguration, CONFIG_KIND, TNA_CONFIG_COLLECTION,
} = require("../../models/CMS_Models/Merchandising/TnaConfiguration");
const {
  TnaMilestoneDefinition,
} = require("../../models/CMS_Models/Merchandising/TnaMilestoneDefinition");
const library = require("../../services/merchandising/tnaMilestoneLibrary.service");
const config = require("../../services/merchandising/tnaConfig.service");

let companyId;
const ctx = () => ({ companyId, actor: { name: "Configurer" } });

const milestone = (over = {}) => ({
  milestoneCode: "MATERIALS_OK",
  name: "Materials approved",
  category: "MATERIALS", stage: "ORDER_EXECUTION",
  ownerDepartment: "MERCHANDISING", completionMethod: "SYSTEM_EVENT",
  systemEventKey: "merchandising.material_trim_card.approved",
  ...over,
});

beforeEach(async () => {
  companyId = (await Acc_Company.create({
    companyName: "GRAV Demo", booksFromDate: new Date("2026-04-01"),
  }))._id;
});

/* ═══ 1 · ONE COLLECTION ═══════════════════════════════════════════════════ */

test("both kinds really are in the one collection, and no other was created", async () => {
  await config.upsertReasonCode(ctx(), {
    body: { code: "SUPPLIER_LATE", label: "Supplier delivered late", kind: "RESCHEDULE" },
  });
  await library.createDefinition(ctx(), milestone());

  const names = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
  expect(names).toContain(TNA_CONFIG_COLLECTION);
  /* The collection the cap would not allow. */
  expect(names).not.toContain("merchandising_tna_milestone_definitions");

  const raw = await mongoose.connection.db.collection(TNA_CONFIG_COLLECTION)
    .find({ companyId }).sort({ kind: 1 }).toArray();
  expect(raw.map((d) => d.kind)).toEqual(["MILESTONE", "RESCHEDULE"]);
});

/* ═══ 2 · REASON CODES ARE UNTOUCHED ═══════════════════════════════════════ */

describe("existing reason-code configuration works exactly as before", () => {
  test("both kinds write, read back and keep their shape", async () => {
    for (const [code, label, kind] of [
      ["SUPPLIER_LATE", "Supplier delivered late", "RESCHEDULE"],
      ["AWAITING_APPROVAL", "Waiting on an approval", "BLOCK"],
    ]) {
      await config.upsertReasonCode(ctx(), { body: { code, label, kind } });
    }
    const all = await config.listReasonCodes(ctx(), {});
    expect(all.reasonCodes.map((r) => r.code).sort())
      .toEqual(["AWAITING_APPROVAL", "SUPPLIER_LATE"]);

    /* Filtered by kind, as the reschedule and block dialogs each do. */
    const onlyBlocks = await config.listReasonCodes(ctx(), { kind: "BLOCK" });
    expect(onlyBlocks.reasonCodes.map((r) => r.code)).toEqual(["AWAITING_APPROVAL"]);

    const doc = await mongoose.connection.db.collection(TNA_CONFIG_COLLECTION)
      .findOne({ companyId, code: "SUPPLIER_LATE" });
    /* The document shape it has always had: no milestone field arrived with it. */
    expect(Object.keys(doc).sort()).toEqual([
      "__v", "_id", "code", "companyId", "createdAt", "isActive", "kind", "label", "updatedAt",
    ]);
  });

  test("a reason code still refuses a kind that is not one", async () => {
    await expect(config.upsertReasonCode(ctx(), {
      body: { code: "NOPE", label: "Not a reason", kind: CONFIG_KIND.MILESTONE },
    })).rejects.toThrow();
  });

  test("a milestone is never returned as a reason code", async () => {
    await library.createDefinition(ctx(), milestone());
    expect((await config.listReasonCodes(ctx(), {})).reasonCodes).toEqual([]);
    expect(await TnaReasonCode.countDocuments({ companyId })).toBe(0);
    expect(await TnaReasonCode.findOne({ companyId, code: "MATERIALS_OK" })).toBeNull();
  });

  test("even asked for by name, the milestone kind cannot be read through reason codes", async () => {
    await library.createDefinition(ctx(), milestone());
    /* The guard is `$and`-ed with whatever the caller asked, so a narrower
       request still wins and a wider one cannot widen past the two kinds. */
    expect(await TnaReasonCode.find({ companyId, kind: CONFIG_KIND.MILESTONE })).toEqual([]);
    expect(await TnaReasonCode.find({
      companyId, kind: { $in: ["BLOCK", "RESCHEDULE", "MILESTONE"] },
    })).toEqual([]);
    expect(await TnaReasonCode.distinct("kind", { companyId })).toEqual([]);
  });

  test("a reason-code write can never touch a milestone", async () => {
    const made = await library.createDefinition(ctx(), milestone());
    await TnaReasonCode.updateMany({ companyId }, { $set: { label: "Overwritten" } });
    await TnaReasonCode.deleteMany({ companyId });

    const still = await TnaMilestoneDefinition.findOne({ companyId }).lean();
    expect(still.name).toBe(made.name);
    expect(still.label).toBeUndefined();
  });
});

/* ═══ 3 · MILESTONES ARE UNTOUCHED FROM THE OTHER SIDE ═════════════════════ */

describe("the milestone library cannot see reason codes", () => {
  test("a list of milestones holds no reason code", async () => {
    await config.upsertReasonCode(ctx(), {
      body: { code: "SUPPLIER_LATE", label: "Supplier delivered late", kind: "RESCHEDULE" },
    });
    await library.createDefinition(ctx(), milestone());

    const listed = await library.listDefinitions(ctx());
    expect(listed.milestones.map((m) => m.milestoneCode)).toEqual(["MATERIALS_OK"]);
    expect(await TnaMilestoneDefinition.countDocuments({ companyId })).toBe(1);
  });

  test("a template cannot place a reason code as though it were a milestone", async () => {
    await config.upsertReasonCode(ctx(), {
      body: { code: "SUPPLIER_LATE", label: "Supplier delivered late", kind: "RESCHEDULE" },
    });
    await library.createDefinition(ctx(), milestone());
    const { template } = await config.createTemplate(ctx(), { body: { name: "Order T&A" } });

    await expect(config.createVersion(ctx(), {
      templateId: template.id,
      body: {
        effectiveFrom: "2026-01-01",
        milestones: [{ milestoneCode: "SUPPLIER_LATE", anchor: "PLAN_START" }],
      },
    })).rejects.toMatchObject({ code: "TNA_MILESTONE_NOT_IN_LIBRARY" });
  });
});

/* ═══ 4 · THE INDEXES ══════════════════════════════════════════════════════ */

describe("uniqueness, and which index provides it", () => {
  test("the collection's EXISTING index is what makes a milestone code unique", async () => {
    const indexes = await mongoose.connection.db.collection(TNA_CONFIG_COLLECTION).indexes();
    const shared = indexes.find((ix) => ix.unique
      && JSON.stringify(ix.key) === JSON.stringify({ companyId: 1, code: 1, kind: 1 }));
    /* It predates the milestone library. Nothing had to be built for this. */
    expect(shared).toBeDefined();
    expect(shared.partialFilterExpression).toBeUndefined();

    await library.createDefinition(ctx(), milestone());
    await expect(library.createDefinition(ctx(), milestone({ name: "A different name" })))
      .rejects.toMatchObject({ code: "TNA_MILESTONE_EXISTS" });
  });

  test("the ONE new index constrains milestone names and nothing else", async () => {
    const indexes = await mongoose.connection.db.collection(TNA_CONFIG_COLLECTION).indexes();
    const nameIx = indexes.find((ix) => ix.name === "tna_milestone_name_unique");
    expect(nameIx).toMatchObject({
      unique: true,
      key: { companyId: 1, nameKey: 1 },
      partialFilterExpression: { kind: CONFIG_KIND.MILESTONE },
    });
  });

  test("so many reason codes, none of which has a nameKey, do not collide", async () => {
    /* Without the partial filter every one of these is `{companyId, null}` and
       the second insert fails. This is the whole reason the filter is there. */
    for (const code of ["A_LATE", "B_LATE", "C_LATE"]) {
      await config.upsertReasonCode(ctx(), {
        body: { code, label: `Reason ${code}`, kind: "RESCHEDULE" },
      });
    }
    expect((await config.listReasonCodes(ctx(), {})).reasonCodes).toHaveLength(3);
  });

  test("a reason code and a milestone may share a code — they are different things", async () => {
    await config.upsertReasonCode(ctx(), {
      body: { code: "MATERIALS_OK", label: "Materials were fine", kind: "BLOCK" },
    });
    const made = await library.createDefinition(ctx(), milestone());
    expect(made.milestoneCode).toBe("MATERIALS_OK");
    /* Both exist, told apart by kind — which is what the shared index keys on. */
    expect(await mongoose.connection.db.collection(TNA_CONFIG_COLLECTION)
      .countDocuments({ companyId, code: "MATERIALS_OK" })).toBe(2);
  });
});

/* ═══ 5 · COMPANY ISOLATION, ON ONE COLLECTION ═════════════════════════════ */

test("neither kind leaks between companies", async () => {
  await config.upsertReasonCode(ctx(), {
    body: { code: "SUPPLIER_LATE", label: "Supplier delivered late", kind: "RESCHEDULE" },
  });
  await library.createDefinition(ctx(), milestone());

  const other = (await Acc_Company.create({
    companyName: "Other Co", booksFromDate: new Date("2026-04-01"),
  }))._id;
  const theirs = { companyId: other, actor: { name: "Them" } };

  expect((await library.listDefinitions(theirs)).milestones).toEqual([]);
  expect((await config.listReasonCodes(theirs, {})).reasonCodes).toEqual([]);

  /* And the same code is free for them, in both kinds. */
  await library.createDefinition(theirs, milestone());
  await config.upsertReasonCode(theirs, {
    body: { code: "SUPPLIER_LATE", label: "Supplier delivered late", kind: "RESCHEDULE" },
  });
  expect(await TnaConfiguration.countDocuments({})).toBe(4);
});
