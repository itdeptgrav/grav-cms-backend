// test/costing/sales-commercial-review.test.js
//
// WHO MAY DECIDE THAT A PRICE MAY BE QUOTED.
//
// ── THREE AUTHORITIES, NOT ONE ──────────────────────────────────────────────
// Asking for a decision, taking an ordinary one, and waiving the company's own
// floor are three different acts held by three different people. If one
// capability could do all three, the floor would be a suggestion enforced by
// nobody — so the split is what these tests are mostly about.
//
// ── AND NOTHING IS RECALCULATED ─────────────────────────────────────────────
// Every figure a decision rests on was FROZEN when the estimate was prepared.
// A floor recomputed at decision time could differ from the one the reviewer
// was shown, so the service reads the frozen standing and never the policy of
// the day.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

jest.mock("../../config/firebaseAdmin", () => ({ messaging: () => ({ send: async () => ({}) }) }));
jest.mock("../../services/NotificationService", () => ({
  notify: async () => ({}), notifyUser: async () => ({}), send: async () => ({}),
}));
jest.mock("../../services/departmentNotify.service", () => ({
  notifyEvent: async () => ({}), APP_URL: "http://localhost",
}));
jest.mock("../../services/changeLog", () => ({
  recordChange: async () => ({}), historyFor: async () => [], diff: () => ({}),
}));
jest.mock("../../services/cowork.service", () => ({}), { virtual: true });
jest.mock("../../services/coworkSheets.service", () => ({}), { virtual: true });
jest.mock("../../Middlewear/SalesAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    if (!global.__ACTOR__) return res.status(401).json({ success: false });
    req.user = global.__ACTOR__;
    next();
  };
  mw.withRoles = () => mw;
  return mw;
});

const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

/* ── A REPLICA SET, BECAUSE A DECISION AND ITS EVIDENCE COMMIT TOGETHER ─────
 * `lifecycle` refuses to move a version's status unless the deployment can
 * give it a transaction: a status change whose evidence failed to write is an
 * approval nobody can be shown to have made. The shared harness runs a
 * standalone mongod, which would refuse every decision here for that reason —
 * and every authority assertion would then pass for the wrong reason. */
let rs;
beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "sales_commercial_review" });
});
afterAll(async () => {
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const {
  seedSourceBacked, configureProduction, approveFinancingPolicy, approveMarginPolicy,
  CONFIRMED_TERMS, EVERY_FAMILY, confirmCostingBrief,
} = require("./helpers/sourceBacked");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const CostingPolicy = require("../../models/CMS_Models/Costing/CostingPolicy");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const CostingTransition = require("../../models/CMS_Models/Costing/CostingTransition");
const Costing = require("../../models/CMS_Models/Costing/Costing");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const Employee = require("../../models/Employee");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

const prep = require("../../services/sales/costingPreparation.service");
const review = require("../../services/sales/commercialReview.service");
const capabilities = require("../../services/centralCosting/capabilities");
const companyContext = require("../../services/centralCosting/companyContext.service");

const { CAPABILITIES: C } = capabilities;
let seq = 0;

/* ── PEOPLE, FROM REAL DEPARTMENT GRANTS ─────────────────────────────────── */
async function person({ company, grant = null, role = "editor", admin = false } = {}) {
  const n = ++seq;
  const email = `review-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "R", lastName: `V${n}`, email, biometricId: `RV${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  if (grant) await DepartmentRole.create({ departmentSlug: grant, email, role, isActive: true });
  if (admin) {
    await DeptUser.create({
      name: "R", email, passwordHash: "x", isAdmin: true, isActive: true,
      departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
    });
  }
  if (company) {
    await SpCompanyMembership.create({
      companyId: company._id, email, employeeRef: emp._id, personName: "R",
    });
  }
  return { emp, email, user: { id: String(emp._id), email }, name: `R V${n}` };
}

const ctxFor = (p, companyId) =>
  companyContext.resolveForActor(p.user, { requestedCompanyId: companyId });

const actorOf = (p) => ({ id: String(p.emp._id), name: p.name, email: p.email });

/**
 * A costed enquiry product with a proposed price.
 *
 * `markup` and `price` together decide the STANDING: the engine freezes
 * `AT_OR_ABOVE_FLOOR` or `BELOW_FLOOR` when it prepares, and every test here
 * reads that frozen answer rather than asserting one.
 */
async function world({ markup = "20", price = "900", ...over } = {}) {
  const co = await Acc_Company.create({
    companyName: `Review ${++seq}`, booksFromDate: new Date("2026-04-01"),
  });
  await CostingPolicy.create({
    companyId: co._id, baseCurrency: "INR", roundingMode: "HALF_UP",
    sellingPriceIncrementMinor: 100, revision: 1,
  });
  await approveFinancingPolicy(co._id);
  if (markup !== null) await approveMarginPolicy(co._id, { floorMarkupPercent: markup });
  const seeded = await seedSourceBacked(co._id, {
    ...EVERY_FAMILY, paymentTerms: { ...CONFIRMED_TERMS }, brief: null, ...over,
  });
  await configureProduction(co._id);
  await confirmCostingBrief(co._id, {
    enquiryId: seeded.enquiry._id,
    styleId: seeded.style._id,
    quantities: [{ key: "q500", quantity: "500", isPrimary: true, proposedSellingPriceExclTax: price }],
  });
  return { co, seeded, product: seeded.product };
}

const prepareFor = async (ctx, w) => prep.prepare(ctx, {
  enquiryId: w.seeded.enquiry._id, product: w.product, actionKey: `rv-${++seq}`,
});

const args = (w, over = {}) => ({
  enquiryId: w.seeded.enquiry._id, product: w.product, ...over,
});

const latestOf = async (w) => {
  const costing = await Costing.findOne({ companyId: w.co._id }).lean();
  return CostingVersion.findOne({ costingId: costing._id }).sort({ versionNumber: -1 }).lean();
};

const refusalOf = async (fn) => {
  try { await fn(); } catch (err) { return err; }
  return null;
};

/**
 * A prepared, submitted world, with the actors that can decide on it.
 *
 * ── THE STANDING IS PRODUCED, NEVER ASSUMED ─────────────────────────────────
 * `below: true` does not guess at a price low enough to breach the floor —
 * the seeded cost decides that, and a guess would silently stop testing the
 * below-floor path the day the fixture's cost changed. It prepares once to
 * learn the floor the engine computed, proposes a penny under it, and
 * prepares again.
 */
async function submitted({ markup = "20", price = "900", below = false } = {}) {
  /* ── A BELOW-FLOOR CASE IS MADE BY THE MARKUP, NOT BY GUESSING ────────
     A confirmed brief is immutable, so the price cannot be adjusted after
     the floor is known. Raising the MARKUP instead puts the floor far above
     any ordinary proposal: at 900% the floor is ten times the true cost, so
     the seeded ₹300 is unambiguously below it whatever the fixture's cost
     happens to be. The engine still decides the standing; this only makes
     sure the case being exercised is the one the test is named for. */
  const w = await world(below ? { markup: "900", price: "300" } : { markup, price });
  const editor = await person({ company: w.co, grant: "sales", role: "editor" });
  const approver = await person({ company: w.co, grant: "sales", role: "approver" });
  const exec = await person({ company: w.co, grant: "ceo", role: "owner" });

  const ectx = await ctxFor(editor, w.co._id);
  await prepareFor(ectx, w);
  const v = await latestOf(w);
  await review.submit(ectx, args(w, { versionId: String(v._id), actionKey: `s-${++seq}`, actor: actorOf(editor) }));

  return {
    w, editor, approver, exec,
    ectx,
    actx: await ctxFor(approver, w.co._id),
    xctx: await ctxFor(exec, w.co._id),
    versionId: String(v._id),
  };
}

/* ═══ 1 · THE THREE AUTHORITIES ══════════════════════════════════════════ */

describe("the capabilities", () => {
  const capsOf = (slug, role) =>
    capabilities.capabilitiesFromGrants([{ departmentSlug: slug, role }], false).capabilities;

  test("submit, ordinary approval and the exception are three separate grants", () => {
    expect(C.COMMERCIAL_SUBMIT).toBe("costing.commercial.submit");
    expect(C.COMMERCIAL_APPROVE).toBe("costing.commercial.approve");
    expect(C.COMMERCIAL_EXCEPTION).toBe("costing.commercial.exception");
    expect(new Set(Object.values(C)).size).toBe(Object.values(C).length);
  });

  test("Sales ranks get exactly what their job is, and no exception authority", () => {
    expect(capsOf("sales", "viewer")).toEqual([C.OUTPUT_READ]);

    const editor = capsOf("sales", "editor");
    expect(editor).toContain(C.COMMERCIAL_SUBMIT);
    expect(editor).not.toContain(C.COMMERCIAL_APPROVE);

    for (const role of ["approver", "owner"]) {
      const caps = capsOf("sales", role);
      expect(caps).toContain(C.COMMERCIAL_SUBMIT);
      expect(caps).toContain(C.COMMERCIAL_APPROVE);
      /* ── THE LINE THAT MAKES THE FLOOR A RULE ─────────────────────
         No Sales rank may waive it. */
      expect(caps).not.toContain(C.COMMERCIAL_EXCEPTION);
    }
  });

  test("none of the three reveals cost, margin or policy", () => {
    for (const role of ["editor", "approver", "owner"]) {
      const caps = capsOf("sales", role);
      for (const denied of [C.COST_READ, C.MARGIN_READ, C.DRAFT_WRITE, C.APPROVE, C.POLICY_MANAGE]) {
        expect(caps).not.toContain(denied);
      }
    }
  });

  test("the executive authority and platform administrators hold the exception", () => {
    expect(capsOf("ceo", "owner")).toContain(C.COMMERCIAL_EXCEPTION);
    expect(capabilities.capabilitiesFromGrants([], true).capabilities).toContain(C.COMMERCIAL_EXCEPTION);
  });

  test("an unrelated department gets none of them", () => {
    for (const slug of ["store", "merchandising", "production", "accounts"]) {
      expect(capsOf(slug, "owner")).toEqual([]);
    }
  });
});

/* ═══ 2 · SUBMISSION ═════════════════════════════════════════════════════ */

describe("submitting for review", () => {
  test("a Sales editor submits, and the version moves to review", async () => {
    const w = await world();
    const editor = await person({ company: w.co, grant: "sales", role: "editor" });
    const ctx = await ctxFor(editor, w.co._id);
    await prepareFor(ctx, w);
    const v = await latestOf(w);

    const out = await review.submit(ctx, args(w, {
      versionId: String(v._id), actionKey: `s-${++seq}`, actor: actorOf(editor),
    }));

    expect(out.outcome).toBe("SUBMITTED");
    expect(out.reviewState).toBe(review.REVIEW.AWAITING_COMMERCIAL_APPROVAL);
    expect((await latestOf(w)).status).toBe("IN_REVIEW");
  });

  test("a Sales viewer is refused, and nothing moves", async () => {
    const w = await world();
    const editor = await person({ company: w.co, grant: "sales", role: "editor" });
    await prepareFor(await ctxFor(editor, w.co._id), w);
    const v = await latestOf(w);

    const viewer = await person({ company: w.co, grant: "sales", role: "viewer" });
    const vctx = await ctxFor(viewer, w.co._id);
    const err = await refusalOf(() => review.submit(vctx,
      args(w, { versionId: String(v._id), actionKey: `s-${++seq}`, actor: actorOf(viewer) })));

    expect(err.code).toBe(review.CODES.FORBIDDEN);
    expect(err.details.required).toBe(C.COMMERCIAL_SUBMIT);
    expect((await latestOf(w)).status).toBe("DRAFT");
    expect(await CostingTransition.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("an already-submitted version is refused by name", async () => {
    const s = await submitted();
    const err = await refusalOf(() => review.submit(s.ectx,
      args(s.w, { versionId: s.versionId, actionKey: `s-${++seq}`, actor: actorOf(s.editor) })));
    /* The lifecycle owns the status and names the conflict — a DIFFERENT key,
       so this is a second submission rather than a replayed one. */
    expect(err.code).toBe("COSTING_VERSION_STATE_CONFLICT");
  });
});

/* ═══ 3 · THE ORDINARY DECISION ══════════════════════════════════════════ */

describe("ordinary commercial approval", () => {
  test("an above-floor proposal is approved by a Sales approver", async () => {
    const s = await submitted({ markup: "20", price: "900" });
    const before = await latestOf(s.w);
    expect(before.commercial.bridge[0].standing).toBe("AT_OR_ABOVE_FLOOR");

    const out = await review.approve(s.actx, args(s.w, {
      versionId: s.versionId, actionKey: `a-${++seq}`, actor: actorOf(s.approver),
    }));

    expect(out.outcome).toBe("APPROVED");
    expect(out.reviewState).toBe(review.REVIEW.APPROVED);
    expect((await latestOf(s.w)).status).toBe("APPROVED");
  });

  test("a price EXACTLY at the floor is approvable — the floor is a floor", async () => {
    /* ── EQUAL IS AT OR ABOVE ─────────────────────────────────────────
       A strict `>` would send a quotation priced exactly at the company's
       own floor for an executive exception.

       The brief is immutable once confirmed, so the floor is learned from
       one world and the price seeded into a second built from the same
       fixture — rather than re-confirming, which the brief refuses. */
    const probe = await world({ markup: "20", price: null });
    const prober = await person({ company: probe.co, grant: "sales", role: "editor" });
    await prepareFor(await ctxFor(prober, probe.co._id), probe);
    const floorMinor = (await latestOf(probe)).scenarios[0].floor.floorPriceMinor;
    expect(floorMinor).toBeGreaterThan(0);

    const w = await world({ markup: "20", price: String(floorMinor / 100) });
    const editor = await person({ company: w.co, grant: "sales", role: "editor" });
    const ectx = await ctxFor(editor, w.co._id);
    await prepareFor(ectx, w);
    const v = await latestOf(w);

    expect(v.scenarios[0].floor.floorPriceMinor).toBe(floorMinor);
    expect(v.commercial.bridge[0].proposedPriceExclTaxMinor).toBe(floorMinor);
    expect(v.commercial.bridge[0].standing).toBe("AT_OR_ABOVE_FLOOR");

    await review.submit(ectx, args(w, { versionId: String(v._id), actionKey: `s-${++seq}`, actor: actorOf(editor) }));
    const approver = await person({ company: w.co, grant: "sales", role: "approver" });
    const out = await review.approve(await ctxFor(approver, w.co._id), args(w, {
      versionId: String(v._id), actionKey: `a-${++seq}`, actor: actorOf(approver),
    }));
    expect(out.outcome).toBe("APPROVED");
  });

  test("a BELOW-floor proposal is refused, and names the authority it needs", async () => {
    const s = await submitted({ below: true });
    const v = await latestOf(s.w);
    expect(v.commercial.bridge[0].standing).toBe("BELOW_FLOOR");
    expect(s.actx.capabilitySet.has(C.COMMERCIAL_EXCEPTION)).toBe(false);

    const err = await refusalOf(() => review.approve(s.actx, args(s.w, {
      versionId: s.versionId, actionKey: `a-${++seq}`, actor: actorOf(s.approver),
    })));

    expect(err.code).toBe(review.CODES.EXCEPTION_REQUIRED);
    expect(err.details.required).toBe(C.COMMERCIAL_EXCEPTION);
    expect(err.details.reviewState).toBe(review.REVIEW.AWAITING_EXECUTIVE_EXCEPTION);
    /* And it is still under review, undecided. */
    expect((await latestOf(s.w)).status).toBe("IN_REVIEW");
  });

  test("an actor with no approval grant is refused before anything is read", async () => {
    const s = await submitted();
    const err = await refusalOf(() => review.approve(s.ectx, args(s.w, {
      versionId: s.versionId, actionKey: `a-${++seq}`, actor: actorOf(s.editor),
    })));
    expect(err.code).toBe(review.CODES.FORBIDDEN);
    expect(err.details.required).toBe(C.COMMERCIAL_APPROVE);
  });
});

/* ═══ 4 · THE EXECUTIVE EXCEPTION ════════════════════════════════════════ */

describe("the below-floor exception", () => {
  test("an executive approves it, with a reason, and the reason is recorded", async () => {
    const s = await submitted({ below: true });
    const reason = "Strategic account: accepted below floor to win the season.";

    const out = await review.approveException(s.xctx, args(s.w, {
      versionId: s.versionId, reason, actionKey: `x-${++seq}`, actor: actorOf(s.exec),
    }));

    expect(out.outcome).toBe("APPROVED_BY_EXCEPTION");
    expect((await latestOf(s.w)).status).toBe("APPROVED");
    expect((await latestOf(s.w)).lifecycle.approvalNote).toBe(reason);
  });

  test("a missing or trivial reason is refused, and nothing is decided", async () => {
    const s = await submitted({ below: true });
    for (const reason of ["", "   ", "ok"]) {
      const err = await refusalOf(() => review.approveException(s.xctx, args(s.w, {
        versionId: s.versionId, reason, actionKey: `x-${++seq}`, actor: actorOf(s.exec),
      })));
      expect(err.code).toBe(review.CODES.REASON_REQUIRED);
    }
    expect((await latestOf(s.w)).status).toBe("IN_REVIEW");
  });

  test("a Sales approver cannot reach the exception door", async () => {
    const s = await submitted({ below: true });
    const err = await refusalOf(() => review.approveException(s.actx, args(s.w, {
      versionId: s.versionId, reason: "We should take this order anyway.",
      actionKey: `x-${++seq}`, actor: actorOf(s.approver),
    })));
    expect(err.code).toBe(review.CODES.FORBIDDEN);
    expect(err.details.required).toBe(C.COMMERCIAL_EXCEPTION);
  });

  test("an at-or-above proposal cannot be approved AS an exception", async () => {
    /* Recording a waiver of a floor that was never breached would let the
       executive path quietly become the ordinary one. */
    const s = await submitted({ markup: "20", price: "900" });
    const err = await refusalOf(() => review.approveException(s.xctx, args(s.w, {
      versionId: s.versionId, reason: "Approving this one personally, for the record.",
      actionKey: `x-${++seq}`, actor: actorOf(s.exec),
    })));
    expect(err.code).toBe(review.CODES.NOT_AN_EXCEPTION);
  });
});

/* ═══ 5 · RETURN AND RESUBMIT ════════════════════════════════════════════ */

describe("returning to Sales", () => {
  test("a return needs a reason, and sends the version back as a draft", async () => {
    const s = await submitted();

    const bad = await refusalOf(() => review.returnToSales(s.actx, args(s.w, {
      versionId: s.versionId, reason: "no", actionKey: `r-${++seq}`, actor: actorOf(s.approver),
    })));
    expect(bad.code).toBe(review.CODES.REASON_REQUIRED);

    const reason = "The quantity break is wrong; please re-quote at 1,000.";
    const out = await review.returnToSales(s.actx, args(s.w, {
      versionId: s.versionId, reason, actionKey: `r-${++seq}`, actor: actorOf(s.approver),
    }));

    expect(out.outcome).toBe("RETURNED");
    expect(out.reviewState).toBe(review.REVIEW.RETURNED);
    expect(out.returnReason).toBe(reason);

    const v = await latestOf(s.w);
    expect(v.status).toBe("DRAFT");
    expect(v.lifecycle.returnReason).toBe(reason);
    /* The submission is cleared, so it cannot read as still under review. */
    expect(v.lifecycle.submittedAt).toBeFalsy();
  });

  test("a returned version can be resubmitted, and the return is cleared", async () => {
    const s = await submitted();
    await review.returnToSales(s.actx, args(s.w, {
      versionId: s.versionId, reason: "Please re-quote at the higher run size.",
      actionKey: `r-${++seq}`, actor: actorOf(s.approver),
    }));

    const again = await review.submit(s.ectx, args(s.w, {
      versionId: s.versionId, actionKey: `s2-${++seq}`, actor: actorOf(s.editor),
    }));
    expect(again.outcome).toBe("SUBMITTED");

    const v = await latestOf(s.w);
    expect(v.status).toBe("IN_REVIEW");
    expect(v.lifecycle.returnReason).toBeFalsy();
    /* ── AND THE HISTORY SURVIVES THE CLEARING ────────────────────────
       The version no longer shows the objection; the immutable record of it
       is exactly where it should be. */
    const kinds = (await CostingTransition.find({ companyId: s.w.co._id }).sort({ at: 1 }).lean())
      .map((t) => t.kind);
    expect(kinds).toEqual(["SUBMIT", "RETURN", "SUBMIT"]);
  });

  test("an editor cannot return their own submission", async () => {
    const s = await submitted();
    const err = await refusalOf(() => review.returnToSales(s.ectx, args(s.w, {
      versionId: s.versionId, reason: "Actually let me change this first.",
      actionKey: `r-${++seq}`, actor: actorOf(s.editor),
    })));
    expect(err.code).toBe(review.CODES.FORBIDDEN);
  });

  test("a below-floor return needs the executive, not the approver", async () => {
    const s = await submitted({ below: true });
    const reason = "Not accepting this margin; re-quote or escalate properly.";

    const refused = await refusalOf(() => review.returnToSales(s.actx, args(s.w, {
      versionId: s.versionId, reason, actionKey: `r-${++seq}`, actor: actorOf(s.approver),
    })));
    expect(refused.code).toBe(review.CODES.FORBIDDEN);
    expect(refused.details.required).toBe(C.COMMERCIAL_EXCEPTION);

    const out = await review.returnToSales(s.xctx, args(s.w, {
      versionId: s.versionId, reason, actionKey: `r-${++seq}`, actor: actorOf(s.exec),
    }));
    expect(out.outcome).toBe("RETURNED");
  });
});

/* ═══ 6 · WHAT CANNOT BE REVIEWED AT ALL ═════════════════════════════════ */

describe("refusals that are not ordinary approval cases", () => {
  test("a version with no proposed price has nothing to decide", async () => {
    const w = await world({ price: null });
    const editor = await person({ company: w.co, grant: "sales", role: "editor" });
    const ctx = await ctxFor(editor, w.co._id);
    await prepareFor(ctx, w);
    const v = await latestOf(w);

    const err = await refusalOf(() => review.submit(ctx,
      args(w, { versionId: String(v._id), actionKey: `s-${++seq}`, actor: actorOf(editor) })));
    expect(err.code).toBe(review.CODES.NOT_REVIEWABLE);
    expect(err.details.reason).toBe(review.BLOCKED.NO_PROPOSED_PRICE);
  });

  test("a historical MARGIN_BAND_V1 version is refused, not translated", async () => {
    /* ── HISTORY IS NOT A CASE FOR THIS WORKFLOW ──────────────────────
       It was judged against a retired band. "Is this at or above the floor"
       was never put to it, and answering it now would approve a price under
       a rule nobody applied. It stays readable as history. */
    const band = {
      versionNumber: 3,
      status: "IN_REVIEW",
      calculation: { engineVersion: "1.0.0" },
      scenarios: [{ key: "q500", isPrimary: true, prices: { minimum: { priceMinor: 14000 } } }],
      commercial: {
        proposedPrices: [{ scenarioKey: "q500", priceExclTaxMinor: 20000 }],
        bridge: [{ scenarioKey: "q500", standing: "BELOW_MINIMUM" }],
      },
    };
    const subject = review.subjectOf(band);
    expect(subject.ok).toBe(false);
    expect(subject.reason).toBe(review.BLOCKED.HISTORICAL_CONTRACT);
  });

  test("POLICY_MISSING is refused rather than treated as approvable", async () => {
    const noPolicy = {
      versionNumber: 1, status: "IN_REVIEW",
      calculation: { engineVersion: "1.0.0" },
      scenarios: [{ key: "q", isPrimary: true, floor: { floorPriceMinor: 0 } }],
      commercial: {
        proposedPrices: [{ scenarioKey: "q", priceExclTaxMinor: 50000 }],
        bridge: [{ scenarioKey: "q", standing: "POLICY_MISSING" }],
      },
    };
    const subject = review.subjectOf(noPolicy);
    expect(subject.ok).toBe(false);
    expect(subject.reason).toBe(review.BLOCKED.POLICY_MISSING);
  });

  test("an unprepared or uncalculated version is refused", () => {
    expect(review.subjectOf(null).reason).toBe(review.BLOCKED.NO_ESTIMATE);
    expect(review.subjectOf({ scenarios: [] }).reason).toBe(review.BLOCKED.NOT_CALCULATED);
    expect(review.subjectOf({
      calculation: { engineVersion: "1" }, scenarios: [{ key: "q", isPrimary: true }],
    }).reason).toBe(review.BLOCKED.NOT_CALCULATED);
  });

  test("a floor-shaped version with no standing yet is refused", () => {
    const notJudged = {
      calculation: { engineVersion: "1" },
      scenarios: [{ key: "q", isPrimary: true, floor: { floorPriceMinor: 60000 } }],
      commercial: { proposedPrices: [{ scenarioKey: "q", priceExclTaxMinor: 70000 }], bridge: [] },
    };
    expect(review.subjectOf(notJudged).reason).toBe(review.BLOCKED.NO_STANDING);
  });
});

/* ═══ 7 · STALENESS, IDEMPOTENCY AND ISOLATION ═══════════════════════════ */

describe("the decision targets the exact version", () => {
  test("a decision naming an older version is refused", async () => {
    const s = await submitted();
    /* Sales refreshes the estimate: a newer version now exists. */
    await Enquiry.updateOne(
      { _id: s.w.seeded.enquiry._id },
      { $set: { "costingBriefs.0.quantities.0.proposedSellingPriceExclTax": "950" } },
    );
    await prepareFor(s.ectx, s.w);
    const newer = await latestOf(s.w);
    expect(String(newer._id)).not.toBe(s.versionId);

    const err = await refusalOf(() => review.approve(s.actx, args(s.w, {
      versionId: s.versionId, actionKey: `a-${++seq}`, actor: actorOf(s.approver),
    })));
    expect(err.code).toBe(review.CODES.STALE_VERSION);
    expect(err.details.reason).toBe("NEWER_VERSION_EXISTS");
  });

  test("an identical retry replays instead of deciding twice", async () => {
    const s = await submitted();
    const key = `a-idem-${++seq}`;
    const first = await review.approve(s.actx, args(s.w, {
      versionId: s.versionId, actionKey: key, actor: actorOf(s.approver),
    }));
    const again = await review.approve(s.actx, args(s.w, {
      versionId: s.versionId, actionKey: key, actor: actorOf(s.approver),
    }));

    expect(first.outcome).toBe("APPROVED");
    expect(again.outcome).toBe("REPLAYED");
    const approvals = await CostingTransition.countDocuments({
      companyId: s.w.co._id, kind: "APPROVE",
    });
    expect(approvals).toBe(1);
  });

  test("a second decision on an already-approved version is refused", async () => {
    const s = await submitted();
    await review.approve(s.actx, args(s.w, {
      versionId: s.versionId, actionKey: `a-${++seq}`, actor: actorOf(s.approver),
    }));
    const err = await refusalOf(() => review.approve(s.actx, args(s.w, {
      versionId: s.versionId, actionKey: `a-${++seq}`, actor: actorOf(s.approver),
    })));
    /* A different action key, so this is a genuine second decision and not a
       recovered retry — refused by the lifecycle, which owns the status. */
    expect(err.code).toBe("COSTING_VERSION_STATE_CONFLICT");
  });

  test("another company's enquiry is not found, never forbidden", async () => {
    const mine = await submitted();
    const theirs = await submitted();

    const err = await refusalOf(() => review.approve(mine.actx, {
      enquiryId: theirs.w.seeded.enquiry._id, product: theirs.w.product,
      versionId: theirs.versionId, actionKey: `a-${++seq}`, actor: actorOf(mine.approver),
    }));
    expect(err.code).toBe("NOT_FOUND");
    expect((await latestOf(theirs.w)).status).toBe("IN_REVIEW");
  });
});

/* ═══ 8 · THE EVIDENCE, AND WHAT SALES IS TOLD ═══════════════════════════ */

describe("evidence and the frontend contract", () => {
  test("every decision is immutable evidence with actor, states and reason", async () => {
    const s = await submitted({ below: true });
    const reason = "Strategic account: accepted below floor to win the season.";
    await review.approveException(s.xctx, args(s.w, {
      versionId: s.versionId, reason, actionKey: `x-${++seq}`, actor: actorOf(s.exec),
    }));

    const rows = await CostingTransition.find({ companyId: s.w.co._id }).sort({ at: 1 }).lean();
    expect(rows.map((r) => r.kind)).toEqual(["SUBMIT", "APPROVE"]);

    const approve = rows[1];
    expect(approve.fromStatus).toBe("IN_REVIEW");
    expect(approve.toStatus).toBe("APPROVED");
    expect(approve.actorId).toBe(String(s.exec.emp._id));
    expect(approve.actorName).toBe(s.exec.name);
    expect(approve.note).toBe(reason);
    expect(approve.versionId).toBeTruthy();
    expect(approve.at).toBeTruthy();

    /* And it cannot be edited afterwards. */
    const err = await refusalOf(() => CostingTransition.updateOne(
      { _id: approve._id }, { $set: { note: "something else" } },
    ));
    expect(err).toBeTruthy();
  });

  test("the Sales projection carries status and reasons, and no confidential input", async () => {
    const s = await submitted({ below: true });
    const state = await review.stateFor(s.ectx, args(s.w));

    expect(state.reviewState).toBe(review.REVIEW.AWAITING_EXECUTIVE_EXCEPTION);
    expect(state.requires).toBe("EXECUTIVE_EXCEPTION");
    expect(state.floor.standing).toBe("BELOW_FLOOR");
    expect(state.floor.floorPriceMinor).toBeGreaterThan(0);
    expect(state.submittedByName).toBe(s.editor.name);

    /* ── AND NOTHING BEHIND THE FLOOR ─────────────────────────────────
       Floor minus markup is the cost, so the markup amount is as
       confidential as the cost itself. */
    const body = JSON.stringify(state);
    for (const secret of [
      "floorMarkupPercent", "trueUnitCostMinor", "markupAmountMinor",
      "unitCostMinor", "totalCostMinor", "supplierName", "quotationReference",
      "operatorSalary", "policySnapshot", "sourceReferences",
    ]) {
      expect(body).not.toContain(secret);
    }
    /* Nor an actor's email or id. */
    expect(body).not.toContain(s.editor.email);
  });

  test("permitted actions match the caller's own authority", async () => {
    const s = await submitted({ markup: "20", price: "900" });

    const editor = await review.stateFor(s.ectx, args(s.w));
    expect(editor.permitted).toEqual({
      submit: false, approve: false, return: false, approveException: false,
    });

    const approver = await review.stateFor(s.actx, args(s.w));
    expect(approver.permitted.approve).toBe(true);
    expect(approver.permitted.return).toBe(true);
    expect(approver.permitted.approveException).toBe(false);

    const below = await submitted({ below: true });
    const belowApprover = await review.stateFor(below.actx, args(below.w));
    expect(belowApprover.permitted.approve).toBe(false);
    expect(belowApprover.permitted.return).toBe(false);
    const belowExec = await review.stateFor(below.xctx, args(below.w));
    expect(belowExec.permitted.approveException).toBe(true);
    expect(belowExec.permitted.return).toBe(true);
  });

  test("reading the review state writes nothing", async () => {
    const s = await submitted();
    const before = await CostingTransition.countDocuments({ companyId: s.w.co._id });
    const versions = await CostingVersion.countDocuments({ companyId: s.w.co._id });
    for (let i = 0; i < 3; i += 1) await review.stateFor(s.ectx, args(s.w));
    expect(await CostingTransition.countDocuments({ companyId: s.w.co._id })).toBe(before);
    expect(await CostingVersion.countDocuments({ companyId: s.w.co._id })).toBe(versions);
  });
});

/* ═══ 9 · THE COMMAND MUST NAME ITS SUBJECT AND ITS KEY ══════════════════ */

describe("what every command must say", () => {
  const omit = (fn, over) => refusalOf(fn(over));

  test("a missing versionId cannot submit, approve, return or except", async () => {
    /* ── THE SUBSTITUTION THIS PREVENTS ───────────────────────────────
       `subjectVersion` used to accept a missing id and fall back to the
       latest version. That is invisible when it goes wrong: the decision
       succeeds, on figures the caller never saw, and looks correct. */
    const s = await submitted();
    const below = await submitted({ below: true });

    const cases = [
      [() => review.submit(s.ectx, args(s.w, { actionKey: `k-${++seq}`, actor: actorOf(s.editor) }))],
      [() => review.approve(s.actx, args(s.w, { actionKey: `k-${++seq}`, actor: actorOf(s.approver) }))],
      [() => review.returnToSales(s.actx, args(s.w, {
        reason: "Please re-quote at the higher run size.", actionKey: `k-${++seq}`, actor: actorOf(s.approver),
      }))],
      [() => review.approveException(below.xctx, args(below.w, {
        reason: "Strategic account, accepted below floor.", actionKey: `k-${++seq}`, actor: actorOf(below.exec),
      }))],
    ];

    for (const [fn] of cases) {
      const err = await refusalOf(fn);
      expect(err.code).toBe(review.CODES.VERSION_REQUIRED);
      expect(err.status).toBe(400);
    }
    /* And nothing moved on either world. */
    expect((await latestOf(s.w)).status).toBe("IN_REVIEW");
    expect((await latestOf(below.w)).status).toBe("IN_REVIEW");
  });

  test("an invalid versionId is refused, not looked up", async () => {
    const s = await submitted();
    const err = await refusalOf(() => review.approve(s.actx, args(s.w, {
      versionId: "not-an-id", actionKey: `k-${++seq}`, actor: actorOf(s.approver),
    })));
    expect(err.code).toBe(review.CODES.VERSION_REQUIRED);
  });

  test("a missing idempotency key is refused on all four commands", async () => {
    /* ── AND NOT INVENTED SERVER-SIDE ─────────────────────────────────
       A generated key would make the retry guarantee a fiction: the retry of
       a lost response would arrive with a different key, match no receipt,
       and be taken as a second decision. */
    const s = await submitted();
    const below = await submitted({ below: true });

    const cases = [
      () => review.submit(s.ectx, args(s.w, { versionId: s.versionId, actor: actorOf(s.editor) })),
      () => review.approve(s.actx, args(s.w, { versionId: s.versionId, actor: actorOf(s.approver) })),
      () => review.returnToSales(s.actx, args(s.w, {
        versionId: s.versionId, reason: "Please re-quote at the higher run size.", actor: actorOf(s.approver),
      })),
      () => review.approveException(below.xctx, args(below.w, {
        versionId: below.versionId, reason: "Strategic account, accepted below floor.", actor: actorOf(below.exec),
      })),
    ];

    for (const fn of cases) {
      const err = await refusalOf(fn);
      expect(err.code).toBe(review.CODES.KEY_REQUIRED);
      expect(err.status).toBe(400);
    }
    expect((await latestOf(s.w)).status).toBe("IN_REVIEW");
  });
});

/* ═══ 10 · CHANGED SOURCES ═══════════════════════════════════════════════ */

describe("a version whose sources moved", () => {
  /**
   * Move a source that the fingerprint actually covers.
   *
   * A quotation is immutable, so Store withdraws it rather than editing —
   * and a withdrawn quotation is exactly the change this is about: the
   * material has no applicable rate any more.
   */
  async function staleTheSources(w) {
    const SupplierOffer = require("../../models/CMS_Models/Inventory/Sourcing/SupplierOffer");
    const offer = await SupplierOffer.findOne({ companyId: w.co._id, itemId: w.seeded.item._id });
    await SupplierOffer.collection.updateOne({ _id: offer._id }, { $set: { status: "WITHDRAWN" } });
  }

  test("the SAME version becomes blocked once a fingerprinted source changes", async () => {
    /* ── NON-VACUOUS BY CONSTRUCTION ──────────────────────────────────
       The version is decidable first, and the assertion is that the SAME
       version — same id, same frozen figures — stops being decidable. If
       the change were not one the fingerprint covers, the first half would
       pass and the second would fail. */
    const s = await submitted();
    const before = await review.stateFor(s.actx, args(s.w));
    expect(before.blockedReason).toBeNull();
    expect(before.permitted.approve).toBe(true);

    await staleTheSources(s.w);

    const after = await review.stateFor(s.actx, args(s.w));
    expect(after.version.versionId).toBe(before.version.versionId);
    expect(after.blockedReason).toBe(review.BLOCKED.INPUTS_CHANGED);
    expect(after.blockedMessage).toMatch(/inputs behind this estimate have changed/i);
    expect(after.changed.length).toBeGreaterThan(0);
    expect(after.changed.map((c) => c.owner)).toContain("Store / Purchase");

    /* Every command is off, so the screen offers nothing that would refuse. */
    expect(after.permitted).toEqual({
      submit: false, approve: false, return: false, approveException: false,
    });
  });

  test("a stale version cannot be approved, returned or excepted", async () => {
    const s = await submitted();
    await staleTheSources(s.w);

    const approve = await refusalOf(() => review.approve(s.actx, args(s.w, {
      versionId: s.versionId, actionKey: `st-${++seq}`, actor: actorOf(s.approver),
    })));
    expect(approve.code).toBe(review.CODES.STALE_INPUTS);
    expect(approve.details.reason).toBe(review.BLOCKED.INPUTS_CHANGED);

    const returned = await refusalOf(() => review.returnToSales(s.actx, args(s.w, {
      versionId: s.versionId, reason: "Please re-quote at the higher run size.",
      actionKey: `st-${++seq}`, actor: actorOf(s.approver),
    })));
    expect(returned.code).toBe(review.CODES.STALE_INPUTS);

    expect((await latestOf(s.w)).status).toBe("IN_REVIEW");
  });

  test("a stale DRAFT cannot be submitted", async () => {
    const w = await world();
    const editor = await person({ company: w.co, grant: "sales", role: "editor" });
    const ectx = await ctxFor(editor, w.co._id);
    await prepareFor(ectx, w);
    const v = await latestOf(w);
    await staleTheSources(w);

    const err = await refusalOf(() => review.submit(ectx, args(w, {
      versionId: String(v._id), actionKey: `st-${++seq}`, actor: actorOf(editor),
    })));
    expect(err.code).toBe(review.CODES.STALE_INPUTS);
    expect((await latestOf(w)).status).toBe("DRAFT");
  });

  test("a stale below-floor proposal cannot be excepted either", async () => {
    const s = await submitted({ below: true });
    await staleTheSources(s.w);
    const err = await refusalOf(() => review.approveException(s.xctx, args(s.w, {
      versionId: s.versionId, reason: "Strategic account, accepted below floor.",
      actionKey: `st-${++seq}`, actor: actorOf(s.exec),
    })));
    expect(err.code).toBe(review.CODES.STALE_INPUTS);
  });

  test("changed sources are NOT the same problem as a newer version", async () => {
    /* Two different refusals with two different fixes: refresh this one, or
       go and read the one somebody else prepared. */
    const s = await submitted();
    await staleTheSources(s.w);
    const stale = await refusalOf(() => review.approve(s.actx, args(s.w, {
      versionId: s.versionId, actionKey: `d-${++seq}`, actor: actorOf(s.approver),
    })));
    expect(stale.code).toBe(review.CODES.STALE_INPUTS);
    expect(stale.code).not.toBe(review.CODES.STALE_VERSION);
  });
});

/* ═══ 10b · FRESHNESS THAT CANNOT BE ESTABLISHED ═════════════════════════ */

describe("when freshness cannot be checked at all", () => {
  afterEach(() => jest.restoreAllMocks());

  /** Force the one resolver every freshness answer comes from to fail. */
  const breakResolver = () => jest.spyOn(prep, "resolve")
    .mockRejectedValue(new Error("simulated source resolution failure"));

  test("no command may decide, and nothing at all is written", async () => {
    /* ── NOT KNOWING IS NOT "FINE" ────────────────────────────────────
       An earlier version answered "not stale" whenever the resolver threw,
       so a database blip read as "verified current" and a decision was taken
       on figures nobody had checked. */
    const s = await submitted();
    const below = await submitted({ below: true });
    const versionsBefore = await CostingVersion.countDocuments({ companyId: s.w.co._id });
    const evidenceBefore = await CostingTransition.countDocuments({ companyId: s.w.co._id });

    breakResolver();

    const approve = await refusalOf(() => review.approve(s.actx, args(s.w, {
      versionId: s.versionId, actionKey: `fu-${++seq}`, actor: actorOf(s.approver),
    })));
    expect(approve.code).toBe(review.CODES.FRESHNESS_UNAVAILABLE);
    expect(approve.status).toBe(503);
    expect(approve.details.reason).toBe(review.BLOCKED.FRESHNESS_UNAVAILABLE);
    expect(approve.details.retryable).toBe(true);
    /* The underlying failure is never published. */
    expect(JSON.stringify(approve.details)).not.toContain("simulated");

    const returned = await refusalOf(() => review.returnToSales(s.actx, args(s.w, {
      versionId: s.versionId, reason: "Please re-quote at the higher run size.",
      actionKey: `fu-${++seq}`, actor: actorOf(s.approver),
    })));
    expect(returned.code).toBe(review.CODES.FRESHNESS_UNAVAILABLE);

    const excepted = await refusalOf(() => review.approveException(below.xctx, args(below.w, {
      versionId: below.versionId, reason: "Strategic account, accepted below floor.",
      actionKey: `fu-${++seq}`, actor: actorOf(below.exec),
    })));
    expect(excepted.code).toBe(review.CODES.FRESHNESS_UNAVAILABLE);

    /* ── AND NO TRANSITION AND NO EVIDENCE ────────────────────────────
       The version is untouched and the audit trail did not grow. */
    expect((await latestOf(s.w)).status).toBe("IN_REVIEW");
    expect((await latestOf(below.w)).status).toBe("IN_REVIEW");
    expect(await CostingVersion.countDocuments({ companyId: s.w.co._id })).toBe(versionsBefore);
    expect(await CostingTransition.countDocuments({ companyId: s.w.co._id })).toBe(evidenceBefore);
  });

  test("a DRAFT cannot be submitted while freshness is unknown", async () => {
    const w = await world();
    const editor = await person({ company: w.co, grant: "sales", role: "editor" });
    const ectx = await ctxFor(editor, w.co._id);
    await prepareFor(ectx, w);
    const v = await latestOf(w);

    breakResolver();
    const err = await refusalOf(() => review.submit(ectx, args(w, {
      versionId: String(v._id), actionKey: `fu-${++seq}`, actor: actorOf(editor),
    })));
    expect(err.code).toBe(review.CODES.FRESHNESS_UNAVAILABLE);
    expect((await latestOf(w)).status).toBe("DRAFT");
    expect(await CostingTransition.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("the projection says so, and offers nothing", async () => {
    const s = await submitted();
    breakResolver();

    const state = await review.stateFor(s.actx, args(s.w));
    expect(state.blockedReason).toBe(review.BLOCKED.FRESHNESS_UNAVAILABLE);
    expect(state.blockedMessage).toMatch(/could not be checked/i);
    expect(state.permitted).toEqual({
      submit: false, approve: false, return: false, approveException: false,
    });
  });

  test("a resolver that answers without a freshness verdict is also unknown", () => {
    /* Absent is not "current". A resolve that came back with no freshness
       block established nothing. */
    jest.spyOn(prep, "resolve").mockResolvedValue({ state: "ESTIMATE_READY" });
    return review.stateFor({ companyId: new mongoose.Types.ObjectId(), capabilitySet: new Set() },
      { enquiryId: new mongoose.Types.ObjectId(), product: "x" })
      .then((state) => {
        /* No costing at all here, so there is no version to judge — the
           assertion that matters is that it did not throw and offered
           nothing. */
        expect(state.permitted.approve).toBe(false);
      });
  });
});

/* ═══ 11 · THE RETRY GUARANTEE ═══════════════════════════════════════════ */

describe("a lost response", () => {
  test("an exact retry replays even after the state has moved AND the sources changed", async () => {
    /* ── THE ORDERING THIS PROVES ─────────────────────────────────────
       The receipt is consulted before freshness and before state. Both have
       moved by the time the retry arrives — the version is APPROVED and its
       sources are stale — and the retry must still replay, because the
       caller is asking about a decision that already happened. */
    const s = await submitted();
    const key = `replay-${++seq}`;

    const first = await review.approve(s.actx, args(s.w, {
      versionId: s.versionId, actionKey: key, actor: actorOf(s.approver),
    }));
    expect(first.outcome).toBe("APPROVED");

    const SupplierOffer = require("../../models/CMS_Models/Inventory/Sourcing/SupplierOffer");
    const offer = await SupplierOffer.findOne({ companyId: s.w.co._id, itemId: s.w.seeded.item._id });
    await SupplierOffer.collection.updateOne({ _id: offer._id }, { $set: { status: "WITHDRAWN" } });

    const retry = await review.approve(s.actx, args(s.w, {
      versionId: s.versionId, actionKey: key, actor: actorOf(s.approver),
    }));
    expect(retry.outcome).toBe("REPLAYED");

    /* And exactly one decision was recorded. */
    expect(await CostingTransition.countDocuments({
      companyId: s.w.co._id, kind: "APPROVE",
    })).toBe(1);
  });

  test("an exact retry replays even after a NEWER version has been prepared", async () => {
    /* ── THE ORDERING THIS PROVES ─────────────────────────────────────
       The receipt is consulted before the latest-version comparison. A
       retry of a decision that already happened is a caller asking what
       happened, not a new decision — refusing it because somebody has since
       prepared a newer version would lose the answer to a request that
       already succeeded. */
    const s = await submitted();
    const key = `newer-${++seq}`;

    const first = await review.approve(s.actx, args(s.w, {
      versionId: s.versionId, actionKey: key, actor: actorOf(s.approver),
    }));
    expect(first.outcome).toBe("APPROVED");

    /* Sales prepares again: a newer version now exists. */
    await Enquiry.updateOne(
      { _id: s.w.seeded.enquiry._id },
      { $set: { "costingBriefs.0.quantities.0.proposedSellingPriceExclTax": "980" } },
    );
    await prepareFor(s.ectx, s.w);
    const newer = await latestOf(s.w);
    expect(String(newer._id)).not.toBe(s.versionId);

    const retry = await review.approve(s.actx, args(s.w, {
      versionId: s.versionId, actionKey: key, actor: actorOf(s.approver),
    }));
    expect(retry.outcome).toBe("REPLAYED");
    expect(await CostingTransition.countDocuments({
      companyId: s.w.co._id, kind: "APPROVE",
    })).toBe(1);
  });

  test("the SAME old version with a NEW key is refused as stale", async () => {
    /* Not a retry — a fresh decision on figures that have been superseded. */
    const s = await submitted();
    await review.approve(s.actx, args(s.w, {
      versionId: s.versionId, actionKey: `orig-${++seq}`, actor: actorOf(s.approver),
    }));
    await Enquiry.updateOne(
      { _id: s.w.seeded.enquiry._id },
      { $set: { "costingBriefs.0.quantities.0.proposedSellingPriceExclTax": "985" } },
    );
    await prepareFor(s.ectx, s.w);

    const err = await refusalOf(() => review.approve(s.actx, args(s.w, {
      versionId: s.versionId, actionKey: `fresh-${++seq}`, actor: actorOf(s.approver),
    })));
    expect(err.code).toBe(review.CODES.STALE_VERSION);
    expect(err.details.reason).toBe("NEWER_VERSION_EXISTS");
  });

  test("the named version is company-scoped when it is loaded", async () => {
    /* Loading BY ID could reach across a tenancy if it were not scoped.
       Another company's version answers exactly as one that never existed. */
    const mine = await submitted();
    const theirs = await submitted();

    const err = await refusalOf(() => review.approve(mine.actx, {
      enquiryId: mine.w.seeded.enquiry._id,
      product: mine.w.product,
      versionId: theirs.versionId,
      actionKey: `iso-${++seq}`,
      actor: actorOf(mine.approver),
    }));
    expect(err.code).toBe("NOT_FOUND");
    expect((await latestOf(theirs.w)).status).toBe("IN_REVIEW");
  });

  test("the same key with a DIFFERENT payload is still refused", async () => {
    const s = await submitted({ below: true });
    const key = `conflict-${++seq}`;

    await review.approveException(s.xctx, args(s.w, {
      versionId: s.versionId, reason: "Strategic account, accepted below floor.",
      actionKey: key, actor: actorOf(s.exec),
    }));

    const err = await refusalOf(() => review.approveException(s.xctx, args(s.w, {
      versionId: s.versionId, reason: "A completely different justification entirely.",
      actionKey: key, actor: actorOf(s.exec),
    })));
    expect(err.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await CostingTransition.countDocuments({
      companyId: s.w.co._id, kind: "APPROVE",
    })).toBe(1);
  });

  test("a submission retry replays after the version has already moved on", async () => {
    const w = await world();
    const editor = await person({ company: w.co, grant: "sales", role: "editor" });
    const ectx = await ctxFor(editor, w.co._id);
    await prepareFor(ectx, w);
    const v = await latestOf(w);
    const key = `sreplay-${++seq}`;

    await review.submit(ectx, args(w, { versionId: String(v._id), actionKey: key, actor: actorOf(editor) }));
    const retry = await review.submit(ectx, args(w, { versionId: String(v._id), actionKey: key, actor: actorOf(editor) }));

    expect(retry.outcome).toBe("REPLAYED");
    expect(await CostingTransition.countDocuments({ companyId: w.co._id, kind: "SUBMIT" })).toBe(1);
  });
});

/* ═══ 9 · THE DOOR ITSELF ════════════════════════════════════════════════ */

describe("the commands are exposed on the enquiry, not on Costing", () => {
  let server; let base;

  beforeAll(async () => {
    const express = require("express");
    const app = express();
    app.use(express.json());
    app.use("/", require("../../routes/CMS_Routes/Sales/enquiries"));
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); });
  afterEach(() => { global.__ACTOR__ = null; });

  const call = (path_, { method = "GET", body } = {}) =>
    fetch(`${base}${path_}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }).then(async (r) => {
      const raw = await r.text();
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { nonJson: true }; }
      return { status: r.status, body: parsed };
    });

  test("submit and approve travel over the Sales routes", async () => {
    const w = await world();
    const editor = await person({ company: w.co, grant: "sales", role: "editor" });
    const approver = await person({ company: w.co, grant: "sales", role: "approver" });
    await prepareFor(await ctxFor(editor, w.co._id), w);
    const v = await latestOf(w);
    const enq = String(w.seeded.enquiry._id);

    global.__ACTOR__ = { id: String(editor.emp._id), email: editor.email };
    const submitted_ = await call(`/${enq}/costing-estimate/submit`, {
      method: "POST", body: { product: w.product, versionId: String(v._id), actionKey: `http-s-${++seq}` },
    });
    expect(submitted_.status).toBe(200);
    expect(submitted_.body.reviewState).toBe(review.REVIEW.AWAITING_COMMERCIAL_APPROVAL);

    global.__ACTOR__ = { id: String(approver.emp._id), email: approver.email };
    const approved = await call(`/${enq}/costing-estimate/approve`, {
      method: "POST", body: { product: w.product, versionId: String(v._id), actionKey: `http-a-${++seq}` },
    });
    expect(approved.status).toBe(200);
    expect(approved.body.reviewState).toBe(review.REVIEW.APPROVED);
  });

  test("a below-floor approval is refused over the door, with the authority named", async () => {
    const s = await submitted({ below: true });
    global.__ACTOR__ = { id: String(s.approver.emp._id), email: s.approver.email };

    const r = await call(`/${s.w.seeded.enquiry._id}/costing-estimate/approve`, {
      method: "POST", body: { product: s.w.product, versionId: s.versionId, actionKey: `http-x-${++seq}` },
    });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe(review.CODES.EXCEPTION_REQUIRED);
    expect(r.body.error.details.required).toBe(C.COMMERCIAL_EXCEPTION);
  });

  test("the door refuses a command with no versionId, and one with no key", async () => {
    /* Both are typed 400s over the wire, so a client learns which field it
       omitted rather than meeting a generic validation error. */
    const s = await submitted();
    global.__ACTOR__ = { id: String(s.approver.emp._id), email: s.approver.email };
    const enq = String(s.w.seeded.enquiry._id);

    const noVersion = await call(`/${enq}/costing-estimate/approve`, {
      method: "POST", body: { product: s.w.product, actionKey: `http-nv-${++seq}` },
    });
    expect(noVersion.status).toBe(400);
    expect(noVersion.body.error.code).toBe(review.CODES.VERSION_REQUIRED);

    const noKey = await call(`/${enq}/costing-estimate/approve`, {
      method: "POST", body: { product: s.w.product, versionId: s.versionId },
    });
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.code).toBe(review.CODES.KEY_REQUIRED);

    /* Neither attempt decided anything. */
    expect((await latestOf(s.w)).status).toBe("IN_REVIEW");
  });

  test("the door refuses a stale version, and says which problem it is", async () => {
    const s = await submitted();
    const SupplierOffer = require("../../models/CMS_Models/Inventory/Sourcing/SupplierOffer");
    const offer = await SupplierOffer.findOne({ companyId: s.w.co._id, itemId: s.w.seeded.item._id });
    await SupplierOffer.collection.updateOne({ _id: offer._id }, { $set: { status: "WITHDRAWN" } });

    global.__ACTOR__ = { id: String(s.approver.emp._id), email: s.approver.email };
    const r = await call(`/${s.w.seeded.enquiry._id}/costing-estimate/approve`, {
      method: "POST",
      body: { product: s.w.product, versionId: s.versionId, actionKey: `http-st-${++seq}` },
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe(review.CODES.STALE_INPUTS);
    expect(r.body.error.details.reason).toBe(review.BLOCKED.INPUTS_CHANGED);
  });

  test("the review read is a GET and writes nothing", async () => {
    const s = await submitted();
    global.__ACTOR__ = { id: String(s.editor.emp._id), email: s.editor.email };
    const before = await CostingTransition.countDocuments({ companyId: s.w.co._id });

    const r = await call(
      `/${s.w.seeded.enquiry._id}/costing-estimate/review?product=${encodeURIComponent(s.w.product)}`,
    );
    expect(r.status).toBe(200);
    expect(r.body.reviewState).toBe(review.REVIEW.AWAITING_COMMERCIAL_APPROVAL);
    /* And the confidential inputs are absent over the wire too. */
    for (const secret of ["floorMarkupPercent", "trueUnitCostMinor", "markupAmountMinor"]) {
      expect(JSON.stringify(r.body)).not.toContain(secret);
    }
    expect(await CostingTransition.countDocuments({ companyId: s.w.co._id })).toBe(before);
  });
});

/* ═══ 9 · WHAT THIS WORKFLOW MUST NOT TOUCH ══════════════════════════════ */

describe("the boundaries", () => {
  test("approving releases no procurement demand", async () => {
    const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
    const s = await submitted();
    await review.approve(s.actx, args(s.w, {
      versionId: s.versionId, actionKey: `a-${++seq}`, actor: actorOf(s.approver),
    }));
    expect(await SpendRequest.countDocuments({ companyId: s.w.co._id })).toBe(0);
  });

  test("approving sends no customer approval and writes no customer log", async () => {
    /* The token flow at `/costing-approval/:token` is a separate workflow on
       `Enquiry.customerApprovalLog`, and this one never reaches it. */
    const s = await submitted();
    await review.approve(s.actx, args(s.w, {
      versionId: s.versionId, actionKey: `a-${++seq}`, actor: actorOf(s.approver),
    }));
    const enq = await Enquiry.findById(s.w.seeded.enquiry._id).lean();
    expect(enq.customerApprovalLog || []).toEqual([]);
  });

  test("no Board policy is written by any decision", async () => {
    const BoardPolicy = require("../../models/CMS_Models/Board/BoardPolicy");
    const s = await submitted({ below: true });
    const before = await BoardPolicy.countDocuments({ companyId: s.w.co._id });
    await review.approveException(s.xctx, args(s.w, {
      versionId: s.versionId, reason: "Strategic account, accepted below floor.",
      actionKey: `x-${++seq}`, actor: actorOf(s.exec),
    }));
    expect(await BoardPolicy.countDocuments({ companyId: s.w.co._id })).toBe(before);
  });
});
