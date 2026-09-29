// test/merchandising/order-demand-release.integration.test.js
//
// RECOVERING AN INTERRUPTED RELEASE, AGAINST THE REAL HANDOFF.
//
// ── WHY THIS FILE EXISTS SEPARATELY ─────────────────────────────────────────
// The unit suite stubs `projectionHandoff` and proves the SAGA: that the
// command is frozen before the work runs, that a claim survives a crash, and
// that a retry replays rather than repeats.
//
// It cannot prove the thing that matters most. In production, once the first
// attempt has created spend requests, those requirements read as already
// spoken for — so a recovery that re-derived its selection would find nothing
// selectable and refuse a release that had in fact succeeded. Only the real
// projection, the real `SpendRequest` writes and the real handoff idempotency
// record show whether the replay genuinely returns the SAME requests.
//
// So this file builds a genuinely sourced costing, approves it through the
// real lifecycle, and injects a fault between the requests being created and
// the release row being finished.
//
// It needs a replica set: `costingDemand.createDraftsFromCosting` refuses to
// create the product and service requests unless it can write them together.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

let rs;
beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "demand_release_integration" });
});
afterAll(async () => {
  await mongoose.disconnect();
  if (rs) await rs.stop();
});
afterEach(() => jest.restoreAllMocks());

const {
  seedSourceBacked, configureProduction, approveFinancingPolicy, approveMarginPolicy,
  CONFIRMED_TERMS, EVERY_FAMILY, confirmCostingBrief, prepareForCosting,
} = require("../costing/helpers/sourceBacked");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const CostingPolicy = require("../../models/CMS_Models/Costing/CostingPolicy");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const Costing = require("../../models/CMS_Models/Costing/Costing");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const DemandRelease = require("../../models/CMS_Models/Merchandising/DemandRelease");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
const Employee = require("../../models/Employee");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

const release = require("../../services/merchandising/orderDemandRelease.service");
const lifecycle = require("../../services/centralCosting/lifecycle.service");
const approvedOutput = require("../../services/centralCosting/approvedOutput.service");

let seq = 0;
const ctxOf = (co) => ({ companyId: co._id, role: "approver" });

/**
 * A real Employee, because the handoff stamps the requester onto every spend
 * request it raises and refuses an actor it cannot find.
 */
async function releaser(co) {
  const n = ++seq;
  const email = `int-rel-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "M", lastName: `Mgr${n}`, email, biometricId: `IM${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DepartmentRole.create({
    departmentSlug: "merchandiser", email, role: "approver", isActive: true,
  });
  await SpCompanyMembership.create({
    companyId: co._id, email, employeeRef: emp._id, personName: "M Mgr",
  });
  return { id: String(emp._id), name: `M Mgr${n}` };
}

const refusalOf = async (fn) => {
  try { await fn(); } catch (err) { return err; }
  return null;
};

/**
 * A confirmed order whose line is priced from a REAL approved costing.
 *
 * Everything from the technical record down to the supplier quotations is the
 * ordinary fixture a costing has, so `projectionHandoff` finds genuine
 * requirements and raises genuine requests from them.
 */
async function world() {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `Int ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  await CostingPolicy.create({
    companyId: co._id, baseCurrency: "INR", roundingMode: "HALF_UP",
    sellingPriceIncrementMinor: 100, revision: 1,
  });
  await approveFinancingPolicy(co._id);
  await approveMarginPolicy(co._id, { floorMarkupPercent: "20" });

  const seeded = await seedSourceBacked(co._id, {
    ...EVERY_FAMILY, paymentTerms: { ...CONFIRMED_TERMS }, brief: null,
  });
  await configureProduction(co._id);
  await confirmCostingBrief(co._id, {
    enquiryId: seeded.enquiry._id,
    styleId: seeded.style._id,
    quantities: [{ key: "q500", quantity: "500", isPrimary: true, proposedSellingPriceExclTax: "900" }],
  });

  const costing = await Costing.create({
    companyId: co._id,
    context: seeded.context,
    contextSnapshot: { label: seeded.product },
    baseCurrency: "INR", status: "DRAFT",
  });

  const calc = await prepareForCosting(costing._id);
  if (calc.status !== 201) {
    throw new Error(`prepare refused: ${calc.status} ${JSON.stringify(calc.body).slice(0, 400)}`);
  }
  const version = await CostingVersion.findOne({ costingId: costing._id })
    .sort({ versionNumber: -1 }).lean();

  /* ── APPROVED THROUGH THE REAL LIFECYCLE, WITH A FIXTURE RETRY ────────
     State and evidence commit together, which needs a transaction. The
     in-memory replica set gives those a 5ms lock timeout, and a
     `TransientTransactionError` is exactly what Mongo tells a client to
     retry — so the FIXTURE retries, with a fresh key because the old one may
     have been abandoned. Nothing about the production path changes; the
     alternative is a suite that fails on machine speed rather than on
     behaviour. The same workaround is documented in
     `test/costing/projection-handoff.route.test.js`. */
  const transition = async (verb, extra) => {
    let last = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        return await lifecycle[verb]({
          companyId: co._id, costingId: costing._id, versionId: version._id,
          actor: { id: `fixture-${n}`, name: "Fixture" },
          idempotencyKey: `int-${verb}-${n}-${attempt}`,
          target: `costing:${costing._id}:version:${version._id}`,
          ...extra,
        });
      } catch (err) {
        last = err;
        if (!/lock|Transient|WriteConflict/i.test(String(err.message))) throw err;
        await new Promise((r) => setTimeout(r, 60 * (attempt + 1)));
      }
    }
    throw last;
  };
  await transition("submitForReview", {});
  await transition("approve", { note: "Approved for the integration fixture." });

  const approved = await CostingVersion.findById(version._id).lean();
  const scenario = (approved.scenarios || []).find((s) => s.isPrimary) || approved.scenarios[0];
  const floorMinor = scenario.floor.floorPriceMinor;

  const request = await CustomerRequest.create({
    requestId: `REQ-INT-${n}`,
    status: "quotation_sales_approved",
    orderOrigin: "customer",
    customerInfo: { name: `Buyer ${n}` },
    items: [{
      stockItemName: seeded.product,
      totalQuantity: Number(scenario.quantity),
      sampleStyleId: seeded.style._id,
    }],
    quotations: [{
      quotationNumber: `Q-INT-${n}`,
      status: "sales_approved",
      currency: "INR",
      items: [{
        itemName: seeded.product,
        sampleStyleId: seeded.style._id,
        quantity: Number(scenario.quantity),
        unitPrice: floorMinor / 100,
        basePrice: floorMinor / 100,
        costingSource: {
          source: "APPROVED_COSTING",
          costingId: costing._id,
          costingVersionId: approved._id,
          costingVersionNumber: approved.versionNumber,
          sampleStyleId: seeded.style._id,
          scenarioKey: scenario.key,
          quantity: String(scenario.quantity),
          priceTier: "floor",
          unitPriceMinor: floorMinor,
          currency: "INR",
          approvedAt: new Date(),
          fingerprint: approvedOutput.fingerprintOf({
            costingId: String(costing._id),
            versionId: String(approved._id),
            scenarioKey: scenario.key,
            tier: "floor",
            priceMinor: floorMinor,
            currency: "INR",
          }),
        },
      }],
    }],
  });

  const saved = await CustomerRequest.findById(request._id).lean();
  return {
    co, seeded, costing, actor: await releaser(co),
    orderId: String(request._id),
    lineRef: String(saved.items[0].lineRef),
    costingVersionId: String(approved._id),
  };
}

const args = (w, over = {}) => ({
  orderId: w.orderId, lineRef: w.lineRef, costingVersionId: w.costingVersionId,
  actor: w.actor, ...over,
});

/* ═══════════════════════════════════════════════════════════════════════ */

describe("the real handoff, interrupted", () => {
  test("a release raises genuine spend requests", async () => {
    /* The baseline the recovery test rests on. If this stops producing real
       requests, the recovery assertions below would pass vacuously. */
    const w = await world();
    const out = await release.release(ctxOf(w.co), args(w));
    expect(out.outcome).toBe("RELEASED");

    const raised = await SpendRequest.find({ companyId: w.co._id }).lean();
    expect(raised.length).toBeGreaterThan(0);
    /* Drafts, and nothing further along. */
    expect(raised.every((r) => r.status === "draft")).toBe(true);

    const row = await DemandRelease.findOne({ companyId: w.co._id }).lean();
    expect(row.state).toBe("RELEASED");
    expect(row.demand.spendRequestIds.map(String).sort())
      .toEqual(raised.map((r) => String(r._id)).sort());
  });

  test("a crash after the requests exist replays to the SAME requests", async () => {
    /* ── THE CASE THE MOCKED SUITE CANNOT REACH ───────────────────────
       After the first attempt, the real projection reports these
       requirements as already spoken for. A recovery that re-derived its
       selection would find nothing selectable and refuse a release that had
       in fact succeeded — so the replay must use the FROZEN command. */
    const w = await world();

    const realUpdate = DemandRelease.updateOne.bind(DemandRelease);
    jest.spyOn(DemandRelease, "updateOne").mockImplementationOnce(() => {
      throw new Error("simulated crash after the requests were created");
    });

    const crashed = await refusalOf(() => release.release(ctxOf(w.co), args(w)));
    expect(crashed).toBeTruthy();

    /* Real requests exist; the claim is unfinished. */
    const afterCrash = await SpendRequest.find({ companyId: w.co._id }).lean();
    expect(afterCrash.length).toBeGreaterThan(0);
    const firstIds = afterCrash.map((r) => String(r._id)).sort();

    const claims = await DemandRelease.find({ companyId: w.co._id }).lean();
    expect(claims).toHaveLength(1);
    expect(claims[0].state).toBe("PENDING");
    expect(claims[0].handoffCommand.requirementIds.length).toBeGreaterThan(0);
    expect(claims[0].handoffCommand.idempotencyKey).toMatch(/^demand-release:/);

    DemandRelease.updateOne = realUpdate;

    /* ── AND SELECTION IS NOW GENUINELY EMPTY ─────────────────────────
       Proved rather than assumed: the same projection the recovery would
       have re-derived from reports nothing selectable. */
    const projectionHandoff = require("../../services/centralCosting/projectionHandoff.service");
    const reprepared = await projectionHandoff.prepare(
      { companyId: w.co._id, actorId: w.actor.id, actorName: w.actor.name, capabilitySet: new Set() },
      { costingId: w.costing._id, scenarioKey: claims[0].scenarioKey },
    );
    expect((reprepared.requirements || []).filter((r) => r.selectable)).toHaveLength(0);

    const recovered = await release.release(ctxOf(w.co), args(w));
    expect(recovered.outcome).toBe("RECOVERED");
    expect(recovered.releaseId).toBe(String(claims[0]._id));

    /* ── THE SAME REQUESTS, AND NO SECOND SET ─────────────────────────
       The real handoff recognised its own idempotency record. */
    const afterRetry = await SpendRequest.find({ companyId: w.co._id }).lean();
    expect(afterRetry.map((r) => String(r._id)).sort()).toEqual(firstIds);

    const rows = await DemandRelease.find({ companyId: w.co._id }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("RELEASED");
    expect(rows[0].demand.spendRequestIds.map(String).sort()).toEqual(firstIds);
  });

  test("an ordinary retry after success creates nothing further", async () => {
    const w = await world();
    const first = await release.release(ctxOf(w.co), args(w));
    const before = await SpendRequest.countDocuments({ companyId: w.co._id });

    const again = await release.release(ctxOf(w.co), args(w));
    expect(again.outcome).toBe("ALREADY_RELEASED");
    expect(again.releaseId).toBe(first.releaseId);
    expect(await SpendRequest.countDocuments({ companyId: w.co._id })).toBe(before);
    expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════ */

describe("a committed claim outranks today's sources", () => {
  const projectionHandoff = require("../../services/centralCosting/projectionHandoff.service");

  /** Make every live commercial source refuse, without touching the claim. */
  async function spoilTheSources(w) {
    await CustomerRequest.updateOne({ _id: w.orderId }, {
      $set: {
        status: "enquiry",
        "items.0.totalQuantity": 4321,
        "quotations.0.items.0.costingSource.fingerprint": "no-longer-matching",
      },
    });
  }

  test("a changed order and quotation cannot strand a started command", async () => {
    /* ── THE GAP THIS CLOSES ──────────────────────────────────────────
       The claim commits, the handoff raises real requests, and then the
       order moves on — a status change, a revised quantity, a re-issued
       quotation. Revalidating live sources before looking for the claim
       meant the retry was refused and the started command could never be
       finished by anybody, while its demand sat in Requests unaccounted
       for. */
    const w = await world();

    const realUpdate = DemandRelease.updateOne.bind(DemandRelease);
    jest.spyOn(DemandRelease, "updateOne").mockImplementationOnce(() => {
      throw new Error("simulated crash after the requests were created");
    });
    const crashed = await refusalOf(() => release.release(ctxOf(w.co), args(w)));
    expect(crashed).toBeTruthy();
    DemandRelease.updateOne = realUpdate;
    jest.restoreAllMocks();

    const firstIds = (await SpendRequest.find({ companyId: w.co._id }).lean())
      .map((r) => String(r._id)).sort();
    expect(firstIds.length).toBeGreaterThan(0);

    await spoilTheSources(w);

    /* ── PROVED, NOT ASSUMED: A NEW ATTEMPT WOULD NOW BE REFUSED ──────
       If the sources still verified, the recovery below would pass without
       demonstrating anything. */
    const now = await release.stateFor(ctxOf(w.co), args(w));
    expect(now.subject).toBeNull();
    expect(now.blocked).toBeTruthy();

    const recovered = await release.release(ctxOf(w.co), args(w));
    expect(recovered.outcome).toBe("RECOVERED");

    /* ── AND NOTHING WAS RAISED A SECOND TIME ─────────────────────────── */
    const afterIds = (await SpendRequest.find({ companyId: w.co._id }).lean())
      .map((r) => String(r._id)).sort();
    expect(afterIds).toEqual(firstIds);

    const rows = await DemandRelease.find({ companyId: w.co._id }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("RELEASED");
    expect(rows[0].demand.spendRequestIds.map(String).sort()).toEqual(firstIds);

    /* An exact retry after that answers from the record, still without
       asking whether today's quotation agrees. */
    const again = await release.release(ctxOf(w.co), args(w));
    expect(again.outcome).toBe("ALREADY_RELEASED");
    expect(again.releaseId).toBe(recovered.releaseId);
    expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(1);
    expect(await SpendRequest.countDocuments({ companyId: w.co._id })).toBe(firstIds.length);
  });

  test("a colleague's retry finishes the action without becoming its author", async () => {
    /* ── WHO COMMITTED THE COMPANY TO BUY ─────────────────────────────
       Holding the release grant lets somebody finish an interrupted
       command. It does not make them the person who started it. Replaying
       under the retrying user would have authored the spend requests to
       them while the release row still named the initiator — two records
       disagreeing about who made a purchasing commitment. */
    const w = await world();
    const initiator = w.actor;

    jest.spyOn(projectionHandoff, "handoff").mockImplementationOnce(() => {
      throw new Error("simulated crash before any request was created");
    });
    const crashed = await refusalOf(() => release.release(ctxOf(w.co), args(w)));
    expect(crashed).toBeTruthy();
    jest.restoreAllMocks();

    expect(await SpendRequest.countDocuments({ companyId: w.co._id })).toBe(0);
    const claim = await DemandRelease.findOne({ companyId: w.co._id }).lean();
    expect(claim.state).toBe("PENDING");
    expect(String(claim.releasedByActorId)).toBe(String(initiator.id));

    /* A different, equally authorised person presses retry. */
    const colleague = await releaser(w.co);
    expect(String(colleague.id)).not.toBe(String(initiator.id));

    const recovered = await release.release(ctxOf(w.co), args(w, { actor: colleague }));
    expect(recovered.outcome).toBe("RECOVERED");

    const raised = await SpendRequest.find({ companyId: w.co._id }).lean();
    expect(raised.length).toBeGreaterThan(0);
    /* Every request names the initiator, not the retrying user. */
    for (const r of raised) {
      expect(String(r.requestedBy)).toBe(String(initiator.id));
      expect(String(r.requestedBy)).not.toBe(String(colleague.id));
    }

    const row = await DemandRelease.findById(recovered.releaseId).lean();
    expect(String(row.releasedByActorId)).toBe(String(initiator.id));
    expect(row.releasedByActorName).toBe(initiator.name);
    /* One claim, one demand set. */
    expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(1);
    expect(row.demand.spendRequestIds.map(String).sort())
      .toEqual(raised.map((r) => String(r._id)).sort());
  });
});

/* ═══════════════════════════════════════════════════════════════════════ */

describe("released from the Execution File, against the real handoff", () => {
  const producer = require("../../services/sales/merchandisingHandover.service");
  const salesDelivery = require("../../services/integration/salesHandoverDelivery.service");
  const executionSvc = require("../../services/merchandising/execution.service");
  const fileRelease = require("../../services/merchandising/fileDemandRelease.service");
  const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");

  /** Sales issues the line, Merchandising accepts it, and a file exists. */
  async function filed(w) {
    const { correlationId } = await producer.issue({ companyId: w.co._id }, {
      requestId: w.orderId,
      lineId: w.lineRef,
      body: {
        expectedCurrentVersionNo: 0,
        deliveries: [{ committedDeliveryDate: "2026-12-15", quantity: 500 }],
      },
      actor: { name: "Sales Person" },
    });
    await salesDelivery.deliverPending({ companyId: w.co._id, correlationId });

    const ctx = { companyId: w.co._id, role: "approver", actorId: w.actor.id };
    const inbox = await executionSvc.listHandovers(ctx, {});
    const handoverId = inbox.rows[0].id;
    const { file } = await executionSvc.acceptHandover(ctx, {
      id: handoverId, actor: { id: w.actor.id, name: w.actor.name },
    });
    return String(file.id);
  }

  test("the file resolves the exact command and raises genuine DRAFT requests", async () => {
    /* ── THE WHOLE CHAIN, WITH NOTHING STUBBED ────────────────────────
       A real approved costing, a real quotation stamped from it, a real
       Sales handover, a real acceptance — and then a release addressed by
       NOTHING but the file id and the handle the read returned. */
    const w = await world();
    const fileId = await filed(w);
    const ctx = ctxOf(w.co);

    const before = await ExecutionFile.findById(fileId).lean();

    const read = await fileRelease.stateForFile(ctx, { fileId });
    expect(read.eligible).toBe(true);
    expect(read.permitted.release).toBe(true);
    expect(read.expectedVersion).toMatch(/^[0-9a-f]{32}$/);
    /* The read exposes no internal identity and no money. */
    const raw = JSON.stringify(read);
    expect(raw).not.toContain(w.costingVersionId);
    expect(raw).not.toContain(w.orderId);
    expect(raw).not.toMatch(/markup|floorPrice|unitCost|supplier/i);

    const out = await fileRelease.releaseFromFile(ctx, {
      fileId, expectedVersion: read.expectedVersion, actor: w.actor,
    });
    expect(out.outcome).toBe("RELEASED");

    /* ── GENUINE DRAFTS, AND NOTHING FURTHER ALONG ────────────────────── */
    const raised = await SpendRequest.find({ companyId: w.co._id }).lean();
    expect(raised.length).toBeGreaterThan(0);
    expect(raised.every((r) => r.status === "draft")).toBe(true);

    /* ── AND AGAINST THE IDENTITIES THE FILE RESOLVED ─────────────────── */
    const row = await DemandRelease.findOne({ companyId: w.co._id }).lean();
    expect(String(row.orderId)).toBe(w.orderId);
    expect(row.lineRef).toBe(w.lineRef);
    expect(String(row.costingVersionId)).toBe(w.costingVersionId);
    expect(row.demand.spendRequestIds.map(String).sort())
      .toEqual(raised.map((r) => String(r._id)).sort());

    /* The file itself was not touched by reading or releasing. */
    const file = await ExecutionFile.findById(fileId).lean();
    expect(file.revision).toBe(before.revision);
    expect(file.updatedAt).toEqual(before.updatedAt);
  });

  test("an exact retry through the file creates no second demand", async () => {
    const w = await world();
    const fileId = await filed(w);
    const ctx = ctxOf(w.co);

    const read = await fileRelease.stateForFile(ctx, { fileId });
    const first = await fileRelease.releaseFromFile(ctx, {
      fileId, expectedVersion: read.expectedVersion, actor: w.actor,
    });
    const count = await SpendRequest.countDocuments({ companyId: w.co._id });

    const again = await fileRelease.releaseFromFile(ctx, {
      fileId, expectedVersion: read.expectedVersion, actor: w.actor,
    });
    expect(again.outcome).toBe("ALREADY_RELEASED");
    expect(again.releaseId).toBe(first.releaseId);
    expect(await SpendRequest.countDocuments({ companyId: w.co._id })).toBe(count);
    expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(1);
  });
});
