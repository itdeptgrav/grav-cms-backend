# The verification harnesses were removed — 2 Oct 2026

Owner's decision: the 42 `verify*` harnesses and the `verify.js` runner are gone.
The reasoning was that they check rules which already work, so re-checking them on
every change is maintenance for no return.

This note exists for one reason: **two of them were failing when they were deleted**,
and the findings are real. Deleting the check does not fix what it found, and without
this note the information would have gone with it.

## 1. The late-arrival ladder is not reaching payroll

`verifyPayrollLadder` — 11 passed, **4 failed**. The policy itself is configured
correctly; the deduction never lands on pay.

```
ok    the month context now carries the late policy
ok    and the policy is enabled with the 3/5 ladder
FAIL  31 Aug is the 3rd late → half day in PAY, not just on screen  -- P/P/lop=0
FAIL  25 Aug is the 5th → full absence in pay                       -- P/P/lop=0
FAIL  found an employee stored as HD for punching on Independence Day
FAIL  before the resync, payroll docks that day as a half day       -- NH/NH/lop=0
```

`lop=0` is loss-of-pay zero. The 3rd late arrival shows as a red mark on the
attendance screen and the employee is still **paid in full** for the day. The 5th
should be a full absence in pay and is not. Same for the Independence Day case in
reverse: a national holiday was being docked as a half day.

This is money. It affects every employee who crosses the ladder in a month.

## 2. A customer ledger is linked to the wrong party

`verifyPartyLinkSafety` — 25 passed, **1 failed**, out of 19 links checked:

```
"MAYFAIR World Cup Village, Rourkela"  ->  "MAYFAIR CORPORATE BBSR"
```

One customer's ledger points at a different customer. Receipts and statements for
one land against the other. The names are similar enough that it reads as correct
on screen.

## What the harnesses were, for anyone wondering later

Not unit tests — 42 end-to-end checks of business rules against real data, run with
`npm run verify` (~90 s) in three tiers: pure rules, read-only against the dev
database, and write checks behind `npm run verify:all`.

One of them is worth remembering even though it is gone:
`verifyNoUndefinedRefs` read every route and service and reported any identifier
used without being imported. That single check would have caught four production
bugs that each survived a merge which dropped a `require` and kept the call:

| Identifier | What it broke |
|---|---|
| `applyDefaultNarration` | saving ANY voucher — ~1 week in production |
| `settlementOf` | the purchase-order lookup and detail |
| `billMatching` | the open-bills lookup |
| `assertServiceContext` | sample-style images |

If that class of bug recurs after a merge, this is the shape to look for: a call
with no import, which only throws when the line is finally reached at runtime.
