# Merchandising — manual browser checklist

Everything below is verified by the integration harness
(`test/merchandising/production-closure.journey.test.js`, one walk through the
real routers). This list is for the things a harness cannot see: what a person
actually reads on the screen, and whether the right control is where they look
for it.

**Before you start.** The four sections need data to be interesting, and two
gates stand in front of that on any database that has not had them applied:

1. Journey product lines need permanent references, or Development accepts
   nothing. Run the backfill dry run first, read it, then apply.
2. A company needs one published Time & Action template and one published
   working calendar, or no plan can be created.

Both commands are in `docs/handoff/latest-implementation.md`. Neither has been
run against your dev cluster.

Sign each line off as **works / broken / not reachable**. "Not reachable"
usually means the data gate above, not a defect.

---

## A. Navigation and shell

- [ ] The bar shows exactly four entries, in this order: Overview, Development,
      Order Execution, Time & Action.
- [ ] Standing on `/merchandiser/development` lights **Development** and
      nothing else.
- [ ] Opening a development file keeps Development lit.
- [ ] There is no Changes entry and no Management entry in the bar.
- [ ] `/merchandiser/management` opens from app settings and lights nothing.

## B. Overview

- [ ] Two decks: **Development** first, then **Order execution**.
- [ ] Every figure is a link. Clicking one opens a list holding that many rows.
- [ ] "Questions to Sales" opens `new` **plus** the clarification filter — the
      records it counted, not their whole view.
- [ ] Stop the backend and reload: figures read **Couldn't check**, never 0.
- [ ] Break only the development read: the order figures still show.

## C. Development register

- [ ] Seven views: New requests, Active, Awaiting approval, Approved,
      Released to R&D, Closed, All.
- [ ] Arrow keys move between view tabs and focus follows.
- [ ] Each empty view names who holds the next move. `Approved` says Sales.
- [ ] Search, "Assigned to me" and "Waiting on Sales" all survive a reload
      (they are in the URL).
- [ ] No column shows quantity, consumption, rate, cost, supplier or stock.
- [ ] At phone width the table becomes cards and nothing scrolls sideways.

## D. Development file

- [ ] Exactly six tabs: Summary, Sales Brief, Materials & Trims, Packaging,
      Approvals & Handover, Changes & History.
- [ ] Summary's first line names a department — never "in progress".
- [ ] Sales Brief has no edit control anywhere on it.
- [ ] The row form has eight fields and none of them is a quantity or a cost.
- [ ] Adding a row you have no grant for is refused **in the server's words**.
- [ ] Submit, then try to approve as the same person: refused, and the refusal
      explains that the approver may not be the author.
- [ ] Approve as somebody else: the file reads **Approved, awaiting Sales**,
      not a green tick.
- [ ] There is no Release button anywhere on this screen.

## E. Sales' side

- [ ] Style & Sample stage shows a **Development** panel.
- [ ] A line with no permanent reference offers no Send button and says why.
- [ ] After Merchandising approves, the panel shows the approved revision and
      the chosen materials, read-only, with no way to edit one.
- [ ] **Authorise release to R&D** appears only once a revision is approved.
- [ ] Open the same journey from the Merchandiser dashboard: the Development
      panel is **absent**.

## F. Order Execution

- [ ] On a file whose order came from development, Materials & Trims and
      Packaging show a band naming the development number.
- [ ] Adopting fills a **draft** — the revision state is not Approved.
- [ ] Adopting twice reports what it skipped rather than duplicating rows.
- [ ] An order that did not come from development shows no band at all.

## G. Time & Action

- [ ] A file with no plan offers **Create the plan** (at approver level).
- [ ] The template dropdown's default is "Whichever one applies to this order".
- [ ] After creating, the file appears in the Time & Action register.
- [ ] Baseline, forecast and actual are three separate columns.
- [ ] Request a reschedule: the dialog ends at **Send it for a decision** and
      offers no Approve.
- [ ] The request then appears in **Waiting on a decision** for everybody.
- [ ] Approving as the requester is refused; as somebody else it moves the
      forecast, and the date on screen actually changes.
- [ ] Where the move breaches the committed date, the band says so before you
      approve.

## H. Handover and change control

- [ ] Submitting the pack without ticking the declaration is refused.
- [ ] After submitting, the file is **not** shown as handed over until PPC
      accepts.
- [ ] A Sales change appears on the file, and the previously approved
      selections are unchanged.

## I. Management

- [ ] Configuration is visible only at owner level.
- [ ] Three areas: Plan templates, Working calendars, Reason codes.
- [ ] A published version has no Save control — only Retire.
- [ ] Starting a draft from a published template carries its milestones across.
- [ ] Setting a milestone owned by another department to "Merchandising marks
      it done" shows the rule in red, beside the control.
- [ ] Bulk tools: download the template, fill two rows, upload, and check the
      report names any column it did not recognise.
- [ ] Apply is unavailable until a preview exists.

## J. Both widths

- [ ] Repeat B, C and F at 1280px and at 1440px.
- [ ] The register's table header stays put while rows scroll under it.
