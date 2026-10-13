# CMS-wide semantic catalogue and assistant compiler

Status: accepted and implemented for the shared runtime. Planner,
Configurations and Store are fully catalogued applications. HR and Accounting are explicitly partial;
Sales customer-master, Store supplier-master and Inventory raw-item master are
completed slices inside applications that remain pending.
Date: 27 September 2026.

## Problem

Tool descriptions and model enums are insufficient correctness boundaries. A
schema-valid model answer can still select the wrong business domain, entity or
metric. Adding a phrase rule after each failure does not scale and cannot prove
coverage.

## Decision

Every assistant-enabled CMS application declares machine-readable metadata:

- business domains and their ordinary vocabulary;
- entity types and their ordinary vocabulary;
- canonical scalar metrics, aliases, source, path, value type and temporal
  grain;
- each tool's catalogue, compatible domains and compatible subject types;
- permission and deterministic data adapter, which remain server-owned.

`services/ai/semanticCatalogue.js` compiles and validates this metadata. It
provides longest-unique metric resolution, explicit domain detection, alias
collision audits and cross-catalogue candidate selection.

Metric words may repeat across different entity types. Resolution is therefore
entity-first: `status` is not resolved until the server has proved whether the
business identity names a purchase order, worker work order, manufacturing
work order or order request. Alias collisions inside one entity still fail the
audit. This prevents a valid field on one record type from answering a question
about another record type.

## Runtime order

1. Resolve the signed-in actor and remove unauthorised tools.
2. Run catalogue-only claims. Exact scalar claims must resolve their subject to
   a real typed entity before they may execute. A unique verified master-data
   entity outranks overlapping vocabulary from another application; fuzzy,
   missing and multi-match entities never claim a route.
3. Detect every explicit business domain across every registered catalogue.
4. Offer Qwen only authorised tools compatible with those domains. Ambiguous
   cross-application language keeps the valid candidates from every catalogue.
5. Validate the closed arguments, re-authorise the selected tool and execute a
   deterministic adapter.
6. Render exact facts deterministically. Use grounded model synthesis only for
   broad evidence packets.

A broad business concept may declare several response fields and temporal
variants. The catalogue compiler, not Qwen, chooses the authoritative source:
for example, an employee's unqualified `salary` is the current configured
salary summary, a named month is a posted payroll summary, and a year-only
request is an annual payroll summary. Specific concepts such as gross, net or
CTC continue to resolve to one exact metric.

Known catalogue language is claimed before model planning. A catalogue may
also expose a semantic-linking fallback for unseen paraphrases: Qwen may choose
only a canonical concept ID, never a database path, collection or value. The
adapter independently resolves the real entity and rejects a concept belonging
to another entity type before reading data. High-consequence catalogues may
remain entirely non-model-selectable; Accounting financial scalars do.

## Extension protocol

A new CMS application must:

1. define its domains and entities;
2. define every scalar metric and its authoritative source/temporal grain;
3. register tools with `semantic.catalogue`, `semantic.domains` and
   `semantic.subjects`;
4. keep database access, permission checks and calculations in deterministic
   services;
5. add generated catalogue audits and representative live fixtures.

Adding a new datapoint means one catalogue entry and one authorised adapter,
not a new sentence matcher. A module is not considered assistant-complete when
its catalogue audit, permission parity or cross-domain negative tests fail.

The application-level coverage manifest lives in
`services/ai/cmsApplicationManifest.js`. Every route area is explicitly
`catalogued`, `partial`, `pending` or `excluded`; exclusions require a reason.
`catalogued` is reserved for an application whose reachable Mongo models,
Firestore collections, dynamic collection references and external data
adapters are all explicitly contracted. `partial` means safe typed tools exist
but whole-application coverage is not claimed. The
`npm run audit:assistant-cms-coverage` report is the CMS-wide migration gate.
It prevents the absence of a tool from being mistaken for model intelligence
or complete product coverage.

The same manifest is enforced at runtime. When a request clearly belongs to a
pending business application and no completed catalogue owns it, GRAV returns
a deterministic coverage message without asking Qwen to answer from memory.
Likewise, a detected catalogued domain with no authorised compatible tool is a
deterministic permission refusal. Missing coverage or permission therefore
cannot be disguised as a plausible CMS answer while migration is in progress.

## Current coverage

- HR: 10 domains, 5 entity types, 65 metrics/concepts, plus typed
  record tools for attendance, leave, recruitment, documents, payroll,
  performance, policy and audit.
- Accounting: 6 domains, 4 entity types and 12 financial concepts covering
  summary, revenue, expenses, direct revenue/expense, gross/net profit and
  margin, assets, liabilities and equity, plus the registered ledger, voucher,
  company, party and general-report tools. Financial concepts are
  catalogue-only: Qwen cannot select their metric argument and exact answers
  never pass through a second model response.
- Sales customer master: 29 concepts backed by a source-field contract over all
  69 persisted paths (35 exposed, 34 excluded). Exact customer identity and
  database-backed Sales read access are required; missing ownership fails
  closed rather than falling back to a global customer row.
- Store & Purchase supplier master: 28 concepts backed by a source-field
  contract over all 63 persisted paths (32 exposed, 31 excluded). Bank details,
  signatures, tenant keys, internal actor IDs, migration metadata and recovery
  markers cannot enter assistant context. Reads require `sp.read`, exact
  supplier identity and the Store tenant filter.
- Inventory raw-item master: 23 concepts backed by a source-field contract over
  all 95 persisted paths (38 exposed, 57 excluded). Transaction history is not
  smuggled into the current-state master contract; it requires its own temporal
  ledger contract.
- Planner: 20 concepts over both Planner schemas. All 28 persisted paths are
  classified (18 exposed, 10 excluded), every query is constrained by the
  signed-in owner, and no internal owner or record identifier enters context.
- Configurations: 20 concepts covering measurement categories, measurement
  templates and the MRF budget switch. All 30 persisted paths across the three
  read sources are classified (19 exposed, 11 excluded). The StockItem model
  reached by category assignment is explicitly excluded as a mutation-only
  dependency; it is not silently treated as Configuration read data. Missing
  singleton settings are reported as absent rather than created or defaulted by
  an assistant read.
- Store: 181 concepts cover purchase orders, worker work orders, numbering,
  vendor/worker directories, Store-visible order requests, manufacturing work
  orders, bills of material and stock issuance. All 13 reachable model sources
  are accounted for: 9 collection models are contracted and 4 embedded schema
  helpers are explicitly excluded as non-collections. Its 186 classified paths
  contain 154 individually addressable safe fields and 32 exclusions. Live
  stock requirements, shortfalls, verification and issuance progress are
  server calculations; payment identifiers, attachment URLs and internal join
  IDs never enter conversational answers.
- CMS-wide source inventory: 32 application areas and 374 route files are
  accounted for. Three applications are fully catalogued, HR and Accounting are
  explicitly partial, 20 business applications are pending, and 7
  transport/security/infrastructure areas are excluded. Recursive static
  discovery currently finds 287 reachable Mongo model files, 60 Firestore
  collection names, 30 unresolved dynamic collection references and 2 external
  data adapters. Sixteen Mongo models are under field contracts; no Firestore
  collection is yet under a field contract. The manifest is intentionally not
  complete while any partial or pending application remains.

## Guarantees and limits

The catalogue prevents known-domain and known-metric substitution, verifies
entity type before exact reads, preserves permissions, and detects metadata
collisions before release. It does not infer new business semantics from raw
database schemas. New modules and calculations still require an explicit
authoritative definition. Unknown language may use Qwen, but Qwen cannot
bypass the catalogue, permissions or closed execution schemas.

An exact, permission-scoped business identity also outranks generic application
vocabulary. A material, supplier or other record whose real name contains a
word such as `Board`, `Sales` or `Store` is first resolved by its authorised
data adapter; that embedded word cannot activate the uncatalogued-application
fallback. The model receives only the eligible semantic capability and closed
concept IDs, never the recognised record. If no real identity resolves, the
ordinary application coverage boundary still applies.

Standard employee identity fields are an explicit CI contract. Full name,
title, nickname, both managers, department, designation, job title, location,
shift, operating status and both work/personal email may not disappear from the
catalogue without failing tests. Composite values such as a full name are
assembled only from the authorised employee record; Qwen never guesses them.

Complete new questions are also a hard context boundary. Previous tool,
subject and period arguments are supplied to Qwen only for an explicitly
elliptical follow-up such as “what about October?” This prevents an earlier
month or employee from leaking into a later self-contained request.

Every schema-backed master-data slice also has a closed field-coverage
contract. A persisted path must be exposed through one typed concept or
excluded with a durable reason. A new database field therefore fails the audit
instead of becoming silently inaccessible or leaking through a broad document
read. Exact scalar renderers project only approved fields and return only the
requested concept.

The source inventory follows local dependencies from every route without
executing application code. It recognises literal and file-local constant
Firestore collection names, Mongo model imports and supported external data
SDKs. A computed collection expression is reported as unresolved rather than
guessed. This is a release boundary: a fully catalogued application may have no
uncontracted model, uncontracted collection, unresolved collection expression
or uncontracted external adapter.

## Verification

- `test/hr-ai/semanticCatalogue.test.js` generates alias, domain,
  cross-catalogue and collision cases from metadata.
- `test/hr-ai/hrComprehensiveCatalogue.test.js` verifies HR claims, subject
  resolution and deterministic renderers.
- `test/hr-ai/accountingEntityClaim.test.js` verifies entity-first routing for
  cross-application terms, all financial scalar claims and renderers, and the
  fuzzy/ambiguous fail-closed boundaries.
- `test/hr-ai/qwenToolPlanner.test.js` verifies closed model planning.
- `test/hr-ai/centralAssistant.route.test.js` and
  `test/hr-access/hr-ai-parity.test.js` verify the HTTP boundary and permission
  parity against a temporary database.
- `test/hr-ai/salesCustomerContract.test.js` and
  `test/hr-ai/storeSupplierContract.test.js` verify exact identity claims,
  ambiguity refusals, permission gates and one-field deterministic rendering.
- `test/hr-ai/inventoryItemContract.test.js`,
  `test/hr-ai/assistantSubjectPrecedence.test.js`,
  `test/hr-ai/plannerContract.test.js` and
  `test/hr-ai/plannerAssistantContext.test.js` verify the Inventory and Planner
  field/permission boundaries, including collisions between record names and
  application names.
- `test/hr-ai/sourceInventory.test.js` verifies Firestore constant discovery,
  dynamic-reference refusal and external-adapter reporting.
- `test/hr-ai/configurationContract.test.js` verifies complete Configuration
  field coverage, exact named-entity routing, one-field rendering, missing-row
  refusal and signed-in read permission.
- `test/hr-ai/storeApplicationFieldContracts.test.js`,
  `test/hr-ai/storeSemanticContract.test.js` and
  `test/hr-ai/storeAssistantContext.integration.test.js` verify Store source
  closure, entity-first routing, one-field answers, sensitive-field suppression
  and database-backed material shortfall calculations.

Fresh-chat live verification against the configured CMS database proves:

- `what is arpita's email?` -> `hr_person_metric` / `employee.work_email`;
- `arpita's attendance` -> `hr_employee` / `attendanceSummary`;
- `designations inside accounts department?` -> `hr_departments`;
- `balance of salary payable` -> the unique `Salary Payable` ledger through
  `acc_ledger_balance`, despite simultaneous HR-payroll vocabulary, then a
  deterministic reconciliation refusal because its source postings are
  structurally incomplete;
- `what is arpita gross salary?` remains the HR configured-gross metric.
- `expenses for this yr` -> `financials.expenses`, and returns only total
  expenses;
- `what is our gross profit?` -> `financials.gross_profit`, and returns only
  gross profit;
- only an explicit `P&L`/financial-summary request returns the full financial
  packet.
- a real database-backed Store reader resolves an exact supplier and returns
  only its requested email field. The Store tenant service's documented legacy
  read-through remains temporary migration debt; the assistant does not invent
  ownership or bypass that service.

Single named-ledger answers do not pass through a second model response. A
structurally incomplete ledger never emits either its calculated or cached
figure; a complete posted-voucher balance is formatted deterministically.
