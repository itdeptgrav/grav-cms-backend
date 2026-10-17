# GRAV Voice Automation platform

## Outcome

GRAV Voice becomes one reusable, company-wide interaction channel rather than
MRF-specific call code. Authorised workflows may ring a person inside the CMS,
hold a natural English/Hindi/Odia conversation, and either read information or
offer a small set of workflow-owned actions.

The first expansion supports:

1. a read-only personal morning brief;
2. personal and work-queue reminders with snooze;
3. manager leave decisions;
4. HR final leave decisions; and
5. the existing MRF approval flow as the first workflow adapter.

Regularisation, overtime, department and accounting approvals may join only
after their own authority and commit adapters are reviewed. A workflow is not
enabled merely because its notification type already exists.

## Three interaction modes

### Decision call

Used for MRF and approval queues. The agent describes one record, accepts
natural discussion, proposes a bounded action, reads the effect back, and
requires a separate confirmation before the domain service may commit it.

Examples include:

- manager approval or rejection of a leave request;
- HR final approval or rejection after the required manager stage; and
- MRF approval, rejection or defer.

The model never receives generic database-write access. Each workflow adapter
exposes only the actions already available to the authenticated recipient.

### Briefing

Used for a daily morning brief. It is read-only and assembled from the existing
`services/home/employeeHome.service.js` result for that employee, preserving
its bounded parallel sections and explicit `unavailable` status. A brief can
cover attendance, the person's own leave, pending requests, planner items,
interviews, meetings, holidays, people away and CoWork tasks.

The listener may say ordinary things such as “next”, “repeat the meetings”,
“skip this”, “open my tasks”, “what needs my attention first?”, “remind me at
three”, or “stop”. Creating a reminder is a separate confirmed action. Missing
or unavailable data is stated honestly; it is never converted to “nothing is
pending”.

### Reminder or nudge

Used for a due item or unresolved queue. A reminder says why it rang and can
open the exact item, snooze to a permitted time, dismiss this occurrence, or
disable future voice reminders of that type. It does not silently become a
decision call.

Existing hourly pending-work counters remain the source of truth for whether a
queue is still outstanding. Voice escalation is a separate opt-in policy; an
hourly push sweep must not create an hourly call.

## User experience

### Before a call

Every user has voice preferences:

- enabled workflows;
- preferred language and voice;
- working timezone;
- quiet hours and working days;
- morning-brief time;
- allowed delivery surfaces;
- maximum calls per day;
- whether a push may escalate to a call and after how long; and
- temporary pause, per-workflow mute and “do not call while I am on leave”.

Defaults are conservative. Morning brief, repeat reminders and escalation calls
are opt-in. A new approval workflow begins with ordinary notification plus the
Requests queue until the user enables its call.

### During a call

The agent starts with a greeting and waits for acknowledgement. It supports
pause, repeat, back, next, skip, explanation, open-in-app and end-call across
all workflows. The dialogue may vary its wording naturally, but the facts,
available actions and confirmation state come from the deterministic workflow
session.

Interruptions stop speech after a short natural boundary where possible. The
agent acknowledges the interruption once, answers it if it is within the
bounded context, and returns to the unfinished question. Silence, background
noise and uncertain transcription do not advance the workflow.

### After a call

The exact application remains the system of record. The user sees a short call
outcome with a deep link to the affected record or briefing section. A decision
call records the proposed intent, separate confirmation, adapter result and
authority evidence. Raw audio is not recorded by default.

## Morning brief policy

The brief is a prioritised summary, not a spoken dump of the home screen.
Suggested order:

1. attendance or an immediate punch problem;
2. meetings or interviews starting soon;
3. overdue and due-today work;
4. approval queues owned by the listener;
5. the listener's leave or planner items; and
6. optional holidays and people moments.

The initial default suggestion is 09:15 in the employee's timezone on working
days, but the user must accept or change it. There is at most one automatic
morning brief per employee per local date. If it was already completed on
another device, another scheduler instance must not ring again.

## Leave approval boundary

Leave is not one generic approval:

- manager decisions use the record-assignment checks behind
  `/api/employee/leave-applications/manager/:id/*`;
- HR final decisions use the `LEAVE_DECIDE_HR` boundary behind
  `/api/hr/leaves/:id/*`; and
- primary, secondary and HR stages remain distinct.

The voice agent must reload the record and prove that the current recipient is
the actor for the current stage immediately before commit. It must not allow HR
to front-run a required primary-manager decision or let a manager perform the
HR transition.

Leave reasons may contain sensitive personal information. The default spoken
summary gives requester, dates, duration, leave type and current stage; it does
not speak the free-text reason until the authorised listener explicitly asks
for it. Lock-screen notifications contain no reason or medical detail.

## Delivery and priority

The CMS global call surface remains the first delivery client. Registered web
devices may receive a short-lived closed-tab Web Push that opens the exact
session. Web Push is not a guaranteed operating-system VoIP call after a force
quit. WhatsApp-like lock-screen behaviour requires the separately approved
iOS CallKit/PushKit and Android Telecom/high-priority FCM shell.

Calls have one of three priorities:

- `routine`: briefings and personal reminders; never override quiet hours;
- `action`: assigned approvals; may ring during configured work hours; and
- `urgent`: reserved for a future explicitly governed incident workflow.

No current business approval is automatically `urgent`.

## Fatigue and safety rules

- Group routine items into the morning brief where possible.
- Do not ring again merely because a scheduler polled again.
- One active session per workflow subject and recipient.
- Use stable occurrence keys so retries are idempotent.
- Enforce a user-level daily call cap and a per-workflow cooldown.
- A snoozed occurrence cannot be recreated by another scheduler process.
- If the user is busy, offline, outside policy or over the cap, fall back to the
  normal notification and application queue.
- “Stop calling me about this” disables that workflow for the user after a
  confirmation; it never changes the underlying business record.

## IT and user controls

The IT Voice Automation screen owns workflow enablement, runtime health,
scheduler health, delivery attempts, failure reasons, language availability,
limits and synthetic tests. IT cannot decide an employee's approval through
that screen.

The existing Voice Lab becomes a workflow simulator. It can select MRF, leave,
morning brief or reminder fixtures and uses the real LiveKit, STT, dialogue and
TTS path, but every fixture is structurally unable to call a production commit
adapter.

Users manage their own schedule, language, quiet hours, call types and devices
from notification/voice preferences. Company policy may cap frequency or
disable a workflow, but it cannot secretly opt a person into routine calls.

## Release measures

- fewer overdue approvals without an increase in duplicate decisions;
- morning briefs completed or intentionally skipped, not merely delivered;
- snoozes that fire once at the chosen time;
- no call outside quiet-hour policy;
- no action without current authority plus separate confirmation;
- no duplicate occurrence across server restarts or multiple schedulers;
- bounded false wake-ups from noise and bounded unknown-intent recovery; and
- per-workflow opt-out and daily-cap rates monitored as fatigue signals.

