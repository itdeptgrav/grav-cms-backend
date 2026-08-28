// routes/CMS_Routes/Manufacturing/QC/qcTeamRoutes.js
//
// THE QC TEAM SCREEN'S API — checkpoints, and who is standing at each of them.
//
// Mounted at /api/cms/manufacturing/qc/team, BEFORE the main qc router so the
// prefix is unambiguous.
//
// WHO MAY DO WHAT, AND WHY IT IS SPLIT
// ------------------------------------
// WRITES are owner-only, and the owner is read from `department_roles` for the
// "qc" slug on every request — the same store the CEO's Access Control screen
// writes, so there is no second place to grant this and no second answer. This
// is deliberately stricter than the rest of the CMS, where an editor may write
// and an approver may approve: the roster decides who is allowed to record a
// verdict, so anyone who can edit the roster can quietly grant themselves
// authority over any checkpoint. That is an owner's decision.
//
// READS split in two, because they have genuinely different audiences:
//   /stages, /my-stages   any signed-in QC user. The inspection station needs
//                         to know the checkpoints and which one the person at
//                         the scanner may use; refusing that would make the
//                         station unusable for everyone except the owner.
//   /members              owner only. It lists colleagues and their roles,
//                         which is roster administration, not floor work.
//
// THE OWNER IS NOT IN THEIR OWN TEAM LIST. The ask was explicit: the list is
// the people the owner assigns, and the owner is the one doing the assigning.
// Listing themselves there invites the one assignment that makes the whole
// separation pointless.

"use strict";

const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");

const { SECRET, LEGACY_SECRETS, readToken } = require("../../../../config/jwt");
const { getRole, listRoles } = require("../../../../services/departmentRoles");

const QCStage = require("../../../../models/CMS_Models/Manufacturing/QC/QCStage");
const QCStageAssignment = require("../../../../models/CMS_Models/Manufacturing/QC/QCStageAssignment");
const QCInspection = require("../../../../models/CMS_Models/Manufacturing/QC/DefectRecord");
const Employee = require("../../../../models/Employee");
const qcStages = require("../../../../services/qcStages");
const QCDefectType = require("../../../../models/CMS_Models/Manufacturing/QC/QCDefectType");
const { OTHER_CODE, STANDARD_DEFECT_TYPES } = QCDefectType;
const QCOperationDefectMap = require("../../../../models/CMS_Models/Manufacturing/QC/QCOperationDefectMap");

const SLUG = "qc";

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

/**
 * Put the caller on the request from their CMS session.
 *
 * The same shape as Middlewear/departmentWriteGuard's seedIdentity, and for the
 * same reason: this router is mounted straight onto the app with no department
 * auth middleware in front of it, so nothing has resolved `req.user` yet. The
 * legacy-secret loop is not optional — tokens issued before the secret rotated
 * are still inside their seven-day life.
 */
function qcAuth(req, res, next) {
  const token = readToken(req);
  if (!token) {
    return res.status(401).json({ success: false, message: "Please sign in." });
  }

  let decoded = null;
  try {
    decoded = jwt.verify(token, SECRET);
  } catch {
    for (const legacy of LEGACY_SECRETS) {
      try { decoded = jwt.verify(token, legacy); break; } catch { /* next */ }
    }
  }
  if (!decoded) {
    return res.status(401).json({ success: false, message: "Your session has expired. Sign in again." });
  }

  req.qcUser = {
    id: decoded.id,
    email: String(decoded.email || "").toLowerCase(),
    name: decoded.name || "",
    role: decoded.role,
    isAdmin: Boolean(decoded.isAdmin),
  };
  next();
}

/**
 * Owner of the QC department, or a platform admin.
 *
 * NOTE THE ONE DIFFERENCE FROM requireDepartmentRole: that guard fails OPEN for
 * a department with no roles assigned, so that turning RBAC on does not lock
 * out departments nobody has configured yet. This one does NOT, and must not.
 * Failing open here would mean that on any floor where QC roles have not been
 * granted, every inspector could rewrite the roster that decides whose verdicts
 * count. An unconfigured department gets a clear message instead.
 */
async function requireQCOwner(req, res, next) {
  try {
    if (req.qcUser?.isAdmin) { req.qcRole = "owner"; return next(); }

    const role = await getRole(SLUG, req.qcUser?.email);
    if (role === "owner") { req.qcRole = role; return next(); }

    return res.status(403).json({
      success: false,
      code: role ? "INSUFFICIENT_DEPARTMENT_ROLE" : "NO_DEPARTMENT_ROLE",
      role: role || null,
      message: role
        ? `Only the QC owner can manage the team. You are ${role}.`
        : "Only the QC owner can manage the team. Ask an administrator to grant QC roles.",
    });
  } catch (err) {
    console.error("[qc team] owner check failed:", err.message);
    res.status(500).json({ success: false, message: "Could not check your access." });
  }
}

router.use(qcAuth);

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const actor = (req) => ({
  email: req.qcUser?.email || "",
  name: req.qcUser?.name || "",
});

/** A stage's line position, and the code, normalised the one way. */
const normaliseCode = (code, name) => {
  const raw = String(code || name || "").trim();
  return raw.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
};

/**
 * Employee records for a set of emails, so an assignment can carry the
 * biometric id the station will actually scan.
 *
 * Employee.email is sparse-unique, and a QC role may well be granted to an
 * email with no employee record at all (a contractor, or somebody added to
 * Access Control before HR onboarded them). Those simply come back without a
 * biometric id, and the team screen says so — an assignment without one is
 * valid but unmatchable from the station, which is a thing the owner needs to
 * see rather than a thing to refuse.
 */
async function employeesByEmail(emails = []) {
  const clean = [...new Set(emails.filter(Boolean).map((e) => String(e).toLowerCase().trim()))];
  if (!clean.length) return new Map();
  const rows = await Employee.find({ email: { $in: clean } })
    .select("email firstName middleName lastName biometricId identityId department designation isActive status")
    .lean();
  return new Map(
    rows.map((e) => [
      String(e.email).toLowerCase(),
      {
        biometricId: e.biometricId || "",
        identityId: e.identityId || "",
        name: [e.firstName, e.middleName, e.lastName].filter(Boolean).join(" ").trim(),
        department: e.department || "",
        designation: e.designation || "",
        isActive: e.isActive !== false && e.status !== "inactive",
      },
    ]),
  );
}

/* ------------------------------------------------------------------ */
/* GET /members — the QC people the owner may roster                   */
/* ------------------------------------------------------------------ */

router.get("/members", requireQCOwner, async (req, res) => {
  try {
    const at = new Date();
    const roles = await listRoles(SLUG);

    // THE OWNER IS IN THIS LIST, and was not always. The original reasoning was
    // that the person who edits the roster should not appear on it — which is a
    // sound rule for an approval chain and the wrong one for a factory floor,
    // where the QC owner is a working inspector who stands at a checkpoint like
    // everybody else. Excluding them meant the one person who could fix the
    // roster was the one person who could not be on it.
    //
    // The separation that actually matters — only the owner may EDIT the roster
    // — is enforced by requireQCOwner on every write and is untouched by this.
    // Inactive grants stay excluded: a revoked role should not be rosterable.
    const members = roles.filter((r) => r.isActive);

    const [empMap, assignments] = await Promise.all([
      employeesByEmail(members.map((m) => m.email)),
      qcStages.activeAssignments({ at }),
    ]);

    const byEmail = new Map();
    for (const a of assignments) {
      const key = String(a.email).toLowerCase();
      if (!byEmail.has(key)) byEmail.set(key, []);
      byEmail.get(key).push({
        _id: a._id,
        stageId: a.stageId,
        stageCode: a.stageCode,
        stageName: a.stageName,
        validFrom: a.validFrom,
        validTo: a.validTo,
      });
    }

    res.json({
      success: true,
      members: members.map((m) => {
        const emp = empMap.get(String(m.email).toLowerCase()) || null;
        return {
          email: m.email,
          name: m.name || emp?.name || m.email,
          role: m.role,
          // So the team screen can mark them, and the assign form can say
          // "you" rather than showing the owner their own name in a list of
          // colleagues.
          isOwner: m.role === "owner",
          isYou: String(m.email).toLowerCase() === String(req.qcUser?.email || "").toLowerCase(),
          biometricId: emp?.biometricId || "",
          designation: emp?.designation || "",
          // Without this the person can be rostered but never matched to a
          // scan, because the station identifies people by ID card alone.
          hasStationIdentity: Boolean(emp?.biometricId),
          employeeActive: emp ? emp.isActive : null,
          currentStages: byEmail.get(String(m.email).toLowerCase()) || [],
        };
      }),
      total: members.length,
    });
  } catch (err) {
    console.error("[qc team members]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* GET /stages — the line, with who is on it                           */
/* ------------------------------------------------------------------ */

router.get("/stages", async (req, res) => {
  try {
    const at = new Date();
    const includeRetired = req.query.includeRetired === "true";

    const [stages, current, upcoming] = await Promise.all([
      qcStages.listStages({ includeRetired }),
      qcStages.activeAssignments({ at }),
      // Rotations the owner has already scheduled. The team screen shows them
      // beneath the current roster so a 10-minute handover is visible before it
      // happens rather than only after somebody is refused at the scanner.
      QCStageAssignment.find({ isActive: true, validFrom: { $gt: at } })
        .sort({ validFrom: 1 })
        .limit(200)
        .lean(),
    ]);

    const group = (rows) => {
      const m = new Map();
      for (const a of rows) {
        const key = String(a.stageId);
        if (!m.has(key)) m.set(key, []);
        m.get(key).push({
          _id: a._id, email: a.email, name: a.name, biometricId: a.biometricId,
          deptRole: a.deptRole, validFrom: a.validFrom, validTo: a.validTo, note: a.note || "",
        });
      }
      return m;
    };

    const now = group(current);
    const later = group(upcoming);

    res.json({
      success: true,
      stages: stages.map((s) => ({
        ...s,
        assignments: now.get(String(s._id)) || [],
        scheduled: later.get(String(s._id)) || [],
      })),
      // The station and the overview both need to know whether the rules are
      // live, and neither should have to infer it from an empty array.
      enforced: stages.length > 0,
      rosterSize: current.length,
    });
  } catch (err) {
    console.error("[qc team stages]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* GET /my-stages — what the person at this station may scan           */
/* ------------------------------------------------------------------ */

router.get("/my-stages", async (req, res) => {
  try {
    // The station's day-session identity (an ID-card scan) takes precedence
    // when it is supplied, because that is who the defect will be attributed
    // to. The CMS session email is the fallback for a person whose employee
    // record has no biometric id yet.
    const person = {
      biometricId: req.query.biometricId || "",
      email: req.query.email || req.qcUser?.email || "",
    };
    const result = await qcStages.stagesForPerson(person);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("[qc my-stages]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Stage CRUD                                                          */
/* ------------------------------------------------------------------ */

router.post("/stages", requireQCOwner, async (req, res) => {
  try {
    const { name, code, description = "", serial } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: "A checkpoint name is required." });
    }

    const finalCode = normaliseCode(code, name);
    if (!finalCode) {
      return res.status(400).json({ success: false, message: "A checkpoint code is required." });
    }

    const clash = await QCStage.findOne({ code: finalCode }).lean();
    if (clash) {
      return res.status(409).json({
        success: false,
        message: `The code ${finalCode} is already used by "${clash.name}".`,
      });
    }

    // Appended to the end of the line unless a position is given. New
    // checkpoints are almost always added after the ones that exist, and asking
    // for a number the owner has to work out first is friction for nothing.
    let position = Number(serial);
    if (!Number.isFinite(position)) {
      const last = await QCStage.findOne({ isActive: true }).sort({ serial: -1 }).select("serial").lean();
      position = (last?.serial || 0) + 1;
    }

    const a = actor(req);
    const stage = await QCStage.create({
      name: String(name).trim(),
      code: finalCode,
      description: String(description || "").trim(),
      serial: position,
      createdByEmail: a.email,
      createdByName: a.name,
      updatedByEmail: a.email,
      updatedByName: a.name,
    });

    res.status(201).json({ success: true, stage });
  } catch (err) {
    console.error("[qc stage create]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.patch("/stages/:id", requireQCOwner, async (req, res) => {
  try {
    const { name, description, serial, isActive } = req.body || {};
    const stage = await QCStage.findById(req.params.id);
    if (!stage) return res.status(404).json({ success: false, message: "Checkpoint not found." });

    const a = actor(req);
    if (name != null && String(name).trim()) stage.name = String(name).trim();
    if (description != null) stage.description = String(description).trim();
    if (serial != null && Number.isFinite(Number(serial))) stage.serial = Number(serial);
    if (isActive != null) stage.isActive = Boolean(isActive);
    stage.updatedByEmail = a.email;
    stage.updatedByName = a.name;

    // The code is deliberately NOT editable. Inspections snapshot it, and the
    // roster snapshots it; letting it change would leave two spellings of the
    // same checkpoint in the history with nothing to join them.
    await stage.save();

    // Retiring a checkpoint closes its roster. Leaving people assigned to a
    // stage that no longer runs means they show as "on duty" at a checkpoint
    // that cannot be scanned.
    if (isActive === false) {
      await QCStageAssignment.updateMany(
        { stageId: stage._id, isActive: true, $or: [{ validTo: null }, { validTo: { $gt: new Date() } }] },
        { $set: { validTo: new Date() } },
      );
    }

    res.json({ success: true, stage: stage.toObject() });
  } catch (err) {
    console.error("[qc stage update]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete("/stages/:id", requireQCOwner, async (req, res) => {
  try {
    const stage = await QCStage.findById(req.params.id);
    if (!stage) return res.status(404).json({ success: false, message: "Checkpoint not found." });

    // A checkpoint that has judged pieces is HISTORY, and history is not
    // deletable — every inspection recorded there names it, and the piece
    // progress strip would develop a hole where a real verdict used to be.
    // Retire it instead; it stops appearing on the line and keeps its past.
    const used = await QCInspection.countDocuments({ stageId: stage._id });
    if (used > 0) {
      stage.isActive = false;
      stage.updatedByEmail = actor(req).email;
      stage.updatedByName = actor(req).name;
      await stage.save();
      await QCStageAssignment.updateMany(
        { stageId: stage._id, isActive: true, $or: [{ validTo: null }, { validTo: { $gt: new Date() } }] },
        { $set: { validTo: new Date() } },
      );
      return res.json({
        success: true,
        retired: true,
        inspections: used,
        message: `"${stage.name}" has ${used} inspection${used === 1 ? "" : "s"} recorded against it, so it was retired rather than deleted.`,
      });
    }

    await QCStageAssignment.deleteMany({ stageId: stage._id });
    await stage.deleteOne();
    res.json({ success: true, deleted: true });
  } catch (err) {
    console.error("[qc stage delete]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * PUT /stages/reorder — the whole line at once.
 *
 * Takes the complete ordered list of active stage ids and rewrites the serials
 * 1..n. Sending the whole list rather than "move this one up" is what keeps the
 * serials dense and collision-free without a transaction: there is one writer
 * and one intended final state, so two owners dragging at the same time end
 * with one of the two orders rather than an interleaving of both.
 */
router.put("/stages/reorder", requireQCOwner, async (req, res) => {
  try {
    const { order } = req.body || {};
    if (!Array.isArray(order) || !order.length) {
      return res.status(400).json({ success: false, message: "An ordered list of checkpoints is required." });
    }

    const stages = await QCStage.find({ isActive: true }).select("_id").lean();
    const known = new Set(stages.map((s) => String(s._id)));
    const clean = order.map(String).filter((id) => known.has(id));

    if (clean.length !== known.size) {
      return res.status(400).json({
        success: false,
        message: "The order must list every active checkpoint exactly once. Reload and try again.",
      });
    }

    await Promise.all(
      clean.map((id, i) =>
        QCStage.updateOne({ _id: id }, { $set: { serial: i + 1, updatedByEmail: actor(req).email } }),
      ),
    );

    res.json({ success: true, stages: await qcStages.listStages() });
  } catch (err) {
    console.error("[qc stage reorder]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Assignments                                                         */
/* ------------------------------------------------------------------ */

/**
 * POST /assignments — put somebody on a checkpoint.
 *
 * `validFrom` defaults to now and `validTo` to open-ended, which is the common
 * case: "Ram is on end-line until I say otherwise". Both are accepted so the
 * owner can schedule a rotation in advance — the ask was explicitly that this
 * may change every hour, or every ten minutes, and a roster you can only edit
 * at the moment of the change is a roster nobody keeps accurate.
 *
 * REPLACES RATHER THAN STACKS. Assigning somebody who already holds this
 * checkpoint closes the open row instead of adding a second one, so the roster
 * cannot quietly accumulate duplicates that all say the same thing.
 */
router.post("/assignments", requireQCOwner, async (req, res) => {
  try {
    const { stageId, email, validFrom, validTo, note = "" } = req.body || {};
    if (!stageId || !email) {
      return res.status(400).json({ success: false, message: "A checkpoint and a person are required." });
    }

    const stage = await QCStage.findById(stageId).lean();
    if (!stage || !stage.isActive) {
      return res.status(404).json({ success: false, message: "Checkpoint not found or retired." });
    }

    const mail = String(email).toLowerCase().trim();

    // The person must actually hold a QC role. Rostering somebody with no
    // grant would let the team screen become a second, weaker way of giving
    // department access — exactly the thing Access Control exists to be the
    // only source of.
    const role = await getRole(SLUG, mail);
    if (!role) {
      return res.status(400).json({
        success: false,
        message: "That person has no QC role. Grant one from Access Control first.",
      });
    }

    const from = validFrom ? new Date(validFrom) : new Date();
    const to = validTo ? new Date(validTo) : null;
    if (Number.isNaN(from.getTime())) {
      return res.status(400).json({ success: false, message: "That start time is not a valid date." });
    }
    if (to && (Number.isNaN(to.getTime()) || to <= from)) {
      return res.status(400).json({ success: false, message: "The end time must be after the start time." });
    }

    const empMap = await employeesByEmail([mail]);
    const emp = empMap.get(mail) || null;

    // Close any open row for this person at this checkpoint, so the window is
    // continuous rather than overlapping itself.
    await QCStageAssignment.updateMany(
      {
        stageId: stage._id,
        email: mail,
        isActive: true,
        $or: [{ validTo: null }, { validTo: { $gt: from } }],
      },
      { $set: { validTo: from } },
    );

    const a = actor(req);
    const assignment = await QCStageAssignment.create({
      stageId: stage._id,
      stageCode: stage.code,
      stageName: stage.name,
      email: mail,
      name: emp?.name || "",
      biometricId: emp?.biometricId || "",
      deptRole: role,
      validFrom: from,
      validTo: to,
      note: String(note || "").trim(),
      assignedByEmail: a.email,
      assignedByName: a.name,
    });

    res.status(201).json({
      success: true,
      assignment,
      // Surfaced rather than refused — see employeesByEmail.
      warning: emp?.biometricId
        ? null
        : "This person has no biometric ID on their employee record, so their station scans cannot be matched to this checkpoint yet.",
    });
  } catch (err) {
    console.error("[qc assignment create]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/** PATCH /assignments/:id — adjust a window (usually: end it now). */
router.patch("/assignments/:id", requireQCOwner, async (req, res) => {
  try {
    const { validFrom, validTo, note, isActive } = req.body || {};
    const row = await QCStageAssignment.findById(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: "Assignment not found." });

    if (validFrom != null) {
      const d = new Date(validFrom);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ success: false, message: "That start time is not a valid date." });
      }
      row.validFrom = d;
    }
    if (validTo !== undefined) {
      if (validTo === null || validTo === "") row.validTo = null;
      else {
        const d = new Date(validTo);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({ success: false, message: "That end time is not a valid date." });
        }
        row.validTo = d;
      }
    }
    if (row.validTo && row.validTo <= row.validFrom) {
      return res.status(400).json({ success: false, message: "The end time must be after the start time." });
    }
    if (note != null) row.note = String(note).trim();
    if (isActive != null) row.isActive = Boolean(isActive);

    await row.save();
    res.json({ success: true, assignment: row.toObject() });
  } catch (err) {
    console.error("[qc assignment update]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * DELETE /assignments/:id — take somebody off a checkpoint.
 *
 * An assignment that has ALREADY BEEN IN FORCE is closed, not deleted: scans
 * taken during its window were authorised by it, and deleting it would make
 * those scans look unauthorised in hindsight. One that has not started yet —
 * a scheduled rotation the owner changed their mind about — never authorised
 * anything, so it is simply removed.
 */
router.delete("/assignments/:id", requireQCOwner, async (req, res) => {
  try {
    const row = await QCStageAssignment.findById(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: "Assignment not found." });

    const now = new Date();
    if (row.validFrom > now) {
      await row.deleteOne();
      return res.json({ success: true, deleted: true });
    }

    row.validTo = now;
    await row.save();
    res.json({ success: true, ended: true, assignment: row.toObject() });
  } catch (err) {
    console.error("[qc assignment delete]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Defect types — WHAT is wrong, as opposed to WHERE                   */
/* ------------------------------------------------------------------ */

/**
 * Make sure OTHER exists, once, before anything reads the list.
 *
 * IT IS SEEDED RATHER THAN ASSUMED because every consumer depends on it: the
 * inspection screen puts it last in the picker, the save route accepts a note
 * only for it, and the export groups it under its own heading. A deployment
 * where it is missing has an inspector standing at a scanner with a real defect
 * and nothing to record it as — which is the exact failure the whole catalogue
 * exists to prevent.
 *
 * upsert, so two simultaneous first-reads cannot create two of them.
 */
async function ensureOther() {
  await QCDefectType.updateOne(
    { code: OTHER_CODE },
    {
      $setOnInsert: {
        code: OTHER_CODE,
        name: "Other / not listed",
        category: "OTHER",
        description: "Anything the list does not cover. The inspector types what they saw.",
        sortOrder: 9999,
        isActive: true,
        isOther: true,
      },
    },
    { upsert: true },
  ).catch((e) => {
    // A duplicate-key race is the expected loser of two concurrent upserts and
    // means the row exists, which is all the caller wanted.
    if (e.code !== 11000) throw e;
  });
}

/**
 * GET /defect-types — the catalogue.
 *
 * Readable by any signed-in QC user: the inspection station needs it on every
 * lookup, and a picker only the owner can load is a station only the owner can
 * use. Writing is owner-only, below.
 */
router.get("/defect-types", async (req, res) => {
  try {
    await ensureOther();
    const includeRetired = req.query.includeRetired === "true";
    const rows = await QCDefectType.find(includeRetired ? {} : { isActive: true })
      .sort({ isOther: 1, category: 1, sortOrder: 1, code: 1 })
      .lean();

    // Grouped for the picker, which is read by category — a flat list of forty
    // codes is the thing the categories exist to avoid.
    const byCategory = [];
    const index = new Map();
    for (const r of rows) {
      const key = r.isOther ? "OTHER" : (r.category || "OTHER");
      if (!index.has(key)) {
        index.set(key, { category: key, types: [] });
        byCategory.push(index.get(key));
      }
      index.get(key).types.push(r);
    }

    res.json({ success: true, defectTypes: rows, byCategory, total: rows.length });
  } catch (err) {
    console.error("[qc defect-types]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/defect-types", requireQCOwner, async (req, res) => {
  try {
    const { code, name, category = "OTHER", description = "" } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: "A defect name is required." });
    }
    const finalCode = normaliseCode(code, name);
    if (!finalCode) {
      return res.status(400).json({ success: false, message: "A defect code is required." });
    }
    if (finalCode === OTHER_CODE) {
      return res.status(400).json({ success: false, message: `${OTHER_CODE} is reserved.` });
    }

    const clash = await QCDefectType.findOne({ code: finalCode }).lean();
    if (clash) {
      return res.status(409).json({
        success: false,
        message: `The code ${finalCode} is already used by "${clash.name}".`,
      });
    }

    const a = actor(req);
    const last = await QCDefectType.findOne({ category: String(category).trim() || "OTHER" })
      .sort({ sortOrder: -1 }).select("sortOrder").lean();

    const row = await QCDefectType.create({
      code: finalCode,
      name: String(name).trim(),
      category: String(category).trim().toUpperCase() || "OTHER",
      description: String(description || "").trim(),
      sortOrder: (last?.sortOrder || 0) + 1,
      createdByEmail: a.email,
      createdByName: a.name,
    });
    res.status(201).json({ success: true, defectType: row });
  } catch (err) {
    console.error("[qc defect-type create]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.patch("/defect-types/:id", requireQCOwner, async (req, res) => {
  try {
    const row = await QCDefectType.findById(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: "Defect type not found." });

    const { name, category, description, isActive, sortOrder } = req.body || {};
    if (row.isOther && isActive === false) {
      return res.status(400).json({
        success: false,
        message: "Other cannot be retired — it is what an inspector uses when nothing else fits.",
      });
    }
    if (name != null && String(name).trim()) row.name = String(name).trim();
    if (category != null) row.category = String(category).trim().toUpperCase() || "OTHER";
    if (description != null) row.description = String(description).trim();
    if (isActive != null) row.isActive = Boolean(isActive);
    if (sortOrder != null && Number.isFinite(Number(sortOrder))) row.sortOrder = Number(sortOrder);
    // The code is not editable: inspections snapshot it, and two spellings of
    // one defect with nothing to join them is how a report stops adding up.
    await row.save();
    res.json({ success: true, defectType: row.toObject() });
  } catch (err) {
    console.error("[qc defect-type update]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete("/defect-types/:id", requireQCOwner, async (req, res) => {
  try {
    const row = await QCDefectType.findById(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: "Defect type not found." });
    if (row.isOther) {
      return res.status(400).json({
        success: false,
        message: "Other cannot be deleted — it is what an inspector uses when nothing else fits.",
      });
    }

    // Same rule as a checkpoint: a code that has judged garments is history.
    const used = await QCInspection.countDocuments({ "defectTypes.code": row.code });
    if (used > 0) {
      row.isActive = false;
      await row.save();
      return res.json({
        success: true,
        retired: true,
        inspections: used,
        message: `"${row.name}" has been recorded on ${used} inspection${used === 1 ? "" : "s"}, so it was retired rather than deleted.`,
      });
    }
    await row.deleteOne();
    res.json({ success: true, deleted: true });
  } catch (err) {
    console.error("[qc defect-type delete]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /defect-types/import — a sheet of them at once.
 *
 * TAKES PARSED ROWS, NOT A FILE. The browser already has exceljs loaded for the
 * QUALCOM export, so it can read the .xlsx or .csv and post JSON — which keeps
 * multipart handling, a temp-file path and a second parser out of the API
 * entirely. The client owns "what does column 2 mean"; this owns "is it valid".
 *
 * UPSERTS BY CODE. Re-importing a corrected sheet is the normal way this gets
 * used, and it must update the forty rows that already exist rather than
 * failing on all of them. `mode: "replace"` additionally retires codes absent
 * from the sheet — never deletes them, because inspections reference them.
 */
router.post("/defect-types/import", requireQCOwner, async (req, res) => {
  try {
    const { rows, mode = "merge" } = req.body || {};
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ success: false, message: "No rows to import." });
    }
    if (rows.length > 2000) {
      return res.status(400).json({ success: false, message: "That is more than 2000 rows — split the sheet." });
    }

    await ensureOther();
    const a = actor(req);

    const errors = [];
    const seen = new Set();
    const ops = [];

    rows.forEach((raw, i) => {
      const line = i + 1;
      const code = normaliseCode(raw?.code, raw?.name);
      const name = String(raw?.name || "").trim();
      const category = String(raw?.category || "OTHER").trim().toUpperCase() || "OTHER";

      if (!name) { errors.push(`Row ${line}: no defect name.`); return; }
      if (!code) { errors.push(`Row ${line}: no usable code.`); return; }
      if (code === OTHER_CODE) { errors.push(`Row ${line}: ${OTHER_CODE} is reserved.`); return; }
      // A sheet with the same code twice is a mistake worth naming rather than
      // silently resolving to whichever row happened to be last.
      if (seen.has(code)) { errors.push(`Row ${line}: ${code} appears more than once in the sheet.`); return; }
      seen.add(code);

      ops.push({
        updateOne: {
          filter: { code },
          update: {
            $set: {
              name,
              category,
              description: String(raw?.description || "").trim(),
              sortOrder: Number.isFinite(Number(raw?.sortOrder)) ? Number(raw.sortOrder) : i,
              isActive: true,
            },
            $setOnInsert: { code, createdByEmail: a.email, createdByName: a.name },
          },
          upsert: true,
        },
      });
    });

    if (!ops.length) {
      return res.status(400).json({
        success: false,
        message: "No valid rows in that sheet.",
        errors: errors.slice(0, 20),
      });
    }

    const result = await QCDefectType.bulkWrite(ops, { ordered: false });

    let retired = 0;
    if (mode === "replace") {
      const r = await QCDefectType.updateMany(
        { code: { $nin: [...seen, OTHER_CODE] }, isActive: true, isOther: { $ne: true } },
        { $set: { isActive: false } },
      );
      retired = r.modifiedCount || 0;
    }

    res.json({
      success: true,
      imported: ops.length,
      created: result.upsertedCount || 0,
      updated: result.modifiedCount || 0,
      retired,
      skipped: errors.length,
      errors: errors.slice(0, 20),
    });
  } catch (err) {
    console.error("[qc defect-type import]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/** POST /defect-types/load-standard — the list the printed form already uses. */
router.post("/defect-types/load-standard", requireQCOwner, async (req, res) => {
  try {
    await ensureOther();
    const a = actor(req);
    const result = await QCDefectType.bulkWrite(
      STANDARD_DEFECT_TYPES.map((t) => ({
        updateOne: {
          filter: { code: t.code },
          update: {
            $set: { name: t.name, category: t.category, sortOrder: t.sortOrder, isActive: true },
            $setOnInsert: { code: t.code, createdByEmail: a.email, createdByName: a.name },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
    res.json({
      success: true,
      created: result.upsertedCount || 0,
      updated: result.modifiedCount || 0,
      total: STANDARD_DEFECT_TYPES.length,
    });
  } catch (err) {
    console.error("[qc defect-type load-standard]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});


/* ------------------------------------------------------------------ */
/* Preset checkpoints                                                  */
/* ------------------------------------------------------------------ */

/**
 * THE LINE EVERY GARMENT FACTORY ALREADY RUNS.
 *
 * Checkpoints began as a blank list the owner filled in, which is the flexible
 * answer and the wrong first impression: a new QC department opened to an empty
 * screen and an "Add checkpoint" button, and the owner had to invent from
 * scratch a structure that is the same in every garment factory on earth.
 *
 * These three are that structure. They are SEEDED, not hardcoded — once
 * created they are ordinary checkpoints that can be renamed, reordered,
 * retired, or joined by a fourth and fifth. The preset is a starting point, not
 * a constraint; what it removes is the blank page.
 */
const PRESET_STAGES = [
  {
    code: "INITIAL",
    name: "Initial check",
    serial: 1,
    description: "First look, early in the line — catch a fault before the piece is built on top of it.",
  },
  {
    code: "ENDLINE",
    name: "End-line check",
    serial: 2,
    description: "The garment as it comes off the sewing line, complete.",
  },
  {
    code: "FINAL",
    name: "Final check",
    serial: 3,
    description: "After finishing and pressing — the last look before the piece is packed.",
  },
];

/**
 * POST /stages/load-presets — create the three, if they are not already there.
 *
 * UPSERT BY CODE and never touch a stage that exists. Re-running this must be
 * harmless: an owner who has renamed "End-line check" to "Endline audit" and
 * clicks the button again should not find their rename undone.
 */
router.post("/stages/load-presets", requireQCOwner, async (req, res) => {
  try {
    const a = actor(req);
    const codes = PRESET_STAGES.map((p) => p.code);

    // ALL stages, retired included — `code` is globally unique, so a retired
    // preset still owns its code and an insert would be rejected by the index.
    // Retired and active are then handled differently, which is the whole
    // reason to look at both: an earlier version checked only for existence
    // and reported "already on the line" for a checkpoint that had been retired
    // and was therefore very much not on the line.
    const existing = await QCStage.find({ code: { $in: codes } })
      .select("code isActive").lean();
    const active = new Set(existing.filter((e) => e.isActive).map((e) => e.code));
    const retired = new Set(existing.filter((e) => !e.isActive).map((e) => e.code));

    const toCreate = PRESET_STAGES.filter((p) => !active.has(p.code) && !retired.has(p.code));
    const toRevive = PRESET_STAGES.filter((p) => retired.has(p.code));

    if (!toCreate.length && !toRevive.length) {
      return res.json({ success: true, created: 0, message: "The preset checkpoints are already on the line." });
    }

    // Appended after whatever is already there, so presets added to a line that
    // has been customised do not collide with its serials.
    const last = await QCStage.findOne({ isActive: true }).sort({ serial: -1 }).select("serial").lean();
    let next = (last?.serial || 0) + 1;
    const onEmptyLine = active.size === 0 && !last;

    if (toCreate.length) {
      await QCStage.insertMany(
        toCreate.map((p) => ({
          code: p.code,
          name: p.name,
          description: p.description,
          serial: onEmptyLine ? p.serial : next++,
          createdByEmail: a.email,
          createdByName: a.name,
          updatedByEmail: a.email,
          updatedByName: a.name,
        })),
      );
    }

    // Bringing a retired preset back keeps its NAME and history — the owner may
    // have renamed it before retiring it, and overwriting that would undo a
    // decision on the way to honouring a different one.
    for (const p of toRevive) {
      await QCStage.updateOne(
        { code: p.code },
        { $set: { isActive: true, serial: next++, updatedByEmail: a.email, updatedByName: a.name } },
      );
    }

    res.json({
      success: true,
      created: toCreate.length,
      revived: toRevive.length,
      stages: await qcStages.listStages(),
    });
  } catch (err) {
    console.error("[qc load-presets]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Per-operation defect suggestions                                    */
/* ------------------------------------------------------------------ */

/**
 * GET /operation-defects — the whole shortlist map.
 *
 * Small by construction (one row per operation anybody has bothered to map)
 * and read on every piece lookup, so it is returned whole rather than queried
 * per operation.
 */
router.get("/operation-defects", async (req, res) => {
  try {
    const rows = await QCOperationDefectMap.find({}).lean();
    const map = {};
    for (const r of rows) map[r.operationCode] = r.defectCodes || [];
    res.json({ success: true, map, total: rows.length });
  } catch (err) {
    console.error("[qc operation-defects]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * PUT /operation-defects/:operationCode — set one operation's shortlist.
 *
 * An empty list DELETES the row rather than storing an empty one: "no
 * suggestions for this operation" and "somebody explicitly suggested nothing"
 * are the same thing to the picker, and keeping the second would leave the map
 * accumulating rows that mean nothing.
 */
router.put("/operation-defects/:operationCode", requireQCOwner, async (req, res) => {
  try {
    const code = String(req.params.operationCode || "").trim().toUpperCase();
    if (!code) return res.status(400).json({ success: false, message: "An operation code is required." });

    const { defectCodes, operationName } = req.body || {};
    const clean = Array.isArray(defectCodes)
      ? [...new Set(defectCodes.map((c) => String(c).trim().toUpperCase()).filter(Boolean))]
      : [];

    if (!clean.length) {
      await QCOperationDefectMap.deleteOne({ operationCode: code });
      return res.json({ success: true, cleared: true });
    }

    const a = actor(req);
    const row = await QCOperationDefectMap.findOneAndUpdate(
      { operationCode: code },
      {
        $set: {
          defectCodes: clean,
          operationName: String(operationName || "").trim(),
          updatedByEmail: a.email,
          updatedByName: a.name,
        },
        $setOnInsert: { operationCode: code },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    res.json({ success: true, mapping: row });
  } catch (err) {
    console.error("[qc operation-defects set]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /operation-defects/import — a sheet of shortlists.
 *
 * Rows are `{ operationCode, operationName, defectCodes }` where defectCodes
 * may be an array or a delimited string, because that is how it comes out of a
 * spreadsheet cell somebody typed by hand.
 */
router.post("/operation-defects/import", requireQCOwner, async (req, res) => {
  try {
    const { rows } = req.body || {};
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ success: false, message: "No rows to import." });
    }
    if (rows.length > 5000) {
      return res.status(400).json({ success: false, message: "That is more than 5000 rows — split the sheet." });
    }

    const a = actor(req);
    const errors = [];
    const ops = [];

    rows.forEach((raw, i) => {
      const code = String(raw?.operationCode || "").trim().toUpperCase();
      if (!code) { errors.push(`Row ${i + 1}: no operation code.`); return; }

      const listed = Array.isArray(raw?.defectCodes)
        ? raw.defectCodes
        : String(raw?.defectCodes || "").split(/[,;|/]+/);
      const clean = [...new Set(listed.map((c) => String(c).trim().toUpperCase()).filter(Boolean))];
      if (!clean.length) { errors.push(`Row ${i + 1}: no defect codes for ${code}.`); return; }

      ops.push({
        updateOne: {
          filter: { operationCode: code },
          update: {
            $set: {
              defectCodes: clean,
              operationName: String(raw?.operationName || "").trim(),
              updatedByEmail: a.email,
              updatedByName: a.name,
            },
            $setOnInsert: { operationCode: code },
          },
          upsert: true,
        },
      });
    });

    if (!ops.length) {
      return res.status(400).json({
        success: false,
        message: "No valid rows in that sheet.",
        errors: errors.slice(0, 20),
      });
    }

    const result = await QCOperationDefectMap.bulkWrite(ops, { ordered: false });
    res.json({
      success: true,
      imported: ops.length,
      created: result.upsertedCount || 0,
      updated: result.modifiedCount || 0,
      skipped: errors.length,
      errors: errors.slice(0, 20),
    });
  } catch (err) {
    console.error("[qc operation-defects import]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
