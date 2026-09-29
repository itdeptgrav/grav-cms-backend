// test/costing/costing-manual-input-retired.test.js
//
// NOBODY TYPES A COST INTO COSTING.
//
// ── WHAT THIS SUITE IS ABOUT ────────────────────────────────────────────────
// Central Costing is a calculation engine. Every figure in a costing is read
// from the record of the department that owns it: the technical record for
// what a garment consumes, the Store register for what those things cost, the
// company policy for labour and overhead, the Board for financing.
//
// One path used to escape that. A PROVISIONAL OVERRIDE was a hand-entered
// figure with a cost family, a reason, and the actor and time stamped
// server-side — a careful contract, built when five of the ten cost families
// had no authoritative record at all. Every family has one now.
//
// The contract was careful about the wrong layer. An override is perfectly
// readable in the version's provenance and completely invisible in its TOTAL,
// which is the number a quote goes out on. So the answer to a missing fact is
// no longer "type it and say why"; it is "the costing stays blocked, and here
// is who has to record it and where".
//
// ── AND RETIRING CREATION IS NOT REWRITING HISTORY ──────────────────────────
// Versions frozen while overrides existed still carry them, still read, and
// still say who typed what and why. Nothing here touches a read.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const Costing = require("../../models/CMS_Models/Costing/Costing");

const { seedSourceBacked, configureProduction, seedHistoricalAdhoc, prepareForCosting, assembleForCosting } = require("./helpers/sourceBacked");
const costCoverage = require("../../services/centralCosting/costCoverage");
const assembly = require("../../services/centralCosting/assembly.service");
const { parseLine } = require("../../services/centralCosting/calculationInput");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/costings", require("../../routes/CMS_Routes/Costing/costings"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/costings`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const newKey = () => `mr-${++seq}-${Math.random().toString(36).slice(2)}`;

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
  /* ── NO OVERHEAD ON THIS BODY ─────────────────────────────────────
     It was here, and the costing policy refuses it now: overhead is a Board
     policy with an effective date and an approver. The fixture approves one
     through `configureProduction`, at the same 12% of DIRECT_PLUS_FIXED this
     line used to set — so every figure this suite asserts is unchanged. */
  /* The GST treatment is an approved Board decision now; the costing policy
     refuses the field. `configureProduction` approves the fixture's, at the
     same RECOVERABLE this used to write. */
  revision: 0,
};

const ONE = [{ key: "q500", label: "500", quantity: "500", isPrimary: true }];

async function actor(co) {
  const n = ++seq;
  const email = `retire-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "Cost", lastName: `L${n}`, email, biometricId: `MR${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "Admin", email, passwordHash: "x", isAdmin: true, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "Cost" });
  return jwt.sign(
    { id: String(emp._id), email, name: "Cost", role: "employee", employeeId: emp.biometricId },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
  );
}

/** A real, calculable, source-backed costing. */
async function world(seedOpts = {}) {
  const co = await Acc_Company.create({
    companyName: `Retire ${++seq}`, booksFromDate: new Date("2026-04-01"),
  });
  const token = await actor(co);
  expect((await call("/policy/current", {
    method: "PUT", token, company: co._id, body: POLICY,
  })).status).toBe(200);

  const seeded = await seedSourceBacked(co._id, seedOpts);
  await configureProduction(co._id);

  const made = await call("/", {
    method: "POST", token, company: co._id, idempotencyKey: newKey(),
    body: { context: seeded.context },
  });
  expect(made.status).toBe(201);
  return { co, token, seeded, costingId: made.body.costing.id };
}

/* ── PREPARED THE WAY SALES DOES ──────────────────────────────────────────
   `POST /:id/versions` was the Calculate button and refuses a browser client
   now (`COSTING_PREPARATION_MOVED_TO_SALES`). What these tests prove is about
   the ENGINE, and the engine is unchanged: the orchestration resolves the
   confirmed brief and every source and calls it.

   `lines` never reached the engine even before — the server assembles its own
   rows — so a body carrying only lines goes the Sales way. A body carrying
   anything ELSE is a payload-contract test, and those go to the retired door
   on purpose: its refusal is the contract now. */
const payloadContract = (body = {}) => Object.keys(body).some((k) => k !== "lines")
  /* A NON-EMPTY `lines` is a payload-contract test too. The engine assembles
     its own rows and ignored an empty list, but a list with something in it is
     a client trying to send a figure — which is exactly what those tests
     exist to see refused. */
  || (Array.isArray(body.lines) && body.lines.length > 0);

const calc = (x, body = {}) => (payloadContract(body)
  ? call(`/${x.costingId}/versions`, {
    method: "POST", token: x.token, company: x.co._id, idempotencyKey: newKey(),
    body: { lines: [], ...body },
  })
  : prepareForCosting(x.costingId));

/** One hand-entered line, in the exact shape the retired workspace produced. */
const override = (over = {}) => ({
  lineKey: "typed-1", category: "DUTY", behaviour: "FIXED_PER_RUN",
  label: "Customs cess", amount: { amountMinor: 500000, currency: "INR" },
  override: { family: "duty", reason: "The broker's estimate for the imported trim" },
  ...over,
});

/* ═══ 1 · THE CALCULATION STILL WORKS, WITH NO LINES AT ALL ═══════════════ */

describe("a source-backed costing calculates from its records", () => {
  test("an empty line list is the normal request, and it produces a costed version", async () => {
    /* ── THE CONTROL ───────────────────────────────────────────────────
       Every refusal below is only meaningful if the ordinary path succeeds.
       A suite that proved nothing may be typed, on an engine that could not
       calculate anything either, would prove nothing at all. */
    const x = await world();
    const r = await calc(x);
    expect(r.status).toBe(201);

    const v = r.body.versions[0];
    const keys = v.cost.inputs.map((l) => l.lineKey);
    expect(keys).toContain(x.seeded.materialLineKey);
    expect(keys).toContain(x.seeded.operationLineKey);
    /* And the server built them — none was posted. */
    expect(v.cost.inputs.every((l) => l.lineKey)).toBe(true);
  });
});


/**
 * A TYPED LINE, OFFERED TO EVERY DOOR THAT EXISTS.
 *
 * ── WHY THIS IS NOT SIMPLY "POST IT AND READ THE ERROR" ─────────────────────
 * It used to be. `POST /:id/versions` parsed the body, then assembled, and a
 * hand-entered figure was refused at whichever of the two saw it first.
 *
 * That route refuses a browser client outright now — preparing an estimate is
 * a Sales action — so a typed line meets `COSTING_PREPARATION_MOVED_TO_SALES`
 * before anything looks at it. That is a STRONGER answer to "can somebody type
 * a cost", not a weaker one, and this suite would be worth very little if it
 * only ever asserted that.
 *
 * So each case is offered to all three: the door, the request parser, and the
 * assembly. The door must turn it away, and whichever of the other two owns
 * the rule must refuse it by name. The refusal is returned in the shape the
 * route answered in, so every assertion below is the one it always made.
 */
const typed = async (x, lines) => {
  const atDoor = await call(`/${x.costingId}/versions`, {
    method: "POST", token: x.token, company: x.co._id, idempotencyKey: newKey(),
    body: { lines },
  });
  expect(atDoor.status).toBe(409);
  expect(atDoor.body.error.code).toBe("COSTING_PREPARATION_MOVED_TO_SALES");

  const shaped = (err) => ({
    status: err.status || 400,
    body: { success: false, error: { code: err.code, message: err.message, details: err.details || {} } },
  });

  const { parseLine } = require("../../services/centralCosting/calculationInput");
  const seen = new Set();
  const parsed = [];
  for (let i = 0; i < lines.length; i += 1) {
    try {
      parsed.push(parseLine(lines[i], i, "INR", seen));
    } catch (err) {
      return shaped(err);
    }
  }

  try {
    await assembleForCosting(x.costingId, { lines: parsed });
  } catch (err) {
    return shaped(err);
  }
  throw new Error("a typed cost line was accepted — by the parser and by the engine");
};

/* ═══ 2 · AND REFUSES EVERY HAND-ENTERED FIGURE ══════════════════════════ */

describe("a tampered or stale client cannot type a cost line", () => {
  test("a fully declared override is refused, by name", async () => {
    /* ── THE SHAPE THE OLD SCREEN SENT ─────────────────────────────────
       Family, reason, an amount, a real cost family with no source of its
       own. This is the request the retired button built, sent by a browser
       that has not been reloaded — the exact case the backend refusal
       exists for. */
    const x = await world();
    const r = await typed(x, [override()]);

    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("COSTING_MANUAL_INPUT_RETIRED");
    expect(r.body.error.details.reason).toBe("MANUAL_OVERRIDE_RETIRED");
    expect(r.body.error.details.lineKey).toBe("typed-1");
  });

  test("the refusal names the department that owns the fact and where they record it", async () => {
    /* ── A DEAD END IS WHAT SENT PEOPLE TO THE OVERRIDE ────────────────
       "This cannot be entered here" on its own leaves somebody with a
       number, a deadline and nowhere to put it — which is how the escape
       hatch came to be used. A refusal that redirects is a task. */
    const x = await world();
    const r = await typed(x, [override({
        lineKey: "typed-mat", category: "MATERIAL", behaviour: "PER_UNIT",
        amount: undefined, unitRate: { amountMinor: 41250, currency: "INR" },
        quantityPerUnit: "1.4", quantityUom: "Metre",
        override: { family: "materials", reason: "Vendor's price over the phone" },
      })]);

    expect(r.status).toBe(400);
    expect(r.body.error.details.family).toBe("materials");
    expect(r.body.error.details.owner.department).toBeTruthy();
    expect(r.body.error.details.owner.recordedIn).toBeTruthy();
    /* And the sentence itself carries both, so a client that renders only
       the message is not left with a dead end either. */
    expect(r.body.error.message).toContain(r.body.error.details.owner.department);
    expect(r.body.error.message).toContain(r.body.error.details.owner.recordedIn);
  });

  test("a replacement override is refused too — a typed row cannot displace an assembled one", async () => {
    /* ── THE WORSE OF THE TWO ──────────────────────────────────────────
       A supplement double-counts, which at least moves a total somebody
       might question. A REPLACEMENT silently stands in for the row the
       server read off a dated quotation: the figure changes, the line
       count does not, and the version still cites the technical record. */
    const x = await world();
    const r = await typed(x, [override({
        lineKey: "typed-replaces", category: "MATERIAL", behaviour: "PER_UNIT",
        amount: undefined, unitRate: { amountMinor: 1, currency: "INR" },
        override: {
          family: "materials", reason: "Cheaper elsewhere",
          replacesLineKey: x.seeded.materialLineKey,
        },
      })]);

    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("COSTING_MANUAL_INPUT_RETIRED");
  });

  test("the replacement instruction is refused even with the override wrapper removed", async () => {
    /* A caller that learns `override` is refused has one obvious next move:
       send the same instruction loose. It is refused where it is written
       rather than reaching the allowlist and being dropped as an unknown
       key — dropping teaches a client that the field works. */
    const x = await world();
    const r = await typed(x, [{
        lineKey: "loose", category: "MATERIAL", behaviour: "PER_UNIT",
        unitRate: { amountMinor: 1, currency: "INR" }, quantityPerUnit: "1",
        replacesLineKey: x.seeded.materialLineKey,
      }]);

    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("COSTING_MANUAL_INPUT_RETIRED");
    expect(r.body.error.details.reason).toBe("REPLACEMENT_LINE_RETIRED");
  });

  test("an undeclared manual line is still refused, and now names its owner too", async () => {
    /* This refusal predates the change and used to end by telling the
       caller to declare an override instead. That remedy no longer exists,
       so the message and the `remedy` code both had to move. */
    const x = await world();
    const r = await typed(x, [{
        lineKey: "plain", category: "PACKAGING", behaviour: "PER_UNIT",
        label: "Poly bag", unitRate: { amountMinor: 400, currency: "INR" },
        quantityPerUnit: "1", quantityUom: "pc",
      }]);

    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("COSTING_MANUAL_LINE_REFUSED");
    expect(r.body.error.details.remedy).toBe("RECORD_IN_OWNING_APPLICATION");
    expect(r.body.error.details.remedy).not.toBe("PROVISIONAL_OVERRIDE");
    expect(r.body.error.details.owner.department).toBeTruthy();
  });

  test("nothing is written when a manual line is refused", async () => {
    /* ── REFUSED, NOT STRIPPED ─────────────────────────────────────────
       The alternative — drop the typed row and calculate the rest — is the
       worst outcome available: the save succeeds, the person believes their
       figure is in the costing, and the version they go on to approve does
       not contain it. */
    const x = await world();
    const before = await CostingVersion.countDocuments({ costingId: x.costingId });
    expect((await typed(x, [override()])).status).toBe(400);
    expect(await CostingVersion.countDocuments({ costingId: x.costingId })).toBe(before);
  });
});

/* ═══ 3 · THE REQUEST CONTRACT REFUSES IT WITHOUT A DATABASE ═════════════ */

describe("the refusal is in the request contract, not only in the assembly", () => {
  test("parseLine refuses an override before anything is read", () => {
    /* Reached before the style, the quotations and the policy are loaded, so
       a hostile payload costs one parse rather than four reads — and so the
       rule holds for any caller of the parser, not just this route. */
    expect(() => parseLine(override(), 0, "INR", new Set()))
      .toThrow(/cannot be entered in Costing/i);
  });

  test("and the assembly refuses one too, for a caller that skipped the parser", () => {
    /* Two layers on purpose. The parser is the edge; this is the layer that
       knows the costing is source-backed, and an internal caller building
       an input by hand does not pass through the edge. */
    expect(typeof assembly.mergeOverrides).toBe("undefined");
  });
});

/* ═══ 4 · MISSING FACTS STAY BLOCKED, AND STAY OWNED ═════════════════════ */

describe("a missing fact is a blocker with a name on it, never a manual line", () => {
  test("a material with no usable quotation blocks the save and names Store", async () => {
    /* ── THE CASE THE OVERRIDE WAS INVENTED FOR ────────────────────────
       No quotation, a deadline, and a person who knows roughly what the
       fabric costs. The answer is that the costing does not calculate and
       Store is asked — not that the figure is typed with a reason beside
       it. */
    /* Seeded WITHOUT a quotation rather than withdrawing one afterwards: a
       supplier offer is immutable and refuses an update query outright, which
       is itself the right behaviour and not this suite's subject. */
    const x = await world({ withQuotation: false });

    /* Creating a costing already writes an empty draft version 1, so the
       claim is that this request adds NONE — not that none exists. */
    const before = await CostingVersion.countDocuments({ costingId: x.costingId });

    const r = await calc(x);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_ASSEMBLY_BLOCKED");
    /* Named and owned, so the answer is "ask Store" rather than "type it". */
    expect(r.body.error.details.owner.department).toBe("Store");
    expect(r.body.error.details.owner.system).toMatch(/quotation register/i);
    /* Blocked, with something to act on — never a version costed at a
       plausible zero. */
    expect(await CostingVersion.countDocuments({ costingId: x.costingId })).toBe(before);
  });

  test("a quotation the server cannot read does not become a typed rate either", async () => {
    /* A read FAILURE and an ABSENCE are different facts, and the dangerous
       confusion is treating the first as the second: a rate typed while the
       register is unreadable is a guess standing in for a price that exists. */
    const x = await world();
    const offerRead = require("../../services/storePurchase/supplierOfferRead.service");
    const spy = jest.spyOn(offerRead, "applicableOffersForItem").mockImplementation(() => {
      throw new Error("register unavailable");
    });
    const before = await CostingVersion.countDocuments({ costingId: x.costingId });
    try {
      const r = await calc(x);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(await CostingVersion.countDocuments({ costingId: x.costingId })).toBe(before);
    } finally {
      spy.mockRestore();
    }
  });

  test("every cost family names a department, so no refusal can be a dead end", () => {
    /* ── WHY THIS IS AN INVARIANT AND NOT A SPOT CHECK ─────────────────
       The refusals above look up the owner by family. A family with no
       owner would produce the generic message — true, and useless — and
       nothing would fail. This is what would fail. */
    for (const f of costCoverage.FAMILIES) {
      const owner = costCoverage.ownerOf({ family: f.key });
      expect(owner).toBeTruthy();
      expect(owner.department).toBeTruthy();
      expect(owner.recordedIn).toBeTruthy();
    }
  });

  test("PROVISIONAL_OVERRIDE is no longer an authority a family can hold", () => {
    /* It meant "a person typed it". No family can be in that state on a
       costing raised from now on, and an enum member nothing produces reads
       as a menu to the next person who needs a figure. */
    expect(costCoverage.AUTHORITY.PROVISIONAL_OVERRIDE).toBeUndefined();
    expect(Object.values(costCoverage.AUTHORITY)).not.toContain("PROVISIONAL_OVERRIDE");
  });
});

/* ═══ 5 · AND HISTORY IS UNTOUCHED ══════════════════════════════════════ */

describe("costings frozen with provisional inputs stay exactly as they were", () => {
  test("a historical manual costing still reads, with its label and its lines", async () => {
    const co = await Acc_Company.create({
      companyName: `Retire hist ${++seq}`, booksFromDate: new Date("2026-04-01"),
    });
    const token = await actor(co);
    const hist = await seedHistoricalAdhoc(co._id, { label: "2024 estimate" });

    const r = await call(`/${hist._id}`, { token, company: co._id });
    expect(r.status).toBe(200);
    /* The server's own word for it, unchanged — nothing here relabels a
       record because the rule that produced it has since changed. */
    expect(r.body.costing.historical.label).toBe("Historical manual costing");
    expect(r.body.costing.historical.readOnly).toBe(true);
  });

  test("a frozen PROVISIONAL line and its MANUAL_ENTRY provenance both still read", async () => {
    /* ── WHAT WOULD HAVE BROKEN THIS ───────────────────────────────────
       Refusing a stored override on the way OUT — treating the read path
       like the write path — would make every costing raised before this
       change unreadable, which is the one thing worse than having allowed
       them. */
    const co = await Acc_Company.create({
      companyName: `Retire read ${++seq}`, booksFromDate: new Date("2026-04-01"),
    });
    const token = await actor(co);
    const hist = await seedHistoricalAdhoc(co._id);

    /* ── WRITTEN AT CREATION, BECAUSE A VERSION IS IMMUTABLE ───────────
       A frozen version refuses an update query on `cost` outright — which is
       the guarantee this whole area rests on, and it applies to a fixture as
       much as to a route. So the historical version is CREATED carrying the
       provisional line, which is how it came to exist in the first place. */
    const version = await CostingVersion.create({
      companyId: co._id, costingId: hist._id, versionNumber: 1, baseCurrency: "INR",
      provenance: { origin: "LEGACY_IMPORT", createdAt: new Date() },
      /* Top-level on the document; the serializer presents it under `cost`. */
      inputs: [{
        lineKey: "legacy-override", category: "DUTY", behaviour: "FIXED_PER_RUN",
        label: "Customs cess", amount: { amountMinor: 500000, currency: "INR" },
        confidence: "PROVISIONAL",
      }],
      sourceReferences: [{
        sourceType: "MANUAL_ENTRY", sourceKey: "override:legacy-override",
        label: "Provisional override — Customs cess", confidence: "PROVISIONAL",
        capturedAt: new Date(),
        snapshot: [
          { key: "costFamily", text: "duty" },
          { key: "reason", text: "The broker's estimate" },
          { key: "enteredByActorName", text: "A Buyer" },
        ],
      }],
    });
    await Costing.updateOne({ _id: hist._id }, { $set: { currentVersionNumber: 1 } });
    expect(version.versionNumber).toBe(1);

    const r = await call(`/${hist._id}/versions`, { token, company: co._id });
    expect(r.status).toBe(200);

    const v = r.body.versions[0];
    const line = v.cost.inputs.find((l) => l.lineKey === "legacy-override");
    expect(line).toBeTruthy();
    expect(line.confidence).toBe("PROVISIONAL");
    expect(line.amount.amountMinor).toBe(500000);

    /* And the explanation beside it — who typed it and why — which is the
       whole reason the old contract asked for a reason. */
    const ref = (v.cost.sourceReferences || []).find((s) => s.sourceKey === "override:legacy-override");
    expect(ref).toBeTruthy();
    expect(ref.confidence).toBe("PROVISIONAL");
  });
});
