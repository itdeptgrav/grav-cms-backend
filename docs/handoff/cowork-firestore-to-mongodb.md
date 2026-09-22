# Cowork: Firestore → MongoDB

**Status (21 Sep 2026): the code path is complete end to end and behind one
switch. It has not yet run against a MongoDB replica set, because none exists
on the machines this was built on.** Until it has, this is "built and tested",
not "migrated".

**Scope conflict, recorded rather than resolved:** `docs/tasks/current-task.md`
names Store & Purchase professionalisation as the active scope. This work was
directed separately by the owner. Per `CLAUDE.md` the conflict is reported here
instead of the task file being rewritten unilaterally.

---

## The switch

`COWORK_DB=mongo` in the backend's environment. Anything else — including unset
— is Firestore, unchanged. Reversible by an environment variable and a restart,
never a deploy.

The URI must name a **replica set** (`?replicaSet=rs0`, or Atlas `mongodb+srv`).
`services/mongo/coworkDbChoice.js` refuses a standalone URI at boot, because a
standalone `mongod` serves every read and write and fails only at the first
`watch()` — by which time realtime is silently dead.

## The shape

Two facades, one on each side, so that **none of the ~650 call sites changed**:

| | where | what it answers |
|---|---|---|
| server | `services/mongo/firestoreCompat.js` | the Firestore *admin* API — `db.collection().doc().get()`, `FieldValue`, snapshots — over the MongoDB driver |
| browser | `Cowork/lib/legacy/firestoreClient.ts` | the Firestore *client* API — `collection`, `doc`, `getDoc`, `getDocs`, `query`, `where`, `onSnapshot`, `writeBatch`, `Timestamp` … — over `POST /cowork/db` |

The browser no longer holds any database connection. Every read and write it
used to make directly against Firestore (147 import sites in 10 files, all
re-pointed by one specifier swap) now goes to the server, authenticated by the
same Firebase ID token as every other request.

**Firebase Auth stays.** Only the database moved. `config/firebaseAdmin.js`
still exports `auth`, `messaging`, `rtdb`; only `db` is switched.

## What stands where Firestore's rules stood

The rules were never in this repository — only in the Firebase console — so
`services/mongo/dataAccess.js` is the only written statement of who may read
and write what from the browser. **Deny by default**: a collection with no entry
is refused, and the refusal names the collection. Reads are `employee` (any
authenticated workspace member — the directory, settings), `audience` (the same
people `rooms.js` would send the realtime change to, so nobody can be told
about a change to a record they could not read), or `owner`. A subcollection is
judged by its parent. Query results are filtered server-side per document.

## Realtime

`onSnapshot` in the browser is now: fetch, then refetch whenever the server's
`realtime:change` names the collection being watched. The server side is one
`db.watch()` change stream (`services/realtime/changeStreamBroker.js`) over the
whole database, resume token persisted, `realtime:resync` when the oplog has
moved past it. The audience for every change is computed **from the document**
(`rooms.js`), never from a room a client asked to join, and delivered only to
`user:<employeeId>` / `presence` — rooms `server.js`'s existing handshake
middleware grants after verifying the token. The legacy `join_cowork` rooms are
untouched and carry nothing new.

A subcollection change (`cowork_tasks__chat`) is delivered to its **parent's**
audience, resolved with a 5-second bounded cache.

## Semantics that would otherwise have failed silently

Each of these was found by a test or a survey before anything ran; each would
have produced no error, only wrong data:

- `snapshot.exists` — a **property** on the admin SDK, a **method** on the
  client SDK. Both facades match their own side.
- `update()` on a missing document throws NOT_FOUND on Firestore and succeeds
  on Mongo. The server facade turns the miss back into the throw.
- Timestamps: MongoDB stores a BSON `Date`; the server facade revives it into a
  `CompatTimestamp` (`toDate()`, `_seconds/_nanoseconds` on the wire), and the
  client facade revives that into a `Timestamp`. Writing a timestamp back stores
  a real `Date` again, so the field stays queryable and sortable.
- `admin.firestore.FieldValue` sentinels (308 sites) are recognised by
  constructor name; `serverTimestamp()` would otherwise have stored `{}`.
- `runTransaction` resolves to the callback's value (10 sites use it directly),
  and every operation inside is enrolled in the session — previously none was.
- Notifications are keyed `recipientEmployeeId`; duty and timers by document id.
- Presence is workspace-wide, as `workspace-member-status` already is.

## Data and indexes

`scripts/migrateCoworkToMongo.js` — `--dry-run`, `--only`, `--verify`.
Re-runnable upserts, ids preserved as strings, never writes to Firestore,
reports (never renames) field names MongoDB cannot store. Covers the
`cowork_*`, `meeting_*` and `bandconfigs` roots and the nine real
subcollections.

`services/mongo/indexes.js` — 50 indexes derived from the query shapes in the
code, ensured on every boot and by `scripts/ensureCoworkIndexes.js`. Without
them every query is a collection scan, including the `authUid` lookup on every
authenticated request.

## First real run — 22 Sep 2026, against the Atlas cluster

The copy landed **16,123 documents in 47 collections** (database `cowork`),
then Atlas refused the next collection: `already using 500 collections of
500`. The cluster is shared by nine databases; a database named `test` holds
409 of the 500. `--verify` afterwards: 39 of 45 top-level collections exact,
five differences that are live drift (Firebase kept changing during the copy —
a second pass fixes them), one real miss (`meeting_verbatim_transcripts`,
refused by the cap). Every flattened subcollection matches.

**Do not set `COWORK_DB=mongo` on a cluster at its collection cap.** Any
collection the app creates at runtime — `cowork_realtime_state` for the
broker's resume position, `cowork_task_timers__sessions` on the first timer
start, the `*__logs` children — would be refused, and the failure would look
like an application bug. Free the cap first (drop `test` if it is disposable,
upgrade the tier, or point `COWORK_MONGODB_URI` at the self-hosted replica set
the migration was planned for), then re-run the copy and verify.

## Cutover, in order

1. Start `mongod --replSet rs0`, run `rs.initiate()` once.
2. `COWORK_MONGODB_URI=mongodb://127.0.0.1:27017/cowork?replicaSet=rs0`
3. `node -r dotenv/config scripts/migrateCoworkToMongo.js --dry-run`, then
   without `--dry-run`, then `--verify` until every collection reads `ok`.
4. `node -r dotenv/config scripts/ensureCoworkIndexes.js`
5. `COWORK_DB=mongo`, restart. Watch `GET /cowork/admin/realtime-stats`.
6. Deploy the Cowork frontend from `MONGODB_DATA_BRANCH` — its `/cowork/db`
   calls need this backend.
7. Re-run the migration once more for the delta, then verify again.
8. To go back: unset `COWORK_DB`, restart. Nothing else.

## Tests

Backend `npm test`: 1814, of which the migration suites are 140 and all pass;
4 pre-existing failures in `blockedDeadline`, `openItems`,
`salesJourneyOutcome`. Cowork `npm test`: see the commit for the count; the
only failures are the two pre-existing environment-dependent ones.

## Known limits, stated rather than hidden

- Never run against a real MongoDB. Every semantic above is proven against an
  in-memory store that mirrors the driver on the points the facades depend on.
- The client-side `runTransaction` (one caller) commits its writes as one batch
  but does not re-run on a conflicting concurrent write as the SDK does.
- Both bandwidth meters patch admin-SDK prototypes the facade never
  instantiates; on MongoDB the Firestore document counts read zero.
- Firebase Realtime Database (`rtdb`, 8 call sites in `cowork.service.js`) is a
  different product and was not moved.
