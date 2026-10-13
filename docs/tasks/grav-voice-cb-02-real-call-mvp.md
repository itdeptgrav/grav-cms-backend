# GRAV Voice — CB-02 Real-call MVP

**Status:** IMPLEMENTED, configured and KYC-active; browser call and recording verification active  
**Date:** 8 October 2026

## Outcome

An authorised CMS user can open the standalone **GRAV Voice** application and
run an outbound bridge test. Exotel calls the employee mobile first, calls the
customer after the employee answers, presents the ExoPhone as caller ID and
records the connected conversation.

## Deliberately temporary test dialler

The MVP accepts two typed phone numbers only while
`GRAV_VOICE_ALLOW_TEST_DIALLER=1`, and only for a session whose signed token
carries `isAdmin: true`. This is a controlled commissioning tool, not the
production calling contract.

Before general employee release, replace those fields with:

- the authenticated actor's active, company-owned Sales Person work phone;
- a selected company-owned Lead, Account or Contact phone;
- the production initiation rate limit and audit event.

Turning the flag off disables live initiation without removing call history.

## Server configuration

```text
EXOTEL_ACCOUNT_SID=<account SID>
EXOTEL_API_KEY=<API key>
EXOTEL_API_TOKEN=<API token>
EXOTEL_CALLER_ID=<trial or purchased ExoPhone>
EXOTEL_API_BASE_URL=https://api.in.exotel.com
GRAV_VOICE_ALLOW_TEST_DIALLER=1
```

For automatic callback updates also set:

```text
EXOTEL_WEBHOOK_BASE_URL=https://<public GRAV backend host>
EXOTEL_WEBHOOK_TOKEN=<at least 32 random characters>
```

The callback origin must be public HTTPS. These two callback settings are
optional for the first local call: the UI's Refresh button can reconcile it.

For direct browser-to-customer calling through the configured Plivo path, keep
the existing LiveKit server credentials and add:

```text
LIVEKIT_PLIVO_SIP_OUTBOUND_TRUNK_ID=<LiveKit Plivo outbound trunk ID>
PLIVO_CALLER_ID=<KYC-approved Indian Plivo number in E.164>
```

The current MVP uses `ST_B4w69aME82ne` and `+918065395337`. Plivo SIP
credentials stay in Plivo and LiveKit; they do not belong in the CMS browser or
the GRAV backend environment.

Browser recording uses an audio-only LiveKit room-composite Egress. LiveKit
writes the mixed employee/customer MP3 directly into GRAV-controlled Google
Cloud Storage, and the CMS streams it only through the authenticated,
company-scoped recording route. Configure a bucket-limited service account for
production:

```text
LIVEKIT_EGRESS_GCP_BUCKET=<GRAV recording bucket>
LIVEKIT_EGRESS_GCP_CREDENTIALS=<one-line GCP service-account JSON>
```

For the local MVP these values fall back to `FIREBASE_STORAGE_BUCKET` and
`FIREBASE_SERVICE_ACCOUNT`. Production must use a dedicated service account
restricted to the recording bucket before employee rollout.

Telnyx remains available as an independent future browser provider:

```text
LIVEKIT_TELNYX_SIP_OUTBOUND_TRUNK_ID=<LiveKit Telnyx outbound trunk ID>
TELNYX_CALLER_ID=<KYC-approved Indian Telnyx number, for example +9198...>
```

The CMS exposes Plivo, Telnyx and Exotel as separate browser-call choices. It
enables each choice only when that provider's own trunk ID and caller ID are
present.

## Safety boundaries

- Exotel credentials never reach the browser.
- Company ownership is resolved by the existing Sales company-scope service.
- A browser request ID is reserved before provider initiation to prevent a
  retry from ringing twice.
- Recording URLs remain server-side; playback is proxied through an
  authenticated, company-scoped endpoint.
- The public callback token is only a wake-up signal. GRAV fetches the
  authoritative call from Exotel before storing status.
- Direct calls from the iPhone Phone app remain outside GRAV Voice.

## Remaining release gates

1. Place one browser-to-phone call from `/voice`; verify the Plivo business
   caller ID, two-way LiveKit audio, final status and playable mixed MP3 in GRAV.
2. Add a recorded-call announcement approved for GRAV's jurisdiction and use.
3. Replace the commissioning dialler with roster/CRM selection before employee
   rollout.
