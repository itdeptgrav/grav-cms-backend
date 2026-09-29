# HRMS Existing Codebase Audit

> **Status:** Source audit for planning; no application code changed.
>
> **Audit date:** 7 September 2026
>
> **Frontend reviewed:** `/Users/risheeray/grav-cms`
>
> **Backend reviewed:** `/Users/risheeray/grav-cms-backend`
>
> **Product direction:** `docs/product/garment-manufacturer-app-architecture.md`

## 1. Executive finding

GRAV does not need a greenfield HRMS. It already has a large HR administration
surface and working backend domains for employee records, organisation
structure, attendance, leave, payroll, recruitment, documents, policies,
performance, approvals, history and employee self-service APIs.

The correct programme is **controlled professionalisation**, not a rewrite:

1. secure and scope the existing system;
2. establish durable workforce and organisation records;
3. stabilise time, leave and payroll as auditable period workflows;
4. connect recruitment, onboarding, skills, training and compliance;
5. add management analytics and employee/manager self-service;
6. retire legacy structures only after migration and parity proof.

The greatest immediate risk is not missing features. It is that HR's core
records are globally scoped in the reviewed schemas: no `companyId`, legal
entity, establishment or factory key was found in `Employee` or the HR models.
That must be resolved before GRAV is treated as a multi-company or
multi-factory HR system.

## 2. Existing frontend capability

The HR shell groups the current application into six usable areas.

| Area | Existing screens |
|---|---|
| People | Employees, employee detail, create, import, history, departments, department detail, team structure, recruitment, performance |
| Time | Attendance overview, daily attendance, muster roll, timecard, reports, attendance settings, leave, shift management, regularisations |
| Pay and policy | Payroll workspace, payslip, payroll settings, salary rules, SOP point deductions, policies |
| Documents | Issued-document library, employee requests, letter generation and PDF support |
| System | Approval queue, HR team/roles, change history, password management |
| Profile | HR user's profile and self-service password change |

The reviewed HR frontend contains roughly 49,000 lines across its HR routes and
components. Several screens are substantial operational workspaces rather than
stubs, especially attendance, leave, payroll, employee entry, recruitment,
documents and policy management.

Useful UI foundations to preserve:

- one grouped HR navigation rather than a long flat menu;
- shared department guard and role-aware controls;
- a real dashboard backed by attendance, headcount, leave and activity data;
- import preview before employee creation/update;
- employee history and a department-wide change-history view;
- approval queue for editor writes;
- document generation, release, revoke and request states;
- granular attendance views instead of one overloaded table;
- separate payroll preview, run, items, settings, export and payslip views.

Observed frontend gaps:

- there is no complete web employee self-service portal in this repository;
  only a public employee identity page is present, while most self-service
  capability appears to be exposed as backend APIs for another client;
- no workforce planning, position control or approved manpower requisition
  workspace;
- no onboarding/offboarding case workspace;
- no skill matrix, training, certification or competency workspace;
- no contractor labour, gate-pass, hostel/transport/canteen or welfare
  workspace;
- no health, safety, grievance, disciplinary case or incident workspace;
- no statutory compliance calendar/register workspace;
- no succession, talent review, compensation-review or promotion cycle;
- no configurable report catalogue spanning headcount, attrition, overtime,
  labour cost, compliance and skills;
- navigation exposes “Vendors” inside HR although vendor ownership belongs to
  Supply Chain under the approved application architecture.

## 3. Existing backend capability

### 3.1 Workforce record

`models/Employee.js` already holds a broad employee profile:

- personal and family information;
- contact and address details;
- department, designation and reporting managers;
- date of joining, confirmation, probation and employment type;
- intern arrangements;
- work location and shift assignment;
- compensation components and bank details;
- identity/statutory numbers and uploaded documents;
- dynamic custom fields;
- SOP point records, push tokens and audit stamps;
- distinct HR organisation and application-access department links.

The distinction between `departmentId` and `accessDepartmentId` is important
and should be retained. Organisation assignment must never silently grant
application access.

### 3.2 Time, attendance and leave

The backend includes:

- biometric and manual punch ingestion;
- interpreted daily attendance;
- shift rules, grace periods, half-day rules and punch expectations;
- day override and bulk override;
- missed-punch and regularisation workflows;
- holiday calendar and muster roll;
- leave configuration, balances, applications and manager/HR decisions;
- attendance period sync and export;
- shift swaps;
- overtime reports and approval data;
- employee attendance, leave, regularisation and absence-calendar APIs.

Two attendance representations exist: `Attendance` and `DailyAttendance`.
Their authoritative responsibilities and retirement path need an explicit
decision before adding another timekeeping feature.

### 3.3 Payroll and finance handoff

The backend includes:

- payroll preview and run creation;
- item-level calculation and day breakdown;
- overrides, hold/release and mark-paid flows;
- settings and salary configuration;
- payroll export and payslip generation/history;
- encrypted employee compensation fields;
- a payroll bridge and payroll readers in Accounts & Finance.

This is a valuable base, but the permanent ownership rule must be explicit:
HR owns workforce and payroll inputs; the payroll engine creates an approved
payroll result; Accounts & Finance owns accounting, payment execution and the
financial ledger. “Mark paid” in HR must ultimately consume a Finance payment
status, not become a second payment truth.

### 3.4 Recruitment and documents

The backend includes job postings, candidates, stages, interviews/tasks,
ratings and history. Document support includes employee requests, document
types, prefill, generate/upload, release, revoke, decline, short-lived links
and employee-only projections.

The missing bridge is a controlled `Candidate -> Employment Offer -> Worker`
conversion. Recruitment and Employee currently look like adjacent modules,
not one idempotent hire workflow.

### 3.5 Governance already present

- HR-prefixed writes have a general change-history floor.
- Several important modules add structured before/after audit events.
- HR editor writes can be held for an approver through the department change
  request mechanism.
- Employee-facing document reads exclude unreleased documents.
- A shared HR access resolver exists for AI tools.
- Employee and access departments are deliberately separate.

These mechanisms should be made uniform rather than replaced.

## 4. Structural and security findings

### P0 — tenant and establishment boundary is absent

No company, legal-entity, establishment or factory scope was found on the
reviewed Employee and HR domain schemas or in their route queries. Global
singletons also exist for leave, attendance and payroll settings.

Consequences:

- records cannot be safely partitioned between companies or legal entities;
- the same employee number, holiday, payroll period or biometric identifier
  may collide across establishments;
- policies cannot be independently effective-dated by company/factory;
- enterprise reporting has no durable organisational dimensions;
- future scoping added only in UI filters would be cosmetic, not security.

### P0 — authentication and authorisation are not consistently equivalent

Many HR routers visibly use `EmployeeAuthMiddleware`, which proves a valid
session but does not by itself prove an HR application grant or capability.
The global department write guard protects writes through selected prefixes,
but read routes and specially mounted prefixes still need a complete access
matrix and negative tests. `Passwordmanagement.js` has its own `hrOnly` role
check, while other areas rely on different layers.

Required outcome: one shared HR policy resolver for every read and write, with
record scope plus capabilities such as `people.read`, `compensation.read`,
`attendance.correct`, `payroll.prepare`, `payroll.approve`,
`documents.release` and `compliance.manage`.

### P0 — sensitive fields are concentrated in one aggregate

The Employee document combines ordinary directory data with compensation,
banking, government identifiers, uploaded identity evidence, credentials,
manager assignment and operational configuration. Compensation encryption is
already valuable, but one broad record makes least-privilege reads, retention,
key rotation, disclosure logs and field-level export control difficult.

The migration should separate protected subdomains without breaking the
existing employee identifier.

### P1 — duplicate and oversized boundaries

- `Attendance` and `DailyAttendance` overlap.
- department identity exists in HR organisation records and access records for
  valid reasons, but mapping and rename behaviour require reconciliation tools.
- payroll routes are mounted twice under `/api/hr/payroll`.
- HR “Vendors” reuses the Supply Chain vendor router.
- `Employee` embeds growing arrays such as custom fields, SOP history and
  documents that will make retention and concurrent updates harder at scale.
- several HR route files are thousands of lines long, especially Attendance,
  Payroll and Leave, raising regression and ownership risk.

### P1 — effective dating is incomplete

Current employee, manager, department, designation, shift and salary values are
mostly stored as present-state fields. Professional HR/payroll needs dated
assignments so a transfer or salary revision does not rewrite the explanation
for an old payroll, attendance day or approval chain.

### P1 — tests are not proportional to payroll and privacy risk

The codebase has useful verification scripts for shifts, payroll, HR change
history and write coverage, plus HR-AI tests. The reviewed frontend has no
dedicated HR test suite in its ordinary test-file inventory, and backend HR
coverage is much smaller than the size and sensitivity of the domain.

## 5. Preserve, strengthen, replace

| Existing capability | Direction |
|---|---|
| Employee identity and stable `_id` | Preserve as the migration anchor |
| HR org department vs access department | Preserve and add reconciliation |
| Attendance interpretation and settings | Preserve behind a versioned time-policy boundary |
| Daily attendance, regularisation and leave links | Preserve; define one canonical day ledger |
| Leave balances and approval chain | Preserve; add effective-dated policy and reservation ledger |
| Payroll preview/run/item/day breakdown | Preserve; add immutable period close and Finance acknowledgement |
| Employee salary encryption | Preserve; move toward separate protected compensation store |
| Recruitment job/candidate/task records | Preserve; add requisition and hire conversion |
| Document release boundary | Preserve as the reference pattern for employee visibility |
| Change request and change history | Preserve; standardise actor, reason, before/after and correlation ID |
| HR Vendors navigation | Remove from HR; link to controlled Supply Chain projection if needed |
| Global configuration singletons | Replace with scoped, effective-dated policy versions |
| Broad auth-only HR reads | Replace with capability and record-scope enforcement |
| Present-state job/manager/salary fields only | Supplement with effective-dated assignment history |

## 6. Audit conclusion

The current system is feature-rich in day-to-day HR administration but is not
yet a durable enterprise HRMS boundary. The safest sequence is foundation and
security first, then employee lifecycle, time/leave, payroll close, and only
then the broader talent and compliance portfolio. Building more isolated
screens before company scope, permissions, effective dating and canonical
records are settled would deepen the migration cost.

