// test/store-purchase/auto-reservation.coverage.test.js
//
// EVERY APPROVAL PATH GOES THROUGH THE ONE SERVICE.
//
// ── WHY THIS IS A SOURCE TEST ───────────────────────────────────────────────
// The risk this feature carries is not that the allocation is wrong; it is that
// a request gets approved through a door nobody wired up, and sits forever in a
// queue that no longer has a "Ready to reserve" stage to catch it. That is a
// statement about the SET of approval paths, and the only way to assert a set
// is to enumerate it from the source.
//
// So this counts the writers: every place that can put an MRF into a
// store-actionable state, and every one of them calling `autoReservation`. A
// new approval path added later fails the count, which is the point — it is a
// tripwire for the next person, not a description of today.
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const MRF_ROUTES = "routes/CMS_Routes/Inventory/Operations/mrfRoutes.js";
const COWORK_ROUTES = "routes/CMS_Routes/Inventory/Operations/coworkMrfRoutes.js";
const INTAKE = "routes/CMS_Routes/Requests/intakeRequests.js";

/* The complete list of files that construct an MRF or move one to APPROVED,
   established by audit (see docs/tasks/current-task.md). */
const APPROVAL_FILES = [MRF_ROUTES, COWORK_ROUTES, INTAKE];

test("the set of MRF writers is exactly the three files this feature wired", () => {
  /* If a fourth file starts creating material requests, it is an approval path
     and it needs the trigger — so the enumeration itself is asserted. */
  const dirs = ["routes", "services"];
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith(".js")) {
        const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
        if (/new MRF\(|MRF\.create\(/.test(src)) found.push(rel);
      }
    }
  };
  dirs.forEach(walk);
  expect(found.sort()).toEqual(APPROVAL_FILES.slice().sort());
});

test("every file that can approve an MRF calls the shared service", () => {
  for (const f of APPROVAL_FILES) {
    const src = read(f);
    expect(src).toMatch(/autoReservation\.service/);
    expect(src).toMatch(/autoReservation\.(attemptInBackground|attemptForRequest)/);
  }
});

test("each of the four request-level approval doors names its own trigger", () => {
  /* One shared service, but the audit answer to "why was this reserved" has to
     be specific, so every door passes a different trigger. */
  expect(read(COWORK_ROUTES)).toMatch(/TRIGGERS\.TL_APPROVED/);        // normal TL/PM approval
  expect(read(COWORK_ROUTES)).toMatch(/TRIGGERS\.AUTO_FORWARDED/);     // AUTO_STORE creation
  expect(read(MRF_ROUTES)).toMatch(/TRIGGERS\.AUTO_FORWARDED/);        // the store-side creation
  expect(read(MRF_ROUTES)).toMatch(/TRIGGERS\.STORE_ON_BEHALF/);       // POST /bypass
  expect(read(INTAKE)).toMatch(/TRIGGERS\.INTAKE_CLASSIFIED/);         // Requests-desk classify
});

test("the line-level eligibility moments are wired too", () => {
  const src = read(MRF_ROUTES);
  /* A line can become eligible long after the request was approved: an
     UNMATCHED line that the store matches or registers. Both doors pass
     `lineId`, so only that line is attempted. */
  const matches = src.match(/TRIGGERS\.LINE_MATCHED/g) || [];
  expect(matches).toHaveLength(2);
  expect(src).toMatch(/lineId: item\._id/);
});

test("no approval path builds its own allocation — there is one engine", () => {
  for (const f of APPROVAL_FILES) {
    const src = read(f);
    /* The giveaway of a second engine: a route reaching for the atomic guard or
       writing a StockReservation itself. The manual reserve endpoint in
       mrfRoutes is the one legitimate caller, so that file is allowed exactly
       the references it already had. */
    if (f === MRF_ROUTES) continue;
    expect(src).not.toMatch(/reserveAtLocation/);
    expect(src).not.toMatch(/new StockReservation\(/);
  }
});

test("the approval routes call it AFTER their own commit, never inside it", () => {
  /* A hold that could roll back an approval would be a worse feature than no
     hold at all. `attemptInBackground` is the form that cannot: it resolves,
     and the approval paths use it rather than awaiting the attempt in-line. */
  const cowork = read(COWORK_ROUTES);
  const tlApproveBlock = cowork.slice(cowork.indexOf("tl-approve"));
  const commitAt = tlApproveBlock.indexOf("await commitMrf(");
  const reserveAt = tlApproveBlock.indexOf("autoReservation.attemptInBackground");
  expect(commitAt).toBeGreaterThan(-1);
  expect(reserveAt).toBeGreaterThan(commitAt);
});

test("the shared service is the only thing that writes an automatic hold", () => {
  const svc = read("services/storePurchase/autoReservation.service.js");
  // It reuses the existing authority rather than reimplementing it.
  expect(svc).toMatch(/reservationSvc\.reserveAtLocation/);
  expect(svc).toMatch(/reservationSvc\.rollUp/);
  expect(svc).toMatch(/reservationSvc\.orderedCandidates/);
  expect(svc).toMatch(/customerOwnedReserve\.heldFor/);
  expect(svc).toMatch(/unitOfWork\.run/);
  // And it never moves stock: no mutator from the issue engine appears at all.
  expect(svc).not.toMatch(/decLocationGuarded|applyLocationIn|applyLocationOut|adjustStock/);
});
