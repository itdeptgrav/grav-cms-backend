"use strict";
/**
 * services/partyGstVerification.test.js
 *
 * `verdictFrom` is the whole risk surface of this feature, and it is pure —
 * one lookup in, one stored verdict out — so it is tested directly, with no
 * database and no provider.
 *
 * The verdict is what an accountant will act on. Getting it wrong in the
 * generous direction (calling a cancelled supplier "active") loses input tax
 * credit at assessment. Getting it wrong in the harsh direction (calling a
 * provider outage "not registered") puts a red mark against a company that
 * has done nothing wrong, and the accountant stops trusting the whole column.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { verdictFrom } = require("./partyGstVerification.service");

const ledger = { name: "GRAV CLOTHING PVT LTD" };
const found = (data) => ({ ok: true, found: true, provider: "appyflow", data });

test("an active registration in the ledger's own name passes", () => {
  const v = verdictFrom(ledger, found({ legalName: "GRAV CLOTHING PRIVATE LIMITED", status: "Active" }));
  assert.equal(v.status, "active");
  assert.equal(v.legalName, "GRAV CLOTHING PRIVATE LIMITED");
  assert.ok(v.checkedAt instanceof Date);
});

test("a cancelled supplier is flagged, and the note says what it costs", () => {
  const v = verdictFrom(
    ledger,
    found({ legalName: "GRAV CLOTHING PRIVATE LIMITED", status: "Cancelled", cancelledDate: "31/03/2026" }),
  );
  assert.equal(v.status, "cancelled");
  /* The reason an accountant cares, stated where they will read it — not
     "status: cancelled" and left to them to work out the consequence. */
  assert.match(v.note, /input tax credit/i);
  assert.match(v.note, /31\/03\/2026/);
});

test("suspended and inactive count as cancelled too", () => {
  for (const status of ["Suspended", "Inactive", "CANCELLED"]) {
    assert.equal(verdictFrom(ledger, found({ legalName: "GRAV CLOTHING PRIVATE LIMITED", status })).status, "cancelled");
  }
});

test("a live registration under somebody else's name is its own status", () => {
  const v = verdictFrom(ledger, found({ legalName: "ZENITH TEXTILES PRIVATE LIMITED", status: "Active" }));
  /* Not "active": the registration is fine, the LEDGER is pointing at the
     wrong party — which is exactly the error that puts another company's
     credit on your return. */
  assert.equal(v.status, "mismatch");
  assert.match(v.note, /ZENITH TEXTILES/);
});

test("the same name written differently is not a mismatch", () => {
  for (const registered of [
    "GRAV CLOTHING PRIVATE LIMITED",
    "Grav Clothing Pvt. Ltd.",
    "GRAV CLOTHING (OPC) PRIVATE LIMITED",
  ]) {
    assert.equal(
      verdictFrom(ledger, found({ legalName: registered, status: "Active" })).status,
      "active",
      `${registered} should not read as a mismatch`,
    );
  }
});

test("a trade name counts when there is no legal name", () => {
  const v = verdictFrom(ledger, found({ tradeName: "GRAV CLOTHING", status: "Active" }));
  assert.equal(v.status, "active");
});

test("no registration behind the GSTIN is recorded as not-found", () => {
  const v = verdictFrom(ledger, { ok: true, found: false, provider: "appyflow" });
  assert.equal(v.status, "not-found");
  assert.match(v.note, /no registration/i);
});

/* ── the half that protects innocent parties ───────────────────────────── */

test("a provider outage is NOT a verdict on the party", () => {
  for (const lookup of [
    { ok: false, reason: "timeout" },
    { ok: false, reason: "network" },
    { ok: false, reason: "rate-limited" },
    { ok: false, reason: "auth" },
    null,
  ]) {
    const v = verdictFrom(ledger, lookup);
    /* `unavailable`, never `not-found`. The difference is whether an
       accountant sees a red flag against a supplier who is perfectly
       registered. */
    assert.equal(v.status, "unavailable");
  }
});

test("a sandbox answer is called out by name", () => {
  const v = verdictFrom(ledger, { ok: false, reason: "mismatched-response", provider: "appyflow" });
  assert.equal(v.status, "unavailable");
  /* The exact failure this account hit on its trial key — worth naming so
     nobody debugs it as a data problem. */
  assert.match(v.note, /different GSTIN|sandbox|trial/i);
});

test("no provider configured is unavailable, not a mark against anybody", () => {
  const v = verdictFrom(ledger, { ok: false, reason: "not-configured" });
  assert.equal(v.status, "unavailable");
  assert.match(v.note, /no gst lookup provider/i);
});

test("an unnamed ledger cannot produce a mismatch", () => {
  /* Comparing a registered name against nothing would flag every such
     ledger forever. */
  const v = verdictFrom({ name: "" }, found({ legalName: "ANYTHING AT ALL", status: "Active" }));
  assert.equal(v.status, "active");
});
