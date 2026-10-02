# Interactive fit trial — acceptance matrix

**Lane B · acceptance design · 2 Oct 2026.**
Twenty-two cases against `interactive-fit-trials.md`. Adversarial: each one is
written as the thing somebody will actually do that breaks a careless
implementation.

> Separate from `validation-matrix.md`, which covers whether a fitting may be
> produced at all. This pack starts from a fitting that exists and asks whether
> interacting with it can corrupt it, misrepresent it, or reach the pattern.

---

## 1. How to read this

Case identifiers are `IT-nn`. Each gives the setup, the action, what **must** be
true afterwards, and what counts as a failure.

### Outcomes

| Outcome | Meaning |
|---|---|
| **Holds** | the product behaves as specified |
| **Blocked** | the product refuses the action and says why |
| **Ends trial** | the trial is discarded or closed, by design |
| **Degrades honestly** | the product cannot do the thing and says so, in words, with a route forward |

### The invariant every single case also asserts

> **The pattern revision is byte-identical before and after.**

IT-10 tests it directly. Every other case asserts it as a postcondition, because a
feature that holds this rule in twenty-one places and breaks it in one has not held
it.

### Counts

| Group | Cases | Theme |
|---|---|---|
| **A** — action lifecycle | IT-01 … IT-05 | grab, pin, relax, cancel |
| **B** — session and identity | IT-06 … IT-09 | tab, revision, quality, solver version |
| **C** — the authority rule | IT-10 … IT-12 | pattern immutability, approval, publication |
| **D** — honest absence | IT-13 … IT-16 | missing fabric, body, landmarks, neck finish |
| **E** — never mixing | IT-17 … IT-19 | baseline vs trial, staleness, anchoring |
| **F** — the adversary | IT-20 … IT-22 | the screenshot, the shared URL, the stacked trial |

22 cases. None of them is a performance benchmark; §17 of the contract states
behaviour rather than numbers, so the acceptance here is "says what mode it is in",
not "renders in 200 ms".

---

## 2. Group A — action lifecycle

### IT-01 · Grab and release without saving

**Setup.** A completed baseline drape. **Action.** Grab the left chest, pull 40 mm,
release, let it settle. Then navigate away and return.

**Must hold.**

- During drag: the garment shows **"Trial — the pattern has not changed."**
- The nine findings are **suspended**, not recomputed from the held state.
- On return: the **baseline**, exactly as before. No trial, no prompt, no "restore
  your session?".
- Nothing was written to the database. No audit entry, because nothing happened.

**Fails if.** A findings panel updates during the grab. A confirmation dialog appears
on navigation. Any trial state survives the reload. Any write occurs.

### IT-02 · Pin, then Return to baseline

**Setup.** Baseline drape. **Action.** Place a pin on the right hem, drag it 30 mm
outward, let it settle. Press **Return to baseline**.

**Must hold.**

- One click, **no confirmation** — there is nothing to lose.
- The baseline drape returns exactly: the stored `drape.positions` were never
  written, so this is a discard of a working copy and not a recomputation.
- **Redo is empty.** Return to baseline is a discard, not an undo step (§12).
- The pin marker is gone from the viewport and from the pin list.

**Fails if.** A confirmation appears. Redo offers the pin back. The returned garment
differs from the baseline by any amount. The pin list retains an entry.

### IT-03 · Multiple pins

**Setup.** Baseline drape. **Action.** Place four pins — two at the hem, one at each
shoulder. Let it settle. Remove the second pin. Let it settle.

**Must hold.**

- All four pins **visible from every camera angle**, never occluded by cloth.
- The header reads **"4 pins — this garment is being held."**, then **"3 pins"**.
- Each pin resolves its **own** vertex set. Where two pins overlap, the **strongest
  constraint per vertex** wins; displacements are **not summed**.
- Removing one pin re-settles the garment with the other three still held.
- No finding is reported. No surface says "fits".

**Fails if.** Overlapping pins sum and move cloth to a position no pin specified. A
pin hides behind the garment. The pin count is absent. Any dimensional finding
appears while pins are active.

### IT-04 · Relaxing only a selected region

**Setup.** Baseline drape of a woven shirt with visible tension at one armhole.
**Action.** Relax a 60 mm radius region at that armhole at 40% for its duration. Let
it expire.

**Must hold.**

- Only constraints with **both endpoints inside the region** are softened, so the
  region boundary is not artificially slack.
- **Bending is unchanged.** No positional constraint is added.
- While active: **"Softened — not behaving like the real fabric."** persistently, and
  **strain withheld in that region**.
- No dimensional observation can be recorded from the relaxed region while active.
- On expiry: compliance returns to the fabric's own values and the cloth **settles
  again under the real material**.
- The after-state, under the real fabric, **is** a recordable observation — and if the
  cloth settled somewhere materially different, that is reported as the baseline
  having been at a false equilibrium.

**Fails if.** Strain is shown in the softened region as though it were the fabric.
The whole garment softens. Bending changes. The softened state persists silently past
its duration. An observation recorded during relax is stored as a property of the
garment.

### IT-05 · Cancelling during settling

**Setup.** A trial mid-settle after a grab. **Action.** Press Cancel.

**Must hold.**

- The solver stops.
- The garment returns to the **last settled state** — not a half-settled frame.
- **No action is recorded** for the cancelled grab.
- Cancel was **available and responsive throughout**, because the solver is in a
  Worker and the UI never blocked.
- No observation could have been recorded mid-settle: the record control was disabled,
  with the reason shown.

**Fails if.** The UI was frozen and Cancel could not be pressed. The garment is left
in an unsettled intermediate state. The cancelled grab appears in the action list. An
observation was recordable before settling completed.

---

## 3. Group B — session and identity

### IT-06 · Closing the tab during a trial

**Setup.** An unsaved trial with two pins, mid-settle. **Action.** Close the tab.

**Must hold.**

- The trial is **gone**. No autosave, no recovery offer, no draft trial in a list.
- The **baseline job** is unaffected — it already completed.
- If a *baseline* solve had been running rather than a trial, the job is left in
  `simulating` and never reported, which Lane A's adapter already specifies as
  **visible and clearable**: *"A tab that is closed mid-drape leaves a job that never
  reported — visible, and clearable — rather than a preview that silently never
  existed."*
- No partial trial record exists in any state.

**Fails if.** A trial is recoverable. A half-written trial record exists. A job is
left invisible, or is auto-completed from nothing.

### IT-07 · Switching pattern revision

**Setup.** A trial with three pins on revision 3. Revision 4 is approved. **Action.**
Switch to revision 4.

**Must hold.**

- The trial **ends**. Revision 4 needs its own drape; there is no baseline to pin
  against yet.
- If the trial had been saved, it stays attached to **revision 3**, is marked
  **stale** (S1), and reads **"From pattern revision 3. The current revision is 4."**
- The saved trial is **not re-run** against revision 4, and **not re-pointed**.
- Its `baselineJobRef` is unchanged — the field is immutable.
- The undo stack is emptied.

**Fails if.** The trial's pins are carried onto revision 4. The saved trial silently
re-points. A stale trial appears without its label. Undo crosses the revision change.

### IT-08 · Switching Draft to High quality

**Setup.** A trial on a Draft baseline with two pins and one relax. **Action.** Switch
to High quality.

**Must hold.**

- The trial **ends** — a different mesh is a different baseline.
- The **actions survive** and are **offered**: *"Replay these 3 actions at High
  quality?"*
- Accepting produces a **new trial** with a **new `trialRef`** and the High-quality
  job as its baseline. It is not the same trial continued.
- Each region resolves **against the new mesh by pattern-space distance**, so the
  same stored region covers the **same physical cloth** at both qualities.
- **No stored vertex index is used anywhere in this.** This is the case that proves
  §5 works.

**Fails if.** Pins land somewhere else on the garment — the symptom of vertex-index
anchoring. The trial keeps its old `trialRef`. The actions are silently replayed
without being offered. A region resolves to an empty set without being reported.

### IT-09 · Opening a saved trial under a different solver version

**Setup.** A trial saved under `fit-1.0`. The solver is now `fit-1.1`, bumped because
it moves vertices. **Action.** Open the saved trial.

**Must hold.**

- It is **stale** (S2), because `solverVersionAtSave` ≠ current.
- It is **visible as history** with its note, author, date and full provenance intact.
- It **cannot be presented as current** and is excluded from comparison against a
  current baseline.
- Re-running is **explicit** and produces a **new** trial.
- `solverVersionAtSave` existing as a duplicated field is what makes this detectable —
  the one duplication §4.2 allows, for exactly this purpose.

**Fails if.** It opens as current. It is silently re-solved under `fit-1.1` and
presented as the saved trial. It is hidden rather than labelled. Its observations are
compared against a current baseline's.

---

## 4. Group C — the authority rule

### IT-10 · The pattern is byte-identical after every action

**Setup.** A pattern revision with a recorded hash of its stored document. **Action.**
In one session: grab and release; place and remove three pins; relax two regions; undo
four times; redo twice; return to baseline; save a trial; delete the trial; replay a
trial at a different quality.

**Must hold.**

- The pattern revision's stored document is **byte-identical** to its recorded hash.
- Its `outline`, `pieces`, `seamPairings`, `unit` and every geometric field are
  untouched.
- No code path in the trial feature holds a writable reference to a pattern revision.

**Fails if.** Any byte differs. Any field was touched, including a timestamp. This is
the case that justifies the feature existing.

### IT-11 · A trial cannot be approved as a production garment

**Setup.** A saved trial that looks excellent — well settled, calm strain, good
clearance. **Action.** Attempt to approve it, by every route: the fitting screen, the
version list, the API, an export and re-import, and the technical-pack flow.

**Must hold.**

- There is **no approve action on a trial**, anywhere.
- A trial **never appears** in any list of approvable things.
- A trial **cannot become** a pattern revision, a garment model or a publication by
  any route, including export and re-import.
- A trial is **never** the source of a technical pack or an IE projection.
- The permissions table says this explicitly, so a reader looking for the capability
  finds an explicit **no** rather than an absence they could read as an oversight.

**Fails if.** Any route reaches approval. A trial appears beside approvable models.
An export round-trips into a revision.

### IT-12 · A trial is not a publication

**Setup.** A saved trial. **Action.** Look at every list a garment model publication
appears in.

**Must hold.**

- The trial is in **none** of them. Lane A's reasoning applies one level further out:
  filing a drape as a publication *"would put it in the same list as approvable
  models and somebody would approve it"* — and a trial is a drape **plus a human
  intervention**.
- Where a trial does appear, it is labelled as a trial with its baseline named.

**Fails if.** A trial appears in a publication list, a model list, or anything a
factory receives.

---

## 5. Group D — honest absence

### IT-13 · Strain unavailable because fabric evidence is incomplete

**Setup.** A baseline whose fabric profile has weight and bending but **no stretch
values**. **Action.** Open the strain view.

**Must hold.**

- Strain is **unavailable**, as a named, explained empty state: *"This fabric's
  stretch was never recorded, so strain cannot be shown."*
- There is a **route forward** — which profile, and who can supply it.
- **Clearance is still available.** One missing input does not disable the other view.
- The garment still drapes: weight is present, so gravity is real.

**Fails if.** A strain map is rendered from defaults. The panel is blank with no
explanation. A zeroed colour map is shown, which reads as "no strain anywhere" — the
most dangerous possible rendering of missing data.

**Variant IT-13a.** Stretch values present but **no stated load**. Strain **is**
shown and marked **"measured at an unstated load — do not compare this with another
fabric."** Fails if two fabrics measured at unstated loads are ranked against each
other.

### IT-14 · Clearance unavailable because body evidence is incomplete

**Setup.** A baseline with **no body measurements at all**. **Action.** Open the
clearance view.

**Must hold.**

- Clearance is **unavailable**, explained: *"There is no body for this fitting, so
  clearance cannot be shown."*
- **The garment still drapes under gravity** — a drape with no body is a legitimate
  hanging drape and is still evidence about seams closing and panels being on grain.
- **Strain is still available.**
- No default body is substituted.

**Fails if.** A capsule body is invented from nothing. A clearance map is shown
against a default torso. The whole fitting is refused.

### IT-15 · Body measurements but no landmarks

**Setup.** A baseline with a capsule body built from measurements, and no landmark
definitions — which is the real state of the record today. **Action.** Open the
clearance view and the findings.

**Must hold.**

- Clearance **is** shown as a **surface map**, with the capsule limitation printed:
  the body is *"a capsule body built from measurements"*, least like a body exactly
  at the shoulder, armpit and neck where clearance matters most.
- **No per-finding clearance** — shoulder, armhole and sleeve-length findings remain
  **not available** for want of landmarks.
- The map is explicitly **comparable between fittings on the same body** and not an
  absolute statement about a person.

**Fails if.** A landmark is inferred from a plausible height. The surface map is
presented as a tape measurement. An armhole clearance finding appears.

### IT-16 · No neck finish in the pattern

**Setup.** A tee with front, back and sleeves fully mapped and confirmed, and **no
band, collar or facing anywhere**. **Action.** Run the fitting, then a trial.

**Must hold.**

- A fitting **is produced** — a Partial. The drape is **not refused**.
- **"This pattern has no neck finish. The neck opening is unfinished."** shown
  prominently on the fitting, not in a details panel.
- Collar circumference, neck clearance and collar roll are **withheld**, each saying
  why.
- **Nothing is invented**: no band generated, the opening not closed, no approximated
  neck circumference reported from the raw opening.
- Body findings are reported normally, and trials work normally.

**Fails if.** The drape is refused. A band is synthesised. A neck measurement is taken
from the unfinished opening. The missing finish is only mentioned in a details panel.

**Variant IT-16a.** A neck band **exists** in the pattern and is unmapped, or mapped
with unconfirmed alignment. This **must refuse** — R12. Fails if it degrades to a
Partial, because a present-but-half-joined piece is an unfinished mapping and draping
around it would silently exclude cloth the pattern-maker drew.

---

## 6. Group E — never mixing

### IT-17 · Baseline and trial findings never get mixed

**Setup.** A baseline with chest, bicep and collar reported. **Action.** Grab the
chest and hold it open 25 mm. Open the comparison view.

**Must hold.**

- The nine findings are **suspended** in the trial state — not recomputed, and **not
  shown as greyed-out versions of themselves**, which reads as "still true, just
  dimmed".
- The trial shows **trial observations** instead, phrased as what they are: *"held
  open 18 mm at the left chest, the cloth is no longer pulling at the armhole."*
- The comparison view shows baseline and trial **side by side, each with a persistent
  label**, in separate panels.
- **No arithmetic between them** that is not explicitly presented as a difference.
- Nothing anywhere reads "chest fits".

**Fails if.** A findings panel recomputes from the held state. Baseline and trial
numbers appear in one column, one table row, or one list. A difference is shown
without being labelled a difference. Any finding is shown greyed rather than
suspended.

### IT-18 · A stale trial remains visible but cannot masquerade as current

**Setup.** Three saved trials: one current, one on an older revision (S1), one under an
older solver version (S2). **Action.** Open the trial list, open each, and attempt to
use each in a comparison against the current baseline.

**Must hold.**

- All three are **visible**, with notes, authors, dates and provenance intact — a
  stale trial is still a true record of a question somebody asked.
- The two stale ones are **labelled stale in the list and on open**, and in any
  export.
- Neither can be the source of an observation about today's pattern.
- Both are **excluded** from comparison against the current baseline.
- Neither was silently re-run or re-pointed.
- Re-running either is explicit and produces a **new** trial.

**Fails if.** A stale trial is hidden (losing history). A stale trial is unlabelled in
any surface, including export. A stale trial is comparable against the current
baseline. A stale trial is auto-refreshed.

### IT-19 · Anchoring survives what it must and reports what it cannot

**Setup.** A saved trial with a pin on a sleeve interior and a pin on a hem boundary.
**Action.** (a) Replay at High quality. (b) Replay against a revision where that
sleeve was reshaped so the pin's pattern-space anchor now falls outside the piece.

**Must hold.**

- **(a)** Both pins land on the **same physical cloth**: the interior pin resolved by
  pattern-space distance, the hem pin by Lane A's existing `anchorSchema` on an
  outline `pointIndex`.
  No stored vertex index was involved.
- **(b)** The region is **unresolvable** and is **reported by name** — *"This pin was
  placed on part of the pattern that has since changed."* The replay is a **failed
  replay**.
- **(b)** The region is **not quietly dropped**, and the replay is not silently
  truncated to the actions that did work.
- **(b)** This should have been caught as staleness (S1/S4) before replay was offered.

**Fails if.** A pin moves to different cloth across qualities. An unresolvable region
is dropped silently. A partial replay is presented as a complete one.

---

## 7. Group F — the adversary

These three are about people, not code, and they are why §18 of the contract specifies
sentences rather than tooltips.

### IT-20 · The screenshot

**Setup.** A trial where the chest is being held open by a grab and the strain colour
looks calm. **Action.** Screenshot the viewport — just the 3D view, no side panels —
and imagine it in a group chat captioned "chest is fine".

**Must hold.**

- **"Trial — the pattern has not changed."** is **inside the viewport**, persistent,
  and survives the crop. Not a toast, not a side panel, not a status bar outside the
  canvas.
- A pinned state shows its pin count in the viewport.
- A relaxed region shows **"Softened"** in the viewport.
- Pin markers are drawn in the 3D view and are visible from any angle.

**Fails if.** A cropped viewport screenshot of a held, pinned or softened garment is
indistinguishable from a baseline. This is the failure this whole document exists to
prevent.

### IT-21 · The shared URL

**Setup.** A user in an active trial. **Action.** Copy the URL and open it in another
browser, logged in as someone else.

**Must hold.**

- The other person sees the **baseline**, not the trial. Trial state is in one tab's
  memory and is **not in the URL** (§15).
- A **saved** trial may be linked, and opens **labelled as a trial**, with its
  baseline, author, note and date, and its staleness evaluated fresh.
- No URL can encode a trial state in a way that makes it look like a result.

**Fails if.** Trial state round-trips through a URL. A shared link shows a held
garment as though it were a drape.

### IT-22 · The stacked trial

**Setup.** A saved trial. **Action.** Open it and attempt to start a new trial *from
the saved trial's end state* rather than from the baseline.

**Must hold.**

- Either the product **refuses** it, or it is explicit: the new trial's baseline is
  still the **same `baselineJobRef`**, and its action list is the old trial's actions
  **plus** the new ones, as one ordered list replayable from the baseline.
- There is **no trial whose baseline is another trial**. A trial always names exactly
  one baseline job (§2), and a chain of trials on trials would make provenance a
  claim rather than a fact.
- The combined action list replays from the baseline, or it is a failed replay.

**Fails if.** A trial records another trial as its baseline. A trial stores an end
state and builds on it, so its result cannot be re-derived from a pattern revision.

---

## 8. What this pack does not cover

- **Performance numbers.** §17 specifies behaviour — never blocking, detected
  capability, a visible mode — not milliseconds. A benchmark suite is Lane A's to
  write against real devices.
- **Solver correctness.** Whether the cloth settles *correctly* is not tested here;
  only whether the product is honest about what it settled to.
- **Multi-user concurrency.** Two people trialling the same baseline at once is
  harmless today because trials are ephemeral and local. If trials ever become
  shared, this pack needs cases for it.
- **Accessibility beyond colour.** §11.5 requires colour never be the only channel;
  full keyboard operation of grab and pin is not specified and should be.
- **Movement.** Still one static pose, as in `validation-matrix.md` §5. A trial can
  hold a sleeve up, which is *not* the same as simulating an arm lifting.
