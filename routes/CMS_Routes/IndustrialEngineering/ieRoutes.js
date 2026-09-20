// routes/CMS_Routes/IndustrialEngineering/ieRoutes.js
//
// INDUSTRIAL ENGINEERING — THE DEPARTMENT'S FIRST DOOR, AND IT ONLY READS.
//
// ── WHY A NEW BOUNDARY RATHER THAN MORE PRODUCTION ROUTES ───────────────────
// ADR-003 separates IE from PPC and from Production. Production Manager and
// Production Supervisor are roles INSIDE Production; IE owns the manufacturing
// standard — operation definitions, bulletins, sequence, SAM, method studies,
// machine and skill requirements, line balance, capacity standards and targets.
// Hanging IE's reads off `/api/cms/production/style-route` would have given the
// two departments one door and one grant, which is the ambiguity Chunk 0 was
// written to stop.
//
// So this is a separate router, mounted once at `/api/cms/ie`, gated on the
// `ie` department grant. Chunk 1 held only GETs — no writer of any kind, so a
// shell built against it could not be given a Save button by accident.
//
// ── CHUNK 2A ADDED ONE WRITE SURFACE ────────────────────────────────────────
// The company operation library, under `/operations/library`. There is no
// DELETE anywhere on this router: an operation is RETIRED, never removed,
// because styles and bulletins point at it and history that vanishes takes
// their meaning with it.
//
// ── CHUNK 4B ADDS THE FOURTH: ALLOWANCES, STANDARD TIME AND APPROVAL ────────
// `/allowance-policies` is the company's effective-dated allowance decision,
// drafted by an editor and PUBLISHED by somebody else. The method study gains
// `/submit`, `/return`, `/approve` and `/submissions`: a completed draft is
// frozen with the policy effective on the day it was studied, its standard time
// is calculated, and a second person decides. Every attempt is kept.
//
// Approval here approves a METHOD STUDY and its standard time. It writes nothing
// into the bulletin row and releases nothing to Production, Planning or Costing
// — the Operation Bulletin's own approval and release are still not built, and
// this router still has no verb for them.
//
// ── CHUNK 4A ADDS THE THIRD: THE DRAFT METHOD STUDY ─────────────────────────
// Timed cycles behind ONE bulletin row, under
// `/engineering-files/:fileId/bulletin/:rowId/method-studies` and
// `/method-studies/:studyId`. It records evidence and calculates observed and
// normal time. It writes nothing back to the bulletin or the operation
// library, and there is still no submit, approve or release verb: the study
// lifecycle, allowances and standard time are Chunk 4B.
//
// ── CHUNK 3A ADDS THE SECOND: THE STYLE ENGINEERING FILE ────────────────────
// Opened through an order — `/orders/:orderId/styles/:styleId/engineering-file`
// — because the order is what proves a style belongs to this company, and
// edited through `/engineering-files/:fileId/bulletin`. It holds ONE draft
// bulletin. There is no submit, no approve and no release verb here: Chunk 4
// owns the approval lifecycle, and a shell built against this router cannot
// find an approval control to wire up by accident.
//
// ── THE COMPANY IS THE ACTOR'S, NEVER THE REQUEST'S ─────────────────────────
// Resolved from their own membership through the shared company-context
// service. A body cannot name a company here, and neither can a query — the
// only thing a caller may do is SELECT among memberships they already hold,
// which is the established multi-company behaviour and is validated against
// their own rows before it means anything.
//
// ── AND NO SALES RECORD LEAVES THROUGH IT ───────────────────────────────────
// A SampleStyle's company lives on its Sales parents, so the Journey and the
// enquiry are how ownership is PROVED. Neither appears in a response, and
// neither does a customer, a supplier, a rate, a salary, a cost or a margin.
// See services/industrialEngineering/ieRead.service.js, where every shape is
// built field by field.
"use strict";

const express = require("express");

const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const {
  resolveCompanyForActor,
} = require("../../../services/companyContext/companyMembership.service");
const { getEffectiveRole, roleAtLeast } = require("../../../services/departmentRoles");
const { fail, sendError, handle } = require("../../../services/storePurchase/errors");
const ieRead = require("../../../services/industrialEngineering/ieRead.service");
const ieOrders = require("../../../services/industrialEngineering/ieOrders.service");
const ieLibrary = require("../../../services/industrialEngineering/ieOperationLibrary.service");
const ieStyleFile = require("../../../services/industrialEngineering/ieStyleFile.service");
const ieMethodStudy = require("../../../services/industrialEngineering/ieMethodStudy.service");
const ieAllowancePolicy = require("../../../services/industrialEngineering/ieAllowancePolicy.service");
const ieLineLayout = require("../../../services/industrialEngineering/ieLineLayout.service");
const ieLineTemplate = require("../../../services/industrialEngineering/ieLineTemplate.service");
const ieCapacityStandard = require("../../../services/industrialEngineering/ieCapacityStandard.service");
const ieRampProfile = require("../../../services/industrialEngineering/ieRampProfile.service");
const ieBulletinVersion = require("../../../services/industrialEngineering/ieBulletinVersion.service");
const ieRelease = require("../../../services/industrialEngineering/ieRelease.service");
const ieReleaseImpact = require("../../../services/industrialEngineering/ieReleaseImpact.service");
const {
  listMembershipCompanies,
} = require("../../../services/companyContext/companyMembership.service");

const router = express.Router();
router.use(EmployeeAuthMiddleware);

/** Industrial Engineering's own department slug. */
const DEPARTMENT = "ie";

/**
 * The company this actor works in, proved from their own membership.
 *
 * The same header and query name every other company-scoped module already
 * accepts, and for the same reason: it SELECTS among memberships the person
 * holds and is authority for nothing on its own. A person in one company has
 * theirs whatever they send; a person in several must choose, and choosing one
 * they do not belong to is refused exactly as naming a company that does not
 * exist is.
 */
async function requireCompany(req, res, next) {
  try {
    const requestedCompanyId = req.get("X-Costing-Company") || req.query?.actingCompanyId || null;
    const { companyId, membershipSource } = await resolveCompanyForActor(req.user, {
      requestedCompanyId,
      domainLabel: "Industrial Engineering",
      fail,
    });
    req.ie = { companyId, membershipSource };
    next();
  } catch (err) {
    sendError(res, err);
  }
}

/**
 * An IE seat, re-read on every request rather than trusted from the token: a
 * grant removed five minutes ago must not survive in a seven-day JWT.
 *
 * The platform-administrator branch is the SAME one every other department
 * guard in this codebase uses — see productionStyleRoute.js. It is copied
 * rather than extended: inventing a new bypass for a brand-new department
 * would be a second answer to "who may act as an owner", and the point of this
 * chunk is to add no new authority path at all.
 */
const requireIe = (minimumRole, { code = "FORBIDDEN", message = "Manufacturing standards are Industrial Engineering's." } = {}) => async (req, res, next) => {
  try {
    if (req.user?.isAdmin || req.admin) { req.ieRole = "owner"; return next(); }
    const role = await getEffectiveRole(DEPARTMENT, req);
    if (!role || !roleAtLeast(role, minimumRole)) {
      return sendError(res, fail(code, message,
        { requires: { department: DEPARTMENT, minimumRole }, held: role || null }));
    }
    req.ieRole = role;
    next();
  } catch (err) {
    sendError(res, err);
  }
};

/** Every READ needs a viewer — the Chunk 1 boundary, unchanged. */
const canRead = requireIe("viewer");

/* ── AND EVERY WRITE NEEDS AN EDITOR ────────────────────────────────────────
 * `editor` is the established second rung of the one department vocabulary
 * (viewer → editor → approver → owner, models/Access/DepartmentRole.js), and
 * maintaining the operation library is exactly what "create and change" means.
 * Retire and restore sit on the same rung deliberately: retirement is
 * reversible and destroys nothing, so putting it behind `approver` would only
 * mean the register is not kept tidy. When Chunk 2B/3 adds an APPROVED
 * standard time, the actions that touch a released standard go to `approver`
 * — that is a change to make with the approval lifecycle, not before it.
 *
 * ── WHY NOT `departmentWrites("ie")` AT THE MOUNT ───────────────────────────
 * The mount-level guard (Middlewear/departmentWriteGuard.js) FAILS OPEN for a
 * department with no roles granted yet — which is precisely what a brand-new
 * department is — so mounting it here would leave IE's first write surface
 * open to every authenticated employee until somebody happened to grant the
 * first `ie` role. It also converts an editor's write into a queued
 * ChangeRequest answered with 202, and this contract answers with the record.
 * So this reuses the same underlying `getEffectiveRole`/`roleAtLeast` service
 * as everything else, and fails CLOSED.
 *
 * It is a SEPARATE refusal code from the read guard's: "you may look but not
 * change" and "you may not open Industrial Engineering" are different answers
 * and a screen should be able to tell them apart without reading prose. */
const canWrite = requireIe("editor", {
  code: "IE_WRITE_FORBIDDEN",
  message: "Changing the operation library needs an Industrial Engineering editor role.",
});

/* ── AND A DECISION NEEDS AN APPROVER ───────────────────────────────────────
 * The third rung of the same vocabulary. It gates publishing an allowance
 * policy and returning or approving a method study — the actions whose whole
 * purpose is that somebody other than the author performs them.
 *
 * The ROLE is only half of it: the services also compare actor IDS, so an
 * approver cannot approve their own submission and an owner or platform
 * administrator gets no exemption. A grant says what somebody may do;
 * maker-checker is about who they are. */
const canApprove = requireIe("approver", {
  code: "IE_WRITE_FORBIDDEN",
  message: "Approving Industrial Engineering work needs an approver role.",
});

/** Everything a write stamps on the record. Identity only — never authority. */
const actorOf = (req) => ({ id: req.user?.id, name: req.user?.name, email: req.user?.email });

/**
 * GET /companies — the companies this actor may work in.
 *
 * ── WHY THIS ONE DOES NOT TAKE A COMPANY ────────────────────────────────────
 * Every other IE read runs behind `requireCompany`, and a multi-company person
 * is refused with `COMPANY_SELECTION_REQUIRED` until they name one. This
 * endpoint EXISTS to make that choice, so requiring the answer as input would
 * be a locked door with the key inside. It carries the `ie` grant and employee
 * authentication like everything else.
 *
 * ── AND IT IS NOT THE COMPANY DIRECTORY ─────────────────────────────────────
 * It reads the actor's OWN membership rows and looks up only those ids, so it
 * cannot be used to enumerate the company master. Two fields leave — the id and
 * the display name — because that is all a selector needs; nothing about books,
 * addresses, tax registration or any other company's existence is published.
 * The rule is the shared one in `companyContext/companyMembership.service.js`,
 * not an IE copy of it.
 */
router.get("/companies", canRead, handle(async (req, res) => {
  const out = await listMembershipCompanies(req.user);
  return res.json({ success: true, ...out });
}));

/* ── ORDERS — THE LANDING LIST (Chunk 1B) ────────────────────────────────
 *
 * IE works order-wise, so this is the department's front door and the style
 * endpoints below it are what an order opens into. The order here is the
 * `WorkOrder` — the record production is authorised and scheduled from — and
 * NOT the `CustomerRequest` the Project Manager's screens label "Manufacturing
 * Order", which is a customer order carrying quotations, prices and payments.
 * See services/industrialEngineering/ieOrders.service.js for why, and for how
 * an order without a `companyId` of its own is nevertheless proved to belong
 * to one.
 *
 * Both are reads. There is still no write verb anywhere on this router. */

/** GET /orders — the IE Orders landing list. */
router.get("/orders", requireCompany, canRead, handle(async (req, res) => {
  const out = await ieOrders.listOrders(req.ie, {
    limit: req.query.limit,
    cursor: req.query.cursor,
  });
  return res.json({ success: true, ...out });
}));

/**
 * GET /orders/:orderId — one order and the styles provably on it.
 *
 * The styles are returned inline rather than behind a third endpoint. A work
 * order names one product and, through the two stored references, a handful of
 * styles at most — there is no volume here that a separate page would serve,
 * and splitting it would make the common case two round trips to answer one
 * question. If a linked-style count ever grows past a page, the split belongs
 * then, against evidence.
 */
router.get("/orders/:orderId", requireCompany, canRead, handle(async (req, res) => {
  const out = await ieOrders.readOrder(req.ie, { orderId: req.params.orderId });
  return res.json({ success: true, ...out });
}));

/**
 * GET /styles — the IE style worklist.
 *
 * Kept as a reusable read: orders are the navigation, and a style is the
 * engineering unit an order opens into. Bounded and stably ordered. It does
 * not take a Journey, does not require one, and does not publish one.
 */
router.get("/styles", requireCompany, canRead, handle(async (req, res) => {
  const out = await ieRead.listStyles(req.ie, {
    limit: req.query.limit,
    cursor: req.query.cursor,
  });
  return res.json({ success: true, ...out });
}));

/**
 * GET /styles/:styleId — one style, with its two legacy route sources shown
 * separately and a comparison state between them.
 */
router.get("/styles/:styleId", requireCompany, canRead, handle(async (req, res) => {
  const out = await ieRead.readStyle(req.ie, { styleId: req.params.styleId });
  return res.json({ success: true, ...out });
}));

/**
 * GET /operations — the operation master, read-only, with its own scope
 * limitation and duplicate-code ambiguity published on the response.
 */
router.get("/operations", requireCompany, canRead, handle(async (req, res) => {
  const out = await ieRead.listOperations(req.ie, {
    q: req.query.q,
    limit: req.query.limit,
    cursor: req.query.cursor,
  });
  return res.json({ success: true, ...out });
}));

/* ══ THE COMPANY OPERATION LIBRARY — CHUNK 2A ════════════════════════════════
 *
 * ── WHY `/operations/library` AND NOT `/operations` ─────────────────────────
 * `GET /operations` above is Chunk 1's read of the LEGACY global register, and
 * two accepted things pin it exactly as it is:
 *
 *   · the frozen IE frontend calls it and renders its `scope` limitation and
 *     its duplicate-code ambiguity — re-pointing it would silently replace a
 *     shipped screen's contents with an empty new register;
 *   · `test/industrial-engineering/ie-read.route.test.js` pins that `POST
 *     /operations` and `PATCH /operations/1` do not exist, which is the Chunk
 *     1A "this boundary adds no writer" guarantee.
 *
 * The two registers are different lists with different rules — one global,
 * duplicate-tolerant and salary-carrying; one company-scoped, unique-coded and
 * retirable — so they get different paths rather than one path that means two
 * things depending on who is asking. Everything Chunk 2A adds lives under this
 * sub-resource, list and writes together, so the thing a POST creates is the
 * thing the matching GET returns.
 *
 * When Lane B's Operations screen moves onto this library, `/operations` can be
 * re-pointed at it — in ONE slice that changes the frontend and this route
 * together, never a backend change that empties a live screen.
 *
 * Both guards run on every write, in this order and for this reason:
 * `requireCompany` proves WHOSE library is being changed from the actor's own
 * membership, and `canWrite` proves they may change a library at all. Neither
 * stands in for the other: an IE owner with no membership in this company
 * reaches nothing, and a member with a viewer grant may read every row and
 * change none. */

/** GET the company's operation library. */
router.get("/operations/library", requireCompany, canRead, handle(async (req, res) => {
  const out = await ieLibrary.listOperations(req.ie, {
    q: req.query.q,
    status: req.query.status,
    limit: req.query.limit,
    cursor: req.query.cursor,
  });
  return res.json({ success: true, ...out });
}));

/** GET one operation — what a form re-reads after losing a revision race. */
router.get("/operations/library/:operationId", requireCompany, canRead, handle(async (req, res) => {
  const out = await ieLibrary.readOperation(req.ie, { operationId: req.params.operationId });
  return res.json({ success: true, ...out });
}));

/** CREATE an operation. */
router.post("/operations/library", requireCompany, canWrite, handle(async (req, res) => {
  const out = await ieLibrary.createOperation(req.ie, { body: req.body, actor: actorOf(req) });
  return res.status(201).json({ success: true, ...out });
}));

/** EDIT an operation. PATCH, because a body names the fields it changes and
 *  nothing it omits is cleared — a PUT here would let a client that forgot a
 *  field erase a machine type it never meant to touch. */
router.patch("/operations/library/:operationId", requireCompany, canWrite, handle(async (req, res) => {
  const out = await ieLibrary.updateOperation(req.ie, {
    operationId: req.params.operationId, body: req.body, actor: actorOf(req),
  });
  return res.json({ success: true, ...out });
}));

/* RETIRE and RESTORE are POSTs on a named action rather than a status field on
   the PATCH: a lifecycle move has its own rules, its own refusals and its own
   audit stamp, and hiding it inside a general edit is how "I only renamed it"
   becomes "I also retired it". `status` is refused by name on the PATCH. */
router.post("/operations/library/:operationId/retire", requireCompany, canWrite, handle(async (req, res) => {
  const out = await ieLibrary.retireOperation(req.ie, {
    operationId: req.params.operationId, body: req.body, actor: actorOf(req),
  });
  return res.json({ success: true, ...out });
}));

router.post("/operations/library/:operationId/restore", requireCompany, canWrite, handle(async (req, res) => {
  const out = await ieLibrary.restoreOperation(req.ie, {
    operationId: req.params.operationId, body: req.body, actor: actorOf(req),
  });
  return res.json({ success: true, ...out });
}));

/* ── WHAT AN OPERATION REQUIRES TO BE RUN — CHUNK 5A ─────────────────────────
 * Machine types, attachments, and operators or helpers at a skill and grade.
 * REQUIREMENTS, never allocations: there is no endpoint here that assigns a
 * person or a machine, none that reads availability, and none that calculates
 * capacity — those are other departments' answers, and IE states the question.
 *
 * The profile hangs off the operation because that is what it describes. It is
 * addressed separately from the operation's own PATCH so that setting
 * requirements cannot be smuggled into a rename, and so the Chunk 2A create and
 * edit contract is untouched. */

/** READ the profile. A retired operation reads exactly like an active one. */
router.get("/operations/library/:operationId/requirements", requireCompany, canRead, handle(async (req, res) => {
  const out = await ieLibrary.readRequirements(req.ie, { operationId: req.params.operationId });
  return res.json({ success: true, ...out });
}));

/** SET one or more requirement groups. An omitted group is left alone; an
 *  empty list is the decision that none are required. */
router.patch("/operations/library/:operationId/requirements", requireCompany, canWrite, handle(async (req, res) => {
  const out = await ieLibrary.updateRequirements(req.ie, {
    operationId: req.params.operationId,
    body: req.body,
    actor: actorOf(req),
  });
  return res.json({ success: true, ...out });
}));

/* There is no DELETE, here or anywhere on this router, and there is no route
   that removes an IeOperation document. Retirement is the only way an operation
   leaves the pickers, and it is reversible. */

/* ══ THE STYLE ENGINEERING FILE AND ITS DRAFT BULLETIN — CHUNK 3A ═════════════
 *
 * ── WHY THE FILE IS OPENED THROUGH AN ORDER ─────────────────────────────────
 * A SampleStyle carries no company of its own — Chunk 1B proved its company
 * through the Sales parents of the order that names it. So the creation and
 * read paths run through `/orders/:orderId/styles/:styleId`, and they call the
 * ACCEPTED order boundary to prove both halves rather than resolving ownership
 * a second way. There is no top-level styles module here and no way to reach a
 * file by naming a style alone.
 *
 * The bulletin edit and the history are addressed by the file's own id, whose
 * company is re-proved from the stored record on every request.
 *
 * Both guards on every write, as everywhere else in this department:
 * `requireCompany` proves whose file it is, `canWrite` proves the actor may
 * change one, and neither stands in for the other. */

/** OPEN (or return) the engineering file for a style on an order. */
router.post("/orders/:orderId/styles/:styleId/engineering-file", requireCompany, canWrite, handle(async (req, res) => {
  const out = await ieStyleFile.createFile(req.ie, {
    orderId: req.params.orderId,
    styleId: req.params.styleId,
    body: req.body,
    actor: actorOf(req),
  });
  /* 201 the first time, 200 when it already existed. The `created` flag says
     the same thing in the body, because a client that retried a request should
     be able to tell "I made this" from "this was already here". */
  return res.status(out.created ? 201 : 200).json({ success: true, ...out });
}));

/** READ the file for a style on an order. */
router.get("/orders/:orderId/styles/:styleId/engineering-file", requireCompany, canRead, handle(async (req, res) => {
  const out = await ieStyleFile.readFileForStyle(req.ie, {
    orderId: req.params.orderId,
    styleId: req.params.styleId,
  });
  return res.json({ success: true, ...out });
}));

/** REPLACE the draft bulletin — one PATCH, one revision, one audit entry set. */
router.patch("/engineering-files/:fileId/bulletin", requireCompany, canWrite, handle(async (req, res) => {
  const out = await ieStyleFile.updateBulletin(req.ie, {
    fileId: req.params.fileId,
    body: req.body,
    actor: actorOf(req),
  });
  return res.json({ success: true, ...out });
}));

/** The append-only audit trail, newest first. */
router.get("/engineering-files/:fileId/history", requireCompany, canRead, handle(async (req, res) => {
  const out = await ieStyleFile.readHistory(req.ie, {
    fileId: req.params.fileId,
    limit: req.query.limit,
  });
  return res.json({ success: true, ...out });
}));

/* ══ THE DRAFT METHOD STUDY — CHUNK 4A ═══════════════════════════════════════
 *
 * A study belongs to a BULLETIN ROW, so it is opened and listed through the
 * row's own path, and read or edited by its own id afterwards. The row path is
 * what proves the file is this company's before any study is touched; the study
 * path re-proves the company from the stored record.
 *
 * Reads need a viewer; opening and editing need an editor — the same two
 * separate checks as everywhere else on this router, neither standing in for
 * the other. There is no submit, approve, reject or apply-to-bulletin verb
 * here, and no DELETE: a study is evidence, and evidence that can be deleted is
 * not evidence. */

/** OPEN (or resume) the draft study for a bulletin row. */
router.post("/engineering-files/:fileId/bulletin/:rowId/method-studies", requireCompany, canWrite, handle(async (req, res) => {
  const out = await ieMethodStudy.createStudy(req.ie, {
    fileId: req.params.fileId,
    rowId: req.params.rowId,
    body: req.body,
    actor: actorOf(req),
  });
  /* 201 the first time, 200 when the draft was already open — the `created`
     flag says the same thing in the body, so a retried request can tell "I
     started this" from "this was already here". */
  return res.status(out.created ? 201 : 200).json({ success: true, ...out });
}));

/** Every study for that row — current and superseded alike. */
router.get("/engineering-files/:fileId/bulletin/:rowId/method-studies", requireCompany, canRead, handle(async (req, res) => {
  const out = await ieMethodStudy.listStudies(req.ie, {
    fileId: req.params.fileId,
    rowId: req.params.rowId,
    limit: req.query.limit,
    cursor: req.query.cursor,
  });
  return res.json({ success: true, ...out });
}));

/** One study: its cycles, its calculation, its history and its applicability. */
router.get("/method-studies/:studyId", requireCompany, canRead, handle(async (req, res) => {
  const out = await ieMethodStudy.readStudy(req.ie, { studyId: req.params.studyId });
  return res.json({ success: true, ...out });
}));

/** EDIT the draft — one revision, one audit entry, or nothing at all. */
router.patch("/method-studies/:studyId", requireCompany, canWrite, handle(async (req, res) => {
  const out = await ieMethodStudy.updateStudy(req.ie, {
    studyId: req.params.studyId,
    body: req.body,
    actor: actorOf(req),
  });
  return res.json({ success: true, ...out });
}));

/* ══ THE METHOD STUDY LIFECYCLE — CHUNK 4B ═══════════════════════════════════
 *
 * DRAFT ──submit──▶ IN_REVIEW ──approve──▶ APPROVED, with a return path back to
 * DRAFT. An editor submits; an APPROVER returns or approves, and never their own
 * submission. Each is one atomic document write — study status, submission
 * state, revision and audit event together, or none of them. */

/** SUBMIT a completed draft for review, freezing its standard time. */
router.post("/method-studies/:studyId/submit", requireCompany, canWrite, handle(async (req, res) => {
  const out = await ieMethodStudy.submitStudy(req.ie, {
    studyId: req.params.studyId, body: req.body, actor: actorOf(req),
  });
  return res.json({ success: true, ...out });
}));

/** RETURN it for correction, with a reason. Approver, and not the submitter. */
router.post("/method-studies/:studyId/return", requireCompany, canApprove, handle(async (req, res) => {
  const out = await ieMethodStudy.returnStudy(req.ie, {
    studyId: req.params.studyId, body: req.body, actor: actorOf(req),
  });
  return res.json({ success: true, ...out });
}));

/** APPROVE it. Approver, and not the submitter. Nothing is released. */
router.post("/method-studies/:studyId/approve", requireCompany, canApprove, handle(async (req, res) => {
  const out = await ieMethodStudy.approveStudy(req.ie, {
    studyId: req.params.studyId, body: req.body, actor: actorOf(req),
  });
  return res.json({ success: true, ...out });
}));

/** Every frozen submission, newest first — calculated against overridden, and
 *  what each decision was. */
router.get("/method-studies/:studyId/submissions", requireCompany, canRead, handle(async (req, res) => {
  const out = await ieMethodStudy.listSubmissions(req.ie, {
    studyId: req.params.studyId, limit: req.query.limit,
  });
  return res.json({ success: true, ...out });
}));

/* ══ THE COMPANY ALLOWANCE POLICY — CHUNK 4B ══════════════════════════════════
 *
 * Effective-dated, published by a second person, and immutable once published.
 * `/effective` answers "which rules applied on this day" and refuses rather than
 * falling back to the newest policy — a study timed in September must be
 * calculated on September's allowances.
 *
 * `/allowance-policies/effective` is registered BEFORE `/:policyId`, or express
 * would read the word "effective" as a policy id and answer not-found. */

/** The company's policies, newest effective date first. */
router.get("/allowance-policies", requireCompany, canRead, handle(async (req, res) => {
  const out = await ieAllowancePolicy.listPolicies(req.ie, {
    status: req.query.status, limit: req.query.limit, cursor: req.query.cursor,
  });
  return res.json({ success: true, ...out });
}));

/** WHICH POLICY APPLIES ON A DATE. */
router.get("/allowance-policies/effective", requireCompany, canRead, handle(async (req, res) => {
  const out = await ieAllowancePolicy.readEffectivePolicy(req.ie, { at: req.query.at });
  return res.json({ success: true, ...out });
}));

/** CREATE the company's one draft policy. */
router.post("/allowance-policies", requireCompany, canWrite, handle(async (req, res) => {
  const out = await ieAllowancePolicy.createPolicy(req.ie, { body: req.body, actor: actorOf(req) });
  return res.status(201).json({ success: true, ...out });
}));

/** One policy, with its history. */
router.get("/allowance-policies/:policyId", requireCompany, canRead, handle(async (req, res) => {
  const out = await ieAllowancePolicy.readPolicy(req.ie, { policyId: req.params.policyId });
  return res.json({ success: true, ...out });
}));

/** EDIT the draft. A published policy is refused by name, not silently ignored. */
router.patch("/allowance-policies/:policyId", requireCompany, canWrite, handle(async (req, res) => {
  const out = await ieAllowancePolicy.updatePolicy(req.ie, {
    policyId: req.params.policyId, body: req.body, actor: actorOf(req),
  });
  return res.json({ success: true, ...out });
}));

/** PUBLISH it — approver, and never the person who wrote it. */
router.post("/allowance-policies/:policyId/publish", requireCompany, canApprove, handle(async (req, res) => {
  const out = await ieAllowancePolicy.publishPolicyDraft(req.ie, {
    policyId: req.params.policyId, body: req.body, actor: actorOf(req),
  });
  return res.json({ success: true, ...out });
}));

/* ══ THE LINE LAYOUT AND ITS BALANCE — CHUNK 6A ══════════════════════════════
 *
 * The bulletin's operations arranged into ordered stations, and the balance
 * that arrangement produces. An engineering STANDARD: it is opened against one
 * exact bulletin revision, it calculates only from standard times a second
 * person approved in Chunk 4B, and it allocates nothing.
 *
 * A layout is opened and listed through its engineering file — the file is what
 * proves the company and holds the bulletin — and read or edited afterwards by
 * its own id. There is no submit, approve, release or Production
 * acknowledgement verb here, and no capacity, target output or shift: Chunk 7
 * owns those, and a shell built against this router cannot find a control for
 * them to wire up. */

/** OPEN (or resume) the layout for this file's current bulletin revision. */
router.post("/engineering-files/:fileId/line-layouts", requireCompany, canWrite, handle(async (req, res) => {
  const out = await ieLineLayout.createLayout(req.ie, {
    fileId: req.params.fileId, body: req.body, actor: actorOf(req),
  });
  return res.status(out.created ? 201 : 200).json({ success: true, ...out });
}));

/** Every layout for this file — current and superseded alike. */
router.get("/engineering-files/:fileId/line-layouts", requireCompany, canRead, handle(async (req, res) => {
  const out = await ieLineLayout.listLayouts(req.ie, {
    fileId: req.params.fileId, limit: req.query.limit, cursor: req.query.cursor,
  });
  return res.json({ success: true, ...out });
}));

/** One layout: its stations, its metrics, its readiness and its history. */
router.get("/line-layouts/:layoutId", requireCompany, canRead, handle(async (req, res) => {
  const out = await ieLineLayout.readLayout(req.ie, { layoutId: req.params.layoutId });
  return res.json({ success: true, ...out });
}));

/** EDIT the stations — one revision, one audit entry, or nothing at all. */
router.patch("/line-layouts/:layoutId", requireCompany, canWrite, handle(async (req, res) => {
  const out = await ieLineLayout.updateLayout(req.ie, {
    layoutId: req.params.layoutId, body: req.body, actor: actorOf(req),
  });
  return res.json({ success: true, ...out });
}));

/**
 * APPROVE this balance as the plan — Chunk 7C2.
 *
 * `approver`, because the whole purpose of a decision is that somebody other
 * than the author takes it. The role is only the first half: the command also
 * compares actor ids, so an approver cannot approve their own layout.
 *
 * An approved layout is permanent evidence. Nothing here releases it, publishes
 * it, acknowledges it or books capacity against it — those are Chunks 7C3 and
 * 8, and a shell built against this router cannot find a control for them.
 */
router.post("/line-layouts/:layoutId/approve", requireCompany, canApprove, handle(async (req, res) => {
  const out = await ieLineLayout.approveLayout(req.ie, {
    layoutId: req.params.layoutId, body: req.body, actor: actorOf(req),
  });
  return res.json({ success: true, ...out });
}));

/* ── REUSABLE LINE TEMPLATES — CHUNK 6C ──────────────────────────────────────
 *
 * A template is an engineering PATTERN: station order, labels, notes, planned
 * machine types and which operations belong where. It is captured from a layout
 * that exists and applied to another later.
 *
 * ── COMPANY-SCOPED, EXACTLY AS EVERYTHING ELSE HERE IS ──────────────────────
 * `requireCompany` resolves the acting company from proved membership, so a
 * template belonging to another company is indistinguishable from one that does
 * not exist. Reading needs `viewer`; capturing, editing, retiring, restoring and
 * applying need `editor`.
 *
 * ── AND THERE IS STILL NO DELETE ────────────────────────────────────────────
 * A template leaves the pickers by being RETIRED, which is reversible and
 * removes no record — the same rule the operation library has held since Chunk
 * 2A. There is no approve, no release, no allocation and no capacity verb here
 * either: a shell built against this router cannot find a control for one.
 */

/** CAPTURE a reusable pattern from a layout this company owns. */
router.post("/line-templates", requireCompany, canWrite, handle(async (req, res) => {
  const out = await ieLineTemplate.createTemplate(req.ie, { body: req.body, actor: actorOf(req) });
  return res.status(201).json({ success: true, ...out });
}));

/** The company's templates, newest first — retired ones included and labelled. */
router.get("/line-templates", requireCompany, canRead, handle(async (req, res) => {
  const out = await ieLineTemplate.listTemplates(req.ie, {
    status: req.query.status, limit: req.query.limit, cursor: req.query.cursor,
  });
  return res.json({ success: true, ...out });
}));

/** One template: its pattern, its provenance and its history. */
router.get("/line-templates/:templateId", requireCompany, canRead, handle(async (req, res) => {
  const out = await ieLineTemplate.readTemplate(req.ie, { templateId: req.params.templateId });
  return res.json({ success: true, ...out });
}));

/** EDIT its metadata and its pattern — one revision, one audit entry, or nothing. */
router.patch("/line-templates/:templateId", requireCompany, canWrite, handle(async (req, res) => {
  const out = await ieLineTemplate.updateTemplate(req.ie, {
    templateId: req.params.templateId, body: req.body, actor: actorOf(req),
  });
  return res.json({ success: true, ...out });
}));

/** RETIRE — reversible, and it deletes nothing. */
router.post("/line-templates/:templateId/retire", requireCompany, canWrite, handle(async (req, res) => {
  const out = await ieLineTemplate.retireTemplate(req.ie, {
    templateId: req.params.templateId, body: req.body, actor: actorOf(req),
  });
  return res.json({ success: true, ...out });
}));

/** RESTORE — which can be refused, because retiring released the name. */
router.post("/line-templates/:templateId/restore", requireCompany, canWrite, handle(async (req, res) => {
  const out = await ieLineTemplate.restoreTemplate(req.ie, {
    templateId: req.params.templateId, body: req.body, actor: actorOf(req),
  });
  return res.json({ success: true, ...out });
}));

/**
 * BUILD this layout FROM a template — one atomic layout update.
 *
 * Named `from-template` rather than `apply-template` on purpose: "apply" is the
 * word this router has reserved since Chunk 3A for releasing or publishing a
 * standard downstream, and five accepted boundary tests hold the router to
 * having no such verb. This is not one — nothing leaves Industrial Engineering
 * — and the name says what actually happens.
 *
 * It lives on the LAYOUT because that is what changes: the answer is the
 * complete published layout, with its balance, its compatibility and its
 * readiness recalculated by the layout's own publisher.
 */
router.post("/line-layouts/:layoutId/from-template", requireCompany, canWrite, handle(async (req, res) => {
  const out = await ieLineTemplate.applyTemplate(req.ie, {
    layoutId: req.params.layoutId, body: req.body, actor: actorOf(req),
  });
  return res.json({ success: true, ...out });
}));

/* ══ CAPACITY STANDARDS AND TARGETS — CHUNK 7A ═══════════════════════════════
 *
 * What a balanced line is a STANDARD for: pieces an hour, a shift and a day,
 * from a garment SAM this server sums off the layout's frozen approved standard
 * times and working-time assumptions somebody stated on the record.
 *
 * ── IT IS CREATED ON THE LAYOUT, AND READ BY ITS OWN ID ─────────────────────
 * The layout is what proves the company and holds the frozen source, so a
 * standard is opened through it. Afterwards it has its own identity, because a
 * layout may hold several — a conservative assumption and an optimistic one —
 * and nothing here decides which is "the" one: deciding that is approval.
 *
 * ── AND THERE IS NO APPROVE, RELEASE, PUBLISH, BOOK OR ACKNOWLEDGE VERB ─────
 * Chunk 7A calculates a standard. It does not approve it, release it to
 * Planning, publish it to Production, book capacity against it or promise a
 * delivery date, and a shell built against this router cannot find a control
 * for any of those. The published record says so in as many words.
 */

/** OPEN a capacity standard against this exact line layout revision. */
router.post("/line-layouts/:layoutId/capacity-standards", requireCompany, canWrite, handle(async (req, res) => {
  const out = await ieCapacityStandard.createStandard(req.ie, {
    layoutId: req.params.layoutId, body: req.body, actor: actorOf(req),
  });
  return res.status(201).json({ success: true, ...out });
}));

/** This layout's capacity standards, newest first. */
router.get("/line-layouts/:layoutId/capacity-standards", requireCompany, canRead, handle(async (req, res) => {
  const out = await ieCapacityStandard.listStandards(req.ie, {
    layoutId: req.params.layoutId, limit: req.query.limit, cursor: req.query.cursor,
  });
  return res.json({ success: true, ...out });
}));

/** The company's capacity standards — enough for the future Capacity page. */
router.get("/capacity-standards", requireCompany, canRead, handle(async (req, res) => {
  const out = await ieCapacityStandard.listStandards(req.ie, {
    layoutId: req.query.layoutId, styleFileId: req.query.styleFileId,
    limit: req.query.limit, cursor: req.query.cursor,
  });
  return res.json({ success: true, ...out });
}));

/** One standard: its frozen source, its inputs, its calculation and its history. */
router.get("/capacity-standards/:capacityStandardId", requireCompany, canRead, handle(async (req, res) => {
  const out = await ieCapacityStandard.readStandard(req.ie, {
    capacityStandardId: req.params.capacityStandardId,
  });
  return res.json({ success: true, ...out });
}));

/** EDIT the planning inputs — one revision, one audit entry, or nothing at all. */
router.patch("/capacity-standards/:capacityStandardId", requireCompany, canWrite, handle(async (req, res) => {
  const out = await ieCapacityStandard.updateStandard(req.ie, {
    capacityStandardId: req.params.capacityStandardId, body: req.body, actor: actorOf(req),
  });
  return res.json({ success: true, ...out });
}));

/**
 * APPROVE this target — Chunk 7C3.
 *
 * `approver`, because the whole purpose of a decision is that somebody other
 * than the author takes it. The role is only the first half: the command also
 * compares actor ids, so an approver cannot approve their own standard.
 *
 * ── APPROVING PROVES NO CALENDAR ────────────────────────────────────────────
 * A PROVISIONAL standard is the ordinary thing to approve, and approving it
 * changes nothing about why it is provisional: the working time is still an
 * explicitly stated IE assumption, the calendar linkage is still UNKNOWN, and
 * the assumed-working-time gap still travels with the record. What a second
 * person accepts is the assumption, not a calendar.
 *
 * Nothing here releases the standard, acknowledges it, books capacity against
 * it or promises a date. Chunk 8 owns release, and a shell built against this
 * router cannot find a control for it.
 */
router.post("/capacity-standards/:capacityStandardId/approve", requireCompany, canApprove, handle(async (req, res) => {
  const out = await ieCapacityStandard.approveStandard(req.ie, {
    capacityStandardId: req.params.capacityStandardId, body: req.body, actor: actorOf(req),
  });
  return res.json({ success: true, ...out });
}));

/* ══ RAMP PROFILES — CHUNK 7B ════════════════════════════════════════════════
 *
 * A stated assumption about how a line reaches its steady-state efficiency:
 * production days one to three at forty per cent, four to ten at sixty, and so
 * on. A capacity standard names a profile and a stage explicitly and freezes
 * both, so correcting a profile afterwards restates no target already planned.
 *
 * ── WHY IT IS A REGISTER AND NOT A FIELD ────────────────────────────────────
 * Two styles on the same floor ramp the same way, and a ramp is argued about on
 * its own terms — so it is reviewable, versioned and named, like the operation
 * library and the line templates before it.
 *
 * ── AND THERE IS STILL NO DELETE, AND NOTHING THAT OBSERVES A RUN ───────────
 * A profile leaves the pickers by being RETIRED, which is reversible and removes
 * no record. Nothing here reads a date, a scan, a piece of output or an
 * attendance row: a stage says what is PLANNED, and which stage applies is a
 * person's explicit choice. There is no approve, release or acknowledge verb.
 */

/** CREATE a ramp profile for this company. */
router.post("/ramp-profiles", requireCompany, canWrite, handle(async (req, res) => {
  const out = await ieRampProfile.createProfile(req.ie, { body: req.body, actor: actorOf(req) });
  return res.status(201).json({ success: true, ...out });
}));

/** The company's profiles, newest first — retired ones included and labelled. */
router.get("/ramp-profiles", requireCompany, canRead, handle(async (req, res) => {
  const out = await ieRampProfile.listProfiles(req.ie, {
    status: req.query.status, limit: req.query.limit, cursor: req.query.cursor,
  });
  return res.json({ success: true, ...out });
}));

/** One profile: its stages and its history. */
router.get("/ramp-profiles/:rampProfileId", requireCompany, canRead, handle(async (req, res) => {
  const out = await ieRampProfile.readProfile(req.ie, { rampProfileId: req.params.rampProfileId });
  return res.json({ success: true, ...out });
}));

/** EDIT its name, description and stages — one revision, one entry, or nothing. */
router.patch("/ramp-profiles/:rampProfileId", requireCompany, canWrite, handle(async (req, res) => {
  const out = await ieRampProfile.updateProfile(req.ie, {
    rampProfileId: req.params.rampProfileId, body: req.body, actor: actorOf(req),
  });
  return res.json({ success: true, ...out });
}));

/** RETIRE — reversible, and it deletes nothing and rewrites no standard. */
router.post("/ramp-profiles/:rampProfileId/retire", requireCompany, canWrite, handle(async (req, res) => {
  const out = await ieRampProfile.retireProfile(req.ie, {
    rampProfileId: req.params.rampProfileId, body: req.body, actor: actorOf(req),
  });
  return res.json({ success: true, ...out });
}));

/** RESTORE — which can be refused, because retiring released the name. */
router.post("/ramp-profiles/:rampProfileId/restore", requireCompany, canWrite, handle(async (req, res) => {
  const out = await ieRampProfile.restoreProfile(req.ie, {
    rampProfileId: req.params.rampProfileId, body: req.body, actor: actorOf(req),
  });
  return res.json({ success: true, ...out });
}));

/* ══ OPERATION BULLETIN VERSIONS — CHUNK 7C1 ════════════════════════════════
 *
 * The Style File's embedded bulletin remains the one writable draft, and
 * `PATCH /engineering-files/:fileId/bulletin` remains its only writer. These
 * five routes move SUBMITTED SNAPSHOTS through their lifecycle.
 *
 * ── WHY SUBMIT IS AN EDITOR AND THE OTHER TWO ARE APPROVERS ─────────────────
 * Submit PROPOSES: it is the last act of authoring, and the person who wrote
 * the bulletin is the right person to say it is finished. Return and approve
 * DECIDE, and the whole purpose of a decision is that somebody other than the
 * author takes it — so they sit on the third rung of the same department
 * vocabulary, beside publishing an allowance policy and deciding a method
 * study. The role is only the first half: approval additionally compares actor
 * ids, so an approver cannot approve their own submission.
 *
 * ── AND THERE IS STILL NO RELEASE VERB HERE ─────────────────────────────────
 * Approving a bulletin version makes it this file's current approved bulletin.
 * It publishes nothing downstream, acknowledges nothing, and books nothing —
 * Chunk 8 owns release, and a shell built against this router cannot find a
 * control for it. There is no delete either: a returned version is evidence,
 * and evidence is not removed.
 */

/** SUBMIT the current draft as a new version, freezing the draft. */
router.post("/engineering-files/:fileId/bulletin-versions", requireCompany, canWrite, handle(async (req, res) => {
  const out = await ieBulletinVersion.submitVersion(req.ie, {
    fileId: req.params.fileId, body: req.body, actor: actorOf(req),
  });
  return res.status(201).json({ success: true, ...out });
}));

/** This file's versions, newest first — every state, labelled. */
router.get("/engineering-files/:fileId/bulletin-versions", requireCompany, canRead, handle(async (req, res) => {
  const out = await ieBulletinVersion.listVersions(req.ie, {
    fileId: req.params.fileId, state: req.query.state,
    limit: req.query.limit, cursor: req.query.cursor,
  });
  return res.json({ success: true, ...out });
}));

/** One version: its frozen rows, its evidence and its history. */
router.get("/bulletin-versions/:versionId", requireCompany, canRead, handle(async (req, res) => {
  const out = await ieBulletinVersion.readVersion(req.ie, { versionId: req.params.versionId });
  return res.json({ success: true, ...out });
}));

/** RETURN it — terminal, and it unfreezes the draft. */
router.post("/bulletin-versions/:versionId/return", requireCompany, canApprove, handle(async (req, res) => {
  const out = await ieBulletinVersion.returnVersion(req.ie, {
    versionId: req.params.versionId, body: req.body, actor: actorOf(req),
  });
  return res.json({ success: true, ...out });
}));

/** APPROVE it — it becomes the file's current approved bulletin. */
router.post("/bulletin-versions/:versionId/approve", requireCompany, canApprove, handle(async (req, res) => {
  const out = await ieBulletinVersion.approveVersion(req.ie, {
    versionId: req.params.versionId, body: req.body, actor: actorOf(req),
  });
  return res.json({ success: true, ...out });
}));

/* ══ THE IE RELEASE — CHUNK 8A-i ═════════════════════════════════════════════
 *
 * The moment Industrial Engineering hands Planning a complete, approved
 * aggregate: one approved Operation Bulletin Version, one approved Line Layout
 * at one exact revision, and one approved Capacity Standard bound to that
 * revision. The release freezes all three and is immutable from the instant it
 * exists.
 *
 * ── `approver`, AND AN IDEMPOTENCY KEY ──────────────────────────────────────
 * Issuing is a decision, so it sits on the third rung of the same department
 * vocabulary. The key is REQUIRED rather than optional because a release is the
 * one IE command whose accidental repetition is expensive: a retried request
 * without one would mint a second version, supersede the first, and leave
 * Planning reconciling two handovers of the same plan.
 *
 * ── AND THIS IS WHERE IT STOPS ──────────────────────────────────────────────
 * There is no acknowledgement route, no PPC receipt, no change-impact
 * comparison, no withdrawal and no outbox. Delivery is a READ of the release
 * collection, which a later chunk builds. A shell built against this router can
 * find none of them.
 */
router.post("/style-files/:fileId/releases", requireCompany, canApprove, handle(async (req, res) => {
  const out = await ieRelease.issueRelease(req.ie, {
    fileId: req.params.fileId,
    body: req.body,
    /* Header names are case-insensitive in Node, and the key never comes from
       the body — a body field could be replayed verbatim by a client that
       believed it was retrying. */
    idempotencyKey: req.get("Idempotency-Key"),
    actor: actorOf(req),
  });
  return res.status(out.created ? 201 : 200).json({
    success: true, created: Boolean(out.created), release: out.release,
  });
}));

/* ══ CHANGE IMPACT — CHUNK 8A-iii ════════════════════════════════════════════
 *
 * What has moved since this release was issued: the release's own frozen
 * bulletin evidence against the style file's CURRENT approved bulletin version,
 * row by row, with the digest movement, the garment-SAM delta, the capacity
 * delta, and the work orders whose link to this style is actually provable.
 *
 * ── A READ, AND ONLY A READ ─────────────────────────────────────────────────
 * `viewer`, because asking what changed is not deciding anything. It is
 * computed on demand and stored nowhere: a cached impact record would be a
 * second, weaker copy of a fact both bulletins already hold, and the first time
 * it disagreed with them nobody could say which was right.
 *
 * It writes nothing. Not the release, not the style file, not a bulletin
 * version, not a history event, not a PPC receipt, not an outbox row, and not a
 * work order, barcode identity or scan record. Work orders are READ, and the
 * ones it cannot prove are named as unprovable rather than quietly dropped.
 */
router.get("/releases/:releaseId/impact", requireCompany, canRead, handle(async (req, res) => {
  const out = await ieReleaseImpact.readImpact(req.ie, { releaseId: req.params.releaseId });
  return res.json({ success: true, ...out });
}));

/* There is still no DELETE anywhere on this router, and no verb that releases an
   approved standard time to another department or writes it into a bulletin
   row. Both are later decisions, and neither has a door here. */

module.exports = router;
