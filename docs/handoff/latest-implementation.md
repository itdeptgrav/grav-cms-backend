# Latest Implementation Handoff

---

## Call recordings on the Sales customer record

> **Synced phone-call recordings surface on the customer they belong to, matched
> by phone number or by the name the call was saved under, with the audio and an
> AI summary in place.** Both Sales customer surfaces get it: the CRM account
> workspace and the portal-customer page. Nothing committed.

### Backend (`grav-cms-backend`)

| File | Purpose |
|---|---|
| `services/callRecordingMatch.service.js` | **New.** Pure matching helpers. `phoneKey` normalises any number to its last 10 digits (`+91 98765 43210`, `098765-43210`, `9876543210` → one key). `nameKey` lowercases, flattens punctuation and strips legal suffixes (`Mayfair Exports Pvt. Ltd.` → `mayfair exports`); org names additionally yield their leading brand word as a key when it is ≥5 chars, so a contact saved as "Mayfair Textiles" matches. Person names are whole-phrase only — "Rahul" is not an identity. `buildRecordingFilter` returns the Mongo `$or` (indexed `normalizedPhone` clause + a raw-`phoneNumber` digit-tail regex for un-backfilled rows + name regexes); `annotateMatches` applies the strict whole-word rule in memory and stamps each row `matchedBy: "phone" \| "name"`. |
| `models/CallRecording.js` | Added `normalizedPhone` (maintained by a pre-save hook calling `phoneKey`) + index; added `aiSummary` / `aiSummaryModel` / `aiSummaryAt`, kept **separate** from the device's own `summary` so the two are never confused or overwritten. |
| `services/callSummary.service.js` | **New.** Gemini (`gemini-flash-lite-latest`, matching `aiAssist.service.js`) turns a transcript into a short sales-readable summary — one opening line, "Discussed:" bullets, "Next step:". Returns a typed result, never throws for a provider failure; quota is reported distinctly from a connection failure. Deliberately does **not** transcribe audio: no transcript → it says so and stops. |
| `routes/CMS_Routes/Sales/callRecordings.js` | **New**, `salesAuth` per handler. `GET /` (`?accountId=` or `?customerId=`) resolves the customer's numbers and names — for a CRM account that includes every contact person's `phone`/`mobile`/`whatsapp` — and returns matched recordings with `matchedBy`/`matchedOn`. `GET /:id/audio` proxies the Drive file so audio stays behind the Sales session (the uploader makes each file link-public; a raw Drive URL would be permanently replayable by anyone who saw it once). `POST /:id/summarize` generates and stores the AI summary, idempotent unless `force`. |
| `server.js` | One mount at `/api/cms/crm/call-recordings`, **without** `salesWrites()` — nothing here creates a business record, and holding a "summarise" click for an approver would be nonsense. |
| `backfill_call_recording_phones.js` | **New**, optional. Fills `normalizedPhone` on pre-existing rows. Idempotent; changes no results (the regex fallback already covers them), only the query plan. |

The Android app's upload endpoint (`/api/recordings`, shared-API-key gated) is untouched.

### Frontend (`grav-cms`)

| File | Purpose |
|---|---|
| `components/sales/CallRecordingsPanel.js` | **New.** Self-fetching panel: call list (direction, time, duration, number), expandable row with audio, AI summary, the recorder app's own summary shown separately, collapsed transcript, and notes. A name match is always labelled "Name match" with the name it matched on — a fuzzy join is never presented as fact. Audio is fetched as a credentialed blob rather than set as an `<audio src>`, because a cross-origin `src` sends no cookies and would 401 silently in dev. |
| `app/sales/dashboard/accounts/[id]/_sections/CallRecordingsSection.js` + `page.js` | New "Calls" tab in the account workspace, next to Activities. |
| `app/sales/dashboard/customers/[id]/page.js` | New "Calls" tab; needs no `fetchTabData` branch since the panel fetches its own data. |

### Verification

- Matcher exercised directly against a fixture set: exact number in three formats → `phone`; "Mayfair Textiles" and `call_20250612_mayfair.m4a` → `name`; **"May Flower" and "Rahul Verma" correctly excluded**; empty identity → `null` filter (the caller returns no recordings rather than every call in the company).
- All new/changed backend modules `require` cleanly; all changed frontend files parse.
- **Not verified in a browser:** no logged-in Sales session or seeded recordings were available in this environment, so the rendered tabs, the audio proxy end-to-end, and a live Gemini summary have not been exercised.

---

## Global GRAV Assistant — Chunk 2: global text overlay

> **One GRAV assistant overlay, mounted once in the root shell, available on the
> app switcher and every authenticated app.** Bottom-centre translucent rounded
> composer that expands into a conversation panel; talks to the central
> `/api/ai/assistant/message`; keeps its conversation across app navigation.
> **Chunk 2 only** — no microphone / speech / "Hey GRAV" / waveform (Chunk 3+).
> HR endpoints remain thin task adapters (unchanged). Nothing committed.

### What was built (frontend `grav-cms`)

| File | Purpose |
|---|---|
| `components/ai/GravAssistantOverlay.js` | The single overlay. Launcher (compact "Ask GRAV" pill, bottom-centre) ↔ open (wide translucent rounded composer + conversation panel above it). Typing, send, loading ("GRAV is thinking…"), error bubbles, conversation history, reset (new conversation), collapse/close. Restores prior server-side conversation on mount via `GET /api/ai/assistant/history`. Sends `{ message, routeContext }` to `POST /api/ai/assistant/message` with `credentials: "include"`; route is context only. Shortcuts: `Cmd/Ctrl+O` and `Ctrl/Cmd+Space` toggle; `Escape` collapses. Uses GRAV frost tokens (not a literal copy of the reference). |
| `components/shell/AppShell.js` | Mounts the overlay **exactly once**, at a stable position (always the 2nd child of the top-level fragment) so React preserves it across a client navigation between apps — the conversation is not reset when moving app→app. Rendered only when authenticated (`checked && departments.length > 0`), so it never appears on login/onboarding-unauthed. Being a single root mount, it cannot duplicate during navigation. |

No backend changes — the Chunk 1 central endpoint is reused as-is.

### How the requirements are met

- **One overlay in the highest shared shell** — mounted in `AppShell` (root layout), the same instance on the app switcher (`/onboarding`), HR, Sales and all authed apps.
- **Central endpoint** — `/api/ai/assistant/message`; conversation keyed server-side by user (Chunk 1).
- **Same conversation across apps** — the overlay never remounts on client navigation (stable mount position), so its React message state persists; on a full remount it also restores from `/history`.
- **Bottom-centre compact translucent composer that expands** — verified visually; it floats (fixed), never consuming layout space; collapses to a small launcher pill.
- **Shortcuts** — `Cmd/Ctrl+O` attempted (browsers may reserve it) + `Ctrl/Cmd+Space` reliable fallback; `Escape` collapses. (On macOS, `Cmd+Space` is Spotlight and never reaches the page — `Ctrl+Space` is the one that works there.)
- **Route is optional context only** — passed as `routeContext`, never changes identity or gates answers (enforced server-side in Chunk 1).
- **Single instance / no duplication** — one mount in the persistent root shell.

### Verification (live, running stack)

Driven through a temporary unguarded harness (since the sandbox browser is not page-authenticated — see limitation) plus direct API checks:

- **Build:** `npm run build` compiles; overlay renders **bottom-centre**, correctly centered.
- **Open/att shortcut:** `Ctrl+Space` opens the composer and auto-focuses the input.
- **Type + send → real reply:** sent "Hello GRAV, what can you help me with?" → a genuine **central-assistant** answer with the GRAV identity ("I'm GRAV… across the app switcher, HR, Sales, Accounting…") — confirms the overlay uses `/api/ai/assistant/message`.
- **Expand/panel:** conversation panel opens with header (New conversation + Collapse).
- **Escape:** collapses to the launcher and **preserves the conversation** (pill shows the message count).
- **Auth-gating:** on `/login` (unauthenticated: `/api/auth/verify` → 401) the overlay is **absent**.
- **Server-side restore:** `GET /api/ai/assistant/history` → 200 with the prior turns (restore-on-mount path).

### Conversation persistence — honest answers to the two questions

- **Across app navigation (app switcher ↔ HR ↔ Sales): YES.** The overlay is a single mount at a stable position in the persistent root shell, so a client-side navigation does not remount it and the message state carries over. Even on a full page reload (a real remount) it restores the conversation from the server via `/history`. *Caveat:* I could not drive the authenticated multi-app navigation inside the sandbox browser — it is not page-authenticated (`/api/auth/verify` returns no departments there) and I cannot log in (entering a password is not something I do). Please confirm in your logged-in browser; the mechanism and the server-restore path are both verified.
- **Across a backend restart: NO — and this is expected, not permanent persistence.** The Chunk 1 conversation store is in-memory. Verified directly: with 2 turns stored, restarting the backend and calling `/history` returned **0 turns**. A still-open tab keeps its local React messages, but the server has lost the context, and a page reload shows an empty history. A durable store (e.g. Mongo) would remove this and is a clean future change behind the same API.

### Preserved / no commit

- HR endpoints and panels untouched (thin task adapters, as agreed). Temporary verification harness was removed. Only `AppShell.js` was modified plus the new overlay component. Pre-existing uncommitted work untouched. Nothing committed or staged. Chunks 3–5 (voice, "Hey GRAV", hardening) not started.

### Chunk 2 corrections (post-review)

Four fixes applied; no redesign, no voice work.

1. **Authentication gating decoupled from departments.** `AppShell` now tracks a
   separate `authed` flag = a *successful* `/api/auth/verify` (not a mere cookie,
   and not `departments.length`). Department data drives only the rail. The
   overlay shows to every server-verified employee — **including `/onboarding`
   with an empty department list** — and is hidden on public/sign-in routes via
   a dedicated `ASSISTANT_HIDDEN_PATHS` list (`/`, `/login`, `/signin`,
   `/coworking-login`, `/accountant/login`, `/accountant/accept-invite`).
   Verified: all 12 route show/hide decisions correct; overlay absent on
   `/login`; an old cookie that fails verify (as in the sandbox) does **not**
   expose it.
2. **Restoration race closed.** Sending is blocked until the initial history
   restore settles (`!restored` guards both `send()` and the send button; the
   `finally` always sets `restored`, so it can't hang). A delayed history
   response can no longer overwrite what the user has entered/sent: restore is
   skipped once a `dirtyRef` is set (on typing or sending), and — because send
   is gated until restored — a sent message can never race restore. Verified in
   a harness: a draft typed during a 4 s-delayed restore was preserved.
   Navigation persistence unchanged.
3. **Reset correctness.** Reset now awaits the backend and clears locally **only
   on success**; on failure it keeps the conversation and shows a retryable
   error ("Couldn't start a new conversation. Please try again."). Repeated
   clicks while pending are ignored (button disabled + single in-flight guard).
   Verified deterministically: failure → preserved + error + 1 call; success →
   cleared.
4. **Verification.** Route logic + component behaviour verified as above.
   *Caveat unchanged:* the sandbox browser has no v2 verify session and I do not
   sign in, so I could not drive the authenticated `/onboarding → HR → Sales`
   navigation myself — please confirm that visual flow in your logged-in
   browser (single overlay, same conversation carried across apps). Backend
   restart still clears the in-memory history by design (documented limitation,
   not durable storage — unchanged this pass).

---

## Global GRAV Assistant — Chunk 1: centralise the Qwen integration

> **One central CMS assistant, one identity, one model path.** The HR-specific
> AI has been refactored into a single shared backend service + central API that
> any authenticated employee can use. HR data is now a **permission-gated tool**
> of the central assistant — not a separate HR model or personality.
> **Chunk 1 only** (backend centralisation). Chunks 2–5 (global overlay, voice,
> "Hey GRAV", hardening) are NOT started. Nothing committed.

### What was built (backend `grav-cms-backend`)

| File | Purpose |
|---|---|
| `services/ai/identity.js` | The ONE constant GRAV identity + `buildSystemPrompt({routeContext, taskRules})`. Identity never changes with page/app; route is context-only and never rewrites it. |
| `services/ai/toolRegistry.js` | Feature modules register permission-gated context tools (`permission(user)`, `matches(message)`, `provideContext`). Central service attaches a tool's data only when the signed-in user is authorised AND the message is relevant. |
| `services/ai/tools/hrTools.js` | Registers `hr_overview` (aggregate HR context), gated to `hr_manager`. The only place HR data reaches the general assistant. |
| `services/ai/conversationStore.js` | Per-USER conversation (keyed by verified `req.user.id`, not route), in-memory, windowed to 24 turns. Survives navigation; isolates users. |
| `services/ai/gravAssistant.js` | The ONE central service and the ONLY caller of the Ollama client. `chat()` = general answer (attaches authorised+relevant tool data, threads user history); `runStructured()` = feature structured tasks through the same identity/model. |
| `routes/ai/assistant.js` | Central API: `POST /api/ai/assistant/message`, `GET /assistant/history`, `POST /assistant/reset`. Any authenticated employee; conversation keyed by user; `routeContext` optional and non-authoritative. |
| `routes/HrRoutes/AiOverviewAssistant.js` · `AiDailyAttendanceAssistant.js` | **Refactored to delegate** to `gravAssistant.runStructured` (no direct model calls). Their prompts were reframed from a competing "You are the HR … Assistant" identity into a structured **task** under the central GRAV identity. Response shapes unchanged, so the existing HR panels keep working. |
| `server.js` | +1 mount: `/api/ai` → central assistant (after the HR AI mounts). |
| `test/hr-ai/centralAssistant.route.test.js` | 11 tests: auth fail-closed, any-employee reply, HR tool attached only for HR + only when relevant, permission isolation (Sales never sees HR data), conversation persistence across messages, cross-user isolation, reset, route-context-is-context-only. |

### How the requirements are met

- **Reuses existing Ollama + qwen3:8b**; `gravAssistant` is the single caller of `services/ollamaClient` — no duplicated model logic anywhere.
- **One identity, no page-specific personality** — `identity.js` is constant; feature screens contribute a *task* + *data*, not an identity.
- **HR data = permission-gated tool/context**, gated to `hr_manager`; a non-HR user's message never has HR data attached (enforced server-side in the registry, keyed off the verified JWT role).
- **Conversation keyed by user/session, not route** — moving between app switcher / HR / Sales keeps the same conversation; a user cannot read another's.
- **Existing HR Overview questions still work through the central service** — the HR routes now call `runStructured`; all prior HR tests pass unchanged.
- **Private HR info not exposed outside permissions** — verified by test and live (Sales user refused, HR user served).

### Verification

- **Backend jest:** `test/hr-ai` **45/45** (incl. the real qwen3:8b smoke); full suite **359/359** — the HR-route delegation caused no regressions.
- **Live through the central endpoint (real qwen3:8b):**
  - HR user, "how many present today + anything to watch?" → correct answer, `toolsUsed=["hr_overview"]` (~29s).
  - Follow-up "which department did you say needs attention?" → answered from **conversation memory** ("Cutting … below the overall rate"), ~7s.
  - Sales user, same HR question → **no** HR data (`toolsUsed=[]`), replied "I don't have access… check the HR module."
- **Routes mounted (after restart on :5050):** `/api/ai/assistant/message`, `/api/hr/ai/overview-assistant`, `/api/hr/ai/daily-attendance-assistant` all return `401` JSON; clean boot.

### Notes / limitations (for later chunks)

- Conversation store is in-memory (survives navigation, not a server restart); a durable store can replace it without changing callers.
- Tool relevance uses keyword matching (not full model function-calling) — deliberate for Chunk 1; sufficient for HR overview questions. Daily attendance stays a page-scoped endpoint (needs a date scope) and also routes through the central service.
- No frontend changes in Chunk 1 — the global bottom-centre overlay, `Cmd/Ctrl+O` launcher, voice and "Hey GRAV" are Chunks 2–4 and were not started.

### Preserved / no commit

- Existing HR Overview + Daily Attendance behaviour and response shapes unchanged (they now flow through the central brain). Pre-existing uncommitted CRM/Sales-Journey work untouched. Only `server.js` AI mounts changed. Nothing committed or staged.

---

## Daily Attendance AI — first page-contextual HR AI tool (read-only)

> **Extends the HR AI to `/hr/dashboard/attendance/daily`.** A read-only,
> page-scoped attendance assistant built on the same Ollama client, HR-only
> authorisation and one shared visual panel as the Overview assistant (which is
> unchanged). Establishes the reusable architecture for the later Muster Roll,
> Timecard, Leaves and Regularisations tools. Nothing committed.

### What was built

**Backend (`grav-cms-backend`)**

| File | Purpose |
|---|---|
| `routes/HrRoutes/Attendance_section.js` | Refactor only: the `GET /daily` handler body was extracted into an exported `async getDailyAttendance(date, department)` (same query params, same returned shape); the route is now a thin wrapper. So the AI reads attendance through the **exact same calculation/status logic** the page uses — one source of truth, no drift. |
| `services/hrAiShared.js` | Shared safety helpers for all HR AI tools: `isRestricted()` (privacy + **ranking/misconduct/employment-decision** patterns), `sendOllamaError()` (code→503/504/502), `asStringArray()`, `DISCLAIMER`. The Overview assistant is intentionally left untouched. |
| `services/dailyAttendanceContext.js` | Validates scope hints (`date` `YYYY-MM-DD`, `department`, `statusFilter`/`typeFilter` enums, `search`), calls `getDailyAttendance` server-side, applies the **same filter predicate** as the page, and projects each row to attendance-only fields (name + biometric id as shown on the HR page, department, type, status + label, in/out, late/early + mins, missed-punch, HR-override flag). Keeps **missing data distinct from absence** (`dataState: not_synced`, `MP` legend). Never reads salary/bank/contact/documents/medical. Prompt row cap 200 (count preserved). |
| `routes/HrRoutes/AiDailyAttendanceAssistant.js` | `POST /api/hr/ai/daily-attendance-assistant`. Auth + fail-closed `hr_manager`; validates question (≤500) and scope; refuses restricted intents pre-model; strict read-only attendance system prompt; structured output `{summary, attendanceBreakdown, itemsNeedingAttention, observations, suggestedFollowUps}`; **echoes the resolved scope** + `inScopeCount` + `dataState` in `meta`. |
| `server.js` | +2 lines: mount `AiDailyAttendanceAssistant` under the existing `/api/hr/ai`. |
| `test/hr-ai/dailyAttendance.route.test.js` | 11 mocked HTTP tests — fail-closed 401/403, scope validation, **server-side fetch / client records ignored**, filter scoping, missing-data-vs-absence, restricted refusal, structured 200, error mapping, no leak. |
| `test/hr-ai/dailyAttendance.smoke.test.js` | **One real qwen3:8b smoke test** through the live route (auth + DB fetch stubbed, real model). Auto-skips when Ollama/`qwen3:8b` is unreachable so CI without a model still passes. |

**Frontend (`grav-cms`)**

| File | Purpose |
|---|---|
| `components/hr/HrAiAssistant.js` | The single reusable HR AI panel (button + compact floating dialog, presets, free-text, generic structured-answer renderer, browser-only conversation). Optional `scope` (page hints merged into every request — never records), `scopeText` (header line) and `formatScope(meta)` (per-answer scope line from the server's echo). |
| `components/hr/HrOverviewAssistant.js` | Now a thin wrapper over `HrAiAssistant` with the overview config — **same appearance and behaviour as before**. |
| `components/hr/DailyAttendanceAssistant.js` | Wrapper wired to the daily endpoint; auto-scoped to the page's date/department/status/type/search; presets *Summarise this day · Who needs attendance review? · Explain absences & late arrivals · Find missed punches · Draft follow-up reminders*; renders a human-readable scope in the header and on every answer. |
| `app/hr/dashboard/attendance/daily/page.js` | +1 import, +1 `<DailyAttendanceAssistant …/>` in the header actions passing the live page state. No redesign. |

### Live API used

- **New:** `POST /api/hr/ai/daily-attendance-assistant`.
- Reads attendance server-side via the existing `getDailyAttendance`. Only outbound call is to the **local** Ollama. Env vars are shared with the Overview tool (`OLLAMA_BASE_URL` / `OLLAMA_MODEL` / `OLLAMA_TIMEOUT_MS`).

### Safety guarantees (server-enforced)

- **Fail closed** — no token → 401; non-`hr_manager` → 403 (before any fetch/model). Employee-specific attendance is therefore HR-only.
- **Server owns the data** — browser sends only scope hints; records are fetched + filtered server-side; any client-submitted records are ignored (test-proven).
- **Attendance-only fields** — no salary, bank, contact, documents or medical data enters the context.
- **Read-only** — no overrides, regularisations, leave changes or disciplinary actions exist in this feature.
- **No ranking / no conclusions** — ranking, misconduct/performance judgements and employment decisions are refused pre-model and forbidden in the prompt; the model is instructed to describe only what the records show.
- **Missing ≠ absent** — unsynced days and missed punches are surfaced as data gaps, distinct from absence, in both context and prompt.
- **No leakage** — `think:false` + `<think>` stripping; prompts/reasoning never returned.

### Verification

- **Backend jest:** `test/hr-ai` **35/35** (incl. the real qwen3:8b smoke, ~33s); full suite **346/346** — the `/daily` extraction caused no regressions.
- **Live (after restart on :5050):** `POST /api/hr/ai/daily-attendance-assistant` → `401` JSON (mounted); Overview route still `401` (intact); `GET /hr/attendance/daily` still `401` JSON (refactor healthy); clean boot.
- **Frontend:** `npm run build` compiles; `/hr/dashboard/attendance/daily` builds.

### Notes / known limitations

- Same latency profile as Overview (local 8B ≈ 10–35s); 60s client timeout applies.
- The `/daily` refactor is behaviour-preserving and covered by the route tests, but I could not exercise it against a real synced day + HR session (needs the live biometric data and an `hr_manager` JWT); its structure and auth path are verified live and by the mocked suite.
- **Design hook:** the impeccable hook flagged 20 pre-existing `10px` font-size findings elsewhere in `daily/page.js` (lines ~287–602) — none in the ~12 lines I added. Left unchanged to preserve unrelated work; not introduced by this task.

### Post-review fixes (from live HR testing)

1. **Empty answer on large contexts.** With all 90 employees in scope, qwen3:8b ignored the multi-field shape and returned `{"answer": "…"}`, so the normaliser showed "No summary was produced." Fixed by (a) passing a **JSON Schema** as Ollama's `format` (structured outputs) from both HR AI routes via a new `schema` option on `ollamaClient.chatJson`, and (b) a defensive normaliser that recovers a stray `answer`/`response`/`text` field. Verified live end-to-end.
2. **Misread punch times.** The model saw raw UTC timestamps and wrongly called a present in-time "missing / not in IST". Fixed in `dailyAttendanceContext.projectRecord`: `inTime`/`outTime` are now formatted to the **same IST clock string the HR page shows** (`"9:28 am"`), and each row carries `hasInPunch`/`hasOutPunch`/`missingPunch` ("in" | "out" | null) so the model states *which* punch is missing. Prompt + legend updated accordingly. Verified: "is umung present?" → "present (P) but out-punch missing"; "what is his in-time?" → "9:28 am, out-time missing".

Both fixes keep the Overview assistant's output shape and behaviour identical (schema + fallback only). Tests: `test/hr-ai` 35/35 still green; backend restarted on :5050.

### Preserved / no commit

- Overview assistant untouched in behaviour; only the shared-panel refactor + schema/fallback hardening sit beneath it. Pre-existing uncommitted CRM/Sales-Journey work untouched. `server.js` changes this session are only the HR-AI mounts. Nothing committed or staged in either repo.

---

## HR Overview Assistant — local Qwen (read-only) foundation

> **Smallest real local-LLM integration for HR.** A read-only "Ask HR AI"
> assistant on the HR Overview, backed by the already-installed local Ollama
> model `qwen3:8b`. No AI/SDK dependency added (native `fetch`), nothing
> committed, existing HR functionality untouched. This is a foundation only —
> it answers questions about the current HR overview aggregates and can do
> nothing else.

### What was built

**Backend (`grav-cms-backend`)**

| File | Purpose |
|---|---|
| `services/ollamaClient.js` | Reusable local Ollama client over native `fetch`. `POST {OLLAMA_BASE_URL}/api/chat`, `stream:false`, `format:"json"`, `think:false`. Defaults `http://127.0.0.1:11434` + `qwen3:8b` + 60s timeout, all env-overridable. `AbortController` timeout; classifies every failure into a stable `.code` (`OLLAMA_UNAVAILABLE`, `OLLAMA_MODEL_NOT_FOUND`, `OLLAMA_TIMEOUT`, `OLLAMA_BAD_STATUS`, `OLLAMA_MALFORMED_RESPONSE`); strips `<think>…</think>` and extracts the JSON object defensively. |
| `services/hrOverviewContext.js` | Builds the aggregate-only model context from the **same source** as `GET /api/hr/overview/dashboard` (Employee, DailyAttendance, LeaveApplication, CompanyHoliday, RegularizationRequest), reusing the identical LHD/LAB/EAB status logic. Returns **only** aggregate headcount, department distribution + attendance, today/monthly attendance, leave + regularisation pending counts, upcoming holidays, alerts. **No names, no individual records, no payroll/salary/bank/medical/profile data.** Does not modify `Overview-Section.js`. |
| `routes/HrRoutes/AiOverviewAssistant.js` | `POST /api/hr/ai/overview-assistant`. `EmployeeAuthMiddlewear` + fail-closed `hr_manager` check. Validates the question (≤500 chars), refuses restricted intents **before any model call**, builds context server-side, calls the model with a strict read-only system prompt, and returns a fixed structured shape. Maps each Ollama failure code to a clear status (503/504/502). |
| `test/hr-ai/ollamaClient.test.js` | 11 unit tests, `fetch` injected — happy path, `<think>` strip, prose-wrapped JSON, model-not-found, bad status, connection-refused, timeout, malformed output/envelope, env overrides. No Ollama, no network. |
| `test/hr-ai/overviewAssistant.route.test.js` | 12 HTTP tests (real Express on an ephemeral port, auth + Ollama + context mocked) — 401/403 fail-closed, structured 200, **context built server-side / client dashboard data ignored**, input validation, restricted-topic refusal, preset handling, error-code→status mapping, no prompt/reasoning leak. |
| `server.js` | +5 lines: mount `hrAiRoutes` at `/api/hr/ai` (before the generic `/api/hr` router). |

**Frontend (`grav-cms`)**

| File | Purpose |
|---|---|
| `components/hr/HrOverviewAssistant.js` | Self-contained "Ask HR AI" button + compact floating panel: preset questions, free-text box, structured answer rendering (summary / priorities / observations / next steps), explicit "AI assistance based on current HR data. Read-only." labels, `Escape`-to-close, focus management. Conversation state lives only in component state (nothing persisted). Sends only `{question}` or `{preset}` — never dashboard data. |
| `components/hr/HrOverview.js` | One line added to the header actions (`<HrOverviewAssistant />`) next to Refresh. No redesign. |

### Live APIs used

- **New:** `POST /api/hr/ai/overview-assistant` (this work).
- **Reads (server-side only):** the same Mongo collections the HR dashboard already reads. No new external API. The only outbound call is to the **local** Ollama server.

### Environment (all optional; sensible defaults)

- `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`)
- `OLLAMA_MODEL` (default `qwen3:8b`)
- `OLLAMA_TIMEOUT_MS` (default `60000`)

No `.env` change is required to run with the installed model.

### Safety guarantees (enforced server-side)

- **Auth + HR fail closed** — no token → 401; authenticated non-`hr_manager` → 403; neither reaches the model.
- **Server-owned context** — any dashboard/context the browser POSTs is ignored; the backend builds its own aggregate snapshot (a dedicated route test proves the injected value never reaches the prompt).
- **Aggregate-only exposure** — no payroll, salaries, bank details, passwords, documents, medical data, private profiles, or individual employee records ever enter the context.
- **Restricted intents refused pre-model** — pay, personal data, candidate ranking / hiring / firing / promotion, and raw-DB / prompt-extraction phrasings return an instant canned refusal.
- **Read-only** — no approvals, attendance/leave/regularisation actions, or employee mutations exist in this feature.
- **No reasoning/prompt leakage** — `think:false` plus `<think>` stripping; the system prompt and model reasoning are never returned.

### Verification

- **Backend jest:** `test/hr-ai` 23/23 pass; full suite **334/334 pass** (no regressions).
- **Live end-to-end** against the installed `qwen3:8b`: the client returns the exact `{summary, priorities, observations, suggestedNextSteps}` shape with no `<think>` leak (~9–25s); the real route returned 200 for HR, 403 for non-HR (no model call), and an instant restricted-topic refusal (no model call).
- **Frontend:** `npm run build` compiles successfully; `/hr/dashboard` builds.

### Known limitations

- First version: conversation is browser-only and not persisted; no rate limiting on the endpoint yet; answers are AI-generated and may be imperfect (surfaced to the user).
- Requires a local Ollama running `qwen3:8b`; when it is down/missing/slow the endpoint returns a clear 503/504 and the panel shows a friendly message.
- Aggregate context intentionally omits the dashboard's name-bearing lists (recent hires, today-on-leave names) — counts only.

### Unrelated work preserved / no commit

- The pre-existing uncommitted CRM Step 01 + Sales Journey work (both repos) is untouched; the only `server.js` change this session is the 5-line `/api/hr/ai` mount.
- Nothing was committed or staged in either repository.

---

> **Active Lead Command Centre — Phase 1 correctness pass (both repos).** Four
> focused fixes, no redesign. (1) **Singular, deterministic next action** —
> `PATCH /leads/:id/next-action` now picks the CANONICAL open follow-up (earliest
> due, tie-broken by createdAt — the same one the frontend `byDue` picks; the FE
> canonical set is now follow-ups only), updates it in place, and CANCELS any
> other open follow-ups (status `cancelled`, kept as history — never deleted),
> keeping `nextFollowUpAt` synced. Transactions aren't available on the standalone
> test Mongo, so a Lead-save failure rolls the Activity writes back by hand (no
> drift). (2) **Partial-failure safety** — the Activity drawer now saves the
> interaction FIRST and refreshes the timeline, THEN offers an optional Set next
> action step (shared `NextActionForm.js`); if that fails it reports the
> interaction was saved and retries only the next action — the interaction is
> never re-submitted. (3) **Call** — the dialer no longer auto-opens; there's an
> explicit "Open dialer"; after logging the outcome the same Set/Update Next
> Action step runs (`QuickCall.js`). (4) **Seamless approval** — the Prospect
> detail page's `onApproved` now RELOADS the same Lead in place (no redirect, no
> duplicate) so it re-renders as the Active-Lead Command Centre. New/updated
> tests: `lead-next-action.route.test.js` now covers canonical+cancel, rollback
> consistency, and interaction-survives-next-action-failure (6 tests); related
> lead suites green (65 passed). Sales Journeys untouched. Not committed.
>
> **Prior: Active Lead Command Centre — Phase 1 (both repos).** Action-first layout on
> the existing `/sales/dashboard/leads/[id]` Active-Lead page (LeadWorkspace.js,
> not restarted): compact header (identity company/person · qualification status
> · owner · next action + due), a primary-action bar **Call · Email · Message ·
> Meeting · Note** plus one prominent **Set / Update Next Action** control (NO
> separate CRM Task action), a "Needs attention now" band (overdue / missing next
> action / qualification blockers), the central Activity timeline with
> communication-type filters, and a right **Lead Brief** (contacts, confirmed
> requirement, researched commercial potential + evidence summary, HOD approval
> context shown READ-ONLY, and qualification readiness + the backend-enforced
> move controls). Detailed fields stay in the Edit Lead Details drawer. All five
> communication actions run through ONE reusable Activity drawer
> (ActivityComposer / QuickCall extracted to `QuickCall.js`) on the existing Lead
> Activity API + CRMActivity — Call/Email/Message/Meeting capture contact,
> direction, date-time, outcome, notes; Message adds channel (WhatsApp/SMS/Other);
> Note is internal; open-external (tel/mailto/wa) is clearly separated from
> logging. New backend endpoint **`PATCH /leads/:id/next-action`** — sets/updates
> the ONE open planned follow-up Activity (subject + due) and `nextFollowUpAt`,
> reusing CRMActivity (not a task system); updates in place, creates when none.
> The Prospect→Active handoff is UNCHANGED and already correct: approval keeps the
> same Lead record, preserves identity/source/sourced-by/owner/research/estimates/
> evidence/justification/HOD review history, carries `pendingFirstAction` into the
> Active Lead as the real next action (planned follow-up + `nextFollowUpAt`, both
> visible in the timeline/queue), and leaves `qualificationState` at `new`. New
> tests `lead-next-action.route.test.js` (3); related lead suites green (60
> passed). Prospect behaviour, qualification rules, conversion and Sales Journeys
> untouched. Not committed.
>
> **Prior: Prospect closeout pass (both repos).** Five focused fixes, no redesign:
> (1) **Prospects page** — for reviewers (HOD/admin) a new `Awaiting Review`
> scope (submitted team Prospects) is the DEFAULT view; `My Prospects` and
> `Team Prospects` stay (`app/sales/dashboard/prospects/page.js`). The default
> scope initialises only AFTER the async department role resolves
> (`useDeptRole().loading`) — scope is `null` and Prospect loading is held until
> then, so a COLD load no longer strands an HOD on `My Prospects`; it fires once
> and never overrides a manual choice (build-verified; no frontend test harness
> in this repo). (2)
> **ProspectCard** — company-type Prospects now title with the company name
> (contact person secondary); individuals keep the person primary. (3) Evidence
> read wording `Attached` → `Reference provided` (a reference may be a URL or
> doc). (4) `Review Prospect for HOD` → `Review Prospect`. (5) **"Not sure yet"
> now genuinely clears a saved Lead Source / Customer Segment** — the frontend
> sends `""` verbatim and `pickEditable` (routes/CMS_Routes/Sales/leads.js)
> normalises an empty CLEARABLE_ENUM_FIELDS value to `undefined`, so Mongoose
> `$unset`s it and submission readiness (`source`/`segment`) flips back to
> unmet. New test `test/crm/lead-clear-enum.route.test.js` (2 tests); the
> related lead suites stay green (113 passed). Active Leads and Sales Journeys
> untouched. Not committed.
>
> **Prior session: Prospect → HOD Review → Active Lead approval workflow
> (both repos).** A Prospect (captureStatus:"draft") no longer becomes an
> Active Lead by a salesperson pressing a button — it now carries a THIRD,
> independent status axis, `reviewStatus`
> (researching → submitted → approved | returned | rejected), and the ONLY
> path to an Active Lead is a HOD/admin approving a submitted Prospect,
> enforced on the backend. New: `services/leadReview.js` (single-writer state
> machine, mirrors leadQualification.js), `computeSubmissionReadiness`
> (the ~11-item Submit-to-HOD checklist replacing the retired 5-item "start
> working" bar), and four routes — `POST /:id/submit` (rep, readiness-gated),
> `/:id/approve` (HOD only, optional owner override, the retired
> `/:id/activate`'s replacement + reliability pattern), `/:id/return-for-info`
> and `/:id/reject` (HOD only, reason required; reject = archive). Submitted
> Prospects are read-only for everyone at the field level (`refuseIfLocked`).
> New Lead fields: `reviewStatus`, `pursuitJustification` ("Why should we
> pursue this?"), and review audit (`submittedAt/By`, `reviewedAt/By`,
> `reviewReason`). Frontend: `lib/leadReview.js`, a `PursuitCaseSection`, and
> a rebuilt `DraftWorkspace` that shows the submission checklist + Submit/
> Resubmit for the rep, a native-`<fieldset disabled>` read-only lock while
> submitted, the returned-reason banner, and a HOD review panel (Approve with
> optional owner / Return / Reject). This is a review gate, NOT conversion —
> "Approve as Active Lead", never "convert"; no Account/Contact/Sales Journey
> is touched, no Active-Lead qualification changed. Ownership unchanged from
> the prior session: no owner/source controls at capture or Prospect Setup,
> creator auto-credited/owned, HOD may reassign only inside the approval
> action. Backend **299/299 jest** (18 suites; new `lead-review.route.test.js`
> = 20 tests). Frontend `npm run build` clean. Full flow browser-verified
> (submit gating, read-only lock, HOD approve→Active Lead, return→editable→
> resubmit). **No migration, nothing committed.** Detail + the earlier
> Prospect-capture and correction work below.
>
> Earlier this session: **Prospect capture chunk (Chunk 1 of the revised Lead →
> Sales Journey roadmap) — `grav-cms-backend` + `grav-cms`, both repos.**
> Product model going forward: **Prospect** (a possible buyer we're still
> preparing to work) and **Active Lead** (one we're actively researching,
> contacting and qualifying) are the SAME `Lead` record — internal
> `captureStatus: draft`/`active` is unchanged, "Prospect" is a user-facing
> rename only, no field rename, no migration. Planned chunks: 1) Prospect
> capture and setup (**this session**), 2) Active Lead activities and
> controlled statuses, 3) Requirement/commercial potential/qualification, 4)
> secure evidence/document handling, 5) conversion to Account/Contact/Sales
> Journey. Only Chunk 1 was implemented; 2–5 are explicitly out of scope and
> untouched.
>
> **What changed:** Quick Capture now also asks Customer segment (reuses
> `industry`), Lead Source, and City/location — still under a minute, still
> never requirement/quantity/revenue/procurement/decision-maker/evidence.
> Prospect Setup (was "Preparing this Lead") was cut down to exactly: Basic
> identity + contact/location (`IdentitySection`, now also carrying Customer
> segment), Lead Source + owner (`OriginSection`, Priority removed — that's
> Active-Lead-only now), one short **Initial research note** (new
> `InitialNoteSection`, bound to the existing `organisationNotes` field, not
> a new one), and First next action + due date. Requirement/commercial
> potential/procurement/evidence sections were removed from the Prospect
> workspace entirely — the fields and their components (`RequirementSection`,
> `CommercialPotentialSection`, `ProcurementSection`, `EvidenceSection`,
> `OrganisationResearchSection`) are untouched and still fully live in the
> Active Lead workspace's "Supporting details" — nothing was deleted, only
> hidden from Prospect Setup, per the task's own "move out of the Prospect
> UI rather than deleting" instruction. **"Start Working Lead" (was "Activate
> Lead") is now a real, functional action** — `services/leadReadiness.js`'s
> checklist was cut from 7 items to exactly 5 (identity, Lead Source, owner,
> first next action, follow-up date); phone/email/website are no longer part
> of it at all (verified live: a Prospect with zero contact info and a next
> action of "Research contact details" starts working successfully), and an
> unreviewed possible duplicate is now informational only (still surfaced in
> the response, never blocks). Lead Source vocabulary
> (`lib/leadQualification.js`'s `SOURCES`, mirrored server-side by
> `models/CMS_Models/Sales/Lead.js`'s inline enum) gained
> `google`/`linkedin`/`directory`/`field_visit` and relabeled
> `website`→"Website Enquiry"/`trade_show`→"Exhibition" — additive only, no
> code removed, no migration. Terminology renamed in user-facing text only:
> Draft Lead→Prospect, My Drafts→My Prospects, Save Draft→Save Prospect,
> Preparing this Lead→Prospect Setup, Activate Lead→Start Working Lead.
> **No Account, Contact or Sales Journey is created anywhere in this chunk.**
> No dependency, migration, seed or Git setting was changed. **Nothing was
> committed.** Full file list and verification in Part 8 below.
>
> Earlier records below: Part 2 the Sales Journey foundation, Part 3 the
> lifecycle-spine redesign, Part 4 the rejected worklist pass, Part 5 the
> shared Journey shell + eight stages, Part 6 the first Journey frontend
> build, Part 7 CRM Step 01, Part 8 this session (Prospect capture chunk;
> also documents the Draft Lead chunk, Lead frontend correction, and Lead
> correction chunk sessions that happened in between Part 1 and this one,
> which were never separately recorded here).

---

# Part 1 — Lead Chunk 1: foundation and boundary hardening (this session)

Implements `docs/tasks/lead-chunk-01-foundation.md` (copied into
`docs/tasks/current-task.md` for this session) in `grav-cms-backend` only.
Per ADR-002 and `docs/tasks/lead-to-journey-roadmap.md`, this is Chunk 1 of 6
— backend/data-contract work only. **Chunk 2 (Lead Inbox redesign) was not
started. Lead conversion (Account/Contact/Journey creation) was not
implemented.** No frontend file was touched.

**This session has two passes.** The first pass (below, "the original
design") added `qualificationState` as a field genuinely independent of
`stage` — two fields, only one exposed to new writes, but still two things
that could in principle drift. Review found that insufficient: bullet 4 of
the review (`docs/tasks/lead-chunk-01-foundation.md` §3's own requirement,
restated explicitly) called for `stage` and `qualificationState` to be
incapable of contradicting each other, not merely unlikely to. **The second
pass — this handoff's authoritative description — replaced "one field is the
only writer" with "one FUNCTION is the only writer for both fields, called
from every entry point."** See "Revision after review" below for the full
list of behavioural changes; the original-design section is kept for context
on what changed and why, not as a description of current behaviour.

## What this chunk does

The existing `Lead` model had three problems named directly in the task: an
unsafe `countDocuments() + 1` reference generator, a `stage` enum that
overlaps the Sales Journey lifecycle (`proposal_sent`/`negotiation`/`won`),
and an embedded `activities[]` timeline duplicating the shared `CRMActivity`
architecture. This chunk fixes the first; replaces the second with a single
shared transition service (`services/leadQualification.js`) that is the only
code allowed to write either `stage` or `qualificationState`, anywhere in the
codebase; and adds a canonical, CRMActivity-backed path for the third
alongside the legacy embedded array, which remains readable but is no longer
written to by anything this chunk touches. Nothing existing was deleted or
migrated.

## Revision after review — what changed from the original design

The original design (kept in `git diff` history for this session) treated
`stage` as a free-form field still directly writable by
`PATCH /:id/stage`, the generic `POST /`/`PATCH /:id`, and
`routes/CMS_Routes/Sales/callSchedule.js`, on the reasoning that touching any
of those risked breaking a caller this backend-only chunk had no way to
verify. Review rejected that reasoning: "no way to verify" is not the same as
"safe," and the specific gaps it left (new `proposal_sent`/`negotiation`/
`won` assignments still possible; `stage` and `qualificationState` editable
independently; Call Planner still writing the embedded array and faking
conversion) were exactly the two-state-machine problem ADR-002 exists to
prevent. Fixed as follows:

1. **`services/leadQualification.js` (new)** is now the ONLY code that writes
   `Lead.stage` or `Lead.qualificationState`. Three functions:
   - `applyQualificationTransition(lead, {qualificationState, reason, actor})`
     — the canonical move. Validates the enum, refuses `converted`, refuses
     any move once already `converted`, checks the explicit transition graph
     (`LEAD_QUALIFICATION_TRANSITIONS` in `constants/crm.js`, next section),
     requires a reason where needed, then sets `qualificationState` AND
     derives `stage` from it (`deriveLegacyStage`) in one place. Used
     directly by `PATCH /:id/qualification-state`.
   - `applyLegacyStageChange(lead, {stage, reason, lostReason, actor})` — the
     legacy-compatible wrapper, used by `PATCH /:id/stage`, the generic
     `PATCH /:id` (when `stage` changes), and `callSchedule.js`. Returns
     `false` (no mutation) when the submitted `stage` already equals the
     Lead's current `stage` — "an existing legacy record submits its
     unchanged stage while editing another field" is a no-op, not a
     transition attempt. Otherwise resolves the legacy value through
     `resolveLegacyStageRequest` (below) and calls
     `applyQualificationTransition`.
   - `resolveInitialQualification(stageInput, {reason, lostReason})` — Lead
     **creation** only. Not a transition (no prior state exists), so it is
     NOT checked against the transition graph — it only validates the legacy
     mapping/blocklist and any required reason. Called by `POST /`
     **before** the document exists, so an invalid initial stage creates
     nothing.
   - `resolveLegacyStageRequest(stage, {reason, lostReason})` — the shared
     legacy→canonical translation: `new/contacted/qualified` map 1:1;
     `lost` maps to `disqualified` (reason required, also mirrored onto the
     legacy `lostReason` field for any old reader); `proposal_sent`,
     `negotiation`, `won` throw outright — see next point.
2. **`proposal_sent`, `negotiation`, `won` can no longer be assigned by ANY
   write path** — `POST /`, `PATCH /:id`, `PATCH /:id/stage`, and
   `callSchedule.js`'s `POST /:id/complete` all reject them with a 400
   explaining that those outcomes now belong to the Sales Journey. Existing
   records that already carry one of these values from before this chunk are
   completely unaffected — nothing migrates, nothing is rewritten.
3. **The "won ⇒ probability 100 / convertedToCustomer / convertedAt" side
   effect is deleted, not just made unreachable.** It existed in three
   places (`PATCH /:id/stage`, `callSchedule.js`); all three now go through
   `applyQualificationTransition`, which never touches those legacy fields.
4. **Neither `PATCH /:id/stage` nor `POST /:id/activity` (singular, legacy)
   appends to the embedded `lead.activities[]` anymore.** `/:id/stage`'s only
   remaining job is the state change, audited via `recordChange` like every
   other Lead mutation. `POST /:id/activity` (a follow-up fix — the first
   revision left it appending to the embedded array on the reasoning that
   nothing calls it) now translates its legacy request shape
   (`{type, title, description, scheduledAt, outcome}`) into a shared
   `CRMActivity`, the same as the plural endpoint, with a backward-compatible
   response (`lead` still returned; `activity` added alongside it).
5. **`callSchedule.js`'s `POST /:id/complete` was rewritten**, then further
   corrected in the follow-up fix — see its own section below. It now logs
   every completed call as a `CRMActivity` (`leadId`-owned) instead of the
   embedded array, and routes any `newLeadStage` through
   `applyLegacyStageChange`. The follow-up fix corrected two bugs in that
   rewrite: the audited `before` snapshot was being captured AFTER
   `lastContactedAt`/`nextFollowUpAt` were already mutated in memory (so it
   never reflected a real "before"), and a rejected `newLeadStage` (e.g.
   `won`) was still being written onto the `CallSchedule` record even though
   the Lead transition itself was refused.
6. **`Activity.js`'s ownership guard now rejects BOTH `accountId` and
   `leadId` being set**, not just neither.
7. **`routes/CMS_Routes/Sales/activities.js` (the Account-scoped router) now
   whitelists create/update fields** — `leadId` is not in either list, so
   that router can never create or edit a Lead-owned Activity, and
   `activityId`/`isActive`/`archivedAt`/`archivedBy`/`createdBy`/`updatedBy`
   (and, on update, `accountId` itself) are all server-controlled.
8. **`POST /:id/activities` (plural, canonical, on the Lead router) now
   accepts `outcome`, `nextActionDate` and `activityDate`** — the interaction
   metadata the Account-Activity router already supports, missing from the
   first pass.

## Model changes — `models/CMS_Models/Sales/Lead.js`

| Change | Detail |
|---|---|
| `leadId` | `required, unique, immutable`. No auto-generating pre-save hook — always allocated by `services/leadRef.js` **before** `Model.create()`, mirroring `SalesJourney.journeyId`. The only call site (`leads.js` `POST /`) resolves an initial `{qualificationState, stage}` pair via `resolveInitialQualification` first, so an invalid request creates nothing. |
| `qualificationState` | **Canonical.** Enum `new, contacted, qualified, readyToConvert, nurture, disqualified, duplicate, converted` (codes verbatim from the task spec — camelCase, documented exception in `constants/crm.js`). Default `"new"`. Every change validated against `LEAD_QUALIFICATION_TRANSITIONS` — see below. |
| `qualificationReason` | Free text, required by `services/leadQualification.js` when `qualificationState` is `disqualified`/`duplicate`. |
| `requirementReceivedAt` | Qualification-evidence timestamp placeholder. Not auto-set — Chunk 3's qualification workspace is the expected writer. |
| `conversion.{accountId,contactId,journeyId,convertedAt,convertedBy}` | Canonical placeholders. Fully unset — no conversion endpoint exists. Chunk 5 is the only future writer. |
| `normalizedCompany`, `emailDomain`, `normalizedPhone`, `websiteDomain` | Duplicate-detection foundations (§7). Derived on save. No matching UI, no auto-merge. |
| `createdBy`, `updatedBy`, `archivedAt`, `archivedBy` | Audit actors, matching the `actorRef` shape in `Activity.js`/`SalesJourney.js`. Server-assigned only. |
| `stage` | LEGACY enum, unchanged shape. **Read-only from every code path in the codebase except `services/leadQualification.js`** — see next section. Existing records that already carry `proposal_sent`/`negotiation`/`won`/`lost` from before this chunk remain fully readable; nothing migrates. |
| `activities[]`, `convertedToCustomer`, `convertedCustomerId`, `convertedAt` | LEGACY, unchanged shape, read-only from every code path added or touched by this chunk. |

**Indexes:** `{isActive,assignedTo,updatedAt}`, `{qualificationState}`,
`{normalizedCompany}`, `{emailDomain}`, `{normalizedPhone}`,
`{websiteDomain}`, `{nextFollowUpAt}`, `{"conversion.accountId"}`,
`{"conversion.journeyId"}` — only what the roadmap's Lead Inbox/qualification
access patterns need; no speculative Journey-stage indexes.

## The shared transition service — `services/leadQualification.js` (new)

This is the file that actually resolves review item 1. Full design and
rationale is in the file's own header comment; the operative facts:

- **Every writer of `Lead.stage` or `Lead.qualificationState` in the
  codebase calls into this file.** `routes/CMS_Routes/Sales/leads.js` (four
  call sites: create, generic update, `/stage`, `/qualification-state`) and
  `routes/CMS_Routes/Sales/callSchedule.js` (one call site). There is no
  other write path left — grepped to confirm.
- `LEAD_QUALIFICATION_TRANSITIONS` (in `constants/crm.js`) is the explicit
  graph from review item 2, reproduced exactly:
  ```
  new            → contacted | nurture | disqualified | duplicate
  contacted      → qualified | nurture | disqualified | duplicate
  qualified      → readyToConvert | nurture | disqualified | duplicate
  readyToConvert → nurture | disqualified | duplicate
  nurture        → contacted | qualified | disqualified | duplicate
  disqualified   → (terminal — empty)
  duplicate      → (terminal — empty)
  converted      → (unreachable — reserved for the conversion service)
  ```
  `isValidTransition(from, to)` reads directly from this map — `test/crm/
  lead.test.js` pins the map's exact shape, and `test/crm/lead.route.test.js`
  exercises the happy path, both backward-illegal moves
  (`readyToConvert → qualified`/`contacted`), `nurture`'s two re-entry
  points, and both terminal states refusing every further move, including
  re-entering themselves.
- `LEGACY_LEAD_STAGE_TO_QUALIFICATION` (`new/contacted/qualified/lost` only)
  and `BLOCKED_LEGACY_LEAD_STAGES` (`proposal_sent/negotiation/won`) are the
  legacy-compatibility half. `lost` → canonical `disqualified`, reason
  required, mirrored onto the legacy `lostReason` field too. The blocked
  three throw a 400 naming the Sales Journey as where those outcomes now
  live.
- `LEAD_QUALIFICATION_TO_LEGACY_STAGE` is the reverse projection
  (`deriveLegacyStage`) that keeps `stage` in sync with every canonical
  change, including ones made directly through
  `PATCH /:id/qualification-state` — `nurture` is the one deliberate
  exception, left as a pass-through of whatever `stage` already was, since
  it has no legacy funnel equivalent.
- An unchanged `stage` resubmission (`stage === lead.stage`) is a **no-op**,
  not a transition attempt — this is what makes the grav-cms Edit Lead
  modal's habit of resubmitting the whole form (including an untouched
  `stage`) safe without needing any frontend change.

## Reference generator — `services/leadRef.js` (new file, unchanged from the first pass)

Same atomic pattern as `services/salesJourneyRef.js`
(`findOneAndUpdate({$inc},{upsert:true})` on a per-year counter document),
producing `LEAD-YYYY-NNNN`. **`salesJourneyRef.js` was not modified.**
`leadRef.js` imports and reuses its exported `Counter` model — one atomic-
counter collection (`crm_sequences`), not two parallel implementations —
under a disjoint key namespace (`lead:<year>` vs. `salesJourney:<year>`).
This sharing is covered by a regression test (`test/crm/lead.test.js`,
"regression: allocating Lead references does not disturb Journey reference
sequencing"). `createWithRef(Lead, payload)` retries onto the next number on
a duplicate-key error, mirroring the Journey service. A pre-existing
legacy-format `leadId` (`LEAD-0001`, no year segment, from before this
chunk) remains readable — verified with a raw-insert test.

## CRM Activity ownership — `models/CMS_Models/Sales/Activity.js`

`accountId` is field-optional; a new `leadId` (→ `Lead`) field lets an
Activity be Lead-owned instead. The pre-validate hook now enforces **exactly
one** of `accountId`/`leadId` — review item 4 tightened this from the first
pass's "at least one": both being set is now rejected too (`"A CRM Activity
cannot belong to both an Account and a Lead at the same time."`), not only
neither. `{leadId, activityDate: -1}` index added for the Lead timeline
query. `activityId` generation (`countDocuments()+1`) is unchanged — out of
this chunk's scope.

**`routes/CMS_Routes/Sales/activities.js` (the Account-scoped router) — new
in this revision.** Previously spread `req.body` directly into
`Activity.create()`/`findByIdAndUpdate()`, which meant a client could inject
`leadId` (creating a dual-owned Activity before the model guard existed) or
overwrite `activityId`/`isActive`/`archivedAt`/`archivedBy`/`createdBy`/
`updatedBy`. Now whitelists: `ACCOUNT_ACTIVITY_CREATE_FIELDS` includes
`accountId`; `ACCOUNT_ACTIVITY_UPDATE_FIELDS` does not (ownership is
immutable after creation). **`leadId` is in neither list** — this router can
never create or edit a Lead-owned Activity, full stop. Regression-tested:
ordinary Account-activity create/update still work exactly as before.

## Lead API — `routes/CMS_Routes/Sales/leads.js` (revised)

- `POST /` — whitelists business fields (`LEAD_EDITABLE_FIELDS`, `stage`
  removed from the list — see below), resolves any submitted `stage` via
  `resolveInitialQualification` **before** calling `createWithRef`, so an
  invalid stage (blocked value, or a missing required reason) creates
  nothing. Server-assigns `createdBy`/`updatedBy`.
- `PATCH /:id` — same whitelist. A `stage` key in the body is handled
  separately: unchanged is ignored, changed is routed through
  `applyLegacyStageChange` (same validation as `/:id/stage`, so the two
  endpoints can never disagree). `qualificationState` remains fully outside
  the whitelist regardless — "converted cannot be faked through a generic
  patch" is enforced independently of the stage handling.
  `probability`/`estimatedValue`/etc. remain ordinary whitelisted business
  fields, unrelated to the state machine.
- `PATCH /:id/stage` — now a thin wrapper over `applyLegacyStageChange`.
  Same request shape (`{stage, lostReason}`, `reason` also now accepted) and
  response shape as before, but: no longer writes `stage` directly (derived
  by the shared service instead), no longer produces the `probability=100`/
  `convertedToCustomer`/`convertedAt` side effect on `"won"` (removed
  entirely — `"won"` is rejected outright now), and no longer appends to the
  embedded `activities[]` (the change is audited via `recordChange` only).
- `PATCH /:id/qualification-state` — now calls `applyQualificationTransition`
  directly rather than re-implementing the same validation inline, so there
  is exactly one implementation of the transition rules in the codebase.
- `POST /:id/activities` (plural) — now also accepts `outcome`,
  `nextActionDate`, `activityDate` (previously silently dropped — a real gap
  flagged by review item 5; `test/crm/lead.route.test.js`'s "logs a completed
  interaction..." test now asserts `outcome` round-trips through both the
  response and a direct re-read of the stored document).
- `POST /:id/activity` (singular, legacy) — **follow-up fix.** No longer
  appends to the embedded `activities[]`. Translates its legacy request
  shape (`{type, title, description, scheduledAt, outcome}`) into a shared
  `CRMActivity`, via `LEGACY_LEAD_ACTIVITY_TYPE_TO_CRM` (the legacy
  `call/email/meeting/note/status_change/task` vocabulary mapped onto
  CRMActivity's `activityType` codes — `email→email_log`,
  `status_change→other`, the rest 1:1). Response stays backward-compatible:
  `lead` is still returned (its `activities[]` simply no longer grows);
  `activity` is added alongside it, additive only. `lastContactedAt` is
  still bumped, and both the new `CRMActivity` and the Lead update are
  audited.
- `DELETE /:id` — unchanged from the first pass (`archivedAt`/`archivedBy`
  stamped, `recordChange` uses `action: "delete"` since `"archive"` is not
  in the shared `ChangeLog.action` enum — noted as a pre-existing,
  out-of-scope gap also present in `accounts.js`).
- Role + write-approval enforcement unchanged: `/api/cms/crm/leads` was
  already mounted behind `salesWrites("lead")` in `server.js` before this
  chunk; `server.js` is not touched.

## Call Planner — `routes/CMS_Routes/Sales/callSchedule.js` (revised — was "left unchanged" in the first pass; review rejected that)

`POST /:id/complete`'s Lead-facing behaviour:

- **Every completed call against a Lead now creates a `CRMActivity`**
  (`leadId`-owned, `activityType: "call"`, `status: "completed"`, `outcome`
  copied through) instead of pushing into `lead.activities[]`. Pre-existing
  embedded entries from before this chunk are completely untouched — nothing
  reads, migrates, or deletes them; a dedicated test asserts an old entry
  survives a new completion unchanged.
- An optional `newLeadStage` is passed to `applyLegacyStageChange` — the
  SAME function `leads.js` uses, so Call Planner cannot assign
  `proposal_sent`/`negotiation`/`won`, cannot fake a conversion (the
  probability/convertedToCustomer side effect is gone here too), and cannot
  produce a `stage`/`qualificationState` disagreement with what `leads.js`
  would have done for the identical request.
- **The call completion itself never fails because of an invalid stage
  request.** `schedule.save()` and the new `CRMActivity` are unconditional;
  only the stage portion is wrapped in its own try/catch, reported back as
  `leadUpdate: { applied: false, message }` in the response rather than
  surfacing as an overall 400 — a rejected stage should not make the
  salesperson's "mark this call done" action fail. `lastContactedAt`/
  `nextFollowUpAt` are updated regardless.
- `lost` maps to canonical `disqualified`; the reason is an explicit
  `reason` field if present, else `feedbackNotes` (the free-text field this
  endpoint already collects on every completion).

**Follow-up fix, on top of the above.** Two bugs survived the initial
rewrite:

- The audited `before` snapshot was captured via `lead.toObject()` **after**
  `lead.lastContactedAt`/`lead.nextFollowUpAt` had already been reassigned in
  memory, so the recorded "before" silently matched "after" for those
  fields — the audit trail understated what changed. Fixed by capturing
  `before` at the very top of the Lead-side block, before any field is
  touched.
- When no stage change was requested (or it was a no-op), the branch called
  `lead.save()` with **zero** audit logging at all, even though
  `lastContactedAt` always changes on every completion. Fixed: the Lead-side
  block now does exactly one `lead.save()` and always records exactly one
  Lead `recordChange` call, with a summary that reflects a stage change when
  one applied and a generic "updated via call completion" otherwise.
- `schedule.newLeadStage` was being set and saved **before** the Lead
  transition was even attempted, so a rejected request (e.g. `won`) still
  left `newLeadStage: "won"` sitting on the `CallSchedule` record — looking,
  to anyone reading that record later, like it had taken effect. Fixed: the
  schedule's core completion fields save first (so the call always completes
  even if the Lead-side logic throws), and `newLeadStage` is only written —
  via a small second save — once `applyLegacyStageChange` has actually
  succeeded.

## Constants — `constants/crm.js`

First pass added `LEAD_QUALIFICATION_STATES`/`_STATE_CODES`,
`LEAD_QUALIFICATION_REASON_REQUIRED`, `LEAD_QUALIFICATION_RESERVED_STATES`,
and a `lead_qualification_state` `LOOKUP_CATEGORIES` entry. This revision
adds `LEAD_QUALIFICATION_TRANSITIONS` (the explicit graph),
`LEGACY_LEAD_STAGE_TO_QUALIFICATION`, `BLOCKED_LEGACY_LEAD_STAGES`, and
`LEAD_QUALIFICATION_TO_LEGACY_STAGE` — all consumed exclusively by
`services/leadQualification.js`. Purely additive; no seed run;
`/api/cms/crm/lookups` still serves the already-seeded DB collection and
won't reflect the new category until someone deliberately reseeds (out of
scope).

## Files changed (this revision, on top of the first pass)

**New:**
- `services/leadQualification.js`
- `test/crm/call-schedule.route.test.js`
- `test/crm/activities.route.test.js`

**Modified again:**
- `constants/crm.js` (additions)
- `models/CMS_Models/Sales/Lead.js` (header comments corrected to describe the shared-service design; the `activities[]` field comment corrected for the `POST /:id/activity` follow-up fix)
- `models/CMS_Models/Sales/Activity.js` (XOR, not "at least one")
- `routes/CMS_Routes/Sales/leads.js` (stage handling rewritten around the shared service; follow-up fix: `POST /:id/activity` now writes shared `CRMActivity`)
- `routes/CMS_Routes/Sales/activities.js` (field whitelist — newly touched this revision)
- `routes/CMS_Routes/Sales/callSchedule.js` (newly touched this revision; follow-up fix: correct `before` snapshot, single save/audit, conditional `newLeadStage` persistence — see above)
- `test/crm/lead.test.js` (both-owner-rejection test, transition-map data-structure tests)
- `test/crm/lead.route.test.js` (stage/qualification-state test sections substantially rewritten; follow-up fix: `POST /:id/activity` test section rewritten for the new CRMActivity-backed behaviour)
- `test/crm/call-schedule.route.test.js` (follow-up fix: added before-snapshot-correctness, single-audit, and newLeadStage-persistence tests)
- `docs/handoff/latest-implementation.md` (this file)

**Still not touched:** `services/salesJourneyRef.js`,
`models/CMS_Models/Sales/SalesJourney.js`,
`routes/CMS_Routes/Sales/salesJourneys.js`, `server.js`, every `grav-cms`
frontend file, every Sales Journey stage page/component.

## Tests and exact results

`npx jest test/crm` — focused CRM suite only, no migrations or seeds run:

```
Test Suites: 14 passed, 14 total
Tests:       184 passed, 184 total
Time:        ~6–7s
```

Of the 184 tests, **105 are pre-existing and entirely untouched by Lead
Chunk 1** (10 suites — Account/Contact/Sales-Journey/etc. — confirming zero
regressions), and **79 belong to Lead Chunk 1**, across 4 suites:

| Suite | Tests | Status |
|---|---|---|
| `test/crm/lead.test.js` | 23 | unchanged this follow-up |
| `test/crm/lead.route.test.js` | 41 | follow-up fix: `POST /:id/activity` test section rewritten (net +3) |
| `test/crm/call-schedule.route.test.js` | 10 | follow-up fix: +3 tests (before-snapshot correctness, single-audit, newLeadStage persistence) |
| `test/crm/activities.route.test.js` | 5 | unchanged this follow-up |
| **Lead Chunk 1 total** | **79** | |
| **Pre-existing (unchanged)** | **105** | 10 suites |
| **Grand total** | **184** | 14 suites |

Coverage highlights added by this follow-up fix, on top of everything the
prior revision already had: `POST /:id/activity` (singular) creating a
`CRMActivity` rather than growing the embedded array, its backward-compatible
response, its legacy-type-to-CRMActivity-type mapping, and existing embedded
entries surviving untouched; Call Planner's `recordChange` `before` snapshot
proven correct with a concrete pre-set `lastContactedAt` that must NOT equal
`after`; exactly one Lead audit firing even when no stage change is
requested; and a rejected `newLeadStage` confirmed absent from the persisted
`CallSchedule` record while a successful one is confirmed present.

## Known integration limitations (revised)

- **Call Planner is no longer a blocker — it was fixed this revision.** The
  first pass's handoff flagged it as unsafe to touch without frontend
  visibility; review concluded that reasoning didn't hold, since the fix
  needed (route through the same shared service, log via CRMActivity) is
  entirely a backend contract change that preserves the response shape
  (`{success, schedule, leadUpdate}` — `leadUpdate` is new but additive) and
  degrades gracefully (an invalid stage request no longer fails the whole
  call-completion action). Frontend behaviour on a rejected `leadUpdate` is
  still unverified (no frontend visibility in this chunk) — if the Call
  Planner UI currently assumes `newLeadStage` always applies, it may need a
  small adjustment in Chunk 2/3 to surface `leadUpdate.applied === false`.
- **The current Sales Leads UI is a real, accepted UX regression until
  Chunk 2.** `grav-cms/app/sales/dashboard/leads/page.js`'s Kanban board
  lets a user drag a card to "Won" or "Proposal Sent" — that action now
  receives a 400 from the backend (previously it silently overloaded
  `stage`/`probability` with no server validation at all). This is the
  direct, intended consequence of review item 1 ("Generic create/update must
  not create new proposal_sent/negotiation/won assignments"), not an
  oversight — the frontend was read but cannot be changed in this
  backend-only chunk. Chunk 2 replaces this page with a
  `qualificationState`-driven Lead Inbox.
- `activityId` on `CRMActivity` still uses `countDocuments()+1` — out of
  scope, unchanged from the first pass's note.
- `ChangeLog.action` enum gap (`"archive"` not in the enum) — unchanged from
  the first pass's note, still pre-existing/out-of-scope.

## Confirmation

- **Chunk 2 (Lead Inbox redesign) was not started.** No frontend file in
  `grav-cms` was created, edited, or deleted.
- **Lead conversion was not implemented.** No Account, Contact, or
  SalesJourney document is created, read, or referenced as a side effect by
  any code in this chunk. `conversion.*` remains fully unset.
- **The Sales Journey model, API, Progress Spine and stage pages are
  functionally unchanged** — `services/salesJourneyRef.js`,
  `models/CMS_Models/Sales/SalesJourney.js`, and
  `routes/CMS_Routes/Sales/salesJourneys.js` were not edited; the full
  `sales-journey.test.js`/`sales-journey.route.test.js` suites pass
  unmodified (confirmed again after this revision).
- **No dependency, migration, seed, or Git setting was changed.**
- **Nothing was committed or staged.** `git status` at the end of this
  session shows only the files listed above as modified/untracked, plus
  whatever was already uncommitted before this session began.

---

# Part 2 — Sales Journey foundation (previous session)

Implements `docs/tasks/sales-journey-foundation.md` across
`grav-cms-backend` and `grav-cms`.

## What now works end to end

1. A salesperson opens **Sales Journeys** and sees live records (an honest
   empty state when there are none).
2. **Start Journey** opens a drawer, searches the real Account library,
   and creates a real `SalesJourney` with a server-assigned `SJ-YYYY-NNNN`.
3. An optional first next action becomes a real linked `CRMActivity` task.
4. The new Journey appears on the Progress Spine and opens at
   `/sales/dashboard/journeys/{journeyId}/account` with live Account data.
5. Later stages render honest empty/preview states — no fabricated detail.

## Backend

### Model — `models/CMS_Models/Sales/SalesJourney.js`

Registered as `SalesJourney`. The header comment states what the record is
**not**, because every field depends on it: not a customer master, not a
contact store, not a task system, not an Order, not a container for
later-stage data.

| Group | Fields |
|---|---|
| Identity | `journeyId` (unique, **immutable**, the route key), `name`, `accountId` → `CRMAccount` (required), `businessType`, `requirementRef` |
| Parties | `parties.{buyingHouse,brand,poIssuer,billTo,consignee,importer,agent}AccountId` — every one a `CRMAccount` ref, **no fallback name strings** |
| People | `primaryContactId` → `CRMContact`; `ownerId`/`ownerName` (required), `merchandiserId`/`merchandiserName` |
| Lifecycle | `currentStage`, `stageStates` (all eight), `risk`, `riskReason`, `businessStatus` |
| Timing / commercial | `targetDate.{label,date}`, `expectedValue.{amount,currency,confirmed}` |
| Next action | `currentNextActionId` → `CRMActivity` — a **pointer**, nothing duplicated |
| Audit | `createdBy`, `updatedBy`, `archivedAt`, `archivedBy`, `isActive`, timestamps |

`stageStates` is **built from the stage list**, not typed out, so a stage added
to `constants/crm.js` cannot be silently missing. A new Journey opens
`currentStage: account`, `stageStates.account: inProgress`, every later stage
`notStarted`, `risk: onTrack` — selecting an Account deliberately does **not**
mark the Account stage complete.

**Indexes** (the Hub's real access patterns, not speculative ones):

```
{ journeyId: 1 }  unique          { isActive, ownerId, updatedAt: -1 }
{ accountId: 1 }                  { isActive, accountId, updatedAt: -1 }
{ currentStage: 1 }               { isActive, currentStage, risk }
{ risk: 1 }  { isActive: 1 }      { isActive, "targetDate.date": 1 }
{ currentNextActionId: 1 }
```

**Virtuals, never stored:** `currentStageState`, `waitingOn` — a stored copy
goes stale the moment a stage state changes.

### Reference generation — `services/salesJourneyRef.js`

The task forbade `countDocuments() + 1`, and rightly: the reference is the
**route key**, so a collision is two customers' work at one URL.

`findOneAndUpdate({ $inc }, { upsert: true })` on a per-year counter document
(`crm_sequences`, key `salesJourney:2026`) is atomic in MongoDB. The unique
index on `journeyId` is the backstop, with a bounded 5-attempt retry for the
case where a counter is restored from a stale backup. Sequences restart at
`0001` each January with no reset job.

> **Note, not changed:** `CRMActivity.activityId` still uses the unsafe
> `countDocuments() + 1` pattern. It is pre-existing, affects all Activity
> creation, and fixing it is a separate change with its own blast radius.

### Vocabulary — `constants/crm.js`

Added `SALES_JOURNEY_STAGES / STAGE_STATES / RISKS / BUSINESS_TYPES` and
`SALES_JOURNEY_LINK_MODULE = "sales-journey"`.

**These are camelCase while every other vocabulary here is snake_case.** That
is a considered exception, documented inline: the frontend's `stageConfig.js`
already declares itself the single naming source of truth and its keys are
load-bearing in eight stage components, the spine, the fixtures and the tone
maps. Snake_case codes would have meant a translation layer between two
vocabularies for the same eight concepts. **Renaming a stage means editing both
files; neither is authoritative alone.**

Nothing was added to `LOOKUP_CATEGORIES`, so **no lookup seed run is required**.

### API — `routes/CMS_Routes/Sales/salesJourneys.js`

Mounted in `server.js` at `/api/cms/crm/sales-journeys` behind
`salesWrites("sales journey")`, the same guard as every other CRM router.

| Endpoint | Behaviour |
|---|---|
| `GET /` | Pagination, search (Journey ref/name/requirementRef **and** the customer's name/code), filters for account, owner, stage, stage-state, risk, business type, waiting-on, commercial range. Returns a purpose-built summary DTO. |
| `GET /:journeyId` | **Keyed on the human reference.** Adds resolved parties and contact. 404 for unknown. |
| `POST /` | Creates the Journey and, optionally, one linked `CRMActivity`. |

**Two things the client is never trusted with**, both tested:

1. **My-work scope** comes from the session. `?scope=mine&owner=<someone-else>`
   still returns the caller's own work. (An explicit `owner` *filter* on team
   scope is allowed — filtering to a colleague is not impersonation.)
2. `journeyId`, `createdBy`, `updatedBy`, `currentStage` and `stageStates` are
   all server-assigned. A client cannot start a Journey at Production.

**Validation:** Account exists and is tradeable (`archived`/`inactive`/`blocked`
refused); Contact must belong to the selected Account; every commercial party
must exist and be active; business type, dates and amounts checked.

**Dates go out as real ISO dates.** No relative text is ever stored or sent —
`"in 3 days"` is derived client-side against one `now`, which is the only way
it stays true past midnight.

### Permissions and audit

`expectedValue` is **removed from the response**, not blanked, via
`stripJourneyCommercial` / `stripJourneyCommercialList` added to the existing
`services/crmVisibility.js`. It reuses `canViewCredit` (admin/ceo, or
department approver/owner) so a Journey hides exactly what an Account hides.
The **value-range filter is also ignored** for unauthorized callers, so it
cannot be used to binary-search a value they may not read.

`recordChange(...)` audits both the Journey create and the Activity create.

### Activity integration

When a first action is supplied, one `CRMActivity` is created with
`activityType: "task"`, `status: "planned"`, the Journey's owner, the chosen due
date, and `links: [{ module: "sales-journey", recordId: <journey._id> }]` — the
forward-link hook the Activity model was designed for. The Journey stores only
`currentNextActionId`. **Nothing about the task is duplicated on the Journey.**

**Partial failure is reported, never swallowed.** If the Journey saves and the
task does not, the response is `201` with a `warning` field, `currentNextActionId`
is left unset, and the drawer surfaces the warning instead of a clean success.
(Sequential rather than transactional: the in-memory test Mongo is a standalone
without replica-set transactions. Documented as a limitation below.)

## Frontend

### Fixture-to-live cutover

| Function | Before | After |
|---|---|---|
| `loadHubSummaries` | fixtures | `GET /sales-journeys` |
| `loadJourney` | fixtures | `GET /sales-journeys/:journeyId`, 404 → real not-found |
| `loadJourneysForAccount` | fixtures | `GET /sales-journeys?accountId=` |
| `createJourney` | did not exist | `POST /sales-journeys`, held/warning aware |
| `loadStage` (7 preview stages) | fixtures | **unchanged** — still fixtures |

`JOURNEY_RECORD_MODE` flipped to `live` in `capabilities.js`. The **seven later
stages keep their own `prototype` flags**, so a real Journey still shows honest
preview/empty states past Account.

**The fixture boundary is now structural, not a comment.** Every sample journey
was re-keyed `SJ-2026-0042` → `DEMO-0042`. The reason is concrete: the backend
mints `SJ-YYYY-NNNN` from `0001`, so a live Journey would eventually have been
issued `SJ-2026-0038` and **silently inherited the fixture's production data**.
`DEMO-` makes that collision impossible and makes a sample record unmistakable
in a screenshot. The dead fixture-hydration path (`summarizeJourney`,
`resolveParty`, `accountIndex`, `journeyById`) was removed from the adapter.

### Start Journey — `components/sales/crm/journey/StartJourneyDrawer.js`

Reuses `CrmDrawer` (Escape, focus trap, initial focus, focus restoration), the
Primitives, and `crmApi` through the adapter. **No second API client and no
second Account picker.**

Fields: Account (searched through the existing `/accounts` endpoint, never
preloaded; code shown beside name), Journey name (suggested from the Account,
free to edit, stops suggesting once touched), business type, requirement/RFQ
reference, primary contact (scoped to the chosen Account), then timing, value
(offered only to the commercial capability) and first action in an expandable
section.

The drawer **says what it does not do**: *"This creates the Journey itself and,
if you add one, a first task — it does not create an enquiry, style, quotation
or order."*

**Three outcomes, kept honest:**

- `201` → toast, refresh Hub, navigate to `…/{journeyId}/account`.
- `202` held → a terminal panel saying it is awaiting an approver, and
  **navigates nowhere**, because no record exists.
- `201 + warning` → reported as partial success, not a clean one.

On failure the form state is preserved and the server's own message is shown.
Duplicate submission is blocked both by the disabled button and a guard inside
the submit handler (a double Enter can fire before React re-renders).

**Owner** defaults to the signed-in user and the form says so. No safe user
picker exists to reuse, and inventing an employee-directory endpoint for one
form was out of scope — reassignment is later work.

### Hub and Account page

`Start Journey` is a real button for users with Sales editor access, and is
replaced by *"Creating a Journey needs Sales editor access."* otherwise. The
preview tag is gone from the result count — the data is real. The page is
wrapped in `ToastHost` so the drawer's notifications actually surface.

The Account workspace gained a **Sales Journeys** rail group listing that
account's journeys with stage position, linking into each. It queries by
indexed `accountId`; **no `journeyIds[]` array was added to Account**, so the
two records cannot maintain competing relationship lists.

## Verification performed

### Backend — `npx jest test/crm`

```
Test Suites: 10 passed, 10 total
Tests:      105 passed, 105 total
```

**45 of those are new**, across two suites:

`test/crm/sales-journey.test.js` (23) — model and services: sequence allocation,
**25 concurrent allocations with zero collisions**, 10 concurrent creates all
persisting distinct references, per-year scoping, reference immutability, stage
defaults, enum rejection, derived virtuals absent from the raw document, **no
copy of the customer's name in the stored document**, the Activity link pointing
both ways, commercial stripping, and the Hub's query shapes.

`test/crm/sales-journey.route.test.js` (22) — real HTTP against the router on an
ephemeral port (no supertest in this repo and no dependency added; Express +
Node's global `fetch`). Covers create defaults, audit invocation, **client
cannot choose reference/stage/actor**, linked Activity, every validation
rejection, **partial-failure warning** (via a mocked Activity failure),
401 unauthenticated, scope isolation, **my-work impersonation blocked**,
filters, search across the customer's name, pagination, real dates, **expected
value absent from list *and* detail for a plain sales user**, the value-filter
ignored for unauthorized callers, detail by human reference, and 404.

### Frontend — `npm run build` ✓ compiled, 245/245 pages

Browser verification ran against the **real backend** on `:5050`.

| Check | Result |
|---|---|
| Route mounted | `GET /sales-journeys?scope=team` → `200 {success:true, journeys:[], pagination:{total:0}}` |
| **Real empty state** | Hub shows *"No sales journeys yet"* with the eight-stage lifecycle — **zero fixture journeys leaked through** |
| Permission-restricted | With no Sales role, `Start Journey` is hidden and the empty state explains why |
| Drawer opens | Renders with the scope note; keyboard reachable |
| Validation | Empty submit produced three `role="alert"` errors and **made no network call** |
| Account search | Typing "Uniform" hit the live endpoint → *"Test Uniform Client Co · ACC-0001 · active"* |
| Account selected | Name auto-suggested; contact dropdown scoped to that account's real contacts |
| Server error | Submit → `403 "You have not been given a role in this department yet."` shown in-form; **name and account preserved**, button re-enabled, drawer open |
| Escape | Closes and **restores focus to the Start Journey button** |
| Mobile 375 | Full-height sheet, all controls reachable, `scrollWidth === innerWidth` |
| Account filter | `?accountId=…` → `200`, correct filtered total |

**A committed `201` create could not be exercised over HTTP**, because the
signed-in session has no Sales department role and the write guard correctly
refuses it. I did **not** grant a role to work around this — modifying live
access-control data is well outside this task. The create path is instead
covered by the 22 route tests, which drive the same handler over real HTTP with
an injected identity.

## Known limitations

1. **Create not exercised against the live dev database** — see above. To do so,
   grant your Sales user an `editor` (or `approver`) department role, then use
   Start Journey. An editor will get the `202` held path; an approver/owner
   commits directly.
2. **Journey creation is not transactional.** Journey then Activity, sequential.
   A mid-flight failure leaves a valid Journey with no task and returns an
   explicit warning. A replica-set deployment could wrap both in a session;
   the in-memory test Mongo cannot.
3. **`CRMActivity.activityId` still uses `countDocuments() + 1`** — pre-existing,
   unsafe under concurrency, deliberately not changed here.
4. **Owner is always the creator.** No reassignment, and no merchandiser field
   in the form, until a safe user picker exists.
5. **Urgency banding is still client-side**, over a 200-row page. Fine at
   current volume; it should move server-side with the real API when volume
   justifies it.
6. **Fixture stage content is unreachable for real journeys** — a live Journey
   shows empty states on all seven later stages, which is correct and honest,
   but means the preview screens are only viewable via a `DEMO-…` URL.
7. **`GET /` caps at `limit=200`**; the Hub requests 200 and does not paginate
   in the UI yet.

## Commands you may need

```bash
npx jest test/crm            # 105 tests, from grav-cms-backend
```

No migration, no seed, and no lookup re-seed is required — the Journey
vocabulary is code-only and the model creates its own counter document on first
use.

## Files changed

**`grav-cms-backend`**

```
added     models/CMS_Models/Sales/SalesJourney.js
added     routes/CMS_Routes/Sales/salesJourneys.js
added     services/salesJourneyRef.js
added     test/crm/sales-journey.test.js
added     test/crm/sales-journey.route.test.js
modified  constants/crm.js          (journey vocabulary + exports)
modified  services/crmVisibility.js (stripJourneyCommercial helpers)
modified  server.js                 (one mount)
```

**`grav-cms`**

```
added     components/sales/crm/journey/StartJourneyDrawer.js
modified  lib/salesJourney/adapter.js            (fixtures → live, + createJourney)
modified  lib/salesJourney/capabilities.js       (JOURNEY_RECORD_MODE → live)
modified  lib/salesJourney/fixtures/journeys.js  (re-keyed DEMO-, boundary note)
modified  lib/salesJourney/fixtures/stageData.js (re-keyed DEMO-)
modified  app/sales/dashboard/journeys/page.js   (real Start Journey, ToastHost)
modified  app/sales/dashboard/accounts/[id]/page.js (Sales Journeys rail group)
```

## Confirmation

- **No later lifecycle module was implemented.** No Enquiry, Style & Sample,
  Cost & Quote, PO/Contract, Production, Shipment or Retention model, route or
  screen was created, and creating a Journey creates no later-stage record.
- **No duplication.** Journey stores no Account name, no Contact subdocument, no
  embedded task, and no Order. Verified by a test asserting the customer's name
  and code appear nowhere in the stored document.
- **No migration or seed** was written or run.
- **No dependency changed** — the route tests use Express and Node's `fetch`
  rather than adding supertest.
- **`PRODUCT.md`, `DESIGN.md` and Git settings untouched.**
- **Nothing committed.** Both trees hold their pre-existing modified/untracked
  files plus the ones listed above, confirmed by `git status --porcelain`.

---

# Part 3 — Sales Journeys as a lifecycle spine (earlier session)

## Why the previous version was rejected

> *"The current result is rejected because it remains a conventional filtered
> table with minor rearrangement. It does not visually communicate a connected
> Sales Journey or create a sufficiently intuitive, distinctive experience."*

Both prior attempts (Parts 2 and 4) rendered the lifecycle as **text in a
cell** — `"Cost & Quote · Stage 4 of 8"` — and left every other structural
decision to table convention. The stage was information the page *stated*
rather than something the page *was*.

## The shaping round

Run as `/impeccable shape`, no code written until approval. Three deliberately
non-tabular concepts were built as rendered wireframes using the real lifecycle
and the real fixture journeys, through one identical frame so the comparison
stayed about structure rather than rendering polish:

| # | Concept | Organising unit |
|---|---|---|
| 1 | **The Progress Spine** — eight stages as the page's ruler, each Journey a track measured against it | the Journey's shape |
| 2 | **The Merchandiser's Docket** — verb-first actions banded Overdue / Today / This week / Later | the next action |
| 3 | **The Account Brief** — grouped by customer, each Journey a short state-of-play in prose | the relationship |

Each carried a desktop wireframe, mobile behaviour, information hierarchy, how
the lifecycle is understood, how urgent work surfaces, how a Journey opens, and
an honest risk. **The user approved Concept 1 with Concept 2's urgency
banding**, which is what was built.

### A recorded commitment had to be reversed first

`PRODUCT.md` carried a **standing commitment** — "the category convention,
played straight", with Odoo and Zoho as the named craft bar — recorded after
the user rejected an invented layout for the sign-in portal. Its escape clause
was *"do not re-introduce a bespoke organising metaphor here without the user
asking for one."*

This request **was** the user asking for one. That was surfaced to the user
before any concept was drawn rather than silently overridden, and on approval
`PRODUCT.md` was corrected: the **craft bar stays product-wide**, the
**pattern-wins rule is now scoped to `/onboarding`**, with the reasoning and
date recorded in place. This is the only file changed outside the two component
files.

## What the page is now

The eight lifecycle stages are named **once**, as a ruler across the top. Every
Journey below is a **track** measured against that ruler, and the tracks are
grouped into urgency bands.

```
LIFECYCLE     Account  Enquiry/RFQ  Style & Sample  Cost & Quote  PO/Contract  Production  Shipment  Retention
─────────────────────────────────────────────────────────────────────────────────────────────────────────────
OVERDUE  1
Harbor & Field — AW26 Woven Shirts     ●────●────●────●────●────◉┈┈┈┈○┈┈┈┈○
SJ-2026-0038 · Northstar Buying                            [Delayed] Confirm revised ex-factory date with buyer
                                                           Vikram Shetty · 05 Aug · yesterday
TODAY  1
Southgate Hospitality — Scrubs Q3      ●────●────⊘────●────◉┈┈┈┈○┈┈┈┈○┈┈┈┈○
SJ-2026-0047 · Southgate Hospitality              [Blocked] Obtain contract variation approval
```

Four node states, and the third is the one that matters: **done** (filled),
**current** (large ringed marker, coloured by stage state), **upcoming**
(hollow, dashed connector), and **skipped** (hollow, struck through).

**Stage skipping was already in the data and previously invisible.** Two of the
five fixture journeys — Southgate's replenishment and Riverside's blazer
reorder — legitimately bypass Style & Sample, because both are repeats off an
already-approved style. In a table that is a null cell. On a track it is a
struck-through node you cannot miss, and the info drawer explains why it
happens.

## Files changed

**Added**

```
components/sales/crm/journey/JourneyTrack.js
```
Exports `trackNodes` (the single place a Journey's shape is computed),
`StageRuler`, `JourneyTrackRow` (tablet/desktop) and `JourneyTrackCard`
(mobile). Opens with a five-block **direction contract** recording the thesis,
world, story, first viewport and approved form.

**Rewritten**

```
app/sales/dashboard/journeys/page.js
```
Urgency banding, the ruler, and the state/filter plumbing carried over from
Part 2. Also opens with the direction contract.

**Deleted**

```
components/sales/crm/journey/JourneyCard.js
```
Superseded — its `JourneyWorklist`/`JourneyCard` exports were the rejected
table-derived layout, and nothing else imported it (verified by grep before
removal).

**Modified outside the page**

```
PRODUCT.md          ← the standing-commitment scope correction described above
```

**Untouched:** every file under `app/sales/dashboard/journeys/[journeyId]/`,
every stage component, `lib/salesJourney/*` (adapter, stageConfig,
capabilities, commercialAccess, fixtures), `crmShared.js`, `journeyBits.js`,
`Sales_DashboardLayout.js`, `Breadcrumb.js`, and all backend code.

## Nothing was invented

Every node reads `journey.stageStates`, which `loadHubSummaries` **already
returned for all eight stages** — the previous table simply discarded it. Stage
names, order, count and short forms all come from `stageConfig`; a renamed
stage renames itself here. `loadHubSummaries` is called exactly as before, the
adapter boundary is untouched, and no fixture was edited to make the page look
better.

## Two controls were deliberately removed

Both were required by `sales-journeys-page-ui.md` and both became **redundant**
once bands landed. Flagged rather than dropped quietly:

1. **The "Your Focus" pill strip** (brief §6) — Overdue / Today / This week
   *is* the focus. A filter re-answering the question the layout already
   answers is exactly the redundancy this redesign exists to remove.
2. **The sort control** (brief §9) — a page grouped by urgency cannot also be
   sorted by customer without one organiser destroying the other. The brief's
   own default was "Urgency"; the bands make that structural and permanent.

Stage, stage status, risk, business type, waiting-on and owner all remain
reachable in the Filters drawer, so no filtering capability was lost. If either
control is wanted back, "group by" rather than "sort by" is the shape that
would not fight the bands.

## Design-hook findings

Seven `design-system-font-size` findings fired across two rounds, all sub-11px
literals. **All were treated as real, none suppressed.** DESIGN.md carries a
named **Small-Text-Earns-Ink Rule** — *"Below 12px, ink steps up the ramp
rather than down. Small type on a screen used in bright factory light is a
legibility question, not a taste one"* — and PRODUCT.md notes these screens are
used on tablets in bright ambient light. I had paired 9.5–10px with the
*faintest* ink, which is precisely what that rule forbids.

Resolved by raising every size to ≥11px and stepping the stage ruler's ink from
faint to muted. The 9.5px ruler was the worst of them: if those eight labels
cannot be read, the concept fails at its foundation. The hand-rolled state chip
was also replaced with the design system's own `Chip` primitive, which is 12px
and tone-driven.

## Verification performed

**Commands**

```
npm run build      # ✓ Compiled successfully (Turbopack), 245/245 static pages
```

Only the long-standing unrelated warning (`rimraf`/`fstream` externals). No new
warnings. `npm run lint` remains broken repo-wide (no eslint dependency
installed); there is no test framework.

**Browser** — the route sits behind `FrostShell`'s `guardSlug="sales"` and no
authenticated Sales session was available, so verification again ran through a
temporary harness route **generated by `sed` from the real page file** (only
`DashboardLayout` swapped for a themed wrapper), calling the real
`loadHubSummaries` against the real backend. Deleted after verification.

Two inspection rounds, which is the ceiling; polish stopped there.

| Check | Result |
|---|---|
| Desktop 1440 | Ruler aligns with nodes; bands read Overdue 1 / Today 1 / This week 3; skipped nodes visibly struck on Southgate and Riverside |
| Tablet 820 | Action spans full track width instead of being squeezed; ruler switches to `stageConfig.short` forms so labels stop colliding |
| Mobile 375 | Spine survives at ~250px; `"PO/Contract · stage 5 of 8 · 1 skipped"` caption; `scrollWidth === innerWidth`, no horizontal scroll |
| Dark theme | Every colour is a token — forced `data-theme="dark"` and markers, rings and chips all held with zero page-specific dark work |
| Keyboard focus | Tab reaches the row link; `:focus-visible` matched, real `2px solid` outline at `-2px` offset (inset so it isn't clipped by the row divider) |
| Accessible name | One `aria-label` per row carrying name, reference, customer, `"stage 6 of 8, Production"`, state, distinct risk, skipped stages, next action + due, and owner. The spine is `aria-hidden` so eight dots aren't announced separately |
| Commercial gating | Unauthorized: no Value column, no `VALUE` ruler header, no value filter fields. Forced-authorized in the harness: column and header appear correctly |
| **Defect found and fixed (round 1)** | Riverside's "Waiting on Customer" was carried **only by the marker's colour** — state-by-colour-alone, forbidden by the craft floor and by my own direction contract. `notableState()` now gives every non-normal Journey a text chip, picking the single most severe true fact |
| **Defect found and fixed (round 2)** | Ruler was ragged (two-line labels knocked one-line labels out of alignment) and cramped below `lg`. Fixed with `items-end` and the config's `short` forms |

**Not verified:** the guarded route as actually deployed, with `FrostShell`
chrome, breadcrumb and top nav around the redesigned content — the harness
renders an identical component tree but no Sales session existed here.

## Remaining limitations

- Same prototype boundary throughout: `loadHubSummaries` is fixture-backed,
  `Start Journey` is an honest disabled preview.
- **Deep-linking to a specific completed stage dot was cut**, though the
  concept pitched it. `sales-journeys-page-ui.md` §10.1 explicitly forbids
  separate links inside a row ("one row/card is one obvious link target"), and
  nested interactive elements inside an anchor are invalid HTML besides. The
  row opens the Journey at its current stage; per-stage entry stays inside the
  Journey's own lifecycle bar.
- The spine wants roughly 400px of horizontal room. Above ~40 journeys the page
  will want stage-filtering or pagination; at fixture scale it is comfortable.
- Banding is client-side. When a Journey API exists, bucketing should move
  server-side rather than growing here.
- Dark theme was verified by forcing the attribute; `FrostShell`'s real toggle
  was not exercised end-to-end for this page.

## Confirmation

- **No backend code, model, route, API, migration, seed, fixture, dependency or
  configuration was changed.** No backend file was opened.
- **No Journey stage page was changed** — everything under
  `app/sales/dashboard/journeys/[journeyId]/` is untouched.
- **Nothing was committed**; no Git setting changed.
- **Unrelated uncommitted work preserved** — `app/grav-ui.css`,
  `app/sales/dashboard/page.js`, `app/sales/dashboard/accounts/**`,
  `components/shell/FrostShell.js`, `app/sales/references/` and every other
  pre-existing modified or untracked file are exactly as they were, confirmed
  by `git status --porcelain` before and after.

---

# Part 4 — Sales Journeys page, worklist pass (rejected, superseded)

## Brief

Two documents drove this session, applied in sequence:

1. `docs/tasks/sales-journeys-page-ui.md` — business requirements for the
   Journey Hub worklist: what a salesperson should see within five seconds,
   an ownership scope instead of five equal views, a quick-filter "Your Focus"
   strip, urgency sorting, and a combined lifecycle-position-plus-state
   column. It gave content and priority, not a mandated visual layout —
   explicit creative freedom on presentation.
2. A follow-up instruction to load `.claude/skills/impeccable/SKILL.md` and
   apply its `distill` guidance to the resulting implementation — strip
   anything that doesn't earn its place, remove redundancy, keep exactly one
   primary path.

## What changed, in one line

Five equal navigation tabs (My Journeys / Team Journeys / Needs Attention /
Waiting on Customer / At Risk) became one ownership choice (**My work** /
**Team**, My work first) plus four quiet urgency *conditions* ("Your Focus")
that toggle a filter rather than replace a destination — and the worklist row
itself was rebuilt around one combined lifecycle fact and a next-action line
that is never truncated.

## Design approach

`impeccable`'s `context.mjs` setup script resolved `PRODUCT.md` / `DESIGN.md`
for this repository, but both describe the **`/onboarding` launcher surface
only** (its own scope note says so explicitly — the eleven department
dashboards, Sales included, "still carry the older look... and do not follow
the tokens below yet"). Applying that surface's emerald/Odoo-launcher system to
a Sales CRM screen would have fought the incumbent design language the rest of
the Journey work already established. Per `impeccable`'s own rule —
**"Visual authority is evidence, not a filename"** — the evidence for this
surface is the shipped Sales module itself: `app/grav-ui.css`'s frost-panel /
ink / `--state-*` token system, `components/ceo/ui/Primitives.tsx`, and the
Journey components built in Part 2. This was therefore a `distill`
**refinement** of that incumbent system, not a redesign onto a different one.

`craft-floor.md`'s bans were applied directly:

- **No kicker/eyebrow above the `Sales Journeys` heading** — removed the
  existing `kicker="Sales"` PageHead prop. The ban is explicit and absolute.
- **No colored left border on rows/cards** — an early draft used one to signal
  risk; dropped in favor of the chip vocabulary already carrying that
  information as text, not decoration.
- **No progress-ring/sparkline stand-in for the stage position** — the brief
  allowed an optional tick row "only if it improves comprehension and does not
  add another competing status signal." Since `"Cost & Quote · Stage 4 of 8"`
  already states the position as text, a decorative tick row would be pure
  redundancy under `distill`'s own rule ("if it's said elsewhere, don't repeat
  it here") — cut before it was ever verified.
- One `<Link>` per row/card, not a title-inside-a-container with a stretched
  pseudo-element — flatter markup, and a real, complete `aria-label` per row
  rather than whatever the browser concatenates from nested chip text.

## Screens changed

Only `/sales/dashboard/journeys`. Nothing under
`/sales/dashboard/journeys/[journeyId]/...` (the eight stage workspaces) was
opened for editing.

| Area | Before this session | After |
|---|---|---|
| Header | `kicker="Sales"` eyebrow, two-line subtitle with an inline prototype sentence, always-visible Refresh button in the actions row | No kicker; subtitle is the brief's exact sentence; an `Info` icon opens "How Sales Journeys work"; Refresh moved beside the result count |
| Primary navigation | Five equal `Segmented` views: My Journeys / Team Journeys / Needs Attention / Waiting on Customer / At Risk | Two-option `Segmented`: **My work** (default) / **Team** |
| Urgency conditions | Three of the five views above, indistinguishable from the other two | A "Your Focus" strip — four toggleable pills with live counts, quiet (not hidden) at zero, one active at a time |
| Sort | None — adapter's natural fixture order | A `Sorted by` control: Urgency (default) / Due date / Recently updated / Customer / Lifecycle stage |
| Stage + status | Two separate table cells | One `LifecyclePosition` fact: `"Cost & Quote · Stage 4 of 8"` + one state chip; a redundant risk chip (e.g. a second "Blocked") is suppressed when its label would repeat the state chip's |
| Next action | A truncated cell in a dense table row | Its own full-width line under every row/card, arrow-prefixed, never truncated, "No next action assigned" when missing |
| Desktop/tablet result list | An HTML `<table>` with `min-w-[880px]` forcing horizontal scroll below that width | A CSS-grid worklist (`JourneyWorklist`) with `minmax(0, …)` columns that truncate/wrap instead of forcing scroll; Value is a `lg:`-only column so tablet keeps the Journey title legible |
| Mobile cards | Business type, buying-house/brand, business status and a readiness meter alongside the essentials | Reduced to the brief's exact order: name, reference + customer, lifecycle position + state, next action, owner, due, value (permission-gated) |
| Filters drawer | One flat list of seven fields | Grouped under **Journey** / **Responsibility** / **Commercial** headings; **Owner is omitted** entirely while My work is selected (it can only ever match the signed-in user) |
| Empty states | One generic "no journeys" / "no match" pair | Three: first-use (shows the eight-stage lifecycle once), **My-work-empty** ("No Journeys assigned to you" → "View Team Journeys"), and filtered-empty |
| Lifecycle explainer | None | A small `Info` action opens a drawer listing all eight stages with their `stageConfig` descriptions — no second permanent lifecycle bar |

## Components changed

**Rewritten**

- `app/sales/dashboard/journeys/page.js` — scope/focus/sort state, the Focus
  strip, the regrouped filter drawer, the info drawer, all four required empty
  states.
- `components/sales/crm/journey/JourneyCard.js` — `JourneyTable` (a literal
  `<table>`) replaced by `JourneyWorklist` (a CSS-grid list); `JourneyCard`
  (mobile) rebuilt as one `<Link>` instead of a stretched-anchor-in-a-div.
  Both now share `LifecyclePosition`, `NextActionLine`, `DueFact`, `OwnerFact`,
  and `journeyAriaLabel`/`distinctRiskLabel` so the two presentations can never
  disagree about what a Journey shows.

**Reused, unchanged** — `lib/salesJourney/adapter.js` (`loadHubSummaries` is
called exactly as before; focus counts, urgency rank and sort are all derived
client-side from its existing return shape), `lib/salesJourney/stageConfig.js`
(`STAGE_LIST`, `stageIndex`, `STAGE_COUNT`, `STAGE_STATE`, `RISK_STATE`,
`BUSINESS_TYPE`), `lib/salesJourney/commercialAccess.js`
(`useCommercialAccess`, unchanged fail-closed rule), `CrmDrawer`/`DrawerFooter`
from `crmShared.js` (the info sheet reuses the exact focus-trap/Escape/restore
contract the filter drawer already had), `PreviewAction`/`SubHead` from
`journeyBits.js`, `PreviewOnlyTag`, `useIsMobile`.

**Not introduced:** no second data adapter, no new lifecycle label or stage
order (both still read from `stageConfig`), no new Journey field the fixtures
don't already provide.

## Why My work is the default

The brief's own diagnosis: the previous default was `team`, "the broadest
dataset instead of the user's immediate work." Switching the default to `mine`
is the single change that makes "answer what needs me before what exists"
literally true on first paint, and it is reversible with one click.

## Focus counts vs. filters — a deliberate simplification

The brief left open whether "Your Focus" counts should reflect the full scope
or the currently-filtered subset. Rather than run a second, unfiltered
background fetch purely to compute a stable baseline, the counts are derived
from the **same rows** `loadHubSummaries` already returns for the active
scope + search + advanced filters (before the focus predicate itself is
applied) — one request, one source of truth, and the counts honestly narrow
alongside whatever the user has already searched or filtered, which is at
least as useful as a fixed baseline. The **My-work-empty** state is detected
the same way, with no second request: if My work is selected, no search, no
advanced filter, and no focus condition is active, and the result set is still
empty, that emptiness can only be the ownership scope itself.

## Permission behaviour

Unchanged rule, reused via `useCommercialAccess` (admin or department
approver/owner, fail-closed while resolving): the Value column, the Value
range filter fields (and their `Commercial` drawer heading), and the Value
line on mobile cards are all absent from the markup for an unauthorized
viewer — never rendered blank, matching the brief's explicit "do not leave an
empty Value column."

## Accessibility

- Every row/card is one `<Link>`; its `aria-label` states Journey name,
  reference, customer, `"stage N of 8, <Stage Name>"`, state, risk (only when
  distinct from the state), next action or "no next action assigned", and
  owner or "unassigned" — one clear name, not whatever nested chip text a
  screen reader would otherwise concatenate.
- Focus pills expose `aria-pressed`; the Ownership `Segmented` control already
  provided roving-tabindex arrow-key navigation and `aria-checked` (reused,
  unmodified).
- The Filters and "How Sales Journeys work" drawers both reuse `CrmDrawer`'s
  existing focus trap, Escape-to-close, initial focus, and focus-restoration
  contract — verified live (see below), not assumed.
- State is never colour-only: every chip pairs a tone with a text label; Focus
  pills pair an icon with a label and a numeric count.
- Confirmed the app's global `.grav-ui :focus-visible { outline: 2px solid
  var(--color-ink); outline-offset: 2px; }` rule (in `app/grav-ui.css`,
  untouched) already covers every new interactive element correctly — no
  bespoke focus-ring classes were added. In the course of rebuilding this
  page's own search input and the two commercial-value number inputs, an
  existing **defect confined to this page** was corrected: they had
  `focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)]`, and
  `--focus-ring` is not defined anywhere in the stylesheet — the override was
  silently suppressing the one focus indicator that did work and replacing it
  with nothing. Removed the override; these three inputs now inherit the
  correct, already-verified global outline like everything else on the page.

## Verification performed

**Commands**

```
npm run build      # ✓ Compiled successfully (Turbopack), 245/245 static pages
```

Same pre-existing, unrelated warning as every prior session (the `middleware`
→ `proxy` deprecation notice; a `rimraf`/`fstream` externals warning). No new
warnings or errors. `npm run lint` remains broken repo-wide (no eslint
dependency installed) and was not run; there is no test framework.

**Browser** — the in-app browser has no authenticated Sales session, and the
department guard's `/api/auth/verify` call additionally fails cross-origin
once the dev server's port was reassigned (see Environment note below), so a
temporary harness route was used again (same technique as Part 2/3): the
verbatim page body with `DashboardLayout` (which carries the auth guard)
swapped for a bare `.grav-ui theme-ready` wrapper, calling the real
`loadHubSummaries` against the real backend for real fixture data. Deleted
after verification; no trace remains in the repo.

| Check | Result |
|---|---|
| Desktop 1440×1000 | My work defaults correctly (3 journeys); Focus counts match the fixture predicates by hand-check; urgency sort ordering verified — Blocked → Overdue → At Risk → Waiting on Customer → remaining, exactly per brief §9's priority list |
| Tablet 820×1000 | Worklist grid holds without horizontal scroll; Journey title column compresses first, as designed, before anything is hidden |
| Mobile 375×812 | Cards stack cleanly; `document.documentElement.scrollWidth === window.innerWidth` confirmed (no horizontal page scroll); one tap target per card |
| Dark theme | Forced `data-theme="dark"` on the `.grav-ui` root — every colour on the page comes from an existing `var(--...)` token, none hard-coded, so contrast and chip legibility held with zero page-specific dark-mode work needed |
| Ownership scope toggle | Clicking Team correctly re-queries and re-sorts (5 journeys); `[role=radio]` `aria-checked` and the active/inactive class both confirmed correct in the live DOM (an initial screenshot appeared stale mid-transition — re-queried DOM state, not a pixel capture, settled the check) |
| Focus pill toggle | `aria-pressed` toggles correctly; selecting **Overdue** narrowed 5 → 1 journey and matched the fixture with `nextAction.overdue === true`; re-clicking cleared it |
| Redundant risk chip | Found and fixed live: a Blocked-stage, Blocked-risk Journey rendered `"Blocked Blocked"`. `distinctRiskLabel()` now suppresses the risk chip (and the aria-label's risk clause) whenever it would repeat the state chip's own label |
| Sort control | Selecting **Customer** re-sorted alphabetically by customer name, confirmed against the visible list |
| Filters drawer — grouping | `Journey` heading always present; `Responsibility` (Owner) present only when Team is selected, confirmed absent under My work by reading the drawer's own text content |
| Filters drawer — focus contract | Escape closed the drawer and returned focus to the exact `Filters` button that opened it, confirmed via `document.activeElement`, under both scopes |
| Info drawer | Opens on the `Info` button; lists all eight stages with their real `stageConfig` descriptions; Escape closes and restores focus |
| Commercial gating | Verified with the default (unauthorized) `useCommercialAccess` result: no Value column, no Value filter fields, no `Commercial` drawer heading anywhere in the DOM |

**Not verified in the browser:** the guarded route itself
(`/sales/dashboard/journeys` as actually deployed, behind `DashboardLayout` /
`FrostShell`'s `guardSlug="sales"`) — the harness renders the identical
component tree and calls the identical adapter function, but an authenticated
session was not available in this environment to exercise the guard,
breadcrumb, and top-nav chrome together with the redesigned content.

## Remaining limitations

- Same prototype boundary as every prior session: `loadHubSummaries` is
  fixture-backed (`JOURNEY_RECORD_MODE = "prototype"`); `Start Journey`
  remains an honest, disabled preview action.
- Focus counts and sort are computed client-side against whatever
  `loadHubSummaries` already returned; when a real Journey API exists, both
  should move server-side rather than growing further here.
- The "Needs Attention" superset predicate (blocked stage, blocked risk,
  overdue next action, at-risk/delayed risk, or an unassigned owner) is
  defined once in `page.js` and is not exposed anywhere the adapter or a
  future API could reuse it — worth promoting into the adapter layer if a
  second surface ever needs the same definition of "needs attention."
- Dark theme was verified by forcing the attribute in the browser console
  (this repo has no in-harness theme toggle wired up); the real toggle, part
  of `FrostShell`, was not exercised end-to-end for this specific page.

## Files changed

**Modified — `/Users/risheeray/grav-cms`**

```
app/sales/dashboard/journeys/page.js
components/sales/crm/journey/JourneyCard.js
```

**Not touched this session (for contrast with Part 2):** every stage
component under `components/sales/crm/journey/stages/`,
`components/sales/crm/journey/JourneyWorkspace.js`,
`components/sales/crm/journey/JourneyHeader.js`,
`components/sales/crm/journey/JourneyStatusStrip.js`,
`components/sales/crm/journey/JourneyActivityDrawer.js`,
`components/sales/crm/journey/RecordSelector.js`,
`components/sales/crm/journey/MoreMenu.js`, `journeyBits.js`,
`stageChrome.js`, `useMediaQuery.js`,
`app/sales/dashboard/journeys/[journeyId]/**`,
`lib/salesJourney/adapter.js`, `lib/salesJourney/stageConfig.js`,
`lib/salesJourney/capabilities.js`, `lib/salesJourney/fixtures/*`,
`lib/salesJourney/commercialAccess.js`, `components/Sales_DashboardLayout.js`,
`components/Breadcrumb.js`.

**Environment note (not a code change):** `.claude/launch.json` is
git-ignored local tooling config, not part of this repository's shipped code.
Port 3000 was occupied by an unrelated project's dev server; `"autoPort":
true` was added to this file so the harness could assign a free port
automatically. No application file, and nothing under version control, was
affected.

## Confirmation

- **No backend code, model, route, migration, seed, dependency or
  configuration was changed.** No backend file was opened this session.
- **No individual Journey stage page was changed** — every file under
  `app/sales/dashboard/journeys/[journeyId]/` is untouched; only the top-level
  Hub route and its two dedicated presentation components changed.
- **Nothing was committed** and no Git setting was changed.
- **Unrelated uncommitted work preserved:** `app/grav-ui.css`,
  `app/sales/dashboard/page.js`, `app/sales/dashboard/accounts/page.js`,
  `components/shell/FrostShell.js`, `app/sales/references/` and every other
  file already modified/untracked before this session began remain exactly as
  they were — confirmed via `git status --porcelain` before and after.

---

# Part 5 — Sales Journey UI simplification (earlier session)

## What changed, in one line

The stage workspace stopped being a three-column command centre with a floating
bottom lifecycle bar and seven header buttons, and became one guided column: a
compact two-row header, an inline lifecycle stepper, **one** alert, one work
panel, and everything else behind `Activity`, `More`, tabs and drawers.

## Screens simplified

| Screen | Before | After |
|---|---|---|
| `/sales/dashboard/journeys` | Two-line subtitle, prototype banner, 11-view switcher with a paragraph under it, an always-open 8-field filter grid, a card/table mode toggle, cards carrying 14 facts | One-line purpose, 5 views (tooltips not paragraphs), one search field + one `Filters` button, applied-filter chips, table on desktop/tablet and cards on mobile from the same data, 7 facts per result |
| `/sales/dashboard/journeys/[journeyId]/[stage]` (all 8) | Header + left context rail + main + right activity rail + bottom lifecycle bar; prototype banner and risk banner stacked | Compact sticky header → inline lifecycle stepper → one status strip → optional record selector → one ~1200px work column |
| Account stage | Reproduced most of the Account workspace inside the Journey | Concise Account summary + *what is missing* + link to the full record; sections open from tabs/`More` |
| Enquiry/RFQ | 5 tabs of raw fields, requirement rail | One enquiry summary; unresolved qualification problems as the attention block |
| Style & Sample | Style rail + 6-step substage stepper + all versions mixed | Style dropdown with counts; active version only; earlier versions under `More → Version history` |
| Cost & Quote | Costing rail + 5-step stepper; uniform price list as a second large table | Active quotation as the work area; the price list is an alternate content type *inside* the Quote tab |
| PO/Contract | Mismatches buried below PO metadata | Mismatch count and fields are the attention block; `Resolve Differences (n)` is the secondary action |
| Production | Milestone rail + 5-view switcher + selected-milestone panel | Progress and next three milestones as the work area; ONE milestone timeline in the Milestones tab |
| Shipment | Shipment rail + 7-step stepper | Shipment selector with partial-shipment progress in one line ("2 of 2 dispatched · 17,000 of 17,000 pcs") |
| Retention | Claims, repeat, uniform stats, performance and a 5-button completion row, all at once | Outcome and next relationship action as the work area; workstreams in tabs; completion options in `More` |

## Shared components refactored

**Rewritten**

- `components/sales/crm/journey/JourneyWorkspace.js` — single-column shell. Now
  owns the header, lifecycle, status strip, Activity drawer, checklist drawer
  and `More` menu, so all eight stages get one identical chrome. Stages pass
  **action descriptors** (`primary`, `secondary`, `moreItems`), not buttons —
  a stage structurally *cannot* render a second primary action.
- `components/sales/crm/journey/JourneyHeader.js` — two compact rows, sticky at
  every width. Business type, full party string, merchandiser and the six
  note/task/document/blocker/timeline/checklist buttons moved into
  `Activity`/`More`.
- `components/sales/crm/shell/LifecycleBar.js` — inline slim stepper below the
  header instead of a bar floating over the bottom of the viewport. Sentence
  case, no repeated "Preview", state icons + accessible state text. Mobile shows
  `Stage 4 of 8 · Cost & Quote` with previous/next and a full-lifecycle sheet.
- `components/sales/crm/journey/JourneyCard.js` — reduced card and 7-column
  table; each result is one stretched-link click target.
- `components/sales/crm/journey/stages/stageChrome.js` — `StageTabs`,
  `firstVisibleTab`, `StageDetails`. The substage stepper was **removed**: two
  step bars stacked under each other read as one confused control.

**New**

- `JourneyStatusStrip.js` — one alert by priority (blocked → at risk → waiting →
  prototype). The stage's own attention items are nested inside it behind
  `View details`, so the fold never carries two alerts saying the same thing.
- `JourneyActivityDrawer.js` — timeline / tasks / approvals / documents in one
  drawer, with `initialTab`.
- `RecordSelector.js` — one row (label + native `<select>` + state chip +
  counts) replacing the 272px left rail.
- `MoreMenu.js` — accessible overflow menu (roving focus, Home/End, Escape).
- `useMediaQuery.js` — SSR-safe, so the secondary action genuinely *moves* into
  `More` on tablet rather than being CSS-hidden in two places.
- `lib/salesJourney/commercialAccess.js` — the one commercial/finance rule.

**Deleted** (superseded, not orphaned): `JourneyContextRail.js`,
`JourneyActivityRail.js`.

**Extended, not forked** — `CrmDrawer` in `components/sales/crm/crmShared.js`
gained a focus trap, initial focus, focus restoration and a `placement="bottom"`
sheet variant. Every CRM dialog inherits it, including the Account library's.

## Navigation and terminology

- Sidebar `Journey Hub` → **`Sales Journeys`**. `Journey Hub` survives only as
  the hub page's own subtitle. The active sidebar item stays `Sales Journeys`
  through all eight stages (unchanged `JOURNEY_ACTIVE_MENU`).
- Breadcrumb is now `Sales Journeys / SJ-… / Current Stage` — the journey crumb
  is the reference alone, since the full name is the page heading two lines
  below and repeating it pushed the stage crumb off a phone.
- No stage was added to the sidebar; Accounts and Contacts are not duplicated.
- `Prepare Delivery/Shipment` → **`Prepare Shipment`**;
  `Close and Grow Account` → **`Move to Retention`**;
  `Start Enquiry/RFQ/Tender` → `Start Enquiry/RFQ`;
  `Send Costable Styles to Cost & Quote` → `Send to Cost & Quote`;
  Retention's primary is now `Create Repeat Journey`.
  All of these live in `lib/salesJourney/stageConfig.js` and are read by the
  stages — no stage hard-codes a lifecycle label.
- Per-stage primary actions are state-dependent where the brief asks:
  `Submit for Approval` → `Send to Cost & Quote`; `Send Quote` →
  `Convert to PO/Contract`; `Confirm Delivery` → `Move to Retention`.

### Stage tab sets replaced (`stageConfig.STAGES[*].tabs`)

Stage keys, slugs, labels, order and data modes are **unchanged**. The `tabs`
arrays were replaced with the brief's simplified per-stage view lists, and two
new declarative flags were added so visibility rules cannot be honoured in one
stage and forgotten in another:

- `requires: "commercial"` — Cost & Quote → Costing, Shipment → Commercial close
- `requires: "uniform"` — Retention → Uniform Service

`visibleTabs(stageKey, { commercial, uniform })` applies them and **fails
closed**; `firstVisibleTab()` stops a stage defaulting to a tab the viewer
cannot open.

## Permission behaviour

Commercial visibility no longer uses the generic `atLeast("editor")` threshold.
`useCommercialAccess()` grants it to **admin, or a department role of
approver/owner** — the same explicit rule `crmShared.useCreditAccess` uses for
restricted Account fields, which mirrors the server. It **fails closed** while
the role is resolving, so a figure never appears and then vanishes.

Restricted content is *removed from the markup*, not blanked: the Costing tab
and the `Margin` column are absent from the DOM for an unauthorized viewer, and
a single `RestrictedNote` explains the boundary. This is presentation only —
when these stages get a backend the server must strip the fields too.

## Known defects corrected (brief §12)

| # | Defect | Fix |
|---|---|---|
| 1 | Timeline opened the Stage Checklist | `More → Timeline` opens `JourneyActivityDrawer` with `initialTab="timeline"`; the checklist is its own entry |
| 2 | Commercial visibility on a generic editor threshold | `lib/salesJourney/commercialAccess.js` — explicit approver/owner capability, fails closed |
| 3 | Mobile rail dialogs lacked Escape / focus trap / initial focus / focus restore | Implemented once in `CrmDrawer`; the rails that had the problem no longer exist |
| 4 | Header described as sticky on mobile but wasn't | `JourneyHeader` is `sticky top-[72px]` at every width (72px clears FrostShell's floating top bar) |
| 5 | `Prepare Delivery/Shipment` | `Prepare Shipment`, from `stageConfig` |
| 6 | `Close and Grow Account` | `Move to Retention`, from `stageConfig` |
| 7 | Raw Account ids flashing in breadcrumbs | Account page publishes a placeholder label on first render; `Breadcrumb.js` also masks any unlabelled 24-hex ObjectId segment as a backstop |
| 8 | Account resolution stopped at the first 200 accounts | `adapter.accountIndex()` now does a targeted lookup per distinct referenced code using the list endpoint's existing `search` parameter, then requires an exact `accountId` match. No endpoint invented, no unbounded pagination, bounded by the number of distinct fixture codes (currently 2) |

## Verification performed

**Commands**

```
npm run build      # ✓ Compiled successfully (Turbopack), 245/245 static pages
```

The only build warnings are pre-existing and unrelated (the `middleware` →
`proxy` deprecation notice, and a `rimraf`/`fstream` externals warning).
`npm run lint` remains broken in this repo (declares `eslint .` with no eslint
config or dependency installed) and was not run. There is no test framework.

**Browser** — verified in the running dev server against a temporary harness
route that renders the real shell and stage components with real adapter data
outside the department guard (the in-app browser has no Sales session, so the
guarded routes redirect to the landing page). The harness was deleted after
verification; no trace remains in the repo.

| Check | Result |
|---|---|
| Desktop 1440×900 | Above the fold: one compact header, one lifecycle stepper, one alert, one work panel. No horizontal page scroll (`scrollWidth === innerWidth`) |
| Tablet 800/744 | Stage secondary action collapsed into `More`; header stayed two logical rows; mobile lifecycle control engages below 768px |
| Mobile 375×812 | Sticky header, stage control directly below it, exactly one visible primary action, cards not tables, no horizontal page scroll. The only element wider than the viewport is a stage tab inside its own `overflow-x: auto` strip |
| Activity drawer | Opens on **Timeline**; `aria-modal`, accessible name "Activity"; initial focus lands on a control inside the panel; Shift+Tab from the first focusable wrapped to the last (trap holds); Escape closed it and focus returned to the `Activity` button |
| Mobile lifecycle sheet | Bottom sheet lists all 8 stages numbered with state text + icon; Escape closed it and focus returned to the `Stage 3 of 8` button |
| `More` menu | `aria-haspopup="menu"`, focus moved to the first item on open, ArrowDown moved to the next, Escape closed and restored focus to the button |
| Status strip priority | `Blocked` won over `At Risk` on SJ-2026-0047; `Waiting on Customer` shown on SJ-2026-0051; `Design preview` only when nothing else applies |
| One alert, not two | `View details` expands the stage's attention items *inside* the strip; verified `aria-expanded` toggles and the items appear/disappear |
| Commercial gating | With the capability **off**: tabs `Quote · Negotiation · Approval · Terms`, table headers `Style · Version · Proposed · Quote state`, no margin figure anywhere in the DOM, restriction note shown. **On**: `Costing` tab and `Margin` column appear |
| Stage naming | All eight read from `stageConfig`: Account, Enquiry/RFQ, Style & Sample, Cost & Quote, PO/Contract, Production, Shipment, Retention. Grep confirms no `Delivery/Shipment`, `Grow Account`, or `Close and Grow` remains |
| Action hierarchy | Every stage checked renders exactly: back link, one primary, at most one secondary, `Activity`, `More` |
| State not by colour alone | Lifecycle pills carry icon + accessible name (`"Production, current stage, In Progress"`); status strip pairs an icon and a written label with its wash |
| Record selector | Style & Sample: `Style [4 options] Approved · 4 styles · 2 approved`; Shipment: `2 of 2 shipments dispatched · 17,000 of 17,000 pcs` |
| Hub results | Table columns `Journey · Stage · Status · Next action · Due · Owner · Value`; the risk chip appears only where risk exists; cards carry the same reduced fact set |
| Defect §12.8 live | `GET /api/cms/crm/accounts?search=ACC-0002&limit=20` against the running backend returned exactly one row with `accountId === "ACC-0002"` |

**Not verified in the browser:** the Account stage (needs an authenticated Sales
session, which this environment could not provide without entering credentials)
and the guarded routes themselves. Both compile and are exercised by the same
shell as the seven stages that were verified.

## Remaining limitations

- Seven of eight stages remain **prototype**: fixtures in
  `lib/salesJourney/fixtures/`, no writes, every unsupported control disabled
  and tagged `Preview`. Nothing implies data was saved.
- The Journey record itself has no backend model, so `Start Journey`,
  `Create Repeat Journey`, `Log Claim` and the completion options are previews.
- Document upload is still unavailable — there is no CRM file service.
- `Needs Attention` in the Hub is derived client-side from the team result
  (overdue / blocked / at risk). It is not a stored view; when a Journey API
  exists it should become a server-side query.
- Owner filter options come from one unfiltered read at mount. Fine at fixture
  volume; a real API should expose an owner list.
- Commercial gating is presentation-only. The server must strip these fields
  when the stages go live.
- The sticky header offset (`top-[72px]`) is tuned to FrostShell's floating top
  bar. If that bar's height changes, this constant follows it.
- Account-stage editing still routes to the Account library, which owns the one
  `AccountForm` — deliberately not duplicated inside the Journey.

## Files changed

**Modified — `/Users/risheeray/grav-cms`**

```
app/sales/dashboard/journeys/page.js
app/sales/dashboard/journeys/[journeyId]/layout.js
app/sales/dashboard/journeys/[journeyId]/[stage]/page.js
app/sales/dashboard/accounts/[id]/page.js          (breadcrumb placeholder only)
components/Breadcrumb.js                            (ObjectId masking only)
components/Sales_DashboardLayout.js                 (one nav label only)
components/sales/crm/crmShared.js                   (CrmDrawer focus contract + bottom placement)
components/sales/crm/shell/LifecycleBar.js
components/sales/crm/journey/JourneyWorkspace.js
components/sales/crm/journey/JourneyHeader.js
components/sales/crm/journey/JourneyCard.js
components/sales/crm/journey/journeyBits.js
components/sales/crm/journey/stages/stageChrome.js
components/sales/crm/journey/stages/AccountStage.js
components/sales/crm/journey/stages/EnquiryStage.js
components/sales/crm/journey/stages/StyleSampleStage.js
components/sales/crm/journey/stages/CostQuoteStage.js
components/sales/crm/journey/stages/PoContractStage.js
components/sales/crm/journey/stages/ProductionStage.js
components/sales/crm/journey/stages/ShipmentStage.js
components/sales/crm/journey/stages/RetentionStage.js
lib/salesJourney/stageConfig.js                     (tab sets, action labels, helpers)
lib/salesJourney/adapter.js                         (account resolution only)
```

**Added**

```
components/sales/crm/journey/JourneyStatusStrip.js
components/sales/crm/journey/JourneyActivityDrawer.js
components/sales/crm/journey/RecordSelector.js
components/sales/crm/journey/MoreMenu.js
components/sales/crm/journey/useMediaQuery.js
lib/salesJourney/commercialAccess.js
```

**Deleted**

```
components/sales/crm/journey/JourneyContextRail.js
components/sales/crm/journey/JourneyActivityRail.js
```

**Untouched, deliberately:** `lib/salesJourney/capabilities.js`,
`lib/salesJourney/fixtures/*`, `app/sales/dashboard/journeys/[journeyId]/page.js`,
`app/sales/dashboard/journeys/[journeyId]/JourneyContext.js`,
`components/sales/crm/journey/PrototypeDataBanner.js`,
`components/sales/crm/journey/StageChecklistDrawer.js`,
`components/sales/crm/shell/RailGroup.js`,
`components/sales/crm/shell/WorkspaceHeader.js` (both still used by the Account
library), and `app/sales/dashboard/accounts/[id]/_sections/*`.

## Confirmation

- **No backend code, model, route, migration or seed was changed.** The only
  backend file read this session was `routes/CMS_Routes/Sales/accounts.js`, to
  confirm that the `search` parameter already matches `accountId` before relying
  on it for defect §12.8.
- **No dependency or configuration was changed** — `package.json`,
  `package-lock.json`, `next.config.mjs`, `components.json`, `.env*` and
  `.gitignore` are untouched. `package-lock.json` shows as modified in
  `git status`, but it was already modified before this session began.
- **Nothing was committed** and no Git setting was changed. The working tree
  holds exactly the same modified/untracked set as at session start, plus the
  files listed above.
- **Unrelated uncommitted work preserved:** `app/grav-ui.css`,
  `app/sales/dashboard/page.js`, `app/sales/dashboard/accounts/page.js`,
  `components/shell/FrostShell.js` and `app/sales/references/` were not touched.

---

# Part 6 — Sales Journey frontend, first build (earlier session)

> Superseded in presentation by Part 1. The routes, adapter, capabilities,
> fixtures and lifecycle described here are unchanged; the layout, navigation
> and action hierarchy described here were replaced.

## Completed functionality

### Routes and screens created

| Route | Purpose | Data mode |
|---|---|---|
| `/sales/dashboard/journeys` | Journey Hub — 11 views, filters, card/table toggle | Prototype |
| `/sales/dashboard/journeys/[journeyId]` | Redirects to the journey's current stage (keeps stage in the URL) | — |
| `/sales/dashboard/journeys/[journeyId]/[stage]` | Deep-linkable stage workspace for all 8 stages | Account = live, rest = prototype |

Stage slugs, as specified: `account`, `enquiry`, `style-sample`, `cost-quote`,
`po-contract`, `production`, `shipment`, `retention`. All eight resolve, and
refresh / back / forward / bookmarking return to the correct workspace.

### Navigation and naming (spec §3.1A)

`components/Sales_DashboardLayout.js`'s `NAV` was reorganized into four
conceptual groups, with every existing href preserved:

```
Sales Overview · Journey Hub · Approvals
Customer libraries → Accounts · Contacts · Call Planner
Operations (existing) → Orders & PI · Products & BOM · Measurements ·
                        Leads (Existing) · Order Customers (Existing)
Configuration → CRM Settings · Sales config (…) · Customer departments · Sales Settings
```

**Transitional labels recorded, as the spec requires.** `Leads (Existing)` and
`Order Customers (Existing)` keep their real identity rather than being
relabelled as Journey Enquiries or Accounts — no approved migration says those
records *are* Journeys or Accounts, and renaming them would assert a data
relationship that does not exist. Remove the "(Existing)" qualifier only when a
migration decision names the source of truth.

Label-only changes (keys and hrefs untouched): `Sales dashboard` → `Sales
Overview`; `Purchase orders / PI` → `Orders & PI`; `MPC measurements` →
`Measurements`; `Customer list` → `Order Customers (Existing)`; `Leads` →
`Leads (Existing)`; `Call planner` → `Call Planner`; `CRM settings` → `CRM
Settings`; `Settings` → `Sales Settings`; the `Store config` sub-group →
`Sales config` (it configures Sales, and the old name read as another
department's).

The eight lifecycle stages are deliberately **not** in the top navigation. Top
nav answers "which workspace am I entering"; the lifecycle bar inside an open
journey answers "where am I within it". All Journey routes report a single
`activeMenu` of `journeys`; Accounts and Contacts keep theirs.

### Breadcrumbs

Journey routes now read
`SALES / Journey Hub / SJ-2026-0042 · MetroCare Uniform Program — 2026 Refresh / Cost & Quote`
and Account detail reads `SALES / Accounts / ACC-0001 · Test Uniform Client Co`
— verified live, no raw database ids.

Implemented by **extending** the existing shared breadcrumb, not forking a
second one: `components/BreadcrumbLabels.js` lets a screen publish readable
labels (and optionally a better href) for the segments it owns, and
`components/Breadcrumb.js` consumes them. Only one breadcrumb renders.

### Shared journey shell (spec §4)

`JourneyHeader` (composes the existing `WorkspaceHeader`) · `JourneyContextRail`
· `JourneyActivityRail` (built on the existing `RailGroup`) ·
`StageChecklistDrawer` (built on the existing `CrmDrawer`) · `JourneyWorkspace`
(three-column shell + responsive rail sheets) · `LifecycleBar` (extended, not
replaced) · `JourneyCard`/`JourneyTable` · `PrototypeDataBanner` ·
`journeyBits.js` (`StageStatusBadge`, `RiskBadge`, `ApprovalBadge`,
`ReadinessBadge`, `ReadinessSummary`, `RiskBanner`, `BlockerCard`,
`VersionBadge`, `ComparisonRow`, `PreviewAction`, `SubHead`, `Fact`) ·
`stages/stageChrome.js` (`StageTabs`, `SubstageStepper`).

### Stage workspaces

- **Account (LIVE)** — reuses the existing live section components unchanged
  (Contacts, Sites & Addresses, Departments, Relationships, Team, Audit,
  Garment Profile, Commercial). Reads the real Account via `lib/crmApi.js`.
- **Enquiry/RFQ** — requirement, product requirement, commercial
  qualification, tender panel (only for tender variants), clarifications,
  pursue decision. Adapts to general / RFQ / tender / uniform / repeat /
  replenishment.
- **Style & Sample** — multi-style rail with filters; `SPECIFY → PREPARE →
  SAMPLE → REVIEW → SEND → APPROVE`; sample history kept as versions, never
  overwritten; per-style costable readiness roll-up.
- **Cost & Quote** — costing rail; `COST → REVIEW → APPROVE → QUOTE →
  NEGOTIATE`; cost build-up, price breaks, approval history, quotation,
  negotiation rounds, and the uniform contract price list.
- **PO/Contract** — `VERIFY → BREAK DOWN → PLAN → RELEASE`; PO-vs-quotation
  mismatch comparison, size/destination breakdown, T&A calendar, release
  checklist with recorded exceptions, numbered amendments.
- **Production** — `MATERIALS → … → PACK` milestone rail with source-system
  attribution; critical path, approvals, summary quantities, quality, customer
  commitments, risks.
- **Shipment** — per-shipment rail (partial shipments first-class); `PLAN →
  BOOK → DISPATCH → DOCUMENTS → TRACK → DELIVER → COMMERCIAL CLOSE`.
- **Retention** — performance review, claims, repeat candidates, uniform
  aftercare, relationship plan, completion options.

## Live APIs used

Only pre-existing endpoints, via the existing `lib/crmApi.js`:

- `GET /api/cms/crm/accounts` — resolves fixture account codes to live Accounts.
- `GET /api/cms/crm/accounts/:id` — the Account stage's live record.
- Every write on the Account stage goes through the reused live section
  components, so real writes and the 202 "submitted for approval" path are
  unchanged.

**No new endpoint was called or invented.** `lib/salesJourney/capabilities.js`
records `api: null` for all seven prototype stages.

## Prototype adapters and fixtures

```
lib/salesJourney/
├── stageConfig.js     # SINGLE naming source of truth: keys, slugs, labels,
│                      # inner tabs, order, and the four state vocabularies
├── capabilities.js    # live | prototype | unavailable, per stage, + api: null
├── adapter.js         # the only data boundary; no create/update/save exists
└── fixtures/
    ├── journeys.js    # 5 journeys, stable ids (SJ-2026-0042 …)
    └── stageData.js   # per-stage view models keyed by journey id
```

Design decisions worth knowing:

- **Accounts are referenced by CODE, never re-typed.** Fixtures carry
  `accountCode`, and the adapter resolves it against the live Account library
  at runtime. Verified live: `ACC-0001` → "Test Uniform Client Co",
  `ACC-0002` → "Northstar Buying Services Test". Where a code does not resolve
  (e.g. "Riverside Schools Trust"), the name still displays but the "View
  Account" control is **disabled with an explanation** rather than implying a
  link that does not exist. No live ObjectId is hardcoded — that would break in
  every other environment.
- **No dates are computed at module load.** Fixtures store day offsets; the
  adapter resolves them against a single `now`. Deterministic and SSR-safe.
- **The adapter has no write functions at all.** Prototype stages have nothing
  to write to, so the adapter offers no way to pretend otherwise.

## Non-persistent interactions

Every preview control renders through `PreviewAction`, which is **disabled**,
carries a `PREVIEW` tag, and has a title explaining that no backend exists.
Named business verbs are kept (`Send to Style & Sample`, `Submit for Commercial
Approval`, `Convert to PO/Contract`, `Release to Production`, `Prepare
Delivery/Shipment`, `Create Repeat Journey`, `Close Journey`) so the transition
is legible — but never presented as saved. `PrototypeDataBanner` sits above
every prototype stage and is not dismissible.

Four outcomes stay visually distinct, per spec §15.4: **saved** (live Account
writes), **submitted for approval** (202 via the reused sections and the
already-mounted `HeldChangeWatcher`), **preview only** (disabled + tag), and
**failed** (real `ErrorState`).

No upload UI was built anywhere — there is no document service, and the spec
forbids a prototype upload path.

## Required backend contracts per stage

| Stage | What a future API must supply |
|---|---|
| Journey record | `SalesJourney`: reference, name, businessType, customer + party account refs, owner/merchandiser, per-stage state, risk + reason, next action, target dates, expected/confirmed value, readiness counts |
| Enquiry/RFQ | Enquiry/RFQ/tender with variant, requirement, product summary, qualification scores, tender eligibility + documents, clarifications, pursue decision |
| Style & Sample | Styles with versions, specify/prepare data, sample history, internal review, dispatch, customer decision; approved-version pointer |
| Cost & Quote | Versioned costing lines + build-up, price breaks, approval history, quotation versions, negotiation rounds, uniform price list. **Margin/commission must be stripped server-side** |
| PO/Contract | Customer PO/contract, quotation-vs-PO diff, size/destination breakdown, T&A milestones, release checklist + exceptions, numbered amendments |
| Production | Milestones with planned/actual/forecast + source system, critical path, pre-production approvals, summary quantities, inspections, customer commitments, risks |
| Shipment | Shipments with mode/ETD/ETA/state, plan, booking, dispatch, documents, tracking events, delivery proof, commercial close (**permission controlled**) |
| Retention | Performance actuals, claims, repeat candidates, uniform aftercare, relationship plan; new-journey creation that references the completed journey |

## Tests and verification

**Build: `npm run build` compiles successfully** (Next.js 16 / Turbopack, exit
0), with all three journey routes registered. Run repeatedly during the build,
including after the final change.

**Lint: `npm run lint` cannot run — it is broken repo-wide.** `package.json`
declares `eslint .` but eslint is not installed (`sh: eslint: command not
found`). This is pre-existing and documented in the frontend `CLAUDE.md`; I did
not add the dependency, since the task forbids dependency changes. `next lint`
is removed in Next 16, so no alternative was available. The production build
(which resolves every module and compiles all JSX) is the verification that did
run. **"Lint passes" is not claimed.**

**Live verification** against the running dev stack (frontend `:3000`, backend
`:5050`), authenticated session:

- Journey Hub: 11 views, all filters, card and table modes, 5 journeys with
  every specified card field; live account-code resolution confirmed.
- All 8 stage routes return 200; each stage's content verified individually
  (style rail with 4 styles, cost build-up, PO mismatch list, production
  milestones with ERP refs, shipment tracking, retention performance/claims).
- Breadcrumbs verified in the exact spec format, on both Journey and Account
  routes.
- Lifecycle bar: 8 stages in order, `aria-current="step"` on the current one,
  completed stages check-marked, state and preview status in each accessible
  name.
- Distinct states verified: **Not Applicable** (Style & Sample on a repeat
  journey — explains itself, doesn't blank), **stage not started** (Shipment on
  a Cost & Quote journey — names where the journey actually is), **unknown
  slug**, **journey not found**, loading skeletons, and the Account stage's
  "customer not linked to a live Account" state.
- Stage checklist drawer: required inputs with readiness, blockers, recommended
  next action, carries-forward list, exceptions. Closes on Escape.
- **Regression:** all 10 legacy Sales routes still return 200 (dashboard,
  leads, customers, customer-requests, accounts, contacts, approvals,
  stock-items, call-planner, crm-settings). Live Account detail still loads
  ACC-0001 and its Garment Sales Profile.

**Responsive** (spec §4.7): desktop 1400px — three columns, rails persistent.
Tablet 768px — rails collapse to labelled toggles that open the *same* rail
components in sheets; lifecycle bar scrolls; no sideways page scroll. Mobile
375px — single column, `documentElement.scrollWidth === 375` (no horizontal
page scroll), lifecycle bar reachable and scrollable, rails as sheets. Wide
tables scroll inside their own `overflow-x: auto` container.

**Accessibility** (spec §17): lifecycle bar is a labelled `<nav>`; every stage
pill's accessible name carries stage, current-step, state and preview status,
so meaning never depends on colour ("PO/Contract, current stage, Complete,
preview data"); `aria-current="step"` set; zero icon-only buttons without an
accessible name; 12 landmarks with `<main>` present; all progressbars labelled;
table headers all `scope="col"`; rail search and filter groups labelled;
drawers are `role="dialog" aria-modal="true"` with a labelled close and Escape
handling.

**Console: clean.** A fresh tab loading a stage produced zero errors. (Errors
seen mid-session in the long-lived tab were stale dev-cache entries logged
before `RetentionStage.js` was written; the file exists and the production
build resolves it.)

## Known limitations

- Seven of eight stages are previews. They are structurally complete but hold
  fixture data; nothing entered is saved because there is nowhere to save it.
- Only journeys whose fixture `accountCode` matches a live Account get a
  working Account stage and "View Account" link. Two of the five do
  (`ACC-0001`, `ACC-0002`); the other three show a clear explanation instead.
- Hub filtering, sorting and search run client-side over five fixtures. Date
  range and a persisted "recently viewed" are not implemented (no per-user
  storage exists to hold them honestly).
- No unsaved-changes guard is implemented, because no prototype stage has an
  editable form to lose — this becomes required as soon as a stage gets a
  backend.
- Restricted commercial information (margin, commission, value, invoice/
  payment) is gated client-side via `useDeptRole`. Presentation only. **When
  these stages get APIs, the server must strip these fields** — the spec is
  explicit that hidden fields must not be recoverable from client payloads.
- Journey documents are display-only; no uploader exists.
- The `Sales config` sub-group label was changed for clarity; its children keep
  their original names, keys and hrefs.

## Unrelated work preserved

Confirmed by `git status` before and after. Untouched: `app/grav-ui.css`,
`app/sales/dashboard/page.js`, `components/shell/FrostShell.js`,
`app/sales/references/`, `lib/crmApi.js`, `components/sales/crm/crmShared.js`,
`AccountForm.js`, the CRM shell components, and all `.DS_Store` files. Nothing
was cleaned, reverted, reformatted or staged.

Files modified this session: `components/Sales_DashboardLayout.js` (nav),
`components/Breadcrumb.js` (label overrides),
`components/sales/crm/shell/LifecycleBar.js` (8 stages from stageConfig),
`app/sales/dashboard/accounts/[id]/page.js` (breadcrumb label),
`app/sales/dashboard/accounts/[id]/_sections/CommercialSection.js` and
`GarmentProfileSection.js` (accept the server permission flag).

Files added: `lib/salesJourney/**` (5), `components/BreadcrumbLabels.js`,
`components/sales/crm/journey/**` (7 + 10 stage files),
`app/sales/dashboard/journeys/**` (4).

## No unauthorized backend work or commit

- **Backend repository untouched this session.** Its `git status` is byte-for-
  byte the same file list as at the end of the Step 01 session — no new
  modifications, no new files except this handoff update.
- No backend model, route, service, migration, seed, dependency,
  configuration or Git setting was changed.
- No demo-data seeding was run.
- **Nothing was committed or staged in either repository.** Frontend branch
  `risheesales`, backend branch `rishee`.

---

# Part 7 — CRM Step 01 (earlier session, still current)

> Customer foundation, Garment Sales Profile, and the live Account workspace.
> Unchanged by the Sales Journey work above, except that the Account workspace
> is now also reachable as the Account stage of a journey.

## Completed functionality

**Customer foundation (spec §7)** — `CRMAccount` extended (not replaced) with
multi-role classification, lifecycle stage, tier, credit fields, hierarchy
parent, provenance, normalized name and archive metadata. New entities:
`CRMSite`, `CRMDepartment`, `CRMAddress`, `CRMAccountRelationship`,
`CRMAccountTeam`, `CRMActivity`, `CRMLookup`. `CRMContact` extended with roles,
consent, site/department links and audit stamping. Typed directional account
relationships with inverse labels. Cycle-safe account and site hierarchies;
single-primary enforcement; duplicate detection with confidence; soft archive
with mandatory reason plus restore; activity timeline with derived (never
stored) overdue state.

**Garment Sales Profile (spec §7.2A)** — nested `garmentSalesProfile`
subdocument in four groups: business/product, compliance/quality (one
configurable lookup, deliberately not a hard-coded scheme list),
buying-house/brand (party fields as Account references), and uniform-customer.
Groups 3 and 4 render only for relevant roles. No wearer names, measurements,
entitlements or price lists are stored.

## Backend files (Step 01)

Modified: `constants/crm.js`, `models/CMS_Models/Sales/Account.js`,
`Contact.js`, `routes/CMS_Routes/Sales/accounts.js`, `contacts.js`,
`server.js`, `services/changeLog.js`, `services/crmVisibility.js`,
`package.json`.

New: `services/crmGarmentProfile.js`, `crmDuplicates.js`, `crmHierarchy.js`,
`crmPrimary.js`; models `Site.js`, `Department.js`, `Address.js`,
`AccountRelationship.js`, `AccountTeam.js`, `Activity.js`, `CrmLookup.js`;
routes `sites.js`, `departments.js`, `addresses.js`,
`accountRelationships.js`, `accountTeam.js`, `activities.js`,
`crmLookups.js`; `scripts/seedCrmLookups.js`; `scripts/seedCrmDemo.js`
(**not run**); `jest.config.js`; `test/setup.js`; `test/crm/*` (8 files).

## Database and API changes (Step 01)

Collections (Mongoose default pluralization, no underscores): `crmsites`,
`crmdepartments`, `crmaddresses`, `crmaccountrelationships`,
`crmaccountteams`, `crmactivities`, `crmlookups` — alongside pre-existing
`crmaccounts` and `crmcontacts`. `garmentSalesProfile` is embedded on
`crmaccounts`; existing rows do not gain it retroactively and both API and UI
treat a missing profile as empty.

`scripts/seedCrmLookups.js` is idempotent — 212 values across 27 categories.
Account list and detail responses carry
`permissions: { canViewRestricted }`.

**No `SalesJourney` model. No lifecycle field on `CustomerRequest`.
`Account.lifecycleStage` not overloaded.**

## Tests (Step 01)

**60/60 jest tests pass** (`npx jest test/crm`, 8 suites, ~3.5s), confirmed
across four consecutive runs. One run took 141s and reported 14 failures with
mongoose buffering timeouts; it did not reproduce — `mongodb-memory-server`
failed to start promptly under load. Worth knowing if CI shows the same shape.

## Pre-existing repository problems (found in Step 01)

1. `npm run lint` broken repo-wide (eslint not installed).
2. `next build` does not type-check (`ignoreBuildErrors: true`).
3. Client/server disagreed on restricted-field access — fixed via the server's
   `permissions.canViewRestricted`.
4. Recoverable hydration error in `ToastHost` — fixed with a post-mount flag.
5. `ChangeLog.sanitise` truncates nested objects at 500 chars — worked around
   by flattening the profile to dot-paths in the accounts route rather than
   changing shared audit infrastructure.

## Step 01 acceptance criteria

**23 pass, 1 not applicable, 1 partial.** Not applicable: tenant isolation — no
Sales/CRM model carries `organizationId`; that concept exists only in the
Accountant module, so this domain is single-company and there is no tenant
boundary to enforce. **If tenancy is introduced, every CRM model and query in
Step 01 needs revisiting.** Partial: build ✓ and tests ✓, but lint and
type-check cannot pass — both broken/disabled repo-wide.

## Known limitations (Step 01)

- Documents rail is a placeholder; no secure CRM file service exists.
- Nominated laboratory/supplier accept one account each in the UI though the
  model stores arrays.
- Party pickers load up to 500 accounts as plain selects; needs a typeahead
  before the account base reaches the thousands.
- `targetMarkets`/`peakSeasons` are free text, not controlled lookups.
- Ordering/fulfillment/sizing/issue-frequency/freight-mode are plain schema
  enums, so labels derive from the code.
- Hub list has no next-action/merchandiser columns (needs backend aggregation).
- Two manually created test accounts remain in dev Mongo (ACC-0001, ACC-0002).

## Setup commands

```bash
cd grav-cms-backend && npm install
node -r dotenv/config scripts/seedCrmLookups.js   # idempotent; already run
npx jest test/crm                                 # 60/60
```

```bash
cd grav-cms && npm install && npm run build
```

Backend dev runs on **:5050** in this environment (`NEXT_PUBLIC_API_URL`), not
the `:5000` default — port 5000 is taken by macOS ControlCenter/AirPlay.

## Commit status

**Nothing committed or staged in either repository.** Backend branch `rishee`,
frontend branch `risheesales`.

---

# Part 8 — Lead/Prospect module: correction chunk + Prospect capture chunk (this session)

> Two chunks landed in this session, in order. Neither touched Sales Journey,
> ran a migration, or committed anything. This section also backfills the
> Draft Lead chunk and Lead frontend correction sessions that happened
> between Part 1 and this one, which were never separately recorded here —
> see `services/leadQualification.js`, `services/leadReadiness.js`,
> `services/salesAccess.js`, and the Draft/Active Lead workspace split in
> `grav-cms` for that intermediate work; only what changed IN THIS SESSION is
> detailed below.

## 8a — Lead correction chunk (5 items, backend + frontend, both repos)

Fixed five gaps identified after the Draft Lead / Lead frontend chunks were
already live:

1. **Controlled status.** Added `contactAttempted` to the qualification
   vocabulary (`new → contactAttempted → contacted → qualified/nurture/
   disqualified/duplicate → readyToConvert`; `new` may also reach `contacted`
   directly for the one-call-and-it-connects case). Every prerequisite is now
   enforced inside `services/leadQualification.js` — Contact Attempted needs
   a logged outreach attempt, Contacted needs a genuinely successful two-way
   contact, Nurture needs a reason + next action + follow-up date (creates a
   real planned follow-up Activity, same reliability pattern as activation),
   Qualified/Ready to Convert share one checklist
   (`services/leadReadiness.js`'s new `computeQualificationReadiness`), and
   Duplicate requires a genuine, existence-verified Lead/Account link
   (new `Lead.duplicateOf`). Reachable from every entry point: the canonical
   `PATCH /:id/qualification-state`, the legacy `PATCH /:id/stage`, and
   `callSchedule.js`'s call-completion flow.
2. **Activity correctness.** Structured outcomes (`no_answer`/
   `replied_connected`/`meeting_completed`/`other`) enforced only on the
   Lead-scoped activity routes (the shared `CRMActivity` model stays free
   text — Account/Journey activities are untouched). `lastContactedAt` now
   updates only for a genuinely successful contact outcome, on both the
   canonical and legacy activity-logging endpoints. Draft Leads reject
   Activity creation/listing entirely. `GET /:id/activities` gained the
   Lead-level access check it was missing.
3. **Lead information.** New `Lead.requirementCertainty`
   (unknown/suspected/prospect_confirmed/document_confirmed) on the CONFIRMED
   requirement side. Evidence-backed-estimate enforcement moved from a
   client-side Draft-save block to a real server-side check inside
   `computeQualificationReadiness`, gating Qualified — Draft/Active saves are
   never blocked by it now.
4. **Permissions.** `authorizeOwnerSourceChange` in `leads.js`: only a Sales
   manager (`services/salesAccess.js`'s `isSalesManager`) may set
   `assignedTo`/`sourcedBy` to anyone other than themselves, on create or
   update. `assignedToName`/`sourcedByName` are never trusted from the
   client — always resolved server-side via `resolveEmployeeName` against
   `SalesDepartment`.
5. **Lists.** Real `assignedTo=none` filter on `GET /leads` (replaces the
   frontend's fetch-everything-then-filter workaround). `onlyMine=true`
   forces My Drafts to the caller's own drafts even for a manager (previously
   a manager's My Drafts silently showed everyone's).

Backend tests: `test/crm/lead-correction.route.test.js` (new, 28 tests) plus
updates to `lead.test.js`, `lead.route.test.js`, `lead-draft.route.test.js`,
`call-schedule.route.test.js`, `lead-capture.route.test.js` for the new
transition graph/vocabulary. **290/290 passing, 17 suites.**

## 8b — Prospect capture chunk (Chunk 1 of the revised roadmap)

See the top-of-file banner for the product-model summary. Detail:

**Terminology (user-facing text only, no field/DB changes):** Draft Lead →
Prospect (`lib/leadCapture.js`'s `CAPTURE_STATUSES` label), My Drafts → My
Prospects, Save Draft → Save Prospect, Preparing this Lead → Prospect Setup,
Activate Lead → Start Working Lead. A handful of backend error messages that
reach the UI directly were reworded to match (`routes/CMS_Routes/Sales/
leads.js`: "Only a Prospect can start working.", "Only a Prospect can be
archived this way.", "This Prospect is archived and read-only.", "Prospects
don't have Activities yet — start working the Lead first.").

**Quick Capture (`AddLeadDrawer.js`)** now asks, in order: Prospect type
(Organisation by default, was Individual), name, Customer segment (reuses
`industry`), Lead Source, phone/email/website (unchanged, all optional),
City (`city`). Ownership: an ordinary employee sees neither Sourced-by nor
Owner controls and is shown "This Prospect will be credited to you and added
to your worklist."; a manager still sees the Owner selector, unchanged.

**Lead Source vocabulary** (`lib/leadQualification.js`'s `SOURCES`,
`models/CMS_Models/Sales/Lead.js`'s inline `source` enum) extended with
`google`/`linkedin`/`directory`/`field_visit` and relabeled
`website`→"Website Enquiry", `trade_show`→"Exhibition" — additive/relabel
only, existing records and the `walk_in`/`social_media`/`cold_call`/
`existing_customer`/`advertisement`/`other` codes are untouched.

**Prospect Setup (`DraftWorkspace.js`)** rebuilt around exactly: Identity and
contact (`IdentitySection`, now with a Customer segment field), Lead source
and owner (`OriginSection`, Priority field removed — it's Active-Lead-only,
`LeadWorkspace.js` already owns it independently), a new **Initial research
note** section (`InitialNoteSection`, bound to the pre-existing
`organisationNotes` field — deliberately not a new field, and safe to
coexist with `OrganisationResearchSection` in the Active workspace since a
Lead is only ever in one of the two workspaces at a time), and First next
action + due date. The "Additional research" collapsible
(`OrganisationResearchSection`/`CommercialPotentialSection`/
`RequirementSection`/`ProcurementSection`/`EvidenceSection`) was removed from
this workspace only — all five components are untouched and remain fully
live in `LeadWorkspace.js`'s "Supporting details" for an Active Lead.

**"Start Working Lead" is now functional** (previously permanently
disabled). `services/leadReadiness.js`'s `computeReadinessChecks` cut from 7
checks to exactly 5: identity, Lead Source, owner, first next action,
follow-up date. Phone/email/website and duplicate review are no longer part
of the checklist at all — contact info must never be mandatory (verified
live: a Prospect with zero phone/email/website and next action "Research
contact details" starts working successfully), and a possible duplicate is
now informational only (still returned as `leadMatches`/`accountMatches` on
both `GET /:id/readiness` and `POST /:id/activate`, on success or failure,
never blocking). `DraftWorkspace.js` now calls `POST /:id/activate` for
real, flips the Lead to Active, and the caller's own toast — the parent
page's redundant `onActivated` notify was removed to avoid a double toast.

### Backend files changed (8a + 8b)

Modified: `constants/crm.js`, `models/CMS_Models/Sales/Lead.js`,
`services/leadQualification.js`, `services/leadReadiness.js`,
`routes/CMS_Routes/Sales/leads.js`, `routes/CMS_Routes/Sales/
callSchedule.js`, `test/crm/lead.test.js`, `test/crm/lead.route.test.js`,
`test/crm/lead-draft.route.test.js`, `test/crm/call-schedule.route.test.js`,
`test/crm/lead-capture.route.test.js`.

New: `test/crm/lead-correction.route.test.js`.

### Frontend files changed (8a + 8b)

Modified: `lib/leadCapture.js`, `lib/leadQualification.js`,
`app/sales/dashboard/leads/_components/leadSections.js`,
`app/sales/dashboard/leads/_components/LeadWorkspace.js`,
`app/sales/dashboard/leads/_components/AddLeadDrawer.js`,
`app/sales/dashboard/leads/_components/DraftWorkspace.js` (full rewrite for
8b), `app/sales/dashboard/leads/page.js`,
`app/sales/dashboard/leads/[id]/page.js`.

No new frontend files. No component was duplicated — `leadSections.js`
remains the single shared source for both the Prospect and Active Lead
workspaces.

### Tests and verification

- Backend: `npx jest` — **290/290 passing, 17 suites** (final run, both
  chunks included).
- Frontend: `npm run build` — clean, no errors, `/sales/dashboard/leads` and
  `/sales/dashboard/leads/[id]` both compile.
- Live browser, both chunks, against the dev backend on `:5050`: logged a
  `contactAttempted`→`contacted` transition end to end; moved a Lead through
  Nurture with a real follow-up Activity created; exercised the Duplicate
  picker against a live match; confirmed the structured Outcome dropdown.
  For the Prospect capture chunk specifically: captured a Prospect via Quick
  Capture with segment/source/city and no contact info; confirmed the
  Prospect Setup checklist showed exactly 5 items with 3 already met
  (identity/source/owner) and phone/email never appearing in it; filled in
  "Research contact details" as the next action with a due date and no
  phone/email/website; clicked Start Working Lead; confirmed
  `POST /leads/:id/activate` returned 200, the Lead reappeared in the Work
  Queue as an Active Lead ("New", city/source carried through, follow-up
  date set); confirmed My Prospects excludes the now-Active Lead.
- One real dev-DB record was created and left in place during this session's
  live verification: **LEAD-2026-0008 ("QA Prospect Chunk1 Verify Co")**,
  captured as a Prospect and then started as an Active Lead via the UI —
  disclosed to the user; not cleaned up unless asked.

### Known follow-ups (explicitly out of scope, not started)

Chunks 2–5 of the roadmap (Active Lead controlled statuses beyond what 8a
already built, requirement/commercial-potential/qualification UI beyond
what's already in `LeadWorkspace.js`'s Supporting details, secure evidence/
document handling, conversion to Account/Contact/Sales Journey) are not
implemented. `PRIMARY_FORWARD_STEP` in `lib/leadQualification.js` is unused
dead code predating this session, left untouched (out of scope).

## 8c — Correction pass on 8b (this session, immediately after)

Seven issues raised in review of 8b, all fixed:

1. **Prospect Setup too large.** `IdentitySection` (`leadSections.js`) was
   showing designation/Customer segment/state/WhatsApp on top of what Quick
   Capture already asks for. Trimmed to exactly: prospect type, name/company,
   phone, email, website, city. Removed fields stay on the Lead model, just
   not surfaced here — no other UI currently edits them for an Active Lead
   either (see the "what Chunk 2 still needs" note in `current-task.md`).
2. **Owner still shown to ordinary employees.** `OriginSection` was falling
   back to a read-only "Owner: Me" `KeyVal` for non-managers. Replaced with
   the same "This Prospect is credited to you and stays on your worklist."
   message Quick Capture already used — no owner display at all now.
3. **"Lead source recorded" wasn't genuine.** `Lead.source`'s Mongoose
   `default: "other"` let the readiness check pass even when nobody had
   picked a source. Removed the default; `OriginSection`'s Select no longer
   pre-selects "Other" either (now genuinely blank/"Not sure yet" until
   chosen), and its payload omits `source` entirely when unset rather than
   sending an empty string. `Lead.industry`'s matching default was removed
   for the same reason (not gated by any check today, same principle).
   `services/leadReadiness.js` needed no code change — `has()` already
   treated `undefined` as unmet; the schema default was the actual bug.
4. **Customer segment taxonomy was mixed.** The old `industry` option list
   (`garments`/`retail`/`wholesale`/`export`/`corporate`/`school_uniform`/
   `hospitality`/`healthcare`/`other`) conflated industry, buyer type and
   programme. Replaced with one consistent "what type of buying
   organisation" taxonomy: Corporate/Staff Uniform, Institutional (School,
   Hospital, Government), Hospitality, Retail/Fashion Brand, Export/
   International Buyer, Distributor/Wholesaler, Individual Consumer, Other
   (`CUSTOMER_SEGMENT_OPTIONS` in `leadSections.js`). The backend enum
   (`models/CMS_Models/Sales/Lead.js`) keeps the old codes too — additive,
   no migration, existing records with old values still validate — the old
   codes just aren't offered in the UI anymore. `OrganisationResearchSection`
   (Active Lead's "Supporting details") relabeled its "Industry" field to
   "Customer segment" to match, using the same option list.
5. **Evidence document upload was exposed but unsecured.** `EvidenceSection`
   let a salesperson attach a file through the app's general Cloudinary
   uploader, unscoped for evidence documents. The upload control (and its
   now-dead plumbing — `uploadEvidenceFile`, the `onFile` handler, `fileRef`,
   `uploading`/`uploadError` state) was removed; a note explains upload isn't
   available yet and points to Source URL / Document reference instead. An
   entry that already has an attachment from before this fix still shows it
   read-only (view/remove), only new uploads are blocked.
6. **`docs/tasks/current-task.md` was stale**, still describing an old
   six-chunk "Lead Chunk 2 — Lead Inbox" plan that predates the Prospect/
   Active Lead product model entirely. Rewritten to reflect the actual
   current chunk (Prospect capture — done) and to document, for whoever
   picks up Chunk 2 next, that meaningful controlled-status/qualification
   work already exists from the "Lead correction chunk" (8a) — Chunk 2 is
   not a blank slate. `docs/tasks/lead-to-journey-roadmap.md`'s status line
   was marked superseded, pointing to `current-task.md`; its body was left
   as historical record, not rewritten.
7. **Disclosed test record.** Asked the user whether to delete
   `LEAD-2026-0008` now rather than assuming either way.

### Files changed in this correction pass

Backend: `models/CMS_Models/Sales/Lead.js` (source/industry enum + default
removal), `test/crm/lead-draft.route.test.js` (readiness assertions updated
for the genuine source check), `docs/tasks/current-task.md` (rewritten),
`docs/tasks/lead-to-journey-roadmap.md` (status line only).

Frontend: `app/sales/dashboard/leads/_components/leadSections.js` (all five
UI fixes — `IdentitySection`, `OriginSection`, `CUSTOMER_SEGMENT_OPTIONS`,
`OrganisationResearchSection`, `EvidenceSection`/`EvidenceEntry`),
`app/sales/dashboard/leads/_components/AddLeadDrawer.js` (Customer segment
option list rename).

### Tests and verification (correction pass)

- Backend: `npx jest` — **291/291 passing, 17 suites.**
- Frontend: `npm run build` — clean.
- Live browser: opened an existing Prospect and confirmed the trimmed
  Identity and contact section, the genuinely-unmet "Lead source recorded"
  checklist item with a real "Not sure yet" placeholder (not silently
  "Other"); opened an Active Lead's Supporting details and confirmed
  "Customer segment" shows the new taxonomy and the evidence document field
  shows the "not available yet" note instead of an upload control.

## 8d — Prospect → HOD Review → Active Lead approval workflow (this session)

The Prospect lifecycle gained a real internal approval gate. See the
top-of-file banner for the summary; detail below.

### Data model (no migration)

- `reviewStatus` on `Lead` (constants/crm.js `LEAD_REVIEW_STATUSES`):
  `researching` (default) → `submitted` → `approved` | `returned` |
  `rejected`. A THIRD axis, independent of captureStatus and
  qualificationState. A missing value reads as "researching".
- `pursuitJustification` ("Why should we pursue this?") — distinct from
  `requirements` (a CONFIRMED requirement), `notes`, `organisationNotes`.
- Review audit: `submittedAt`/`submittedBy`, `reviewedAt`/`reviewedBy`,
  `reviewReason` (required on return + reject).
- A directly-created Active Lead (the legacy one-shot `captureStatus:"active"`
  path) is stamped `reviewStatus:"approved"` — it never went through review.

### State machine — `services/leadReview.js` (new)

Single writer of `reviewStatus`, mirroring `services/leadQualification.js`'s
discipline. Pure/DB-free; validates transitions + stamps audit; the route
does authorization (needs req.user) and the captureStatus flip / Activity
creation. `applySubmit` (researching|returned → submitted),
`applyApprove` (submitted → approved; route flips captureStatus + creates the
first Activity), `applyReturn` (submitted → returned, reason req.),
`applyReject` (submitted → rejected AND captureStatus → archived, reason
req.). `LeadReviewError` for 4xx.

### Submission readiness — `services/leadReadiness.js`

`computeReadinessChecks` (the retired 5-item "start working" bar) REPLACED by
`computeSubmissionReadiness` — the ~11-item Submit-to-HOD checklist: identity,
Lead source, customer segment, justification, annual quantity + confidence,
annual revenue + confidence, at least one evidence URL/doc-ref, first action +
due date. `computeQualificationReadiness` (Active-Lead qualification)
untouched.

### Routes — `routes/CMS_Routes/Sales/leads.js`

- **Retired** `POST /:id/activate` (the salesperson's direct "Start Working
  Lead"). There is now no direct Prospect→Active path.
- `POST /:id/submit` — rep (creator/owner/manager). Enforces submission
  readiness server-side (returns `checks` on 400). researching|returned →
  submitted.
- `POST /:id/approve` — **HOD/admin only** (`isSalesManager`). The ONLY
  Prospect→Active Lead path. Optional `assignedTo` owner override (name
  server-derived). Keeps the create-Activity-then-flip-then-rollback
  reliability pattern; `qualificationState` stays "new".
- `POST /:id/return-for-info` — HOD only, reason required → returned.
- `POST /:id/reject` — HOD only, reason required → archived + rejected.
- `refuseIfArchived` → `refuseIfLocked` (archived OR submitted → 409). Applied
  to PATCH /:id, review-duplicates, archive-draft — a submitted Prospect is
  read-only for everyone at the field level.
- `GET /:id/readiness` now returns submission checks for a draft (qualification
  for an active Lead). `pursuitJustification` added to `LEAD_EDITABLE_FIELDS`
  (reviewStatus + audit fields are NOT editable via PATCH).
- `services/leadQualification.js` draft-guard message reworded ("get the
  Prospect approved as an Active Lead first").

### Frontend

- `lib/leadReview.js` (new) — review-status labels/tones, `reviewStatusOf`,
  `effectiveReviewStatus`.
- `leadSections.js` — new `PursuitCaseSection` (customer segment + "Why should
  we pursue this?").
- `DraftWorkspace.js` (rewrite) — by reviewStatus: researching/returned show
  the submission checklist + Submit/Resubmit (gated on readiness) with the
  returned-reason banner; submitted locks every section via a native
  `<fieldset disabled>` and shows an "In Review" banner; a HOD (canReview)
  additionally sees the review panel (Approve + optional owner select, Return
  w/ reason, Reject w/ reason). Enrichment sections (Identity, Lead source,
  Pursuit case, Commercial potential, Evidence, Initial note, First action)
  are the SAME shared components; document upload stays hidden.
- `[id]/page.js` — header chip shows the review status for a Prospect; passes
  `salesUsers` + `canReview` to DraftWorkspace; `onActivated`→`onApproved`.
- `page.js` (My Prospects list) — each row shows a review-status chip.

### Tests and verification

- Backend: `npx jest` — **299/299, 18 suites.** New
  `test/crm/lead-review.route.test.js` (20 tests): begins researching;
  submission readiness (incl. both confidences + evidence); submit state;
  submitted read-only 409; HOD-only approve/return/reject; approve →
  Active Lead with default + overridden owner; approval reliability rollback;
  `/activate` gone (404); return → editable → resubmit; reject → archived.
  `lead-draft.route.test.js` updated (the retired activate/readiness blocks →
  submission/approve model).
- Frontend: `npm run build` clean.
- Live browser (manager account): submitted a ready Prospect (LEAD-2026-0010)
  → 200; confirmed header "In Review" chip, read-only banner, all inputs +
  Save buttons functionally disabled (native fieldset), Submit button gone,
  HOD review panel present; approved → 200, Prospect became an Active Lead
  (`captureStatus:active`, `reviewStatus:approved`, `qualificationState:new`,
  owner = creator, planned first Activity created). Separately drove a
  Prospect (LEAD-2026-0009) submit → return; confirmed the "Returned" chip,
  the return-reason banner, sections editable again, and a "Resubmit to HOD"
  button.

### Test records left in the dev DB (disclosed)

This session's browser verification left these in the dev database, alongside
the earlier LEAD-2026-0008 / LEAD-2026-0010 the user asked to keep:
- **LEAD-2026-0010** ("QA OwnerRemoval Verify Co") — submitted then APPROVED;
  now an Active Lead.
- **LEAD-2026-0009** ("cc") — submitted then RETURNED; still a Prospect.
Happy to clean any of these up on request.
