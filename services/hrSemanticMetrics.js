"use strict";

const { compileSemanticCatalogue, normalize } = require("./ai/semanticCatalogue");

/**
 * Canonical scalar HR metrics.
 *
 * A metric has one meaning and one source of truth. Natural language never
 * decides which collection to query: Qwen selects one closed metric id, then
 * GRAV applies the temporal and permission contract recorded here.
 */

const CURRENT = "current";
const MONTH = "month_required";
const YEAR = "year_required";
const HR_CATALOGUE_ID = "hr";

const DOMAINS = Object.freeze([
  { id: "people", label: "people", aliases: ["employee", "employees", "staff", "profile", "contact", "personal information"] },
  { id: "organisation", label: "organisation", aliases: ["organization", "department", "departments", "designation", "designations", "org structure", "headcount", "workforce"] },
  { id: "attendance", label: "attendance", aliases: ["present", "absent", "timecard", "punch", "punches", "working hours", "overtime", "late arrival"] },
  { id: "leave", label: "leave", aliases: ["leaves", "regularisation", "regularization", "time off", "holiday", "holidays", "leave balance"] },
  { id: "payroll", label: "payroll", aliases: ["salary", "compensation", "ctc", "payslip", "pay slip", "wage", "wages", "earnings", "deductions"] },
  { id: "recruitment", label: "recruitment", aliases: ["candidate", "candidates", "applicant", "applicants", "job opening", "vacancy", "interview", "hiring"] },
  { id: "documents", label: "employee documents", aliases: ["appointment letter", "offer letter", "warning letter", "experience letter", "relieving letter", "salary certificate", "document request"] },
  { id: "performance", label: "performance", aliases: ["performance score", "sop points", "c4 points", "tenure"] },
  { id: "policy", label: "hr policy", aliases: ["hr policies", "attendance policy", "leave policy", "payroll settings", "shift timings", "working days", "entitlement"] },
  { id: "audit", label: "hr audit", aliases: ["change history", "who changed", "who edited", "audit trail"] },
]);

const ENTITIES = Object.freeze([
  { id: "employee", label: "employee", aliases: ["person", "staff member"] },
  { id: "department", label: "department", aliases: ["team", "business unit"] },
  { id: "payroll_run", label: "payroll run", aliases: ["salary run"] },
  { id: "candidate", label: "candidate", aliases: ["applicant"] },
  { id: "document", label: "employee document", aliases: ["letter"] },
]);

const ALIASES = Object.freeze({
  "employee.full_name": ["full name", "complete name"],
  "employee.title": ["title", "salutation"],
  "employee.nickname": ["nickname", "nick name"],
  "employee.primary_manager": ["primary manager", "reporting manager"],
  "employee.secondary_manager": ["secondary manager"],
  "employee.department": ["department"],
  "employee.designation": ["designation"],
  "employee.job_title": ["job title"],
  "employee.work_location": ["work location"],
  "employee.date_of_joining": ["date of joining", "joining date"],
  "employee.confirmation_date": ["confirmation date"],
  "employee.probation_period": ["probation period", "probation"],
  "employee.employment_type": ["employment type"],
  "employee.biometric_id": ["biometric id"],
  "employee.identity_id": ["identity id"],
  "employee.work_email": ["employee email", "work email", "login email", "email"],
  "employee.work_phone": ["work phone", "job phone", "corporate phone"],
  "employee.extension": ["phone extension", "extension"],
  "employee.personal_email": ["personal email"],
  "employee.phone": ["mobile number", "mobile", "phone number", "phone"],
  "employee.alternate_phone": ["alternate phone", "alternative phone"],
  "employee.date_of_birth": ["date of birth", "dob"],
  "employee.gender": ["gender"],
  "employee.blood_group": ["blood group"],
  "employee.marital_status": ["marital status"],
  "employee.marriage_date": ["marriage date", "wedding date"],
  "employee.spouse_name": ["spouse name", "spouse"],
  "employee.spouse_date_of_birth": ["spouse date of birth", "spouse dob"],
  "employee.father_name": ["father's name", "father name", "father"],
  "employee.father_date_of_birth": ["father's date of birth", "father dob"],
  "employee.mother_name": ["mother's name", "mother name", "mother"],
  "employee.nationality": ["nationality"],
  "employee.religion": ["religion"],
  "employee.place_of_birth": ["place of birth", "birth place"],
  "employee.country_of_origin": ["country of origin"],
  "employee.residential_status": ["residential status"],
  "employee.is_director": ["director status", "is director", "director"],
  "employee.is_international": ["international employee", "international status"],
  "employee.is_physically_challenged": ["physically challenged", "physical challenge status"],
  "employee.shift": ["work shift", "shift"],
  "employee.needs_to_operate": ["needs to operate", "machine operator status"],
  "compensation.configured_gross_monthly": ["gross salary", "monthly gross", "current gross"],
  "compensation.configured_basic_monthly": ["basic salary", "monthly basic"],
  "compensation.configured_hra_monthly": ["hra", "house rent allowance"],
  "compensation.configured_epf_monthly": ["epf", "pf", "provident fund"],
  "compensation.configured_edli_monthly": ["edli"],
  "compensation.configured_employee_esic_monthly": ["employee esic", "employee esi"],
  "compensation.configured_employer_esic_monthly": ["employer esic", "employer esi"],
  "compensation.configured_total_deduction_monthly": ["total deductions", "deductions"],
  "compensation.configured_net_salary_monthly": ["net salary", "take home", "take-home salary"],
  "compensation.configured_employer_cost_monthly": ["ctc", "cost to company", "employer cost"],
  "compensation.configured_stipend_monthly": ["stipend"],
  "payroll.gross_earnings": ["payroll gross", "gross paid", "gross earnings"],
  "payroll.net_pay": ["payroll net", "net paid", "net pay"],
});

const rows = [
  // Employee master — current configured/profile values.
  ["employee.full_name", "Full name", ["firstName", "middleName", "lastName"], CURRENT, "joined_text"],
  ["employee.title", "Title", "title", CURRENT, "text"],
  ["employee.nickname", "Nickname", "nickName", CURRENT, "text"],
  ["employee.primary_manager", "Primary manager", "primaryManager.managerName", CURRENT, "text"],
  ["employee.secondary_manager", "Secondary manager", "secondaryManager.managerName", CURRENT, "text"],
  ["employee.department", "Department", "department", CURRENT, "text"],
  ["employee.designation", "Designation", "designation", CURRENT, "text"],
  ["employee.job_title", "Job title", "jobTitle", CURRENT, "text"],
  ["employee.work_location", "Work location", "workLocation", CURRENT, "text"],
  ["employee.date_of_joining", "Date of joining", "dateOfJoining", CURRENT, "date"],
  ["employee.confirmation_date", "Confirmation date", "confirmationDate", CURRENT, "date"],
  ["employee.probation_period", "Probation period", "probationPeriod", CURRENT, "text"],
  ["employee.employment_type", "Employment type", "employmentType", CURRENT, "text"],
  ["employee.biometric_id", "Biometric ID", "biometricId", CURRENT, "text"],
  ["employee.identity_id", "Identity ID", "identityId", CURRENT, "text"],
  ["employee.work_email", "Work email", "email", CURRENT, "text"],
  ["employee.work_phone", "Work phone", "workPhone", CURRENT, "text"],
  ["employee.extension", "Phone extension", "extension", CURRENT, "text"],
  ["employee.personal_email", "Personal email", "personalEmail", CURRENT, "text"],
  ["employee.phone", "Phone", "phone", CURRENT, "text"],
  ["employee.alternate_phone", "Alternate phone", "alternatePhone", CURRENT, "text"],
  ["employee.date_of_birth", "Date of birth", "dateOfBirth", CURRENT, "date"],
  ["employee.gender", "Gender", "gender", CURRENT, "text"],
  ["employee.blood_group", "Blood group", "bloodGroup", CURRENT, "text"],
  ["employee.marital_status", "Marital status", "maritalStatus", CURRENT, "text"],
  ["employee.marriage_date", "Marriage date", "marriageDate", CURRENT, "date"],
  ["employee.spouse_name", "Spouse", "spouseName", CURRENT, "text"],
  ["employee.spouse_date_of_birth", "Spouse date of birth", "spouseDOB", CURRENT, "date"],
  ["employee.father_name", "Father", ["fatherFirstName", "fatherMiddleName", "fatherLastName"], CURRENT, "joined_text"],
  ["employee.father_date_of_birth", "Father's date of birth", "fatherDateOfBirth", CURRENT, "date"],
  ["employee.mother_name", "Mother", ["motherFirstName", "motherMiddleName", "motherLastName"], CURRENT, "joined_text"],
  ["employee.nationality", "Nationality", "nationality", CURRENT, "text"],
  ["employee.religion", "Religion", "religion", CURRENT, "text"],
  ["employee.place_of_birth", "Place of birth", "placeOfBirth", CURRENT, "text"],
  ["employee.country_of_origin", "Country of origin", "countryOfOrigin", CURRENT, "text"],
  ["employee.residential_status", "Residential status", "residentialStatus", CURRENT, "text"],
  ["employee.is_director", "Director status", "isDirector", CURRENT, "boolean"],
  ["employee.is_international", "International-employee status", "isInternational", CURRENT, "boolean"],
  ["employee.is_physically_challenged", "Physical-challenge status", "isPhysicallyChallenged", CURRENT, "boolean"],
  ["employee.shift", "Work shift", "shift", CURRENT, "text"],
  ["employee.needs_to_operate", "Needs-to-operate status", "needsToOperate", CURRENT, "boolean"],

  // Employee compensation master — configured monthly values, not payroll.
  ["compensation.configured_gross_monthly", "Configured gross monthly salary", "salary.gross", CURRENT, "money"],
  ["compensation.configured_basic_monthly", "Configured basic monthly salary", "salary.basic", CURRENT, "money"],
  ["compensation.configured_hra_monthly", "Configured monthly HRA", "salary.hra", CURRENT, "money"],
  ["compensation.configured_special_allowance_monthly", "Configured monthly special allowance", "salary.specialAllowance", CURRENT, "money"],
  ["compensation.configured_food_allowance_monthly", "Configured monthly food allowance", "salary.foodAllowance", CURRENT, "money"],
  ["compensation.configured_epf_monthly", "Configured monthly EPF", "salary.epf", CURRENT, "money"],
  ["compensation.configured_edli_monthly", "Configured monthly EDLI", "salary.edli", CURRENT, "money"],
  ["compensation.configured_employee_esic_monthly", "Configured monthly employee ESIC", "salary.eeesic", CURRENT, "money"],
  ["compensation.configured_employer_esic_monthly", "Configured monthly employer ESIC", "salary.erEsic", CURRENT, "money"],
  ["compensation.configured_other_deduction_monthly", "Configured monthly other deduction", "salary.otherDeduction", CURRENT, "money"],
  ["compensation.configured_total_deduction_monthly", "Configured monthly total deductions", "salary.totalDeduction", CURRENT, "money"],
  ["compensation.configured_net_salary_monthly", "Configured monthly net salary", "salary.netSalary", CURRENT, "money"],
  ["compensation.configured_employer_cost_monthly", "Configured monthly employer cost", "salary.employerCost", CURRENT, "money"],
  ["compensation.configured_stipend_monthly", "Configured monthly stipend", "salary.stipend", CURRENT, "money"],

  // Posted payroll item — calculated result for an explicit month.
  ["payroll.gross_earnings", "Payroll gross earnings", "earnings.gross", MONTH, "money"],
  ["payroll.net_pay", "Payroll net pay", "netPay", MONTH, "money"],
  ["payroll.total_deductions", "Payroll total deductions", "deductions.total", MONTH, "money"],
  ["payroll.payable_days", "Payroll payable days", "payableDays", MONTH, "number"],
  ["payroll.status", "Payroll status", "status", MONTH, "text"],
  ["payroll.annual_gross", "Annual payroll gross earnings", "totalGross", YEAR, "money"],
  ["payroll.annual_net_pay", "Annual payroll net pay", "totalNetPay", YEAR, "money"],
];

const METRICS = Object.freeze(Object.fromEntries(rows.map(([id, label, path, temporal, valueType]) => [
  id,
  Object.freeze({
    id,
    label,
    path,
    temporal,
    valueType,
    source: id.startsWith("payroll.") ? "posted_payroll_item" : "employee_master",
    domain: id.startsWith("employee.") ? "people" : "payroll",
    entity: "employee",
    aliases: Object.freeze(ALIASES[id] || []),
  }),
])));

const CATALOGUE = compileSemanticCatalogue({
  id: HR_CATALOGUE_ID,
  domains: DOMAINS,
  entities: ENTITIES,
  metrics: Object.values(METRICS),
});

// Same business measure at a different grain. This is catalogue metadata, not
// language matching: when a request carries an explicit payroll period, the
// period variant is the only semantically valid source for that measure.
const PERIOD_VARIANTS = Object.freeze({
  "compensation.configured_gross_monthly": "payroll.gross_earnings",
  "compensation.configured_net_salary_monthly": "payroll.net_pay",
  "compensation.configured_total_deduction_monthly": "payroll.total_deductions",
});

const metricIds = () => Object.keys(METRICS);
const metric = (id) => METRICS[id] || null;
const metricForRequest = (id, { month, year } = {}) => {
  const hasPeriod = month !== undefined || year !== undefined;
  return metric(hasPeriod && PERIOD_VARIANTS[id] ? PERIOD_VARIANTS[id] : id);
};

function metricGlossary() {
  return "Standard terms: CTC/cost to company means configured employer cost; gross salary without a period means configured gross; take-home means configured net salary; PF/EPF means configured provident fund; a named month/year changes gross, net or deductions to the corresponding posted-payroll metric.";
}

function metricFromText(value) {
  const resolved = CATALOGUE.resolveMetric(value);
  return resolved ? metric(resolved.id) : null;
}

function stripMetricTerms(value, definition) {
  return CATALOGUE.stripMetricTerms(value, definition);
}

// Parse a yes/no scalar question using the catalogue's own metric terms. New
// metrics therefore gain comparison support without sentence-specific rules.
function parseMetricComparison(value, definition) {
  if (!definition) return null;
  const terms = [definition.label, ...(definition.aliases || [])]
    .filter(Boolean)
    .sort((a, b) => String(b).length - String(a).length)
    .map((term) => String(term)
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\s+/g, "\\s+"));
  if (!terms.length) return null;
  const pattern = new RegExp(
    "^\\s*(?:is|are)\\s+(.+?)(?:['’]s|s['’])\\s+(?:the\\s+)?(?:" +
      terms.join("|") + ")\\s+(?:is\\s+)?(.+?)\\s*\\??\\s*$",
    "i",
  );
  const match = String(value || "").match(pattern);
  if (!match) return null;
  const employeeName = match[1].trim();
  const expectedValue = match[2].trim().replace(/[?.!]+$/, "").trim();
  return employeeName && expectedValue ? { employeeName, expectedValue } : null;
}

function valueAt(source, path) {
  if (Array.isArray(path)) {
    return path.map((item) => valueAt(source, item)).filter(Boolean).join(" ") || null;
  }
  return String(path || "").split(".").reduce((value, key) => (value == null ? value : value[key]), source);
}

function formatValue(value, valueType) {
  if (value === undefined || value === null || value === "") return null;
  if (valueType === "money") {
    const amount = Number(value);
    return Number.isFinite(amount) ? `₹${amount.toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : null;
  }
  if (valueType === "date") {
    const text = value instanceof Date ? value.toISOString() : String(value);
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : text;
  }
  if (valueType === "boolean") return value === true ? "Yes" : value === false ? "No" : null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return value.toLocaleString("en-IN");
  return String(value).trim() || null;
}

function renderMetricAnswer({ definition, employee, source }) {
  if (!definition) return null;
  const value = formatValue(valueAt(source, definition.path), definition.valueType);
  if (value === null) return `${employee}'s ${definition.label.toLowerCase()} is not recorded or is not available to your account.`;
  return `${employee}'s ${definition.label.toLowerCase()} is ${value}.`;
}

function metricValueMatches({ definition, source, expectedValue }) {
  if (!definition || expectedValue === undefined || expectedValue === null) return false;
  const actual = valueAt(source, definition.path);
  if (actual === undefined || actual === null || actual === "") return false;
  if (definition.valueType === "money" || typeof actual === "number") {
    const expected = Number(String(expectedValue).replace(/[^0-9.-]/g, ""));
    return Number.isFinite(expected) && Number(actual) === expected;
  }
  if (definition.valueType === "boolean" || typeof actual === "boolean") {
    const expected = normalize(expectedValue);
    if (["yes", "true"].includes(expected)) return actual === true;
    if (["no", "false"].includes(expected)) return actual === false;
    return false;
  }
  const actualText = normalize(actual);
  const expectedText = normalize(expectedValue);
  if (!actualText || !expectedText) return false;
  if (actualText === expectedText) return true;
  const actualTokens = new Set(actualText.split(" "));
  const expectedTokens = expectedText.split(" ").filter(Boolean);
  return expectedTokens.length > 0 && expectedTokens.every((token) => actualTokens.has(token));
}

function renderMetricComparisonAnswer({ definition, employee, source, expectedValue }) {
  const ordinary = renderMetricAnswer({ definition, employee, source });
  const actual = formatValue(valueAt(source, definition && definition.path), definition && definition.valueType);
  if (actual === null) return ordinary;
  return `${metricValueMatches({ definition, source, expectedValue }) ? "Yes" : "No"}. ${ordinary}`;
}

module.exports = {
  CURRENT,
  MONTH,
  YEAR,
  HR_CATALOGUE_ID,
  DOMAINS,
  ENTITIES,
  CATALOGUE,
  METRICS,
  ALIASES,
  PERIOD_VARIANTS,
  metric,
  metricForRequest,
  metricGlossary,
  metricFromText,
  stripMetricTerms,
  parseMetricComparison,
  metricIds,
  valueAt,
  formatValue,
  renderMetricAnswer,
  metricValueMatches,
  renderMetricComparisonAnswer,
};
