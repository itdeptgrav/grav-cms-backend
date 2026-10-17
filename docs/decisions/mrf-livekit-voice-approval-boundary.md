# Decision: MRF voice approval uses authenticated WebRTC, not telephony

Date: 13 October 2026

## Decision

MRF approval calls use a private LiveKit room containing the assigned
approver's authenticated CMS browser and a GRAV voice agent. They do not create
a SIP participant and therefore do not use the existing Plivo trunk.

The IT application owns configuration, health and delivery diagnostics. The
Requests application continues to own the request, approver assignment and
decision. The voice agent submits a confirmed command to the same server-side
MRF decision boundary used by the Requests UI.

## Why

LiveKit alone cannot call a PSTN phone number; an outbound phone call requires
a SIP trunk or LiveKit phone-number service. An in-CMS WebRTC call satisfies
the explicit no-Plivo requirement while retaining a strongly authenticated
employee session.

Speech recognition is not identity. The employee's CMS session and room token
establish identity; speech only selects an action available to that identity.
Natural sentences may select that action, but no wording in the selection turn
also confirms it. GRAV repeats the interpreted effect and requires a separate
confirmation turn immediately before commit.

TTS is not the dialogue brain. GRAV Speech turns audio into text, a bounded
Qwen semantic router selects one allowlisted dialogue act, the deterministic
state machine owns the wording and interprets approval controls, and
Kokoro (English), Chatterbox Hindi V3 (Hindi) and Indic Parler (Odia) turn that
controller text back into audio. Qwen never generates
speech prose. It may label an otherwise unknown utterance as a candidate
approve, reject or defer intent, but that label has no authority. The caller
must answer a separate clarification question before the candidate re-enters
the deterministic workflow. Qwen cannot call a decision endpoint, confirm for
the caller or commit a result.

## State machine

`QUEUED -> RINGING -> CONNECTED -> AWAITING_INTENT -> AWAITING_CONFIRMATION`

Terminal states are `APPROVED`, `REJECTED`, `DEFERRED`, `NO_ANSWER`,
`CANCELLED`, `STALE` and `FAILED`. Only `APPROVED` and `REJECTED` invoke an MRF
transition. Every other terminal state leaves the MRF unchanged.

## Commit contract

Immediately before commit the server reloads the MRF in its tenant, resolves
the current actor, proves the actor is the assigned approver, recomputes the
still-pending lines and applies the existing item-decision validation. A
session-specific idempotency key makes repeated agent callbacks the same
action. A stale or already-decided request is reported to the caller rather
than overwritten.

## Consequences

- Approvers need internet and must register each browser/device once. A
  registered browser can alert them with Web Push while all CMS tabs are
  closed; answering resumes the authenticated CMS and only then joins LiveKit.
- Web Push does not promise WhatsApp-equivalent wake-up after a force-quit or
  native lock-screen call controls. Those require a separately shipped iOS
  CallKit/PushKit and Android Telecom/FCM shell; the browser implementation does
  not pretend to provide that guarantee.
- The feature is free of PSTN per-minute charges but LiveKit hosting and GPU
  inference are still infrastructure costs.
- Phone delivery can be added later only as a separate, explicitly authorised
  SIP/PSTN channel.
- The initial voice surface intentionally excludes partial quantities and
  mixed per-line decisions.
- The interactive path has a 1.5-second semantic-router deadline. Misses fail
  safely to a cached scope prompt; they do not extend caller silence or guess a
  decision. High-probability controller phrases are rendered ahead of need and
  kept in a persistent WAV cache on the pod.
