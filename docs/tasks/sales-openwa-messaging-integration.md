# Sales OpenWA messaging integration

## Implemented scope

- [x] Explicit `openwa | meta | disabled` provider boundary.
- [x] Capture OpenWA call lifecycle into the existing company-owned `CallEvent`
      log, including answered/missed/rejected state and connected duration.
- [x] OpenWA text sends from the existing Sales messaging route.
- [x] OpenWA v5/v4 inbound webhook normalisation and retry deduplication.
- [x] Protected webhook secret and protected outbound API key.
- [x] OpenWA health/capability status for the Sales UI.
- [x] Official Meta send and webhook paths dormant unless explicitly selected.
- [x] No automatic fallback to Meta.
- [x] OpenWA-specific UI wording and no Cloud API 24-hour/template gate.
- [x] International recipient normalization for locally stored Indian numbers.
- [x] Reject false OpenWA send results instead of recording phantom sends.
- [x] Protected inbound image, sticker, audio, video and document proxying.
- [x] Strip OpenWA base64 thumbnails from stored message text.

## Deployment acceptance

- [ ] Provision a dedicated Sales WhatsApp number.
- [ ] Run a pinned OpenWA version with persistent browser/session storage.
- [ ] Put its API on loopback/private networking and set an API key.
- [ ] Configure the HTTPS CMS webhook with `X-Webhook-Secret`.
- [ ] Scan the QR code and confirm `/health` reports a ready session.
- [ ] Send one test message to an internal number and reply to it.
- [ ] Confirm both directions appear once in Contact Logs.
- [ ] Exercise restart/session restore and document the relink owner.
- [ ] Agree rate limits, customer-consent rules, and incident rollback.

## Deliberately excluded from this slice

- Bulk or campaign messaging.
- Automatic replies or agent-generated sends.
- Meta-approved templates while OpenWA is active.
- Automatic OpenWA-to-Meta failover.
