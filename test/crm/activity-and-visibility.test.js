// test/crm/activity-and-visibility.test.js — activity overdue logic + the
// server-side restricted-field (credit) permission rules.
"use strict";

const Account = require("../../models/CMS_Models/Sales/Account");
const Activity = require("../../models/CMS_Models/Sales/Activity");
const {
  canViewCredit,
  stripRestrictedAccountFields,
  stripRestrictedUpdates,
} = require("../../services/crmVisibility");

describe("activity overdue (derived, never stored)", () => {
  test("a planned task with a past due date is overdue", async () => {
    const acc = await Account.create({ companyName: "Acc" });
    const a = await Activity.create({
      accountId: acc._id,
      activityType: "task",
      subject: "Overdue task",
      status: "planned",
      dueDate: new Date(Date.now() - 86400000),
    });
    expect(a.isOverdue).toBe(true);
  });

  test("a completed task is never overdue", async () => {
    const acc = await Account.create({ companyName: "Acc" });
    const a = await Activity.create({
      accountId: acc._id,
      activityType: "task",
      subject: "Done task",
      status: "completed",
      dueDate: new Date(Date.now() - 86400000),
    });
    expect(a.isOverdue).toBe(false);
  });

  test("a future planned task is not overdue", async () => {
    const acc = await Account.create({ companyName: "Acc" });
    const a = await Activity.create({
      accountId: acc._id,
      activityType: "follow_up",
      subject: "Future",
      status: "planned",
      dueDate: new Date(Date.now() + 86400000),
    });
    expect(a.isOverdue).toBe(false);
  });
});

describe("restricted commercial fields (server-side)", () => {
  const salesUser = { role: "sales" };
  const adminUser = { role: "admin" };
  const ceoUser = { role: "ceo" };
  const approver = { role: "sales", departmentRole: "approver" };

  test("canViewCredit: sales no, admin/ceo yes, dept approver yes", () => {
    expect(canViewCredit(salesUser)).toBe(false);
    expect(canViewCredit(adminUser)).toBe(true);
    expect(canViewCredit(ceoUser)).toBe(true);
    expect(canViewCredit(approver)).toBe(true);
    expect(canViewCredit({ isAdmin: true })).toBe(true);
  });

  test("strips creditLimit/creditStatus/taxRegistrationNumber for sales", () => {
    const account = { companyName: "X", creditLimit: 500000, creditStatus: "approved", taxRegistrationNumber: "T1", city: "Pune" };
    const stripped = stripRestrictedAccountFields(account, salesUser);
    expect(stripped.creditLimit).toBeUndefined();
    expect(stripped.creditStatus).toBeUndefined();
    expect(stripped.taxRegistrationNumber).toBeUndefined();
    expect(stripped.city).toBe("Pune");
  });

  test("keeps restricted fields for admin, and never mutates the input", () => {
    const account = { companyName: "X", creditLimit: 500000 };
    const kept = stripRestrictedAccountFields(account, adminUser);
    expect(kept.creditLimit).toBe(500000);
    expect(account.creditLimit).toBe(500000); // original untouched
  });

  test("drops restricted keys from an unauthorized update body", () => {
    const body = { companyName: "New", creditLimit: 999 };
    const cleaned = stripRestrictedUpdates(body, salesUser);
    expect(cleaned.creditLimit).toBeUndefined();
    expect(cleaned.companyName).toBe("New");
  });
});
