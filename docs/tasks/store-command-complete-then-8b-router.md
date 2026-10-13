# Finish ⌘K for all of Store, then put qwen3:8b in front of it as a router

Plan only. Nothing below has been built. Written 8 Oct 2026; every number in
"Where we are" was measured against the live dev database, read-only, that day.

## The shape of it, in one paragraph

⌘K answers from the capabilities, deterministically, and **no model ever sees
a record or writes a figure**. Phase 1 makes that cover the whole of Store, so
nothing a person can ask about is unreachable. Phase 2 adds qwen3:8b in ONE
place: when the grammar cannot place somebody's words, the model maps the
sentence onto a route ⌘K already has, and the deterministic layer answers it.
The model is a translator between English and the typed intent. It is never
the source of an answer, and when it is wrong the worst case is the same
refusal we would have given without it.

## Where we are

| | |
|---|---|
| concepts in the Store catalogues | 2,647 — all owned by an authorised capability |
| entity families | 53 declared, 52 answerable |
| generated question matrix | 418 cases, 410 asked, **410 pass**, 0 broader-than-asked |
| model on the ⌘K path | none, enforced by a test that runs the ten questions with `fetch`, `http`, `https`, `spawn` and `exec` throwing |
| assistant model today | `qwen3:32b` on RunPod over an SSH tunnel; the code's own default is `qwen3:8b` |
| local VRAM | 12 GB — fits 8b (~5 GB) or 14b (~9 GB), does not fit 32b at any usable quantisation |

### What is NOT reachable today

1. **A supplier by name.** `DIBANKSH ENTERPRISES` → "no exact meaning in
   Store"; `Fancy Corner` → no match. Both are real vendors with orders. The
   plural `suppliers` list works. Cause: supplier master is a `collectionOnly`
   family, which `isImplicitlyRecognisable` excludes from the catalogue-wide
   identity pass, and the direct fallback added for it is not reaching it.
2. **Eight declared exclusions** (`services/ai/storeCommandExclusions.js`):
   a settings singleton's identity (3 families × 2 shapes), a bare-integer
   identity (1 family × 2 shapes). Each carries a reason and what answers
   instead. These are decisions, not gaps — Phase 1 re-reads them rather than
   assuming.
3. **Collections with no catalogue entry at all.** The list below is the real
   "is any data missed" answer, and it has never been audited before.

### Store-shaped collections the catalogue does not cover (non-empty, live)

```
    127  stockitems                     87  mrfchatmessages
     83  stockissuances                 33  barcodedevices
     28  customer_account_claims        13  qc_raw_item_settings
      6  crm_sequences                   5  qc_raw_item_inspections
      1  storepurchaseorders             1  purchaseordersettings
```
plus merchandising and PPC receipt collections (3–7 rows each), and the
accounting ones (`acc_ledgers` 489, `payrollitems` 416) which are a different
application and out of scope here.

`stockitems` and `stockissuances` are probably already served by the legacy
`store` family (`store_legacy_collection_stock_item_bom_query`,
`…_stock_issuance_query`) — **Phase 1 verifies that rather than assuming it.**

### Covered families with nothing in them

Fourteen families are catalogued and empty in production: storage positions,
location movements, stock ledger, stock reservations, freight offers, sourcing
decisions, landed cost allocations, customer material returns, the four goods
receipt sub-books, intake requests, measurement size configs.

Coverage is not data. The matrix seeds them synthetically and proves the
capability works; a person asking today correctly gets "none found". Nothing
to fix — worth stating so nobody reads "53 families" as "53 families of
answers".

---

# Phase 1 — all of Store, nothing missed

## 1A · Close the supplier-name gap

The one thing a person has already tried that does not work.

- Find why the `COLLECTION_ONLY` direct fallback in `claimsFor` /
  `lookUpFamily` does not reach `supplier_master`.
- Fix so a vendor's name resolves to the vendor, with a link to its page.
- Regression: a case in the generated matrix that asks each
  `collectionOnly` family for a record BY NAME, not only as a collection.

**Done when** `DIBANKSH ENTERPRISES` and `Fancy Corner` answer, and the
matrix has a case that would have caught it.

## 1B · Audit every Store collection, not every catalogued concept

A new audit, `scripts/audits/store-collection-coverage.js`, that lists every
collection in the database and classifies it:

- **catalogued** — an `ENTITY_SPEC` reads it;
- **served by the legacy family** — a `store_legacy_collection_*` capability
  reads it (this is where `stockitems` / `stockissuances` are expected to
  land, and the audit proves it);
- **another application** — accounting, HR, Cowork, PPC, merchandising;
- **deliberately excluded** — with a durable reason in
  `storeCommandExclusions.js`, e.g. a chat transcript
  (`mrfchatmessages`), a counter (`crm_sequences`), a settings row;
- **UNCLASSIFIED** — fails the audit.

The gate is the last line: a Store collection that is none of the first four
fails the build. That is what makes "no data is missed" a property the
repository holds rather than a claim in a handoff.

Expected outcome, from the list above: a handful genuinely join the
catalogue (`barcodedevices`, `customer_account_claims`,
`purchaseordersettings`), several are excluded with a reason, the rest are
other applications.

## 1C · Re-read the eight exclusions

For each, decide again with the question in front of us:

- **settings singletons** — keep excluded; a settings row has no reference
  to type and its name already answers.
- **bare-integer identity** (`development_bom_revision`) — keep excluded, but
  check whether "development BOM revision 101" (the family named, then the
  number) should answer. It is a different shape from a bare `101` and may be
  safe.
- **`storage_position`** — the family has no identity of its own. Confirm
  `inventory_location_metric` answers everything a person would ask, and if
  so keep the exclusion and point at it.

## 1D · Make the slow path fast enough to live with

Measured on live data from a laptop:

```
named questions          0.2 – 0.7 s    lists, counts, filters, documents
a bare name              1 – 8 s        occasionally 30 s cold
```

The slow path is the catalogue-wide identity pass: ~53 families read in
parallel, up to 1,000 documents each, only when nothing recognises the words.

Options, in order of preference:

1. **Ask the likely family first.** The pass exists because a material's name
   matches no declared vocabulary. A cheap pre-step — the capabilities that
   can resolve a name, which are few — already runs; make sure it runs
   before the pass in every case, not only some.
2. **Cache the pass per actor for longer than 5 s**, since the identity space
   changes slowly.
3. **An index-backed identity lookup** instead of a scan: one query across a
   small set of identity fields rather than 53 collection reads. Biggest win,
   biggest change; costs an index.

**Done when** a bare name is under a second warm, and the worst case is
stated honestly in the handoff rather than discovered by a user.

## 1E · The coverage gate, run in CI alongside the others

```
store-command-search-coverage.js    every concept is owned          (exists)
store-command-behaviour.js          18 kinds of question behave     (exists)
store-collection-coverage.js        every collection is classified  (new)
storeCommandMatrix.test.js          410 generated cases             (exists)
store-command-journey.mjs           18 authenticated browser steps  (exists)
```

---

# Phase 2 — qwen3:8b as a router, and nothing else

## The contract

```
          what the person typed
                   │
        compileIntent (grammar)
                   │
        ┌──────────┴───────────┐
   placed it              could not place it
        │                      │
        │              qwen3:8b ──► the SAME typed intent shape
        │                      │    { intent, entity, concept,
        │                      │      filter, value, date, limit }
        └──────────┬───────────┘
                   │
      validate against the registry
      re-authorise for this actor
                   │
        the deterministic layer answers
```

**The model receives:** the sentence, and the list of route shapes it may
choose from — entity names, concept names, operations. Nothing else.

**The model never receives:** a record, a figure, a document number, a person,
a company, or any row from the database.

**The model never produces:** prose, a number, a date, a record name, a route,
a link. Only a choice among names the server gave it.

This is why 8b is enough. Choosing `{entity: "purchase_order", concept:
"status", value: "draft"}` from a fixed menu is a small-model task; writing a
paragraph about money is not, and it will not be asked to.

## Guardrails, each one testable

1. **Closed output.** A JSON object whose every field must match something in
   the registry. Anything else is discarded and the question is refused as it
   would have been without the model.
2. **Re-authorised.** The chosen capability goes through `authorizedTools` and
   the Store application floor again. A model cannot widen access by naming a
   capability.
3. **Never a value the person did not type.** A filter value the model
   proposes must appear in the sentence — the collection layer already
   enforces this (`valueStandsAlone`); the router inherits it.
4. **Bounded.** One model call, one route, the same `MAX_CANDIDATES` after it.
5. **Optional.** The model being down, slow or wrong degrades ⌘K to exactly
   what it is today. A test runs the whole matrix with the model unreachable
   and expects 410/410 still.
6. **Attributable.** An answer reached via the router says so, so a wrong
   answer can be traced to a translation rather than to the data.

## Where it plugs in

One place: `storeCommandSearch.service.js`, after `claimsFor` returns no
claims and before the `unsupported` reply. Nowhere else, and never on the path
of a question the grammar already understood — so the fast cases stay fast and
stay model-free.

## Before switching 32b → 8b

A corpus, not an opinion. Collect real questions (the assistant already has a
conversation store), run each through:

- the grammar alone — does it place it?
- the grammar + 8b router — does it place it, and correctly?
- today's 32b assistant — what does it answer?

Report: placement rate, wrong-route rate, and for the 32b path how often the
grounding guard dropped specifics. **Switch on those numbers.** If the 8b
router places 90%+ of what 32b placed and the deterministic layer answers
them, the 32b is paying rent for nothing.

---

# Phase 3 — retire the rented GPU

Only after Phase 2 measures well:

1. `OLLAMA_MODEL=qwen3:8b` locally; stop the RunPod tunnel.
2. Leave `GRAV_OPEN_JEV_QWEN_MODEL` (accounting) on 32b **until accounting's
   capabilities write their own sentences**, as the Store ones do. Accounting
   is where a model writing prose over figures matters most, and it should be
   the last thing to shrink, not the first.

---

# What this plan will not do

- **Composition across families.** "Which suppliers delivered late last
  quarter and what did it cost us" needs a join and a ranking. Neither the
  grammar nor an 8b router does it; it needs a query planner, and that is a
  separate piece of work. Saying so now so nobody expects it later.
- **Explanation.** "Why is our fabric stock out of sync" — ⌘K can show both
  figures and say they disagree. It cannot say why.
- **Conversation.** ⌘K is stateless by design. Follow-ups stay with the
  assistant.
- **Weaken any existing guarantee.** No broader-than-asked answers, canonical
  record ids, bounded candidates, permission and tenancy unchanged.

# Order of work, and the gate on each

| | step | gate |
|---|---|---|
| 1 | supplier name lookup | both vendors answer; matrix case added |
| 2 | collection coverage audit | every Store collection classified; 0 unclassified |
| 3 | act on what the audit finds | new families catalogued or excluded with a reason |
| 4 | re-read the eight exclusions | each one re-confirmed or removed |
| 5 | performance | bare name under a second warm |
| 6 | 8b router behind the grammar | matrix 410/410 **with the model unreachable** |
| 7 | measure 32b vs grammar+8b | placement and wrong-route numbers reported |
| 8 | switch and drop RunPod | owner's call, on those numbers |

Steps 1–5 are Store completion and stand on their own: they are worth doing
whether or not the router is ever built.
