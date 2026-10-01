# HR assistant data catalogue

Status: implemented for the current HR read model.  
Date: 27 September 2026.

## Meaning of “all HR data points”

The assistant may answer from every current HR business domain that GRAV stores
and the signed-in actor is authorised to read. Qwen receives typed operations
and bounded evidence, not MongoDB access or collection schemas. A future HR
module is not automatically covered merely because this catalogue exists; its
read adapter and permission contract must be added when the module is added.

## Connected domains

| Domain | Available evidence | Required read authority |
| --- | --- | --- |
| People | Directory, employment, reporting lines, contacts/private profile, custom fields, statutory identifiers, medical fields, pay configuration | Field-by-field people/identifier/medical/compensation capabilities |
| Organisation | Departments, all designations, active state, designation managers, primary/secondary department managers, headcount | Directory read |
| Attendance | Daily and ranged rows, raw punch timeline, shifts, final/system status, work/break/OT/late/early/missed-punch values, HR review, holidays, month exclusions | Attendance read |
| Leave | Applications, dates, type, reason, paid/LWP days, documents-present state, manager/HR decisions, regularisation, balances and entitlements | Leave read |
| Recruitment | Jobs, skills, salary range, candidates, stages, ratings, interviews and recruitment tasks | Recruitment read |
| Employee documents | Type, request/generation/release/revoke lifecycle, metadata and history | Documents read; compensation metadata additionally needs compensation read |
| Payroll | Runs, employee items, rates, attendance/payable days, earnings, deductions, employer contributions, adjustments, status/payment metadata and optional single-period day audit | Payroll read plus compensation read |
| Performance | Tenure, attendance metrics/rate, leave position and SOP/C4 ledger | Skills read plus workforce analytics |
| Policy/configuration | Complete attendance, leave, payroll and C4 settings plus complete active policy records | Compliance read |
| Audit | HR change records, actor, action, entity, changed fields, origin, approval and critical flag | Audit read |
| Supporting summaries | Overview, holidays, overtime, aggregate payroll and self/named salary | Corresponding domain capability |

## Intentionally not exposed to the language model

- passwords, password-reset values, session or push tokens;
- face photographs, embeddings, enrolment tokens/hashes, device folders and IP
  or user-agent traces;
- bank account numbers and IFSC codes;
- bearer download URLs, Drive ids, storage public ids and raw document files;
- internal tenant/collection controls or unrestricted query syntax;
- any write operation.

The assistant may describe safe status/metadata where a business adapter exposes
it, but secrets themselves are never model context. This is not incomplete HR
coverage; it is the security boundary.

## Reliability contract

Every query is re-authorised after model selection. Schemas reject unknown
arguments, reads are fixed and bounded, company/person scope is resolved by
GRAV, and the grounding guard checks the final answer against tool evidence.
Missing data must be reported as missing; it must never be invented.

Every standard scalar employee field is a canonical semantic metric. The
application resolves and formats that value directly after the authorised read.
This both reduces latency and prevents a language model from changing an exact
name/value after retrieval; broad multi-field questions continue through the
grounded summarisation path.

## Canonical semantic metrics

Scalar employee and compensation questions use the registry in
`services/hrSemanticMetrics.js`. Every metric records its source of truth,
field path, value type and temporal grain. In particular, configured monthly
compensation comes from the employee master while month/year payroll results
come from posted payroll items. Related measures declare period variants, so a
period cannot silently be applied to a current-only field. For an explicit,
catalogue-defined scalar term, the longest unique catalogue alias claims the
metric before model planning; this prevents a model from substituting a valid
but unrelated enum such as `primary_manager` for `work_email`. Qwen chooses
among typed metrics only when the request is not explicitly claimed. In both
paths, server-owned catalogue metadata chooses and validates the source. This
replaces sentence-by-sentence routing fixes with one metadata contract and its
contract tests.

Standard HR vocabulary is metric metadata too. CTC/cost to company maps to
configured employer cost, take-home maps to configured net salary, and PF/EPF
maps to configured provident fund. The selected metric's aliases are removed
from the person query before employee resolution, so “Arpita CTC” cannot become
a search for an employee named “Arpita CTC”. The same metadata covers standard
employee fields such as work email, personal email, phone, manager, department,
designation, date of birth and employment dates; longer aliases win so
“personal email” cannot collapse to the broader “email” metric.

The same principle applies one level above fields. Existing tool relevance
contracts form a deterministic domain filter before Qwen planning. Once a
request explicitly identifies attendance, leave, payroll, recruitment,
documents, policy or audit, unrelated tools are not offered to the planner.
Named-person attendance is a deterministic read and renderer, including a
specific-day status or the current 30-day summary. Qwen remains available for
unrecognised paraphrases and broad synthesis. The scalar-metric tool is marked
catalogue-only and is not offered to Qwen at all; the broad employee tool offers
only `fullRecord` and `attendanceSummary`. Therefore the model cannot override
an exact catalogue field, select one scalar enum in place of another, or turn a
named attendance request into an unrelated profile field.

Scalar claims also validate the subject type against authoritative HR data
before execution. A field word such as “department” is not enough: the
remaining subject must resolve to an actual employee. Organisation questions
therefore remain organisation queries. A named department/designation request
is resolved against the department catalogue and rendered deterministically.
