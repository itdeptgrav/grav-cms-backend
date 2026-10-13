# Ownership mapping for the Store tenancy backfill — for approval

**Nothing has been written. This is the plan and the exact numbers, measured
read-only against the live database on 6 Oct 2026.**

## What the live database actually holds

```
node -r dotenv/config scripts/audits/store-tenancy-release-gate.js

   companies in the books                         1
   collections checked                            42
   records with no companyId                    821
   STORE_PURCHASE_STRICT_TENANCY                OFF
```

| unowned | of | collection |
|---:|---:|---|
| 301 | 317 | `rawitems` |
| 271 | 271 | `barcodes` |
| 100 | 113 | `purchaseorders` |
| 90 | 94 | `vendors` |
| 33 | 42 | `mrves` (material requests) |
| 24 | 24 | `units` |
| 1 | 1 | `crmaccounts` |
| 1 | 1 | `warehouses` |

**821 records across 8 of the 42 Store & Purchase collections.** The other 34
are fully stamped.

## There is only one company, so there is nothing to map

The books hold exactly **one** company row — `6a08040a1fecacc9bb7149c2`,
`isPrimary: true`, `isActive: true`. (The two IE demo companies noted in
CLAUDE.md on 21 Sep 2026 are no longer in this database.)

So "ownership mapping" has one possible answer for every one of the 821
records, and no judgement is involved:

> every unowned Store & Purchase record → `6a08040a1fecacc9bb7149c2`

This is also what every WRITE already does: `canonicalCompany.getCanonicalCompany`
stamps new records with this same row, and `companyMembership.resolveCompanyForActor`
resolves every authenticated person to it. The backfill makes old records
agree with what new ones already say.

## What the write would do, exactly

```
node -r dotenv/config scripts/migrations/store-purchase-company-backfill.js --apply
```

- `$set: { companyId: <the one company> }` on documents matching
  `{ $or: [ {companyId: {$exists:false}}, {companyId: null} ] }`, per collection.
- **Only where there is none.** A record that already carries a company is not
  matched and not touched; a test asserts that a record owned by another
  company keeps its owner.
- **Nothing is deleted, nothing is moved, no other field changes.**
  `timestamps: false`, so `updatedAt` is not disturbed either.
- Trashed records are included (`withDeleted`), because the trash is still
  readable and leaving it unowned would leave it readable under the old rule.
- Re-running is harmless: a stamped record no longer matches.
- It refuses to run at all if a second company ever appears, unless told
  `--company=<id>` — so this plan cannot silently do the wrong thing later.

## Reversal

The dry run above is the complete list of what changes. If it has to be undone,
the inverse is `$unset: { companyId: "" }` on the same documents — but note
that identifying them afterwards requires the list, so the apply run should be
captured:

```
node -r dotenv/config scripts/migrations/store-purchase-company-backfill.js --apply | tee backfill-6-oct-2026.log
```

## Then, and only then

1. Re-run the gate — it must report `records with no companyId  0`.
2. Set `STORE_PURCHASE_STRICT_TENANCY=1`.
3. Re-run the gate — it must now PASS (it checks both facts).
4. Re-run the Store suites and
   `node scripts/audits/store-command-behaviour.js`.
5. Re-check anything that was relying on unowned records being visible. The
   Cutting queue is the known one: `cuttingAccess.workOrderScope` admits
   unlinked work orders *while the window is open*, and 151 of 152 work orders
   carried no company link as of 26 Sep 2026. **Work orders are not in the 821
   above** — `workorders` is not a Store & Purchase collection and this
   backfill does not touch it — so closing the window will narrow the Cutting,
   Packaging and Finishing queues unless those are backfilled too, as a
   separate decision.

**That last point is the real risk in step 2, and it is not a Store-search
risk.** Turning the flag on is global.

## What this does NOT fix, and why it is not urgent

No authenticated session can resolve to a company other than the primary one
(`companyMembership.resolveCompanyForActor` short-circuits while a primary
profile exists — GAC-AR1). So an unowned record is visible to *the only tenant
there is*, not to a foreign one. See `store-tenancy-strict-cutover.md`.

The backfill is worth doing because it makes isolation a property of the data
rather than of a policy, and because doing it now is minutes of work while
doing it during a future multi-tenant migration would not be.
