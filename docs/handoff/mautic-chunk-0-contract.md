# Mautic integration contract — Marketing Chunk 0

**Date:** 9 September 2026; **live verification 10 September 2026**
**Status:** **VERIFIED LIVE.** Contract recorded, proved synthetically, then
proved end to end against a deployed Mautic 7.2.0 instance.
**Governs:** ADR-004. Roadmap position: `docs/tasks/marketing-mautic-roadmap.md` Chunk 0.

> **Read this first.** A Mautic 7.2.0 instance is deployed and running locally,
> and the full round trip has completed against it — including a webhook Mautic
> itself signed and delivered. §13 records the live run. §11 records what the
> live instance did **differently** from what the source reading predicted,
> including one defect in GRAV's translator that only a real payload exposed.

---

## 1. Exact version

| Component | Pinned | Source |
|---|---|---|
| Mautic | `7.2.0` "Lynx Edition", published 2026-09-02 | `github.com/mautic/mautic` releases API |
| Image | `mautic/mautic:7.2.0-20260902-apache` @ `sha256:dea3bb71…03a0f` | Docker registry manifest |
| PHP | `~8.2`; ext `iconv`, `imap`, `pdo`, `zip`, `zlib` | `mautic/core-lib` 7.x `composer.json` |
| Database | MariaDB `11.4.13-noble` @ `sha256:611a2fcc…26430` | Docker registry manifest |
| Mail sink | Mailpit `v1.31.1` @ `sha256:98b916bd…95365` | Docker registry manifest |

`7.2.0` is the current stable 7.x. `7.1.3` is the previous stable and the
documented fallback. `7.2.0-rc` is a prerelease and is not deployable.

## 2. Deployment topology

`deploy/mautic/docker-compose.yml`. Three services on two networks:
MariaDB and Mailpit on an internal network with **no published port**, Mautic
bridging to an edge network and published on `127.0.0.1:8088` only.

GRAV holds **no database credential and no route to MariaDB**. "Do not read or
write Mautic's database directly" is enforced by the topology, not by
convention. Full detail and the operational drills are in
`deploy/mautic/README.md`.

## 3. Environment variables

GRAV side — `deploy/mautic/grav.env.example`:

```
MAUTIC_BASE_URL              MAUTIC_AUTH_MODE          (oauth2 | basic)
MAUTIC_OAUTH_CLIENT_ID       MAUTIC_OAUTH_CLIENT_SECRET
MAUTIC_BASIC_USERNAME        MAUTIC_BASIC_PASSWORD
MAUTIC_WEBHOOK_SECRET        MARKETING_COMPANY_ID
MAUTIC_TEST_SEGMENT          MAUTIC_HTTP_TIMEOUT_MS
MAUTIC_HTTP_RETRIES          MAUTIC_WEBHOOK_MAX_PER_MINUTE
MARKETING_DISCOVERY_PROVIDER
```

Mautic stack side — `deploy/mautic/mautic.env.example`:

```
MAUTIC_DB_ROOT_PASSWORD  MAUTIC_DB_NAME   MAUTIC_DB_USER   MAUTIC_DB_PASSWORD
MAUTIC_BASE_URL          MAUTIC_HTTP_PORT
MAUTIC_ADMIN_USERNAME    MAUTIC_ADMIN_EMAIL  MAUTIC_ADMIN_PASSWORD
MAILSINK_UI_PORT
```

Neither example file contains a value. Both are named so they escape the
`.gitignore` rule that refuses every `.env.*` path — a file that silently fails
to be committed is worse than one with an awkward name.

## 4. Authentication

**OAuth2 client_credentials** (preferred):

```
POST /oauth/v2/token
Content-Type: application/x-www-form-urlencoded
grant_type=client_credentials&client_id=…&client_secret=…
→ 200 { "access_token": "…", "expires_in": 3600, "token_type": "bearer" }
```

The token is cached until 60 seconds before expiry. A token that expires
between the check and the call produces a 401 indistinguishable from a revoked
credential.

**HTTP basic** is supported for a development instance:
`Authorization: Basic base64(user:pass)`.

`MAUTIC_AUTH_MODE` is validated at start-up and refused if unknown. A mistyped
scheme that silently falls back to the weaker one is a downgrade nobody sees.
Plain `http` to a non-local host is refused outright.

## 5. Supported endpoints used

Verified against `mautic/core-lib` 7.x — `bundles/LeadBundle/Config/config.php`
and the API functional tests, not from documentation.

| Purpose | Call |
|---|---|
| Find by email | `GET /api/contacts?where[0][col]=email&where[0][expr]=eq&where[0][val]=…&limit=2&minimal=true` |
| Create | `POST /api/contacts/new` |
| Update | `PATCH /api/contacts/{id}/edit` |
| List segments | `GET /api/segments?limit=200` |
| Enrol | `POST /api/segments/{id}/contact/{contactId}/add` |
| Prove enrolment | `GET /api/contacts/{id}/segments` |

`where[]`, never `search=`. `search` is a fuzzy full-text match and a fuzzy
match is not an identity rule — the cost of getting it wrong is writing one
person's details onto another's record.

`PATCH`, never `PUT`. `PUT` on this endpoint is a full replacement and would
blank every field GRAV did not send.

### Request and response fields

**Outbound projection — an allowlist, and the whole of it:**

```
email  firstname  lastname  company  phone  website  country  position
grav_person_key        (custom contact field; carries GRAV's opaque key)
```

Anything not on this list is dropped before the request is built, so a caller
cannot widen the contract by passing extra keys. No commercial field, no
lifecycle state, no requirement and no internal note is ever sent — Mautic is
not a second customer master.

**Responses:**

* `GET /api/contacts` → `{ total, contacts: { "<id>": {…} } }`
  — an **object keyed by id**, not an array.
* `POST /api/contacts/new` → **200** (not 201) `{ contact: { id, fields: { all: {…} }, … } }`
* `PATCH /api/contacts/{id}/edit` → `200 { contact: {…} }`
* `GET /api/segments` → `{ total, lists: { "<id>": { id, name, alias } } }`
* `POST /api/segments/{id}/contact/{cid}/add` → `200 { success: true }`
  — **the same answer whether or not the contact was already a member.**

Every one of those shapes was **confirmed against the live instance** on
10 September 2026, including the two that most often break an integration: the
object-keyed collection and the 200-not-201 on create.

## 6. Contact identity-matching rule

In order, and the order is the design:

1. **The mapping row.** If `MarketingIdentity.externals` already names a Mautic
   contact id for this GRAV person, that contact **is** the person. No search
   runs.
2. **One exact email match.** `where[0][col]=email&expr=eq`.
3. **Create.**

The mapping is written after 1, 2 or 3, so the next call takes path 1 and never
searches again.

**The durable key is an opaque GRAV person key, never the email address**
(product plan §10). People change jobs and addresses get reassigned to their
successor; an integration keyed on the address silently starts writing to
somebody else, and nothing about that failure looks like a failure. A test
covers exactly this: a person whose email changes keeps one contact.

**Consent is checked before anything is written.** Only `opted_in` and
not-suppressed may be projected. Deliberately stricter than the handover gate,
which allows `unknown` because a handover is a person-to-person introduction
rather than a marketing send.

## 7. Segment enrolment method

Resolve alias → id via `GET /api/segments`, `POST …/add`, then **read
membership back** with `GET /api/contacts/{id}/segments`.

The read-back is not belt and braces. Mautic answers `{success:true}` whether
or not the call changed anything, so the write's own answer cannot distinguish
"enrolled" from "accepted and quietly did nothing".

## 8. Webhook events and payload

**Signature — the detail most likely to be got wrong:**

```php
base64_encode(hash_hmac('sha256', $jsonPayload, $secret, true))
```

sent in a **`Webhook-Signature`** header
(`bundles/WebhookBundle/Http/Client.php`). **Base64, not hex. Not
`X-Hub-Signature-256`.** An endpoint written to the GitHub/Meta convention
rejects every genuine delivery, and the symptom — 401s that look like a wrong
secret — sends people to rotate a credential that was never the problem.

GRAV verifies over the **raw bytes** and accepts base64 or hex across
`Webhook-Signature`, `x-mautic-signature` and `x-hub-signature-256`. Both
encodings are compared against the same HMAC, so accepting two widens the
format and not the trust. **With no secret configured, everything is
rejected.**

**Envelope — many events per POST, grouped by type:**

```json
{
  "mautic.form_on_submit": [ { "submission": { … }, "timestamp": "…" } ],
  "mautic.page_on_hit":    [ { "hit": { … },        "timestamp": "…" } ]
}
```

An intake reading the body as a single event silently drops everything after
the first.

**Types translated in this chunk:**

| Mautic type | GRAV kind | Dedupe key | Timestamp |
|---|---|---|---|
| `mautic.form_on_submit` | `form_submitted` | `submission.id` | `submission.dateSubmitted` |
| `mautic.page_on_hit` (with `hit.email`) | `email_clicked` | `hit.id` | `hit.dateHit` |
| `mautic.page_on_hit` (without) | `page_viewed` | `hit.id` | `hit.dateHit` |
| `mautic.email_on_open` | `email_opened` | `stat.id` | `stat.dateRead` |

Everything else — `mautic.lead_post_save_*`, `mautic.email_on_send`,
`mautic.lead_channel_subscription_changed` — is reported as **ignored, by
name**. Unsubscribe and bounce suppression is Chunk 2's; mapping it here
without the suppression behaviour behind it would record a withdrawal of
consent that nothing acts on.

**Source event id.** Mautic injects only `timestamp` into an item; there is no
delivery id and no queue id. So the id is **derived** as
`"<type>:<record>:<id>"`, e.g. `mautic.form_on_submit:submission:902`. The type
is part of the key because two event families could otherwise collide on a
shared numeric id.

An item whose record has **no id is rejected**, never stored under an invented
one. An id we made up cannot deduplicate anything, and storing it anyway would
make the ledger's guarantee quietly false for exactly the events most likely to
be replayed. An item naming no contact is rejected for the same reason: it
cannot be attributed to anybody.

## 9. Retry and failure behaviour

**Outbound.** Retryable: transport errors (`ECONNREFUSED`, `ETIMEDOUT`,
`ECONNRESET`, `EAI_AGAIN`, …) and statuses 408, 425, 429, 500, 502, 503, 504.
Bounded by `MAUTIC_HTTP_RETRIES` (default 2, max 5) with exponential backoff
capped at 2 s.

**Terminal — never retried.** 400/422 is a statement about the request, and
retrying it is a way of making the same mistake more times. 401/403 is a
credential problem a retry cannot fix and that hammering may lock out.

Failures map to distinct codes so a screen can tell them apart:

| Code | Status | Means |
|---|---|---|
| `MAUTIC_UNAVAILABLE` | 503 | nothing could be asked — **this is not an empty result** |
| `MAUTIC_AUTH_FAILED` | 502 | Mautic answered and refused GRAV's credential |
| `MAUTIC_NOT_CONFIGURED` | 409 | a deployment secret is missing or malformed |
| `MAUTIC_REJECTED_WRITE` | 422 | Mautic rejected the write; its own field errors travel in `details` |

**Inbound.** A terminal validation failure answers **200 with the rejection
listed**, so Mautic stops resending an event that will never be accepted.
Rate-limited per IP (`MAUTIC_WEBHOOK_MAX_PER_MINUTE`, default 300); the
signature is what stops a forged event being believed, the limit is what stops
an unsigned flood costing anything to reject.

**Never a false zero.** Every count is `null` when it could not be read. The
product plan says it twice, and a health endpoint is the likeliest place to
break the rule because a dashboard wants a number and `0` fits.

## 10. Health-check behaviour

`GET /api/cms/marketing/health` (Marketing session required — the report names
the base URL and says which credential was refused).

Five checks reported **separately**, because each needs a different person:
`configuration`, `reachability`, `authentication`, `api`, `database`. Each is
`ok` / `failed` / `unknown` with the detail that established it. A
configuration failure leaves the rest `unknown`, not `failed`, so nobody is
sent to look at Mautic when the fix is an environment variable.

Answers **200 whatever it finds**. A health check that 503s when its subject is
down cannot be told apart from a health check that is itself down.

Mautic's database is checked **through** Mautic — a segment list is a
database-backed read — and the report says that is what it is rather than
claiming a direct check GRAV has no credential to perform.

The webhook side reports `secret: configured | missing` plus `lastEventAt` and
`eventCount`, and deliberately never says `ok`: a secret that is set is not a
webhook that works, and the only proof one is wired up is a delivery that
arrived.
## 11. What the live instance did differently

The source reading was mostly right. Three things it got wrong, and one thing
the image gets wrong, were found only by running it.

### 11.1 The webhook payload does not carry a flat contact email — A REAL DEFECT

Predicted: `stat.lead.email`, or `stat.lead.fields.all.email` as the REST API
returns.

Observed: **neither exists.** The webhook serializer emits field **groups**, each
holding a full descriptor per field:

```json
"stat": {
  "emailAddress": "chunk0.live@grav-integration-test.invalid",
  "lead": {
    "id": 1,
    "fields": {
      "core": {
        "email": { "id": "3", "label": "Email", "alias": "email",
                   "type": "email", "group": "core",
                   "value": "chunk0.live@…", "normalizedValue": "chunk0.live@…" },
        "grav_person_key": { "alias": "grav_person_key", "value": "c520b9…" }
      },
      "social": {}, "personal": {}, "professional": {}
    }
  }
}
```

`services/marketing/mauticWebhookContract.js` looked only at `contact.email` and
`contact.fields.all.email`. It found neither and **recorded the event with an
empty email address**, attribution surviving only because the contact id was also
present. A handover built from such a row would have had no address for Sales to
write to — a silent data-quality failure that no amount of synthetic testing
would have caught, because the double returned the shape the code expected.

Fixed: `contactEmailOf()` now checks `email`, `fields.all.email`, then
`fields.{core,professional,personal,social}.email.{value,normalizedValue}`, and
finally an event-specific fallback (`stat.emailAddress`). The real payload is
committed as `test/marketing/fixtures/mautic-7.2.0-email-open.json` and four
tests assert against it, including one that asserts the fixture really has no
flat email so it cannot quietly become a straw man.

### 11.2 The private-address allowlist is exact-string, not CIDR

`webhook_allowed_private_addresses` is documented as a list of addresses, and
`PrivateAddressChecker::isAllowedUrl` matches it with **`in_array()`** against
the URL host and against each resolved IP. **CIDR notation does not work.**
`192.168.5.2/32` matches nothing.

Worse, `isPrivateUrl()` returns true for the literal host **`localhost`** before
any IP resolution, so a `http://localhost:5055/...` callback is refused outright
and no allowlist entry can rescue it.

Working configuration:

```php
'webhook_allowed_private_addresses' => ['host.docker.internal', '192.168.5.2'],
```

with the webhook URL written as
`http://host.docker.internal:5055/api/cms/marketing/events`. The hostname
matches on the direct string check; the IP is listed as a fallback in case the
alias resolves differently after a VM restart.

### 11.3 The official 7.2.0 image is missing two production dependencies

`EmailBundle/Validator/ValidEmailLinksValidator.php` constructs
`Symfony\Component\DomCrawler\Crawler` unconditionally for any email with
HTML, and then calls `->filter()` on it, which needs the CSS selector component.
Neither is installed in `mautic/mautic:7.2.0-…-apache`, and neither is a
production requirement of `mautic/core-lib` — they appear in `composer.lock`
only inside other packages' dev and conflict blocks.

The effect: **creating or editing any email 500s**, through the API and through
the UI alike, with `Class "Symfony\Component\DomCrawler\Crawler" not found`.
This is an upstream packaging bug, not a configuration mistake.

Workaround, inside the container:

```bash
composer require symfony/dom-crawler:^7.3 symfony/css-selector:^7.3 --no-scripts
```

`/var/www/html/vendor` is **not** on a volume, so this is lost whenever the
container is recreated. `deploy/mautic/README.md` §3 carries it as a required
post-`up` step.

### 11.4 Webhooks are queued unless told otherwise

Default `queue_mode` defers delivery to `bin/console mautic:webhooks:process`.
Set `'queue_mode' => 'immediate_process'` so a delivery arrives as part of the
act that caused it. Without it the round trip times out waiting for a webhook
that is sitting in a queue.

### 11.5 Confirmed exactly as predicted

* Signature: `Webhook-Signature: base64(HMAC-SHA256(rawBody, secret))`, and the
  header arrives lowercased as `webhook-signature` with `User-Agent: Webhook`.
* Envelope: `{ "<type>": [ { …, "timestamp": "…" } ] }`, grouped by type.
* No event id of its own — the derived `"<type>:<record>:<id>"` key worked
  unchanged against real data (`mautic.email_on_open:stat:16`).
* `contacts` and `lists` keyed by id; `POST …/new` answers 200, not 201;
  a repeat segment add answers `{success:true}`.
* `grav_person_key` is accepted on a contact write, stored, and **readable back
  out of Mautic** — the gap that mattered most, because it is what lets the
  identity mapping be rebuilt from Mautic's side after a restore.
* One `email_on_open` delivery is **8,162 bytes** for a single event. The
  serializer emits every contact field descriptor, so a busy instance will post
  considerably more than the useful payload.

### 11.6 Still not exercised

* **OAuth2.** There is no API for creating an OAuth2 client — `ApiBundle`
  exposes none — so it is a UI-only step. The live proof used HTTP basic auth
  with the least-privilege user. The OAuth2 code path is unit-tested against the
  double but has never held a real Mautic token.
* **`mautic.form_on_submit` and `mautic.page_on_hit`** were not fired live. Both
  translators are exercised by unit tests, and `email_on_open` proved the
  envelope, signature and field-group shape they share. A form submission would
  additionally prove `submission.results`.
* **Upgrade migrations.** No 7.1.3 → 7.2.0 rehearsal has run.
* **Pagination beyond 200 segments**, and Mautic's own API rate limits.
* **Backup and restore**, as a drill. The procedure is written; it has not been
  performed.

## 12. The infrastructure blocker — RESOLVED

It was: no container runtime, no PHP, no relational database.

Resolved on 10 September 2026 by installing **Colima**, not Docker Desktop, at
the user's explicit choice. Docker Desktop was the stated preference but its
first launch requires accepting the Docker Subscription Service Agreement in a
GUI and an administrator password for its privileged helper — both user-gated
steps that would have stopped the task mid-way. Colima needs neither.

| Component | Version | Source |
|---|---|---|
| Colima | 0.10.3 | homebrew-core |
| Lima | 2.2.0 | homebrew-core (Colima dependency) |
| Docker CLI | 29.8.0 | homebrew-core |
| Docker Compose | 5.5.1 | homebrew-core |
| Docker Engine (in VM) | 29.5.2 | Colima's VM |

`colima start --vm-type vz --cpu 4 --memory 6 --disk 40` — Apple's
Virtualization framework, 4 vCPU, 6 GB, 40 GB, virtiofs mounts. Host is an
Apple M4, `arm64`, macOS 26.5.1.

**No image needed replacing.** All three pinned images publish native
`linux/arm64` builds, so nothing runs under emulation and the versions pinned
before any runtime existed stood unchanged.

Two notes for anyone repeating this:

* `docker-compose` from Homebrew is a CLI **plugin**. It must be registered in
  `~/.docker/config.json` under `cliPluginsExtraDirs` or `docker compose` is
  "unknown command".
* `host.docker.internal` resolves inside the container (to `192.168.5.2` here)
  and reaches a host process bound to `127.0.0.1`. That is what makes a
  Docker-to-host webhook callback possible without exposing anything.

## 13. The live round trip

```text
node -r dotenv/config scripts/marketing/mautic-round-trip.js
→ 11 passed, 0 failed, exit 0

  0  health ............ configuration=ok reachability=ok authentication=ok
                         api=ok database=ok
  1  consented person .. key 5db8f971484c4f9d70a86b29
  2a create contact .... Mautic contact 5, matchedBy=created
  2b idempotent update . matchedBy=identity_mapping, 1 contact for that email
  3  identity mapping .. GRAV→5, grav_person_key readable back out of Mautic
  4  segment enrolment . segment 1, membership read back
  5  mail sink ......... sentCount=5 failed=0, arrived in Mailpit, every
                         recipient on a reserved .invalid domain
  6  REAL webhook ...... mautic.email_on_open:stat:16, signed by Mautic,
                         attributed to this run's own contact and address
  7  recorded once ..... 1 ledger row for that delivery
  8  replay ............ status 200, recorded 0, duplicates 1, still 1 row
  9  no Sales record ... 0 leads, 0 enquiries, 0 journeys, 0 accounts
```

Step 6 is the step that could not be faked: the email was sent by Mautic into
the sink, the tracking pixel in the delivered message was fetched, Mautic
generated the open event, signed it, and posted it to GRAV's real Marketing
route, which verified the signature over the raw bytes and recorded it once.

A synthetic run of the same script exits **64**, not 0, and says on every run
that it is not evidence of a live integration.

### What the live run needs

The webhook needs somewhere to arrive. `scripts/marketing/mautic-webhook-listener.js`
mounts **only** the real Marketing router — production signature check,
production envelope translation, production intake ledger — behind the same
global `express.json({ verify })` that `server.js` installs, against a
disposable in-memory MongoDB. Running `server.js` itself would have connected to
the shared development MongoDB and Firestore, seeded users, registered two crons
and read an entire Firestore collection on boot, none of which proving one
webhook requires.

The ledger rows are real rows written by real code. They are simply not written
into shared data.

### Negative cases, all live

| Case | Result |
|---|---|
| Replay of a correctly signed delivery | 200, `recorded 0, duplicates 1`, ledger unchanged |
| Wrong webhook secret | 401, nothing recorded |
| Tampered body, valid signature for the original | 401, nothing recorded |
| No signature at all | 401, nothing recorded |
| Invalid Mautic credentials | `MAUTIC_AUTH_FAILED` 502, not retried |
| Mautic unreachable | `MAUTIC_UNAVAILABLE` 503, **not an empty list** |
| Health with Mautic down | `healthy:false`, `segmentCount:null`, database `unknown` |
| Missing `grav_person_key` | 400 before any call is made |
| Non-opted-in or suppressed person | 403 before any call is made |

### Least privilege, verified

The `grav-integration` user (role "GRAV Integration", `isAdmin:false`):

```text
GET /api/contacts   200      GET /api/users      403
GET /api/segments   200      GET /api/roles      403
                             GET /api/emails     403
                             GET /api/campaigns  403
                             GET /api/forms      403
                             GET /api/pages      403
                             GET /api/hooks      403
                             POST /api/emails/1/send  403
```

GRAV can read and write contacts and enrol them in segments. It cannot read a
campaign, cannot read the webhook it receives from, and **cannot send email**.
Sending in step 5 used the admin credential from `deploy/mautic/.env`, because
sending is deliberately outside what GRAV may do.

### Network exposure, verified

```text
mautic    127.0.0.1:8088 → 302        10.99.21.109:8088 → refused
mailpit   127.0.0.1:8025 → 200        10.99.21.109:8025 → refused
mariadb   container-internal only, nothing published
host      nothing listening on 3306
```

MariaDB sits on a compose network with no published port. Mailpit's SMTP (1025)
is likewise internal. Nothing is reachable from the LAN.
