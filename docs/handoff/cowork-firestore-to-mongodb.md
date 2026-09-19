# Cowork: Firestore → MongoDB

**Status:** foundation implemented and tested. **Nothing is wired in.** The
running server is byte-for-byte unaffected — the only change to the repository
is two new directories under `services/`.

**Scope conflict, recorded rather than resolved:** `docs/tasks/current-task.md`
names Store & Purchase professionalisation as the active scope. This work was
directed separately by the owner. Per `CLAUDE.md` the conflict is reported here
instead of the task file being rewritten unilaterally.

---

## Why this shape

The Cowork backend reaches Firestore from **504 call sites across 87 files**
(services 259, routes 236, middleware 7, server.js 2; a further ~105 sites live
in root-level one-off scripts and are not on the critical path).

Rewriting 504 sites by hand is weeks of mechanical edits through code that
decides who approves work and what somebody is scored on, and each edit is a
chance at a silent inversion.

So the surface those sites use was **measured**:

| Used | Count |
|---|---|
| `.get()` | 1492 |
| `.doc(` | 461 |
| `.set(` | 336 |
| `.exists` | 320 |
| `FieldValue.serverTimestamp` | 239 |
| `.update(` | 218 |
| `.size` / `.docs` / `.empty` | 150 / 124 / 34 |
| `.delete()` | 138 |
| `.add(` | 131 |
| `.where(` | 116 |
| `.limit(` / `.orderBy(` | 73 / 27 |
| `FieldValue.arrayUnion` / `increment` / `arrayRemove` / `delete` | 28 / 18 / 3 / 4 |
| `.batch()` / `runTransaction` | 23 / 12 |
| `.startAfter(` | 1 |

and — decisively — what is **not** used: no `collectionGroup`, no `onSnapshot`
on the backend, no `count()`, no `offset`, no `FieldPath`. Eight query
operators in total (`==`, `array-contains`, `in`, `not-in`, `>=`, `<=`, `<`,
`!=`). Nine subcollections (`chat`, `draft_chat`, `messages`, `dailyReports`,
`sessions`, `logs`, `reports`, `lines`, `events`) across 40 usages.

That is a bounded, emulatable surface. A facade is therefore the lower-risk
path than 504 rewrites.

## What exists

### `services/mongo/firestoreCompat.js`

The Firestore admin API, implemented over MongoDB. Call sites keep their code;
one import changes.

Semantics deliberately preserved rather than approximated:

- **`snapshot.exists` is a getter**, not a method. This codebase has been bitten
  by that difference before.
- **`update()` on a missing document throws** (`code: 5`, NOT_FOUND). Mongo's
  `updateOne` matches nothing and reports success; 218 call sites were written
  against the throw.
- **`set()` replaces; `set(data, {merge:true})` merges.**
- **Ids stay strings** — `_id` is the Firestore id verbatim, so every id already
  stored in another document, a URL, or the Mongo side still resolves.
- **Subcollections flatten** to `<parent>__<child>` with `_parentId` on each
  document; a subcollection reference scopes every read and write by it.
- **`collectionGroup()` throws** rather than being approximated. It is unused,
  and a wrong answer would be silent.

### `services/mongo/mongoStore.js`

The driver half, split out so every rule above is testable with no database.
`mongoStore(db, {client})` for production, `memoryStore()` for tests. The memory
store implements only the operators the facade emits and throws on anything
else, so a new operator fails loudly rather than passing an untested path.

`transaction()` reports `atomic: true/false`. Multi-document atomicity needs a
replica set; without one the batch applies in order and stops at the first
failure. It says which rather than implying a guarantee it is not giving.

### `services/realtime/rooms.js`

**The security boundary.** Firestore's rules were enforced by Google; they are
gone. The audience for every change is computed **from the document**, never
from a room a client asked to join — which matters because `join_cowork`,
`join_group`, `join_dm` and `join_mrf` in `server.js` take their ids straight
from the client with no check. Default is silent: a collection with no rule
reaches nobody. `taskAudience` mirrors `mayViewTask` in
`routes/task_routes/coworkAttachments.js` — one rule, not two.

### `services/realtime/changeStreamBroker.js`

One `db.watch()` over the whole database (not 41 cursors), `updateLookup` so the
audience can be computed, resume token persisted in `cowork_realtime_state`
(excluded from its own pipeline or it feeds itself for ever). On
`ChangeStreamHistoryLost` it emits `realtime:resync` and starts clean rather
than pretending; ordinary failures retry with backoff capped at 30s.

### Client half — `Cowork/lib/realtime/changeFeed.ts`

Turns `realtime:change` into the invalidation Cowork already runs on
(`notifyRepositoryChanged`). Coalesces a burst into one refetch. Carries no
document data: the client refetches, so there is never a second copy of the
truth in the browser, and an audience mistake leaks *that* something changed
rather than *what*.

## Tests

`npm test` (backend): **43 new tests, all passing.** Suite total 1717, with 4
pre-existing failures in `blockedDeadline.test.js`, `openItems.test.js` and
`salesJourneyOutcome.test.js` — untouched by this work.

`npm test` (Cowork): 12 new tests for the client feed; suite unaffected.

Two real bugs were caught by these tests before any of it ran:

1. `toEvent` read `change.ns.collection`; MongoDB change events use `ns.coll`.
   Every change would have looked like an unwatched collection and **nothing
   would ever have been delivered**.
2. `doc().set()` on a subcollection did not stamp `_parentId`, so the document
   landed with no owner and was invisible to its own scoped read. `add()`
   happened to work, which is what made subcollections look functional.

## Deployment prerequisites — not optional

1. **MongoDB must run as a replica set.** A standalone `mongod` has no change
   streams and no multi-document transactions. Single node is fine:
   `mongod --replSet rs0` then `rs.initiate()`; URI
   `mongodb://127.0.0.1:27017/cowork?replicaSet=rs0`.
2. **A backup plan for that host.** One self-hosted node has no redundancy;
   Firestore was replicated by Google.

## Next

1. Migration script: Firestore → Mongo, per collection, ids preserved, re-runnable.
2. Wire the broker into `server.js` (owner's word needed — it opens a live
   change stream).
3. Socket authentication, so room membership is earned rather than claimed.
4. Cut over per collection behind a flag, starting with `cowork_notifications`;
   dual-write and shadow-read to prove equivalence on real traffic.
   `cowork_tasks`, approvals and scoring go last.
