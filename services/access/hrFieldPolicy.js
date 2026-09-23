"use strict";
/**
 * services/access/hrFieldPolicy.js — server-owned field allowlists for HR
 * responses.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * ------------------------------------
 * A directory endpoint stays safe even when the caller asks for more. Adding
 * `?fields=salary`, `?select=bankDetails` or `?include=documents` to a request
 * must not widen the response, because the list of fields is decided HERE from
 * the caller's capabilities and never from anything the browser sent.
 *
 * ALLOWLIST, NOT DENYLIST
 * -----------------------
 * Employee has ~80 top-level fields and grows. A denylist protects the fields
 * somebody remembered; an allowlist protects the field added next week by
 * default. So each class NAMES what may leave the server, and everything
 * unnamed is withheld.
 *
 * THREE CLASSES, MATCHING THE PLAN
 * --------------------------------
 *   directory   — who somebody is at work: name, photo, department, manager
 *   private     — personal identity: contact, address, family, birth, documents
 *   restricted  — compensation, banking, statutory identifiers, medical
 *
 * `NEVER_EXPOSE` sits outside the classes. Those fields leave the server in no
 * response, no audit entry and no log line, at any capability, ever.
 */

const { CAPABILITIES } = require("./hrCapabilities");

/* ── Never, at any capability ────────────────────────────────────────────────
 *
 * Credential material and push/device identifiers. `temporaryPassword` is the
 * one people forget: it is a plaintext column on Employee written by HR's
 * password reset, and returning it in an employee detail response would hand
 * every HR reader a working credential for that account.
 */
const NEVER_EXPOSE = Object.freeze([
  "password",
  "temporaryPassword",
  "fcmToken",
  "pushToken",
  "__v",
]);

/* Nested paths that are never exposed either. Kept separate because pruning a
   nested key is a different operation from dropping a top-level one. */
const NEVER_EXPOSE_PATHS = Object.freeze([]);

/* ── Credential material, by every name it travels under ─────────────────────
 *
 * Separate from NEVER_EXPOSE because those are Employee FIELDS and feed the
 * mongoose projection; these are RESPONSE keys, invented by whichever handler
 * assembled the payload. `newPassword` is the one that mattered: the bulk
 * password reset built its own result rows and put the plaintext of every
 * account it had just reset into each one, and no Employee-field denylist was
 * ever going to see it.
 *
 * `temporaryPassword` is in both lists. As a stored plaintext column on
 * Employee it must never ride along in a record read; as the output of the one
 * operation that generates a one-time credential it is the point, and that
 * single declaration opts in by name (`credentialDelivery`).
 */
const CREDENTIAL_KEYS = Object.freeze([
  "password",
  "passwordHash",
  "temporaryPassword",
  "newPassword",
  "confirmPassword",
  "currentPassword",
  "oldPassword",
  "defaultPassword",
  "plainPassword",
  "plaintextPassword",
  "generatedPassword",
  "resetPassword",
]);

/* ── Directory ───────────────────────────────────────────────────────────────
 * Safe for anybody who may open HR at all, and the only class an employee's
 * colleague ever sees. Work contact only: `phone` is personal and lives in the
 * private class, `workPhone`/`extension` are the company's own numbers.
 */
const DIRECTORY_FIELDS = Object.freeze([
  "_id",
  "biometricId",
  "identityId",
  "employeeId",
  "title",
  "firstName",
  "middleName",
  "lastName",
  "nickName",
  "profilePhoto",
  "email",
  "workPhone",
  "extension",
  "department",
  "departmentId",
  "designation",
  "jobTitle",
  "jobPosition",
  "primaryManager",
  "secondaryManager",
  "workLocation",
  "shift",
  "workShift",
  "employmentType",
  "dateOfJoining",
  "status",
  "isActive",
  "isDirector",
  "needsToOperate",
  "createdAt",
  "updatedAt",
]);

/* ── Private HR ──────────────────────────────────────────────────────────────
 * Everything in directory, plus the personal identity an HR operations user
 * needs to do the job. Statutory identifiers are NOT here — they are restricted
 * even though they live in the same `documents` sub-document, which is why this
 * file prunes by path and not only by top-level key.
 */
const PRIVATE_FIELDS = Object.freeze([
  ...DIRECTORY_FIELDS,
  "phone",
  "alternatePhone",
  "personalEmail",
  "address",
  "addressCustomFields",
  "dateOfBirth",
  "placeOfBirth",
  "gender",
  "maritalStatus",
  "marriageDate",
  "spouseName",
  "spouseDOB",
  "fatherFirstName",
  "fatherMiddleName",
  "fatherLastName",
  "fatherDateOfBirth",
  "motherFirstName",
  "motherMiddleName",
  "motherLastName",
  "nationality",
  "countryOfOrigin",
  "isInternational",
  "religion",
  "residentialStatus",
  "personalCustomFields",
  "workCustomFields",
  "documentCustomFields",
  "fieldsNotAvailable",
  "documents",
  "confirmationDate",
  "probationPeriod",
  "internship",
  "accessDepartmentId",
  "additionalDepartmentIds",
  "coworkEmployeeId",
  "welcomeEmailSent",
  "emailSentAt",
  "createdBy",
  "createdByName",
  "updatedBy",
  "updatedByName",
  "lastFinalizedDate",
]);

/* ── Highly restricted ───────────────────────────────────────────────────────
 * Each entry names its own capability. There is no single "sensitive" gate,
 * because reading somebody's pay and reading somebody's blood group are
 * different decisions with different reviewers.
 */
const RESTRICTED_FIELDS = Object.freeze([
  { path: "salary", capability: CAPABILITIES.COMPENSATION_READ },
  { path: "salaryCustomFields", capability: CAPABILITIES.COMPENSATION_READ },
  { path: "bankDetails", capability: CAPABILITIES.COMPENSATION_READ },

  /* Government / statutory identifiers, inside the `documents` sub-document
     alongside ordinary uploaded files. Pruned by path so the file uploads stay
     available to a private-HR reader while the numbers do not. */
  { path: "documents.aadharNumber", capability: CAPABILITIES.PEOPLE_READ_IDENTIFIERS, statutory: true },
  { path: "documents.panNumber", capability: CAPABILITIES.PEOPLE_READ_IDENTIFIERS, statutory: true },
  { path: "documents.uanNumber", capability: CAPABILITIES.PEOPLE_READ_IDENTIFIERS, statutory: true },
  { path: "documents.passportNumber", capability: CAPABILITIES.PEOPLE_READ_IDENTIFIERS, statutory: true },
  { path: "documents.voterIdNumber", capability: CAPABILITIES.PEOPLE_READ_IDENTIFIERS, statutory: true },
  { path: "documents.drivingLicenseNumber", capability: CAPABILITIES.PEOPLE_READ_IDENTIFIERS, statutory: true },
  { path: "documents.esicNumber", capability: CAPABILITIES.PEOPLE_READ_IDENTIFIERS, statutory: true },
  { path: "documents.pfNumber", capability: CAPABILITIES.PEOPLE_READ_IDENTIFIERS, statutory: true },

  /* Medical / disability. `bloodGroup` is collected for emergencies and
     `isPhysicallyChallenged` is a disability declaration; both are health data
     and neither belongs in a directory response. */
  { path: "bloodGroup", capability: CAPABILITIES.PEOPLE_READ_MEDICAL, medical: true },
  { path: "isPhysicallyChallenged", capability: CAPABILITIES.PEOPLE_READ_MEDICAL, medical: true },

  /* SOP point history — the performance/discipline ledger shown on the HR
     performance page and the CEO employee page. `skills.read` rather than
     `cases.manage`: a confidential grievance file is a different thing from a
     points tally, and gating this at owner level would take a working screen
     away from every HR viewer. */
  { path: "sopPoints", capability: CAPABILITIES.SKILLS_READ },
  { path: "timerDeficitAccumHrs", capability: CAPABILITIES.SKILLS_READ },
  { path: "timerOvertimeAccumHrs", capability: CAPABILITIES.SKILLS_READ },
]);

/** Every field name that must never appear in a directory-class response. */
const RESTRICTED_TOP_LEVEL = Object.freeze([
  ...new Set(RESTRICTED_FIELDS.map((f) => f.path.split(".")[0])),
]);

const CLASSES = Object.freeze({
  DIRECTORY: "directory",
  PRIVATE: "private",
  RESTRICTED: "restricted",
});

/**
 * Which class may this capability set read?
 *
 * Compensation is NOT a class of its own — it is a set of restricted paths
 * inside whichever class the caller already has, because a payroll preparer who
 * may read pay still may not read somebody's home address.
 */
function readClassFor(capabilities) {
  const held = capabilities instanceof Set ? capabilities : new Set(capabilities || []);
  if (held.has(CAPABILITIES.PEOPLE_READ_PRIVATE)) return CLASSES.PRIVATE;
  if (held.has(CAPABILITIES.PEOPLE_READ_DIRECTORY)) return CLASSES.DIRECTORY;
  return null;
}

/** The allowlist for a class. */
function fieldsForClass(cls) {
  if (cls === CLASSES.PRIVATE) return PRIVATE_FIELDS;
  if (cls === CLASSES.DIRECTORY) return DIRECTORY_FIELDS;
  return [];
}

function getPath(obj, path) {
  return path.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function deletePath(obj, path) {
  const parts = path.split(".");
  const last = parts.pop();
  const parent = parts.reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
  if (parent && typeof parent === "object") delete parent[last];
}

/**
 * A mongoose `.select()` string that never LOADS what the caller may not read.
 *
 * The plan's requirement is stronger than "do not serialize it": a restricted
 * value that is loaded has already been decrypted, logged by the driver and
 * held in memory. Passing this to the query keeps it in the database.
 *
 * @param {Iterable<string>} capabilities
 * @returns {string} e.g. "-salary -bankDetails -password"
 */
function excludeSelect(capabilities) {
  const held = capabilities instanceof Set ? capabilities : new Set(capabilities || []);
  const drop = new Set(NEVER_EXPOSE);
  for (const f of RESTRICTED_FIELDS) {
    if (!held.has(f.capability)) drop.add(f.path);
  }
  const cls = readClassFor(held);
  if (cls === CLASSES.DIRECTORY) {
    /* A directory reader also loses every private top-level field. Expressed as
       exclusions rather than an inclusion list so a field added to Employee
       tomorrow is withheld by projectEmployee() below even if this query
       happens to fetch it. */
    for (const f of PRIVATE_FIELDS) {
      if (!DIRECTORY_FIELDS.includes(f)) drop.add(f);
    }
  }
  /* A parent and its own child cannot both appear in a projection — MongoDB
     answers "Path collision at documents" and the whole query fails. A
     directory reader drops `documents` outright AND drops
     `documents.aadharNumber` for want of the identifier capability, so the
     child is redundant the moment the parent is there. */
  const dropped = [...drop];
  const parents = new Set(dropped.filter((f) => !f.includes(".")));
  return dropped
    .filter((f) => !f.includes(".") || !parents.has(f.split(".")[0]))
    .map((f) => `-${f}`)
    .join(" ");
}

/**
 * Reduce one employee document to what this capability set may receive.
 *
 * Accepts a lean object or a mongoose document; always returns a plain object.
 * Unknown fields are DROPPED, not passed through — that is the allowlist.
 *
 * @param {object} doc
 * @param {Iterable<string>} capabilities
 * @param {object} [opts]
 * @param {boolean} [opts.self]  the caller is this employee; see below
 */
function projectEmployee(doc, capabilities, opts = {}) {
  if (!doc || typeof doc !== "object") return doc;
  const source = typeof doc.toObject === "function" ? doc.toObject() : doc;
  const held = capabilities instanceof Set ? capabilities : new Set(capabilities || []);

  /* An employee reading their OWN record sees their private class without an
     HR capability — it is their data. It does NOT extend to the restricted
     class: an employee may see their payslip through the payroll endpoints,
     which apply their own rules, but the raw encrypted compensation block on
     the employee record is not a self-service field. */
  const cls = opts.self ? CLASSES.PRIVATE : readClassFor(held);
  if (!cls) return null;

  const allowed = fieldsForClass(cls);
  const out = {};
  for (const key of allowed) {
    if (source[key] !== undefined) out[key] = source[key];
  }

  /* Restricted paths are added back one at a time, each behind its own
     capability — and ONLY into the private class.
     *
     * The directory class is exactly its allowlist and nothing else. A viewer
     * holds `skills.read` for the performance screen, so an "add it back
     * wherever the capability is held" rule quietly put `sopPoints` and the
     * timer counters into every directory row: fields the directory never
     * declared, arriving because of a capability granted for a different
     * screen. A class means what it says or it means nothing. */
  for (const f of RESTRICTED_FIELDS) {
    const top = f.path.split(".")[0];
    if (!held.has(f.capability)) {
      deletePath(out, f.path);
      continue;
    }
    if (cls !== CLASSES.PRIVATE) {
      /* Directory class: never widened, whatever the caller holds. */
      if (!allowed.includes(top)) deletePath(out, f.path);
      continue;
    }
    if (!allowed.includes(top) && f.path === top) {
      const value = getPath(source, f.path);
      if (value !== undefined) out[top] = value;
    }
  }

  for (const key of NEVER_EXPOSE) delete out[key];
  for (const path of NEVER_EXPOSE_PATHS) deletePath(out, path);

  return out;
}

/**
 * The projection for THIS request, and the safe answer when there isn't one.
 *
 * A route calls `projectFor(req, doc)` rather than reaching for
 * `req.hrAuth.project` directly, so that a handler reached without the contract
 * in front of it — a router mounted somewhere new, a test harness — returns the
 * DIRECTORY class rather than the whole document. Fail closed, and the same
 * line of code covers both cases.
 */
function projectFor(req, docOrDocs, opts = {}) {
  const capabilities =
    req?.hrAuth?.capabilities ||
    /* No contract ran. Grant nothing but the directory read, so the response is
       the narrowest one the policy can produce rather than the widest. */
    new Set([CAPABILITIES.PEOPLE_READ_DIRECTORY]);
  return Array.isArray(docOrDocs)
    ? projectEmployees(docOrDocs, capabilities, opts)
    : projectEmployee(docOrDocs, capabilities, opts);
}

/**
 * The `.select()` string for THIS request, appended to whatever the route
 * already excludes, so a value the caller may not read is never LOADED — and so
 * never decrypted either.
 */
function selectFor(req, baseSelect = "") {
  const held = req?.hrAuth?.capabilities || new Set([CAPABILITIES.PEOPLE_READ_DIRECTORY]);
  return `${baseSelect} ${excludeSelect(held)}`.trim();
}

/** projectEmployee over a list, dropping anything the caller may not see. */
function projectEmployees(docs, capabilities, opts = {}) {
  if (!Array.isArray(docs)) return docs;
  return docs.map((d) => projectEmployee(d, capabilities, opts)).filter(Boolean);
}

/**
 * Strip credential material from anything at all — an audit diff, a log line,
 * a change-history before/after pair.
 *
 * Recursive and shape-agnostic on purpose: audit payloads are arbitrary nested
 * objects assembled by twenty different routers, and a rule that only worked on
 * an Employee document would miss most of them.
 */
function redactSecrets(value, depth = 0) {
  if (depth > 8 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  if (typeof value !== "object") return value;
  if (value instanceof Date) return value;

  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (NEVER_EXPOSE.includes(key)) continue;
    if (/password|passwordhash|secret|token|apikey|api_key|privatekey/i.test(key)) continue;
    out[key] = redactSecrets(v, depth + 1);
  }
  return out;
}

/* ── The response scrub ──────────────────────────────────────────────────────
 *
 * `projectEmployee` is the allowlist, and it is the right tool for a handler
 * that returns an employee. This is the FLOOR underneath it: a small, exact
 * denylist applied to every permitted HR response by Middlewear/hrContract, so
 * that a protected value cannot be serialized to somebody without the
 * capability even by a handler that has not been taught the projection.
 *
 * DELIBERATELY NARROW. It removes only leaf keys that are unambiguously
 * personal protected data, by exact name. A broader rule — anything matching
 * /token|secret/, say — would strip the short-lived link token
 * `/api/hr/documents/:id/link` exists to return, and a caching or shape bug in
 * a permission layer is a permission bug.
 */
const SCRUB_RULES = Object.freeze([
  { keys: ["salary", "salaryCustomFields", "bankDetails"], capability: CAPABILITIES.COMPENSATION_READ },
  {
    keys: [
      "aadharNumber", "panNumber", "uanNumber", "passportNumber",
      "voterIdNumber", "drivingLicenseNumber", "esicNumber", "pfNumber",
    ],
    capability: CAPABILITIES.PEOPLE_READ_IDENTIFIERS,
  },
  { keys: ["bloodGroup", "isPhysicallyChallenged"], capability: CAPABILITIES.PEOPLE_READ_MEDICAL },
]);

/**
 * @param {*} body
 * @param {Iterable<string>} capabilities
 * @param {object} [opts]
 * @param {boolean} [opts.self]  a self-service response: the record IS the
 *   caller's, so the capability rules do not apply to it — an employee reads
 *   their own pay at /api/employee/salary without holding compensation.read.
 *   Credential material is still removed.
 * @param {boolean} [opts.allowCredentialDelivery]  the credential-administration
 *   endpoints, whose whole purpose is to hand a newly generated one-time
 *   password to the authorised administrator who asked for it. Everywhere else
 *   `temporaryPassword` is a stored plaintext column on Employee and must never
 *   ride along in a response.
 */
function scrubResponse(body, capabilities, opts = {}) {
  const held = capabilities instanceof Set ? capabilities : new Set(capabilities || []);
  const drop = new Set([...NEVER_EXPOSE, ...CREDENTIAL_KEYS]);
  /* The one generating operation gets to return the one thing it generated —
     and only that. The stored hash and every other credential name stay
     removed even here. */
  if (opts.allowCredentialDelivery) drop.delete("temporaryPassword");
  if (!opts.self) {
    for (const rule of SCRUB_RULES) {
      if (!held.has(rule.capability)) for (const key of rule.keys) drop.add(key);
    }
  }
  /* `password` is a bcrypt hash wherever it appears and is never deliverable,
     not even on the credential-delivery route. */
  drop.add("password");
  drop.add("passwordHash");

  const walk = (value, depth) => {
    if (depth > 12 || value === null || value === undefined) return value;
    if (typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));

    /* `toJSON` first, and this is the load-bearing line.
     *
     * A handler returns whatever it has: a lean plain object, a mongoose
     * Document, an ObjectId, a Date. Rebuilding those by walking their own
     * enumerable keys turns an ObjectId into `{}` — which serialises as
     * "[object Object]" and quietly corrupts every id in the response — and
     * skips a Document's protected fields entirely, because those live behind
     * its accessors rather than on the instance.
     *
     * Asking for `toJSON()` is exactly what `res.json` is about to do anyway,
     * so this normalises to what would have been SENT, then scrubs that. An
     * ObjectId becomes its hex string, a Date its ISO string, a Document a
     * plain object — and the plain object is the thing with the salary in it. */
    if (typeof value.toJSON === "function") {
      const plain = value.toJSON();
      /* toJSON returning an object again (Document, Buffer) must be walked;
         returning a primitive (ObjectId, Date) is already the answer. */
      return typeof plain === "object" && plain !== null ? walk(plain, depth + 1) : plain;
    }

    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (drop.has(key)) continue;
      out[key] = walk(v, depth + 1);
    }
    return out;
  };

  return walk(body, 0);
}

module.exports = {
  CLASSES,
  CREDENTIAL_KEYS,
  SCRUB_RULES,
  scrubResponse,
  NEVER_EXPOSE,
  DIRECTORY_FIELDS,
  PRIVATE_FIELDS,
  RESTRICTED_FIELDS,
  RESTRICTED_TOP_LEVEL,
  readClassFor,
  fieldsForClass,
  excludeSelect,
  projectEmployee,
  projectEmployees,
  projectFor,
  selectFor,
  redactSecrets,
};
