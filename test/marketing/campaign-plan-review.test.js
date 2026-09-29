// test/marketing/campaign-plan-review.test.js
//
// THE REVIEW AND APPROVAL CONTRACT OF A CAMPAIGN PLAN.
//
//   1. Submit is fenced on the exact revision the submitter reviewed. A stale
//      submit conflicts atomically; a repeat of the accepted submission is a
//      duplicate, not a second write.
//   2. Readiness and Submit answer from ONE gate. For one revision, readiness
//      never says "ready" while Submit refuses — including the conversion goal
//      on a plan with no advertising channel.
//   3. The plan detail tells THIS viewer what they may do, by identity, in
//      booleans and sentences only. The commands still decide.
"use strict";

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/MarketingAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ success: false, message: "Authentication required." });
    const user = JSON.parse(raw);
    if (!["marketing", "admin", "ceo"].includes(user.role) && !user.isAdmin) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }
    req.user = user;
    next();
  };
  mw.withRoles = () => mw;
  mw.ALLOWED_ROLES = ["marketing", "admin", "ceo"];
  return mw;
});

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const service = require("../../services/marketing/campaignDrafts/campaignDraft.service");
const {
  MarketingCampaignDraft, MarketingCampaignDraftHistory,
} = require("../../models/CMS_Models/Marketing/MarketingCampaignDraft");

const oid = () => new mongoose.Types.ObjectId().toString();
const MARKETER = { id: oid(), name: "Mo", role: "marketing", email: "mo@grav.in" };
const MARKETER_TWO = { id: oid(), name: "Nia", role: "marketing", email: "nia@grav.in" };
const ADMIN = { id: oid(), name: "Ada", role: "admin", email: "ada@grav.in" };
/* Same display name, different person. */
const ADMIN_NAMESAKE = { id: oid(), name: "Ada", role: "admin", email: "ada.k@grav.in" };
const CEO = { id: oid(), name: "Cy", role: "ceo", email: "cy@grav.in" };

let server;
let base;
let A;
let B;
const savedSecret = process.env.MARKETING_CHANNEL_ID_SECRET;

beforeAll(async () => {
  const app = express();
  app.use((req, res, next) => {
    const c = String(req.headers["x-test-company"] || "");
    if (mongoose.Types.ObjectId.isValid(c)) req.__marketingCompanyId = new mongoose.Types.ObjectId(c);
    next();
  });
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/campaignDrafts"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/marketing`;
});

afterAll(async () => {
  if (savedSecret === undefined) delete process.env.MARKETING_CHANNEL_ID_SECRET;
  else process.env.MARKETING_CHANNEL_ID_SECRET = savedSecret;
  await new Promise((r) => server.close(r));
});

beforeEach(async () => {
  A = (await Acc_Company.create({ companyName: "GRAV Clothing", booksFromDate: new Date("2026-04-01") }))._id;
  B = (await Acc_Company.create({ companyName: "Other Co", booksFromDate: new Date("2026-04-01") }))._id;
  process.env.MARKETING_CHANNEL_ID_SECRET = "a-deployment-secret-long-enough";
});

const call = async (path, { method = "GET", user = MARKETER, body, company = null } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "x-test-user": JSON.stringify(user),
      "x-test-company": String(company || A),
      "Content-Type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
};

let seq = 0;
const fresh = (p) => `${p}-${Date.now()}-${(seq += 1)}`;

/* An email-only plan: complete, and with no advertising channel. */
const EMAIL_PLAN = Object.freeze({
  name: "Winter uniforms 2026",
  objective: "lead_generation",
  channels: ["email"],
  startDate: "2026-10-01",
  endDate: "2026-12-15",
  budgetAmount: 250000,
  budgetCurrency: "INR",
  budgetBasis: "total",
  conversionGoal: "qualified_prospect",
});

const create = async (over = {}, user = MARKETER, company = A) => {
  const body = { ...EMAIL_PLAN, utmCampaign: fresh("winter"), idempotencyKey: fresh("create-key-0000"), ...over };
  for (const [k, v] of Object.entries(body)) if (v === undefined) delete body[k];
  const res = await call("/campaign-drafts", { method: "POST", body, user, company });
  expect(res.status).toBe(201);
  return res.body.campaignDraft;
};

const path = (id, suffix = "") => `/campaign-drafts/${encodeURIComponent(id)}${suffix}`;
const detail = (id, user = MARKETER, company = A) => call(path(id), { user, company });
const submit = (id, expectedRevision, user = MARKETER, company = A) =>
  call(path(id, "/submit"), { method: "POST", user, company, body: { expectedRevision } });
const readiness = (id, user = MARKETER) => call(path(id, "/deployment-readiness"), { user });
const edit = (id, expectedRevision, changes, user = MARKETER) =>
  call(path(id), { method: "PATCH", user, body: { expectedRevision, ...changes } });
const decide = (id, decision, user, reason) =>
  call(path(id, "/decision"), { method: "POST", user, body: { decision, ...(reason ? { reason } : {}) } });

const submittedRows = async (plan) => MarketingCampaignDraftHistory.countDocuments({
  companyId: A, draftRef: plan.reference, kind: "submitted",
});

/* ═══════════════════════════════════════════════════════════════════════════
   1. THE SUBMIT FENCE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Submit is fenced on the revision the submitter reviewed", () => {
  test("1. expectedRevision is required, a whole number, and the only field", async () => {
    const plan = await create();
    for (const body of [{}, { expectedRevision: "1" }, { expectedRevision: 1.5 }, { expectedRevision: 0 }, { expectedRevision: null }]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call(path(plan.campaignDraftId, "/submit"), { method: "POST", body });
      expect(res.status).toBe(400);
    }
    const extra = await call(path(plan.campaignDraftId, "/submit"), { method: "POST", body: { expectedRevision: 1, state: "approved" } });
    expect(extra.status).toBe(400);
    expect(extra.body.error.details.unknown).toEqual(["state"]);
    expect((await detail(plan.campaignDraftId)).body.campaignDraft.state).toBe("draft");
  });

  test("2. a stale revision conflicts and moves nothing", async () => {
    const plan = await create();
    const edited = await edit(plan.campaignDraftId, plan.revision, { description: "Changed after review" }, MARKETER_TWO);
    expect(edited.status).toBe(200);

    const res = await submit(plan.campaignDraftId, plan.revision);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CAMPAIGN_DRAFT_REVISION_CONFLICT");
    expect(res.body.error.details).toMatchObject({ currentRevision: plan.revision + 1, sentRevision: plan.revision });
    const now = (await detail(plan.campaignDraftId)).body.campaignDraft;
    expect(now.state).toBe("draft");
    expect(await submittedRows(plan)).toBe(0);
  });

  test("3. a double-click on the same revision is one submission and one duplicate", async () => {
    const plan = await create();
    const first = await submit(plan.campaignDraftId, plan.revision);
    const second = await submit(plan.campaignDraftId, plan.revision);
    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBe(false);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.campaignDraft.revision).toBe(plan.revision + 1);
    expect(await submittedRows(plan)).toBe(1);
  });

  test("4. two submitters on the same revision at once: one submission, recorded to whoever won", async () => {
    const plan = await create();
    const [x, y] = await Promise.all([
      submit(plan.campaignDraftId, plan.revision, MARKETER),
      submit(plan.campaignDraftId, plan.revision, MARKETER_TWO),
    ]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect([x.body.duplicate, y.body.duplicate].sort()).toEqual([false, true]);
    expect(await submittedRows(plan)).toBe(1);

    const stored = await MarketingCampaignDraft.findOne({ companyId: A, draftRef: plan.reference });
    expect(stored.revision).toBe(plan.revision + 1);
    const winner = x.body.duplicate ? MARKETER_TWO : MARKETER;
    expect(String(stored.submittedBy.id)).toBe(winner.id);
    /* Each sees, by identity, whether it was their submission. */
    expect((await detail(plan.campaignDraftId, MARKETER)).body.viewerActions.submittedByYou).toBe(winner === MARKETER);
    expect((await detail(plan.campaignDraftId, MARKETER_TWO)).body.viewerActions.submittedByYou).toBe(winner === MARKETER_TWO);
  });

  test("5. an edit racing a submit: exactly one lands, and what was submitted is what the submitter saw", async () => {
    for (let round = 0; round < 4; round += 1) {
      // eslint-disable-next-line no-await-in-loop
      const plan = await create();
      // eslint-disable-next-line no-await-in-loop
      const [s, e] = await Promise.all([
        submit(plan.campaignDraftId, plan.revision),
        edit(plan.campaignDraftId, plan.revision, { description: `race ${round}` }, MARKETER_TWO),
      ]);
      /* Never both. */
      expect([s.status, e.status].filter((st) => st === 200)).toHaveLength(1);
      // eslint-disable-next-line no-await-in-loop
      const stored = await MarketingCampaignDraft.findOne({ companyId: A, draftRef: plan.reference });
      if (s.status === 200) {
        expect(stored.state).toBe("awaiting_approval");
        expect(stored.description || "").not.toBe(`race ${round}`);
      } else {
        expect(s.body.error.code).toMatch(/CAMPAIGN_DRAFT_(REVISION|STATE)_CONFLICT/);
        expect(stored.state).toBe("draft");
        expect(stored.description).toBe(`race ${round}`);
      }
    }
  });

  test("6. a stale submit after somebody else resubmitted a NEWER revision is a conflict, not a duplicate", async () => {
    const plan = await create();
    await submit(plan.campaignDraftId, plan.revision);
    const returned = await decide(plan.campaignDraftId, "return", ADMIN, "Tighten the audience.");
    expect(returned.status).toBe(200);
    const r = returned.body.campaignDraft.revision;
    const edited = await edit(plan.campaignDraftId, r, { description: "Tightened" }, MARKETER_TWO);
    await submit(plan.campaignDraftId, edited.body.campaignDraft.revision, MARKETER_TWO);

    /* Mo still has the returned revision open and presses Submit. */
    const stale = await submit(plan.campaignDraftId, r, MARKETER);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("CAMPAIGN_DRAFT_REVISION_CONFLICT");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   1b. THE FENCE AT THE SERVICE BOUNDARY — EVERY CALLER, NOT ONLY HTTP
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the service refuses an unfenced or stale submit, and mutates nothing", () => {
  /* Everything that could move: the plan document, byte for byte, and its history. */
  const snapshot = async (plan) => {
    const doc = await MarketingCampaignDraft.findOne({ companyId: A, draftRef: plan.reference }).lean();
    const rows = await MarketingCampaignDraftHistory.find({ companyId: A, draftRef: plan.reference })
      .sort({ revision: 1 }).lean();
    return JSON.stringify({ doc, rows });
  };
  const serviceSubmit = (plan, extra = {}) => service.submit({
    companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId, ...extra,
  });

  test("20. omitted, null or malformed expectedRevision: refused before anything is read or written", async () => {
    const plan = await create();
    const before = await snapshot(plan);
    for (const extra of [{}, { expectedRevision: undefined }, { expectedRevision: null },
      { expectedRevision: "1" }, { expectedRevision: 0 }, { expectedRevision: 1.5 }, { expectedRevision: NaN }]) {
      // eslint-disable-next-line no-await-in-loop
      await expect(serviceSubmit(plan, extra)).rejects.toMatchObject({ code: "VALIDATION", details: { field: "expectedRevision" } });
    }
    expect(await snapshot(plan)).toBe(before);
  });

  test("21. a stale revision on a draft: conflict, and the plan and its history are untouched", async () => {
    const plan = await create();
    await service.update({
      companyId: A, user: MARKETER_TWO, campaignDraftId: plan.campaignDraftId,
      payload: { description: "Changed after review", expectedRevision: plan.revision },
    });
    const before = await snapshot(plan);
    await expect(serviceSubmit(plan, { expectedRevision: plan.revision }))
      .rejects.toMatchObject({ code: "CAMPAIGN_DRAFT_REVISION_CONFLICT" });
    /* A revision from the future is just as stale. */
    await expect(serviceSubmit(plan, { expectedRevision: plan.revision + 5 }))
      .rejects.toMatchObject({ code: "CAMPAIGN_DRAFT_REVISION_CONFLICT" });
    expect(await snapshot(plan)).toBe(before);
  });

  test("22. an unfenced or stale repeat against an already-submitted plan is refused, not a duplicate", async () => {
    const plan = await create();
    await serviceSubmit(plan, { expectedRevision: plan.revision });
    const before = await snapshot(plan);

    /* The old state-only duplicate is gone: no revision, no answer. */
    await expect(serviceSubmit(plan)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(serviceSubmit(plan, { expectedRevision: null })).rejects.toMatchObject({ code: "VALIDATION" });
    /* The submitted revision itself is not a revision anybody reviewed. */
    await expect(serviceSubmit(plan, { expectedRevision: plan.revision + 1 }))
      .rejects.toMatchObject({ code: "CAMPAIGN_DRAFT_REVISION_CONFLICT" });
    expect(await snapshot(plan)).toBe(before);
  });

  test("23. only the exact accepted revision is idempotent", async () => {
    const plan = await create();
    const first = await serviceSubmit(plan, { expectedRevision: plan.revision });
    const before = await snapshot(plan);
    const again = await serviceSubmit(plan, { expectedRevision: plan.revision });
    expect(first.duplicate).toBe(false);
    expect(again).toMatchObject({ duplicate: true, revision: first.revision, state: "awaiting_approval" });
    expect(await snapshot(plan)).toBe(before);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. ONE GATE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("readiness and Submit answer from one gate", () => {
  const agree = async (plan) => {
    const ready = await readiness(plan.campaignDraftId);
    expect(ready.status).toBe(200);
    expect(ready.body.evaluatedRevision).toBe(plan.revision);
    const res = await submit(plan.campaignDraftId, plan.revision);
    /* The invariant: ready ⇔ Submit accepts, for this revision. */
    expect({ approvalReady: ready.body.approvalReady, accepted: res.status === 200 })
      .toEqual({ approvalReady: res.status === 200, accepted: res.status === 200 });
    return { ready: ready.body, res };
  };

  test("7. an email-only plan with no conversion goal is not ready, and Submit says the same", async () => {
    const plan = await create({ conversionGoal: undefined });
    const { ready, res } = await agree(plan);
    expect(ready.approvalReady).toBe(false);
    expect(ready.applicable).toBe(false);
    expect(ready.sections.missingFromPlan.map((f) => f.code)).toContain("CONVERSION_GOAL_MISSING");
    expect(res.status).toBe(400);
    expect(res.body.error.details.missing).toEqual(["conversionGoal"]);

    /* The viewer is told the same thing before pressing anything. */
    const view = (await detail(plan.campaignDraftId)).body.viewerActions;
    expect(view.submit).toMatchObject({ allowed: false, reasonCode: "PLAN_INCOMPLETE" });
    expect(view.submit.reason).toMatch(/conversionGoal/);
  });

  test("8. a complete email-only plan is ready, and Submit accepts it", async () => {
    const plan = await create();
    const { ready, res } = await agree(plan);
    expect(ready.approvalReady).toBe(true);
    expect(res.status).toBe(200);
  });

  test("9. the invariant holds across incomplete variants", async () => {
    /* Name, objective and channels are required at creation, so a draft can
       only lack the rest. */
    for (const over of [
      { startDate: undefined, endDate: undefined },
      { budgetAmount: undefined, budgetCurrency: undefined, budgetBasis: undefined },
      { conversionGoal: undefined, startDate: undefined, endDate: undefined },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const plan = await create(over);
      // eslint-disable-next-line no-await-in-loop
      const { ready } = await agree(plan);
      expect(ready.approvalReady).toBe(false);
    }
  });

  test("10. an advertising plan with an incomplete brief: readiness and Submit agree", async () => {
    const plan = await create({ channels: ["google_ads"] });
    const { ready, res } = await agree(plan);
    expect(ready.applicable).toBe(true);
    expect(ready.approvalReady).toBe(false);
    expect(res.body.error.code).toBe("CAMPAIGN_DRAFT_ADVERTISING_INCOMPLETE");
    expect(res.body.error.details.advertisingReadiness.evaluatedRevision).toBe(plan.revision);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. WHAT THIS VIEWER MAY DO
   ═══════════════════════════════════════════════════════════════════════════ */

describe("viewer-specific action eligibility", () => {
  test("11. a marketer on a complete draft: may edit, submit and cancel; may not decide", async () => {
    const plan = await create();
    const res = await detail(plan.campaignDraftId, MARKETER);
    const v = res.body.viewerActions;
    expect(v.evaluatedRevision).toBe(plan.revision);
    expect(v.submittedByYou).toBe(false);
    expect(v.edit.allowed).toBe(true);
    expect(v.submit.allowed).toBe(true);
    expect(v.cancel.allowed).toBe(true);
    expect(v.approve).toMatchObject({ allowed: false, reasonCode: "NOT_AVAILABLE_IN_STATE" });

    await submit(plan.campaignDraftId, plan.revision);
    const after = (await detail(plan.campaignDraftId, MARKETER)).body.viewerActions;
    expect(after.submittedByYou).toBe(true);
    expect(after.edit.allowed).toBe(false);
    expect(after.approve).toMatchObject({ allowed: false, reasonCode: "APPROVER_ONLY" });
    expect(after.return.allowed).toBe(false);
  });

  test("12. self-approval: the submitter is told before pressing, and the backend still refuses", async () => {
    const plan = await create({}, ADMIN);
    await submit(plan.campaignDraftId, plan.revision, ADMIN);

    const v = (await detail(plan.campaignDraftId, ADMIN)).body.viewerActions;
    expect(v.submittedByYou).toBe(true);
    expect(v.approve).toMatchObject({ allowed: false, reasonCode: "SELF_APPROVAL" });
    expect(v.approve.reason).toMatch(/somebody else/);
    expect(v.return.allowed).toBe(true);
    expect(v.reject.allowed).toBe(true);

    const refused = await decide(plan.campaignDraftId, "approve", ADMIN);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("CAMPAIGN_DRAFT_DECISION_FORBIDDEN");
  });

  test("13. same name, different person: identity decides, not the display name", async () => {
    const plan = await create({}, ADMIN);
    await submit(plan.campaignDraftId, plan.revision, ADMIN);

    const v = (await detail(plan.campaignDraftId, ADMIN_NAMESAKE)).body.viewerActions;
    expect(v.submittedByYou).toBe(false);
    expect(v.approve).toMatchObject({ allowed: true, reasonCode: null });
    const approved = await decide(plan.campaignDraftId, "approve", ADMIN_NAMESAKE);
    expect(approved.status).toBe(200);
    expect(approved.body.campaignDraft.state).toBe("approved");
  });

  test("14. the backend stays authoritative: a forged 'allowed' changes nothing", async () => {
    const plan = await create();
    await submit(plan.campaignDraftId, plan.revision);
    /* A marketer calling approve directly, whatever a screen showed. */
    const res = await decide(plan.campaignDraftId, "approve", MARKETER);
    expect(res.status).toBe(403);
    expect((await detail(plan.campaignDraftId)).body.campaignDraft.state).toBe("awaiting_approval");
  });

  test("15. an approver sees approve allowed only when the plan would pass the gate", async () => {
    const plan = await create();
    await submit(plan.campaignDraftId, plan.revision);
    const v = (await detail(plan.campaignDraftId, CEO)).body.viewerActions;
    expect(v.approve.allowed).toBe(true);
    expect(v.edit.allowed).toBe(false);
  });

  test("16. no raw identifier or email of anybody appears in the detail", async () => {
    const plan = await create({}, ADMIN);
    await submit(plan.campaignDraftId, plan.revision, ADMIN);
    const res = await detail(plan.campaignDraftId, ADMIN_NAMESAKE);
    const flat = JSON.stringify(res.body);
    for (const u of [ADMIN, ADMIN_NAMESAKE, MARKETER]) expect(flat).not.toContain(u.id);
    expect(JSON.stringify(res.body.viewerActions)).not.toMatch(/@|[0-9a-f]{24}/);
  });

  test("17. an unverifiable identity is told so and offered nothing", async () => {
    const plan = await create();
    const v = (await detail(plan.campaignDraftId, { id: "not-an-id", name: "Ghost", role: "admin" })).body.viewerActions;
    for (const action of ["edit", "submit", "approve", "return", "reject", "cancel"]) {
      expect(v[action]).toMatchObject({ allowed: false, reasonCode: "IDENTITY_UNVERIFIED" });
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. COMPANY ISOLATION
   ═══════════════════════════════════════════════════════════════════════════ */

describe("company isolation", () => {
  test("18. another company can neither read, judge, nor submit a plan", async () => {
    const plan = await create();
    const asB = { user: ADMIN, company: B };
    expect((await call(path(plan.campaignDraftId), asB)).status).toBe(404);
    expect((await call(path(plan.campaignDraftId, "/deployment-readiness"), asB)).status).toBe(404);
    const s = await submit(plan.campaignDraftId, plan.revision, ADMIN, B);
    expect(s.status).toBe(404);
    expect((await detail(plan.campaignDraftId)).body.campaignDraft.state).toBe("draft");
  });

  test("19. the same user in two companies: eligibility is per plan, per company", async () => {
    const inA = await create({}, ADMIN, A);
    const inB = await create({}, ADMIN, B);
    await submit(inA.campaignDraftId, inA.revision, ADMIN, A);

    expect((await detail(inA.campaignDraftId, ADMIN, A)).body.viewerActions.submittedByYou).toBe(true);
    const inBView = (await detail(inB.campaignDraftId, ADMIN, B)).body.viewerActions;
    expect(inBView.submittedByYou).toBe(false);
    expect(inBView.submit.allowed).toBe(true);
  });
});
