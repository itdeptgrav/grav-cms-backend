// test/accountant/company-identity.route.test.js
//
// The company screen's two new jobs: checking that the tax identifiers agree
// with each other, and holding the certificates behind them.
//
// The identifier ARITHMETIC is unit-tested in services/taxIdentity.test.js —
// 28 cases, no database. What is tested here is the wiring: that the endpoint
// exists, that it reports rather than blocks, that a document's bytes go to
// Drive and never come back as a provider URL, and that the owner-only gate
// on this router covers the new routes too.
"use strict";

process.env.JWT_SECRET = process.env.JWT_SECRET || "company-identity-test-secret";

const express = require("express");
const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const { mintLetterToken } = require("../../utils/letterDownloadToken");

jest.mock("../../services/companyDrive.service", () => ({
  uploadCompanyFile: jest.fn(async (buf) => ({
    driveFileId: "drive-" + Math.random().toString(36).slice(2),
    mimeType: "application/pdf",
    bytes: buf.length,
  })),
  streamCompanyFile: jest.fn(async () => ({
    stream: require("stream").Readable.from([Buffer.from("PDFBYTES")]),
    meta: { name: "cert.pdf", mimeType: "application/pdf", size: 8 },
  })),
  deleteCompanyFile: jest.fn(async () => true),
}));

let server;
let base;
/* Swapped per test to exercise the router's owner-only gate. */
let CURRENT_USER = { id: new mongoose.Types.ObjectId().toString(), role: "owner", name: "Owner" };

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = CURRENT_USER;
    next();
  });
  app.use("/api/accountant/tally/companies", require("../../routes/Accountant_Routes/Acc_companies"));
  await new Promise((r) => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${server.address().port}/api/accountant/tally/companies`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});
beforeEach(() => {
  CURRENT_USER = { id: new mongoose.Types.ObjectId().toString(), role: "owner", name: "Owner" };
});

async function call(path, { method = "GET", body: payload, raw = false } = {}) {
  const headers = {};
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (raw) return { status: res.status, headers: res.headers, text: await res.text() };
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body, headers: res.headers };
}

/** Upload one document through the real multipart path. */
async function upload(companyId, { kind = "gst", name = "cert.pdf", note = "" } = {}) {
  const form = new FormData();
  form.append("file", new Blob([Buffer.from("%PDF-1.4 fake")], { type: "application/pdf" }), name);
  form.append("kind", kind);
  if (note) form.append("note", note);
  const res = await fetch(`${base}/${companyId}/documents`, { method: "POST", body: form });
  return { status: res.status, body: await res.json() };
}

const seedCompany = (over = {}) =>
  Acc_Company.create({
    companyName: "GRAV CLOTHING PVT LTD",
    gstin: "21AAMCG0739M1ZH",
    pan: "AAMCG0739M",
    booksFromDate: new Date("2026-04-01"),
    ...over,
  });

/* ═══════════════════════════════════════════════════════════════════════════
 * CHECKING THE DETAILS
 * ══════════════════════════════════════════════════════════════════════════ */

describe("POST /verify", () => {
  test("a consistent set comes back clean, and says the check was offline", async () => {
    const { status, body } = await call("/verify", {
      method: "POST",
      body: {
        companyName: "GRAV CLOTHING PVT LTD",
        gstin: "21AAMCG0739M1ZH",
        pan: "AAMCG0739M",
        cin: "U14101OD2025OPC049369",
        tan: "BBNG03651E",
        address: { state: "Odisha", stateCode: "21" },
      },
    });

    expect(status).toBe(200);
    expect(body.clean).toBe(true);
    expect(body.errorCount).toBe(0);
    /* The claim the UI repeats. Nothing here asked the GST portal whether the
       registration exists, and the response must not let anyone think it did. */
    expect(body.checkedOffline).toBe(true);
    expect(body.valid).toBeUndefined();
  });

  test("a mistyped GSTIN check digit is caught", async () => {
    const { body } = await call("/verify", {
      method: "POST",
      body: { gstin: "21AAMCG0739M1ZG", companyName: "GRAV CLOTHING PVT LTD" },
    });
    expect(body.fields.gstin.status).toBe("error");
    expect(body.fields.gstin.message).toMatch(/check digit/i);
  });

  test("a GSTIN and PAN from different companies is an error the form can point at", async () => {
    const { body } = await call("/verify", {
      method: "POST",
      body: { gstin: "21AAMCG0739M1ZH", pan: "AABCT1332L" },
    });
    const hit = body.findings.find((f) => f.severity === "error");
    expect(hit).toBeTruthy();
    /* The finding names its fields so the UI can mark both boxes rather than
       printing a sentence nobody can act on. */
    expect(hit.fields).toEqual(expect.arrayContaining(["gstin", "pan"]));
  });

  test("it verifies what is on screen, including a company that was never saved", async () => {
    /* The useful moment is while somebody is typing — an id would make this
       endpoint useless for the New Company form. */
    const { status, body } = await call("/verify", {
      method: "POST",
      body: { gstin: "21AAMCG0739M1ZH" },
    });
    expect(status).toBe(200);
    expect(body.fields.gstin.status).toBe("ok");
  });

  test("an empty form is not a failure", async () => {
    const { body } = await call("/verify", { method: "POST", body: {} });
    expect(body.errorCount).toBe(0);
  });

  test("it reports and never writes", async () => {
    const before = await Acc_Company.countDocuments({});
    await call("/verify", { method: "POST", body: { gstin: "21AAMCG0739M1ZH" } });
    expect(await Acc_Company.countDocuments({})).toBe(before);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE CERTIFICATES
 * ══════════════════════════════════════════════════════════════════════════ */

describe("company documents", () => {
  const drive = require("../../services/companyDrive.service");

  test("a certificate is stored and comes back on the company", async () => {
    const company = await seedCompany();
    const { status, body } = await upload(String(company._id), { kind: "gst", name: "GST-cert.pdf" });

    expect(status).toBe(201);
    expect(body.document).toMatchObject({ kind: "gst", name: "GST-cert.pdf" });

    const listed = await call(`/${company._id}/documents`);
    expect(listed.body.documents).toHaveLength(1);

    const fresh = await Acc_Company.findById(company._id);
    expect(fresh.documents[0].driveFileId).toBeTruthy();
  });

  test("the provider's file id never reaches the client", async () => {
    const company = await seedCompany();
    await upload(String(company._id));

    const listed = await call(`/${company._id}/documents`);
    /* Not a URL and not an id: anything the client holds, the client can put
       in a support ticket. */
    expect(JSON.stringify(listed.body)).not.toMatch(/drive-|googleapis|drive\.google/);
    expect(listed.body.documents[0].driveFileId).toBeUndefined();
  });

  test("an unknown kind falls back to 'other' rather than being stored as typed", async () => {
    const company = await seedCompany();
    const { body } = await upload(String(company._id), { kind: "whatever" });
    expect(body.document.kind).toBe("other");
  });

  test("a request with no file is refused", async () => {
    const company = await seedCompany();
    const res = await fetch(`${base}/${company._id}/documents`, { method: "POST", body: new FormData() });
    expect(res.status).toBe(400);
  });

  test("a document on a company that does not exist is not found", async () => {
    const ghost = new mongoose.Types.ObjectId().toString();
    const { status } = await upload(ghost);
    expect(status).toBe(404);
  });

  test("the link is our own URL carrying a short-lived token", async () => {
    const company = await seedCompany();
    const up = await upload(String(company._id), { name: "GST-cert.pdf" });

    const { status, body } = await call(`/${company._id}/documents/${up.body.document.id}/link`);
    expect(status).toBe(200);
    expect(body.url).toMatch(/\/documents\/[^/]+\/download\/GST-cert\.pdf\?t=/);
    expect(body.url).not.toMatch(/googleapis|drive\.google/);
  });

  test("the bytes need the token, and the token is scoped to this document", async () => {
    const company = await seedCompany();
    const up = await upload(String(company._id));
    const docId = up.body.document.id;

    const noToken = await call(`/${company._id}/documents/${docId}/download`, { raw: true });
    expect(noToken.status).toBe(404);

    /* A token minted for the employee-letter feature must not open a company
       certificate — that is the entire reason `scope` exists on the token. */
    const wrongScope = mintLetterToken({ docId, scope: "letter", subject: "u" });
    const scoped = await call(
      `/${company._id}/documents/${docId}/download?t=${encodeURIComponent(wrongScope)}`,
      { raw: true },
    );
    expect(scoped.status).toBe(404);

    const good = mintLetterToken({ docId, scope: "company-doc", subject: "u" });
    const ok = await call(
      `/${company._id}/documents/${docId}/download?t=${encodeURIComponent(good)}`,
      { raw: true },
    );
    expect(ok.status).toBe(200);
    expect(ok.text).toBe("PDFBYTES");
  });

  test("anything that could execute is forced to download", async () => {
    const company = await seedCompany();
    const up = await upload(String(company._id), { name: "payload.svg" });
    const docId = up.body.document.id;

    drive.streamCompanyFile.mockResolvedValueOnce({
      stream: require("stream").Readable.from([Buffer.from("<svg onload=alert(1)>")]),
      meta: { name: "payload.svg", mimeType: "image/svg+xml", size: 21 },
    });

    const token = mintLetterToken({ docId, scope: "company-doc", subject: "u" });
    const res = await call(
      `/${company._id}/documents/${docId}/download?t=${encodeURIComponent(token)}`,
      { raw: true },
    );
    /* Served inline it would run on this origin with this session's cookie. */
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("deleting removes the record and asks Drive to drop the bytes", async () => {
    const company = await seedCompany();
    const up = await upload(String(company._id));
    drive.deleteCompanyFile.mockClear();

    const { status, body } = await call(`/${company._id}/documents/${up.body.document.id}`, {
      method: "DELETE",
    });
    expect(status).toBe(200);
    expect(body.driveDeleted).toBe(true);
    expect(drive.deleteCompanyFile).toHaveBeenCalled();

    const fresh = await Acc_Company.findById(company._id);
    expect(fresh.documents).toHaveLength(0);
  });

  test("Drive failing still removes the record, and says so", async () => {
    const company = await seedCompany();
    const up = await upload(String(company._id));
    drive.deleteCompanyFile.mockResolvedValueOnce(false);

    const { body } = await call(`/${company._id}/documents/${up.body.document.id}`, {
      method: "DELETE",
    });
    /* The documented trade-off: an orphaned Drive object beats a record
       pointing at bytes the user believes are gone. */
    expect(body.driveDeleted).toBe(false);
    expect((await Acc_Company.findById(company._id)).documents).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE GATE THIS ROUTER ALREADY HAD
 * ══════════════════════════════════════════════════════════════════════════ */

describe("owner-only, including the new routes", () => {
  test("a non-owner cannot attach or delete a certificate", async () => {
    const company = await seedCompany();
    const owned = await upload(String(company._id));
    expect(owned.status).toBe(201);

    CURRENT_USER = { id: new mongoose.Types.ObjectId().toString(), role: "accountant" };

    const blocked = await upload(String(company._id));
    expect(blocked.status).toBe(403);

    const del = await call(`/${company._id}/documents/${owned.body.document.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(403);

    /* Refused AND unchanged. */
    expect((await Acc_Company.findById(company._id)).documents).toHaveLength(1);
  });

  test("a non-owner can still READ what is on file", async () => {
    const company = await seedCompany();
    await upload(String(company._id));

    CURRENT_USER = { id: new mongoose.Types.ObjectId().toString(), role: "accountant" };
    const listed = await call(`/${company._id}/documents`);
    /* The router lets every GET through; an accountant needs to see which
       certificates exist even though they may not change them. */
    expect(listed.status).toBe(200);
    expect(listed.body.documents).toHaveLength(1);
  });
});
