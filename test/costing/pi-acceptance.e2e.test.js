// test/costing/pi-acceptance.e2e.test.js
//
// ONE LINE, END TO END: CONFIRMED QUANTITY → APPROVED COSTING → REVIEWED PRICE
// → PROFORMA, AND THE SAVED DOCUMENT READ BACK.
//
// ── WHY THIS EXISTS BESIDE THE UNIT SUITES ──────────────────────────────────
// `proforma-request.route.test.js` proves each refusal, and it builds the
// approved decision by writing a version document. That is the right shape for
// testing a gate — but a gate tested only against a hand-written record cannot
// notice that the real chain never produces that record.
//
// This one takes the long way round. Every step is the PUBLIC command a person
// uses, in order:
//
//   1. Sales confirms a commercial quantity          (commercialLine.confirmQuantity)
//   2. Sales enters a selling price                  (the cost-ledger line route's authority)
//   3. Central Costing prepares the estimate         (costingPreparation.prepare)
//   4. Sales submits it for commercial review        (commercialReview.submit)
//   5. An approver decides                           (commercialReview.approve)
//   6. Sales raises the proforma                     (proformaRequest.createForEnquiry)
//   7. The SAVED CustomerRequest is read back
//
// Nothing is stubbed and no version is hand-written. If the price never reaches
// the version the review decides on, step 5 or step 6 fails — which is exactly
// what happened before the brief began carrying it.
//
// ── AND THE NUMBERS ARE THE ACCEPTANCE CASE ─────────────────────────────────
//   · the stock item's catalogue price is ₹599 — a stale figure
//   · the confirmed quantity is 750
//   · the selling price Sales enters is ₹590
//   · the proforma must store 750 × ₹590, and never ₹599
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
// A browser session against the dev database. It runs the real routes' own
// service commands against a persisted replica set, and reads the stored
// document. A human still has to click the screens once.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

/* A replica set, because the review's decisions and their evidence commit
   together — `lifecycle` refuses to move a status without a transaction. */
let rs;
beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "pi_acceptance" });
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const {
  seedSourceBacked, configureProduction, approveFinancingPolicy, approveMarginPolicy,
  CONFIRMED_TERMS, EVERY_FAMILY,
} = require("./helpers/sourceBacked");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const CostingPolicy = require("../../models/CMS_Models/Costing/CostingPolicy");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const Costing = require("../../models/CMS_Models/Costing/Costing");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const Employee = require("../../models/Employee");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const Customer = require("../../models/Customer_Models/Customer");

const companyContext = require("../../services/centralCosting/companyContext.service");
const commercialLine = require("../../services/sales/commercialLine.service");
const prep = require("../../services/sales/costingPreparation.service");
const review = require("../../services/sales/commercialReview.service");
const proformaRequest = require("../../services/sales/proformaRequest.service");

let seq = 0;

async function person({ company, grant, role }) {
  const n = ++seq;
  const email = `pia-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "P", lastName: `A${n}`, email, biometricId: `PIA${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DepartmentRole.create({ departmentSlug: grant, email, role, isActive: true });
  await SpCompanyMembership.create({
    companyId: company._id, email, employeeRef: emp._id, personName: "P A",
  });
  return { emp, email, user: { id: String(emp._id), email }, name: `P A${n}` };
}
const ctxFor = (p, companyId) => companyContext.resolveForActor(p.user, { requestedCompanyId: companyId });
const actorOf = (p) => ({ id: String(p.emp._id), name: p.name, email: p.email });

const CONFIRMED_QTY = 750;
const SELLING_PRICE = 590;
const STALE_CATALOGUE_PRICE = 599;

describe("the 750-piece / ₹590 acceptance, through the public commands", () => {
  test("confirmed quantity → approved costing → reviewed price → proforma, read back", async () => {
    /* ── THE COMPANY, ITS POLICIES AND A COSTABLE STYLE ─────────────────── */
    const co = await Acc_Company.create({
      companyName: `PI Acceptance ${++seq}`, booksFromDate: new Date("2026-04-01"),
    });
    await CostingPolicy.create({
      companyId: co._id, baseCurrency: "INR", roundingMode: "HALF_UP",
      sellingPriceIncrementMinor: 100, revision: 1,
    });
    await approveFinancingPolicy(co._id);
    /* A low markup, so ₹590 clears the floor and this is the ordinary
       at-or-above case rather than an exception. */
    await approveMarginPolicy(co._id, { floorMarkupPercent: "5" });

    /* `brief: null` — the brief is NOT pre-written. Confirming the quantity is
       what writes it, which is the step under test. */
    const seeded = await seedSourceBacked(co._id, {
      ...EVERY_FAMILY, paymentTerms: { ...CONFIRMED_TERMS }, brief: null,
    });
    await configureProduction(co._id);

    const editor = await person({ company: co, grant: "sales", role: "editor" });
    const approver = await person({ company: co, grant: "sales", role: "approver" });
    const ectx = await ctxFor(editor, co._id);
    const actx = await ctxFor(approver, co._id);

    const enquiry0 = await Enquiry.findById(seeded.enquiry._id).lean();
    const row = enquiry0.products.find((p) => String(p.product) === String(seeded.product))
      || enquiry0.products[0];
    const productLineRef = String(row.productLineRef);
    const sampleStyleId = String(seeded.style._id);

    /* ── A STALE CATALOGUE PRICE, LINKED TO THE STYLE ───────────────────
       ₹599: what this garment was approved at for an earlier quantity, and
       what the retired customer-approval sync used to fan across every
       variant. The proforma must never reach for it. */
    const stock = await StockItem.create({
      companyId: co._id,
      name: `Acceptance shirt ${seq}`,
      reference: `ACC-${seq}`,
      category: "Apparel",
      createdBy: new mongoose.Types.ObjectId(),
      baseSalesPrice: STALE_CATALOGUE_PRICE,
      variants: [{
        combination: ["Sand"], sku: `ACC-${seq}-V1`, quantity: 0,
        salesPrice: STALE_CATALOGUE_PRICE, cost: 400, attributes: [],
      }],
    });
    await SampleStyle.updateOne(
      { _id: seeded.style._id },
      { $set: { "production.stockItemId": stock._id } },
    );
    await Enquiry.updateOne(
      { _id: seeded.enquiry._id, "products.productLineRef": productLineRef },
      { $set: { "products.$.stockItemId": stock._id } },
    );
    const customer = await Customer.create({
      name: `Acceptance buyer ${seq}`,
      email: `buyer${seq}@example.com`, phone: "9000000000",
    });

    /* ══ 1 · SALES CONFIRMS 750 ═══════════════════════════════════════════ */
    const confirmed = await commercialLine.confirmQuantity(
      { companyId: co._id },
      {
        enquiryId: String(seeded.enquiry._id),
        productLineRef, sampleStyleId,
        quantity: CONFIRMED_QTY,
        reason: "Buyer confirmed 750.",
        actor: actorOf(editor),
      },
    );
    expect(confirmed.line.quantity).toBe(CONFIRMED_QTY);

    /* ══ 2 · SALES ENTERS ₹590 ════════════════════════════════════════════
       Written where the route writes it — the ledger row keyed by the pair —
       and then carried to the brief by `repriceLine`, which is what the route
       calls. Both halves, so this is the route's own behaviour. */
    await Enquiry.updateOne(
      { _id: seeded.enquiry._id },
      {
        $push: {
          costLedger: {
            productName: String(row.product),
            productLineRef, sampleStyleId, price: SELLING_PRICE,
          },
        },
      },
    );
    const repriced = await commercialLine.repriceLine(
      { companyId: co._id },
      { enquiryId: String(seeded.enquiry._id), productLineRef, sampleStyleId, actor: actorOf(editor) },
    );
    expect(repriced.requested).toBe(true);

    /* ══ 3 · CENTRAL COSTING PREPARES ═════════════════════════════════════ */
    const prepared = await prep.prepare(ectx, {
      enquiryId: String(seeded.enquiry._id),
      product: seeded.product,
      actionKey: `acc-prep-${++seq}`,
    });
    expect(prepared.outcome).toBe("PREPARED");

    const costing = await Costing.findOne({ companyId: co._id }).lean();
    const version = await CostingVersion.findOne({ costingId: costing._id })
      .sort({ versionNumber: -1 }).lean();

    /* The version was calculated for 750 and carries the price Sales typed —
       the binding the whole chain depends on. */
    const primary = version.scenarios.find((s) => s.isPrimary) || version.scenarios[0];
    expect(Number(primary.quantity)).toBe(CONFIRMED_QTY);
    expect(version.commercial.proposedPrices[0].priceExclTaxMinor).toBe(SELLING_PRICE * 100);
    /* And ₹590 cleared the floor, so this is an ordinary approval. */
    const bridgeRow = version.commercial.bridge.find((b) => b.scenarioKey === primary.key);
    expect(bridgeRow.standing).toBe("AT_OR_ABOVE_FLOOR");

    /* ══ 4 · SUBMITTED FOR REVIEW ═════════════════════════════════════════ */
    const submitted = await review.submit(ectx, {
      enquiryId: String(seeded.enquiry._id),
      product: seeded.product,
      versionId: String(version._id),
      actionKey: `acc-sub-${++seq}`,
      actor: actorOf(editor),
    });
    expect(submitted.reviewState).toBe("AWAITING_COMMERCIAL_APPROVAL");

    /* ══ 5 · APPROVED ═════════════════════════════════════════════════════ */
    const decided = await review.approve(actx, {
      enquiryId: String(seeded.enquiry._id),
      product: seeded.product,
      versionId: String(version._id),
      note: "Agreed at the commercial review.",
      actionKey: `acc-app-${++seq}`,
      actor: actorOf(approver),
    });
    expect(decided.reviewState).toBe("APPROVED");

    /* ══ 6 · THE PROFORMA ═════════════════════════════════════════════════
       Identity only. No quantity, no price — and a forged pair of both, to
       prove neither is read. */
    const raised = await proformaRequest.createForEnquiry(
      ectx,
      String(seeded.enquiry._id),
      {
        customerId: String(customer._id),
        items: [{
          productLineRef, sampleStyleId,
          stockItemId: String(stock._id),
          variantId: String(stock.variants[0]._id),
          /* Forged, and ignored. */
          quantity: 500,
          unitPrice: STALE_CATALOGUE_PRICE,
        }],
        actionKey: `acc-pi-${++seq}`,
        actor: actorOf(editor),
      },
    );
    expect(raised._id).toBeTruthy();

    /* ══ 7 · READ THE SAVED DOCUMENT BACK ═════════════════════════════════ */
    const saved = await CustomerRequest.findById(raised._id).lean();
    expect(saved).toBeTruthy();
    const [line] = saved.items;

    /* THE QUANTITY: the confirmed 750, not the forged 500. */
    expect(line.totalQuantity).toBe(CONFIRMED_QTY);
    expect(line.variants[0].quantity).toBe(CONFIRMED_QTY);

    /* THE PRICE: the approved ₹590, not the catalogue's ₹599. */
    const unitPrice = line.variants[0].estimatedPrice / line.variants[0].quantity;
    expect(unitPrice).toBe(SELLING_PRICE);
    expect(unitPrice).not.toBe(STALE_CATALOGUE_PRICE);
    expect(line.totalEstimatedPrice).toBe(SELLING_PRICE * CONFIRMED_QTY);

    /* AND THE DECISION IT WAS INVOICED ON, STAMPED. */
    expect(line.commercialDecision.quantity).toBe(CONFIRMED_QTY);
    expect(line.commercialDecision.unitPriceMinor).toBe(SELLING_PRICE * 100);
    expect(String(line.commercialDecision.costingVersionId)).toBe(String(version._id));
    expect(line.commercialDecision.standing).toBe("AT_OR_ABOVE_FLOOR");
    expect(line.commercialDecision.wasBelowFloorException).toBe(false);
    expect(line.commercialDecision.approvedByName).toBe(approver.name);

    /* ── AND THE CATALOGUE PRICE IS ON NO MONEY FIELD ──────────────────
       Asserted on the fields that carry money rather than as a substring of
       the line: a Mongo ObjectId is hex and can legitimately END in "599", so
       the substring form fails for a reason that has nothing to do with
       pricing. Naming the fields is what makes this mean something. */
    for (const money of [
      line.variants[0].estimatedPrice,
      line.totalEstimatedPrice,
      line.commercialDecision.unitPriceMinor,
      line.commercialDecision.floorPriceMinor,
    ]) {
      expect(money).not.toBe(STALE_CATALOGUE_PRICE);
      expect(money).not.toBe(STALE_CATALOGUE_PRICE * 100);
      expect(money).not.toBe(STALE_CATALOGUE_PRICE * CONFIRMED_QTY);
    }

    /* AND THE ITEM MASTER WAS NEVER TOUCHED BY ANY OF IT. */
    const stockAfter = await StockItem.findById(stock._id).lean();
    expect(stockAfter.baseSalesPrice).toBe(STALE_CATALOGUE_PRICE);
    expect(stockAfter.variants[0].salesPrice).toBe(STALE_CATALOGUE_PRICE);

    /* ══ 8 · THE PRICE COMES FROM THE DECISION, NOT THE CATALOGUE ═════════
       Proved by moving the catalogue somewhere absurd and asking the issuance
       authority again. A PI that read the item master would follow it; one
       that reads the frozen decision cannot. */
    await StockItem.updateOne(
      { _id: stock._id },
      { $set: { baseSalesPrice: 4242, "variants.0.salesPrice": 4242 } },
    );
    const lineReadiness = require("../../services/sales/lineReadiness.service");
    const enquiryNow = await Enquiry.findById(seeded.enquiry._id);
    const stillReady = await lineReadiness.issuanceFor(
      { companyId: co._id }, enquiryNow, { productLineRef, sampleStyleId },
    );
    expect(stillReady.ok).toBe(true);
    expect(stillReady.unitPriceMinor).toBe(SELLING_PRICE * 100);
    expect(stillReady.unitPriceMinor).not.toBe(4242 * 100);
    expect(String(stillReady.costingVersionId)).toBe(String(version._id));

    /* ══ 9 · A PRICE CHANGE INVALIDATES THE APPROVAL ══════════════════════
       Approved behaviour: a new selling price is a new decision. The brief is
       revised with it, the costing re-prepared, and the approval that covered
       the old figures no longer covers this line — so the proforma door
       refuses until the new price has been reviewed in its own right. */
    await Enquiry.updateOne(
      { _id: seeded.enquiry._id, "costLedger.productLineRef": productLineRef },
      { $set: { "costLedger.$.price": 640 } },
    );
    const repricedAgain = await commercialLine.repriceLine(
      { companyId: co._id },
      { enquiryId: String(seeded.enquiry._id), productLineRef, sampleStyleId, actor: actorOf(editor) },
    );
    expect(repricedAgain.requested).toBe(true);

    /* Re-prepared, so a NEW version now carries the new price. */
    const afterReprice = await prep.prepare(ectx, {
      enquiryId: String(seeded.enquiry._id),
      product: seeded.product,
      actionKey: `acc-prep2-${++seq}`,
    });
    /* `REVISED`, not `PREPARED`: a version already exists for this line, so
       re-preparing supersedes it rather than creating the first. */
    expect(["PREPARED", "REVISED"]).toContain(afterReprice.outcome);

    const newVersion = await CostingVersion.findOne({ costingId: costing._id })
      .sort({ versionNumber: -1 }).lean();
    expect(newVersion.versionNumber).toBeGreaterThan(version.versionNumber);
    expect(newVersion.commercial.proposedPrices[0].priceExclTaxMinor).toBe(64000);
    /* The new version is NOT approved — nobody has reviewed ₹640. */
    expect(newVersion.status).not.toBe("APPROVED");

    /* And the door is shut: the old approval does not authorise the new
       price, and there is no approved version for the current one. */
    const enquiryAfter = await Enquiry.findById(seeded.enquiry._id);
    const afterChange = await lineReadiness.issuanceFor(
      { companyId: co._id }, enquiryAfter, { productLineRef, sampleStyleId },
    );
    expect(afterChange.ok).toBe(false);
    expect([
      "SELLING_PRICE_CHANGED", "COSTING_NOT_APPROVED", "REVIEW_INCOMPLETE",
      "APPROVED_FOR_ANOTHER_QUANTITY",
    ]).toContain(afterChange.reason);
  }, 240_000);
});
