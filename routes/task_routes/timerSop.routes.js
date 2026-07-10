/**
 * backend/routes/task_routes/timerSop.routes.js
 * POST /cowork/timer-sop/evaluate
 * GET  /cowork/timer-sop/accum/:employeeId
 * POST /cowork/timer-sop/test-finalize/:employeeId   (CEO only, testing)
 *
 * FIXES vs the previous version:
 *   1. Both routes looked up Employee by { employeeId }, a non-queryable
 *      virtual — always returned null. Fixed to { biometricId }.
 *   2. POST trusted req.body.employeeId/employeeName — any authenticated
 *      cowork user could ask the server to evaluate a DIFFERENT employee's
 *      record. Now takes the identity from the verified token
 *      (req.coworkUser) instead, same as every other cowork route that
 *      needs "who is calling."
 *
 * ADDED: test-finalize. By design, /evaluate never touches today's total
 * until today's office hours are over — that's the fix for the double-
 * counting bug, not a bug itself. But it means you can't see it work
 * until end of day. This route forces today to finalize regardless of
 * the clock and returns the actual before/after result in the response,
 * so you can confirm the calculation is correct right now. CEO-gated
 * because forcing a day to finalize before it's actually over can dock
 * or credit someone based on hours they were still going to add to —
 * this is a verification tool, not something to wire into any UI button
 * employees can press.
 */
const express = require("express");
const router = express.Router();
const { verifyCoworkToken, verifyEmployeeToken, verifyCeoToken } = require("../../Middlewear/coworkAuth");
const { evaluateTimerSop } = require("../../services/timerSop.service");
const Employee = require("../../models/Employee");

router.post("/timer-sop/evaluate", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        const { employeeId, name: employeeName } = req.coworkUser;
        if (!employeeId) return res.status(400).json({ error: "No employeeId on verified token" });
        if (req.body?.wait === true) {
            // SOP page uses this: wait for finalization, so the page can
            // immediately re-fetch fresh counter values afterward.
            const result = await evaluateTimerSop(employeeId, employeeName || "");
            return res.json(result);
        }
        // Timer pause/commit path: fire async — don't block the pause on this
        evaluateTimerSop(employeeId, employeeName || "").catch(e =>
            console.error("[timerSop route]", e.message)
        );
        res.json({ ok: true });
    } catch (e) {
        console.error("[timerSop route]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET accumulator values for an employee (for display in the SOP page, etc.)
router.get("/timer-sop/accum/:employeeId", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        const emp = await Employee.findOne({ biometricId: req.params.employeeId })
            .select("timerDeficitAccumHrs timerOvertimeAccumHrs lastFinalizedDate");
        if (!emp) return res.status(404).json({ error: "Employee not found" });
        res.json({
            timerDeficitAccumHrs: emp.timerDeficitAccumHrs || 0,
            timerOvertimeAccumHrs: emp.timerOvertimeAccumHrs || 0,
            lastFinalizedDate: emp.lastFinalizedDate || null,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// TEST/ADMIN ONLY — forces today to finalize right now and returns the
// actual result, so you don't have to wait for office hours to end to
// confirm the engine works. CEO-gated on purpose — see file header.
router.post("/timer-sop/test-finalize/:employeeId", verifyCoworkToken, verifyCeoToken, async (req, res) => {
    try {
        const emp = await Employee.findOne({ biometricId: req.params.employeeId }).select("firstName lastName");
        if (!emp) return res.status(404).json({ error: "Employee not found" });
        const name = [emp.firstName, emp.lastName].filter(Boolean).join(" ") || req.params.employeeId;
        const result = await evaluateTimerSop(req.params.employeeId, name, { forceToday: true });
        res.json(result);
    } catch (e) {
        console.error("[timerSop test-finalize]", e.message);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;