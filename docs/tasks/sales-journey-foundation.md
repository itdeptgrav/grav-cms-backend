# Sales Journey Foundation — Real Records and Start Journey Flow

> **Status:** Proposed implementation task
>
> **Backend:** `/Users/risheeray/grav-cms-backend`
>
> **Frontend:** `/Users/risheeray/grav-cms`
>
> **Purpose:** Make `Start Journey` create a real Sales Journey that appears on `/sales/dashboard/journeys`
>
> **Strict boundary:** Build the Journey record and creation flow only. Do not implement Enquiry/RFQ, Style & Sample, Cost & Quote, PO/Contract, Production, Shipment, or Retention business modules.

---

## 1. Problem

The Sales Journeys page currently looks operational but is backed by centralized frontend fixtures:

- `lib/salesJourney/fixtures/journeys.js`
- `lib/salesJourney/fixtures/stageData.js`

`Start Journey` is a disabled preview action. A salesperson cannot create a Journey, and no Sales Journey database model or API exists.

The next implementation must establish the smallest real Journey foundation that lets a user:

1. Select an existing Account.
2. Create a Sales Journey for one real customer requirement.
3. Assign basic ownership and timing.
4. Create an initial next-action task using the existing CRM Activity model.
5. See the new Journey immediately in the Sales Journeys page.
6. Open it at the Account stage.

---

## 2. Durable architecture rules

- **Account, Sales Journey, and Order remain distinct records.**
- A Sales Journey references one primary Account; it does not copy the Account into another customer master.
- Contacts remain `CRMContact` records.
- Tasks, calls, notes, meetings, and follow-ups remain `CRMActivity` records.
- The Journey may reference an Activity as its current next action; it must not create a duplicate embedded task system.
- Buying house, brand, PO issuer, bill-to party, consignee, importer, agent, and other organizations remain separate Account references.
- A Journey may exist without an Order.
- No later-stage record is created merely because a Journey is created.
- Lifecycle stage names, order, and state vocabulary remain centralized and consistent across backend and frontend.

---

## 3. Existing architecture to reuse

### Backend

- `models/CMS_Models/Sales/Account.js`
- `models/CMS_Models/Sales/Contact.js`
- `models/CMS_Models/Sales/Activity.js`
- `models/CMS_Models/Sales/AccountTeam.js`
- Existing Sales authentication middleware.
- Existing `salesWrites(...)` approval-aware write guard.
- Existing `recordChange(...)` audit service.
- Existing CRM visibility/permission services.
- Existing `/api/cms/crm/*` response conventions.

### Frontend

- `lib/crmApi.js`
- `lib/salesJourney/adapter.js`
- `lib/salesJourney/stageConfig.js`
- `lib/salesJourney/commercialAccess.js`
- Existing Account search/picker patterns.
- Existing `CrmDrawer`, form primitives, notifications, held-write handling, and accessible focus behaviour.
- The approved Progress Spine Sales Journeys page.

Do not create a second API client, Account picker, permission system, lifecycle configuration, task model, or audit system.

---

## 4. Backend Journey model

Create a dedicated Mongoose model such as:

`models/CMS_Models/Sales/SalesJourney.js`

The implementing agent must follow existing naming and schema conventions discovered in the repository.

### 4.1 Identity

- Mongo `_id` remains internal.
- `journeyId`: immutable, unique, human-readable reference such as `SJ-2026-0001`.
- `name`: required, editable Journey title.
- `accountId`: required reference to `CRMAccount`.
- `businessType`: required stable code.

Allowed initial business types should align with the frontend vocabulary:

- Buying house.
- Direct brand.
- Uniform program.
- Repeat order.
- Replenishment.

Use stable stored codes, not display labels.

### 4.2 Referenced commercial parties

Optional Account references:

- Buying house.
- Brand.
- PO issuer.
- Bill-to party.
- Consignee.
- Importer.
- Agent.

Do not store fallback organization names in live Journey records. Resolve names from the referenced Accounts.

### 4.3 Contact and ownership

- Optional `primaryContactId` reference to `CRMContact`.
- Required Journey owner using the existing Sales user/department identity pattern.
- Optional merchandiser using the same identity pattern.
- `createdBy` and `updatedBy` actor metadata consistent with the existing CRM models.

Do not invent a new employee directory endpoint merely for this form. Reuse an existing safe user/team source when one exists. If the repository has no suitable picker contract, default the owner to the signed-in user and document reassignment as later work.

### 4.4 Lifecycle

- `currentStage`.
- `stageStates` for all eight stages.
- `risk`.
- Optional `riskReason`.
- Optional `businessStatus`.

Initial state for a newly created Journey:

- `currentStage = account`
- `account = inProgress`
- All later stages = `notStarted`
- `risk = onTrack`

Do not automatically mark Account complete merely because an Account was selected. The Account stage should use the real Account/readiness view and later determine whether it is ready to advance.

### 4.5 Timing and commercial summary

- Optional target date with label and date.
- Optional expected value and currency.
- Expected value is restricted commercial information and must follow server-side visibility rules.
- Optional current-next-action reference to a `CRMActivity` task.

Do not store relative text such as `in 3 days`; derive it from real dates.

### 4.6 Lifecycle/audit fields

- Active/archive state consistent with other CRM models.
- Timestamps.
- Created/updated/archive actor metadata.
- Useful indexes for Account, owner, current stage, state/risk, next-action due date or referenced activity, and updated date.

### 4.7 Reference generation

Generate `SJ-YYYY-NNNN` safely under concurrent creation.

Do not use an unprotected `countDocuments() + 1` generator. Reuse an existing safe sequence mechanism if one exists; otherwise implement a small atomic counter with a unique index/retry strategy consistent with this backend.

---

## 5. Activity integration

The existing `CRMActivity` model already supports tasks/follow-ups and forward links:

```text
links[] = { module, recordId }
```

Use it for the optional initial next action.

### Creation behaviour

When the user supplies an initial next action:

- Create a `CRMActivity` with `activityType = task` or the existing appropriate task code.
- Link it to the selected Account.
- Link it to the new Journey through `links[]` using the agreed module code.
- Set subject, due date, owner, planned status, and appropriate visibility.
- Store/reference that Activity as the Journey's current next action if the chosen model needs a direct pointer.

Do not duplicate the task subject, owner, status, and due date as an independently editable embedded task on the Journey.

If the initial action is omitted, the Journey may be created without one and the Hub must visibly say `No next action assigned`.

Document and handle partial failure safely. Do not report complete success if the Journey is created but a requested initial Activity fails silently.

---

## 6. API

Add the Journey API under the existing CRM namespace, for example:

```text
/api/cms/crm/sales-journeys
```

Use the final naming consistently in model, route mount, frontend adapter, and audit records.

### Required endpoints

#### List

`GET /api/cms/crm/sales-journeys`

Support the current Hub needs without loading an unbounded collection:

- Pagination.
- Search by Journey reference/name and populated Account name/code.
- Account filter.
- Owner filter.
- Current-stage filter.
- Current-stage-state filter.
- Risk filter.
- Business-type filter.
- Waiting-on filter derived from lifecycle state.
- Commercial value range only for authorized roles.
- My work versus Team scope.
- Urgency ordering or enough normalized date data for the current bounded client grouping.

Return a purpose-built summary DTO for the Hub. Do not expose unrestricted raw Mongoose documents.

#### Detail

`GET /api/cms/crm/sales-journeys/:journeyId`

Return Journey context required by the shared header and lifecycle:

- Business reference and title.
- Resolved Account and optional party references.
- Ownership.
- Current stage and all stage states.
- Risk/status.
- Target date.
- Permission-aware commercial summary.
- Current next-action Activity summary.

Accept the human Journey reference used by the route. Do not expose Mongo IDs in the URL or breadcrumb.

#### Create

`POST /api/cms/crm/sales-journeys`

Create the Journey and optional initial Activity.

Validate:

- Account exists and is active.
- Contact, if supplied, belongs to the selected Account or is otherwise valid under the existing relationship rules.
- Referenced commercial parties exist and are active.
- Business type, lifecycle codes, currency, dates, and amounts.
- Required ownership.
- Permission to create.

Respect the existing `salesWrites(...)` held-for-approval behaviour. A `202` must not be presented as a committed Journey.

### Not required in this task

- General Journey edit screen.
- Stage-transition API.
- Delete/archive/restore UI.
- Enquiry or later-stage CRUD.
- Bulk import.

Add only a narrowly justified internal update needed to attach the initial Activity during creation if required by the chosen implementation.

---

## 7. Server-side permissions and visibility

- Read access follows the existing Sales CRM read rules.
- Create access follows the existing approval-aware Sales write rules.
- Commercial expected value must be removed from unauthorized responses, not merely hidden in React.
- My work scope must be determined from authenticated identity, not a client-supplied arbitrary user ID.
- Team scope must respect existing department visibility.
- Audit every successful Journey creation and initial Activity creation.
- Do not trust client-supplied `createdBy`, `updatedBy`, Journey reference, lifecycle stage defaults, or Account display names.

---

## 8. Start Journey frontend flow

Make the existing `Start Journey` control functional for authorized users.

Use the established drawer/sheet pattern unless repository inspection establishes a clearer existing form convention. Keep the flow short enough to complete without CRM training.

### 8.1 Required fields

1. **Account** — searchable existing Account selection.
2. **Journey name** — required; suggest a value from Account plus requirement reference, but keep it editable.
3. **Business type** — required.

### 8.2 Ownership and context

4. **Primary contact** — optional; options scoped to the selected Account.
5. **Owner** — required; default to the current signed-in user when no approved user picker exists.
6. **Merchandiser** — optional when a safe existing picker exists.
7. **Customer requirement/RFQ reference** — optional external reference for orientation only; this does not create an Enquiry record.

### 8.3 Timing and action

8. **Target label** and **target date** — optional.
9. **Expected value** and **currency** — optional and permission controlled.
10. **First next action** and **due date** — optional; creates a real CRM Activity task.

### 8.4 Interaction requirements

- Clearly say that the Journey starts at Account.
- Clearly say that later lifecycle modules are not created by this form.
- Search Accounts through the existing endpoint; do not preload an unbounded Account list.
- After Account selection, show Account code and name so similarly named organizations are distinguishable.
- Keep party selection out of the minimum first screen unless it remains understandable; optional commercial parties may live in an expandable section.
- Validate required fields before submission.
- Prevent duplicate submissions.
- Handle `202 held` distinctly: say the Journey was submitted for approval and do not navigate to a record that does not yet exist.
- On committed success, refresh the Hub and navigate to:

```text
/sales/dashboard/journeys/{journeyId}/account
```

- On failure, preserve entered values and show the server message.
- Drawer/sheet must preserve Escape, focus trap, initial focus, and focus restoration.

---

## 9. Replace fixture-backed operational data

Once the API is implemented:

- The default Sales Journeys Hub must load real Journey summaries.
- `loadJourney(journeyId)` must load real Journey context.
- `loadJourneysForAccount(accountId)` must use the real filtered API.
- The capability registry must mark the Journey record itself as live.
- The Account stage remains live as it is now.
- The seven later stage modules remain prototype/unavailable according to their existing capability flags.

Do not silently mix sample Journeys with real Journeys in the operational list.

The existing prototype records may remain available only through an explicit development/demo mechanism that cannot be mistaken for live business data. If no such mechanism already exists, keep the fixture files for component development but remove them from the normal Hub adapter path.

For a newly created real Journey:

- Account stage opens with real Account data.
- Unreached later stages render honest empty/preview states.
- No fake stage detail is generated for the new Journey.

---

## 10. Account integration

- The Account detail page's related Journeys section must use the real Journey API.
- A newly created Journey should appear under its selected Account without duplicating Account data.
- Opening the Account from the Journey must continue to use the real Account ID internally while showing Account code/name to the user.

Do not add a `journeyIds[]` array to Account unless the repository's established relationship direction requires it. Prefer querying Journeys by indexed `accountId` so Account and Journey do not maintain competing relationship lists.

---

## 11. Data-model and duplication risks

The implementation must explicitly avoid:

- Copying Account names/addresses/roles into Journey as editable customer data.
- Copying Contacts into Journey subdocuments.
- Embedding a second task model for next actions.
- Treating the Journey as an Order.
- Creating Enquiry, Style, Quote, Order, Production, Shipment, or Retention records during Journey creation.
- Hardcoding prototype user IDs in live records.
- Trusting client-provided owner scope or audit actors.
- Unsafe count-based Journey reference generation.
- Returning commercial value to unauthorized clients.
- Mixing fixtures and live records without an unmistakable demo boundary.

---

## 12. Required states

### Hub

- Loading.
- Real empty state.
- Populated with live Journeys.
- Filtered empty.
- Error with retry.
- Held-for-approval result.

### Start Journey

- Initial.
- Account searching.
- Account selected.
- Validation errors.
- Submitting.
- Held for approval.
- Success.
- Server/network error without lost form state.
- Permission restricted/read-only.

### Journey detail

- Real Journey with live Account stage.
- Journey not found.
- Later stage not started/prototype.

---

## 13. Verification

### Backend

Add focused tests consistent with the repository's actual test framework for:

- Journey reference generation.
- Required field and enum validation.
- Missing/inactive Account rejection.
- Contact/Account relationship validation.
- Permission-aware expected-value response.
- My work scope cannot be impersonated through query parameters.
- Successful create without initial task.
- Successful create with linked CRM Activity task.
- Partial-failure behaviour.
- List filters and pagination.
- Detail by human Journey reference.
- Audit invocation.

Do not run migrations or seeds.

### Frontend

- Start Journey opens and is keyboard accessible.
- Account search and selection.
- Validation and duplicate-submit prevention.
- Held `202` behaviour.
- Successful creation appears in the Progress Spine.
- Successful creation opens the Account stage.
- Commercial value is absent for unauthorized roles.
- Real empty/loading/error states.
- Desktop and mobile flow.

### Regression boundaries

- Existing Account CRUD remains functional.
- Existing CRM Activity creation remains functional.
- Existing Progress Spine layout remains intact.
- Existing prototype stage screens still show honest preview/empty states.
- No application dependency changes unless separately approved.

---

## 14. Acceptance criteria

- `Start Journey` is no longer a disabled preview for authorized users.
- A user can create a real Journey from an existing Account.
- The backend assigns a safe human Journey reference.
- The new Journey appears immediately in the live Sales Journeys Hub.
- The new Journey opens at the Account stage.
- Account, Journey, Activity, and Order concepts remain distinct.
- The optional first next action is a real linked CRM Activity task.
- The Hub and Account detail page read real Journey data.
- Sample Journeys are not mixed into the operational live list.
- Seven later stages remain out of scope and do not gain fake persistence.
- Server-side permissions protect commercial values and user scope.
- Every successful mutation is audited.
- Held-for-approval writes are represented honestly.
- No migration or seed is required or run.
- No unrelated or uncommitted work is overwritten.
- Nothing is committed unless explicitly requested.

---

## 15. Required handoff

Update `docs/handoff/latest-implementation.md` with:

- Model and indexes added.
- API routes and response contracts.
- Permission and audit behaviour.
- Start Journey fields and flow.
- Activity-link behaviour.
- Fixture-to-live adapter changes.
- Files changed in each repository.
- Tests/verification performed and exact results.
- Any commands the user must run.
- Known limitations.
- Confirmation that later lifecycle modules were not implemented.
- Commit status.

