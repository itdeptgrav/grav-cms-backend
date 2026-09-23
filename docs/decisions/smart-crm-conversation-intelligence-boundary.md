# Smart CRM Conversation Intelligence Boundary

**Decision:** Accepted for implementation  
**Date:** 9 September 2026

## Context

Sales phone calls and CoWork meetings are already recorded and transcribed, but
they live in different stores and have different identity and permission
models:

- phone calls are MongoDB `CallEvent` records and are matched to customers by
  phone or, less reliably, by name;
- meeting metadata, audio, summaries and transcripts are Firestore records
  protected by CoWork authorization;
- CRM business records and Activities are MongoDB records protected by Sales
  authorization and company ownership.

The system needs to use both sources without copying business truth out of a
transcript, weakening permissions, or treating an inferred customer match as a
fact.

## Decision

Introduce two concepts.

### 1. `CRMConversationLink`

This is the stable, audited bridge between an external conversation and the CRM.

Required shape:

```text
conversationLinkId
company ownership stamp
source.kind                 call_event | cowork_meeting
source.externalId           CallEvent _id | meetId
source.occurredAt
source.transcriptKind       device | verbatim | translated
owner.leadId XOR owner.accountId
journeyRef                  optional Account-owned tag
contactId                   optional CRM Contact
leadContactId               optional embedded Lead contact
linkMethod                  phone_exact | contact_exact | manual_verified
linkConfidence              exact | verified
linkedBy / linkedAt
status                      active | unlinked
unlinkedBy / unlinkedAt / unlinkReason
```

Rules:

- Unique on company + source kind + external ID while active.
- A call matched only by fuzzy name is not automatically linkable.
- A meeting is always manually verified in S1; later scheduling flows may
  create an exact link when the customer is selected before the meeting.
- A link points to either a Lead or an Account, never both.
- Journey is a tag only and must belong to the selected Account.
- Unlinking preserves audit and supersedes open analysis; it does not delete.
- The link never contains audio or full transcript text.

### 2. `CRMConversationAnalysis`

This is a versioned derived record, not business truth.

Required shape:

```text
analysisId
conversationLinkId
version
transcriptFingerprint
transcriptSourceRef
model provider / model / promptVersion
status                      pending | ready | failed | superseded
failureCode / failureMessage
signals[]                   typed value + evidence + confidence
recommendations[]           proposed actions only
createdAt / completedAt
```

Only one ready analysis version is current for a transcript fingerprint.
Reprocessing identical input returns that version. Changed input creates a new
version and supersedes open recommendations from the previous version.

## Evidence contract

Every model-derived signal must contain:

```text
type
value
confidence                  low | medium | high
speaker                     when known
startSecond / endSecond     when known
excerpt                     short and bounded
needsReview
```

An analysis response may summarize the source, but a client must request a
specific authorized source to read the full transcript.

## Store and authorization boundary

- MongoDB owns CRM links, analyses, recommendations and accepted Activities.
- Firestore remains authoritative for CoWork meetings, audio, transcripts and
  meeting summaries.
- `CRMConversationLink` stores Firestore document identifiers, never copied
  audio or transcript blobs.
- Linking a meeting requires both checks in the same request:
  1. Sales actor can see the target Lead/Account/Journey.
  2. CoWork identity for that actor is an organiser or participant, unless a
     separately named management capability authorizes broader access.
- A manager's Sales role alone does not silently grant access to every CoWork
  transcript.

## Action boundary

Analysis can propose a task or field change. It cannot write those fields.
Acceptance calls the existing Lead/Account/Activity/Journey service with normal
authorization and audit. The accepted recommendation stores the resulting
record ID.

No model output may directly change lifecycle, pricing, approval, PO, payment,
order or do-not-contact state.

## Alternatives rejected

### Put intelligence fields directly on `CallEvent` and meeting documents

Rejected because it duplicates the feature across stores, couples Sales state
to CoWork retention and provides no shared recommendation lifecycle.

### Copy all transcripts into MongoDB

Rejected because it expands the access surface and defeats CoWork's existing
authorization and retention boundary.

### Infer meeting customer from the title or transcript

Rejected because an incorrect link can expose one customer's conversation on
another customer's record. Model suggestions may help a user find a candidate,
but a person must verify the first link.

### Write extracted values directly to CRM fields

Rejected because transcript errors and ordinary conversational ambiguity would
become commercial facts. The first system proposes with evidence; authorized
people commit.

## Consequences

- A small linking step is required for existing meetings.
- New customer-meeting scheduling should later select the CRM context up front.
- The same analysis and recommendation contract works for calls and meetings.
- Reprocessing, audit, correction and future model changes remain explainable.
- Sales can use meeting intelligence without taking ownership of CoWork media.

