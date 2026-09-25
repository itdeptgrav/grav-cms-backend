// Persistent Development-register demo data for a specifically named company.
//
// Unlike merchandising-demo-server.js, this writes to the configured database.
// It therefore refuses to run without both --apply and an explicit company id.
// Every business reference is prefixed DEMO-DEV so the records are unmistakable.
"use strict";

require("dotenv").config();

const mongoose = require("mongoose");
const { randomUUID } = require("crypto");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const {
  SalesDevelopmentRequest,
} = require("../../models/CMS_Models/Sales/DevelopmentRequest");
const {
  DevelopmentFile,
  DevelopmentRequestReceipt,
  DevelopmentBomRevision,
} = require("../../models/CMS_Models/Merchandising/Development");
const {
  MerchandisingAuditEvent,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");

const PREFIX = "DEMO-DEV-";
const arg = (name) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? String(process.argv[at + 1] || "").trim() : "";
};
const day = (offset) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const oid = () => new mongoose.Types.ObjectId();

const salesActor = { name: "Meera Demo", email: "sales.demo@grav.local" };
const maker = { name: "Aisha Demo", email: "merch.demo@grav.local" };
const checker = { name: "Rahul Demo", email: "merch.approver@grav.local" };

const resortReferences = [
  {
    url: "/demo/merchandising/development/rs-510/resort-shirt-front.jpg",
    caption: "Buyer reference · Front view",
  },
  {
    url: "/demo/merchandising/development/rs-510/resort-shirt-back.jpg",
    caption: "Buyer reference · Back view",
  },
  {
    url: "/demo/merchandising/development/rs-510/cotton-linen-texture.jpg",
    caption: "Material reference · Warm-ivory cotton-linen texture",
  },
  {
    url: "/demo/merchandising/development/rs-510/coconut-buttons.jpg",
    caption: "Trim reference · Coconut-look four-hole buttons",
  },
  {
    url: "/demo/merchandising/development/rs-510/camp-collar-detail.jpg",
    caption: "Construction reference · Camp collar and front placket",
  },
];

const resortBrief = [
  "[DEMO DATA] Northstar Apparel · Resort 2027 · UK market · men's woven shirts.",
  "Develop a relaxed short-sleeve resort shirt in warm ivory with a camp collar, straight hem and side vents.",
  "Select a breathable, soft-hand textured fabric with adequate opacity; tonal sewing thread; natural coconut-look 18L front buttons plus one spare; woven main and size labels; care label; hangtag; and recyclable first-proto sample packaging.",
  "Sample: two pieces in size M. Avoid excessive transparency and keep all visible stitching tonal.",
].join(" ");

async function enrichDemoRecords(companyId) {
  const request = await SalesDevelopmentRequest.findOne({
    companyId, requestRef: `${PREFIX}001`, versionNo: 1,
  }).select("_id").lean();
  const file = await DevelopmentFile.findOne({
    companyId, developmentNumber: `${PREFIX}001`,
  }).select("_id developmentNumber lifecycleStatus createdAt").lean();

  if (!request || !file) throw new Error("DEMO-DEV-001 was not found after seeding.");

  await Promise.all([
    SalesDevelopmentRequest.updateOne(
      { _id: request._id, companyId },
      {
        $set: {
          requirementSummary: resortBrief,
          referenceImages: resortReferences,
          requestedCategories: ["FABRIC", "TRIMS", "LABELS", "ACCESSORIES", "SAMPLE_PACKAGING"],
          targetPriceCeiling: { amount: 850, currency: "INR", basis: "PER_PIECE" },
        },
      },
    ),
    DevelopmentFile.updateOne(
      { _id: file._id, companyId },
      {
        $set: {
          coordinationNote: file.lifecycleStatus === "NEW"
            ? "[DEMO DATA] Incoming Resort 2027 brief is complete and ready for Merchandising review. Five buyer references are attached; no material has been selected or approved yet."
            : "[DEMO DATA] Resort 2027 brief with five buyer references and an ₹850 per-piece Sales target ceiling. Material selection remains Merchandising's work.",
          updatedBy: salesActor,
        },
      },
    ),
  ]);

  const openedAt = file.createdAt || new Date();
  const events = [
    {
      correlationId: `${PREFIX}001-CREATED`,
      action: "DEVELOPMENT_FILE_CREATED",
      at: openedAt,
      reason: "Sales issued the Resort 2027 product-development request.",
      details: { requestVersionNo: 1 },
    },
    {
      correlationId: `${PREFIX}001-REFERENCES`,
      action: "DEVELOPMENT_OBSERVED",
      at: new Date(new Date(openedAt).getTime() + 60 * 1000),
      reason: "Sales supplied five product, material, trim and construction references.",
      details: { referenceCount: resortReferences.length },
    },
  ];
  for (const event of events) {
    await MerchandisingAuditEvent.updateOne(
      { companyId, developmentFileId: file._id, correlationId: event.correlationId },
      {
        $setOnInsert: {
          companyId,
          recordType: "DEVELOPMENT_FILE",
          recordId: file._id,
          developmentFileId: file._id,
          developmentNumber: file.developmentNumber,
          action: event.action,
          actor: salesActor,
          source: "sales",
          at: event.at,
          reason: event.reason,
          correlationId: event.correlationId,
          resultingState: "NEW",
          details: event.details,
        },
      },
      { upsert: true },
    );
  }

  return {
    developmentNumber: `${PREFIX}001`,
    references: resortReferences.length,
    status: file.lifecycleStatus,
  };
}

const rowsFor = (code, fabric, shade) => [
  {
    rowRef: `${code}-FABRIC`, category: "FABRIC",
    rawItemName: fabric, rawItemSku: `${code}-FAB-01`,
    colourOrShade: shade, finish: "Soft handle, pre-shrunk",
    placement: "Main body and sleeves", appliesTo: "Whole style",
    selectionNote: "Primary fabric selected for the first sample.",
    source: { kind: "MERCHANDISING_SELECTION", reference: `${PREFIX}${code}` },
  },
  {
    rowRef: `${code}-THREAD`, category: "TRIM",
    rawItemName: "Core-spun sewing thread", rawItemSku: `${code}-TRM-01`,
    colourOrShade: "Tonal", finish: "Colour matched",
    placement: "All seams", appliesTo: "Whole style",
    selectionNote: "Match thread to the approved fabric shade.",
    source: { kind: "MERCHANDISING_SELECTION", reference: `${PREFIX}${code}` },
  },
  {
    rowRef: `${code}-MAIN-LABEL`, category: "LABEL",
    rawItemName: "Woven main label", rawItemSku: `${code}-LBL-01`,
    colourOrShade: "Buyer artwork colours", finish: "Damask woven",
    placement: "Centre-back neck", appliesTo: "Whole style",
    selectionNote: "Use buyer artwork revision 2.",
    source: { kind: "MERCHANDISING_SELECTION", reference: `${PREFIX}${code}` },
  },
  {
    rowRef: `${code}-HANGTAG`, category: "ACCESSORY",
    rawItemName: "Buyer hangtag", rawItemSku: `${code}-ACC-01`,
    colourOrShade: "Natural kraft / black", finish: "Matt",
    placement: "First button or belt loop", appliesTo: "Whole style",
    selectionNote: "Sample presentation only; commercial quantity is not recorded here.",
    source: { kind: "MERCHANDISING_SELECTION", reference: `${PREFIX}${code}` },
  },
  {
    rowRef: `${code}-SAMPLE-BAG`, category: "SAMPLE_PACKAGING",
    rawItemName: "Reusable sample garment bag", rawItemSku: `${code}-PKG-01`,
    colourOrShade: "Clear", finish: "Recycled LDPE",
    placement: "One development sample", appliesTo: "Sample dispatch",
    selectionNote: "Identify style, colourway and sample stage on the sticker.",
    source: { kind: "MERCHANDISING_SELECTION", reference: `${PREFIX}${code}` },
  },
];

const scenarios = [
  {
    code: "001", lifecycle: "NEW", bom: null, receipt: null,
    buyer: "Northstar Apparel", product: "Textured resort shirt", style: "RS-510",
    fabric: "Cotton-linen slub", shade: "Natural sand", due: 12,
    summary: "Select breathable fabric, coconut-look buttons, labels and sample packaging for the first proto sample.",
  },
  {
    code: "002", lifecycle: "NEW", bom: null, receipt: "CLARIFICATION_REQUESTED",
    buyer: "Harbor & Co", product: "Performance running tee", style: "AT-224",
    fabric: "Recycled polyester jersey", shade: "Electric blue", due: 9,
    summary: "Choose moisture-management fabric, reflective trim and transfer labels for the development sample.",
    clarification: "The reflective-trim artwork reference is missing. Sales needs to attach the buyer-approved placement before selection begins.",
  },
  {
    code: "003", lifecycle: "ACTIVE", bom: "DRAFT", receipt: "ACCEPTED",
    buyer: "Fieldline", product: "Washed denim overshirt", style: "DJ-630",
    fabric: "11 oz cotton denim", shade: "Vintage indigo", due: 18,
    summary: "Develop the washed denim body, antique-metal trims, woven labels and reusable sample bag.",
  },
  {
    code: "004", lifecycle: "AWAITING_APPROVAL", bom: "SUBMITTED", receipt: "ACCEPTED",
    buyer: "Harbor & Co", product: "Ribbed knit cardigan", style: "KN-412",
    fabric: "Cotton-viscose rib knit", shade: "Forest green", due: 22,
    summary: "Settle the rib-knit body, horn-look buttons, neck label and folded sample presentation.",
  },
  {
    code: "005", lifecycle: "APPROVED", bom: "APPROVED", receipt: "ACCEPTED",
    buyer: "Northstar Apparel", product: "Tailored twill trouser", style: "TR-092",
    fabric: "Stretch cotton twill", shade: "Deep navy", due: 27,
    summary: "Select stretch twill, pocketing, zip, waistband trims and sample-stage packaging for buyer review.",
  },
  {
    code: "006", lifecycle: "RELEASED_TO_RND", bom: "APPROVED", receipt: "ACCEPTED",
    buyer: "Northstar Workwear", product: "Canvas utility jacket", style: "UJ-705",
    fabric: "Organic cotton canvas", shade: "Washed olive", due: 31,
    summary: "Develop the utility-jacket canvas, matte-black hardware, brand patch and sample presentation.",
    released: true,
  },
  {
    code: "007", lifecycle: "CLOSED", bom: "APPROVED", receipt: "ACCEPTED",
    buyer: "Fieldline", product: "Linen camp shirt", style: "LS-118",
    fabric: "European flax linen", shade: "Chalk white", due: -5,
    summary: "Completed development selection retained as a closed example with its approved material revision.",
  },
];

async function main() {
  const companyId = arg("--company");
  if (!process.argv.includes("--apply") || !mongoose.Types.ObjectId.isValid(companyId)) {
    throw new Error("Refusing to write. Run with --apply --company <company ObjectId>.");
  }

  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  const company = await Acc_Company.findById(companyId).select("companyName").lean();
  if (!company) throw new Error("The requested company does not exist.");

  const existing = await DevelopmentFile.find({
    companyId, developmentNumber: { $regex: `^${PREFIX}` },
  }).select("developmentNumber lifecycleStatus").sort({ developmentNumber: 1 }).lean();
  if (existing.length) {
    const enrichment = await enrichDemoRecords(companyId);
    console.log(JSON.stringify({
      outcome: "UPDATED",
      company: company.companyName,
      rows: existing,
      enrichment,
    }, null, 2));
    return;
  }

  const session = await mongoose.startSession();
  const created = [];
  try {
    await session.withTransaction(async () => {
      for (const s of scenarios) {
        const requestId = oid();
        const journeyId = oid();
        const enquiryId = oid();
        const now = new Date();
        const requestRef = `${PREFIX}${s.code}`;
        const releaseReference = s.released ? `${PREFIX}RND-${s.code}` : "";

        await SalesDevelopmentRequest.create([{
          _id: requestId,
          companyId,
          requestRef,
          versionNo: 1,
          journeyId,
          journeyRef: `${PREFIX}JOURNEY-${s.code}`,
          enquiryId,
          productLineRef: `${PREFIX}LINE-${s.code}`,
          state: "ISSUED",
          buyerDisplayLabel: s.buyer,
          accountRef: `${PREFIX}BUYER-${s.code}`,
          productName: s.product,
          styleRef: s.style,
          requestedCategories: ["FABRIC", "TRIMS", "LABELS", "ACCESSORIES", "SAMPLE_PACKAGING"],
          requirementSummary: s.summary,
          requiredByDate: day(s.due),
          requestedBy: salesActor,
          requestedAt: now,
          release: s.released ? {
            releaseReference,
            bomRevisionNo: 1,
            authorisedAt: now,
            authorisedBy: salesActor,
            idempotencyKey: randomUUID(),
            correlationId: randomUUID(),
          } : undefined,
        }], { session });

        const [file] = await DevelopmentFile.create([{
          developmentNumber: requestRef,
          companyId,
          journeyId,
          journeyRef: `${PREFIX}JOURNEY-${s.code}`,
          productLineRef: `${PREFIX}LINE-${s.code}`,
          currentRequestId: requestId,
          currentRequestVersionNo: 1,
          requestHistory: [{ requestId, versionNo: 1, event: "ISSUED", at: now, by: salesActor }],
          productName: s.product,
          styleRef: s.style,
          buyerDisplayLabel: s.buyer,
          requiredByDate: day(s.due),
          lifecycleStatus: s.lifecycle,
          lifecycleReason: s.lifecycle === "CLOSED" ? "Demo development completed and retained for reference." : "",
          responsibleMerchandiser: s.lifecycle === "NEW" ? undefined : {
            email: maker.email,
            name: maker.name,
            assignedAt: now,
            assignedBy: checker,
          },
          currentBomRevisionNo: s.bom === "APPROVED" ? 1 : null,
          releasedToRndAt: s.released ? now : null,
          releasedBy: s.released ? salesActor : undefined,
          releaseReference,
          releasedBomRevisionNo: s.released ? 1 : null,
          coordinationNote: `[DEMO DATA] ${s.summary}`,
          createdBy: maker,
          updatedBy: maker,
        }], { session });

        if (s.receipt) {
          await DevelopmentRequestReceipt.create([{
            companyId,
            requestRef,
            requestVersionNo: 1,
            requestId,
            developmentFileId: file._id,
            state: s.receipt,
            clarification: s.receipt === "CLARIFICATION_REQUESTED" ? {
              category: "REFERENCE_MISSING",
              reason: s.clarification,
            } : undefined,
            decidedBy: maker,
            decidedAt: now,
            revision: 1,
          }], { session });
        }

        if (s.bom) {
          await DevelopmentBomRevision.create([{
            companyId,
            developmentFileId: file._id,
            revisionNo: 1,
            state: s.bom,
            rows: rowsFor(s.code, s.fabric, s.shade),
            submittedBy: ["SUBMITTED", "APPROVED"].includes(s.bom) ? maker : undefined,
            submittedAt: ["SUBMITTED", "APPROVED"].includes(s.bom) ? now : null,
            approvedBy: s.bom === "APPROVED" ? checker : undefined,
            approvedAt: s.bom === "APPROVED" ? now : null,
            createdBy: maker,
            revision: s.bom === "DRAFT" ? 1 : s.bom === "SUBMITTED" ? 2 : 3,
          }], { session });
        }

        if (s.released) {
          await SalesDevelopmentRequest.updateOne(
            { _id: requestId },
            { $set: { "release.developmentFileId": file._id } },
            { session },
          );
        }

        created.push({
          developmentNumber: requestRef,
          lifecycle: s.lifecycle,
          buyer: s.buyer,
          product: s.product,
        });
      }
    });
  } finally {
    await session.endSession();
  }

  const enrichment = await enrichDemoRecords(companyId);

  console.log(JSON.stringify({
    outcome: "CREATED", company: company.companyName, rows: created, enrichment,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState) await mongoose.disconnect();
  });
