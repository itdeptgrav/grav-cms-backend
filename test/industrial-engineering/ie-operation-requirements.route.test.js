// test/industrial-engineering/ie-operation-requirements.route.test.js
//
// IE CHUNK 5A — WHAT AN OPERATION REQUIRES TO BE RUN, AT THE WIRE.
//
// Requirements, not allocations. The claims worth holding are the ones that
// keep that distinction true and keep the profile from leaking into records it
// does not own:
//
//   · machine TYPES, attachments, and operators or helpers at a skill and grade
//     — and no field anywhere for a person, a serial number, an availability or
//     a capacity;
//   · an empty list is a decision ("none required") and is not the same fact as
//     nobody having said yet, which is what `requirementsConfigured` separates;
//   · an omitted group on a PATCH is left exactly as it was;
//   · a row keeps its id through renaming and reordering, and an id this
//     operation does not hold is refused rather than quietly minted;
//   · quantities are whole and positive, and the same machine, attachment or
//     role-skill-grade twice is one requirement with a larger quantity;
//   · a foreign operation answers exactly as one that never existed;
//   · a retired operation still reads and cannot be changed;
//   · and changing requirements moves the operation's revision while leaving
//     every bulletin snapshot and approved standard time exactly where it was.
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
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const IeOperation = require("../../models/CMS_Models/IndustrialEngineering/IeOperation");
const IeStyleFile = require("../../models/CMS_Models/IndustrialEngineering/IeStyleFile");
const IeMethodStudy = require("../../models/CMS_Models/IndustrialEngineering/IeMethodStudy");

const ieLibrary = require("../../services/industrialEngineering/ieOperationLibrary.service");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/ie", require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/ie`;
  await IeOperation.syncIndexes();
  await IeStyleFile.syncIndexes();
  await IeMethodStudy.syncIndexes();
});

afterAll(async () => { await new Promise((r) => server.close(r)); });

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

/* ══ FIXTURES ═════════════════════════════════════════════════════════════ */

async function actor({ companies = [], grants = {} } = {}) {
  const n = ++seq;
  const email = `rq${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "R", lastName: `Q${n}`, email, biometricId: `RQ${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "R" });
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
      { id: String(emp._id), email, name: `IE Engineer ${n}`, role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

const company = (name) => Acc_Company.create({
  companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01"),
});
const editorIn = (...cos) => actor({ companies: cos, grants: { ie: "editor" } });
const viewerIn = (...cos) => actor({ companies: cos, grants: { ie: "viewer" } });

async function operation(a, co, { code = "SEW-01", name = "Side seam", machineType = "SNLS" } = {}) {
  const res = await call("/operations/library", {
    method: "POST", token: a.token, company: co._id, body: { code, name, machineType },
  });
  expect(res.status).toBe(201);
  return res.body.operation;
}

const path = (operationId) => `/operations/library/${operationId}/requirements`;
const read = (a, co, operationId) => call(path(operationId), { token: a.token, company: co._id });
const write = (a, co, operationId, body) => call(path(operationId), {
  method: "PATCH", token: a.token, company: co._id, body,
});

const MACHINES = [{ machineType: "SNLS", quantity: 1 }, { machineType: "Overlock 4T", quantity: 1 }];
const ATTACHMENTS = [{ code: "binder-r", name: "Right binder", quantity: 1, note: "20 mm" }];
const LABOUR = [
  { workerType: "OPERATOR", quantity: 1, skillCode: "sew-b", skillName: "Sewing", grade: "b" },
  { workerType: "HELPER", quantity: 2 },
];

/** A company, an editor, and one operation with a full requirement profile. */
async function configured(name) {
  const co = await company(name);
  const a = await editorIn(co);
  const op = await operation(a, co);
  const res = await write(a, co, op.operationId, {
    expectedRevision: op.revision,
    machineRequirements: MACHINES,
    attachmentRequirements: ATTACHMENTS,
    labourRequirements: LABOUR,
  });
  expect(res.status).toBe(200);
  return { co, a, op, profile: res.body };
}

/* ══ 1. WHO MAY READ AND WRITE ════════════════════════════════════════════ */

describe("reading and setting requirements", () => {
  test("an editor records all three groups; the server mints the ids", async () => {
    const co = await company("Record");
    const a = await editorIn(co);
    const op = await operation(a, co);

    const res = await write(a, co, op.operationId, {
      expectedRevision: op.revision,
      machineRequirements: MACHINES,
      attachmentRequirements: ATTACHMENTS,
      labourRequirements: LABOUR,
    });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);
    const r = res.body.requirements;
    expect(r.requirementsConfigured).toBe(true);
    expect(r.allocates).toBe(false);

    expect(r.machineRequirements.map((m) => [m.machineType, m.quantity, m.sequence]))
      .toEqual([["SNLS", 1, 1], ["Overlock 4T", 1, 2]]);
    expect(r.machineRequirements.every((m) => /^mreq_[0-9a-f]{18}$/.test(m.requirementId))).toBe(true);

    /* Codes are normalised the way every other IE code is. */
    expect(r.attachmentRequirements[0]).toMatchObject({ code: "BINDER-R", name: "Right binder", quantity: 1, note: "20 mm" });
    expect(r.attachmentRequirements[0].requirementId).toMatch(/^areq_[0-9a-f]{18}$/);

    expect(r.labourRequirements[0]).toMatchObject({
      workerType: "OPERATOR", quantity: 1, skillCode: "SEW-B", skillName: "Sewing", grade: "B",
    });
    expect(r.labourRequirements[1]).toMatchObject({ workerType: "HELPER", quantity: 2, skillCode: "", grade: "" });
    expect(r.labourRequirements.every((l) => /^lreq_[0-9a-f]{18}$/.test(l.requirementId))).toBe(true);

    /* Counts of what is REQUIRED — never an availability or a capacity. */
    expect(r.totals).toEqual({ machineTypes: 2, machines: 2, attachments: 1, operators: 1, helpers: 2 });

    /* The operation moved once, with one bounded audit line. */
    expect(res.body.operation.revision).toBe(op.revision + 1);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({
      type: "OPERATION_REQUIREMENTS_UPDATED", operationRevision: 2, actorName: expect.stringMatching(/^IE Engineer /),
    });
    expect(res.body.events[0].changed.sort()).toEqual(["attachment", "labour", "machine"]);
    expect(res.body.events[0].summary.length).toBeLessThanOrEqual(300);
    /* The audit line carries no rows. */
    expect(JSON.stringify(res.body.events)).not.toMatch(/requirementId|BINDER-R/);
  });

  test("a viewer reads the profile and cannot change it", async () => {
    const { co, a, op } = await configured("ViewerReads");
    const viewer = await viewerIn(co);

    const seen = await read(viewer, co, op.operationId);
    expect(seen.status).toBe(200);
    expect(seen.body.requirements.machineRequirements).toHaveLength(2);
    expect(seen.body.operation.operationId).toBe(op.operationId);

    const refused = await write(viewer, co, op.operationId, {
      expectedRevision: 2, machineRequirements: [],
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("IE_WRITE_FORBIDDEN");
    expect(refused.body.error.details.requires).toEqual({ department: "ie", minimumRole: "editor" });

    const after = await IeOperation.findById(op.operationId).lean();
    expect(after.requirements.machine).toHaveLength(2);
    expect(after.revision).toBe(2);
    expect(a).toBeTruthy();
  });

  test("an operation that predates this profile reads as not configured", async () => {
    const co = await company("NotConfigured");
    const a = await editorIn(co);
    const op = await operation(a, co);

    const res = await read(a, co, op.operationId);
    expect(res.status).toBe(200);
    expect(res.body.requirements).toMatchObject({
      requirementsConfigured: false,
      machineRequirements: [], attachmentRequirements: [], labourRequirements: [],
    });
    expect(res.body.requirements.totals).toEqual({ machineTypes: 0, machines: 0, attachments: 0, operators: 0, helpers: 0 });
    expect(res.body.history).toEqual([]);

    /* And a document written before the field existed at all reads the same. */
    await IeOperation.collection.updateOne({ _id: new mongoose.Types.ObjectId(op.operationId) }, { $unset: { requirements: "" } });
    const legacy = await read(a, co, op.operationId);
    expect(legacy.status).toBe(200);
    expect(legacy.body.requirements.requirementsConfigured).toBe(false);
    expect(legacy.body.requirements.labourRequirements).toEqual([]);
  });

  test("empty lists are a decision, and are recorded as one", async () => {
    const co = await company("NoneRequired");
    const a = await editorIn(co);
    const op = await operation(a, co);

    const res = await write(a, co, op.operationId, {
      expectedRevision: op.revision,
      machineRequirements: [], attachmentRequirements: [], labourRequirements: [],
    });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);
    /* Configured TRUE with every list empty: somebody said "none required". */
    expect(res.body.requirements.requirementsConfigured).toBe(true);
    expect(res.body.requirements.machineRequirements).toEqual([]);
    expect(res.body.operation.revision).toBe(2);
    expect(res.body.events[0].changed).toEqual(["profile"]);

    const stored = await IeOperation.findById(op.operationId).lean();
    expect(stored.requirements.configured).toBe(true);
  });

  test("an omitted group is left exactly as it was", async () => {
    const { co, a, op, profile } = await configured("Omission");
    const machineIds = profile.requirements.machineRequirements.map((m) => m.requirementId);

    const res = await write(a, co, op.operationId, {
      expectedRevision: 2,
      attachmentRequirements: [{ code: "GUIDE-1", name: "Edge guide", quantity: 1 }],
    });

    expect(res.status).toBe(200);
    expect(res.body.requirements.attachmentRequirements.map((x) => x.code)).toEqual(["GUIDE-1"]);
    /* Untouched, ids and all. */
    expect(res.body.requirements.machineRequirements.map((m) => m.requirementId)).toEqual(machineIds);
    expect(res.body.requirements.labourRequirements).toHaveLength(2);
    expect(res.body.events[0].changed).toEqual(["attachment"]);
  });

  test("a PATCH naming no group at all is refused", async () => {
    const { co, a, op } = await configured("NoGroup");
    const res = await write(a, co, op.operationId, { expectedRevision: 2 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IE_OPERATION_REQUIREMENTS_NO_CHANGE_REQUESTED");
    expect(res.body.error.details.accepts)
      .toEqual(["machineRequirements", "attachmentRequirements", "labourRequirements"]);
    expect((await IeOperation.findById(op.operationId).lean()).revision).toBe(2);
  });
});

/* ══ 1b. THE FIRST ANSWER IS A COMPLETE ONE ═══════════════════════════════
 *
 * `requirementsConfigured` says somebody has decided what this operation needs,
 * and that decision covers all three groups. A first PATCH naming only machines
 * would store the other two as empty and mark the profile configured — writing
 * down an answer about attachments that nobody gave. */

describe("configuring a profile for the first time", () => {
  test("a first PATCH naming one group is refused, and writes nothing", async () => {
    const co = await company("FirstPartial");
    const a = await editorIn(co);
    const op = await operation(a, co);
    const before = await IeOperation.findById(op.operationId).lean();

    const res = await write(a, co, op.operationId, {
      expectedRevision: op.revision, machineRequirements: MACHINES,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IE_OPERATION_REQUIREMENTS_INVALID");
    expect(res.body.error.details.missing).toEqual(["attachmentRequirements", "labourRequirements"]);
    /* One error per missing group, so a form marks both at once. */
    expect(res.body.error.details.fieldErrors).toEqual([
      { field: "attachmentRequirements", code: "REQUIRED", message: expect.stringContaining("attachments") },
      { field: "labourRequirements", code: "REQUIRED", message: expect.stringContaining("operators and helpers") },
    ]);

    const after = await IeOperation.findById(op.operationId).lean();
    expect(after.revision).toBe(before.revision);
    expect(after.requirements.configured).toBe(false);
    expect(after.requirements.machine).toEqual([]);
    expect(after.history).toHaveLength(before.history.length);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
  });

  test("a first PATCH naming two groups is refused for the third", async () => {
    const co = await company("FirstTwo");
    const a = await editorIn(co);
    const op = await operation(a, co);

    const res = await write(a, co, op.operationId, {
      expectedRevision: op.revision, machineRequirements: MACHINES, attachmentRequirements: ATTACHMENTS,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IE_OPERATION_REQUIREMENTS_INVALID");
    expect(res.body.error.details.missing).toEqual(["labourRequirements"]);
    expect(res.body.error.details.fieldErrors).toHaveLength(1);
    expect((await IeOperation.findById(op.operationId).lean()).requirements.configured).toBe(false);
  });

  test("three explicit empty lists are a deliberate all-none profile", async () => {
    const co = await company("FirstAllNone");
    const a = await editorIn(co);
    const op = await operation(a, co);

    const res = await write(a, co, op.operationId, {
      expectedRevision: op.revision,
      machineRequirements: [], attachmentRequirements: [], labourRequirements: [],
    });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);
    expect(res.body.requirements.requirementsConfigured).toBe(true);
    expect(res.body.requirements.totals).toEqual({ machineTypes: 0, machines: 0, attachments: 0, operators: 0, helpers: 0 });
    expect(res.body.operation.revision).toBe(op.revision + 1);
    expect(res.body.events[0].changed).toEqual(["profile"]);
  });

  test("once configured, a one-group PATCH leaves the other two alone", async () => {
    const co = await company("PartialAfterFirst");
    const a = await editorIn(co);
    const op = await operation(a, co);
    const first = await write(a, co, op.operationId, {
      expectedRevision: op.revision,
      machineRequirements: MACHINES, attachmentRequirements: ATTACHMENTS, labourRequirements: LABOUR,
    });
    expect(first.status).toBe(200);
    const attachmentIds = first.body.requirements.attachmentRequirements.map((x) => x.requirementId);
    const labourIds = first.body.requirements.labourRequirements.map((x) => x.requirementId);

    const second = await write(a, co, op.operationId, {
      expectedRevision: first.body.operation.revision,
      machineRequirements: [{ machineType: "Bartack", quantity: 1 }],
    });

    expect(second.status).toBe(200);
    expect(second.body.requirements.machineRequirements.map((m) => m.machineType)).toEqual(["Bartack"]);
    expect(second.body.requirements.attachmentRequirements.map((x) => x.requirementId)).toEqual(attachmentIds);
    expect(second.body.requirements.labourRequirements.map((x) => x.requirementId)).toEqual(labourIds);
    expect(second.body.events[0].changed).toEqual(["machine"]);
  });
});

/* ══ 2. ROW IDENTITY ══════════════════════════════════════════════════════ */

describe("a requirement row keeps its identity", () => {
  test("ids survive editing and reordering; new rows get their own", async () => {
    const { co, a, op, profile } = await configured("StableIds");
    const [snls, overlock] = profile.requirements.machineRequirements;

    const res = await write(a, co, op.operationId, {
      expectedRevision: 2,
      machineRequirements: [
        { requirementId: overlock.requirementId, machineType: "Overlock 5T", quantity: 2 },
        { requirementId: snls.requirementId, machineType: "SNLS", quantity: 1 },
        { machineType: "Bartack", quantity: 1 },
      ],
    });

    expect(res.status).toBe(200);
    const rows = res.body.requirements.machineRequirements;
    expect(rows.map((m) => m.requirementId).slice(0, 2)).toEqual([overlock.requirementId, snls.requirementId]);
    expect(rows.map((m) => m.sequence)).toEqual([1, 2, 3]);
    expect(rows[0]).toMatchObject({ machineType: "Overlock 5T", quantity: 2 });
    expect(rows[2].requirementId).toMatch(/^mreq_[0-9a-f]{18}$/);
    expect([snls.requirementId, overlock.requirementId]).not.toContain(rows[2].requirementId);
  });

  test("an id this operation does not hold is refused", async () => {
    const { co, a, op, profile } = await configured("UnknownId");
    const other = await operation(a, co, { code: "HEM-01", name: "Hem" });
    const otherProfile = await write(a, co, other.operationId, {
      expectedRevision: other.revision,
      machineRequirements: [{ machineType: "SNLS", quantity: 1 }],
      attachmentRequirements: [],
      labourRequirements: [],
    });
    const foreignId = otherProfile.body.requirements.machineRequirements[0].requirementId;

    for (const requirementId of ["mreq_deadbeefdeadbeefde", foreignId]) {
      const res = await write(a, co, op.operationId, {
        expectedRevision: 2, machineRequirements: [{ requirementId, machineType: "SNLS", quantity: 1 }],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("IE_OPERATION_REQUIREMENT_NOT_FOUND");
      expect(res.body.error.details.requirementId).toBe(requirementId);
      expect(res.body.error.details.fieldErrors[0]).toMatchObject({
        field: "machineRequirements.0.requirementId", requirementId, index: 0,
      });
    }

    /* A group id used in the wrong group is equally unknown. */
    const crossed = await write(a, co, op.operationId, {
      expectedRevision: 2,
      attachmentRequirements: [{ requirementId: profile.requirements.machineRequirements[0].requirementId, code: "X", name: "X", quantity: 1 }],
    });
    expect(crossed.body.error.code).toBe("IE_OPERATION_REQUIREMENT_NOT_FOUND");
    expect((await IeOperation.findById(op.operationId).lean()).revision).toBe(2);
  });
});

/* ══ 3. WHAT A REQUIREMENT MAY SAY ════════════════════════════════════════ */

describe("validation", () => {
  test("quantities are whole and positive", async () => {
    const { co, a, op } = await configured("Quantities");
    for (const quantity of [0, -1, 1.5, "2", null, undefined, Number.NaN]) {
      const res = await write(a, co, op.operationId, {
        expectedRevision: 2, machineRequirements: [{ machineType: "SNLS", quantity }],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("IE_OPERATION_REQUIREMENT_QUANTITY_INVALID");
      expect(res.body.error.details.fieldErrors[0].field).toBe("machineRequirements.0.quantity");
      expect(res.body.error.details.fieldErrors[0].index).toBe(0);
    }
    expect((await IeOperation.findById(op.operationId).lean()).revision).toBe(2);
  });

  test("the same machine, attachment or role twice is refused", async () => {
    const { co, a, op } = await configured("Duplicates");

    const machines = await write(a, co, op.operationId, {
      expectedRevision: 2,
      machineRequirements: [{ machineType: "SNLS", quantity: 1 }, { machineType: "snls", quantity: 2 }],
    });
    expect(machines.status).toBe(400);
    expect(machines.body.error.code).toBe("IE_OPERATION_REQUIREMENT_MACHINE_DUPLICATE");
    expect(machines.body.error.details.field).toBe("machineRequirements.1.machineType");

    const attachments = await write(a, co, op.operationId, {
      expectedRevision: 2,
      attachmentRequirements: [
        { code: "BINDER-R", name: "Right binder", quantity: 1 },
        { code: "binder-r", name: "Right binder again", quantity: 1 },
      ],
    });
    expect(attachments.status).toBe(400);
    expect(attachments.body.error.code).toBe("IE_OPERATION_REQUIREMENT_ATTACHMENT_DUPLICATE");

    const labour = await write(a, co, op.operationId, {
      expectedRevision: 2,
      labourRequirements: [
        { workerType: "OPERATOR", quantity: 1, skillCode: "SEW-B", grade: "B" },
        { workerType: "operator", quantity: 1, skillCode: "sew-b", grade: "b" },
      ],
    });
    expect(labour.status).toBe(400);
    expect(labour.body.error.code).toBe("IE_OPERATION_REQUIREMENT_LABOUR_DUPLICATE");
    expect(labour.body.message).toMatch(/once with the quantity/i);

    /* Two helpers at DIFFERENT grades are two real requirements. */
    const distinct = await write(a, co, op.operationId, {
      expectedRevision: 2,
      labourRequirements: [
        { workerType: "HELPER", quantity: 1, grade: "A" },
        { workerType: "HELPER", quantity: 1, grade: "B" },
      ],
    });
    expect(distinct.status).toBe(200);
    expect(distinct.body.requirements.labourRequirements).toHaveLength(2);
  });

  test("what makes two labour rows the same requirement", async () => {
    const { co, a, op } = await configured("LabourIdentity");
    /* Accepted writes move the revision, so it is threaded through — a refused
       one leaves it exactly where it was. */
    let revision = 2;
    const labour = async (rows) => {
      const res = await write(a, co, op.operationId, { expectedRevision: revision, labourRequirements: rows });
      if (res.status === 200) revision = res.body.operation.revision;
      return res;
    };

    /* 1. The same CODE is the same skill, whatever it is displayed as. */
    const sameCode = await labour([
      { workerType: "OPERATOR", quantity: 1, skillCode: "SEW-B", skillName: "Sewing", grade: "B" },
      { workerType: "OPERATOR", quantity: 1, skillCode: "sew-b", skillName: "Machine sewing", grade: "B" },
    ]);
    expect(sameCode.status).toBe(400);
    expect(sameCode.body.error.code).toBe("IE_OPERATION_REQUIREMENT_LABOUR_DUPLICATE");

    /* 2. With NO code, the skill name is what distinguishes them — this is the
       pair the old key wrongly collapsed into one requirement. */
    const namedSkills = await labour([
      { workerType: "OPERATOR", quantity: 1, skillName: "Sewing", grade: "B" },
      { workerType: "OPERATOR", quantity: 1, skillName: "Cutting", grade: "B" },
    ]);
    expect(namedSkills.status).toBe(200);
    expect(namedSkills.body.requirements.labourRequirements.map((l) => l.skillName)).toEqual(["Sewing", "Cutting"]);

    /* 3. Case and spacing are not a difference. */
    const sameName = await labour([
      { workerType: "OPERATOR", quantity: 1, skillName: "Sewing", grade: "B" },
      { workerType: "OPERATOR", quantity: 1, skillName: "  sewing  ", grade: "b" },
    ]);
    expect(sameName.status).toBe(400);
    expect(sameName.body.error.code).toBe("IE_OPERATION_REQUIREMENT_LABOUR_DUPLICATE");

    /* 4. Two rows with no skill at all say the same thing twice. */
    const blank = await labour([
      { workerType: "HELPER", quantity: 1, grade: "A" },
      { workerType: "HELPER", quantity: 2, grade: "A" },
    ]);
    expect(blank.status).toBe(400);
    expect(blank.body.error.code).toBe("IE_OPERATION_REQUIREMENT_LABOUR_DUPLICATE");

    /* And a coded skill is not the same requirement as an uncoded one that
       happens to share a display name — the code is the identity when present. */
    const codedAndNot = await labour([
      { workerType: "OPERATOR", quantity: 1, skillCode: "SEW-B", skillName: "Sewing", grade: "B" },
      { workerType: "OPERATOR", quantity: 1, skillName: "Sewing", grade: "B" },
    ]);
    expect(codedAndNot.status).toBe(200);
    expect(codedAndNot.body.requirements.labourRequirements.map((l) => l.skillCode)).toEqual(["SEW-B", ""]);
  });

  test("malformed groups and entries are refused", async () => {
    const { co, a, op } = await configured("Malformed");
    for (const [body, code] of [
      [{ expectedRevision: 2, machineRequirements: null }, "IE_OPERATION_REQUIREMENTS_INVALID"],
      [{ expectedRevision: 2, machineRequirements: "SNLS" }, "IE_OPERATION_REQUIREMENTS_INVALID"],
      [{ expectedRevision: 2, machineRequirements: [null] }, "IE_OPERATION_REQUIREMENTS_INVALID"],
      [{ expectedRevision: 2, machineRequirements: [{ quantity: 1 }] }, "IE_OPERATION_REQUIREMENTS_INVALID"],
      [{ expectedRevision: 2, attachmentRequirements: [{ code: "X", quantity: 1 }] }, "IE_OPERATION_REQUIREMENTS_INVALID"],
      [{ expectedRevision: 2, labourRequirements: [{ workerType: "SUPERVISOR", quantity: 1 }] }, "IE_OPERATION_REQUIREMENTS_INVALID"],
      [{ expectedRevision: 2, labourRequirements: [{ quantity: 1 }] }, "IE_OPERATION_REQUIREMENTS_INVALID"],
    ]) {
      const res = await write(a, co, op.operationId, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(code);
      expect(typeof res.body.error.details.field).toBe("string");
    }
    expect((await IeOperation.findById(op.operationId).lean()).revision).toBe(2);
  });

  test("a requirement cannot name a person, a machine or an availability", async () => {
    const { co, a, op } = await configured("NoAllocation");
    for (const [group, row] of [
      ["labourRequirements", { workerType: "OPERATOR", quantity: 1, employeeId: "GR0067" }],
      ["labourRequirements", { workerType: "OPERATOR", quantity: 1, employeeName: "Someone" }],
      ["labourRequirements", { workerType: "OPERATOR", quantity: 1, wageRate: 500 }],
      ["machineRequirements", { machineType: "SNLS", quantity: 1, machineId: String(new mongoose.Types.ObjectId()) }],
      ["machineRequirements", { machineType: "SNLS", quantity: 1, serialNumber: "SN-4471" }],
      ["machineRequirements", { machineType: "SNLS", quantity: 1, available: 2 }],
      ["machineRequirements", { machineType: "SNLS", quantity: 1, capacity: 480 }],
      ["machineRequirements", { machineType: "SNLS", quantity: 1, sequence: 3 }],
      ["attachmentRequirements", { code: "X", name: "X", quantity: 1, colour: "blue" }],
    ]) {
      const res = await write(a, co, op.operationId, { expectedRevision: 2, [group]: [row] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
    }

    /* And nothing of that kind is anywhere on the stored record or in a read. */
    const stored = await IeOperation.findById(op.operationId).lean();
    expect(JSON.stringify(stored)).not.toMatch(/employeeId|employeeName|serialNumber|wageRate|salary|available|capacity/i);
    const seen = await read(a, co, op.operationId);
    expect(JSON.stringify(seen.body)).not.toMatch(/employee|payroll|serial|wage|salary|availab|capacity|shortage/i);
  });
});

/* ══ 4. COMPANY, LIFECYCLE AND CONCURRENCY ════════════════════════════════ */

describe("whose operation it is, and when it may change", () => {
  test("a foreign operation answers exactly as one that never existed", async () => {
    const theirs = await configured("TheirOperation");
    const mine = await company("MyOperation");
    const a = await editorIn(mine);

    const foreignRead = await read(a, mine, theirs.op.operationId);
    const inventedRead = await read(a, mine, new mongoose.Types.ObjectId());
    expect(foreignRead.status).toBe(404);
    expect(foreignRead.body).toEqual(inventedRead.body);
    expect(foreignRead.body.error.code).toBe("IE_OPERATION_NOT_FOUND");
    expect(JSON.stringify(foreignRead.body)).not.toMatch(/SNLS|BINDER-R|Side seam/);

    const foreignWrite = await write(a, mine, theirs.op.operationId, {
      expectedRevision: 2, machineRequirements: [],
    });
    const inventedWrite = await write(a, mine, new mongoose.Types.ObjectId(), {
      expectedRevision: 2, machineRequirements: [],
    });
    expect(foreignWrite.status).toBe(404);
    expect(foreignWrite.body).toEqual(inventedWrite.body);

    const untouched = await IeOperation.findById(theirs.op.operationId).lean();
    expect(untouched.requirements.machine).toHaveLength(2);
    expect(untouched.revision).toBe(2);
  });

  test("a retired operation still reads, and refuses a change", async () => {
    const { co, a, op } = await configured("Retired");
    const retired = await call(`/operations/library/${op.operationId}/retire`, {
      method: "POST", token: a.token, company: co._id, body: { expectedRevision: 2 },
    });
    expect(retired.status).toBe(200);

    const seen = await read(a, co, op.operationId);
    expect(seen.status).toBe(200);
    expect(seen.body.operation.status).toBe("RETIRED");
    expect(seen.body.requirements.machineRequirements).toHaveLength(2);

    const refused = await write(a, co, op.operationId, {
      expectedRevision: seen.body.operation.revision, machineRequirements: [],
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("IE_OPERATION_ALREADY_RETIRED");
    expect(refused.body.error.details.allowedAction).toBe("restore");

    const stored = await IeOperation.findById(op.operationId).lean();
    expect(stored.requirements.machine).toHaveLength(2);
    expect(stored.revision).toBe(seen.body.operation.revision);
  });

  test("a stale revision is refused without touching anything", async () => {
    const { co, a, op } = await configured("Stale");
    await write(a, co, op.operationId, { expectedRevision: 2, attachmentRequirements: [] });

    const stale = await write(a, co, op.operationId, {
      expectedRevision: 2, machineRequirements: [{ machineType: "Bartack", quantity: 1 }],
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("IE_OPERATION_REVISION_CONFLICT");
    expect(stale.body.error.details).toMatchObject({ expected: 2, actual: 3 });

    const stored = await IeOperation.findById(op.operationId).lean();
    expect(stored.revision).toBe(3);
    expect(stored.requirements.machine.map((m) => m.machineType)).toEqual(["SNLS", "Overlock 4T"]);
  });

  test("a save that changes nothing changes nothing", async () => {
    const { co, a, op, profile } = await configured("NoOp");
    const before = await IeOperation.findById(op.operationId).lean();

    const resend = (rows, pick) => rows.map((r) => Object.fromEntries(pick.map((k) => [k, r[k]])));
    const res = await write(a, co, op.operationId, {
      expectedRevision: 2,
      machineRequirements: resend(profile.requirements.machineRequirements, ["requirementId", "machineType", "quantity"]),
      attachmentRequirements: resend(profile.requirements.attachmentRequirements, ["requirementId", "code", "name", "quantity", "note"]),
      labourRequirements: resend(profile.requirements.labourRequirements, ["requirementId", "workerType", "quantity", "skillCode", "skillName", "grade", "note"]),
    });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(false);
    expect(res.body.events).toEqual([]);
    expect(res.body.requirements.machineRequirements).toHaveLength(2);

    const after = await IeOperation.findById(op.operationId).lean();
    expect(after.revision).toBe(before.revision);
    expect(after.history).toHaveLength(before.history.length);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
  });

  test("two simultaneous edits: exactly one lands", async () => {
    const { co, a, op } = await configured("Race");
    const send = (machineType) => write(a, co, op.operationId, {
      expectedRevision: 2, machineRequirements: [{ machineType, quantity: 1 }],
    });
    const [one, two] = await Promise.all([send("Bartack"), send("Kansai")]);

    expect([one, two].filter((r) => r.status === 200)).toHaveLength(1);
    const loser = [one, two].find((r) => r.status !== 200);
    expect(loser.status).toBe(409);
    expect(loser.body.error.code).toBe("IE_OPERATION_REVISION_CONFLICT");

    const stored = await IeOperation.findById(op.operationId).lean();
    expect(stored.revision).toBe(3);
    expect(stored.requirements.machine).toHaveLength(1);
    expect(stored.history.filter((e) => e.type === "OPERATION_REQUIREMENTS_UPDATED")).toHaveLength(2);
  });
});

/* ══ 5. NOTHING DOWNSTREAM MOVES ══════════════════════════════════════════ */

describe("what setting requirements does not do", () => {
  /** An order, a style, an engineering file and a bulletin row on this operation. */
  async function withBulletin(name) {
    const co = await company(name);
    const a = await editorIn(co);
    const accountId = new mongoose.Types.ObjectId();
    const journey = await SalesJourney.create({
      journeyId: `SJ-${name}-${++seq}`, companyId: co._id, accountId,
      ownerId: new mongoose.Types.ObjectId(), ownerName: "Owner", name: `J ${name}`, isActive: true,
    });
    const enquiry = await Enquiry.create({
      enquiryId: `ENQ-${name}-${seq}`, journeyId: journey._id, accountId, companyId: co._id,
      title: `E ${name}`, isActive: true, products: [{ product: "Tee", quantity: 500 }],
    });
    const item = await StockItem.create({
      name: `Tee ${name}`, sku: `SKU-${name}-${seq}`, reference: `REF-${name}-${seq}`,
      category: "Garment", createdBy: new mongoose.Types.ObjectId(),
      quantityOnHand: 0, minStock: 0, maxStock: 10,
      variants: [{ sku: `VAR-${name}-${seq}`, cost: 0, salesPrice: 0 }],
    });
    const wo = await WorkOrder.create({
      workOrderNumber: `WO-${name}-${seq}`, stockItemId: item._id, stockItemName: item.name,
      stockItemReference: item.reference, quantity: 500, originalQuantity: 500, status: "planned",
      timeline: { plannedStartDate: new Date("2026-10-01"), plannedEndDate: new Date("2026-10-20") },
      customerId: new mongoose.Types.ObjectId(), customerName: "Northwind Apparel Ltd",
    });
    const style = await SampleStyle.create({
      sampleStyleId: `SS-${name}-${seq}`, productName: `Tee ${name}`, styleCode: `ST-${name}`,
      variantLabel: "Navy", journeyId: journey._id, enquiryId: enquiry._id, sourceStockItemId: item._id,
      materials: { status: "pending", rawItems: [] },
      techSheet: {
        technical: { status: "approved", revision: 3 },
        technicalRevisions: [{
          revision: 3, submittedAt: new Date("2026-08-01"), outcome: "approved", decidedAt: new Date("2026-08-05"),
          snapshot: { revision: 3, materials: [], requirements: [], operations: [] },
        }],
      },
      production: { workOrderIds: [wo._id] },
    });

    const op = await operation(a, co);
    const file = (await call(`/orders/${wo._id}/styles/${style._id}/engineering-file`, {
      method: "POST", token: a.token, company: co._id, body: {},
    })).body.file;
    const bulletin = await call(`/engineering-files/${file.fileId}/bulletin`, {
      method: "PATCH", token: a.token, company: co._id,
      body: { expectedRevision: 1, rows: [{ ieOperationId: op.operationId, proposedSamMinutes: 1.5 }] },
    });
    expect(bulletin.status).toBe(200);
    return { co, a, op, fileId: file.fileId, row: bulletin.body.file.bulletin.rows[0], fileRevision: bulletin.body.file.revision };
  }

  test("a bulletin row keeps the operation snapshot it was written with", async () => {
    const { co, a, op, fileId, row, fileRevision } = await withBulletin("BulletinUntouched");
    expect(row).toMatchObject({ ieOperationRevision: 1, operationCode: "SEW-01", operationName: "Side seam", machineType: "SNLS" });
    const fileBefore = await IeStyleFile.findById(fileId).lean();

    /* The first profile answers all three groups; the second changes one. The
       operation reaches revision 3. */
    await write(a, co, op.operationId, {
      expectedRevision: 1,
      machineRequirements: MACHINES,
      attachmentRequirements: [],
      labourRequirements: LABOUR,
    });
    const second = await write(a, co, op.operationId, {
      expectedRevision: 2, attachmentRequirements: ATTACHMENTS,
    });
    expect(second.body.operation.revision).toBe(3);

    const fileAfter = await IeStyleFile.findById(fileId).lean();
    expect(fileAfter.revision).toBe(fileRevision);
    expect(fileAfter.revision).toBe(fileBefore.revision);
    /* The row still says revision 1, and still says SNLS. */
    expect(fileAfter.bulletin.rows[0]).toMatchObject({
      rowId: row.rowId, ieOperationRevision: 1, operationCode: "SEW-01",
      operationName: "Side seam", machineType: "SNLS", proposedSamMinutes: 1.5,
    });
    expect(fileAfter.bulletin.rows).toEqual(fileBefore.bulletin.rows);
    expect(fileAfter.history).toHaveLength(fileBefore.history.length);

    /* A method study opened from that row captures the row's revision, not the
       operation's current one. */
    const study = await call(`/engineering-files/${fileId}/bulletin/${row.rowId}/method-studies`, {
      method: "POST", token: a.token, company: co._id, body: {},
    });
    expect(study.status).toBe(201);
    expect(study.body.study.operation).toMatchObject({ ieOperationRevision: 1, operationCode: "SEW-01", machineType: "SNLS" });
    expect(study.body.study.applicability).toBe("CURRENT");

    /* And changing requirements again does not make that study stale. */
    await write(a, co, op.operationId, { expectedRevision: 3, machineRequirements: [] });
    const still = await call(`/method-studies/${study.body.study.studyId}`, { token: a.token, company: co._id });
    expect(still.body.study.applicability).toBe("CURRENT");
    expect(still.body.study.operation.ieOperationRevision).toBe(1);
  });

  test("there is no endpoint that allocates, releases or calculates capacity", async () => {
    const { co, a, op } = await configured("NoDownstream");
    for (const p of [
      `/operations/library/${op.operationId}/requirements/allocate`,
      `/operations/library/${op.operationId}/requirements/assign`,
      `/operations/library/${op.operationId}/requirements/release`,
      `/operations/library/${op.operationId}/requirements/publish`,
      `/operations/library/${op.operationId}/capacity`,
      `/operations/library/${op.operationId}/availability`,
      "/capacity",
      "/machines",
    ]) {
      expect((await call(p, { method: "POST", token: a.token, company: co._id, body: {} })).status).toBe(404);
    }
    expect((await call(path(op.operationId), { method: "DELETE", token: a.token, company: co._id })).status).toBe(404);

    const router = require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes");
    const paths = router.stack.filter((l) => l.route).map((l) => l.route.path);
    expect(paths.filter((p) => /allocate|assign|availab|shortage|machines?$/i.test(p))).toEqual([]);
    /* Chunk 7A added capacity STANDARDS, which hang off a line layout and never
       off an operation's requirements. Nothing here grew a capacity door. */
    expect(paths.filter((p) => /capacity/i.test(p) && /operations|requirements/i.test(p))).toEqual([]);
    expect(paths.filter((p) => /capacity/i.test(p)).every(
      (p) => p === "/capacity-standards"
        || p === "/capacity-standards/:capacityStandardId"
        /* Chunk 7C3's one added verb, and it still hangs off a standard rather
           than off an operation's requirements. */
        || p === "/capacity-standards/:capacityStandardId/approve"
        || p === "/line-layouts/:layoutId/capacity-standards",
    )).toBe(true);
    /* Two release routes exist on this router and no more: CHUNK 8A-i's
       `POST /style-files/:fileId/releases`, which issues one, and 8A-iii's
       `GET /releases/:releaseId/impact`, which only READS what has moved
       since. Both are excluded by name rather than by weakening the pattern,
       so anything else matching would still be caught. Everything DOWNSTREAM
       of a release — acknowledging it, a PPC receipt, withdrawal, an outbox —
       is still absent, and PPC's receipt is on PPC's own router. */
    expect(paths.filter((p) => /release|apply/i.test(p))
      .filter((p) => p !== "/style-files/:fileId/releases"
        && p !== "/releases/:releaseId/impact")).toEqual([]);
    expect(router.stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods))).not.toContain("delete");

    /* And the service exports one reader and one writer — no general-purpose
       mutation helper somebody could point at another field. */
    expect(Object.keys(ieLibrary).filter((k) => /^(set|patch|mutate|update)[A-Z]/.test(k)).sort())
      .toEqual(["updateOperation", "updateRequirements"]);
  });

  test("the operation's own create, edit and lifecycle contract is unchanged", async () => {
    const { co, a, op } = await configured("ContractIntact");
    /* The published operation is exactly the Chunk 2A shape — requirements are
       addressed through their own endpoint, not folded into it. */
    const listed = await call("/operations/library", { token: a.token, company: co._id });
    expect(Object.keys(listed.body.rows[0]).sort()).toEqual([
      "aliases", "code", "companyId", "createdAt", "createdByName", "isActive", "machineType",
      "name", "operationId", "revision", "status", "statusChangedAt", "statusChangedByName",
      "updatedAt", "updatedByName",
    ]);

    /* An ordinary edit still works and still moves the revision by one. */
    const edited = await call(`/operations/library/${op.operationId}`, {
      method: "PATCH", token: a.token, company: co._id, body: { name: "Side seam (twin)", expectedRevision: 2 },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.operation.revision).toBe(3);
    /* And the requirements it never mentioned are still there. */
    const after = await read(a, co, op.operationId);
    expect(after.body.requirements.machineRequirements).toHaveLength(2);
    expect(after.body.operation.name).toBe("Side seam (twin)");
  });
});

/* ══ 6. THE SHAPER ON ITS OWN ═════════════════════════════════════════════ */

describe("the requirement shaper, without a server", () => {
  test("it normalises codes, numbers the sequence and mints missing ids", () => {
    const rows = ieLibrary.shapeRequirementGroup("attachment", [
      { code: " binder-r ", name: "  Right   binder ", quantity: 2, note: " 20 mm " },
    ], new Map());
    expect(rows).toEqual([{
      requirementId: expect.stringMatching(/^areq_[0-9a-f]{18}$/),
      sequence: 1, code: "BINDER-R", name: "Right binder", quantity: 2, note: "20 mm",
    }]);
  });

  test("the no-op comparison is by persisted value, not by object identity", () => {
    const a = [{ requirementId: "mreq_1", sequence: 1, machineType: "SNLS", quantity: 1 }];
    const b = [{ requirementId: "mreq_1", sequence: 1, machineType: "SNLS", quantity: 1 }];
    expect(ieLibrary.sameRequirementRows(a, b)).toBe(true);
    expect(ieLibrary.sameRequirementRows(a, [{ ...b[0], quantity: 2 }])).toBe(false);
    expect(ieLibrary.sameRequirementRows(a, [])).toBe(false);
  });

  test("it publishes counts of what is required and nothing about supply", () => {
    const published = ieLibrary.publishRequirements({
      requirements: {
        configured: true,
        machine: [{ requirementId: "m", sequence: 1, machineType: "SNLS", quantity: 2 }],
        attachment: [],
        labour: [
          { requirementId: "l1", sequence: 1, workerType: "OPERATOR", quantity: 1 },
          { requirementId: "l2", sequence: 2, workerType: "HELPER", quantity: 3 },
        ],
      },
    });
    expect(published.totals).toEqual({ machineTypes: 1, machines: 2, attachments: 0, operators: 1, helpers: 3 });
    expect(published.allocates).toBe(false);
    expect(Object.keys(published)).not.toContain("available");
    expect(Object.keys(published)).not.toContain("capacity");
  });
});
