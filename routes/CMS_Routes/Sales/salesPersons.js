// routes/CMS_Routes/Sales/salesPersons.js
//
// THE SALES ROSTER — who is on sales duty, and which corporate phone number
// stands for them in the call log and the tracking map.
//
// Explicit request, 30 Aug 2026: "in the setting page, put the input for
// defining the sales person... select the employee, describe what he/she is
// doing/responsible for... we need to track these sales person corporate
// office phone number from the employee schema... only these phone number's
// need to take reference as an sales person's in order to track the call
// logs, location tracking and all."
//
// See models/CMS_Models/Sales/SalesPerson.js for why the phone is snapshotted
// onto the roster row rather than read live off the Employee every time.
"use strict";

const express = require("express");
const router = express.Router();

const Employee = require("../../../models/Employee");
const { SalesPerson, normalizePhone } = require("../../../models/CMS_Models/Sales/SalesPerson");
const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");

/** The fields the picker and every roster row need.
 *
 *  NAME IS THREE FIELDS, NOT ONE. Employee stores firstName/middleName/
 *  lastName and exposes `fullName` only as a VIRTUAL — and virtuals do not
 *  survive `.lean()`, which every read here uses. Selecting "name" (not a real
 *  path on this schema) silently resolved to undefined for all 105 employees,
 *  so the picker rendered a list of blank rows. `displayName` below is the one
 *  place those parts get joined. */
const EMPLOYEE_FIELDS = "firstName middleName lastName email biometricId department designation workPhone phone status isActive";

/** "KRISHNA BEHERA" from the three name parts, blanks skipped. */
function displayName(e) {
  return [e?.firstName, e?.middleName, e?.lastName].filter(Boolean).join(" ").trim();
}

/** One employee, shaped for the dropdown. */
function toOption(e) {
  return {
    _id: String(e._id),
    name: displayName(e),
    email: e.email || "",
    employeeCode: e.biometricId || "",
    department: e.department || "",
    designation: e.designation || "",
    workPhone: e.workPhone || "",
    // Surfaced ONLY so the picker can warn "this employee has no corporate
    // number yet" — the roster itself never falls back to the personal one.
    // The Employee schema is explicit that `phone` is the number they log in
    // with, and tracking somebody's personal phone is a different decision
    // from tracking the handset the company issued them.
    hasWorkPhone: Boolean((e.workPhone || "").trim()),
  };
}

/**
 * GET /employees — candidates for the dropdown.
 *
 * Everyone active, whether or not they have a work phone: an admin needs to
 * SEE that a person is missing one (and go fix it in HR) rather than have them
 * silently absent from a list they are expecting to find them in.
 */
router.get("/employees", salesAuth, async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const filter = {};
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ name: rx }, { email: rx }, { biometricId: rx }, { workPhone: rx }];
    }

    const employees = await Employee.find(filter)
      .select(EMPLOYEE_FIELDS)
      .sort({ name: 1 })
      .limit(500)
      .lean();

    // Already on the roster — the picker greys these out rather than letting
    // somebody add a duplicate and hit the unique-index error.
    const taken = await SalesPerson.find({}).select("employeeRef").lean();
    const takenIds = new Set(taken.map((r) => String(r.employeeRef)));

    res.json({
      success: true,
      employees: employees
        .filter((e) => e.isActive !== false && e.status !== "inactive")
        .map((e) => ({ ...toOption(e), alreadyAdded: takenIds.has(String(e._id)) })),
    });
  } catch (err) {
    console.error("[salesPersons] employees failed:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET / — the roster.
 *
 * Each row carries `phoneDrifted`: the employee's corporate number has since
 * changed from the snapshot this row was created with. Reported, never
 * auto-applied — re-syncing re-attributes history, so it is the admin's call.
 */
router.get("/", salesAuth, async (req, res) => {
  try {
    const rows = await SalesPerson.find({})
      .populate("employeeRef", EMPLOYEE_FIELDS)
      .sort({ active: -1, name: 1 })
      .lean();

    res.json({
      success: true,
      salesPersons: rows.map((r) => {
        const live = r.employeeRef || null;
        const liveWorkPhone = (live?.workPhone || "").trim();
        return {
          _id: String(r._id),
          employeeRef: live ? String(live._id) : null,
          employeeCode: r.employeeCode || live?.biometricId || "",
          name: r.name || displayName(live) || "",
          email: r.email || live?.email || "",
          department: r.department || live?.department || "",
          designation: r.designation || live?.designation || "",
          workPhone: r.workPhone || "",
          normalizedPhone: r.normalizedPhone || "",
          responsibility: r.responsibility || "",
          active: r.active !== false,
          syncedAt: r.syncedAt || null,
          createdAt: r.createdAt || null,
          // The employee record is gone — the row is kept so past calls stay
          // attributed, but it can no longer be re-synced.
          employeeMissing: !live,
          phoneDrifted: Boolean(live && liveWorkPhone && liveWorkPhone !== (r.workPhone || "").trim()),
          livePhone: liveWorkPhone,
        };
      }),
    });
  } catch (err) {
    console.error("[salesPersons] list failed:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/** POST / — put an employee on the roster, snapshotting their corporate phone. */
router.post("/", salesAuth, async (req, res) => {
  try {
    const { employeeRef, responsibility } = req.body || {};
    if (!employeeRef) return res.status(400).json({ success: false, message: "Choose an employee." });

    const employee = await Employee.findById(employeeRef).select(EMPLOYEE_FIELDS).lean();
    if (!employee) return res.status(404).json({ success: false, message: "That employee no longer exists." });

    const workPhone = String(employee.workPhone || "").trim();
    if (!workPhone) {
      // REFUSED RATHER THAN ADDED WITHOUT ONE. The whole point of a roster row
      // is the number it carries; one without a phone matches no call and no
      // route, and would sit there looking configured while doing nothing.
      return res.status(400).json({
        success: false,
        code: "NO_WORK_PHONE",
        message: `${displayName(employee) || "This employee"} has no corporate phone number on their HR record. Add it there first — the call log and tracking are matched on that number.`,
      });
    }

    const existing = await SalesPerson.findOne({ employeeRef }).lean();
    if (existing) return res.status(409).json({ success: false, message: `${displayName(employee) || "That employee"} is already on the sales roster.` });

    const doc = await SalesPerson.create({
      employeeRef,
      employeeCode: employee.biometricId || "",
      name: displayName(employee),
      email: employee.email || "",
      department: employee.department || "",
      designation: employee.designation || "",
      workPhone,
      normalizedPhone: normalizePhone(workPhone),
      responsibility: String(responsibility || "").trim().slice(0, 500),
      active: true,
      syncedAt: new Date(),
      addedByEmail: String(req.user?.email || req.dept?.email || "").toLowerCase(),
    });

    res.json({ success: true, salesPerson: doc });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ success: false, message: "That employee is already on the sales roster." });
    }
    console.error("[salesPersons] create failed:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * PATCH /:id — edit the responsibility, toggle active, or re-sync the phone.
 *
 * `resyncPhone` is the ONLY way the number changes, and it is deliberately an
 * explicit action: it re-points every future match at the new number, and any
 * call already recorded under the old one keeps that attribution.
 */
router.patch("/:id", salesAuth, async (req, res) => {
  try {
    const row = await SalesPerson.findById(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: "Not on the roster." });

    const { responsibility, active, resyncPhone } = req.body || {};

    if (responsibility !== undefined) row.responsibility = String(responsibility || "").trim().slice(0, 500);
    if (active !== undefined) row.active = Boolean(active);

    if (resyncPhone) {
      const employee = await Employee.findById(row.employeeRef).select(EMPLOYEE_FIELDS).lean();
      if (!employee) return res.status(404).json({ success: false, message: "That employee no longer exists, so their number can't be re-synced." });
      const workPhone = String(employee.workPhone || "").trim();
      if (!workPhone) {
        return res.status(400).json({ success: false, code: "NO_WORK_PHONE", message: "That employee has no corporate phone number on their HR record." });
      }
      row.workPhone = workPhone;
      row.normalizedPhone = normalizePhone(workPhone);
      row.name = displayName(employee) || row.name;
      row.employeeCode = employee.biometricId || row.employeeCode;
      row.department = employee.department || row.department;
      row.designation = employee.designation || row.designation;
      row.syncedAt = new Date();
    }

    await row.save();
    res.json({ success: true, salesPerson: row });
  } catch (err) {
    console.error("[salesPersons] update failed:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * DELETE /:id — take somebody off the roster entirely.
 *
 * Offered because an admin who added the wrong person should be able to undo
 * it. The UI steers toward deactivating instead (which keeps past calls
 * attributed); this is the escape hatch, not the default.
 */
router.delete("/:id", salesAuth, async (req, res) => {
  try {
    const removed = await SalesPerson.findByIdAndDelete(req.params.id);
    if (!removed) return res.status(404).json({ success: false, message: "Not on the roster." });
    res.json({ success: true });
  } catch (err) {
    console.error("[salesPersons] delete failed:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
