// test/merchandising/department-description-migration.test.js
//
// THE MERCHANDISING DEPARTMENT DESCRIPTION, CORRECTED ONCE AND ONLY ONCE.
//
// Two claims, and they are the whole reason this is a migration rather than a
// line in the boot-time seeder:
//
//   · the OLD SYSTEM DEFAULT changes, because it named three other apps'
//     records as Merchandising's work;
//   · anything an administrator wrote themselves REMAINS, byte for byte —
//     including the wording they may have written precisely because the seeded
//     sentence was wrong.
//
// Plus the two properties that make it safe to hand somebody: it is idempotent,
// and a dry run writes nothing.
"use strict";

const AccessDepartment = require("../../models/Access/AccessDepartment");
const {
  DEPARTMENT_KEY, OLD_DEFAULT, NEW_DEFAULT,
  planDescriptionFix, applyDescriptionFix, describe: describeOutcome,
} = require("../../scripts/migrations/merchandising-department-description");
const { DEPARTMENTS } = require("../../services/ensureAccessDepartments");

const seed = (description) => AccessDepartment.create({
  key: DEPARTMENT_KEY, slug: "merchandiser", name: "Merchandising",
  description, dashboardPath: "/merchandiser/dashboard",
  sortOrder: 45, isSystem: true, isActive: true,
});

const descriptionOf = async () => {
  const row = await AccessDepartment.findOne({ key: DEPARTMENT_KEY }).select("description").lean();
  return row ? row.description : null;
};

test("the seeder and the migration agree on the new wording", () => {
  const seeded = DEPARTMENTS.find((d) => d.key === DEPARTMENT_KEY);
  expect(seeded.description).toBe(NEW_DEFAULT);
  /* A fresh database gets the truthful sentence with no migration at all. */
  expect(NEW_DEFAULT).toMatch(/Style execution/);
  /* And the old one named work Merchandising does not own. */
  expect(OLD_DEFAULT).toMatch(/Purchase orders/);
});

test("the old default changes", async () => {
  await seed(OLD_DEFAULT);
  const plan = await planDescriptionFix(AccessDepartment);
  expect(plan.outcome).toBe("WILL_UPDATE");

  const res = await applyDescriptionFix(AccessDepartment);
  expect(res.outcome).toBe("UPDATED");
  expect(res.updated).toBe(1);
  expect(await descriptionOf()).toBe(NEW_DEFAULT);
});

test("a custom value remains, untouched", async () => {
  const custom = "Our own words about merchandising, thanks.";
  await seed(custom);

  const plan = await planDescriptionFix(AccessDepartment);
  expect(plan.outcome).toBe("CUSTOMISED");
  expect(describeOutcome(plan, { applied: false })).toMatch(/REFUSING/);

  const res = await applyDescriptionFix(AccessDepartment);
  expect(res.updated).toBe(0);
  expect(await descriptionOf()).toBe(custom);
});

test("a near-miss is a custom value, not a default", async () => {
  /* One word different is somebody's edit, not the seeder's sentence. The
     match is exact on purpose: "close enough" is how a migration ends up
     rewriting the thing it was told to leave alone. Surrounding whitespace is
     not part of the comparison because the schema trims it before it is ever
     stored, so it cannot be what distinguishes two values. */
  const nearMiss = OLD_DEFAULT.replace("customers", "buyers");
  await seed(nearMiss);
  const res = await applyDescriptionFix(AccessDepartment);
  expect(res.outcome).toBe("CUSTOMISED");
  expect(await descriptionOf()).toBe(nearMiss);
});

test("it is idempotent — the second run changes nothing", async () => {
  await seed(OLD_DEFAULT);
  await applyDescriptionFix(AccessDepartment);
  const second = await applyDescriptionFix(AccessDepartment);
  expect(second.outcome).toBe("ALREADY_CORRECT");
  expect(second.updated).toBe(0);
  expect(await descriptionOf()).toBe(NEW_DEFAULT);
});

test("a dry run writes nothing and says what it would do", async () => {
  await seed(OLD_DEFAULT);
  const plan = await planDescriptionFix(AccessDepartment);
  expect(await descriptionOf()).toBe(OLD_DEFAULT);
  const said = describeOutcome(plan, { applied: false });
  expect(said).toMatch(/DRY RUN/);
  expect(said).toMatch(/--apply/);
  expect(said).toContain(NEW_DEFAULT);
});

test("no Merchandising row is created where none exists", async () => {
  const res = await applyDescriptionFix(AccessDepartment);
  expect(res.outcome).toBe("ABSENT");
  expect(await AccessDepartment.countDocuments({})).toBe(0);
});

test("it touches no other department", async () => {
  await seed(OLD_DEFAULT);
  await AccessDepartment.create({
    key: "sales", slug: "sales", name: "Sales",
    description: OLD_DEFAULT, dashboardPath: "/sales/dashboard",
    sortOrder: 40, isSystem: true, isActive: true,
  });

  await applyDescriptionFix(AccessDepartment);

  const sales = await AccessDepartment.findOne({ key: "sales" }).select("description").lean();
  expect(sales.description).toBe(OLD_DEFAULT);
});
