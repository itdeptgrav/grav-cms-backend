"use strict";
/*
 * THE IE DEMO SEEDER.
 *
 * A seeder is a program that writes to a database on purpose, so the facts
 * worth pinning are mostly about what it REFUSES to do. The scenario it builds
 * matters too — an empty demo is the problem it exists to solve — but a demo
 * seeder that could run against the wrong database is a worse problem than an
 * empty screen.
 *
 * These run against the suite's in-memory replica set, whose URI is a local
 * 127.0.0.1 host, so the guard under test allows it for the same reason it
 * allows a developer's own mongod.
 */

/* The house convention for IE route tests: a throwaway key so `Employee`'s
   salary encryption hook can run. Jest does not load `.env`. */
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || "grav_clothing_secret_key";

const mongoose = require("mongoose");

const guards = require("../../scripts/ie/ieDemoGuards");
const seeder = require("../../scripts/ie/seed-ie-demo");
const { IDENTITIES } = require("../../scripts/ie/ieDemoScenario");

const AccessDepartment = require("../../models/Access/AccessDepartment");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");

const PASSWORD = "demo-password-1234";
const LOCAL = "mongodb://127.0.0.1:27017/grav_ie_demo";

const db = () => mongoose.connection.db;
const env = (over = {}) => ({
  NODE_ENV: "development", IE_DEMO_SEED: "1", IE_DEMO_PASSWORD: PASSWORD, ...over,
});

/**
 * The `ie` AccessDepartment the real boot creates.
 *
 * Copied field-for-field from `services/ensureAccessDepartments.js` rather
 * than invented, so this fixture cannot drift away from what the application
 * actually has — and so the absence of a `ppc` row here is the SAME absence
 * the running server has.
 */
/**
 * The manifest is a raw collection with no Mongoose model, so the suite's
 * `afterEach` — which walks `mongoose.connection.collections` — never clears
 * it. Left behind, it makes every test after the first one think the scenario
 * is already built.
 */
async function clearManifest() {
  await mongoose.connection.db.collection(seeder.MANIFEST).deleteMany({});
}

/**
 * The seeder is self-contained, so nothing is pre-created here any more. Only
 * the model-less manifest is cleared, which the suite's own `afterEach` cannot
 * see. An empty database is the case under test.
 */
async function bootDepartments() {
  await clearManifest();
}

const runSeed = (opts = {}) =>
  seeder.seed(db(), { password: PASSWORD, skipRelease: false, ...opts }, { log() {} });

/* ══ 1–2. IT REFUSES ══════════════════════════════════════════════════════ */

describe("the seeder refuses to run where it should not", () => {
  test("production is refused outright", () => {
    expect(() => guards.assertSeedable(env({ NODE_ENV: "production" }), LOCAL))
      .toThrow(/NODE_ENV is production/);
  });

  test("the explicit opt-in is required", () => {
    expect(() => guards.assertSeedable(env({ IE_DEMO_SEED: "" }), LOCAL))
      .toThrow(/IE_DEMO_SEED=1/);
    expect(() => guards.assertSeedable(env({ IE_DEMO_SEED: "yes" }), LOCAL))
      .toThrow(/IE_DEMO_SEED=1/);
  });

  test("a managed cluster is refused even when NODE_ENV says development", () => {
    /* THE CASE THAT MATTERS ON THIS CHECKOUT. `.env` sets NODE_ENV=development
       and the URI carries no database path, so Mongoose defaults to a database
       named `test` — which means the house convention's two guards BOTH pass
       while pointing at the team's live Atlas cluster. */
    const atlas = "mongodb+srv://user@cluster0.nffihha.mongodb.net/";
    expect(() => guards.assertSeedable(env(), atlas)).toThrow(/managed cluster/);
    expect(guards.looksManaged(atlas)).toBe(true);
    expect(guards.looksLocal(atlas)).toBe(false);
  });

  test("an unrecognised host is refused rather than assumed safe", () => {
    expect(() => guards.assertSeedable(env(), "mongodb://db.internal.example:27017/x"))
      .toThrow(/not a recognised local host/);
  });

  test("the password must come from the environment and be real", () => {
    expect(() => guards.assertSeedable(env({ IE_DEMO_PASSWORD: "" }), LOCAL))
      .toThrow(/IE_DEMO_PASSWORD/);
    expect(() => guards.assertSeedable(env({ IE_DEMO_PASSWORD: "short" }), LOCAL))
      .toThrow(/at least 8/);
  });

  test("a local replica set is allowed", () => {
    expect(guards.assertSeedable(env(), LOCAL)).toEqual({ password: PASSWORD });
    expect(guards.assertSeedable(env(), mongoose.connection.client.s.url || LOCAL))
      .toEqual({ password: PASSWORD });
  });

  test("and a standalone is refused for the release rather than faking one", () => {
    expect(() => guards.assertReplicaSet(false)).toThrow(/no transactions/);
    expect(() => guards.assertReplicaSet(true)).not.toThrow();
  });
});

/* ══ 3–4. IT BUILDS, ONCE ═════════════════════════════════════════════════ */

describe("the scenario", () => {
  beforeEach(bootDepartments);

  test("a first run creates the two companies and the connected chain", async () => {
    const m = await runSeed();

    const companies = await Acc_Company.find({
      companyName: { $in: [seeder.PRIMARY, seeder.SECONDARY] },
    }).lean();
    expect(companies).toHaveLength(2);

    expect(m.workOrderIds.length).toBe(
      seeder.PRIMARY_ORDERS.length + seeder.SECONDARY_ORDERS.length,
    );
    expect(m.styleIds.length).toBe(m.workOrderIds.length);
    /* Several orders, so no register is a one-row mockup. */
    expect(seeder.PRIMARY_ORDERS.length).toBeGreaterThan(1);
    /* The second company is deliberately smaller, so the selector visibly
       changes the screen. */
    expect(seeder.SECONDARY_ORDERS.length).toBeLessThan(seeder.PRIMARY_ORDERS.length);

    expect(m.operationIds.length).toBeGreaterThan(4);
    expect(m.policyIds.length).toBe(1);
    expect(m.fileIds.length).toBe(seeder.PRIMARY_ORDERS.length);
    expect(m.versionIds).toHaveLength(1);
    expect(m.layoutIds).toHaveLength(1);
    expect(m.standardIds).toHaveLength(1);
    expect(m.rampIds).toHaveLength(1);
  }, 120000);

  test("a second run creates no duplicates", async () => {
    const first = await runSeed();
    const before = {
      companies: await Acc_Company.countDocuments({}),
      users: await DeptUser.countDocuments({}),
      orders: await WorkOrder.countDocuments({}),
      styles: await SampleStyle.countDocuments({}),
      roles: await DepartmentRole.countDocuments({}),
      memberships: await SpCompanyMembership.countDocuments({}),
    };

    const second = await runSeed();

    expect(await Acc_Company.countDocuments({})).toBe(before.companies);
    expect(await DeptUser.countDocuments({})).toBe(before.users);
    expect(await WorkOrder.countDocuments({})).toBe(before.orders);
    expect(await SampleStyle.countDocuments({})).toBe(before.styles);
    expect(await DepartmentRole.countDocuments({})).toBe(before.roles);
    expect(await SpCompanyMembership.countDocuments({})).toBe(before.memberships);

    /* Same records, reused — not a second scenario beside the first. */
    expect(second.fileIds.sort()).toEqual(first.fileIds.sort());
    expect(second.versionIds).toEqual(first.versionIds);
    /* The note is now the stronger claim: not "a manifest existed" but "every
       member of the scenario was verified present, linked and in state". */
    expect(second.notes.join(" ")).toMatch(/verified complete/i);
    expect(second.notes.join(" ")).not.toMatch(/rebuilt/i);
  }, 180000);
});

/* ══ 5. CLEANUP IS NARROW ═════════════════════════════════════════════════ */

describe("cleanup removes only what the demo made", () => {
  beforeEach(bootDepartments);

  test("an unrelated record is untouched", async () => {
    const outsider = await Acc_Company.create({
      companyName: "Real Customer Co", booksFromDate: new Date("2026-04-01"),
    });
    const outsiderUser = await DeptUser.create({
      name: "Real Person", email: "real.person@example.com", passwordHash: "x",
      departmentId: new mongoose.Types.ObjectId(), isActive: true,
    });
    const outsiderOrder = await WorkOrder.create({
      workOrderNumber: "REAL-WO-1", quantity: 10, originalQuantity: 10, status: "planned",
      stockItemId: new mongoose.Types.ObjectId(), stockItemName: "Real", stockItemReference: "REAL",
      customerId: new mongoose.Types.ObjectId(), customerName: "Real Customer",
    });

    await runSeed();
    await seeder.purge(db(), { log() {} });

    expect(await Acc_Company.findById(outsider._id).lean()).toBeTruthy();
    expect(await DeptUser.findById(outsiderUser._id).lean()).toBeTruthy();
    expect(await WorkOrder.findById(outsiderOrder._id).lean()).toBeTruthy();

    /* And the demo's own records are gone. */
    expect(await Acc_Company.findOne({ companyName: seeder.PRIMARY }).lean()).toBeNull();
    expect(await DeptUser.countDocuments({ email: /\.demo@grav\.demo$/ })).toBe(0);
    expect(await seeder.loadManifest(db())).toBeNull();
  }, 180000);

  test("cleanup deletes by id, never by a name pattern", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "../../scripts/ie/seed-ie-demo.js"), "utf8",
    );
    const purgeBody = src.slice(src.indexOf("async function purge"), src.indexOf("async function seed"));
    /* A regex over a NAME would delete whatever somebody had renamed. The one
       regex allowed is over this demo's own idempotency keys. */
    expect(purgeBody).toMatch(/_id: \{ \$in: ids\(list\) \}/);
    expect(purgeBody).not.toMatch(/companyName:\s*\/|name:\s*new RegExp/);
  });
});

/* ══ 6–7. THE SIX IDENTITIES ══════════════════════════════════════════════ */

describe("the development identities", () => {
  beforeEach(bootDepartments);

  test("all six exist with the intended department and role", async () => {
    await runSeed();

    for (const spec of IDENTITIES) {
      const user = await DeptUser.findOne({ email: spec.email }).lean();
      expect(user).toBeTruthy();
      expect(user.isActive).toBe(true);

      const grant = await DepartmentRole.findOne({
        departmentSlug: spec.dept, email: spec.email,
      }).lean();
      expect(grant).toBeTruthy();
      expect(grant.role).toBe(spec.role);
    }
  }, 120000);

  test("the roles are the application's own, never invented", async () => {
    const { ROLE_KEYS } = require("../../services/departmentRoles");
    for (const spec of IDENTITIES) expect(ROLE_KEYS).toContain(spec.role);
  });

  test("memberships are isolated — only the multi-company approver holds both", async () => {
    await runSeed();
    const primary = await Acc_Company.findOne({ companyName: seeder.PRIMARY }).lean();
    const secondary = await Acc_Company.findOne({ companyName: seeder.SECONDARY }).lean();

    for (const spec of IDENTITIES) {
      const rows = await SpCompanyMembership.find({ email: spec.email }).lean();
      const ids = rows.map((r) => String(r.companyId)).sort();
      const expected = spec.companies
        .map((s) => String((s === "primary" ? primary : secondary)._id)).sort();
      expect(ids).toEqual(expected);
    }

    const multi = await SpCompanyMembership.find({ email: "ie.multicompany.demo@grav.demo" }).lean();
    expect(multi).toHaveLength(2);
    const viewer = await SpCompanyMembership.find({ email: "ie.viewer.demo@grav.demo" }).lean();
    expect(viewer).toHaveLength(1);
  }, 120000);

  test("passwords are set through the real DeptUser API and verify", async () => {
    await runSeed();
    const user = await DeptUser.findOne({ email: "ie.approver.demo@grav.demo" });
    /* The same method `/api/auth/login` calls. No bypass anywhere. */
    expect(await user.verifyPassword(PASSWORD)).toBe(true);
    expect(await user.verifyPassword("wrong-password")).toBe(false);
  }, 120000);
});

/* ══ 8–9. THE CHAIN IS CONNECTED BY STORED IDS ════════════════════════════ */

describe("the seeded chain is genuinely connected", () => {
  beforeEach(bootDepartments);

  test("the primary work order resolves to the seeded company and style", async () => {
    await runSeed();
    const company = await Acc_Company.findOne({ companyName: seeder.PRIMARY }).lean();
    const lead = seeder.PRIMARY_ORDERS[0];
    const ref = `${seeder.DEMO_TAG}-primary-${lead.key}`;

    const wo = await WorkOrder.findOne({ workOrderNumber: ref }).lean();
    const style = await SampleStyle.findOne({ sampleStyleId: ref }).lean();
    expect(wo).toBeTruthy();
    expect(style).toBeTruthy();

    /* The order names the style through Production's own field. */
    expect((style.production.workOrderIds || []).map(String)).toContain(String(wo._id));

    /* And the style proves the company on the SPINE branch of
       `styleOwnershipClause`: it names a journey, and that journey names this
       company. (The house-sample branch needs a style with no journey, which
       is unreachable here — `Enquiry.journeyId` is required by its own schema,
       so a journey exists either way.) */
    const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
    const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
    const journey = await SalesJourney.findById(style.journeyId).lean();
    expect(journey).toBeTruthy();
    expect(String(journey.companyId)).toBe(String(company._id));

    const enquiry = await Enquiry.findById(style.enquiryId).lean();
    expect(String(enquiry.companyId)).toBe(String(company._id));

    /* Which is exactly what the IE orders read requires, so the order is
       listable by this company and by no other. */
    const { styleOwnershipClause } = require("../../services/companyContext/merchandisingScope.service");
    const clause = await styleOwnershipClause(company._id);
    const visible = await SampleStyle.find({ ...clause, _id: style._id }).lean();
    expect(visible).toHaveLength(1);

    const other = await Acc_Company.findOne({ companyName: seeder.SECONDARY }).lean();
    const otherClause = await styleOwnershipClause(other._id);
    const leaked = await SampleStyle.find({ ...otherClause, _id: style._id }).lean();
    expect(leaked).toHaveLength(0);
  }, 120000);

  test("bulletin → version → layout → capacity are bound by stored ids", async () => {
    const m = await runSeed();

    /* Read through the MODELS, so this cannot drift from whatever collection
       name Mongoose derives. */
    const IeBulletinVersion = require("../../models/CMS_Models/IndustrialEngineering/IeBulletinVersion");
    const IeLineLayout = require("../../models/CMS_Models/IndustrialEngineering/IeLineLayout");
    const IeCapacityStandard = require("../../models/CMS_Models/IndustrialEngineering/IeCapacityStandard");

    const version = await IeBulletinVersion.findById(m.versionIds[0]).lean();
    const layout = await IeLineLayout.findById(m.layoutIds[0]).lean();
    const standard = await IeCapacityStandard.findById(m.standardIds[0]).lean();
    expect(version).toBeTruthy();
    expect(layout).toBeTruthy();
    expect(standard).toBeTruthy();

    expect(version.state).toBe("APPROVED");
    expect(layout.status).toBe("APPROVED");
    expect(standard.status).toBe("APPROVED");

    /* Each member names the one before it. */
    expect(String(layout.ieBulletinVersionId)).toBe(String(version._id));
    expect(String(standard.lineLayoutId)).toBe(String(layout._id));
    expect(String(version.ieStyleFileId)).toBe(String(m.fileIds[0]));

    /* And the revisions the release will compare are real numbers. */
    expect(typeof layout.revision).toBe("number");
    expect(typeof standard.revision).toBe("number");
    expect(typeof version.versionNo).toBe("number");

    /* A ramp stage was actually selected. */
    expect(standard.ramp).toBeTruthy();
  }, 120000);

  test("nothing manufactured an approved state by writing a status field", () => {
    const fs = require("fs");
    const path = require("path");
    const dir = path.join(__dirname, "../../scripts/ie");
    for (const f of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
      /* Every IE lifecycle state comes from its service. A seeder that wrote
         `status: "APPROVED"` would be demonstrating the seeder. */
      expect(src).not.toMatch(/status:\s*["']APPROVED["']/);
      expect(src).not.toMatch(/state:\s*["']APPROVED["']/);
      expect(src).not.toMatch(/state:\s*["']ISSUED["']/);
    }
  });
});

/* ══ 8b. THE CANONICAL ORDER-TO-STYLE LINK ════════════════════════════════ */

describe("the order names its style the way a new order does", () => {
  beforeEach(bootDepartments);

  test("the WorkOrder's OWN sampleStyleId is set, not just the reverse list", async () => {
    await runSeed();
    const ref = `${seeder.DEMO_TAG}-primary-${seeder.PRIMARY_ORDERS[0].key}`;
    const wo = await WorkOrder.findOne({ workOrderNumber: ref }).lean();
    const style = await SampleStyle.findOne({ sampleStyleId: ref }).lean();

    /* THE CANONICAL DIRECTION. An order carrying only the reverse reference
       would exercise `ieOrders.service`'s legacy recovery path, not the
       contract a newly released order actually uses. */
    expect(wo.sampleStyleId).toBeTruthy();
    expect(String(wo.sampleStyleId)).toBe(String(style._id));

    /* And the reverse list, so a style can still find its runs. */
    expect((style.production.workOrderIds || []).map(String)).toContain(String(wo._id));

    /* Every seeded order, not just the lead one. */
    for (const m of [...seeder.PRIMARY_ORDERS.map((o) => ["primary", o]),
      ...seeder.SECONDARY_ORDERS.map((o) => ["secondary", o])]) {
      const r = `${seeder.DEMO_TAG}-${m[0]}-${m[1].key}`;
      const order = await WorkOrder.findOne({ workOrderNumber: r }).lean();
      expect(String(order.sampleStyleId || "")).toMatch(/^[a-f0-9]{24}$/);
    }
  }, 180000);

  test("ieOrders.service lists it for the primary company, with canonical linkage", async () => {
    await runSeed();
    const primary = await Acc_Company.findOne({ companyName: seeder.PRIMARY }).lean();
    const ieOrders = require("../../services/industrialEngineering/ieOrders.service");

    const out = await ieOrders.listOrders({ companyId: primary._id }, { limit: 50 });
    const ref = `${seeder.DEMO_TAG}-primary-${seeder.PRIMARY_ORDERS[0].key}`;
    /* The published field is `reference`, which is the work-order number. */
    const row = (out.rows || []).find((r) => r.reference === ref);
    expect(row).toBeTruthy();

    /* ── THE SERVICE'S OWN VERDICTS, READ RATHER THAN ASSUMED ───────────
       `orderStyleLink` publishes both: how the company was proved, and WHICH
       stored reference resolved the style. `BOTH_REFERENCES_AGREE` is what a
       correctly seeded order produces — the canonical `sampleStyleId` and the
       style's reverse list pointing at each other. */
    const { COMPANY_ATTRIBUTION, STYLE_LINK_STATUS, resolveOrderStyleLink } =
      require("../../services/industrialEngineering/orderStyleLink");

    /* Attribution is the service's INTERNAL verdict — it decides whether an
       order is listed at all and is deliberately not published on the row, so
       it is read from the resolver itself rather than from the response. */
    const wo = await WorkOrder.findOne({ workOrderNumber: ref }).lean();
    const style = await SampleStyle.findOne({ sampleStyleId: ref }).lean();
    const decision = resolveOrderStyleLink({
      order: wo,
      canonicalStyleId: wo.sampleStyleId,
      directStyleIds: [style._id],
      ownerOf: () => String(primary._id),
    });
    expect(decision.attribution).toBe(COMPANY_ATTRIBUTION.ONE_COMPANY);
    expect(String(decision.companyId)).toBe(String(primary._id));
    expect([
      STYLE_LINK_STATUS.CANONICAL_WORK_ORDER_REFERENCE,
      STYLE_LINK_STATUS.BOTH_REFERENCES_AGREE,
    ]).toContain(row.styleLinkState);
    /* And specifically NOT the legacy-recovery path. */
    expect(row.styleLinkState).not.toBe(STYLE_LINK_STATUS.DIRECT_WORK_ORDER_REFERENCE);
    expect(row.styleLinkState).not.toBe(STYLE_LINK_STATUS.NO_STYLE_REFERENCE);
  }, 180000);

  test("and it is absent for the second company", async () => {
    await runSeed();
    const secondary = await Acc_Company.findOne({ companyName: seeder.SECONDARY }).lean();
    const ieOrders = require("../../services/industrialEngineering/ieOrders.service");

    const out = await ieOrders.listOrders({ companyId: secondary._id }, { limit: 50 });
    const refs = (out.rows || []).map((r) => r.reference);

    for (const o of seeder.PRIMARY_ORDERS) {
      expect(refs).not.toContain(`${seeder.DEMO_TAG}-primary-${o.key}`);
    }
    /* Its own order IS there, so an empty list is not what passed this. */
    expect(refs).toContain(`${seeder.DEMO_TAG}-secondary-${seeder.SECONDARY_ORDERS[0].key}`);
  }, 180000);
});

/* ══ 4b. THE SCENARIO IS VERIFIED WHOLE, NOT SAMPLED ══════════════════════ */

describe("idempotency verifies the complete scenario", () => {
  beforeEach(bootDepartments);

  const { verifyScenario } = require("../../scripts/ie/ieDemoIntegrity");

  /**
   * Corruption is simulated through the RAW collection.
   *
   * The models refuse it — an approved line layout carries a query-layer guard
   * that throws "An approved line layout is permanent evidence of a plan
   * somebody accepted", which is the application being right. The scenarios
   * below are not legal operations; they are the database having been damaged
   * by something else, which is exactly what the integrity check exists to
   * notice. Going around the guard is the only honest way to stage that.
   */
  const raw = (name) => mongoose.connection.db.collection(name);
  const oid = (v) => new mongoose.Types.ObjectId(String(v));

  test("a freshly seeded scenario verifies complete", async () => {
    const m = await runSeed();
    const v = await verifyScenario(m, {});
    expect(v.reasons).toEqual([]);
    expect(v.complete).toBe(true);
  }, 180000);

  test("deleting a MIDDLE record is detected and the chain is restored", async () => {
    const first = await runSeed();
    /* The layout sits in the middle: a version above it, a standard and a
       release below. Exactly the case the old one-file check missed. */
    await raw("ie_line_layouts").deleteOne({ _id: oid(first.layoutIds[0]) });
    const IeLineLayout = require("../../models/CMS_Models/IndustrialEngineering/IeLineLayout");
    expect((await verifyScenario(first, {})).complete).toBe(false);

    const second = await runSeed();
    expect(second.notes.join(" ")).toMatch(/incomplete, rebuilt/i);
    expect((await verifyScenario(second, {})).complete).toBe(true);

    /* Rebuilt, not duplicated — and the orphaned old records are gone. */
    expect(second.layoutIds).toHaveLength(1);
    expect(second.versionIds).toHaveLength(1);
    expect(second.standardIds).toHaveLength(1);
    expect(second.releaseIds).toHaveLength(1);
    expect(await IeLineLayout.countDocuments({})).toBe(1);

    const IeBulletinVersion = require("../../models/CMS_Models/IndustrialEngineering/IeBulletinVersion");
    const IeCapacityStandard = require("../../models/CMS_Models/IndustrialEngineering/IeCapacityStandard");
    const IeRelease = require("../../models/CMS_Models/IndustrialEngineering/IeRelease");
    expect(await IeBulletinVersion.countDocuments({})).toBe(1);
    expect(await IeCapacityStandard.countDocuments({})).toBe(1);
    expect(await IeRelease.countDocuments({})).toBe(1);

    /* No orphan: the old ids are not still lying around under new ones. */
    expect(String(second.layoutIds[0])).not.toBe(String(first.layoutIds[0]));
  }, 300000);

  test("deleting a TERMINAL record is detected and the chain is restored", async () => {
    const first = await runSeed();
    const IeRelease = require("../../models/CMS_Models/IndustrialEngineering/IeRelease");

    await raw("ie_releases").deleteOne({ _id: oid(first.releaseIds[0]) });
    const v = await verifyScenario(first, {});
    expect(v.complete).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/release/i);

    const second = await runSeed();
    expect((await verifyScenario(second, {})).complete).toBe(true);
    expect(await IeRelease.countDocuments({})).toBe(1);
    expect(second.releaseIds).toHaveLength(1);
  }, 300000);

  test("a deleted identity is detected too", async () => {
    const first = await runSeed();
    await DeptUser.deleteOne({ email: "ppc.approver.demo@grav.demo" });
    const v = await verifyScenario(first, {});
    expect(v.complete).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/ppc\.approver\.demo/);

    await runSeed();
    expect(await DeptUser.findOne({ email: "ppc.approver.demo@grav.demo" }).lean()).toBeTruthy();
  }, 300000);

  test("a broken LINK is detected, not just a missing document", async () => {
    const first = await runSeed();
    const IeCapacityStandard = require("../../models/CMS_Models/IndustrialEngineering/IeCapacityStandard");

    /* The standard exists, but no longer names the seeded layout. Existence
       checks pass; the scenario is still broken. */
    await raw("ie_capacity_standards").updateOne(
      { _id: oid(first.standardIds[0]) },
      { $set: { lineLayoutId: new mongoose.Types.ObjectId() } },
    );
    const v = await verifyScenario(first, {});
    expect(v.complete).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/does not name the seeded layout/i);
  }, 300000);

  test("a lifecycle state that moved is detected", async () => {
    const first = await runSeed();
    await raw("ie_line_layouts").updateOne(
      { _id: oid(first.layoutIds[0]) }, { $set: { status: "DRAFT" } },
    );
    const v = await verifyScenario(first, {});
    expect(v.complete).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/line layout: status is DRAFT/);
  }, 300000);
});

/* ══ 4c. THE DEPARTMENTS, SUPPLIED LOCALLY ════════════════════════════════ */

describe("the seeder is self-contained about departments", () => {
  beforeEach(bootDepartments);

  test("an empty database gets both `ie` and `ppc`", async () => {
    expect(await AccessDepartment.countDocuments({})).toBe(0);
    const m = await runSeed();

    const ie = await AccessDepartment.findOne({ slug: "ie" }).lean();
    const ppc = await AccessDepartment.findOne({ slug: "ppc" }).lean();
    expect(ie).toBeTruthy();
    expect(ppc).toBeTruthy();
    /* The PPC app-switcher destination the frontend shell routes to. */
    expect(ppc.dashboardPath).toBe("/ppc/engineering-releases");
    expect(ie.dashboardPath).toBe("/industrial-engineering/orders");
    expect(m.createdDepartments.sort()).toEqual(["ie", "ppc"]);
  }, 180000);

  test("PPC users point at the PPC department, never aliased to IE", async () => {
    await runSeed();
    const ppc = await AccessDepartment.findOne({ slug: "ppc" }).lean();
    const ie = await AccessDepartment.findOne({ slug: "ie" }).lean();

    for (const email of ["ppc.viewer.demo@grav.demo", "ppc.approver.demo@grav.demo"]) {
      const user = await DeptUser.findOne({ email }).lean();
      expect(String(user.departmentId)).toBe(String(ppc._id));
      expect(String(user.departmentId)).not.toBe(String(ie._id));
    }
    for (const email of ["ie.viewer.demo@grav.demo", "ie.approver.demo@grav.demo"]) {
      const user = await DeptUser.findOne({ email }).lean();
      expect(String(user.departmentId)).toBe(String(ie._id));
    }
  }, 180000);

  test("a department it did NOT create survives the purge", async () => {
    /* Somebody else's `ie` row, already there. */
    await AccessDepartment.create({
      key: "ie", slug: "ie", name: "Industrial Engineering", sortOrder: 47,
      legacyModel: null, legacyCollection: "iedepartments", legacyUserType: "ie",
      dashboardPath: "/industrial-engineering/orders", description: "Pre-existing.",
      isActive: true,
    });

    const m = await runSeed();
    expect(m.createdDepartments).toEqual(["ppc"]);

    await seeder.purge(db(), { log() {} });
    /* Its own `ppc` row is gone; the pre-existing `ie` row is untouched. */
    expect(await AccessDepartment.findOne({ slug: "ppc" }).lean()).toBeNull();
    const ie = await AccessDepartment.findOne({ slug: "ie" }).lean();
    expect(ie).toBeTruthy();
    expect(ie.description).toBe("Pre-existing.");
  }, 240000);
});

/* ══ 10. PPC SEES THE RELEASE ═════════════════════════════════════════════ */

describe("the issued release reaches PPC", () => {
  beforeEach(bootDepartments);

  test("it is visible through the existing PPC read boundary", async () => {
    const m = await runSeed();
    expect(m.releaseIds).toHaveLength(1);

    const company = await Acc_Company.findOne({ companyName: seeder.PRIMARY }).lean();
    const ppc = require("../../services/ppc/ieReleaseAck.service");
    const out = await ppc.listReleases(
      { companyId: company._id },
      { view: "pending", limit: 25 },
    );
    const ids = (out.rows || []).map((r) => String(r.releaseId));
    expect(ids).toContain(String(m.releaseIds[0]));

    /* Pending, because PPC has not answered it — not a fabricated receipt. */
    const row = out.rows.find((r) => String(r.releaseId) === String(m.releaseIds[0]));
    expect(row.effectiveState).toBe("PENDING");
    expect(row.releaseState).toBe("ISSUED");
  }, 180000);
});

/* ══ 11. NOTHING SECRET IS PRINTED ════════════════════════════════════════ */

describe("output never carries a secret", () => {
  beforeEach(bootDepartments);

  test("the report prints accounts and roles but no password, hash or token", async () => {
    const m = await runSeed();
    const lines = [];
    seeder.report(m, {}, { log: (s) => lines.push(String(s)) });
    const out = lines.join("\n");

    expect(out).toMatch(/ie\.approver\.demo@grav\.demo/);
    expect(out).toMatch(/approver/);
    expect(out).toMatch(/IE_DEMO_PASSWORD/); // names the variable, not the value

    expect(out).not.toContain(PASSWORD);
    expect(out).not.toMatch(/\$2[aby]\$/);   // no bcrypt hash
    expect(out).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}/); // no JWT
    for (const key of ["passwordHash", "tokenVersion"]) expect(out).not.toContain(key);
  }, 120000);

  test("the manifest itself holds no credential", async () => {
    const m = await runSeed();
    const dumped = JSON.stringify(m);
    expect(dumped).not.toContain(PASSWORD);
    expect(dumped).not.toMatch(/\$2[aby]\$/);
    expect(dumped).not.toMatch(/passwordHash/);
  }, 120000);

  test("and the redactor removes anything that could be one", () => {
    const red = guards.redact({
      email: "a@b.c", passwordHash: "$2a$10$x", token: "eyJhbGci", nested: { secret: "s", name: "n" },
    });
    expect(red.email).toBe("a@b.c");
    expect(red.passwordHash).toBe("[redacted]");
    expect(red.token).toBe("[redacted]");
    expect(red.nested.secret).toBe("[redacted]");
    expect(red.nested.name).toBe("n");
  });
});

/* ══ 12. NO EXISTING APPLICATION FILE WAS TOUCHED ═════════════════════════ */

describe("the lane boundary", () => {
  test("the seeder lives entirely in its own new directory", () => {
    const fs = require("fs");
    const path = require("path");
    const dir = path.join(__dirname, "../../scripts/ie");
    expect(fs.readdirSync(dir).sort()).toEqual([
      "ie-demo-mongo.js", "ieDemoGuards.js", "ieDemoIntegrity.js",
      "ieDemoLifecycle.js", "ieDemoScenario.js", "seed-ie-demo.js",
    ]);
  });

  test("it reuses the application's services rather than reimplementing them", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../../scripts/ie/ieDemoLifecycle.js"), "utf8");
    for (const svc of [
      "ieStyleFile.service", "ieOperationLibrary.service", "ieAllowancePolicy.service",
    ]) expect(src).toContain(svc);

    const seed = fs.readFileSync(path.join(__dirname, "../../scripts/ie/seed-ie-demo.js"), "utf8");
    for (const svc of [
      "ieBulletinVersion.service", "ieLineLayout.service",
      "ieCapacityStandard.service", "ieRampProfile.service", "ieRelease.service",
    ]) expect(seed).toContain(svc);
  });
});
