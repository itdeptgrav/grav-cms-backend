"use strict";
/**
 * PROTECTED FIELDS NEVER LEAVE THE SERVER.
 *
 * The allowlist in services/access/hrFieldPolicy.js is the last line: even a
 * caller who reached a permitted endpoint receives only the fields their
 * capabilities allow, and no query parameter can widen that — the field list is
 * derived from the capability set, never from the request.
 *
 * The document under test is a REAL Employee saved through the model, so the
 * salary block is genuinely encrypted by the pre-save hook and the assertions
 * are about what a live record produces rather than a hand-written literal.
 */

const { resetAccessCaches, makeEmployee } = require("./helpers");

const {
  projectEmployee,
  projectEmployees,
  excludeSelect,
  redactSecrets,
  DIRECTORY_FIELDS,
  NEVER_EXPOSE,
  RESTRICTED_FIELDS,
  RESTRICTED_TOP_LEVEL,
} = require("../../services/access/hrFieldPolicy");
const { ROLE_TEMPLATES, CAPABILITIES } = require("../../services/access/hrCapabilities");

/* Every name that must not appear in a directory-class response, whatever
   route produced it. */
const FORBIDDEN_IN_DIRECTORY = [
  "salary", "salaryCustomFields", "bankDetails",
  "password", "temporaryPassword",
  "aadharNumber", "panNumber", "uanNumber", "esicNumber", "pfNumber",
  "passportNumber", "voterIdNumber", "drivingLicenseNumber",
  "bloodGroup", "isPhysicallyChallenged",
  "phone", "personalEmail", "address", "dateOfBirth",
];

let record;

beforeEach(async () => {
  resetAccessCaches();
  record = await makeEmployee({
    biometricId: "GR0099",
    firstName: "Asha",
    lastName: "Rao",
    email: "asha@grav.in",
    workPhone: "0801234",
    designation: "Operator",
    department: "Cutting",
    phone: "9999999999",
    personalEmail: "asha@personal.test",
    dateOfBirth: new Date("1995-04-01"),
    bloodGroup: "O+",
    isPhysicallyChallenged: false,
    address: { current: { street: "1 Road", city: "Bengaluru" } },
    salary: { gross: 45000 },
    bankDetails: { bankName: "SBI", accountNumber: "1234567890", ifscCode: "SBIN0001" },
    documents: {
      aadharNumber: "1111 2222 3333",
      panNumber: "ABCDE1234F",
      uanNumber: "100200300",
      pfNumber: "PF/1",
      esicNumber: "ESI/1",
      resumeFile: { url: "https://example.test/cv.pdf", name: "cv.pdf" },
    },
    password: "$2a$10$hashedhashedhashed",
    temporaryPassword: "Welcome@123",
  });
});

const flatten = (value, out = []) => {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) { value.forEach((v) => flatten(v, out)); return out; }
  if (typeof value === "object" && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value)) { out.push(k); flatten(v, out); }
  }
  return out;
};

describe("11 — a directory response carries no protected field", () => {
  test("an HR viewer receives the directory class and nothing else", () => {
    const out = projectEmployee(record, ROLE_TEMPLATES.hr_viewer);
    const keys = flatten(out);

    for (const forbidden of FORBIDDEN_IN_DIRECTORY) {
      expect({ forbidden, present: keys.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
    /* And it is still a useful directory entry. */
    expect(out.firstName).toBe("Asha");
    expect(out.designation).toBe("Operator");
    expect(out.biometricId).toBe("GR0099");
  });

  test("the CEO/management projection is the directory class too", () => {
    const keys = flatten(projectEmployee(record, ROLE_TEMPLATES.ceo_projection));
    for (const forbidden of FORBIDDEN_IN_DIRECTORY) expect(keys).not.toContain(forbidden);
  });

  test("asking for more does not get more", () => {
    /* The projection takes a capability set and a document. There is deliberately
       no parameter through which a request could name a field, which is why a
       hostile `?fields=salary&select=bankDetails&include=documents` cannot
       widen it: the caller's capabilities are the only input. */
    const asViewer = projectEmployee(record, ROLE_TEMPLATES.hr_viewer);
    const asViewerAgain = projectEmployee(
      { ...record.toObject(), fields: "salary", select: "bankDetails", include: "documents" },
      ROLE_TEMPLATES.hr_viewer,
    );
    expect(Object.keys(asViewerAgain).sort()).toEqual(Object.keys(asViewer).sort());
    expect(asViewerAgain.salary).toBeUndefined();
    expect(asViewerAgain.fields).toBeUndefined();
  });

  test("a list is projected row by row", () => {
    const rows = projectEmployees([record, record], ROLE_TEMPLATES.hr_viewer);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(flatten(row)).not.toContain("salary");
  });
});

describe("the classes step up one capability at a time", () => {
  test("private identity needs people.read.private", () => {
    expect(projectEmployee(record, ROLE_TEMPLATES.hr_viewer).phone).toBeUndefined();
    expect(projectEmployee(record, ROLE_TEMPLATES.hr_editor).phone).toBe("9999999999");
  });

  test("compensation and banking need compensation.read", () => {
    expect(projectEmployee(record, ROLE_TEMPLATES.hr_editor).salary).toBeUndefined();
    expect(projectEmployee(record, ROLE_TEMPLATES.hr_editor).bankDetails).toBeUndefined();

    const approver = projectEmployee(record, ROLE_TEMPLATES.hr_approver);
    expect(approver.salary).toBeDefined();
    expect(approver.bankDetails.accountNumber).toBe("1234567890");
  });

  test("statutory identifiers are pruned out of documents without their capability", () => {
    /* The interesting case: `documents` is ONE sub-document holding both the
       uploaded files a private-HR reader legitimately needs and the government
       numbers they may not have. The projection prunes by path, so the file
       survives and the number does not. */
    const withoutIdentifiers = projectEmployee(record, new Set([
      CAPABILITIES.HR_ACCESS, CAPABILITIES.PEOPLE_READ_DIRECTORY, CAPABILITIES.PEOPLE_READ_PRIVATE,
    ]));
    expect(withoutIdentifiers.documents.resumeFile.url).toBe("https://example.test/cv.pdf");
    expect(withoutIdentifiers.documents.aadharNumber).toBeUndefined();
    expect(withoutIdentifiers.documents.panNumber).toBeUndefined();
    expect(withoutIdentifiers.documents.uanNumber).toBeUndefined();

    const withIdentifiers = projectEmployee(record, ROLE_TEMPLATES.hr_editor);
    expect(withIdentifiers.documents.aadharNumber).toBe("1111 2222 3333");
  });

  test("medical and disability data needs its own capability", () => {
    const noMedical = projectEmployee(record, new Set([
      CAPABILITIES.HR_ACCESS, CAPABILITIES.PEOPLE_READ_DIRECTORY, CAPABILITIES.PEOPLE_READ_PRIVATE,
    ]));
    expect(noMedical.bloodGroup).toBeUndefined();
    expect(noMedical.isPhysicallyChallenged).toBeUndefined();
    expect(projectEmployee(record, ROLE_TEMPLATES.hr_editor).bloodGroup).toBe("O+");
  });

  test("an employee reading their OWN record gets the private class and no pay block", () => {
    const own = projectEmployee(record, ROLE_TEMPLATES.employee_self, { self: true });
    expect(own.phone).toBe("9999999999");
    expect(own.salary).toBeUndefined();
    expect(own.bankDetails).toBeUndefined();
    expect(own.password).toBeUndefined();
  });

  test("someone with no read capability at all receives nothing", () => {
    expect(projectEmployee(record, new Set())).toBeNull();
  });
});

describe("credential material never leaves, at any capability", () => {
  test("not for an owner, not for a platform administrator", () => {
    for (const template of ["hr_owner", "platform_admin"]) {
      const out = projectEmployee(record, ROLE_TEMPLATES[template]);
      for (const secret of NEVER_EXPOSE) {
        expect({ template, secret, present: out[secret] !== undefined })
          .toEqual({ template, secret, present: false });
      }
      /* The one that is easiest to forget: a plaintext reset password sitting
         on the employee record. */
      expect(out.temporaryPassword).toBeUndefined();
      expect(out.password).toBeUndefined();
    }
  });

  test("redactSecrets strips them from an arbitrary audit payload too", () => {
    const before = {
      employee: { firstName: "Asha", password: "hash", temporaryPassword: "Welcome@123" },
      changes: [{ field: "passwordHash", to: "abc" }, { field: "designation", to: "Operator" }],
      meta: { apiKey: "sk-live-xyz", correlationId: "c-1" },
    };
    const after = redactSecrets(before);
    const text = JSON.stringify(after);
    expect(text).not.toMatch(/Welcome@123|hash|sk-live-xyz/);
    expect(after.meta.correlationId).toBe("c-1");
    expect(after.employee.firstName).toBe("Asha");
  });
});

describe("the scrub does not corrupt what it passes through", () => {
  const { scrubResponse } = require("../../services/access/hrFieldPolicy");
  const mongoose = require("mongoose");

  test("an ObjectId stays an id and a Date stays a date", async () => {
    /* The regression: rebuilding an object by walking its own enumerable keys
       turns an ObjectId into `{}`, which serialises as "[object Object]" and
       silently corrupts every id in the response. */
    const id = new mongoose.Types.ObjectId();
    const out = scrubResponse(
      { data: [{ _id: id, when: new Date("2026-01-01T00:00:00.000Z"), salary: { gross: 1 } }] },
      ROLE_TEMPLATES.hr_viewer,
    );
    expect(String(out.data[0]._id)).toBe(String(id));
    expect(out.data[0].when).toBe("2026-01-01T00:00:00.000Z");
    expect(out.data[0].salary).toBeUndefined();
  });

  test("a mongoose DOCUMENT is scrubbed, not skipped", async () => {
    /* The other half of the same bug, and the dangerous half: a route that
       forgets `.lean()` returns a Document whose protected fields live behind
       accessors, so a walker that only reads own enumerable keys would find
       nothing to remove and send the salary. */
    const doc = record; // a real, saved mongoose document
    const out = scrubResponse({ employee: doc }, ROLE_TEMPLATES.hr_viewer);

    expect(out.employee.firstName).toBe("Asha");
    expect(out.employee.salary).toBeUndefined();
    expect(out.employee.bankDetails).toBeUndefined();
    expect(out.employee.password).toBeUndefined();
    expect(out.employee.temporaryPassword).toBeUndefined();
    expect(JSON.stringify(out)).not.toMatch(/Welcome@123|1234567890/);
  });
});

describe("the query itself never loads what it may not return", () => {
  test("excludeSelect keeps restricted values in the database", () => {
    const viewer = excludeSelect(ROLE_TEMPLATES.hr_viewer);
    const held = new Set(ROLE_TEMPLATES.hr_viewer);
    /* Every restricted path whose capability the viewer does NOT hold. Computed
       rather than listed: a viewer legitimately reads `sopPoints` (it rides
       skills.read, which the performance screen needs), so asserting "every
       restricted field is excluded for everybody" would be asserting something
       untrue and would have to be weakened later. */
    for (const f of RESTRICTED_FIELDS.filter((r) => !held.has(r.capability))) {
      /* A nested path is covered by its parent when the parent is excluded
         too — and it has to be, because MongoDB refuses a projection naming
         both ("Path collision at documents"). */
      const parent = f.path.split(".")[0];
      const covered = viewer.includes(`-${f.path}`) || viewer.includes(`-${parent} `) || viewer.endsWith(`-${parent}`);
      expect({ path: f.path, covered }).toEqual({ path: f.path, covered: true });
    }
    for (const field of NEVER_EXPOSE) expect(viewer).toContain(`-${field}`);
    /* A directory reader also loses the private class at the query. */
    expect(viewer).toContain("-phone");
    expect(viewer).toContain("-address");

    const owner = excludeSelect(ROLE_TEMPLATES.hr_owner);
    expect(owner).toContain("-password");
    expect(owner).toContain("-temporaryPassword");
    expect(owner).not.toContain("-salary");
  });

  test("no directory field is also a restricted one", () => {
    /* A field cannot be in both lists: it would be returned to a viewer by the
       allowlist and then deleted by the restricted pass, or worse, the reverse. */
    for (const field of DIRECTORY_FIELDS) {
      expect(RESTRICTED_TOP_LEVEL).not.toContain(field);
    }
  });
});
