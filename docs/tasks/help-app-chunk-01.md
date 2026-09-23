# GRAV Help — Fast Chunk 1: Foundation

> **Status:** Ready for implementation
>
> **Primary repository:** `/Users/risheeray/grav-cms`
>
> **Documentation repository:** `/Users/risheeray/grav-cms-backend`
>
> **Scope:** Frontend Help foundation and five Getting Started guides only
>
> **Do not begin:** Store/Sales guide migration, screenshots, tours, GRAV AI,
> analytics, browser authoring, backend Help APIs or exhaustive test work

## 1. Goal

Deliver the smallest useful authenticated GRAV Help application:

- `/help` home with search;
- one application/topic hub;
- one reusable task-guide page;
- five Getting Started guides;
- a global “Help for this page” launcher;
- a simple route-to-guide matcher;
- an update-friendly, version-controlled content format.

At completion, an authenticated employee can open Help from any GRAV screen,
search the initial guides, open an article and return to the screen they came
from. No business records are read or changed.

## 2. Required reading before editing

Read these files first:

- `/Users/risheeray/grav-cms-backend/AGENTS.md`
- `/Users/risheeray/grav-cms-backend/docs/product/help-app-plan.md`, especially
  sections 4–6 and 13–15
- `/Users/risheeray/grav-cms/components/shell/AppShell.js`
- `/Users/risheeray/grav-cms/components/shell/AppSwitcherNav.js`
- `/Users/risheeray/grav-cms/components/shell/useMyApps.js`
- `/Users/risheeray/grav-cms/components/access/useDeptRole.js`
- `/Users/risheeray/grav-cms/components/access/DepartmentGuard.js`
- `/Users/risheeray/grav-cms/components/shell/FrostShell.js`, only the public
  props and layout sections needed to follow its visual conventions
- `/Users/risheeray/grav-cms/app/onboarding/page.js` and the components it uses
  to understand the authenticated application list
- `/Users/risheeray/grav-cms/lib/salesJourney/stageConfig.js`, only as a model
  for canonical reusable guidance; do not modify it in this chunk
- `/Users/risheeray/grav-cms/components/store/StoreQuickTour.js`, only as a
  model for route-aware help; do not modify it in this chunk

Inspect nearby tests and current design primitives before choosing final
component names.

## 3. Pre-flight

1. Run `git status --short` in both repositories.
2. Preserve all existing uncommitted changes. Both repositories contain large
   active Sales, Store, Costing, Accounting and production changes.
3. Do not reformat or clean unrelated files.
4. Do not replace or truncate `docs/tasks/current-task.md`.
5. If a proposed file already exists by implementation time, adapt to it and
   record the conflict instead of overwriting it.
6. Do not commit or create a branch unless the user separately requests it.

## 4. Fixed decisions

1. Help lives inside the existing Next.js frontend at `/help`.
2. Help is not a department and does not mint or switch a department token.
3. Only a server-verified authenticated employee may render the Help
   application.
4. The current route is context for finding an article, never authority.
5. Help is read-only. It may link to a business screen but never submit a
   business action.
6. The first chunk contains general Getting Started content only. Do not put
   Costing, margin, salary, payroll, financial figures or other restricted
   guidance into a client-delivered content bundle.
7. Keep content in version-controlled `.md` files with validated metadata.
8. Add no Markdown, search, tour or analytics dependency in this chunk.
9. Render a deliberately small safe Markdown subset; never use raw HTML or
   `dangerouslySetInnerHTML` for Help content.
10. UI changes update their related Help article in the same change, using
    `source_refs` and `last_verified`.

## 5. Proposed file structure

Final names may follow repository conventions, but keep these ownership
boundaries:

```text
grav-cms/
  app/help/
    layout.js
    page.js
    [app]/page.js
    [app]/[slug]/page.js
  components/help/
    HelpGate.js
    HelpHome.js
    HelpArticle.js
    HelpLauncher.js
    HelpSearch.js
  content/help/
    getting-started/
      sign-in.md
      choose-an-application.md
      switch-applications.md
      understand-access.md
      get-help-for-this-page.md
  lib/help/
    catalogue.js
    content.js
    routeMatcher.js
```

Do not create backend models, routes or collections.

## 6. Content format

Each `.md` guide begins with simple YAML-like front matter:

```yaml
---
id: getting-started.switch-applications
title: Switch between GRAV applications
app: getting-started
summary: Open another application available to your account.
kind: task
status: published
owner: Platform
last_verified: 2026-09-06
routes:
  - /onboarding
source_refs:
  - components/shell/AppSwitcherNav.js
  - components/shell/useMyApps.js
keywords:
  - switch app
  - applications
  - department
---
```

The visible body uses this fixed structure:

```markdown
## Use this when

## Before you start

## Steps

## Done when

## If blocked

## Who acts next
```

### Parser boundary

Implement a small server-only loader/parser sufficient for this controlled
format. It may support:

- `##` headings;
- ordinary paragraphs;
- `-` bullet lists;
- numbered lists;
- inline code if trivial to support safely.

It must treat all content as text/React nodes. Do not support arbitrary HTML,
scripts, embedded components or external image markup.

Validate at load/test time:

- unique `id`;
- required metadata;
- `status` is one of `draft`, `published`, `needs_review`, `legacy`, `retired`;
- routes start with `/`;
- `last_verified` is an ISO date;
- published articles contain all six required visible sections;
- source references are repository-relative strings and do not escape upward.

Malformed published content should fail with a clear developer-facing error,
not partially render.

## 7. Application catalogue

Create one small Help catalogue for display metadata and route-prefix matching.
For Chunk 1 it needs:

- `getting-started` as a universal topic;
- known application slugs/prefixes needed to identify the app the user came
  from;
- display name and dashboard/help fallback path.

The catalogue is navigation metadata, not an access-control source. The
authenticated department list remains authoritative for which application
cards the employee may see.

Costing and future capability-only applications can be added in a later chunk
when their server-side Help visibility contract is implemented. Do not infer
their access from a typed URL.

## 8. Routes and screens

### `/help`

Show:

- “GRAV Help” title and a short purpose sentence;
- search input focused by a visible action, not forced on every load;
- Getting Started card;
- application cards for the departments returned by the existing verified
  session, clearly marked “Guides coming next” when they have no content;
- matching articles as the user searches;
- honest no-result state;
- optional “Back to previous screen” when a safe `from` path exists.

Search only published articles. Search title, summary and keywords first; body
matching may be included if it remains simple.

### `/help/[app]`

Show the topic/application title, its published articles and a back-to-Help
link. Unknown topics return the normal not-found experience.

### `/help/[app]/[slug]`

Show:

- article title and summary;
- owner and last verified date;
- the standard guide sections;
- links back to its application hub and Help home;
- a safe return link when supplied;
- a small “Information out of date?” note telling the employee to contact the
  named owner. Do not build feedback storage yet.

Draft, retired and legacy articles must not appear in ordinary navigation or
search. Only `published` is needed for the five initial guides.

## 9. Authentication and visibility

- Reuse the current shared `verifySession()` request/cache rather than adding a
  competing authentication call.
- Do not render article contents until verification succeeds.
- On unauthenticated response, follow the existing sign-in behaviour and
  preserve a safe return path if current conventions support it.
- Do not accept departments, roles or capabilities from query parameters,
  local storage or article metadata as proof of access.
- The five Getting Started guides are available to every verified employee.
- Department application cards come only from the verified response.
- A failure to load the session shows a retryable error, not an empty Help
  library.

Because Chunk 1 contains no sensitive application articles, a backend Help
content API is deliberately deferred. Before restricted content is introduced,
the later chunk must enforce filtering before content is sent to the browser.

## 10. Contextual Help launcher

Add one `HelpLauncher` at the shared `AppShell` level so it is implemented once
for authenticated routes.

- Hide it on public/sign-in/customer approval routes using the same route
  boundary already used by `AppShell`.
- Hide it on `/help` itself.
- Link to `/help?from=<encoded current pathname>`.
- Accept only a pathname beginning with one `/`; reject protocols, `//`, full
  URLs and control characters.
- Keep `from` as a return/context value. Never navigate automatically to an
  arbitrary supplied value.
- Make it keyboard accessible with the label “Help for this page”.
- Position it so it does not cover the global GRAV assistant, mobile navigation
  or primary submit controls. Prefer a small shell/header action when a shared
  insertion point exists; otherwise use a restrained fixed control after
  checking the assistant's occupied corner.

Do not edit every department layout separately.

## 11. Route matching

Create a pure matcher that:

- strips query/hash values;
- normalises trailing slashes;
- recognises parameter placeholders such as `:id`;
- returns exact/specific matches before application-prefix fallbacks;
- returns Getting Started Help or an application hub when no article matches;
- never throws on malformed input.

Chunk 1 mappings only need `/onboarding`, the main signed-in application route
families and the five Getting Started articles. Store/Sales task-level mappings
belong to Chunk 2.

## 12. Visual direction

- Reuse GRAV Frost variables and existing primitives.
- Keep the home page quiet: one search field, application cards and results.
- Use readable article measure rather than a dashboard-width text column.
- Support the existing light/dark theme without adding a Help-only theme.
- Make the three screens usable at 375 px and desktop widths.
- Do not add screenshots, animations, diagrams or a new design system.

## 13. Initial five guides

Write and verify:

1. **Sign in to GRAV** — what account/session is required and safe handling of
   a failed sign-in. Do not document credentials or bypasses.
2. **Choose an application** — the app portal shows only granted applications.
3. **Switch applications** — use the existing app switcher without treating a
   missing app as a UI bug.
4. **Understand access and approvals** — hidden actions, read-only access and
   held-for-approval work in plain employee language.
5. **Get Help for the current page** — launcher, search, return link and what to
   do when no verified guide exists.

Do not invent generic instructions where the code does not establish the
behaviour. If sign-in or approval behaviour varies by application, keep the
guide narrow and state the limitation.

## 14. Fast verification only

Do not run the full frontend test suite or broad visual regression.

Add focused tests for:

- content parsing and required metadata;
- duplicate IDs and invalid route/source values;
- published-section validation;
- exact, parameterised and fallback route matching;
- unsafe `from` values being rejected;
- draft/retired content excluded from normal results.

Run only the new focused test files using the repository's bare Node test
pattern. Also run lint only on files changed in this chunk if practical.

Perform two manual checks:

1. Authenticated desktop: open a normal application page, open Help, search,
   read an article and return.
2. Phone-sized viewport: repeat the same path and confirm the launcher and
   article do not cover navigation or controls.

If a manual check cannot run because the local app/session is unavailable,
record that honestly; do not expand scope to repair the environment.

## 15. Acceptance criteria

- `/help`, `/help/getting-started` and five article URLs work for a verified
  employee.
- An unauthenticated visitor cannot read the Help article body.
- Search returns the five published guides and shows a useful no-result state.
- Only server-returned department applications appear as application cards.
- Help opens with current-route context and offers a safe return link.
- The launcher is implemented once and is absent on public routes and Help.
- Content lives in `.md` files and can be updated without editing React pages.
- Invalid published content fails clearly during the focused content check.
- No application business workflow, backend API, database model or existing
  Store/Sales help implementation changes.
- No dependency is added.
- All unrelated and uncommitted work remains untouched.
- Nothing is committed.

## 16. Handoff

Create or update:

`/Users/risheeray/grav-cms-backend/docs/handoff/help-app-latest.md`

Record:

- files added and changed;
- final content schema and parser boundary;
- authentication and safe-return behaviour;
- route matcher behaviour;
- the five article IDs and URLs;
- focused checks and exact results;
- manual desktop/mobile result or why it could not run;
- known limitations for Chunk 2;
- confirmation that no backend, Store/Sales guides, tours, AI or analytics were
  started;
- commit status.
