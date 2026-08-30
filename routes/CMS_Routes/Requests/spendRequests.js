// routes/CMS_Routes/Requests/spendRequests.js
//
// PURCHASE AND SERVICE REQUESTS — /api/requests/spend
//
// The second kind of ask in the Requests app. Material from Store is an MRF
// and is untouched by this file; this is for what the store cannot issue: a
// repair, a vendor purchase, a piece of software.
//
// ── EVERY FIGURE IS RECOMPUTED HERE ─────────────────────────────────────────
// The client sends a quantity and a rate. It does NOT send an amount, and if
// it did the number would be ignored: a line's amount is quantity × rate and a
// total is the sum of the lines, computed on the way in. A stored total that
// disagrees with its own lines is not a derivation, and it is the number
// somebody later approves.
//
// ── NO BUDGET, DELIBERATELY ─────────────────────────────────────────────────
// A request names an account head so it can be counted against one later.
// Nothing here reserves, commits or consumes budget, and no response claims
// to. That is a separate decision with its own approvals.
//
// ── AUTHENTICATION ──────────────────────────────────────────────────────────
// Mounted behind EmployeeAuth in server.js, exactly like the CMS door onto MRF.
// The requester is always the caller: `requestedBy` is taken from the session
// and never from the body, so nobody can file an ask as somebody else.

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const SpendRequest = require("../../../models/CMS_Models/Requests/SpendRequest");
const Employee = require("../../../models/Employee");
const { Acc_Company, Acc_Ledger } = require("../../../models/Accountant_model/Acc_MasterModels");
const mrfApprover = require("../../../services/mrfApprover.service");
const fulfilment = require("../../../services/storeFulfilment.service");
const financeDecision = require("../../../services/spendFinanceDecision.service");
const chain = require("../../../services/spendApproval.service");
const { Acc_User } = require("../../../models/Accountant_model/Acc_OrgModels");
const budgetMatch = require("../../../services/budgetCommitment.service");
/* The same Store/board/finance grant the intake door reads. Shared so
   "Store & Purchase" means one thing across both routers. */
const { resolveFulfilmentAccess } = require("../../../services/access/fulfilmentAccess");
const spendCreate = require("../../../services/spendRequestCreate.service");
const multer = require("multer");
const {
  uploadVoucherAttachment,
  streamVoucherAttachment,
} = require("../../../services/voucherDriveUpload.service");

/* ── WHERE A QUOTE ACTUALLY LIVES ────────────────────────────────────────────
 * The same private Drive folder the accountant's voucher attachments use, and
 * for the same reason: a supplier quote is the same class of document as a
 * purchase bill, and it must not be a link anybody with the URL can open. That
 * service never calls `permissions.create({ type: "anyone" })`; every download
 * is streamed back through an authenticated route below.
 *
 * Nothing touches disk — 20 MB in memory, then straight to Drive. Smaller than
 * the voucher route's 50 MB on purpose: this is a quote, not a scan of a
 * ledger, and the cap is the cheapest guard against somebody attaching a video. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const BLOCKED_MIME = [
  "application/x-msdownload",
  "application/x-executable",
  "application/x-sh",
  "application/x-bat",
  "application/x-msdos-program",
];

const ATTACHMENT_LABELS = ["quote", "proforma", "invoice", "screenshot", "other"];
const MAX_ATTACHMENTS = 10;

/* What a request may be RAISED as — two, not the three the schema still
   accepts. `SOFTWARE` loads and reads as Service; nothing new is created with
   it. See the note on the enum. */
const REQUEST_TYPES = SpendRequest.CURRENT_REQUEST_TYPES;
const REQUEST_TYPE_LABEL = SpendRequest.REQUEST_TYPE_LABEL;
const PRIORITIES = SpendRequest.PRIORITIES;

const text = (v, max = 500) => String(v ?? "").trim().slice(0, max);
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

/** The caller's own employee record — the only identity this router trusts. */
async function requester(req) {
  const biometricId = req.user?.employeeId;
  const byId = mongoose.isValidObjectId(req.user?.id) ? { _id: req.user.id } : null;
  return Employee.findOne(
    biometricId ? { $or: [{ biometricId }, { identityId: biometricId }] } : byId,
  )
    /* `identityId` as well as `biometricId`: an HR record may carry either,
       a CoWork session presents whichever its own doc uses, and reading only
       one leaves an identityId-only employee with no identity at all — no
       managed list, no self-approval guard, and a request stored against a
       blank requester id. */
    /* `accessDepartmentId` and `additionalDepartmentIds` are what
       resolveFulfilmentAccess reads. Without them the Store grant can never
       resolve on this router, and every Store action here is refused to the
       people who hold it. */
    .select(
      "_id firstName middleName lastName name email department biometricId identityId " +
        "primaryManager accessDepartmentId additionalDepartmentIds isActive status",
    )
    .lean();
}

/**
 * The books this request belongs to.
 *
 * One company today, and this asks rather than assumes: with several, a
 * department employee's session says nothing about which set of books their
 * spend belongs to, and picking the first would file it against whichever
 * happened to be created first. Refusing is the honest answer until somebody
 * decides the rule.
 */
async function theCompany() {
  const companies = await Acc_Company.find({}).select("_id companyName").limit(2).lean();
  if (companies.length === 1) return { company: companies[0], error: null };
  return {
    company: null,
    error: companies.length
      ? "More than one set of books exists, and a request cannot tell which it belongs to. Ask finance to configure this."
      : "No company is set up in the books yet. Ask finance to create one.",
  };
}

/**
 * The lines, checked and costed.
 *
 * Refuses with the line number and what is missing, because "invalid request"
 * on a form with six lines is a hunt. Every rule here is also enforced in the
 * form — this is the one that decides.
 */
function buildLines(raw) {
  if (!Array.isArray(raw) || !raw.length) {
    return { error: "Add at least one item or service." };
  }
  if (raw.length > 50) {
    return { error: "A request can have at most 50 lines. Split it." };
  }

  const lines = [];
  for (const [i, r] of raw.entries()) {
    const at = `Line ${i + 1}`;
    const name = text(r?.name, 200);
    const whyNeeded = text(r?.whyNeeded, 500);
    const unit = text(r?.unit, 40);
    const quantity = money(r?.quantity);
    const rate = money(r?.rate);

    if (!name) return { error: `${at}: name the item or service.` };
    if (!whyNeeded) return { error: `${at}: say why it is needed.` };
    if (quantity === null || quantity <= 0) return { error: `${at}: quantity must be more than 0.` };
    if (!unit) return { error: `${at}: add a unit.` };
    if (rate === null || rate <= 0) return { error: `${at}: rate must be more than 0.` };

    lines.push({
      name,
      whyNeeded,
      quantity,
      unit,
      rate,
      /* Never from the body. */
      amount: money(quantity * rate),
    });
  }

  const totalAmount = money(lines.reduce((sum, l) => sum + l.amount, 0));
  return { lines, totalAmount };
}

/**
 * WHO THE CALLER IS, FOR THE PURPOSES OF APPROVING.
 *
 * Two facts, both read rather than declared:
 *
 *   managedIds  who reports to them, from the org chart. It decides whether
 *               they are a TL at all, and — because it is their OWN people —
 *               which requests the TL step is theirs to take.
 *   isFinance   whether the books know them as an owner or an approver.
 *               Matched by email, which is the only thing a CMS employee and
 *               an accounts user share.
 *
 * An editor in the books is deliberately NOT finance here. Entering vouchers
 * is not the same as agreeing to spend, and the accounts module already draws
 * that line for its own writes.
 */
async function viewerOf(emp) {
  const [managedDocIds, accUser, fulfil] = await Promise.all([
    /* Takes a biometric id STRING and answers with Mongo _ids — passing the
       document returns nothing and comparing its answer to a biometric id
       matches nothing, which is how a TL's queue came back empty for requests
       that were sitting in it. */
    mrfApprover.listManagedEmployeeIds(emp?.biometricId || emp?.identityId).catch(() => []),
    emp?.email
      ? Acc_User.findOne({ email: String(emp.email).trim().toLowerCase() })
          .select("role isActive email")
          .lean()
          .catch(() => null)
      : null,
    resolveFulfilmentAccess(emp).catch(() => ({ allowed: false, via: null })),
  ]);
  /* Back into biometric ids, which is the identity everything else in this
     flow speaks — `requestedById`, `viewer.employeeId`, and MRF's own routing.
     One vocabulary end to end rather than two that have to be translated at
     every comparison. */
  const reports = (managedDocIds || []).length
    ? await Employee.find({ _id: { $in: managedDocIds } })
        .select("biometricId identityId")
        .lean()
    : [];
  const managedIds = reports
    .map((r) => r.biometricId || r.identityId)
    .filter(Boolean)
    .map(String);

  return {
    /* The same fallback the requester lookup and every id written onto a
       request use, so one person is one identity end to end. */
    employeeId: emp?.biometricId || emp?.identityId || "",
    managedIds,
    managesPeople: managedIds.length > 0,
    isFinance: accUser?.isActive !== false && chain.isFinanceApprover(accUser),
    /* Whether this person may act for Store. The same grant the intake door
       reads, so "Store & Purchase" means one thing across both routers rather
       than each deciding for itself. Finance counts too — they see every
       request that spends money anyway, and a confirmed quote stuck because
       the one store person is on leave is a quote somebody re-raises through
       a channel nobody is measuring. */
    canFulfil: Boolean(fulfil?.allowed) || (accUser?.isActive !== false && chain.isFinanceApprover(accUser)),
  };
}

/**
 * Attachment metadata, checked and re-stamped.
 *
 * The client sends what the upload endpoint gave it back. Everything that says
 * WHO is taken from the session regardless of what arrived — a client that can
 * name the uploader can name somebody else.
 */
function buildAttachments(raw, emp, who) {
  if (raw === undefined || raw === null) return { attachments: [] };
  if (!Array.isArray(raw)) return { error: "Attachments have to be a list." };
  if (raw.length > MAX_ATTACHMENTS) {
    return { error: `A request can carry at most ${MAX_ATTACHMENTS} attachments.` };
  }

  const attachments = [];
  for (const [i, a] of raw.entries()) {
    const at = `Attachment ${i + 1}`;
    const fileId = text(a?.fileId, 200);
    if (!fileId) return { error: `${at}: no file id — upload the file first.` };

    const size = Number(a?.fileSize);
    if (a?.fileSize !== undefined && (!Number.isFinite(size) || size < 0)) {
      return { error: `${at}: that file size cannot be read.` };
    }

    const label = String(a?.label || "other").toLowerCase();
    if (!ATTACHMENT_LABELS.includes(label)) {
      return { error: `${at}: "${label}" is not a kind of attachment.` };
    }

    attachments.push({
      fileId,
      fileName: text(a?.fileName, 300) || "attachment",
      fileType: text(a?.fileType, 120),
      fileSize: Number.isFinite(size) ? size : undefined,
      label,
      uploadedAt: new Date(),
      uploadedBy: emp._id,
      uploadedByName: who,
    });
  }
  return { attachments };
}

/**
 * May this person see this request, and therefore its quotes?
 *
 * The requester, whoever it is routed to, finance, and — once it is approved —
 * whoever raises the order against it. Deliberately NOT "any signed-in
 * employee": a quote carries a vendor, a price and terms, and the voucher
 * attachment route's own weakness is that it streams any file id to any
 * authenticated accountant. This one checks the request first and then that
 * the file is actually one of ITS attachments, so a guessed id gets nothing.
 */
function maySeeRequest(doc, emp, viewer) {
  if (String(doc.requestedBy) === String(emp._id)) return true;
  if (viewer.isFinance) return true;
  if (viewer.managedIds.map(String).includes(String(doc.requestedById))) return true;
  if (viewer.employeeId && chain.tlRouting.storedApproverIds(doc).includes(String(viewer.employeeId)))
    return true;
  /* Approved and waiting for an order — Store has to read the quote to raise
     the purchase order against it. */
  if (doc.status === chain.APPROVED || doc.status === chain.ORDERED) return true;
  return false;
}

/** What a screen is allowed to see. Deliberately not the raw document. */
const publicRequest = (r) => ({
  _id: String(r._id),
  requestNumber: r.requestNumber,
  title: r.title,
  requestType: r.requestType,
  /* Composed here so every screen says the same word about the same row — and
     so a legacy `SOFTWARE` reads as Service, which is what it always was. */
  requestTypeLabel: REQUEST_TYPE_LABEL[r.requestType] || "Service",
  requestedByName: r.requestedByName,
  department: r.department,
  ledgerId: r.ledgerId ? String(r.ledgerId) : null,
  ledgerName: r.ledgerName || null,
  vendorName: r.vendorName || null,
  gstin: r.gstin || null,
  neededBy: r.neededBy || null,
  priority: r.priority,
  purpose: r.purpose,
  items: (r.items || []).map((l) => ({
    _id: String(l._id),
    name: l.name,
    /* Null when the two are the same, so the card only draws the comparison
       where there is one to draw. */
    requestedName: l.requestedName && l.requestedName !== l.name ? l.requestedName : null,
    whyNeeded: l.whyNeeded,
    /* What Store actually found, so the requester is confirming the thing
       rather than a name and a number. */
    spec: l.spec || null,
    quantity: l.quantity,
    unit: l.unit,
    rate: l.rate,
    amount: l.amount,
    suggestedVendorName: l.suggestedVendorName || null,
    vendorName: l.vendorName || null,
    vendorNote: l.vendorNote || null,
    gstin: l.gstin || null,
    quoteRef: l.quoteRef || null,
    gstPercent: typeof l.gstPercent === "number" ? l.gstPercent : null,
    taxAmount: typeof l.taxAmount === "number" ? l.taxAmount : null,
    lineTotal: typeof l.lineTotal === "number" ? l.lineTotal : null,
    expectedDeliveryDate: l.expectedDeliveryDate || null,
    /* ── WHAT MAKES THE CONFIRMATION WORTH ANSWERING ─────────────────────
       "Sharma Systems, ₹50,000" is a claim; the quote beside it is the thing
       that lets somebody agree to it. Streamed through the authenticated
       route, so this carries the id rather than a URL. */
    attachments: (l.attachments || []).map((a) => ({
      fileId: a.fileId,
      fileName: a.fileName || "Attachment",
      fileType: a.fileType || null,
      fileSize: typeof a.fileSize === "number" ? a.fileSize : null,
      label: a.label || "quote",
      uploadedByName: a.uploadedByName || null,
    })),
    /* ── HAS STORE ACTUALLY PRICED THIS? ─────────────────────────────────
       Composed here, once, rather than each screen deciding for itself what
       "complete" means — the requester's card hides Confirm on the strength
       of it, and two implementations would eventually disagree about a line
       that has a rate but no vendor. */
    pricingComplete: Boolean(
      typeof l.rate === "number" && l.rate > 0 && String(l.vendorName || "").trim(),
    ),
    confirmedAt: l.confirmedAt || null,
    confirmedByName: l.confirmedByName || null,
    revisionRequested: Boolean(l.revisionRequested),
    revisionReason: l.revisionReason || null,
  })),
  totalAmount: r.totalAmount,
  status: r.status,
  /* The state in words, composed here so every screen says the same thing
     about the same status rather than each keeping its own map. */
  statusLabel: chain.STAGE_LABEL[r.status] || r.status,
  approverName: r.approverName || null,
  /* Why it routed the way it did, and the sentence to show when the chain
     broke. `RESOLVED` and an empty note on every ordinary request. */
  approverResolution: r.approverResolution || "RESOLVED",
  approverResolutionNote: r.approverResolutionNote || null,
  tlApprovedByName: r.tlApprovedByName || null,
  tlApprovedAt: r.tlApprovedAt || null,
  financeApprovedByName: r.financeApprovedByName || null,
  financeApprovedAt: r.financeApprovedAt || null,
  /* The budget answer travels WITH the request. The screen must not assemble
     it from a second call — two round trips is two moments, and the figure it
     showed would be from a different one than the status beside it. */
  unbudgetedHeadRequest: Boolean(r.unbudgetedHeadRequest),
  /* ── THE BUDGET EXCEPTION, WHEN THERE IS ONE ──────────────────────────────
     Read from the document rather than recomputed: the head moves as other
     requests commit against it, and the requester has to see the overrun
     finance actually objected to. `null` on every request that never had
     one, which is almost all of them. */
  /* Where this sits in the confirmation loop, so a card can render the right
     question without inferring it from the status string. */
  purchaseOrderNumber: r.purchaseOrderNumber || null,
  purchaseOrderId: r.purchaseOrderId ? String(r.purchaseOrderId) : null,
  requesterConfirmedAt: r.requesterConfirmedAt || null,
  requesterConfirmedByName: r.requesterConfirmedByName || null,
  revisionRequestedAt: r.revisionRequestedAt || null,
  revisionNote: r.revisionNote || null,
  awaitingConfirmation: r.status === chain.AWAITING_CONFIRMATION,
  confirmed: r.status === chain.CONFIRMED,
  budgetException: r.budgetExceptionAt
    ? {
        at: r.budgetExceptionAt,
        byName: r.budgetExceptionByName || "Finance",
        note: r.budgetExceptionNote || "",
        overrun: typeof r.budgetExceptionOverrun === "number" ? r.budgetExceptionOverrun : null,
        available:
          typeof r.budgetExceptionAvailable === "number" ? r.budgetExceptionAvailable : null,
        /* Answered already, and back with finance — the banner has to stop
           asking for a decision that has been made. */
        answered: r.status !== chain.BUDGET_EXCEPTION,
        askedForMore: Boolean(r.budgetAskAt),
      }
    : null,
  requestedHeadName: r.requestedHeadName || null,
  requestedHeadReason: r.requestedHeadReason || null,
  budgetMatchStatus: r.budgetMatchStatus || "no_budget_line",
  budgetFinancialYear: r.budgetFinancialYear || null,
  budgetDepartment: r.budgetDepartment || null,
  budgetSnapshot: r.budgetSnapshot || null,
  budgetApprovalKind: r.budgetApprovalKind || null,
  commitmentId: r.commitmentId ? String(r.commitmentId) : null,
  commitmentStatus: r.commitmentStatus || null,
  /* Metadata only — never a URL. Opening one goes through the authenticated
     route below, which checks the request before it checks the file. */
  attachments: (r.attachments || []).map((a) => ({
    fileId: a.fileId,
    fileName: a.fileName || "attachment",
    fileType: a.fileType || null,
    fileSize: a.fileSize ?? null,
    label: a.label || "other",
    uploadedAt: a.uploadedAt || null,
    uploadedByName: a.uploadedByName || null,
  })),
  attachmentCount: (r.attachments || []).length,
  /* Where it came from, and whether it comes back. Both absent on a request
     raised the older way, which is the truth about those. */
  intakeRequestId: r.intakeRequestId ? String(r.intakeRequestId) : null,
  recurring: r.recurring?.isRecurring
    ? {
        isRecurring: true,
        frequency: r.recurring.frequency || null,
        startsOn: r.recurring.startsOn || null,
        endsOn: r.recurring.endsOn || null,
        note: r.recurring.note || null,
      }
    : null,
  orderReference: r.orderReference || null,
  orderedByName: r.orderedByName || null,
  orderedAt: r.orderedAt || null,
  submittedAt: r.submittedAt || null,
  decidedAt: r.decidedAt || null,
  decisionNote: r.decisionNote || null,
  createdAt: r.createdAt,
});

/* ── THE HEADS THIS DEPARTMENT MAY SPEND AGAINST ─────────────────────────────
 * Not the chart of accounts. What finance already approved for THIS department
 * in the period that is running — usually two or three lines, each with what is
 * left on it. See approvedHeadsFor for why the whole chart was the wrong list.
 *
 * The same source the submit checks against, so the picker cannot offer a head
 * the server will then refuse. */
router.get("/budget-heads", async (req, res) => {
  try {
    const emp = await requester(req);
    if (!emp) return res.json({ success: true, heads: [], reason: "no_employee" });

    const { company, error } = await theCompany();
    if (error) return res.json({ success: true, heads: [], reason: "no_company", message: error });

    const { heads, reason } = await budgetMatch.approvedHeadsFor({
      companyId: company._id,
      department: emp.department || "",
    });
    res.json({
      success: true,
      heads,
      reason: heads.length ? null : reason,
      emptyMessage: heads.length
        ? null
        : "No approved budget heads for this department yet.",
      department: emp.department || null,
    });
  } catch (e) {
    console.error("[spend] budget-heads:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ── THE BUDGET CHECK, BEFORE ANYTHING IS RAISED ─────────────────────────────
 * What the form asks once a head and an amount are known, so somebody sees the
 * state of the envelope before they send rather than after. The same matcher
 * the submit uses, so the strip on the form and the snapshot on the request
 * cannot disagree.
 *
 * Read-only, and never a refusal: it reports, and the form submits regardless.
 * Whether spending past a head is allowed is finance's decision, not a form's. */
/* ══ QUOTES THE REQUESTER HAS CONFIRMED ═════════════════════════════════════
 * Store's own queue for the last step: the requester has agreed this is the
 * right item at an acceptable price, and it is within budget. All that is left
 * is to send it to finance.
 *
 * It is a separate queue from the fulfilment one on purpose. That one holds
 * requests nobody has priced; this holds priced quotes waiting on one click,
 * and mixing them would bury a five-second action under an hour's work.
 *
 * Declared above `/:id/...` so a literal path is never read as an id.
 */
router.get("/to-send", async (req, res) => {
  try {
    const emp = await requester(req);
    if (!emp) return res.json({ success: true, requests: [] });

    const viewer = await viewerOf(emp);
    if (!viewer.canFulfil) {
      return res.status(403).json({
        success: false,
        message: "Only Store & Purchase or finance can see confirmed quotes.",
      });
    }

    /* ── EVERYTHING STORE IS WAITING ON, WHATEVER SIDE OF THE ANSWER ────────
       Three states, because leaving any one of them out means a request Store
       classified simply disappears from their screen the moment it leaves
       their hands:
         AWAITING_CONFIRMATION  sent, no answer yet — nothing to do, but Store
                                 should be able to see it is still with them
         CONFIRMED               the requester agreed — ready to send to finance
         REVISION_REQUESTED      sent back — Store's move, and now requotable
       Sorted oldest-first within each state by the field that actually moved
       last for it, so a stale sort key never buries something new near the
       bottom. */
    const rows = await SpendRequest.find({
      status: { $in: [chain.AWAITING_CONFIRMATION, chain.CONFIRMED, chain.REVISION_REQUESTED] },
    })
      .sort({ updatedAt: 1 })
      .limit(100)
      .lean();

    res.json({ success: true, requests: rows.map(publicRequest) });
  } catch (e) {
    console.error("[spend] to-send:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ══ EVERYTHING STORE HAS EVER CLASSIFIED FROM AN INTAKE REQUEST ═══════════
 * The permanent record, as opposed to `/to-send`'s worklist.
 *
 * ── THE BUG THIS EXISTS TO FIX ──────────────────────────────────────────────
 * Classifying an intake request moves it out of `needs_classification`. That
 * dropped it out of `/fulfilment`, and nothing else in Store's queue ever
 * picked it back up — so the moment Store acted on a request, it vanished
 * from their screen entirely. A manufacturing order or a material request
 * never does this: it stays in the list with an updated status chip for as
 * long as it exists. This is the same rule applied to the one row type that
 * was missing it.
 *
 * ── WHY IT IS EVERY STATUS, NOT A FILTERED SLICE ────────────────────────────
 * `/to-send` deliberately narrows to the three states that are still Store's
 * move, because mixing "needs a click" with "settled, nothing to do" buries
 * the five-second actions under the rest. This is the opposite list on
 * purpose: the full history of what Store has done, however it turned out.
 */
router.get("/from-fulfilment", async (req, res) => {
  try {
    const emp = await requester(req);
    if (!emp) return res.json({ success: true, requests: [] });

    const viewer = await viewerOf(emp);
    if (!viewer.canFulfil) {
      return res.status(403).json({
        success: false,
        message: "Only Store & Purchase or finance can see this.",
      });
    }

    const rows = await SpendRequest.find({ intakeRequestId: { $exists: true, $ne: null } })
      .sort({ updatedAt: -1 })
      .limit(200)
      .lean();

    res.json({ success: true, requests: rows.map(publicRequest) });
  } catch (e) {
    console.error("[spend] from-fulfilment:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get("/budget-check", async (req, res) => {
  try {
    const emp = await requester(req);
    if (!emp) return res.json({ success: true, match: null });

    const { company, error } = await theCompany();
    if (error) return res.json({ success: true, match: null, message: error });

    const ledgerId = String(req.query.ledgerId || "");
    if (!ledgerId) return res.json({ success: true, match: null });

    const ledger = await Acc_Ledger.findOne({ _id: ledgerId, companyId: company._id })
      .select("_id name")
      .lean()
      .catch(() => null);
    if (!ledger) return res.json({ success: true, match: null });

    const match = await budgetMatch.matchFor({
      companyId: company._id,
      department: emp.department || "",
      ledgerId: ledger._id,
      ledgerName: ledger.name,
      amount: Number(req.query.amount) || 0,
    });

    res.json({ success: true, match });
  } catch (e) {
    console.error("[spend] budget-check:", e);
    /* A budget read that fails must not stop somebody asking for a repair —
       the strip simply says nothing. */
    res.json({ success: true, match: null });
  }
});

/* ── UPLOADING A QUOTE ───────────────────────────────────────────────────────
 * Stores the file and hands back metadata; it does not attach it to anything.
 * That is deliberate — the file is usually chosen before the request exists,
 * and a two-step upload means a failed submit does not lose it.
 *
 * The reply carries no URL, because there is no URL: the only way back to the
 * bytes is the authenticated stream below. */
router.post("/attachments", upload.single("file"), async (req, res) => {
  try {
    const emp = await requester(req);
    if (!emp) return res.status(404).json({ success: false, message: "Your staff record was not found." });
    if (!req.file) return res.status(400).json({ success: false, message: "No file was sent." });
    if (BLOCKED_MIME.includes(req.file.mimetype)) {
      return res.status(400).json({ success: false, message: "Executable files are not allowed." });
    }

    const stored = await uploadVoucherAttachment(req.file.buffer, {
      fileName: req.file.originalname || "attachment",
      mimeType: req.file.mimetype || "application/octet-stream",
    });

    res.json({
      success: true,
      attachment: {
        fileId: stored.fileId,
        fileName: stored.fileName || req.file.originalname || "attachment",
        fileType: stored.mimeType || req.file.mimetype || null,
        fileSize: req.file.size ?? null,
      },
    });
  } catch (e) {
    console.error("[spend] attachment upload:", e.message);
    res.status(500).json({
      success: false,
      message: "The file could not be stored. Check the Drive credentials, or try again.",
    });
  }
});

/* Adding one to a request that is already in — the requester while it is still
   waiting, or finance while they are reviewing it. Not once it is decided:
   after that the file would be evidence for a decision already taken. */
router.post("/:id/attachments", async (req, res) => {
  try {
    const emp = await requester(req);
    if (!emp) return res.status(404).json({ success: false, message: "Your staff record was not found." });

    const doc = await SpendRequest.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: "Request not found." });

    const viewer = await viewerOf(emp);
    const mine = String(doc.requestedBy) === String(emp._id);
    if (!mine && !viewer.isFinance) {
      return res.status(403).json({
        success: false,
        message: "Only the person who raised this, or finance, can add proof to it.",
      });
    }
    if (!chain.OPEN_STATUSES.includes(doc.status)) {
      return res.status(409).json({
        success: false,
        message: `This request is ${chain.STAGE_LABEL[doc.status] || doc.status}; proof cannot be added now.`,
      });
    }

    const who = mrfApprover.buildFullName(emp);
    const built = buildAttachments([req.body?.attachment || req.body], emp, who);
    if (built.error) return res.status(400).json({ success: false, message: built.error });
    if ((doc.attachments || []).length + built.attachments.length > MAX_ATTACHMENTS) {
      return res.status(400).json({
        success: false,
        message: `A request can carry at most ${MAX_ATTACHMENTS} attachments.`,
      });
    }

    doc.attachments.push(...built.attachments);
    doc.history.push({
      at: new Date(), by: emp._id, byName: who,
      action: "attachment added", note: built.attachments[0].fileName,
    });
    await doc.save();

    res.json({ success: true, request: publicRequest(doc.toObject()) });
  } catch (e) {
    console.error("[spend] add attachment:", e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ── OPENING ONE ─────────────────────────────────────────────────────────────
 * The request is checked BEFORE the file, and then that the file is actually
 * one of that request's attachments. A file id on its own opens nothing — a
 * quote carries a vendor, a price and terms, and a route that streamed any id
 * to any signed-in employee would be a directory of the company's suppliers. */
router.get("/:id/attachments/:fileId", async (req, res) => {
  try {
    const emp = await requester(req);
    if (!emp) return res.status(404).json({ success: false, message: "Your staff record was not found." });

    const doc = await SpendRequest.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ success: false, message: "Request not found." });

    const viewer = await viewerOf(emp);
    if (!maySeeRequest(doc, emp, viewer)) {
      return res.status(403).json({ success: false, message: "That is not your request." });
    }

    /* Document-level first, then the LINES. A quote now hangs off the line it
       priced — one vendor per line means one quote per line — and a reader
       that only knew about the document's own list would 404 on every file
       Store attached. */
    const found =
      (doc.attachments || []).find((a) => a.fileId === req.params.fileId) ||
      (doc.items || [])
        .flatMap((l) => l.attachments || [])
        .find((a) => a.fileId === req.params.fileId);
    if (!found) {
      /* Not "forbidden" — as far as this request is concerned it does not
         exist, and saying otherwise would confirm that some other request has
         it. */
      return res.status(404).json({ success: false, message: "No such attachment on this request." });
    }

    const { stream, meta } = await streamVoucherAttachment(found.fileId);
    const safeName = String(found.fileName || meta.name || "attachment").replace(/["\r\n]/g, "");
    res.setHeader("Content-Type", meta.mimeType || found.fileType || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${safeName}"`);
    if (meta.size) res.setHeader("Content-Length", meta.size);

    stream.on("error", (err) => {
      console.error("[spend] attachment stream:", err.message);
      if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
      else res.end();
    });
    stream.pipe(res);
  } catch (e) {
    console.error("[spend] attachment open:", e.message);
    if (!res.headersSent) res.status(500).json({ success: false, message: e.message });
  }
});

/* ── MY REQUESTS ─────────────────────────────────────────────────────────── */
router.get("/", async (req, res) => {
  try {
    const emp = await requester(req);
    if (!emp) return res.json({ success: true, requests: [] });

    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const filter = { requestedBy: emp._id };
    if (req.query.status) filter.status = String(req.query.status);

    const rows = await SpendRequest.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ success: true, requests: rows.map(publicRequest) });
  } catch (e) {
    console.error("[spend] list:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ── RAISE ONE ───────────────────────────────────────────────────────────── */
router.post("/", async (req, res) => {
  try {
    const emp = await requester(req);
    if (!emp) {
      return res.status(404).json({
        success: false,
        message: "Your staff record was not found. Ask HR to check it.",
      });
    }

    const b = req.body || {};
    const title = text(b.title, 200);
    const purpose = text(b.purpose, 1000);
    const requestType = String(b.requestType || "").toUpperCase();

    if (!title) return res.status(400).json({ success: false, message: "Give the request a title." });
    if (!REQUEST_TYPES.includes(requestType)) {
      return res.status(400).json({
        success: false,
        message: "Choose whether this is a product or a service.",
      });
    }
    if (!purpose) {
      return res.status(400).json({ success: false, message: "Say what this is for." });
    }

    const { lines, totalAmount, error } = buildLines(b.items);
    if (error) return res.status(400).json({ success: false, message: error });

    const { company, error: companyError } = await theCompany();
    if (companyError) return res.status(409).json({ success: false, message: companyError });

    /* ── WHICH HEAD, AND WHETHER THEY MAY USE IT ────────────────────────────
       Two ways a request may name what it will be charged to, and the server
       decides which one this is — never the form.

       1 · an approved budget head for THIS department. Checked against the
           same list the picker was built from, so a ledger id typed into the
           payload by hand cannot buy access to another department's envelope
           or to a head nobody budgeted.

       2 · a request FOR a head that does not exist yet, in words. A genuinely
           new kind of spend has no line, and refusing it would send that
           spending somewhere nobody is measuring — so it is allowed, and it
           arrives marked as unbudgeted rather than dressed up as a budgeted
           ask against an arbitrary ledger. */
    const asksForNewHead = b.unbudgetedHead === true;

    let ledger = null;
    let approvedHead = null;
    let requestedHeadName = "";
    let requestedHeadReason = "";

    if (asksForNewHead) {
      requestedHeadName = text(b.requestedHeadName, 200);
      requestedHeadReason = text(b.requestedHeadReason, 1000);
      if (!requestedHeadName) {
        return res.status(400).json({
          success: false,
          message: "Name the head you need — what should this spend be called?",
        });
      }
      if (!requestedHeadReason) {
        return res.status(400).json({
          success: false,
          message: "Say why none of your approved budget heads fit.",
        });
      }
    } else {
      if (!b.ledgerId) {
        return res.status(400).json({
          success: false,
          message: "Choose the account head this spend belongs to.",
        });
      }

      const { heads } = await budgetMatch.approvedHeadsFor({
        companyId: company._id,
        department: emp.department || "",
      });
      approvedHead = heads.find((h) => String(h.ledgerId) === String(b.ledgerId)) || null;

      if (!approvedHead) {
        /* Deliberately not "invalid ledger": the head may well exist and be
           perfectly real — it is simply not one this department has an
           approved budget for, and the way to spend against it is to ask for
           it rather than to select it. */
        return res.status(400).json({
          success: false,
          code: "HEAD_NOT_APPROVED",
          /* The same opening sentence the intake door refuses with. One rule
             refused in two wordings reads as two rules, and this is the one a
             person is most likely to quote when they ask why. */
          message:
            "That budget head is not in this department's approved budget. Use one of your approved heads, or request another head.",
        });
      }

      ledger = await Acc_Ledger.findOne({ _id: b.ledgerId, companyId: company._id })
        .select("_id name")
        .lean();
      if (!ledger) {
        return res.status(400).json({ success: false, message: "That account head is not in the books." });
      }
    }

    const priority = PRIORITIES.includes(String(b.priority || "").toUpperCase())
      ? String(b.priority).toUpperCase()
      : "NORMAL";

    const neededBy = b.neededBy ? new Date(b.neededBy) : null;
    if (neededBy && Number.isNaN(neededBy.getTime())) {
      return res.status(400).json({ success: false, message: "That needed-by date cannot be read." });
    }

    /* ── WHO IT WAITS ON ────────────────────────────────────────────────────
       The same org-chart resolver MRF uses, for the one thing it is asked
       here: who this person's manager is. Its ROUTING answer is deliberately
       ignored — "sent directly to the Store" is an MRF outcome and means
       nothing for a repair — so when the chart cannot name a manager the
       approver is simply left blank. Blank means nobody is named yet, which is
       the truth; finance routing lands in the next chunk. */
    let approver = {
      approverEmployee: null,
      approverName: "",
      approverBiometricId: "",
      approverAltIds: [],
      approverResolution: "NO_MANAGER",
      approverResolutionNote: "",
    };
    try {
      approver = await mrfApprover.approverPatchFor(emp, { fallbackTo: "finance" });
    } catch (e) {
      console.error("[spend] approver resolution failed, leaving it unassigned:", e.message);
      approver.approverResolutionNote =
        "Your Primary Manager could not be looked up — sent to finance according to the fallback rule.";
    }

    const viewer = await viewerOf(emp);
    const now = new Date();
    const fullName = mrfApprover.buildFullName(emp);

    /* Optional. A repair often needs approving before a vendor will quote it,
       and demanding proof up front only teaches people to attach something
       meaningless. */
    const built = buildAttachments(b.attachments, emp, fullName);
    if (built.error) return res.status(400).json({ success: false, message: built.error });
    const attachments = built.attachments;

    /* Which envelope this asks to use, where it starts, and the row itself —
       all of it in the service the classification path also calls, so a
       request raised on this form and one classified out of the unified intake
       cannot match budget differently. See spendRequestCreate.service. */
    const { request: created } = await spendCreate.createSpendRequest({
      emp,
      actorName: fullName,
      company,
      title,
      purpose,
      requestType,
      priority,
      neededBy,
      vendorName: text(b.vendorName, 200),
      gstin: text(b.gstin, 20),
      lines,
      totalAmount,
      ledger,
      asksForNewHead,
      requestedHeadName,
      requestedHeadReason,
      attachments,
      approver,
      /* Where it starts: an ordinary employee's waits for their TL, a TL's own
         goes straight to finance, and one with no TL to wait for does too —
         see spendApproval.service. */
      startAt: chain.startingStatus({
        managesPeople: viewer.managesPeople,
        hasApprover: !!approver.approverEmployee,
      }),
      now,
    });

    res.status(201).json({ success: true, request: publicRequest(created.toObject()) });
  } catch (e) {
    console.error("[spend] create:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ── WAITING ON ME ───────────────────────────────────────────────────────────
 * One queue, not two. A TL sees their own people's requests at the TL step; a
 * finance approver sees everything at the finance step; somebody who is both
 * sees both, and the card says which step each is at. Splitting them into two
 * endpoints would have meant the screen asking twice and guessing which answer
 * to show when a person wears both hats. */
router.get("/approvals", async (req, res) => {
  try {
    const emp = await requester(req);
    if (!emp) return res.json({ success: true, requests: [], counts: { tl: 0, finance: 0 } });
    const viewer = await viewerOf(emp);

    const or = [];
    /* The TL step is only for requests ADDRESSED to this person — the manager
       stored when the request was raised. Requests that named nobody (the
       legacy rows) fall back to the live reporting line, and only for this
       person's own reports. One rule, shared with the intake desk and MRF. */
    const tlClause = chain.tlRouting.tlQueueClause({
      viewer,
      statuses: [chain.PENDING_TL, chain.LEGACY_SUBMITTED],
    });
    if (tlClause) or.push(tlClause);
    if (viewer.isFinance) or.push({ status: chain.PENDING_FINANCE });
    if (!or.length) return res.json({ success: true, requests: [], counts: { tl: 0, finance: 0 } });

    /* Never your own, at any step — the rule the decision itself enforces,
       applied to the LIST too so a request you cannot action never appears in
       a queue that says it is waiting for you. */
    const rows = await SpendRequest.find({ $or: or, requestedById: { $ne: viewer.employeeId || "—" } })
      .sort({ createdAt: 1 })
      .limit(100)
      .lean();

    const requests = rows.map((r) => ({
      ...publicRequest(r),
      requestedById: r.requestedById,
      /* Which step this person's yes would be, so the card can say so. */
      step: chain.decisionFor({ request: r, viewer }).step,
    }));

    res.json({
      success: true,
      requests,
      counts: {
        tl: requests.filter((r) => r.step === "tl").length,
        finance: requests.filter((r) => r.step === "finance").length,
      },
    });
  } catch (e) {
    console.error("[spend] approvals:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/** Approve or reject — one handler, because the entitlement question is the
 *  same one and only the outcome differs. */
async function decide(req, res, outcome) {
  const emp = await requester(req);
  if (!emp) return res.status(404).json({ success: false, message: "Your staff record was not found." });

  const doc = await SpendRequest.findById(req.params.id);
  if (!doc) return res.status(404).json({ success: false, message: "Request not found." });

  const viewer = await viewerOf(emp);
  const verdict = chain.decisionFor({ request: doc, viewer });
  if (!verdict.can) return res.status(403).json({ success: false, message: verdict.reason });

  const note = text(req.body?.note, 500);
  const who = mrfApprover.buildFullName(emp);

  /* ── THE FINANCE STEP IS SHARED WITH THE BOOKS ──────────────────────────
     Payables → Spend approvals answers the same question from the accounting
     side, and approving is the moment money is promised: it writes a budget
     commitment. A commitment written one way here and another way there is a
     number nobody can reconcile, so the rule lives in one service and both
     doors call it. See services/spendFinanceDecision.service.js.

     The TL step stays here. It is a different question asked by a different
     person, and the books have no business answering it. */
  if (verdict.step === "finance") {
    const r = await financeDecision.decide({
      request: doc,
      actor: { id: emp._id, email: emp.email, name: who },
      outcome,
      note,
      expectedPaymentDate: req.body?.expectedPaymentDate || null,
    });
    if (!r.ok) {
      return res.status(r.status).json({ success: false, code: r.code, message: r.message });
    }
    return res.json({ success: true, request: publicRequest(doc.toObject()) });
  }

  /* ── THE TL STEP ────────────────────────────────────────────────────────
     Does this department actually need it. Answerable without a price, which
     is why it is not gated on one — blocking a TL behind a figure they are
     not the ones to supply would stall every request behind it. */
  if (outcome === "rejected" && !note) {
    return res.status(400).json({ success: false, message: "Say why you are rejecting it." });
  }

  const now = new Date();
  if (outcome === "rejected") {
    doc.status = chain.REJECTED;
    doc.decidedAt = now;
    doc.decidedBy = emp._id;
    doc.decidedByName = who;
    doc.decisionNote = note;
  } else {
    doc.tlApprovedBy = emp._id;
    doc.tlApprovedByName = who;
    doc.tlApprovedAt = now;
    doc.status = chain.statusAfter("tl");
  }

  doc.history.push({
    at: now,
    by: emp._id,
    byName: who,
    action: outcome === "rejected" ? `rejected at ${verdict.step}` : `approved at ${verdict.step}`,
    note,
  });
  await doc.save();

  res.json({ success: true, request: publicRequest(doc.toObject()) });
}

router.patch("/:id/approve", async (req, res) => {
  try {
    await decide(req, res, "approved");
  } catch (e) {
    console.error("[spend] approve:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

router.patch("/:id/reject", async (req, res) => {
  try {
    await decide(req, res, "rejected");
  } catch (e) {
    console.error("[spend] reject:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ── WHEN THE MONEY IS EXPECTED TO LEAVE ─────────────────────────────────────
 * Finance setting, or correcting, the payment date on a commitment already
 * made. This is what makes the forecast's "some approved requests have no
 * payment date" notice actionable rather than a dead end.
 *
 * Finance only: it is a cash-flow figure, and the department that raised the
 * request has no view of the company's terms with the vendor. */
router.patch("/:id/expected-payment-date", async (req, res) => {
  try {
    const emp = await requester(req);
    if (!emp) return res.status(404).json({ success: false, message: "Your staff record was not found." });

    const viewer = await viewerOf(emp);
    if (!viewer.isFinance) {
      return res.status(403).json({
        success: false,
        message: "Only finance can set when a committed spend is expected to be paid.",
      });
    }

    const doc = await SpendRequest.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: "Request not found." });
    if (!doc.commitmentId) {
      return res.status(409).json({
        success: false,
        message: "This request has no commitment yet — approve it first.",
      });
    }

    const raw = req.body?.expectedPaymentDate;
    const when = raw ? new Date(raw) : null;
    if (raw && Number.isNaN(when?.getTime())) {
      return res.status(400).json({ success: false, message: "That date cannot be read." });
    }

    const Commitment = require("../../../models/Accountant_model/Acc_BudgetCommitment");
    const commitment = await Commitment.findById(doc.commitmentId);
    if (!commitment) {
      return res.status(404).json({ success: false, message: "That commitment no longer exists." });
    }
    if (commitment.status === "released") {
      return res.status(409).json({
        success: false,
        message: "This commitment has already been replaced by a voucher.",
      });
    }

    commitment.expectedPaymentDate = when || undefined;
    await commitment.save();

    doc.history.push({
      at: new Date(), by: emp._id, byName: mrfApprover.buildFullName(emp),
      action: "expected payment date set",
      note: when ? when.toISOString().slice(0, 10) : "cleared",
    });
    await doc.save();

    res.json({ success: true, expectedPaymentDate: commitment.expectedPaymentDate || null });
  } catch (e) {
    console.error("[spend] expected payment date:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ── STORE & PURCHASE ────────────────────────────────────────────────────────
 * What has been agreed and is waiting for an order to be raised against it.
 *
 * Store is not an approval step: by the time a request lands here the TL and
 * finance have both said yes, and asking a third person to agree would make
 * the two decisions above provisional. They raise the PO or the WO and record
 * the reference, which is what closes the loop for the requester. */
router.get("/purchasing", async (req, res) => {
  try {
    const rows = await SpendRequest.find({ status: chain.APPROVED })
      .sort({ neededBy: 1, createdAt: 1 })
      .limit(100)
      .lean();
    res.json({ success: true, requests: rows.map(publicRequest) });
  } catch (e) {
    console.error("[spend] purchasing:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ══ ONE SPEND REQUEST, ACROSS ITS WHOLE LIFECYCLE ══════════════════════════
 * `/to-send` and `/from-fulfilment` are both lists shaped for a particular
 * moment; a detail page needs one document regardless of which list it came
 * from, and needs it to keep working as the document moves through states
 * neither list covers (budget exception, with finance, approved, ordered).
 *
 * Visible to whoever fulfils, whoever answers the finance step, and the
 * person who asked for it — the same three audiences `publicRequest` already
 * assumes when it withholds nothing beyond what those readers may see.
 *
 * ── WHY IT IS DECLARED LAST AMONG THE GET ROUTES ────────────────────────────
 * `/:id` matches ANY single path segment — including "approvals", "purchasing"
 * and every other literal GET on this router. Express resolves routes in
 * DECLARATION order, so this has to come after every one of them or it
 * silently swallows their traffic: a request for `/approvals` would be read
 * as `id = "approvals"`, fail the ObjectId check, and 404 — breaking a working
 * endpoint with no error anywhere that says why.
 */
router.get("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ success: false, message: "Request not found." });
    }
    const emp = await requester(req);
    if (!emp) return res.status(404).json({ success: false, message: "Your staff record was not found." });

    const doc = await SpendRequest.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ success: false, message: "Request not found." });

    const viewer = await viewerOf(emp);
    const mine = String(doc.requestedBy) === String(emp._id);
    if (!mine && !viewer.canFulfil && !viewer.isFinance) {
      return res.status(403).json({ success: false, message: "That is not your request." });
    }

    res.json({ success: true, request: publicRequest(doc) });
  } catch (e) {
    console.error("[spend] get one:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});


/* ══ TURN AN APPROVED QUOTE INTO A PURCHASE ORDER ═══════════════════════════
 * The last step, and the one the chain was missing a join for.
 *
 * ── WHY IT IS A CONVERSION AND NOT A NEW FORM ───────────────────────────────
 * Everything a purchase order needs has already been agreed: the vendor Store
 * chose, the rate they were quoted, the tax, the delivery date the requester
 * confirmed, and the figure finance committed. Re-typing that into a blank PO
 * form is an invitation to type it differently — and the order that goes to
 * the vendor would then be a document nobody approved.
 *
 * So the PO is BUILT from the approval, and carries `spendRequestId` back to
 * it. That link is what makes "was this order approved?" answerable at all;
 * before it, a purchase order had no upstream and the question could only be
 * settled by somebody remembering.
 *
 * ── THE GUARD THAT WAS PREVIOUSLY IMPOSSIBLE ────────────────────────────────
 * "A PO cannot be created before finance approval" had nothing to attach to
 * while the two collections were unrelated. It attaches here: this is the only
 * door that produces a linked order, and it refuses anything that is not
 * approved. Orders typed directly into the PO module are unaffected and remain
 * unlinked — that is a separate door and closing it is a separate decision.
 */
router.post("/:id/purchase-order", async (req, res) => {
  try {
    const emp = await requester(req);
    if (!emp) return res.status(404).json({ success: false, message: "Your staff record was not found." });

    const doc = await SpendRequest.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: "Request not found." });

    const viewer = await viewerOf(emp);
    if (!viewer.canFulfil) {
      return res.status(403).json({
        success: false,
        message: "Only Store & Purchase can raise a purchase order.",
      });
    }

    /* ── APPROVED, AND ONLY APPROVED ─────────────────────────────────────
       Not "confirmed", not "with finance". The money has to have been agreed
       before anything is ordered from a vendor. */
    if (doc.status !== chain.APPROVED) {
      return res.status(409).json({
        success: false,
        message:
          doc.status === chain.ORDERED
            ? `${doc.purchaseOrderNumber || "An order"} has already been raised for this.`
            : `This request is ${chain.STAGE_LABEL[doc.status] || doc.status} — a purchase order can only be raised against an approved one.`,
      });
    }
    /* Belt and braces: the link is what makes a second order detectable even
       if the status were moved by hand. */
    if (doc.purchaseOrderId) {
      return res.status(409).json({
        success: false,
        message: `${doc.purchaseOrderNumber || "An order"} has already been raised for this.`,
      });
    }

    const PurchaseOrder = require("../../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
    const Vendor = require("../../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");

    /* ── THE VENDOR, WHERE STORE PICKED ONE OFF THE BOOKS ─────────────────
       Lines carry `vendorId` when the supplier was chosen rather than typed.
       Several lines could name several suppliers; a purchase order is one
       document to one vendor, so a request spanning two is refused rather than
       silently ordered from whichever line came first. */
    const vendorNames = [...new Set((doc.items || []).map((l) => (l.vendorName || "").trim()).filter(Boolean))];
    if (vendorNames.length > 1) {
      return res.status(400).json({
        success: false,
        message: `This quote names ${vendorNames.length} suppliers (${vendorNames.join(", ")}). A purchase order goes to one — raise it in the purchase-order module, or split the request.`,
      });
    }
    const vendorName = vendorNames[0] || doc.vendorName || "";
    const vendorId =
      (doc.items || []).map((l) => l.vendorId).find(Boolean) ||
      (vendorName
        ? (await Vendor.findOne({ companyName: vendorName }).select("_id").lean().catch(() => null))?._id
        : null) ||
      null;

    /* ── THE LINES, AS AGREED ─────────────────────────────────────────────
       Quantity and rate straight off the approved quote. Nothing is recomputed
       from a body: the figure finance committed is the figure ordered. */
    const items = (doc.items || []).map((l) => ({
      rawItem: l.rawItemId || undefined,
      itemName: l.name,
      unit: l.unit || "unit",
      quantity: Number(l.quantity) || 0,
      unitPrice: Number(l.rate) || 0,
      totalPrice: Math.round((Number(l.quantity) || 0) * (Number(l.rate) || 0) * 100) / 100,
      pendingQuantity: Number(l.quantity) || 0,
      expectedDeliveryDate: l.expectedDeliveryDate || doc.expectedDeliveryDate || null,
    }));
    if (!items.length) {
      return res.status(400).json({ success: false, message: "This request has no lines to order." });
    }

    const subtotal = Math.round(items.reduce((t, i) => t + i.totalPrice, 0) * 100) / 100;
    const taxAmount = Math.round((Number(doc.taxAmount) || 0) * 100) / 100;

    /* Same generator the purchase-order module uses, so an order raised here
       is indistinguishable in the register from one raised there. */
    const poNumber = await (async () => {
      for (let i = 0; i < 8; i += 1) {
        const n = `PO${String(new Date().getFullYear()).slice(-2)}${String(new Date().getMonth() + 1).padStart(2, "0")}${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`;
        if (!(await PurchaseOrder.exists({ poNumber: n }))) return n;
      }
      return null;
    })();
    if (!poNumber) {
      return res.status(500).json({ success: false, message: "Could not allocate a PO number. Try again." });
    }

    const po = await PurchaseOrder.create({
      spendRequestId: doc._id,
      spendRequestNumber: doc.requestNumber,
      poNumber,
      vendor: vendorId || undefined,
      vendorName,
      orderDate: new Date(),
      expectedDeliveryDate: items[0].expectedDeliveryDate || null,
      items,
      subtotal,
      taxRate: Number(doc.gstPercent) || 0,
      taxAmount,
      totalAmount: Math.round((subtotal + taxAmount) * 100) / 100,
      totalPending: items.reduce((t, i) => t + i.quantity, 0),
      /* DRAFT, not ISSUED. Approving the money is not the same as sending the
         order — somebody in Store still reads it and sends it, and that is the
         purchase-order module's own step. */
      status: "DRAFT",
      notes: [doc.purpose, doc.items?.[0]?.quoteRef ? `Quote ${doc.items[0].quoteRef}` : ""]
        .filter(Boolean)
        .join(" · "),
      createdBy: emp._id,
    });

    const now = new Date();
    const who = mrfApprover.buildFullName(emp);
    doc.status = chain.ORDERED;
    doc.purchaseOrderId = po._id;
    doc.purchaseOrderNumber = po.poNumber;
    doc.orderReference = po.poNumber;
    doc.history.push({
      at: now, by: emp._id, byName: who,
      action: `raised purchase order ${po.poNumber}`,
      note: vendorName ? `To ${vendorName}` : "",
    });
    await doc.save();

    res.status(201).json({
      success: true,
      request: publicRequest(doc.toObject()),
      purchaseOrder: {
        _id: String(po._id),
        poNumber: po.poNumber,
        vendorName: po.vendorName,
        totalAmount: po.totalAmount,
        status: po.status,
      },
      message: `${po.poNumber} raised for ${vendorName || "the vendor"}.`,
    });
  } catch (e) {
    console.error("[spend] purchase-order:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

router.patch("/:id/ordered", async (req, res) => {
  try {
    const emp = await requester(req);
    if (!emp) return res.status(404).json({ success: false, message: "Your staff record was not found." });

    const doc = await SpendRequest.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: "Request not found." });
    if (doc.status !== chain.APPROVED) {
      return res.status(409).json({
        success: false,
        message: `This request is ${chain.STAGE_LABEL[doc.status] || doc.status} — an order can only be raised against an approved one.`,
      });
    }

    const reference = text(req.body?.reference, 100);
    if (!reference) {
      return res.status(400).json({
        success: false,
        message: "Give the purchase or work order number you raised.",
      });
    }

    const now = new Date();
    doc.status = chain.ORDERED;
    doc.orderReference = reference;
    doc.orderedBy = emp._id;
    doc.orderedByName = mrfApprover.buildFullName(emp);
    doc.orderedAt = now;
    doc.history.push({
      at: now, by: emp._id, byName: doc.orderedByName,
      action: "ordered", note: reference,
    });
    await doc.save();

    res.json({ success: true, request: publicRequest(doc.toObject()) });
  } catch (e) {
    console.error("[spend] ordered:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ── WITHDRAW ────────────────────────────────────────────────────────────── */
/* ══ IS THIS WHAT YOU MEANT? ════════════════════════════════════════════════
 * The requester checks what Store actually found, line by line, before
 * anybody approves money against it.
 *
 * ── THE FAILURE THIS EXISTS FOR ─────────────────────────────────────────────
 * "A mouse, the good one" can be sourced perfectly competently as the wrong
 * model, from a vendor with a six-week lead time, at a price the requester
 * would never have asked for. Finance approves it because the FIGURE fits the
 * head — they are not equipped to notice, and it is not their job to. By the
 * time the wrong thing arrives the money is committed.
 *
 * ── WHY IT IS LINE BY LINE ──────────────────────────────────────────────────
 * One line of a quote can be exactly right while another is wrong. Confirming
 * the whole request as one would force somebody to reject a line they are
 * happy with in order to object to a line they are not, and Store would then
 * requote both.
 *
 * ── AND WHY THE BUDGET IS CHECKED HERE ──────────────────────────────────────
 * This is the first moment a real figure exists AND the person who owns the
 * head has seen it. Earlier would test the requester's guess; later means
 * finance is the first to notice, by which point the requester has agreed to
 * something they cannot have.
 */
router.patch("/:id/confirm", async (req, res) => {
  try {
    const emp = await requester(req);
    if (!emp) return res.status(404).json({ success: false, message: "Your staff record was not found." });

    const doc = await SpendRequest.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: "Request not found." });

    if (String(doc.requestedBy) !== String(emp._id)) {
      return res.status(403).json({
        success: false,
        message: "Only the person who asked for this can say whether it is what they meant.",
      });
    }
    if (doc.status !== chain.AWAITING_CONFIRMATION) {
      return res.status(409).json({
        success: false,
        message: `This request is ${chain.STAGE_LABEL[doc.status] || doc.status}, so there is nothing to confirm.`,
      });
    }

    const posted = req.body?.lines && typeof req.body.lines === "object" ? req.body.lines : null;
    if (!posted) {
      return res.status(400).json({
        success: false,
        message: "Say which lines you are confirming.",
      });
    }

    const now = new Date();
    const who = mrfApprover.buildFullName(emp);
    const sendBack = [];

    for (const [i, l] of (doc.items || []).entries()) {
      const spec = posted[String(l._id)] ?? posted[String(i)] ?? null;
      if (!spec) {
        return res.status(400).json({
          success: false,
          message: `${l.name}: say whether this is what you meant.`,
        });
      }

      if (spec.revise) {
        const why = String(spec.reason || "").trim().slice(0, 500);
        if (!why) {
          return res.status(400).json({
            success: false,
            message: `${l.name}: tell Store what is wrong with it, or they will send back the same thing.`,
          });
        }
        l.revisionRequested = true;
        l.revisionReason = why;
        l.confirmedAt = undefined;
        l.confirmedByName = undefined;
        sendBack.push(`${l.name}: ${why}`);
      } else {
        l.revisionRequested = false;
        l.revisionReason = undefined;
        l.confirmedAt = now;
        l.confirmedByName = who;
      }
    }

    /* ── ONE LINE SENT BACK SENDS THE QUOTE BACK ────────────────────────────
       Store requotes the objected lines; the confirmed ones keep their
       confirmation and are not asked about again. */
    if (sendBack.length) {
      doc.status = chain.REVISION_REQUESTED;
      doc.revisionRequestedAt = now;
      doc.revisionNote = sendBack.join(" · ");
      doc.requesterConfirmedAt = undefined;
      doc.requesterConfirmedByName = undefined;
      doc.history.push({
        at: now, by: emp._id, byName: who,
        action: "asked Store to look again",
        note: doc.revisionNote,
      });
      await doc.save();
      return res.json({
        success: true,
        request: publicRequest(doc.toObject()),
        message: `${doc.requestNumber} is back with Store.`,
      });
    }

    doc.requesterConfirmedAt = now;
    doc.requesterConfirmedByName = who;
    doc.revisionRequestedAt = undefined;
    doc.revisionNote = undefined;

    /* ── AND NOW, DOES IT FIT? ──────────────────────────────────────────────
       Against the head the requester chose, at the figure Store actually
       quoted. Over budget stops here rather than travelling to finance to be
       refused: the requester has three things they can do about it and
       finance has none. */
    let overrun = null;
    let available = null;
    if (doc.ledgerId && doc.companyId) {
      const { heads } = await budgetMatch
        .approvedHeadsFor({
          companyId: doc.companyId,
          department: doc.budgetDepartment || doc.department || "",
        })
        .catch(() => ({ heads: [] }));
      const head = (heads || []).find((h) => String(h.ledgerId) === String(doc.ledgerId));
      if (head) {
        available = head.available;
        const wanted = Number(doc.grandTotal || doc.totalAmount) || 0;
        if (wanted > head.available) {
          overrun = Math.round((wanted - head.available) * 100) / 100;
        }
      }
    }

    if (overrun !== null) {
      doc.status = chain.BUDGET_EXCEPTION;
      doc.budgetExceptionAt = now;
      doc.budgetExceptionByName = "Budget check";
      doc.budgetExceptionNote =
        "The quote you confirmed is more than the head has left. Reduce it, ask for additional budget, or withdraw it.";
      doc.budgetExceptionOverrun = overrun;
      doc.budgetExceptionAvailable = available;
      doc.history.push({
        at: now, by: emp._id, byName: who,
        action: "confirmed — and it is over budget",
        note: doc.budgetExceptionNote,
      });
      await doc.save();
      return res.json({
        success: true,
        request: publicRequest(doc.toObject()),
        message: "You confirmed it, but it is over the head's remaining budget.",
      });
    }

    doc.status = chain.CONFIRMED;
    doc.history.push({
      at: now, by: emp._id, byName: who,
      action: "confirmed this is the right item and vendor",
      note: String(req.body?.note || "").trim().slice(0, 500),
    });
    await doc.save();

    res.json({
      success: true,
      request: publicRequest(doc.toObject()),
      message: `${doc.requestNumber} is confirmed and back with Store to send to finance.`,
    });
  } catch (e) {
    console.error("[spend] confirm:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ══ STORE SENDS THE CONFIRMED QUOTE ON ═════════════════════════════════════
 * The only door into finance for a request raised through fulfilment, and it
 * opens only after the requester has confirmed. Store's own last act: they
 * priced it, the requester agreed it is the right thing, and now somebody has
 * to agree to the money.
 */
/* ══ STORE FIXES A LINE THE REQUESTER SENT BACK ═════════════════════════════
 * The other half of "Send back to Store" — before this, that button changed
 * the request's status and gave Store nowhere to act on it. The line's
 * objection reason was visible on the confirmed-quotes panel, but there was
 * no door back into the commercial terms to fix it: no vendor field, no rate
 * field, nothing to submit.
 *
 * ── WHY ONLY THE FLAGGED LINES ──────────────────────────────────────────────
 * A requester who objects to one line of five has already agreed to the other
 * four. Re-opening every line for editing would let a confirmed line's terms
 * change out from under a confirmation the requester already gave — the exact
 * shape of bug "one line sent back sends the whole quote back" exists to
 * prevent. Only lines carrying `revisionRequested` may be touched here; the
 * request is refused if the body tries to change anything else.
 *
 * ── AND WHY IT GOES BACK TO AWAITING_CONFIRMATION, NOT STRAIGHT ON ──────────
 * Store fixed the price; they did not re-verify that the ITEM is right. The
 * requester still has to look again — this is the same door they came through
 * the first time, not a shortcut around it.
 */
router.patch("/:id/requote", async (req, res) => {
  try {
    const emp = await requester(req);
    if (!emp) return res.status(404).json({ success: false, message: "Your staff record was not found." });

    const doc = await SpendRequest.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: "Request not found." });

    const viewer = await viewerOf(emp);
    if (!viewer.canFulfil) {
      return res.status(403).json({
        success: false,
        message: "Only Store & Purchase can requote a request.",
      });
    }
    if (doc.status !== chain.REVISION_REQUESTED) {
      return res.status(409).json({
        success: false,
        message: `This request is ${chain.STAGE_LABEL[doc.status] || doc.status}, so there is nothing to requote.`,
      });
    }

    const posted = req.body?.lines && typeof req.body.lines === "object" ? req.body.lines : {};
    const flagged = (doc.items || []).filter((l) => l.revisionRequested);
    if (!flagged.length) {
      /* Should not be reachable — a REVISION_REQUESTED request always has at
         least one flagged line — but a data path that got here some other way
         must not silently do nothing. */
      return res.status(409).json({
        success: false,
        message: "No line on this request is flagged for a new quote.",
      });
    }

    for (const [i, l] of (doc.items || []).entries()) {
      if (!l.revisionRequested) continue;
      const spec = posted[String(l._id)] ?? posted[String(i)] ?? null;
      if (!spec) {
        return res.status(400).json({
          success: false,
          message: `${l.name}: this line needs a new quote before it can be sent back.`,
        });
      }

      const rate = num(spec.rate);
      if (rate === null || rate <= 0) {
        return res.status(400).json({ success: false, message: `${l.name} needs a quoted rate.` });
      }
      const vendorName = text(spec.vendorName, 200);
      if (!vendorName) {
        return res.status(400).json({ success: false, message: `${l.name} needs a vendor.` });
      }
      const gstPercent = spec.gstPercent === "" || spec.gstPercent === undefined || spec.gstPercent === null
        ? 0
        : num(spec.gstPercent);
      if (gstPercent === null || gstPercent < 0 || gstPercent > 28) {
        return res.status(400).json({ success: false, message: `${l.name}: GST is between 0 and 28 percent.` });
      }
      const deliveryRaw = spec.expectedDeliveryDate || null;
      const delivery = deliveryRaw ? new Date(deliveryRaw) : null;
      if (!delivery || Number.isNaN(delivery.getTime())) {
        return res.status(400).json({ success: false, message: `${l.name} needs an expected delivery date.` });
      }

      const priced = fulfilment.priceFor({ lines: [{ buyQty: l.quantity, rate, gstPercent }] });

      if (spec.newItemName) l.name = text(spec.newItemName, 200);
      if (spec.spec !== undefined) l.spec = text(spec.spec, 300);
      l.vendorName = vendorName;
      l.gstin = text(spec.gstin, 20);
      l.quoteRef = text(spec.quoteRef, 60);
      l.rate = rate;
      l.gstPercent = gstPercent;
      l.taxAmount = priced.taxAmount;
      l.amount = priced.subtotal;
      l.lineTotal = priced.grandTotal;
      l.expectedDeliveryDate = delivery;
      l.attachments = Array.isArray(spec.attachments)
        ? spec.attachments
            .filter((a) => a && typeof a.fileId === "string" && a.fileId.trim())
            .slice(0, 5)
            .map((a) => ({
              fileId: text(a.fileId, 200),
              fileName: text(a.fileName, 200),
              fileType: text(a.fileType, 100),
              fileSize: num(a.fileSize) || undefined,
              label: ["quote", "photo", "spec"].includes(String(a.label || "").trim())
                ? String(a.label).trim()
                : "other",
              uploadedAt: new Date(),
              uploadedByName: mrfApprover.buildFullName(emp),
            }))
        : l.attachments;

      /* Answered — the objection this line carried is resolved by the new
         figure, whether or not the requester ends up agreeing with it. */
      l.revisionRequested = false;
      l.revisionReason = undefined;
    }

    /* ── THE DOCUMENT TOTALS, RECOMPUTED FROM EVERY LINE ────────────────────
       Not just the flagged ones — a line the requester already confirmed still
       contributes its own figure to the total the requester is about to see
       again. */
    const priced = fulfilment.priceFor({
      lines: (doc.items || []).map((l) => ({
        buyQty: l.quantity, rate: l.rate, gstPercent: l.gstPercent,
      })),
    });
    doc.totalAmount = priced.subtotal;
    doc.gstPercent = priced.gstPercent;
    doc.taxAmount = priced.taxAmount;
    doc.grandTotal = priced.grandTotal;

    const now = new Date();
    const who = mrfApprover.buildFullName(emp);
    const note = text(req.body?.note, 500);

    doc.status = chain.AWAITING_CONFIRMATION;
    doc.revisionRequestedAt = undefined;
    doc.revisionNote = undefined;
    doc.history.push({
      at: now, by: emp._id, byName: who,
      action: "requoted and sent back to the requester",
      note: note || flagged.map((l) => l.name).join(", "),
    });
    await doc.save();

    res.json({
      success: true,
      request: publicRequest(doc.toObject()),
      message: `${doc.requestNumber} is back with ${doc.requestedByName || "the requester"}.`,
    });
  } catch (e) {
    console.error("[spend] requote:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

router.patch("/:id/send-to-finance", async (req, res) => {
  try {
    const emp = await requester(req);
    if (!emp) return res.status(404).json({ success: false, message: "Your staff record was not found." });

    const doc = await SpendRequest.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: "Request not found." });

    const viewer = await viewerOf(emp);
    if (!viewer.canFulfil) {
      return res.status(403).json({
        success: false,
        message: "Only Store & Purchase or finance can send a quote on.",
      });
    }
    if (doc.status !== chain.CONFIRMED) {
      return res.status(409).json({
        success: false,
        message:
          doc.status === chain.AWAITING_CONFIRMATION
            ? `${doc.requestedByName || "The requester"} has not confirmed this is the right item yet.`
            : `This request is ${chain.STAGE_LABEL[doc.status] || doc.status}.`,
      });
    }

    const now = new Date();
    const who = mrfApprover.buildFullName(emp);
    doc.status = chain.PENDING_FINANCE;
    doc.history.push({
      at: now, by: emp._id, byName: who,
      action: "sent the confirmed quote to finance",
      note: String(req.body?.note || "").trim().slice(0, 500),
    });
    await doc.save();

    res.json({
      success: true,
      request: publicRequest(doc.toObject()),
      message: `${doc.requestNumber} is with finance.`,
    });
  } catch (e) {
    console.error("[spend] send-to-finance:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ══ THE REQUESTER'S ANSWER TO A BUDGET EXCEPTION ═══════════════════════════
 * Finance sent it back because the quoted figure does not fit the head. Three
 * things the requester can do about it, and only the third leaves a record
 * here:
 *
 *   revise               →  back to finance at whatever it now costs
 *   additional_budget    →  back to finance WITH a reason, as a request for
 *                           more budget rather than for the spend
 *   withdraw             →  goes through the ordinary cancel door
 *
 * ── WHY THE REASON IS MANDATORY ON THE SECOND ───────────────────────────────
 * Asking for more money is a different question from asking to spend it, and
 * the person who has to answer it was not in the room when the need arose.
 * "Because it costs more than we budgeted" is not a reason; it is the
 * observation that prompted the question.
 *
 * ── AND WHY REVISING DOES NOT REPRICE ANYTHING ──────────────────────────────
 * The quote belongs to Store and the vendor. A requester who needs a smaller
 * quantity or a different head is changing the ASK — repricing it is Store's
 * job, and a request whose figure the requester could edit is a request
 * finance cannot trust.
 */
router.patch("/:id/budget-answer", async (req, res) => {
  try {
    const emp = await requester(req);
    if (!emp) return res.status(404).json({ success: false, message: "Your staff record was not found." });

    const doc = await SpendRequest.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: "Request not found." });

    if (String(doc.requestedBy) !== String(emp._id)) {
      return res.status(403).json({ success: false, message: "That is not your request." });
    }
    if (doc.status !== chain.BUDGET_EXCEPTION) {
      return res.status(409).json({
        success: false,
        message: "This request is not waiting on a budget answer.",
      });
    }

    const answer = String(req.body?.answer || "").toLowerCase();
    const reason = String(req.body?.reason || "").trim().slice(0, 1000);
    const now = new Date();
    const who = mrfApprover.buildFullName(emp);

    if (answer === "additional_budget") {
      if (!reason) {
        return res.status(400).json({
          success: false,
          message:
            "Say why the department needs more budget for this. Finance is being asked a different question from the one they just answered, and they were not in the room when the need came up.",
        });
      }
      doc.budgetAskReason = reason;
      doc.budgetAskAt = now;
      /* Back to finance as the SAME request, carrying the original number, the
         quoted figure, the head and the overrun finance recorded. A fresh
         document would lose the thread between the ask and what prompted
         it. */
      doc.status = chain.PENDING_FINANCE;
      doc.history.push({
        at: now,
        by: emp._id,
        byName: who,
        action: "asked for additional budget",
        note: reason,
      });
    } else if (answer === "revise") {
      doc.status = chain.PENDING_FINANCE;
      doc.history.push({
        at: now,
        by: emp._id,
        byName: who,
        action: "revised and sent back to finance",
        note: reason,
      });
    } else {
      return res.status(400).json({
        success: false,
        message: "Say what you want to do: revise it, ask for additional budget, or withdraw it.",
      });
    }

    await doc.save();
    res.json({
      success: true,
      request: publicRequest(doc.toObject()),
      message:
        answer === "additional_budget"
          ? `${doc.requestNumber} is back with finance as a request for additional budget.`
          : `${doc.requestNumber} is back with finance.`,
    });
  } catch (e) {
    console.error("[spend] budget-answer:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

router.patch("/:id/cancel", async (req, res) => {
  try {
    const emp = await requester(req);
    if (!emp) return res.status(404).json({ success: false, message: "Your staff record was not found." });

    const doc = await SpendRequest.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: "Request not found." });
    /* ── WHOSE MOVE A WITHDRAWAL IS ─────────────────────────────────────────
       While a request is still an ask, it is the requester's to take back and
       nobody else's. Once finance has agreed, the company has promised the
       money — a budget line is reduced by it and Store may already be raising
       the order — so it becomes finance's to release, and the person who asked
       can no longer do it quietly. */
    const viewer = await viewerOf(emp);
    const mine = String(doc.requestedBy) === String(emp._id);
    const approvedAlready = doc.status === chain.APPROVED;

    if (approvedAlready) {
      if (!viewer.isFinance) {
        return res.status(403).json({
          success: false,
          message:
            "Finance has approved this and the money is committed against a budget. Ask finance to withdraw it.",
        });
      }
    } else if (!mine) {
      return res.status(403).json({ success: false, message: "That is not your request." });
    }
    /* ── WITHDRAWING AFTER FINANCE HAS AGREED ───────────────────────────────
       Up to finance's yes, a request is just an ask and the person who made it
       may take it back. After it, the company has promised the money: a budget
       line is reduced by it and Store may already be raising the order. So the
       requester can no longer do it quietly — finance, who made the promise,
       has to be the one who releases it. */
    if (!chain.OPEN_STATUSES.includes(doc.status) && !approvedAlready) {
      return res.status(409).json({
        success: false,
        message: `This request is ${chain.STAGE_LABEL[doc.status] || doc.status} and can no longer be withdrawn.`,
      });
    }

    const now = new Date();
    doc.status = "cancelled";
    doc.decidedAt = now;
    doc.decidedBy = emp._id;
    doc.decidedByName = mrfApprover.buildFullName(emp);
    doc.decisionNote = text(req.body?.note, 500);
    doc.history.push({
      at: now,
      by: emp._id,
      byName: doc.decidedByName,
      action: "cancelled",
      note: doc.decisionNote,
    });

    /* The promise goes with it. Released, never deleted — the commitment is
       still the record of what finance agreed and when. */
    if (doc.commitmentId) {
      try {
        const Commitment = require("../../../models/Accountant_model/Acc_BudgetCommitment");
        const commitment = await Commitment.findById(doc.commitmentId);
        await budgetMatch.releaseForVoucher({
          commitment,
          voucher: null,
          actor: { email: emp.email, name: doc.decidedByName },
          reason: "request_cancelled",
        });
        if (commitment) doc.commitmentStatus = commitment.status;
      } catch (e) {
        console.error("[spend] releasing commitment on cancel failed:", e.message);
      }
    }

    await doc.save();

    res.json({ success: true, request: publicRequest(doc.toObject()) });
  } catch (e) {
    console.error("[spend] cancel:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
