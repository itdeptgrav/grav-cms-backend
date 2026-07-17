// routes/HrRoutes/policyRoutes.js
// ─────────────────────────────────────────────────────────────────────────────
// HR Compliance Policy routes.
//
// Mount in your main server file alongside the SOP route:
//   app.use("/api/hr/policy", require("./routes/HrRoutes/policyRoutes"));
//
// Endpoints:
//   GET    /api/hr/policy                 list policies (?scope= &department=)
//   POST   /api/hr/policy                 create policy
//   PATCH  /api/hr/policy/:id             edit policy
//   DELETE /api/hr/policy/:id             delete policy
//   GET    /api/hr/policy/departments     active departments (for the scope dropdown)
//   GET    /api/hr/policy/suggestions     scan attendance → violation suggestions (?from= &to=)
//   POST   /api/hr/policy/apply           accept one suggestion → write a C4 bleach
//
// Auth + mount mirror routes/HrRoutes/hrSopRoutes.js exactly so behaviour is
// identical to the existing SOP module.
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const Policy = require("../../models/HR_Models/Policy");
const C4Config = require("../../models/HR_Models/C4Config");
const Department = require("../../models/HR_Models/Departments");
const Employee = require("../../models/Employee");
const DailyAttendance = require("../../models/HR_Models/Dailyattendance");
const verifyHRToken = require("../../Middlewear/EmployeeAuthMiddlewear");

const AUTO_TRIGGERS = ["absent_no_notice", "late_arrival", "early_departure"];
// Reward rule — resolves to C4 Settings' basePointsPerDay at apply time so
// manual backfills always match what the auto engine writes.
const REWARD_TRIGGERS = ["present_on_time"];
const ALL_TRIGGERS = [...AUTO_TRIGGERS, ...REWARD_TRIGGERS, "manual"];

// ── small helpers ────────────────────────────────────────────────────────────
const pad2 = (n) => String(n).padStart(2, "0");

function monthRange() {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth(); // 0-based
  const first = `${y}-${pad2(m + 1)}-01`;
  const lastDay = new Date(y, m + 1, 0).getDate();
  const last = `${y}-${pad2(m + 1)}-${pad2(lastDay)}`;
  return { first, last };
}

// Local "YYYY-MM-DD" (never toISOString — it shifts back 5:30h in IST).
function todayLocalStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// C4 CONFIG — pre-saved point values (singleton). No percentages.
// GET  /api/hr/policy/c4-config
// PUT  /api/hr/policy/c4-config
// ═════════════════════════════════════════════════════════════════════════════
router.get("/c4-config", verifyHRToken, async (req, res) => {
  try {
    const cfg = await C4Config.getSingleton();
    res.json({ success: true, config: cfg });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/c4-config", verifyHRToken, async (req, res) => {
  try {
    const cfg = await C4Config.getSingleton();
    const NUMS = [
      "basePointsPerDay",
      "lateArrivalPoints",
      "absencePoints",
      "earlyDeparturePoints",
      "lateThresholdMins",
      "earlyThresholdMins",
    ];
    for (const f of NUMS) {
      if (req.body[f] !== undefined && !isNaN(Number(req.body[f]))) {
        const v = Number(req.body[f]);
        if (v < 0)
          return res.status(400).json({ error: `${f} cannot be negative.` });
        cfg[f] = v;
      }
    }
    if (req.body.presenceAutoCredit !== undefined)
      cfg.presenceAutoCredit = !!req.body.presenceAutoCredit;
    if (Array.isArray(req.body.nonWorkingStatuses))
      cfg.nonWorkingStatuses = req.body.nonWorkingStatuses.map(String);
    if (req.body.updatedByName)
      cfg.updatedByName = String(req.body.updatedByName);
    if (req.body.updatedByRole)
      cfg.updatedByRole = String(req.body.updatedByRole);
    cfg.updatedAt = Date.now();
    await cfg.save();
    res.json({ success: true, config: cfg, message: "C4 settings saved." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// PRESENCE CREDIT ENGINE — flat points, no working-day math.
// Writes the daily base point (debit, +basePointsPerDay) into sopPoints for
// every present-and-on-time working day, when cfg.presenceAutoCredit is on.
//   • Dedup marker: bleach.taskId === "c4_presence" + the date.
//   • Only credits days strictly BEFORE today (today is still in progress).
//   • Uses updateOne ($push/$inc), deliberately bypassing employee.save() so
//     the salary-encryption pre-save hook doesn't churn on every credit.
//   • KNOWN LIMIT: a credit is never revoked if HR later regularizes that day
//     to Absent — flag such days before the engine reaches them.
// ═════════════════════════════════════════════════════════════════════════════
const PRESENCE_MARKER = "c4_presence";

async function runPresenceCredits(fromStr, toStr) {
  const cfg = await C4Config.getSingleton();
  const out = {
    enabled: !!cfg.presenceAutoCredit,
    from: fromStr,
    to: toStr,
    credited: 0,
    skipped: 0,
  };
  if (!cfg.presenceAutoCredit) return out;

  const basePerDay = Number(cfg.basePointsPerDay) || 0;
  if (!(basePerDay > 0)) return out;
  const nonWorking = new Set(cfg.nonWorkingStatuses || ["WO"]);
  const lateThr = Number(cfg.lateThresholdMins) || 0;
  const earlyThr = Number(cfg.earlyThresholdMins) || 0;

  // Never credit today — the day isn't over.
  const today = todayLocalStr();
  const to =
    toStr < today
      ? toStr
      : (() => {
          const d = new Date(`${today}T00:00:00`);
          d.setDate(d.getDate() - 1);
          return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
        })();
  if (fromStr > to) return out;

  const days = await DailyAttendance.find({
    dateStr: { $gte: fromStr, $lte: to },
  })
    .select(
      "dateStr employees.biometricId employees.isLate employees.lateMins " +
        "employees.isEarlyDeparture employees.earlyDepartureMins " +
        "employees.systemPrediction employees.hrFinalStatus",
    )
    .lean();

  // Already-credited set: `${bid}|${date}`
  const emps = await Employee.find({})
    .select(
      "biometricId sopPoints.year sopPoints.bleaches.taskId sopPoints.bleaches.date",
    )
    .lean();
  const done = new Set();
  for (const e of emps)
    for (const yp of e.sopPoints || [])
      for (const b of yp.bleaches || [])
        if (b.taskId === PRESENCE_MARKER && b.date)
          done.add(`${e.biometricId}|${b.date}`);

  for (const day of days) {
    for (const entry of day.employees || []) {
      const bid = entry.biometricId;
      if (!bid) continue;

      // On-time = a working day, not absent, not late/early over threshold.
      const eff = entry.hrFinalStatus || entry.systemPrediction || "";
      if (nonWorking.has(eff) || eff === "AB") continue;
      const isLate = !!entry.isLate && Number(entry.lateMins || 0) > lateThr;
      const isEarly =
        !!entry.isEarlyDeparture &&
        Number(entry.earlyDepartureMins || 0) > earlyThr;
      if (isLate || isEarly) continue;

      const key = `${bid}|${day.dateStr}`;
      if (done.has(key)) {
        out.skipped++;
        continue;
      }

      const year = Number(day.dateStr.slice(0, 4));
      const bleach = {
        sopId: null,
        policyId: null,
        type: "C4",
        sopName: "Present & on time",
        folderName: "Company-wide",
        points: basePerDay,
        description: `Daily attendance base point (${day.dateStr})`,
        date: day.dateStr,
        bleachType: "debit",
        isCredit: true,
        taskId: PRESENCE_MARKER,
        componentId: null,
        cutBy: "",
        cutByName: "System",
        cutByRole: "system",
        recheck: {
          status: "none",
          requestedAt: null,
          requestNote: "",
          reviewedBy: null,
          reviewedByName: null,
          reviewedAt: null,
          reviewNote: "",
        },
      };

      // Push into the matching year record; create it if absent. updateOne
      // avoids the heavy salary pre-save hook that employee.save() triggers.
      const r = await Employee.updateOne(
        { biometricId: bid, "sopPoints.year": year },
        {
          $push: { "sopPoints.$.bleaches": bleach },
          $inc: { "sopPoints.$.totalDeducted": -basePerDay },
        },
      );
      if (!r.matchedCount) {
        await Employee.updateOne(
          { biometricId: bid },
          {
            $push: {
              sopPoints: {
                year,
                totalDeducted: -basePerDay,
                bleaches: [bleach],
              },
            },
          },
        );
      }
      done.add(key);
      out.credited++;
    }
  }
  return out;
}

// Hourly background pass with a 7-day lookback (self-healing: dedup makes
// repeats free; the lookback catches late-arriving attendance docs and server
// downtime). Global guard so hot-reloads don't stack timers.
if (!global.__c4PresenceTimer) {
  const kick = () => {
    const today = todayLocalStr();
    const d = new Date(`${today}T00:00:00`);
    d.setDate(d.getDate() - 7);
    const from = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    runPresenceCredits(from, today).then(
      (r) =>
        r.enabled &&
        (r.credited || r.skipped) &&
        console.log(
          `[C4 presence] credited=${r.credited} skipped=${r.skipped} (${r.from}→${r.to})`,
        ),
      (e) => console.error("[C4 presence] error:", e.message),
    );
  };
  global.__c4PresenceTimer = setInterval(kick, 60 * 60 * 1000);
  setTimeout(kick, 30 * 1000); // first pass shortly after boot
}

// ═════════════════════════════════════════════════════════════════════════════
// C4 PRESENCE — manual run (for testing / backfill beyond the 7-day lookback)
// POST /api/hr/policy/c4-presence-run   body: { from?, to? }  (YYYY-MM-DD)
// ═════════════════════════════════════════════════════════════════════════════
router.post("/c4-presence-run", verifyHRToken, async (req, res) => {
  try {
    const today = todayLocalStr();
    const d = new Date(`${today}T00:00:00`);
    d.setDate(d.getDate() - 7);
    const defFrom = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const from = (req.body.from || defFrom).slice(0, 10);
    const to = (req.body.to || today).slice(0, 10);
    const r = await runPresenceCredits(from, to);
    res.json({
      success: true,
      ...r,
      message: r.enabled
        ? `Credited ${r.credited} day(s); ${r.skipped} already credited.`
        : "Auto-credit is OFF — enable it in C4 Settings first.",
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// DEPARTMENTS (for the scope dropdown on the policy form)
// GET /api/hr/policy/departments
// ═════════════════════════════════════════════════════════════════════════════
router.get("/departments", verifyHRToken, async (req, res) => {
  try {
    const depts = await Department.find({ status: "active" })
      .select("name")
      .sort({ name: 1 })
      .lean();
    res.json({
      success: true,
      departments: depts.map((d) => ({ id: d._id, name: d.name })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// EMPLOYEES (for the manual-apply picker)
// GET /api/hr/policy/employees
// Active employees only — uses the status/isActive duality so records that
// carry status:"active" without isActive:true are still included.
// ═════════════════════════════════════════════════════════════════════════════
router.get("/employees", verifyHRToken, async (req, res) => {
  try {
    const emps = await Employee.find({
      $or: [{ status: "active" }, { isActive: true }],
      biometricId: { $nin: [null, ""] },
    })
      .select("biometricId firstName lastName department")
      .sort({ firstName: 1 })
      .lean();
    res.json({
      success: true,
      employees: emps.map((e) => ({
        biometricId: e.biometricId,
        name:
          `${e.firstName || ""} ${e.lastName || ""}`.trim() || e.biometricId,
        department: e.department || "",
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POINTS SUMMARY (read-only dashboard data)
// GET /api/hr/policy/points-summary?year=&from=&to=&type=
//
// Aggregates EVERY active employee's sopPoints bleaches — across all sources
// (C1/C2/C3 from the cowork/admin side, C4 from this module). Each bleach is
// self-describing, so no cowork-side models are needed here.
//
// Sign convention (backend): credit/penalty raises the net (worse), debit/
// reward lowers it (better). Each employee/type also gets `score = -net`, the
// "higher = better" number to show on screen.
// ═════════════════════════════════════════════════════════════════════════════
router.get("/points-summary", verifyHRToken, async (req, res) => {
  try {
    const year = req.query.year
      ? Number(req.query.year)
      : new Date().getFullYear();
    const from = req.query.from ? String(req.query.from).slice(0, 10) : null;
    const to = req.query.to ? String(req.query.to).slice(0, 10) : null;
    const typeFilter = req.query.type || null;

    const emps = await Employee.find({
      $or: [{ status: "active" }, { isActive: true }],
    })
      .select("biometricId firstName lastName department sopPoints")
      .lean();

    const KNOWN = ["C1", "C2", "C3", "C4"];
    const byType = {};
    const ensure = (t) =>
      (byType[t] = byType[t] || {
        type: t,
        count: 0,
        penaltyPts: 0,
        rewardPts: 0,
        net: 0,
      });
    KNOWN.forEach(ensure);

    const employees = [];
    const recent = [];
    const catalogByType = {}; // type -> Map(sopName -> {count, source})

    for (const e of emps) {
      const yp = (e.sopPoints || []).find((y) => y.year === year);
      if (!yp) continue;
      let empNet = 0;
      const empByType = {};

      for (const b of yp.bleaches || []) {
        if (from && (!b.date || b.date < from)) continue;
        if (to && (!b.date || b.date > to)) continue;
        const t = KNOWN.includes(b.type) ? b.type : "Other";
        if (typeFilter && t !== typeFilter) continue;

        const pts = Number(b.points) || 0;
        // Reward if explicitly debit OR the legacy isCredit flag is set.
        const isReward = b.bleachType === "debit" || b.isCredit === true;
        const bucket = ensure(t);
        bucket.count += 1;
        if (isReward) {
          bucket.rewardPts += pts;
          bucket.net -= pts;
          empNet -= pts;
          empByType[t] = (empByType[t] || 0) - pts;
        } else {
          bucket.penaltyPts += pts;
          bucket.net += pts;
          empNet += pts;
          empByType[t] = (empByType[t] || 0) + pts;
        }

        const name = b.sopName || "—";
        catalogByType[t] = catalogByType[t] || new Map();
        const ex = catalogByType[t].get(name) || {
          name,
          type: t,
          count: 0,
          source: b.policyId ? "policy" : b.sopId ? "sop" : "task",
        };
        ex.count += 1;
        catalogByType[t].set(name, ex);

        // Daily presence credits stay in the totals/score but are excluded
        // from the activity feed — hundreds of identical "+N Present" rows
        // would bury every real event.
        if (b.taskId === "c4_presence") continue;

        recent.push({
          biometricId: e.biometricId,
          employeeName: `${e.firstName || ""} ${e.lastName || ""}`.trim(),
          type: t,
          name,
          points: pts,
          bleachType: isReward ? "debit" : "credit",
          date: b.date || "",
          by: b.cutByName || "",
        });
      }

      if (Object.keys(empByType).length) {
        employees.push({
          biometricId: e.biometricId,
          name:
            `${e.firstName || ""} ${e.lastName || ""}`.trim() || e.biometricId,
          department: e.department || "",
          net: +empNet.toFixed(2),
          score: +(-empNet).toFixed(2), // higher = better, for display
          byType: empByType,
        });
      }
    }

    recent.sort((a, b) => (a.date < b.date ? 1 : -1));

    const types = Object.values(byType).map((x) => ({
      type: x.type,
      count: x.count,
      penaltyPts: +x.penaltyPts.toFixed(2),
      rewardPts: +x.rewardPts.toFixed(2),
      net: +x.net.toFixed(2),
      score: +(-x.net).toFixed(2),
    }));

    const catalog = Object.entries(catalogByType).map(([t, map]) => ({
      type: t,
      policies: [...map.values()].sort((a, b) => b.count - a.count),
    }));

    const grandNet = types.reduce((s, t) => s + t.net, 0);

    res.json({
      success: true,
      year,
      from,
      to,
      types,
      employees: employees.sort((a, b) => a.net - b.net), // best (lowest net) first
      recent: recent.slice(0, 150),
      catalog,
      grandNet: +grandNet.toFixed(2),
      grandScore: +(-grandNet).toFixed(2),
      employeeCount: employees.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// EMPLOYEE HISTORY (detail sidebar) — one employee, entry-by-entry, paginated
// GET /api/hr/policy/employee-history/:biometricId?year=&type=&page=&limit=
// `counts` powers the category tabs; `items` is the paginated list for `type`.
// ═════════════════════════════════════════════════════════════════════════════
router.get(
  "/employee-history/:biometricId",
  verifyHRToken,
  async (req, res) => {
    try {
      const { biometricId } = req.params;
      const year = req.query.year
        ? Number(req.query.year)
        : new Date().getFullYear();
      const typeFilter =
        req.query.type && req.query.type !== "all" ? req.query.type : null;
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

      const emp = await Employee.findOne({ biometricId })
        .select("biometricId firstName lastName department sopPoints")
        .lean();
      if (!emp) return res.status(404).json({ error: "Employee not found." });

      const yp = (emp.sopPoints || []).find((y) => y.year === year);
      const bleaches = yp ? yp.bleaches || [] : [];

      const KNOWN = ["C1", "C2", "C3", "C4"];
      const normType = (b) => (KNOWN.includes(b.type) ? b.type : "Other");

      const counts = {
        C1: 0,
        C2: 0,
        C3: 0,
        C4: 0,
        Other: 0,
        all: bleaches.length,
      };
      let net = 0;
      for (const b of bleaches) {
        counts[normType(b)] += 1;
        const pts = Number(b.points) || 0;
        const isReward = b.bleachType === "debit" || b.isCredit === true;
        net += isReward ? -pts : pts;
      }

      const items = bleaches
        .filter((b) => !typeFilter || normType(b) === typeFilter)
        .map((b) => {
          const pts = Number(b.points) || 0;
          const isReward = b.bleachType === "debit" || b.isCredit === true;
          return {
            type: normType(b),
            name: b.sopName || "—",
            description: b.description || "",
            points: pts,
            bleachType: isReward ? "debit" : "credit",
            date: b.date || "",
            by: b.cutByName || "",
            recheckStatus: (b.recheck && b.recheck.status) || "none",
          };
        })
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

      const total = items.length;
      const totalPages = Math.max(1, Math.ceil(total / limit));
      const start = (page - 1) * limit;

      res.json({
        success: true,
        employee: {
          biometricId: emp.biometricId,
          name:
            `${emp.firstName || ""} ${emp.lastName || ""}`.trim() ||
            emp.biometricId,
          department: emp.department || "",
        },
        year,
        counts,
        net: +net.toFixed(2),
        score: +(-net).toFixed(2),
        type: typeFilter || "all",
        page,
        limit,
        total,
        totalPages,
        items: items.slice(start, start + limit),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// EXTERNAL RULES (read-only) — C1/C2/… scoring rules defined on the cowork side.
// Source: bandconfigs.globalSettings. Each category (c1, c2, …) holds named
// rules; a rule carries either `award` (points increase) or `deduction`
// (penalty) plus a `desc`. Flattened here for display only — HR cannot edit.
// GET /api/hr/policy/external-rules
// ═════════════════════════════════════════════════════════════════════════════
router.get("/external-rules", verifyHRToken, async (req, res) => {
  try {
    const doc = await mongoose.connection.db
      .collection("bandconfigs")
      .findOne({}, { sort: { updatedAt: -1 } });

    if (!doc || !doc.globalSettings)
      return res.json({
        success: true,
        rules: [],
        updatedBy: doc ? doc.updatedBy || null : null,
        updatedAt: doc ? doc.updatedAt || null : null,
      });

    const rules = [];
    for (const [catKey, catRules] of Object.entries(doc.globalSettings)) {
      if (!catRules || typeof catRules !== "object") continue;
      const category = String(catKey).toUpperCase(); // c1 → C1
      for (const [ruleKey, def] of Object.entries(catRules)) {
        if (!def || typeof def !== "object") continue;
        const hasAward = def.award !== undefined && def.award !== null;
        const hasDeduction =
          def.deduction !== undefined && def.deduction !== null;
        if (!hasAward && !hasDeduction) continue;
        rules.push({
          category,
          key: ruleKey,
          name: def.desc || ruleKey,
          points: Number(hasAward ? def.award : def.deduction) || 0,
          // "award" = increases the employee's score (reward)
          // "deduction" = penalty
          type: hasAward ? "award" : "deduction",
        });
      }
    }

    // Group order: by category then by name, so display is stable.
    rules.sort((a, b) =>
      a.category === b.category
        ? a.name.localeCompare(b.name)
        : a.category.localeCompare(b.category),
    );

    res.json({
      success: true,
      rules,
      updatedBy: doc.updatedBy || null,
      updatedAt: doc.updatedAt || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// LIST POLICIES
// GET /api/hr/policy?scope=&department=
// ═════════════════════════════════════════════════════════════════════════════
router.get("/", verifyHRToken, async (req, res) => {
  try {
    const { scope, department } = req.query;
    const q = {};
    if (scope === "global" || scope === "department") q.scope = scope;
    if (department) q.departmentName = department;
    const policies = await Policy.find(q)
      .sort({ scope: 1, departmentName: 1, createdAt: -1 })
      .lean();
    res.json({ success: true, policies });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// CREATE POLICY
// POST /api/hr/policy
// ═════════════════════════════════════════════════════════════════════════════
router.post("/", verifyHRToken, async (req, res) => {
  try {
    const {
      name,
      description,
      points,
      category,
      scope,
      departmentId,
      triggerKey,
      thresholdMins,
      isActive,
      bleachType,
      createdByName,
      createdByRole,
    } = req.body;

    if (!name || !name.trim())
      return res.status(400).json({ error: "Policy name is required." });
    if (points === undefined || points === null || isNaN(Number(points)))
      return res.status(400).json({ error: "Valid points value is required." });

    // Direction constrains which rules make sense:
    //   Reward (debit)  → "manual" or the predefined "present_on_time".
    //   Penalty (credit) → attendance triggers or "manual" — never a reward rule.
    const finalBleachType = bleachType === "debit" ? "debit" : "credit";
    const reqTrigger = ALL_TRIGGERS.includes(triggerKey)
      ? triggerKey
      : "manual";
    const finalTrigger =
      finalBleachType === "debit"
        ? REWARD_TRIGGERS.includes(reqTrigger)
          ? reqTrigger
          : "manual"
        : REWARD_TRIGGERS.includes(reqTrigger)
          ? "manual"
          : reqTrigger;

    let depId = null;
    let depName = "";
    const finalScope = scope === "department" ? "department" : "global";
    if (finalScope === "department") {
      if (!departmentId)
        return res
          .status(400)
          .json({ error: "departmentId is required for a department policy." });
      const dep = await Department.findById(departmentId).lean();
      if (!dep) return res.status(404).json({ error: "Department not found." });
      depId = dep._id;
      depName = dep.name;
    }

    const policy = await Policy.create({
      name: name.trim(),
      description: (description || "").trim(),
      points: Number(points),
      category: "C4", // hard-locked — HR cannot create other categories
      scope: finalScope,
      departmentId: depId,
      departmentName: depName,
      triggerKey: finalTrigger,
      thresholdMins:
        thresholdMins !== undefined && !isNaN(Number(thresholdMins))
          ? Number(thresholdMins)
          : 15,
      isActive: isActive === undefined ? true : !!isActive,
      bleachType: finalBleachType,
      createdByName: createdByName || "HR Manager",
      createdByRole: createdByRole || "hr_manager",
    });

    res.status(201).json({ success: true, policy });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// EDIT POLICY
// PATCH /api/hr/policy/:id
// ═════════════════════════════════════════════════════════════════════════════
router.patch("/:id", verifyHRToken, async (req, res) => {
  try {
    const policy = await Policy.findById(req.params.id);
    if (!policy) return res.status(404).json({ error: "Policy not found." });

    const {
      name,
      description,
      points,
      category,
      scope,
      departmentId,
      triggerKey,
      thresholdMins,
      isActive,
      bleachType,
    } = req.body;

    if (name !== undefined) policy.name = String(name).trim();
    if (description !== undefined)
      policy.description = String(description).trim();
    if (points !== undefined && !isNaN(Number(points)))
      policy.points = Number(points);
    // Category is hard-locked to C4 — ignore any client-supplied category.
    policy.category = "C4";
    if (triggerKey !== undefined && ALL_TRIGGERS.includes(triggerKey))
      policy.triggerKey = triggerKey;
    if (thresholdMins !== undefined && !isNaN(Number(thresholdMins)))
      policy.thresholdMins = Number(thresholdMins);
    if (isActive !== undefined) policy.isActive = !!isActive;
    if (bleachType === "credit" || bleachType === "debit")
      policy.bleachType = bleachType;

    // Keep direction and rule consistent:
    //   reward → "manual" or "present_on_time"; penalty → never a reward rule.
    if (
      policy.bleachType === "debit" &&
      !REWARD_TRIGGERS.includes(policy.triggerKey)
    )
      policy.triggerKey = "manual";
    if (
      policy.bleachType === "credit" &&
      REWARD_TRIGGERS.includes(policy.triggerKey)
    )
      policy.triggerKey = "manual";

    if (scope !== undefined) {
      if (scope === "department") {
        if (!departmentId)
          return res.status(400).json({
            error: "departmentId is required for a department policy.",
          });
        const dep = await Department.findById(departmentId).lean();
        if (!dep)
          return res.status(404).json({ error: "Department not found." });
        policy.scope = "department";
        policy.departmentId = dep._id;
        policy.departmentName = dep.name;
      } else {
        policy.scope = "global";
        policy.departmentId = null;
        policy.departmentName = "";
      }
    } else if (departmentId !== undefined && policy.scope === "department") {
      const dep = await Department.findById(departmentId).lean();
      if (dep) {
        policy.departmentId = dep._id;
        policy.departmentName = dep.name;
      }
    }

    await policy.save();
    res.json({ success: true, policy });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// DELETE POLICY
// DELETE /api/hr/policy/:id
// ═════════════════════════════════════════════════════════════════════════════
router.delete("/:id", verifyHRToken, async (req, res) => {
  try {
    const policy = await Policy.findByIdAndDelete(req.params.id);
    if (!policy) return res.status(404).json({ error: "Policy not found." });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// SUGGESTIONS — scan attendance for policy violations
// GET /api/hr/policy/suggestions?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Returns a flat list of { biometricId, employeeName, department, date,
// policyId, policyName, points, triggerKey, reason, statusSource }.
// Already-applied (policyId + date + employee) combinations are filtered out.
// Nothing is written — HR must accept each via POST /apply.
// ═════════════════════════════════════════════════════════════════════════════
router.get("/suggestions", verifyHRToken, async (req, res) => {
  try {
    const { first, last } = monthRange();
    const from = (req.query.from || first).slice(0, 10);
    const to = (req.query.to || last).slice(0, 10);

    // 1) Active auto-trigger policies
    const policies = await Policy.find({
      isActive: true,
      triggerKey: { $in: AUTO_TRIGGERS },
    }).lean();

    if (!policies.length) {
      return res.json({
        success: true,
        from,
        to,
        count: 0,
        suggestions: [],
        note: "No active attendance policies with an auto-trigger are defined.",
      });
    }

    // Index policies: global[trigger] = [...]; dept[name][trigger] = [...]
    const globalByTrigger = {};
    const deptByTrigger = {};
    for (const p of policies) {
      if (p.scope === "department" && p.departmentName) {
        deptByTrigger[p.departmentName] = deptByTrigger[p.departmentName] || {};
        deptByTrigger[p.departmentName][p.triggerKey] =
          deptByTrigger[p.departmentName][p.triggerKey] || [];
        deptByTrigger[p.departmentName][p.triggerKey].push(p);
      } else {
        globalByTrigger[p.triggerKey] = globalByTrigger[p.triggerKey] || [];
        globalByTrigger[p.triggerKey].push(p);
      }
    }

    // 2) Attendance day docs in range
    const days = await DailyAttendance.find({
      dateStr: { $gte: from, $lte: to },
    })
      .select(
        "dateStr employees.biometricId employees.employeeName employees.department " +
          "employees.isLate employees.lateMins employees.isEarlyDeparture " +
          "employees.earlyDepartureMins employees.systemPrediction employees.hrFinalStatus",
      )
      .lean();

    // 3) Employees → name fallback + dedup set of already-applied bleaches
    //    (loaded without status filter so dedup is correct for everyone who
    //     appears in attendance, active or not).
    const employees = await Employee.find({})
      .select("biometricId firstName lastName sopPoints")
      .lean();

    const empByBid = new Map();
    const appliedSet = new Set(); // `${bid}|${date}|${policyId}`
    for (const e of employees) {
      empByBid.set(e.biometricId, e);
      for (const yp of e.sopPoints || []) {
        for (const b of yp.bleaches || []) {
          if (b.policyId && b.date)
            appliedSet.add(`${e.biometricId}|${b.date}|${b.policyId}`);
        }
      }
    }

    const matches = (entry, policy) => {
      const eff = entry.hrFinalStatus || entry.systemPrediction || "";
      switch (policy.triggerKey) {
        case "absent_no_notice":
          return eff === "AB";
        case "late_arrival":
          return (
            !!entry.isLate &&
            Number(entry.lateMins || 0) > Number(policy.thresholdMins || 0)
          );
        case "early_departure":
          return (
            !!entry.isEarlyDeparture &&
            Number(entry.earlyDepartureMins || 0) >
              Number(policy.thresholdMins || 0)
          );
        default:
          return false;
      }
    };

    const reasonFor = (entry, policy) => {
      if (policy.triggerKey === "absent_no_notice") return "Marked Absent (AB)";
      if (policy.triggerKey === "late_arrival")
        return `Late by ${entry.lateMins || 0} min (threshold ${policy.thresholdMins})`;
      if (policy.triggerKey === "early_departure")
        return `Left early by ${entry.earlyDepartureMins || 0} min`;
      return "";
    };

    const suggestions = [];
    for (const day of days) {
      for (const entry of day.employees || []) {
        const bid = entry.biometricId;
        if (!bid) continue;
        const deptName = entry.department || "";

        // applicable policies for this entry = global + this dept
        const bucket = [];
        for (const trig of AUTO_TRIGGERS) {
          if (globalByTrigger[trig]) bucket.push(...globalByTrigger[trig]);
          if (deptByTrigger[deptName] && deptByTrigger[deptName][trig])
            bucket.push(...deptByTrigger[deptName][trig]);
        }

        for (const policy of bucket) {
          if (!matches(entry, policy)) continue;
          const key = `${bid}|${day.dateStr}|${policy._id}`;
          if (appliedSet.has(key)) continue;

          const emp = empByBid.get(bid);
          suggestions.push({
            biometricId: bid,
            employeeName: emp
              ? `${emp.firstName || ""} ${emp.lastName || ""}`.trim() ||
                entry.employeeName ||
                bid
              : entry.employeeName || bid,
            department: deptName,
            date: day.dateStr,
            policyId: policy._id,
            policyName: policy.name,
            category: policy.category || "C4",
            points: policy.points,
            triggerKey: policy.triggerKey,
            reason: reasonFor(entry, policy),
            statusSource: entry.hrFinalStatus
              ? "hr_final"
              : "system_prediction",
          });
        }
      }
    }

    // newest date first, then by employee name
    suggestions.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return a.employeeName.localeCompare(b.employeeName);
    });

    res.json({
      success: true,
      from,
      to,
      count: suggestions.length,
      suggestions,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// APPLY — accept one suggestion → write a credit bleach into Employee.sopPoints
// POST /api/hr/policy/apply
// body: { targetEmployeeId, policyId, date, reason?, cutByName?, cutByRole? }
//
// Mirrors the mechanics of hrSopRoutes POST /bleach exactly.
// ═════════════════════════════════════════════════════════════════════════════
router.post("/apply", verifyHRToken, async (req, res) => {
  try {
    const { targetEmployeeId, policyId, date, reason, cutByName, cutByRole } =
      req.body;

    if (!targetEmployeeId || !policyId || !date)
      return res
        .status(400)
        .json({ error: "targetEmployeeId, policyId and date are required." });

    const policy = await Policy.findById(policyId).lean();
    if (!policy) return res.status(404).json({ error: "Policy not found." });

    const employee = await Employee.findOne({ biometricId: targetEmployeeId });
    if (!employee)
      return res.status(404).json({ error: "Employee not found." });

    const year = Number(String(date).slice(0, 4)) || new Date().getFullYear();

    // Dedup — never record the same policy violation twice for one date.
    const already = (employee.sopPoints || []).some((yp) =>
      (yp.bleaches || []).some(
        (b) => String(b.policyId) === String(policyId) && b.date === date,
      ),
    );
    if (already)
      return res.status(409).json({
        error:
          "This policy has already been recorded for this employee on this date.",
      });

    const isReward = policy.bleachType === "debit";
    const isPresenceReward =
      isReward && policy.triggerKey === "present_on_time";

    let points;
    let rateNote = "";
    let taskIdMarker = null;
    if (isPresenceReward) {
      // Manual BACKFILL of the daily base point for one day the auto engine
      // missed. Points come LIVE from C4 Settings so a backfill always writes
      // exactly what the engine would have. Cross-dedup via the engine's own
      // "c4_presence" marker — neither side can double-credit a day.
      const cfg = await C4Config.getSingleton();
      points = Number(cfg.basePointsPerDay) || 0;
      if (!(points > 0))
        return res.status(400).json({
          error:
            "basePointsPerDay is 0 in C4 Settings — set the base point first.",
        });
      const alreadyCredited = (employee.sopPoints || []).some((yp) =>
        (yp.bleaches || []).some(
          (b) => b.taskId === "c4_presence" && b.date === date,
        ),
      );
      if (alreadyCredited)
        return res.status(409).json({
          error: `This day (${date}) is already credited — by the auto engine or a previous manual apply.`,
        });
      taskIdMarker = "c4_presence";
      rateNote = ` — manual backfill of the daily base point (${date})`;
    } else {
      points = Number(policy.points) || 0;
      if (!(points > 0))
        return res.status(400).json({
          error:
            "This policy has 0 points — nothing would be applied. Set a points value on the policy first.",
        });
    }
    // Penalty (credit) ADDS to the penalty score; reward (debit) SUBTRACTS.
    const signedDelta = isReward ? -points : points;

    const bleach = {
      sopId: null,
      policyId: policy._id,
      type: policy.category || "C4",
      sopName: policy.name,
      folderName:
        policy.scope === "department"
          ? policy.departmentName || "Department"
          : "Company-wide",
      points,
      description:
        ((reason && reason.trim()) || policy.description || policy.name) +
        rateNote,
      date,
      bleachType: isReward ? "debit" : "credit",
      isCredit: isReward,
      taskId: taskIdMarker, // "c4_presence" for backfills; null otherwise
      cutBy: "",
      cutByName: cutByName || "HR Manager",
      cutByRole: cutByRole || "hr_manager",
      recheck: {
        status: "none",
        requestedAt: null,
        requestNote: "",
        reviewedBy: null,
        reviewedByName: null,
        reviewedAt: null,
        reviewNote: "",
      },
    };

    const idx = employee.sopPoints.findIndex((sp) => sp.year === year);
    if (idx >= 0) {
      employee.sopPoints[idx].bleaches.push(bleach);
      employee.sopPoints[idx].totalDeducted = +(
        (employee.sopPoints[idx].totalDeducted || 0) + signedDelta
      ).toFixed(2);
    } else {
      employee.sopPoints.push({
        year,
        totalDeducted: signedDelta,
        bleaches: [bleach],
      });
    }

    await employee.save();
    const who = employee.firstName || targetEmployeeId;
    res.status(201).json({
      success: true,
      message: isReward
        ? `${points} pt(s) awarded to ${who} for "${policy.name}".`
        : `${points} pt(s) deducted from ${who} for "${policy.name}".`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
