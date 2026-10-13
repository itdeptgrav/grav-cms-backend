Continue Lane A: the Store ⌘K deterministic command palette.

**Read first, in this order:**
1. `docs/tasks/store-command-complete-then-8b-router.md` — the plan. Follow it.
2. `docs/handoff/latest-implementation.md` — the three most recent sections.
3. `services/ai/storeCommandSearch.service.js` — the entry point; its header
   explains why there is no model on this path.

Repos: backend `/Users/risheeray/grav-cms-backend`, frontend
`/Users/risheeray/grav-cms`. Both on `NEW_CMS_BRANCH`, both with other lanes'
uncommitted work in the tree. **Preserve it. Do not commit anything.**

## What already exists — do not rebuild it

```
services/ai/storeCommandIntent.js       the typed grammar (no DB, no catalogue)
services/ai/storeCommandRouting.js      pure candidate selection, bounded at 6
services/ai/storeCommandArgs.js         fills a capability's form from its own
                                        published x-semanticOptions vocabulary
services/ai/storeCommandExclusions.js   what the palette deliberately refuses
services/ai/storeCommandSearch.service.js   the entry point
routes/ai/storeCommandSearch.js         POST /api/ai/store/command-search
grav-cms: components/shell/CommandPalette.js, commandProviders.js,
          useProviderResults.js, lib/store/commandProvider.js
```

Tests and audits that must stay green:

```
npx jest test/hr-ai/storeCommand test/hr-ai/storeTenancyGate.test.js --runInBand
    → 9 suites, 177 tests
node scripts/audits/store-command-search-coverage.js    → 2,647 concepts, 0 unexplained
node scripts/audits/store-command-behaviour.js          → 18 of 18
```

Authenticated browser journey (real login form, real Chrome, real endpoint and
middleware, throwaway in-memory database — 18 steps):

```
node scripts/e2e/store-command-server.js --port 5099
# in grav-cms:
NEXT_DIST_DIR=.next-e2e NEXT_PUBLIC_API_URL=http://localhost:5099 npx next dev -p 3005
node scripts/e2e/store-command-journey.mjs
```

## Guarantees that must not regress

- **No model on this path.** Enforced by `storeCommandNoModel.test.js`, which
  answers the ten required questions with `fetch`, `http.request`,
  `https.request`, `spawn` and `exec` all throwing.
- **Both tool families reachable** under Store application access +
  `CAPABILITIES.READ` (`"sp.read"`, never the literal `"READ"`): ≥7 `store`,
  ≥100 `store_purchase`.
- **No broader-than-asked answer.** The generated matrix
  (`storeCommandMatrix.test.js`, 418 cases / 410 asked / 410 pass) names, for
  every filtered case, the record that fails the filter and fails if it
  appears. That count must stay at 0.
- **Bounded**: ≤6 capabilities per question.
- Choices carry canonical record ids and resolve without rewriting the input.
- Data answers outrank navigation only when a verified answer exists.

## The trap that cost a day — read this before testing anything

The jest suites load **only** the Store tool modules. The server loads **every**
application's through `services/ai/gravAssistant`. Registration order differs,
and routing ties used to fall back to it — so a bare material name was answered
by a supplier reader on the server and by the inventory reader in tests. Tests
were green; the product was broken.

**Always verify a routing or discovery change with the full registry loaded**
(`require("./services/ai/gravAssistant")` in a scratch script, or through the
running server on :5050), not with the Store modules alone.

## Start at step 1: a supplier by name

`DIBANKSH ENTERPRISES` → "no exact meaning in Store"; `Fancy Corner` →
no match. Both are real vendors with orders. The plural `suppliers` list works.

What is already known: `supplier_master` is a `collectionOnly` family, and
`isImplicitlyRecognisable` in `services/storePurchaseUniversalContext.js`
excludes those from the catalogue-wide identity pass. `claimsFor` /
`lookUpFamily` in the search service has a `COLLECTION_ONLY` direct fallback
meant to cover exactly this, and it is not reaching them — find out why.
Add a matrix case that asks every `collectionOnly` family for a record BY NAME,
so this cannot regress.

Then work through steps 2–5 of the plan (collection coverage audit, act on what
it finds, re-read the eight exclusions, performance).

## Where this is going: ⌘K first, then qwen3:8b as a router only

This is the whole point of the work, so build steps 1–5 with it in mind.

**Phase 1 (steps 1–5): ⌘K covers all of Store, deterministically.** No model
anywhere on the path. Every sentence is written by the capability that read the
record, so a figure cannot be invented — that is why this path needs no
grounding guard while `gravAssistant` does.

**Phase 2 (steps 6–8): qwen3:8b translates, and nothing else.**

```
          what the person typed
                   │
        compileIntent (the grammar)
                   │
        ┌──────────┴───────────┐
   placed it              could not place it
        │                      │
        │              qwen3:8b ──► the SAME typed intent shape
        │                      │    { intent, entity, concept,
        │                      │      filter, value, date, limit }
        └──────────┬───────────┘
                   │
      validate against the registry · re-authorise for this actor
                   │
        the deterministic layer reads the data and writes the sentence
```

- **The model receives** the sentence and a menu of route names — entities,
  concepts, operations. Nothing else.
- **The model never receives** a record, a figure, a document number, a
  person, a company, or any row from the database.
- **The model never produces** prose, a number, a date, a record name, a
  route or a link. Only a choice among names the server handed it.

That is why 8b is enough: picking `{entity: "purchase_order", concept:
"status", value: "draft"}` from a fixed menu is a small-model task. Writing a
paragraph about money is not, and it will never be asked to.

**Guardrails, each testable:**

1. Closed output — every field must match something in the registry, or the
   object is discarded and the question is refused exactly as it is today.
2. Re-authorised — the chosen capability goes back through `authorizedTools`
   and the Store application floor. A model cannot widen access by naming a
   capability.
3. No value the person did not type — a proposed filter value must appear in
   the sentence (`valueStandsAlone` already enforces this; the router
   inherits it).
4. Bounded — one model call, one route, the same `MAX_CANDIDATES` after it.
5. **Optional.** The model being down, slow or wrong degrades ⌘K to exactly
   what it is today. **The gate for step 6 is the full 410-case matrix passing
   with the model unreachable.** If the router becomes load-bearing, it is
   wrong.
6. Attributable — an answer reached through the router says so, so a wrong
   answer traces to a translation rather than to the data.

**It plugs in at ONE place:** `storeCommandSearch.service.js`, after
`claimsFor` returns no claims and before the `unsupported` reply. Never on the
path of a question the grammar already understood, so the fast cases stay fast
and stay model-free.

**Before any model switch (step 7–8):** collect real questions, run each
through (a) the grammar alone, (b) grammar + 8b router, (c) today's 32b
assistant. Report placement rate, wrong-route rate, and how often 32b's
grounding guard dropped specifics. Switch on those numbers, not on judgement.
The owner has 12 GB VRAM: 8b (~5 GB) and 14b (~9 GB) fit; 32b does not, which
is why it currently runs on rented RunPod GPU over an SSH tunnel
(`scripts/dev-qwen-runpod.sh`). Accounting
(`GRAV_OPEN_JEV_QWEN_MODEL`) stays on 32b until its capabilities write their
own sentences — it is where a model doing prose over figures matters most.

**Out of scope, deliberately:** composition across families ("which suppliers
delivered late last quarter and what did it cost us" needs a join and a
ranking — a query planner, not a bigger model), explanation, and
conversation. Those stay with the assistant.

Steps 6–8 only after 1–5 are done and green.

## Live data rules

- `.env` points at the live dev Atlas. **Reads are fine; writes are not.**
- `scripts/migrations/store-purchase-company-backfill.js` is a dry run unless
  `--apply`. **It has not been run and is awaiting the owner's approval** —
  see `docs/decisions/store-tenancy-ownership-mapping.md`. Do not run it with
  `--apply`, and do not set `STORE_PURCHASE_STRICT_TENANCY=1`, without the
  owner saying so in this chat.
- Real records to test with: materials `Lining Polyster Plain`, `Rollax`,
  `Snap Metal Prong`; documents `GRN/2026-27/0006`, `PO/2026-27/0011`,
  `MRF/2026-27/0011`; vendors `DIBANKSH ENTERPRISES`, `Fancy Corner`.
- The owner's own stack runs the frontend on :3001 and the backend on :5050
  under nodemon, against that live database. Changing a watched file restarts
  their server; that is expected and fine.

## Report honestly

State what you verified and how. If something is slow, say the number. If a
question is unanswerable, name it rather than widening the answer to cover it.
