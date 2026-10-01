// test/merchandising/tna-source-event-integration.test.js
//
// A MILESTONE THAT NOTHING CAN EVER CLOSE.
//
// A `SOURCE_EVENT` milestone cannot be completed by hand — that is the point
// of it — so one whose event no application publishes is unreachable: nobody
// may tick it and nothing will ever arrive. Until now a template could name
// any string at all and publish happily, and the 27 Sep audit found most
// source-owned milestones in exactly that state, counted as ordinary work
// somebody had failed to do.
//
// What this proves, against the real services and a real database:
//
//   1  the two authoritative Merchandising moments now close their milestones
//      — minutes ISSUED, and a pack SUBMITTED — and neither closes on a draft;
//   2  replaying either event changes nothing;
//   3  neither crosses a company or an execution file;
//   4  a missing milestone does not roll back the source operation;
//   5  publishing refuses a source event nothing will ever publish, and names
//      each offender;
//   6  a plan already running on a legacy template keeps its milestones, shows
//      them as not integrated, and keeps them out of every alarm figure.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const {
  TnaPlan, TnaMilestone, MILESTONE_STATUS,
} = require("../../models/CMS_Models/Merchandising/TnaPlan");
const {
  MerchandisingOutboxEvent, MerchandisingIntakeLedger, OUTBOX_KIND,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const { TnaTemplate, TnaTemplateVersion } = require("../../models/CMS_Models/Merchandising/TnaTemplate");
const {
  WorkingCalendar, WorkingCalendarVersion,
} = require("../../models/CMS_Models/Merchandising/WorkingCalendar");
const intake = require("../../services/merchandising/tnaIntake.service");
const registry = require("../../services/merchandising/tnaSourceEvents.js");
const portfolio = require("../../services/merchandising/tnaPortfolio.service");
const starterSeed = require("../../scripts/readiness/seed-tna-starter.js");
const milestoneLibrary = require("../../services/merchandising/tnaMilestoneLibrary.service");

let companyId;
let otherCompanyId;
let seq = 0;
const ctx = () => ({ companyId, role: { canRead: true, canConfigure: true, canExecute: true } });

beforeEach(async () => {
  companyId = (await Acc_Company.create({
    companyName: "GRAV Demo", booksFromDate: new Date("2026-04-01"),
  }))._id;
  otherCompanyId = (await Acc_Company.create({
    companyName: "Other Co", booksFromDate: new Date("2026-04-01"),
  }))._id;
});

/** A file with a plan, and whichever milestones the test needs on it. */
async function planWith(milestones, { company = null } = {}) {
  const co = company || companyId;
  const n = ++seq;
  const file = await ExecutionFile.create({
    companyId: co, fileNumber: `MEF-T-${n}`,
    handoverRef: `ORD-${n}`, handoverLineRef: `LN-${n}`,
    currentHandoverVersionId: new mongoose.Types.ObjectId(),
    lifecycleStatus: "OPEN",
    currentExecutionProjection: {
      orderRef: `ORD-${n}`, orderLineRef: `LN-${n}`,
      styleRef: `ST-${n}`, productName: "Polo",
      totalQuantity: 100,
      deliveries: [{ dropRef: "D1", committedDeliveryDate: "2026-11-20", quantity: 100 }],
    },
  });
  /* A plan pins the template and calendar version it was built on, and the
     services re-read both to repropagate dates — so the fixture creates real
     ones rather than dangling ids. */
  const calendar = await WorkingCalendar.create({
    companyId: co, calendarRef: `CAL-${n}`, name: `Cal ${n}`, timezone: "Asia/Kolkata",
  });
  const calendarVersion = await WorkingCalendarVersion.create({
    companyId: co, calendarId: calendar._id, versionNo: 1, state: "PUBLISHED",
    weekPattern: [true, true, true, true, true, false, false],
    effectiveFrom: "2026-01-01", horizonTo: "2030-12-31",
  });
  const template = await TnaTemplate.create({ companyId: co, templateRef: `TPL-${n}`, name: `Tpl ${n}` });
  const templateVersion = await TnaTemplateVersion.create({
    companyId: co, templateId: template._id, versionNo: 1, state: "PUBLISHED",
    effectiveFrom: "2026-01-01",
    defaultCalendarId: calendar._id,
    milestones: milestones.map((m) => ({
      milestoneCode: m.ref, name: m.name || m.ref,
      ownerDepartment: m.owner || "MERCHANDISING",
      completionAuthority: m.authority || "SOURCE_EVENT",
      sourceEventKinds: m.kinds || [],
      anchor: "PLAN_START", offsetWorkingDays: 5, scope: "FILE",
    })),
    dependencies: [],
  });
  const plan = await TnaPlan.create({
    companyId: co, fileId: file._id,
    templateId: template._id,
    templateVersionId: templateVersion._id,
    templateVersionNo: 1,
    calendarId: calendar._id,
    calendarVersionId: calendarVersion._id,
    calendarVersionNo: 1,
    timezone: "Asia/Kolkata",
    state: "ACTIVE",
    planStartDate: "2026-09-01",
  });
  const made = [];
  for (const m of milestones) {
    made.push(await TnaMilestone.create({
      companyId: co, planId: plan._id, fileId: file._id,
      milestoneRef: m.ref, milestoneCode: m.ref, name: m.name || m.ref,
      ownerDepartment: m.owner || "MERCHANDISING",
      completionAuthority: m.authority || "SOURCE_EVENT",
      sourceEventKinds: m.kinds || [],
      forecastDate: m.forecastDate || "2026-09-20",
      status: m.status || MILESTONE_STATUS.PENDING,
    }));
  }
  return { file, plan, milestones: made };
}

/** Publish one outbox event, exactly as a producer does. */
const publish = (kind, payload, { company = null } = {}) => MerchandisingOutboxEvent.create({
  companyId: company || companyId, kind, payload,
  correlationId: new mongoose.Types.ObjectId().toString(),
});

const reload = (ref, co = null) =>
  TnaMilestone.findOne({ companyId: co || companyId, milestoneRef: ref }).lean();

/* ══ 1 — THE PRE-PRODUCTION MEETING ══════════════════════════════════════ */

describe("issuing pre-production minutes closes the milestone waiting for them", () => {
  test("a draft, a save and a conducted meeting publish nothing T&A listens for", () => {
    /* The service emits exactly one outbox kind, on exactly one command. A
       meeting that is drafted, scheduled, saved or even conducted is
       Merchandising's working state — the minutes are the evidence. */
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "..", "services", "merchandising",
        "preProductionMeeting.service.js"), "utf8");
    const emissions = src.match(/MerchandisingOutboxEvent\.create/g) || [];
    expect(emissions).toHaveLength(1);
    const issueBody = src.slice(src.indexOf("async function issue("));
    expect(issueBody).toContain("MerchandisingOutboxEvent.create");
    expect(issueBody.indexOf("MerchandisingOutboxEvent.create"))
      .toBeLessThan(issueBody.indexOf("async function cancelDraft("));
  });

  test("the issued event closes only the matching milestone on that order", async () => {
    const mine = await planWith([
      { ref: "PPM_HELD", kinds: [OUTBOX_KIND.PPM_ISSUED] },
      { ref: "TRIM", kinds: [OUTBOX_KIND.MATERIAL_TRIM_APPROVED] },
    ]);
    /* A milestone with the SAME name on another order must not move. */
    const other = await planWith([{ ref: "PPM_HELD", kinds: [OUTBOX_KIND.PPM_ISSUED] }]);

    const event = await publish(OUTBOX_KIND.PPM_ISSUED, {
      executionFileId: mine.file._id, ppmId: new mongoose.Types.ObjectId(),
      ppmRef: "PPM-1", versionNo: 1, effectiveDate: "2026-09-18",
    });
    const out = await intake.receive(event.toObject());
    expect(out.applied).toBe(true);
    expect(out.closed).toEqual(["PPM_HELD"]);

    const closed = await TnaMilestone.findById(mine.milestones[0]._id).lean();
    expect(closed.status).toBe(MILESTONE_STATUS.COMPLETED);
    /* The date the meeting was HELD, which the producer stated. */
    expect(closed.actualDate).toBe("2026-09-18");
    /* Traceable back to the minutes, not to M4's revision shape. */
    expect(closed.completion.sourceEventKind).toBe(OUTBOX_KIND.PPM_ISSUED);
    expect(closed.completion.sourceRecordRef).toBe("PPM-1");
    expect(closed.completion.sourceRecordVersion).toBe(1);
    /* Nobody completed it. A record did. */
    expect(closed.completion.actor?.name).toBeFalsy();

    /* Neither the sibling nor the same-named milestone on another order
       CLOSED. Their status may have been recomputed by the repropagation
       that a real closure triggers — that is the plan doing its job — so
       what is asserted is the thing the event must not have done. */
    const sibling = await TnaMilestone.findById(mine.milestones[1]._id).lean();
    expect(sibling.actualDate).toBeFalsy();
    expect(sibling.status).not.toBe(MILESTONE_STATUS.COMPLETED);
    const elsewhere = await TnaMilestone.findById(other.milestones[0]._id).lean();
    expect(elsewhere.actualDate).toBeFalsy();
    expect(elsewhere.status).not.toBe(MILESTONE_STATUS.COMPLETED);
  });

  test("replaying the same event changes nothing and is not an error", async () => {
    const w = await planWith([{ ref: "PPM_HELD", kinds: [OUTBOX_KIND.PPM_ISSUED] }]);
    const event = await publish(OUTBOX_KIND.PPM_ISSUED, {
      executionFileId: w.file._id, ppmId: new mongoose.Types.ObjectId(),
      ppmRef: "PPM-1", versionNo: 1, effectiveDate: "2026-09-18",
    });
    await intake.receive(event.toObject());
    const again = await intake.receive(event.toObject());
    expect(again.duplicate).toBe(true);
    expect(again.applied).toBe(false);

    expect(await MerchandisingIntakeLedger.countDocuments({ sourceEventId: event._id })).toBe(1);
    const m = await reload("PPM_HELD");
    expect(m.actualDate).toBe("2026-09-18");
    expect(m.status).toBe(MILESTONE_STATUS.COMPLETED);
    /* Closed once: one completion record, not a second one written over it. */
    expect(m.completion.sourceEventId.toString()).toBe(event._id.toString());
    expect(await MerchandisingIntakeLedger.countDocuments({})).toBe(1);
  });

  test("an event cannot reach another company's plan", async () => {
    const theirs = await planWith(
      [{ ref: "PPM_HELD", kinds: [OUTBOX_KIND.PPM_ISSUED] }],
      { company: otherCompanyId },
    );
    /* This company's event, naming THEIR file. */
    const event = await publish(OUTBOX_KIND.PPM_ISSUED, {
      executionFileId: theirs.file._id, ppmId: new mongoose.Types.ObjectId(),
      ppmRef: "PPM-X", versionNo: 1,
    });
    const out = await intake.receive(event.toObject());
    expect(out.applied).toBe(false);
    expect(out.outcome).toBe("NOOP");
    expect((await reload("PPM_HELD", otherCompanyId)).status).toBe(MILESTONE_STATUS.PENDING);
  });

  test("a plan with no matching milestone is a NOOP, not a failure", async () => {
    const w = await planWith([{ ref: "TRIM", kinds: [OUTBOX_KIND.MATERIAL_TRIM_APPROVED] }]);
    const event = await publish(OUTBOX_KIND.PPM_ISSUED, {
      executionFileId: w.file._id, ppmId: new mongoose.Types.ObjectId(),
      ppmRef: "PPM-1", versionNo: 1,
    });
    const out = await intake.receive(event.toObject());
    /* Recorded as delivered. A failure would be retried for ever against a
       plan that will never accept it — and would be reported to a person who
       had just issued perfectly good minutes. */
    expect(out.outcome).toBe("NOOP");
    expect(out.applied).toBe(false);
    expect(await MerchandisingIntakeLedger.countDocuments({ sourceEventId: event._id })).toBe(1);
  });
});

/* ══ 2 — THE EXECUTION PACK ══════════════════════════════════════════════ */

describe("submitting the execution pack closes the milestone waiting for it", () => {
  test("T&A consumes the pack's OWN event, not a second one written for it", () => {
    /* The pack already announced itself to PPC. A second announcement would
       be a second version of one fact. */
    expect(intake.CONSUMED_KINDS).toContain(OUTBOX_KIND.PACK_SUBMITTED);
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "..", "services", "merchandising",
        "executionPack.service.js"), "utf8");
    expect((src.match(/OUTBOX_KIND\.PACK_SUBMITTED/g) || []).length).toBeGreaterThan(0);
  });

  test("submission closes only the matching milestone on that order", async () => {
    const mine = await planWith([{ ref: "PACK_OUT", kinds: [OUTBOX_KIND.PACK_SUBMITTED] }]);
    const other = await planWith([{ ref: "PACK_OUT", kinds: [OUTBOX_KIND.PACK_SUBMITTED] }]);
    const packId = new mongoose.Types.ObjectId();

    const event = await publish(OUTBOX_KIND.PACK_SUBMITTED, {
      executionFileId: mine.file._id, packId, packVersionNo: 2,
    });
    const out = await intake.receive(event.toObject());
    expect(out.applied).toBe(true);

    const closed = await reload("PACK_OUT");
    expect(closed.status).toBe(MILESTONE_STATUS.COMPLETED);
    expect(closed.completion.sourceEventKind).toBe(OUTBOX_KIND.PACK_SUBMITTED);
    expect(closed.completion.sourceRecordRef).toBe(String(packId));
    expect(closed.completion.sourceRecordVersion).toBe(2);

    expect((await TnaMilestone.findById(other.milestones[0]._id).lean()).status)
      .toBe(MILESTONE_STATUS.PENDING);
  });

  test("replaying a submission is idempotent", async () => {
    const w = await planWith([{ ref: "PACK_OUT", kinds: [OUTBOX_KIND.PACK_SUBMITTED] }]);
    const event = await publish(OUTBOX_KIND.PACK_SUBMITTED, {
      executionFileId: w.file._id, packId: new mongoose.Types.ObjectId(), packVersionNo: 1,
    });
    await intake.receive(event.toObject());
    const before = await reload("PACK_OUT");
    const again = await intake.receive(event.toObject());
    expect(again.duplicate).toBe(true);
    const after = await reload("PACK_OUT");
    /* Nothing moved on the second delivery. */
    expect(after.revision).toBe(before.revision);
    expect(after.actualDate).toBe(before.actualDate);
    expect(await MerchandisingIntakeLedger.countDocuments({})).toBe(1);
  });

  test("a draft pack publishes nothing — only the submitted kind is consumed", () => {
    /* `PACK_SUBMITTED` is the only pack kind T&A listens for. Preparing,
       saving or withdrawing a pack cannot close a milestone. */
    expect(intake.CONSUMED_KINDS).not.toContain(OUTBOX_KIND.PACK_SUPERSEDED);
    expect(intake.CONSUMED_KINDS).not.toContain(OUTBOX_KIND.PACK_WITHDRAWN);
  });
});

/* ══ 3 — THE REGISTRY, AND WHAT A TEMPLATE MAY ASK FOR ═══════════════════ */

describe("a template cannot promise an integration that does not exist", () => {
  test("there is one registry, and the consumer derives its list from it", () => {
    expect(intake.CONSUMED_KINDS).toEqual(registry.supportedKinds());
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "..", "services", "merchandising",
        "tnaIntake.service.js"), "utf8");
    /* Not a second literal array beside the registry. */
    expect(src).toContain("sourceEvents.supportedKinds()");
  });

  test("an invented event kind is refused, and named", () => {
    const offenders = registry.unsupportedInVersion([
      { milestoneCode: "GOOD", completionAuthority: "SOURCE_EVENT",
        sourceEventKinds: [OUTBOX_KIND.PACKAGING_APPROVED] },
      { milestoneCode: "TYPO", completionAuthority: "SOURCE_EVENT",
        sourceEventKinds: ["merchandising.packaging.aproved"] },
    ]);
    expect(offenders.map((o) => o.milestoneCode)).toEqual(["TYPO"]);
    expect(offenders[0].reasons.join(" ")).toMatch(/Nothing in GRAV publishes/);
  });

  test("an empty list is refused — nothing could ever close it", () => {
    /* It used to publish, under the starter script's documented convention
       "no producer yet, so the list is DELIBERATELY EMPTY". That convention
       described the state accurately and then let a schedule commit to it.
       A milestone completed by a system action that names none is the worst
       case of all: unreachable AND unnameable, so there is not even a
       department to ask. */
    const offenders = registry.unsupportedInVersion([
      { milestoneCode: "SAMPLE_APPROVED", name: "Sample approved",
        completionAuthority: "SOURCE_EVENT", sourceEventKinds: [] },
    ]);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].reasons[0]).toMatch(/names none/);
    /* A version already published keeps it, and it still reads honestly. */
    expect(registry.milestoneIntegration({
      completionAuthority: "SOURCE_EVENT", sourceEventKinds: [],
    }).integration).toBe(registry.INTEGRATION.NOT_INTEGRATED);
  });

  test("the shipped starter template publishes, because it places only wired work", () => {
    /* The regression this gate could most easily have caused, and the reason
       the starter is now shorter than the order it describes: six of its ten
       milestones wait on an application that does not exist, so they stay on
       the company's list rather than in its first schedule. */
    const asPlaced = starterSeed.STARTER_PLACEMENTS.map((step) => {
      const def = milestoneLibrary.STARTER_LIBRARY
        .find((d) => d.milestoneCode === step.milestoneCode);
      return { ...milestoneLibrary.milestoneFacts(def) };
    });
    expect(asPlaced.length).toBeGreaterThan(0);
    expect(registry.unsupportedInVersion(asPlaced)).toEqual([]);
    expect(starterSeed.STARTER_PLACEMENTS.length)
      .toBeLessThan(starterSeed.LEGACY_STARTER_MILESTONES.length);
  });

  test("a recognised-but-unbuilt producer is refused, and names who owes it", () => {
    /* This is the reversal. A named kind with no producer used to publish and
       show as not integrated, so another department's work could at least be
       scheduled. But a schedule is a commitment, and a date nothing can ever
       satisfy is not one — so it is refused until the producer exists, and the
       message says which application owes it.

       The honest consequence, stated rather than worked around: another
       department's milestone is NOT schedulable until that department
       publishes. Offering Merchandising as the completer instead would be a
       fabrication — it cannot declare Production finished. */
    const offenders = registry.unsupportedInVersion([
      { milestoneCode: "EX_FACTORY", name: "Goods dispatched",
        completionAuthority: "SOURCE_EVENT",
        sourceEventKinds: ["source.production.ex_factory"] },
    ]);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toMatchObject({
      milestoneCode: "EX_FACTORY", owed: ["Production"],
      kinds: ["source.production.ex_factory"],
    });
  });

  test("a wired producer publishes", () => {
    expect(registry.unsupportedInVersion([
      { milestoneCode: "TRIM", completionAuthority: "SOURCE_EVENT",
        sourceEventKinds: [OUTBOX_KIND.MATERIAL_TRIM_APPROVED] },
    ])).toEqual([]);
  });

  test("a manual milestone is never an integration question", () => {
    expect(registry.milestoneIntegration({ completionAuthority: "MERCHANDISING" }).integration)
      .toBe(registry.INTEGRATION.MANUAL);
    expect(registry.unsupportedInVersion([{ completionAuthority: "MERCHANDISING" }])).toEqual([]);
  });
});

/* ══ 4 — WHAT A LEGACY PLAN LOOKS LIKE ══════════════════════════════════ */

describe("a milestone waiting on an application nobody has built", () => {
  test("is marked not integrated, and says so in one plain sentence", async () => {
    const w = await planWith([
      { ref: "EX_FACTORY", owner: "IE_PPC_PRODUCTION",
        kinds: ["source.production.ex_factory"] },
    ]);
    const plans = require("../../services/merchandising/tnaPlan.service");
    const out = await plans.listMilestones(ctx(), { fileId: String(w.file._id) });
    const row = out.rows.find((r) => r.milestoneRef === "EX_FACTORY");
    expect(row.notIntegrated).toBe(true);
    expect(row.integration).toBe(registry.INTEGRATION.NOT_INTEGRATED);
    expect(row.integrationNote)
      .toBe("This milestone cannot update automatically because its source "
        + "application is not connected yet.");
    /* And no completion control may be offered: it is source-owned. */
    expect(row.merchandisingMayComplete).toBe(false);
  });

  test("is kept out of the overdue and at-risk figures, and counted apart", async () => {
    await planWith([
      /* One real overdue milestone, and one that nothing can ever close. */
      { ref: "TRIM", kinds: [OUTBOX_KIND.MATERIAL_TRIM_APPROVED],
        status: MILESTONE_STATUS.OVERDUE },
      { ref: "EX_FACTORY", owner: "IE_PPC_PRODUCTION",
        kinds: ["source.production.ex_factory"], status: MILESTONE_STATUS.OVERDUE },
    ]);

    const { counts } = await portfolio.portfolioCounts(ctx());
    expect(counts.overdue).toBe(1);
    expect(counts["at-risk"]).toBe(1);
    /* The total is the total: it is still on the plan and still readable. */
    expect(counts.all).toBe(2);
    expect(counts["not-integrated"]).toBe(1);

    const attention = await portfolio.attention(ctx());
    expect(attention.counts.overdue).toBe(1);
    expect(attention.counts.atRisk).toBe(1);
    expect(attention.counts.notIntegrated).toBe(1);
    /* It IS waiting on another department's record — that bucket tells the
       truth about it and is deliberately not filtered. */
    expect(attention.counts.awaitingOther).toBe(2);
  });

  test("every figure still opens exactly the rows it counted", async () => {
    await planWith([
      { ref: "TRIM", kinds: [OUTBOX_KIND.MATERIAL_TRIM_APPROVED],
        status: MILESTONE_STATUS.OVERDUE },
      { ref: "EX_FACTORY", owner: "IE_PPC_PRODUCTION",
        kinds: ["source.production.ex_factory"], status: MILESTONE_STATUS.OVERDUE },
    ]);
    const { counts } = await portfolio.portfolioCounts(ctx());
    for (const view of ["overdue", "at-risk", "not-integrated", "all"]) {
      const key = view === "at-risk" ? "at-risk" : view;
      const page = await portfolio.portfolio(ctx(), { view, limit: 100 });
      expect({ [view]: page.rows.length }).toEqual({ [view]: counts[key] });
    }
  });
});
