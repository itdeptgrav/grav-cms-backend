# Decision: Chat channel and OpenWA pairing boundary

**Date:** 13 October 2026  
**Status:** Accepted

## Decision

GRAV Chat exposes external WhatsApp and internal company messaging as two
explicit lanes behind one application grant. They are not merged into a single
ambiguous inbox.

External messages continue to use `WhatsAppConversation` and `WhatsAppMessage`.
Internal Chat uses `InternalMailThread` and `InternalMailMessage`, but a thread
created by Chat has `purpose: "chat"`. All internal Mail queries apply the Mail
purpose predicate; all internal Chat queries apply the Chat purpose predicate.
Rows created before this field existed are Mail. This is a storage reuse choice,
not a UI-only distinction.

The OpenWA QR has one authenticated endpoint:
`GET /api/cms/chat/whatsapp/qr`. It is requested only from the External
connection panel, returned with `Cache-Control: no-store, private`, and never
returned from health/status. The server does not persist or log its value.

## Why

A customer phone number and an employee identity imply different audience,
privacy, delivery, and failure expectations. Blending both into one thread list
would make it too easy to send company material outside GRAV. Conversely,
building a second copy of the existing WhatsApp history would fragment the
customer record. Purpose-scoped internal reuse preserves one implementation
while keeping Mail and Chat mutually unreadable at the query boundary.

A WhatsApp pairing QR can authorise a device session. Treating it as ordinary
status data would expose it to caches, logs, screenshots, and users who need
read-only monitoring but should not link devices.

## Consequences

- Chat must be granted explicitly in Access Control.
- OpenWA remains the only external transport in this foundation.
- The Sales WhatsApp UI and Chat read the same customer history; Chat alone owns
  the self-service QR surface.
- A future migration to separate internal Chat collections is possible because
  `purpose` makes the current ownership explicit.
