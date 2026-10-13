# Strict tenancy: what it is, and what it is not — 6 Oct 2026

**Status: the read-through is OPEN, and it is NOT an exploitable cross-tenant
leak today.** This note corrects an earlier version of itself that said it was.

## The correction, first

`services/companyContext/companyMembership.service.js` short-circuits:

> GRAV is one organisation. When the GRAV Clothing primary profile exists,
> every authenticated internal actor works in it — no membership row is
> needed, because application authorisation is the access decision and
> company is not. A requested company can only NAME the primary one.

So **no authenticated session can resolve to a company other than the primary
one.** `test/hr-ai/storeTenancyGate.test.js` proves it directly: an actor with
an SpCompanyMembership in another company still resolves to the canonical one,
and the end-to-end journey confirmed it in a real browser — a second seeded
"company B" user signed in and was answered as company A.

An earlier version of this note called the read-through a cross-tenant leak
and demonstrated it with a hand-built actor. That actor is not a session
anybody can obtain. Calling it a leak overstated the finding, and the
correction matters more than the original claim did.

## What IS wrong

`services/storePurchase/tenantContext.service.js`, while
`STORE_PURCHASE_STRICT_TENANCY` is unset:

```js
{ $or: [ { companyId: ctx.companyId },
         { companyId: { $exists: false } },
         { companyId: null } ] }
```

The last two clauses are a deliberate, temporary read-through for records
written before company stamping. **Every Store reader inherits them** — the
Store UI, the assistant, and the command palette alike. A record with no
`companyId` is therefore visible to a reader of *any* company.

Consequently an unowned record is visible to **the only tenant there is** —
which is every Store reader. Two things follow, and only two:

1. **Consistency.** A record with no company behaves differently from one
   with the company stamped on it, so the same question can answer
   differently depending on when the record was written. The Cutting queue
   already learned this the hard way: it listed one order instead of thirteen
   because its scope admitted only linked work.
2. **The day the single-organisation rule ends.** The moment a second real
   tenant exists, the read-through becomes a genuine leak with no further
   change. The gate below is the precondition for that day, and it is far
   cheaper to satisfy now than during the migration that creates the risk.

It is NOT an open door today, and the release decision should not be made as
though it were.

## What the palette must NOT do about it

Narrow its own scope. The palette is correct precisely because it reuses the
same tenant filter as every other Store read; a private, stricter filter here
would hide the problem in one surface and leave it in the other forty, and the
palette would then disagree with the pages it links to.

## The cutover

1. **Measure.** `node -r dotenv/config scripts/audits/store-tenancy-release-gate.js`
   Read-only. Counts, per collection, how many live records have no
   `companyId` — across every Store & Purchase entity in the universal
   contract that has the field, plus `rawitems` and `location_balances`, which
   are not in that contract and are the two biggest (they are what "stock of
   X" and "where is X kept" read). Exits non-zero until the gate passes.

2. **Decide the owner.** The backfill stamps the canonical (`isPrimary`)
   company. **It refuses to run when the books hold more than one company**
   unless `--company=<objectId>` names which one these records belong to —
   with two companies, "the canonical one" is a guess about ownership, and a
   wrong guess hands one company's stock to another. This database currently
   holds three companies (GRAV CLOTHING PVT LTD plus the two IE demo rows
   seeded 21 Sep 2026), so **the owner must name the company.**

3. **Dry run.**
   `node -r dotenv/config scripts/migrations/store-purchase-company-backfill.js --company=<id>`
   Writes nothing; prints what it would stamp, per collection.

4. **Apply.** The same command with `--apply`. It sets `companyId` only where
   there is none, never changes one, never deletes, and includes trashed
   records (a trashed raw item is still readable, so leaving it unowned leaves
   it readable across companies). Re-running is harmless.

5. **Re-measure.** The gate must report `records with no companyId  0`.

6. **Set `STORE_PURCHASE_STRICT_TENANCY=1`** and re-run the gate. It passes
   only when **both** are true: nothing unowned, and the flag on. Owning
   everything is not enough on its own — the read-through is one `$or` away
   from re-opening the moment an unstamped record is written.

7. Run the Store suites and
   `node scripts/audits/store-command-behaviour.js` once more. The
   cross-tenant case there is a seeded assertion, not a flag check, so it
   holds either way; what changes is that it stops depending on the fixtures
   having stamped every record.

## Why it is still worth doing, and why it is not a blocker

Not a blocker: no session can be in another company, so nothing can cross a
boundary that does not exist for people. Worth doing: the flag is the only
thing standing between "one organisation by policy" and "one organisation
because the data says so", and the backfill is a few minutes of work against
a database nobody is migrating yet.

The three companies in the live books are the primary GRAV CLOTHING PVT LTD
plus two IE demo rows seeded on 21 Sep 2026. Records stamped to the demo
companies are already invisible to every reader — the tenant filter matches
the primary id, absent, or null, and a demo id is none of those.

## Scope

The flag is global to Store & Purchase. Turning it on closes the read-through
for **every** Store surface at once, which is the point: this is not a
palette setting. Anything still relying on unowned records — the Cutting queue
once read one order instead of thirteen for exactly this reason — must be
re-checked after the cutover, not before.

Covered by `test/hr-ai/storeTenancyGate.test.js` (13 tests, DB-backed).

## The command palette's own position

The palette is a read surface over the same scope every other Store surface
reads through. It neither improves nor worsens the tenancy position; what it
changes is reach, since one box answers across 117 capabilities.

The honest statement for release: *Store search carries no cross-tenant
exposure, because GRAV resolves every authenticated person to one company by
design. The read-through should still be closed, and the cutover above is how
— but it gates the day GRAV becomes multi-tenant, not this release.*
