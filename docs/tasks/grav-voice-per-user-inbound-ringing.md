# GRAV Voice — per-user DIDs and inbound browser ringing

## Delivered application slice

- Unique Voice DID fields on the existing Sales Person roster.
- Admin-only line assignment with outbound/inbound trunk identities.
- No shared caller-ID fallback for an unassigned user.
- Outbound sessions resolve the signed-in user's line and record its owner.
- Owner-scoped inbound discovery, answer, answered and decline endpoints.
- Browser polling, audible/vibration ringing, full-screen incoming-call UI and
  LiveKit answer flow.
- CMS-wide centered incoming overlay mounted in the persistent authenticated
  shell, with Answer, Decline, Mute and End controls outside `/voice`.
- Incoming call rows and recordings reuse `CallEvent`.

## External commissioning gate

First-line progress on 12 October 2026:

- `+918065395337` was initially assigned to Aroona Panda and is now assigned to
  the active company membership for `ceo@grav.in`.
- LiveKit inbound trunk: `ST_ea9mTZRoL5w6`.
- LiveKit direct dispatch rule: `SDR_f6x6FcyTLmW2`.
- Dedicated CEO room: `grav-voice-in-eedd6ab4a0953c5de38b0617`.
- Plivo inbound trunk `25553776921923528` is active, points to the India-pinned
  endpoint `f96q3m0l.india.sip.livekit.cloud;transport=tcp`, and has the DID
  linked.
- Pending: complete the LiveKit-side India ingress check, then the real
  ring/answer/audio checks.

Because four direct Zentrunk attempts reached Plivo but never produced a
LiveKit room, the application now also owns a provider-independent fallback:
`GET|POST /api/cms/voice/plivo/inbound`. A Plivo Voice Application can use this
as its answer URL. The route resolves the called DID to its enabled GRAV owner
and returns Plivo Dial XML targeting
`sip:<DID>@<LiveKit regional SIP endpoint>;transport=tcp`. LiveKit's existing
inbound trunk and per-owner dispatch rule remain authoritative after that hop.
The route validates Plivo V3 signatures whenever `PLIVO_AUTH_TOKEN` is present;
production should additionally set `GRAV_VOICE_PLIVO_REQUIRE_SIGNATURE=1` and
`GRAV_VOICE_PUBLIC_BASE_URL=https://api.grav.in` after the token is installed.

Focused bridge/assignment/LiveKit tests pass (23/23). For localhost
commissioning, the Voice router now mounts above the broad `/api/cms` auth
middleware, a narrow proxy exposes only the two Plivo webhook paths, and a
Cloudflare quick tunnel serves the answer URL. The Plivo application
`GRAV_Voice_Inbound_to_LiveKit` (`28308954336650476`) owns the DID during this
test. This tunnel is temporary and must not be treated as production routing.

The first inbound attempt at 22:15 IST reached Plivo trunk
`25553776921923528`, remained unanswered for 21 seconds, and ended as carrier
cancelled with SIP response 487. At that time the updated owner-aware Voice app
was not running for the assigned identity. The local application now resolves
the CEO assignment and must remain open on `/voice` for the next ring test.
The second attempt at 22:22 had the same Plivo SIP 487 result and produced no
LiveKit room, which isolated the failure to the provider-to-LiveKit hop. The
provider URI was then changed from the global endpoint to LiveKit's required
India endpoint.

Two post-change attempts at 22:27 and 22:28 also reached Plivo trunk
`25553776921923528`, received no ring-start response, created no LiveKit room,
and ended after about 20 seconds as carrier-cancelled/SIP 487. A read-only
LiveKit API check confirmed that inbound trunk `ST_ea9mTZRoL5w6` still carries
the E.164 DID and dispatch rule `SDR_f6x6FcyTLmW2` still points to the CEO room.
The India endpoint resolves and accepts TCP connections on port 5060. This
leaves Plivo-to-LiveKit SIP delivery (or an account-side India routing policy)
as the commissioning blocker; it is not an application owner-assignment or
browser-ringing failure.

At 07:28 IST on 13 October, the application bridge passed its first real
carrier test. Plivo fetched the local answer XML, created outbound SIP B-leg
`74beabb6-2837-450d-8aa5-8477e2b5770a`, and played ringing to the PSTN caller.
The B-leg nevertheless had no ring-start or answer timestamp, ended with zero
seconds duration, and produced no LiveKit room or SIP participant. Therefore
the CEO browser correctly continued to report `incoming: null`: there was no
LiveKit caller for it to discover.

LiveKit's Plivo guide states that calls made from a Plivo India number require
region pinning and fail without it. The bridge is using the documented India
endpoint format, `f96q3m0l.india.sip.livekit.cloud`; the remaining account-side
check exposed a project/account mismatch. The signed-in `itdeptgrav@gmail.com`
account contains only project `p_llxf08vfxsr` (`Grav`), whose SIP URI is
`llxf08vfxsr.sip.livekit.cloud`; it has zero SIP trunks, zero dispatch rules,
and zero calls in the past 24 hours. The backend credentials and the existing
trunk/dispatch resources belong to inaccessible project `p_f96q3m0l`; opening
that project under the signed-in account returns 404. Plivo support still shows
“Waiting for a teammate” with no engineer reply.

Do not switch Plivo to `llxf08vfxsr` alone: the browser token and room APIs
would still use `f96q3m0l`. The safe self-service fix is either to sign in to
the account that owns `p_f96q3m0l`, or to create a dedicated GRAV Voice key in
the current `Grav` project and migrate the Voice-only LiveKit configuration as
one atomic change.

That Voice-only migration was completed on 13 October after explicit approval:

- dedicated service-account key `GRAV Voice inbound browser` created in the
  signed-in `Grav` project and stored only in local `.env`;
- Voice now prefers `GRAV_VOICE_LIVEKIT_URL`, `..._API_KEY`, and
  `..._API_SECRET`, leaving Cowork and other LiveKit consumers on their existing
  project;
- inbound trunk `ST_n8ajcjdWsj2Z` created for `+918065395337`;
- direct dispatch rule `SDR_kCAfBSdEJc4k` routes that trunk to
  `grav-voice-in-eedd6ab4a0953c5de38b0617`;
- the CEO membership stores the new inbound trunk id; and
- the public Plivo answer XML now targets
  `llxf08vfxsr.india.sip.livekit.cloud;transport=tcp` and still carries the
  completion diagnostic callback.

LiveKit's dashboard and API independently show one inbound trunk and one direct
dispatch rule with the expected DID, trunk binding, and room. The local CEO
Voice app again reports `+91 80653 95337` as ready. A fresh real call is now the
only remaining localhost commissioning check.

The 07:53 IST call crossed the previously blocked boundary. Plivo created SIP
B-leg `ff0a5ada-a54b-462d-bcb2-e20b6417cd37` to the new project's India
endpoint, reported ringing for 39 seconds, and LiveKit recorded one telephony
call with zero connected duration. The caller cancelled before answer. The CEO
CMS did not ring because `incomingCaller()` recognized SIP participants only
after one of their asynchronously populated `sip.*` attributes appeared.
LiveKit exposes participant kind `SIP` immediately, so the service now detects
that kind and uses the stable participant identity as the inbound database key.
This avoids both the missed early ring window and a mid-call key change when
`sip.callID` arrives. The focused Voice tests pass 26/26 and the localhost
backend was restarted with the fix. One more real call must verify the visible
CMS ring, Answer, and two-way audio.

The next attempt (Plivo A-leg `64f3b03a-ecfe-494e-916a-f252cc895268`) reached
the answer webhook and ended caller-cancelled after ringing, but there were no
CMS `/incoming` requests at all during the attempt. The local Voice browser tab
had been closed, so this test did not exercise the corrected detector. The CEO
Voice page was reopened at `http://localhost:3001/voice`; it authenticated as
Chief Executive Officer, showed the assigned DID ready, and resumed successful
`/incoming` polling. Keep that tab open for the next real call.

After the first visible Voice-page ring succeeded, the inbound UI was promoted
to the persistent CMS application shell. The assigned employee is now polled on
authenticated CMS pages rather than only while `/voice` is open. A centered,
modal overlay owns ringing and the complete LiveKit answer lifecycle outside
the Voice page; it remains mounted across client-side application navigation.
The Voice page keeps its existing richer phone UI and owns polling there, so
only one consumer handles a call at a time. ESLint passed for the changed shell
and overlay, and the focused frontend shell suite passes 73/73. A live call
while the CEO was on the CMS home produced the expected non-null global
`/incoming` response, proving the shell monitor was active; Answer and two-way
audio still require a deliberate live acceptance test.

## Localhost restart recovery — 13 October 2026

A later caller heard the provider's unavailable announcement because the
localhost services had stopped and the Plivo application still referenced the
expired quick-tunnel hostname. The backend, narrow webhook proxy and public
tunnel were restored. Plivo application `28308954336650476` now posts to
`https://cork-builder-certain-ability.trycloudflare.com/api/cms/voice/plivo/inbound`.
The backend answers on port 5050, the allow-listed proxy answers on 5052, the
frontend answers on 3001, the public URL reaches the proxy, and a localhost-only
synthetic DID probe returned the expected Dial XML for the accessible LiveKit
India endpoint. This remains a development bridge: a quick-tunnel hostname is
ephemeral and must be replaced by the stable deployed GRAV HTTPS endpoint.

The Dial XML now includes a same-origin `action` callback at
`/api/cms/voice/plivo/inbound/status`. The narrow proxy forwards that route,
the public tunnel returned HTTP 200 for both answer and status probes, and the
backend logs only the bounded diagnostic fields (`DialStatus`, ring status,
hangup cause, and leg UUIDs). The next real call will therefore capture Plivo's
final Dial outcome even when the SIP B-leg never reaches LiveKit.

## Persistent call notch across CMS navigation — 13 October 2026

The existing CMS island/notch now owns the visible state and browser-departure
cleanup for Voice-page calls. Previously, unmounting `/voice` during ordinary
client-side CMS navigation ran the same cleanup as closing the browser: it
deleted the server call and disconnected the LiveKit room. The Voice page no
longer hangs up on component unmount. It publishes the active room, call,
connected timestamp, mute state, and end/mute actions to the already-mounted
island instead, so the call and its compact controls remain available while
the employee works in another CMS application. A real browser/tab departure
still invokes the call's keepalive cleanup through the persistent island.

Call publications are owner-scoped: the global inbound holder cannot clear a
Voice-page call, and it does not start a competing inbound poll while that
call is active. Returning to `/voice` rehydrates the current room and controls
from the held publication. Focused island/shell tests pass 14/14, and a full
Next.js production build completes successfully. The remaining verification
is a deliberate localhost call: connect from `/voice`, navigate to another CMS
application, confirm uninterrupted two-way audio and a live timer in the
notch, then mute and end from the notch.

The first outbound retest at 09:54–09:58 IST failed before a PSTN leg existed.
Three database rows for `+919861690346` ended `FAILED` with LiveKit error code
`not_found`; the active `Grav` LiveKit project contained the CEO inbound trunk
but no outbound trunk, while the CEO membership still referenced old trunk
`ST_B4w69aME82ne`. A separate Plivo termination trunk
`GRAV-LiveKit-Outbound` and one-purpose credential were created without
altering the existing `GRAV-Voice` trunk. LiveKit outbound trunk
`ST_z8XPr5DwaBmu` now points to that active Plivo termination domain over TCP
and presents `+918065395337`. The CEO membership and local legacy fallback now
reference the verified new trunk; `assignedVoiceLine({email: "ceo@grav.in"})`
resolves configured with the expected inbound and outbound IDs. A fresh real
outbound call is required to verify carrier acceptance, answer, audio, and the
cross-application notch behavior.

The 10:07 IST retest advanced beyond the missing-trunk failure but was rejected
with LiveKit code `permission_denied`; LiveKit created no outbound call-log row.
The stored outbound trunk did not specify a destination country. LiveKit's
Plivo guidance requires region pinning when the caller ID is an Indian Plivo
number or the destination is in India. Outbound trunk `ST_z8XPr5DwaBmu` now
has `destinationCountry: "in"` while retaining TCP transport, the dedicated
Plivo termination domain, and caller ID `+918065395337`. The API readback
confirmed the field. Another real call must determine whether this clears the
pre-provider rejection or exposes a subsequent Plivo response.

The 10:11–10:13 IST retests exposed the next provider boundary precisely.
LiveKit created outbound call rows, but Plivo returned `403 Forbidden` to the
SIP INVITE. The dedicated Plivo credential and the password stored on LiveKit
had drifted; this can recur whenever a Plivo credential/trunk is recreated or
rotated without updating the corresponding LiveKit outbound trunk. The
`GRAV LiveKit outbound` credential was rotated once and the new secret was
immediately applied to LiveKit trunk `ST_z8XPr5DwaBmu`. Neither secret is kept
in the CMS environment, so a backend or frontend restart no longer participates
in this credential path.

At 10:21 IST, a controlled verification request returned LiveKit SIP call ID
`SCL_vPuHqkQoofah`, but the call completed in about 1.5 seconds and did not
prove carrier acceptance or ringing. The subsequent 10:23 IST call from the
CEO Voice UI created LiveKit call `SCL_6RK6qh5Wkkv6` and failed with Plivo
`403 Forbidden`; Plivo created no corresponding outbound CDR. A direct
readback of both provider configurations found that the selected Plivo
credential and LiveKit outbound trunk use different SIP usernames. Password
rotation alone therefore did not clear the authentication failure. Aligning
the LiveKit username to the existing Plivo credential is the next required
configuration change before another real call.

The localhost frontend process on port 3001 was separately found unresponsive
and restarted cleanly. The frontend is serving `/voice` again. After the SIP
username is aligned, a browser call still needs to ring and be answered to
verify two-way audio, recording startup, and the cross-app notch through the
complete CMS path.

At 10:30 IST, the LiveKit outbound trunk username was aligned to the existing
Plivo credential and the dashboard confirmed `Updated trunk`. A fresh call
from the CEO Voice UI to `+919861690346` then advanced from `Connecting` to
`On call`; the UI showed recording active and a live duration. Navigating from
`/voice` to `/onboarding` preserved the compact call notch and its timer. The
call was ended from that global notch at 23 seconds and the CMS confirmed
`Call ended`. This verifies the repaired outbound carrier path and the
cross-application call holder. The destination Jio number was only a PSTN test
endpoint; it is not a dependency of the GRAV business-line architecture.

For each employee line:

1. Purchase/approve a distinct Plivo DID.
2. Add it to an outbound trunk allowed to present that number.
3. Prefer the Plivo Voice Application answer URL for carrier ingress; its GRAV
   XML response dials the LiveKit SIP endpoint. Keep direct Zentrunk as a
   provider-level fallback until the application route has passed a live call.
4. Create a LiveKit inbound trunk for that DID.
5. Create a direct dispatch rule from that trunk to the roster row's dedicated
   inbound room.
6. Save the DID and returned trunk ids in Sales Settings, then enable the line.
7. Make a real inbound call and verify audible ring, answer, two-way audio,
   decline, missed-call lifecycle and authenticated recording playback.

Do not mark the work commissioned until the real-call checks pass. Provider to
LiveKit SIP delivery is now proven; the corrected CMS ring/answer/audio path and
production deployment remain open.
