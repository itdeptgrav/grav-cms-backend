# Qwen typed capability architecture for the GRAV CMS assistant

Status: accepted and implemented for the central assistant read path.  
Date: 27 September 2026.

## Decision

Use Qwen as the central assistant's only live language planner. Models do not
receive unrestricted database access and do not own permissions, identity,
company scope, calculations or writes.

Every CMS application extends the assistant by registering a typed capability
and semantic-catalogue metadata (see
`docs/decisions/cms-semantic-catalogue.md`):

1. GRAV resolves the signed-in actor and removes capabilities they may not use.
2. GRAV detects explicit business domains and exact catalogue metrics. Exact
   catalogue claims execute without Qwen; otherwise Qwen receives only the
   authorised, domain-compatible capability names and descriptions.
3. Qwen receives only that capability's closed JSON schema and fills its
   arguments from the user's words and the last validated plan.
4. GRAV validates the object, rejects unknown fields, and re-authorises the
   capability after the model decision.
5. A deterministic application service resolves real identities and scope,
   reads the authoritative records and constructs a bounded evidence packet.
6. Qwen explains that packet. A grounding guard rejects invented dates and
   figures before the answer is shown.

The current page is not authority. A capability is available from any CMS page
when the signed-in actor holds its underlying permission.

## HR catalogue now connected

The deterministic HR services are exposed through a permission-gated read
catalogue covering the current HR business model:

- workforce overview, employee directory and complete authorised employee
  records (private, statutory, medical and compensation fields remain separate
  permission classes);
- daily and ranged attendance, raw punch timelines, work/break/late/early/OT
  measures, HR review evidence, monthly exclusions and all existing monthly
  report inputs;
- leave applications, regularisation, balances, entitlements, approval history,
  holiday calendar and complete leave configuration;
- department/designation hierarchy and manager assignments;
- job postings, candidates and recruitment tasks;
- employee document register and lifecycle metadata;
- company payroll runs, employee payroll items, earnings, deductions,
  contributions, adjustments and an opt-in day audit for a named employee and
  pay period;
- performance evidence (attendance, leave and SOP/C4 points), complete active
  policies, attendance/payroll/C4 settings and HR audit history.

The full field/domain matrix and intentional exclusions are recorded in
`docs/decisions/hr-assistant-data-catalogue.md`.

The catalogue uses the same `hrCapabilities` actor contract as the mounted HR
routes. Salary and payroll are not offered to a directory-only user. Private
employee, identifier, medical and compensation fields are projected
independently. The model never sees a forbidden tool and every selected tool
checks permission again before reading.

## Conversation contract

The assistant stores the last validated tool and typed arguments separately
from answer prose. Follow-ups such as “show me details”, “what about yesterday”
or “and Priya” may use that state. Assistant prose and previously returned HR
records are not copied into the planning prompt.

## Jev

Open-Jev remains evaluation code and historical evidence, but it is no longer
called by the live central assistant. This prevents an accounting-only pilot
from intercepting HR or another CMS application's question. Qwen is the one
live language layer; GRAV's deterministic services remain the data authority.

## Writes

This decision does not turn read tools into mutation tools. Any future HR write
must be a separate typed capability with server-side validation and the sequence
draft -> preview -> explicit confirmation -> idempotent execution -> audit.
No model response by itself authorises a leave approval, payroll operation,
employee edit or other consequential action.

## Evidence

- `test/hr-ai/qwenToolPlanner.test.js` proves the two-stage closed planner,
  bounded state, unoffered-tool refusal and extra-field refusal.
- `test/hr-ai/centralAssistant.route.test.js` proves cross-page HR access,
  denial for unauthorised employees and deterministic HR data attachment.
- `test/hr-access/hr-ai-parity.test.js` proves assistant capability permissions
  remain aligned with mounted HR endpoint permissions.
- `test/hr-ai/openJevPilot.test.js` proves the central path remains Qwen-only
  even when a stale Open-Jev flag is present.
