# Synthetic pilot fixtures — RETIRED FROM THE LIVE DATABASE

These three files generated the invented Accounting dataset the pilot used
before the real mart existed: two made-up companies, made-up parties, generated
vouchers. Nothing in them is copied from, derived from, or shaped to match any
GRAV record.

**They are no longer loaded.** They sit in this subdirectory precisely because
the Postgres entrypoint runs only the top level of the mounted `seed/` directory
and does not recurse — so moving them here is what stops them re-seeding on the
next `make reset`, and `V002__drop_synthetic_pilot_schema.sql` removed the
schema they had already created.

The live reporting database now holds `reporting.*`, synced from MongoDB by
`npm run reporting:sync -- --full`. Two schemas of plausible-looking Accounting
tables in one database, one of them fiction, is how a made-up figure ends up in
a board pack.

## If you want them again

For a throwaway database only — never the one Metabase is pointed at:

```bash
psql "$SOME_SCRATCH_DATABASE_URL" -f 10-schema.sql -f 15-data.sql -f 90-validate.sql
```

They are kept because a generated dataset with known totals is genuinely useful
for exercising a report by hand, and regenerating one costs a second.
