// routes/CMS_Routes/Requests/intakeRequests.js
//
// THE REQUESTS DESK — /api/requests/intake
//
// One door in. The requester says what they need; nobody asks them whether it
// is store stock, a purchase, a repair or a subscription, because that is a
// fact about how this company is organised and not about what they need.
//
// ── THREE COLLECTIONS, ONE DESK ─────────────────────────────────────────────
// The list endpoints here read across all three:
//
//   IntakeRequest   the unified ask (this file's own)
//   MRF             material requests raised before this existed, and the ones
//                   a classified request becomes
//   SpendRequest    purchase/service requests raised before this existed, and
//                   the ones a classified request becomes
//
// Nothing was migrated and nothing was rewritten. A request raised last month
// through the old two-tab form is still exactly the document it was; it simply
// appears on the desk beside the new ones, in the same words. That is the whole
// of requirement 8, and it is why this reads rather than converts.
//
// Rows that a NEW intake spawned are folded into their intake row rather than
// listed twice — the ask and the thing it became are one item on a desk, not
// two.
//
// ── WHAT THIS FILE DOES NOT DO ──────────────────────────────────────────────
// Fulfil anything. Classification spawns the real document and stops; the store
// screens issue stock exactly as they did, finance approves spend exactly as it
// did, and the purchasing queue is untouched. If this file went away tomorrow
// every fulfilment path would still work — which is the test of whether an
// intake layer is a layer or a rewrite.
//
// ── AUTHENTICATION ──────────────────────────────────────────────────────────
// Mounted behind EmployeeAuth in server.js, like the MRF and spend doors. The
// requester is always the caller: taken from the session, never from the body.

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const IntakeRequest = require("../../../models/CMS_Models/Requests/IntakeRequest");
const SpendRequest = require("../../../models/CMS_Models/Requests/SpendRequest");
const MRF = require("../../../models/CMS_Models/Inventory/Operations/MRF");
const RawItem = require("../../../models/CMS_Models/Inventory/Products/RawItem");
const Vendor = require("../../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const Employee = require("../../../models/Employee");
const { Acc_Company, Acc_Ledger } = require("../../../models/Accountant_model/Acc_MasterModels");
const { Acc_User } = require("../../../models/Accountant_model/Acc_OrgModels");

const intake = require("../../../services/requestIntake.service");
const chain = require("../../../services/spendApproval.service");
const mrfApprover = require("../../../services/mrfApprover.service");
const budgetMatch = require("../../../services/budgetCommitment.service");
const spendCreate = require("../../../services/spendRequestCreate.service");
const { resolveFulfilmentAccess } = require("../../../services/access/fulfilmentAccess");
const vendorResolve = require("../../../services/vendorResolve.service");
/* The material door's own fulfilment rules — the split between what is issued
   and what is bought, and the tax on top of the quote. Shared rather than
   restated so the two store doors cannot drift apart on the same arithmetic. */
const storeFulfilment = require("../../../services/storeFulfilment.service");

const text = (v, max = 500) => String(v ?? "").trim().slice(0, max);

/** At most this many reference photos per line. */
const MAX_IMAGES_PER_LINE = 4;

/**
 * Reference photos, checked.
 *
 * The browser uploads straight to Cloudinary and sends back URLs — the pattern
 * every other image in this CMS uses — so what arrives is a link, and the only
 * useful checks are that it IS a link and that there are not fifty of them.
 *
 * An entry that fails is dropped rather than refusing the whole request: a
 * photo is an aid, and losing somebody's ask because one upload came back
 * malformed would trade the important thing for the helpful one. The same rule
 * MRF's own `cleanImages` has always applied.
 */
function cleanImages(images) {
  if (!Array.isArray(images)) return [];
  return images
    .filter((im) => im && typeof im.url === "string" && /^https?:\/\//i.test(im.url))
    .slice(0, MAX_IMAGES_PER_LINE)
    .map((im) => ({
      url: im.url.trim(),
      publicId: text(im.publicId, 200),
      name: text(im.name, 120),
    }));
}
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * A DEPARTMENT LOGIN THAT HAS NO STAFF RECORD.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Not every login in this CMS is an employee. The CEO signs in through the
 * legacy `ceodepartments` collection and has no row in `employees` at all;
 * several older department accounts are the same. Until this function existed
 * those logins resolved to `null` here, and every route in this router
 * answered them with a well-formed empty list — so the CEO opened the desk and
 * was told, truthfully and uselessly, that nothing was waiting.
 *
 * That was a silent failure of the worst kind: it is indistinguishable from an
 * empty queue, so nobody reports it as a bug, they report it as a missing
 * request. fulfilmentAccess has granted the board this queue since it was
 * written — `BOARD_DEPT_SLUGS` — but the grant was unreachable, because the
 * caller never got far enough to be asked about.
 *
 * ── WHAT A STAND-IN IS, AND IS NOT ──────────────────────────────────────────
 * It carries the DEPARTMENT the token was issued for, and nothing personal.
 * That is enough for every question this desk asks about a department — may
 * you fulfil, may you classify — and deliberately not enough for the questions
 * it asks about a person.
 *
 * It has NO `_id`, and that is the point rather than an omission. Every
 * identity this router stores is a ref into `employees`, so a stand-in has
 * nothing valid to write. The write paths refuse it explicitly (see
 * `refuseStandIn`) instead of persisting a dangling reference that would read
 * back as a deleted employee.
 *
 * The `department` is looked up rather than taken from the token so the desk
 * says "Executive Office" and not "ceo".
 */
async function standInFor(req) {
  const deptId = req.user?.deptId;
  if (!deptId || !mongoose.isValidObjectId(deptId)) return null;

  const dept = await mongoose.connection
    .collection("access_departments")
    .findOne({ _id: new mongoose.Types.ObjectId(String(deptId)) })
    .catch(() => null);
  if (!dept || dept.isActive === false) return null;

  return {
    _id: null,
    standIn: true,
    firstName: req.user?.name || dept.name || "",
    middleName: "",
    lastName: "",
    name: req.user?.name || dept.name || "",
    email: req.user?.email || "",
    /* The token's employeeId, when there is one — "CEO001" and its kind. It
       matches no employee, which is correct: a stand-in is nobody's approver
       and nobody's requester, so every ownership test fails closed. */
    biometricId: req.user?.employeeId || "",
    identityId: req.user?.employeeId || "",
    department: dept.name || "",
    /* The one field that does real work. resolveEmployeeDepartments reads it
       first, so the department grant this login already holds is the same
       grant fulfilmentAccess then judges. */
    accessDepartmentId: dept._id,
    additionalDepartmentIds: [],
    primaryManager: null,
    isActive: true,
    status: "active",
  };
}

/**
 * The caller's own employee record, or the department they signed in as.
 *
 * An employee record always wins — a person who has one is that person, even
 * when their login also carries a department grant.
 */
async function requester(req) {
  const biometricId = req.user?.employeeId;
  const byId = mongoose.isValidObjectId(req.user?.id) ? { _id: req.user.id } : null;
  const emp = await Employee.findOne(
    biometricId ? { $or: [{ biometricId }, { identityId: biometricId }] } : byId,
  )
    .select(
      "_id firstName middleName lastName name email department biometricId identityId " +
        "primaryManager accessDepartmentId additionalDepartmentIds isActive status",
    )
    .lean();

  return emp || standInFor(req);
}

/**
 * Refuse a write that needs a person, and say which person is missing.
 *
 * Returns true when it has already answered the request. The sentence names
 * the actual problem — no staff record — because "you are not allowed" would
 * send somebody to Access Control to fix a permission that is not the issue.
 */
function refuseStandIn(res, emp, what) {
  if (!emp?.standIn) return false;
  res.status(403).json({
    success: false,
    message:
      `${what} has to be done by a member of staff, and this login is a department ` +
      `account with no staff record. Sign in with your own employee login.`,
  });
  return true;
}

/**
 * What this person is, for the purposes of this desk.
 *
 * Four independent facts, deliberately not collapsed into a "role": somebody
 * can be a TL who is also in Store, or a finance approver who manages nobody.
 * A single role field would have to pick one and would be wrong for them.
 */
async function viewerOf(emp) {
  const [managedDocIds, accUser, fulfil] = await Promise.all([
    mrfApprover.listManagedEmployeeIds(emp?.biometricId || emp?.identityId).catch(() => []),
    emp?.email
      ? Acc_User.findOne({ email: String(emp.email).trim().toLowerCase() })
          .select("role isActive email")
          .lean()
          .catch(() => null)
      : null,
    resolveFulfilmentAccess(emp).catch(() => ({ allowed: false, via: null })),
  ]);

  /* listManagedEmployeeIds answers with Mongo _ids; everything else in this
     flow — requestedById, approverBiometricId, the session's own employeeId —
     speaks biometric ids. Translated once, here, rather than at every
     comparison. */
  const reports = (managedDocIds || []).length
    ? await Employee.find({ _id: { $in: managedDocIds } })
        .select("biometricId identityId")
        .lean()
    : [];
  const managedIds = reports
    .map((r) => r.biometricId || r.identityId)
    .filter(Boolean)
    .map(String);

  const isFinance = accUser?.isActive !== false && chain.isFinanceApprover(accUser);

  return {
    employeeId: emp?.biometricId || emp?.identityId || "",
    managedIds,
    managesPeople: managedIds.length > 0,
    isFinance,
    /* Finance classifies too. They see every request that spends money anyway,
       and a request stuck because the one store person is on leave is a
       request somebody raises again through a channel nobody is measuring. */
    canFulfil: Boolean(fulfil?.allowed) || isFinance,
    fulfilVia: fulfil?.via || (isFinance ? "finance" : null),
  };
}

/* ── ONE ROW SHAPE, WHATEVER COLLECTION IT CAME OUT OF ───────────────────────
 * The desk shows three kinds of document in one list, so they are composed
 * into one shape here rather than each screen learning three.
 *
 * `source` is on the row because the ACTIONS differ — approving an MRF and
 * approving a spend request are different endpoints — and the client has to
 * know which to call. It is not a label: nothing renders the word "mrf".
 */
/** What the store found, said in words rather than as an enum. */
const AVAILABILITY_LABEL = {
  AVAILABLE: "In store",
  PARTIAL: "Part of it is in store",
  NOT_AVAILABLE: "Not in store",
  ALTERNATIVE: "Store has an alternative",
};

/**
 * One line, in the one shape.
 *
 * `estimated` is the difference between the two documents in one flag: a
 * figure on an intake line is what the requester guessed, and a figure on a
 * spend line is what finance is being asked to agree to. Rendering the two
 * identically would let a guess be read as a price.
 *
 * The availability fields are the STORE's report, and they are null until the
 * store has actually looked — which happens AFTER the manager approves. A card
 * that filled them in with something optimistic would be answering a question
 * nobody has asked yet.
 */
const lineOf = ({
  name, quantity, unit, note, rate = null, estimated = false, item = null, stock = null, sku = "",
  images = [],
}) => {
  const q = Number(quantity);
  const r = rate === null || rate === undefined ? null : Number(rate);
  const reported = item && item.availability && item.availability !== "UNREVIEWED";

  return {
    name: name || "—",
    quantity: Number.isFinite(q) ? q : null,
    unit: unit || "",
    note: note || null,
    rate: r !== null && Number.isFinite(r) ? r : null,
    /* Computed here so the screen never multiplies money. */
    amount:
      r !== null && Number.isFinite(r) && Number.isFinite(q)
        ? Math.round(q * r * 100) / 100
        : null,
    estimated,
    availability: reported ? item.availability : null,
    /* The words, composed here — nothing on a screen should have to know that
       PARTIAL means part of it is on the shelf. */
    availabilityLabel: reported
      ? AVAILABILITY_LABEL[item.availability] || item.availability
      : null,
    availableQty: reported && item.availableQty !== null ? item.availableQty : null,
    availabilityNote: reported ? item.availabilityNote || null : null,
    /* Set only when the requester picked this out of the store's catalogue. */
    sku: sku || null,
    /* ── TWO KINDS OF PICTURE, KEPT APART ─────────────────────────────────
       `images` are the requester's own reference photos — what they are
       holding, or the broken thing. `catalogueImage` is what the store
       registered against the item. They answer different questions ("is this
       the one you mean" versus "what does this look like") and merging them
       into one strip would lose which was which. */
    images: (images || []).map((im) => ({
      url: im.url,
      name: im.name || null,
    })),
    catalogueImage: stock?.image || null,
    /* ── WHAT THE CATALOGUE SAYS IS ON THE SHELF ──────────────────────────
       A real figure from the store's own stock record, read live rather than
       snapshotted — a count from three weeks ago is worse than no count.
       Deliberately NOT called "available": the store's verdict accounts for
       what is reserved, what is the wrong grade and what is spoken for, and
       that judgement is still theirs to make. This is the catalogue's number
       and the screen says exactly that. */
    stockOnHand: stock ? stock.quantity ?? null : null,
    stockUnit: stock ? stock.unit || null : null,
  };
};

/**
 * What the store has said about a request's stock, if anything.
 *
 * Returns null when nobody has looked — which on a manager's approval card is
 * ALWAYS, because the store reviews availability after the TL approves. That
 * null is the honest answer and the card says so in words; inventing "probably
 * in stock" would answer a question nobody has asked yet.
 */
function stockNote(items) {
  const reported = items.filter((l) => l.availability);
  if (!reported.length) return null;
  const worst =
    reported.find((l) => l.availability === "NOT_AVAILABLE") ||
    reported.find((l) => l.availability === "PARTIAL") ||
    reported.find((l) => l.availability === "ALTERNATIVE") ||
    reported[0];
  return {
    label: AVAILABILITY_LABEL[worst.availability] || worst.availability,
    /* How many lines the store has actually looked at, so "In store" on a
       six-line request cannot be read as a verdict on all six. */
    reviewed: reported.length,
    total: items.length,
  };
}

/**
 * What this approval MEANS, in the approver's own terms.
 *
 * Composed here rather than in the card because the two steps are genuinely
 * different promises and the screen must not blur them: a manager is agreeing
 * the department needs the thing, and finance is agreeing the company will pay
 * for it. A single "Approve this request" would let one be mistaken for the
 * other, which is the whole reason there are two steps.
 */
/**
 * The queue chip for a department step, named for what it actually is.
 *
 * "Your turn: Pramod approval" while others are still to come, and "Final
 * department approval: Rakesh" for the last one — an approver should know
 * they are the gate that releases the request rather than assuming somebody
 * more senior will look again.
 *
 * Null on a request with no chain, where the caller falls back to the plain
 * wording those rows have always carried.
 */
function chainStepLabel(r) {
  const chain = r.approvalChain || [];
  if (!chain.length) return null;
  const i = Number.isInteger(r.currentApproverIndex) ? r.currentApproverIndex : 0;
  const step = chain[i];
  if (!step) return null;
  return i === chain.length - 1 && chain.length > 1
    ? `Final department approval: ${step.name}`
    : `Your turn: ${step.name} approval`;
}

const STEP_NOTE = {
  tl: "Approving confirms the department need. Store handles fulfilment after this — you are not approving any spend.",
  finance: "Approving commits the money against the account head below. The department need was already agreed by their department.",
};

/* ── WHAT THE HEAD LOOKS LIKE, AND WHAT THIS REQUEST WOULD DO TO IT ──────────
 * Store & Purchase are about to turn this into money leaving the company, and
 * "Repairs & Maintenance" on its own does not tell them whether that is a
 * comfortable decision. So the whole position travels: what was approved, what
 * has been paid, what has been promised, what was left when the head was
 * chosen — and what would be left afterwards.
 *
 * ── WHY `availableAfter` IS LABELLED AND NOT JUST PRINTED ────────────────────
 * On an intake request the cost is the REQUESTER's estimate, and it is often
 * partial — a line with no rate contributes nothing, so the figure understates
 * the impact. Printing it beside three exact numbers would make a guess look
 * like a measurement. It therefore carries `estimated` and `complete`, and the
 * screen says which it is. Null when nobody guessed at all: no figure is a
 * better answer than a wrong one.
 *
 * The spend request this becomes recomputes all of it against the real total —
 * see budgetCommitment.matchFor. This is the picture at the fulfilment step,
 * not a substitute for finance's.
 */
/**
 * @param {boolean} withMoney  Whether this viewer may see the BALANCES on the
 *        head — approved, spent, committed, available, and what this request
 *        would leave. The head's NAME is routing context and everybody in the
 *        chain gets it; the figures are the department's financial position
 *        and are nobody's business but theirs and finance's.
 *
 *        Store is the fulfilment and commercial medium. They price a quote;
 *        they do not decide whether the company can afford it, and showing
 *        them the balance invites them to — either by trimming a quote to fit
 *        an envelope that is not theirs to manage, or by justifying an
 *        overrun they have no standing to justify. Finance checks the budget.
 *
 *        Enforced HERE rather than by hiding it on the screen: a field absent
 *        from the response cannot be read out of the network tab.
 */
function budgetHeadOf(r, withMoney = false) {
  if (!r.ledgerName) return null;

  const snap = withMoney ? r.budgetSnapshot || null : null;
  const available =
    withMoney && typeof r.budgetSnapshot?.available === "number"
      ? r.budgetSnapshot.available
      : null;
  const estimate = typeof r.estimatedTotal === "number" && r.estimatedTotal > 0
    ? r.estimatedTotal
    : null;

  return {
    ledgerId: r.ledgerId ? String(r.ledgerId) : null,
    ledgerName: r.ledgerName,
    /* ── THE PLANNED ITEM ────────────────────────────────────────────────
       Carried on every row, for everybody — it is fulfilment context, not a
       figure. Store reads the NAME so they know the request is for the PC
       that was planned rather than any PC; it is not a budget balance and is
       not gated behind `withMoney`.

       `null` on requests raised before planned items existed, which the
       screens render as "No planned item linked". */
    plannedItemKey: r.plannedItemKey || null,
    plannedItemName: r.plannedItemName || null,
    /* The APPROVED figure for that row is money, so it follows the same rule
       as every other balance: not for Store. */
    plannedItemAmount: withMoney && typeof r.plannedItemAmount === "number"
      ? r.plannedItemAmount
      : null,
    unbudgeted: Boolean(r.unbudgetedHeadRequest),
    reason: r.requestedHeadReason || null,
    /* The address of the allocation, both halves — see the model. */
    budgetCycleId: r.budgetCycleId ? String(r.budgetCycleId) : null,
    budgetLineId: r.budgetLineId ? String(r.budgetLineId) : null,
    financialYear: r.budgetFinancialYear || null,
    department: r.budgetDepartment || r.department || null,
    matchStatus:
      r.budgetMatchStatus || (r.unbudgetedHeadRequest ? "no_budget_line" : null),
    /* What the requester was looking at when they chose it. */
    snapshot: snap,
    availableAfter:
      available === null || estimate === null
        ? null
        : Math.round((available - estimate) * 100) / 100,
    availableAfterEstimated: true,
    availableAfterComplete: Boolean(r.estimateComplete && estimate !== null),
  };
}

/* ── WHERE IT IS, IN ONE SENTENCE ────────────────────────────────────────────
 * `stageLabel` says WHAT a request is waiting for. This says WHO, and on a
 * multi-step chain it also says who has already answered — which is the
 * question a requester actually has:
 *
 *   Waiting for Pramod
 *   Pramod approved · waiting for Rakesh
 *   Department approval complete · with Store
 *   Approval skipped — requester is the department lead
 *
 * ── AND WHY A BROKEN CHAIN IS NEVER SILENT ──────────────────────────────────
 * A request that skipped approval because nobody in the department is senior
 * to the requester, and one that skipped it because HR has no department on
 * their record, both arrive at Store with nobody having approved anything.
 * They are completely different facts and only one of them is fine. The second
 * is returned with `tone: "warn"` so the screen can mark it rather than
 * letting it read as an ordinary skip.
 *
 * Composed here rather than in the card because three screens show it — the
 * requester's list, the approval queue and the fulfilment desk — and one
 * sentence written three times is three sentences.
 */
const CLEAN_SKIPS = new Set(["top_of_department", "outside_department"]);

function stageDetailOf(r) {
  const chain = r.approvalChain || [];
  const pendingTl = r.status === intake.PENDING_TL;

  /* ── A CHAIN THAT WAS NEVER BUILT ────────────────────────────────────── */
  if (!chain.length) {
    if (CLEAN_SKIPS.has(r.chainStop)) {
      return {
        text: "Approval skipped — requester is the department lead",
        tone: "muted",
      };
    }
    if (r.chainStop && r.chainStop !== "no_manager") {
      /* Missing department, unreachable manager, a loop in HR. Marked, because
         a request nobody could route is not a request nobody needed to. */
      return { text: `Approval skipped — ${r.chainStopReason || "the reporting line could not be read"}`, tone: "warn" };
    }
    if (r.chainStopReason && !chain.length && r.status !== intake.PENDING_TL) {
      return { text: `Approval skipped — ${r.chainStopReason}`, tone: "warn" };
    }
    /* Raised before the chain existed: one stored approver, or none. */
    if (r.approverResolutionNote) return { text: r.approverResolutionNote, tone: "warn" };
    if (pendingTl && r.approverName) return { text: `Waiting for ${r.approverName}`, tone: "muted" };
    if (r.tlApprovedByName) return { text: `Approved by ${r.tlApprovedByName}`, tone: "muted" };
    return null;
  }

  /* ── A CHAIN THAT EXISTS ─────────────────────────────────────────────── */
  const rejected = chain.find((c) => c.status === "rejected");
  if (rejected) {
    return { text: `${rejected.name} rejected this`, tone: "warn" };
  }

  const done = chain.filter((c) => c.status === "approved");
  const waiting = chain.find((c) => c.status === "pending");

  if (!waiting) {
    return { text: "Department approval complete · with Store", tone: "muted" };
  }
  if (!done.length) {
    return { text: `Waiting for ${waiting.name}`, tone: "muted" };
  }
  /* Only the most recent yes is named. "Soumya approved · Pramod approved ·
     waiting for Rakesh" is the rail's job, not a sentence's. */
  const last = done[done.length - 1];
  return { text: `${last.name} approved · waiting for ${waiting.name}`, tone: "muted" };
}

function intakeRow(r, linked, stock = null, { withMoney = false } = {}) {
  const kind = r.fulfilmentKind ? intake.kindOf(r.fulfilmentKind) : null;

  /* Once classified, the live state is the spawned document's. Reading it from
     there rather than copying it back is the difference between one fact and
     two that drift. */
  let stage = intake.STAGE_LABEL[r.status] || r.status;
  let settled = [intake.REJECTED, intake.CANCELLED, intake.CLOSED].includes(r.status);
  if (linked?.kind === "mrf") {
    stage = intake.MRF_STAGE_LABEL[linked.status] || linked.status;
    settled = intake.SETTLED_MRF.includes(linked.status);
  } else if (linked?.kind === "spend") {
    stage = chain.STAGE_LABEL[linked.status] || linked.status;
    settled = ["rejected", "cancelled"].includes(linked.status);
  }

  return {
    source: "intake",
    id: String(r._id),
    number: r.requestNumber,
    title: r.title,
    purpose: r.purpose,
    note: r.note || null,
    requestedByName: r.requestedByName || "",
    requestedById: r.requestedById || "",
    department: r.department || "",
    createdAt: r.createdAt,
    neededBy: r.neededBy || null,
    priority: r.priority || "NORMAL",
    repeats: Boolean(r.repeats),
    requestType: r.requestType || null,
    requestTypeLabel: r.requestType ? intake.REQUEST_TYPE_LABEL[r.requestType] : null,
    /* ── THE MANAGER'S BUDGET HEAD ────────────────────────────────────────
       Null on every request approved before the manager was the one choosing
       it. The screen says "Budget head not set" rather than inventing one —
       those requests had their head picked by Store at classification, and
       claiming otherwise would misreport who decided. */
    budgetHead: budgetHeadOf(r, withMoney),
    items: (r.items || []).map((l) => ({
      ...lineOf({
        name: l.name, quantity: l.quantity, unit: l.unit, note: l.note,
        rate: l.rate ?? null, estimated: true, sku: l.rawItemSku,
        images: l.images,
        stock: l.rawItem && stock ? stock.get(String(l.rawItem)) || null : null,
      }),
      /* ── THE LINE THE STORE COULD NOT GET ────────────────────────────────
         On the line rather than in a note at the foot of the request: a
         requester reading five lines needs to know WHICH one is not coming,
         and finding out from a short delivery is how it worked before. */
      unfulfilled: Boolean(l.unfulfilled),
      unfulfilledReason: l.unfulfilledReason || null,
      unfulfilledByName: l.unfulfilledByName || null,
    })),
    /* Labelled an estimate wherever it appears. It is what the requester
       guessed, and `estimateComplete` says whether even the guess is whole. */
    estimate: r.estimatedTotal
      ? { amount: r.estimatedTotal, complete: Boolean(r.estimateComplete) }
      : null,
    status: r.status,
    stageLabel: stage,
    settled,
    /* Never the enum. "From store stock", not STORE_ISSUE. */
    fulfilmentLabel: kind ? kind.label : null,
    /* Said explicitly rather than left to a null label, because "nobody has
       decided yet" is a real state a manager should be able to read. */
    classified: Boolean(kind),
    /* The requester's own reference photos, across every line. Nothing else is
       attachable at intake yet, so this is the whole count. */
    attachmentCount: (r.items || []).reduce((n, l) => n + (l.images || []).length, 0),
    accountHead: null,
    /* An intake request holds no stock report of its own. Once it has become
       an MRF the store's findings live there, and they are read through
       `linked` rather than copied back onto the ask. */
    stock: linked?.stock || null,
    approverName: r.approverName || null,
    /* ── THE DEPARTMENT CHAIN, AS A RAIL ──────────────────────────────────
       Soumya → Pramod → Rakesh, each with its own state, so the requester can
       see where it is stuck and an approver can see whether anybody looked
       before them. Empty on a request raised before the chain existed and on
       one whose requester is the most senior person in their department; the
       two are told apart by `chainStop`. */
    approvalChain: intake.approvalChain.progressOf(r),
    approvalStepLabel: intake.approvalChain.stepLabel(r),
    approvalStepIndex: Number.isInteger(r.currentApproverIndex) ? r.currentApproverIndex : 0,
    approvalStepCount: (r.approvalChain || []).length,
    chainStop: r.chainStop || null,
    /* Said out loud when there was nobody to ask — "you are the most senior
       person in your department" is a different sentence from "your reporting
       line is broken", and only one of them is a problem. */
    chainStopReason: r.chainStopReason || null,
    /* Why it routed the way it did. `RESOLVED` on every ordinary request; the
       note is the sentence to show when it is not. */
    approverResolution: r.approverResolution || "RESOLVED",
    stageDetail: stageDetailOf(r)?.text || null,
    /* "muted" on an ordinary step, "warn" when the chain could not be built —
       a skipped approval must never read like a completed one. */
    stageDetailTone: stageDetailOf(r)?.tone || null,
    tlApprovedByName: r.tlApprovedByName || null,
    tlApprovedAt: r.tlApprovedAt || null,
    classifiedByName: r.classifiedByName || null,
    classifiedAt: r.classifiedAt || null,
    classificationNote: r.classificationNote || null,
    /* What it became, so a requester can see the number the store or finance
       is talking about. */
    becameNumber: r.mrfNumber || r.spendRequestNumber || null,
    decisionNote: r.decisionNote || null,
  };
}

/** A material request raised before the unified intake existed. */
function mrfRow(m) {
  return {
    source: "mrf",
    id: String(m._id),
    number: m.mrfNumber,
    title: (m.items || [])[0]?.rawItemName || "Material request",
    purpose: m.reason || "",
    note: null,
    requestedByName: m.requestedForName || "",
    requestedById: m.requestedForId || "",
    department: m.requestedForDept || "",
    createdAt: m.createdAt,
    neededBy: m.neededBy || null,
    priority: m.priority || "NORMAL",
    repeats: false,
    /* An MRF is material by definition; it predates the type field entirely. */
    requestType: "PRODUCT",
    requestTypeLabel: "Product",
    /* Only an MRF that came off this desk carries one. A material request
       raised through the store app directly never had a head chosen, and
       null is the honest answer for it — not a gap to fill in. */
    budgetHead: m.budgetLedgerName
      ? {
          ledgerId: m.budgetLedgerId ? String(m.budgetLedgerId) : null,
          ledgerName: m.budgetLedgerName,
          unbudgeted: Boolean(m.budgetHeadRequested),
          reason: null,
          budgetCycleId: m.budgetCycleId ? String(m.budgetCycleId) : null,
          budgetLineId: m.budgetLineId ? String(m.budgetLineId) : null,
          financialYear: m.budgetFinancialYear || null,
          department: m.budgetDepartment || m.requestedForDept || null,
          matchStatus: m.budgetHeadRequested ? "no_budget_line" : "matched",
          /* Issuing owned stock spends nothing, so there is no position to
             show and no "after" to project. The head is a record of the
             decision, not a figure this document moves. */
          snapshot: null,
          availableAfter: null,
          availableAfterEstimated: false,
          availableAfterComplete: false,
        }
      : null,
    items: (m.items || []).map((i) =>
      lineOf({
        name: i.rawItemName, quantity: i.requestedQty, unit: i.unit,
        note: i.description, item: i, sku: i.rawItemSku, images: i.images,
      }),
    ),
    estimate: null,
    status: m.status,
    stageLabel: intake.MRF_STAGE_LABEL[m.status] || m.status,
    settled: intake.SETTLED_MRF.includes(m.status),
    /* Raised when the requester still had to choose. Saying so is honest about
       what these rows are; leaving it blank would imply nobody decided. */
    fulfilmentLabel: "From store stock",
    classified: true,
    stock: stockNote(
      (m.items || []).map((i) => ({
        availability: i.availability && i.availability !== "UNREVIEWED" ? i.availability : null,
      })),
    ),
    /* The requester's own photos of the thing they need — the only files an
       MRF carries, and they are attached per line. */
    attachmentCount: (m.items || []).reduce((n, i) => n + (i.images || []).length, 0),
    accountHead: null,
    approverName: m.approverName || null,
    approverResolution: m.approverResolution || "RESOLVED",
    /* MRF composes its own fallback sentence at creation — the same fact in
       the same words, read from the field it already had. */
    stageDetail: stageDetailOf({
      status: m.status === "PENDING" ? intake.PENDING_TL : m.status,
      approverName: m.approverName,
      tlApprovedByName: m.tlApprovedByName,
      approverResolutionNote: m.autoForwarded ? m.autoForwardReason : "",
    })?.text || null,
    stageDetailTone: m.autoForwarded ? "warn" : null,
    tlApprovedByName: m.tlApprovedByName || null,
    tlApprovedAt: m.tlApprovedAt || null,
    classifiedByName: null,
    classifiedAt: null,
    classificationNote: null,
    becameNumber: null,
    decisionNote: m.tlRejectionNote || null,
  };
}

/** A purchase or service request raised before the unified intake existed. */
function spendRow(sp) {
  return {
    source: "spend",
    id: String(sp._id),
    number: sp.requestNumber,
    title: sp.title,
    purpose: sp.purpose || "",
    note: null,
    requestedByName: sp.requestedByName || "",
    requestedById: sp.requestedById || "",
    department: sp.department || "",
    createdAt: sp.createdAt,
    neededBy: sp.neededBy || null,
    priority: sp.priority || "NORMAL",
    repeats: Boolean(sp.recurring?.isRecurring),
    requestType: sp.requestType === "PRODUCT" ? "PRODUCT" : "SERVICE",
    /* A legacy `SOFTWARE` row reads as Service, which is what it always was. */
    requestTypeLabel: sp.requestType === "PRODUCT" ? "Product" : "Service",
    /* ── ONE SHAPE, TWO COLLECTIONS ──────────────────────────────────────
       A spend request's snapshot names the same figures differently —
       `committedBefore`, `availableBefore`, and a real `availableAfter`
       computed against the agreed total rather than an estimate. Translated
       here so one card renders both kinds of row: a screen that had to know
       which collection it was holding before it could read a number is the
       thing this desk exists to avoid. */
    budgetHead: sp.ledgerName
      ? {
          ledgerId: sp.ledgerId ? String(sp.ledgerId) : null,
          ledgerName: sp.ledgerName,
          unbudgeted: Boolean(sp.unbudgetedHeadRequest),
          reason: sp.requestedHeadReason || null,
          budgetCycleId: sp.budgetCycleId ? String(sp.budgetCycleId) : null,
          budgetLineId: sp.budgetLineId ? String(sp.budgetLineId) : null,
          financialYear: sp.budgetFinancialYear || null,
          department: sp.budgetDepartment || sp.department || null,
          matchStatus: sp.budgetMatchStatus || null,
          snapshot: sp.budgetSnapshot
            ? {
                approved: sp.budgetSnapshot.approved,
                committed: sp.budgetSnapshot.committedBefore,
                actual: sp.budgetSnapshot.actual,
                available: sp.budgetSnapshot.availableBefore,
              }
            : null,
          availableAfter:
            typeof sp.budgetSnapshot?.availableAfter === "number"
              ? sp.budgetSnapshot.availableAfter
              : null,
          /* Finance agreed a figure; nothing here is a guess. */
          availableAfterEstimated: false,
          availableAfterComplete: true,
        }
      : null,
    items: (sp.items || []).map((l) =>
      lineOf({
        name: l.name, quantity: l.quantity, unit: l.unit, note: l.whyNeeded,
        /* Not an estimate on this side — this is the rate finance approves. */
        rate: l.rate, estimated: false,
      }),
    ),
    /* Not an estimate on this side — the lines carry the rate finance is being
       asked to agree to. Marked complete so no screen calls it a guess. */
    estimate: sp.totalAmount ? { amount: sp.totalAmount, complete: true } : null,
    status: sp.status,
    stageLabel: chain.STAGE_LABEL[sp.status] || sp.status,
    settled: ["rejected", "cancelled"].includes(sp.status),
    fulfilmentLabel:
      sp.requestType === "PRODUCT" ? "Buy from outside" : "Service or repair",
    classified: true,
    attachmentCount: (sp.attachments || []).length,
    /* Only ever shown once something has been classified — a head named on an
       unclassified request would be a decision nobody has made. */
    accountHead: sp.ledgerName || null,
    stock: null,
    approverName: sp.approverName || null,
    approverResolution: sp.approverResolution || "RESOLVED",
    stageDetail: stageDetailOf({
      status: [chain.PENDING_TL, chain.LEGACY_SUBMITTED].includes(sp.status)
        ? intake.PENDING_TL : sp.status,
      approverName: sp.approverName,
      tlApprovedByName: sp.tlApprovedByName,
      approverResolutionNote: sp.approverResolutionNote,
    })?.text || null,
    stageDetailTone: null,
    tlApprovedByName: sp.tlApprovedByName || null,
    tlApprovedAt: sp.tlApprovedAt || null,
    classifiedByName: null,
    classifiedAt: null,
    classificationNote: null,
    becameNumber: null,
    decisionNote: sp.decisionNote || null,
  };
}

/**
 * What the catalogue currently holds, for every line that named an item.
 *
 * One query for the whole page. Read live and never stored on the request: a
 * stock count is true at the moment it is read and at no other moment, and one
 * frozen into a request three weeks ago would be a number somebody acts on.
 */
async function stockFor(rows) {
  const ids = rows.flatMap((r) => (r.items || []).map((l) => l.rawItem).filter(Boolean));
  if (!ids.length) return new Map();
  const items = await RawItem.find({ _id: { $in: ids } })
    /* `variants.image` and not `image`: there is no item-level picture in this
       model, the registered ones hang off the variants. */
    .select("_id quantity unit customUnit variants.image")
    .lean()
    .catch(() => []);
  return new Map(
    items.map((it) => [
      String(it._id),
      {
        quantity: it.quantity ?? null,
        unit: it.customUnit || it.unit || "",
        /* The first variant that was actually photographed. Read live with the
           count, for the same reason: a picture replaced last week should be
           the one on screen. */
        image: (it.variants || []).map((v) => v.image).find(Boolean) || null,
      },
    ]),
  );
}

/**
 * The live state of everything a set of intake rows became.
 *
 * Two bulk reads, not one per row. Also returns the ids so the caller can drop
 * those documents from the legacy lists — the ask and the thing it became are
 * one item on a desk, not two.
 */
async function linkedFor(rows) {
  const mrfIds = rows.map((r) => r.mrfId).filter(Boolean);
  const spendIds = rows.map((r) => r.spendRequestId).filter(Boolean);

  const [mrfs, spends] = await Promise.all([
    mrfIds.length
      ? MRF.find({ _id: { $in: mrfIds } })
          /* The store's availability report too, so a requester reading their
             own row sees "Not in store" without opening the MRF. */
          .select("_id status items.availability")
          .lean()
      : [],
    spendIds.length
      ? SpendRequest.find({ _id: { $in: spendIds } }).select("_id status").lean()
      : [],
  ]);

  const byId = new Map();
  for (const m of mrfs) {
    byId.set(String(m._id), {
      kind: "mrf",
      status: m.status,
      stock: stockNote(
        (m.items || []).map((i) => ({
          availability: i.availability && i.availability !== "UNREVIEWED" ? i.availability : null,
        })),
      ),
    });
  }
  for (const s of spends) byId.set(String(s._id), { kind: "spend", status: s.status });

  return {
    linkOf: (r) => byId.get(String(r.mrfId || r.spendRequestId || "")) || null,
    mrfIds: mrfIds.map(String),
    spendIds: spendIds.map(String),
  };
}

/** Newest first, but anything still moving above anything settled. */
const deskOrder = (a, b) => {
  if (a.settled !== b.settled) return a.settled ? 1 : -1;
  return new Date(b.createdAt) - new Date(a.createdAt);
};

/* ══ WHO AM I HERE ══════════════════════════════════════════════════════════
 * The desk asks once, so it knows which tabs exist for this person. Cheaper
 * and more honest than each tab discovering it is empty because it was not
 * theirs to see.
 */
/* ── THE HEADS I MAY SPEND AGAINST ───────────────────────────────────────────
 * The requester's OWN department's approved allocations, for the form they are
 * about to fill in. Not the chart of accounts — what finance approved for
 * them, in the period that is running, usually two or three lines.
 *
 * Declared above `/:id/...` so the literal path wins; a bare `/budget-heads`
 * would otherwise be read as an id.
 *
 * ── WHY THE REQUESTER IS ASKED AFTER ALL ────────────────────────────────────
 * This moved. The head used to be chosen by the requester's manager, on the
 * ground that a person needing a replacement blade does not know the
 * department's accounting heads. That is still true of the CHART; it is not
 * true of the two or three lines their own department has budget on, which are
 * the only options this returns. Naming it up front means the chain reviewing
 * the request is reading one that already says which envelope it comes out of,
 * rather than being asked to agree to a need and invent its accounting in the
 * same click. An approver may still correct it.
 */
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
      department: emp.department || "",
      financialYear: heads.find((h) => h.financialYear)?.financialYear || null,
      reason: heads.length ? null : reason || "no_lines",
      /* Said here rather than inferred from an empty dropdown, which reads as
         a form that has not finished loading. */
      emptyMessage: heads.length
        ? null
        : "No approved budget heads for your department yet.",
      heads: heads.map((h) => ({
        ledgerId: String(h.ledgerId),
        /* ── THE PLAN INSIDE THE HEAD ────────────────────────────────────
           The head is an accounting bucket; these are the rows finance
           actually agreed to. A request spends against a row, never against
           the bucket — otherwise the thing finance refused can be bought out
           of the money approved for something else, and the report still
           balances. */
        plannedItems: h.plannedItems || [],
        ledgerName: h.name,
        approved: h.approved,
        committed: h.committed,
        actual: h.actual,
        available: h.available,
      })),
    });
  } catch (e) {
    console.error("[intake] my budget-heads:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ══ SUPPLIERS THE COMPANY ALREADY BUYS FROM ════════════════════════════════
 * A picker for the vendor field, the same shape as the inventory picker beside
 * it: most quotes come from somebody already on the books, and retyping
 * "Sharma Engineering" produces four spellings of one supplier that no report
 * can add together.
 *
 * ── AND IT DOES NOT REPLACE TYPING ──────────────────────────────────────────
 * A genuinely new supplier is ordinary — somebody has to be quoted first
 * before they can be onboarded — so the field still accepts a free name. This
 * offers a match; it does not demand one.
 *
 * ── WHY IT IS NOT THE PURCHASE-ORDER ENDPOINT ───────────────────────────────
 * There is already a `/data/vendors` on the purchase-order router, and it is
 * mounted with NO auth middleware in front of it. Rather than build a second
 * caller onto that, this asks the same question behind this router's session
 * and returns only the two fields the form actually fills — a name and a
 * GSTIN. Bank details, addresses and payment terms are none of this screen's
 * business.
 *
 * Declared above `/:id/...` so a literal path is never read as an id.
 */
router.get("/vendors", async (req, res) => {
  try {
    const emp = await requester(req);
    if (!emp) return res.json({ success: true, vendors: [] });

    const viewer = await viewerOf(emp);
    if (!viewer.canFulfil) {
      return res.status(403).json({
        success: false,
        message: "Only Store & Purchase or finance can look up suppliers.",
      });
    }

    const search = text(req.query.search, 80);
    /* No blank-query listing. Seventy-nine suppliers returned for an empty box
       is a list of everybody the company has ever bought from, presented as if
       it were a result. */
    if (search.length < 2) return res.json({ success: true, vendors: [] });

    const safe = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(safe, "i");
    const rows = await Vendor.find({
      status: "Active",
      $or: [{ companyName: rx }, { gstNumber: rx }],
    })
      .select("_id companyName gstNumber vendorType")
      .sort({ companyName: 1 })
      .limit(20)
      .lean();

    res.json({
      success: true,
      vendors: rows.map((v) => ({
        id: String(v._id),
        name: v.companyName || "",
        gstin: v.gstNumber || "",
        kind: v.vendorType || "",
      })),
    });
  } catch (e) {
    console.error("[intake] vendors:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get("/me", async (req, res) => {
  try {
    const emp = await requester(req);
    if (!emp) {
      return res.json({
        success: true,
        identityMissing: true,
        me: {
          name: "",
          department: "",
          managesPeople: false,
          isFinance: false,
          canFulfil: false,
          /* Said out loud, so the desk can explain itself rather than render
             every tab empty and let the reader draw the wrong conclusion. */
          identityMissing: true,
        },
      });
    }
    const viewer = await viewerOf(emp);

    /* ── WHO THEIR OWN REQUESTS WILL GO TO ─────────────────────────────────
       Answered before they type anything, because "who will see this" changes
       what somebody writes — and because a broken reporting line is worth
       finding out about while raising the request rather than a week later
       when nobody has looked at it.

       Built with the SAME walk the request itself will use. Asking the
       single-manager resolver instead would name the requester's primary
       manager even when that person is in another department — so somebody
       whose request will actually skip straight to Store would be told it
       goes to the CEO. The form and the routing have to agree.

       A failure costs the sentence, not the form. */
    let approver = null;
    try {
      const built = await intake.approvalChain.buildChain({
        requester: emp,
        load: (id) =>
          Employee.findById(id)
            .select("_id firstName middleName lastName name email biometricId identityId " +
                    "department departmentId designation jobTitle isActive status primaryManager")
            .lean(),
      });
      const clean = built.stop === "top_of_department" || built.stop === "outside_department";
      approver = {
        /* The whole chain, so the form can say "Pramod, then Rakesh" rather
           than naming one person and implying they are the only gate. */
        chain: built.chain.map((c) => ({ name: c.name, designation: c.designation || null })),
        name: built.chain[0]?.name || null,
        resolution: built.chain.length ? "RESOLVED" : built.stop,
        note: built.chain.length
          ? null
          : clean
            ? "You are the most senior person in your department, so your requests go straight to Store."
            : `${built.stopReason} Your requests go straight to Store.`,
        /* Marked when the chain could not be BUILT, so the form can warn
           rather than letting a broken hierarchy read as a normal skip. */
        broken: !built.chain.length && !clean,
      };
    } catch (e) {
      console.error("[intake] me: approval chain lookup failed:", e.message);
    }

    res.json({
      success: true,
      me: {
        name: mrfApprover.buildFullName(emp),
        department: emp.department || "",
        /* Whether they have anybody's requests to approve is a fact about the
           org chart, not about whether any are waiting right now. */
        managesPeople: viewer.managesPeople,
        isFinance: viewer.isFinance,
        canFulfil: viewer.canFulfil,
        /* A department account rather than a person. The desk uses this to
           drop the tabs that are about somebody's own work — a stand-in has no
           requests of their own and is in nobody's approval chain — so it
           shows what this login CAN do instead of three empty lists. */
        standIn: Boolean(emp.standIn),
        /* Their own Primary Manager, from HR. Null only if the lookup itself
           failed; an unresolved chain answers with a resolution and a note. */
        approver,
      },
    });
  } catch (e) {
    console.error("[intake] me:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ══ MY REQUESTS ════════════════════════════════════════════════════════════
 * Everything this person ever asked for, whichever door they asked through.
 */
router.get("/", async (req, res) => {
  try {
    const emp = await requester(req);
    /* Not an error — but never a bare empty list either. An unidentified
       caller and a caller with nothing waiting are DIFFERENT ANSWERS, and
       sending the same payload for both is what let the CEO read "no requests"
       for a request that was sitting right there. The flag lets the desk say
       which of the two it is. */
    if (!emp) return res.json({ success: true, requests: [], identityMissing: true });

    const limit = Math.min(Number(req.query.limit) || 60, 200);

    const mine = await IntakeRequest.find({ requestedBy: emp._id })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    const [{ linkOf, mrfIds, spendIds }, stock] = await Promise.all([
      linkedFor(mine),
      stockFor(mine),
    ]);

    /* The legacy halves, minus anything a new intake row already speaks for. */
    const [mrfs, spends] = await Promise.all([
      MRF.find({
        requestedFor: emp._id,
        ...(mrfIds.length ? { _id: { $nin: mrfIds } } : {}),
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),
      SpendRequest.find({
        requestedBy: emp._id,
        ...(spendIds.length ? { _id: { $nin: spendIds } } : {}),
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),
    ]);

    const requests = [
      /* Their own request against their own department's head. The requester
         chose it from the balances in the first place — hiding them now would
         be hiding a number they already saw. */
      ...mine.map((r) => intakeRow(r, linkOf(r), stock, { withMoney: true })),
      ...mrfs.map(mrfRow),
      ...spends.map(spendRow),
    ].sort(deskOrder);

    res.json({ success: true, requests });
  } catch (e) {
    console.error("[intake] list:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ══ RAISE ONE ══════════════════════════════════════════════════════════════
 * The whole point of this chunk: no request type, no account head, no store-
 * versus-purchase. What is needed, why, when, and how much of it.
 */
router.post("/", async (req, res) => {
  try {
    const emp = await requester(req);
    if (!emp) {
      return res.status(404).json({
        success: false,
        message: "Your staff record was not found. Ask HR to check it.",
      });
    }
    /* `requestedBy` is a required ref into `employees`, and a request has to
       belong to somebody who can be sent it back. A department account is
       neither. */
    if (refuseStandIn(res, emp, "Raising a request")) return;

    const b = req.body || {};
    const givenTitle = text(b.title, 200);
    const purpose = text(b.purpose, 1000);

    /* Lines first, matching the form's own order — a refusal that names the
       last field while the first is empty is a refusal somebody has to hunt. */
    const { lines, estimatedTotal, estimateComplete, error } = await buildLines(b.items);
    if (error) return res.status(400).json({ success: false, message: error });

    if (!purpose) {
      return res.status(400).json({ success: false, message: "Say what this is for." });
    }

    /* ── THE TITLE, WHEN NOBODY WROTE ONE ──────────────────────────────────
       For a one-line request the title and the item name are the same
       sentence, and demanding both is demanding it twice. A title is still
       accepted and still wins — a situation ("compressor on line 2 is making a
       noise") is a better summary than the part it needs. */
    const title =
      givenTitle ||
      (lines.length === 1
        ? lines[0].name
        : `${lines[0].name} +${lines.length - 1} more`);

    const priority = intake.PRIORITIES.includes(String(b.priority || "").toUpperCase())
      ? String(b.priority).toUpperCase()
      : "NORMAL";

    /* Product or service, and nothing else. An unrecognised value — `SOFTWARE`
       from an old client, say — is refused rather than quietly coerced: a
       request silently filed as the wrong kind is worse than one that failed
       to send. */
    const requestType = String(b.requestType || "PRODUCT").toUpperCase();
    if (!intake.REQUEST_TYPES.includes(requestType)) {
      return res.status(400).json({
        success: false,
        message: "Choose whether this is a product or a service.",
      });
    }

    const neededBy = b.neededBy ? new Date(b.neededBy) : null;
    if (neededBy && Number.isNaN(neededBy.getTime())) {
      return res.status(400).json({ success: false, message: "That needed-by date cannot be read." });
    }

    /* ── THE BUDGET HEAD, CHOSEN BY THE REQUESTER ───────────────────────────
       Named when the request is raised, not later. The chain that reviews it
       is reading a request that already says which envelope it comes out of —
       an approver asked to agree to a need AND invent its accounting head at
       the same moment is answering two questions with one click.

       What the requester may choose from is NOT the chart of accounts. It is
       their own department's approved allocations for the period in force —
       usually two or three lines — and the server checks the choice against
       that same list, so a ledger id typed into a payload buys nothing. See
       resolveHead and budgetCommitment.approvedHeadsFor.

       ── AND THERE IS NO WAY TO INVENT ONE FROM HERE ──────────────────────
       This door used to accept `unbudgetedHead` — a head asked for in free
       text, with a reason. It no longer does. A requester naming a head that
       does not exist is creating an accounting category from a stock-request
       form, and every one of those arrived at finance as a line nobody had
       agreed, spelled however the requester spelled it.

       A department with nothing approved is genuinely blocked here, and that
       is the intended answer: finance adds the head first. The refusal says
       so rather than offering a box to type in.

       The field is still honoured on the APPROVER's route and on the purchase
       door, which are different decisions made by different people — see the
       note on that block. */
    if (b.unbudgetedHead === true || b.requestedHeadName) {
      return res.status(400).json({
        success: false,
        code: "HEAD_NOT_REQUESTABLE",
        message:
          "A request has to name one of your department's approved budget heads. " +
          "New heads are added by finance, not from this form.",
      });
    }

    if (!b.ledgerId) {
      return res.status(400).json({
        success: false,
        message: "Choose the budget head this comes out of.",
      });
    }

    let headPatch;
    {
      const resolved = await resolveHead({
        department: emp.department,
        ledgerId: b.ledgerId,
        plannedItemKey: text(b.plannedItemKey, 80),
        plannedItemName: text(b.plannedItemName, 200),
        /* Every NEW request names the row it spends against. Old ones are
           readable without one; new ones are not writable without one. */
        requirePlannedItem: true,
      });
      if (resolved.error) return res.status(400).json({ success: false, message: resolved.error });
      headPatch = {
        unbudgetedHeadRequest: false,
        plannedItemKey: resolved.plannedItem.key,
        plannedItemName: resolved.plannedItem.name,
        /* A snapshot, like budgetSnapshot: the plan can be revised, and the
           figure the requester was answering has to survive that. */
        plannedItemAmount: resolved.plannedItem.amount,
        ledgerId: resolved.ledger._id,
        ledgerName: resolved.ledger.name,
        budgetCycleId: resolved.budgetId || undefined,
        budgetLineId: resolved.budgetLineId || undefined,
        budgetFinancialYear: resolved.financialYear || undefined,
        budgetDepartment: resolved.department || emp.department || "",
        budgetMatchStatus: "matched",
        /* What the requester was looking at when they chose it. */
        budgetSnapshot: resolved.snapshot,
      };
    }

    /* ── WHO HAS TO AGREE, INSIDE THIS DEPARTMENT ───────────────────────────
       The reporting line, walked upward from the requester and stopped at the
       edge of their own department: Soumya → Pramod → Rakesh, and never the
       CEO above Rakesh, who is not in IT.

       Built ONCE, here, and written onto the request. HR reorganises; a
       request in flight must not be re-routed underneath the people already
       looking at it. See approvalChain.service.

       An EMPTY chain is an answer, not a failure — it means nobody in the
       department stands above this person, so the request goes straight to
       Store. `chainStop` records which of the two empties it is. */
    let built = { chain: [], stop: "no_manager", stopReason: "", department: emp.department || "" };
    try {
      built = await intake.approvalChain.buildChain({
        requester: emp,
        load: (id) =>
          Employee.findById(id)
            .select("_id firstName middleName lastName name email biometricId identityId " +
                    "department departmentId designation jobTitle isActive status primaryManager")
            .lean(),
      });
    } catch (e) {
      console.error("[intake] approval chain could not be built:", e.message);
      built.stopReason = "The reporting line could not be read — sent to Store & Purchase.";
    }

    /* The stored approver fields keep their meaning — "who this is waiting for
       RIGHT NOW" — and are moved along as the chain advances. That is what
       lets the approvals queue, the notifications and every legacy reader work
       unchanged against a multi-step request. */
    const head = built.chain[0] || null;
    const approver = head
      ? {
          approverEmployee: head.employeeId,
          approverName: head.name,
          approverBiometricId: head.loginId,
          approverAltIds: head.altIds,
          approverResolution: "RESOLVED",
          approverResolutionNote: "",
        }
      : {
          approverEmployee: null,
          approverName: "",
          approverBiometricId: "",
          approverAltIds: [],
          approverResolution: "NO_MANAGER",
          approverResolutionNote:
            built.stop === "top_of_department" || built.stop === "outside_department"
              ? "You are the most senior person in your department, so this goes straight to Store & Purchase."
              : `${built.stopReason} Sent to Store & Purchase according to the fallback rule.`,
        };

    const viewer = await viewerOf(emp);
    const now = new Date();
    const fullName = mrfApprover.buildFullName(emp);

    const created = await IntakeRequest.create({
      title,
      purpose,
      requestType,
      note: text(b.note, 1000),
      requestedBy: emp._id,
      requestedByName: fullName,
      requestedById: emp.biometricId || emp.identityId || "",
      department: emp.department || "",
      neededBy,
      priority,
      /* The one fulfilment question the requester CAN answer, because it is
         about their own need and not about the company: will you need this
         again. The schedule is captured later, by whoever classifies it. */
      repeats: b.repeats === true,
      items: lines,
      estimatedTotal,
      estimateComplete,
      /* Waiting on the first approver, or straight to Store when there is
         nobody in the department above this person. */
      status: intake.startingStatus({ chainLength: built.chain.length }),
      approvalChain: built.chain,
      currentApproverIndex: 0,
      chainStop: built.stop,
      chainStopReason: built.stopReason,
      ...approver,
      ...headPatch,
      submittedAt: now,
      history: [{ at: now, by: emp._id, byName: fullName, action: "submitted", note: "" }],
    });

    res.status(201).json({
      success: true,
      request: intakeRow(created.toObject(), null, null, { withMoney: true }),
    });
  } catch (e) {
    console.error("[intake] create:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * The lines, checked and estimated.
 *
 * Refuses with the line number and what is missing, because "invalid request"
 * on a form with six lines is a hunt.
 *
 * A rate is OPTIONAL here and mandatory on a spend request, which is the
 * difference between the two documents in one field: at intake nobody knows
 * yet whether this costs the company anything, and a required rate would make
 * the requester invent one for a box of blades the store already holds.
 */
async function buildLines(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "Add at least one thing you need." };
  }
  if (raw.length > 30) return { error: "That is more than thirty lines — split it up." };

  const lines = [];
  let estimatedTotal = 0;
  let estimateComplete = true;

  /* ── THE ONES THEY RECOGNISED ────────────────────────────────────────────
     A picked catalogue item is verified against the catalogue, never trusted
     from the body: an id typed into a payload could name anything, and the
     store would go and issue it. An unrecognised id is dropped rather than
     refused — the line still says what they need, and describing something the
     store has never stocked was always allowed. */
  const pickedIds = raw
    .map((r) => r?.rawItemId)
    .filter((id) => id && mongoose.isValidObjectId(id));
  const catalogue = pickedIds.length
    ? new Map(
        (
          await RawItem.find({ _id: { $in: pickedIds } })
            .select("_id name sku unit customUnit")
            .lean()
        ).map((it) => [String(it._id), it]),
      )
    : new Map();

  for (const [i, r] of raw.entries()) {
    const at = `Line ${i + 1}`;
    const picked = r?.rawItemId ? catalogue.get(String(r.rawItemId)) : null;
    /* The catalogue's name wins over whatever is in the box. They are usually
       the same; when they are not it is because somebody typed over a pick,
       and the store must issue what was picked. */
    const name = picked ? picked.name : text(r?.name, 200);
    if (!name) return { error: `${at}: name what you need.` };

    const quantity = num(r?.quantity);
    if (quantity === null || quantity <= 0) return { error: `${at}: add a quantity.` };

    const unit = text(r?.unit, 40);
    if (!unit) return { error: `${at}: say what the quantity is in — pieces, metres, hours.` };

    const rate = r?.rate === "" || r?.rate === undefined || r?.rate === null ? null : num(r.rate);
    if (r?.rate !== "" && r?.rate !== undefined && r?.rate !== null && (rate === null || rate < 0)) {
      return { error: `${at}: that estimated rate cannot be read.` };
    }

    if (rate === null) estimateComplete = false;
    else estimatedTotal += quantity * rate;

    lines.push({
      name,
      rawItem: picked ? picked._id : null,
      rawItemSku: picked ? picked.sku || "" : "",
      baseUnit: picked ? picked.customUnit || picked.unit || "" : "",
      quantity,
      unit,
      ...(rate === null ? {} : { rate }),
      note: text(r?.note, 500),
      images: cleanImages(r?.images),
    });
  }

  return {
    lines,
    estimatedTotal: Math.round(estimatedTotal * 100) / 100,
    /* A total nobody could complete is not a total. Saying so beats printing a
       confident figure that quietly treats a missing rate as zero. */
    estimateComplete: estimateComplete && estimatedTotal > 0,
    error: null,
  };
}

/* ══ WAITING ON ME ══════════════════════════════════════════════════════════
 * One queue across all three collections. Somebody who is a TL and a finance
 * approver sees both steps, and each row says which of the two their yes would
 * be — asking three endpoints would have meant the screen guessing which
 * answer to show when a person wears two hats.
 */
router.get("/approvals", async (req, res) => {
  try {
    const emp = await requester(req);
    /* Not an error — but never a bare empty list either. An unidentified
       caller and a caller with nothing waiting are DIFFERENT ANSWERS, and
       sending the same payload for both is what let the CEO read "no requests"
       for a request that was sitting right there. The flag lets the desk say
       which of the two it is. */
    if (!emp) return res.json({ success: true, requests: [], identityMissing: true });
    const viewer = await viewerOf(emp);

    /* ── THE THREE QUEUES ────────────────────────────────────────────────
       Intake: what is ADDRESSED TO ME at the TL step — the manager stored on
               the request when it was raised, not whoever happens to manage
               that person today. Legacy rows that named nobody fall back to
               the live reporting line; see tlRouting.service.
       MRF:    the same rule, which is where it came from.
       Spend:  the same rule at the TL step, everything at the finance step. */
    const intakeClause = intake.tlRouting.tlQueueClause({
      viewer,
      statuses: [intake.PENDING_TL],
    });
    const spendTlClause = chain.tlRouting.tlQueueClause({
      viewer,
      statuses: [chain.PENDING_TL, chain.LEGACY_SUBMITTED],
    });

    const [intakeRows, mrfs, spends] = await Promise.all([
      intakeClause
        ? IntakeRequest.find(intakeClause).sort({ createdAt: 1 }).limit(100).lean()
        : [],
      /* MRF names its requester `requestedForId` rather than `requestedById`,
         so the shared clause is built against that field and then renamed —
         one rule, one vocabulary difference, admitted in one place. Without
         the legacy half, an MRF raised before approver routing existed would
         show on the MRF app's own queue and not on this desk. */
      (() => {
        const c = intake.tlRouting.tlQueueClause({ viewer, statuses: ["PENDING"] });
        if (!c) return [];
        const renamed = {
          status: c.status,
          $or: c.$or.map((branch) =>
            branch.$and
              ? {
                  $and: [
                    branch.$and[0],
                    { requestedForId: branch.$and[1].requestedById },
                  ],
                }
              : branch,
          ),
          ...(c.requestedById ? { requestedForId: c.requestedById } : {}),
        };
        return MRF.find(renamed).sort({ createdAt: 1 }).limit(100).lean();
      })(),
      (() => {
        const or = [];
        if (spendTlClause) or.push(spendTlClause);
        if (viewer.isFinance) or.push({ status: chain.PENDING_FINANCE });
        return or.length
          ? SpendRequest.find({ $or: or }).sort({ createdAt: 1 }).limit(100).lean()
          : [];
      })(),
    ]);

    /* Every queue row says which of the two approvals this is AND what that
       approval means. The second half matters more than it looks: a manager
       who thinks they are approving the spend approves differently from one
       who knows the store may have it on the shelf. */
    const atStep = (row, step) => ({
      ...row,
      step,
      /* Named for what the person actually is on this row. "Your approval"
         alone said nothing about WHY it was theirs, and the whole point of
         this step is that it is theirs because they are this requester's own
         manager — not because they hold a role or share a department. */
      /* Why THIS person is looking at it. "Your approval" said nothing about
         which approval, and on a chain that is most of the information: being
         the second of two is a different act from being the first, because
         the second one releases the request to Store. */
      stepLabel:
        step === "finance"
          ? "Finance approval"
          : chainStepLabel(row) || "Your turn: department approval",
      stepNote: STEP_NOTE[step],
    });

    const stock = await stockFor(intakeRows);

    const requests = [
      /* The department's own managers, deciding whether the department needs
         this. What is left on the head is exactly the context that decision
         turns on. */
      ...intakeRows.map((r) => atStep(intakeRow(r, null, stock, { withMoney: true }), "tl")),
      ...mrfs.map((m) => atStep(mrfRow(m), "tl")),
      ...spends.map((sp) => {
        const verdict = chain.decisionFor({ request: sp, viewer });
        const step = verdict.step || (sp.status === chain.PENDING_FINANCE ? "finance" : "tl");
        return atStep(spendRow(sp), step);
      }),
    ]
      /* Somebody cannot approve their own request at any step. Filtered here
         rather than only refused on the action, so a request never appears in
         a queue its owner cannot act on. */
      .filter((r) => String(r.requestedById || "") !== String(viewer.employeeId))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    res.json({
      success: true,
      requests,
      counts: {
        tl: requests.filter((r) => r.step === "tl").length,
        finance: requests.filter((r) => r.step === "finance").length,
      },
    });
  } catch (e) {
    console.error("[intake] approvals:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ══ THE TL STEP ════════════════════════════════════════════════════════════
 * Does this department actually need it. Nothing about money, nothing about
 * how it will be got — those are the next two people's questions.
 */
async function decide(req, res, outcome) {
  const emp = await requester(req);
  if (!emp) return res.status(404).json({ success: false, message: "Your staff record was not found." });
  /* The chain is built from employees, so a stand-in is in nobody's chain and
     would be refused a step or two below anyway — but as "it is not your turn",
     which is a misleading way to say "we do not know who you are". */
  if (refuseStandIn(res, emp, "Approving a request")) return;

  const doc = await IntakeRequest.findById(req.params.id);
  if (!doc) return res.status(404).json({ success: false, message: "Request not found." });

  const viewer = await viewerOf(emp);
  const verdict = intake.decisionFor({ request: doc, viewer });
  if (!verdict.can) return res.status(403).json({ success: false, message: verdict.reason });

  const note = text(req.body?.note, 500);
  /* A rejection owes a reason. An approval does not — a forced one produces
     "ok", which reads like a reason and is not. */
  if (outcome === "rejected" && !note) {
    return res.status(400).json({ success: false, message: "Say why you are rejecting it." });
  }

  const now = new Date();
  const who = mrfApprover.buildFullName(emp);

  if (outcome === "rejected") {
    /* A no anywhere in the chain ends it. The request goes back to the
       requester rejected rather than on to whoever is next: asking somebody
       more senior to overturn their own report in the same queue is not an
       escalation path, it is an argument with no owner. */
    const step = intake.approvalChain.currentStep(doc);
    if (step) {
      step.status = "rejected";
      step.rejectedAt = now;
      step.note = note;
    }
    doc.status = intake.REJECTED;
    doc.decidedAt = now;
    doc.decidedBy = emp._id;
    doc.decidedByName = who;
    doc.decisionNote = note;
  } else {
    /* ── THE HEAD IS ALREADY ON THE REQUEST, AND MAY BE CORRECTED ─────────
       The requester chose it when they raised this, from their department's
       own approved allocations. An approver reading the request may disagree
       — they hold the envelope and see more of it — so a head posted here
       REPLACES the one on the request, checked against the same list.

       Optional, because it is a correction rather than a question. Posting
       nothing leaves the requester's choice standing, which is the ordinary
       case and is why the approval screen is one click again. */
    const b = req.body || {};
    const asksForNewHead = b.unbudgetedHead === true;
    const correctingHead = asksForNewHead || Boolean(b.ledgerId);

    if (!correctingHead) {
      /* Nothing posted, and nothing on the request either — only possible on a
         row raised before the requester was asked for one. It cannot go on to
         Store without a head, so it is refused here with the reason. */
      const has = Boolean(doc.ledgerId) || (doc.unbudgetedHeadRequest && doc.requestedHeadName);
      if (!has) {
        return res.status(400).json({
          success: false,
          message:
            "This request has no budget head. Choose one of the department's approved heads, or ask for a new one.",
        });
      }
    } else if (asksForNewHead) {
      const ready = intake.readyToApprove({
        ledgerId: b.ledgerId,
        unbudgetedHead: true,
        requestedHeadName: b.requestedHeadName,
        requestedHeadReason: b.requestedHeadReason,
      });
      if (!ready.ok) return res.status(400).json({ success: false, message: ready.reason });
    }

    if (asksForNewHead) {
      doc.unbudgetedHeadRequest = true;
      doc.requestedHeadName = text(b.requestedHeadName, 200);
      doc.requestedHeadReason = text(b.requestedHeadReason, 1000);
      doc.ledgerId = undefined;
      doc.ledgerName = doc.requestedHeadName;
      /* A head nobody has approved yet has no line, no cycle and no figures.
         Recorded as such rather than left blank: `no_budget_line` is the same
         word SpendRequest uses, and it is not a refusal — it is a real request
         finance has to see. */
      doc.budgetCycleId = undefined;
      doc.budgetLineId = undefined;
      doc.budgetFinancialYear = undefined;
      doc.budgetDepartment = doc.department || "";
      doc.budgetMatchStatus = "no_budget_line";
      doc.budgetSnapshot = undefined;
    } else if (correctingHead) {
      const head = await resolveHead({ department: doc.department, ledgerId: b.ledgerId });
      if (head.error) return res.status(400).json({ success: false, message: head.error });

      doc.unbudgetedHeadRequest = false;
      doc.ledgerId = head.ledger._id;
      doc.ledgerName = head.ledger.name;
      /* ── THE WHOLE ADDRESS, NOT HALF OF IT ────────────────────────────
         Cycle AND line, because a line id alone cannot be looked up; the
         canonical department, because that is what the money is filed under;
         and the match status in SpendRequest's own vocabulary, so the request
         and the spend request it becomes say the same thing. */
      doc.budgetCycleId = head.budgetId || undefined;
      doc.budgetLineId = head.budgetLineId || undefined;
      doc.budgetFinancialYear = head.financialYear || undefined;
      doc.budgetDepartment = head.department || doc.department || "";
      doc.budgetMatchStatus = "matched";
      /* What the manager was actually looking at. Not the figures the head
         carries months later, which is a different statement. */
      doc.budgetSnapshot = head.snapshot;
    }

    /* ── AND MAY CORRECT THE KIND ────────────────────────────────────────
       Product and service are easy to mix up from the requester's side — a
       compressor repair typed as a product, a part typed as a service — and
       the manager is reading it anyway. Only these two; nothing here can
       invent a third. */
    if (b.requestType) {
      const t = String(b.requestType).toUpperCase();
      if (!intake.REQUEST_TYPES.includes(t)) {
        return res.status(400).json({
          success: false,
          message: "A request is either a product or a service.",
        });
      }
      doc.requestType = t;
    }

    /* ── ONE STEP OF THE CHAIN ────────────────────────────────────────────
       Mark THIS approver answered and move to the next. Only when the last
       one has agreed does the request leave the department. */
    const step = intake.approvalChain.currentStep(doc);
    if (step) {
      step.status = "approved";
      step.approvedAt = now;
      step.note = note || undefined;
    }

    /* `tlApproved*` keeps its meaning across both shapes: the LAST department
       approval. On a single-step chain that is the same event it always was,
       so MRF, the spend request and every screen that reads it carry on
       unchanged; on a longer one it is the approval that released the request,
       which is the one those documents are recording. */
    const move = step
      ? intake.approvalChain.advance(doc)
      : { done: true, nextIndex: 0, next: null };

    if (move.done) {
      doc.tlApprovedBy = emp._id;
      doc.tlApprovedByName = who;
      doc.tlApprovedAt = now;
      /* Approved by the department, and now a question for the people who know
         how things get got. Nobody has agreed to spend anything: this may yet
         turn out to be a box the store already has, in which case the head is
         simply never used. */
      doc.status = intake.NEEDS_CLASSIFICATION;
    } else {
      doc.currentApproverIndex = move.nextIndex;
      /* The stored approver fields always name who it is waiting for RIGHT
         NOW. Moving them along is what lets the approvals queue, the
         notifications and every legacy reader work unchanged against a
         multi-step request. */
      doc.approverEmployee = move.next.employeeId || null;
      doc.approverName = move.next.name || "";
      doc.approverBiometricId = move.next.loginId || "";
      doc.approverAltIds = move.next.altIds || [];
      doc.status = intake.PENDING_TL;
    }
  }

  doc.history.push({
    at: now,
    by: emp._id,
    byName: who,
    action: outcome === "rejected" ? "rejected at tl" : "approved at tl",
    note:
      outcome === "rejected"
        ? note
        : [note, doc.ledgerName ? `head: ${doc.ledgerName}` : null].filter(Boolean).join(" · "),
  });
  await doc.save();

  res.json({ success: true, request: intakeRow(doc.toObject(), null, null, { withMoney: true }) });
}

router.patch("/:id/approve", async (req, res) => {
  try {
    await decide(req, res, "approved");
  } catch (e) {
    console.error("[intake] approve:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

router.patch("/:id/reject", async (req, res) => {
  try {
    await decide(req, res, "rejected");
  } catch (e) {
    console.error("[intake] reject:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ══ TO FULFIL ══════════════════════════════════════════════════════════════
 * Everything the TL has agreed the department needs, waiting for somebody to
 * say how it gets got.
 */
router.get("/fulfilment", async (req, res) => {
  try {
    const emp = await requester(req);
    /* Not an error — but never a bare empty list either. An unidentified
       caller and a caller with nothing waiting are DIFFERENT ANSWERS, and
       sending the same payload for both is what let the CEO read "no requests"
       for a request that was sitting right there. The flag lets the desk say
       which of the two it is. */
    if (!emp) return res.json({ success: true, requests: [], identityMissing: true });

    const viewer = await viewerOf(emp);
    if (!viewer.canFulfil) {
      return res.status(403).json({
        success: false,
        message: "Only Store & Purchase or finance can see the classification queue.",
      });
    }

    const rows = await IntakeRequest.find({ status: intake.NEEDS_CLASSIFICATION })
      .sort({ neededBy: 1, createdAt: 1 })
      .limit(150)
      .lean();
    const stock = await stockFor(rows);

    res.json({
      success: true,
      /* ── STORE SEES NO BALANCES ────────────────────────────────────────
         The fulfilment queue is Store's screen. They match stock and price a
         quote; whether the company can afford it is finance's question, asked
         after the quote arrives. A finance approver who also has fulfilment
         access is a finance approver, and keeps the figures.

         Stripped from the RESPONSE, not from the screen — a field that never
         leaves the server cannot be read out of the network tab. */
      requests: rows.map((r) => intakeRow(r, null, stock, { withMoney: viewer.isFinance })),
      /* The four ways out, named for the screen. Sent rather than hard-coded in
         the client so the vocabulary has one home. */
      kinds: intake.KIND_IDS.map((id) => ({
        id,
        label: intake.KINDS[id].label,
        needsFinance: intake.KINDS[id].needsFinance,
        needsSchedule: Boolean(intake.KINDS[id].needsSchedule),
      })),
      frequencies: intake.FREQUENCIES.map((id) => ({
        id,
        label: intake.FREQUENCY_LABEL[id],
      })),
      types: intake.REQUEST_TYPES.map((id) => ({
        id,
        label: intake.REQUEST_TYPE_LABEL[id],
        hint: intake.REQUEST_TYPE_HINT[id],
      })),
    });
  } catch (e) {
    console.error("[intake] fulfilment:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ── THE HEADS THIS REQUEST MAY BE CHARGED TO ────────────────────────────────
 * Scoped to the REQUESTER's department, never the classifier's. A store person
 * classifying a Tech request is spending Tech's envelope, and offering them
 * Store's heads would file it against the wrong one — which does not fail, it
 * just quietly makes a budget report wrong.
 *
 * The same source the classification checks against, so the picker cannot
 * offer a head the server will then refuse.
 */
router.get("/:id/budget-heads", async (req, res) => {
  try {
    const emp = await requester(req);
    if (!emp) return res.status(404).json({ success: false, message: "Your staff record was not found." });

    const doc = await IntakeRequest.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ success: false, message: "Request not found." });

    /* ── WHO NEEDS THIS LIST ─────────────────────────────────────────────
       The requester's own manager, who now chooses the head at approval — and
       still Store and finance, who read it on a request they are fulfilling
       or paying for. Deliberately NOT the requester: the whole point of
       moving the choice up a level is that they were never the right person
       to make it. */
    const viewer = await viewerOf(emp);
    const isTheirManager = viewer.managedIds.map(String).includes(String(doc.requestedById));
    if (!viewer.canFulfil && !isTheirManager) {
      return res.status(403).json({
        success: false,
        message: "Only the requester's manager, Store & Purchase or finance can see these heads.",
      });
    }

    const { company, error } = await theCompany();
    if (error) return res.status(409).json({ success: false, message: error });

    const { heads, reason } = await budgetMatch.approvedHeadsFor({
      companyId: company._id,
      department: doc.department || "",
    });

    res.json({
      success: true,
      department: doc.department || "",
      /* Why the list is empty, and the sentence to show for it. Composed here
         rather than in the picker so the manager reads the same words wherever
         the list is short — and so "nothing is approved" is stated rather than
         being inferred from a dropdown with no options in it, which reads as a
         screen that has not finished loading. */
      reason: heads.length ? null : reason || "no_lines",
      emptyMessage: heads.length
        ? null
        : "No approved budget heads for this department yet.",
      /* Off the heads themselves. `approvedHeadsFor` answers `{heads, reason}`
         and never a year of its own — destructuring one out of it produced an
         undefined that rendered as a blank in the picker's hint. */
      financialYear: heads.find((h) => h.financialYear)?.financialYear || null,
      heads: heads.map((h) => ({
        ledgerId: String(h.ledgerId),
        /* The service calls it `name`. Reading `ledgerName` off it gave every
           option in the classification dropdown an empty label — the picker
           listed the right heads and showed none of their names. */
        ledgerName: h.name,
        approved: h.approved,
        committed: h.committed,
        actual: h.actual,
        available: h.available,
      })),
    });
  } catch (e) {
    console.error("[intake] budget-heads:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * The books this request belongs to.
 *
 * One company today, and this asks rather than assumes: with several, an
 * employee's session says nothing about which set of books their spend belongs
 * to, and picking the first would file it against whichever happened to be
 * created first.
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

/* ══ CLASSIFY ═══════════════════════════════════════════════════════════════
 * The internal decision the requester was never asked to make. This is where
 * the request stops being one shape and becomes the document that fulfils it.
 */
router.patch("/:id/classify", async (req, res) => {
  try {
    const emp = await requester(req);
    if (!emp) return res.status(404).json({ success: false, message: "Your staff record was not found." });

    const doc = await IntakeRequest.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: "Request not found." });

    const viewer = await viewerOf(emp);
    const allowed = intake.classificationFor({ request: doc, viewer });
    if (!allowed.can) return res.status(403).json({ success: false, message: allowed.reason });

    const b = req.body || {};

    /* ── THE ROUTE IS DERIVED, NOT DECLARED ─────────────────────────────────
       Store says what it can ISSUE; the route follows from that. All of it off
       the shelf is a stock issue, none of it is a purchase, some of it is
       both — which is an arithmetic question, not a judgement, and asking
       somebody to answer it twice (once as a quantity, once as a category) is
       how the two answers end up contradicting each other.

       Derived on the SERVER as well as in the browser, because a client that
       posts `kind: store_issue` alongside an issue quantity of zero is either
       out of date or lying, and the quantities are the thing that has to be
       true — they are what the MRF and the spend request are built from.

       `issue` absent entirely means the caller predates this and is naming the
       kind directly. Those still work: the material desk and every existing
       test post a kind. */
    /* ── TWO SHAPES, ONE RULE ───────────────────────────────────────────────
       `lines` is what the store's fulfilment form posts: per requested line,
       which inventory item it matched to, how much of it is being issued, and
       what the balance should be called when it is bought. `issue` is the
       thinner shape that came before it — quantities only — and still works.
       Both reduce to the same two maps, so the route inference below reads one
       thing however the caller wrote it. */
    const linesPosted = b.lines && typeof b.lines === "object";
    const issuePosted = linesPosted || (b.issue && typeof b.issue === "object");
    const issueQty = new Map();
    const buyQty = new Map();
    /* What the store decided ABOUT each line, as opposed to how much of it.
       Carried separately because it lands on two different documents: the
       matched inventory item goes on the MRF, the proposed name goes on the
       spend request. */
    const lineSpec = new Map();
    let derivedKind = null;

    if (issuePosted) {
      const isService = String(doc.requestType || "").toUpperCase() === "SERVICE";
      let totalIssue = 0;
      let totalBuy = 0;

      /* ── THE MATCHED ITEMS MUST BE REAL, AND MUST HAVE THE STOCK ────────
         Read once, in bulk, before anything is written. A rawItemId that is
         not in the catalogue would otherwise reach the MRF as a dangling ref
         and read back as a deleted item; a quantity above what is on the shelf
         would drive stock negative, which this system does not do. */
      const wantedIds = [];
      if (linesPosted) {
        for (const [i, l] of (doc.items || []).entries()) {
          const spec = b.lines[String(l._id)] ?? b.lines[String(i)] ?? {};
          if (spec && spec.rawItemId && mongoose.isValidObjectId(spec.rawItemId)) {
            wantedIds.push(spec.rawItemId);
          }
        }
      }
      const stockById = new Map();
      if (wantedIds.length) {
        const found = await RawItem.find({ _id: { $in: wantedIds } })
          .select("_id name sku quantity unit customUnit")
          .lean()
          .catch(() => []);
        for (const it of found) stockById.set(String(it._id), it);
      }

      for (const [i, l] of (doc.items || []).entries()) {
        const asked = num(l.quantity) || 0;
        const spec = linesPosted
          ? b.lines[String(l._id)] ?? b.lines[String(i)] ?? {}
          : {};

        /* ── A LINE THE STORE CANNOT GET ─────────────────────────────────
           Taken out of the arithmetic entirely: it is neither issued nor
           bought, so it contributes nothing to the route, nothing to the MRF
           and nothing to the quote. The reason is mandatory — an unexplained
           refusal on one line of five is the one the requester will chase. */
        if (spec.cannotFulfil) {
          const why = text(spec.reason, 500);
          if (!why) {
            return res.status(400).json({
              success: false,
              message: `${l.name}: say why the store cannot fulfil this line. The requester sees it.`,
            });
          }
          issueQty.set(i, 0);
          buyQty.set(i, 0);
          lineSpec.set(i, { cannotFulfil: true, reason: why });
          continue;
        }
        const raw = linesPosted
          ? spec.issueQty ?? 0
          : b.issue[String(l._id)] ?? b.issue[String(i)] ?? 0;
        const issued = num(raw) || 0;

        /* ── THE ITEM THIS LINE WAS MATCHED TO ─────────────────────────── */
        let matched = null;
        if (spec.rawItemId) {
          if (!mongoose.isValidObjectId(spec.rawItemId) || !stockById.has(String(spec.rawItemId))) {
            return res.status(400).json({
              success: false,
              message: `${l.name}: that inventory item is not in the catalogue.`,
            });
          }
          matched = stockById.get(String(spec.rawItemId));
        }
        if (issued > 0 && !matched && linesPosted) {
          return res.status(400).json({
            success: false,
            message: `${l.name}: choose which inventory item is being issued before entering a quantity.`,
          });
        }
        if (matched && issued > 0) {
          const onHand = num(matched.quantity) || 0;
          if (issued > onHand) {
            return res.status(400).json({
              success: false,
              message: `${l.name}: only ${onHand} of ${matched.name} is in store, so ${issued} cannot be issued.`,
            });
          }
        }

        if (
          spec.gstPercent !== undefined &&
          spec.gstPercent !== null &&
          spec.gstPercent !== "" &&
          (num(spec.gstPercent) === null || num(spec.gstPercent) < 0 || num(spec.gstPercent) > 28)
        ) {
          return res.status(400).json({
            success: false,
            message: `${l.name}: GST is between 0 and 28 percent.`,
          });
        }

        lineSpec.set(i, {
          rawItemId: matched ? matched._id : null,
          rawItemName: matched ? matched.name : "",
          rawItemSku: matched ? matched.sku || "" : "",
          /* What the bought half should be called. Blank falls back to the
             requester's own words, which is the right default: they described
             the thing, and the store proposing a different name is a decision
             rather than a formality. */
          newItemName: text(spec.newItemName, 200),
          /* ── THE QUOTE, AS A FILE ─────────────────────────────────────
             Metadata only, and everything that says WHO is stamped from the
             session below — a client that could name the uploader could name
             somebody else. Capped, so one line cannot carry a folder. */
          attachments: Array.isArray(spec.attachments)
            ? spec.attachments
                .filter((a) => a && typeof a.fileId === "string" && a.fileId.trim())
                .slice(0, 5)
                .map((a) => ({
                  fileId: text(a.fileId, 200),
                  fileName: text(a.fileName, 200),
                  fileType: text(a.fileType, 100),
                  fileSize: num(a.fileSize) || undefined,
                  /* ── A KNOWN KIND, OR "other" ─────────────────────────
                     A supplier's quote and a photograph of the thing answer
                     different questions, and the requester's card groups them
                     by this. A free-text label would let one client write
                     "Quote" and another "quotation", and the grouping would
                     silently stop working. */
                  label: ["quote", "photo", "spec"].includes(String(a.label || "").trim())
                    ? String(a.label).trim()
                    : "other",
                }))
            : [],
          /* What Store suggests instead, on a line they cannot get. Optional:
             sometimes there simply is no alternative, and inventing one to
             fill a box would be worse than the honest blank. */
          alternative: text(spec.alternative, 300),
          /* Size, grade, model — what a vendor needs to quote the right
             thing. The requester's own note stands in when the store adds
             nothing, rather than the line reaching a vendor bare. */
          spec: text(spec.spec, 300),
          /* ── THIS LINE'S OWN QUOTE ────────────────────────────────────
             A request with two lines is often two vendors. Captured per
             line; the request-level fields below become a summary of these
             rather than the place the terms live. */
          suggestedVendorName: text(spec.suggestedVendorName, 200),
          vendorNote: text(spec.vendorNote, 300),
          vendorName: text(spec.vendorName, 200),
          /* ── THE VENDOR BECOMES A REAL RECORD, NOT JUST A STRING ────────
             The picker already tells Store "it will be recorded as a new
             supplier" for a typed name — resolved here, once, so a name typed
             on one request and picked from the list on the next are provably
             the same supplier rather than two records that quietly diverge. */
          vendorId: await vendorResolve.resolveVendor({
            vendorId: spec.vendorId,
            vendorName: text(spec.vendorName, 200),
            gstin: text(spec.gstin, 20),
            createdBy: emp._id,
          }),
          gstin: text(spec.gstin, 20),
          quoteRef: text(spec.quoteRef, 60),
          gstPercent:
            spec.gstPercent === undefined || spec.gstPercent === null || spec.gstPercent === ""
              ? null
              : num(spec.gstPercent),
          expectedDeliveryDate: spec.expectedDeliveryDate || null,
          rate: num(spec.rate),
        });

        if (issued < 0) {
          return res.status(400).json({
            success: false,
            message: `${l.name}: the quantity issued cannot be negative.`,
          });
        }
        if (issued > asked) {
          return res.status(400).json({
            success: false,
            message: `${l.name}: you cannot issue ${issued} against a request for ${asked}.`,
          });
        }
        /* A service is never issued off a shelf. Refused rather than silently
           zeroed, so a client that offers the field on the wrong form is told
           about it instead of quietly producing the wrong route. */
        if (isService && issued > 0) {
          return res.status(400).json({
            success: false,
            message: "A service cannot be issued from stock.",
          });
        }

        issueQty.set(i, issued);
        buyQty.set(i, Math.round((asked - issued) * 1000) / 1000);
        totalIssue += issued;
        totalBuy += asked - issued;
      }

      /* ── EVERY LINE REFUSED IS A REFUSED REQUEST ───────────────────────
         Nothing is being issued and nothing bought, so there is no document
         for this to become. It takes the same door a request-level refusal
         takes, with the line reasons collected into one sentence — rather
         than producing an empty MRF or a spend request for zero. */
      const refused = [...lineSpec.entries()].filter(([, v]) => v.cannotFulfil);
      if (refused.length === (doc.items || []).length && refused.length > 0) {
        return await returnRequest({
          res,
          doc,
          emp,
          reason: refused
            .map(([i, v]) => `${doc.items[i].name}: ${v.reason}`)
            .join(" · "),
          lineSpec,
        });
      }

      if (totalIssue > 0 && totalBuy > 0) derivedKind = "partial";
      else if (totalIssue > 0) derivedKind = "store_issue";
      else derivedKind = isService ? "service" : "purchase";
    }

    const kindId = String(derivedKind || b.kind || "").toLowerCase();
    const kind = intake.kindOf(kindId);
    if (!kind) {
      return res.status(400).json({
        success: false,
        message: "Say how this gets fulfilled — from stock, bought, a service, or something recurring.",
      });
    }

    const schedule = kind.needsSchedule
      ? {
          frequency: String(b.frequency || "").toUpperCase(),
          startsOn: b.startsOn ? new Date(b.startsOn) : null,
          endsOn: b.endsOn ? new Date(b.endsOn) : null,
          note: text(b.scheduleNote, 500),
        }
      : null;

    /* ── THE HEAD IS THE MANAGER'S, AND IS READ HERE ─────────────────────
       Store no longer chooses it. What is checked is that one is actually
       there — a request that arrived without one cannot become a spend
       request, and letting Store invent one would hand the choice back to the
       person on this chain who knows the department's budget least.

       `ledgerId` OR a named unbudgeted ask both count: the second is a real
       decision the manager made, not a gap. */
    const hasApprovedHead =
      Boolean(doc.ledgerId) ||
      (doc.unbudgetedHeadRequest === true && Boolean(doc.requestedHeadName));

    const ready = intake.readyToClassify({
      kind: kindId,
      hasApprovedHead,
      schedule,
    });
    if (!ready.ok) return res.status(400).json({ success: false, message: ready.reason });

    const now = new Date();
    const who = mrfApprover.buildFullName(emp);
    const note = text(b.note, 500);

    /* ── CLASSIFYING IS THE ONE WRITE A DEPARTMENT ACCOUNT MAY DO ───────────
       It is a decision about how the company fulfils something, not a personal
       act, and the board and Store hold that grant by department. So a
       stand-in gets through — but it has no `employees` row to point at, and a
       ref to an id that is not in that collection reads back as a deleted
       employee. The NAME carries the accountability instead, which is what
       every screen actually renders. */
    const whoId = emp._id || null;

    const stamp = () => {
      /* The lines that could not be got, recorded on the request itself. The
         requester's screen reads these — a short delivery with no explanation
         is the thing this exists to prevent. */
      for (const [i, v] of lineSpec.entries()) {
        if (!v.cannotFulfil || !doc.items[i]) continue;
        doc.items[i].unfulfilled = true;
        doc.items[i].unfulfilledReason = v.reason;
        doc.items[i].unfulfilledAt = now;
        doc.items[i].unfulfilledByName = who;
      }
      doc.fulfilmentKind = kind.id;
      doc.classifiedBy = whoId;
      doc.classifiedByName = who;
      doc.classifiedAt = now;
      doc.classificationNote = note;
      doc.status = kind.status;
      doc.history.push({
        at: now,
        by: whoId,
        byName: who,
        action: `classified as ${kind.label.toLowerCase()}`,
        note,
      });
    };

    /* ── STOCK THE COMPANY ALREADY OWNS ─────────────────────────────────────
       Becomes an MRF, already TL-approved, sitting with the store exactly
       where an MRF approved through the material app sits. No finance step,
       because nothing leaves the bank account. */
    if (kind.becomes === "mrf") {
      const mrf = await spawnMrf({
        doc,
        classifier: emp,
        classifierName: who,
        now,
        issueQty: issuePosted ? issueQty : null,
        lineSpec,
      });
      doc.mrfId = mrf._id;
      doc.mrfNumber = mrf.mrfNumber;
      stamp();
      await doc.save();
      return res.json({
        success: true,
        request: intakeRow(doc.toObject(), { kind: "mrf", status: mrf.status }),
        message: `${mrf.mrfNumber} is with the store — no finance approval needed for stock we already hold.`,
      });
    }

    /* ── PART OF IT IS ON THE SHELF ────────────────────────────────────────
       Two documents out of one request: the MRF for what the store is issuing
       today, the spend request for the balance.

       The MRF is created FIRST and deliberately so. If the spend half fails —
       a withdrawn budget head, a rate that will not parse — the store has
       already been told to hand over eight of the twenty, and that is a real
       instruction somebody may have acted on. Creating the cheap, no-approval
       half first and reporting the failure of the expensive half is the order
       that leaves the least wrong behind; the reverse would leave a spend
       request with finance for a balance nobody is issuing against. */
    if (kind.becomes === "both") {
      const mrf = await spawnMrf({
        doc, classifier: emp, classifierName: who, now, issueQty, lineSpec,
      });

      const { spend, error: partialError } = await spawnSpend({
        doc, kind, body: b, schedule, classifier: emp, classifierName: who, now, buyQty, lineSpec,
      });
      if (partialError) {
        /* The MRF stands and the request stays in the queue: the store may
           correct the rate and send the balance again, and the issue half does
           not have to be redone. Said plainly rather than as a bare error, or
           somebody re-issues stock that is already on its way out. */
        return res.status(400).json({
          success: false,
          message: `${mrf.mrfNumber} was raised for the stock you are issuing, but the balance could not be sent on: ${partialError}`,
        });
      }

      doc.mrfId = mrf._id;
      doc.mrfNumber = mrf.mrfNumber;
      doc.spendRequestId = spend._id;
      doc.spendRequestNumber = spend.requestNumber;
      stamp();
      await doc.save();

      return res.json({
        success: true,
        request: intakeRow(doc.toObject(), { kind: "spend", status: spend.status }),
        message: `${mrf.mrfNumber} is with the store for what you have, and ${spend.requestNumber} is with finance for the balance.`,
      });
    }

    /* ── SOMETHING THAT LEAVES THE BANK ACCOUNT ─────────────────────────────
       Becomes a spend request at the FINANCE step. The TL already agreed the
       department needs it; asking them again would be the same person
       answering the same question twice, so their yes is carried across rather
       than reset. */
    const { spend, error } = await spawnSpend({
      doc,
      kind,
      body: b,
      schedule,
      classifier: emp,
      classifierName: who,
      now,
      /* Nothing is being issued on this route, so the balance IS the whole
         request — passing the map changes no quantity, and leaving it null
         would be the same result by a less obvious path. */
      buyQty: issuePosted ? buyQty : null,
      lineSpec,
    });
    if (error) return res.status(400).json({ success: false, message: error });

    doc.spendRequestId = spend._id;
    doc.spendRequestNumber = spend.requestNumber;
    stamp();
    await doc.save();

    res.json({
      success: true,
      request: intakeRow(doc.toObject(), { kind: "spend", status: spend.status }),
      message: `${spend.requestNumber} is with finance — this one spends money, so finance decides.`,
    });
  } catch (e) {
    console.error("[intake] classify:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * Return a request to the requester because the store cannot get it.
 *
 * One implementation, two doors: the request-level refusal, and the case where
 * every line of a multi-line request was refused individually. Those are the
 * same outcome and must not drift into two — a request returned line by line
 * and one returned whole should read identically to the person who asked.
 *
 * @param {Map|null} lineSpec  When the refusal came line by line, the per-line
 *        reasons are stamped onto the items too, so the requester sees which
 *        line failed for which reason rather than one merged sentence.
 */
async function returnRequest({ res, doc, emp, reason, lineSpec = null }) {
  const now = new Date();
  const who = mrfApprover.buildFullName(emp);
  const whoId = emp._id || null;

  if (lineSpec) {
    for (const [i, v] of lineSpec.entries()) {
      if (!v.cannotFulfil || !doc.items[i]) continue;
      doc.items[i].unfulfilled = true;
      doc.items[i].unfulfilledReason = v.reason;
      doc.items[i].unfulfilledAt = now;
      doc.items[i].unfulfilledByName = who;
    }
  }

  doc.status = intake.REJECTED;
  doc.decidedBy = whoId;
  doc.decidedByName = who;
  doc.decidedAt = now;
  doc.decisionNote = reason;
  doc.history.push({
    at: now,
    by: whoId,
    byName: who,
    /* Said in the store's own words rather than "rejected", so the history
       distinguishes "the department said no" from "we cannot get it". */
    action: "store could not fulfil it",
    note: reason,
  });
  await doc.save();

  return res.json({
    success: true,
    request: intakeRow(doc.toObject(), null),
    message: "Returned to the requester with your reason.",
  });
}

/* ══ THE STORE CANNOT SUPPLY IT ═════════════════════════════════════════════
 * The fourth answer to "how does this get fulfilled", and the only one that
 * fulfils nothing.
 *
 * ── WHY IT IS NOT A CLASSIFICATION ──────────────────────────────────────────
 * The other three routes turn the request into a document that carries it
 * forward — an MRF or a spend request. This one produces no document, so it
 * cannot go through `classify`: there is no `kind` to record and no thing for
 * the request to become. It ends the request instead.
 *
 * ── AND WHY IT IS TERMINAL ──────────────────────────────────────────────────
 * There is no "back to the requester for edit" state on this model, and this
 * chunk is not the place to invent one — a status is a thing every screen,
 * queue and count has to learn. So this REJECTS, the requester sees the
 * store's reason, and a changed ask is a new request. The reason is therefore
 * mandatory: an unexplained refusal is the one outcome that guarantees the
 * same request comes back unchanged.
 *
 * The entitlement is the classifier's, deliberately — deciding the store
 * cannot supply something is the same authority as deciding it can.
 */
router.patch("/:id/cannot-fulfil", async (req, res) => {
  try {
    const emp = await requester(req);
    if (!emp) return res.status(404).json({ success: false, message: "Your staff record was not found." });

    const doc = await IntakeRequest.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: "Request not found." });

    const viewer = await viewerOf(emp);
    const allowed = intake.classificationFor({ request: doc, viewer });
    if (!allowed.can) return res.status(403).json({ success: false, message: allowed.reason });

    const reason = text(req.body?.reason, 500);
    if (!reason) {
      return res.status(400).json({
        success: false,
        message:
          "Say why the store cannot fulfil this. The requester sees it, and it is the only thing that stops the same request coming back unchanged.",
      });
    }

    return await returnRequest({ res, doc, emp, reason });
  } catch (e) {
    console.error("[intake] cannot-fulfil:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * Check a chosen head against the department that will be charged for it.
 *
 * The same approved-heads list the picker was built from, so a ledger id typed
 * into a payload by hand cannot buy access to another department's envelope or
 * to a head nobody budgeted. Returns the ledger AND the figures the chooser was
 * looking at, so the request can record what they saw rather than what the head
 * says months later.
 */
/**
 * @param {string}  [plannedItemKey]  the working row being spent against
 * @param {string}  [plannedItemName] stored beside the key so a positional key
 *        that later resolves to a different row is refused rather than
 *        silently reattached — see budgetPlannedItems.keyOf
 * @param {boolean} [requirePlannedItem] New submissions must name one. Left
 *        false for the paths that re-resolve a head on a request raised before
 *        planned items existed: those rows are readable, and re-validating one
 *        into a refusal would strand a request nobody can now fix.
 */
async function resolveHead({
  department,
  ledgerId,
  plannedItemKey = null,
  plannedItemName = null,
  requirePlannedItem = false,
}) {
  const { company, error } = await theCompany();
  if (error) return { error };

  const { heads } = await budgetMatch.approvedHeadsFor({
    companyId: company._id,
    department: department || "",
  });
  const approved = heads.find((h) => String(h.ledgerId) === String(ledgerId)) || null;
  if (!approved) {
    /* Deliberately not "invalid ledger": the head may well be real and simply
       not one this department has an approved budget for, and the way to spend
       against it is to ask for it rather than to select it. */
    return {
      error:
        "That budget head is not in this department's approved budget. Use one of their approved heads, or request another head.",
    };
  }

  const ledger = await Acc_Ledger.findOne({ _id: ledgerId, companyId: company._id })
    .select("_id name")
    .lean();
  if (!ledger) return { error: "That budget head is not in the books." };

  /* ── AND THE ROW INSIDE IT ──────────────────────────────────────────────
     The head is the bucket; the plan is what finance agreed. A head whose
     plan has no approved rows cannot be spent against at all — the budget has
     to be revised before a request can name anything. */
  const plan = approved.plannedItems || [];
  let plannedItem = null;

  if (requirePlannedItem) {
    if (!plan.length) {
      return {
        error:
          "No planned items approved under this head. Revise the budget before raising a request.",
      };
    }
    if (!plannedItemKey) {
      return { error: "Choose the planned item this comes out of." };
    }
    plannedItem =
      plan.find(
        (x) =>
          x.key === String(plannedItemKey) &&
          (!plannedItemName ||
            !String(plannedItemName).trim() ||
            x.name === String(plannedItemName).trim()),
      ) || null;
    if (!plannedItem) {
      /* Deliberately not "invalid item": the row may well exist and simply
         not be approved, or belong to another head or another department's
         plan. Naming the actual condition is what tells somebody to go and
         revise the budget rather than retry. */
      return {
        error:
          "That planned item is not an approved row under this budget head. Choose one of the planned items, or revise the budget first.",
      };
    }
  }

  return {
    ledger,
    plannedItem,
    plannedItems: plan,
    snapshot: {
      approved: approved.approved,
      committed: approved.committed,
      actual: approved.actual,
      available: approved.available,
    },
    /* Both halves of the address. A line id inside an `items[]` array is not
       addressable without the document that holds it. */
    budgetId: approved.budgetId,
    budgetLineId: approved.budgetLineId,
    financialYear: approved.financialYear,
    /* The department off the ALLOCATION, not off the request: the registry
       canonicalises spellings, and the money is filed under the line's. */
    department: approved.department || department || "",
    error: null,
  };
}

/**
 * The MRF a store-issue classification becomes.
 *
 * Items are created UNMATCHED — the same shape the material app already
 * produces for a line the requester described rather than picked from the
 * catalogue. The store matches or registers them exactly as they do today; no
 * new state, no new screen.
 *
 * Created directly at APPROVED because the TL has already agreed the need,
 * which is the only thing MRF's own TL step decides.
 */
/**
 * @param {Map<number,number>|null} issueQty  How much of each line the store is
 *        issuing, by line index. Null means the whole request — the ordinary
 *        case, and the shape every caller before the partial route used. Lines
 *        the store is issuing NONE of are left off the MRF entirely rather
 *        than added with a zero: a zero line is something to issue that
 *        nobody can issue, and it would sit on the store's queue forever.
 */
async function spawnMrf({ doc, classifier, classifierName, now, issueQty = null, lineSpec = null }) {
  const sourceLines = (doc.items || []).filter(
    (l, i) =>
      !lineSpec?.get(i)?.cannotFulfil && (!issueQty || num(issueQty.get(i)) > 0),
  );
  const mrf = new MRF({
    requestedFor: doc.requestedBy,
    requestedForName: doc.requestedByName || "",
    requestedForDept: doc.department || "",
    requestedForId: doc.requestedById || "",
    creationMode: "SELF",
    createdByRef: doc.requestedBy,
    createdByModel: "Employee",
    createdByName: doc.requestedByName || "",
    /* Not time-boxed by a deadline the requester never gave. `neededBy` is the
       date they DID give and is carried; `requestType` is MRF's own axis and
       USES_BASED is the one that does not invent a deadline. */
    requestType: "USES_BASED",
    neededBy: doc.neededBy || null,
    reason: doc.purpose || "",
    priority: doc.priority || "NORMAL",
    /* The whole routing record travels, not three fields of it: the alternate
       ids are what let the manager still be matched on the MRF's own screens,
       and the resolution is why this request routed as it did. */
    approverEmployee: doc.approverEmployee || null,
    approverName: doc.approverName || "",
    approverBiometricId: doc.approverBiometricId || "",
    approverAltIds: doc.approverAltIds || [],
    approverResolution: doc.approverResolution || "RESOLVED",
    /* ── THE HEAD THE MANAGER ALREADY CHOSE ───────────────────────────────
       Recorded and, on this path, never used: issuing stock the company owns
       spends nothing. It is here for the case where that turns out to be
       wrong — the store cannot supply it and it has to be bought — so the
       decision does not have to be made a second time. See the MRF model. */
    intakeRequestId: doc._id,
    intakeRequestNumber: doc.requestNumber || "",
    budgetLedgerId: doc.ledgerId || null,
    budgetLedgerName: doc.ledgerName || "",
    budgetCycleId: doc.budgetCycleId || null,
    budgetLineId: doc.budgetLineId || null,
    budgetFinancialYear: doc.budgetFinancialYear || "",
    budgetDepartment: doc.budgetDepartment || doc.department || "",
    budgetHeadRequested: Boolean(doc.unbudgetedHeadRequest),
    /* The row of the plan this is against — fulfilment context for the store,
       and the tie back to what finance actually agreed to. */
    plannedItemKey: doc.plannedItemKey || undefined,
    plannedItemName: doc.plannedItemName || undefined,
    plannedItemAmount:
      typeof doc.plannedItemAmount === "number" ? doc.plannedItemAmount : undefined,
    status: "APPROVED",
    tlApproved: true,
    tlApprovedBy: doc.tlApprovedBy || null,
    tlApprovedByName: doc.tlApprovedByName || "",
    tlApprovedAt: doc.tlApprovedAt || now,
    approvedAt: now,
    items: sourceLines.map((l) => ({
      /* ── MATCHED WHERE THE REQUESTER RECOGNISED IT ────────────────────
         A line they picked out of the store's catalogue arrives issuable. A
         line they described arrives UNMATCHED — the store's existing path,
         where somebody works out which item was meant or registers a new one.
         Both are ordinary; the second is not a failure. */
      /* ── MATCHED BY THE STORE, WHERE THE STORE MATCHED IT ─────────────
         The requester may have picked this out of the catalogue themselves,
         in which case `l.rawItem` was already right. Where they described it
         instead, the store has now said which item they meant — and a line
         that arrives already matched is a line the store does not have to
         match a second time on the MRF's own screen. */
      rawItem: lineSpec?.get((doc.items || []).indexOf(l))?.rawItemId || l.rawItem || null,
      rawItemName:
        lineSpec?.get((doc.items || []).indexOf(l))?.rawItemName || l.name,
      rawItemSku:
        lineSpec?.get((doc.items || []).indexOf(l))?.rawItemSku || l.rawItemSku || "",
      /* What is being ISSUED, not what was asked for. On a partial these
         differ, and the MRF has to describe its own half of the job — an MRF
         for twenty when the store is issuing eight is an MRF that reads as
         twelve short forever. */
      requestedQty: issueQty
        ? num(issueQty.get((doc.items || []).indexOf(l)))
        : l.quantity,
      unit: l.unit,
      baseUnit: l.baseUnit || "",
      description: l.note || "",
      /* The reference photos travel. On an UNMATCHED line they are most of
         what the store has to go on when deciding which catalogue item this
         is — or what to register if it is not one yet. */
      images: (l.images || []).map((im) => ({
        url: im.url, publicId: im.publicId || "", name: im.name || "",
      })),
      /* Issuable the moment it lands, when somebody has said what it is.
         UNMATCHED is still an ordinary outcome — a described line nobody
         matched goes to the store's existing matching path, exactly as
         before. */
      itemStatus:
        lineSpec?.get((doc.items || []).indexOf(l))?.rawItemId || l.rawItem
          ? "APPROVED"
          : "UNMATCHED",
      availability: "UNREVIEWED",
    })),
  });

  mrf.logEvent({
    action: "CREATED",
    actorName: doc.requestedByName || "",
    actorRole: "employee",
    detail: `Raised as ${doc.requestNumber} on the Requests desk.`,
  });
  mrf.logEvent({
    action: "TL_APPROVED",
    actorName: doc.tlApprovedByName || "System",
    actorRole: "tl",
    detail: `${classifierName} routed this to the store from ${doc.requestNumber}.`,
  });

  await mrf.save();
  return mrf;
}

/**
 * The spend request a purchase, service or recurring classification becomes.
 *
 * The head is validated against the same approved-heads list the picker was
 * built from — and against the REQUESTER's department, not the classifier's.
 */
/**
 * Roll the lines' commercial terms up into the request-level fields.
 *
 * One distinct value across every line is the request's value. Several is not
 * one value, and saying so beats picking the first line's — a purchase order
 * headed with the wrong vendor is worse than one that says to look at the
 * lines. The earliest delivery date is the one worth surfacing: it is the
 * first commitment anybody has to meet.
 */
function summarise(lines, body) {
  const distinct = (key) => {
    const seen = [...new Set(lines.map((l) => l[key]).filter(Boolean))];
    return seen.length === 1 ? seen[0] : seen.length > 1 ? "Multiple" : "";
  };
  const dates = lines.map((l) => l.expectedDeliveryDate).filter(Boolean);

  return {
    vendorName: distinct("vendorName") || text(body.vendorName, 200),
    /* Never "Multiple" — a GSTIN is validated elsewhere as a real identifier,
       and a sentinel in that field would be read as one. Blank when the lines
       disagree. */
    gstin: (() => {
      const seen = [...new Set(lines.map((l) => l.gstin).filter(Boolean))];
      return seen.length === 1 ? seen[0] : text(body.gstin, 20);
    })(),
    quoteRef: distinct("quoteRef") || text(body.quoteRef, 60),
    expectedDeliveryDate: dates.length
      ? new Date(Math.min(...dates.map((d) => new Date(d).getTime())))
      : null,
  };
}

/**
 * @param {Map<number,number>|null} buyQty  Per line index, how much has to be
 *        bought. Null means the whole request.
 */
async function spawnSpend({ doc, kind, body, schedule, classifier, classifierName, now, buyQty = null, lineSpec = null }) {
  const { company, error: companyError } = await theCompany();
  if (companyError) return { error: companyError };

  /* ── THE HEAD THE MANAGER CHOSE ─────────────────────────────────────────
     Read off the request, not off this request body. Store is fulfilling a
     decision, not making one, and a head posted from the classification screen
     would be a head chosen by somebody who does not hold the budget.

     Re-validated against the department's approved list rather than trusted
     from the document: an allocation can be withdrawn between approval and
     classification, and filing spend against a head that is no longer approved
     is exactly the silent wrong the picker exists to prevent. */
  const asksForNewHead = doc.unbudgetedHeadRequest === true;
  let ledger = null;
  const requestedHeadName = asksForNewHead ? doc.requestedHeadName || "" : "";
  const requestedHeadReason = asksForNewHead ? doc.requestedHeadReason || "" : "";

  if (!asksForNewHead) {
    if (!doc.ledgerId) {
      return {
        error:
          "No budget head was set when this was approved. Send it back to the requester's manager to choose one.",
      };
    }
    const head = await resolveHead({ department: doc.department, ledgerId: doc.ledgerId });
    if (head.error) {
      return {
        error: `${head.error} It was approved against "${doc.ledgerName || "a head"}"; that head is no longer available to this department.`,
      };
    }
    ledger = head.ledger;
  }

  /* ── THE RATE A SPEND REQUEST NEEDS AND AN INTAKE DID NOT ────────────────
     Every line has to carry one before finance can be asked to agree to a
     figure. The requester's estimate is used where they gave one; where they
     did not, the classifier has to supply it, because a spend request whose
     lines are all zero is a request to approve nothing. */
  const rates = body.rates && typeof body.rates === "object" ? body.rates : {};
  const lines = [];
  let totalAmount = 0;

  for (const [i, l] of (doc.items || []).entries()) {
    /* ── ONLY THE BALANCE, ON A PARTIAL ─────────────────────────────────
       `buyQty` is what the store could NOT cover off the shelf. Null means
       the whole line, which is every route except the partial one. A line
       fully covered by stock is skipped rather than priced at zero: asking
       finance to approve a zero-value line for something already issued is
       asking them to approve nothing. */
    const quantity = buyQty ? num(buyQty.get(i)) : l.quantity;
    if (buyQty && (quantity === null || quantity <= 0)) continue;

    /* The rate posted against THIS line wins over the flat map — the store's
       form prices each line beside the item it belongs to, and a rate that
       sits next to the thing it prices is the one that was meant. */
    const perLine = lineSpec?.get(i) || null;
    /* A line the store cannot get is not a line finance can approve. Skipped
       before it is priced, so it contributes nothing to the quoted total. */
    if (perLine?.cannotFulfil) continue;
    const given =
      perLine && perLine.rate !== null && perLine.rate !== undefined
        ? perLine.rate
        : rates[String(l._id)] ?? rates[String(i)] ?? l.rate;
    const rate = num(given);
    if (rate === null || rate < 0) {
      return {
        error: `Line ${i + 1} (${l.name}) has no rate. This one is being bought, so finance needs the figure.`,
      };
    }
    const amount = Math.round(quantity * rate * 100) / 100;
    totalAmount += amount;
    /* This line's own terms, falling back to the request-level ones. The
       fallback is what keeps every older caller working: they send one vendor
       and one rate for the whole request, and every line quietly inherits it,
       which is exactly what used to happen. */
    const lineGst =
      perLine && perLine.gstPercent !== null && perLine.gstPercent !== undefined
        ? perLine.gstPercent
        : num(body.gstPercent) || 0;
    const lineNet = Math.round(quantity * rate * 100) / 100;
    const lineTax = Math.round(((lineNet * lineGst) / 100) * 100) / 100;
    const lineDelivery = perLine?.expectedDeliveryDate || body.expectedDeliveryDate || null;
    const parsedDelivery = (() => {
      if (!lineDelivery) return null;
      const d = new Date(lineDelivery);
      return Number.isNaN(d.getTime()) ? null : d;
    })();

    lines.push({
      /* What the store proposes to buy it as, where they renamed it. The
         requester described a need; the store knows what the thing is called
         on an invoice, and finance and the vendor both read that name. */
      name: perLine?.newItemName || l.name,
      /* The requester's own words, kept beside Store's. */
      requestedName: l.name,
      spec: perLine?.spec || l.note || "",
      /* Both names, so finance can see that Store went somewhere other than
         where the requester pointed them — and why. */
      attachments: (perLine?.attachments || []).map((a) => ({
        ...a,
        uploadedAt: now,
        /* From the session, never from the body. */
        uploadedByName: classifierName,
      })),
      suggestedVendorName: perLine?.suggestedVendorName || "",
      vendorNote: perLine?.vendorNote || "",
      vendorName: perLine?.vendorName || text(body.vendorName, 200),
      vendorId: perLine?.vendorId || null,
      gstin: perLine?.gstin || text(body.gstin, 20),
      quoteRef: perLine?.quoteRef || text(body.quoteRef, 60),
      gstPercent: lineGst,
      taxAmount: lineTax,
      lineTotal: Math.round((lineNet + lineTax) * 100) / 100,
      expectedDeliveryDate: parsedDelivery,
      /* The line's own reason. The requester wrote one per line where they had
         something to say; the request's purpose stands in where they did not,
         because the field is required and an empty one would read as nobody
         having asked. */
      whyNeeded: l.note || doc.purpose,
      quantity,
      unit: l.unit,
      rate,
      amount,
    });
  }
  totalAmount = Math.round(totalAmount * 100) / 100;

  if (!lines.length) {
    return { error: "There is nothing left to buy on this request." };
  }

  /* Tax on top of the whole quote, not per line — one vendor, one rate, one
     GST figure. The same rule storeFulfilment applies on the material door,
     shared rather than restated so the two cannot disagree. */
  const priced = storeFulfilment.priceFor({
    lines: lines.map((l) => ({ buyQty: l.quantity, rate: l.rate, gstPercent: l.gstPercent })),
    gstPercent: num(body.gstPercent) || 0,
  });

  const emp = {
    _id: doc.requestedBy,
    biometricId: doc.requestedById,
    department: doc.department,
  };

  const { request } = await spendCreate.createSpendRequest({
    emp,
    actorName: doc.requestedByName || "",
    company,
    title: doc.title,
    purpose: doc.purpose,
    /* ── THE THING'S OWN NATURE WINS OVER THE ROUTE ──────────────────────
       A product that has to be bought is still a product; a licence arranged
       through a vendor is still a service. `kind` says how it gets got, which
       is a different question — and the requester declared the type and the
       manager confirmed it, so two people have now agreed on it. The
       fulfilment kind is the fallback for requests raised before there was a
       type to carry. */
    requestType: doc.requestType || kind.spendType,
    priority: doc.priority || "NORMAL",
    neededBy: doc.neededBy || null,
    /* The vendor is asked once, here, of the people who choose vendors. It
       used to be asked of the requester as well; that was the same answer
       collected twice from the person less qualified to give it. */
    /* ── THE REQUEST-LEVEL TERMS ARE NOW A SUMMARY ────────────────────────
       They stay because every screen, report and voucher built before the
       line-wise fields reads them. One distinct value across the lines IS the
       request's value; several is not summarisable, and "Multiple" is the
       honest answer — better than silently showing whichever line happened to
       be first, which would name the wrong vendor on a purchase order. */
    ...summarise(lines, body),
    lines,
    totalAmount,
    gstPercent: priced.gstPercent,
    taxAmount: priced.taxAmount,
    grandTotal: priced.grandTotal,
    ledger,
    asksForNewHead,
    requestedHeadName,
    requestedHeadReason,
    /* Carried whole. The spend request inherits the manager the INTAKE was
       addressed to — the requester's own — rather than re-resolving against
       the classifier or against HR as it stands today. */
    approver: {
      approverEmployee: doc.approverEmployee || null,
      approverName: doc.approverName || "",
      approverBiometricId: doc.approverBiometricId || "",
      approverAltIds: doc.approverAltIds || [],
      approverResolution: doc.approverResolution || "RESOLVED",
      approverResolutionNote: doc.approverResolutionNote || "",
    },
    /* ── TO THE REQUESTER, NOT TO FINANCE ──────────────────────────────────
       It used to go straight to finance: the department had agreed the need,
       so the only question left looked like money.

       It was not. Store sources what they think was meant, and "a mouse, the
       good one" can be sourced perfectly well as the wrong model from a vendor
       with a six-week lead time. Finance approves it because the FIGURE is
       fine, and the wrong thing is on order with the money committed.

       So the person who knows what they meant sees the item, spec, vendor,
       price and date first. The TL step is still answered and is not asked
       again — this is a different question from "does the department need
       this". */
    startAt: chain.AWAITING_CONFIRMATION,
    tlApproval: doc.tlApprovedAt
      ? { by: doc.tlApprovedBy, byName: doc.tlApprovedByName, at: doc.tlApprovedAt }
      : null,
    recurring: schedule
      ? {
          isRecurring: true,
          frequency: schedule.frequency,
          startsOn:
            schedule.startsOn && !Number.isNaN(schedule.startsOn.getTime())
              ? schedule.startsOn
              : undefined,
          endsOn:
            schedule.endsOn && !Number.isNaN(schedule.endsOn.getTime())
              ? schedule.endsOn
              : undefined,
          note: schedule.note,
        }
      : null,
    intakeRequestId: doc._id,
    plannedItem: doc.plannedItemKey
      ? { key: doc.plannedItemKey, name: doc.plannedItemName, amount: doc.plannedItemAmount }
      : null,
    historyNote: `Raised as ${doc.requestNumber}; classified by ${classifierName}.`,
    now,
  });

  return { spend: request, error: null };
}

/* ══ WITHDRAW ═══════════════════════════════════════════════════════════════
 * While it is still an ask, it is the requester's to take back. Once it has
 * been classified it is a live MRF or a live spend request, and it is
 * withdrawn there — where the store or finance can see that it was.
 */
router.patch("/:id/cancel", async (req, res) => {
  try {
    const emp = await requester(req);
    if (!emp) return res.status(404).json({ success: false, message: "Your staff record was not found." });
    /* Only the requester withdraws their own request, and a stand-in raised
       none — the ownership test below would fail closed regardless. */
    if (refuseStandIn(res, emp, "Withdrawing a request")) return;

    const doc = await IntakeRequest.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: "Request not found." });

    if (String(doc.requestedBy) !== String(emp._id)) {
      return res.status(403).json({ success: false, message: "That is not your request." });
    }
    if (!intake.OPEN_STATUSES.includes(doc.status)) {
      return res.status(409).json({
        success: false,
        message: doc.fulfilmentKind
          ? `This is now ${doc.mrfNumber || doc.spendRequestNumber} and has to be withdrawn there.`
          : `This request is ${intake.STAGE_LABEL[doc.status] || doc.status} and can no longer be withdrawn.`,
      });
    }

    const now = new Date();
    doc.status = intake.CANCELLED;
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
    await doc.save();

    res.json({ success: true, request: intakeRow(doc.toObject(), null, null, { withMoney: true }) });
  } catch (e) {
    console.error("[intake] cancel:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
