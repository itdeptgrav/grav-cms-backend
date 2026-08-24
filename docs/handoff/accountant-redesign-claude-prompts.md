# Claude prompts — Accounting redesign from Sales design language

## Claude Design prompt

Use `/Users/risheeray/grav-cms` as the frontend repo.

Study the current Sales app design language and the existing design artifacts:

- `app/grav-ui.css`
- `components/shell/FrostShell.js`
- `components/Sales_DashboardLayout.js`
- `components/ceo/ui/Primitives.tsx`
- `components/sales/crm/crmShared.js`
- `.design/Main.dc.html`
- `.design/account-page-directions.html`
- `.design/costinv/`
- `DESIGN_SYSTEM.md`
- `FRONTEND_AUDIT.md`
- `UI_SCREEN_INVENTORY.md`

Then design the Accounting app so it feels like the same GRAV product as Sales,
while staying dense and financial. Do not invent a new design system.

Produce artboards for:

1. Accounting overview dashboard.
2. Invoice or voucher register.
3. Sales voucher or payment entry form.
4. Invoice detail or ledger detail.
5. Trial balance or balance sheet report.
6. Import wizard or bank reconciliation workflow.
7. Invoice print/e-way bill preview exception.

Show the GRAV Frost shell, accounting navigation, company switcher, global
search, notifications, primary actions, table/list treatment, loading, empty and
error states, responsive behaviour, and status/audit-note chips.

Use `docs/tasks/accountant-sales-design-redesign.md` in
`/Users/risheeray/grav-cms-backend` as the product brief.

## Claude Code prompt

Use `/Users/risheeray/grav-cms` as the frontend repo and
`/Users/risheeray/grav-cms-backend` for planning docs.

Goal: redo the full `/accountant` app so it follows the current Sales app design
language.

Required reading before editing:

- `/Users/risheeray/grav-cms-backend/docs/tasks/accountant-sales-design-redesign.md`
- `/Users/risheeray/grav-cms/DESIGN_SYSTEM.md`
- `/Users/risheeray/grav-cms/FRONTEND_AUDIT.md`
- `/Users/risheeray/grav-cms/UI_SCREEN_INVENTORY.md`
- `/Users/risheeray/grav-cms/app/grav-ui.css`
- `/Users/risheeray/grav-cms/components/Sales_DashboardLayout.js`
- `/Users/risheeray/grav-cms/components/shell/FrostShell.js`
- `/Users/risheeray/grav-cms/components/ceo/ui/Primitives.tsx`
- `/Users/risheeray/grav-cms/components/accountant/LayoutShell.js`
- `/Users/risheeray/grav-cms/components/accountant/Sidebar.js`
- `/Users/risheeray/grav-cms/components/accountant/Topbar.js`

Start with Slice 0 and Slice 1 only:

- Inspect `git status` in both repos and preserve all existing uncommitted work.
- Do not edit backend accounting models or APIs.
- Preserve Accountant auth, company selection, push registration, route hiding,
  no-chrome login/invite routes, `DepartmentGuard slug="accountant" softFail`,
  and `ForceLightTheme`.
- Move Accounting toward the GRAV Frost shell and Sales design language.
- Keep accounting dense: compact tables, tabular figures, clear totals and
  sticky actions.
- Reuse `components/ceo/ui/Primitives.tsx` wherever possible.
- Do not create a parallel design system.

After Slice 1, report:

- files changed
- behaviours preserved
- screenshots or browser checks completed
- remaining risks
- exact next slice recommendation
