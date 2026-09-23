# F-0 — Frontend-first Controlled Documents prototype

> **Status:** Ready to activate; not active. User requested frontend first on 2026-09-22. `docs/tasks/current-task.md` still tracks Image Studio work in the existing checkout. This brief does not activate a second task in that checkout.
>
> References: `docs/product/controlled-documents.md`, `docs/decisions/controlled-documents-boundary.md`, `docs/tasks/controlled-documents-roadmap.md`.

## Implementation prompt

Work in the frontend repository `/Users/risheeray/grav-cms`. Build **F-0 only**: a reviewable, interactive prototype of the Controlled Documents app using synthetic data. Use an isolated worktree if the current checkout still has unrelated uncommitted changes. Bring these untracked planning documents into the worktree as reference. Do not modify the existing checkout or backend application code.

Before editing, read the three references above, frontend `CLAUDE.md`, the current shared-shell components, and the existing preview-route conventions. Record the baseline Git status and tests. Report a short file-level plan.

### Build

- A preview-only entry point under `/preview/controlled-docs`, visibly labelled **Prototype · sample data**. Keep it out of the production app switcher and `/controlled-docs` route until capability-gated backend access exists. Use the existing shared top bar/shell styling; do not fork or redesign `TopBar`, `FrostShell` or `AppShell`.
- Reusable presentation components and a React-free model for the document library, reader, structured builder and review inbox. The preview should show one complete synthetic Policy, SOP and Machine Work Instruction, including versions and lifecycle states.
- Library: search/filter controls, type and status badges, due-review information, and clear empty states.
- Builder: choose a template; required sections from plan §4; paragraph, list, step, callout, table, image, attachment and document-reference blocks; add, reorder and delete steps; validation checklist naming missing required sections; a read-only preview. Demonstrate the difference between a draft and an approved version. Keep edits in memory only; never imply they were saved.
- Reader: current effective version, document number, owner, approver, effective date, review date, safe rendering of all block types, and a prominent machine-friendly step view for an MWI example. Do not implement pairing or token storage in F-0.
- Review screens: awaiting review, awaiting approval, and history as sample-data states. Labels and controls may demonstrate the intended flow, but must not pretend to have recorded a review or approval.
- Responsive layout for desktop and tablet; check the shared top bar is consistent with the other apps. Include a profile icon at its existing right-end position through the shared shell.

### Boundaries

- No network calls to controlled-docs endpoints, no real documents, no persistent browser storage, no PDF export, no route or API that changes document state.
- No app registration, capability tile, middleware change or production route. Those belong to CD-8 after CD-2 access exists.
- No changes to barcode, scan, production, machine register, PPC, HR scoring, C4, or CoWork code. Do not edit shared shell internals to fit the prototype.
- Do not commit. Preserve unrelated changes byte-for-byte.

### Acceptance

1. A reviewer can navigate the sample library → reader → builder → review screens and inspect all three document types.
2. Required sections and step numbering behave according to the product plan. Sample edits update the local preview and validation list, with an always-visible sample/unsaved label.
3. No screen presents sample approvals as real or provides an actionable publish button.
4. The prototype works at desktop and tablet widths and uses the shared top bar.
5. Focused frontend tests cover template/step/validation logic. Run the frontend test suite and record its result, plus a browser check of the preview.
6. Compare the final Git status and diff against the baseline; only F-0 files and an implementation handoff entry changed. Report any pre-existing failures separately.

Stop after F-0 and show the result for product review. Do not start backend CD-1 or wire real APIs until the prototype is reviewed.
