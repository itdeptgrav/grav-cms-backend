// test/marketing/campaign-drafts.test.js
//
// GRAV CAMPAIGN PLANS: TENANCY, PERMISSIONS, LIFECYCLE, REVISIONS, AUDIT.
//
// ── WHAT THIS SUITE IS MOST CONCERNED WITH ─────────────────────────────────
// Three failures would each be expensive and each would look like success:
//
//   1. An approval that activates something. `approved` is the word a reader
//      takes for "live", and the day a deployment chunk lands is the day a
//      convenient import could make it true retroactively.
//   2. An approval attached to a version nobody read, because the author kept
//      editing while it waited.
//   3. One company reading another's commercial plans through a leaked or
//      guessed identifier.
//
// The rest — budgets, dates, content references — are validation, and they are
// tested because a silently coerced budget is a number somebody acts on.
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
const {
  MarketingCampaignDraft, MarketingCampaignDraftHistory,
} = require("../../models/CMS_Models/Marketing/MarketingCampaignDraft");
const service = require("../../services/marketing/campaignDrafts/campaignDraft.service");
const draftIdentity = require("../../services/marketing/campaignDrafts/draftIdentity");
const campaignIdentity = require("../../services/marketing/channels/campaignIdentity");
const cursors = require("../../services/marketing/channels/campaignCursor");
const allocation = require("../../services/marketing/campaignDrafts/campaignAllocation.service");
const {
  MarketingCampaignRefCounter, MarketingCampaignIdentity, MarketingCampaignCreateIntent,
} = require("../../models/CMS_Models/Marketing/MarketingCampaignAllocation");

const MARKETER = { id: new mongoose.Types.ObjectId().toString(), name: "Mo", role: "marketing", email: "mo@grav.in" };
const MARKETER_TWO = { id: new mongoose.Types.ObjectId().toString(), name: "Nia", role: "marketing", email: "nia@grav.in" };
const ADMIN = { id: new mongoose.Types.ObjectId().toString(), name: "Ada", role: "admin", email: "ada@grav.in" };
const CEO = { id: new mongoose.Types.ObjectId().toString(), name: "Cy", role: "ceo", email: "cy@grav.in" };
/* Sales reaches the router's middleware and is refused there. Present so the
   "Sales has no approval role" claim is tested rather than asserted. */
const SALES = { id: new mongoose.Types.ObjectId().toString(), name: "Sam", role: "sales", email: "sam@grav.in" };

const ENV_KEYS = ["MARKETING_CHANNEL_ID_SECRET"];
const savedEnv = {};

let app;
let server;
let base;
let A;
let B;

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

  app = express();
  /* The company is injected under the memo key the router reads, so a
     cross-company test can present a company the actor is not in without a
     membership fixture for every case. Nothing else is bypassed — the signed
     identifier still has to match, and so does every selector. */
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
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await new Promise((r) => server.close(r));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(async () => {
  const a = await Acc_Company.create({ companyName: "GRAV Clothing", booksFromDate: new Date("2026-04-01") });
  const b = await Acc_Company.create({ companyName: "Other Co", booksFromDate: new Date("2026-04-01") });
  A = a._id;
  B = b._id;
  process.env.MARKETING_CHANNEL_ID_SECRET = "a-deployment-secret-long-enough";
});

const call = async (path, { method = "GET", user = MARKETER, body, company = null } = {}) => {
  /* ── SUBMIT SENDS THE REVISION THE SUBMITTER IS LOOKING AT ──────────────
     The contract requires `expectedRevision`. A test that does not care which
     revision behaves like a client: read the plan as this user, then send the
     revision it shows. Tests about the fence pass their own body. */
  if (method === "POST" && /\/submit$/.test(path) && body === undefined) {
    const viewed = await call(path.replace(/\/submit$/, ""), { user, company });
    body = { expectedRevision: viewed.body?.campaignDraft?.revision ?? 1 };
  }
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

/* A complete plan: everything submission requires. */
const COMPLETE = Object.freeze({
  name: "Winter uniforms 2026",
  objective: "lead_generation",
  description: "Hotel and hospital uniform enquiries for the winter order window.",
  /* ── A NON-ADVERTISING CHANNEL, DELIBERATELY ──────────────────────────────
     These tests are about the plan lifecycle, durability and concurrency, not about
     advertising. Submission and approval now consult the readiness evaluator for any
     plan that advertises, so an advertising fixture would need a complete brief in
     every one of them — and a lifecycle test failing because a headline is missing
     tests the wrong thing. The advertising gate is covered in
     `deployment-readiness.test.js`. */
  channels: ["email"],
  audienceReference: "Hospitality buyers, north India",
  qualificationNotes: "Properties with 50+ rooms that reordered last winter.",
  contentRefs: [{ kind: "landing_page", contentId: "41", capturedName: "Winter uniform guide" }],
  startDate: "2026-10-01",
  endDate: "2026-12-15",
  budgetAmount: 250000,
  budgetCurrency: "INR",
  budgetBasis: "total",
  conversionGoal: "qualified_prospect",
  utmCampaign: "winter-uniforms-2026",
});

/* ── EVERY CREATE CARRIES AN IDEMPOTENCY KEY ────────────────────────────────
   The same body field the prospect-handover submission uses, so this is the
   domain's existing convention rather than a new one. A fresh key per helper call
   by default, because these tests create independent plans; the idempotency tests
   below pass one deliberately. */
let keySeq = 0;
const freshKey = () => `create-key-${Date.now()}-${(keySeq += 1)}`.padEnd(12, "0");

const createPlan = async (overrides = {}, opts = {}) => {
  const body = { ...COMPLETE, ...overrides };
  if (!Object.prototype.hasOwnProperty.call(body, "idempotencyKey")) {
    body.idempotencyKey = freshKey();
  }
  const res = await call("/campaign-drafts", { method: "POST", body, ...opts });
  return res;
};

/** Create, submit, and return the submitted plan's public id and revision. */
const submittedPlan = async (overrides = {}) => {
  const created = await createPlan(overrides);
  expect(created.status).toBe(201);
  const id = created.body.campaignDraft.campaignDraftId;
  const submitted = await call(`/campaign-drafts/${encodeURIComponent(id)}/submit`, { method: "POST" });
  expect(submitted.status).toBe(200);
  return { id, plan: submitted.body.campaignDraft };
};

/* ═══════════════════════════════════════════════════════════════════════════
   1. NOTHING HERE CAN ACTIVATE ADVERTISING
   ═══════════════════════════════════════════════════════════════════════════ */

describe("a campaign plan is a GRAV document and activates nothing", () => {
  test("neither the router nor the service loads a provider client", () => {
    const fs = require("fs");
    const path = require("path");

    const files = [
      path.join(__dirname, "..", "..", "routes", "CMS_Routes", "Marketing", "campaignDrafts.js"),
      path.join(__dirname, "..", "..", "services", "marketing", "campaignDrafts", "campaignDraft.service.js"),
      path.join(__dirname, "..", "..", "services", "marketing", "campaignDrafts", "draftIdentity.js"),
    ];

    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      /* The structural half of the guarantee. If this fails, somebody has given
         the approval flow a way to reach an advertising account, and no amount of
         route testing would have caught it. */
      for (const forbidden of [
        /require\([^)]*googleAdsClient/,
        /require\([^)]*metaAdsClient/,
        /require\([^)]*googleAnalyticsClient/,
        /require\([^)]*channelHttp/,
        /require\(['"]axios['"]\)/,
        /require\([^)]*mauticClient/,
      ]) {
        expect(src).not.toMatch(forbidden);
      }
    }
  });

  test("an approved plan says in its own payload that nothing was deployed", async () => {
    const { id } = await submittedPlan();
    const decided = await call(`/campaign-drafts/${encodeURIComponent(id)}/decision`, {
      method: "POST", user: ADMIN, body: { decision: "approve" },
    });

    expect(decided.status).toBe(200);
    const plan = decided.body.campaignDraft;
    expect(plan.state).toBe("approved");
    /* `approved` is the word a reader takes for "live". These two fields are what
       stop a screen implying it. */
    expect(plan.deployed).toBe(false);
    expect(plan.deploymentMeans).toMatch(/creates it, paused/i);
    expect(plan.stateMeans).toMatch(/NOTHING has been created in any advertising channel/);
    expect(plan.stateMeans).toMatch(/no money can be spent/i);
  });

  test("nothing can set deployed through the write boundary", async () => {
    const created = await createPlan();
    const id = created.body.campaignDraft.campaignDraftId;

    for (const body of [
      { deployed: true, expectedRevision: 1 },
      { state: "approved", expectedRevision: 1 },
      { providerCampaignId: "20481", expectedRevision: 1 },
    ]) {
      const res = await call(`/campaign-drafts/${encodeURIComponent(id)}`, {
        method: "PATCH", body,
      });
      expect(res.status).toBe(400);
    }

    const after = await call(`/campaign-drafts/${encodeURIComponent(id)}`);
    expect(after.body.campaignDraft.deployed).toBe(false);
    expect(after.body.campaignDraft.state).toBe("draft");
  });

  test("the served vocabulary says approval commits no spending", async () => {
    const res = await call("/campaign-drafts");
    expect(res.body.vocabulary.ownership.approvalMeans).toMatch(/commits no spending/i);
    /* And who is not involved, said out loud rather than left to a reader to
       infer from an absence. */
    expect(res.body.vocabulary.ownership.salesRole).toBe("none");
  });

  test("no route on this router deletes, activates or pauses anything", () => {
    const router = require("../../routes/CMS_Routes/Marketing/campaignDrafts");
    const routes = [];
    for (const layer of router.stack) {
      if (!layer.route) continue;
      for (const [verb, used] of Object.entries(layer.route.methods)) {
        if (used) routes.push(`${verb.toUpperCase()} ${layer.route.path}`);
      }
    }
    expect(routes.sort()).toEqual([
      "GET /campaign-drafts",
      "GET /campaign-drafts/:campaignDraftId",
      "GET /campaign-drafts/:campaignDraftId/deployment-readiness",
      "PATCH /campaign-drafts/:campaignDraftId",
      "POST /campaign-drafts",
      "POST /campaign-drafts/:campaignDraftId/cancel",
      "POST /campaign-drafts/:campaignDraftId/decision",
      "POST /campaign-drafts/:campaignDraftId/submit",
    ]);
    /* Activation, pausing and deletion are absent, and each needs its own route
       rather than a branch inside one of these. The readiness route is a GET that
       evaluates and explains; it creates nothing, which is asserted directly in the
       readiness suite. */
    expect(routes.some((r) => r.startsWith("DELETE"))).toBe(false);
    expect(routes.some((r) => /activate|pause|publish/i.test(r))).toBe(false);
    expect(routes.filter((r) => /deploy/i.test(r)))
      .toEqual(["GET /campaign-drafts/:campaignDraftId/deployment-readiness"]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. TENANCY
   ═══════════════════════════════════════════════════════════════════════════ */

describe("one company never reads another's campaign plans", () => {
  test("a plan identifier from company A is refused for company B", async () => {
    const created = await createPlan();
    const id = created.body.campaignDraft.campaignDraftId;

    for (const [path, method] of [
      [`/campaign-drafts/${encodeURIComponent(id)}`, "GET"],
      [`/campaign-drafts/${encodeURIComponent(id)}/submit`, "POST"],
      [`/campaign-drafts/${encodeURIComponent(id)}/cancel`, "POST"],
    ]) {
      const res = await call(path, {
        method, company: B,
        body: method !== "POST" ? undefined : path.endsWith("/submit") ? { expectedRevision: 1 } : {},
      });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("CAMPAIGN_DRAFT_NOT_FOUND");
    }
  });

  test("a list shows only the asking company's plans", async () => {
    await createPlan({ name: "A's plan", utmCampaign: "a-plan" });
    await createPlan({ name: "B's plan", utmCampaign: "b-plan" }, { company: B });

    const forA = await call("/campaign-drafts");
    expect(forA.body.campaignDrafts).toHaveLength(1);
    expect(forA.body.campaignDrafts[0].name).toBe("A's plan");

    const forB = await call("/campaign-drafts", { company: B });
    expect(forB.body.campaignDrafts).toHaveLength(1);
    expect(forB.body.campaignDrafts[0].name).toBe("B's plan");
  });

  test("references restart per company, so volume is not inferable", async () => {
    const a = await createPlan({ utmCampaign: "a-one" });
    const b = await createPlan({ utmCampaign: "b-one" }, { company: B });

    expect(a.body.campaignDraft.reference).toMatch(/^MCP-\d{4}-0001$/);
    expect(b.body.campaignDraft.reference).toMatch(/^MCP-\d{4}-0001$/);
  });

  test("every stored row and history row carries the company", async () => {
    const created = await createPlan();
    const id = created.body.campaignDraft.campaignDraftId;
    await call(`/campaign-drafts/${encodeURIComponent(id)}/submit`, { method: "POST" });

    for (const row of await MarketingCampaignDraft.find({}).lean()) {
      expect(String(row.companyId)).toBe(String(A));
    }
    for (const row of await MarketingCampaignDraftHistory.find({}).lean()) {
      expect(String(row.companyId)).toBe(String(A));
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. THE OPAQUE IDENTIFIER
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the public plan identifier is opaque, signed and company-bound", () => {
  test("it carries no internal id and the reference is not a key", async () => {
    const created = await createPlan();
    const plan = created.body.campaignDraft;
    const stored = await MarketingCampaignDraft.findOne({}).lean();

    expect(plan).not.toHaveProperty("_id");
    expect(plan).not.toHaveProperty("id");
    expect(plan.campaignDraftId).not.toContain(String(stored._id));

    /* The human reference is published — it is what somebody quotes in a
       conversation — and it is NOT accepted as a path parameter, so knowing one
       grants nothing. */
    const byRef = await call(`/campaign-drafts/${encodeURIComponent(plan.reference)}`);
    expect(byRef.status).toBe(404);
  });

  test("a forged, modified or foreign identifier is refused with one message", async () => {
    const created = await createPlan();
    const good = created.body.campaignDraft.campaignDraftId;
    const stored = await MarketingCampaignDraft.findOne({}).lean();

    const messages = new Set();
    for (const bad of [
      "not-an-identifier",
      `${good}x`,
      good.slice(0, -3),
      /* Same plan, signed for another company. */
      draftIdentity.encodeDraftId({ companyId: String(B), draftId: String(stored._id) }),
      /* A hand-built payload with a plausible signature. */
      `${Buffer.from(`d1.${String(A)}.${String(stored._id)}`, "utf8").toString("base64url")}.AAAAAAAAAAAAAAAAAAAAAA`,
    ]) {
      const res = await call(`/campaign-drafts/${encodeURIComponent(bad)}`);
      expect(res.status).toBe(404);
      messages.add(res.body.error.message);
    }
    /* One message for every cause. Separating them would confirm which field a
       prober got wrong, and "this company exists" is what the identifier
       withholds. */
    expect(messages.size).toBe(1);
  });

  test("the plan, external-campaign and cursor signing purposes are all separate", () => {
    const created = draftIdentity.encodeDraftId({
      companyId: String(A), draftId: String(new mongoose.Types.ObjectId()),
    });

    /* A plan identifier accepted where an external campaign identifier was
       expected would turn a read of a GRAV document into a read of an advertising
       account. */
    expect(() => campaignIdentity.decodeCampaignId(created, { companyId: String(A) })).toThrow();
    expect(() => cursors.decodeCursor(created, { companyId: String(A), channel: "google_ads" })).toThrow();

    const external = campaignIdentity.encodeCampaignId({
      companyId: String(A), channel: "google_ads", providerCampaignId: "20481",
    });
    expect(() => draftIdentity.decodeDraftId(external, { companyId: String(A) })).toThrow();
  });

  test("without the signing secret, identifiers cannot be issued", () => {
    delete process.env.MARKETING_CHANNEL_ID_SECRET;
    expect(() => draftIdentity.encodeDraftId({
      companyId: String(A), draftId: String(new mongoose.Types.ObjectId()),
    })).toThrow(/cannot be issued/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. PERMISSIONS
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Marketing writes, an administrator decides, Sales has no part", () => {
  test("Sales cannot reach any of these routes", async () => {
    const created = await createPlan();
    const id = created.body.campaignDraft.campaignDraftId;

    for (const [path, method, body] of [
      ["/campaign-drafts", "POST", COMPLETE],
      ["/campaign-drafts", "GET", undefined],
      [`/campaign-drafts/${encodeURIComponent(id)}/submit`, "POST", {}],
      [`/campaign-drafts/${encodeURIComponent(id)}/decision`, "POST", { decision: "approve" }],
    ]) {
      const res = await call(path, { method, user: SALES, body });
      expect(res.status).toBe(403);
    }
  });

  test("Marketing may create, edit and submit but not decide", async () => {
    const { id } = await submittedPlan();

    const decided = await call(`/campaign-drafts/${encodeURIComponent(id)}/decision`, {
      method: "POST", user: MARKETER_TWO, body: { decision: "approve" },
    });
    expect(decided.status).toBe(403);
    expect(decided.body.error.code).toBe("CAMPAIGN_DRAFT_DECISION_FORBIDDEN");
    /* The refusal names who can, and who cannot. */
    expect(decided.body.error.message).toMatch(/administrator/i);
    expect(decided.body.error.message).toMatch(/Sales has no part/i);
  });

  test("an administrator and the CEO may both decide", async () => {
    for (const approver of [ADMIN, CEO]) {
      const { id } = await submittedPlan({ utmCampaign: `plan-${approver.role}` });
      const res = await call(`/campaign-drafts/${encodeURIComponent(id)}/decision`, {
        method: "POST", user: approver, body: { decision: "approve" },
      });
      expect(res.status).toBe(200);
      expect(res.body.campaignDraft.state).toBe("approved");
    }
  });

  test("an approver may not approve a plan they submitted themselves", async () => {
    /* An administrator may also write plans, deliberately. Without this check one
       person could write, submit and approve a budget commitment alone, and the
       audit trail would show two decisions by the same name and read as
       controlled. */
    const created = await createPlan({}, { user: ADMIN });
    const id = created.body.campaignDraft.campaignDraftId;
    await call(`/campaign-drafts/${encodeURIComponent(id)}/submit`, { method: "POST", user: ADMIN });

    const selfApprove = await call(`/campaign-drafts/${encodeURIComponent(id)}/decision`, {
      method: "POST", user: ADMIN, body: { decision: "approve" },
    });
    expect(selfApprove.status).toBe(403);
    expect(selfApprove.body.error.message).toMatch(/needs somebody else/i);

    /* Returning and rejecting your own are allowed: declining your own plan needs
       no second pair of eyes, and blocking it would trap an author who changed
       their mind. */
    const selfReturn = await call(`/campaign-drafts/${encodeURIComponent(id)}/decision`, {
      method: "POST", user: ADMIN, body: { decision: "return", reason: "Budget needs rework." },
    });
    expect(selfReturn.status).toBe(200);

    /* And a different administrator can approve it. */
    await call(`/campaign-drafts/${encodeURIComponent(id)}/submit`, { method: "POST", user: ADMIN });
    const other = await call(`/campaign-drafts/${encodeURIComponent(id)}/decision`, {
      method: "POST", user: CEO, body: { decision: "approve" },
    });
    expect(other.status).toBe(200);
    expect(other.body.campaignDraft.state).toBe("approved");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. THE LIFECYCLE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the lifecycle is a closed transition table", () => {
  test("draft → awaiting_approval → approved, with each step earning its timestamp", async () => {
    const created = await createPlan();
    const id = created.body.campaignDraft.campaignDraftId;

    expect(created.body.campaignDraft.state).toBe("draft");
    /* Not set at creation: a submittedAt written then would make every draft look
       submitted to any query testing for its presence. */
    expect(created.body.campaignDraft.submittedAt).toBeNull();
    expect(created.body.campaignDraft.decidedAt).toBeNull();

    const submitted = await call(`/campaign-drafts/${encodeURIComponent(id)}/submit`, { method: "POST" });
    expect(submitted.body.campaignDraft.state).toBe("awaiting_approval");
    expect(submitted.body.campaignDraft.submittedAt).toBeTruthy();
    expect(submitted.body.campaignDraft.submittedBy.name).toBe("Mo");
    expect(submitted.body.campaignDraft.decidedAt).toBeNull();

    const approved = await call(`/campaign-drafts/${encodeURIComponent(id)}/decision`, {
      method: "POST", user: ADMIN, body: { decision: "approve" },
    });
    expect(approved.body.campaignDraft.state).toBe("approved");
    expect(approved.body.campaignDraft.decidedAt).toBeTruthy();
    expect(approved.body.campaignDraft.decidedBy.name).toBe("Ada");
  });

  test("a submitted plan is immutable until it is returned", async () => {
    const { id } = await submittedPlan();

    const blocked = await call(`/campaign-drafts/${encodeURIComponent(id)}`, {
      method: "PATCH", body: { name: "Edited while waiting", expectedRevision: 2 },
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("CAMPAIGN_DRAFT_STATE_CONFLICT");
    /* The refusal says what would unfreeze it, because "conflict" alone leaves an
       author guessing whether to wait or to ask somebody. */
    expect(blocked.body.error.message).toMatch(/returned before it can be edited/i);

    const returned = await call(`/campaign-drafts/${encodeURIComponent(id)}/decision`, {
      method: "POST", user: ADMIN, body: { decision: "return", reason: "Narrow the audience." },
    });
    expect(returned.body.campaignDraft.state).toBe("returned");
    expect(returned.body.campaignDraft.editable).toBe(true);

    const edited = await call(`/campaign-drafts/${encodeURIComponent(id)}`, {
      method: "PATCH", body: { name: "Winter uniforms 2026 v2", expectedRevision: returned.body.campaignDraft.revision },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.campaignDraft.name).toBe("Winter uniforms 2026 v2");
  });

  test("a returned plan can be resubmitted, and the old decision reason is cleared", async () => {
    const { id } = await submittedPlan();
    await call(`/campaign-drafts/${encodeURIComponent(id)}/decision`, {
      method: "POST", user: ADMIN, body: { decision: "return", reason: "Budget too high." },
    });

    const resubmitted = await call(`/campaign-drafts/${encodeURIComponent(id)}/submit`, { method: "POST" });
    expect(resubmitted.body.campaignDraft.state).toBe("awaiting_approval");
    /* Leaving it would show the next approver the previous rejection as though it
       applied to the version in front of them. */
    expect(resubmitted.body.campaignDraft.decisionReason).toBe("");
    expect(resubmitted.body.campaignDraft.decidedAt).toBeNull();
  });

  test("a rejected plan is finished: not editable, not resubmittable", async () => {
    const { id } = await submittedPlan();
    const rejected = await call(`/campaign-drafts/${encodeURIComponent(id)}/decision`, {
      method: "POST", user: ADMIN, body: { decision: "reject", reason: "Not this quarter." },
    });
    expect(rejected.body.campaignDraft.state).toBe("rejected");
    expect(rejected.body.campaignDraft.terminal).toBe(true);
    expect(rejected.body.campaignDraft.availableActions).toEqual([]);

    const resubmit = await call(`/campaign-drafts/${encodeURIComponent(id)}/submit`, { method: "POST" });
    expect(resubmit.status).toBe(409);
    expect(resubmit.body.error.message).toMatch(/nothing further can be done/i);

    const edit = await call(`/campaign-drafts/${encodeURIComponent(id)}`, {
      method: "PATCH", body: { name: "x", expectedRevision: rejected.body.campaignDraft.revision },
    });
    expect(edit.status).toBe(409);
  });

  test("an approved plan cannot be edited back into a draft", async () => {
    const { id } = await submittedPlan();
    const approved = await call(`/campaign-drafts/${encodeURIComponent(id)}/decision`, {
      method: "POST", user: ADMIN, body: { decision: "approve" },
    });

    /* Editing an approved plan would carry the approval onto text nobody
       approved. Cancelling is the only move left. */
    const edit = await call(`/campaign-drafts/${encodeURIComponent(id)}`, {
      method: "PATCH", body: { name: "x", expectedRevision: approved.body.campaignDraft.revision },
    });
    expect(edit.status).toBe(409);
    expect(approved.body.campaignDraft.availableActions.map((a) => a.action)).toEqual(["cancel"]);
  });

  test("a draft cannot be approved without being submitted", async () => {
    const created = await createPlan();
    const id = created.body.campaignDraft.campaignDraftId;

    const res = await call(`/campaign-drafts/${encodeURIComponent(id)}/decision`, {
      method: "POST", user: ADMIN, body: { decision: "approve" },
    });
    expect(res.status).toBe(409);
    /* The refusal lists what IS available, so a client is not guessing. */
    expect(res.body.error.details.availableActions).toEqual(["submit", "cancel"]);
  });

  test("Marketing may withdraw before a decision; an approver stands down an approved plan", async () => {
    const { id } = await submittedPlan();
    const withdrawn = await call(`/campaign-drafts/${encodeURIComponent(id)}/cancel`, {
      method: "POST", body: { reason: "Order window moved." },
    });
    expect(withdrawn.body.campaignDraft.state).toBe("cancelled");

    const { id: second } = await submittedPlan({ utmCampaign: "second-plan" });
    await call(`/campaign-drafts/${encodeURIComponent(second)}/decision`, {
      method: "POST", user: ADMIN, body: { decision: "approve" },
    });

    /* Standing down an APPROVED plan is the approver's call, because the approval
       was theirs. */
    const marketerTries = await call(`/campaign-drafts/${encodeURIComponent(second)}/cancel`, {
      method: "POST", user: MARKETER, body: {},
    });
    expect(marketerTries.status).toBe(403);

    const approverCancels = await call(`/campaign-drafts/${encodeURIComponent(second)}/cancel`, {
      method: "POST", user: ADMIN, body: { reason: "Budget reallocated." },
    });
    expect(approverCancels.body.campaignDraft.state).toBe("cancelled");
  });

  test("an incomplete plan cannot be submitted, and the refusal lists everything missing", async () => {
    const created = await createPlan({
      budgetAmount: undefined, budgetCurrency: undefined, budgetBasis: undefined,
      startDate: undefined, endDate: undefined, conversionGoal: undefined,
    });
    expect(created.status).toBe(201);

    const res = await call(`/campaign-drafts/${encodeURIComponent(created.body.campaignDraft.campaignDraftId)}/submit`, { method: "POST" });
    expect(res.status).toBe(400);
    /* All at once, not one field per round trip. */
    expect(res.body.error.details.missing.sort())
      .toEqual(["budget", "conversionGoal", "endDate", "startDate"]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   6. DUPLICATE TRANSITIONS
   ═══════════════════════════════════════════════════════════════════════════ */

describe("a repeated transition is idempotent, not a second write", () => {
  test("a double submit writes one revision and one history row", async () => {
    const created = await createPlan();
    const id = created.body.campaignDraft.campaignDraftId;

    /* A double-click: the SAME revision, twice. */
    const seen = (await call(`/campaign-drafts/${encodeURIComponent(id)}`)).body.campaignDraft.revision;
    const first = await call(`/campaign-drafts/${encodeURIComponent(id)}/submit`, { method: "POST", body: { expectedRevision: seen } });
    const second = await call(`/campaign-drafts/${encodeURIComponent(id)}/submit`, { method: "POST", body: { expectedRevision: seen } });

    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBe(false);
    expect(second.status).toBe(200);
    /* A success, because the caller's intent is satisfied — and flagged, so a
       client can tell. */
    expect(second.body.duplicate).toBe(true);
    expect(second.body.campaignDraft.revision).toBe(first.body.campaignDraft.revision);

    const submits = await MarketingCampaignDraftHistory.countDocuments({ kind: "submitted" });
    expect(submits).toBe(1);
  });

  test("concurrent submits produce one transition", async () => {
    const created = await createPlan();
    const id = created.body.campaignDraft.campaignDraftId;

    const results = await Promise.all([
      call(`/campaign-drafts/${encodeURIComponent(id)}/submit`, { method: "POST" }),
      call(`/campaign-drafts/${encodeURIComponent(id)}/submit`, { method: "POST" }),
      call(`/campaign-drafts/${encodeURIComponent(id)}/submit`, { method: "POST" }),
    ]);

    /* Whatever the interleaving, the plan is submitted once. The unique index on
       (draft, revision) is what holds this under concurrency, where a
       read-then-check would not. */
    const stored = await MarketingCampaignDraft.findOne({}).lean();
    expect(stored.state).toBe("awaiting_approval");
    expect(await MarketingCampaignDraftHistory.countDocuments({ kind: "submitted" })).toBe(1);
    /* Every caller gets an honest answer: the winner a 200, the losers either a
       duplicate 200 or a 409 saying somebody moved it. None gets a database
       error — the conditional update is what makes that true, and relying on the
       history index alone surfaced a raw duplicate-key 500 carrying collection
       and index names. */
    for (const r of results) {
      expect([200, 409]).toContain(r.status);
      expect(JSON.stringify(r.body)).not.toMatch(/E11000|duplicate key|marketing_campaign_draft_history/);
    }
  });

  test("a repeated identical decision is a duplicate; a different one is a conflict", async () => {
    const { id } = await submittedPlan();

    const first = await call(`/campaign-drafts/${encodeURIComponent(id)}/decision`, {
      method: "POST", user: ADMIN, body: { decision: "approve" },
    });
    const again = await call(`/campaign-drafts/${encodeURIComponent(id)}/decision`, {
      method: "POST", user: ADMIN, body: { decision: "approve" },
    });

    expect(first.body.duplicate).toBe(false);
    expect(again.body.duplicate).toBe(true);
    expect(again.body.campaignDraft.revision).toBe(first.body.campaignDraft.revision);

    /* Changing an approval into a rejection is a NEW decision somebody must make
       from a state that allows it — not an overwrite of the recorded one. */
    const reversal = await call(`/campaign-drafts/${encodeURIComponent(id)}/decision`, {
      method: "POST", user: ADMIN, body: { decision: "reject", reason: "Changed my mind." },
    });
    expect(reversal.status).toBe(409);
    expect(await MarketingCampaignDraftHistory.countDocuments({ kind: "approved" })).toBe(1);
  });

  test("a repeated cancel is a duplicate", async () => {
    const created = await createPlan();
    const id = created.body.campaignDraft.campaignDraftId;

    await call(`/campaign-drafts/${encodeURIComponent(id)}/cancel`, { method: "POST", body: {} });
    const again = await call(`/campaign-drafts/${encodeURIComponent(id)}/cancel`, { method: "POST", body: {} });
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(await MarketingCampaignDraftHistory.countDocuments({ kind: "cancelled" })).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   7. REVISIONS
   ═══════════════════════════════════════════════════════════════════════════ */

describe("every write states the revision it is replacing", () => {
  test("a stale revision is refused and names the current one", async () => {
    const created = await createPlan();
    const id = created.body.campaignDraft.campaignDraftId;

    const first = await call(`/campaign-drafts/${encodeURIComponent(id)}`, {
      method: "PATCH", body: { name: "Edit one", expectedRevision: 1 },
    });
    expect(first.status).toBe(200);
    expect(first.body.campaignDraft.revision).toBe(2);

    /* A second editor who opened revision 1. Without this, their change silently
       replaces the first editor's. */
    const stale = await call(`/campaign-drafts/${encodeURIComponent(id)}`, {
      method: "PATCH", user: MARKETER_TWO, body: { name: "Edit two", expectedRevision: 1 },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("CAMPAIGN_DRAFT_REVISION_CONFLICT");
    expect(stale.body.error.details.currentRevision).toBe(2);

    const after = await call(`/campaign-drafts/${encodeURIComponent(id)}`);
    expect(after.body.campaignDraft.name).toBe("Edit one");
  });

  test("an omitted or coerced revision is refused", async () => {
    const created = await createPlan();
    const id = created.body.campaignDraft.campaignDraftId;

    const omitted = await call(`/campaign-drafts/${encodeURIComponent(id)}`, {
      method: "PATCH", body: { name: "No revision" },
    });
    expect(omitted.status).toBe(400);
    expect(omitted.body.error.details.field).toBe("expectedRevision");

    /* `Number("1")` is 1 and `Number(null)` is 0. Both would let a caller who
        does not know the revision pass by accident. */
    for (const value of ["1", null, 1.5, 0, true, [1]]) {
      const res = await call(`/campaign-drafts/${encodeURIComponent(id)}`, {
        method: "PATCH", body: { name: "Coerced", expectedRevision: value },
      });
      expect(res.status).toBe(400);
    }

    const after = await call(`/campaign-drafts/${encodeURIComponent(id)}`);
    expect(after.body.campaignDraft.revision).toBe(1);
  });

  test("a save that changes nothing creates no revision, and says so", async () => {
    const created = await createPlan();
    const id = created.body.campaignDraft.campaignDraftId;

    const noop = await call(`/campaign-drafts/${encodeURIComponent(id)}`, {
      method: "PATCH", body: { name: COMPLETE.name, expectedRevision: 1 },
    });

    expect(noop.status).toBe(200);
    /* Bumping the revision here would make every other open editor conflict for
       no reason and fill the history with rows recording nothing. */
    expect(noop.body.changed).toBe(false);
    expect(noop.body.changedFields).toEqual([]);
    expect(noop.body.campaignDraft.revision).toBe(1);
    expect(await MarketingCampaignDraftHistory.countDocuments({ kind: "edited" })).toBe(0);
  });

  test("each transition advances the revision exactly once", async () => {
    const created = await createPlan();
    const id = created.body.campaignDraft.campaignDraftId;
    expect(created.body.campaignDraft.revision).toBe(1);

    const submitted = await call(`/campaign-drafts/${encodeURIComponent(id)}/submit`, { method: "POST" });
    expect(submitted.body.campaignDraft.revision).toBe(2);

    const returned = await call(`/campaign-drafts/${encodeURIComponent(id)}/decision`, {
      method: "POST", user: ADMIN, body: { decision: "return", reason: "Tighten the audience." },
    });
    expect(returned.body.campaignDraft.revision).toBe(3);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   8. VALIDATION
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the write boundary refuses rather than coerces", () => {
  test("a negative, coerced or incomplete budget is refused", async () => {
    for (const [body, why] of [
      [{ budgetAmount: -1 }, "negative"],
      [{ budgetAmount: "250000" }, "a string, which is a client bug worth surfacing"],
      [{ budgetAmount: null }, "null, which Number() would turn into 0"],
      [{ budgetAmount: 250000, budgetCurrency: undefined, budgetBasis: undefined }, "no currency"],
      [{ budgetCurrency: "RUPEES" }, "not an ISO code"],
      [{ budgetBasis: "monthly" }, "not a basis GRAV has"],
    ]) {
      const res = await createPlan(body);
      expect(res.status).toBe(400);
    }

    /* And a zero budget IS allowed: a plan with no spend is a real plan, and
       refusing it would conflate "nothing" with "not stated". */
    const zero = await createPlan({ budgetAmount: 0, utmCampaign: "zero-budget" });
    expect(zero.status).toBe(201);
    expect(zero.body.campaignDraft.budget).toEqual({ amount: 0, currency: "INR", basis: "total" });
  });

  test("money is never published as a bare number", async () => {
    const created = await createPlan();
    const budget = created.body.campaignDraft.budget;
    expect(typeof budget).toBe("object");
    expect(budget.currency).toBe("INR");
    /* ₹50,000 total and ₹50,000 a day differ by a factor of thirty, and a plan
       that does not say which is one an approver reads the cheaper way. */
    expect(budget.basis).toBe("total");
  });

  test("impossible and reversed dates are refused", async () => {
    for (const body of [
      { startDate: "2026-02-31" },
      { startDate: "2025-02-29" },
      { endDate: "2026-13-01" },
      { startDate: "2026-12-15", endDate: "2026-10-01" },
      /* A plan running to 2126 is a typo in the year. */
      { endDate: "2126-10-01" },
    ]) {
      const res = await createPlan(body);
      expect(res.status).toBe(400);
    }

    /* A real leap day is fine. */
    const leap = await createPlan({ startDate: "2028-02-29", endDate: "2028-03-31", utmCampaign: "leap-plan" });
    expect(leap.status).toBe(201);
  });

  test("an empty or unsupported channel selection is refused", async () => {
    for (const channels of [[], ["tiktok_ads"], ["google_ads", "billboards"], "google_ads", [null]]) {
      const res = await createPlan({ channels });
      expect(res.status).toBe(400);
    }

    /* Duplicates are collapsed, not refused: selecting one channel twice in a UI
       is a harmless mistake and the stored value is what they meant. */
    const dupes = await createPlan({ channels: ["email", "email", "google_ads"], utmCampaign: "dupe-channels" });
    expect(dupes.status).toBe(201);
    expect(dupes.body.campaignDraft.channels).toEqual(["email", "google_ads"]);
  });

  test("content references must use the GRAV contentId contract", async () => {
    for (const contentRefs of [
      [{ kind: "newsletter", contentId: "1" }],
      [{ kind: "email" }],
      [{ kind: "email", contentId: "" }],
      /* A URL is not an identifier, and a provider API path would name the
         engine. */
      [{ kind: "email", contentId: "https://mautic.internal/api/emails/41" }],
      [{ kind: "email", contentId: "/api/emails/41" }],
      [{ kind: "email", contentId: 41 }],
      [{ kind: "email", contentId: "41", customHtml: "<b>hi</b>" }],
      "not-a-list",
    ]) {
      const res = await createPlan({ contentRefs });
      expect(res.status).toBe(400);
    }

    /* And a valid pair is stored with its snapshot labelled as one. */
    const ok = await createPlan({
      contentRefs: [{ kind: "email", contentId: "41", capturedName: "Winter intro" }],
      utmCampaign: "content-ok",
    });
    expect(ok.status).toBe(201);
    expect(ok.body.campaignDraft.contentRefs[0]).toMatchObject({
      kind: "email", contentId: "41", capturedName: "Winter intro",
    });
    expect(ok.body.campaignDraft.contentRefs[0].capturedAt).toBeTruthy();
  });

  test("the same content reference twice is stored once", async () => {
    const res = await createPlan({
      contentRefs: [
        { kind: "email", contentId: "41" },
        { kind: "email", contentId: "41", capturedName: "dup" },
        { kind: "form", contentId: "41" },
      ],
      utmCampaign: "dedupe-content",
    });
    expect(res.status).toBe(201);
    /* Two: the same id under a different KIND is a different asset. */
    expect(res.body.campaignDraft.contentRefs).toHaveLength(2);
  });

  test("a credential or a provider campaign id is refused by name, not ignored", async () => {
    for (const field of [
      "accessToken", "access_token", "refreshToken", "clientSecret", "developerToken",
      "providerCampaignId", "googleCampaignId", "metaCampaignId", "adAccountId",
      "customHtml", "trackingScript",
    ]) {
      const res = await createPlan({ [field]: "something" });
      expect(res.status).toBe(400);
      /* Silently dropping it would leave somebody believing GRAV holds their
         token. */
      expect(res.body.error.message).toMatch(/refused rather than saved|does not accept/i);
      expect(res.body.error.message).toContain(field);
    }
  });

  test("an unknown field is named in the refusal", async () => {
    const res = await createPlan({ prority: "high" });
    expect(res.status).toBe(400);
    expect(res.body.error.details.unknown).toEqual(["prority"]);
    expect(res.body.error.details.accepted).toContain("objective");
  });

  test("a UTM identity is lower-cased, validated, and unique among live plans", async () => {
    const upper = await createPlan({ utmCampaign: "Winter-Uniforms-2026" });
    expect(upper.status).toBe(201);
    /* Analytics tools treat `Winter` and `winter` as two campaigns, and a
       marketer then reconciles two halves of one number. */
    expect(upper.body.campaignDraft.utmCampaign).toBe("winter-uniforms-2026");

    for (const utmCampaign of ["has spaces", "-leading-hyphen", "slash/es", "q?uery"]) {
      const res = await createPlan({ utmCampaign });
      expect(res.status).toBe(400);
    }

    const clash = await createPlan({ name: "Second", utmCampaign: "winter-uniforms-2026" });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe("CAMPAIGN_DRAFT_UTM_TAKEN");
    /* Renaming somebody's campaign identity for them is not GRAV's decision. */
    expect(clash.body.error.message).toMatch(/indistinguishable row/i);
  });

  test("a cancelled or rejected plan keeps its campaign identity for ever", async () => {
    const first = await createPlan();
    await call(`/campaign-drafts/${encodeURIComponent(first.body.campaignDraft.campaignDraftId)}/cancel`, {
      method: "POST", body: { reason: "Not this year." },
    });

    /* ── THE CORRECTION ──────────────────────────────────────────────────────
       This used to succeed. It was wrong in a way that only shows up later: the
       moment any plan has EVER been deployed, its identity exists in the
       channels' click data and in every analytics report covering that period.
       Reusing it attaches a new campaign's sessions to the old campaign's
       history, and the merged row looks perfectly plausible. */
    const reuse = await createPlan({ name: "Reusing the identity" });
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.code).toBe("CAMPAIGN_DRAFT_UTM_TAKEN");
    expect(reuse.body.error.message).toMatch(/never released/i);

    /* A rejected plan holds it just as permanently. */
    const second = await createPlan({ name: "Second", utmCampaign: "spring-uniforms-2027" });
    const id = second.body.campaignDraft.campaignDraftId;
    await call(`/campaign-drafts/${encodeURIComponent(id)}/submit`, { method: "POST" });
    await call(`/campaign-drafts/${encodeURIComponent(id)}/decision`, {
      method: "POST", user: ADMIN, body: { decision: "reject", reason: "Not this quarter." },
    });

    const afterReject = await createPlan({ name: "Third", utmCampaign: "spring-uniforms-2027" });
    expect(afterReject.status).toBe(409);
  });

  test("another company may still use the same campaign identity", async () => {
    await createPlan();
    /* Uniqueness is per company. Two companies' analytics properties are
       separate, so their campaign identities cannot collide with each other. */
    const other = await createPlan({ name: "Their winter plan" }, { company: B });
    expect(other.status).toBe(201);
    expect(other.body.campaignDraft.utmCampaign).toBe("winter-uniforms-2026");
  });

  test("an edit cannot take an identity another plan holds, including a dead one", async () => {
    const first = await createPlan();
    await call(`/campaign-drafts/${encodeURIComponent(first.body.campaignDraft.campaignDraftId)}/cancel`, {
      method: "POST", body: { reason: "Withdrawn." },
    });

    const second = await createPlan({ name: "Second", utmCampaign: "other-identity" });
    const res = await call(`/campaign-drafts/${encodeURIComponent(second.body.campaignDraft.campaignDraftId)}`, {
      method: "PATCH", body: { utmCampaign: "winter-uniforms-2026", expectedRevision: 1 },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CAMPAIGN_DRAFT_UTM_TAKEN");

    /* And nothing was written: no revision, no history row. */
    const after = await call(`/campaign-drafts/${encodeURIComponent(second.body.campaignDraft.campaignDraftId)}`);
    expect(after.body.campaignDraft.revision).toBe(1);
    expect(after.body.campaignDraft.utmCampaign).toBe("other-identity");
    expect(after.body.history).toHaveLength(1);
  });

  test("an over-long name is refused, not truncated", async () => {
    const res = await createPlan({ name: "x".repeat(121) });
    expect(res.status).toBe(400);
    /* A name silently cut is a name the author did not write, and they will not
       notice until somebody reads it back to them. */
    expect(res.body.error.details.max).toBe(120);
  });

  test("a decision needs a reason to return or reject, and none to approve", async () => {
    const { id } = await submittedPlan();

    for (const decision of ["return", "reject"]) {
      const res = await call(`/campaign-drafts/${encodeURIComponent(id)}/decision`, {
        method: "POST", user: ADMIN, body: { decision },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.details.field).toBe("reason");
    }

    const approved = await call(`/campaign-drafts/${encodeURIComponent(id)}/decision`, {
      method: "POST", user: ADMIN, body: { decision: "approve" },
    });
    expect(approved.status).toBe(200);
  });

  test("an unknown decision word is refused by name", async () => {
    const { id } = await submittedPlan();
    for (const body of [{ decision: "defer" }, { decision: "" }, { decision: 1 }, {}, { decision: "approve", note: "x" }]) {
      const res = await call(`/campaign-drafts/${encodeURIComponent(id)}/decision`, {
        method: "POST", user: ADMIN, body,
      });
      expect(res.status).toBe(400);
    }
  });

  test("a malformed body is a refusal, not a crash", async () => {
    const res = await fetch(`${base}/campaign-drafts`, {
      method: "POST",
      headers: {
        "x-test-user": JSON.stringify(MARKETER),
        "x-test-company": String(A),
        "Content-Type": "application/json",
      },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  test("an out-of-range page size is refused, not clamped", async () => {
    for (const limit of ["0", "101", "twenty", "-1"]) {
      const res = await call(`/campaign-drafts?limit=${limit}`);
      expect(res.status).toBe(400);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   9. THE AUDIT HISTORY
   ═══════════════════════════════════════════════════════════════════════════ */

describe("history is append-only and records the whole story", () => {
  test("creation, edits and decisions each leave a row, in order", async () => {
    const created = await createPlan();
    const id = created.body.campaignDraft.campaignDraftId;

    await call(`/campaign-drafts/${encodeURIComponent(id)}`, {
      method: "PATCH", body: { budgetAmount: 300000, budgetCurrency: "INR", budgetBasis: "total", expectedRevision: 1 },
    });
    await call(`/campaign-drafts/${encodeURIComponent(id)}/submit`, { method: "POST" });
    await call(`/campaign-drafts/${encodeURIComponent(id)}/decision`, {
      method: "POST", user: ADMIN, body: { decision: "return", reason: "Split by region." },
    });

    const view = await call(`/campaign-drafts/${encodeURIComponent(id)}`);
    const kinds = view.body.history.map((h) => h.kind);
    expect(kinds).toEqual(["created", "edited", "submitted", "returned"]);

    /* The revisions are gap-free, which is what makes the sequence readable as a
       story rather than a set of events. */
    expect(view.body.history.map((h) => h.revision)).toEqual([1, 2, 3, 4]);

    const edit = view.body.history[1];
    expect(edit.changedFields).toEqual(["budget"]);
    expect(edit.before.budget).toMatchObject({ amount: 250000 });
    expect(edit.after.budget).toMatchObject({ amount: 300000 });

    const decision = view.body.history[3];
    expect(decision.fromState).toBe("awaiting_approval");
    expect(decision.toState).toBe("returned");
    expect(decision.reason).toBe("Split by region.");
    expect(decision.actor.name).toBe("Ada");
  });

  test("a history row cannot be updated or deleted", async () => {
    await createPlan();
    const row = await MarketingCampaignDraftHistory.findOne({});

    await expect(MarketingCampaignDraftHistory.updateOne({ _id: row._id }, { $set: { reason: "rewritten" } }))
      .rejects.toThrow(/append-only/i);
    await expect(MarketingCampaignDraftHistory.deleteOne({ _id: row._id }))
      .rejects.toThrow(/append-only/i);
    await expect(MarketingCampaignDraftHistory.findOneAndUpdate({ _id: row._id }, { $set: { kind: "approved" } }))
      .rejects.toThrow(/append-only/i);

    /* And the save path too, which the query middlewares do not cover. */
    row.reason = "rewritten";
    await expect(row.save()).rejects.toThrow(/append-only/i);

    const after = await MarketingCampaignDraftHistory.findById(row._id).lean();
    expect(after.reason).toBe("");
    expect(after.kind).toBe("created");
  });

  test("the audit records who acted, without becoming a directory lookup", async () => {
    const { id } = await submittedPlan();
    await call(`/campaign-drafts/${encodeURIComponent(id)}/decision`, {
      method: "POST", user: ADMIN, body: { decision: "approve" },
    });

    const view = await call(`/campaign-drafts/${encodeURIComponent(id)}`);
    const approval = view.body.history.find((h) => h.kind === "approved");
    expect(approval.actor).toEqual({ name: "Ada", role: "admin" });
    /* A snapshot, not a reference: an employee can be renamed or deactivated and
       the audit row must still say who acted. */
    expect(approval.actor).not.toHaveProperty("id");
    expect(approval.actor).not.toHaveProperty("email");
  });

  test("an edit records only the fields that moved", async () => {
    const created = await createPlan();
    const id = created.body.campaignDraft.campaignDraftId;

    await call(`/campaign-drafts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { name: "Renamed", description: COMPLETE.description, expectedRevision: 1 },
    });

    const view = await call(`/campaign-drafts/${encodeURIComponent(id)}`);
    const edit = view.body.history.find((h) => h.kind === "edited");
    /* The description was sent but unchanged, so it is not in the diff. A full
       snapshot per edit would store it every time and make the diff a reader
       wants something they have to compute. */
    expect(edit.changedFields).toEqual(["name"]);
    expect(Object.keys(edit.after)).toEqual(["name"]);
  });

  test("no history row names the internal email engine", async () => {
    const created = await createPlan({ channels: ["email"], utmCampaign: "email-only" });
    const id = created.body.campaignDraft.campaignDraftId;
    await call(`/campaign-drafts/${encodeURIComponent(id)}/submit`, { method: "POST" });

    const view = await call(`/campaign-drafts/${encodeURIComponent(id)}`);
    const text = JSON.stringify(view.body);
    expect(text).not.toMatch(/mautic/i);
    expect(text).not.toMatch(/MAUTIC_/);
    /* The channel is named — a marketer chose email — and what sends it is not. */
    expect(view.body.campaignDraft.channels).toEqual(["email"]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   10. THE SERVED VOCABULARY
   ═══════════════════════════════════════════════════════════════════════════ */

describe("a client never hard-codes a state, a label or a transition", () => {
  test("the lifecycle and its meanings travel with the data", async () => {
    const res = await call("/campaign-drafts");
    const v = res.body.vocabulary;

    expect(v.states.map((s) => s.code).sort())
      .toEqual(["approved", "awaiting_approval", "cancelled", "draft", "rejected", "returned"]);
    expect(v.decisions.map((d) => d.code)).toEqual(["approve", "return", "reject"]);
    expect(v.objectives.map((o) => o.code)).toContain("lead_generation");
    expect(v.conversionGoals.map((g) => g.code)).toContain("qualified_prospect");
    expect(v.contentKinds.map((k) => k.code)).toEqual(["email", "form", "landing_page"]);

    /* Every state explains what it does NOT mean, which is the part a screen has
       to carry. */
    const approved = v.states.find((s) => s.code === "approved");
    expect(approved.means).toMatch(/NOTHING has been created/);
  });

  test("available actions come from the server, not a client's guess", async () => {
    const created = await createPlan();
    expect(created.body.campaignDraft.availableActions).toEqual([
      { action: "submit", to: "awaiting_approval", actor: "marketing" },
      { action: "cancel", to: "cancelled", actor: "marketing" },
    ]);

    const { plan } = await submittedPlan({ utmCampaign: "actions-plan" });
    expect(plan.availableActions.map((a) => a.action).sort())
      .toEqual(["approve", "cancel", "reject", "return"]);
    /* And who may do each. A client rendering an approve button for a marketer
       would render one the server refuses. */
    const approve = plan.availableActions.find((a) => a.action === "approve");
    expect(approve.actor).toBe("approver");
    expect(plan.availableActions.find((a) => a.action === "cancel").actor).toBe("marketing");
  });

  test("a conversion goal says who counts it", async () => {
    const res = await call("/campaign-drafts");
    const goals = res.body.vocabulary.conversionGoals;
    /* GRAV-owned goals are the ones that will eventually be comparable across
       channels; provider- and analytics-counted ones are not. */
    expect(goals.find((g) => g.code === "qualified_prospect").owner).toBe("grav");
    expect(goals.find((g) => g.code === "channel_conversion").owner).toBe("provider");
    expect(goals.find((g) => g.code === "page_view").owner).toBe("analytics");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   11. DURABILITY: AN INTERRUPTED COMMAND REPAIRS, IT DOES NOT DUPLICATE
   ═══════════════════════════════════════════════════════════════════════════

   The bug these exist for: the first version changed the plan and then appended
   history. An interruption between the two left the plan changed with a permanent
   hole in its trail, and a retry saw the target state, answered `duplicate: true`
   and never repaired it. The gap was undetectable because nothing recorded that a
   row was owed.

   History is now written first, carrying the complete plan for that revision, so
   the gap is detectable — history holds a revision the plan does not — and
   repairable deterministically. These tests interrupt at each stage and prove it.

   They drive the service directly, because the injection seam is not reachable
   from a route and a test asserting otherwise would be asserting a hole. */

describe("an interrupted command leaves a repairable record, never a hole", () => {
  const boom = (stage) => {
    const err = new Error(`injected outage at ${stage}`);
    err.__injected = true;
    return err;
  };

  const draftsFor = () => MarketingCampaignDraft.find({ companyId: A }).lean();
  const historyFor = (draftId) => MarketingCampaignDraftHistory
    .find({ companyId: A, draftId }).sort({ revision: 1 }).lean();

  const payloadFor = (overrides = {}) => ({ ...COMPLETE, idempotencyKey: freshKey(), ...overrides });

  /* ── STAGE 1: BEFORE THE HISTORY RESERVATION ──────────────────────────────
     Nothing is written at all. The correct outcome is no plan and no row — an
     outage before anything was recorded must not leave a half-created plan. */
  test("stage 1, create: interrupted before history writes nothing", async () => {
    await expect(service.create({
      companyId: A, user: MARKETER, payload: payloadFor(),
      hooks: { before_history: () => { throw boom("before_history"); } },
    })).rejects.toThrow(/injected outage/);

    expect(await draftsFor()).toHaveLength(0);
    expect(await MarketingCampaignDraftHistory.countDocuments({ companyId: A })).toBe(0);
  });

  /* ── STAGE 2: AFTER HISTORY, BEFORE THE PROJECTION ────────────────────────
     The decision is durably recorded and the plan does not exist yet. This is the
     state the protocol is designed around: detectable, and the row holds exactly
     what the plan must become. */
  test("stage 2, create: history is durable, the plan is not, and a read repairs it", async () => {
    await expect(service.create({
      companyId: A, user: MARKETER, payload: payloadFor(),
      hooks: { after_history: () => { throw boom("after_history"); } },
    })).rejects.toThrow(/injected outage/);

    /* Recorded. */
    const rows = await MarketingCampaignDraftHistory.find({ companyId: A }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].revision).toBe(1);
    expect(rows[0].kind).toBe("created");
    /* And the row carries the whole plan, which is what makes the repair
       deterministic rather than a guess. */
    expect(rows[0].resulting).toMatchObject({
      name: COMPLETE.name, objective: COMPLETE.objective, state: "draft",
      utmCampaign: COMPLETE.utmCampaign,
    });
    /* Not yet projected. */
    expect(await draftsFor()).toHaveLength(0);

    /* A read repairs it. */
    const repaired = await service.reconcileDraft({ companyId: A, draftId: rows[0].draftId });
    expect(repaired).toMatchObject({ repaired: true, toRevision: 1 });

    const plans = await draftsFor();
    expect(plans).toHaveLength(1);
    expect(plans[0].name).toBe(COMPLETE.name);
    expect(plans[0].revision).toBe(1);
    /* Exactly one row, still. The repair projects; it does not append. */
    expect(await MarketingCampaignDraftHistory.countDocuments({ companyId: A })).toBe(1);
  });

  test("stage 2, create: the list read reconciles without being asked", async () => {
    await expect(service.create({
      companyId: A, user: MARKETER, payload: payloadFor(),
      hooks: { after_history: () => { throw boom("after_history"); } },
    })).rejects.toThrow(/injected outage/);

    /* No explicit repair call. The ordinary read finishes the interrupted write,
       which is what replaces the scheduler this deployment does not have. */
    const view = await service.list({ companyId: A });
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0].name).toBe(COMPLETE.name);
    expect(await MarketingCampaignDraftHistory.countDocuments({ companyId: A })).toBe(1);
  });

  /* ── STAGE 3: AFTER THE PROJECTION, BEFORE THE RESPONSE ───────────────────
     Both halves are durable and the caller never learned. A retry must be a
     confirmed duplicate, not a second revision. */
  test("stage 3, create: both halves are durable and a retry adds nothing", async () => {
    await expect(service.create({
      companyId: A, user: MARKETER, payload: payloadFor(),
      hooks: { after_projection: () => { throw boom("after_projection"); } },
    })).rejects.toThrow(/injected outage/);

    const plans = await draftsFor();
    expect(plans).toHaveLength(1);
    expect(plans[0].revision).toBe(1);
    expect(await MarketingCampaignDraftHistory.countDocuments({ companyId: A })).toBe(1);

    /* Creation is not idempotent by nature — a retry is a new plan, with its own
       reference and its own identity. What must NOT happen is the first plan
       losing its row or gaining a second. */
    const retry = await service.create({
      companyId: A, user: MARKETER, payload: payloadFor({ utmCampaign: "retry-identity" }),
    });
    expect(retry.reference).toBe("MCP-2026-0002");
    expect(await MarketingCampaignDraftHistory.countDocuments({ companyId: A })).toBe(2);
  });

  /* ── STAGE 4: THE REPAIR ITSELF FAILS ─────────────────────────────────────
     The honest answer is neither success nor "nothing happened". 503, carrying
     GRAV's own stage and the revisions, and nothing from the driver. */
  test("stage 4: a repair that cannot be confirmed answers 503 with GRAV-owned detail", async () => {
    const created = await service.create({ companyId: A, user: MARKETER, payload: payloadFor() });
    const draftId = (await draftsFor())[0]._id;

    /* Interrupt a submit after its history row is durable. */
    await expect(service.submit({
      companyId: A, user: MARKETER, campaignDraftId: created.campaignDraftId, expectedRevision: created.revision,
      hooks: { after_history: () => { throw boom("after_history"); } },
    })).rejects.toThrow(/injected outage/);

    expect((await historyFor(draftId)).map((h) => h.revision)).toEqual([1, 2]);
    expect((await draftsFor())[0].revision).toBe(1);

    /* Now make the repair itself fail. */
    await expect(service.reconcileDraft({
      companyId: A, draftId, hooks: { before_repair: () => { throw boom("before_repair"); } },
    })).rejects.toThrow(/injected outage/);

    /* Still recorded, still unapplied, and nothing corrupted. */
    expect((await draftsFor())[0].revision).toBe(1);
    expect((await historyFor(draftId))).toHaveLength(2);

    /* And a caller told honestly. */
    let caught = null;
    try {
      await service.submit({
        companyId: A, user: MARKETER, campaignDraftId: created.campaignDraftId, expectedRevision: created.revision,
        hooks: { before_repair: () => { throw boom("before_repair"); } },
      });
    } catch (err) { caught = err; }
    expect(caught).toBeTruthy();
    expect(caught.__injected || caught.code === "CAMPAIGN_DRAFT_REPAIR_PENDING").toBe(true);
  });

  test("stage 4: the 503 leaks no driver, collection or index detail", async () => {
    const created = await service.create({ companyId: A, user: MARKETER, payload: payloadFor() });
    const draftId = (await draftsFor())[0]._id;

    /* A history row for a revision the plan cannot reach, because the row before
       it is missing. The replay refuses to paper over the gap. */
    await MarketingCampaignDraftHistory.create({
      companyId: A, draftId, draftRef: created.reference,
      kind: "edited", revision: 7, fromState: "draft", toState: "draft",
      actor: { id: new mongoose.Types.ObjectId(), name: "Mo", email: "mo@grav.in", role: "marketing" },
      resulting: { ...(await historyFor(draftId))[0].resulting, name: "From the future" },
      at: new Date(),
    });

    let caught = null;
    try {
      await service.update({
        companyId: A, user: MARKETER, campaignDraftId: created.campaignDraftId,
        payload: { name: "Anything", expectedRevision: 1 },
      });
    } catch (err) { caught = err; }

    expect(caught?.code).toBe("CAMPAIGN_DRAFT_REPAIR_PENDING");
    expect(caught.details.stage).toBe("history_gap");
    const text = JSON.stringify({ message: caught.message, details: caught.details });
    for (const leak of ["E11000", "duplicate key", "marketing_campaign_draft", "MongoServerError", "_1_revision_1"]) {
      expect(text).not.toContain(leak);
    }
    /* Only GRAV's own words. */
    expect(caught.details).toEqual({ stage: "history_gap", revision: 2, previousRevision: 1 });
  });

  /* ── STAGE 5: ACROSS EVERY COMMAND ────────────────────────────────────────
     The durability rule is one rule. A command that used a different one would be
     the command that loses a row. */
  test("stage 5: edit, submit and approve each repair the same way", async () => {
    const created = await service.create({ companyId: A, user: MARKETER, payload: payloadFor() });
    const id = created.campaignDraftId;
    const draftId = (await draftsFor())[0]._id;

    /* Edit, interrupted after history. */
    await expect(service.update({
      companyId: A, user: MARKETER, campaignDraftId: id,
      payload: { name: "Edited name", expectedRevision: 1 },
      hooks: { after_history: () => { throw boom("after_history"); } },
    })).rejects.toThrow(/injected outage/);
    expect((await draftsFor())[0].revision).toBe(1);
    expect(await service.reconcileDraft({ companyId: A, draftId })).toMatchObject({ repaired: true, toRevision: 2 });
    expect((await draftsFor())[0].name).toBe("Edited name");

    /* Submit, interrupted after history. The plan is at revision 2 now. */
    await expect(service.submit({
      companyId: A, user: MARKETER, campaignDraftId: id, expectedRevision: 2,
      hooks: { after_history: () => { throw boom("after_history"); } },
    })).rejects.toThrow(/injected outage/);
    expect((await draftsFor())[0].state).toBe("draft");
    expect(await service.reconcileDraft({ companyId: A, draftId })).toMatchObject({ repaired: true, toRevision: 3 });
    expect((await draftsFor())[0].state).toBe("awaiting_approval");

    /* Approve, interrupted after history. */
    await expect(service.decide({
      companyId: A, user: ADMIN, campaignDraftId: id, decision: "approve",
      hooks: { after_history: () => { throw boom("after_history"); } },
    })).rejects.toThrow(/injected outage/);
    expect((await draftsFor())[0].state).toBe("awaiting_approval");

    /* And a RETRY of the approval repairs and reports a confirmed duplicate —
       the distinction the first version got wrong, because it answered duplicate
       from the plan's state alone while a row was still missing. */
    const retry = await service.decide({
      companyId: A, user: ADMIN, campaignDraftId: id, decision: "approve",
    });
    expect(retry.duplicate).toBe(true);
    expect(retry.state).toBe("approved");

    /* Every revision accounted for, each exactly once. */
    const rows = await historyFor(draftId);
    expect(rows.map((h) => h.revision)).toEqual([1, 2, 3, 4]);
    expect(rows.map((h) => h.kind)).toEqual(["created", "edited", "submitted", "approved"]);
    expect((await draftsFor())[0].revision).toBe(4);
  });

  test("stage 5: cancellation follows the same rule", async () => {
    const created = await service.create({ companyId: A, user: MARKETER, payload: payloadFor() });
    const draftId = (await draftsFor())[0]._id;

    await expect(service.cancel({
      companyId: A, user: MARKETER, campaignDraftId: created.campaignDraftId, reason: "Stood down.",
      hooks: { after_history: () => { throw boom("after_history"); } },
    })).rejects.toThrow(/injected outage/);

    expect((await draftsFor())[0].state).toBe("draft");
    const view = await service.detail({ companyId: A, campaignDraftId: created.campaignDraftId });
    /* The detail read reconciled it. */
    expect(view.draft.state).toBe("cancelled");
    expect((await historyFor(draftId)).map((h) => h.revision)).toEqual([1, 2]);
  });

  /* ── STAGE 6: ANOTHER COMPANY AT THE SAME REVISION NUMBERS ────────────────
     Two companies' plans both sit at revision 1, 2, 3. A reconciliation keyed on
     draft and revision alone could apply one company's row to the other's plan.
     The company is in every selector, and this proves it. */
  test("stage 6: an interrupted write in one company does not touch another's plan at the same revision", async () => {
    const inA = await service.create({ companyId: A, user: MARKETER, payload: payloadFor({ name: "A's plan" }) });
    const inB = await service.create({ companyId: B, user: MARKETER, payload: payloadFor({ name: "B's plan" }) });

    const planA = await MarketingCampaignDraft.findOne({ companyId: A }).lean();
    const planB = await MarketingCampaignDraft.findOne({ companyId: B }).lean();
    expect(planA.revision).toBe(1);
    expect(planB.revision).toBe(1);

    /* Interrupt A's edit to revision 2. B also has a revision 1 and no revision 2. */
    await expect(service.update({
      companyId: A, user: MARKETER, campaignDraftId: inA.campaignDraftId,
      payload: { name: "A edited", expectedRevision: 1 },
      hooks: { after_history: () => { throw boom("after_history"); } },
    })).rejects.toThrow(/injected outage/);

    /* Reconciling company B must find nothing to do. */
    const bRepair = await service.reconcileCompany({ companyId: B });
    expect(bRepair).toMatchObject({ repaired: 0 });

    const bAfter = await MarketingCampaignDraft.findOne({ companyId: B }).lean();
    expect(bAfter.name).toBe("B's plan");
    expect(bAfter.revision).toBe(1);

    /* And A repairs to its own row. */
    await service.reconcileCompany({ companyId: A });
    const aAfter = await MarketingCampaignDraft.findOne({ companyId: A }).lean();
    expect(aAfter.name).toBe("A edited");
    expect(aAfter.revision).toBe(2);

    /* B's history never gained a row. */
    expect(await MarketingCampaignDraftHistory.countDocuments({ companyId: B })).toBe(1);
  });

  test("a repeated reconcile is a no-op, and never appends", async () => {
    const created = await service.create({ companyId: A, user: MARKETER, payload: payloadFor() });
    const draftId = (await draftsFor())[0]._id;

    await expect(service.submit({
      companyId: A, user: MARKETER, campaignDraftId: created.campaignDraftId, expectedRevision: created.revision,
      hooks: { after_history: () => { throw boom("after_history"); } },
    })).rejects.toThrow(/injected outage/);

    const first = await service.reconcileDraft({ companyId: A, draftId });
    const second = await service.reconcileDraft({ companyId: A, draftId });
    const third = await service.reconcileDraft({ companyId: A, draftId });

    expect(first.repaired).toBe(true);
    expect(second).toMatchObject({ repaired: false, stage: "consistent" });
    expect(third).toMatchObject({ repaired: false, stage: "consistent" });
    expect((await historyFor(draftId))).toHaveLength(2);
    expect((await draftsFor())[0].revision).toBe(2);
  });

  test("every revision has exactly one history row, across a full lifecycle", async () => {
    const created = await service.create({ companyId: A, user: MARKETER, payload: payloadFor() });
    const id = created.campaignDraftId;
    const draftId = (await draftsFor())[0]._id;

    await service.update({ companyId: A, user: MARKETER, campaignDraftId: id, payload: { name: "v2", expectedRevision: 1 } });
    await service.submit({ companyId: A, user: MARKETER, campaignDraftId: id, expectedRevision: 2 });
    await service.decide({ companyId: A, user: ADMIN, campaignDraftId: id, decision: "return", reason: "Tighten it." });
    await service.update({ companyId: A, user: MARKETER, campaignDraftId: id, payload: { name: "v3", expectedRevision: 4 } });
    await service.submit({ companyId: A, user: MARKETER, campaignDraftId: id, expectedRevision: 5 });
    await service.decide({ companyId: A, user: CEO, campaignDraftId: id, decision: "approve" });

    const rows = await historyFor(draftId);
    const plan = (await draftsFor())[0];

    /* Gap-free, one per revision, and the plan sits on the last one. */
    expect(rows.map((h) => h.revision)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(rows.map((h) => h.revision)).size).toBe(rows.length);
    expect(plan.revision).toBe(7);

    /* And each row can reconstruct its own revision. */
    for (const row of rows) {
      expect(row.resulting).toBeTruthy();
      expect(row.resulting.state).toBe(row.toState);
      expect(row.resulting.draftRef).toBe(plan.draftRef);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   12. CONCURRENCY: ONE EDIT WINS, AND NOTHING OF THE LOSER SURVIVES
   ═══════════════════════════════════════════════════════════════════════════ */

describe("two edits from the same revision cannot both succeed", () => {
  /* Both callers are deferred to the same point before either writes, so the race
     is real rather than accidentally serialised by the event loop. */
  const deferred = () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    return { gate, release };
  };

  test("exactly one revision and one history row win", async () => {
    const created = await service.create({ companyId: A, user: MARKETER, payload: { ...COMPLETE, idempotencyKey: freshKey() } });
    const id = created.campaignDraftId;
    const draftId = (await MarketingCampaignDraft.findOne({ companyId: A }).lean())._id;

    const { gate, release } = deferred();
    let arrived = 0;
    const hold = async () => {
      arrived += 1;
      /* Both callers have validated and computed revision 2; neither has reserved
         it. Released together. */
      if (arrived === 2) release();
      await gate;
    };

    const results = await Promise.allSettled([
      service.update({
        companyId: A, user: MARKETER, campaignDraftId: id,
        payload: { name: "Edit from Mo", description: "Mo's description", expectedRevision: 1 },
        hooks: { before_history: hold },
      }),
      service.update({
        companyId: A, user: MARKETER_TWO, campaignDraftId: id,
        payload: { name: "Edit from Nia", budgetAmount: 999999, budgetCurrency: "INR", budgetBasis: "total", expectedRevision: 1 },
        hooks: { before_history: hold },
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    /* The loser is told what to reload, with the revision that actually won. */
    expect(rejected[0].reason.code).toBe("CAMPAIGN_DRAFT_REVISION_CONFLICT");
    expect(rejected[0].reason.details.currentRevision).toBe(2);
    expect(rejected[0].reason.details.sentRevision).toBe(1);

    /* One revision, one row. */
    const plan = await MarketingCampaignDraft.findOne({ companyId: A }).lean();
    expect(plan.revision).toBe(2);
    const rows = await MarketingCampaignDraftHistory.find({ companyId: A, draftId }).lean();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.revision === 2)).toHaveLength(1);
  });

  test("no field from the losing edit reaches the stored plan", async () => {
    const created = await service.create({ companyId: A, user: MARKETER, payload: { ...COMPLETE, idempotencyKey: freshKey() } });
    const id = created.campaignDraftId;

    const { gate, release } = deferred();
    let arrived = 0;
    const hold = async () => { arrived += 1; if (arrived === 2) release(); await gate; };

    const results = await Promise.allSettled([
      service.update({
        companyId: A, user: MARKETER, campaignDraftId: id,
        payload: { name: "Mo wins or loses", expectedRevision: 1 },
        hooks: { before_history: hold },
      }),
      service.update({
        companyId: A, user: MARKETER_TWO, campaignDraftId: id,
        /* Distinctive values that must not survive if this one loses. */
        payload: { description: "NIA ONLY", budgetAmount: 777777, budgetCurrency: "USD", budgetBasis: "daily", expectedRevision: 1 },
        hooks: { before_history: hold },
      }),
    ]);

    const loser = results.findIndex((r) => r.status === "rejected");
    const plan = await MarketingCampaignDraft.findOne({ companyId: A }).lean();

    if (loser === 1) {
      /* None of Nia's fields landed — not one, and not partially. The condition on
         the revision is what makes that true; a read-then-save would have written
         whichever arrived second. */
      expect(plan.description).not.toBe("NIA ONLY");
      expect(plan.budget.amount).toBe(250000);
      expect(plan.budget.currency).toBe("INR");
      expect(plan.name).toBe("Mo wins or loses");
    } else {
      expect(plan.name).not.toBe("Mo wins or loses");
      expect(plan.description).toBe("NIA ONLY");
      expect(plan.budget.amount).toBe(777777);
    }

    /* Either way: one revision beyond creation, and the plan is internally
       consistent with the row that won. */
    expect(plan.revision).toBe(2);
    const winningRow = await MarketingCampaignDraftHistory
      .findOne({ companyId: A, revision: 2 }).lean();
    expect(winningRow.resulting.name).toBe(plan.name);
    expect(winningRow.resulting.description).toBe(plan.description);
  });

  test("a transition racing an edit cannot attach approval to unreviewed content", async () => {
    const created = await service.create({ companyId: A, user: MARKETER, payload: { ...COMPLETE, idempotencyKey: freshKey() } });
    const id = created.campaignDraftId;

    const { gate, release } = deferred();
    let arrived = 0;
    const hold = async () => { arrived += 1; if (arrived === 2) release(); await gate; };

    /* An edit and a submit, both computed from revision 1 and released together. */
    const results = await Promise.allSettled([
      service.update({
        companyId: A, user: MARKETER, campaignDraftId: id,
        payload: { name: "Edited after submission?", expectedRevision: 1 },
        hooks: { before_history: hold },
      }),
      service.submit({
        companyId: A, user: MARKETER_TWO, campaignDraftId: id, expectedRevision: 1,
        hooks: { before_history: hold },
      }),
    ]);

    const plan = await MarketingCampaignDraft.findOne({ companyId: A }).lean();
    expect(plan.revision).toBe(2);

    /* Exactly one of them happened. The plan is either edited and still a draft,
       or submitted and unedited — never submitted WITH the edit, which is the
       state that would put an approver's decision on text they never saw. */
    const submitted = plan.state === "awaiting_approval";
    if (submitted) {
      expect(plan.name).toBe(COMPLETE.name);
    } else {
      expect(plan.state).toBe("draft");
      expect(plan.name).toBe("Edited after submission?");
    }

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rows = await MarketingCampaignDraftHistory.find({ companyId: A }).lean();
    expect(rows.filter((r) => r.revision === 2)).toHaveLength(1);
  });

  test("a submit that overtakes an in-flight edit carries the edit, and the edit cannot land after it", async () => {
    const created = await service.create({ companyId: A, user: MARKETER, payload: { ...COMPLETE, idempotencyKey: freshKey() } });
    const id = created.campaignDraftId;

    /* The edit pauses after reserving revision 2 and before projecting it. */
    let paused = null;
    const editPromise = service.update({
      companyId: A, user: MARKETER, campaignDraftId: id,
      payload: { name: "Edited while submitting", expectedRevision: 1 },
      hooks: { after_history: () => new Promise((r) => { paused = r; }) },
    });
    await new Promise((r) => setTimeout(r, 20));

    /* The submit's own load reconciles the edit in FIRST — the edit's row is
       durable, so it is part of the plan — and then submits revision 3. That is
       the correct outcome and worth stating plainly: the approver will read a plan
       that includes the edit, which is the content that was actually submitted.
       What must never happen is the reverse, and that is asserted below. */
    /* Submitted at revision 2: the edit's durable row is part of the plan the
       submitter is acting on. */
    const submitted = await service.submit({ companyId: A, user: MARKETER_TWO, campaignDraftId: id, expectedRevision: 2 });
    expect(submitted.state).toBe("awaiting_approval");
    expect(submitted.revision).toBe(3);
    expect(submitted.name).toBe("Edited while submitting");

    paused();
    await editPromise;

    const plan = await MarketingCampaignDraft.findOne({ companyId: A }).lean();
    /* The edit did not re-land on top of the submission. Its conditional update
       required an editable state AND revision 1, and the plan is now submitted at
       revision 3. */
    expect(plan.state).toBe("awaiting_approval");
    expect(plan.revision).toBe(3);

    /* Gap-free, one row per revision. */
    const rows = await MarketingCampaignDraftHistory
      .find({ companyId: A }).sort({ revision: 1 }).lean();
    expect(rows.map((h) => h.revision)).toEqual([1, 2, 3]);
    expect(rows.map((h) => h.kind)).toEqual(["created", "edited", "submitted"]);

    /* And no further edit can land now, which is the guarantee that keeps an
       approval attached to reviewed content. */
    await expect(service.update({
      companyId: A, user: MARKETER, campaignDraftId: id,
      payload: { name: "After submission", expectedRevision: 3 },
    })).rejects.toMatchObject({ code: "CAMPAIGN_DRAFT_STATE_CONFLICT" });
  });

  test("concurrent decisions produce one decision", async () => {
    const created = await service.create({ companyId: A, user: MARKETER, payload: { ...COMPLETE, idempotencyKey: freshKey() } });
    const id = created.campaignDraftId;
    await service.submit({ companyId: A, user: MARKETER, campaignDraftId: id, expectedRevision: 1 });

    const { gate, release } = deferred();
    let arrived = 0;
    const hold = async () => { arrived += 1; if (arrived === 2) release(); await gate; };

    const results = await Promise.allSettled([
      service.decide({ companyId: A, user: ADMIN, campaignDraftId: id, decision: "approve", hooks: { before_history: hold } }),
      service.decide({ companyId: A, user: CEO, campaignDraftId: id, decision: "reject", reason: "No.", hooks: { before_history: hold } }),
    ]);

    const plan = await MarketingCampaignDraft.findOne({ companyId: A }).lean();
    expect(["approved", "rejected"]).toContain(plan.state);
    expect(plan.revision).toBe(3);

    /* One decision row for revision 3, whichever won. */
    const rows = await MarketingCampaignDraftHistory.find({ companyId: A, revision: 3 }).lean();
    expect(rows).toHaveLength(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  test("the injection seam is not reachable from a route", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "..", "routes", "CMS_Routes", "Marketing", "campaignDrafts.js"), "utf8",
    );
    /* A route that forwarded hooks would let a caller choose where GRAV stops
       mid-write. */
    expect(src).not.toMatch(/hooks/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   13. A STABLE AUDIT ACTOR IS REQUIRED
   ═══════════════════════════════════════════════════════════════════════════ */

describe("nothing is written without an identity GRAV can attribute it to", () => {
  const NO_ID = { name: "Nobody", role: "admin", email: "nobody@grav.in" };
  const BAD_ID = { id: "not-an-object-id", name: "Malformed", role: "admin", email: "bad@grav.in" };
  const EMPTY = { id: "", name: "", role: "admin", email: "" };

  test("a create, edit, submit or decision with no stable actor writes nothing", async () => {
    for (const user of [NO_ID, BAD_ID, EMPTY]) {
      await expect(service.create({ companyId: A, user, payload: { ...COMPLETE, idempotencyKey: freshKey() } }))
        .rejects.toMatchObject({ code: "CAMPAIGN_DRAFT_ACTOR_UNVERIFIED" });
    }
    /* Not one row, not one plan. The check runs before anything is read. */
    expect(await MarketingCampaignDraft.countDocuments({})).toBe(0);
    expect(await MarketingCampaignDraftHistory.countDocuments({})).toBe(0);

    const created = await service.create({ companyId: A, user: MARKETER, payload: { ...COMPLETE, idempotencyKey: freshKey() } });
    const id = created.campaignDraftId;

    for (const user of [NO_ID, BAD_ID]) {
      await expect(service.update({ companyId: A, user, campaignDraftId: id, payload: { name: "x", expectedRevision: 1 } }))
        .rejects.toMatchObject({ code: "CAMPAIGN_DRAFT_ACTOR_UNVERIFIED" });
      await expect(service.submit({ companyId: A, user, campaignDraftId: id, expectedRevision: 1 }))
        .rejects.toMatchObject({ code: "CAMPAIGN_DRAFT_ACTOR_UNVERIFIED" });
      await expect(service.cancel({ companyId: A, user, campaignDraftId: id }))
        .rejects.toMatchObject({ code: "CAMPAIGN_DRAFT_ACTOR_UNVERIFIED" });
    }

    await service.submit({ companyId: A, user: MARKETER, campaignDraftId: id, expectedRevision: 1 });
    for (const user of [NO_ID, BAD_ID]) {
      await expect(service.decide({ companyId: A, user, campaignDraftId: id, decision: "approve" }))
        .rejects.toMatchObject({ code: "CAMPAIGN_DRAFT_ACTOR_UNVERIFIED" });
    }

    /* Still at the submitted revision: nothing moved. */
    const plan = await MarketingCampaignDraft.findOne({ companyId: A }).lean();
    expect(plan.revision).toBe(2);
    expect(plan.state).toBe("awaiting_approval");
  });

  test("an identity-less administrator cannot bypass the second-person rule", async () => {
    /* The failure this replaces: ids defaulted to null and the rule fell back to
       comparing emails, so two actors who were both "nobody" never compared equal
       and one person could approve their own submission. */
    const created = await service.create({ companyId: A, user: ADMIN, payload: { ...COMPLETE, idempotencyKey: freshKey() } });
    const id = created.campaignDraftId;
    await service.submit({ companyId: A, user: ADMIN, campaignDraftId: id, expectedRevision: 1 });

    await expect(service.decide({ companyId: A, user: { ...ADMIN, email: "" }, campaignDraftId: id, decision: "approve" }))
      .rejects.toMatchObject({ code: "CAMPAIGN_DRAFT_DECISION_FORBIDDEN" });

    /* A different id with the SAME display name and no email is still a different
       person, and may approve. The id is the authority; the name is a snapshot. */
    const other = { id: new mongoose.Types.ObjectId().toString(), name: "Ada", role: "admin", email: "" };
    const approved = await service.decide({ companyId: A, user: other, campaignDraftId: id, decision: "approve" });
    expect(approved.state).toBe("approved");
  });

  test("a plan whose submitter has no recorded id cannot be approved at all", async () => {
    const created = await service.create({ companyId: A, user: MARKETER, payload: { ...COMPLETE, idempotencyKey: freshKey() } });
    const id = created.campaignDraftId;
    await service.submit({ companyId: A, user: MARKETER, campaignDraftId: id, expectedRevision: 1 });

    /* Simulating a row from before the rule. GRAV cannot tell whether the approver
       is the submitter, and the safe answer is to refuse rather than to assume
       they are different. */
    await MarketingCampaignDraft.updateOne(
      { companyId: A }, { $set: { "submittedBy.id": null } },
    );

    await expect(service.decide({ companyId: A, user: ADMIN, campaignDraftId: id, decision: "approve" }))
      .rejects.toMatchObject({ code: "CAMPAIGN_DRAFT_DECISION_FORBIDDEN" });

    /* Returning it is still available, so nobody is stuck. */
    const returned = await service.decide({
      companyId: A, user: ADMIN, campaignDraftId: id, decision: "return", reason: "Resubmit please.",
    });
    expect(returned.state).toBe("returned");
  });

  test("the audit row stores the id and publishes only the display snapshot", async () => {
    const created = await service.create({ companyId: A, user: MARKETER, payload: { ...COMPLETE, idempotencyKey: freshKey() } });
    const row = await MarketingCampaignDraftHistory.findOne({ companyId: A }).lean();

    /* Stored. */
    expect(String(row.actor.id)).toBe(MARKETER.id);

    /* Published without it — an audit row says who acted and is not a directory
       lookup. */
    const view = await service.detail({ companyId: A, campaignDraftId: created.campaignDraftId });
    expect(view.history[0].actor).toEqual({ name: "Mo", role: "marketing" });
  });

  test("a route with a malformed actor writes nothing and answers 403", async () => {
    const res = await call("/campaign-drafts", {
      method: "POST", user: { name: "Ghost", role: "admin" }, body: COMPLETE,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CAMPAIGN_DRAFT_ACTOR_UNVERIFIED");
    expect(await MarketingCampaignDraft.countDocuments({})).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   14. SHARED IDENTITIES ARE SERIALISED ACROSS PLANS, NOT JUST WITHIN ONE
   ═══════════════════════════════════════════════════════════════════════════

   The flaw these close: the history-first protocol serialises revisions WITHIN a
   plan, because `(company, draft, revision)` is unique. Two concurrent creates
   mint different draft ids, so each reserved a perfectly valid history row with no
   collision — and both rows carried the same reference, or the same campaign
   identity, because both derived it from the same state a moment earlier. The plan
   collection's unique index then rejected one projection and left canonical,
   append-only history that could never be applied.

   Every shared identity is now claimed atomically BEFORE any history is written.
   These tests force each race and state the exact outcome. */

describe("two concurrent creates cannot take the same reference", () => {
  /* Released together, so both callers are past validation and neither has
     allocated anything when the race starts. */
  const barrier = (n) => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let arrived = 0;
    return async () => {
      arrived += 1;
      if (arrived === n) release();
      await gate;
    };
  };

  const planPayload = (over = {}) => ({ ...COMPLETE, idempotencyKey: freshKey(), ...over });

  test("both succeed, with distinct references and no orphan history", async () => {
    const hold = barrier(2);

    const results = await Promise.all([
      service.create({
        companyId: A, user: MARKETER,
        payload: planPayload({ name: "First", utmCampaign: "first-plan" }),
        hooks: { after_reference: hold },
      }),
      service.create({
        companyId: A, user: MARKETER_TWO,
        payload: planPayload({ name: "Second", utmCampaign: "second-plan" }),
        hooks: { after_reference: hold },
      }),
    ]);

    /* OUTCOME: both created. The reference comes from an atomic counter, so the
       two callers received 0001 and 0002 — never 0001 twice, which is what reading
       the largest existing reference allowed. */
    const refs = results.map((r) => r.reference).sort();
    expect(refs).toEqual(["MCP-2026-0001", "MCP-2026-0002"]);

    const plans = await MarketingCampaignDraft.find({ companyId: A }).lean();
    expect(plans).toHaveLength(2);
    expect(new Set(plans.map((p) => p.draftRef)).size).toBe(2);

    /* One history row each, and not one orphan: every row's draft exists. */
    const rows = await MarketingCampaignDraftHistory.find({ companyId: A }).lean();
    expect(rows).toHaveLength(2);
    const planIds = new Set(plans.map((p) => String(p._id)));
    for (const row of rows) expect(planIds.has(String(row.draftId))).toBe(true);
  });

  test("the counter is company-and-year scoped, and another company runs its own sequence", async () => {
    const a1 = await service.create({ companyId: A, user: MARKETER, payload: planPayload({ utmCampaign: "a-one" }) });
    const a2 = await service.create({ companyId: A, user: MARKETER, payload: planPayload({ utmCampaign: "a-two" }) });
    const b1 = await service.create({ companyId: B, user: MARKETER, payload: planPayload({ utmCampaign: "b-one" }) });

    /* OUTCOME: company A advances 0001 → 0002; company B starts again at 0001. */
    expect(a1.reference).toBe("MCP-2026-0001");
    expect(a2.reference).toBe("MCP-2026-0002");
    expect(b1.reference).toBe("MCP-2026-0001");

    const counters = await MarketingCampaignRefCounter.find({}).lean();
    expect(counters).toHaveLength(2);
    for (const c of counters) {
      expect([String(A), String(B)]).toContain(String(c.companyId));
      expect(c.year).toBe(2026);
    }
  });

  test("a gap after an interruption is acceptable and leaves no duplicate", async () => {
    /* Interrupted after the reference was allocated. Its number is spent. */
    await expect(service.create({
      companyId: A, user: MARKETER, payload: planPayload({ utmCampaign: "doomed" }),
      hooks: { after_reference: () => { throw new Error("injected outage"); } },
    })).rejects.toThrow(/injected outage/);

    /* A RETRY under a fresh key takes the next number, not the spent one — the
       sequence is a reference, not a count, and nothing reads it as one. */
    const next = await service.create({ companyId: A, user: MARKETER, payload: planPayload({ utmCampaign: "next-plan" }) });
    expect(next.reference).toBe("MCP-2026-0002");

    /* OUTCOME: 0001 is unused and 0002 exists. No two plans share a reference. */
    const plans = await MarketingCampaignDraft.find({ companyId: A }).lean();
    expect(plans).toHaveLength(1);
    expect(plans[0].draftRef).toBe("MCP-2026-0002");
  });
});

describe("two concurrent claims on one campaign identity", () => {
  const barrier = (n) => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let arrived = 0;
    return async () => { arrived += 1; if (arrived === n) release(); await gate; };
  };

  const planPayload = (over = {}) => ({ ...COMPLETE, idempotencyKey: freshKey(), ...over });

  test("creates: one success, one clean 409, and no orphan history", async () => {
    const hold = barrier(2);

    const results = await Promise.allSettled([
      service.create({
        companyId: A, user: MARKETER,
        payload: planPayload({ name: "Mo's plan", utmCampaign: "contested-identity" }),
        hooks: { before_identity: hold },
      }),
      service.create({
        companyId: A, user: MARKETER_TWO,
        payload: planPayload({ name: "Nia's plan", utmCampaign: "contested-identity" }),
        hooks: { before_identity: hold },
      }),
    ]);

    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");

    /* OUTCOME: exactly one plan, and the loser gets a 409 naming the field. */
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason.code).toBe("CAMPAIGN_DRAFT_UTM_TAKEN");
    expect(lost[0].reason.status).toBe(409);
    expect(lost[0].reason.details.field).toBe("utmCampaign");

    const plans = await MarketingCampaignDraft.find({ companyId: A }).lean();
    expect(plans).toHaveLength(1);

    /* ── THE POINT OF THE WHOLE CORRECTION ────────────────────────────────────
       The loser reserved NO history. Before this, it reserved a valid row under its
       own draft id, and that row could never be projected — canonical history with
       nowhere to go. */
    const rows = await MarketingCampaignDraftHistory.find({ companyId: A }).lean();
    expect(rows).toHaveLength(1);
    expect(String(rows[0].draftId)).toBe(String(plans[0]._id));

    /* One reservation, owned by the winner. */
    const reservations = await MarketingCampaignIdentity.find({ companyId: A }).lean();
    expect(reservations).toHaveLength(1);
    expect(String(reservations[0].draftId)).toBe(String(plans[0]._id));
  });

  test("edits: two plans changing to one identity give one success and one 409", async () => {
    const one = await service.create({ companyId: A, user: MARKETER, payload: planPayload({ name: "One", utmCampaign: "identity-one" }) });
    const two = await service.create({ companyId: A, user: MARKETER, payload: planPayload({ name: "Two", utmCampaign: "identity-two" }) });

    const hold = barrier(2);
    const results = await Promise.allSettled([
      service.update({
        companyId: A, user: MARKETER, campaignDraftId: one.campaignDraftId,
        payload: { utmCampaign: "both-want-this", expectedRevision: 1 },
        /* Met BEFORE the identity claim, which is the earliest point at which the
           two contend. Meeting at `before_history` would deadlock: by then one of
           them has already been refused and never arrives. */
        hooks: { before_identity: hold },
      }),
      service.update({
        companyId: A, user: MARKETER_TWO, campaignDraftId: two.campaignDraftId,
        payload: { utmCampaign: "both-want-this", expectedRevision: 1 },
        hooks: { before_identity: hold },
      }),
    ]);

    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");

    /* OUTCOME: one plan now holds it; the other is refused with a 409. */
    expect(won).toHaveLength(1);
    expect(lost[0].reason.code).toBe("CAMPAIGN_DRAFT_UTM_TAKEN");

    const plans = await MarketingCampaignDraft.find({ companyId: A }).sort({ draftRef: 1 }).lean();
    const holders = plans.filter((p) => p.utmCampaign === "both-want-this");
    expect(holders).toHaveLength(1);

    /* The LOSER gained no revision and no history row. */
    const loserRef = plans.find((p) => p.utmCampaign !== "both-want-this");
    expect(loserRef.revision).toBe(1);
    expect(await MarketingCampaignDraftHistory.countDocuments({ companyId: A, draftId: loserRef._id }))
      .toBe(1);

    /* And the winner has exactly two. */
    expect(await MarketingCampaignDraftHistory.countDocuments({ companyId: A, draftId: holders[0]._id }))
      .toBe(2);
  });

  test("an identity stays reserved after the holder changes to a different one", async () => {
    const plan = await service.create({ companyId: A, user: MARKETER, payload: planPayload({ utmCampaign: "original-identity" }) });

    await service.update({
      companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId,
      payload: { utmCampaign: "replacement-identity", expectedRevision: 1 },
    });

    /* OUTCOME: both rows exist, the old one marked superseded, and neither is
       available to another plan — the old identity may already be in click data. */
    const rows = await MarketingCampaignIdentity.find({ companyId: A }).sort({ at: 1 }).lean();
    expect(rows.map((r) => r.utmCampaign)).toEqual(["original-identity", "replacement-identity"]);
    expect(rows.map((r) => r.current)).toEqual([false, true]);

    await expect(service.create({
      companyId: A, user: MARKETER, payload: planPayload({ name: "Scavenger", utmCampaign: "original-identity" }),
    })).rejects.toMatchObject({ code: "CAMPAIGN_DRAFT_UTM_TAKEN" });
  });

  test("another company may hold the same campaign identity", async () => {
    await service.create({ companyId: A, user: MARKETER, payload: planPayload({ utmCampaign: "shared-word" }) });
    const inB = await service.create({ companyId: B, user: MARKETER, payload: planPayload({ utmCampaign: "shared-word" }) });

    /* OUTCOME: both succeed. Two companies' analytics properties are separate, so
       their identities cannot collide with each other. */
    expect(inB.utmCampaign).toBe("shared-word");
    const rows = await MarketingCampaignIdentity.find({ utmCampaign: "shared-word" }).lean();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => String(r.companyId))).size).toBe(2);
  });

  test("the reservation lookup is company-scoped", async () => {
    await service.create({ companyId: A, user: MARKETER, payload: planPayload({ utmCampaign: "a-only" }) });

    /* Company B asking about A's identity learns nothing and is not blocked. */
    expect(await allocation.identityOwner({ companyId: B, utmCampaign: "a-only" })).toBeNull();
    expect(await allocation.identityOwner({ companyId: A, utmCampaign: "a-only" })).toBeTruthy();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   15. CREATION IS RETRYABLE ACROSS EVERY INTERRUPTION
   ═══════════════════════════════════════════════════════════════════════════ */

describe("a retried creation continues, it never duplicates", () => {
  const KEY = "stable-create-key-0001";
  const planPayload = (over = {}) => ({ ...COMPLETE, idempotencyKey: KEY, ...over });

  const counts = async () => ({
    plans: await MarketingCampaignDraft.countDocuments({ companyId: A }),
    history: await MarketingCampaignDraftHistory.countDocuments({ companyId: A }),
    identities: await MarketingCampaignIdentity.countDocuments({ companyId: A }),
    intents: await MarketingCampaignCreateIntent.countDocuments({ companyId: A }),
  });

  /* The four interruption points, each resumed under the same key. */
  const resumePoints = [
    ["between reference allocation and identity reservation", "after_reference"],
    ["between identity reservation and campaign history", "after_identity"],
    ["between campaign history and the projection", "after_history"],
    ["between the projection and the response", "after_projection"],
  ];

  for (const [label, stage] of resumePoints) {
    test(`interrupted ${label}: the retry completes exactly once`, async () => {
      await expect(service.create({
        companyId: A, user: MARKETER, payload: planPayload(),
        hooks: { [stage]: () => { throw new Error("injected outage"); } },
      })).rejects.toThrow(/injected outage/);

      /* The retry carries the same key and the same payload. */
      const retry = await service.create({ companyId: A, user: MARKETER, payload: planPayload() });

      expect(retry.reference).toBe("MCP-2026-0001");
      expect(retry.state).toBe("draft");
      expect(retry.revision).toBe(1);
      expect(retry.utmCampaign).toBe(COMPLETE.utmCampaign);

      /* OUTCOME: exactly one of everything, whichever stage was interrupted. */
      expect(await counts()).toEqual({ plans: 1, history: 1, identities: 1, intents: 1 });

      /* And a third attempt changes nothing. */
      const again = await service.create({ companyId: A, user: MARKETER, payload: planPayload() });
      expect(again.reference).toBe("MCP-2026-0001");
      expect(await counts()).toEqual({ plans: 1, history: 1, identities: 1, intents: 1 });
    });
  }

  test("the same key returns the same campaign, flagged as a duplicate", async () => {
    const first = await service.create({ companyId: A, user: MARKETER, payload: planPayload() });
    const second = await service.create({ companyId: A, user: MARKETER, payload: planPayload() });

    /* OUTCOME: one plan, returned twice, and the second says so. */
    expect(second.campaignDraftId).toBe(first.campaignDraftId);
    expect(second.reference).toBe(first.reference);
    expect(second.duplicate).toBe(true);
    expect(first.duplicate).toBe(false);
    expect(await counts()).toEqual({ plans: 1, history: 1, identities: 1, intents: 1 });
  });

  test("the same key with a changed payload is refused", async () => {
    await service.create({ companyId: A, user: MARKETER, payload: planPayload() });

    await expect(service.create({
      companyId: A, user: MARKETER, payload: planPayload({ name: "A different plan", utmCampaign: "different-identity" }),
    })).rejects.toMatchObject({ code: "CAMPAIGN_DRAFT_KEY_REUSED", status: 409 });

    /* OUTCOME: nothing extra written. Answering with the first plan would have
       hidden the client's bug behind an apparent success. */
    expect(await counts()).toEqual({ plans: 1, history: 1, identities: 1, intents: 1 });
  });

  test("the fingerprint ignores key order and whitespace, not values", async () => {
    const base = planPayload();
    await service.create({ companyId: A, user: MARKETER, payload: base });

    /* Same values, different key order — the same creation. */
    const reordered = Object.fromEntries(Object.entries(base).reverse());
    const same = await service.create({ companyId: A, user: MARKETER, payload: reordered });
    expect(same.duplicate).toBe(true);

    /* A changed value is a different creation. */
    await expect(service.create({
      companyId: A, user: MARKETER, payload: { ...base, budgetAmount: 1 },
    })).rejects.toMatchObject({ code: "CAMPAIGN_DRAFT_KEY_REUSED" });
  });

  test("two concurrent requests with one key produce one campaign", async () => {
    const results = await Promise.allSettled([
      service.create({ companyId: A, user: MARKETER, payload: planPayload() }),
      service.create({ companyId: A, user: MARKETER, payload: planPayload() }),
    ]);

    /* OUTCOME: neither is an error beyond a recoverable one, and there is exactly
       one plan. Both callers either created it or were handed it. */
    const plans = await MarketingCampaignDraft.find({ companyId: A }).lean();
    expect(plans).toHaveLength(1);
    expect(await counts()).toMatchObject({ plans: 1, history: 1, intents: 1 });
    for (const r of results) {
      if (r.status === "rejected") {
        expect(["CAMPAIGN_DRAFT_REPAIR_PENDING", "CAMPAIGN_DRAFT_UTM_TAKEN"]).toContain(r.reason.code);
      }
    }
  });

  test("a key is strictly validated and may not be a credential", () => {
    for (const bad of ["", "short", "x".repeat(129), "has spaces", "slash/es", "Bearer abcdefghijkl", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"]) {
      expect(() => allocation.assertIdempotencyKey(bad)).toThrow();
    }
    for (const good of ["create-key-0001", "0191f2c4-5a7b-7c3d-8e9f-a1b2c3d4e5f6", "req.2026.09.11:0007"]) {
      expect(allocation.assertIdempotencyKey(good)).toBe(good);
    }
  });

  test("a create with no key is refused before anything is written", async () => {
    const { idempotencyKey, ...noKey } = planPayload();
    await expect(service.create({ companyId: A, user: MARKETER, payload: noKey }))
      .rejects.toMatchObject({ code: "CAMPAIGN_DRAFT_KEY_REQUIRED", status: 400 });
    expect(await counts()).toEqual({ plans: 0, history: 0, identities: 0, intents: 0 });
  });

  test("one key in two companies is two independent creations", async () => {
    const inA = await service.create({ companyId: A, user: MARKETER, payload: planPayload() });
    const inB = await service.create({ companyId: B, user: MARKETER, payload: planPayload() });

    /* OUTCOME: two plans. The intent is company-scoped, so a key one company uses
       cannot be claimed out from under another. */
    expect(inB.campaignDraftId).not.toBe(inA.campaignDraftId);
    expect(await MarketingCampaignCreateIntent.countDocuments({})).toBe(2);
    expect(await MarketingCampaignDraft.countDocuments({})).toBe(2);
  });

  test("every allocation lookup is company-scoped", async () => {
    await service.create({ companyId: A, user: MARKETER, payload: planPayload() });

    for (const col of [MarketingCampaignRefCounter, MarketingCampaignIdentity, MarketingCampaignCreateIntent]) {
      const rows = await col.find({}).lean();
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(String(row.companyId)).toBe(String(A));
    }
    /* And nothing was written for company B. */
    expect(await MarketingCampaignDraft.countDocuments({ companyId: B })).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   16. PENDING IS NOT THE SAME AS IMPOSSIBLE
   ═══════════════════════════════════════════════════════════════════════════ */

describe("a recorded command that cannot be applied is not called pending", () => {
  test("a history row claiming another plan's identity answers 409, not 503", async () => {
    const one = await service.create({ companyId: A, user: MARKETER, payload: { ...COMPLETE, idempotencyKey: freshKey(), utmCampaign: "taken-already" } });
    const two = await service.create({ companyId: A, user: MARKETER, payload: { ...COMPLETE, idempotencyKey: freshKey(), name: "Two", utmCampaign: "its-own" } });

    const twoId = (await MarketingCampaignDraft.findOne({ companyId: A, utmCampaign: "its-own" }).lean())._id;
    const newest = await MarketingCampaignDraftHistory.findOne({ companyId: A, draftId: twoId }).lean();

    /* A row that could only exist if it had bypassed the reservation — which is
       what the ordering now prevents, and what this branch exists to answer
       honestly for data written before it. */
    await MarketingCampaignDraftHistory.create({
      companyId: A, draftId: twoId, draftRef: newest.draftRef,
      kind: "edited", revision: 2, fromState: "draft", toState: "draft",
      actor: { id: new mongoose.Types.ObjectId(), name: "Mo", email: "mo@grav.in", role: "marketing" },
      resulting: { ...newest.resulting, utmCampaign: "taken-already" },
      at: new Date(),
    });

    let caught = null;
    try {
      await service.detail({ companyId: A, campaignDraftId: two.campaignDraftId });
    } catch (err) { caught = err; }

    /* OUTCOME: 409, terminal, and the message does NOT promise a later repair. */
    expect(caught?.code).toBe("CAMPAIGN_DRAFT_HISTORY_UNPROJECTABLE");
    expect(caught.status).toBe(409);
    expect(caught.details.stage).toBe("identity_owned_elsewhere");
    expect(caught.message).toMatch(/will not resolve on its own/i);
    expect(caught.message).not.toMatch(/nothing has been lost/i);
    expect(caught.message).not.toMatch(/reload in a moment/i);
  });

  test("reconciliation reaches the same stable answer every time, and writes nothing", async () => {
    const plan = await service.create({ companyId: A, user: MARKETER, payload: { ...COMPLETE, idempotencyKey: freshKey(), utmCampaign: "mine" } });
    const other = await service.create({ companyId: A, user: MARKETER, payload: { ...COMPLETE, idempotencyKey: freshKey(), name: "Other", utmCampaign: "theirs" } });

    const mineId = (await MarketingCampaignDraft.findOne({ companyId: A, utmCampaign: "mine" }).lean())._id;
    const newest = await MarketingCampaignDraftHistory.findOne({ companyId: A, draftId: mineId }).lean();

    await MarketingCampaignDraftHistory.create({
      companyId: A, draftId: mineId, draftRef: newest.draftRef,
      kind: "edited", revision: 2, fromState: "draft", toState: "draft",
      actor: { id: new mongoose.Types.ObjectId(), name: "Mo", email: "mo@grav.in", role: "marketing" },
      resulting: { ...newest.resulting, utmCampaign: "theirs" },
      at: new Date(),
    });

    const attempts = [];
    for (let i = 0; i < 4; i += 1) {
      attempts.push(await service.reconcileDraft({ companyId: A, draftId: mineId }));
    }

    /* OUTCOME: identical every time, terminal, and no revision advanced. A loop
       that kept trying would hammer the database for ever on one bad row. */
    for (const a of attempts) {
      expect(a).toMatchObject({ repaired: false, terminal: true, stage: "identity_owned_elsewhere" });
    }
    const after = await MarketingCampaignDraft.findById(mineId).lean();
    expect(after.revision).toBe(1);
    expect(after.utmCampaign).toBe("mine");
    expect(await MarketingCampaignDraftHistory.countDocuments({ companyId: A, draftId: mineId })).toBe(2);
  });

  test("a genuinely pending repair still says pending", async () => {
    const created = await service.create({ companyId: A, user: MARKETER, payload: { ...COMPLETE, idempotencyKey: freshKey() } });
    const draftId = (await MarketingCampaignDraft.findOne({ companyId: A }).lean())._id;

    await expect(service.submit({
      companyId: A, user: MARKETER, campaignDraftId: created.campaignDraftId, expectedRevision: created.revision,
      hooks: { after_history: () => { throw new Error("injected outage"); } },
    })).rejects.toThrow(/injected outage/);

    /* OUTCOME: this one IS applicable, so a read repairs it rather than refusing. */
    const view = await service.detail({ companyId: A, campaignDraftId: created.campaignDraftId });
    expect(view.draft.state).toBe("awaiting_approval");
    expect(view.draft.revision).toBe(2);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   17. THE LIST NEVER LOSES A RECORDED CREATION
   ═══════════════════════════════════════════════════════════════════════════ */

describe("pending creations are separate from ordinary pagination", () => {
  const payload = (over = {}) => ({ ...COMPLETE, idempotencyKey: freshKey(), ...over });
  const boom = () => { throw new Error("injected outage"); };

  /* A creation recorded but never projected. */
  const strandCreation = async (over = {}) => {
    await expect(service.create({
      companyId: A, user: MARKETER, payload: payload(over),
      hooks: { after_history: boom },
    })).rejects.toThrow(/injected outage/);
  };

  test("an interrupted creation is repaired by the list read and becomes an ordinary plan", async () => {
    await strandCreation();
    expect(await MarketingCampaignDraft.countDocuments({ companyId: A })).toBe(0);

    const view = await service.list({ companyId: A });

    /* Repaired in place, so it is an ordinary row and not a pending item. The
       author does not see their plan simply missing. */
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0].name).toBe(COMPLETE.name);
    expect(view.rows[0].repairPending).toBe(false);
    expect(view.pendingCreations).toMatchObject({ items: [], total: 0, capped: false });
    expect(view.page).toMatchObject({ total: 1, pages: 1 });
  });

  /* A creation that can never be projected: its reference is already taken. */
  const strandUnrepairable = async ({ reference, name, utmCampaign, state = "draft" }) => {
    const template = await MarketingCampaignDraftHistory.findOne({ companyId: A }).lean();
    const orphanId = new mongoose.Types.ObjectId();
    await MarketingCampaignDraftHistory.create({
      companyId: A, draftId: orphanId, draftRef: reference,
      kind: "created", revision: 1, fromState: null, toState: state,
      actor: { id: new mongoose.Types.ObjectId(), name: "Nia", email: "nia@grav.in", role: "marketing" },
      resulting: {
        ...template.resulting, draftRef: reference, name, utmCampaign, state,
      },
      at: new Date(),
    });
    return orphanId;
  };

  test("pending creations are never in campaignDrafts, and carry only safe fields", async () => {
    const held = await service.create({ companyId: A, user: MARKETER, payload: payload({ utmCampaign: "holder" }) });
    const ref = held.reference;

    const orphan = await strandUnrepairable({
      reference: ref, name: "Stuck plan", utmCampaign: "holder",
    });

    const view = await service.list({ companyId: A });

    /* The ordinary page holds the real plan only. */
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0].reference).toBe(ref);
    expect(view.page).toMatchObject({ total: 1, pages: 1 });

    /* And the stranded creation is in its own block. */
    expect(view.pendingCreations.total).toBe(1);
    const item = view.pendingCreations.items[0];
    expect(item.name).toBe("Stuck plan");
    expect(item.state).toBe("draft");
    expect(item.readable).toBe(false);
    expect(item.createdAt).toBeTruthy();

    /* ── ONLY THE SIX SAFE FIELDS ────────────────────────────────────────────
       No repair stage, no revision, no database id, nothing about a collection or
       a driver. */
    expect(Object.keys(item).sort())
      .toEqual(["campaignDraftId", "createdAt", "name", "readable", "reference", "state"]);

    const text = JSON.stringify(view);
    expect(text).not.toContain(String(orphan));
    expect(text).not.toMatch(/repairStage|identity_owned_elsewhere|reference_owned_elsewhere/);
    expect(text).not.toMatch(/marketing_campaign|E11000|MongoServerError/);

    /* The identifier is the same signed contract every other row uses. */
    expect(draftIdentity.decodeDraftId(item.campaignDraftId, { companyId: String(A) }))
      .toMatchObject({ draftId: String(orphan) });
  });

  test("ordinary pages keep their size and totals while pending items exist", async () => {
    /* Seven confirmed plans, two stranded creations, pages of three. */
    const refs = [];
    for (let i = 0; i < 7; i += 1) {
      const made = await service.create({
        companyId: A, user: MARKETER,
        payload: payload({ name: `Plan ${i}`, utmCampaign: `plan-${i}` }),
      });
      refs.push(made.reference);
    }
    await strandUnrepairable({ reference: refs[0], name: "Stranded one", utmCampaign: "plan-0" });
    await strandUnrepairable({ reference: refs[1], name: "Stranded two", utmCampaign: "plan-1" });

    const seen = [];
    for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
      const view = await service.list({ companyId: A, limit: 3, page: pageNumber });

      /* No page exceeds the requested size. The synthetic rows used to push a page
         over it. */
      expect(view.rows.length).toBeLessThanOrEqual(3);

      /* Totals describe confirmed plans and are the same on every page. */
      expect(view.page).toMatchObject({ total: 7, pages: 3, size: 3, number: pageNumber });

      /* The pending block is identical on every page, because its scope is the
         company and not the page. */
      expect(view.pendingCreations.total).toBe(2);
      expect(view.pendingCreations.items.map((i) => i.name).sort())
        .toEqual(["Stranded one", "Stranded two"]);

      for (const row of view.rows) seen.push(row.campaignDraftId);
    }

    /* Seven rows across three pages, no repeats — and no pending item among them. */
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    for (const view of [await service.list({ companyId: A, limit: 3, page: 1 })]) {
      const pendingIds = view.pendingCreations.items.map((i) => i.campaignDraftId);
      for (const id of pendingIds) expect(seen).not.toContain(id);
    }
  });

  test("no signed identifier is duplicated between ordinary rows and pending items", async () => {
    const made = await service.create({ companyId: A, user: MARKETER, payload: payload({ utmCampaign: "first" }) });
    await strandUnrepairable({ reference: made.reference, name: "Stranded", utmCampaign: "first" });

    const view = await service.list({ companyId: A });
    const all = [
      ...view.rows.map((r) => r.campaignDraftId),
      ...view.pendingCreations.items.map((i) => i.campaignDraftId),
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  test("a pending creation excluded by the state filter does not appear", async () => {
    const made = await service.create({ companyId: A, user: MARKETER, payload: payload({ utmCampaign: "held" }) });
    await strandUnrepairable({
      reference: made.reference, name: "Stranded draft", utmCampaign: "held", state: "draft",
    });

    /* Asking for approved plans: neither the draft plan nor the stranded draft
       creation belongs in the answer. */
    const approved = await service.list({ companyId: A, state: "approved" });
    expect(approved.rows).toHaveLength(0);
    expect(approved.page.total).toBe(0);
    expect(approved.pendingCreations.total).toBe(0);
    expect(approved.pendingCreations.items).toEqual([]);

    /* Asking for drafts: both. */
    const asDraft = await service.list({ companyId: A, state: "draft" });
    expect(asDraft.rows).toHaveLength(1);
    expect(asDraft.pendingCreations.total).toBe(1);
  });

  test("an existing plan that is behind its history stays an ordinary row, even off page one", async () => {
    /* Five plans, then the OLDEST is left behind its own history. The list sorts
       newest first, so it lands on the second page of three. */
    const plans = [];
    for (let i = 0; i < 5; i += 1) {
      plans.push(await service.create({
        companyId: A, user: MARKETER,
        payload: payload({ name: `Plan ${i}`, utmCampaign: `behind-${i}` }),
      }));
      await new Promise((r) => setTimeout(r, 5));
    }

    const oldest = plans[0];
    await expect(service.update({
      companyId: A, user: MARKETER, campaignDraftId: oldest.campaignDraftId,
      payload: { name: "Edited but unapplied", expectedRevision: 1 },
      hooks: { after_history: () => { throw new Error("injected outage"); } },
    })).rejects.toThrow(/injected outage/);

    const firstPage = await service.list({ companyId: A, limit: 3, page: 1 });

    /* ── EXISTENCE IS A COMPANY-WIDE QUESTION ────────────────────────────────
       The behind plan is not on page one. Deciding "does a plan exist" from the ids
       on the current page would have made it look like a pending creation here. */
    expect(firstPage.pendingCreations.total).toBe(0);
    expect(firstPage.page.total).toBe(5);

    /* It is an ordinary row wherever it appears. The list read repairs it, so by
       the time it is published it is no longer behind. */
    const secondPage = await service.list({ companyId: A, limit: 3, page: 2 });
    const row = secondPage.rows.find((r) => r.reference === oldest.reference);
    expect(row).toBeTruthy();
    expect(row.name).toBe("Edited but unapplied");
    expect(secondPage.pendingCreations.total).toBe(0);
  });

  test("the route publishes the documented shape", async () => {
    await createPlan();
    const res = await call("/campaign-drafts");

    expect(Object.keys(res.body).sort())
      .toEqual(["campaignDrafts", "page", "pendingCreations", "success", "vocabulary"]);
    expect(res.body.pendingCreations).toEqual({ items: [], total: 0, limit: 50, capped: false });
    expect(Object.keys(res.body.page).sort()).toEqual(["number", "pages", "size", "total"]);
    /* The old per-row operator array is gone from the top level. */
    expect(res.body).not.toHaveProperty("repairPending");
  });

  test("both ordinary and pending results are company-isolated", async () => {
    const inA = await service.create({ companyId: A, user: MARKETER, payload: payload({ name: "A's plan", utmCampaign: "a-name" }) });
    await strandUnrepairable({ reference: inA.reference, name: "A's stranded", utmCampaign: "a-name" });

    await service.create({ companyId: B, user: MARKETER, payload: payload({ name: "B's plan", utmCampaign: "b-name" }) });

    const forA = await service.list({ companyId: A });
    const forB = await service.list({ companyId: B });

    expect(forA.rows.map((r) => r.name)).toEqual(["A's plan"]);
    expect(forA.pendingCreations.items.map((i) => i.name)).toEqual(["A's stranded"]);

    /* Company B sees its own plan and none of A's anything. */
    expect(forB.rows.map((r) => r.name)).toEqual(["B's plan"]);
    expect(forB.pendingCreations.total).toBe(0);
    expect(JSON.stringify(forB)).not.toContain("A's stranded");
  });

  test("another company's pending creation never leaks, and repairs on its own read", async () => {
    await expect(service.create({
      companyId: B, user: MARKETER, payload: payload(),
      hooks: { after_history: boom },
    })).rejects.toThrow(/injected outage/);

    const forA = await service.list({ companyId: A });
    expect(forA.rows).toHaveLength(0);
    expect(forA.page.total).toBe(0);
    expect(forA.pendingCreations.total).toBe(0);

    const forB = await service.list({ companyId: B });
    expect(forB.rows).toHaveLength(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   18. CONCURRENT CREATION UNDER ONE KEY IS FENCED
   ═══════════════════════════════════════════════════════════════════════════

   The flaw: both callers read `intent.draftRef` as empty, both allocated a number,
   both wrote it. Last write won on the intent while each caller carried on with its
   own local number — so the intent could record MCP-2026-0002 for a plan that is
   actually MCP-2026-0001. An unused counter number is an acceptable gap; an intent
   disagreeing with its plan is not. */

describe("two concurrent creates under one key agree on one reference", () => {
  const KEY = "concurrent-create-key-01";
  const payload = () => ({ ...COMPLETE, idempotencyKey: KEY });

  const barrier = (n) => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let arrived = 0;
    return async () => { arrived += 1; if (arrived === n) release(); await gate; };
  };

  test("both resolve, one is the original and one a duplicate, on one reference", async () => {
    /* Released together, both past the intent claim and neither having established
       a reference. */
    const hold = barrier(2);

    const results = await Promise.allSettled([
      service.create({ companyId: A, user: MARKETER, payload: payload(), hooks: { before_identity: hold } }),
      service.create({ companyId: A, user: MARKETER_TWO, payload: payload(), hooks: { before_identity: hold } }),
    ]);

    /* OUTCOME: both succeed. Neither an identity conflict nor a pending repair is
       an acceptable answer here — both callers asked for the same creation under
       the same key, and the protocol exists so that both get it. */
    for (const r of results) {
      if (r.status === "rejected") {
        throw new Error(`a caller was refused: ${r.reason.code} ${r.reason.message}`);
      }
    }
    const [first, second] = results.map((r) => r.value);

    /* Exactly one original, exactly one duplicate. */
    expect([first.duplicate, second.duplicate].filter(Boolean)).toHaveLength(1);
    expect([first.duplicate, second.duplicate].filter((d) => d === false)).toHaveLength(1);

    /* The same plan, under the same signed identifier and the same reference. */
    expect(second.campaignDraftId).toBe(first.campaignDraftId);
    expect(second.reference).toBe(first.reference);

    /* ── AND ALL THREE RECORDS AGREE ON IT ───────────────────────────────────
       This is the assertion the flaw would have failed: the intent used to be able
       to record the loser's number. */
    const intent = await MarketingCampaignCreateIntent.findOne({ companyId: A, idempotencyKey: KEY }).lean();
    const plan = await MarketingCampaignDraft.findOne({ companyId: A }).lean();
    const row = await MarketingCampaignDraftHistory.findOne({ companyId: A }).lean();

    expect(intent.draftRef).toBe(first.reference);
    expect(plan.draftRef).toBe(first.reference);
    expect(row.draftRef).toBe(first.reference);
    expect(row.resulting.draftRef).toBe(first.reference);

    /* One of everything. */
    expect(await MarketingCampaignDraft.countDocuments({ companyId: A })).toBe(1);
    expect(await MarketingCampaignDraftHistory.countDocuments({ companyId: A })).toBe(1);
    expect(await MarketingCampaignIdentity.countDocuments({ companyId: A })).toBe(1);
    expect(await MarketingCampaignCreateIntent.countDocuments({ companyId: A })).toBe(1);
  });

  test("the loser's allocated number is an accepted gap, not a second plan", async () => {
    const hold = barrier(2);
    await Promise.all([
      service.create({ companyId: A, user: MARKETER, payload: payload(), hooks: { before_identity: hold } }),
      service.create({ companyId: A, user: MARKETER_TWO, payload: payload(), hooks: { before_identity: hold } }),
    ]);

    /* The counter advanced twice — both callers took a number — and only one was
       used. OUTCOME: a gap, which is cosmetic, instead of two plans claiming one
       reference, which cannot both exist. */
    const counter = await MarketingCampaignRefCounter.findOne({ companyId: A }).lean();
    expect(counter.seq).toBe(2);
    const plans = await MarketingCampaignDraft.find({ companyId: A }).lean();
    expect(plans).toHaveLength(1);
    expect(["MCP-2026-0001", "MCP-2026-0002"]).toContain(plans[0].draftRef);
  });

  test("three concurrent callers under one key still produce one plan", async () => {
    const hold = barrier(3);
    const results = await Promise.allSettled([
      service.create({ companyId: A, user: MARKETER, payload: payload(), hooks: { before_identity: hold } }),
      service.create({ companyId: A, user: MARKETER_TWO, payload: payload(), hooks: { before_identity: hold } }),
      service.create({ companyId: A, user: ADMIN, payload: payload(), hooks: { before_identity: hold } }),
    ]);

    for (const r of results) {
      if (r.status === "rejected") throw new Error(`refused: ${r.reason.code}`);
    }
    const refs = new Set(results.map((r) => r.value.reference));
    expect(refs.size).toBe(1);
    expect(results.filter((r) => r.value.duplicate === false)).toHaveLength(1);
    expect(await MarketingCampaignDraft.countDocuments({ companyId: A })).toBe(1);
  });

  test("the fenced allocation is company-scoped", async () => {
    const hold = barrier(2);
    /* Same key, two companies. Two independent creations, each with its own
       reference sequence starting at 0001. */
    const [inA, inB] = await Promise.all([
      service.create({ companyId: A, user: MARKETER, payload: payload(), hooks: { before_identity: hold } }),
      service.create({ companyId: B, user: MARKETER, payload: payload(), hooks: { before_identity: hold } }),
    ]);

    expect(inA.reference).toBe("MCP-2026-0001");
    expect(inB.reference).toBe("MCP-2026-0001");
    expect(inA.campaignDraftId).not.toBe(inB.campaignDraftId);
    expect(await MarketingCampaignCreateIntent.countDocuments({})).toBe(2);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   19. A PROVISIONAL CLAIM IS NOT YET A PERMANENT IDENTITY
   ═══════════════════════════════════════════════════════════════════════════

   "Never release an identity" was applied too early. An edit claimed an identity,
   lost the revision race, and held the name for ever on behalf of a revision that
   never existed — so a typo in a losing request permanently burned a name nobody
   ever used. A claim is provisional until the revision wanting it is accepted. */

describe("an identity claim commits on acceptance and resolves on loss", () => {
  const barrier = (n) => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let arrived = 0;
    return async () => { arrived += 1; if (arrived === n) release(); await gate; };
  };

  const newPlan = (over = {}) => service.create({
    companyId: A, user: MARKETER, payload: { ...COMPLETE, idempotencyKey: freshKey(), ...over },
  });

  test("one plan edited concurrently to two identities: one commits, the loser's is freed", async () => {
    const plan = await newPlan({ utmCampaign: "starting-identity" });
    const hold = barrier(2);

    const results = await Promise.allSettled([
      service.update({
        companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId,
        payload: { utmCampaign: "identity-a", expectedRevision: 1 },
        hooks: { before_history: hold },
      }),
      service.update({
        companyId: A, user: MARKETER_TWO, campaignDraftId: plan.campaignDraftId,
        payload: { utmCampaign: "identity-b", expectedRevision: 1 },
        hooks: { before_history: hold },
      }),
    ]);

    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");

    /* OUTCOME: exactly one revision 2. */
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason.code).toBe("CAMPAIGN_DRAFT_REVISION_CONFLICT");

    const stored = await MarketingCampaignDraft.findOne({ companyId: A }).lean();
    expect(stored.revision).toBe(2);
    const winningIdentity = stored.utmCampaign;
    const losingIdentity = winningIdentity === "identity-a" ? "identity-b" : "identity-a";

    /* The winner's claim is COMMITTED. */
    const winner = await MarketingCampaignIdentity.findOne({ companyId: A, utmCampaign: winningIdentity }).lean();
    expect(winner.status).toBe("committed");
    expect(winner.committedAt).toBeTruthy();

    /* ── AND THE LOSER'S IS GONE, NOT HELD FOR EVER ──────────────────────────
       The edit that lost never adopted the identity. Before this correction it
       stayed reserved permanently, burning a name on behalf of a revision that
       never happened. */
    expect(await MarketingCampaignIdentity.findOne({ companyId: A, utmCampaign: losingIdentity }).lean())
      .toBeNull();

    /* Which means another plan may now take it. */
    const other = await newPlan({ name: "Reuses the freed name", utmCampaign: losingIdentity });
    expect(other.utmCampaign).toBe(losingIdentity);
  });

  test("a provisional claim blocks another plan while it is in flight", async () => {
    const one = await newPlan({ utmCampaign: "plan-one" });
    const two = await newPlan({ name: "Two", utmCampaign: "plan-two" });

    /* The first edit pauses holding a provisional claim on the contested name. */
    let paused = null;
    const inFlight = service.update({
      companyId: A, user: MARKETER, campaignDraftId: one.campaignDraftId,
      payload: { utmCampaign: "contested", expectedRevision: 1 },
      hooks: { before_history: () => new Promise((r) => { paused = r; }) },
    });
    await new Promise((r) => setTimeout(r, 20));

    /* OUTCOME: the second plan cannot steal it, and the refusal says it may become
       available — which is true, and is different from a committed identity. */
    let caught = null;
    try {
      await service.update({
        companyId: A, user: MARKETER_TWO, campaignDraftId: two.campaignDraftId,
        payload: { utmCampaign: "contested", expectedRevision: 1 },
      });
    } catch (err) { caught = err; }

    expect(caught?.code).toBe("CAMPAIGN_DRAFT_UTM_TAKEN");
    expect(caught.details.claimState).toBe("in_flight");
    expect(caught.message).toMatch(/becomes available again/i);

    paused();
    await inFlight;

    /* And once the first edit is accepted, the claim is committed and the wording
       for a later attempt changes. */
    const committed = await MarketingCampaignIdentity.findOne({ companyId: A, utmCampaign: "contested" }).lean();
    expect(committed.status).toBe("committed");

    let second = null;
    try {
      await service.update({
        companyId: A, user: MARKETER_TWO, campaignDraftId: two.campaignDraftId,
        payload: { utmCampaign: "contested", expectedRevision: 1 },
      });
    } catch (err) { second = err; }
    expect(second.details.claimState).toBe("committed");
    expect(second.message).toMatch(/never released/i);
  });

  test("a retry of the same interrupted edit continues its own claim", async () => {
    const plan = await newPlan({ utmCampaign: "before-change" });

    /* Interrupted after claiming the identity and before reserving history. */
    await expect(service.update({
      companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId,
      payload: { utmCampaign: "after-change", expectedRevision: 1 },
      hooks: { before_history: () => { throw new Error("injected outage"); } },
    })).rejects.toThrow(/injected outage/);

    const claim = await MarketingCampaignIdentity.findOne({ companyId: A, utmCampaign: "after-change" }).lean();
    expect(claim.status).toBe("provisional");
    expect(claim.claimedAtRevision).toBe(2);

    /* OUTCOME: the retry recognises its own claim — the token is derived from the
       plan, the revision and the identity, so nothing is held in memory — and
       completes. One claim row, now committed. */
    const retried = await service.update({
      companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId,
      payload: { utmCampaign: "after-change", expectedRevision: 1 },
    });
    expect(retried.utmCampaign).toBe("after-change");
    expect(retried.revision).toBe(2);

    const rows = await MarketingCampaignIdentity.find({ companyId: A, utmCampaign: "after-change" }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("committed");
  });

  test("a crash between the claim and history is resolved once the outcome is decided", async () => {
    const plan = await newPlan({ utmCampaign: "original" });

    /* Crash after the claim, before history. The claim is for revision 2. */
    await expect(service.update({
      companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId,
      payload: { utmCampaign: "abandoned", expectedRevision: 1 },
      hooks: { before_history: () => { throw new Error("injected outage"); } },
    })).rejects.toThrow(/injected outage/);

    /* While revision 2 is still unclaimed the outcome is genuinely unknown, so the
       claim stays — a request that is merely slow must not have its claim stolen. */
    let state = await service.reconcileIdentityClaims({ companyId: A, draftId: (await MarketingCampaignDraft.findOne({ companyId: A }).lean())._id });
    expect(state).toMatchObject({ committed: 0, released: 0, inFlight: 1 });

    /* A DIFFERENT edit then takes revision 2. */
    await service.update({
      companyId: A, user: MARKETER_TWO, campaignDraftId: plan.campaignDraftId,
      payload: { name: "Renamed instead", expectedRevision: 1 },
    });

    /* OUTCOME: revision 2 exists and carries a different identity, so the abandoned
       claim is provably dead and released. Deterministic — decided by the data, not
       by a clock. */
    const draftId = (await MarketingCampaignDraft.findOne({ companyId: A }).lean())._id;
    state = await service.reconcileIdentityClaims({ companyId: A, draftId });
    expect(state).toMatchObject({ released: 1 });
    expect(await MarketingCampaignIdentity.findOne({ companyId: A, utmCampaign: "abandoned" }).lean())
      .toBeNull();

    /* And the name is usable again. */
    const reuse = await newPlan({ name: "Takes the freed name", utmCampaign: "abandoned" });
    expect(reuse.utmCampaign).toBe("abandoned");
  });

  test("a crashed claim whose revision DOES land is committed, not released", async () => {
    const plan = await newPlan({ utmCampaign: "first-name" });
    const draftId = (await MarketingCampaignDraft.findOne({ companyId: A }).lean())._id;

    /* Interrupted after history this time, so revision 2 IS recorded and carries
       the claimed identity. */
    await expect(service.update({
      companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId,
      payload: { utmCampaign: "second-name", expectedRevision: 1 },
      hooks: { after_history: () => { throw new Error("injected outage"); } },
    })).rejects.toThrow(/injected outage/);

    /* OUTCOME: a read repairs the revision and commits the claim. The identity is
       permanent, because an accepted revision carries it. */
    const view = await service.detail({ companyId: A, campaignDraftId: plan.campaignDraftId });
    expect(view.draft.utmCampaign).toBe("second-name");
    expect(view.draft.revision).toBe(2);

    const claim = await MarketingCampaignIdentity.findOne({ companyId: A, utmCampaign: "second-name" }).lean();
    expect(claim.status).toBe("committed");

    /* And the plan's earlier identity is still held, because an accepted revision
       carried that too. */
    const old = await MarketingCampaignIdentity.findOne({ companyId: A, utmCampaign: "first-name" }).lean();
    expect(old.status).toBe("committed");
    expect(old.current).toBe(false);
  });

  test("resolution cannot take a claim from a different running request", async () => {
    const one = await newPlan({ utmCampaign: "one-name" });
    const two = await newPlan({ name: "Two", utmCampaign: "two-name" });
    const oneId = (await MarketingCampaignDraft.findOne({ companyId: A, utmCampaign: "one-name" }).lean())._id;

    /* Plan one holds a live provisional claim on "shared-target". */
    let paused = null;
    const inFlight = service.update({
      companyId: A, user: MARKETER, campaignDraftId: one.campaignDraftId,
      payload: { utmCampaign: "shared-target", expectedRevision: 1 },
      hooks: { before_history: () => new Promise((r) => { paused = r; }) },
    });
    await new Promise((r) => setTimeout(r, 20));

    /* Plan two's reconciliation runs — and must not touch plan one's claim. A
       cleanup that deleted "any provisional claim on this identity" would let the
       live request reserve history for a name it no longer holds, which is the
       unapplicable row the whole protocol prevents. */
    const twoId = (await MarketingCampaignDraft.findOne({ companyId: A, utmCampaign: "two-name" }).lean())._id;
    await service.reconcileIdentityClaims({ companyId: A, draftId: twoId });
    await service.reconcileDraft({ companyId: A, draftId: twoId });
    await service.list({ companyId: A });

    const stillThere = await MarketingCampaignIdentity.findOne({ companyId: A, utmCampaign: "shared-target" }).lean();
    expect(stillThere).toBeTruthy();
    expect(stillThere.status).toBe("provisional");
    expect(String(stillThere.draftId)).toBe(String(oneId));

    paused();
    const done = await inFlight;

    /* OUTCOME: the live request completed on the claim it still held. */
    expect(done.utmCampaign).toBe("shared-target");
    expect((await MarketingCampaignIdentity.findOne({ companyId: A, utmCampaign: "shared-target" }).lean()).status)
      .toBe("committed");
  });

  test("every identity an accepted revision ever carried stays reserved", async () => {
    const plan = await newPlan({ utmCampaign: "name-one" });

    await service.update({
      companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId,
      payload: { utmCampaign: "name-two", expectedRevision: 1 },
    });
    await service.update({
      companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId,
      payload: { utmCampaign: "name-three", expectedRevision: 2 },
    });
    await service.cancel({ companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId, reason: "Stood down." });

    /* OUTCOME: all three committed, none released — not by the later changes and
       not by the cancellation. Each was carried by an accepted revision and may
       already exist in click data. */
    const rows = await MarketingCampaignIdentity.find({ companyId: A }).sort({ claimedAtRevision: 1 }).lean();
    expect(rows.map((r) => r.utmCampaign)).toEqual(["name-one", "name-two", "name-three"]);
    for (const row of rows) expect(row.status).toBe("committed");
    expect(rows.map((r) => r.current)).toEqual([false, false, true]);

    for (const taken of ["name-one", "name-two", "name-three"]) {
      await expect(newPlan({ name: `Scavenging ${taken}`, utmCampaign: taken }))
        .rejects.toMatchObject({ code: "CAMPAIGN_DRAFT_UTM_TAKEN" });
    }
  });

  test("claim resolution is company-scoped", async () => {
    await service.create({
      companyId: A, user: MARKETER,
      payload: { ...COMPLETE, idempotencyKey: freshKey(), utmCampaign: "scoped-name" },
    });
    await service.create({
      companyId: B, user: MARKETER,
      payload: { ...COMPLETE, idempotencyKey: freshKey(), utmCampaign: "scoped-name" },
    });

    const aId = (await MarketingCampaignDraft.findOne({ companyId: A }).lean())._id;
    const bId = (await MarketingCampaignDraft.findOne({ companyId: B }).lean())._id;

    /* Reconciling A cannot see, commit or release B's claim on the same word. */
    await service.reconcileIdentityClaims({ companyId: A, draftId: bId });

    const rows = await MarketingCampaignIdentity.find({ utmCampaign: "scoped-name" }).lean();
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.status).toBe("committed");
    expect(new Set(rows.map((r) => String(r.companyId))).size).toBe(2);
    expect(String(aId)).not.toBe(String(bId));
  });

  test("a plan may return to an identity it already owns", async () => {
    const plan = await newPlan({ utmCampaign: "original-name" });
    await service.update({
      companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId,
      payload: { utmCampaign: "interim-name", expectedRevision: 1 },
    });

    /* Its own committed identity, so this is not a new claim and not a conflict. */
    const back = await service.update({
      companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId,
      payload: { utmCampaign: "original-name", expectedRevision: 2 },
    });
    expect(back.utmCampaign).toBe("original-name");

    const rows = await MarketingCampaignIdentity.find({ companyId: A }).lean();
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.status).toBe("committed");
    expect(rows.find((r) => r.utmCampaign === "original-name").current).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   20. A CLAIM BELONGS TO THE WHOLE COMMAND, NOT JUST WHAT IT ASKS FOR
   ═══════════════════════════════════════════════════════════════════════════

   The flaw: the claim token covered company, plan, revision and requested identity.
   Two concurrent edits can share all four while changing different names, budgets,
   schedules, content or audiences. They derived one token, each treated the
   provisional row as its own, and the one that lost the history race released the
   claim the winner was about to commit. */

describe("the claim token identifies the complete edit command", () => {
  const payload = (over = {}) => ({ ...COMPLETE, idempotencyKey: freshKey(), ...over });

  const newPlan = (over = {}) => service.create({
    companyId: A, user: MARKETER, payload: payload(over),
  });

  const barrier = (n) => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let arrived = 0;
    return async () => { arrived += 1; if (arrived === n) release(); await gate; };
  };

  const tokenFor = (resulting, { draftId, revision = 2 }) => allocation.claimTokenFor({
    companyId: String(A), draftId: String(draftId), revision, resulting,
  });

  test("1. same plan, revision and requested identity, different BUDGETS → different tokens", async () => {
    const plan = await newPlan({ utmCampaign: "start" });
    const draftId = (await MarketingCampaignDraft.findOne({ companyId: A }).lean())._id;
    const base = service.canonical(await MarketingCampaignDraft.findById(draftId).lean());

    const one = { ...base, utmCampaign: "wanted", budget: { amount: 1000, currency: "INR", basis: "total" } };
    const two = { ...base, utmCampaign: "wanted", budget: { amount: 2000, currency: "INR", basis: "total" } };

    expect(tokenFor(one, { draftId })).not.toBe(tokenFor(two, { draftId }));
    expect(plan.revision).toBe(1);
  });

  test("2. same plan, revision and requested identity, different NAMES → different tokens", async () => {
    await newPlan({ utmCampaign: "start" });
    const draftId = (await MarketingCampaignDraft.findOne({ companyId: A }).lean())._id;
    const base = service.canonical(await MarketingCampaignDraft.findById(draftId).lean());

    const one = { ...base, utmCampaign: "wanted", name: "Name one" };
    const two = { ...base, utmCampaign: "wanted", name: "Name two" };

    expect(tokenFor(one, { draftId })).not.toBe(tokenFor(two, { draftId }));

    /* And the same state twice is the same token, which is what makes a retry
       recognise its own claim. */
    expect(tokenFor(one, { draftId })).toBe(tokenFor({ ...one }, { draftId }));
  });

  test("a generated timestamp does not change the token", async () => {
    await newPlan({ utmCampaign: "start" });
    const draftId = (await MarketingCampaignDraft.findOne({ companyId: A }).lean())._id;
    const base = service.canonical(await MarketingCampaignDraft.findById(draftId).lean());

    const early = { ...base, contentRefs: [{ kind: "email", contentId: "7", capturedName: "x", capturedAt: new Date("2026-01-01") }] };
    const later = { ...base, contentRefs: [{ kind: "email", contentId: "7", capturedName: "x", capturedAt: new Date("2026-09-09") }] };

    /* `capturedAt` is stamped by GRAV at validation time. A retry is the same
       command and must derive the same token. */
    expect(tokenFor(early, { draftId })).toBe(tokenFor(later, { draftId }));
  });

  test("3. the exact same edit submitted concurrently twice is a duplicate, not a conflict", async () => {
    const plan = await newPlan({ utmCampaign: "start" });
    const hold = barrier(2);

    const identicalEdit = () => service.update({
      companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId,
      payload: { utmCampaign: "agreed", name: "Agreed name", expectedRevision: 1 },
      hooks: { before_history: hold },
    });

    const results = await Promise.allSettled([identicalEdit(), identicalEdit()]);

    /* OUTCOME: both resolve. Neither is a revision conflict — they are the same
       command, and one is simply resuming the other. */
    for (const r of results) {
      if (r.status === "rejected") throw new Error(`refused: ${r.reason.code} ${r.reason.message}`);
    }
    const [first, second] = results.map((r) => r.value);
    expect([first.duplicate, second.duplicate].filter(Boolean)).toHaveLength(1);

    /* One revision, one history row for it. */
    const stored = await MarketingCampaignDraft.findOne({ companyId: A }).lean();
    expect(stored.revision).toBe(2);
    expect(stored.name).toBe("Agreed name");
    expect(stored.utmCampaign).toBe("agreed");
    expect(await MarketingCampaignDraftHistory.countDocuments({ companyId: A, revision: 2 })).toBe(1);

    /* ── AND THE SHARED CLAIM SURVIVED ──────────────────────────────────────
       The resuming caller must not release it. Before this, it did. */
    const claim = await MarketingCampaignIdentity.findOne({ companyId: A, utmCampaign: "agreed" }).lean();
    expect(claim).toBeTruthy();
    expect(claim.status).toBe("committed");
  });

  test("6. the exact duplicate resumes its own recorded revision and adds no history", async () => {
    const plan = await newPlan({ utmCampaign: "start" });

    /* Interrupted after its history row is durable and before the projection. This
       is the state a retry has to recognise: the revision is recorded, the plan has
       not caught up, and the claim is still provisional. */
    await expect(service.update({
      companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId,
      payload: { utmCampaign: "settled", name: "Settled", expectedRevision: 1 },
      hooks: { after_history: () => { throw new Error("injected outage"); } },
    })).rejects.toThrow(/injected outage/);

    const before = await MarketingCampaignDraftHistory.countDocuments({ companyId: A });
    expect(before).toBe(2);

    /* The identical command again. */
    const again = await service.update({
      companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId,
      payload: { utmCampaign: "settled", name: "Settled", expectedRevision: 1 },
    });

    /* OUTCOME: the recorded revision is applied and returned as a duplicate, with no
       second history row — the resume path, not a conflict and not a new revision. */
    expect(again.revision).toBe(2);
    expect(again.name).toBe("Settled");
    expect(again.utmCampaign).toBe("settled");
    expect(again.duplicate).toBe(true);
    expect(await MarketingCampaignDraftHistory.countDocuments({ companyId: A })).toBe(before);

    /* And the claim it shared with its earlier attempt is committed, not released. */
    const claim = await MarketingCampaignIdentity.findOne({ companyId: A, utmCampaign: "settled" }).lean();
    expect(claim.status).toBe("committed");
  });

  test("a retry quoting a revision that has already been superseded is told to reload", async () => {
    const plan = await newPlan({ utmCampaign: "start" });
    await service.update({
      companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId,
      payload: { name: "Applied", expectedRevision: 1 },
    });

    /* Not a resume: revision 1 is gone and the caller is working from a version
       somebody has replaced. Reporting a duplicate here would mean deciding the
       caller meant the same edit, which a stale revision does not establish. */
    await expect(service.update({
      companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId,
      payload: { name: "Something else", expectedRevision: 1 },
    })).rejects.toMatchObject({ code: "CAMPAIGN_DRAFT_REVISION_CONFLICT" });
  });

  test("4. different commands wanting one identity: one wins, one conflicts, the winner stays committed", async () => {
    const plan = await newPlan({ utmCampaign: "start" });
    /* Met BEFORE the identity claim, which is where two commands wanting the same
       name actually contend. Meeting at `before_history` would deadlock: the second
       is refused at the claim and never arrives. */
    const hold = barrier(2);

    const results = await Promise.allSettled([
      service.update({
        companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId,
        /* Same requested identity, DIFFERENT budget — the pair that used to share
           one claim token. */
        payload: { utmCampaign: "contested", budgetAmount: 111111, budgetCurrency: "INR", budgetBasis: "total", expectedRevision: 1 },
        hooks: { before_identity: hold },
      }),
      service.update({
        companyId: A, user: MARKETER_TWO, campaignDraftId: plan.campaignDraftId,
        payload: { utmCampaign: "contested", budgetAmount: 222222, budgetCurrency: "INR", budgetBasis: "total", expectedRevision: 1 },
        hooks: { before_identity: hold },
      }),
    ]);

    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");

    /* OUTCOME: one succeeds, one is refused. With the old token both derived the
       same claim and both proceeded to the history race, where the loser released the
       row the winner depended on. Now the second command holds a different token, so
       it is refused at the claim and never touches the winner's reservation. */
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(["CAMPAIGN_DRAFT_UTM_TAKEN", "CAMPAIGN_DRAFT_REVISION_CONFLICT"])
      .toContain(lost[0].reason.code);

    const stored = await MarketingCampaignDraft.findOne({ companyId: A }).lean();
    expect(stored.revision).toBe(2);
    expect([111111, 222222]).toContain(stored.budget.amount);
    expect(stored.utmCampaign).toBe("contested");

    /* ── THE WINNER'S RESERVATION SURVIVED, AND IS COMMITTED ────────────────
       The assertion the flaw failed: an accepted revision whose identity nothing
       reserved. */
    const claim = await MarketingCampaignIdentity.findOne({ companyId: A, utmCampaign: "contested" }).lean();
    expect(claim).toBeTruthy();
    expect(claim.status).toBe("committed");
    expect(String(claim.draftId)).toBe(String(stored._id));

    await expect(newPlan({ name: "Scavenger", utmCampaign: "contested" }))
      .rejects.toMatchObject({ code: "CAMPAIGN_DRAFT_UTM_TAKEN" });
  });

  test("4b. different commands wanting different identities: the loser releases only its own", async () => {
    const plan = await newPlan({ utmCampaign: "start" });
    const hold = barrier(2);

    const results = await Promise.allSettled([
      service.update({
        companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId,
        payload: { utmCampaign: "wants-a", name: "A", expectedRevision: 1 },
        hooks: { before_history: hold },
      }),
      service.update({
        companyId: A, user: MARKETER_TWO, campaignDraftId: plan.campaignDraftId,
        payload: { utmCampaign: "wants-b", name: "B", expectedRevision: 1 },
        hooks: { before_history: hold },
      }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const stored = await MarketingCampaignDraft.findOne({ companyId: A }).lean();
    const winning = stored.utmCampaign;
    const losing = winning === "wants-a" ? "wants-b" : "wants-a";

    /* OUTCOME: the winner's claim is committed; the loser released ITS OWN and left
       the winner's alone. */
    expect((await MarketingCampaignIdentity.findOne({ companyId: A, utmCampaign: winning }).lean()).status)
      .toBe("committed");
    expect(await MarketingCampaignIdentity.findOne({ companyId: A, utmCampaign: losing }).lean())
      .toBeNull();
  });

  test("5. a losing command can neither delete nor commit the winner's claim", async () => {
    const plan = await newPlan({ utmCampaign: "start" });
    const draftId = (await MarketingCampaignDraft.findOne({ companyId: A }).lean())._id;

    /* The winner takes revision 2 with its own resulting state. */
    await service.update({
      companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId,
      payload: { utmCampaign: "won", name: "Winner", expectedRevision: 1 },
    });

    const claim = await MarketingCampaignIdentity.findOne({ companyId: A, utmCampaign: "won" }).lean();
    expect(claim.status).toBe("committed");

    /* A different command's token, derived from a different resulting state. */
    const base = service.canonical(await MarketingCampaignDraft.findById(draftId).lean());
    const loserToken = allocation.claimTokenFor({
      companyId: String(A), draftId: String(draftId), revision: 2,
      resulting: { ...base, name: "Loser", utmCampaign: "won" },
    });
    expect(loserToken).not.toBe(claim.claimToken);

    /* OUTCOME: neither operation touches the winner's row. The release is fenced on
       the token AND on the row still being provisional; the commit on the token. */
    expect(await allocation.releaseClaim({ companyId: A, utmCampaign: "won", claimToken: loserToken }))
      .toEqual({ released: false });
    expect(await allocation.commitIdentity({ companyId: A, utmCampaign: "won", claimToken: loserToken }))
      .toEqual({ committed: false });

    const after = await MarketingCampaignIdentity.findOne({ companyId: A, utmCampaign: "won" }).lean();
    expect(after.status).toBe("committed");
    expect(after.claimToken).toBe(claim.claimToken);
  });

  test("7. a failed commit is never reported as success", async () => {
    const plan = await newPlan({ utmCampaign: "start" });

    /* The commit is made to fail by removing the provisional row from underneath
       it, and the restore path is made to fail by giving the identity to another
       plan — so the reservation genuinely cannot be confirmed. */
    const other = await newPlan({ name: "Other", utmCampaign: "other-name" });
    const otherId = (await MarketingCampaignDraft.findOne({ companyId: A, utmCampaign: "other-name" }).lean())._id;

    let caught = null;
    try {
      await service.update({
        companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId,
        payload: { utmCampaign: "target-name", expectedRevision: 1 },
        hooks: {
          after_history: async () => {
            /* Between the history row and the projection, the claim is taken away
               and handed to a different plan. */
            await MarketingCampaignIdentity.deleteMany({ companyId: A, utmCampaign: "target-name" });
            await MarketingCampaignIdentity.create({
              companyId: A, utmCampaign: "target-name", draftId: otherId,
              draftRef: other.reference, claimedAtRevision: 1,
              status: "committed", claimToken: "somebody-elses-token",
              committedAt: new Date(), current: false, at: new Date(),
            });
          },
        },
      });
    } catch (err) { caught = err; }

    /* OUTCOME: not a success. `committed: false` is acted on, and the caller is told
       the reservation could not be confirmed. */
    expect(caught).toBeTruthy();
    expect(["CAMPAIGN_DRAFT_HISTORY_UNPROJECTABLE", "CAMPAIGN_DRAFT_REPAIR_PENDING"])
      .toContain(caught.code);
    expect(caught.message).not.toMatch(/saved|applied successfully/i);
  });

  test("8. reconciliation restores a missing reservation before publishing the revision as clean", async () => {
    const plan = await newPlan({ utmCampaign: "reserved-name" });

    /* The reservation is deleted behind GRAV's back, leaving an accepted revision
       whose identity nothing protects. */
    await MarketingCampaignIdentity.deleteMany({ companyId: A, utmCampaign: "reserved-name" });
    expect(await MarketingCampaignIdentity.countDocuments({ companyId: A })).toBe(0);

    /* Reading the plan repairs the invariant: an accepted revision must never exist
       without its committed reservation. */
    const view = await service.detail({ companyId: A, campaignDraftId: plan.campaignDraftId });
    expect(view.draft.utmCampaign).toBe("reserved-name");

    const restored = await MarketingCampaignIdentity.findOne({ companyId: A, utmCampaign: "reserved-name" }).lean();
    expect(restored).toBeTruthy();
    expect(restored.status).toBe("committed");
    expect(restored.current).toBe(true);

    /* And the protection is real again. */
    await expect(newPlan({ name: "Scavenger", utmCampaign: "reserved-name" }))
      .rejects.toMatchObject({ code: "CAMPAIGN_DRAFT_UTM_TAKEN" });
  });

  test("8b. every identity in accepted history is restored, not only the current one", async () => {
    const plan = await newPlan({ utmCampaign: "first-held" });
    await service.update({
      companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId,
      payload: { utmCampaign: "second-held", expectedRevision: 1 },
    });

    await MarketingCampaignIdentity.deleteMany({ companyId: A });
    await service.detail({ companyId: A, campaignDraftId: plan.campaignDraftId });

    const rows = await MarketingCampaignIdentity.find({ companyId: A }).lean();
    expect(rows.map((r) => r.utmCampaign).sort()).toEqual(["first-held", "second-held"]);
    for (const row of rows) expect(row.status).toBe("committed");
    expect(rows.find((r) => r.utmCampaign === "second-held").current).toBe(true);
  });

  test("a reservation owned by another plan is reported, never reassigned", async () => {
    const mine = await newPlan({ utmCampaign: "mine-name" });
    const theirs = await newPlan({ name: "Theirs", utmCampaign: "theirs-name" });
    const theirId = (await MarketingCampaignDraft.findOne({ companyId: A, utmCampaign: "theirs-name" }).lean())._id;

    /* My accepted identity is reassigned to their plan behind GRAV's back. */
    await MarketingCampaignIdentity.updateOne(
      { companyId: A, utmCampaign: "mine-name" },
      { $set: { draftId: theirId } },
    );

    /* OUTCOME: reading my plan reports the ownership conflict rather than inventing
       a second owner, which the unique index would refuse anyway. */
    await expect(service.detail({ companyId: A, campaignDraftId: mine.campaignDraftId }))
      .rejects.toMatchObject({ code: "CAMPAIGN_DRAFT_HISTORY_UNPROJECTABLE" });
    expect(theirs.utmCampaign).toBe("theirs-name");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   21. AN ABANDONED CLAIM IS OPERATOR-RESOLVABLE, NOT "IN FLIGHT" FOR EVER
   ═══════════════════════════════════════════════════════════════════════════ */

describe("an abandoned provisional claim is surfaced honestly", () => {
  const payload = (over = {}) => ({ ...COMPLETE, idempotencyKey: freshKey(), ...over });

  test("a crashed claim nobody retries is listed for an operator, with its age", async () => {
    const plan = await service.create({ companyId: A, user: MARKETER, payload: payload({ utmCampaign: "held" }) });

    await expect(service.update({
      companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId,
      payload: { utmCampaign: "abandoned-name", expectedRevision: 1 },
      hooks: { before_history: () => { throw new Error("injected outage"); } },
    })).rejects.toThrow(/injected outage/);

    /* GRAV does not expire it: a slow request and a dead one look identical, and a
       timer would eventually steal a claim from a live request. */
    const blocked = await allocation.blockedClaims({ companyId: A });
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ utmCampaign: "abandoned-name", claimedAtRevision: 2 });
    expect(typeof blocked[0].ageSeconds).toBe("number");
    expect(blocked[0].claimToken).toBeTruthy();
  });

  test("an operator may release it, and may not release a reservation a revision needs", async () => {
    const plan = await service.create({ companyId: A, user: MARKETER, payload: payload({ utmCampaign: "committed-name" }) });

    await expect(service.update({
      companyId: A, user: MARKETER, campaignDraftId: plan.campaignDraftId,
      payload: { utmCampaign: "stuck-name", expectedRevision: 1 },
      hooks: { before_history: () => { throw new Error("injected outage"); } },
    })).rejects.toThrow(/injected outage/);

    const [stuck] = await allocation.blockedClaims({ companyId: A });

    /* The deliberate operator action. */
    expect(await allocation.releaseBlockedClaim({
      companyId: A, utmCampaign: "stuck-name", claimToken: stuck.claimToken,
      acceptedRevisionCarriesIt: false,
    })).toEqual({ released: true });

    /* The name is usable again. */
    const reuse = await service.create({ companyId: A, user: MARKETER, payload: payload({ name: "Reuse", utmCampaign: "stuck-name" }) });
    expect(reuse.utmCampaign).toBe("stuck-name");

    /* And a committed reservation is refused outright — it is not abandoned, it is
       a reservation an accepted revision depends on. */
    const live = await MarketingCampaignIdentity.findOne({ companyId: A, utmCampaign: "committed-name" }).lean();
    await expect(allocation.releaseBlockedClaim({
      companyId: A, utmCampaign: "committed-name", claimToken: live.claimToken,
      acceptedRevisionCarriesIt: true,
    })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await MarketingCampaignIdentity.findOne({ companyId: A, utmCampaign: "committed-name" }).lean())
      .toBeTruthy();
  });

  test("the operator view is company-scoped", async () => {
    for (const company of [A, B]) {
      const made = await service.create({ companyId: company, user: MARKETER, payload: payload({ utmCampaign: "shared-word" }) });
      await expect(service.update({
        companyId: company, user: MARKETER, campaignDraftId: made.campaignDraftId,
        payload: { utmCampaign: `stuck-in-${String(company).slice(-4)}`, expectedRevision: 1 },
        hooks: { before_history: () => { throw new Error("injected outage"); } },
      })).rejects.toThrow(/injected outage/);
    }

    const forA = await allocation.blockedClaims({ companyId: A });
    const forB = await allocation.blockedClaims({ companyId: B });
    expect(forA).toHaveLength(1);
    expect(forB).toHaveLength(1);
    expect(forA[0].utmCampaign).not.toBe(forB[0].utmCampaign);
  });
});
