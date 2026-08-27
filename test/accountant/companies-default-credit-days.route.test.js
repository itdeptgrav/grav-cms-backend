// test/accountant/companies-default-credit-days.route.test.js
//
// HTTP-level tests for
// PATCH /api/accountant/tally/companies/:id/default-credit-days
//
// Mirrors test/accountant/parties-credit-terms.route.test.js: the router is
// mounted on a bare Express app against an in-memory MongoDB, and
// AccountantAuthMiddleware is mocked so identity/permissions are assertable
// per request without a JWT.
"use strict";

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/AccountantAuthMiddleware", () => ({
  accountantAuth: (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ error: "Authentication required." });
    req.user = JSON.parse(raw);
    next();
  },
}));

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");

const EDITOR = { id: new mongoose.Types.ObjectId().toString(), name: "Priya Editor", permissions: { canEdit: true } };
const VIEWER = { id: new mongoose.Types.ObjectId().toString(), name: "Vikram Viewer", permissions: { canEdit: false } };

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/accountant/tally/companies", require("../../routes/Accountant_Routes/Acc_companies"));
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api/accountant/tally/companies`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function call(path, { method = "GET", body, user = EDITOR } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(user ? { "x-test-user": JSON.stringify(user) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function seedCompany(overrides = {}) {
  return Acc_Company.create({
    companyName: "Company A",
    booksFromDate: new Date("2025-04-01"),
    ...overrides,
  });
}

const patchPath = (id) => `/${id}/default-credit-days`;

/* ── Valid save / clear ──────────────────────────────────────────────────── */

describe("valid save and clear", () => {
  test("a valid value saves and stamps provenance", async () => {
    const company = await seedCompany();
    const { status, body } = await call(patchPath(company._id), {
      method: "PATCH",
      body: { defaultCreditDays: 45 },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.company.defaultCreditDays).toBe(45);
    expect(body.company.defaultCreditDaysSet).toBe(true);

    const stored = await Acc_Company.findById(company._id).lean();
    expect(stored.defaultCreditDays).toBe(45);
    expect(String(stored.defaultCreditDaysUpdatedBy)).toBe(EDITOR.id);
    expect(stored.defaultCreditDaysUpdatedByName).toBe(EDITOR.name);
    expect(stored.defaultCreditDaysUpdatedAt).toBeTruthy();
  });

  test("a numeric string, as a form input sends, saves correctly", async () => {
    const company = await seedCompany();
    const { status, body } = await call(patchPath(company._id), {
      method: "PATCH",
      body: { defaultCreditDays: "30" },
    });
    expect(status).toBe(200);
    expect(body.company.defaultCreditDays).toBe(30);
  });

  test("an empty string clears the default to null, not 0", async () => {
    const company = await seedCompany({ defaultCreditDays: 30 });
    const { status, body } = await call(patchPath(company._id), {
      method: "PATCH",
      body: { defaultCreditDays: "" },
    });
    expect(status).toBe(200);
    expect(body.company.defaultCreditDays).toBeNull();
    expect(body.company.defaultCreditDaysSet).toBe(false);

    const stored = await Acc_Company.findById(company._id).lean();
    expect(stored.defaultCreditDays).toBeNull();
  });

  test("null clears the default", async () => {
    const company = await seedCompany({ defaultCreditDays: 30 });
    const { status, body } = await call(patchPath(company._id), {
      method: "PATCH",
      body: { defaultCreditDays: null },
    });
    expect(status).toBe(200);
    expect(body.company.defaultCreditDays).toBeNull();
  });

  test("0 clears the default — it is not a valid 'due on receipt' value", async () => {
    const company = await seedCompany({ defaultCreditDays: 30 });
    const { status, body } = await call(patchPath(company._id), {
      method: "PATCH",
      body: { defaultCreditDays: 0 },
    });
    expect(status).toBe(200);
    expect(body.company.defaultCreditDays).toBeNull();

    const stored = await Acc_Company.findById(company._id).lean();
    expect(stored.defaultCreditDays).toBeNull(); // never stored as 0
  });
});

/* ── Rejected values ──────────────────────────────────────────────────────── */

describe("invalid values are rejected, and an existing value survives", () => {
  test("negative is rejected", async () => {
    const company = await seedCompany({ defaultCreditDays: 60 });
    const { status, body } = await call(patchPath(company._id), {
      method: "PATCH",
      body: { defaultCreditDays: -5 },
    });
    expect(status).toBe(400);
    expect(body.code).toBe("NEGATIVE");
    const stored = await Acc_Company.findById(company._id).lean();
    expect(stored.defaultCreditDays).toBe(60);
  });

  test("fractional is rejected", async () => {
    const company = await seedCompany({ defaultCreditDays: 60 });
    const { status, body } = await call(patchPath(company._id), {
      method: "PATCH",
      body: { defaultCreditDays: 30.5 },
    });
    expect(status).toBe(400);
    expect(body.code).toBe("NOT_INTEGER");
    const stored = await Acc_Company.findById(company._id).lean();
    expect(stored.defaultCreditDays).toBe(60);
  });

  test("> 365 is rejected", async () => {
    const company = await seedCompany({ defaultCreditDays: 60 });
    const { status, body } = await call(patchPath(company._id), {
      method: "PATCH",
      body: { defaultCreditDays: 400 },
    });
    expect(status).toBe(400);
    expect(body.code).toBe("TOO_LARGE");
    const stored = await Acc_Company.findById(company._id).lean();
    expect(stored.defaultCreditDays).toBe(60);
  });

  test("boolean is rejected", async () => {
    const company = await seedCompany({ defaultCreditDays: 60 });
    const { status, body } = await call(patchPath(company._id), {
      method: "PATCH",
      body: { defaultCreditDays: true },
    });
    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_TYPE");
  });

  test("object is rejected", async () => {
    const company = await seedCompany({ defaultCreditDays: 60 });
    const { status, body } = await call(patchPath(company._id), {
      method: "PATCH",
      body: { defaultCreditDays: { days: 30 } },
    });
    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_TYPE");
  });

  test("array is rejected", async () => {
    const company = await seedCompany({ defaultCreditDays: 60 });
    const { status, body } = await call(patchPath(company._id), {
      method: "PATCH",
      body: { defaultCreditDays: [30] },
    });
    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_TYPE");
  });

  test("a non-numeric string is rejected", async () => {
    const company = await seedCompany({ defaultCreditDays: 60 });
    const { status, body } = await call(patchPath(company._id), {
      method: "PATCH",
      body: { defaultCreditDays: "abc" },
    });
    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_TYPE");
    const stored = await Acc_Company.findById(company._id).lean();
    expect(stored.defaultCreditDays).toBe(60);
  });
});

/* ── Whitelist ────────────────────────────────────────────────────────────── */

describe("body whitelist", () => {
  test("an unsupported field is refused outright, not silently dropped", async () => {
    const company = await seedCompany();
    const { status, body } = await call(patchPath(company._id), {
      method: "PATCH",
      body: { defaultCreditDays: 30, companyName: "Renamed Co" },
    });
    expect(status).toBe(400);
    expect(body.code).toBe("UNSUPPORTED_FIELD");

    const stored = await Acc_Company.findById(company._id).lean();
    expect(stored.companyName).toBe("Company A");
    expect(stored.defaultCreditDays).toBeNull();
  });

  test("a body missing defaultCreditDays entirely is refused", async () => {
    const company = await seedCompany();
    const { status, body } = await call(patchPath(company._id), {
      method: "PATCH",
      body: {},
    });
    expect(status).toBe(400);
    expect(body.code).toBe("NOTHING_TO_UPDATE");
  });
});

/* ── Permission ───────────────────────────────────────────────────────────── */

describe("permission", () => {
  test("a read-only role cannot save, and the company is untouched", async () => {
    const company = await seedCompany({ defaultCreditDays: 30 });
    const { status } = await call(patchPath(company._id), {
      method: "PATCH",
      body: { defaultCreditDays: 90 },
      user: VIEWER,
    });
    expect(status).toBe(403);

    const stored = await Acc_Company.findById(company._id).lean();
    expect(stored.defaultCreditDays).toBe(30);
  });

  test("no auth header at all is refused", async () => {
    const company = await seedCompany();
    const { status } = await call(patchPath(company._id), {
      method: "PATCH",
      body: { defaultCreditDays: 30 },
      user: null,
    });
    expect(status).toBe(401);
  });
});

/* ── Company scoping / not found ─────────────────────────────────────────── */

describe("wrong or missing company", () => {
  test("a malformed id is rejected safely", async () => {
    const { status, body } = await call(patchPath("not-an-object-id"), {
      method: "PATCH",
      body: { defaultCreditDays: 30 },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid company id/i);
  });

  test("a well-formed but non-existent id returns 404, writes nothing", async () => {
    const ghostId = new mongoose.Types.ObjectId().toString();
    const { status, body } = await call(patchPath(ghostId), {
      method: "PATCH",
      body: { defaultCreditDays: 30 },
    });
    expect(status).toBe(404);
    expect(body.error).toMatch(/not found/i);
  });

  test("writing company A never touches company B", async () => {
    const companyA = await seedCompany({ companyName: "Company A" });
    const companyB = await seedCompany({ companyName: "Company B", defaultCreditDays: 15 });

    await call(patchPath(companyA._id), {
      method: "PATCH",
      body: { defaultCreditDays: 60 },
    });

    const storedB = await Acc_Company.findById(companyB._id).lean();
    expect(storedB.defaultCreditDays).toBe(15);
  });
});

/* ── Scope guard: this endpoint touches Acc_Company only ────────────────────── */

describe("scope guard", () => {
  test("no voucher document is created, read for write, or otherwise touched", async () => {
    const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
    const before = await Acc_Voucher.countDocuments({});
    expect(before).toBe(0);

    const company = await seedCompany();
    await call(patchPath(company._id), {
      method: "PATCH",
      body: { defaultCreditDays: 30 },
    });

    const after = await Acc_Voucher.countDocuments({});
    expect(after).toBe(0);
  });

  test("no Acc_BillTerms document is created by this endpoint", async () => {
    const Acc_BillTerms = require("../../models/Accountant_model/Acc_BillTerms");
    const before = await Acc_BillTerms.countDocuments({});
    expect(before).toBe(0);

    const company = await seedCompany();
    await call(patchPath(company._id), {
      method: "PATCH",
      body: { defaultCreditDays: 30 },
    });

    const after = await Acc_BillTerms.countDocuments({});
    expect(after).toBe(0);
  });
});

/* ── The rest of this router's owner-only gate still applies elsewhere ──────── */

describe("owner-only gate is untouched for other routes", () => {
  test("a non-owner editor still cannot PUT the general company-update route", async () => {
    const company = await seedCompany();
    const { status } = await call(`/${company._id}`, {
      method: "PUT",
      body: { companyName: "Hijacked" },
      user: EDITOR, // canEdit, but not owner/isLegacy/isDev
    });
    expect(status).toBe(403);
  });
});
