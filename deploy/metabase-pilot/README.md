# Metabase self-service reporting — LOCAL PILOT

**Development preview. REAL Accounting data. Not deployable.**

Metabase's visual query builder, embedded in the GRAV Accounting app at
`/accountant/custom-reports`, over the **Accounting reporting mart** in a local
PostgreSQL database — dimensions and a flattened voucher-line fact, synced from
the real MongoDB Accounting collections.

It exists to answer one question before anyone spends money: **does self-service
reporting actually work for an accountant, using Metabase's own builder, saving,
and Excel export?**

## The synthetic dataset is gone

The pilot began over an invented dataset in schema `accounting`. That schema has
been **dropped** (`migrations/reporting/V002__drop_synthetic_pilot_schema.sql`)
and its seed files moved to `seed/synthetic/`, which is deliberately not
mounted. Two schemas of plausible-looking Accounting tables in one database, one
of them fiction, is how a made-up figure ends up in a board pack.

The fixtures are kept for throwaway databases — see `seed/synthetic/README.md`.

---

## What this is not

| | |
|---|---|
| Not production | Authentication is a **browser-readable API key**. Production needs per-request JWT SSO minted by the GRAV backend. The frontend refuses to initialise when `NODE_ENV=production`. |
| Not multi-tenant | No row-level security yet. Every mart row carries `organization_id` — the sandbox key — but Metabase sandboxing needs a Pro/Enterprise licence and is a later slice. Today one organisation owns every company, so there is nothing to separate. |
| Not incremental | Full refresh only. Schedulers, change streams and deletion tombstones are a later slice. The mart is as fresh as the last time somebody ran the sync. |
| Not the whole mart | Companies, groups, ledgers, vouchers and voucher lines. Invoices, expenses, bank transactions, budgets, bill allocations and cost centres are later slices. |

**The mart holds no credentials, tokens, consent records, bank account numbers,
PANs or attachment locations.** The sync's projections are an allow-list and
`test/reporting/mart-sync-unit.test.js` asserts it against documents stuffed
with all of them.

---

## Start

Prerequisites: Docker (Colima is fine) and a free `127.0.0.1:3100` / `:15433`.

```bash
cd deploy/metabase-pilot
cp .env.example .env          # then set the passwords it names
make up                       # start; waits for health (~60-90s on first boot)
```

Then build the mart, from **`grav-cms-backend`** (not from here):

```bash
npm run reporting:migrate -- --apply     # schema + curated views
npm run reporting:roles   -- --apply     # reporting_sync + metabase_reader
npm run reporting:sync    -- --full      # real data from MongoDB
npm run reporting:verify-roles           # prove the reader cannot write
```

Finally, point Metabase at it:

```bash
./bootstrap.sh                # idempotent; repoints the connection and rescans
```

`bootstrap.sh` prints the values for the frontend. Put them in
`grav-cms/.env.local` (the API key is in `deploy/metabase-pilot/.env.local`,
which is git-ignored and never printed):

```
METABASE_PILOT_ENABLED=true
METABASE_PILOT_SITE_URL=http://localhost:3100
METABASE_PILOT_COLLECTION_ID=<printed>
METABASE_PILOT_API_KEY=<from deploy/metabase-pilot/.env.local>
```

**None of these carry a `NEXT_PUBLIC_` prefix, and that is the point.** Next
INLINES `NEXT_PUBLIC_*` into the JavaScript it emits, so a key read that way is
compiled into the bundle — production included — and no runtime check can take
it back out. These are server-only, read at runtime by
`app/api/accountant/metabase-pilot-config`, which **refuses with 404 outside
development** (the route is still compiled into a production build — it simply
answers as though it were not there), refuses unless
`METABASE_PILOT_ENABLED=true`, refuses a non-loopback URL, and then
**authenticates the caller against the GRAV backend**.

That last step is real authentication, not a presence check: the endpoint
forwards the caller's `Authorization` header and cookies to
`GET /api/accountant/auth/me` and serves configuration only for a confirmed
non-legacy Accounting user with an organisation and `permissions.canView`. An
arbitrary `Authorization: anything` is refused, as is a legacy bootstrap
session, a session with no organisation, and any case where the backend is
unreachable or answers with something other than JSON.
`npm run check:metabase-leak` builds for production and fails if a sentinel key
appears anywhere in the output. **Stop `next dev` before running it** — it
overwrites `.next`, and a dev server whose build directory changes underneath it
answers 500 on every route until it is restarted.

Restart `next dev`, then open **GRAV Accounting → Reports → Custom Reports**.

> Reading the key: use `sed -n 's/^METABASE_PILOT_API_KEY=//p' .env.local`.
> `cut -d= -f2` truncates it, because the key can contain `=`.

## Stop, reset, verify

```bash
make down      # stop, keep data
make reset     # stop and DESTROY the volumes (the mart must then be rebuilt)
make verify    # prove the safety properties
make logs
```

`./verify.sh` checks, and fails loudly on any of them:

1. the read-only role can `SELECT`;
2. it cannot `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `CREATE TABLE`,
   `CREATE SCHEMA` or `DROP`;
3. it cannot reach Metabase's application database;
4. the mart is non-empty and **every posted voucher balances**;
5. nothing is bound to `0.0.0.0`;
6. the pilot identity sees only the Accounting mart, **native SQL is
   refused**, and the query builder works;
7. it can save, reopen, list, edit and download XLSX in `GRAV Accounting Pilot`,
   and **cannot** save into the root collection, any other shared collection, or
   a personal collection.

Every Metabase id is resolved **by name** at run time. Hardcoding database 2 /
table 192 broke the moment `make reset` renumbered them, which meant
verification quietly tested nothing on a fresh instance.

---

## How it is put together

```
postgres-app         Metabase's application database. No host port at all.
                     Postgres, not H2 — H2 is a single file that cannot be
                     backed up while running and corrupts under load.

postgres-reporting   The Accounting reporting mart. 127.0.0.1:15433. An empty
                     server on first boot: schema, roles and data all arrive
                     from the backend's reporting:* commands.
                     A SEPARATE server, not another database in the same one,
                     so the read-only role has no path to Metabase's own data
                     even if a grant were wrong.

metabase             v1.63.1, pinned. 127.0.0.1:3100.
                     `latest` would change the SDK compatibility contract
                     underneath the frontend without warning.
```

### The read-only role

Metabase connects as `metabase_readonly`, which holds `SELECT` and nothing
else. Read-only is asserted by **removing** privileges (`REVOKE ... FROM
PUBLIC`), not by assuming none were granted — every role inherits `PUBLIC`.
`seed/lib/roles.sql` is the whole of it, and `verify.sh` proves it by trying
each forbidden verb.

### Collection permissions

Data permissions decide what the pilot identity may QUERY. Collection
permissions decide what it may SAVE INTO and BROWSE — a separate graph with its
own revision. Granting one does not grant the other, and the same inheritance
trap applies: "All Users" ships with `write` on the root collection and
everything under it, so restricting the pilot group alone changes nothing.

`bootstrap.sh` gives the pilot group `write` on `GRAV Accounting Pilot` and
`none` everywhere else, and strips every other non-admin group's collection
grants. The result is that the pilot identity can see exactly one collection.
`verify.sh` proves refusal rather than concealment: it enumerates the other
collections with the ADMIN session and then tries to write to each of them with
the PILOT key.

### Native SQL

Two settings, and the second is the one that actually mattered:

- the pilot group gets `create-queries: "query-builder"`;
- **every other non-admin group loses native SQL on this database.** Metabase
  grants the *most permissive* permission across all of a user's groups, and
  everyone is in "All Users", which ships with `query-builder-and-native`.
  Restricting the pilot group alone changed nothing — a native `SELECT 1` still
  ran. `verify.sh` step 6 is there because of that.

### The dataset

`accounting` schema: `companies`, `account_groups`, `ledgers`, `parties`,
`vouchers`, `voucher_lines`, `bank_transactions`, `budget_allocations`.

Two companies, twelve months, six voucher types (sales, purchase, receipt,
payment, journal, contra), GST split into CGST/SGST, bank inflows and outflows,
monthly budgets, and one cancelled voucher per company so a report that forgets
`status = 'posted'` gives a visibly different answer.

`voucher_lines` is **flattened** — one row per line, with `signed_amount`
(+Dr/−Cr). That is the point of the shape: the reason Accounting is unqueryable
in a visual builder today is that `Acc_Voucher.ledgerEntries[]` is an embedded
array two levels deep.

Transactions are generated, not typed, so they cannot drift out of balance, and
`seed/90-validate.sql` aborts the whole seed if a voucher does not balance, a
cross-company reference exists, a table is empty, or a fixture contains
something that looks like real GRAV data or a credential.

### Reports it supports

Ledger totals by period · revenue and expenses by month · customer and supplier
balances · voucher register · GST summary · bank inflow/outflow · budget vs
actual.

---

## Remaining manual steps

**One.** After `bootstrap.sh`, copy the four values into
`grav-cms/.env.local` and restart `next dev`. This is manual because the
frontend repo's env file is developer-owned and may hold unrelated secrets;
writing into it automatically from a script in another repository is not a
trade worth making for one copy-paste.

Everything else — admin creation, the read-only database connection, removing
the bundled Sample Database, the collection, the group, the permission graph
and the API key — is done by `bootstrap.sh`, and re-running it is safe.

---

## Credentials

`.env` and `.env.local` are git-ignored and hold generated values only. Nothing
here reuses a password, secret or token from any GRAV environment, and nothing
here needs one: there is no real data to protect. The API key is written to
`.env.local` at creation and never printed — Metabase shows it exactly once, so
to rotate it, delete that file and re-run `bootstrap.sh`.
