// services/actionables/actionableProviders.js
//
// What each application counts for the /onboarding dashboard — one provider
// per department slug, `async (ctx) => items[]`, where an item is
// `{ key, label, count, tone, href }` (see actionablesSummary.js).
//
// RULES EVERY PROVIDER FOLLOWS
// - The filter is the one the department's own list or overview already uses
//   (cited beside each), so the number matches what the page shows. Nothing
//   here invents a status.
// - One countDocuments per item, all of an application's run at once.
// - Role decides what is shown: a decision (approve / reject) only to someone
//   whose role may approve (`ctx.canApprove`); work to do only to a role that
//   may write; a viewer is shown nothing to act on.
// - `href` is the CMS page that lists those records.
// - Applications with no stored, countable queue (CEO, finishing stages,
//   embroidery) have no provider: the page says "open to see its work"
//   rather than pretending they are clear.
//
// COMPANY. GRAV is one organisation, and while STORE_PURCHASE_STRICT_TENANCY
// is unset every module reads the primary company's records PLUS the legacy
// ones with no company stamped. `companyScope()` is that read-through: the
// canonical (isPrimary) company, or no company at all. Demo companies (the IE
// seed) are therefore never counted.

"use strict";

const { TONE } = require("./actionablesSummary");

const MAX_MS = 4000;

const lazy = (fn) => {
  let v;
  return () => (v === undefined ? (v = fn()) : v);
};

/** A bounded count; a slow collection fails the provider rather than the page. */
function count(Model, filter) {
  return Model.countDocuments(filter).maxTimeMS(MAX_MS);
}

/* ── company read-through (memoised; it changes when the books change) ── */

let companyMemo = { at: 0, id: undefined };
async function primaryCompanyId() {
  if (companyMemo.id !== undefined && Date.now() - companyMemo.at < 5 * 60_000) return companyMemo.id;
  let id = null;
  try {
    const { getCanonicalCompany } = require("../companyContext/canonicalCompany.service");
    const c = await getCanonicalCompany();
    id = c?._id || null;
  } catch {
    id = null;
  }
  companyMemo = { at: Date.now(), id };
  return id;
}

async function companyScope(field = "companyId") {
  const id = await primaryCompanyId();
  const legacy = [{ [field]: null }]; // matches absent and null
  return { $or: id ? [{ [field]: id }, ...legacy] : legacy };
}

/** IST midnight of today, as the UTC instant stored day fields compare with. */
function todayIST(now = new Date()) {
  const ist = new Date(now.getTime() + 330 * 60000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

const item = (key, label, n, tone, href) => ({ key, label, count: n, tone, href });

/* ── models, required on first use ───────────────────────────────────── */

const M = {
  ChangeRequest: lazy(() => require("../../models/Access/ChangeRequest")),
  Leave: lazy(() => require("../../models/HR_Models/LeaveManagement")),
  EmployeeDocument: lazy(() => require("../../models/HR_Models/EmployeeDocument")),
  Activity: lazy(() => require("../../models/CMS_Models/Sales/Activity")),
  CustomerRequest: lazy(() => require("../../models/Customer_Models/CustomerRequest")),
  Development: lazy(() => require("../../models/CMS_Models/Merchandising/Development")),
  AccOrg: lazy(() => require("../../models/Accountant_model/Acc_OrgModels")),
  SpendRequest: lazy(() => require("../../models/CMS_Models/Requests/SpendRequest")),
  IntakeRequest: lazy(() => require("../../models/CMS_Models/Requests/IntakeRequest")),
  MRF: lazy(() => require("../../models/CMS_Models/Inventory/Operations/MRF")),
  PurchaseOrder: lazy(() => require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder")),
  Measurement: lazy(() => require("../../models/Customer_Models/Measurement")),
  WorkOrder: lazy(() => require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder")),
  PackingCarton: lazy(() => require("../../models/CMS_Models/Manufacturing/Packaging/PackingCarton")),
  PpcPlanningFile: lazy(() => require("../../models/CMS_Models/PPC/PpcPlanningFile").PpcPlanningFile),
  IeMethodStudy: lazy(() => require("../../models/CMS_Models/IndustrialEngineering/IeMethodStudy")),
  IeBulletinVersion: lazy(() => require("../../models/CMS_Models/IndustrialEngineering/IeBulletinVersion")),
  MaintenanceOrder: lazy(() => require("../../models/CMS_Models/Maintenance/MaintenanceOrder")),
  EnquiryRouting: lazy(() => require("../../models/CMS_Models/Marketing/MarketingSourceEnquiryRouting").MarketingSourceEnquiryRouting),
  ProspectHandover: lazy(() => require("../../models/CMS_Models/Marketing/ProspectHandover")),
  BoardPolicy: lazy(() => require("../../models/CMS_Models/Board/BoardPolicy")),
  DevAlert: lazy(() => require("../../models/DevOps/DevAlert")),
};

/* ── the approval queue (routes/Access/changeRequests.js) ─────────────────
   An approver is shown the department's pending holds (the queue's own
   badge filter, :201); anyone else who may write is shown their OWN changes
   still waiting, as the queue lists them for an editor (:192). */
async function heldChanges(ctx, slug, href) {
  const ChangeRequest = M.ChangeRequest();
  if (ctx.canApprove) {
    const n = await count(ChangeRequest, { departmentSlug: slug, status: "pending" });
    return [item(`changes:${slug}`, "Changes waiting for your approval", n, TONE.ATTENTION, href)];
  }
  if (ctx.capabilities.write && ctx.email) {
    const n = await count(ChangeRequest, { departmentSlug: slug, status: "pending", "requestedBy.email": ctx.email });
    return [item(`my-changes:${slug}`, "Your changes awaiting approval", n, TONE.INFO, href)];
  }
  return [];
}

const all = async (...parts) => (await Promise.all(parts)).flat().filter(Boolean);
const when = (cond, fn) => (cond ? fn() : Promise.resolve([]));

/* ── providers ────────────────────────────────────────────────────────── */

const PROVIDERS = {
  /* routes/HrRoutes/Overview-Section.js:200-215; EmployeeDocuments_section.js:538 */
  hr: (ctx) => all(
    when(ctx.capabilities.write, async () => {
      const { LeaveApplication, RegularizationRequest } = M.Leave();
      const open = { status: { $in: ["pending", "manager_approved"] } };
      const [leave, reg, docs] = await Promise.all([
        count(LeaveApplication, open),
        count(RegularizationRequest, open),
        count(M.EmployeeDocument(), { requestStatus: "requested" }),
      ]);
      return [
        item("leave", "Leave requests to decide", leave, TONE.ATTENTION, "/hr/dashboard/leaves"),
        item("regularization", "Attendance regularizations to decide", reg, TONE.ATTENTION, "/hr/dashboard/attendance/regularizations"),
        item("documents", "Document requests to fulfil", docs, TONE.INFO, "/hr/dashboard/documents/requests"),
      ];
    }),
    heldChanges(ctx, "hr", "/hr/dashboard/approvals"),
  ),

  /* routes/CMS_Routes/Sales/activities.js:140 (/tasks/mine);
     routes/CMS_Routes/Sales/dashboard.js:44 */
  sales: (ctx) => all(
    when(ctx.capabilities.write && /^[a-f0-9]{24}$/i.test(ctx.userId), async () => {
      const n = await count(M.Activity(), {
        isActive: true, status: "planned", ownerId: ctx.userId, dueDate: { $lt: new Date() },
      });
      return [item("overdue-tasks", "Your overdue follow-ups", n, TONE.URGENT, "/sales/dashboard")];
    }),
    when(ctx.capabilities.write, async () => {
      const n = await count(M.CustomerRequest(), { status: { $in: ["pending", "pending_edit_approval"] } });
      return [item("customer-requests", "Customer requests awaiting a response", n, TONE.ATTENTION, "/sales/dashboard/customer-requests")];
    }),
    heldChanges(ctx, "sales", null),
  ),

  /* services/merchandising/development.service.js:478-501 */
  merchandiser: (ctx) => when(ctx.capabilities.write, async () => {
    const { DevelopmentFile, DevelopmentRequestReceipt } = M.Development();
    const co = await companyScope();
    const live = { ...co, archived: { $ne: true } };
    const [fresh, awaiting, clarify] = await Promise.all([
      count(DevelopmentFile, { ...live, lifecycleStatus: "NEW" }),
      count(DevelopmentFile, { ...live, lifecycleStatus: "AWAITING_APPROVAL" }),
      count(DevelopmentRequestReceipt, { ...co, state: "CLARIFICATION_REQUESTED" }),
    ]);
    return [
      item("dev-new", "New development requests", fresh, TONE.ATTENTION, "/merchandiser/development?view=new"),
      item("dev-approval", "Developments awaiting approval", awaiting, TONE.INFO, "/merchandiser/development?view=awaiting-approval"),
      item("dev-clarify", "Requests waiting on a clarification", clarify, TONE.INFO, "/merchandiser/development?awaitingClarification=true"),
    ];
  }),

  /* routes/Accountant_Routes/Acc_approvals.js:797; Acc_spendApprovals.js:134 */
  accountant: (ctx) => when(ctx.canApprove, async () => {
    const { Acc_ApprovalRequest } = M.AccOrg();
    const co = await companyScope();
    const [approvals, spend] = await Promise.all([
      count(Acc_ApprovalRequest, { status: "pending" }),
      count(M.SpendRequest(), { ...co, status: "pending_finance" }),
    ]);
    return [
      item("acc-approvals", "Accounting approvals waiting", approvals, TONE.ATTENTION, "/accountant/approvals"),
      item("spend-finance", "Spend requests at finance review", spend, TONE.ATTENTION, "/accountant/payables/spend-approvals"),
    ];
  }),

  /* routes/CMS_Routes/Inventory/overview/operations.js:86,119,135;
     intakeRequests.js:2134 (to classify); spendRequests.js:1300 (ready to order) */
  store: (ctx) => when(ctx.capabilities.write, async () => {
    const co = await companyScope();
    const PO = M.PurchaseOrder();
    const open = { ...co, status: { $in: ["ISSUED", "PARTIALLY_RECEIVED"] } };
    const [mrf, classify, toOrder, drafts, late, expected] = await Promise.all([
      count(M.MRF(), { ...co, status: "APPROVED", storeReviewedAt: null }),
      count(M.IntakeRequest(), { status: "needs_classification" }),
      count(M.SpendRequest(), { ...co, status: "approved" }),
      count(PO, { ...co, status: "DRAFT" }),
      count(PO, { ...open, expectedDeliveryDate: { $lt: todayIST() } }),
      count(PO, open),
    ]);
    return [
      item("po-late", "Purchase orders past their delivery date", late, TONE.URGENT, "/store/dashboard/operations/purchase-order"),
      item("mrf-review", "Material requests to review", mrf, TONE.ATTENTION, "/store/dashboard/order-requests"),
      item("intake-classify", "Requests to classify", classify, TONE.ATTENTION, "/requests"),
      item("spend-to-order", "Approved purchases to order", toOrder, TONE.ATTENTION, "/store/dashboard/operations/purchase-order"),
      item("po-draft", "Draft purchase orders", drafts, TONE.INFO, "/store/dashboard/operations/purchase-order?status=DRAFT"),
      item("po-expected", "Deliveries expected", expected, TONE.INFO, "/store/dashboard/operations/purchase-order"),
    ];
  }),

  /* models/Customer_Models/Measurement.js — measurements still collecting people */
  "mpc-measurement": (ctx) => when(ctx.capabilities.write, async () => {
    const n = await count(M.Measurement(), { convertedToPO: false, pendingEmployees: { $gt: 0 } });
    return [item("measurements", "Measurements with people still to measure", n, TONE.INFO, "/mpc-measurement/dashboard/configurations/measurements")];
  }),

  /* cuttingAccess.workOrderScope — the Cutting queue's own read-through */
  "cutting-master": (ctx) => when(ctx.capabilities.write, async () => {
    const id = await primaryCompanyId();
    const scope = id
      ? require("../../routes/CMS_Routes/Manufacturing/CuttingMaster/cuttingAccess").workOrderScope(id)
      : { "salesLineLink.companyId": null };
    const n = await count(M.WorkOrder(), { ...scope, sentToCutting: true, cuttingStatus: { $in: ["pending", "in_progress"] } });
    return [item("cutting", "Work orders to cut", n, TONE.ATTENTION, "/cutting-master/dashboard/assigned-work")];
  }),

  /* the only queue it holds is the approval one; no page lists it */
  "production-supervisor": (ctx) => heldChanges(ctx, "production-supervisor", null),

  /* services/qcStages.pendingReworkSnapshot — what the QC overview shows */
  qc: (ctx) => when(ctx.capabilities.write, async () => {
    const { count: n } = await require("../qcStages").pendingReworkSnapshot({});
    return [item("rework", "Pieces waiting for re-inspection", n, TONE.ATTENTION, "/qc/dashboard/inspect")];
  }),

  /* cartonDispatchRoutes.js:303 (packed = not yet dispatched); packagingRoutes.js:1208 */
  "packaging-dispatch": (ctx) => when(ctx.capabilities.write, async () => {
    const co = await companyScope();
    const [packed, unweighed] = await Promise.all([
      count(M.PackingCarton(), { ...co, status: "packed" }),
      count(M.PackingCarton(), { ...co, status: "packed", weightKg: null }),
    ]);
    return [
      item("cartons-packed", "Packed cartons waiting for dispatch", packed, TONE.ATTENTION, "/packaging-dispatch/dashboard/cartons"),
      item("cartons-unweighed", "Cartons still to weigh", unweighed, TONE.INFO, "/packaging-dispatch/dashboard/cartons"),
    ];
  }),

  /* PPC holds the production writes under the `project-manager` slug */
  ppc: (ctx) => all(
    when(ctx.capabilities.write, async () => {
      const co = await companyScope();
      const n = await count(M.PpcPlanningFile(), { ...co, state: "OPEN" });
      return [item("planning-open", "Orders not yet planned", n, TONE.ATTENTION, "/ppc/order-book")];
    }),
    heldChanges(ctx, "project-manager", "/ppc/approvals"),
  ),

  ie: (ctx) => all(
    when(ctx.canApprove, async () => {
      const co = await companyScope();
      const [studies, bulletins] = await Promise.all([
        count(M.IeMethodStudy(), { ...co, status: "IN_REVIEW" }),
        count(M.IeBulletinVersion(), { ...co, state: "IN_REVIEW" }),
      ]);
      return [
        item("method-review", "Method studies in review", studies, TONE.ATTENTION, "/industrial-engineering/development"),
        item("bulletin-review", "Operation bulletins in review", bulletins, TONE.ATTENTION, "/industrial-engineering/orders"),
      ];
    }),
    heldChanges(ctx, "ie", null),
  ),

  /* services/maintenance/maintenanceOrders.service.js:990 (overdue), the
     report step (DONE = repair completed, report pending) */
  maintenance: (ctx) => when(ctx.capabilities.write, async () => {
    const ready = await require("../maintenance/maintenanceStorage").orderStorageReady().catch(() => false);
    if (!ready) return [];
    const flow = require("../maintenance/maintenanceOrderFlow");
    const Order = M.MaintenanceOrder();
    const open = { status: { $in: flow.storedAsAny(flow.OPEN.service) } };
    const [overdue, reports, running] = await Promise.all([
      count(Order, { ...open, "details.targetDate": { $lt: todayIST() } }),
      count(Order, { status: { $in: flow.storedAs("DONE") } }),
      count(Order, open),
    ]);
    return [
      item("mnt-overdue", "Maintenance jobs past their target date", overdue, TONE.URGENT, "/maintenance/service-orders?due=overdue"),
      item("mnt-report", "Repairs waiting for a report", reports, TONE.ATTENTION, "/maintenance/service-orders?status=DONE"),
      item("mnt-open", "Open maintenance jobs", running, TONE.INFO, "/maintenance/service-orders"),
    ];
  }),

  marketing: (ctx) => when(ctx.capabilities.write, async () => {
    const co = await companyScope();
    const [held, returned] = await Promise.all([
      count(M.EnquiryRouting(), { ...co, state: "held_for_review" }),
      count(M.ProspectHandover(), { ...co, state: "RETURNED" }),
    ]);
    return [
      item("enquiries-held", "Enquiries held for review", held, TONE.ATTENTION, "/marketing/enquiries/routing"),
      item("handovers-returned", "Handovers returned by Sales", returned, TONE.ATTENTION, "/marketing/handovers"),
    ];
  }),

  board: (ctx) => when(ctx.canApprove, async () => {
    const co = await companyScope();
    const n = await count(M.BoardPolicy(), { ...co, status: "DRAFT" });
    return [item("policy-drafts", "Policy drafts awaiting board approval", n, TONE.ATTENTION, "/board/dashboard")];
  }),

  /* routes/DevOps/developer.js:452 */
  developer: async () => {
    const [open, acked] = await Promise.all([
      count(M.DevAlert(), { status: "open" }),
      count(M.DevAlert(), { status: "acked" }),
    ]);
    return [
      item("alerts-open", "New system alerts", open, TONE.URGENT, "/developer/alerts"),
      item("alerts-acked", "Acknowledged alerts not yet resolved", acked, TONE.INFO, "/developer/alerts"),
    ];
  },
};

// `_models` is exported for the tests, which replace each with a recording stand-in.
module.exports = { PROVIDERS, companyScope, todayIST, _models: M };
