# Production Supervisor — flow signals and dependency forecast

## Outcome

Keep the existing Live Production Tracker and add understandable, evidence-based flow signals between consecutive operations: pending work, piling, possible blockage, and risk that the downstream operation will run out of work.

## Data contract

- Route identity and operation SAM come only from the frozen Production execution basis.
- Pending pieces are distinct upstream-completed units without a downstream-or-later completion.
- Recent rates use the selected Flow window.
- Active operators are distinct `operatorId` values on attributed scans in that window. Machine count and planning headcount are never substitutes.
- Downstream standard pace is `operators × 60 / SAM minutes` when both inputs are proved.
- Otherwise the observed downstream completion rate is the fallback consumption rate.
- Feed gap is `downstream requirement − upstream arrival rate`.
- Run-out time is `pending pieces / feed gap × 60` minutes.
- “May run out of work” applies only when feed gap is positive and run-out time is within the selected window.
- Missing trustworthy rates return an unavailable prediction, never zero.

## UI states and wording

- Pending: “{n} pieces completed {upstream} but not {downstream}.”
- Piling: “Work is piling up before {downstream}: {n} pieces pending.”
- Possible blockage: “Check {downstream}: no output for {window} minutes, with {n} pieces pending.”
- Starvation risk: “{downstream} may run out of work in {minutes} minutes.”
- Slow feeder: “{upstream} is not feeding {downstream} fast enough.”
- Normal: “{upstream} and {downstream} are running at a similar speed.”

Red is reserved for possible blockage, amber for piling, violet for forecast run-out risk, teal for a clearing queue, and slate for balanced/quiet/unknown states. The detail card discloses whether the forecast used frozen SAM plus recent operator evidence or observed downstream pace.

## Acceptance

1. Old queue counting, confidence, scoping, and physical-placement rules remain unchanged.
2. Repeated scans do not increase WIP or operator counts.
3. The server returns SAM, recent operator counts, standard pace, pace percentage, feed gap, forecast minutes, and forecast basis.
4. The tracker presents blockage before run-out risk, and run-out risk before piling.
5. Unknown evidence never displays as zero and never produces a forecast.
6. Backend and frontend focused flow suites pass.
