// test/merchandising/tna-milestone-library-report.test.js
//
// THE DRY-RUN RECONCILIATION REPORT.
//
// It has no `--apply`, deliberately: every line it prints is a question about
// somebody's process, and a script that answered by picking would silently merge
// two control points into one and make every report over them wrong in a way
// nobody could see.
//
// So what is tested is that it NAMES each decision, against real documents —
// including a duplicate pair that can only exist because it was written before
// the unique index did.
process.env.SALARY_ENCRYPTION_KEY = "0".repeat(64);

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const { TnaMilestoneDefinition } = require("../../models/CMS_Models/Merchandising/TnaMilestoneDefinition");
const { TnaTemplate, TnaTemplateVersion } = require("../../models/CMS_Models/Merchandising/TnaTemplate");
const report = require("../../scripts/migrations/tna-milestone-library-report.js");

test("the report names every decision a person has to take", async () => {
  const companyId = (await Acc_Company.create({ companyName: "R", booksFromDate: new Date("2026-04-01") }))._id;

  /* `code`, because that is the shared configuration collection's identity
     field — the service and every response call it `milestoneCode`. See
     `tnaMilestoneLibrary.codeOf`. */
  const mk = ({ milestoneCode, ...over }) => TnaMilestoneDefinition.create({
    code: milestoneCode,
    companyId, category: "MATERIALS", stage: "ORDER_EXECUTION",
    ownerDepartment: "MERCHANDISING", completionMethod: "SYSTEM_EVENT",
    systemEventKey: "merchandising.material_trim_card.approved", ...over,
  });
  await mk({ milestoneCode: "TRIM_CARD_APPROVED", name: "Trim card approved" });
  await mk({ milestoneCode: "FABRIC_IN_HOUSE", name: "Fabric in house",
    ownerDepartment: "STORE_SUPPLY_CHAIN", systemEventKey: "source.store.fabric_in_house" });
  // A pair from before the index existed: inserted underneath validation.
  await TnaMilestoneDefinition.collection.insertOne({
    companyId, kind: "MILESTONE",
    code: "FABRIC_IN", name: "Fabric-in-house", nameKey: "fabric in house",
    category: "MATERIALS", stage: "ORDER_EXECUTION", ownerDepartment: "STORE_SUPPLY_CHAIN",
    completionMethod: "SYSTEM_EVENT", systemEventKey: "source.store.trims_in_house", isActive: true,
  });
  // And one only the LOOSE pass catches.
  await mk({ milestoneCode: "FABRIC_HOUSE_2", name: "Fabric is in the house",
    ownerDepartment: "STORE_SUPPLY_CHAIN", systemEventKey: "source.store.trims_in_house" });
  // A development-stage entry placed on an order template, and one off-list.
  await mk({ milestoneCode: "DEV_ONLY", name: "Development sample approved",
    stage: "DEVELOPMENT", ownerDepartment: "PRODUCT_DEVELOPMENT",
    systemEventKey: "source.buyer.approval_received" });

  const tpl = await TnaTemplate.create({ companyId, templateRef: "T1", name: "Order" });
  await TnaTemplateVersion.create({
    companyId, templateId: tpl._id, versionNo: 1, state: "PUBLISHED",
    effectiveFrom: "2025-01-01", effectiveTo: null,
    milestones: [
      { milestoneCode: "STRIKE_OFF", name: "Strike-off received", ownerDepartment: "PRODUCT_DEVELOPMENT",
        completionAuthority: "SOURCE_EVENT", sourceEventKinds: [], anchor: "PLAN_START", offsetWorkingDays: 1, scope: "FILE" },
      { milestoneCode: "DEV_ONLY", name: "Development sample approved", ownerDepartment: "PRODUCT_DEVELOPMENT",
        completionAuthority: "SOURCE_EVENT", sourceEventKinds: ["source.buyer.approval_received"], anchor: "PLAN_START", offsetWorkingDays: 2, scope: "FILE" },
      { milestoneCode: "TRIM_CARD_APPROVED", name: "Trim card approved", ownerDepartment: "QUALITY",
        completionAuthority: "SOURCE_EVENT", sourceEventKinds: [], anchor: "PLAN_START", offsetWorkingDays: 3, scope: "FILE" },
    ],
    dependencies: [],
  });

  const r = await report.inspectCompany(companyId);
  /* On a published template but not on the list: a person decides whether the
     company still wants it. */
  expect(r.notOnList.map((x) => x.milestoneCode)).toEqual(["STRIKE_OFF"]);
  expect(r.wrongStage.map((x) => x.milestoneCode)).toEqual(["DEV_ONLY"]);
  expect(r.duplicateMeaning[0].codes.sort()).toEqual(["FABRIC_IN", "FABRIC_IN_HOUSE"]);
  /* Two codes, one name. The index refuses this now; these two predate it, and
     nothing merges them — the report carries the question instead. */
  expect(r.duplicateMeaning[0].question).toMatch(/Nothing is merged automatically/);
  /* And the looser pass, which the index does NOT refuse: "Fabric is in the
     house" is a different name by the index's rules and the same thing to a
     person. Reported separately, as a question rather than a finding. */
  expect(r.nearlyTheSame.length).toBe(1);
  expect(r.nearlyTheSame[0].codes).toContain("FABRIC_HOUSE_2");
  /* A step whose stored facts disagree with the list's — named field by field,
     old value and new, so a person can see which one is right. */
  expect(r.disagrees.some((d) => d.differs.some((x) => x.includes("owner QUALITY")))).toBe(true);
  expect(r.disagrees.some((d) => d.differs.some((x) => x.includes("system action")))).toBe(true);
});

test("it writes nothing, whatever it finds", async () => {
  const companyId = (await Acc_Company.create({
    companyName: "Untouched", booksFromDate: new Date("2026-04-01"),
  }))._id;
  const tpl = await TnaTemplate.create({ companyId, templateRef: "T9", name: "Order" });
  await TnaTemplateVersion.create({
    companyId, templateId: tpl._id, versionNo: 1, state: "PUBLISHED",
    effectiveFrom: "2025-01-01", effectiveTo: null,
    milestones: [{
      milestoneCode: "OFF_LIST", name: "Off the list", ownerDepartment: "QUALITY",
      completionAuthority: "SOURCE_EVENT", sourceEventKinds: [],
      anchor: "PLAN_START", offsetWorkingDays: 1, scope: "FILE",
    }],
    dependencies: [],
  });

  const before = await TnaTemplateVersion.findOne({ companyId }).lean();
  const r = await report.inspectCompany(companyId);
  expect(r.notOnList).toHaveLength(1);

  /* The report found a problem and fixed nothing: no definition invented for
     the off-list milestone, and the version untouched. */
  expect(await TnaMilestoneDefinition.countDocuments({ companyId })).toBe(0);
  expect(await TnaTemplateVersion.findOne({ companyId }).lean()).toEqual(before);
});
