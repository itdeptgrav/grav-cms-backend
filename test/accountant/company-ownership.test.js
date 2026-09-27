// test/accountant/company-ownership.test.js
//
// ONE ACCOUNTING COMPANY HAS EXACTLY ONE ORGANISATION OWNER (decision D2).
//
// `Acc_Organization.tallyCompanyIds[]` was always the ownership record, but
// nothing enforced that a company appeared in only one of them. The one
// production path that assigned ownership did this:
//
//     org.tallyCompanyIds = companies.map((c) => c._id);
//
// — every company in the database, handed to whichever organisation asked
// first. That was harmless only because the deployment has a single
// organisation, which is a fact about the data and not a rule.
//
// What is being defended here is the rule, and specifically that it survives
// CONCURRENCY. A read-then-write check in application code is defeated by two
// requests interleaving; these tests therefore go at the database as well as
// at the service, including one that writes straight past the service to prove
// the index is what actually holds the line.
"use strict";

const mongoose = require("mongoose");

const {
  Acc_Organization,
} = require("../../models/Accountant_model/Acc_OrgModels");

const {
  OWNERSHIP_INDEX_NAME,
  COMPANY_OWNERSHIP_CODES,
  normaliseCompanyIds,
  attachCompaniesToOrganization,
  findOwnershipConflicts,
} = require("../../services/accountantCompanyOwnership.service");

let seq = 0;
const newCompanyId = () => new mongoose.Types.ObjectId();

async function makeOrg(tallyCompanyIds = []) {
  return Acc_Organization.create({ name: `Org ${++seq}`, tallyCompanyIds });
}

const idsOf = async (org) =>
  (await Acc_Organization.findById(org._id).lean()).tallyCompanyIds.map(String);

beforeAll(async () => {
  // `autoIndex` is on outside production, but index creation is asynchronous.
  // Without this the first test can race the index build and pass for the
  // wrong reason — the very failure mode this suite exists to rule out.
  await Acc_Organization.init();
});

/* ================================================================== */
/* 1. The index itself                                                 */
/* ================================================================== */

describe("the ownership index", () => {
  test("exists, is unique, and is partial on the array element type", async () => {
    const indexes = await Acc_Organization.collection.indexes();
    const ix = indexes.find((i) => i.name === OWNERSHIP_INDEX_NAME);

    expect(ix).toBeTruthy();
    expect(ix.unique).toBe(true);
    expect(ix.key).toEqual({ tallyCompanyIds: 1 });
    // The partial filter is what keeps "owns nothing" legal — an empty array
    // indexes as a single `undefined` key, so without it the second
    // organisation owning nothing would collide with the first.
    expect(ix.partialFilterExpression).toEqual({
      tallyCompanyIds: { $type: "objectId" },
    });
  });
});

/* ================================================================== */
/* 2. The invariant, enforced by MongoDB                               */
/* ================================================================== */

describe("two organisations cannot own the same company", () => {
  test("the second insert is refused by the database", async () => {
    const shared = newCompanyId();
    await makeOrg([shared]);

    // Straight at the model — no service, no pre-check. If this succeeds the
    // invariant is application-level only, which is what we are refusing.
    await expect(makeOrg([shared])).rejects.toMatchObject({ code: 11000 });
  });

  test("an update that would claim another organisation's company is refused", async () => {
    const shared = newCompanyId();
    await makeOrg([shared]);
    const other = await makeOrg([newCompanyId()]);

    await expect(
      Acc_Organization.updateOne(
        { _id: other._id },
        { $addToSet: { tallyCompanyIds: shared } },
      ),
    ).rejects.toMatchObject({ code: 11000 });

    expect(await idsOf(other)).not.toContain(String(shared));
  });

  test("one organisation may own many companies", async () => {
    const a = newCompanyId();
    const b = newCompanyId();
    const c = newCompanyId();
    const org = await makeOrg([a, b, c]);
    expect((await idsOf(org)).sort()).toEqual([a, b, c].map(String).sort());
  });

  test("any number of organisations may own nothing", async () => {
    await makeOrg([]);
    await makeOrg([]);
    await makeOrg([]);
    // …including one with the field absent entirely.
    await Acc_Organization.collection.insertOne({ name: "No field", isActive: true });

    expect(await Acc_Organization.countDocuments({})).toBe(4);
  });

  test("an organisation can be emptied and its company claimed by another", async () => {
    // Ownership has to be transferable, or a company is stranded forever.
    const company = newCompanyId();
    const first = await makeOrg([company]);
    const second = await makeOrg([]);

    await Acc_Organization.updateOne(
      { _id: first._id },
      { $pull: { tallyCompanyIds: company } },
    );
    const moved = await attachCompaniesToOrganization({
      organizationId: second._id,
      companyIds: [company],
    });

    expect(moved.ok).toBe(true);
    expect(await idsOf(second)).toEqual([String(company)]);
    expect(await idsOf(first)).toEqual([]);
  });
});

/* ================================================================== */
/* 3. The service                                                      */
/* ================================================================== */

describe("attachCompaniesToOrganization", () => {
  test("attaches a company to an organisation that owns nothing", async () => {
    const org = await makeOrg([]);
    const company = newCompanyId();

    const res = await attachCompaniesToOrganization({
      organizationId: org._id,
      companyIds: [company],
    });

    expect(res.ok).toBe(true);
    expect(res.attached).toEqual([String(company)]);
    expect(res.alreadyAttached).toEqual([]);
    expect(await idsOf(org)).toEqual([String(company)]);
  });

  test("is idempotent for the current owner", async () => {
    const company = newCompanyId();
    const org = await makeOrg([company]);

    const res = await attachCompaniesToOrganization({
      organizationId: org._id,
      companyIds: [company],
    });

    expect(res.ok).toBe(true);
    expect(res.attached).toEqual([]);
    expect(res.alreadyAttached).toEqual([String(company)]);
    // Re-attaching must not duplicate the entry inside the owner's own array —
    // the index does not constrain that, `$addToSet` does.
    expect(await idsOf(org)).toEqual([String(company)]);
  });

  test("repeated calls stay idempotent", async () => {
    const org = await makeOrg([]);
    const companies = [newCompanyId(), newCompanyId()];

    for (let i = 0; i < 3; i++) {
      const res = await attachCompaniesToOrganization({
        organizationId: org._id,
        companyIds: companies,
      });
      expect(res.ok).toBe(true);
    }
    expect((await idsOf(org)).sort()).toEqual(companies.map(String).sort());
  });

  test("refuses a company owned by another organisation, naming the company", async () => {
    const shared = newCompanyId();
    await makeOrg([shared]);
    const org = await makeOrg([]);

    const res = await attachCompaniesToOrganization({
      organizationId: org._id,
      companyIds: [shared],
    });

    expect(res.ok).toBe(false);
    expect(res.code).toBe(COMPANY_OWNERSHIP_CODES.ALREADY_OWNED);
    expect(res.status).toBe(409);
    expect(res.companyId).toBe(String(shared));
  });

  test("the refusal says nothing about the organisation that holds it", async () => {
    const shared = newCompanyId();
    const holder = await makeOrg([shared]);
    const org = await makeOrg([]);

    const res = await attachCompaniesToOrganization({
      organizationId: org._id,
      companyIds: [shared],
    });

    const body = JSON.stringify(res);
    expect(body).not.toContain(String(holder._id));
    expect(body).not.toContain(holder.name);
  });

  test("bulk attachment is all-or-nothing when one company conflicts", async () => {
    const contested = newCompanyId();
    await makeOrg([contested]);

    const org = await makeOrg([]);
    const free = [newCompanyId(), newCompanyId()];

    const res = await attachCompaniesToOrganization({
      organizationId: org._id,
      companyIds: [...free, contested],
    });

    expect(res.ok).toBe(false);
    expect(res.code).toBe(COMPANY_OWNERSHIP_CODES.ALREADY_OWNED);
    // The free companies must NOT have been attached. A half-populated
    // organisation is harder to reason about than an empty one, and it hides
    // which company was the problem.
    expect(await idsOf(org)).toEqual([]);
  });

  test("concurrent claims from different organisations: exactly one wins", async () => {
    // The real race, run for real rather than simulated. A read-then-write
    // check in application code is defeated by exactly this interleaving, so
    // the contract is: one winner per company, and every loser gets the
    // ordinary ownership refusal rather than a raw driver error.
    const contested = newCompanyId();
    const orgs = await Promise.all([makeOrg([]), makeOrg([]), makeOrg([])]);

    const results = await Promise.all(
      orgs.map((o) =>
        attachCompaniesToOrganization({
          organizationId: o._id,
          companyIds: [contested],
        }),
      ),
    );

    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(2);
    for (const loser of losers) {
      expect(loser.code).toBe(COMPANY_OWNERSHIP_CODES.ALREADY_OWNED);
      expect(loser.companyId).toBe(String(contested));
    }

    // And the database agrees: the company sits in exactly one organisation.
    const holders = await Acc_Organization.countDocuments({
      tallyCompanyIds: contested,
    });
    expect(holders).toBe(1);
  });

  test("a duplicate-key error from the write is translated, not leaked", async () => {
    // The branch the concurrency test reaches only sometimes, pinned
    // deterministically: the pre-check passes, the index refuses the write.
    // What must come back is the ordinary ownership refusal — not an E11000,
    // not a 500, and nothing naming an index or a collection.
    const contested = newCompanyId();
    const org = await makeOrg([]);

    const spy = jest
      .spyOn(Acc_Organization, "updateOne")
      .mockImplementationOnce(() => {
        const err = new Error("E11000 duplicate key error collection: crm_test.acc_organizations");
        err.code = 11000;
        err.keyValue = { tallyCompanyIds: contested };
        return Promise.reject(err);
      });

    try {
      const res = await attachCompaniesToOrganization({
        organizationId: org._id,
        companyIds: [contested],
      });

      expect(res.ok).toBe(false);
      expect(res.code).toBe(COMPANY_OWNERSHIP_CODES.ALREADY_OWNED);
      expect(res.status).toBe(409);
      expect(res.companyId).toBe(String(contested));

      const body = JSON.stringify(res);
      expect(body).not.toMatch(/E11000|duplicate key|acc_organizations|index/i);
      expect(await idsOf(org)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  test("an unknown organisation is refused without touching anything", async () => {
    const res = await attachCompaniesToOrganization({
      organizationId: new mongoose.Types.ObjectId(),
      companyIds: [newCompanyId()],
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(COMPANY_OWNERSHIP_CODES.ORGANIZATION_NOT_FOUND);
  });

  test("attaching an empty set succeeds and changes nothing", async () => {
    const company = newCompanyId();
    const org = await makeOrg([company]);
    const res = await attachCompaniesToOrganization({
      organizationId: org._id,
      companyIds: [],
    });
    expect(res.ok).toBe(true);
    expect(await idsOf(org)).toEqual([String(company)]);
  });
});

describe("normaliseCompanyIds", () => {
  test("accepts ObjectIds, strings and documents carrying _id", () => {
    const id = newCompanyId();
    expect(normaliseCompanyIds(id).ids).toEqual([String(id)]);
    expect(normaliseCompanyIds(String(id)).ids).toEqual([String(id)]);
    expect(normaliseCompanyIds([{ _id: id }]).ids).toEqual([String(id)]);
  });

  test("de-duplicates", () => {
    const id = newCompanyId();
    expect(normaliseCompanyIds([id, String(id), { _id: id }]).ids).toEqual([String(id)]);
  });

  test.each([["banana"], [""], [null], [{}], ["0123456789abcdef0123456"]])(
    "refuses %p",
    (bad) => {
      const res = normaliseCompanyIds([bad]);
      expect(res.ok).toBe(false);
      expect(res.code).toBe(COMPANY_OWNERSHIP_CODES.INVALID_ID);
    },
  );

  test("does not echo the rejected value back", () => {
    const res = normaliseCompanyIds(["<script>alert(1)</script>"]);
    expect(JSON.stringify(res)).not.toContain("script");
  });
});

describe("findOwnershipConflicts", () => {
  test("is empty when every company has one owner", async () => {
    await makeOrg([newCompanyId(), newCompanyId()]);
    await makeOrg([newCompanyId()]);
    await makeOrg([]);
    expect(await findOwnershipConflicts()).toEqual([]);
  });

  test("reports the company and every organisation claiming it", async () => {
    // This is the PRE-MIGRATION state, and the index now makes it
    // unrepresentable — which is the point of the index, and the reason the
    // readiness script has to run before it. So the index comes off for the
    // duration and goes straight back on.
    const shared = newCompanyId();
    const a = new mongoose.Types.ObjectId();
    const b = new mongoose.Types.ObjectId();

    await Acc_Organization.collection.dropIndex(OWNERSHIP_INDEX_NAME);
    try {
      await Acc_Organization.collection.insertMany([
        { _id: a, name: "A", tallyCompanyIds: [shared] },
        { _id: b, name: "B", tallyCompanyIds: [shared] },
      ]);

      const conflicts = await findOwnershipConflicts();
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].companyId).toBe(String(shared));
      expect(conflicts[0].organizationIds.sort()).toEqual([String(a), String(b)].sort());

      // And the index cannot be rebuilt while the conflict stands — the exact
      // refusal the migration script reports rather than forcing.
      await expect(
        Acc_Organization.collection.createIndex(
          { tallyCompanyIds: 1 },
          {
            unique: true,
            name: OWNERSHIP_INDEX_NAME,
            partialFilterExpression: { tallyCompanyIds: { $type: "objectId" } },
          },
        ),
      ).rejects.toMatchObject({ code: 11000 });
    } finally {
      await Acc_Organization.collection.deleteMany({ _id: { $in: [a, b] } });
      await Acc_Organization.collection.createIndex(
        { tallyCompanyIds: 1 },
        {
          unique: true,
          name: OWNERSHIP_INDEX_NAME,
          partialFilterExpression: { tallyCompanyIds: { $type: "objectId" } },
        },
      );
    }
  });
});

/* ================================================================== */
/* 4. No second source of ownership                                    */
/* ================================================================== */

describe("ownership has exactly one source", () => {
  test("no financial model gained an organizationId field", () => {
    // The decision was explicit: `tallyCompanyIds` stays canonical and
    // `organizationId` is NOT copied onto financial records. A second copy is
    // a second answer, and the two drift.
    const FINANCIAL = [
      ["Acc_VoucherModels", ["Acc_Voucher"]],
      ["Acc_MasterModels", ["Acc_Company", "Acc_Ledger", "Acc_Group", "Acc_CostCentre", "Acc_StockItem"]],
      [
        "Acc_OperationalModels",
        ["Acc_Invoice", "Acc_Expense", "Acc_BankTransaction", "Acc_Budget", "Acc_JournalEntry", "Acc_TaxFiling"],
      ],
    ];

    const offenders = [];
    for (const [file, models] of FINANCIAL) {
      const mod = require(`../../models/Accountant_model/${file}`);
      for (const name of models) {
        const model = mod[name];
        if (!model) continue;
        if (model.schema.path("organizationId")) offenders.push(`${name}.organizationId`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the organisation document is still where ownership lives", () => {
    expect(Acc_Organization.schema.path("tallyCompanyIds")).toBeTruthy();
  });
});
