// services/studio/studioKeys.service.js
//
// THE KEYS GRAV STUDIO SIGNS IN WITH (14 Oct 2026).
//
// GRAV Studio is a desktop app. The owner chose a key per designer, issued by
// an administrator, over the designer's own CMS password: it is typed into the
// app once, kept in the operating system's secure store, and revoked here
// without touching the person's CMS login.
//
//   • A key belongs to ONE person of ONE department (Design / R&D) and ONE
//     company — what a signed-in session of theirs would be scoped to.
//   • Only a SHA-256 of it is stored (AccessDepartment.studioKeys, select:false).
//     The key is returned once, at issue, and never again.
//   • Every use re-checks that the holder still holds a role in the department:
//     removing somebody's grant ends their key the same moment, revoked or not.
//     A department nobody has been granted yet admits the key (the same
//     fail-open rule requireDepartmentRole applies), so a fresh deployment is
//     not locked out before its roles are set.

"use strict";

const crypto = require("crypto");
const AccessDepartment = require("../../models/Access/AccessDepartment");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const { getRole } = require("../departmentRoles");

const DEPARTMENT = "research-development";
const PREFIX = "gsk_";

const hashOf = (key) => crypto.createHash("sha256").update(String(key), "utf8").digest("hex");

function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** A new key: `gsk_` + 32 random bytes, URL-safe. */
function newKey() {
  return PREFIX + crypto.randomBytes(32).toString("base64url");
}

async function department() {
  const dept = await AccessDepartment.findOne({ slug: DEPARTMENT }).select("+studioKeys");
  if (!dept) throw fail(404, "The Design (R&D) department is not set up in this CMS.");
  return dept;
}

/** What an administrator sees of a key: never the hash. */
function publicKey(k) {
  return {
    keyId: k.keyId,
    prefix: k.prefix,
    holder: { email: k.holder?.email || "", name: k.holder?.name || "", employeeId: k.holder?.employeeId || "" },
    label: k.label || "",
    issuedAt: k.issuedAt,
    issuedBy: k.issuedBy?.name || "",
    lastUsedAt: k.lastUsedAt,
    revokedAt: k.revokedAt,
    active: !k.revokedAt,
  };
}

/** Every key of the department, newest first. */
async function listKeys() {
  const dept = await department();
  return (dept.studioKeys || [])
    .map(publicKey)
    .sort((a, b) => new Date(b.issuedAt) - new Date(a.issuedAt));
}

/**
 * Issue a key to one designer. Returns `{ key, record }`; the key is shown to
 * the administrator this once.
 */
async function issueKey({ email, name, employeeId, label, companyId, actor }) {
  const mail = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(mail)) throw fail(400, "Enter the designer's email address.");
  const dept = await department();
  /* The designer must hold a role in Design (R&D) — once any role there has
     been granted at all. */
  const anyRoles = await DepartmentRole.exists({ departmentSlug: DEPARTMENT, isActive: true });
  if (anyRoles && !(await getRole(DEPARTMENT, mail))) {
    throw fail(400, `${mail} has no role in Design (R&D). Grant one first.`);
  }
  const key = newKey();
  const record = {
    keyId: crypto.randomUUID(),
    hash: hashOf(key),
    prefix: key.slice(0, PREFIX.length + 6),
    holder: { email: mail, name: String(name || "").trim(), employeeId: String(employeeId || "").trim() },
    companyId: companyId || undefined,
    label: String(label || "").trim().slice(0, 80),
    issuedAt: new Date(),
    issuedBy: { id: String(actor?.id || ""), name: String(actor?.name || "") },
  };
  dept.studioKeys = [...(dept.studioKeys || []), record];
  await dept.save();
  return { key, record: publicKey(record) };
}

async function revokeKey(keyId, actor) {
  const dept = await department();
  const k = (dept.studioKeys || []).find((x) => x.keyId === keyId);
  if (!k) throw fail(404, "No such key.");
  if (!k.revokedAt) {
    k.revokedAt = new Date();
    k.revokedBy = { id: String(actor?.id || ""), name: String(actor?.name || "") };
    await dept.save();
  }
  return publicKey(k);
}

/**
 * The holder of a key, or a refusal. `{ keyId, holder, companyId }`.
 * `lastUsedAt` is stamped at most once a minute.
 */
async function authenticate(key) {
  const raw = String(key || "").trim();
  if (!raw.startsWith(PREFIX) || raw.length < PREFIX.length + 20) throw fail(401, "This GRAV Studio key is not valid.");
  const hash = hashOf(raw);
  const dept = await AccessDepartment.findOne({ slug: DEPARTMENT, "studioKeys.hash": hash }).select("+studioKeys");
  const k = dept?.studioKeys?.find((x) => x.hash === hash);
  if (!k) throw fail(401, "This GRAV Studio key is not valid.");
  if (k.revokedAt) throw fail(401, "This GRAV Studio key was revoked. Ask an administrator for a new one.");
  const anyRoles = await DepartmentRole.exists({ departmentSlug: DEPARTMENT, isActive: true });
  if (anyRoles && !(await getRole(DEPARTMENT, k.holder.email))) {
    throw fail(403, "This key's holder no longer has a role in Design (R&D).");
  }
  if (!k.lastUsedAt || Date.now() - new Date(k.lastUsedAt).getTime() > 60_000) {
    AccessDepartment.updateOne(
      { _id: dept._id, "studioKeys.keyId": k.keyId },
      { $set: { "studioKeys.$.lastUsedAt": new Date() } },
    ).catch(() => {});
  }
  return {
    keyId: k.keyId,
    holder: { email: k.holder.email, name: k.holder.name || "", employeeId: k.holder.employeeId || "" },
    companyId: k.companyId || null,
  };
}

module.exports = { listKeys, issueKey, revokeKey, authenticate, hashOf, DEPARTMENT, PREFIX };
