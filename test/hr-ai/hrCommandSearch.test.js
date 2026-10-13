// test/hr-ai/hrCommandSearch.test.js
//
// CMD/CTRL K FOR HR — WHAT A ROLE MAY READ, AND NEVER A PRIVATE FIELD.
//
// Two people are called Ravi, one person has left, and every protected value
// the HR field policy names is planted (test/support/hrCommandFixtures.js) —
// so an answer that named the wrong Ravi, listed somebody who left, or let a
// salary, an Aadhaar number or a leave's medical reason through would show.
"use strict";

const fs = require("fs");
const path = require("path");
const service = require("../../services/ai/hrCommandSearch.service");
const C = require("../../services/ai/hrCommandContract");
const { CAPABILITIES: CAP, ROLE_TEMPLATES, DEPARTMENT_ROLE_TEMPLATE } = require("../../services/access/hrCapabilities");
const { seedHr, SECRETS, NOW } = require("../support/hrCommandFixtures");

const ROLE = (name) => new Set(ROLE_TEMPLATES[DEPARTMENT_ROLE_TEMPLATE[name]]);
const VIEWER = () => ROLE("viewer");
const EDITOR = () => ROLE("editor");
const APPROVER = () => ROLE("approver");
const CEO = () => new Set(ROLE_TEMPLATES.ceo_projection);

let ids;
beforeEach(async () => {
  ids = await seedHr();
});

const ask = (query, capabilities = APPROVER()) => service.search({ capabilities, query, now: NOW });
const rows = (out) => (out.groups || []).flatMap((g) => g.results);
/* Who is LISTED — a card's "Reports to" names somebody too, and that is not a listing. */
const listed = (out) => rows(out).map((r) => r.title).join(" || ");
const said = (out) => [out.note || "", ...rows(out).map((r) => `${r.title} ${r.subtitle || ""} ${r.value || ""} ${JSON.stringify(r.card || "")}`)].join(" || ");

describe("a person, by what you would type", () => {
  test("an employee code opens that person, with a card of directory facts", async () => {
    const out = await ask("GR0067");
    const [row] = rows(out);
    expect(row.href).toBe(`/hr/dashboard/employees/${ids.ravi}`);
    expect(row.card.lead).toBe(true);
    const fact = (label) => row.card.facts.find((f) => f.label === label)?.value;
    expect([fact("Employee ID"), fact("Department"), fact("Designation"), fact("Reports to")]).toEqual(["GR0067", "Cutting", "Tailor", "Asha Mehta"]);
  });

  test("a full name names one Ravi; a first name offers both, never somebody else", async () => {
    expect(rows(await ask("Ravi Kumar")).map((r) => r.title)).toEqual(["Ravi Kumar"]);
    const both = rows(await ask("Ravi")).filter((r) => r.entityType === "employee").map((r) => r.title).sort();
    expect(both).toEqual(["Ravi Kumar", "Ravi Sharma"]);
  });

  test("'who is Ravi Kumar's manager' looks up Ravi Kumar — the card says who", async () => {
    const [row] = rows(await ask("who is Ravi Kumar's manager"));
    expect(row.title).toBe("Ravi Kumar");
    expect(row.card.facts.find((f) => f.label === "Reports to").value).toBe("Asha Mehta");
  });

  test("a department by name, with its head and headcount", async () => {
    const [row] = rows(await ask("Cutting"));
    expect(row.href).toBe(`/hr/dashboard/departments/${ids.cutting}`);
    /* Two active people in Cutting; the one who left is not counted. */
    expect(row.card.facts.find((f) => f.label === "Employees").value).toBe("2");
  });

  test("a name said loosely finds the closest people, marked as near matches", async () => {
    const out = await ask("Ravee Kumaar");
    expect(out.note).toBe('No exact match for "Ravee Kumaar" — closest matches.');
    expect(rows(out)[0].title).toBe("Ravi Kumar");
    expect(rows(out)[0].metadata.approximate).toBe(true);
    /* Only from what the role may read: the CEO view has no recruitment. */
    expect(said(await ask("Senior Taylor", CEO()))).not.toMatch(/Senior Tailor/);
  });

  test("a name nobody has finds nothing", async () => {
    expect((await ask("Zorawar Qadri")).state).toBe("no_match");
  });
});

describe("people, filtered", () => {
  test("employees in a department — the active ones only", async () => {
    const out = listed(await ask("employees in cutting department"));
    expect(out).toMatch(/Ravi Kumar/);
    expect(out).toMatch(/Asha Mehta/);
    expect(out).not.toMatch(/Ravi Sharma|Old Timer/);
  });

  test("how many, interns, inactive, by designation, a manager's team", async () => {
    expect(rows(await ask("how many employees"))[0].title).toBe("There are 4 active employees.");
    expect(said(await ask("interns"))).toMatch(/Priya Nair/);
    expect(listed(await ask("interns"))).not.toMatch(/Ravi/);
    expect(said(await ask("inactive employees"))).toMatch(/Old Timer/);
    expect(said(await ask("inactive employees"))).not.toMatch(/Ravi Kumar/);
    expect(said(await ask("tailors"))).toMatch(/Ravi Kumar/);
    const team = listed(await ask("Asha's team"));
    expect(team).toMatch(/Ravi Kumar/);
    expect(team).not.toMatch(/Old Timer|Priya/);
  });

  test("who joined, and a date range that does not say which date is refused", async () => {
    const joined = listed(await ask("new joiners this month"));
    expect(joined).toMatch(/Ravi Kumar/);
    expect(joined).not.toMatch(/Priya|Asha/);
    expect((await ask("employees this month")).state).toBe("needs_clarification");
  });

  test("a department word that names nobody is never dropped", async () => {
    const out = await ask("employees in Nowhere");
    expect(out.state).toBe("no_match");
    expect(rows(out)).toEqual([]);
  });
});

describe("attendance", () => {
  test("who is absent today — HR's own correction of a day wins over the system's guess", async () => {
    const out = await ask("who is absent today");
    expect(said(out)).toMatch(/Ravi Kumar/);
    /* Asha was predicted absent and HR marked her present. */
    expect(said(out)).not.toMatch(/Asha/);
    expect(rows(out)[0].title).toBe("1 person is absent on 8 Oct 2026.");
  });

  test("late, on leave, and the day at a glance", async () => {
    expect(said(await ask("late today"))).toMatch(/Ravi Sharma/);
    /* As translation renders "ଆଜି କିଏ ଅନୁପସ୍ଥିତ" — and a missed PUNCH stays a missed punch. */
    expect(rows(await ask("who is missing today"))[0].title).toBe("1 person is absent on 8 Oct 2026.");
    expect(said(await ask("employees on leave today"))).toMatch(/Priya Nair/);
    expect(rows(await ask("attendance today"))[0].title).toMatch(/^8 Oct 2026: 2 present, 1 late, 1 absent, 1 on leave — of 4 on the roll\.$/);
  });

  test("one person's day, with their punches; one person's month", async () => {
    const [day] = rows(await ask("was Ravi Kumar present on 3 Oct"));
    expect(day.title).toBe("Ravi Kumar was present on 3 Oct 2026 (in 9:28 am, out 6:35 pm).");
    expect(day.card.lead).toBe(false);
    const [month] = rows(await ask("attendance of GR0067 this month"));
    expect(month.title).toBe("Ravi Kumar, this month: 1 present, 1 absent, 1 on leave — 3 days recorded.");
  });

  test("a list over a range is refused; a day not yet come says so", async () => {
    expect((await ask("absent this month")).state).toBe("needs_clarification");
    expect((await ask("absent tomorrow")).note).toMatch(/has not happened yet/);
  });
});

describe("leave", () => {
  test("pending means awaiting a decision — the manager's or HR's", async () => {
    const out = said(await ask("pending leave requests"));
    expect(out).toMatch(/Ravi Kumar — sick leave/);
    expect(out).toMatch(/Ravi Sharma — privilege leave/);
    expect(out).not.toMatch(/Asha/);
  });

  test("by type and period, and by person", async () => {
    const sick = said(await ask("sick leaves this month"));
    expect(sick).toMatch(/Ravi Kumar/);
    expect(sick).not.toMatch(/Sharma|Asha/);
    expect(said(await ask("leaves of Asha"))).toMatch(/casual leave/);
  });

  test("a person nobody is called answers nothing — never every leave", async () => {
    const out = await ask("leaves of Nobody Atall");
    expect(out.state).toBe("no_match");
    expect(said(out)).not.toMatch(/Ravi|Asha/);
  });

  test("a leave balance, this calendar year", async () => {
    expect(rows(await ask("CL balance of Ravi Kumar"))[0].title).toBe("Ravi Kumar, 2026: CL 3 of 7 left, SL 5 of 7 left, PL 10 of 15 left.");
    expect(rows(await ask("leave balance of Asha"))[0].title).toBe("No leave balance is recorded for Asha Mehta in 2026.");
  });

  test("a balance asked the way a translated Hindi or Odia question comes out", async () => {
    const want = "Ravi Kumar, 2026: CL 3 of 7 left, SL 5 of 7 left, PL 10 of 15 left.";
    expect(rows(await ask("how much leave does Ravi Kumar have left"))[0].title).toBe(want);
    expect(rows(await ask("how many leaves are left for Ravi Kumar"))[0].title).toBe(want);
    expect(rows(await ask("how much is Ravi Kumar's vacation left"))[0].title).toBe(want);
    /* "pending leave" is still the requests, not a balance. */
    expect(said(await ask("pending leave requests"))).toMatch(/Ravi Kumar — sick leave/);
  });

  test("holidays: the next one, the year's, one by name", async () => {
    expect(rows(await ask("next holiday"))[0].title).toBe("The next holiday is Dussehra, on 20 Oct 2026.");
    expect(rows(await ask("holidays this year"))[0].title).toBe("3 holidays this year.");
  });
});

describe("corrections, overtime, recruitment, letters, payroll, policies", () => {
  test("pending attendance corrections; overtime yesterday", async () => {
    const corr = said(await ask("pending attendance corrections"));
    expect(corr).toMatch(/Ravi Kumar — Miss punch/);
    expect(corr).not.toMatch(/Asha/);
    const ot = said(await ask("overtime yesterday"));
    expect(ot).toMatch(/Asha Mehta/);
    expect(ot).not.toMatch(/Ravi Sharma/);
  });

  test("open jobs, candidates by stage, interviews this week", async () => {
    const open = said(await ask("open jobs"));
    expect(open).toMatch(/Senior Tailor/);
    expect(open).not.toMatch(/Accountant/);
    const hr = said(await ask("candidates in hr interview"));
    expect(hr).toMatch(/Meena Das/);
    expect(hr).not.toMatch(/Kiran/);
    expect(said(await ask("interviews this week"))).toMatch(/Meena Das/);
    expect((await ask("jobs this month")).state).toBe("needs_clarification");
  });

  test("a letter by its reference number; requested letters", async () => {
    const [letter] = rows(await ask("GRAV/HR/2026/014"));
    expect(letter.title).toBe("Offer letter — Ravi Kumar");
    const requested = said(await ask("requested letters"));
    expect(requested).toMatch(/Experience letter — Ravi Sharma/);
    expect(requested).not.toMatch(/Offer/);
  });

  test("payroll runs by month and status — never an amount", async () => {
    const out = said(await ask("payroll September 2026", EDITOR()));
    expect(out).toMatch(/September 2026 payroll/);
    expect(out).toMatch(/Approved/);
    expect(out).not.toMatch(/12,34,567|1234567/);
  });

  test("C4 policies", async () => {
    expect(said(await ask("c4 policies"))).toMatch(/Late arrival.*−2 points/);
  });
});

describe("what a role may read", () => {
  test("no HR access, no answer", async () => {
    expect((await ask("Ravi Kumar", new Set())).state).toBe("unauthorised");
  });

  test("a viewer reads the directory and leave, but not payroll", async () => {
    expect((await ask("pending leave requests", VIEWER())).state).toBe("answered");
    const payroll = await ask("payroll September 2026", VIEWER());
    expect(payroll.state).toBe("unauthorised");
    expect(payroll.note).toBe("Your HR role does not include payroll runs.");
  });

  test("the CEO's read-only view has no recruitment and no letters — not even in a name search", async () => {
    expect((await ask("open jobs", CEO())).state).toBe("unauthorised");
    expect((await ask("requested letters", CEO())).state).toBe("unauthorised");
    expect((await ask("Meena Das", CEO())).state).toBe("no_match");
    expect((await ask("who is absent today", CEO())).state).toBe("answered");
  });

  test("each family asks for exactly the capability its own screen declares", () => {
    const { findDeclaration } = require("../../services/access/hrRouteContract");
    const SCREEN = {
      employee: ["GET", "/api/employees/all"],
      department: ["GET", "/api/hr/departments/with-designations"],
      attendance: ["GET", "/hr/attendance/daily"],
      correction: ["GET", "/hr/attendance/regularizations"],
      leave: ["GET", "/api/hr/leaves"],
      job: ["GET", "/api/hr/job-postings/dashboard/jobs"],
      candidate: ["GET", "/api/hr/candidates/x"],
      document: ["GET", "/api/hr/documents"],
      payroll: ["GET", "/api/hr/payroll/runs"],
    };
    for (const [family, [method, url]] of Object.entries(SCREEN)) {
      const declared = findDeclaration(method, url);
      expect([family, Boolean(declared)]).toEqual([family, true]);
      expect([family, declared.capabilities.includes(C.familyById(family).capability)]).toEqual([family, true]);
    }
  });
});

describe("what it never shows", () => {
  test("no planted private or protected value appears, for the widest role, whatever is asked", async () => {
    const owner = new Set(ROLE_TEMPLATES[DEPARTMENT_ROLE_TEMPLATE.owner]);
    const queries = [
      "GR0067", "Ravi Kumar", "Ravi", "employees in cutting", "attendance of Ravi Kumar this month", "pending leave requests",
      "leaves of Ravi Kumar", "leave balance of Ravi Kumar", "Meena Das", "candidates in hr interview", "Senior Tailor",
      "GRAV/HR/2026/014", "letters of Ravi Kumar", "payroll September 2026", "payroll", "who is Ravi Kumar's manager",
      "ravi.home@example.com", "9876501234", "123412341234",
    ];
    for (const query of queries) {
      // eslint-disable-next-line no-await-in-loop
      const shown = JSON.stringify(await ask(query, owner));
      for (const [name, secret] of Object.entries(SECRETS)) {
        expect([query, name, shown.includes(String(secret))]).toEqual([query, name, false]);
      }
    }
  });

  test("a private phone or email typed into the box finds nobody — they are not searched", async () => {
    expect((await ask(SECRETS.phone)).state).toBe("no_match");
    expect((await ask(SECRETS.personalEmail)).state).toBe("no_match");
  });

  test("the fields read are allow-listed, and none is protected", () => {
    const all = Object.values(C.PROJECTIONS).join(" ").split(/\s+/);
    for (const forbidden of ["salary", "bankDetails", "phone", "alternatePhone", "personalEmail", "address", "dateOfBirth",
      "documents", "bloodGroup", "password", "temporaryPassword", "reason", "expectedSalary", "salaryRange",
      "letterMeta.annualCTC", "hrNotes", "totalNetPay", "totalGross", "totalDeductions", "embedding"]) {
      expect([forbidden, all.some((f) => f === forbidden || f.startsWith(`${forbidden}.`))]).toEqual([forbidden, false]);
    }
    expect(C.PROJECTIONS.candidate).not.toMatch(/\bemail\b/);
  });

  test("no model on this path, and the door is read-only, declared, and HR's", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "services", "ai", "hrCommandSearch.service.js"), "utf8");
    expect(src).not.toMatch(/require\(["'][^"']*(qwen|ollama|gravAssistant|hrTools|gemini)/i);
    const route = fs.readFileSync(path.join(__dirname, "..", "..", "routes", "HrRoutes", "HrCommandSearch.js"), "utf8");
    expect(route.match(/router\.(post|get|put|patch|delete)\(/g)).toEqual(["router.get("]);
    const { findDeclaration } = require("../../services/access/hrRouteContract");
    expect(findDeclaration("GET", "/api/hr/command-search").capabilities).toEqual([CAP.HR_ACCESS]);
    const { MOUNTS } = require("../../services/access/hrMountRegistry");
    expect(MOUNTS).toContainEqual(["/api/hr/command-search", "./routes/HrRoutes/HrCommandSearch"]);
  });
});
