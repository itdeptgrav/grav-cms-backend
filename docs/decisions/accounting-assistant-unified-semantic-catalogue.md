# Accounting assistant: unified semantic catalogue

Date: 27 September 2026  
Status: accepted, first read universe implemented

## Decision

The Accounting assistant is not connected to raw MongoDB, SQL, Metabase or an
unbounded list of HTTP routes. It is connected to a server-owned catalogue of
typed accounting capabilities.

For the general reporting universe, the model may describe a report only with
approved semantic field ids, calculations, filters, sorting and a bounded
limit. GRAV independently resolves the signed-in Accounting user and active
organisation, injects the organisation’s company ids, validates the complete
layout and executes it with deterministic code. Unknown fields and invalid
field/operation/calculation combinations are refused.

The first universe is posted voucher lines. It covers company, voucher date,
month, financial year, voucher number/type/narration, ledger, ledger group,
party, debit, credit, signed amount and GST classification. Existing specialist
capabilities remain authoritative where voucher lines cannot express the
answer, including current closing balances and receivable/payable ageing.

The financial specialist is itself a typed catalogue. One closed `metric`
selects revenue, expenses, direct revenue, direct expenses/COGS, gross profit,
gross-profit margin, net profit, net-profit margin, assets, liabilities,
equity, or an explicit complete summary. The reply renderer consumes the
selected id and cannot silently substitute the complete summary for a
single-figure request.

## Why

Phrase-by-phrase rules do not generalise, while unrestricted database access
cannot make a language model learn and turns a misunderstanding into a data
isolation or write-safety failure. A semantic catalogue lets the model handle
language variations while code owns authority and accounting correctness.

## Mutation boundary

Read access follows the signed-in person’s Accounting permissions. A future
write capability must create a typed draft, show a deterministic preview,
re-check permissions and company scope, and require an explicit confirmation
bound to that draft. A model-generated plan is never itself authorisation to
write.

## Consequences

- Adding a semantic field or specialist domain changes the catalogue/adapter,
  not a list of user phrases.
- “Unsupported” is valid only when the authorised catalogue truly lacks the
  requested accounting operation, or the request is non-accounting.
- Complete Accounting coverage still requires dedicated adapters for domains
  outside the voucher-line universe; the catalogue must not overclaim them.

## Reliability invariants (27 September 2026 correction)

- Ledger names and groups are master-data dimensions. Denormalised copies on a
  voucher line are fallback evidence, not the grouping authority.
- Financial year is a deterministic function of voucher date and the Indian
  April–March boundary. An imported label cannot move a posted line into or out
  of a period.
- Debit/credit turnover is activity over posted voucher lines. Debit/credit
  balance is a closing position. A planner or executor may never substitute one
  for the other.
- A formatted report is released only after its result shape, bound, numeric
  measures, resolved dimensions and requested ordering are verified.
- Closing balance authority is the flagged trial-balance figure, or otherwise
  opening balance plus posted voucher movements. A differing cached
  `currentBalance` is marked `cache_stale`; it cannot override or suppress a
  complete traceable calculation.
- A zero-opening ledger with settlement-side movement but no normal-side
  posting is marked `source_incomplete` and withheld. This distinguishes stale
  cache (Debidutt Mangilall) from structurally incomplete books (Salary Payable)
  without ledger-name or phrase-specific rules.
- Search, reports and assistant reads must converge on the same server-owned
  calculation service. A UI-specific cached field is not a second accounting
  truth.
- Financial values retain two-decimal precision. Gross profit follows the
  chart-of-accounts hierarchy (sales/direct income/closing stock less
  purchases/direct expenses/opening stock), not phrase matching and not a
  dashboard shortcut.
