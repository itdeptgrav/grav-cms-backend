/**
 * EVERYTHING A CAD TEST CUSTOMER HOLDS, WRITTEN TO A FILE — before `seedEmployees.js --cleanup` removes it.
 *
 *     node scripts/onboard/backupTestOrg.js <productRef> [...]
 *
 * Read-only. The test customer is found the way seedEmployees.js names it (cadtest.<product>@internal.gravtest.com);
 * its employees, measurement record, requests, work orders and production progress go to
 * scripts/onboard/backups/<productRef>-testorg-<time>.json, enough to put every document back with insertMany.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Customer = require("../../models/Customer_Models/Customer");
const EmployeeMpc = require("../../models/Customer_Models/Employee_Mpc");
const Measurement = require("../../models/Customer_Models/Measurement");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const EmployeeProductionProgress = require("../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");

const BACKUPS = path.join(__dirname, "backups");
fs.mkdirSync(BACKUPS, { recursive: true });

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  for (const ref of process.argv.slice(2)) {
    const email = `cadtest.${ref.toLowerCase().replace(/[^a-z0-9]/g, "")}@internal.gravtest.com`;
    const org = await Customer.findOne({ email }).lean();
    if (!org) { console.log(`${ref}: no test customer (${email})`); continue; }
    const requests = await CustomerRequest.find({ customerId: org._id }).lean();
    const ids = requests.map((r) => r._id);
    const workOrders = await WorkOrder.find({ customerRequestId: { $in: ids } }).lean();
    const progress = await EmployeeProductionProgress.find({ manufacturingOrderId: { $in: ids } }).lean();
    const measurements = await Measurement.find({ organizationId: org._id }).lean();
    const employees = await EmployeeMpc.find({ customerId: org._id }).lean();
    const file = path.join(BACKUPS, `${ref}-testorg-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(file, JSON.stringify({ takenAt: new Date().toISOString(), productRef: ref, customer: org, requests, workOrders, progress, measurements, employees }));
    console.log(`${ref}: customer ${org._id}, ${requests.length} request(s), ${workOrders.length} work order(s), ${progress.length} progress, ${measurements.length} measurement doc(s), ${employees.length} employee(s) -> ${file}`);
  }
  await mongoose.disconnect();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
