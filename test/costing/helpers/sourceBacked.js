"use strict";
/**
 * test/costing/helpers/sourceBacked.js
 *
 * THE MINIMUM A REAL COSTING NEEDS.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Every suite used `context: { type: "ADHOC" }` as the cheap way to get a
 * costing to work on — two lines, no fixtures, and a version could be built
 * from whatever the test posted. Closing ADHOC removed that shortcut, and
 * rightly: it was the same shortcut a user had, and the whole point is that
 * nobody produces an approvable cost without the sources behind it.
 *
 * So the shortcut becomes a fixture. This seeds an enquiry product, the sales
 * journey that proves its company, a technical record, a supplier quotation
 * and a complete costing policy — enough that `POST /:id/versions` with
 * `lines: []` produces a costed version, deterministically.
 *
 * ── DETERMINISTIC BY DESIGN ─────────────────────────────────────────────────
 * The defaults below are chosen so the arithmetic is checkable by hand:
 *
 *   material  1 Metre per garment at ₹100.00           = 10000 minor
 *   labour    SAM 1.5, salary 18,000, burden 18%,
 *             9,000 productive minutes                 =   354 minor
 *                                                        ───────────
 *   direct cost per garment                              10354 minor
 *
 * A suite that needs different numbers passes them; a suite that only needs A
 * costing to exist takes the defaults and can assert on them.
 *
 * ── TEST CODE ONLY ──────────────────────────────────────────────────────────
 * Nothing here is imported by production code, and no production path has been
 * given a test-only bypass. Historical ADHOC records are seeded by writing the
 * document, which is what they are — history — rather than by reopening the
 * route that is now closed.
 */

const mongoose = require("mongoose");

const Enquiry = require("../../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../../models/CMS_Models/Sales/SalesJourney");
const Account = require("../../../models/CMS_Models/Sales/Account");
const SampleStyle = require("../../../models/CMS_Models/Sales/SampleStyle");
const CostingPolicy = require("../../../models/CMS_Models/Costing/CostingPolicy");
const Costing = require("../../../models/CMS_Models/Costing/Costing");
const RawItem = require("../../../models/CMS_Models/Inventory/Products/RawItem");
const Unit = require("../../../models/CMS_Models/Inventory/Configurations/Unit");
const Vendor = require("../../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const SupplierOffer = require("../../../models/CMS_Models/Inventory/Sourcing/SupplierOffer");
const ServiceSupplierOffer = require("../../../models/CMS_Models/Inventory/Sourcing/ServiceSupplierOffer");
const Service = require("../../../models/CMS_Models/Inventory/Services/Service");

let seq = 0;

/* ── WHAT STORE SAID ABOUT WHERE A QUOTED INPUT COMES FROM ─────────────────
 *
 * Every purchased line now needs this answer before customs duty can be
 * positioned, and the whole point of the rule is that NOT ANSWERING IS NOT AN
 * ANSWER — an offer with no `sourcing` is not a domestic supply and is not
 * duty-free. So the shape is built in one place, and the three cases are all
 * reachable on purpose:
 *
 *   "DOMESTIC"  bought in India. No customs entry, so no duty, and the
 *               duty-inclusion question does not apply and is not written.
 *   "IMPORTED"  carries the origin and whether the rate already includes the
 *               duty. A fixture proving the blocking cases passes `""` for
 *               either and gets the gap it is asserting against.
 *   null / ""   NO `sourcing` sub-document at all — the shape of every offer
 *               written before Store was asked. Fixtures about missing data
 *               opt into it deliberately; nothing gets it by forgetting.
 */
const sourcingFor = (type, { countryOfOrigin = "", dutyInQuotedRate = "" } = {}) => {
  if (!type) return {};
  if (type !== "IMPORTED") return { sourcing: { type } };
  return {
    sourcing: {
      type,
      ...(countryOfOrigin ? { countryOfOrigin } : {}),
      ...(dutyInQuotedRate ? { dutyInQuotedRate } : {}),
    },
  };
};

/** The assumptions a labour rate rests on, and the tax position a quotation needs. */
const PRODUCTION_POLICY = Object.freeze({
  productiveMinutesPerMonth: 9000,
  employerBurdenPercent: "18",
  machineBurdenTreatment: "IN_OVERHEAD",
  inputGstTreatment: "RECOVERABLE",
});

/** What the defaults cost, so a suite can assert without recomputing. */
const EXPECTED = Object.freeze({
  materialRateMinor: 10000,   // ₹100.00 per Metre, 1 Metre per garment
  labourRateMinor: 354,       // 18,000 x 1.18 / 9,000 x 1.5
  directPerGarmentMinor: 10354,
  /* With a 12% DIRECT_PLUS_FIXED overhead and nothing else. */
  overheadPerGarmentMinor: 1242,
  unitCostMinor: 11596,
});

/**
 * An enquiry product with everything behind it.
 *
 * @param {ObjectId} companyId
 * @param {object}  [opts]
 * @param {string}  [opts.product]            product name on the enquiry
 * @param {boolean} [opts.withOperation=true] seed an operation
 * @param {boolean} [opts.withMaterial=true]  seed a material + its quotation
 * @param {boolean} [opts.withQuotation=true] seed the supplier quotation
 * @param {number}  [opts.samSeconds=90]      operation time
 * @param {number}  [opts.salary=18000]       operator monthly net salary
 * @param {number}  [opts.rateMinor=10000]    quoted material rate per unit
 * @param {string}  [opts.consumption="1"]    material per garment
 * @param {boolean} [opts.secondStyle=false]  seed a sibling variant, for
 *                                            ambiguity tests
 * @param {object}  [opts.item]               an existing RawItem to consume,
 *                                            for a suite that has already
 *                                            built its own Store fixtures
 * @param {string}  [opts.uom="Metre"]        the unit the consumption is in
 * @param {object}  [opts.packaging]          `{ quantity, unit, basis, rateMinor,
 *                                            moq, orderMultiple, tiers }` — a
 *                                            packaging requirement and the
 *                                            quotation behind it
 * @param {object}  [opts.service]            `{ quantity, unit, basis, rateMinor,
 *                                            minimumChargeMinor, tiers, second }`
 *                                            — a required process and its
 *                                            quotation
 */
async function seedSourceBacked(companyId, {
  product = null,
  withOperation = true,
  withMaterial = true,
  withQuotation = true,
  item: existingItem = null,
  uom = "Metre",
  packaging = null,
  service = null,
  development = null,
  /* `null` leaves the enquiry with no delivery terms at all; an object
     overrides the default ex-works arrangement. */
  freight = {},
  /* ── WHEN THIS ORDER GETS PAID ────────────────────────────────────────
     `null` — the default — leaves the enquiry with NO payment terms, which
     is what most fixtures want: an unanswered enquiry, whose financing
     family is honestly outstanding rather than silently nil. A suite that
     needs financing to calculate passes confirmed terms.

     Deliberately not defaulted to something usable. A fixture that quietly
     confirmed terms nobody stated would make every suite in this folder
     assert against an agreement that does not exist. */
  paymentTerms = null,
  /* ── WHERE STORE SAYS THE MATERIALS COME FROM ─────────────────────────
     `DOMESTIC` by default, which answers the customs half of the duty family
     and is what almost every fixture in this folder wants. `IMPORTED` with no
     `countryOfOrigin` and no tariff code on the item is the blocking case. */
  sourcingType = "DOMESTIC",
  countryOfOrigin = "",
  /* ── AND WHETHER THE QUOTED RATE ALREADY CARRIES THE DUTY ─────────────
     Only meaningful on an import: a domestic supply has no customs entry for
     duty to be inside. `EXCLUDED` — the default for an import — means the
     Board's rule is applied on top. `INCLUDED` means it is already in the
     rate and no second line is added. `""` is the deliberately unanswered
     case, and it BLOCKS naming Store rather than picking either. */
  dutyInQuotedRate = "EXCLUDED",
  /* The customs tariff heading, on the ITEM master where a heading belongs —
     never the quotation's GST HSN. Empty is the unclassified import, which
     blocks. */
  customsTariffCode = "",
  /* ── THE PACKAGING SUPPLIER'S OWN ANSWER ──────────────────────────────
     Separate from the fabric's, because they are two quotations from two
     suppliers and either can be the import. `DOMESTIC` by default — a local
     packer's poly bag — and `null` omits `sourcing` entirely, which is the
     shape of every offer written before Store was asked the question. */
  packagingSourcingType = "DOMESTIC",
  /* ── AND THE THREE DEPARTMENT-OWNED APPLICABILITY DECISIONS ───────────
     `{ packaging: false, outsideProcesses: true, development: false }` — a
     boolean per family, written as the department would write it, with a
     fixture reason. Absent leaves each unanswered, which is the state a real
     style starts in and the one most suites should be asserting against. */
  applicability = null,
  /* ── WHAT SALES ASKED TO BE COSTED ────────────────────────────────────
     The confirmed costing brief: which approved style, what quantities, in
     what unit, at what proposed price. Central Costing reads it and REFUSES
     to calculate without one, so almost every suite here wants it — pass the
     quantities that suite asserts against.

     `null` opts out, for a suite about a costing nobody has briefed. */
  brief = { quantities: [{ key: "q500", quantity: "500", isPrimary: true }], quantityUom: "Pieces" },
  samSeconds = 90,
  salary = 18000,
  rateMinor = 10000,
  consumption = "1",
  secondStyle = false,
} = {}) {
  const n = ++seq;
  const name = product || `Oxford Shirt ${n}`;

  const account = await Account.create({
    companyName: `Buyer ${n}`,
    companyId,
    companyOwnership: { source: "MEMBERSHIP_RECORD", resolvedAt: new Date(), proven: true },
    isActive: true,
  });
  const journey = await SalesJourney.create({
    journeyId: `SJ-SB-${n}`, companyId,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(),
    ownerName: "Owner", name: `Journey ${n}`, isActive: true,
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-SB-${n}`, journeyId: journey._id, accountId: account._id,
    companyId, title: `Enquiry ${n}`, isActive: true,
    products: [{ product: name, quantity: 500 }],
    /* ── HOW THIS ORDER IS DELIVERED ──────────────────────────────────
       `ex_works` by default: the customer collects, which is a real answer
       and costs the company nothing to deliver. A suite that needs a
       delivered order asks for one. Absent entirely would leave every
       fixture's freight family unanswered, which is a different fact and
       not the one most of these suites are about. */
    ...(freight === null ? {} : { freight: { arrangement: "ex_works", ...freight } }),
    ...(paymentTerms === null ? {} : {
      paymentTerms: {
        source: "ENQUIRY",
        confirmedAt: new Date(),
        confirmedBy: { name: "Fixture" },
        ...paymentTerms,
      },
    }),
  });

  /* The Store side: a unit, an item, an active supplier and a live quotation.
     Without an applicable quotation a material line has no rate and the
     calculation is refused — correctly, and unhelpfully for a suite that only
     wants a costing to exist. */
  let item = existingItem;
  let offer = null;
  if (withMaterial) {
    if (!item) {
      await Unit.create({ companyId, name: uom, symbol: "m", status: "Active" }).catch(() => null);
      item = await RawItem.create({
        companyId, name: `Fabric ${n}`, sku: `RAW-SB-${n}`,
        unit: uom, quantity: 0, minStock: 0, maxStock: 100, variants: [],
        /* A property of the GOODS, so it lives here and not on the offer: two
           suppliers of one fabric do not classify it differently. Absent
           unless the fixture states one — an unclassified import is a real
           state and one the duty suites assert against. */
        ...(customsTariffCode ? { customsTariffCode } : {}),
      });
    }
    if (withQuotation) {
      const supplier = await Vendor.create({
        companyId, companyName: `Mill ${n}`, vendorType: "Supplier", status: "Active",
      });
      offer = await SupplierOffer.create({
        companyId, supplierId: supplier._id, supplierName: supplier.companyName,
        itemId: item._id, purchaseUom: uom, currency: "INR",
        unitPriceMinor: rateMinor, priceBasis: "TAX_EXCLUSIVE", gstRatePercent: 12,
        /* ── THE INBOUND LEG, ANSWERED ────────────────────────────────
           A quotation that does not say whether its rate includes delivery
           to our warehouse leaves the material's landed cost unknown, and
           the costing says so. These fixtures state it — a local supplier
           delivering to the door — rather than leaving every suite blocked
           on a question about a different family. */
        freightTerms: "INCLUSIVE_LANDED",
        /* ── AND WHERE THE GOODS COME FROM ────────────────────────────
           Store's own statement, on the quotation, and the ONLY route to the
           duty family being answerable. It used to be answered by a typed
           acknowledgement on the calculation — `DUTY_NOT_APPLICABLE`, sent by
           whoever was costing — and that is retired: a person costing a
           garment does not know where its fabric was bought.

           `DOMESTIC` means no customs entry, so no duty. Overridable per
           fixture, because a suite testing an unclassified import needs the
           opposite. */
        ...sourcingFor(sourcingType, { countryOfOrigin, dutyInQuotedRate }),
        quotationReference: `Q-SB-${n}`, status: "ACTIVE",
        effectiveFrom: new Date("2026-01-01"),
      });
    }
  }

  /* One development requirement, or several — `development.also` adds another
     row, which is how a style needing screens for the body AND for the sleeve
     is seeded. Each carries its own stable identity. */
  const developmentRows = (development
    ? [development, ...(development.also ? [{ ...development, ...development.also }] : [])]
    : []
  ).map((d) => ({ ...d, rowId: d.rowId || new mongoose.Types.ObjectId().toString() }));

  const styleFor = (variantKey, variantLabel) => ({
    sampleStyleId: `SS-SB-${n}${variantKey}`,
    styleCode: `SC-SB-${n}${variantKey}`,
    journeyId: journey._id,
    /* Candidates are matched on enquiry + product name; the journey proves the
       company. */
    enquiryId: enquiry._id,
    companyId,
    productName: name,
    variantKey,
    variantLabel,
    materials: { rawItems: [] },
    sample: {
      consumptionRawItems: withMaterial
        ? [{ rawItemId: item._id, rawItemName: item.name, quantity: Number(consumption), unit: uom, allowancePercent: 0 }]
        : [],
      operations: withOperation
        ? [{
          type: "Assembly", operationCode: `OP-SB-${n}`, machine: "SNLS",
          minutes: Math.floor(samSeconds / 60), seconds: samSeconds % 60,
          totalSeconds: samSeconds,
          salaryDept: "Production", salaryDesig: "Operator",
          operatorSalary: salary, operatorCost: 1.92,
        }]
        : [],
      /* How many garments one shipping carton holds — the style's SINGLE
         statement of it, read by both freight and per-carton packaging. Only
         set when a fixture asks for it, so its absence stays testable. */
      ...(packaging?.garmentsPerCarton
        ? { shipment: { garmentsPerCarton: packaging.garmentsPerCarton } }
        : {}),
      packagingRequirements: packaging && packagingItem
        ? [{
          rawItemId: packagingItem._id, rawItemName: packagingItem.name,
          specification: packaging.specification || "Printed poly bag, 300x400mm",
          quantity: packaging.quantity,
          unit: packaging.unit || "Piece",
          basis: packaging.basis || "PER_GARMENT",
          /* Stated by the fixture, never assumed — the difference between a
             row a costing may verify and one it must keep provisional. */
          evidence: packaging.evidence || "SAMPLE_MEASURED",
        }]
        : [],
      serviceRequirements: [
        ...(service && serviceMaster ? [{
          serviceId: serviceMaster._id,
          serviceCode: serviceMaster.serviceCode, serviceName: serviceMaster.name,
          specification: service.specification || "Enzyme wash, two cycles",
          quantity: service.quantity,
          billingUnit: service.unit || "Piece",
          basis: service.basis || "PER_GARMENT",
          owner: service.owner || "RND",
          evidence: service.evidence || "SAMPLE_MEASURED",
          purpose: "OUTSIDE_PROCESS",
        }] : []),
        /* ── ONE-TIME SETUP, FROM EITHER SOURCE ────────────────────────
           `development.internal` names a configured company charge; anything
           else is bought outside and priced from its own quotation. */
        ...(developmentRows.map((d) => ({
          /* The row's own identity, as the sample submit mints it — so two
             rows naming the same charge stay two rows. */
          rowId: d.rowId,
          ...(d.internal
            ? {
              developmentSource: "COMPANY_POLICY",
              developmentChargeKey: d.chargeKey || "pattern",
              /* How many of what the charge is priced per. A flat charge is
                 not a quantity of anything, and carries none. */
              ...(d.quantity === null ? {} : { quantity: d.quantity ?? 1 }),
              ...(d.unit ? { billingUnit: d.unit } : {}),
            }
            : {
              developmentSource: "SUPPLIER_QUOTATION",
              serviceId: devServiceMaster?._id,
              serviceCode: devServiceMaster?.serviceCode,
              serviceName: devServiceMaster?.name,
              billingUnit: d.unit || "Lot",
              quantity: d.quantity ?? 1,
            }),
          specification: d.specification || "Pattern and marker development",
          basis: "FIXED_PER_RUN",
          purpose: "DEVELOPMENT_TOOLING",
          owner: d.owner || "RND",
          evidence: d.evidence || "SAMPLE_MEASURED",
        }))),
      ],
      status: "approved",
      approvedAt: new Date("2026-08-01"),
    },
    bomApproval: { status: "approved", round: 2 },
    /* ── AN APPROVED TECHNICAL REVISION, BECAUSE SALES QUOTES ONE ──────
       A costing brief may name only a style whose technical revision Sales
       APPROVED — the frozen revision, not the live record R&D may still be
       drafting. `techSheet.status` alone never proved that.

       The snapshot is deliberately EMPTY: `engineered` rows come from it and
       outrank the measured and planned lists, so a fixture that filled it in
       would silently re-source every material figure in this folder. Empty
       means the existing precedence — measured, then planned — is unchanged,
       and every figure these suites assert stays what it was. */
    techSheet: {
      status: "approved",
      technical: { status: "approved", revision: 1 },
      technicalRevisions: [{
        revision: 1, outcome: "approved",
        submittedAt: new Date("2026-07-01"), submittedBy: { name: "R&D Fixture" },
        decidedAt: new Date("2026-07-02"), decidedByName: "Sales Fixture",
        snapshot: { materials: [] },
      }],
    },
  });

  /* ── PACKAGING: R&D'S ROW, AND STORE'S QUOTATION BEHIND IT ─────────────
     Two records, as in production. The requirement carries no rate. */
  let packagingItem = null;
  let packagingOffer = null;
  if (packaging) {
    const pkgUom = packaging.unit || "Piece";
    await Unit.create({ companyId, name: pkgUom, symbol: pkgUom.slice(0, 3), status: "Active" }).catch(() => null);
    packagingItem = await RawItem.create({
      companyId, name: `Poly Bag ${n}`, sku: `PKG-SB-${n}`,
      unit: pkgUom, quantity: 0, minStock: 0, maxStock: 100, variants: [],
    });
    if (packaging.rateMinor !== undefined) {
      const pkgSupplier = await Vendor.create({
        companyId, companyName: `Packer ${n}`, vendorType: "Supplier", status: "Active",
      });
      packagingOffer = await SupplierOffer.create({
        companyId, supplierId: pkgSupplier._id, supplierName: pkgSupplier.companyName,
        itemId: packagingItem._id, purchaseUom: pkgUom, currency: "INR",
        unitPriceMinor: packaging.rateMinor, priceBasis: "TAX_EXCLUSIVE", gstRatePercent: 12,
        /* ── THE INBOUND LEG, ANSWERED ────────────────────────────────
           A quotation that does not say whether its rate includes delivery
           to our warehouse leaves the material's landed cost unknown, and
           the costing says so. These fixtures state it — a local supplier
           delivering to the door — rather than leaving every suite blocked
           on a question about a different family. */
        freightTerms: "INCLUSIVE_LANDED",
        /* ── THE PACKER'S OWN SOURCING ANSWER ─────────────────────────
           Stated, because a poly bag is a purchased input like any other and
           customs asks the same question of it. Leaving it unanswered here
           blocked every fixture that had packaging at all, which is the
           rule working — an offer nobody asked is not a domestic supply. */
        ...sourcingFor(packagingSourcingType, {}),
        quotationReference: `QP-SB-${n}`, status: "ACTIVE",
        effectiveFrom: new Date("2026-01-01"),
        ...(packaging.moq ? { moq: packaging.moq } : {}),
        ...(packaging.orderMultiple ? { orderMultiple: packaging.orderMultiple } : {}),
        ...(packaging.tiers ? { tiers: packaging.tiers } : {}),
      });
    }
  }

  /* ── AND A REQUIRED PROCESS, WITH ITS OWN REGISTER ─────────────────────── */
  let serviceMaster = null;
  let serviceOffer = null;
  let secondServiceOffer = null;
  if (service) {
    serviceMaster = await Service.create({
      companyId, serviceCode: `SVC-SB-${n}`, name: `Garment Wash ${n}`,
      billingUnit: service.unit || "Piece", sacCode: "998821",
      /* Planning guidance, deliberately present and deliberately never read
         by costing — the tests assert that it is not. */
      defaultRate: 99,
      status: "ACTIVE",
    });
    const mk = (over = {}) => ServiceSupplierOffer.create({
      companyId,
      supplierId: over.supplierId,
      supplierName: over.supplierName,
      serviceId: serviceMaster._id,
      serviceCode: serviceMaster.serviceCode,
      serviceName: serviceMaster.name,
      billingUnit: service.unit || "Piece",
      currency: "INR",
      unitPriceMinor: over.rateMinor ?? service.rateMinor,
      priceBasis: "TAX_EXCLUSIVE",
      gstRatePercent: 18,
      quotationReference: over.reference || `QS-SB-${n}`,
      status: "ACTIVE",
      effectiveFrom: new Date("2026-01-01"),
      ...(service.minimumChargeMinor ? { minimumChargeMinor: service.minimumChargeMinor } : {}),
      ...(service.minQuantity ? { minQuantity: service.minQuantity } : {}),
      ...(service.orderMultiple ? { orderMultiple: service.orderMultiple } : {}),
      ...(service.tiers ? { tiers: service.tiers } : {}),
      ...over.extra,
    });
    if (service.rateMinor !== undefined) {
      const sv1 = await Vendor.create({
        companyId, companyName: `Wash House A ${n}`, vendorType: "Supplier", status: "Active",
      });
      serviceOffer = await mk({ supplierId: sv1._id, supplierName: sv1.companyName });
      if (service.second) {
        const sv2 = await Vendor.create({
          companyId, companyName: `Wash House B ${n}`, vendorType: "Supplier", status: "Active",
        });
        secondServiceOffer = await mk({
          supplierId: sv2._id, supplierName: sv2.companyName,
          rateMinor: service.second.rateMinor ?? service.rateMinor,
          reference: `QS2-SB-${n}`,
        });
      }
    }
  }

  /* A separate Service master for setup work bought outside: making the
     screens and printing with them are two different things a supplier does. */
  let devServiceMaster = null;
  let devServiceOffer = null;
  if (development && !development.internal) {
    devServiceMaster = await Service.create({
      companyId, serviceCode: `SVD-SB-${n}`, name: `Screen Making ${n}`,
      billingUnit: development.unit || "Lot", sacCode: "998912",
      defaultRate: 77, status: "ACTIVE",
    });
    if (development.rateMinor !== undefined) {
      const devSupplier = await Vendor.create({
        companyId, companyName: `Screen Room ${n}`, vendorType: "Supplier", status: "Active",
      });
      const mkDev = (over = {}) => ServiceSupplierOffer.create({
        companyId,
        supplierId: over.supplierId, supplierName: over.supplierName,
        serviceId: devServiceMaster._id,
        serviceCode: devServiceMaster.serviceCode, serviceName: devServiceMaster.name,
        billingUnit: development.unit || "Lot", currency: "INR",
        unitPriceMinor: over.rateMinor ?? development.rateMinor,
        priceBasis: "TAX_EXCLUSIVE", gstRatePercent: 18,
        quotationReference: over.reference || `QD-SB-${n}`,
        status: "ACTIVE", effectiveFrom: new Date("2026-01-01"),
      });
      devServiceOffer = await mkDev({ supplierId: devSupplier._id, supplierName: devSupplier.companyName });
      if (development.second) {
        const alt = await Vendor.create({
          companyId, companyName: `Screen Room B ${n}`, vendorType: "Supplier", status: "Active",
        });
        await mkDev({
          supplierId: alt._id, supplierName: alt.companyName,
          rateMinor: development.second.rateMinor ?? development.rateMinor,
          reference: `QD2-SB-${n}`,
        });
      }
    }
  }

  const style = await SampleStyle.create(styleFor("", ""));
  const sibling = secondStyle ? await SampleStyle.create(styleFor("alt", "Alternate")) : null;

  /* ── AND WHAT THE THREE DEPARTMENTS SAID ABOUT APPLICABILITY ──────────
     Written straight onto the style, the way each department's own service
     writes it. Only recorded where the fixture asked: an absent decision is
     the state every real style starts in, and defaulting one here would make
     every suite in this folder assert against an answer nobody gave. */
  if (applicability) {
    const stamp = (required, reason) => ({
      required,
      reason: required ? "" : (reason || "Fixture: recorded as not required."),
      decidedBy: { id: new mongoose.Types.ObjectId(), name: "A Fixture Decider" },
      decidedAt: new Date("2026-06-01"),
    });
    for (const target of [style, sibling].filter(Boolean)) {
      if (applicability.packaging !== undefined) {
        target.materials = target.materials || {};
        target.materials.packagingDecision = stamp(applicability.packaging, applicability.packagingReason);
        target.markModified("materials.packagingDecision");
      }
      if (applicability.outsideProcesses !== undefined) {
        target.sample = target.sample || {};
        target.sample.outsideProcessDecision = stamp(applicability.outsideProcesses, applicability.outsideProcessesReason);
        target.markModified("sample.outsideProcessDecision");
      }
      if (applicability.development !== undefined) {
        target.sample = target.sample || {};
        target.sample.developmentDecision = stamp(applicability.development, applicability.developmentReason);
        target.markModified("sample.developmentDecision");
      }
      await target.save();
    }
  }

  /* ── AND THE BRIEF SALES CONFIRMED ────────────────────────────────────
     Through `confirmCostingBrief` below, which goes through the REAL Sales
     service. A fixture that assembled the embedded shape by hand could create
     a brief the service would refuse — an unapproved style, two primaries, a
     quantity of nothing — and every suite would then be asserting against a
     record production cannot produce. */
  let seededBrief = null;
  if (brief) {
    seededBrief = await confirmCostingBrief(companyId, {
      enquiryId: enquiry._id,
      styleId: style._id,
      ...brief,
    });
  }

  return {
    context: { type: "ENQUIRY_STYLE", primaryId: String(enquiry._id), externalKey: name },
    styleId: String(style._id),
    briefId: seededBrief?.briefId || null,
    brief: seededBrief?.brief || null,
    siblingStyleId: sibling ? String(sibling._id) : null,
    /* The keys the server will generate, so a suite can assert on the rows it
       assembled rather than on rows the suite posted. */
    materialLineKey: item ? `mat:${item._id}::` : null,
    operationLineKey: withOperation ? `op:op::OP-SB-${n}` : null,
    packagingItem, packagingOffer, serviceMaster, serviceOffer, secondServiceOffer,
    devServiceMaster, devServiceOffer,
    /* Built from the ROW's identity, which is what the assembly keys on. */
    developmentLineKey: developmentRows.length ? `dev:dev:${developmentRows[0].rowId}` : null,
    developmentLineKeys: developmentRows.map((d) => `dev:dev:${d.rowId}`),
    developmentRowIds: developmentRows.map((d) => d.rowId),
    packagingLineKey: packagingItem ? `pkg:pkg:${packagingItem._id}::` : null,
    serviceLineKey: serviceMaster ? `svc:svc:${serviceMaster._id}` : null,
    enquiry, style, sibling, account, journey, item, offer, product: name,
  };
}

/** Give a company the assumptions its labour rate and tax position rest on. */
/**
 * The company assumptions a source-backed costing needs, plus the Board's
 * overhead rule.
 *
 * ── WHY THE OVERHEAD APPROVAL LIVES HERE ────────────────────────────────────
 * Overhead used to be two fields most suites set in their policy body, so
 * every fixture company had an overhead line without anybody thinking about
 * it. It is a Board decision now and the legacy write is refused, so each of
 * those suites would otherwise need its own approval call — seventeen copies
 * of one line, each a chance to drift.
 *
 * Every suite that wants a fully configured company already calls this, and
 * the defaults are exactly what those suites used to write inline (12% of
 * `DIRECT_PLUS_FIXED`), so every figure they assert is unchanged.
 *
 * `overhead: null` opts out, for a suite that is specifically about a company
 * whose Board has NOT decided.
 */
const configureProduction = async (companyId, {
  overhead = {}, labour = {}, gst = {}, development = null, contingency = null,
  margin = {}, ...over
} = {}) => {
  await CostingPolicy.updateOne({ companyId }, { $set: { ...PRODUCTION_POLICY, ...over } });

  /* ── AND THE DEVELOPMENT CHARGE CATALOGUE, WHERE A SUITE NEEDS ONE ────
     Opt IN, unlike the three below: most suites cost no in-house development
     work at all, and approving an empty catalogue for them would make every
     one of them assert against a Board decision nobody in the suite made.
     Idempotent for the same reason as the others. */
  if (development) {
    const boardDev = require("../../../services/board/boardPolicy.service");
    const haveDev = await boardDev.resolveEffective(companyId, "DEVELOPMENT_CHARGE_POLICY", new Date());
    if (!haveDev) await approveDevelopmentPolicy(companyId, development);
  }

  /* ── AND THE CONTINGENCY DECISION, WHERE A SUITE NEEDS ONE ────────────
     Opt IN, like development and for the same reason: a contingency added to
     every fixture would be counted into every paisa-exact figure the suites
     assert. Idempotent, so a suite that configures production repeatedly does
     not try to approve a second policy on one date. */
  if (contingency) {
    const boardCtg = require("../../../services/board/boardPolicy.service");
    const haveCtg = await boardCtg.resolveEffective(companyId, "CONTINGENCY_POLICY", new Date());
    if (!haveCtg) await approveContingencyPolicy(companyId, contingency);
  }

  /* ── AND THE BOARD'S LABOUR METHODOLOGY ───────────────────────────────
     Same reasoning as overhead below, and idempotent for the same reason:
     several suites configure production after every policy save, and a second
     approval on one effective date is refused. `labour: null` opts out, for a
     suite about a company whose Board has not decided. */
  const boardPolicy = require("../../../services/board/boardPolicy.service");

  /* ── AND THE MARGIN BAND, WHICH IS NOT OPTIONAL ───────────────────────
     Without it no version can be frozen at all — every price break is solved
     from it — so unlike every other Board fixture here this defaults ON.
     `margin: null` opts out, for a suite about a company whose Board has not
     decided. Idempotent, like the rest. */
  if (margin) {
    const haveMargin = await boardPolicy.resolveEffective(companyId, "MARGIN_POLICY", new Date());
    if (!haveMargin) await approveMarginPolicy(companyId, margin);
  }

  /* ── AND THE INPUT GST TREATMENT ──────────────────────────────────────
     Same reasoning and same idempotence as the two below: without it every
     taxable quotation is refused for want of a tax position. `gst: null` opts
     out, for a suite about a company whose Board has not decided. */
  if (gst) {
    const haveGst = await boardPolicy.resolveEffective(companyId, "GST_TAX_POLICY", new Date());
    if (!haveGst) await approveGstPolicy(companyId, gst);
  }

  if (labour) {
    const haveLabour = await boardPolicy.resolveEffective(companyId, "LABOUR_METHODOLOGY", new Date());
    if (!haveLabour) await approveLabourPolicy(companyId, labour);
  }

  if (!overhead) return;
  /* ── IDEMPOTENT, BECAUSE SUITES CALL THIS MORE THAN ONCE ──────────────
     Several suites configure production after every policy save. A second
     approval on the same effective date is refused by the lifecycle — and
     rightly, since two policies cannot both be in force at once — so the
     fixture approves one only where the company has none. */
  const already = await boardPolicy.resolveEffective(companyId, "OVERHEAD", new Date());
  if (already) return;
  await approveOverheadPolicy(companyId, overhead);
};

/**
 * A historical manual costing, written as the record it is.
 *
 * ── NOT THROUGH THE ROUTE ───────────────────────────────────────────────────
 * Creation is closed, and reopening it for tests would be exactly the
 * test-only bypass this correction exists to remove. These documents predate
 * the rule; seeding them directly is what "historical" means.
 */
async function seedHistoricalAdhoc(companyId, { label = "Historical estimate", actorName = "Someone" } = {}) {
  const n = ++seq;
  return Costing.create({
    companyId,
    status: "DRAFT",
    context: { type: "ADHOC", externalKey: "" },
    contextSnapshot: { label, facts: [], capturedAt: new Date() },
    currentVersionNumber: 0,
    createdByActorId: `legacy-${n}`,
    createdByActorName: actorName,
    isArchived: false,
  });
}

/* ── `withOverride` IS GONE ─────────────────────────────────────────────────
 *
 * It declared a fixture line as a provisional override — the one legitimate
 * way a suite could put a figure into a costing by hand. Its own comment
 * insisted it be used "only where that is the truth", and its default family
 * had already had to move from `freight` to `duty` once, as freight acquired
 * a source.
 *
 * There is no such thing now: the request contract refuses an override for
 * every family, so a fixture that used this would be asserting against a
 * request nothing can accept.
 *
 * What replaces it is below — the seed options that make every SOURCED family
 * calculable, and the one acknowledgement that answers the one family that
 * still has no source. A fixture wanting a complete costing states the
 * records behind it, exactly as a company would have to.
 */

/**
 * THE SEED OPTIONS THAT LEAVE NO SOURCED FAMILY OUTSTANDING.
 *
 * Materials and operations come from the technical record and the supplier
 * quotation the base seed already creates. These add the three families that
 * need a requirement AND a quotation of their own — packaging, outside
 * services, and development work bought outside — plus the payment terms half
 * of financing.
 *
 * Spread rather than passed whole, so a suite can override one line of it:
 *
 *     seedSourceBacked(companyId, { ...EVERY_FAMILY, packaging: null })
 *
 * The Board's half of financing is NOT here, because it is a different
 * record with its own lifecycle: call `approveFinancingPolicy(companyId)`
 * beside this. A fixture that quietly approved a Board policy would make
 * every suite in this folder assert against a decision nobody took.
 */
const EVERY_FAMILY = Object.freeze({
  packaging: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 250 },
  service: { quantity: 1, unit: "Piece", basis: "PER_GARMENT", rateMinor: 800 },
  development: { internal: false, unit: "Lot", quantity: 1, rateMinor: 1000000 },
  /* Stated inline rather than spread from `CONFIRMED_TERMS`, which is
     declared further down: a `const` is in its temporal dead zone until its
     own line runs, so referring to it here would throw on require. The two
     must agree, and the assertion below is what keeps them agreeing. */
  paymentTerms: { advancePercent: 30, creditDays: 45, creditDaysFrom: "INVOICE" },
  /* The customer collects, so freight is a RECORDED ZERO — an answer with an
     arrangement behind it, not a gap. */
  freight: { arrangement: "ex_works" },
});

/**
 * DUTY IS ANSWERED BY STORE NOW, ON THE QUOTATION.
 *
 * This was `DUTY_NOT_APPLICABLE` — `[{ key: "duty", reason: "Domestic order…" }]`
 * sent as `technicalAcknowledgements` with the calculation, and every suite in
 * this folder spread it to make a costing complete.
 *
 * It was the last family answerable that way, and it was the wrong desk: a
 * person costing a garment does not know where its fabric was bought. Store
 * states it on the quotation (`sourcing.type`), the assembly reads it, and the
 * calculation payload now REFUSES an acknowledgement rather than accepting
 * one.
 *
 * `seedSourceBacked` writes `DOMESTIC` by default, so a fixture that used to
 * spread this needs nothing in its place. The two values are exported for the
 * suites that need the other answer.
 */
const SOURCING = Object.freeze({ DOMESTIC: "DOMESTIC", IMPORTED: "IMPORTED" });

/**
 * AN APPROVED, EFFECTIVE BOARD FINANCING POLICY.
 *
 * Written through the service, not the collection, so a fixture cannot create
 * a shape the lifecycle would refuse — the approval path is the same one a
 * person walks, including the completeness check and the effective date.
 *
 * Dated a year back by default so it is already in force for a costing made
 * now. A suite testing future dating passes its own.
 */
async function approveFinancingPolicy(companyId, {
  annualRatePercent = "12",
  basis = "SUBTOTAL_BEFORE_FINANCING",
  advanceTreatment = "REDUCES_FINANCED_AMOUNT",
  dayCountBasis = 365,
  effectiveFrom = new Date(Date.now() - 365 * 24 * 3600 * 1000),
  rationale = "Fixture policy.",
  actorName = "Board Fixture",
} = {}) {
  const boardPolicy = require("../../../services/board/boardPolicy.service");
  const ctx = { companyId, actorId: "fixture", actorName };
  const draft = await boardPolicy.createDraft(ctx, {
    policyKey: "FINANCING",
    financing: { annualRatePercent, basis, advanceTreatment, dayCountBasis },
    rationale,
  });
  return boardPolicy.approve(ctx, draft._id, { effectiveFrom });
}

/**
 * AN APPROVED, EFFECTIVE BOARD OVERHEAD POLICY.
 *
 * Written through the service, not the collection, so a fixture cannot create
 * a shape the lifecycle would refuse.
 *
 * ── WHY EVERY SUITE NEEDS THIS NOW ──────────────────────────────────────────
 * Overhead used to be two fields most suites set in their policy body, so a
 * costing came out with an overhead line without anybody thinking about it.
 * It is a Board decision now, and the legacy write is refused — so a fixture
 * that wants an overhead line has to approve one, exactly as a company does.
 * A suite that does NOT call this gets a costing with no overhead, which is
 * the honest state of a company whose Board has not decided.
 *
 * The defaults are the ones the suites used to write inline (12% of
 * `DIRECT_PLUS_FIXED`), so every figure they assert is unchanged.
 */
async function approveOverheadPolicy(companyId, {
  ratePercent = "12",
  basis = "DIRECT_PLUS_FIXED",
  effectiveFrom = new Date(Date.now() - 365 * 24 * 3600 * 1000),
  rationale = "Fixture policy.",
  actorName = "Board Fixture",
} = {}) {
  const boardPolicy = require("../../../services/board/boardPolicy.service");
  const ctx = { companyId, actorId: "fixture", actorName };
  const draft = await boardPolicy.createDraft(ctx, {
    policyKey: "OVERHEAD",
    overhead: { ratePercent, basis },
    rationale,
  });
  return boardPolicy.approve(ctx, draft._id, { effectiveFrom });
}

/**
 * AN APPROVED, EFFECTIVE BOARD LABOUR METHODOLOGY.
 *
 * ── WHY EVERY SUITE NEEDS THIS NOW ──────────────────────────────────────────
 * `PRODUCTION_POLICY` wrote the three labour assumptions straight to the
 * costing policy document, so an operation came out costed without anybody
 * thinking about it. They are a Board decision now, and `getPolicy` no longer
 * reads them into the calculation — so without an approved policy every
 * operation falls back to the sample's own figure and is reported PROVISIONAL.
 *
 * The defaults are exactly what `PRODUCTION_POLICY` set (9,000 productive
 * minutes, 18% employer burden, machine cost in overhead), so every figure the
 * suites assert — `EXPECTED.labourRateMinor` among them — is unchanged.
 */
async function approveLabourPolicy(companyId, {
  productiveMinutesPerMonth = 9000,
  labourEfficiencyPercent = undefined,
  employerBurdenPercent = "18",
  machineBurdenTreatment = "IN_OVERHEAD",
  machineExclusionReason = "",
  effectiveFrom = new Date(Date.now() - 365 * 24 * 3600 * 1000),
  rationale = "Fixture policy.",
  actorName = "Board Fixture",
} = {}) {
  const boardPolicy = require("../../../services/board/boardPolicy.service");
  const ctx = { companyId, actorId: "fixture", actorName };
  const draft = await boardPolicy.createDraft(ctx, {
    policyKey: "LABOUR_METHODOLOGY",
    labour: {
      /* Exactly one basis reaches the draft: sending both is refused, and
         rightly — they are two answers to one question. */
      ...(labourEfficiencyPercent === undefined
        ? { productiveMinutesPerMonth }
        : { labourEfficiencyPercent }),
      employerBurdenPercent,
      machineBurdenTreatment,
      machineExclusionReason,
    },
    rationale,
  });
  return boardPolicy.approve(ctx, draft._id, { effectiveFrom });
}

/**
 * AN APPROVED, EFFECTIVE BOARD INPUT GST TREATMENT.
 *
 * ── WHY EVERY SUITE NEEDS THIS NOW ──────────────────────────────────────────
 * `PRODUCTION_POLICY` wrote `inputGstTreatment: "RECOVERABLE"` straight to the
 * costing policy, so every quotation-backed line priced without anybody
 * thinking about it. It is a Board decision now and `getPolicy` no longer
 * reads the legacy field — so without an approved policy, `taxPositionFor`
 * refuses every taxable quotation with TAX_TREATMENT_REQUIRED.
 *
 * The default is the one `PRODUCTION_POLICY` set, so every figure the suites
 * assert is unchanged.
 */
/**
 * The Board's development charge catalogue, approved.
 *
 * ── SEEDED, NOT POSTED ──────────────────────────────────────────────────────
 * `validateDevelopmentCharges` refuses a key the draft does not already hold,
 * so a client — a fixture included — cannot name one. That is deliberate: a
 * key is what stored requirements point at, and inventing one would give a
 * charge a second identity. Fixtures need the exact keys their requirements
 * name, so they arrive by the same seeding door the legacy migration uses,
 * where the rows are validated against themselves.
 *
 * Backdated a year by default, so every suite's costing — whatever date it
 * carries — resolves it.
 */
async function approveDevelopmentPolicy(companyId, charges = [], {
  effectiveFrom = new Date(Date.now() - 365 * 24 * 3600 * 1000),
  rationale = "Fixture catalogue.",
  actorName = "Board Fixture",
} = {}) {
  const boardPolicy = require("../../../services/board/boardPolicy.service");
  const { adaptTable } = require("../../../services/centralCosting/developmentCharges");
  const ctx = { companyId, actorId: "fixture", actorName };
  const draft = await boardPolicy.createDraft(ctx, {
    policyKey: "DEVELOPMENT_CHARGE_POLICY",
    /* Adapted, like the legacy migration door itself: suites written before
       rate periods existed state a charge as one flat amount, and that is
       exactly the shape a real company's retired table is in. */
    seed: adaptTable(charges),
    rationale,
  });
  return boardPolicy.approve(ctx, draft._id, { effectiveFrom });
}

/**
 * The Board's contingency decision, approved.
 *
 * Opt-in throughout: most suites assert paisa-exact figures, and a company
 * contingency added to all of them would be counted into every one. What each
 * suite needs from this is its own, so nothing is defaulted.
 */
/**
 * The Board's PRICING FLOOR, approved.
 *
 * ── UNLIKE THE OTHERS, THIS ONE IS NOT OPTIONAL ─────────────────────────────
 * Every other Board fixture here can be opted out of, because a company
 * without that policy still produces a costing with a named gap. Without an
 * approved pricing policy there is no selling price at all and version
 * creation is refused, so every suite that freezes a version needs one.
 *
 * ── AND WHY THE DEFAULT IS 25% ──────────────────────────────────────────────
 * The band this replaced defaulted to `18/25/32`, and the suites that assert
 * an exact selling price assert against the TARGET — 25%. A markup of 25% is
 * not the same price as a margin of 25% and no fixture pretends otherwise:
 * suites asserting a price state their own expected figure, computed as
 * `cost x 1.25`. The number is carried over so the FIXTURE reads as
 * continuous, not so the arithmetic does.
 */
async function approveMarginPolicy(companyId, {
  floorMarkupPercent = "25",
  effectiveFrom = new Date(Date.now() - 365 * 24 * 3600 * 1000),
  rationale = "Fixture pricing floor.",
  actorName = "Board Fixture",
} = {}) {
  const boardPolicy = require("../../../services/board/boardPolicy.service");
  const ctx = { companyId, actorId: "fixture", actorName };
  const draft = await boardPolicy.createDraft(ctx, {
    policyKey: "MARGIN_POLICY",
    margin: { floorMarkupPercent },
    rationale,
  });
  return boardPolicy.approve(ctx, draft._id, { effectiveFrom });
}

/**
 * A HISTORICAL three-band policy, written straight to the collection.
 *
 * ── WHY IT BYPASSES THE SERVICE ─────────────────────────────────────────────
 * The service refuses to create one, which is the point of the migration: no
 * new band may be approved. But versions frozen under a band still exist, are
 * still read, and still have to keep reading correctly — so a suite proving
 * that needs a way to seed the thing the service will not make.
 *
 * This is the only route to one, it is deliberately not exported as a general
 * fixture, and it writes exactly what the old writer wrote.
 */
async function seedHistoricalBandPolicy(companyId, {
  minimumMarginPercent = "18",
  targetMarginPercent = "25",
  preferredMarginPercent = "32",
  approvalThresholdMarginPercent = undefined,
  estimatedIncomeTaxRatePercent = undefined,
  effectiveFrom = new Date(Date.now() - 730 * 24 * 3600 * 1000),
} = {}) {
  const BoardPolicy = require("../../../models/CMS_Models/Board/BoardPolicy");
  return BoardPolicy.create({
    companyId,
    policyKey: "MARGIN_POLICY",
    status: "BOARD_APPROVED",
    effectiveFrom,
    approvedAt: effectiveFrom,
    approvedByActorId: "fixture",
    approvedByActorName: "Board Fixture",
    margin: {
      pricingContract: "MARGIN_BAND_V1",
      minimumMarginPercent, targetMarginPercent, preferredMarginPercent,
      ...(approvalThresholdMarginPercent !== undefined ? { approvalThresholdMarginPercent } : {}),
      ...(estimatedIncomeTaxRatePercent !== undefined ? { estimatedIncomeTaxRatePercent } : {}),
    },
    rationale: "Historical band, seeded for a test about reading history.",
  });
}

async function approveContingencyPolicy(companyId, {
  mode = "APPLY",
  ratePercent = "2",
  basis = "PRIME",
  effectiveFrom = new Date(Date.now() - 365 * 24 * 3600 * 1000),
  rationale = "Fixture decision.",
  actorName = "Board Fixture",
} = {}) {
  const boardPolicy = require("../../../services/board/boardPolicy.service");
  const ctx = { companyId, actorId: "fixture", actorName };
  const draft = await boardPolicy.createDraft(ctx, {
    policyKey: "CONTINGENCY_POLICY",
    contingency: mode === "NONE" ? { mode } : { mode, ratePercent, basis },
    rationale,
  });
  return boardPolicy.approve(ctx, draft._id, { effectiveFrom });
}

async function approveGstPolicy(companyId, {
  inputGstTreatment = "RECOVERABLE",
  effectiveFrom = new Date(Date.now() - 365 * 24 * 3600 * 1000),
  rationale = "Fixture policy.",
  actorName = "Board Fixture",
} = {}) {
  const boardPolicy = require("../../../services/board/boardPolicy.service");
  const ctx = { companyId, actorId: "fixture", actorName };
  const draft = await boardPolicy.createDraft(ctx, {
    policyKey: "GST_TAX_POLICY",
    gst: { inputGstTreatment },
    rationale,
  });
  return boardPolicy.approve(ctx, draft._id, { effectiveFrom });
}

/** Terms a costing can finance: 30% up front, the balance 45 days after invoice. */
const CONFIRMED_TERMS = Object.freeze({
  advancePercent: 30, creditDays: 45, creditDaysFrom: "INVOICE",
});

/* One set of terms, stated twice out of necessity. A fixture whose two
   spellings drifted would let one suite finance an order on terms another
   suite says it was quoted on. */
for (const [k, v] of Object.entries(CONFIRMED_TERMS)) {
  if (EVERY_FAMILY.paymentTerms[k] !== v) {
    throw new Error(`EVERY_FAMILY.paymentTerms.${k} has drifted from CONFIRMED_TERMS`);
  }
}

/**
 * A CONFIRMED SALES COSTING BRIEF, THROUGH THE REAL SERVICE.
 *
 * ── WHY NOT THE EMBEDDED SHAPE ──────────────────────────────────────────────
 * Six suites were hand-building `enquiry.costingBriefs[0]` and saving it. Each
 * copy could drift, and — worse — each could create a brief the Sales service
 * would refuse: an unapproved style, two primary quantities, a quantity of
 * nothing, a proposed price that is not a decimal. A fixture that can write a
 * record production cannot produce is a fixture whose suites prove nothing.
 *
 * So this saves a draft and confirms it the way Sales does, and inherits every
 * rule the service enforces — including the one that matters most here: a
 * brief may name only a style whose technical revision is APPROVED.
 *
 * @param {ObjectId|string} companyId
 * @param {object} opts
 * @param {ObjectId|string} opts.enquiryId
 * @param {ObjectId|string} opts.styleId    the approved style being quoted
 * @param {Array}  [opts.quantities]        `{key, label, quantity, isPrimary,
 *                                           proposedSellingPriceExclTax}`
 * @param {string} [opts.quantityUom]       one unit for the whole brief
 * @param {string} [opts.currency]
 * @param {string} [opts.note]
 * @param {Date|string} [opts.requiredBy]
 * @param {boolean} [opts.confirm]          false leaves it a DRAFT, for a
 *   suite about a costing Sales has not finished asking for
 * @returns {Promise<{briefId, brief, briefs}>}
 */
async function confirmCostingBrief(companyId, {
  enquiryId, styleId,
  quantities = [{ key: "q500", label: "500", quantity: "500", isPrimary: true }],
  quantityUom = "Pieces",
  currency = "INR",
  note = "",
  requiredBy = undefined,
  confirm = true,
  revise = false,
  actor = null,
} = {}) {
  const costingBrief = require("../../../services/sales/costingBrief.service");
  const ctx = { companyId };
  const who = actor || { id: new mongoose.Types.ObjectId(), name: "A Fixture Salesperson" };

  const saved = await costingBrief.saveBrief(ctx, {
    enquiryId,
    /* A confirmed brief is never rewritten, so a fixture that wants a
       RICHER brief in force than the one the commercial line drove asks for
       a revision — the same door Sales uses to change its mind. */
    ...(revise ? { revise: true } : {}),
    body: {
      sampleStyleId: String(styleId),
      quantities: quantities.map((q, i) => ({
        key: String(q.key || `q${i + 1}`),
        label: String(q.label || q.key || `q${i + 1}`),
        quantity: String(q.quantity),
        isPrimary: q.isPrimary === true,
        ...(q.proposedSellingPriceExclTax !== undefined && q.proposedSellingPriceExclTax !== null
          ? { proposedSellingPriceExclTax: String(q.proposedSellingPriceExclTax) }
          : {}),
      })),
      quantityUom,
      currency,
      note,
      ...(requiredBy ? { requiredBy } : {}),
    },
    actor: who,
  });

  const mine = saved.briefs.find((b) => b.sampleStyleId === String(styleId) && b.state === "DRAFT");
  if (!confirm) return { briefId: mine.briefId, brief: mine, briefs: saved.briefs };

  const out = await costingBrief.confirmBrief(ctx, {
    enquiryId, briefId: mine.briefId, actor: who,
  });
  const confirmed = out.confirmed.find((b) => b.briefId === mine.briefId);
  return { briefId: mine.briefId, brief: confirmed, briefs: out.briefs };
}

/**
 * THE CONFIRMED COMMERCIAL LINE A QUOTATION IS NOW REQUIRED TO HAVE.
 *
 * ── WHY A FIXTURE NEEDS ONE ─────────────────────────────────────────────────
 * The quantity on a quotation line is no longer taken from the request body.
 * It is read from the commercial line Sales confirmed, and a line with no
 * confirmed quantity is refused rather than priced. So a suite that quotes an
 * approved costing without one is quoting a state production forbids — which
 * is the same reason `confirmCostingBrief` exists rather than hand-built
 * embedded briefs.
 *
 * Confirmed through the real service, so the fixture inherits its rules and
 * drives the costing the way Sales does. Call it AFTER the version is
 * approved where the suite asserts on a scenario key: confirming supersedes
 * the brief with a single-quantity one of its own, and the key would move
 * under an approved version the suite is about to read.
 *
 * @param {ObjectId|string} companyId
 * @param {object} opts
 * @param {ObjectId|string} opts.enquiryId
 * @param {ObjectId|string} opts.styleId
 * @param {number} [opts.quantity]  defaults to the seeded product's 500
 * @returns {Promise<{line, productLineRef}>}
 */
async function confirmCommercialLine(companyId, { enquiryId, styleId, quantity = 500, actor = null } = {}) {
  const commercialLine = require("../../../services/sales/commercialLine.service");
  const Enquiry = require("../../../models/CMS_Models/Sales/Enquiry");
  const doc = await Enquiry.findById(enquiryId).lean();
  const productLineRef = String((doc.products || [])[0].productLineRef);
  const out = await commercialLine.confirmQuantity({ companyId }, {
    enquiryId: String(enquiryId),
    productLineRef,
    sampleStyleId: String(styleId),
    quantity,
    actor: actor || { id: String(new mongoose.Types.ObjectId()), name: "A Fixture Salesperson" },
  });
  return { line: out.line, productLineRef };
}

/**
 * PREPARE THE ESTIMATE, THE WAY SALES DOES.
 *
 * ── WHY NOT THE COSTING ROUTE ANY MORE ──────────────────────────────────────
 * `POST /:id/versions` was the Calculate button and now refuses a browser
 * client with `COSTING_PREPARATION_MOVED_TO_SALES`. A fixture that kept
 * posting to it would be testing a door nobody is allowed through — and, worse,
 * would keep passing if the refusal were ever removed.
 *
 * So suites prepare an estimate the way production does: through the Sales
 * orchestration, which resolves the brief, assembles the sources, decides
 * whether a version is even needed, and delegates to the same engine.
 *
 * @returns {{outcome, versionId, version, result}} `outcome` is PREPARED,
 *   REVISED, UNCHANGED or BLOCKED — the four things pressing the button can
 *   honestly do.
 */
/* ── A COUNTER OF ITS OWN ──────────────────────────────────────────────────
 * NOT `seq`. That one names the seeded companies, suppliers and styles, and a
 * suite asserting "Screen Room 1 and Screen Room B, in supplier order" is
 * asserting on names it produced. Preparing an estimate would silently shift
 * every later name by one, and the failure would look like an ordering bug in
 * the engine rather than a fixture that moved. */
let prepSeq = 0;

async function prepareEstimate(ctx, { enquiryId, product, actionKey = null } = {}) {
  const costingPreparation = require("../../../services/sales/costingPreparation.service");
  const CostingVersion = require("../../../models/CMS_Models/Costing/CostingVersion");

  const out = await costingPreparation.prepare(ctx, {
    enquiryId,
    product,
    /* A distinct key per call unless the suite is deliberately replaying one:
       reusing a key by accident is how a fixture "proves" idempotency it never
       exercised. */
    actionKey: actionKey || `fixture-${++prepSeq}-${Math.random().toString(36).slice(2)}`,
  });

  const version = out.costingId
    ? await CostingVersion.findOne({ costingId: out.costingId })
      .sort({ versionNumber: -1 }).lean()
    : null;

  return {
    outcome: out.outcome,
    costingId: out.costingId || null,
    versionId: version ? String(version._id) : null,
    version,
    result: out,
  };
}

/**
 * PREPARE AN ESTIMATE, SHAPED LIKE THE ROUTE THAT USED TO DO IT.
 *
 * ── WHY AN ADAPTER AND NOT A REWRITE ────────────────────────────────────────
 * Two dozen suites drove `POST /:id/versions` and then asserted on the VERSION
 * it produced — the lines, the scenarios, the provenance, the freight working.
 * None of those assertions was ever about the transport; the route was simply
 * how a fixture got a version made.
 *
 * The route is retired, so the fixture prepares the estimate the way Sales
 * does — through the orchestration, which resolves the brief, assembles the
 * sources and decides whether a version is needed. This returns that result in
 * the `{status, body:{versions:[…]}}` shape those assertions already read, so
 * what each suite proves is unchanged and only the door has moved.
 *
 * A suite that is specifically about the RETIRED ROUTE should call it directly
 * and expect `COSTING_PREPARATION_MOVED_TO_SALES`. This helper is for the
 * suites that just need a version to exist.
 */
async function prepareAsRoute(ctx, { enquiryId, product, actionKey = null } = {}) {
  const visibility = require("../../../services/centralCosting/visibility");
  const Costing = require("../../../models/CMS_Models/Costing/Costing");
  const CostingVersion = require("../../../models/CMS_Models/Costing/CostingVersion");

  let out;
  try {
    out = await prepareEstimate(ctx, { enquiryId, product, actionKey });
  } catch (err) {
    /* The orchestration throws where the route answered 4xx. Adapted, so a
       suite asserting on a refusal still reads one. */
    return {
      status: err.status || 400,
      body: { success: false, error: { code: err.code, message: err.message, details: err.details || {} } },
    };
  }

  if (out.outcome === "BLOCKED") {
    /* ── THE ENGINE'S OWN REFUSAL, NOT A SUMMARY OF IT ────────────────────
       `assertNoBlockingGap` is what `POST /:id/versions` refused with: the
       first blocking gap, and where every quotation for it was excluded for
       one reason, that reason's own code and message — "the quotation
       expired", "below the supplier's minimum", "quoted in another unit".
       Dozens of suites read those codes, and they are still true: the engine
       is unchanged and would still refuse exactly this.

       It is reproduced HERE, in the fixture, rather than by the orchestration.
       Those codes are derived from the EXCLUDED offers, and an excluded offer
       names its supplier and its rate — which is precisely what Sales may not
       be shown. So Sales gets the gap, its owner and its message; a fixture
       standing in for the retired route gets what the route gave. */
    const subject = out.costingId
      ? String(out.costingId)
      : String((await Costing.findOne({
        companyId: ctx.companyId,
        "context.primaryId": String(enquiryId),
        "context.externalKey": product,
      }).select("_id").lean() || {})._id || "");
    /* The assembly can itself refuse — no technical record, a style the
       brief names that this costing cannot reach. That refusal IS the answer;
       letting it escape would turn a correct refusal into a thrown fixture. */
    let assembled = null;
    if (subject) {
      try {
        assembled = await assembleForCosting(subject, { capabilities: [...ctx.capabilitySet] });
      } catch (err) {
        if (!err?.code) throw err;
        return {
          status: err.status || 409,
          body: { success: false, error: { code: err.code, message: err.message, details: err.details || {} } },
        };
      }
    }
    try {
      if (assembled) {
        require("../../../services/centralCosting/versionCreation.service")
          .assertNoBlockingGap(assembled);
      }
    } catch (err) {
      return {
        status: err.status || 409,
        body: { success: false, error: { code: err.code, message: err.message, details: err.details || {} } },
      };
    }

    /* It found nothing blocking and the orchestration did — a disagreement
       worth failing loudly on rather than papering over with a generic body. */
    const first = out.result.blockers.find((b) => b.blocking) || null;
    return {
      status: 409,
      body: {
        success: false,
        error: {
          code: "COSTING_ASSEMBLY_BLOCKED",
          message: first?.message || "Some inputs this estimate needs are missing.",
          details: { missing: out.result.blockers, key: first?.key || null, reason: "ASSEMBLY_BLOCKED",
            owner: first?.owner ? { department: first.owner } : null },
        },
      },
    };
  }

  const costing = await Costing.findById(out.costingId).lean();
  const versions = await CostingVersion.find({ costingId: out.costingId })
    .sort({ versionNumber: -1 }).lean();

  /* Serialised through the SAME visibility rules the route used, so a suite
     asserting on what a reader may see still asserts on the real answer —
     and carrying the same envelope, because suites read `policyConfigured`
     and `visibility` off it as readily as they read the version. */
  const policyService = require("../../../services/centralCosting/policy.service");
  const bundle = await policyService.getPolicy(ctx).catch(() => null);

  return {
    status: 201,
    body: {
      success: true,
      ...visibility.serialize({ costing, versions, ctx }),
      policyConfigured: bundle ? bundle.configured !== false : null,
    },
  };
}

/**
 * PREPARE THE ESTIMATE FOR A COSTING THAT ALREADY EXISTS.
 *
 * ── WHY THIS EXISTS BESIDE `prepareAsRoute` ─────────────────────────────────
 * Two dozen suites hold a `costingId` and a `{co, me}` pair, because that is
 * what `POST /:id/versions` needed. `prepareAsRoute` needs the ENQUIRY and the
 * product, which is what Sales holds — and threading those back through every
 * fixture's `world()` would be a large edit to prove nothing.
 *
 * So this reads the costing's own context. That is not a shortcut: the context
 * is the enquiry product the costing was raised against, and it is exactly
 * what the orchestration resolves the brief from. The company comes off the
 * costing too, so a fixture cannot accidentally prepare across a tenancy.
 *
 * The actor is a fixture identity unless a suite names one. It matters in two
 * places and both are deliberate: the creation claim hashes it, so two
 * different actors replaying one key are two different actions; and the
 * version's provenance records it.
 */
async function prepareForCosting(costingId, {
  actorId = null, actorName = "Fixture Actor", capabilities = null, actionKey = null,
} = {}) {
  const Costing = require("../../../models/CMS_Models/Costing/Costing");
  const costing = await Costing.findById(costingId).lean();
  if (!costing) throw new Error(`prepareForCosting: no costing ${costingId}`);
  if (costing.context?.type !== "ENQUIRY_STYLE") {
    throw new Error("prepareForCosting: only an enquiry costing has an estimate to prepare");
  }

  const ctx = {
    companyId: costing.companyId,
    actorId: actorId || `fixture-actor-${++prepSeq}`,
    actorName,
    capabilitySet: new Set(capabilities || [
      "costing.draft.write", "costing.cost.read", "costing.margin.read",
      "costing.output.read", "costing.approve",
      /* Preparing requires `costing.prepare`, which nothing else implies —
         see `sales-prepare-authorisation.test.js`. Every actor built here is
         an AUTHORISED one; the refusals are proved against real department
         grants in that suite, not by leaving a fixture short. */
      "costing.prepare",
    ]),
  };

  return prepareAsRoute(ctx, {
    enquiryId: costing.context.primaryId,
    product: costing.context.externalKey,
    actionKey,
  });
}

/**
 * THE ASSEMBLY ITSELF, FOR THE CLAIMS SALES IS NOT ALLOWED TO SEE.
 *
 * ── WHY THIS IS NOT A BACK DOOR ─────────────────────────────────────────────
 * `prepareAsRoute` reports a blocked estimate the way SALES is shown one: the
 * gap, its owner and its message, and nothing else. Some suites assert on the
 * candidates behind a gap — that two quotations apply, that the cheaper is not
 * preferred, that they come back in supplier order. That is a real claim and
 * it is the ENGINE's, not Sales': an excluded or candidate offer names its
 * supplier and its rate, and the whole point of the narrow projection is that
 * those never reach a Sales response.
 *
 * So those suites read the assembly directly, which is where the data lives
 * and who the claim is about. The person who acts on it is a buyer, on Store's
 * sourcing-decision queue, and that surface has its own tests.
 */
async function assembleForCosting(costingId, { capabilities = null, lines = null } = {}) {
  const Costing = require("../../../models/CMS_Models/Costing/Costing");
  const assembly = require("../../../services/centralCosting/assembly.service");
  const policyService = require("../../../services/centralCosting/policy.service");
  const salesBrief = require("../../../services/centralCosting/salesBrief.service");
  const costingBrief = require("../../../services/sales/costingBrief.service");
  const { parseScenarios } = require("../../../services/centralCosting/calculationInput");

  const costing = await Costing.findById(costingId).lean();
  if (!costing) throw new Error(`assembleForCosting: no costing ${costingId}`);

  const ctx = {
    companyId: costing.companyId,
    actorId: `fixture-actor-${++prepSeq}`,
    actorName: "Fixture Actor",
    capabilitySet: new Set(capabilities || [
      "costing.draft.write", "costing.cost.read", "costing.margin.read",
      "costing.output.read", "costing.approve",
      /* Preparing requires `costing.prepare`, which nothing else implies —
         see `sales-prepare-authorisation.test.js`. Every actor built here is
         an AUTHORISED one; the refusals are proved against real department
         grants in that suite, not by leaving a fixture short. */
      "costing.prepare",
    ]),
  };

  const Enquiry = require("../../../models/CMS_Models/Sales/Enquiry");
  const enquiry = await Enquiry.findOne({ _id: costing.context.primaryId, companyId: costing.companyId }).lean()
    || await Enquiry.findById(costing.context.primaryId).lean();
  const brief = costingBrief.confirmedBriefOn(enquiry, costing.context.externalKey);
  if (!brief) throw new Error("assembleForCosting: no confirmed brief on the enquiry");
  const fromBrief = salesBrief.toCalculationInput(brief);
  const policyBundle = await policyService.getPolicy(ctx);

  return assembly.assembleLines(ctx, costing, {
    styleId: fromBrief.technicalStyleId,
    policy: policyBundle.policy,
    scenarios: parseScenarios(fromBrief.scenarios),
    /* ── ONLY EVER FOR A TEST THAT WANTS THEM REFUSED ──────────────────
       The orchestration passes none, and that is the point: no client can
       put a figure in front of the engine any more. A suite proving the
       engine still turns one away needs some way to hand it one, and this is
       it — not a door, a probe. */
    ...(lines ? { clientLines: lines } : {}),
  });
}

/**
 * THE RETIRED ROUTE'S WHOLE SEQUENCE, WITHOUT THE ROUTE.
 *
 * ── WHAT THE SUITES USING THIS ARE ACTUALLY ABOUT ───────────────────────────
 * A large family of tests posted LINES and asserted on what happened: an
 * imported row that matches the record calculates; one whose consumption,
 * unit, item, variant, evidence or behaviour has been altered is refused by
 * name; a declared override is refused whatever shape it arrives in.
 *
 * The route parsed the body, assembled, then calculated, and the answer came
 * from whichever step saw the problem. It refuses a browser client outright
 * now, so a posted line meets `COSTING_PREPARATION_MOVED_TO_SALES` before any
 * of that — a stronger answer to "can a client send a figure", and a useless
 * one to "does the engine still check what it was sent".
 *
 * So this runs the same three steps directly. The door is checked first and
 * must refuse; then the lines go to the parser and the assembly, and whichever
 * refuses answers, in the shape the route answered in. If nothing refuses, the
 * estimate is prepared the way Sales prepares it — because a line that
 * survives every check describes a row the server assembles for itself, which
 * is the whole claim of the migration.
 */
async function prepareWithLines(costingId, lines = [], { actionKey = null, door = null } = {}) {
  const shaped = (err) => ({
    status: err.status || 400,
    body: { success: false, error: { code: err.code, message: err.message, details: err.details || {} } },
  });

  if (typeof door === "function") await door();

  if (Array.isArray(lines) && lines.length) {
    const { parseLine } = require("../../../services/centralCosting/calculationInput");
    const seen = new Set();
    const parsed = [];
    for (let i = 0; i < lines.length; i += 1) {
      try {
        parsed.push(parseLine(lines[i], i, "INR", seen));
      } catch (err) {
        return shaped(err);
      }
    }
    let assembled = null;
    try {
      assembled = await assembleForCosting(costingId, { lines: parsed });
    } catch (err) {
      return shaped(err);
    }

    /* ── AND THE BINDING, WHICH THE ROUTE RAN AFTER THE ASSEMBLY ──────────
       `bindTechnicalLines` re-reads the style and revalidates every line
       carrying a `technicalKey` against it — the consumption, the unit, the
       item, the variant, the evidence, the behaviour. It is what refuses a
       row that says it came from the record while saying something the record
       does not. Leaving it out here would make a suite about exactly that
       report success. */
    const Costing = require("../../../models/CMS_Models/Costing/Costing");
    const technicalBinding = require("../../../services/centralCosting/technicalBinding.service");
    const policyService = require("../../../services/centralCosting/policy.service");
    const costing = await Costing.findById(costingId).lean();
    const ctx = {
      companyId: costing.companyId,
      actorId: `fixture-actor-${++prepSeq}`,
      actorName: "Fixture Actor",
      capabilitySet: new Set([
        "costing.draft.write", "costing.cost.read", "costing.margin.read",
        "costing.output.read", "costing.approve", "costing.prepare",
      ]),
    };
    const bundle = await policyService.getPolicy(ctx);
    try {
      await technicalBinding.bindTechnicalLines(ctx, costing, {
        lines: assembled.lines,
        clientLines: parsed,
        technicalStyleId: assembled.styleId || "",
      }, { currency: bundle.policy.baseCurrency, policy: bundle.policy });
    } catch (err) {
      return shaped(err);
    }
  }

  return prepareForCosting(costingId, { actionKey });
}

module.exports = {
  /* Exported so a suite can pin the baseline shape itself — see
     `board-duty-costing`. */
  sourcingFor,
  seedSourceBacked, confirmCostingBrief, confirmCommercialLine, prepareEstimate, prepareAsRoute, prepareForCosting, assembleForCosting, prepareWithLines, seedHistoricalAdhoc, configureProduction,
  approveFinancingPolicy, approveOverheadPolicy, approveLabourPolicy, approveGstPolicy,
  approveDevelopmentPolicy, approveContingencyPolicy, approveMarginPolicy, seedHistoricalBandPolicy,
  PRODUCTION_POLICY, EXPECTED, CONFIRMED_TERMS,
  EVERY_FAMILY, SOURCING,
};
