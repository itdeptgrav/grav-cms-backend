# HRMS Sequential Implementation Roadmap

> **Status:** Proposed queue. This does not replace the active scope in
> `docs/tasks/current-task.md` until the user explicitly selects HRMS work.
>
> **Product plan:** `docs/product/hrms-professionalisation-plan.md`
>
> **Source audit:** `docs/audits/hrms-existing-codebase-audit.md`

## Sequencing rule

Each chunk is independently reviewable, releasable behind compatibility
boundaries and small enough for one implementation/review cycle. A later chunk
must not start until the preceding chunk's acceptance evidence exists.

## Chunk 0 — boundary, endpoint and data audit

**Goal:** establish the truth of the existing HR system without writes or
migrations.

- catalogue all HR/admin/employee frontend routes and backend mounts;
- classify each endpoint by persona, operation, data sensitivity and current
  guard;
- map every HR collection, reference, unique index and external consumer;
- profile record counts, missing identifiers and duplicate candidates using
  read-only queries;
- map `Attendance` versus `DailyAttendance` production consumers;
- map payroll calculation inputs and Accounts/Finance consumers;
- identify employee self-service client(s);
- publish current-state context and data-flow diagrams;
- create a regression command list and baseline results.

**Must not:** edit schemas, backfill records, change route guards, alter payroll
or reprocess attendance.

**Acceptance:** every in-scope route and collection has an owner and proposed
disposition; unknowns and live-data assumptions are explicitly listed.

## Chunk 1 — HR authorisation contract

**Goal:** one policy for HR application access, record scope and protected
fields.

- define capability catalogue and role templates;
- central HR route guard using verified application grants;
- record-scope resolver for company/factory/department/team/self;
- field projection for directory/private/compensation/case data;
- temporary compatibility mapping for legacy `hr_manager` tokens;
- negative tests for every endpoint family;
- access-denial audit without leaking the protected record.

**Acceptance:** authentication alone grants no HR data; every route family has
wrong-role and wrong-scope tests; existing authorised journeys still work.

## Chunk 2 — organisational scope foundation

**Goal:** introduce Company, Legal Entity, Establishment/Factory and stable
organisation scope without changing current business results.

- scoped organisation models and indexes;
- default-scope migration plan for existing records;
- request context and scoped repository/query helpers;
- company/factory-aware settings lookup;
- mapping from HR organisation units to access departments and Finance cost
  centres;
- read-only reconciliation report before any backfill;
- dual-read compatibility where required.

**Acceptance:** identical employee numbers, biometric IDs and payroll periods
can exist in two scopes; cross-scope route tests fail closed.

## Chunk 3 — workforce identity and effective-dated assignment

**Goal:** separate stable person/worker identity from changing employment and
assignment facts.

- Person, Worker, Employment and WorkerAssignment boundaries;
- dated department, position, manager, grade, site, line and shift;
- compatibility projection to existing Employee reads;
- optimistic concurrency and reason-required changes;
- historical-as-of query service;
- duplicate identity review queue and merge policy.

**Acceptance:** a future transfer does not alter historical manager,
attendance, approval or payroll interpretation.

## Chunk 4 — protected employee data split

**Goal:** enforce least privilege for compensation, banking, identity and
private profile information.

- sensitivity classification and response allowlists;
- protected profile and compensation records;
- encryption key/version metadata and masked values;
- read-access event logging;
- export-purpose and row-count audit;
- dual-write/backfill/reconciliation/rollback plan.

**Acceptance:** directory readers cannot receive protected values even when a
frontend accidentally requests or renders them.

## Chunk 5 — organisation and position control

**Goal:** make approved positions and reporting structure the source of
workforce demand.

- organisation tree and dated changes;
- job/grade/designation/position catalogues;
- sanctioned/filled/vacant/frozen position states;
- occupancy and reporting-line validation;
- manpower summary and data-quality queue;
- controlled access-department mapping.

**Acceptance:** headcount and vacancy figures reconcile to active assignments;
organisation renames do not change historical labels or application access.

## Chunk 6 — recruitment requisition and hire conversion

**Goal:** connect existing recruitment to workforce identity without duplicate
entry.

- manpower requisition and approvals;
- requisition-to-job link;
- interview scorecard and decision contract;
- offer version/approval/acceptance;
- duplicate check against Person/Worker/Candidate;
- idempotent conversion and complete audit link;
- onboarding case creation.

**Acceptance:** retrying hire conversion creates no second worker; every new
hire traces to an approved position or authorised exception.

## Chunk 7 — onboarding, probation, transfer and separation cases

**Goal:** one case engine for joiner/mover/leaver work.

- configurable checklists and responsible owner;
- access/biometric/equipment/document handoffs;
- probation review, extension and confirmation;
- dated transfer/promotion/manager change;
- separation, clearance and final-settlement inputs;
- SLA, blockers, escalation and timeline.

**Acceptance:** no lifecycle state can complete while a required gate is open;
downstream requests are replay-safe and reconciled.

## Chunk 8 — canonical time-event and attendance-day boundary

**Goal:** preserve evidence and remove ambiguity between attendance models.

- immutable TimeEvent ingestion contract;
- source/device/idempotency identity;
- canonical AttendanceDay calculation result;
- rule-version and roster references;
- compatibility readers for current screens and consumers;
- discrepancy report against current daily attendance;
- archive policy for raw events.

**Acceptance:** replay produces the same day result for the same evidence and
rule version; no legacy consumer changes until parity thresholds pass.

## Chunk 9 — roster, overtime and attendance close

**Goal:** make expected work and period closure explicit.

- roster/rotation/overnight shifts;
- device health and unmatched identity queues;
- regularisation and overtime state machines;
- team/time-office work queues;
- attendance period reconcile, close and approved reopen;
- dated manager authority.

**Acceptance:** a closed period cannot be silently reprocessed; every correction
states evidence, reason, actor and resulting revision.

## Chunk 10 — leave policy and entitlement ledger

**Goal:** replace mutable balance interpretation with explainable transactions.

- effective-dated scoped leave policy;
- accrual/grant/use/reversal/lapse/encashment entries;
- request reservation and overlap controls;
- migration reconciliation to current balances;
- year close and adjustment approval;
- attendance/payroll projection.

**Acceptance:** every displayed balance is the sum of ledger entries and every
leave-to-payroll effect references an approved application/version.

## Chunk 11 — employee and manager self-service web

**Goal:** complete the missing web self-service experience.

- employee home, own profile projection and controlled change requests;
- attendance, roster, leave, overtime, documents and payslips;
- manager inbox and team calendar;
- delegated approval;
- responsive, accessible and low-bandwidth behaviour;
- coexistence/migration contract for the current mobile client.

**Acceptance:** self-service endpoints cannot select arbitrary employee IDs;
managers see only records in their effective reporting scope.

## Chunk 12 — payroll input snapshot and close

**Goal:** make existing payroll explainable, repeatable and immutable by period.

- effective-dated compensation component assignment;
- payroll population and frozen input snapshot;
- attendance/leave/overtime cutoff versions;
- blocker and variance workbench;
- maker-checker submit/approve/close/reopen;
- audit pack and golden payroll cases;
- compatibility with current payslips.

**Acceptance:** rerunning a closed payroll cannot mutate it; a reproduced result
identifies every source input and exact rule version.

## Chunk 13 — Finance payroll handoff

**Goal:** one payment and accounting truth.

- approved payroll journal/provision contract;
- idempotent Finance handoff and acknowledgement;
- payment batch/reference status from Finance;
- reconciliation and exception queue;
- controlled payslip release policy;
- cancellation/reversal semantics.

**Acceptance:** HR never independently invents payment success; retrying a
handoff creates no duplicate voucher or payment instruction.

## Chunk 14 — skills and training

**Goal:** provide factory-ready competency control.

- skill/proficiency catalogue;
- IE operation mapping;
- assessment and evidence;
- certification expiry;
- training needs, batches, attendance and results;
- line/factory coverage and deployment-readiness projection.

**Acceptance:** Production/PPC can read eligibility and coverage without private
HR data or the ability to alter a worker's skill evidence.

## Chunk 15 — contractor labour

**Goal:** govern non-employee workers without duplicating supplier ownership.

- contractor reference from Supply Chain;
- contractor worker identity and duplicate detection;
- contract/site eligibility, documents and expiries;
- deployment, attendance and wage-input boundaries;
- compliance exceptions and audit pack.

**Acceptance:** an expired or incomplete worker is visibly ineligible for
deployment; HR does not create a second vendor master.

## Chunk 16 — compliance, EHS and employee relations

**Goal:** controlled compliance obligations and confidential case handling.

- obligation/register calendar;
- audit and evidence pack;
- incident and corrective action;
- grievance/disciplinary restricted cases;
- legal hold, retention and anonymisation;
- policy acknowledgement.

**Acceptance:** case visibility is narrower than general HR access and every
deadline/action has accountable ownership and immutable history.

## Chunk 17 — governed analytics and archive

**Goal:** scale reporting without querying operational collections ad hoc.

- metric catalogue and semantic definitions;
- scoped workforce/time/payroll/hiring/skills/compliance projections;
- drill-through to authorised exception queues;
- historical snapshots and slowly changing dimensions;
- time-event/attendance/payroll archive and partition strategy;
- query-performance budgets and observability.

**Acceptance:** every metric reconciles to transactional controls, respects
row/field permissions and has documented freshness.

## Programme-wide stop conditions

Stop and return to product/architecture review if a chunk would:

- add a new employee/person master;
- infer access from organisation assignment;
- make UI filtering the tenant boundary;
- overwrite an approved historical baseline;
- place payment truth in HR;
- copy IE, Production, Supply Chain, Stores or Finance facts into HR ownership;
- hard-code a statutory rule without scope, effective date and legal sign-off;
- migrate live records without dry-run counts, reconciliation and rollback;
- retire an existing route before all consumers and deep links are accounted
  for.

