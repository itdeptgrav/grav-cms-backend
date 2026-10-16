# Sewing completion is QC's in-line pass; Ops QR on the Overview; orders newest first (15 Oct 2026)

**Not committed.** Owner: the supervisor's Sewing Completion scan page
duplicated a scan QC already makes — a piece that passes the FIRST QC
checkpoint (in-line, end of the sewing line) is sewn. So:

- `services/manufacturing/sewingCompletion.js` is the one writer of
  `productioncompletionscanrecords`: `recordSewingCompletion` (the old
  mark-done logic, moved: format, work order, quantity, optional route rule,
  recorded-once-ever dedup, bucketed by the IST day the scan HAPPENED) and
  `completeFromQcPass` (records when the verdict is `passed` at the
  lowest-serial active stage, or when no stages are configured; never
  throws). `isCompletingStage` is pure and tested
  (`sewingCompletion.test.js`, 6/6).
- `POST /manufacturing/qc/save-inspection` and `/save-inspection-offline`
  call it after the verdict is written and answer `sewingCompletion:
  {attempted, recorded, alreadyRecorded, skippedReason?}`; the offline path
  uses the device's `recordedAt`. The CMS station toast adds "recorded as
  sewn".
- `POST /production-completion/mark-done` still works for any older caller,
  through the same service. `/preview` unchanged.
- CMS: the Sewing Completion nav entry and page are gone (the URL forwards to
  the Overview); the Ops QR button moved from the tracker's More menu to the
  Overview header; the Orders page opens on "Newest" (was "Deadline"), and
  every "scanned on the Production Record page" wording now says the first
  QC checkpoint.

Checked 15 Oct 2026 against the dev server with scratch pieces of a Black
Pant work order (all removed afterwards): P1 pass → recorded (by the
inspector's name); P2 pass on the same piece → `not-first-stage`, no second
row; P1 defect → `not-a-pass`; the rework pass at P1 → recorded; offline P1
pass → recorded at the device's time; legacy mark-done of the first piece →
"already recorded earlier", "hello" invalid. Browser: Overview shows Ops QR
and opens the panel, nav without Sewing Completion, Orders sorted
newest-first (10 Aug, 03 Aug, 25 Jul…), `/production-record` lands on the
Overview, tracker More menu without Ops QR. Known, pre-existing, not changed:
the offline QC route's own parser reads only the 8-hex barcode form.

---

# Cmd/Ctrl K: GRAV Music and desktop apps missing from Apps (10 Oct 2026)

**Not committed.** Typing "music" in HR's Cmd/Ctrl K gave "Nothing in HR is called
that." The cause: the onboarding portal adds two kinds of tile that
`grav-cms/components/shell/useMyApps.js` (the list the switcher and Cmd/Ctrl K
read) did not. Those are GRAV Music (`musicTileFor`) and the native apps the
desktop build carries, like GRAV Video (`desktopTilesFor(desktopInfo())`).
`useMyApps` now adds both, and `openApp` launches a `desktopApp` tile with
`launchDesktopApp` the way the portal does. Music opens through the existing
`directHref` path.
Checked on the test stack (store@e2e.test): "music" → GRAV Music (Apps, with its
logo), and Enter → /music. Shell tests 368/369; the 1 failure is the
pre-existing route-map test (/cctv, /dev, /face-enroll).

---

# Cmd/Ctrl K: closest matches with a warning instead of "no match" (9 Oct 2026)

**Not committed.** Owner: "we can't do verbatim, we need to show best possible
results while giving a small warning". When a NAME matches nothing exactly,
Store, HR and Accounting now return the closest records the person can
already see, under an amber note: `No exact match for "<what was said>" — closest matches.`
- Shared scorer `services/ai/commandSearch/closest.js` (pure). It compares
  word by word: exact, sound-alike Indian spellings (Ravee/Ravi), prefix, stem,
  and one typo (two in long words). It ignores of/off and question words. At
  least one word must really match, and most of what was said must be covered.
- Store: `search` wraps the old one (now `searchExact`). It falls back only on
  no_match or unsupported, and never when the question carries a reference
  number, a filter or a date. Candidates come from `identityRows` (cached)
  within the person's scope.
- HR: `closestInHr` covers employees, departments, jobs, policies and
  holidays, each family gated by its capability. Accounting: `closestInBooks`
  covers the company's ledgers, stock items and groups.
- Frontend: `CommandPalette` shows the note as a warning row
  (`data-command-approximate`, `.cmdk-approx`). Voice says "I couldn't find
  exactly that. The closest match is …".
- Checked:
  - Live dev, read-only, 0 writes:
    - "Feed Off Arm" → Feed of the Arm folder 1/4
    - "mushrom buton" → MUSHROOM BUTTON
    - "macbok air" → MacBook
    - "PO/2026-27/9999" and "zzz qqq" → still no match
  - e2e browser: "macbok" → warning plus Macbook / Macbook Pro 14. The e2e seed has
    no cotton item, so "cotton fabrik" correctly offers nothing.
  - Suites:
    - Store/HR/Accounting command search, Jest: 31 suites, 404/404.
    - Frontend voice and speech: 20/20.
- Not done: near-match answers are not recorded in the missed-search report.

---

# Store: "stock of feed of the arm folder" answered about "Folder" (9 Oct 2026)

**Not committed.** Found by voice. `services/inventoryItemContext.js`
`resolveInventoryItem` picked the item whose WHOLE name sits inside the words
("Folder"), over "Feed of the Arm folder 1/4" that every word belongs to (the
"1/4" is never said). Now, when the whole-name winners cover only some of the
words and other items cover all of them, those win (one → the answer, several
→ a choice); "stock of folder" still finds Folder. Live dev data (read-only,
0 writes): "stock of feed of the arm folder" → Feed of the Arm folder 1/4,
2 Pcs. Test `test/hr-ai/storeMaterialByWords.test.js` (3). Store/HR/Accounting
command-search suites 31 files, 400/400 (incl. the matrix).
Voice: "stock off X" → "stock of X" (`voiceToQuery`, after question words only).

**Also found and fixed — a "read-only" path that wrote.** Loading Store's
search loads the accounting voucher model, which reconciles `acc_vouchers`
(two `updateMany` on `isLive` + `createIndexes`) — IMMEDIATELY if the
connection is already open. My probe recorded 3 writes against the live dev
DB; result 0 documents modified, "all indexes already exist" (16 before and
after) — no data changed. `scripts/reports/store-command-misses.js` now loads
every search BEFORE connecting with that one listener dropped
(`withoutVoucherReconcile`); the earlier Accounting guard had the same hole
(it ran after connecting). Re-run: 0 writes.

---

# Voice: no orb; one clear "speak now" moment (9 Oct 2026, evening)

**Not committed.** Owner: "orb is also opening, pls remove … waveform and
listening sound don't match, I'm not sure when to speak."
- The voice orb is retired (`SHOW_VOICE_ORB = false` in GravAssistantOverlay);
  turns show only in Cmd/Ctrl K.
- New stage "opening" while the mic opens (still faint line, "One moment…");
  "listening" only when the recorder is RUNNING — set together with a new
  rising two-note chime (`playCue("start")`), placeholder "Speak now…"; a soft
  falling note (`playCue("end")`) when it stops listening, then "Thinking…".
  The old "mm-hmm" on a 200 ms timer (before the mic was ready) is removed;
  the no-speech timer now counts from the recorder start.
- Measured in Chrome: opening 293 ms → recorder 311 ms → chime 313 ms →
  "Speak now" 328 ms; end note → Thinking → Speaking → idle; no orb.

---

# Hindi and Odia voice commands — said in the script, answered in English (9 Oct 2026)

**Not committed.** Owner's ask: "if someone speaks Hindi, write Hindi text and
then translate to English; same with Odia."
- Pod: translator `/root/grav-voice-mt/server.py` (IndicTrans2 indic-en
  dist-200M, AI4Bharat, MIT; gated — granted to HF account grav111 and its
  fine-grained token now has "read public gated repos") on 127.0.0.1:19058,
  venv `/root/grav-voice-mt/venv` (uv, system torch; `/workspace` can't hold a
  venv — no chmod on that volume), weights `/workspace/hf-cache/hub`
  (`HF_HUB_CACHE`, NOT `HF_HOME` — that also moves the sign-in token and every
  download went out unauthenticated). Start: `/root/grav-voice-mt/run.sh`.
- Speech server: `X-Langs: en,hi,or` → transcribe as English AND in the
  heard script; the model's language-ID alone is unreliable (Indian-accented
  English came out labelled Hindi, in Devanagari), so a reading whose
  translation says the same words as the English transcript (after joining
  spelled digits) was English. Otherwise → `{text: English translation,
  original: what was said, lang}`. No translator → English, as before.
- Measured: real Odia recordings (benchmark set with truth) → Odia at
  confidence 1.00, transcripts ≈ truth, fluent English; Hindi "रवि कुमार की
  छुट्टी कितनी बची है" → "how much leave does ravi kumar have left";
  English kept English ("Show me GR0067"). ~0.5–1 s a short command.
- Backend `sttEngines.js` sends X-Langs (env `GRAV_INDIC_STT_LANGS`, default
  en,hi,or; 12 s cap) and passes `original`/`lang` through the transcribe
  route. Frontend: the palette shows a line under the box — "HINDI रवि कुमार…"
  / "ODIA …" — above the English it searches. HR Cmd/Ctrl K learned the
  translated phrasings: "how much leave does X have left", "vacation",
  "who is missing today" (= absent). Browser-checked: both answered and read
  aloud; AI assistant calls 0. HR tests 32/32; frontend 382/383 (known).
- Not done: answers are spoken in English (not Hindi/Odia); Ctrl K for Store/
  Accounting has not been taught translated phrasings; synthetic Hindi voice
  misheard "Ravi" as "रविवार" (real speech untested).

---

# "Hey GRAV" speech-to-text on the RunPod GPU — Indic-Transcribe-Flex (9 Oct 2026)

**Not committed.** Owner's ask: use their RunPod pod `grav-stt-romanizer-v2`
(id 2rnk6usdaxaq78, RTX 2000 Ada 16 GB) for Bodhan AI / AI4Bharat's
Indic-Transcribe-Flex, which was already on the pod (`/root/indic-transcribe-flex`,
venv `/root/indic-flex-venv`).
- Pod: GRAV's own server `/root/grav-voice-stt/server.py` on **127.0.0.1:19057**
  only (no public port, no pod settings changed); `run.sh` (re)starts it by its
  own pid file. Copies kept in `services/ai/runpod/`. Another agent's benchmark
  worker (`flex_worker.py`, :19038) was left untouched.
- Mac: SSH tunnel, launch entry `grav-indic-tunnel` (127.0.0.1:19057 → pod).
  Backend `.env`: `GRAV_INDIC_STT_URL=http://127.0.0.1:19057`.
- Backend: `services/ai/sttEngines.js` — Indic first (8 s cap), local Whisper on
  any failure; `routes/ai/assistant.js` transcribe route calls it (small edit;
  that file also carries another lane's uncommitted changes).
- Settings measured on the pod: language GIVEN as English (the model's own
  language-ID is weakest for Hindi — it turned "show me" into "show mein" and a
  code into "Saat"), mode `mixed` (digits stay digits: "3rd October"); spelled
  codes rejoined ("GR zero zero six seven" → "GR0067"); a warm-up before ready
  (the first clip after load was wrong, warm ones exact). ~0.3 s a command on
  the GPU, ~1 s end to end through the tunnel. Fallback proven (tunnel port
  closed → Whisper, same text).
- Not done: Hindi/Hinglish commands ("…balance batao" → "battery") need Ctrl K
  vocabulary first; the pod server does not restart itself when the pod
  reboots (`/root/grav-voice-stt/run.sh`); the tunnel stops when the app stops
  preview servers — voice then uses Whisper until it is reopened.

---

# "Hey GRAV" voice → Cmd/Ctrl K, not the AI assistant (9 Oct 2026)

**Not committed.** Frontend only (grav-cms).
- A spoken command now goes into the SHARED palette on screen, exactly as if
  typed — same search, permissions and ranking, no model — and the palette's
  own answer is read aloud. "open …"/"go to …" runs the top result.
  Only a page with no palette falls back to the AI assistant.
- `lib/commandSearch/voiceBridge.js` (+test): the shell registers as the
  answerer (`answerVoiceAsks`), the overlay asks (`askCommandPalette`);
  filler ("hey grav, can you tell me…") is dropped; 9s cap on waiting.
- `CommandPalette.js`: `ask` prop — puts the words in the box, waits for the
  provider to settle, says `spokenFor(top)` (answer sentence / record name +
  its line / "Found <page>"), or runs the top result for "open…".
  `FrostShell.js` registers and passes `ask`. `GravAssistantOverlay.js`: the
  voice turn's one send line (another lane's uncommitted link/choice edits in
  that file untouched).
- Proven in Chrome (fake mic, transcription stubbed): "pending leave requests"
  → palette shows HR's 2 requests, reads "2 pending leave requests."; "open
  muster roll" → navigates, says "Opening Muster Roll."; "who is GR0067" →
  Ravi Kumar's card, reads "Ravi Kumar, GR0067, Cutting, Tailor." AI assistant
  calls: 0. Journeys HR 21/21, Store 24/24; frontend 688/689 (known route map).

**The voice turn now lives IN the palette (after "not working", 9 Oct):**
the owner's screenshot showed Ctrl K open and empty — the turn ran in the
assistant's orb and the palette only appeared after transcription, so a
missed or empty turn looked like nothing at all. Now "Hey GRAV" opens Ctrl K
at once, listening ("Listening…" pill + placeholder), then "Transcribing…",
the words, the answer read aloud ("Speaking"); a missed turn says "Didn't
catch that". The orb is hidden where a palette answers. A mic button in the
box starts a turn without the wake word; Esc/closing stops listening.
Bridge: `setVoicePhase`/`onVoicePhase`, `registerVoiceCapture`. Checked in the
owner's Chrome on :3001: Vosk loads and listens; transcription 200 via the
backend (290 ms); the box mic opens a listening turn with no orb.
Note: end-of-speech detection runs on animation frames, which Chrome pauses
in a background tab — a turn in a hidden tab waits until it is shown.

**"Stuck on didn't catch that" (9 Oct):** two causes, both fixed.
1. One-breath "Hey GRAV, <command>": Vosk reports the wake only when the whole
   utterance ends, so the command recorder opened after the command and heard
   silence. `lib/voskWake.js` now keeps the last 8 s of audio and hands it over
   with the wake (`wavFrom` → 16 kHz WAV); the overlay transcribes it first and
   answers what follows the wake phrase (`afterWake`), listening only when the
   wake came alone. Real Whisper output checked: "Hey grab pending leave
   requests" → "pending leave requests"; "Hey Graham" → listen. Accepted
   spellings widened (grab, Graham, gravy, groove…).
2. A fixed speech threshold (0.045 RMS) missed soft voices / quiet mics. Now
   per turn: the room's quietest frame in the first 450 ms × 2.5 + 0.006,
   between 0.012 and the old 0.045.
A miss now says why in the box ("No speech heard…", "Couldn't make out the
words…", "The microphone isn't available…") and clears after 5 s; the palette
also opens on "Transcribing…" (a one-breath turn skips listening).

**Orb behaviour, waveform look (owner's ask, 9 Oct):** the in-box pills,
"Didn't catch that" and "Try again" are gone. The palette now does exactly
what the orb did — listening → thinking → speaking → idle, and a turn that
heard nothing simply ends while "Hey GRAV" re-arms — drawn as a live waveform
(`components/shell/VoiceWave.js`, canvas; the mic level arrives per frame
through `emitVoiceLevel`/`onVoiceLevel`, no React render per frame). Listening
follows your voice; thinking/speaking breathe. Placeholder says
Listening… / Thinking… / Speaking…. The idle mic button stays (tap-to-talk).
Checked in Chrome (fake mic): listening wave → thinking wave → words in the box
→ "2 pending leave requests." → back to the mic button; no orb.

**Spoken answers made human (9 Oct):** `lib/commandSearch/speech.js`
(`speakableAnswer`, `forSpeech`) turns the result on screen into sentences —
no model, no new facts (a test checks every word comes from the screen). A
list = its sentence + the first 3 rows (+ "and N more on screen"), skipping
what the sentence already said; a person = "Ravi Kumar is a Tailor in Cutting,
reporting to Asha Mehta. Joined on 2nd October."; money in rupees/lakh/crore;
dates "8th October" (year only if not this year); Dr/Cr → debit/credit;
PO/2026-27/0013 → "P O number 13"; Mtr → metres; statuses lowered, names not.
Voice choice: premium/enhanced first, then Indian English (Tara, Aman, Isha,
Veena, Rishi), then the old US chain. Checked through the real palette:
"There are 2 pending leave requests. Ravi Sharma, privilege leave, 20th to
22nd October, 3 days, approved by the manager. …"; "For 2026, Ravi Kumar has
3 of 7 casual leaves, …"; "1 person was absent on 8th October. Ravi Kumar
from Cutting." Tests 380/381 (known route map).

**Then set up, with the owner's OK (9 Oct 2026):**
- Whisper rebuilt: the broken venv moved aside to `~/.grav-stt-venv.broken-ros2`;
  new `~/.grav-stt-venv` on Homebrew Python 3.12 with the pinned
  requirements; `small.en` downloaded. Running on 127.0.0.1:5757 (launch entry
  `grav-stt`); the backend reaches it per request, so the already-running
  backend uses it, and its boot check finds it up and spawns no second copy.
  Spoken test phrases ("pending leave requests", "who is absent today",
  "open muster roll", "leave balance of Ravi Kumar") transcribed exactly.
- Vosk enabled: `NEXT_PUBLIC_VOSK_MODEL_URL=/vosk/model.tar.gz` added to
  grav-cms `.env.local` (model served from `public/vosk/`). Not confirmed in a
  signed-in page; if "Hey GRAV" still uses Web Speech, restart the frontend.

**Found earlier (now addressed above):**
- Vosk wake word is OFF here: the model is in `public/vosk/model.tar.gz` and
  `vosk-browser` is installed, but `NEXT_PUBLIC_VOSK_MODEL_URL` is not set in
  `.env.local`, so "Hey GRAV" uses the browser's Web Speech (audio to Google
  in Chrome). Enable: `NEXT_PUBLIC_VOSK_MODEL_URL=/vosk/model.tar.gz`.
- Command transcription is OFF here: `~/.grav-stt-venv` was built on
  `~/miniconda3/envs/ros2`, which no longer exists, so the Whisper sidecar
  cannot start and every voice command comes back empty. Rebuilding needs a
  new venv + `pip install -r services/ai/requirements-stt.txt` + the
  `small.en` model download (~0.5 GB).

---

# Cmd/Ctrl K motion — Spotlight-like, in every application (8 Oct 2026, late)

**Not committed.** Frontend only (grav-cms), in the ONE shared palette, so
every application changes together:
- Opens by rising a few px from 96.5% scale on a fast-out curve (240ms) as the
  backdrop fades; closes faster (140ms) — the surface stays mounted, marked
  `closing` and untouchable, then unmounts (`PALETTE_EXIT_MS`).
- The panel's height follows the results (200ms) — grows at once, and only
  shrinks once a search has settled, so typing never dips it to "Searching…".
- The selection is one highlight that glides between rows (140ms) instead of
  each row toggling its background; a row paints its own until the highlight
  is measured, so the server render still shows the active row.
- `components/shell/CommandPalette.js`, `app/grav-ui.css` (`.cmdk-*`).
- Found while measuring: the low-performance shell (HR's, QC's default)
  crushes every animation to 0.01ms with `!important`, so none of it ran there.
  Exempted the palette as the file already exempts spinners and the QC stage
  (transform/opacity only); `prefers-reduced-motion` still wins with a plain
  short fade.
- Measured in Chrome on HR (low-perf): open opacity 0.55→0.88→0.95→1 while
  rising; glide 4→21→32→36→38→40px over six frames; height 416→321→148px;
  close fading at 50ms, gone by 300ms; reduced motion = fade only.
- Frontend shell/HR/Store/Accounting tests 654/655 (the known route-map one).
  Journeys re-run: Store 24/24, HR 21/21, Accounting 19/19.

---

# Cmd/Ctrl K for HR — the whole app, gated by HR's own roles (8 Oct 2026, night)

**Not committed.** HR's Cmd/Ctrl K now searches HR's records, not only its
pages, on the shared palette (same dialog, rows, cards as Store and Accounting).

**What it answers** (`services/ai/hrCommandSearch.service.js`, no model):
a person by code / name / work email (card: ID, department, designation,
reports to, joined, type, work email, work phone); departments (card: head,
headcount), designations ("tailors" lists who holds it); people filtered by
department, designation, manager ("Asha's team"), type (interns, contract),
status (inactive), joining date ("new joiners this month"); attendance — a day
at a glance, who was absent/late/on leave on a day, one person's day with
punches or month tally; leave requests (pending = awaiting manager OR HR, by
type, person, period), leave balance (calendar year), holidays (next, by
period, by name); attendance corrections; overtime; job openings ("open" =
published), candidates by stage/opening, interviews; HR letters by reference
no., type, person, request status; payroll runs by month and status only;
C4 policies. Counts and "latest N" throughout.

**Rules held, each pinned by a test (31 in `hrCommandSearch.test.js`):**
- Door: `GET /api/hr/command-search`, under `hrContract` like every HR route,
  declared (`hr.access`) in `hrRouteContract.js`, in `hrMountRegistry.js`.
  Each family then needs the SAME capability its own screen declares (test
  compares against the route contract). Viewer: no payroll; CEO projection:
  no recruitment, no letters — not even inside a name search.
- Never shown, whatever the role: pay, bank, statutory ids, personal phone /
  email, address, DOB, family, medical, credentials, per-person pay, payroll
  amounts, a candidate's contact or expected salary, a leave's reason, a
  letter's CTC or HR notes. Projections are allow-lists; a planted-secrets
  sweep runs ~20 questions as an HR OWNER and finds none. Private phone /
  email typed in are not searched.
- A named person nobody has → nothing, never the whole list. More than 5
  matches → "add the surname or employee ID". A date range on a family with
  several dates must say which ("joined", "applied", "published", "issued").
- Mutation checks: removing the capability gate, reading `phone`, or dropping
  an unknown person each turn the suite red.
- Misses: `POST /api/ai/hr/command-search/miss` (HR's `seedIdentity` +
  `requireHrCapability(hr.access)`; not under /api/hr, where a POST would be
  queued for approval), `app: "hr"`, same anonymous 90-day list.
- Every HR collection decided (`hrCommandExclusions.js`): 14 searched, 11 left
  out with reasons (payroll items, settings rows, face photos/invites, …).

**Shared changes (help Store and Accounting too):**
- `storeCommandIntent.dateRangeFrom`: "on 3 Oct 2026" was read as ALL of
  October (broader than asked). A dated day — 3 Oct 2026, Oct 3 2026,
  2026-10-03, 03/10/2026 — is now that one day; 31 Feb is refused.
- New `services/ai/commandSearch/words.js` (period words incl. this/last/next
  week, tomorrow, next month, "3 Oct"; plural-aware name matching; `strip`
  now takes "policies" with "policy"). Accounting uses it (its copies removed).

**Frontend (grav-cms):** `lib/hr/commandProvider.js`, `lib/hr/commandPages.js`
(+test: all 43 HR pages accounted for — menu 27, palette 6, records 5, left
out 6 with reasons; create forms `minRole: editor` through the menu's own
`filterHrNav`), `components/Hr_DashboardLayout.js` (+10 lines).

**Verification:** backend Cmd K gates 35 files — 433/434 pass; the 2 red files
pre-date this (3 undeclared attendance/face routes in `route-coverage`, at
HEAD; `accountingReportQuery`, one of the 7 known red). Store matrix passes.
Browser: HR journey **21/21** (`scripts/e2e/hr-command-journey.mjs`: editor
and viewer through the real login; Store person refused by HR's guard; no
planted value on screen), Store **24/24**, Accounting **19/19**. Frontend
shell + HR + Store + Accounting tests: all new pass; 3 red are pre-existing
(attendance-page transport contract at HEAD; route map `/cctv,/dev,/face-enroll`).
**Live dev data, read-only:** 17/17 answers equal a direct count (107
employees, 222 attendance days, 558 leave requests), **0 writes**. Privacy
sweep over 15 real people with private values on file, 90 questions as an HR
owner: no statutory id, bank detail, personal email or leave reason appeared.
One person's personal and alternate phone are the same number as their WORK
phone, so that number shows as "Work phone" — as the Employees directory
already shows it. A data question for HR, not a code leak.

**Weekly look:** `node scripts/reports/store-command-misses.js --app hr` re-asks HR's
unanswered searches with the widest HR role (read-only; tested). None recorded yet.

**Owner decisions surfaced:** "pending" leave = awaiting manager or HR;
"open" jobs = published; pay is not in Cmd/Ctrl K at all; "this year" in HR
is the calendar year (the books keep the financial year).

---

# Cmd/Ctrl K opens the other applications (8 Oct 2026, evening)

**Not committed.** In every application on the shared shell, Cmd/Ctrl K now
lists, under **Apps**, the other applications this account holds, plus
"All applications" (the portal). Typing "hum" in Store offers Human
Resources; Enter opens it.

- Same list as the top bar's app switcher (`useMyApps`: the verified session's
  departments + Costing/Board/Marketing/CCTV/Voice tiles), fetched the first
  time the palette opens and shared with the switcher. Opened by `openApp` —
  the department switch / SSO handoff that re-checks the grant on the server.
  No new access logic anywhere.
- Each app row shows that app's own logo (`DepartmentIcon`, the portal's and
  switcher's mark: uploaded logo, else built-in glyph, else initials).
- The app on screen is not offered. A page with the same name ranks above
  the app (Pages group first). A refused switch is said on screen.
- Files (grav-cms): new `components/shell/appCommands.js` (+ test, 8 cases);
  `FrostShell.js` (Apps group, lazy load, refusal notice); `AppSwitcherNav.js`
  now takes its name rule from `appCommands.js` (one rule for both).
- Backend: e2e seed adds `twoapps@e2e.test` (Store + HR); the Store browser
  journey gains 4 steps — held app offered, unheld app not, current app not,
  Enter lands exactly where the server's switch sends HR. **24/24.**
  Accounting journey re-run on the changed shell: **19/19.** Shell + Store +
  Accounting frontend suites 377/378 (the one failure is the known
  `/cctv,/dev,/face-enroll` route-map test from other lanes).
- Reach: every application layout in grav-cms renders through `FrostShell`
  (directly, via `AppShell`/`FinishingShell`, or via `AutoDashboardLayout`,
  which only picks one of those), so every app has it. External apps (CoWork,
  Material Requests) are offered and opened by SSO, but have no Cmd/Ctrl K of
  their own once you are in them.

---

# Cmd/Ctrl K — Accounting: proven on live data, repeatable journey, weekly report (8 Oct 2026, later)

**Not committed.** Follows the section below.

**1 · Live dev books, read-only** (one company, GRAV CLOTHING PVT LTD: 1,959
vouchers, 489 ledgers, 47 groups, 0 stock items). A probe built its questions
from real records and checked every figure against an independent count:
16 correct, 0 wrong, **0 writes** (the voucher model's open-time index
reconcile was kept from loading, and every query was watched). Examples:
"how many vouchers" 1,959 · total posted sales ₹2,79,99,865.51 · a real
customer's balance ₹25,750 Dr · a GSTIN → its ledger · 50–480 ms.
It found two defects the fixture never could, both fixed and now tested:
- "sales vouchers this FY" read "sales" as a PARTY — the plural sat mid-
  sentence and only the last word was singularised. Every word is now tried,
  and a voucher type always beats the bare word "voucher". Live: 128, equal to
  a direct count.
- "stock items" asked a stock figure about "items". Naming the family is now
  a list. Live: "There are no stock items in these books."

**2 · Repeatable browser journey** — `scripts/e2e/accounting-command-journey.mjs`,
19 steps on the e2e server (now seeds the books: two organisations, an Accounts
CMS person whose accounting role is an Acc_User viewer, and the real
`Acc_auth`, companies and command-search routes): real CMS login → books
upgrade; invoice card; the other organisation's same-numbered invoice never
shown; balance; status filter; posted totals; unknown party → nothing;
"this FY"; "net profit" → P&L; no create form or Team page for a viewer;
Enter opens the invoice; an unanswered search sends only words + company;
the other organisation's REAL company → 403 with none of its data; a fresh
client with no session → 401. Run with `E2E_OTHER_COMPANY=<books.companyB
from the server's ready line>`. Store's journey 20/20 alongside.

**3 · Weekly report, Accounting mode** — `node scripts/reports/store-command-misses.js
--app accounting [--company <id>]`. Misses are kept without a company, so they
are re-asked of `--company` or the primary company; read-only (same listener
guard). `--suggest` stays Store-only. Tested against the seeded books.

**4 · Wider suites.** Frontend `npm test`: 15,533 tests, 15,479 pass, 41 fail —
none in a file this work changed; the Store-nav failures assert top-bar entries
the committed layout had already removed (my diff to that file is three lines:
an import, a comment, the `commandPages` prop). Backend `test/hr-ai`: 55 suites, 47 pass —
the 7 red suites are the same 7 that were red before this work (qwen*,
partyReportAnswer, openJevAccountsPilot, accountingReportQuery,
assistantSubjectPrecedence). An 8th, the Store collection audit, went red
because another lane added `models/VoiceContact.js`; it is now declared as
GRAV Voice's in `storeCollectionOwnership.js` and the audit is 18/18.
Backend `test/accountant`: 75 suites, 53 pass, 22 fail (mostly 403s in the
budget/auth route tests). Three of them were run on a clean checkout of HEAD
with none of this work: identical, 44 failed / 79 passed both ways — so they
pre-date this work and are not caused by it.

---

# Cmd/Ctrl K — Accounting on the ONE shared palette (8 Oct 2026, later)

Both repos. **Not committed.** Owner's direction: Accounting fully, and
centralised — one look and one behaviour for every application, so a change
made once holds everywhere.

**Centralised.** Accounting's own dialog (`components/accountant/GlobalSearch.js`,
664 lines, its own shortcut, rows and look — and an UNFILTERED page list that
offered Team, Approvals and Custom Reports to people who could not open them)
is retired; its test went with it, its one rule (a balance it cannot vouch for
says "Needs reconciliation") moved to the server and its test. Accounting now
contributes a provider and pages to the shared palette, exactly as Store does.
Shared now: the dialog and `RecordCard` (components/shell), the result/card
validation, `lib/commandSearch/outcome.js` (Store's provider moved onto it),
`services/ai/commandSearch/cards.js` (Store's cards moved onto it, 11/11
unchanged), the grammar, and the anonymous misses list. See the guide's new
§ 1b for the full shared / per-application split.

**Accounting search** — `GET /api/accountant/command-search` (accounting
session, `canView`, `requireCompanyScope`; one read-only route, pinned):
records by number/name/GSTIN/HSN (vouchers, ledgers incl. customers and
suppliers, stock items, groups, proforma invoices) with cards; balances via
the shared `computeLedgerBalances(companyId, …)`; stock; vouchers by type,
status, party and period (this/last month, today, this FY, "FY 2026-27",
named months); how many / total (posted unless a status is named, and said) /
latest. Its own readers, because `accountingContext.company()` reads the
PRIMARY company, not the selected one. Bank details, phone and email never
selected. Words: jv, cn, dn, debtors, creditors, sundry debtors, a/c, invoice.

**Every accounting collection decided** — 5 searched, 40 left out with a reason
and what answers instead (`accountingCommandExclusions.js`), gated by
`accountingCollectionCoverage.test.js`. **Every accounting page** (84) in one
list (`lib/accounting/commandPages.js` + test): the menu, 11 extra pages (8
create forms gated `canEdit`, 3 budget pages), 4 left out, 27 record pages;
extra pages pass the menu's own gate (`useNavGate`, extracted from
`useVisibleNav`).

Verified:
- backend 18 suites / 294 tests (accounting 18 + 5 coverage + 2 misses);
  mutations: dropping the company filter, counting drafts in a total,
  ignoring an unknown party, removing a create form's gate — each caught.
- the real door with curl: company A answers; company B (another
  organisation) → 403 `COMPANY_FORBIDDEN`; no session → 401.
- browser, real Accounting layout, CMS login → accounting session upgrade:
  "INV/0012" → card (Posted, ₹1,200…); "balance of Gaurav Enterprises" →
  "₹700 Dr (posted vouchers)" with the card beneath; "new receipt" offers
  nothing to a viewer; "net profit" → Profit & Loss.
- Store journey 20/20 after the shared refactor; frontend 535/536 (the
  unrelated `/cctv`, `/dev`, `/face-enroll` mapping).

**Found, not changed (auth — the owner's call):** an accounting-ONLY person
(no CMS login) is bounced from `/accountant` to `/` in local testing: the
accounting login sets `accountant_token`, while the frontend route guard
(`grav-cms/middleware.js`) admits `/accountant` only with an `auth_token`
cookie. The everyday path — a CMS person with an accounting role — works.
May differ in production, where the cookie domains are different.

---

# GRAV Voice — one line, end-user desktop app (8 Oct 2026)

Both repos. **Not committed.** Owner's request: make the Voice app end-user
facing, remove Exotel / Telnyx / the provider choice, one final calling path,
a proper calling-app UI with waveforms; desktop first (mobile later), styled
like the rest of the CMS.

**Backend (`grav-cms-backend`)**
- `services/telephony/livekitBrowserCall.js` — one `LiveKitBrowserCall.fromEnv()`
  line, no registry; employee-facing setup message without env-var names;
  `dialFailureState()` maps SIP 486/603 → busy, 408/480/487/timeout → no answer.
- Deleted: `exotelProvider(.test).js`, `knowlarityProvider.js`,
  `providerRegistry(.test).js`, `fakeProvider(.test).js`, `provider.js`.
  `callLifecycle.js` stays (CallEvent uses its states).
- `routes/CMS_Routes/Voice/voice.js` — `/status` returns `{ line, canCall,
  blockedReason, calls }` with only the caller's own browser calls; `publicCall`
  no longer exposes provider/IDs; `POST /calls` and the Exotel webhook removed;
  DELETE keeps a busy/no-answer outcome instead of relabelling it cancelled.
- Permission gate unchanged (`GRAV_VOICE_ALLOW_TEST_DIALLER=1` + admin).

**Frontend (`grav-cms/app/voice/`)**
- `VoiceApp.js` — full-height three-panel desktop layout: Recents (search,
  All/Unanswered, grouped by day) · calling stage (keypad with DTMF tones,
  keyboard dialling, in-call screen with live Customer/You waveforms, mute,
  in-call DTMF keypad, end) · details (Today summary, or the selected call
  with Call again, facts and the recording player). Theme tokens only.
- `LiveWaveform.js` (Web Audio analyser → scrolling canvas bars, theme colour),
  `RecordingPlayer.js` (decoded-peaks waveform, seek), `phone.js` + test.
- `app/preview/voice` — dev-only harness: `?state=call|ringing|keypad`,
  `?selected=c1`, synthetic audio, no dialling.

**Verified:** backend telephony 11/11, frontend voice 15/15; preview harness
in light and dark, live waveforms, recording playback; `/voice` compiles.
**Not verified:** a real call through the new UI (needs a signed-in admin and
the live line). Mobile layout is intentionally not designed yet.

---

# Store Cmd/Ctrl K — learning the words people use (8 Oct 2026, later)

Both repos. **Not committed.** Owner's decisions this session: save the
searches Ctrl K could not answer, **anonymously** (the words, never who), and
**delete them 90 days** after they were last typed.

**1 · Starter words** — `services/ai/storeVocabulary.js`, each with when and
why, folded into the family names by the universal contract:
`indent` → material request, `inward` / `inward entry` → goods receipt,
`godown` → warehouse, `pos` → purchase orders ("POs": a three-letter word is
never de-pluralised). All were refused before; live, "pending indents" now
gives exactly what "pending material requests" gives. Left for the owner as
decisions, not synonyms: "open" POs, "challan", "PR".

**2 · Saving unanswered searches**
- `models/CMS_Models/AI/CommandSearchMiss.js` → `command_search_misses`: app,
  words, state, count, first/last seen. No field for a person (a test pins the
  schema); TTL index deletes a row 90 days after `lastSeenAt`. One row per
  wording, counted with `$inc`.
- `services/ai/commandSearchMisses.js`: blanks phone numbers and emails, and
  records only if the server's OWN re-run of the search still finds nothing —
  the browser cannot write into the list by claiming a miss.
- `routes/ai/commandSearchMisses.js` (`POST /api/ai/store/command-search/miss`,
  same auth, always 204) — its own file because the palette's search route is
  pinned read-only with exactly one route; the first version put it there and
  that test caught it. Mounted in `server.js` (one line, beside the search
  route) and the e2e server.
- Frontend: the provider's optional `reportMiss(words)`; the palette calls it
  on Escape / click-away only when the last search found nothing, no page
  matched, and nothing is still loading. Fire-and-forget, `keepalive`.

**3 · The weekly look** — `node scripts/reports/store-command-misses.js
[--limit 30] [--suggest]`, read-only: most-typed misses, "now answered" for
ones a word has since fixed, and with `--suggest` the local qwen3:8b's reading
as a sentence — only if it survives the router contract — else "needs a
person". Approved words go into `storeVocabulary.js`. Loads Store capabilities
only (not the assistant), so no other application's start-up code touches the
database.

**Note for the owner's own stack:** when the server on :5050 restarts with
this code, Mongoose will create the empty `command_search_misses` collection
and its indexes on the dev database — the same as for any new model — and
real misses typed on :3001 will start being saved there. That is the feature;
saying it so it is not a surprise.

Verified: backend Store gate 16 suites / 269 tests (includes
`storeVocabulary` 2, `commandSearchMisses` 7); collection audit 0 unclassified;
frontend 331/332 (the unrelated `/cctv`, `/dev`, `/face-enroll` mapping);
journey 20/20; in the browser, "stuff lying around" + Escape sent one
`POST …/miss` → 204.

---

# Store Cmd/Ctrl K — record cards: the facts that matter, without opening the page (8 Oct 2026, later)

Both repos. **Not committed.**

A result about ONE record now carries a card — a status and up to eight
labelled facts — for the five records Store opens most:

| record | card |
|---|---|
| purchase order | supplier, ordered, expected, total, items, received/pending, payment, source MRF |
| goods receipt | source, supplier, PO (or source document), received on, invoice, warehouse, lines |
| material | SKU, stock on hand with unit, category, type, min/max stock |
| supplier | code, contact, phone, email, GST, open orders (issued + partly received), rating |
| material request | requested for, department, raised by, needed by, priority, items, purpose |

- `services/ai/storeRecordCards.js` reads the record by canonical id through
  `resolveEntity` — the same tenant scope and contract PROJECTION as every
  answer, so an excluded field (bank details) is never read; the test plants
  bank details on a supplier and checks they never appear. Every fact names a
  path the contract exposes (pinned). Supplier "open orders" is a tenant-scoped
  count.
- Only results about one record get a card (`metadata.single`), at most 3 per
  answer; a list never does. Mutation: dropping that rule fails a test.
- A LOOKUP's card leads (title becomes the record); a QUESTION's card sits
  beneath the answer sentence. The first version let the card replace the
  sentence and the journey caught it: "where is soda ash kept" lost the bin.
- Subtitles now show the concept's label, not its id (`__records__`,
  `sp.purchase_order.ponumber` were visible before).
- Frontend: `normaliseCard` (closed shape: strings, ≤8 facts, no link or
  markup; `lead` only when told), `RecordCard` in the palette.

Live (read-only): PO/2026-27/0011 → Completed · PADMA · ₹1,110 · 2 items ·
8 received, 0 pending; MRF/2026-27/0011 → Pending · Production · urgent;
Rollax → out of stock, 0 Gram; DIBANKSH ENTERPRISES → phone, email, GST,
0 open orders.

Verified: backend Store gate 14 suites / 259 tests + `storeRecordCards` 11;
frontend 329/330 (the unrelated `/cctv`, `/dev`, `/face-enroll` mapping);
browser: PO, supplier, material and "where is soda ash kept" seen; journey
20/20.

---

# Store Cmd/Ctrl K — every Store page reachable (8 Oct 2026, later)

Frontend `grav-cms` only. **Not committed.**

Cmd/Ctrl K searched the top bar alone: 16 of Store's 62 pages. Now every page
under `app/store/dashboard` (91, counting the 29 one-record pages) is in
exactly one list in `lib/store/commandPages.js`:

| | |
|---|---|
| in the top bar (unchanged) | 16 |
| added to Ctrl K by name, with search words | 30 — floor tools, checks and reports, requisitions, customer materials, products/BOM, the three Store setup sections (`setup?section=…`), five create forms |
| left out on purpose, with the reason and where to go instead | 21 — 2 redirects; the legacy PO sheets, worker sheets, machine configuration and deliveries the layout retired; legacy setup routes now inside Store setup; the retired hub pages; the superseded reservations and product-request queues; item info (needs a scanned item) |
| one-record pages | 29 — 14 opened by a Ctrl K record result, the rest actions on a record or legacy |

The bar is unchanged: `FrostShell` gained a generic `commandPages` prop
(palette only, never drawn, no duplicates of the bar), and a command may carry
`keywords` (matched as context, never above a page's own name).
`lib/store/commandPages.test.mjs` walks the folder and fails on a page in no
list, a listed page that does not exist, or an "instead" that is not a page;
removing one entry fails 2 tests.

Also fixed: typing a page's name printed the data search's "No authorised Store
record matches that." above the page it found. A "found nothing" sentence now
shows only when nothing else was found (clarifying notes still show).

Verified: frontend shell + store suites 326/327 (the one failure is
`activeApplication`: `/cctv`, `/dev`, `/face-enroll` unmapped — other lanes'
routes); in the browser, "valuation" → Inventory valuation → Enter opened it,
"units of measure" → Enter opened `setup?section=units`; journey 20/20.

Worth a look by whoever owns Store setup: a warehouse, unit or machine record
result opens its LEGACY edit form under `/configurations/…` (the backend's
`STORE_RECORD_ROUTES`), not Store setup.

---

# Store Cmd/Ctrl K — Phase 1 complete: all of Store, nothing missed (8 Oct 2026)

Plan: `docs/tasks/store-command-complete-then-8b-router.md`, steps 1–5.
**Not committed.** No migration run, `STORE_PURCHASE_STRICT_TENANCY` not set.
The live dev database was READ (probes, the collection audit's `--live`
mode). One thing touched it that I did not write — see "A write I did not
intend" below.

Every routing and discovery check here was run with the FULL registry
(`require("./services/ai/gravAssistant")`, i.e. the server's load order) and
the REAL company resolver, against live data. The first probe I wrote used
`SpCompanyMembership.findOne()` for its company and landed in the wrong one
(`6ab1459d…` instead of the primary `6a08040a…`), which made three real
documents look missing. Any future probe should resolve the company through
`companyMembership.resolveCompanyForActor`, as the server does.

## 1 · A supplier by name — two defects, not one

`DIBANKSH ENTERPRISES` → was answered with purchase order `PO26094229`;
`Fancy Corner` → "No authorised Store record matches that". Now both lead
with the supplier and open `/store/dashboard/vendors-buyer/vendors/view/<id>`.

1. **The collection-only fallback ran only when the catalogue pass named
   nothing.** A supplier's name is a purchase-order identity field
   (`vendorName`), so with exactly ONE order carrying it the pass "found" the
   order and the supplier master was never asked. With two orders the pass
   was ambiguous, named nothing, and the fallback happened to run — which is
   why some suppliers worked. `familiesHolding()` now always runs the pass
   AND the collection-only reads, side by side.
2. **Even when found, nothing could show it.** `discover` builds rows from a
   capability's `recognizeSubject`, and no capability resolves those families
   under their own id (the supplier reader's subject is `"supplier"`, the
   inventory readers' `"inventory_item"`). `recordRows()` now turns the
   resolution into a row through the OWNING capability's own `buildLinks`, so
   a row exists only when an authorised capability offers a page. The record
   the name IS leads; records that merely mention it follow.

Regression: the matrix now asks every `collectionOnly` family for a record
BY NAME, with the same name written on one neighbouring record of another
family (the exact DIBANKSH shape). Mutations: restoring the old fallback rule
fails 2 matrix cases and 1 full-registry case; dropping `recordRows` fails 3.

## 2 · Found on the way, and fixed — each one a guarantee that had a hole

| Question (live) | Was | Now |
|---|---|---|
| `PO/2026-27/9999` (no such order) | "Matching purchase orders:" + **ten other orders** | `no_match` |
| `development BOM revision 909` | every revision listed | `no_match` |
| `customer account Q35A0000-9` (matrix) | `answered` with "I couldn't match one customer account exactly" | not an answer |
| `next po number` | a list of existing PO numbers | the numbering concept's answer (see open item) |

- **A reference that names no record** was the broad fallback the whole layer
  exists to prevent. The matrix never saw it: every reference it typed was one
  it had seeded. The narrowed-nothing refusal now covers a reference and an
  unplaced number, not only a worded constraint, and also catches a
  collection bigger than the scan cap (`truncated`). New matrix kind
  "unknown reference" — one per family, 52 cases. Mutation: dropping the
  reference from the rule fails 5 tests.
- **A capability's not-found sentence was reported as `answered`.**
  `resolveChoice` already read the resolution's verdict first; `runClaim` now
  does too (an ambiguous resolution still shows its sentence).
- **A family name inside a longer concept.** "po" is a purchase order's
  family label and also part of the numbering concept "next po number"; the
  shorter family match won. When every family label that put the leaders on
  topic sits inside a longer concept phrase a claiming capability recognised,
  that phrase decides. Pinned in `storeCommandFullRegistry.test.js`; mutation
  fails it.

## 3 · Every collection classified — `store-collection-coverage.js` (new)

`scripts/audits/store-collection-coverage.js` (offline: every collection a
model writes; `--live`: also every collection in the database, read-only),
backed by `services/ai/storeCollectionOwnership.js` and gated in CI by
`test/hr-ai/storeCollectionCoverage.test.js`. Ownership is the model's
DIRECTORY, so a new model is classified by where it is put, and one put
somewhere undeclared fails.

```
live, 8 Oct 2026                          411 collections
  catalogued                                53
  served by the legacy store family          8
  deliberately excluded                      9
  another application                      312
  orphaned (no model, no running code)      29   — every one of them empty
  UNCLASSIFIED                               0
```

Mutation: removing the `mrfchatmessages` exclusion → audit exit 1, 3 jest
failures.

**What the plan expected vs what the audit found:**

- `stockitems` (127), `stockissuances` (83), `storepurchaseorders` (1),
  `workerworkorders`, `purchaseordersettings`, `workordersettings` — **served by
  the legacy `store` family**, read from its own field contracts
  (`storeApplicationFieldContracts.sourceModels`). Verified, not assumed.
- **No family joins the catalogue.** The plan expected three:
  - `barcodedevices` — scanners managed from `/production-supervisor/dashboard/firmware`
    and `/barcode-scanner-device`; no Store screen. Owned by "production devices".
  - `customer_account_claims` — a Sales race-lock record (one customer, one
    account); a Sales model, not business data.
  - `purchaseordersettings` — already answered by the legacy `store_metric`.
- **Excluded with a reason** (`storeCommandExclusions.EXCLUDED_COLLECTIONS`):
  `mrfchatmessages` (a conversation, 87), `locationreservations` (concurrency
  projection), `rawitemaddrequests` (superseded, read-only, no company),
  `sp_idempotency_records` (replay records, 147), `sp_company_memberships`
  (access control), `sp_approval_policies` (authority limits),
  `storedepartments` (credentials), `Mrves` (a stale case-variant copy of
  `mrves` — all 4 numbers are in `mrves`), `productchangerequests` (orphaned
  queue, 7 rows, last 28 Aug).
- `settings`, `products`, `categories`, `orders`, `users`, `wallets`,
  `sitecontents` are the **public website shop** sharing the database
  (storeName, deliveryFee). Easy to mistake for Store; they are not.

## 4 · The eight exclusions, re-read

- **Settings singletons** — kept. On live, "store settings", "production
  settings", "sales settings" each answer by name.
- **`development_bom_revision`, bare integer** — kept, and now with evidence
  for "the family named, then the number": on live **all eight revisions are
  numbered 1** (the number is unique only within a development file); the
  field reader takes "revision" from the family's own name and answers "101's
  revision is not recorded" about revision 101; the collection reader cannot
  place a bare number. The identity a person can type is file + revision; that
  composite would have to become the family's identity first.
- **`storage_position`** — kept. "storage positions" / "how many" answer as a
  collection; "where is X kept" answers through `inventory_location_metric`
  (integration suite; live — the live balances collection is empty, so every
  live answer is honestly "no recorded position").

Also tightened: the matrix's "partial identity" case now also fails if the
record's pair appears. 0 failures.

## 5 · Performance — measured live, laptop → Atlas, full registry

| | before | after (warm) |
|---|---|---|
| bare material name (`Rollax`, `Lining Polyster Plain`) | ~890 ms, 18 reads | **~250 ms**, 18 reads |
| bare supplier name, identity space warm | 0.3 – 2.4 s | **4 – 350 ms** |
| a name nobody has (`nothing called this`) | 0.85 – 2 s | **~230 ms** |
| document reference (`GRN/2026-27/0006`) | ~420 ms | ~200 ms |
| named question (`pending material requests`) | 0.1 – 0.2 s | unchanged |
| **cold: first catalogue pass in a process** | | **1.8 – 2.6 s** |

Three changes, none of which reads anything new:

1. Claims and discovery resolvers run **side by side** instead of in turn
   (bounded at 6 / 3 as before, so the reads are identical).
2. The legacy `resolveAnyRecord` (`services/storeAssistantContext.js`) reads
   its five record types and two party types side by side — it was a quarter
   of a second of sequential round trips on every unhinted Store question,
   the assistant's included.
3. **The identity space is cached for 30 s** (`STORE_IDENTITY_SPACE_CACHE_MS`,
   0 turns it off), per family and tenant scope, opt-in — the palette asks for
   it, the assistant does not. Measured: the 53 reads take 0.28 – 1.8 s for the
   same pass on the same data, because they queue on the cluster; the old 5 s
   cache was keyed on the actor OBJECT, which is new each request, so it never
   hit across keystrokes. **The price:** a record created in the last 30 s may
   not be found by bare name through the pass (references, lists and the
   routed resolvers still read fresh). Pinned in
   `storeIdentitySpaceCache.test.js`, including that price.

**The worst case, stated:** the first bare name a server process places pays
the cold pass — 1.8 – 2.6 s measured. Option 3 of the plan (one index-backed
lookup instead of 53 reads) would remove it, and needs an index on live — not
done, it is a write.

## Open items for the owner

1. **"next po number" — DECIDED by the owner, 8 Oct 2026: it means the
   register.** It now answers from the Store & Purchase document sequence for
   the person's own company, read with `documentSequence.peek` (nothing moves)
   and rendered by its `format`: live, **`PO/2026-27/0014`** (latest order
   `PO/2026-27/0013`). It no longer reads the legacy `purchaseordersettings`
   counter (`PO-0001`), which only the legacy screen at
   `/store/dashboard/configurations/purchase-orders` still uses. No company →
   fails closed. Worker work order numbering is unchanged (no newer counter
   exists). Changed in `services/ai/tools/storeTools.js` (`store_metric`), so
   the assistant gives the same answer. Pinned in
   `storeCommandFullRegistry.test.js` (another company's sequence is never
   read; asking moves nothing; a new year starts at 0001); restoring the legacy
   counter fails 2 tests.
2. **A write I did not intend.** Loading the full registry (required by the
   routing rule above) loads `models/Accountant_model/Acc_VoucherModels.js`,
   whose `ensureVoucherIndexes()` runs on connect: an idempotent `isLive`
   backfill (`updateMany`) and an index check against `acc_vouchers`. The
   server runs the same on every boot, including each nodemon restart today,
   so it should have matched nothing — but I did not measure the matched count
   and cannot prove it was zero. Probes that only need Store should not load
   the accounting model.
3. The cold first pass (above).
4. `assistantSubjectPrecedence` (pre-existing red) fails on its own fixture:
   `companyId: "company-1"` is not an ObjectId and the location reader's query
   casts it. Not touched.

## Changed files (backend; all in the untracked Store command layer)

| File | Change |
|---|---|
| `services/ai/storeCommandSearch.service.js` | `familiesHolding`, `recordRows`, the reference / unplaced-number refusal, not-found ≠ answered, concept-phrase precedence, claims and discovery side by side, cached identity space |
| `services/ai/storeCommandExclusions.js` | `EXCLUDED_COLLECTIONS` + `excludedCollection`; the re-read recorded on each rule |
| `services/ai/storeCollectionOwnership.js` | **new** — owners by model directory, model-less owners with evidence, `classifyCollection` |
| `services/storePurchaseUniversalContext.js` | opt-in `identityRows` cache; `cached` passed through the pass |
| `services/storeAssistantContext.js` | `resolveAnyRecord` reads side by side |
| `scripts/audits/store-collection-coverage.js` | **new** |
| `scripts/e2e/store-command-journey.mjs` | +2 steps: supplier by name opens the supplier; an unissued PO number is refused |
| `test/support/storeEntityFixtures.js`, `storeQuestionMatrix.js` | named records with a masking neighbour; "unknown reference", "by name"; partial identity's `never` |
| `test/hr-ai/storeCommandMatrix.test.js` | the new kinds, `opens` assertion, prints its own denominators |
| `test/hr-ai/storeCommandFullRegistry.test.js` | **new** — the server's tool load order |
| `test/hr-ai/storeCollectionCoverage.test.js` | **new** — the collection gate in CI |
| `test/hr-ai/storeIdentitySpaceCache.test.js` | **new** — the cache's contract and its price |

## 6 · qwen3:8b as a router behind the grammar (plan step 6)

**Off by default.** `STORE_COMMAND_ROUTER=qwen` turns it on; it then uses
local Ollama (`STORE_COMMAND_ROUTER_URL`, default `http://127.0.0.1:11434`),
`STORE_COMMAND_ROUTER_MODEL` (default `qwen3:8b`) and a 5 s budget
(`STORE_COMMAND_ROUTER_TIMEOUT_MS`). Its own variables on purpose — `OLLAMA_*`
point the assistant at 32b over the tunnel.

- `services/ai/storeCommandRouterContract.js` (no model, no DB): the menu —
  names of authorised families, the catalogue's concept phrases (the 40 the
  sentence shares words with), recorded statuses, five operations; a closed
  schema; the prompt; `validate`; `sentenceFor`, which writes the choice back
  as a sentence in the catalogue's own words.
- `services/ai/storeCommandRouter.js`: the only file that calls a model;
  loaded only by `routes/ai/storeCommandSearch.js`, only when the variable is
  set. The search service never requires it — the router is injected.
- One plug-in point, in `search()`: after the grammar placed nothing and no
  record carries the words. The translated sentence is answered by the same
  path, so authorisation, grounding, the narrowed-nothing refusal and the
  bounds all apply. The answer says `Read as "…"` and every row carries
  `metadata.via = "router"`.

The plan's six guardrails, each tested (`storeCommandRouter.test.js`, 31):
closed output; the menu holds only authorised families; a value must be words
the person typed; one call, never for a question the grammar placed; down /
slow / prose / off-menu / invented value → exactly today's answer; attributed.
Two more the provisional corpus forced:

- **Anchored** — the family or concept chosen must share a word (on its stem)
  with what was typed. A real but unrelated family is refused.
- **Nothing dropped** — every content word typed must be accounted for by the
  sentence the route becomes. qwen3:8b routed "requisitions pending" to
  "store requisitions" (every requisition) and "why is our fabric stock wrong"
  to "stock items"; both are now refused. Counted from the composed sentence,
  not the choice — the first version let a concept a list never uses "cover"
  the dropped word. Mutation: rule off → 3 failures.

**The gate:** the whole matrix re-run with the model unreachable — 464 asked,
464 unchanged. A hostile router that names a real family for everything was
consulted for 30 of 472 cases and produced 0 broader answers and changed no
question the grammar answered. Journey 20/20 with the router on, in Chrome; the
palette showed `Read as "goods receipts".` above the two receipts.

Also fixed on the way: a collection reader that REFUSED (`ok: false` — "I
couldn't safely match the requested purchase order constraint…") was reported
`answered`. It is now `no_match` with the reader's sentence as the note.

## 7 · Measured — what could be, and what could not (plan step 7)

**There is no corpus of real questions.** `conversationStore` is in-memory
and lost on restart; `grav_ai_usage` holds 0 rows. **The 32b side could not be
run**: the RunPod tunnel (`127.0.0.1:11436`) did not answer. So the plan's
switching evidence does not exist yet, and nothing here should be read as it.

What exists: `scripts/audits/store-router-measure.js` — grammar alone vs
grammar + router over any corpus, on a throwaway in-memory database with the
server's registry order — and `store-router-corpus.provisional.json`, 28
questions I wrote by hand about the seeded fixture, labelled as such.

```
qwen3:8b, local Ollama, Apple M4 (16 GB unified), provisional corpus
  placed by the grammar alone        11 of 28
  left for the router                17   (9 routable, 8 should be refused)
  routed and right                    4 of 9
  wrong routes                        0 of 4 routed answers
  refusals kept as refusals           8 of 8
  placed overall                     15 of 20 answerable  (grammar alone: 11)
  router latency                     p50 6.2 s, max 7.0 s this run;
                                     2.0 – 4.3 s warm in earlier runs
```

Read honestly: the guardrails held — every bad choice the model made was
refused — but the model's raw choices are poor (it offered "salary dept" for
"salary of ravi" and a spend-request family for "on order from Gaurav"), and
latency on this machine is often over the 5 s budget, when the router simply
degrades to today's refusal. Four questions the grammar PARTLY placed and then
refused ("number of warehouses we run", "tally of goods receipts") never reach
the router, by the plan's rule; widening the plug-in point to "the grammar's
reading was refused" is the obvious next decision and is not made here.

**Step 8 (switch 32b → 8b, drop RunPod) needs**: a real corpus — which means
deciding to persist palette questions, a write and a privacy call — and the
32b tunnel up to measure against. Neither is mine to decide.

## Verification

```
npx jest test/hr-ai/storeCommand test/hr-ai/storeTenancyGate.test.js \
         test/hr-ai/storeCollectionCoverage.test.js \
         test/hr-ai/storeIdentitySpaceCache.test.js --runInBand
                                            13 suites, 249 tests, all pass
  matrix: 472 cases, 464 asked, 464 pass, 0 broader   (was 418 / 410 / 410)
  matrix, model unreachable: 464 asked, 464 unchanged
  matrix, hostile router: consulted for 30 of 472, 0 broader
node scripts/audits/store-command-search-coverage.js   2,647 concepts, 0 unexplained
node scripts/audits/store-command-behaviour.js         18 of 18
node scripts/audits/store-collection-coverage.js       0 unclassified (offline)
node scripts/audits/store-collection-coverage.js --live  411 collections, 0 unclassified
node scripts/e2e/store-command-journey.mjs             20 of 20 router off; 20 of 20 router on
                                                       (one router-on run failed step 3 with the
                                                       palette input not yet mounted; passed on
                                                       rerun — the same flake seen once router-off)
npx jest test/hr-ai --runInBand                        same 7 pre-existing red suites,
                                                       1 failed / 508 passed (after the router and the PO-number decision)
```

Router files added to the changed list: `services/ai/storeCommandRouterContract.js`
(new), `services/ai/storeCommandRouter.js` (new), `routes/ai/storeCommandSearch.js`
(router injected when enabled), `scripts/audits/store-router-measure.js` (new),
`scripts/audits/store-router-corpus.provisional.json` (new),
`test/hr-ai/storeCommandRouter.test.js` (new), `storeCommandNoModel.test.js`
(the contract module added to the files that must name no model).

Seen, not changed: a collection answer's subtitle shows the internal metric id
`__records__` in the palette.

---

# Store Cmd/Ctrl K — matrix complete, journey proven, tenancy corrected (6 Oct 2026)

**Not committed. No live database written.** The live database was READ once,
read-only, by the tenancy gate and the backfill's dry run. The backfill itself
has NOT been run and is waiting on approval
(`docs/decisions/store-tenancy-ownership-mapping.md`).

## 1 · The tenancy claim was wrong, and this corrects it

An earlier handoff called the legacy read-through an exploitable cross-tenant
leak. **It is not one.** `companyMembership.resolveCompanyForActor`
short-circuits: while a primary company profile exists, every authenticated
internal actor works in it (GAC-AR1, "GRAV is one organisation"). No session
can resolve to another company, so the "stranger from company B" in the
earlier test was a hand-built object, not something anybody can obtain.

Proven twice over: a unit test seeds a membership in another company and shows
the canonical rule still wins, and the end-to-end journey signed a second
seeded company's user in through the real login form and was answered as the
primary company.

**And the live database holds ONE company, not three.** The gate, run
read-only against Atlas on 6 Oct 2026:

```
   companies in the books                         1
   collections checked                           42
   records with no companyId                    821
   STORE_PURCHASE_STRICT_TENANCY                OFF
```

821 unowned records across 8 collections (`rawitems` 301, `barcodes` 271,
`purchaseorders` 100, `vendors` 90, `mrves` 33, `units` 24, `crmaccounts` 1,
`warehouses` 1). With one company there is nothing to decide: every one of
them belongs to `6a08040a1fecacc9bb7149c2`, which is what every WRITE already
stamps. The plan, the dry run and the reversal are in
`store-tenancy-ownership-mapping.md`, **awaiting approval**.

One thing in that plan is a real risk and it is not a Store-search risk:
`STORE_PURCHASE_STRICT_TENANCY` is global, and the Cutting, Packaging and
Finishing queues rely on unlinked WORK ORDERS being visible. Work orders are
not among the 821 and this backfill does not touch them.

## 2 · The matrix: every asked question passes

| | |
|---|---|
| families | 53 declared, **52 seeded**, 1 (`storage_position`) excluded by the product |
| cases | **418** |
| asked | **410** |
| pass | **410** (100%) |
| broader/unfiltered answers | **0** |
| known gaps | **0** |
| declared product exclusions | **8** |

The earlier "417 vs 420" and "53 vs 52" were two different runs either side of
a fixture fix, reported without saying so. The denominator moves when the
matrix's own generation changes, so it is now printed by the suite itself
rather than quoted from memory.

### The three known gaps are fixed

- **`stock_ledger` / `development_request_receipt` status filtering** — a
  family can record its workflow on a field not called `status`
  (`applicationState`, `state`). The contract now publishes the recorded
  values of EVERY closed workflow field, and the collection layer grounds the
  field whose values the question actually names.
- **`goods_receipt_putaway` date filtering** — a capability now declares the
  names it answers to (`semantic.labels`) and routing takes the LONGEST one a
  question contains, so "goods receipt put-aways" stops being read as a
  goods-receipt question.

### Four more defects the matrix found on the way

- An account's lifecycle stage records "customer" and the family is called a
  "customer account": "customer accounts" was read as a FILTER and answered
  "none found" about records that were there. A recorded value is now matched
  only OUTSIDE the family's own name.
- A recorded value was being used to choose the column to SHOW rather than the
  rows to keep ("reserved barcodes" listed every barcode with its state).
- A count question was answered three times over — material requests, then
  inventory items, then the request desk. A question that names a family is
  now answered only by that family.
- **"Stock of a material nobody ever registered" listed every material in
  Store.** The reader now reports how much it narrowed by, and a question that
  carried a constraint and narrowed by nothing is refused. That was a genuine
  broad-fallback, found only by the browser journey.

### The 8 exclusions are product decisions, declared in the product

`services/ai/storeCommandExclusions.js` — not a test fixture, so the reason
and the thing that answers instead live where the product can state them:

- **a settings singleton's identity** (`store_settings`, `production_settings`,
  `sales_settings`; 6 cases) — one row, no business reference to type. Its
  NAME answers, and the suite proves that.
- **a bare-integer identity** (`development_bom_revision`; 2 cases) — a number
  is not a document reference; treating one as an identity would match any
  record holding that figure in any field.
- **`storage_position`** (the family, not asked at all) — a location balance
  is the quantity of one item at one shelf and carries no identity; its
  catalogue entry names fields the model does not store.
  `inventory_location_metric` answers "where is X kept" from the same
  balances.

The two that were previously excluded and are now ANSWERED: a bare SKU and a
bare supplier code. `isImplicitlyRecognisable` leaves collection-only families
out of the catalogue-wide pass; the palette now asks those two families
directly — the same scoped read, two reads, only for a question that already
looks like a reference.

## 3 · An authenticated journey, in a real browser

`scripts/e2e/store-command-server.js` + `scripts/e2e/store-command-journey.mjs`.
A REAL backend (`routes/auth/deptAuth`, `EmployeeAuthMiddleware`,
`resolveAppAccess`, `tenantContext`, the registry) on a THROWAWAY in-memory
database, a real Chrome via playwright-core, the real login form, the real
Store dashboard, the real palette.

```
   18 of 18 steps passed.
```

sign-in · the dashboard renders · exact document number · a field of a named
material · where a material is kept · a date window honoured · a window with
no date named refused · a status filter that excludes · latest-five newest
first · a count about one family only · an aggregate · ambiguity offering
canonical choices · choosing one answering about THAT record without
rewriting the question · a record result opening its own page · a question
about nothing saying so · a record of another company not returned · no
application at all cannot sign in · a signed-in person without the Store
grant refused by the endpoint.

Two findings from it: the broad-fallback above, and that a person with no
application grant is refused at the LOGIN door, before Store is reachable.

## 4 · The guarantees, still held

- No model: `storeCommandNoModel.test.js` answers all ten required questions
  with `fetch`, `http.request`, `https.request`, `spawn` and `exec` throwing.
- Both families, under Store access + `sp.read`: pinned at ≥7 `store`,
  **≥100 `store_purchase`**, total = their sum.
- Bounded: ≤6 capabilities per question; the one catalogue-wide pass runs only
  for a reference no capability's aliases recognised.
- No broad fallback: proven by the matrix's 0 leaks AND by the new
  narrowed-nothing refusal.
- Choices carry canonical ids and resolve without rewriting the input.
- Data outranks navigation only when a verified answer exists.

## Verification

```
the nine Store suites, one command        Test Suites: 9 passed, 9 total
                                          Tests:     177 passed, 177 total
scripts/audits/store-command-behaviour     18 of 18
scripts/audits/store-command-search-coverage  2,647 concepts, 0 unexplained
scripts/e2e/store-command-journey.mjs      18 of 18 steps
grav-cms: node --test (shell + provider)  148 passed
git diff --check (both repos)             clean
```

---

# Store Cmd/Ctrl K — release blockers closed (5 Oct 2026, later)

**Not committed. No live database written or read:** every test and both
audits run against an in-memory replica set; the tenancy gate and the backfill
are written but have NOT been run against Atlas.

## 1 · The test actors were using a capability string that does not exist

`storeCommandSearch.test.js` spelled the Store & Purchase read capability
`"READ"`. The real value is `CAPABILITIES.READ` = `"sp.read"`, so **every
`store_purchase` capability was unauthorised throughout that suite** and its
assertions about both families holding were made against a 7-tool set. A
fixture that invents the value it is testing against proves nothing.

Both actors now read the string from the real module, and two assertions that
had been passing on an empty set failed immediately and were corrected:

- `only Store tools are ever consulted` asserted `application === "store"` —
  now asserts membership of both families, with a floor of 107 capabilities.
- `no authorised Store tool exposes a mutation` refused any capability whose
  NAME contained "issue", "receive" or "create". That is a guess about a word
  and it was wrong in both directions: `store_receive_query` READS the
  receiving register and a capability called `store_summary` could write all
  day without tripping it. It now checks SHAPE — a registered tool may carry
  no callable but the seven read entry points — and a second test pins that
  the service calls no other.

`storeToolsFor()` is now pinned explicitly: both families present, ≥7 `store`,
**≥100 `store_purchase`**, and the total equal to their sum.

## 2 · The suites, run as one command each

### Full regression — `npx jest test/hr-ai --runInBand`

```
Test Suites: 7 failed, 39 passed, 46 total
Tests:       1 failed, 433 passed, 434 total
```

The seven red suites are the ones that were red before this work began —
`qwenRouteReviewer`, `qwenArgumentInterpreter`, `qwenAccountingPlanner`,
`partyReportAnswer`, `openJevAccountsPilot`, `accountingReportQuery`,
`assistantSubjectPrecedence`. None of them requires a file changed here. The
baseline was **283 passing with the same seven red**; it is now **433**.

### The focused suite, run as one command

```
npx jest test/hr-ai/storeCommandArgs test/hr-ai/storeCommandIntent \
         test/hr-ai/storeCommandRegistry test/hr-ai/storeCommandSearch \
         test/hr-ai/storeCommandSearch.integration test/hr-ai/storeCommandNoModel \
         test/hr-ai/storeCommandCoverage test/hr-ai/storeCommandMatrix \
         test/hr-ai/storeTenancyGate --runInBand

Test Suites: 9 passed, 9 total
Tests:       174 passed, 174 total
```

## 3 · Legacy tenant read-through is a RELEASE BLOCKER

**Store search is not production-ready on a multi-company database.**
`tenantContext.tenantFilter` reads through to records with no `companyId`
while `STORE_PURCHASE_STRICT_TENANCY` is unset. Every Store reader inherits
that, the palette included, so cross-tenant isolation is a property of the
DATA, not of the code.

`test/hr-ai/storeTenancyGate.test.js` **demonstrates the leak** rather than
describing it: an unowned raw item answers a stranger's "stock of Orphan
Fabric" through the palette's own entry point, and the same question about an
OWNED record of another company is refused. The palette must not narrow its
own scope to hide this — it is correct because it reuses the same filter as
every other Store read, and a private stricter filter would fix one surface
and leave forty.

- **Gate:** `scripts/audits/store-tenancy-release-gate.js` (read-only) counts
  unowned records per collection across every Store & Purchase entity that
  has the field, plus `rawitems` and `location_balances` — not in the
  universal contract, the two biggest, and what "stock of X" and "where is X
  kept" read. It passes only when **nothing is unowned AND the flag is on**.
- **Backfill:** `scripts/migrations/store-purchase-company-backfill.js`, a dry
  run unless `--apply`. It **refuses to run with more than one company**
  unless `--company=<id>` names the owner — this database holds three, and
  guessing hands one company's stock to another.
- **Plan:** `docs/decisions/store-tenancy-strict-cutover.md`.

Neither has been run against Atlas; that is the owner's call.

## 4 · An answer now outranks a page

Navigation came first, always, so "stock of macbook" put a generic Stock page
above the verified figure and **Enter navigated instead of answering**. When
the provider's state is `answered`, `choices` or a collection, its results
lead and the cursor returns to the top; otherwise navigation leads as before,
so a question still being typed does not reorder the list under the cursor.

Verified in the browser on the real surface: typing `salary` (both a page and
a question) gives row 0 = the verified figure, `aria-selected="true"`, row 1 =
the Salary page; `attendance` keeps the page first; `orders` leads with the
collection and its two openable rows.

## 5 · The question matrix — generated, seeded, and gated

`test/hr-ai/storeCommandMatrix.test.js` with
`test/support/storeEntityFixtures.js` and `storeQuestionMatrix.js`:

- a representative **pair** of records is seeded into **all 53** entity
  families, from each family's own schema — identity paths the model actually
  declares, its recorded enum values, its date concepts, and a distinct value
  for every field a unique index covers;
- the questions are generated from the catalogue's own vocabulary — nothing
  hardcodes an entity, a concept or a phrase;
- a pair, not a record, because "pending purchase orders" answered with the
  only purchase order there is looks right whether the filter was applied or
  dropped. **Every filtered case names the record that FAILS its filter and
  fails if it appears.**

**420 cases. 401 asked, 398 correct (99.3%), 0 broader answers, 3 known gaps,
19 declared unsupported with reasons.** 52 of 53 families seeded; the 53rd
(`storage_position`) declares identity fields its model does not have, so
nothing can write or read them.

### Eight real defects it found, each now fixed and held shut

1. A bare plural ("units", "warehouses") was read as DISCOVERY and routed to
   the capabilities that turn a NAME into one record, crowding out the one
   that lists them: "units" answered "no authorised Store record matches
   that" with two in the database.
2. `includesTerm` does not match "warehouses" against the alias "warehouse",
   and only some families happen to list a plural. The palette now asks a
   capability in the plural typed and then the singular its aliases are in.
3. A date window was refused although the capability had PLACED it: the
   grammar's doubt was read as the verdict, and 35 correctly-answered
   questions were turned into "say which date you mean".
4. A workflow value was grounded only when its field was literally called
   `status`. A customer-material expectation records `state`, a barcode an
   `identityState`: "draft customer material expectations" grounded nothing.
   The contract now publishes the workflow values of whichever field holds
   them, and the collection layer grounds that field.
5. A status word that is part of a DATE concept's name ("service orders with
   **expected** completion date in June 2026") was demanded as a separate
   filter and the capability refused the whole question.
6. A recorded value was used to choose the column to SHOW rather than the
   rows to keep: "reserved barcodes" listed every barcode with its state
   beside it. Values are now declared (`x-semanticValues`) and never name an
   output field.
7. A bare reference whose prefix names no entity ("CSM-2026-0004", a SKU)
   reached nothing. The catalogue's own one-pass recognition now names the
   family and that family's capabilities lead — and the reference segment
   bound rose from 9 characters to 24, because `RAW-LAP-APPMACAIR2022A2681`
   is a real SKU and was not recognised as a reference at all.
8. **Two capabilities answered one constrained question, one of them
   unfiltered** — "recorded goods receipts" came back with the filtered list
   AND the receiving register's broader reading. A constrained question now
   gets ONE answer: the best-ranked capability that found something, and for
   a reference, the one whose answer names it.

### The 3 known gaps (exact, and the suite fails if the list changes)

| Family | Shape | Why |
|---|---|---|
| `stock_ledger` | status filter | its workflow field is `applicationState` while a root `status` also exists; the root wins the grounding, so the question is filtered against the wrong field and answers EMPTY |
| `development_request_receipt` | status filter | same shape (`state` beside a root `status`) |
| `goods_receipt_putaway` | date filter | "created at" is answered by the neighbouring goods-receipt family |

All three answer **emptily**, never broadly — pinned by its own test.

### The 19 declared-unsupported shapes, with reasons

- **a settings document's identity** (`store_settings`, `production_settings`,
  `sales_settings`) — a singleton has no business identity anybody types;
  `isImplicitlyRecognisable` excludes singletons from reference recognition.
  Their own name answers, which is what makes them reachable.
- **a collection-only family's identity** (`inventory_item_master`,
  `supplier_master`) — excluded from catalogue-wide reference recognition by
  the same existing rule; they are addressed as collections. *This is the one
  worth revisiting: typing a supplier code finds nothing today.*
- **a numeric business identity** (`development_bom_revision`, whose identity
  is a revision number) — a number is not a document reference and prints as
  a bare figure, so no answer can be matched to it by name.
- **`storage_position`** is seeded but not asked: its contract declares
  identity fields the model does not have, so nothing writes or reads them.

## The one expensive path, said plainly

A reference whose prefix names no entity triggers the catalogue's own
recognition pass — an identity read per family, cached five seconds per actor
and message. It runs ONLY when the question carries a reference AND no
capability's own aliases recognised the words, so "GRN/2026-27/0004" never
reaches it. Everything after it is bounded at six capabilities as before.
Pinned by `storeCommandRegistry.test.js`.

## Still open

The authenticated journey through the real Store palette, and the tenancy
cutover. Both need the owner.

---

# Voucher Number across the top — the frontend, and two wrong messages (5 Oct 2026)

Frontend repo `grav-cms` only. **No backend file changed.** **Not committed.**
The 50-heading rule is not reimplemented here; the server remains authoritative
and the number shown is whatever it sends.

## Two messages that were wrong

**`REPORTING_TOO_MANY_HEADINGS` was not a code this client knew.** It arrives on
a 422, and an unrecognised 422 became `INVALID_SPEC` — *"Something in the report
is not available for this company"* — which sent the user hunting for a broken
field. There is no broken field: the report is fine and the filter is too wide.

**`REPORTING_UNAVAILABLE` had no case of its own** and fell to the default:
*"Your accounting data has not been connected for reporting yet."* That
describes a company nobody has set up. Said during a restart, about books that
were answering a minute earlier, it is the sentence that sent a developer to the
backend looking for a connection problem that did not exist. It now reads
**"Reporting is temporarily unavailable — your report is safe, try again
shortly."**

## What the refusal does now

The banner keeps the layout, keeps the last successful sheet underneath, shows
the server's own sentence, and offers the two ways out as real controls:
`Filter <field>` (opens the existing filter workflow with that field chosen) and
`Put down the left` (moves the field out of the headings through the same
`placeAt` the field's own menu uses, so Undo steps back through it).

The fields come from the server's `fields` array, so a report spread by two at
once offers one filter button per field rather than assuming Voucher Number.
"Try again" is withheld when `canRetry` is false — the same request would be
refused identically. Technical codes stay in the collapsed Technical details.

## Changed files

| File | Change |
|---|---|
| `lib/reporting/reportingClient.js` | `TOO_MANY_HEADINGS` code; `safeDetails` whitelist; `refusalFrom` carries metadata; explicit `UNAVAILABLE` and `TOO_MANY_HEADINGS` cases |
| `components/accountant/reporting/ReportSheet.js` | the banner shows the refusal's own title, its two actions, and honours `canRetry` |
| `components/accountant/reporting/ReportDesigner.js` | carries `details` into the preview state; wires the two recovery actions |
| `lib/reporting/fixtures.js` | `voucher_number` gains `columns`, mirroring the live catalogue |
| `lib/reporting/tooManyHeadings.test.mjs` | **new**, 14 tests |
| `components/accountant/reporting/tooWide.interaction.test.mjs` | **new**, 10 tests |
| `lib/reporting/reporting.test.mjs`, `customReports.test.mjs`, `placement.interaction.test.mjs` | updated for the new wording and the new placement |

No change was needed for the catalogue itself — it is fetched with
`cache: "no-store"`, so the new placement arrived live — or for the one-click
`+`, which sends text fields to `rows` in both modes and is pinned by a test.

## Mutation checks — all seven fail as required

| Restored defect | Tests that fail |
|---|---|
| the TOO_MANY_HEADINGS case removed (falls back to "data not connected") | **10** |
| the UNAVAILABLE case removed (same fallback) | 6 |
| the new code not recognised, so a 422 reads as INVALID_SPEC | 9 |
| the refusal's metadata dropped in transit | 2 |
| the banner reverts to a hardcoded headline | 2 |
| the two recovery buttons not rendered | 2 |
| `+` starts sending voucher numbers across the top | 1 |

The metadata one initially caught **nothing** — every test called the mapper
directly. Added two that drive the real client response path with a stubbed
fetch; one of them also proves `sql`, `tableId` and `apiKey` in a refusal body
are not carried through.

## Tests

Reporting suites: **514 passed, 0 failed, 0 skipped.**

The whole frontend suite is 15,392 / 15,435 with 30 pre-existing failures in
Store, PPC, HR and IE navigation. None reference any file changed here.

## Browser evidence, live GRAV data

- **`+` on Voucher Number** → "Column", cells `00531` — unchanged.
- **Menu** offers Show down the sheet / Spread across the top / Use as a filter.
- **Spread with no filter** → `REPORTING_TOO_MANY_HEADINGS`, *"This would create
  more than 50 headings."*, the server's reason, both buttons, sheet intact.
- **Put down the left** → recovered immediately to "Column", report ran again
  ("Showing 100 of 852 groups").
- **Filter Voucher Number** → opened **"Filter by Voucher Number"** with its own
  operations; `starts_with 0053` then rendered heading **`00531`**, exact.
- **Month × Voucher Number** → the banner named BOTH and offered **Filter
  Month**, **Filter Voucher Number**, **Put down the left**.
- **Ledger Group × Month × Total Debit** unchanged — `July 2025`, `August 2025`,
  no banner, Excel still offered.
- Desktop, **immersive/full-screen** and **390px mobile**: banner within the
  viewport, no horizontal overflow, sheet and downloads never cleared.

---

# Store Cmd/Ctrl K — the deterministic foundation, corrected (5 Oct 2026)

Backend + the shared shell's provider boundary. **Not committed. No live
database written: every test and both audits run against an in-memory replica
set seeded by `test/support/storeCommandFixtures.js`.**

Lane A only. No Sales intake, Development Requirement, raw-item or
Development-lineage file was touched.

## The five blocking defects, and what each one actually was

**1 · 110 of 117 Store capabilities were unreachable.** The service filtered
`tool.application === "store"`. The registry tags 7 that way and 110
`store_purchase`: inventory stock and locations, the Request Desk, receiving,
procurement, operational summaries and every universal field. Both families are
now served, and including them widens nothing — three gates still apply and all
three must pass (the Store application grant with its read capability; the
Store & Purchase read capability from the tenant resolver; the tool's own
`permission`). A `store_purchase` capability remains unreachable by somebody
who does not hold Store itself.
*Pinned by `test/hr-ai/storeCommandRegistry.test.js` against the REAL registry.
The first version of that fixture used the string `"READ"` instead of
`CAPABILITIES.READ` (`"sp.read"`) and every assertion passed against an EMPTY
authorised set — which is exactly the failure a fabricated `{application:
"store"}` tool object would have hidden.*

**2 · Five of the ten required questions returned nothing; two were answered
wrongly.** Three new modules, none of which knows any of the ten sentences:

- `services/ai/storeCommandIntent.js` — a typed grammar. Intent, document
  reference (recognised by SHAPE, so a series nobody listed still resolves),
  date window, limit, order, status, constraint.
- `services/ai/storeCommandRouting.js` — pure candidate selection from what
  each capability DECLARES about itself (`semantic.subjects`, `semantic.domains`,
  its own `matches` aliases). No tool name is hardcoded.
- `services/ai/storeCommandArgs.js` — fills a collection capability's form from
  its OWN published `x-semanticOptions` vocabulary. The 55 collection
  capabilities have no `claim` because they expected a model to choose their
  arguments; four of the ten questions reached one and were dropped.

**3 · One keystroke asked all 117 capabilities.** Two stages now: routing reads
nothing and returns at most 6; only those are asked. Capabilities sharing a
subject resolve it ONCE and share the result, `claim` (cheap for nearly all of
them) is asked before any identity is resolved, and the resolved subject is
handed to `provideContext` — which used to re-resolve the same record a second
time for every answer.

**4 · A clarification choice carried its display label.** Selecting one
appended the label to the original question and searched again — a second guess
at the same ambiguous words, and an item whose name is contained in another's
could never be picked. A choice now carries `{tool, concept, entityType,
recordId}`; a choice with no canonical id is not offered at all.
`resolveInventoryItem` takes a `recordId` and reads it under the same tenant
filter. `resolveChoice` re-does EVERY gate on the way back (actor re-resolved,
Store grant re-read, capability re-authorised, concept checked against that
capability's own enum, company compared) and reports a failed read as
`no_match` rather than as an `answered` shrug.

**5 · Six different nothings arrived at the browser as one empty array.** The
provider returned only `groups`, so an uninterpretable phrase, a missing
record, several matching records, a window needing one more word, no Store
access and an expired session all read "Nothing matches". `ambiguous` was
worse: the server sent a note with an EMPTY group, the validator drops an empty
group as malformed, and the note went with it — a blank panel for a question
with a real answer behind it. The boundary now carries `{state, note, groups}`,
each state has its own sentence, a chosen record is dropped the moment the
typed question changes, and a collection's bounded rows are rendered and walked
by the arrow keys.

## Four honesty rules, each from a wrong answer seen in a seeded database

- **A window must name its date.** "goods receipts expected in June 2026" was
  answered with a receipt recorded on 20 May. A capability that cannot say
  WHICH of its dates the window means does not claim the question; if none can,
  the palette asks which date rather than answering.
- **A status must be a value something records.** "pending goods receipt
  inspections" listed every inspection. A GoodsReceiptInspection has no status
  field at all — the record exists only once the decision is made — so the
  question is answered by the receiving register, whose stages ARE its
  statuses, and which now publishes its own aliases.
- **A word containing a status is not that status.** `\b` treats a hyphen as a
  boundary, so "half-approved material requests" matched "approved" and was
  silently answered with the approved subset. Fixed in the grammar AND in
  `storePurchaseCollectionContext` (`valueStandsAlone`), where a separator
  INSIDE a value stays flexible (`1-10` is "1 10") and one at the EDGE is a
  boundary.
- **"Latest five" must be the latest five.** Rows were ordered by the DISPLAYED
  text of their first output field, and for a list of records there is no
  output field — so "descending" changed nothing and the answer was the five
  OLDEST. A displayed date sorts no better (`20/5/2026` before `5/6/2026`), so
  the sort key is now the raw value, falling back to when the record was
  created.

## Two things that are new concepts, not new plumbing

- `item.stock_shortfall` on the inventory contract — the gap between quantity
  on hand and minimum stock, which is what "minimum stock" MEANS. It adds no
  schema field. When no minimum is recorded the answer says so rather than
  calling the gap zero.
- A bare name is answered with the RECORD. "macbook" asks no question, so
  nothing claimed it and the most ordinary use of a palette answered "no
  authorised Store record matches that" about a material sitting right there.
  Identity comes from the capability's own `recognizeSubject` and the link from
  its own `buildLinks`; a row with nowhere to open is not offered.

## No model on this path — proved by running it

`test/hr-ai/storeCommandNoModel.test.js` answers all ten questions against a
seeded Store with `fetch`, `http.request`, `https.request`, `spawn` and `exec`
all throwing. MongoDB speaks raw TCP through `net`, so the reads are
unaffected; a model cannot be consulted locally or remotely without one of
them. The require-graph check remains, as a second lock — **it is not the
proof, because it only says nothing was imported.**

## Read-only

Nothing on this path writes. `resolveChoice` and `search` call only
`recognizeSubject`, `claim`, `provideContext`, `renderAnswer`, `buildLinks` and
`buildChoices`. Capabilities whose names contain "issuance", "movement" or
"adjustment" are included: they are READS of those books, and the question is
what the capability does, not what its name contains.

## Two audits, deliberately separate

| | |
|---|---|
| `scripts/audits/store-command-search-coverage.js` | STRUCTURAL. 2,647 concepts across all four Store catalogues; 0 unexplained; 0 owned by nothing; 0 owned only outside Store & Purchase. No database. |
| `scripts/audits/store-command-behaviour.js` | BEHAVIOURAL. 18 kinds of question — exact and partial identity, a field, a filter, two kinds of date window, top-N, a count, an aggregate, a relationship, two locations, a shortfall, pending work, ambiguity, nonsense, permission, cross-tenant denial — asked of a seeded Store, with what the answer must and must not say. 18 of 18. |

They were one report once and the single number was read as both. The old
sentence gate asked whether a phrase CONTAINED a concept's alias, which can be
wrong in both directions at once: "pending goods receipt inspections" contained
one and was answered with every inspection, while "GRN/2026-27/0004" contained
none and is answered correctly.

## Verification

```
npx jest test/hr-ai                                    404 passed, 1 failed*
  storeCommandSearch.test.js                            19 passed
  storeCommandRegistry.test.js                          29 passed
  storeCommandIntent.test.js                            40 passed
  storeCommandArgs.test.js                              17 passed
  storeCommandSearch.integration.test.js  (DB-backed)   27 passed
  storeCommandNoModel.test.js             (DB-backed)    4 passed
  storeCommandCoverage.test.js                           9 passed
node scripts/audits/store-command-search-coverage.js   2,647 concepts, 0 unexplained
node scripts/audits/store-command-behaviour.js         18 of 18
grav-cms: node --test (shell + provider, 6 files)      144 passed
git diff --check (both repos)                          clean
```

\* The one failing test is `openJevAccountsPilot.test.js`, in the same seven
suites that were failing before this work began (the Qwen planner, accounting
report and party-report suites). None of them requires a file changed here, and
the count went from 283 passed to 404 passed with the same seven red.

**Browser, on the real palette surface** (`/preview/command-palette`, which now
drives every outcome without a session): the clarification sentence renders;
a collection shows its two rows with Open links; an ambiguous question offers
both records and the SECOND one resolves by its own id (`bbbbbb…`); typing a
new question drops the chosen record; "no access" and an uninterpretable phrase
each say what they are.

## Still open

An authenticated journey through the real Store palette against the dev
database. The dev server is up but this session has no credentials, so the
browser gate above was run on the preview surface with the real component.

---

# Voucher Number across the top, safely (5 Oct 2026)

Backend only. **No frontend file changed.** **Not committed.**

## The chosen maximum: 50 heading combinations

Server-owned, written once in `services/reporting/headingBudget.js`. A request
cannot raise it. The sheet's width is `headings × values` leaf columns and a
preview returns at most 100 rows, so 50 keeps even a three-value report
(~325 KB) well inside the existing `maxResponseBytes` backstop of 1,500,000.
50 is not where the bytes become dangerous — it is where the SHEET does.

## Why the B6 budget could not do this

`previewBudget.js` says it itself: *"Cardinality is unknowable here — this is
the part of the cost the LAYOUT decides."* One field across the top is one
field whether it holds twelve months or nine thousand voucher numbers. That is
why the catalogue's blunt `placements: ["rows","filters"]` was the only lever,
and why it was too blunt. The B6 gate is unchanged and still runs first.

## The API error contract

    HTTP 422
    {
      "ok": false,
      "code": "REPORTING_TOO_MANY_HEADINGS",
      "message": "<the reason>",
      "field":   "Voucher Number",
      "fields":  ["Voucher Number"],
      "headings": 50,
      "exact":    false,
      "maximum":  50,
      "reason":  "Voucher Number would make more than 50 headings across the top,
                  and a report that wide cannot be read. Filter Voucher Number
                  more narrowly, or put it down the left instead."
    }

`exact: false` means the count stopped at the bound — "more than 50", not a
total nobody counted. With several fields across the top they are all named
(`"Voucher Type × Voucher Number"`). No Metabase id, MBQL, SQL, mart column
name or credential appears, and a test asserts each of those strings is absent.

## How the bound is measured

A grouped count over the column fields with `limit: MAX + 1`, built by
`buildQuery` — so it begins with `tenantFilters` (organisation and company,
unconditionally) and carries the report's own filters. It can return at most
51 rows against any book. It runs AFTER the route's company-scope guard, so an
unowned or mixed-company request is 403 with no query at all.

Applied in **preview**, **XLSX export** and **chart compilation**. Saving a
report validates the shape only — how wide it will be depends on the data the
day it is run.

## Changed files

| File | Change |
|---|---|
| `services/reporting/headingBudget.js` | **new.** The maximum, the bounded probe, the refusal contract |
| `services/reporting/fieldCatalogue.js` | `voucher.number` gains `columns`; `text_exact` / `natural` / no calculations unchanged |
| `services/reporting/metabaseEngine.js` | `CODES.TOO_MANY_HEADINGS` |
| `routes/Accountant_Routes/Acc_reporting.js` | the gate in preview, export and chart-session; `onError` forwards `err.details` |
| `test/accountant/reporting-headings.test.js` | **new**, 19 tests |
| `test/accountant/reporting.route.test.js` | 9 route tests; fake engine grew `resolveView`/`runQuery` |
| `test/accountant/reporting-integration.route.test.js` | 4 live tests |
| `test/accountant/reporting-bounds.route.test.js` | fake engine grew the same two seams |
| `nodemon.json` | **new** — see below |

## A flake that was never the engine's fault

The live suite failed 1–3 tests a run, a different one each time, always a 502.
`test/accountant/reporting-mutation.test.js` writes mutated modules next to the
real one (they must sit there for relative requires to resolve). **nodemon saw
those files and restarted the dev server mid-run**, killing whatever request a
parallel Jest worker had in flight. Proven by watching the backend PID across a
run: 38824 → 42465. `nodemon.json` now ignores `__mutant_*.js`, `test/**` and
`scratchpad/**` — it takes effect on the next nodemon start. Three orphaned
mutant files were removed from `routes/Accountant_Routes/`.

This is pre-existing and unrelated to this slice: an A/B with the new gate
disabled produced MORE failures, not fewer, and one of the flaking tests
predates the slice entirely.

## Tests: 551 passed, 0 failed

Run in two parts so the mutation suite cannot restart the server under the
others (until the nodemon config is picked up):

    npx jest test/accountant/reporting test/reporting \
      --testPathIgnorePatterns "reporting-mutation"      # 537 passed, 18 suites
    npx jest test/accountant/reporting-mutation.test.js  #  14 passed

## Live, against GRAV CLOTHING PVT LTD

**Accepted** — voucher numbers across the top, ledgers down the left, total
debit in the cells, filtered to 1–12 Aug 2025: HTTP 200, **17 headings**, 24
ledgers.

    ['1','2','12','13','39/25-26','55','176','177','178','233','234','235',
     '236','305','FC/C08836','FC/C08936','R&C/003/25-26']

Every heading is text, and the order is NATURAL — `2` before `12`, `55` before
`176` — which lexicographic ordering would get wrong. Filtered to `starts_with
"0053"` the single heading is **`00531`**, leading zeros intact.

**Refused** — the same report with no filter: HTTP 422,
`REPORTING_TOO_MANY_HEADINGS`, field `Voucher Number`, maximum 50,
`exact: false`, body **327 bytes**. August 2025 alone exceeds the bound, so it
bites on real books rather than only in theory.

---

# Reporting-stack recovery — hardening (5 Oct 2026)

Follows the recovery entry below. Backend only. **No frontend file changed.**
**Not committed.** No Docker volume was reset or deleted.

## Why a new developer still could not rebuild

The data was back, but three things stood between that and a repeatable
rebuild:

1. README, Makefile, compose.yaml, bootstrap.sh, verify.sh and four scripts all
   said `npm run reporting:migrate|roles|sync|verify-roles`. **None of those
   commands existed in package.json.** Every document was correct when written
   and went stale silently.
2. The documented order was migrate → roles, which deadlocks on a fresh
   database (V003 grants to a role `roles` creates; `roles` granted on views
   only the repeatable migration creates).
3. One red assertion that was about the DATA, not the engine.

## The rebuild command

    npm run reporting:setup              # the plan, runs nothing
    npm run reporting:setup -- --apply   # roles → migrate → roles → sync → verify

Stops at the first failure, exits non-zero, prints no secret, deletes nothing —
no database, schema, row or Docker volume. Emptying a mart is still `make reset`,
deliberately elsewhere. Proven both ways: a clean re-run against the live mart
exits 0 with "24/24 checks passed"; with `REPORTING_SYNC_PASSWORD` unset it
stops at step 1 of 5, exits 1, and says nothing was deleted.

## Changed files

| File | Change |
|---|---|
| `package.json` | added `reporting:setup`, `:migrate`, `:roles`, `:sync`, `:verify-roles`, `:chart-cleanup` — the five that were documented but missing, plus the new one |
| `services/reporting/martSetup.service.js` | **new.** The five steps, their order and the reasons. Takes its runner as an argument so the order is testable without a database |
| `scripts/reporting/setup.js` | **new.** Spawns each step as its own process, inherits stdio, stops on the first non-zero exit |
| `test/reporting/mart-setup.test.js` | **new.** 12 tests: the exact order, roles-twice-with-migrate-between, stop-at-first-failure, no destructive argv, and that every `npm run reporting:…` in the repo's own docs exists in package.json |
| `test/accountant/reporting-integration.route.test.js` | the `< 25%` assertion replaced with durable properties; test renamed off "333-LEDGER" |
| `deploy/metabase-pilot/README.md` | one command, plus a section on why the order is what it is |
| `deploy/metabase-pilot/Makefile` | `reset` now points at `reporting:setup` |
| `deploy/metabase-pilot/compose.yaml`, `bootstrap.sh` | same correction |
| `scripts/reporting/migrate.js`, `roles.js` | headers name `reporting:setup` and say what happens if you run them alone on an empty mart |
| `migrations/reporting/roles/R__roles.sql` | comment names the command that exists |

## The assertion that was replaced

`visibleDebit / martDebit < 0.25` — "the hundred rows on screen are a minority
of the money". True of the books it was written against (333 ledgers), false of
today's (236, where the first hundred hold 48%). Nothing in the engine changed;
an accountant posted vouchers. It is **not** replaced with another percentage —
a different threshold would go red the same way. What replaced it:

- `previewRowCount` equals the rows actually returned;
- `groupCount` is greater than it, and comes from the mart;
- `omitted.rows === groupCount - previewRowCount`;
- per series, `omitted === martTotal - visible` to the paisa;
- the signed series keeps its sign, asserted as
  `sign(omitted) === sign(martSigned - visibleSigned)` rather than a magnitude.

## Verification

`npx jest test/accountant/reporting test/reporting` → **519 passed, 0 failed,
18 suites.**

Live, after every change — the exact report from the original fault:

    POST /api/accountant/reporting/preview
    rows: date.voucher + company.name, company 6a08040a1fecacc9bb7149c2
    → HTTP 200, 100 rows of 3073, truncated
      2025-07-23T00:00:00+05:30 | GRAV CLOTHING PVT LTD
      dataAsOf 2026-10-05T04:30:09Z

---

# Custom Reports data-loading failure — root cause and fix (5 Oct 2026)

Backend repo only. **No frontend file changed.** **Not committed.**

## The cause, in one line

The reporting stack was not running, and could not be rebuilt: Colima (the
Docker VM holding the mart and Metabase) had been recreated at some point,
which destroyed both volumes — and a bootstrap-order deadlock in the mart
tooling meant a fresh mart could not be built from scratch.

The screen's message was a red herring, as suspected. The backend classified
it correctly all along:

    HTTP 503  {"ok":false,"code":"REPORTING_UNAVAILABLE",
               "message":"The reporting engine is unreachable."}

NOT a compiler failure on `date.voucher` + `company.name`: Voucher Date alone,
Company alone and the pair all returned the identical 503 while the engine was
down, and all three return 200 now with no code change to the compiler.

## What was actually wrong

1. **Colima was stopped**, so `postgres-reporting` (127.0.0.1:**15433**, not
   5432) and Metabase (localhost:3100) were both down. `docker volume ls`
   showed **no volumes at all** — the mart data and Metabase's app DB were
   gone, not merely stopped.
2. **A bootstrap deadlock** (the one code defect). `migrate` runs every
   versioned migration before any repeatable one. `V003__voucher_register_view.sql`
   ends with `GRANT SELECT … TO metabase_reader`, and that role is created by
   `roles.js`; but `R__roles.sql` granted on `reporting.v_general_ledger` and
   `v_trial_balance`, which only `R__curated_views.sql` creates — after all the
   versioned ones. So `migrate` stopped at V003 and `roles` failed on the
   missing view. Neither command could go first. It never showed up before
   because the roles pre-dated V003 on the original volume.
3. **Metabase credentials were stale.** A fresh Metabase has no admin, no API
   key and no database connection, so `METABASE_REPORTING_API_KEY` in `.env`
   returned 401.

## Changed files

| File | Change |
|---|---|
| `migrations/reporting/roles/R__roles.sql` | the reader's grants now skip a relation that does not exist yet (`to_regclass` + `EXECUTE format`), and `v_voucher_register` joined the explicit list |
| `.env` (git-ignored) | `METABASE_REPORTING_API_KEY`, `METABASE_EMBEDDING_SECRET`, `METABASE_EMBED_ADMIN_API_KEY`, `METABASE_REPORTING_COLLECTION_ID=7` — the values `bootstrap.sh` minted for the rebuilt Metabase |

The explicit-naming rule is preserved on purpose: the grant list is still one
relation at a time, so a table added by a future migration is still exposed
only by being named there. Skipping an absent object is safe where
`GRANT … ON ALL TABLES` would not be, because the file is REPEATABLE and is run
again after the migrations.

No versioned migration was edited — the migrator refuses that by design
(`REPORTING_MIGRATION_CHECKSUM_MISMATCH`, "Add a new V<n>__ migration instead").

## What was run to restore service

    colima start
    cd deploy/metabase-pilot && docker compose up -d
    node -r dotenv/config scripts/reporting/roles.js   --apply   # roles first now
    node -r dotenv/config scripts/reporting/migrate.js --apply   # V001–V004 + R__curated_views
    node -r dotenv/config scripts/reporting/roles.js   --apply   # grants the new views
    node -r dotenv/config scripts/reporting/sync.js    --full
    ./bootstrap.sh                                               # Metabase admin, DB, collection, keys
    # then the new keys into ../../.env and restart the backend

`verify-roles`: **24/24 passed** — the Metabase connection can read the
approved objects and do nothing else.

`sync --full`: GRAV CLOTHING PVT LTD — 47 groups, 486 ledgers, 1002 vouchers,
3152 lines; source and mart reconciled on all 6 checks, 3 companies committed.

## Live evidence (all after the fix)

| Check | Result |
|---|---|
| catalogue | 200 — 14 fields, grain `voucher_line`, both `date.voucher` and `company.name` present |
| Voucher Date alone | 200 — 20 rows of **3073** |
| Company alone | 200 — 20 rows of **3073** |
| **Voucher Date + Company** | **200 — 100 rows of 3073**, `2025-07-23 / GRAV CLOTHING PVT LTD`, `dataAsOf 2026-10-05T03:54:23Z` |
| unowned company `000000000000000000000000` | **403 `REPORTING_FORBIDDEN`** |
| no cookie | 401 `REPORTING_UNAUTHORISED` |

`6ab1459d…` (IE Demo Garments) returns 200 and should: it is in the
organisation's `tallyCompanyIds`, so it is owned, not unowned.

Browser smoke test on `/accountant/custom-reports`: the two-column report
renders `23 Jul 2025 | GRAV CLOTHING PVT LTD`, status "Showing 100 of 3,073
rows", no error banner, and the "not been connected for reporting" string is
absent from the page. Metabase logs show `POST /api/dataset 202` in 23–60 ms
against the reporting database for those requests.

## Tests

`npx jest test/accountant/reporting test/reporting` → **506 passed, 1 failed,
507 total** (17 suites, 16 passed).

The one failure is **data-dependent, not a regression**, and I have not touched
it. `reporting-integration.route.test.js:950` asserts
`visibleDebit / martDebit < 0.25` — "the hundred rows on screen are a minority
of the money", a finding recorded when the books held 333 ledgers. Measured
against the freshly synced mart: **236 ledgers**, and the first 100 by name hold
**48.00%** of debit (0.4800 — exactly what the test reported). Every invariant in
the same test that is about the ENGINE passed, including
`visible + omitted ≈ complete` for all three series, `groupCount`,
`omitted.rows` and the signed-amount sign. The threshold needs re-baselining
against today's books, or restating as a property rather than a ratio — the
owner's call, not something to loosen quietly.

---

# Latest implementation — the Sales → Merchandising buyer brief

3 Oct 2026. **Nothing committed. No live data touched. No production migration.**

## What changed, in one sentence

Sales can now record what the buyer actually said — price, market, season, fit,
fabric, colours, performance, trims, processes, testing and what to avoid — and
Merchandising receives it as one server-built, read-only Buyer Brief.

## The two defects behind the work

**`targetPriceCeiling` was unauthorable.** It was on the model, validated in the
service, projected to Merchandising and rendered in the page header — and
`DevelopmentRequestPanel.js` had no control for it (`grep -c targetPrice` → 0).
Every request in the database had none, so the header figure never appeared.

**A corrected version carried nothing forward.** `issue()` built each successor
from the posted body alone, so a correction that changed the delivery date
issued a version with no target price, no style reference and no images — and
since the previous version was already superseded, the buyer's ceiling was
simply gone, with nothing in the record showing it had ever been there.

## Reused, not rebuilt

Product, style and buyer identity · required-by date · requirement summary ·
requested categories · reference images and their upload control ·
`targetPriceCeiling` · request ref and version · request immutability and the
`{companyId, requestRef, versionNo}` index · the Ask Sales clarification
workflow · `FORBIDDEN_FIELDS` · the Marketing UI kit and `SourceFacts`.

## Newly captured in Sales

Three typed groups on the versioned request — not a `preferences` blob, so every
fact is queryable and validatable:

| Group | Facts |
|---|---|
| `customerDirection` | market, season + year, intended use, target customer |
| `productDirection` | fit, fabric families, composition, weight/feel, colours, performance, trims and branding, **avoid** |
| `developmentNeed` | sample type/quantity/sizes, sample packaging, printing, embroidery, wash-finish, testing, certification, sustainability |

Each controlled choice is `{ choice, note }` — the choice is what reports count,
the note is the qualification that would otherwise be lost ("relaxed, but not
boxy through the shoulder").

**`choice`, not `value`.** `value` is a forbidden field name on this request (it
means the opportunity's value) and `assertNoForbiddenFields` refuses it at any
depth. Renaming the field was the right way round: weakening a guard that keeps
Sales' commercial record in Sales, to suit a field name, is not.

## The versioning correction

`developmentBriefCarryForward.js` — pure, and applied recursively:

| | |
|---|---|
| field omitted | carries forward |
| field posted as `null` | cleared, deliberately |
| field posted with a value | that value |
| array posted | **replaced whole** — a buyer who sends three instead of four has removed one |
| previous version | untouched, byte for byte |

Validation moved inside the transaction, because the thing to validate is the
MERGED value and the merge needs the version in force. A version stored before
these fields existed carries none, loads exactly as it did, and is correctable.

## Three traps found on the way

- **A Mongoose document spreads its internals.** `open` is a document, so
  `{...previous}` copied `$__parent` into the successor, and an unset
  subdocument materialised with its defaults — `targetPriceCeiling` read back as
  `{amount: null, currency: ""}` and every reissue was refused as partial money.
  Fixed with `toObject()` and an explicit "a ceiling is only a ceiling when it
  carries an amount".
- **`Number(null)` is 0.** The projection coerced an unset amount and produced a
  target price of **₹0 per piece** — a ceiling no material can be selected
  under. Caught by a route test; the raw value must *be* a number.
- **`pruned()` stringified numbers**, so the season year left the form as
  `"2027"`.

## What Merchandising receives

`services/merchandising/buyerBrief.projection.js` — one server-owned, read-only
projection of the file's **current** Sales request version. Every controlled key
is already the words a person reads, every absence is already a sentence, and
the grouping is already decided, so the Summary and Sales Brief tabs choose
which groups to show and neither decides what a fact means.

It reads a **fixed list of paths**, so a field added to the Sales record later
cannot leak by accident — it will not appear until somebody adds it here on
purpose. Images now keep `referenceType`, `storageRef`, caption and the
`{requestRef, versionNo}` that supplied them; the old projection carried only
url and caption, so a brief could not tell an artwork from a packaging shot.
Nothing is copied into Merchandising — every url points at the media Sales
uploaded.

## What changed visually

**Header** — unchanged. It already carried exactly Required by / target price /
Responsible / Whose move.

**Summary** — the "Sales request" block repeated the product, style and buyer
the header shows an inch above, two provenance rows nobody acts on, and the
brief as a paragraph. Replaced by: a four-tile decision strip (target price
emphasised with the `--c1` accent, never the overdue red), who it is for,
product direction as compact facts and tags, the sample and the processes, a
**Must follow** block with *Avoid* first and marked, then the references — one
large, the rest grouped by what each one is of.

**Sales Brief tab** — the complete authoritative source in seven groups plus
Missing information, every absence stated in words, the attribution line
`Recorded by Sales · Read-only in Merchandising · Request vN`, and one **Ask
Sales** action that reuses the existing clarification workflow. No editing
control exists on either surface; a test asserts the only button is Ask Sales.

**Sales form** — four sections that start closed (twenty empty boxes read as
twenty things somebody forgot) and open automatically on a correction when they
already hold something. Printing / embroidery / wash each answer Required / Not
required / **Not confirmed**, and the detail box appears only on Required — a
blank cannot tell "the buyer said no" from "nobody has asked", and those are
different jobs. Options come from `GET /tna/../development-requests/vocabulary`,
never hard-coded.

## Test results

| Suite | Result |
|---|---|
| `test/merchandising/buyer-brief-rules.test.js` **new** | **33 passed** |
| `test/merchandising/buyer-brief.route.test.js` **new** | **7 passed** |
| `components/merchandiser/buyerBrief.test.mjs` **new** | **14 passed** |
| `components/merchandiser/buyerBriefBlocks.render.test.mjs` **new** | **14 passed** |
| `components/sales/.../developmentBriefFields.render.test.mjs` **new** | **12 passed** |
| `test/merchandising/preorder-development.route.test.js` | **111 passed**, unchanged |

The rule matrix is tested as VALUES, not through HTTP: carry-forward and
validation are pure functions, and proving them through a route and a replica
set tested the same arithmetic through thirty writes a case — slower, and a
failure said "400" rather than which rule broke. The route suite keeps only what
needs a real request.

Responsive, measured rather than eyeballed, on `/preview/buyer-brief`:
375px — no horizontal overflow, 2×2 decision strip; 768px — one row of four,
two-column groups; 1440px — four-column facts. The target-price accent measures
`rgb(0, 178, 107)`, which is `--c1`.

## Still with no authoritative Sales source

**Expected margin** — deliberately. It is in `FORBIDDEN_FIELDS` and stays in
Sales, which matches the brief's own instruction not to leak it.

**Sales channel** was in the first brief and not the second; it is not captured.
Market, intended use and target customer cover what the second brief asked for.

## Assistant record links

The central assistant API now returns permission-safe record navigation in
`meta.links`. The producing tool owns the mapping from a verified result to a
CMS route; the language model is never asked to generate links. The same links
are retained in conversation history and rendered beneath responses in the
full assistant page and the global overlay.

Store coverage includes exact catalogue records, filtered/list/existence
queries, expected and recorded receiving results, inventory items/locations,
suppliers, Request Desk records, and purchase-exception orders. Links are only
shown where a concrete CMS detail/action page exists. In particular, an
expected arrival opens the PO Receive workflow, whereas an existing GRN opens
the GRN detail page.

Checks: 73/73 assistant-navigation and focused Store integration tests pass
across 11 suites. The
frontend compiled; the complete build remains blocked later by the unrelated,
pre-existing missing Suspense boundary on `/marketing/campaigns/plans`.

---

# Latest implementation — the /onboarding launcher as an actionables dashboard
# Latest implementation — the employee home on /onboarding

10 Oct 2026, later. Built on the actionables dashboard below. Owner's brief:
"Employee Home Dashboard", plus "make sure the UI matches our apps, it
shouldn't look alien". The owner chose to **only show what exists**: no
company pulse, announcements, kudos, events, training or tickets, and no
sample content. The people directory exposes name, role, department and photo
only. Leave and payslip drawers are offered to employee logins.

## Work first, personal second (owner, 10 Oct 2026, later still)

"Less personal … more about actionables and tasks and data about the role",
then "don't completely remove personal data, keep it secondary".

- **Backend:** `/api/me/home` gains `tasks` (Firestore `cowork_tasks`,
  keyed on the Cowork id).
  - `items` are the person's open / in-progress tasks (`assigneeIds`), minus
    finally-approved ones. Overdue come first; each carries progress, due,
    `sentBack` and `inReview`.
  - The counts are open, overdue, dueToday and sentBack.
  - `toReview` / `reviewItems` are `pending_tl_review` submissions on tasks
    this person approves (`approverId`) or assigned (`assignedBy`).
  - It uses the same queries the workload route and cowork.service already
    run, so no new Firestore index is needed.
- **Work, at the top:**
  - The hero's dial is the workload by urgency (items, the same counting rule
    as the urgency figures).
  - "Needs your attention" lists Cowork, planner and application queues only.
    The person's own leave and attendance corrections moved to the personal
    card (`personalItems`).
  - "Your tasks" (`TasksPanel.js`).
  - "Your work by application", with the role in each and its queue lines
    (`RolesPanel.js`, from `/api/me/actionables` `apps`).
  - Today's schedule and quick actions.
- **Personal, under a quiet "Personal" heading:**
  - "You": attendance, a thin shift bar, small leave rings, your requests,
    and Time off / Payslips.
  - The calendar, which now also marks Cowork task deadlines.
  - "Around GRAV": who is away, and a compact celebrations list.

## Rebuilt the same evening (owner: "not even close to the reference … boring")

The layout now follows the reference pack's structure, using only real data:

- **Hero** (`HomeHero.js`): the app's own stepped slab (`SlabCard`), with the
  person in its tab, the greeting, three clickable figures, the search, and a
  **shift clock**. The clock is an arc from shift start to end with the "now"
  sun and the punch-in mark. It uses the day's attendance row, else
  `home.shift`, the factory hours from `shiftHours.js`. A woven texture is
  drawn in the slab's ink at 5%.
- **App dock** (`AppDock.js`): large plates with queue counts, overlapping the
  hero's edge. "All N" opens the full pin/reorder launcher in a drawer.
- **Needs your attention**: three figures (Urgent / Needs action / To do) that
  filter the list. Each row has an urgency rail and its own action button.
  The all-clear state has a drawn spool.
- **Profile card** (`ProfileCard.js`): today's standing, then Request time off
  and Payslips (employee login) or Raise a request and Planner (anyone else).
  Leave left is shown as the kit's `Ring`s.
- **Your day** (`DayPanel.js`): a timeline with a live "now" line and Join
  links, then planner tasks due today, then who is away as an avatar stack.
- **Calendar** (`CalendarPanel.js`): this month and next, with holidays,
  approved and waiting leave marked, and today ringed. The next holidays are
  listed as date tiles.
- **Celebrations** (`PeoplePanel.js`): cards with a mark per kind, today's
  first, and a kind filter.
- **Backend:** `/api/me/home` adds `shift`, `holidays.month` / `range` (this
  month and next) and `attendance.late` / `workedMins`.
- **Checks:** desktop, tablet and phone, light and dark; no horizontal
  overflow; keyboard paths checked.
- **Motion:** a 520 ms rise and a slow pulse, both off under
  `prefers-reduced-motion`.

## Backend

- `GET /api/me/home` (`routes/Access/meHome.js`, mounted in `server.js`
  right after `/api/me/actionables`). Behind `authenticateCmsSession`,
  `Cache-Control: private, no-store`.
- `services/home/employeeHome.service.js`:
  - It resolves the session to its HR `Employee`. An employee login by `_id`.
    A department account by `employeeRef`, then badge → `biometricId`, then
    email. An accountant by email.
  - It reads nine sections side by side. Each has a 6 s timeout and answers
    `ok`, `none` (nothing to read for this person) or `unavailable`, never a
    fake zero.
  - The sections:
    - today's attendance (`DailyAttendance`);
    - the person's open and coming leave;
    - pending regularizations and document requests;
    - planner tasks overdue or due today;
    - today's interviews (`EmployeeTask`);
    - today's Cowork meetings (Firestore `cowork_scheduled_meets`,
      `participants` array-contains);
    - the next holidays (`CompanyHoliday`);
    - who is on approved leave today;
    - birthdays, work anniversaries and new joiners (company people memoised
      10 min; the birth year is never sent).
  - The answer is memoised per identity for `HOME_CACHE_MS` (30 s);
    `?fresh=1` skips it.
  - `me.selfService` is true only for an employee login. The
    `/api/employee/**` routes read the token id as the Employee `_id`, so
    leave and payslips from the home work only there.
- `GET /api/me/people?q=` searches colleagues: at least 2 characters, every
  word must match, at most 8 results, `{id, name, role, department, photo}`
  only.
- `services/home/homeDates.js` (pure): IST day arithmetic (the
  `Date.now() + 5.5h` / `getUTC*` pattern) and `peopleMoments`, which handles
  the year-end wrap and Feb 29 shown on Feb 28.
- Tests: `homeDates.test.js` (8) and `employeeHome.service.test.js` (5), all
  passing. `npm test`: 2308 / 2309. The one failure is
  `agedBillsForLedger … pre-migration inline output`, and it fails identically
  without these changes.
- No new collection (the cluster is at its cap) and no write anywhere.

## Frontend (grav-cms, `components/home/`)

- `HomeDashboard.js` lays out:
  - a greeting, date and context line;
  - a search pill (Ctrl/⌘K);
  - a 12-column bento from `deck`: attention 8 | today 4, apps 8 | quick
    actions 4, people full width;
  - two columns on a tablet, and one column on a phone in priority order.
- The sections:
  - `AttentionPanel`: own items plus every application's queue, urgent first,
    6 rows then "Show all".
  - `TodayPanel`: attendance, schedule, holidays, away.
  - `AppLauncher`: pin, reorder and recent apps, kept in localStorage.
  - `QuickActionsPanel`: only actions that exist, plus the leave balance for
    an employee login.
  - `PeoplePanel`.
  - `CommandPalette`: cmdk, covering applications, actions and people.
  - `LeaveDrawer`: the app's own `POST /api/employee/leave-applications` and
    withdraw.
  - `PayslipDrawer`: the app's own history and PDF.
- The rules are in `homeModel.mjs` (9 tests).
- Every request sends the session as `Authorization: Bearer` (`authHeaders`).
  `/api/employee/**` does not read the CMS `auth_token` cookie.
- Built on the `.grav-ui` tokens, `components/marketing/ui` and the CEO
  primitives. The header wears the shared `AccountMenu`. The old
  `ActionablesDashboard.js` was removed (nothing referenced it).
- The launcher's tile grid and the leave-balance row use
  `grid-cols-[repeat(3,minmax(0,1fr))]` on purpose: `globals.css` folds any
  plain `grid-cols-3` to one column under 768 px.
- Checked rendered at 1440, 820 and 390 px with stubbed APIs. No horizontal
  overflow, every control has an accessible name, Ctrl+K focuses the search,
  Escape closes it and returns focus. Not yet seen against the live backend in
  a browser.

## Not built, because nothing stores it

Announcements, kudos, events, training, tickets, room booking, expenses and a
notification inbox. Regularization and HR-document requests are counted but
are worked in the GRAV app. Leave and payslips stay in the app for
non-employee logins.

---

# Earlier the same day — the /onboarding launcher as an actionables dashboard

10 Oct 2026. **Committed and pushed on `NEW_CMS_BRANCH` in both repositories**
(owner's request: "the onboarding page should look like a proper dashboard,
the actionables of the entire CMS — if a person has access to five apps, that
should be the screen for their actionables").

The previous handoff (the CLO T-shirt drape, 2 Oct 2026) is in git history.

## What it does

`/onboarding` (frontend `components/onboarding/DepartmentPortal.js`) used to be
a grid of application tiles. It is now a dashboard for every application the
person holds:

- greeting, date and a one-line summary ("13 items need your attention in 2
  applications, 1 of them urgent"), with a Refresh button and an updated time;
- four summary figures: waiting on you, urgent, applications with work, all clear;
- **Needs your attention**: one ranked list across all applications (urgent →
  needs action → to do, then by count). A line switches into the application
  the way a tile always has (`switch-department`) and lands on the page that
  lists those records;
- **By application**: the busiest applications, each with a bar;
- **Your applications**: one card per tile with its role, up to three to-do
  lines, and a real state: loading, all clear, couldn't check, or "open to see
  its work" for an application with no to-do list on the dashboard.

## Backend

`GET /api/me/actionables` (`routes/Access/actionables.js`, mounted in
`server.js` beside `/api/department-team`; it reads its own session through
`services/cmsSession`).

- `services/actionables/actionables.service.js`: the applications counted are
  exactly `listAccessibleApps` (the tiles' own resolver). All applications are
  asked at once, each provider under `ACTIONABLES_PROVIDER_TIMEOUT_MS` (6 s).
  A failure is "unavailable", never "all clear". The answer is memoised per
  identity + token version for `ACTIONABLES_CACHE_MS` (30 s; 0 disables), and
  `?fresh=1` skips the memo.
- `actionablesSummary.js` (pure) ranks the items, drops zero counts, keeps only
  in-app paths (never a URL) and builds the totals.
- `actionableProviders.js` holds one provider per department slug. Each filter
  is the one the department's own list or overview uses, cited in the file.
  Role rules:
  - a viewer is shown nothing to act on;
  - work to do needs write;
  - a decision needs approve;
  - the approval queue (`ChangeRequest`) shows an approver the department's
    pending holds, and an editor only their own.

  Company-stamped models read the canonical (primary) company **or** no
  company: the non-strict read-through. Demo companies are never counted.
- No provider yet for CEO, the finishing stages or embroidery: none has a
  stored, countable queue. Their cards say "open to see its work".

| App | Counts |
|---|---|
| HR | leave and regularizations to decide, document requests, held changes |
| Sales | your overdue follow-ups, customer requests pending, held changes |
| Merchandising | new developments, awaiting approval, clarifications |
| Accounting (approver) | approval requests, spend at finance review |
| Store | overdue POs, MRFs to review, requests to classify, approved purchases to order, draft POs, deliveries expected |
| MPC | measurements still collecting people |
| Cutting | work orders to cut (Cutting's own `workOrderScope`) |
| QC | pieces waiting for re-inspection (`pendingReworkSnapshot`) |
| Packaging | packed cartons not dispatched, cartons to weigh |
| PPC | orders not yet planned, held changes (`project-manager` slug) |
| IE | method studies and bulletins in review (approver), held changes |
| Maintenance | overdue jobs, repairs awaiting a report, open jobs (only where `maintenance_orders` exists) |
| Marketing | enquiries held for review, handovers returned |
| Board (approver) | policy drafts |
| Developer | new alerts, acknowledged unresolved alerts |

## Also in this change: the app-access resolver restored

`ab4dc21` (9 Oct, "maintenance reports …") deleted
`services/access/appAccess.service.js` while `routes/auth/deptAuth.js` still
requires it, so `/api/auth/login` and `/verify` threw MODULE_NOT_FOUND on this
branch. It was restored from `main`'s 8 Oct version (the one-read grant index).

**Not fixed — the owner's call.** The same commit also:

- deleted `services/access/accessGrantAdmin.service.js`, which
  `routes/Access/departmentTeam.js` and `routes/Accountant_Routes/Acc_team.js`
  still require;
- deleted `services/cctv/{cctvLink,config,manager}.js`;
- removed 89 `app.use` lines from `server.js` and added 7.

Unmounted at HEAD as a result:

- the `hrContract()` guards;
- `/api/cms/ppc`, `/api/cms/ie`, `/api/cms/merchandising`, `/api/cms/marketing`,
  `/api/cms/maintenance`, `/api/cms/board/policies`, `/api/costings`;
- QC raw items, finishing, carton dispatch, and more.

See `git show ab4dc21 -- server.js`. The dashboard's counts read the models
directly and work either way, but the pages its lines open call those APIs.

## Verification

- `node --test services/actionables/*.test.js`: 15/15. That is 5 for the pure
  summary, 3 for the service wiring with a stubbed resolver (only allowed apps
  asked, timeout means unavailable, memo, refusal), and 7 for the providers
  against recording stand-ins (role rules, company read-through, filters).
- Every provider filter was cast against its real Mongoose schema, with no
  database. Every path exists and every value casts; the checker was confirmed
  to catch a misspelled path.
- `npm test`: 2201 pass, 1 fail. The failure is
  `services/openItems.test.js` (`agedBillsForLedger`), which this change does
  not touch.
- Frontend: `components/onboarding/actionables.test.mjs` passes 6/6 under the
  repo's runner. Both changed components parse, and the dashboard
  server-renders without error in the data, loading and failed states.
- **Not done:** no run against a live database (no `.env` in this
  environment), so no real counts were seen, and nothing was viewed in a
  browser.


## IE: operations assignment and per-work-order line planning (16 Oct 2026)

Owner's ask: the IE order page must show the product photo etc.; IE assigns /
changes the operations against work orders (one or many at once — "the main
thing"); line planning per work order on the supervisor's 2D/3D floor, with
shortcuts (multi-WO, copy / reference another WO), stored on the WO for PPC.

Backend (grav-backend):
- `models/CMS_Models/Manufacturing/WorkOrder/WorkOrder.js` — `operationsPlan`
  and `linePlan` sub-documents (additive, no default).
- `services/industrialEngineering/ieWorkOrderPlanning.service.js` (+ `.test.js`,
  4 node:test cases) — reads, set/append/copy operations, save/copy/clear line
  plan, floor read, plan sources, registered operations, operators.
- `routes/CMS_Routes/IndustrialEngineering/ieRoutes.js` — `/work-orders/*`.
- `services/industrialEngineering/ieOrders.service.js` — MO rows carry photo,
  variant, operation rows + plan stamp, line-plan summary.

Frontend (grav-clothing):
- `app/industrial-engineering/orders/mo/[moId]/page.js` (rebuilt),
  `…/mo/[moId]/line-plan/page.js` (new),
  `components/industrialEngineering/orders/{WorkOrderRow.js (rebuilt),
  OperationsDrawer.js, LinePlanBoard.js, workOrderPlanning.mjs (+ test, 4 cases)}`,
  `app/production-supervisor/dashboard/tracker/components/FloorCanvas1D.js`
  (`slotBadges`, `machineSlotTap` props), `lib/industrialEngineering/api.js`,
  `app/industrial-engineering/ieShell.test.mjs` (scope of the read-only sweep).

Verification: backend unit tests pass; the FerretDB harness
(`/home/claude/work/e2e/ie-plan.js`, real models + real service, ownership
bound stubbed) passes 19 checks — read with photo/variant, floor read,
register search, set / append / copy operations (closed WO skipped, version
bumps, stamps), save one plan on two WOs each resolving its own operation
rows, copy plan, re-save, sources, clear, refusals. Frontend: pure rules
tests pass; every new JSX file parses (esbuild); `ieShell.test.mjs` 33 pass /
2 fail exactly as at HEAD. Not run here: `next build`, a browser session.
