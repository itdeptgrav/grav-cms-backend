// Local-only Merchandising showroom. No configured MongoDB or Firebase credentials
// are passed to the child server. Closing this process discards the database.
"use strict";

const { generateKeyPairSync, randomUUID } = require("crypto");
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const PORT = 5199;
const DB = "merchandising_demo";
const EMAIL = "merch.demo@grav.local";
const PASSWORD = "DemoMerch2026!";
/* A second person, because one cannot approve their own work. Every
   maker/checker rule in Merchandising — a selection revision, a baseline, an
   issued minute — is enforced against the identity that wrote the thing, so a
   showroom with one user could not produce an approved anything. */
const APPROVER_EMAIL = "merch.approver@grav.local";
const APPROVER_PASSWORD = "DemoMerch2026!";
const id = () => new mongoose.Types.ObjectId();
const day = (offset) => {
  const value = new Date();
  value.setUTCHours(12, 0, 0, 0);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
};

async function seed() {
  process.env.SALARY_ENCRYPTION_KEY = "0".repeat(64);
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  const AccessDepartment = require("../../models/Access/AccessDepartment");
  const DeptUser = require("../../models/Access/DeptUser");
  const DepartmentRole = require("../../models/Access/DepartmentRole");
  const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
  const SalesHandoverVersion = require("../../models/CMS_Models/Sales/SalesHandoverVersion");
  const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
  const HandoverReceipt = require("../../models/CMS_Models/Merchandising/HandoverReceipt");
  const ExecutionUnit = require("../../models/CMS_Models/Merchandising/ExecutionUnit");
  const { SalesDevelopmentRequest } = require("../../models/CMS_Models/Sales/DevelopmentRequest");
  const { DevelopmentFile, DevelopmentRequestReceipt } = require("../../models/CMS_Models/Merchandising/Development");
  const { TnaPlan, TnaMilestone, TnaBaseline } = require("../../models/CMS_Models/Merchandising/TnaPlan");
  const { TnaTemplate, TnaTemplateVersion } = require("../../models/CMS_Models/Merchandising/TnaTemplate");
  const { WorkingCalendar, WorkingCalendarVersion } = require("../../models/CMS_Models/Merchandising/WorkingCalendar");
  const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");

  const company = await Acc_Company.create({ companyName: "GRAV Demo Garments", booksFromDate: new Date("2026-04-01") });
  const department = await AccessDepartment.create({
    key: "merchandiser", slug: "merchandiser", name: "Merchandising",
    dashboardPath: "/merchandiser/dashboard", isActive: true,
  });
  const user = new DeptUser({ name: "Aisha Demo", email: EMAIL, passwordHash: "pending", departmentId: department._id });
  await user.setPassword(PASSWORD);
  await user.save();
  await DepartmentRole.create({ departmentSlug: "merchandiser", departmentId: department._id, email: EMAIL, name: user.name, role: "owner" });
  await SpCompanyMembership.create({ companyId: company._id, email: EMAIL, personName: user.name });
  const actor = { id: user._id, email: EMAIL, name: user.name };

  const approver = new DeptUser({ name: "Rahul Demo", email: APPROVER_EMAIL, passwordHash: "pending", departmentId: department._id });
  await approver.setPassword(APPROVER_PASSWORD);
  await approver.save();
  await DepartmentRole.create({ departmentSlug: "merchandiser", departmentId: department._id, email: APPROVER_EMAIL, name: approver.name, role: "owner" });
  await SpCompanyMembership.create({ companyId: company._id, email: APPROVER_EMAIL, personName: approver.name });
  const approverActor = { id: approver._id, email: APPROVER_EMAIL, name: approver.name };

  /* ── STORE'S CATALOGUE, SO THE PICKER HAS SOMETHING TO FIND ───────────
     Written as STORE holds it — with the balances, minimums and suppliers a
     real item master carries — precisely so the showroom proves that none of
     them reaches Merchandising. A catalogue seeded with only the safe fields
     would prove nothing at all. */
  const catalogue = await RawItem.insertMany([
    {
      name: "Recycled polyester mesh 135gsm", sku: "FAB-MESH-135", category: "Fabric", unit: "Metre",
      attributes: [{ name: "GSM", values: ["135"] }, { name: "Colour", values: ["Slate", "Black", "Electric blue"] }],
      variants: [
        { combination: ["Slate", "135"], sku: "FAB-MESH-135-SL", quantity: 420, minStock: 150 },
        { combination: ["Black", "135"], sku: "FAB-MESH-135-BK", quantity: 180, minStock: 150 },
        { combination: ["Electric blue", "135"], sku: "FAB-MESH-135-EB", quantity: 0, minStock: 150 },
      ],
    },
    {
      name: "Cotton-linen slub 160gsm", sku: "FAB-SLUB-160", category: "Fabric", unit: "Metre",
      attributes: [{ name: "GSM", values: ["160"] }, { name: "Colour", values: ["Natural sand", "Warm ivory"] }],
      variants: [
        { combination: ["Natural sand"], sku: "FAB-SLUB-160-NS", quantity: 960, minStock: 200 },
        { combination: ["Warm ivory"], sku: "FAB-SLUB-160-WI", quantity: 240, minStock: 200 },
      ],
    },
    {
      name: "Single jersey 180gsm", sku: "FAB-JSY-180", category: "Fabric", unit: "Kilogram",
      attributes: [{ name: "GSM", values: ["180"] }],
      variants: [{ combination: ["Optical white"], sku: "FAB-JSY-180-OW", quantity: 75, minStock: 100 }],
    },
    {
      name: "Reflective tape 12mm", sku: "TRM-REF-12", category: "Tapes", unit: "Metre",
      attributes: [{ name: "Width", values: ["12mm"] }, { name: "Finish", values: ["Glass-bead"] }],
      variants: [{ combination: ["Silver-grey"], sku: "TRM-REF-12-SG", quantity: 2400, minStock: 500 }],
    },
    {
      name: "Flat drawcord 4mm", sku: "TRM-CORD-04", category: "Cords", unit: "Metre",
      attributes: [{ name: "Width", values: ["4mm"] }],
      variants: [
        { combination: ["Black"], sku: "TRM-CORD-04-BK", quantity: 5200, minStock: 1000 },
        { combination: ["Natural"], sku: "TRM-CORD-04-NT", quantity: 3100, minStock: 1000 },
      ],
    },
    {
      name: "Coconut-look button 18L", sku: "TRM-BTN-18L", category: "Buttons", unit: "Pieces",
      attributes: [{ name: "Size", values: ["18L"] }, { name: "Holes", values: ["4"] }],
      variants: [{ combination: ["Natural"], sku: "TRM-BTN-18L-NT", quantity: 14000, minStock: 5000 }],
    },
    {
      name: "Woven main label, satin", sku: "LBL-MAIN-STN", category: "Labels", unit: "Pieces",
      attributes: [{ name: "Type", values: ["Main"] }, { name: "Attachment", values: ["Loop fold"] }],
      variants: [{ combination: ["Black on ivory"], sku: "LBL-MAIN-STN-BI", quantity: 8200, minStock: 2000 }],
    },
    {
      name: "Heat-transfer size mark", sku: "LBL-SIZE-HT", category: "Labels", unit: "Pieces",
      attributes: [{ name: "Type", values: ["Size"] }],
      variants: [],
    },
    {
      name: "Metal slider zip 5mm, closed end", sku: "ACC-ZIP-05", category: "Zippers", unit: "Pieces",
      attributes: [{ name: "Gauge", values: ["5mm"] }, { name: "Length", values: ["18cm", "55cm"] }],
      variants: [
        { combination: ["Antique brass", "18cm"], sku: "ACC-ZIP-05-AB18", quantity: 900, minStock: 300 },
        { combination: ["Antique brass", "55cm"], sku: "ACC-ZIP-05-AB55", quantity: 420, minStock: 300 },
      ],
    },
    {
      name: "Recycled LDPE polybag 300x400", sku: "PKG-POLY-3040", category: "Packaging", unit: "Pieces",
      attributes: [{ name: "Size", values: ["300x400"] }],
      variants: [{ combination: ["Clear"], sku: "PKG-POLY-3040-CL", quantity: 6000, minStock: 1000 }],
    },
    {
      name: "Enzyme wash compound", sku: "CHM-ENZ-01", category: "Chemicals", unit: "Litre",
      attributes: [{ name: "Concentration", values: ["High"] }],
      variants: [],
    },
  ].map((item) => ({
    ...item,
    companyId: company._id,
    /* The facts that must stay on Store's side of the keyhole. */
    quantity: 500, minStock: 100, maxStock: 5000,
    primaryVendor: id(), alternateVendors: [id()],
    discounts: [{ minQuantity: 500, price: 182.5 }],
    budgetLedgerName: "Fabric and trims purchases",
    stockTransactions: [{
      type: "ADD", quantity: 500, previousQuantity: 0, newQuantity: 500,
      unitPrice: 194.75, supplier: "Meridian Mills", invoiceNumber: "INV-DEMO-88",
    }],
  })));
  const bySku = new Map(catalogue.map((i) => [i.sku, i]));

  const styles = [
    ["Woven linen shirt", "LN-204", "Northstar Apparel", 750, -3],
    ["Cotton jersey polo", "PO-118", "Harbor & Co", 1200, 6],
    ["Utility overshirt", "OS-307", "Northstar Apparel", 640, 17],
    ["Relaxed twill trouser", "TR-092", "Fieldline", 980, 25],
    ["Ribbed knit cardigan", "KN-412", "Harbor & Co", 520, 33],
  ];
  const files = [];
  for (let i = 0; i < styles.length; i += 1) {
    const [productName, styleRef, buyerDisplayLabel, totalQuantity, dueOffset] = styles[i];
    const handoverRef = `DEMO-ORD-${String(i + 1).padStart(3, "0")}`;
    const handoverLineRef = `DEMO-LINE-${i + 1}`;
    const projection = {
      orderRef: handoverRef, orderLineRef: handoverLineRef,
      styleRef, productName, buyerDisplayLabel, totalQuantity,
      breakdown: [{ lineSplitRef: `SPLIT-${i + 1}`, attributes: [{ name: "Colour", value: i % 2 ? "Olive" : "Indigo" }], sizeRange: "XS–XXL", quantity: totalQuantity }],
      deliveries: [{ dropRef: `DROP-${i + 1}`, committedDeliveryDate: new Date(`${day(dueOffset)}T12:00:00Z`), quantity: totalQuantity, nominatedFactoryRef: i % 2 ? "Unit B" : "Unit A" }],
      packingRequirement: "Fold, polybag and carton by size",
      testingRequirement: "Buyer wash and colour-fastness tests",
      deliveryRequirement: "Ex-factory dispatch against confirmed drop",
    };
    const version = await SalesHandoverVersion.create({
      companyId: company._id, handoverRef, handoverLineRef, versionNo: 1,
      sourceRecord: { app: "sales", recordType: "customer_request", recordId: id(), sourceVersion: new Date().toISOString(), issuedAt: new Date() },
      executionProjection: projection, publication: { state: "CURRENT" }, issuedBy: actor,
    });
    if (i < 2) continue; // The first two stay in the real New Handovers inbox.
    const lifecycleStatus = i === 3 ? "ON_HOLD" : "OPEN";
    const file = await ExecutionFile.create({
      fileNumber: `MEF-2026-${String(i - 1).padStart(4, "0")}`,
      companyId: company._id, handoverRef, handoverLineRef,
      currentHandoverVersionId: version._id,
      sourceVersionHistory: [{ versionId: version._id, versionNo: 1, event: "ACCEPTED", at: new Date(), by: actor }],
      currentExecutionProjection: projection, lifecycleStatus,
      lifecycleReason: lifecycleStatus === "ON_HOLD" ? "Awaiting buyer-approved trim shade" : "",
      executionPhase: "INTAKE",
      responsibleMerchandiser: { email: EMAIL, name: user.name, assignedAt: new Date(), assignedBy: actor },
      coordinationNote: "Demo order for exploring the Merchandising workflow.", createdBy: actor,
    });
    await HandoverReceipt.create({
      companyId: company._id, handoverVersionId: version._id, handoverRef, handoverLineRef,
      sourceVersionNo: 1, state: "ACCEPTED", executionFileId: file._id,
      decidedBy: actor, decidedAt: new Date(), correlationId: randomUUID(),
    });
    await ExecutionUnit.create({
      companyId: company._id, fileId: file._id, unitDiscriminator: `UNIT:SPLIT-${i + 1}|DROP-${i + 1}`,
      lineSplitRef: `SPLIT-${i + 1}`, dropRef: `DROP-${i + 1}`,
      attributes: projection.breakdown[0].attributes, sizeRange: "XS–XXL",
      committedDeliveryDate: projection.deliveries[0].committedDeliveryDate,
      nominatedFactoryRef: projection.deliveries[0].nominatedFactoryRef,
      quantity: totalQuantity, sourceVersionId: version._id, sourceVersionNo: 1,
    });
    files.push(file);
  }

  /* ── THE PRE-ORDER DEVELOPMENT REGISTER ────────────────────────────────
     Three files, and the second one is the showroom's worked example: it is
     the file the Development screen is meant to be judged on, so it carries
     references, a brief, a draft selection and a real question waiting on
     Sales. The other two stay thin, because a register of identical rich
     files teaches nothing about the register. */
  const development = [
    ["Textured resort shirt", "RS-510", "Northstar Apparel", "NEW"],
    ["Performance running tee", "AT-224", "Harbor & Co", "ACTIVE"],
    ["Washed denim jacket", "DJ-630", "Fieldline", "AWAITING_APPROVAL"],
  ];

  /* The worked example's own content. Its reference images are flat SVG
     sketches served by the frontend from `public/demo/merchandising` — local
     files, marked DEMO, depicting nobody's real product. */
  const WORKED = {
    index: 1,
    requirementSummary:
      "Lightweight summer running tee for the Harbor & Co performance block. Develop the main "
      + "mesh body fabric, the reflective trim, the woven labels and the heat-transfer size mark. "
      + "The buyer wants a reflective band across the back yoke and reflective tipping at the "
      + "cuffs; both have to read at 50 metres under headlights. First fit sample by the required-"
      + "by date, in the buyer's size M.",
    requestedCategories: ["FABRIC", "TRIMS", "LABELS", "ACCESSORIES"],
    referenceImages: [
      { url: "/demo/merchandising/development/at-224/running-tee-front.svg", caption: "Front view — buyer reference" },
      { url: "/demo/merchandising/development/at-224/running-tee-back.svg", caption: "Back view — reflective band" },
      { url: "/demo/merchandising/development/at-224/reflective-placement.svg", caption: "Reflective placement — construction reference" },
      { url: "/demo/merchandising/development/at-224/fabric-mesh.svg", caption: "Main fabric — recycled polyester mesh" },
      { url: "/demo/merchandising/development/at-224/reflective-tape.svg", caption: "Trim — 12mm reflective tape" },
    ],
    clarification: {
      category: "REFERENCE_MISSING",
      reason:
        "the buyer-approved reflective-trim placement artwork. The construction reference on the "
        + "request is Merchandising's own sketch, and the buyer has not approved a placement, so "
        + "the tape cannot be specified against it.",
    },
    /* Chosen FROM the catalogue, by id and variant — which is how a
       merchandiser adds one now. The service reads the name and the code back
       out of Store's record, so nothing here writes them. */
    rows: [
      {
        category: "FABRIC", itemSku: "FAB-MESH-135", variantSku: "FAB-MESH-135-SL",
        colourOrShade: "Slate", finish: "Moisture-wicking", placement: "Body and sleeves",
        selectionNote: "Provisional. Buyer has seen the shade on the reference, not on bulk.",
      },
      {
        category: "TRIM", itemSku: "TRM-REF-12", variantSku: "TRM-REF-12-SG",
        colourOrShade: "Silver-grey", finish: "Glass-bead reflective",
        placement: "Back yoke band and cuff tipping",
        selectionNote: "Provisional until Sales sends the buyer-approved placement artwork.",
      },
    ],
  };
  for (let i = 0; i < development.length; i += 1) {
    const [productName, styleRef, buyerDisplayLabel, lifecycleStatus] = development[i];
    const worked = i === WORKED.index;
    const journeyId = id();
    const productLineRef = `PL-DEMO-${i + 1}`;
    const requiredByDate = worked ? day(9) : day(14 + i * 7);
    const request = await SalesDevelopmentRequest.create({
      companyId: company._id, requestRef: `DEMO-DEV-${String(i + 1).padStart(3, "0")}`, versionNo: 1,
      journeyId, journeyRef: `SJ-DEMO-${i + 1}`, enquiryId: id(), productLineRef,
      buyerDisplayLabel, productName, styleRef,
      requestedCategories: worked ? WORKED.requestedCategories : ["FABRIC", "TRIMS", "LABELS"],
      requirementSummary: worked
        ? WORKED.requirementSummary
        : "Choose fabric, trims and labels for the first sample.",
      referenceImages: worked ? WORKED.referenceImages : [],
      requiredByDate,
      /* Sales asked, so Sales is who asked — not the merchandiser reading it. */
      requestedBy: { name: "Meera Shah", email: "meera.shah@grav.local" },
      requestedAt: new Date(),
    });
    const file = await DevelopmentFile.create({
      developmentNumber: `MDF-2026-${String(i + 1).padStart(4, "0")}`,
      companyId: company._id, journeyId, journeyRef: `SJ-DEMO-${i + 1}`,
      productLineRef, currentRequestId: request._id, currentRequestVersionNo: 1,
      requestHistory: [{ requestId: request._id, versionNo: 1, event: "ACCEPTED", at: new Date(), by: actor }],
      productName, styleRef, buyerDisplayLabel, requiredByDate,
      lifecycleStatus, responsibleMerchandiser: { email: EMAIL, name: user.name, assignedAt: new Date(), assignedBy: actor },
      createdBy: actor,
    });

    /* ── THE WORKED EXAMPLE IS WAITING ON SALES ─────────────────────────
       Merchandising asked for the one thing it cannot proceed without. The
       server answers a request version once, so this version cannot also be
       accepted — Sales answers by issuing a new one, and the screen says so.
       Material selection carries on meanwhile, which is what the draft below
       is: two provisional rows, written through the service that owns them. */
    /* ── A NEW REQUEST HAS NO RECEIPT AT ALL ────────────────────────────
       Absence IS pending: Merchandising has not answered. The first file is
       left that way on purpose, so the register and the file screen both
       have one to show — with the two acts a new request offers, which no
       other state does. */
    if (lifecycleStatus !== "NEW") {
      await DevelopmentRequestReceipt.create({
        companyId: company._id, requestRef: request.requestRef, requestVersionNo: 1,
        requestId: request._id, developmentFileId: file._id,
        state: worked ? "CLARIFICATION_REQUESTED" : "ACCEPTED",
        clarification: worked ? WORKED.clarification : undefined,
        decidedBy: actor, decidedAt: new Date(),
      });
    }

    if (worked) {
      const devService = require("../../services/merchandising/development.service");
      const devCtx = { companyId: company._id };
      await devService.createDraft(devCtx, {
        fileId: String(file._id), actor, idempotencyKey: randomUUID(),
      });
      for (const { itemSku, variantSku, ...row } of WORKED.rows) {
        const item = bySku.get(itemSku);
        const variant = (item?.variants || []).find((v) => v.sku === variantSku);
        const live = await devService.getFile(devCtx, { fileId: String(file._id) });
        // eslint-disable-next-line no-await-in-loop
        await devService.addRow(devCtx, {
          fileId: String(file._id), actor,
          body: {
            ...row,
            /* Two ids. The name and the code come back from the catalogue. */
            rawItemId: String(item._id),
            ...(variant ? { variantId: String(variant._id) } : {}),
            expectedRevision: live.currentBom?.revision,
          },
        });
      }
    }
  }

  // Pin the plan to real published configuration, so the file-level tab can
  // show its calendar arithmetic instead of merely filling the portfolio.
  const calendar = await WorkingCalendar.create({
    companyId: company._id, calendarRef: "DEMO-WEEK", name: "Factory working week", createdBy: actor,
  });
  const calendarVersion = await WorkingCalendarVersion.create({
    companyId: company._id, calendarId: calendar._id, versionNo: 1, state: "PUBLISHED",
    effectiveFrom: day(-180), horizonTo: day(365), publishedBy: actor, publishedAt: new Date(),
    createdBy: actor,
  });
  const template = await TnaTemplate.create({
    companyId: company._id, templateRef: "DEMO-EXPORT", name: "Standard export order", createdBy: actor,
  });
  const steps = [
    ["FABRIC_APPROVED", "Fabric selection approved", "MERCHANDISING", "OVERDUE", -4],
    ["TRIM_CARD", "Trim card approved", "MERCHANDISING", "DUE_SOON", 2],
    ["PP_SAMPLE", "PP sample approved", "PRODUCT_DEVELOPMENT", "PENDING", 9],
    ["FABRIC_INHOUSE", "Fabric in-house", "STORE_SUPPLY_CHAIN", "PENDING", 16],
  ];
  const templateVersion = await TnaTemplateVersion.create({
    companyId: company._id, templateId: template._id, versionNo: 1, state: "PUBLISHED",
    effectiveFrom: day(-180), defaultCalendarId: calendar._id,
    milestones: steps.map(([milestoneCode, name, ownerDepartment], i) => ({
      milestoneCode, name, ownerDepartment,
      completionAuthority: ownerDepartment === "MERCHANDISING" ? "MERCHANDISING" : "SOURCE_EVENT",
      anchor: "PLAN_START", offsetWorkingDays: i * 5, scope: "FILE", sortOrder: i,
    })),
    dependencies: steps.slice(1).map(([milestoneCode], i) => ({
      dependencyRef: `DEP-${i + 1}`, predecessorCode: steps[i][0], successorCode: milestoneCode,
      type: "FINISH_TO_START", lagWorkingDays: 0,
    })),
    publishedBy: actor, publishedAt: new Date(), createdBy: actor,
  });
  const file = files[0];
  const plan = await TnaPlan.create({
    companyId: company._id, fileId: file._id,
    templateId: template._id, templateVersionId: templateVersion._id, templateVersionNo: 1, templateName: template.name,
    calendarId: calendar._id, calendarVersionId: calendarVersion._id, calendarVersionNo: 1, calendarName: calendar.name,
    state: "ACTIVE", planStartDate: day(-12), currentBaselineNo: 1,
    createdBy: actor,
  });
  await TnaBaseline.create({
    companyId: company._id, planId: plan._id, fileId: file._id, baselineNo: 1, state: "ACTIVE",
    templateVersionId: templateVersion._id, calendarVersionId: calendarVersion._id,
    planStartDate: day(-12), entries: steps.map(([milestoneCode, , , , offset]) => ({
      milestoneRef: milestoneCode, milestoneCode, baselineDate: day(offset - 1),
    })), approvedBy: actor, approvedAt: new Date(),
  });
  for (let i = 0; i < steps.length; i += 1) {
    const [milestoneCode, name, ownerDepartment, status, offset] = steps[i];
    await TnaMilestone.create({
      companyId: company._id, planId: plan._id, fileId: file._id,
      milestoneRef: milestoneCode, milestoneCode, name, ownerDepartment,
      completionAuthority: ownerDepartment === "MERCHANDISING" ? "MERCHANDISING" : "SOURCE_EVENT",
      scopeKind: "FILE", sequenceRank: i,
      baselineDate: day(offset - 1), forecastDate: day(offset), status,
    });
  }
  /* ── THE ONE FILE THE SHOWROOM IS FOR ──────────────────────────────────
     Every other record above populates a register. This one is the complete
     Order Coordination File: five sections, real records behind each, seeded
     through the services that own them. Its URL is printed on start-up. */
  /* The register's files above are written directly and take the numbers
     MEF-2026-0001 onwards; the service below MINTS its number from a counter
     that has never seen them. Advancing the counter past them is what keeps
     the real acceptance from colliding with a seeded row. */
  const { Counter } = require("../../services/salesJourneyRef");
  await Counter.findOneAndUpdate(
    { key: `merchandisingExecutionFile:${new Date().getFullYear()}` },
    { $set: { seq: 100 } },
    { upsert: true },
  );

  const complete = await require("./merchandising-demo-complete-file")({
    company, maker: actor, checker: approverActor, day,
  });

  return {
    company: company.companyName,
    handovers: 2,
    executionFiles: files.length + 1,
    developmentRequests: development.length,
    milestones: steps.length + complete.milestones,
    completeFile: {
      fileNumber: complete.fileNumber,
      fileId: complete.fileId,
      companyId: String(company._id),
      path: `/merchandiser/execution/${complete.fileId}?company=${String(company._id)}`,
      packState: complete.packState,
      meetingVersion: complete.meetingVersion,
      seedNotes: complete.notes,
    },
  };
}

async function main() {
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  const uri = mongo.getUri(DB);
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):/.test(uri)) throw new Error("Demo database must bind to loopback");
  await mongoose.connect(uri);
  let child;
  const stop = async () => {
    if (child && !child.killed) child.kill("SIGTERM");
    await mongoose.disconnect();
    await mongo.stop();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const counts = await seed();
  await mongoose.disconnect();
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const backendDir = process.env.MERCH_DEMO_BACKEND_DIR;
  if (!backendDir || require("fs").existsSync(require("path").join(backendDir, ".env"))) {
    throw new Error("Set MERCH_DEMO_BACKEND_DIR to a clean source copy without .env");
  }
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "development",
    MONGODB_URI: uri, PORT: String(PORT), JWT_SECRET: "merchandising-local-demo-only",
    SALARY_ENCRYPTION_KEY: "0".repeat(64),
    FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: "grav-local-demo-invalid", client_email: "demo@grav-local-demo-invalid.iam.gserviceaccount.com", private_key: privateKey }),
    FIREBASE_DATABASE_URL: "http://127.0.0.1:1",
  };
  child = spawn(process.execPath, ["server.js"], { cwd: backendDir, env, stdio: "inherit" });
  child.once("exit", (code) => { console.error(`Demo backend exited (${code})`); void stop(); });
  console.log(`MERCHANDISING DEMO READY: http://localhost:${PORT}`);
  console.log(`DEMO DATA: ${JSON.stringify({ ...counts, completeFile: counts.completeFile.fileNumber })}`);
  console.log(`LOGIN: ${EMAIL} / ${PASSWORD}`);
  console.log(`APPROVER LOGIN: ${APPROVER_EMAIL} / ${APPROVER_PASSWORD}`);
  console.log(`COMPLETE DEMO FILE: ${counts.completeFile.fileNumber}`);
  console.log(`COMPLETE FILE URL: ${process.env.MERCH_DEMO_WEB_ORIGIN || "http://localhost:3000"}${counts.completeFile.path}`);
  if (counts.completeFile.seedNotes?.length) {
    console.log(`COMPLETE FILE NOTES: ${JSON.stringify(counts.completeFile.seedNotes)}`);
  }
  console.log("LOCAL MEMORY DATABASE ONLY; stopping this process discards all demo changes.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
