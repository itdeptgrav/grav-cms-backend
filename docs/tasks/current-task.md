# ACTIVE TASK — IMAGE STUDIO / PHOTOPEA, SLICE 0.5: NATIVE GRAV PRESENTATION (21 Sep 2026)

> Codex review accepted the Slice 0 synthetic-file integration proof. The user has asked to improve the native GRAV feel before backend file integration. This is a frontend presentation slice only. Read `docs/product/image-studio-photopea.md`, `docs/decisions/image-studio-photopea-boundary.md`, and `docs/tasks/image-studio-photopea.md` first.

## Scope of this slice

Polish `/image-studio` and `/image-studio/editor` within the existing GRAV shell so they feel like one internal module rather than a diagnostic iframe. Keep Photopea embedded and fully usable; retain its branding, ads, menus, and editor controls as supplied. Use existing GRAV navigation, typography, spacing, status patterns, and responsive conventions. In particular, fix the observed phone-width overlap where the CMS floating top bar covers Photopea's menu row. Provide a clear way back, useful loading/error states, and an editor viewport that gives the creative work priority.

The employee-facing default view should not be a test console. Keep the synthetic open/export proof and diagnostic logging available only in a clearly labelled development/test surface or equivalent automated tests; do not remove the verified adapter or message safeguards. State plainly that GRAV file opening and saving are not available yet. Do not add fake Save, dirty, or autosave indicators.

Do not touch company-drive bytes, backend file endpoints, revisions, Save As, Customer Assets, or production rollout. Do not alter Photopea's cross-origin DOM or use overlays/CSS to hide its branding or ads. Before code, re-read shared frontend files because other work is in flight, and give the precise file-level plan. Preserve unrelated changes; do not commit. Stop after this slice and update `docs/handoff/latest-implementation.md` with actual desktop and phone browser evidence plus relevant tests.

## Exit evidence

- Desktop and narrow-phone browser checks show the Photopea menu unobstructed and the GRAV shell/navigation coherent.
- Loading, failure, and Back flows are understandable without developer logs.
- The prior synthetic image open/export proof and message-coordinator tests still pass.
- No GRAV file or save API was called; no UI claims a GRAV save.

---

# HISTORICAL COMPLETED TASK — IMAGE STUDIO / PHOTOPEA, SLICE 0 (21 Sep 2026)

> Activated by Codex after the user's clarification that hosted Photopea is allowed. The completed Marketing consent task below is retained as history; it is not the active implementation scope. Read `docs/product/image-studio-photopea.md`, `docs/decisions/image-studio-photopea-boundary.md`, and `docs/tasks/image-studio-photopea.md` first.

## Scope of this slice

Prove the documented Photopea integration boundary in the existing CMS shell with **synthetic, non-company image data only**. Inspect both repositories and preserve unrelated/uncommitted changes. Add the minimum protected Image Studio entry/editor route and a small TypeScript Photopea adapter/message coordinator. Verify iframe readiness, exact origin-and-source validation, serialized commands, binary open, `saveToOE` binary export, timeout/error handling, and listener cleanup in a real browser. Unit-test the coordinator with the frontend's existing test stack. Confirm how `customIO` behaves, but do not depend on undocumented behavior without browser evidence.

No GRAV company-drive bytes, file-save endpoint, revision schema, Save As, broad dashboard, customer assets, or production rollout in this slice. Do not show a GRAV “Saved” state. The `restricted`/unclassified exclusion and existing drive authorization must be implemented before a later slice opens GRAV files. Hosted Photopea branding and ads remain intact.

Before code, report the precise file-level plan and any repository changes since the inspection. Stop after this slice, update `docs/handoff/latest-implementation.md` with actual verification, and wait for Codex to activate the next slice. Do not commit unless asked.

## Exit evidence

- The Image Studio entry and editor route load without affecting unrelated pages.
- A synthetic file opens in the embedded Photopea iframe and returns bytes through `saveToOE` in a real browser.
- Invalid-origin/source messages are rejected in tests; timeout and cleanup behavior are tested.
- Documentation records exact supported behavior, limitations, and the next slice's security prerequisites.

---

# HISTORICAL COMPLETED TASK — MARKETING LANE A, CHUNK 1 SLICE 1: CANONICAL CONSENT AND ENFORCEMENT (10 Sep 2026)

> `AGENTS.md` assigns this file to Codex. Added on explicit user instruction.
> Everything below this block is untouched history.

**Status: SLICE COMPLETE. Verified against the live Mautic instance. Nothing committed.**

Roadmap: `docs/tasks/marketing-mautic-roadmap.md` Chunk 1, first bullet. ADR-004
governs. Product source: `docs/product/marketing-app-mautic-plan.md` §7.

## The hole this closes

Chunk 0 shipped `syncContact({ …, consent })`, which checked the argument it was
handed:

```js
if (str(consent.emailConsent) !== "opted_in") refuse
```

That reads like an enforcement and is not one. Any caller wanting a person in
Mautic could have them by passing `{ emailConsent: "opted_in" }` — no record, no
evidence, nobody accountable. The check tested the **request**, and a request
cannot be the authority on whether a person agreed to be marketed to.

## Ownership and data model

Consent is a GRAV business record, in two collections:

| Collection | Role |
|---|---|
| `marketing_consents` | current state; exactly one row per company + person + channel + purpose, unique index |
| `marketing_consent_history` | one row per transition, append-only and enforced at the schema |

Keyed on `gravPersonKey` — the opaque identity `MarketingIdentity` already mints.
**No competing person identity is created.** The consent row deliberately holds
no name, email, phone or company name, so it cannot become a second Contact,
Lead or Person master; reading one requires the identity row that owns the key.
A test asserts the absence of every such field.

Each row carries channel, purpose, state (`unknown` / `opted_in` / `opted_out` /
`suppressed`), capture source and timestamp, notice version, evidence reference,
the actor or system that recorded it, and withdrawal timestamp and reason.
`capturedAt` (when the person answered) is kept distinct from `at` (when GRAV
applied it), because an import records an answer given months earlier and
conflating the two makes a backdated consent look fresh.

Purpose is a real axis: `marketing`, `transactional`, `service`. Transactional is
never consulted for marketing eligibility, so an order-confirmation address
cannot become an audience.

## How append-only is guaranteed

Not by convention. Every mutating mongoose entry point on the history schema is
blocked — `updateOne`, `updateMany`, `findOneAndUpdate`, `findOneAndReplace`,
`replaceOne`, `deleteOne`, `deleteMany`, `findOneAndDelete`, `remove` — and
`pre("save")` refuses a non-new document, so re-saving a loaded entry is an edit
and fails too. The pattern is lifted from
`models/CMS_Models/StorePurchase/SpActionHistory.js`, the repository's existing
append-only ledger, rather than invented beside it. A test drives all eight doors
and the re-save.

Two further integrity properties: the current row's `revision` equals the history
depth, so a silently rewritten row is detectable by arithmetic; and history is
written **before** the current row, so a crash between the two leaves an entry
with no current state — visible and replayable — rather than a state nothing
explains.

## How the resolver behaves

`resolveEffective({ companyId, gravPersonKey, channel, purpose })` reads the
record and takes no state from its caller. Most refusals are properties of the
query rather than branches that must remember:

| Situation | Result |
|---|---|
| another company's consent | not found → `CONSENT_MISSING` |
| another person's consent | not found → `CONSENT_MISSING` |
| transactional consent, marketing asked | not found → `CONSENT_MISSING` |
| no record | `CONSENT_MISSING` |
| row says `unknown` | `CONSENT_UNKNOWN` |
| row says `opted_out` | `CONSENT_WITHDRAWN` |
| row says `suppressed` | `CONSENT_SUPPRESSED` |
| two rows for one tuple | `CONSENT_AMBIGUOUS` |

No path returns `eligible: true` without having read a row whose state is
literally `opted_in` for the asked-for channel and purpose.

**Suppression crosses purposes on the same channel.** A hard bounce is a fact
about the address, so a suppression recorded under `transactional` also blocks
`marketing` on email — the one place a lookup reads beyond its own purpose, and
only ever in the refusing direction. That is the plan's "conflicts resolve toward
suppression until reviewed".

The reason codes are a stable vocabulary in `constants/marketing.js`
(`CONSENT_INELIGIBLE_REASONS`) so the future Data Health screen can group and
count them; each names a different business situation needing a different
response, which is why there is not simply one "not consented".

## Where caller trust was removed

`syncContact` no longer accepts consent. It calls
`assertMarketingEmailEligible` and uses the answer. A caller that still passes
`consent`, `emailConsent`, `consentState`, `suppressed` or `optedIn` is
**refused with 400 `MARKETING_CONSENT_CALLER_SUPPLIED`**, naming the parameter
and saying where consent comes from.

Refused rather than ignored, deliberately. An ignored parameter lets a caller
believe they granted something, and that belief is the whole vulnerability. The
test asserts the refusal with **no consent record present**, so a merely-ignored
parameter would fail 403 for a missing grant and pass a laxer test.

## Verification

| Run | Result | Baseline |
|---|---|---|
| `npx jest test/marketing` | **125 passed, 125 total** | 86 passed |
| `npx jest test/crm test/sales` | 785 passed, 42 failed | 778 passed, 42 failed |

The CRM/Sales total moved because **another agent added
`test/sales/sample-style-surface.test.js` (7 tests) while this slice was in
progress** — not this work. The failure count and the failing set are identical
to baseline: the same nine pre-existing suites.

39 new tests across `test/marketing/marketing-consent.test.js` (38) and the
forged-consent case added to `test/marketing/mautic-contract.test.js`.

### Live proof, against the deployed Mautic 7.2.0

Separate from the synthetic suites. `node /tmp/live-consent.js`, exit 0, 8 of 8:

```text
[PASS] opted-in projected to live Mautic contact 8 and enrolled in segment 1;
       permitted by consent rev 1
[PASS] repeat request idempotent — same contact 8, 1 contact in Mautic
[PASS] optedout   refused 403 CONSENT_WITHDRAWN;   contacts before/after 0/0
[PASS] suppressed refused 403 CONSENT_SUPPRESSED;  contacts before/after 0/0
[PASS] missing    refused 403 CONSENT_MISSING;     contacts before/after 0/0
[PASS] forged consent object rejected 400 MARKETING_CONSENT_CALLER_SUPPLIED
[PASS] history append-only — 1 entry, and an update attempt threw
[PASS] no Sales record created or modified
```

Each refusal was checked against the live Mautic by querying for the address
before and after: the contact was never created and rolled back, it was never
created.

The full Chunk 0 round trip still passes end to end — **11 passed, 0 failed,
exit 0** — with step 1 now writing and resolving a canonical consent record
instead of asserting one.

## Files

Created:

```text
models/CMS_Models/Marketing/MarketingConsent.js          current + append-only history
services/marketing/marketingConsent.service.js           resolver and commands
test/marketing/marketing-consent.test.js                 38 tests
```

Changed:

```text
constants/marketing.js                                   channels, purposes, reason codes
services/storePurchase/errors.js                         3 additive error codes
services/marketing/mauticContactSync.service.js          caller trust removed
scripts/marketing/mautic-round-trip.js                   records consent instead of asserting
test/marketing/mautic-contract.test.js                   consent param stripped, forged case added
```

No Sales, Costing, IE, Packaging or Merchandising file was touched. No Sales
schema changed. No UI, no engagement intake, no scoring, no handover.

## Remaining risks

No HTTP surface yet — consent is written through the service only, so nothing
outside Node can record an opt-in and the Data Health API of Chunk 1's later
bullets does not exist. The reason codes are designed for that screen but no
screen consumes them.

`personKeyForEmail` resolves a person only if `MarketingIdentity` already has a
row; a person GRAV has never met has no key and therefore cannot hold consent,
which is correct but means the identity row must exist first. Nothing yet creates
one outside the projection path.

Suppression is channel-wide by resolution, not by stored state: the suppressed
row still sits under one purpose. A reconciliation that lists suppressions must
query the channel, not the purpose.

The product plan's "last successful synchronization state" per channel is **not**
implemented — it belongs with the retryable delivery state in a later slice.

Unsubscribe and hard-bounce webhooks do not yet call `suppress()`. The command
exists and is idempotent on `commandKey` ready for exactly that, but wiring it is
Chunk 2.

## Is the exit condition satisfied?

For this slice, yes. The slice's condition was that callers cannot obtain Mautic
enrollment by passing a trusted-looking consent object, and that is now true by
construction: the parameter does not exist, passing it is an error, and the only
path to `eligible: true` reads a recorded grant with its evidence. Proved live,
not only synthetically.

Chunk 1 as a whole is **not** complete — the identity mapping and projection
allowlist existed before this slice, but retryable delivery state, the
reconciliation query and the Data Health API remain.

## Next slice (not started)

Chunk 1, second bullet onward: retryable delivery state on the identity mapping
plus the reconciliation query, then the Data Health read API that groups by the
reason codes this slice established.

---

# MARKETING LANE A — CHUNK 0 COMPLETE: LIVE MAUTIC DEPLOYMENT (10 Sep 2026)

> `AGENTS.md` assigns this file to Codex. Added on explicit user instruction.
> The 9 September Chunk 0 block below recorded the same chunk as BLOCKED; it is
> left in place as history and is superseded by this one. Nothing else in the
> file has been touched.

**Status: CHUNK 0 COMPLETE. Verified live. Nothing committed.**

Roadmap: `docs/tasks/marketing-mautic-roadmap.md` Chunk 0. ADR-004 governs.
Full contract and live evidence: `docs/handoff/mautic-chunk-0-contract.md`.

## The blocker is gone

Yesterday's blocker was no container runtime, no PHP, no database. Resolved by
installing **Colima 0.10.3** (Lima 2.2.0, Docker CLI 29.8.0, Compose 5.5.1,
Engine 29.5.2 in the VM) from official Homebrew sources.

Colima rather than Docker Desktop, at the user's explicit choice: Docker Desktop
was the stated preference, but its first launch requires a GUI licence
acceptance and an administrator password for its privileged helper, both of which
would have stopped the task mid-way. Colima needs neither and is the same Docker
API, so `deploy/mautic/docker-compose.yml` ran unchanged.

No pinned image was replaced. All three publish native `linux/arm64` builds, so
nothing runs under emulation on this Apple M4.

## What is running

```text
mautic      healthy   mautic/mautic:7.2.0-20260902-apache@sha256:dea3bb71…03a0f   PHP 8.3.33
mautic-db   healthy   mariadb:11.4.13-noble@sha256:611a2fcc…26430                 MariaDB 11.4.13
mailsink    healthy   axllent/mailpit:v1.31.1@sha256:98b916bd…95365               Mailpit v1.31.1

http://127.0.0.1:8088   Mautic          (localhost only; refused on the LAN IP)
http://127.0.0.1:8025   Mailpit UI      (localhost only; refused on the LAN IP)
                        MariaDB         container-internal, no published port
                        Mailpit SMTP    container-internal, port 1025
```

## The live round trip

`node -r dotenv/config scripts/marketing/mautic-round-trip.js` → **11 passed,
0 failed, exit 0.** Health, a consented synthetic person, contact creation,
idempotent re-sync, the identity mapping read back out of Mautic, segment
enrolment proved by membership read-back, a campaign email delivered into the
sink, a webhook Mautic itself signed and posted, recorded exactly once, replayed
without duplicating, and no Sales lifecycle record anywhere.

A synthetic run exits **64**, never 0, so no CI job can mistake a contract proof
for a live integration.

## What the live instance taught us

Four findings the source reading could not have produced, detailed in the
contract document §11:

1. **A real defect in GRAV's translator.** The webhook payload has no flat
   contact email. Mautic's webhook serializer emits field *groups* of
   descriptors (`stat.lead.fields.core.email.value`), not the flat
   `fields.all.email` the REST API returns, and `stat.lead.email` does not
   exist. GRAV recorded the first real event **with an empty email address** —
   a handover built from that row would have had no address for Sales. Fixed,
   and the real payload is committed as a fixture with four tests against it.
2. **`webhook_allowed_private_addresses` is exact-string, not CIDR**, and the
   literal host `localhost` is refused before the allowlist is consulted.
3. **The official 7.2.0 image is missing two production dependencies** —
   `symfony/dom-crawler` and `symfony/css-selector` — so creating or editing any
   email 500s. An upstream packaging bug; the workaround is documented.
4. **Webhooks queue by default.** `queue_mode` must be `immediate_process`.

Also learned the hard way: running Mautic's cache commands as root breaks Apache,
and a `.env` value containing shell-glob characters can swallow the rest of the
file when sourced — which installed Mautic with a 205-character multi-line admin
password and forced a rebuild.

## Files

Created:

```text
scripts/marketing/mautic-provision-dev.js       idempotent provisioning
scripts/marketing/mautic-webhook-listener.js    the real router, disposable DB
test/marketing/fixtures/mautic-7.2.0-email-open.json   real captured payload
deploy/mautic/.env                              gitignored, mode 600
```

Changed:

```text
services/marketing/mauticWebhookContract.js     contactEmailOf() — the real fix
scripts/marketing/mautic-round-trip.js          live mode actually drives Mautic
test/marketing/mautic-contract.test.js          +4 fixture tests
deploy/mautic/README.md                         runtime, install, networking
docs/handoff/mautic-chunk-0-contract.md         verified live behaviour
.env                                            GRAV's Mautic credentials appended
```

No Sales, Costing, IE, Packaging or Merchandising file was touched. No database
schema changed.

## Verification

| Run | Result |
|---|---|
| `scripts/marketing/mautic-round-trip.js` (live) | **11 passed, 0 failed, exit 0** |
| `scripts/marketing/mautic-round-trip.js --synthetic` | 9 passed, 2 not applicable, exit 64 |
| `npx jest test/marketing` | **86 passed, 86 total** (was 82) |
| `npx jest test/crm test/sales` | 778 passed, 42 failed — unchanged pre-existing baseline |

Nine negative cases proved live: replay, wrong secret, tampered body, unsigned,
invalid credentials, Mautic unreachable, health with Mautic down, missing
`grav_person_key`, non-consented person. Every count that could not be read is
`null`, never `0`.

Least privilege verified against the running instance: contacts and segments
200, users/roles/emails/campaigns/forms/pages/hooks all 403, and the integration
user **cannot send email**.

## Remaining risks

OAuth2 has never held a real Mautic token — there is no API for creating an
OAuth2 client, so it is UI-only and the proof used basic auth. `form_on_submit`
and `page_on_hit` were not fired live, though they share the envelope and field
shape that `email_on_open` proved. No upgrade rehearsal and no backup/restore
drill has been performed. The two `composer require` packages are lost whenever
the Mautic container is recreated, because `vendor/` is not on a volume. One
`email_on_open` delivery is 8 KB for a single event, so a busy instance will post
considerably more than the useful payload.

## Can Chunk 0 be marked complete?

**Yes.** Its exit criterion was "one synthetic GRAV person completes a send and
webhook round-trip without using Mautic's database directly". That has happened,
end to end, against a pinned supported release, through supported APIs and an
authenticated webhook, with GRAV holding no database credential at all.

The caveats above are Chunk 8 operational-hardening work and a UI step for
OAuth2; none of them blocks Chunk 1.

## Next recommended task

**Chunk 1, first slice: the canonical GRAV marketing-consent record.**

`MarketingIdentity` and the idempotent projection already exist and are proved
live. What does not exist is the consent record they should be reading: today
`syncContact` is handed a `consent` object by its caller and trusts it. Chunk 1's
smallest useful step is a company-scoped `MarketingConsent` model with channel,
purpose, state, capture source, timestamp, notice version, evidence reference
and an append-only history, plus a service that resolves the current state for a
person — so that "only an opted-in person may be projected into Mautic" becomes
a fact the server establishes rather than a parameter the caller asserts.

---

# MARKETING LANE A — CHUNK 0: MAUTIC DEPLOYMENT AND CONTRACT PROOF (9 Sep 2026)

> `AGENTS.md` assigns this file to Codex. This block was added on explicit user
> instruction to record the active Marketing implementation scope. The Chunk 3A
> handover block below and all earlier history are untouched.

**Status: contract RECORDED and PROVED SYNTHETICALLY. Live deployment BLOCKED.
Nothing committed.**

Product source: `docs/product/marketing-app-mautic-plan.md` §6, §10, §12.
Roadmap position: `docs/tasks/marketing-mautic-roadmap.md` Chunk 0. ADR-004
governs. Full contract: `docs/handoff/mautic-chunk-0-contract.md`.

## The blocker, stated first

This machine has no container runtime, no PHP and no relational database:

```text
docker / docker-compose / podman / colima   not found
php / composer                              not found
mysql / mariadb / mysqld                    not found
```

So **no Mautic instance was deployed and no live round trip ran.** Installing
Docker Desktop or a PHP/MariaDB stack is a machine-level change needing the
user's password and was not attempted unasked.

Network access WAS available, and was used: every version and image digest
below was verified live against the GitHub releases API and the Docker registry
manifest API, not taken from memory.

## Pinned versions — verified 9 September 2026

| Component | Pinned | Digest |
|---|---|---|
| Mautic | `7.2.0` "Lynx Edition" (2026-09-02) | `sha256:dea3bb71…03a0f` |
| PHP | `~8.2` + iconv, imap, pdo, zip, zlib | from `core-lib` 7.x composer.json |
| MariaDB | `11.4.13-noble` | `sha256:611a2fcc…26430` |
| Mailpit | `v1.31.1` | `sha256:98b916bd…95365` |

Pinned by digest, not tag. `7.1.3` is the documented fallback; `7.2.0-rc` is a
prerelease and is not deployable.

## What the contract research changed

Reading Mautic 7.2.0's own source rather than trusting the existing endpoint
found a **real defect in Chunk 3A's webhook**, now fixed:

GRAV expected a **hex** digest in `x-mautic-signature`. Mautic 7.x sends
**base64** in a header named **`Webhook-Signature`**
(`bundles/WebhookBundle/Http/Client.php`). The endpoint would have rejected
every genuine delivery, and the symptom — 401s that look like a wrong secret —
sends people to rotate a credential that was never the problem.

Two further differences were found and handled:

- **One POST carries many events, grouped by type.** The endpoint read the body
  as a single event and would have silently dropped everything after the first.
- **An item has no event id of its own.** Mautic injects only `timestamp`. The
  dedupe key is now derived as `<type>:<record>:<id>`, and an item whose record
  has no id is rejected rather than stored under an invented one.

## Files added

```text
deploy/mautic/docker-compose.yml              pinned 3-service dev stack
deploy/mautic/mautic.env.example              stack settings, names only
deploy/mautic/grav.env.example                GRAV-side settings, names only
deploy/mautic/README.md                       topology, least-privilege identity,
                                              health, backup/restore, rotation,
                                              upgrade rehearsal
services/marketing/mauticClient.js            supported REST API client
services/marketing/mauticContactSync.service.js   idempotent projection + enrolment
services/marketing/mauticWebhookContract.js   real signature + envelope translation
services/marketing/mauticHealth.service.js    five separate checks
services/marketing/mauticTestDouble.js        synthetic Mautic contract
scripts/marketing/mautic-round-trip.js        the 9-step prover
test/marketing/mautic-contract.test.js        39 tests
docs/handoff/mautic-chunk-0-contract.md       the recorded contract
```

Changed:

```text
services/marketing/mauticEventIntake.service.js  signature check delegates to the
                                                 one implementation; hex-only bug gone
routes/CMS_Routes/Marketing/marketingHandovers.js  accepts Mautic's own envelope;
                                                 adds GET /health
services/storePurchase/errors.js                 four additive Mautic error codes
.gitignore                                       deploy/mautic secrets and dumps
test/marketing/prospect-handover.route.test.js   route inventory now expects /health
```

No database schema changed. No Sales, Costing, IE, Packaging or Merchandising
file was touched.

## Security and operational controls

- Credentials only in deployment secrets. Both example files carry names and no
  values, and are named to escape the `.gitignore` rule that refuses `.env.*`.
- Least-privilege Mautic role documented: contacts and segments read/edit plus
  API access, everything else off. GRAV never authenticates as the admin.
- MariaDB on a network with no published port — "GRAV must not read Mautic's
  database" is enforced by topology, not convention.
- Mail sink only. No credentialed path off the host; the probe address is a
  reserved `.invalid` domain that can never be delivered to.
- Both published ports bind to `127.0.0.1`.
- Plain http to a non-local host is refused at start-up.
- Logs mask the person (`m***@domain`) and drop the query string, which carries
  the email in a `where[]` filter.
- Webhook rate-limited per IP; unconfigured secret rejects everything.
- 401/403 and 400/422 are terminal — hammering a bad credential can lock the
  integration identity out.

## Verification

| Run | Result |
|---|---|
| `npx jest test/marketing` | **82 passed, 82 total** (43 handover + 39 contract) |
| `scripts/marketing/mautic-round-trip.js --synthetic` | **9 passed, 0 failed, 1 manual**, exit 64 |
| `npx jest test/marketing test/crm test/sales` | 860 passed, 42 failed — all 42 pre-existing |
| `npx jest test/store-purchase` | 1376 passed, 1 failed — pre-existing |

Both failure sets were proved pre-existing by reverting this chunk's edits to
the shared files and re-running: the same nine CRM suites fail identically
without the `Lead.js` additions, and `idempotency-faults.test.js` fails
identically without the four added error codes.

The synthetic round trip exits **64**, not 0, so no CI job can mistake a
contract proof for a live integration.

## Test coverage

Mautic unavailable · authentication failure · invalid configuration · contact
creation · idempotent contact update · segment enrolment · signed webhook
accepted · invalid signature rejected · webhook replay · missing required
identifiers · unavailable data never rendered as a false zero.

## Remaining risks

Eight named gaps between the synthetic double and a real instance, listed in
`docs/handoff/mautic-chunk-0-contract.md` §11 — chiefly that nothing has
authenticated against a real Mautic, no custom field has been created, no mail
has been sent, and no webhook has been delivered by Mautic itself. Mautic's
`PrivateAddressChecker` will refuse a Docker-to-host callback until
`webhook_allowed_private_addresses` is set, which is documented but unproven.

## Next recommended task

Deploy the stack on a machine with a container runtime and run the live round
trip. That is the whole of what is left in Chunk 0, and every later Marketing
chunk depends on it. Chunk 1 (consent, identity and the one-way contact
projection) is otherwise ready: its client, sync service and identity mapping
are written and tested here.

---

# MARKETING — CHUNK 3A: MARKETING-TO-SALES PROSPECT HANDOVER (9 Sep 2026)

> `AGENTS.md` assigns this file to Codex. This block was added on explicit user
> instruction to record the active Marketing implementation scope. Nothing else
> in the file has been touched.

**Status: IMPLEMENTED — first vertical slice only. Nothing committed.**

Product source: `docs/product/marketing-app-mautic-plan.md` §4.
Roadmap position: `docs/tasks/marketing-mautic-roadmap.md` Chunk 3, reduced to
the handover half. ADR-004 governs.

## Verified Sales workflow (inspected, not assumed)

```text
Prospect                 Lead.captureStatus = "draft"
                         Lead.reviewStatus  = researching | submitted |
                                              returned | approved | rejected
   → Active Lead         Lead.captureStatus = "active", reviewStatus "approved"
                         (services/leadReview.js is the ONLY writer)
   → qualification       Lead.qualificationState: new → qualified →
                         readyToConvert  (services/leadQualification.js is the
                         ONLY writer)
   → Pipeline            Enquiry → SalesJourney stages account … poContract
   → Order Book          poContract / production / shipment
```

Three independent axes already exist on `Lead`: `captureStatus` (Prospect /
Active Lead / Archived), `reviewStatus` (the HOD approval of a Prospect) and
`qualificationState` (how far an Active Lead has come). Each has exactly one
writer. This slice adds no fourth writer to any of them.

## What already exists and is reused

| Need | Existing asset |
|---|---|
| Prospect record | `models/CMS_Models/Sales/Lead.js` (`captureStatus:"draft"`) |
| Prospect reference | `services/leadRef.js` `createWithRef` |
| Duplicate matching | `services/crmDuplicates.js` `findProspectDuplicates` |
| Company scope + ownership stamp | `services/companyContext/*` |
| Cross-application delivery | `services/integration/salesHandoverDelivery.service.js` producer/outbox/receiver/ledger pattern |
| Refusal shape | `services/storePurchase/errors.js` `fail()` |
| Audit of user edits | `services/changeLog.js` `recordChange` |
| Sales authentication | `Middlewear/SalesAuthMiddlewear.js` |
| Manager test | `services/salesAccess.js` `isSalesManager` |

## Data flow

```text
Mautic  ──signed webhook──▶  POST /api/cms/marketing/events
                              marketing_intent_events   (immutable ledger,
                              unique on source+sourceEventId)
                                      │
Zintlr / any provider ──▶ discoveryProvider.service ──▶ provenance block
   (never reaches Mautic; Marketing calls the boundary, not the provider)
                                      │
                              POST /api/cms/marketing/handovers
                              consent + threshold + contract checks
                              rule-based fit / intent assessment
                                      ▼
                              marketing_prospect_handovers  (AWAITING_REVIEW)
                              marketing_outbox_events       (PENDING)
                                      │  marketingProspectDelivery
                                      ▼
                              sales/marketingProspectIntake.receive()
                              marketing_handover_receipts   (intake ledger,
                              unique on companyId+handoverRef)
                                      ▼
                              Lead  captureStatus "draft"
                                    reviewStatus  "researching"
                                    marketingHandover{…} compact projection
                                      │
                              Sales decides on the RECEIPT, not the ledger
                              accept | return | reject | link-duplicate
                                      ▼
                              sales_marketing_outcome_outbox (PENDING)
                                      │  marketingOutcomeDelivery
                                      ▼
                              marketing/salesOutcomeIntake.receive()
                              handover.outcome + acquisitionPausedAt
```

## Boundaries this slice holds

- Marketing writes no Sales record. The Sales receiver creates the Prospect.
- Sales writes no Marketing record. The Marketing receiver records the outcome.
- No Marketing path can reach `leadReview.js` or `leadQualification.js`, so a
  handover cannot produce an Active Lead, an Enquiry, a Journey, a quotation,
  a customer or an order.
- Accepting a handover assigns the Prospect to a salesperson and leaves it a
  Prospect. Becoming an Active Lead stays the existing Sales-only act.
- Zintlr is never called from Mautic and never reaches Mautic. Discovery data
  enters through `services/marketing/discoveryProvider.service.js` and is
  stored as provenance on the handover.

## Files

Created:

```
constants/marketing.js
models/CMS_Models/Marketing/MarketingEvent.js
models/CMS_Models/Marketing/ProspectHandover.js
models/CMS_Models/Marketing/MarketingIdentity.js
models/CMS_Models/Sales/MarketingProspectIntake.js
services/marketing/handoverContract.js
services/marketing/handoverAssessment.js
services/marketing/discoveryProvider.service.js
services/marketing/mauticEventIntake.service.js
services/marketing/prospectHandover.service.js
services/marketing/salesOutcomeIntake.service.js
services/sales/marketingProspectIntake.service.js
services/sales/marketingHandoverDecision.service.js
services/integration/marketingProspectDelivery.service.js
services/integration/marketingOutcomeDelivery.service.js
Middlewear/MarketingAuthMiddlewear.js
routes/CMS_Routes/Marketing/marketingHandovers.js
routes/CMS_Routes/Sales/marketingHandovers.js
test/marketing/prospect-handover.route.test.js
```

Changed:

```
models/CMS_Models/Sales/Lead.js   additive `marketingHandover` block,
                                  additive source code "marketing_campaign",
                                  partial unique index on the handover ref
server.js                         two router mounts
```

## Database changes

New collections: `marketing_intent_events`, `marketing_prospect_handovers`,
`marketing_outbox_events`, `marketing_audit_events`, `marketing_identities`,
`marketing_handover_receipts`, `sales_marketing_outcome_outbox`.

Changed collection: `leads` gains an optional `marketingHandover` subdocument
and one partial unique index `{companyId, marketingHandover.handoverRef}`. No
migration runs; every existing Lead has no such field and is unaffected.

## Verification

`npx jest test/marketing` — 43 passed, 43 total.

`npx jest test/crm test/sales` — 820 passed, 42 failed, all 42 pre-existing. The
same nine suites fail identically with this chunk's `Lead.js` additions reverted
(178 passed / 42 failed both ways), so nothing here caused them. They cluster in
enquiry get-or-create, sales-journey schema defaults, sample-style phases and
the Lead HOD-approval gate.

**Carried risk, not introduced here:** `test/crm/lead-review.route.test.js`
fails on "an ordinary salesperson (even the owner) cannot approve" — a 403 is
expected and a 200 is returned. In this working tree the HOD gate on
Prospect → Active Lead is not holding. This chunk does not depend on it (no
Marketing path reaches `services/leadReview.js` at all) but it weakens the
surrounding guarantee and should be fixed before the Marketing UI ships.

## Out of scope

Marketing app UI, Mautic outbound contact projection, segment enrollment,
engagement timeline projection, campaign attribution reporting, generative
copilot, and every Sales screen not listed above.

---

# IE — CHUNKS 5A–6A: REQUIREMENTS AND LINE BALANCING (9 Sep 2026)

> `AGENTS.md` assigns this file to Codex. This block records the IE Lane A
> status only; nothing else in the file has been touched.

**Chunk 5A backend and frontend — ACCEPTED 9 September 2026. Nothing committed.**

A company IE operation now carries a revisioned resource-requirement profile —
machine types, attachments, and operator/helper requirements with skill and
grade — under `GET`/`PATCH /api/cms/ie/operations/library/:operationId/requirements`.

Requirements only: no named employee, no machine id, no assignment, no
availability, no capacity, no bulletin write-back and no release. The audit
found no company-scoped Maintenance or HR master safe to store, so the rows are
normalised snapshots and no cross-department master was created.

The existing Operations destination now includes the Resource Requirements
workspace. It preserves the backend's sibling response contract (`operation`,
`requirements`, `history`), uses the operation revision for writes, supports
explicit first configuration and later partial group edits, and becomes
read-only for retired operations and viewers. It does not imply availability,
allocation or capacity.

Verification: Chunk 5A backend 28/28 and complete IE backend 435/435; the
complete IE frontend suite passed 534/534 independently in Codex review.

Chunk 5B's source audit is complete and the slice is **BLOCKED**. The global
machine register has neither company scope nor stable type identity and its
status describes condition, not uncommitted availability. HR has no skill or
grade master, capability register or company-scoped anonymised aggregate.
Neither attendance/absence nor Store/Purchase access membership is a valid
substitute. No endpoint was created and unknown availability must never be
reported as zero.

**Chunk 6A backend — ACCEPTED 9 September 2026.** IE now owns a separate,
company-scoped DRAFT line layout bound to an exact bulletin revision and exact
approved-standard-time fingerprint. Ordered stable stations assign every
bulletin row at most once; the server calculates work content, pitch,
bottleneck, balance efficiency and loss. Old layouts remain immutable evidence
when either the bulletin or approved standard changes, and a new exact source
opens idempotently beside them.

Verification: focused Chunk 6A 37/37 and complete IE backend 472/472 passed
independently in Codex review. The next executable IE slice is the bounded
Chunk 6A frontend inside the existing Line Planning destination. Detail is in
`docs/handoff/latest-implementation.md`.

---

# SALES SMART CRM — S1 CONVERSATION EVIDENCE FOUNDATION (9 Sep 2026)

> New approved Sales lane. The completed Merchandising record and the Central
> Costing lanes below remain unchanged. This section records a separate,
> sequential implementation scope; it does not reopen any delivered work.

Status:

```text
Smart CRM product direction: RECORDED
Conversation-intelligence boundary: ACCEPTED
S1 implementation contract: READY
S1 application implementation: NOT STARTED
S2 transcript extraction: BLOCKED BY S1
S3 Sales Today feed: BLOCKED BY S1 AND S2
```

The first implementation task is
`docs/tasks/smart-crm-s1-conversation-evidence.md`.

Calls and meetings are both first-class sources. Calls already live in MongoDB
as `CallEvent` records. Recorded CoWork meetings, summaries and verbatim or
translated transcripts live in Firestore. S1 adds a stable, authorized and
audited CRM link across that boundary without copying audio/transcript blobs or
letting model output write business facts.

The durable product direction is
`docs/product/smart-crm-intelligence.md`; the store, identity, authorization and
action boundary is
`docs/decisions/smart-crm-conversation-intelligence-boundary.md`.

---

# MERCHANDISING LANE A — ROUTES EXTRACTED FROM THE SALES ROUTER (10 Sep 2026)

> Same note as below: `AGENTS.md` assigns this file to Codex, and the other
> lane scopes further down are active. Nothing has been removed.

The final checkpoint blocker. Eleven Merchandising endpoints were registered
inside `routes/CMS_Routes/Sales/sampleStyles.js`, a Sales router carrying
seventy-four hunks of another lane's in-flight rewrite, so the staged
Merchandising application could not be assembled without them.

## What this task did

- Moved the eleven handlers to `routes/CMS_Routes/Merchandising/styleRoute.js`,
  under `/api/cms/merchandising`, behind the live `merchandiser` grant.
- Kept five old URLs answering for the R&D application through
  `legacyPackagingCompat` — the same handler objects, re-exported and mounted
  at the old prefix behind the Sales middleware R&D authenticates with.
- Moved the shared response shape (`publicPackagingSelection` →
  `publicSelection`) into `services/sales/packagingBom.service.js`, which both
  surfaces already import, so no logic exists twice.
- Repointed the Merchandising client to one base URL and four Merchandising
  test suites to the Merchandising router.
- Moved two suites whose subject is a SALES helper to `test/sales/`, with every
  assertion unchanged.
- Removed the Merchandising imports the cut left behind in the Sales router.

## The boundary rule

Ownership of a route follows the DECISION it records, not the record it
touches. Sales owns style identity; Merchandising owns the operations recorded
against it. ADR-006 states it, with the alternatives rejected.

`Enquiry.companyId`, `SalesJourney.companyId`,
`Enquiry.products[].productLineRef` and the `CustomerRequest` order line's
`sampleStyleId` are a Sales-to-Merchandising CONTRACT, not Merchandising
ownership of a Sales record. Sales writes all four; Merchandising reads them.

## Verification

The staged snapshot was built from the Git index alone into a temporary
directory and run there: **21 suites, 669 tests, 669 passed.** The Sales
sample-style router in that snapshot is byte-identical to `HEAD`. Frontend
Merchandising suites: 593 tests, 593 passed.

`test/crm/sample-style.route.test.js` fails six tests, identically on pure
`HEAD`, in the staged snapshot and in the working tree. It is the other lane's
in-flight rewrite and is inherited, not caused.

Nothing committed, nothing pushed, nothing deployed, no production data command
executed.

# MERCHANDISING LANE A — M7: CHANGE CONTROL AND ENTERPRISE SCALE (9 Sep 2026)

> Same note as below: `AGENTS.md` assigns this file to Codex, and the Central
> Costing Lane A scope further down is another lane's ACTIVE task. Nothing has
> been removed; M7 is recorded above M6 so every scope stays readable.

Baseline:

```
M1+M2: FROZEN
M3: DELIVERED
M4: DELIVERED
M5: DELIVERED
M6: DELIVERED
M7: DELIVERED
PRE-ORDER DEVELOPMENT: DELIVERED
PRODUCTION CLOSURE: DELIVERED
DATA AND GO-LIVE CLOSURE: DELIVERED
MERCHANDISING: FEATURE-COMPLETE
LOCAL DATA: READY
PRODUCTION DATA: DRY RUN READY, NOT APPLIED
AUTHENTICATED UI: NOT VERIFIED — a release activity
LANE STATUS: CLOSED
```

The closure run walked the whole journey once through the real routers and
found four seam defects, all fixed: the development-to-execution adoption link
was declared and never written; every adopted row was refused while the
adoption reported success; a file with no Time & Action plan could not be given
one; and the reschedule dialog offered Approve to the only person the server
refuses. See `docs/handoff/latest-implementation.md`.

Both data gates are now closed on a real local database and proved idempotent:
27 product-line references minted across 12 enquiries, and one starter calendar
and template published per Merchandising-enabled company. Neither has been run
against the shared Atlas cluster — the exact unexecuted commands are in
`docs/handoff/latest-implementation.md`, and the manual browser pass is
`docs/handoff/merchandising-browser-checklist.md`.

The go-live run also fixed a real defect: an approved reschedule set the
forecast and then propagation recomputed it away, so a date move could be
approved by a second person and never happen.

The `MERCHANDISING: FEATURE-COMPLETE` line was first written at the end of M7
and was wrong then. M1–M7 built the confirmed-order half of the application;
the company does most of its merchandising before a purchase order exists. The
claim stands now that pre-order development is delivered. See
`## MERCHANDISING LANE A — PRE-ORDER DEVELOPMENT` below and ADR-005.

No earlier contract was reopened.

## MERCHANDISING LANE A — PRE-ORDER DEVELOPMENT AND MATERIAL SELECTION (9 Sep 2026)

The correction to the premature completion claim. Merchandising's work now
starts where it actually starts: Sales asks for a product to be developed,
Merchandising decides what it is made from, and everything downstream is
computed against that decision.

The seven permanent ownership decisions are recorded as ADR-005 in
`docs/decisions/architecture-decisions.md` and summarised in section 4A of
`docs/product/merchandising-app-final-plan.md`. In short:

1. A Journey product line has a permanent, server-minted reference — never a
   position, a name or a mutable index.
2. Sales owns the ask; Merchandising owns the file. Neither has a route into
   the other's record.
3. The Development File is a separate aggregate from the Execution File.
4. The development BOM holds identity only; every other field is refused by
   name, saying which department owns it.
5. Approval is maker/checker and freezes. Owners are not exempt.
6. Release to R&D is Sales', because it is a commercial judgement.
7. The approved development selection outranks the registered product's BOM
   for R&D and Costing.

Navigation is now four entries: Overview, Development, Order Execution,
Time & Action.

Two admitted M7 UI gaps closed with it: a manager-only configuration editor
over the existing template, calendar and reason-code endpoints, and a
spreadsheet-based bulk workflow in place of hand-written JSON. Both are
sections of the existing management page and add no navigation entry.

The legacy Sales materials form is READ and offered for adoption, never
written. It is retired only behind a verified migration gate.

---

## What M7 delivered

- **Sales-authorised change intake.** A versioned, immutable, Sales-owned
  change notice carrying only the typed execution projection, with a stable
  `changeRef` across versions, supersession, cancellation, and a retryable
  carrier into Merchandising's own receiver.
- **A Merchandising change case** rooted in the Execution File: acknowledge or
  ask Sales, assess the internal impact, record the revisions it produced,
  announce it to the applications it reaches, close it.
- **Impact that creates revisions and never overwrites.** The change service
  cannot reach an approved revision, a baseline or a submitted pack; it records
  the number of what the owning service produced.
- **Receiver-owned acknowledgements** with staleness that is shown and never
  counted, and an explicit statement that acknowledged is not ready.
- **Preview-first bulk operations** with a source checksum, an expiry, per-row
  outcomes, partial success, a 500-row refusal and formula-safe CSV results.
- **Exports and eight source-backed reports** that refuse to compute a positive
  from missing data.
- **Archive that hides and never deletes**, with restore.
- **Integration observability as a query** — no daemon, timer or broker.
- **A management page off the navigation**, at `/merchandiser/management`.

## What M7 deliberately did not do

No Merchandising path that authors a change or another application's
acknowledgement. No buyer conversation, price, margin or payment terms. No new
capability constant. No fourth navigation destination. No daemon or broker. No
deletion of any audit or version history.

## Honest gaps carried forward

- No application publishes a change acknowledgement yet, so announced
  applications read PENDING and the register says so.
- Bulk rows are entered as JSON; a CSV upload is the natural next iteration.
- Configuration has full APIs but is not editable from the management page.
- The production build is blocked by four untracked Accounting and Store pages
  missing Suspense boundaries — not Merchandising's, evidenced in the handoff.

## Final full-app acceptance

All seven questions in the product plan's §12 are answerable from Merchandising
without opening a Sales Journey or editing another department's record. The
structural invariants hold: three navigation entries, fourteen capabilities,
live authority, immutable approved revisions and baselines, no cross-application
transaction, database-enforced idempotency, no terminal outbox failure, no
daemon, every count opening its records, and a failed read rendering
"Couldn't check" rather than a zero.

---

# MERCHANDISING LANE A — M6: DEPARTMENT STATUS AND DOWNSTREAM HANDOVER (9 Sep 2026)

> Same note as below: `AGENTS.md` assigns this file to Codex, and the Central
> Costing Lane A scope further down is another lane's ACTIVE task. Nothing has
> been removed; M6 is recorded above M5 so every scope stays readable.

Baseline at start:

```
M1+M2: FROZEN
M3: DELIVERED
M4: DELIVERED
M5: DELIVERED
M6: DELIVERED
```

No earlier contract was reopened.

## What M6 delivered

- **Source-backed department projections** for all eight source departments,
  read-only and event-sourced. Four honest availability states — reported,
  unknown, unavailable, not applicable — with the sentence each renders as, and
  derived freshness. A department that has said nothing reads *"Not yet
  reported by Store"*, never a blank, a zero or a tick.
- **A versioned, immutable Execution Pack** rooted in the Execution File,
  holding exact references (not copies) to the accepted Sales handover, the
  execution units, the three approved M3/M4 revisions, the M4 approval
  position, the M5 template/calendar/plan and approved baseline, a labelled
  forecast snapshot, and Merchandising's completion declaration.
- **Completion gates that are Merchandising's own facts only.** Seven of them,
  and not one is another department's readiness — a pack submits with every
  department UNKNOWN, and PPC decides what to do about that.
- **A PPC receiver-owned receipt**, written by PPC's own route behind a live
  `ppc` grant, with accept and clarification. No generic rejected state.
- **The `Handed Over` lifecycle defect closed properly.** `HANDED_OVER` is a
  real lifecycle value produced by PPC's acceptance and reversed by their
  clarification. The view holds records and its count is real. `OPEN`,
  `ON_HOLD`, `CLOSED` and `CANCELLED` are untouched.
- **The ninth tab**, `Department Status & Handover`, with the pack above and
  the department register below it under its own "context, not a submission
  gate" heading. Navigation is still exactly Overview, Order Execution,
  Time & Action.

## What M6 deliberately did not do

No Store, Supply Chain, Product Development, IE, PPC, Quality, Production or
Logistics features inside Merchandising. No supplier, rate, PO, consumption or
cost. No route, service export or model path that authors a department's
status. No Merchandising path that writes PPC's decision. No change control.

## Honest gaps carried forward

- **No application publishes any of the eight department event kinds yet**, so
  every department currently reads UNKNOWN or UNAVAILABLE. That is the true
  state and the register says so; the door is `receive(event)`, called by each
  producing app's own carrier when one exists.
- **PPC's application is one queue and two decisions.** Planning, capacity,
  line allocation and release are PPC's to build; M6 only ensures the receiving
  decision was theirs from the start.
- **The Department Status & Handover tab was not verified visually** — that
  needs an authenticated session and seeded live dev data, which is not
  authorised.

## What is left for M7

Sales-authorised change intake, impact coordination, acknowledgements and T&A
reforecast; bulk tools, exports, reports, archive and observability;
manager-only configuration.

---

# MERCHANDISING LANE A — M5: TIME & ACTION (9 Sep 2026)

> Same note as below: `AGENTS.md` assigns this file to Codex, and the Central
> Costing Lane A scope further down is another lane's ACTIVE task. Nothing has
> been removed; M5 is recorded above M4 so every scope stays readable.

Baseline at start: frontend FROZEN, M1+M2 FROZEN, M3 DELIVERED, M4 DELIVERED.
No earlier contract was reopened.

**M5: DELIVERED.**

## What M5 delivered

- **The date control.** Versioned process templates and working calendars,
  plans instantiated from them, and three dates per milestone — baseline
  (committed), forecast (expected), actual (happened). It answers one question:
  which milestone threatens the committed delivery date, and what is being done
  about it.
- **The baseline as a commitment.** Nothing but baseline creation and revision
  may write `baselineDate`. A revision writes a new immutable baseline and
  supersedes the old one, which stays readable for the life of the file. One
  ACTIVE baseline per plan, enforced by a partial unique index.
- **Source-owned completion.** A milestone another department owns cannot be
  completed by hand here — there is no route for it and no control on the
  screen. Those close from M4's published approval events, through a delivery
  carrier and an intake ledger, recording a reference to the record that closed
  them and no actor.
- **Rescheduling as a decision.** Preview computes the whole downstream impact
  and writes nothing; approval applies the impact that was SHOWN, refuses with
  `TNA_IMPACT_STALE` if the plan moved underneath, and where the move breaks a
  committed date it revises the baseline and may not be approved by its own
  requester — owners included.
- **The cross-file register.** Every milestone across every order, by the date
  somebody is chasing, as an indexed query with cursor pagination and an
  aggregated count per view.
- **The frontend.** A third navigation destination, an eighth tab on the
  Execution File, three date columns that stay three on mobile, a critical-path
  list rather than a Gantt, and the reschedule dialog.

## What M5 deliberately did not do

No personal tasks, to-dos, checklists, delegation or reminders — a source scan
pins their absence. No Store readiness, PPC capacity or production scheduling.
No second approval model: M4's register is untouched and no approval state is
duplicated. No reach into M4's collections — only its published events.

## What is left for M6/M7

Department Status is the one tab the product plan lists that this screen still
does not show, and the navigation carries no change-management or readiness
destination. Both are held to the same rule Time & Action was held to until this
milestone: no surface before the record behind it exists.

---

# MERCHANDISING LANE A — M4: DEVELOPMENT REQUIREMENTS AND APPROVALS (8 Sep 2026)

> Same note as below: `AGENTS.md` assigns this file to Codex, and the Central
> Costing Lane A scope further down is another lane's ACTIVE task. Nothing has
> been removed; M4 is recorded above M3 so all three scopes stay readable.

Baseline at start: frontend FROZEN, M1+M2 FROZEN, M3 DELIVERED. No earlier
contract was reopened.

## What M4 delivered

- **Development Requirements** as a third family of the M3 revision record —
  same lifecycle, same maker/checker, same idempotency, own row shape. Twelve
  requirement types, a required-by date, whose work it is, and execution-unit
  applicability.
- **An Approval Register** per Execution File: what this order waits to be
  approved, who owns each decision, and what their record last said.
- **The ownership rule made structural.** Merchandising states requirements for
  anybody and records results only for itself. Internal approvals resolve live
  from Merchandising's own approved revisions; external ones are observed, and
  22 decision-shaped fields are refused by name. There is no endpoint and no
  control that completes another department's approval.
- **Honest absence.** Sales, Product Development and Quality publish no record
  this register can read, so those rows say `Awaiting source record` and name
  the department — never "outstanding", never a blank. The reader map is empty
  and wired, so a producer can be added without touching anything else.
- **Transitional development data** adopted read-only-previewed and idempotently
  into a draft, carrying no quantity, basis or costing figure.
- **Two tabs**, making seven. Navigation unchanged: Overview, Order Execution.

## Not started

M5 Time & Action, M6 department status and downstream handover, M7 change
control. No external producer or consumer. No Time & Action or Department
Status tab.

Full detail is in `docs/handoff/latest-implementation.md`.

---

# MERCHANDISING LANE A — M3: MATERIALS, TRIM CARD AND PACKAGING (8 Sep 2026)

> **Note on this file.** `AGENTS.md` assigns the collaboration documents to
> Codex, and the Central Costing Lane A scope below is another lane's ACTIVE
> task. It has not been removed or rewritten. This M3 record is added above it
> so both scopes remain readable; if Codex wants one active task per file, the
> split is Codex's to make.

```
Frontend audit: FRONTEND FROZEN
M1+M2.1 backend audit: pending in Lane B at M3 start
M3 proceeded under explicit user-authorised controlled override
```

## What M3 delivered

Each Execution File now has one authoritative, approved and auditable truth for
its material, trim, accessory and packaging selections.

- **Records:** `MerchandisingMaterialTrimRevision` and
  `MerchandisingPackagingRevision`, rooted on the Execution File — never on the
  shared `SampleStyle`, which has no company of its own and which Sales and
  Product Development also write.
- **Lifecycle:** `DRAFT → SUBMITTED → APPROVED`, superseded on the next
  approval; changes-required is a recorded decision that returns it to DRAFT.
  One draft, one submitted and one approved per file and family, each held by
  a partial unique index rather than by a check somebody can race.
- **Identity:** opaque `MTR-`/`PKG-` row references, carried unchanged by every
  clone; withdrawn rows leave the draft and stay in the revisions that approved
  them.
- **Authority:** `merchandising.selection.write` to author, `.approve` to
  decide, live grants only, with maker/checker separation that owners do not
  bypass.
- **Documents:** the Digital Trim Card and the Packaging Specification, as
  authenticated printable frozen revisions that state their revision number and
  say plainly when they have been superseded.
- **Transitional data:** an idempotent, read-only-previewable adoption path
  from `SampleStyle.materials.packagingSelections[]` into a DRAFT, preserving
  the source and approving nothing.
- **Screens:** two new tabs inside the Execution File. Navigation is unchanged
  — Overview and Order Execution.

## Boundaries held

Merchandising states required identity and specification. Consumption, marker,
supplier, quotation, rate, purchase order, stock, lot, receipt, reservation,
issue, laboratory result, testing outcome, sample construction, buyer
communication and buyer approval are not stored, not asked for, and refused by
name. Cross-app records are referenced by identity and source version only.

## Not started

M4 development requirements and approval register, M5 Time & Action, M6
department status and downstream handover, M7 change control. No outbox
consumer. No QR on the printable card — it would require an unauthenticated
public record, which M3 does not create.

Full detail, including the API surface, the event vocabulary and the
verification results, is in `docs/handoff/latest-implementation.md`.

---

# CENTRAL COSTING LANE A — ASKING FOR AN ESTIMATE IS ITS OWN PERMISSION (9 Sep 2026)

## The gap this closes

`Prepare estimate` and `Refresh estimate` were guarded by Sales authentication
and a company resolution, and by nothing else. Both answer *who are you and
which company are you in*. Neither answers *may you do this* — and preparing an
estimate is a write: it can bring a `Costing` and a frozen `CostingVersion`
into existence, under a durable creation claim, in a history somebody may later
be asked about.

So any authenticated Sales user could make the server write records the
capability model reserves for `costing.draft.write` — held by platform
administrators and the CEO authority alone. Company membership is not
authority: every Sales rank belongs to the same company.

## The capability contract

```
costing.prepare
```

> May ask Central Costing to assemble the departmental inputs and prepare or
> refresh an estimate for an authorised Sales enquiry.

It implies **nothing**, and nothing implies it:

| Not implied | Why |
|---|---|
| `costing.cost.read` | Sales does not see the internal build-up |
| `costing.margin.read` | nor what the company adds on top of it |
| `costing.draft.write` | that is the authority to maintain costings, and it carries `cost.read` |
| `costing.approve` | deciding a costing is approved is a separate decision |
| `costing.policy.manage` | the Board owns company-wide rules |
| supplier-rate visibility | quotations are Store's register |
| manual calculation inputs | no client composes a calculation |

A holder can start a calculation and then be shown almost none of its result.
That asymmetry is the design: the request and the reading are different
authorities, which is precisely why an existing name could not express it.

## Role matrix

| Grant | `output.read` | `prepare` | Everything else |
|---|---|---|---|
| Sales **viewer** | ✓ | — | — |
| Sales **editor** | ✓ | ✓ | — |
| Sales **approver** | ✓ | ✓ | — |
| Sales **owner** | ✓ | ✓ | — |
| `ceo` (all ranks) | ✓ | ✓ | ✓ |
| platform administrator | ✓ | ✓ | ✓ |
| every other department | — | — | — |

`viewer` stops at reading because preparing is a write, and `viewer` is the rank
this system gives to people who see the work without being answerable for it.
The resolver ranks rather than matching exactly, so an unnamed Sales rank falls
to the highest rank at or below it — which is what keeps a junior or read-only
grant from silently acquiring a write.

Resolved through the existing `DepartmentRole` table by
`capabilities.resolveCapabilities`, which reads the database on every request.
No parallel permission store, and no token is trusted — a grant revoked or
downgraded a minute ago is gone on the next call.

## Where it is enforced

- **At the door** — `POST /:id/costing-estimate/prepare` calls `assertMayPrepare`
  on the server-resolved context before the service is reached.
- **In the service** — `costingPreparation.prepare` asserts it as its first
  statement, before the brief is resolved or any source assembled. This is
  defence in depth: the service is a plain module, and a future route could
  call it without inheriting a check that lives in one route file.
- **Not on the read.** `GET /:id/costing-estimate` stays open to a Sales viewer.
  Gating it would hide from them the very number their grant exists to let them
  quote, and it writes nothing.

Denial returns a controlled **403 `COSTING_PREPARE_FORBIDDEN`** naming the
required capability — never who holds it. A caller who may not reach the
enquiry never gets that far: that is a 404 from the scope resolution, and the
two answers must not be swapped.

## What denial does not do

No `Costing`, no `CostingVersion`, no creation claim, no idempotency record.
Asserted by counting all three before and after a refused call.

## Frontend

The Sales result projection publishes `permissions.canPrepare`, and
`estimateState` requires it before offering the action. An absent block means
yes, so an older response cannot silently disable the button. The panel is
otherwise unchanged. Hiding the control is a courtesy, not the control: a client
that ignored it meets the 403.

---

# CENTRAL COSTING LANE A — THE ESTIMATE IS PREPARED FROM THE ENQUIRY (8 Sep 2026)

## The product rule this implements

> Sales asks for the estimate, from the enquiry they are already on. Central
> Costing assembles the departments' records, applies Store's quotations and
> the Board's approved policies, calculates and versions — invisibly.
>
> No user opens the Costing app to create or recalculate an estimate. Sales
> sees the commercial answer their role is already entitled to, and nothing
> else.

## What this delivered

**On the enquiry, under `Costing brief`.** A second section, `Costing estimate`,
in Sales' own words and no others: **Prepare estimate · Refresh estimate ·
Awaiting inputs · Estimate ready · Inputs changed · Approval required**. It
shows what is still outstanding **grouped by the department that owes it**, with
a destination where a real screen exists; the permitted result for every
quantity Sales confirmed; each proposed price against the permitted guidance;
whether approval is required; and the version number, calculation date and
status. It never says "costing workspace", offers no manual workaround, and
distinguishes a failed read from an absent estimate.

**One orchestration, server-side.** `services/sales/costingPreparation.service.js`
proves the company, resolves the confirmed brief and its approved style,
assembles the technical and departmental inputs, reads Store's sourcing
decisions and the Board's effective policies, and either reports every blocker
or calls the same engine a calculation always called. The browser sends the
enquiry it is already on and an action key. It constructs no payload.

Four outcomes, and none of them is "always write":

| Outcome | When |
|---|---|
| `BLOCKED` | a department owes an input. Nothing is written, every blocker is returned. |
| `PREPARED` | no estimate existed. The costing and its version 1 are created under one durable creation claim. |
| `REVISED` | the resolved source fingerprint differs from the one the last version froze. |
| `UNCHANGED` | it does not. The version that exists is returned — under the same key and under a different one. |

An approved version is never restated, superseded in place, or mutated.

**One durable fingerprint.** `services/centralCosting/sourceFingerprint.service.js`
hashes the brief's revision, style, quantities and proposed prices; the approved
technical revision; effective consumption and allowance per material; operation
SAM; packaging and service requirements; the shipment facts; the identity of
every quotation behind a line; Store's sourcing and applicability decisions; the
Board's approved policies by id and effective date; the company policy revision;
and the costing date to the day. It is frozen onto the version with its parts,
so "have the inputs changed since?" has something to compare against for ever.

**A token, never a figure.** A quotation contributes its identity and revision, a
Board policy its id and effective date. No rate, no salary, no percentage —
because the parts travel with the version and are shown to Sales as *what
changed*.

**The brief as a real prerequisite.** `sourceApps.REQUIREMENTS` gained a `scope`
of `FAMILY | CALCULATION`, and the confirmed brief is registered as a
Sales-owned `CALCULATION`-scoped requirement with a null family — not attached
to a cost family it does not belong to. It distinguishes seven states: no brief,
draft, confirmed, superseded, style no longer eligible, confirmed with changed
sources, and a current estimate.

**A narrow Sales projection.** `services/sales/costingResult.service.js` publishes
quantity and UOM, the cost **only** under `costing.cost.read`, the proposed
price, the permitted guidance, the margin standing and whether approval is
required, the version status, and whether the result is current. Supplier
identities, quotation rates, material purchase prices, salaries, cost-per-minute
figures and Board percentages are not in the response — shaped out server-side,
not hidden by the browser.

**And Costing prepares nothing.** The `Calculate` control, the
`Create revised costing version` toggle and the `Start a costing` picker are
gone from the app — deleted, not unmounted. `POST /:id/versions` answers a typed
`COSTING_PREPARATION_MOVED_TO_SALES` naming Sales and the enquiry. The
orchestration still calls `versionCreation.createNextVersion` internally, every
historical costing still reads, and the restricted legacy sheet importer,
`submit` and `approve` are untouched — they are the workspace's remaining
actions.

## Two defects this found

**The creation claim ignored its subject.** `{company, actor, operation, key}`
hashed, copying the HTTP middleware — which can afford to leave the target out
because it stores it beside the claim and refuses a mismatch. Nothing stores a
target on a costing's creation claim, so the same action key used on a second
enquiry would not have been refused; it would have been **recovered**, handing
the second enquiry the first enquiry's costing. The subject is now part of what
is claimed, and `sales-estimate-preparation.test.js` fails without it.

**The Board's decisions were not in the fingerprint at all.** It read
`policy.boardPolicies`, which the company costing policy does not carry — each
family's service resolves its own at calculation time. Approving or backdating a
Board policy read as "nothing changed". They are now resolved generically over
the Board's own keys, so a policy added later is fingerprinted the day it exists.

## How the suites were migrated, and what it took

Twenty-seven suites drove `POST /:id/versions` and then asserted on the version
it produced. None of those assertions was ever about the transport, so the
fixture prepares the estimate the way Sales does and returns the result in the
shape they already read — `test/costing/helpers/sourceBacked.js`:
`prepareForCosting`, and `prepareAsRoute` for the enquiry-shaped call.

Two things had to be reproduced rather than summarised.

**The engine's own refusal.** `assertNoBlockingGap` turns the first blocking gap
into the typed answer a caller acts on — "the quotation expired", "below the
supplier's minimum", "quoted in another unit" — and dozens of suites read those
codes. They are derived from the EXCLUDED offers, and an excluded offer names
its supplier and its rate, which is exactly what Sales may not see. So the
orchestration reports the gap, its owner and its message; the fixture, standing
in for the retired route, reproduces what the route gave.

**The whole sequence, for the suites about what a client may send.**
`prepareWithLines` runs the door, then the request parser, then the assembly,
then the technical binding — the four steps the route ran, in the order it ran
them. Every refusal those suites assert is the same refusal, raised by the same
code, reached the only way that is left. The door must refuse first, and it is
asserted every time.

A brief-widening helper appears where a suite needs a genuinely LATER version:
the orchestration will not write one for unchanged sources, so a fixture that
wants a second version has to give it a second reason — another quantity Sales
wants quoted, which is also a real second calculation.

---

# CENTRAL COSTING LANE A — THE COMMERCIAL INPUTS MOVED TO SALES (8 Sep 2026)

## The product rule this implements

> Sales owns the commercial question: which approved style is being quoted,
> what quantities the customer wants priced, the commercial unit, the proposed
> selling price, the commercial note, and when the estimate is needed.
>
> Central Costing consumes the Sales brief and all departmental and Board
> sources invisibly. No user opens Costing to enter a commercial fact.

## What moved, and from where

| Input | Was | Is |
|---|---|---|
| Which of several SampleStyles | `?styleId=` on the preview, `technicalStyleId` on the calculation, a picker in `CostingWorkspace` | `Enquiry.costingBriefs[].sampleStyleId` |
| Run sizes, and which is primary | `scenarios[]` on the calculation, a repeatable editor | `costingBriefs[].quantities[]` |
| The quantity unit | `scenarios[].quantityUom` — **per scenario** | `costingBriefs[].quantityUom` — **once for the brief** |
| Proposed selling price excl. tax | `scenarios[].proposedSellingPriceExclTax` | `quantities[].proposedSellingPriceExclTax` + `currency` |
| The costing note | `note` on the create/calculation payload | `costingBriefs[].note` |
| When the estimate is needed | nowhere at all | `costingBriefs[].requiredBy` |

The unit being per scenario allowed one costing to quote 500 pieces beside 500
metres. It is stated once now, and stamped onto every quantity server-side.

## Where the brief is stored, and why there

**`Enquiry.costingBriefs[]` — top-level, keyed by `SampleStyle._id`.**

* Not on `products[]`: `sanitizeProducts()` rebuilds that array on every
  requirement save and reassigns each row a fresh `_id`. Anything stored on a
  product row is lost the next time somebody edits a quantity — which is why
  `costLedger` and `costingSheets` are top-level and keyed by product NAME.
* Not keyed by product name either. That was the fallback those two had to
  take, and it breaks on a rename and on two spellings of one garment.
* `SampleStyle._id` is stable for ever. `productName` is kept as a **display
  snapshot** and is never joined on.

## Style eligibility

A brief may be confirmed only against a style whose **approved technical
revision** exists — `technicalRecord.approvedRevisionOf(techSheet)`, the frozen
revision Sales approved, not `techSheet.status`. Reading the status field would
let a style be briefed that the costing engine then refuses.

Ineligible styles are **listed with their reason**, never hidden: an absent
option reads as a style that does not exist, and somebody waiting on an
approval needs to see which one.

The chooser publishes identity and approval state only — style code, reference,
variant, and the three gate statuses. No consumption, operation, standard time,
material, quotation or cost: what is IN a style is R&D's and Production's
record, and Sales choosing between styles does not make them a reader of it.

## Supersession

A confirmed brief is what a frozen costing version cites, so it is never
edited and never retargeted. Confirming a brief for a different style of the
same product **closes the earlier one explicitly** — `state: SUPERSEDED`,
`supersededByBriefId`, `supersededBy`, `supersededAt` and a reason. The old
brief goes on naming the style it was actually for.

Two confirmed briefs for one product are **reported, never ranked**: preferring
the newest would silently choose which garment the company quoted.

## Scenarios are quotation quantities, not production orders

A quantity on a brief is a **quotation break point** — "what does this cost at
500, and at 2,000". Several are normal and they are hypothetical. The committed
figure is the work order's, arrives much later, and through a different record.
Reusing an order-quantity structure for these would make a quote look like a
commitment; `approvedOutput` already publishes them to Sales as
`quantityBreaks`, which is what they are.

## Idempotent costing orchestration

Unchanged, and now proved end to end:

* **Costing + version 1** — `POST /api/costings`, guarded by the creation claim
  and its unique index (not the idempotency marker, which is a second write and
  can fail).
* **Each later version** — `POST /:id/versions` under
  `withIdempotency("COSTING_VERSION_CREATE")`, the key bound to the costing in
  the URL. One key, one version: a retry after a lost response returns the same
  version rather than making a second.
* **Two deliberate calculations under two keys** are two versions, which is the
  existing contract and is unchanged.
* An **approved** version is immutable — a later brief revision does not reach
  back into it. A version records what was approved, not a live view of the
  request.

## The refusal contract

```
POST /:id/versions  { scenarios | note | technicalStyleId | quantityUom }
→ 400 COSTING_BRIEF_MOVED
  details: { fields, owner: {department:"Sales", recordedIn:"Enquiry · Costing brief"}, briefAt }

POST /:id/versions  (no confirmed brief, or a DRAFT one)
→ 409 COSTING_BRIEF_REQUIRED
  details: { reason:"NO_CONFIRMED_BRIEF", owner, enquiryRef, product }
```

Refused, never stripped: calculating from the brief while silently discarding
what somebody just typed produces a version that is right and unexplainable,
and a proposed price they believe they recorded would be absent with nothing
saying why.

**Several styles and no brief is `COSTING_BRIEF_REQUIRED` too** — and the
candidates are deliberately **not** published with it. A list of styles
attached to a refusal is an invitation to pick one.

## What is now read-only or absent in Costing

Absent: the scenario editor, the quantity-unit field, the proposed-price field,
the style picker, `?styleId=` on the preview, `toWireScenario`, `seedFrom`'s
scenario seeding, `priceFromPrevious`. `sourceBackedPayload()` takes **no
arguments** and returns `{ lines: [] }`.

Read-only: a `SalesBrief` panel showing the style, each quantity with its unit
and proposed price, the note, the required-by date, and who confirmed it when.
Where there is no brief it names Sales and their screen rather than offering a
blank editor.

## Every interactive action left inside Costing

1. Calculate a new version.
2. Submit for review.
3. Approve, or reject with a reason.
4. Import a historical Sales costing sheet — a migration route with its own
   capability, which states its own run sizes because it predates briefs
   entirely and demanding one would make historical enquiries permanently
   un-importable.

No figure, rate, quantity, unit, price, style, supplier or applicability
decision.

## Next Lane A task

**A Production-owned manufacturing-method decision**, if fully outsourced
garment manufacture is a business case the company actually has. It is the one
cost family whose "no escape" answer rests on the repository recording nothing
rather than on the fact being inherently required, and it needs a product
decision before any code.

# CENTRAL COSTING LANE A — "DOES NOT APPLY", RELOCATED (8 Sep 2026)

## The product rule this implements

> Central Costing does not decide whether a business fact applies. Each
> department records the applicability of the fact it owns, and Central Costing
> consumes that decision read-only. Missing information is never equivalent to
> "not applicable", and a family that is inherently required has no escape.

## The audit, family by family

| Family | Can it genuinely be inapplicable? | Who owns that decision | Source record & screen | Did an explicit source decision already exist? | Did Costing override or duplicate it? | What changed |
|---|---|---|---|---|---|---|
| **Materials** | **No.** A garment is made of something; a blank BOM is unfinished work. There is no registered-product costing context in this repository — `ENQUIRY_STYLE` and `ADHOC` are the only two — so no legitimate workflow reaches costing without a technical record. | nobody | `SampleStyle.materials.rawItems` → approved `techSheet.technical.materials` (R&D) | n/a | **Duplicated as an escape.** `CoverageDecisions` offered "Mark not applicable" on it. | Escape removed. No owner in the table; a decision naming it is refused at the payload and dropped by `assess`. |
| **Packaging** | **Yes** — the customer supplies it, or the goods ship loose. | **Merchandising** (they choose the components) | `materials.packagingSelections` → Merchandising · Style · Packaging components | **No.** Only an empty list, and row-level `included`/`excludedReason`. | **Owned it.** Answerable only by a Costing acknowledgement. | New `materials.packagingDecision`; `PUT /:id/packaging-decision`; control on the Merchandising style page. |
| **Operations** | **No.** A blank Route & SAM is missing Production work. Fully-outsourced manufacture would need a Production-owned manufacturing-method decision **and** the matching external service requirement; the repository records neither, and this task does not invent them. | nobody | `techSheet.technical.operations` (Production, via `styleRoute.service`) | n/a | **Duplicated as an escape.** | Escape removed. |
| **Outside services** | **Yes** — cut, made and finished in-house. | **Production** (the only door to the `OUTSIDE_PROCESS` rows) | `sample.serviceRequirements[purpose=OUTSIDE_PROCESS]` → Production · Style · Outside processes | **No — and the hypothesis was wrong here.** `sourceAppRequirements` returned `NOT_APPLICABLE` on an *empty list*, which is inference, not a decision. | **Owned it,** and inferred it elsewhere. | New `sample.outsideProcessDecision`; `PUT /styles/:id/outside-processes/decision`; control on `StyleRoutePanel`. The empty-list inference is retired — it now reports `AWAITING_OTHER_DEPARTMENT` naming Production. |
| **Freight** | **Yes, and it already is** — but as a *line*, not a family escape. | **Sales** | `Enquiry` delivery terms → `freight.service` | **Yes.** `ex_works`/`to_pay` produce a `RECORDED_ZERO` line with the arrangement on it. | **Duplicated it,** with a special-case guard refusing the acknowledgement on a delivered order. | No family owner at all. The guard is gone because the thing it guarded against cannot be sent. |
| **Customs duty & non-recoverable tax** | **Partly.** Store's `DOMESTIC` evidence answers *customs*. GST is a separate question. | **Store / Purchase** (customs) + the Board's GST policy | `SupplierOffer.sourcing.type` per material → Store · Supplier quotations | **Yes — `sourcingEvidence.rollUp` → `NOT_APPLICABLE`. Built, and read by nobody in Costing.** | **Owned it entirely.** Duty was `AWAITING_SOURCE`; every fixture in the repository answered it with a typed acknowledgement. | Now read. Resolves `NOT_APPLICABLE` only when **both** Store says all-domestic **and** an input-GST treatment is in force — one decision must not erase two tax questions. No duty-rate table was built. |
| **Financing** | **Yes, and it already is** — as a nil line with Sales' reason on it. | **Sales** | `Enquiry.paymentTerms.notApplicable` + reason → `financing.service` | **Yes,** with a compulsory reason. | **Duplicated it.** | No family owner. A 100% advance or zero credit days remains a *recorded zero*, not "not applicable". |
| **Development / tooling** | **Yes** — a repeat style whose pattern and screens exist. | **Merchandising** (`styleDevelopment.service` is the door) | `sample.serviceRequirements[purpose=DEVELOPMENT_TOOLING]` → Merchandising · Style · Development | **No.** Only an empty list; row-level exclusions exist and are a narrower fact. | **Owned it.** | New `sample.developmentDecision`; `PUT /merchandising/styles/:id/development/decision`; control on the Merchandising style page. Row-level exclusions preserved. |
| **Overhead** | **No.** The Board's rate, including an approved zero. | Board (Lane B) | `BoardPolicy` OVERHEAD | n/a | **Duplicated as an escape.** | Escape removed. Lane B's files untouched. |
| **Labour** | **No.** Production supplies the operations, the Board the methodology. | Production + Board (Lane B) | operations + `BoardPolicy` LABOUR_METHODOLOGY | n/a | Folded into `operations`. | No Costing-level escape. |

### Corrections to the starting hypothesis

* **Outside services** — "Production already states whether anything is sent
  outside" was not true. What existed was an empty-list inference in the
  readiness projection, which is precisely the "missing = not applicable"
  defect. An explicit state was added, and the inference removed.
* **Duty** — "Store's explicit domestic/import decision answers customs
  applicability" was true, and the decision was *already recorded and already
  correct*. Nothing in Costing read it.
* **Freight and financing** need no family-level decision at all: both already
  produce an answer as a LINE, which is a stronger record than an exclusion.

## What was removed from Costing

| Removed | Where it lived |
|---|---|
| `technicalAcknowledgements` parsing | `calculationInput.parseAcknowledgements` → `refuseAcknowledgements` |
| `assemble`/`assembleLines` acknowledgement parameter | `assembly.service` |
| the freight `ACKNOWLEDGEMENT_REFUSED` guard | `assembly.applyFreight` — unreachable once nothing can send one |
| `freezeAcknowledgements` | `versionCreation` → `freezeApplicabilityDecisions` |
| `technicalSource.UNRESOLVED` + `resolveUnresolved` | the second checklist over three families that now have records, plus `embellishment`, which had no record, no department and no family |
| `CompleteTechnical` and `CoverageDecisions` panels | `CostingWorkspace` |
| `groupStates`, `acknowledge`, `unacknowledge`, `acknowledgementsToWire`, `GROUP_FORM`, `usableLine` | `technicalImport.js` |

## The tamper-refusal contract

```
POST /api/costings/:id/versions   { technicalAcknowledgements: [...] }
→ 400 COSTING_APPLICABILITY_DECISION_MOVED
  details: {
    field: "technicalAcknowledgements",
    reason: "APPLICABILITY_DECISION_MOVED_TO_SOURCE",
    keys: [...],
    owners: {
      packaging: { department: "Merchandising", recordedIn: "Style · Packaging components" },
      materials: { department: null, recordedIn: null, inherentlyRequired: true },
    },
  }
```

An empty list is refused too. Nothing is silently stripped: dropping it would
calculate from whatever the departments had decided while the person who
pressed Calculate believed they had excluded something else — a version that is
right and unexplainable.

## Historical behaviour

Versions frozen while Costing owned the decision keep their `MANUAL_ENTRY`
`not-applicable:<group>` source references, their `NOT_APPLICABLE` family
states, and the actor, timestamp and reason on each. Nothing is recalculated or
reinterpreted on read. `GROUP_STATE.NOT_APPLICABLE` and its label survive for
exactly that reason. A new decision freezes as `DEPARTMENT_DECISION` instead,
with the department and the record named — and dated when the *department*
decided, not when somebody pressed Calculate.

## Every interactive action left inside Costing

1. Choose which technical record (style) a costing is for, where a product has
   several.
2. Set the run-size scenarios, their units, and a proposed selling price per
   scenario.
3. Add a note.
4. Calculate a new version.
5. Submit for review, and approve or reject with a reason.
6. Import a historical Sales costing sheet (migration route, own capability).

No figure, no rate, no quantity, no supplier and no applicability decision.

## Next smallest Lane A task

**A Production-owned manufacturing-method decision**, if — and only if — fully
outsourced garment manufacture is a business case the company actually has. It
is the one family in the table above whose "no escape" answer rests on the
repository recording nothing, rather than on the fact being inherently
required. It needs a product decision before any code.

# CENTRAL COSTING LANE B — BOARD INPUT GST TREATMENT: DONE (8 Sep 2026)

The fourth policy on the Board lifecycle, at `/board/dashboard/policies/gst`.

**`offerPricing.taxPositionFor` was not touched** — the quotation's own
`NON_TAXABLE` answer still takes precedence, an unrated taxable quotation is
still refused, and a recorded `0` is still the supplier's statement. One
overlay reaches materials, packaging, outside services, bought-in development
and freight.

**This did not implement customs duty.** `duty` stays one family with two named
facts; the tariff × origin table is still unbuilt.

**Legacy:** `GST_POLICY_MOVED` (409), clearing only.
**Frozen:** `gstProvenance` — which decision, when, by whom. The per-line GST
workings were already frozen and are unchanged.

**Decision record:** `docs/decisions/board-policy-lifecycle.md` §6C.
**Input map:** `docs/tasks/central-costing-lane-b-input-map.md` §28.

**Next Board migration:** development charges.

---

# CENTRAL COSTING LANE B — BOARD LABOUR METHODOLOGY: DONE (8 Sep 2026)

The third policy on the Board lifecycle, at `/board/dashboard/policies/labour`.

**`labourCost.js` was not touched** — it stays the single labour authority, and
`getPolicy(ctx, {asOf})` overlays the Board's approved version onto the four
names it reads.

**The productive basis is exactly one** of stated minutes or an efficiency:
neither is undecided, both is two different numbers. **Machine burden** can be
approved and still leave a costing open — `IN_OPERATION_RATE` names a source
nobody has built, `IN_OVERHEAD` depends on the overhead policy — and those are
reported as dependencies, not collapsed into "labour unavailable".

**Legacy:** `LABOUR_POLICY_MOVED` (409), all four fields clearing together.
`/costing/policy` had four live controls; all are gone.

**Frozen:** the Board decision, both halves of the productive basis, and every
operation's working — which no version has ever kept.

**Decision record:** `docs/decisions/board-policy-lifecycle.md` §6B.
**Input map:** `docs/tasks/central-costing-lane-b-input-map.md` §27.

**Next Board migration:** GST treatment.

---

# CENTRAL COSTING LANE A — R&D MATERIAL ALLOWANCE, CONSUMED (8 Sep 2026)

## The canonical rule

> **effective consumption per piece = base × (1 + allowance ÷ 100)**
> — unless the row records the allowance is already inside the quantity, in
> which case the recorded quantity IS the effective one.

Computed once, in exact decimal, in `technicalSource.effectiveConsumption`, and
attached to every material row where the row is built.

## The finding that changed the shape of this task

**`engineeredRow` — R&D's approved technical record — was built, returned as
`facts.engineered`, and read by nobody.** `technicalPreview.mergeMaterial`
paired `planned` and `measured` only.

So a style with a complete, approved technical record was costed from the
Merchandiser's shortlist. The allowance was not being ignored so much as the
entire modern record was, and the previous task's finding ("the source exists,
the engine ignores it") understated it.

`engineeredRow`'s own documentation had said since it was written that it
outranks both — *"the fact its owner established and Sales approved… the only
one of the three that carries an allowance the costing may apply"*. That
precedence is now implemented rather than invented: `RND_ENGINEERED` →
`SAMPLE_MEASURED` → `BOM_PLANNED`, with all three kept visible on the row.

## Modern versus legacy

| | modern (`materialRequirements[]` → approved revision) | legacy (`sample.consumptionRawItems`) |
|---|---|---|
| what the quantity is | what the garment CONTAINS | what the sample round CONSUMED |
| allowance | separate, applied | already inside, never applied again |
| `allowanceAlreadyInQuantity` | `false` | `true` |

The legacy flag is not a guess about the number: `sampleStyles.js` writes that
list as the effective amount and syncs approval with `allowancePercent: 0`.
1.45 × 1.05 = 1.5225 is the allowance charged twice, and is what the flag exists
to prevent.

## Mandatory or optional

**Optional, and explicit** — by R&D's own validation, not a Costing assumption.
`technicalRecord.materialGaps` records that a null allowance means "R&D has not
said", is a legitimate answer, and blocks nothing. Base consumption is
different and still blocks when absent or non-positive.

Three answers stay distinguishable in provenance for ever:

| `allowanceInQuantity` | Meaning |
|---|---|
| `no` | stated, and applied |
| `yes` | legacy — already included |
| `none recorded` | R&D left it blank, which is allowed |

An explicit `0` is a fourth thing again and reads as `0`.

## Effect on quotation selection

`quantityPerUnit` is the effective consumption, and it is the field the
applicability check multiplies by the largest run size. So the supplier's
minimum order, the quantity tier, Store's candidate list and the revalidation of
a recorded sourcing decision are all judged on the quantity that will actually
be bought — 735 metres, not 700.

Both applicability sites also stopped using floating point. `Number(stated) *
largest` made 1.47 × 500 into 734.9999999999999, and a tier boundary reached by
luck is a rate nobody quoted.

A change to either base consumption or allowance reopens a sourcing decision
when the resulting quantity changes applicability — the same revalidation Store
already relies on, now fed the right number.

## Frozen provenance

`baseConsumptionPerPiece`, `allowancePercent`, `allowanceInQuantity`,
`effectiveConsumptionPerPiece`, `unit` — beside the existing evidence, basis and
scenario facts. A reader can reproduce the priced quantity:

```
base × (1 + allowance/100) = effective     (unless already included)
effective × run quantity   = what is bought
```

This replaced `m.measured?.allowancePercent` and a flag derived from the
evidence being `SAMPLE_MEASURED` — both legacy-only. An engineered row with a
real 5% allowance previously froze the allowance as absent and the flag as
"none recorded", which was false.

## Previously understated corrections

1. **The modern record was unread** (above) — the previous task reported the
   symptom and not the cause.
2. **Five `quotationChoices` payload tests were left broken** by the
   quotation-selection task. Its final regression was swamped by Lane B's
   overhead migration and never surfaced them:
   `costing-technical-import.route` (×3), `costing-packaging-services` (×2),
   `costing-development-setup` (×1), `costing-freight` (×1). All now assert the
   refusal, with the positive claim pointed at `sourcing-decisions.route.test.js`
   where the decision is actually made.
3. **`COSTING_TECHNICAL_SOURCE_CHANGED.details.expected`** was a raw number
   while `submitted` was a string; both are exact decimal strings now.

## Not touched

Packaging, services, development and freight get no allowance — an allowance is
a property of a material being cut. Frozen versions are never recalculated on
read. The retired manual wastage line stays refused: `allowancePercent` IS the
wastage fact, and a second field for it would be the same number twice.

## Next Lane A task

**Relocating "does not apply" to the department that owns each family** —
unchanged from the previous task's recommendation, and now the last decision
taken inside Costing.

# BOARD ROLE ASSIGNMENT: DONE (8 Sep 2026)

The Board API required an explicit `DepartmentRole` on `ceo` and Access Control
offered no way to set one, so the guard was correct and unreachable.

**Assign at `/ceo/dashboard/access` → People → Board.** One entry in
`components/access/moduleRoles.js` against `deptSlug: "ceo"`, through the
existing generic writer — no second table, no second API, and **zero backend
source changes**. `boardAccess.js` is untouched: no admin bypass, no
empty-list fallback.

**Membership ≠ role:** the executive department chip opens `/ceo/dashboard` and
shows the Board tile; it grants nothing inside Board until an administrator
picks a role. Changes take effect on the next request without a new sign-in.

**Decision record:** `docs/decisions/board-policy-lifecycle.md` §3.1a–3.1b.

**Next Lane B task:** labour methodology.

---

# CENTRAL COSTING LANE B — BOARD OVERHEAD POLICY: DONE (8 Sep 2026)

The second policy on the Board lifecycle. Company and factory overhead is an
approved, effective-dated `BoardPolicy` version resolved against the costing's
own date, at `/board/dashboard/policies/overhead`.

**The arithmetic did not change** — `engine.js` was not touched. `getPolicy(ctx,
{asOf})` overlays the resolved Board rule onto the two names the engine already
reads.

**Legacy:** `OVERHEAD_POLICY_MOVED` (409) on write, clearing only; the value
stays readable but is applied to nothing, because applying an unapproved rate
under a Board-governed family would treat it as Board-approved.

**Decision record:** `docs/decisions/board-policy-lifecycle.md` §6A.
**Input map:** `docs/tasks/central-costing-lane-b-input-map.md` §26.

**Next Board migration:** labour methodology.

---

# CENTRAL COSTING LANE A — QUOTATION SELECTION MOVED TO STORE (8 Sep 2026)

**Store owns the sourcing decision.** When several valid quotations can price
one requirement, Store chooses in the Store app; Central Costing consumes the
choice read-only and can no longer be sent one.

With this, **Central Costing has no commercial writer left**. The two things a
person still does there — state the run sizes to cost, and record that a family
does not apply — are a request and a decision, not a price.

## The audit, before editing

### When selection is automatic today (unchanged)

| Applicable quotations | Behaviour |
|---|---|
| 0 | blocking gap owned by Store — *record one*, not *choose one* |
| 1 | attached automatically, in all five families; nothing is asked |
| 2+ | blocking gap carrying the candidates, never ordered by price |

Preserved exactly. Sending every unambiguous requirement to a queue would turn
a working automatic path into somebody's inbox and bury the real decisions.

### What makes two quotations comparable

Read from the existing pricing services, not invented:

| Family | Applicability criteria |
|---|---|
| Material, packaging | `{companyId, itemId, variantId, quantity, requestedUom, asOf}` — plus supplier active, UOM convertible, MOQ, order multiple, tier coverage |
| Outside service, development | service id, quantity, billing unit, `asOf` |
| Freight | `{originWarehouseId, destination, mode, asOf}` — a LANE, which is why it cannot be flattened into a service name |

Quantity is the **largest** scenario, because a quotation that cannot supply the
largest run cannot price the costing. Applicability is therefore run-size
dependent, which is the whole reason a decision cannot be a standing preference.

### Where the chosen offer was stored: nowhere

`quotationChoices` was `useState({})` in `CostingWorkspace`, posted with the
calculation and frozen into `offerProvenance`. Nobody's name was on it, nothing
recorded when it was made, and closing the tab asked again.

## The decision identity

`{companyId, costingId, lineKey}` — unique over `ACTIVE` rows.

The smallest truthful key: the costing carries the company, the enquiry, the
product and the style; the line key carries the subject and its variant.

- **Not keyed by item.** "Which supplier for Oxford cotton" is a standing
  preference — a different question, and answering it with a choice made for one
  enquiry at one run size is how a decision outlives its facts.
- **Not keyed by scenario.** A costing prices several run sizes from one
  assembled row set; a per-scenario decision would let one comparison be priced
  from two suppliers.

The **rate is not stored**. The quotation is re-read from its register on every
calculation; a copy here would drift from the number the costing uses. What is
stored beside the choice is the context it was judged in — quantity, unit,
`asOf`, currency, revision, reference, supplier name, candidate count — read by
people and by nothing that calculates.

## Validity and invalidation

Every read revalidates against the live register at the costing's own
quantities and date — the check that already guarded the browser's map, now fed
Store's record. A decision becomes **unresolved, never substituted**, when the
quotation is withdrawn or superseded, is not effective for the date, no longer
fits its tier or MOQ, has an incompatible unit or currency, the freight lane or
mode changed, the requirement changed, or company ownership does not match.

**The successor is never assumed.** Revising supersedes with a new document at a
new rate; following the chain would price the costing at a figure Store has not
agreed to.

**Frozen versions keep what they used.** `offerProvenance` is untouched by any
later change to the live decision.

## What was removed from Costing

- the quotation radio group and its candidate list;
- `quotationChoices` from the payload builder's signature and body;
- `onChooseQuotation` and the state behind it;
- the gate clause that treated a just-clicked radio as a cleared blocker;
- the candidates, rates, suppliers, tiers, MOQs, lead times and exclusion
  reasons from the costing-side view of a gap.

A payload still carrying `quotationChoices` is refused with
**`COSTING_QUOTATION_CHOICE_MOVED` (400)**, naming Store and the screen —
never stripped, which would calculate from whatever Store decided while the
person who pressed Calculate believed they chose.

## Remaining interactive actions in Costing

1. **The run sizes to cost**, and a proposed selling price against each — a
   commercial proposal no cost line reads.
2. **"Does not apply", with a reason** — a decision, frozen with its author.

Plus submit for review and approve. Nothing else; no figure of any kind.

## The information boundary

| Reader | Sees |
|---|---|
| Store's decision screen | rate, unit, tier, MOQ, order multiple, lead time, validity, and ruled-out quotations with reasons |
| A costing reader | that a decision is outstanding, **how many** quotations contend, who owns it, and where it is made |
| Merchandising, R&D, Production, Sales readiness | status and owner only |

A count is not a list: "two suppliers quoted this" says why the costing waits
without saying what either charges.

## Cutting-wastage audit (finding only — no change made)

**It is a separate unresolved fact, not something consumption already carries.**

`SampleStyle.sample.materialRequirements[].allowancePercent` exists and R&D
records it — explicitly separate from `consumptionPerPiece`, and the schema says
so in as many words: *"Explicit, and separate from the consumption. Never folded
into it."*

`technicalSource.service.js` sets `allowanceAlreadyInQuantity: false` on the
technical-record path and `true` only on the legacy `sample.consumptionRawItems`
path — which is precisely why the flag exists.

**Nothing consumes it.** `lineFromMaterial` builds `quantityPerUnit` from
`m.quantity` alone; the allowance is frozen as provenance
(`fact("allowancePercent", …)`) and never multiplied in.

So: the source exists, the engine ignores it, and the two record paths disagree
about whether the allowance is already inside the quantity. Applying it blindly
would double-count on the legacy path. **Left for a decision of its own.**

## Tests

- `test/costing/sourcing-decisions.route.test.js` — 23 tests.
- `components/store/supplier-offers/sourcingDecisions.test.mjs` — 19 tests.

Two behaviours the tests caught and corrected during the build:

1. A withdrawn chosen quotation left exactly one candidate, and the queue's
   "more than one candidate" filter dropped the gap — so Store was never asked
   while the costing went on refusing. The threshold is now "the assembly
   emitted a quotation gap at all", because the assembly only emits one when it
   could not resolve the requirement itself.
2. A decision taken before any run size existed was re-reported for ever: the
   no-quantity branch emitted its gap unconditionally. A recorded decision now
   suppresses it, without applying it — applicability is still judged at
   calculation.

## Verified limitations

1. **The first decision on a costing is judged without a run size.** A costing
   that has never calculated has no scenarios, so the candidates are the
   quotations *current* for the item rather than those *applicable at 500*. The
   screen says "Not yet costed" rather than printing a quantity nobody judged,
   and the choice is revalidated at calculation.
2. **The queue is capped** (25 costings by default, 50 maximum) and reports
   `moreCostingsNotScanned`. Each costing costs an assembly, so an uncapped scan
   would be a slow screen; a silent cap would read as "you are done".
3. **A platform administrator can decide.** `ADMIN_SET` includes
   `sp.sourcing.manage`, repo-wide — the same authority that already lets an
   admin create and withdraw the quotations. Narrowing it is a separate task
   touching every Store route.

## Concurrent-lane note (8 Sep 2026, during this task)

Lane B's **overhead-policy migration landed while this task was running**:
`services/centralCosting/overheadPolicy.service.js` is new, and
`policy.service.savePolicy` now refuses `overheadBasis` and
`overheadRatePercent` with `OVERHEAD_POLICY_MOVED` (409) — the same shape the
financing migration used.

Most costing fixtures set those two fields on the costing policy, so their
`PUT /policy/current` now returns 409 and every test in those suites fails at
the fixture rather than the assertion. It is their migration to finish; overhead
policy and unrelated test repair are both out of this task's scope.

`sourcing-decisions.route.test.js` was adapted — it no longer claims an overhead
rate the Board has not approved, which is the honest fixture under the new
contract, and none of its assertions needed one.

## Next smallest Lane A task

**Move the "does not apply" decision to the department that owns the family.**
It is the last decision taken inside Costing. Packaging not applying is R&D's
statement about the garment; duty not applying is Finance's about the order.
Each already has an app and an owner named on the gap. After it, the only thing
left in the costing workspace is the run sizes and the proposed price — a
commercial request, which belongs with Sales — and the Costing app is a read
surface that can be folded into the apps that own its outputs.


# CENTRAL COSTING LANE A — MANUAL AND PROVISIONAL INPUTS RETIRED (7 Sep 2026)

**No user may type a cost figure inside Central Costing.** There is no control
that offers one, no payload the server accepts, and no cost family whose answer
is "estimate it here". When a source fact is missing the calculation stays
blocked and names the fact, the department that owns it, and the record they
keep it in.

## The audit, before editing

Every place a new manual or provisional value could be created:

| # | Path | Layer | State |
|---|---|---|---|
| 1 | "Add provisional override" button + its four-field form | `CostingWorkspace.js` | **retired** |
| 2 | "Add cost" on each unresolved group in the completion panel | `CostingWorkspace.js` → `technicalImport.lineForGroup` | **retired** |
| 3 | "Use provisional manual rate instead" + a typed rate field | `SupplierOfferPicker.js` (unmounted) | **file deleted** |
| 4 | Automatic fallback: a changed item silently made a quotation-backed row manual | `offerPicker.noteContextChange` → `useManualRate` | **retired** — the row is now UNPRICED, a Store-owned blocker |
| 5 | `rateFieldState` returning `readOnly: false` for an unpriced row | `offerPicker.js` | **retired** — read-only either way |
| 6 | `lines[].override` on `POST /:id/versions` | `calculationInput.parseLine` | **refused** |
| 7 | `lines[].replacesLineKey` sent loose | `calculationInput.parseLine` | **refused** |
| 8 | Override placement into the assembled set | `assembly.mergeOverrides` | **function deleted**; `refuseOverrides` in its place |
| 9 | `MANUAL_ENTRY` override provenance writer | `versionCreation.freezeOverrides` | **deleted** |
| 10 | `AUTHORITY.PROVISIONAL_OVERRIDE` — "a person typed it" | `costCoverage.js` | **removed from the enum** |

### Which paths were historical only

- **Ad-hoc costings.** `POST /costings` with `context.type: "ADHOC"` was already
  closed (`COSTING_ADHOC_CREATION_CLOSED`), and every write to an existing one
  is refused by `refuseHistoricalManual` (`COSTING_ADHOC_READ_ONLY`) — versions,
  legacy import, submit and approve. Untouched.
- **`POST /:id/versions/legacy-import`.** A server-side migration adapter for
  Sales costing sheets, exempted in `versionCreation` and stamping its own
  provenance. **Not reachable from the browser at all** — `costingApi` exposes
  it but nothing in `app/` or `components/` calls it. Untouched.
- **Frozen versions carrying legacy overrides.** Reads only. Untouched.

### Which paths still affected NEW source-backed costings

Rows 1–9 above. Row 6 was the operative one: `parseLine` accepted a declared
override for any family, and `mergeOverrides` placed it into the assembled set
as a supplement or a named replacement.

## The refusal contract

| Payload | Code | Reason | Status |
|---|---|---|---|
| `lines[].override`, however complete | `COSTING_MANUAL_INPUT_RETIRED` | `MANUAL_OVERRIDE_RETIRED` | 400 |
| `lines[].replacesLineKey`, wrapper removed | `COSTING_MANUAL_INPUT_RETIRED` | `REPLACEMENT_LINE_RETIRED` | 400 |
| a plain line with no `technicalKey` | `COSTING_MANUAL_LINE_REFUSED` | `UNDECLARED_MANUAL_LINE`, `remedy: RECORD_IN_OWNING_APPLICATION` | 400 |
| `confidence` other than `PROVISIONAL` | `VALIDATION` | `CONFIDENCE_NOT_CLIENT_SETTABLE` | 400 |
| a server-derived scenario rate, quantity or saving | `VALIDATION` | `SERVER_DERIVED_FIELD` | 400 |

Every refusal carries `family`, `owner: { department, recordedIn }` and the
same sentence in its message, resolved by `costCoverage.ownerOf()`. A dead end
is what sent people to the override in the first place.

**Two layers.** `calculationInput.parseLine` refuses at the request edge before
the style, the quotations and the policy are read. `assembly.assembleLines`
refuses again for an internal caller that built an input without passing the
edge.

**Refused, never stripped.** Dropping a typed figure and calculating the rest
is the worst outcome available: the save succeeds, the person believes their
figure is in the costing, and the version they approve does not contain it.

## What historical behaviour is preserved

- Frozen `PROVISIONAL` cost lines read exactly as written, with their amounts.
- `MANUAL_ENTRY` source references keep `costFamily`, `reason`,
  `enteredByActorName` and `enteredAt`.
- Historical manual (`ADHOC`) costings keep `historical: { label, readOnly,
  reason }` and stay readable under the same visibility rules.
- `STATE.PROVISIONAL` and its "Provisional" label stay in the frontend
  vocabulary; the build-up still tags a provisional line and explains it.
- `PROVISIONAL_INPUTS` warnings on frozen versions still render.

Nothing was deleted, relabelled or rewritten. Retiring creation does not
authorise editing the record.

## Every interactive action left in Costing

Three, and none of them is a number:

1. **Choose a quotation** where several genuinely apply — an offer id only,
   re-read and re-priced per scenario by the server.
2. **State the quantities to cost**, and a proposed selling price against each
   — a commercial proposal that no cost line reads.
3. **Mark a cost family not applicable, with a reason** — frozen with its
   author, stamped from the session.

Plus the lifecycle acts: **submit for review** and **approve** (and the policy
screen, which is Finance's own and out of this scope).

**Quotation selection is deliberately preserved.** Removing the manual fallback
did not require changing who owns that choice, and the brief says so. Moving it
to Store is a later, separate task — and it is the only remaining reason a
person opens the costing workspace to do anything but read.

## Verification

- `test/costing/costing-manual-input-retired.test.js` — 15 tests: the ordinary
  path still calculates from `lines: []`; a declared override, a replacement,
  a loose `replacesLineKey` and an undeclared line are each refused by name and
  by owner; nothing is written on refusal; the parser refuses without a
  database; a missing quotation and an unreadable register both stay blocked;
  every family resolves an owner; and a frozen provisional line and its
  `MANUAL_ENTRY` provenance still read.
- `components/costing/manualInputRetired.test.mjs` — 13 tests: no control, no
  builder, no manual source state, no editable rate field anywhere in
  `components/costing/`; a dropped quotation leaves the row unpriced; a read
  failure is not an absence; blockers keep their owners; `PROVISIONAL` stays
  readable.

## The fixture migration this forced

Twelve backend suites built their costings by posting one typed override per
cost family — the completeness gate refuses review while a family is
unaddressed, so a fixture needed eight rows to get an approvable version.

That is the same shortcut a user had, and leaving the path open so tests could
use it would have been the whole change undone. `test/costing/helpers/
sourceBacked.js` gained `EVERY_FAMILY` (the seed options that make every
SOURCED family calculable) and `DUTY_NOT_APPLICABLE` (the one family with no
source, answered by a decision), and `withOverride` was removed.

Two route-level tests lost their subject and say so in place: `INPUTS_INCOMPLETE`
and `NEGATIVE_NET_COST` are engine guards that no request can now reach, and
both are exercised directly against the engine in `costing-engine.test.js` and
`costing-claim-and-credits.test.js`.

One figure changed: `costing-version.route` asserted a unit cost including a 4%
cutting-wastage line the fixture typed. Nothing records a wastage percentage
for a style, so nothing assembles one, and the figure is 400 minor lower.

## Verified limitations

1. **Customs duty still has no source.** It is the one family in the table with
   no authoritative record — an import classification nothing here holds — so
   the only answer available is "not applicable, with a reason". The
   customs-duty table is explicitly out of scope, and a company that genuinely
   imports dutiable trim cannot cost the duty at all today. This is a real gap,
   and it is now visible as one instead of being papered over by an estimate.
2. **Quotation selection remains in Costing** (see above).
3. **No live browser walkthrough.** The session credentials were not used, per
   the brief. Everything rests on API and component tests.

## Lane B was not touched

`services/centralCosting/financing.service.js`, `services/board/*`,
`models/CMS_Models/Board/BoardPolicy.js`, `app/ceo/dashboard/policies/*` and
Sales payment terms are unmodified. The financing family is read through
`costCoverage.ownerOf` like every other; no methodology, policy writer or
lifecycle was changed.

## Next smallest Lane A task

**Move quotation selection to Store.** It is the last interactive decision in
the costing workspace, and the only reason left to open it for anything but
reading. The shape: where several applicable quotations exist, the assembly
already reports a `CHOICE` gap owned by Store with the candidates attached —
so the decision moves to the supplier-offer register as "which quotation prices
this item for this enquiry", the costing reads it, and `quotationChoices`
leaves the calculation payload. That closes the browser's last write to a
costing, after which the standalone Costing app is a read surface and can be
folded into the apps that own its outputs.


# HRMS CHUNK 1 — HR AUTHORISATION CONTRACT: DONE (7 Sep 2026)

One authorisation contract for every HR endpoint. A valid login no longer grants
any HR data: every request is checked for **application access**, **capability**,
**record scope** and a **protected-field projection**, from access records
re-read server-side.

**Decision records:** `docs/decisions/hr-authorisation-contract.md` (the
contract, denial codes, role templates, compatibility exceptions) and
`docs/decisions/hr-legacy-role-compatibility.md` (the `hr_manager` bridge and
its retirement conditions).
**Endpoint matrix:** `docs/audits/hr-endpoint-capability-matrix.md` — generated,
322 mounted routes across 38 prefixes, 322 declarations, 0 undeclared.

## What was built

| File | Role |
|---|---|
| `services/access/hrCapabilities.js` | 38-capability catalogue + 8 role templates + the legacy role map |
| `services/access/hrFieldPolicy.js` | directory / private / restricted allowlists, `NEVER_EXPOSE`, `excludeSelect`, `projectEmployee`, `scrubResponse`, `redactSecrets` |
| `services/access/hrAuthorization.js` | the resolver: `resolveHrActor` and `authorizeHr` |
| `services/access/hrRouteContract.js` | 322 explicit endpoint declarations + the matcher |
| `services/access/hrMountRegistry.js` | the mounted-router list and the route walker |
| `Middlewear/hrContract.js` | mount-level enforcement, the response scrub, and the record-free denial audit |
| `scripts/hrRouteInventory.js` | the matrix generator and the coverage test's input |
| `server.js` | five `app.use(prefix, hrContract())` lines, above every HR router — three of them deliberately BELOW `conditionalGet` so the ETag covers the scrubbed body |

`services/access/hrAccess.js` became a thin `{ allowed, via }` view over the same
resolver, and the assistant's HR tools now name the capability their data needs
(`services/ai/tools/hrTools.js`, `services/ai/gravAssistant.js`) — so a CEO
refused compensation at `/api/hr/payslip/:id` is refused it by `hr_salary` too.

## Endpoint families covered

Employee list/detail/create/update/import/history; departments and team
structure; attendance (daily, timecard, muster roll, settings, corrections,
regularisations, holidays, period sync); shift swaps; face registration; leave
(config, balances, decisions, holidays); payroll (preview, run, items, overrides,
settings, export) and payslips; recruitment (jobs, candidates, tasks); documents
and document requests; policies and SOPs; performance; reports; change history;
HR profile; password management; the CEO HR projection; and the employee/manager
self-service surface under `/api/employee/**`.

## Tests

| Suite | Result |
|---|---|
| `test/hr-access/route-coverage.test.js` | 18/18 |
| `test/hr-access/hr-authorisation.test.js` | 22/22 |
| `test/hr-access/hr-contract.route.test.js` | 25/25 |
| `test/hr-access/hr-field-projection.test.js` | 16/16 |
| `test/hr-access/hr-approval-queue.route.test.js` | 7/7 |
| `test/hr-access/manager-scope.route.test.js` | 3/3 |
| `test/hr-access/hr-response-scrub.route.test.js` | 8/8 |
| `test/hr-access/hr-ai-parity.test.js` | 10/10 |
| **`test/hr-access` + `test/hr-ai` together** | **133/133** |
| `test/hr-ai/centralAssistant.route.test.js` | 14/14 (was 0/14 — see below) |
| `npm run verify` (13 safe harnesses) | 368 passed, 0 failed |
| `npm test` (node:test) | 1803/1804 |
| `test/access`, `test/auth`, `test/planner`, `test/requests` | run for regression — all failures pre-existing, see below |

`route-coverage.test.js` is the one that stops the next unguarded endpoint: it
walks the real `router.stack` of all 38 mounts in a child node process (two
routers pull in ESM-only dependencies Jest's loader refuses) and fails when a
route has no declaration — or when a declaration has no route.

**Pre-existing failures, unchanged by this work** (each reproduced with the
chunk's files reverted):
- `test/access/department-role-cache.test.js` — 3 failures
- `test/auth/cowork-sso-apps.route.test.js` — 4 failures
- `services/salesJourneyOutcome.test.js` — 1 failure (sales journey, in the
  in-progress uncommitted Sales work)
- `test/requests` — 55 failures, identical with and without this chunk's files
  (the in-progress uncommitted budget/spend work)
- `verifyHrChangeHistory.js` — 4 failures (origin / approver / decision-note)

`test/hr-ai/centralAssistant.route.test.js` was failing 14/14 at HEAD for three
fixture reasons that had nothing to do with authorisation — a missing required
`AccessDepartment.key`, an `Employee.gender` default that is not in its own enum,
and an unset `SALARY_ENCRYPTION_KEY`. Fixed in the fixture so the HR-AI
regression coverage this chunk depends on actually runs.

## Compatibility exceptions (all named, all tested)

`PLATFORM_ADMIN_FULL_HR`, `LEGACY_ROLE_TOKEN`, `HR_ROLES_UNCONFIGURED`,
`LEGACY_GLOBAL_HR_SCOPE`, plus eight endpoints left on their existing behaviour
(the C4 cron's shared-secret auth, the app-update endpoints, the face-engine
health check, the signed document download, the public ID-card page, the employee
app's own sign-in, the Supply Chain vendor router mounted under `/api/hr`, and
the CEO attendance-sync proxy that has been 404ing since it shipped). Each is
listed with its exit condition in `docs/decisions/hr-authorisation-contract.md` §6.

## Limitations

- Record scope inside HR is **global** — no HR schema carries a company, legal
  entity or factory, so none is claimed. A request that explicitly names one is
  refused (`HR_SCOPE_NOT_PROVABLE`) rather than answered across all of them.
  Chunk 2.
- The ~320 handlers still select their own fields. The guard's response scrub
  removes what the caller may not have on the way out — so the disclosure is
  closed — but the value is still LOADED and decrypted first. Teaching the
  employee, payslip and CEO routes to pass `.select(req.hrAuth.exclude)` is the
  cheap next step.
- An HR **editor** no longer sees compensation: under the role templates that
  starts at approver. Intended, and visible on the employee detail page's salary
  tab; the answer is an approver grant, not a code change. Nothing changes until
  the first HR role is assigned.
- `scope: "manager"` relies on the routers' existing check against the stored
  reporting rows, pinned against the real router by
  `test/hr-access/manager-scope.route.test.js`. Dated reporting relationships are
  Chunk 3.

## Watch at rollout

`resolveEmployeeDepartments` lets login fall back to matching an employee's
ORG-CHART department name when they hold no access grant. The contract
deliberately does not inherit that — it is the "organisation assignment is not
access" rule — so an account that reaches HR only through that fallback will now
be refused while still being able to sign in. The fix is one grant in
CEO -> Access Control, and the denial log line names the account.

## No data was migrated

No schema change, no backfill, no migration, no payroll/attendance/leave
calculation change, and no HR route handler was rewritten.

---

# CENTRAL COSTING LANE B — BOARD FINANCING POLICY: DONE (7 Sep 2026)

The first Board-owned policy vertical slice. `financing` is now the only cost
family in this lane whose operational input contract AND the company policy
behind it both exist.

**What was built:** an effective-dated, approved, versioned `BoardPolicy`
record (`DRAFT → BOARD_APPROVED → EFFECTIVE → SUPERSEDED`, the last two
derived); the financing methodology contract; a per-order calculation that
combines it with Sales' confirmed payment terms; `financingProvenance` frozen
onto every version; and the smallest Board policy screen.

**Correction, same day — the app boundary.** The screen shipped at
`/ceo/dashboard/policies/financing` and now lives at
**`/board/dashboard/policies/financing`**, in its own app with its own shell,
navigation and switcher tile. The first placement answered the wrong question:
the `ceo` grant was already the board-level boundary, so filing the screen
inside the CEO app meant nothing had to be seeded — a sound argument about
ACCESS that settled IDENTITY by accident.

**The app is Board; the access grant is still `ceo`**, and the split is three
constants (`guardSlug`, `BOARD_VIA_SLUG`, `BOARD_DEPT_SLUG`). The old address
redirects and renders no editor; the CEO nav entry went with the screen rather
than staying as a second way in. No backend, lifecycle, calculation or
provenance changed.

**What was retired:** `CostingPolicy.financingRatePercent` /
`financingBasis` are refused on write (`FINANCING_POLICY_MOVED`), no longer
raise a cost line, and stay readable so versions frozen under them remain
explicable. There was no financing control on `/costing/policy` to remove.

**Decision record:** `docs/decisions/board-policy-lifecycle.md`.
**Input map:** `docs/tasks/central-costing-lane-b-input-map.md` §25 (and §5.2,
now closed).

**Tests:** `test/costing/board-financing-policy.test.js` (22),
`test/costing/board-financing-costing.test.js` (23),
`components/board/financingPolicy.test.mjs` (22). Backend `test/costing`
1218/1219 (one pre-existing `sales-tenancy-guard` failure in `leads.js`,
`sampleBomApproval.js`, `leadContactPromotion.js`). Frontend `npm test`
3114/3117 (three pre-existing).

**Next Board migration:** overhead — see the input map's closing note. It is
the first policy that will land in the Board app rather than being moved into
it.

**The naming conflict is resolved.**
`docs/product/garment-manufacturer-app-architecture.md` had been rewritten
mid-task to rename app 1 from "Board & Executive" to "Management". On the
product owner's explicit decision the name is **Board & Executive**, and that
document has been reverted to it — every unrelated edit in that revision
preserved.

---

# IE — CHUNK 0 BOUNDARY AND SOURCE AUDIT (complete, 7 Sep 2026)

The IE department boundary is approved and the source audit is complete. The
next implementation scope is **Chunk 1A: read-only IE backend boundary**. It
must not change or migrate any live route, SAM, StockItem, WorkOrder, schedule,
barcode or costing record.

- Canonical scope: `docs/tasks/industrial-engineering-chunk-00.md`
- Audit: `docs/audits/industrial-engineering-chunk-00-boundary.md`
- Product plan: `docs/product/industrial-engineering-app-plan.md`
- Decision: `docs/decisions/architecture-decisions.md` — ADR-003

---

# CENTRAL COSTING LANE A — PACKAGING: CLOSED (acceptance passed, 7 Sep 2026)

Packaging is complete and verified end to end. No application code was changed
for this acceptance; one test assertion was added (below).

## The sixteen acceptance points, and what proves each

| # | Point | Proof |
|---|---|---|
| 1 | Merchandising selects a component | `rnd-technical-record` · merchandising packaging selection |
| 2 | A proposal does not become R&D work | `packaging-bom-link` · "a proposed selection… seeds nothing" |
| 3 | After approval the exact component reaches R&D | `packaging-bom-link` · seeding by `sourceSelectionRowId` |
| 4 | R&D records quantity/unit/basis/evidence/inclusion | `PATCH /:id/packaging-requirements/:rowId` tests |
| 5 | Merchandising sees only safe handoff status | `merchandisingHandoff` — all four states asserted |
| 6 | Merchandising never receives R&D data | route test asserts no `quantity\|unit\|evidence\|notes\|excludedReason\|carton\|SAMPLE_MEASURED` crosses back |
| 7 | Store is the only rate source | no supplier/rate/price field accepted, stored or rendered |
| 8 | Two rows on one Raw Item stay distinct | proved through approval, R&D entry and withdrawal |
| 9 | Withdrawal never deletes the R&D requirement | `WITHDRAWN_WITH_RND_RECORD` + retained measurement |
| 10 | Legacy R&D-only rows readable **and costable** | every costing fixture is selection-less — all 41 costing tests exercise it |
| 11 | All three bases | `PER_GARMENT`, `PER_CARTON`, `FIXED_PER_RUN` each tested |
| 12 | `PER_CARTON` uses the shipment fact with ceiling arithmetic | 500→20 cartons, 501→**21** |
| 13 | No packaging row stores carton capacity | asserted on the merge output and the cards |
| 14 | Frozen version retains amount **and provenance** | **assertion added this task** — see below |
| 15 | No Packaging screen links to `/costing` | asserted on both cards and both page sources |
| 16 | No Journey in Merchandising or Production responses | allowlisted boundary; `ownershipProofFor`'s `journeyRef` deliberately unread |

## The one gap found, and closed

Point 14 requires the frozen version to retain the packaging amount **and its
provenance**. The test asserted the amount, the per-scenario table, the carton
count and the behaviour — but not which quotation produced the rate. An amount
nobody can trace is a number, not evidence, and the moment it matters is
exactly when the supplier's offer has since been withdrawn.

The provenance was already being frozen correctly; only the assertion was
missing. `test/costing/costing-packaging-services.test.js` now also asserts
`offerId`, `supplierName`, `quotedAmountMinor` and `currency` survive on the
frozen version after the offer is withdrawn.

## Totals

- Backend Lane A: **151 passed** across 4 suites.
- Frontend Lane A: **87 passed** across 5 files.
- Whitespace clean in both repositories.

## Verified limitations, carried forward

1. **No live browser walkthrough.** The authenticated session expired and
   credentials were not used. Everything above is proved by API and component
   tests, not by driving the app.
2. **Two wider failures, neither Packaging.** `sales-tenancy-guard` (the
   long-standing `leads.js` offenders) and
   `source-app-requirements.route` · "Production's remaining blocker still
   names its missing form", which is Lane B's own outside-processes migration
   in flight. Both are outside Lane A and were left alone.
3. **Merchandising has no dedicated packaging picker endpoint** — the item
   search reuses the R&D style's raw-item search. It is company-scoped and
   returns no rate, so it is safe, but it is a shared read rather than a
   Merchandising-owned one.

## Next

Lane A Packaging is **closed**. The next Lane A work is whichever family the
input map nominates; nothing in Packaging is outstanding.

---

# CENTRAL COSTING LANE A — MERCHANDISING STYLE BOM ENTRY POINT (done, 7 Sep 2026)

## What this added

`Merchandising → Styles → Style BOM → Packaging`, using the existing
Merchandising shell. Packaging is one section of the BOM, not an application.

| Route | What it is |
|---|---|
| `/merchandiser/styles` | The company's styles, by identity, with packaging lifecycle counts |
| `/merchandiser/styles/[id]` | One style's BOM: Materials, **Packaging**, Development |

Materials and Development name themselves and say who owns them; only
Packaging is editable here, as scoped.

## Merchandising has no Journey — enforced, not just avoided

The ordinary style list populates `journeyId` and returns the journey's name,
so it is unusable here. A separate boundary was added:

- `GET /sample-styles/merchandising/styles`
- `GET /sample-styles/merchandising/styles/:id`

Both publish an **allowlist**: style id, reference, code, product name, variant
label, packaging lifecycle counts. `ownershipProofFor` returns `journeyRef` and
it is deliberately **not read** — publishing the proof would put the journey
back on screen through the back door.

Company scoping bounds the query by the company's own journeys and enquiries
(two indexed reads) and then proves each style individually, because a parent
whose company is unset proves nothing. The clause uses the named
`companyClause` form the tenancy guard recognises.

## A separate card, not the R&D one with fields hidden

`components/merchandiser/PackagingSelectionCard.js` offers exactly the four
things Merchandising owns: choose a component, say how it is packed, approve,
withdraw with a required reason. Rendering R&D's card with its consumption
editor hidden would leave those controls one CSS rule from being usable, and
would make one component keep two departments' rules straight. Only the shared
`SELECTION` lifecycle constant is reused.

An approved row shows **"Approved — awaiting R&D consumption"**. No supplier,
rate, amount, margin, carton capacity, or route to R&D or Costing.

## Next task

**Validate the complete Merchandising → R&D Packaging handoff through both
departmental screens.** Select and approve a component in
`/merchandiser/styles/[id]`, then confirm it appears in the R&D Packaging card
on `/research-development/styles/[id]` ready for consumption, and that a
withdrawal after R&D has measured leaves the measurement intact on both.

---

# CENTRAL COSTING LANE A — BOM → PACKAGING SECTION (done, 7 Sep 2026)

## What this added

The Packaging card on the existing R&D Style detail page
(`/research-development/styles/[id]`), between **Materials** and **History**.
No new route, no standalone packaging screen, no link to `/costing` — Costing
is an engine that reads these facts, not a place anybody is sent.

| Half | Owner | Controls on the card |
|---|---|---|
| Which components, packing instruction, approve, withdraw | Merchandising | item picker, specification, Approve, Withdraw (reason required) |
| Consumption, unit, basis, evidence, include/exclude | R&D | inline consumption editor |
| Rate, supplier, validity | Store | **nothing** — no field, no display |
| Carton capacity | R&D, on `sample.shipment` | read-only display, jump to the real editor |

Ownership is keyed off the session's real `deptSlug` (`merchandiser` vs
`rnd`), with admins seeing both halves. It is UX only — the server is the gate
on every packaging route.

## Two things worth recording

**A real Shipment editor exists** on this same page (`id="shipment"`,
`data-garments-per-carton`), inside the sample-submission block. The card
offers "Go to Shipment facts" only when that block is actually rendered;
otherwise it states the blocker and says where the value is recorded, rather
than offering a dead link.

**One backend route was added**: `PATCH /:id/packaging-requirements/:rowId`.
The only existing write path for `sample.packagingRequirements` is the whole
sample submission, which also moves the sample's status — editing a poly bag's
quantity must not send the sample to Sales as a side effect. It accepts only
R&D's own fields and rebuilds identity through the same merge the read uses.

## Next task

**Merchandising's own entry point.** The card is on the R&D page, which is
where R&D works; a merchandiser signing in to their own workspace has no route
to it. Either surface the same card in the Merchandiser's style view, or route
them to this page — a product decision, not an implementation one, and worth
settling before more packaging UI is written.

---

# CENTRAL COSTING LANE A — PACKAGING OWNERSHIP LINK (done, 7 Sep 2026)

## What this completed

The backend join between the two owned Packaging records. Packaging is part of
the Style BOM: one future BOM → Packaging section, two owners underneath.

| Record | Owner | Holds |
|---|---|---|
| `materials.packagingSelections[]` | Merchandising | item identity, approved specification, lifecycle. **No** quantity, rate, supplier or carton capacity |
| `sample.packagingRequirements[]` | R&D | consumption, unit, basis, evidence, include/exclude |
| `sample.shipment.garmentsPerCarton` | R&D | the style's ONE carton capacity, shared with Freight |
| Supplier quotation register | Store | rate, currency, validity, applicability |

`services/sales/packagingBom.service.js` joins them. It runs on **read and on
write**, and is idempotent by construction — a merge that appended per pass
would grow a duplicate requirement per page view.

**The join is by ROW, not by item.** Two legitimate selections may name the
same item — an inner bag and an outer bag — and joining on `rawItemId` would
collapse them into one requirement and lose a component. The link is the
selection's server-minted `rowId`, stamped onto the requirement via the new
`sourceSelectionRowId` field.

## Behaviour that is now guaranteed

- An **approved** selection produces exactly one requirement, with no
  consumption invented; repeated processing changes nothing.
- A **proposed** selection is shown and seeds nothing — asking R&D to measure
  a component nobody agreed to fills the record with rows that never ship.
- A **withdrawn** selection never deletes a requirement, a costing version or
  frozen evidence. The row is returned as withdrawn, with its reason.
- **R&D's figures survive** every re-merge; **identity and the approved
  specification are rebuilt** from the selection, so a submitted `rawItemId`
  naming another component contributes nothing.
- **Legacy** styles — requirements with no selection — stay readable and
  costable, labelled `LEGACY`. An unlinked row is **adopted once** by a
  matching approval and then carries the link. Nothing is backfilled.
- `PER_CARTON` still blocks truthfully without `sample.shipment.garmentsPerCarton`,
  and no carton capacity is ever copied onto a packaging row.

## Not changed

No Lane B file, no non-Packaging costing family, and no frontend. The frozen
per-scenario persistence work from the previous task was not touched.

## Next task

**Build the single BOM → Packaging UI section.** The backend read model is
ready: `GET /:id/packaging-selections` returns `selections`, the merged
`packaging` rows (each carrying its selection lifecycle and R&D's consumption),
a `readiness` gap list owned by desk, and the style's `shipment.garmentsPerCarton`.

One section, three states per row — Merchandising's choice, R&D's consumption,
Costing's read-only result. No rate, supplier or carton-capacity field belongs
on it, and the carton count is edited in the existing Shipment area only.

---

# CENTRAL COSTING — CHUNK 1: PACKAGING (audit + scope, 7 Sep 2026)

## The finding that changes the scope

**Packaging is already a fully source-backed costing family, working end to
end.** It was built alongside the technical-source contract and is live: the
Soumya Tshirt costing reports `packaging CALCULATED · ₹18.00 per unit` from a
real supplier quotation today.

What exists, verified in code:

| Layer | Where | State |
|---|---|---|
| Technical requirement | `SampleStyle.sample.packagingRequirements[]` | Built. `rowId` identity, `rawItemId` → **RawItem master** (no duplicate master), specification, quantity, unit, basis, evidence, `included`/`excludedReason` |
| Blockers | `technicalSource.packagingRow` / `packagingBlockers` | Built. Refuses no-item and no-quantity, names R&D. Missing is never read as zero |
| Costing line | `assembly.lineFromPackaging` | Built. `category: "PACKAGING"`, priced through the **same** supplier-quotation register as materials, per-scenario revalidated |
| Quotation choice | `offerApplicability` + `assembly` | Built. *"one applicable quotation is used and several is reported as a choice. Nothing is interpolated and no offer is preferred."* Variant-specific supersedes whole-item; two of a kind stay a genuine decision |
| Provenance / immutability | `CostingVersion` + `visibility` | Built. Frozen per version; later quotation changes do not touch it |
| Sales boundary | `visibility.js` | Built. Approved output is price bands only |

So most of what this chunk asks for is not missing. Re-implementing it would
create a second packaging path beside a working one, which is the specific
outcome the brief forbids.

## The three genuine gaps

**A · Ownership is not split.** Today one R&D-owned record holds *both* which
item and how much. The brief wants Merchandising to choose the components
(identity + specification, **no quantity**) and R&D to record consumption
against that approved selection. There is no merchandising packaging-requirement
concept anywhere today.

**B · `PER_CARTON` cannot be expressed.** The basis enum is
`PER_GARMENT | FIXED_PER_RUN`. `FIXED_PER_RUN` is a real and *different*
concept — bought once for the run and diluted across it, e.g. a shipping-mark
plate — and it does not scale. Neither value can say *"1 carton per 25
garments"*, which scales in steps. `PER_CARTON` is therefore **additive**;
`FIXED_PER_RUN` is not a synonym and is not being replaced.

**C · A third packaging concept exists, and I introduced it.** The R&D
technical record added on 7 Sep carries
`techSheet.technical.requirements[]` with `family: "PACKAGING"`. Nothing
consumes it — the costing reads `sample.packagingRequirements`. Two writable
records for one fact is a source-of-truth conflict and it is mine to resolve.

## Decision — the source-of-truth model

1. **`sample.packagingRequirements[]` remains the single technical record.**
   It is already wired to the costing end to end. Nothing is migrated and no
   stored row changes shape.

2. **Add a merchandising selection layer**: `materials.packagingSelections[]`
   on SampleStyle — item identity, name snapshot, optional specification,
   approval status. **No quantity, no rate, no supplier.** R&D's rows are
   seeded from it by identity, exactly as the material shortlist now works.

3. **`PER_CARTON` is added to the basis enum.** The conversion is **not** a
   new field: `sample.shipment.garmentsPerCarton` already exists, is
   R&D-recorded, carries the identical ceiling rule in its own comment
   (*"250 garments at 40 a carton is 7 cartons, and the seventh is charged in
   full"*), and has been read by the **freight** family since it was built.
   Repeating it on the packaging row would let one style hold two answers to
   one question — 25 to a carton for freight, 40 for packaging — with nobody
   ever told. The assembly reads the shipment and refuses the row when it is
   unset. Rounding is `ceil(scenarioQty / garmentsPerCarton)`.

   A carton line is priced as a `FIXED_PER_RUN` line with `amountByScenario`,
   which is the mechanism freight already uses for exactly this — a run total
   that steps with run size. No new engine behaviour is introduced.

4. **`family: "PACKAGING"` is removed from `technical.requirements`.** That
   field keeps `SERVICE` and `DEVELOPMENT_TOOLING` only, so packaging has
   exactly one writable home. This is the compatibility decision with the
   widest blast radius and is taken deliberately: the field shipped on 7 Sep,
   is not yet used by any live style, and nothing reads it for costing.

## Migration and compatibility

- **No backfill.** No packaging consumption or cost is guessed for any existing
  style. Rows already stored keep their `basis` and their figures.
- **Existing frozen versions are untouched.** The immutability guarantee is
  unchanged and is re-tested.
- A style with no merchandising selections falls back to whatever
  `sample.packagingRequirements` already holds — the same explicit-fallback
  pattern used for the material shortlist, and tested as such.
- `FIXED_PER_RUN` stays supported and stays distinct from `PER_CARTON`.

## Out of scope for this chunk

Outside Services, Freight, Customs, Financing, Overhead. Not started.

---

# WALKTHROUGH BLOCKERS (6 Sep 2026)

Five defects found during the live costing walkthrough, fixed at their own
ownership boundaries.

| # | Defect | Cause | Fix |
|---|---|---|---|
| 1 | Work order with `Operations: 0` accepted six scans and stayed at 0/6 | `createWorkOrdersAndProgress` read the route from `StockItem.operations` and created the order even when that was empty | Release refuses with `PRODUCTION_ROUTE_MISSING`, naming the product and the R&D action; production preview and save both refuse unrouted barcodes and write nothing |
| 2 | QC listed the order; piece lookup showed all 259 company operations | QC listed every non-cancelled order, and fell back to the operation master when the product had no route | Unrouted orders excluded in the query; the scope is now the **work order's frozen route**; the master fallback is replaced by a refusal with a remedy |
| 3 | New supplier shown as "Not yet owned" | **Not an ownership bug.** The record *was* owned; `publicSupplier`'s allowlist does not publish `companyId`, and the frontend inferred "legacy" from its absence | Frontend reads the published `legacy` flag; `tenantContext.stamp` additionally refuses an unresolved company or a legacy-scope write |
| 4 | Supplier detail page crashed | `<BankSection>` rendered, never imported | Imported the existing restricted panel; its capability checks untouched |
| 5 | Six orphan scans already written | — | `scripts/migrations/reconcile-walkthrough-2026-09-06.js`, dry-run by default, voids-then-removes exactly those six on exactly that order |

**No broad backfill.** The eighty legacy suppliers are untouched and stay
read-only. The walkthrough supplier needs no repair if the diagnosis above is
right — see the report.

---

# CENTRAL COSTING — MAKING THE PROCUREMENT HANDOFF OPERATIONAL (audit + scope)

## What already exists

| Question | Answer found in the code |
|---|---|
| What does `prepare()` do? | Reads `procurementProjection.projectFor`, attaches each requirement's request history from `SpendRequest.costingSource` + `items[].costingDemandSource`, marks `blocked` / `alreadyRequested` / `selectable`, and returns a `handoff` count of what pressing the button would create. Pure read. |
| What does `handoff()` do? | Wraps `createDrafts` in `idempotency.begin/complete/abandon` — replays an identical retry, conflicts a reused key with a different selection, and abandons on refusal so a failure never becomes a replayable success. |
| Are product, service and freight grouped correctly? | `procurementProjection.kindOf` returns `PHYSICAL`, `SERVICE` or `FREIGHT`. `createDrafts` splits on `kind === "PHYSICAL"`, so **freight joins the SERVICE draft** — correct, because freight is bought as a service and would otherwise reach Store as something to shelve. Worth stating explicitly; it was implicit in a `!==`. |
| At most one product and one service draft? | Yes. `plan` holds at most two entries, one per `requestType`; never one per supplier. |
| Is creation atomic? | **No.** It checks `unitOfWork.transactionsAvailable()` and refuses up front when two drafts are needed and transactions are unavailable — but the two `createSpendRequest` calls then run in sequence **outside any session**, so a failure on the second leaves the first written. The comment claims all-or-neither; the code does not deliver it. |
| Is creation idempotent? | Yes, through the shared idempotency record and its unique index. |
| Why does the source-boundary guard flag it? | `services/centralCosting/projectionHandoff.service.js` does `require(".../Requests/SpendRequest")` and both reads (`find`) and writes (`updateOne`) the model directly. The guard's rule is that Central Costing must not read downstream Requests records as a costing source — and owning the model is a stronger violation than reading it. |
| What is the canonical Requests boundary? | `services/spendRequestCreate.service.js` is the canonical **creation** service and is already used. There is **no** canonical read/attach service — the history read and the `costingSource` write were done against the model directly. |

## Bounded scope of this chunk

1. **Move the boundary, do not suppress the guard.** A new narrowly-scoped
   Requests-domain service owns the model and exposes only what Central Costing
   needs: create-draft-from-costing, and read-demand-for-a-costing-version.
2. **Make the two drafts genuinely atomic**, through the existing unit of work.
3. **Complete the visible workflow**: gate the action on the draft-request
   capability, ask for the two genuine request-level facts (purpose, required
   date with a reason when it differs), and refresh the projection afterwards
   so handed-off requirements are marked without a reload.

Out of scope, unchanged: submission, approval, budget commitment, MRF, purchase
or service orders, stock reservation, supplier contact.

## What was done

- **`services/requests/costingDemand.service.js`** — the Requests domain's own
  door. It owns `SpendRequest` and exposes exactly three operations:
  `demandForCostingVersion` (the review screen's history), `createDraftsFromCosting`
  (creation + provenance stamp, in one session), `requestsRaisedFromCosting`
  (the reconciliation read). No update, no submit, no approve, no delete, no
  general query. Central Costing no longer requires the model anywhere.
- **`services/storePurchase/orderActualsRead.service.js`** — the same treatment
  for `ServiceOrder`, which the reconciliation report read directly.
- **Atomicity made real.** Both drafts now write inside one `withTransaction`.
  Doing so surfaced a live defect: `SpendRequest`'s `pre("validate")` number
  generator read outside the session, so two requests created in one
  transaction computed the same `requestNumber` and the unique index rejected
  the second. It now reads in `this.$session()`, which is `null` outside a
  transaction — exactly the previous behaviour.
- **The visible workflow completed**: capability gate, a compact review over
  the projection asking only for purpose and required date (with a reason when
  it disagrees with Sales'), and a re-read afterwards so handed-off
  requirements come back marked.

---

# CENTRAL COSTING — FREIGHT AND LOGISTICS (scope + source audit, 6 Sep 2026)

## The accounting distinction this pass preserves

**Inbound procurement freight** — what it costs to bring fabric, trims and
packaging into our warehouse — belongs to the MATERIAL's landed acquisition
cost, not to a freight line. `PurchaseOrder.shippingCharges` and
`LandedCostAllocation` are records of what was ACTUALLY paid on a real receipt;
one historical PO's charge is not a forecast for an unrelated enquiry, and this
pass never reads either as one.

**Outbound finished-goods freight** — delivering the finished order to the
customer — is the family implemented here.

## Source audit, before editing

| Fact | Where it lives today | Verdict |
|---|---|---|
| `freightArrangement` | `Account.freightArrangement`, enum `prepaid / to_pay / ex_works / delivered` (`constants/crm.js`) | **Present, account level only.** No enquiry-level value exists — added by this pass, with the account as the fallback and the actual source frozen |
| Preferred freight mode | — | **Missing.** Added to the enquiry's freight terms; owner Sales |
| Incoterm | `Account.defaultIncoterm`, free text | **Present but unusable for calculation.** Recorded, never parsed |
| Shipping address | `CRMAddress` — `addressType: shipping`, `isPrimaryForType`, `accountId`. Scoped by account, not by company | **Present.** Billing and shipping are already separate records, so nothing has to assume they match — and this pass never substitutes one for the other |
| Company warehouse / dispatch origin | `Warehouse` — `companyId`, `name`, `shortName`, `addressDetail{line1,line2,city,state,postalCode,country}`, `status` | **Present** |
| Packed weight | — | **Missing everywhere.** No weight field on `SampleStyle`, `StockItem` or `RawItem`. Added to the sample's shipment facts in grams; owner R&D |
| Carton capacity / count | — | **Missing.** `sample.packagingRequirements[]` records that a carton is USED, never how many garments one holds. Added as garments-per-carton; owner R&D |
| Shipment / delivery schedule | — | **Missing.** `Enquiry.products[]` carries quantities and no delivery split. A multi-delivery requirement is therefore a Sales/Logistics decision, not a calculation |
| Freight-forwarder suppliers | `Vendor.vendorType` is a free string defaulting to "Raw Material Supplier" | **Unreliable as a filter.** A freight offer references a company-scoped active `Vendor` by id; its type is not used as a gate |
| Transporter quotations | — | **Missing entirely.** See the model decision below |
| GST treatment | `Account.gstTreatment` (customer registration); `CostingPolicy.inputGstTreatment` = `RECOVERABLE / NON_RECOVERABLE`, already used by material and service pricing | **Present.** Freight reuses the policy rule, so recoverable GST never becomes garment cost |
| PO shipping charges | `PurchaseOrder.shippingCharges` (Number) | **Present, and actual.** Never read as a forecast |
| Landed-cost allocations | `LandedCostAllocation` — company-scoped, per receipt movement | **Present, and actual.** Never read as a forecast |
| Material offer freight inclusion | — | **Missing.** `SupplierOffer` records no incoterm and no landed/ex-works statement, so nothing today can say whether a quoted material rate already contains inbound freight. Added as `freightTerms`; owner Store |

**Nothing is calculated that the codebase cannot source.** Distance, dimensional
weight, vehicle types, pallets and shipment consolidation have no factual
inputs here and are not implemented.

## Why a dedicated freight register

`ServiceSupplierOffer` identifies its subject by `serviceId` — one Service
master row. A freight rate is identified by a LANE: an origin, a destination or
zone, and a mode. Expressing that through the service register means encoding
"Ludhiana → Bengaluru, road" into a Service name, which makes the lane a
string nobody can query, scope or validate, and makes every lane a new master
record. It also has no place for a destination at all.

So: a dedicated company-scoped `FreightOffer` model and a Store/Purchase
register, following the same conventions as the two registers already there —
dated, referenced, revisioned, immutable once active, withdrawn rather than
deleted.

## Responsibility rules

| Arrangement | Company freight cost | Why |
|---|---|---|
| `ex_works` | **recorded zero**, with the arrangement frozen | The customer collects. A cost of nil that somebody decided is not a missing cost |
| `to_pay` | **recorded zero**, with the arrangement frozen | The customer pays the carrier directly |
| `delivered` | **calculated**; a valid quotation is required | The company bears it and it is inside the price |
| `prepaid` | **blocking commercial decision, owned by Sales** | See below |

`prepaid` is labelled "Prepaid (we pay)" while `delivered` is "Delivered
(included in price)". The codebase therefore says the company pays the carrier
and does NOT say whether it recovers that from the customer — and those two
readings differ by the whole freight amount in the garment cost. Nothing here
guesses: the costing blocks with a decision owned by Sales/Commercial, who
answer it per enquiry.

## Reopened: the backend contract corrected, and the three screens built

| Correction | State |
|---|---|
| Destination resolved through a company-owned Account (`shippingDestination.service`), applied at offer create, revise, applicable lookup and costing | done |
| `addressType: "shipping"` required; billing/office/registered refused, never converted | done |
| `prepaid + IN_PRICE` priced into the garment; `prepaid + RECOVERED_SEPARATELY` costed, frozen, held out of the price basis and carried to the approved output at cost | done |
| Multi-delivery: fixed, per-carton and any minimum charge all block; per-kg with no minimum permitted | done |
| `SupplierOffer.freightTerms` wired: landed passes, excluded and unanswered are blocking inbound gaps owned by Store | done |
| Store freight register (tab on the existing Supplier Quotations workspace) | done |
| Sales delivery terms on the enquiry stage | done |
| R&D shipment facts on the sample form | done |
| Costing shows the lane, the basis and the working read-only | done |

**Inbound freight is still unpriced, deliberately.** There is no inbound rate
register; the outbound one is a different lane and a different carrier, and
`PurchaseOrder.shippingCharges` / `LandedCostAllocation` are records of what was
actually paid on a real receipt. `EXCLUSIVE` and unanswered stay honest
blockers until an inbound source exists.

## What the first pass built

| Layer | State |
|---|---|
| `FreightOffer` model + Store register routes (`/api/cms/inventory/freight-offers`) | done |
| `freight.service` (arrangement, lane matching, three bases, minimum charge) | done |
| `freightSource.service` (company-scoped enquiry, address, warehouse reads) | done |
| Assembly `applyFreight`, per-scenario run totals, blocking gaps with owners | done |
| Engine `amountByScenario` for a run total that differs by run size | done |
| Frozen `freightProvenance` + visibility under the `cost` block | done |
| Coverage family `freight` → AUTOMATIC, recorded zero distinguished | done |
| Generic freight override and `does not apply` on `delivered` → refused | done |
| `Enquiry.freight` terms + PATCH validation; `sample.shipment` + submit capture | done |
| `SupplierOffer.freightTerms` (inbound landed/exclusive) recorded | done |
| Costing screen: read-only freight group with the lane and the working | done |
| **Store freight-register UI** | **not built** |
| **Sales enquiry delivery-terms form** | **not built** |
| **R&D packed-weight / carton inputs** | **not built** |

The three UI surfaces are the remaining work. Until they exist a freight
quotation can only be recorded through the API, so **this family is not
closed** — the same standard the development-charge chunk was held to.

---

# CENTRAL COSTING — DEVELOPMENT CHARGES, CONFIGURABLE (scope, 6 Sep 2026)

The model below is correct and unchanged. What was missing is the surface: the
engine read this table, R&D offered its charge types, and every costing needing
one said "the company has not configured any development charges" — because
there was nowhere for Finance to configure them. A rule nobody can edit is a
rule nobody has.

**The table is no longer one fixed amount per key.** A definition is:

- a **stable key**, minted server-side from the name on first save and
  permanent thereafter — never a business field, never editable, never removed;
- a label and optional description, both freely editable;
- `calculation`: `FLAT_PER_RUN` (one amount for the run) or
  `PER_REQUIREMENT_UNIT` (an amount per screen, plate or pattern);
- `unit`, required for `PER_REQUIREMENT_UNIT` and absent otherwise;
- `rates[]`: effective-dated `[from, to)` periods, in the company's **base
  currency only** while no FX source exists;
- `active` — deactivate, never delete.

R&D selects the definition by name and supplies a quantity only where the
calculation requires one; it never receives amounts or rate periods. The
costing resolves the applicable rate server-side at its own `asOf` and freezes
the provenance.

**This pass added:**

1. The **Development and tooling charges** editor inside the existing
   `/costing/policy` workspace — add a definition, choose its calculation, add
   and revise effective-dated periods, activate or deactivate. Amounts are
   typed in major units and converted exactly to minor units at the API
   boundary. "New rate from today" closes the open period and opens the next on
   the same day, which is the revision every company actually makes.
2. **Permanent keys enforced server-side.** A key missing from a submitted
   table — dropped, renamed, or cleared with the whole list — is refused with
   `DEVELOPMENT_CHARGE_KEY_REMOVED` (409) and told to deactivate instead.
   A stale revision is now diagnosed before the table is validated, so a lost
   race reads as a lost race.

Freight and customs duty remain the only two families with no source.

---

# CENTRAL COSTING — DEVELOPMENT CHARGES, REOPENED (scope, 6 Sep 2026)

Two accounting defects in the INTERNAL charge table. The source-driven
architecture below is unchanged; what follows corrects how the company's own
charges are stored and calculated.

**1 · Effective dating was not effective dating.** One amount per key, replaced
on update. September's rate ceased to exist when October's was published, so a
September costing could not be recalculated at its own figure. A definition now
holds a LIST of half-open `[from, to)` rate periods; overlaps, missing starts
and non-final open-ended periods are refused where the table is written; exactly
one period is resolved at the costing's `asOf`, and zero or several both block.

**2 · Every charge was flat.** Screen making is ₹2,000 a screen. A definition
now declares `calculation` — `FLAT_PER_RUN` (the amount IS the charge, no
quantity asked) or `PER_REQUIREMENT_UNIT` (a configured unit, R&D enters a
count, total is quantity × rate). Both produce a `FIXED_SETUP` line whose total
is constant across garment quantities and whose per-garment share dilutes.

**Plus one identity defect found on the way:** a line key derived from the
charge key made two requirements using one charge type a single line. Each
requirement row now carries a server-minted `rowId`, preserved across edits, and
the line key is built from it.

Rates are in the company's base currency only, while no FX source exists.
Existing flat configuration is adapted into one rate period, never discarded.

---

# CENTRAL COSTING — DEVELOPMENT, PATTERN, TOOLING AND SETUP (scope, 6 Sep 2026)

The `development` / `FIXED_SETUP` family is the last of the three that still
reports AWAITING_SOURCE with "enter a provisional override". This closes it
without asking anybody to type an amount into the costing editor.

## What the audit found before implementing

| Question | Answer in the repository today |
|---|---|
| Does anything record that a style needs pattern or tooling work? | **No.** `sample.serviceRequirements[]` records outside PROCESSES; nothing distinguishes recurring work from one-time setup. |
| Can a service quotation price a fixed charge? | **Yes, already.** `ServiceSupplierOffer` + `servicePricing.resolveServiceRate` handle `basis: "FIXED_PER_RUN"` and return `fixedAmountMinor`. |
| Does the engine dilute a fixed line? | **Yes, already.** `runScenario` adds `line.fixedMinor` whole to the run and divides by `Q` for the per-unit figure. Nothing multiplies it. |
| Is there a company-level place for internal charges? | **No.** `CostingPolicy` carries rate/basis rules only — a percentage of a subtotal, which a flat pattern charge is not. |

Two of the four are already true, which is why this chunk is bounded: what is
missing is the **classification** on the requirement and the **internal**
source.

## Source model

Two authoritative paths, and no third.

**1 · Externally purchased setup work.** The existing Service Master and
`ServiceSupplierOffer` register, unchanged. `sample.serviceRequirements[]`
gains a `purpose`:

- `OUTSIDE_PROCESS` — recurring production work → costed as `SERVICE`.
- `DEVELOPMENT_TOOLING` — one-time setup → costed as `FIXED_SETUP`, basis
  forced to `FIXED_PER_RUN`.

Existing rows have no `purpose` and read as `OUTSIDE_PROCESS`, which is what
they are. No price is entered in R&D or in Costing.

**2 · Internally performed standard development.** Pattern and marker
development normally have no supplier. `CostingPolicy` gains
`developmentCharges[]`. No defaults and no hardcoded amounts: a company that
has configured none gets a BLOCKING gap owned by Finance, not a guess.

*(This paragraph described one named fixed amount per entry, which is what the
first cut stored. The implemented contract is below — the entry is a charge
DEFINITION with a history of rates, not an amount.)*

Each definition, as implemented:

| Part | Contract |
|---|---|
| `key` | minted server-side from the name on first save, then **permanent**. Never a business field, never editable, never removed from the table |
| `label`, `description` | freely editable; renaming orphans nothing, because requirements point at the key |
| `calculation` | `FLAT_PER_RUN` — one amount for the whole run — or `PER_REQUIREMENT_UNIT` — an amount per screen, plate or pattern |
| `unit` | required for `PER_REQUIREMENT_UNIT`, absent otherwise |
| `rates[]` | effective-dated periods, `[effectiveFrom, effectiveTo)`. Non-overlapping, each with a start, only the last open-ended |
| currency | the company's **base currency only**, while no FX source exists |
| `active` | **deactivate rather than delete** — a charge named by a frozen costing stays readable for ever |

R&D picks a configured charge definition by NAME, supplies a quantity only when
the calculation is `PER_REQUIREMENT_UNIT`, and never sees an amount or a rate
period. Costing resolves the ONE period in force at the version's own `asOf`,
computes the run total (the amount, or quantity × unit amount) and freezes the
provenance — key, label, calculation, unit, quantity, unit amount, total,
currency, the selected period's start and end, policy revision, `asOf`, the
requirement row identity and the technical evidence. **A later rate period, a
rename or a deactivation never changes a frozen version.**

## What is deliberately not built

- No separate app. The charge table lives in the existing Costing Policy
  workspace until the Board app exists.
- No override path presented as the normal answer for this family. "Does not
  apply", with a reason, stays.
- No third source. A requirement is external or internal, never both.

## Verification

External pattern setup priced from its quotation; internal marker development
from the effective policy entry; ₹10,000 staying ₹10,000 at 100/500/1,000
while the per-garment figure falls 100 → 20 → 10; several quotations still a
decision; missing policy blocking; both sources on one requirement refused;
foreign and inactive refused; frozen versions unmoved by later changes; no
editable money field in either screen; and existing outside-process rows still
recurring `SERVICE` costs.

---

> ## PROSPECTS — COMPLETE (5 Sep 2026)
>
> A Prospect is a possible customer Sales is contacting to determine whether
> genuine interest exists. It is not commercially qualified, and the workspace
> no longer asks it to qualify itself: no quantities, budgets, delivery dates,
> revenue estimates, evidence scores or detailed requirements are collected
> before conversion. Nothing was deleted — every removed field still exists on
> the model, still holds its values, and still gates an ACTIVE Lead.
>
> **The workflow.** Capture → outreach (call, email, WhatsApp, note, next
> action) → the customer engages → confirm what they did that showed interest →
> convert. One record throughout: a Prospect IS a Lead with
> `captureStatus:"draft"`, so nothing migrates at conversion.
>
> **Conversion requires a genuine successful interaction.** The bar is a
> completed outreach Activity whose outcome is in `SUCCESSFUL_CONTACT_OUTCOMES`
> (`replied_connected`, `meeting_completed`). A `no_answer` call, a completed
> activity with no outcome, an outgoing email or WhatsApp nobody replied to, a
> note and a planned activity all fail it. `hasSuccessfulInteraction` is the one
> fact behind the work state, `readyToConfirm` and the conversion endpoint, so a
> card can never say "Ready to convert" on a Prospect the endpoint would refuse.
> Fixtures that claimed an interaction nobody had were corrected; the rule was
> not weakened to preserve them.
>
> **The queue is derived, never moved by hand.** New (no completed attempt) →
> Contacting (attempted, not answered) → Follow-up (answered, prerequisites
> incomplete) → Ready to convert (every pre-confirmation requirement met),
> computed in ONE aggregate per page. Archived/rejected records are not fetched
> into it at all; submitted legacy records stay in the manager-only Awaiting
> Review scope and the old review routes are untouched.
>
> **The form** asks five questions in the order the work happens: who are they,
> how should we contact them, how did we find them, what might they need, and
> how is this filed. Question-style labels, a visible explanation, a real
> example, and an `Optional` marker on everything that is optional — only the
> six genuine prerequisites carry "Needed before converting". One surface, two
> columns on desktop, no cards inside cards. The rail shows a compact "Before
> converting" summary of what is MISSING, never the interest signal and note
> (they belong to the conversion dialog, and listing them there is what
> deadlocked the screen once).
>
> **New model fields**, all optional, all tenant-scoped, none of them a gate:
> `businessType`, `preferredContactMethod`, `bestContactTime`, `contactTimeNote`,
> `preferredLanguage`, `productInterests[]`, plus the existing `state` and
> `country`. Controlled enums where the options are fixed; arrays sanitized and
> de-duplicated; all in the editable allowlist and all clearable. They survive
> conversion untouched and stay editable on the Lead — the Lead edit surfaces
> render the same section components.
>
> `/approve` was NOT changed. Its source records that HOD-only gating was
> removed at the CEO's explicit request; the failing HOD-only test is stale
> against that decision, not evidence of a hole.
>
> Scope held: Lead stages, qualification transitions, Sales Journey, Order Book,
> navigation, and the in-flight Costing, Store, Accountant and company-scoping
> work are all untouched. Lead-stage work has not been started.
>
> **Prospect Contacts, Chunk 3 — contact-specific outreach (5 Sep 2026).**
>
> **ACTIVITY IDENTITY.** `Activity.leadContactId` is an EMBEDDED contact's
> `_id` — never a CRMContact, and never written into `contactId`, where it
> would be a broken ref that populate() resolves to null. It is valid only on a
> Lead-owned Activity, resolved against that Lead's own contacts, and a foreign
> or unknown id is refused rather than dropped. `contactName` is derived from
> the match, never trusted from the client: a name contradicting the id sent
> with it is stale or wrong. Absent is legitimate — legacy history has none,
> and a general note is about the record. Indexed `{leadId, leadContactId,
> activityDate}` for the per-contact summary and the referenced-contact check.
>
> **ONE NEXT ACTION, WITH AN OPTIONAL TARGET.** `pendingFirstAction.leadContactId`,
> validated against the same Lead. Deliberately NOT a follow-up schedule per
> person: a Prospect has one thing to do next, and giving each contact their own
> would turn a work queue into four. Conversion re-resolves the target onto the
> first follow-up Activity, inside the existing create-then-flip-then-rollback
> order.
>
> **AMBIGUITY IS NOT GUESSED, AND IS IDENTITY-SPECIFIC.** Auto-sync attributes
> evidence to a contact only when exactly ONE of them owns that number or
> address — calls on `phoneNumber`, WhatsApp on the conversation's `waId`,
> email on the customer side of the exchange (sender when inbound, recipients
> when outbound, connected mailbox excluded).
>
> Ambiguity is tracked per IDENTITY, not per person: a contact with a shared
> `purchasing@` mailbox and their own direct line is ambiguous on the mailbox
> and unique on the line, and a shared email must not suppress their unique
> phone call.
>
> Two outcomes, and they differ:
>
> - **ambiguous only INSIDE this Lead** — two of our own people on one desk
>   line — is unattributable but still ours, so the Activity is logged at Lead
>   level;
> - **an identity that also exists on ANOTHER Lead** causes the event to be
>   **skipped entirely**. Dropping only the attribution was never enough:
>   the event might be the other customer's, and copying it here duplicates
>   potentially private correspondence onto a record it may have nothing to do
>   with.
>
> Matching stays company-scoped, and fails closed when uniqueness cannot be
> established.
>
> **DE-DUPLICATION IS PER CONTACT, AND THE BUCKETS DO NOT MIX.** The ten-minute
> window used to be per CHANNEL, so ringing the merchandiser and then the
> purchase manager about the same order silently dropped the second call.
> Logged times are partitioned by type AND contact — contact A against A, B
> against B, unattributed against unattributed.
>
> An earlier version folded unattributed Activities into every contact's
> bucket, on the reasoning that an event logged before it could be attributed
> is the same event. That reasoning needs a way to RECOGNISE the event, and
> `Activity` stores no source identity — so the only thing compared is a
> timestamp, which cannot tell "the same call, now attributed" from "a
> different call to a different person three minutes later". Mixing them
> recreated the original defect exactly.
>
> **Known limitation:** an event logged at Lead level and later seen again with
> a contact resolved WILL be logged a second time. A visible, correctable
> duplicate is the better failure than silently missing calls, and it stops
> being possible once source event IDs are stored — which is deliberately not
> this work.
>
> **EVERY CONVERSION PATH CARRIES THE TARGET.** Both the direct
> `convert-to-active` and the retained `/approve` re-resolve
> `pendingFirstAction.leadContactId` onto the first follow-up Activity, inside
> the existing create-then-flip-then-rollback order.
>
> **A REMINDER CAN BE RE-AIMED.** `PATCH /:id/activities/:activityId` validates
> and updates `leadContactId`, deriving `contactName` from it; `null` clears
> both, so no reminder is left labelled with somebody it is no longer for.
>
> **DUPLICATE DETECTION SEES EVERY PERSON, AND SAYS WHICH ONE.** The old check
> read the Lead's top-level identity, which is the PRIMARY contact's mirror — so
> on a Prospect with four people, three were checked against nothing. Every
> embedded contact now participates (email, phone, WhatsApp; derived fields
> where they exist, a digit-tolerant fallback for rows saved before those
> fields did), against other Leads' top-level identity AND their embedded
> contacts, promoted CRMContacts under Accounts, and Accounts' own primary
> fields.
>
> A result names WHICH of our people matched, WHICH record and contact it
> matched, and on WHICH identity — "Anita Rao's phone matches LEAD-2026-0041",
> never an anonymous "this record may be a duplicate", because the anonymous
> version can only be resolved by opening every candidate and comparing by eye.
>
> Excluded: the current Lead, records outside the caller's company (answering
> across that boundary would disclose that another company holds a customer
> with this number — the answer IS the leak), inactive Leads, archived or
> inactive Contacts, and any CRMContact this Prospect itself was promoted into.
> A name on its own is never a match: two people called Ramesh Sharma is a
> Tuesday, and crying wolf teaches people to click past the alert that matters.
>
> **THREE QUERIES, WHATEVER THE CONTACT COUNT.** Identities are collected
> across all contacts and issued as one `$or` per collection. Eight people cost
> three queries, not twenty-four.
>
> **A PERSON IS NOT A CUSTOMER RECORD.** A CRMContact match is reported as its
> PARENT ACCOUNT — `recordType: "account"`, the Account's `_id`, reference and
> name — with the person carried as `matchedContactId`/`matchedContactName`/
> `matchedContactReference`. The duplicate workflow links a Prospect to a
> surviving Lead or Account; returning a contact id under an Account href was a
> contract that disagreed with itself, and every consumer guessed differently
> (one opened `/leads/<contactId>`). Parent Accounts are fetched in a fourth
> bounded batch — four fixed queries, because a self-consistent contract beats
> the smaller number. An Account matched through BOTH its primary fields and
> one of its contacts is one result per (Account × our contact), keeping every
> reason and the matched person.
>
> **ONE CONTRACT.** Quick Capture, readiness, the Contacts panel and the Lead's
> duplicate picker read the same row shape (`recordType` — only ever `lead` or
> `account`, `recordId`, `reference`, `recordName`, our
> `contactId`/`contactName`, their `matchedContactId`/`matchedContactName`/
> `matchedContactReference`, `matchedOn`, `confidence`, `href`).
> `contactId: null` is meaningful, not missing: it marks a record-level match
> such as a company name, which no individual person owns. The legacy
> `leadMatches`/`accountMatches` arrays are returned unchanged alongside it —
> the auto-sync ambiguity checks read their string `matchedOn` and were not
> migrated.
>
> **THE SERVER OWNS THE DESTINATION.** `href` is computed once by a single
> `leadHref` helper used by BOTH the contact-aware and the record-level paths:
> a still-draft Lead routes to `/prospects/<id>`, an active one to
> `/leads/<id>`, a person to their Account. `findLeadDuplicates` returns
> `captureStatus` so the record-level path can tell those apart — it used to
> hardcode the Lead route, so a Prospect matched on company name alone opened
> a Lead screen. No consumer rebuilds a route from `recordType`.
>
> **A REASON NAMES THE FIELD IT CAME FROM.** Matching stays broad — their
> landline may be the number we hold as somebody's WhatsApp, and that is a real
> match — but the reason is labelled for THEIR source field: phone/mobile/
> alternate and an Account's `primaryPhone` report `phone`, WhatsApp fields
> report `whatsapp`. Both reasons appear only when both of their fields hold
> the number. Previously every number was checked against both channels and
> labelled by whichever of OUR fields held it, so an Account's primaryPhone
> could be reported as a WhatsApp match — a claim the record cannot support.
>
> **HIDING A ROW IS NOT A SAVED REVIEW.** Rows disappear for good only after
> the server accepts the review; a failure restores them with an inline error,
> and a second click while saving sends nothing. Dismissing the LAST remaining
> row records the review — previously the panel just returned `null`, so the
> warning vanished while the checklist still asked for a review nobody could
> give. Partial dismissals stay session-local. Groups are keyed by contact key,
> never by name: two people called Ramesh Sharma are ordinary.
>
> **THE WARNING IS NOT A CONTACT LIST.** `matchedOn` leaves the server as
> `{kind, label, masked}` — "phone", and a `…0404` tail or `b…@lakeview.com`,
> enough to tell two of a person's numbers apart. Raw numbers and addresses
> stay internal to matching: a duplicate check is reachable for any Prospect
> and would otherwise return identities belonging to records the caller may not
> be entitled to read in full.
>
> **ONE REVIEW PANEL.** The full panel renders once, under the Contacts it is
> about. The Prospect sidebar shows a count and a button that opens that tab —
> it holds no dismissal state of its own. Two live panels meant two independent
> decision states: hiding a row in one left it warning in the other.
>
> **Known limitation — a contact with no reachable Account is not reported.**
> If a matching CRMContact has no `accountId`, or its Account is inactive or
> belongs to another company, there is no customer record a Prospect could be
> linked to, so the row is skipped rather than returned as something nobody can
> act on. The person is still found the moment their Account is reachable.
>
> **Known limitation — one timestamp cannot hold per-result verdicts.** The
> record carries a single `duplicateReviewedAt`. It can record that somebody
> reviewed this identity data; it cannot record "Anita is a genuine second
> contact, but Ramesh really is our existing customer". So the panel's per-row
> decisions are session-local, only "none of these" stamps the record, and any
> identity change (including adding or editing a contact) retires the stamp
> server-side. Per-result decisions need per-result storage, which is
> deliberately not this work.
>
> **IT WARNS, IT NEVER ACTS.** No auto-merge, no overwrite, no CRMContact
> created for an unconverted Prospect, and conversion is never gated on a
> duplicate. Declaring a record a duplicate stays the explicit terminal outcome
> it already was.
>
> **CONTACTS ARE THE BUYER AUTHORITY.** Lead form redesign, chunk 1.
> `decisionMakerName` / `decisionMakerRole` are gone from the form. Readiness
> reads contacts: at least one person flagged `isDecisionMaker` or carrying the
> canonical `decision_maker` role, named, and still contactable — somebody who
> has left, is blocked, archived or marked do-not-contact cannot approve an
> order. A committee is normal, so it asks for AT LEAST one, never exactly one.
> The legacy fields are a FALLBACK, not an alternative: they answer only for
> records with no embedded contacts at all. Historical values are untouched and
> nothing is migrated. The check's label — "Someone in Contacts marked as a
> decision-maker" — names where the answer is given, because the checklist is
> also the navigation.
>
> **PROSPECT INFORMATION IS CONTEXT, NOT A SECOND FORM.** "Who they are",
> "Organisation research" and "Prospect background" were editable on the Active
> Lead form and every field in them was settled during prospecting — three
> sections of blank-looking questions somebody had already answered, and a
> second place to change facts the Prospect owns. They are replaced by a
> read-only `CarriedForward` strip. No data moved; the values are still
> Prospect-editable.
>
> **THE PROJECTIONS ARE DERIVED SERVER-SIDE.** `productInterest[]` and
> `estimatedQuantity` were computed in the browser and PATCHed alongside the
> rows they were computed from. Two writers of one fact eventually disagree,
> and the readiness gate reads the projections — so a stale total could qualify
> a Lead whose lines said otherwise. A Lead pre-save hook derives both from
> `requirementItems`, and only when that array is touched: rebuilding from an
> empty array would erase a legacy record's real values.
>
> **ONE DELIVERY ANSWER, TWO WAYS TO GIVE IT.** `requirementDate` for a firm
> date, the existing `deliveryTimeline` for a window in the customer's own
> words. No new field for the same question. New: `requirementUseCase` (the
> programme behind the order), `requirementItems[].unit`, `budgetStatus` (a
> state, not a figure) and `keyObjection`. The free-text `budget` survives as
> optional detail — existing values stay visible and editable, unreinterpreted.
>
> **EVIDENCE COUNTS WHEREVER IT WAS TYPED.** A researched-or-higher estimate
> still needs support; it may now come from the estimate's inline source OR an
> Evidence entry tied to that estimate's own claim. Unrelated evidence never
> counts, and an evidence row with no reference of any kind proves nothing.
> `estimatedUnitPrice` has no claim code in the evidence vocabulary, so its
> inline source remains its only support.
>
> > **PROMOTION HAPPENS AT THE ACCOUNT, AND PROMOTES EVERYBODY.** Chunk 5.
> `services/leadContactPromotion.js` is the one path, shared by
> `POST /leads/:id/account` and Sales Journey's `sourceLeadId` bridge. Journey
> used to seed exactly ONE contact ("decision-maker, else the first one") and
> only when the Account had none; customer setup created an Account with nobody
> on it at all. Both now promote every named embedded contact. Nothing is
> promoted at Prospect → Lead conversion — there is no customer to attach
> anyone to yet.
>
> Resolution order per contact: a `promotedContactId` that really belongs to
> this Account → a unique exact normalized email inside it → a unique exact
> normalized phone or WhatsApp inside it → create. **Name is never a match**,
> and ambiguity is never guessed: two CRM Contacts matching one person, or two
> Lead contacts matching one CRM Contact, refuse the whole promotion with a
> conflict naming both sides. A `promotedContactId` pointing outside this
> Account or company is refused, not quietly re-pointed.
>
> An existing contact is authoritative about itself: only genuinely empty
> fields are filled, roles are unioned, and status, ownership, assignment and
> the primary flag are untouched. Mapping is lossless where the CRM has a home
> for it — name, job title (free-text `role` as the fallback), department,
> roleCode plus `isDecisionMaker` as the `decision_maker` ROLE, email, phone,
> WhatsApp, preferred channel (and the older `preferredContact` where it maps —
> `portal`/`none` have no equivalent and are left unset), preferred language,
> status, notes, and `linkedLeads`.
>
> **PRIMARY:** an Account's existing active primary wins and is never demoted;
> only if it has none does the Lead's active primary take the role; somebody
> departed, blocked or archived never does; the Account never ends with two.
>
> **IDEMPOTENT AND ALL-OR-NOTHING.** Re-running creates nothing, and a Lead
> already linked to an Account still reconciles people added later rather than
> returning early. Every match is resolved before anything is written. There is
> no transaction to rely on (the deployment is not guaranteed to be a replica
> set — see the Store & Purchase unit-of-work for why), so a failure
> compensates: created contacts deleted, filled fields and roles restored,
> `updatedBy` restored, the `linkedLeads` entry pulled (only when promotion
> added it — a Lead already listed there was somebody else's link), and every
> `promotedContactId` put back on the Lead. `$unset` is used for fields that
> were previously absent, because `$set: undefined` is silently dropped and
> would leave the write in place.
>
> **COMPENSATION IS A SCALPEL, NOT A SAVE.** `undo()` never calls
> `lead.save()`. That document was loaded before promotion and carries the
> whole record; `markModified("contacts")` makes Mongoose rewrite the ENTIRE
> array from that stale copy, so a losing request's rollback deleted people a
> concurrent request had added and reverted contact edits it had made. Instead
> it issues one targeted `updateOne` with `arrayFilters`, addressing each
> embedded contact by its stable `_id` and matching only while
> `promotedContactId` is STILL the value this promotion wrote. Anything newer
> stands; a second call matches nothing, which is what makes `undo()`
> idempotent. Account setup's rollback follows the same rule: the
> `lead.accountId` restore is a conditional `updateOne`, not a save.
>
> **THE JOURNEY COMMIT BOUNDARY.** The core operation is the promoted
> contacts, the Journey, its optional first Activity and the Lead's conversion.
> It COMMITS when the conditional Lead flip succeeds — or, with no source Lead,
> once the Journey and its audit entry are written. Before that point any
> failure undoes all of it through one `compensate()` that grows as the
> operation does. After it, nothing is reversed: the Lead's audit entry and the
> response reload become warnings on a successful Journey, following the policy
> this route already applied to the optional first action. Partial rollback was
> the bug — the outer catch undid only the promotion and left a Journey and a
> converted Lead pointing at contacts that no longer existed.
>
> **`doNotContact` IS NOT A STATUS.** It is a separate boolean on CRMContact, so
> a contact can be `status: "active"`, `isActive: true` and still be suppressed.
> Checking status alone let those through while looking as though the question
> had been asked. `isUsableContact` and the promotion's primary rule both test
> it, and the Account-primary fallback query filters on it. Better no primary
> than a suppressed one.
>
> **THE CALLER GETS THE COMPENSATION BACK.** `promoteLeadContacts` returns
> `{ summary, undo }`. Promotion is rarely a request's last act: Sales Journey
> promotes and then inserts a Journey, flips the Lead and writes an audit
> entry. Every failure after promotion — the lost conversion race, the Journey
> insert, the audit — calls `undo()`. Deleting only the contacts it had
> CREATED (all the old rollback did) left fills, `linkedLeads` and every
> `promotedContactId` behind, so a Lead believed its people were promoted for a
> conversion that never happened.
>
> **A REFUSAL IS NOT A SUCCESS.** A promotion conflict returns **409** with
> `code: "contact_promotion_conflict"` and structured `conflicts`. It used to
> return `success: true` with a count, so the screen linked the customer and
> showed a mild note — while the people it was about had not been promoted and
> no screen exists for doing it by hand. An existing Account is preserved
> untouched; a newly created one is deleted and `lead.accountId` restored.
>
> **A HALF-SET-UP CUSTOMER IS WORSE THAN NONE.** `POST /leads/:id/account`
> wrote the Account and the Lead's link BEFORE promotion, so any later failure
> left a customer record whose people never arrived and no way back. Account
> creation, the link, promotion, the `Account.primaryContact` write and the
> audit entry now roll back together. The refreshed Account is returned, not
> the stale pre-update document, and the primary is persisted on BOTH the
> new-Account and the reconciliation path — the latter never wrote it at all.
>
> **ARCHIVED IS NOT ABSENT.** Contacts under the Account are loaded regardless
> of `isActive`. A `promotedContactId` pointing at an archived contact under
> THIS Account is `inactive_link`, not `foreign_link`; an identity matching an
> archived contact is `inactive_match` rather than a silent second record
> carrying the same email or number. Both ask for reactivation: reusing an
> archived contact would resurrect a record somebody deliberately removed.
>
> **A JOURNEY PRIMARY MUST BE REACHABLE.** An explicitly chosen contact — and
> the Account-primary fallback — must belong to the Account and company, be
> active, and carry a contactable status. Present is not usable.
>
> **Known limitation:** Lead activities are NOT migrated. They stay Lead-owned
> with their `leadContactId`; `promotedContactId` is the bridge to the CRM
> Contact. A multi-contact Lead typed `individual` cannot be promoted — the
> Lead's own one-contact invariant refuses the re-save — which is unreachable
> through the API and only affects fixtures or legacy rows.
>
> **HISTORY OUTLIVES THE PERSON.** A contact referenced by any Activity, or by
> the current next action, cannot be removed — the server says to mark them Left
> organisation or Do not contact instead. Somebody who has left is a fact about
> the relationship, not a row to tidy away.
>
> **OUTREACH AIMS AT A PERSON.** One `ContactTarget` selector, shared by the
> Prospect dock and the Active Lead's. Defaults to the active primary and
> selects NOBODY when that is unavailable. Each channel uses that person's own
> route; WhatsApp reads the `whatsapp` field only and never substitutes the
> phone. `do_not_contact` and `left_organization` block outbound channels with
> a visible reason while other contacts stay available; notes are exempt. The
> selection is workspace state, never stored on the Lead. Evidence is ONE fetch
> per Lead, filtered to the selected person. A record with no `contacts[]` keeps
> its previous behaviour off the mirrored top-level routes.
>
> Evidence is filtered on all three channels — calls by number, WhatsApp by the
> conversation's `waId`, email by parsed addresses with the rest of the mailbox
> state (loading, connected, reason, error) preserved.
>
> **LEGACY IS A STATED CASE, NOT AN INFERENCE.** `channelBlocked` takes
> `hasContacts`: a record with no stored contacts uses its own top-level routes
> and writes `contactName` with no `leadContactId`; a record that HAS people
> must have one chosen, because falling back to the mirror would dial whoever
> happens to be mirrored.
>
> **THREE TARGET STATES.** `null` (nothing chosen → the active primary),
> `GENERAL_TARGET` (deliberately about the record) and an id. General is a real
> choice: saving it sends `leadContactId: null`, which clears both the id and
> the derived name, rather than leaving a reminder aimed at whoever it used to
> be for. Call, Email and WhatsApp still require a contact with that channel.
>
> **DE-DUPLICATION IS PER PERSON ON BOTH SIDES.** The server partitions logged
> times by type AND contact; the Quick controls' "already logged" marks now do
> the same, so a call to one contact no longer hides another contact's call
> minutes later. An unattributed Activity is added to each contact's times (it
> may be that same event, imported before it could be attributed) but never
> stands in for them. There is no stable external event id on `Activity` — the
> models expose none — so this stays a time window.
>
> **CROSS-RECORD SAFETY COVERS SECONDARY CONTACTS.** `ambiguousContactIdentities`
> checks each embedded contact's normalised phone, WhatsApp and email against
> every other Lead in the company scope. A shared identity is skipped for
> automatic attribution — the evidence is still logged at Lead level, and can
> always be logged by hand. This is the auto-sync safety check only; duplicate
> management is its own chunk.
>
> **NOT WIRED, AND SAID SO:** Notes remain paused on the Active Lead dock
> (`UnderConstruction`), so `ActivityComposer` runs there only for other action
> codes. The Prospect dock's Note is live.
>
> ---
>
> **Prospect Contacts, Chunk 2 — the Contacts UI (5 Sep 2026).**
>
> `ProspectContactsSection` is the ONLY editor for `contacts[]`, on the Prospect
> form and on both Lead edit surfaces. `WhoTheyAreSection` is organisation-only;
> `ContactSection` and the old `ContactsSection` have no render call sites (both
> are still exported, nothing calls them). Stored top-level person fields and
> their mirroring are untouched.
>
> **The contact save contract.** Contacts do not auto-save: a half-typed person
> would post with no name and be refused while somebody was still typing. Each
> surface passes a dedicated `saveContacts` that RETURNS the updated Lead and
> RETHROWS on failure — deliberately separate from `saveSection`, whose
> debounced writes must keep swallowing their own errors or every auto-save
> would leave an unhandled rejection.
>
> `commitContacts` treats anything other than a Lead-with-contacts as a
> failure, including `undefined` from a handler that swallowed its own error and
> a held write. Believing those closed the drawer over a save that never
> happened, and meant a new contact never learned its server `_id` — the next
> save then created that person a second time.
>
> The drawer closes only on a confirmed save, keeps the typed draft on a
> refusal, and shows the server's own message. Rows are local state that follows
> the server; a parent refresh does not replace them while an editor is open.
>
> Contact statuses, roles and channels all come from the CRM lookups
> (`contact_status`, `contact_role`, `preferred_channel`). Only active,
> left_organization and do_not_contact are offered at Prospect stage; a contact
> already carrying a legacy status keeps it, shown with its real label, and is
> never converted invisibly.
>
> ---
>
> **Prospect Contacts, Chunk 1 — data model and compatibility (5 Sep 2026).**
>
> One prospective company has several people on it from the first call: a
> merchandiser, a purchase manager, an admin head, and whoever signs. The
> embedded `contacts[]` array on the Lead is where they live. They are NOT
> CRMContacts — a CRMContact belongs to an Account, and creating one for a
> Prospect that may never convert produces an orphan customer record. They are
> promoted to real Contacts when the Account is created (a later chunk).
>
> **CONTACT AUTHORITY.** Once a Prospect has `contacts[]`, the PRIMARY contact
> is the authority for every person-specific value. The Lead's own
> `firstName`, `lastName`, `designation`, `email`, `phone`, `whatsapp`,
> `preferredContactMethod`, `bestContactTime`, `contactTimeNote` and
> `preferredLanguage` are COMPATIBILITY MIRRORS, written FROM the primary and
> never back into it. Duplicate detection, `identityFor`, call and WhatsApp
> matching, the readiness gate and every card read those top-level fields;
> mirroring keeps all of that working, and a single direction of authority is
> what stops the two disagreeing.
>
> **COMPATIBILITY RULES.**
>
> - A record with no `contacts[]` is a legacy Prospect. Its top-level fields
>   are its real data and are left completely alone.
> - The form adapter may present a synthetic contact derived from those fields;
>   the first contact SAVE materialises it. **A read never writes** — a GET
>   that quietly materialised a contact would rewrite history on every page
>   load, under whoever opened the page.
> - **Embedded contact ids are STABLE.** An existing `_id` may be submitted and
>   is RESOLVED against this Lead's own contacts — never trusted. One belonging
>   to another Lead, or to nobody, is refused rather than quietly replaced. New
>   rows get server-generated ids; reordering changes none of them; removing
>   one leaves the rest alone. The future `Activity.leadContactId`,
>   `promotedContactId` and per-contact history all depend on this, and an
>   array that is wholly replaced on every save breaks all three.
> - `promotedContactId` is server-controlled and carried across an edit; a
>   client can never write it, nor the three normalised fields.
> - **Ambiguity is REFUSED, never repaired.** The server cannot know which
>   contact somebody just clicked, and choosing by array order means a reorder
>   silently moves the primary. So: two primaries → 400; a non-active contact
>   marked primary → 400; several active contacts with none marked → 400;
>   removing or deactivating the primary without naming a replacement → 400.
>   The single permitted inference is one active contact with nothing marked,
>   where there is no choice to get wrong.
> - A Prospect with no contacts is valid (early capture often knows only the
>   company). A Prospect whose contacts are all inactive may have no primary;
>   it simply cannot convert.
> - **`prospectType` is the authority.** An Individual Prospect takes at most
>   one contact; handed several, the save is REFUSED and says to change the
>   type to Organisation. Extra contacts are neither demoted nor deleted. An
>   earlier version inferred the type from the presence of a company name,
>   overriding a choice the user had actually made, invisibly and forever.
>   `prospectType` defaults to `"individual"`, so a legacy record may carry
>   that label wrongly — the fix is an explicit, visible type change. Quick
>   Capture already submits an explicit type.
> - **Malformed input is refused, never absorbed.** A non-array, an oversized
>   list, a non-object row or a row with no name is a 400 and the stored
>   contacts are untouched. An explicit `[]` remains the only way to clear
>   them. Same principle as `productInterests`: silent data loss with a success
>   response is the worst of both.
> - `role` (free text) and `isDecisionMaker` are RETAINED verbatim. Old values
>   are prose a salesperson typed and are never reinterpreted as enum codes;
>   `roleCode` is a separate structured field and existing rows have none.
> - The existing canonical CRM contact roles stay canonical — the same list a
>   CRMContact carries, so promotion is lossless. No parallel taxonomy.
> - A contact's `preferredChannel` uses the CRM's `PREFERRED_CHANNELS`; the
>   Lead's legacy `preferredContactMethod` is an older, different set. The
>   mirror TRANSLATES between them (phone→call, messaging→whatsapp,
>   email→email, none→none); `portal` has no legacy equivalent and clears the
>   mirror rather than guessing.
> - `normalizedEmail`/`normalizedPhone`/`normalizedWhatsapp` live ON each
>   contact, not in a record-level array, so a later duplicate result can name
>   WHICH person matched. Derived, never client-supplied.
> - `promotedContactId` is present and unused — set at Account promotion.
>
> **NOT in this chunk:** the Contacts UI, outreach composers, duplicate
> detection, Lead→Account promotion, and the "one active primary with a
> reachable route before conversion" gate. The model contract for that gate is
> prepared and tested; enforcing it is a later chunk.
>
> ---
>
> **Corrections completed (5 Sep 2026), and the phase is now FROZEN.**
>
> - `POST /:id/convert-to-active` was registered TWICE. Express reaches only
>   the first, so the second was unreachable code that read like live code —
>   two implementations free to drift, invisibly. The live one is kept (it
>   delegates the review transition to `services/leadReview.js`, the single
>   writer of `reviewStatus`), the dead one is deleted, and the suite asserts
>   the route is registered exactly once.
> - "Not known yet" is now exclusive to the concrete product interests, in the
>   UI in both directions AND as a server invariant — a rule only the component
>   enforces is a rule any other client can break.
> - A malformed `productInterests` used to become `[]` and return 200, silently
>   wiping a saved list. It is refused with 400 and the stored value survives;
>   an explicit `[]` is still how the field is cleared.
> - The contact requirement is stated once over the group ("Add at least one:
>   phone, WhatsApp or email") instead of marking all three individually
>   required, and priority is now "Priority if converted" with help text saying
>   what it actually does.
>
> Not visually verified — no authenticated browser session was available. The
> next task is the Lead-stage redesign; Prospect work is complete and frozen.
>
> ---
>
> ## SALES LEAD — LIFECYCLE, Chunk 1 — COMPLETE (5 Sep 2026)
>
> **The Lead lifecycle is about the requirement, not the phone.** A Lead exists
> because a Prospect converted, and a Prospect only converts after a successful
> two-way interaction with a confirmed interest signal. The old funnel reopened
> at New → Contacting → Contacted, which restarted a funnel already completed:
> it asked a salesperson to prove contact they had just proved, and said nothing
> about the only open question — what does this customer actually want?
>
> **The visible lifecycle**, on the same stored codes (no migration, no renamed
> field):
>
> | Stage | Code | Trigger |
> |---|---|---|
> | Interest Confirmed | `new` | The Prospect conversion itself — successful interaction, interest signal, interest note, server-set confirmer and timestamp. Nothing is re-asked. |
> | Requirement Captured | `qualified` | A product · an indicative quantity **> 0** · `requirementCertainty` ≠ `unknown`. `suspected` qualifies. No annual figures, budget or delivery date. |
> | Enquiry Ready | `readyToConvert` | The above, plus identity · one reachable phone/WhatsApp/email · certainty `prospect_confirmed` or `document_confirmed` · decision-maker · a source behind any estimate marked researched-or-higher. Estimates themselves stay optional. |
> | Enquiry Raised | `converted` | Journey creation only. |
>
> Parked, Lost and Duplicate remain side outcomes from every active state, under
> the existing safeguards.
>
> **`contactAttempted` and `contacted` are legacy-only.** They appear in the
> transition graph as SOURCES and never as targets, so nothing — including the
> legacy `PATCH /:id/stage` wrapper and call completion — can put a record into
> one. Existing records stay readable, keep their activity and audit history,
> advance straight to Requirement Captured, and are DISPLAYED at Interest
> Confirmed through `displayQualificationState()`. Nothing is rewritten.
>
> **Calls no longer move Leads.** `POST /call-schedules/:id/complete` still
> writes the call Activity, `lastContactedAt` and the next follow-up, but a
> `newLeadStage` is accepted and refused with `leadUpdate.applied: false` and a
> message naming where stages actually move. The refused value is not recorded
> on the CallSchedule. `PATCH /leads/:id/qualification-state` is the ordinary
> writer.
>
> **A stored `readyToConvert` is a memory, not a guarantee.**
> `assertLeadConvertible` re-runs `computeEnquiryReadiness` at Journey creation
> and refuses with the missing checklist labels, so a Lead whose decision-maker,
> contact route, requirement certainty or estimate evidence was edited away
> after it became ready cannot raise an Enquiry. The atomic, idempotent
> conditional flip is unchanged.
>
> Not visually verified — no authenticated browser session was available. Next
> is the Lead form redesign; the lifecycle logic is complete.
>
> ---
>
> ## Prospect Outreach, Chunk 1 — COMPLETE (5 Sep 2026)
>
> **Central Costing is PAUSED, not cancelled.** Everything recorded below this
> note stands: Chunks 1, 2 and 3B1 remain complete, the Chunk 3 gate remains
> blocked on SampleStyle and StockItem ownership, and every uncommitted Costing
> and company-scoping change in the working tree is preserved untouched. Nothing
> in the Costing record has been rewritten or deleted — resume from it directly.
>
> **The active bounded task is Prospect Outreach Chunk 1:** make the existing
> Prospect detail page an actionable outreach workspace. A Prospect is a possible
> customer being contacted to discover interest, and must support call, email,
> WhatsApp/message, note and next-action outreach *before* conversion.
>
> Scope boundaries, stated so they cannot drift:
>
> - A Prospect stays `captureStatus:"draft"` throughout. Outreach must not change
>   `qualificationState`, convert the record, or move it through Lead stages.
> - Draft Prospects stay blocked from `/qualification-state` transitions.
> - Prospect and Lead are ONE record; no separate Prospect activity model, so
>   history survives conversion by construction.
> - Conversion readiness, `convert-to-active`, Sales Journey, Lead stages and
>   Order Book are all out of scope.
> - The Sales tenancy guard's allowed unscoped-query count must not increase.
>
> **Delivered.** A Prospect can now be called, emailed, messaged, noted and
> given a next action while it is still a Draft, with the history and the
> detected call/WhatsApp/mail evidence shown alongside. All of it reuses the
> Active Lead's own controls, so a call logged on a Prospect is the same
> Activity as one logged on the Lead it becomes.
>
> Four latent faults were found and fixed on the way, each of which failed
> silently rather than loudly:
>
> - `ambiguousContactChannels` used `req` without taking it, so every channel
>   read as ambiguous and auto-sync was disabled entirely.
> - `matchedCallEvents` / `matchedWhatsAppMessages` called `identityFor` with no
>   service context; the throw was swallowed and every lead reported "no
>   evidence found".
> - The auto-sync route's `.select()` omitted `createdBy`/`assignedTo`, so it
>   answered 403 to the owner of any restricted record.
> - The follow-up step inside the Quick controls reduces its save to
>   `{nextFollowUpAt}`, which for a Draft is the one field NOT carrying the
>   action. The page's silent reload now returns its Lead and the refresh
>   adopts it, so the server record is authoritative after any save.
>
> The last two of those belong to the in-flight company-scoping work rather
> than to this chunk; they were corrected minimally because the chunk could not
> be verified around them. Worth a look by whoever owns that refactor.
>
> Verification: 16 backend route tests, 27 frontend source-level guards, Sales
> tenancy guard 7/7 (ratchet not raised), `next build` compiles. The existing
> Lead activity suites are unchanged from their pre-chunk baseline.
>
> **Not started, and deliberately so:** Prospect statuses (Contacting,
> Follow-up, Interested). Note also remains paused on the Active Lead while it
> works on a Prospect — a product decision, not an oversight.
>
> **Central Costing resumes from the record below, untouched.**
>
> ---

> **Status:** Central Costing — **Chunk 1 COMPLETE** (two hardening passes),
> **Chunk 2 COMPLETE and CLOSED** (4 Sep 2026, after four correction passes —
> the last of them, A3.7.1b, made alias claim-receipt persistence mandatory).
> **Chunk 3B1 is COMPLETE (after one correction pass) and the CHUNK 3 GATE
> REMAINS BLOCKED (4 Sep 2026).** All 114 previously unscoped Account, Lead and
> Contact queries are scoped, the guard expects zero offenders, and Journey
> creation resolves its company exactly once (A4.7).
> Account, Lead and Contact now carry server-derived ownership, and a Journey
> can no longer be created from a foreign Account, Lead, Contact or commercial
> party — the claim path 3A left open (A4.6). Still blocking: **SampleStyle**
> has no ownership (Chunk 3B2, deliberately deferred), **StockItem** has none
> (Chunk 4), and the full Account/Lead/Contact route surfaces are unscoped —
> zero — the debt ratchet is gone and the guard expects an empty list.
>
> **Write integrity closed (A4.8, 5 Sep 2026).** Ownership is immutable after
> creation (route sanitizer + model seal, migration-only escape hatch), and
> Account relationships — Contact→Account, Lead→Account, parent Account — are
> validated inside the request's company. The supplier-offer path
> `Company → Account/Lead/Contact → SalesJourney → Enquiry → Costing` is
> declared safe; **Chunk 3 supplier offers may start.** SampleStyle (3B2) and
> StockItem (Chunk 4) stay deferred and are not on that path.

## Central Costing — Chunk 3: Supplier Offers and Price Provenance — **COMPLETE** (5 Sep 2026)

A costing material line can be priced from a real, applicable supplier
quotation, and the exact commercial evidence is frozen in the immutable
`CostingVersion`. The four closing contracts (A4.9) and the supplier-status
correction (A4.10) are done.

**Lifecycle.** `DRAFT → ACTIVE → SUPERSEDED | WITHDRAWN`. Expiry is derived from
`validUntil` against the costing date, never stored — a record does not change
because a date passed. A commercial correction creates a NEW revision and
supersedes its predecessor in one commit; the old record keeps the price
somebody was quoted. The model refuses every other write, and the three named
transitions each name exactly the fields they may touch.

**API.** `GET /` (list/search), `GET /:id`, `GET /applicable`, `POST /`,
`POST /:id/activate`, `POST /:id/revise`, `POST /:id/withdraw` under Store
authentication — `sp.sourcing.manage` to write, Store read to list. Costing
reads through the in-process adapter and `GET /api/costings/lookup/offers`
behind `costing.cost.read` / `costing.draft.write`.

**Applicability.** One pure rule decides company, subject, publication state,
the clock, supplier status, unit conversion, MOQ, order multiple and tier
coverage — and every excluded offer comes back with a named reason rather than
being filtered away. Applicable offers are returned in a stable order that is
deliberately NOT price-ranked; the lowest rate is reported as information and
nothing selects a supplier.

**Tax.** The offer is authoritative for HSN/SAC, GST rate and basis.
Recoverability is stated per line and never assumed: recoverable GST stays out
of garment cost, non-recoverable enters it, `NON_TAXABLE` forces a recorded
zero, and a taxable quotation with no recorded rate is refused.

**Frozen per version:** supplier and item/variant identities and names,
supplier item code, quotation reference and date, document reference, validity
window, tier floor and ceiling, purchase UoM and quoted rate, consumption UoM,
conversion factor and rounding mode, currency, tax basis, HSN/SAC, GST rate,
amount, treatment, gross and net, the base rate used as cost, per-scenario
quantities, and the `SUPPLIER_QUOTATION` classification. The engine calculates
from the snapshot and never re-reads the live offer.

### Acknowledged limitation — non-blocking

**`INACTIVE_ITEM` never fires.** `RawItem` has no lifecycle flag: its `status`
is derived from quantity against minimum stock (`In Stock` / `Low Stock` /
`Out of Stock`), which is a warehouse fact and not a discontinuation. Treating
"Out of Stock" as inactive would refuse to cost every item that happens to be
empty today, which is most of what a costing is for. The resolver passes
`itemActive: null` — explicitly "not checked", never read as a pass — and keeps
the reason code for when the item master gains a real flag. Supplier status IS
checked, on both the Store listing and the costing path, because `Vendor.status`
is a genuine `active/inactive/pending` enum.

This is a gap in the RawItem master, not in the supplier-offer path, and it
does not block Chunk 3. Closing it means giving RawItem a lifecycle separate
from its stock status — a Store master change belonging to a later chunk.

### Still deferred

SampleStyle ownership (3B2), StockItem tenancy (Chunk 4), BOM integration,
purchase orders, budget commitments, economies of scale beyond factual quoted
tiers, costing approval lifecycle, actual-cost reconciliation.
>
> **(Superseded)** Chunk 3A verdict:
> Enquiry and SalesJourney access is now fully company-scoped and neither can be
> created unowned (A4.5). The gate stays shut on one named dependency:
> `Account`, `Lead`, `Contact` and `SampleStyle` carry no `companyId`, so a
> journey can still be created from another company's account. Chunk 3 must not
> store supplier quotations against this chain until that is closed.
>
> **(Superseded)** Previously recorded as complete after
> one correction pass: Its first implementation failed open on four counts —
> unresolved Enquiry ownership created an UNOWNED enquiry instead of refusing,
> the source journey was loaded without company scope, authenticated Enquiry
> reads were not scoped at all, and the Store facts boundary returned supplier
> references without proving the supplier belonged to the reading company. All
> four are corrected and tested; see A4.4 in the decision record.
> Chunk 3 itself — supplier offers and price provenance — has not been started.
> Chunk 3 itself — supplier offers and price provenance — has not been started.
> See "Chunk 3A" below for what the gate opened and what it did not.
>
> ### Chunk 3A — the supplier-data security gate (COMPLETE, 4 Sep 2026)
>
> A prerequisite chunk, not supplier offers. Chunk 3 will attach confidential
> supplier quotations and item prices to costings; this proves first that the
> facts it will read belong to the company reading them.
>
> **Stale blockers, re-audited from the code rather than from this document.**
> Several routers this file still listed as unscoped have since been converted
> and are now authenticated, company-scoped and capability-protected:
> `vendor.js`, `rawItems.js`, `units.js`, `mrfRoutes.js`, `services.js`. The
> unauthenticated `/api/cms/units` mount in particular — recorded here for two
> chunks as an open hole — is closed: reads need a Store reader, writes need
> master-maintenance authority, and a test now pins it.
>
> **Real blockers found.**
> - `StockItem` has **no `companyId` and no tenant middleware** on its router.
>   Chunk 3 works on RawItem, so it is outside this gate — but it is unsafe and
>   is a blocker for Chunk 4 (BOM).
> - `RawItem` carries **no HSN code and no GST rate at all**. Chunk 3's own
>   roadmap entry requires an offer to record HSN/GST and the tax-inclusive
>   basis, so this must be modelled before offers can be complete. The service
>   boundary reports `tax.available: false` rather than returning empty strings
>   that would read as "this item is zero-rated".
>
> **Supplier-data paths secured for costing.** Supplier identity, item and
> variant identity, purchase UoM, unit conversions and the legacy alias price
> are read through ONE narrow door,
> `services/centralCosting/storeFacts.service.js`, which takes an explicit
> `{companyId, reason}` service context, puts the company in the same query as
> the id, and returns plain objects rather than models. A conversion pointing at
> another company's unit is dropped rather than returned. The alias price is
> labelled `PROVISIONAL` with `evidence: "LEGACY_ALIAS_FIELD"` and there is no
> way to ask for it otherwise.
>
> **Enquiry ownership, and the migration rule.** `Enquiry.companyId` now exists,
> stamped at creation from the actor's server-owned membership (or the
> single-company deployment rule) and never from the request; how it was decided
> is recorded in `companyOwnership`. Costing resolves `ENQUIRY_STYLE` with ONE
> query containing `_id`, `isActive` and the resolved company. **The migration
> rule:** an unowned enquiry is usable only where ownership cannot be ambiguous
> — a sole-company deployment — and fails closed as NOT FOUND, indistinguishable
> from a missing one, the moment a second company exists. Where membership
> cannot be proved a new enquiry is created UNOWNED with the reason recorded,
> rather than refused, so Sales keeps working.
> `scripts/migrations/backfill-enquiry-company.js` settles legacy enquiries for
> single-company deployments. It defaults to a dry run, refuses a multi-company
> database outright, and **has not been run**.
>
> **The costing / Store permission boundary.** A Store grant of any rank
> resolves to NO costing capability — `sp.sourcing.manage` grants no margin, no
> policy and no approval. Sales still receives `costing.output.read` only.
> One implication was decided and is now resolved centrally in
> `services/centralCosting/capabilities.js`: **`costing.draft.write` implies
> `costing.cost.read`**, because a person cannot professionally edit a costing
> while unable to read the inputs they are editing. It implies nothing else.
> The operational owner of costing — who besides a platform admin or the CEO
> may raise one — remains an **unresolved business decision for Chunk 6**.
>
> **What remains unsafe elsewhere in Store/Purchase.** This gate covers the
> supplier-data paths Chunk 3 consumes; it does NOT close the wider
> Store/Purchase professionalisation chunk, which stays open. Unconverted or
> unscoped: `StockItem`, and the Sales-side Enquiry read/list/update routes,
> which are deliberately NOT company-scoped yet — scoping them strictly before
> the backfill runs would hide every existing enquiry from Sales. Costing does
> not depend on those routes; it does its own scoped resolution.
>
> **Gate verdict: BLOCKED.** The Store-side half is ready — supplier, item and
> unit facts are company-scoped and supplier references are proven. The
> Sales-side source chain is not: `Account`, `Lead`, `Contact` and `SampleStyle`
> have no ownership, and journey creation still loads its source account
> globally. Closing it means ownership + stamping + a dry-run backfill on those
> four models and scoping their routers (~5,600 lines). HSN/GST on the item
> master remains a separate Chunk 3 dependency.
>
> The gate rests on all five acceptance criteria now holding: no new Enquiry can
> be unowned (creation refuses with the established company-selection,
> membership and outage errors); authenticated Enquiry operations are
> company-scoped through one shared helper; a source journey cannot be claimed
> across companies; Store facts return only company-proven supplier references;
> and the focused route and service suites pass.
>
> **Still outside the gate, and still unsafe:** `StockItem` (no `companyId`, no
> tenant middleware) — a Chunk 4 blocker; and the Sales-side Enquiry queries in
> `customerRequests.js`, `sampleStyles.js`, `sampleStyleEmail.service.js` and
> `closingVerdict.js`, which were not part of this correction's stated scope and
> need the same treatment.
>
> **Active brief:** `docs/tasks/central-costing-roadmap.md`.
>
> ### Central Costing Chunk 1 — COMPLETE (4 Sep 2026)
>
> Specified in `docs/handoff/central-costing-chunk-01-prompt.md`; architecture
> record `docs/decisions/central-costing-company-context-and-visibility.md`
> (plus Amendments 1 and 2, which record what the hardening passes corrected).
>
> - **Company context** — one shared, domain-neutral resolver
>   (`services/companyContext/companyMembership.service.js`) that Store's tenant
>   context now also calls, so the two cannot disagree. Fail-closed; a broken
>   identity query is a stable `503 COMPANY_CONTEXT_UNAVAILABLE`, never an
>   authorisation answer, and never a way to reach the single-company fallback.
> - **Capabilities** — six `costing.*` keys resolved from the existing
>   `DeptUser`/`DepartmentRole` records. Sales holds `costing.output.read` only;
>   every other department is deliberately unmapped pending a business decision
>   (open decisions in §8 of the record).
> - **Canonical models** — `Costing` + `CostingVersion` in a neutral namespace,
>   company-scoped, archive-not-delete, versions **completely immutable**
>   (content and status) across every mongoose write path.
> - **Protected API** — `POST /api/costings`, `GET /api/costings/:id`,
>   `GET /api/costings/:id/versions`, one server-side visibility layer, durable
>   creation claims so a lost response cannot become a second costing.
> - `Enquiry.costingSheets` untouched; the adapter boundary was left for Chunk 2.
>
> ### Central Costing Chunk 2 — IMPLEMENTED, INCLUDING THE CORRECTION PASS
>
> First usable costing number: a pure engine, company costing policy, quantity
> scenarios, calculated immutable versions, and the legacy Sales-sheet import.
>
> **The correction pass (4 Sep 2026) is applied and tested.** Six guarantees
> around the calculator were unsafe; each is fixed at its source and recorded
> in Amendment 3 of
> `docs/decisions/central-costing-company-context-and-visibility.md`:
>
> 1. An unconfigured company can no longer freeze a priced version at an
>    accidental 0% margin — `409 COSTING_POLICY_REQUIRED`. A policy explicitly
>    saved at 0% is still valid and still calculates.
> 2. Idempotency keys are bound to the costing in the URL, so a key reused
>    against another costing is a stable `409`, never a replay, a duplicate or
>    a 500 — and stays so after the bookkeeping row expires.
> 3. Recovery repairs the parent's current-version pointer, forward-only, so a
>    recovered version and an ordinary detail read agree.
> 4. Every persisted `*Minor` field is validated at the schema: safe integer,
>    zero valid, missing ≠ zero, negatives only where the domain permits them,
>    and nothing silently rounded.
> 5. `TOTAL_COST` (always circular, never usable) is removed;
>    `SUBTOTAL_BEFORE_FINANCING` is added so financing can validly follow
>    overhead.
> 6. Policy writes use optimistic concurrency on `{companyId, revision}` —
>    `409 POLICY_REVISION_CONFLICT` rather than a silent overwrite.
>
> **A second correction pass (4 Sep 2026)** closed four defects the first one
> left behind — recorded as A3.7 in the decision record: the legacy import's
> idempotency was not durable past its bookkeeping row;
> `provenance.creationClaimTarget` was declared and never written; credits could
> drive a scenario's net cost negative and out the other side as negative
> selling prices (`NEGATIVE_NET_COST` now refuses it before pricing); and the
> policy screen still described the behaviour A3.1 removed.
>
> **A third pass (4 Sep 2026)** closed the last durable-idempotency hole
> (A3.7.1a): a key that resolved to an existing version through legacy CONTENT
> deduplication was recorded only in the temporary `SpIdempotencyRecord`, so its
> permanent binding lapsed when that row expired. Durable claim receipts
> (`costing_claims`) now bind every spent key — creating or aliasing — to the
> company, costing, target, request hash and resolved version, without mutating
> a frozen version or creating a duplicate.
>
> **A fourth pass (4 Sep 2026)** closed A3.7.1b: alias claim receipts were
> written on a best-effort basis, so an aliasing key could be reported as bound
> when its durable record had failed. An alias operation now cannot report
> success until its receipt is durable — a failed write is a retryable
> `503 COSTING_CLAIM_PERSISTENCE_FAILED`, the idempotency row is abandoned
> rather than completed, and the retry finishes the record without repeating
> the import. Duplicate claim ids are verified field by field rather than
> assumed to agree.
>
> **CHUNK 2 IS CLOSED (4 Sep 2026).** All six corrections, the four follow-up
> fixes, the durable-receipt fix and its mandatory-persistence correction are
> implemented and covered by focused tests.
>
> **The one limitation this closure is recorded against:** `next build`
> compiles the costing pages successfully but cannot complete, because
> `/hr/dashboard/attendance/shifts` fails prerendering. That failure is
> unrelated to costing, reproduces on a clean tree with no costing files
> present, and names no costing page. Chunk 2 is therefore closed on costing
> compilation plus focused verification, not on a full production build.
> Whoever fixes the HR page should re-run the build; nothing in costing is
> expected to change.
> ### Central Costing Chunk 3 — COMPLETE (5 Sep 2026)
>
> Supplier quotations now price costing lines, end to end and without anybody
> typing an id.
>
> **3.1 Supplier Offer Master** lives in Store, on Store's own tenancy,
> capabilities (`sp.read` / `sp.sourcing.manage`) and idempotency — corrected
> from an initial Costing-owned build, which would have required Store users to
> hold `costing.cost.read` to keep their own supplier register. Create, revise,
> activate, withdraw, register filtering and the five-section entry flow are
> implemented and tested.
>
> **3.2 Quotation-backed costing lines.** The server resolves the rate from the
> chosen quotation — tier, tax basis, unit conversion, MOQ and order-multiple
> warnings — and freezes the evidence into the immutable version. Corrected
> across two passes:
>
> 1. Tiers and commercial warnings are judged against the quantity the SUPPLIER
>    is asked for, not the finished-goods count: 500 garments at 1.4 m is 700 m.
> 2. A visible picker — item search, variant, consumption, and candidates the
>    server has already priced, unusable ones shown with their reason.
> 3. The preview cannot disagree with what is saved: changing the item or
>    variant drops the selection, changing a quantity holds it as *Rechecking
>    quotation…*, and Calculate is refused until the server has answered for the
>    inputs on screen. A stale response can neither confirm nor condemn a newer
>    selection.
> 4. Every scenario shows its own purchase requirement; a shared tier is stated
>    once, and diverging tiers carry the blocker beside the exact scenarios.
> 5. Provenance freezes readable snapshots — item and variant names and SKUs,
>    supplier item name, the quotation document, and per-scenario quantities.
> 6. Item search tells "could not be read" apart from "no such item".
>
> Also closed while proving this: a quantity past every quoted tier ceiling
> built a rate from `undefined` and would have frozen it. Now
> `COSTING_OFFER_NO_QUANTITY_TIER` (422). Below the first band the offer's own
> headline price still applies — that is the supplier's number, and the stale
> docblock claiming otherwise was corrected to match the code.
>
## Central Costing — Source-driven assembly: FIFTH CORRECTION (5 Sep 2026)

**The import step is gone for `ENQUIRY_STYLE`.** The editor reads its sources
when it opens (`loadAssembly` + `useEffect`). Importing was the old contract —
fetch the record, tick rows, post them back as cost lines — and the server
builds those rows now, so the step's result was discarded and a half-ticked
import produced a costing that silently disagreed with the record it cites.
`TechnicalImportPanel` renders only for `ADHOC`. Several records show the
chooser; none blocks with R&D named.

**The preview returns a presentation contract.** It returned
`assembled.technical` — the RAW sample facts — and dropped `assembled.generated`
entirely. `presentAssembly()` now returns `{state, styleId, style, candidates,
rows: {materials, operations}, quotationDecisions, missing,
productionAssumptions, coverage, policy, technical}`, built from the same
generated rows version creation is built from.

**The labour mismatch is closed.** The screen read
`preview.operations[].operatorCost` — the sample's legacy
`salary / 12,480 x SAM` — and showed ₹2.16 as VERIFIED while version creation
froze the policy-derived ₹3.54. Operation rows now carry `rateMinor`,
`rateBasis`, `workings` and `legacyRateMinor`; the legacy figure is returned only
so a reader can see the two differ, and is never the displayed rate. A route
test asserts `displayed === frozen === 354`.

**The gate no longer treats an unread assembly as ad-hoc.** `assembly === null`
fell through to `NOT_SOURCE_BACKED` — "hand-built work, calculate away" — so the
button was live over a costing whose sources nobody had read. `NOT_LOADED`,
`LOAD_FAILED` and `assemblyLoading` are each their own blocking state.

### Tests

Focused frontend → **239 passed**. `costing-technical-import.route` +
`costing-version.route` → **121 passed**. Server-rendered both contexts: the
enquiry editor renders with no Import/Apply, no editable table, the read-only
assembled block present and Calculate blocked on open; ad-hoc keeps both.
`git diff --check` clean in both repositories.

### Superseded record of the fourth correction

## Central Costing — Source-driven assembly: FOURTH CORRECTION (5 Sep 2026)

**1. The editable spreadsheet is absent for `ENQUIRY_STYLE`.** Not hidden — the
whole table, its per-row controls (description, category, behaviour, rate,
consumption, tax, delete, generic quotation picker) and the mobile stack are the
ELSE branch of `sourceBacked`. Assembled rows render read-only; every permitted
action lives in `Assembled costing inputs`. `ADHOC` is untouched, and legacy
Sales-sheet import remains a separately labelled action.

**2. One Calculate gate.** `sourceGate({ costing, assembly, lines, scenarios,
quotationChoices, lineGate })` — assembly state, blocking missing-source
entries, required quotation selections, override completeness, quantity
scenarios, then the existing line rule (which carries the quotation-recheck
state). Choosing a quotation clears its blocker immediately, with no round trip.
The button and the sentence beside it read the same result. Ad-hoc returns
`lineGate` unchanged.

**3. `unresolvedGroup` can no longer carry money.** The tag is a string the
browser sets: it named a family and carried no reason, no actor, no timestamp
and no supplement-or-replace decision — the same manual-line bypass under a
different field name. Rows are refused unless declared as an override;
`CompleteTechnical` now produces the full override shape. "Does not apply"
remains an acknowledgement with a reason.

**4. The legacy `operatorCost` prerequisite is gone.** `bindOperation` order is
now: time → salary → canonical calculation → legacy only if the canonical one
cannot be reached AND the legacy figure exists → otherwise a precise
missing-input refusal naming the assumption. `operationRow` marks an operation
importable on SAM + salary, no longer requiring the field older code generated.

### Tests

Focused: `costing-technical-import.route`, `costing-labour`,
`costing-version.route`, `costing-engine` → **176 passed**. Frontend focused →
**233 passed**. `/costing` serves 200. `git diff --check` clean both repos.

Noted: `test/costing/costing-corrections.test.js` leaks a `jest.spyOn` on
`updateOne` that can fail `costing-completeness` in a whole-directory run. It
passes in isolation and on re-run; pre-existing test isolation, not a product
defect.

### Superseded record of the third correction

## Central Costing — Source-driven assembly: THIRD CORRECTION (5 Sep 2026)

Three defects, all real:

**1. The policy labour rate was overwritten on save.** `assembly` computed it,
then `bindOperation` replaced it with `row.operatorCost` — the sample's own
`salary / 12,480 x SAM`. The preview showed the new number and the version froze
the old one. Binding is the authoritative boundary, so the recomputation moved
there: it re-reads SAM and salary from the record it has just proved, calls
`labourCost.labourCostPerGarment`, and never restores the sample's figure once a
policy rate exists. `technicalRateBasis` records which produced the number
(`COMPANY_POLICY` or `LEGACY_SAMPLE_RATE`), and the workings are frozen beside it.

A route test asserts the saved input AND the calculated scenario line carry
**354** minor units (₹3.54), not 216 (₹2.16), for the worked example.

**2. Undeclared manual lines are refused.** The `carried = plain.filter(...)`
path accepted any row without a technical key — so the block added last pass
could be sidestepped by leaving the key off, and a supplement double-counted
silently beside its assembled line. Now `COSTING_MANUAL_LINE_REFUSED` (400),
naming the offending keys and the remedy. Historical versions are recognised by
the server-side legacy-import path, never by a browser-submitted row shape.

Also fixed: `calculationInput` dropped `override.replacesLineKey`, so every
replacement arrived looking like a supplement and sat beside the line it was
meant to stand in for.

**3. Quotation selection is a real decision.** Multiple applicable quotations
return candidates (supplier, rate, tier, unit, MOQ, multiple, lead time,
validity, reference) plus the excluded ones with reasons, keyed by the assembled
line. `quotationChoices: { [lineKey]: offerId }` carries only the identity; the
offer is re-read and revalidated per scenario at save. The frontend renders a
radio group under the gap, in the server's order — never cheapest-first. A
preview with no run size yet lists CURRENT quotations and says the quantity check
happens at calculation, rather than falsely reporting none applicable.

### Tests

`npx jest test/costing/ --runInBand` → **560 passed / 18 suites**.
Focused frontend → **229 passed**. `/costing` serves 200. `git diff --check`
clean in both repositories.

### Superseded record of the second correction

## Central Costing — Source-driven assembly: SECOND CORRECTION (5 Sep 2026)

Two defects made the previous pass' claim false:

- **The manual bypass.** `assembleLines` returned client lines whenever the
  technical record was missing or ambiguous, so a stale or hostile client could
  type its way to a frozen version. Now `COSTING_AWAITING_SOURCE` (409), no
  version created. Ad-hoc keeps the manual calculator; legacy Sales-sheet
  import is exempt.
- **Production policy changed only a label.** `labourCost.js` is now the one
  calculation for preview and save, using SAM, salary, productive
  minutes/efficiency and employer burden. Worked example and formula in the
  decision document. Both productive bases set is refused, not resolved by
  precedence. `IN_OPERATION_RATE` no longer counts as resolved — an enum is not
  a machine-cost source.

Also: the assembled view now renders ABOVE every editable control, the generic
"Add line" is confined to ad-hoc costings, and the override form actually
exists and reaches the payload (it previously produced an object no form could
fill in and `toWireLine` did not send).

### Superseded record of the first correction

## Central Costing — Source-driven assembly: CORRECTED AND COMPLETE (5 Sep 2026)

The first pass produced a preview CONTRACT and called it assembly. The runtime
still required the browser to reconstruct technical rows before anything was
costed. That is fixed:

- `assembly.assembleLines()` GENERATES material and operation lines from the
  technical record. `versionCreation` calculates those, not `input.lines`.
- The parser accepts an empty `lines` array for an `ENQUIRY_STYLE` costing —
  the last place the old contract survived.
- Each generated material is matched to the ONE quotation that unambiguously
  applies; several is a sourcing decision reported as a choice, none is a named
  gap owned by Store. Nothing is chosen by price.
- A client that still echoes technical rows has them RECONCILED, not
  duplicated — and `bindTechnicalLines` then revalidates each against the live
  record, which is the stricter path.
- `policyMissing()` reports contingency (it was omitted).
- Operation rates are PROVISIONAL until the company configures productive
  minutes/efficiency, employer burden and machine-burden treatment. New policy
  fields; no defaults.
- Input-GST recoverability moved to policy: a quotation states a rate, not
  whether this company reclaims it.
- Overrides declare family + reason, are stamped with actor and time
  server-side, are frozen `PROVISIONAL`, and must say whether they replace an
  assembled line or supplement a family. Ambiguous duplicates are refused.
- **The Assembled costing inputs view is built** —
  `components/costing/assembledInputs.js` + the `AssembledInputs` panel. Six
  groups, each row carrying value, unit, owner, source record and state. Manual
  entry is a secondary "Add provisional override".

### Superseded record of the first pass

## Central Costing — Source-driven assembly: BACKEND IMPLEMENTED, UI DEFERRED (5 Sep 2026)

The audit and the source-authority table are in
`docs/decisions/central-costing-technical-source-semantics.md`. **Five of the ten
cost families have no authoritative record in this repository** — outside
services, packaging, freight, customs duty and development/tooling. Each now
names the department that owns the gap.

**One assembly service.** `assembly.service.js` is called by the preview route
and by `technicalBinding` on save, so what the screen shows and what is frozen
come from one function. A test asserts both call it.

**Named workflow states** replace `preview: null`, which meant three different
things: `ASSEMBLED`, `AWAITING_RND_TECHNICAL_DATA`, `SEVERAL_TECHNICAL_RECORDS`,
`NOT_SOURCE_BACKED`. Each `missing[]` entry carries its owning department.

**Two company-level rules added** to the costing policy — financing and
contingency, each a rate plus a basis, synthesised as engine lines exactly as
overhead is. Unset stays unset: a 0% default would read as "this company borrows
for nothing".

**Provisional overrides** declare a cost family, require a reason, and are
stamped with the actor and time from the session. Frozen as `PROVISIONAL`,
never `SUPPLIER_QUOTATION`; refused outright on a sourced line.

### Tests run

- `npx jest test/costing/costing-technical-import.route.test.js
  test/costing/costing-engine.test.js test/costing/costing-offer-line.route.test.js
  test/costing/costing-version.route.test.js test/costing/costing-contract.test.js
  test/costing/costing-supplier-data-gate.test.js --runInBand` → **244 passed**
  (12 added).
- Frontend pure modules → **212 passed**, unchanged.
- `git diff --check` clean in both repositories.

### Deferred, deliberately

- **The Assembled-costing-inputs workspace view is NOT built.** The preview
  response now carries everything it needs — state, `missing[]` with owners,
  `policy.rules` with owners and states, and `coverage.families` with authority
  and owner — so the remaining work is rendering what the server already
  returns. It is a substantial React build and was not started rather than
  half-finished.
- **No browser walkthrough**: the app needs a signed-in session and I will not
  enter credentials.
- Product BOM, purchase orders, budgets, approvals and actual-cost
  reconciliation remain out of scope.

## Central Costing Chunk 5A — Scenario-specific EOS: IMPLEMENTED (5 Sep 2026)

**The blocking contract is gone.** `offerPricing` refused when two scenarios
reached two quoted tiers, because the engine carried one rate per line — which
made the central economies-of-scale comparison impossible to calculate. A
`PER_UNIT` line now carries `unitRateByScenario`, built by the SERVER re-reading
the quotation for each scenario's own supplier quantity. The browser still
submits only the offer reference, the subject identity, the consumption and the
conversion. Full reasoning in `docs/decisions/central-costing-company-context-and-visibility.md`
(A5.1).

**Per-scenario facts are frozen, not derived.** `offerProvenance[].scenarios[]`
records each quantity's supplier quantity, band, quoted amount, net/effective
rate, GST split, conversion and tax treatment — so a version answers "why was
3,000 cheaper" without the quotation still being active.

**Every rule runs per scenario**: company, supplier status, quotation state and
dates, item/variant, currency, UoM conversion, MOQ, order multiple, tier floor,
ceiling and gaps. Nothing interpolated, no nearest tier. One unsupported
scenario refuses the version and names that scenario, its output quantity, its
derived purchase quantity and the exact reason.

**Fixed dilution is unchanged and now visible**: the total does not move, only
its per-garment allocation, and both totals are reported so a reader can see it.

**Four causes, each a fact**: `SUPPLIER_TIER`, `FIXED_COST_DILUTION`,
`UNCHANGED_VARIABLE_COST`, `OVERHEAD_CONSEQUENCE` — with affected line, both
amounts, the per-garment difference, provenance and a display label. Bulk
discounts, efficiency, wastage and freight consolidation are absent by design.
An unexplained residue is stated as `unattributedMinor`.

**A dead helper was found and replaced.** `explainDifference` mapped the
engine's `reason` through a lookup of two codes the engine has never emitted, so
the "Why the unit cost differs" cell read "Not set" for every scenario — on the
one screen whose entire purpose is explaining why the quantities differ.

### Files

Backend — `services/centralCosting/engine.js`,
`services/centralCosting/offerPricing.service.js`,
`services/centralCosting/versionCreation.service.js`,
`services/centralCosting/calculationInput.js`,
`services/centralCosting/visibility.js`,
`models/CMS_Models/Costing/CostingVersion.js`,
`models/CMS_Models/Costing/costingCalculation.js`.
Frontend — `components/costing/costingSummary.js`,
`components/costing/CostingWorkspace.js`.

### Tests run

- `npx jest test/costing/costing-engine.test.js
  test/costing/costing-offer-line.route.test.js
  test/costing/costing-version.route.test.js
  test/costing/costing-technical-import.route.test.js
  test/costing/costing-contract.test.js --runInBand` → **210 passed**
  (9 engine + 9 route tests added; 2 rewritten from the removed refusal).
- `node --test components/costing/costingSummary.test.mjs
  components/costing/offerPicker.test.mjs
  components/costing/technicalImport.test.mjs
  components/costing/costingQueue.test.mjs` → **212 passed** (11 added,
  3 fixtures corrected to the shape the engine actually returns).
- `git diff --check` clean in both repositories. No full suite, no build.

### Remaining limitations

- **`UNCHANGED_VARIABLE_COST` is emitted per line**, so a costing with many
  unchanged lines produces a long cause list. The UI sorts by absolute movement
  and the zero-movement rows fall last, but they are not collapsed.
- **The engine's `confidence` still narrows to two values.** Quotation-backed
  lines store `PROVISIONAL` in their scenario line results; the EOS provenance
  is derived from the presence of a per-scenario rate table instead, which is
  precise but leaves the older narrowing in place.
- **`COSTING_OFFER_TIER_VARIES_BY_SCENARIO` is retired but still declared**, so
  an old stored refusal resolves to a name rather than to `undefined`. Nothing
  raises it.
- **Board migration is deferred**; the existing workspace was extended.
- Confirmed-demand aggregation, probability-weighted forecasts,
  operation-efficiency bands, wastage reductions, freight consolidation,
  approval, quotation handoff, purchase orders, budgets and actual-cost
  reconciliation remain out of scope (Chunk 5B and later).

## Central Costing Chunk 4C — Operational entry and dashboard: IMPLEMENTED (5 Sep 2026)

### 1 · The detail-page failure, diagnosed

**It was never a costing 401.** "Sign in required" is rendered by
`components/access/DepartmentGuard.js`, and it appeared because
`verifySession()` in `components/access/useDeptRole.js` shared its in-flight
promise for 15 seconds **whatever it resolved to**. One transient failure — a
network blip, a cold backend, a request that lost the race with session setup —
was then replayed to every caller for the rest of the window.

That produces exactly the reported symptom. The list page's guard renders
optimistically while its check is in flight, so the list appears. Opening a
costing mounts a FRESH guard, which calls `verifySession()` again, receives the
cached failure, and denies — with the server never asked a second time.

Two fixes, both in the shared access layer:

- **A failed verify is no longer cached.** A success is still shared (that is
  what the window is for); a failure clears the cache so the next caller
  re-asks. The clear is guarded on promise identity, so a slow failure settling
  after a fast success cannot wipe the good answer.
- **"We could not ask" is told apart from "you are not signed in."** The fetch
  turns a network error into a RESOLVED `{ok:false, status:0}`, so it never
  reached the guard's catch — and the branch treated it, and every 5xx, as an
  expired session: it signed the person out and sent them to the portal. A
  status of 0 or ≥500 is now offered as a retry and the session is left alone.
  A real 401/403 still denies, and is not offered as a retry.

The API side was checked and is symmetric: `GET /` and `GET /:id` require the
same five capabilities, and the workspace's third call (`policy/current`) is
already `.catch(() => null)`.

### 2 · The dashboard

`/costing` is a work queue: **Awaiting costing · Draft · Under review ·
Approved**, counts first, then compact tables. The state is derived from the
VERSION pointers, because `Costing.status` is an enum of exactly one value —
grouping by it would put every row in one bucket forever. An approved version
outranks whatever is being drafted beside it.

Each row carries customer, enquiry number, product, variant, quantity, wanted-by
date, owner, version and last-updated — from a live `subject` block the list
endpoint now attaches alongside the frozen `contextSnapshot`, never instead of
it. No database ids as labels. No cost, price or margin anywhere on the screen:
a queue is a place to choose a record, and putting a figure on it would mean
gating every row. Actions follow capabilities — Start costing / Continue / View
approved costing — and a reader who cannot write is never offered one the server
would refuse.

### 3 · The enquiry picker

`GET /api/costings/lookup/enquiry-products` (company-scoped, `draft.write`)
returns one row per enquiry PRODUCT with the **server-owned context** the create
expects. The browser echoes it and constructs nothing: the old form asked for a
raw Mongo `_id` and the product name spelled exactly as the enquiry spells it,
which nobody can do from memory — and which made the client responsible for
naming a record correctly. Searchable by enquiry number, customer, product,
colour and size range. Foreign enquiries are absent, not refused.

### 4 · Creation

"Start a costing" defaults to the enquiry picker; ad-hoc is the secondary tab.
Nothing is created until a row is chosen, and creation opens the workspace
directly rather than returning to a list. A second costing for the same enquiry
product is refused with `COSTING_ALREADY_EXISTS` (409) carrying the existing
costing, so the screen routes there instead of reporting a failure for work that
exists; the picker also shows "Open existing" rather than offering Start.
Archived costings do not block a fresh one.

### 5 · Discoverability

`GET /api/costings/access` answers "does this account hold any costing
capability", above the company middleware — capabilities are company-independent,
and requiring the context would hide the tile from anybody in two companies for
a reason unrelated to their permissions. The Apps switcher shows a Costing tile
when it says yes. Costing is not a department, so the tile opens as a plain link
rather than through `switch-department`. **No new permissions were granted**, and
hiding is not treated as protection: every endpoint re-checks server-side.

### Files

Backend — `services/centralCosting/enquiryLookup.service.js` (new),
`routes/CMS_Routes/Costing/costings.js`.
Frontend — `components/access/useDeptRole.js`,
`components/access/DepartmentGuard.js`, `components/shell/useMyApps.js`,
`components/costing/costingQueue.js` (new),
`components/costing/CostingList.js` (rewritten), `lib/centralCosting.js`.

### Tests run

- `npx jest test/costing/costing-foundation.route.test.js
  test/costing/costing-lifecycle.route.test.js
  test/costing/costing-version.route.test.js
  test/costing/costing-technical-import.route.test.js --runInBand`
  → **173 passed** (12 added to the foundation suite).
- `node --test components/costing/costingQueue.test.mjs
  components/costing/technicalImport.test.mjs
  components/costing/offerPicker.test.mjs
  components/costing/costingSummary.test.mjs
  components/access/sessionVerify.test.mjs`
  → **197 passed** (16 + 7 added).
- `git diff --check` clean in both repositories.
- No full regression suite and no production build, per the brief.

### Browser walkthrough — NOT COMPLETED

The dev server is running and `/costing` compiles and serves 200, but the app
redirects to the sign-in page without a session and I will not enter
credentials. **The authenticated walkthrough and the three requested screenshots
(dashboard, picker, opened workspace) were not produced.** They need somebody
signed in to drive them.

What was proved instead, at the API level: the same token and company header
lists and then opens a costing (200/200/200) with no second sign-in; the two
routes are gated identically; a no-grant account is refused by both; and the
access probe answers without a company and returns no costing data.

### Remaining limitations

- **The dashboard cannot show what has NEVER been costed.** "Awaiting costing"
  means a costing was raised and has no version yet. Enquiry products with no
  costing at all appear only in the picker. Showing them as queue rows would
  mean the queue listing Sales records, which is a wider read than this chunk
  should take.
- **"Under review" depends on the version status reaching the list.** The
  serializer sends `currentVersion.number` but not its status, so a costing
  whose newest version is IN_REVIEW currently groups as Draft. Surfacing that
  needs a one-field change to `serializeCosting` and belongs with the approval
  work rather than here.
- **The `test` record is untouched**, as instructed. It will appear in the
  Ad-hoc rows of whichever queue it belongs to; nothing depends on it.
- **The variant shown is colour + size range**, the nearest thing an enquiry
  product has. It is not a SampleStyle variant.
- The verify-cache fix is in the SHARED access layer and affects every app, not
  only Costing. That is where the defect was.

## Central Costing Chunk 4B — Completing the technical build-up: IMPLEMENTED (5 Sep 2026)

4A imported materials and operations and then named four things nobody had
costed — outside services, embellishment, packaging and one-time development.
It named them and stopped. Every costing carried the same four warnings
indefinitely, because nothing on the screen let anybody discharge one: the
reader had to know that "Packaging" meant adding a `PACKAGING` line, and that a
`SERVICE` line for dyeing would not clear the embroidery requirement. That is
server vocabulary, and no reason to expect a merchandiser to hold it.

**Each group now takes exactly two answers**, in a compact table inside the
existing workspace — no new page, no cards:

- **Add cost line** — creates a row already classified. The person supplies the
  money; never the category and never the group tag. `services` and
  `embellishment` → `SERVICE`, `packaging` → `PACKAGING`, `development` →
  `FIXED_SETUP`. Packaging is per garment and development is fixed for the run
  (charged once); services and embellishment can honestly be either, so the
  choice is offered. Multiple lines per group are allowed.
- **Does not apply** — requires a reason, posted as `technicalAcknowledgements`
  through the parser and provenance path that already existed. Reversible: a
  decision is not a lock, and a cost can arrive later.

There is deliberately no third option. No "skip", no "0", no dismiss — a
control that cleared a warning without either costing it or writing down why is
exactly how missing becomes zero.

**Four states, because they need different actions:** Missing, Needs
rate/amount, Cost entered, Marked not applicable. "Started and not finished" is
its own answer; calling it Missing would read as untouched and send somebody to
add a second empty row.

**The screen and the server agree by construction.** The group list and each
group's `resolvedBy` rule come from the server with the preview and are read,
not restated — a fifth group added server-side needs no frontend change. Only
the small matching algorithm is mirrored, because the screen must say whether
the costing is complete while somebody is still typing. Critically, the
UNRESOLVED entries in `completeness.outstanding` are now RECOMPUTED from the
current lines and decisions rather than replayed: that list was built when the
style was read, so replaying it left a group listed after it had been costed
and — worse — could stay quiet about one since emptied.

**One real defect found and fixed in the provenance path.** Acknowledgement
references were gated behind `styleId && lines.some(technicalKey)` — the
conditions for freezing IMPORTED rows. A costing that read the technical record,
imported nothing usable and wrote down "the customer supplies all packaging"
therefore froze no record of that decision: the reason vanished and the version
simply had no packaging cost, indistinguishable from nobody having thought about
it. `freezeAcknowledgements` is now independent of whether anything was
imported, and the snapshot helpers were lifted to module scope so both freezers
share one definition of a fact.

Manually entered amounts stay `PROVISIONAL`. The answer is still
**Pre-production estimated cost** even when every group is answered — it was
made before anything was produced, and "complete" is not "final" or "approved".
Historical versions are untouched: a judgement made in October does not appear
on a version frozen in June.

### Files

Backend — `services/centralCosting/versionCreation.service.js`.
Frontend — `components/costing/technicalImport.js` (`GROUP_FORM`,
`lineForGroup`, `groupStates`, `acknowledge`/`unacknowledge`,
`acknowledgementsToWire`, live `unresolvedInputs`),
`components/costing/CostingWorkspace.js` (the `CompleteTechnical` section and
the acknowledgement state), `components/costing/TechnicalImportPanel.js`
(points at the section instead of ending in a passive list).

### Tests run

- `npx jest test/costing/costing-technical-import.route.test.js --runInBand`
  → **51 passed** (43 before; 8 added).
- `npx jest test/costing/costing-version.route.test.js --runInBand` → 25 passed,
  run because `versionCreation` changed.
- `node --test components/costing/technicalImport.test.mjs` → **33 passed**
  (21 before; 12 added, 3 existing assertions updated to the new contract).
- `node --test components/costing/offerPicker.test.mjs
  components/costing/costingSummary.test.mjs` → 131 passed, unchanged.
- `git diff --check` clean in both repositories.

No full regression suite and no production build were run, per the brief.

### Remaining Chunk 4 limitations

- **The unresolved section needs a technical preview.** The four groups come
  from the server's reading of a style, so an `ADHOC` costing with no style
  shows no section. That is consistent with 4A and not a regression, but it
  means a hand-built costing has no prompt to consider packaging at all.
- **Services and embellishment default to per-garment.** The choice is offered
  and visible; the default is a starting position, not a recorded decision.
- **No allowance, wastage or process-loss modelling** on manually added
  resolution lines — the roadmap's Chunk 4 bullet for those is met only for
  imported material rows (4A).
- **`Service.defaultRate` is still not used**, deliberately: it is planning
  guidance, not a confirmed rate.
- **The RawItem lifecycle gap** recorded under Chunk 3 is unchanged.
- Economies-of-scale scenarios, profit-band selling prices, costing approval,
  Sales quotation handoff, purchase orders, budget commitments and actual-cost
  reconciliation remain out of scope.

> ### Central Costing Chunk 4A — Technical Cost Builder: IMPLEMENTED (5 Sep 2026)
>
> An `ENQUIRY_STYLE` costing can import the materials and operations already
> recorded on its SampleStyle instead of having them typed a second time.
>
> **The semantics were established first, by reading the write paths** — and
> written down in `docs/decisions/central-costing-technical-source-semantics.md`,
> because none of them is obvious from the field names:
>
> - `materials.rawItems` (Merchandising's planned pick) and
>   `sample.consumptionRawItems` (R&D's measured consumption) are ALTERNATIVE
>   evidence for the same material, not two costs. They merge onto one row.
> - The measured quantity ALREADY INCLUDES its `allowancePercent` —
>   `sampleStyles.js:1508` says so explicitly and passes it to the product BOM
>   with the allowance zeroed. The schema comment says the opposite; the write
>   path is what ran. It is never multiplied in again.
> - `operatorCost` is `salary ÷ 12,480 minutes × SAM` — rupees per operation
>   **per finished piece**, so it imports as a `PER_UNIT` `OPERATION` line with
>   no conversion asked of the user.
> - "Approved" is three separate gates: `bomApproval.status`,
>   `techSheet.status` and `sample.status`. Measured consumption supersedes the
>   planned pick ONLY once the sample is approved.
>
> **No denominator is assumed.** Nothing stores how many garments a sample round
> produced, so nothing is divided. The basis is graded instead:
> `PER_GARMENT_CONFIRMED` (the product BOM carries the same quantity),
> `PER_GARMENT_BY_APPROVAL` (the approval sync wrote it as a per-garment BOM
> quantity), `PER_GARMENT_PLANNED`, or `NEEDS_CONFIRMATION` — which is shown
> with its figures and is not importable.
>
> **Ownership** is proved through the Sales Journey, which is company-scoped;
> SampleStyle still is not (Chunk 3B2). A foreign style is not listed as
> unavailable — it is not listed. Sibling variant styles are returned as
> candidates and never resolved by ordering.
>
> **What it does not do:** invent a price. The technical record says how much is
> used, never what it costs, so an imported material arrives complete except for
> its rate and waits visibly for the Chunk 3.2 quotation picker. An operation
> that priced to zero because no salary basis could be resolved is reported as
> missing, not free. Outside services, embellishment, packaging and one-time
> development are named as unresolved groups rather than rendered as ₹0.
>
> Rows are matched on stable source identities — item-and-variant, or operation
> code — so re-importing after a rename updates a row rather than adding a
> second. Hand-entered lines carry no technical key and are never touched.
> Version provenance freezes the style, both approval gates, and each row's
> quantity, unit, allowance and planned-versus-measured basis as `BOM` and
> `OPERATION` source references; editing the style afterwards does not change
> it. The answer is labelled a **pre-production estimated cost** throughout.
>
> Approval, Sales quotation handoff, economies-of-scale policy and actual-cost
> reconciliation are deliberately not in this chunk.
>
> **PAUSED STORE/PURCHASE SCOPE — Chunk 1: tenant boundary, permissions,
> immutable audit history, idempotency, document sequences and safe lifecycle
> controls. NOT COMPLETE.** Architecture record:
> `docs/decisions/store-purchase-tenancy-permissions.md`.
>
> ### Chunk 1A — foundation and operational-PO pilot: IMPLEMENTED
>
> What exists and is tested:
>
> - **Tenant context** (`services/storePurchase/tenantContext.service.js` +
>   `Middlewear/storePurchaseTenant.js`) with deterministic company selection
>   and fail-closed membership.
> - **Capabilities** (`services/storePurchase/capabilities.js`) — 17 keys,
>   mapped from the existing `DepartmentRole` grants. Authentication alone
>   grants nothing.
> - **Atomic numbering** (`SpDocumentSequence`), **idempotency**
>   (`SpIdempotencyRecord`), **append-only history** (`SpActionHistory`),
>   **approval policy** (`SpApprovalPolicy`), lifecycle guards.
> - **Applied end-to-end to the operational Purchase Order router only.**
> - Frontend capability/forbidden/legacy/conflict states and a history drawer
>   on the two PO screens only.
>
> ### Chunk 1 — REMAINING, and why the boundary is not yet real
>
> **Cross-company access is NOT impossible today.** The following active
> Store/Purchase transaction routers are still unscoped, unpermissioned and
> non-idempotent, exactly as Chunk 0 found them:
>
> - MRF / material-request (review, match, fulfilment decision, issue, return)
> - Requisitions
> - Stock issuance and stock adjustment/correction
> - Vendor returns and replacement receipts
> - Barcode / lot operational writes
> - Deliveries
> - RawItem direct stock writes and its hard-delete path
> - Worksheet PO / worker work orders
> - `/api/cms/units` — still mounted with **no authentication at all**
>
> Any of those can read and mutate another company's records. Until each one
> satisfies the boundary, Chunk 1 is not done.
>
> **Passing tests do not establish completion.** The suites that pass cover
> the routers that were converted. A green run says nothing about the routers
> above, and must not be read as evidence that the boundary holds.
>
> **Chunk 2 is BLOCKED** until every active Store/Purchase transaction path
> satisfies the Chunk 1 boundary. Master-data redesign on top of an
> unenforced tenant boundary would build the new model on the same hole.
>
> **Known migration requirement:** the legacy global index `poNumber_1` must
> be dropped by an authorised migration before multi-company use. A reviewable
> script exists at `scripts/migrations/store-purchase-chunk1-indexes.js`; it
> has **not** been run against any database.
>
> ---
>
> **Chunk 0 — baseline, vocabulary and safety harness: COMPLETE
> (2026-09-01, after a technical correction pass, the Item Master addendum,
> an accuracy correction to both, and a final runtime/report-integrity
> correction).**
> All deliverables exist and are verified:
>
> 1. Full two-repo system inventory: `docs/audits/store-purchase-baseline.md`
>    (56 frontend routes, all models/routers/write paths, flow map, the
>    twelve stock-mutation sites S1–S12), **plus the Item Master audit in
>    §12** — every item-identity field across RawItem, its variants,
>    StockItem/BOM, categories, units and conversions, supplier aliases,
>    barcodes, PO/MRF/Requisition/Intake/Spend item references, budget
>    mappings, reorder fields and catalogue metadata, each classified by
>    data class, trust level, readers/writers and proposed target owner.
> 2. Read-only usage/data baseline: `scripts/store-purchase-baseline-audit.js`
>    (native-driver, provably read-only) + pure arithmetic in
>    `services/storePurchaseBaselineAudit.service.js` and
>    `services/storePurchaseItemMasterAudit.service.js`; **119 node:test
>    cases** plus jest integration tests proving every collection in the
>    gather plan — documents and indexes, including those it finds absent —
>    is unchanged after a run. The item-master half measures SKU/name
>    identity, category and unit conflicts, conversion validity, variant and
>    balance hygiene, **supplier relationships at all three layers**
>    (primaryVendor, alternateVendors[], variant aliases — with "no
>    configured supplier relationship" wording, since history may still name
>    one), **StockItem hygiene as part of one Item Master** (reference/name/
>    barcode/variant-SKU identity, productType vs trackInventory, services
>    holding balances, header vs variant totals, HSN/tax completeness),
>    cross-collection ObjectId collisions, type/lifecycle capability gaps,
>    reference integrity (BOM and barcode), **company-specific budget
>    coverage against an optional mapping collection**, and RawItem↔StockItem
>    overlap **candidates only**, by exact normalised matching with no fuzzy
>    guessing. **NOT yet run against production** — command in audit doc §7,
>    and no coverage figure may be quoted without an authorised run.
> 3. Vocabulary/navigation record:
>    `docs/decisions/store-purchase-vocabulary-navigation.md` — **PROPOSED,
>    awaiting business approval; nothing in it is adopted.** No live labels,
>    routes or navigation were changed.
> 4. Regression harness: existing `test/requests/` suites (upstream chain)
>    plus `test/store-purchase/po-receipt.route.test.js` — 22
>    characterisation tests covering the real DRAFT → ISSUED transition,
>    whether POST can bypass it, PO receipt incl. duplicate receipt, vendor
>    returns, payments, the unauthenticated `/api/cms/units` mount, absent
>    authorisation and company isolation. A literal single end-to-end test is
>    impossible today (spend→PO conversion drops the catalogue-item link —
>    documented) and none was faked.
> 5. Migration traceability: audit doc §9 — no new fields introduced.
> 6. **Item master target model, item types and migration boundaries**:
>    product plan §4.1a / §4.1b / §4.1c — **all PROPOSED, not adopted**.
>    Chunk 2's roadmap entry now specifies the decomposed Item Master it
>    must build; §4.1c fixes the point at which `RawItem.quantity` stops
>    being authoritative (a Chunk 3 gate), forbids a big-bang migration, and
>    states the **non-negotiable collection-identity compatibility
>    requirements**. Target Item identity is **stable after migration**;
>    whether it reuses a legacy id is a Chunk 2 decision, and legacy
>    references keep resolving only because legacy documents remain and
>    adapters use the legacy-source mapping — a Mongoose `ref` resolves
>    against a named collection, so unchanged ObjectIds alone preserve
>    nothing. Legacy documents are
>    retained, Items carry `legacySourceType`/`legacySourceId` under a unique
>    index, adapters serve old references, migration is batched, id
>    collisions are detected before any id reuse, snapshots are preserved,
>    and legacy collections retire only after a reference-coverage gate.
> 7. **Budget/Accounting status classified from `HEAD`**: the **committed
>    Store baseline has NO item-wise budget attribution authority at all** —
>    `RawItem.budgetLedgerId`/`budgetLedgerName`/setter audit fields,
>    `Acc_ItemCategoryBudget`, `itemBudgetHead.service.js` and request-line
>    `budgetAllocation` are none of them in `HEAD`. All are paused,
>    uncommitted integration work; the proposed target is a **company-scoped**
>    ItemAccountingProfile. The audit reads the mapping collection as optional
>    (absence = `MAPPING_COLLECTION_ABSENT` per company — unknown coverage,
>    never `CATEGORY_NEVER_REVIEWED`) and is **company-safe**, evaluating
>    every company in the committed company master including those with no
>    budget configuration at all: an override whose ledger belongs to another company is
>    `ITEM_OVERRIDE_COMPANY_MISMATCH` and the item still falls through to that
>    company's category coverage, never excluded from it. It also reports
>    override target companies, missing ledgers, unverifiable ownership, and
>    that every override is structurally unsafe because RawItem has no company
>    scope. **Discovered risk documented, not fixed:** the paused resolver
>    returns an item override before validating the ledger's company. Those
>    files were not modified or reverted.
> 8. **Barcode identity across the whole future namespace**: product-code
>    collisions item-vs-item, variant-vs-variant and item-level-vs-variant-
>    level, reported **separately** from printed lot instances (the
>    `barcodes` collection, identified by document `_id`), which are a
>    different concept and cannot collide — with one narrow cross-check for
>    an ObjectId pasted into a barcode field.
>
> The technical correction pass is recorded in audit doc §14; the item-master
> measurements and their limitations in §13; budget-attribution statuses,
> company-universe rules and mapping-absence semantics in §12.5a. The final
> pass repaired the human-readable Item Master summary (it was consuming a
> stale budget shape and printing seven `undefined` values), completed the
> company universe from the committed company master, corrected
> mapping-absence semantics, and extended the read-only proof to every
> collection the runner may read — which surfaced and fixed a latent bug
> where the outer report never forwarded the optional collections.
>
> Known-unsafe behaviour was characterised, documented (audit doc §10) and
> deliberately NOT fixed. No Item schema was implemented — that is Chunk 2.
> Pre-existing unrelated failure: `services/salesJourneyOutcome.test.js`
> (sales scope, committed, untouched by this chunk).
>
> **Next after Chunk 1:** Chunk 2 — professional master data (Item,
> ItemVariant, categories, UoM, SupplierItem, warehouse/location). Do not
> begin it before it is separately scoped and requested.
>
> **Paused:** Department-head budget app Chunk 2 and item-wise budget
> attribution after its foundation chunk. Their existing briefs remain durable
> context. Store/Purchase Chunk 8 deliberately reconnects procurement to the
> final item-wise budget model after the operational foundations are sound.
>
> **Previous paused scope — Department-head budget app:** Build a
> department-head budget app whose UI matches the finance/accountant budget
> app. Its planning brief remains
> `docs/tasks/department-head-budget-app.md`.
>
> **Chunk 1:** Shipped. Department app entry + proposals, reusing the existing
> `/api/budget-proposals` server boundary and shared frontend body.
>
> **Paused next step:** Chunk 2 - approved-budget tracking for the department's
> own approved lines and evaluated actuals.
>
> ---
>
> **Previous paused work:** Redesign the full Accounting app in
> `/Users/risheeray/grav-cms` so it follows the current Sales app design
> language. The active planning brief is
> `docs/tasks/accountant-sales-design-redesign.md`.
>
> **Important:** The Sales lead/journey scope below remains durable context, but
> it is not the active implementation target while the Account Budget feature is
> being planned.

> **Previous status before pause:** Active
>
> **Product model (current, supersedes the older 6-chunk plan below):**
> Prospect (a possible buyer we've found and are still preparing to work) and
> Active Lead (one we're actively researching, contacting and qualifying) are
> the SAME `Lead` record — internal `captureStatus: draft`/`active` is
> unchanged; "Prospect" is a user-facing rename only, no field rename, no
> migration. Sales Journey is unaffected: a qualified, specific commercial
> requirement being pursued, created only after qualification (Chunk 5).
>
> **Chunk plan:**
>
> 1. Prospect capture and setup — **done, including the follow-up correction
>    pass.**
> 2. Active Lead activities and controlled statuses — **not formally started
>    as its own chunk, but a meaningful part of it already exists**: see
>    "What Chunk 2 inherits" below. Not yet done: reviewing whether the
>    inherited work fully satisfies Chunk 2's intent.
>
>    **Superseded (5 Sep 2026):** this used to say no editable identity/contact
>    surface existed for an Active Lead. It does now. `EditLeadDrawer.js` and
>    `app/sales/dashboard/leads/[id]/edit/page.js` render the SAME section
>    components as the Prospect form — `WhoTheyAreSection`, `ContactSection`,
>    `OriginSection`, `WhatTheyMightNeedSection` — so every field captured
>    before conversion stays editable after it. It is one record.
> 3. Requirement, commercial potential and qualification — partially
>    inherited (see below); not formally scoped as its own chunk.
> 4. Secure evidence/document handling — **not started.** The old,
>    unsecured Cloudinary-upload evidence path was hidden from the UI in the
>    correction pass (`EvidenceSection` in `leadSections.js`) rather than
>    presented as if complete; Source URL / Document reference text fields
>    remain available.
> 5. Conversion to Account, Contact and Sales Journey — **not started.**
>
> **Instruction:** Do not implement Chunk 2 (or any later chunk) as new work
> without it being separately scoped and requested — the items above
> describe what already exists, not a green light to proceed. When Chunk 2
> is actually taken up, start by reviewing what's listed below rather than
> assuming a blank slate.
>
> **Superseded:** `docs/tasks/lead-to-journey-roadmap.md`'s six-chunk
> breakdown ("Chunk 1 — Lead foundation", "Chunk 2 — Lead Inbox and quick
> capture", …) is an EARLIER numbering scheme for the same overall Lead →
> Sales Journey arc. The product model and chunk list above are what's
> current; that file's own status line has been marked superseded but its
> body was not rewritten.

# What exists today (for whoever picks up Chunk 2 next)

## Inherited from the "Lead correction chunk" (predates the 5-chunk product
## model above, but lands squarely inside Chunk 2/3's territory)

- Canonical qualification vocabulary: `new → contactAttempted → contacted →
  qualified/nurture/disqualified/duplicate → readyToConvert` (`new` may also
  reach `contacted` directly for the one-call-and-it-connects case).
- Every transition's prerequisite is enforced server-side in
  `services/leadQualification.js`, not only the UI: Contact Attempted needs a
  logged outreach attempt; Contacted needs a genuinely successful two-way
  contact; Nurture needs a reason + next action + follow-up date; Qualified/
  Ready to Convert share one checklist
  (`services/leadReadiness.js`'s `computeQualificationReadiness`); Duplicate
  requires a genuine, existence-verified Lead/Account link.
- Structured Activity outcomes (`no_answer`/`replied_connected`/
  `meeting_completed`/`other`), `lastContactedAt` gated on a genuinely
  successful contact, Draft Leads blocked from having Activities.
- `Lead.requirementCertainty` (confirmed-requirement side, separate from the
  researched-potential confidence fields) exists but has no UI beyond what
  `LeadWorkspace.js`'s "Supporting details" already shows.
- Manager-only owner/source reassignment; employee names always server-
  derived, never client-trusted.
- The full frontend for this lives in `LeadWorkspace.js` (Active Lead
  workspace) — "Move this lead", the qualification checklist, the duplicate
  picker, structured outcome dropdown are all already built and verified.

## What Chunk 2 (as newly scoped) still needs, if/when it's taken up

- Decide whether the inherited qualification/activity work above already
  satisfies Chunk 2's intent, or whether it needs revision now that the
  product model has Prospect/Active Lead terminology and a 5-item "Start
  Working Lead" bar that didn't exist when it was built.
- ~~An Active Lead identity/contact editing surface~~ — done (5 Sep 2026);
  the Lead edit surfaces render the Prospect form's own sections.
- Whatever else Chunk 2 is scoped to cover once that scoping happens —
  nothing below this line should be treated as decided until it is.
