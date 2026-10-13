# TypeSafe Jev actionables pilot

## Goal

Determine whether official Jev improves the employee home's top attention
queues compared with the deterministic urgent/attention/info ordering.

## Delivered slice

- Official HTTPS System One client with bearer authentication and timeout.
- Bounded score question for at most twelve visible queue summaries.
- Feature flag, shadow/active modes and confidence threshold.
- Existing totals, permissions and queue membership remain unchanged.
- Deterministic fallback for missing credentials, errors and uncertainty.
- Token-usage and model metadata for cost/evaluation.
- Focused unit tests without making paid network calls.

## Commissioning

1. Obtain an official TypeSafe key and store it only in the backend environment.
2. Enable `shadow` mode.
3. Compare `ranking.proposedOrder` with the existing `top` order on real days.
4. Record whether the employee's genuinely important queue appears in the top five.
5. Move to `active` only if the shadow sample improves top-five usefulness and
   does not demote any hard deadline/stoppage queue.

## Not in this slice

- Individual record or email classification.
- Deduplicating developer alerts.
- Automated actions or notification suppression.
- Sending HR, customer, financial or message bodies to TypeSafe.
