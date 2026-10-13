# GRAV Mail — foundation implementation task

> **Status:** Centralized vertical slice implemented; release hardening remains
>
> **Product contract:** `docs/product/mail-app.md`
>
> **Architecture decision:** `docs/decisions/mail-app-identity-oauth-boundary.md`
>
> **Repositories:** backend `/Users/risheeray/grav-cms-backend`; frontend `/Users/risheeray/grav-cms`

## 1. Goal

Add GRAV Mail as a separate, grantable CMS application and deliver the smallest
centralized vertical slice: internal employee-ID mail plus the actor's connected
Gmail in one shell, inbox, reading pane and composer. Preserve CoWork without
changing or removing any of its mail routes, fields or UI.

Implemented on 12 October 2026:

- additive `mail` catalogue row, launcher icon, route mapping and protected shell;
- canonical employee identity and employee-ID directory resolution;
- internal thread/message persistence with membership-scoped list/read/reply;
- encrypted per-actor Gmail connection and replay-safe OAuth attempt;
- Gmail list/thread/send/reply/state endpoints;
- responsive All/Internal/Gmail inbox, shared reading pane, composer and settings;
- no changes to `/api/google/employee-gmail/*` or CoWork token storage.

Release hardening still required: provider-side search/folders, attachments,
idempotency receipts, rate limits, audit events, complete provider error mapping,
key rotation procedure, expanded authorization/OAuth route tests and production
Google consent/redirect configuration.

Runtime configuration for Gmail:

- `MAIL_CREDENTIAL_ENCRYPTION_KEY`: preferably 32 random bytes encoded as 64 hex
  characters. The current local environment explicitly uses
  `derive:SALARY_ENCRYPTION_KEY`, which creates a domain-separated Mail key from
  its existing stable encryption root without using that root directly. Back up
  whichever root is deployed; losing it disconnects every Mail Gmail connection.
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`: the Google OAuth client.
- `GOOGLE_REDIRECT_URI_MAIL`: the exact callback registered in Google Cloud.
  Prefer `https://<api-host>/api/cms/mail/oauth/google/callback`. The current
  local environment reuses the already-registered employee-Gmail callback; a
  server alias claims only `mail_` namespaced states and passes every ordinary
  Cowork state to the unchanged legacy handler.
- `FRONTEND_URL`: the CMS origin used after the callback (production normally
  `https://cms.grav.in`).

## 2. Required sequence

Implementation is deliberately sequential. Do not start a later step until the
preceding boundary has focused tests.

### MA-01 — register the application

Backend:

- Add a strictly additive `mail` row to `services/ensureAccessDepartments.js`:
  name `Mail`, dashboard path `/mail/inbox`, no legacy collection, and a sort
  order in the Company/shared-application group.
- Confirm the row appears in Access Control and remains grantable through the
  existing Viewer/Editor/Approver/Owner flow.
- Add catalogue/access tests proving an ungranted user is denied, a granted user
  is allowed and a database-verified platform administrator can administer the
  application without acquiring another person's mailbox authority.

Frontend:

- Add the `mail` icon to `components/onboarding/DepartmentIcon.js`.
- Map `/mail` to `mail` in `components/shell/activeApplication.js`.
- Update route-map/icon/launcher focused tests.

Acceptance:

- A granted user sees a Mail tile returned by the server and can switch into the
  `mail` application context.
- An ungranted user cannot open `/mail` or a Mail API.
- No direct/unconditional client tile is introduced.

### MA-02 — establish connection and OAuth stores

Add dedicated models/services; exact filenames may follow repository naming,
but responsibilities must remain separate:

- `MailConnection`: canonical actor id, provider, connected address metadata,
  encrypted refresh credential, key version, status and timestamps. Unique per
  actor/provider. Never return ciphertext through an API projection.
- `MailOAuthAttempt`: random state hash, actor id, provider, allowlisted return
  path, expiry and consumed timestamp. TTL cleanup plus atomic single-use
  consumption.
- `MailWriteReceipt`: actor, idempotency key, request hash, provider result
  reference and expiry for send/reply deduplication.
- Credential cipher service with versioned encryption and rotation support.

Do not use email address, `employeeId`, department slug or a browser-supplied id
as the credential ownership key.

Acceptance:

- Raw refresh tokens do not appear in employee documents, logs, JSON responses
  or test snapshots.
- OAuth attempts expire, cannot be replayed and cannot be consumed for a
  different actor/provider.
- A key-versioned encrypted credential round-trips only through the credential
  service.

### MA-03 — build the self-scoped Mail router

Mount `/api/cms/mail` with the existing CMS session authentication and canonical
`mail` application-access resolver.

Minimum routes:

| Method | Route | Capability |
|---|---|---|
| GET | `/status` | Mail read |
| POST | `/connections/google/authorize` | Mail read; creates OAuth attempt |
| GET | `/oauth/google/callback` | Public callback; consumes single-use attempt |
| DELETE | `/connection` | Mail read; revoke then remove own connection |
| GET | `/folders` | Mail read |
| GET | `/conversations` | Mail read; folder/search/cursor query |
| GET | `/conversations/:threadId` | Mail read |
| PATCH | `/messages/:messageId/state` | Editor+; allowlisted read/star/archive/trash action only |
| POST | `/messages` | Editor+; idempotent compose |
| POST | `/conversations/:threadId/replies` | Editor+; idempotent reply |
| GET | `/messages/:messageId/attachments/:attachmentId` | Mail read; streamed download |

Rules:

- No route accepts `employeeId`, actor id, credential id or mailbox address to
  choose the connection.
- Validate opaque provider ids and cursors as bounded strings.
- Validate folder/action enums.
- Apply provider timeouts and translate revoked grant, rate limit, unavailable,
  malformed message and not-found into stable Mail error codes.
- Never return raw provider error objects or token material.
- Rate-limit OAuth initiation, list/search and sends separately.

### MA-04 — provider-neutral core and Gmail adapter

Create a provider contract for list/search/thread/actions/send/reply/attachment
operations. Move no CoWork route in this step.

Gmail adapter requirements:

- request the minimum scopes justified by implemented actions;
- list conversations rather than presenting duplicate messages as inbox rows;
- fetch bounded metadata for lists and full payload only for an opened thread;
- report partial fetches rather than silently dropping failed messages;
- parse nested multipart messages, charsets and inline attachments safely;
- use a maintained MIME/mail composer rather than constructing headers and
  quoted-printable bodies manually;
- validate addresses and forbid CR/LF in every header value;
- stream and cap attachments; never accept a 50 MB base64 JSON body;
- set From from the connected provider identity only;
- use idempotency receipts around send/reply retries.

Add characterization tests around the existing
`routes/services/googleEmployeeGmailService.js` before extracting any helper it
also uses. `/api/google/employee-gmail/*` must retain its current contract.

### MA-05 — safe message rendering contract

The backend returns:

- normalized headers and timestamps;
- a trustworthy plain-text representation;
- sanitized bounded HTML, or a typed `htmlUnavailable` result;
- attachment metadata with GRAV download routes, never provider credentials.

The renderer must use a sandboxed message surface. Remote images are blocked by
default; scripts, forms, embedded frames, SVG and active content are removed.
Links receive safe schemes plus `noopener noreferrer`. Add malicious-message
fixtures covering script, event attributes, CSS URLs, forms, iframes, SVG and
tracking pixels.

### MA-06 — Mail shell and connection UI

Frontend files should follow the established application pattern:

- `app/mail/layout.js`: metadata and one persistent Mail layout.
- `components/mail/MailLayout.js`: `FrostShell` with `guardSlug="mail"` and
  `appSlug="mail"`.
- `app/mail/page.js`: redirect to `/mail/inbox`.
- `app/mail/settings/page.js`: connection status/connect/disconnect.
- a small typed client module under `lib/mail/`; pages do not hand-build fetch
  contracts independently.

The OAuth callback returns to `/mail/settings` with a short result code, never
an email address, provider error or token in the URL.

### MA-07 — inbox, thread and composer UI

Add:

- `/mail/inbox` with folder/search/cursor state;
- `/mail/thread/[threadId]` or an equivalent responsive split-view route;
- compose and reply surfaces with client-generated idempotency keys;
- optimistic state actions with rollback;
- mobile layout with one pane at a time;
- clear states for not connected, reconnect required, empty, loading, partial,
  rate limited and unavailable.

The UI must not use `dangerouslySetInnerHTML` in the main application document
for message content. Use the safe renderer from MA-05.

### MA-08 — verification and release gate

Focused backend tests:

- application grant and capability matrix;
- self-scope and attempted cross-user identifiers;
- OAuth expiry, replay, wrong actor and unsafe return path;
- encrypted credential projection and disconnect revocation;
- Gmail pagination, partial failure and revoked grant;
- MIME/header injection, Unicode, empty attachment and size limits;
- send/reply idempotency;
- CoWork route compatibility.

Focused frontend tests:

- launcher icon and active-application mapping;
- guard and shell identity;
- connection states;
- folder/search pagination;
- thread rendering malicious fixtures;
- compose validation, duplicate-click prevention and failure retry;
- responsive one-pane/split-pane behaviour.

Release remains blocked until Google OAuth consent-screen configuration,
redirect URI, credential encryption key/rotation procedure, privacy wording and
production rate limits are verified.

## 3. Initial file scope

### Backend — expected additions

- `models/Mail/MailConnection.js`
- `models/Mail/MailOAuthAttempt.js`
- `models/Mail/MailWriteReceipt.js`
- `services/mail/mailAccess.service.js`
- `services/mail/mailConnection.service.js`
- `services/mail/mailbox.service.js`
- `services/mail/mailCredentialCipher.js`
- `services/mail/providers/gmail.provider.js`
- `routes/mail/mail.routes.js`
- focused tests under `services/mail/` and `test/mail/`

### Backend — expected edits

- `services/ensureAccessDepartments.js`
- `server.js`

### Frontend — expected additions

- `app/mail/layout.js`
- `app/mail/page.js`
- `app/mail/inbox/page.js`
- `app/mail/settings/page.js`
- `components/mail/**`
- `lib/mail/**`
- focused Mail tests

### Frontend — expected edits

- `components/onboarding/DepartmentIcon.js`
- `components/shell/activeApplication.js`
- route/icon/application-shell tests

## 4. Explicit non-goals

- Removing or rewriting CoWork mail.
- Migrating existing CoWork tokens.
- Outlook or shared mailbox support.
- CRM auto-logging.
- AI summarization, drafting or mailbox-wide indexing.
- Unread counts in the global launcher.
- Background sync, push notifications or offline mail.
- Administrator mailbox impersonation.

## 5. Handoff rule

If implementation discovers that a CMS actor cannot be mapped to one immutable
canonical identity without using an email address, stop and return the conflict
to Codex. Do not fall back to `employeeId`, current department, email or a client
parameter. Likewise, any request to reuse a CoWork refresh token is a new
migration decision, not an implementation shortcut.
