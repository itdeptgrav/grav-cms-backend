// test/rnd/demo-access-seed.test.js
//
// THE DEMO ACCESS SEEDER IS SAFE TO RUN TWICE.
//
// The 3D workspace was unreachable for its first reader because nobody held an
// R&D grant, and the fix was a seeder that arranges three — an editor, a
// separate approver and a viewer. A seeder of GRANTS is a different kind of
// script from a seeder of sample rows: run twice it must not double anybody's
// access, and run against a database that already has the grants it must
// change nothing and say so. Both are claims about behaviour, so they are
// tested here rather than asserted in the script's own header.
//
// Each test arranges its own department and company, because the shared
// harness (test/setup.js) empties every collection between tests — so a second
// `seed()` call inside ONE test is what "run it twice" means here.
//
// What is deliberately NOT tested: the password. The seeder writes it to a
// git-ignored file and never returns or prints it, so there is nothing to
// assert against. `RND_DEMO_PASSWORD` is set below precisely so these runs do
// not write that file into the repository.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
process.env.RND_DEMO_PASSWORD = "seed-test-only-not-a-real-credential";
process.env.RND_SEED_QUIET = "1";

const mongoose = require("mongoose");

const AccessDepartment = require("../../models/Access/AccessDepartment");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const DeptUser = require("../../models/Access/DeptUser");
const Employee = require("../../models/Employee");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");

const { seed, DEMO, SLUG } = require("../../scripts/seed/rndWorkspaceAccess");

const EDITOR = "rnd.editor.demo@grav.demo";
const VIEWER = "rnd.viewer.demo@grav.demo";
const emails = DEMO.map((d) => d.email);
const grants = () => DepartmentRole.find({ departmentSlug: SLUG }).lean();
const viewerRow = async () => (await grants()).find((r) => r.email === VIEWER);

/** The two things the seeder refuses to invent for itself. */
async function fixtures() {
  await AccessDepartment.create({
    slug: SLUG, key: "research_development", name: "Research & Development",
    dashboardPath: "/research-development", isActive: true,
  });
  await Acc_Company.create({
    companyName: "GRAV CLOTHING PVT LTD", booksFromDate: new Date("2026-04-01"),
  });
}

describe("the R&D demo access seeder", () => {
  test("the first run arranges an editor, a separate approver and a viewer", async () => {
    await fixtures();
    const manifest = await seed();

    expect(manifest.company).toMatch(/GRAV CLOTHING/i);
    expect(manifest.accounts.map((a) => a.role).sort()).toEqual(["approver", "editor", "viewer"]);
    /* Three DIFFERENT people. A model's publisher cannot accept their own
       work, so a demo with one account holding both roles cannot show an
       approval at all — the separation is part of what is being seeded. */
    expect(new Set(manifest.accounts.map((a) => a.email)).size).toBe(3);

    expect((await grants()).map((r) => `${r.email}:${r.role}:${r.isActive}`).sort()).toEqual([
      "rnd.approver.demo@grav.demo:approver:true",
      "rnd.editor.demo@grav.demo:editor:true",
      "rnd.viewer.demo@grav.demo:viewer:true",
    ]);

    /* Each one can also reach a company, which is the other half of the
       original failure: a grant with no membership still refuses. */
    for (const email of emails) {
      expect(await SpCompanyMembership.countDocuments({ email, isActive: true })).toBe(1);
      expect(await DeptUser.countDocuments({ email, isActive: true })).toBe(1);
      expect(await Employee.countDocuments({ email })).toBe(1);
    }
  });

  test("a second run changes nothing, and says so rather than staying silent", async () => {
    await fixtures();
    await seed();
    const again = await seed();

    for (const account of again.accounts) {
      expect(account.grant).toBe(`already ${account.role}`);
      expect(account.membership).toBe("already active");
    }
    /* The unique index would stop a duplicate GRANT on its own; nothing stops
       a second membership, employee or sign-in account, so those are counted. */
    expect(await grants()).toHaveLength(3);
    for (const email of emails) {
      expect(await SpCompanyMembership.countDocuments({ email })).toBe(1);
      expect(await Employee.countDocuments({ email })).toBe(1);
      expect(await DeptUser.countDocuments({ email })).toBe(1);
    }
  });

  test("it repairs a grant that was revoked, instead of leaving it dead", async () => {
    await fixtures();
    await seed();
    await DepartmentRole.updateOne({ departmentSlug: SLUG, email: VIEWER }, { $set: { isActive: false } });
    await SpCompanyMembership.updateOne({ email: VIEWER }, { $set: { isActive: false } });

    await seed();

    expect((await viewerRow()).isActive).toBe(true);
    expect((await viewerRow()).role).toBe("viewer");
    expect(await SpCompanyMembership.countDocuments({ email: VIEWER, isActive: true })).toBe(1);
    expect(await grants()).toHaveLength(3);
  });

  test("it does not quietly leave the viewer holding something it could approve with", async () => {
    await fixtures();
    await seed();
    await DepartmentRole.updateOne({ departmentSlug: SLUG, email: VIEWER }, { $set: { role: "owner" } });

    await seed();

    /* The seeder STATES each demo account's role, so a hand-edited row is put
       back to what the demo is meant to show — downwards as well as up. */
    expect((await viewerRow()).role).toBe("viewer");
  });

  test("a dry run reports what it would do and writes nothing", async () => {
    await fixtures();

    /* `--dry-run` is read from argv when the module loads, so it is exercised
       the way an operator uses it: as a separate process, against this same
       in-memory database. */
    const client = mongoose.connection.getClient();
    const [host, query] = String(client.s.url).replace(/^mongodb:\/\//, "").split("/?");
    const uri = `mongodb://${host}/${mongoose.connection.name}${query ? `?${query}` : ""}`;

    const out = require("child_process").execFileSync(process.execPath, [
      "scripts/seed/rndWorkspaceAccess.js", "--dry-run", "--company", "GRAV CLOTHING",
    ], { env: { ...process.env, MONGODB_URI: uri, RND_SEED_QUIET: "" }, encoding: "utf8" });

    expect(out).toMatch(/DRY RUN/);
    expect(out).toMatch(/would set none → editor/);
    expect(out).toMatch(/Nothing was written/);
    /* And nothing was. */
    expect(await grants()).toHaveLength(0);
    expect(await SpCompanyMembership.countDocuments({ email: EDITOR })).toBe(0);
  });
});
