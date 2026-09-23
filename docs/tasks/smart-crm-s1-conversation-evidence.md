# SMART CRM — S1 Conversation Evidence Foundation

**Status:** READY FOR IMPLEMENTATION  
**Sequence:** S1 of S7  
**Scope:** Backend contract and tests first; smallest linking UI second.

## 1. Goal

Create the trustworthy bridge that allows recorded/transcribed phone calls and
CoWork meetings to become evidence for CRM intelligence.

S1 does not interpret transcripts yet and does not render Sales Today. It makes
the next chunks safe and idempotent.

## 2. Sources already present

### Calls

- `models/CallEvent.js`
- `routes/CMS_Routes/Sales/callEvents.js`
- `routes/CMS_Routes/Sales/callRecordings.js`
- `services/callRecordingMatch.service.js`

### Meetings

- `cowork_scheduled_meets/{meetId}`
- `meeting_audio_recordings`
- `meeting_verbatim_transcripts/{meetId}`
- `meeting_summaries/{meetId}`
- `routes/task_routes/meetingTranscript.routes.js`
- `routes/task_routes/meetingSummary.routes.js`

### CRM destination

- `Lead` or `CRMAccount` owns the conversation context.
- `SalesJourney` is an optional Account-owned tag.
- `CRMActivity` remains the accepted activity/timeline record.

## 3. Backend work

### S1.1 Constants

Add fixed codes for:

- source kind: `call_event`, `cowork_meeting`;
- link method: `phone_exact`, `contact_exact`, `manual_verified`;
- link status: `active`, `unlinked`;
- transcript kind: `device`, `verbatim`, `translated`;
- analysis status: `pending`, `ready`, `failed`, `superseded`.

Do not place these in configurable `CRMSettings`: they are data-contract values,
not administrator labels.

### S1.2 `CRMConversationLink` model

Implement the accepted decision document exactly. Reuse the existing company
ownership helpers. Enforce:

- exactly one of `leadId` or `accountId`;
- a Journey only with an Account and only when it belongs to that Account;
- contact references only within the owning Lead/Account;
- an active unique source link per company/source/external ID;
- immutable source identity and ownership after creation;
- soft unlink with actor, date and reason;
- created/updated actor snapshots.

Use a collision-safe generated human reference. Do not use `countDocuments()+1`.

### S1.3 `CRMConversationAnalysis` model

Add the versioned shell now so later extraction does not require a data-model
rewrite. S1 may create no analysis rows, but the schema and indexes must exist.

Required indexes:

- conversation link + version unique;
- conversation link + transcript fingerprint;
- current/status query;
- company + status + created date.

Evidence excerpts must have a conservative maximum length. Full transcript text
is forbidden in this model.

### S1.4 Source resolvers

Provide provider-shaped readers:

```text
resolveCallSource(callEventId, actor, companyScope)
resolveMeetingSource(meetId, actor)
```

Both return a neutral metadata contract: source ID, occurred date, participants,
recording/transcript availability and authorized source references.

The meeting reader must:

- load `cowork_scheduled_meets/{meetId}`;
- resolve the Sales actor's employee ID;
- require the actor to be creator or participant;
- report transcript/summary availability without returning full text;
- distinguish not found, forbidden and not-yet-transcribed.

No general “Sales manager reads every CoWork meeting” exception in S1.

### S1.5 Link service

Implement one service used by every route:

```text
linkConversation(input, actor, companyContext)
unlinkConversation(id, reason, actor, companyContext)
getConversationLink(id, actor, companyContext)
listConversationLinks(filters, actor, companyContext)
```

The service, not the client, verifies source access, entity ownership, Journey
membership and contact membership.

For calls:

- exact normalized phone/contact matches may create an exact link;
- fuzzy name matches may be returned as candidates but never committed without
  `manual_verified`;
- an ambiguous identity must be refused, matching existing auto-sync policy.

For meetings:

- S1 accepts `manual_verified` only;
- the actor must explicitly select the CRM context.

### S1.6 Routes

Mount under `/api/cms/crm/conversations`:

```text
GET    /                         list accessible links
GET    /:id                     detail without transcript body
POST   /link-call               link one CallEvent
POST   /link-meeting            link one CoWork meeting
POST   /:id/unlink              soft unlink with reason
GET    /meeting/:meetId/status  authorized metadata + existing link state
GET    /call/:callEventId/status authorized metadata + existing link state
```

Writes use the existing Sales write/approval conventions. A held write must not
be presented as a committed link.

### S1.7 Activity source identity

Add an optional source reference to `CRMActivity`:

```text
source.kind
source.externalId
source.conversationLinkId
```

It is server-controlled and immutable after creation. Existing manual
Activities remain valid with no source. Add a partial unique index that prevents
one source conversation being logged twice into the same owning CRM context.

Update call auto-sync to populate this identity. Retain the old time-window
dedupe only for historical source-less Activities.

## 4. Smallest frontend

Do not build Sales Today in S1.

Add “Link to CRM” for an accessible CoWork meeting, with:

- Lead or Account search;
- optional Journey selector restricted to the chosen Account;
- optional contact selector;
- a clear statement that linking makes the meeting available as evidence;
- existing-link display;
- unlink action requiring a reason.

The control may live first on the CoWork meeting detail. Do not duplicate the
meeting player or transcript inside Sales.

For calls, expose existing exact link status and a correction action where the
current match is ambiguous or wrong.

## 5. Tests

### Model/service

- exactly-one owner invariant;
- immutable source and owner;
- active-source uniqueness and idempotent retry;
- unlink preserves the row and allows no silent relink to a different customer;
- Journey/Account mismatch refused;
- Contact/owner mismatch refused;
- company isolation;
- collision-safe reference generation.

### Calls

- exact phone match accepted;
- fuzzy-name automatic link refused;
- ambiguous phone automatic link refused;
- manually verified correction records actor and method;
- repeat request returns the existing link;
- auto-synced Activity stores source identity;
- historical Activity fallback dedupe still works.

### Meetings

- organiser can inspect/link;
- participant can inspect/link;
- non-participant is forbidden even with Sales access;
- actor lacking access to target CRM record is forbidden;
- nonexistent meeting and missing transcript are distinct;
- transcript is not returned by list/status routes;
- repeat link is idempotent;
- unlink is audited.

### Approval and audit

- editor write held for approval creates no active link;
- accepted link and unlink produce change-log entries;
- read-only actor cannot link/unlink.

## 6. Acceptance

S1 is complete only when:

1. A recorded CallEvent can be tied to one CRM context with stable source
   identity and no timestamp-based duplicate on new rows.
2. A CoWork organiser/participant can explicitly link a meeting to a visible
   Lead or Account and optional valid Journey.
3. Sales list responses expose source availability without transcript bodies.
4. CoWork media and transcripts remain behind CoWork authorization.
5. Every link/unlink is company-scoped, authorized and audited.
6. The analysis shell can safely accept S2's versioned transcript outputs.
7. No transcript has changed a CRM field, stage, price, approval or task.

## 7. Explicitly out of scope

- transcript extraction or prompting;
- Sales Today ranking/feed;
- automatic meeting-to-customer inference;
- autonomous tasks or outreach;
- copied audio/transcript blobs;
- win scoring and revenue forecasting;
- changes to qualification/Journey state machines;
- redesign of Accounts, Customers or Contact Logs.

## 8. Review gate

After implementation, Codex reviews the complete diff for:

- Sales/CoWork authorization composition;
- company isolation;
- idempotency and partial failure;
- source and transcript privacy;
- Activity backward compatibility;
- indexes and query bounds;
- proof that S2 did not begin.

