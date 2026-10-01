# GRAV HRMS Professionalisation Plan

> **Status:** Proposed product and architecture plan; no application code is
> changed by this document.
>
> **Plan date:** 7 September 2026
>
> **Product boundary:** HR & Compliance in
> `docs/product/garment-manufacturer-app-architecture.md`
>
> **Source audit:** `docs/audits/hrms-existing-codebase-audit.md`

## 1. Product outcome

Build one professional **People, Payroll & Compliance** application for a
garment manufacturer. It must support office employees, factory workers,
trainees, interns, fixed-term staff and contractor labour across companies,
legal entities, establishments, factories, departments, shifts and production
lines without creating a second copy of workforce truth.

The permanent worker lifecycle is:

```text
Approved manpower need
  -> recruitment and selection
  -> offer and pre-joining
  -> worker/employee creation
  -> onboarding and deployment
  -> time, leave, pay and development
  -> transfer / promotion / compensation changes
  -> separation and final settlement
  -> retained statutory and audit record
```

The application should feel like an operations control centre. HR sees work
queues, exceptions, expiring documents, payroll blockers and compliance risk.
Managers see only their teams and decisions. Employees see their own record,
requests, documents and pay. Management receives aggregated workforce signals,
not unrestricted access to every sensitive field.

## 2. Permanent design rules

1. **One person, one workforce identity.** Candidate, employee, operator,
   intern and alumnus states are linked through one durable person/worker ID;
   they are not parallel employee tables.
2. **Organisation assignment is not system access.** Department, line and
   manager placement never grants an application permission.
3. **Every record has a company and establishment scope.** UI filters are not a
   security boundary; every query and unique index must include its scope.
4. **Employment facts are effective-dated.** Transfers, managers, shifts,
   grades, compensation and policies retain the dates for which they were true.
5. **Sensitive data follows least privilege.** Directory, private identity,
   health, bank and compensation data have different read/write permissions.
6. **Attendance evidence is immutable; judgement is versioned.** Raw punches
   are preserved. Reprocessing or correction creates an auditable new result.
7. **Leave and pay are ledgers, not mutable counters.** Every balance and net-pay
   result can be reconstructed from dated entries and frozen inputs.
8. **A payroll period closes once.** Reopening requires a named authority,
   reason and revision; payment truth comes back from Accounts & Finance.
9. **Rules are configuration, not code branches.** Policies are scoped,
   effective-dated, approved, versioned and testable before activation.
10. **Managers act only inside their dated reporting scope.** A current manager
    cannot approve a historical period merely because the employee reports to
    them today.
11. **Employee visibility is an explicit projection.** Internal notes,
    unreleased documents, investigation material and draft pay never leak into
    self-service.
12. **No silent automation.** Every system-derived absence, penalty, overtime,
    entitlement or payroll adjustment states its rule version and evidence.
13. **No hard delete of material HR history.** Corrections, revocations,
    anonymisation and retention disposal are explicit events.
14. **Build on the existing system.** Each replacement needs compatibility,
    migration, reconciliation and parity proof before a legacy path retires.

## 3. Application boundary

### 3.1 HR & Compliance owns

- workforce identity and employment lifecycle;
- organisation assignment, position, grade, manager and work location history;
- workforce documents and acknowledgements;
- attendance policy, attendance judgement and correction workflow;
- shifts, rosters, leave policy, entitlement and absence cases;
- approved payroll inputs and payroll calculation/approval;
- manpower requisitions, recruitment and onboarding;
- skills, training, certification and competency evidence;
- contractor labour compliance and deployment eligibility;
- employee relations, grievance and disciplinary case administration;
- health, safety and social-compliance cases and registers;
- separation, clearance and final-settlement inputs;
- workforce reporting and statutory evidence packs.

### 3.2 HR & Compliance does not own

| Fact | Authoritative owner |
|---|---|
| Company budgets, payroll accounting, payment, tax ledger, provisions | Accounts & Finance |
| Production output and WIP | Production |
| Standard operations, SAM/SMV and skill demand per operation | IE |
| Capacity plan and planned manpower demand | PPC |
| Machine licence/calibration and equipment availability | Maintenance |
| Suppliers and service vendors | Supply Chain |
| Physical uniforms/PPE inventory and issues | Stores |
| Quality inspection result | Quality |
| Company-wide approval limits and high-level policies | Management/Board |

HR may consume approved projections from these owners. For example, IE may
publish operation skill demand; HR owns the worker's verified skill and
training evidence. Production publishes actual output; HR may use an approved
incentive input but does not rewrite production output.

## 4. Users and data visibility

| Persona | Primary workspace | Visibility |
|---|---|---|
| Employee / worker | My work life | Own profile projection, attendance, roster, leave, documents, payslips, requests, training |
| Line supervisor | Team today | Assigned team/line attendance, roster exceptions, permitted requests and skill coverage |
| Department manager | My people | Effective-dated reporting scope, approvals, vacancies, readiness and team analytics |
| Recruiter | Hiring | Approved requisitions, candidates, interviews, offers and onboarding handoff |
| HR operations | People operations | Workforce records, cases, documents, lifecycle workflows |
| Time office | Time control | Punches, attendance judgement, rosters, corrections, overtime and closure |
| Payroll preparer | Payroll inputs | Compensation projection, payable days, inputs, exceptions and draft runs |
| Payroll approver | Payroll close | Variance, evidence, approval, reopen and Finance handoff |
| L&D / skill coordinator | Skills and training | Skill demand, assessments, certification, training and expiry |
| Compliance / EHS officer | Compliance | Registers, audits, incidents, corrective actions and evidence |
| Auditor | Audit room | Time-bounded, read-only, redacted evidence packs |
| Management | Workforce command | Aggregated headcount, labour cost, absenteeism, attrition, skills and risk |

Capability checks must be independent from page navigation. At minimum:

```text
people.read.directory       people.read.private
people.write                employment.change
compensation.read           compensation.write
attendance.read             attendance.correct         attendance.close
leave.decide.manager        leave.decide.hr
payroll.prepare             payroll.approve             payroll.reopen
recruitment.manage          offer.approve               hire.convert
documents.issue             documents.release
skills.assess               training.manage
compliance.manage           cases.manage
analytics.workforce         audit.export
```

Every grant is scoped by company, establishment/factory and, where applicable,
department/team. Break-glass access needs reason, expiry and an audit alert.

## 5. Professional module map

### 5.1 Workforce core

- person and worker identity;
- employee number sequences by legal entity/establishment;
- employment, worker category and contract history;
- position, department, cost centre, factory, line and manager assignments;
- grade/band, job and designation catalogue;
- compensation assignment reference, never exposed in directory reads;
- emergency contacts, dependants and statutory identifiers;
- document checklist and verified status;
- probation/confirmation, transfer, deputation, promotion and status changes;
- complete timeline and data-quality exceptions;
- import with preview, row-level validation, idempotency and rollback report.

### 5.2 Organisation and position management

- company -> legal entity -> establishment -> factory -> department -> team/line;
- effective-dated organisation tree;
- approved positions with planned/filled/vacant/frozen states;
- position occupancy and reporting relationships;
- sanctioned headcount, skill/grade/shift demand and hiring justification;
- reorganisations modelled as dated changes, not bulk text replacements;
- mapping to Finance cost centres and application access departments.

### 5.3 Recruitment and pre-boarding

- manpower requisition linked to an approved position or seasonal plan;
- approval by HR, budget owner and hiring manager as policy requires;
- job publication, source/vendor, referral and candidate consent;
- configurable hiring pipeline, interview scorecards and decision evidence;
- duplicate candidate/person detection;
- offer components, approval, acceptance, expiry and version history;
- background/reference/medical checks as configurable gates;
- pre-joining checklist and document collection;
- idempotent candidate-to-worker conversion;
- recruitment funnel, time-to-fill, offer acceptance and source quality.

### 5.4 Onboarding, deployment and probation

- joining case with owner, due dates and blockers;
- employee number, biometric registration and access provisioning requests;
- bank/statutory/document verification;
- induction, policy acknowledgement and mandatory safety training;
- uniform/PPE and asset issue requests to Stores/IT owners;
- factory/line/shift deployment and supervisor acknowledgement;
- probation goals, review reminders, extension and confirmation decision;
- new-joiner pulse and 30/60/90-day completion dashboard.

### 5.5 Time office, shifts and workforce scheduling

- immutable punch/event ledger with source, device and ingestion identity;
- versioned shift definitions, calendars, rotations and overnight shifts;
- worker roster assignment by period, team and line;
- attendance day ledger with evidence, derived status and rule version;
- missing punch, late/early, half-day, weekly-off and holiday logic;
- overtime request/authorisation/actual/approval separation;
- regularisation with manager and time-office/HR decision;
- period reconciliation and close; controlled reopen;
- device health, sync lag, unmatched biometric IDs and duplicate-punch queues;
- muster roll and legally reviewed exports by establishment.

### 5.6 Leave and absence

- versioned policies by worker category, establishment and effective date;
- accrual, grant, carry-forward, lapse, encashment and adjustment ledger;
- leave request with overlap, holiday, roster and balance validation;
- multi-level approval based on dated reporting relationship;
- planned absence calendar with privacy-safe team projection;
- maternity, injury, unpaid and other configurable absence categories;
- attendance and payroll handoff through frozen period facts;
- balance reconciliation, negative-balance controls and year close.

### 5.7 Payroll and compensation

- protected, effective-dated compensation assignment;
- earning, deduction, employer contribution and reimbursement component master;
- eligibility and formula rules by grade/category/location/effective date;
- payroll calendar and employee inclusion/exclusion population;
- frozen inputs from employment, attendance, leave, overtime and adjustments;
- preview with blockers, variance from prior period and maker notes;
- item-level explanation and day-level trace already present in concept;
- maker-checker approval, period close and controlled reopen;
- off-cycle payroll, arrears, retro changes, bonus and incentive inputs;
- separation settlement inputs and recovery/clearance states;
- payslip release and employee acknowledgement;
- approved payroll journal/provision handoff to Finance;
- payment-status acknowledgement from Finance and reconciliation;
- statutory outputs implemented only from legally reviewed, effective-dated
  rule packs—never frozen forever in application code.

### 5.8 Employee and manager self-service

- responsive/PWA employee home suitable for shared and low-bandwidth devices;
- own profile with change requests for controlled fields;
- punch/attendance timeline and correction request;
- roster, holiday, leave, overtime and absence calendar;
- payslips, letters, acknowledgements and document requests;
- manager inbox for leave, regularisation, overtime, confirmation and hiring;
- team calendar, staffing exceptions and expiring skill/certification alerts;
- multilingual labels/content where required, with server-owned workflow states;
- delegated approver with explicit date range and audit trail.

### 5.9 Skills, training and productivity readiness

- skill catalogue aligned to IE operation codes without copying IE standards;
- proficiency levels, assessor, evidence and validity dates;
- worker skill matrix by factory, line, operation and product family;
- training needs from missing/expiring skills and compliance requirements;
- course, batch, trainer, attendance, assessment and certification;
- deployment eligibility projection for PPC/Production;
- succession/talent features only after the operational skill record is trusted;
- no automatic pay or disciplinary action from a productivity metric alone.

### 5.10 Contractor labour and workforce services

- contractor, contract, licence/evidence and validity;
- contractor worker identity with duplicate detection against employees;
- onboarding, age/identity/document verification and deployment eligibility;
- attendance and wage-input separation by contract;
- statutory evidence checklist and expiry alerts;
- gate/deployment status projection without duplicating vendor ownership;
- optional transport, canteen, hostel, uniform/PPE and welfare service records.

Supply Chain remains the owner of the supplier/vendor master. HR owns the
contractor worker and labour-compliance projection it needs.

### 5.11 Employee relations, health, safety and social compliance

- confidential grievance and disciplinary cases with restricted case teams;
- allegation, evidence, hearing, action, appeal and closure history;
- incident/near-miss reporting and medical-treatment record separation;
- corrective/preventive action with owner, due date and verification;
- committee, training, inspection and drill registers;
- licence, permit, audit and certification calendar;
- worker interview/sample evidence for social-compliance audits;
- anonymous reporting option and anti-retaliation controls;
- retention and redaction rules by case type.

### 5.12 Separation and alumni record

- resignation, retirement, contract end, termination and abandonment cases;
- notice period, last working day and approval;
- access deprovision requests and physical asset/stock clearance;
- knowledge/shift handover;
- leave/payroll recovery and final-settlement inputs;
- relieving/experience documents and exit interview;
- rehire eligibility kept private and auditable;
- post-retention anonymisation while preserving required aggregate/audit proof.

### 5.13 Analytics and workforce control centre

Core measures:

- sanctioned, active, joining, exiting, vacant and contractor headcount;
- attendance, absenteeism, late arrival, overtime and roster variance;
- labour cost by entity/factory/department/category and payroll variance;
- hiring funnel, ageing, time-to-fill and joining conversion;
- probation/confirmation and onboarding SLA;
- attrition by tenure, category, manager, factory and reason;
- skill coverage, single-point skill risk and expiring certification;
- leave liability and absence forecast;
- compliance obligations, overdue actions and audit readiness;
- data-quality completeness and unresolved identity mappings.

Metrics need a published definition, owner, dimensions, refresh time and data
lineage. Dashboards must link to the exact exception queue behind each number.

## 6. Canonical data architecture

### 6.1 Organisational scope

Every canonical HR record carries or derives an enforced scope:

```text
Company
  -> LegalEntity
      -> Establishment / Factory
          -> OrganisationUnit (department, team, line)
              -> Position
                  -> WorkerAssignment
```

`companyId` is the tenant partition. Legal entity is the employer/payroll
boundary. Establishment/factory is the attendance, holiday, statutory and
operational boundary. Organisation unit and position express who works where.

### 6.2 Recommended bounded records

| Record | Purpose |
|---|---|
| Person | Stable human identity and deduplication anchor |
| Worker | Company relationship and durable worker number |
| Employment | Employer, category, contract and lifecycle dates |
| WorkerAssignment | Effective-dated position, org, manager, site, line, grade and shift |
| PrivateProfile | Restricted identity, family, address and government identifiers |
| CompensationAssignment | Restricted, encrypted, effective-dated pay components |
| WorkforceDocument | Metadata, verification, release and retention state |
| TimeEvent | Immutable punch/manual/source event |
| AttendanceDay | Derived day result, evidence references and rule version |
| RosterAssignment | Expected shift/work pattern for a dated period |
| LeaveLedgerEntry | Grant/accrual/use/reversal/expiry/encashment transaction |
| PayrollRun / PayrollResult | Frozen population, inputs, result, approval and close |
| Position / ManpowerRequisition | Approved demand and vacancy control |
| Candidate / Offer / JoiningCase | Hiring and conversion workflow |
| SkillEvidence / TrainingRecord | Competency and validity evidence |
| ComplianceObligation / Case | Due dates, evidence, action and closure |

The existing Employee `_id` remains a compatibility identifier during
migration. New records reference it until Person/Worker IDs are fully adopted.

### 6.3 History, events and outbox

Every material mutation records:

- company and establishment;
- entity type and ID;
- action and workflow transition;
- actor, acting role and delegated authority;
- timestamp and business-effective date;
- reason/comment;
- before/after field diff with protected-field redaction;
- policy/rule version;
- request/correlation/idempotency ID.

Cross-app handoffs use an outbox with idempotency keys. Notification delivery
failure never rolls back the business transaction, and a retry never creates a
second employee, payroll journal, access request or task.

### 6.4 Retention and privacy

- classify fields as directory, internal, private, highly restricted or case
  confidential;
- encrypt protected values with managed key version metadata;
- log reads of compensation, bank, identity and confidential case data;
- redact exports by purpose and permission;
- use short-lived document links and malware scanning;
- record consent/legal basis where required;
- configure retention by document/case type and jurisdiction;
- support legal hold, verified disposal and anonymised analytics;
- exclude secrets and protected values from application logs and audit diffs.

## 7. Key end-to-end workflows

### 7.1 Hire-to-worker

```text
Position vacancy
 -> manpower requisition approved
 -> job and candidate process
 -> approved offer version
 -> accepted + pre-joining gates complete
 -> convert once to Person/Worker/Employment
 -> onboarding case
 -> biometric/access/equipment requests
 -> deployment acknowledged
 -> probation review
 -> confirmed / extended / separated
```

### 7.2 Time-to-pay

```text
Immutable time events + roster + holiday + leave
 -> attendance-day calculation with rule version
 -> exception and regularisation queues
 -> time-office period close
 -> frozen payroll input snapshot
 -> payroll preview and blocker resolution
 -> maker submission + approver decision
 -> immutable payroll close
 -> Finance journal/payment handoff
 -> payment acknowledgement
 -> payslip release
```

### 7.3 Transfer or promotion

```text
Effective-dated change request
 -> current/future state preview
 -> HR and policy approvals
 -> new assignment/compensation versions
 -> access/roster/cost-centre change requests
 -> effective-date activation
 -> reconciliation and employee letter release
```

No workflow edits historical payroll or attendance records in place.

## 8. UX and navigation target

Keep the grouped top navigation, but evolve it to work queues:

| Group | Workspaces |
|---|---|
| Today | HR command centre, my approvals, alerts, data-quality queue |
| Workforce | People directory, lifecycle cases, organisation, positions, onboarding, separation |
| Time & Leave | Live attendance, exceptions, roster, overtime, leave, period close, policy |
| Payroll | Inputs, exceptions, runs, approvals, off-cycle, payslips, Finance reconciliation |
| Hiring | Requisitions, vacancies, candidates, interviews, offers, joining |
| Skills | Skill matrix, assessments, training, certification, deployment readiness |
| Compliance | Contractor labour, statutory calendar, EHS, social compliance, cases, audits |
| Documents | Templates, requests, issued documents, acknowledgements, retention |
| Insights | Workforce, attendance, labour cost, attrition, hiring, skills, compliance |
| Configuration | Scoped policies, calendars, components, workflows, roles and integrations |

Each list needs saved views, server-side filters, pagination, bulk actions with
preview, export permissions and a stable URL. Each detail page needs summary,
current state, timeline, related cases and permitted actions.

## 9. Integration contracts

- **Management/Board:** approved workforce policy, headcount thresholds and
  escalations in; aggregated risk and approval requests out.
- **IE:** operation/skill demand in; verified workforce skill coverage out.
- **PPC:** planned labour demand in; availability/readiness projection out.
- **Production:** deployment and approved availability out; actual authorised
  incentive/productivity inputs in.
- **Stores:** PPE/uniform/asset request out; issue/return status in.
- **Supply Chain:** contractor/vendor identity projection in; HR labour
  eligibility/compliance status out.
- **Maintenance/EHS:** equipment-related incident references, training and
  certification projection without copying maintenance records.
- **Accounts & Finance:** approved payroll journal/provision and settlement
  input out; voucher/payment/reconciliation status in.
- **Identity/access:** joiner/mover/leaver request out; fulfilment result in.
- **Biometric devices:** versioned adapters, device registry, health, replay-safe
  ingestion and unmatched-identity queue.

## 10. Non-functional requirements

- multi-company and multi-establishment isolation proven by negative tests;
- all material list APIs paginated and indexed by scope plus workflow state;
- optimistic concurrency for sensitive writes;
- idempotent imports, device events, workflow transitions and handoffs;
- immutable period snapshots for attendance/payroll close;
- field-level encryption and masked display for sensitive values;
- audit completeness and tamper-evident export;
- defined recovery point and recovery time for HR/payroll data;
- accessibility and keyboard support for high-volume desks;
- responsive employee/manager self-service;
- low-bandwidth and retry-safe request submission;
- observable queues for sync failures, stuck approvals and integration lag;
- archive/partition strategy for time events, attendance and payroll history.

## 11. Delivery roadmap

### Phase 0 — boundary and safety baseline

- approve HRMS ownership and glossary;
- inventory every frontend route, backend endpoint, schema and consumer;
- define company/legal-entity/establishment/factory scope;
- build capability matrix and negative-access test harness;
- classify sensitive fields and exports;
- decide canonical attendance record and map duplicates;
- document current payroll calculation and Finance handoff;
- establish baseline reconciliation reports.

**Exit:** no unknown HR endpoint, owner or sensitive field; proposed migrations
are reversible and legacy behaviour has a measurable baseline.

### Phase 1 — scoped workforce foundation

- introduce organisational scope and scoped uniqueness;
- create effective-dated employment and assignment records;
- add safe compatibility projections for existing Employee readers;
- centralise HR access and field redaction;
- create organisation/position masters and mapping tools;
- upgrade employee import to scoped idempotent batches;
- add workforce data-quality control centre.

**Exit:** two companies/factories can hold overlapping identifiers without
cross-reading or cross-writing; an old payroll/attendance record resolves the
assignment that applied on its date.

### Phase 2 — joiner, mover and leaver lifecycle

- approved manpower requisition and position vacancy;
- candidate-to-worker conversion;
- onboarding and probation cases;
- effective-dated transfer/promotion/manager changes;
- access and equipment provisioning handoffs;
- separation, clearance and settlement-input workflow.

**Exit:** every active employee entered through a traceable lifecycle or an
audited legacy migration; no manual duplicate creation is required.

### Phase 3 — time, roster and leave hardening

- immutable time-event ledger and device monitoring;
- one canonical attendance-day record;
- roster/rotation and overnight-shift support;
- versioned attendance and leave policies;
- ledger-based leave balance;
- exception queues, close/reopen and reconciliation;
- employee and manager web self-service for time/leave.

**Exit:** any attendance or leave result can be replayed from evidence and the
exact rule version; a closed period cannot change silently.

### Phase 4 — payroll close and Finance integration

- protected effective-dated compensation;
- component/formula catalogue and effective-dated rule packs;
- frozen payroll input snapshot;
- variance and blocker workbench;
- maker-checker close/reopen controls;
- approved journal/provision handoff and payment reconciliation;
- off-cycle, arrears and separation settlement;
- payslip release and audit pack.

**Exit:** net pay, every component and every payable day are explainable;
Finance and HR do not maintain competing payment states.

### Phase 5 — skills, training and factory workforce readiness

- skill catalogue connected to IE operations;
- assessment/evidence and certification validity;
- worker skill matrix and gap analysis;
- training plan, batches and assessment;
- PPC/Production readiness projections;
- contractor workforce and deployment eligibility.

**Exit:** production staffing decisions can consume verified skill/availability
without gaining access to private HR records.

### Phase 6 — compliance, EHS and employee relations

- compliance obligation/calendar and evidence register;
- contractor statutory evidence;
- EHS incident and corrective-action workflows;
- confidential grievance/disciplinary cases;
- audit room, legal hold, retention and disposal;
- policy acknowledgement and worker communication.

**Exit:** each obligation and case has an owner, deadline, evidence, decision
history and restricted visibility.

### Phase 7 — enterprise insight and optimisation

- governed workforce metrics and semantic definitions;
- headcount/labour-cost plan versus actual;
- attrition, hiring, absence, overtime, skills and compliance analytics;
- anomaly detection that creates reviewable suggestions, never silent changes;
- succession and talent review where justified;
- archive, partition and performance programme.

**Exit:** every headline metric is traceable to scoped records and an exception
queue; analytics never bypass transactional permissions.

## 12. Quality strategy

Every implementation chunk needs:

- schema and service unit tests;
- route tests for success, wrong company, wrong factory, wrong role and wrong
  record ownership;
- transition tests for invalid and repeated actions;
- concurrency and idempotency tests;
- audit assertions including actor, reason and correlation;
- protected-field projection tests;
- payroll/attendance golden cases and rounding boundaries;
- migration dry run, reconciliation counts and rollback instructions;
- frontend rendering, permission, keyboard and empty/error-state tests;
- one end-to-end workflow proof with real API boundaries.

No payroll, attendance or leave policy goes live solely because its arithmetic
test passes. Its product wording, effective date, population and legal review
must also be recorded.

## 13. Success measures

- 100% of HR records carry enforced company and establishment scope;
- zero cross-company access in the negative test suite;
- 100% of material writes produce structured audit events;
- 100% of closed attendance/payroll periods are immutable without approved
  reopen;
- every payroll item explains its population, inputs, rules and adjustments;
- employee import reports every accepted, rejected, duplicate and changed row;
- joiner/mover/leaver tasks have owners and SLA visibility;
- all sensitive exports identify requester, purpose and row count;
- every workforce dashboard metric has an owner and definition;
- legacy endpoints retire only after consumer inventory and parity proof.

## 14. Product decisions required before implementation

1. Is GRAV currently one employing legal entity and one establishment, or must
   initial migration support several immediately?
2. Which worker populations are in scope first: office employees, factory
   workers, interns, fixed-term staff and/or contractor labour?
3. Which client is the current employee self-service experience, and should the
   web HRMS replace it or coexist with it?
4. Which system is authoritative for payment status: GRAV Finance, Tally,
   bank integration or a controlled manual acknowledgement?
5. Which attendance representation is canonical today: `Attendance`,
   `DailyAttendance`, or a defined combination pending migration?
6. Which statutory jurisdictions and establishment registrations must the
   first payroll/compliance release support? These rules require current legal
   validation before specification.
7. Who may view compensation, government IDs, medical information and
   confidential cases, including Management and platform administrators?

## 15. Recommended first implementation scope

Do **not** start with another feature screen. Start with **HRMS Chunk 0:
Boundary, access and data audit** in `docs/tasks/hrms-roadmap.md`. It creates the
evidence required to design company scope and migration without changing live
workforce, attendance, leave or payroll records.

