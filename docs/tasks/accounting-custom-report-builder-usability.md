# Accounting Custom Reports — completion and usability plan

**Status:** proposed implementation plan  
**Date:** 26 September 2026  
**Repositories:** `grav-cms` (primary), `grav-cms-backend` (only for the
explicit persistence contract in Slice 4)  
**Goal:** a first-time Accounting user can select fields, immediately see real
data, optionally summarise it, place a chart on the same worksheet, save it,
reopen it exactly, and download it without learning BI vocabulary.

This plan replaces incremental copy changes with one coherent interaction
model. It does not restore any Metabase interface. Metabase may remain behind
the reporting API; the browser renders GRAV's worksheet and charts.

## 1. Audit findings from the current code

### 1.1 The visible drag promise is false

- `ReportDesigner` renders `DataPanel`.
- `DataPanel` deliberately has no `draggable`, drag handle, `dataTransfer`, or
  drag callbacks.
- `DataPointPanel` implements field dragging but is dead code: no production
  component imports it. Only tests read it.
- `ReportDesigner.startFieldDrag` exists but has no production caller.
- The More Options drawer says “Drag a field between them”, although only
  chips already present in the shelves can be dragged.
- The worksheet's five drop regions therefore cannot be reached from the
  visible field catalogue. They appear only while an existing shelf chip is
  being dragged.

This is why source tests pass while the browser does not perform the advertised
gesture. Tests currently prove that drag-related strings exist in files, not
that the rendered component tree connects drag source to drop target.

### 1.2 Two interaction models coexist

The current source contains both:

- the older pivot-first model (`DataPointPanel`, five permanent shelves,
  type-based default placement); and
- the newer list-first model (`DataPanel`, `mode.js`, `ConfigBar`), where a
  click means “show this as a column”.

The production tree uses the second, but comments, tests, first-use guidance,
drag copy, and parts of the advanced drawer still describe the first. This
creates conflicting expectations and makes regressions easy.

### 1.3 The list-first model is the right default but is not yet proven live

`mode.js` now maps every clicked field to `rows` while the report is a detail
list. That should make Month followed by Voucher Date appear as two columns.
The screenshot showing both under `BY` is therefore either an older hot-loaded
bundle or evidence that browser verification did not exercise the current
tree. The plan requires a clean-server, real-session acceptance run before the
behavior is called fixed.

### 1.4 Saved Reports is visibly present but functionally incomplete

`SavedReports` renders Open, Download, Duplicate, and Delete. In
`ReportDesigner` today:

- Open only switches the view back to Design; it does not call `getReport` or
  load the selected layout.
- Download ignores the selected report and exports the currently open layout.
- Duplicate only switches views and creates no copy.
- Delete calls the API but does not handle failure or remove/refetch the row.
- Save always calls `createReport`; it never calls `updateReport`.
- `savedReportId` is assigned but never read, and any edit discards it.
- New report returns to the current designer state rather than explicitly
  creating a clean draft.

These are product bugs, not polish items.

### 1.5 Worksheet objects are not persisted

The frontend has safe `serialiseWorksheet` / `deserialiseWorksheet` functions,
but the save contract does not accept a worksheet. Only the first chart's type
and title are saved; chart positions, sizes, additional charts, and settings
are lost. The UI admits this after Save. A “fully done” builder must persist
the whole safe worksheet or must not present those controls as durable.

### 1.6 Tests overstate UI assurance

The focused reporting suite is 293/293 green. Many component tests inspect
source text with regular expressions. They are useful architecture guards but
cannot prove clicks, drag/drop, state transitions, focus, API payloads, or
saved-report behavior. Some explicitly inspect dead `DataPointPanel` code.

## 2. Product interaction contract

There will be one beginner path and one advanced path.

### Beginner path: click to build a list

1. A blank worksheet says: “Choose fields from the left. Their data will
   appear here as columns.”
2. Clicking either the field name or its `+` adds that field as the next
   visible column.
3. The sheet immediately shows a loading state and then real rows.
4. Dates stay ordinary visible columns. Amounts stay ordinary visible columns.
5. Column headers provide rename, sort, filter, remove, and drag-to-reorder.
6. `Summarize` is an explicit action. Nothing silently changes a list into a
   pivot except chart creation, and that conversion requires a clear preview
   and Undo.

### Advanced path: arrange a summary

After `Summarize`, the compact configuration reads:

```
Group by: Ledger Group    Calculate: Total Debit    Break down by: Month
```

More Options exposes the full five destinations. Click/menu controls remain
the accessible primary route; drag is a shortcut that really works.

### Drag contract

- In List mode, drag from the handle on a field to the worksheet header. A
  vertical insertion marker shows the exact new column position.
- In Summary mode, starting a field drag opens one compact destination dock:
  Group by, Calculate, Break down by, Filter, Compare. Invalid destinations
  are disabled with a plain reason.
- Existing column headings drag to reorder visible columns.
- Existing summary chips drag between valid destinations and reorder within a
  destination.
- Dropping on blank worksheet body in List mode appends a column.
- Escape cancels. A refused drop changes nothing and explains why.
- Touch does not depend on drag; tap and menus provide every operation.
- No copy says “drag” unless the rendered element is a live drag source and a
  reachable drop target is currently available.

### Chart contract

- `Add chart` uses the current visible columns.
- If the shape is sufficient, it creates the recommended native GRAV chart in
  one click on the same worksheet.
- If one figure is missing, it asks one small question and creates the chart
  on confirmation.
- Chart creation must not silently destroy the user's List configuration. A
  chart may own a derived summary specification separately from the displayed
  table, or the UI must preview and make the conversion explicitly undoable.
- No iframe or Metabase UI is allowed.

## 3. Sequential implementation slices

### Slice 0 — Make tests describe the production tree

Files: frontend reporting tests and component inventory only.

1. Delete `DataPointPanel` if it has no production consumer, or replace
   `DataPanel` with it deliberately. Do not keep both.
2. Remove source tests that count dead drag code as product coverage.
3. Add a production-component reachability manifest beginning at
   `app/accountant/custom-reports/page.js`.
4. Add a real component test environment (React DOM + user events) or a
   browser E2E harness for this route. Source-pattern tests remain only for
   boundary rules such as “no iframe” and “no engine credential”.

**Pass:** removing the active DataPanel drag wiring makes a drag test fail;
changing an Open handler to a no-op makes a Saved Reports test fail.

### Slice 1 — One truthful field interaction

Files: `DataPanel`, `ConfigBar`, `FirstUseGuide`, `mode.js`, designer wiring.

1. Make the entire unselected field row and its `+` perform the same documented
   action: append a visible List column.
2. Keep the selected state visible and make clicking a selected field open its
   column settings.
3. Remove all type-based automatic placement from the beginner path.
4. Remove stale Rows/Values/Across-the-top instructions from the first-use
   guide.
5. Show loading, ready-empty, error, and real-zero states distinctly in the
   worksheet.
6. Abort obsolete preview requests rather than only ignoring late responses.

**Pass:** on a clean dev server with a real Accounting session, Month then
Voucher Date yields two populated columns in that order. No `BY`, `Values`, or
blank unexplained grid appears.

### Slice 2 — Complete drag/drop, end to end

Files: `DataPanel`, `ReportDesigner`, `ReportSheet`, advanced destination dock,
drag model, interaction tests.

1. Add a visible, keyboard-described drag handle to active DataPanel rows on
   fine-pointer devices. Keep click primary.
2. Wire the active row to `startFieldDrag`; remove the dead function problem.
3. Replace the five-region full-sheet overlay in List mode with one column
   insertion overlay aligned to actual header geometry.
4. In Summary mode, show a compact destination dock during field drag and wire
   every valid target to `handleDrop`.
5. Keep shelf-chip movement and heading reordering, but use the same drag
   payload and validation model everywhere.
6. Close or reposition overlays so a drawer never physically blocks its drop
   target.
7. Add pointer/mouse browser tests that perform the actual gesture, verify the
   insertion marker, release, and inspect both UI and preview payload.

**Pass:** dragging Voucher Date between columns A and B produces that exact
order; dragging Debit to Calculate in Summary creates the correct value;
invalid drops leave the layout byte-identical; touch users can do all three by
tap/menu.

### Slice 3 — Simplify summary, filters, comparison, and chart transitions

1. Keep List as the permanent default.
2. Make Summarize show a preview of the proposed grouping/calculations before
   applying when inference is not unambiguous.
3. Make Back to list restore the exact pre-summary List column order, not a
   reconstructed approximation.
4. Make Filters open the filter catalogue directly, not merely the generic
   five-shelf drawer.
5. Make Add chart operate on a chart-owned derived layout so adding a chart
   does not unexpectedly convert the visible table.
6. Reduce guidance to one actionable message tied to the relevant control.

**Pass:** List → Summary → List is lossless; Add chart leaves the table shape
unchanged; every visible action has a successful keyboard and touch path.

### Slice 4 — Finish Saved Reports and worksheet persistence

Frontend first fixes the existing REST use; backend adds one narrow validated
field.

Frontend:

1. Open calls `getReport(id)`, validates/presents the returned layout, resets
   history around it, loads worksheet state, and runs its preview.
2. Save creates only for a new draft; subsequent saves call `updateReport`.
   Editing must not discard report identity.
3. Duplicate fetches the selected report, removes its identity, chooses a
   non-conflicting copy name, and creates it.
4. Download exports the selected saved report, not the currently open draft.
5. Delete handles success/failure and updates the list without stale rows.
6. New report creates a clean draft after an unsaved-changes confirmation.
7. Empty saved list says “No saved reports yet”, not “being connected”.

Backend:

1. Add a `worksheet` field to the saved-report schema and create/update/open
   presenters.
2. Rebuild it through a strict allowlist: table start cell; chart object id,
   type, row, column, spans, title, and approved visualization settings.
3. Enforce object count, string lengths, integer bounds, and total serialized
   size. Refuse unknown keys.
4. Never accept tokens, URLs, engine/card ids, SQL, or MBQL.
5. Keep v1/v2 saved reports readable with `worksheet: null` migrated to an
   empty worksheet presentation.

**Pass:** create → arrange two charts → save → leave → reopen reproduces the
same fields, filters, calculations, chart types, titles, positions and sizes;
Save again updates one row rather than creating a duplicate.

### Slice 5 — Reliability and recovery

1. Abort catalogue, preview, open, download, and save requests when superseded
   or unmounted.
2. Disable only the action currently running; prevent double Save and double
   chart creation.
3. Preserve the last good matrix during refresh with an explicit stale/error
   indicator.
4. Provide Retry for preview failure without clearing the layout.
5. Confirm before company switch, New, Open, or navigation when unsaved work
   exists.
6. Keep history coherent across list fields, summary changes, filters,
   comparisons, charts, chart movement, and deletion. Define whether worksheet
   actions participate in the same Undo stack; do not keep two contradictory
   Undo systems.
7. Resolve the known heavy two-dimension count failure with a backend timeout,
   cardinality, and query-plan investigation; return a bounded, actionable
   refusal rather than `ERR_EMPTY_RESPONSE`.

**Pass:** rapid field changes never show stale results; failed requests never
erase readable data; double clicks create one mutation; leaving with unsaved
work always asks once.

### Slice 6 — Real acceptance suite and cleanup

Run against the real local frontend, backend, mart, and Accounting session.

Required journeys:

1. Blank → Month → Voucher Date: data appears immediately.
2. Add, reorder by drag, reorder by keyboard, remove, Undo, Redo.
3. Ledger Name + Debit + Credit detail list.
4. Summarize by Ledger Group; total Debit; break down by Month.
5. Filter a date and a voucher type.
6. Previous-period comparison.
7. Create, move, resize, retitle, duplicate, and delete a chart.
8. Save, reopen exactly, update, duplicate, download, delete.
9. Switch company with an unsaved report.
10. Simulate preview timeout/network loss and recover.
11. Normal, immersive, focus, tablet, and phone flows.

Collect screenshots and request logs. Verify no engine UI, credential, internal
identifier, or cross-company result reaches the browser.

**Pass:** every control visible in the UI is exercised successfully in a real
browser. No completion claim may rely solely on a source-regex test.

## 4. Definition of done

- A first-time user gets real data after one field click.
- Click behavior is consistent for every field type.
- Every displayed drag instruction corresponds to a working drag source and
  reachable drop target.
- Drag is optional; keyboard and touch paths are complete.
- The visible table never changes mode without explicit action and clear Undo.
- Charts coexist with the table and do not expose Metabase UI.
- Saved Reports Open/Update/Duplicate/Download/Delete are real and tested.
- Worksheet charts and positions survive reopening.
- Network failures and heavy reports fail clearly without losing work.
- Tests include real component/browser interactions and fail when production
  wiring is removed.
- Unused legacy components and contradictory documentation are deleted.

## 5. Recommended execution order

Do not split frontend work by visual component. Complete vertical behavior in
this order:

1. **Lane A:** Slices 0–2 — truthful tests, click behavior, complete drag/drop.
2. **Lane A:** Slice 3 — lossless List/Summary/chart interaction.
3. **Lane B:** Slice 4 backend worksheet contract and Slice 5 heavy-query
   reliability.
4. **Lane A:** Slice 4 frontend saved-report lifecycle.
5. **Both lanes:** Slice 6 live acceptance, with Lane A owning the browser run
   and Lane B owning request/query evidence.

Each slice stops for review. Do not stack another visual redesign on top of a
behavior that has not passed its browser gate.
