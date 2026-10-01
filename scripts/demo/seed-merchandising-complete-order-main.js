// Seed the complete Merchandising Order Execution demo into the named GRAV
// demo company. Dry-run by default; writes only with --apply after proving the
// database, company and permanent demo identity.
"use strict";

require("dotenv/config");

const { randomUUID } = require("crypto");
const mongoose = require("mongoose");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const execution = require("../../services/merchandising/execution.service");
const ppm = require("../../services/merchandising/preProductionMeeting.service");
const seedCompleteFile = require("./merchandising-demo-complete-file");

const COMPANY_ID = "6a08040a1fecacc9bb7149c2";
const COMPANY_NAME = "GRAV CLOTHING PVT LTD";
const FILE_NUMBER = seedCompleteFile.ORDER.fileNumber;

const maker = {
  id: "6ab64dbe4fd3a5a87422cf28",
  name: "RISHEE RAY",
  email: "ray@grav.in",
};
const checker = {
  id: "69f057f6c02292fc8d7f48f2",
  name: "Chief Executive Officer",
  email: "ceo@grav.in",
};

const day = (offset) => {
  const value = new Date();
  value.setUTCHours(12, 0, 0, 0);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
};

async function finishExisting(company, existing) {
  const ctx = { companyId: company._id };
  const fileId = String(existing._id);
  const live = await execution.getFile(ctx, { id: fileId });
  if (live.file.responsibleMerchandiser?.email !== maker.email) {
    await execution.assignFile(ctx, {
      id: fileId,
      actor: maker,
      body: {
        email: maker.email,
        expectedRevision: live.file.revision,
        reason: "Responsible owner for the complete Order Execution demo.",
      },
    });
  }

  let meeting = await ppm.getCurrent(ctx, { fileId });
  if (!meeting.issued) {
    if (!meeting.working) {
      await ppm.createDraft(ctx, { fileId, actor: maker, idempotencyKey: randomUUID() });
      meeting = await ppm.getCurrent(ctx, { fileId });
    }

    if (meeting.working?.state === "DRAFT") {
      await ppm.updateDraft(ctx, {
        fileId,
        actor: maker,
        body: {
          expectedRevision: meeting.working.revision,
          plannedMeetingDate: day(-1),
          actualMeetingAt: new Date(`${day(-1)}T04:30:00Z`),
          locationOrMode: "Unit A — meeting room 2, with the laundry joining by call",
          chairperson: `${maker.name} — Merchandising owner`,
          merchandisingRepresentative: `${maker.name} — responsible merchandiser`,
          attendees: [
            { name: maker.name, department: "MERCHANDISING", role: "Responsible merchandiser" },
            { name: "Meera Shah", department: "SALES", role: "Sales handover owner" },
            { name: "Nandini Rao", department: "PRODUCT_DEVELOPMENT", role: "Pattern and sample" },
            { name: "Imran Qureshi", department: "IE", role: "Industrial engineer" },
            { name: "Farah Siddiqui", department: "QUALITY", role: "Quality lead" },
            { name: "Vikram Joshi", department: "PPC", role: "Planner" },
            { name: "Anil Kumar", department: "STORE", role: "Store in-charge" },
            { name: "Suresh Pillai", department: "PRODUCTION", role: "Line supervisor, Unit A" },
          ],
          absentDepartments: ["LOGISTICS"],
          reviewNotes: [
            { topic: "CONSTRUCTION", observation: "Front placket is interlined on both sides; snap spacing on the PP sample matches the approved pattern." },
            { topic: "MATERIAL_TRIM", observation: "Bulk twill matches both approved colour standards. The trim card carries the buyer-approved matte-black snaps." },
            { topic: "MEASUREMENT_FIT", observation: "The size M cuff opening was 5mm wide; the pattern was corrected before cutting." },
            { topic: "PACKAGING_PRESENTATION", observation: "The recycled polybag and kraft collar card hold the agreed presentation. Washed Olive cartons carry the WASHED mark." },
            { topic: "TESTING", observation: "Colour-fastness and shrinkage are submitted; metal detection follows once all snaps are in-house." },
            { topic: "MACHINE_ATTACHMENT", observation: "The snap machine needs the 15mm die set; IE confirmed two heads are available." },
            { topic: "PRODUCTION_HANDLING", observation: "Washed Olive moves to laundry in bundles of 20, with no mixed-colour bundles." },
            { topic: "BUYER_INSTRUCTIONS", observation: "No print is used on this style; the care instruction is woven." },
          ],
          decisions: [
            {
              topic: "MEASUREMENT_FIT",
              ownerDepartment: "PRODUCT_DEVELOPMENT",
              decision: "Correct the size M cuff opening by 5mm and reissue the graded pattern before cutting.",
              status: "CLOSED",
              closureNote: "Corrected pattern issued; IE has the updated marker.",
            },
            {
              topic: "MATERIAL_TRIM",
              ownerDepartment: "STORE",
              decision: "Confirm the received matte-black snaps against the 11-per-garment requirement and report the short quantity.",
              status: "OPEN",
              externalTaskRef: "TASK-2026-4471",
            },
            {
              topic: "TESTING",
              ownerDepartment: "QUALITY",
              decision: "Run metal detection on the first 200 finished pieces and record the result against this order.",
              status: "OPEN",
            },
            {
              topic: "PACKAGING_PRESENTATION",
              ownerDepartment: "LOGISTICS",
              decision: "Confirm whether the WASHED carton mark changes consolidation labelling.",
              status: "NOT_APPLICABLE",
              closureNote: "The buyer's consolidator owns the outer consolidation label.",
            },
          ],
        },
      });
      meeting = await ppm.getCurrent(ctx, { fileId });
    }

    if (meeting.working?.state === "DRAFT") {
      await ppm.conduct(ctx, {
        fileId,
        actor: maker,
        idempotencyKey: randomUUID(),
        body: { expectedRevision: meeting.working.revision },
      });
      meeting = await ppm.getCurrent(ctx, { fileId });
    }
  }

  const verified = await execution.getFile(ctx, { id: fileId });
  const verifiedMeeting = await ppm.getCurrent(ctx, { fileId });
  return {
    file: verified.file,
    meetingVersion: verifiedMeeting.issued?.versionNo
      || verifiedMeeting.working?.versionNo
      || null,
    meetingState: verifiedMeeting.issued?.state
      || verifiedMeeting.working?.state
      || "NOT_STARTED",
  };
}

async function main() {
  const apply = process.argv.includes("--apply");
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required.");

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  try {
    if (mongoose.connection.name !== "test") {
      throw new Error(`Refusing database ${mongoose.connection.name}; expected test.`);
    }

    const company = await Acc_Company.findById(COMPANY_ID).select("companyName");
    if (!company || company.companyName !== COMPANY_NAME) {
      throw new Error("The guarded demo company could not be proven.");
    }

    const existing = await ExecutionFile.findOne({
      companyId: company._id,
      fileNumber: FILE_NUMBER,
    }).select("_id fileNumber currentExecutionProjection.productName lifecycleStatus").lean();

    if (existing) {
      if (apply) {
        const repaired = await finishExisting(company, existing);
        console.log(JSON.stringify({
          outcome: "REPAIRED",
          database: mongoose.connection.name,
          company: company.companyName,
          fileId: repaired.file.id,
          fileNumber: repaired.file.fileNumber,
          product: repaired.file.productName,
          lifecycleStatus: repaired.file.lifecycleStatus,
          responsible: repaired.file.responsibleMerchandiser?.name || "",
          meetingVersion: repaired.meetingVersion,
          meetingState: repaired.meetingState,
          images: repaired.file.referenceImages?.length || 0,
          path: `/merchandiser/execution/${repaired.file.id}`,
        }, null, 2));
        return;
      }
      console.log(JSON.stringify({
        outcome: "ALREADY_EXISTS",
        database: mongoose.connection.name,
        company: company.companyName,
        fileId: String(existing._id),
        fileNumber: existing.fileNumber,
        product: existing.currentExecutionProjection?.productName || "",
        lifecycleStatus: existing.lifecycleStatus,
      }, null, 2));
      return;
    }

    if (!apply) {
      console.log(JSON.stringify({
        outcome: "DRY_RUN",
        database: mongoose.connection.name,
        company: company.companyName,
        willCreate: FILE_NUMBER,
        product: seedCompleteFile.ORDER.productName,
        quantity: seedCompleteFile.ORDER.quantity,
      }, null, 2));
      return;
    }

    const seeded = await seedCompleteFile({ company, maker, checker, day });
    if ((seeded.notes || []).length) {
      throw new Error(`The demo order was only partly populated: ${seeded.notes.join(" / ")}`);
    }

    const saved = await ExecutionFile.findOne({
      _id: seeded.fileId,
      companyId: company._id,
      fileNumber: FILE_NUMBER,
    }).lean();
    if (!saved) throw new Error("The demo order could not be verified after creation.");

    console.log(JSON.stringify({
      outcome: "CREATED",
      database: mongoose.connection.name,
      company: company.companyName,
      fileId: String(saved._id),
      fileNumber: saved.fileNumber,
      orderRef: saved.currentExecutionProjection?.orderRef || "",
      product: saved.currentExecutionProjection?.productName || "",
      quantity: saved.currentExecutionProjection?.totalQuantity || 0,
      lifecycleStatus: saved.lifecycleStatus,
      images: 4,
      path: `/merchandiser/execution/${String(saved._id)}`,
    }, null, 2));
  } finally {
    if (mongoose.connection.readyState) await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});
