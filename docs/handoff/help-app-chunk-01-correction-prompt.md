# Claude Code prompt — GRAV Help Chunk 1 correction

Use `/Users/risheeray/grav-cms` as the implementation repository and
`/Users/risheeray/grav-cms-backend` as the documentation repository.

## Goal

Correct the one finding from the Codex review of GRAV Help Fast Chunk 1, then
stop. Do not begin Chunk 2.

## Required reading

Read:

- `/Users/risheeray/grav-cms-backend/docs/tasks/help-app-chunk-01.md`
- `/Users/risheeray/grav-cms-backend/docs/audits/help-app-chunk-01-review.md`
- `/Users/risheeray/grav-cms-backend/docs/handoff/help-app-latest.md`
- `/Users/risheeray/grav-cms/lib/help/content.js`
- `/Users/risheeray/grav-cms/lib/help/content.test.mjs`

## Pre-flight

1. Run `git status --short` in both repositories.
2. Preserve every existing uncommitted change.
3. Do not revert, format or edit unrelated files.
4. Do not commit or create a branch.

## Required correction

`last_verified` currently checks the `YYYY-MM-DD` shape and then relies on
`Date.parse(...)`. JavaScript normalises some impossible calendar dates, so
values such as `2026-02-30` incorrectly pass.

Replace that check with a strict calendar-date validation that:

- requires the existing zero-padded `YYYY-MM-DD` format;
- rejects impossible days for the selected month;
- applies real leap-year rules;
- does not depend on locale or local time zone;
- keeps the same developer-facing `HelpContentError` behaviour and clear error
  message;
- changes no other content parsing or rendering behaviour.

A valid implementation may parse the three numeric components, construct a UTC
date and compare the resulting UTC year, month and day back to the source. Use
an equally strict approach if it is simpler and clearer.

## Required focused cases

Extend `lib/help/content.test.mjs` to prove:

- `2026-02-29` is rejected;
- `2026-02-30` is rejected;
- `2026-04-31` is rejected;
- `2024-02-29` is accepted.

Preserve the existing invalid-format cases.

## Verification

Run only:

```bash
node --test lib/help/routeMatcher.test.mjs lib/help/content.test.mjs
```

Do not run the full suite, production build, lint or browser walkthrough for
this correction.

## Documentation

Update:

`/Users/risheeray/grav-cms-backend/docs/handoff/help-app-latest.md`

Append a short correction note containing:

- the strict validation approach;
- the four added calendar cases;
- the focused test command and exact result;
- confirmation that no other implementation scope changed;
- confirmation that Chunk 2 was not started;
- commit status.

## Stop condition

Stop after the date validator, focused cases and handoff note are complete.
Do not add Store/Sales guides, permission filtering, metadata changes, AI,
analytics, screenshots or tours.
