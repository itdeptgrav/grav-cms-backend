# Open-Jev + Qwen accounting routing cascade

Status: implemented as a disabled-by-default evaluation pilot; not approved for production traffic.

## Outcome

The accounting assistant may use a two-stage route decision without giving either model access to accounting data or authority to execute an action:

1. GRAV builds the candidate list from the signed-in user's current tool permissions.
2. Jev sees only the question and safe candidate descriptions.
3. A confident executable Jev route takes the fast path. `clarify` and `unsupported` are control labels rather than completed accounting reads, so the hybrid mode always gives the typed Qwen planner one chance to interpret them; this prevents a confidently wrong control label from ending a valid accounting request.
4. The planner receives the chronological user-only conversation, the same safe candidate descriptions and Jev's route probabilities. At most two earlier user messages are included; assistant answers are excluded.
5. Qwen must return one offered tool plus a closed typed plan. The plan can express a single ledger, an account group or all ledgers with balance-side/ranking/limit, a voucher party/type/date/ranking/limit, a precise clarification, or unsupported. Invalid, unavailable or unoffered results fail closed.
6. GRAV independently re-runs the chosen tool's permission check and executes its deterministic read from the validated plan, or from the user's exact words when Jev used the fast path.
7. If a confident Jev executable route reaches a deterministic read that cannot resolve the language safely, the same planner may make one retry with a typed plan. It may correct the route within the already-authorised candidate set.
8. GRAV validates every planned field, re-runs the selected tool's permission check, and retries its deterministic read. A second ambiguous result remains a clarification; Qwen never chooses a database record.
9. GRAV formats the answer from the returned evidence.

This is intended to improve phrasing tolerance while keeping ordinary, unambiguous questions fast. It does not make model text an accounting fact and it does not replace generic fixes in the underlying accounting tools.

The model is deliberately given broad *planning* freedom over this accounting semantic catalogue, not unrestricted database access. Adding raw database access would not improve its language understanding; it would only allow a misunderstood or injected plan to bypass company scope, permissions, field semantics and query limits. A new question shape belongs in the shared typed catalogue and deterministic reporting/query layer, after which every phrasing of that shape is available without adding phrase-specific rules.

## Product promise

The target is not a literal guarantee that every conceivable question receives an answer. The safe target is: give the verified answer when the request and evidence are sufficient; otherwise ask a precise clarification or say that the request is unsupported. Never guess a ledger, date range, sort order, company, amount or write action.

For example, “tell me the top five biggest vouchers” should normally stay entirely on the Jev fast path. Jev chooses `acc_vouchers`; GRAV's resolver extracts a limit of five and largest-by-amount ordering; GRAV re-authorises the read; the database returns the sorted rows; and GRAV formats the verified result.

If a valid ledger request such as “tell me cb of debidutt mangilal” reaches the correct tool but its words do not resolve safely, Qwen returns a single-ledger plan naming `Debidutt Mangilall`. That value is only a search term. GRAV must still find one real ledger through its existing resolver before it can expose a balance. A request such as “top five biggest debtors” becomes a group plan for `Sundry Debtors`, largest-first, limited to five; GRAV performs the lookup, balance calculation and ranking. The design therefore generalises across shorthand, word order, spelling, ranking and mixed Hindi-English without making Qwen's text authoritative or building a phrase-by-phrase regex dictionary.

Likewise, “top five ledgers with credit balance” is an all-ledger plan constrained to the credit side, and “last five transactions of Debidutt” is a recent-voucher plan with a party search term. GRAV first resolves that term to exactly one ledger in the active company and only then applies the exact recorded ledger name as a voucher filter. Several matches produce a clarification; none of the model's text is used as a database expression.

## Party-report catalogue expansion (27 Sep 2026)

The first catalogue expansion adds one typed `acc_party_reports` capability,
not four phrase routes. Its closed `report` enum is:

- `customer_outstanding`
- `customer_ageing`
- `supplier_outstanding`
- `supplier_ageing`

The remaining fields are an optional ISO as-of date, optional party search,
`none|largest|smallest` ranking and a limit from 1–15. Plain receivables,
payables, debtor/creditor balances and ranked party amounts use the outstanding
reports. Ageing is selected only when the user asks for ageing, overdue/due-date
buckets or invoice/bill age. Relative words such as “current”, “latest” and
“today” do not become dates; null tells GRAV's existing report service to apply
its authoritative current business boundary.

The executor reuses `customerOutstanding.service`, `customerAgeing.service`,
`supplierOutstanding.service` and `supplierAgeing.service`. Those services own
the company scope, Sundry-group population, posted-voucher arithmetic, ageing,
reconciliation and separation of receivables from customer credits and payables
from supplier advances. The assistant introduces no second accounting formula.

Local Qwen occasionally serialises schema-null as the literal string `"null"`.
The argument boundary normalises only standard empty sentinels (`null`, `none`,
`n/a`) to absence; arbitrary strings such as `latest` remain invalid. This is a
transport normalisation and cannot widen a report, route or permission.

Focused tests pass 82/82. A live local read proved that “show top five largest
customer receivables” becomes `customer_outstanding`, `ranking=largest`,
`limit=5`, then returns the real ranked result through the existing service.
This proves the slice, not complete accounting coverage: GST, cash flow,
budgets, cost centres, statements and the custom-report semantic catalogue
remain future adapters.

## Boundaries

- Qwen receives no ledgers, balances, vouchers, database identifiers, credentials, connection details or raw tool output.
- Qwen cannot call tools, query the database or widen the candidate list.
- Qwen may change Jev's proposed route only to another route in GRAV's already-authorised candidate enum. It cannot add a tool or widen access.
- Only previous user messages may be included for pronoun/follow-up resolution. Earlier assistant answers are excluded so balances, identifiers and tool output are not copied into the interpretation prompt.
- Prompt text is treated as untrusted content. The system instruction and JSON schema remain developer-controlled.
- Candidate selection never grants access. GRAV re-authorises immediately before execution.
- The pilot remains read-only. No create, edit, approve, post, send or delete action is added.
- The model may select only server-owned semantic fields, filters, sort directions and bounded limits. GRAV owns the mapping to storage, adds organisation/company scope, escapes values, and rejects unknown fields and operations. Raw SQL, collection names, query operators and database credentials are never part of the model contract.
- Ranked group requests are executed from real ledger-group matches and posted-voucher balances. A single-ledger request that matches several records still asks which one; the planner cannot silently select a record.
- Bare abbreviations with materially different meanings, such as “DR” meaning debit-balance ledgers or Sundry Debtors, require one precise clarification.
- A Qwen failure does not silently fall through to regex or another model.
- The pure Jev locked evaluation remains separate. Cascade results must not be reported as Jev accuracy or used to pass Jev's release gate.

## Configuration

The default remains off. Evaluation requires both:

- `GRAV_OPEN_JEV_PILOT_ENABLED=true`
- `GRAV_OPEN_JEV_MODE=jev_qwen_accounts`

Reviewer settings are independent:

- `GRAV_OPEN_JEV_QWEN_URL` (default `http://127.0.0.1:11434`)
- `GRAV_OPEN_JEV_QWEN_MODEL` (default `qwen3:8b`)
- `GRAV_OPEN_JEV_QWEN_TIMEOUT_MS` (default `15000`)

## Release work still required

Before production activation, evaluate the cascade on a locked set that includes ordinary phrasing, abbreviations, misspellings, mixed Hindi-English, contextual follow-ups, ambiguous entities, conflicting sort words, multi-intent requests, prompt injection, cross-company requests and write requests. Record end-to-end correct/clarify/unsupported behavior and latency percentiles separately for the Jev fast path, Qwen route-review path and Qwen argument-retry path. Production is blocked unless unsafe executable decisions are zero, permissions are rechecked for every executed read and retry, the result contains no data leakage, and latency meets the agreed interactive target.
