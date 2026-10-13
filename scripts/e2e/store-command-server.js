#!/usr/bin/env node
"use strict";
/**
 * scripts/e2e/store-command-server.js — a real backend, a throwaway database.
 *
 * ── WHAT THIS IS FOR ──────────────────────────────────────────────────────
 * Proving the command palette end to end means signing in through the real
 * login door, with a real session cookie, against real permission middleware,
 * and asking the real endpoint for real records. Everything below the browser
 * is therefore the actual code: `routes/auth/deptAuth`, `EmployeeAuthMiddleware`,
 * `resolveAppAccess`, `tenantContext.resolveForActor`, the tool registry.
 *
 * What is NOT real is the DATABASE and the server's own wiring. It runs on an
 * in-memory replica set seeded here, and mounts only the two routers the
 * journey needs — because booting `server.js` would connect to Atlas and
 * Firestore and run its boot-time repair pass over live data, which no test
 * is allowed to do.
 *
 * Two companies and three people are seeded, so the journey can prove what
 * somebody must NOT see as well as what they must:
 *
 *   store@e2e.test     Store department grant, company A
 *   other@e2e.test     Store department grant, company B
 *   nostore@e2e.test   a signed-in person with no Store grant at all
 *
 *   node scripts/e2e/store-command-server.js --port 5099
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "e2e-only-secret-not-for-any-deployment";

const express = require("express");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");

const PASSWORD = "E2e-Store-Pass!7731";
const PORT = Number((process.argv.find((a) => a.startsWith("--port=")) || "").split("=")[1])
  || Number(process.argv[process.argv.indexOf("--port") + 1])
  || 5099;
const ORIGINS = [
  "http://localhost:3001", "http://localhost:3005", "http://localhost:3000",
  "http://127.0.0.1:3001", "http://127.0.0.1:3005",
];

const oid = () => new mongoose.Types.ObjectId();

async function seed() {
  const db = mongoose.connection;
  const { seedStore, oid: fxOid } = require("../../test/support/storeCommandFixtures");

  /* ── COMPANY A, AND THE STORE IT HOLDS ──────────────────────────────── */
  const store = await seedStore();
  const companyA = store.companyId;
  await db.collection("acc_companies").insertOne({
    _id: companyA, name: "GRAV CLOTHING PVT LTD", isPrimary: true, isActive: true,
    createdAt: new Date(), updatedAt: new Date(),
  });

  /* A second material whose name contains the first's, so the journey can
     ask something genuinely ambiguous and be offered a choice. */
  await db.collection("rawitems").insertOne({
    _id: fxOid(), companyId: companyA, name: "Sodium Hydroxide Flake",
    sku: "SODIUM-FLAKE", quantity: 7, unit: "Kg", variants: [], deletedAt: null,
    createdAt: new Date(), updatedAt: new Date(),
  });

  /* ── COMPANY B, WITH A MATERIAL OF ITS OWN ──────────────────────────── */
  const companyB = fxOid();
  await db.collection("acc_companies").insertOne({
    _id: companyB, name: "Other Company Ltd", isActive: true,
    createdAt: new Date(), updatedAt: new Date(),
  });
  await db.collection("rawitems").insertOne({
    _id: fxOid(), companyId: companyB, name: "Beta Only Fabric", sku: "BETA-ONLY-1",
    quantity: 55, unit: "Mtr", variants: [], deletedAt: null,
    createdAt: new Date(), updatedAt: new Date(),
  });

  /* ── THE DEPARTMENT, AND THE PEOPLE ─────────────────────────────────── */
  const departmentId = oid();
  await db.collection("access_departments").insertMany([
    {
      _id: departmentId, slug: "store", name: "Store & Purchase",
      isActive: true, createdAt: new Date(), updatedAt: new Date(),
    },
    {
      _id: oid(), slug: "hr", name: "Human Resources",
      isActive: true, createdAt: new Date(), updatedAt: new Date(),
    },
    {
      _id: oid(), slug: "accountant", name: "Accounts",
      isActive: true, createdAt: new Date(), updatedAt: new Date(),
    },
  ]);

  const hash = await bcrypt.hash(PASSWORD, 10);
  const people = [
    { email: "store@e2e.test", name: "Store Keeper", company: companyA, grant: true },
    { email: "other@e2e.test", name: "Other Keeper", company: companyB, grant: true },
    { email: "nostore@e2e.test", name: "No Store", company: companyA, grant: false },
    /* Signed in, with an application — just not this one. The person who
       proves the endpoint's own refusal, rather than the login door's. */
    { email: "hronly@e2e.test", name: "HR Only", company: companyA, grant: false, other: "hr" },
    /* HR with the narrowest role: Cmd/Ctrl K must not offer them a create
       form, nor read a family their role does not cover (payroll). */
    { email: "hrviewer@e2e.test", name: "HR Viewer", company: companyA, grant: false, other: "hr", role: "viewer" },
    /* A CMS person in the Accounts department, so the books' shell (its
       route guard and department guard) admits the browser; the books
       themselves are then read as books@e2e.test, the accounting session. */
    { email: "accounts@e2e.test", name: "Accounts E2E", company: companyA, grant: false, other: "accountant" },
    /* Store AND HR: the person Cmd/Ctrl K's Apps results are proven with —
       HR is offered and opens; Accounts, which they do not hold, is not. */
    { email: "twoapps@e2e.test", name: "Two Apps", company: companyA, grant: true, also: "hr" },
  ];
  for (const person of people) {
    const id = oid();
    await db.collection("dept_users").insertOne({
      /* `passwordHash` is the only field that can authenticate — the model
         says so, and a seed that wrote `password` instead would be a user
         nobody can sign in as. */
      _id: id, email: person.email, name: person.name, passwordHash: hash,
      departmentId, departmentSlug: "store",
      isActive: true, isAdmin: false, tokenVersion: 0, mustChangePassword: false,
      failedLoginAttempts: 0, createdAt: new Date(), updatedAt: new Date(),
    });
    if (person.grant || person.other) {
      await db.collection("department_roles").insertOne({
        _id: oid(), departmentSlug: person.grant ? "store" : person.other,
        email: person.email, name: person.name,
        role: person.role || "editor", isActive: true, createdAt: new Date(), updatedAt: new Date(),
      });
    }
    if (person.also) {
      await db.collection("department_roles").insertOne({
        _id: oid(), departmentSlug: person.also, email: person.email, name: person.name,
        role: "editor", isActive: true, createdAt: new Date(), updatedAt: new Date(),
      });
    }
    /* Which company each person belongs to. */
    await db.collection("sp_company_memberships").insertOne({
      _id: oid(), companyId: person.company, email: person.email,
      personName: person.name, userId: id, isActive: true,
      createdAt: new Date(), updatedAt: new Date(),
    });
    person.id = id;
  }

  /* ── THE BOOKS ───────────────────────────────────────────────────────
     Two organisations, each owning one company, with deliberately alike
     data (test/support/accountingCommandFixtures.js) — so a search that
     leaked across companies would show the other company's figure. One
     accounting-only person signs in through the books' own login door. */
  const books = await require("../../test/support/accountingCommandFixtures").seedBooks();
  await db.collection("acc_companies").insertMany([
    { _id: books.A, companyName: "GRAV Books A", isActive: true, createdAt: new Date(), updatedAt: new Date() },
    { _id: books.B, companyName: "Other Books B", isActive: true, createdAt: new Date(), updatedAt: new Date() },
  ]);
  const { Acc_Organization, Acc_User } = require("../../models/Accountant_model/Acc_OrgModels");
  const accountant = new Acc_User({
    name: "Books E2E", email: "books@e2e.test", role: "owner", isActive: true, loginMode: "password", tokenVersion: 0,
  });
  const org = await Acc_Organization.create({ name: "GRAV E2E Books", ownerUserId: accountant._id, tallyCompanyIds: [books.A], isActive: true });
  accountant.organizationId = org._id;
  await accountant.setPassword(PASSWORD);
  await accountant.save();
  await Acc_Organization.create({ name: "Somebody Else", ownerUserId: oid(), tallyCompanyIds: [books.B], isActive: true });
  /* The everyday path: a CMS person whose ACCOUNTING role is stored as an
     Acc_User with the same email and no password of its own ("one person,
     one login"). Signing into the CMS, the books upgrade the session through
     /sync-legacy into an organisation token — the real flow. */
  await Acc_User.create({
    name: "Accounts E2E", email: "accounts@e2e.test", role: "viewer", isActive: true,
    loginMode: "none", tokenVersion: 0, organizationId: org._id,
  });

  /* HR's records — two Ravis, somebody who left, and every private value
     planted (test/support/hrCommandFixtures.js). */
  await require("../../test/support/hrCommandFixtures").seedHr();

  return { store, companyA, companyB, people, departmentId, books };
}

function buildApp() {
  const app = express();
  app.use(cors({ origin: ORIGINS, credentials: true }));
  app.use(cookieParser());
  app.use(express.json({ limit: "2mb" }));

  /* The real routers, with their real middleware. */
  app.use("/api/auth", require("../../routes/auth/deptAuth"));
  app.use("/api/ai", require("../../routes/ai/storeCommandSearch"));
  app.use("/api/ai", require("../../routes/ai/commandSearchMisses"));
  /* The books: their own login, their company list, and Cmd/Ctrl K. */
  app.use("/api/accountant/auth", require("../../routes/Accountant_Routes/Acc_auth"));
  app.use("/api/accountant/tally/companies", require("../../routes/Accountant_Routes/Acc_companies"));
  app.use("/api/accountant/command-search", require("../../routes/Accountant_Routes/Acc_commandSearch"));
  /* HR: its own guard on every /api/hr route, exactly as server.js mounts it,
     then Cmd/Ctrl K behind it. */
  app.use("/api/hr", require("../../Middlewear/hrContract")());
  app.use("/api/hr/command-search", require("../../routes/HrRoutes/HrCommandSearch"));

  /* The shell asks for these on load. Answering them keeps the page from
     erroring its way out of rendering the palette; neither grants anything. */
  app.get("/api/access/my-applications", (req, res) => res.json({ success: true, applications: [] }));
  app.use((req, res) => res.status(404).json({ success: false, message: "Not part of the E2E surface." }));
  return app;
}

async function main() {
  const { MongoMemoryReplSet } = require("mongodb-memory-server");
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  process.env.MONGODB_URI = replSet.getUri();
  await mongoose.connect(replSet.getUri(), { dbName: "store_command_e2e" });

  const world = await seed();
  const app = buildApp();
  const server = app.listen(PORT, () => {
    process.stdout.write(`${JSON.stringify({
      ready: true,
      port: PORT,
      password: PASSWORD,
      companyA: String(world.companyA),
      companyB: String(world.companyB),
      people: world.people.map((p) => ({ email: p.email, grant: p.grant, other: p.other || null })),
      receiptNumber: world.store.receiptNumber,
      books: { accountant: "books@e2e.test", companyA: String(world.books.A), companyB: String(world.books.B) },
    })}\n`);
  });

  const stop = async () => {
    server.close();
    await mongoose.disconnect().catch(() => {});
    await replSet.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exit(1);
  });
}

module.exports = { buildApp, seed, PASSWORD };
