// scripts/demo/merchandising-demo-complete-file.js
//
// ONE COMPLETE ORDER COORDINATION FILE, FOR LOOKING AT.
//
// The showroom's other files exist to populate a register. This one exists to
// be OPENED: every section of the five-section file has real records behind
// it, so a layout can be judged against a believable order instead of against
// an empty tab.
//
// ── IT IS SEEDED THROUGH THE REAL SERVICES ─────────────────────────────────
// Every record below is written by the service that owns it — the selection
// service approves the revisions, the meeting service conducts and issues the
// minutes, the plan service moves the dates, the intake services deliver what
// other departments say. That matters for a demo more than it looks: the
// maker/checker rule, the refused fields, the allocation arithmetic and the
// immutability of an issued minute are all enforced on the way in, so what a
// reviewer sees on screen is a state the real workflow can actually reach.
//
// Two identities do the work, because one cannot: Aisha writes and submits,
// Rahul approves and issues. A seed that used one person would be rejected by
// the services it is seeding through, which is the point.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────
// It states nothing on another department's behalf that that department has
// no way to publish yet. Where a source has no producer in this repository —
// the approval register's external readers are the clearest case — the row is
// created and left reading "awaiting source record", which is what the
// register would say in production today. A demo that filled those in would
// be showing a screen the system cannot produce.
"use strict";

const crypto = require("crypto");

const execution = require("../../services/merchandising/execution.service");
const selection = require("../../services/merchandising/selection.service");
const approvals = require("../../services/merchandising/approvalRegister.service");
const ppm = require("../../services/merchandising/preProductionMeeting.service");
const tnaConfig = require("../../services/merchandising/tnaConfig.service");
const tnaPlan = require("../../services/merchandising/tnaPlan.service");
const pack = require("../../services/merchandising/executionPack.service");
const statusIntake = require("../../services/merchandising/departmentStatusIntake.service");
const changeNotice = require("../../services/sales/changeNotice.service");
const changeDelivery = require("../../services/integration/salesChangeDelivery.service");
const changeControl = require("../../services/merchandising/changeControl.service");
const ackIntake = require("../../services/merchandising/changeAckIntake.service");

const key = () => crypto.randomUUID();

/* The order, as a person would describe it. Written once here so every
   section below quotes the same buyer, style and quantities — a demo whose
   sections disagree teaches the reader to distrust the screen. */
const ORDER = Object.freeze({
  fileNumber: "MEF-DEMO-COMPLETE-001",
  orderRef: "SO-NS-26091",
  orderLineRef: "LN-NS-26091-01",
  handoverRef: "DEMO-ORD-COMPLETE",
  handoverLineRef: "DEMO-LINE-COMPLETE",
  buyer: "Northstar Apparel",
  brand: "Northstar Workwear",
  buyerPo: "PO-NS-26091",
  styleRef: "OS-307",
  buyerStyleRef: "NW-UTILITY-26",
  productName: "Women's utility overshirt",
  season: "AW 2026",
  quantity: 640,
  factory: "Unit A",
  colourways: [
    { splitRef: "SPLIT-INDIGO", colour: "Indigo", quantity: 380 },
    { splitRef: "SPLIT-OLIVE", colour: "Washed Olive", quantity: 260 },
  ],
  sizeRange: "XS–XXL",
});

/**
 * The whole file, in the order the work happens.
 *
 * `day(n)` is the showroom's own relative-date helper, so the file reads the
 * same whenever somebody runs it: dates behind today are history, dates ahead
 * are commitments, and the ex-factory date never falls into the past.
 */
module.exports = async function seedCompleteFile({ company, maker, checker, day }) {
  const ctx = { companyId: company._id };
  const notes = [];
  const step = async (what, run) => {
    try { return await run(); } catch (e) {
      notes.push(`${what}: ${e?.code || e?.name || "error"} — ${e?.message || e}`);
      return null;
    }
  };

  /* ══ 1 — WHAT SALES CONFIRMED ═══════════════════════════════════════════
     Written as the Sales producer writes it, then ACCEPTED through
     Merchandising's own service, so the file, its receipt and its execution
     units are the ones the real intake would have produced. */
  const mongoose = require("mongoose");
  const SalesHandoverVersion = require("../../models/CMS_Models/Sales/SalesHandoverVersion");
  const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
  const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");

  /* ── THE SALES ORDER THIS ALL HANGS OFF ────────────────────────────────
     The whole chain, because half of it is not enough: Sales proves that an
     order belongs to a company through the STYLE's journey, so a request with
     no style behind it reads as an order nobody can open — and the file's
     procurement panel then says exactly that, about a problem the demo
     invented rather than one the product has.

     The LINE REFERENCE is minted by the system rather than typed here: the
     buyer's change later in this file is issued by the Sales service against
     that line, and Sales refuses a line reference it did not issue. */
  const Account = require("../../models/CMS_Models/Sales/Account");
  const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
  const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
  const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");

  const account = await Account.create({ companyName: ORDER.buyer, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: "SJ-26-NS-001", companyId: company._id,
    name: `${ORDER.buyer} — ${ORDER.productName}`, accountId: account._id,
    ownerId: new mongoose.Types.ObjectId(), ownerName: "Meera Shah",
  });
  const enquiry = await Enquiry.create({
    enquiryId: "ENQ-26-NS-001", journeyId: journey._id, accountId: account._id,
    companyId: company._id, title: ORDER.productName, isActive: true,
    products: [{ product: ORDER.productName, quantity: ORDER.quantity }],
  });
  const style = await SampleStyle.create({
    sampleStyleId: "SS-26-NS-001", styleCode: ORDER.styleRef, productName: ORDER.productName,
    journeyId: journey._id, enquiryId: enquiry._id, accountId: account._id, stage: "rnd",
  });
  const request = await CustomerRequest.create({
    requestId: ORDER.orderRef,
    status: "quotation_sales_approved",
    orderOrigin: "customer",
    customerInfo: { name: ORDER.buyer },
    items: [{
      stockItemName: ORDER.productName, totalQuantity: ORDER.quantity,
      sampleStyleId: style._id,
    }],
  });
  const savedRequest = await CustomerRequest.findById(request._id).lean();
  const lineRef = String(savedRequest.items[0].lineRef);

  const drops = [
    { dropRef: "DROP-1", committedDeliveryDate: new Date(`${day(38)}T12:00:00Z`), quantity: 380, nominatedFactoryRef: ORDER.factory, targetExFactoryDate: new Date(`${day(31)}T12:00:00Z`) },
    { dropRef: "DROP-2", committedDeliveryDate: new Date(`${day(59)}T12:00:00Z`), quantity: 260, nominatedFactoryRef: ORDER.factory, targetExFactoryDate: new Date(`${day(52)}T12:00:00Z`) },
  ];
  const projection = {
    orderRef: ORDER.orderRef,
    orderLineRef: lineRef,
    styleRef: ORDER.styleRef,
    buyerStyleRef: ORDER.buyerStyleRef,
    productName: ORDER.productName,
    buyerDisplayLabel: ORDER.buyer,
    brandDisplayLabel: ORDER.brand,
    totalQuantity: ORDER.quantity,
    breakdown: ORDER.colourways.map((c) => ({
      lineSplitRef: c.splitRef,
      attributes: [{ name: "Colourway", value: c.colour }],
      sizeRange: ORDER.sizeRange,
      quantity: c.quantity,
    })),
    /* Two splits across two drops, so Sales has to say how much of each ships
       when. The four rows add to 640 — the same 640 the line confirms. */
    allocations: [
      { allocationRef: "ALLOC-1", lineSplitRef: "SPLIT-INDIGO", dropRef: "DROP-1", quantity: 240 },
      { allocationRef: "ALLOC-2", lineSplitRef: "SPLIT-INDIGO", dropRef: "DROP-2", quantity: 140 },
      { allocationRef: "ALLOC-3", lineSplitRef: "SPLIT-OLIVE", dropRef: "DROP-1", quantity: 140 },
      { allocationRef: "ALLOC-4", lineSplitRef: "SPLIT-OLIVE", dropRef: "DROP-2", quantity: 120 },
    ],
    deliveries: drops,
    packingRequirement:
      "Single-fold, recycled polybag per piece, size sticker on the bag face. "
      + "Solid-colour cartons, 20 pieces per carton, ratio XS1/S3/M6/L6/XL3/XXL1.",
    testingRequirement:
      "Buyer wash and colour-fastness to the AW 2026 protocol, plus a metal-detection pass "
      + "on every snap-fastened garment before packing.",
    deliveryRequirement:
      `Ex-factory against each drop, ${ORDER.factory}. Both drops ship on the ${ORDER.season} `
      + "consolidation; no partial drop without written Sales agreement.",
    /* The buyer's own instructions, as Sales records them: each stated
       requirement with the buyer approval it rests on. The PO is the
       evidence, which is where a buyer PO lives on a handover. */
    processRequirements: {
      statedAt: new Date(`${day(-26)}T09:30:00Z`),
      statedByName: "Meera Shah",
      processes: [
        {
          process: "EMBROIDERY", otherLabel: "", requirement: "REQUIRED",
          buyerSpecification:
            "Brand patch embroidered to the left chest, 55mm wide, matte-black thread on both colourways.",
          evidence: {
            kind: "BUYER_PO", label: "Buyer-approved order (PO)", buyerApprovalRef: ORDER.buyerPo,
            approvalRevision: 2, approvedAt: new Date(`${day(-28)}T10:00:00Z`),
            poNumber: ORDER.buyerPo, poDate: new Date(`${day(-30)}T00:00:00Z`),
            documentRef: "demo/northstar/PO-NS-26091.pdf",
            documentName: "Northstar AW26 utility overshirt PO", authorisedById: null,
            authorisedAt: null, reason: "",
          },
        },
        {
          process: "WASHING", otherLabel: "", requirement: "REQUIRED",
          buyerSpecification:
            "Garment enzyme wash on Washed Olive only. Indigo ships unwashed against the approved lab dip.",
          evidence: {
            kind: "BUYER_PO", label: "Buyer-approved order (PO)", buyerApprovalRef: ORDER.buyerPo,
            approvalRevision: 2, approvedAt: new Date(`${day(-28)}T10:00:00Z`),
            poNumber: ORDER.buyerPo, poDate: new Date(`${day(-30)}T00:00:00Z`),
            documentRef: "demo/northstar/PO-NS-26091.pdf",
            documentName: "Northstar AW26 utility overshirt PO", authorisedById: null,
            authorisedAt: null, reason: "",
          },
        },
        {
          process: "PRINTING", otherLabel: "", requirement: "NOT_REQUIRED",
          buyerSpecification: "No print on this style; the care instruction is woven, not printed.",
          evidence: {
            kind: "BUYER_PO", label: "Buyer-approved order (PO)", buyerApprovalRef: ORDER.buyerPo,
            approvalRevision: 2, approvedAt: new Date(`${day(-28)}T10:00:00Z`),
            poNumber: ORDER.buyerPo, poDate: new Date(`${day(-30)}T00:00:00Z`),
            documentRef: "demo/northstar/PO-NS-26091.pdf",
            documentName: "Northstar AW26 utility overshirt PO", authorisedById: null,
            authorisedAt: null, reason: "",
          },
        },
      ],
    },
  };

  const version = await SalesHandoverVersion.create({
    companyId: company._id,
    handoverRef: ORDER.orderRef,
    handoverLineRef: lineRef,
    versionNo: 1,
    sourceRecord: {
      app: "sales", recordType: "customer_request",
      /* The order this version was issued from, by its real id. A random one
         here would leave the file pointing at an order nobody can read, and
         the procurement-demand panel would say exactly that — honestly, and
         about a problem the demo invented. */
      recordId: request._id,
      sourceVersion: `${ORDER.buyerPo}/2`,
      issuedAt: new Date(`${day(-26)}T09:35:00Z`),
    },
    executionProjection: projection,
    publication: { state: "CURRENT" },
    issuedBy: { id: null, email: "meera.shah@grav.local", name: "Meera Shah" },
  });

  const accepted = await execution.acceptHandover(ctx, { id: String(version._id), actor: maker });
  const fileId = String(accepted.file.id);

  /* ── THE SHOWROOM'S OWN NAME FOR IT ────────────────────────────────────
     A file number is minted by the service and the model marks it immutable,
     which is right: a file people quote in emails for months does not get
     renamed. Mongoose therefore drops it from an ordinary update, so the demo
     label is written through the raw collection — once, in a disposable
     in-memory database, so that a reviewer can find this file among the
     register's others at a glance.

     It is the ONLY value in this file written behind a service, and it is
     cosmetic: the receipt, the units, the history and every record below are
     the ones the real acceptance produced. */
  await ExecutionFile.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(fileId) },
    { $set: { fileNumber: ORDER.fileNumber, executionPhase: "COORDINATION" } },
  );

  const liveFile = await execution.getFile(ctx, { id: fileId });
  /* The execution units the acceptance minted, so a colourway-specific row
     can name the real ones rather than a string somebody typed. */
  const oliveUnits = (liveFile.file.units || [])
    .filter((u) => (u.attributes || []).some((a) => /olive/i.test(a.value)))
    .map((u) => u.unitDiscriminator);
  await step("coordination note", () => execution.patchFile(ctx, {
    id: fileId, actor: maker,
    body: {
      expectedRevision: liveFile.file.revision,
      coordinationNote:
        `${ORDER.season} repeat body in a new fabric. Indigo is the lead colourway and ships first; `
        + "Washed Olive follows on drop 2 after the enzyme wash trial. Trims are the risk on this order — "
        + "the matte-black snaps are a buyer change and the supplier has confirmed a short first lot.",
      tags: [ORDER.season, "Demo", "Utility"],
    },
  }));

  await step("responsible merchandiser", async () => {
    const before = await execution.getFile(ctx, { id: fileId });
    return execution.assignFile(ctx, {
      id: fileId, actor: checker,
      body: {
        email: maker.email,
        expectedRevision: before.file.revision,
        reason: "Aisha runs the Northstar block this season.",
      },
    });
  });

  /* ══ 2 — PRODUCT REQUIREMENTS ═══════════════════════════════════════════ */


  const approveFamily = async (family, label) => {
    const current = await selection.getCurrent(ctx, { fileId, family });
    const working = current?.working;
    if (!working) return null;
    await selection.submit(ctx, {
      fileId, family, actor: maker, idempotencyKey: key(),
      body: { expectedRevision: working.revision },
    });
    const submitted = await selection.getCurrent(ctx, { fileId, family });
    return selection.approve(ctx, {
      fileId, family, actor: checker, idempotencyKey: key(),
      body: { expectedRevision: submitted.working.revision },
    });
  };

  const addRows = async (family, rows) => {
    for (const row of rows) {
      const current = await selection.getCurrent(ctx, { fileId, family });
      // eslint-disable-next-line no-await-in-loop
      await selection.addRow(ctx, {
        fileId, family, actor: maker,
        body: { ...row, expectedRevision: current.working.revision },
      });
    }
  };

  /* ── Materials & trims ──────────────────────────────────────────────────
     Identity and specification only. Every row here is what the garment is
     made OF; not one of them carries a supplier, a rate, a lead time or a
     consumption, and the service would refuse them if they did. */
  await step("materials & trims", async () => {
    await selection.createDraft(ctx, { fileId, family: "MATERIAL_TRIM", actor: maker, idempotencyKey: key() });
    await addRows("MATERIAL_TRIM", [
      {
        group: "FABRIC", componentCode: "FAB-TWILL-240", componentName: "Cotton twill 240gsm",
        internalRef: "F-2411", buyerRef: "NS-TWILL-240", colourOrShade: "Indigo / Washed Olive",
        finish: "Peached, soft handle", placement: "Body, sleeves, collar", sizeOrDimension: "150cm usable width",
        specification: "100% cotton twill, 240gsm ±5%, 3/1 weave, pre-shrunk to 2%.",
      },
      {
        group: "FABRIC", componentCode: "FAB-POCKET-POP", componentName: "Pocketing poplin",
        internalRef: "F-2412", buyerRef: "NS-POP-110", colourOrShade: "Ecru",
        finish: "Mercerised", placement: "Chest pocket bags", sizeOrDimension: "110gsm",
        specification: "100% cotton poplin, 110gsm, bleached ecru, colour-matched to the twill's ground.",
      },
      {
        group: "TRIM", componentCode: "THR-CORE-40", componentName: "Core-spun sewing thread",
        internalRef: "T-3301", colourOrShade: "Tonal to each colourway", placement: "All seams",
        sizeOrDimension: "Tex 40", specification: "Polyester core / cotton wrap, tonal dyed, 4,000m cones.",
      },
      {
        group: "TRIM", componentCode: "SNP-MB-15", componentName: "Metal snap button 15mm",
        internalRef: "T-3302", buyerRef: "NS-SNAP-MB", colourOrShade: "Matte black",
        finish: "Matte black electroplate", placement: "Front placket (7), chest pockets (2), cuffs (2)",
        sizeOrDimension: "15mm cap",
        specification: "Ring-spring snap, nickel-free, 11 per garment, pull test to the buyer's protocol.",
      },
      {
        group: "LABEL", componentCode: "LBL-MAIN-WOVEN", componentName: "Main label — woven",
        internalRef: "L-5501", buyerRef: "NW-MAIN-26", colourOrShade: "Black ground, ecru text",
        placement: "Centre back neck", sizeOrDimension: "40 × 20mm",
        specification: "Woven damask, folded, Northstar Workwear mark to the buyer's artwork revision 3.",
      },
      {
        group: "LABEL", componentCode: "LBL-SIZE", componentName: "Size label",
        internalRef: "L-5502", colourOrShade: "Black ground, ecru text",
        placement: "Under the main label", sizeOrDimension: "18 × 15mm",
        specification: "Woven, one per size XS to XXL, sizes printed in the buyer's size nomenclature.",
      },
      {
        group: "LABEL", componentCode: "LBL-CARE", componentName: "Care and content label",
        internalRef: "L-5503", colourOrShade: "Ecru ground, black text",
        placement: "Left side seam, 300mm from hem", sizeOrDimension: "40 × 60mm folded",
        specification: "Satin care label; wash instruction differs by colourway — Washed Olive carries the enzyme-wash care.",
      },
      {
        group: "ACCESSORY", componentCode: "PATCH-BRAND", componentName: "Brand patch",
        internalRef: "A-7701", buyerRef: "NW-PATCH-26", colourOrShade: "Matte black on twill",
        placement: "Left chest, 55mm from the pocket seam", sizeOrDimension: "55 × 18mm",
        specification: "Embroidered patch to the buyer's artwork; 12,000 stitches, merrow edge.",
      },
      {
        group: "ACCESSORY", componentCode: "TAG-HANG", componentName: "Hangtag",
        internalRef: "A-7702", colourOrShade: "Kraft board", placement: "Through the left cuff snap",
        sizeOrDimension: "60 × 110mm",
        specification: "Recycled kraft board 400gsm, buyer artwork AW26, string-tied.",
      },
      /* The one colourway-specific row: it does NOT apply to all units, and
         the units it names are this file's own — the two Washed Olive ones. */
      {
        group: "TRIM", componentCode: "TAPE-TWILL-OLV", componentName: "Inner neck tape",
        internalRef: "T-3303", colourOrShade: "Olive melange",
        placement: "Neck seam, Washed Olive only", sizeOrDimension: "12mm",
        specification: "Cotton twill tape, enzyme-wash stable, on the Washed Olive colourway only.",
        appliesToAllUnits: false, unitRefs: oliveUnits,
      },
    ]);
    return approveFamily("MATERIAL_TRIM", "Materials & Trims");
  });

  /* ── Packaging ──────────────────────────────────────────────────────── */
  await step("packaging", async () => {
    await selection.createDraft(ctx, { fileId, family: "PACKAGING", actor: maker, idempotencyKey: key() });
    await addRows("PACKAGING", [
      {
        group: "POLYBAG", componentCode: "PBG-REC-40", componentName: "Recycled polybag",
        buyerRef: "NS-PBG-REC", colourOrShade: "Clear", placement: "One garment per bag",
        sizeOrDimension: "300 × 400mm, 40 micron",
        specification: "80% post-consumer recycled LDPE, self-seal, buyer's suffocation warning printed.",
      },
      {
        group: "STICKER", componentCode: "STK-SIZE", componentName: "Size sticker",
        colourOrShade: "White ground, black text", placement: "Bag face, bottom-right",
        sizeOrDimension: "40 × 25mm", specification: "One per bag, size and barcode, buyer's GS1 range.",
      },
      {
        group: "CARTON", componentCode: "CTN-5PLY", componentName: "Export carton",
        buyerRef: "NS-CTN-A", sizeOrDimension: "600 × 400 × 300mm, 5-ply",
        specification: "Solid colour, solid size not permitted; 20 pieces per carton, max 15kg gross.",
      },
      {
        group: "CARTON", componentCode: "CTN-MARK", componentName: "Carton marking",
        placement: "Two long sides and one short side",
        specification: "Buyer mark to PO-NS-26091 artwork: PO, style, colourway, size ratio, carton n of N, gross/net.",
      },
      {
        group: "TAG", componentCode: "TAG-PLACE", componentName: "Hangtag placement",
        placement: "Left cuff snap, string through the buttonhole",
        specification: "Hangtag and barcode tag together, barcode facing out, string knotted twice.",
      },
      {
        group: "TISSUE_OR_INSERT", componentCode: "INS-CARD", componentName: "Collar support card",
        colourOrShade: "Kraft", sizeOrDimension: "80 × 120mm",
        specification: "Recycled kraft insert under the collar; no plastic clips or pins on this style.",
      },
    ]);
    const current = await selection.getCurrent(ctx, { fileId, family: "PACKAGING" });
    await selection.updateInstructions(ctx, {
      fileId, family: "PACKAGING", actor: maker,
      body: {
        expectedRevision: current.working.revision,
        foldingMethod: "Single fold, sleeves back, collar supported by the kraft card.",
        assortmentInstruction: "Solid colour, assorted size per carton — never a solid-size carton.",
        ratioDescription: "XS1 / S3 / M6 / L6 / XL3 / XXL1 per carton (20 pieces).",
        cartonMarks: "PO-NS-26091, style OS-307, colourway, size ratio, carton n of N, gross and net weight.",
        additionalInstruction:
          "Buyer packing note: Washed Olive cartons are marked WASHED on the short side so the "
          + "distribution centre can separate them without opening a carton.",
      },
    });
    return approveFamily("PACKAGING", "Packaging");
  });

  /* ── Development requirements ────────────────────────────────────────── */
  await step("development requirements", async () => {
    await selection.createDraft(ctx, { fileId, family: "DEVELOPMENT", actor: maker, idempotencyKey: key() });
    await addRows("DEVELOPMENT", [
      {
        requirementType: "PRE_PRODUCTION_SAMPLE", requirementCode: "PPS-01",
        title: "Pre-production sample, both colourways",
        brief: "Bulk fabric, bulk trims, bulk snaps. One size M per colourway for the PP meeting.",
        requiredByDate: day(-2), responsibleApplication: "PRODUCT_DEVELOPMENT",
        coordinationNote: "Indigo submitted; Washed Olive waits on the wash trial.",
      },
      {
        requirementType: "WASH", requirementCode: "WSH-01",
        title: "Enzyme wash standard — Washed Olive",
        brief: "Establish the wash recipe and a sealed standard the laundry and Quality both work to.",
        requiredByDate: day(6), responsibleApplication: "PRODUCT_DEVELOPMENT",
        coordinationNote: "Two trial cycles done; shade is a half-step light against the buyer's swatch.",
      },
      {
        requirementType: "EMBROIDERY", requirementCode: "EMB-01",
        title: "Brand patch embroidery development",
        brief: "Digitise the patch to the buyer artwork and prove it on bulk twill without puckering.",
        requiredByDate: day(4), responsibleApplication: "PRODUCT_DEVELOPMENT",
      },
      {
        requirementType: "ARTWORK", requirementCode: "ART-01",
        title: "Hangtag and carton mark artwork approval",
        brief: "Buyer-approved artwork for the hangtag, size sticker and carton mark.",
        requiredByDate: day(9), responsibleApplication: "SALES",
        coordinationNote: "Sales holds the buyer's approval; Merchandising reads it, and does not record it.",
      },
      {
        requirementType: "OTHER", requirementCode: "TST-01",
        title: "Fabric and garment test package",
        brief: "Colour-fastness, shrinkage and the metal-detection pass on snap-fastened garments.",
        requiredByDate: day(12), responsibleApplication: "QUALITY",
      },
      {
        requirementType: "PRINT", requirementCode: "PRN-01",
        title: "Printed care instruction — not required on this style",
        brief:
          "Sales' confirmed requirement states no print on this style; the care instruction is woven. "
          + "Recorded so the absence is visible rather than an omission, and no approved reference is expected.",
        requiredByDate: day(12), responsibleApplication: "PRODUCT_DEVELOPMENT",
        approvedReferenceExpected: false,
      },
    ]);
    return approveFamily("DEVELOPMENT", "Development Requirements");
  });

  /* ── A second materials revision ───────────────────────────────────────
     The buyer's snap change, later in this file, is what produced it. The
     approved revision 1 stays readable as a superseded revision — nothing is
     overwritten, which is the property the whole family exists for. */
  const materialsRevision = await step("materials revision 2", async () => {
    const approved = await selection.getCurrent(ctx, { fileId, family: "MATERIAL_TRIM" });
    await selection.createDraft(ctx, {
      fileId, family: "MATERIAL_TRIM", actor: maker, idempotencyKey: key(),
      body: { fromRevisionNo: approved.approved?.revisionNo },
    });
    const draft = await selection.getCurrent(ctx, { fileId, family: "MATERIAL_TRIM" });
    const snap = (draft.working.rows || []).find((r) => r.componentCode === "SNP-MB-15");
    if (snap) {
      /* Only the fields a row IS. The view around it — its reference, the
         source it came from — is not something a caller may send back. */
      const ROW_FIELDS = [
        "group", "componentCode", "componentName", "internalRef", "buyerRef",
        "colourOrShade", "finish", "placement", "sizeOrDimension", "specification",
        "notes", "appliesToAllUnits", "unitRefs",
      ];
      const snapFields = Object.fromEntries(
        ROW_FIELDS.filter((f) => snap[f] !== undefined && snap[f] !== null).map((f) => [f, snap[f]]),
      );
      await selection.updateRow(ctx, {
        fileId, family: "MATERIAL_TRIM", rowRef: snap.rowRef, actor: maker,
        body: {
          ...snapFields,
          colourOrShade: "Matte black (was antique brass)",
          finish: "Matte black electroplate, buyer-changed from antique brass",
          specification:
            "Ring-spring snap, nickel-free, 11 per garment, pull test to the buyer's protocol. "
            + "Finish changed to matte black on the buyer's authorised change.",
          expectedRevision: draft.working.revision,
        },
      });
    }
    return approveFamily("MATERIAL_TRIM", "Materials & Trims");
  });

  /* ══ 4 — APPROVALS AND THE PRE-PRODUCTION MEETING ═══════════════════════ */

  await step("approval register", async () => {
    const rows = [
      { category: "MATERIAL_TRIM_CARD", note: "Trim card for both colourways, including the changed snap finish." },
      { category: "PACKAGING_SPEC", note: "Polybag, carton, marking and the buyer's packing note." },
      { category: "DEVELOPMENT_SCHEDULE", note: "Every development requirement this order asks for." },
      { category: "PP_SAMPLE_APPROVED", requiredByDate: day(3), note: "Product Development decides; Merchandising reads their record." },
      { category: "BUYER_LAB_DIP", requiredByDate: day(-4), note: "Sales holds the buyer's lab-dip decision for both colourways." },
      { category: "BUYER_PRINT_STRIKE_OFF", requiredByDate: day(9), note: "Buyer artwork for the hangtag and carton mark." },
      { category: "FABRIC_TEST_PASSED", requiredByDate: day(12), note: "Quality's own test record for the twill." },
      { category: "GARMENT_TEST_PASSED", requiredByDate: day(20), note: "Includes the metal-detection pass on snap-fastened garments." },
    ];
    for (const body of rows) {
      const register = await approvals.readRegister(ctx, { fileId });
      // eslint-disable-next-line no-await-in-loop
      await approvals.addRequirement(ctx, {
        fileId, actor: maker, body: { ...body, expectedRevision: register.revision },
      });
    }
    return approvals.observe(ctx, { fileId, actor: maker });
  });

  /* ══ 4 — SCHEDULE AND HANDOVER ═════════════════════════════════════════ */

  const MILESTONES = [
    ["HANDOVER_ACCEPTED", "Sales handover accepted", "MERCHANDISING", "MERCHANDISING", 0],
    /* Completed by M4's own published approval event rather than by hand —
       the one source-event completion path this build actually has. */
    ["MATERIAL_APPROVED", "Material selection approved", "MERCHANDISING", "SOURCE_EVENT", 4],
    ["TRIM_CARD", "Trim card approved", "MERCHANDISING", "MERCHANDISING", 7],
    ["PP_SAMPLE_SUBMIT", "PP sample submission", "PRODUCT_DEVELOPMENT", "SOURCE_EVENT", 12],
    ["PP_SAMPLE_APPROVED", "PP sample approval", "PRODUCT_DEVELOPMENT", "SOURCE_EVENT", 16],
    ["LAB_TEST", "Lab-test completion", "QUALITY", "SOURCE_EVENT", 19],
    ["FABRIC_INHOUSE", "Fabric in-house", "STORE_SUPPLY_CHAIN", "SOURCE_EVENT", 21],
    ["TRIMS_INHOUSE", "Trims in-house", "STORE_SUPPLY_CHAIN", "SOURCE_EVENT", 24],
    ["PP_MEETING", "Pre-production meeting", "MERCHANDISING", "MERCHANDISING", 26],
    ["PACK_SUBMIT", "Execution-pack submission", "MERCHANDISING", "MERCHANDISING", 28],
    /* The plan's own department vocabulary groups the floor together; PPC
       and Production are one owner there, and the milestone names say which
       of them is meant. */
    ["PPC_REVIEW", "PPC review", "IE_PPC_PRODUCTION", "SOURCE_EVENT", 30],
    ["PRODUCTION_START", "Production start", "IE_PPC_PRODUCTION", "SOURCE_EVENT", 33],
    ["EX_FACTORY", "Ex-factory", "IE_PPC_PRODUCTION", "SOURCE_EVENT", 45],
  ];

  const plan = await step("time & action", async () => {
    const calendar = await tnaConfig.createCalendar(ctx, {
      body: { name: "Demo factory week", timezone: "Asia/Kolkata" }, actor: maker,
    });
    const calendarId = calendar.calendar.id;
    const calendarVersion = await tnaConfig.createCalendarVersion(ctx, {
      calendarId, actor: maker,
      body: {
        effectiveFrom: day(-120), horizonTo: day(365),
        /* Monday to Saturday worked, Sunday off — the factory's week. */
        weekPattern: [true, true, true, true, true, true, false],
        exceptions: [],
      },
    });
    await tnaConfig.publishCalendarVersion(ctx, {
      calendarId, versionNo: calendarVersion.version.versionNo, actor: checker,
    });
    /* A block needs a reason this company has approved. Seeded here, as an
       administrator would have, so the block below is a real one. */
    await tnaConfig.upsertReasonCode(ctx, {
      body: { code: "MATERIAL_SHORT", label: "Material or trim short", kind: "BLOCK" },
    });
    await tnaConfig.upsertReasonCode(ctx, {
      body: { code: "SUPPLIER_LATE", label: "Supplier confirmed late", kind: "RESCHEDULE" },
    });

    const template = await tnaConfig.createTemplate(ctx, {
      body: { name: "Demo utility overshirt plan" }, actor: maker,
    });
    const templateVersion = await tnaConfig.createVersion(ctx, {
      templateId: template.template.id, actor: maker,
      body: {
        effectiveFrom: day(-120),
        defaultCalendarId: calendarId,
        milestones: MILESTONES.map(([milestoneCode, name, ownerDepartment, completionAuthority], i) => ({
          milestoneCode, name, ownerDepartment, completionAuthority,
          sourceEventKinds: milestoneCode === "MATERIAL_APPROVED"
            ? ["merchandising.material_trim_card.approved"] : [],
          anchor: i === MILESTONES.length - 1 ? "EX_FACTORY" : "PLAN_START",
          offsetWorkingDays: i === MILESTONES.length - 1 ? 0 : MILESTONES[i][4],
          scope: "FILE", criticalPathCandidate: i > 8, sortOrder: i,
        })),
        dependencies: MILESTONES.slice(1).map(([milestoneCode], i) => ({
          dependencyRef: `DEP-${i + 1}`, predecessorCode: MILESTONES[i][0],
          successorCode: milestoneCode, type: "FINISH_TO_START", lagWorkingDays: 0,
        })),
      },
    });
    await tnaConfig.publishVersion(ctx, {
      templateId: template.template.id, versionNo: templateVersion.version.versionNo, actor: checker,
    });
    await tnaPlan.createPlan(ctx, {
      fileId, actor: maker, idempotencyKey: key(),
      body: { templateId: template.template.id, planStartDate: day(-26) },
    });
    const created = await tnaPlan.getPlan(ctx, { fileId });
    await tnaPlan.approveBaseline(ctx, {
      fileId, actor: checker, idempotencyKey: key(),
      body: { expectedRevision: created.plan.revision },
    });

    /* What has actually happened, what is late, and what is stuck. Each one
       goes through the command that owns it, so the status on screen is the
       status the service derived rather than one written into the row. */
    /* M4's approval events are still in the outbox; draining them now closes
       the milestone that waits for one, with the date the approval carries. */
    await require("../../services/merchandising/tnaIntake.service")
      .drain({ companyId: company._id });

    const done = [
      ["HANDOVER_ACCEPTED", day(-26)],
      ["TRIM_CARD", day(-15)],
      ["PP_MEETING", day(-1)],
    ];
    for (const [ref, actualDate] of done) {
      const live = await tnaPlan.getPlan(ctx, { fileId });
      const m = live.milestones.find((x) => x.milestoneRef === ref);
      if (!m) continue;
      // eslint-disable-next-line no-await-in-loop
      await tnaPlan.completeMilestone(ctx, {
        fileId, milestoneRef: ref, actor: maker,
        body: { actualDate, expectedRevision: m.revision, note: "Recorded from the file's own record." },
      }).catch((e) => notes.push(`complete ${ref}: ${e.message}`));
    }

    /* Forecast late: the laundry's trial pushed the wash standard, so PP
       approval will land after the committed date. */
    const late = (await tnaPlan.getPlan(ctx, { fileId })).milestones
      .find((x) => x.milestoneRef === "PP_SAMPLE_APPROVED");
    if (late) {
      await tnaPlan.updateForecast(ctx, {
        fileId, milestoneRef: "PP_SAMPLE_APPROVED", actor: maker,
        body: {
          forecastDate: day(9), expectedRevision: late.revision, reasonCode: "SUPPLIER_LATE",
          note: "The laundry needs a third wash trial before Washed Olive can be submitted.",
        },
      }).catch((e) => notes.push(`forecast PP_SAMPLE_APPROVED: ${e.message}`));
    }

    /* Blocked: the snap supplier shipped short after the buyer's change. */
    const blocked = (await tnaPlan.getPlan(ctx, { fileId })).milestones
      .find((x) => x.milestoneRef === "TRIMS_INHOUSE");
    if (blocked) {
      await tnaPlan.blockMilestone(ctx, {
        fileId, milestoneRef: "TRIMS_INHOUSE", actor: maker,
        body: {
          expectedRevision: blocked.revision, reasonCode: "MATERIAL_SHORT",
          note: "Matte-black snaps short by 1,800 pieces after the buyer's finish change.",
        },
      }).catch((e) => notes.push(`block TRIMS_INHOUSE: ${e.message}`));
    }
    return tnaPlan.getPlan(ctx, { fileId });
  });

  /* ── What the other departments say about themselves ──────────────────
     Delivered as events, through the intake the real producers would use.
     Merchandising writes none of these; it is reading them. */
  await step("department statuses", async () => {
    const mongoose = require("mongoose");
    const reported = [
      ["product_development.sample.status_changed", "SAMPLE_SUBMITTED", "PP sample submitted for Indigo", "product_development", "SAMPLE", "PPS-2026-0188", day(-8)],
      ["supply_chain.sourcing.status_changed", "SUPPLIER_CONFIRMED", "Twill confirmed in full; snaps re-confirmed after the buyer's change", "supply_chain", "SOURCING", "SRC-2026-0912", day(-5)],
      ["store.material.status_changed", "PARTIALLY_RECEIVED", "Twill received; snaps short by 1,800 pieces", "store", "GRN", "GRN-2026-3320", day(-3)],
      ["ie.route.released", "ROUTE_RELEASED", "Route and SAM released for Unit A", "ie", "ROUTE", "IEREL-2026-0455", day(-2)],
      ["quality.result.recorded", "TEST_PENDING", "Colour-fastness and shrinkage submitted; metal detection pending", "quality", "TEST", "QC-2026-1187", day(-2)],
      ["ppc.plan.status_changed", "PLAN_PENDING", "Awaiting the execution pack before booking capacity", "ppc", "PLAN", "PPC-2026-0640", day(-1)],
      ["production.progress.recorded", "NOT_STARTED", "No cutting until the pack is released", "production", "PROGRESS", "PRD-2026-0771", day(-1)],
    ];
    for (const [kind, statusCode, statusLabel, sourceApp, sourceRecordType, sourceRecordRef, observedOn] of reported) {
      // eslint-disable-next-line no-await-in-loop
      await statusIntake.receive({
        _id: new mongoose.Types.ObjectId(),
        companyId: company._id,
        kind,
        createdAt: new Date(),
        occurredAt: new Date(`${observedOn}T06:00:00Z`),
        payload: {
          executionFileId: new mongoose.Types.ObjectId(fileId),
          statusCode, statusLabel, sourceApp, sourceRecordType, sourceRecordRef,
          sourceRecordVersion: 1,
          sourceObservedAt: new Date(`${observedOn}T06:00:00Z`),
        },
        correlationId: key(),
      });
    }
    /* Logistics reports nothing, on purpose: the register then shows the
       difference between a department that has spoken and one that has not. */
    return true;
  });

  /* ── The execution pack ───────────────────────────────────────────────── */
  const packState = await step("execution pack", async () => {
    await pack.createDraft(ctx, { fileId, actor: maker, idempotencyKey: key() });
    /* The draft snapshots the file as it was when it was opened. Everything
       above moved since, so it is re-read before it is submitted — which is
       what a merchandiser would do, and what the refusal tells them to do. */
    const opened = await pack.getPack(ctx, { fileId });
    await pack.refreshDraft(ctx, {
      fileId, actor: maker, body: { expectedRevision: opened.pack?.revision },
    }).catch((e) => notes.push(`pack refresh: ${e.message}`));
    const draft = await pack.getPack(ctx, { fileId });
    const submitted = await pack.submitPack(ctx, {
      fileId, actor: checker, idempotencyKey: key(),
      body: { declarationAcknowledged: true, expectedRevision: draft.pack?.revision },
    }).catch((e) => {
      notes.push(`pack submit: ${e.message} ${JSON.stringify(e.details || {})}`);
      return null;
    });
    return submitted ? "SUBMITTED" : "DRAFT";
  });

  const meeting = await step("pre-production meeting", async () => {
    await ppm.createDraft(ctx, { fileId, actor: maker, idempotencyKey: key() });
    const draft = await ppm.getCurrent(ctx, { fileId });
    const at = (t) => new Date(`${day(-1)}T${t}:00Z`);
    await ppm.updateDraft(ctx, {
      fileId, actor: maker,
      body: {
        expectedRevision: draft.working.revision,
        plannedMeetingDate: day(-1),
        actualMeetingAt: at("04:30"),
        locationOrMode: `${ORDER.factory} — meeting room 2, with the laundry joining by call`,
        chairperson: `${checker.name} — Merchandising manager`,
        merchandisingRepresentative: `${maker.name} — responsible merchandiser`,
        attendees: [
          { name: maker.name, department: "MERCHANDISING", role: "Responsible merchandiser" },
          { name: checker.name, department: "MERCHANDISING", role: "Merchandising manager" },
          { name: "Nandini Rao", department: "PRODUCT_DEVELOPMENT", role: "Pattern and sample" },
          { name: "Imran Qureshi", department: "IE", role: "Industrial engineer" },
          { name: "Farah Siddiqui", department: "QUALITY", role: "Quality lead" },
          { name: "Vikram Joshi", department: "PPC", role: "Planner" },
          { name: "Anil Kumar", department: "STORE", role: "Store in-charge" },
          { name: "Suresh Pillai", department: "PRODUCTION", role: "Line supervisor, Unit A" },
        ],
        absentDepartments: ["LOGISTICS"],
        reviewNotes: [
          { topic: "CONSTRUCTION", observation: "Front placket is interlined both sides; the snap spacing on the PP sample matched the pattern." },
          { topic: "MATERIAL_TRIM", observation: "Bulk twill matches the approved standard on both shades. The matte-black snaps are the buyer's change and the trim card now carries them." },
          { topic: "MEASUREMENT_FIT", observation: "PP sample measured within tolerance except the cuff opening, 5mm wide on size M. Pattern corrected before cutting." },
          { topic: "PACKAGING_PRESENTATION", observation: "Folded sample presented in the recycled polybag; collar card holds the shape. Washed Olive cartons will carry the WASHED mark." },
          { topic: "TESTING", observation: "Colour-fastness and shrinkage submitted; the metal-detection pass is scheduled once the snaps are in-house." },
          { topic: "MACHINE_ATTACHMENT", observation: "Snap machine needs the 15mm die set; IE confirmed two heads are free from the 8th." },
          { topic: "PRODUCTION_HANDLING", observation: "Washed Olive goes to the laundry in bundles of 20; no mixed-colour bundles at any stage." },
          { topic: "BUYER_INSTRUCTIONS", observation: "No print anywhere on this style — the care instruction is woven. Read back from the confirmed requirement." },
        ],
        decisions: [
          {
            topic: "MEASUREMENT_FIT", ownerDepartment: "PRODUCT_DEVELOPMENT",
            decision: "Correct the size M cuff opening by 5mm on the graded set and reissue the pattern before cutting.",
            status: "CLOSED",
            closureNote: "Corrected pattern issued the same evening; IE has the updated marker.",
          },
          {
            topic: "MATERIAL_TRIM", ownerDepartment: "STORE",
            decision: "Confirm the matte-black snap quantity received against the 11-per-garment requirement, and report the short quantity.",
            status: "OPEN",
            externalTaskRef: "TASK-2026-4471",
          },
          {
            topic: "TESTING", ownerDepartment: "QUALITY",
            decision: "Run the metal-detection pass on the first 200 finished pieces and record the result against this order.",
            status: "OPEN",
          },
          {
            topic: "PACKAGING_PRESENTATION", ownerDepartment: "LOGISTICS",
            decision: "Confirm whether the WASHED carton mark affects the consolidation labelling.",
            status: "NOT_APPLICABLE",
            closureNote: "Logistics was absent; the buyer's consolidator handles labelling on this route, so nothing is owed here.",
          },
        ],
      },
    });
    const ready = await ppm.getCurrent(ctx, { fileId });
    await ppm.conduct(ctx, {
      fileId, actor: maker, idempotencyKey: key(),
      body: { expectedRevision: ready.working.revision },
    });
    const conducted = await ppm.getCurrent(ctx, { fileId });
    /* Issued by the manager who chaired it, not by the merchandiser who wrote
       it up. The service refuses the other way round. */
    return ppm.issue(ctx, {
      fileId, actor: checker, idempotencyKey: key(),
      body: { expectedRevision: conducted.working.revision },
    });
  });

  /* ══ 5 — THE BUYER'S CHANGE, AND WHAT IT COST ══════════════════════════ */

  await step("change control", async () => {
    /* The change is Sales'. It is issued by the Sales service against the
       order line Sales itself minted, delivered by the Sales delivery worker,
       and read by Merchandising — the path a real buyer change takes. No
       Merchandising route can author one, which is the point. */
    /* The requirement as it now stands, with the buyer's change in it. A
       notice carries the WHOLE projection — the before is read from the
       handover, so the difference is the record's, not a caller's claim.

       ── WHY THIS CHANGE AND NOT THE SNAP FINISH ────────────────────────
       A Sales change notice carries the CONFIRMED COMMERCIAL requirement:
       quantities, splits, deliveries and the packing, testing and delivery
       requirements. A trim's finish is not on that list and the contract
       refuses it — which is right, because a snap finish is Merchandising's
       selection to restate, not a commercial term. So the buyer's change
       here is the one a buyer actually sends down this pipe, and the snap
       finish moves the way it really moves: as a new Merchandising revision
       (revision 2 above), superseding the approved one without erasing it. */
    const after = JSON.parse(JSON.stringify(projection));
    delete after.processRequirements;
    after.packingRequirement =
      "Single-fold, recycled polybag per piece, size sticker on the bag face. "
      + "Solid-colour cartons, 20 pieces per carton, ratio XS1/S3/M6/L6/XL3/XXL1. "
      + "Washed Olive cartons carry a WASHED mark on the short side so the distribution "
      + "centre can separate them without opening a carton.";
    await changeNotice.issue({ companyId: company._id }, {
      requestId: String(request._id), lineId: lineRef,
      actor: { id: null, email: "meera.shah@grav.local", name: "Meera Shah" },
      body: {
        /* The contract's own vocabulary. There is no "specification" kind:
           what the buyer altered is what the style is made of, and this is
           the kind that carries it. */
        changeKind: "PACKING_REQUIREMENT",
        reason:
          "The buyer's distribution centre asked for the Washed Olive cartons to carry a WASHED "
          + "mark, so washed and unwashed stock can be separated without opening a carton.",
        after,
      },
    });
    await changeDelivery.deliverPending({ companyId: company._id });

    const list = await changeControl.listChanges(ctx, { fileId });
    const row = (list.rows || [])[0];
    if (!row?.notice?.changeRef) {
      notes.push("change control: the notice did not reach Merchandising");
      return null;
    }
    const changeRef = row.notice.changeRef;

    await changeControl.acknowledgeChange(ctx, {
      fileId, changeRef, actor: maker, idempotencyKey: key(),
    });
    await changeControl.assessImpact(ctx, {
      fileId, changeRef, actor: maker, idempotencyKey: key(),
      body: {
        decision: "REVISE",
        note:
          "Packaging is affected: the carton-marking row and the packing instruction are reissued on "
          + "revision 2 with the WASHED mark. Materials and trims are unaffected — the mark is on the "
          + "carton, not on the garment. No T&A date moves; the carton supplier confirmed the new "
          + "marking plate inside the existing lead time.",
        affectedApplications: ["SUPPLY_CHAIN", "STORE", "LOGISTICS"],
      },
    });
    /* The revision the change PRODUCED. Recorded against the notice, so the
       question "what did we actually change because of this?" has an answer
       that is a record rather than a recollection. */
    const packagingRevision = await step("packaging revision 2", async () => {
      const approved = await selection.getCurrent(ctx, { fileId, family: "PACKAGING" });
      await selection.createDraft(ctx, {
        fileId, family: "PACKAGING", actor: maker, idempotencyKey: key(),
        body: { fromRevisionNo: approved.approved?.revisionNo },
      });
      const draft = await selection.getCurrent(ctx, { fileId, family: "PACKAGING" });
      const mark = (draft.working.rows || []).find((r) => r.componentCode === "CTN-MARK");
      if (mark) {
        await selection.updateRow(ctx, {
          fileId, family: "PACKAGING", rowRef: mark.rowRef, actor: maker,
          body: {
            group: mark.group, componentCode: mark.componentCode, componentName: mark.componentName,
            placement: mark.placement,
            specification:
              "Buyer mark to PO-NS-26091 artwork: PO, style, colourway, size ratio, carton n of N, "
              + "gross/net. Washed Olive cartons additionally marked WASHED on the short side.",
            expectedRevision: draft.working.revision,
          },
        });
      }
      return approveFamily("PACKAGING", "Packaging");
    });
    const impactRevision = async () => {
      const current = await changeControl.getChange(ctx, { fileId, changeRef });
      return current?.impact?.revision;
    };
    if (packagingRevision?.revision?.revisionNo) {
      await changeControl.recordProducedRevision(ctx, {
        fileId, changeRef, actor: maker,
        body: {
          area: "PACKAGING",
          revisionNo: packagingRevision.revision.revisionNo,
          expectedRevision: await impactRevision(),
        },
      }).catch((e) => notes.push(`produced revision: ${e.message}`));
    }
    await changeControl.coordinateImpact(ctx, {
      fileId, changeRef, actor: checker, idempotencyKey: key(),
      body: { expectedRevision: await impactRevision() },
    }).catch((e) => notes.push(`coordinate: ${e.message}`));

    /* Two departments have answered and one has not — the outstanding
       acknowledgement is the point of the panel. */
    /* Each acknowledgement arrives as the OWNING application's own event —
       there is no Merchandising route that records one on their behalf, and
       the kinds below are the eight this build listens for. Store has not
       answered, and the panel says so rather than assuming. */
    const acks = [
      ["supply_chain.change_acknowledgement.recorded", "SUPPLY_CHAIN", "ACCEPTED",
        "Carton marking plate re-cut for the WASHED mark; inside the existing lead time."],
      /* Not every answer is a yes. Logistics has asked a question back, which
         is an answer Merchandising has to act on — and a different row from
         the department that has not answered at all. */
      ["logistics.change_acknowledgement.recorded", "LOGISTICS", "CLARIFICATION_REQUESTED",
        "Does the WASHED mark go on the short side only, or on both sides for the consolidation scan?"],
    ];
    for (const [kind, application, state, note] of acks) {
      // eslint-disable-next-line no-await-in-loop
      await ackIntake.receive({
        _id: new mongoose.Types.ObjectId(),
        companyId: company._id,
        kind,
        createdAt: new Date(),
        payload: {
          executionFileId: new mongoose.Types.ObjectId(fileId),
          changeRef,
          changeVersionNo: row.notice.versionNo,
          application, state, reason: note,
          sourceRecordRef: `ACK-${application}-1`,
          acknowledgedAt: new Date(`${day(-1)}T08:00:00Z`),
        },
        correlationId: key(),
      }).then((r) => {
        if (!r?.applied) notes.push(`ack ${application}: ${r?.outcome || "?"} — ${r?.note || ""}`);
      }).catch((e) => notes.push(`ack ${application}: ${e.message}`));
    }
    return changeRef;
  });

  return {
    fileId,
    fileNumber: ORDER.fileNumber,
    order: ORDER,
    meetingVersion: meeting?.meeting?.versionNo ?? meeting?.versionNo ?? null,
    milestones: plan?.milestones?.length ?? 0,
    packState,
    notes,
  };
};

module.exports.ORDER = ORDER;
