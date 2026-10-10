# GRAV Voice Provider Boundary

**Decision date:** 8 October 2026  
**Status:** Accepted for implementation

## Parallel-provider amendment — 8 October 2026

Exotel remains the active provider while Knowlarity is evaluated. GRAV Voice
shows both providers as an explicit per-call choice and never silently falls
back from one provider to the other. Every call stores its provider identity;
status refresh and recording playback dispatch through that stored identity,
so introducing Knowlarity cannot break historical Exotel calls.

Knowlarity stays visibly "setup in progress" until GRAV receives account-
specific Click2Call, call-detail and recording API access. A marketing/demo
request or a generated Click2Call URL alone does not satisfy the product's
recording guarantee and must not enable its live call button.

## Browser-call amendment — 8 October 2026

The product owner wants an optional browser softphone so an employee can speak
inside GRAV Voice without first receiving a callback on a Jio/Airtel handset.
The accepted design uses the existing LiveKit Cloud project for browser media
and an Exotel outbound SIP trunk for Indian PSTN termination. This is distinct
from both the existing `Calls/connect` callback bridge and Exotel's Veeno
browser product. The browser receives only a short-lived LiveKit room token;
LiveKit holds the Exotel trunk reference and creates the customer as a SIP
participant in that room.

An authenticated read-only probe of the `grav61` account on 8 October 2026
returned `Exotel API Version v2 not supported`. Dynamic SIP Trunking is not
enabled for this account yet. GRAV must therefore:

- keep the working PSTN bridge as the only live Exotel mode until enablement;
- never send Exotel API, WebRTC client-secret or SIP credentials to the browser;
- use short-lived, server-issued LiveKit authentication after Exotel enables
  Dynamic SIP Trunking and supplies an outbound trunk;
- show browser calling as unavailable, not as a button that silently falls
  back to the employee's phone;
- keep browser and callback calls in the same company-owned `CallEvent`
  lifecycle while identifying the browser path as `outbound_browser`;
- add LiveKit Egress (or a verified Exotel SIP-trunk recording contract) before
  claiming that browser calls are recorded.

The CMS and server integration may be prepared behind this explicit capability
gate. A real PSTN call remains blocked until Exotel enables v2 SIP trunking and
`LIVEKIT_SIP_OUTBOUND_TRUNK_ID` is configured. This is an external provisioning
gate, not a frontend defect.

## Self-service SIP amendment — 8 October 2026

Plivo is the configured self-service SIP provider for the browser-call MVP.
The Plivo CX India flow successfully provided self-service signup, KYC, a local
number and an outbound SIP trunk. LiveKit trunk `ST_B4w69aME82ne` terminates at
Plivo with caller ID `+918065395337` and destination country `IN`. Telnyx stays
available as a parallel candidate rather than being removed.

The provider choice is stored on every browser `CallEvent`. Existing Exotel
callback and browser records continue to resolve through Exotel; selecting
Plivo or Telnyx never silently changes or migrates them. Plivo is enabled only
when all five server-side values exist:

```text
LIVEKIT_URL=<existing GRAV LiveKit project URL>
LIVEKIT_API_KEY=<server-only key>
LIVEKIT_API_SECRET=<server-only secret>
LIVEKIT_PLIVO_SIP_OUTBOUND_TRUNK_ID=<LiveKit outbound trunk ID>
PLIVO_CALLER_ID=<KYC-approved Indian Plivo number in E.164>
```

The Plivo SIP username and password belong in Plivo/LiveKit provisioning only;
they must not be returned to the CMS browser or persisted in GRAV application
records. Browser calls use audio-only LiveKit room-composite Egress. The mixed
recording is written directly to a GRAV-controlled GCP/Firebase bucket,
identified on the company-owned `CallEvent`, and played only through the
authenticated GRAV recording route. Production credentials must belong to a
dedicated service account restricted to that recording bucket; the broader
Firebase service-account fallback is only for local MVP commissioning.

## Decision

Build GRAV Voice as a provider-neutral recorded call bridge inside Sales / CRM.
Use a licensed telephony provider for Indian PSTN connectivity and recording.
Implement Exotel as the first adapter, but do not put Exotel request/response
fields into route handlers, CRM components or the core `CallEvent` lifecycle.

Release 1 calls the employee's existing corporate Jio number as the agent leg.
It does not build a native iOS audio client and does not claim to record calls
made directly through the iPhone Phone app.

## Why

- iOS does not expose ordinary cellular call audio to GRAV.
- The bridge records server-side and therefore works with an unmodified iPhone.
- Exotel's published API already supports the required two-number bridge,
  virtual caller ID, recording and status callback.
- A stable internal contract prevents telephony pricing, coverage or service
  changes from becoming an application rewrite.
- The repository already treats `CallEvent` as the single call-history source;
  a second provider-call collection would recreate the split that earlier work
  deliberately removed.

## Non-negotiable consequences

1. Provider credentials and callback secrets are server-only.
2. The client never selects the employee phone number.
3. The release-1 customer number comes from an authorised CRM entity.
4. New provider calls are company-owned; legacy unowned call rows are not an
   excuse to create more unowned data.
5. Provider call ID is the correlation key. Phone-plus-time matching remains
   only for legacy device uploads.
6. A webhook is a notification, not proof. Terminal state and recording details
   are fetched from the provider before being committed.
7. Provider recording URLs are temporary ingestion sources and are never
   browser playback URLs.
8. Recording notice and retention policy are deployment gates.
9. Direct SIM calls remain outside the system and are labelled accordingly.

## Rejected alternatives

### Jailbreak the iPhone

Rejected for security, reliability, device-management and legal reasons.

### Capture cellular audio in a native iOS app

Not available through supported Apple APIs.

### Put Exotel calls in a new collection

Rejected because it would split one conversation across parallel histories and
break existing CRM evidence, summary and playback paths.

### Trust callback payloads as final truth

Rejected because the webhook endpoint is public and delivery can be duplicated,
delayed or forged. The provider detail API is the authority.

## Initial provider capability fit

Exotel is the first adapter candidate, not a permanent product dependency. Its
official API documents:

- `POST /v1/Accounts/{account_sid}/Calls/connect`;
- first-leg employee and second-leg customer calling;
- virtual-number caller ID;
- `Record=true` and optional dual-channel recording;
- terminal status callback;
- call-detail and recording retrieval.

Commercial account availability, number allocation, call announcement support,
pricing, data residency and final India compliance remain procurement gates.
