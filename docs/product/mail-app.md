# GRAV Mail application

> **Status:** First centralized vertical slice implemented; release configuration pending
>
> **Application slug:** `mail`
>
> **Frontend root:** `/mail`
>
> **Backend root:** `/api/cms/mail`

## 1. Product outcome

GRAV Mail is a first-class CMS application, alongside Store & Purchase, HR,
Sales and the other applications shown on the employee home. A person who has
the Mail application grant can send private internal mail to an employee ID and
connect their own Google mailbox for external email. Both channels meet in one
inbox and composer without requiring the person to enter CoWork.

The existing CoWork mail concept is the reference for the useful capabilities:
per-person OAuth, live Gmail reads, folders, search, threads, message actions,
compose, reply and attachments. GRAV Mail does not remove, redirect or replace
anything in CoWork. The first release creates a separate CMS application and a
safe mail boundary. CoWork remains operational on its existing routes and data.

## 2. Why Mail is a separate application

Mail is not a CoWork section and it is not owned by Sales, HR or Store. The same
person may use their mailbox while working in any of those applications. Making
Mail its own application gives it:

- a launcher tile and application identity;
- an explicit access grant;
- its own `/mail` route tree and shared CMS shell;
- its own privacy, OAuth and provider boundary;
- one place for inbox, sent mail, search and composition;
- room for provider-neutral evolution without expanding CoWork.

Cross-application screens may later link to a Mail thread or open a prefilled
composer, but they do not own the mailbox and they never receive mailbox-wide
credentials or search authority.

## 3. Access and mailbox ownership

### 3.1 Application access

`mail` is registered in `AccessDepartment` and granted through the existing
`DepartmentRole` / application-access flow. It appears on the employee home
only for people the server says may open it. The application uses the standard
Viewer, Editor, Approver and Owner vocabulary:

| Role | Mail capability |
|---|---|
| Viewer | Open Mail and read/search the actor's own connected mailbox |
| Editor | Viewer plus compose, reply, mark, star, archive and trash |
| Approver | Same mailbox operations as Editor; reserved for later shared-mailbox policy, with no extra MVP surveillance power |
| Owner | Same personal-mailbox operations plus application access/configuration administration through the existing platform controls |

No role permits reading somebody else's personal mailbox. A platform
administrator may register/configure the application and grant access, but has
no implicit mailbox delegation.

Internal mail follows the same rule. A participant may read a conversation only
when their server-resolved canonical employee identity is in its participant
set. The browser supplies a recipient employee ID when composing, but never an
actor key; the server resolves that directory address to the canonical account.

### 3.2 Personal Gmail boundary

Every mailbox operation derives the mailbox owner from the verified CMS actor.
The browser never sends an `employeeId`, user id, email address or connection id
to choose whose credentials the backend uses.

The MVP deliberately excludes:

- shared mailboxes;
- executive or administrator mailbox inspection;
- delegated access;
- legal discovery/export;
- cross-mailbox search;
- automatic ingestion into another application.

Any of those requires a separate product and audit decision.

### 3.3 Internal delivery boundary

Internal messages are GRAV records, not Gmail messages. A sender addresses one
or more active colleagues by their employee IDs. The server resolves those IDs
against Employee first and the linked department account only as a compatibility
fallback. It stores canonical participant keys, and every list, read, reply and
state operation rechecks membership. Internal mail is never forwarded to Gmail.

## 4. MVP experience

### 4.1 Launcher and shell

- App name: **Mail**.
- Slug: `mail`.
- Home route: `/mail/inbox`.
- Icon: envelope/mail glyph using the common application icon system.
- Chrome: `FrostShell`, `guardSlug="mail"`, `appSlug="mail"`.
- Primary navigation in the first slice: Inbox and Settings. The inbox itself
  switches between All mail, Internal and Gmail.
- Compose is a prominent action, not another navigation destination.
- Search filters the centralized loaded inbox. Provider-side Gmail search is a
  follow-up before large mailboxes can rely on it as exhaustive search.

### 4.2 Not connected

The first screen explains that GRAV will connect to the person's Google account,
which permissions are requested, and that GRAV does not copy the entire mailbox
into its own database. The user explicitly starts OAuth. A failed, expired or
revoked connection produces a reconnect action rather than an empty inbox.

### 4.3 Central inbox

- Inbox merges internal conversations and Gmail messages newest first, with a
  visible source label and a consistent reading pane.
- Internal compose accepts one or more employee IDs and returns explicit missing
  or ambiguous-ID errors rather than guessing.
- Unread, starred and attachment state is visible without opening a message.
- Opening a conversation shows the full thread in chronological order.
- External images are blocked by default and can be loaded deliberately.
- Links open safely in a new browser context.
- Plain-text fallback is always available.
- Mark read/unread, star/unstar, archive and trash act on the provider and give
  optimistic feedback with rollback on failure.
- Pagination uses opaque provider cursors; the client cannot construct them.

### 4.4 Compose and reply

- To is required; Cc and Bcc are optional.
- Subject is required for a new message and inherited for a reply.
- The actor may send plain text or the application's bounded rich-text subset.
- Attachments use streamed multipart upload, not base64 inside JSON.
- GRAV enforces a conservative 20 MiB total attachment limit for one send.
- Send is idempotent from the UI: a retry key prevents duplicate messages when
  the browser loses the response.
- The From address is always the provider-connected address. The browser cannot
  override it.

### 4.5 Settings

Settings shows provider, connected address, connection time and connection
health. Disconnect revokes the Google grant when possible and then removes the
local credential. It never returns token material.

## 5. Data and privacy

GRAV Mail reads external messages live from Gmail and does not persist Gmail
message bodies, subjects, recipients, snippets or attachments in MongoDB or
Firestore. Internal messages are deliberately persisted in MongoDB because GRAV
is their delivery system. Stored records are:

- encrypted provider connection metadata and refresh credential;
- a short-lived OAuth attempt/nonce;
- internal conversation metadata and internal message bodies;
- non-content operational audit events such as connected, disconnected, send
  attempted/succeeded/failed and provider grant revoked;
- idempotency receipts for bounded write retries.

Logs and metrics must not contain message bodies, subjects, addresses,
attachment names, OAuth codes, access tokens or refresh tokens. Metrics may
contain provider, operation, outcome, latency and size buckets.

## 6. Provider scope

Gmail is the only MVP provider. The application service speaks a small internal
provider contract so Outlook or another provider can be added later without
changing route semantics or UI state names.

Provider capabilities in the MVP:

- connect/status/disconnect;
- list folders and conversations;
- search;
- fetch a thread;
- mark read/unread;
- star/unstar;
- archive and trash;
- compose and reply;
- download an attachment.

Draft listing may be shown only when draft retrieval is reliable. Draft
creation/editing is not claimed until implemented and tested.

## 7. CoWork compatibility

The following are hard requirements:

1. Do not remove or rename `/api/google/employee-gmail/*` in the Mail foundation.
2. Do not remove the `gmailToken` field or migrate it destructively from
   `cowork_employees`.
3. Do not change CoWork authentication, navigation or redirect behaviour as a
   side effect of introducing Mail.
4. Do not make the standalone Mail app select a CoWork employee by a
   browser-supplied identifier.
5. Do not silently copy a person's CoWork refresh token into the CMS Mail
   credential store. A later migration requires explicit consent, identity
   proof and a rollback plan.
6. Shared provider helpers may be extracted only after characterization tests
   pin CoWork's current behaviour. Compatibility wrappers must keep its public
   contract intact.

## 8. Failure states

The UI distinguishes:

- no Mail application grant;
- Google integration not configured on the server;
- no mailbox connected;
- OAuth cancelled or expired;
- grant revoked / reconnect required;
- provider unavailable or timed out;
- rate limited;
- malformed or unsupported message content;
- action conflict or message no longer available;
- partial thread/list result.

Provider failures never become an empty-inbox answer.

## 9. Success criteria

The centralized first slice is complete when a granted employee can:

1. open Mail from the employee home;
2. connect their own Google account through a replay-safe OAuth flow;
3. read their internal and external mail in one inbox;
4. send and reply internally by employee ID;
5. compose and reply externally through their own connected Gmail account;
7. disconnect and revoke the connection;
8. use the same experience on desktop and mobile widths;
9. do all of the above without changing CoWork behaviour;
10. pass ownership, OAuth and credential tests.

Provider-side exhaustive search, attachments, full folder/state UI, HTML
rendering, send idempotency, production rate limits and audit events remain
release-hardening work and are not represented as complete by the first slice.

## 10. Explicitly later

- Outlook/Microsoft 365;
- shared/team mailboxes;
- aliases and send-as identities;
- signatures and templates;
- scheduling and snooze;
- offline mailbox cache;
- notifications and unread counts on the global launcher;
- automatic CRM logging or AI processing;
- cross-application composer intents;
- retention, discovery and mailbox export.
