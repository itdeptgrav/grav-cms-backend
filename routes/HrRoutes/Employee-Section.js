const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const Employee = require("../../models/Employee");
const SalaryConfig = require("../../models/Salaryconfig");
const EmployeeAuthMiddlewear = require("../../Middlewear/EmployeeAuthMiddlewear");
const emailService = require("../../services/emailService");
const { recordChange } = require("../../services/changeLog");
const {
  invalidateAppAccess,
} = require("../../Middlewear/AllEmployeeAppMiddleware");
const {
  encryptSalaryFields,
  decryptSalaryFields,
  decryptEmployeeDoc,
  decryptEmployeeDocs,
} = require("../../utils/salaryEncryption");

require("dotenv").config();

// ─── SALARY CALCULATION HELPER ───────────────────────────────────────────────
// Always operates on plain numbers. Caller must decrypt before passing in,
// and encrypt the result before saving to MongoDB.
function recalculateSalary(salary = {}, cfg = {}, employmentType = "") {
  // Decrypt in case caller passed an encrypted object (belt-and-suspenders)
  const s = decryptSalaryFields(salary);

  // ── Interns ──────────────────────────────────────────────────────────────
  // A stipend has no basic, no HRA and no statutory deductions, so none are
  // computed. This has to live here as well as in the model's pre-save hook
  // because the update below goes through findByIdAndUpdate, which does not
  // fire that hook — the two paths would otherwise disagree about what an
  // intern's salary object contains, and HR editing an intern would quietly
  // give them an EPF deduction.
  if (employmentType === "intern") {
    const stipend = Number(s.stipend) || 0;
    return {
      stipend,
      gross: 0, basic: 0, hra: 0, specialAllowance: 0,
      epf: 0, edli: 0, adminCharges: 0,
      epfOverride: false, edliOverride: false, adminOverride: false,
      eeesic: 0, erEsic: 0, foodAllowance: 0,
      employerCost: stipend,
      totalDeduction: 0,
      netSalary: stipend,
      allowances: 0, deductions: 0,
      // HR's input, not a derived figure — and it applies to interns too.
      otherDeduction: Number(s.otherDeduction) || 0,
    };
  }

  const basicPct = (cfg.basicPct ?? 50) / 100;
  const hraPct = (cfg.hraPct ?? 50) / 100;
  const eepfPct = (cfg.eepfPct ?? 12) / 100;
  const epfCapAmount = cfg.epfCapAmount ?? 1800;
  const edliPct = (cfg.edliPct ?? 0.5) / 100;
  const edliCapAmount = cfg.edliCapAmount ?? 15000;
  const adminPct = (cfg.adminChargesPct ?? 0.5) / 100;
  const esiWageLimit = cfg.esiWageLimit ?? 21000;
  const eeEsicPct = (cfg.eeEsicPct ?? 0.75) / 100;
  const erEsicPct = (cfg.erEsicPct ?? 3.25) / 100;
  const foodAllowance = cfg.foodAllowance ?? 1600;

  const gross = s.gross || 0;
  const basic = Math.round(gross * basicPct);
  const hra = Math.round(gross * hraPct);

  // EPF — respect HR override. When epfOverride is set, keep the HR-entered
  // value; otherwise ROUND(MIN(basic * 12%, epfCapAmount)) — rupee cap 1,800/mo
  const epf = s.epfOverride
    ? s.epf || 0
    : Math.round(Math.min(basic * eepfPct, epfCapAmount));

  // EDLI & Admin — respect HR override
  const edli = s.edliOverride
    ? s.edli || 0
    : Math.round(Math.min(basic * edliPct, edliCapAmount));
  const adminCharges = s.adminOverride
    ? s.adminCharges || 0
    : Math.round(basic * adminPct);

  // ESI — calculated on Basic, applies when Basic <= esiWageLimit
  const esiApplicable = basic <= esiWageLimit;
  const eeesic = esiApplicable ? Math.ceil(basic * eeEsicPct) : 0;
  const erEsic = esiApplicable ? Math.ceil(basic * erEsicPct) : 0;

  // CTC = Gross + EPF + ESIC(ER) + Food Allowance
  const employerCost = gross + epf + erEsic + foodAllowance;

  // Employee deductions = EPF + ESIC(EE)
  const totalDeduction = epf + eeesic;
  const netSalary = Math.max(gross - totalDeduction, 0);

  // Returns plain numbers — caller encrypts before saving
  return {
    gross,
    basic,
    hra,
    epf,
    edli,
    adminCharges,
    epfOverride: s.epfOverride || false,
    edliOverride: s.edliOverride || false,
    adminOverride: s.adminOverride || false,
    eeesic,
    erEsic,
    foodAllowance,
    employerCost,
    totalDeduction,
    netSalary,
    allowances: hra,
    deductions: totalDeduction,
    // Zeroed rather than omitted — the caller replaces the whole salary
    // object, so an intern promoted to staff would otherwise keep a stipend
    // sitting beside their new gross.
    stipend: 0,
    // Kept, not zeroed: HR's input, and it survives a change of type.
    otherDeduction: Number(s.otherDeduction) || 0,
  };
}

// ─── SALARY CONFIG — GET ──────────────────────────────────────────────────────
// Using /config/salary so it never collides with the /:id param routes
router.get("/config/salary", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const config = await SalaryConfig.getSingleton();
    res.json({ success: true, data: config });
  } catch (err) {
    console.error("Salary config GET error:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch salary config" });
  }
});

// ─── SALARY CONFIG — UPDATE ───────────────────────────────────────────────────
router.put("/config/salary", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;

    const allowed = [
      "basicPct",
      "hraPct",
      "eepfPct",
      "epfCapAmount",
      "foodAllowance",
      "edliPct",
      "edliCapAmount",
      "adminChargesPct",
      "esiWageLimit",
      "eeEsicPct",
      "erEsicPct",
    ];

    const updates = {};
    allowed.forEach((k) => {
      if (req.body[k] !== undefined) updates[k] = Number(req.body[k]);
    });
    updates.updatedBy = user.id;
    updates.updatedAt = new Date();

    // Read before the write. These percentages drive every payslip the company
    // issues, so "PF changed at some point" is not an answer anybody can act on
    // — the entry has to carry the old rate.
    const previousConfig = (await SalaryConfig.findOne({}).lean()) || {};

    const config = await SalaryConfig.findOneAndUpdate(
      {},
      { $set: updates },
      { new: true, upsert: true, runValidators: true },
    );

    recordChange(req, {
      departmentSlug: "hr",
      section: "hr:salary-config",
      entity: "salary-config",
      entityId: "global",
      entityLabel: "Salary configuration",
      action: "update",
      before: Object.fromEntries(allowed.map((k) => [k, previousConfig[k]])),
      after: Object.fromEntries(allowed.map((k) => [k, config[k]])),
    });

    res.json({ success: true, message: "Salary config updated", data: config });
  } catch (err) {
    console.error("Salary config PUT error:", err);
    if (err.name === "ValidationError") {
      const errors = Object.values(err.errors).map((e) => e.message);
      return res
        .status(400)
        .json({ success: false, message: "Validation error", errors });
    }
    res
      .status(500)
      .json({ success: false, message: "Failed to update salary config" });
  }
});

// ─── CREATE new employee ──────────────────────────────────────────────────────
router.post("/", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    const employeeData = req.body;

    // Sanitize fields that are ObjectId references — empty string causes a BSONError cast fail
    const OBJECTID_FIELDS = [
      "departmentId",
      "primaryManager.managerId",
      "secondaryManager.managerId",
    ];
    OBJECTID_FIELDS.forEach((path) => {
      const [top, nested] = path.split(".");
      if (nested) {
        if (employeeData[top] && employeeData[top][nested] === "") {
          delete employeeData[top][nested];
        }
      } else {
        if (employeeData[top] === "" || employeeData[top] === null) {
          delete employeeData[top];
        }
      }
    });

    // Also strip any other empty-string values that map to typed fields to avoid cast errors
    if (employeeData.primaryManager && !employeeData.primaryManager.managerId) {
      delete employeeData.primaryManager;
    }
    if (
      employeeData.secondaryManager &&
      !employeeData.secondaryManager.managerId
    ) {
      delete employeeData.secondaryManager;
    }

    // ── Inherit the department's managers ─────────────────────────────────
    // If the form didn't pick managers explicitly, a new employee reports to
    // whoever is assigned as the department's primary/secondary manager (set
    // from the Departments page). Explicit picks in the form always win.
    if (
      employeeData.departmentId &&
      (!employeeData.primaryManager || !employeeData.secondaryManager)
    ) {
      try {
        const Department = require("../../models/HR_Models/Departments");
        const dept = await Department.findById(employeeData.departmentId)
          .select("primaryManager secondaryManager")
          .lean();
        if (dept) {
          if (!employeeData.primaryManager && dept.primaryManager?.managerId) {
            employeeData.primaryManager = {
              managerId: dept.primaryManager.managerId,
              managerName: dept.primaryManager.managerName || "",
            };
          }
          if (
            !employeeData.secondaryManager &&
            dept.secondaryManager?.managerId
          ) {
            employeeData.secondaryManager = {
              managerId: dept.secondaryManager.managerId,
              managerName: dept.secondaryManager.managerName || "",
            };
          }
        }
      } catch (e) {
        console.warn("[CREATE] department manager inherit failed:", e.message);
      }
    }

    // ── Sparse unique index fields must NEVER be empty string ──────────────
    // MongoDB sparse+unique indexes skip null/undefined but index "".
    // Two employees with biometricId:"" → E11000 duplicate key on 2nd save.
    const SPARSE_UNIQUE_FIELDS = [
      "biometricId",
      "identityId",
      "email",
      "personalEmail",
    ];
    SPARSE_UNIQUE_FIELDS.forEach((f) => {
      if (employeeData[f] === "" || employeeData[f] === null)
        delete employeeData[f];
    });
    if (employeeData.documents && typeof employeeData.documents === "object") {
      ["aadharNumber", "panNumber", "uanNumber"].forEach((f) => {
        if (
          employeeData.documents[f] === "" ||
          employeeData.documents[f] === null
        ) {
          delete employeeData.documents[f];
        }
      });
    }

    // Password = employee's mobile number (fallback to "password123" if no phone)
    const temporaryPassword =
      (employeeData.phone || "").trim() || "password123";

    const newEmployee = new Employee({
      ...employeeData,
      password: temporaryPassword,
      temporaryPassword: temporaryPassword,
      createdBy: user.id,
      createdByName: user.name || "",
      createdAt: new Date(),
    });

    await newEmployee.save();
    console.log("Employee saved with ID:", newEmployee._id);

    // Audit: who created this employee. Fire-and-forget — recordChange never
    // throws and must never delay or fail the create it is recording.
    const createdName =
      `${newEmployee.firstName || ""} ${newEmployee.lastName || ""}`.trim();
    recordChange(req, {
      departmentSlug: "hr",
      section: "hr:employees",
      entity: "employee",
      entityId: newEmployee._id,
      entityLabel: createdName,
      action: "create",
      summary: `Created employee ${createdName}`,
      after: {
        name: createdName,
        department: newEmployee.department,
        designation: newEmployee.designation || newEmployee.jobTitle,
        biometricId: newEmployee.biometricId,
      },
    });

    // Send welcome email asynchronously
    if (process.env.ENABLE_EMAILS === "true" && employeeData.email) {
      try {
        const emailData = {
          name:
            [employeeData.firstName, employeeData.lastName]
              .filter(Boolean)
              .join(" ") || "Employee",
          email: employeeData.email,
          employeeId: employeeData.biometricId,
          department: employeeData.department,
          designation: employeeData.designation || employeeData.jobPosition,
          // Don't include temporaryPassword here since it's passed separately
        };

        console.log("Sending welcome email with data:", emailData);
        console.log("With password:", temporaryPassword);

        emailService
          .sendWelcomeEmail(emailData, temporaryPassword)
          .then(() => {
            console.log(
              "Welcome email sent successfully for employee:",
              newEmployee._id,
            );
            Employee.findByIdAndUpdate(newEmployee._id, {
              $set: { welcomeEmailSent: true, emailSentAt: new Date() },
              $unset: { temporaryPassword: 1, emailError: 1 },
            }).catch(console.error);
          })
          .catch((err) => {
            console.error("Welcome email failed:", err);
            Employee.findByIdAndUpdate(newEmployee._id, {
              $set: {
                welcomeEmailSent: false,
                emailError: err.message,
              },
            }).catch(console.error);
          });
      } catch (e) {
        console.error("Email error:", e);
      }
    } else {
      console.log("Emails disabled or no email provided");
    }

    const resp = newEmployee.toObject();
    delete resp.password;
    delete resp.temporaryPassword;
    delete resp.__v;

    // Decrypt salary in the response so the client gets plain numbers back
    if (resp.salary) resp.salary = decryptSalaryFields(resp.salary);

    res.status(201).json({
      success: true,
      message: "Employee created successfully",
      data: resp,
    });
  } catch (error) {
    console.error("Create employee error:", error);
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => e.message);
      return res
        .status(400)
        .json({ success: false, message: "Validation error", errors });
    }
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res
        .status(400)
        .json({ success: false, message: `${field} already exists.` });
    }
    res
      .status(500)
      .json({ success: false, message: "Error creating employee" });
  }
});

/**
 * An employee record as the history should see it.
 *
 * WHY NOT A LIST OF INTERESTING FIELDS
 * ------------------------------------
 * The first version of this diffed nine hand-picked fields (department,
 * designation, status, email, phone, gross pay, the two managers). Editing
 * anything else — an address, a date of birth, a bank account, a shift, an
 * emergency contact — produced an entry that said "Updated employee X" and
 * listed nothing, because the diff of the nine fields was empty. That is worse
 * than no entry: it records that something happened and refuses to say what.
 *
 * So this inverts it. Everything is included, and only what genuinely should
 * not be in a history is taken out:
 *
 *   secrets        password, temporary password, push/FCM tokens
 *   audit stamps   created/updated by and at — the log already knows all four,
 *                  and they change on EVERY save, so leaving them in would put
 *                  two meaningless rows on every entry
 *   engine state   sopPoints, timer accumulators, welcome-email bookkeeping —
 *                  written by background jobs, not by the person saving the form
 *   its own screen profilePhoto, which has its own route and its own entry
 *
 * SALARY is deliberately IN, and decrypted, because a hike is the single change
 * most worth being able to look up — that was the intent of the original
 * `grossPay` field too. Only the figures a human actually types are kept; EPF,
 * EDLI and admin charges are recomputed from gross on every save, so including
 * them would add half a dozen derived rows to every pay change and bury the one
 * number that was edited.
 */
const AUDIT_OMIT = new Set([
  "_id", "id", "__v",
  "password", "temporaryPassword", "pushToken", "fcmToken",
  "createdAt", "updatedAt", "createdBy", "createdByName", "updatedBy", "updatedByName",
  "profilePhoto", "sopPoints",
  "timerDeficitAccumHrs", "timerOvertimeAccumHrs", "lastFinalizedDate",
  "welcomeEmailSent", "emailSentAt", "emailError",
]);

function employeeAuditSnapshot(doc, decryptedSalary) {
  if (!doc) return undefined;
  const raw = typeof doc.toObject === "function" ? doc.toObject() : doc;

  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (AUDIT_OMIT.has(k)) continue;
    out[k] = v;
  }

  // Managers flattened to the name that is actually shown. Left as objects they
  // diff on their ObjectId, which reads as a change every time mongoose hands
  // back a hydrated document instead of a lean one.
  out.primaryManager = raw.primaryManager?.managerName || "";
  out.secondaryManager = raw.secondaryManager?.managerName || "";

  // Encrypted at rest, so the raw values are two ciphertexts that differ on
  // every save whether or not the number moved.
  const sal = decryptedSalary || {};
  out.salary = {
    gross: sal.gross,
    basic: sal.basic,
    hra: sal.hra,
    specialAllowance: sal.specialAllowance,
    stipend: sal.stipend,
  };

  return out;
}

// ─── UPDATE employee ──────────────────────────────────────────────────────────
router.put("/:id", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const updateData = req.body;

    const canUpdate = user.role === "hr_manager" || user.id === id;
    if (!canUpdate) {
      return res
        .status(403)
        .json({ success: false, message: "Permission denied" });
    }

    // Snapshot before the write, so the change log can diff old against new.
    //
    // THE WHOLE DOCUMENT, not a projection. This used to select thirteen
    // fields, which broke the diff twice over: an edit to anything outside the
    // list showed as no change at all, and once `after` became the full record
    // every field missing from `before` would have been reported as newly
    // added. employeeAuditSnapshot decides what is worth keeping — the query
    // must not decide it as well, or the two lists drift and the difference
    // between them is silently logged as edits nobody made.
    const beforeDoc = await Employee.findById(id).lean();

    // ── The biometric ID is write-once ──────────────────────────────────────
    // It is the join key across both datastores — Mongo's employee record and
    // the Firestore cowork document share it, and every attendance row, punch
    // and payroll item is keyed on it. Changing it does not rename those; it
    // orphans them, and the employee silently stops having a history.
    //
    // So: set it once, on an employee who has none, and never again. Sent
    // unchanged is fine and common — the form posts the whole record back —
    // and only an actual attempt to change one is refused, loudly, because
    // silently ignoring it would leave HR believing it had been renamed.
    //
    // identityId is deliberately NOT locked. It is a display/HR number with
    // nothing keyed on it.
    if (updateData.biometricId !== undefined && beforeDoc?.biometricId) {
      const next = String(updateData.biometricId || "").trim().toUpperCase();
      const current = String(beforeDoc.biometricId).trim().toUpperCase();
      if (next && next !== current) {
        return res.status(400).json({
          success: false,
          code: "BIOMETRIC_ID_IMMUTABLE",
          message:
            `Biometric ID cannot be changed. ${beforeDoc.biometricId} is the ` +
            `key their attendance, punches and payroll are stored under — ` +
            `renaming it here would orphan all of it, not move it.`,
        });
      }
      delete updateData.biometricId;
    }

    // Strip base64 blobs (should have been uploaded to Cloudinary before hitting this endpoint)
    if (
      updateData.profilePhoto &&
      typeof updateData.profilePhoto === "string" &&
      updateData.profilePhoto.startsWith("data:image")
    ) {
      delete updateData.profilePhoto;
    }
    if (updateData.documents) {
      [
        "aadharFile",
        "panFile",
        "resumeFile",
        "offerLetterFile",
        "appointmentLetterFile",
      ].forEach((f) => {
        if (
          updateData.documents[f] &&
          typeof updateData.documents[f] === "string" &&
          updateData.documents[f].startsWith("data:image")
        ) {
          delete updateData.documents[f];
        }
      });
      if (updateData.documents.additionalDocuments) {
        updateData.documents.additionalDocuments =
          updateData.documents.additionalDocuments.filter(
            (doc) =>
              !(
                doc.url &&
                typeof doc.url === "string" &&
                doc.url.startsWith("data:image")
              ),
          );
      }
    }

    // Restricted fields
    ["password", "temporaryPassword", "createdBy", "createdAt"].forEach(
      (f) => delete updateData[f],
    );

    // Stamp who last edited (findByIdAndUpdate treats these as $set).
    updateData.updatedBy = user.id;
    updateData.updatedByName = user.name || "";
    updateData.updatedAt = new Date();

    // Sanitize empty-string ObjectId fields to prevent BSONError cast failures
    if (updateData.departmentId === "" || updateData.departmentId === null) {
      delete updateData.departmentId;
    }
    if (updateData.primaryManager && !updateData.primaryManager.managerId) {
      delete updateData.primaryManager;
    }
    if (updateData.secondaryManager && !updateData.secondaryManager.managerId) {
      delete updateData.secondaryManager;
    }

    // Recalculate all salary fields from gross using current config rates,
    // then encrypt the result before it goes into MongoDB
    if (updateData.salary) {
      const cfg = await SalaryConfig.getSingleton();
      // The type being saved, or the one already on file when this edit does
      // not touch it — a partial update must not turn an intern back into a
      // salaried employee by omission.
      const effectiveType =
        updateData.employmentType ?? beforeDoc?.employmentType ?? "";
      const calculated = recalculateSalary(
        updateData.salary,
        cfg.toObject(),
        effectiveType,
      );
      updateData.salary = encryptSalaryFields(calculated);
      // Boolean override flags are not encrypted
      updateData.salary.epfOverride = calculated.epfOverride;
      updateData.salary.edliOverride = calculated.edliOverride;
      updateData.salary.adminOverride = calculated.adminOverride;
    }

    const updated = await Employee.findByIdAndUpdate(id, updateData, {
      new: true,
      runValidators: false,
    }).select("-password -temporaryPassword -__v");

    if (!updated)
      return res
        .status(404)
        .json({ success: false, message: "Employee not found" });

    // App access is cached for five minutes per employee. Moving somebody to
    // or from intern changes whether they may use the app at all, so the
    // stale answer is dropped here instead of being served for another five.
    if (
      updateData.employmentType !== undefined &&
      updateData.employmentType !== beforeDoc?.employmentType
    ) {
      invalidateAppAccess(id);
    }

    // Decrypt salary before sending to client
    const decryptedDoc = decryptEmployeeDoc(updated);

    // Audit: the whole record, before and after. No hand-written summary —
    // services/changeLog writes one from the diff, so the sentence can never
    // disagree with the fields underneath it. An edit that moved nothing this
    // snapshot can see is now suppressed entirely rather than filed as a
    // contentless "Updated employee X".
    const updatedName =
      `${updated.firstName || ""} ${updated.lastName || ""}`.trim();
    recordChange(req, {
      departmentSlug: "hr",
      section: "hr:employees",
      entity: "employee",
      entityId: id,
      entityLabel: updatedName,
      action: "update",
      before: employeeAuditSnapshot(
        beforeDoc,
        beforeDoc?.salary ? decryptSalaryFields(beforeDoc.salary) : {},
      ),
      after: employeeAuditSnapshot(updated, decryptedDoc?.salary || {}),
    });
    res.status(200).json({
      success: true,
      message: "Employee updated successfully",
      data: decryptedDoc,
    });
  } catch (error) {
    console.error("Update employee error:", error);
    if (error.code === 11000)
      return res
        .status(400)
        .json({ success: false, message: "Duplicate value error" });
    if (error.name === "CastError")
      return res
        .status(400)
        .json({ success: false, message: "Invalid employee ID" });
    res
      .status(500)
      .json({ success: false, message: "Error updating employee" });
  }
});

// ─── UPDATE DOCUMENTS ONLY ────────────────────────────────────────────────────
router.patch("/:id/documents", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const { documents } = req.body;

    if (user.role !== "hr_manager" && user.id !== id) {
      return res
        .status(403)
        .json({ success: false, message: "Permission denied" });
    }

    const clean = { ...documents };
    ["aadharFile", "panFile", "resumeFile"].forEach((f) => {
      if (
        clean[f] &&
        typeof clean[f] === "string" &&
        clean[f].startsWith("data:image")
      )
        delete clean[f];
    });
    if (clean.additionalDocuments) {
      clean.additionalDocuments = clean.additionalDocuments.filter(
        (d) =>
          !(
            d.url &&
            typeof d.url === "string" &&
            d.url.startsWith("data:image")
          ),
      );
    }

    const previous = await Employee.findById(id).select("documents").lean();

    const updated = await Employee.findByIdAndUpdate(
      id,
      { $set: { documents: clean } },
      { new: true, runValidators: false },
    ).select("documents firstName lastName biometricId");

    if (!updated)
      return res
        .status(404)
        .json({ success: false, message: "Employee not found" });

    // Filed under Employee documents, not Employees: it is the documents page
    // somebody will be looking at when they ask when an Aadhaar was replaced.
    recordChange(req, {
      departmentSlug: "hr",
      section: "hr:documents",
      entity: "employee-document",
      entityId: String(id),
      entityLabel: `${[updated.firstName, updated.lastName].filter(Boolean).join(" ")}${updated.biometricId ? ` (${updated.biometricId})` : ""}`,
      action: "update",
      before: previous?.documents || {},
      after: updated.documents || {},
    });

    res.status(200).json({
      success: true,
      message: "Documents updated successfully",
      data: updated.documents,
    });
  } catch (error) {
    console.error("Update documents error:", error);
    res
      .status(500)
      .json({ success: false, message: "Error updating documents" });
  }
});

// ─── UPDATE PROFILE PHOTO ONLY ────────────────────────────────────────────────
router.patch("/:id/profile-photo", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const { profilePhoto } = req.body;

    if (user.role !== "hr_manager" && user.id !== id) {
      return res
        .status(403)
        .json({ success: false, message: "Permission denied" });
    }

    if (!profilePhoto?.url || !profilePhoto?.publicId) {
      return res.status(400).json({
        success: false,
        message: "Valid profilePhoto with url and publicId required",
      });
    }

    if (
      typeof profilePhoto.url === "string" &&
      profilePhoto.url.startsWith("data:image")
    ) {
      return res
        .status(400)
        .json({ success: false, message: "Upload to Cloudinary first" });
    }

    const updated = await Employee.findByIdAndUpdate(
      id,
      { $set: { profilePhoto } },
      { new: true, runValidators: false },
    ).select("profilePhoto firstName lastName biometricId");

    if (!updated)
      return res
        .status(404)
        .json({ success: false, message: "Employee not found" });

    recordChange(req, {
      departmentSlug: "hr",
      section: "hr:employees",
      entity: "employee",
      entityId: String(id),
      entityLabel: `${[updated.firstName, updated.lastName].filter(Boolean).join(" ")}${updated.biometricId ? ` (${updated.biometricId})` : ""}`,
      action: "update",
      summary:
        `Replaced the profile photo` +
        `${user.id === id ? " (their own)" : ""}.`,
      after: { "profilePhoto.publicId": profilePhoto.publicId },
    });

    res.status(200).json({
      success: true,
      message: "Profile photo updated successfully",
      data: updated.profilePhoto,
    });
  } catch (error) {
    console.error("Update profile photo error:", error);
    res
      .status(500)
      .json({ success: false, message: "Error updating profile photo" });
  }
});

// ─── GET ALL employees (paginated, filterable) ─────────────────────────────────
router.get("/all", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      department,
      status,
      search,
      sort,
      employmentType,
    } = req.query;

    // Optional sort — the list defaults to newest-first; "dob"/"dob_desc"
    // order by date of birth (missing DOBs sink to the end via the fallback).
    const SORTS = {
      dob: { dateOfBirth: 1, createdAt: -1 },
      dob_desc: { dateOfBirth: -1, createdAt: -1 },
      name: { firstName: 1, lastName: 1 },
      doj: { dateOfJoining: 1, createdAt: -1 },
      doj_desc: { dateOfJoining: -1, createdAt: -1 },
    };
    const sortSpec = SORTS[sort] || { createdAt: -1 };

    let filter = {};

    // FIX: Case-insensitive department match — employee records may store "PRODUCTION"
    // while the departments API returns "Production". Regex handles any casing.
    if (department && department !== "all")
      filter.department = {
        $regex: new RegExp(
          `^${department.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
          "i",
        ),
      };

    if (status && status !== "all") filter.status = status;

    // "interns" and "staff" rather than a bare employmentType match, because
    // the useful question on this page is which side of that line somebody
    // falls — and "staff" has to include the employees who predate the field
    // and have it empty, which $ne does and an enum match would not.
    if (employmentType === "interns") filter.employmentType = "intern";
    else if (employmentType === "staff")
      filter.employmentType = { $ne: "intern" };
    else if (employmentType && employmentType !== "all")
      filter.employmentType = employmentType;
    if (search) {
      filter.$or = [
        { firstName: { $regex: search, $options: "i" } },
        { lastName: { $regex: search, $options: "i" } },
        { middleName: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { biometricId: { $regex: search, $options: "i" } },
        { identityId: { $regex: search, $options: "i" } },
        { jobTitle: { $regex: search, $options: "i" } },
        { designation: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [employees, total, deptStats] = await Promise.all([
      Employee.find(filter)
        .sort(sortSpec)
        .skip(skip)
        .limit(parseInt(limit))
        .select("-password -temporaryPassword -__v")
        .lean(),
      Employee.countDocuments(filter),
      // FIX: deptStats must respect the active/inactive tab — add $match on status only
      // (intentionally excludes department + search so the strip always shows all depts)
      Employee.aggregate([
        ...(status && status !== "all" ? [{ $match: { status } }] : []),
        { $group: { _id: "$department", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
    ]);

    const totalPages = Math.ceil(total / parseInt(limit));

    // Decrypt salary fields in each employee doc before sending to client.
    // List views only show minimal salary info (gross/net) so this is fast.
    const decryptedEmployees = decryptEmployeeDocs(employees);

    res.status(200).json({
      success: true,
      data: {
        employees: decryptedEmployees,
        pagination: {
          currentPage: parseInt(page),
          totalPages,
          totalEmployees: total,
          hasNextPage: parseInt(page) < totalPages,
          hasPrevPage: parseInt(page) > 1,
        },
        stats: { total, departmentStats: deptStats },
      },
    });
  } catch (error) {
    console.error("Get employees error:", error);
    res
      .status(500)
      .json({ success: false, message: "Error fetching employees" });
  }
});

// ─── BULK UPDATE ──────────────────────────────────────────────────────────────
// PATCH /api/employees/bulk-update  { employeeIds: [...], updates: {...} }
//
// Applies the same partial update to every selected employee. Declared ABOVE
// the /:id routes so it is never shadowed by them. HR only.
//
// Updates are flattened to dot-paths and applied via doc.set() + doc.save() —
// NOT updateMany — because the Employee pre-save hook is what recalculates and
// re-encrypts salary; a bare $set would store plaintext salary numbers.
router.patch("/bulk-update", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    if (user.role !== "hr_manager") {
      return res
        .status(403)
        .json({ success: false, message: "Permission denied" });
    }
    const { employeeIds, updates } = req.body || {};
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "employeeIds required" });
    }
    if (employeeIds.length > 200) {
      return res
        .status(400)
        .json({ success: false, message: "Max 200 employees per bulk update" });
    }
    if (!updates || typeof updates !== "object" || !Object.keys(updates).length) {
      return res
        .status(400)
        .json({ success: false, message: "No updates provided" });
    }

    // Fields that must never be bulk-written: credentials/system stamps, and
    // every unique-per-person identifier — writing one value onto many
    // employees would either corrupt identity data or blow up on the unique
    // indexes (biometricId, identityId, email…).
    const clean = JSON.parse(JSON.stringify(updates));
    [
      "password",
      "temporaryPassword",
      "createdBy",
      "createdAt",
      "_id",
      "__v",
      "biometricId",
      "identityId",
      "email",
      "personalEmail",
      "phone",
      "firstName",
      "middleName",
      "lastName",
      "profilePhoto",
    ].forEach((f) => delete clean[f]);
    if (clean.documents) {
      ["aadharNumber", "panNumber", "uanNumber", "passportNumber",
       "voterIdNumber", "drivingLicenseNumber", "esicNumber", "pfNumber",
       "aadharFile", "panFile", "resumeFile", "offerLetterFile",
       "appointmentLetterFile", "additionalDocuments",
      ].forEach((f) => delete clean.documents[f]);
      if (!Object.keys(clean.documents).length) delete clean.documents;
    }
    if (clean.departmentId === "" || clean.departmentId === null)
      delete clean.departmentId;
    if (clean.primaryManager && !clean.primaryManager.managerId)
      delete clean.primaryManager;
    if (clean.secondaryManager && !clean.secondaryManager.managerId)
      delete clean.secondaryManager;
    if (!Object.keys(clean).length) {
      return res.status(400).json({
        success: false,
        message: "None of the provided fields can be bulk-updated",
      });
    }

    // Nested objects → dot paths, so a partial {salary:{gross}} or
    // {address:{current:{city}}} merges instead of replacing the sub-document.
    const flatten = (obj, prefix = "", out = {}) => {
      for (const [k, v] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${k}` : k;
        if (
          v &&
          typeof v === "object" &&
          !Array.isArray(v) &&
          !(v instanceof Date)
        )
          flatten(v, path, out);
        else out[path] = v;
      }
      return out;
    };
    const paths = flatten(clean);

    const results = { updated: 0, failed: [] };
    for (const empId of employeeIds) {
      try {
        const doc = await Employee.findById(empId).select(
          "-password -temporaryPassword",
        );
        if (!doc) {
          results.failed.push({ id: empId, reason: "Not found" });
          continue;
        }
        const beforeGrossBulk = doc.salary
          ? decryptSalaryFields(doc.salary)?.gross
          : undefined;
        const beforeSnap = {
          department: doc.department,
          designation: doc.designation,
          jobTitle: doc.jobTitle,
          status: doc.status,
          grossPay: beforeGrossBulk,
          primaryManager: doc.primaryManager?.managerName || "",
          secondaryManager: doc.secondaryManager?.managerName || "",
        };

        const beforeType = doc.employmentType;
        for (const [path, value] of Object.entries(paths)) doc.set(path, value);
        doc.set("updatedBy", user.id);
        doc.set("updatedByName", user.name || "");
        // pre-save hook recalculates + re-encrypts salary and stamps updatedAt
        await doc.save();
        // Same reason as the single-employee update: a change of employment
        // type changes whether the app will let them in, and the answer is
        // cached for five minutes.
        if (doc.employmentType !== beforeType) invalidateAppAccess(doc._id);

        const name = `${doc.firstName || ""} ${doc.lastName || ""}`.trim();
        recordChange(req, {
          departmentSlug: "hr",
          section: "hr:employees",
          entity: "employee",
          entityId: doc._id,
          entityLabel: name,
          action: "update",
          summary: `Bulk update (${employeeIds.length} employees)`,
          before: beforeSnap,
          after: {
            department: doc.department,
            designation: doc.designation,
            jobTitle: doc.jobTitle,
            status: doc.status,
            grossPay: doc.salary
              ? decryptSalaryFields(doc.salary)?.gross
              : undefined,
            primaryManager: doc.primaryManager?.managerName || "",
            secondaryManager: doc.secondaryManager?.managerName || "",
          },
        });
        results.updated++;
      } catch (e) {
        results.failed.push({ id: empId, reason: e.message });
      }
    }

    res.status(200).json({
      success: true,
      message: `Updated ${results.updated} of ${employeeIds.length} employees`,
      data: results,
    });
  } catch (error) {
    console.error("Bulk update error:", error);
    res.status(500).json({ success: false, message: "Error in bulk update" });
  }
});

// ─── EMPLOYEE CHANGE HISTORY ──────────────────────────────────────────────────
// GET /api/employees/history?employeeId=&limit=   (HR only)
// Reads the shared change_logs collection. Declared above /:id so it is never
// shadowed by the param route.
router.get("/history", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    if (req.user.role !== "hr_manager") {
      return res
        .status(403)
        .json({ success: false, message: "Permission denied" });
    }
    const { employeeId, limit = 100 } = req.query;
    const ChangeLog = require("../../models/Access/ChangeLog");
    const q = { departmentSlug: "hr", entity: "employee" };
    if (employeeId) q.entityId = String(employeeId);
    const entries = await ChangeLog.find(q)
      .sort({ createdAt: -1 })
      .limit(Math.min(parseInt(limit) || 100, 300))
      .lean();
    res.status(200).json({ success: true, data: entries });
  } catch (error) {
    console.error("Employee history error:", error);
    res.status(500).json({ success: false, message: "Error fetching history" });
  }
});

// ─── GET single employee ──────────────────────────────────────────────────────
router.get("/:id", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const employee = await Employee.findById(req.params.id)
      .select("-password -temporaryPassword -__v")
      .lean();
    if (!employee)
      return res
        .status(404)
        .json({ success: false, message: "Employee not found" });
    // Decrypt salary fields before sending to client
    const decrypted = decryptEmployeeDoc(employee);
    res.status(200).json({ success: true, data: decrypted });
  } catch (error) {
    console.error("Get employee error:", error);
    if (error.name === "CastError")
      return res
        .status(400)
        .json({ success: false, message: "Invalid employee ID" });
    res
      .status(500)
      .json({ success: false, message: "Error fetching employee" });
  }
});

// ─── GET employee DETAILS (full formatted) ────────────────────────────────────
router.get("/:id/details", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { id } = req.params;

    const employee = await Employee.findById(id)
      .select("-password -temporaryPassword -__v")
      .populate("departmentId", "name designations managers")
      .populate(
        "primaryManager.managerId",
        "firstName lastName biometricId department jobTitle",
      )
      .populate(
        "secondaryManager.managerId",
        "firstName lastName biometricId department jobTitle",
      )
      .populate("createdBy", "name email")
      .lean();

    if (!employee)
      return res
        .status(404)
        .json({ success: false, message: "Employee not found" });

    // Decrypt salary before building the response object
    const sal = decryptSalaryFields(employee.salary || {});

    const [teamMembers, managerHierarchy, recentActivities] = await Promise.all(
      [
        Employee.find({
          $or: [
            { "primaryManager.managerId": id },
            { "secondaryManager.managerId": id },
          ],
        })
          .select("firstName lastName biometricId department jobTitle status")
          .limit(10)
          .lean(),
        getManagerHierarchy(id),
        getRecentActivities(id),
      ],
    );

    const fullName = [
      employee.firstName,
      employee.middleName,
      employee.lastName,
    ]
      .filter(Boolean)
      .join(" ")
      .trim();

    const formatted = {
      basicInfo: {
        id: employee._id,
        biometricId: employee.biometricId,
        identityId: employee.identityId,
        title: employee.title || "",
        firstName: employee.firstName,
        middleName: employee.middleName || "",
        lastName: employee.lastName,
        fullName,
        nickName: employee.nickName || "",
        email: employee.email,
        personalEmail: employee.personalEmail || "",
        phone: employee.phone,
        alternatePhone: employee.alternatePhone || "Not Provided",
        extension: employee.extension || "",
        dateOfBirth: employee.dateOfBirth
          ? new Date(employee.dateOfBirth).toLocaleDateString("en-IN")
          : "Not Provided",
        age: employee.dateOfBirth ? calculateAge(employee.dateOfBirth) : null,
        gender: employee.gender ? capitalize(employee.gender) : "Not Provided",
        bloodGroup: employee.bloodGroup || "Not Provided",
        maritalStatus: employee.maritalStatus
          ? capitalize(employee.maritalStatus)
          : "Not Provided",
        marriageDate: employee.marriageDate
          ? new Date(employee.marriageDate).toLocaleDateString("en-IN")
          : null,
        spouseName: employee.spouseName || null,
        spouseDOB: employee.spouseDOB
          ? new Date(employee.spouseDOB).toLocaleDateString("en-IN")
          : null,
        nationality: employee.nationality || "Not Provided",
        religion: employee.religion || "Not Provided",
        placeOfBirth: employee.placeOfBirth || "Not Provided",
        countryOfOrigin: employee.countryOfOrigin || "Not Provided",
        residentialStatus: employee.residentialStatus || "Not Provided",
        fatherName:
          [
            employee.fatherFirstName,
            employee.fatherMiddleName,
            employee.fatherLastName,
          ]
            .filter(Boolean)
            .join(" ") || "Not Provided",
        fatherDateOfBirth: employee.fatherDateOfBirth
          ? new Date(employee.fatherDateOfBirth).toLocaleDateString("en-IN")
          : null,
        motherName:
          [
            employee.motherFirstName,
            employee.motherMiddleName,
            employee.motherLastName,
          ]
            .filter(Boolean)
            .join(" ") || "Not Provided",
        isDirector: employee.isDirector ? "Yes" : "No",
        isInternational: employee.isInternational ? "Yes" : "No",
        isPhysicallyChallenged: employee.isPhysicallyChallenged ? "Yes" : "No",
        profilePhoto: employee.profilePhoto,
        customFields: employee.personalCustomFields || [],
      },
      workInfo: {
        department: employee.department,
        departmentId: employee.departmentId,
        designation: employee.designation || employee.jobPosition,
        jobTitle: employee.jobTitle,
        biometricId: employee.biometricId,
        identityId: employee.identityId,
        needsToOperate: employee.needsToOperate || false,
        dateOfJoining: employee.dateOfJoining
          ? new Date(employee.dateOfJoining).toLocaleDateString("en-IN")
          : "Not Provided",
        confirmationDate: employee.confirmationDate
          ? new Date(employee.confirmationDate).toLocaleDateString("en-IN")
          : null,
        probationPeriod: employee.probationPeriod
          ? `${employee.probationPeriod} months`
          : null,
        tenure: employee.dateOfJoining
          ? calculateTenure(employee.dateOfJoining)
          : null,
        employmentType: formatEmploymentType(employee.employmentType),
        workLocation: employee.workLocation || "GRAV Clothing",
        shift: employee.shift || "Not Assigned",
        status: employee.status ? capitalize(employee.status) : "Active",
        isActive: employee.isActive ? "Yes" : "No",
        customFields: employee.workCustomFields || [],
      },
      managers: {
        primary: employee.primaryManager
          ? {
              managerId: employee.primaryManager.managerId?._id,
              name:
                employee.primaryManager.managerName ||
                [
                  employee.primaryManager.managerId?.firstName,
                  employee.primaryManager.managerId?.lastName,
                ]
                  .filter(Boolean)
                  .join(" "),
              employeeId: employee.primaryManager.managerId?.biometricId,
              department: employee.primaryManager.managerId?.department,
              jobTitle: employee.primaryManager.managerId?.jobTitle,
            }
          : null,
        secondary: employee.secondaryManager
          ? {
              managerId: employee.secondaryManager.managerId?._id,
              name:
                employee.secondaryManager.managerName ||
                [
                  employee.secondaryManager.managerId?.firstName,
                  employee.secondaryManager.managerId?.lastName,
                ]
                  .filter(Boolean)
                  .join(" "),
              employeeId: employee.secondaryManager.managerId?.biometricId,
              department: employee.secondaryManager.managerId?.department,
              jobTitle: employee.secondaryManager.managerId?.jobTitle,
            }
          : null,
      },
      salaryInfo: {
        gross: sal.gross
          ? `₹${sal.gross.toLocaleString("en-IN")}`
          : "Not Provided",
        basic: sal.basic ? `₹${sal.basic.toLocaleString("en-IN")}` : null,
        netSalary: sal.netSalary
          ? `₹${sal.netSalary.toLocaleString("en-IN")}`
          : null,
        customFields: employee.salaryCustomFields || [],
      },
      bankDetails: {
        bankName: employee.bankDetails?.bankName || "Not Provided",
        accountNumber: employee.bankDetails?.accountNumber
          ? `XXXX${employee.bankDetails.accountNumber.slice(-4)}`
          : "Not Provided",
        ifscCode: employee.bankDetails?.ifscCode || "Not Provided",
        accountType: employee.bankDetails?.accountType
          ? capitalize(employee.bankDetails.accountType)
          : "Not Provided",
        branchName: employee.bankDetails?.branchName || "Not Provided",
      },
      documents: {
        aadharNumber: employee.documents?.aadharNumber
          ? maskId(employee.documents.aadharNumber)
          : "Not Provided",
        panNumber: employee.documents?.panNumber || "Not Provided",
        uanNumber: employee.documents?.uanNumber || "Not Provided",
        passportNumber: employee.documents?.passportNumber || "Not Provided",
        voterIdNumber: employee.documents?.voterIdNumber || "Not Provided",
        drivingLicenseNumber:
          employee.documents?.drivingLicenseNumber || "Not Provided",
        esicNumber: employee.documents?.esicNumber || "Not Provided",
        pfNumber: employee.documents?.pfNumber || "Not Provided",
        aadharFile: employee.documents?.aadharFile,
        panFile: employee.documents?.panFile,
        resumeFile: employee.documents?.resumeFile,
        offerLetterFile: employee.documents?.offerLetterFile,
        appointmentLetterFile: employee.documents?.appointmentLetterFile,
        additionalDocuments: employee.documents?.additionalDocuments || [],
        customFields: employee.documentCustomFields || [],
      },
      address: {
        current: {
          street: employee.address?.current?.street || "Not Provided",
          city: employee.address?.current?.city || "Not Provided",
          state: employee.address?.current?.state || "Not Provided",
          pincode: employee.address?.current?.pincode || "Not Provided",
          country: employee.address?.current?.country || "India",
          ownershipType:
            employee.address?.current?.ownershipType || "Not Provided",
        },
        permanent: {
          street: employee.address?.permanent?.street || "Same as Current",
          city: employee.address?.permanent?.city || "Same as Current",
          state: employee.address?.permanent?.state || "Same as Current",
          pincode: employee.address?.permanent?.pincode || "Same as Current",
          country: employee.address?.permanent?.country || "India",
          ownershipType:
            employee.address?.permanent?.ownershipType || "Not Provided",
        },
        customFields: employee.addressCustomFields || [],
      },
      systemInfo: {
        createdBy: employee.createdBy?.name || "HR System",
        createdAt: employee.createdAt
          ? new Date(employee.createdAt).toLocaleDateString("en-IN")
          : "N/A",
        updatedAt: employee.updatedAt
          ? new Date(employee.updatedAt).toLocaleDateString("en-IN")
          : "N/A",
      },
      relatedData: {
        teamMembers: teamMembers.map((m) => ({
          id: m._id,
          name: [m.firstName, m.lastName].filter(Boolean).join(" "),
          employeeId: m.biometricId,
          department: m.department,
          jobTitle: m.jobTitle,
          status: m.status,
        })),
        managerHierarchy,
        recentActivities,
      },
    };

    res.status(200).json({ success: true, data: formatted });
  } catch (error) {
    console.error("Get employee details error:", error);
    if (error.name === "CastError")
      return res
        .status(400)
        .json({ success: false, message: "Invalid employee ID" });
    res
      .status(500)
      .json({ success: false, message: "Error fetching employee details" });
  }
});

// ─── GET employees by dept + designation (manager picker) ─────────────────────
router.get(
  "/department/employees",
  EmployeeAuthMiddlewear,
  async (req, res) => {
    try {
      const { departmentId, designation } = req.query;
      if (!departmentId || !designation) {
        return res.status(400).json({
          success: false,
          message: "departmentId and designation required",
        });
      }

      const employees = await Employee.find({
        departmentId,
        designation,
        status: "active",
        isActive: true,
      })
        .select(
          "firstName middleName lastName biometricId identityId email phone department designation jobTitle profilePhoto",
        )
        .sort({ firstName: 1 })
        .lean();

      const formatted = employees.map((emp) => ({
        id: emp._id,
        employeeId: emp.biometricId || emp.identityId,
        biometricId: emp.biometricId,
        name: [emp.firstName, emp.lastName].filter(Boolean).join(" ").trim(),
        fullName: [emp.firstName, emp.middleName, emp.lastName]
          .filter(Boolean)
          .join(" ")
          .trim(),
        email: emp.email,
        phone: emp.phone,
        department: emp.department,
        designation: emp.designation,
        jobTitle: emp.jobTitle,
        profilePhoto: emp.profilePhoto,
      }));

      res
        .status(200)
        .json({ success: true, data: formatted, count: formatted.length });
    } catch (error) {
      console.error("Get dept employees error:", error);
      res
        .status(500)
        .json({ success: false, message: "Error fetching employees" });
    }
  },
);

// ─── SOFT DELETE ──────────────────────────────────────────────────────────────
// ─── SOFT DELETE ──────────────────────────────────────────────────────────────
router.delete("/:id", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    if (user.role !== "hr_manager") {
      return res.status(403).json({
        success: false,
        message: "Only HR managers can delete employees",
      });
    }

    // BEFORE (broken): loads full doc then calls .save() → triggers full validation
    // → fails on stale enum values like gender:"Male" stored before schema tightening
    //
    // const employee = await Employee.findById(req.params.id);
    // employee.isActive = false;
    // employee.status = "inactive";
    // await employee.save();

    // AFTER: direct update, runValidators:false — only touches these two fields
    const employee = await Employee.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          isActive: false,
          status: "inactive",
          updatedBy: user.id,
          updatedByName: user.name || "",
          updatedAt: new Date(),
        },
      },
      { new: true, runValidators: false },
    );

    if (!employee)
      return res
        .status(404)
        .json({ success: false, message: "Employee not found" });

    // Audit: who deactivated this employee.
    recordChange(req, {
      departmentSlug: "hr",
      section: "hr:employees",
      entity: "employee",
      entityId: req.params.id,
      entityLabel: `${employee.firstName || ""} ${employee.lastName || ""}`.trim(),
      action: "delete",
      summary: "Deactivated employee",
      before: { status: "active" },
      after: { status: "inactive" },
    });

    res
      .status(200)
      .json({ success: true, message: "Employee deactivated successfully" });
  } catch (error) {
    console.error("Delete employee error:", error);
    if (error.name === "CastError")
      return res
        .status(400)
        .json({ success: false, message: "Invalid employee ID" });
    res
      .status(500)
      .json({ success: false, message: "Error deleting employee" });
  }
});

router.get("/team-structure", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    // Fetch all active employees with only the fields we need
    const employees = await Employee.find({ isActive: true })
      .select(
        "firstName lastName department designation biometricId profilePhoto primaryManager secondaryManager",
      )
      .lean();

    // Build a map: leaderId → { leaderDoc, primaryReports, secondaryReports }
    const leaderMap = {};

    for (const emp of employees) {
      const pid = emp.primaryManager?.managerId
        ? String(emp.primaryManager.managerId)
        : null;
      const sid = emp.secondaryManager?.managerId
        ? String(emp.secondaryManager.managerId)
        : null;

      if (pid) {
        if (!leaderMap[pid]) leaderMap[pid] = { primary: [], secondary: [] };
        leaderMap[pid].primary.push({
          _id: emp._id,
          firstName: emp.firstName,
          lastName: emp.lastName,
          department: emp.department,
          designation: emp.designation,
          biometricId: emp.biometricId,
          profilePhoto: emp.profilePhoto,
        });
      }
      if (sid) {
        if (!leaderMap[sid]) leaderMap[sid] = { primary: [], secondary: [] };
        leaderMap[sid].secondary.push({
          _id: emp._id,
          firstName: emp.firstName,
          lastName: emp.lastName,
          department: emp.department,
          designation: emp.designation,
          biometricId: emp.biometricId,
          profilePhoto: emp.profilePhoto,
        });
      }
    }

    // Enrich with leader data
    const leaderIds = Object.keys(leaderMap);
    if (!leaderIds.length) return res.json({ success: true, data: [] });

    const leaders = await Employee.find({
      _id: { $in: leaderIds },
      isActive: true,
    })
      .select(
        "firstName lastName department designation biometricId profilePhoto",
      )
      .lean();

    const result = leaders.map((l) => ({
      _id: l._id,
      firstName: l.firstName,
      lastName: l.lastName,
      department: l.department,
      designation: l.designation,
      biometricId: l.biometricId,
      profilePhoto: l.profilePhoto,
      primaryReports: leaderMap[String(l._id)]?.primary || [],
      secondaryReports: leaderMap[String(l._id)]?.secondary || [],
      totalReports:
        (leaderMap[String(l._id)]?.primary.length || 0) +
        (leaderMap[String(l._id)]?.secondary.length || 0),
    }));

    // Sort by department, then by name
    result.sort((a, b) => {
      const dept = (a.department || "").localeCompare(b.department || "");
      if (dept !== 0) return dept;
      return `${a.firstName} ${a.lastName}`.localeCompare(
        `${b.firstName} ${b.lastName}`,
      );
    });

    res.json({ success: true, data: result });
  } catch (err) {
    console.error("[TEAM-STRUCTURE]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const capitalize = (str) =>
  str ? str.charAt(0).toUpperCase() + str.slice(1) : str;

const maskId = (id) => {
  if (!id || id.length < 4) return id;
  return "XXXX XXXX " + id.slice(-4);
};

const calculateAge = (dob) => {
  const today = new Date();
  const birth = new Date(dob);
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
};

const calculateTenure = (dateOfJoining) => {
  const today = new Date();
  const joining = new Date(dateOfJoining);
  let years = today.getFullYear() - joining.getFullYear();
  let months = today.getMonth() - joining.getMonth();
  if (months < 0) {
    years--;
    months += 12;
  }
  return { years, months };
};

const formatEmploymentType = (type) => {
  const map = {
    full_time: "Full Time",
    part_time: "Part Time",
    contract: "Contract",
    intern: "Intern",
  };
  return map[type] || type || "Not Provided";
};

const getManagerHierarchy = async (employeeId) => {
  try {
    const hierarchy = [];
    let current = await Employee.findById(employeeId)
      .select("primaryManager firstName lastName biometricId department")
      .populate(
        "primaryManager.managerId",
        "firstName lastName biometricId department",
      )
      .lean();
    const visited = new Set();
    while (current && !visited.has(current._id.toString())) {
      visited.add(current._id.toString());
      hierarchy.push({
        id: current._id,
        name: [current.firstName, current.lastName]
          .filter(Boolean)
          .join(" ")
          .trim(),
        employeeId: current.biometricId,
        department: current.department,
        level: hierarchy.length + 1,
      });
      if (current.primaryManager?.managerId) {
        current = await Employee.findById(current.primaryManager.managerId._id)
          .select("primaryManager firstName lastName biometricId department")
          .populate(
            "primaryManager.managerId",
            "firstName lastName biometricId department",
          )
          .lean();
      } else break;
    }
    return hierarchy.reverse();
  } catch (e) {
    console.error("Manager hierarchy error:", e);
    return [];
  }
};

const getRecentActivities = async (employeeId) => {
  // Placeholder – integrate with an audit log collection if available
  return [
    {
      id: 1,
      activity: "Profile updated",
      date: new Date().toLocaleDateString("en-IN"),
      type: "update",
    },
  ];
};

module.exports = router;
