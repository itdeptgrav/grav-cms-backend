#!/usr/bin/env node
"use strict";

/*
 * One-time, additive showcase for the IE Development workspace in the shared
 * `test` database. It enriches ONE existing demo style and drives the IE
 * bulletin/method-study/approval lifecycle through the same services as the
 * HTTP routes. It never creates a company, changes access, deletes data, or
 * touches order planning, PPC, Production, barcode or scan records.
 *
 * Run only with IE_DEVELOPMENT_SHOWCASE_SEED=1 and --apply.
 */

const mongoose = require("mongoose");
const { randomUUID } = require("crypto");

const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const { SalesDevelopmentRequest } = require("../../models/CMS_Models/Sales/DevelopmentRequest");
const {
  DevelopmentRequestReceipt,
  DevelopmentFile,
  DevelopmentBomRevision,
} = require("../../models/CMS_Models/Merchandising/Development");
const DeptUser = require("../../models/Access/DeptUser");

const styleFiles = require("../../services/industrialEngineering/ieStyleFile.service");
const versions = require("../../services/industrialEngineering/ieBulletinVersion.service");
const feasibility = require("../../services/industrialEngineering/ieFeasibility.service");
const { actorOf, approveRowTimes } = require("./ieDemoLifecycle");

const MANIFEST_COLLECTION = "ie_demo_manifest";
const MANIFEST_ID = "IE_DEVELOPMENT_SHOWCASE_V1";
const COMPANY_ID = "6a08040a1fecacc9bb7149c2";
const COMPANY_NAME = "GRAV CLOTHING PVT LTD";
const STYLE_ID = "6ab24e5c2935295bc82db1ad";
const STYLE_CODE = "NW-POLO-26";
const REQUEST_REF = "IEDEV-NW-POLO-001";
const DEVELOPMENT_NUMBER = "MDV-DEMO-NW-POLO-001";
const PRODUCT_LINE_REF = "PL-23d678b9b90a";
const APP_ORIGIN = "http://localhost:3001";

const COMPANY = new mongoose.Types.ObjectId(COMPANY_ID);
const STYLE = new mongoose.Types.ObjectId(STYLE_ID);

const EDITOR_EMAIL = "ie.editor.demo@grav.demo";
const APPROVER_EMAIL = "ie.approver.demo@grav.demo";

const OPERATION_TIMES = Object.freeze({
  "SJ-01": 0.72,
  "OL-02": 1.15,
  "OL-03": 1.40,
  "CS-04": 1.05,
  "HM-05": 0.88,
  "SJ-06": 0.45,
});

const demoUrl = (path) => `${APP_ORIGIN}${path}`;
const day = (value) => new Date(`${value}T10:00:00.000Z`);

function person(user, fallbackName) {
  if (!user?.employeeRef) throw new Error(`Demo actor ${user?.email || fallbackName} has no employeeRef.`);
  return {
    email: user.email,
    user: { name: user.user?.name || fallbackName },
    employee: { _id: user.employeeRef },
  };
}

function upstreamActors(editor, approver) {
  return {
    maker: { id: editor.employee._id, name: editor.user.name, email: editor.email },
    checker: { id: approver.employee._id, name: approver.user.name, email: approver.email },
    sampleActor: { id: editor.employee._id, name: "R&D Sample Room (demo)" },
    salesActor: { id: approver.employee._id, name: "Asha Menon (demo sales)", email: approver.email },
  };
}

async function exactTarget(db) {
  const company = await db.collection("acc_companies").findOne(
    { _id: COMPANY }, { projection: { companyName: 1 } },
  );
  if (!company || company.companyName !== COMPANY_NAME) {
    throw new Error("The exact GRAV demo company was not found; refusing to choose another company.");
  }

  const style = await SampleStyle.findById(STYLE).lean();
  if (!style || style.styleCode !== STYLE_CODE || String(style.journeyId) !== "6ab24e5c2935295bc82db199") {
    throw new Error("The exact NW-POLO-26 demo style was not found; refusing to seed a substitute.");
  }
  if (style.techSheet?.technical?.status !== "approved") {
    throw new Error("NW-POLO-26 no longer has an approved R&D technical record; refusing to invent one.");
  }
  const journey = await db.collection("salesjourneys").findOne({
    _id: style.journeyId, companyId: COMPANY,
  }, { projection: { journeyId: 1 } });
  const enquiry = await db.collection("enquiries").findOne({
    _id: style.enquiryId, companyId: COMPANY,
    "products.productLineRef": PRODUCT_LINE_REF,
  }, { projection: { enquiryId: 1 } });
  if (!journey || !enquiry) {
    throw new Error("The style's company-owned Sales journey/product line is not intact.");
  }
  return { style, journey, enquiry };
}

async function seedUpstream({ style, journey, enquiry, editor, approver, manifest }) {
  const session = await mongoose.startSession();
  const { maker, checker, sampleActor, salesActor } = upstreamActors(editor, approver);
  const requestId = new mongoose.Types.ObjectId();
  const developmentFileId = new mongoose.Types.ObjectId();
  const now = day("2026-09-18");

  const references = [
    {
      url: demoUrl("/demo/merchandising/execution/embroidered-polo/front.png"),
      caption: "Buyer reference — embroidered polo front",
      referenceType: "PRODUCT",
    },
    {
      url: demoUrl("/demo/merchandising/execution/embroidered-polo/back.png"),
      caption: "Buyer reference — back construction",
      referenceType: "PRODUCT",
    },
    {
      url: demoUrl("/demo/merchandising/execution/embroidered-polo/materials-and-trims.png"),
      caption: "Fabric, rib, buttons and label direction",
      referenceType: "TRIM",
    },
  ];

  await session.withTransaction(async () => {
    await SalesDevelopmentRequest.create([{
      _id: requestId,
      companyId: COMPANY,
      requestRef: REQUEST_REF,
      versionNo: 1,
      journeyId: style.journeyId,
      journeyRef: journey.journeyId,
      enquiryId: style.enquiryId,
      productLineRef: PRODUCT_LINE_REF,
      state: "ISSUED",
      buyerDisplayLabel: "Northwind Workwear (demo)",
      accountRef: "NW-DEMO",
      productName: style.productName,
      styleRef: style.styleCode,
      sampleStyleId: STYLE,
      stockItemId: style.sourceStockItemId || null,
      referenceImages: references,
      requirementSummary: "Develop a navy pique polo with stable collar shape, clean sleeve setting, "
        + "left-chest embroidery and repeatable production methods for an 1,800-piece opportunity.",
      requestedCategories: ["FABRIC", "TRIMS", "LABELS", "ACCESSORIES", "SAMPLE_PACKAGING"],
      requiredByDate: "2026-10-15",
      requestedBy: salesActor,
      requestedAt: day("2026-09-05"),
      release: {
        releaseReference: "NW-RND-REL-001",
        developmentFileId,
        bomRevisionNo: 1,
        authorisedAt: now,
        authorisedBy: salesActor,
        idempotencyKey: randomUUID(),
        correlationId: randomUUID(),
      },
      releases: [{
        releaseReference: "NW-RND-REL-001",
        developmentFileId,
        bomRevisionNo: 1,
        authorisedAt: now,
        authorisedBy: salesActor,
        idempotencyKey: randomUUID(),
        correlationId: randomUUID(),
      }],
    }], { session });

    await DevelopmentFile.create([{
      _id: developmentFileId,
      developmentNumber: DEVELOPMENT_NUMBER,
      companyId: COMPANY,
      journeyId: style.journeyId,
      journeyRef: journey.journeyId,
      productLineRef: PRODUCT_LINE_REF,
      currentRequestId: requestId,
      currentRequestVersionNo: 1,
      requestHistory: [{ requestId, versionNo: 1, event: "ISSUED", at: day("2026-09-05"), by: salesActor }],
      productName: style.productName,
      styleRef: style.styleCode,
      buyerDisplayLabel: "Northwind Workwear (demo)",
      sampleStyleId: STYLE,
      stockItemId: style.sourceStockItemId || null,
      requiredByDate: "2026-10-15",
      lifecycleStatus: "RELEASED_TO_RND",
      responsibleMerchandiser: {
        email: editor.email, name: "Maya Rao (demo merchandiser)", assignedAt: day("2026-09-06"), assignedBy: checker,
      },
      currentBomRevisionNo: 1,
      releasedToRndAt: now,
      releasedBy: salesActor,
      releaseReference: "NW-RND-REL-001",
      releasedBomRevisionNo: 1,
      coordinationNote: "[IE DEVELOPMENT SHOWCASE] Approved pre-order selection for the navy polo sample.",
      revision: 4,
      createdBy: maker,
      updatedBy: maker,
    }], { session });

    await DevelopmentRequestReceipt.create([{
      companyId: COMPANY,
      requestRef: REQUEST_REF,
      requestVersionNo: 1,
      requestId,
      developmentFileId,
      state: "ACCEPTED",
      decidedBy: maker,
      decidedAt: day("2026-09-06"),
      revision: 1,
    }], { session });

    await DevelopmentBomRevision.create([{
      companyId: COMPANY,
      developmentFileId,
      revisionNo: 1,
      state: "APPROVED",
      rows: [
        {
          rowRef: "NW-FAB-01", category: "FABRIC", rawItemName: "220 GSM cotton-rich pique",
          rawItemSku: "FAB-PIQUE-220", colourOrShade: "Navy 19-3921 TCX", finish: "Bio-wash",
          placement: "Main body and sleeve", appliesTo: "All sizes",
          selectionNote: "Collar recovery and shrinkage to be checked on the fit sample.",
          source: { kind: "MERCHANDISING_SELECTION", reference: "NW-BOM-1", observedAt: day("2026-09-08") },
        },
        {
          rowRef: "NW-TRIM-01", category: "TRIM", rawItemName: "2-hole matt navy button",
          rawItemSku: "BTN-NVY-18L", colourOrShade: "Tone-on-tone", finish: "Matt",
          placement: "Front placket", appliesTo: "All sizes",
          selectionNote: "Three buttons plus one spare in sample pack.",
          source: { kind: "MERCHANDISING_SELECTION", reference: "NW-BOM-1", observedAt: day("2026-09-08") },
        },
        {
          rowRef: "NW-LBL-01", category: "LABEL", rawItemName: "Main woven label",
          rawItemSku: "LBL-NW-01", colourOrShade: "Black / white", finish: "Soft edge",
          placement: "Centre back neck", appliesTo: "All sizes",
          selectionNote: "Attach after neck rib operation.",
          source: { kind: "MERCHANDISING_SELECTION", reference: "NW-BOM-1", observedAt: day("2026-09-08") },
        },
        {
          rowRef: "NW-ACC-01", category: "ACCESSORY", rawItemName: "Left-chest embroidery thread set",
          rawItemSku: "EMB-NW-SET", colourOrShade: "Ivory and rust", finish: "Rayon",
          placement: "Left chest", appliesTo: "All sizes",
          selectionNote: "Use approved 68 mm crest artwork.",
          source: { kind: "MERCHANDISING_SELECTION", reference: "NW-BOM-1", observedAt: day("2026-09-08") },
        },
        {
          rowRef: "NW-PKG-01", category: "SAMPLE_PACKAGING", rawItemName: "Clear sample polybag",
          rawItemSku: "PKG-SAMPLE-01", colourOrShade: "Clear", finish: "Self seal",
          placement: "One development sample", appliesTo: "Sample dispatch",
          selectionNote: "Protect embroidery with tissue before packing.",
          source: { kind: "MERCHANDISING_SELECTION", reference: "NW-BOM-1", observedAt: day("2026-09-08") },
        },
      ],
      submittedBy: maker,
      submittedAt: day("2026-09-10"),
      approvedBy: checker,
      approvedAt: day("2026-09-11"),
      createdBy: maker,
      revision: 3,
    }], { session });

    const existingBriefImage = style.brief?.images?.[0];
    const briefImages = [
      ...(existingBriefImage ? [existingBriefImage] : []),
      {
        name: "NW-POLO-26 front view (demo)",
        url: demoUrl("/demo/merchandising/execution/embroidered-polo/front.png"),
      },
      {
        name: "NW-POLO-26 back view (demo)",
        url: demoUrl("/demo/merchandising/execution/embroidered-polo/back.png"),
      },
    ];
    const fitFront = demoUrl("/demo/merchandising/execution/embroidered-polo/front.png");
    const fitBack = demoUrl("/demo/merchandising/execution/embroidered-polo/back.png");
    const detail = demoUrl("/demo/merchandising/execution/embroidered-polo/embroidery-detail.png");

    await SampleStyle.collection.updateOne(
      { _id: STYLE, styleCode: STYLE_CODE, journeyId: style.journeyId, enquiryId: style.enquiryId },
      {
        $set: {
          stage: "rnd",
          "brief.note": "Navy cotton-rich pique polo for Northwind Workwear — pre-order development showcase.",
          "brief.colour": "Navy",
          "brief.fabricPreference": "Cotton-rich pique, 220 GSM, bio-washed",
          "brief.fabricComposition": "60% cotton / 40% polyester",
          "brief.gsm": "220",
          "brief.branding": "Left-chest embroidered crest",
          "brief.brandingPlacement": "Left chest, 68 mm wide",
          "brief.trims": "Matt navy buttons; soft-edge woven main label",
          "brief.specialConstruction": "Two-piece rib collar; reinforced shoulder tape; side vents",
          "brief.images": briefImages,
          "brief.brandingRequirements": [{
            ref: "NW-EMB-01", type: "Embroidery", placement: "Left chest", width: 68, height: 54,
            unit: "mm", colourNotes: "Ivory and rust", notes: "Demo buyer crest reference",
            artworkState: "Buyer reference received",
            artwork: [{ name: "Northwind crest detail (demo)", url: detail }],
            legacy: false,
          }],
          "materials.status": "approved",
          "materials.items": [
            "220 GSM cotton-rich navy pique — approved development selection",
            "Matt navy 18L buttons — approved development selection",
            "Soft-edge woven main label — approved development selection",
          ],
          "techSheet.status": "approved",
          "techSheet.file": {
            name: "NW-POLO-26 materials-and-construction.png",
            url: demoUrl("/demo/merchandising/execution/embroidered-polo/materials-and-trims.png"),
            uploadedAt: day("2026-09-12"),
          },
          "sample.status": "approved",
          "sample.startedAt": day("2026-09-12"),
          "sample.submittedAt": day("2026-09-17"),
          "sample.approvedAt": day("2026-09-18"),
          "sample.approvedBy": sampleActor,
          "sample.photos": [
            { name: "Approved fit sample — front", url: fitFront },
            { name: "Approved fit sample — back", url: fitBack },
            { name: "Approved embroidery detail", url: detail },
          ],
          "sample.rounds": [
            {
              roundNo: 1, type: "proto", note: "First proto used to correct collar roll and crest height.",
              images: [{ name: "Proto round 1 — front", url: fitFront }], outcome: "rejected",
              feedback: "Raise the crest 12 mm and improve collar recovery.",
              judgedAt: day("2026-09-14"), judgedBy: sampleActor, madeAt: day("2026-09-13"),
            },
            {
              roundNo: 2, type: "fit", note: "Fit sample after collar and embroidery corrections.",
              images: [
                { name: "Fit round 2 — front", url: fitFront },
                { name: "Fit round 2 — back", url: fitBack },
                { name: "Fit round 2 — embroidery", url: detail },
              ],
              outcome: "accepted", feedback: "Fit, collar shape and embroidery placement accepted for IE study.",
              judgedAt: day("2026-09-18"), judgedBy: sampleActor, madeAt: day("2026-09-17"),
            },
          ],
        },
        $push: {
          history: {
            $each: [
              { kind: "materials_approved", from: "materials", to: "rnd", note: "Demo BOM revision 1 approved and released to R&D.", by: sampleActor, at: day("2026-09-11") },
              { kind: "sample_rejected", from: "rnd", to: "rnd", note: "Proto returned for collar and embroidery correction.", by: sampleActor, at: day("2026-09-14") },
              { kind: "sample_approved", from: "rnd", to: "rnd", note: "Fit sample accepted for IE development.", by: sampleActor, at: day("2026-09-18") },
            ],
          },
        },
      },
      { session },
    );
  });
  await session.endSession();

  manifest.requestId = String(requestId);
  manifest.developmentFileId = String(developmentFileId);
  manifest.styleId = STYLE_ID;
  manifest.notes.push("Sales request, Merchandising file/BOM, R&D sample evidence and media added for NW-POLO-26.");
}

async function seedEngineering({ editor, approver, manifest }) {
  const ctx = { companyId: COMPANY, membershipSource: "SERVICE" };
  const operations = await mongoose.connection.db.collection("ie_operations").find({
    companyId: COMPANY,
    code: { $in: Object.keys(OPERATION_TIMES) },
    status: "ACTIVE",
    "requirements.configured": true,
  }).sort({ code: 1 }).toArray();
  if (operations.length !== Object.keys(OPERATION_TIMES).length) {
    throw new Error("The GRAV demo operation library is incomplete; refusing a partial bulletin.");
  }

  const opened = await styleFiles.createFileForStyle(ctx, {
    styleId: STYLE_ID, body: {}, actor: actorOf(editor),
  });
  const fileId = opened.file.fileId;
  const byCode = new Map(operations.map((op) => [op.code, op]));
  const sequence = ["SJ-01", "OL-02", "OL-03", "CS-04", "HM-05", "SJ-06"];
  const saved = await styleFiles.updateBulletin(ctx, {
    fileId,
    body: {
      expectedRevision: opened.file.revision,
      rows: sequence.map((code) => ({
        ieOperationId: String(byCode.get(code)._id),
        proposedSamMinutes: OPERATION_TIMES[code],
        note: code === "CS-04" ? "Use the 6 mm folder and match collar notches." : "",
      })),
    },
    actor: actorOf(editor),
  });

  const studies = [];
  await approveRowTimes(ctx, {
    fileId,
    rows: saved.file.bulletin.rows,
    editor,
    approver,
    minutesByCode: OPERATION_TIMES,
    manifest: { studyIds: studies },
  });

  /* ── CAN IT BE MADE? ──────────────────────────────────────────────────
     The bulletin cannot be submitted until somebody has assessed whether the
     factory can make the garment. The showcase records a real judgement about
     THIS polo — a folder nobody has arranged, decoration that has to happen
     before assembly, a needle and thread still to confirm, and an in-process
     check on the placket — rather than a rubber stamp. */
  await feasibility.saveFeasibility(ctx, {
    fileId,
    actor: actorOf(editor),
    body: {
      expectedRevision: 0,
      outcome: "FEASIBLE_WITH_CONDITIONS",
      recommendation: "Make it, once the collar folder is arranged and the chest embroidery "
        + "is sequenced before front assembly.",
      findings: [
        {
          area: "CONSTRUCTION",
          title: "Fabric stretches while attaching the collar",
          observation: "The rib collar grows on the shoulder seam when it is set by hand.",
          severity: "CONCERN",
          owner: "INDUSTRIAL_ENGINEERING",
          requiredAction: "Trial a folder or guide on the next sample round.",
        },
        {
          area: "MACHINES",
          title: "Collar folder must be arranged before bulk production",
          observation: "No folder for this collar width is on the floor today.",
          severity: "CONCERN",
          owner: "INDUSTRIAL_ENGINEERING",
          requiredAction: "Arrange or order the folder.",
          availability: "NEED_TO_ARRANGE",
        },
        {
          area: "SPECIAL_PROCESSES",
          title: "Chest embroidery must be finished before front assembly",
          observation: "The 68 mm crest cannot be hooped once the front is joined to the back.",
          severity: "CONCERN",
          owner: "PRODUCTION",
          requiredAction: "Sequence the embroidery ahead of assembly.",
        },
        {
          area: "MATERIALS",
          title: "Confirm the needle and thread on the approved fabric",
          observation: "The pique is bio-washed; the needle and thread pairing has not been "
            + "proved on it.",
          severity: "CONCERN",
          owner: "RESEARCH_DEVELOPMENT",
          requiredAction: "Confirm the combination on the approved fabric.",
        },
        {
          area: "QUALITY_RISK",
          title: "Placket alignment needs an in-process check",
          observation: "The placket shifts against the button stand on the fit sample.",
          severity: "CONCERN",
          owner: "INDUSTRIAL_ENGINEERING",
          requiredAction: "Add an in-process alignment check at the placket operation.",
        },
        {
          area: "SAMPLE_EVIDENCE",
          title: "Round 3 proved the collar and the crest placement",
          observation: "The accepted round shows the crest at 68 mm on the left chest.",
          severity: "INFORMATION",
          owner: "RESEARCH_DEVELOPMENT",
          requiredAction: "",
        },
      ],
      conditions: [
        {
          text: "A collar folder is available before bulk production starts",
          owner: "INDUSTRIAL_ENGINEERING",
          requiredAction: "Arrange the folder and prove it on a sample.",
        },
        {
          text: "Chest embroidery is completed before front assembly",
          owner: "PRODUCTION",
          requiredAction: "Sequence the outside process ahead of assembly.",
        },
        {
          text: "The needle and thread combination is confirmed on the approved fabric",
          owner: "RESEARCH_DEVELOPMENT",
          requiredAction: "Confirm and record the combination.",
        },
      ],
    },
  });

  const ready = await styleFiles.readFileForOwnedStyle(ctx, { styleId: STYLE_ID });
  const submitted = await versions.submitVersion(ctx, {
    fileId,
    body: { expectedRevision: ready.file.revision },
    actor: actorOf(editor),
  });
  const approved = await versions.approveVersion(ctx, {
    versionId: submitted.version.bulletinVersionId,
    body: { expectedRevision: submitted.version.revision },
    actor: actorOf(approver),
  });

  manifest.fileId = String(fileId);
  manifest.studyIds = studies;
  manifest.bulletinVersionId = String(approved.version.bulletinVersionId);
  manifest.notes.push("IE file, six-row bulletin, six approved method studies and approved bulletin version created through services.");
}

async function main() {
  if (process.env.IE_DEVELOPMENT_SHOWCASE_SEED !== "1" || !process.argv.includes("--apply")) {
    throw new Error("Explicit opt-in required: IE_DEVELOPMENT_SHOWCASE_SEED=1 and --apply.");
  }
  if (process.env.NODE_ENV === "production") throw new Error("Refusing NODE_ENV=production.");
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required.");

  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, serverSelectionTimeoutMS: 10000 });
  try {
    const db = mongoose.connection.db;
    if (db.databaseName !== "test") throw new Error("Refusing a database other than test.");
    const existing = await db.collection(MANIFEST_COLLECTION).findOne({ _id: MANIFEST_ID });
    if (existing) {
      if (existing.status !== "COMPLETE") throw new Error(`${MANIFEST_ID} is incomplete; inspect it before retrying.`);
      process.stdout.write(`${JSON.stringify({ reused: true, ...existing.urls }, null, 2)}\n`);
      return;
    }

    const target = await exactTarget(db);
    const [editorUser, approverUser] = await Promise.all([
      DeptUser.findOne({ email: EDITOR_EMAIL, isActive: true }).lean(),
      DeptUser.findOne({ email: APPROVER_EMAIL, isActive: true }).lean(),
    ]);
    const editor = person(editorUser, "IE Editor (demo)");
    const approver = person(approverUser, "IE Approver (demo)");
    const manifest = {
      _id: MANIFEST_ID,
      tag: MANIFEST_ID,
      status: "INCOMPLETE",
      companyId: COMPANY_ID,
      companyName: COMPANY_NAME,
      createdAt: new Date(),
      notes: [],
      urls: {
        development: `${APP_ORIGIN}/industrial-engineering/development/${STYLE_ID}?company=${COMPANY_ID}`,
        register: `${APP_ORIGIN}/industrial-engineering/development?view=all&company=${COMPANY_ID}`,
      },
    };
    await db.collection(MANIFEST_COLLECTION).insertOne(manifest);

    try {
      await seedUpstream({ ...target, editor, approver, manifest });
      await db.collection(MANIFEST_COLLECTION).replaceOne({ _id: MANIFEST_ID }, manifest);
      await seedEngineering({ editor, approver, manifest });
      manifest.status = "COMPLETE";
      manifest.completedAt = new Date();
      await db.collection(MANIFEST_COLLECTION).replaceOne({ _id: MANIFEST_ID }, manifest);
    } catch (error) {
      manifest.status = "INCOMPLETE";
      manifest.failedAt = new Date();
      manifest.error = { name: error.name, message: error.message };
      await db.collection(MANIFEST_COLLECTION).replaceOne({ _id: MANIFEST_ID }, manifest, { upsert: true });
      throw error;
    }

    process.stdout.write(`${JSON.stringify({
      status: manifest.status,
      styleId: manifest.styleId,
      developmentFileId: manifest.developmentFileId,
      ieStyleFileId: manifest.fileId,
      bulletinVersionId: manifest.bulletinVersionId,
      methodStudies: manifest.studyIds.length,
      urls: manifest.urls,
    }, null, 2)}\n`);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`${error.name}: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main, exactTarget };
