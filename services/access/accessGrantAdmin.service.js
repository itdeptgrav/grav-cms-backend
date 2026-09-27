// services/access/accessGrantAdmin.service.js
//
// THE ONE WRITE PATH FOR APPLICATION ACCESS (GAC-2, 25 Sep 2026).
//
//   changeAppAccess({ actor, email, application, role, reason, idempotencyKey, body })
//
// canonical person + application + Viewer/Editor/Approver/Owner or revoke +
// mandatory reason + idempotency key. Every Access Control grant, role change
// and revoke goes through here; the routes that still exist for older screens
// are thin adapters over this function (see routes/Admin/accessAdmin.js and
// routes/Access/departmentTeam.js).
//
// What the browser may say: who (an email), which application, which role (or
// none), why, and a key for retries. What it may NEVER say — refused outright,
// never ignored: a company, company grants or membership, administrator status,
// capabilities, the current/previous/effective role, an identity id or kind, a
// password. Those are the server's to know.
//
// ── STORAGE: THE EXISTING AUTHORITIES, NO NEW ONE ────────────────────────────
//   · DepartmentRole (global role row) for every application except Accounting;
//     `companyGrants[]` is never written.
//   · Accounting: an explicit adapter over Acc_User — the role Accounting's
//     own orgAuth reads on every request. Never duplicated into DepartmentRole.
// Administrator status (DeptUser.isAdmin) is NOT written here and a grant never
// sets it; PATCH /api/admin/users/:id is that separate write.
//
// ── SAFETY ───────────────────────────────────────────────────────────────────
//   · Target identity is the canonical one (services/access/canonicalIdentity);
//     missing, inactive and ambiguous targets are refused; nothing is created.
//   · Actor must be the application's Owner per the canonical resolver — which
//     a database-verified platform administrator is in every application.
//     Nobody but an administrator may change their own role.
//   · One MongoDB transaction per change, SERIALISED on the single
//     `access_grant_head` document (the audit chain head), so no two access
//     changes — to any applications — can interleave: no lost updates, no
//     conflicting Owner changes. Inside it: the idempotency lookup, the head
//     advance, the before-state read, the last-Owner check, the write and the
//     audit event. A failure anywhere writes nothing.
//   · AUDIT (GAC-2 correction): the record of authority is an append-only
//     AccessGrantEvent (models/Access/AccessGrantEvent.js) — mutation refused
//     by the model, hash-chained so raw tampering is detectable. A ChangeLog
//     line is still written for the History screen; it is a display copy only.
//   · IDEMPOTENCY IN STORAGE: the event's `_id` IS the idempotency key, so the
//     database itself refuses a second event for one key, across every
//     application. A retry with the same key and request returns the original
//     result and writes nothing; the same key for a different request is
//     refused (409 IDEMPOTENCY_KEY_REUSED).
//   · Existing module rules kept: one Owner per application (granting Owner
//     demotes the incumbent to Approver, as setRole always has); the last
//     active Owner cannot be revoked or demoted; Accounting's one owner per
//     organisation, whom a revoke can never remove.
//   · STALE AUTHORITY: the transaction advances the shared grant revision
//     (services/access/grantRevision.js); every authorization cache checks it
//     on each hit, so the next request in ANY process sees the change even if
//     the local cache clear after commit fails. Accounting sessions whose role
//     changed — including an automatically demoted Owner — have tokenVersion
//     incremented, so their existing accountant tokens stop working.
//   · The response is RE-READ through resolveAppAccess() — never built from
//     the request.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const ROLE_KEYS = ["viewer", "editor", "approver", "owner"];
const ACCOUNTING = "accountant";
const ENTITY = "access-grant";

class AccessGrantError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}
const refuse = (status, code, message, details) => { throw new AccessGrantError(status, code, message, details); };

/* ── input ────────────────────────────────────────────────────────────── */

/** The only keys a caller may send. Anything else is refused by name. */
const ALLOWED_KEYS = new Set(["email", "application", "role", "reason", "idempotencyKey", "name", "budgetDepartments"]);

/** Refused with a specific message, because each is a forgery risk. */
const FORBIDDEN_KEYS = [
  "companyId", "companyIds", "company", "companyGrants", "companyScope", "tenant", "tenantId",
  "membership", "memberships", "organizationId", "organisationId",
  "isAdmin", "admin", "platformAdmin",
  "capabilities", "capability", "permissions",
  "currentRole", "previousRole", "effectiveRole", "fromRole", "source", "subject", "identityId", "identityKind",
  "password",
];

/** Headers that would assert a company; refused on this write path. */
const FORBIDDEN_HEADERS = ["x-company-id", "x-costing-company", "x-store-purchase-company", "x-tenant-id"];

const FILLER_REASONS = new Set([
  "test", "testing", "n/a", "na", "none", "ok", "okay", "change", "changed", "update", "updated",
  "fix", "asdf", "reason", "no reason", "access", "role", "grant", "revoke", ".", "-", "x",
]);

function assertMeaningfulReason(reason) {
  const text = String(reason ?? "").trim();
  if (!text) refuse(400, "REASON_REQUIRED", "Give a reason for this access change.");
  if (text.length < 10 || !/[a-z]{3,}/i.test(text) || FILLER_REASONS.has(text.toLowerCase())) {
    refuse(400, "REASON_NOT_MEANINGFUL", "Say why this access is changing, in at least a short sentence (10+ characters).");
  }
  if (text.length > 500) refuse(400, "REASON_TOO_LONG", "Keep the reason under 500 characters.");
  return text;
}

function assertIdempotencyKey(key) {
  const k = String(key ?? "").trim();
  if (!k) refuse(400, "IDEMPOTENCY_KEY_REQUIRED", "An idempotency key is required so a retried request cannot apply twice.");
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(k)) refuse(400, "IDEMPOTENCY_KEY_INVALID", "The idempotency key must be 8–128 letters, digits or . _ : -");
  return k;
}

/**
 * Validate the raw request (body + headers). Throws AccessGrantError.
 * @returns normalised { email, application, role, reason, idempotencyKey, name, budgetDepartments }
 */
function parseRequest({ body = {}, headers = {}, defaults = {} } = {}) {
  const src = { ...defaults, ...(body || {}) };
  for (const h of FORBIDDEN_HEADERS) {
    if (headers?.[h] !== undefined && headers[h] !== "") {
      refuse(400, "COMPANY_SCOPE_NOT_ACCEPTED", "GRAV Clothing is the only organisation — a company header is not accepted on an access change.", { header: h });
    }
  }
  for (const key of Object.keys(body || {})) {
    if (FORBIDDEN_KEYS.includes(key)) {
      const company = /compan|tenant|member|organi/i.test(key);
      refuse(400, company ? "COMPANY_SCOPE_NOT_ACCEPTED" : "FIELD_NOT_ACCEPTED",
        company
          ? "GRAV Clothing is the only organisation — company-scoped access is not accepted."
          : `"${key}" is decided by the server and cannot be sent.`,
        { field: key });
    }
    if (!ALLOWED_KEYS.has(key)) refuse(400, "FIELD_NOT_ACCEPTED", `"${key}" is not part of an access change.`, { field: key });
  }
  const email = String(src.email || "").toLowerCase().trim();
  if (!email || !email.includes("@")) refuse(400, "EMAIL_REQUIRED", "Name the person by their email address.");
  const application = String(src.application || "").toLowerCase().trim();
  if (!application) refuse(400, "APPLICATION_REQUIRED", "Name the application.");
  const role = src.role === null || src.role === undefined || src.role === "" ? null : String(src.role).toLowerCase().trim();
  if (role !== null && !ROLE_KEYS.includes(role)) refuse(400, "INVALID_ROLE", `Role must be one of ${ROLE_KEYS.join(", ")}, or none to revoke.`);
  const reason = assertMeaningfulReason(src.reason);
  const idempotencyKey = assertIdempotencyKey(src.idempotencyKey ?? headers?.["idempotency-key"]);
  let budgetDepartments;
  if (src.budgetDepartments !== undefined) {
    if (application !== "budget") refuse(400, "FIELD_NOT_ACCEPTED", "budgetDepartments applies to the Budget application only.", { field: "budgetDepartments" });
    budgetDepartments = [...new Set((Array.isArray(src.budgetDepartments) ? src.budgetDepartments : [])
      .map((v) => String(v ?? "").trim().toLowerCase()).filter(Boolean))];
  }
  return { email, application, role, reason, idempotencyKey, name: src.name ? String(src.name).trim() : "", budgetDepartments };
}

/* ── identity and authority ───────────────────────────────────────────── */

/** The canonical target, or a refusal. Never creates anything. */
async function canonicalTarget(email) {
  const { findCandidates, classify } = require("./canonicalIdentity.service");
  const kind = await classify(email);
  if (kind.kind === "none" || kind.kind === "legacy") {
    // A person whose only records are deactivated is inactive, not missing.
    const c = kind.counts || {};
    if ((c.employees > 0 && c.activeEmployees === 0) || (c.accUsers > 0 && c.activeAccUsers === 0)) {
      refuse(409, "IDENTITY_INACTIVE", "That person's login is deactivated. Reactivating a person is not an access change.");
    }
    refuse(404, "IDENTITY_NOT_FOUND", "No active login or employee has that email.");
  }
  if (kind.kind === "ambiguous") refuse(409, "AMBIGUOUS_IDENTITY", "That email belongs to more than one account. Merge them before granting access.");
  const c = await findCandidates(email);
  if (kind.kind === "dept_user") {
    if (!c.deptUser.isActive) refuse(409, "IDENTITY_INACTIVE", "That person's login is deactivated.");
    return { subject: "dept_user", id: c.deptUser._id, email: c.deptUser.email, name: c.deptUser.name,
      actor: { id: c.deptUser._id, email: c.deptUser.email, subject: "dept_user", tv: c.deptUser.tokenVersion || 0 } };
  }
  if (kind.kind === "employee") {
    const e = c.employees.find((x) => x.isActive !== false && x.status !== "inactive");
    return { subject: "employee", id: e._id, email: e.email, name: `${e.firstName || ""} ${e.lastName || ""}`.trim(),
      actor: { id: e._id, email: e.email, subject: "employee" } };
  }
  const a = c.accUsers.find((x) => x.isActive);
  return { subject: "accountant", id: a._id, email: a.email, name: a.name,
    actor: { id: a._id, email: a.email, subject: "accountant", tv: a.tokenVersion || 0 } };
}

/**
 * May this actor administer this application's access? Its Owner per the
 * canonical resolver — every database-verified platform administrator is. The
 * actor is re-read; no claim is trusted.
 */
async function authorise(actor, application) {
  const { resolveAppAccess, isVerifiedPlatformAdmin } = require("./appAccess.service");
  const access = await resolveAppAccess(actor, application);
  if (access.denialCode === "ACCESS_CHECK_UNAVAILABLE") refuse(503, "ACCESS_GRANT_UNAVAILABLE", "Access could not be checked just now. Nothing was changed.");
  // Only somebody entitled to administer access is told an application is
  // missing or inactive; everybody else gets the same 403.
  if ((access.denialCode === "APP_NOT_FOUND" || access.denialCode === "APP_INACTIVE") && await isVerifiedPlatformAdmin(actor)) {
    if (access.denialCode === "APP_NOT_FOUND") refuse(404, "APP_NOT_FOUND", "No such application.");
    refuse(409, "APP_INACTIVE", "That application is not active.");
  }
  if (!access.allowed || access.role !== "owner") {
    refuse(403, "NOT_APPLICATION_OWNER", "Only a platform administrator or this application's Owner can change who has access to it.");
  }
  return { isAdmin: await isVerifiedPlatformAdmin(actor) };
}

/* ── storage adapters (inside the transaction) ────────────────────────── */

function fingerprint(actor, req) {
  return crypto.createHash("sha256").update(JSON.stringify({
    actor: String(actor.id), email: req.email, application: req.application, role: req.role,
    reason: req.reason, budgetDepartments: req.budgetDepartments ?? null,
  })).digest("hex");
}

/** DepartmentRole adapter — every application except Accounting. */
const departmentRoleStore = {
  async read(session, app, email) {
    const DepartmentRole = require("../../models/Access/DepartmentRole");
    const row = await DepartmentRole.findOne({ departmentSlug: app, email }).session(session).lean();
    return { role: row && row.isActive ? row.role : null, budgetDepartments: row?.budgetDepartments ?? null };
  },
  async otherActiveOwners(session, app, email) {
    const DepartmentRole = require("../../models/Access/DepartmentRole");
    return DepartmentRole.countDocuments({ departmentSlug: app, role: "owner", isActive: true, email: { $ne: email } }).session(session);
  },
  async write(session, app, email, req, target, actor) {
    const DepartmentRole = require("../../models/Access/DepartmentRole");
    const sideEffects = [];
    if (req.role === null) {
      await DepartmentRole.updateOne({ departmentSlug: app, email }, { $set: { isActive: false } }, { session });
      return sideEffects;
    }
    if (req.role === "owner") {
      // One Owner per application — the incumbent becomes Approver, recorded.
      const incumbents = await DepartmentRole.find({ departmentSlug: app, role: "owner", isActive: true, email: { $ne: email } })
        .select("email").session(session).lean();
      if (incumbents.length) {
        await DepartmentRole.updateMany({ departmentSlug: app, role: "owner", email: { $ne: email } }, { $set: { role: "approver" } }, { session });
        for (const i of incumbents) sideEffects.push({ email: i.email, from: "owner", to: "approver" });
      }
    }
    await DepartmentRole.updateOne(
      { departmentSlug: app, email },
      {
        $set: {
          role: req.role, isActive: true,
          ...(req.name || target.name ? { name: req.name || target.name } : {}),
          ...(req.budgetDepartments !== undefined ? { budgetDepartments: req.budgetDepartments } : {}),
          grantedBy: actor.id, grantedByEmail: actor.email || "",
        },
        $setOnInsert: { departmentSlug: app, email },
      },
      { upsert: true, session },
    );
    return sideEffects;
  },
};

/** Accounting adapter — Acc_User, the store Accounting's orgAuth reads. */
const accountingStore = {
  async read(session, app, email) {
    const { Acc_User } = require("../../models/Accountant_model/Acc_OrgModels");
    const u = await Acc_User.findOne({ email }).session(session).lean();
    return { role: u && u.isActive ? u.role : null, budgetDepartments: null, _row: u };
  },
  async otherActiveOwners(session, app, email) {
    const { Acc_User } = require("../../models/Accountant_model/Acc_OrgModels");
    return Acc_User.countDocuments({ role: "owner", isActive: true, email: { $ne: email } }).session(session);
  },
  async write(session, app, email, req, target, actor) {
    const { Acc_User, Acc_Organization } = require("../../models/Accountant_model/Acc_OrgModels");
    const sideEffects = [];
    let row = await Acc_User.findOne({ email }).session(session);
    if (req.role === null) {
      if (row) {
        // Accounting rule kept: the organisation owner cannot be removed.
        if (row.role === "owner" && row.isActive) refuse(409, "ACCOUNTING_OWNER_REQUIRED", "The Accounting owner cannot be removed. Make somebody else the owner first.");
        row.isActive = false;
        row.tokenVersion = (row.tokenVersion || 0) + 1; // their accounting sessions end now
        await row.save({ session });
      }
      return sideEffects;
    }
    const org = row
      ? { _id: row.organizationId }
      : await Acc_Organization.findOne({}).sort({ createdAt: 1 }).session(session).lean();
    if (!org) refuse(409, "ACCOUNTING_NOT_SET_UP", "Accounting has no organisation yet.");
    if (req.role === "owner") {
      const incumbents = await Acc_User.find({ organizationId: org._id, role: "owner", email: { $ne: email } }).select("email").session(session).lean();
      if (incumbents.length) {
        // The demoted Owner's authority changed, so their accounting sessions
        // must end too — tokenVersion is what orgAuth checks on every request.
        await Acc_User.updateMany(
          { organizationId: org._id, role: "owner", email: { $ne: email } },
          { $set: { role: "approver" }, $inc: { tokenVersion: 1 } },
          { session },
        );
        for (const i of incumbents) sideEffects.push({ email: i.email, from: "owner", to: "approver", sessionsEnded: true });
      }
    }
    if (!row) {
      // Only reachable for a DeptUser or Employee target (an accounting-only
      // person's identity IS their Acc_User row, so it exists). This row is
      // ROLE STORAGE: loginMode "none", no password hash. It is never a login
      // (every password path refuses it by loginMode) and never an identity
      // (canonicalIdentity excludes it) — see models/Accountant_model/Acc_OrgModels.js.
      if (target.subject === "accountant") refuse(409, "ACCOUNTING_RECORD_MISSING", "That Accounting login record could not be found.");
      row = new Acc_User({
        organizationId: org._id, email, name: req.name || target.name || email, role: req.role, isActive: true,
        loginMode: "none",
      });
    } else {
      if (row.role !== req.role || !row.isActive) row.tokenVersion = (row.tokenVersion || 0) + 1;
      row.role = req.role;
      row.isActive = true;
    }
    await row.save({ session });
    return sideEffects;
  },
};

const storeFor = (app) => (app === ACCOUNTING ? accountingStore : departmentRoleStore);

/* ── caches ───────────────────────────────────────────────────────────── */

/**
 * Drop this process's cached answers straight away. NOT the guarantee — that
 * is the shared grant revision advanced inside the transaction, which every
 * cache checks on each hit (services/access/grantRevision.js) and which also
 * reaches other processes. A failure here is therefore logged, loudly, and
 * costs at most a revision read on the next request; it cannot leave stale
 * authority in force.
 */
function invalidateAfterCommit(app, emails) {
  const steps = [
    ["hr authorization", () => require("./hrAuthorization").invalidateHrAuthorization(`access grant ${app}`)],
    ["qc viewer", () => { for (const e of emails) require("../qcViewer").invalidateViewer(e); }],
    ["application catalogue", () => require("../memo").invalidate("access-departments:active")],
  ];
  for (const [name, run] of steps) {
    try { run(); } catch (err) {
      console.error(`[accessGrant] local ${name} cache clear failed (the grant revision still invalidates it):`, err?.message || err);
    }
  }
}

/* ── the write ─────────────────────────────────────────────────────────── */

/** The stored result of an event, in the shape a replay returns. */
function outcomeFromEvent(ev, replayed) {
  return {
    replayed,
    changed: Boolean(ev.changed),
    before: { role: ev.before?.role ?? null },
    after: { ...(ev.after || {}), sideEffects: ev.sideEffects || [] },
    auditId: String(ev._id),
  };
}

/** A replay of `key`, or a refusal if the key belongs to a different request. */
function replayOrRefuse(prior, print) {
  if (prior.fingerprint !== print) {
    refuse(409, "IDEMPOTENCY_KEY_REUSED", "That idempotency key was already used for a different access change.");
  }
  return outcomeFromEvent(prior, true);
}

/**
 * @param {object} args
 * @param {object} args.actor  who is asking — identifiers only; authority is re-read
 * @param {object} args.body   raw request body (validated here)
 * @param {object} [args.headers]
 * @param {object} [args.defaults] values a compatibility route supplies from its URL (e.g. application)
 * @param {string} [args.via]  which route called (recorded on the audit event; informational)
 */
async function changeAppAccess({ actor, body, headers = {}, defaults = {}, via = "app-access" }) {
  const ChangeLog = require("../../models/Access/ChangeLog");
  const { AccessGrantEvent, AccessGrantHead, HEAD_ID, GENESIS, computeHash } = require("../../models/Access/AccessGrantEvent");

  // AUTHORITY FIRST: somebody who may not change this application's access
  // learns nothing from the shape of their request — they get the 403.
  const application = String((defaults && defaults.application) || (body && body.application) || "").toLowerCase().trim();
  if (!application) refuse(400, "APPLICATION_REQUIRED", "Name the application.");
  let authority;
  let target;
  try {
    authority = await authorise(actor, application);
  } catch (err) {
    if (err instanceof AccessGrantError) throw err;
    console.error("[accessGrant] authority check failed:", err?.message || err);
    refuse(503, "ACCESS_GRANT_UNAVAILABLE", "Access could not be checked just now. Nothing was changed.");
  }

  const req = parseRequest({ body, headers, defaults });
  if (req.application !== application) refuse(400, "APPLICATION_MISMATCH", "The application in the request does not match the route.");

  try {
    target = await canonicalTarget(req.email);
  } catch (err) {
    if (err instanceof AccessGrantError) throw err;
    console.error("[accessGrant] pre-check failed:", err?.message || err);
    refuse(503, "ACCESS_GRANT_UNAVAILABLE", "Access could not be checked just now. Nothing was changed.");
  }

  if (!authority.isAdmin && String(actor.email || "").toLowerCase() === target.email.toLowerCase()) {
    refuse(403, "SELF_CHANGE", "You cannot change your own access. Ask another Owner or an administrator.");
  }

  const print = fingerprint(actor, req);
  const store = storeFor(req.application);
  let outcome;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // 1. Idempotency: the event's _id is the key, across every application.
      const prior = await AccessGrantEvent.findById(req.idempotencyKey).session(session).lean();
      if (prior) { outcome = replayOrRefuse(prior, print); return; }

      // 2. Advance the chain head. Every access change writes this one
      //    document, so concurrent changes serialise (a second writer hits a
      //    write conflict and is retried by withTransaction, by which time it
      //    sees the first one's event). Also advances the shared revision that
      //    authorization caches check.
      const head = await AccessGrantHead.collection.findOneAndUpdate(
        { _id: HEAD_ID },
        { $inc: { seq: 1, revision: 1 }, $setOnInsert: { lastHash: GENESIS } },
        { upsert: true, returnDocument: "after", session },
      );
      const headDoc = head && head.value !== undefined && head.ok !== undefined ? head.value : head;

      // 3. Before, rules, write.
      const before = await store.read(session, req.application, target.email);
      const nextBudget = req.budgetDepartments !== undefined ? req.budgetDepartments : before.budgetDepartments;
      const unchanged = before.role === req.role
        && JSON.stringify(before.budgetDepartments ?? null) === JSON.stringify(req.role === null ? before.budgetDepartments ?? null : nextBudget ?? null);

      if (!unchanged && before.role === "owner" && req.role !== "owner") {
        const others = await store.otherActiveOwners(session, req.application, target.email);
        if (others === 0) {
          refuse(409, "LAST_APPLICATION_OWNER", "This is the application's only active Owner. Make somebody else Owner first.");
        }
      }

      let sideEffects = [];
      if (!unchanged) sideEffects = await store.write(session, req.application, target.email, req, target, actor);

      // 4. The append-only event, chained to the previous one.
      const after = {
        role: req.role,
        ...(req.budgetDepartments !== undefined ? { budgetDepartments: req.budgetDepartments } : {}),
      };
      const event = {
        _id: req.idempotencyKey,
        seq: headDoc.seq,
        prevHash: headDoc.lastHash || GENESIS,
        application: req.application,
        actor: {
          id: String(actor.id || ""), email: String(actor.email || ""), name: String(actor.name || ""),
          subject: String(actor.subject || ""), authority: authority.isAdmin ? "platform_admin" : "application_owner",
        },
        target: { subject: target.subject, id: String(target.id), email: target.email },
        before: { role: before.role, ...(before.budgetDepartments ? { budgetDepartments: before.budgetDepartments } : {}) },
        after,
        changed: !unchanged,
        sideEffects,
        reason: req.reason,
        fingerprint: print,
        via,
        occurredAt: new Date(),
      };
      event.hash = computeHash(event);
      await AccessGrantEvent.create([event], { session });
      await AccessGrantHead.collection.updateOne({ _id: HEAD_ID }, { $set: { lastHash: event.hash } }, { session });

      // 5. The History screen's copy (display only; not the audit).
      await ChangeLog.create([{
        departmentSlug: req.application,
        section: "access:grant",
        entity: ENTITY,
        entityId: `${req.application}:${target.email}`,
        entityLabel: target.email,
        action: req.role === null ? "delete" : (before.role ? "update" : "create"),
        summary: `${target.email}: ${before.role || "no access"} → ${req.role || "no access"} in ${req.application}. ${req.reason}`,
        before: event.before,
        after: { ...after, changed: !unchanged, sideEffects, idempotencyKey: req.idempotencyKey, reason: req.reason, auditEventId: event._id },
        actorId: mongoose.isValidObjectId(actor.id) ? actor.id : undefined,
        actorName: actor.name || "",
        actorEmail: actor.email || "",
        actorRole: event.actor.authority,
        origin: "direct",
        decisionNote: req.reason,
        critical: true,
      }], { session });

      outcome = outcomeFromEvent(event, false);
    });
  } catch (err) {
    if (err instanceof AccessGrantError) throw err;
    // A concurrent request with the same key committed first and the storage
    // refused this one's event: answer as the retry it is.
    if (err?.code === 11000 && /access_grant_events/.test(String(err?.message || ""))) {
      const prior = await AccessGrantEvent.findById(req.idempotencyKey).lean().catch(() => null);
      if (prior) outcome = replayOrRefuse(prior, print);
    }
    if (!outcome) {
      console.error("[accessGrant] write failed:", err?.message || err);
      refuse(503, "ACCESS_GRANT_UNAVAILABLE", "The access change could not be saved. Nothing was changed.");
    }
  } finally {
    await session.endSession();
  }

  if (!outcome.replayed && outcome.changed) {
    invalidateAfterCommit(req.application, [target.email, ...(outcome.after.sideEffects || []).map((x) => x.email)]);
  }

  // The answer is what the canonical resolver now says — never the request.
  // Re-read the target too: a change may have bumped their session version
  // (Accounting), and the question is what the PERSON may now do. If they no
  // longer resolve (an accounting-only person just revoked), the stale actor
  // makes the resolver say so.
  const { resolveAppAccess } = require("./appAccess.service");
  const fresh = await canonicalTarget(target.email).catch(() => null);
  const effective = await resolveAppAccess((fresh || target).actor, req.application);
  return {
    replayed: outcome.replayed,
    changed: outcome.changed,
    application: req.application,
    target: { subject: target.subject, id: String(target.id), email: target.email },
    before: { role: outcome.before?.role ?? null },
    after: { role: outcome.after?.role ?? null, sideEffects: outcome.after?.sideEffects || [] },
    effective: { allowed: effective.allowed, role: effective.role, source: effective.source, denialCode: effective.denialCode },
    auditId: outcome.auditId,
  };
}

/**
 * The canonical actor behind a session that names only an email (the
 * Accounting team screen's orgAuth session carries an Acc_User id, which may
 * be role storage). Authority is still decided by resolveAppAccess inside
 * changeAppAccess; this only says WHO is asking. Refuses if the email does not
 * name exactly one active canonical identity.
 */
async function canonicalActorForEmail(email) {
  try {
    const t = await canonicalTarget(String(email || "").toLowerCase().trim());
    return { ...t.actor, name: t.name };
  } catch (err) {
    if (err instanceof AccessGrantError) refuse(403, "NOT_APPLICATION_OWNER", "Only a platform administrator or this application's Owner can change who has access to it.");
    throw err;
  }
}

/** Express helper: turn a thrown AccessGrantError into its response. */
function sendGrantError(res, err) {
  if (err instanceof AccessGrantError) {
    return res.status(err.status).json({ success: false, code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
  }
  console.error("[accessGrant] unexpected:", err);
  return res.status(503).json({ success: false, code: "ACCESS_GRANT_UNAVAILABLE", message: "The access change could not be completed. Nothing was changed." });
}

module.exports = { changeAppAccess, canonicalActorForEmail, sendGrantError, parseRequest, AccessGrantError, ROLE_KEYS, FORBIDDEN_KEYS, FORBIDDEN_HEADERS };
