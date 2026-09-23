// test/costing/board-development-policy.test.js
//
// THE FIFTH POLICY ON THE BOARD LIFECYCLE: DEVELOPMENT AND TOOLING CHARGES.
//
// ── THE FIRST BOARD PAYLOAD THAT IS A CATALOGUE ─────────────────────────────
// Financing, overhead, labour and input GST are each ONE company rule. This is
// many: pattern development, marker making, screen making, a die. The Board
// approves the whole catalogue as one decision with one effective date, and
// that outer date is a second dating layer over the rate periods each charge
// already has.
//
// Both layers are load-bearing, and this suite proves each independently:
//
//   · without the OUTER one, adding a charge would apply to every costing ever
//     recalculated, because there would be nothing dated to select;
//   · without the INNER one, publishing October's rate would re-price a
//     costing approved at September's.
//
// ── AND A KEY IS THE ONE THING THAT IS PERMANENT ────────────────────────────
// A charge's key is what a style's requirement points at and what a frozen
// costing names in its provenance. It cannot be invented by a client, cannot
// be renamed, and cannot vanish — not from a draft, and not from a version
// superseding the one that published it. Withdrawing a charge is `active:
// false`, which stops it being offered and keeps it readable.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const AccessDepartment = require("../../models/Access/AccessDepartment");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const BoardPolicy = require("../../models/CMS_Models/Board/BoardPolicy");
const CostingPolicy = require("../../models/CMS_Models/Costing/CostingPolicy");
const developmentChargePolicy = require("../../services/centralCosting/developmentChargePolicy.service");

let server, base, rs, seq = 0;

const KEY = "DEVELOPMENT_CHARGE_POLICY";
const TEN_K = 1000000;
const TWELVE_K = 1200000;
const PER_SCREEN = 200000;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "board_development" });
  const app = express();
  app.use(express.json());
  app.use("/api/cms/board/policies", require("../../routes/CMS_Routes/Board/policies"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/board/policies`;
  await BoardPolicy.init();
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const call = (path, { token, company, method = "GET", body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const company = (name) => Acc_Company.create({
  companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01"),
});


/* ── A GRANT IS A DEPARTMENT AND A ROLE ──────────────────────────────────────
   Access Control writes both, and `services/board/boardAccess.js` requires
   both: a role row with nobody holding the department is a row, not a person —
   which is how "only employees with HR records hold Board" is enforced in the
   guard rather than only on the screen that writes the row.

   These fixtures used to write the role alone. Created on demand rather than in
   `beforeAll` because `test/setup.js` empties every collection after each
   test. */
const deptRow = (slug) => AccessDepartment.findOneAndUpdate(
  { slug },
  { $setOnInsert: { slug, key: slug, name: slug, dashboardPath: `/${slug}` } },
  { upsert: true, new: true },
).lean();

async function actor({ companies = [], grants = {}, isAdmin = false } = {}) {
  const n = ++seq;
  const email = `dev${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "D", lastName: `V${n}`, email, biometricId: `DV${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "D" });
  }
  const held = [];
  for (const [departmentSlug, role] of Object.entries(grants)) {
    const dept = await deptRow(departmentSlug);
    held.push(dept._id);
    await DepartmentRole.create({
      departmentSlug, email, name: "User", role, isActive: true,
      departmentId: dept._id,
    });
  }
  if (held.length) {
    await Employee.updateOne({ _id: emp._id }, { $set: { additionalDepartmentIds: held } });
  }
  return {
    email,
    token: jwt.sign(
      { id: String(emp._id), email, name: `Board ${n}`, role: "employee", isAdmin, employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

const rate = (over = {}) => ({
  amountMinor: TEN_K, currency: "INR", effectiveFrom: "2026-04-01", ...over,
});
const PATTERN = { label: "Pattern development", calculation: "FLAT_PER_RUN", rates: [rate()] };
const SCREENS = {
  label: "Screen making", calculation: "PER_REQUIREMENT_UNIT", unit: "Screen",
  rates: [rate({ amountMinor: PER_SCREEN })],
};

const startDraft = (me, co, body = {}) =>
  call(`/${KEY}/drafts`, { method: "POST", token: me.token, company: co._id, body });

const writeDraft = (me, co, id, revision, developmentCharges) =>
  call(`/${KEY}/drafts/${id}`, {
    method: "PUT", token: me.token, company: co._id,
    body: { revision, developmentCharges },
  });

const approveDraft = (me, co, id, effectiveFrom) =>
  call(`/${KEY}/drafts/${id}/approve`, {
    method: "POST", token: me.token, company: co._id, body: { effectiveFrom },
  });

/** Draft → write → approve, the whole act, as the Board performs it. */
async function publish(me, co, developmentCharges, { effectiveFrom = "2026-04-01", seedFrom = null } = {}) {
  const started = await startDraft(me, co, seedFrom ? { seedFrom } : {});
  if (started.status !== 201) return started;
  const v = started.body.version;
  if (developmentCharges !== undefined) {
    const saved = await writeDraft(me, co, v._id, v.revision, developmentCharges);
    if (saved.status !== 200) return saved;
  }
  return approveDraft(me, co, v._id, effectiveFrom);
}

const read = (me, co) => call(`/${KEY}`, { token: me.token, company: co._id });
const effectiveCharges = (res) => {
  const v = (res.body.versions || []).find((x) => String(x._id) === String(res.body.effectiveId));
  return v ? (v.developmentCharges || []) : [];
};

/* ═══ 1 · NOTHING BY DEFAULT, AND ABSENCE IS NOT FREE ═════════════════════ */

describe("a company starts with no development charge catalogue", () => {
  test("nothing is seeded, and no charge is invented", async () => {
    const co = await company("Fresh");
    const me = await actor({ companies: [co], grants: { board: "owner" } });

    const r = await read(me, co);
    expect(r.status).toBe(200);
    expect(r.body.versions).toEqual([]);
    expect(r.body.effectiveId).toBeFalsy();
  });

  test("with no policy the resolver says so, and does not report an empty catalogue", async () => {
    /* ── THE DISTINCTION THE WHOLE FAMILY TURNS ON ────────────────────
       "The Board has not decided" and "the Board decided there are none" are
       different answers fixed in different places. Collapsing them would tell
       a company to add a charge when what it actually needs is a decision. */
    const co = await company("Undecided");
    const resolved = await developmentChargePolicy.resolveFor({ companyId: co._id });
    expect(resolved.state).toBe("POLICY_MISSING");
    expect(resolved.charges).toEqual([]);
    expect(resolved.missing[0].owner.department).toBe("Board");
    expect(resolved.missing[0].message).toMatch(/It is not free/);
    /* And the overlay fills NOTHING, so the assembly can tell the two apart. */
    expect(developmentChargePolicy.overlayFor(resolved).developmentCharges).toBeUndefined();
  });

  test("an empty catalogue is a decision the Board may approve, and reads as one", async () => {
    const co = await company("Buys everything outside");
    const me = await actor({ companies: [co], grants: { board: "owner" } });

    const r = await publish(me, co, []);
    expect(r.status).toBe(200);

    const resolved = await developmentChargePolicy.resolveFor({ companyId: co._id });
    expect(resolved.state).toBe("APPLIED");
    expect(resolved.charges).toEqual([]);
    /* An empty ARRAY, not undefined: the company answered. */
    expect(developmentChargePolicy.overlayFor(resolved).developmentCharges).toEqual([]);
  });
});

/* ═══ 2 · A KEY IS MINTED, NEVER TYPED ════════════════════════════════════ */

describe("a charge's identity", () => {
  test("the server mints a readable key, and a client cannot name one", async () => {
    const co = await company("Minting");
    const me = await actor({ companies: [co], grants: { board: "owner" } });

    expect((await publish(me, co, [PATTERN])).status).toBe(200);
    const [stored] = effectiveCharges(await read(me, co));
    expect(stored.key).toBe("pattern-development");

    /* ── AND A SECOND IDENTITY FOR ONE CHARGE IS REFUSED ──────────────
       A client that could name its own key could publish "pattern" beside
       "pattern-development" and split one charge in two, leaving half the
       requirements resolving and half not. */
    const started = await startDraft(me, co, { seedFrom: "EFFECTIVE_VERSION" });
    const r = await writeDraft(me, co, started.body.version._id, started.body.version.revision, [
      { ...PATTERN, key: "pattern" },
    ]);
    expect(r.status).toBe(400);
    expect(r.body.error.details.reason).toBe("DEVELOPMENT_CHARGE_KEY_UNKNOWN");
  });

  test("two charges with the same name get different keys", async () => {
    const co = await company("Collision");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    expect((await publish(me, co, [PATTERN, { ...PATTERN }])).status).toBe(200);
    expect(effectiveCharges(await read(me, co)).map((c) => c.key))
      .toEqual(["pattern-development", "pattern-development-2"]);
  });

  test("the name may change; the key does not follow it", async () => {
    const co = await company("Rename");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await publish(me, co, [PATTERN]);
    const [before] = effectiveCharges(await read(me, co));

    const r = await publish(
      me, co,
      [{ ...PATTERN, key: before.key, label: "Pattern and marker development" }],
      { effectiveFrom: "2026-07-01", seedFrom: "EFFECTIVE_VERSION" },
    );
    expect(r.status).toBe(200);
    const [after] = effectiveCharges(await read(me, co));
    expect(after.key).toBe(before.key);
    expect(after.label).toBe("Pattern and marker development");
  });
});

/* ═══ 3 · NOTHING MAY VANISH, IN A DRAFT OR ACROSS VERSIONS ═══════════════ */

describe("a published key is permanent", () => {
  test("dropping a key from a seeded draft is refused, and says what to do instead", async () => {
    const co = await company("Dropping");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await publish(me, co, [PATTERN, SCREENS]);
    const stored = effectiveCharges(await read(me, co));

    const started = await startDraft(me, co, { seedFrom: "EFFECTIVE_VERSION" });
    const r = await writeDraft(me, co, started.body.version._id, started.body.version.revision, [
      { ...PATTERN, key: stored[0].key },
    ]);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("DEVELOPMENT_CHARGE_KEY_REMOVED");
    expect(r.body.error.details.keys).toEqual(["screen-making"]);
    expect(r.body.error.details.remedy).toBe("DEACTIVATE");
  });

  test("and a version that omits it cannot supersede one that published it", async () => {
    /* ── THE HOLE A DRAFT-ONLY CHECK WOULD LEAVE ──────────────────────
       A draft starts empty, so "nothing was removed from this draft" is
       trivially true of one written from scratch. The removal that matters is
       against what the company actually has in force, so it is checked at the
       act that puts a catalogue in force. */
    const co = await company("Superseding");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await publish(me, co, [PATTERN, SCREENS]);

    const started = await startDraft(me, co, {});
    await writeDraft(me, co, started.body.version._id, started.body.version.revision, [PATTERN]);
    const r = await approveDraft(me, co, started.body.version._id, "2026-07-01");
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("DEVELOPMENT_CHARGE_KEY_REMOVED");

    /* And what is in force is untouched — the refusal is not a partial act. */
    expect(effectiveCharges(await read(me, co))).toHaveLength(2);
  });

  test("withdrawing is allowed, keeps the row, and stops it being offered", async () => {
    const co = await company("Withdrawing");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await publish(me, co, [PATTERN, SCREENS]);
    const stored = effectiveCharges(await read(me, co));

    const r = await publish(
      me, co,
      [{ ...PATTERN, key: stored[0].key }, { ...SCREENS, key: stored[1].key, active: false }],
      { effectiveFrom: "2026-07-01", seedFrom: "EFFECTIVE_VERSION" },
    );
    expect(r.status).toBe(200);

    const after = effectiveCharges(await read(me, co));
    expect(after).toHaveLength(2);
    expect(after[1].active).toBe(false);

    /* Still resolvable — a frozen costing that names it stays explicable — and
       no longer offered to the desk that picks one. */
    const resolved = await developmentChargePolicy.resolveFor({ companyId: co._id });
    expect(resolved.charges.map((c) => c.key)).toEqual(["pattern-development", "screen-making"]);
    expect([...developmentChargePolicy.catalogueForMerchandising(resolved).keys()])
      .toEqual(["pattern-development"]);
  });
});

/* ═══ 4 · A CATALOGUE THAT COULD NOT BE APPLIED IS NOT APPROVED ═══════════ */

describe("what a catalogue must state before it is in force", () => {
  test("a charge with no rate is a gap, and blocks approval by name", async () => {
    const co = await company("Rateless");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const r = await publish(me, co, [{ label: "Pattern development", rates: [] }]);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("BOARD_POLICY_INCOMPLETE");
    expect(r.body.error.details.gaps[0].message).toMatch(/has no rate/);
    expect(effectiveCharges(await read(me, co))).toHaveLength(0);
  });

  test("a per-unit charge with no unit names a count nobody can enter", async () => {
    const co = await company("Unitless");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const r = await publish(me, co, [{ ...SCREENS, unit: "" }]);
    expect(r.status).toBe(400);
    expect(r.body.error.details.gaps[0].message).toMatch(/a screen, a plate, a pattern/);
  });

  test("two rates on one day is a contradiction, refused where it is written", async () => {
    const co = await company("Overlap");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const started = await startDraft(me, co, {});
    const r = await writeDraft(me, co, started.body.version._id, started.body.version.revision, [{
      label: "Pattern development",
      rates: [
        rate({ effectiveFrom: "2026-04-01", effectiveTo: "2026-12-01" }),
        rate({ amountMinor: TWELVE_K, effectiveFrom: "2026-10-01" }),
      ],
    }]);
    expect(r.status).toBe(400);
    expect(r.body.error.details.reason).toBe("DEVELOPMENT_CHARGE_PERIOD_OVERLAP");
  });

  test("only the last rate period may be open-ended", async () => {
    const co = await company("OpenEnded");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const started = await startDraft(me, co, {});
    const r = await writeDraft(me, co, started.body.version._id, started.body.version.revision, [{
      label: "Pattern development",
      rates: [rate({ effectiveFrom: "2026-04-01" }), rate({ amountMinor: TWELVE_K, effectiveFrom: "2026-10-01" })],
    }]);
    expect(r.status).toBe(400);
    expect(r.body.error.details.reason).toBe("DEVELOPMENT_CHARGE_PERIOD_OPEN_ENDED");
    expect(r.body.error.message).toMatch(/Close it on the date the next one starts/);
  });

  test("a rate in another currency could only be converted by guessing", async () => {
    const co = await company("Currency");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const started = await startDraft(me, co, {});
    const r = await writeDraft(me, co, started.body.version._id, started.body.version.revision, [{
      label: "Pattern development", rates: [rate({ currency: "USD" })],
    }]);
    expect(r.status).toBe(400);
    expect(r.body.error.details.reason).toBe("DEVELOPMENT_CHARGE_CURRENCY_UNSUPPORTED");
    expect(r.body.error.details.expected).toBe("INR");
    expect(r.body.error.message).toMatch(/no exchange rate source/);
  });

  test("periods that meet exactly are accepted, because the window is half-open", async () => {
    const co = await company("Consecutive");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const r = await publish(me, co, [{
      label: "Pattern development",
      rates: [
        rate({ effectiveFrom: "2026-04-01", effectiveTo: "2026-10-01" }),
        rate({ amountMinor: TWELVE_K, effectiveFrom: "2026-10-01" }),
      ],
    }]);
    expect(r.status).toBe(200);
    expect(effectiveCharges(await read(me, co))[0].rates).toHaveLength(2);
  });
});

/* ═══ 5 · THE OUTER DATING LAYER ══════════════════════════════════════════ */

describe("the version's own effective date selects the catalogue", () => {
  test("a catalogue approved for July is not the one a costing dated in May reads", async () => {
    /* ── WHY THE OUTER LAYER IS NOT REDUNDANT ─────────────────────────
       The rate periods date the AMOUNTS. The catalogue itself — which charges
       exist at all — is dated only by the version. Without this, adding a
       charge in July would make it exist in May too, and a costing
       recalculated for an old enquiry would resolve a charge nobody had. */
    const co = await company("TwoCatalogues");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await publish(me, co, [PATTERN], { effectiveFrom: "2026-04-01" });
    await publish(
      me, co,
      [{ ...PATTERN, key: "pattern-development" }, SCREENS],
      { effectiveFrom: "2026-07-01", seedFrom: "EFFECTIVE_VERSION" },
    );

    const may = await developmentChargePolicy.resolveFor(
      { companyId: co._id }, { asOf: new Date("2026-05-15") },
    );
    expect(may.charges.map((c) => c.key)).toEqual(["pattern-development"]);

    const august = await developmentChargePolicy.resolveFor(
      { companyId: co._id }, { asOf: new Date("2026-08-15") },
    );
    expect(august.charges.map((c) => c.key)).toEqual(["pattern-development", "screen-making"]);
  });

  test("and the inner layer still selects the rate inside whichever one applies", async () => {
    const co = await company("BothLayers");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await publish(me, co, [{
      label: "Pattern development",
      rates: [
        rate({ effectiveFrom: "2026-04-01", effectiveTo: "2026-10-01" }),
        rate({ amountMinor: TWELVE_K, effectiveFrom: "2026-10-01" }),
      ],
    }], { effectiveFrom: "2026-04-01" });

    const { selectPeriod } = require("../../services/centralCosting/developmentCharges");
    const resolved = await developmentChargePolicy.resolveFor(
      { companyId: co._id }, { asOf: new Date("2026-11-01") },
    );
    /* One catalogue, two rates, and the date picks between them. */
    expect(selectPeriod(resolved.charges[0], new Date("2026-09-30")).period.amountMinor).toBe(TEN_K);
    expect(selectPeriod(resolved.charges[0], new Date("2026-11-01")).period.amountMinor).toBe(TWELVE_K);
  });
});

/* ═══ 6 · COPYING IS NOT APPROVING ════════════════════════════════════════ */

describe("the migration door", () => {
  test("what a company still carries is offered for copying, with its keys", async () => {
    const co = await company("Legacy");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await CostingPolicy.create({
      companyId: co._id, baseCurrency: "INR", roundingMode: "HALF_UP", revision: 1,
      developmentCharges: [{
        key: "pattern", label: "Pattern development", amountMinor: TEN_K,
        currency: "INR", basis: "FIXED_PER_RUN", effectiveFrom: new Date("2026-04-01"), active: true,
      }],
    });

    const offered = await call(`/${KEY}/legacy`, { token: me.token, company: co._id });
    expect(offered.status).toBe(200);
    expect(offered.body.available).toBe(true);
    /* The KEY travels, because stored requirements point at it. Retyping the
       charge would mint a new one and orphan every one of them. */
    expect(offered.body.charges[0].key).toBe("pattern");
    /* Adapted out of the retired flat shape into the one period it always
       was, rather than arriving with no rate at all. */
    expect(offered.body.charges[0].rates[0].amountMinor).toBe(TEN_K);
  });

  test("a seeded draft is still a draft, and records that it was copied", async () => {
    const co = await company("Seeded");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await CostingPolicy.create({
      companyId: co._id, baseCurrency: "INR", roundingMode: "HALF_UP", revision: 1,
      developmentCharges: [{
        key: "pattern", label: "Pattern development", amountMinor: TEN_K,
        currency: "INR", basis: "FIXED_PER_RUN", effectiveFrom: new Date("2026-04-01"), active: true,
      }],
    });

    const started = await startDraft(me, co, { seedFrom: "LEGACY_COSTING_POLICY" });
    expect(started.status).toBe(201);
    expect(started.body.version.status).toBe("DRAFT");
    expect(started.body.version.seededFrom).toBe("LEGACY_COSTING_POLICY");
    expect(started.body.version.developmentCharges[0].key).toBe("pattern");
    /* Nothing is in force until somebody approves it. */
    expect(effectiveCharges(await read(me, co))).toHaveLength(0);

    expect((await approveDraft(me, co, started.body.version._id, "2026-04-01")).status).toBe(200);
    expect(effectiveCharges(await read(me, co))[0].key).toBe("pattern");
  });

  test("a company with nothing to copy is told so rather than given an empty draft", async () => {
    const co = await company("NothingToCopy");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const offered = await call(`/${KEY}/legacy`, { token: me.token, company: co._id });
    expect(offered.body.available).toBe(false);
    expect(offered.body.charges).toEqual([]);
  });
});

/* ═══ 7 · THE INFORMATION BOUNDARY ════════════════════════════════════════ */

describe("what leaves this policy, and what does not", () => {
  test("Merchandising is given identity and shape, and never a rate", async () => {
    const co = await company("Boundary");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await publish(me, co, [PATTERN, SCREENS]);

    const resolved = await developmentChargePolicy.resolveFor({ companyId: co._id });
    const offered = [...developmentChargePolicy.catalogueForMerchandising(resolved).values()];
    expect(offered).toEqual([
      { key: "pattern-development", label: "Pattern development", description: "", calculation: "FLAT_PER_RUN", unit: null },
      { key: "screen-making", label: "Screen making", description: "", calculation: "PER_REQUIREMENT_UNIT", unit: "Screen" },
    ]);
    /* Said as a whole-payload fact, not field by field: no amount, and no rate
       period to derive one from. */
    const text = JSON.stringify(offered);
    expect(text).not.toMatch(/amountMinor|rates|currency|effectiveFrom|1000000|200000/);
  });

  test("what a version freezes is the DECISION, not the rate card", async () => {
    const co = await company("Freezing");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await publish(me, co, [PATTERN, SCREENS]);

    const resolved = await developmentChargePolicy.resolveFor({ companyId: co._id });
    const frozen = developmentChargePolicy.freeze({ resolved, asOf: new Date("2026-09-01") });
    expect(frozen).toMatchObject({
      state: "APPLIED", policyKey: KEY, chargeCount: 2,
    });
    expect(frozen.boardPolicyId).toBeTruthy();
    expect(frozen.policyApprovedByName).toBeTruthy();
    /* The charge each LINE used is frozen on the line, with its selected
       period. Copying the whole catalogue here would put a rate card on a
       garment. */
    expect(JSON.stringify(frozen)).not.toMatch(/amountMinor|1000000|200000/);
  });
});

/* ═══ 8 · THE GUARD IS THE BOARD'S, NOT AN ADMINISTRATOR'S ════════════════ */

describe("who may publish a charge", () => {
  test("an administrator with no Board grant cannot read or write the catalogue", async () => {
    const co = await company("AdminOnly");
    const admin = await actor({ companies: [co], isAdmin: true });
    const r = await read(admin, co);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("BOARD_ACCESS_REQUIRED");
  });

  test("another company's catalogue is not this company's", async () => {
    const mine = await company("Mine");
    const theirs = await company("Theirs");
    const me = await actor({ companies: [mine], grants: { board: "owner" } });
    const them = await actor({ companies: [theirs], grants: { board: "owner" } });
    await publish(them, theirs, [PATTERN]);

    expect(effectiveCharges(await read(me, mine))).toHaveLength(0);
    const resolved = await developmentChargePolicy.resolveFor({ companyId: mine._id });
    expect(resolved.state).toBe("POLICY_MISSING");
  });
});
