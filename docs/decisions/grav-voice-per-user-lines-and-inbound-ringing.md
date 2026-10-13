# GRAV Voice per-user numbers and inbound ringing

**Decision date:** 12 October 2026  
**Status:** Accepted; localhost carrier fallback active, LiveKit ingress and production deployment pending

## Decision

Each enabled GRAV Voice user owns one administrator-assigned public DID. A DID
cannot be assigned to two identities. Sales employees may carry the assignment
on their Sales Person row; executives and other identities without an Employee
record carry it on their company membership. The old process-wide caller ID is not a
fallback for an unassigned user: such a user sees Voice as unconfigured and
cannot accidentally place calls from somebody else's number.

The Sales Person roster or company membership stores the public number and the
non-secret LiveKit outbound/inbound trunk identities. Provider credentials remain server-side.
Outgoing calls use the signed-in user's assignment. Incoming calls are routed
by the carrier to that DID's LiveKit inbound trunk and by one long-lived direct
dispatch rule to a dedicated, opaque employee room. The Voice app polls only
its authenticated owner's room, rings visibly and audibly, and offers Answer
and Decline. Accepting joins the employee to the room; GRAV starts recording
only after the browser has joined and acknowledged the answer.

GRAV owns identity, company scope, number uniqueness, call history, recording
and authorisation. LiveKit/Plivo provisioning owns DID purchase, SIP delivery,
inbound trunk connectivity and dispatch. Merely typing a number or trunk id in
Sales Settings does not claim that provider provisioning succeeded.

When Plivo Zentrunk cannot deliver a DID directly to LiveKit, the accepted
fallback is a Plivo Voice Application answer URL on the GRAV backend. It returns
only a bounded Dial/User instruction for an enabled DID already assigned in
GRAV; it does not accept a caller-supplied arbitrary SIP destination. This keeps
per-user ownership in GRAV while moving the failing first SIP hop from Zentrunk
to Plivo Programmable Voice. LiveKit inbound trunks and dispatch rules remain
unchanged.

## Current external evidence

The initial LiveKit inspection on 12 October 2026 found one outbound trunk,
`GRAV Plivo` (`ST_B4w69aME82ne`), carrying `+918065395337`, and no inbound
resources. Commissioning later that day created inbound trunk
`ST_ea9mTZRoL5w6` and direct dispatch rule `SDR_f6x6FcyTLmW2`, routing that DID
to Aroona Panda's opaque Voice room. The roster assignment is enabled.

The Plivo console was then used to create active inbound trunk
`25553776921923528` and link the existing DID. Two test attempts proved that
the initial global origination URI did not deliver an INVITE to LiveKit: both
ended after about 20 seconds as carrier-cancelled/SIP 487 and no LiveKit room
was created. LiveKit's Plivo guidance requires India region pinning for Indian
numbers, so the primary URI was corrected to
`f96q3m0l.india.sip.livekit.cloud;transport=tcp`. Two post-change calls at
22:27 and 22:28 IST produced the same zero-second carrier-cancelled/SIP 487
result and no LiveKit room. The saved Plivo primary URI, LiveKit E.164 inbound
trunk, CEO dispatch rule, DNS answer, and TCP/5060 reachability were then
independently rechecked. Commissioning is therefore blocked at
Plivo-to-LiveKit SIP delivery or an account-side India routing policy, not at
GRAV's per-user ownership or browser ring flow. The line was subsequently
reassigned from Aroona Panda to `ceo@grav.in`; dispatch rule
`SDR_f6x6FcyTLmW2` now targets the CEO room
`grav-voice-in-eedd6ab4a0953c5de38b0617`. Consequently:

- the application can enforce per-user number ownership now;
- The CEO's carrier, LiveKit and application assignment is present, but is not
  declared fully commissioned until the updated application is deployed and a
  live call passes;
- additional users need additional KYC-approved DIDs (or an explicitly
  approved extension-routing product) before their lines can be enabled.

On 13 October the DID was temporarily cut over to Plivo Voice Application
`28308954336650476`, whose answer URL reaches the localhost backend through a
narrow proxy and temporary Cloudflare tunnel. A 07:28 IST test proved the
application hop: the caller heard ringing and Plivo created SIP B-leg
`74beabb6-2837-450d-8aa5-8477e2b5770a`. The B-leg itself never rang or
answered, lasted zero seconds, and created no LiveKit room, so the CEO browser
had no inbound participant to display. This preserves the earlier diagnosis:
the unresolved boundary is LiveKit SIP ingress/India routing, not GRAV owner
resolution or browser polling. LiveKit Cloud currently requires an interactive
login to inspect its project call logs; Plivo support has not replied.

The subsequent login identified a stronger root cause: the active LiveKit
account (`itdeptgrav@gmail.com`) exposes only project `p_llxf08vfxsr`, while
the backend and Plivo configuration target `p_f96q3m0l`. The visible project
has no SIP trunks, dispatch rules, or calls, and the configured project returns
404 in that account. A migration must update the Voice backend credentials,
SIP endpoint, inbound trunk, dispatch rule and Plivo target together; changing
only the carrier URI would split the caller and browser across projects.

The chosen fix is a Voice-only migration rather than changing the legacy
project shared by unrelated features. GRAV Voice has dedicated project
credentials, new inbound trunk `ST_n8ajcjdWsj2Z`, and direct dispatch rule
`SDR_kCAfBSdEJc4k` in the accessible `Grav` project. Plivo now dials the
project's explicit India endpoint, `llxf08vfxsr.india.sip.livekit.cloud`, while
the CEO browser uses the same project credentials for room discovery and
answer tokens. This keeps the carrier leg and browser leg in one project
without migrating Cowork or screen-sharing traffic.

The fallback now adds a bounded Dial completion action URL, also exposed by the
narrow proxy, so the next real attempt records Plivo's Dial status, ring flag,
hangup cause and leg UUIDs. Before production, install the Plivo Auth Token as
a deployment secret, require V3 signatures, set the public base URL explicitly,
replace the temporary tunnel with the deployed HTTPS endpoint, and run the
real-call gate.

A 07:53 IST call on 13 October proved SIP ingress to the migrated project:
Plivo's B-leg rang against `llxf08vfxsr.india.sip.livekit.cloud` for 39 seconds
and LiveKit counted the call. The browser miss was an application-side timing
bug, not another routing failure. Room participants are now classified as SIP
by LiveKit participant kind as well as by `sip.*` attributes, because those
attributes may be populated after the participant first becomes visible. The
stable participant identity, rather than the asynchronously arriving
`sip.callID`, is the inbound call key. This preserves one call record throughout
ringing and answer.

## Safety and lifecycle rules

- Assignment is admin-only and unique by E.164 number.
- An inbound call is visible only to its assigned roster owner.
- A caller hanging up before answer becomes `AGENT_NO_ANSWER` / missed.
- Decline is recorded as rejected; it is not presented as an answered call.
- Incoming and outgoing recordings remain company-scoped and stream only
  through the authenticated recording route.
- No browser receives SIP credentials, LiveKit API secrets or provider tokens.
