# Sales Journeys Page — Intuitive UI Refinement

> **Status:** Proposed focused frontend task
>
> **Page:** `/sales/dashboard/journeys`
>
> **Frontend repository:** `/Users/risheeray/grav-cms`
>
> **Scope:** The Sales Journeys list/Hub page only
>
> **Do not change:** Individual Journey stage pages, backend code, APIs, models, dependencies, configuration, fixtures, or Git settings

---

## 1. Objective

Make the Sales Journeys page understandable to a salesperson without teaching them the CRM data model first.

Within five seconds, the page should answer:

1. What needs my attention now?
2. Which customer Journey is this?
3. Which lifecycle stage is it in?
4. What is the next action?
5. When is it due and who owns it?

The page should feel like a daily sales worklist connected to a lifecycle, not a generic database table with many filters.

---

## 2. Current-page diagnosis

Claude's latest version is materially cleaner than the first prototype. It already:

- Reduced the header copy.
- Moved advanced filters into a drawer.
- Removed the card/table mode switch.
- Uses a table on larger screens and cards on mobile.
- Reduced the information shown per Journey.
- Uses `Sales Journeys` consistently in navigation and breadcrumbs.

However, the page still starts with five equal view choices:

- My Journeys.
- Team Journeys.
- Needs Attention.
- Waiting on Customer.
- At Risk.

This makes users decide how to query the system before the system tells them what matters. `Needs Attention`, `Waiting on Customer`, and `At Risk` are not equal destinations; they are conditions that require action. Treating all five as equivalent tabs weakens the page hierarchy.

The default is also `Team Journeys`, which presents the broadest dataset instead of the user's immediate work.

The result table is clean but still makes `Stage` and `Status` separate concepts without explaining progress through the eight-stage lifecycle. A salesperson should understand `Cost & Quote · Stage 4 of 8` more quickly than two unrelated cells.

---

## 3. Core design decision

Use one primary worklist with two ownership scopes:

- **My work** — default.
- **Team** — secondary.

Treat urgency and waiting conditions as quick filters, not primary page tabs:

- Needs attention.
- Overdue.
- Waiting on customer.
- At risk.

The user should land on useful work immediately and refine only when necessary.

---

## 4. Proposed page structure

```text
┌─────────────────────────────────────────────────────────────────────┐
│ Sales Journeys                                      [Start Journey] │
│ Follow each customer requirement from Account to Retention.         │
├─────────────────────────────────────────────────────────────────────┤
│ YOUR FOCUS                                                          │
│ [3 Need attention]  [1 Overdue]  [2 Waiting on customer] [1 At risk]│
├─────────────────────────────────────────────────────────────────────┤
│ [My work] [Team]     Search journeys…                 [Filters 2]   │
│ Active filters: [Cost & Quote ×] [A. Sharma ×]                      │
├─────────────────────────────────────────────────────────────────────┤
│ 12 active journeys                              Sorted by urgency ▾ │
│                                                                     │
│ MetroCare Uniform Programme                         DUE TOMORROW    │
│ SJ-2026-0042 · MetroCare Hospitals                                  │
│ Cost & Quote · Stage 4 of 8  [Waiting on customer]                  │
│ Next: Receive revised quantity confirmation          R. Mehta       │
│ ─────────────────────────────────────────────────────────────────── │
│ Northstar AW26 Knitwear                              ON TRACK       │
│ SJ-2026-0048 · Northstar Buying House                              │
│ Style & Sample · Stage 3 of 8  [In progress]                         │
│ Next: Submit fit sample for approval                  S. Khan        │
└─────────────────────────────────────────────────────────────────────┘
```

This is a hierarchy reference, not a requirement to copy ASCII styling.

---

## 5. Page header

### Required content

- Title: `Sales Journeys`.
- Subtitle: `Follow each customer requirement from Account to Retention.`
- Primary action: `Start Journey`.

### Prototype behaviour

Because Journey creation has no backend:

- Keep `Start Journey` visibly marked as preview.
- Do not display a full prototype explanation beside the main subtitle.
- Place a small `Preview data` indicator near the result count or in an information tooltip.

### Remove from the header

- `Journey Hub` wording.
- Long explanations about fixtures and live Account resolution.
- A permanently visible refresh button unless live refresh is operationally necessary.

If Refresh is retained, put it inside a small overflow menu or next to the result timestamp.

---

## 6. Your Focus summary

### Purpose

Tell the user what requires attention before showing the complete worklist.

### Summary items

Show no more than four compact items:

1. Needs attention.
2. Overdue.
3. Waiting on customer.
4. At risk.

Each item contains:

- Count.
- Plain-language label.
- State icon.

### Interaction

- Selecting an item filters the worklist.
- Selecting the active item again clears it.
- Only one focus filter is active at a time.
- The active item has a clear selected state.
- Counts respect the selected ownership scope: My work or Team.

### Visual rules

- Use a single compact strip, not four large dashboard cards.
- Do not use red for every item.
- `Overdue` and `At risk` may use stronger warning treatment.
- Always use text and an icon; do not communicate state through colour alone.
- Hide zero-count warning items or show them quietly as `0`; do not create empty alert cards.

---

## 7. Ownership scope

Use a two-option control:

- `My work` — default.
- `Team`.

Do not retain five equal segmented views.

### My work

Show Journeys where the signed-in user is the responsible Sales owner or assigned Journey owner, according to the existing fixture/adapter semantics.

### Team

Show all Journeys the user is authorized to view.

### Empty state

If My work is empty:

- Title: `No Journeys assigned to you`.
- Explanation: `Switch to Team to view other active Sales Journeys.`
- Action: `View Team Journeys`.

---

## 8. Search and filters

### Always visible

- Search input.
- Filters button.

### Search placeholder

Use:

`Search by Journey, customer, RFQ or owner…`

Searching should not require opening the filter drawer.

### Filter drawer

Retain the existing drawer and existing supported filters:

- Lifecycle stage.
- Stage status.
- Risk.
- Business type.
- Waiting on.
- Owner.
- Commercial value range for authorized roles.

### Improvements

- Group filters under meaningful headings: `Journey`, `Responsibility`, and `Commercial`.
- Disable or omit Owner when `My work` is selected unless changing it has a meaningful defined result.
- Show the active-filter count on the Filters button.
- Show removable chips only after filters are applied.
- `Clear all` must preserve the selected ownership scope but clear focus, search, and advanced filters.
- Applying a focus summary must not silently erase advanced filters.

---

## 9. Result ordering

Default sort: **Urgency**.

Recommended priority:

1. Blocked.
2. Overdue next action.
3. At risk/delayed.
4. Waiting on customer.
5. Due soon.
6. Remaining active Journeys by next-action date.

Provide a small sort control:

- Urgency.
- Due date.
- Recently updated.
- Customer.
- Lifecycle stage.

Do not expose database-oriented sorting such as internal ID.

The adapter may perform the sort client-side while the data is prototype-only. Keep it isolated so it can later move behind a real Journey API.

---

## 10. Journey worklist

### 10.1 One Journey equals one obvious row/card

- The complete row/card should open the Journey.
- Do not add separate `Open`, `Resume`, Account, or stage links inside the same row.
- Keyboard focus must clearly identify the complete row/card action.

### 10.2 Information order

Each Journey should show, in this order:

1. Journey name.
2. Journey reference and customer name.
3. Current lifecycle stage with stage number.
4. Current state or exception.
5. Next action.
6. Due date/relative urgency.
7. Owner.
8. Commercial value only when authorized and when space allows.

### 10.3 Stage presentation

Display:

`Cost & Quote · Stage 4 of 8`

Do not show a complete eight-stage mini-stepper on every row.

Optionally use a very small progress line derived from the stage number, but only if it improves comprehension and does not add another competing status signal.

### 10.4 State presentation

Show one main state label:

- In progress.
- Waiting on customer.
- Waiting internally.
- Blocked.
- Complete.
- Not applicable.

Show a separate risk label only when the Journey is genuinely at risk/delayed. Do not show `On track` on every row.

### 10.5 Next action

The next action is the operational centre of the row.

- Use a clear verb-led sentence.
- Show `No next action assigned` when missing rather than a dash.
- Highlight overdue action dates.
- Do not truncate the next action so aggressively that its meaning is lost.
- Prefer wrapping to two lines over hiding the action in a tooltip.

### 10.6 Owner

- Show a short avatar/initials and owner name when the existing UI system supports it.
- Use `Unassigned` visibly when no owner exists.
- Unassigned should participate in Needs attention.

---

## 11. Desktop presentation

Prefer a structured worklist over a traditional dense table.

Recommended columns:

1. Journey/customer.
2. Lifecycle position and state.
3. Next action.
4. Due.
5. Owner.
6. Value, permission controlled.

Combine `Stage` and `Status` into one lifecycle column. This reduces scanning and explains that the state belongs to the current stage.

Use comfortable row height. The goal is fast comprehension, not maximum rows per screen.

---

## 12. Mobile presentation

Use cards generated from the same view model.

Each mobile card should show:

- Journey name.
- Customer and reference.
- `Stage n of 8` with stage name.
- State/risk.
- Next action.
- Due date.
- Owner.

Mobile rules:

- Keep the focus summary horizontally scrollable only if it cannot fit; do not make the entire page scroll sideways.
- Ownership scope, search, and Filters should remain easy to reach.
- Hide commercial value before hiding next action or due date.
- The whole card remains one clear tap target.

---

## 13. Lifecycle understanding

The page must communicate that a Journey moves through:

`Account → Enquiry/RFQ → Style & Sample → Cost & Quote → PO/Contract → Production → Shipment → Retention`

Do not permanently place a second full eight-stage navigation bar above the worklist; that could recreate the crowding problem.

Instead:

- Show stage number and name in each result.
- Add a small `How Sales Journeys work` information action near the page title or empty state.
- Its popover/sheet may explain the eight stages in plain language.
- The advanced Stage filter may list the stages in their lifecycle order.

---

## 14. Required states

### Loading

- Preserve the page header and controls.
- Skeleton the focus strip and results.
- Do not replace the entire page with a spinner.

### First-use empty

- Explain a Sales Journey in one short sentence.
- Show the eight-stage lifecycle once.
- Offer Start Journey as a preview action.

### Filtered empty

- State which scope/filter produced no results.
- Offer `Clear filters`.
- Do not show the first-use explanation.

### Error

- Explain that Journeys could not load.
- Offer Retry.
- Retain search/scope state.

### Permission restricted

- Remove commercial value fields from the layout for unauthorized users.
- Do not leave an empty Value column.

---

## 15. Accessibility

- Ownership and focus controls must expose selected state.
- Each worklist row/card must have one clear accessible link name including Journey and customer.
- Search must have a visible or screen-reader label.
- Status and risk must include text, not colour alone.
- The filter drawer must preserve Escape, focus trap, initial focus, and focus restoration.
- Focus should return to the Filters button after closing the drawer.
- Focus order must follow the visual order.
- Avoid using tooltips for information necessary to understand the Journey.

---

## 16. Existing architecture to reuse

Reuse:

- `app/sales/dashboard/journeys/page.js`.
- `components/sales/crm/journey/JourneyCard.js`.
- `lib/salesJourney/adapter.js`.
- `lib/salesJourney/stageConfig.js`.
- `lib/salesJourney/commercialAccess.js`.
- Existing `CrmDrawer`, primitives, state badges, theme tokens, navigation, and breadcrumb system.

Do not:

- Introduce a second Journey data adapter.
- Duplicate lifecycle labels or stage order locally.
- Invent a Journey API.
- Change fixtures merely to make the page look populated.
- Modify individual stage workspaces.

If the existing adapter cannot provide a requested count or state honestly, omit the UI or derive it transparently from the already-loaded prototype rows.

---

## 17. Implementation sequence

1. Replace five equal views with `My work / Team` ownership scope.
2. Add the compact Your Focus summary derived from the active scope.
3. Add urgency sorting and the small sort control.
4. Refactor the desktop result into the six-column worklist.
5. Align the mobile card to the same information order.
6. Improve the filter drawer grouping and clear behaviour.
7. Implement loading, empty, error, and permission states.
8. Verify desktop, tablet, mobile, keyboard, and focus behaviour.

Do not continue into the Journey detail/stage pages after completing this sequence.

---

## 18. Acceptance criteria

- The page defaults to My work, not the full Team dataset.
- My work and Team are the only primary scope choices.
- Needs attention, Overdue, Waiting on customer, and At risk are compact focus filters rather than equal navigation tabs.
- The user can identify the Journey, customer, stage, next action, due date, and owner without opening the record.
- The current lifecycle position is shown as stage name plus `Stage n of 8`.
- Stage and current-stage status are visually grouped.
- Results default to urgency ordering.
- The next action is not hidden by premature truncation.
- One row/card is one obvious link target.
- Advanced filters remain in the existing accessible drawer.
- Commercial value remains permission controlled.
- Desktop uses a comfortable six-column worklist; mobile uses cards from the same data.
- The page does not add another permanently visible eight-stage bar.
- No individual Journey stage page is changed.
- No backend, API, dependency, configuration, fixture, migration, seed, or Git setting is changed.
- Unrelated and uncommitted work is preserved.
- No commit is created.

---

## 19. Required verification and handoff

Verify:

- Desktop around 1440px.
- Tablet around 768–1024px.
- Mobile around 375px.
- No page-level horizontal scrolling.
- Keyboard interaction for scope, focus filters, worklist links, sort, and filter drawer.
- Filter focus restoration.
- Loading, empty, error, restricted-commercial, and populated states.
- All lifecycle names come from the central configuration.

Update `docs/handoff/latest-implementation.md` with:

- The Sales Journeys page changes only.
- Files changed.
- Verification performed and results.
- Any remaining limitations.
- Confirmation that individual stage pages and backend code were not changed.

