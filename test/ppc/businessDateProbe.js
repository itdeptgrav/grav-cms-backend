// test/ppc/businessDateProbe.js
//
// Run as a CHILD PROCESS under a chosen `TZ` by ppc-planning-file-contract.test.js.
// Node fixes its timezone at start-up, so the only honest way to prove a date
// does not shift in Los Angeles or Kiritimati is to start a process there.
// It touches no database: it runs the normaliser, the model's own casting and
// the projection, and prints what each produced.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");
const { PpcPlanningFile } = require("../../models/CMS_Models/PPC/PpcPlanningFile");
const planning = require("../../services/ppc/planningFile.service");
const { businessDateFromInstant } = require("../../services/ppc/businessDate");

const sent = {
  requestedProductionStart: "2026-10-05",
  requestedProductionEnd: "2026-10-26",
  requestedCompletionDate: "2026-10-31",
};
const actor = { id: new mongoose.Types.ObjectId(), name: "Probe", email: "" };
const { set } = planning.normalisePlanningFields(sent, { actor });

const doc = new PpcPlanningFile({
  planningFileRef: "PPCPF-PROBE", companyId: new mongoose.Types.ObjectId(),
  orderRef: "O", orderLineRef: "L", executionFileId: new mongoose.Types.ObjectId(),
  sourceBasis: {
    capturedAt: new Date(), confirmedQuantity: 1,
    /* Merchandising's instant for the 20th, as a date input produced it. */
    earliestDeliveryDate: businessDateFromInstant(new Date("2026-11-20")),
    packReceiptId: new mongoose.Types.ObjectId(), packReceiptVersionNo: 1,
    ieReceiptId: new mongoose.Types.ObjectId(), ieReceiptVersionNo: 1,
  },
  planning: {
    requestedProductionStart: set["planning.requestedProductionStart"],
    requestedProductionEnd: set["planning.requestedProductionEnd"],
    requestedCompletionDate: set["planning.requestedCompletionDate"],
  },
  history: [],
});
const wire = JSON.parse(JSON.stringify(planning.projected(doc.toObject())));

process.stdout.write(JSON.stringify({
  tz: process.env.TZ,
  offsetMinutes: new Date("2026-10-05T12:00:00Z").getTimezoneOffset(),
  normalised: {
    start: set["planning.requestedProductionStart"],
    end: set["planning.requestedProductionEnd"],
    completion: set["planning.requestedCompletionDate"],
  },
  stored: {
    start: doc.planning.requestedProductionStart,
    end: doc.planning.requestedProductionEnd,
    completion: doc.planning.requestedCompletionDate,
    delivery: doc.sourceBasis.earliestDeliveryDate,
  },
  wire: {
    start: wire.planning.requestedProductionStart,
    end: wire.planning.requestedProductionEnd,
    completion: wire.planning.requestedCompletionDate,
    delivery: wire.sourceBasis.earliestDeliveryDate,
  },
}));
