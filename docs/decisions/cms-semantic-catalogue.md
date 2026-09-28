# CMS-wide semantic catalogue and assistant compiler

Status: accepted and implemented for the shared runtime, HR and Accounting.  
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

Catalogue-only tools are never model-selectable. Qwen therefore cannot replace
one scalar enum with another.

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

## Current coverage

- HR: 10 domains, 5 entity types, 55 scalar metrics and 89 aliases, plus typed
  record tools for attendance, leave, recruitment, documents, payroll,
  performance, policy and audit.
- Accounting: 6 domains and 4 entity types covering the currently registered
  financial, ledger, voucher, company, party and general-report tools. Its
  scalar financial metrics remain owned by the existing typed financial tool
  and can be migrated into generated metric metadata independently.

## Guarantees and limits

The catalogue prevents known-domain and known-metric substitution, verifies
entity type before exact reads, preserves permissions, and detects metadata
collisions before release. It does not infer new business semantics from raw
database schemas. New modules and calculations still require an explicit
authoritative definition. Unknown language may use Qwen, but Qwen cannot
bypass the catalogue, permissions or closed execution schemas.

## Verification

- `test/hr-ai/semanticCatalogue.test.js` generates alias, domain,
  cross-catalogue and collision cases from metadata.
- `test/hr-ai/hrComprehensiveCatalogue.test.js` verifies HR claims, subject
  resolution and deterministic renderers.
- `test/hr-ai/accountingEntityClaim.test.js` verifies entity-first routing for
  cross-application terms and its fuzzy/ambiguous fail-closed boundaries.
- `test/hr-ai/qwenToolPlanner.test.js` verifies closed model planning.
- `test/hr-ai/centralAssistant.route.test.js` and
  `test/hr-access/hr-ai-parity.test.js` verify the HTTP boundary and permission
  parity against a temporary database.

Fresh-chat live verification against the configured CMS database proves:

- `what is arpita's email?` -> `hr_person_metric` / `employee.work_email`;
- `arpita's attendance` -> `hr_employee` / `attendanceSummary`;
- `designations inside accounts department?` -> `hr_departments`;
- `balance of salary payable` -> the unique `Salary Payable` ledger through
  `acc_ledger_balance`, despite simultaneous HR-payroll vocabulary, then a
  deterministic reconciliation refusal because its source postings are
  structurally incomplete;
- `what is arpita gross salary?` remains the HR configured-gross metric.

Single named-ledger answers do not pass through a second model response. A
structurally incomplete ledger never emits either its calculated or cached
figure; a complete posted-voucher balance is formatted deterministically.
