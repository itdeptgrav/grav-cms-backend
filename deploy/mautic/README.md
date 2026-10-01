# Mautic development instance — deployment and operations

**Chunk 0 of `docs/tasks/marketing-mautic-roadmap.md`.** Governed by ADR-004.

This directory deploys one **isolated Mautic development instance** beside the
GRAV backend. Mautic is a separate application with its own PHP runtime and its
own relational database. No Mautic code enters the GRAV Node backend, and GRAV
never opens a connection to Mautic's database.

---

## 1. Exact version

| Component | Pinned to | Verified |
|---|---|---|
| Mautic | `7.2.0` "Lynx Edition" | github.com/mautic/mautic release, published 2026-09-02 |
| Image | `mautic/mautic:7.2.0-20260902-apache` | digest `sha256:dea3bb71a5c5bf4c0c7d1764e58a32109898e7b2e6a710f14f50e2a913c03a0f` |
| PHP | `~8.2` with `iconv`, `imap`, `pdo`, `zip`, `zlib` | `mautic/core-lib` 7.x `composer.json` |
| Database | MariaDB `11.4.13-noble` | digest `sha256:611a2fcc5fa7c6ceb8644c6f74b25ede004ff6c3a6b38c8f8c23d3bbf6c26430` |
| Mail sink | Mailpit `v1.31.1` | digest `sha256:98b916bd3c8d61f7633a52d3ea2f58d00620cb01ca57ab59edde68c347a95365` |

All three images are pinned **by digest**, not by tag. A tag is a pointer
somebody else can move, and the first symptom of that is an integration
contract that changed with nobody editing this repository.

`7.1.3` (2026-07-07) is the previous stable and the documented fallback if
7.2.0 proves unstable in staging. `7.2.0-rc` is a prerelease and must not be
deployed.

---

## 2. Topology

```text
        ┌───────────────────────── host (127.0.0.1 only) ─────────────────────────┐
        │                                                                          │
GRAV ───┼──► :8088  mautic          ── mautic-edge ──┐                             │
Node    │           (PHP 8.2/Apache)                 │                             │
backend │                 │                          │                             │
        │                 └──────── mautic-internal ─┴─► mautic-db  (MariaDB)      │
        │                                            └─► mailsink   (Mailpit)      │
        │           :8025  mailpit UI                                              │
        └──────────────────────────────────────────────────────────────────────────┘
```

* **`mautic-internal`** publishes no port. MariaDB lives only here, so "GRAV
  must not read Mautic's database" is enforced by the topology rather than by
  everyone remembering it.
* Both published ports bind to `127.0.0.1`. A development Mautic on `0.0.0.0`
  is an open marketing platform on the office network.
* **Mail goes nowhere.** Mailpit accepts every message and delivers none. There
  is no credentialed path off the host, so a campaign cannot reach a real
  person even if one is triggered by accident.

---

## 2a. The container runtime

**Verified working on Colima**, not Docker Desktop — Apple M4, `arm64`,
macOS 26.5.1:

```bash
brew install colima docker docker-compose
colima start --vm-type vz --cpu 4 --memory 6 --disk 40
```

| Component | Version |
|---|---|
| Colima | 0.10.3 (Lima 2.2.0) |
| Docker CLI | 29.8.0 |
| Docker Compose | 5.5.1 |
| Docker Engine in the VM | 29.5.2 |

Colima was chosen over Docker Desktop because it needs **no administrator
password and no GUI licence acceptance**, so the stack can be brought up
unattended. Docker Desktop works too; its first launch requires accepting the
Docker Subscription Service Agreement and an admin password for its privileged
helper, and it carries commercial-licence conditions for larger organisations.

Two things that will otherwise waste an hour:

* **`docker compose` is a plugin.** Homebrew's `docker-compose` must be
  registered or the subcommand does not exist:

  ```json
  // ~/.docker/config.json
  { "cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"] }
  ```

* **All three images publish native `linux/arm64` builds**, so nothing runs
  under emulation on Apple Silicon and the pinned digests need no change.

## 3. Bringing it up

```bash
cd deploy/mautic
cp mautic.env.example .env          # then fill in real values
docker compose up -d
docker compose ps                   # every service must report healthy
```

### Install Mautic

The image does not install itself. Run its own installer once:

```bash
docker compose exec -T -w /var/www/html mautic php bin/console mautic:install \
  "http://localhost:8088" \
  --db_driver=pdo_mysql --db_host=mautic-db --db_port=3306 \
  --db_name=mautic --db_user=mautic --db_password="<MAUTIC_DB_PASSWORD>" \
  --admin_firstname=GRAV --admin_lastname=Admin \
  --admin_username="<MAUTIC_ADMIN_USERNAME>" \
  --admin_email="<MAUTIC_ADMIN_EMAIL>" \
  --admin_password="<MAUTIC_ADMIN_PASSWORD>" \
  --force --no-interaction
```

### Install the two missing production dependencies

**Required.** `mautic/mautic:7.2.0-…-apache` ships without
`symfony/dom-crawler` and `symfony/css-selector`, yet
`EmailBundle/Validator/ValidEmailLinksValidator.php` needs both in production.
Without them, **creating or editing any email 500s** — through the API and
through the UI alike. Neither is a declared production requirement of
`mautic/core-lib`; this is an upstream packaging bug in 7.2.0.

```bash
docker compose exec -T -w /var/www/html -e COMPOSER_ALLOW_SUPERUSER=1 mautic \
  composer require symfony/dom-crawler:^7.3 symfony/css-selector:^7.3 \
  --no-interaction --no-scripts
```

`/var/www/html/vendor` is **not** on a volume, so this must be repeated whenever
the container is recreated.

### Configure it

```bash
docker compose exec -T -w /var/www/html mautic php -r '
$f="config/local.php"; require $f; $p=$parameters;
$p["mailer_dsn"]="smtp://mailsink:1025";
$p["mailer_from_name"]="GRAV Marketing Dev";
$p["mailer_from_email"]="marketing@grav-integration-test.invalid";
$p["messenger_dsn_email"]="sync://";
$p["api_enabled"]=true;
$p["api_enable_basic_auth"]=true;
$p["queue_mode"]="immediate_process";
$p["webhook_allowed_private_addresses"]=["host.docker.internal","192.168.5.2"];
file_put_contents($f,"<?php\n\$parameters = ".var_export($p,true).";\n");'
```

### Rebuild the cache AS www-data

**This matters.** Running `cache:clear` or `cache:warmup` as root (which
`docker compose exec` is by default) leaves root-owned cache directories that
Apache cannot write, and every API call then 500s with
`The directory ".../var/cache/prod/jms_serializer_default" is not writable` —
which looks like a Mautic permissions bug and is actually this:

```bash
docker compose exec -T -w /var/www/html mautic sh -lc '
  rm -rf var/cache/prod; chown -R www-data:www-data var config vendor
  su -s /bin/sh www-data -c "php bin/console cache:warmup --env=prod"'
docker compose restart mautic
```

### Provision the rest

Everything below — the least-privilege role and user, the `grav_person_key`
field, the test segment, the webhook and a probe email — is created by one
idempotent script. Re-run it any time to check an instance is still configured:

```bash
node scripts/marketing/mautic-provision-dev.js
```

Then, in the GRAV backend's own `.env`, add the variables from
`grav.env.example`. Those are GRAV's credentials for **calling** Mautic and do
not belong in `deploy/mautic/.env`.

Generate every password with something you did not choose yourself:

```bash
openssl rand -base64 30
```

### What the provisioning script creates

| Thing | Why it must exist |
|---|---|
| Role "GRAV Integration" | §4 — least privilege |
| User `grav-integration` | the identity GRAV authenticates as |
| Custom field `grav_person_key` | without it Mautic **silently drops** GRAV's opaque key from a contact write, and the identity mapping then exists only in MongoDB with no way to rebuild it from Mautic's side |
| Segment `grav-integration-test` | the round trip's audience |
| Webhook → GRAV | §6 |
| Probe email | a harmless message for the send proof |

### Generating credentials — read this before you run `openssl rand`

Keep every value in `.env` inside `[A-Za-z0-9-_.~]`.

`docker compose` parses the file literally. POSIX `source` / zsh `.` does **not**:
a value containing `* ? [ ] ( ) { }` or `!` is glob-expanded, and an
unterminated bracket pattern **swallows the rest of the file into the variable**.
That is not theoretical — on the first attempt at this deployment it installed
Mautic with a 205-character multi-line admin password that could not be
reproduced from the file, and the stack had to be rebuilt. Read `.env` with a
compose-style parser; both `scripts/marketing/*.js` do.

```bash
# safe
python3 -c "import secrets,string;A=string.ascii_letters+string.digits+'-_.~';print(''.join(secrets.choice(A) for _ in range(36)))"
```

---

## 4. The least-privilege integration identity

GRAV **must not** authenticate as the administrator. Create a role and a user
that can do exactly what the integration does and nothing else.

**Role** (Settings → Roles → New), full system access **off**:

| Permission | Grant | Why |
|---|---|---|
| Contacts → Contacts | View own+others, Edit own+others, Create | create-or-update the projection |
| Contacts → Segments (Lists) | View own+others, Edit own+others | resolve a segment, enrol a contact |
| API access | Enabled | every call above |

Everything else — Users, Roles, Configuration, Emails, Campaigns, Pages,
Forms, Reports, Plugins, Stages, Points — stays **off**. GRAV reads engagement
through webhooks, which Mautic pushes; it never needs permission to read
campaigns or emails, and granting it would hand an integration credential the
ability to send.

**User**: Settings → Users → New, assign that role. Its username and password
are `MAUTIC_BASIC_USERNAME` / `MAUTIC_BASIC_PASSWORD`.

**OAuth2 (preferred)**: Settings → API Credentials → New → *OAuth2*, grant type
Client Credentials, owned by that user. Its id and secret are
`MAUTIC_OAUTH_CLIENT_ID` / `MAUTIC_OAUTH_CLIENT_SECRET`, and
`MAUTIC_AUTH_MODE=oauth2`.

**This one really is UI-only.** `ApiBundle` exposes no route for creating an
OAuth2 client, so the provisioning script cannot do it and the live proof used
basic auth with the least-privilege user instead. The OAuth2 code path is
unit-tested against the contract double but has never held a real Mautic token —
see `docs/handoff/mautic-chunk-0-contract.md` §11.6.

Credentials live in deployment secrets only. Never in a database document,
never in frontend configuration, never in a committed file.

---

## 5. Health checks

Three layers, each answering a different question:

| Layer | How | Answers |
|---|---|---|
| Container | `docker compose ps` | are the processes alive? |
| Mautic ↔ its database | the compose healthcheck on `/s/login` | is Mautic serving? |
| GRAV ↔ Mautic | `GET /api/cms/marketing/health` | can GRAV actually use it? |

The GRAV check reports **configuration, reachability, authentication, api and
database separately**, because each needs a different person to fix it.
Collapsing them into one boolean sends everybody to the same dashboard to find
nothing.

It answers **200 whatever it finds** — a health check that 503s when its subject
is down cannot be told apart from a health check that is itself down. `healthy`
in the body is the answer.

Every count in it is `null` when it could not be read, **never `0`**. Mautic's
database is checked *through* Mautic (GRAV holds no credential for it by
design), and the report says that is what it is rather than claiming a direct
check.

---

## 6. Webhooks

Mautic → Webhooks → New:

* **Post URL** — `https://<grav-backend>/api/cms/marketing/events`
* **Secret** — the same value as GRAV's `MAUTIC_WEBHOOK_SECRET`
* **Events** — Form submitted, Page hit, Email opened

Mautic signs each delivery as
`base64(HMAC-SHA256(rawBody, secret))` in a **`Webhook-Signature`** header. Not
hex, and not `X-Hub-Signature-256`. Confirmed live: the header arrives as
`webhook-signature` with `User-Agent: Webhook`. GRAV verifies against the raw
bytes; with no secret configured it rejects everything, because a verification
that passes when unconfigured is not a verification.

### The private-address restriction, and how to solve it

Mautic refuses webhook URLs on private addresses. Two details that the
documentation does not make obvious, both confirmed by reading
`CoreBundle/Helper/PrivateAddressChecker.php` and by testing:

* **The allowlist is matched with `in_array()` — exact strings, not CIDR.**
  `192.168.5.2/32` matches nothing.
* **The literal host `localhost` is refused before the allowlist is consulted.**
  No entry can rescue a `http://localhost:…` callback.

So the callback uses the container's host alias and allowlists it by name:

```php
'webhook_allowed_private_addresses' => ['host.docker.internal', '192.168.5.2'],
```

```text
Post URL: http://host.docker.internal:5055/api/cms/marketing/events
```

`host.docker.internal` resolves inside the container (to `192.168.5.2` under
Colima) and reaches a host process bound to `127.0.0.1`, so nothing has to be
exposed. **Do not tunnel this to the public internet** — it is a signed endpoint,
but a development Mautic posting to a public URL is a development Mautic
somebody else can find.

### Delivery must be immediate, or it waits for cron

Default `queue_mode` defers delivery to `bin/console mautic:webhooks:process`.
Set `'queue_mode' => 'immediate_process'` (the configure step above does) so a
delivery arrives as part of the act that caused it.

### Proving it

```bash
node -r dotenv/config scripts/marketing/mautic-webhook-listener.js &
node -r dotenv/config scripts/marketing/mautic-round-trip.js
```

The listener mounts **only** the real Marketing router against a disposable
in-memory MongoDB, so proving one webhook does not start the whole platform or
touch shared data. The round trip must report 11 passed, 0 failed, and exit 0.

---

## 7. Backup and restore

**Back up the database and the uploaded assets together.** A restored database
referencing media that no longer exists is not a restored instance.

```bash
# Backup
cd deploy/mautic
mkdir -p backups
docker compose exec -T mautic-db \
  mariadb-dump -u root -p"$MAUTIC_DB_ROOT_PASSWORD" --single-transaction \
  --routines --triggers "$MAUTIC_DB_NAME" | gzip > "backups/mautic-$(date +%F-%H%M).sql.gz"

docker run --rm -v grav-mautic-dev_mautic-media:/media -v "$PWD/backups:/out" \
  alpine tar czf "/out/mautic-media-$(date +%F-%H%M).tar.gz" -C /media .
docker run --rm -v grav-mautic-dev_mautic-config:/config -v "$PWD/backups:/out" \
  alpine tar czf "/out/mautic-config-$(date +%F-%H%M).tar.gz" -C /config .
```

```bash
# Restore
docker compose down
docker volume rm grav-mautic-dev_mautic-db-data grav-mautic-dev_mautic-media
docker compose up -d mautic-db
gunzip -c backups/<dump>.sql.gz | \
  docker compose exec -T mautic-db mariadb -u root -p"$MAUTIC_DB_ROOT_PASSWORD" "$MAUTIC_DB_NAME"
docker run --rm -v grav-mautic-dev_mautic-media:/media -v "$PWD/backups:/in" \
  alpine tar xzf "/in/<media>.tar.gz" -C /media
docker compose up -d
```

`backups/` and `*.sql.gz` are gitignored. **A restore is only proven by
performing one**: after restoring, run
`node -r dotenv/config scripts/marketing/mautic-round-trip.js` and require every
step to pass.

---

## 8. Secret rotation

Rotate without an outage by adding before removing.

* **API credential** — create a second OAuth2 client on the same
  least-privilege user, deploy the new id and secret, confirm
  `GET /api/cms/marketing/health` reports `authentication: ok`, then delete the
  old credential in Mautic. GRAV caches an access token for up to an hour, so
  wait out the cache before deleting.
* **Webhook secret** — Mautic signs with one secret at a time, so this one is a
  cut-over: change it in Mautic and in GRAV's `.env` together, then confirm the
  next delivery is accepted. Deliveries signed with the old secret in that
  window are rejected and Mautic retries them.
* **Database password** — change it in MariaDB, then in `deploy/mautic/.env`,
  then `docker compose up -d`. GRAV is unaffected; it holds no database
  credential.

Rotate immediately if a credential reaches a log, a ticket or a chat message.

---

## 9. Upgrade rehearsal

Never upgrade production first, and never against a moving tag.

1. Restore the latest production backup into a scratch stack.
2. Change the image digest in `docker-compose.yml` to the new pinned version.
3. `docker compose up -d` and let Mautic run its migrations.
4. Run `node -r dotenv/config scripts/marketing/mautic-round-trip.js` against
   the upgraded instance. Every step must pass.
5. Re-verify the contract itself: the API paths, the response shapes and the
   webhook signature scheme recorded in
   `docs/handoff/mautic-chunk-0-contract.md`. A minor Mautic release has
   changed a response shape before.
6. Only then change the digest for the real instance.

---

## 10. What is deliberately not here

Production mail delivery and domain authentication, TLS termination, a public
hostname, horizontal scaling, a managed database, and any credential that could
reach a real recipient. This is a development instance and opening its ports
would make it something else.
