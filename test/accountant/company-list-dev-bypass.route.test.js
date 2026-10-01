// test/accountant/company-list-dev-bypass.route.test.js
//
// SCOPING THE COMPANY LIST MUST NOT BREAK THE DEVELOPER BYPASS.
//
// `ACCOUNTANT_AUTH_BYPASS=true` attaches a session with `isDev: true` and NO
// organisation — it exists so the initial data can be seeded through curl
// before any organisation owns anything. `resolveCompanyScope` and
// `requireCompanyAccess` both already exempt it, and the company list now has
// to as well, or the bypass could authenticate but never see a company to seed.
//
// ── WHY A SEPARATE FILE ──────────────────────────────────────────────────────
// `DEV_BYPASS` is read once, at module load, in AccountantOrgAuthMiddleware. It
// cannot be switched on and off inside one jest process, so the two states need
// two processes. The scoped behaviour is in
// company-list-scoping.route.test.js.
//
// The other half of the exemption's wording — that it says `isDev` rather than
// "has no organisation", so a real but organisation-less session sees nothing
// instead of everything — is in company-list-no-organisation.route.test.js,
// which needs the bypass OFF and so needs a third process.
"use strict";

process.env.JWT_SECRET = "test_secret_for_company_list_dev_bypass";
/* Set before the requires below — the middleware reads it at module load. */
process.env.ACCOUNTANT_AUTH_BYPASS = "true";

const express = require("express");

const { Acc_Organization } = require("../../models/Accountant_model/Acc_OrgModels");
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

async function list() {
  const res = await fetch(`${origin}/api/accountant/tally/companies`);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 160) };
  }
  return { status: res.status, body };
}

let seq = 0;
const makeCompany = (name, over = {}) =>
  Acc_Company.create({
    companyName: `${name} ${++seq}`,
    booksFromDate: new Date("2025-04-01"),
    ...over,
  });

const namesIn = (body) => (body.companies || []).map((c) => c.companyName);

test("the bypass is actually on — the request needs no token at all", () => {
  // Guards the suite itself. If the env flag stopped being read this file
  // would otherwise 401 everywhere and prove nothing.
  expect(process.env.ACCOUNTANT_AUTH_BYPASS).toBe("true");
});

test("a dev session sees every active company, owned by an organisation or not", async () => {
  const org = await Acc_Organization.create({ name: "Some Org", tallyCompanyIds: [] });
  const owned = await makeCompany("OWNED CO");
  await Acc_Organization.updateOne(
    { _id: org._id },
    { $addToSet: { tallyCompanyIds: owned._id } },
  );
  await makeCompany("UNOWNED CO");

  const res = await list();

  expect(res.status).toBe(200);
  expect(res.body.count).toBe(2);
  expect(namesIn(res.body).join(" ")).toMatch(/OWNED CO/);
  expect(namesIn(res.body).join(" ")).toMatch(/UNOWNED CO/);
});

test("it still excludes soft-deleted companies — the bypass is not a raw dump", async () => {
  await makeCompany("LIVE CO");
  await makeCompany("CLOSED CO", { isActive: false });

  const res = await list();
  expect(res.body.count).toBe(1);
  expect(namesIn(res.body)[0]).toMatch(/LIVE CO/);
});

test("with nothing seeded at all it is an empty list, not an error", async () => {
  // The state the bypass exists for: an empty database about to be seeded.
  const res = await list();
  expect(res.status).toBe(200);
  expect(res.body.companies).toEqual([]);
});
