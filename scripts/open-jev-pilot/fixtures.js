"use strict";
/**
 * Synthetic, permission-scoped fixtures for the Open-Jev routing pilot.
 *
 * Nothing here is read from, or written to, a database. Names are invented;
 * "Rishee Ray" stands in for the example question in the pilot decision. The
 * evaluation clock is fixed at 11:00 IST on 22 Sep 2026.
 */

const { ROLE_TEMPLATES } = require("../../services/access/hrCapabilities");

const NOW = new Date("2026-09-22T05:30:00.000Z"); // 11:00 IST
const TODAY = "2026-09-22";
const ist = (hhmm) => new Date(`${TODAY}T${hhmm}:00.000+05:30`);

// company → active employees. Sanjay Verma is inactive and must never resolve.
const EMPLOYEES = [
  { companyId: "A", employeeId: "GR0101", firstName: "Rishee", lastName: "Ray" },
  { companyId: "A", employeeId: "GR0102", firstName: "Rishi", lastName: "Kumar" },
  { companyId: "A", employeeId: "GR0103", firstName: "Priya", lastName: "Sharma" },
  { companyId: "A", employeeId: "GR0104", firstName: "Priya", lastName: "Nair" },
  { companyId: "A", employeeId: "GR0105", firstName: "Umang", lastName: "Arora" },
  { companyId: "A", employeeId: "GR0106", firstName: "Ananya", lastName: "Das" },
  { companyId: "A", employeeId: "GR0107", firstName: "Kiran", lastName: "Patel" },
  { companyId: "A", employeeId: "GR0108", firstName: "Meera", lastName: "Joshi" },
  { companyId: "A", employeeId: "GR0109", firstName: "Sanjay", lastName: "Verma", inactive: true },
  { companyId: "A", employeeId: "GR0110", firstName: "Rahul", lastName: "Verma" },
  { companyId: "B", employeeId: "GR0201", firstName: "Rishee", lastName: "Mehta" },
  { companyId: "B", employeeId: "GR0202", firstName: "Farhan", lastName: "Ali" },
];

// Today's attendance entries. Ananya (GR0106) deliberately has none.
const ENTRIES = {
  GR0101: { inTime: ist("09:12"), outTime: null, hrFinalStatus: null, systemPrediction: "P" },
  GR0102: { inTime: ist("09:48"), outTime: null, hrFinalStatus: "P*", systemPrediction: "P*" },
  GR0103: { inTime: ist("09:05"), outTime: null, hrFinalStatus: null, systemPrediction: "P" },
  GR0104: { inTime: null, outTime: null, hrFinalStatus: null, systemPrediction: "AB" },
  GR0105: { inTime: ist("09:30"), outTime: null, hrFinalStatus: "P", systemPrediction: "P" },
  GR0107: { inTime: null, outTime: null, hrFinalStatus: null, systemPrediction: "AB" },
  GR0108: { inTime: null, outTime: null, hrFinalStatus: "L-CL", systemPrediction: "AB" },
  GR0110: { inTime: ist("10:02"), outTime: null, hrFinalStatus: null, systemPrediction: "P*" },
  GR0201: { inTime: ist("09:00"), outTime: null, hrFinalStatus: null, systemPrediction: "P" },
  GR0202: { inTime: null, outTime: null, hrFinalStatus: null, systemPrediction: "AB" },
};

const SCENARIOS = {
  normal: { syncedAt: ist("10:30") },
  stale: { syncedAt: ist("07:00") },
  no_sync: null,
};

function actor({ template, hasHrApplicationAccess, capabilities, companyId }) {
  const caps = capabilities || (template ? ROLE_TEMPLATES[template] : []);
  return {
    id: `eval-${template || "custom"}-${companyId}`,
    companyId,
    hrAccess: { allowed: hasHrApplicationAccess, via: "fixture" },
    accountingAccess: { allowed: false, via: null },
    hrActor: {
      authenticated: true,
      template: template || null,
      capabilities: new Set(caps),
      hasHrApplicationAccess,
      employee: null,
      employeeRef: null,
      compatibility: [],
    },
  };
}

const ACTORS = {
  hr_viewer_A: () => actor({ template: "hr_viewer", hasHrApplicationAccess: true, companyId: "A" }),
  hr_viewer_B: () => actor({ template: "hr_viewer", hasHrApplicationAccess: true, companyId: "B" }),
  ceo_A: () => actor({ template: "ceo_projection", hasHrApplicationAccess: true, companyId: "A" }),
  // An ordinary employee: their template holds attendance.read for THEIR OWN
  // record, but no HR application access.
  employee_self_A: () => actor({ template: "employee_self", hasHrApplicationAccess: false, companyId: "A" }),
  sales_only_A: () => actor({ template: null, hasHrApplicationAccess: false, capabilities: [], companyId: "A" }),
  // Synthetic: HR application + directory, but NOT attendance.read. Probes
  // whether any path reads attendance on directory permission alone.
  directory_only_A: () =>
    actor({ template: null, hasHrApplicationAccess: true, capabilities: ["hr.access", "people.read.directory"], companyId: "A" }),
};

/** Caller-scoped ports over the fixtures, with read counters. */
function fixturePorts({ companyId, scenario }) {
  const reads = { directory: 0, attendance: [] };
  return {
    reads,
    directory: {
      async listVisible() {
        reads.directory += 1;
        return EMPLOYEES.filter((e) => e.companyId === companyId && !e.inactive).map((e) => ({
          employeeRef: `ref-${e.employeeId}`,
          employeeId: e.employeeId,
          firstName: e.firstName,
          middleName: "",
          lastName: e.lastName,
        }));
      },
    },
    attendance: {
      async readEmployeeDay({ dateStr, employeeId }) {
        reads.attendance.push(employeeId);
        const s = SCENARIOS[scenario];
        if (!s || dateStr !== TODAY) return null;
        const visible = EMPLOYEES.find((e) => e.employeeId === employeeId && e.companyId === companyId);
        if (!visible) throw new Error("fixture: cross-company attendance read attempted");
        return { syncedAt: s.syncedAt, holiday: null, entry: ENTRIES[employeeId] || null };
      },
    },
  };
}

module.exports = { NOW, TODAY, EMPLOYEES, ENTRIES, SCENARIOS, ACTORS, fixturePorts };
