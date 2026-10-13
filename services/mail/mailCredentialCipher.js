"use strict";

const crypto = require("crypto");

function keyFromEnv() {
  const raw = String(process.env.MAIL_CREDENTIAL_ENCRYPTION_KEY || "").trim();
  // Local/current deployments already have a stable encryption root for
  // salary data. An explicit derive marker lets Mail use a domain-separated
  // child key without copying that secret into another env value or using the
  // salary cipher key directly. Production may replace this with an independent
  // 64-hex Mail key at any time before connections are created.
  if (raw === "derive:SALARY_ENCRYPTION_KEY") {
    const root = String(process.env.SALARY_ENCRYPTION_KEY || "");
    if (root.length < 32) {
      const err = new Error("SALARY_ENCRYPTION_KEY is not available for Mail key derivation");
      err.code = "MAIL_ENCRYPTION_NOT_CONFIGURED";
      throw err;
    }
    return Buffer.from(crypto.hkdfSync(
      "sha256",
      Buffer.from(root, "utf8"),
      Buffer.from("grav-mail-credential-root-v1", "utf8"),
      Buffer.from("gmail-refresh-token", "utf8"),
      32,
    ));
  }
  if (!/^[a-fA-F0-9]{64}$/.test(raw)) {
    const err = new Error("MAIL_CREDENTIAL_ENCRYPTION_KEY must be a 64-character hex key or an approved derive marker");
    err.code = "MAIL_ENCRYPTION_NOT_CONFIGURED";
    throw err;
  }
  return Buffer.from(raw, "hex");
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFromEnv(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    keyVersion: 1,
  };
}

function decrypt(value) {
  if (!value?.ciphertext || !value?.iv || !value?.tag) throw new Error("Invalid encrypted credential");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    keyFromEnv(),
    Buffer.from(value.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function isConfigured() {
  try {
    keyFromEnv();
    return true;
  } catch {
    return false;
  }
}

module.exports = { encrypt, decrypt, isConfigured };
