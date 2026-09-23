// services/merchandising/approvalRegister.service.js
//
// THE EXECUTION FILE'S APPROVAL REGISTER.
//
// What this order is waiting to be approved, who owns each decision, and what
// their record last said. One register per file.
//
// ── THE ONE RULE THIS SERVICE EXISTS TO ENFORCE ─────────────────────────────
// Merchandising may state a REQUIREMENT for anybody. It may record a RESULT
// only for itself.
//
// So there are two ways a row's status is set, and they are not
// interchangeable:
//
//   · a Merchandising-owned row RESOLVES from Merchandising's own records —
//     the M3 and M4 revisions. Nobody types its status; it is read from the
//     approved revision, or from its absence;
//   · an externally-owned row is OBSERVED from the source application's
//     record. `observe` reads; it never writes a decision. There is no
//     argument, no body field and no code path by which a Merchandising
//     caller supplies one.
//
// That is why `upsertRequirement` refuses `observation` and every field inside
// it by name: the one way to make this register lie is to let somebody tick a
// box on somebody else's behalf, and a comment asking them not to would not be
// enough.
//
// ── AND WHY MOST ROWS SAY `AWAITING_SOURCE_RECORD` TODAY ────────────────────
// Because it is true. Sales has no buyer-decision record, Product Development
// has no released tech-pack or sample-approval record, and Quality has no test
// or inspection record that this register could read. Until those exist, the
// honest answer is that nobody can know — which is a different statement from
// "outstanding", and very different from a blank that reads as fine.
//
// M4 builds no producer for them. Inventing one here would mean Merchandising
// deciding what a buyer approval looks like, which is exactly the ownership
// this whole application is arranged to prevent.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const {
  APPROVAL_OWNER, APPROVAL_CATEGORY, OBSERVED_STATUS, ApprovalRegister,
} = require("../../models/CMS_Models/Merchandising/ApprovalRegister");
const {
  REVISION_FAMILY, REVISION_STATE,
} = require("../../models/CMS_Models/Merchandising/SelectionRevision");
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const ExecutionUnit = require("../../models/CMS_Models/Merchandising/ExecutionUnit");
const { MerchandisingAuditEvent } = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const selection = require("./selection.service");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

/** The only fields a caller may state on an approval requirement. */
const REQUIREMENT_FIELDS = Object.freeze([
  "category", "appliesToAllUnits", "unitRefs", "requiredByDate", "note", "sourceRef",
]);
const SOURCE_REF_FIELDS = Object.freeze(["app", "recordType", "recordId", "recordRef", "sourceVersion"]);

/**
 * Fields that would let a Merchandising caller record somebody else's
 * decision. Refused by name, because the refusal has to teach the rule.
 */
const REFUSED_FIELDS = Object.freeze({
  observation: "another department's decision",
  status: "another department's decision",
  observedStatus: "another department's decision",
  decidedBy: "another department's decision",
  decidedByName: "another department's decision",
  decidedAt: "another department's decision",
  approved: "another department's decision",
  approvedAt: "another department's decision",
  approvedBy: "another department's decision",
  result: "another department's decision",
  outcome: "another department's decision",
  testResult: "a test result — Quality owns it",
  inspectionResult: "an inspection result — Quality owns it",
  buyerDecision: "a buyer decision — Sales owns it",
  buyerComment: "buyer communication — Sales owns it",
  techPack: "a tech pack — Product Development owns it",
  measurements: "measurements — Product Development owns it",
  consumption: "consumption — Product Development owns it",
  /* Server-owned. */
  companyId: "a company stamp",
  fileId: "an execution file stamp",
  approvalRequirementRef: "a requirement reference",
  owningApplication: "an owning application — it follows the category",
});

/** Which Merchandising revision family answers each internal category. */
const INTERNAL_SOURCE = Object.freeze({
  MATERIAL_TRIM_CARD: REVISION_FAMILY.MATERIAL_TRIM,
  PACKAGING_SPEC: REVISION_FAMILY.PACKAGING,
  DEVELOPMENT_SCHEDULE: REVISION_FAMILY.DEVELOPMENT,
});

const mintRef = () => `APR-${crypto.randomBytes(6).toString("hex")}`;

async function withTxn(fn) {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => { out = await fn(session); });
    return out;
  } catch (err) {
    if (/Transaction numbers|replica set|transactions are not supported/i.test(str(err?.message))) {
      throw fail("MERCHANDISING_TRANSACTION_REQUIRED",
        "This deployment cannot record the change atomically. Ask an operator — the database needs a replica set.");
    }
    throw err;
  } finally {
    session.endSession();
  }
}

/** The file, proved to be this company's — foreign reads as missing. */
async function loadFile(ctx, fileId, session = null) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  if (!isId(fileId)) throw fail("NOT_FOUND", "Execution file not found.");
  const q = ExecutionFile.findOne({ _id: fileId, companyId: ctx.companyId });
  const file = session ? await q.session(session) : await q;
  if (!file) throw fail("NOT_FOUND", "Execution file not found.");
  return file;
}

/** The register, created empty on first read rather than by a command. */
async function loadRegister(file, session = null) {
  const q = ApprovalRegister.findOne({ companyId: file.companyId, fileId: file._id });
  let register = session ? await q.session(session) : await q;
  if (!register) {
    try {
      const made = await ApprovalRegister.create(
        [{ companyId: file.companyId, fileId: file._id, rows: [] }],
        session ? { session } : {},
      );
      [register] = made;
    } catch (err) {
      /* Two first reads raced; the loser reads the winner's. */
      if (err?.code !== 11000) throw err;
      const again = ApprovalRegister.findOne({ companyId: file.companyId, fileId: file._id });
      register = session ? await again.session(session) : await again;
    }
  }
  return register;
}

/* ═══ RESOLVING WHAT MERCHANDISING ITSELF HAS APPROVED ═════════════════════ */

/**
 * A Merchandising-owned row's status, read from the record that owns it.
 *
 * Never stored on the row. The approved revision IS the answer, so keeping a
 * copy here would be a second place for it to live and a first place for it to
 * go stale — a register saying "approved" beside a family whose approval was
 * superseded an hour ago.
 */
async function resolveInternal(file, category) {
  const family = selection.FAMILIES[INTERNAL_SOURCE[category]];
  if (!family) {
    return { status: OBSERVED_STATUS.AWAITING_SOURCE_RECORD, reason: "No Merchandising record answers this category." };
  }
  const [approved, working] = await Promise.all([
    family.model.findOne({
      companyId: file.companyId, fileId: file._id, state: REVISION_STATE.APPROVED,
    }).lean(),
    family.model.findOne({
      companyId: file.companyId, fileId: file._id,
      state: { $in: [REVISION_STATE.DRAFT, REVISION_STATE.SUBMITTED] },
    }).lean(),
  ]);

  if (approved) {
    return {
      status: OBSERVED_STATUS.APPROVED,
      decidedByName: str(approved.approvedBy?.name),
      decidedAt: approved.approvedAt || null,
      sourceVersion: `revision ${approved.revisionNo}`,
      reason: "",
    };
  }
  if (working) {
    return {
      status: working.state === REVISION_STATE.SUBMITTED
        ? OBSERVED_STATUS.IN_PROGRESS : OBSERVED_STATUS.NOT_STARTED,
      sourceVersion: `revision ${working.revisionNo}`,
      reason: working.state === REVISION_STATE.SUBMITTED
        ? "A revision is submitted and awaiting a decision."
        : "A revision is being drafted.",
    };
  }
  return { status: OBSERVED_STATUS.NOT_STARTED, reason: "No revision has been started." };
}

/* ═══ OBSERVING WHAT SOMEBODY ELSE HAS DECIDED ═════════════════════════════ */

/**
 * The producers this register could read, per owning application.
 *
 * Deliberately empty. Sales has no buyer-decision record, Product Development
 * has no released tech-pack or sample-approval record, and Quality has no test
 * or inspection record that carries a decision for one execution file. When one
 * of them exists, its reader goes here and every row of that class starts
 * answering — with no change to the register, the API or the screen.
 *
 * Until then `observeExternal` returns AWAITING_SOURCE_RECORD, which is true.
 */
const EXTERNAL_READERS = Object.freeze({
  [APPROVAL_OWNER.SALES]: null,
  [APPROVAL_OWNER.PRODUCT_DEVELOPMENT]: null,
  [APPROVAL_OWNER.QUALITY]: null,
});

/**
 * Read the source record for an externally-owned row.
 *
 * It READS. There is no argument by which a caller supplies a decision, and no
 * branch that writes one from a request. A reader that throws is reported as
 * UNAVAILABLE with the moment of the attempt — an unreadable source and a
 * source that says "not approved" are different facts.
 */
async function observeExternal(file, row) {
  const reader = EXTERNAL_READERS[row.owningApplication];
  if (!reader) {
    return {
      status: OBSERVED_STATUS.AWAITING_SOURCE_RECORD,
      reason: `${labelForOwner(row.owningApplication)} does not yet publish a record this register can read.`,
      observedAt: new Date(),
    };
  }
  try {
    const seen = await reader(file, row);
    return { ...seen, observedAt: new Date() };
  } catch (err) {
    return {
      status: OBSERVED_STATUS.UNAVAILABLE,
      reason: str(err?.message).slice(0, 500) || "The source could not be read.",
      observedAt: new Date(),
    };
  }
}

const OWNER_LABEL = Object.freeze({
  [APPROVAL_OWNER.MERCHANDISING]: "Merchandising",
  [APPROVAL_OWNER.SALES]: "Sales",
  [APPROVAL_OWNER.PRODUCT_DEVELOPMENT]: "Product Development",
  [APPROVAL_OWNER.QUALITY]: "Quality",
});
const labelForOwner = (owner) => OWNER_LABEL[owner] || owner;

/* ═══ VIEWS ═══════════════════════════════════════════════════════════════ */

function rowView(row, resolved) {
  const category = APPROVAL_CATEGORY[row.category] || {};
  const observation = resolved || row.observation || {};
  return {
    approvalRequirementRef: str(row.approvalRequirementRef),
    category: str(row.category),
    categoryLabel: category.label || str(row.category),
    owningApplication: str(row.owningApplication),
    owningApplicationLabel: labelForOwner(row.owningApplication),
    /* Whether this register can settle the row itself. The screen uses it to
       decide whether a decision control could ever be shown — and for an
       external row the answer is always no. */
    internallyOwned: row.owningApplication === APPROVAL_OWNER.MERCHANDISING,
    appliesToAllUnits: row.appliesToAllUnits !== false,
    unitRefs: (row.unitRefs || []).map(str),
    requiredByDate: row.requiredByDate || null,
    note: str(row.note),
    sourceRef: row.sourceRef?.recordId || row.sourceRef?.recordRef || row.sourceRef?.app
      ? {
        app: str(row.sourceRef.app),
        recordType: str(row.sourceRef.recordType),
        recordRef: str(row.sourceRef.recordRef),
        sourceVersion: str(row.sourceRef.sourceVersion),
      }
      : null,
    status: str(observation.status) || OBSERVED_STATUS.AWAITING_SOURCE_RECORD,
    decidedByName: str(observation.decidedByName),
    decidedAt: observation.decidedAt || null,
    observedAt: observation.observedAt || null,
    reason: str(observation.reason),
    observedSourceVersion: str(observation.sourceVersion),
    createdByName: str(row.createdBy?.name),
  };
}

/* ═══ READS ═══════════════════════════════════════════════════════════════ */

/**
 * The whole register, with every Merchandising-owned row resolved live.
 *
 * External rows are shown as last observed — reading them here would make a
 * page load depend on however many other applications, and a reader that hung
 * would hang the screen. `observe` is the explicit act that refreshes them.
 */
async function readRegister(ctx, { fileId } = {}) {
  const file = await loadFile(ctx, fileId);
  const register = await loadRegister(file);

  const rows = [];
  for (const row of register.rows || []) {
    const resolved = row.owningApplication === APPROVAL_OWNER.MERCHANDISING
      ? await resolveInternal(file, row.category)
      : null;
    rows.push(rowView(row, resolved));
  }

  return {
    fileId: str(file._id),
    revision: register.revision,
    rows,
    /* The vocabulary a screen needs to offer a new row without inventing one. */
    categories: Object.entries(APPROVAL_CATEGORY).map(([code, meta]) => ({
      code, label: meta.label, owningApplication: meta.owner,
      owningApplicationLabel: labelForOwner(meta.owner),
      internallyOwned: meta.owner === APPROVAL_OWNER.MERCHANDISING,
    })),
  };
}

/**
 * The one-line answer the Summary needs: how many approvals this file waits
 * on, how many are settled, and how many nobody can answer yet.
 *
 * `awaitingSource` is reported separately and never folded into "outstanding".
 * They are different problems: one needs somebody to decide, the other needs
 * somebody to build a record.
 */
async function approvalSummary(ctx, { fileId } = {}) {
  const { rows } = await readRegister(ctx, { fileId });
  const counts = {
    total: rows.length, approved: 0, rejected: 0,
    outstanding: 0, awaitingSource: 0, unavailable: 0,
  };
  for (const r of rows) {
    if (r.status === OBSERVED_STATUS.APPROVED) counts.approved += 1;
    else if (r.status === OBSERVED_STATUS.REJECTED) counts.rejected += 1;
    else if (r.status === OBSERVED_STATUS.AWAITING_SOURCE_RECORD) counts.awaitingSource += 1;
    else if (r.status === OBSERVED_STATUS.UNAVAILABLE) counts.unavailable += 1;
    else counts.outstanding += 1;
  }
  return { fileId: str(fileId), counts };
}

/** One row, and the reference behind it. */
async function readDecision(ctx, { fileId, approvalRequirementRef } = {}) {
  const file = await loadFile(ctx, fileId);
  const register = await loadRegister(file);
  const row = (register.rows || []).find(
    (r) => str(r.approvalRequirementRef) === str(approvalRequirementRef),
  );
  if (!row) throw fail("NOT_FOUND", "That approval requirement is not on this register.");
  const resolved = row.owningApplication === APPROVAL_OWNER.MERCHANDISING
    ? await resolveInternal(file, row.category) : null;
  return { fileId: str(file._id), row: rowView(row, resolved) };
}

/* ═══ WRITES — REQUIREMENTS ONLY ══════════════════════════════════════════ */

/** Refuse any field this door does not accept, by name. */
function assertRequirementShape(body) {
  for (const key of Object.keys(body || {})) {
    if (key === "expectedRevision") continue;
    const refused = REFUSED_FIELDS[key];
    if (refused) {
      throw fail("FIELD_NOT_ACCEPTED",
        `This register records what approval is REQUIRED. It cannot record ${refused}.`,
        { field: key });
    }
    if (!REQUIREMENT_FIELDS.includes(key)) {
      throw fail("FIELD_NOT_ACCEPTED", `"${key}" is not part of an approval requirement.`, { field: key });
    }
  }
  for (const key of Object.keys(body?.sourceRef || {})) {
    if (REFUSED_FIELDS[key]) {
      throw fail("FIELD_NOT_ACCEPTED",
        `A source reference names a record. It cannot carry ${REFUSED_FIELDS[key]}.`, { field: key });
    }
    if (!SOURCE_REF_FIELDS.includes(key)) {
      throw fail("FIELD_NOT_ACCEPTED", `"${key}" is not part of a source reference.`, { field: key });
    }
  }
}

async function shapeRequirement(file, body, session) {
  assertRequirementShape(body);

  const category = str(body.category).toUpperCase();
  const meta = APPROVAL_CATEGORY[category];
  if (!meta) {
    throw fail("VALIDATION",
      `Choose an approval category: ${Object.keys(APPROVAL_CATEGORY).join(", ")}.`,
      { field: "category" });
  }

  const appliesToAllUnits = body.appliesToAllUnits !== false;
  let unitRefs = [];
  if (!appliesToAllUnits) {
    unitRefs = [...new Set((Array.isArray(body.unitRefs) ? body.unitRefs : []).map(str).filter(Boolean))];
    if (!unitRefs.length) {
      throw fail("VALIDATION",
        "Say which execution units this approval applies to, or mark it as applying to all of them.",
        { field: "unitRefs" });
    }
    const units = await ExecutionUnit.find({ fileId: file._id, companyId: file.companyId })
      .select("unitDiscriminator").session(session);
    const known = new Set(units.map((u) => str(u.unitDiscriminator)));
    for (const ref of unitRefs) {
      if (!known.has(ref)) {
        throw fail("SELECTION_UNIT_UNKNOWN",
          `"${ref}" is not an execution unit of this file.`, { field: "unitRefs", value: ref });
      }
    }
  }

  let requiredByDate = null;
  if (body.requiredByDate) {
    requiredByDate = new Date(body.requiredByDate);
    if (Number.isNaN(requiredByDate.getTime())) {
      throw fail("VALIDATION", "That required-by date is not a date.", { field: "requiredByDate" });
    }
  }

  return {
    category,
    /* Taken from the category, never from the body: who owns a buyer approval
       is not a thing a caller gets to state. */
    owningApplication: meta.owner,
    appliesToAllUnits,
    unitRefs,
    requiredByDate,
    note: str(body.note).slice(0, 2000),
    sourceRef: {
      app: str(body.sourceRef?.app),
      recordType: str(body.sourceRef?.recordType),
      ...(isId(body.sourceRef?.recordId)
        ? { recordId: new mongoose.Types.ObjectId(str(body.sourceRef.recordId)) } : {}),
      recordRef: str(body.sourceRef?.recordRef),
      sourceVersion: str(body.sourceRef?.sourceVersion),
    },
  };
}

/** The optimistic-concurrency check every write on this register makes. */
function assertExpected(register, expectedRevision) {
  const expected = Number(expectedRevision);
  if (!Number.isInteger(expected)) {
    throw fail("VALIDATION", "Say which revision of the register you are changing.",
      { field: "expectedRevision" });
  }
  if (expected !== register.revision) {
    throw fail("SELECTION_REVISION_CONFLICT",
      "Somebody changed this register while you were editing. Re-read it and try again.",
      { expected, actual: register.revision });
  }
}

/** ADD an approval requirement to the register. */
async function addRequirement(ctx, { fileId, body = {}, actor = null } = {}) {
  return withTxn(async (session) => {
    const file = await loadFile(ctx, fileId, session);
    const register = await loadRegister(file, session);
    assertExpected(register, body?.expectedRevision);

    const shaped = await shapeRequirement(file, body, session);
    const row = {
      ...shaped,
      approvalRequirementRef: mintRef(),
      /* An external row starts life saying nobody can answer it yet, which is
         the truth until somebody builds the record that would. */
      observation: shaped.owningApplication === APPROVAL_OWNER.MERCHANDISING
        ? { status: OBSERVED_STATUS.NOT_STARTED }
        : {
          status: OBSERVED_STATUS.AWAITING_SOURCE_RECORD,
          reason: `${labelForOwner(shaped.owningApplication)} does not yet publish a record this register can read.`,
        },
      createdBy: actor || undefined,
      createdAt: new Date(),
    };
    register.rows.push(row);
    register.revision += 1;
    register.updatedBy = actor || undefined;
    await register.save({ session });

    await MerchandisingAuditEvent.create([audit(file, register, "APPROVAL_REQUIREMENT_CREATED", actor, {
      approvalRequirementRef: row.approvalRequirementRef,
      category: row.category,
      owningApplication: row.owningApplication,
    })], { session, ordered: true });

    return { approvalRequirementRef: row.approvalRequirementRef, revision: register.revision };
  });
}

/** EDIT an approval requirement — the requirement, never the decision. */
async function updateRequirement(ctx, { fileId, approvalRequirementRef, body = {}, actor = null } = {}) {
  return withTxn(async (session) => {
    const file = await loadFile(ctx, fileId, session);
    const register = await loadRegister(file, session);
    assertExpected(register, body?.expectedRevision);

    const index = (register.rows || []).findIndex(
      (r) => str(r.approvalRequirementRef) === str(approvalRequirementRef),
    );
    if (index < 0) throw fail("NOT_FOUND", "That approval requirement is not on this register.");

    const existing = register.rows[index];
    const shaped = await shapeRequirement(file, body, session);
    register.rows.set(index, {
      ...existing.toObject(),
      ...shaped,
      approvalRequirementRef: str(existing.approvalRequirementRef),
      /* Untouched, whatever the caller sent — and they cannot send it. */
      observation: existing.observation,
      createdBy: existing.createdBy,
      createdAt: existing.createdAt,
      updatedBy: actor || undefined,
    });
    register.revision += 1;
    register.updatedBy = actor || undefined;
    await register.save({ session });

    await MerchandisingAuditEvent.create([audit(file, register, "APPROVAL_REQUIREMENT_UPDATED", actor, {
      approvalRequirementRef: str(existing.approvalRequirementRef),
      category: shaped.category,
    })], { session, ordered: true });

    return { approvalRequirementRef: str(existing.approvalRequirementRef), revision: register.revision };
  });
}

/**
 * OBSERVE — re-read the source record behind every external row.
 *
 * This is a READ of somebody else's record and a write of what was seen. It
 * takes no status, no outcome and no actor decision from the caller; there is
 * no parameter through which one could arrive. Internal rows are skipped
 * because they resolve live and have nothing to cache.
 */
async function observe(ctx, { fileId, actor = null } = {}) {
  return withTxn(async (session) => {
    const file = await loadFile(ctx, fileId, session);
    const register = await loadRegister(file, session);

    let changed = 0;
    const audits = [];
    for (let i = 0; i < (register.rows || []).length; i += 1) {
      const row = register.rows[i];
      if (row.owningApplication === APPROVAL_OWNER.MERCHANDISING) continue;

      const seen = await observeExternal(file, row);
      const before = str(row.observation?.status);
      register.rows[i].observation = {
        status: seen.status,
        decidedByName: str(seen.decidedByName),
        decidedAt: seen.decidedAt || null,
        observedAt: seen.observedAt,
        reason: str(seen.reason).slice(0, 500),
        sourceVersion: str(seen.sourceVersion),
      };
      changed += 1;
      /* Only a CHANGE of what the source says is worth a history line; a
         reading that found the same answer is not an event. */
      if (before !== seen.status) {
        audits.push(audit(file, register, "APPROVAL_SOURCE_OBSERVED", actor, {
          approvalRequirementRef: str(row.approvalRequirementRef),
          category: str(row.category),
          owningApplication: str(row.owningApplication),
          previousStatus: before,
          observedStatus: seen.status,
        }));
      }
    }

    if (changed) {
      register.revision += 1;
      register.updatedBy = actor || undefined;
      await register.save({ session });
    }
    if (audits.length) {
      await MerchandisingAuditEvent.create(audits, { session, ordered: true });
    }
    return { fileId: str(file._id), observed: changed, revision: register.revision };
  });
}

function audit(file, register, action, actor, details) {
  return {
    companyId: file.companyId,
    recordType: "APPROVAL_REGISTER",
    recordId: register._id,
    recordRevision: register.revision,
    action,
    actor: actor || undefined,
    source: "merchandising",
    at: new Date(),
    correlationId: crypto.randomUUID(),
    details: { fileNumber: str(file.fileNumber), ...details },
  };
}

module.exports = {
  APPROVAL_OWNER, APPROVAL_CATEGORY, OBSERVED_STATUS,
  REQUIREMENT_FIELDS, REFUSED_FIELDS, INTERNAL_SOURCE, EXTERNAL_READERS,
  labelForOwner, resolveInternal, observeExternal,
  readRegister, approvalSummary, readDecision,
  addRequirement, updateRequirement, observe,
};
