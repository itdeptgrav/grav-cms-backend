// test/industrial-engineering/ie-operation-library.route.test.js
//
// INDUSTRIAL ENGINEERING — CHUNK 2A, THE COMPANY OPERATION LIBRARY, AT THE WIRE.
//
// This is IE's first write path, so the claims worth holding are the ones that
// decide whether it is safe to give a department a Save button:
//
//   · the two checks are genuinely two — an `ie` editor with no membership in
//     this company reaches nothing, and a member with only a viewer grant may
//     read every row and change none;
//   · a foreign company's operation, a deleted one and a fabricated id are ONE
//     answer, byte for byte, so the boundary cannot be used to ask whether a
//     competitor's operation exists;
//   · unique ACTIVE code per company is enforced by the DATABASE, proved by
//     racing two creates and by writing straight to the model past the
//     service's pre-check — a pre-check alone would pass this file and still
//     admit duplicates in production;
//   · two companies may each hold SEW-01;
//   · a revision moves on every accepted mutation, and a stale one is refused
//     rather than merged;
//   · retirement deletes NOTHING, is reversible, releases the code for reuse,
//     and a restore that would create a second live SEW-01 is refused;
//   · and there is no hard delete on this router at all.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const IeOperation = require("../../models/CMS_Models/IndustrialEngineering/IeOperation");
const LegacyOperation = require("../../models/CMS_Models/Inventory/Configurations/Operation");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/ie", require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/ie`;
  /* The uniqueness claims in this file are claims about an INDEX. Building it
     explicitly is what makes them true here rather than only in production. */
  await IeOperation.syncIndexes();
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

const call = (path, { method = "GET", body, token, company } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => {
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text || "null"); } catch { parsed = { nonJson: true }; }
    return { status: r.status, body: parsed };
  });

const company = (name) => Acc_Company.create({
  companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01"),
});

async function actor({ companies = [], grants = {}, isAdmin = false } = {}) {
  const n = ++seq;
  const email = `ie2a${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "I", lastName: `E${n}`, email, biometricId: `IE2A${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "I" });
  }
  for (const [departmentSlug, role] of Object.entries(grants)) {
    await DepartmentRole.create({
      departmentSlug, email, name: "User", role, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  return {
    email,
    token: jwt.sign(
      { id: String(emp._id), email, name: `IE Actor ${n}`, role: "employee", employeeId: emp.biometricId, isAdmin },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

const editorIn = (...cos) => actor({ companies: cos, grants: { ie: "editor" } });
const viewerIn = (...cos) => actor({ companies: cos, grants: { ie: "viewer" } });

/** Create one operation through the API and hand back the published record. */
async function make(a, co, body) {
  const res = await call("/operations/library", { method: "POST", token: a.token, company: co._id, body });
  expect(res.status).toBe(201);
  return res.body.operation;
}

const LIBRARY = "/operations/library";

/* ══ 1. THE TWO CHECKS ARE TWO ════════════════════════════════════════════ */

describe("a write proves both permission and tenancy", () => {
  test("a viewer reads the library and cannot change one row of it", async () => {
    const co = await company("ViewerCo");
    const editor = await editorIn(co);
    const op = await make(editor, co, { code: "SEW-01", name: "Side seam" });

    const viewer = await viewerIn(co);
    const list = await call(LIBRARY, { token: viewer.token, company: co._id });
    expect(list.status).toBe(200);
    expect(list.body.rows.map((r) => r.code)).toEqual(["SEW-01"]);
    expect((await call(`${LIBRARY}/${op.operationId}`, { token: viewer.token, company: co._id })).status).toBe(200);

    const writes = [
      ["POST", LIBRARY, { code: "X-1", name: "X" }],
      ["PATCH", `${LIBRARY}/${op.operationId}`, { name: "Renamed", expectedRevision: 1 }],
      ["POST", `${LIBRARY}/${op.operationId}/retire`, { expectedRevision: 1 }],
      ["POST", `${LIBRARY}/${op.operationId}/restore`, { expectedRevision: 1 }],
    ];
    for (const [method, path, body] of writes) {
      const res = await call(path, { method, token: viewer.token, company: co._id, body });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("IE_WRITE_FORBIDDEN");
      /* The refusal says what is missing, so a screen can ask for the right
         thing rather than "contact an administrator". */
      expect(res.body.error.details.requires).toEqual({ department: "ie", minimumRole: "editor" });
      expect(res.body.error.details.held).toBe("viewer");
    }
    /* And nothing moved. */
    const after = await IeOperation.findById(op.operationId).lean();
    expect(after.name).toBe("Side seam");
    expect(after.status).toBe("ACTIVE");
    expect(after.revision).toBe(1);
    expect(await IeOperation.countDocuments({ companyId: co._id })).toBe(1);
  });

  test("an editor can create, edit, retire and restore", async () => {
    const co = await company("EditorCo");
    const a = await editorIn(co);

    const created = await make(a, co, { code: "SEW-02", name: "Attach cuff", machineType: "SNLS" });
    expect(created.status).toBe("ACTIVE");

    const edited = await call(`${LIBRARY}/${created.operationId}`, {
      method: "PATCH", token: a.token, company: co._id,
      body: { name: "Attach cuff (double)", expectedRevision: created.revision },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.operation.name).toBe("Attach cuff (double)");

    const retired = await call(`${LIBRARY}/${created.operationId}/retire`, {
      method: "POST", token: a.token, company: co._id,
      body: { expectedRevision: edited.body.operation.revision },
    });
    expect(retired.status).toBe(200);
    expect(retired.body.operation.status).toBe("RETIRED");

    const restored = await call(`${LIBRARY}/${created.operationId}/restore`, {
      method: "POST", token: a.token, company: co._id,
      body: { expectedRevision: retired.body.operation.revision },
    });
    expect(restored.status).toBe(200);
    expect(restored.body.operation.status).toBe("ACTIVE");
  });

  test("membership alone is not permission to write", async () => {
    /* A member of the company with NO ie grant at all. They cannot even read —
       and the write refusal is the write refusal, not a silent success. */
    const co = await company("MemberOnlyCo");
    const a = await actor({ companies: [co], grants: {} });
    const res = await call(LIBRARY, {
      method: "POST", token: a.token, company: co._id, body: { code: "M-1", name: "Member" },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("IE_WRITE_FORBIDDEN");
    expect(await IeOperation.countDocuments({ companyId: co._id })).toBe(0);
  });

  test("permission alone is not membership — an IE owner with no company reaches nothing", async () => {
    const co = await company("NoMembershipCo");
    await company("SecondCoSoNoSingleCompanyFallback");
    const stranger = await actor({ companies: [], grants: { ie: "owner" } });

    const res = await call(LIBRARY, {
      method: "POST", token: stranger.token, company: co._id, body: { code: "S-1", name: "Stranger" },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("TENANT_MEMBERSHIP_UNPROVEN");
    expect(await IeOperation.countDocuments({})).toBe(0);
  });

  test("permission does not cross a company boundary", async () => {
    /* An IE editor in company A, holding a real operation id from company B.
       The permission check passes; the tenancy check is what refuses. */
    const [a1, b1] = [await company("CrossA"), await company("CrossB")];
    const inB = await editorIn(b1);
    const theirs = await make(inB, b1, { code: "SEW-01", name: "Their seam" });

    const inA = await editorIn(a1);
    for (const [method, path, body] of [
      ["PATCH", `${LIBRARY}/${theirs.operationId}`, { name: "Mine now", expectedRevision: 1 }],
      ["POST", `${LIBRARY}/${theirs.operationId}/retire`, { expectedRevision: 1 }],
      ["POST", `${LIBRARY}/${theirs.operationId}/restore`, { expectedRevision: 1 }],
      ["GET", `${LIBRARY}/${theirs.operationId}`, undefined],
    ]) {
      const res = await call(path, { method, token: inA.token, company: a1._id, body });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("IE_OPERATION_NOT_FOUND");
    }
    /* Untouched. */
    const after = await IeOperation.findById(theirs.operationId).lean();
    expect(after.name).toBe("Their seam");
    expect(after.revision).toBe(1);
  });

  test("a multi-company actor must say which company they are working in", async () => {
    const [c1, c2] = [await company("MultiA"), await company("MultiB")];
    const a = await editorIn(c1, c2);

    const refused = await call(LIBRARY, {
      method: "POST", token: a.token, body: { code: "MC-1", name: "Multi" },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("COMPANY_SELECTION_REQUIRED");
    expect(await IeOperation.countDocuments({})).toBe(0);

    /* And naming one they do not hold is the same answer as naming one that
       does not exist — never a confirmation that it is real. */
    const outsider = await company("MultiC");
    const foreign = await call(LIBRARY, {
      method: "POST", token: a.token, company: outsider._id, body: { code: "MC-1", name: "Multi" },
    });
    const invented = await call(LIBRARY, {
      method: "POST", token: a.token, company: new mongoose.Types.ObjectId(), body: { code: "MC-1", name: "Multi" },
    });
    expect(foreign.status).toBe(403);
    expect(foreign.body).toEqual(invented.body);

    /* Chosen properly, it lands in the company they named and nowhere else. */
    const ok = await call(LIBRARY, {
      method: "POST", token: a.token, company: c2._id, body: { code: "MC-1", name: "Multi" },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.operation.companyId).toBe(String(c2._id));
    expect(await IeOperation.countDocuments({ companyId: c1._id })).toBe(0);
  });
});

/* ══ 2. THE PUBLISHED CONTRACT ════════════════════════════════════════════ */

describe("what a create returns", () => {
  test("exactly the contract, and no persistence field", async () => {
    const co = await company("ContractCo");
    const a = await editorIn(co);
    const res = await call(LIBRARY, {
      method: "POST", token: a.token, company: co._id,
      body: { code: "sew 01", name: "Side  seam", machineType: "SNLS", aliases: ["Sidesteam", "side seam op"] },
    });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    const op = res.body.operation;
    expect(Object.keys(op).sort()).toEqual([
      "aliases", "code", "companyId", "createdAt", "createdByName", "isActive", "machineType",
      "name", "operationId", "revision", "status", "statusChangedAt", "statusChangedByName",
      "updatedAt", "updatedByName",
    ]);
    /* Display value preserved as typed (whitespace collapsed); the normalised
       form used for uniqueness is persistence and is not published. */
    expect(op.code).toBe("sew 01");
    expect(op.name).toBe("Side seam");
    expect(op.status).toBe("ACTIVE");
    expect(op.isActive).toBe(true);
    expect(op.revision).toBe(1);
    /* Stamped from the session, so "who registered this" has an answer a year
       later. It is identity only — the name never decides anything. */
    expect(op.createdByName).toMatch(/^IE Actor \d+$/);
    expect(op.updatedByName).toBe(op.createdByName);
    expect(op.statusChangedAt).toBeNull();
    expect(op.aliases).toEqual(["Sidesteam", "side seam op"]);
    expect(JSON.stringify(res.body)).not.toMatch(/codeNormalised|__v|createdBy"|salary/i);

    /* Stored, and stored normalised, so the index can do its job. */
    const stored = await IeOperation.findById(op.operationId).lean();
    expect(stored.codeNormalised).toBe("SEW 01");
  });

  test("the library it returns is the library the create wrote to", async () => {
    const co = await company("RoundTripCo");
    const a = await editorIn(co);
    const op = await make(a, co, { code: "HEM-1", name: "Hem" });
    const list = await call(LIBRARY, { token: a.token, company: co._id });
    expect(list.body.rows.map((r) => r.operationId)).toEqual([op.operationId]);
    expect(list.body.scope).toEqual({
      companyScoped: true,
      register: "IE_COMPANY_OPERATION_LIBRARY",
      message: expect.any(String),
    });
  });

  test("the legacy global register is not written to by any of this", async () => {
    const co = await company("LegacyUntouchedCo");
    const a = await editorIn(co);
    await make(a, co, { code: "SEW-01", name: "Side seam" });
    expect(await LegacyOperation.countDocuments({})).toBe(0);
  });
});

/* ══ 3. THE FIELD RULE ════════════════════════════════════════════════════ */

describe("unknown and invalid fields", () => {
  test("an unknown key is refused BY NAME rather than ignored", async () => {
    const co = await company("UnknownFieldCo");
    const a = await editorIn(co);
    const res = await call(LIBRARY, {
      method: "POST", token: a.token, company: co._id,
      body: { code: "U-1", name: "U", colour: "blue" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
    expect(res.body.error.details.field).toBe("colour");
    expect(res.body.error.details.fieldErrors).toEqual([
      { field: "colour", code: "NOT_ACCEPTED", message: expect.stringContaining("colour") },
    ]);
    expect(await IeOperation.countDocuments({ companyId: co._id })).toBe(0);
  });

  test("a field owned somewhere else is refused with where it lives", async () => {
    const co = await company("RefusedFieldCo");
    const a = await editorIn(co);
    for (const [field, body] of [
      ["totalSam", { code: "R-1", name: "R", totalSam: 1.5 }],
      ["salaryDept", { code: "R-2", name: "R", salaryDept: "Stitching" }],
      ["companyId", { code: "R-3", name: "R", companyId: String(co._id) }],
      ["status", { code: "R-4", name: "R", status: "RETIRED" }],
    ]) {
      const res = await call(LIBRARY, { method: "POST", token: a.token, company: co._id, body });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
      expect(res.body.error.details.field).toBe(field);
    }
    expect(await IeOperation.countDocuments({ companyId: co._id })).toBe(0);
  });

  test("an invalid value names every bad field at once, in the shape a form binds to", async () => {
    const co = await company("InvalidCo");
    const a = await editorIn(co);
    const res = await call(LIBRARY, {
      method: "POST", token: a.token, company: co._id,
      body: { code: "-leading-dash", name: "   ", machineType: "M".repeat(200) },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION");
    const fields = res.body.error.details.fieldErrors;
    expect(fields.map((f) => f.field).sort()).toEqual(["code", "machineType", "name"]);
    expect(fields.map((f) => f.code).sort()).toEqual(["INVALID", "REQUIRED", "TOO_LONG"]);
    for (const f of fields) expect(typeof f.message).toBe("string");
    /* The singular `field` is kept beside the array for the shape every
       existing screen in this codebase already reads. */
    expect(res.body.error.details.field).toBe(fields[0].field);
  });

  test("aliases are synonyms, not second codes", async () => {
    const co = await company("AliasCo");
    const a = await editorIn(co);
    /* Two operations may share an alias, and an alias may equal another
       operation's code, because aliases are not identity. */
    const first = await make(a, co, { code: "OL-1", name: "Overlock", aliases: ["Serge", "Overlock 3T", "OL-1"] });
    expect(first.aliases).toEqual(["Serge", "Overlock 3T"]); // its own code is not its alias
    const second = await make(a, co, { code: "OL-2", name: "Overlock 4T", aliases: ["Serge", "OL-1"] });
    expect(second.aliases).toEqual(["Serge", "OL-1"]);

    /* And they are searchable, which is what they are for. */
    const found = await call(`${LIBRARY}?q=${encodeURIComponent("Serge")}`, { token: a.token, company: co._id });
    expect(found.body.rows.map((r) => r.code).sort()).toEqual(["OL-1", "OL-2"]);
  });

  test("a lifecycle action accepts nothing but the revision", async () => {
    const co = await company("LifecycleShapeCo");
    const a = await editorIn(co);
    const op = await make(a, co, { code: "L-1", name: "L" });
    const res = await call(`${LIBRARY}/${op.operationId}/retire`, {
      method: "POST", token: a.token, company: co._id,
      body: { expectedRevision: 1, name: "sneaky rename" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
    expect(res.body.error.details.field).toBe("name");
    expect((await IeOperation.findById(op.operationId).lean()).status).toBe("ACTIVE");
  });
});

/* ══ 4. UNIQUENESS, ENFORCED WHERE IT HAS TO BE ═══════════════════════════ */

describe("one active code per company", () => {
  test("a duplicate active code in the same company is refused, and says which record holds it", async () => {
    const co = await company("DupCo");
    const a = await editorIn(co);
    const first = await make(a, co, { code: "SEW-01", name: "Side seam" });

    const res = await call(LIBRARY, {
      method: "POST", token: a.token, company: co._id, body: { code: "sew-01", name: "Side seam again" },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_OPERATION_CODE_TAKEN");
    expect(res.body.error.details.conflictingOperationId).toBe(first.operationId);
    expect(res.body.error.details.fieldErrors[0]).toEqual({
      field: "code", code: "DUPLICATE_ACTIVE_CODE", message: expect.any(String),
    });
    expect(await IeOperation.countDocuments({ companyId: co._id })).toBe(1);
  });

  test("the same code in two companies is fine", async () => {
    const [c1, c2] = [await company("SameCodeA"), await company("SameCodeB")];
    const a1 = await editorIn(c1);
    const a2 = await editorIn(c2);
    const one = await make(a1, c1, { code: "SEW-01", name: "Side seam" });
    const two = await make(a2, c2, { code: "SEW-01", name: "Side seam" });
    expect(one.operationId).not.toBe(two.operationId);
    expect(await IeOperation.countDocuments({ codeNormalised: "SEW-01" })).toBe(2);
  });

  test("an edit cannot move a code onto another active operation", async () => {
    const co = await company("EditDupCo");
    const a = await editorIn(co);
    await make(a, co, { code: "SEW-01", name: "Side seam" });
    const other = await make(a, co, { code: "HEM-1", name: "Hem" });

    const res = await call(`${LIBRARY}/${other.operationId}`, {
      method: "PATCH", token: a.token, company: co._id,
      body: { code: "SEW-01", expectedRevision: other.revision },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_OPERATION_CODE_TAKEN");
    expect((await IeOperation.findById(other.operationId).lean()).code).toBe("HEM-1");
  });

  test("two simultaneous creates of one code: the database decides, and exactly one wins", async () => {
    const co = await company("RaceCo");
    const a = await editorIn(co);
    const send = () => call(LIBRARY, {
      method: "POST", token: a.token, company: co._id, body: { code: "RACE-1", name: "Race" },
    });
    const results = await Promise.all([send(), send(), send(), send()]);

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const losers = results.filter((r) => r.status !== 201);
    expect(losers).toHaveLength(3);
    for (const loser of losers) {
      /* A lost race is the documented duplicate-code refusal, never a 500. */
      expect(loser.status).toBe(409);
      expect(loser.body.error.code).toBe("IE_OPERATION_CODE_TAKEN");
    }
    expect(await IeOperation.countDocuments({ companyId: co._id, codeNormalised: "RACE-1" })).toBe(1);
  });

  test("the constraint is an index, not a service pre-check", async () => {
    /* Written straight to the model, past every line of service code. If the
       uniqueness rule lived only in the service this would succeed — which is
       exactly the production failure a route-level test cannot see. */
    const co = await company("IndexCo");
    await IeOperation.create({ companyId: co._id, code: "IDX-1", name: "One", status: "ACTIVE" });
    await expect(
      IeOperation.create({ companyId: co._id, code: "idx-1", name: "Two", status: "ACTIVE" }),
    ).rejects.toMatchObject({ code: 11000 });

    const indexes = await IeOperation.collection.indexes();
    const unique = indexes.find((i) => i.name === "ie_operation_active_code_per_company");
    expect(unique).toMatchObject({
      unique: true,
      key: { companyId: 1, codeNormalised: 1 },
      partialFilterExpression: { status: "ACTIVE" },
    });

    /* And the partial filter is what lets a RETIRED row keep its code. */
    await IeOperation.create({ companyId: co._id, code: "IDX-1", name: "Retired twin", status: "RETIRED" });
    expect(await IeOperation.countDocuments({ companyId: co._id, codeNormalised: "IDX-1" })).toBe(2);
  });
});

/* ══ 5. REVISIONS ═════════════════════════════════════════════════════════ */

describe("optimistic concurrency", () => {
  test("every accepted mutation moves the revision", async () => {
    const co = await company("RevisionCo");
    const a = await editorIn(co);
    const op = await make(a, co, { code: "REV-1", name: "Rev" });
    expect(op.revision).toBe(1);

    const named = await call(`${LIBRARY}/${op.operationId}`, {
      method: "PATCH", token: a.token, company: co._id, body: { name: "Rev 2", expectedRevision: 1 },
    });
    expect(named.body.operation.revision).toBe(2);

    const aliased = await call(`${LIBRARY}/${op.operationId}`, {
      method: "PATCH", token: a.token, company: co._id, body: { aliases: ["synonym"], expectedRevision: 2 },
    });
    expect(aliased.body.operation.revision).toBe(3);

    const retired = await call(`${LIBRARY}/${op.operationId}/retire`, {
      method: "POST", token: a.token, company: co._id, body: { expectedRevision: 3 },
    });
    expect(retired.body.operation.revision).toBe(4);

    const restored = await call(`${LIBRARY}/${op.operationId}/restore`, {
      method: "POST", token: a.token, company: co._id, body: { expectedRevision: 4 },
    });
    expect(restored.body.operation.revision).toBe(5);
  });

  test("a stale revision is refused, and the record is not overwritten", async () => {
    const co = await company("StaleCo");
    const a = await editorIn(co);
    const op = await make(a, co, { code: "ST-1", name: "First" });

    await call(`${LIBRARY}/${op.operationId}`, {
      method: "PATCH", token: a.token, company: co._id, body: { name: "Second", expectedRevision: 1 },
    });
    const stale = await call(`${LIBRARY}/${op.operationId}`, {
      method: "PATCH", token: a.token, company: co._id, body: { name: "Third", expectedRevision: 1 },
    });

    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("IE_OPERATION_REVISION_CONFLICT");
    expect(stale.body.error.details).toMatchObject({ expected: 1, actual: 2 });
    expect((await IeOperation.findById(op.operationId).lean()).name).toBe("Second");
  });

  test("a mutation without a revision is refused before anything is read into it", async () => {
    const co = await company("NoRevisionCo");
    const a = await editorIn(co);
    const op = await make(a, co, { code: "NR-1", name: "NR" });
    /* The retire body carries no `name` — the shape rule is checked first, so
       an unknown key would be refused as FIELD_NOT_ACCEPTED before the
       revision is ever looked at, which is the right order and a different
       claim from this one. */
    for (const [method, path, body] of [
      ["PATCH", `${LIBRARY}/${op.operationId}`, { name: "x" }],
      ["POST", `${LIBRARY}/${op.operationId}/retire`, {}],
      ["POST", `${LIBRARY}/${op.operationId}/restore`, {}],
    ]) {
      const res = await call(path, { method, token: a.token, company: co._id, body });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION");
      expect(res.body.error.details.field).toBe("expectedRevision");
      expect(res.body.error.details.fieldErrors[0].code).toBe("REQUIRED");
    }
    expect((await IeOperation.findById(op.operationId).lean()).revision).toBe(1);
  });
});

/* ══ 6. RETIREMENT AND RESTORE ════════════════════════════════════════════ */

describe("retirement is reversible and deletes nothing", () => {
  test("a retired operation is still there, still readable, and still carries its code", async () => {
    const co = await company("RetireCo");
    const a = await editorIn(co);
    const op = await make(a, co, { code: "RT-1", name: "Retire me", aliases: ["old name"] });

    const retired = await call(`${LIBRARY}/${op.operationId}/retire`, {
      method: "POST", token: a.token, company: co._id, body: { expectedRevision: 1 },
    });
    expect(retired.status).toBe(200);
    expect(retired.body.operation.status).toBe("RETIRED");
    expect(retired.body.operation.isActive).toBe(false);
    expect(retired.body.operation.statusChangedAt).toEqual(expect.any(String));
    expect(retired.body.operation.statusChangedByName).toBeTruthy();

    /* The document itself, unchanged apart from its lifecycle. */
    const stored = await IeOperation.findById(op.operationId).lean();
    expect(stored).toBeTruthy();
    expect(stored.code).toBe("RT-1");
    expect(stored.name).toBe("Retire me");
    expect(stored.aliases).toEqual(["old name"]);

    /* Readable through the API, and listed by default so a style that names it
       still resolves. `status=ACTIVE` is what a picker asks for. */
    expect((await call(`${LIBRARY}/${op.operationId}`, { token: a.token, company: co._id })).status).toBe(200);
    const all = await call(LIBRARY, { token: a.token, company: co._id });
    expect(all.body.rows.map((r) => r.status)).toEqual(["RETIRED"]);
    const active = await call(`${LIBRARY}?status=ACTIVE`, { token: a.token, company: co._id });
    expect(active.body.rows).toEqual([]);
  });

  test("a retired operation cannot be edited — restore is the only door", async () => {
    const co = await company("RetiredEditCo");
    const a = await editorIn(co);
    const op = await make(a, co, { code: "RE-1", name: "Frozen" });
    await call(`${LIBRARY}/${op.operationId}/retire`, {
      method: "POST", token: a.token, company: co._id, body: { expectedRevision: 1 },
    });

    const res = await call(`${LIBRARY}/${op.operationId}`, {
      method: "PATCH", token: a.token, company: co._id, body: { name: "Renamed", expectedRevision: 2 },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_OPERATION_ALREADY_RETIRED");
    expect(res.body.error.details.allowedAction).toBe("restore");
    expect((await IeOperation.findById(op.operationId).lean()).name).toBe("Frozen");
  });

  test("retiring twice, and restoring what is already active, are their own answers", async () => {
    const co = await company("DoubleLifecycleCo");
    const a = await editorIn(co);
    const op = await make(a, co, { code: "DL-1", name: "DL" });

    const already = await call(`${LIBRARY}/${op.operationId}/restore`, {
      method: "POST", token: a.token, company: co._id, body: { expectedRevision: 1 },
    });
    expect(already.status).toBe(409);
    expect(already.body.error.code).toBe("IE_OPERATION_ALREADY_ACTIVE");

    await call(`${LIBRARY}/${op.operationId}/retire`, {
      method: "POST", token: a.token, company: co._id, body: { expectedRevision: 1 },
    });
    const again = await call(`${LIBRARY}/${op.operationId}/retire`, {
      method: "POST", token: a.token, company: co._id, body: { expectedRevision: 2 },
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("IE_OPERATION_ALREADY_RETIRED");
  });

  test("a retired code may be reused, and the restore that would duplicate it is refused", async () => {
    const co = await company("ReuseCo");
    const a = await editorIn(co);
    const first = await make(a, co, { code: "SEW-01", name: "Old side seam" });
    await call(`${LIBRARY}/${first.operationId}/retire`, {
      method: "POST", token: a.token, company: co._id, body: { expectedRevision: 1 },
    });

    /* THE DECISION: retiring RELEASES the code. */
    const second = await make(a, co, { code: "SEW-01", name: "New side seam" });
    expect(second.code).toBe("SEW-01");

    /* And so restoring the old one would put two live SEW-01 in one company. */
    const refused = await call(`${LIBRARY}/${first.operationId}/restore`, {
      method: "POST", token: a.token, company: co._id, body: { expectedRevision: 2 },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("IE_OPERATION_RESTORE_CODE_CONFLICT");
    expect(refused.body.error.details.conflictingOperationId).toBe(second.operationId);
    expect(refused.body.error.details.resolution).toBe("RETIRE_CONFLICTING_THEN_RESTORE");
    expect((await IeOperation.findById(first.operationId).lean()).status).toBe("RETIRED");

    /* Retire the newcomer and the restore becomes possible again — nothing was
       renamed automatically, a person decided. */
    await call(`${LIBRARY}/${second.operationId}/retire`, {
      method: "POST", token: a.token, company: co._id, body: { expectedRevision: 1 },
    });
    const restored = await call(`${LIBRARY}/${first.operationId}/restore`, {
      method: "POST", token: a.token, company: co._id, body: { expectedRevision: 2 },
    });
    expect(restored.status).toBe(200);
    expect(restored.body.operation.status).toBe("ACTIVE");
  });
});

/* ══ 7. NON-DISCLOSURE, AND NO DELETE ═════════════════════════════════════ */

describe("the boundary answers nothing it should not", () => {
  test("a foreign operation, a deleted one and a fabricated id are one answer", async () => {
    const [mine, theirs] = [await company("MineCo"), await company("TheirsCo")];
    const other = await editorIn(theirs);
    const foreign = await make(other, theirs, { code: "F-1", name: "Foreign" });

    const a = await editorIn(mine);
    const answers = await Promise.all([
      call(`${LIBRARY}/${foreign.operationId}`, { token: a.token, company: mine._id }),
      call(`${LIBRARY}/${new mongoose.Types.ObjectId()}`, { token: a.token, company: mine._id }),
      call(`${LIBRARY}/not-an-object-id`, { token: a.token, company: mine._id }),
    ]);
    for (const res of answers) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual(answers[0].body);
    }
    expect(JSON.stringify(answers[0].body)).not.toContain("Foreign");
  });

  test("no hard delete exists — not on this router, and not in the service", async () => {
    const co = await company("NoDeleteCo");
    const a = await actor({ companies: [co], grants: { ie: "owner" } });
    const op = await make(a, co, { code: "ND-1", name: "ND" });

    for (const path of [LIBRARY, `${LIBRARY}/${op.operationId}`, `${LIBRARY}/${op.operationId}/retire`]) {
      const res = await call(path, { method: "DELETE", token: a.token, company: co._id });
      expect(res.status).toBe(404);
    }
    /* PUT is not a verb here either — an edit is a PATCH so an omitted field is
       not a cleared field. */
    expect((await call(`${LIBRARY}/${op.operationId}`, {
      method: "PUT", token: a.token, company: co._id, body: { name: "x" },
    })).status).toBe(404);

    const router = require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes");
    const verbs = router.stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods));
    expect(verbs).not.toContain("delete");
    expect(verbs).not.toContain("put");

    const service = require("../../services/industrialEngineering/ieOperationLibrary.service");
    expect(Object.keys(service).filter((k) => /delete|remove|destroy|purge/i.test(k))).toEqual([]);

    /* And the record is still there after all of that. */
    expect(await IeOperation.countDocuments({ _id: op.operationId })).toBe(1);
  });

  test("an unauthenticated caller reaches none of it", async () => {
    const co = await company("AnonCo");
    for (const [method, path, body] of [
      ["GET", LIBRARY, undefined],
      ["POST", LIBRARY, { code: "A-1", name: "A" }],
      ["PATCH", `${LIBRARY}/${new mongoose.Types.ObjectId()}`, { name: "A", expectedRevision: 1 }],
    ]) {
      const res = await call(path, { method, body, company: co._id });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).not.toBe(200);
    }
    expect(await IeOperation.countDocuments({})).toBe(0);
  });
});

/* ══ 8. CONCURRENCY, AT THE WIRE ══════════════════════════════════════════
 *
 * Read-compare-write would pass every test above and still lose an engineer's
 * change in production: two requests read revision 1, both find it acceptable,
 * both write revision 2. These are the tests that can tell the difference, and
 * they can only tell it by racing real requests. */

describe("two requests, one record, one winner", () => {
  test("two simultaneous edits quoting the same revision: exactly one succeeds", async () => {
    const co = await company("PatchRaceCo");
    const a = await editorIn(co);
    const op = await make(a, co, { code: "PR-1", name: "Original" });

    const [one, two] = await Promise.all([
      call(`${LIBRARY}/${op.operationId}`, {
        method: "PATCH", token: a.token, company: co._id, body: { name: "First writer", expectedRevision: 1 },
      }),
      call(`${LIBRARY}/${op.operationId}`, {
        method: "PATCH", token: a.token, company: co._id, body: { name: "Second writer", expectedRevision: 1 },
      }),
    ]);

    const winners = [one, two].filter((r) => r.status === 200);
    const losers = [one, two].filter((r) => r.status !== 200);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    /* The loser is told what actually happened — not that its input is wrong. */
    expect(losers[0].status).toBe(409);
    expect(losers[0].body.error.code).toBe("IE_OPERATION_REVISION_CONFLICT");
    expect(losers[0].body.error.details).toMatchObject({ expected: 1, actual: 2 });

    /* The winner's values are what is stored, and the revision moved ONCE. */
    const stored = await IeOperation.findById(op.operationId).lean();
    expect(stored.name).toBe(winners[0].body.operation.name);
    expect(["First writer", "Second writer"]).toContain(stored.name);
    expect(stored.revision).toBe(2);
    expect(winners[0].body.operation.revision).toBe(2);
  });

  test("an edit and a retirement quoting the same revision cannot both land", async () => {
    const co = await company("EditVsRetireCo");
    const a = await editorIn(co);
    const op = await make(a, co, { code: "EVR-1", name: "Contested" });

    const [edit, retire] = await Promise.all([
      call(`${LIBRARY}/${op.operationId}`, {
        method: "PATCH", token: a.token, company: co._id, body: { name: "Renamed", expectedRevision: 1 },
      }),
      call(`${LIBRARY}/${op.operationId}/retire`, {
        method: "POST", token: a.token, company: co._id, body: { expectedRevision: 1 },
      }),
    ]);

    const results = [edit, retire];
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const loser = results.find((r) => r.status !== 200);
    expect(loser.status).toBe(409);
    /* Whichever order the database settled on, the refusal is one of the two
       typed answers — never a 500, and never a silent second write. */
    expect(["IE_OPERATION_REVISION_CONFLICT", "IE_OPERATION_ALREADY_RETIRED"])
      .toContain(loser.body.error.code);

    const stored = await IeOperation.findById(op.operationId).lean();
    expect(stored.revision).toBe(2);
    /* Exactly one of the two things happened, not both. */
    expect(stored.status === "RETIRED" ? stored.name : "Renamed").toBe(stored.status === "RETIRED" ? "Contested" : "Renamed");
  });

  test("two simultaneous lifecycle moves quoting the same revision cannot both land", async () => {
    const co = await company("LifecycleRaceCo");
    const a = await editorIn(co);
    const op = await make(a, co, { code: "LR-1", name: "Lifecycle" });

    const retireTwice = await Promise.all([
      call(`${LIBRARY}/${op.operationId}/retire`, { method: "POST", token: a.token, company: co._id, body: { expectedRevision: 1 } }),
      call(`${LIBRARY}/${op.operationId}/retire`, { method: "POST", token: a.token, company: co._id, body: { expectedRevision: 1 } }),
    ]);
    expect(retireTwice.filter((r) => r.status === 200)).toHaveLength(1);
    const retireLoser = retireTwice.find((r) => r.status !== 200);
    expect(retireLoser.status).toBe(409);
    expect(["IE_OPERATION_REVISION_CONFLICT", "IE_OPERATION_ALREADY_RETIRED"]).toContain(retireLoser.body.error.code);
    expect((await IeOperation.findById(op.operationId).lean())).toMatchObject({ status: "RETIRED", revision: 2 });

    /* And the other direction: a retirement racing a restore. */
    const both = await Promise.all([
      call(`${LIBRARY}/${op.operationId}/restore`, { method: "POST", token: a.token, company: co._id, body: { expectedRevision: 2 } }),
      call(`${LIBRARY}/${op.operationId}/restore`, { method: "POST", token: a.token, company: co._id, body: { expectedRevision: 2 } }),
    ]);
    expect(both.filter((r) => r.status === 200)).toHaveLength(1);
    const restoreLoser = both.find((r) => r.status !== 200);
    expect(["IE_OPERATION_REVISION_CONFLICT", "IE_OPERATION_ALREADY_ACTIVE"]).toContain(restoreLoser.body.error.code);
    expect((await IeOperation.findById(op.operationId).lean())).toMatchObject({ status: "ACTIVE", revision: 3 });
  });

  test("a code race stays a code refusal — not a revision error and not a 500", async () => {
    const co = await company("CodeRaceCo");
    const a = await editorIn(co);
    const one = await make(a, co, { code: "CR-1", name: "One" });
    const two = await make(a, co, { code: "CR-2", name: "Two" });

    /* Both edits quote their OWN correct revision, so the revision check
       cannot be what separates them. The only thing that can is the unique
       index — and it must speak in the documented duplicate-code code. */
    const results = await Promise.all([
      call(`${LIBRARY}/${one.operationId}`, {
        method: "PATCH", token: a.token, company: co._id, body: { code: "SHARED-1", expectedRevision: one.revision },
      }),
      call(`${LIBRARY}/${two.operationId}`, {
        method: "PATCH", token: a.token, company: co._id, body: { code: "SHARED-1", expectedRevision: two.revision },
      }),
    ]);

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const loser = results.find((r) => r.status !== 200);
    expect(loser.status).toBe(409);
    expect(loser.body.error.code).toBe("IE_OPERATION_CODE_TAKEN");
    expect(loser.body.error.details.fieldErrors[0].field).toBe("code");
    expect(await IeOperation.countDocuments({ companyId: co._id, codeNormalised: "SHARED-1", status: "ACTIVE" })).toBe(1);

    /* And the loser did not move: a refused edit is not a half-applied one. */
    const stored = await IeOperation.find({ companyId: co._id }).sort({ code: 1 }).lean();
    expect(stored.filter((d) => d.revision === 1)).toHaveLength(1);
  });

  test("a restore conflict offers only an action this API can carry out", async () => {
    const co = await company("RestoreAdviceCo");
    const a = await editorIn(co);
    const old = await make(a, co, { code: "RA-1", name: "Old" });
    await call(`${LIBRARY}/${old.operationId}/retire`, {
      method: "POST", token: a.token, company: co._id, body: { expectedRevision: 1 },
    });
    const holder = await make(a, co, { code: "RA-1", name: "New holder" });

    const refused = await call(`${LIBRARY}/${old.operationId}/restore`, {
      method: "POST", token: a.token, company: co._id, body: { expectedRevision: 2 },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("IE_OPERATION_RESTORE_CODE_CONFLICT");
    expect(refused.body.error.details.resolution).toBe("RETIRE_CONFLICTING_THEN_RESTORE");
    expect(refused.body.error.details.conflictingOperationId).toBe(holder.operationId);
    /* It must NOT suggest re-coding the retired operation: there is no request
       that could do it. */
    expect(refused.body.message).not.toMatch(/different code|another code|rename/i);
    expect(refused.body.message).toMatch(/retire/i);

    /* Proof that the advice it does NOT give is impossible... */
    const recode = await call(`${LIBRARY}/${old.operationId}`, {
      method: "PATCH", token: a.token, company: co._id, body: { code: "RA-2", expectedRevision: 2 },
    });
    expect(recode.status).toBe(409);
    expect(recode.body.error.code).toBe("IE_OPERATION_ALREADY_RETIRED");
    const codeOnRestore = await call(`${LIBRARY}/${old.operationId}/restore`, {
      method: "POST", token: a.token, company: co._id, body: { code: "RA-2", expectedRevision: 2 },
    });
    expect(codeOnRestore.status).toBe(400);
    expect(codeOnRestore.body.error.code).toBe("FIELD_NOT_ACCEPTED");

    /* ...and that the advice it DOES give works, exactly as written. */
    const retired = await call(`${LIBRARY}/${holder.operationId}/retire`, {
      method: "POST", token: a.token, company: co._id, body: { expectedRevision: holder.revision },
    });
    expect(retired.status).toBe(200);
    const restored = await call(`${LIBRARY}/${old.operationId}/restore`, {
      method: "POST", token: a.token, company: co._id, body: { expectedRevision: 2 },
    });
    expect(restored.status).toBe(200);
    expect(restored.body.operation).toMatchObject({ status: "ACTIVE", code: "RA-1", revision: 3 });
  });
});
