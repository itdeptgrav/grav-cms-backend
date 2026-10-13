# Store & Purchase assistant coverage gate

## Objective

Every safe, authorised Store & Purchase business read must be represented by a
typed semantic concept and a deterministic server adapter. The Store product
uses both `routes/CMS_Routes/StorePurchase` and shared
`routes/CMS_Routes/Inventory`; completion therefore requires both source
inventories to have no unexplained business-data source.

“All fields” does not mean raw database access. Qwen receives capability names
and closed semantic concept IDs only. The server owns identity resolution,
tenant scope, permission checks, joins, calculations and output rendering.
Credentials, tokens, tenancy keys, internal IDs, idempotency state, mutation
commands and security/audit internals are excluded with a written reason.

## Required gates

1. Source inventory: every reachable Mongo model, Firestore collection and
   external data adapter is discovered automatically.
2. Field classification: every in-scope persisted business field is either
   exposed through a semantic concept or excluded with a durable reason.
3. Identity first: entity name/code resolution is exact and authorised before
   Qwen selects a concept; the model never invents an entity identifier.
4. No semantic substitution: a missing location cannot become stock status, a
   missing salary cannot become employment type, and an unavailable field is
   reported as unavailable.
5. Conversation continuity: only a genuinely elliptical follow-up may inherit
   a previously validated subject or period.
6. Deterministic execution: permissions and tenancy are checked again when the
   selected adapter executes, and the response contains only the requested
   projection.
7. Regression matrix: each family has positive, unavailable, ambiguous,
   unauthorised, cross-tenant and follow-up tests.
8. Release wording: the app is not “complete” or “100%” while either
   application is pending/partial, any source is unexplained, or any contract
   or regression gate is red.

## Delivery families

| Family | Representative authority | State |
|---|---|---|
| Item master | `RawItem` | contracted |
| Supplier master | `Vendor` | contracted |
| Physical locations | `LocationBalance`, warehouse location projection | contracted |
| Movement and marking history | `LocationMovement`, `Barcode` | contracted |
| Warehouses and units | `Warehouse`, `Unit` | contracted |
| Purchase orders and sourcing | purchase-order models and services | contracted |
| Receiving, inspection and put-away | goods-receipt, inspection and put-away models | contracted |
| Requests, reservations and issuance | request, reservation and issuance models | contracted through the Store/Inventory views reachable by this app |
| Customer-owned material | lot, expectation and return models | contracted |
| Disposition, sessions and operational history | operational models | contracted |

## Current verified state

The Store & Purchase route inventory discovers 55 Mongo model files. Thirty-four
are covered by typed field contracts and 21 are explicitly excluded
access/security/schema-helper dependencies. There are zero unexplained Mongo,
Firestore or external-adapter sources for this application.

The schema generator currently exposes 2,438 safe concepts across 53 business
entity types. It excludes tenancy keys, database relationship IDs, credentials,
payment identifiers, raw internal payloads and attachment/media references.
Every entity has a closed collection-query tool, and every entity with a safe
record identity also has a closed exact-record field tool. Collection queries
support list, count, existence, numeric
aggregates, grouped counts, up to three projected fields, up to three filters,
date ranges, sorting and bounded output. Qwen receives a question-ranked
semantic shortlist with human-readable labels; it never receives a model name,
collection, raw document or database handle. The server independently repeats
permission, tenant, identity and projection checks before rendering.

The Store frontend surface audit discovers 154 API endpoints across 21 product
surfaces. Seventeen read/data surfaces are catalogued; four non-assistant
surfaces are explicitly excluded: uploads/imports, workforce lookup owned by
the HR permission domain, manufacturing mutation lookup, and the Costing app
dependency. There are no partial or unclassified Store surfaces and no missing
runtime tools. Cataloguing a surface does not authorise its mutation endpoints:
the assistant remains read-only.

The live `qwen3:32b` matrix passes 5/5 schema-driven query shapes and 6/6 legacy
Store query shapes. It covers expected GRNs by month, purchase-order counts by
status, goods-receipt lists and grouped counts, three-field vendor-filtered PO
lists, worker work-order counts, manufacturing-work-order date ranges, stock
item projections and stock-issuance counts. The real CMS chat also returns the
Store operations queues, inventory valuation, purchase exceptions, open stock
counts, service-order lists and one expected June 2026 arrival.

Routing now distinguishes an exact record from a collection question before
the model chooses a tool. Receiving-register wording no longer captures a PO
whose status merely contains "received". Singleton settings and categorical
history values cannot masquerade as record identities. Entity contracts add
plural labels generically, rather than maintaining per-question aliases.

The latest verification is 16 Store-focused suites / 79 tests, 117 Store runtime
capabilities, all 53 schema-driven entity collections executing safely against
the development database, and 6/6 legacy collection paths. The semantic and
frontend-surface audits have no issues; live 32B routing passes all 11 locked
query shapes. This proves the catalogued,
authorised read/query classes; it does not promise that every imaginable
natural-language sentence will route correctly or make the whole CMS complete.

The machine-readable result of `npm run audit:assistant-cms-coverage` is the
source of truth for counts. This document defines the acceptance rule; it does
not override that result. Store & Purchase is catalogued; the CMS-wide goal
remains open while other applications are pending or partial.
