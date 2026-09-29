// test/accountant/company-list-no-organisation.route.test.js
//
// A REAL SESSION WITH NO ORGANISATION SEES NOTHING — NOT EVERYTHING.
//
// The company list exempts exactly one kind of session from organisation
// scoping: the developer bypass, which sets `isDev: true`. That exemption could
// equally have been spelled "a session with no organisation is unrestricted",
// because the dev session has no organisation either — and the two spellings
// are indistinguishable until the day a real session arrives without one.
//
// Then they are opposites. A user whose organisation lookup failed, or whose
// organisation was deleted between the token being signed and the request
// arriving, is a BROKEN session. Under `isDev` it is refused; under "no
// organisation" it would receive every company in the deployment — which is
// the bug this whole change exists to close, reintroduced through the exemption
// rather than through the query.
//
// ── WHY THE AUTH GATE IS DOUBLED ─────────────────────────────────────────────
// The real middleware cannot produce this state: `orgAuth` confirms the
// organisation against the database and answers 403 ORGANIZATION_INACTIVE when
// it is missing, so the handler is never reached without one. The branch is
// defence in depth, and the only way to exercise it is to stand in for the
// gate. So `accountantAuth` is replaced here — and ONLY `accountantAuth`. The
// router, its second gate, and the list handler are the real ones.
"use strict";

process.env.JWT_SECRET = "test_secret_for_company_list_no_org";
process.env.ACCOUNTANT_AUTH_BYPASS = "false";

/* The session the real gate cannot build: authenticated, not dev, no
   organisation. Swapped per test.
   The `mock` prefix is required — jest refuses a `jest.mock` factory that
   closes over any other out-of-scope variable. */
let mockSession = null;

jest.mock("../../Middlewear/AccountantAuthMiddleware", () => {
  const actual = jest.requireActual("../../Middlewear/AccountantAuthMiddleware");
  return {
    ...actual,
    accountantAuth: (req, _res, next) => {
      req.user = mockSession.user;
      req.organization = mockSession.organization;
      next();
    },
  };
});

const express = require("express");
const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");

let server;
let origin;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/accountant/tally/companies",
    require("../../routes/Accountant_Routes/Acc_companies"),
  );
  await new Promise((r) => {
    server = app.listen(0, r);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  mockSession = {
    user: {
      id: new mongoose.Types.ObjectId().toString(),
      role: "owner",
      permissions: { canView: true, canEdit: true, canManageSettings: true },
    },
    organization: null,
  };
});

async function list() {
  const res = await fetch(`${origin}/api/accountant/tally/companies`);
  const body = await res.json();
  return { status: res.status, body };
}

const seedCompany = (name) =>
  Acc_Company.create({ companyName: name, booksFromDate: new Date("2025-04-01") });

test("an organisation-less session is refused, and is told why", async () => {
  await seedCompany("SHOULD NOT BE VISIBLE PVT LTD");

  const res = await list();

  expect(res.status).toBe(403);
  expect(res.body.success).toBe(false);
  expect(res.body.code).toBe("NO_ORGANIZATION_CONTEXT");
});

test("not one company crosses in the refusal body", async () => {
  await seedCompany("SHOULD NOT BE VISIBLE PVT LTD");

  const res = await list();

  expect(res.body.companies).toBeUndefined();
  expect(JSON.stringify(res.body)).not.toContain("SHOULD NOT BE VISIBLE");
});

test("being an owner does not substitute for having an organisation", async () => {
  // The refusal is about scope, not seniority, so the most privileged role is
  // the one worth asserting on.
  await seedCompany("SHOULD NOT BE VISIBLE PVT LTD");
  mockSession.user.role = "owner";

  expect((await list()).status).toBe(403);
});

test("the same session WITH an organisation is answered normally", async () => {
  /* The control. Without it a handler that refused every request would pass
     every assertion above. */
  const company = await seedCompany("VISIBLE PVT LTD");
  mockSession.organization = { _id: new mongoose.Types.ObjectId(), tallyCompanyIds: [company._id] };

  const res = await list();

  expect(res.status).toBe(200);
  expect(res.body.companies.map((c) => c.companyName)).toEqual(["VISIBLE PVT LTD"]);
});

test("an explicitly dev session is still exempt, even here", async () => {
  // `isDev` is the marker, and it is the ONLY thing that changes the answer.
  const company = await seedCompany("UNOWNED PVT LTD");
  mockSession.user.isDev = true;

  const res = await list();

  expect(res.status).toBe(200);
  expect(res.body.companies.map((c) => String(c._id))).toEqual([String(company._id)]);
});
