# Sales Journey UI Simplification Brief

> **Status:** Proposed UI refinement
>
> **Repository:** `/Users/risheeray/grav-cms`
>
> **Scope:** Frontend information architecture, navigation, visual hierarchy, responsive behaviour, and usability only
>
> **Lifecycle:** `ACCOUNT → ENQUIRY/RFQ → STYLE & SAMPLE → COST & QUOTE → PO/CONTRACT → PRODUCTION → SHIPMENT → RETENTION`
>
> **Instruction:** Simplify the existing Sales Journey UI. Do not implement backend functionality, invent APIs, change dependencies, or begin another CRM phase.

---

## 1. Why this refinement is required

The first Journey prototype proves that the full lifecycle can fit inside one connected workspace. It also exposes too much information and too many controls at the same time.

The current stage workspace may show all of the following simultaneously:

- The application sidebar.
- Breadcrumbs.
- A large Journey header.
- Journey identity, customer, owner, merchandiser, current stage, target date, value, next action, status, business type, and risk.
- View Account, Stage Checklist, Timeline, Add Note, Create Task, Link Document, and Update Blocker actions.
- A prototype-data banner.
- A risk banner.
- Left and right rail buttons on smaller screens.
- A left contextual-record rail.
- A main stage workspace with its own panels, tabs, tables, badges, and actions.
- A right activity rail with overdue tasks, upcoming tasks, customer waits, approvals, activity, and documents.
- An eight-stage lifecycle bar fixed near the bottom.

This makes every item compete for attention. The user cannot quickly answer:

1. Which customer and Journey am I working on?
2. Where is this Journey now?
3. What needs my attention?
4. What is the next action?
5. Where should I click?

The revised design must make those answers obvious within five seconds.

---

## 2. Product intent that must remain unchanged

The redesign must preserve these core concepts:

- An Account is a durable customer/party record.
- A Sales Journey is one connected commercial lifecycle.
- Styles, samples, quotations, orders, production records, shipments, claims, and repeat opportunities remain distinct records referenced by the Journey.
- The eight approved lifecycle stages and their order remain unchanged.
- The route must continue to identify the Journey and active stage.
- Account and Journey must remain separate.
- Production must remain a customer-facing milestone view, not become ERP/MES execution.
- Prototype stages must remain visibly identified as preview data.
- Unsupported actions must not imply that data was saved.
- Existing architecture, theme tokens, CRM primitives, authentication, and permission patterns must be reused.

This is a simplification of the presentation, not a simplification of the business model.

---

## 3. Existing frontend architecture to reuse

Reuse the current route and central configuration:

- `/sales/dashboard/journeys`
- `/sales/dashboard/journeys/[journeyId]/[stage]`
- `lib/salesJourney/stageConfig.js`
- `lib/salesJourney/capabilities.js`
- `lib/salesJourney/adapter.js`
- `components/Sales_DashboardLayout.js`
- Existing CRM primitives and theme tokens.
- Existing live Account components where the Account stage uses real data.

The current three-column stage shell may be refactored, but the individual stage view models and route structure should not be discarded merely to achieve a visual change.

---

## 4. Design direction

### 4.1 Guiding principle

The Journey should feel like a guided workspace, not a command centre.

Show the user the smallest amount of information required to understand the present stage and take the next action. Keep supporting information available through tabs, drawers, expansion, or a secondary detail view.

### 4.2 Progressive disclosure

Use three information levels:

1. **Always visible:** Journey identity, current stage, state/risk, next action.
2. **Visible for the current task:** The selected record and the stage's primary work.
3. **Available on demand:** Activity, documents, checklist, history, secondary metadata, and advanced details.

Do not render all three levels as persistent columns.

### 4.3 Action hierarchy

Each screen must have:

- A maximum of one primary action.
- A maximum of two visible secondary actions.
- All remaining actions inside a `More` menu or contextual drawer.
- Clear disabled/preview treatment for unsupported actions.

The primary action must represent the most likely next step for the current stage, such as `Send to Style & Sample` or `Prepare Shipment`.

### 4.4 Visual hierarchy

Above the fold, show no more than:

- One compact context header.
- One lifecycle/navigation control.
- One alert or attention block.
- One main work panel.

Avoid rows of unrelated chips, multiple simultaneous banners, deeply nested cards, and large blocks of explanatory copy during normal use.

---

## 5. Revised global navigation

Keep the Sales sidebar simple and distinguish active work from reference libraries.

### Primary Sales navigation

1. **Overview**
2. **Sales Journeys**
3. **Approvals**

### Customer libraries

4. **Accounts**
5. **Contacts**

### Existing operational modules

Keep existing legacy or operational modules in a clearly separated group. Do not mix them into the lifecycle stage list and do not rename them as if they are Journey stages.

### Navigation rules

- Rename `Journey Hub` in the sidebar to `Sales Journeys`; use `Journey Hub` only as an optional page subtitle.
- Do not create eight sidebar entries for the eight stages.
- Do not duplicate Accounts or Contacts under multiple menu groups.
- The active sidebar item must remain `Sales Journeys` throughout all Journey stages.
- Breadcrumbs should be short: `Sales Journeys / SJ-… / Current Stage`.
- Never show a raw database ID in a breadcrumb.

---

## 6. Simplified Journey Hub

### 6.1 Purpose

The Hub should answer:

- Which Journeys need attention?
- Which stage is each Journey in?
- What is the next action and due date?
- Who owns it?

It should not try to display every commercial fact about every Journey.

### 6.2 Header

Use one compact page header:

- Title: `Sales Journeys`
- Short subtitle: `Track customer requirements from enquiry to retention.`
- Primary action: `Start Journey` when supported, otherwise visibly marked preview.
- Refresh may be an icon action or part of `More`; it should not compete with Start Journey.

### 6.3 Views

Provide a small view switcher:

- My Journeys
- Team Journeys
- Needs Attention
- Waiting on Customer
- At Risk

Do not show a paragraph explaining the selected view after every selection. Use a tooltip or concise empty-state explanation where necessary.

### 6.4 Search and filters

Always show:

- One search field.
- One `Filters` button.
- Active filter chips only after filters are applied.

Move these into the filter drawer/popover:

- Stage.
- Stage status.
- Risk.
- Business type.
- Waiting on.
- Owner.
- Value range, only for authorized roles.

Do not display an eight-field filter grid by default.

### 6.5 Default result layout

Use one default presentation rather than asking users to choose between equally prominent card and table modes.

Recommended:

- Desktop/tablet: compact list or table.
- Mobile: stacked cards generated from the same data.

Desktop columns:

1. Journey and customer.
2. Current stage.
3. Status/risk.
4. Next action.
5. Due date.
6. Owner.
7. Commercial value only when authorized.

Hide secondary facts such as buying-house details, multiple tags, internal metadata, and full lifecycle state until the Journey is opened.

### 6.6 Journey row/card

Each result should have one obvious click target. It should show:

- Journey reference and name.
- Customer name.
- Current stage.
- One state badge.
- Risk only when risk exists.
- Next action and due date.
- Owner.

Do not show every stage as a miniature lifecycle inside every card.

---

## 7. Simplified Journey workspace

### 7.1 Remove the persistent three-column layout

Do not keep contextual records, stage work, and activity permanently visible as three competing columns.

Use:

- One main content column.
- A compact record selector only when the stage contains multiple records.
- An `Activity` drawer for timeline, tasks, approvals, and notes.
- A `Documents` drawer or stage tab when documents are central to the stage.
- A `More` menu for checklist, history, and lower-frequency actions.

Target main-content width: approximately 960–1200px depending on the table required by the stage.

### 7.2 Compact Journey header

The header must occupy no more than two compact rows on desktop and one condensed block on mobile.

#### First row

- Back to Sales Journeys.
- Journey reference.
- Journey name.
- Customer name.
- Current state badge.
- Risk badge only when risk is not normal.

#### Second row

- Owner.
- Important target date.
- Next action.
- One primary action.
- Up to two secondary actions: normally `Activity` and `More`.

Move these out of the always-visible header:

- Business type unless needed to understand the current workflow.
- Full commercial-party string.
- Merchandiser label when the owner is sufficient.
- Multiple preview actions.
- Separate buttons for note, task, document, blocker, timeline, and checklist.

Those actions should live in `Activity` or `More`.

### 7.3 Lifecycle navigation

Place the lifecycle immediately below the compact header, not as a floating panel that competes with the page at the bottom.

Desktop:

- Use a slim horizontal stepper.
- Show the current stage strongly.
- Show completed, waiting, blocked, and not-applicable states with small icons.
- Do not use uppercase for every stage label.
- Do not repeat `Preview` on every stage.

Mobile:

- Show `Stage 4 of 8 · Cost & Quote` as the main control.
- Provide previous/next stage controls.
- Open the full lifecycle in a sheet when the stage label is selected.

### 7.4 Alerts and banners

Combine prototype, risk, blocked, and waiting information into one slim status strip.

Priority:

1. Blocked.
2. At risk.
3. Waiting.
4. Prototype notice.

Show only the highest-priority message by default, with `View details` when more information exists.

### 7.5 Main stage page structure

Every stage should use the same three-part rhythm:

1. **Attention:** one concise block shown only when something needs action.
2. **Current work:** the primary object or workflow for this stage.
3. **Details:** secondary information behind tabs or collapsible sections.

Do not display empty panels simply to prove that future information categories exist.

---

## 8. Stage-by-stage UI requirements

## 8.1 Account

### User question

Is the customer foundation complete enough to begin an Enquiry/RFQ?

### Default view

Show:

- Account identity: code, name, account type, and active status.
- Primary contact.
- Billing and delivery location summary.
- Internal owner.
- Account readiness summary.
- Missing required information, if any.

### Tabs

- Overview.
- Contacts.
- Locations.
- Relationships.
- Garment profile.

### Actions

- Primary: `Start Enquiry/RFQ` when ready.
- Secondary: `Edit Account` when authorized.
- Secondary: `Activity`.
- More: add contact, add location, manage relationship, checklist, history.

### Simplification rules

- Do not reproduce the complete Account detail workspace inside the Journey.
- Show a concise Account summary and link to the full Account record.
- Show only missing readiness items, not a long checklist of completed facts.

---

## 8.2 Enquiry/RFQ

### User question

What is the customer asking for, and is it qualified enough to develop?

### Default view

Show one enquiry summary containing:

- RFQ/enquiry reference.
- Requirement type.
- Customer deadline.
- Expected quantity range.
- Product/category summary.
- Decision-makers and approving party.
- Qualification state.
- Next action.

### When multiple enquiries exist

Use a compact selector above the content:

`Enquiry/RFQ: [RFQ-2026-004 ▾]`

Do not keep an entire left rail visible merely to select one enquiry.

### Tabs

- Brief.
- Requirements.
- Parties & Contacts.
- Qualification.
- Documents.

### Attention block

Show only unresolved qualification problems, missing deadlines, unclear quantities, or missing approvers.

### Actions

- Primary: `Send to Style & Sample`.
- Secondary: `Edit Enquiry` when supported.
- Secondary: `Activity`.

---

## 8.3 Style & Sample

### User question

Which style/sample version is current, and what is required to obtain approval?

### Default view

Show:

- Selected style and style reference.
- Current sample type and version.
- Sample status.
- Customer feedback status.
- Next submission/approval date.
- One visual thumbnail or placeholder when useful.
- Outstanding issues.

### Record selection

Use a style dropdown or compact horizontal selector. Show counts such as `3 styles` without rendering a permanent rail.

### Tabs

- Style brief.
- Samples.
- Technical details.
- Feedback.
- Documents.

### Version handling

- Display only the active version in the default view.
- Put prior versions in `Version history`.
- Never mix old feedback into the active version without a clear version label.

### Actions

- Primary: `Submit for Approval` or `Send to Cost & Quote`, depending on state.
- Secondary: `Add Sample Version` when supported.
- Secondary: `Activity`.

---

## 8.4 Cost & Quote

### User question

What price are we proposing, is it commercially approved, and what must happen before the customer can accept it?

### Default view

Show:

- Active quotation number and version.
- Quotation status.
- Currency.
- Total quoted value.
- Validity date.
- Delivery assumption.
- Approval state.
- A compact line-item table.

### Commercial information

Margin, supplier cost, commission, and approval thresholds must be hidden unless the user has the correct explicit commercial/finance capability. A generic editor role is not sufficient.

### Tabs

- Quote.
- Costing, permission controlled.
- Negotiation.
- Approval.
- Terms.

### Uniform price lists

Render the uniform contract price list as an alternate quote content type inside the Quote tab. Do not place it below the normal quote as another large simultaneous table.

### Actions

- Primary: `Send Quote` or `Convert to PO/Contract`, according to state.
- Secondary: `New Version` when supported.
- Secondary: `Activity`.
- More: approval history, comparison, documents.

---

## 8.5 PO/Contract

### User question

Does the customer PO/contract match the accepted quotation, and is the order ready for production release?

### Default view

Show:

- Customer PO number.
- Separate internal Order reference.
- Order state.
- Customer and consignee.
- Quantity and delivery window.
- PO-versus-quote match status.
- Release readiness.

### Attention block

If mismatches exist, make them the first content after the header. Show the mismatch count and the fields requiring resolution. Do not bury mismatches among general PO metadata.

### Tabs

- PO summary.
- Differences.
- Quantity breakdown.
- Time & action calendar.
- Amendments.

### Actions

- Primary: `Release to Production` when ready.
- Secondary: `Resolve Differences` when mismatches exist.
- Secondary: `Activity`.

### Architecture language

Clearly state that the Order is referenced by the Journey and is not the Journey itself. Keep this as concise supporting text, not a repeated explanatory paragraph on every visit.

---

## 8.6 Production

### User question

Is production on track for the committed shipment date, and what exception needs Sales attention?

### Default view

Show:

- Overall progress.
- Current production milestone.
- Planned versus forecast completion.
- Shipment target.
- The next three milestones.
- Active exceptions or customer-impacting risks.

### Main visualization

Use one milestone timeline or progress list. Do not display every factory operation as a separate dashboard panel.

### Tabs

- Overview.
- Milestones.
- Quality.
- Exceptions.

Materials, cut, decorate, sew, finish, inspect, and pack may be milestones within the Milestones tab. They should not all compete as top-level controls unless real process data later proves that users need them daily.

### Actions

- Primary: `Prepare Shipment` when ready.
- Secondary: `Update Customer` when supported.
- Secondary: `Activity`.

### Boundary

Do not add shop-floor execution, operator assignment, machine status, or detailed WIP transactions to this Sales Journey UI.

---

## 8.7 Shipment

### User question

Where are the goods, what remains before delivery, and is the commercial close complete?

### Default view

Show:

- Shipment reference.
- Dispatch/delivery status.
- Mode and carrier.
- Quantity shipped versus ordered.
- Planned and actual dispatch.
- Expected delivery.
- Tracking reference.
- Critical missing documents.

### Multiple shipments

Use a compact shipment selector. Clearly summarize partial shipment progress, for example `2 of 3 shipments dispatched · 8,400 of 12,000 pcs`.

### Tabs

- Tracking.
- Shipment details.
- Documents.
- Delivery.
- Commercial close, permission controlled.

### Actions

- Primary: `Confirm Delivery` or `Move to Retention`, depending on state.
- Secondary: `View Tracking` when available.
- Secondary: `Activity`.

### Naming

Use `Shipment`, not `Delivery/Shipment`. The next stage is `Retention`, not `Grow Account` or `Aftercare`.

---

## 8.8 Retention

### User question

What did we learn, what issue remains, and what is the next repeat-business opportunity?

### Default view

Show:

- Journey outcome summary.
- On-time delivery result.
- Claims/open issue count.
- Customer satisfaction or relationship signal when available.
- Repeat-order likelihood.
- Next relationship action and owner.

### Tabs

- Performance.
- Claims.
- Repeat Business.
- Relationship Plan.
- Uniform Service, only for applicable uniform accounts.

### Commercial information

Quoted value, actual value, estimated margin, actual margin, and payment behaviour must remain permission controlled.

### Actions

- Primary: `Create Repeat Journey` when appropriate.
- Secondary: `Log Claim` when supported.
- Secondary: `Activity`.

### Simplification rules

- Do not show claims, repeat opportunities, service statistics, performance metrics, and relationship tasks as simultaneous panels.
- Start with the outcome and the next relationship action.
- Use tabs for the different retention workstreams.

---

## 9. Activity, checklist, documents, and history

These supporting tools should no longer occupy a permanent right rail.

### Activity drawer

One `Activity` drawer should contain:

- Timeline.
- Notes and communications.
- Tasks.
- Waiting-on-customer items.
- Pending approvals.

The Timeline action must open the timeline, not the Stage Checklist.

### Checklist

The stage checklist should open from `More → Stage checklist` or from an attention block when incomplete items are blocking progress.

### Documents

Documents may be:

- A stage tab when documents are central to the stage.
- A section inside Activity/More for stages where they are secondary.

Do not show the same documents simultaneously in a right rail and main panel.

### History

Version history and audit history should be opened on demand. The default screen should show the current approved/active version only.

---

## 10. Responsive behaviour

### Desktop

- One main column.
- Optional compact selector above the work area.
- Drawers for supporting information.
- Tables may use the available width but should avoid unnecessary columns.

### Tablet

- Same information order as desktop.
- Actions collapse into `More` earlier.
- Filters, activity, and lifecycle details open as sheets.

### Mobile

- Compact sticky Journey header.
- Current stage control directly below the header.
- One primary action visible.
- Cards replace wide tables.
- Secondary metadata collapses.
- Activity and details use full-height sheets.
- No horizontal page scrolling.

All drawers and sheets must:

- Close on Escape.
- Trap focus while open.
- Move focus to a sensible initial control.
- Restore focus to the opening control when closed.
- Provide an accessible name and visible close control.

---

## 11. Required visual states

Every stage must support the following without adding permanent clutter:

- Loading.
- Empty/first use.
- Populated.
- Error with retry.
- Read-only.
- Permission restricted.
- Waiting on customer.
- Waiting internally.
- Blocked.
- At risk.
- Complete.
- Not applicable.
- Prototype data.

Use a shared state component and concise message. Do not create a separate banner for each simultaneous state.

---

## 12. Known defects to correct during simplification

1. Timeline currently opens the Stage Checklist; connect it to the activity timeline.
2. Commercial visibility is currently based on a generic editor threshold; use an explicit commercial/finance capability and fail closed.
3. Mobile rail dialogs lack complete Escape, focus-trap, initial-focus, and focus-restoration behaviour.
4. The Journey header is described as sticky on mobile but is not currently implemented as sticky.
5. Replace `Prepare Delivery/Shipment` with `Prepare Shipment`.
6. Replace `Close and Grow Account` with `Move to Retention`.
7. Prevent raw Account database IDs from flashing in breadcrumbs while business labels load.
8. Account resolution must not silently stop at the first 200 Accounts; use an existing exact lookup or safe pagination without inventing an endpoint.

---

## 13. Implementation sequence

### Phase 1 — Simplify the shared shell

1. Refactor the Journey header into the compact two-row hierarchy.
2. Move lifecycle navigation beneath the header.
3. Replace the persistent right activity rail with an Activity drawer.
4. Replace the persistent left context rail with a compact record selector.
5. Combine prototype/risk/waiting/blocked notices into one status strip.
6. Consolidate actions into one primary action, two secondary actions, and More.

### Phase 2 — Simplify the Journey Hub

1. Reduce header copy and controls.
2. Move advanced filters into a drawer/popover.
3. Choose list/table for desktop and cards for mobile.
4. Reduce each result to the facts required to choose the next Journey.

### Phase 3 — Apply the stage rhythm

For each stage, implement:

1. Attention block when needed.
2. One primary current-work area.
3. Tabs/collapsible sections for details.
4. Stage-appropriate primary action.

Complete stages sequentially in the approved lifecycle order. Do not redesign several stages through unrelated one-off patterns.

### Phase 4 — Responsive and accessibility verification

1. Verify desktop, tablet, and mobile widths.
2. Verify keyboard navigation and focus behaviour.
3. Verify state and risk are not communicated by colour alone.
4. Verify permission-hidden information is not presented to unauthorized roles.
5. Verify one primary action is visually dominant on every screen.

---

## 14. Acceptance criteria

- A first-time user can identify the customer, Journey, current stage, risk/state, and next action within five seconds.
- The stage workspace no longer uses a persistent three-column layout.
- No stage shows more than one primary action and two visible secondary actions.
- Supporting activity, tasks, approvals, documents, checklist, and history use progressive disclosure.
- The Hub no longer shows the full advanced-filter grid by default.
- The lifecycle remains visible and understandable without obstructing the bottom of the workspace.
- The active stage remains part of the URL and supports direct navigation.
- All eight approved stage names are sourced from the central stage configuration.
- Shipment and Retention terminology is used consistently.
- Account, Journey, quotation, order, production, and shipment records remain architecturally distinct.
- Commercial fields use explicit permission-aware presentation.
- Breadcrumbs never show raw database IDs.
- Desktop, tablet, and mobile layouts are usable without horizontal page scrolling.
- Drawers and sheets meet keyboard and focus requirements.
- Prototype data and unsupported actions remain honest and clearly labelled.
- No backend endpoint, data model, dependency, or configuration is changed for this task.
- Unrelated uncommitted work is preserved.

---

## 15. Out of scope

- Backend Journey models or APIs.
- Database migrations or seeds.
- Real persistence for prototype actions.
- Step 02 or later CRM backend functionality.
- Manufacturing execution or detailed shop-floor control.
- New authentication or role systems.
- Dependency upgrades.
- Large changes to unrelated application modules.

---

## 16. Required handoff

After implementation, update `docs/handoff/latest-implementation.md` with:

- Screens simplified.
- Shared components refactored.
- Navigation and terminology changes.
- Permission behaviour used.
- Responsive widths checked.
- Keyboard/focus checks completed.
- Verification commands and results.
- Remaining prototype limitations.
- Files changed.
- Confirmation that backend code, dependencies, configuration, migrations, seeds, and commits were not changed.

