// test/marketing/handover-read-model.test.js
//
// THE OPERATIONAL READ MODEL BEHIND /marketing/handovers.
//
// A read slice is easy to get wrong in ways no user notices until they act on
// it: a page length presented as a total, a pending delivery described as Sales
// being slow, a failed acquisition stop rendered as a blank, a zero that is
// really a failed query. Every block below pins one of those.
//
// The structural test at the end is the load-bearing one: this read model must
// never query a Sales-owned collection, and the tempting shortcut is a single
// `Lead.findById` for a display name.
"use strict";

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/MarketingAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ success: false, message: "Authentication required." });
    req.user = JSON.parse(raw);
    next();
  };
  mw.withRoles = () => mw;
  return mw;
});
jest.mock("../../services/changeLog", () => ({
  recordChange: jest.fn().mockResolvedValue(undefined),
  historyForWithChildren: jest.fn(),
}));

const readModel = require("../../services/marketing/handoverReadModel.service");
const acquisitionHold = require("../../services/marketing/acquisitionHold.service");
const Handover = require("../../models/CMS_Models/Marketing/ProspectHandover");
const Hold = require("../../models/CMS_Models/Marketing/MarketingAcquisitionHold");
const {
  MarketingAuditEvent, MarketingOutboxEvent,
} = require("../../models/CMS_Models/Marketing/MarketingEvent");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const { MARKETING_EVENT_KINDS, HANDOVER_STATE_CODES } = require("../../constants/marketing");

const MARKETER = {
  id: new mongoose.Types.ObjectId().toString(), name: "M", role: "marketing", email: "m@grav.in",
};

let A;
let B;
let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/marketingHandovers"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/marketing`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

beforeEach(async () => {
  const c = await Acc_Company.create({ companyName: "GRAV Read", booksFromDate: new Date("2026-04-01") });
  A = c._id;
  B = new mongoose.Types.ObjectId();
  await Hold.syncIndexes();
});

const api = async (path, user = MARKETER) => {
  const r = await fetch(`${base}${path}`, { headers: { "x-test-user": JSON.stringify(user) } });
  return { status: r.status, body: await r.json() };
};

const SUBMITTED = new Date("2026-09-01T09:00:00Z");
const DECIDED = new Date("2026-09-02T15:30:00Z");
const MEASURED = new Date("2026-09-03T09:00:00Z");

let seq = 0;
/**
 * One handover plus the records the read model reads beside it.
 *
 * Every knob here corresponds to a state a marketer can actually see, so a test
 * can set up "accepted, delivered, hold failed" without reaching into four
 * collections itself.
 */
async function handoverIn(companyId, {
  state = "AWAITING_REVIEW",
  decision = null,
  decidedAt = DECIDED,
  submittedAt = SUBMITTED,
  blockedReason = "",
  outbox = "DELIVERED",
  outboxAttempts = 0,
  /* Distinct from `submittedAt` by default in the timing tests, so a
     measurement taken from the wrong end is visible in the number. */
  deliveredAt = undefined,
  hold = null,
  nurtureTopic = "",
  revisitAt = null,
  salesRecordRef = "LEAD-2026-0001",
  campaignName = "Hotel linen Q3",
  assetName = "Linen durability guide",
  freshness = 6,
} = {}) {
  seq += 1;
  const ref = `MHO-2026-${String(3000 + seq)}`;
  const correlationId = `corr-${ref}`;
  const salesRecordId = new mongoose.Types.ObjectId();

  const handover = await Handover.create({
    companyId,
    handoverRef: ref,
    state,
    company: { name: "Aurora Hotels Pvt Ltd", domain: "aurorahotels.in" },
    person: { firstName: "Meera", lastName: "Nair", jobTitle: "Head of Housekeeping", workEmail: "meera@aurorahotels.in" },
    marketing: { sourceSystem: "mautic", campaignName, assetName, lastEngagedAt: SUBMITTED },
    assessment: {
      accountFit: "strong",
      intent: "explicit_request",
      handoverReason: "Asked for a quotation for 400 rooms.",
      recommendedAction: "call_within_one_business_day",
      evidenceFreshnessHours: freshness,
      rulesVersion: "v1",
      accountFitFactors: ["400 rooms", "India"],
      intentFactors: ["quotation request"],
    },
    permission: { emailConsent: "opted_in", capturedSource: "form", capturedAt: SUBMITTED },
    activities: [{ kind: "form_submitted", occurredAt: SUBMITTED, campaignName, detail: "Quotation form", sourceEventId: `evt-${seq}` }],
    topicsOfInterest: ["linen"],
    sourceEventIds: [`evt-${seq}`],
    correlationId,
    submittedAt,
    blockedReason,
    ...(decision
      ? {
        outcome: {
          decision, decidedAt, decidedBy: { name: "Sai" }, reason: "Good fit.",
          nurtureTopic, revisitAt,
          salesRecordType: "lead", salesRecordId, salesRecordRef,
        },
      }
      : {}),
  });

  if (outbox) {
    await MarketingOutboxEvent.create({
      companyId,
      kind: MARKETING_EVENT_KINDS.HANDOVER_SUBMITTED,
      payload: { handoverId: handover._id, handoverRef: ref },
      occurredAt: submittedAt || new Date(),
      correlationId,
      status: outbox === "DELIVERED" ? "DELIVERED" : "PENDING",
      attempts: outboxAttempts,
      deliveredAt: outbox === "DELIVERED"
        ? (deliveredAt === undefined ? submittedAt : deliveredAt)
        : null,
      lastAttemptAt: outboxAttempts ? new Date("2026-09-01T10:00:00Z") : null,
      /* A realistic internal message, to prove it never reaches the wire. */
      lastError: outboxAttempts ? "connect ECONNREFUSED 10.0.0.4:5000 token=abc123" : "",
    });
  }

  if (hold) {
    await Hold.create({
      companyId, handoverRef: ref, handoverId: handover._id,
      gravPersonKey: `key-${seq}`, mauticContactId: "700",
      reason: decision === "DUPLICATE_LINKED" ? "SALES_DUPLICATE_LINKED" : "SALES_ACCEPTED",
      requestedAt: decidedAt || new Date(),
      ...hold,
    });
  }

  await MarketingAuditEvent.create({
    companyId, handoverRef: ref, handoverId: handover._id,
    action: "handover.submitted", at: submittedAt || new Date(),
    resultingState: state, correlationId,
    details: { campaignName },
  });

  return { ref, handover, correlationId, salesRecordId };
}

const APPLIED_HOLD = {
  state: "APPLIED", attempts: 1, confirmedAt: DECIDED, lastAttemptAt: DECIDED,
  evidence: {
    holdFieldSet: true, segmentsRemoved: ["9"], campaignsRemoved: ["4"],
    exclusionsGuarded: ["9"], verifiedAt: DECIDED,
  },
};
const FAILED_HOLD = {
  state: "FAILED", attempts: 2, retryCount: 1,
  nextAttemptAt: new Date("2026-09-04T09:00:00Z"), lastAttemptAt: DECIDED,
  activeError: {
    reasonCode: "MAUTIC_UNREACHABLE", failureClass: "TRANSIENT", sourceCode: "MAUTIC_UNAVAILABLE",
    message: "Mautic did not respond.", at: DECIDED, attemptNo: 2,
  },
};

/* ═══════════════════════════════════════════════════════════════════════════
   1. THE LIST CONTRACT
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the list contract", () => {
  test("it returns rows, a summary, a cursor and the moment it was measured", async () => {
    await handoverIn(A);
    const res = await api("/handovers");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      "filter", "filters", "hasMore", "measuredAt", "nextCursor", "page", "rows", "success", "summary",
    ]);
    expect(res.body.rows).toHaveLength(1);
    expect(typeof res.body.measuredAt).toBe("string");
    expect(res.body.hasMore).toBe(false);
    expect(res.body.nextCursor).toBeNull();
  });

  test("the summary is exact and company-scoped, with every state present", async () => {
    await handoverIn(A, { state: "AWAITING_REVIEW" });
    await handoverIn(A, { state: "AWAITING_REVIEW" });
    await handoverIn(A, { state: "ACCEPTED", decision: "ACCEPTED", hold: APPLIED_HOLD });
    await handoverIn(A, { state: "BLOCKED", outbox: null, blockedReason: "No marketing consent." });
    await handoverIn(B, { state: "ACCEPTED", decision: "ACCEPTED" });

    const res = await api("/handovers");
    expect(res.body.summary.total).toBe(4);
    expect(res.body.summary.byState).toEqual({
      AWAITING_REVIEW: 2, ACCEPTED: 1, RETURNED: 0, REJECTED: 0, DUPLICATE_LINKED: 0, BLOCKED: 1,
    });
    /* Every state, including the measured zeroes, so a client renders a stable
       set rather than guessing which are missing. */
    expect(Object.keys(res.body.summary.byState).sort()).toEqual([...HANDOVER_STATE_CODES].sort());
  });

  test("a page length is never presented as a total", async () => {
    for (let i = 0; i < 7; i += 1) await handoverIn(A);
    const res = await api("/handovers?limit=3");
    expect(res.body.rows).toHaveLength(3);
    expect(res.body.page).toEqual({ size: 3, maxSize: readModel.MAX_PAGE });
    /* The real number is in the summary, and it is not 3. */
    expect(res.body.summary.total).toBe(7);
    expect(res.body.hasMore).toBe(true);
  });

  test("every accepted filter works and narrows the rows", async () => {
    await handoverIn(A, { state: "AWAITING_REVIEW" });
    await handoverIn(A, { state: "ACCEPTED", decision: "ACCEPTED", hold: APPLIED_HOLD });
    await handoverIn(A, { state: "RETURNED", decision: "RETURNED", nurtureTopic: "linen", revisitAt: new Date("2027-03-01T00:00:00Z") });
    await handoverIn(A, { state: "REJECTED", decision: "REJECTED" });
    await handoverIn(A, { state: "DUPLICATE_LINKED", decision: "DUPLICATE_LINKED", hold: APPLIED_HOLD });
    await handoverIn(A, { state: "BLOCKED", outbox: null, blockedReason: "No consent." });

    for (const filter of readModel.LIST_FILTERS) {
      const res = await api(`/handovers?state=${filter}`);
      expect(res.status).toBe(200);
      expect(res.body.filter).toBe(filter);
      if (filter === "all") expect(res.body.rows).toHaveLength(6);
      else {
        expect(res.body.rows).toHaveLength(1);
        expect(res.body.rows[0].state).toBe(filter);
      }
    }
  });

  test("an unknown filter is refused rather than answered with an empty page", async () => {
    await handoverIn(A);
    const res = await api("/handovers?state=ACCEPTED_MAYBE");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION");
    expect(res.body.error.message).toContain("ACCEPTED_MAYBE");
    expect(res.body.error.details.accepted).toEqual(readModel.LIST_FILTERS);
    /* The dangerous alternative: an empty list that reads as "nothing is
       waiting for Sales". */
    expect(res.body.rows).toBeUndefined();
  });

  test("a lowercase or mixed-case state is refused too, rather than guessed at", async () => {
    expect((await api("/handovers?state=accepted")).status).toBe(400);
    expect((await api("/handovers?state=Awaiting_Review")).status).toBe(400);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. PAGINATION
   ═══════════════════════════════════════════════════════════════════════════ */

describe("cursor pagination", () => {
  test("it walks the whole list exactly once, newest first", async () => {
    const refs = [];
    for (let i = 0; i < 7; i += 1) refs.push((await handoverIn(A)).ref);

    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const res = await api(`/handovers?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...res.body.rows.map((r) => r.handoverRef));
      cursor = res.body.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor);

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    /* Newest first: the last handover created is the first row. */
    expect(seen[0]).toBe(refs[refs.length - 1]);
    expect(seen[seen.length - 1]).toBe(refs[0]);
  });

  test("the page size is bounded however much is asked for", async () => {
    for (let i = 0; i < 3; i += 1) await handoverIn(A);
    const res = await api("/handovers?limit=100000");
    expect(res.body.page.maxSize).toBe(readModel.MAX_PAGE);
    expect(res.body.rows).toHaveLength(3);
    /* And a nonsense size falls back rather than returning nothing. */
    expect((await api("/handovers?limit=0")).body.rows.length).toBeGreaterThan(0);
    expect((await api("/handovers?limit=banana")).body.rows.length).toBeGreaterThan(0);
  });

  test("a malformed cursor is refused", async () => {
    await handoverIn(A);
    const res = await api("/handovers?cursor=not-an-id");
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("valid page cursor");
  });

  test("a cursor minted against another company reveals nothing", async () => {
    const mine = await handoverIn(A);
    const theirs = await handoverIn(B);
    /* A real, well-formed cursor — it simply belongs to a row this company's
       selector does not match. */
    const res = await api(`/handovers?cursor=${theirs.handover._id}`);
    expect(res.status).toBe(200);
    expect(res.body.rows.every((r) => r.handoverRef !== theirs.ref)).toBe(true);
    expect(res.body.summary.total).toBe(1);
    /* And it cannot be used to page past this company's own rows either: the
       cursor orders BEFORE them, so the page is simply empty. */
    expect(res.body.rows.map((r) => r.handoverRef)).not.toContain(theirs.ref);
    expect(JSON.stringify(res.body)).not.toContain(theirs.ref);
    expect(mine.ref).toBeTruthy();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. WHAT EACH ROW SAYS
   ═══════════════════════════════════════════════════════════════════════════ */

describe("a row carries operational fields and nothing else", () => {
  test("the submitted, assessed and source fields a marketer reads", async () => {
    const { ref } = await handoverIn(A);
    const row = (await api("/handovers")).body.rows[0];

    expect(row.handoverRef).toBe(ref);
    expect(row.submittedAt).toBe(SUBMITTED.toISOString());
    expect(row.person).toEqual({
      displayName: "Meera Nair",
      jobTitle: "Head of Housekeeping",
      workEmail: "meera@aurorahotels.in",
    });
    expect(row.organisation.name).toBe("Aurora Hotels Pvt Ltd");
    expect(row.source.campaignName).toBe("Hotel linen Q3");
    expect(row.source.assetName).toBe("Linen durability guide");
    expect(row.assessment).toMatchObject({
      accountFit: "strong",
      intent: "explicit_request",
      handoverReason: "Asked for a quotation for 400 rooms.",
      recommendedAction: "call_within_one_business_day",
      evidenceFreshnessHours: 6,
    });
  });

  test("a missing name is said to be missing rather than rendered blank", async () => {
    await Handover.create({
      companyId: A, handoverRef: "MHO-2026-3900", state: "AWAITING_REVIEW",
      company: { name: "Aurora" }, person: { workEmail: "x@aurorahotels.in" },
      assessment: { handoverReason: "Asked.", recommendedAction: "email_introduction" },
      correlationId: "corr-3900", submittedAt: SUBMITTED,
    });
    const row = (await api("/handovers")).body.rows[0];
    expect(row.person.displayName).toBe("(name not captured)");
    /* And freshness that was never measured is null, not zero. */
    expect(row.assessment.evidenceFreshnessHours).toBeNull();
  });

  test("no Sales lifecycle or commercial field reaches the payload", async () => {
    await handoverIn(A, { state: "ACCEPTED", decision: "ACCEPTED", hold: APPLIED_HOLD });
    const row = (await api("/handovers")).body.rows[0];

    /* Field NAMES, gathered from the whole nested payload. Searching the
       serialised text would fail on a handover reason that merely mentions a
       quotation, which is prose a marketer wrote and not a commercial field. */
    const keys = new Set();
    (function walk(node) {
      if (!node || typeof node !== "object") return;
      for (const [k, v] of Object.entries(node)) { keys.add(k); walk(v); }
    }(row));

    for (const forbidden of [
      "captureStatus", "reviewStatus", "qualificationState", "enquiryId", "journeyId",
      "quotationId", "price", "margin", "orderValue", "creditDays", "assignedTo",
    ]) {
      expect([...keys]).not.toContain(forbidden);
    }
    /* The Sales record is present as identity and its keys are exactly three. */
    expect(Object.keys(row.salesRecord).sort()).toEqual(["id", "ref", "type"]);
  });

  test("an undecided handover carries no decision block at all", async () => {
    await handoverIn(A);
    const row = (await api("/handovers")).body.rows[0];
    expect(row.decision).toBeNull();
    expect(row.salesRecord).toBeNull();
  });

  test("a decided handover carries the decision, its time and its reason", async () => {
    await handoverIn(A, { state: "ACCEPTED", decision: "ACCEPTED", hold: APPLIED_HOLD });
    const row = (await api("/handovers")).body.rows[0];
    expect(row.decision).toMatchObject({
      decision: "ACCEPTED",
      decidedAt: DECIDED.toISOString(),
      decidedBy: "Sai",
      reason: "Good fit.",
    });
  });

  test("nurture topic and revisit date appear only on a return", async () => {
    await handoverIn(A, {
      state: "RETURNED", decision: "RETURNED",
      nurtureTopic: "housekeeping fabric durability", revisitAt: new Date("2027-03-01T00:00:00Z"),
    });
    const returned = (await api("/handovers?state=RETURNED")).body.rows[0];
    expect(returned.decision.nurtureTopic).toBe("housekeeping fabric durability");
    expect(returned.decision.revisitAt).toBe("2027-03-01T00:00:00.000Z");

    await handoverIn(A, { state: "ACCEPTED", decision: "ACCEPTED", nurtureTopic: "ignored", hold: APPLIED_HOLD });
    const accepted = (await api("/handovers?state=ACCEPTED")).body.rows[0];
    expect(accepted.decision.nurtureTopic).toBe("");
    expect(accepted.decision.revisitAt).toBeNull();
  });

  test("the canonical Sales record is an identity and nothing more", async () => {
    const { salesRecordId } = await handoverIn(A, {
      state: "ACCEPTED", decision: "ACCEPTED", hold: APPLIED_HOLD,
    });
    const row = (await api("/handovers")).body.rows[0];
    expect(Object.keys(row.salesRecord).sort()).toEqual(["id", "ref", "type"]);
    expect(row.salesRecord).toEqual({
      type: "lead", id: String(salesRecordId), ref: "LEAD-2026-0001",
    });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. DELIVERY TO SALES
   ═══════════════════════════════════════════════════════════════════════════ */

describe("delivery to Sales is four states, not a flag", () => {
  test("blocked before submission", async () => {
    await handoverIn(A, { state: "BLOCKED", outbox: null, blockedReason: "No marketing consent on file." });
    const row = (await api("/handovers")).body.rows[0];
    expect(row.delivery.state).toBe("BLOCKED_BEFORE_SUBMISSION");
    expect(row.delivery.label).toMatch(/never submitted to Sales/);
    expect(row.delivery.blockedReason).toBe("No marketing consent on file.");
    expect(row.delivery.deliveredAt).toBeNull();
  });

  test("pending delivery is never described as Sales being slow", async () => {
    await handoverIn(A, { outbox: "PENDING" });
    const row = (await api("/handovers")).body.rows[0];
    expect(row.delivery.state).toBe("PENDING_DELIVERY");
    expect(row.delivery.label).toMatch(/has not seen it yet/i);
    expect(row.delivery.label).not.toMatch(/awaiting review/i);
    expect(row.delivery.deliveredAt).toBeNull();
  });

  test("a failed attempt is distinguished from never having been tried", async () => {
    await handoverIn(A, { outbox: "PENDING", outboxAttempts: 3 });
    const row = (await api("/handovers")).body.rows[0];
    expect(row.delivery.state).toBe("DELIVERY_FAILED");
    expect(row.delivery.attempts).toBe(3);
    expect(row.delivery.lastAttemptAt).toBe("2026-09-01T10:00:00.000Z");
    expect(row.delivery.label).toMatch(/awaiting another attempt/i);
  });

  test("delivered carries the time it landed", async () => {
    await handoverIn(A, { outbox: "DELIVERED" });
    const row = (await api("/handovers")).body.rows[0];
    expect(row.delivery.state).toBe("DELIVERED");
    expect(row.delivery.deliveredAt).toBe(SUBMITTED.toISOString());
  });

  test("a submitted handover with no delivery record says so", async () => {
    await handoverIn(A, { outbox: null });
    const row = (await api("/handovers")).body.rows[0];
    expect(row.delivery.state).toBe("UNRECORDED");
    expect(row.delivery.label).toMatch(/needs an operator/i);
  });

  test("no internal error text, credential or host reaches the payload", async () => {
    await handoverIn(A, { outbox: "PENDING", outboxAttempts: 2 });
    const serialised = JSON.stringify((await api("/handovers")).body);
    /* The stored `lastError` for this row is
       "connect ECONNREFUSED 10.0.0.4:5000 token=abc123". */
    expect(serialised).not.toContain("ECONNREFUSED");
    expect(serialised).not.toContain("token=abc123");
    expect(serialised).not.toContain("10.0.0.4");
    expect(serialised).not.toMatch(/at Object\.|node_modules/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. RESPONSE TIMING
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Sales-response time is measured from confirmed delivery only", () => {
  /* ── THE BUG THIS BLOCK PINS ──────────────────────────────────────────────
     The first version measured from `submittedAt`, which is when MARKETING
     committed the handover. A handover still sitting in Marketing's outbox
     therefore grew an "awaiting" Sales-response duration by the hour while Sales
     had never been shown it — telling a marketer that Sales was slow when the
     real fault was GRAV's own undelivered announcement.

     Delivery is deliberately given its own timestamp here, four hours after
     submission, so a measurement taken from the wrong one is visible in the
     number rather than hidden by a fixture that made them equal. */
  const DELIVERED_AT = new Date("2026-09-01T13:00:00Z");

  test("blocked is not applicable at all", async () => {
    await handoverIn(A, { state: "BLOCKED", outbox: null, blockedReason: "No consent." });
    const view = await readModel.list({ companyId: A, now: MEASURED });
    const timing = view.rows[0].responseTiming;
    expect(timing).toMatchObject({ applicable: false, available: false, basis: "blocked" });
    expect(timing.elapsedMs).toBeNull();
    expect(timing.reason).toMatch(/Sales was never asked/);
  });

  test("pending delivery has no Sales-response duration", async () => {
    await handoverIn(A, { outbox: "PENDING" });
    const view = await readModel.list({ companyId: A, now: MEASURED });
    const row = view.rows[0];
    expect(row.delivery.state).toBe("PENDING_DELIVERY");
    expect(row.responseTiming).toMatchObject({
      applicable: true, available: false, basis: "delivery_unconfirmed",
    });
    expect(row.responseTiming.elapsedMs).toBeNull();
    expect(row.responseTiming.elapsedHours).toBeNull();
    expect(row.responseTiming.reason).toMatch(/Delivery to Sales has not been confirmed/);
  });

  test("failed delivery has no Sales-response duration either", async () => {
    await handoverIn(A, { outbox: "PENDING", outboxAttempts: 3 });
    const view = await readModel.list({ companyId: A, now: MEASURED });
    const row = view.rows[0];
    expect(row.delivery.state).toBe("DELIVERY_FAILED");
    expect(row.responseTiming).toMatchObject({
      applicable: true, available: false, basis: "delivery_unconfirmed",
    });
    expect(row.responseTiming.elapsedMs).toBeNull();
  });

  test("an unrecorded delivery has no Sales-response duration either", async () => {
    await handoverIn(A, { outbox: null });
    const view = await readModel.list({ companyId: A, now: MEASURED });
    const row = view.rows[0];
    expect(row.delivery.state).toBe("UNRECORDED");
    expect(row.responseTiming).toMatchObject({
      applicable: true, available: false, basis: "delivery_unconfirmed",
    });
    expect(row.responseTiming.elapsedMs).toBeNull();
  });

  test("delivered and undecided measures from deliveredAt to the moment of measurement", async () => {
    await handoverIn(A, { outbox: "DELIVERED", deliveredAt: DELIVERED_AT });
    const view = await readModel.list({ companyId: A, now: MEASURED });
    const timing = view.rows[0].responseTiming;
    expect(timing).toMatchObject({ applicable: true, available: true, basis: "awaiting" });
    expect(timing.from).toEqual(DELIVERED_AT);
    expect(timing.to).toEqual(MEASURED);
    expect(timing.elapsedMs).toBe(MEASURED.getTime() - DELIVERED_AT.getTime());
    expect(timing.elapsedHours).toBe(44);
    /* Not 48, which is what measuring from submission would have given. */
    expect(timing.elapsedHours).not.toBe(48);
  });

  test("delivered and decided measures from deliveredAt to decidedAt", async () => {
    await handoverIn(A, {
      state: "ACCEPTED", decision: "ACCEPTED", hold: APPLIED_HOLD,
      outbox: "DELIVERED", deliveredAt: DELIVERED_AT,
    });
    const view = await readModel.list({ companyId: A, now: MEASURED });
    const timing = view.rows[0].responseTiming;
    expect(timing).toMatchObject({ applicable: true, available: true, basis: "decided" });
    expect(timing.from).toEqual(DELIVERED_AT);
    expect(timing.to).toEqual(DECIDED);
    expect(timing.elapsedHours).toBe(26.5);
    /* Not 30.5, which is submission to decision. */
    expect(timing.elapsedHours).not.toBe(30.5);
  });

  test("delivered with no deliveredAt is unavailable", async () => {
    await handoverIn(A, { outbox: "DELIVERED", deliveredAt: null });
    const view = await readModel.list({ companyId: A, now: MEASURED });
    const row = view.rows[0];
    expect(row.delivery.state).toBe("DELIVERED");
    expect(row.responseTiming).toMatchObject({
      applicable: true, available: false, basis: "unavailable",
    });
    expect(row.responseTiming.reason).toMatch(/no recorded delivery time/);
    expect(row.responseTiming.elapsedMs).toBeNull();
  });

  test("a decision with no decision time is unavailable, not measured to now", async () => {
    await handoverIn(A, {
      state: "ACCEPTED", decision: "ACCEPTED", decidedAt: null, hold: APPLIED_HOLD,
      outbox: "DELIVERED", deliveredAt: DELIVERED_AT,
    });
    const view = await readModel.list({ companyId: A, now: MEASURED });
    const timing = view.rows[0].responseTiming;
    expect(timing).toMatchObject({ applicable: true, available: false, basis: "unavailable" });
    expect(timing.reason).toMatch(/no recorded decision time/);
  });

  test("a decision recorded BEFORE delivery is unavailable, never negative and never zero", async () => {
    /* Reversed records: decided at 15:30 on the 2nd, "delivered" on the 5th. */
    await handoverIn(A, {
      state: "ACCEPTED", decision: "ACCEPTED", hold: APPLIED_HOLD,
      outbox: "DELIVERED", deliveredAt: new Date("2026-09-05T09:00:00Z"),
    });
    const view = await readModel.list({ companyId: A, now: MEASURED });
    const timing = view.rows[0].responseTiming;
    expect(timing).toMatchObject({ applicable: true, available: false, basis: "unavailable" });
    expect(timing.reason).toMatch(/wrong order/);
    expect(timing.elapsedMs).toBeNull();
    /* The two wrong answers this refuses to give: a silent zero, and a negative
       duration. It gives null and a reason instead. */
    expect(timing.elapsedMs).toBeNull();
    expect(timing.elapsedHours).toBeNull();
  });

  test("a measurement moment that is not a valid time is unavailable", async () => {
    await handoverIn(A, { outbox: "DELIVERED", deliveredAt: DELIVERED_AT });
    const view = await readModel.list({ companyId: A, now: new Date("not a date") });
    const timing = view.rows[0].responseTiming;
    expect(timing.available).toBe(false);
    expect(timing.elapsedMs).toBeNull();
  });

  test("an unparseable or non-finite timestamp never produces a number", () => {
    for (const bad of ["not a date", NaN, Infinity, -Infinity, {}, [], "", 0]) {
      expect(readModel.validDate(bad)).toBeNull();
    }
    expect(readModel.validDate(new Date("2026-09-01T00:00:00Z"))).toBeInstanceOf(Date);

    /* And the subtraction refuses rather than returning NaN or a negative. */
    const good = new Date("2026-09-02T00:00:00Z");
    const earlier = new Date("2026-09-01T00:00:00Z");
    expect(readModel.elapsedBetween(null, good, "x", "r").available).toBe(false);
    expect(readModel.elapsedBetween(good, null, "x", "r").available).toBe(false);
    expect(readModel.elapsedBetween(good, earlier, "x", "r")).toMatchObject({
      available: false, elapsedMs: null, elapsedHours: null,
    });
    expect(readModel.elapsedBetween(earlier, good, "x", "r").elapsedHours).toBe(24);
  });

  test("nothing anywhere calls a handover overdue", async () => {
    await handoverIn(A, {
      submittedAt: new Date("2026-01-01T00:00:00Z"),
      outbox: "DELIVERED", deliveredAt: new Date("2026-01-01T01:00:00Z"),
    });
    const body = (await api("/handovers")).body;
    const serialised = JSON.stringify(body).toLowerCase();
    for (const word of ["overdue", "breach", "sla", "late", "violated", "missed"]) {
      expect(serialised).not.toContain(word);
    }
    expect(body.rows[0].responseTiming.elapsedHours).toBeGreaterThan(1000);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5b. TIME WAITING FOR DELIVERY, REPORTED WHERE IT BELONGS
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the delivery wait is measured under delivery, never called a Sales response", () => {
  test("a pending handover reports how long it has waited for delivery", async () => {
    await handoverIn(A, { outbox: "PENDING" });
    const row = (await readModel.list({ companyId: A, now: MEASURED })).rows[0];
    expect(row.delivery.waitingForDelivery).toMatchObject({ available: true, basis: "waiting" });
    expect(row.delivery.waitingForDelivery.elapsedHours).toBe(48);
    /* The same 48 hours the old, wrong contract put under responseTiming. */
    expect(row.responseTiming.available).toBe(false);
  });

  test("a delivered handover reports how long delivery took", async () => {
    await handoverIn(A, { outbox: "DELIVERED", deliveredAt: new Date("2026-09-01T13:00:00Z") });
    const row = (await readModel.list({ companyId: A, now: MEASURED })).rows[0];
    expect(row.delivery.waitingForDelivery).toMatchObject({
      available: true, basis: "delivered", elapsedHours: 4,
    });
  });

  test("a blocked handover waited for nothing", async () => {
    await handoverIn(A, { state: "BLOCKED", outbox: null, blockedReason: "No consent." });
    const row = (await readModel.list({ companyId: A, now: MEASURED })).rows[0];
    expect(row.delivery.waitingForDelivery.available).toBe(false);
    expect(row.delivery.waitingForDelivery.reason).toMatch(/never submitted/);
  });

  test("a missing submission time makes the wait unmeasurable, not zero", async () => {
    await handoverIn(A, { submittedAt: null, outbox: "PENDING" });
    const row = (await readModel.list({ companyId: A, now: MEASURED })).rows[0];
    expect(row.delivery.waitingForDelivery).toMatchObject({
      available: false, elapsedMs: null, elapsedHours: null,
    });
  });

  test("the delivery wait is never labelled a Sales response anywhere", async () => {
    await handoverIn(A, { outbox: "PENDING" });
    const body = (await api("/handovers")).body;
    /* The wait lives under `delivery`, and `responseTiming` carries no number. */
    expect(body.rows[0].delivery.waitingForDelivery.elapsedHours).toBeGreaterThan(0);
    expect(body.rows[0].responseTiming.elapsedHours).toBeNull();
    expect(body.rows[0].responseTiming.basis).toBe("delivery_unconfirmed");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   6. ACQUISITION STATE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("acquisition state carries the four facts", () => {
  test("not applicable before a decision, and on a decision that does not stop acquisition", async () => {
    await handoverIn(A);
    await handoverIn(A, { state: "RETURNED", decision: "RETURNED" });
    await handoverIn(A, { state: "REJECTED", decision: "REJECTED" });

    for (const filter of ["AWAITING_REVIEW", "RETURNED", "REJECTED"]) {
      const row = (await api(`/handovers?state=${filter}`)).body.rows[0];
      expect(row.acquisition.applicable).toBe(false);
      expect(row.acquisition.state).toBe("NOT_APPLICABLE");
      expect(row.acquisition.pausedAt).toBeNull();
      expect(row.acquisition.disclosure.confirmedStopped).toBe(false);
    }
  });

  test("confirmed stopped carries all four facts", async () => {
    await handoverIn(A, { state: "ACCEPTED", decision: "ACCEPTED", hold: APPLIED_HOLD });
    const row = (await api("/handovers")).body.rows[0];
    expect(row.acquisition.state).toBe("APPLIED");
    expect(row.acquisition.pausedAt).toBe(DECIDED.toISOString());
    expect(row.acquisition.disclosure).toMatchObject({
      currentlyRemoved: { segments: ["9"], campaigns: ["4"] },
      futureEnrollmentPrevented: true,
      awaitingRetry: false,
      retryIsAutomatic: false,
      confirmedStopped: true,
    });
  });

  test("a failed hold is awaiting retry, and never claims the retry is automatic", async () => {
    await handoverIn(A, { state: "ACCEPTED", decision: "ACCEPTED", hold: FAILED_HOLD });
    /* Measured before the scheduled retry falls due, so this is the waiting
       state rather than the due one. Both are read from the clock, which is why
       `measuredAt` travels with every payload. */
    const row = (await readModel.list({ companyId: A, now: MEASURED })).rows[0];
    expect(row.acquisition.state).toBe("RETRY_WAITING");
    expect(row.acquisition.pausedAt).toBeNull();
    expect(row.acquisition.label).toMatch(/not automatic/i);
    expect(row.acquisition.disclosure).toMatchObject({
      futureEnrollmentPrevented: false,
      awaitingRetry: true,
      retryIsAutomatic: false,
      confirmedStopped: false,
    });
    expect(row.acquisition.failure.reasonCode).toBe("MARKETING_ENGINE_UNREACHABLE");

    /* And once its backoff has elapsed it reads as due, still not automatic. */
    const later = (await readModel.list({
      companyId: A, now: new Date("2026-09-05T09:00:00Z"),
    })).rows[0];
    expect(later.acquisition.state).toBe("RETRY_DUE");
    expect(later.acquisition.label).toMatch(/operator or a redelivery/i);
    expect(later.acquisition.disclosure.retryIsAutomatic).toBe(false);
  });

  test("a requested hold is distinguished from one being applied", async () => {
    await handoverIn(A, { state: "ACCEPTED", decision: "ACCEPTED", hold: { state: "REQUESTED" } });
    expect((await api("/handovers")).body.rows[0].acquisition.state).toBe("REQUESTED");

    await Hold.updateMany({ companyId: A }, { $set: { attempts: 1, inFlightSince: new Date() } });
    expect((await api("/handovers")).body.rows[0].acquisition.state).toBe("IN_FLIGHT");
  });

  test("a superseded hold says so rather than claiming a stop", async () => {
    await handoverIn(A, {
      state: "ACCEPTED", decision: "ACCEPTED",
      hold: {
        state: "SUPERSEDED", attempts: 0,
        supersededBy: { reason: "CONSENT_SUPPRESSED", at: DECIDED, handoverRef: "" },
      },
    });
    const row = (await api("/handovers")).body.rows[0];
    expect(row.acquisition.state).toBe("SUPERSEDED");
    expect(row.acquisition.pausedAt).toBeNull();
    expect(row.acquisition.supersededBy.reason).toBe("CONSENT_SUPPRESSED");
    expect(row.acquisition.disclosure.confirmedStopped).toBe(false);
  });

  test("a decision owing a hold that does not exist is reported, not blank", async () => {
    await handoverIn(A, { state: "ACCEPTED", decision: "ACCEPTED", hold: null });
    const row = (await api("/handovers")).body.rows[0];
    expect(row.acquisition.applicable).toBe(true);
    expect(row.acquisition.state).toBe("MISSING");
    expect(row.acquisition.label).toMatch(/needs an operator/i);
    expect(row.acquisition.pausedAt).toBeNull();
  });

  test("no row reduces acquisition to a paused boolean", async () => {
    await handoverIn(A, { state: "ACCEPTED", decision: "ACCEPTED", hold: APPLIED_HOLD });
    const row = (await api("/handovers")).body.rows[0];
    expect(row.acquisition.paused).toBeUndefined();
    expect(row.acquisition.isPaused).toBeUndefined();
    expect(typeof row.acquisition.disclosure).toBe("object");
  });

  test("the list reads acquisition in one batch query, not one per row", async () => {
    for (let i = 0; i < 6; i += 1) {
      await handoverIn(A, { state: "ACCEPTED", decision: "ACCEPTED", hold: APPLIED_HOLD });
    }
    const spy = jest.spyOn(Hold, "find");
    const view = await readModel.list({ companyId: A, limit: 6 });
    expect(view.rows).toHaveLength(6);
    /* Six rows, one query. An N+1 would be six. */
    expect(spy).toHaveBeenCalledTimes(1);
    expect(view.rows.every((r) => r.acquisition.state === "APPLIED")).toBe(true);
    spy.mockRestore();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   7. THE DETAIL CONTRACT
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the detail contract", () => {
  test("it carries the same row plus evidence and audit history", async () => {
    const { ref } = await handoverIn(A, { state: "ACCEPTED", decision: "ACCEPTED", hold: APPLIED_HOLD });
    const res = await api(`/handovers/${ref}`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      "assessmentFactors", "blockedReason", "evidence", "history", "measuredAt",
      "permission", "row", "success",
    ]);

    /* The same interpretation the list gives, so the two cannot disagree. */
    const listRow = (await api("/handovers")).body.rows[0];
    expect(res.body.row.delivery.state).toBe(listRow.delivery.state);
    expect(res.body.row.acquisition.state).toBe(listRow.acquisition.state);
    expect(res.body.row.salesRecord).toEqual(listRow.salesRecord);

    expect(res.body.evidence.activities[0]).toMatchObject({
      kind: "form_submitted", detail: "Quotation form",
    });
    expect(res.body.evidence.topicsOfInterest).toEqual(["linen"]);
    expect(res.body.history.map((h) => h.action)).toEqual(["handover.submitted"]);
    expect(res.body.assessmentFactors.accountFitFactors).toEqual(["400 rooms", "India"]);
  });

  test("a blocked handover explains itself", async () => {
    const { ref } = await handoverIn(A, {
      state: "BLOCKED", outbox: null, blockedReason: "Email consent is unknown.",
    });
    const res = await api(`/handovers/${ref}`);
    expect(res.body.blockedReason).toBe("Email consent is unknown.");
    expect(res.body.row.delivery.state).toBe("BLOCKED_BEFORE_SUBMISSION");
    expect(res.body.row.responseTiming.applicable).toBe(false);
  });

  test("another company's handover is not found", async () => {
    const theirs = await handoverIn(B);
    const res = await api(`/handovers/${theirs.ref}`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("aurorahotels.in");
  });

  test("a handover that does not exist gets the same answer as one owned elsewhere", async () => {
    const theirs = await api(`/handovers/${(await handoverIn(B)).ref}`);
    const nothing = await api("/handovers/MHO-2026-0000");
    expect(theirs.status).toBe(nothing.status);
    expect(theirs.body.error.message).toBe(nothing.body.error.message);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   8. BOUNDARIES
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the read model stays inside Marketing", () => {
  test("it loads no Sales-owned model or service", () => {
    /* ── THE STRUCTURAL GUARANTEE ────────────────────────────────────────
       Route tests cannot catch this: a single `Lead.findById` for a display
       name would pass every assertion above while breaking the boundary the
       whole product rests on. So the module's own dependency list is asserted.

       The only Sales-shaped thing it may name is the IDENTITY of a Sales record
       carried on Marketing's own outcome copy. */
    const fs = require("fs");
    const source = fs.readFileSync(
      require.resolve("../../services/marketing/handoverReadModel.service"), "utf8",
    );
    const requires = [...source.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);

    for (const path of requires) {
      expect(path).not.toMatch(/CMS_Models\/Sales/);
      expect(path).not.toMatch(/services\/sales\//);
      expect(path).not.toMatch(/Sales\/MarketingProspectIntake/);
    }
    /* And what it does load is Marketing's own, plus the shared error table. */
    expect(requires.sort()).toEqual([
      "../../constants/marketing",
      "../../models/CMS_Models/Marketing/MarketingEvent",
      "../../models/CMS_Models/Marketing/ProspectHandover",
      "../storePurchase/errors",
      "./acquisitionHold.service",
    ]);
  });

  test("every read requires a company", async () => {
    await expect(readModel.list({})).rejects.toMatchObject({ code: "TENANT_MEMBERSHIP_UNPROVEN" });
    await expect(readModel.detail({ handoverRef: "MHO-2026-0001" }))
      .rejects.toMatchObject({ code: "TENANT_MEMBERSHIP_UNPROVEN" });
    await expect(readModel.summaryFor({ companyId: null })).rejects.toThrow();
  });

  test("a detail read without a reference is refused", async () => {
    await expect(readModel.detail({ companyId: A, handoverRef: "" }))
      .rejects.toMatchObject({ code: "VALIDATION" });
  });

  test("no row, summary or cursor crosses companies", async () => {
    for (let i = 0; i < 3; i += 1) await handoverIn(B, { state: "ACCEPTED", decision: "ACCEPTED", hold: APPLIED_HOLD });
    await handoverIn(A);

    const mine = await api("/handovers");
    expect(mine.body.rows).toHaveLength(1);
    expect(mine.body.summary.total).toBe(1);
    expect(mine.body.summary.byState.ACCEPTED).toBe(0);

    /* Company B's world is intact and invisible from here. */
    const theirs = await readModel.list({ companyId: B });
    expect(theirs.rows).toHaveLength(3);
    expect(theirs.summary.total).toBe(3);
  });

  test("an unauthenticated caller is refused at both reads", async () => {
    const { ref } = await handoverIn(A);
    for (const path of ["/handovers", `/handovers/${ref}`]) {
      expect((await fetch(`${base}${path}`)).status).toBe(401);
    }
  });

  test("the list is a GET only, and writes nothing", async () => {
    const { ref } = await handoverIn(A);
    const before = await Handover.findOne({ companyId: A, handoverRef: ref }).lean();
    await api("/handovers");
    await api(`/handovers/${ref}`);
    const after = await Handover.findOne({ companyId: A, handoverRef: ref }).lean();
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(await MarketingAuditEvent.countDocuments({ companyId: A, handoverRef: ref })).toBe(1);
  });
});
