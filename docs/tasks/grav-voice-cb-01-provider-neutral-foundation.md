# GRAV VOICE — CB-01 Provider-Neutral Foundation

**Status:** IN PROGRESS — provider contract, canonical lifecycle, fake adapter
and additive `CallEvent` fields implemented; bridge service and routes pending  
**Parent product:** `docs/product/grav-voice-call-bridge.md`  
**Decision:** `docs/decisions/grav-voice-call-bridge-provider-boundary.md`

**Existing-system audit:**
`docs/audits/grav-voice-existing-call-foundation-2026-10-08.md`

## Goal

Create the safe internal contract for recorded bridge calls without placing a
real chargeable call. CB-01 ends with deterministic tests using a fake provider.

## Backend scope

### 1. Extend `CallEvent`

Add optional legacy-compatible fields:

```text
companyId                  ObjectId, required for bridge sources
provider                   enum: exotel | fake
providerCallId             string
providerParentCallId       string | null
providerStatus             canonical state
providerDirection          inbound | outbound_bridge
businessNumber             string, normalised snapshot
initiatedBy.userId         ObjectId/string snapshot
initiatedBy.employeeId     string
initiatedBy.email          string
salesPersonId              ObjectId | null
crmSource.kind             lead | account | contact | inbound_match | null
crmSource.externalId       ObjectId/string | null
recordingSync.status       pending | available | importing | imported | failed | not_expected
recordingSync.failureCode  string | null
recordingSync.lastAttemptAt Date | null
providerOccurredAt         Date | null
```

Do not store provider credentials. Do not expose provider recording URLs.

Add partial indexes:

- unique `{ companyId, provider, providerCallId }` where provider identity is
  present;
- `{ companyId, startTime: -1 }`;
- `{ companyId, "initiatedBy.employeeId": 1, startTime: -1 }`.

Legacy rows remain valid. Every service that creates a bridge source must refuse
to proceed without a resolved company.

### 2. Canonical lifecycle

Define one internal state set:

```text
QUEUED
AGENT_RINGING
CUSTOMER_RINGING
IN_PROGRESS
COMPLETED
AGENT_NO_ANSWER
AGENT_BUSY
CUSTOMER_NO_ANSWER
CUSTOMER_BUSY
FAILED
CANCELLED
```

Provider adapters translate their vocabulary into this set. Unknown values fail
closed to `FAILED` with a redacted diagnostic; they do not become completed.

### 3. Provider contract

Create `services/telephony/provider.js` and a fake adapter with:

```text
initiateBridgeCall(command)
getCall(providerCallId)
getRecording(providerCallId)
normaliseWebhook(payload)
health()
```

The command contains already-authorised E.164 values, an idempotency reference,
callback URL and compliance playback configuration. The adapter never resolves
employees, customers or company scope.

### 4. Bridge service

Create a service that:

- accepts an authenticated request plus CRM source identity;
- resolves Sales company scope once;
- resolves the actor's own active Sales Person row;
- refuses a missing/inactive roster row or work phone;
- resolves the destination through a company-scoped Lead/Account/Contact read;
- refuses ambiguous or absent phone numbers;
- creates the pending `CallEvent` before calling the provider;
- passes a server-generated immutable correlation reference;
- records provider identity exactly once;
- returns a safe view with no employee phone, provider secret or recording URL;
- treats a duplicate idempotency key as a replay of the original command.

Before this service is allowed to place even a fake call, company-scope the
Sales Person roster as specified by the existing-system audit. A global roster
lookup is not an acceptable shortcut.

### 5. Routes

Mount under `/api/cms/crm/voice`:

```text
POST /calls             initiate one outbound bridge call
GET  /calls/:id         safe live status for a company-owned call
POST /webhooks/:token   public provider notification endpoint
GET  /health            authorised configuration health only
```

`POST /calls` requires an `Idempotency-Key` header. Initial body:

```json
{
  "source": { "kind": "lead", "id": "..." },
  "phoneField": "primary"
}
```

Do not accept `agentPhone`, `customerPhone`, `companyId`, `provider`, `record`
or `callerId` from the browser.

The public webhook route is mounted outside Sales authentication. It validates
the installation token, extracts only provider identity, queues/idempotently
performs provider reconciliation and responds quickly.

### 6. Tests

- company is resolved once and stamped;
- actor without an active roster entry is refused;
- actor cannot select another employee's phone;
- destination is resolved from an owned CRM record;
- foreign-company source returns the same answer as missing;
- arbitrary destination fields are ignored/refused;
- missing idempotency key is refused;
- retry returns the original event and calls the provider once;
- provider rejection leaves a visible failed event;
- duplicate webhooks remain one event;
- forged token is refused;
- webhook fields cannot change company, phones or CRM identity;
- terminal reconciliation fetches provider truth;
- completed-without-recording becomes a recording exception;
- safe response contains no provider credentials or recording URL.

## Frontend scope

CB-01 adds no production Call button. A provider-free preview may demonstrate
the states, but live UI waits for CB-02's sandbox proof so the interface cannot
promise a call that has never been connected.

## Explicitly out of scope

- live Exotel credentials or chargeable calls;
- inbound routing;
- recording download/import;
- transcription and AI analysis;
- free-form dialling;
- native iOS application;
- disabling the iPhone Phone app;
- modifying historical PersonalCallRecorder rows.

## Acceptance

CB-01 is complete when the fake-provider integration proves initiation,
idempotency, canonical state transitions, company isolation and forged-webhook
refusal without external network access.
