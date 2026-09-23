# Decision record — Board & Executive policy lifecycle, and the financing methodology

> **Status:** Adopted and implemented for **four** policies: `FINANCING`,
> `OVERHEAD`, `LABOUR_METHODOLOGY` and `GST_TAX_POLICY`. The lifecycle, the
> resolution rule, the access boundary and the shared workspace carry all four;
> nothing else is migrated, and no other `policyKey` is accepted.
>
> The API is `/api/cms/board/policies` — the `/api/cms/` prefix is this
> repository's namespace for CMS employee routes, and the router is the one the
> lifecycle shipped on. It is not duplicated or re-mounted.
>
> Scope: `docs/tasks/central-costing-lane-b-input-map.md` §25.
> Product direction: `docs/product/garment-manufacturer-app-architecture.md`
> (app 1, Board & Executive).

---

## 1. The problem this record closes

`CostingPolicy` is one mutable row per company. That is the right shape for a
standing convention — the currency a company calculates in, the step it rounds
prices to — and the wrong shape for a **governed decision**, for three reasons
that only show up later:

* **There is no draft.** Whatever somebody types is in force the instant they
  save it, so a rule cannot be prepared, circulated or reviewed.
* **There is no history.** `revision` counts changes and keeps none of them, so
  "what was the financing rate in March" is answerable only by finding a
  costing frozen in March and reading its snapshot.
* **There is no effective date.** A rate agreed in September to start in
  October cannot be recorded until October, by somebody who has to remember.

`CostingPolicy.developmentCharges[].rates[]` already concedes the third of
these, locally, for one field. This record generalises the answer.

Separately, and worse: `financingRatePercent` was a flat percentage of a
subtotal with **no duration in it**. Two orders with the same materials and
payment terms ninety days apart carried identical financing. It had the units
of a cost of capital and none of its meaning.

## 2. The record

`models/CMS_Models/Board/BoardPolicy.js` — one document per **version** of a
policy, keyed `{companyId, policyKey}`.

An approved version is never edited and never rewritten. A change is a new
version with a later effective date, and the earlier one stays exactly as it
was approved.

### 2.1 Only two statuses are stored

The vocabulary a person reads is four:

```
DRAFT → BOARD_APPROVED → EFFECTIVE → SUPERSEDED
```

Only the first two are **acts**. The other two are consequences of the calendar
and of what has been approved since:

| Derived state | Means |
|---|---|
| `EFFECTIVE` | approved, its date has arrived, nothing later has taken over |
| `SUPERSEDED` | approved, and a later approved version now stands in front of it |

Storing them would mean something has to run at midnight to make a future-dated
policy true, and something has to write to every earlier row on every approval.
Both are ways to get history wrong — and a job that does not run leaves the
company on last year's rate with nothing saying so. They are derived, in
`services/board/boardPolicy.service.lifecycleOf`, from the two facts that are
actually stored: whether it was approved, and from when.

### 2.2 Resolution is a query, not a state machine

> The policy in force on a date is the approved version with the greatest
> `effectiveFrom` at or before it.

Two of the required rules are therefore **structural** rather than enforced:

* a future-dated version cannot affect a calculation before its date, because
  the query does not select it;
* at most one version is in force for a company on a date, because the greatest
  qualifying date is unique.

A partial unique index on `{companyId, policyKey, effectiveFrom}` over
`status: "BOARD_APPROVED"` rows makes sure two approvals never share a date.
Drafts are exempt: several may name the same intended date while they are being
argued about, and only one will be approved.

### 2.3 Backdating cannot restate a frozen costing

Nothing in this record protects that, and nothing needs to. A `CostingVersion`
**copies** the resolved policy into `financingProvenance` at freeze time and
reads the copy for ever after. Approving a version dated last January changes
what the next costing resolves; a costing already frozen never asks again.

This is the same guarantee `policySnapshot` and `freightProvenance` already
give, obtained the same way — by value, not by reference.

## 3. The app, and the access row — two different things

### 3.0 Identity

**The application is Board.** Its address is `/board`, the financing policy is
at `/board/dashboard/policies/financing`, and its chrome, navigation and
switcher tile all say Board. It is not a section of the CEO dashboard.

It shipped as one, at `/ceo/dashboard/policies/financing`, and that was a
mistake worth recording because of how it was made rather than what it cost.
The `ceo` grant was already the board-level access boundary, so filing the
screen inside the CEO app meant nothing new had to be seeded — a sound
argument about ACCESS which silently settled IDENTITY too. The two are
different questions:

| | Answer | Why |
|---|---|---|
| Which app is this? | **Board** | a governed decision, approved by a body, effective from a date, outliving any one executive |
| Who may open it? | the **`board`** grant | its own department, because it is its own application |

Filed under "CEO", the company's financing rate reads as the chief executive's
setting. Everything else in that dashboard reports what the company *did*; a
Board policy is the company deciding what it *will* do, and the whole point of
giving it an approver and an effective date is that it is not one office's
switch.

The identity moved first and the grant followed a release later. Both are now
the same word, `board`, held in three constants that must agree: `guardSlug` in
`components/Board_DashboardLayout.js`, `BOARD_VIA_SLUG` in
`components/shell/boardApp.js` and `components/access/boardRole.js`, and
`BOARD_DEPT_SLUG` in `services/board/boardAccess.js`.

### 3.1 Authorisation

`services/board/boardAccess.js`. The Board boundary is the **`board` department
grant** — its own `AccessDepartment`, seeded by
`services/ensureAccessDepartments.js`.

It read `ceo` for one release, because `services/access/hrAccess.js` and
`services/access/fulfilmentAccess.js` had both declared
`BOARD_DEPT_SLUGS = new Set(["ceo"])` since before this app existed, and
borrowing that boundary avoided seeding anything. What it actually did was make
two independent applications one grant:

* a Board seat could not be given without the executive dashboard;
* granting the executive dashboard silently carried a Board seat;
* revoking either quietly moved the other.

Those two HR/fulfilment readers deliberately **stay** on `ceo`. What they mean is
"an executive may read this", which is the Executive Office and not the Board;
moving them would change who can see HR and fulfilment, which is a different
decision from this one.

**There is no `ceo || board` branch in the guard, and there must not be.** A
guard that accepts either slug hands Board to every executive for as long as the
branch survives, and nothing ever forces its removal. The compatibility is a
one-off migration instead —
`scripts/migrations/board-department-split.js`, §3.1c — so this authority has
exactly one answer.

| Act | Needs |
|---|---|
| read | `viewer` |
| draft / edit / discard | `editor` |
| approve | `approver` |

Drafting and approving are different ranks on purpose: a policy whose author is
always its approver has a review step in name only.

### 3.1a Where an administrator assigns the role

**Access Control → People** (`/ceo/dashboard/access`), on the row of anybody who
holds the **Board** access department. Board is its own chip beside Executive
Office, and granting it is what reveals the role selector: **Viewer / Editor /
Approver / Owner**.

It is registered in `components/access/moduleRoles.js` against
`deptSlug: "board"`, through the same `genericDeptRole` writer every other
department row uses — so it posts to the existing
`PUT /api/admin/department-roles/board`, and inherits that route's one-Owner
demotion, its audit entry and its change-log record without a second table, a
second API or a second rule. Board's own wording and role list live in
`components/access/boardRole.js`, which has no imports so the eligibility rule
and the labels can be tested without a bundler.

`supportsExternal: false`: Accounting is the module that accepts an outside
bookkeeper with no HR record; a Board seat is not something to create an account
for from this screen.

**The screen was missing once, and the Board API was correct and unreachable
because of it.** The guard requires an explicit `DepartmentRole`; no screen could
write one; so every Board member was refused with `BOARD_ACCESS_REQUIRED /
NO_BOARD_GRANT`. The fix was the screen. The guard was not touched.

### 3.1c The migration that separated them

`scripts/migrations/board-department-split.js`, run at boot from `server.js`
after the seeder and before Board answers anything.

The preservation boundary is an **active, explicit `ceo` `DepartmentRole`** — not
Executive Office membership. Those are different populations and only the first
could actually use the Board app: membership alone was already refused, so
granting it now would not be preserving access, it would be granting it, quietly,
to whoever happened to hold the executive department.

| Who they were | What they get |
|---|---|
| an active explicit `ceo` role | that role copied to `board`, and Board department membership |
| `ceo` membership with no role | nothing — they had no Board access to preserve |
| an inactive `ceo` role | nothing — a withdrawn grant stays withdrawn |

It changes, deactivates and deletes **no** `ceo` row. Membership is added to
`additionalDepartmentIds`, so nobody's primary department — the dashboard they
land on when they sign in — moves. Every write is `$setOnInsert` or `$addToSet`,
so a second run writes nothing, and it does not re-assert a rank or a membership
an administrator has since changed.

It **refuses** rather than improvising when the `board` department does not exist
(the seeder has not run) or when two Employee records share an address that holds
a board-level role. A refusal is not a state to retry past:
`services/board/boardReadiness.js` keeps Board shut and answers `503
BOARD_NOT_READY` with the reason. The wrong answer in that window would be
`NO_BOARD_GRANT`, which reads as broken access and gets somebody to restore the
`ceo` fallback.

An email holding an active `ceo` role with no Employee record has its role copied
— the role store has always been keyed by email — and gets **no** membership,
reported loudly. Only employees with HR records hold Board, and this invents
nobody.

### 3.1b Membership is not a role

The distinction the whole boundary rests on, and the one an administrator has
to make deliberately:

| | Grants | Set where |
|---|---|---|
| **Board application membership** (the `board` `AccessDepartment` chip) | the role selector appears on that row; **nothing** inside Board | Access Control → the person's departments |
| **Board role** (the `board` `DepartmentRole` row) | everything inside the Board app | Access Control → People → Board |

Holding the membership grants **nothing** in Board. Neither does being a
platform administrator, owning another department, holding the Executive Office,
or seeing the tile — each is its own test.

**The switcher requires both.** `boardTileFor` in
`components/shell/boardApp.js` checks the grant (from the department list the
switcher already has) and an active role (from `GET
/api/cms/board/policies/access`, the same second-read the Costing tile makes),
and neither check stands in for the other: dropping the grant check would offer
Board to anybody with a stale role row after their department was withdrawn, and
dropping the role check would offer it to every new Board member before an
administrator had decided what they may do. Because `board` is a real department,
`/api/auth/verify` also returns a tile for it, so `withoutBoard` removes that
un-gated copy — one rule decides whether Board is offered.

The tile is a convenience and was never protection: somebody who types `/board`
reaches the app and the server refuses them per request.

Because `getRole` reads the database on every call with no cache in front of
it, granting, changing or revoking a role takes effect on the **next Board
request** — same token, no new sign-in.

### 3.2 Why `requireDepartmentRole` is not used

`services/departmentRoles.requireDepartmentRole` is the right guard for
departmental screens and the wrong one here, for two reasons it documents about
itself:

* `if (req.user?.isAdmin || req.admin) return next();` — every platform
  administrator would hold Board approval. The company's borrowing rate is not
  an administrative setting.
* `if (assigned.length === 0) return next();` — a transitional convenience that
  opens a department to **everyone** until somebody is granted a role in it. On
  a policy nobody has been granted yet, that is precisely backwards.

The grant is therefore read directly, per request, and must be present. No
bypass, no fallback. Reading it per request rather than from the token is the
same decision `services/centralCosting/capabilities.js` records: a grant
withdrawn five minutes ago must not survive in a seven-day JWT.

## 4. The financing methodology

Every field is required for an **approval** and none has a default. A draft may
hold any subset; approval is where the contract is enforced.

| Field | Values | Why it is asked |
|---|---|---|
| `annualRatePercent` | 0–100 | what a year of borrowing costs this company |
| `basis` | the engine's own `BASIS_KEYS` | a rate with no basis is not a rule |
| `advanceTreatment` | `REDUCES_FINANCED_AMOUNT` \| `IGNORED` | see §4.1 |
| `dayCountBasis` | 365 \| 360 | they differ by ~1.4% of the figure |
| `effectiveFrom` | a date | a rule with no start applies to everything ever costed |
| `rationale` | free text | the figure says what; this says on what basis |

`basis` reuses the engine's vocabulary rather than a second one: a basis this
record could name and the engine could not resolve would be a rule that never
applies.

### 4.1 The advance treatment is a Board decision, not a default

"Money already received is not money being financed" is the common answer and
**not the only defensible one**: a company financing its whole working-capital
cycle at a blended rate may deliberately charge the full order value. The two
produce materially different garment costs on any order with a substantial
advance, so the code does not pick. Hard-coding either would be this system
making a Board decision.

### 4.2 The formula

```
financedShare    = advanceTreatment === REDUCES_FINANCED_AMOUNT ? (100 − advance%) / 100 : 1
effectivePercent = annualRate × financedShare × creditDays ÷ dayCountBasis
financing        = selected basis × effectivePercent ÷ 100
```

`advance%` and `creditDays` come from
`services/sales/paymentTermsResolution.projectionFor` — the **confirmed** terms
on the enquiry, never prose (`NET30`, `balanceTerms`) and never the Account read
through live.

The derived percent is applied through the existing `PERCENT_OF_BASIS`
machinery, so financing still joins the same basis graph and is still ordered
after overhead by `SUBTOTAL_BEFORE_FINANCING`. `effectivePercent` is kept to six
decimal places: it is an intermediate, and rounding an intermediate to the
precision of a displayed rate loses money on every large basis. The engine
rounds once, at the end, in the company's own mode.

### 4.3 Five answers, and only two are a line

| State | Line | Reason |
|---|---|---|
| `CALCULATED` | a figure | both records answered |
| `RECORDED_ZERO` | nil, terms frozen beside it | 100% advance, or 0 credit days — the money is out for no time, which is an **answer** |
| `NOT_APPLICABLE` | nil, reason frozen | Sales stated a condition |
| `TERMS_MISSING` | **none** | nobody has agreed when this order gets paid |
| `POLICY_MISSING` | **none** | the Board has not decided |

The last two produce no line — never a zero, which would be the claim that this
order costs nothing to finance. Both gaps are reported rather than the first:
they are fixed at different desks, and reporting only one leaves the other
department believing their half was done.

`NOT_APPLICABLE` needs no Board policy. Asking the Board to decide the
company's borrowing rate before an intercompany transfer can be recorded as
unfinanced would be asking the wrong person about the wrong order.

### 4.4 A missing policy blocks the family, not the save

Absence of an effective policy is a **blocker** — the `financing` family cannot
reach complete and `costComplete` is false — and it is not a refusal to
calculate. A draft that could not be calculated at all would stop every costing
in the company until the Board had met and somebody had been round every open
enquiry. This is the same judgement `applyFreight` records for an unstated
delivery arrangement. The result is a costing that is honestly incomplete
rather than one that is silently wrong.

## 5. Retiring the old writer

| | Before | Now |
|---|---|---|
| `PUT /api/costings/policy/current` | wrote `financingBasis` + `financingRatePercent` | **refuses** them with `FINANCING_POLICY_MOVED` (409), by name. Clearing is the one write still accepted |
| `engine.js` | synthesised `policy:financing` from the flat rate | does not. Warns `POLICY_FINANCING_RETIRED` where one survives |
| `GET /policy/current` | returned the two fields | still does, plus `financingPolicy: { editable: false, ownedBy: "BOARD" }` |
| `assembly.policySection` | listed a `financing` rule beside overhead | does not — financing is no longer a standing company rate |
| `/costing/policy` screen | **had no financing control at all** | states where the decision lives, and shows a surviving legacy rate as retired |

Refused **by name** rather than ignored: silently dropping the field would leave
whoever sent it believing the rate was saved, which is the worse of the two
failures by a distance. Clearing stays open so a company can retire its legacy
rate through the screen it was set in, without that being a write path for a
new one.

The fields stay on the model and in `policySnapshot`. Versions frozen under the
flat rate have to remain explicable, and a company holding one has to be able to
see it.

There is deliberately **no link** from the costing policy screen to the Board
app: a reader there may well not be on the Board, and a control that navigates
to a screen they cannot open is worse than a sentence saying who can.

### 5.1 And one screen, not two

The same rule applies to the move itself. `/ceo/dashboard/policies/financing`
still answers — the address is in histories, bookmarks and this document's own
earlier revisions, and deleting it would turn all of those into a 404 — but it
**redirects** and renders no editor.

Two screens writing one policy would be two writers even though both post to
the same endpoint, because the two drift: a field added to one and not the
other, an approval guard on one and not the other. `app/board/…/financing` is
the only page in the repository that mounts `FinancingPolicyPanel`, and a test
asserts that by counting them.

## 6. What is frozen onto a version

`CostingVersion.financingProvenance` — the Board's half (`boardPolicyId`,
`policyEffectiveFrom`, `policyApprovedAt`, `policyApprovedByName`,
`annualRatePercent`, `basis`, `advanceTreatment`, `dayCountBasis`), Sales' half
(`enquiryRef`, `termsState`, `advancePercent`, `creditDays`, `creditDaysFrom`,
`termsSource`, `termsConfirmedAt`, `termsConfirmedByName`,
`notApplicableReason`), and the arithmetic (`financedSharePercent`,
`effectivePercent`, `formula`).

`boardPolicyId` is there so the decision can be **found**; every figure beside
it is there so the calculation can be **checked without finding it**.

It is published inside the `cost` block of `visibility.js`, so a reader who may
see an approved selling price but not the internal cost sees neither the
company's borrowing rate nor the customer's payment terms.

## 6A. Overhead — the second policy on this lifecycle (8 Sep 2026)

Financing proved the lifecycle. Overhead proves it is a *lifecycle* and not a
financing feature: a policy with a different payload, its own validation, and a
much larger legacy footprint went onto it without either policy's contract
being weakened to fit the other.

### 6A.1 What the payload looks like, and why it is not generic

`BoardPolicy` carries **a named, typed sub-document per key** — `financing`
beside `overhead` — dispatched through a `CONTRACT` table of
`{field, validate, gaps}`. What is shared is the lifecycle: draft, approval,
effective dating, supersession, company isolation, the stale-revision guard.
What is not shared is what a policy *means*.

A single `Mixed` payload would have been shorter and would have cost each
policy its validation: the completeness check before approval becomes "is the
payload non-empty", which approves a financing rate with no day count and an
overhead rate with no basis. The two contracts share exactly one field *name*
— `basis` — and nothing else, which is why an overhead payload satisfies one
of financing's four questions and is still refused on the other three. That
single overlap is the argument for per-key checks rather than against them.

### 6A.2 The contract

| Field | Values | Why it is asked |
|---|---|---|
| `ratePercent` | 0–1000 | what the company adds to cover running itself |
| `basis` | the engine's `BASIS_KEYS` | a rate with no basis is a percentage of something unstated |
| `effectiveFrom` | a date | required to approve |
| `rationale` | free text | the figure says what; this says on what basis |

The 1000% ceiling is the one the rule it replaces allowed: a real overhead pool
measured against a narrow basis can exceed 100% of it, and refusing that would
invent a business rule the company never asked for.

**It stays one combined figure.** "Company and factory overhead" is one rate
here because it is one rate everywhere else — every frozen costing carries a
single overhead line, and nothing in this repository records the corporate pool
separately from the factory pool. Splitting them would mean asking the Board to
approve an allocation nobody has computed.

### 6A.3 The calculation, unchanged

Overhead is still a percentage of a named subtotal, still synthesised by
`engine.js` as its own `PERCENT_OF_BASIS` line, still ordered by the same basis
graph. **`engine.js` was not touched.**

What changed is where the rate comes from. `policyService.getPolicy(ctx, {asOf})`
resolves the effective Board version and **overlays** it onto
`policy.overheadRatePercent` / `policy.overheadBasis` — the two names the engine
already reads. `versionCreation` passes the costing's own `meta.asOf`, so a
costing dated in March is calculated at March's rate.

One seam, one resolution, no second answer. There is no version of this
migration where the engine had to be re-read to be sure the number still comes
out the same — and a test asserts the per-garment figure against the fixture's
own `EXPECTED`, written before any of this existed.

### 6A.4 Legacy data — the compatibility decision

`CostingPolicy.overheadRatePercent` / `overheadBasis` are **read-only and no
longer applied**:

* `savePolicy` refuses them with `OVERHEAD_POLICY_MOVED` (409), by name.
  Clearing is the one write still accepted, so a company can retire its rate
  through the screen it was set in without that being a path to a new one.
* They stay on the schema, in `policySnapshot`, and in the `GET /policy/current`
  response (`overheadPolicy.editable: false`), so old frozen versions stay
  explicable and a company can *see* the number it needs the Board to approve.
* They are **not** fallen back to in any calculation. Applying an unapproved
  value under a Board-governed family would be treating it as Board-approved,
  which is the one thing this migration must not do. A company that has not
  approved a policy gets **no overhead line** and its costings say so.

**The hazard this created, and the guard against it.** `getPolicy` stopped
projecting those two names (the Board's rule fills them now), but `savePolicy`
writes its merged object back and `$unset`s anything undefined — so a save of an
*unrelated* setting would have silently wiped the legacy value this decision
promised to keep. `validatePatch` therefore seeds them from
`legacyOverheadBasis` / `legacyOverheadRatePercent`, and only an explicit clear
removes them. There is a test named for exactly that.

### 6A.5 Four readiness states, and no rate

`resolveState(companyId, policyKey, asOf)` reports `EFFECTIVE`, `FUTURE_ONLY`,
`DRAFT_ONLY` or `NONE`. "No effective policy" is one phrase for four situations
and only one of them means somebody has to decide: a draft is waiting for an
*approver*, and a future-dated policy needs nobody to act at all. A department
chasing "the Board has not decided" would be wrong in two of the four cases.

The departmental projection publishes the state, the dates and the approver's
name — **never the rate or the basis**. Who stands behind the company's rule is
not commercial information; the rule is.

### 6A.6 What is frozen

`CostingVersion.overheadProvenance` — the Board's decision (`boardPolicyId`,
`policyEffectiveFrom`, `policyApprovedAt`, `policyApprovedByName`), the rule
(`ratePercent`, `basis`), and **per scenario** the `basisAmountMinor` beside the
`overheadMinor` it produced.

That last part is the one the old snapshot could not do. `DIRECT_PLUS_FIXED` is
a computed subtotal across every other line on the version, so "12% of direct
plus fixed" cannot be re-derived a year later without recalculating the whole
costing. The amounts are read off the engine's own result, never recomputed — a
second calculation is a second answer.

Versions frozen before this keep `policySnapshot.overheadRatePercent` and carry
no provenance. Reading them through the new field would claim a Board approval
that never happened.

### 6A.7 The Board screen

`/board/dashboard/policies/overhead`, beside Financing. The draft/approve/
effective-date/history chrome is `BoardPolicyWorkspace`, shared with Financing
because that part genuinely is the same decision every time; the fields and the
completeness rule are each policy's own, passed as a contract and a render prop.

Each basis option carries what it *means* rather than its enum name: the same
12% on conversion cost and on everything-before-overhead differ by the whole
material cost, which on a garment is most of it. The basis is half the
decision, and as four enum names in a list that is invisible.

## 6B. Labour methodology — the third policy (8 Sep 2026)

Overhead proved the lifecycle was a lifecycle. Labour is the first policy whose
contract is not simply "are the fields filled in", and the first where a valid
Board decision can still leave a costing incomplete.

### 6B.1 The contract, and the rule that is not a field

| Field | Values | Why |
|---|---|---|
| `productiveMinutesPerMonth` | > 0 | the denominator the rate is divided by, stated |
| `labourEfficiencyPercent` | 0 < x ≤ 100 | the same answer as a fraction of the paid month |
| `employerBurdenPercent` | ≥ 0, ≤ 1000 | PF, ESI, gratuity, bonus. Zero is a decision; absent is not zero |
| `machineBurdenTreatment` | `IN_OPERATION_RATE` \| `IN_OVERHEAD` \| `NOT_COSTED` | where machine cost is accounted for |
| `machineExclusionReason` | text | required only for `NOT_COSTED` — see §6B.4 |

**The productive basis is EXACTLY ONE of the first two.** Neither is a company
that has not said how much of a paid month is productive. Both is a company
that has said two different numbers — 9,000 minutes and 80% of 12,480 is
9,984 — and silently preferring either buries that disagreement inside every
labour rate the company quotes.

`labourCost.productiveBasis()` has always refused both-at-once at calculation
time. `validateLabour` now refuses it at the WRITE, and `labourGaps` refuses
neither-at-all at APPROVAL, so a Board never approves a methodology the engine
will then refuse.

The 1000% burden ceiling is the one the retired endpoint used: a burden can
exceed take-home pay in some structures, so only the lower bound is a business
rule.

### 6B.2 The formula, unchanged

`services/centralCosting/labourCost.js` was **not touched**. It remains the
single labour authority:

```
employer cost per month = net salary × (1 + employer burden %)
productive minutes      = stated minutes, OR 12,480 × efficiency %
cost per minute         = employer cost per month ÷ productive minutes
labour cost per garment = cost per minute × SAM
```

`PAID_MINUTES_PER_MONTH = 26 × 8 × 60`. Exact `Decimal` throughout, rounded
once at the end in the policy's own mode. There is no more authoritative
company-calendar source in this repository, so the constant stands.

What changed is where the four names it reads are filled from:
`policyService.getPolicy(ctx, {asOf})` overlays the effective Board version —
the same seam overhead uses, and the third consumer of it. `versionCreation`
passes the costing's own `meta.asOf`.

### 6B.3 Production still owns the other half

The route, the SAM and which salary basis an operation is paid at are
Production's, and none of them is in this policy or on the Board screen. What
the Board decides is how a PAID month becomes productive, what an operator
costs beyond take-home pay, and where machine cost sits.

### 6B.4 Machine burden — a valid answer that can still block

This is the only Board answer in the system that can be correct and still leave
a costing incomplete, and pretending otherwise would be the "resolved because a
field has a value in it" failure this whole lane exists to correct.

| Treatment | Status | Depends on |
|---|---|---|
| `IN_OPERATION_RATE` | approvable | **nothing records a machine hourly rate, a depreciation schedule or a power rate.** The fix is a Production master, not a policy edit |
| `IN_OVERHEAD` | approvable | the Board's overhead policy being in force. Without one, machine cost is charged nowhere |
| `NOT_COSTED` | approvable | nothing — but it must state WHY, because the other two name somewhere the cost IS carried and this one says it is carried nowhere |

`labourPolicy.dependenciesOf()` reports these separately from the policy
itself, with the owner who can close them — which for the machine source is
nobody yet, and saying "Not yet assigned" is more honest than naming a
department that has no such record. The Board screen shows the dependency at
the point of choosing, so a director knows before approving.

### 6B.5 Readiness — eleven situations, not one phrase

"Labour unavailable" covers a missing Board policy, a draft awaiting approval,
a future-dated one, a contradictory productive basis, a missing burden, a
missing machine treatment, a missing machine source, a missing overhead
dependency, a missing SAM and a missing salary basis. Those are fixed by four
different people in four different apps.

`labourPolicy.CODES` keeps five apart; the four policy states come from
`boardPolicy.resolveState`; and `labourCost.assumptionGaps` — still the one
definition — supplies the rest. The departmental projection publishes states
and dates and **never the methodology**.

### 6B.6 What is frozen

`CostingVersion.labourProvenance` carries two things the version never had.

**The Board's decision**, copied by value, including both halves of the
productive basis: `productiveBasis`, `labourEfficiencyPercent` AND
`productiveMinutesResolved`. An efficiency is not a denominator — 80% is what
the Board agreed and 9,984 is what the arithmetic divided by, and a reader
checking a rate needs the second while an auditor asking what was agreed needs
the first. The resolved figure is taken from `labourCost.productiveBasis()`
itself, so the frozen denominator is guaranteed to be the one used.

**Every operation's working** — SAM, salary, employer monthly cost, productive
minutes, cost per minute and the resulting figure. The assembly has always
computed these and the preview has always shown them; **no version has ever
kept one**, so "₹3.54 for this operation" could only be checked by re-reading
the sample, the operation master and the policy — and once any of the three had
moved, not at all. Read off the frozen lines, never recomputed.

Dependencies are frozen too, so a version costed while no machine source
existed goes on saying so rather than looking complete the day somebody builds
one.

### 6B.7 Legacy handling

The four fields are refused on write with **`LABOUR_POLICY_MOVED` (409)**, by
name. **All four clear together** — they are one methodology, and a
half-cleared one would leave an employer burden with no productive basis to
apply it to.

They stay on the schema, in `policySnapshot`, and in the `GET` response
(`labourPolicy.editable: false`), so old versions stay explicable and a company
can see the assumptions it needs approved. They feed no calculation.

`validatePatch` seeds them from `legacy*` so an unrelated save cannot `$unset`
them — the same hazard overhead had, guarded the same way and tested by name.

**`/costing/policy` had four live controls for this**, more than any other
retired family. All are gone, replaced by a read-only statement and, where they
survive, the legacy figures shown as retired.

## 6C. Input GST treatment — the fourth policy (8 Sep 2026)

The shortest contract of the four — one field, two values — and the one whose
risk is not in its complexity but in its **name**.

### 6C.1 Four facts are called "GST", and this is one of them

| Fact | Owner | Where |
|---|---|---|
| the **rate** a supplier charges | Store | `gstRatePercent` on the quotation |
| whether eligible input tax is **reclaimed** | **the Board** | this policy |
| customs **duty** | **the Board**, separately | `DUTY_POLICY` — its own record, §6G |
| **output** GST billed to the customer | Sales / Accounts | invoices and vouchers |

A director approving this while thinking of one of the other three would apply
the wrong answer to every purchased line in the company, so the screen names
the three it is not.

### 6C.2 The contract

`inputGstTreatment`: `RECOVERABLE` or `NON_RECOVERABLE`. No default, because
the two move money in opposite directions on every quotation-backed line —
assuming reclaimed under-costs every non-recoverable purchase, assuming the
reverse over-costs the rest.

**`NONE` is deliberately not a third value.** It is the absence of an opinion
rather than a third opinion — and a supply that genuinely carries no GST says
so on its own quotation.

### 6C.3 Precedence — the quotation keeps its exception

`offerPricing.taxPositionFor` was **not touched** and remains the single place
a tax position is decided:

| Quotation says | Result |
|---|---|
| `priceBasis: NON_TAXABLE` | `treatment: NONE`, rate a recorded `0`. A company treatment on one is **refused**, not applied |
| taxable, rate recorded | the Board's treatment applies at the quotation's own rate |
| taxable, **no** rate recorded | refused (`GST_NOT_RECORDED`) — not treated as zero-rated |
| taxable, rate recorded as `0` | honoured. `undefined` is "nobody wrote a rate down"; `0` is "this is zero-rated", a supplier's statement |

**The Board decides how ELIGIBLE input tax is treated. It does not decide what
is taxable**, and the screen says so at the point of choosing.

### 6C.4 One overlay, every family

`getPolicy(ctx, {asOf})` fills `policy.inputGstTreatment` from the Board
version — the fourth consumer of that seam. All five paths read it from that
one object: materials and packaging via `attachQuotations`, outside processes
and bought-in development via `attachServiceQuotations`, and freight via
`freight.priceScenario`. No pricing code changed.

The engine's arithmetic is untouched: `RECOVERABLE` accumulates into
`recoverableTaxMinor` and is added to nothing; `NON_RECOVERABLE` is added to
the line; `NONE` does nothing. Exact `Decimal`, one rounding point.

### 6C.5 Duty and GST are one FAMILY and two FACTS

Costing reports both under `duty` because both are tax that stays with the
company. They are different charges on different events, and merging them into
one Board policy would mean approving a customs position nobody can compute —
there is no tariff table. The readiness contract now names them as two facts:
`INPUT_GST_TREATMENT` (Board, migrated) beside `CUSTOMS_CLASSIFICATION` (no
source at all).

`familyApplicability.dutyDecision` already refused to record "every material is
domestic, so no customs entry" while the GST treatment was unset. That guard is
unchanged and now reads the Board's value through the snapshot — a
domestic-sourcing decision still cannot close the family on its own.

### 6C.6 What is frozen

The per-line workings were **already** frozen and stay exactly where they are:
each cost line carries `tax.treatment` and `tax.ratePercent`; each scenario's
line result carries `taxMinor` (the tax *added to cost* — zero when
recoverable); each scenario carries `recoverableTaxMinor`; `offerProvenance`
carries the quotation's own `gstRatePercent`, `taxTreatment` and the offer it
came from.

What no version could say is **which company decision** produced the treatment.
`policySnapshot.inputGstTreatment` recorded the value and nothing about its
authority. `CostingVersion.gstProvenance` is that missing half: policy id,
treatment, effective date, approver, approval time.

### 6C.7 Legacy handling

`GST_POLICY_MOVED` (409) on write, by name; clearing only. The value stays on
the schema, in `policySnapshot` and in the `GET` response
(`gstPolicy.editable: false`), and feeds no calculation. `validatePatch` seeds
it from `legacyInputGstTreatment` so an unrelated save cannot `$unset` it.

`/costing/policy` had a select for it; it is gone, replaced by a read-only
statement that also says the quotation's non-taxable answer still wins.

**A company with no approved policy has its quotation-backed lines refused**
(`TAX_TREATMENT_REQUIRED`) rather than priced on an assumption. That is the
existing refusal, unchanged — only its source moved.

## 6D. Development and tooling charges — the fifth policy (8 Sep 2026)

The first Board payload that is a **catalogue** rather than a figure. Everything
about the lifecycle is unchanged; what is new is that the thing approved is a
list of charges, each with a permanent identity and its own dated rates.

### 6D.1 What this policy is, and what it is not

A development requirement is priced one of two ways, and Merchandising says
which when it records the row:

| `developmentSource` | Priced from | Owner |
|---|---|---|
| `SUPPLIER_QUOTATION` | Store's service quotation register | Store |
| `COMPANY_POLICY` | a charge the company published | **Board** |

Only the second moved. Setup bought outside is still priced from that
supplier's quotation, exactly like any other outside process, and this
migration does not touch `ServiceSupplierOffer` or that path.

A charge for work the company does itself is a price the company publishes
about its own capability: no supplier quoted it and no department measured it.
That is why it is a Board decision and not a Finance setting.

### 6D.2 Two layers of dating, and both are load-bearing

The Board **version**'s `effectiveFrom` selects which catalogue is company
policy on the costing's date. Each charge's **rate periods** select which rate
inside it applies on the same date.

* Drop the outer layer and adding a charge would apply to every costing ever
  recalculated — the catalogue itself is otherwise undated.
* Drop the inner one and publishing October's rate would re-price a costing
  already approved at September's, which is the exact defect `rates[]` was
  introduced to fix.

Both are proved independently in `test/costing/board-development-policy.test.js`
§5.

### 6D.3 The contract

`developmentCharges` is a **list**, unlike the other four payloads, which the
generic dispatch has to accommodate: `createDraft`/`updateDraft` default a
missing payload to `{}`, and for this key anything that is not an array means
*not sent* and leaves the stored catalogue alone. `default: undefined` on the
model rather than `[]`, because a company that has configured none has none.

| Rule | Where it bites | Why there |
|---|---|---|
| a key is claimed, never invented | write (`DEVELOPMENT_CHARGE_KEY_UNKNOWN`) | a second identity for one charge orphans half its requirements |
| nothing may vanish from a draft | write (`DEVELOPMENT_CHARGE_KEY_REMOVED`, 409, `remedy: "DEACTIVATE"`) | requirements and frozen costings point at the key |
| nothing may vanish across versions | **approval** (same code) | a draft starts empty, so a draft-only check is trivially satisfied |
| rate periods coherent — start required, window not inverted, INR only, no overlap, only the last open-ended | write | these are not incompleteness, they are incoherence |
| a charge with no rate; a per-unit charge with no unit | **approval** (`BOARD_POLICY_INCOMPLETE`) | a draft is a decision being worked out; approving one that no costing could apply is the failure |

The last row is a deliberate move: under the retired writer, saving *was*
publishing, so both were refused on save. A draft is not published.

### 6D.4 An empty catalogue is an answer; no policy is not

`[]` means the Board decided the company publishes no charge of its own — a
real answer for a company that buys every piece of setup outside. `undefined`
means nobody has decided. The two are fixed in different places, so the overlay
fills `developmentCharges` with an array in the first case and leaves it absent
in the second, and `applyDevelopmentCharges` gives a different refusal for each.

### 6D.5 The calculation, unchanged

`services/centralCosting/developmentCharges.js` — `selectPeriod`,
`chargeTotalMinor`, the legacy flat-shape adapter — is **not modified**. The
overlay fills the one field `applyDevelopmentCharges` already read, so the
period selection, the two calculations, the rounding and the four typed
refusals are untouched. Only the owner of the amounts changed, and the gap owner
moved from Finance to the Board.

### 6D.6 The migration door, and why the client cannot use it

A charge's key is what stored requirements point at. Since the Board refuses a
key it does not already hold, an existing catalogue **cannot** be retyped in —
every charge would mint a new key and orphan every requirement naming the old
one. So seeding is server-side: `GET /:policyKey/legacy` offers what the company
still carries, and `POST /:policyKey/drafts {seedFrom}` applies it, validated
against itself so every coherence rule still runs while its own keys are
claimable. `seedFrom: "EFFECTIVE_VERSION"` does the same for amending a
catalogue already in force.

`BoardPolicy.seededFrom` records that the content was copied rather than
authored. **Copying is not approving**: the draft still needs a named approver
and an effective date.

### 6D.7 The information boundary

Merchandising and R&D are given `{key, label, description, calculation, unit}`
and never a rate, a period or a total. The projection lives once, in
`developmentChargePolicy.catalogueForMerchandising`, and all three readers —
`styleDevelopment.service`, `sampleRequirements.service` and the sample-styles
route — call it rather than each mapping their own allowlist.

The catalogue those readers see is resolved at **today**: a version taking
effect next month is not yet what the company publishes, and accepting a key out
of it would let a requirement name a charge that does not exist. The rate
periods inside it are still deliberately ignored there — which rate applies is a
question with the costing's date on it.

### 6D.8 What is frozen

The per-line working was already frozen and is unchanged: `policyProvenance[]`
carries, per line, the charge key and label, the calculation, the unit, the
quantity, the unit amount, the total and the **selected** rate period.

`developmentProvenance` adds the half no version could state — which approved
catalogue that charge was read out of, its effective date, its approver, and how
many charges it held. It carries **no amounts**: copying every rate the company
publishes onto every costing would put a rate card on a garment.

### 6D.9 Legacy handling

`DEVELOPMENT_POLICY_MOVED` (409) on write, by name; clearing only. The table
stays on the schema, in `policySnapshot` and in the `GET` response
(`developmentPolicy.editable: false`), and feeds no calculation.
`validatePatch` seeds `developmentCharges` from `legacyDevelopmentCharges` so an
unrelated save cannot `$unset` it — which matters more here than for the other
four, because this is the material the Board copies into its first draft.

`/costing/policy` had a whole table editor for it. The mount, the editor
component (`components/costing/DevelopmentChargesEditor.js`) and the payload
builder are removed; `components/costing/developmentCharges.js` is reduced to
its reader, and the editing side lives in
`components/board/developmentPolicy.js`. A read-only statement names the charges
the company still carries and says a supplier's setup is unaffected.

**A company with no approved catalogue has its in-house development
requirements refused** rather than priced or treated as free.

## 6E. Standard contingency — the sixth policy (8 Sep 2026)

The first policy on this lifecycle whose decision can legitimately be **no**,
and the first where that had to become sayable.

### 6E.1 The defect this closes

`CostingPolicy.contingencyRatePercent` + `contingencyBasis` were one rate and
one basis. There was no way to record that a company had *considered* a
standard contingency and decided against one, so an empty rate meant both that
and "nobody has ever asked". A costing raised under either was identical — no
line — and so was the frozen version afterwards.

The policy therefore has a **mode**, not just a rate:

| Mode | Meaning | What the engine gets |
|---|---|---|
| `APPLY` | a rate on a stated subtotal | both names filled; a `MISC` line |
| `NONE` | the company adds none, with a recorded reason | neither name; no line |
| *(no policy)* | nobody has decided | neither name; no line, and a readiness note |

### 6E.2 Three answers, not two

An explicit **0%** is a third, distinct decision and is preserved deliberately:
it produces a real `MISC` line at nil in every build-up, which a later Board can
raise without changing the shape of the cost sheet. `NONE` says the company does
not work that way at all. The engine already told them apart — a `"0"` rate
synthesises a line, an absent rate does not — and `overlayFor` keeps that by
filling nothing for `NONE` rather than a fabricated zero.

### 6E.3 The rationale is completeness — only here

`contingencyGaps` is the one gap function that reads the version's `rationale`
as well as its payload, via `CONTRACT.gapsNeedRationale`. A nil contingency with
no reason is indistinguishable from an oversight a year later, and the reason is
the only thing that separates them. `APPLY` does not require one.

### 6E.4 A basis that made every costing uncalculable

The contingency line is `MISC`, and four of the eleven bases **contain** `MISC`:
`DIRECT`, `DIRECT_PLUS_FIXED`, `SUBTOTAL_BEFORE_OVERHEAD`,
`SUBTOTAL_BEFORE_FINANCING`. A percentage of a total that includes itself is
refused by `orderPercentLines` — and it refuses **the whole costing**, not the
line. The retired writer accepted all eleven, and an existing test actually
stored `SUBTOTAL_BEFORE_OVERHEAD`, so any company configured that way had every
costing it raised refused, discoverable only by raising one.

`CONTINGENCY_BASES` is **derived** from the engine's own `BASES` rather than
listed, so a basis added to the engine is classified by the same rule. The
contract refuses the four by name with `CONTINGENCY_BASIS_CIRCULAR`; the screen
does not offer them.

### 6E.5 The calculation, unchanged

`contingency = basis × rate ÷ 100`, synthesised by `engine.js` as before,
ordered against every other percentage line by the same topological pass and
rounded once. `engine.js` was **not modified**. Contingency stays `MISC` — a
cost, distinct from `OVERHEAD` (its own category, its own Board policy) and from
margin (not a cost at all; applied to the total afterwards).

### 6E.6 Readiness — reported, never blocking

A contingency is a cushion **on** a cost, not an input **to** one: every figure
in a costing is correct without it, and `costCoverage` already lists `MISC` as
ungated, so no family waits on it. It is therefore an open **Board decision**,
non-blocking — the same weight it had before, with two corrections:

* the note appears only when the Board has **not decided**. A company that chose
  `NONE` no longer gets told for ever that its policy "is not configured", which
  is what a rate-presence check produced;
* the owner is the Board, not Finance.

`policySection` gains a three-state row: `VERIFIED`, `NOT_APPLICABLE` (a
decision of none — an answer) and `MISSING` (a silence).

### 6E.7 What is frozen

`contingencyProvenance` is the only block in this family frozen **when nothing
was charged**, and that is why it exists. It carries the state, the mode, the
policy id, effective date, approver, the **rationale** (which for `NONE` is the
evidence a reader has instead of a line), the rate and basis where applicable,
and the per-scenario `basisAmountMinor` / `contingencyMinor` read off the
engine's own result. Not frozen when no policy is in force — an unanswered
question belongs in readiness, not as a provenance block on every version.

### 6E.8 Legacy handling

`CONTINGENCY_POLICY_MOVED` (409) on write, by name; clearing only, and the pair
clears together. `validatePatch` seeds both from `legacyContingency*` so an
unrelated save cannot `$unset` them.

**There was never a frontend editor for contingency** — the only mention of it
in `grav-cms` was a test fixture string. So nothing was removed from
`/costing/policy` beyond adding the read-only Board statement; no UI-removal is
claimed. A repository check pins this.

`GET /:policyKey/legacy` offers the retired rate as an `APPLY` seed — the old
shape could only ever have meant "we add this much". A legacy basis the engine
cannot charge is **dropped and named** (`basisDropped`) rather than carried,
because carrying it would refuse the draft outright and leave exactly the
companies whose costings have been failing with no way to fix anything.

## 6F. Margin and profit guardrails — the seventh policy (8 Sep 2026)

The last family off the mutable `CostingPolicy` row, and the only one whose
absence stops a costing outright.

### 6F.1 Why this one is not like the other six

Overhead, labour, GST, development charges and contingency are **costs** the
engine adds or does not add: a company missing one still gets a costing with the
gap named. The margin band is what every price break is **solved from** —

```
selling price = cost / (1 - margin)
```

— and `engine.js` reads all three figures as **required**, refusing `undefined`
and enforcing the ordering itself. A company with no band has no selling price
at all.

### 6F.2 The default that made this urgent

`CostingPolicy` declared the three `required: true, default: "0"`. So a company
that had never opened the costing screen held a band **the engine accepts** —
and would have priced every garment at cost, with nobody's name against the
decision. Every other retired field defaulted to absent and produced a *gap*;
this one produced a *price*.

`profitBridge.standingOf` already carried the right instinct ("a band of zeroes
is the unconfigured default, not a decision that every price is acceptable") and
leaned on a separate `configured` flag. The flag worked; what it could never
carry is who decided the band and from when.

Three states now, and they are different records:

| | Engine gets | Outcome |
|---|---|---|
| no approved policy | nothing | refused, `MARGIN_POLICY_REQUIRED` (409), naming the Board |
| approved 0/0/0 | `"0"` × 3 | prices at cost — a decision somebody signed |
| approved band | the band | prices from it |

`DEFAULTS` no longer carries the zeros, and the schema's `required`/`default`
are removed: what is left on the row is history, and history is not required.

### 6F.3 Which fields, and why together

| Field | In the policy | Why |
|---|---|---|
| `minimumMarginPercent` | **band** | the commercial floor |
| `targetMarginPercent` | **band** | the normal acceptable return |
| `preferredMarginPercent` | **band** | the recommended opening position |
| `approvalThresholdMarginPercent` | optional | see §6F.4 |
| `estimatedIncomeTaxRatePercent` | optional | see §6F.5 |

The three band figures are one indivisible decision — the engine validates their
ordering as a unit — so they are gaps together, cleared together, and
`0 ≤ min ≤ target ≤ preferred < 100` is enforced at the write **and** at
approval. 100% is excluded rather than capped: at a margin of 1 the price is a
division by zero, so it is not a high margin, it is not a price.

### 6F.4 The approval threshold is recorded, not enforced

Audited: it is stored, validated and projected, and **read by nothing**. There is
no costing approval workflow that consults a threshold, and building one is
explicitly out of scope. It stays **optional**, and the frozen provenance carries
`approvalThresholdEnforced: false` beside the number — without that flag a reader
years later would assume a price below it had passed an approval that never
existed.

### 6F.5 Estimated income tax stays here, and is labelled

It is not a margin, and it does not warrant its own Board policy. It is a
**profit assumption**: `profitBridge` uses it to turn a pre-tax profit figure
into an after-tax one, it never touches the price arithmetic, and a costing
calculates identically whether or not it is set. It sits on this policy because
it is read beside the band by the same people for the same purpose — kept
visibly apart from the band on the screen, and labelled everywhere as an
after-tax estimate that is **not GST** (`GST_TAX_POLICY` is about tax on
purchases and does change what a garment costs) and **not product cost**.

### 6F.6 Integration and provenance

Resolved at the costing version's `asOf` through the same overlay seam as the
other six, so `engine.js` is unmodified and the price arithmetic, the rounding
to the selling-price increment and the effective-margin reporting are untouched.

`marginProvenance` freezes the policy id, effective date, approver, rationale,
the three band values, the threshold with its `enforced: false` flag, and the tax
rate. It is **inside the `margin` block in `visibility.js`**, so it is withheld
by exactly the rule that withholds the band itself: a reader entitled to see what
a garment costs is not thereby entitled to see what the company will sell it for.
A frozen version is a copy, never a lookup — a later Board decision cannot
re-price it.

### 6F.7 Legacy handling

`MARGIN_POLICY_MOVED` (409) on write for all five fields, by name; clearing only,
with the band clearing as a band. `validatePatch` seeds all five from `legacy*`
so an unrelated save cannot `$unset` them.

**A latent bug was found and fixed here:** the three band fields sat in
`savePolicy`'s always-`$set` object literal rather than the clearable group,
because the schema had made them impossible to unset. An `undefined` in a `$set`
is silently dropped by MongoDB, so clearing would have been a no-op that
reported success. They are in the clearable group now.

`GET /:policyKey/legacy` offers the band as a seed — **except an all-zero one**.
A company sitting on the schema default has not chosen a nil floor; it has never
opened the screen, and seeding that would hand the Board a band to rubber-stamp
that nobody ever meant. That is reported as `allZeroDefault`, not as content.

`/costing/policy` had a **real editor** — three inputs posting straight to the
policy. It is removed and replaced by a read-only statement. There was no editor
for the threshold or the tax rate; neither was even loaded into the panel's form,
so no removal is claimed for those.

## 6G. Customs duty — the eighth policy (9 Sep 2026)

The first policy on this lifecycle that **cannot answer on its own**, and the
first to close a family that had no source at all.

### 6G.1 Three desks, one figure

| Fact | Owner | Record |
|---|---|---|
| whether goods are imported, and from where | **Store** | `SupplierOffer.sourcing.type` + `countryOfOrigin` |
| the customs tariff heading | **Store** (item master) | `RawItem.customsTariffCode` |
| what that heading and origin cost | **Board** | `DUTY_POLICY` |

A line missing any one is blocked naming the desk that holds it. The generic
"no customs duty source exists" that named Finance for all of it is gone.

### 6G.2 What is deliberately never inferred

* the **HSN** on a quotation is a GST classification, not a customs heading;
* a **supplier's address** is where the supplier is, not where goods were made;
* an **item's category** says nothing about its heading;
* there is **no prefix matching** on headings and **no rest-of-world** origin
  fallback.

Each is a real customs concept needing evidence this system does not record.
Matching is exact on heading **and** ISO-2 origin **and** date.

### 6G.3 The assessable base — and its limit, stated

Duty is charged on the **quotation-backed purchase amount** of the imported
line: the selected supplier's rate × consumption × run quantity.

**This is not the statutory CIF assessable value.** The audit found none of the
parts that would make CIF computable — inbound freight has no source at all (the
outbound register is a different lane and carrier), no insurance figure is
recorded, there is no exchange-rate source, and no preferential-origin
certificate is recorded as a value. Inventing any of them would produce a
confident number with no evidence behind it.

Every frozen entry therefore carries `assessableBasis: "QUOTATION_PURCHASE_AMOUNT"`,
so no reader can mistake it for a customs computation.

### 6G.4 A new Store fact, because both guesses were wrong

`freightTerms: INCLUSIVE_LANDED` means *delivered to our warehouse* — a
statement about freight. **Nothing recorded whether a quoted rate already
includes duty.** Adding duty to a rate that includes it overstates every metre;
assuming it does not understates every metre. So
`SupplierOffer.sourcing.dutyInQuotedRate` (`INCLUDED` / `EXCLUDED`) is asked,
absent blocks the imported line, and `INCLUDED` produces a recorded
not-applicable rather than a second charge.

### 6G.5 Nine readiness states, each with an owner

`NOT_APPLICABLE` (domestic, or duty already in the rate) · `SOURCING_TYPE_MISSING`
· `ORIGIN_MISSING` · `TARIFF_CODE_MISSING` · `DUTY_INCLUSION_UNKNOWN` (all Store)
· `POLICY_MISSING` · `NO_MATCHING_RULE` · `AMBIGUOUS_RULES` (all Board) ·
`APPLIED` · `ZERO_RATED`.

**A missing rule is never a rate of nil.** If goods genuinely attract no duty
that is approved as an explicit **0%** rule, which produces a real line of zero
and a `ZERO_RATED` provenance — a different record from no rule at all.

Domestic sourcing answers **only** the customs question; the input-GST policy
question is separate and untouched by it.

### 6G.6 Engine and freezing

A separate line in the existing **`DUTY`** category — never `MISC`, and never
folded into the material rate, because duty is a different charge on a different
event under a different classification levied by a different authority.
`FIXED_PER_RUN` with `amountByScenario`, so each scenario's duty is computed on
its own run total and rounded once.

`dutyProvenance[]` freezes per duty line: policy id, effective date, approver,
rule key and its window, heading, origin, rate, the assessable basis, Store's
offer id **and revision**, the duty-inclusion answer, and per-scenario basis and
duty amounts.

### 6G.7 Fingerprint

`sourceFingerprint` gains one part per duty line carrying heading, origin, rule
key, offer id, offer revision and the inclusion answer — **never the rate, and
never the supplier's**. Sales learns the customs position moved; what it moved
to stays with the desks that own it. The Board policy itself is already covered
generically by `boardPoliciesFor`.

## 6H. The pricing floor — one management markup (9 Sep 2026)

§6F migrated a three-band margin model to the Board. Management then replaced
the model itself. This records what changed, why the key did not, and what
happens to every version approved under the old one.

### 6H.1 One decision, one number, one price

Management sets **one markup percentage**. Central Costing calculates **one
floor selling price** per quantity break:

```
floor selling price = true unit cost × (1 + markup ÷ 100)
```

Sales may quote at or above it freely. Below it is recorded, flagged, and
requires management approval — the standing is published here; the workflow
that acts on it is **not built** and nothing consults it.

### 6H.2 Markup on cost, not margin on price

The distinction is the whole change, and it is money:

| ₹500 true unit cost, 20% | arithmetic | result |
|---|---|---|
| **markup** (this policy) | `500 × 1.20` | **₹600** |
| margin (retired) | `500 ÷ (1 − 0.20)` | ₹625 |

Every layer asserts the ₹600 **and asserts against the ₹625 by name** — the old
formula produces a plausible number from the same two inputs, so a regression to
it is invisible except by that comparison.

### 6H.3 Why the key stayed `MARGIN_POLICY`

A new key was considered and rejected. `MARGIN_POLICY` is:

* the identity every frozen `marginProvenance` names;
* the key the supersession index `{companyId, policyKey, effectiveFrom}` is
  built on;
* what a company's entire approval history hangs off;
* what `boardPoliciesFor`, `sourceApps` and readiness `BOARD_MARGIN_POLICY`
  resolve.

A second key would have started an empty lineage — every approved band reading
as *never approved* — broken effective-date supersession across the change, and,
decisively, allowed **two pricing policies in force for one company on one
date**. So the **contract** is versioned instead, on the payload:

| `pricingContract` | means |
|---|---|
| absent | approved before the field existed. All of these are bands. |
| `MARGIN_BAND_V1` | the retired model. Historical only. |
| `MARKUP_FLOOR_V2` | one markup, one floor. The only contract a new version may be approved under. |

### 6H.4 Active and retired fields

**Active:** `floorMarkupPercent`. Required, `≥ 0`, no upper bound — a margin of
100% divided by zero, a markup of 100% is a doubling. `0` is a valid approved
decision (sell at cost) and is not the same as unset, which blocks.

**Retired as inputs, preserved as record:** `minimumMarginPercent`,
`targetMarginPercent`, `preferredMarginPercent`,
`approvalThresholdMarginPercent`. A patch carrying any of them is **refused by
name** (`MARGIN_BAND_RETIRED`) rather than ignored: a body answered 200 while
nothing it sent was stored would let somebody believe the company's floor had
moved.

`estimatedIncomeTaxRatePercent` is also refused (`NOT_A_PRICING_INPUT`). It is
an assumption about profit **after** a price is agreed — never part of product
cost, and not part of a floor. Versions that froze it keep reporting it; new
ones report the after-tax commentary as unavailable rather than as nil. Where it
should live is a management-reporting policy that is deliberately **not built
here**.

### 6H.5 Nothing converts

A company's approved 20% margin is **not** a 20% markup. Re-reading it as one
would move every floor price in the company without anybody deciding to, so:

* a company still on `MARGIN_BAND_V1` resolves to state `LEGACY_BAND` and is
  refused with a **different message** from a company with no policy — it has a
  decision, it just lacks a markup;
* the legacy door offers the old band as **history**, not as a seed;
* the equivalent markup (`m ÷ (1 − m)`) is offered only as
  `status: "UNAPPROVED_SUGGESTION"`, never written into a draft;
* a draft seeded from the legacy policy carries **no markup at all** and cannot
  be approved until somebody states one.

### 6H.6 What a version freezes

Per version: the board policy id, effective date, approver, `pricingContract`,
`floorMarkupPercent` and `calculationMethod: "MARKUP_ON_TRUE_COST"`. Per
scenario: `trueUnitCostMinor`, `markupAmountMinor`, `floorPriceMinor`,
`roundingIncrementMinor` and `roundingUpliftMinor`.

The method is stored rather than implied: a version holding a price and a
percentage but not the formula could be re-read years later under either, and
the two differ by real money.

**Rounding is upward, always.** A floor raised to the saleable increment stays
at or above the one management set; rounding down would publish a floor beneath
it. The uplift is recorded, not absorbed. A floor of nil reports
`realisedReturnOnPricePercent: null` rather than dividing by zero.

### 6H.7 Three standings, and no workflow

`AT_OR_ABOVE_FLOOR` (equal counts — a floor is the lowest acceptable price, not
one to beat), `BELOW_FLOOR`, `POLICY_MISSING`. A missing floor is never "above":
a price cannot clear a floor that does not exist. Historical rows keep the four
retired band standings and are never re-judged.

### 6H.8 Visibility

The floor price crosses to an output-only reader. `floorMarkupPercent`,
`trueUnitCostMinor` and `markupAmountMinor` sit on the same subdocument and
**none of them crosses** — a reader entitled to quote a price is not thereby
entitled to the company's cost or to what the Board marks it up by. The build-up
is behind `margin.read`.

### 6H.9 Quotation tiers

A quotation may still name a tier against a costing approved under the band —
those quotations are real and the company ships against them. A tier asked of a
**floor-priced** version returns `PRICE_TIER_RETIRED` rather than answering with
the floor under a tier's name: "target" and "floor" are commercially different
claims about the same number.

### 6H.10 The one file the overlay could not protect

Eight policy migrations left `engine.js` untouched by filling legacy field names
from Board records. This one changed the **arithmetic**, so `engine.js` changed:
`priceFor()` and the three-tier `prices` block are gone, replaced by one `floor`.
That is stated here because the overlay seam's whole value was that arithmetic
could not drift, and this is the one time it deliberately did.

## 7. What is unresolved

* **Every company-level costing rule is now Board-governed** — customs duty
  included, and §6G closed the last of the eight. What remains on
  `CostingPolicy` is the base currency, the rounding mode and the selling-price
  increment — mechanical settings, not commercial decisions — plus the retained
  legacy values kept for historical explanation and first-draft seeding.
* **After-tax profit commentary has no source.** The income-tax estimate was
  retired with the margin band and is not a pricing input. Versions that froze
  one keep reporting it; new ones report the after-tax figures as unavailable.
  A management-reporting policy to hold it is not built.

* **No machine-cost source exists.** `IN_OPERATION_RATE` is approvable and
  permanently blocked until a Production machine-rate master is built. That is
  recorded as a dependency rather than hidden, and it is the one gap in this
  lane with no owning department yet.
* **Existing companies carrying legacy overhead or labour values have neither
  until their Board approves them.** That is deliberate — see §6A.4 — and it is the
  one operational consequence of this migration that a company will notice. The
  read-only statement on `/costing/policy` shows the surviving figure so the
  same number can be approved deliberately.
* **A superseded policy is not reported to the department that used it.** If the
  Board halves the financing rate, nothing tells Sales that quotations issued
  last month were costed at the old one. That is a notification question, not a
  policy one, and it is not built.
* **The Board app is one screen.** There is no Board dashboard, no cross-policy
  view and no approval queue, and its nav lists no policy that does not exist —
  an entry for a policy the Board has not made tells a director it has. `/board`
  and `/board/dashboard` both open the financing screen. With five policies now
  listed, the dashboard becoming a real index — what is in force, what is
  drafted, what changes next month — is overdue. Deliberately: this record establishes the
  lifecycle, not the workspace.
* **The access grant is Board's own.** The `board` department admits Board members
  because it is what exists — though holding it now grants nothing until a
  Board role is set (§3.1a). Seeding a real `board` `AccessDepartment` row is
  an access-control change, listed here so it is a decision rather than an
  oversight — see §3.0 for the constants it would move, and
  `components/access/boardRole.js` for the fourth.
