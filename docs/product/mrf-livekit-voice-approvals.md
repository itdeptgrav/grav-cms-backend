# MRF LiveKit voice approvals

## Outcome

When an MRF reaches its assigned Primary Manager/TL, GRAV may ring that
approver inside the signed-in CMS. The call is a private LiveKit WebRTC room;
it does not dial a telephone number and does not use Plivo or another PSTN
carrier.

After the approver answers, a GRAV voice agent:

1. says hello, identifies itself, and waits for the approver to acknowledge
   before giving request information;
2. identifies the MRF and requester;
3. reads the still-pending lines and quantities in the approver's selected
   language (English, Hindi or Odia);
4. asks whether to approve all pending lines, reject them, hear the request
   again, open it in Requests, or decide later;
5. repeats the proposed decision and asks for explicit confirmation; and
6. records the confirmed result through the existing MRF approval service.

## Natural call behaviour

- The agent never launches directly into request details. It says hello and
  asks whether the approver can hear it. Only a response advances the call.
- After seven seconds of silence it says hello once more. A second unanswered
  wait ends as `NO_ANSWER` and leaves the MRF pending in Requests.
- LiveKit barge-in remains enabled while the agent is speaking. When the
  approver interrupts, speech stops, the agent gives a brief warm
  acknowledgement, answers the interruption, and returns to the unfinished
  approval question rather than snapping into a new prompt, restarting the
  whole call or silently skipping information.
- Decisions are ordinary speech, not command words. Sentences such as “this
  looks fine, please proceed”, “send this back”, and “I need more time” map to
  approve, reject and later respectively. The agent then states what it
  understood and waits for a separate natural confirmation such as “yes,
  that's right, go ahead”; the original decision sentence is never also its
  own confirmation.
- When deterministic vocabulary cannot settle an otherwise natural sentence,
  Qwen may propose a non-authoritative candidate intent. The agent asks a
  direct clarification such as whether the caller means to reject; only the
  caller's separate yes/no answer advances the state machine. Phrases such as
  “I think I would pass for now” therefore do not become silent rejection
  commands.
- A bounded Qwen semantic router classifies natural speech into one allowlisted
  dialogue act. It receives only the request context, selected language,
  dialogue phase and proposed-but-uncommitted intent. It cannot see
  credentials, generate the spoken wording or invoke an MRF mutation.
- The deterministic controller rotates equivalent, reviewed phrasings for each
  dialogue act. Because the complete response bank is bounded, likely replies
  can be rendered during the greeting and served from a persistent audio cache
  rather than waiting for a fresh language-model plus speech-model chain.
- When Qwen is unavailable, misses its 1.5-second deadline or produces anything
  outside its one-code contract, a cached controller reply explains the scope
  and returns to the current approval question. The call never guesses.

## Product boundary

- LiveKit transports browser audio only and the call requires internet. An
  already registered browser may receive a short-lived Web Push while every
  CMS tab is closed. Answering the notification opens the exact pending call;
  the authenticated CMS page then asks for microphone access and joins
  LiveKit. Reaching a mobile or landline number would require SIP/PSTN and is
  outside this feature.
- Web Push is a closed-tab notification, not an operating-system VoIP call.
  Delivery after the browser has been force-quit, a guaranteed looping
  ringtone, lock-screen call controls and Bluetooth/wearable answer require a
  native shell: PushKit plus CallKit on iOS, and high-priority FCM plus Android
  Telecom/incoming-call UI on Android.
- A call is offered only to the employee stored on the MRF as approver. The
  LiveKit join token is minted for that authenticated employee and one room.
- Voice is an input method, not a new authority. The existing tenant,
  assigned-approver, employment, idempotency and item-state checks remain
  authoritative at commit time.
- `Approve` means approve every line still waiting, in full. `Reject` requires
  a captured reason. Reduced quantities, partial approvals and mixed decisions
  open the existing Requests approval screen.
- `Later`, no answer, timeout, transcription uncertainty and model failure do
  not change the MRF.
- The agent must read the decision back and receive a separate confirmation.
  A single ambiguous utterance never commits a decision.
- The stored audit contains the bounded transcript, interpreted intent,
  confirmation and resulting MRF action. Raw room audio is not recorded for
  the MVP.

## Language and model boundary

- English TTS: Kokoro-82M.
- Hindi TTS: Resemble AI Chatterbox Multilingual Hindi V3 with the approved
  native-Hindi female reference voice. It returns a complete WAV and is kept
  warm behind its own pod-local gateway.
- Odia TTS: AI4Bharat Indic Parler-TTS with Debjani, streamed incrementally.
  Voice descriptions require warm, conversational office delivery rather than
  formal recitation.
- STT: the existing private GRAV Speech service.
- Intent interpretation is deterministic for the approval vocabulary. A
  self-hosted 4-bit Qwen3 4B Instruct model acts only as a compact semantic
  router for less literal speech and interruption recovery. It emits one
  allowlisted code, not prose, and cannot commit a decision, confirm for the
  approver or invent a rejection reason.
- Models run behind a private GRAV TTS endpoint. Model weights and provider
  credentials never reach the browser.

## Availability and fallback

When the browser is open, the global CMS call surface polls for assigned
pending calls. When it is closed, a newly queued call sends a 120-second,
high-priority data push to every registered device of the approver. The worker
shows a persistent `Answer` / `Later` notification tagged by voice-session ID;
`Answer` opens `/requests` with that exact session selected and `Later` only
dismisses the ring. Neither service worker nor notification action can approve,
reject or defer an MRF. Once the authenticated page sees the session it closes
the stale system notification and presents the normal call overlay.

If the approver is offline, push is disabled, the browser has been force-quit,
or the short delivery window is missed, the request remains in the ordinary
Requests queue. IT can inspect delivery attempts and model health, but cannot
approve an MRF on the approver's behalf.

IT also has a Voice Lab under `/developer/voice-lab`. It creates an explicitly
synthetic, one-hour session for the signed-in tester and runs the real LiveKit,
STT, dialogue and TTS path. The screen shows the bounded transcript, interpreted
intent and confidence. Finishing the conversation changes only that test
session; the route never invokes an MRF approve/reject command and its spoken
closing explicitly says that no real material request was changed.

## Release gates

- authenticated global incoming-call UI for this call type;
- global device registration plus a closed-tab Web Push acceptance test on the
  production HTTPS origin;
- LiveKit agent worker deployed and named explicitly;
- local TTS health for all three languages;
- GRAV Speech readiness;
- approved Hindi Chatterbox and Odia Indic Parler voices and licence notices;
- concurrency tests proving that browser and voice decisions cannot both win;
- end-to-end tests for approve, reject with reason, defer, no answer,
  uncertain transcript, stale request and already-decided lines.
