# Where the T&A milestone list is stored — Option A selected

27 Sep 2026. **Option A selected; code prepared; live index not yet applied.**
**Nothing has been changed on any live cluster.**

## The problem

`TnaMilestoneDefinition` currently declares its own collection,
`merchandising_tna_milestone_definitions`. `CLAUDE.md` records the cluster at
its 500-collection cap (this database reports 409 of a cluster-wide 500), and
`cutting_seasons` already had to be created by RENAMING an empty orphan because
a plain create failed with "already using 500 collections of 500".

So the milestone library works in tests, which use an in-memory server, and
would fail on the first write in production. Step 1 is not deployable until this
is settled.

`scripts/migrations/collection-cap-inventory.js` (reads only) prints the real
numbers: how many collections this database holds, which ones no model in this
repository declares, and how many of those are empty.

## Option A — host it in `merchandising_tna_reason_codes` *(SELECTED, built)*

Reason codes are already a company-scoped, code-keyed, named, `isActive`
configuration vocabulary that other records reference by code. A milestone
definition is the same kind of thing. A mongoose **discriminator** on that
collection expresses "two kinds of configuration record, one store" without
pretending the fields are interchangeable.

**Why this one:** no slot needed, no drop, no rename, nothing destructive.

The existing unique index is `{companyId, code, kind}` — `kind` is *already*
part of the identity, so a milestone `SAMPLE_REJECTED` cannot collide with a
reason code of the same code. That index does not have to change, which is the
thing that makes this safe rather than merely possible.

| Needed | Kind of change |
|---|---|
| `kind` enum gains `MILESTONE` | additive, no index touched |
| a partial unique index on `{companyId, nameKey}` filtered to `kind: "MILESTONE"` | **a live index build** — additive and non-destructive, but still needs approval |
| `TnaMilestoneDefinition` becomes a discriminator | code only |

**The honest cost:** the collection is *named* `…_reason_codes` and would hold
milestones. That is a real readability cost and a comment does not fully pay it.
It can be settled later by an approved rename (a rename keeps the collection
count, which is how `cutting_seasons` was made).

## Option B — remove an empty orphan and keep a dedicated collection *(not taken)*

Cleanest model, and the collection name means what it says. It needs a genuinely
empty, genuinely unused collection removed first.

Run the inventory to get the candidates. A candidate qualifies only if **all** of
these hold, and each needs a person to confirm:

1. no model in this repository declares it;
2. it holds zero documents;
3. somebody can say what wrote it historically and that nothing will again;
4. it is not a view, and not owned by another service that shares the cluster.

`vehicles` was the last collection judged this way, and it was renamed rather
than dropped — a rename preserves the data if the judgement was wrong.

**I have not run this against the live cluster and I am not proposing a specific
victim.** Naming one from a file listing would be a guess about what your
business writes.

## Option C — a new collection anyway *(not taken)*

Blocked. It fails at creation until the cap is relieved, and finding that out in
production is the worst version of this decision.

## What was built

| Piece | Where |
|---|---|
| Neutral base model on the shared collection, `discriminatorKey: "kind"` | `models/CMS_Models/Merchandising/TnaConfiguration.js` |
| Milestones as a Mongoose discriminator, value `MILESTONE` | `models/CMS_Models/Merchandising/TnaMilestoneDefinition.js` |
| Reason codes unchanged, plus a query guard so they can never return a milestone | `models/CMS_Models/Merchandising/TnaPlan.js` |
| Dry-run index script | `scripts/migrations/tna-milestone-name-index.js` |
| Compatibility tests, 13 | `test/merchandising/tna-configuration-collection.test.js` |

### Why `kind` and not a new discriminator field

Every existing document already carries `kind: "BLOCK"` or `"RESCHEDULE"`. A
Mongoose discriminator filters by its key on **every** query, so a *new* field
would have been absent on every existing row and every reason code in the
business would have vanished from its own screens until a backfill ran. Using
`kind` meant **no data migration at all**.

### Why reason codes are not themselves a discriminator

A discriminator has one value; reason codes have two, and `BLOCK`/`RESCHEDULE`
is real information the product uses, not a type tag. `TnaReasonCode` therefore
keeps its own schema, document shape and indexes, and gets a query guard
(`kind: $in [BLOCK, RESCHEDULE]`, `$and`-ed with whatever the caller asked) so a
milestone can never be read as one. Proved from both directions.

### What `label` does NOT do

A milestone's `name` is **not** pushed through the reason code's required
`label`. Different lengths, different uniqueness rule, different meaning. The
base requires neither.

### The one field deliberately shared

`code`. A reason code's code and a milestone's code are each "the short
unchanging name of this entry" — the same meaning — so the collection's
**existing** unique index `{companyId, code, kind}` gives company-scoped
milestone-code uniqueness with **nothing built on a live cluster**. A test
asserts that index exists, carries no partial filter, and predates this work.

## The one live command still awaiting approval

Milestone-code uniqueness needed no index. The normalised **name** does:

```
db.merchandising_tna_reason_codes.createIndex(
  { "companyId": 1, "nameKey": 1 },
  { "unique": true,
    "name": "tna_milestone_name_unique",
    "partialFilterExpression": { "kind": "MILESTONE" },
    "background": true }
)
```

**PARTIAL is load-bearing.** A reason code has no `nameKey`, so without the
filter every reason code is `{companyId, null}` and the second insert fails. A
test covers exactly that.

Run it through the script, which reports collisions first because a unique index
will not build over violating data — and merges nothing, since folding two
control points into one makes every report over them wrong invisibly:

```bash
node -r dotenv/config scripts/migrations/tna-milestone-name-index.js
```

`--apply` builds it. `autoIndex` is off in production (`server.js`), so
deploying the code does **not** build it; development and tests build it from
the schema declaration.

## Still true

The cluster remains at its cap. This decision spends **no** slot. If the cap is
relieved later, the definitions can move to their own collection under an
ordinary migration, because the discriminator already keeps them in one document
shape.
