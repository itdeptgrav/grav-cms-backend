"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { encrypt, decrypt, isConfigured } = require("./mailCredentialCipher");

test("mail refresh credentials round-trip through authenticated encryption", () => {
  const before = process.env.MAIL_CREDENTIAL_ENCRYPTION_KEY;
  process.env.MAIL_CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  try {
    const stored = encrypt("refresh-token-value");
    assert.equal(decrypt(stored), "refresh-token-value");
    assert.notEqual(stored.ciphertext, "refresh-token-value");
    assert.equal(stored.keyVersion, 1);
  } finally {
    if (before === undefined) delete process.env.MAIL_CREDENTIAL_ENCRYPTION_KEY;
    else process.env.MAIL_CREDENTIAL_ENCRYPTION_KEY = before;
  }
});

test("mail credentials fail closed without a valid 256-bit key", () => {
  const before = process.env.MAIL_CREDENTIAL_ENCRYPTION_KEY;
  process.env.MAIL_CREDENTIAL_ENCRYPTION_KEY = "too-short";
  try {
    assert.equal(isConfigured(), false);
    assert.throws(() => encrypt("secret"), { code: "MAIL_ENCRYPTION_NOT_CONFIGURED" });
  } finally {
    if (before === undefined) delete process.env.MAIL_CREDENTIAL_ENCRYPTION_KEY;
    else process.env.MAIL_CREDENTIAL_ENCRYPTION_KEY = before;
  }
});

test("the approved existing root produces a separate stable Mail key", () => {
  const beforeMail = process.env.MAIL_CREDENTIAL_ENCRYPTION_KEY;
  const beforeRoot = process.env.SALARY_ENCRYPTION_KEY;
  process.env.MAIL_CREDENTIAL_ENCRYPTION_KEY = "derive:SALARY_ENCRYPTION_KEY";
  process.env.SALARY_ENCRYPTION_KEY = "a stable deployment encryption root that is longer than thirty two bytes";
  try {
    const stored = encrypt("mail-refresh-token");
    assert.equal(decrypt(stored), "mail-refresh-token");
    assert.equal(isConfigured(), true);
  } finally {
    if (beforeMail === undefined) delete process.env.MAIL_CREDENTIAL_ENCRYPTION_KEY;
    else process.env.MAIL_CREDENTIAL_ENCRYPTION_KEY = beforeMail;
    if (beforeRoot === undefined) delete process.env.SALARY_ENCRYPTION_KEY;
    else process.env.SALARY_ENCRYPTION_KEY = beforeRoot;
  }
});
