# Cmd/Ctrl K for an application — how Store was done, and how to do the next one

Written 8 Oct 2026, from the Store and Accounting work (backend
`grav-cms-backend`, frontend `grav-cms`). Store and Accounting are the two
reference implementations on one shared core; every file named here exists.
Read this before starting HR, Sales, Merchandising or any
other application.

---

## In plain words

Cmd/Ctrl K is a search box that answers. You type a document number, a name,
or a short question, and it either opens the page or shows the answer right
there — "PO/2026-27/0011" shows the supplier, total and what has arrived;
"stock of Rollax" shows how much is left; "pending indents" lists them.

It works **without AI**. Every record type and every field has a name (and
other names people use for it). When your words match those names, the search
knows what you mean and reads the answer straight from the database, under the
same permissions as the screens. If your words match nothing, it says so
rather than guessing.

Doing this for an application means five things:

1. **Name everything** — every record type and field the app holds, with the
   words people use for them, and a written reason for anything kept hidden.
2. **Reach every record** — a typed number or name finds the exact record.
3. **Reach every page** — every page is findable by name, or listed as
   deliberately left out.
4. **Show the important facts** — a small card for the records people open most.
5. **Prove it** — tests that ask hundreds of generated questions and fail if any
   answer is wrong, too broad, or about another company's data.

Then it keeps improving: searches nobody could answer are saved (anonymously,
90 days) and reviewed weekly, and the missing words are added.

---

## 1 · The shape of it

```
 browser (grav-cms)                                 server (grav-cms-backend)
 ─────────────────                                  ─────────────────────────
 FrostShell  ── Cmd/Ctrl K ──► CommandPalette
   nav (top bar) ─┐              │ pages: ranked locally, instantly
   commandPages ──┘              │
                                 │ records/answers: the app's PROVIDER
 lib/<app>/commandProvider.js ───┼──► POST /api/ai/<app>/command-search
                                 │          │
                                 │          ▼
                                 │    <app>CommandSearch.service.search()
                                 │      1 resolve the actor (app grant + tenant)
                                 │      2 compileIntent(words)        grammar, no DB
                                 │      3 selectCandidates(tools)     ≤ 6, no DB
                                 │      4 claim / fill the form       the capability's own vocabulary
                                 │      5 run ≤ 3 capabilities        their own scope + projection
                                 │      6 guards (never broader than asked)
                                 │      7 cards for single records
                                 ▼
                         normaliseProviderResult  — closed shape; anything else dropped
```

**The rule that makes it safe:** the search never queries the database itself.
It only calls the application's existing assistant *capabilities* (the tools in
`services/ai/tools/*`), which already own permission checks, tenant scope,
field projection and trusted links. A second path to the data would be a second
place for those to be wrong.

---

## 1b · What is SHARED — change it once, it changes in every application

Decided 8 Oct 2026: Cmd/Ctrl K looks and behaves the same in every
application, from one implementation. An application supplies its own
records and pages; it never draws its own dialog.

| Shared piece | File | What it owns |
|---|---|---|
| the dialog, rows, keyboard, states | `grav-cms/components/shell/CommandPalette.js` | everything the person sees |
| the record card's look | `RecordCard` in the same file | label/value facts, status badge, lead vs beneath |
| what a server may send | `grav-cms/components/shell/commandProviders.js` | `normaliseResult`, `normaliseCard` — closed shapes |
| reading an answer, sending a miss | `grav-cms/lib/commandSearch/outcome.js` | `readOutcome`, `sendNote` — one meaning of 401/403/failed |
| pages beyond the top bar | `FrostShell` `commandPages` prop | palette-only pages, `keywords` |
| opening other applications | `grav-cms/components/shell/appCommands.js`, wired in `FrostShell` | the "Apps" results: the app switcher's own list (`useMyApps`), opened by `openApp` — free for every app on `FrostShell`, nothing to add |
| the card's shape, formatting, bounds | `services/ai/commandSearch/cards.js` | `FORMAT`, `buildCard`, `withCards` (one record only, ≤3, lead rule) |
| the grammar (dates, counts, limits) | `services/ai/storeCommandIntent.js` | generic despite its name; a dated day (3 Oct 2026, 03/10/2026) is ONE day |
| reading the words (periods, plurals, names) | `services/ai/commandSearch/words.js` | `periodFrom` (this/last/next week·month, today, "3 Oct"), `longestName`, `strip` — Accounting and HR |
| unanswered searches | `models/CMS_Models/AI/CommandSearchMiss.js`, `services/ai/commandSearchMisses.js`, `routes/ai/commandSearchMisses.js` | one anonymous list, `app` field, 90 days |

**Per application** — and only this:

| | Store | Accounting | HR |
|---|---|---|---|
| frontend provider | `lib/store/commandProvider.js` | `lib/accounting/commandProvider.js` (one per selected company) | `lib/hr/commandProvider.js` |
| page index + test | `lib/store/commandPages.js` | `lib/accounting/commandPages.js` (gated by the menu's own `useNavGate`) | `lib/hr/commandPages.js` (gated by the menu's own `minRole` / `filterHrNav`) |
| search door (read-only, one route) | `routes/ai/storeCommandSearch.js` | `routes/Accountant_Routes/Acc_commandSearch.js` | `routes/HrRoutes/HrCommandSearch.js` — behind `hrContract`, declared in `hrRouteContract.js`, listed in `hrMountRegistry.js` |
| engine | `services/ai/storeCommandSearch.service.js` (reuses Store's assistant tools) | `services/ai/accountingCommandSearch.service.js` (own company-scoped readers) | `services/ai/hrCommandSearch.service.js` (own readers, each family gated by the HR capability its screen declares) |
| contract: names, statuses, links, cards | `storePurchaseUniversalContract.js`, `storeRecordCards.js` | `services/ai/accountingCommandContract.js` | `services/ai/hrCommandContract.js` (allow-list projections; `NEVER_SHOWN`) |
| every collection decided | `storeCommandExclusions.js` + collection audit | `services/ai/accountingCommandExclusions.js` + `accountingCollectionCoverage.test.js` | `services/ai/hrCommandExclusions.js` + `hrCollectionCoverage.test.js` |

**Why two engines.** Store's assistant tools own Store's tenant scope, so its
palette reuses them. Accounting's assistant reader (`accountingContext`) reads
the PRIMARY company whichever is selected — reusing it would show company A's
figures to someone in company B — so the books have their own readers, every
one filtered by the company `requireCompanyScope` has checked. Pick per
application by asking: do its existing readers scope to the person's
company/tenant? If yes, reuse them (Store); if not, write readers (Accounting).

## 2 · The guarantees (do not weaken any of them)

| Guarantee | How it is held | Proved by |
|---|---|---|
| No model on the path | the service requires no model module; the optional router is injected by the route | `storeCommandNoModel.test.js` — answers with `fetch`/`http`/`https`/`spawn`/`exec` all throwing |
| Never broader than asked | a filtered/referenced/numbered question whose reader narrowed nothing is refused | generated matrix: every filtered case names the record that must NOT appear (0 allowed) |
| Bounded | ≤ 6 capabilities considered, ≤ 3 run, ≤ 3 cards | `storeCommandRegistry.test.js`, matrix |
| Permission and tenancy unchanged | app grant + read capability + each tool's `permission()`; tenant filter from the tools | `storeCommandSearch.test.js`, `storeTenancyGate.test.js`, journey steps 18–20 |
| Canonical identity | a choice carries the record id, never its label; re-authorised on the way back | `resolveChoice` tests, journey step 13 |
| Data never invented | answers and cards are the tools' own sentences / formatted fields | record-card test plants bank details and checks they never appear |
| Nothing missed silently | every concept owned; every collection classified; every page listed | three coverage gates (§ 9) |

---

## 3 · Step by step for a new application

Do them in this order. Each step has a **done when** — don't move on before it.

### Step 0 — Look before building

- Which collections does the app own? Run
  `node scripts/audits/store-collection-coverage.js --live` and read the
  "another application, by owner" section for your app's directory.
- Which assistant capabilities already exist for it? `services/ai/tools/<app>Tools.js`.
  Count how many can answer **without a model** (they have a `claim` or are
  collection tools). HR today: 21 readers, 3 without a model; Accounting 6 / 2.
- Does it already own Cmd/Ctrl K? Accounting does (`ownsCommandShortcut`) —
  integrate with its search, don't add a second one.

**Done when** you have the list of families (record types), their collections,
and their existing readers.

### Step 1 — The contract: name every family and field

Store's: `services/storePurchaseUniversalContract.js`.

- One `spec(id, label, aliases, Model, sourceModelPath, identityPaths, options)`
  per family. `identityPaths` = the fields a person types to name ONE record
  (number, code, name). `options.collectionOnly` for masters addressed as lists
  (materials, suppliers); `options.singleton` for one-row settings.
- Every field is either **exposed** (with a label and aliases) or **excluded
  with a reason** ("sensitive payment credential", "internal id").
  `fieldCoverageContract` refuses a model path that is neither.
- The workflow values a status field records are published, so "pending" is a
  filter, not a field to report.

**Done when** `scripts/audits/<app>-command-search-coverage.js` (copy Store's)
reports every concept owned, `UNEXPLAINED 0`.

### Step 2 — Capabilities that can answer without a model

For each family, three kinds of reader (Store generates the first two in a loop):

| Reader | Answers | Store file |
|---|---|---|
| collection | lists, counts, filters, dates, totals, latest N | `tools/storePurchaseCollectionTools.js` |
| record field | one field of one named record | `tools/storePurchaseUniversalTools.js` |
| specialist | a figure with its own logic (stock, location, next number) | `tools/inventoryTools.js`, `tools/storeTools.js` |

Each implements: `matches`, `claim` (or a form the grammar can fill from
`x-semanticOptions`), `recognizeSubject` (name → record), `provideContext`
(read, scoped), `renderAnswer` (the sentence), `buildLinks` (trusted links via
`assistantLinks.recordLink`). Add the app's record pages to
`STORE_RECORD_ROUTES`'s equivalent so a result can open them.

**Done when** each family answers a list, a count, and one record by its
identity in a quick script — run with the **full registry loaded** (see § 8.1).

### Step 3 — The search service and endpoint

Store's: `services/ai/storeCommandSearch.service.js`, `routes/ai/storeCommandSearch.js`.

The service is Store-shaped today (its application list, actor resolver and
contract are constants). **The first new application should extract the
reusable core** — grammar (`storeCommandIntent.js`), routing
(`storeCommandRouting.js`), form filling (`storeCommandArgs.js`), the guards,
cards and miss-saving are already application-neutral — and pass an app config:

```js
{ app: "hr", applications: ["hr"], resolveActor, toolsFor, contract,
  recordRoutes, cards, vocabulary, exclusions }
```

Copy the guards exactly; each exists because of a real wrong answer:

| Guard | The wrong answer it stops |
|---|---|
| narrowed-nothing refusal (constraint, reference, unplaced number) | "PO/2026-27/9999" answered with ten other orders |
| not-found ≠ answered; `ok:false` ≠ answered | a reader's "I couldn't match…" shown as a green answer |
| a constrained question gets ONE answer | a filtered list shown beside an unfiltered one |
| a named family answers alone | "how many material requests" answered three times |
| concept phrase beats family word inside it | "next po number" listing existing POs |
| collection-only families always asked by name | a supplier's name answered with one of its orders |

The endpoint must stay **read-only with exactly one route** (a test pins it).
Anything that writes gets its own route file (`routes/ai/commandSearchMisses.js`).

**Done when** `npx jest test/hr-ai/<app>Command…` passes the copied unit,
integration and no-model suites.

### Step 4 — The generated question matrix

Store's: `test/hr-ai/storeCommandMatrix.test.js` with
`test/support/storeEntityFixtures.js` and `storeQuestionMatrix.js`.

- Seeds a **pair** of records in every family from its own schema — one that
  matches each filter and one that must not.
- Generates questions from the catalogue's own words: exact and partial
  identity, a field of a named record, list, count, status filter, date filter,
  date window with no date named (must be refused), aggregate, an unknown
  reference (must be refused), and — for collection-only families — a record
  by NAME with the same name planted on another family's record.
- Fails on any broader answer, any unanswered supported case, and prints its
  own denominators. Store: 472 cases, 464 asked, 464 pass, 0 broader.

Shapes you decide not to answer go in the app's exclusions module
(`services/ai/storeCommandExclusions.js`) **with a reason and what answers
instead** — not in the test.

**Done when** asked = pass and broader = 0.

### Step 5 — Every collection classified

Store's: `scripts/audits/store-collection-coverage.js`,
`services/ai/storeCollectionOwnership.js`, `test/hr-ai/storeCollectionCoverage.test.js`.

Ownership comes from the model's directory. Every collection the app owns must
be catalogued, served by a legacy reader, or excluded with a reason (chat
transcripts, idempotency records, credentials, superseded queues). The audit
fails on anything else. For another app, add its directory as the gated owner.

**Done when** `--live` shows `UNCLASSIFIED 0` and the jest gate passes offline.

### Step 6 — Every page reachable

Store's: `lib/store/commandPages.js` + `lib/store/commandPages.test.mjs` (frontend).

The top bar is deliberately short. Every other page goes in one of:
`<APP>_COMMAND_PAGES` (searchable by name, with `keywords`),
`<APP>_PAGES_LEFT_OUT` (redirects, retired legacy screens — each with `why`
and `instead`), or `<APP>_RECORD_PAGES` (`[id]` pages and how they're reached).
Pass the list to `FrostShell` as `commandPages`. The test walks
`app/<app>/**/page.js` and fails on a page in no list.

Read the layout's own comments before deciding what's "retired" — Store's
layout says in words which pages left navigation on purpose.

**Done when** the page test passes and a few names open the right page in the
browser.

### Step 7 — Cards for the records people open most

Store's: `services/ai/storeRecordCards.js` (backend), `normaliseCard` +
`RecordCard` (frontend).

Up to 8 facts per family, read by canonical id through the contract's
projection (so an excluded field cannot appear), only for results about ONE
record, at most 3 per answer. A **lookup's** card leads; a **question's** card
sits beneath the answer sentence (the first Store version hid "where is soda
ash kept" behind the card).

**Done when** the card test passes, including the planted-sensitive-field check.

### Step 8 — Words people use, and the weekly look

Store's: `services/ai/storeVocabulary.js`, `models/CMS_Models/AI/CommandSearchMiss.js`,
`services/ai/commandSearchMisses.js`, `routes/ai/commandSearchMisses.js`,
`scripts/reports/store-command-misses.js`.

- Add the app's everyday words with when and why ("indent", "godown"). A word
  that is a **decision**, not a synonym ("open POs"), goes to the owner.
- Misses are saved anonymously (no person field — pinned), phone/email blanked,
  only when the server's own re-run still finds nothing, deleted 90 days after
  last typed. The collection already has an `app` field — reuse it.
- Weekly: `node scripts/reports/<app>-command-misses.js --suggest`.

### Step 9 — The browser journey

Store's: `scripts/e2e/store-command-server.js` (real auth and middleware on a
throwaway in-memory database) + `scripts/e2e/store-command-journey.mjs`
(real Chrome, real login form). Copy both; 18–20 steps covering each guarantee
in § 2, including someone without the app's grant being refused by the endpoint.

```bash
node scripts/e2e/store-command-server.js --port 5099
NEXT_DIST_DIR=.next-e2e NEXT_PUBLIC_API_URL=http://localhost:5099 npx next dev -p 3005   # in grav-cms
node scripts/e2e/store-command-journey.mjs
```

---

## 4 · The optional model router (off)

`services/ai/storeCommandRouter.js` + `storeCommandRouterContract.js`. Off unless
`STORE_COMMAND_ROUTER=qwen`. When the grammar places nothing, a local qwen3:8b
may translate the sentence into the catalogue's own words, which the ordinary
path then answers. It sees names only, never data, and its choice must survive:
closed names, authorised families only, values the person typed, anchored in
their words, **no typed word dropped**. Matrix proven unchanged with the model
unreachable.

Measured on Store (provisional, hand-written questions): it rescued 4 of 9, 0
wrong, 2–7 s on an M4. **Recommendation: leave it off; grow the vocabulary from
real misses instead.** Its useful job is suggesting meanings in the weekly report.

---

## 5 · The gates — run all of them before calling an app done

```bash
# backend
npx jest test/hr-ai/storeCommand test/hr-ai/storeTenancyGate.test.js \
  test/hr-ai/storeCollectionCoverage.test.js test/hr-ai/storeIdentitySpaceCache.test.js \
  test/hr-ai/storeRecordCards.test.js test/hr-ai/storeVocabulary.test.js \
  test/hr-ai/commandSearchMisses.test.js --runInBand          # Store: 16 suites, 269 tests
node scripts/audits/store-command-search-coverage.js          # every concept owned
node scripts/audits/store-command-behaviour.js                # 18 kinds of question
node scripts/audits/store-collection-coverage.js [--live]     # every collection classified
# frontend (grav-cms)
node --test --import ./test-support/register.mjs components/shell/*.test.mjs lib/store/*.test.mjs
# browser
node scripts/e2e/store-command-journey.mjs                    # 20 of 20
```

After a new test passes, **break the code it protects and check it fails**
(mutation check). Several Store tests passed for the wrong reason until this
was done.

---

## 6 · What went wrong on Store, so it doesn't again

1. **Tests green, product broken — registration order.** Jest loaded only the
   Store tools; the server loads every application's through
   `services/ai/gravAssistant`, in a different order, and routing ties fell to
   it. Verify routing with the **full registry** (`storeCommandFullRegistry.test.js`
   loads tools in gravAssistant's order without the model).
2. **A probe in the wrong company.** `SpCompanyMembership.findOne()` picked a
   non-primary company and three real documents "vanished". Resolve the company
   with `companyMembership.resolveCompanyForActor`, as the server does.
3. **A capability string that didn't exist.** Tests used `"READ"`; the real
   value is `CAPABILITIES.READ` = `"sp.read"`, so 110 of 117 tools were silently
   unauthorised in tests. Import constants, never retype them.
4. **Fixture fields the model doesn't have** (`grandTotal` vs `totalAmount`) —
   a card correctly showed nothing and the test blamed the card.
5. **Only references the fixture seeded were ever typed**, so "a reference
   nobody issued" went untested until live data showed ten wrong orders.
6. **A list's first link treated as the list's summary** — cards only for
   results about one record.
7. **A card covering the answer** — lookups lead; questions keep their sentence.
8. **A write added to a read-only route** — a test caught it; writes get their own file.
9. **Loading the full registry runs other apps' start-up code**: the accounting
   voucher model's `ensureVoucherIndexes()` runs an idempotent backfill on
   connect. Scripts that only need one app should load only its tools.
10. **Live data rules.** Reads fine, writes not. Tenancy migrations are the
    owner's call. Say so in the handoff whenever a probe touched live data.

---

## 7 · Checklist

- [ ] Families, collections and existing readers listed (Step 0)
- [ ] Contract: every field exposed or excluded with a reason; coverage audit 0 unexplained
- [ ] Readers answer list / count / one record without a model, full registry loaded
- [ ] Service + read-only endpoint; guards copied; no-model suite green
- [ ] Generated matrix: asked = pass, broader = 0; exclusions declared with reasons
- [ ] Collection audit: 0 unclassified (offline and `--live`)
- [ ] Page index: every page searchable, left out with a reason, or a record page
- [ ] Cards for the top records; sensitive-field test
- [ ] Starter vocabulary; misses saved (anonymous, 90 days); weekly report
- [ ] Browser journey green; mutation checks done
- [ ] Handoff states what was verified, how, the numbers, and what was not done
