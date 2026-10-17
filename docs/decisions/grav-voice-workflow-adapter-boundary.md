# Decision: GRAV Voice uses workflow adapters, not a general-purpose agent

Date: 13 October 2026

## Decision

GRAV will generalise the existing MRF voice call into a shared Voice Workflow
platform. The platform owns delivery, session lifecycle, media, dialogue
turn-taking, scheduling, preferences, audit envelopes and operational health.
Each source application owns its facts, authorisation and business mutation
through a narrow workflow adapter.

The language model may understand or phrase conversation. It is not an
authority engine, scheduler or universal CMS tool runner.

```text
domain trigger or schedule
  -> idempotent voice occurrence
  -> recipient + preference + quiet-hour policy
  -> workflow adapter builds a bounded snapshot
  -> web/native delivery opens an authenticated LiveKit session
  -> GRAV Speech STT
  -> deterministic dialogue state + bounded Qwen phrasing/clarification
  -> Kokoro or approved Indic TTS
  -> adapter reauthorises and commits one confirmed domain command
  -> domain record remains the system of record
```

## Shared session envelope

Every occurrence contains a versioned shared envelope:

- `companyId`, `workflowKey`, `workflowVersion`;
- server-derived `recipientId` and authenticated participant identity;
- `subjectType` and opaque server-owned `subjectId`;
- stable `occurrenceKey` and idempotency key;
- `mode` (`DECISION`, `BRIEFING`, or `REMINDER`);
- priority, language, delivery deadline and expiry;
- lifecycle state and bounded dialogue events;
- snapshot version/hash, not an unrestricted data object;
- proposed action and confirmation as separate events; and
- adapter result or typed terminal reason.

The shared lifecycle covers queued, offered, connected, active and terminal
delivery states. Workflow-specific business states stay inside the adapter. A
single global enum will not pretend that MRF lines, leave stages and reminders
have the same transitions.

## Adapter contract

A workflow adapter must implement only the capabilities it needs:

1. `resolveRecipient(trigger)` derives the recipient on the server;
2. `buildSnapshot(actor, subject)` returns bounded speakable facts and allowed
   intents;
3. `refresh(actor, subject)` detects stale facts or lost authority;
4. `propose(transcript, state)` maps speech to a non-authoritative candidate;
5. `confirm(candidate)` supplies the exact effect to read back;
6. `commit(actor, candidate, idempotencyKey)` calls the existing domain
   service after reauthorisation; and
7. `deepLink(actor, subject)` returns an application-owned route.

Read-only adapters omit `commit`. A reminder adapter may expose `snooze` or
preference updates, but cannot mutate the reminded business object.

An adapter is registered only after its owner, allowed modes, privacy fields,
confirmation policy, expiry, cooldown, deep link and acceptance tests are
declared. There is no dynamic browser-supplied workflow key or tool schema.

## Dialogue and model boundary

The deterministic controller owns greeting, acknowledgement wait, current
phase, allowed intents, explicit confirmation, timeout and completion. Qwen may:

- turn natural language into a proposed bounded intent;
- answer from the immutable snapshot;
- ask a clarification; and
- vary short phrasing without repeating the prior sentence.

Qwen may not query arbitrary CMS data, select a recipient, widen a snapshot,
change a schedule, confirm for the listener or invoke `commit`. An unknown or
low-confidence sentence stays unknown and gets a contextual clarification.

Global dialogue acts such as pause, repeat, next, previous, open, snooze and
end are interpreted before workflow actions. A phrase that might mean either a
conversation control or a business decision is clarified, never guessed.

## Scheduling boundary

One scheduler service materialises occurrences from versioned policies. It
uses a unique occurrence key such as:

`company:workflow:recipient:subject-or-local-date:policy-version`

The durable occurrence record is claimed atomically by one scheduler process.
Restarts, retries and multiple server instances therefore cannot create a
second ring. Quiet hours, local working calendar, leave status, daily cap,
cooldown and user preference are evaluated before offer and again before a
retry.

The existing pending-reminder sweep remains a live queue counter. It may emit a
candidate trigger but does not itself decide call timing or escalation.

## Authority examples

- MRF commit calls its existing item-decision service and proves assigned
  approver authority.
- Manager leave commit proves the manager's record assignment and current
  primary/secondary stage.
- HR leave commit separately requires `LEAVE_DECIDE_HR` and the current final
  stage.
- Morning brief reads the authenticated employee's existing home aggregate and
  has no business commit method.
- Reminder snooze changes the occurrence schedule only; it never edits the
  referenced task or request.

## Data and retention

Adapters declare speakable fields. The shared platform stores only the bounded
snapshot needed to keep a call internally consistent and its hash/version for
audit. It does not become a second copy of every source record.

Lock-screen payloads remain generic. Transcript events are bounded and retained
under the workflow policy. Raw audio is not recorded by default. Sensitive
free text, including leave reasons, is spoken only after an explicit authorised
request and is excluded from push payloads and routine operational logs.

## Consequences

- New workflows reuse call delivery without inheriting MRF's business rules.
- Product teams must expose a reviewed service boundary before receiving a
  voice decision adapter; copying HTTP route handlers is not accepted.
- Read-only morning brief ships before new write-capable leave adapters, giving
  the platform a low-risk production proving path.
- Web closed-tab alerts remain best effort. Native lock-screen calling is a
  separate delivery adapter and release gate.
- A generic “AI can operate the CMS” voice agent is rejected because it would
  blur permissions, make confirmations unreliable and create unbounded data
  exposure.

