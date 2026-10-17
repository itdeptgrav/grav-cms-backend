# MRF LiveKit voice approvals — implementation task

## Scope

Implement the product and decision contracts in:

- `docs/product/mrf-livekit-voice-approvals.md`
- `docs/decisions/mrf-livekit-voice-approval-boundary.md`

## Sequential slices

1. **VA-01 — shared decision boundary.** Extract the existing approve-all and
   reject-all orchestration from the HTTP route into a service. Preserve
   tenant, approver, item, idempotency, history, notification and reservation
   behaviour. Pin route parity with tests before adding voice.
2. **VA-02 — delivery record.** Add a company-scoped voice-approval session
   with the documented state machine, bounded transcript events and a unique
   active-session constraint per MRF/approver.
3. **VA-03 — queue and authenticated answer.** Queue after successful MRF
   submission, expose assigned-approver-only incoming/accept/defer endpoints,
   mint a one-room LiveKit token and dispatch the named agent only on answer.
4. **VA-04 — self-hosted speech worker.** Add a separately runnable LiveKit
   Agents worker using GRAV Speech STT, Kokoro for English, Chatterbox Hindi V3
   for Hindi and Indic Parler for Odia. Do not download model weights during
   application startup.
5. **VA-05 — confirmed command callback.** Accept only server-signed worker
   callbacks. Re-authorise the approver and call VA-01 after a two-turn
   intent/confirmation exchange.
6. **VA-06 — global CMS call surface.** Extend the existing global call notch
   to show MRF identity, answer/defer, transcript/confirmation and a link to
   `/mrf?tab=approvals`. This is a distinct WebRTC call type and must not touch
   the Voice app's SIP call records.
7. **VA-07 — IT operations surface.** Show configuration and worker/model/STT
   health, queued/ringing/failed attempts and retry/cancel controls. IT has no
   decision control.
8. **VA-08 — end-to-end acceptance.** Verify English, Hindi and Odia; approve,
   reject and later; offline/no-answer; double-submit races; and fallback to
   the normal Requests queue.
9. **VA-09 — closed-tab delivery.** Register push devices from every
   authenticated CMS surface, send a short-lived call invitation only when a
   new real session is queued, and deep-link `Answer` to the exact session.
   Notification actions remain non-authoritative. A native CallKit/Telecom
   shell is a later product slice, not a hidden promise of this web slice.

## Configuration

- `MRF_VOICE_APPROVAL_ENABLED=false` by default
- `MRF_VOICE_AGENT_NAME`
- `GRAV_TTS_URL` and a server-to-server secret
- existing GRAV Voice LiveKit URL/key/secret, without any SIP trunk
- existing GRAV Speech URL/secret

## Current external gates

- The frontend repository must receive VA-06 and VA-07.
- The existing Capacitor shell has no native push credentials, push plugin,
  iOS VoIP entitlement/CallKit provider or Android incoming-call service. A
  true force-quit/lock-screen call therefore requires the Firebase Android
  config, APNs/Apple signing entitlements and a separately accepted native
  VA-10 slice; none of those secrets may be fabricated or committed.
- The target inference host needs sufficient disk for the Python environments,
  Kokoro, Chatterbox Hindi V3, Indic Parler and their approved reference assets.
- No release claim is allowed until the three-language worker and concurrency
  tests pass end to end.

## Evidence — 13 October 2026

- Backend intent, readiness and no-answer tests pass: 8/8. This includes deterministic
  English, romanized Hindi and romanized Odia phrases.
- The RunPod is an NVIDIA A40 host. Model assets are kept on `/workspace`; the
  disposable Python environment is recreated under `/tmp` by
  `runpod-start.sh`.
- Existing `/workspace/grav-speech` is the only STT implementation. Its
  `bodhan-ai/indic-transcribe-flex` model transcribed the English approval test
  prompt successfully. Whisper is not part of this workflow.
- Kokoro generated a valid 24 kHz English WAV on the pod.
- The managed pod stack generated the English prompt with Kokoro and then the
  existing GRAV Speech repository transcribed it as: `a material request was
  received say approve reject or i will approve later`. The stack used about
  3.3 GB of the A40's 46 GB VRAM for that warmed test.
- LiveKit registered the named `grav-mrf-approval` worker successfully. Its
  health listener uses pod-local port 8091 because the existing speech worker
  already owns LiveKit's default 8081 port; only one idle job process is kept.
- AI4Bharat IndicF5 source was installed initially while its gated weights were
  unavailable. Approved access was later supplied on 14 October; see the
  multilingual acceptance evidence below.
- A mount-order defect was fixed: worker-secret routes now sit above the legacy
  `/api/cms` employee-auth catch-all. A valid worker secret reaches the local
  callback (HTTP 409 for a deliberately absent session); a wrong secret is
  refused.
- `api.grav.in` currently reaches another/stale backend instance and rejects
  the new worker secret. A localhost end-to-end test therefore needs explicit
  approval for the narrow two-route development relay, or the updated backend
  must be deployed at `api.grav.in`.
- The narrow three-route local relay was verified: valid worker callback 409
  for an absent test session, unrelated CMS path 404, and wrong secret 404. No tunnel was
  opened because third-party relay approval is still required.
- Natural dialogue is now a separate pod-private layer: hello/acknowledgement,
  seven-second silence retry, `NO_ANSWER`, barge-in recovery and bounded Qwen3
  4B replies. Qwen returns text only; the deterministic backend remains the
  sole interpreter of approve/reject/later and the browser remains the commit
  authority.
- The official `Qwen/Qwen3-4B-Instruct-2507` checkpoint is cached on persistent
  RunPod storage and reports `loaded4bit: true`. Its CUDA allocator settled at
  2,722 MiB allocated / 2,774 MiB reserved; `nvidia-smi` attributed 7,498 MiB
  to that process and 3,080 MiB to the speech process. This fits the current
  A40 but still needs a peak test before claiming reliable operation on a
  12 GB production GPU. Warm synthetic turns took 0.54–2.40 seconds.
- Final dialogue probes correctly answered `Ramesh submitted this request.`
  without treating Ramesh as the caller, and reduced the unrelated statement
  `I am having lunch right now` to the neutral reply `Understood.` The
  deterministic controller then owns resuming the pending approval question.
- The collection-limit gate was cleared by verifying and removing the empty,
  obsolete `workspacemessages` collection. `mrfvoiceapprovalsessions` now has
  its intended seven-day TTL index without Mongoose's duplicate `expiresAt`
  index declaration.
- Local development is enabled with `MRF_VOICE_LANGUAGES=en,hi,or`. Language
  selectors remain driven by backend readiness rather than a frontend claim.
- A narrow authenticated relay and encrypted reverse SSH tunnel to the user's
  RunPod carried only the three worker callback routes. No public third-party
  tunnel was opened.
- The final English acceptance call used request
  `VOICE-TEST-20261013120943`, raised by a different employee and assigned to
  `CEO001`. LiveKit connected, Kokoro spoke, GRAV Speech captured a natural
  question, the deterministic approve/confirm exchange reached
  `DECISION_READY`, and the authenticated browser committed the real MRF
  transition. Both the voice session and pending line reached `APPROVED` at
  12:16 IST. Exact synthetic acceptance records were removed after evidence
  was captured so the test line cannot be issued or purchased.
- Speech startup now prewarms GRAV Speech and Kokoro before the LiveKit worker
  registers. This removes the observed first-call timeout after a pod restart.
- Deterministic intent and confirmation now accept bounded natural sentences,
  while preserving the mandatory separate confirmation turn. Interruption
  recovery adds a short acknowledgement before the answer/resumed prompt so
  barge-in does not sound abrupt.
- The IT Voice Lab is available at `/developer/voice-lab`. It starts an
  isolated synthetic LiveKit session, exposes live STT/intent evidence, supports
  mute/end/retry, and completes without loading or mutating an MRF. The rendered
  route was verified locally; the in-app browser denied microphone permission,
  so an interactive audio run must be started from the user's normal CMS browser.
- The focused backend suite now passes 13/13, including synthetic-session
  isolation, exclusion from the normal incoming-call poll, and natural
  multi-word decision/confirmation sentences. It also proves that only a
  user-confirmed Qwen candidate may re-enter the deterministic workflow. The new
  frontend page and IT navigation both parse successfully with the repository's
  installed JSX compiler.
- Qwen semantic clarification was verified live on the deployed A40. “I think
  I would pass for now” and the imperfect STT output “Are rejected” both
  returned `REJECT` at 0.95 confidence and asked different confirmation
  questions; “I need more time” returned `DEFER` at 0.95 and asked whether to
  decide later. No candidate is a stored decision until the caller confirms.
- Spoken English workflow prompts now rotate equivalent wording within the
  call. The gateway receives the previous agent sentence, rejects close
  repetition and non-question clarification drafts, retries Qwen, and uses a
  bounded varied question only if all model drafts violate that contract.
- The pod launcher remains fail-closed but now allows 180 seconds for cold
  GRAV Speech/Kokoro prewarm. This fixes the observed restart loop where a
  healthy cold load completed just beyond the former 90-second watchdog. The
  deployed speech gateway, 4-bit Qwen gateway and LiveKit worker all passed
  their health checks after restart.
- A silent Voice Lab call at 19:37 IST was traced to the localhost development
  link, not LiveKit or TTS: the worker received both dispatches but timed out
  reading `/worker/:id/context` because an orphaned remote `sshd` listener held
  port 5061 after the local tunnel had gone away. The stale listener was
  removed, the narrow relay was restarted, and the reverse SSH tunnel was
  reopened with `ExitOnForwardFailure`, a 30-second keepalive and a three-miss
  limit. A RunPod-to-local probe then returned the relay's deliberate 404 in
  0.34 seconds. A fresh synthetic dispatch fetched context successfully and
  invoked Kokoro TTS without the former `httpx.ReadTimeout`; the verification
  session was cancelled afterward and no real MRF was changed. A direct
  post-repair greeting probe returned HTTP 200 and a 250,844-byte mono 24 kHz,
  16-bit PCM WAV, confirming synthesis itself is producing playable audio.
- Approval calls now request an explicit mono speech capture profile in both
  the production overlay and IT Voice Lab: browser echo cancellation, noise
  suppression, automatic gain control and Chromium voice isolation are on;
  LiveKit uses its speech bitrate preset and discontinuous transmission. The
  deployed Silero gate now requires 250 ms of speech at a 0.65 activation
  threshold (previously 50 ms at 0.5), with 700 ms end-of-turn silence. This
  rejects most fans, keyboard taps and brief background bursts without clipping
  ordinary sentences. The frontend capture contract passes 2/2 tests, the
  backend voice suite remains 13/13, and the restarted worker registered with
  LiveKit while the protected callback relay remained healthy.
- The full backend suite currently reports 2392 passes and 6 unrelated
  pre-existing failures in `openItems` and `flowTrackingRoutes`; the targeted
  MRF voice suite is green.
- VA-09 now uses the existing device registry and FCM service worker. A newly
  queued real MRF voice session sends one high-priority push with a 120-second
  TTL and a per-session tag to every enabled device belonging to its assigned
  approver. The notification remains visible with `Answer` and `Later`;
  `Answer` opens the exact session in Requests, while `Later` only dismisses
  the notification. The authenticated overlay consumes and removes the deep
  link, closes the corresponding system notification, and still requires the
  page to obtain microphone access before LiveKit joins. Push registration is
  mounted once at the global authenticated shell instead of only inside HR.
  Focused backend tests pass 14/14 and the new push/deep-link frontend tests
  pass 3/3 (5/5 together with the audio-capture contract).
- On 14 October the unavailable A40 pod was replaced by the user's selected
  RTX PRO 4000 Blackwell pod (24 GB VRAM). The network-volume migration kept
  the GRAV Speech models, application checkout and private configuration, but
  flattened Hugging Face snapshot symlinks into zero-byte files. The intact
  Qwen3-4B and Kokoro blobs were used to reconstruct both snapshots; the
  zero-byte trees remain as recoverable `-zero-migrated` backups.
- RunPod startup now builds the vendored IndicF5 package from disposable local
  storage because package metadata renames are unsupported by the object-backed
  `/workspace` filesystem. After repair, GRAV Speech and Kokoro reported
  loaded, Qwen reported ready in 4-bit, the narrow callback relay returned its
  deliberate 404, and `grav-mrf-approval` registered with LiveKit. The active
  stack used about 6 GB of the pod's 24 GB VRAM at the readiness check.
- Approved `ai4bharat/IndicF5` weights were downloaded into the persistent
  Hugging Face cache on 14 October without storing the access token in the
  repository or runtime environment. IndicF5's Transformers constraint is
  incompatible with the newer Qwen runtime, so the launcher creates an
  isolated speech environment and exposes it only through pod-local port 8892;
  the existing gateway on port 8890 proxies Hindi/Odia synthesis to it.
  `torchcodec` was added for reference-audio decoding. The production-shaped
  `/v1/audio/speech` path returned valid RIFF PCM for Hindi (221,756 bytes) and
  Odia (199,724 bytes), both mono, 24 kHz and 16-bit. GRAV Speech, Kokoro,
  IndicF5, 4-bit Qwen and the named LiveKit worker all reported ready after the
  split-runtime restart.
- Hindi and Odia speech now use a native-script preparation boundary before
  IndicF5. Dynamic English CMS summaries are rewritten as everyday office
  Hindi/Hinglish or conversational Odia, while familiar words such as call,
  approval, reject, confirm, pending, request and items are retained
  phonetically in Devanagari/Odia script rather than replaced with obscure
  textbook vocabulary. The gateway rejects localized output that still
  contains Latin prose. Production-path round trips recovered the new Hindi
  greeting as `Hello main Grav se ek material request ke approval ke liye call
  kar rahi hoon...` and the Odia greeting as `Hello mu graphru ek material
  requestor approval pain call karuchi...`, confirming that the intended
  conversational wording—not the earlier formal wording—reached synthesis.
- Odia no longer inherits the official IndicF5 demo's Punjabi conditioning
  voice. Its persistent reference is a 6.295-second female extempore sample
  from Khordha, Odisha, paired with the dataset's exact native transcript.
  Source: AI4Bharat `IndicContextEval`, Odia row/file
  `7318349394555788_0_32.wav`, speaker `7318349394478294`, released under
  CC-BY-4.0. The full temporary parquet shard was removed after extracting the
  reference. A production synthesis/STT round trip recovered: `Mun Gravaru eka
  material requestara approval pain call karuchi apana mo katha suni paruchanti
  ki`, and the named LiveKit worker remained ready.
- Hindi now also has a language-matched conditioning voice: a 6.208-second
  female extempore sample from Shahdara, Delhi, paired with its exact Hindi
  transcript. Source: AI4Bharat `IndicContextEval`, Hindi file
  `7318349394497156_0_0.wav`, speaker `7318349394477362`, CC-BY-4.0. The
  temporary source shard was removed after extraction. The production output
  round-tripped as `Hello main Grav se ek material request ke approval ke liye
  call kar rahi hoon...`. The speech gateway also rewrites uppercase `GRAV` to
  `Grav` for English and to its native-script pronunciation for Hindi/Odia;
  an English production probe recovered `this is grav`, not spelled letters.
- Reload recovery and microphone ownership were hardened on 14 October. Voice
  Lab now restores a still-ringing synthetic test after a page reload and ends
  a disconnected synthetic room rather than leaving an invisible active row.
  Expired active rows are marked `STALE` before morning-brief concurrency is
  evaluated, so an expired session cannot block the recipient indefinitely.
  A real stale CEO test lock was identified and cancelled; a subsequent
  morning brief visibly reached the global overlay, and the verification call
  was closed with no active CEO voice sessions remaining.
- Call audio is now exclusive. While a SIP/notch call, MRF/morning-brief call,
  or Voice Lab test is ringing, connecting or active, Hey GRAV and the Ctrl-K
  microphone are dormant. The wake preference is preserved and resumes only
  after every call owner releases audio. The focused frontend call/voice bridge
  suites pass 27/27 and the focused backend voice suites pass 14/14.
- Stale ringing is now reconciled during the ringing phase as well as after a
  LiveKit connection. Voice Lab polls the authoritative test session while its
  incoming card is visible and removes the card, backdrop and ring loop when
  the server session becomes terminal. A browser-held ringing card was tested
  against an externally cancelled synthetic session and disappeared on the
  next poll. When any workflow call takes audio ownership, the shell also
  closes a voice-opened Ctrl-K surface so its backdrop cannot obscure the call
  card. The focused frontend voice bridge suite passes 17/17.
- The Voice Lab MRF test card is rendered through a document-body portal. This
  keeps it fixed to the visible viewport instead of centring it inside the
  long, transformed IT page container. Verification triggered a synthetic MRF,
  returned to the top of the page, and confirmed the full card remained
  centred above its backdrop; the synthetic row was then cancelled. Focused
  call, audio and voice-bridge contracts pass 22/22.
- Voice Lab diagnostics now show both sides of the spoken exchange. For
  synthetic tests only, the authenticated worker records the exact text it
  passes to TTS as a `WORKFLOW` transcript entry; the IT UI labels this as
  `GRAV agent · TTS message`, alongside the approver's raw STT text, intent and
  confidence. Production calls do not persist agent wording through this
  diagnostic path. The narrow local relay allowlist includes only this new
  worker-secret callback in addition to the existing context, turn and
  no-answer callbacks.
- Voice Lab now mirrors the production MRF conversation until the deliberately
  isolated commit boundary: it greets the approver, names the requester and
  request, reads the pending-item summary, accepts natural speech, asks for a
  rejection reason where required, and performs a separate confirmation turn.
  IT can edit the synthetic requester, department, spoken item summary and a
  test-only Qwen wording instruction before ringing. The instruction can
  affect tone only; facts, JSON shape, confirmation and authority remain
  locked. Synthetic diagnostics separately retain the structured payload sent
  to Qwen, Qwen's reply/candidate/confidence/model response, and the final text
  handed to TTS. These model diagnostics and editable guidance remain excluded
  from production calls. The deployed RunPod worker, 4-bit Qwen gateway and
  speech gateway were restarted and reported ready after this change.
- Hindi delivery retains IndicF5's natural `1.0x` cadence; the earlier `1.14x`
  default was removed after clarifying that the requirement concerned response
  latency, not speaking rate. Product initialisms are normalized immediately
  before synthesis: MRF remains letter-by-letter but receives explicit pauses
  (`एम, आर, एफ` / `ଏମ୍, ଆର୍, ଏଫ୍`) even when Qwen has already transliterated it.
  Qwen's dialogue and localization prompts now declare the female assistant
  voice, and a deterministic final Hindi normalizer corrects common masculine
  first-person forms such as `कर रहा हूँ` to `कर रही हूँ`. Four focused
  dependency-free normalization tests pass.
- Greeting acknowledgements such as `Ji main aap ko sun pa raha hoon` are now
  handled deterministically instead of spending a Qwen turn on `समझ गई`.
  Negative audibility replies remain conversational. The worker prepares the
  exact introduction while the greeting is playing, and the private speech
  gateway keeps a bounded 64-entry in-memory WAV cache; the post-acknowledgement
  LiveKit TTS request therefore reuses the prepared audio instead of repeating
  Qwen localization and IndicF5 synthesis. On the deployed pod, the same Hindi
  introduction measured 10.727 seconds uncached and 0.003 seconds from cache;
  its audio duration is 5.14 seconds at the restored natural speaking rate.
  Six focused text/acknowledgement tests pass, and all three model services plus
  the LiveKit worker reported ready after deployment.
- Post-input silence in the Hindi Voice Lab was traced to the speech gateway,
  not the microphone or STT: GRAV Speech completed transcription and Qwen
  returned a localization, but a residual Latin token in a dynamic requester,
  identifier or item description caused the gateway to return HTTP 503. Native
  localization now retries up to three times with the residual tokens named in
  the repair instruction. If a catalogue/name token still survives, a bounded
  target-script letter pronunciation is used instead of failing the whole
  utterance. The LiveKit worker also has a short native-language audible
  recovery if synthesis itself fails, so the call cannot silently return to
  listening. Eight focused normalizer tests and Python compilation pass. After
  deploying and restarting the pod, the exact mixed Hindi/English regression
  introduction for `MRF-TEST-20261014083603` returned HTTP 200 from Qwen,
  IndicF5 and the public speech adapter and produced a valid 576 KB WAV; the
  named LiveKit worker remained registered.
- A subsequent fully silent call at 14:28 IST did not reach TTS at all. Three
  consecutive LiveKit jobs crashed while fetching their session context:
  RunPod loopback port 5061 was again owned by an orphaned `sshd` listener
  (PID 1366), and the callback timed out after 15 seconds. The exact stale
  listener was terminated and the narrow reverse SSH tunnel was reopened with
  `ExitOnForwardFailure`, a 30-second keepalive and a three-miss limit. An
  authenticated RunPod-to-CMS callback then returned the expected terminal
  session response in 0.709 seconds, and all three model services plus the
  named LiveKit worker remained ready. Calls dispatched during the outage had
  already crashed and must be replaced with a fresh Voice Lab test.
- The first post-greeting Hindi turn then exposed a separate latency defect.
  STT returned 200 and both Qwen localization and IndicF5 synthesis returned
  200, but the worker awaited one long pre-rendered introduction. In the traced
  call that work completed only after the browser participant disconnected,
  and LiveKit correctly rejected the late `say()` because the session was
  closing. Introductions are now short pipelined chunks: acknowledgement,
  request identity, item summary and decision prompt. Each next chunk prewarms
  while the current chunk plays, so the caller hears an immediate response
  instead of a full-synthesis gap. The deployed Hindi acknowledgement generated
  in 4.779 seconds cold during greeting and returns from cache in 0.003 seconds;
  all model services, the named worker and the private callback remained ready
  after restart.
- Voice Lab then exposed an STT spelling variant: spoken `जी` arrived as `Je`.
  Because the deterministic audibility recognizer accepted `ji` but not `je`,
  the GREETING turn was unnecessarily sent to Qwen, which returned the generic
  and contextually wrong `समझ गई। कैसे मदद कर सकती हूँ?` before the real MRF
  introduction. `je`, `jee` and closely bounded affirmative variants now skip
  Qwen as audibility acknowledgements; the Qwen GREETING contract also forbids
  an open-ended “how can I help?” response. Nine focused tests pass. The
  corrected worker is deployed, all model services are ready, and the callback
  tunnel was moved from a detached setup process to a persistent foreground
  session; its authenticated probe returns the expected 409 in 0.423 seconds.
- A further greeting probe arrived as the unrecognizable STT fragment `Mwnse`.
  Routing arbitrary first-turn noise through Qwen allowed another objective-free
  response asking the approver what they were talking about. GREETING is now
  entirely deterministic: any non-empty utterance establishes presence and
  proceeds directly to the known MRF, while only an explicit negative-audibility
  sentence repeats the hearing check. Qwen is never invoked in this phase and
  its fallback contract also forbids asking what the call is about. Ten focused
  tests pass. The deployed model services and named worker are ready; the
  separately persistent callback tunnel survived restart and returned the
  expected authenticated 409 in 0.571 seconds.
- The remaining unnatural inter-turn pause had two independent causes. The
  private speech adapter serialized STT, English TTS, Indic localization and
  IndicF5 synthesis through one global lock, so a background Hindi render
  could make an already-finished caller utterance wait silently. It now uses
  independent STT, Kokoro and cache locks; IndicF5 retains its own gateway
  serialization without blocking recognition. In addition, the worker now
  pre-renders every introduction chunk sequentially during the greeting and
  exposes per-chunk readiness events, allowing playback to begin as soon as
  each chunk is ready rather than starting its synthesis after the preceding
  chunk finishes. An overlapping production-pod probe returned STT in 2.019
  seconds while an uncached Hindi render continued for 18.626 seconds. All
  three model gateways and the named LiveKit worker reported ready after
  deployment, and the authenticated RunPod-to-CMS callback returned the
  expected 409 in 0.397 seconds.
- The production-like introduction still exposed a synthesis gap between its
  first two clips. The first prewarm slot was being spent on the standalone
  filler “now I will tell you the details”, after which the worker spoke the
  internal MRF identifier even though the approver does not need it. The
  Hindi, Odia and English introductions now start with the requester and the
  approval context, omit the spoken request identifier, use conversational
  office wording, and reserve pauses for meaningful sentence boundaries.
  IndicF5 output also trims its usual ~300 ms leading pad to a 60 ms breath
  boundary with short fades, without altering internal pauses or pitch.
- Serial IndicF5 rendering was the remaining compute bottleneck: the new first
  Hindi sentence is 4.03 seconds long but its following item sentence takes
  about nine seconds to synthesize. The deployed gateway now runs a bounded
  two-replica pool (3.5 GB total IndicF5 VRAM on this pod), while the worker
  submits all introduction chunks concurrently. In the exact production-like
  Hindi probe, sentence one was ready in 9.628 seconds and sentence two in
  13.167 seconds, so sentence two finished about 0.49 seconds before sentence
  one ended; both subsequent cache reads took under 0.003 seconds. Total GPU
  use remained 18.0/24.5 GB, all gateways and the named LiveKit worker were
  ready, and the authenticated callback returned the expected 409 in 0.400
  seconds.
- A 14 October latency audit separated dialogue from synthesis instead of
  attributing the whole pause to Qwen. The live 4-bit Qwen 3 4B dialogue
  endpoint took 4.47-4.66 seconds for a short Hindi turn. The exact uncached
  IndicF5 introduction clips still took 9.63-13.17 seconds, so synthesis is the
  largest component while the 4B dialogue model is a meaningful secondary
  component. A Qwen 3 1.7B non-thinking candidate was rejected: representative
  Hindi approval turns took about 14.3 seconds and failed the gateway's safe
  structured-output contract. The live model was not downgraded.
- Translation is now separated from dialogue. The worker sends selected-
  language, native-script caller text to Qwen, and the speech adapter no longer
  asks Qwen to translate. A reviewed static ONNX export of the MIT-licensed
  IndicTrans2 200M model runs on CPU without executing model-repository Python
  code and covers both `hin_Deva` and `ory_Orya`. The 14 October live pod probe
  translated a representative Hindi request sentence in 3.803 seconds. Native
  Hindi and Odia controller phrases bypass translation entirely.
- The approval hot path now pre-renders its bounded confirmation, rejection-
  reason, defer and commit responses while the introduction is playing. Exact
  cached IndicF5 speech returns in 0.003 seconds; the same Hindi confirmation
  took 3.654 seconds on its uncached render. Deterministic approval intents do
  not wait for Qwen. A genuinely ambiguous Hindi turn still took 4.170 seconds
  in Qwen on the live 4-bit 4B endpoint, so that remains the slow path rather
  than being hidden as a universal latency claim. All four gateways and the
  named LiveKit worker were ready after deployment.
- The 14 October sub-four-second redesign removes prose generation and
  translation from the interactive Qwen request. The 4-bit 4B model now emits
  exactly one allowlisted semantic code; the controller chooses a reviewed,
  naturally varied phrase and the speech gateway serves its WAV from a
  persistent pod cache. Deployed Romanized-Hindi probes correctly routed
  approve, reject, defer, requester, item-detail and unrelated requests. The
  first request took 1.039 seconds and the following five took 0.113-0.118
  seconds each. A hard 1.5-second worker deadline falls back to a cached scope
  prompt rather than extending silence.
- Deployed synthesis probes measured 2.681-5.755 seconds for two new Hindi
  phrases and 2.329 seconds for a new English phrase. The identical second
  requests returned in 0.002-0.003 seconds. The cache is stored under
  `/workspace/grav-mrf-voice/cache/tts`, so restarts no longer discard those
  renders. The call pre-renders its finite response bank during earlier audio,
  and the VAD end-of-turn wait is now 450 ms. Therefore the warmed reply path
  is expected to be dominated by turn detection and STT rather than Qwen or
  TTS; cold dynamic IndicF5 remains outside the 3-4 second promise and must not
  be placed on the decision hot path.
- The deployed response bank was then seeded once for both Hindi and Odia: 36
  bounded phrases rendered in 110.045 seconds of background setup. Repeating
  all 36 requests completed in 0.919 seconds total, and 39 WAV entries were
  present in the persistent cache. This setup cost is outside a caller session;
  it prevents the same cold-render cost from recurring on ordinary turns.
- A Voice Lab attempt at 22:06 IST on 14 October joined the LiveKit room but
  produced no speech. The exact worker job `AJ_nnF76mYtUgCe` failed before TTS
  with `httpx.ConnectError` while fetching its session context: restarting the
  local CMS had not also restored the separate callback relay and reverse SSH
  tunnel. The narrow relay was restarted on local loopback port 5061 and the
  encrypted tunnel was reopened with fail-fast binding and 30-second
  keepalives. A RunPod-originated authenticated probe now reaches the backend
  and returns the expected terminal-session HTTP 409. Speech, dialogue,
  translation and IndicF5 services remained healthy; a fresh synthetic call is
  required because the failed session was ended.
- The fully silent Voice Lab attempts at 08:00 IST on 15 October were the same
  callback failure after migration to RunPod `civil_amaranth_lion`, not a TTS
  regression. Jobs `AJ_LEhJVgWpvkL8` and `AJ_yPMcF6hiHwK6` crashed at the
  initial `/worker/:id/context` fetch with `httpx.ConnectError`, before any
  synthesis request. The local CMS on port 5050 and the authenticated relay on
  loopback port 5061 were already healthy; the new pod simply had no reverse
  tunnel listener. The encrypted tunnel was reopened against the pod's new SSH
  endpoint with fail-fast binding and 30-second keepalives. A pod-originated
  probe now reaches the relay in 0.345 seconds and receives its deliberate 404,
  while the LiveKit worker and speech/translation services remain ready. Calls
  dispatched before this repair are terminal and require a fresh Voice Lab
  test.
- The next retry (`AJ_zZspV7K7Ayio`) still produced no transcript because it
  also failed before STT: the callback connected but timed out fetching
  context. The migrated local CMS was listening on IPv6 loopback (`::1:5050`)
  while `mrf-voice-local-relay.js` still forced its upstream connection to
  IPv4 loopback (`127.0.0.1:5050`). The relay now targets `::1` explicitly and
  normalizes the bracketed URL hostname for Node's HTTP client. After removing
  the exact orphaned RunPod `sshd` listener and reopening the encrypted tunnel,
  an authenticated pod-originated context probe returned the expected HTTP 409
  in 0.427 seconds. Calls started before this repair cannot yield input text;
  a fresh call is required to exercise STT.
- AI4Bharat Indic Parler-TTS replaced IndicF5 for Hindi and Odia after the
  owner accepted the gated model. Kokoro remains the English path. The Parler
  runtime is isolated from the Qwen/LiveKit environment because it requires
  Transformers 4.46. Hindi uses Divya and Odia uses Debjani with explicit
  conversational-office voice descriptions.
- Full-sentence trial generation took 12.680 seconds for 9.137 seconds of
  Hindi audio and 16.410 seconds for 12.063 seconds of Odia audio, which is not
  suitable as a buffered call response. The deployed gateway therefore uses
  Parler's audio streamer and forwards 24 kHz PCM as SSE deltas through the
  private OpenAI-compatible endpoint. The isolated benchmark produced its
  first Hindi audio in 1.568 seconds. After deployment, the complete production
  proxy returned the first Hindi delta in 2.028 seconds and the first warm Odia
  delta in 0.801 seconds. All four gateways reported ready and LiveKit worker
  `grav-mrf-approval` registered successfully.
- A 15 October delivery-timing probe showed why streamed Parler Hindi still
  sounded non-human despite its fast first delta. The production gateway began
  audio in 1.177 seconds, but generated only 8.373 seconds of audio over 13.872
  seconds (real-time factor 1.657). Typical 116 ms audio chunks arrived about
  180 ms apart, so playout repeatedly starved and exposed synthetic micro-pauses.
  Prompt wording and speech-rate changes cannot repair that transport deficit.
- Hindi now uses Kokoro's native `hf_alpha` Hindi voice and returns a complete
  WAV. On the same A40, the exact 8.850-second Hindi probe completed through the
  production speech gateway in 1.458 seconds (real-time factor 0.165); its cached
  repeat returned in 0.052 seconds. This stays inside the 3-4 second response
  target without accelerating playback or altering pitch. Odia remains on
  Indic Parler pending qualification of a comparably fast native Odia model.
- The RunPod migration preserved several Hugging Face cache files as zero-byte
  placeholders and cleared the temporary Python environments. The affected
  Kokoro, FLAN tokenizer and IndicTrans2 files were restored from their source
  repositories. Runtime defaults now live under the persistent worker root,
  and the translation environment is isolated with Transformers 4.x rather
  than hard-linked to the worker's Transformers 5.x environment. Speech, Hindi
  TTS and IndicTrans2 report ready, and LiveKit worker `grav-mrf-approval`
  registered as `AW_cMdbabMsT7EP` after deployment.
- A user-approval trial was generated with the dedicated Hindi checkpoint
  `aguken-ai/Qwen-3-TTS-12Hz-0.6B-Base-hi-LoRA-Finetuned`, its female Rasa
  reference voice, and the same conversational MRF approval script. The result
  is stored at `docs/audio/hindi-qwen06-approval-sample.wav` (40.160 seconds,
  mono 24 kHz PCM). Cold model load took 23.231 seconds and synthesis took
  107.577 seconds without Flash Attention, so this checkpoint is a voice-quality
  candidate only; it has not replaced the live Hindi path and must not be wired
  into production unless the owner first approves the sample and a streaming or
  otherwise sub-four-second serving path is demonstrated.
- The Qwen Hindi sample was rejected for naturalness and pronunciation. A
  replacement approval trial was generated with Resemble AI's dedicated Hindi
  Chatterbox V3 single-language checkpoint and the official native-Hindi female
  reference voice. The unchanged MRF script is stored at
  `docs/audio/hindi-chatterbox-v3-approval-sample.wav` (22.400 seconds, mono
  24 kHz PCM). Cold loading, including first downloads, took 131.179 seconds;
  synthesis took 12.703 seconds. The owner approved this voice and pronunciation
  on 15 October. It is deployed as a separate warm pod-local service on port
  8894, leaving English and Odia unchanged. A production-gateway probe returned
  a valid 5.040-second mono 24 kHz PCM WAV in 3.327 seconds; the identical cached
  request returned in 0.004 seconds. LiveKit worker `grav-mrf-approval`
  registered as `AW_r5oeCEFkh49q` after the switch.
- The same deployment audit found the Qwen dialogue service down because the
  RunPod object-volume migration had again flattened its Hugging Face snapshot
  links into zero-byte files. Its intact 7.6 GB blobs were reconstructed into a
  direct-file model directory and the launcher now prefers that validated copy
  when the configured model remains the default. The repaired 4-bit gateway
  reports ready at 2,722 MiB allocated and routed a Hindi rejection-like test to
  `CONFIRM_REJECT` in 0.658 seconds; no business decision was committed.
- Voice Lab then exposed that its cards labelled the controller's mixed-script
  sentence as “TTS input”, even though the speech gateway localized it later.
  Translating the whole mixed Hindi sentence also changed “material request”
  into an unrelated meaning. Mixed Hindi now preserves the controller-owned
  Hindi scaffold and translates only embedded names or catalogue phrases;
  English-dominant item descriptions are translated as one unit so quantities
  stay attached to their items. The worker now resolves and records the exact
  final text before handing it to LiveKit TTS. The screenshot example resolves
  to `धन्यवाद। अनीता दास की मटेरियल रिक्वेस्ट आपके अप्रूवल के लिए आई है।`
  and `रिक्वेस्ट में ये आइटम्स हैं: इंडस्ट्रियल सिलाई नीडल्स — 4 बॉक्स;
  पैकिंग टेप — 12 रोल; मशीन ऑयल — 2 कैन।`.
  Both returned valid 24 kHz WAV through the production endpoint, and worker
  `AW_eQzwKEQA4bFb` registered after deployment.
