// test/crm/sales-journey.test.js
//
// Focused tests for the Sales Journey foundation: safe reference generation,
// schema defaults and validation, the Activity link, and the server-side
// commercial visibility rule.
//
// These exercise the MODEL and SERVICES directly rather than booting Express —
// which is what every other suite in test/crm does, and what the in-memory
// Mongo setup supports. Route-level concerns that are pure request plumbing
// (auth headers, the approval 202) are verified in the browser instead; the
// rules worth pinning here are the ones a future edit could silently break.
"use strict";

const mongoose = require("mongoose");

const Account = require("../../models/CMS_Models/Sales/Account");
const Contact = require("../../models/CMS_Models/Sales/Contact");
const Activity = require("../../models/CMS_Models/Sales/Activity");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const { nextJourneyRef, createWithRef, _resetSequence } = require("../../services/salesJourneyRef");
const { canViewCredit, stripJourneyCommercial, stripJourneyCommercialList } = require("../../services/crmVisibility");
const { SALES_JOURNEY_LINK_MODULE, SALES_JOURNEY_STAGE_CODES } = require("../../constants/crm");

const YEAR = new Date().getFullYear();

/** The minimum a Journey needs to save. */
const journeyPayload = (accountId, over = {}) => ({
  name: "MetroCare Uniform Program — 2026 Refresh",
  accountId,
  businessType: "uniform",
  ownerId: new mongoose.Types.ObjectId(),
  ownerName: "Anita Rao",
  ...over,
});

describe("journey reference generation", () => {
  test("allocates SJ-YYYY-0001 first, then increments", async () => {
    await _resetSequence(YEAR);
    expect(await nextJourneyRef(YEAR)).toBe(`SJ-${YEAR}-0001`);
    expect(await nextJourneyRef(YEAR)).toBe(`SJ-${YEAR}-0002`);
    expect(await nextJourneyRef(YEAR)).toBe(`SJ-${YEAR}-0003`);
  });

  test("concurrent allocations never collide", async () => {
    await _resetSequence(YEAR);
    const refs = await Promise.all(Array.from({ length: 25 }, () => nextJourneyRef(YEAR)));
    expect(new Set(refs).size).toBe(25);
  });

  test("concurrent CREATES all persist with distinct references", async () => {
    await _resetSequence(YEAR);
    const acc = await Account.create({ companyName: "Concurrent Co" });
    const made = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createWithRef(SalesJourney, journeyPayload(acc._id, { name: `Journey ${i}` })),
      ),
    );
    const refs = made.map((j) => j.journeyId);
    expect(new Set(refs).size).toBe(10);
    expect(await SalesJourney.countDocuments()).toBe(10);
  });

  test("sequences are scoped per year", async () => {
    await _resetSequence(2031);
    await _resetSequence(2032);
    expect(await nextJourneyRef(2031)).toBe("SJ-2031-0001");
    expect(await nextJourneyRef(2032)).toBe("SJ-2032-0001");
  });

  test("the reference is immutable once written", async () => {
    await _resetSequence(YEAR);
    const acc = await Account.create({ companyName: "Immutable Co" });
    const j = await createWithRef(SalesJourney, journeyPayload(acc._id));
    const original = j.journeyId;
    j.journeyId = "SJ-1999-9999";
    await j.save();
    const reread = await SalesJourney.findById(j._id).lean();
    expect(reread.journeyId).toBe(original);
  });
});

describe("journey schema defaults and validation", () => {
  test("a new journey starts at Enquiry, in progress, on track", async () => {
    const acc = await Account.create({ companyName: "Defaults Co" });
    const j = await createWithRef(SalesJourney, journeyPayload(acc._id));

    // "account" is no longer a stage — Enquiry is the first stage now.
    expect(j.currentStage).toBe("enquiry");
    expect(j.risk).toBe("onTrack");
    expect(j.stageStates.enquiry).toBe("inProgress");
    expect(j.stageStates.enquiry).not.toBe("complete");
    // The legacy "account" state still exists in the schema but starts idle.
    expect(j.stageStates.account).toBe("notStarted");
  });

  test("every later stage starts notStarted, and all eight exist", async () => {
    const acc = await Account.create({ companyName: "Stages Co" });
    const j = await createWithRef(SalesJourney, journeyPayload(acc._id));

    for (const code of SALES_JOURNEY_STAGE_CODES) {
      expect(j.stageStates[code]).toBeDefined();
      // Enquiry is the one in progress on a fresh journey; everything else
      // (including the retired "account" state) is notStarted.
      if (code !== "enquiry") expect(j.stageStates[code]).toBe("notStarted");
    }
    expect(SALES_JOURNEY_STAGE_CODES).toHaveLength(8);
  });

  test("account, name, businessType and owner are required", async () => {
    const acc = await Account.create({ companyName: "Required Co" });
    await expect(createWithRef(SalesJourney, journeyPayload(acc._id, { name: undefined }))).rejects.toThrow();
    await expect(createWithRef(SalesJourney, journeyPayload(acc._id, { businessType: undefined }))).rejects.toThrow();
    await expect(createWithRef(SalesJourney, journeyPayload(acc._id, { ownerId: undefined }))).rejects.toThrow();
    await expect(createWithRef(SalesJourney, journeyPayload(undefined))).rejects.toThrow();
  });

  test("business type, stage and risk reject values outside the vocabulary", async () => {
    const acc = await Account.create({ companyName: "Enum Co" });
    await expect(
      createWithRef(SalesJourney, journeyPayload(acc._id, { businessType: "not_a_type" })),
    ).rejects.toThrow();
    await expect(
      createWithRef(SalesJourney, journeyPayload(acc._id, { currentStage: "invoicing" })),
    ).rejects.toThrow();
    await expect(
      createWithRef(SalesJourney, journeyPayload(acc._id, { risk: "on_fire" })),
    ).rejects.toThrow();
  });

  test("currentStageState and waitingOn are derived, never stored", async () => {
    const acc = await Account.create({ companyName: "Derived Co" });
    const j = await createWithRef(SalesJourney, journeyPayload(acc._id));

    expect(j.currentStageState).toBe("inProgress");
    expect(j.waitingOn).toBeNull();

    j.stageStates.enquiry = "waitingCustomer";
    await j.save();
    expect(j.currentStageState).toBe("waitingCustomer");
    expect(j.waitingOn).toBe("customer");

    j.stageStates.enquiry = "waitingInternal";
    await j.save();
    expect(j.waitingOn).toBe("internal");

    // Neither is a real column.
    const raw = await SalesJourney.collection.findOne({ _id: j._id });
    expect(raw.currentStageState).toBeUndefined();
    expect(raw.waitingOn).toBeUndefined();
  });

  test("a journey stores no copy of the customer's name", async () => {
    const acc = await Account.create({ companyName: "No Duplication Co", accountId: "ACC-9001" });
    const j = await createWithRef(SalesJourney, journeyPayload(acc._id));
    const raw = await SalesJourney.collection.findOne({ _id: j._id });

    expect(String(raw.accountId)).toBe(String(acc._id));
    expect(JSON.stringify(raw)).not.toContain("No Duplication Co");
    expect(JSON.stringify(raw)).not.toContain("ACC-9001");
  });
});

describe("activity link — the next action is a real CRMActivity", () => {
  test("a linked task points both ways and duplicates nothing", async () => {
    const acc = await Account.create({ companyName: "Linked Co" });
    const journey = await createWithRef(SalesJourney, journeyPayload(acc._id));

    const activity = await Activity.create({
      accountId: acc._id,
      activityType: "task",
      subject: "Submit revised costing for commercial approval",
      status: "planned",
      dueDate: new Date(Date.now() + 2 * 86400000),
      links: [{ module: SALES_JOURNEY_LINK_MODULE, recordId: journey._id }],
    });

    journey.currentNextActionId = activity._id;
    await journey.save();

    // Journey → Activity
    const populated = await SalesJourney.findById(journey._id).populate("currentNextActionId").lean();
    expect(populated.currentNextActionId.subject).toBe("Submit revised costing for commercial approval");

    // Activity → Journey
    const back = await Activity.findOne({
      "links.module": SALES_JOURNEY_LINK_MODULE,
      "links.recordId": journey._id,
    }).lean();
    expect(String(back._id)).toBe(String(activity._id));

    // The Journey stores a POINTER, not a second copy of the task.
    const raw = await SalesJourney.collection.findOne({ _id: journey._id });
    expect(raw.currentNextActionId).toBeDefined();
    expect(raw.subject).toBeUndefined();
    expect(raw.dueDate).toBeUndefined();
    expect(JSON.stringify(raw)).not.toContain("Submit revised costing");
  });

  test("a journey is valid with no next action at all", async () => {
    const acc = await Account.create({ companyName: "Actionless Co" });
    const j = await createWithRef(SalesJourney, journeyPayload(acc._id));
    expect(j.currentNextActionId).toBeUndefined();

    const populated = await SalesJourney.findById(j._id).populate("currentNextActionId").lean();
    expect(populated.currentNextActionId ?? null).toBeNull();
  });

  test("the linked task's overdue state stays derived on the Activity", async () => {
    const acc = await Account.create({ companyName: "Overdue Co" });
    const journey = await createWithRef(SalesJourney, journeyPayload(acc._id));
    const activity = await Activity.create({
      accountId: acc._id,
      activityType: "task",
      subject: "Chase size breakdown",
      status: "planned",
      dueDate: new Date(Date.now() - 86400000),
      links: [{ module: SALES_JOURNEY_LINK_MODULE, recordId: journey._id }],
    });
    expect(activity.isOverdue).toBe(true);
  });
});

describe("contact relationship validation", () => {
  test("a contact from another account is detectable as mismatched", async () => {
    const accA = await Account.create({ companyName: "Account A" });
    const accB = await Account.create({ companyName: "Account B" });
    const contactB = await Contact.create({ accountId: accB._id, firstName: "Mira", lastName: "Kulkarni" });

    // The rule the route enforces before it will accept the contact.
    const fetched = await Contact.findById(contactB._id).select("accountId").lean();
    expect(String(fetched.accountId)).not.toBe(String(accA._id));
    expect(String(fetched.accountId)).toBe(String(accB._id));
  });
});

describe("commercial visibility is enforced server-side", () => {
  const authorized = { role: "admin" };
  const alsoAuthorized = { role: "sales", departmentRole: "approver" };
  const unauthorized = { role: "sales" };

  test("canViewCredit admits admin/ceo and department approver/owner only", () => {
    expect(canViewCredit(authorized)).toBe(true);
    expect(canViewCredit({ role: "ceo" })).toBe(true);
    expect(canViewCredit(alsoAuthorized)).toBe(true);
    expect(canViewCredit({ role: "sales", departmentRole: "owner" })).toBe(true);
    expect(canViewCredit(unauthorized)).toBe(false);
    expect(canViewCredit({ role: "sales", departmentRole: "editor" })).toBe(false);
    expect(canViewCredit(undefined)).toBe(false);
  });

  test("expected value is REMOVED from the payload, not blanked", () => {
    const dto = { id: "SJ-2026-0001", name: "X", expectedValue: { amount: 4820000, currency: "INR" } };

    const forOwner = stripJourneyCommercial(dto, authorized);
    expect(forOwner.expectedValue.amount).toBe(4820000);

    const forViewer = stripJourneyCommercial(dto, unauthorized);
    expect("expectedValue" in forViewer).toBe(false);
    // The number must not survive anywhere in the serialized response.
    expect(JSON.stringify(forViewer)).not.toContain("4820000");
  });

  test("stripping never mutates the source object", () => {
    const dto = { id: "SJ-2026-0002", expectedValue: { amount: 100, currency: "USD" } };
    stripJourneyCommercial(dto, unauthorized);
    expect(dto.expectedValue.amount).toBe(100);
  });

  test("list stripping covers every row", () => {
    const rows = [
      { id: "A", expectedValue: { amount: 1 } },
      { id: "B", expectedValue: { amount: 2 } },
    ];
    const stripped = stripJourneyCommercialList(rows, unauthorized);
    expect(stripped.every((r) => !("expectedValue" in r))).toBe(true);
    expect(stripJourneyCommercialList(rows, authorized).every((r) => "expectedValue" in r)).toBe(true);
  });
});

describe("query shapes the Hub depends on", () => {
  test("journeys are findable by account, owner, stage and risk", async () => {
    const accA = await Account.create({ companyName: "Filter A" });
    const accB = await Account.create({ companyName: "Filter B" });
    const mine = new mongoose.Types.ObjectId();
    const theirs = new mongoose.Types.ObjectId();

    // New journeys default to "enquiry"; set distinct stages so the stage
    // filter is a real test (not just the default on every row).
    await createWithRef(SalesJourney, journeyPayload(accA._id, { ownerId: mine, name: "Mine A", currentStage: "styleSample" }));
    await createWithRef(SalesJourney, journeyPayload(accA._id, { ownerId: theirs, name: "Theirs A", risk: "atRisk", currentStage: "costQuote" }));
    await createWithRef(SalesJourney, journeyPayload(accB._id, { ownerId: mine, name: "Mine B", currentStage: "enquiry" }));

    expect(await SalesJourney.countDocuments({ isActive: true, accountId: accA._id })).toBe(2);
    expect(await SalesJourney.countDocuments({ isActive: true, ownerId: mine })).toBe(2);
    expect(await SalesJourney.countDocuments({ isActive: true, currentStage: "enquiry" })).toBe(1);
    expect(await SalesJourney.countDocuments({ isActive: true, risk: "atRisk" })).toBe(1);
  });

  test("a current-stage-state filter matches the CURRENT stage only", async () => {
    const acc = await Account.create({ companyName: "State Co" });
    const j = await createWithRef(SalesJourney, journeyPayload(acc._id));

    // Waiting on the customer at Enquiry (the first stage).
    j.stageStates.enquiry = "waitingCustomer";
    await j.save();
    expect(
      await SalesJourney.countDocuments({ currentStage: "enquiry", "stageStates.enquiry": "waitingCustomer" }),
    ).toBe(1);

    // A later stage carrying the same value must NOT match while the journey
    // is still on Enquiry — otherwise the Hub's status filter lies.
    const j2 = await createWithRef(SalesJourney, journeyPayload(acc._id, { name: "Other" }));
    j2.stageStates.shipment = "waitingCustomer";
    await j2.save();
    expect(
      await SalesJourney.countDocuments({ currentStage: "enquiry", "stageStates.enquiry": "waitingCustomer" }),
    ).toBe(1);
  });

  test("archived journeys drop out of the active list", async () => {
    const acc = await Account.create({ companyName: "Archive Co" });
    const j = await createWithRef(SalesJourney, journeyPayload(acc._id));
    expect(await SalesJourney.countDocuments({ isActive: true })).toBe(1);

    j.isActive = false;
    j.archivedAt = new Date();
    await j.save();
    expect(await SalesJourney.countDocuments({ isActive: true })).toBe(0);
  });

  test("detail is addressable by the human reference", async () => {
    const acc = await Account.create({ companyName: "Reference Co" });
    const j = await createWithRef(SalesJourney, journeyPayload(acc._id));
    const found = await SalesJourney.findOne({ journeyId: j.journeyId, isActive: true }).lean();
    expect(found).toBeTruthy();
    expect(String(found._id)).toBe(String(j._id));
  });
});
