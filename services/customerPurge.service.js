"use strict";
// services/customerPurge.service.js
//
// "Delete this customer and everything raised for them."
//
// 28 Aug 2026, explicit request: a delete control on the customer page that
// removes "whatever the prospects, pipeline, leads and all orders and all are
// made for that customer".
//
// ── WHY THIS REFUSES SOME DELETES ───────────────────────────────────────────
//
// A customer is the root of a tree roughly 35 collections wide. Most of it is
// safe to remove — enquiries, journeys, work orders, dispatch challans, the
// customer's own employee roster. Some of it is NOT, and the difference is not
// a matter of taste:
//
//   • Acc_Invoice.customerId and Acc_BankTransaction.linkedCustomer point
//     straight at the Customer. Deleting the customer orphans posted invoices
//     and reconciled bank lines.
//   • Acc_Ledger.linkedCustomerId is the bridge from the CMS to the books, and
//     Acc_Voucher.partyLedgerId hangs off the LEDGER. So vouchers survive a
//     customer delete but their ledger's back-pointer dangles, and every
//     reconciliation query that joins ledgers to customers silently drops rows.
//     Deleting the ledger instead would break double-entry outright.
//
// Accounting records are not ours to destroy from a sales screen. So this
// service INSPECTS FIRST, and refuses the delete when money is attached,
// naming what is in the way. Everything else deletes for real.
//
// ── DELETION ORDER ──────────────────────────────────────────────────────────
// Children before parents, because several links are `required: true`
// (Measurement.organizationId, ReturnRequest.originalMoId,
// EmployeeMeasurement.workOrderId, and five required accountId fields). Removing
// a parent first leaves documents that can never be saved again.

const mongoose = require("mongoose");

/** Load a model by path, tolerating one that isn't present in this deployment. */
function tryModel(path) {
  try { return require(path); } catch { return null; }
}

const M = {
  Customer: () => tryModel("../models/Customer_Models/Customer"),
  CustomerRequest: () => tryModel("../models/Customer_Models/CustomerRequest"),
  EmployeeMpc: () => tryModel("../models/Customer_Models/Employee_Mpc"),
  Measurement: () => tryModel("../models/Customer_Models/Measurement"),
  DepartmentProductRule: () => tryModel("../models/Customer_Models/DepartmentProductRule"),
  Account: () => tryModel("../models/CMS_Models/Sales/Account"),
  Contact: () => tryModel("../models/CMS_Models/Sales/Contact"),
  Lead: () => tryModel("../models/CMS_Models/Sales/Lead"),
  Enquiry: () => tryModel("../models/CMS_Models/Sales/Enquiry"),
  SalesJourney: () => tryModel("../models/CMS_Models/Sales/SalesJourney"),
  SampleStyle: () => tryModel("../models/CMS_Models/Sales/SampleStyle"),
  Activity: () => tryModel("../models/CMS_Models/Sales/Activity"),
  WorkOrder: () => tryModel("../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder"),
  DispatchChallan: () => tryModel("../models/CMS_Models/Manufacturing/Dispatch/DispatchChallan"),
  EmployeeProductionProgress: () => tryModel("../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress"),
  ReturnRequest: () => tryModel("../models/CMS_Models/Manufacturing/Return/ReturnRequest"),
};

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const countOf = (Model, filter) => (Model ? Model.countDocuments(filter) : Promise.resolve(0));

/**
 * Everything attached to this customer, counted — plus whether deleting is safe.
 *
 * Always run before deleting, and shown to the person doing it: a cascade whose
 * scope you cannot see before confirming is not a decision, it is a gamble.
 */
async function deletionImpact(customerId) {
  const Customer = M.Customer();
  const customer = await Customer.findById(customerId)
    .select("name customerId email phone isActive")
    .lean();
  if (!customer) return null;

  const id = oid(customerId);

  // Roots the rest of the tree hangs from.
  const CustomerRequest = M.CustomerRequest();
  const Account = M.Account();
  const requests = CustomerRequest
    ? await CustomerRequest.find({ customerId: id }).select("_id requestId").lean()
    : [];
  const accounts = Account
    ? await Account.find({ linkedCustomer: id }).select("_id companyName").lean()
    : [];
  const requestIds = requests.map((r) => r._id);
  const accountIds = accounts.map((a) => a._id);

  const WorkOrder = M.WorkOrder();
  const workOrders = WorkOrder && requestIds.length
    ? await WorkOrder.find({ customerRequestId: { $in: requestIds } }).select("_id").lean()
    : [];
  const workOrderIds = workOrders.map((w) => w._id);

  const [
    contacts, leads, journeys, enquiries, sampleStyles, activities,
    challans, personProgress, returns, employees, measurements, deptRules,
  ] = await Promise.all([
    countOf(M.Contact(), { $or: [{ linkedCustomer: id }, ...(accountIds.length ? [{ accountId: { $in: accountIds } }] : [])] }),
    countOf(M.Lead(), accountIds.length ? { $or: [{ accountId: { $in: accountIds } }, { convertedCustomerId: id }] } : { convertedCustomerId: id }),
    countOf(M.SalesJourney(), accountIds.length ? { accountId: { $in: accountIds } } : { _id: null }),
    countOf(M.Enquiry(), accountIds.length ? { accountId: { $in: accountIds } } : { _id: null }),
    countOf(M.SampleStyle(), accountIds.length ? { accountId: { $in: accountIds } } : { _id: null }),
    countOf(M.Activity(), accountIds.length ? { accountId: { $in: accountIds } } : { _id: null }),
    countOf(M.DispatchChallan(), requestIds.length ? { manufacturingOrderId: { $in: requestIds } } : { _id: null }),
    countOf(M.EmployeeProductionProgress(), requestIds.length ? { manufacturingOrderId: { $in: requestIds } } : { _id: null }),
    countOf(M.ReturnRequest(), { $or: [{ customerId: id }, ...(requestIds.length ? [{ originalMoId: { $in: requestIds } }] : [])] }),
    countOf(M.EmployeeMpc(), { customerId: id }),
    countOf(M.Measurement(), { organizationId: id }),
    countOf(M.DepartmentProductRule(), { customerId: id }),
  ]);

  // ── The money check. Read straight off the collections so a model that this
  // deployment doesn't register still can't hide an invoice.
  const db = mongoose.connection.db;
  const safeCount = async (name, filter) => {
    try { return await db.collection(name).countDocuments(filter); } catch { return 0; }
  };
  const [invoices, bankTxns, ledgers, proformas] = await Promise.all([
    safeCount("acc_invoices", { $or: [{ customerId: id }, ...(requestIds.length ? [{ customerRequestId: { $in: requestIds } }] : [])] }),
    safeCount("acc_bank_transactions", { linkedCustomer: id }),
    safeCount("acc_ledgers", { linkedCustomerId: id }),
    safeCount("acc_proforma_invoices", { customerId: id }),
  ]);

  const blockers = [];
  if (invoices) blockers.push(`${invoices} accounting invoice${invoices === 1 ? "" : "s"}`);
  if (proformas) blockers.push(`${proformas} proforma invoice${proformas === 1 ? "" : "s"}`);
  if (bankTxns) blockers.push(`${bankTxns} reconciled bank transaction${bankTxns === 1 ? "" : "s"}`);
  if (ledgers) blockers.push(`${ledgers} accounting ledger${ledgers === 1 ? "" : "s"}`);

  // Money already received is its own stop: an order that has been paid for is
  // a financial event even when the books have not caught up with it yet.
  const paidOrders = requests.length && CustomerRequest
    ? await CustomerRequest.countDocuments({ _id: { $in: requestIds }, totalPaidAmount: { $gt: 0 } })
    : 0;
  if (paidOrders) blockers.push(`${paidOrders} order${paidOrders === 1 ? "" : "s"} with payments received`);

  return {
    customer: {
      id: String(customer._id),
      name: customer.name,
      code: customer.customerId,
      email: customer.email,
      phone: customer.phone,
      isActive: customer.isActive,
    },
    counts: {
      orders: requests.length,
      workOrders: workOrders.length,
      dispatchChallans: challans,
      personProgressRecords: personProgress,
      returns,
      accounts: accounts.length,
      contacts,
      leads,
      journeys,
      enquiries,
      sampleStyles,
      activities,
      customerEmployees: employees,
      measurementSessions: measurements,
      departmentRules: deptRules,
    },
    total: requests.length + workOrders.length + challans + personProgress + returns
      + accounts.length + contacts + leads + journeys + enquiries + sampleStyles
      + activities + employees + measurements + deptRules,
    financial: { invoices, proformas, bankTxns, ledgers, paidOrders },
    blockers,
    safeToDelete: blockers.length === 0,
    ids: { requestIds, accountIds, workOrderIds },
  };
}

/**
 * Delete the customer and everything beneath them.
 *
 * Refuses outright when `deletionImpact` found financial records — the caller
 * cannot override that, because "the salesperson was sure" is not a reason to
 * orphan a posted invoice.
 *
 * NOT wrapped in a transaction: this deployment's MongoDB is not guaranteed to
 * be a replica set, and `session`-based transactions throw outright on a
 * standalone server. Deletion runs children-first so a failure part-way leaves
 * orphaned CHILDREN removed and the parent intact — recoverable, and visibly
 * incomplete — rather than a live customer whose orders vanished.
 */
async function purgeCustomer(customerId) {
  const impact = await deletionImpact(customerId);
  if (!impact) return { ok: false, reason: "not-found" };
  if (!impact.safeToDelete) return { ok: false, reason: "has-financial-records", impact };

  const { requestIds, accountIds } = impact.ids;
  const deleted = {};
  const del = async (key, Model, filter) => {
    if (!Model) return;
    const r = await Model.deleteMany(filter);
    deleted[key] = r?.deletedCount || 0;
  };

  // ── Deepest children first ────────────────────────────────────────────────
  if (requestIds.length) {
    await del("personProgressRecords", M.EmployeeProductionProgress(), { manufacturingOrderId: { $in: requestIds } });
    await del("dispatchChallans", M.DispatchChallan(), { manufacturingOrderId: { $in: requestIds } });
    await del("returns", M.ReturnRequest(), { $or: [{ customerId: oid(customerId) }, { originalMoId: { $in: requestIds } }] });
    await del("workOrders", M.WorkOrder(), { customerRequestId: { $in: requestIds } });
  } else {
    await del("returns", M.ReturnRequest(), { customerId: oid(customerId) });
  }

  // ── The Sales CRM tree, beneath the account ───────────────────────────────
  if (accountIds.length) {
    await del("sampleStyles", M.SampleStyle(), { accountId: { $in: accountIds } });
    await del("enquiries", M.Enquiry(), { accountId: { $in: accountIds } });
    await del("journeys", M.SalesJourney(), { accountId: { $in: accountIds } });
    await del("activities", M.Activity(), { accountId: { $in: accountIds } });
    await del("leads", M.Lead(), { $or: [{ accountId: { $in: accountIds } }, { convertedCustomerId: oid(customerId) }] });
    await del("contacts", M.Contact(), { $or: [{ accountId: { $in: accountIds } }, { linkedCustomer: oid(customerId) }] });
  } else {
    await del("leads", M.Lead(), { convertedCustomerId: oid(customerId) });
    await del("contacts", M.Contact(), { linkedCustomer: oid(customerId) });
  }

  // ── Then the roots, then the customer's own records ───────────────────────
  await del("orders", M.CustomerRequest(), { customerId: oid(customerId) });
  await del("accounts", M.Account(), { linkedCustomer: oid(customerId) });
  await del("measurementSessions", M.Measurement(), { organizationId: oid(customerId) });
  await del("customerEmployees", M.EmployeeMpc(), { customerId: oid(customerId) });
  await del("departmentRules", M.DepartmentProductRule(), { customerId: oid(customerId) });

  await M.Customer().deleteOne({ _id: oid(customerId) });
  deleted.customer = 1;

  return { ok: true, deleted, customer: impact.customer };
}

module.exports = { deletionImpact, purgeCustomer };
