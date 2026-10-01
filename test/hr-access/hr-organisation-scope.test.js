"use strict";
/**
 * HRMS CHUNK 2A — the scope classifier, and what it refuses to decide.
 *
 * The point of a classifier rather than a resolver is that it can say "I do not
 * know" in four different ways, and each of those is a different instruction to
 * the Chunk 2B migration. These tests pin the ones that matter: a migration
 * that quietly picked the first candidate, or preferred the direct field over a
 * contradicting derivation, would populate wrong answers and then index them.
 *
 * Pure — no database. The audit runner owns the fetching, and its own contract
 * is tested in hr-organisation-scope-audit.test.js.
 */

process.env.TEST_WITHOUT_MONGO = "1";

const {
  SCOPE_STATUS,
  DUPLICATE_VERDICT,
  POPULATABLE,
  PROHIBITED_DIAGNOSTIC_KEYS,
  classifyScope,
  classifyDuplicateGroup,
  scopedUniquenessKey,
  containsPrivateData,
} = require("../../services/access/hrScopeClassifier");

const COMPANY_A = "6a00000000000000000000a1";
const COMPANY_B = "6a00000000000000000000b2";
const ESTAB_1 = "6a00000000000000000000e1";
const ESTAB_2 = "6a00000000000000000000e2";

describe("direct scope", () => {
  test("a record that carries its own resolving scope is SCOPED", () => {
    const r = classifyScope({ level: "company", direct: COMPANY_A, directExists: true });
    expect(r.status).toBe(SCOPE_STATUS.SCOPED);
    expect(r.scopeId).toBe(COMPANY_A);
    expect(r.populatable).toBe(true);
    expect(r.evidence[0]).toEqual({ kind: "direct", id: COMPANY_A, exists: true });
  });

  test("agreeing derived evidence does not disturb it", () => {
    const r = classifyScope({
      level: "company",
      direct: COMPANY_A,
      directExists: true,
      derived: [{ id: COMPANY_A, via: "department" }, { id: COMPANY_A, via: "site" }],
    });
    expect(r.status).toBe(SCOPE_STATUS.SCOPED);
    expect(r.scopeId).toBe(COMPANY_A);
  });
});

describe("derivation", () => {
  test("exactly one candidate is DERIVABLE_UNAMBIGUOUS, with its provenance", () => {
    const r = classifyScope({
      level: "company",
      derived: [{ id: COMPANY_A, via: "hr-department-mapping" }],
    });
    expect(r.status).toBe(SCOPE_STATUS.DERIVABLE_UNAMBIGUOUS);
    expect(r.scopeId).toBe(COMPANY_A);
    /* A derivation that cannot say WHY is not safe to migrate from. */
    expect(r.evidence).toContainEqual({
      kind: "derived", id: COMPANY_A, via: ["hr-department-mapping"],
    });
  });

  test("two paths reaching the SAME company are one candidate, not a choice", () => {
    const r = classifyScope({
      level: "company",
      derived: [
        { id: COMPANY_A, via: "hr-department-mapping" },
        { id: COMPANY_A, via: "payroll-bridge" },
      ],
    });
    expect(r.status).toBe(SCOPE_STATUS.DERIVABLE_UNAMBIGUOUS);
    expect(r.candidateIds).toEqual([COMPANY_A]);
  });
});

describe("what must NOT be decided", () => {
  test("two candidate companies are AMBIGUOUS — never the first one", () => {
    const r = classifyScope({
      level: "company",
      derived: [
        { id: COMPANY_A, via: "hr-department-mapping" },
        { id: COMPANY_B, via: "payroll-bridge" },
      ],
    });
    expect(r.status).toBe(SCOPE_STATUS.AMBIGUOUS);
    expect(r.scopeId).toBeNull();
    expect(r.populatable).toBe(false);
    expect(r.candidateIds.sort()).toEqual([COMPANY_A, COMPANY_B].sort());
  });

  test("two candidate establishments are AMBIGUOUS too", () => {
    const r = classifyScope({
      level: "establishment",
      derived: [
        { id: ESTAB_1, via: "attendance-device" },
        { id: ESTAB_2, via: "work-location-mapping" },
      ],
    });
    expect(r.status).toBe(SCOPE_STATUS.AMBIGUOUS);
    expect(r.scopeId).toBeNull();
  });

  test("direct versus derived disagreement is CONFLICT — the direct value does not win", () => {
    const r = classifyScope({
      level: "company",
      direct: COMPANY_A,
      directExists: true,
      derived: [{ id: COMPANY_B, via: "hr-department-mapping" }],
    });
    expect(r.status).toBe(SCOPE_STATUS.CONFLICT);
    expect(r.scopeId).toBeNull();
    expect(r.conflictingIds).toEqual([COMPANY_B]);
  });

  test("missing evidence stays MISSING — there is no default company", () => {
    for (const direct of [null, undefined, "", "   "]) {
      const r = classifyScope({ level: "company", direct, derived: [] });
      expect({ direct, status: r.status }).toEqual({ direct, status: SCOPE_STATUS.MISSING });
      expect(r.scopeId).toBeNull();
    }
  });

  test("a scope reference pointing at nothing is DANGLING_REFERENCE", () => {
    const r = classifyScope({ level: "company", direct: COMPANY_A, directExists: false });
    expect(r.status).toBe(SCOPE_STATUS.DANGLING_REFERENCE);
    expect(r.scopeId).toBeNull();
  });

  test("a dangling direct reference is not rescued by an agreeing derivation", () => {
    const r = classifyScope({
      level: "company",
      direct: COMPANY_A,
      directExists: false,
      derived: [{ id: COMPANY_A, via: "hr-department-mapping" }],
    });
    expect(r.status).toBe(SCOPE_STATUS.DANGLING_REFERENCE);
  });

  test("derived candidates that all dangle are DANGLING_REFERENCE, not MISSING", () => {
    const r = classifyScope({
      level: "company",
      derived: [{ id: COMPANY_A, via: "hr-department-mapping", exists: false }],
    });
    expect(r.status).toBe(SCOPE_STATUS.DANGLING_REFERENCE);
  });

  test("a free-text site label is an UNSUPPORTED_LEGACY_SHAPE, not evidence", () => {
    /* `Employee.workLocation` is a string defaulting to "GRAV Clothing". It
       looks like a site and references nothing; reading it as one is guessing. */
    const r = classifyScope({ level: "establishment", legacyShape: "free-text-work-location" });
    expect(r.status).toBe(SCOPE_STATUS.UNSUPPORTED_LEGACY_SHAPE);
    expect(r.scopeId).toBeNull();
    expect(r.populatable).toBe(false);
  });

  test("only SCOPED and DERIVABLE_UNAMBIGUOUS may be populated by a migration", () => {
    expect([...POPULATABLE].sort()).toEqual(
      [SCOPE_STATUS.SCOPED, SCOPE_STATUS.DERIVABLE_UNAMBIGUOUS].sort(),
    );
    for (const status of [
      SCOPE_STATUS.MISSING, SCOPE_STATUS.AMBIGUOUS, SCOPE_STATUS.CONFLICT,
      SCOPE_STATUS.DANGLING_REFERENCE, SCOPE_STATUS.UNSUPPORTED_LEGACY_SHAPE,
    ]) {
      expect(POPULATABLE).not.toContain(status);
    }
  });
});

describe("organisation placement is never application access", () => {
  test("the classifier has no concept of a capability, grant or role", () => {
    /* The permanent rule, asserted where it can actually be broken: a future
       edit that taught this file to return a capability would fail here. */
    const source = require("fs").readFileSync(
      require("path").join(__dirname, "../../services/access/hrScopeClassifier.js"), "utf8",
    );
    for (const forbidden of [
      "hrCapabilities", "capabilit", "accessDepartmentId", "DepartmentRole",
      "hasHrApplicationAccess", "grant",
    ]) {
      /* The header prose says "never gain one", so match on code shapes rather
         than the bare word where the word is also English. */
      expect(source).not.toMatch(new RegExp(`require\\([^)]*${forbidden}`, "i"));
    }
    const api = require("../../services/access/hrScopeClassifier");
    expect(Object.keys(api).some((k) => /capab|access|grant|role/i.test(k))).toBe(false);
  });

  test("classifying a department placement returns a scope, never a permission", () => {
    const r = classifyScope({ level: "department", direct: "dept-1", directExists: true });
    expect(r.status).toBe(SCOPE_STATUS.SCOPED);
    expect(r).not.toHaveProperty("capabilities");
    expect(r).not.toHaveProperty("allowed");
    expect(r).not.toHaveProperty("hasHrApplicationAccess");
  });
});

describe("scoped uniqueness", () => {
  const inScope = (companyId, establishmentId) => ({
    recordId: `r-${companyId}-${establishmentId}`,
    companyId,
    establishmentId,
    scopeStatus: SCOPE_STATUS.SCOPED,
  });

  test("the key is an unambiguous encoding, not a delimiter join", () => {
    /* Same reasoning as the authorisation cache key: a join is injective only
       if no component can contain the delimiter, and these components are
       data. */
    const a = scopedUniquenessKey({ companyId: "x|y", establishmentId: "z", value: "GR1" });
    const b = scopedUniquenessKey({ companyId: "x", establishmentId: "y|z", value: "GR1" });
    expect(a).not.toBe(b);
  });

  test("the SAME employee number in two distinct companies becomes legal", () => {
    const verdict = classifyDuplicateGroup([inScope(COMPANY_A, ESTAB_1), inScope(COMPANY_B, ESTAB_2)]);
    expect(verdict.verdict).toBe(DUPLICATE_VERDICT.LEGAL_UNDER_SCOPE);
    expect(verdict.groups).toBe(2);
  });

  test("a duplicate employee number WITHIN one scope stays invalid", () => {
    const verdict = classifyDuplicateGroup([inScope(COMPANY_A, ESTAB_1), inScope(COMPANY_A, ESTAB_1)]);
    expect(verdict.verdict).toBe(DUPLICATE_VERDICT.INVALID_UNDER_SCOPE);
  });

  test("the SAME biometric id in two distinct establishments becomes legal", () => {
    const verdict = classifyDuplicateGroup([inScope(COMPANY_A, ESTAB_1), inScope(COMPANY_A, ESTAB_2)]);
    expect(verdict.verdict).toBe(DUPLICATE_VERDICT.LEGAL_UNDER_SCOPE);
  });

  test("a duplicate biometric id within one establishment stays invalid", () => {
    const verdict = classifyDuplicateGroup([inScope(COMPANY_A, ESTAB_2), inScope(COMPANY_A, ESTAB_2)]);
    expect(verdict.verdict).toBe(DUPLICATE_VERDICT.INVALID_UNDER_SCOPE);
  });

  test("the same payroll period in two companies becomes legal", () => {
    const october = (companyId) => ({ recordId: `run-${companyId}`, companyId, scopeStatus: SCOPE_STATUS.SCOPED });
    expect(classifyDuplicateGroup([october(COMPANY_A), october(COMPANY_B)]).verdict)
      .toBe(DUPLICATE_VERDICT.LEGAL_UNDER_SCOPE);
    /* …and twice in ONE company is still one period run twice. */
    expect(classifyDuplicateGroup([october(COMPANY_A), october(COMPANY_A)]).verdict)
      .toBe(DUPLICATE_VERDICT.INVALID_UNDER_SCOPE);
  });

  test("an UNKNOWN scope is not a distinction — the group stays invalid", () => {
    /* This is the one that keeps a migration honest. Every HR record today has
       no company, so "they might be in different companies" must not read as
       "they are". */
    const verdict = classifyDuplicateGroup([
      { recordId: "a", companyId: null },
      { recordId: "b", companyId: null },
    ]);
    expect(verdict.verdict).toBe(DUPLICATE_VERDICT.INVALID_UNDER_SCOPE);
    expect(verdict.undecidableCount).toBe(2);
  });

  test("a scope that is only AMBIGUOUS does not count as known either", () => {
    const verdict = classifyDuplicateGroup([
      { recordId: "a", companyId: COMPANY_A, scopeStatus: SCOPE_STATUS.AMBIGUOUS },
      { recordId: "b", companyId: COMPANY_B, scopeStatus: SCOPE_STATUS.SCOPED },
    ]);
    expect(verdict.verdict).toBe(DUPLICATE_VERDICT.INVALID_UNDER_SCOPE);
  });

  test("a single record is UNIQUE", () => {
    expect(classifyDuplicateGroup([inScope(COMPANY_A, ESTAB_1)]).verdict)
      .toBe(DUPLICATE_VERDICT.UNIQUE);
  });
});

describe("diagnostics carry no private HR data", () => {
  test("classifier output contains only ids and machine labels", () => {
    const r = classifyScope({
      level: "company",
      direct: COMPANY_A,
      directExists: true,
      derived: [{ id: COMPANY_B, via: "hr-department-mapping" }],
    });
    expect(containsPrivateData(r)).toEqual([]);
  });

  test("containsPrivateData finds a prohibited field at any depth", () => {
    expect(containsPrivateData({ a: { b: [{ email: "x@y.z" }] } })).toEqual(["a.b[0].email"]);
    expect(containsPrivateData({ rows: [{ salary: { gross: 1 } }] })).toEqual(["rows[0].salary"]);
    expect(containsPrivateData({ ok: 1, nested: { fine: "yes" } })).toEqual([]);
  });

  test("every class of private HR value is named in the prohibited list", () => {
    for (const key of [
      "firstName", "lastName", "email", "phone", "address", "dateOfBirth",
      "salary", "bankDetails", "accountNumber",
      "aadharNumber", "panNumber", "uanNumber",
      "bloodGroup", "password", "temporaryPassword", "documents",
    ]) {
      expect(PROHIBITED_DIAGNOSTIC_KEYS).toContain(key);
    }
  });
});
