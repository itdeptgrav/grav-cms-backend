// test/project-manager/pm-requests-tl-state.route.test.js
//
// Chunk 3A, Phase 0. The MRF TL trail on the Project Manager requests list.
//
// The list mapper published `approverName`, `tlApproved`, `tlApprovedAt`,
// `tlApprovedByName`, `tlRejected`, `tlRejectedAt`, `tlRejectionNote` and
// `autoForwarded` — but the `.select(...)` on the same query never loaded any
// of them, so the lean documents did not carry them and every MRF in the
// response came back as `tlApproved: false, tlRejected: false,
// approverName: ""`, including ones a TL had approved months earlier.
//
// The requests desk could therefore not tell an awaiting request from a decided
// one, and had to infer the state from the lifecycle `status` instead. These
// tests pin the explicit trail so that inference stays a fallback rather than
// the only signal — and, specifically, that a genuine TL decision is reported
// as itself and is never derived from the legacy PM flags, which mean something
// different on an MRF.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || "grav_clothing_secret_key";

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const MRF = require("../../models/CMS_Models/Inventory/Operations/MRF");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // server.js:1625, without the pmWrites guard: every case here is a GET, which
  // that guard passes through untouched.
  app.use("/api/cms/pm/requests", require("../../routes/CMS_Routes/pm/pmRequestsRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/pm/requests`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const token = () =>
  jwt.sign(
    { id: String(new mongoose.Types.ObjectId()), email: `pm${++seq}@test.example`, role: "project_manager", name: "PM" },
    process.env.JWT_SECRET,
    { expiresIn: "10m" },
  );

const list = () =>
  fetch(base, { headers: { Authorization: `Bearer ${token()}` } })
    .then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

/** A material request. `over` sets the TL trail under test. */
async function mrf(over = {}) {
  const n = ++seq;
  return MRF.create({
    mrfNumber: `MRF-${String(n).padStart(4, "0")}`,
    requestedFor: new mongoose.Types.ObjectId(),
    requestedForName: `Requester ${n}`,
    createdByRef: new mongoose.Types.ObjectId(),
    requestType: "TIME_BASED",
    items: [{ rawItemName: `Thread ${n}`, requestedQty: 5, unit: "m" }],
    ...over,
  });
}

const rowFor = (body, number) =>
  body.requests.find((r) => r._type === "mrf" && r.number === number);

describe("MRF TL state reaches the requests list", () => {
  test("an awaiting request reports no decision and names its assigned approver", async () => {
    const m = await mrf({ status: "PENDING", approverName: "Priya TL" });
    const { status, body } = await list();

    expect(status).toBe(200);
    const row = rowFor(body, m.mrfNumber);
    expect(row.approverName).toBe("Priya TL");
    expect(row.tlApproved).toBe(false);
    expect(row.tlRejected).toBe(false);
    expect(row.status).toBe("PENDING");
  });

  test("an approved request reports the approval, when, and by whom", async () => {
    const at = new Date("2026-07-14T06:30:00Z");
    const m = await mrf({
      status: "APPROVED",
      approverName: "Priya TL",
      tlApproved: true,
      tlApprovedAt: at,
      tlApprovedByName: "Priya Nair",
      autoForwarded: true,
    });
    const { body } = await list();
    const row = rowFor(body, m.mrfNumber);

    // The exact failure this fixes: before the select, this was `false`.
    expect(row.tlApproved).toBe(true);
    expect(row.tlRejected).toBe(false);
    expect(new Date(row.tlApprovedAt).toISOString()).toBe(at.toISOString());
    expect(row.tlApprovedByName).toBe("Priya Nair");
    expect(row.autoForwarded).toBe(true);
  });

  test("a rejected request reports the rejection, when, by whom, and why", async () => {
    const at = new Date("2026-08-02T11:00:00Z");
    const m = await mrf({
      status: "REJECTED",
      tlRejected: true,
      tlRejectedAt: at,
      tlRejectedByName: "Anil Rao",
      tlRejectionNote: "Order against the running PO instead.",
    });
    const { body } = await list();
    const row = rowFor(body, m.mrfNumber);

    expect(row.tlRejected).toBe(true);
    expect(row.tlApproved).toBe(false);
    expect(new Date(row.tlRejectedAt).toISOString()).toBe(at.toISOString());
    expect(row.tlRejectedByName).toBe("Anil Rao");
    expect(row.tlRejectionNote).toBe("Order against the running PO instead.");
  });

  test("the TL trail is not derived from the legacy PM flags", async () => {
    // An MRF is decided by the requester's TL, never by the Project Manager. A
    // stale `pmApproved` on an old record is history and must not be read as a
    // TL approval — nor must a real TL approval be reported as a PM decision.
    const m = await mrf({
      status: "PENDING",
      pmApproved: true,
      pmApprovedAt: new Date("2026-01-05T00:00:00Z"),
    });
    const { body } = await list();
    const row = rowFor(body, m.mrfNumber);

    expect(row.pmApproved).toBe(true);      // preserved, unchanged
    expect(row.tlApproved).toBe(false);     // and it decides nothing here
    expect(row.tlRejected).toBe(false);
    expect(row.readOnly).toBe(true);        // no PM action offered on an MRF
  });

  test("every published TL key is present on every MRF row", async () => {
    // A key that silently stops being sent is how the desk lost this the first
    // time: the mapper still named it, so nothing looked wrong.
    await mrf({ status: "PENDING" });
    const { body } = await list();
    const row = body.requests.find((r) => r._type === "mrf");

    for (const key of [
      "approverName", "tlApproved", "tlApprovedAt", "tlApprovedByName",
      "tlRejected", "tlRejectedAt", "tlRejectedByName", "tlRejectionNote",
      "autoForwarded",
    ]) {
      expect(row).toHaveProperty(key);
    }
  });

  test("an anonymous request is still refused", async () => {
    const res = await fetch(base).then(async (r) => ({
      status: r.status, body: JSON.parse((await r.text()) || "null"),
    }));
    expect(res.status).toBe(401);
    expect(res.body).not.toHaveProperty("requests");
  });
});
