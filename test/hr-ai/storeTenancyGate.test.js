// test/hr-ai/storeTenancyGate.test.js
//
// THE RELEASE GATE BLOCKS, AND THE LEAK IT GUARDS IS REAL.
//
// ── WHY THIS IS A BLOCKER AND NOT A CAVEAT ────────────────────────────────
// `tenantContext.tenantFilter` reads through to records with no `companyId`
// while `STORE_PURCHASE_STRICT_TENANCY` is unset. Every Store reader inherits
// that, the command palette included. So cross-tenant isolation is a property
// of the DATA, not of the code — and the first test below demonstrates the
// leak rather than describing it, through the palette's own entry point.
//
// The palette cannot fix this and must not pretend to: it is correct
// precisely because it reuses the same scope as every other Store read.
// Narrowing it here would hide the problem in one surface and leave it in
// the other forty.
"use strict";

const mongoose = require("mongoose");

const service = require("../../services/ai/storeCommandSearch.service");
const gate = require("../../scripts/audits/store-tenancy-release-gate");
const { seedStore, storeReaderFor, oid } = require("../support/storeCommandFixtures");

const said = (out) => (out.groups || []).flatMap((g) => g.results.map((r) => r.title)).join(" || ");

/* ══ WHO CAN EVEN BE IN ANOTHER COMPANY ═══════════════════════════════════ */

describe("every authenticated actor resolves to the one canonical company", () => {
  /* ── THE CORRECTION THIS DESCRIBE EXISTS TO MAKE ────────────────────────
     An earlier version of this file called the read-through an exploitable
     cross-tenant leak. It is not one TODAY, and saying so was overstating
     the finding.

     `companyMembership.resolveCompanyForActor` short-circuits: while a
     primary company profile exists, every authenticated internal actor
     works in it — membership rows are not consulted at all (GAC-AR1, "GRAV
     is one organisation"). So the product cannot mint an actor whose
     company differs from anybody else's, and the stranger in the test below
     is a hand-built object, not a session anybody can obtain.

     What the read-through actually does is make UNOWNED records visible to
     the only tenant there is — a correctness and consistency matter, and a
     tenancy risk only on the day GRAV stops being one organisation. The
     gate is the precondition for that day; it is not an open door today. */
  const membership = require("../../services/companyContext/companyMembership.service");

  test("a membership in another company does not put the actor there", async () => {
    const store = await seedStore();
    const canonical = oid();
    await mongoose.connection.collection("acc_companies").insertMany([
      { _id: canonical, name: "GRAV CLOTHING PVT LTD", isPrimary: true, isActive: true },
      { _id: store.companyId, name: "Another Set Of Books", isActive: true },
    ]);
    const actor = { id: String(oid()), email: "someone@grav.in" };
    await mongoose.connection.collection("sp_company_memberships").insertOne({
      _id: oid(), companyId: store.companyId, email: actor.email, isActive: true,
    });

    const resolved = await membership.resolveCompanyForActor(actor, {
      domainLabel: "Store & Purchase",
      fail: (code, message) => Object.assign(new Error(message), { code }),
    });
    /* The membership says one company; the canonical rule says the other,
       and the canonical rule wins. */
    expect(String(resolved.companyId)).toBe(String(canonical));
    expect(resolved.membershipSource).toMatch(/canonical/i);
  });

  test("so the Store palette answers every signed-in person as the same tenant", async () => {
    const store = await seedStore();
    await mongoose.connection.collection("acc_companies").insertOne({
      _id: store.companyId, name: "GRAV CLOTHING PVT LTD", isPrimary: true, isActive: true,
    });
    /* `storeReaderFor` hands the service a company directly, which is what a
       resolved session would carry — and a resolved session can only carry
       this one. */
    const reader = storeReaderFor(store.companyId);
    const out = await service.search({ user: reader, query: "stock of macbook" });
    expect(out.state).toBe("answered");
    expect(said(out)).toMatch(/Macbook/);
  });
});

describe("an unowned record is visible to any company that could exist", () => {
  test("a record with no companyId answers a different company's question", async () => {
    /* A HAND-BUILT actor, deliberately: the product does not mint one (see
       above). This is what the read-through would mean the day it could. */
    const store = await seedStore();
    /* The same material, with no owner — exactly the shape of a record
       written before company stamping. */
    await mongoose.connection.collection("rawitems").insertOne({
      _id: oid(), name: "Orphan Fabric", sku: "ORPHAN-1",
      quantity: 99, unit: "Mtr", variants: [], deletedAt: null,
      createdAt: new Date(), updatedAt: new Date(),
      /* no companyId at all */
    });

    const stranger = storeReaderFor(oid());
    const out = await service.search({ user: stranger, query: "stock of Orphan Fabric" });

    /* The read-through in one assertion: a reader scoped to a company that
       does not own this record still reads it. Not reachable through a real
       session today; the reason the gate exists before it is. */
    expect(out.state).toBe("answered");
    expect(said(out)).toMatch(/Orphan Fabric/);
    expect(said(out)).toMatch(/99/);
    expect(store.companyId).toBeTruthy();
  });

  test("an OWNED record of another company is not", async () => {
    /* And this is why the backfill fixes it rather than the palette: once a
       record carries a company, the very same scope refuses it. */
    const store = await seedStore();
    const stranger = storeReaderFor(oid());
    const out = await service.search({ user: stranger, query: "stock of macbook" });
    expect(said(out)).not.toMatch(/Macbook/);
    expect(store.items.macbook).toBeTruthy();
  });
});

describe("the gate counts what has to be true before the flag is set", () => {
  test("it reports every unowned record, across every Store collection", async () => {
    await seedStore();
    await mongoose.connection.collection("rawitems").insertOne({
      _id: oid(), name: "Orphan Fabric", sku: "ORPHAN-1", quantity: 99,
      unit: "Mtr", variants: [], deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
    });
    await mongoose.connection.collection("purchaseorders").insertOne({
      _id: oid(), poNumber: "PO/LEGACY/0001", items: [],
      createdAt: new Date(), updatedAt: new Date(),
    });

    const out = await gate.measure();
    expect(out.unownedTotal).toBeGreaterThanOrEqual(2);
    const byCollection = Object.fromEntries(out.rows.map((r) => [r.collection, r.unowned]));
    expect(byCollection.rawitems).toBeGreaterThanOrEqual(1);
    expect(byCollection.purchaseorders).toBeGreaterThanOrEqual(1);
    /* And it FAILS, which is the whole point of a gate. */
    expect(out.isolated).toBe(false);
  });

  test("it checks the collections the palette actually reads", async () => {
    const names = gate.collections().map((c) => c.model.collection.name);
    /* The two biggest, and the ones behind "stock of X" and "where is X
       kept", are not in the universal contract and were the easiest to
       leave out of a gate written from that list alone. */
    expect(names).toContain("rawitems");
    expect(names).toContain("location_balances");
    expect(names).toContain("purchaseorders");
    expect(names).toContain("goodsreceipts");
    expect(names.length).toBeGreaterThan(30);
  });

  test("every collection it checks really has a companyId to check", async () => {
    for (const entry of gate.collections()) {
      expect(entry.model.schema.path("companyId")).toBeTruthy();
    }
  });

  test("owning everything is still not enough while the flag is off", async () => {
    /* A clean database with the read-through still on is one `$or` away from
       the leak returning the next time an unstamped record is written. */
    const out = await gate.measure();
    expect(out.unownedTotal).toBe(0);
    expect(process.env.STORE_PURCHASE_STRICT_TENANCY).not.toBe("1");
    expect(out.strict).toBe(false);
    expect(out.isolated).toBe(false);
  });

  test("the gate passes only when both are true", async () => {
    const before = process.env.STORE_PURCHASE_STRICT_TENANCY;
    process.env.STORE_PURCHASE_STRICT_TENANCY = "1";
    try {
      const out = await gate.measure();
      expect(out.unownedTotal).toBe(0);
      expect(out.strict).toBe(true);
      expect(out.isolated).toBe(true);
    } finally {
      if (before === undefined) delete process.env.STORE_PURCHASE_STRICT_TENANCY;
      else process.env.STORE_PURCHASE_STRICT_TENANCY = before;
    }
  });
});

describe("the backfill is a dry run, and refuses to guess an owner", () => {
  const backfill = require("../../scripts/migrations/store-purchase-company-backfill");

  test("with no company in the books it refuses rather than inventing one", async () => {
    await expect(backfill.resolveCompany()).rejects.toThrow(/no company/i);
  });

  test("with two companies it refuses to choose between them", async () => {
    await mongoose.connection.collection("acc_companies").insertMany([
      { _id: oid(), name: "GRAV CLOTHING PVT LTD", isPrimary: true },
      { _id: oid(), name: "IE Demo Garments" },
    ]);
    /* Stamping the canonical company would hand one company's stock to the
       other. Which company unowned records belong to is the owner's
       decision, and the script says so instead of guessing. */
    await expect(backfill.resolveCompany()).rejects.toThrow(/--company=/);
  });

  test("a named company must be an id, not a name", async () => {
    const argv = process.argv;
    process.argv = [...argv, "--company=GRAV CLOTHING"];
    try {
      await expect(backfill.resolveCompany()).rejects.toThrow(/is not an id/);
    } finally {
      process.argv = argv;
    }
  });

  test("a dry run writes nothing", async () => {
    const store = await seedStore();
    await mongoose.connection.collection("rawitems").insertOne({
      _id: oid(), name: "Orphan Fabric", sku: "ORPHAN-1", quantity: 99,
      unit: "Mtr", variants: [], deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
    });
    await mongoose.connection.collection("acc_companies").insertOne({
      _id: store.companyId, name: "GRAV CLOTHING PVT LTD", isPrimary: true,
    });

    const before = await gate.measure();
    const out = await backfill.run({ apply: false });
    const after = await gate.measure();

    expect(out.unownedTotal).toBeGreaterThanOrEqual(1);
    expect(out.rows.every((r) => r.stamped === 0)).toBe(true);
    expect(after.unownedTotal).toBe(before.unownedTotal);
  });

  test("applying it stamps every unowned record, and the gate then clears", async () => {
    const store = await seedStore();
    await mongoose.connection.collection("rawitems").insertOne({
      _id: oid(), name: "Orphan Fabric", sku: "ORPHAN-1", quantity: 99,
      unit: "Mtr", variants: [], deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
    });
    await mongoose.connection.collection("purchaseorders").insertOne({
      _id: oid(), poNumber: "PO/LEGACY/0001", items: [], createdAt: new Date(), updatedAt: new Date(),
    });
    await mongoose.connection.collection("acc_companies").insertOne({
      _id: store.companyId, name: "GRAV CLOTHING PVT LTD", isPrimary: true,
    });

    await backfill.run({ apply: true });
    const after = await gate.measure();
    expect(after.unownedTotal).toBe(0);

    /* And the leak is closed: the stranger's question no longer finds it. */
    const stranger = storeReaderFor(oid());
    const out = await service.search({ user: stranger, query: "stock of Orphan Fabric" });
    expect(said(out)).not.toMatch(/Orphan Fabric/);
  });

  test("it never changes a company that is already recorded", async () => {
    const store = await seedStore();
    const other = oid();
    const kept = oid();
    await mongoose.connection.collection("rawitems").insertOne({
      _id: kept, companyId: other, name: "Someone Else's Fabric", sku: "ELSE-1",
      quantity: 5, unit: "Mtr", variants: [], deletedAt: null,
      createdAt: new Date(), updatedAt: new Date(),
    });
    await mongoose.connection.collection("acc_companies").insertOne({
      _id: store.companyId, name: "GRAV CLOTHING PVT LTD", isPrimary: true,
    });

    await backfill.run({ apply: true });
    const row = await mongoose.connection.collection("rawitems").findOne({ _id: kept });
    expect(String(row.companyId)).toBe(String(other));
  });
});
