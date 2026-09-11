// verifyRegularizationRules.js
//
// A client visit is Present. A day claimed as Present comes with its hours.
//
// Run:  node -r dotenv/config verifyRegularizationRules.js
//
// ── WHAT THIS IS ABOUT ──────────────────────────────────────────────────────
// Two rules were added to the regularisation form in the app:
//
//   1. "Client visit" no longer asks what the day should have been. Somebody
//      out seeing a customer was PRESENT — there is no other answer — so the
//      form sends P rather than making a person pick it from a list of six.
//
//   2. "Wrong status" asks for IN and OUT times when the status claimed is
//      Present, Present (late) or Present (early). Being marked present is a
//      claim about WHEN somebody was here; without the hours the applier has
//      to invent them. Half day, work from home and comp off are decisions
//      about what a day COUNTS as, so they are not asked.
//
// The form is in the app, but the rules only hold if the SERVER accepts what
// the form now sends and the applier writes it. That is what this checks —
// the form's own behaviour is checked by scripts/check-regularize-rules.js in
// the app repo. Two halves of one feature, each tested where it lives.
//
// IT WRITES, AND PUTS EVERYTHING BACK: requests it creates are deleted again,
// including on a crash.

"use strict";

const mongoose = require("mongoose");

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass += 1; console.log(`  ok    ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? ` -- ${d}` : ""}`); }
};

/* Every request this file creates carries this in its reason, and cleanup
   deletes BY THAT MARKER rather than by ids collected during the run. Ids
   collected from a response depend on its shape; the marker does not, and the
   first version of this harness left a row behind precisely because the id it
   captured was undefined. */
/* Deliberately free of regex metacharacters. The first version wrapped the
   harness name in parentheses and escaped them for the lookup — and one lost
   backslash turned "(verifyRegularizationRules)" into a capture group, so the
   marker never matched, the read-back reported a working feature as broken,
   and cleanup deleted nothing. A marker that needs no escaping cannot fail
   that way. */
const MARKER = "AUTOMATED-CHECK-verifyRegularizationRules";
const COLLECTION = "regularizationrequests";

async function cleanUp() {
  if (mongoose.connection.readyState !== 1) return "not connected — nothing removed";
  const r = await mongoose.connection.db
    .collection(COLLECTION)
    .deleteMany({ reason: { $regex: MARKER } });
  return `removed ${r.deletedCount} test request(s)`;
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  console.log(`\nconnected to ${mongoose.connection.name}\n`);

  const Employee = require("./models/Employee");
  require("./routes/Employee_Routes/regularization");

  /* ── what the server is willing to accept ───────────────────────────── */
  console.log("the statuses an employee may ask for");
  const src = require("fs").readFileSync(
    "routes/Employee_Routes/regularization.js", "utf8",
  );
  const allowed = (src.match(/const ALLOWED_STATUS = \[(.*?)\]/s) || [])[1] || "";
  check('"P" is accepted — a client visit depends on it', /"P"/.test(allowed), allowed);
  check('"P*" and "P~" are accepted', /"P\*"/.test(allowed) && /"P~"/.test(allowed));
  check("leave codes are NOT — those go through the leave module",
    !/L-CL|L-SL|L-EL/.test(allowed));

  console.log("\na requestedStatus is accepted on ANY type, not only wrong_status");
  /* The client-visit rule sends requestedStatus on a `client_visit` request.
     If the route only honoured it for `wrong_status`, the day would be
     approved and then land as nothing. */
  const elseBranch = src.slice(src.indexOf('if (type === "wrong_status")'));
  check("the non-wrong_status branch validates rather than discards",
    /else if \(requestedStatus && !ALLOWED_STATUS\.includes\(requestedStatus\)\)/.test(elseBranch));

  console.log("\nthe applier writes whatever status the request carries");
  const applier = require("fs").readFileSync(
    "routes/HrRoutes/Attendance_section.js", "utf8",
  );
  check("hrFinalStatus is set from requestedStatus, whatever the type",
    /if \(r\.requestedStatus\) emp\.hrFinalStatus = r\.requestedStatus;/.test(applier));
  check("and it is not gated on type === wrong_status",
    !/type === "wrong_status"[\s\S]{0,120}hrFinalStatus/.test(applier));

  /* ── the round trip, against the real route ─────────────────────────── */
  console.log("\na client visit, filed for real");
  const emp = await Employee.findOne({ isActive: true, employmentType: { $ne: "intern" } })
    .select("_id firstName lastName biometricId").lean();
  check("found an employee to file as", Boolean(emp), emp ? emp.biometricId : "none");

  if (emp) {
    /* A REAL token, not a stubbed req.user. AllEmployeeAppMiddleware is
       attached per-route inside the router, so an upstream stub never runs
       and every request came back 401 — which also made the "is it refused?"
       checks below pass for the wrong reason. Signing a token exercises the
       actual path the app uses. */
    const jwt = require("jsonwebtoken");
    const token = jwt.sign(
      { id: String(emp._id), employeeId: emp.biometricId, userType: "employee" },
      process.env.JWT_SECRET,
      { expiresIn: "10m" },
    );

    const express = require("express");
    const app = express();
    app.use(express.json());
    app.use("/regularizations", require("./routes/Employee_Routes/regularization"));
    const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}/regularizations`;

    /* A date far enough back to be settled, and unique per run so a rerun
       does not collide with its own leftovers. */
    const d = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);

    try {
      const post = (body) =>
        fetch(base, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        });

      /* A refusal has to be refused for the RIGHT reason. Asserting only
         `status >= 400` let three checks pass against a 401 — the route was
         never reached and the rules were never tested. */
      const refusedBecause = async (res, ...codes) => {
        const b = await res.json().catch(() => ({}));
        return {
          ok: res.status >= 400 && res.status !== 401 &&
              (!codes.length || codes.includes(b.code)),
          detail: `${res.status} ${b.code || ""} ${b.message || ""}`.trim(),
        };
      };

      const cv = await post({
        dateStr: d, type: "client_visit",
        reason: `${MARKER} — client visit defaults to Present`,
        requestedStatus: "P",
      });
      const cvBody = await cv.json();
      check("the server accepts a client visit carrying P",
        cv.status < 400 && cvBody.success !== false,
        `${cv.status} ${JSON.stringify(cvBody).slice(0, 150)}`);
      /* Read back from the collection the route actually writes to.
         `regularizations` does not exist — the model is RegularizationRequest,
         so it is `regularizationrequests`, and looking in the wrong place made
         a working feature report as broken. */
      const stored = await mongoose.connection.db
        .collection(COLLECTION)
        .findOne({ reason: { $regex: `${MARKER}.*client visit` } });
      check("and stores it as requestedStatus P",
        stored ? stored.requestedStatus === "P" : false,
        stored ? String(stored.requestedStatus) : "not found");
      check("under the client_visit type, not disguised as wrong_status",
        stored ? stored.type === "client_visit" : false,
        stored ? stored.type : "-");

      console.log("\nwhat the server refuses");
      const noStatus = await refusedBecause(
        await post({
          dateStr: d, type: "wrong_status",
          reason: `${MARKER} — wrong status with no status`,
        }),
        "STATUS_REQUIRED",
      );
      check("wrong_status with no status is refused", noStatus.ok, noStatus.detail);

      const badStatus = await refusedBecause(
        await post({
          dateStr: d, type: "wrong_status", requestedStatus: "L-CL",
          reason: `${MARKER} — leave code through the wrong door`,
        }),
        "BAD_STATUS",
      );
      check("a leave code is refused (it must go through Leave)",
        badStatus.ok, badStatus.detail);

      const badTime = await refusedBecause(
        await post({
          dateStr: d, type: "miss_punch", inTime: "18:00", outTime: "09:00",
          reason: `${MARKER} — reversed times`,
        }),
        "BAD_RANGE",
      );
      check("OUT before IN is refused", badTime.ok, badTime.detail);
    } finally {
      await new Promise((r) => server.close(r));
      console.log(`  ${await cleanUp()}`);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("\nharness crashed:", e.message, (e.stack || "").split("\n")[1] || "");
  try { console.error("cleanup:", await cleanUp()); } catch (err) {
    console.error(`CLEANUP FAILED — remove rows whose reason contains "${MARKER}":`, err.message);
  }
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
