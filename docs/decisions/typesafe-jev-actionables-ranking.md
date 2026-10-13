# TypeSafe Jev for employee actionables ranking

**Decision date:** 12 October 2026  
**Status:** Accepted for a guarded pilot

## Decision

Use the official hosted TypeSafe Jev API as an optional judgment layer for the
employee home's cross-application attention list. Jev ranks already-authorised
queue summaries. It does not discover records, grant access, change totals,
execute actions, or hide work.

The old Open-Jev and Qwen pilots are not dependencies of this integration.
This integration uses the official `POST https://api.typesafe.ai/v1/systemone`
contract and the `jev-latest` alias.

## Boundary

Ordinary GRAV code remains authoritative for:

- identity, company scope and permissions;
- which applications and queues the employee may see;
- counts, URLs and hard deadline/stoppage rules;
- fallback ordering whenever Jev is disabled, uncertain or unavailable.

Jev receives only the bounded queue descriptors already present in the
actionables response: application name, queue label, count and existing tone.
It receives no employee name, email, record payload, customer text, amount or
secret. The server-side API key must never reach the browser.

## Rollout

The feature is off by default. Enabling it defaults to `shadow`, which records
the proposed order in response metadata without changing the dashboard.
`active` may be selected only after representative shadow results are reviewed.

Configuration:

- `TYPESAFE_API_KEY` — server-side credential.
- `TYPESAFE_JEV_ACTIONABLES_ENABLED=true` — opt in.
- `TYPESAFE_JEV_ACTIONABLES_MODE=shadow|active` — defaults to `shadow`.
- `TYPESAFE_JEV_MODEL` — defaults to `jev-latest`.
- `TYPESAFE_JEV_TIMEOUT_MS` — defaults to 1800 ms, bounded to 100–10000 ms.
- `TYPESAFE_JEV_MIN_CONFIDENCE` — defaults to 0.65.
- `TYPESAFE_JEV_API_URL` — defaults to the official HTTPS endpoint; HTTP is refused.

No credential means `unconfigured`, not an application error. API errors,
timeouts, malformed answers and answers below the confidence threshold retain
the deterministic order. The response exposes provider, mode, status, served
model, evaluated/confident counts and token usage; it never exposes the key.

## Known limitation

The current providers return aggregate queues. Ranking those queues improves
the home page but cannot deduplicate hundreds of alerts or rank individual
purchase orders, emails or approvals. Record-level candidate envelopes and
source-specific deduplication are a separate future slice and must preserve the
same authorization boundary.
