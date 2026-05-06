// services/ledgerSeeder.service.js
// =============================================================================
// LEDGER SEEDER
// -----------------------------------------------------------------------------
// Auto-creates ledgers for the GRAV organisation against a Tally Company:
//
//   1. SALARY EXPENSE LEDGERS  — one per HR department, under "Indirect Expenses"
//        e.g. "Salary - Cutting", "Salary - HR", "Salary - Production"
//   2. EMPLOYEE PAYABLE LEDGERS — one per active employee, under
//        "Sundry Creditors" (so unpaid salary sits on the liability side)
//   3. CUSTOMER LEDGERS         — one per CMS Customer, under "Sundry Debtors"
//   4. VENDOR LEDGERS           — one per Vendor record, under "Sundry Creditors"
//   5. STANDARD CASH/BANK       — "Cash-in-Hand", "HDFC Bank A/c" placeholders
//
// All seeders are idempotent: running twice will not produce duplicates.
// =============================================================================

const mongoose = require("mongoose");
const {
  TallyGroup,
  TallyLedger,
} = require("../models/Accountant_model/TallyMasterModels");

// Lazy-load CMS models so a missing model doesn't crash boot
function tryRequire(p) {
  try {
    return require(p);
  } catch {
    return null;
  }
}

const Employee = tryRequire("../models/Employee");
const Customer = tryRequire("../models/Customer_Models/Customer");
const Vendor = tryRequire("../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const HRDepartment = tryRequire("../models/HRDepartment");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
async function findOrCreateGroup(companyId, groupName, fallback) {
  let grp = await TallyGroup.findOne({ companyId, name: groupName });
  if (grp) return grp;
  // Caller can provide a fallback shape (e.g. for a new sub-group under a parent)
  return TallyGroup.create({ companyId, name: groupName, ...fallback });
}

async function findOrCreateLedger(filter, doc) {
  let led = await TallyLedger.findOne(filter);
  if (led) return { ledger: led, created: false };
  led = await TallyLedger.create(doc);
  return { ledger: led, created: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// SEED 1 — Cash & Bank (placeholders)
// ─────────────────────────────────────────────────────────────────────────────
async function seedCashAndBank(companyId, createdBy) {
  const results = [];

  const cashGroup = await TallyGroup.findOne({
    companyId,
    name: "Cash-in-Hand",
  });
  if (cashGroup) {
    const r = await findOrCreateLedger(
      { companyId, name: "Cash" },
      {
        companyId,
        name: "Cash",
        groupId: cashGroup._id,
        groupName: cashGroup.name,
        nature: "asset",
        openingBalance: 0,
        currentBalance: 0,
        currentBalanceType: "Dr",
        createdBy,
        importSource: "auto",
      },
    );
    if (r.created) results.push(r.ledger.name);
  }

  const bankGroup = await TallyGroup.findOne({
    companyId,
    name: "Bank Accounts",
  });
  if (bankGroup) {
    const r = await findOrCreateLedger(
      { companyId, name: "HDFC Bank A/c" },
      {
        companyId,
        name: "HDFC Bank A/c",
        groupId: bankGroup._id,
        groupName: bankGroup.name,
        nature: "asset",
        openingBalance: 0,
        currentBalance: 0,
        currentBalanceType: "Dr",
        bankDetails: { bankName: "HDFC Bank", accountType: "current" },
        createdBy,
        importSource: "auto",
      },
    );
    if (r.created) results.push(r.ledger.name);
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// SEED 2 — Salary Expense Ledgers (one per HR department)
// ─────────────────────────────────────────────────────────────────────────────
// Lives under "Indirect Expenses" (the standard Tally home for payroll).
async function seedSalaryExpenseByDepartment(companyId, createdBy) {
  if (!HRDepartment) return [];
  const created = [];

  const parent = await TallyGroup.findOne({
    companyId,
    name: "Indirect Expenses",
  });
  if (!parent) return [];

  // Sub-group "Salaries" if it doesn't exist
  let salaryGroup = await TallyGroup.findOne({
    companyId,
    name: "Salaries & Wages",
  });
  if (!salaryGroup) {
    salaryGroup = await TallyGroup.create({
      companyId,
      name: "Salaries & Wages",
      parent: parent._id,
      parentName: parent.name,
      nature: "expense",
      level: 2,
      fullPath: `${parent.fullPath || parent.name} > Salaries & Wages`,
      isReserved: false,
    });
    created.push({ type: "group", name: salaryGroup.name });
  }

  // Pull distinct department names from HR records (also include hard-coded core depts)
  const hrDepts = await HRDepartment.distinct("department", {
    isActive: { $ne: false },
  });
  const coreDepts = [
    "Cutting",
    "Production Supervisor",
    "Quality Control",
    "Packaging & Dispatch",
    "Human Resources",
    "Accounting",
    "Executive Office",
    "Sales",
    "Inventory",
    "Customer Service",
  ];
  const allDepts = Array.from(new Set([...hrDepts, ...coreDepts])).filter(
    Boolean,
  );

  for (const dept of allDepts) {
    const ledgerName = `Salary - ${dept}`;
    const r = await findOrCreateLedger(
      { companyId, name: ledgerName },
      {
        companyId,
        name: ledgerName,
        groupId: salaryGroup._id,
        groupName: salaryGroup.name,
        nature: "expense",
        openingBalance: 0,
        currentBalance: 0,
        currentBalanceType: "Dr",
        createdBy,
        importSource: "auto",
        notes: `Auto-seeded salary expense for ${dept} department`,
      },
    );
    if (r.created) created.push({ type: "ledger", name: ledgerName });
  }

  return created;
}

// ─────────────────────────────────────────────────────────────────────────────
// SEED 3 — Employee Payable Ledgers (one per employee)
// ─────────────────────────────────────────────────────────────────────────────
// Each employee gets a ledger under "Sundry Creditors" so unpaid salary
// (a liability) accrues against their account. Bill-wise enabled so each
// month's payroll appears as a separate bill.
async function seedEmployeeLedgers(companyId, createdBy) {
  if (!Employee) return [];
  const created = [];

  const parent = await TallyGroup.findOne({
    companyId,
    name: "Sundry Creditors",
  });
  if (!parent) return [];

  // Sub-group "Employee Payables"
  let empGroup = await TallyGroup.findOne({
    companyId,
    name: "Employee Payables",
  });
  if (!empGroup) {
    empGroup = await TallyGroup.create({
      companyId,
      name: "Employee Payables",
      parent: parent._id,
      parentName: parent.name,
      nature: "liability",
      level: 2,
      fullPath: `${parent.fullPath || parent.name} > Employee Payables`,
      isReserved: false,
    });
    created.push({ type: "group", name: empGroup.name });
  }

  // Page through employees to keep memory in check on large rosters
  const cursor = Employee.find({ status: "active" })
    .select(
      "_id firstName lastName employeeId identityId email phone department",
    )
    .lean()
    .cursor();

  for (let emp = await cursor.next(); emp; emp = await cursor.next()) {
    const fullName =
      `${emp.firstName || ""} ${emp.lastName || ""}`.trim() || emp.employeeId;
    const codeTag =
      emp.employeeId || emp.identityId || String(emp._id).slice(-6);
    const ledgerName = `${fullName} (${codeTag})`;

    const r = await findOrCreateLedger(
      { companyId, linkedEmployeeId: emp._id },
      {
        companyId,
        name: ledgerName,
        aliases: [emp.employeeId, emp.identityId].filter(Boolean),
        groupId: empGroup._id,
        groupName: empGroup.name,
        nature: "liability",
        openingBalance: 0,
        currentBalance: 0,
        currentBalanceType: "Cr",
        billWiseEnabled: true,
        contactDetails: {
          phone: emp.phone || "",
          email: emp.email || "",
        },
        linkedEmployeeId: emp._id,
        notes: `Auto-seeded for employee ${codeTag} · ${emp.department || "—"}`,
        createdBy,
        importSource: "auto",
      },
    );
    if (r.created)
      created.push({ type: "ledger", name: ledgerName, employeeId: codeTag });
  }

  return created;
}

// ─────────────────────────────────────────────────────────────────────────────
// SEED 4 — Customer Ledgers (one per Customer)
// ─────────────────────────────────────────────────────────────────────────────
async function seedCustomerLedgers(companyId, createdBy) {
  if (!Customer) return [];
  const created = [];

  const parent = await TallyGroup.findOne({
    companyId,
    name: "Sundry Debtors",
  });
  if (!parent) return [];

  const cursor = Customer.find({})
    .select("_id name email phone gstin pan billingAddress shippingAddress")
    .lean()
    .cursor();

  for (let cust = await cursor.next(); cust; cust = await cursor.next()) {
    if (!cust.name) continue;
    const ledgerName = String(cust.name).trim();

    const addr = cust.billingAddress || cust.shippingAddress || {};
    const r = await findOrCreateLedger(
      { companyId, linkedCustomerId: cust._id },
      {
        companyId,
        name: ledgerName,
        groupId: parent._id,
        groupName: parent.name,
        nature: "asset",
        openingBalance: 0,
        currentBalance: 0,
        currentBalanceType: "Dr",
        gstin: cust.gstin || "",
        panNumber: cust.pan || "",
        gstApplicable: !!cust.gstin,
        billWiseEnabled: true,
        contactDetails: {
          phone: cust.phone || "",
          email: cust.email || "",
          address: [addr.line1, addr.line2].filter(Boolean).join(", "),
          city: addr.city || "",
          state: addr.state || "",
          pincode: addr.pincode || "",
        },
        linkedCustomerId: cust._id,
        createdBy,
        importSource: "auto",
      },
    );
    if (r.created) created.push({ type: "ledger", name: ledgerName });
  }

  return created;
}

// ─────────────────────────────────────────────────────────────────────────────
// SEED 5 — Vendor Ledgers (one per Vendor)
// ─────────────────────────────────────────────────────────────────────────────
async function seedVendorLedgers(companyId, createdBy) {
  if (!Vendor) return [];
  const created = [];

  const parent = await TallyGroup.findOne({
    companyId,
    name: "Sundry Creditors",
  });
  if (!parent) return [];

  const cursor = Vendor.find({})
    .select("_id name email phone gstin pan address")
    .lean()
    .cursor();

  for (let vendor = await cursor.next(); vendor; vendor = await cursor.next()) {
    if (!vendor.name) continue;
    const ledgerName = String(vendor.name).trim();

    const r = await findOrCreateLedger(
      { companyId, linkedVendorId: vendor._id },
      {
        companyId,
        name: ledgerName,
        groupId: parent._id,
        groupName: parent.name,
        nature: "liability",
        openingBalance: 0,
        currentBalance: 0,
        currentBalanceType: "Cr",
        gstin: vendor.gstin || "",
        panNumber: vendor.pan || "",
        gstApplicable: !!vendor.gstin,
        billWiseEnabled: true,
        contactDetails: {
          phone: vendor.phone || "",
          email: vendor.email || "",
          address:
            typeof vendor.address === "string"
              ? vendor.address
              : [vendor.address?.line1, vendor.address?.city]
                  .filter(Boolean)
                  .join(", "),
        },
        linkedVendorId: vendor._id,
        createdBy,
        importSource: "auto",
      },
    );
    if (r.created) created.push({ type: "ledger", name: ledgerName });
  }

  return created;
}

// ─────────────────────────────────────────────────────────────────────────────
// Master orchestrator
// ─────────────────────────────────────────────────────────────────────────────
async function seedAll(companyId, createdBy = null) {
  if (!companyId) throw new Error("companyId required");
  if (!mongoose.Types.ObjectId.isValid(companyId)) {
    throw new Error("Invalid companyId");
  }

  const summary = {
    cashAndBank: await seedCashAndBank(companyId, createdBy),
    salaryExpenses: await seedSalaryExpenseByDepartment(companyId, createdBy),
    employees: await seedEmployeeLedgers(companyId, createdBy),
    customers: await seedCustomerLedgers(companyId, createdBy),
    vendors: await seedVendorLedgers(companyId, createdBy),
  };

  summary.totalCreated =
    summary.cashAndBank.length +
    summary.salaryExpenses.length +
    summary.employees.length +
    summary.customers.length +
    summary.vendors.length;

  return summary;
}

module.exports = {
  seedAll,
  seedCashAndBank,
  seedSalaryExpenseByDepartment,
  seedEmployeeLedgers,
  seedCustomerLedgers,
  seedVendorLedgers,
};
