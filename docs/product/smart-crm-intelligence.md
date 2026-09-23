# GRAV Smart CRM Intelligence

**Status:** Approved direction, implementation starts with S1.

## 1. Product outcome

GRAV Sales should progress from a system that records work to a system that
helps a salesperson decide what to do next.

The primary product is a **Sales Today** feed. It ranks a small number of real
actions across Prospects, Leads, Accounts and Sales Journeys and explains:

- what needs attention;
- why it needs attention now;
- which source facts support that conclusion;
- what action is recommended;
- who should own it and when it should happen;
- whether GRAV is suggesting, preparing or performing the action.

The first release is not a general-purpose chatbot and not an autonomous sales
agent. It is an explainable recommendation system with human review.

## 2. Existing assets

The CRM already has the records needed for a useful rules-first system:

- Prospect capture and HOD review;
- Lead qualification and readiness checks;
- Account hierarchy and contacts;
- next actions and overdue tasks;
- Sales Journey stages, holds, risk, outcomes and target dates;
- quotation, sample, PO, payment and production gates;
- phone call events, recordings and transcripts;
- WhatsApp conversations;
- salesperson-scoped Gmail matching;
- CoWork meeting recordings, summaries and verbatim/translated transcripts.

These remain authoritative. Intelligence references them; it does not replace
or copy their business records.

## 3. Calls and meetings are first-class evidence

### 3.1 Phone calls

`CallEvent` is the recording/call-log source. It may contain the number,
direction, answered/rejected state, salesperson phone, recording, transcript
and summaries. Existing identity matching can associate a call with a CRM
record, but a fuzzy name match is never sufficient for an automatic business
update.

### 3.2 CoWork meetings

CoWork currently provides three related records:

- `cowork_scheduled_meets/{meetId}` — title, organiser, internal participants,
  agenda, dates and status;
- `meeting_verbatim_transcripts/{meetId}` — speaker-attributed verbatim and/or
  translated transcript;
- `meeting_summaries/{meetId}` — summary, conversation flow, dialogue,
  deadlines, action items and assigned tasks.

A CoWork meeting presently has no authoritative CRM customer or opportunity
link. Title matching, participant-name matching and model inference must not be
used to silently create one.

The first smart-CRM slice therefore introduces an explicit, audited meeting
link to exactly one owning CRM context: either a pre-Account Lead or an Account.
A Sales Journey may be attached as a tag under an Account, matching the current
`CRMActivity` ownership rule.

## 4. Intelligence outputs

The system may extract the following as **proposals** from a transcript:

- customer requirement or requirement change;
- garment category, style or sample discussed;
- quantity and units;
- target price, quoted price or budget indication;
- requested sample, quote, PO, delivery or follow-up date;
- named stakeholders and their decision roles;
- objections, competitor/current-supplier mentions and blockers;
- customer sentiment or engagement direction;
- explicit commitments made by either side;
- agreed next action, owner and date;
- suggested CRM next action and the reasons for it.

Each extracted proposal must retain evidence: source conversation, speaker,
timestamp range where available, a short excerpt, confidence and the analysis
version that produced it.

## 5. Truth and action levels

Every capability must declare one of three levels:

1. **Observe** — read and summarize; changes no business record.
2. **Propose** — prepare a field update, task or message for a person to review.
3. **Act** — perform a pre-authorized, reversible action and record what it did.

S1 and S2 stop at **Propose**. They may never automatically:

- change a Lead qualification state or Journey stage;
- mark a Journey parked, lost, won or closed;
- change price, cost, margin, quantity, PO or payment facts;
- state that a sample/customer approval happened;
- send an email or WhatsApp message;
- create or amend an order;
- override a role or approval gate.

The safe initial actions are: prepare a next-action task, prepare a follow-up
message, propose a contact/requirement correction, or dismiss/snooze the
recommendation.

## 6. Recommendation contract

Every recommendation shown to a user must include:

- stable recommendation ID;
- subject Lead/Account and optional Journey;
- action type and plain-language label;
- reason codes and a readable `whyNow` sentence;
- evidence references;
- confidence and rule/model provenance;
- suggested owner and due date where relevant;
- created, last-computed and expiry timestamps;
- state: `open`, `accepted`, `dismissed`, `snoozed`, `expired` or `superseded`;
- resolution actor, time and optional feedback reason;
- resulting Activity ID if accepted into CRM work.

A recommendation is not a CRM fact. Acceptance creates or updates the real
record through its existing authorized service.

## 7. Sales Today ordering

The first ranking is deterministic and explainable. It uses existing facts:

1. a decision is required;
2. blocked or externally overdue work;
3. an explicit customer commitment is due;
4. an overdue next action;
5. a recent inbound response without a salesperson response;
6. a quote/sample/approval deadline approaching;
7. missing decision maker or contact route;
8. no next action;
9. stale work with no date;
10. ordinary upcoming work.

Manual priority is a tiebreaker, not the sole intelligence signal. Every rank
must be reproducible from stored reason codes.

## 8. Transcript processing rules

- Preserve the original transcript. Intelligence writes a separate analysis.
- Hash the transcript content. Re-running an unchanged transcript is
  idempotent; a changed transcript creates a new analysis version and
  supersedes its previous open proposals.
- Use verbatim meeting transcripts where available. A translated transcript is
  supporting context and must remain labelled as translated.
- Never invent a number, date, person, approval or commitment.
- Mark uncertain transcription spans and reduce confidence rather than filling
  gaps.
- Do not send full transcripts to the browser in a list response.
- Do not copy audio into CRM storage. Retain an authorized source reference.
- A deleted or inaccessible transcript leaves its accepted CRM history intact,
  but its unaccepted recommendations become unavailable with an honest reason.

## 9. Privacy and access

- A person may analyze a call only if Sales access allows the linked CRM
  context.
- A CoWork meeting may be linked only by its organiser/participant or an
  expressly authorized manager, and the target CRM record must be visible to
  that same actor.
- Meeting recordings and transcripts keep CoWork authorization. Sales receives
  derived evidence and authorized deep links, not a second public copy.
- Do-not-contact and restricted-contact rules outrank any outreach suggestion.
- Model prompts and logs must not contain unrelated mailbox or meeting data.

## 10. Success measures

The first release is measured by behaviour, not model output volume:

- percentage of active work with a current next action;
- overdue next actions and median days overdue;
- time from inbound customer contact to salesperson response;
- percentage of recorded calls/linked meetings successfully analyzed;
- recommendation acceptance, dismissal and correction rates by reason;
- accepted recommendations that led to stage movement within a defined window;
- false-link and incorrect-extraction reports;
- percentage of recommendations with usable evidence.

Win probability and revenue forecasting are deliberately later. They need
enough clean outcome history and forecast-versus-actual snapshots to be trusted.

## 11. Delivery sequence

1. **S1 — Conversation evidence foundation:** source identity, meeting-to-CRM
   linking, versioned analysis records and permissions.
2. **S2 — Call and meeting extraction:** structured proposals with transcript
   evidence and idempotent processing.
3. **S3 — Sales Today:** explainable ranked feed and recommendation lifecycle.
4. **S4 — Review and apply:** accept proposed tasks/field corrections through
   existing authorized services.
5. **S5 — Playbooks:** repeatable follow-up sequences with reply/transition
   stop conditions.
6. **S6 — Account growth:** renewal, reorder, dormancy and cross-sell signals.
7. **S7 — Predictive calibration:** probability and forecasting only after
   coverage and outcome thresholds are met.

