> **Status:** Active planning.
>
> **Current requested work:** Study the Sales Accounts app in
> `/Users/risheeray/grav-cms` and `/Users/risheeray/grav-cms-backend`, then
> scope a proper customer/account budget feature for the Account workspace.
> The active planning brief is
> `docs/tasks/sales-account-budget-feature.md`.
>
> **Important:** This is a product/architecture planning task. Do not change
> application code for the Account Budget feature until an implementation slice
> is explicitly requested.
>
> ---
>
> **Previous paused work:** Redesign the full Accounting app in
> `/Users/risheeray/grav-cms` so it follows the current Sales app design
> language. The active planning brief is
> `docs/tasks/accountant-sales-design-redesign.md`.
>
> **Important:** The Sales lead/journey scope below remains durable context, but
> it is not the active implementation target while the Account Budget feature is
> being planned.

> **Previous status before pause:** Active
>
> **Product model (current, supersedes the older 6-chunk plan below):**
> Prospect (a possible buyer we've found and are still preparing to work) and
> Active Lead (one we're actively researching, contacting and qualifying) are
> the SAME `Lead` record — internal `captureStatus: draft`/`active` is
> unchanged; "Prospect" is a user-facing rename only, no field rename, no
> migration. Sales Journey is unaffected: a qualified, specific commercial
> requirement being pursued, created only after qualification (Chunk 5).
>
> **Chunk plan:**
>
> 1. Prospect capture and setup — **done, including the follow-up correction
>    pass.**
> 2. Active Lead activities and controlled statuses — **not formally started
>    as its own chunk, but a meaningful part of it already exists**: see
>    "What Chunk 2 inherits" below. Not yet done: reviewing whether the
>    inherited work fully satisfies Chunk 2's intent, and an editable
>    identity/contact UI for an Active Lead (`LeadWorkspace.js` currently
>    shows Contact facts read-only — Prospect Setup's `IdentitySection` was
>    deliberately trimmed to a short enrichment step in the correction pass,
>    on the understanding that "deeper information belongs in Active Lead";
>    nothing currently provides that surface).
> 3. Requirement, commercial potential and qualification — partially
>    inherited (see below); not formally scoped as its own chunk.
> 4. Secure evidence/document handling — **not started.** The old,
>    unsecured Cloudinary-upload evidence path was hidden from the UI in the
>    correction pass (`EvidenceSection` in `leadSections.js`) rather than
>    presented as if complete; Source URL / Document reference text fields
>    remain available.
> 5. Conversion to Account, Contact and Sales Journey — **not started.**
>
> **Instruction:** Do not implement Chunk 2 (or any later chunk) as new work
> without it being separately scoped and requested — the items above
> describe what already exists, not a green light to proceed. When Chunk 2
> is actually taken up, start by reviewing what's listed below rather than
> assuming a blank slate.
>
> **Superseded:** `docs/tasks/lead-to-journey-roadmap.md`'s six-chunk
> breakdown ("Chunk 1 — Lead foundation", "Chunk 2 — Lead Inbox and quick
> capture", …) is an EARLIER numbering scheme for the same overall Lead →
> Sales Journey arc. The product model and chunk list above are what's
> current; that file's own status line has been marked superseded but its
> body was not rewritten.

# What exists today (for whoever picks up Chunk 2 next)

## Inherited from the "Lead correction chunk" (predates the 5-chunk product
## model above, but lands squarely inside Chunk 2/3's territory)

- Canonical qualification vocabulary: `new → contactAttempted → contacted →
  qualified/nurture/disqualified/duplicate → readyToConvert` (`new` may also
  reach `contacted` directly for the one-call-and-it-connects case).
- Every transition's prerequisite is enforced server-side in
  `services/leadQualification.js`, not only the UI: Contact Attempted needs a
  logged outreach attempt; Contacted needs a genuinely successful two-way
  contact; Nurture needs a reason + next action + follow-up date; Qualified/
  Ready to Convert share one checklist
  (`services/leadReadiness.js`'s `computeQualificationReadiness`); Duplicate
  requires a genuine, existence-verified Lead/Account link.
- Structured Activity outcomes (`no_answer`/`replied_connected`/
  `meeting_completed`/`other`), `lastContactedAt` gated on a genuinely
  successful contact, Draft Leads blocked from having Activities.
- `Lead.requirementCertainty` (confirmed-requirement side, separate from the
  researched-potential confidence fields) exists but has no UI beyond what
  `LeadWorkspace.js`'s "Supporting details" already shows.
- Manager-only owner/source reassignment; employee names always server-
  derived, never client-trusted.
- The full frontend for this lives in `LeadWorkspace.js` (Active Lead
  workspace) — "Move this lead", the qualification checklist, the duplicate
  picker, structured outcome dropdown are all already built and verified.

## What Chunk 2 (as newly scoped) still needs, if/when it's taken up

- Decide whether the inherited qualification/activity work above already
  satisfies Chunk 2's intent, or whether it needs revision now that the
  product model has Prospect/Active Lead terminology and a 5-item "Start
  Working Lead" bar that didn't exist when it was built.
- An Active Lead identity/contact editing surface (see status note above).
- Whatever else Chunk 2 is scoped to cover once that scoping happens —
  nothing below this line should be treated as decided until it is.
