# Accountant app redesign — align with Sales design language

> **Status:** Ready for design and implementation.
>
> **User intent:** Use the current Sales app in `/Users/risheeray/grav-cms` as
> the design-language source, use the existing Claude Design artifacts as visual
> input, then redo the entire Accounting app accordingly.
>
> **Scope boundary:** This document authorizes planning and implementation
> direction only. It does not authorize backend accounting model/API changes
> unless a later slice explicitly requires them.

## 1. Source of truth

The Sales app's current visual language is the target:

- `app/grav-ui.css` — GRAV token layer: `.grav-ui`, frost surfaces, slab,
  state colours, radius scale, field hues and graph hues.
- `components/shell/FrostShell.js` — shared top navigation chrome used by Sales,
  CEO, HR, Store, Merchandiser, Planner, QC and R&D.
- `components/Sales_DashboardLayout.js` — Sales navigation structure and app
  composition. Treat this as the closest working reference for Accounting.
- `components/ceo/ui/Primitives.tsx` — shared kit: `Panel`, `PanelHead`,
  `PageHead`, `Button`, `Field`, `Input`, `Select`, `Chip`, `EmptyState`,
  `ErrorState`, `SkeletonRows`, `Rows`, `StatPair`, `Meter`.
- `components/sales/crm/crmShared.js` — useful modal/drawer and CRM interaction
  patterns where they are generic enough to copy or extract.
- `.design/` — Claude Design artifacts already checked into the frontend repo:
  `Main.dc.html`, `account-page-directions.html`, and `costinv/` layouts.

The audit documents in the frontend repo are also required reading:

- `DESIGN_SYSTEM.md`
- `FRONTEND_AUDIT.md`
- `UI_SCREEN_INVENTORY.md`

## 2. Current Accounting problem

Accounting is the largest module that does not use the GRAV design system:

- 65 routes under `/accountant`.
- `0` design-token references and thousands of raw Tailwind palette utilities.
- Bespoke sidebar + topbar in `components/accountant/Sidebar.js`,
  `components/accountant/Topbar.js`, and `components/accountant/LayoutShell.js`.
- Local page patterns for tables, forms, loading states, empty states, badges,
  panels and overlays.
- Important accounting behaviour already exists and must be preserved:
  company switcher, accountant auth, route hiding via hidden nav items,
  push registration, `DepartmentGuard slug="accountant" softFail`, print routes,
  vouchers, ledgers, reports, imports, approvals and audit notes.

The redesign is a visual and interaction migration, not a rewrite of accounting
business logic.

## 3. Design principles

Accounting should feel like the same GRAV product as Sales, but not like a Sales
screen wearing accounting labels.

- Use the Sales/Frost shell and token system as the base.
- Keep accounting light-only unless a separate dark-mode accounting decision is
  made. `ForceLightTheme` can remain.
- Preserve accounting density: ledgers, vouchers and reports need compact rows,
  tabular figures, sticky actions and fast scanning.
- Use slab headers for record identity and report context, not decorative hero
  sections.
- Use frost panels for grouped work, summaries and side context.
- Use quiet table/list surfaces for books; avoid oversized marketing cards.
- Use `Chip` tones for status and risk vocabulary instead of ad hoc coloured
  pills.
- Use lucide icons consistently; remove emoji/icon substitutes.
- Keep page containers aligned with Sales: `mx-auto max-w-[1480px] px-4 py-6
  deck:px-8` unless the screen has a known fixed-width print/device reason.
- Create missing shared accounting primitives only when multiple screens need
  them; do not copy a local table/form pattern 65 times.

## 4. Claude Design brief

Claude Design should produce a small set of canonical Accounting artboards
before broad coding starts.

Required artboards:

1. Accounting overview dashboard.
2. Register/list screen: invoices or vouchers.
3. Voucher entry form: sales voucher or payment.
4. Record detail: invoice detail or ledger detail.
5. Financial report: trial balance or balance sheet.
6. Import/reconciliation workflow: import wizard or bank reconciliation.
7. Print/preview exception: invoice print or e-way bill preview.

Each artboard must show:

- Sales/Frost shell applied to Accounting navigation.
- Accounting-specific top controls: company switcher, global search,
  notifications and primary action.
- Dense ledger-friendly table/list treatment.
- Loading, empty and error states.
- Mobile/tablet behaviour for at least one register and one form.
- How statuses, approvals and audit notes are expressed with `Chip` tones.

Design must be grounded in the existing files, not an unrelated new design
system.

## 5. Claude Code implementation slices

### Slice 0 — inventory and guardrails

- Read `git status` in both repos and preserve all uncommitted work.
- Read the Sales design files and Accounting shell files listed above.
- Produce a route-by-route implementation checklist from
  `UI_SCREEN_INVENTORY.md`'s Accounting section.
- Identify print/device routes that must remain special-cased.

### Slice 1 — Accounting shell on GRAV Frost

- Refactor `components/accountant/LayoutShell.js` to wrap Accounting pages in the
  `.grav-ui`/`FrostShell` environment while preserving:
  - `AccountantAuthProvider`
  - `PushRegistrar`
  - `DepartmentGuard slug="accountant" softFail`
  - hidden route enforcement
  - no-chrome login and accept-invite pages
  - `ForceLightTheme`
- Replace the bespoke sidebar/topbar experience with a top-nav arrangement
  aligned to Sales, while keeping Accounting's navigation groups discoverable.
- Keep company switching and global search visible in the shell controls.

### Slice 2 — shared Accounting primitives

Create or extract only the primitives needed repeatedly across Accounting:

- `AccountingPageHead` or direct `PageHead` usage with company/report context.
- `AccountingTable` for dense ledger rows, sticky headers, empty state and
  row actions.
- `AccountingStatStrip` for debit/credit/balance/report totals.
- `AccountingActionBar` for save/post/approve/print/export actions.
- `AccountingStatusChip` mapping accounting statuses to the existing `Chip`
  tones.
- Optional drawer/modal wrapper if `CrmDrawer`/`CrmModal` is not appropriate
  outside CRM.

Prefer composing `components/ceo/ui/Primitives.tsx` instead of inventing a
parallel kit.

### Slice 3 — high-traffic screens

Migrate the screens users touch most:

- `/accountant`
- `/accountant/invoices`
- `/accountant/invoices/[id]`
- `/accountant/sales-vouchers`
- `/accountant/sales-vouchers/new`
- `/accountant/ledger-balances`
- `/accountant/ledger/[id]`
- `/accountant/chart-of-accounts`
- `/accountant/bank-reconciliation`

Preserve all data fetching and mutations. This slice should be visual and
structural, not a backend refactor.

### Slice 4 — remaining registers and forms

Migrate the remaining vouchers, parties, customers, vendors, receipts, payments,
expenses, budgets, tax filings, companies, team and import/history pages.

### Slice 5 — reports

Migrate all financial reports with a shared report pattern:

- trial balance
- day book
- profit and loss
- balance sheet
- cash flow
- GST summary
- receivables aging
- payables aging

Reports need tabular-number alignment, export/print actions, date/company
context and clear empty/loading/error states.

### Slice 6 — print/device exceptions

Review print routes separately. They may not use the full app shell, but their
preview/control screens should still use the GRAV visual language where it does
not affect print fidelity.

### Slice 7 — cleanup and verification

- Remove unused raw Accounting sidebar/topbar code only after all routes have
  moved.
- Remove duplicate local badges, table wrappers and modal styles only when their
  replacements are active.
- Verify `npm run build`.
- Run browser checks for representative desktop and mobile widths.
- Confirm no unrelated files were reverted or reformatted.

## 6. Acceptance criteria

- Accounting visually belongs to the same product family as Sales.
- Accounting still feels compact and financial, not decorative.
- Every `/accountant` route either uses the GRAV shell/patterns or is explicitly
  documented as a print/auth exception.
- Company switching, search, hidden nav preferences, auth, push registration and
  route access still work.
- High-risk screens have before/after screenshots or browser verification notes.
- Raw `slate-*`/`gray-*` styling in Accounting is substantially reduced and no
  new parallel design system is introduced.
- No backend persistence or accounting calculation behaviour changes without a
  separate backend task.

## 7. Open decisions

- Whether Accounting should keep a top navigation like Sales or use a FrostShell
  sidebar variant if/when one is implemented.
- Whether the old Accountant sidebar customization should become a top-nav menu
  customizer or a module settings page.
- Whether the global GRAV command/search should eventually replace the current
  Accountant `GlobalSearch`, or whether both should coexist.
- Which Accounting screens are genuinely mobile-supported versus desktop-first
  but responsive enough for review/approval.
