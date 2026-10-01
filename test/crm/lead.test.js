// test/crm/lead.test.js
//
// Focused MODEL-level tests for Lead Chunk 1 (docs/tasks/lead-chunk-01-foundation.md):
// safe reference generation, canonical vs legacy state coexistence, and the
// CRMActivity extension for a pre-Account Lead. Route-level concerns (field
// whitelisting, the qualification-state endpoint, audit calls, auth) are in
// test/crm/lead.route.test.js, mirroring the sales-journey split.
"use strict";

const mongoose = require("mongoose");

const Lead = require("../../models/CMS_Models/Sales/Lead");
const Account = require("../../models/CMS_Models/Sales/Account");
const Activity = require("../../models/CMS_Models/Sales/Activity");
const { nextLeadRef, createWithRef, _resetSequence } = require("../../services/leadRef");
const { nextJourneyRef, _resetSequence: _resetJourneySequence } = require("../../services/salesJourneyRef");
const {
  LEAD_QUALIFICATION_STATE_CODES,
  LEAD_QUALIFICATION_TRANSITIONS,
  LEAD_QUALIFICATION_STATES,
  LEAD_QUALIFICATION_LEGACY_STATES,
  LEAD_QUALIFICATION_DISPLAY_STATE,
} = require("../../constants/crm");
const { isValidTransition, deriveLegacyStage, assertLeadConvertible } = require("../../services/leadQualification");

const YEAR = new Date().getFullYear();

const leadPayload = (over = {}) => ({
  firstName: "Asha",
  lastName: "Verma",
  company: "Northstar Buying Services",
  ...over,
});

describe("lead reference generation", () => {
  test("allocates LEAD-YYYY-0001 first, then increments", async () => {
    await _resetSequence(YEAR);
    expect(await nextLeadRef(YEAR)).toBe(`LEAD-${YEAR}-0001`);
    expect(await nextLeadRef(YEAR)).toBe(`LEAD-${YEAR}-0002`);
    expect(await nextLeadRef(YEAR)).toBe(`LEAD-${YEAR}-0003`);
  });

  test("concurrent allocations never collide", async () => {
    await _resetSequence(YEAR);
    const refs = await Promise.all(Array.from({ length: 25 }, () => nextLeadRef(YEAR)));
    expect(new Set(refs).size).toBe(25);
  });

  test("concurrent CREATES all persist with distinct references", async () => {
    await _resetSequence(YEAR);
    const made = await Promise.all(
      Array.from({ length: 10 }, (_, i) => createWithRef(Lead, leadPayload({ firstName: `Lead${i}` }))),
    );
    const refs = made.map((l) => l.leadId);
    expect(new Set(refs).size).toBe(10);
    expect(await Lead.countDocuments()).toBe(10);
  });

  test("sequences are scoped per year", async () => {
    await _resetSequence(2031);
    await _resetSequence(2032);
    expect(await nextLeadRef(2031)).toBe("LEAD-2031-0001");
    expect(await nextLeadRef(2032)).toBe("LEAD-2032-0001");
  });

  test("the reference is immutable once written", async () => {
    await _resetSequence(YEAR);
    const lead = await createWithRef(Lead, leadPayload());
    const original = lead.leadId;
    lead.leadId = "LEAD-1999-9999";
    await lead.save();
    const reread = await Lead.findById(lead._id).lean();
    expect(reread.leadId).toBe(original);
  });

  test("a Lead cannot be saved without a leadId (no auto-generating hook)", async () => {
    await expect(Lead.create(leadPayload())).rejects.toThrow();
  });

  test("regression: allocating Lead references does not disturb Journey reference sequencing", async () => {
    // Both services share services/salesJourneyRef.js's Counter model/collection
    // under disjoint keys ("lead:<year>" vs "salesJourney:<year>") — this pins
    // that sharing down, per the chunk task's requirement that reusing the
    // primitive be "covered by regression tests."
    await _resetSequence(YEAR);
    await _resetJourneySequence(YEAR);
    expect(await nextLeadRef(YEAR)).toBe(`LEAD-${YEAR}-0001`);
    expect(await nextJourneyRef(YEAR)).toBe(`SJ-${YEAR}-0001`);
    expect(await nextLeadRef(YEAR)).toBe(`LEAD-${YEAR}-0002`);
    expect(await nextJourneyRef(YEAR)).toBe(`SJ-${YEAR}-0002`);
  });
});

describe("canonical qualificationState vs legacy stage", () => {
  test("a new Lead defaults to canonical qualificationState 'new' and legacy stage 'new'", async () => {
    const lead = await createWithRef(Lead, leadPayload());
    expect(lead.qualificationState).toBe("new");
    expect(lead.stage).toBe("new");
  });

  test("qualificationState rejects a value outside the canonical vocabulary", async () => {
    await expect(
      createWithRef(Lead, leadPayload({ qualificationState: "proposal_sent" })),
    ).rejects.toThrow();
  });

  test("legacy stage values (proposal_sent/negotiation/won/lost) remain valid and readable", async () => {
    const lead = await createWithRef(Lead, leadPayload({ stage: "negotiation" }));
    expect(lead.stage).toBe("negotiation");
    const reread = await Lead.findById(lead._id).lean();
    expect(reread.stage).toBe("negotiation");
    // Unaffected by the legacy stage — the two fields are independent.
    expect(reread.qualificationState).toBe("new");
  });

  test("a pre-existing legacy-format leadId (no year segment) remains readable without migration", async () => {
    // Simulates a row created before this chunk, when leadId was
    // `LEAD-0001` (countDocuments()+1, no year). Inserted directly since the
    // schema now requires leadId at creation time.
    await Lead.collection.insertOne({
      leadId: "LEAD-0001",
      firstName: "Legacy",
      stage: "won",
      convertedToCustomer: true,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const legacy = await Lead.findOne({ leadId: "LEAD-0001" }).lean();
    expect(legacy.stage).toBe("won");
    expect(legacy.qualificationState).toBeUndefined(); // never backfilled — no migration ran
  });

  test("the canonical vocabulary matches the chunk spec exactly", () => {
    expect(LEAD_QUALIFICATION_STATE_CODES).toEqual([
      "new", "contactAttempted", "contacted", "qualified", "readyToConvert", "nurture", "disqualified", "duplicate", "converted",
    ]);
  });

  test("user-facing labels describe the REQUIREMENT lifecycle (stored codes unchanged)", () => {
    /* A Lead exists because a Prospect converted, and a Prospect only converts
       on a successful interaction with a confirmed interest signal. So the
       Lead no longer restarts a contact funnel it has already completed — the
       same codes are relabelled around the only open question at this stage:
       what does this customer actually want? */
    const label = Object.fromEntries(LEAD_QUALIFICATION_STATES.map((s) => [s.code, s.label]));
    expect(label.new).toBe("Interest Confirmed");
    expect(label.qualified).toBe("Requirement Captured");
    expect(label.readyToConvert).toBe("Enquiry Ready");
    expect(label.converted).toBe("Enquiry Raised");
    // Side outcomes, not forward stages.
    expect(label.nurture).toBe("Nurture");
    expect(label.disqualified).toBe("Disqualified");
    expect(label.duplicate).toBe("Duplicate");
    // The two contact states are kept readable, and marked for what they are.
    expect(label.contactAttempted).toMatch(/legacy/i);
    expect(label.contacted).toMatch(/legacy/i);
  });

  test("the legacy states are named as legacy and shown at Interest Confirmed", () => {
    expect([...LEAD_QUALIFICATION_LEGACY_STATES].sort()).toEqual(["contactAttempted", "contacted"]);
    expect(LEAD_QUALIFICATION_DISPLAY_STATE.contactAttempted).toBe("new");
    expect(LEAD_QUALIFICATION_DISPLAY_STATE.contacted).toBe("new");
    // and no CURRENT state is displaced to somewhere else
    for (const code of ["new", "qualified", "readyToConvert", "nurture", "disqualified", "duplicate", "converted"]) {
      expect(LEAD_QUALIFICATION_DISPLAY_STATE[code]).toBeUndefined();
    }
  });
});

describe("canonical transition map (review item 2) — the data structure itself", () => {
  test("matches the exact graph from the review, state by state", () => {
    expect(LEAD_QUALIFICATION_TRANSITIONS).toEqual({
      new: ["qualified", "nurture", "disqualified", "duplicate"],
      contactAttempted: ["qualified", "nurture", "disqualified", "duplicate"],
      contacted: ["qualified", "nurture", "disqualified", "duplicate"],
      qualified: ["readyToConvert", "nurture", "disqualified", "duplicate"],
      readyToConvert: ["nurture", "disqualified", "duplicate"],
      nurture: ["new", "qualified", "disqualified", "duplicate"],
      disqualified: [],
      duplicate: [],
      converted: [],
    });
  });

  test("NOTHING may target a legacy contact state", () => {
    /* This is what makes them legacy rather than merely discouraged: the graph
       itself refuses to put a record there, from anywhere, including from
       nurture — a parked Lead resuming must resume in the current vocabulary. */
    for (const [from, targets] of Object.entries(LEAD_QUALIFICATION_TRANSITIONS)) {
      expect(targets).not.toContain("contactAttempted");
      expect(targets).not.toContain("contacted");
      expect(isValidTransition(from, "contactAttempted")).toBe(false);
      expect(isValidTransition(from, "contacted")).toBe(false);
    }
  });

  test("a record sitting in a legacy state is not stranded", () => {
    // readable, and able to advance straight to Requirement Captured
    for (const legacy of ["contactAttempted", "contacted"]) {
      expect(isValidTransition(legacy, "qualified")).toBe(true);
      for (const outcome of ["nurture", "disqualified", "duplicate"]) {
        expect(isValidTransition(legacy, outcome)).toBe(true);
      }
    }
  });

  test("isValidTransition reflects the map directly, including terminal states", () => {
    expect(isValidTransition("new", "qualified")).toBe(true);
    expect(isValidTransition("qualified", "readyToConvert")).toBe(true);
    expect(isValidTransition("new", "readyToConvert")).toBe(false); // no skipping a stage
    expect(isValidTransition("disqualified", "new")).toBe(false);
    expect(isValidTransition("disqualified", "disqualified")).toBe(false);
    expect(isValidTransition("duplicate", "anything")).toBe(false);
  });

  test("deriveLegacyStage projects the canonical state onto the legacy funnel, and leaves it alone for nurture", () => {
    expect(deriveLegacyStage("contacted", "new")).toBe("contacted");
    expect(deriveLegacyStage("readyToConvert", "qualified")).toBe("qualified");
    expect(deriveLegacyStage("disqualified", "qualified")).toBe("lost");
    expect(deriveLegacyStage("duplicate", "contacted")).toBe("lost");
    expect(deriveLegacyStage("nurture", "qualified")).toBe("qualified"); // unchanged, orthogonal
  });
});

describe("conversion placeholders are unset by this chunk", () => {
  test("conversion.* and legacy convertedCustomerId stay empty on create", async () => {
    const lead = await createWithRef(Lead, leadPayload());
    expect(lead.conversion.accountId).toBeUndefined();
    expect(lead.conversion.contactId).toBeUndefined();
    expect(lead.conversion.journeyId).toBeUndefined();
    expect(lead.convertedCustomerId).toBeUndefined();
    expect(lead.convertedToCustomer).toBe(false);
  });
});

describe("assertLeadConvertible — the Lead → Sales Journey bridge's rules", () => {
  /* A Lead that both CARRIES the state and still MEETS the bar. The two are
     different facts: the state records that the bar was cleared once, and an
     ordinary edit can undo it afterwards. */
  const convertible = (over = {}) => ({
    captureStatus: "active",
    qualificationState: "readyToConvert",
    company: "Northstar Buying Services",
    phone: "9876500000",
    requirementItems: [{ product: "Housekeeping shirts", quantity: 500 }],
    requirementCertainty: "prospect_confirmed",
    decisionMakerName: "Ravi Kumar",
    ...over,
  });

  test("passes silently for a readyToConvert Lead that still meets the bar", () => {
    expect(() => assertLeadConvertible(convertible())).not.toThrow();
  });

  test("refuses one whose readiness has since been undone, and names what is missing", () => {
    for (const [patch, expected] of [
      [{ decisionMakerName: "" }, /decision-maker/i],
      [{ requirementCertainty: "suspected" }, /confirmed by the customer or a document/i],
      [{ phone: "" }, /contact route/i],
      [{ requirementItems: [] }, /product/i],
      [{ estimatedAnnualRevenue: 900000, estimatedAnnualRevenueConfidence: "researched" }, /source/i],
    ]) {
      expect(() => assertLeadConvertible(convertible(patch))).toThrow(/no longer meets the bar/i);
      expect(() => assertLeadConvertible(convertible(patch))).toThrow(expected);
    }
  });

  test("the error carries the checklist, so a caller can render it", () => {
    try {
      assertLeadConvertible(convertible({ decisionMakerName: "" }));
      throw new Error("should have refused");
    } catch (err) {
      /* The label names WHERE the answer is given, because the checklist is
         also the navigation — it now opens the Contacts editor rather than a
         decision-maker box that no longer exists on the form. */
      expect(err.missing).toContain("Someone in Contacts marked as a decision-maker");
      expect(err.checks.some((c) => c.key === "decisionMaker" && !c.met)).toBe(true);
    }
  });
  test("refuses a Prospect (draft)", () => {
    expect(() => assertLeadConvertible({ captureStatus: "draft", qualificationState: "new" })).toThrow(/prospects cannot start a sales journey/i);
  });
  test("refuses a Lead that already converted", () => {
    expect(() => assertLeadConvertible({ captureStatus: "active", qualificationState: "converted" })).toThrow(/already started a sales journey/i);
  });
  test.each(["new", "contactAttempted", "contacted", "qualified", "nurture", "disqualified", "duplicate"])(
    "refuses a Lead at \"%s\" (not yet Enquiry Ready)",
    (qualificationState) => {
      expect(() => assertLeadConvertible(convertible({ qualificationState }))).toThrow(/enquiry ready/i);
    },
  );
});

describe("duplicate-detection normalized fields (foundations only)", () => {
  test("normalizedCompany/emailDomain/normalizedPhone/websiteDomain are derived on save", async () => {
    const lead = await createWithRef(
      Lead,
      leadPayload({
        company: "  Northstar Buying Services  ",
        email: "Buyer@Example.CO.UK",
        phone: "+91 98765-43210",
        website: "https://www.example.co.uk/contact",
      }),
    );
    expect(lead.normalizedCompany).toBe("northstar buying services");
    expect(lead.emailDomain).toBe("example.co.uk");
    expect(lead.normalizedPhone).toBe("919876543210");
    expect(lead.websiteDomain).toBe("example.co.uk");
  });
});

describe("CRMActivity ownership — Account or pre-Account Lead, EXACTLY one, never neither and never both", () => {
  test("Account Activity regression: accountId-only creation still works", async () => {
    const acc = await Account.create({ companyName: "Acc Co" });
    const a = await Activity.create({ accountId: acc._id, activityType: "note", subject: "Regression note" });
    expect(a.accountId.toString()).toBe(acc._id.toString());
    expect(a.leadId).toBeUndefined();
  });

  test("Account Activity regression: update still works and stays Account-owned", async () => {
    const acc = await Account.create({ companyName: "Acc Co" });
    const a = await Activity.create({ accountId: acc._id, activityType: "note", subject: "Original" });
    a.subject = "Edited";
    await a.save();
    const reread = await Activity.findById(a._id).lean();
    expect(reread.subject).toBe("Edited");
    expect(reread.accountId.toString()).toBe(acc._id.toString());
    expect(reread.leadId).toBeUndefined();
  });

  test("a pre-Account Lead can own an Activity via leadId, with no accountId", async () => {
    const lead = await createWithRef(Lead, leadPayload());
    const a = await Activity.create({ leadId: lead._id, activityType: "call", subject: "Discovery call" });
    expect(a.leadId.toString()).toBe(lead._id.toString());
    expect(a.accountId).toBeUndefined();
  });

  test("an Activity with neither accountId nor leadId is rejected as an orphan", async () => {
    await expect(Activity.create({ activityType: "note", subject: "Orphan" })).rejects.toThrow(/Account.*Lead/i);
  });

  test("an Activity with BOTH accountId and leadId set is rejected", async () => {
    const acc = await Account.create({ companyName: "Acc Co" });
    const lead = await createWithRef(Lead, leadPayload());
    await expect(
      Activity.create({ accountId: acc._id, leadId: lead._id, activityType: "note", subject: "Both owners" }),
    ).rejects.toThrow(/cannot belong to both/i);
  });

  test("a Lead's activity timeline is retrievable by leadId, newest first", async () => {
    const lead = await createWithRef(Lead, leadPayload());
    const older = await Activity.create({
      leadId: lead._id, activityType: "note", subject: "First contact",
      activityDate: new Date(Date.now() - 86400000),
    });
    const newer = await Activity.create({ leadId: lead._id, activityType: "call", subject: "Follow-up call" });
    const timeline = await Activity.find({ leadId: lead._id }).sort({ activityDate: -1 }).lean();
    expect(timeline.map((t) => t._id.toString())).toEqual([newer._id.toString(), older._id.toString()]);
  });
});
