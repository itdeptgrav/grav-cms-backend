# GRAV Help — Fast Chunk 1 Review

> **Review date:** 2026-09-06
>
> **Verdict:** One small correction required before final acceptance
>
> **Reviewed scope:** `/Users/risheeray/grav-cms` Help implementation against
> `docs/tasks/help-app-chunk-01.md`

## 1. Finding

### P2 — `last_verified` accepts impossible calendar dates

`lib/help/content.js` validates the `YYYY-MM-DD` shape and then uses
`Date.parse(...)`. JavaScript normalises some impossible dates instead of
rejecting them:

```text
2026-02-29 -> 2026-03-01
2026-02-30 -> 2026-03-02
2026-04-31 -> 2026-05-01
```

The implementation and handoff claim that `last_verified` is a **real** ISO
date, so invalid calendar dates must be refused. Compare the parsed UTC year,
month and day back to the three source components, or use an equally strict
calendar check. Add focused leap-year and month-length cases.

This is the only required correction found.

## 2. Verified

- `/help`, topic and article route structure matches the chunk.
- Content is stored in five version-controlled Markdown files.
- The parser emits typed React-safe data and does not render raw HTML.
- Article bodies load after the page's authoritative session verification.
- Search receives metadata only, not article bodies.
- Application cards originate from the verified department list.
- `from` rejects external/protocol-relative/control-character inputs.
- Context is preserved through Help home, hub and article links.
- The launcher is mounted once in `AppShell` and hidden on Help/public routes.
- No dependency or backend Help API/model was added.
- Store and Sales guide/tour sources were not modified.
- All 43 focused Help tests pass.
- The production build compiled successfully. It later stopped while
  prerendering `/hr/dashboard/documents` on an unrelated pre-existing error;
  no Help compile error was reported.

## 3. Non-blocking prerequisite for Chunk 2

`generateMetadata()` currently loads the published content catalogue before
the page-level session check. The present five guide titles are universal and
non-sensitive, so this does not block Chunk 1. Before restricted application
guides are introduced, metadata lookup must use the same authorised catalogue
as the page or return generic Help metadata. No restricted title, summary,
keyword, route or body may be derived before authorisation.

## 4. Re-review required

After the strict date correction:

1. run the two focused Help test files;
2. show that `2026-02-29`, `2026-02-30` and `2026-04-31` are refused;
3. show that `2024-02-29` is accepted;
4. update `docs/handoff/help-app-latest.md` with the correction and results.

No broader retest is requested.
