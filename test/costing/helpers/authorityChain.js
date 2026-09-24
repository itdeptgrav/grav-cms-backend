// test/costing/helpers/authorityChain.js
//
// THE FOUR APPROVALS A COSTING NOW NEEDS, PERFORMED RATHER THAN STAMPED.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// Central Costing reads no R&D value until Industrial Engineering has confirmed
// the exact revision it belongs to. Every fixture in `test/costing` was written
// before that was true: they stamped `techSheet.status = "approved"` and costed
// the measured sample consumption directly.
//
// Retiring those paths means the fixtures have to build the real chain:
//
//   1. Merchandising approves the BOM — which materials.
//   2. R&D submits and has approved a technical revision — the specification,
//      consumption and allowance, frozen.
//   3. IE opens an engineering file from that exact revision, authors a
//      bulletin, has a method study approved for every row, SUBMITS the
//      version and has somebody ELSE approve it.
//   4. Costing binds the result.
//
// ── PERFORMED, NOT ASSERTED ─────────────────────────────────────────────────
// Step 3 runs through the real IE routes — the allowance policy is published,
// the operations are created in the company library, the bulletin is PATCHed,
// each method study is opened, filled, submitted and approved by a second
// person, and the version is submitted and approved by a third. Inserting an
// already-APPROVED `IeBulletinVersion` would produce a document the workflow
// cannot actually reach, and a fixture that cannot happen proves nothing about
// a rule that has to hold when it does.
//
// The one thing written directly is R&D's frozen revision, because `SampleStyle`
// has no route that freezes one — the sampling app writes it. It is written in
// the shape the real writer produces, and its identity fields are what IE then
// confirms.
"use strict";

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../../models/Employee");
const DeptUser = require("../../../models/Access/DeptUser");
const DepartmentRole = require("../../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SampleStyle = require("../../../models/CMS_Models/Sales/SampleStyle");
const IeStyleFile = require("../../../models/CMS_Models/IndustrialEngineering/IeStyleFile");
/* The one function R&D submits a revision through. The fixture freezes what
   production freezes, or it is describing a different system. */
const technicalRecord = require("../../../services/centralCosting/technicalRecord.service");

let seq = 0;
let server = null;
let base = "";

/** The IE app, started once for the whole file that uses this helper. */
async function ieApp() {
  if (server) return base;
  const app = express();
  app.use(express.json());
  app.use("/api/cms/ie", require("../../../routes/CMS_Routes/IndustrialEngineering/ieRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/ie`;
  return base;
}

/** Shut it down. A suite using this helper calls it in `afterAll`. */
async function stop() {
  if (!server) return;
  await new Promise((r) => server.close(r));
  server = null;
  base = "";
}

const call = async (path, { method = "GET", body, token, company } = {}) => {
  const root = await ieApp();
  const res = await fetch(`${root}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text || "null"); } catch { parsed = { nonJson: text.slice(0, 200) }; }
  return { status: res.status, body: parsed };
};

/** An IE person in one company, with one role. */
async function iePerson(companyId, role) {
  const n = ++seq;
  const email = `ac-${role}-${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "A", lastName: `C${n}`, email, biometricId: `AC${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  await SpCompanyMembership.create({
    companyId, email, employeeRef: emp._id, personName: "A",
  });
  await DepartmentRole.create({
    departmentSlug: "ie", email, name: "User", role, isActive: true,
    departmentId: new mongoose.Types.ObjectId(),
  });
  return {
    email,
    token: jwt.sign(
      { id: String(emp._id), email, name: `IE ${role} ${n}`, role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "30m" },
    ),
  };
}

/* One published allowance policy per company, so a standard time has a basis. */
const policyByCompany = new Map();
async function allowancePolicy(companyId, maker, checker) {
  const key = String(companyId);
  if (policyByCompany.has(key)) return policyByCompany.get(key);
  const drafted = await call("/allowance-policies", {
    method: "POST", token: maker.token, company: companyId,
    body: { name: `Fixture allowance ${++seq}`, effectiveFrom: "2026-01-01", categories: [] },
  });
  const policyId = drafted.body?.policy?.policyId;
  if (policyId) {
    await call(`/allowance-policies/${policyId}/publish`, {
      method: "POST", token: checker.token, company: companyId,
      body: { expectedRevision: 1 },
    });
  }
  policyByCompany.set(key, policyId || null);
  return policyByCompany.get(key);
}

/**
 * R&D's frozen approved technical revision.
 *
 * Written directly because `SampleStyle` has no route that freezes one — the
 * sampling app does — and in the shape that writer produces. `revision`,
 * `submittedAt` and `decidedAt` are the identity IE then confirms, and are what
 * make a later re-approval a DIFFERENT decision.
 */
function frozenRevision({ revision = 1, materials = [], operations = [], services = [] } = {}) {
  /* ── THE SNAPSHOT IS THE REAL FUNCTION'S OUTPUT, NOT A HAND-BUILT SHAPE ──
     This used to assemble the snapshot itself, and invented three keys —
     `packaging`, `services` and `shipment` — that `technicalRecord.snapshotOf`
     has never produced. Central Costing was bound to those keys, so it read
     packaging, outside services and shipment for FIXTURE styles and `null` for
     every style whose revision came through R&D's own routes. The fixture is
     not allowed to describe a world production cannot produce, so the one
     function R&D submits through builds this too, and a key that is missing
     here is missing in production. */
  const snapshot = technicalRecord.snapshotOf(
    { revision, materials, operations, requirements: [] },
    null,
    /* Outside services and development/tooling, from the record that owns
       them — which is what `snapshotOf` now freezes into `requirements`. */
    { serviceRequirements: services },
  );
  return {
    revision,
    outcome: "approved",
    submittedAt: new Date("2026-07-01"),
    submittedBy: { name: "R&D Fixture" },
    decidedAt: new Date("2026-07-02"),
    decidedByName: "Sales Fixture",
    snapshot,
  };
}

/**
 * Perform IE's confirmation of a style's approved technical revision.
 *
 * Every step is a real request. Returns `{ fileId, versionId, versionNo }`, or
 * `null` when the style carries no approved revision for IE to confirm — which
 * is a legitimate fixture state and must not be papered over.
 */
async function confirmWithIe(companyId, styleId, { maker = null, checker = null } = {}) {
  const style = await SampleStyle.findById(styleId).select("techSheet").lean();
  const revisions = style?.techSheet?.technicalRevisions || [];
  const approved = revisions.filter((r) => r.outcome === "approved");
  if (!approved.length) return null;

  const m = maker || await iePerson(companyId, "editor");
  const c = checker || await iePerson(companyId, "approver");
  await allowancePolicy(companyId, m, c);

  /* 1 — open the engineering file FROM THE STYLE, the pre-order door. */
  const opened = await call(`/styles/${styleId}/engineering-file`, {
    method: "POST", token: m.token, company: companyId, body: {},
  });
  if (![200, 201].includes(opened.status)) {
    throw new Error(`authorityChain: could not open the engineering file (${opened.status}) `
      + `${JSON.stringify(opened.body?.error || opened.body)}`);
  }
  const file = opened.body.file;

  /* 2 — one library operation per operation the revision carried, and a
     bulletin row for each. A revision with no route still gets one row: a
     garment is made by doing something, and a bulletin with no rows cannot be
     submitted. */
  const snapshot = approved.reduce((best, r) => (r.revision > (best?.revision ?? -1) ? r : best), null).snapshot || {};
  /* ── THE ROUTE IS THE REVISION'S, NEVER INVENTED ───────────────────────
     An earlier version of this helper fabricated one row when a revision
     carried no operations, because a bulletin with no rows cannot be
     submitted. That put an operation into fixtures that deliberately had none
     — and, having no salary basis, it blocked every costing in those suites
     with a Production gap about a route nobody had authored.

     A fixture that wants no route gets no confirmation, which is the honest
     answer: IE cannot approve an empty bulletin, so a style with no
     operations is not costable. See the architecture note in the report. */
  const wanted = snapshot.operations || [];
  if (!wanted.length) return null;

  const rows = [];
  for (const [i, op] of wanted.entries()) {
    const created = await call("/operations/library", {
      method: "POST", token: m.token, company: companyId,
      body: {
        /* ── THE CODE IS THE IDENTITY, AND IS CARRIED VERBATIM ────────
           This appended a sequence number, so the library operation was
           `OP-SB-1-4` where the revision said `OP-SB-1`. `costOperations`
           resolves the salary basis from the registered Operation master BY
           CODE, so the rename severed the route from Production's rate and
           every costing blocked on "not mapped to a salary group".
           The library is company-scoped, so there is nothing to disambiguate. */
        code: op.operationCode || `OP-${++seq}`,
        name: op.name || op.operationCode || `Operation ${i + 1}`,
        machineType: op.machineType || "SNLS",
      },
    });
    const minutes = (Number(op.minutes) || 0) + (Number(op.seconds) || 0) / 60;
    rows.push({
      ieOperationId: created.body.operation.operationId,
      proposedSamMinutes: minutes || 1.5,
    });
  }

  const patched = await call(`/engineering-files/${file.fileId}/bulletin`, {
    method: "PATCH", token: m.token, company: companyId,
    body: { expectedRevision: file.revision, rows },
  });
  if (patched.status !== 200) {
    throw new Error(`authorityChain: could not author the bulletin (${patched.status}) `
      + `${JSON.stringify(patched.body?.error || patched.body)}`);
  }

  /* 3 — an APPROVED method study for every row, by two different people. */
  for (const [i, row] of patched.body.file.bulletin.rows.entries()) {
    const study = await call(`/engineering-files/${file.fileId}/bulletin/${row.rowId}/method-studies`, {
      method: "POST", token: m.token, company: companyId, body: {},
    });
    const studyId = study.body.study.studyId;
    const filled = await call(`/method-studies/${studyId}`, {
      method: "PATCH", token: m.token, company: companyId,
      body: {
        expectedRevision: 1, studiedAt: "2026-09-08T04:30:00.000Z", location: "Line 1",
        methodNote: "Fixture method", ratingPercent: 100,
        observations: [{ durationSeconds: 60 }],
      },
    });
    const submitted = await call(`/method-studies/${studyId}/submit`, {
      method: "POST", token: m.token, company: companyId,
      body: {
        expectedRevision: filled.body.study.revision,
        manualStandardTimeMinutes: rows[i].proposedSamMinutes,
        overrideReason: "Fixed standard agreed for this fixture.",
      },
    });
    const okStudy = await call(`/method-studies/${studyId}/approve`, {
      method: "POST", token: c.token, company: companyId,
      body: { expectedRevision: submitted.body.study.revision },
    });
    if (okStudy.status !== 200) {
      throw new Error(`authorityChain: a method study was not approved (${okStudy.status}) `
        + `${JSON.stringify(okStudy.body?.error || okStudy.body)}`);
    }
  }

  /* 4 — submit, and have somebody ELSE approve. Maker-checker is the point. */
  const fresh = await call(`/styles/${styleId}/engineering-file`, { token: m.token, company: companyId });
  const submitted = await call(`/engineering-files/${file.fileId}/bulletin-versions`, {
    method: "POST", token: m.token, company: companyId,
    body: { expectedRevision: fresh.body.file.revision },
  });
  if (submitted.status !== 201) {
    throw new Error(`authorityChain: the bulletin was not submitted (${submitted.status}) `
      + `${JSON.stringify(submitted.body?.error || submitted.body)}`);
  }
  const version = submitted.body.version;

  const approvedVersion = await call(`/bulletin-versions/${version.bulletinVersionId}/approve`, {
    method: "POST", token: c.token, company: companyId,
    body: { expectedRevision: version.revision },
  });
  if (approvedVersion.status !== 200) {
    throw new Error(`authorityChain: the bulletin version was not approved (${approvedVersion.status}) `
      + `${JSON.stringify(approvedVersion.body?.error || approvedVersion.body)}`);
  }

  const storedFile = await IeStyleFile.findById(file.fileId).select("currentApprovedBulletinVersionId currentApprovedVersionNo").lean();
  return {
    fileId: String(file.fileId),
    versionId: String(storedFile.currentApprovedBulletinVersionId),
    versionNo: storedFile.currentApprovedVersionNo,
    maker: m,
    checker: c,
  };
}

/** Forget the per-company caches — a suite clearing collections calls this. */
function reset() {
  policyByCompany.clear();
}

module.exports = { confirmWithIe, frozenRevision, iePerson, stop, reset, call };
