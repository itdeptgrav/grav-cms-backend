# Open-Jev pilot for GRAV CMS

Status: proposed pilot, not production integration. Date: 22 September 2026.

## Decision

Evaluate Open-Jev as a local, typed decision engine for narrow CMS tasks. Do not
give the model database credentials, a database connection string, direct SQL,
or a general tool-execution interface. Open-Jev accepts supplied context and
candidate decisions; it is not an authority for the facts in GRAV's records.

This is an extension of the **existing** central GRAV assistant, not a second
assistant or a new UI. The backend already has `services/ai/gravAssistant.js`,
`services/ai/toolRegistry.js` and `POST /api/ai/assistant/message` (plus its
streaming path). The frontend already has the global assistant overlay and
`/grav-ai`. Preserve their conversation, authentication and visual identity.
The current Ollama tool-selection round and regex fallback remain the baseline
against which Open-Jev must be tested.

GRAV owns each read. The existing department service checks the caller's role,
company and subject scope, reads the minimum permitted fields, and constructs a
small versioned evidence packet. A model adapter may return a typed choice or
score with probabilities. GRAV validates the schema, applies deterministic
thresholds and records the model/checkpoint and evidence version. The model
cannot write records or grant permissions. An unavailable or low-confidence
model leaves the ordinary CMS path working.

## First evaluation

Use an offline, read-only question-routing trial based on questions such as
"Is Rishee present today?" and "Rishee present?". Open-Jev chooses only the
intent (`attendance_today`, `leave_today`, `other`, or `unclear`). GRAV resolves
the employee name against the caller-visible directory and asks the authorized
HR attendance service for today's evidence in the company's time zone. A typo
or multiple matching employees requires clarification. The final answer may
say "checked in" or "no check-in recorded" only when those are the facts the
attendance service publishes; it must not infer physical presence from a
model probability. The pilot must not bypass unresolved HR canonical-attendance
and authorization questions.

This trial starts with synthetic and permission-scoped recorded cases; it does
not query live attendance or expose a user-facing assistant until the HR read
contract is confirmed. Include typo, ambiguity, absent evidence, stale data,
cross-company and unauthorized cases. Compare Open-Jev with a deterministic
router and the CMS's existing AI path on the same held-out cases, measuring
accuracy, abstention, latency and operating cost. Adopt it only if it improves
a defined outcome without weakening refusals.

## Runtime and deployment gate

The public Open-Jev repository describes its completed 2B/9B releases as LoRA
adapters plus a decision head requiring pinned upstream Qwen weights and its
loader. Its documented trained-checkpoint workflow targets Linux/CUDA. GRAV's
current development host is Darwin arm64. Therefore no claim of local speed,
production suitability or zero cost follows from its open-source license.
Benchmark on an explicitly provisioned compatible host before connecting a CMS
route. Keep model traffic within the approved deployment boundary and do not
log employee names or attendance packets in model diagnostics.

## Implementation status (22 September 2026)

Built behind `GRAV_OPEN_JEV_PILOT_ENABLED` (off by default) in `services/ai/openJev/`. It hooks into the first line
of `gravAssistant.chat`/`chatStreaming`. The endpoint, conversation store, authentication and UI are unchanged. Any
`null` from the pilot runs the existing Ollama round and regex fallback exactly as before.

Order of authority:

1. GRAV decides which intents to offer, via `authorizeHr` with `people.read.directory` and `attendance.read`.
2. Open-Jev picks one of the offered intents.
3. GRAV re-authorises, re-reads the question and resolves the person. A typo, an ambiguous name or a partial match
   gets a clarifying question.
4. GRAV reads one employee-day and answers from a versioned evidence packet
   (`grav.hr.attendance-today.evidence/1`).

Live Open-Jev inference is **blocked**: there is no Linux/CUDA host. The Ollama baseline is also **blocked**: no model
is installed. Results and findings are in
[open-jev-pilot-evaluation.md](../audits/open-jev-pilot-evaluation.md).

## Not in this pilot

- Replacing exact validation, credential redaction, permission checks,
  idempotency, consent or policy rules with a probabilistic result.
- A model-generated database query or unrestricted access to MongoDB.
- Automatic HR decisions, Sales assignments, marketing outreach or ad spend.
- Treating an answer to a factual question as something the model can infer
  without the authoritative application read.

Sources: [Open-Jev repository](https://github.com/Zefan-Cai/Open-Jev),
[GRAV Marketing AI gateway](marketing-campaign-health-adviser.md),
[GRAV HR authorization contract](hr-authorisation-contract.md).
