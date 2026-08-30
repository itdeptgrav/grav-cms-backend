"use strict";
/**
 * services/taxIdentity.test.js
 *
 * The interesting tests here are the ones that must NOT fire. A validator
 * that flags correct data is worse than none: people learn to click past it,
 * and then it is decoration on the day it is right. So alongside the typos it
 * catches, this pins the legitimate shapes it has to stay quiet about — a One
 * Person Company styled "Private Limited", a company operating outside its
 * state of incorporation, a company that renamed after its PAN was issued.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validateGstin,
  validatePan,
  validateTan,
  validateCin,
  verifyCompanyIdentity,
  gstinChecksumValid,
} = require("./taxIdentity.service");

/* The live GRAV Clothing record. A real, internally consistent set — if the
   validator ever complains about this, it is the validator that is wrong. */
const GRAV = {
  companyName: "GRAV CLOTHING PVT LTD",
  gstin: "21AAMCG0739M1ZH",
  pan: "AAMCG0739M",
  cin: "U14101OD2025OPC049369",
  tan: "BBNG03651E",
  address: { state: "Odisha", stateCode: "21", city: "BHUBANESWAR" },
};

test("the real company passes every check, with nothing to say", () => {
  const r = verifyCompanyIdentity(GRAV);
  assert.equal(r.errorCount, 0);
  assert.equal(r.warnCount, 0);
  assert.equal(r.clean, true);
  assert.equal(r.checkedOffline, true);
});

test("nothing entered is not a failure", () => {
  const r = verifyCompanyIdentity({ companyName: "New Co" });
  assert.equal(r.errorCount, 0);
  for (const f of Object.values(r.fields)) assert.equal(f.status, "empty");
});

/* ── GSTIN ─────────────────────────────────────────────────────────────── */

test("the GSTIN check digit catches a single mistyped character", () => {
  assert.equal(gstinChecksumValid("21AAMCG0739M1ZH"), true);

  /* The whole point of a check digit. Change one character, keep the shape
     perfectly valid, and only the arithmetic notices. */
  const typo = "21AAMCG0739M1ZG";
  assert.equal(gstinChecksumValid(typo), false);
  const r = validateGstin(typo);
  assert.equal(r.status, "error");
  assert.match(r.message, /check digit/i);
});

test("a GSTIN of the wrong length says so by number", () => {
  const r = validateGstin("21AAMCG0739M1Z");
  assert.equal(r.status, "error");
  assert.match(r.message, /15 characters; this is 14/);
});

test("a GSTIN reports the state and the PAN it carries", () => {
  const r = validateGstin("21AAMCG0739M1ZH");
  assert.equal(r.status, "ok");
  assert.equal(r.stateCode, "21");
  assert.equal(r.stateName, "Odisha");
  assert.equal(r.embeddedPan, "AAMCG0739M");
});

test("a GSTIN with an unassigned state code is refused", () => {
  /* 88 is not a state. Built so the shape and checksum both pass, leaving the
     state as the only thing wrong. */
  const r = validateGstin("88AAMCG0739M1ZH");
  assert.equal(r.status, "error");
});

test("lowercase and stray spaces are cleaned, not rejected", () => {
  const r = validateGstin("  21aamcg0739m1zh ");
  assert.equal(r.status, "ok");
  assert.equal(r.value, "21AAMCG0739M1ZH");
});

/* ── PAN ───────────────────────────────────────────────────────────────── */

test("PAN shape and holder type are read out", () => {
  const r = validatePan("AAMCG0739M", { companyName: "GRAV CLOTHING PVT LTD" });
  assert.equal(r.status, "ok");
  assert.equal(r.entityCode, "C");
  assert.equal(r.entityType, "Company");
});

test("a PAN with digits and letters swapped is refused", () => {
  assert.equal(validatePan("AAMC0G739M").status, "error");
  assert.equal(validatePan("AAMCG0739").status, "error");
});

test("an impossible holder-type character is refused by name", () => {
  const r = validatePan("AAMZG0739M");
  assert.equal(r.status, "error");
  assert.match(r.message, /not a PAN holder type/i);
});

test("a name-letter mismatch is a WARNING, because renaming is legal", () => {
  const r = validatePan("AAMCG0739M", { companyName: "ZENITH TEXTILES PVT LTD" });
  /* Not an error: the PAN keeps the letter of the name it was issued under,
     so a renamed company legitimately mismatches forever. */
  assert.equal(r.status, "warn");
  assert.match(r.message, /5th character/i);
});

/* ── TAN ───────────────────────────────────────────────────────────────── */

test("a TAN is read for its jurisdiction and name letter", () => {
  const r = validateTan("BBNG03651E", { companyName: "GRAV CLOTHING PVT LTD" });
  assert.equal(r.status, "ok");
  assert.equal(r.jurisdiction, "BBN");
});

test("a TAN whose 4th letter contradicts the name is a warning", () => {
  const r = validateTan("BBNG03651E", { companyName: "ZENITH TEXTILES" });
  assert.equal(r.status, "warn");
});

test("a malformed TAN is refused", () => {
  assert.equal(validateTan("BBN03651E").status, "error");
  assert.equal(validateTan("BBNG0365AE").status, "error");
});

/* ── CIN ───────────────────────────────────────────────────────────────── */

test("a CIN is decoded into class, state and year", () => {
  const r = validateCin("U14101OD2025OPC049369", { companyName: "GRAV CLOTHING PVT LTD" });
  assert.equal(r.status, "ok");
  assert.equal(r.listing, "Unlisted");
  assert.equal(r.stateLetters, "OD");
  assert.equal(r.stateName, "Odisha");
  assert.equal(r.year, 2025);
  assert.equal(r.ownershipCode, "OPC");
});

test("a One Person Company styled 'Private Limited' is NOT flagged", () => {
  /* An OPC's legal name IS "… (OPC) Private Limited". A class check that did
     not know that would fire on every one-person company in the country —
     which is exactly the kind of false alarm that gets a validator ignored. */
  const r = validateCin("U14101OD2025OPC049369", { companyName: "GRAV CLOTHING PVT LTD" });
  assert.equal(r.status, "ok");
});

test("a public class on a Private Limited name is flagged", () => {
  const r = validateCin("U14101OD2025PLC049369", { companyName: "GRAV CLOTHING PVT LTD" });
  assert.equal(r.status, "warn");
  assert.match(r.message, /Private Limited but the CIN class is PLC/i);
});

test("a listed CIN on a private company is flagged", () => {
  const r = validateCin("L14101OD2025PTC049369", { companyName: "GRAV CLOTHING PVT LTD" });
  assert.equal(r.status, "warn");
  assert.match(r.message, /listed/i);
});

test("an LLPIN in the CIN box is told where it belongs", () => {
  const r = validateCin("AAB-1234", { companyName: "GRAV DESIGNS LLP" });
  assert.equal(r.status, "error");
  assert.match(r.message, /LLPIN/);
  assert.match(r.message, /leave this blank/i);
});

test("a bad registrar state or class is refused by name", () => {
  assert.match(validateCin("U14101ZZ2025PTC049369").message, /registrar-of-companies state/i);
  assert.match(validateCin("U14101OD2025XYZ049369").message, /company-class code/i);
});

/* ── the checks that need two fields ───────────────────────────────────── */

test("a GSTIN and PAN describing different companies is an ERROR", () => {
  /* The single most valuable check here. Both values are individually
     flawless; only the comparison shows one of them is another company's. */
  const r = verifyCompanyIdentity({
    ...GRAV,
    pan: "AABCT1332L",
  });
  const hit = r.findings.find((f) => f.fields.includes("gstin") && f.fields.includes("pan"));
  assert.ok(hit, "expected a GSTIN/PAN mismatch finding");
  assert.equal(hit.severity, "error");
  assert.equal(r.errorCount >= 1, true);
});

test("an empty PAN beside a valid GSTIN is offered the answer, not an error", () => {
  const r = verifyCompanyIdentity({ ...GRAV, pan: "" });
  const hit = r.findings.find((f) => f.severity === "info" && f.fields.includes("pan"));
  assert.ok(hit);
  assert.equal(hit.suggestion.pan, "AAMCG0739M");
  assert.equal(r.errorCount, 0);
});

test("an address in a different state from the GSTIN is a warning", () => {
  const r = verifyCompanyIdentity({
    ...GRAV,
    address: { state: "Maharashtra", stateCode: "27" },
  });
  const hit = r.findings.find((f) => f.fields.includes("address.stateCode"));
  assert.ok(hit);
  assert.equal(hit.severity, "warn");
});

test("a missing state code is offered the one the GSTIN carries", () => {
  const r = verifyCompanyIdentity({ ...GRAV, address: { state: "Odisha" } });
  const hit = r.findings.find((f) => f.suggestion && f.suggestion["address.stateCode"]);
  assert.ok(hit);
  assert.equal(hit.suggestion["address.stateCode"], "21");
});

test("Orissa and Odisha are the same place", () => {
  /* Real address fields carry both spellings; flagging one as a mismatch
     would be a validator failing on its own data. */
  const r = verifyCompanyIdentity({ ...GRAV, address: { state: "Orissa" } });
  assert.equal(r.findings.some((f) => f.severity === "warn"), false);
});

test("a company registered in one state and operating in another is a note, not an error", () => {
  const r = verifyCompanyIdentity({
    ...GRAV,
    cin: "U14101MH2025OPC049369",
  });
  const hit = r.findings.find((f) => f.fields.includes("cin") && f.fields.includes("gstin"));
  assert.ok(hit);
  assert.equal(hit.severity, "warn");
  assert.equal(r.errorCount, 0);
});

test("a CIN beside a non-company PAN is an error", () => {
  /* A registered company's PAN must say Company. There is no legitimate case
     where a CIN sits next to an individual's PAN. */
  const r = verifyCompanyIdentity({
    ...GRAV,
    gstin: "",
    pan: "AAMPG0739M",
  });
  const hit = r.findings.find((f) => f.fields.includes("pan") && f.fields.includes("cin"));
  assert.ok(hit);
  assert.equal(hit.severity, "error");
});

test("the result never claims the registration exists", () => {
  const r = verifyCompanyIdentity(GRAV);
  /* Everything here is arithmetic on the identifiers. Nothing asked a
     government API, so nothing may imply it did. */
  assert.equal(r.checkedOffline, true);
  assert.equal("verified" in r, false);
});
