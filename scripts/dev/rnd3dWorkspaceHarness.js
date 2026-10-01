// scripts/dev/rnd3dWorkspaceHarness.js
//
// THE R&D 3D WORKSPACE, RUNNING FOR REAL, AGAINST NOTHING REAL.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// The workspace cannot be accepted from unit tests. Somebody has to open it,
// turn a garment, drop a marker on a sleeve, reload the page and see the marker
// come back to the same stitch. That needs the actual routes, an actual
// database and an actual file store.
//
// It must not need the REAL ones. This repository's `.env` holds live
// credentials: a Mongo Atlas URI, a Firebase service account and a Google
// service account that writes into the company's own Drive. Booting `server.js`
// with those present would read production Firestore on the way up — its
// start-up repair block scans the whole `cowork_tasks` collection — and an
// upload would land in the company's real Drive folder. Neither is acceptable
// for a development walk-through.
//
// So this harness keeps everything that decides BEHAVIOUR and replaces
// everything that decides WHERE:
//
//   · the routers, services, models, middleware and auth are the real ones,
//     required from source and mounted exactly as `server.js` mounts them;
//   · the database is an ephemeral in-memory replica set that dies with the
//     process;
//   · the file store is a folder on this machine, standing in for Drive behind
//     the same three functions the service exports.
//
// ── AND THE GUARD IS NOT A COMMENT ──────────────────────────────────────────
// Every credential that could reach a live system is deleted from `process.env`
// before a single application module is required, and the Mongo URI is asserted
// to be local afterwards. A mistake here does not produce a warning, it
// produces an exit.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

/* ═══ 1. DISARM THE ENVIRONMENT, BEFORE ANYTHING IS REQUIRED ═══════════════ */

/* The real `.env` is read for the few values that decide behaviour rather than
   destination — chiefly JWT_SECRET, so a token this harness mints is the same
   shape `routes/login.js` would mint. */
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const LIVE_KEYS = [
  "MONGODB_URI", "GOOGLE_SERVICE_ACCOUNT_KEY", "GOOGLE_DRIVE_FOLDER_ID",
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN",
  "FIREBASE_SERVICE_ACCOUNT", "FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY", "FIREBASE_DATABASE_URL", "FIREBASE_STORAGE_BUCKET",
  "BREVO_API_KEY", "CLOUDINARY_URL", "TEAMOFFICE_USERNAME", "TEAMOFFICE_PASSWORD",
  "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "GEMINI_API_KEY",
];
for (const key of LIVE_KEYS) delete process.env[key];

process.env.NODE_ENV = "development";
process.env.ENABLE_EMAILS = "false";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || "grav_clothing_secret_key";

const PORT = Number(process.env.RND3D_PORT || 5055);
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), "rnd3d-store-"));

/* ═══ 2. THE FILE STORE, STANDING IN FOR DRIVE ═════════════════════════════
 * Injected into the module cache before anything requires it, so the real
 * service file is never loaded and its credential check never runs. The three
 * functions are the whole surface the application uses.
 */
const drivePath = require.resolve("../../services/companyDrive.service");
require.cache[drivePath] = {
  id: drivePath,
  filename: drivePath,
  loaded: true,
  exports: {
    async uploadCompanyFile(buffer, { fileName, mimeType } = {}) {
      const id = `local-${crypto.randomBytes(8).toString("hex")}`;
      fs.writeFileSync(path.join(STORE, id), buffer);
      fs.writeFileSync(path.join(STORE, `${id}.json`), JSON.stringify({ fileName, mimeType }));
      return { id, name: fileName };
    },
    async streamCompanyFile(id) {
      const file = path.join(STORE, String(id));
      if (!fs.existsSync(file)) throw new Error("not found");
      const meta = JSON.parse(fs.readFileSync(`${file}.json`, "utf8"));
      return {
        stream: fs.createReadStream(file),
        meta: { mimeType: meta.mimeType, size: fs.statSync(file).size },
      };
    },
    async deleteCompanyFile(id) {
      for (const f of [id, `${id}.json`]) {
        const p = path.join(STORE, f);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
      return true;
    },
  },
};

/* ═══ 3. THE DATABASE, EPHEMERAL ══════════════════════════════════════════ */

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const GLB = process.argv[2]
  || path.join(os.homedir(), "grav-cms", "public", "__dev__", "sweater_pack.glb");

async function main() {
  const rs = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  const uri = rs.getUri();

  /* Not a comment, a gate. */
  if (/mongodb\+srv|\.mongodb\.net|atlas/i.test(uri)) {
    console.error("Refusing to start: the harness resolved a non-local database.");
    process.exit(1);
  }
  process.env.MONGODB_URI = uri;
  await mongoose.connect(uri, { dbName: "rnd3d_dev" });

  /* ═══ 4. THE REAL ROUTERS ═══════════════════════════════════════════════ */

  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(cookieParser());
  app.use(express.json({ limit: "50mb" }));

  /* Mount order mirrors server.js: `deptAuth` first, so its `/verify` shadows
     the legacy one exactly as it does in production. The portal's own guard
     calls that route before it will render any department page, so getting
     this wrong means a walk-through that never reaches the workspace. */
  app.use("/api/auth", require("../../routes/auth/deptAuth"));
  app.use("/api/auth", require("../../routes/login"));
  app.use("/api/cms/crm/sample-styles", require("../../routes/CMS_Routes/Sales/sampleStyles"));
  app.use("/api/cms/rnd", require("../../routes/CMS_Routes/RnD/technicalRecordRoute"));
  app.use("/api/cms/rnd", require("../../routes/CMS_Routes/RnD/garmentModelRoute"));

  /* Anything the workspace does not need answers honestly rather than hanging
     a screen on a request that will never resolve. */
  app.use("/api", (req, res) => res.status(501).json({
    success: false,
    message: `This development harness does not mount ${req.method} ${req.originalUrl}.`,
  }));

  const server = app.listen(PORT);

  /* ═══ 5. THE WORLD ═════════════════════════════════════════════════════ */

  const Employee = require("../../models/Employee");
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  const DeptUser = require("../../models/Access/DeptUser");
  const DepartmentRole = require("../../models/Access/DepartmentRole");
  const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
  const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
  const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
  const Account = require("../../models/CMS_Models/Sales/Account");
  const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");

  const company = await Acc_Company.create({
    companyName: "Grav Clothing", booksFromDate: new Date("2026-04-01"),
  });
  const account = await Account.create({ companyName: "Northwind Apparel", status: "active" });
  const journey = await SalesJourney.create({
    journeyId: "SJ-2026-0041", companyId: company._id, name: "Northwind AW26",
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "Sales",
  });
  const enquiry = await Enquiry.create({
    enquiryId: "ENQ-2026-0088", journeyId: journey._id, accountId: account._id,
    companyId: company._id, title: "Northwind AW26", isActive: true,
    products: [{ product: "Rib-knit Sweater", quantity: 600 }],
  });
  const style = await SampleStyle.create({
    sampleStyleId: "SS-2026-0412", styleCode: "SC-NW-04", productName: "Rib-knit Sweater",
    journeyId: journey._id, enquiryId: enquiry._id, accountId: account._id,
    stage: "rnd", techSheet: { status: "in_progress" },
  });

  /* The department the portal switches into. `/api/auth/verify` re-resolves it
     from the database on every request and refuses a session whose department
     it cannot find, so this is not decoration. */
  const AccessDepartment = require("../../models/Access/AccessDepartment");
  const accessDept = await AccessDepartment.create({
    key: "research-development",
    slug: "research-development",
    name: "Research & Development",
    dashboardPath: "/research-development/dashboard",
    legacyRole: "rnd",
    legacyUserType: "rnd",
    isActive: true,
  });

  /** One person, one department grant, one token the real middleware accepts. */
  async function person(name, email, grants) {
    const emp = await Employee.create({
      firstName: name.split(" ")[0], lastName: name.split(" ").slice(1).join(" ") || "User",
      email, biometricId: `GR${Math.floor(Math.random() * 9000) + 1000}`,
      isActive: true, gender: "Other", department: "Research & Development",
      accessDepartmentId: accessDept._id,
    });
    await DeptUser.create({
      name, email, passwordHash: "x", isActive: true,
      departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
    });
    await SpCompanyMembership.create({
      companyId: company._id, email, employeeRef: emp._id, personName: name,
    });
    for (const [departmentSlug, role] of Object.entries(grants)) {
      await DepartmentRole.create({
        departmentSlug, email, name, role, isActive: true,
        departmentId: new mongoose.Types.ObjectId(),
      });
    }
    return {
      name, email, id: String(emp._id),
      /* The shape `routes/auth/deptAuth.js` mints for an employee session —
         v2, subject "employee", carrying the department it was opened for.
         Minted here rather than by posting to /login, because a password
         round-trip would prove nothing this walk-through is about. */
      token: jwt.sign(
        {
          v: 2,
          subject: "employee",
          id: String(emp._id),
          deptId: String(accessDept._id),
          deptSlug: accessDept.slug,
          role: accessDept.legacyRole,
          userType: accessDept.legacyUserType,
          employeeId: emp.biometricId,
          name,
          email,
          isAdmin: false,
          tv: 0,
        },
        process.env.JWT_SECRET, { expiresIn: "12h" },
      ),
    };
  }

  const editor = await person("Anita Rao", "anita.rao@grav.test", { "research-development": "editor", sales: "viewer" });
  const approver = await person("Umung Arora", "umung.arora@grav.test", { "research-development": "approver", sales: "approver" });
  const viewer = await person("Priya Nair", "priya.nair@grav.test", { "research-development": "viewer" });

  /* ═══ 6. A PUBLICATION, MADE BY THE REAL ROUTE ═════════════════════════
     Uploaded rather than inserted: the point of the walk-through is that the
     thing on screen arrived the way a real one would — parsed, hashed,
     limit-checked and warned about by the same code a CLO export will hit. */
  if (!fs.existsSync(GLB)) {
    console.error(`No model at ${GLB}. Pass one as the first argument.`);
    process.exit(1);
  }
  const glb = fs.readFileSync(GLB);
  const form = new FormData();
  form.append("webModel", new Blob([glb], { type: "model/gltf-binary" }), path.basename(GLB));
  form.append("cloVersion", "CLO 7.3.154");
  form.append("unit", "cm");
  form.append("unitScale", "100");
  form.append("upAxis", "Y");
  form.append("handedness", "right");
  form.append("exportedAt", "2026-09-28T09:12:00.000Z");
  form.append("title", "Rib-knit sweater AW26 — first web model");

  const published = await fetch(
    `http://127.0.0.1:${PORT}/api/cms/rnd/garment-models/styles/${style._id}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${editor.token}`, "X-Costing-Company": String(company._id) },
      body: form,
    },
  ).then((r) => r.json());

  const out = {
    api: `http://localhost:${PORT}`,
    store: STORE,
    database: "in-memory replica set (dies with this process)",
    companyId: String(company._id),
    styleId: String(style._id),
    styleCode: style.styleCode,
    workspaceUrl: `http://localhost:3001/research-development/styles/${style._id}/workspace-3d`,
    publication: published?.publication
      ? {
        id: published.publication.id,
        modelName: published.publication.modelName,
        state: published.publication.state,
        meshes: published.publication.stats.meshes,
        triangles: published.publication.stats.triangles,
        anchorable: published.publication.anchorable,
        warnings: (published.warnings || []).map((w) => w.code),
      }
      : published,
    people: {
      editor: { email: editor.email, token: editor.token },
      approver: { email: approver.email, token: approver.token },
      viewer: { email: viewer.email, token: viewer.token },
    },
  };
  fs.writeFileSync(path.join(STORE, "session.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.log(`\nREADY on ${out.api} — session also written to ${STORE}/session.json`);

  const shutdown = async () => {
    server.close();
    await mongoose.disconnect();
    await rs.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Harness failed:", err);
  process.exit(1);
});
