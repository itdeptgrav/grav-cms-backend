# Sales messaging through OpenWA

## Outcome

The Sales **Contact Logs → Conversations** experience uses a linked OpenWA
session for one-to-one WhatsApp text messages. Existing conversations and
message history stay in the same MongoDB collections.

The official Meta WhatsApp Cloud API remains in the repository but is dormant.
It may only become active through the explicit `WHATSAPP_PROVIDER=meta`
configuration. The system must never fall back from OpenWA to Meta on failure.

## User-visible behaviour

- Sales can start a chat from a customer number and send normal text messages.
- Customer replies arrive in the existing Sales conversation thread.
- The page reports whether the OpenWA session is connected or needs attention.
- OpenWA conversations are not blocked by the Cloud API's 24-hour template
  composer rule.
- A 10-digit Indian mobile number is converted to its international WhatsApp
  identifier by prefixing the configured default country code (`91` by
  default). Already country-coded numbers are preserved.
- A rejected OpenWA send is shown as an error and is not persisted as a
  successfully sent message.
- Received OpenWA images, stickers, audio, video and documents are decrypted on
  demand behind the authenticated CMS media proxy. Raw base64 thumbnails must
  never be stored or shown as message text.
- WhatsApp call-state events appear in **Contact Logs → Calls**. A call becomes
  received only after OpenWA reports `ACTIVE` (or that it was handled on a
  linked device); connected duration is calculated from that transition to the
  terminal event. Ringing time is not counted as talk time.
- Voice/video and group-call flags are retained, but OpenWA does not expose or
  record the call audio. Tracking is best-effort and requires the linked
  OpenWA session to remain online for the full call lifecycle.
- Meta-approved templates remain unavailable while OpenWA is active. The UI
  must not imply that those templates are present.

## Operational and safety boundary

OpenWA automates WhatsApp Web. It is unofficial, is not affiliated with Meta,
and can break when WhatsApp Web changes. It can also expose the linked account
to suspension if used for spam or excessive automation. Use a dedicated Sales
number, obtain customer consent, keep message concurrency low, and do not use
this integration for bulk campaigns.

The OpenWA API must be private and protected by an API key. Its webhook must use
HTTPS in production and send `X-Webhook-Secret`. Session/browser state belongs
to the OpenWA service, not the CMS process.

## Configuration

```text
WHATSAPP_PROVIDER=openwa
OPENWA_BASE_URL=http://127.0.0.1:8080
OPENWA_API_KEY=<long random secret>
OPENWA_WEBHOOK_SECRET=<different long random secret>
OPENWA_SESSION_ID=sales
OPENWA_COMPANY_ID=<company ObjectId that owns the linked Sales number>
OPENWA_DEFAULT_COUNTRY_CODE=91
OPENWA_REQUEST_TIMEOUT_MS=15000
```

The OpenWA webhook target is:

```text
https://<backend-host>/api/whatsapp/webhook/openwa
```

The official provider remains dormant even when its old credentials are still
present. Re-enabling it requires `WHATSAPP_PROVIDER=meta` and a deliberate
deployment.

## Supported webhook contracts

The receiver accepts OpenWA's current v5 envelope
`{ event, sessionId, payload: { message } }` and the common stable-v4
`{ event, data }` shape. It ignores groups and self-authored events and uses the
provider message id for retry deduplication.

Call tracking accepts `call.state` envelopes containing OpenWA's `Call` object.
The provider call id is the idempotency key, so repeated ringing and terminal
webhooks update one `CallEvent` rather than creating duplicate call rows.
