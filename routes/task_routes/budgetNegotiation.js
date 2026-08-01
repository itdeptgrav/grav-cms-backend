/**
 * GRAV-CMS-BACKEND/routes/task_routes/budgetNegotiation.js
 *
 * The time-budget negotiation loop: propose a counter, or accept what stands.
 *
 * **There is deliberately no reject route.** A refusal that ends the
 * negotiation leaves work carrying a budget one side never agreed to, which is
 * the state this loop exists to make impossible. Disagreeing means countering.
 *
 * Permission is the TURN, checked in the service inside a transaction — not
 * here. Two concurrent moves would otherwise both pass a check made before
 * either wrote.
 */

const express = require("express");
const {
  verifyCoworkToken,
  verifyEmployeeToken,
} = require("../../Middlewear/coworkAuth");
const svc = require("../../services/budgetNegotiation.service");

const router = express.Router();

/** Map a typed failure onto a status a client can act on. */
function statusFor(code) {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "NOT_A_PARTY":
    case "NOT_YOUR_TURN":
      return 403;
    default:
      return 400;
  }
}

router.post(
  "/task/:taskId/budget/counter",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const { proposedSecs, reason } = req.body;
      const result = await svc.counterBudgetProposal({
        taskId: req.params.taskId,
        employeeId: req.coworkUser.employeeId,
        employeeName: req.coworkUser.name,
        proposedSecs,
        reason,
      });
      res.json({ success: true, ...result });
    } catch (e) {
      console.error("[budget/counter]", e.code || "", e.message);
      res
        .status(statusFor(e.code))
        .json({ error: e.message, code: e.code || "COUNTER_FAILED" });
    }
  },
);

router.post(
  "/task/:taskId/budget/accept",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const result = await svc.acceptBudgetProposal({
        taskId: req.params.taskId,
        employeeId: req.coworkUser.employeeId,
        employeeName: req.coworkUser.name,
      });
      res.json({ success: true, ...result });
    } catch (e) {
      console.error("[budget/accept]", e.code || "", e.message);
      res
        .status(statusFor(e.code))
        .json({ error: e.message, code: e.code || "ACCEPT_FAILED" });
    }
  },
);

module.exports = router;
