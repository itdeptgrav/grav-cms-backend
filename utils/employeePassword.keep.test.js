"use strict";
/* A default sign-in never replaces a password that is set (12 Oct 2026):
   HR set a password through "forgot password" and it was overwritten
   whenever anybody signed in with the phone or name+DOB default. */
const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { matchesEmployeePassword } = require("./employeePassword");

const base = { firstName: "rahul", dateOfBirth: new Date("1999-04-07T00:00:00Z"), phone: "9876543210" };

test("HR-set password signs in, no upgrade", async () => {
  const e = { ...base, password: await bcrypt.hash("Hr@Set123", 10) };
  assert.deepEqual(await matchesEmployeePassword(e, "Hr@Set123"), { ok: true, via: "hash", needsUpgrade: false });
});

test("a DEFAULT sign-in over a set password does NOT ask to overwrite it", async () => {
  const e = { ...base, password: await bcrypt.hash("Hr@Set123", 10) };
  const phone = await matchesEmployeePassword(e, "9876543210");
  assert.equal(phone.ok, true);
  assert.equal(phone.needsUpgrade, false);
  const nameDob = await matchesEmployeePassword(e, "Rahul@04071999");
  assert.equal(nameDob.ok, true);
  assert.equal(nameDob.needsUpgrade, false);
});

test("an account with NO password still converts on its first default sign-in", async () => {
  assert.equal((await matchesEmployeePassword({ ...base, password: "" }, "9876543210")).needsUpgrade, true);
});

test("legacy plain text still converts", async () => {
  assert.deepEqual(await matchesEmployeePassword({ ...base, password: "plain1" }, "plain1"), { ok: true, via: "plaintext", needsUpgrade: true });
});
