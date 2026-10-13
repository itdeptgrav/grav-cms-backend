# Decision: OpenWA is the active Sales WhatsApp provider

## Decision

Run OpenWA as a separate session service and integrate it through its protected
Easy API plus webhook. Do not embed its browser runtime inside the CMS backend.

Keep Meta Cloud API code and credentials intact but dormant behind the explicit
provider selector. Do not implement automatic provider fallback.

## Why

- Browser/session failure is isolated from the main CMS server.
- Relinking by QR does not require redeploying application code.
- API keys and session storage have a clear operational boundary.
- A transport failure cannot unexpectedly spend Meta API quota or send from a
  different business identity.
- Returning to the official API remains a configuration and validation choice,
  not a rewrite or data migration.

## Consequences

- A separate long-running OpenWA service and persistent session volume are
  required.
- OpenWA availability and WhatsApp Web compatibility become operational risks.
- Text messaging is the first supported capability. Cloud API templates and
  its media download flow stay provider-specific and dormant.
- Production rollout requires a dedicated account, consent/anti-spam policy,
  rate limiting, backup/relink instructions, and acceptance of account-ban
  risk.
