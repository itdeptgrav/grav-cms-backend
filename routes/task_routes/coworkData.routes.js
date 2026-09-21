/**
 * `POST /cowork/db` — the browser's one door to the Cowork database.
 *
 * Every read and write the frontend used to make directly against Firestore
 * arrives here instead, as `{ op, path, ... }`, authenticated exactly like every
 * other `/cowork/**` route. The policy — who may read and write what — lives in
 * `services/mongo/dataAccess.js`, where it can be tested without a server.
 *
 * The response for a document is `{ id, exists, data }`; for a query
 * `{ docs: [...] }`. Timestamps inside `data` serialise as
 * `{ _seconds, _nanoseconds }`, which is the same shape a Firestore Timestamp
 * has always had on the wire and what the frontend already parses.
 */

const express = require("express");
const { db } = require("../../config/firebaseAdmin");
const { verifyCoworkToken, verifyEmployeeToken } = require("../../Middlewear/coworkAuth");
const { AccessError, execute } = require("../../services/mongo/dataAccess");

const router = express.Router();

router.post("/db", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  const caller = {
    employeeId: String(req.coworkUser.employeeId),
    role: String(req.coworkUser.role || "employee"),
  };
  try {
    const result = await execute(db, caller, req.body);
    res.json(result);
  } catch (e) {
    if (e instanceof AccessError) {
      return res.status(e.status).json({ error: e.message });
    }
    /* A NOT_FOUND from `update()` on a missing document is what Firestore's
       client SDK would have thrown too; give it the same status. */
    if (e && e.code === 5) return res.status(404).json({ error: e.message });
    console.error("[cowork/db]", e);
    res.status(500).json({ error: "The request could not be completed." });
  }
});

module.exports = router;
