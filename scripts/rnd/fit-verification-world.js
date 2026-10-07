// scripts/rnd/fit-verification-world.js
//
// A THROWAWAY WORLD FOR VERIFYING PATTERN & FIT IN A BROWSER.
//
// ── WHY THIS EXISTS AS A MAINTAINED SCRIPT ──────────────────────────────────
// Pattern & Fit needs two collections the shared Atlas dev cluster has no room
// for: it sits at its 500-collection ceiling, and freeing space there is a
// decision about other people's data. So verification runs against a disposable
// MongoDB this script boots itself, seeded with exactly one company, one style,
// one login and one pattern revision imported from the genuine CLO AAMA export in
// `test/fixtures/rnd/`.
//
// **It never touches Atlas.** It never reads `MONGODB_URI` and it drops everything
// when it stops, because a `mongodb-memory-server` instance exists only for the
// life of this process.
//
// ── RUNNING IT ──────────────────────────────────────────────────────────────
//   node scripts/rnd/fit-verification-world.js
//
// It prints the URI, the style id, the workspace URL and the login, then stays up
// until interrupted. Start the backend against the URI it prints:
//
//   MONGODB_URI=<printed uri> npm run dev
//
// The login it seeds is a verification account with a password printed to the
// terminal. It is not a production credential and the database it lives in
// disappears when this process does.
"use strict";

require("dotenv/config");

const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const fs = require("fs");

const PORT = 27018;
const DB = "grav_fit_verify";

(async () => {
  const mongod = await MongoMemoryServer.create({
    instance: { port: PORT, dbName: DB },
  });
  const uri = mongod.getUri(DB);
  console.log("URI", uri);

  await mongoose.connect(uri, { dbName: DB });

  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  const Account = require("../../models/CMS_Models/Sales/Account");
  const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
  const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
  const CEODepartment = require("../../models/CEODepartment");
  const { inspectDxf } = require("../../utils/dxfInspect");
  const bundle = require("../../services/rnd/patternBundle.service");
  const patterns = require("../../services/rnd/patternRevision.service");

  const company = await Acc_Company.create({
    companyName: "GRAV Clothing (verification)",
    booksFromDate: new Date("2026-04-01"),
    isPrimary: true,
  });

  /* ── THE PASSWORD IS PASSED IN PLAIN, AND THE MODEL HASHES IT ──────────
     `CEODepartment` carries a pre-save hook that bcrypts `password`. Hashing it
     here first means it is hashed twice, and the login then fails with "invalid
     email or password" against a user that exists with the right address. */
  const PASSWORD = "FitVerify!2026";
  const ceo = await CEODepartment.create({
    name: "Fit Verification",
    email: "fit@grav.test",
    password: PASSWORD,
    employeeId: "E000",
    role: "ceo",
    department: "CEO",
    isActive: true,
  });

  /* ── THE CANONICAL IDENTITY ────────────────────────────────────────────
     A `DeptUser` is what the sign-in actually resolves; the department row above
     is the legacy record it is the migration OF, and a legacy row on its own is
     refused as LEGACY_ACCOUNT_NOT_MIGRATED however correct its password is. The
     department it belongs to has to be active too, or the refusal is
     HOME_APPLICATION_INACTIVE. */
  const AccessDepartment = require("../../models/Access/AccessDepartment");
  const DeptUser = require("../../models/Access/DeptUser");
  const department = await AccessDepartment.findOneAndUpdate(
    { key: "ceo" },
    {
      $setOnInsert: {
        key: "ceo", slug: "ceo", name: "CEO", dashboardPath: "/ceo/dashboard",
        isActive: true, isSystem: true, legacyModel: "CEODepartment", legacyRole: "ceo",
        legacyUserType: "ceo",
      },
    },
    { upsert: true, new: true },
  );
  await DeptUser.create({
    _id: ceo._id,
    email: ceo.email,
    passwordHash: await require("bcryptjs").hash(PASSWORD, 10),
    name: ceo.name,
    employeeId: ceo.employeeId,
    departmentId: department._id,
    isAdmin: true,
    isActive: true,
    legacyModel: "CEODepartment",
    legacyRole: "ceo",
  });

  /* ── THE R&D GRANT ─────────────────────────────────────────────────────
     Opening a garment model needs an active Research & Development role, and
     `isAdmin` is deliberately not a rung on that ladder — an administrator is not
     automatically an R&D user. The grant is made the ordinary way, as a
     `DepartmentRole` row against this person's address, which is exactly what the
     access screen writes. Nothing about the guard is bypassed or weakened. */
  const DepartmentRole = require("../../models/Access/DepartmentRole");
  await DepartmentRole.create({
    departmentSlug: "research-development",
    email: ceo.email,
    name: ceo.name,
    role: "owner",
    isActive: true,
  });

  const account = await Account.create({ companyName: "Buyer", status: "active" });
  const journey = await SalesJourney.create({
    journeyId: "SJ-FIT-1", companyId: company._id, name: "Fit verification",
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const style = await SampleStyle.create({
    sampleStyleId: "SS-FIT-1", styleCode: "FIT-TEE-01", productName: "CLO T-shirt",
    journeyId: journey._id, accountId: account._id, stage: "rnd",
    techSheet: { status: "pending" },
  });

  /* The genuine CLO AAMA export, declared in inches. */
  const buf = fs.readFileSync(require("path").join(__dirname, "..", "..", "test", "fixtures", "rnd", "clo-tshirt-aama.dxf"));
  const read = inspectDxf(buf);
  const patternSet = bundle.ingestPatternSet(read, {
    file: { originalname: "clo-tshirt-aama.dxf", size: buf.length, buffer: buf },
  });
  const out = await patterns.importRevision(
    { companyId: company._id },
    {
      styleId: style._id,
      patternSet,
      sourceDxf: { driveFileId: "", name: "clo-tshirt-aama.dxf", sha256: "", bytes: buf.length },
      name: "CLO T-shirt AAMA DXF",
      actor: { id: String(ceo._id), name: ceo.name, email: ceo.email },
    },
  );

  /* ── AND A SECOND STYLE, FULLY MAPPED ──────────────────────────────────
     The CLO export above is the real input and is what the readiness half is
     verified against. Mapping its 121-point outlines correctly is a
     pattern-maker's judgement — which runs are the armhole, which end is the
     underarm — and guessing it would produce a believable garment nobody
     designed, which is the one thing this whole contract exists to prevent.

     So the drape half is verified on a four-piece tee whose anchors can be
     stated exactly: the same shape the automated suites drape, imported here so
     the browser flow has something correctly mapped to run on. */
  const tee = require("../../test/rnd/fixtures/renderableTee");
  const style2 = await SampleStyle.create({
    sampleStyleId: "SS-FIT-2", styleCode: "FIT-TEE-02", productName: "Mapped tee",
    journeyId: journey._id, accountId: account._id, stage: "rnd",
    techSheet: { status: "pending" },
  });
  const mapped = await patterns.importRevision(
    { companyId: company._id },
    {
      styleId: style2._id,
      patternSet: tee.patternSet(),
      sourceDxf: { driveFileId: "", name: "mapped-tee.dxf", sha256: "", bytes: 0 },
      name: "A tee with every seam mapped",
      actor: { id: String(ceo._id), name: ceo.name, email: ceo.email },
    },
  );
  await patterns.setSimulationInputs(
    { companyId: company._id },
    {
      revisionId: mapped.revision.id,
      inputs: tee.simulationInputs(),
      actor: { id: String(ceo._id), name: ceo.name, email: ceo.email },
    },
  );

  console.log(JSON.stringify({
    ready: true,
    mappedStyleId: String(style2._id),
    mappedUrl: `http://localhost:3001/research-development/styles/${style2._id}/workspace-3d`,
    uri,
    companyId: String(company._id),
    styleId: String(style._id),
    revisionId: out.revision.id,
    revisionRef: out.revision.revisionRef,
    unit: out.revision.unit,
    pieces: out.revision.pieceCount,
    login: { email: ceo.email, password: PASSWORD },
    url: `http://localhost:3001/research-development/styles/${style._id}/workspace-3d`,
  }, null, 1));

  await mongoose.disconnect();
  /* Hold the server open for the browser run. */
  process.on("SIGINT", async () => { await mongod.stop(); process.exit(0); });
  setInterval(() => {}, 1 << 30);
})().catch((e) => { console.error("FAILED:", e.message, e.stack); process.exit(1); });
