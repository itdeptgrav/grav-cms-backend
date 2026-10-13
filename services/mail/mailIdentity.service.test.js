"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanId, employeeIdOf } = require("./mailIdentity.service");

test("internal mail addresses employee IDs case-insensitively", () => {
  assert.equal(cleanId("  grv-1042 "), "GRV-1042");
});

test("the HR biometric ID is the canonical internal mail address", () => {
  assert.equal(employeeIdOf({ biometricId: " grav-7 ", identityId: "legacy" }), "GRAV-7");
  assert.equal(employeeIdOf({ identityId: " id-9 ", coworkEmployeeId: "cowork" }), "ID-9");
});
