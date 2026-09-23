// test/costing/board-duty-policy.test.js
//
// THE EIGHTH POLICY ON THE BOARD LIFECYCLE: CUSTOMS DUTY.
//
// ── THE FIRST ONE THAT CANNOT ANSWER ON ITS OWN ─────────────────────────────
// Every other Board policy is a complete decision the moment it is approved.
// A duty figure needs three facts held at three desks:
//
//   Store  whether the goods are imported and from where — on the quotation,
//          because the same fabric may be quoted by a local mill and by an
//          importer;
//   Item   the customs tariff heading, on the item master, because a heading
//          belongs to the goods and not to one offer;
//   Board  what that heading and origin cost — this table.
//
// So this suite proves the table's own rules, and `board-duty-costing` proves
// what happens when one of the other two desks has not answered.
//
// ── AND THE INFERENCES THAT ARE REFUSED ─────────────────────────────────────
// No prefix matching on headings, no rest-of-world origin fallback, no reading
// the quotation's GST HSN as a customs heading, no reading the supplier's
// address as an origin. Each is a real customs concept needing evidence this
// system does not record; each would turn a missing fact into a confident
// wrong number.
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
const dutyPolicy = require("../../services/centralCosting/dutyPolicy.service");

let server, base, rs, seq = 0;
const KEY = "DUTY_POLICY";

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "board_duty" });
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
  const email = `dt${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "D", lastName: `T${n}`, email, biometricId: `DT${n}`,
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
    token: jwt.sign(
      { id: String(emp._id), email, name: `Board ${n}`, role: "employee", isAdmin, employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

const RULE = (over = {}) => ({
  customsTariffCode: "6204.42", countryOfOrigin: "CN", ratePercent: "10",
  effectiveFrom: "2026-01-01", ...over,
});

const startDraft = (me, co, body = {}) =>
  call(`/${KEY}/drafts`, { method: "POST", token: me.token, company: co._id, body });
const writeDraft = (me, co, id, revision, dutyRules) =>
  call(`/${KEY}/drafts/${id}`, {
    method: "PUT", token: me.token, company: co._id, body: { revision, dutyRules },
  });
const approveDraft = (me, co, id, effectiveFrom) =>
  call(`/${KEY}/drafts/${id}/approve`, {
    method: "POST", token: me.token, company: co._id, body: { effectiveFrom },
  });

async function publish(me, co, dutyRules, { effectiveFrom = "2026-04-01", seedFrom = null } = {}) {
  const started = await startDraft(me, co, { ...(seedFrom ? { seedFrom } : {}), rationale: "Board minute." });
  if (started.status !== 201) return started;
  const v = started.body.version;
  if (dutyRules !== undefined) {
    const saved = await writeDraft(me, co, v._id, v.revision, dutyRules);
    if (saved.status !== 200) return saved;
  }
  return approveDraft(me, co, v._id, effectiveFrom);
}

const read = (me, co) => call(`/${KEY}`, { token: me.token, company: co._id });
const effectiveRules = (res) => {
  const v = (res.body.versions || []).find((x) => String(x._id) === String(res.body.effectiveId));
  return v ? (v.dutyRules || []) : [];
};

/* ═══ 1 · NOTHING BY DEFAULT, AND MISSING IS NOT ZERO ═════════════════════ */

describe("a company starts with no duty table", () => {
  test("nothing is seeded, and no rate is invented", async () => {
    const co = await company("Fresh");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const r = await read(me, co);
    expect(r.status).toBe(200);
    expect(r.body.versions).toEqual([]);
  });

  test("with no policy an imported line is BLOCKED, not duty-free", async () => {
    /* ── THE DISTINCTION THE WHOLE FEATURE RESTS ON ───────────────────
       An unanswered question is not a rate of nil. Charging nothing because
       nobody has decided is the same defect as charging nothing because a
       field was blank. */
    const position = dutyPolicy.positionFor({
      sourcingType: "IMPORTED", countryOfOrigin: "CN",
      customsTariffCode: "6204.42", dutyInQuotedRate: "EXCLUDED",
    }, null);
    expect(position.state).toBe("POLICY_MISSING");
    expect(position.blocking).toBe(true);
    expect(position.owner.department).toBe("Board");
    expect(position.message).toMatch(/not a duty of nil/);
  });

  test("an empty table is a decision the Board may approve", async () => {
    const co = await company("ImportsNothing");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    expect((await publish(me, co, [])).status).toBe(200);
    expect(effectiveRules(await read(me, co))).toEqual([]);
  });
});

/* ═══ 2 · WHAT A RULE MUST STATE ══════════════════════════════════════════ */

describe("what a duty rule must state", () => {
  test("a heading is required", async () => {
    const co = await company("NoHeading");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const started = await startDraft(me, co, {});
    const r = await writeDraft(me, co, started.body.version._id, started.body.version.revision,
      [RULE({ customsTariffCode: "" })]);
    expect(r.status).toBe(400);
    expect(r.body.error.details.reason).toBe("DUTY_RULE_TARIFF_REQUIRED");
  });

  test("origin must be ISO-2, because that is how Store records it", async () => {
    /* A table keyed "China" would never match an offer keyed "CN". */
    const co = await company("BadOrigin");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const started = await startDraft(me, co, {});
    const r = await writeDraft(me, co, started.body.version._id, started.body.version.revision,
      [RULE({ countryOfOrigin: "China" })]);
    expect(r.status).toBe(400);
    expect(r.body.error.details.reason).toBe("DUTY_RULE_ORIGIN_INVALID");
    expect(r.body.error.message).toMatch(/would not match it/);
  });

  test("an explicit 0% is a valid rule; a blank rate is not", async () => {
    const co = await company("ZeroRule");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    expect((await publish(me, co, [RULE({ ratePercent: "0" })])).status).toBe(200);
    expect(effectiveRules(await read(me, co))[0].ratePercent).toBe("0");

    const co2 = await company("BlankRate");
    const me2 = await actor({ companies: [co2], grants: { board: "owner" } });
    const started = await startDraft(me2, co2, {});
    const r = await writeDraft(me2, co2, started.body.version._id, started.body.version.revision,
      [RULE({ ratePercent: "" })]);
    expect(r.status).toBe(400);
  });

  test("a rule with no start date cannot be approved", async () => {
    const co = await company("NoStart");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const started = await startDraft(me, co, {});
    const r = await writeDraft(me, co, started.body.version._id, started.body.version.revision,
      [RULE({ effectiveFrom: "" })]);
    expect(r.status).toBe(400);
    expect(r.body.error.details.reason).toBe("DUTY_RULE_PERIOD_START_REQUIRED");
  });
});

/* ═══ 3 · TWO RULES MAY NOT CLAIM ONE HEADING AT ONE TIME ═════════════════ */

describe("overlapping rules are refused where they are written", () => {
  test("two active rules for one heading and origin that overlap in time", async () => {
    const co = await company("Overlap");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const started = await startDraft(me, co, {});
    const r = await writeDraft(me, co, started.body.version._id, started.body.version.revision, [
      RULE({ effectiveTo: "2026-12-01" }),
      RULE({ effectiveFrom: "2026-10-01", ratePercent: "12" }),
    ]);
    expect(r.status).toBe(400);
    expect(r.body.error.details.reason).toBe("DUTY_RULE_PERIOD_OVERLAP");
    expect(r.body.error.message).toMatch(/could not say which rate it used/);
  });

  test("only the last rule for a pair may be open-ended", async () => {
    const co = await company("OpenEnded");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const started = await startDraft(me, co, {});
    const r = await writeDraft(me, co, started.body.version._id, started.body.version.revision, [
      RULE(), RULE({ effectiveFrom: "2026-10-01", ratePercent: "12" }),
    ]);
    expect(r.status).toBe(400);
    expect(r.body.error.details.reason).toBe("DUTY_RULE_PERIOD_OPEN_ENDED");
  });

  test("periods that meet exactly are accepted — the window is half-open", async () => {
    const co = await company("Consecutive");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const r = await publish(me, co, [
      RULE({ effectiveTo: "2026-10-01" }),
      RULE({ effectiveFrom: "2026-10-01", ratePercent: "12" }),
    ]);
    expect(r.status).toBe(200);
    expect(effectiveRules(await read(me, co))).toHaveLength(2);
  });

  test("the same heading from a DIFFERENT origin is not a clash", async () => {
    /* Which is the whole point of keying on both. */
    const co = await company("TwoOrigins");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    expect((await publish(me, co, [RULE(), RULE({ countryOfOrigin: "BD", ratePercent: "5" })])).status).toBe(200);
  });

  test("a withdrawn rule matches nothing, so it cannot collide", async () => {
    const co = await company("WithdrawnNoClash");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    expect((await publish(me, co, [
      RULE({ active: false }), RULE({ ratePercent: "12" }),
    ])).status).toBe(200);
  });
});

/* ═══ 4 · MATCHING IS EXACT, AND NOTHING IS INFERRED ══════════════════════ */

describe("resolution matches exactly", () => {
  const table = [{
    key: "r1", customsTariffCode: "6204.42", countryOfOrigin: "CN",
    ratePercent: "10", effectiveFrom: new Date("2026-01-01"), active: true,
  }];
  const policy = { _id: "p1", dutyRules: table };
  const ev = (o = {}) => ({
    sourcingType: "IMPORTED", countryOfOrigin: "CN",
    customsTariffCode: "6204.42", dutyInQuotedRate: "EXCLUDED", ...o,
  });
  const at = new Date("2026-06-01");

  test("an exact heading-and-origin match applies", () => {
    const p = dutyPolicy.positionFor(ev(), policy, { asOf: at });
    expect(p.state).toBe("APPLIED");
    expect(p.ratePercent).toBe("10");
    expect(p.rule.key).toBe("r1");
  });

  test("a DIFFERENT heading does not match — no prefix or category inference", () => {
    /* 6204.43 is a neighbouring heading. A prefix match would silently duty a
       different garment at this rate. */
    expect(dutyPolicy.positionFor(ev({ customsTariffCode: "6204.43" }), policy, { asOf: at }).state)
      .toBe("NO_MATCHING_RULE");
    expect(dutyPolicy.positionFor(ev({ customsTariffCode: "6204" }), policy, { asOf: at }).state)
      .toBe("NO_MATCHING_RULE");
  });

  test("a DIFFERENT origin does not match — there is no rest-of-world fallback", () => {
    expect(dutyPolicy.positionFor(ev({ countryOfOrigin: "BD" }), policy, { asOf: at }).state)
      .toBe("NO_MATCHING_RULE");
  });

  test("two matching rules block as ambiguous rather than picking one", () => {
    /* The write-time check should make this impossible; this is the second
       guard, because a table written before it existed could still hold one —
       and picking one silently would make the costing unexplainable. */
    const ambiguous = { _id: "p", dutyRules: [
      { ...table[0], key: "a" },
      { ...table[0], key: "b", ratePercent: "12", effectiveFrom: new Date("2026-03-01") },
    ] };
    const p = dutyPolicy.positionFor(ev(), ambiguous, { asOf: at });
    expect(p.state).toBe("AMBIGUOUS_RULES");
    expect(p.blocking).toBe(true);
    expect(p.candidateKeys.sort()).toEqual(["a", "b"]);
  });

  test("an inactive rule matches nothing", () => {
    const off = { _id: "p", dutyRules: [{ ...table[0], active: false }] };
    expect(dutyPolicy.positionFor(ev(), off, { asOf: at }).state).toBe("NO_MATCHING_RULE");
  });

  test("a rule not yet in force, or already ended, does not match", () => {
    expect(dutyPolicy.positionFor(ev(), policy, { asOf: new Date("2025-06-01") }).state)
      .toBe("NO_MATCHING_RULE");
    const ended = { _id: "p", dutyRules: [{ ...table[0], effectiveTo: new Date("2026-03-01") }] };
    expect(dutyPolicy.positionFor(ev(), ended, { asOf: at }).state).toBe("NO_MATCHING_RULE");
    /* Half-open: the end date itself is already outside. */
    expect(dutyPolicy.positionFor(ev(), ended, { asOf: new Date("2026-03-01") }).state)
      .toBe("NO_MATCHING_RULE");
  });

  test("an explicit 0% rule is its own state, distinct from no rule", () => {
    const zero = { _id: "p", dutyRules: [{ ...table[0], ratePercent: "0" }] };
    const p = dutyPolicy.positionFor(ev(), zero, { asOf: at });
    expect(p.state).toBe("ZERO_RATED");
    expect(p.blocking).toBe(false);
    expect(p.rule.key).toBe("r1");
    expect(p.state).not.toBe(dutyPolicy.STATE.NO_MATCHING_RULE);
  });
});

/* ═══ 5 · THE LIFECYCLE ═══════════════════════════════════════════════════ */

describe("draft, approval and effective dating", () => {
  test("an approved table cannot be edited; a change is a new version", async () => {
    const co = await company("Immutable");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const started = await startDraft(me, co, { rationale: "First." });
    await writeDraft(me, co, started.body.version._id, started.body.version.revision, [RULE()]);
    await approveDraft(me, co, started.body.version._id, "2026-04-01");
    const r = await writeDraft(me, co, started.body.version._id, 2, [RULE({ ratePercent: "15" })]);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("BOARD_POLICY_IMMUTABLE");
  });

  test("a future table does not apply before its date, and does after", async () => {
    const co = await company("Future");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await publish(me, co, [RULE()], { effectiveFrom: "2026-04-01" });
    /* Amending the rate keeps the rule's KEY: a rule with no key would mint a
       second identity for the same heading and origin, and the old one would
       then be missing — which the table refuses. */
    const [first] = effectiveRules(await read(me, co));
    expect((await publish(me, co, [{ ...RULE({ ratePercent: "15" }), key: first.key }],
      { effectiveFrom: "2026-10-01", seedFrom: "EFFECTIVE_VERSION" })).status).toBe(200);

    const before = await dutyPolicy.resolveFor({ companyId: co._id }, { asOf: new Date("2026-09-30") });
    const after = await dutyPolicy.resolveFor({ companyId: co._id }, { asOf: new Date("2026-10-01") });
    expect(before.rules[0].ratePercent).toBe("10");
    expect(after.rules[0].ratePercent).toBe("15");
  });

  test("two approvals cannot share an effective date", async () => {
    const co = await company("SameDate");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    expect((await publish(me, co, [RULE()], { effectiveFrom: "2026-04-01" })).status).toBe(200);
    const clash = await publish(me, co, [RULE({ ratePercent: "12" })], { effectiveFrom: "2026-04-01" });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe("BOARD_POLICY_EFFECTIVE_DATE_TAKEN");
  });

  test("a later table supersedes by date, and both stay readable as approved", async () => {
    const co = await company("Superseding");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await publish(me, co, [RULE()], { effectiveFrom: "2026-04-01" });
    const stored = effectiveRules(await read(me, co));
    await publish(me, co, [{ ...RULE({ ratePercent: "15" }), key: stored[0].key }],
      { effectiveFrom: "2026-07-01", seedFrom: "EFFECTIVE_VERSION" });
    const hist = await read(me, co);
    expect(hist.body.versions.filter((v) => v.status === "BOARD_APPROVED")).toHaveLength(2);
    expect(effectiveRules(hist)[0].ratePercent).toBe("15");
  });

  test("dropping a key from a SEEDED draft is refused at the write", async () => {
    const co = await company("KeyPermanenceDraft");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await publish(me, co, [RULE(), RULE({ countryOfOrigin: "BD", ratePercent: "5" })]);
    const stored = effectiveRules(await read(me, co));

    const started = await startDraft(me, co, { seedFrom: "EFFECTIVE_VERSION" });
    const r = await writeDraft(me, co, started.body.version._id, started.body.version.revision,
      [{ ...RULE(), key: stored[0].key }]);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("DUTY_RULE_KEY_REMOVED");
    expect(r.body.error.details.remedy).toBe("DEACTIVATE");
  });

  test("and a version written from scratch cannot supersede one that has more", async () => {
    /* ── THE HOLE A DRAFT-ONLY CHECK WOULD LEAVE ──────────────────────
       A draft started empty has nothing to remove, so "nothing was removed
       from this draft" is trivially true of it. The removal that matters is
       against what the company actually has IN FORCE, so it is checked at the
       act that puts a table in force. */
    const co = await company("KeyPermanenceSupersede");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await publish(me, co, [RULE(), RULE({ countryOfOrigin: "BD", ratePercent: "5" })]);

    const started = await startDraft(me, co, {});
    await writeDraft(me, co, started.body.version._id, started.body.version.revision,
      [RULE({ customsTariffCode: "6109.10" })]);
    const r = await approveDraft(me, co, started.body.version._id, "2026-07-01");
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("DUTY_RULE_KEY_REMOVED");
    /* And what is in force is untouched — the refusal is not a partial act. */
    expect(effectiveRules(await read(me, co))).toHaveLength(2);
  });
});

/* ═══ 6 · THE BOUNDARY ════════════════════════════════════════════════════ */

describe("who may set a duty rate", () => {
  test("an administrator with no Board grant reaches nothing", async () => {
    const co = await company("AdminOnly");
    const admin = await actor({ companies: [co], isAdmin: true });
    const r = await read(admin, co);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("BOARD_ACCESS_REQUIRED");
  });

  test("another company's duty table is not this company's", async () => {
    const mine = await company("Mine");
    const theirs = await company("Theirs");
    const me = await actor({ companies: [mine], grants: { board: "owner" } });
    const them = await actor({ companies: [theirs], grants: { board: "owner" } });
    await publish(them, theirs, [RULE()]);
    expect(effectiveRules(await read(me, mine))).toHaveLength(0);
    expect((await dutyPolicy.resolveFor({ companyId: mine._id })).rules).toHaveLength(0);
  });
});

/* ═══ 7 · THE OTHER SEVEN ARE UNCHANGED ═══════════════════════════════════ */

test("adding an eighth policy changed nothing about the first seven", async () => {
  const co = await company("Keys");
  const me = await actor({ companies: [co], grants: { board: "owner" } });
  const r = await call("/vocabulary", { token: me.token, company: co._id });
  expect(r.body.policyKeys).toEqual([
    "FINANCING", "OVERHEAD", "LABOUR_METHODOLOGY", "GST_TAX_POLICY",
    "DEVELOPMENT_CHARGE_POLICY", "CONTINGENCY_POLICY", "MARGIN_POLICY", "DUTY_POLICY",
  ]);
  for (const key of r.body.policyKeys) {
    expect((await call(`/${key}`, { token: me.token, company: co._id })).status).toBe(200);
  }
});
