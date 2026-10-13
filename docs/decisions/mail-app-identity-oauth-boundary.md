# Decision: GRAV Mail is a self-scoped CMS application with a shared provider core

**Status:** Accepted  
**Date:** 12 October 2026

## Decision

GRAV Mail is registered as the first-class CMS application `mail`, served from
`/mail` and `/api/cms/mail`. It uses the existing application catalogue,
launcher, `DepartmentRole` grants, department switching and `FrostShell` rather
than CoWork's Firebase session or a special direct tile.

Mailbox authority is self-scoped. A route authenticates the CMS session,
resolves the actor's `mail` application access, and chooses the connection from
that verified actor identity. A request cannot name another employee, email
address or credential record. Platform administration does not imply mailbox
delegation.

Internal mail uses a second kind of address: the human-readable employee ID.
It is input only at compose time. The server resolves it to the same canonical
Employee identity used for the signed-in actor, stores canonical participant
keys on the conversation, and checks those keys on every operation. Thus an
employee ID is an address, never an authorization principal. Internal message
content is stored in dedicated MongoDB thread/message collections; it never
passes through Gmail or the CoWork Firebase collections.

Gmail credentials are stored in a dedicated connection collection, separate
from employee directory records, and encrypted at rest. OAuth initiation creates
a random, short-lived, single-use server record bound to the actor and an
allowlisted return path. The callback consumes that record before saving a
credential. Raw actor ids and return paths are not used as OAuth state.

Where the deployed Google client has not yet allowlisted the dedicated Mail
callback, Mail may temporarily use the existing employee-Gmail redirect URI.
Mail OAuth states carry a `mail_` routing prefix and are claimed by a callback
alias before the legacy router; every state without that prefix falls through
unchanged. The prefix grants nothing—the hashed, expiring attempt record remains
the authority—and the compatibility alias can be removed after Google accepts
the dedicated redirect URI.

The provider integration is split into:

1. a Mail application/authentication layer;
2. a provider-neutral mailbox service;
3. a Gmail adapter;
4. encrypted connection and OAuth-attempt stores.

The centralized application composes two channels at the UI/API boundary: the
GRAV-owned internal store and the actor-owned live Gmail adapter. Their
credentials and persistence rules remain separate even though the experience is
one inbox.

The existing CoWork employee-Gmail routes remain mounted and unchanged in the
foundation. They may later call characterized shared Gmail helpers through a
compatibility adapter, but Mail does not depend on CoWork identity or on the
`cowork_employees.gmailToken` location.

## Context

CoWork already contains a useful per-employee Gmail service, but it cannot be
promoted directly into a CMS app:

- the mounted `/api/google` router is intentionally administrator-only after a
  critical unauthenticated exposure was contained;
- CoWork authenticates Firebase tokens while CMS applications use the CMS
  session and application grants;
- the legacy routes accept `employeeId` from the request;
- OAuth state contains the employee id rather than a session-bound nonce;
- the refresh token is stored on an ordinary employee directory document;
- message HTML and MIME construction need a hardened boundary before a new UI
  renders or sends them.

The useful product idea should be retained without copying those security and
ownership assumptions.

## Alternatives rejected

### Put a Mail link inside CoWork only

Rejected because mail is used across every business application and needs its
own access, shell and privacy boundary. The owner explicitly wants Mail to be a
separate application while retaining CoWork.

### Reuse `/api/google/employee-gmail/*` directly

Rejected because the caller selects `employeeId`, the router expects a platform
administrator session, and its OAuth callback is coupled to that containment.
Changing only the middleware would create an insecure direct-object reference.

### Store the new credential on `cowork_employees`

Rejected because CMS users may have no CoWork record and directory documents
are the wrong secret boundary. This coupling previously exposed refresh tokens
through directory projections.

### Copy mailbox contents into GRAV

Rejected for the MVP. Live provider reads avoid retaining unrelated private and
HR mail, reduce breach impact and keep provider state authoritative. A later
search index may store only explicitly selected business correspondence under
a separate retention decision.

### Give administrators access to all mailboxes

Rejected. Application administration and mailbox delegation are different
authorities. Shared or delegated mailboxes require an explicit audited feature.

## Consequences

- A new `mail` catalogue row and grant are required before anyone sees the app.
- A CMS user connects Mail independently even if they previously connected Gmail
  in CoWork. No silent secret migration occurs.
- Provider calls remain live and can be slow or unavailable; typed failure states,
  timeouts and rate-limit handling are part of the contract.
- The application stores very little mail data but must operate a secure dynamic
  credential store and key-rotation procedure.
- CoWork and Mail temporarily have separate route layers and credential stores.
  Shared implementation comes later, after compatibility tests, rather than by
  making either application depend on the other's identity model.
- Cross-application integrations receive narrow intents or references later;
  they never receive mailbox-wide credentials.
