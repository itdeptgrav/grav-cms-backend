// test/store-purchase/tenancy-infrastructure.test.js
//
// Store & Purchase — Chunk 1. The infrastructure, proved directly.
//
// The route suite proves these work through HTTP. This one proves the
// guarantees themselves — concurrency, fiscal-year boundaries, fail-closed
// membership, capability mapping, policy resolution — where a route test
// could only show the happy path.
"use strict";

const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const DeptUser = require("../../models/Access/DeptUser");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SpDocumentSequence = require("../../models/CMS_Models/StorePurchase/SpDocumentSequence");
const SpApprovalPolicy = require("../../models/CMS_Models/StorePurchase/SpApprovalPolicy");
const SpActionHistory = require("../../models/CMS_Models/StorePurchase/SpActionHistory");

const sequences = require("../../services/storePurchase/documentSequence.service");
const tenantContext = require("../../services/storePurchase/tenantContext.service");
const capabilities = require("../../services/storePurchase/capabilities");
const approvalPolicy = require("../../services/storePurchase/approvalPolicy.service");
const actionHistory = require("../../services/storePurchase/actionHistory.service");
const lifecycle = require("../../services/storePurchase/lifecycle.service");

const { CAPABILITIES } = capabilities;
let seq = 0;
const company = () =>
  Acc_Company.create({ companyName: `Co ${++seq}`, booksFromDate: new Date("2026-04-01") });

/* ═══ Document sequences ═════════════════════════════════════════════════ */

describe("document sequences", () => {
  test("fiscal year follows the Indian April–March boundary", () => {
    expect(sequences.fiscalYearOf("2026-04-01")).toBe("2026-27");
    expect(sequences.fiscalYearOf("2026-03-31")).toBe("2025-26");
    expect(sequences.fiscalYearOf("2027-01-15")).toBe("2026-27");
    expect(sequences.fiscalYearOf("2026-12-31")).toBe("2026-27");
    // The 2099→2100 roll still renders two digits.
    expect(sequences.fiscalYearOf("2099-04-01")).toBe("2099-00");
  });

  test("50 concurrent allocations on one key are unique and contiguous", async () => {
    const co = await company();
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        sequences.allocate({ companyId: co._id, documentType: "PURCHASE_ORDER", at: "2026-06-01" })),
    );
    const numbers = results.map((r) => r.sequence).sort((a, b) => a - b);
    // Unique…
    expect(new Set(numbers).size).toBe(50);
    // …and monotonic with no gaps: exactly 1..50, which is what proves the
    // increment was atomic rather than merely lucky.
    expect(numbers).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  test("counters are independent per company, document type and fiscal year", async () => {
    const a = await company();
    const b = await company();
    const first = (args) => sequences.allocate(args).then((r) => r.sequence);

    expect(await first({ companyId: a._id, documentType: "PURCHASE_ORDER", at: "2026-06-01" })).toBe(1);
    // Another company starts its own sequence.
    expect(await first({ companyId: b._id, documentType: "PURCHASE_ORDER", at: "2026-06-01" })).toBe(1);
    // Another document type in the same company starts its own.
    expect(await first({ companyId: a._id, documentType: "REQUISITION", at: "2026-06-01" })).toBe(1);
    // A new fiscal year starts its own.
    expect(await first({ companyId: a._id, documentType: "PURCHASE_ORDER", at: "2027-06-01" })).toBe(1);
    // …and the original key carries on where it left off.
    expect(await first({ companyId: a._id, documentType: "PURCHASE_ORDER", at: "2026-06-01" })).toBe(2);
  });

  test("a number is never reused after the document is abandoned", async () => {
    const co = await company();
    const one = await sequences.allocate({ companyId: co._id, documentType: "PURCHASE_ORDER", at: "2026-06-01" });
    // The caller discards it — a save failed, an order was cancelled.
    const two = await sequences.allocate({ companyId: co._id, documentType: "PURCHASE_ORDER", at: "2026-06-01" });
    expect(two.sequence).toBe(one.sequence + 1);
    // The gap is deliberate: a reissued number is two documents claiming to
    // be one, which is worse than a number nobody used.
  });

  test("the format is server-owned and padded", async () => {
    const co = await company();
    const r = await sequences.allocate({ companyId: co._id, documentType: "PURCHASE_ORDER", at: "2026-06-01" });
    expect(r.number).toBe("PO/2026-27/0001");
    expect(sequences.format({ documentType: "REQUISITION", fiscalYear: "2026-27", sequence: 12345 }))
      .toBe("REQ/2026-27/12345"); // grows past the pad rather than wrapping
  });

  test("an unknown document type is refused rather than silently numbered", async () => {
    const co = await company();
    await expect(sequences.allocate({ companyId: co._id, documentType: "NOT_A_TYPE" }))
      .rejects.toThrow(/Unknown document type/);
  });

  test("the compound key is unique at the database level", async () => {
    const co = await company();
    await SpDocumentSequence.init();
    await SpDocumentSequence.create({
      companyId: co._id, documentType: "PURCHASE_ORDER", fiscalYear: "2026-27", siteId: null, next: 5,
    });
    await expect(SpDocumentSequence.create({
      companyId: co._id, documentType: "PURCHASE_ORDER", fiscalYear: "2026-27", siteId: null, next: 9,
    })).rejects.toThrow(/duplicate key/i);
  });
});

/* ═══ Tenant context ═════════════════════════════════════════════════════ */

describe("tenant context", () => {
  const user = (over = {}) => ({
    id: String(new mongoose.Types.ObjectId()), email: `t${++seq}@x.example`, name: "T", ...over,
  });

  test("an unauthenticated caller is refused before anything else", async () => {
    await expect(tenantContext.resolveForActor(null)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  test("a membership record decides, and is preferred over the deployment fallback", async () => {
    const a = await company();
    await company(); // a second company, so the fallback cannot apply
    const u = user();
    await SpCompanyMembership.create({ companyId: a._id, email: u.email });
    const ctx = await tenantContext.resolveForActor(u);
    expect(String(ctx.companyId)).toBe(String(a._id));
    expect(ctx.membershipSource).toBe("MEMBERSHIP_RECORD");
  });

  test("with two companies and no membership, scoped access FAILS CLOSED", async () => {
    await company();
    await company();
    await expect(tenantContext.resolveForActor(user()))
      .rejects.toMatchObject({ code: "TENANT_MEMBERSHIP_UNPROVEN" });
  });

  test("with no company at all, the message says what to fix", async () => {
    await expect(tenantContext.resolveForActor(user()))
      .rejects.toThrow(/No company is set up/);
  });

  test("the single-company fallback applies only while no membership exists anywhere", async () => {
    const only = await company();
    const u = user();
    const ctx = await tenantContext.resolveForActor(u);
    expect(ctx.membershipSource).toBe("SINGLE_COMPANY_DEPLOYMENT");

    /* The moment somebody is given an explicit membership, the deployment is
       no longer "nobody has been assigned" — and a person without one must
       stop being handed the only company by default. */
    await SpCompanyMembership.create({ companyId: only._id, email: "someone.else@x.example" });
    await expect(tenantContext.resolveForActor(u))
      .rejects.toMatchObject({ code: "TENANT_MEMBERSHIP_UNPROVEN" });
  });

  test("tenantFilter selects the company — and in legacy mode, the unowned", () => {
    const id = new mongoose.Types.ObjectId();
    expect(tenantContext.tenantFilter({ companyId: id, legacyMode: false })).toEqual({ companyId: id });
    const legacy = tenantContext.tenantFilter({ companyId: id, legacyMode: true });
    // Never both: a list that mixes owned and unowned records is the exact
    // ambiguity the legacy rule exists to prevent.
    expect(legacy.$or).toHaveLength(2);
    expect(legacy.companyId).toBeUndefined();
  });

  test("a foreign company in the body is refused; the matching one is allowed", () => {
    const ctx = { companyId: new mongoose.Types.ObjectId() };
    expect(() => tenantContext.assertNoForeignCompany(ctx, {})).not.toThrow();
    expect(() => tenantContext.assertNoForeignCompany(ctx, { companyId: String(ctx.companyId) })).not.toThrow();
    expect(() => tenantContext.assertNoForeignCompany(ctx, { companyId: String(new mongoose.Types.ObjectId()) }))
      .toThrow(/another company/);
  });

  test("a cross-company reference is rejected before it can be used", () => {
    const ctx = { companyId: new mongoose.Types.ObjectId() };
    const foreign = { _id: new mongoose.Types.ObjectId(), companyId: new mongoose.Types.ObjectId() };
    // Non-disclosing: the same answer a missing document gets.
    expect(() => tenantContext.assertSameTenant(ctx, foreign, "vendor")).toThrow(/not found/i);
    // A legacy-global record cannot join a company-scoped write either.
    expect(() => tenantContext.assertSameTenant(ctx, { _id: foreign._id, companyId: null }, "vendor"))
      .toThrow(/predates company ownership/);
    expect(tenantContext.assertSameTenant(ctx, { _id: foreign._id, companyId: ctx.companyId })).toBeTruthy();
  });

  test("a site outside the actor's permitted list is refused", () => {
    const permitted = new mongoose.Types.ObjectId();
    const ctx = { permittedSiteIds: [String(permitted)] };
    expect(String(tenantContext.resolveSite(ctx, permitted))).toBe(String(permitted));
    expect(() => tenantContext.resolveSite(ctx, new mongoose.Types.ObjectId()))
      .toThrow(/do not have access to that site/);
    // No site named is fine — every current document type is site-optional.
    expect(tenantContext.resolveSite(ctx, null)).toBeNull();
  });

  test("a service context must name its company AND its reason", () => {
    expect(() => tenantContext.forService({ reason: "nightly" })).toThrow(/name a company/);
    expect(() => tenantContext.forService({ companyId: new mongoose.Types.ObjectId() })).toThrow(/state its reason/);
    const ctx = tenantContext.forService({ companyId: new mongoose.Types.ObjectId(), reason: "reconciliation" });
    // A service gets exactly what it is given — not everything.
    expect(ctx.capabilities).toEqual([]);
  });
});

/* ═══ Capabilities ═══════════════════════════════════════════════════════ */

describe("capabilities", () => {
  test("authentication alone grants nothing", async () => {
    const r = await capabilities.resolveCapabilities({ email: "nobody@x.example" });
    expect(r.capabilities).toEqual([]);
  });

  test("a store approver may issue and cancel; an editor may not", async () => {
    await DepartmentRole.create({ departmentSlug: "store", email: "app@x.example", role: "approver", isActive: true });
    await DepartmentRole.create({ departmentSlug: "store", email: "ed@x.example", role: "editor", isActive: true });

    const approver = await capabilities.resolveCapabilities({ email: "app@x.example" });
    const editor = await capabilities.resolveCapabilities({ email: "ed@x.example" });

    expect(approver.capabilities).toEqual(expect.arrayContaining([
      CAPABILITIES.PO_ISSUE, CAPABILITIES.PO_CANCEL, CAPABILITIES.STOCK_ADJUST,
    ]));
    expect(editor.capabilities).toEqual(expect.arrayContaining([
      CAPABILITIES.PO_CREATE, CAPABILITIES.RECEIPT_RECORD,
    ]));
    expect(editor.capabilities).not.toContain(CAPABILITIES.PO_ISSUE);
    expect(editor.capabilities).not.toContain(CAPABILITIES.STOCK_ADJUST);
  });

  test("the CEO grant reads everything and writes nothing", async () => {
    await DepartmentRole.create({ departmentSlug: "ceo", email: "ceo@x.example", role: "owner", isActive: true });
    const r = await capabilities.resolveCapabilities({ email: "ceo@x.example" });
    expect(r.capabilities).toEqual(expect.arrayContaining([
      CAPABILITIES.READ, CAPABILITIES.HISTORY_READ, CAPABILITIES.LEGACY_READ,
    ]));
    for (const write of [CAPABILITIES.PO_CREATE, CAPABILITIES.PO_ISSUE, CAPABILITIES.STOCK_ADJUST]) {
      expect(r.capabilities).not.toContain(write);
    }
  });

  test("a platform admin holds everything except quality acceptance", async () => {
    await DeptUser.create({
      email: "admin@x.example", name: "Admin", passwordHash: "x", isAdmin: true, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
    const r = await capabilities.resolveCapabilities({ email: "admin@x.example" });
    expect(r.isAdmin).toBe(true);
    expect(r.capabilities).toContain(CAPABILITIES.POLICY_ADMIN);
    /* Nobody performs quality acceptance today, so no actor is given the
       authority for a step the business has not defined. */
    expect(r.capabilities).not.toContain(CAPABILITIES.QUALITY_ACCEPT);
  });

  test("an inactive grant is not a grant", async () => {
    await DepartmentRole.create({ departmentSlug: "store", email: "gone@x.example", role: "owner", isActive: false });
    const r = await capabilities.resolveCapabilities({ email: "gone@x.example" });
    expect(r.capabilities).toEqual([]);
  });

  test("multiple grants union rather than the last one winning", async () => {
    await DepartmentRole.create({ departmentSlug: "store", email: "both@x.example", role: "editor", isActive: true });
    await DepartmentRole.create({ departmentSlug: "ceo", email: "both@x.example", role: "viewer", isActive: true });
    const r = await capabilities.resolveCapabilities({ email: "both@x.example" });
    expect(r.capabilities).toContain(CAPABILITIES.PO_CREATE);  // from store
    expect(r.capabilities).toContain(CAPABILITIES.LEGACY_READ); // from ceo
  });
});

/* ═══ Approval policy ════════════════════════════════════════════════════ */

describe("approval policy", () => {
  const policy = (companyId, over = {}) => SpApprovalPolicy.create({
    companyId, documentType: "PURCHASE_ORDER", minAmount: 0, maxAmount: null,
    levels: [{ level: 1, requiredCapability: CAPABILITIES.PO_APPROVE }], ...over,
  });

  test("FAIL CLOSED: no matching policy REFUSES issuance rather than allowing it", () => {
    /* An earlier version returned `allowed: true` here, reasoning that "the
       route capability still applies". That made an unconfigured company
       behave exactly like a fully-approved one, and quietly reinterpreted a
       capability check as approval-policy enforcement. They are two gates. */
    const resolution = { outcome: "NONE_MATCHED", documentType: "PURCHASE_ORDER", amount: 500 };
    expect(() => approvalPolicy.evaluate({ resolution, ctx: { capabilitySet: new Set([CAPABILITIES.PO_ISSUE]) } }))
      .toThrow(/No approval rule is configured/);
    try {
      approvalPolicy.evaluate({ resolution, ctx: { capabilitySet: new Set() } });
    } catch (err) {
      expect(err.code).toBe("POLICY_NOT_CONFIGURED");
    }
  });

  test("an emergency order with no emergency rule is refused in its own words", () => {
    const resolution = { outcome: "NONE_MATCHED", documentType: "PURCHASE_ORDER", amount: 500, isEmergency: true };
    expect(() => approvalPolicy.evaluate({ resolution, ctx: { capabilitySet: new Set() } }))
      .toThrow(/No emergency approval rule/);
  });

  test("a policy naming no approver authorises nobody", () => {
    /* An empty level set must not be more permissive than no policy at all. */
    const resolution = {
      outcome: "MATCHED",
      policy: { _id: "p1", levels: [] },
      documentType: "PURCHASE_ORDER", amount: 100,
    };
    expect(() => approvalPolicy.evaluate({ resolution, ctx: { capabilitySet: new Set() } }))
      .toThrow(/names no approver/);
  });

  test("an amount band selects the right rule and refuses an actor without its authority", async () => {
    const co = await company();
    await policy(co._id, { minAmount: 0, maxAmount: 10000, levels: [{ level: 1, requiredCapability: CAPABILITIES.PO_ISSUE }] });
    await policy(co._id, { minAmount: 10000, maxAmount: null, levels: [{ level: 1, requiredCapability: CAPABILITIES.PO_APPROVE }] });

    const small = await approvalPolicy.resolvePolicy({ companyId: co._id, documentType: "PURCHASE_ORDER", amount: 500 });
    const large = await approvalPolicy.resolvePolicy({ companyId: co._id, documentType: "PURCHASE_ORDER", amount: 50000 });
    expect(small.policy.maxAmount).toBe(10000);
    expect(large.policy.maxAmount).toBeNull();

    const buyer = { capabilitySet: new Set([CAPABILITIES.PO_ISSUE]) };
    expect(approvalPolicy.evaluate({ resolution: small, ctx: buyer }).allowed).toBe(true);
    const refused = approvalPolicy.evaluate({ resolution: large, ctx: buyer });
    expect(refused.allowed).toBe(false);
    expect(refused.requiredCapability).toBe(CAPABILITIES.PO_APPROVE);
  });

  test("overlapping active rules are refused, not silently resolved", async () => {
    const co = await company();
    await policy(co._id, { minAmount: 0, maxAmount: 5000 });
    await policy(co._id, { minAmount: 0, maxAmount: 8000 });
    const resolution = await approvalPolicy.resolvePolicy({
      companyId: co._id, documentType: "PURCHASE_ORDER", amount: 1000,
    });
    expect(resolution.outcome).toBe("AMBIGUOUS");
    expect(() => approvalPolicy.evaluate({ resolution, ctx: { capabilitySet: new Set() } }))
      .toThrow(/More than one approval rule/);
  });

  test("policies are company-scoped and never leak across tenants", async () => {
    const a = await company();
    const b = await company();
    await policy(a._id);
    const forB = await approvalPolicy.resolvePolicy({ companyId: b._id, documentType: "PURCHASE_ORDER", amount: 100 });
    expect(forB.outcome).toBe("NONE_MATCHED");
  });

  test("an emergency policy is a separate rule, not a bypass", async () => {
    const co = await company();
    await policy(co._id);
    await policy(co._id, { isEmergencyPolicy: true, levels: [{ level: 1, requiredCapability: CAPABILITIES.POLICY_ADMIN }] });

    const ordinary = await approvalPolicy.resolvePolicy({ companyId: co._id, documentType: "PURCHASE_ORDER", amount: 100 });
    const emergency = await approvalPolicy.resolvePolicy({ companyId: co._id, documentType: "PURCHASE_ORDER", amount: 100, isEmergency: true });
    expect(ordinary.policy.isEmergencyPolicy).toBe(false);
    // "Emergency" means a DIFFERENT recorded authority, never an absent one.
    expect(emergency.policy.levels[0].requiredCapability).toBe(CAPABILITIES.POLICY_ADMIN);
  });

  test("a rule outside its effective window does not apply", async () => {
    const co = await company();
    await policy(co._id, { effectiveFrom: new Date("2030-01-01") });
    const now = await approvalPolicy.resolvePolicy({
      companyId: co._id, documentType: "PURCHASE_ORDER", amount: 100, at: new Date("2026-06-01"),
    });
    expect(now.outcome).toBe("NONE_MATCHED");
  });
});

/* ═══ Action history ═════════════════════════════════════════════════════ */

describe("action history", () => {
  const ctx = (companyId) => ({
    companyId, actorId: "actor-1", actorType: "employee", actorName: "Asha", siteId: null,
  });

  test("an entry records the transition, the actor and the document it was about", async () => {
    const co = await company();
    const entityId = new mongoose.Types.ObjectId();
    await actionHistory.record(ctx(co._id), {
      entityType: "PURCHASE_ORDER", entityId, documentNumber: "PO/2026-27/0001",
      action: "ISSUED", previousState: "DRAFT", resultingState: "ISSUED",
    });
    const [entry] = await actionHistory.listFor(ctx(co._id), { entityId });
    expect(entry).toMatchObject({
      action: "ISSUED", previousState: "DRAFT", resultingState: "ISSUED",
      actorName: "Asha", documentNumber: "PO/2026-27/0001",
    });
  });

  test("actions that exist to be explained demand a reason", async () => {
    const co = await company();
    await expect(actionHistory.record(ctx(co._id), {
      entityType: "PURCHASE_ORDER", entityId: new mongoose.Types.ObjectId(), action: "CANCELLED",
    })).rejects.toThrow(/must record a reason/);
  });

  test("history never carries a payload, a token or an unbounded blob", async () => {
    const co = await company();
    const entityId = new mongoose.Types.ObjectId();
    await actionHistory.record(ctx(co._id), {
      entityType: "PURCHASE_ORDER", entityId, action: "CREATED",
      metadata: {
        total: 100,
        note: "x".repeat(5000),                 // truncated
        token: { secret: "abc" },               // an object — dropped entirely
        lines: ["a", "b"],
      },
    });
    const [entry] = await actionHistory.listFor(ctx(co._id), { entityId });
    expect(entry.metadata.total).toBe(100);
    expect(entry.metadata.note.length).toBe(500);
    expect(entry.metadata.token).toBeUndefined();
    expect(entry.metadata.lines).toEqual(["a", "b"]);
  });

  test("history is tenant-scoped on read", async () => {
    const a = await company();
    const b = await company();
    await actionHistory.record(ctx(a._id), {
      entityType: "PURCHASE_ORDER", entityId: new mongoose.Types.ObjectId(), action: "CREATED",
    });
    expect(await actionHistory.listFor(ctx(b._id), {})).toEqual([]);
  });

  test("the company on an entry comes from context, never from the caller's arguments", async () => {
    const a = await company();
    const b = await company();
    await actionHistory.record(ctx(a._id), {
      entityType: "PURCHASE_ORDER", entityId: new mongoose.Types.ObjectId(),
      action: "CREATED", companyId: b._id, // ignored
    });
    expect(await SpActionHistory.countDocuments({ companyId: b._id })).toBe(0);
    expect(await SpActionHistory.countDocuments({ companyId: a._id })).toBe(1);
  });

  test("recordWithState performs the change and its entry together", async () => {
    const co = await company();
    const entityId = new mongoose.Types.ObjectId();
    let ran = false;
    const result = await actionHistory.recordWithState(ctx(co._id), async () => {
      ran = true;
      return {
        entry: { entityType: "PURCHASE_ORDER", entityId, action: "ISSUED", resultingState: "ISSUED" },
        result: "done",
      };
    });
    expect(ran).toBe(true);
    expect(result).toBe("done");
    const [entry] = await actionHistory.listFor(ctx(co._id), { entityId });
    expect(entry.action).toBe("ISSUED");
    /* The in-memory test server is a standalone, so transactions are
       unavailable and the entry is honestly marked rather than claiming an
       atomicity it did not have. */
    expect(typeof entry.atomicityDegraded).toBe("boolean");
  });
});

/* ═══ Lifecycle ══════════════════════════════════════════════════════════ */

describe("lifecycle rules", () => {
  test("a document past draft cannot be deleted, and the refusal says to cancel", () => {
    try {
      lifecycle.assertDeletable({
        entityLabel: "purchase order", state: "ISSUED", deletableStates: ["DRAFT"], references: [],
      });
      throw new Error("should have refused");
    } catch (err) {
      expect(err.code).toBe("LIFECYCLE_BLOCKED");
      expect(err.details.suggestedAction).toBe("CANCEL");
      expect(err.message).toMatch(/issued to a supplier/); // never the raw enum
    }
  });

  test("a draft with downstream references is blocked, and the blockers are named", () => {
    try {
      lifecycle.assertDeletable({
        entityLabel: "purchase order", state: "DRAFT", deletableStates: ["DRAFT"],
        references: [{ collection: "barcodes", count: 3, describe: "3 printed lot labels" }],
      });
      throw new Error("should have refused");
    } catch (err) {
      expect(err.details.reason).toBe("HAS_REFERENCES");
      expect(err.details.blockingReferences[0]).toMatchObject({ collection: "barcodes", count: 3 });
    }
  });

  test("an untouched draft with no references may be deleted", () => {
    expect(() => lifecycle.assertDeletable({
      entityLabel: "purchase order", state: "DRAFT", deletableStates: ["DRAFT"],
      references: [{ collection: "barcodes", count: 0 }],
    })).not.toThrow();
  });

  test("cancelling demands a reason and a cancellable state", () => {
    expect(() => lifecycle.assertCancellable({
      entityLabel: "purchase order", state: "COMPLETED", cancellableStates: ["DRAFT", "ISSUED"], reason: "x",
    })).toThrow(/cannot be cancelled/);
    expect(() => lifecycle.assertCancellable({
      entityLabel: "purchase order", state: "ISSUED", cancellableStates: ["DRAFT", "ISSUED"], reason: "  ",
    })).toThrow(/needs a reason/);
    expect(() => lifecycle.assertCancellable({
      entityLabel: "purchase order", state: "ISSUED", cancellableStates: ["DRAFT", "ISSUED"], reason: "Duplicate",
    })).not.toThrow();
  });
});
