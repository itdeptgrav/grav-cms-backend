# GRAV Chat

## Product promise

GRAV Chat gives an employee one communication application without pretending
that all communication has the same audience. The application always identifies
which of these two channels is active:

1. **External · WhatsApp** — customer conversations sent and received through
   the company OpenWA session.
2. **Internal · GRAV company** — conversations whose participants are verified
   GRAV employee identities.

The lane label remains visible in the conversation header and in the new-chat
dialog. Starting an external conversation asks for a customer phone number;
starting an internal conversation searches the employee directory and requires
an employee ID. A message cannot be moved or silently rerouted between lanes.

## Access and ownership

Chat is a first-class application at `/chat` with its own `chat` application
grant. A Chat grant does not grant Sales, Mail, Gmail, or company-administration
access. Viewer roles can read; a role with write capability is required to
start a conversation, send a message, mark a WhatsApp thread read, or request a
pairing QR.

External WhatsApp uses the existing WhatsApp conversation/message history so a
customer has one history rather than a second Chat-specific copy. Internal Chat
uses the existing internal message store with a mandatory Chat purpose tag and
purpose-filtered reads. Mail and Chat can therefore reuse proven primitives
without displaying each other's threads.

## WhatsApp connection

The External lane shows OpenWA readiness. When the session is not linked, an
authorised writer may deliberately open the pairing panel. The QR is rendered
inside Chat only and includes a warning that it is a credential. The CMS does
not save the QR, put it in application status, or write it to logs.
While pairing is open, Chat refreshes the rotating code and follows connection
readiness. A successful phone scan closes the panel and enables the composer
without a page reload.

## Out of scope for the foundation

- Meta template authoring or automatic fallback from OpenWA.
- Moving customer conversations into internal Chat.
- Cross-company or guest internal messaging.
- Groups, reactions, editing, deletion, presence, or push notifications.
- Granting Chat automatically to every employee.
