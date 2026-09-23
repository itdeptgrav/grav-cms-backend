// test/accountant/viewer-read-only.route.test.js
//
// LANE A, CHUNK 2 — the Viewer role writes NOTHING.
//
// The previous pass put `canEdit` in front of the GETs that create ledgers.
// That closed the loud half. The quiet half was still open: four reads that a
// Viewer is supposed to have — the ledger list, a ledger's detail page, the
// GSTR-2B period list and a reconciliation — each modified the database on the
// way to answering.
//
//   • GET /chart-of-accounts/ledgers      fired a `bulkWrite` persisting the
//                                         GST state it had just derived
//   • GET /chart-of-accounts/ledgers/:id  called `ledger.save()`
//   • GET /gstr2b/periods, /recon-range   ran an index migration that also
//                                         backfilled `returnType` on legacy docs
//   • GET /gstr2b/:period/recon           stamped lastReconAt / lastReconBy and
//                                         overwrote the cached summary, buckets
//                                         and tolerance
//
// Every one produced a correct-looking response, which is why none of them
// showed up as a permission problem. The assertions here are therefore about
// the DATABASE, not the status code: the read must succeed AND the stored row
// must be byte-identical afterwards.
"use strict";

process.env.JWT_SECRET = "test_secret_for_viewer_read_only";
process.env.ACCOUNTANT_AUTH_BYPASS = "false";

const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const SECRET = process.env.JWT_SECRET;

const {
  Acc_Organization,
  Acc_User,
} = require("../../models/Accountant_model/Acc_OrgModels");
const {
  Acc_Company,
  Acc_Ledger,
  Acc_Group,
} = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_GSTR2B } = require("../../models/Accountant_model/Acc_GSTR2B");
const { signOrgToken } = require("../../Middlewear/AccountantOrgAuthMiddleware");

const UPGRADE = "ACCOUNTING_SESSION_UPGRADE_REQUIRED";

let server;
let origin;
let warnSpy;

beforeAll(async () => {
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  const app = express();
  app.use(express.json());
  const R = (p) => require(`../../routes/Accountant_Routes/${p}`);
  app.use("/api/accountant/chart-of-accounts", R("Acc_chartOfAccounts"));
  app.use("/api/accountant/gstr2b", R("Acc_gstr2b"));
  await new Promise((r) => {
    server = app.listen(0, r);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  warnSpy.mockRestore();
  await new Promise((r) => server.close(r));
});

async function call(path, { method = "GET", body, cookies, bearer } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (cookies) {
    headers.Cookie = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const res = await fetch(`${origin}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text.slice(0, 160) };
  }
  return { status: res.status, body: parsed };
}

let seq = 0;

async function makeOrg() {
  return Acc_Organization.create({ name: `Org ${++seq}`, tallyCompanyIds: [] });
}

async function makeUser(org, role) {
  const user = new Acc_User({
    organizationId: org._id,
    name: `User ${++seq}`,
    email: `user${seq}@example.com`,
    role,
  });
  await user.setPassword("a-long-enough-password");
  await user.save();
  return user;
}

/**
 * A company, optionally attached to the organisation that will be asking for
 * it. Lane A Chunk 3A made company scope real: a company that is not in
 * `org.tallyCompanyIds` is now 403 COMPANY_FORBIDDEN for that organisation, so
 * a fixture that creates a detached company no longer models a working setup.
 */
async function makeCompany(org = null) {
  const company = await Acc_Company.create({
    companyName: `Co ${++seq}`,
    booksFromDate: new Date("2025-04-01"),
  });
  if (org) {
    await Acc_Organization.updateOne(
      { _id: org._id },
      { $addToSet: { tallyCompanyIds: company._id } },
    );
  }
  return company;
}

/** A ledger carrying a GSTIN but NO derived state — the row the reads repaired. */
async function makeGstinLedger(company) {
  const group = await Acc_Group.create({
    companyId: company._id,
    name: `Sundry Debtors ${++seq}`,
    nature: "asset",
    isActive: true,
  });
  return Acc_Ledger.create({
    companyId: company._id,
    name: `Party ${++seq}`,
    groupId: group._id,
    groupName: group.name,
    nature: "asset",
    isActive: true,
    gstin: "27AAAAA0000A1Z5", // 27 = Maharashtra
  });
}

/** A legacy 2B document with no `returnType` — what the migration backfilled. */
async function makeLegacy2B(company, period = "042026") {
  const doc = await Acc_GSTR2B.create({
    companyId: company._id,
    returnType: "GSTR2B",
    taxpayerGSTIN: "27BBBBB0000B1Z5",
    returnPeriod: period,
    periodMonth: 4,
    periodYear: 2026,
    records: [],
  });
  // Strip the field the way a pre-migration document actually looks, without
  // going through the schema.
  await Acc_GSTR2B.collection.updateOne(
    { _id: doc._id },
    { $unset: { returnType: "" } },
  );
  return doc;
}

function legacyToken(claims = {}) {
  return jwt.sign(
    { id: new mongoose.Types.ObjectId().toString(), role: "accountant", ...claims },
    SECRET,
    { expiresIn: "24h" },
  );
}

/** The stored document, straight from the driver — no schema defaults applied. */
const raw = (model, id) => model.collection.findOne({ _id: id });

/* ================================================================== */
/* 1. Ledger list and detail                                           */
/* ================================================================== */

describe("a viewer reading the ledger list", () => {
  test("gets the derived GST state in the response", async () => {
    const org = await makeOrg();
    const viewer = await makeUser(org, "viewer");
    const company = await makeCompany(org);
    const ledger = await makeGstinLedger(company);

    const res = await call(
      `/api/accountant/chart-of-accounts/ledgers?companyId=${company._id}`,
      { bearer: signOrgToken(viewer) },
    );

    expect(res.status).toBe(200);
    const returned = res.body.ledgers.find((l) => l._id === String(ledger._id));
    expect(returned.contactDetails.stateCode).toBe("27");
    expect(returned.contactDetails.state).toBe("Maharashtra");
  });

  test("and the stored ledger is left exactly as it was", async () => {
    const org = await makeOrg();
    const viewer = await makeUser(org, "viewer");
    const company = await makeCompany(org);
    const ledger = await makeGstinLedger(company);

    const before = await raw(Acc_Ledger, ledger._id);
    await call(
      `/api/accountant/chart-of-accounts/ledgers?companyId=${company._id}`,
      { bearer: signOrgToken(viewer) },
    );
    // The write was fire-and-forget, so give it every chance to land.
    await new Promise((r) => setTimeout(r, 150));
    const after = await raw(Acc_Ledger, ledger._id);

    expect(after).toEqual(before);
    expect(after.contactDetails?.stateCode).toBeUndefined();
  });
});

describe("a viewer opening one ledger", () => {
  test("gets the derived GST state in the response", async () => {
    const org = await makeOrg();
    const viewer = await makeUser(org, "viewer");
    const company = await makeCompany(org);
    const ledger = await makeGstinLedger(company);

    const res = await call(
      `/api/accountant/chart-of-accounts/ledgers/${ledger._id}?companyId=${company._id}`,
      { bearer: signOrgToken(viewer) },
    );

    expect(res.status).toBe(200);
    expect(res.body.ledger.contactDetails.stateCode).toBe("27");
    expect(res.body.ledger.contactDetails.state).toBe("Maharashtra");
  });

  test("and the stored ledger is left exactly as it was", async () => {
    const org = await makeOrg();
    const viewer = await makeUser(org, "viewer");
    const company = await makeCompany(org);
    const ledger = await makeGstinLedger(company);

    const before = await raw(Acc_Ledger, ledger._id);
    await call(
      `/api/accountant/chart-of-accounts/ledgers/${ledger._id}?companyId=${company._id}`,
      { bearer: signOrgToken(viewer) },
    );
    await new Promise((r) => setTimeout(r, 150));
    const after = await raw(Acc_Ledger, ledger._id);

    expect(after).toEqual(before);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  test("an owner's read does not write either — the repair is gone, not moved", async () => {
    const org = await makeOrg();
    const owner = await makeUser(org, "owner");
    const company = await makeCompany(org);
    const ledger = await makeGstinLedger(company);

    const before = await raw(Acc_Ledger, ledger._id);
    await call(
      `/api/accountant/chart-of-accounts/ledgers/${ledger._id}?companyId=${company._id}`,
      { bearer: signOrgToken(owner) },
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(await raw(Acc_Ledger, ledger._id)).toEqual(before);
  });
});

/* ================================================================== */
/* 2. GSTR-2B reads                                                    */
/* ================================================================== */

describe("a viewer listing GSTR-2B periods", () => {
  test("does not backfill returnType on a legacy document", async () => {
    const org = await makeOrg();
    const viewer = await makeUser(org, "viewer");
    const company = await makeCompany(org);
    const doc = await makeLegacy2B(company);

    expect((await raw(Acc_GSTR2B, doc._id)).returnType).toBeUndefined();

    const res = await call(
      `/api/accountant/gstr2b/periods?companyId=${company._id}`,
      { bearer: signOrgToken(viewer) },
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 150));

    expect((await raw(Acc_GSTR2B, doc._id)).returnType).toBeUndefined();
  });

  test("nor does /recon-range", async () => {
    const org = await makeOrg();
    const viewer = await makeUser(org, "viewer");
    const company = await makeCompany(org);
    const doc = await makeLegacy2B(company, "052026");

    const before = await raw(Acc_GSTR2B, doc._id);
    const res = await call(
      `/api/accountant/gstr2b/recon-range?companyId=${company._id}&from=2026-04-01&to=2026-06-30`,
      { bearer: signOrgToken(viewer) },
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 150));

    expect(await raw(Acc_GSTR2B, doc._id)).toEqual(before);
  });
});

describe("a viewer running a reconciliation", () => {
  test("gets a result back", async () => {
    const org = await makeOrg();
    const viewer = await makeUser(org, "viewer");
    const company = await makeCompany(org);
    await makeLegacy2B(company);

    const res = await call(
      `/api/accountant/gstr2b/042026/recon?companyId=${company._id}`,
      { bearer: signOrgToken(viewer) },
    );
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.summary).toBeTruthy();
    expect(res.body.buckets).toBeTruthy();
  });

  test("and every lastRecon* field is left untouched", async () => {
    const org = await makeOrg();
    const viewer = await makeUser(org, "viewer");
    const company = await makeCompany(org);
    const doc = await makeLegacy2B(company);

    const before = await raw(Acc_GSTR2B, doc._id);
    await call(`/api/accountant/gstr2b/042026/recon?companyId=${company._id}`, {
      bearer: signOrgToken(viewer),
    });
    await new Promise((r) => setTimeout(r, 200));
    const after = await raw(Acc_GSTR2B, doc._id);

    // Compared against the snapshot rather than asserted absent: the schema
    // gives `lastReconTolerance` a default, so "undefined" is not the claim —
    // "unchanged by the read" is.
    for (const f of [
      "lastReconAt",
      "lastReconBy",
      "lastReconSummary",
      "lastReconBuckets",
      "lastReconTolerance",
    ]) {
      expect({ [f]: after[f] }).toEqual({ [f]: before[f] });
    }
    expect(after.lastReconAt).toBeUndefined();
    expect(after.lastReconBy).toBeUndefined();
    expect(after).toEqual(before);
  });

  test("does not overwrite a reconciliation somebody else stored", async () => {
    // The sharper version: a Viewer opening the page must not replace an
    // existing cached result, or re-stamp it with their own name.
    const org = await makeOrg();
    const viewer = await makeUser(org, "viewer");
    const company = await makeCompany(org);
    const doc = await makeLegacy2B(company);

    const stamped = new Date("2026-01-01T00:00:00.000Z");
    await Acc_GSTR2B.collection.updateOne(
      { _id: doc._id },
      {
        $set: {
          lastReconAt: stamped,
          lastReconBy: "finance.lead@example.com",
          lastReconSummary: { marker: "original" },
          lastReconBuckets: { matched: [] },
          lastReconTolerance: { amount: 5, days: 7 },
        },
      },
    );

    await call(`/api/accountant/gstr2b/042026/recon?companyId=${company._id}`, {
      bearer: signOrgToken(viewer),
    });
    await new Promise((r) => setTimeout(r, 200));
    const after = await raw(Acc_GSTR2B, doc._id);

    expect(after.lastReconBy).toBe("finance.lead@example.com");
    expect(after.lastReconAt).toEqual(stamped);
    expect(after.lastReconSummary).toEqual({ marker: "original" });
    expect(after.lastReconTolerance).toEqual({ amount: 5, days: 7 });
  });

  test("an owner's GET is a pure read too", async () => {
    const org = await makeOrg();
    const owner = await makeUser(org, "owner");
    const company = await makeCompany(org);
    const doc = await makeLegacy2B(company);

    const before = await raw(Acc_GSTR2B, doc._id);
    await call(`/api/accountant/gstr2b/042026/recon?companyId=${company._id}`, {
      bearer: signOrgToken(owner),
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(await raw(Acc_GSTR2B, doc._id)).toEqual(before);
  });
});

/* ================================================================== */
/* 3. The explicit write still works                                   */
/* ================================================================== */

describe("POST /:period/recon/cache — the persistence that was split out", () => {
  test("an editor can store a reconciliation result", async () => {
    const org = await makeOrg();
    const editor = await makeUser(org, "editor");
    const company = await makeCompany(org);
    const doc = await makeLegacy2B(company);

    const res = await call(
      `/api/accountant/gstr2b/042026/recon/cache?companyId=${company._id}`,
      { method: "POST", body: { companyId: String(company._id) }, bearer: signOrgToken(editor) },
    );
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const after = await raw(Acc_GSTR2B, doc._id);
    expect(after.lastReconAt).toBeTruthy();
    expect(after.lastReconSummary).toBeTruthy();
    expect(after.lastReconBuckets).toBeTruthy();
  });

  test("it records the real signed-in user, not an empty string", async () => {
    const org = await makeOrg();
    const editor = await makeUser(org, "editor");
    const company = await makeCompany(org);
    const doc = await makeLegacy2B(company);

    await call(
      `/api/accountant/gstr2b/042026/recon/cache?companyId=${company._id}`,
      { method: "POST", body: { companyId: String(company._id) }, bearer: signOrgToken(editor) },
    );
    expect((await raw(Acc_GSTR2B, doc._id)).lastReconBy).toBe(editor.email);
  });

  test("a viewer cannot use it", async () => {
    const org = await makeOrg();
    const viewer = await makeUser(org, "viewer");
    const company = await makeCompany(org);
    const doc = await makeLegacy2B(company);

    const res = await call(
      `/api/accountant/gstr2b/042026/recon/cache?companyId=${company._id}`,
      { method: "POST", body: { companyId: String(company._id) }, bearer: signOrgToken(viewer) },
    );
    expect(res.status).toBe(403);
    expect(res.body.requires).toBe("canEdit");
    expect((await raw(Acc_GSTR2B, doc._id)).lastReconAt).toBeUndefined();
  });

  test("a failed database write is reported as a failure, not a success", async () => {
    // The `.catch()` this replaced swallowed the error and still answered
    // `success: true`: the caller saw a stored reconciliation, `/recon-range`
    // and the period badges saw nothing, and the response gave no way to tell
    // which had happened.
    const org = await makeOrg();
    const editor = await makeUser(org, "editor");
    const company = await makeCompany(org);
    const doc = await makeLegacy2B(company);

    const spy = jest
      .spyOn(Acc_GSTR2B, "updateOne")
      .mockRejectedValueOnce(new Error("simulated write failure"));
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await call(
        `/api/accountant/gstr2b/042026/recon/cache?companyId=${company._id}`,
        { method: "POST", body: { companyId: String(company._id) }, bearer: signOrgToken(editor) },
      );
      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/simulated write failure/);
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }

    // And nothing was half-written.
    expect((await raw(Acc_GSTR2B, doc._id)).lastReconAt).toBeUndefined();
  });

  test("the GET is unaffected by a write failure — it never writes", async () => {
    const org = await makeOrg();
    const viewer = await makeUser(org, "viewer");
    const company = await makeCompany(org);
    await makeLegacy2B(company);

    const spy = jest
      .spyOn(Acc_GSTR2B, "updateOne")
      .mockRejectedValue(new Error("should never be called"));
    try {
      const res = await call(
        `/api/accountant/gstr2b/042026/recon?companyId=${company._id}`,
        { bearer: signOrgToken(viewer) },
      );
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("a successful editor refresh makes the period available via /recon-range", async () => {
    // The whole reason persistence was kept rather than deleted: `/recon-range`
    // serves only what has been stored, so an editor's Refresh is what puts a
    // period in front of everyone else.
    const org = await makeOrg();
    const editor = await makeUser(org, "editor");
    const viewer = await makeUser(org, "viewer");
    const company = await makeCompany(org);
    await makeLegacy2B(company);

    const beforeRange = await call(
      `/api/accountant/gstr2b/recon-range?companyId=${company._id}&from=2026-04-01&to=2026-04-30`,
      { bearer: signOrgToken(viewer) },
    );
    expect(beforeRange.status).toBe(200);
    // Imported but never reconciled: the range view lists it as outstanding.
    expect(beforeRange.body.periodsReady).toBe(0);
    // `missingRecon` entries spread the enumerated period, which names the key
    // `returnPeriod`; the `periods` array below renames it to `period`. That
    // inconsistency is pre-existing API shape, not something this change made.
    expect(
      beforeRange.body.missingRecon.map((p) => p.returnPeriod),
    ).toContain("042026");

    const post = await call(
      `/api/accountant/gstr2b/042026/recon/cache?companyId=${company._id}`,
      { method: "POST", body: { companyId: String(company._id) }, bearer: signOrgToken(editor) },
    );
    expect(post.status).toBe(200);

    const afterRange = await call(
      `/api/accountant/gstr2b/recon-range?companyId=${company._id}&from=2026-04-01&to=2026-04-30`,
      { bearer: signOrgToken(viewer) },
    );
    expect(afterRange.status).toBe(200);
    expect(afterRange.body.periodsReady).toBe(1);
    expect(afterRange.body.missingRecon).toEqual([]);
    const ready = afterRange.body.periods;
    expect(ready).toHaveLength(1);
    expect(ready[0].period).toBe("042026");
    expect(ready[0].summary).toBeTruthy();
    expect(ready[0].buckets).toBeTruthy();
    expect(ready[0].lastReconAt).toBeTruthy();
  });

  test("what it stores is then served to a viewer via ?cache=true", async () => {
    // The point of splitting rather than deleting: a Viewer still sees the
    // reconciliation an editor ran.
    const org = await makeOrg();
    const editor = await makeUser(org, "editor");
    const viewer = await makeUser(org, "viewer");
    const company = await makeCompany(org);
    await makeLegacy2B(company);

    await call(
      `/api/accountant/gstr2b/042026/recon/cache?companyId=${company._id}`,
      { method: "POST", body: { companyId: String(company._id) }, bearer: signOrgToken(editor) },
    );

    const res = await call(
      `/api/accountant/gstr2b/042026/recon?companyId=${company._id}&cache=true`,
      { bearer: signOrgToken(viewer) },
    );
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(res.body.summary).toBeTruthy();
  });
});

/* ================================================================== */
/* 3b. Tolerance — zero means zero                                     */
/* ================================================================== */
//
// `Number(value) || 1` turned an explicit request for EXACT matching into a
// rupee of slack, so invoices differing by a rupee were reported as matched.
// The same idiom let a negative through, and the match test is
// `diff <= tolerance` — no absolute difference is ever <= -5, so a negative
// tolerance reports the entire return as mismatched.

describe("tolerance handling", () => {
  async function seedForTolerance() {
    const org = await makeOrg();
    const company = await makeCompany(org);
    return {
      org,
      company,
      editor: await makeUser(org, "editor"),
      viewer: await makeUser(org, "viewer"),
      doc: await makeLegacy2B(company),
    };
  }

  test("the pure GET honours an explicit zero", async () => {
    const { company, viewer } = await seedForTolerance();
    const res = await call(
      `/api/accountant/gstr2b/042026/recon?companyId=${company._id}` +
        `&amountTolerance=0&dateTolerance=0`,
      { bearer: signOrgToken(viewer) },
    );
    expect(res.status).toBe(200);
    expect(res.body.tolerance).toEqual({ amount: 0, days: 0 });
  });

  test("the POST honours an explicit zero, in the response AND in what it stores", async () => {
    const { company, editor, doc } = await seedForTolerance();
    const res = await call(
      `/api/accountant/gstr2b/042026/recon/cache?companyId=${company._id}`,
      {
        method: "POST",
        body: {
          companyId: String(company._id),
          amountTolerance: 0,
          dateTolerance: 0,
        },
        bearer: signOrgToken(editor),
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.tolerance).toEqual({ amount: 0, days: 0 });
    expect((await raw(Acc_GSTR2B, doc._id)).lastReconTolerance).toEqual({
      amount: 0,
      days: 0,
    });
  });

  test("a zero sent as a query string is still zero", async () => {
    // The GET carries them as strings; "0" must not be treated as absent.
    const { company, editor } = await seedForTolerance();
    const res = await call(
      `/api/accountant/gstr2b/042026/recon/cache?companyId=${company._id}` +
        `&amountTolerance=0&dateTolerance=0`,
      { method: "POST", body: { companyId: String(company._id) }, bearer: signOrgToken(editor) },
    );
    expect(res.status).toBe(200);
    expect(res.body.tolerance).toEqual({ amount: 0, days: 0 });
  });

  test("the defaults are still ₹1 and 3 days when nothing is supplied", async () => {
    const { company, viewer } = await seedForTolerance();
    const res = await call(
      `/api/accountant/gstr2b/042026/recon?companyId=${company._id}`,
      { bearer: signOrgToken(viewer) },
    );
    expect(res.body.tolerance).toEqual({ amount: 1, days: 3 });
  });

  test("blank and non-numeric values fall back to the defaults", async () => {
    const { company, viewer } = await seedForTolerance();
    for (const qs of [
      "amountTolerance=&dateTolerance=",
      "amountTolerance=abc&dateTolerance=xyz",
    ]) {
      const res = await call(
        `/api/accountant/gstr2b/042026/recon?companyId=${company._id}&${qs}`,
        { bearer: signOrgToken(viewer) },
      );
      expect(`${qs}: ${JSON.stringify(res.body.tolerance)}`).toBe(
        `${qs}: {"amount":1,"days":3}`,
      );
    }
  });

  test.each([
    ["negative", "amountTolerance=-5&dateTolerance=-2"],
    ["negative strings", "amountTolerance=-0.01&dateTolerance=-1"],
    ["infinite", "amountTolerance=Infinity&dateTolerance=Infinity"],
    ["negative infinite", "amountTolerance=-Infinity&dateTolerance=-Infinity"],
  ])("a %s tolerance never reaches reconciliation", async (_label, qs) => {
    const { company, viewer } = await seedForTolerance();
    const res = await call(
      `/api/accountant/gstr2b/042026/recon?companyId=${company._id}&${qs}`,
      { bearer: signOrgToken(viewer) },
    );
    expect(res.status).toBe(200);
    expect(res.body.tolerance.amount).toBeGreaterThanOrEqual(0);
    expect(res.body.tolerance.days).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(res.body.tolerance.amount)).toBe(true);
    expect(Number.isFinite(res.body.tolerance.days)).toBe(true);
    expect(res.body.tolerance).toEqual({ amount: 1, days: 3 });
  });

  test("a negative tolerance is never STORED either", async () => {
    const { company, editor, doc } = await seedForTolerance();
    const res = await call(
      `/api/accountant/gstr2b/042026/recon/cache?companyId=${company._id}`,
      {
        method: "POST",
        body: {
          companyId: String(company._id),
          amountTolerance: -5,
          dateTolerance: -2,
        },
        bearer: signOrgToken(editor),
      },
    );
    expect(res.status).toBe(200);
    const stored = (await raw(Acc_GSTR2B, doc._id)).lastReconTolerance;
    expect(stored.amount).toBeGreaterThanOrEqual(0);
    expect(stored.days).toBeGreaterThanOrEqual(0);
    expect(stored).toEqual({ amount: 1, days: 3 });
  });

  test("a stored zero survives a cached read", async () => {
    // `doc.lastReconTolerance || { amount: amtTol, days: dayTol }` would be fine
    // for {amount:0,days:0} since the object itself is truthy — pinned so a
    // later "simplification" to a field-wise fallback cannot lose the zero.
    const { company, editor, viewer } = await seedForTolerance();
    await call(
      `/api/accountant/gstr2b/042026/recon/cache?companyId=${company._id}`,
      {
        method: "POST",
        body: {
          companyId: String(company._id),
          amountTolerance: 0,
          dateTolerance: 0,
        },
        bearer: signOrgToken(editor),
      },
    );

    const cached = await call(
      `/api/accountant/gstr2b/042026/recon?companyId=${company._id}&cache=true`,
      { bearer: signOrgToken(viewer) },
    );
    expect(cached.status).toBe(200);
    expect(cached.body.cached).toBe(true);
    expect(cached.body.tolerance).toEqual({ amount: 0, days: 0 });
  });

  test("a fractional tolerance is preserved", async () => {
    const { company, viewer } = await seedForTolerance();
    const res = await call(
      `/api/accountant/gstr2b/042026/recon?companyId=${company._id}` +
        `&amountTolerance=2.5&dateTolerance=7`,
      { bearer: signOrgToken(viewer) },
    );
    expect(res.body.tolerance).toEqual({ amount: 2.5, days: 7 });
  });
});

/* ================================================================== */
/* 4. Editor and owner writes are unaffected                           */
/* ================================================================== */

describe("ordinary writes still work", () => {
  test("an owner can still update a ledger, and it persists", async () => {
    const org = await makeOrg();
    const owner = await makeUser(org, "owner");
    const company = await makeCompany(org);
    const ledger = await makeGstinLedger(company);

    const res = await call(
      `/api/accountant/chart-of-accounts/ledgers/${ledger._id}`,
      {
        method: "PUT",
        body: { companyId: String(company._id), name: "Renamed Party" },
        bearer: signOrgToken(owner),
      },
    );
    expect([200, 201]).toContain(res.status);
    expect((await raw(Acc_Ledger, ledger._id)).name).toBe("Renamed Party");
  });

  test("an editor's update still goes to the approval queue, as before", async () => {
    // `coaApprovalGate` answers 202 for an editor rather than applying the
    // change. Nothing here touched that, and this pins it: removing the
    // read-path writes must not have loosened the write path.
    const org = await makeOrg();
    const editor = await makeUser(org, "editor");
    const company = await makeCompany(org);
    const ledger = await makeGstinLedger(company);

    const res = await call(
      `/api/accountant/chart-of-accounts/ledgers/${ledger._id}`,
      {
        method: "PUT",
        body: { companyId: String(company._id), name: "Editor Rename" },
        bearer: signOrgToken(editor),
      },
    );
    expect(res.status).toBe(202);
    expect(res.body._pendingApproval).toBe(true);
    expect((await raw(Acc_Ledger, ledger._id)).name).not.toBe("Editor Rename");
  });

  test("a viewer still cannot update a ledger", async () => {
    const org = await makeOrg();
    const viewer = await makeUser(org, "viewer");
    const company = await makeCompany(org);
    const ledger = await makeGstinLedger(company);

    const res = await call(
      `/api/accountant/chart-of-accounts/ledgers/${ledger._id}`,
      {
        method: "PUT",
        body: { companyId: String(company._id), name: "Should Not Stick" },
        bearer: signOrgToken(viewer),
      },
    );
    expect(res.status).toBe(403);
    expect((await raw(Acc_Ledger, ledger._id)).name).not.toBe("Should Not Stick");
  });
});

/* ================================================================== */
/* 5. Refusals are unchanged                                           */
/* ================================================================== */

describe("anonymous and legacy sessions", () => {
  const paths = (companyId) => [
    ["ledger list", `/api/accountant/chart-of-accounts/ledgers?companyId=${companyId}`],
    ["gstr2b periods", `/api/accountant/gstr2b/periods?companyId=${companyId}`],
    ["gstr2b recon", `/api/accountant/gstr2b/042026/recon?companyId=${companyId}`],
    ["recon range", `/api/accountant/gstr2b/recon-range?companyId=${companyId}&from=2026-04-01&to=2026-06-30`],
  ];

  test("anonymous is still refused everywhere", async () => {
    const company = await makeCompany();
    for (const [label, url] of paths(company._id)) {
      const res = await call(url);
      expect(`${label}: ${res.status}`).toBe(`${label}: 401`);
      expect(res.body.code).toBe("NO_TOKEN");
    }
  });

  test("a legacy CMS session is still refused everywhere", async () => {
    const company = await makeCompany();
    const cookies = { auth_token: legacyToken({ role: "admin" }) };
    for (const [label, url] of paths(company._id)) {
      const res = await call(url, { cookies });
      expect(`${label}: ${res.status}`).toBe(`${label}: 401`);
      expect(res.body.code).toBe(UPGRADE);
    }
  });

  test("the new cache write refuses anonymous and legacy too", async () => {
    const company = await makeCompany();
    const url = `/api/accountant/gstr2b/042026/recon/cache?companyId=${company._id}`;

    const anon = await call(url, { method: "POST", body: {} });
    expect(anon.status).toBe(401);

    const legacy = await call(url, {
      method: "POST",
      body: {},
      cookies: { auth_token: legacyToken({ role: "admin" }) },
    });
    expect(legacy.status).toBe(401);
    expect(legacy.body.code).toBe(UPGRADE);
  });
});
