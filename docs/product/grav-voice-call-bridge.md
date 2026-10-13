# GRAV Voice — Recorded Call Bridge

**Product status:** Approved direction, implementation starting 8 October 2026  
**Owning app:** Sales / CRM  
**Primary users:** GRAV sales employees and authorised sales managers

## 1. Product outcome

GRAV Voice gives each enabled employee an administrator-assigned business
number and makes every call through that number a traceable CRM conversation.
Numbers are unique: one DID has one active employee owner. A company may begin
with one provisioned pilot number, but the application model must never make
every employee silently share it.

The first release is a telephone call bridge, not a native VoIP replacement for
the iPhone Phone app:

- a customer calls an employee's assigned GRAV Voice number and that employee
  receives a centered incoming-call overlay on any authenticated CMS page;
- an employee starts an outbound call from GRAV CMS, the bridge rings the
  employee first, then rings the customer;
- the licensed telephony provider remains in both call legs and records the
  connected conversation server-side;
- terminal status, duration and recording are reconciled into the existing
  `CallEvent` record and shown in the CRM call log.

This preserves ordinary cellular reliability for employees while making the
assigned GRAV Voice number, rather than a personal handset, the customer-facing
identity.

## 2. Explicit boundary

GRAV Voice cannot capture, redirect or record a call dialled directly from the
iPhone Phone app through a normal Jio SIM. Apple Configurator and MDM cannot
disable the Phone app on iPhone.

Release 1 therefore guarantees recording only for calls that enter through the
assigned GRAV Voice numbers or are initiated through the GRAV CMS call action. Direct
SIM calls remain outside the system and must never be presented as recorded.

## 3. Call journeys

### 3.1 Incoming

1. A customer calls the published GRAV number.
2. The provider plays the configured recording notice before the conversation
   is recorded.
3. The provider applies business hours and routing rules.
4. It rings the selected employee's corporate Jio number.
5. When the employee answers, the provider bridges both legs.
6. Provider events update one company-owned `CallEvent` throughout the call.
7. After termination, GRAV independently fetches final call details and the
   recording from the provider.
8. The recording is copied into GRAV-controlled storage and becomes playable
   through the existing authenticated CRM audio route.

### 3.2 Outgoing

1. An authenticated employee selects a Lead, Account or Contact and presses
   **Call through GRAV**.
2. The backend resolves the employee's active Sales Person roster entry and
   corporate work number. The client cannot supply or replace the agent number.
3. The backend resolves the customer's phone from the selected company-owned
   CRM record. Arbitrary free-form destinations are excluded from release 1.
4. The provider rings the employee first.
5. After the employee answers, the provider plays the recording notice and
   rings the customer using that employee's assigned GRAV Voice number as caller ID.
6. The provider bridges and records the conversation.
7. Webhook reconciliation completes the same `CallEvent` and links it to the
   chosen CRM source identity.

### 3.3 Failure outcomes

The UI must distinguish at least:

- employee did not answer;
- employee was busy;
- customer did not answer;
- customer was busy;
- provider rejected the request;
- provider status could not be verified;
- call connected but recording was not delivered;
- recording import failed after a connected call.

A missing recording is a visible exception, never a successful recorded call.

## 4. Functional requirements

### Calling

- One provisioned number for the pilot, with a distinct per-user number
  assignment contract ready for additional DIDs.
- Inbound ringing is mounted in the persistent CMS shell. The assigned employee
  can answer, mute and end the call without first navigating to GRAV Voice; the
  dedicated Voice page retains its richer phone controls.
- Inbound routing to an active Sales Person roster entry or configured queue.
- Outbound click-to-call from an authorised CRM entity.
- Server-controlled agent and customer numbers.
- Configurable business hours, ring timeout and fallback destination.
- Idempotent initiation so a browser retry cannot create a second chargeable
  call.
- A hard rate limit and an audit event for every initiation attempt.

### Recording

- Recording enabled by the server for every bridged call.
- A recording notice controlled by the company compliance configuration.
- Dual-channel recording when the provider/account supports it; single-channel
  is an accepted pilot fallback.
- Provider recording URLs are never returned to browsers.
- GRAV imports the recording into its controlled storage before presenting it
  as available.
- Playback continues through the existing authenticated Sales route.
- Recording access, download, summary and future transcript access are audited.

### CRM

- Continue using `CallEvent` as the one call-history record.
- Add stable provider identity rather than correlating provider calls by phone
  number and time window.
- Stamp company ownership on every new provider-backed call.
- Preserve historical PersonalCallRecorder rows without pretending they have a
  company or provider identity.
- Link outbound calls to the selected Lead, Account or Contact using immutable
  server-owned source references.
- Match inbound callers conservatively; ambiguous numbers remain unlinked for
  manual verification.

### Administration

- Configure provider account, business number and callback origin through
  server secrets, never through the browser.
- Configure inbound queue membership from active, company-owned Sales Person
  roster entries.
- Provide a provider-health check without returning credentials.
- Expose recording gaps and webhook reconciliation failures to administrators.

## 5. Security and tenancy requirements

- Every authenticated command resolves company membership through the shared
  Sales company-scope service.
- `companyId` is server-derived and mandatory on every new bridge call.
- Provider call identity is unique within company and provider.
- Employee work number is read from the active Sales Person roster.
- Customer number is read from the authorised CRM record.
- The browser never receives provider API credentials, recording credentials or
  unrestricted provider URLs.
- Public webhooks do not trust event fields alone. A terminal event is accepted
  as a notification to fetch the authoritative call from the provider before
  mutating business state.
- Webhook requests carry a high-entropy installation token and are rate-limited.
- Logs redact phone numbers, provider credentials and recording URLs.
- No call is initiated from a GET request.

## 6. Provider boundary

The product depends on capabilities, not one vendor's field names:

```text
initiateBridgeCall(command) -> provider call identity
getCall(providerCallId) -> authoritative status and leg data
getRecording(providerCallId) -> authorised recording stream/metadata
normaliseWebhook(payload) -> notification identity only
health() -> configured/reachable status
```

The initial adapter targets Exotel because its published India API supports
connecting two numbers, a virtual caller ID, recording, dual channels and
terminal status callbacks. Other licensed providers can implement the same
contract later.

## 7. Data lifecycle

The provider is the transport and temporary recording source. GRAV is the
system of record after successful import.

Recommended initial retention:

- call metadata: retained with the CRM relationship;
- audio: configurable retention, default 180 days only after legal approval;
- webhook payload diagnostics: 30 days, redacted;
- audit events: retained according to the existing company audit policy.

The final retention period, recording announcement and download permission are
release gates requiring a written company policy and Indian legal review.

## 8. Release sequence

1. **CB-01 — provider-neutral foundation:** safe model contract, adapter
   interface, mocked initiation/reconciliation tests and no live calls.
2. **CB-02 — Exotel sandbox:** one pilot number, outbound bridge, terminal
   webhook verification and recording import.
3. **CB-03 — CMS calling surface:** Call through GRAV action, live status and
   failure messages on the existing call log.
4. **CB-04 — incoming routing:** business hours, queue/fallback rules, inbound
   identity matching and missed-call visibility.
5. **CB-05 — controlled pilot:** five employees, consent notice, permissions,
   audit, retention and operational runbook.
6. **CB-06 — browser calling:** join the employee's CMS browser to a private
   LiveKit room and create the customer as a SIP participant through an Exotel
   outbound trunk. Keep callback calling available. Enable the control only
   after Exotel v2 Dynamic SIP Trunking is active and the LiveKit outbound
   trunk ID is configured. Recording requires a separate verified LiveKit
   Egress or Exotel trunk-recording slice.

## 9. Pilot acceptance

The pilot is accepted only when:

1. a customer can call the GRAV number and reach a rostered employee's Jio
   phone;
2. an employee can start a call from a visible CRM record without typing either
   party's phone number;
3. both journeys create exactly one company-owned `CallEvent` despite retries;
4. connected calls are recorded and playable only by authorised Sales users;
5. missed, busy, failed and unrecorded calls are visible and truthful;
6. a forged webhook cannot complete a call or attach an audio file;
7. another company cannot see, initiate, reconcile or play the call;
8. direct iPhone SIM calls are clearly outside the guarantee.
