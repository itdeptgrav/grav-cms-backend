# AI interview lab

## Purpose

Give an HR interviewer a safe place to test role-specific pre-screening before connecting it to live candidate records. The first preset is Chartered Accountant, but the question and rubric are editable.

## First release

- HR defines an ordered set of base questions for the role. Hosted Indic-Speak speaks the active question; an interviewer can add planned questions or queue an AI-suggested clarification.
- The candidate speaks an answer, the existing central GRAV Speech client returns the raw Roman transcript, and Qwen 3 32B scores that transcript against an interviewer-owned rubric.
- Every criterion shows points, a reason, and a short exact evidence excerpt.
- Contradictions are shown for the interviewer to verify.
- Indic-Speak is TTS-only. Its Bodhan API key, model selection, language mapping, and speaker allowlist remain server-side; it does not perform transcription.
- HR can preview only server-approved Indic-Speak voices. Hindi/English offer Kavya and Amit; Odia offers Itishree and Akash. Arbitrary browser-supplied voice or model identifiers are rejected.
- HR can keep the authored question in English while selecting conversational Hinglish or Odia speech. The backend converts a bounded copy through the existing private Qwen 3 32B API into natural speech text and sends only that copy to Indic-Speak; the authored English question remains the interview and scoring source. GRAV Speech remains transcription-only and is not used for question translation.
- Every transcribed candidate turn passes through a bounded Qwen conversation controller before scoring. A request to repeat replays the same question and receives no score; a request for clarification receives a neutral rephrasing that does not reveal an ideal answer; explicit skips and unusable audio remain unscored.
- The call begins with a Qwen-written welcome and a brief introduction question. The introduction is rapport-building context and is never scored. After each substantive answer, Qwen produces a short neutral acknowledgement and decides whether to ask a bounded evidence follow-up or advance to the next planned question.
- Qwen may add only allowlisted delivery cues (`[warm]`, `[professional]`, `[explain]`, `[excited]`/`[excitement]`, `[neutral]`, and bounded pause cues). The backend interprets those cues as Indic-Speak request styles and PCM silence; the cue text is not spoken, stored as candidate evidence, or used in scoring.
- For a substantive answer, Qwen may ask a concise evidence-focused follow-up only for a material rubric gap, ambiguity, or contradiction. The backend caps this at two AI follow-ups per base question and then advances; Qwen cannot create an open-ended interrogation.
- The backend can recompute a consolidated report from the raw completed question/answer turns. It shows per-question evidence scores, demonstrated strengths, knowledge gaps, contradictions, and suggested questions for a human reviewer, but never produces a hire/reject or ranking recommendation.
- Browser video can be recorded and replayed locally. The lab reports duration, track availability, and interviewer-marked interruptions.
- Results are temporary prototype output. They do not update a candidate, stage, offer, or hiring decision.

## Required boundary

The system must not infer nervousness, suspicion, honesty, emotion, personality, health, disability, or another protected or sensitive trait from face, voice, gaze, movement, or appearance. Those signals are unreliable and inappropriate for automated employment decisions. Video may supply the recording and objective session facts; a human reviewer owns all interpretation and decisions.

## Final conversation flow

1. HR selects a role, edits the ordered base questions and rubric, chooses English, conversational Hinglish, or conversational Odia, and selects a compatible server-approved Indic-Speak voice.
2. After recorded consent, Qwen creates a short welcome, thanks the candidate for joining, and asks for a brief introduction. The introduction answer is acknowledged but remains unscored. The backend sends only this delivery script to hosted Indic-Speak; the authored questions and rubric remain unchanged.
3. The candidate answers while the browser records the turn. In hands-free mode, speech activity followed by about 1.7 seconds of silence ends and submits the turn automatically; the interviewer can disable this and use manual Stop/Continue controls. GRAV Speech returns the raw Roman transcript; neither Qwen nor a human rewrite may replace that source transcript.
4. A deterministic server guard recognises common English and Hinglish repeat phrases immediately, without model latency or cost; ambiguous intent then goes to Qwen before scoring. “Please repeat” replays the same question and starts a fresh answer recording. A clarification request receives a neutral rephrasing. Neither is scored.
5. A substantive answer is scored against the server-normalised rubric. Qwen first writes a brief acknowledgement that does not praise correctness or disclose a score, then decides whether a concise follow-up is needed for a material evidence gap, ambiguity, or contradiction. The server permits at most two follow-ups for the base question.
6. The acknowledgement and Qwen-selected follow-up or next planned question are spoken as one natural transition. A generated follow-up is inserted immediately after its base question so the interview returns to the planned sequence afterward. A human may add a planned question at any point.
7. At the end, the backend sends the bounded raw question/answer turns to Qwen for a consolidated evidence report. The application recomputes all totals from normalised criterion scores and displays the raw transcripts beside the report.
8. The report contains demonstrated knowledge, gaps, contradictions and suggested human-review questions. It contains no automated hire/reject, ranking, personality assessment or behavioural inference.

## Acceptance criteria

1. Only an HR user with recruitment access can open the lab; running inference requires recruitment-management capability.
2. Candidate text is treated as untrusted data and cannot change the evaluator instructions.
3. The application computes the displayed total from the configured rubric; the model cannot alter criterion IDs or maximum points.
4. Every output says that human review is required and makes no hire/reject recommendation.
5. Camera and microphone do not start until the interviewer confirms consent.
6. Indic-Speak remains unavailable until `BODHAN_API_KEY` is configured server-side. The prototype remains release-blocked until employment, consent, privacy, vendor-terms, and AI-governance review is complete; the browser must never receive the key.
7. The browser cannot provide company identity, model selection, source object keys, or callback URLs to GRAV Speech. Company identity is derived from exactly one active server-side HR company grant, or—in the legacy single-company deployment—from the sole active company record. Multiple companies without an actor grant fail closed.
8. Raw `romanTranscript` and `speakerTurns` returned by GRAV Speech remain unedited; Qwen evaluates a copy but never rewrites the source transcript.
9. The service-status indicator checks GRAV Speech readiness, distinguishes model warm-up from ready/unavailable states, and speech requests have a bounded timeout so the interview UI cannot wait indefinitely.
10. Repeat and clarification requests are not treated as deficient answers. AI follow-ups are bounded, neutral, traceable to a rubric gap, and never reveal the expected answer.
11. Final report totals are computed by the application from bounded criterion scores; model output cannot change criterion IDs or maximum points.
12. The introduction is excluded from evidence scoring and the final report. Delivery cues change presentation only and cannot affect scoring or candidate assessment.
