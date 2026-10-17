# GRAV Voice Automation platform — implementation roadmap

## Scope

Implement:

- `docs/product/grav-voice-automation-platform.md`; and
- `docs/decisions/grav-voice-workflow-adapter-boundary.md`.

MRF remains live while it is moved behind the shared contracts. Do not begin a
second voice stack or duplicate LiveKit, STT, TTS or push infrastructure.

## Sequential slices

### VWF-00 — freeze MRF parity

- Pin existing MRF offer, answer, natural dialogue, separate confirmation,
  commit, later, timeout and closed-tab push behaviour with contract tests.
- Record current session fields and frontend event dependencies.
- No schema migration begins until the parity suite passes.

### VWF-01 — shared workflow registry and occurrence model

- Add a server-owned registry with versioned adapter metadata.
- Add the shared occurrence envelope, stable occurrence key, lifecycle events,
  expiry and atomic claim.
- Enforce one active occurrence per workflow subject and recipient.
- Add typed terminal reasons for preference, quiet hours, cap, stale authority,
  offline delivery, expiry and runtime failure.

Acceptance: concurrent schedulers and repeated triggers produce one occurrence
and one offer.

### VWF-02 — delivery, preference and fatigue policy

- Reuse the current LiveKit room/token, worker dispatch, Web Push and global
  call overlay behind workflow-neutral interfaces.
- Add per-user language, working timezone, quiet hours, working days, daily
  call cap, workflow enablement, cooldown, escalation and temporary pause.
- Enforce policy on the server; the browser display is not the authority.
- Keep a normal notification/deep-link fallback for every skipped call.

Acceptance: no routine call outside policy, no duplicate offer after restart,
and a muted workflow never rings while its ordinary queue remains visible.

### VWF-03 — shared dialogue acts and natural phrasing

- Generalise greeting/acknowledgement, repeat, pause, resume, next, previous,
  skip, open, snooze and end-call.
- Preserve noise/VAD settings and smooth barge-in recovery.
- Give Qwen a workflow-declared snapshot and allowed-intent schema only.
- Retain anti-repetition checks and separate decision/confirmation turns.

Acceptance: paraphrase tests, interruption continuation, silence/background
noise tests and ambiguous-intent clarification pass across all three modes.

### VWF-04 — read-only morning brief pilot

- Build the snapshot only from `employeeHome.service.homeFor(actor)`.
- Prioritise immediate attendance, upcoming meetings/interviews, overdue/due
  work and owned approval counts; allow section navigation.
- Materialise at most one occurrence per employee/local working date.
- Support open-in-app, skip, end and a separately confirmed reminder request.
- If a section reports `unavailable`, speak that state instead of claiming zero.

Acceptance: no cross-user data, one brief per date across multiple servers,
honest partial failure, and no source-record mutation.

### VWF-05 — reminders and snooze

- Introduce durable one-off and recurring personal reminder policies.
- Allow the existing pending counters to propose escalation only when the user
  opted in and the queue is still non-zero.
- Make snooze idempotent and timezone-aware; cancel the occurrence when its
  source is no longer pending.
- Add “stop this reminder” and “disable this call type” with explicit scope.

Acceptance: a snooze rings once, resolved queues stop ringing, and hourly
counter sweeps cannot create hourly calls.

### VWF-06 — manager leave adapter

- Extract or reuse the manager decision service rather than calling the HTTP
  route internally.
- Preserve primary/secondary assignment, quick-apply classification, balances,
  attendance sync, notifications, audit and rejection-reason rules.
- Default spoken facts to requester, dates, duration, type and stage; reveal
  free-text reason only on explicit request.
- Reauthorise and reload immediately before commit.

Acceptance: a non-assigned manager, wrong stage, stale record and replayed
confirmation cannot change leave.

### VWF-07 — HR final leave adapter

- Keep it separate from VWF-06 and require `LEAVE_DECIDE_HR` at offer and
  commit.
- Preserve the rule that HR cannot front-run a required primary approval.
- Confirm the exact final effect and any required remarks before mutation.

Acceptance: manager and HR adapters cannot perform each other's transitions.

### VWF-08 — Voice Automation operations and Lab

- Add workflow catalogue, rollout state, policy health, scheduler claims,
  delivery/model health, attempts and typed failures to IT.
- Extend Voice Lab with synthetic MRF, leave, morning-brief and reminder
  fixtures.
- Synthetic adapters must have no production `commit` implementation.
- Add user-facing voice preferences outside IT.

Acceptance: IT can diagnose and simulate but cannot approve a real record.

### VWF-09 — controlled expansion

Review and add separate adapters for regularisation, overtime, department and
accounting approvals in that order. Each requires an existing tested domain
service, recipient proof, confirmation policy, privacy review and rollback
plan. Notification-type presence alone is not sufficient.

### VWF-10 — native delivery, separately gated

Add iOS CallKit/PushKit and Android Telecom/high-priority FCM only after mobile
credentials, entitlements, background behaviour, privacy notices and
store-policy review exist. Web Push remains the accepted fallback until then.

## Recommended release order

1. VWF-00 to VWF-03: shared foundation with MRF parity.
2. VWF-04: small opt-in morning-brief pilot.
3. VWF-05: reminders and fatigue controls.
4. VWF-06 and VWF-07: leave decisions after domain-service extraction.
5. VWF-08: broad operations and synthetic workflow coverage.
6. VWF-09 and VWF-10 only after measured pilot evidence.

## Release gates

- zero authority regressions in the MRF parity suite;
- idempotent scheduling under at least two concurrent server processes;
- server-enforced quiet hours, cooldown and daily cap;
- user opt-in and per-workflow opt-out proven end to end;
- morning brief data matches the employee home response for the same actor;
- leave manager and HR-stage concurrency tests;
- no sensitive content in push payloads or standard logs;
- English acceptance plus Hindi/Odia only when their approved TTS assets are
  available; and
- metrics for delivery, completion, defer, opt-out, duplicate suppression and
  incorrect wake-up before expanding the pilot.

## Explicit non-goals for the first release

- arbitrary voice control of CMS applications;
- automatic approval based on confidence or silence;
- recording raw employee audio by default;
- PSTN/Plivo delivery;
- emergency incident calling; and
- guaranteed force-quit or lock-screen web calling.

## Implementation evidence — 13 October 2026

- The existing `/developer/voice-lab` IT surface is now the Voice Automation
  control centre rather than an MRF-only page.
- `/api/dev/voice-automation` returns a versioned, server-owned catalogue,
  current MRF runtime health and bounded recent delivery evidence.
- The screen presents decision, briefing and reminder modes; MRF, morning
  brief, reminders, manager leave, HR final leave and controlled-later
  workflows; their source owner; and the next release gate.
- MRF remains the only production decision adapter. Morning brief may report
  `pilot` when the shared voice runtime is healthy; later decision adapters
  remain `domain_gate` or `later`, so displaying a workflow cannot grant
  decision authority.
- The real MRF synthetic test remains on the same page and remains unable to
  mutate Requests.
- A self-scoped morning-brief preference now records opt-in, IST call time,
  selected weekdays and an installed voice language. The IT control centre can
  save that preference and enqueue a manual call through the normal global
  CMS overlay.
- The minute scheduler uses a stable employee/local-date occurrence key,
  records the date after every handled due occurrence and skips scheduled
  delivery when the existing Employee Home leave section says approved leave
  covers today.
- Each occurrence stores a compact read-only summary built from
  `employeeHome.service.homeFor(actor)` plus owned approval counters. The
  worker can repeat, open Home or end the brief; this workflow has no commit
  adapter and never enters MRF decision or confirmation state.
- Closed-tab delivery reuses the existing short-lived device notification and
  global LiveKit surface. English is available; Hindi and Odia remain visibly
  disabled until approved model assets are installed and tested.
- The focused backend suite passes 16/16, including summary priority,
  leave-day suppression, preference validation, deterministic IST scheduling,
  catalogue state and read-only dialogue completion.

