// test/costing/costing-development-rates.test.js
//
// THE COMPANY'S OWN CHARGES, OVER TIME AND PER UNIT.
//
// ── THE TWO DEFECTS PINNED HERE ─────────────────────────────────────────────
//
// 1. THE TABLE COULD NOT HOLD TWO RATES. One amount per key, and publishing a
//    new one REPLACED it — so the September charge stopped existing the moment
//    October's was published, and a September costing could not be recalculated
//    at the figure it was actually costed at. An effective-dated table that
//    cannot hold two periods has one date on it.
//
// 2. EVERY CHARGE WAS FLAT. Pattern development is ₹10,000 for the run. Screen
//    making is ₹2,000 A SCREEN, and a garment needing four is ₹8,000 — once.
//    Without the distinction, Finance had to publish a "four screens" charge
//    (a rate that lies about what it is) or somebody had to type ₹8,000 into
//    the costing, which is the thing this family exists to stop.
//
// ── WHERE EACH THING IS PROVED ──────────────────────────────────────────────
// A costing's `asOf` is the moment it is calculated, deliberately: a
// client-supplied date would let somebody backdate a costing onto a cheaper
// rate. So the DATE algebra is proved against the assembly with explicit
// dates, and the MONEY is proved through the real routes with the periods
// arranged around today.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

/* The R&D charge-type route is mounted here too, so what Finance publishes and
   what R&D is shown can be compared in one place — the visibility boundary is
   only meaningful as a difference between two real responses. Costing routes
   authenticate through EmployeeAuthMiddlewear and are untouched by this. */
jest.mock("../../Middlewear/SalesAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ success: false, message: "Authentication required." });
    req.user = JSON.parse(raw);
    next();
  };
  mw.withRoles = () => mw;
  mw.RND_ROLES = [];
  return mw;
});

const Employee = require("../../models/Employee");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const AccessDepartment = require("../../models/Access/AccessDepartment");
const CostingPolicy = require("../../models/CMS_Models/Costing/CostingPolicy");

const charges = require("../../services/centralCosting/developmentCharges");
const { applyDevelopmentCharges } = require("../../services/centralCosting/assembly.service");
const { seedSourceBacked, configureProduction, prepareForCosting } = require("./helpers/sourceBacked");

let server, base, root, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/costings", require("../../routes/CMS_Routes/Costing/costings"));
  app.use("/api/cms/crm/sample-styles", require("../../routes/CMS_Routes/Sales/sampleStyles"));
  /* ── AND THE BOARD, BECAUSE THAT IS WHERE CHARGES ARE PUBLISHED NOW ──
     The catalogue is a Board policy with an effective date and an approver.
     Mounted beside the costing routes so what the Board approves, what a
     costing calculates and what R&D is shown can be compared in one place. */
  app.use("/api/cms/board/policies", require("../../routes/CMS_Routes/Board/policies"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/costings`;
  root = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (path, { method = "GET", body, token, idempotencyKey, company } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const POLICY = {
  baseCurrency: "INR", roundingMode: "HALF_UP", sellingPriceIncrementMinor: 100,
};
const THREE = [
  { key: "q100", label: "100", quantity: "100", isPrimary: true },
  { key: "q500", label: "500", quantity: "500" },
  { key: "q1000", label: "1000", quantity: "1000" },
];

/** ₹10,000 and ₹12,000, in the integer minor units everything here speaks. */
const TEN_K = 1000000;
const TWELVE_K = 1200000;
/** ₹2,000 a screen. */
const PER_SCREEN = 200000;

/* Today is what a costing is calculated at, so periods are arranged around it
   rather than around a date typed into a test. */
const DAY = 86400000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const daysFromNow = (n) => iso(Date.now() + n * DAY);

async function company() {
  const co = await Acc_Company.create({ companyName: `Rates ${++seq}`, booksFromDate: new Date("2026-04-01") });
  const n = ++seq;
  const email = `rates-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "A", lastName: `L${n}`, email, biometricId: `RT${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "Admin", email, passwordHash: "x", isAdmin: true, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "A" });
  /* ── AND AN EXPLICIT BOARD GRANT — BOTH HALVES OF IT ──────────────────
     The catalogue is approved on the Board application, which does NOT wave an
     administrator through. Being an admin of the costing module is not being on
     the Board, and a fixture that relied on the admin flag would be testing a
     door that does not exist.

     Board access is the `board` DEPARTMENT on the employee record AND an active
     `board` role — see `services/board/boardAccess.js`. Access Control writes
     both; so does this. */
  const boardDept = await AccessDepartment.findOneAndUpdate(
    { slug: "board" },
    { $setOnInsert: { slug: "board", key: "board", name: "Board", dashboardPath: "/board" } },
    { upsert: true, new: true },
  ).lean();
  await Employee.updateOne(
    { _id: emp._id }, { $addToSet: { additionalDepartmentIds: boardDept._id } },
  );
  await DepartmentRole.create({
    departmentSlug: "board", email, name: "A", role: "approver", isActive: true,
    departmentId: boardDept._id,
  });
  const token = jwt.sign(
    { id: String(emp._id), email, name: "A", role: "employee", employeeId: emp.biometricId },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
  );
  expect((await call("/policy/current", { method: "PUT", token, company: co._id, body: { ...POLICY, revision: 0 } })).status).toBe(200);
  /* The same person, seen by the R&D routes — the charge-type list is scoped
     to the company they are actually a member of. */
  return { co, token, emp, rnd: JSON.stringify({ id: String(emp._id), name: "A", role: "sales" }) };
}

/* ── PUBLISHING IS AN APPROVAL NOW ────────────────────────────────────────
   A charge is not saved, it is approved, from a date, by a named person. So
   every "publish" here is the whole act: start a draft (seeded from whatever
   is in force, which is how the Board amends a catalogue without retyping
   it), write the charges into it, approve it from a date.

   The dates step BACKWARDS from a year ago rather than forwards from today,
   so each new catalogue is the latest one already in force — a costing run
   now resolves it — while never colliding with the date of the one before. */
const boardCall = (w, path, { method = "GET", body } = {}) =>
  fetch(`${root}/api/cms/board/policies${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${w.token}`,
      "X-Costing-Company": String(w.co._id),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const KEY = "DEVELOPMENT_CHARGE_POLICY";
const YEAR = 365 * DAY;
let approvals = 0;

async function publish(w, developmentCharges, { seed = "EFFECTIVE_VERSION", effectiveFrom = null } = {}) {
  const started = await boardCall(w, `/${KEY}/drafts`, {
    method: "POST", body: { seedFrom: seed },
  });
  if (started.status !== 201) return started;
  const id = started.body.version._id;
  const seeded = (started.body.version.developmentCharges || []).length > 0;
  /* ── A FIRST PUBLICATION CANNOT NAME ITS OWN KEYS ─────────────────
     The server mints a key from the label and refuses one the draft does not
     already hold, so a client cannot give a charge a second identity. The
     fixtures below carry keys because the PURE resolution tests need them,
     so they are dropped on the way in when nothing is in force yet and kept
     when amending a catalogue that already has them. */
  const fresh = !seeded;
  const saved = await boardCall(w, `/${KEY}/drafts/${id}`, {
    method: "PUT",
    body: {
      revision: started.body.version.revision,
      developmentCharges: fresh
        ? developmentCharges.map(({ key, ...rest }) => rest)
        : developmentCharges,
    },
  });
  if (saved.status !== 200) return saved;
  /* Each approval a day later than the last, and all of them in the past, so
     the newest is the one in force. */
  const when = effectiveFrom || iso(Date.now() - YEAR + (approvals += 1) * DAY);
  return boardCall(w, `/${KEY}/drafts/${id}/approve`, { method: "POST", body: { effectiveFrom: when } });
}

/** The catalogue in force, as the Board reads it back. */
const readBoard = (w) => boardCall(w, `/${KEY}`);
const inForce = (res) => {
  const v = (res.body.versions || []).find((x) => String(x._id) === String(res.body.effectiveId));
  return v ? (v.developmentCharges || []) : [];
};

const readPolicy = (w) => call("/policy/current", { token: w.token, company: w.co._id });

async function costingFor(w, development) {
  const seeded = await seedSourceBacked(w.co._id, { withMaterial: false, development });
  await configureProduction(w.co._id);
  const made = await call("/", {
    method: "POST", token: w.token, company: w.co._id,
    idempotencyKey: `k-${++seq}-${Math.random().toString(36).slice(2)}`,
    body: { context: seeded.context },
  });
  expect(made.status).toBe(201);
  return { ...w, seeded, costingId: made.body.costing.id };
}

/* ── THE RUN SIZES ARE THE SALES COSTING BRIEF'S ───────────────────────────
 * They travelled on this body. What quantities the customer wants priced is a
 * commercial decision Sales confirms on the enquiry, and the costing reads it
 * — so `calc` writes them where Sales writes them and posts only the lines.
 * Every test below keeps its own quantities and its own intent; what changed
 * is the record they are stated in. */
const writeBriefQuantities = async (w, scenarios) => {
  const enquiry = await Enquiry.findById(w.seeded.enquiry._id);
  enquiry.costingBriefs[0].quantities = (scenarios || []).map((sc, i) => ({
    key: String(sc.key || `q${i + 1}`),
    label: String(sc.label || sc.key || `q${i + 1}`),
    quantity: String(sc.quantity),
    isPrimary: sc.isPrimary === true || (scenarios.length === 1 && i === 0),
    ...(sc.proposedSellingPriceExclTax
      ? {
        proposedSellingPriceExclTax: String(
          sc.proposedSellingPriceExclTax.amountMinor !== undefined
            ? Number(sc.proposedSellingPriceExclTax.amountMinor) / 100
            : sc.proposedSellingPriceExclTax,
        ),
      }
      : {}),
  }));
  if (!enquiry.costingBriefs[0].quantities.some((q) => q.isPrimary)) {
    enquiry.costingBriefs[0].quantities[0].isPrimary = true;
  }
  enquiry.markModified("costingBriefs");
  await enquiry.save();
};

/* ── PREPARED THE WAY SALES DOES ──────────────────────────────────────────
   `POST /:id/versions` was the Calculate button and refuses a browser client
   now (`COSTING_PREPARATION_MOVED_TO_SALES`). What these tests prove is about
   the ENGINE, which is unchanged — the orchestration resolves the brief and
   the sources and calls it. A call carrying a BODY still goes to the retired
   door on purpose: those tests are about the payload contract, and its
   refusal is the contract now. */
const calc = async (w, scenarios = THREE) => {
  await writeBriefQuantities(w, scenarios);
  return prepareForCosting(w.costingId, {
  actionKey: `v-${++seq}-${Math.random().toString(36).slice(2)}`,
});
};

const scenarioOf = (v, key) => v.cost.scenarios.find((s) => s.key === key);
const setupIn = (v, key) => scenarioOf(v, key).categorySubtotals.find((c) => c.category === "FIXED_SETUP");
const provenanceFor = (v, lineKey) => (v.cost.policyProvenance || []).find((p) => p.lineKey === lineKey) || null;

/** A definition with two consecutive periods, as Finance would publish them. */
const TWO_PERIODS = (from, boundary) => [{
  key: "pattern", label: "Pattern development", calculation: "FLAT_PER_RUN", active: true,
  rates: [
    { amountMinor: TEN_K, currency: "INR", effectiveFrom: from, effectiveTo: boundary },
    { amountMinor: TWELVE_K, currency: "INR", effectiveFrom: boundary, effectiveTo: null },
  ],
}];

/** The one internal line the assembly is asked to price. */
const devLine = (over = {}) => ({
  lineKey: "dev:dev:row-1", category: "FIXED_SETUP", behaviour: "FIXED_PER_RUN",
  label: "pattern", developmentSource: "COMPANY_POLICY", developmentChargeKey: "pattern",
  technicalKey: "dev:row-1", technicalEvidence: "SAMPLE_MEASURED",
  ...over,
});

/* ═══ 1 · A RATE HAS A LIFETIME, AND THE OLD ONE SURVIVES ═════════════════ */

describe("the charge table holds a history, not a current value", () => {
  const DEFS = TWO_PERIODS("2026-04-01", "2026-10-01");

  test("pattern costs ₹10,000 before October and ₹12,000 from October", async () => {
    /* ── THE DEFECT, IN ONE ASSERTION ─────────────────────────────────
       The same table, the same key, two dates, two answers. Before this it
       had one amount, so both of these were whichever one Finance had
       published most recently. */
    const before = applyDevelopmentCharges([devLine()], {
      policy: { developmentCharges: DEFS }, asOf: new Date("2026-09-30"),
    });
    expect(before.missing).toHaveLength(0);
    expect(before.lines[0].amount.amountMinor).toBe(TEN_K);

    const after = applyDevelopmentCharges([devLine()], {
      policy: { developmentCharges: DEFS }, asOf: new Date("2026-10-15"),
    });
    expect(after.lines[0].amount.amountMinor).toBe(TWELVE_K);
  });

  test("publishing October's rate does not remove April's", async () => {
    const w = await company();
    /* Finance publishes the first period, then adds the second — an edit of
       the whole table, which is how the policy screen sends it. */
    expect((await publish(w, [{
      label: "Pattern development", calculation: "FLAT_PER_RUN",
      rates: [{ amountMinor: TEN_K, currency: "INR", effectiveFrom: "2026-04-01" }],
    }])).status).toBe(200);
    /* The amendment names the key the first approval minted — a new one would
       be a second charge, not a second rate for this one. */
    const [first] = inForce(await readBoard(w));
    expect((await publish(w, [{ ...DEFS[0], key: first.key }])).status).toBe(200);

    const stored = inForce(await readBoard(w));
    expect(stored).toHaveLength(1);
    expect(stored[0].key).toBe(first.key);
    /* Both periods, in order, with April's window closed rather than
       overwritten. */
    expect(stored[0].rates.map((r) => r.amountMinor)).toEqual([TEN_K, TWELVE_K]);
    expect(stored[0].rates[0].effectiveTo).toBeTruthy();
    /* The last period is left OPEN — omitted, never stamped with an invented
       expiry that would silently stop a charge nobody withdrew. */
    expect(stored[0].rates[1].effectiveTo).toBeFalsy();
  });

  test("a boundary date belongs to exactly one period", async () => {
    /* ── HALF-OPEN, [from, to) ────────────────────────────────────────
       A period ending on the 1st and one starting on the 1st must not both
       apply on the 1st. Closed intervals make that ambiguity invisible: two
       rates match and the first one found wins, which depends on the order
       somebody typed them in. */
    const def = charges.adaptCharge(DEFS[0]);
    for (const [when, amount] of [
      ["2026-09-30T23:59:59.999Z", TEN_K],
      ["2026-10-01T00:00:00.000Z", TWELVE_K],
      ["2026-10-01T12:00:00.000Z", TWELVE_K],
    ]) {
      const { period, reason } = charges.selectPeriod(def, new Date(when));
      expect(reason).toBeNull();
      expect(period.amountMinor).toBe(amount);
    }
    /* And before the table begins there is no rate at all — not the nearest
       one, and certainly not zero. */
    expect(charges.selectPeriod(def, new Date("2026-03-31")).reason).toBe(charges.REASON.NO_PERIOD);
  });

  test("a date with no rate blocks the costing and names the date", async () => {
    const out = applyDevelopmentCharges([devLine()], {
      policy: { developmentCharges: DEFS }, asOf: new Date("2026-01-01"),
    });
    expect(out.lines[0].amount).toBeUndefined();
    expect(out.missing[0]).toMatchObject({ blocking: true, lineKey: "dev:dev:row-1" });
    expect(out.missing[0].message).toMatch(/No rate for the "Pattern development" development charge was in force on 2026-01-01/);
    /* The BOARD's, not Finance's: what the company charges for its own
       development work is approved, not configured, so the desk that can close
       this gap is the one that can approve a rate for that date. */
    expect(out.missing[0].owner.department).toBe("Board");
  });

  test("two rates on one day is a contradiction, not a choice", async () => {
    /* Validation refuses this, so it can only arrive from data written
       around it. It is still not resolved by picking one: "which rate did
       this costing use" would have no answer. */
    const overlapping = charges.adaptCharge({
      key: "pattern", label: "Pattern development",
      rates: [
        { amountMinor: TEN_K, effectiveFrom: "2026-04-01", effectiveTo: "2026-12-01" },
        { amountMinor: TWELVE_K, effectiveFrom: "2026-10-01" },
      ],
    });
    expect(charges.selectPeriod(overlapping, new Date("2026-11-01")).reason).toBe(charges.REASON.AMBIGUOUS);

    const out = applyDevelopmentCharges([devLine()], {
      policy: { developmentCharges: [overlapping] }, asOf: new Date("2026-11-01"),
    });
    expect(out.lines[0].amount).toBeUndefined();
    expect(out.missing[0].message).toMatch(/Two rates .* apply on 2026-11-01, so this costing cannot say which one it used/);
  });
});

/* ═══ 2 · WHAT THE POLICY REFUSES TO STORE ════════════════════════════════ */

describe("a table that could not be resolved is refused where it is written", () => {
  test("overlapping periods are refused, naming the one they collide with", async () => {
    const w = await company();
    const r = await publish(w, [{
      key: "pattern", label: "Pattern development",
      rates: [
        { amountMinor: TEN_K, currency: "INR", effectiveFrom: "2026-04-01", effectiveTo: "2026-12-01" },
        { amountMinor: TWELVE_K, currency: "INR", effectiveFrom: "2026-10-01" },
      ],
    }]);
    expect(r.status).toBe(400);
    expect(r.body.error.details.reason).toBe("DEVELOPMENT_CHARGE_PERIOD_OVERLAP");
    expect(r.body.error.message).toMatch(/apply at the same time/);
  });

  test("only the last period may be open-ended", async () => {
    const w = await company();
    const r = await publish(w, [{
      key: "pattern", label: "Pattern development",
      rates: [
        { amountMinor: TEN_K, currency: "INR", effectiveFrom: "2026-04-01" },
        { amountMinor: TWELVE_K, currency: "INR", effectiveFrom: "2026-10-01" },
      ],
    }]);
    expect(r.status).toBe(400);
    expect(r.body.error.details.reason).toBe("DEVELOPMENT_CHARGE_PERIOD_OPEN_ENDED");
    expect(r.body.error.message).toMatch(/Close it on the date the next one starts/);
  });

  test("a rate with no start date is refused", async () => {
    const w = await company();
    const r = await publish(w, [{
      key: "pattern", label: "Pattern development",
      rates: [{ amountMinor: TEN_K, currency: "INR" }],
    }]);
    expect(r.status).toBe(400);
    expect(r.body.error.details.reason).toBe("DEVELOPMENT_CHARGE_PERIOD_START_REQUIRED");
  });

  test("a period that ends before it starts is refused", async () => {
    const w = await company();
    const r = await publish(w, [{
      key: "pattern", label: "Pattern development",
      rates: [{ amountMinor: TEN_K, currency: "INR", effectiveFrom: "2026-10-01", effectiveTo: "2026-04-01" }],
    }]);
    expect(r.status).toBe(400);
    expect(r.body.error.details.reason).toBe("DEVELOPMENT_CHARGE_WINDOW_INVALID");
  });

  test("a foreign currency is refused while nothing holds an exchange rate", async () => {
    /* ── NOT A RESTRICTION FOR ITS OWN SAKE ───────────────────────────
       There is no FX source anywhere in this system. A charge published in
       USD could only reach an INR costing by being guessed at, and a guess
       inside a total is indistinguishable from a fact. */
    const w = await company();
    const r = await publish(w, [{
      key: "pattern", label: "Pattern development",
      rates: [{ amountMinor: TEN_K, currency: "USD", effectiveFrom: "2026-04-01" }],
    }]);
    expect(r.status).toBe(400);
    expect(r.body.error.details.reason).toBe("DEVELOPMENT_CHARGE_CURRENCY_UNSUPPORTED");
    expect(r.body.error.details.expected).toBe("INR");
    expect(r.body.error.message).toMatch(/no exchange rate source/);
  });

  test("a per-unit charge that does not say what a unit is, cannot be approved", async () => {
    /* ── WHERE THIS RULE BITES NOW, AND WHY IT MOVED ──────────────────
       It used to be refused on save, because saving WAS publishing. A Board
       draft is not published — it is a decision being worked out — so a
       half-written charge may be saved and finished later. What cannot happen
       is APPROVING one: a per-unit charge with no unit names a quantity
       nobody can enter, and approving it would put a rate into force that no
       costing could apply. */
    const w = await company();
    const r = await publish(w, [{
      label: "Screen making", calculation: "PER_REQUIREMENT_UNIT",
      rates: [{ amountMinor: PER_SCREEN, currency: "INR", effectiveFrom: "2026-04-01" }],
    }]);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("BOARD_POLICY_INCOMPLETE");
    expect(r.body.error.details.gaps[0].message).toMatch(/a screen, a plate, a pattern/);
    /* And nothing is in force, because nothing was approved. */
    expect(inForce(await readBoard(w))).toHaveLength(0);
  });

  test("consecutive periods that meet exactly are accepted", async () => {
    const w = await company();
    expect((await publish(w, TWO_PERIODS("2026-04-01", "2026-10-01"))).status).toBe(200);
  });
});

/* ═══ 3 · THE FLAT CHARGE THAT WAS ALREADY THERE ══════════════════════════ */

describe("configuration written before rate periods existed", () => {
  test("a flat entry is adapted into one period, not discarded", async () => {
    /* ── THE COMPATIBILITY THIS TURNS ON ──────────────────────────────
       Every company that configured its charges last quarter has rows in the
       flat shape. Reading them as "no rates" would empty their table and
       block every costing that used one. */
    const legacy = charges.adaptCharge({
      key: "pattern", label: "Pattern development",
      amountMinor: TEN_K, currency: "INR", basis: "FIXED_PER_RUN",
      effectiveFrom: "2026-04-01", active: true,
    });
    expect(legacy.calculation).toBe("FLAT_PER_RUN");
    expect(legacy.rates).toEqual([{
      amountMinor: TEN_K, currency: "INR",
      effectiveFrom: new Date("2026-04-01"), effectiveTo: null,
    }]);
    /* Same amount, same window — it always WAS one period. */
    expect(charges.selectPeriod(legacy, new Date("2026-09-30")).period.amountMinor).toBe(TEN_K);
  });

  test("a flat entry with no start date still applies, as it always did", async () => {
    /* Its absence meant "from whenever this was published". Adapting it to
       the epoch says the same thing in a shape a date can be compared
       against, rather than leaving a period nothing can resolve. */
    const legacy = charges.adaptCharge({ key: "old", label: "Old charge", amountMinor: 500000 });
    expect(legacy.rates[0].effectiveFrom.getTime()).toBe(0);
    expect(charges.selectPeriod(legacy, new Date("2026-09-30")).period.amountMinor).toBe(500000);
  });

  test("a flat entry copied out of the retired costing policy is stored as one period", async () => {
    /* ── THE MIGRATION DOOR, AND WHY IT IS THE ONLY ONE ───────────────
       A charge's key is what stored requirements point at, so the Board
       refuses a key it does not already hold — which means a company's
       existing charges cannot be re-typed in without giving every one of them
       a second identity. They are COPIED instead, keys and all, and the copy
       still has to be approved. */
    const w = await company();
    await CostingPolicy.updateOne({ companyId: w.co._id }, {
      $set: {
        revision: 1,
        developmentCharges: [{
          key: "pattern", label: "Pattern development", amountMinor: TEN_K,
          currency: "INR", basis: "FIXED_PER_RUN",
          effectiveFrom: new Date("2026-04-01"), active: true,
        }],
      },
    });

    const offered = await boardCall(w, `/${KEY}/legacy`);
    expect(offered.status).toBe(200);
    expect(offered.body.available).toBe(true);
    expect(offered.body.charges[0].key).toBe("pattern");

    const started = await boardCall(w, `/${KEY}/drafts`, {
      method: "POST", body: { seedFrom: "LEGACY_COSTING_POLICY" },
    });
    expect(started.status).toBe(201);
    /* Copied is not approved — the draft records where its content came from
       and still has to be looked at. */
    expect(started.body.version.status).toBe("DRAFT");
    expect(started.body.version.seededFrom).toBe("LEGACY_COSTING_POLICY");
    const approved = await boardCall(w, `/${KEY}/drafts/${started.body.version._id}/approve`, {
      method: "POST", body: { effectiveFrom: iso(Date.now() - 30 * DAY) },
    });
    expect(approved.status).toBe(200);

    const [stored] = inForce(await readBoard(w));
    /* The key travelled, so every requirement pointing at it still resolves. */
    expect(stored.key).toBe("pattern");
    expect(stored.calculation).toBe("FLAT_PER_RUN");
    expect(stored.rates).toHaveLength(1);
    expect(stored.rates[0].amountMinor).toBe(TEN_K);
    /* And nothing about the old row was invented over: the amount and the
       start date are the ones that were sent. */
    expect(stored.rates[0].effectiveFrom.slice(0, 10)).toBe("2026-04-01");
  });

  test("a copied flat entry still prices a costing", async () => {
    const w = await company();
    await CostingPolicy.updateOne({ companyId: w.co._id }, {
      $set: {
        revision: 1,
        /* Written the way the old code wrote it, straight past validation. */
        developmentCharges: [{
          key: "pattern", label: "Pattern development", amountMinor: TEN_K,
          currency: "INR", basis: "FIXED_PER_RUN",
          effectiveFrom: new Date("2026-04-01"), active: true,
        }],
      },
    });
    /* Copied into a Board version and approved — the amounts are the same
       ones, and now somebody has put their name to them. */
    const started = await boardCall(w, `/${KEY}/drafts`, {
      method: "POST", body: { seedFrom: "LEGACY_COSTING_POLICY" },
    });
    expect(started.status).toBe(201);
    expect((await boardCall(w, `/${KEY}/drafts/${started.body.version._id}/approve`, {
      method: "POST", body: { effectiveFrom: iso(Date.now() - 30 * DAY) },
    })).status).toBe(200);
    const c = await costingFor(w, { internal: true, chargeKey: "pattern", quantity: null });
    const r = await calc(c);
    expect(r.status).toBe(201);
    const v = r.body.versions[0];
    expect(setupIn(v, "q100").totalMinor).toBe(TEN_K);
    /* And its provenance says it was a flat charge, because it was. */
    expect(provenanceFor(v, c.seeded.developmentLineKey)).toMatchObject({
      calculation: "FLAT_PER_RUN", unit: null, quantity: null,
      unitAmountMinor: TEN_K, amountMinor: TEN_K,
    });
  });
});

/* ═══ 4 · FIXED IS NOT THE SAME AS FLAT ═══════════════════════════════════ */

describe("a charge that scales with what the garment needs", () => {
  const SCREENS = [{
    key: "screen", label: "Screen making", calculation: "PER_REQUIREMENT_UNIT",
    unit: "Screen", active: true,
    rates: [{ amountMinor: PER_SCREEN, currency: "INR", effectiveFrom: "2026-01-01" }],
  }];

  test("four screens at ₹2,000 is ₹8,000, once, for the run", async () => {
    const w = await company();
    expect((await publish(w, SCREENS)).status).toBe(200);
    const c = await costingFor(w, { internal: true, chargeKey: "screen-making", quantity: 4, unit: "Screen" });
    const r = await calc(c);
    expect(r.status).toBe(201);
    const v = r.body.versions[0];

    const line = v.cost.inputs.find((l) => l.lineKey === c.seeded.developmentLineKey);
    expect(line.category).toBe("FIXED_SETUP");
    expect(line.behaviour).toBe("FIXED_PER_RUN");
    expect(line.amount.amountMinor).toBe(800000);
    expect(line.confidence).toBe("VERIFIED");
  });

  test("and ₹8,000 becomes ₹80, ₹16 and ₹8 a garment at 100, 500 and 1,000", async () => {
    /* ── THE ARITHMETIC THAT MAKES IT A SETUP COST ────────────────────
       Four screens is four screens whatever the order size. What changes is
       what each garment carries, and that difference is the economy of
       scale a quotation is argued over. */
    const w = await company();
    await publish(w, SCREENS);
    const c = await costingFor(w, { internal: true, chargeKey: "screen-making", quantity: 4, unit: "Screen" });
    const v = (await calc(c)).body.versions[0];

    for (const key of ["q100", "q500", "q1000"]) {
      expect(setupIn(v, key).totalMinor).toBe(800000);
    }
    expect(setupIn(v, "q100").perUnitMinor).toBe(8000);
    expect(setupIn(v, "q500").perUnitMinor).toBe(1600);
    expect(setupIn(v, "q1000").perUnitMinor).toBe(800);
  });

  test("the provenance shows the arithmetic, not only the answer", async () => {
    /* ── ₹8,000 CANNOT BE CHECKED; FOUR AT ₹2,000 CAN ─────────────────
       A total on its own is a figure a reader has to take on trust. Both
       halves and the period they came from make it re-derivable against a
       table whose later revisions did not touch this version. */
    const w = await company();
    await publish(w, SCREENS);
    const c = await costingFor(w, { internal: true, chargeKey: "screen-making", quantity: 4, unit: "Screen" });
    const v = (await calc(c)).body.versions[0];

    expect(provenanceFor(v, c.seeded.developmentLineKey)).toMatchObject({
      state: "COMPANY_POLICY",
      chargeKey: "screen-making",
      chargeLabel: "Screen making",
      calculation: "PER_REQUIREMENT_UNIT",
      unit: "Screen",
      quantity: "4",
      unitAmountMinor: PER_SCREEN,
      amountMinor: 800000,
      currency: "INR",
      basis: "FIXED_PER_RUN",
      evidence: "SAMPLE_MEASURED",
    });
    const prov = provenanceFor(v, c.seeded.developmentLineKey);
    expect(prov.effectiveFrom).toBeTruthy();
    expect(prov.policyRevision).toBeGreaterThan(0);
    /* Which row on which style asked for it. */
    expect(prov.requirementKey).toBe(`dev:${c.seeded.developmentRowIds[0]}`);
  });

  test("a per-unit charge with no quantity blocks, and it is R&D's to answer", async () => {
    /* ── A BLANK IS NOT ONE ───────────────────────────────────────────
       Costing it as a single screen would charge a four-screen garment for
       one, which is a wrong number rather than a missing one. */
    const w = await company();
    await publish(w, SCREENS);
    const c = await costingFor(w, { internal: true, chargeKey: "screen-making", quantity: null });
    const r = await calc(c);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/"Screen making" is charged per Screen, so this requirement has to say how many/);
    /* Finance published the rate; the count is R&D's. */
    expect(r.body.error.details.owner.department).toBe("R&D");
  });

  test("a flat charge asks for no quantity at all, and ignores any it is given", async () => {
    const w = await company();
    await publish(w, [{
      key: "pattern", label: "Pattern development", calculation: "FLAT_PER_RUN",
      rates: [{ amountMinor: TEN_K, currency: "INR", effectiveFrom: "2026-01-01" }],
    }]);
    /* Priced with no quantity on the requirement... */
    const bare = await costingFor(w, { internal: true, chargeKey: "pattern-development", quantity: null });
    expect(setupIn((await calc(bare)).body.versions[0], "q100").totalMinor).toBe(TEN_K);

    /* ...and identically with one, because a flat charge is not a quantity
       of anything and multiplying by a stray 7 would be a sevenfold error. */
    const withQty = await costingFor(w, { internal: true, chargeKey: "pattern-development", quantity: 7 });
    const v = (await calc(withQty)).body.versions[0];
    expect(setupIn(v, "q100").totalMinor).toBe(TEN_K);
    expect(provenanceFor(v, withQty.seeded.developmentLineKey)).toMatchObject({
      calculation: "FLAT_PER_RUN", quantity: null, unitAmountMinor: TEN_K, amountMinor: TEN_K,
    });
  });

  test("the money is decimal-safe, not floating point", async () => {
    /* Three screens at ₹333.33 is ₹999.99 — a figure a float renders as
       999.9900000000001 and rounds the wrong way often enough to matter. */
    const def = charges.adaptCharge({
      key: "plate", label: "Plate making", calculation: "PER_REQUIREMENT_UNIT", unit: "Plate",
      rates: [{ amountMinor: 33333, effectiveFrom: "2026-01-01" }],
    });
    const period = charges.selectPeriod(def, new Date("2026-09-30")).period;
    expect(charges.chargeTotalMinor(def, period, { quantity: 3 }).totalMinor).toBe(99999);
    /* And a fractional count rounds once, at the end, under the company's
       own rounding mode. */
    expect(charges.chargeTotalMinor(def, period, { quantity: "2.5" }).totalMinor).toBe(83333);
  });
});

/* ═══ 5 · TWO REQUIREMENTS, TWO LINES ═════════════════════════════════════ */

test("two requirements using one charge type do not collide", async () => {
  /* ── SCREENS FOR THE BODY, AND SCREENS FOR THE SLEEVE ─────────────────
     Keyed by the charge alone these were ONE line: the second either
     disappeared or doubled the first. Both are wrong, and neither was
     visible — the costing simply showed one row. */
  const w = await company();
  await publish(w, [{
    key: "screen", label: "Screen making", calculation: "PER_REQUIREMENT_UNIT",
    unit: "Screen", rates: [{ amountMinor: PER_SCREEN, currency: "INR", effectiveFrom: "2026-01-01" }],
  }]);
  const c = await costingFor(w, {
    internal: true, chargeKey: "screen-making", quantity: 4, unit: "Screen",
    specification: "Body print, four colours",
    also: { quantity: 2, specification: "Sleeve print, two colours" },
  });
  const r = await calc(c);
  expect(r.status).toBe(201);
  const v = r.body.versions[0];

  const setup = v.cost.inputs.filter((l) => l.category === "FIXED_SETUP");
  expect(setup).toHaveLength(2);
  /* Distinct keys, taken from each row's own identity. */
  expect(new Set(setup.map((l) => l.lineKey)).size).toBe(2);
  expect(setup.map((l) => l.lineKey).sort()).toEqual([...c.seeded.developmentLineKeys].sort());
  /* Four screens and two screens, each priced as itself. */
  expect(setup.map((l) => l.amount.amountMinor).sort((a, b) => a - b)).toEqual([400000, 800000]);
  /* And the run carries both — neither merged away nor counted twice. */
  expect(setupIn(v, "q100").totalMinor).toBe(1200000);
  expect(setupIn(v, "q100").perUnitMinor).toBe(12000);

  /* Both provenance entries, each naming its own requirement row. */
  const keys = (v.cost.policyProvenance || []).map((p) => p.requirementKey);
  expect(new Set(keys).size).toBe(2);
});

/* ═══ 6 · AND WHAT MUST NOT HAVE MOVED ════════════════════════════════════ */

test("adding a later rate period does not re-price a frozen version", async () => {
  const w = await company();
  await publish(w, [{
    key: "pattern", label: "Pattern development", calculation: "FLAT_PER_RUN",
    rates: [{ amountMinor: TEN_K, currency: "INR", effectiveFrom: "2026-01-01" }],
  }]);
  const c = await costingFor(w, { internal: true, chargeKey: "pattern-development", quantity: null });
  const first = await calc(c);
  expect(first.status).toBe(201);
  const versionId = first.body.versions[0].id;

  /* The Board closes the current period and approves the next — the whole
     point of periods, and the moment an old costing is most at risk.

     Named by the key the first approval minted: an amendment that invented a
     key would be a second charge, not a second rate for this one. */
  const [minted] = inForce(await readBoard(w));
  expect((await publish(w, [{
    key: minted.key, label: "Pattern development", calculation: "FLAT_PER_RUN",
    rates: [
      { amountMinor: TEN_K, currency: "INR", effectiveFrom: "2026-01-01", effectiveTo: daysFromNow(1) },
      { amountMinor: TWELVE_K, currency: "INR", effectiveFrom: daysFromNow(1) },
    ],
  }])).status).toBe(200);

  const reread = await call(`/${c.costingId}/versions`, { token: w.token, company: w.co._id });
  const after = reread.body.versions.find((x) => x.id === versionId);
  expect(setupIn(after, "q100").totalMinor).toBe(TEN_K);
  expect(provenanceFor(after, c.seeded.developmentLineKey).amountMinor).toBe(TEN_K);
  /* Still pointing at the period it actually used, which now has an end
     date on it — and that is the period, not a rewritten one. */
  expect(provenanceFor(after, c.seeded.developmentLineKey).effectiveFrom.slice(0, 10)).toBe("2026-01-01");
});

test("today resolves to the period in force today, not the newest one", async () => {
  const w = await company();
  await publish(w, [{
    key: "pattern", label: "Pattern development", calculation: "FLAT_PER_RUN",
    rates: [
      { amountMinor: TEN_K, currency: "INR", effectiveFrom: daysFromNow(-30), effectiveTo: daysFromNow(30) },
      { amountMinor: TWELVE_K, currency: "INR", effectiveFrom: daysFromNow(30) },
    ],
  }]);
  const c = await costingFor(w, { internal: true, chargeKey: "pattern-development", quantity: null });
  const v = (await calc(c)).body.versions[0];
  /* The future rate exists and is not used. */
  expect(setupIn(v, "q100").totalMinor).toBe(TEN_K);
  expect(provenanceFor(v, c.seeded.developmentLineKey).unitAmountMinor).toBe(TEN_K);
});

test("externally quoted setup is untouched by any of this", async () => {
  /* It is priced from a supplier's own dated quotation and reads no charge
     table at all. */
  const w = await company();
  await publish(w, [{
    key: "pattern", label: "Pattern development", calculation: "FLAT_PER_RUN",
    rates: [{ amountMinor: TWELVE_K, currency: "INR", effectiveFrom: "2026-01-01" }],
  }]);
  const c = await costingFor(w, { internal: false, unit: "Lot", quantity: 1, rateMinor: TEN_K });
  const r = await calc(c);
  expect(r.status).toBe(201);
  const v = r.body.versions[0];

  expect(setupIn(v, "q100").totalMinor).toBe(TEN_K);
  expect(setupIn(v, "q1000").perUnitMinor).toBe(1000);
  const line = v.cost.inputs.find((l) => l.lineKey === c.seeded.developmentLineKey);
  expect(line.confidence).toBe("SUPPLIER_QUOTATION");
  /* No policy provenance at all: no charge was read. */
  expect(provenanceFor(v, c.seeded.developmentLineKey)).toBeNull();
  expect((v.cost.offerProvenance || []).find((p) => p.lineKey === c.seeded.developmentLineKey)
    .quotationReference).toMatch(/^QD-SB-/);
});

/* ═══ 7 · THE KEY IS PERMANENT, AND THE SCREEN NEVER ASKS FOR ONE ═════════ */

describe("a charge definition's identity", () => {
  const FLAT = {
    label: "Pattern development", description: "First pattern and marker",
    calculation: "FLAT_PER_RUN", active: true,
    rates: [{ amountMinor: TEN_K, currency: "INR", effectiveFrom: "2026-04-01" }],
  };

  test("a new definition is given its key, because nobody should have to invent one", async () => {
    /* ── AN IDENTITY YOU CANNOT LATER CORRECT ─────────────────────────
       Requirements on styles and the frozen provenance of approved versions
       point at this key. Asking a person to type one is asking them to
       commit to something permanent while naming a form field. */
    const w = await company();
    const r = await publish(w, [FLAT]);
    expect(r.status).toBe(200);

    const [stored] = inForce(await readBoard(w));
    /* Readable, so a person meeting it in stored data or in a provenance
       record recognises which charge it is. */
    expect(stored.key).toBe("pattern-development");
    expect(stored.label).toBe("Pattern development");
    expect(stored.calculation).toBe("FLAT_PER_RUN");
    expect(stored.rates[0].amountMinor).toBe(TEN_K);
  });

  test("a per-unit definition keeps its unit, and cannot be approved without one", async () => {
    const w = await company();
    const bad = await publish(w, [{ label: "Screen making", calculation: "PER_REQUIREMENT_UNIT", rates: FLAT.rates }]);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("BOARD_POLICY_INCOMPLETE");

    expect((await publish(w, [{
      label: "Screen making", calculation: "PER_REQUIREMENT_UNIT", unit: "Screen",
      rates: [{ amountMinor: PER_SCREEN, currency: "INR", effectiveFrom: "2026-04-01" }],
    }])).status).toBe(200);
    const [stored] = inForce(await readBoard(w));
    expect(stored).toMatchObject({ key: "screen-making", calculation: "PER_REQUIREMENT_UNIT", unit: "Screen" });
  });

  test("two definitions with the same name get different keys", async () => {
    const w = await company();
    expect((await publish(w, [FLAT, { ...FLAT, description: "Second one" }])).status).toBe(200);
    const stored = inForce(await readBoard(w));
    expect(stored.map((c) => c.key)).toEqual(["pattern-development", "pattern-development-2"]);
  });

  test("the name may change; the key does not follow it", async () => {
    /* Which is the whole reason they are two fields. A requirement recorded
       last season keeps working after Finance rewords the charge. */
    const w = await company();
    await publish(w, [FLAT]);
    const [before] = inForce(await readBoard(w));

    const renamed = await publish(w, [{ ...FLAT, key: before.key, label: "Pattern and marker development" }]);
    expect(renamed.status).toBe(200);
    const [after] = inForce(await readBoard(w));
    expect(after.key).toBe(before.key);
    expect(after.label).toBe("Pattern and marker development");
  });

  test("a key that disappears from the table is refused, and told what to do instead", async () => {
    /* ── WITHDRAWAL BY OMISSION ───────────────────────────────────────
       The model has always SAID keys are permanent and that inactivation
       replaces deletion. A whole-array write quietly allowed a key to be
       dropped — and every requirement pointing at it became a costing that
       could not be priced, with the record of what it meant gone too. */
    const w = await company();
    await publish(w, [FLAT, { label: "Screen making", calculation: "PER_REQUIREMENT_UNIT", unit: "Screen", rates: FLAT.rates }]);
    const stored = inForce(await readBoard(w));

    const dropped = await publish(w, [{ ...FLAT, key: stored[0].key }]);
    expect(dropped.status).toBe(409);
    expect(dropped.body.error.code).toBe("DEVELOPMENT_CHARGE_KEY_REMOVED");
    expect(dropped.body.error.details.keys).toEqual(["screen-making"]);
    expect(dropped.body.error.details.remedy).toBe("DEACTIVATE");
    expect(dropped.body.error.message).toMatch(/Deactivate it instead/);
    /* And nothing moved: the refusal is not a partial write. */
    expect(inForce(await readBoard(w))).toHaveLength(2);
  });

  test("a key cannot be invented, so renaming one is refused before it can lose the old", async () => {
    /* ── TWO GUARDS, AND THE FIRST ONE CATCHES IT ─────────────────────
       Sending a key the catalogue does not have is refused outright: a client
       that could name its own key could give one charge two identities, and
       requirements pointing at the first would silently stop resolving. The
       second guard — nothing may VANISH — is what the test above proves. */
    const w = await company();
    await publish(w, [FLAT]);
    const r = await publish(w, [{ ...FLAT, key: "something-else" }]);
    expect(r.status).toBe(400);
    expect(r.body.error.details.reason).toBe("DEVELOPMENT_CHARGE_KEY_UNKNOWN");
    expect(r.body.error.details.key).toBe("something-else");
    /* And the catalogue in force is untouched. */
    expect(inForce(await readBoard(w)).map((c) => c.key)).toEqual(["pattern-development"]);
  });

  test("emptying the catalogue is refused, because it deletes every key in it", async () => {
    const w = await company();
    await publish(w, [FLAT]);
    const r = await publish(w, []);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("DEVELOPMENT_CHARGE_KEY_REMOVED");
    expect(inForce(await readBoard(w))).toHaveLength(1);
  });

  test("a draft edited without mentioning the charges keeps them", async () => {
    /* A draft is edited over several sittings — its rationale on one, its
       effective date on another. A save that says nothing about the
       catalogue must not be read as emptying it. `null` is not a list, and
       "not a list" means "not sent". */
    const w = await company();
    await publish(w, [FLAT]);
    const r = await publish(w, null);
    expect(r.status).toBe(200);
    expect(inForce(await readBoard(w))).toHaveLength(1);
  });

  test("the costing policy no longer accepts a charge at all", async () => {
    /* ── WHERE THE OLD WRITER WENT ────────────────────────────────────
       Not removed silently: a stale client that still posts a table is told
       the rule moved, and which policy owns it, rather than being told its
       payload was invalid. Clearing what the company is still carrying is
       still allowed — retiring a display is not authoring policy. */
    const w = await company();
    const r = await call("/policy/current", {
      method: "PUT", token: w.token, company: w.co._id,
      body: { ...POLICY, revision: 1, developmentCharges: [FLAT] },
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("DEVELOPMENT_POLICY_MOVED");
    expect(r.body.error.details.ownedBy).toBe("BOARD");
    expect(r.body.error.details.policyKey).toBe("DEVELOPMENT_CHARGE_POLICY");

    const cleared = await call("/policy/current", {
      method: "PUT", token: w.token, company: w.co._id,
      body: { ...POLICY, revision: 1, developmentCharges: [] },
    });
    expect(cleared.status).toBe(200);
  });

  test("deactivating is allowed, and a frozen costing does not move", async () => {
    const w = await company();
    await publish(w, [FLAT]);
    const [stored] = inForce(await readBoard(w));

    const c = await costingFor(w, { internal: true, chargeKey: stored.key, quantity: null });
    const made = await calc(c);
    expect(made.status).toBe(201);
    const versionId = made.body.versions[0].id;

    /* Withdrawn — kept, and no longer offered. */
    const off = await publish(w, [{ ...FLAT, key: stored.key, active: false }]);
    expect(off.status).toBe(200);
    expect(inForce(await readBoard(w))[0].active).toBe(false);

    const reread = await call(`/${c.costingId}/versions`, { token: w.token, company: w.co._id });
    const after = reread.body.versions.find((x) => x.id === versionId);
    expect(setupIn(after, "q100").totalMinor).toBe(TEN_K);
    expect(provenanceFor(after, c.seeded.developmentLineKey).chargeKey).toBe(stored.key);

    /* And the NEXT costing is blocked rather than quietly using it. */
    const next = await calc(await costingFor(w, { internal: true, chargeKey: stored.key, quantity: null }));
    expect(next.status).toBe(409);
    expect(next.body.error.message).toMatch(/no longer active/);
  });

  test("a stale draft revision changes nothing, including the charges", async () => {
    /* Two directors with the draft open. The second save is composed against
       a draft that has moved, and applying it would erase the first. */
    const w = await company();
    const started = await boardCall(w, `/${KEY}/drafts`, { method: "POST", body: {} });
    const id = started.body.version._id;
    const stale = started.body.version.revision;

    const first = await boardCall(w, `/${KEY}/drafts/${id}`, {
      method: "PUT",
      body: {
        revision: stale,
        developmentCharges: [
          { label: "Pattern development", calculation: "FLAT_PER_RUN", rates: FLAT.rates },
          { label: "Marker making", calculation: "FLAT_PER_RUN", rates: FLAT.rates },
        ],
      },
    });
    expect(first.status).toBe(200);

    const late = await boardCall(w, `/${KEY}/drafts/${id}`, {
      method: "PUT",
      body: {
        revision: stale,
        developmentCharges: [{ label: "Renamed by the loser", calculation: "FLAT_PER_RUN", rates: FLAT.rates }],
      },
    });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("BOARD_POLICY_REVISION_CONFLICT");

    /* The winner's work is intact — both charges, unrenamed. */
    const draft = (await readBoard(w)).body.versions.find((v) => String(v._id) === String(id));
    expect(draft.developmentCharges.map((c) => c.key)).toEqual(["pattern-development", "marker-making"]);
    expect(draft.developmentCharges[0].label).toBe("Pattern development");
  });
});

/* ═══ 8 · WHAT EACH DESK IS SHOWN ═════════════════════════════════════════ */

describe("the visibility boundary around the charge table", () => {
  test("R&D is given the definitions and none of the money", async () => {
    /* ── R&D SAYS WHAT WORK; FINANCE SAYS WHAT IT COSTS ───────────────
       Only the key, the name, the arithmetic and the unit cross this line,
       so nobody here can read the rate, quote it, or reconcile it against a
       figure of their own. */
    const w = await company();
    await publish(w, [
      { label: "Pattern development", calculation: "FLAT_PER_RUN", rates: [{ amountMinor: TEN_K, currency: "INR", effectiveFrom: "2026-04-01" }] },
      { label: "Screen making", calculation: "PER_REQUIREMENT_UNIT", unit: "Screen", rates: [{ amountMinor: PER_SCREEN, currency: "INR", effectiveFrom: "2026-04-01" }] },
    ]);
    const c = await costingFor(w, { internal: true, chargeKey: "pattern-development", quantity: null });

    const res = await fetch(`${root}/api/cms/crm/sample-styles/${c.seeded.styleId}/development-charges`, {
      headers: { "x-test-user": w.rnd },
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.charges).toEqual([
      { key: "pattern-development", label: "Pattern development", description: "", calculation: "FLAT_PER_RUN", unit: null },
      { key: "screen-making", label: "Screen making", description: "", calculation: "PER_REQUIREMENT_UNIT", unit: "Screen" },
    ]);
    /* Said as a whole-response fact, not field by field: no amount, and no
       rate periods to derive one from. */
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/amountMinor|rates|currency|effectiveFrom|1000000|200000/);
  });

  test("a withdrawn charge is not offered to R&D, and its rates are still not shown", async () => {
    const w = await company();
    await publish(w, [{ label: "Pattern development", active: false, rates: [{ amountMinor: TEN_K, currency: "INR", effectiveFrom: "2026-04-01" }] }]);
    const c = await costingFor(w, { internal: true, chargeKey: "pattern-development", quantity: null });
    const res = await fetch(`${root}/api/cms/crm/sample-styles/${c.seeded.styleId}/development-charges`, {
      headers: { "x-test-user": w.rnd },
    });
    const body = await res.json();
    expect(body.charges).toEqual([]);
  });

  test("the Board's own response carries the rates, because that is where they are approved", async () => {
    const w = await company();
    await publish(w, [{ label: "Pattern development", calculation: "FLAT_PER_RUN", rates: [
      { amountMinor: TEN_K, currency: "INR", effectiveFrom: "2026-04-01", effectiveTo: "2026-10-01" },
      { amountMinor: TWELVE_K, currency: "INR", effectiveFrom: "2026-10-01" },
    ] }]);
    const [charge] = inForce(await readBoard(w));
    expect(charge.rates).toHaveLength(2);
    expect(charge.rates.map((r) => r.amountMinor)).toEqual([TEN_K, TWELVE_K]);
    expect(charge.rates[1].effectiveTo).toBeFalsy();

    /* And the costing policy publishes only what this company is still
       CARRYING — nothing here is applied to a costing, and the response says
       so rather than offering an editor the server would refuse. */
    const legacy = await readPolicy(w);
    expect(legacy.body.policy.developmentCharges).toEqual([]);
    expect(legacy.body.policy.developmentPolicy).toMatchObject({
      editable: false, ownedBy: "BOARD", policyKey: "DEVELOPMENT_CHARGE_POLICY",
      boardPolicyInForce: true,
    });
  });
});
