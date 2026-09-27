// Enrich the exact PPC walkthrough handover used by the Merchandising review
// screen and link it to a matching Development file with attributed images.
//
// Dry-run by default. Writes only with --apply and only after the configured
// database, company and demo handover identity have all been proven.
"use strict";

require("dotenv/config");

const mongoose = require("mongoose");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const SalesHandoverVersion = require("../../models/CMS_Models/Sales/SalesHandoverVersion");
const { SalesDevelopmentRequest } = require("../../models/CMS_Models/Sales/DevelopmentRequest");
const {
  DevelopmentFile,
  DevelopmentBomRevision,
} = require("../../models/CMS_Models/Merchandising/Development");

const COMPANY_ID = "6a08040a1fecacc9bb7149c2";
const COMPANY_NAME = "GRAV CLOTHING PVT LTD";
const HANDOVER_ID = "6ab38c1c26d85ecfcc19c64a";
const ORDER_REF = "PPC-WALKTHROUGH-2026-ORDER-001";
const LINE_REF = "LN-PPC-WALKTHROUGH-2026-001";
const STYLE_REF = "PPC-WALKTHROUGH-STYLE-001";
const DEVELOPMENT_NUMBER = "DEMO-ORDER-DEV-001";
const REQUEST_REF = "DEMO-ORDER-DEV-REQUEST-001";
const PRODUCT_LINE_REF = `${LINE_REF}-DEVELOPMENT`;

const salesActor = {
  name: "Meera Demo",
  email: "sales.demo@grav.local",
};
const maker = {
  name: "Aisha Demo",
  email: "merch.demo@grav.local",
};
const checker = {
  name: "Rahul Demo",
  email: "merch.approver@grav.local",
};

const references = [
  {
    url: "/demo/merchandising/execution/embroidered-polo/front.png",
    caption: "Buyer reference · Front view",
  },
  {
    url: "/demo/merchandising/execution/embroidered-polo/back.png",
    caption: "Buyer reference · Back view",
  },
  {
    url: "/demo/merchandising/execution/embroidered-polo/embroidery-detail.png",
    caption: "Artwork reference · Left-chest embroidery",
  },
  {
    url: "/demo/merchandising/execution/embroidered-polo/materials-and-trims.png",
    caption: "Material reference · Pique, rib, buttons and threads",
  },
];

const requirementSummary = [
  "[DEMO DATA] Harbor & Co · Resort Performance 2027 · embroidered polo.",
  "Use 220 GSM combed-cotton pique in deep navy with matching rib collar and cuffs,",
  "matte four-hole buttons and a white/sky-blue 52 mm left-chest embroidery.",
  "Maintain a regular fit, three-button placket, side vents and tonal construction stitching.",
  "Buyer-approved artwork revision 3 applies. Pack folded with recycled tissue, one garment per recycled polybag.",
].join(" ");

const bomRows = [
  {
    rowRef: "DEMO-ORDER-POLO-FABRIC",
    category: "FABRIC",
    rawItemName: "220 GSM combed-cotton pique",
    rawItemSku: "FAB-PIQUE-220-NVY",
    colourOrShade: "Deep navy",
    finish: "Bio-polished, pre-shrunk",
    placement: "Main body and sleeves",
    appliesTo: "Whole style",
    selectionNote: "Approved lab dip Navy N-17; spirality maximum 3%.",
    source: { kind: "MERCHANDISING_SELECTION", reference: DEVELOPMENT_NUMBER },
  },
  {
    rowRef: "DEMO-ORDER-POLO-RIB",
    category: "TRIM",
    rawItemName: "1x1 cotton rib collar and cuff",
    rawItemSku: "TRM-RIB-NVY-01",
    colourOrShade: "Deep navy, body matched",
    finish: "Compact knit",
    placement: "Collar and sleeve cuffs",
    appliesTo: "Whole style",
    selectionNote: "Recovery approved on development sample revision 2.",
    source: { kind: "MERCHANDISING_SELECTION", reference: DEVELOPMENT_NUMBER },
  },
  {
    rowRef: "DEMO-ORDER-POLO-BUTTON",
    category: "TRIM",
    rawItemName: "Matte four-hole polo button 14L",
    rawItemSku: "TRM-BTN-14L-MATTE",
    colourOrShade: "Dark navy",
    finish: "Soft-touch matte",
    placement: "Front placket, three plus one spare",
    appliesTo: "Whole style",
    selectionNote: "Button colour to match approved garment standard.",
    source: { kind: "MERCHANDISING_SELECTION", reference: DEVELOPMENT_NUMBER },
  },
  {
    rowRef: "DEMO-ORDER-POLO-LABEL",
    category: "LABEL",
    rawItemName: "Woven main and size label set",
    rawItemSku: "LBL-HC-POLO-041",
    colourOrShade: "Navy / white",
    finish: "Damask woven, soft edge",
    placement: "Centre-back neck",
    appliesTo: "Whole style",
    selectionNote: "Use Harbor & Co artwork revision 5.",
    source: { kind: "MERCHANDISING_SELECTION", reference: DEVELOPMENT_NUMBER },
  },
  {
    rowRef: "DEMO-ORDER-POLO-PACK",
    category: "SAMPLE_PACKAGING",
    rawItemName: "Recycled garment polybag and tissue",
    rawItemSku: "PKG-RLDPE-POLO",
    colourOrShade: "Clear / white",
    finish: "GRS recycled content",
    placement: "One folded garment per bag",
    appliesTo: "Shipment presentation",
    selectionNote: "Apply size sticker and order-line barcode to lower-right corner.",
    source: { kind: "MERCHANDISING_SELECTION", reference: DEVELOPMENT_NUMBER },
  },
];

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required.");
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  try {
    if (mongoose.connection.name !== "test") throw new Error("Refusing unexpected database.");

    const company = await Acc_Company.findById(COMPANY_ID).lean();
    if (!company || company.companyName !== COMPANY_NAME) {
      throw new Error("GRAV company identity did not match.");
    }

    const handover = await SalesHandoverVersion.findOne({
      _id: HANDOVER_ID,
      companyId: company._id,
      handoverRef: ORDER_REF,
      handoverLineRef: LINE_REF,
    }).lean();
    if (!handover) throw new Error("The exact PPC walkthrough handover was not found.");

    const existingFile = await DevelopmentFile.findOne({
      companyId: company._id,
      developmentNumber: DEVELOPMENT_NUMBER,
    }).select("_id currentRequestId currentBomRevisionNo").lean();

    console.log(JSON.stringify({
      database: mongoose.connection.name,
      company: company.companyName,
      handover: { id: HANDOVER_ID, orderRef: ORDER_REF, lineRef: LINE_REF },
      developmentExists: Boolean(existingFile),
      references: references.length,
      apply: process.argv.includes("--apply"),
    }, null, 2));
    if (!process.argv.includes("--apply")) return;

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const now = new Date();
        let request = await SalesDevelopmentRequest.findOne({
          companyId: company._id,
          requestRef: REQUEST_REF,
          versionNo: 1,
        }).session(session);

        let file = await DevelopmentFile.findOne({
          companyId: company._id,
          developmentNumber: DEVELOPMENT_NUMBER,
        }).session(session);

        if (!request) {
          const journeyId = file?.journeyId || new mongoose.Types.ObjectId();
          const enquiryId = new mongoose.Types.ObjectId();
          [request] = await SalesDevelopmentRequest.create([{
            companyId: company._id,
            requestRef: REQUEST_REF,
            versionNo: 1,
            journeyId,
            journeyRef: "DEMO-ORDER-POLO-JOURNEY-001",
            enquiryId,
            productLineRef: PRODUCT_LINE_REF,
            state: "ISSUED",
            buyerDisplayLabel: "Harbor & Co",
            accountRef: "DEMO-HARBOR-CO",
            productName: "Performance embroidered polo",
            styleRef: STYLE_REF,
            sampleStyleId: handover.executionProjection?.sampleStyleId || null,
            referenceImages: references,
            requirementSummary,
            requestedCategories: ["FABRIC", "TRIMS", "LABELS", "ACCESSORIES", "SAMPLE_PACKAGING"],
            requiredByDate: "2026-08-28",
            targetPriceCeiling: { amount: 925, currency: "INR", basis: "PER_PIECE" },
            requestedBy: salesActor,
            requestedAt: new Date("2026-07-14T05:30:00.000Z"),
          }], { session });
        } else {
          /* Issued requests are immutable through the application. This
             exact, prefixed fixture is enriched by the seeder's scoped
             migration write, never by an application command. */
          await SalesDevelopmentRequest.updateOne(
            { _id: request._id, companyId: company._id, requestRef: REQUEST_REF },
            { $set: {
              referenceImages: references,
              requirementSummary,
              requestedCategories: ["FABRIC", "TRIMS", "LABELS", "ACCESSORIES", "SAMPLE_PACKAGING"],
              targetPriceCeiling: { amount: 925, currency: "INR", basis: "PER_PIECE" },
            } },
            { session, runValidators: true },
          );
          request = await SalesDevelopmentRequest.findById(request._id).session(session);
        }

        if (!file) {
          [file] = await DevelopmentFile.create([{
            developmentNumber: DEVELOPMENT_NUMBER,
            companyId: company._id,
            journeyId: request.journeyId,
            journeyRef: request.journeyRef,
            productLineRef: PRODUCT_LINE_REF,
            currentRequestId: request._id,
            currentRequestVersionNo: 1,
            requestHistory: [{ requestId: request._id, versionNo: 1, event: "ISSUED", at: now, by: salesActor }],
            productName: "Performance embroidered polo",
            styleRef: STYLE_REF,
            buyerDisplayLabel: "Harbor & Co",
            sampleStyleId: handover.executionProjection?.sampleStyleId || null,
            requiredByDate: "2026-08-28",
            lifecycleStatus: "RELEASED_TO_RND",
            responsibleMerchandiser: {
              email: maker.email,
              name: maker.name,
              assignedAt: new Date("2026-07-15T05:30:00.000Z"),
              assignedBy: checker,
            },
            currentBomRevisionNo: 1,
            releasedToRndAt: new Date("2026-08-31T05:30:00.000Z"),
            releasedBy: salesActor,
            releaseReference: "DEMO-ORDER-POLO-REL-001",
            releasedBomRevisionNo: 1,
            coordinationNote: "[DEMO DATA] Buyer-approved polo development linked to the confirmed order handover.",
            revision: 3,
            createdBy: maker,
            updatedBy: maker,
          }], { session });
        } else {
          file.currentRequestId = request._id;
          file.currentRequestVersionNo = 1;
          file.productName = "Performance embroidered polo";
          file.styleRef = STYLE_REF;
          file.buyerDisplayLabel = "Harbor & Co";
          file.currentBomRevisionNo = 1;
          file.releasedBomRevisionNo = 1;
          file.releaseReference = "DEMO-ORDER-POLO-REL-001";
          file.releasedToRndAt = file.releasedToRndAt || new Date("2026-08-31T05:30:00.000Z");
          await file.save({ session });
        }

        await DevelopmentBomRevision.updateOne(
          { companyId: company._id, developmentFileId: file._id, revisionNo: 1 },
          {
            $setOnInsert: {
              companyId: company._id,
              developmentFileId: file._id,
              revisionNo: 1,
              createdBy: maker,
            },
            $set: {
              state: "APPROVED",
              rows: bomRows,
              submittedBy: maker,
              submittedAt: new Date("2026-08-25T05:30:00.000Z"),
              approvedBy: checker,
              approvedAt: new Date("2026-08-28T05:30:00.000Z"),
              revision: 3,
            },
          },
          { upsert: true, session, runValidators: true },
        );

        const release = {
          releaseReference: "DEMO-ORDER-POLO-REL-001",
          developmentFileId: file._id,
          bomRevisionNo: 1,
          authorisedAt: new Date("2026-08-31T05:30:00.000Z"),
          authorisedBy: salesActor,
          idempotencyKey: "demo-order-polo-release-001",
          correlationId: "demo-order-polo-release-correlation-001",
        };
        await SalesDevelopmentRequest.updateOne(
          { _id: request._id, companyId: company._id, requestRef: REQUEST_REF },
          { $set: { release, releases: [release] } },
          { session, runValidators: true },
        );

        /* This is a named demo fixture, not a production correction. Issued
           handovers are immutable in the application; the seeder updates only
           this exact walkthrough record so its screen exercises the complete
           read contract. */
        await SalesHandoverVersion.updateOne(
          {
            _id: handover._id,
            companyId: company._id,
            handoverRef: ORDER_REF,
            handoverLineRef: LINE_REF,
          },
          {
            $set: {
              "executionProjection.fulfilmentModel": "FULL_PACKAGE",
              "executionProjection.styleRef": STYLE_REF,
              "executionProjection.buyerStyleRef": "HC-POLO-041",
              "executionProjection.productName": "Performance embroidered polo",
              "executionProjection.buyerDisplayLabel": "Harbor & Co",
              "executionProjection.brandDisplayLabel": "Northline Active",
              "executionProjection.totalQuantity": 600,
              "executionProjection.breakdown": [
                {
                  lineSplitRef: `${LINE_REF}-NAVY`,
                  attributes: [{ name: "Colour", value: "Deep navy" }],
                  sizeRange: "XS–XXL",
                  quantity: 360,
                },
                {
                  lineSplitRef: `${LINE_REF}-SKY`,
                  attributes: [{ name: "Colour", value: "Cloud blue" }],
                  sizeRange: "XS–XXL",
                  quantity: 240,
                },
              ],
              "executionProjection.deliveries": [
                {
                  dropRef: `${LINE_REF}-D1` ,
                  committedDeliveryDate: new Date("2026-11-20T00:00:00.000Z"),
                  targetExFactoryDate: new Date("2026-11-06T00:00:00.000Z"),
                  nominatedFactoryRef: "GRAV-UNIT-01",
                  quantity: 360,
                },
                {
                  dropRef: `${LINE_REF}-D2`,
                  committedDeliveryDate: new Date("2026-12-04T00:00:00.000Z"),
                  targetExFactoryDate: new Date("2026-11-20T00:00:00.000Z"),
                  nominatedFactoryRef: "GRAV-UNIT-01",
                  quantity: 240,
                },
              ],
              "executionProjection.allocations": [
                {
                  allocationRef: `${LINE_REF}-A1`,
                  lineSplitRef: `${LINE_REF}-NAVY`,
                  dropRef: `${LINE_REF}-D1`,
                  quantity: 360,
                },
                {
                  allocationRef: `${LINE_REF}-A2`,
                  lineSplitRef: `${LINE_REF}-SKY`,
                  dropRef: `${LINE_REF}-D2`,
                  quantity: 240,
                },
              ],
              "executionProjection.packingRequirement": "Fold around recycled tissue; one garment per GRS recycled polybag with size sticker and order-line barcode; 24 pieces per export carton.",
              "executionProjection.testingRequirement": "AATCC colourfastness grade 4 minimum, dimensional stability within ±3%, spirality maximum 3%, nickel-safe trims and embroidery appearance after five washes.",
              "executionProjection.deliveryRequirement": "Two confirmed drops to the buyer’s UK consolidation centre. Cartons must be assortment-labelled and delivery documents must quote HC-POLO-041.",
              "executionProjection.processRequirements.processes.0.buyerSpecification": "52 mm white and sky-blue geometric logo at left chest; artwork revision 3; satin stitch; placement 82 mm below shoulder seam.",
              "executionProjection.processRequirements.processes.0.evidence.approvalRevision": 3,
              "executionProjection.processRequirements.processes.0.evidence.approvedAt": new Date("2026-09-18T07:30:00.000Z"),
              "executionProjection.processRequirements.processes.0.evidence.poDate": new Date("2026-09-18T00:00:00.000Z"),
              "executionProjection.processRequirements.processes.0.evidence.documentName": "HC_POLO_041_PO_and_artwork_rev3.pdf",
              "executionProjection.processRequirements.statedBy": salesActor,
              developmentReference: {
                developmentFileId: file._id,
                developmentNumber: DEVELOPMENT_NUMBER,
                bomRevisionNo: 1,
                releaseReference: "DEMO-ORDER-POLO-REL-001",
              },
            },
          },
          { session, runValidators: true },
        );
      });
    } finally {
      await session.endSession();
    }

    const [savedHandover, savedFile, savedRequest] = await Promise.all([
      SalesHandoverVersion.findById(HANDOVER_ID).lean(),
      DevelopmentFile.findOne({ companyId: company._id, developmentNumber: DEVELOPMENT_NUMBER }).lean(),
      SalesDevelopmentRequest.findOne({ companyId: company._id, requestRef: REQUEST_REF, versionNo: 1 }).lean(),
    ]);
    console.log(JSON.stringify({
      outcome: "UPDATED",
      handoverId: String(savedHandover._id),
      product: savedHandover.executionProjection.productName,
      buyerStyle: savedHandover.executionProjection.buyerStyleRef,
      splits: savedHandover.executionProjection.breakdown.length,
      drops: savedHandover.executionProjection.deliveries.length,
      developmentFileId: String(savedFile._id),
      developmentNumber: savedFile.developmentNumber,
      references: savedRequest.referenceImages.length,
    }, null, 2));
  } finally {
    if (mongoose.connection.readyState) await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});
