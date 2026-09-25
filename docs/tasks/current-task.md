> **Status:** Central Costing Chunks 1-2 launch sequence is the active scope.
>
> **Active brief:** `docs/tasks/central-costing-roadmap.md`.
>
> **ACTIVE IMPLEMENTATION SCOPE:** Central Costing Chunk 1, specified in
> `docs/handoff/central-costing-chunk-01-prompt.md`. Chunk 2 may start only
> after Chunk 1's company boundary, permissions, immutable version contract
> and protected API are complete.
>
> **PAUSED STORE/PURCHASE SCOPE — Chunk 1: tenant boundary, permissions,
> immutable audit history, idempotency, document sequences and safe lifecycle
> controls. NOT COMPLETE.** Architecture record:
> `docs/decisions/store-purchase-tenancy-permissions.md`.
>
> ### Chunk 1A — foundation and operational-PO pilot: IMPLEMENTED
>
> What exists and is tested:
>
> - **Tenant context** (`services/storePurchase/tenantContext.service.js` +
>   `Middlewear/storePurchaseTenant.js`) with deterministic company selection
>   and fail-closed membership.
> - **Capabilities** (`services/storePurchase/capabilities.js`) — 17 keys,
>   mapped from the existing `DepartmentRole` grants. Authentication alone
>   grants nothing.
> - **Atomic numbering** (`SpDocumentSequence`), **idempotency**
>   (`SpIdempotencyRecord`), **append-only history** (`SpActionHistory`),
>   **approval policy** (`SpApprovalPolicy`), lifecycle guards.
> - **Applied end-to-end to the operational Purchase Order router only.**
> - Frontend capability/forbidden/legacy/conflict states and a history drawer
>   on the two PO screens only.
>
> ### Chunk 1 — REMAINING, and why the boundary is not yet real
>
> **Cross-company access is NOT impossible today.** The following active
> Store/Purchase transaction routers are still unscoped, unpermissioned and
> non-idempotent, exactly as Chunk 0 found them:
>
> - MRF / material-request (review, match, fulfilment decision, issue, return)
> - Requisitions
> - Stock issuance and stock adjustment/correction
> - Vendor returns and replacement receipts
> - Barcode / lot operational writes
> - Deliveries
> - RawItem direct stock writes and its hard-delete path
> - Worksheet PO / worker work orders
> - `/api/cms/units` — still mounted with **no authentication at all**
>
> Any of those can read and mutate another company's records. Until each one
> satisfies the boundary, Chunk 1 is not done.
>
> **Passing tests do not establish completion.** The suites that pass cover
> the routers that were converted. A green run says nothing about the routers
> above, and must not be read as evidence that the boundary holds.
>
> **Chunk 2 is BLOCKED** until every active Store/Purchase transaction path
> satisfies the Chunk 1 boundary. Master-data redesign on top of an
> unenforced tenant boundary would build the new model on the same hole.
>
> **Known migration requirement:** the legacy global index `poNumber_1` must
> be dropped by an authorised migration before multi-company use. A reviewable
> script exists at `scripts/migrations/store-purchase-chunk1-indexes.js`; it
> has **not** been run against any database.
>
> ---
>
> **Chunk 0 — baseline, vocabulary and safety harness: COMPLETE
> (2026-09-01, after a technical correction pass, the Item Master addendum,
> an accuracy correction to both, and a final runtime/report-integrity
> correction).**
> All deliverables exist and are verified:
>
> 1. Full two-repo system inventory: `docs/audits/store-purchase-baseline.md`
>    (56 frontend routes, all models/routers/write paths, flow map, the
>    twelve stock-mutation sites S1–S12), **plus the Item Master audit in
>    §12** — every item-identity field across RawItem, its variants,
>    StockItem/BOM, categories, units and conversions, supplier aliases,
>    barcodes, PO/MRF/Requisition/Intake/Spend item references, budget
>    mappings, reorder fields and catalogue metadata, each classified by
>    data class, trust level, readers/writers and proposed target owner.
> 2. Read-only usage/data baseline: `scripts/store-purchase-baseline-audit.js`
>    (native-driver, provably read-only) + pure arithmetic in
>    `services/storePurchaseBaselineAudit.service.js` and
>    `services/storePurchaseItemMasterAudit.service.js`; **119 node:test
>    cases** plus jest integration tests proving every collection in the
>    gather plan — documents and indexes, including those it finds absent —
>    is unchanged after a run. The item-master half measures SKU/name
>    identity, category and unit conflicts, conversion validity, variant and
>    balance hygiene, **supplier relationships at all three layers**
>    (primaryVendor, alternateVendors[], variant aliases — with "no
>    configured supplier relationship" wording, since history may still name
>    one), **StockItem hygiene as part of one Item Master** (reference/name/
>    barcode/variant-SKU identity, productType vs trackInventory, services
>    holding balances, header vs variant totals, HSN/tax completeness),
>    cross-collection ObjectId collisions, type/lifecycle capability gaps,
>    reference integrity (BOM and barcode), **company-specific budget
>    coverage against an optional mapping collection**, and RawItem↔StockItem
>    overlap **candidates only**, by exact normalised matching with no fuzzy
>    guessing. **NOT yet run against production** — command in audit doc §7,
>    and no coverage figure may be quoted without an authorised run.
> 3. Vocabulary/navigation record:
>    `docs/decisions/store-purchase-vocabulary-navigation.md` — **PROPOSED,
>    awaiting business approval; nothing in it is adopted.** No live labels,
>    routes or navigation were changed.
> 4. Regression harness: existing `test/requests/` suites (upstream chain)
>    plus `test/store-purchase/po-receipt.route.test.js` — 22
>    characterisation tests covering the real DRAFT → ISSUED transition,
>    whether POST can bypass it, PO receipt incl. duplicate receipt, vendor
>    returns, payments, the unauthenticated `/api/cms/units` mount, absent
>    authorisation and company isolation. A literal single end-to-end test is
>    impossible today (spend→PO conversion drops the catalogue-item link —
>    documented) and none was faked.
> 5. Migration traceability: audit doc §9 — no new fields introduced.
> 6. **Item master target model, item types and migration boundaries**:
>    product plan §4.1a / §4.1b / §4.1c — **all PROPOSED, not adopted**.
>    Chunk 2's roadmap entry now specifies the decomposed Item Master it
>    must build; §4.1c fixes the point at which `RawItem.quantity` stops
>    being authoritative (a Chunk 3 gate), forbids a big-bang migration, and
>    states the **non-negotiable collection-identity compatibility
>    requirements**. Target Item identity is **stable after migration**;
>    whether it reuses a legacy id is a Chunk 2 decision, and legacy
>    references keep resolving only because legacy documents remain and
>    adapters use the legacy-source mapping — a Mongoose `ref` resolves
>    against a named collection, so unchanged ObjectIds alone preserve
>    nothing. Legacy documents are
>    retained, Items carry `legacySourceType`/`legacySourceId` under a unique
>    index, adapters serve old references, migration is batched, id
>    collisions are detected before any id reuse, snapshots are preserved,
>    and legacy collections retire only after a reference-coverage gate.
> 7. **Budget/Accounting status classified from `HEAD`**: the **committed
>    Store baseline has NO item-wise budget attribution authority at all** —
>    `RawItem.budgetLedgerId`/`budgetLedgerName`/setter audit fields,
>    `Acc_ItemCategoryBudget`, `itemBudgetHead.service.js` and request-line
>    `budgetAllocation` are none of them in `HEAD`. All are paused,
>    uncommitted integration work; the proposed target is a **company-scoped**
>    ItemAccountingProfile. The audit reads the mapping collection as optional
>    (absence = `MAPPING_COLLECTION_ABSENT` per company — unknown coverage,
>    never `CATEGORY_NEVER_REVIEWED`) and is **company-safe**, evaluating
>    every company in the committed company master including those with no
>    budget configuration at all: an override whose ledger belongs to another company is
>    `ITEM_OVERRIDE_COMPANY_MISMATCH` and the item still falls through to that
>    company's category coverage, never excluded from it. It also reports
>    override target companies, missing ledgers, unverifiable ownership, and
>    that every override is structurally unsafe because RawItem has no company
>    scope. **Discovered risk documented, not fixed:** the paused resolver
>    returns an item override before validating the ledger's company. Those
>    files were not modified or reverted.
> 8. **Barcode identity across the whole future namespace**: product-code
>    collisions item-vs-item, variant-vs-variant and item-level-vs-variant-
>    level, reported **separately** from printed lot instances (the
>    `barcodes` collection, identified by document `_id`), which are a
>    different concept and cannot collide — with one narrow cross-check for
>    an ObjectId pasted into a barcode field.
>
> The technical correction pass is recorded in audit doc §14; the item-master
> measurements and their limitations in §13; budget-attribution statuses,
> company-universe rules and mapping-absence semantics in §12.5a. The final
> pass repaired the human-readable Item Master summary (it was consuming a
> stale budget shape and printing seven `undefined` values), completed the
> company universe from the committed company master, corrected
> mapping-absence semantics, and extended the read-only proof to every
> collection the runner may read — which surfaced and fixed a latent bug
> where the outer report never forwarded the optional collections.
>
> Known-unsafe behaviour was characterised, documented (audit doc §10) and
> deliberately NOT fixed. No Item schema was implemented — that is Chunk 2.
> Pre-existing unrelated failure: `services/salesJourneyOutcome.test.js`
> (sales scope, committed, untouched by this chunk).
>
> **Next after Chunk 1:** Chunk 2 — professional master data (Item,
> ItemVariant, categories, UoM, SupplierItem, warehouse/location). Do not
> begin it before it is separately scoped and requested.
>
> **Paused:** Department-head budget app Chunk 2 and item-wise budget
> attribution after its foundation chunk. Their existing briefs remain durable
> context. Store/Purchase Chunk 8 deliberately reconnects procurement to the
> final item-wise budget model after the operational foundations are sound.
>
> **Previous paused scope — Department-head budget app:** Build a
> department-head budget app whose UI matches the finance/accountant budget
> app. Its planning brief remains
> `docs/tasks/department-head-budget-app.md`.
>
> **Chunk 1:** Shipped. Department app entry + proposals, reusing the existing
> `/api/budget-proposals` server boundary and shared frontend body.
>
> **Paused next step:** Chunk 2 - approved-budget tracking for the department's
> own approved lines and evaluated actuals.
>
> ---
>
> **Previous paused work:** Redesign the full Accounting app in
> `/Users/risheeray/grav-cms` so it follows the current Sales app design
> language. The active planning brief is
> `docs/tasks/accountant-sales-design-redesign.md`.
>
> **Important:** The Sales lead/journey scope below remains durable context, but
> it is not the active implementation target while the Account Budget feature is
> being planned.

> **Previous status before pause:** Active
>
> **Product model (current, supersedes the older 6-chunk plan below):**
> Prospect (a possible buyer we've found and are still preparing to work) and
> Active Lead (one we're actively researching, contacting and qualifying) are
> the SAME `Lead` record — internal `captureStatus: draft`/`active` is
> unchanged; "Prospect" is a user-facing rename only, no field rename, no
> migration. Sales Journey is unaffected: a qualified, specific commercial
> requirement being pursued, created only after qualification (Chunk 5).
>
> **Chunk plan:**
>
> 1. Prospect capture and setup — **done, including the follow-up correction
>    pass.**
> 2. Active Lead activities and controlled statuses — **not formally started
>    as its own chunk, but a meaningful part of it already exists**: see
>    "What Chunk 2 inherits" below. Not yet done: reviewing whether the
>    inherited work fully satisfies Chunk 2's intent, and an editable
>    identity/contact UI for an Active Lead (`LeadWorkspace.js` currently
>    shows Contact facts read-only — Prospect Setup's `IdentitySection` was
>    deliberately trimmed to a short enrichment step in the correction pass,
>    on the understanding that "deeper information belongs in Active Lead";
>    nothing currently provides that surface).
> 3. Requirement, commercial potential and qualification — partially
>    inherited (see below); not formally scoped as its own chunk.
> 4. Secure evidence/document handling — **not started.** The old,
>    unsecured Cloudinary-upload evidence path was hidden from the UI in the
>    correction pass (`EvidenceSection` in `leadSections.js`) rather than
>    presented as if complete; Source URL / Document reference text fields
>    remain available.
> 5. Conversion to Account, Contact and Sales Journey — **not started.**
>
> **Instruction:** Do not implement Chunk 2 (or any later chunk) as new work
> without it being separately scoped and requested — the items above
> describe what already exists, not a green light to proceed. When Chunk 2
> is actually taken up, start by reviewing what's listed below rather than
> assuming a blank slate.
>
> **Superseded:** `docs/tasks/lead-to-journey-roadmap.md`'s six-chunk
> breakdown ("Chunk 1 — Lead foundation", "Chunk 2 — Lead Inbox and quick
> capture", …) is an EARLIER numbering scheme for the same overall Lead →
> Sales Journey arc. The product model and chunk list above are what's
> current; that file's own status line has been marked superseded but its
> body was not rewritten.

# What exists today (for whoever picks up Chunk 2 next)

## Inherited from the "Lead correction chunk" (predates the 5-chunk product
## model above, but lands squarely inside Chunk 2/3's territory)

- Canonical qualification vocabulary: `new → contactAttempted → contacted →
  qualified/nurture/disqualified/duplicate → readyToConvert` (`new` may also
  reach `contacted` directly for the one-call-and-it-connects case).
- Every transition's prerequisite is enforced server-side in
  `services/leadQualification.js`, not only the UI: Contact Attempted needs a
  logged outreach attempt; Contacted needs a genuinely successful two-way
  contact; Nurture needs a reason + next action + follow-up date; Qualified/
  Ready to Convert share one checklist
  (`services/leadReadiness.js`'s `computeQualificationReadiness`); Duplicate
  requires a genuine, existence-verified Lead/Account link.
- Structured Activity outcomes (`no_answer`/`replied_connected`/
  `meeting_completed`/`other`), `lastContactedAt` gated on a genuinely
  successful contact, Draft Leads blocked from having Activities.
- `Lead.requirementCertainty` (confirmed-requirement side, separate from the
  researched-potential confidence fields) exists but has no UI beyond what
  `LeadWorkspace.js`'s "Supporting details" already shows.
- Manager-only owner/source reassignment; employee names always server-
  derived, never client-trusted.
- The full frontend for this lives in `LeadWorkspace.js` (Active Lead
  workspace) — "Move this lead", the qualification checklist, the duplicate
  picker, structured outcome dropdown are all already built and verified.

## What Chunk 2 (as newly scoped) still needs, if/when it's taken up

- Decide whether the inherited qualification/activity work above already
  satisfies Chunk 2's intent, or whether it needs revision now that the
  product model has Prospect/Active Lead terminology and a 5-item "Start
  Working Lead" bar that didn't exist when it was built.
- An Active Lead identity/contact editing surface (see status note above).
- Whatever else Chunk 2 is scoped to cover once that scoping happens —
  nothing below this line should be treated as decided until it is.
