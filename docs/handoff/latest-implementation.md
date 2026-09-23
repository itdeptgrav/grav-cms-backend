# Latest implementation — Confirmed Sales line ↔ WorkOrder bridge (Production/WorkOrder lane)

Date: 2026-09-22. Requested directly by the user (option A: one WorkOrder = one
permanent Sales `lineRef` + one server-proven company). **Not committed.**
Coordinated with IE Lane A and PPC Lane A before editing; neither had pending
edits in these files.

**Changed:** `models/CMS_Models/Manufacturing/WorkOrder/WorkOrder.js`
(`salesLineLink`, two partial indexes, immutability guard),
`routes/CMS_Routes/Sales/quotationRoutes.js` (release factory, add-product,
person edit, shared size rule), `routes/CMS_Routes/Manufacturing/WorkOrder/workOrderRoutes.js`
(split + mount), `routes/CMS_Routes/Manufacturing/Return/returnRequestRoutes.js`.
**New:** `services/production/salesLineWorkOrderLink.service.js`,
`routes/CMS_Routes/Manufacturing/WorkOrder/salesLineLinkRoutes.js`,
`test/production/sales-line-workorder-bridge.route.test.js`.

**Behaviour change:** measurement orders are grouped by line, then size. A
measured-size/line conflict or a line/people quantity mismatch now refuses
release (409 `WORK_ORDER_MEASUREMENT_LINE_CONFLICT`, conflicts listed) instead of
silently regrouping people across lines.

**Read contract** (PPC viewer + company membership, read-only):
`GET /api/cms/manufacturing/work-orders/sales-line-links/lines?lineRef=…` and
`…/sales-line-links/work-orders?workOrderId=…`; also in-process
`workOrdersForLines(companyId, refs)` / `linesForWorkOrders(companyId, ids)`.
Foreign, unknown and historical records all read `unlinked`.

**Verification:** new suite 27/27; IE Chunk 1D writers 26/26; mutation check
(link stripped from all creation paths) fails all 14 `[identity]` tests, files
restored byte-identical. Broad run (IE, costing, manufacturing, PM, production,
PPC): 12 failing suites, all pre-existing or from other lanes' in-flight work.
No live backfill; the dev DB was only read (counts).

---

# Latest implementation — Image Studio / Photopea, Slice 0.5 continued (editor workspace polish)

Date: 2026-09-21
Task: `docs/tasks/current-task.md`, Slice 0.5 (native GRAV presentation),
continued on the user's instruction. The goal was a restrained, modern dark
editing workspace, without changing Photopea's tool, menu or panel structure.

**Not committed.** Stopped for review. The earlier Slice 0.5 and Slice 0
sections are kept below.

**Scope held.**
- Frontend only. No company-drive file and no backend API.
- Nothing is injected into Photopea's cross-origin page, laid over it, or hidden
  in it.
- Photopea's branding and ads are untouched.
- No Photoshop logo or icon is used, and nothing is named Photoshop or Adobe (a
  test enforces this).

This backend repo changed only this file.

## Photopea's `environment` options, checked on 2026-09-21

| Goal | Hosted-embed support | Decision |
|---|---|---|
| Dark charcoal workspace | `theme` is documented as "0, 1, 2, …" **without descriptions** | All seven presets were rendered in a real browser (headless Chrome, scratch page using only the documented hash config and ArrayBuffer open). See the preset table below. **Theme 1 chosen**, replacing the `theme: 2` added by someone else earlier. |
| Layers/Properties prominent | `panels` (IDs 0–22) is documented | **Rejected after testing.** `[5,2]`, `[5,18,2,16,17,0]` and `[5,2,0]` all reordered or dropped panels and removed the icon column, and none of them docked Properties (5). That changes Photopea's panel structure without achieving the goal. The default docking keeps Layers/Channels/Paths and History docked, with Properties one click away in the icon column. |
| More canvas space | `vmode` 0/1/2 | Kept at **0**. Collapsing or hiding panels would hurt Layers and Properties. The space comes from a slimmer GRAV strip instead. |
| Custom colours, fonts, spacing, accent; a Photoshop look | **Not supported.** There is no CSS option in the hosted embed. Photopea's accounts page says CSS styling needs the licensed **self-hosted** version, and removing ads/branding needs a **Distributor** account. | Not attempted, and no workaround. An exact Photoshop look is a product/licensing decision. |
| `icons`, `phrases`, `showtools`, `menus` | Documented | Not used. They would mean copying marks, relabelling Photopea, or removing familiar tools. A config test asserts `panels`, `showtools`, `icons` and `phrases` are unset. |

The seven presets, sampled from the rendered pixels:

| Theme | Chrome | Canvas surround | Character |
|---|---|---|---|
| 0 | #E0E0E0 | #BFBFBF | light |
| 1 | #474747 | #252525 | **neutral charcoal** |
| 2 | #404550 | #252A35 | blue-slate |
| 3 | #222531 | — | navy |
| 4 | #4B3E51 | — | purple |
| 5 | #353535 | #1A1A1A | darker charcoal |
| 6 | #F7F7F7 | — | light |

Theme 1 gives the clearest separation between panels and canvas with no colour
cast. Theme 5 is the darker alternative if wanted.

## What changed

- **`lib/imageStudio/editor/photopea/photopeaConfig.ts`:** `theme: 1`, with the
  browser-comparison rationale in a comment. `vmode: 0` kept, with the reason
  `panels` was rejected. The test now expects theme 1 and asserts that
  `panels`, `showtools`, `icons` and `phrases` are unset.
- **`components/imageStudio/ImageStudioWorkspace.tsx`:** the editor is now one
  charcoal application window.
  - GRAV's slim title strip holds Back, **Creative / Image Studio**, **Demo
    image** with the loading status on the same line, and an outlined **"Demo
    only — not saved to GRAV"** badge. It sits directly on Photopea's menu bar,
    in the page flow and never over it.
  - The window's colours are sampled from theme 1 (surround #252525, strip
    #2a2a2a, hairlines #3a3a3a), so GRAV's chrome is the quietest layer.
  - Measured contrast on the strip: ink 12.2:1, soft 9.3:1, muted 6.0:1; error
    text 8.2:1 on its own background; badge outline 3.07:1; Retry text on hover
    ≥ 8:1.
  - The error row with Retry and the save notice are restyled for the dark strip.
  - The iframe's surround is the canvas colour, so loading shows charcoal rather
    than a light flash.
  - The earlier Chip and InlineError primitives are no longer used here, because
    their light-theme tones don't suit the dark strip.
  - The layout rules from Slice 0.5 are unchanged: fixed height below the sticky
    bar, nothing positioned over the frame.
- **`app/image-studio/imageStudioRoute.test.mjs`:** two new tests.
  - The window colours and the Photopea theme stay together, and the config
    doesn't touch Photopea's structure.
  - Nothing names Photoshop or Adobe.
- **Unchanged:** routes, shell registration, diagnostics, the preview page, the
  adapter and the coordinator. No shared file was edited in this pass;
  `AppShell.js` and `activeApplication.js` were last modified at 20:55.

## Verification

### Tests

- Image Studio and shell tests together: **246 passed, 0 failed.** That is
  `lib/imageStudio/**`, `app/image-studio/imageStudioRoute.test.mjs`, and the
  shell's `activeApplication`, `topBar` and `shellHydration` tests.
- Full `npm test`: **10,242 passed, 3 failed.** The three failures are the same
  pre-existing Store tests as before (`components/store/navigation/nav.test.mjs`
  tour target, Service master placement, overview valuation).

### Headless Chrome on `/preview/image-studio`

No sign-in and no cookies were read. For the dark-theme shot only, GRAV's own
`grav_theme` preference was set in the throwaway browser profile.

"Before" is the Slice 0.5 state with theme 2 and the light header. "After"
measurements were taken once the editor was ready:

| Width | Frame top (before → after) | Frame size after | Overlap under top bar | Page scroll | Horizontal overflow |
|---|---|---|---|---|---|
| 1440×900 | 124 → 126 | 1406×761 | 0 | none | none |
| 390×844 | 156 → 157 | 364×674 | 0 | none | none |
| 320×640 | 156 → 157 | 294×470 | 0 | none | none |

- **Narrow widths.** No overlap at 390 or 320. The strip is at most two rows. The
  loading status now shares the title line: in the first 320px capture, taken
  while loading, it had pushed the frame to y=181. The frame did not get
  noticeably taller on phones: the full badge wording cannot share a row with
  the breadcrumb at 390px, and it was kept verbatim rather than shortened.
- **Ads.** Photopea shows its "Support Photopea" column at phone widths on some
  loads and not others. Its appearance in the "after" phone shots but not the
  "before" ones is Photopea's ad rotation, not this change.
- **GRAV dark theme.** The window, strip and top bar read as one dark workspace.

### Real browser, signed in (Claude desktop pane)

Route `/image-studio/editor`, 1440×900:
- The config reached Photopea as `{"theme":1,"vmode":0,"customIO":…}`, and the
  demo image opened.
- **Menus:** Layer menu → Duplicate Layer. The Layers panel showed "Layer 1"
  above "Background", and History showed "Duplicate Layer".
- **Tools:** Brush tool selected (its options bar appeared); a stroke painted on
  Layer 1; History showed "Brush Tool".
- **Layers:** Background's visibility eye toggled off.
- **Properties:** opened from the icon column, showing the layer at 640×400.
- **File menu:** File › Save produced GRAV's "Saving to GRAV isn't available yet
  — nothing was saved" notice in the dark strip. The frame moved down to
  y=161; the page did not scroll.

Route `/image-studio/diagnostics`, running theme 1:
- ready in 186 ms;
- synthetic PNG (224,426 B) opened as 640×400;
- exports: PNG 65,211 B (`png`), JPEG 21,105 B (`jpg`), WebP 12,440 B
  (`webp`), PSD 488,959 B (`psd`);
- the exported PSD reopened;
- both forged messages were refused (wrong origin).

Route `/image-studio/editor` at 375×812: bar bottom 68, frame top 157, no page
scroll, no horizontal overflow.

## Findings for the next slice

- **Photopea clears its own modified marker on File › Save.** When the
  `customIO` save hook fires, Photopea clears the `*` from its own document tab
  (`file.png *` → `file.png`), even though nothing was stored. GRAV's notice
  says plainly that nothing was saved. But once the hook drives a real save, it
  must only run through the confirmed-GRAV-save path, and a failed save must
  tell the user explicitly, because Photopea's own marker will already have
  cleared.
- **Pane repaint delay.** The desktop browser pane sometimes draws the frame
  blank for a few seconds after navigating or resizing. DOM state and headless
  captures confirmed the editor had rendered.

## Evidence files (session scratchpad, not in the repo)

`polish/compare/`:
- `1-desktop-before-after.png`
- `2-phone-before-after.png`
- `3-after-both-grav-themes.png`
- `4-photopea-theme-presets.png`
- `5-panels-option-rejected.png`

---

# Latest implementation — Image Studio / Photopea, Slice 0.5 (native GRAV presentation)

Date: 2026-09-21
Task: `docs/tasks/current-task.md` — Image Studio Slice 0.5. Product:
`docs/product/image-studio-photopea.md` ("read as a GRAV workspace"). Roadmap:
`docs/tasks/image-studio-photopea.md` § Slice 0.5.

**Not committed.** Stopped after Slice 0.5 for review. The Slice 0 section below
is kept unchanged.

**Scope held.** Frontend presentation only:
- no company-drive file is read;
- no backend endpoint, model or revision was added;
- there is no Save control, unsaved-changes marker, autosave, or "Saved" state;
- nothing is placed over Photopea, restyled, or hidden inside it; its branding
  and its "Support Photopea" ad panel show as served.

This backend repo changed only this file.

## What changed for employees

**`/image-studio/editor`** (new `components/imageStudio/ImageStudioWorkspace.tsx`)
is now a GRAV workspace, not a test console:
- **Header:** a round Back button ("Back to Image Studio"), the breadcrumb
  **Creative / Image Studio**, the document title **Demo image**, and a status
  chip **"Demo only — not saved to GRAV"**.
- **Status line:** "Loading editor…", then "Opening demo image…". The demo
  picture opens automatically when Photopea is ready.
- **Failures** appear as a GRAV error line with **Retry**, in the page flow above
  the editor. Messages:
  - "The editor did not load. Photopea may be unreachable from this network."
  - "The demo image could not be opened in the editor."
  - "The editor stopped responding…"
  - a configuration message when the editor origin is invalid.
- **Photopea's own File › Save / Save as PSD** (the `customIO` hooks) show a
  dismissible notice: "Saving to GRAV isn't available yet — nothing was saved.
  Photopea's Export and download options save a copy to this device only."
- **Size:** the editor gets the remaining height and full width.

**`/image-studio`** is a GRAV landing page:
- a **Demo image** card with the same chip and an "Open the editor" button;
- a **GRAV files** card that says plainly that opening and saving company-drive
  files isn't available yet, with a link to the File Manager;
- the hosted-editor, branding and licence disclosure.

**Phone overlap fix.** The shared `TopBar` is `sticky top-3`. On the old page
the content scrolled, so on a phone the bar slid over Photopea's menu row. The
workspace now takes exactly `100dvh − 5.75rem`, the same arithmetic
`LegacyPageCanvas fill` uses (12px inset + 56px bar + 12px gap above, 12px
below). The editor route's frame has no bottom padding, so there is nothing to
scroll. Nothing overlays or clips Photopea.

**Diagnostics moved.** The synthetic proof workbench and message log now live
at **`/image-studio/diagnostics`**, labelled "Development only · not shown to
employees". It returns not-found when `NODE_ENV === "production"` and is linked
from nowhere.

## Files (frontend `/Users/risheeray/grav-cms`)

New:
- `components/imageStudio/ImageStudioWorkspace.tsx`
- `app/image-studio/diagnostics/page.js`
- `app/preview/image-studio/page.js`: development-only (not-found in
  production). Renders the real shell with `guardSoftFail`, following the
  `app/preview/shell/topbar` pattern, plus the real Image Studio route
  components. This lets a headless browser take desktop and phone screenshots
  without holding any credential.

Rewritten (Image Studio's own files):
- `app/image-studio/page.js`
- `app/image-studio/editor/page.js`
- `app/image-studio/layout.js`: exports `ImageStudioFrame`; no bottom padding on
  the editor.
- `components/imageStudio/PhotopeaProofWorkbench.tsx`: relabelled
  "Development only".
- `components/ImageStudio_DashboardLayout.js`: exports `IMAGE_STUDIO_NAV`.
- `app/image-studio/imageStudioRoute.test.mjs`: new checks.
  - Diagnostics are not mounted or linked in the employee pages, and both
    development-only routes return not-found in production.
  - The header text is present (Back, Creative, Demo image, the chip, the save
    notice).
  - No Save control and no "unsaved", "dirty" or "autosave" text.
  - The fixed-height class is present, with no `absolute`, `fixed` or `sticky`
    element in the workspace and no bottom padding on the editor.
  - The workspace never uses `postMessage` directly or knows Photopea
    scripts.
  - Both frames are sandboxed without `allow-top-navigation`.

Shared files, each one additive line. Everything else in them belongs to other
work and was preserved:
- `components/shell/AppShell.js`: `"/preview/image-studio"` in `RAIL_HIDDEN_PATHS`.
- `components/shell/activeApplication.js`: the `image-studio` entry also claims
  the `/preview/image-studio` prefix.

**Concurrent change not made by Claude.** At 21:10 someone else edited
`lib/imageStudio/editor/photopea/photopeaConfig.ts` and its test to add
Photopea's documented `environment.theme: 2` (dark-blue preset) and
`vmode: 0`. It was not reverted. The tests pass with it, and the "after"
screenshots were retaken with it in place.

## Verification

### Tests

- Image Studio and shell tests together: **244 passed, 0 failed.** That is
  `lib/imageStudio/**`, `app/image-studio/imageStudioRoute.test.mjs`, and the
  shell's `activeApplication`, `topBar` and `shellHydration` tests.
- Coordinator and adapter tests (origin/source rejection, serialisation,
  timeouts, cleanup): unchanged, all passing.
- Full `npm test`: **10,239 passed, 3 failed.** The three failures are the same
  pre-existing Store tests as in Slice 0:
  - `components/store/navigation/nav.test.mjs` "every tour target exists…";
  - "Service master sits under Masters…";
  - "the overview reports valuation unavailable…".

### Before/after screenshots

Headless Chrome (system Chrome driven by the backend's installed puppeteer) was
pointed at `/preview/image-studio`. It never signs in and never reads cookies.
The "before" shots were taken with the preview rendering the Slice 0 pages,
before any Slice 0.5 edit. Files are in the session scratchpad, not in the repo:
- `compare/1-desktop-editor-before-after.png`
- `compare/2-phone-editor-before-after.png`
- `compare/3-desktop-landing-before-after.png`
- `compare/4-phone-landing-and-states.png`

Measured with `getBoundingClientRect` against the top bar (`.frost-bar`, bottom
edge at 68px):

| View | Before | After |
|---|---|---|
| Desktop 1440×900 editor | frame 1052×702 at y=276; its bottom (978) past the viewport; page scrolls | frame **1408×764** at y=124, fully visible; **page does not scroll** |
| Phone 390×844 editor, at rest | frame 366×658 at y=334; page scrolls | frame **366×676** at y=156; **page does not scroll** |
| Phone editor after scrolling the frame into view | **bar overlaps the frame by 68px**, covering Photopea's menu row | overlap **0**; nothing can scroll |

### Real browser

**Claude desktop browser pane, as the signed-in user.** The backend on `:5050`
was restarted by someone else mid-slice and was up for these checks.
- **Phone width (375×812):** `/image-studio` → "Open the editor" →
  `/image-studio/editor`. Header, chip and demo image correct; Photopea's menu
  row fully visible.
- **File menu:** Photopea's **File** menu opened completely at phone width.
  **File › Save** showed GRAV's "Saving to GRAV isn't available yet — nothing
  was saved" notice. The notice sits above the frame and pushes it down (frame
  top moved from 156 to 228); the page still does not scroll.
- **Keyboard:** the Tab order runs through the shell controls to "Open the
  editor"; Enter opens the editor. In the editor the tab stops are Back,
  breadcrumb link, Dismiss (when shown), then the editor frame. Enter on Back
  returns to `/image-studio`.
  - The pane's `Return` key name did not activate links; `Enter` did. That is a
    quirk of the automation tool, not the page.
- **Synthetic proof on `/image-studio/diagnostics`** (desktop, 1440×900):
  - ready in 249 ms;
  - synthetic PNG (224,127 B) opened as 640×400;
  - exports: PNG 64,970 B (`png`), JPEG 21,052 B (`jpg`), WebP 12,354 B
    (`webp`), PSD 488,682 B (`psd`);
  - the exported PSD reopened.
- **No GRAV file API:** the network log shows no request matching `/api/files`.

**Headless Chrome, same preview route:**
- phone File menu open and File › Save notice captured;
- with photopea.com requests blocked, the "Loading editor…" state appears, and
  after the 45 s ready timeout the error line "The editor did not load. Photopea
  may be unreachable from this network." with Retry.

**Access:** `/image-studio/diagnostics` without a session → 307 to the portal,
through the existing cookie gate.

## What now feels native to GRAV

- The editor route reads like every other GRAV workspace: GRAV's own top bar
  with the "Creative" nav, then a compact GRAV header using the design-system
  kicker, title and chip styles (Primitives `Chip`, `InlineError`).
- There is a clear way back, the page says what is open ("Demo image") and what
  happens to it, and Photopea fills the rest of the screen at both widths.
- Loading and failure speak in GRAV's voice without developer logs.
- The test console is gone from the default experience.

## Limitations and follow-ups

- **Very short viewports.** On a landscape phone the fixed-height workspace
  gives Photopea very little height. There is no minimum height on purpose: a
  minimum would make the page scroll and bring the overlap back.
- **Dev indicator.** Next.js's development "N" badge and "Compiling" toast
  appear in the screenshots. They are development-only overlays, not Image
  Studio.
- **Blank frame in pane screenshots.** The pane sometimes photographs the frame
  blank for a moment after a viewport resize; DOM state confirmed the editor
  was ready.
- **Next-slice prerequisites** are unchanged; see the Slice 0 section.
- **Dev servers.** They were stopped by someone else mid-slice. The frontend dev
  server was restarted by Claude (`npm run dev`, port 3001) and is still
  running.

---

# Latest implementation — Image Studio / Photopea, Slice 0 (contract and deployment proof)

Date: 2026-09-21
Task: `docs/tasks/current-task.md` — Image Studio Slice 0. Product:
`docs/product/image-studio-photopea.md`. Decision: ADR-007,
`docs/decisions/image-studio-photopea-boundary.md`. Roadmap:
`docs/tasks/image-studio-photopea.md`.

**Not committed.** Stopped after Slice 0 for Codex review. The previous handoff
(Marketing intelligence layer) is kept unchanged below this section.

**All code is in the frontend repo (`grav-cms`).** This backend repo changed only
this file. No backend route, model, migration or configuration was added. No
company-drive file was read. No GRAV save, revision, Save As or dashboard was
built. No "Saved" state exists.

## Repository state before coding

Both repos had a large amount of unrelated uncommitted work, and other agents
were editing them during this slice:

- Frontend shell and Marketing planner files: 19:37–20:17.
- Backend Marketing creative-media files, `server.js` and this handoff: 19:40–20:31.

It was all preserved. Each shared file was re-read immediately before its one
additive line was inserted.

ADR-007 lives in its own file. `architecture-decisions.md` has no ADR-007 index
entry; that is left for Codex.

## Files (frontend, `/Users/risheeray/grav-cms`)

New:

| File | Role |
|---|---|
| `lib/imageStudio/editor/ImageEditorAdapter.ts` | The editor boundary: `ready`, `openFile`, `exportDocument`, `subscribe`, `dispose`, states, typed `EditorError` codes. No `save`, dirty flag or close, on purpose. |
| `lib/imageStudio/editor/photopea/messageCoordinator.ts` | Pure protocol logic with no DOM (details under "Message protocol"). |
| `lib/imageStudio/editor/photopea/PhotopeaAdapter.ts` | Photopea scripts and format strings. Documents are tagged via `Document.source`; exports come back through `saveToOE`. |
| `lib/imageStudio/editor/photopea/photopeaConfig.ts` | `NEXT_PUBLIC_PHOTOPEA_ORIGIN`, defaulting to `https://www.photopea.com`. Accepts a bare https origin only (http on loopback). The frame URL is the origin plus the hash config: `environment.customIO` hooks for `save` and `saveAsPSD` only. No files, URLs or credentials. |
| `lib/imageStudio/imageSignature.ts` | Identifies PNG, JPEG, WebP, PSD and PSB from the file's bytes. Used to check what the editor returned; it is evidence for the page, not authority for GRAV. |
| `lib/imageStudio/syntheticImage.ts` | Draws a canvas PNG labelled "SYNTHETIC TEST IMAGE · Not company data". |
| `components/ImageStudio_DashboardLayout.js` | FrostShell, top variant, `appSlug="image-studio"`, nav group "Creative → Image Studio". No `guardSlug` and no `guardSoftFail`, following the File Manager: a session is required, but no department is. |
| `app/image-studio/layout.js`, `app/image-studio/page.js` | Entry page: an editor-check card plus the hosted-editor disclosure (Photopea runs at photopea.com and receives the image in the browser; branding and ads are left intact and the free embed is not a white-label licence; Photopea's downloads are not GRAV saves). |
| `app/image-studio/editor/page.js` | "Back to Image Studio". The workbench loads through `next/dynamic` with `ssr: false`, only on this route. |
| `components/imageStudio/PhotopeaProofWorkbench.tsx` | The proof UI (details below). |
| Tests | `lib/imageStudio/editor/photopea/messageCoordinator.test.mjs` (30), `photopeaConfig.test.mjs` (3), `lib/imageStudio/imageSignature.test.mjs` (2), `app/image-studio/imageStudioRoute.test.mjs` (7). |

The workbench, in detail:
- The adapter, and so its message listener, is created before the iframe `src` is set.
- The iframe is `sandbox`ed without `allow-top-navigation`, with `referrerPolicy="no-referrer"`.
- Buttons: open the test image; export PNG, JPEG, WebP and PSD; reopen the exported PSD; send a forged message.
- Each export's byte count and detected signature are shown, with an on-screen message log.
- It never imports Photopea scripts, message shapes or origins.

Changed. Each is one additive entry; everything else in these dirty files belongs to other work:
- `middleware.js`: `"/image-studio"` added to `PROTECTED_PREFIXES`.
- `components/shell/AppShell.js`: `"/image-studio"` added to `RAIL_HIDDEN_PATHS`.
- `components/shell/activeApplication.js`: `{ slug: "image-studio", prefixes: ["/image-studio"] }`.

Configuration: optional `NEXT_PUBLIC_PHOTOPEA_ORIGIN`. It is unset in dev, so the
hosted default is used. No CSP or `X-Frame-Options` exists in either repo, so
none was changed. If a CSP is ever added, it needs `frame-src <editor origin>`.

## Message protocol (as implemented)

1. **Listener first.** The listener is attached before the frame loads. The
   first `"done"` from the frame moves the state from `loading` to `ready`
   (45 s timeout).
2. **The door.** A message is accepted only if `event.origin` exactly equals the
   configured origin and `event.source` is the current frame's window. Otherwise
   it is dropped and counted as a `rejected` event (reason: origin or source).
   Data must be a string of 64 KB or less, or an `ArrayBuffer`; anything else is
   rejected (type or oversize). Every post goes to that origin, never `"*"`.
3. **One at a time.** Commands queue FIFO with one in flight. Strings and
   buffers received before the next `"done"` belong to that command.
4. **Menu events.** Strings starting with `grav:cmd:` are menu events, never
   replies. Messages nobody asked for are reported as `unsolicited` and dropped.
5. **Acks.** Script commands carry an ack nonce (`grav:ack:N|`). A `"done"` that
   arrives before the ack is treated as stray and ignored.
6. **Open.** Post the ArrayBuffer (a copy). Then run the tag script: if the
   active document's `source` is still the fresh value `"file"`, set it to the
   opaque tag and echo `{ok, source, width, height}`. Both messages are queued
   together.
7. **Export.** The script echoes the active document's source. If it is not the
   expected tag it refuses without exporting; otherwise it calls
   `saveToOE(fmt)`. The page then checks, on its own side, that the source
   matches and that exactly one ArrayBuffer came back.
8. **Timeouts.** Open 60 s, script 15 s, export 120 s. A command timeout fails
   the whole session: the in-flight and queued commands are rejected, and a late
   `"done"` is ignored. The user must reload the editor.
9. **Dispose.** Removes the listener, clears timers, rejects everything pending,
   and is idempotent.

## Verification

### Unit and source tests

`node --test` over the new files plus `components/shell/activeApplication.test.mjs`
and `components/shell/topBar.test.mjs`: **230 passed, 0 failed.**

The new Image Studio tests cover:
- origin mismatches: another host, `https://photopea.com`, and `http://www.photopea.com`;
- a wrong source window and a missing frame;
- object, number, typed-array and oversized payloads;
- ordering and reply attribution, with the second command held back;
- stray `"done"` before an ack, and menu events arriving mid-command;
- ready timeout and command timeout (session failed, late `"done"` ignored);
- a `postMessage` that throws;
- cleanup (listener count 0, timers 0, pending rejected, idempotent);
- adapter open, wrong-document, zero or two buffers, tag injection, format strings and origin parsing.

Source-level checks: the route is gated and off the rail; FrostShell is used
without `guardSlug` or `guardSoftFail`; the editor is client-only; there are no
`/api/files`, `fetch(` or `localStorage` calls and no "Saved" text; the
workbench contains no Photopea details; nothing posts to `"*"`; the sandbox has
no `allow-top-navigation`.

Full `npm test`: **10,233 passed, 3 failed.** All three failures are outside
Image Studio:
- `components/store/navigation/nav.test.mjs`: "every tour target exists…" (`tour-action-panel`);
- "Service master sits under Masters…";
- "the overview reports valuation unavailable…".

### Real browser

Setup: the Claude desktop browser pane. Next dev on `localhost:3001` and backend
on `localhost:5050` were both already running and were not modified. The user
signed in. The target was hosted `https://www.photopea.com`, and the data was
synthetic only.

| Check | Result |
|---|---|
| `/image-studio` with no session | Redirected to `/` (middleware cookie gate). |
| Entry page after sign-in | Rendered in FrostShell, with top bar "IS · Image Studio" and "Creative" nav. |
| Readiness | First `"done"` from `https://www.photopea.com` in 2,641 ms cold and 176 ms warm. Origin logged exactly as configured. |
| Binary open | Synthetic PNG, 224,300 bytes, opened as 640×400 in 152 ms and tagged `grav-proof:<uuid>`. Visible in the editor. |
| `saveToOE` exports | PNG 65,135 B (signature `png`); JPEG `jpg:0.92` 21,059 B (`jpg`); WebP `webp:0.92` 12,380 B (`webp`); PSD 488,788 B (`psd`). Each was one ArrayBuffer followed by `"done"`, in 31–255 ms. |
| PSD reopen | The exported PSD (488,788 B) reopened as 640×400 and was re-tagged. |
| Forged messages | `window.postMessage("done")` and `("grav:cmd:save")` from the CMS page were both refused as wrong origin. No state change and no menu event. |
| Wrong document | A second PNG was posted straight to the frame from the console, bypassing the adapter. Its `"done"` was reported as unsolicited and ignored. Export PNG was then refused with `EDITOR_WRONG_DOCUMENT` and nothing was exported; the editor stayed ready. |
| `customIO` | Photopea's own File › Save and File › Save as PSD each delivered `grav:cmd:save` / `grav:cmd:saveAsPSD` to the page. **No `"done"` followed a menu hook.** No local download occurred. |
| Branding | Photopea's menu, links and social icons render unaltered. Nothing is hidden or overlaid. |
| Network | Image Studio made no GRAV file-API request; the only backend calls were the shell's existing ones. |

## Documented vs observed vs assumed

**Documented, and confirmed in the browser:**
- readiness `"done"`;
- string scripts and ArrayBuffer files over postMessage;
- `"done"` after each message;
- `saveToOE` returning an ArrayBuffer before `"done"`, for `png`, `jpg:q`, `webp:q` and `psd`;
- `echoToOE`;
- reading and writing `Document.source`;
- `customIO` hook scripts.

**Observed, not documented:**
- A document opened from an ArrayBuffer has `source === "file"` and name
  `"file"`. The scripting docs say `local,X,NAME`. The tag script relies on this
  observation (`FRESH_BINARY_SOURCE`); if Photopea changes it, the open fails
  closed with `EDITOR_WRONG_DOCUMENT`.
- A `customIO` hook produces no `"done"`.
- `app.documents.length` exists. It is used only by a one-off console
  diagnostic, not by product code.

**Not verified:**
- SVG open or export (`svg:` options).
- Behaviour on a Photopea script error (scripts catch their own errors, so it
  was never exercised).
- Behaviour when a menu hook fires while a command is in flight. The
  coordinator routes it as an event (unit-tested), but this was not observed
  live.
- Very large files and memory limits.
- Any browser other than the desktop pane (Chromium).
- Timeout paths live. They are unit-tested only.

## Limitations and follow-ups

- **Freshness gap.** An untagged ArrayBuffer document left active before a
  failed open would pass the check. Only this adapter creates such documents,
  and it tags each one immediately.
- **No dirty indicator and no close API.** Photopea documents neither.
- **Hosted-editor disclosure.** Bytes given to the frame are disclosed to
  Photopea's page. This is stated on the entry page.
- **Narrow layout.** At phone width, the floating shell top bar overlaps the top
  of the frame, which hides Photopea's menu row. Fine at desktop width. Polish
  for a later slice.
- **Dev double-mount.** In development React mounts twice. The first adapter is
  disposed, and its `EDITOR_DISPOSED` ready-rejection is now silenced in the
  log.
- **Node warning.** Importing `.ts` under node's test runner prints
  `MODULE_TYPELESS_PACKAGE_JSON`. It is harmless; `package.json` was not changed.

## Security prerequisites before a later slice opens GRAV files

From the product plan and ADR-007:
- A server-side editor-eligibility check that refuses `restricted` and
  unclassified files, separate from the drive's `mayRead`.
- Authorisation, company scope, and a check of the file's real content on every
  byte read and every write.
- A CSRF design that accounts for the `SameSite=None` production cookie. A
  custom header alone is not enough.
- Revision and conflict ordering that cannot leave orphan history, and a
  recoverable Drive-cleanup path on failure.
- An abuse control that is not only an in-memory limiter.
- "Saved" shown only after GRAV confirms durable storage.
- `Document.source` never treated as authorisation.
- Development data only as `IMAGE-STUDIO-TEST` records, with their IDs recorded
  and cleaned up.

---

# Latest implementation — Marketing intelligence layer + boundary corrections (Lane A)

Date: 2026-09-20
Task: `docs/tasks/current-task.md` — provider-neutral GRAV AI gateway,
deterministic evidence evaluator, durable analysis record, Campaign Health
Adviser API.

**Not committed.** Nothing was committed and no branch was changed.

## What was built

The first place in GRAV where a language model sees a customer's data. It
explains figures GRAV has already calculated. It cannot change a campaign, an
advertising account or a Sales record.

Design record: `docs/decisions/marketing-campaign-health-adviser.md`.

### New files

| File | What it is |
|---|---|
| `constants/gravAi.js` | Gateway vocabulary: the closed operation allowlist, disabled capabilities, the outbound content and key-name rules, usage limits, failure codes |
| `models/CMS_Models/AI/GravAiUsage.js` | Per company / operation / day counters, unique-indexed so `$inc` is atomic |
| `services/ai/gravAiGateway.service.js` | The only model caller on the Marketing surface |
| `constants/marketingCampaignHealth.js` | The fixed system prompt, coverage and change thresholds, allowed and forbidden recommendation types, forbidden phrases |
| `services/marketing/intelligence/campaignHealthEvidence.js` | Pure deterministic evaluator; no I/O |
| `services/marketing/intelligence/analysisIdentity.js` | Opaque signed public analysis ids |
| `models/CMS_Models/Marketing/MarketingCampaignAnalysis.js` | Immutable analysis + separate append-only dismissal collection |
| `services/marketing/intelligence/campaignHealthAdviser.service.js` | `current` / `generate` / `dismiss` / `history`, and the output validator |
| `routes/CMS_Routes/Marketing/campaignIntelligence.js` | Five routes |
| `test/marketing/campaign-health-adviser.test.js` | 26 tests, injected fake transport |
| `docs/decisions/marketing-campaign-health-adviser.md` | Design record |

### Changed files

- `server.js` — mounts the intelligence router above the performance router.
- `docs/handoff/latest-implementation.md` — this file.

### API

```
GET  /api/cms/marketing/campaign-drafts/:id/health            any Marketing role
POST /api/cms/marketing/campaign-drafts/:id/health/generate   administrator, empty body
POST /api/cms/marketing/campaign-drafts/:id/health/dismiss    any Marketing role, reason required
GET  /api/cms/marketing/campaign-drafts/:id/health/history    any Marketing role
GET  /api/cms/marketing/intelligence/usage                    administrator
```

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GEMINI_API_KEY` | — | Absent ⇒ intelligence is off and everything else works |
| `MARKETING_AI_MODEL` | `gemini-3.8-flash` | |
| `MARKETING_AI_DAILY_REQUESTS` | 100 | Per company, per operation |
| `MARKETING_AI_DAILY_TOKENS` | 300000 | Per company, per operation |

## Two defects found and fixed during verification

**The outbound safety scan refused ordinary traffic.** It stringified the packet
and matched patterns against the text, so `spendMicros: 5000000000` (an ordinary
₹5,000) matched the phone-number rule, and so did a ratio of `-0.37499999999`.
This is the dangerous kind of false positive — it surfaces as "the assistant is
broken", and the quick fix is to loosen the pattern, which removes the
protection for real phone numbers.

The same scan also could not have caught the realistic accident. A Google
campaign id is `3001` and a Meta one is `120210000000000`; as values they are
indistinguishable from an impression count.

Fixed by walking the structure instead: text rules now apply to string leaves
(everything they protect reaches GRAV as a string; a number in this packet is
something GRAV calculated), and a **new set of rules applies to key names**, so
any field named like an identifier, account, person, credential or destination
is refused whatever it holds. Rules reordered most-specific-first so a refusal
names what it actually found, and the log records the path, never the value.

**The evidence packet named its citation field `id`.** In a packet where a
database id must never appear, a bare `id` is the one field name that cannot
mean anything safe — the new key scan refused it, correctly. Renamed to
`evidenceId`.

## Verification

All tests use an **injected fake transport**. No live provider call was made.

| Suite | Result |
|---|---|
| `test/marketing/campaign-health-adviser.test.js` | **26 / 26**, three consecutive runs |
| `test/marketing` (full) | **1202 passed / 1202 total**, 24 suites — baseline was 1176/1176 across 23, so +26 and no existing test disturbed |
| `test/crm` + `test/sales` (serial, `--runInBand`, nothing concurrent) | **49 failed / 785 passed / 834 total**, 10 failing suites — reconciles exactly to the 42/792/834 across 9 suites baseline, see below |

### Regression reconciliation

The serial run shows 7 more failures and 1 more failing suite than the recorded
baseline. All 7 are in `test/crm/activities.route.test.js`, and all of them are
`mongodb-memory-server` failures — "Instance failed to start within 10000ms" and
the `buffering timed out` cascade behind it — not assertion failures. That suite
has exactly 7 tests and passes **7/7 in 4 seconds** when run on its own.

49 − 7 = 42 failed. 785 + 7 = 792 passed. 10 − 1 = 9 failing suites. Identical
to the baseline, and the remaining 9 suites are the same 9:
`enquiry.route`, `lead-clear-enum.route`, `lead-correction.route`,
`lead-draft.route`, `lead-next-action.route`, `lead-review.route`,
`sales-journey.route`, `sales-journey`, `sample-style.route`.

An earlier parallel run of the same regression was discarded: it reported 58
failures across 11 suites, inflated by 16 `MongoMemoryReplSet.create` timeouts
caused by running it alongside the Marketing suite. Memory-server contention,
not code.

### Live verification status

**No real `GEMINI_API_KEY` is configured in this environment, so nothing is
claimed as live verification.** The key was not added. Tests were not weakened
because it is absent — the fake transport exercises every guard between the
caller and the provider for real; only the provider itself is substituted.

### Known pre-existing noise

`test/marketing/meta-paused-creation.test.js` prints
`RangeError: Maximum call stack size exceeded` from Jest's promise-rejection
reporter when the Meta write client refuses a request. All 17 of that suite's
tests pass. It is unrelated to this task (that suite has no reference to the
gateway or the intelligence code) and was not introduced here; it is flagged as
a follow-up because it masks genuine unhandled-rejection reports.

## Scope

Stopped after the gateway, evaluator, analysis record and adviser API, as the
task requires. No audience recommendations, content generation, lead scoring or
autonomous actions. No frontend changes. No commits.

---

# Correction pass (2026-09-20)

Four bounded corrections after the Campaign Health implementation was accepted.
Frontend contract for both: `docs/handoff/lane-b-campaign-health-contract.md`.

## 1. Advertising-account binding unblocked

`POST /advertising-accounts/:channel` allow-listed Google's four field names for
**every** channel, so `businessId` was refused as an unknown field and a Meta
binding could never carry the business its preflight reads. The service had
accepted, validated, stored and returned it the whole time — only the HTTP path
was closed, and every existing Meta binding test called `binding.bind()`
directly, so the suite was green while the only path a browser can take was
broken.

Now a per-channel contract, declared once in
`constants/marketingGoogleSearchDeployment.js` as `CHANNEL_BINDING_FIELDS` and
used by **both** the route and the service, so they cannot drift again:

| Channel | Required | Optional |
|---|---|---|
| `google_ads` | `externalAccountId` | `loginAccountId`, `externalAccountName`, `note` |
| `meta_ads` | `externalAccountId` | `businessId`, `externalAccountName`, `note` |

`businessId` is **optional**, matching the existing Meta service contract: a
personal advertising account legitimately belongs to no business, and
`metaPreflight` already reports an absent business as `not_applicable` rather
than failing. Requiring it at the route would refuse bindings that deploy
correctly today. This is a deliberate reading of "exactly as the existing Meta
service contract requires" — the required/optional test therefore proves the
without-business case is *accepted* and stores an empty value rather than
borrowing one.

Neither channel accepts the other's identifier, enforced at the service as well
as the route — fixing only the route would leave an internal caller able to do
what the route now refuses. The refusal names the owner:
`"businessId belongs to meta ads, not google ads."`

New: `test/marketing/advertising-account-binding.route.test.js`, **15 tests, all
over HTTP** — businessId stored end to end, optional-business accepted, invalid
business refused, each channel refusing the other's field, the service refusing
it too, credential-shaped names and values still refused on both channels,
administrator-only binding with marketer read, unauthenticated refused, company
isolation, unknown channel, cross-channel account shapes, and no provider error
text reaching the browser.

## 2. Campaign Health generation opened to Marketing users

`POST …/health/generate` no longer requires an administrator. Campaign Health is
marketer-facing; restricting generation left the people it was built for able to
read only what an administrator had thought to ask for.

What holds the cost down was never the role, and all of it is unchanged:
explicit POST that nothing calls on render, strict `{}` body, duplicate-evidence
reuse with no second call, and a per-company daily request/token ceiling checked
before transmission. The **usage dashboard stays administrator-only** — spending
your own company's allowance is ordinary work; reading every consumption figure
is an operator's view.

Tests 27 and 28 prove marketer generation, non-Marketing roles refused (403),
unauthenticated refused (401), marketer refused on `/intelligence/usage`, and
that reuse and the ceiling still bound a marketer's request.

## 3. No infrastructure names in browser responses

`missingConfiguration` is **removed** from every response and from the gateway's
`availability()`. A missing key is now reported as `reason: "not_configured"`
plus GRAV's own sentence. The variable name goes to the server log once per
process, and to the deployment documentation.

Naming server infrastructure in an API response tells every caller the shape of
the deployment and tells the marketer who receives it nothing they can act on.
Test 29 sweeps all four Campaign Health routes, configured and unconfigured, for
any `MARKETING_*` / `GEMINI_*` name.

**Breaking for Lane B if they built against it** — noted in the contract.

## 4. Gateway scope claim corrected

The gateway header, `server.js`, the route header, this file and the design
record all claimed or implied that `gravAiGateway.service.js` is the only model
caller in the repository. **That was false.** Roughly ten direct callers predate
it:

`services/aiAssist.service.js`, `services/textAssist.service.js`,
`services/callSummary.service.js`, `services/ai/gravAssistant.js` (a local
Ollama model via `ollamaClient` — a different provider entirely),
`routes/task_routes/askAI.routes.js`, `meetingSummary.routes.js`,
`meetingTranscript.routes.js`, `routes/CMS_Routes/Measurement/measurementRoutes.js`,
`routes/CMS_Routes/Manufacturing/QC/qcAssistantRoutes.js`,
`routes/CMS_Routes/Inventory/chatbot/inventoryChatbot.routes.js`,
`routes/DevOps/developer.js`.

None was touched. Consolidating them is documented as later CMS-wide migration
work in the design record, with a note on why it is real work rather than a
rename: several use tool/function calling, one uses another provider, and each
needs its own operation-table entry, schema and validator.

The accurate claim — everything under `services/marketing/` and
`routes/CMS_Routes/Marketing/` reaches a model only through the gateway — is now
pinned by test 30, which also asserts the older callers still exist, so if
somebody consolidates them the test fails and the claim gets updated rather than
quietly becoming wrong again.

## 5. The Meta `RangeError` — root cause found, fixed in the test

`test/marketing/meta-paused-creation.test.js` test 16 did:

```js
jest.spyOn(metaWriteClient, "create").mockImplementation(async (args) =>
  metaWriteClient.create.wrapped(args, …));
metaWriteClient.create.wrapped = jest.requireActual(".../metaAdsWriteClient").create;
```

`jest.requireActual` returns the same cached module object that `jest.spyOn` had
just mutated, so `.wrapped` **was the mock** and called itself until the stack
ran out. That was the `RangeError: Maximum call stack size exceeded`.

The test still passed, which is the worse half: the overflow was caught by the
route's error handler, which answered a generic 500 carrying no provider
detail — so every `not.toMatch` assertion passed **without the provider-privacy
path ever running**. It would have passed with that boundary completely broken.

Fixed locally to the test by capturing the real function values before spying.
No provider behaviour changed. The test was also given positive assertions
first — it now proves the real response arrives (`200`, `RESPONSE_LOST`,
`unresolved: true`, `failedStep: "campaign"`, a substantive reason) before
proving what it does not contain, because a response that says nothing at all
satisfies every `not.toMatch`.

## Verification

| Suite | Result |
|---|---|
| `campaign-health-adviser` + `advertising-account-binding.route` | **45 / 45**, three consecutive runs |
| `google-search-deployment` + `meta-deployment-foundation` + `meta-paused-creation` | **102 / 102** |
| `meta-paused-creation` alone | **17 / 17**, no `RangeError` |
| `test/marketing` (full) | **1221 passed / 1221 total**, 25 suites |
| `test/crm` + `test/sales` (serial, alone) | see below |

Still no real `GEMINI_API_KEY`; no live verification claimed; no key added.
Nothing committed.

---

# Marketing Overview read contract (2026-09-20)

`GET /api/cms/marketing/overview` — one company-scoped, read-only business
summary for the redesigned `/marketing` page. Frontend contract:
`docs/handoff/lane-b-marketing-overview-contract.md`. No frontend file touched.

## Files

| File | What it is |
|---|---|
| `constants/marketingOverview.js` | The overview's own vocabulary: default range, confirmed-deployment states, the closed attention list, availability wording. **No business rules.** |
| `services/marketing/overview/overviewPerformance.js` | Company-wide figures and the daily series, under the existing performance rules |
| `services/marketing/overview/overviewMovement.js` | Engagement and handover counts, under the existing engagement and handover contracts |
| `services/marketing/overview/marketingOverview.service.js` | Composition, campaign rows, ranking, attention, availability |
| `routes/CMS_Routes/Marketing/marketingOverview.js` | The route |
| `test/marketing/marketing-overview.route.test.js` | 28 tests |
| `server.js` | one mount line |

## What it reuses rather than reimplements

Completeness, the settled-day filter, money-in-micros, the combination rules and
the derived-ratio rules come from `campaignReport.service.js` and
`constants/marketingPerformance.js` — including `assertRange`, `totalsFrom`,
`ratio` and `freshnessOf` directly. Handover counts come from
`handoverReadModel.summaryFor`, so the Overview and the Handovers page cannot
disagree. What counts as engagement comes from `MEANINGFUL_ENGAGEMENT_KINDS` and
`EXPLICIT_REQUEST_KINDS` in `constants/marketing.js`.

## Four judgement calls, stated because they are not obvious

**The default range ends yesterday, not today.** Today is always partial and the
performance contract already excludes a partial day from every total, so a
default ending today opens the page on a period whose last day is guaranteed to
be left out — and two consecutive "last 30 days" would compare 29 settled days
against 30.

**Conversions combine within one channel and are withheld across channels.** The
existing rule marks conversions `combinable: false` with the reason "each
channel decides for itself what counts as a conversion". That reason is about
channels, and `combine()` only ever evaluates it for one plan across channels.
Applied to a company-wide set the same reasoning gives: sum across deployments
of one channel, withhold the moment a second contributes. Spend is unchanged —
one currency sums, more than one is withheld, never converted.

**Engaged people are counted from `MarketingEventReceipt`, not the event
ledger.** `MarketingIntentEvent.gravPersonKey` is written once at intake and
never rewritten, so a person GRAV could not name in January stays nameless on
January's rows even after being recognised in February; the receipt is the half
that carries late resolution. Counting the ledger would undercount real people.
An event whose person is still unresolved is deliberately **not** counted — GRAV
does not know who they are, and one unresolved event is not evidence of one
human being.

**`prospectMovement` is not a funnel and says so.** `coherentFunnel: false`, no
percentages, no `rate` or `percent` field on any stage. The populations differ,
a prospect's current state is a fact about today rather than the period, and
blocked prospects were never submitted so they are not a remainder of the
submitted count.

## Two things found while building

**A sixth handover state the task did not list.** `DUPLICATE_LINKED` — "Linked
to an existing Sales record" — is one of the four answers Sales may give. It is
published as its own stage (`linked_to_existing`) and its own summary field
rather than folded into "rejected", because folding it in would report a
successful match as a failure.

**The signed plan identifier is signed, not secret.** `draftIdentity`'s token is
scoped to the company and cannot be forged or repointed, but its payload is
base64 and decodes to internal ids. That is the established Marketing pattern
and what the task asked for; it is recorded here so nobody treats the token as
opaque-to-everyone. The response carries no readable database id of its own.

## Not built, deliberately

No provider writes, deployment actions, activation, content creation or
AI-generated recommendations. The route and all three services import no
provider client, HTTP client, deployment writer, Sales model or AI client, and
contain no write call at all — test 28 walks the source to prove it rather than
trusting the comment.

## Verification

| Suite | Result |
|---|---|
| `marketing-overview.route` | **28 / 28**, three consecutive runs |
| `test/marketing` (full) | **1249 passed / 1249 total**, 26 suites |
| `test/crm` + `test/sales` (serial, alone) | **42 failed / 792 passed / 834 total**, 9 failing suites — an exact match to the baseline, with **zero** infrastructure failures this run, so no reconciliation was needed |

The nine are the baseline nine: `enquiry.route`, `lead-clear-enum.route`,
`lead-correction.route`, `lead-draft.route`, `lead-next-action.route`,
`lead-review.route`, `sales-journey.route`, `sales-journey`,
`sample-style.route`. The run took 277s against 1128s for the previous one on a
busy machine, which is also why `activities.route` started cleanly this time and
needed no separating out.

Nothing committed.

---

# Campaign capability matrix (2026-09-20)

`GET /api/cms/marketing/campaign-capabilities` — the contract the professional
Campaign Builder is built from. Design record:
`docs/decisions/marketing-campaign-capability-matrix.md`. Frontend contract:
`docs/handoff/lane-b-campaign-capabilities-contract.md`. No frontend file
touched.

## Files

| File | What it is |
|---|---|
| `constants/marketingCampaignCapabilities.js` | 57 settings × 8 sections × 4 campaign types, six support states, 12 lifecycle states, 13 management reads, 7 declared intelligence capabilities |
| `routes/CMS_Routes/Marketing/campaignCapabilities.js` | Two read routes |
| `test/marketing/campaign-capabilities.route.test.js` | 16 tests |
| `server.js` | one mount line |

## This changed no behaviour

It is a declaration. Creation, readiness, preflight, targeting resolution and
approval still belong to the contracts that own them. The deployable set is
asserted equal to `SUPPORTED_CAMPAIGN_TYPE_CODES` from the creation contract, so
the matrix cannot drift into enabling something.

## Decisions worth knowing

**Six support states, not two.** `unavailable` (the channel cannot),
`not_modelled` (the channel can, GRAV has not built it) and
`requires_external_audience` (reachable today by supplying a list) are three
different answers. Collapsing them tells a marketer to give up on two things
they could have had.

**Firmographics are never a targeting input.** `job_role`, `job_seniority`,
`industry` and `company_size` are `requires_external_audience` on both types. No
channel verifies where somebody works; what they sell under those names is
self-reported profile data, so a campaign aimed at procurement managers reaches
people who once showed an interest in procurement.

**Lead-form types are declared, not enabled.** `google_lead_form` and
`meta_lead_form` carry `deployable: false`, no settings column, and the reason:
GRAV models no channel-hosted form, so enquiries would reach nobody.

**The lifecycle is declared in full and controlled in part.** Twelve states, six
reachable. `scheduled`, `active`, `paused`, `completed` and `archived` carry
`offersControl: false` — a frontend may draw the sequence but must not offer a
button. `deliveryBoundary` is on every response.

## A discrepancy in the brief, reported rather than papered over

The task asked to preserve "the existing Google lead-form scope". **There is
none.** `google_lead_form` was not defined anywhere in the repository, and the
existing scope is the explicit *exclusion* of native provider lead forms —
`constants/marketingDeploymentReadiness.js` states that accepting a plan naming
a lead form would deploy a campaign whose lead capture does not exist.

That exclusion is preserved exactly. The type is declared as blocked, with what
is missing, rather than invented.

## Defect found while building

Two matrix reasons read "As above." Every `why` is rendered beside a single
disabled field, on its own, where "above" has no referent — a cross-reference
that is fine in a comment is meaningless in an API response. All four
cross-references were rewritten to stand alone, and a test now requires every
limited setting to carry at least 20 characters of self-contained reason.

## Verification

| Suite | Result |
|---|---|
| `campaign-capabilities.route` | **16 / 16**, three consecutive runs |
| `test/marketing` (full) | **1265 passed / 1265 total**, 27 suites |
| `test/crm` + `test/sales` (serial) | **42 failed / 792 passed / 834 total**, 9 failing suites — exact baseline match, zero infrastructure failures, no reconciliation needed |

The nine are the baseline nine: `enquiry.route`, `lead-clear-enum.route`,
`lead-correction.route`, `lead-draft.route`, `lead-next-action.route`,
`lead-review.route`, `sales-journey.route`, `sales-journey`,
`sample-style.route`.

Nothing committed.

---

# Google lead forms — verified contract and local validation (2026-09-20)

Partial slice. `google_lead_form` **remains unavailable**, as the task requires
until the whole contract is proven.

Sources: `docs/decisions/google-lead-form-verified-contract.md`.
Frontend: `docs/handoff/lane-b-google-lead-form-contract.md`.

## Destination correction (done first, as asked)

`constants/marketingOverview.js` already published the canonical
`/marketing/campaigns/plans/:campaignPlanId/performance` when this task began —
another session had corrected it, and `marketing-overview.route.test.js` test 32
validates every destination against the real frontend checkout at
`../grav-cms`. The service resolves the identifier into the path, so a client
receives a complete address.

What was still stale was the Lane B handoff, which still documented
`/marketing/campaigns/:campaignPlanId`. Corrected, with a table of the three
canonical paths and an explicit instruction to delete any client-side
translation table.

## Documentation verified before coding

Every Google fact encoded traces to a page read on 2026-09-20 and quoted in the
decision record: `LeadFormAsset`, `LeadFormFieldUserInputType`,
`WebhookDelivery`, `lead_form_submission_data`, and the lead-form help page.

Four findings changed the design:

**Verification is a shared secret in the payload, not a signature.**
`google_secret` is "an anti-spoofing secret set by the advertiser as part of the
webhook payload". There is no HMAC and no signature header. Checking for one
would refuse every genuine lead — and because a secret in a body is replayable
by anyone who has seen one, idempotency on the submission id is part of the
contract rather than an optimisation.

**Retrieval exists, bounded at 60 days.** Google stores leads for 60 days and
`lead_form_submission_data` is queryable, with `id` and `submission_date_time`
both filterable and sortable. A resumable, idempotent sweep is implementable —
and the promise must end where Google's retention does.

**Three eligibility rules decide whether a form serves at all.** Conversion-
focused bidding, a lead-form conversion goal, and responsive search ads. GRAV's
default bid strategy is `maximise_clicks`, which would have produced a campaign
that runs, spends and never shows the form.

**Google publishes a country list where lead forms do not serve.** A campaign
aimed only at those collects nothing.

## Files

| File | What it is |
|---|---|
| `constants/marketingGoogleLeadForm.js` | Google's documented contract, nothing inferred |
| `services/marketing/deployment/googleLeadFormDefinition.js` | Pure validator + derived deployability |
| `test/marketing/google-lead-form-definition.test.js` | 24 tests |
| `constants/marketingCampaignCapabilities.js` | lead-form entry now derives `deployable` |
| `docs/decisions/google-lead-form-verified-contract.md` | sources and quotes |
| `docs/handoff/lane-b-google-lead-form-contract.md` | frontend contract |
| `docs/handoff/lane-b-marketing-overview-contract.md` | destination correction |

## Deployability is derived, not declared

The matrix computes `google_lead_form.deployable` from the same
`UNVERIFIED.webhookPayloadSchema.verified` flag the validator reads, so the
declaration cannot claim readiness the contract denies. A hand-set boolean is
one somebody flips while finishing something else.

`localContract.complete` is `true` and published separately, so Lane B can build
the form design in advance while knowing nothing can be created yet.

## What is NOT built, and why the type stays unavailable

Creation, ingestion, reconciliation, identity/consent/engagement wiring and the
handover route are **not** built. The blocking item is honest and specific:
**Google's webhook payload schema was not read**, so the exact key names it
posts are unknown.

Hard-coding guessed key names would produce an ingestion boundary that fails on
the first real delivery, silently, when nobody is watching — and a lead-form
campaign GRAV cannot receive leads from is one that runs, spends, collects
enquiries and delivers them nowhere. That is the precise failure the design
exists to prevent, so the type stays unavailable rather than being enabled on an
assumption.

## Verification

| Suite | Result |
|---|---|
| `google-lead-form-definition` + `campaign-capabilities.route` | **40 / 40**, three consecutive runs |
| `test/marketing` (full) | **1295 passed / 1295 total**, 28 suites |
| `test/crm` + `test/sales` (serial) | **42 failed / 792 passed / 834 total**, 9 failing suites — exact baseline match, zero infrastructure failures |

The nine are the baseline nine: `enquiry.route`, `lead-clear-enum.route`,
`lead-correction.route`, `lead-draft.route`, `lead-next-action.route`,
`lead-review.route`, `sales-journey.route`, `sales-journey`,
`sample-style.route`.

Nothing committed.

---

# Google lead forms — ingestion core (2026-09-20, second pass)

Partial. `google_lead_form` **remains not deployable**; `meta_lead_form`
untouched.

## What the official pages changed

The webhook schema gap from the first pass is closed — sources and quotes in
`docs/decisions/google-lead-form-verified-contract.md`. Four findings shaped the
code, and three of them are things that would have been got wrong by a
reasonable guess:

**`column_name` is deprecated.** Google marks it so and says it "might not
always be populated, use `column_id` instead". A mapping built on the human
label passes every test written against the official samples — which all carry
one — and starts silently dropping fields in production.

**The ids are int64.** "Clients need to use 8 bytes integer to process" appears
four times. `JSON.parse` turns a campaign id above 2^53 into a nearby number
without complaining, and the correlation it exists for then matches nothing.
Read from the raw body as text.

**Delivery is at-least-once, and verification is a shared secret rather than a
signature.** A replayed body from anybody who has seen one delivery is
indistinguishable from a genuine redelivery, so deduplication on `lead_id` is a
security control here, not an efficiency.

**The HTTP contract carries retry semantics** — 4XX not retryable, 5XX
retryable. A wrong secret must be 4XX (it will not become right on a retry), an
internal fault must be 5XX (or a real lead is lost to a busy moment), and a
duplicate must be 200 (or Google keeps redelivering something that arrived).

### Google's samples contradict themselves on the key name

The production sample spells it `google_key`; **every test sample on the same
page spells it `Google_key`**. The proto says `google_key`, so the capital is
almost certainly a typo — but refusing it would refuse Google's own official
test sample. Both spellings are accepted: that is a second spelling of one field
name, not a second secret or a weaker check.

## Built

| File | What it is |
|---|---|
| `constants/marketingGoogleLeadWebhook.js` | The verified payload contract, closed `column_id` map, HTTP outcomes, limits, and the recorded secret boundary |
| `services/marketing/leads/googleLeadNormalisation.js` | Pure. One normaliser both the webhook and the recovery sweep converge on |
| `services/marketing/leads/googleLeadVerification.js` | Timing-safe secret comparison and Google's documented HTTP outcomes |
| `test/marketing/google-lead-ingestion.test.js` | 22 tests, against Google's own sample payloads |

Both doors converge: a pushed `column_id`/`string_value` delivery and a pulled
`field_type`/`field_value` recovery produce an identical lead, differing only in
recorded provenance. Separate normalisers would drift, and the drift would
surface as one submission stored twice with slightly different contents — the
exact thing deduplication exists to prevent.

## Stopped, as instructed: per-company secret persistence

`SECRET_BOUNDARY.perCompanyPersistenceAvailable: false`.

Marketing's binding contract is explicit that a credential never enters the
database — "the credential in deployment secrets, this in the database — so that
a database dump is not an advertising account". There is no company-scoped
secret store, and the repository's only encryption utility
(`utils/salaryEncryption.js`) is keyed on `SALARY_ENCRYPTION_KEY` and encrypts
numbers; reusing a payroll key for advertising secrets would make one leak into
two.

So the secret resolves from deployment configuration and is not persisted per
company. **That blocks the creation path**, which must configure a per-form
secret it can verify against later — recorded rather than worked around with
plaintext, exactly as the task requires.

## Not built

The webhook route, the lead record, identity/engagement/consent wiring, the
reconciliation sweep, the creation path, and the Lane B leads contract. The
pure, security-critical core they all depend on is done and tested; the wiring
is not.

## Verification

| Suite | Result |
|---|---|
| `google-lead-ingestion` + `google-lead-form-definition` | **46 / 46**, three consecutive runs |
| `test/marketing` (full) | **1317 passed / 1317 total**, 29 suites |
| `test/crm` + `test/sales` (serial) | **42 failed / 792 passed / 834 total**, 9 suites — exact baseline match, zero infrastructure failures |

The nine are the baseline nine: `enquiry.route`, `lead-clear-enum.route`,
`lead-correction.route`, `lead-draft.route`, `lead-next-action.route`,
`lead-review.route`, `sales-journey.route`, `sales-journey`,
`sample-style.route`.

Nothing committed.

---

# Google lead-form webhook keys — derived, not stored (2026-09-20)

The architectural blocker from the previous pass is removed. Decision record:
`docs/decisions/google-lead-webhook-derived-keys.md`.

## What dissolved it

**GRAV never needs to retrieve the webhook key — only to recognise one.** Google
lets the advertiser choose it and only ever hands it back inside a delivery, so
there is no flow where GRAV reads a stored key and shows it to anybody. What can
be recomputed does not have to be kept.

So there is no vault: `services/marketing/leads/leadWebhookKey.js` derives the
key for a company and binding with HKDF-SHA-256 from one dedicated deployment
master, at the two moments it is needed. The database holds the binding identity
and `secretVersion: 1`, neither of which is a secret.

## Files

| File | What it is |
|---|---|
| `services/marketing/leads/leadWebhookKey.js` | Derivation, timing-safe verification, key ring, availability |
| `test/marketing/google-lead-webhook-key.test.js` | 17 tests |
| `docs/decisions/google-lead-webhook-derived-keys.md` | The trade, the blast radius, the rotation procedure |
| `constants/marketingGoogleLeadWebhook.js` | `SECRET_BOUNDARY` now describes the derived strategy |

## Four details that are load-bearing

**Domain separation** — the purpose string is the HKDF salt and carries its own
version, so a second purpose over the same master produces unrelated keys.

**Length-prefixed inputs** — `("ab","c")` and `("a","bc")` would otherwise
produce identical bytes, so two bindings would derive one key. A test asserts
they do not.

**Comparison lives inside the module** — `verifyWebhookKey` takes the candidate
in rather than handing the derived key out. Returning it would be the one moment
the secret exists in a variable somebody could log or serialise.

**Weak configuration refused** — 32 bytes measured in bytes, not characters (a
32-character hex string is 16 bytes), plus a repetition check. That second check
exists because the realistic mistake is `changeme-changeme-…`: 43 bytes, eight
distinct characters, passing both a length test and a distinct-byte floor. It is
caught by counting distinct 4-byte windows — 0.22 for that, 1.0 for anything
random or an ordinary passphrase.

## Blast radius, recorded rather than glossed

One master is a single point of compromise for every company's keys. Against a
database dump — much the likelier event — the derived design is a complete
defence, because the database holds no key material at all. Against a
compromised deployment environment it is none, but that environment already
holds the advertising credentials, which are strictly worse.

An exposed webhook key permits forging lead deliveries into one company's
Marketing records. It does not reach the advertising account, cannot spend, and
cannot create a Sales record.

## A conflict found and resolved

`FORBIDDEN_SOURCES` initially named `GEMINI_API_KEY`, which broke the Campaign
Health suite's structural proof that no file under `services/marketing/` names
the model key — the guarantee that keeps the provider gateway the only route to
a model. A third-party API credential is not key material anyone would derive
from, so the decorative entry was removed rather than eroding the stronger
guarantee.

## Still not built

The delivery binding, webhook route, lead record, identity/engagement/consent
wiring, reconciliation sweep and creation path. `google_lead_form` remains not
deployable; `meta_lead_form` untouched.

## Verification

| Suite | Result |
|---|---|
| `google-lead-webhook-key` | **17 / 17**, three consecutive runs |
| `google-lead-ingestion` + `google-lead-webhook-key` | **39 / 39** |
| `test/marketing` (full) | **1334 passed / 1334 total**, 30 suites |
| `test/crm` + `test/sales` (serial) | **42 failed / 792 passed / 834 total**, 9 suites — exact baseline match, zero infrastructure failures |

Nothing committed.

---

# Google Lead Forms — Chunk 3A (2026-09-20)

A verified production webhook now creates one deduplicated normalized lead
record. `google_lead_form` remains **not deployable**.

## Correction: master-secret validation

The randomness heuristic is removed. The variable must be **exactly 64
hexadecimal characters decoding to 32 bytes**, plus one exact check for a value
of a single repeated character (`0000…` and `ffff…` are valid hex). Operators
generate it with `openssl rand -hex 32`, which the refusal message states. The
supplied value never appears in an error.

Why the heuristic could not work, recorded so it is not reintroduced: 32 random
bytes are indistinguishable from any other 32 bytes, so "detecting randomness"
is really a list of the patterns its author thought of. Mine missed
`changeme-changeme-…` on the first attempt and would have missed the next
placeholder nobody predicted, while refusing legitimate material for looking
unusual.

## Files

| File | What it is |
|---|---|
| `services/marketing/leads/deliveryToken.js` | Signed public route token, own purpose |
| `models/CMS_Models/Marketing/MarketingLeadDeliveryBinding.js` | Company-scoped binding, no secret |
| `services/marketing/leads/leadDeliveryBinding.service.js` | Prepare, resolve, attach identity, disable |
| `models/CMS_Models/Marketing/MarketingAdvertisingLead.js` | Append-only lead + separate test-delivery note |
| `services/marketing/leads/leadIngestion.service.js` | Verified delivery → one record |
| `routes/CMS_Routes/Marketing/googleLeadWebhook.js` | The unauthenticated route |
| `test/marketing/google-lead-webhook.route.test.js` | 27 tests |
| `server.js` | one mount line |

## The trust order is the design

Signed route token → *which binding*. Binding state → *is it still listening*.
Derived key → *is this really Google*. Only then do payload identifiers mean
anything, and only as a correlation check.

**The company is never taken from a payload.** `campaign_id` and `form_id` are
values a sender chooses; letting one select a tenant would let anybody who
guessed a campaign number post enquiries into that company's records, where they
would look entirely ordinary. Test 12 proves a delivery naming another company's
form and campaign still lands in the company the token named.

## Three defects found while building

**`req.destroy()` on an oversized body** gave Google a connection reset instead
of a documented 4XX. Its table treats anything that is not a 4XX as retryable,
so a body GRAV will never accept would have been redelivered indefinitely. Now
the read stops, the remainder drains, and a 4XX is sent.

**Mongoose `immutable` combined with `strict: "throw"`** rejects a document when
it is *loaded*, not when it is changed — a binding became unreadable the moment
it existed. Replaced with the explicit frozen-field hook this repository already
uses elsewhere.

**A stale comment block** describing the removed heuristic survived the edit and
was caught by the test asserting no heuristic remains, not by review.

## Where this chunk stops, structurally

No identity, engagement, consent, prospect, Sales record, reconciliation or
campaign creation. The ingestion service imports none of those and test 25 walks
its imports. Test 24 counts Marketing identities, event receipts, handovers,
Sales Leads and Activities before and after a recorded lead and asserts they are
unchanged.

## Verification

| Suite | Result |
|---|---|
| lead webhook + key + ingestion | **67 / 67**, three consecutive runs |
| `test/marketing` (full) | **1362 passed / 1362 total**, 31 suites |
| `test/crm` + `test/sales` (serial) | **42 failed / 792 passed / 834 total**, 9 suites — exact baseline match, zero infrastructure failures |

The nine are the baseline nine: `enquiry.route`, `lead-clear-enum.route`,
`lead-correction.route`, `lead-draft.route`, `lead-next-action.route`,
`lead-review.route`, `sales-journey.route`, `sales-journey`,
`sample-style.route`.

Nothing committed.

---

# Google Lead Forms — Chunk 3B (2026-09-20)

One verified submission now becomes a resolved person, exactly one engagement,
and an evidence-based consent decision, with a durable receipt describing the
outcome. `google_lead_form` remains **not deployable**.

## Files

| File | What it is |
|---|---|
| `constants/marketingLeadProcessing.js` | Stages, reason codes, the closed agreement list, public states |
| `models/CMS_Models/Marketing/MarketingLeadProcessingReceipt.js` | The mutable receipt, separate from the immutable evidence |
| `services/marketing/leads/leadProcessing.service.js` | The resumable stage machine |
| `test/marketing/google-lead-processing.test.js` | 31 tests |
| `MarketingLeadDeliveryBinding.js` | `consentNotice`, frozen once leads arrive |
| `leadDeliveryBinding.service.js` | preparation accepts the notice as part of the command |
| `leadIngestion.service.js` | stamps `noticeSettledAt` on the first production lead |
| `googleLeadWebhook.js` | detached processing after the 200 |

## The decisions that carry the most weight

**Only email and phone may identify a person.** Not a name, company, job title,
postcode, answer, campaign or click id. Two people called "R Sharma" at "Acme"
are two people, and every one of those fields is self-reported anyway.
Normalisation is imported from the handover contract rather than restated.

**A conflict waits for a human and records nothing.** Email matching one
identity and phone another has no safe automatic answer — choosing guesses,
merging is irreversible, a third identity makes it permanent. No engagement and
no consent either, because both would have to belong to somebody.

**Consent needs four proofs and the notice never comes from the delivery.** A
notice version in a payload is a value the sender chose. The agreement list is
closed and matched exactly: "very interested" is somebody wanting the product,
not agreeing to marketing. Recording permission nobody gave is a claim GRAV
cannot support and will not discover until a complaint; failing to record one
costs an email.

**No permission is not a refusal**, and the public wording says so explicitly.

**Google is answered before the slow work.** Processing is detached, which is
safe only because it is idempotent and resumable — a failure there can never
make Google redeliver a lead already recorded.

## One thing I had to correct in Chunk 3A

3A's test 24 asserted that a recorded lead creates no identity or engagement.
Deferred processing makes that timing-dependent, so it was rewritten to assert
the boundary that still holds — no handover, no Sales record — with identity and
engagement proved properly in the 3B suite where the processor is run
deliberately rather than raced.

## Verification

| Suite | Result |
|---|---|
| `google-lead-processing` | **31 / 31** |
| all five Google Lead Form suites | **122 / 122**, three consecutive runs |
| `test/marketing` (full) | **1393 passed / 1393 total**, 32 suites |
| `test/crm` + `test/sales` (serial) | **42 failed / 792 passed / 834 total**, 9 suites — exact baseline match, zero infrastructure failures |

The nine are the baseline nine: `enquiry.route`, `lead-clear-enum.route`,
`lead-correction.route`, `lead-draft.route`, `lead-next-action.route`,
`lead-review.route`, `sales-journey.route`, `sales-journey`,
`sample-style.route`.

Nothing committed.

# Google Lead Forms — Chunk 3C (2026-09-21)

Two gaps are now closed:
- **Internal:** GRAV answered Google, then stopped before processing.
- **External:** Google never delivered at all.

Both go through the one existing pipeline. Backend only; no frontend file was
edited. `google_lead_form` remains **not deployable**, and `meta_lead_form`
remains unavailable.

## Files

| File | What it is |
|---|---|
| `services/marketing/leads/leadProcessingQueue.js` (new) | the durable promise, `$setOnInsert` only |
| `services/marketing/leads/leadRecovery.service.js` (new) | internal sweep: stale receipts plus enquiries with no receipt, company by company |
| `services/marketing/leads/leadReconciliation.service.js` (new) | the 60-day read-back, cursor, lease and coverage |
| `models/CMS_Models/Marketing/MarketingLeadReconciliationState.js` (new) | per-binding cursor, `coveredUntil`, gap and counts. The cursor id and page token are `select:false` |
| `services/marketing/channels/googleAdsClient.js` | `readLeadFormSubmissions`: one closed GAQL query, adapted to the normaliser's shape |
| `services/marketing/leads/leadIngestion.service.js` | writes the promise before returning; holds a probable duplicate arriving by the other route |
| `services/marketing/leads/googleLeadNormalisation.js` | `instantOf` (the API's zoned time), and custom answers kept as `CUSTOM_QUESTION` |
| `constants/marketingLeadProcessing.js` | reason `possible_duplicate_submission`, `RECOVERY` limits, `COVERAGE_STATES` |
| `constants/marketingCampaignCapabilities.js` | `google_lead_form` now names paused external creation as the remaining boundary |
| `server.js` | a 5-minute internal sweep, which can be switched off via the `marketing-lead-recovery` job flag |
| `test/marketing/google-lead-recovery.test.js` (new) | 27 tests |
| `test/marketing/google-lead-ingestion.test.js` | test 19 rewritten to Google's real custom-field shape |
| `test/marketing/google-lead-form-definition.test.js` | the capability wording assertion follows the new boundary text |

Design decisions are in `docs/decisions/google-lead-form-verified-contract.md`,
under "Chunk 3C decisions".

## For Lane B

- **Public coverage vocabulary:** `recovery_current`, `recovery_behind`,
  `recovery_never_run`, `recovery_gap`, `recovery_unavailable`. It is returned by
  `leadReconciliation.coverage({companyId})`.
- Each entry carries `draftRef`, `state`, `label`, `means`, `lastCheckedAt`,
  `checkedBackTo`, `unrecoverableBefore`, `recoveredEnquiries` and
  `retentionDays`.
- It contains no provider ids, database ids, binding refs, tokens or contact
  details; test 22 pins this.
- **No route is mounted yet.** Exposing coverage is a UI decision for whoever
  builds the screen.
- Reconciliation is not scheduled either, because it needs a campaign GRAV has
  created (the next chunk).

## Found, not fixed (separate work)

- **`googleAdsClient.API_VERSION` is `v18`, which Google has sunset.** Available
  versions are v22 (sunset October 2026) through v25. Every live Google Ads call
  would fail today. The new read reuses the constant and does not upgrade it.
- **`readDeliveryStates` queries `FROM audience_group`, `advertisement` and
  `targeting_term`.** None of these are GAQL resources.

## Verification

| Suite | Result |
|---|---|
| `google-lead-recovery` (3C) | **27 / 27** |
| all six Google Lead Form suites | **149 / 149** |
| `test/marketing` (full) | **1420 passed / 1420 total**, 33 suites (baseline 1393, plus 27 new) |
| `test/crm` + `test/sales` (serial, `--runInBand`) | **42 failed / 792 passed / 834 total**, 9 suites — exact baseline match |

The nine failing suites are the baseline nine.

During the full Marketing run, two regressions I had introduced surfaced and were
fixed in source:
- The boundary text lost the phrase "lead form".
- I had removed `api_reconciliation` from ingestion's `NOT_IN_THIS_CHUNK`, but
  that list describes the ingestion path, which still does not reconcile.

Nothing committed.

# Google Lead Forms — Chunk 3C.1: Google Ads v25 client and the operational reconciliation boundary (2026-09-21)

The shared Google Ads client is moved off sunset v18 onto **v25** and proved
against Google's v25 reference byte for byte. Chunk 3C's missing routes and
scheduler are finished. Backend only; no frontend file was edited.
`google_lead_form` stays **not deployable**, and `meta_lead_form` stays
unavailable. Nothing was committed.

**The full audit:** `docs/decisions/google-ads-api-v25.md` covers 13 defects,
none of them previously caught by a test, including 7 that would have made every
live create or read fail.

## What Lane B needs to act on

1. **New brief field `euPoliticalAdvertising`** on the Google Search brief.
   - Values are `"does_not_contain"` or `"contains"`.
   - Google now refuses any campaign create without this self-declaration
     (`FieldError.REQUIRED`).
   - It is the advertiser's legal statement, so GRAV never defaults it. An empty
     value blocks mapping with `EU_POLITICAL_DECLARATION_MISSING`, exactly like
     Meta's `specialAdCategory`.
   - **Until the campaign builder offers this choice, no Google Search plan can
     be deployed.** Google would reject it anyway.
2. **Recovery status:** `GET /api/cms/marketing/lead-forms/recovery`, readable
   by any Marketing role.
   - It returns `{ recovery: { retentionDays, recoverableFrom, leadsRecorded,
     duplicatesIgnored, awaitingProcessing, heldForReview, leadForms: [ { draftRef,
     state, label, means, checkedThrough, lastCheckedAt, checkedBackTo,
     unrecoverableBefore, recoveredEnquiries, duplicatesIgnored, attentionReason:
     {code,label,means}|null } ] }, canRun, vocabulary }`.
   - The vocabularies come with the response; do not hard-code them.
3. **Check now:** `POST /api/cms/marketing/lead-forms/recovery/run`.
   - Administrator or CEO only; `canRun` tells the client whether to offer it.
   - Send an empty body. Any field is refused with a 400.
   - If a check is already running it returns **409 `alreadyRunning: true`**.
     That is an answer, not an error to retry.
4. **Channel directory:** the Google Ads states may now carry the more precise
   codes `CHANNEL_OAUTH_UNAVAILABLE`, `CHANNEL_API_ACCESS_UNAVAILABLE`,
   `CHANNEL_ACCOUNT_BINDING_UNAVAILABLE` and `CHANNEL_API_VERSION_REJECTED`. They
   map onto the existing `access_refused` and `unavailable` states.

## For the administrator (external prerequisite, not code)

Google sunset developer tokens on **9 September 2026**. API access now belongs to
the **Google Cloud project that owns GRAV's OAuth client**.
- Access was carried over automatically only "based on recent API activity".
  GRAV was calling v18, so that cannot be assumed.
- Someone must confirm in Google Cloud that this project has production access
  (Explorer or above).
- `GOOGLE_ADS_DEVELOPER_TOKEN` is no longer required or sent.
- The lead-form capability names this prerequisite rather than hiding it behind
  "creation not built".

## Files

| File | Change |
|---|---|
| `constants/marketingGoogleAdsApi.js` (new) | supported versions + sunset months, `SELECTED_VERSION = v25`, the only Google Ads URL builder, `ROLE_TO_RESOURCE` |
| `services/marketing/channels/googleAdsErrors.js` (new) | `GoogleAdsFailure` → six GRAV access states; `versionedBase` |
| `services/marketing/channels/googleAdsClient.js` | v25; no developer token, no `pageSize`; v25 field names; campaign keyset paging; real resources in `readDeliveryStates` (budget reported separately); budget read via `campaign`; lead read with whole-day bounds |
| `services/marketing/channels/googleSearchBundle.js` | v25; no `requestId`, no developer token; per-operation v25 field allowlist; EU-declaration assertion; int64 as strings; no temporary names on composite resources |
| `services/marketing/channels/channelHttp.js` | optional `classify` hook for provider error bodies |
| `services/marketing/channels/channelSecrets.js` | developer token neither required nor read |
| `services/marketing/channels/channelDirectory.service.js` | new codes → existing states |
| `services/storePurchase/errors.js` | four new `CHANNEL_*` codes (additive) |
| `services/marketing/deployment/googleSearchMapper.js` | `startDateTime`/`endDateTime`, `totalAmountMicros` for lifetime budgets, ad-group bid level fixed, EU declaration required |
| `constants/marketingGoogleSearchDeployment.js` | `EU_POLITICAL_DECLARATION_TO_GOOGLE`, new mapping code |
| `models/…/MarketingCampaignDraft.js`, `campaignDraft.service.js` | `euPoliticalAdvertising` on the Google brief |
| `services/marketing/leads/leadReconciliation.service.js` | rewritten: `reconcileCompany` (the one reconciler), company lease, per-page already-held lookup, bounds, attention reasons, `status()` |
| `services/marketing/leads/leadReconciliationScheduler.js` (new) | bounded hourly cycle |
| `models/…/MarketingLeadReconciliationLease.js` (new) | one run per company |
| `models/…/MarketingLeadReconciliationState.js` | stored page token removed; `attentionReason`; richer public view |
| `constants/marketingLeadProcessing.js` | `ATTENTION_REASONS`; bounds for v25 paging |
| `routes/CMS_Routes/Marketing/leadRecovery.js` (new) | the two routes |
| `server.js` | mounts the router; registers the reconciliation interval beside the (separate) internal sweep |
| `constants/marketingCampaignCapabilities.js` | `needs`: paused creation, the Cloud-project prerequisite, and real-delivery confirmation |
| `docs/decisions/google-ads-api-v25.md` (new), `google-lead-form-verified-contract.md` | decision records |

## Tests changed, and why each one was out of date

| Test | Change | Why |
|---|---|---|
| `advertising-channels`: "ordinary marketer …" | blanks `GOOGLE_ADS_REFRESH_TOKEN` instead of the developer token | the developer token is no longer required |
| `advertising-channels`: two cursor tests | assert `LIMIT n+1` and the `campaign.id >` keyset | v25 refuses page sizes |
| `google-search-deployment` test 14 | URL `/v25/` | version |
| `google-search-deployment`, `deployment-readiness` fixtures | `euPoliticalAdvertising: "does_not_contain"` | required by Google; never defaulted |
| `google-lead-recovery` §2–3 | rewritten against `reconcileCompany`, and a new-row bound test added | no stored page token; one reconciler. The client-read tests moved into the contract suite |

## Verification

| Suite | Result |
|---|---|
| `google-ads-v25-contract` (new) | **30 / 30** |
| `google-lead-reconciliation-ops` (new) | **17 / 17** |
| `google-lead-recovery` (3C) | **26 / 26** |
| all Google Lead Form suites + contract | **195 / 195**, 8 suites |
| `test/marketing` (full) | **1466 passed / 1466 total**, 35 suites. Baseline 1420, +30 contract, +17 ops, −1 net in recovery (2 client tests moved out, 1 bound test added) |
| `test/crm` + `test/sales` (serial, `--runInBand`) | **42 failed / 792 passed / 834 total**, 9 suites — exact baseline match |
| `npm test` (node:test services) | 1904 / 1905. The one failure is `services/salesJourneyOutcome.test.js` ("advancing clears the hold": expected `poContract`, got `purchaseInvoice`). It depends on `salesJourneyProgress` and `constants/crm.js`, which were already modified in the working tree by concurrent Sales work. 3C.1 touched neither. |

Nothing committed.

# Campaign Plan review and approval contract (2026-09-21)

Backend only; no frontend file edited. Nothing external is created or
activated. Nothing committed.

## What Lane B must change

### 1. Submit now requires the revision being submitted

```
POST /api/cms/marketing/campaign-drafts/:id/submit
{ "expectedRevision": <campaignDraft.revision the user is looking at> }
```

| Case | Answer |
|---|---|
| body missing `expectedRevision`, or not a whole number ≥ 1 | **400** `VALIDATION`, field `expectedRevision` |
| any other body field | **400** `VALIDATION`, `details.unknown` names it |
| plan changed since that revision | **409** `CAMPAIGN_DRAFT_REVISION_CONFLICT`, `details.currentRevision` / `sentRevision`. Reload and show the user what changed |
| a repeat of the accepted submission of that same revision (a double-click, or two people pressing Submit at once) | **200** with `duplicate: true` and the same plan |
| submitted meanwhile from a **newer** revision | **409** `CAMPAIGN_DRAFT_REVISION_CONFLICT`. What went for a decision is not what this user reviewed |
| plan incomplete | unchanged: **400** `VALIDATION` with `details.missing`, or `CAMPAIGN_DRAFT_ADVERTISING_INCOMPLETE` for an advertising plan |

The fence is atomic: the revision is part of the history reservation and of the
conditional update, so an edit and a submit racing on one revision can never
both succeed. **Enforced at the service boundary for every caller**: the
route, `scripts/marketing/seed-demo.js` and tests all pass it. There is no
unfenced branch and no state-only duplicate. See the follow-up below.

### 2. Readiness and Submit now agree

`GET …/deployment-readiness` → `approvalReady` is computed from the **same**
submission gate that Submit and Approve enforce (`deploymentReadiness.submissionGate`).
For the same `evaluatedRevision`, `approvalReady: true` ⇔ Submit accepts.

New plan-level findings, which appear in `sections.missingFromPlan`:
- `CONVERSION_GOAL_MISSING`, raised on **every** plan, email-only included. It is
  plan-level (`channel: null`) when no advertising channel already raised it.
- `PLAN_NAME_MISSING` and `OBJECTIVE_MISSING`, for legacy rows; creation
  already requires both.

`evaluatorVersion` is now `readiness-1.1.0`.

### 3. The plan detail says what THIS viewer may do

`GET /api/cms/marketing/campaign-drafts/:id` adds a `viewerActions` object:

```json
"viewerActions": {
  "evaluatedRevision": 4,
  "submittedByYou": false,
  "edit":    { "allowed": true,  "reasonCode": null, "reason": null },
  "submit":  { "allowed": false, "reasonCode": "PLAN_INCOMPLETE", "reason": "This plan is not ready for a decision yet. It still needs conversionGoal." },
  "approve": { "allowed": false, "reasonCode": "SELF_APPROVAL", "reason": "You submitted this plan, so approving it needs somebody else. You can still return or reject it." },
  "return":  { … }, "reject": { … }, "cancel": { … }
}
```

**Reason codes:** `NOT_AVAILABLE_IN_STATE`, `MARKETING_ONLY`, `APPROVER_ONLY`,
`PLAN_INCOMPLETE`, `SELF_APPROVAL`, `SUBMITTER_UNKNOWN`, `IDENTITY_UNVERIFIED`.

**Rendering rules:**
- Show each `reason` as-is.
- Send `evaluatedRevision` back as Submit's `expectedRevision`.
- Self-approval compares the signed-in user's **id** with the recorded
  submitter's id. Two people with the same name are different people. No id or
  email is ever published: only `submittedByYou` and the sentence.
- `viewerActions` is a courtesy. Every command re-checks role, state, gate and
  self-approval, so a forged "allowed" changes nothing.
- The existing `campaignDraft.availableActions` is unchanged. It describes the
  state machine, not the viewer.

## Files

| File | Change |
|---|---|
| `services/marketing/campaignDrafts/deploymentReadiness.service.js` | plan-level name/objective/goal findings; `submissionGate()` |
| `constants/marketingDeploymentReadiness.js` | `PLAN_NAME_MISSING`, `OBJECTIVE_MISSING`; `readiness-1.1.0` |
| `services/marketing/campaignDrafts/campaignDraft.service.js` | Submit fence (`expectedRevision`, `submittedFrom`); Submit and Approve use the gate; `selfApprovalProblem` shared by enforcement and `viewerActionsFor`; `detail({ user })` |
| `routes/CMS_Routes/Marketing/campaignDrafts.js` | Submit requires `expectedRevision` and refuses other fields; detail passes the viewer and returns `viewerActions` |
| `test/marketing/campaign-plan-review.test.js` (new) | 19 tests |
| `test/marketing/campaign-drafts.test.js` | the route helper sends the revision the user viewed on Submit, as a client does; the double-submit test sends the same revision twice; the company-B table sends a revision to Submit only |

## Verification

| Suite | Result |
|---|---|
| `campaign-plan-review` (new) | **19 / 19**: concurrent submitters, stale revisions, duplicate Submit, stale-after-resubmit, edit/submit race, email-only plans, self-approval, same-name users, unverifiable identity, no raw ids, company isolation |
| `campaign-drafts` + `deployment-readiness` | **260 / 260** |
| `test/marketing` (full) | **1485 passed / 1485 total**, 36 suites (1466 + 19) |
| `test/crm` + `test/sales` (serial, `--runInBand`) | **42 failed / 792 passed / 834 total**, 9 suites — exact baseline match |

## Follow-up: the fence at the service boundary (2026-09-21)

`campaignDraft.service.submit()` now requires a valid `expectedRevision` from
every caller.
- Missing, `null`, `undefined`, `NaN`, non-integer or `< 1` is refused as
  `VALIDATION` (`field: expectedRevision`) before the plan is read.
- The optional unfenced branch and its "already awaiting approval, so
  duplicate" answer are removed.
- Against an already-submitted plan, only a repeat of the exact revision that
  was accepted returns `duplicate: true`. Any other revision is
  `CAMPAIGN_DRAFT_REVISION_CONFLICT`, and so is a missing one, which is refused
  as `VALIDATION` first.

**Callers updated:**
- `scripts/marketing/seed-demo.js`: all three Submit calls pass the stored
  plan's current revision. A re-run may have moved it past 1.
- Service tests in `campaign-drafts`, `deployment-readiness`,
  `google-search-deployment`, `meta-deployment-foundation` and
  `meta-paused-creation`:
  - each passes the revision the plan actually has at that moment (2 after an
    edit, 5 after a return and re-edit, 1 for a retry of an interrupted
    submit);
  - no behavioural assertion was changed or removed;
  - the actor-unverified loop sends a valid revision, so the identity check is
    still the reason it refuses.

**New proofs** (`campaign-plan-review` 20–23) compare the stored plan document
and its complete history before and after:
- omitted, null or malformed revision: nothing written;
- stale revision on a draft (older or from the future): nothing written;
- an unfenced, null or post-submission revision on a submitted plan: refused,
  nothing written;
- the exact accepted revision: `duplicate: true`, nothing written.

| Suite | Result |
|---|---|
| `campaign-plan-review` + `campaign-drafts` + `deployment-readiness` | **283 / 283** |
| `test/marketing` (full) | **1489 passed / 1489 total**, 36 suites (1485 + 4) |
| `test/crm` + `test/sales` (serial, `--runInBand`) | **42 failed / 792 passed / 834 total**, 9 suites — exact baseline match |

Nothing committed.

# Google lead forms — paused creation, proof-account only (2026-09-21)

Backend only. No frontend file edited, nothing committed. `google_lead_form`
remains **not deployable**; decisions and what remains unverified are in
`docs/decisions/google-lead-form-paused-creation.md`.

## Lane B contract

### 1. Draft write (POST and PATCH, unchanged routes)

A Google brief may now say `campaignType: "google_lead_form"` and carry
`googleLeadForm`, beside the Search creative it still needs:

```json
{
  "channel": "google_ads",
  "campaignType": "google_lead_form",
  "googleSearch": { "headlines": ["…","…","…"], "descriptions": ["…","…"], "keywordThemes": ["…"] },
  "googleLeadForm": {
    "businessName": "GRAV Clothing",
    "headline": "Request a uniform quote",
    "description": "Tell us what your team needs and we will price it.",
    "callToAction": "GET_QUOTE",
    "callToActionDescription": "A written quote within two working days.",
    "privacyPolicyUrl": "https://grav.in/privacy",
    "postSubmitHeadline": "", "postSubmitDescription": "", "postSubmitCallToAction": "VISIT_SITE",
    "fields": ["FULL_NAME", "EMAIL", "PHONE_NUMBER"],
    "qualifyingQuestions": ["COMPANY_SIZE"]
  },
  "bidding": { "strategy": "target_cost_per_action", "target": { "amount": 450, "currency": "INR" } },
  "euPoliticalAdvertising": "does_not_contain",
  "…": "every other Search brief field, as before"
}
```

- PATCH still requires `expectedRevision`.
- `googleLeadForm` is accepted **only** on a `google_lead_form` brief.
- Unknown keys are refused by name. That includes `marketingConsent`, which is
  not offered on Google forms in this release, and anything shaped like a
  webhook URL, secret or provider id.
- Text is stored within GRAV's bounds (in `vocabulary.googleLeadForm.contentFields[].maxLength`).
  Google applies its own limits at the validate-only pass.
- `fields` and `qualifyingQuestions` hold up to 12 codes each, stored as given.
  The evaluator reports "asks six, Google allows five" rather than the write
  dropping one.

### 2. Draft read

`GET /campaign-drafts/:id` returns the brief exactly as stored, with
`googleLeadForm`, and `vocabulary.googleLeadForm`:
- `contentFields[]` `{ code, label, means, required, maxLength }`
- `contactFields[]` `{ code, label, selfReported, means }`
- `qualifyingQuestions[]` `{ code, label, question, category, selfReported }`,
  in Google's wording
- `maxQualifyingQuestions: 5`, `fieldExclusions`, `contactableFields`,
  `contactableMeans`
- `callToActionTypes[]` / `postSubmitCallToActionTypes[]` `{ code, label }`,
  Google's v25 enum values, **use these as a choice**, with `buttonLabelsMean`
- `answerProvenance`, and `marketingConsentOffered: false` with its reason

`GET /campaign-capabilities/google_lead_form` also carries:
- `localContract`;
- `controlledCreation: { available: true, means }`;
- the same `leadFormVocabulary`.

It is still `deployable: false` and has no settings.

### 3. Readiness (unchanged route)

`GET …/deployment-readiness` judges lead-form briefs with the one evaluator.
Submit and Approve enforce the same findings.
- `LEAD_FORM_INCOMPLETE` (blocking):
  - field `googleLeadForm.<check>` for the form checks;
  - field `bidding.strategy` when bidding is not `target_cost_per_action`.
- `LEAD_FORM_CONTROLLED_ONLY` (advisory, in `unsupportedByGrav`): says creation
  is limited to the proof account.
- Goals allowed: `form_submission`, `qualified_prospect`.

### 4. Deployment (existing routes, dispatched on the plan's own type)

| Route | Lead-form behaviour |
|---|---|
| `GET …/deployment/google_ads/preflight` | adds the checks `lead_form_definition`, `lead_form_serving_country`, `lead_form_controlled_account`, `lead_form_delivery_address`, `lead_form_delivery_key`; `conversion_action_present` is read and blocks; `externalChecksRequired[]`; `ifCreated.formStatus: "PAUSED"`. Never an address, token or secret. |
| `POST …/deployment/google_ads/create-paused` | administrator only; body `{ idempotencyKey, expectedRevision, targetingFingerprint? }`; **`expectedRevision` required**. Returns `outcome` (`succeeded`, `partially_created`, `failed` or `unknown`), `leadFormStopped`, `deliveryAddressConfirmed`, `deliveryBound`, `providerCampaignId`, `providerLeadFormId`, `deployment`, `delivering: false`, `activationAvailable: false`. |
| `POST …/deployment/google_ads/reconcile` | the recovery path after `outcome: "unknown"`; read-only against Google |
| `GET …/deployment/google_ads` | the deployment (`campaignType: "google_lead_form"`) and its attempts |

There is no activate, publish or schedule route. None is planned in GRAV.

## Verification

| Suite | Result |
|---|---|
| `routes/CMS_Routes/Manufacturing/Return/returnRequestRoutes.js` | unchanged behaviour; no edit was needed for these corrections |
| `scripts/migrations/work-order-number-backfill.js` | one-pass `_id` cursor; injectable batch size; quiesced-window warning in the header and at apply time |
| `test/project-manager/return-barcode-identity.route.test.js` | route-wiring capture block added (14 tests, was 9) |
| `test/project-manager/work-order-number-migration.test.js` | exactly-once, retry-on-later-run, multi-page and deployment-warning tests (26, was 21) |
| 3 documentation files | §13 rewritten |

### 1 — The route is now proven to use the corrected builder

`assignedBarcodeIds` is discarded by mongoose, so no persisted field reveals
which builder ran, and the previous suite called the helper itself — a route
that regressed would have stayed green. The tests now intercept
`EmployeeProductionProgress.findOneAndUpdate`, capture the update **before**
mongoose strips the field, and call through so persistence is still exercised.

**Proof:** reverting the route to `${woDoc.workOrderNumber}-${unit}` fails the
four route-wiring tests while all ten helper-level tests stay green.

### 2 — Each candidate gets exactly one outcome per run

The loop re-selected the first N numberless records every iteration, so a
**failed** record — still numberless — reappeared and was counted again
whenever a batch-mate succeeded. Now paged on a stable `_id > lastId` cursor
that advances before each write.

`examined === written + skipped + failed`, the three sets are disjoint, a failure
is not retried within the run, and a later run retries it. **Proof:** restoring
the old loop fails the exactly-once test; the new one passes with one success,
one concurrent skip and one thrown failure at `batchSize: 1`.

### 3 — The race limitation is stated honestly

See the corrected paragraph above. Structural assertions pin the warning.

### 4 — Accurate barcode inventory

5 building paths, 8 persistence sites, 4 still building from `workOrderNumber`,
**all 8 discarded**. Stated by behaviour and context name, not line number.

### Verification

- `return-barcode-identity` **14/14** · `work-order-number-migration` **26/26**
- `work-order-identity` 29/29 · planning characterisation 62/62
- `test/project-manager` — **297/297**, 10 suites (baseline 287)
- `test/requests` + `test/access` + `test/store-purchase` — **813/813**, 24 suites
- `node --check` clean; `git diff --check` clean in both repositories
- **The migration was not executed.** No index created or removed.

---

## Project Manager professionalisation — Chunk 4B-D (3 Sep 2026)

**Decision package only.** No application code, model, route, test, migration,
frontend file or database was changed. Chunk 4B implementation has **not**
started and must not until the questions below are answered.

**Document:** `docs/decisions/project-manager-work-order-planning-lifecycle.md`
— status **PROPOSED — awaiting user approval**.

### What the evidence changed

Option C (additive `planningState`) + Option A (derive rather than duplicate)
**remains recommended**, and two findings from the full writer/reader inventory
made it stronger or sharper:

- **Schedule placement is already stored separately.** `productionScheduleRoutes`
  and `salesScheduleRoutes` push into `ProductionSchedule.scheduledWorkOrders[]`
  and **never touch `WorkOrder.status`**. Option A is describing the existing
  data model, not proposing a change.
- **Production start is already scan-driven.** `productionSyncService` moves a
  work order to `in_progress`/`completed` from barcode evidence and stamps
  `timeline.actualStartDate`, independently of the `start-production` button. So
  "released" can gate the *button*; it cannot gate the floor. Any design that
  treated a button press as the definition of "started" would contradict a
  service already running in production.

Also established: **nine** distinct `WorkOrder.status` writers across five
applications including the vendor portal in a separate repository;
`ready_to_start`, `paused` and `delayed` are **written by nothing**; and **no
reader distinguishes `planned` from `scheduled`** except the start gate and one
counter — which is what makes an additive axis cheap.

### Contents

Evidence inventory · current contradictions · A/B/C/D comparison · planning-state
definitions · 16-row transition matrix · derived-fact authority table ·
orchestration contract for `POST /:id/plan` · conservative legacy classification
with an explicit `unknown` review queue · compatibility matrix · **14 questions
requiring approval** · rejected alternatives · post-approval sequence ·
rollback and observability.

### Not approved, not implemented

No `planningState` field exists. No transition guard exists. No migration was
written or run. `docs/tasks/current-task.md` untouched; no new active task.

---

## Chunk 4B-D — decision package corrections (3 Sep 2026)

Nine internal contradictions corrected before the package goes for approval.
**Documentation only.** No application code, model, route, service, test,
migration, dependency, frontend file or database was touched. Status remains
**PROPOSED — awaiting user approval**; Chunk 4B has **not** started.

### What was wrong, and what it is now

1. **Writer counts contradicted themselves** ("six, across five applications"
   above nine rows). Now four explicit measures: **9** mechanisms, **12**
   route/service functions, **5** execution contexts, **10** HTTP endpoints
   (W8 is a cron with none), broken down by owner.
2. **`unknown` vs a four-value vocabulary.** The persisted axis now carries
   **five** values. **Verified, not assumed:** a Mongoose schema `default`
   hydrates a legacy document with no stored value as `"not_started"` through
   the ORM while `.lean()` shows it absent — two readers, two answers. So **no
   schema default** is proposed; new work orders get `not_started` from an
   `isNew` invariant (the 4A.2 mechanism), and every reader maps **absent →
   `unknown`**. `unknown` blocks release, needs an approver classification with
   a reason, and is in the review queue.
3. **"All-or-nothing without transactions" was impossible.** **Measured:** the
   test database is a **standalone** and `withTransaction` fails with
   *"Transaction numbers are only allowed on a replica set member or mongos."*
   Three implementable options are set out; **Option 2 recommended** — the first
   orchestration endpoint plans a single document, splitting stays on its
   existing route, and atomicity is then true without qualification.
4. **Scheduled re-planning ignored the calendar.** Now: a work order with active
   ProductionSchedule membership **cannot** re-enter planning; it must be removed
   through the existing scheduling authority first; no planning route ever
   deletes a segment; unresolvable membership **fails closed** into a review
   state.
5. **Derived facts were vacuous.** Every rule is now total, with `unavailable`
   distinct from `false`: empty vs malformed BOM, mixed allocated/issued,
   accepted shortage, empty/malformed/duplicate/zero-duration operations, and a
   `canStartProduction` that includes **the existing status gate** it previously
   dropped. `productionStarted` defines precedence and surfaces contradictions
   as exceptions.
6. **Scan bypass** is now an explicit policy exception — never silently
   released, no fabricated timestamps, visible in observability and the PM
   queue. *(Superseded: this pass named it `scanStartedWithoutRelease`. It was
   generalised in the 4B-D package to `productionStartedWithoutRelease` with a
   `source` dimension, once W10 manual marks were found to write the same
   ledger.)* **Visibility-only
   recommended first**; enforcing at ingestion could stop the floor.
7. **Vendor interaction** specified: forwarding preserves `planningState`;
   vendor writes touch the execution axis only and can never overwrite the
   planning axis; returning work internally needs an explicit transition. The
   separate vendor repository is untouched.
8. **Authorization is route-specific**, never router-wide — a blanket guard
   would break Production Supervisor, Store, vendor and scan writers on the
   shared router. Existing callers were searched: only the two PM planning
   surfaces call the planning routes.
9. **Approval checklist normalised** to one consecutive table of **15**
   decisions, each with recommendation, alternative, compatibility consequence,
   implementation consequence and default. Two have **no default** and must be
   answered: the `unknown` treatment's review owner, and who owns the queue.

### Verification

All eleven required consistency checks pass. 4A.2 focused tests re-run as a
no-regression baseline: **297/297**, 10 suites. `git diff --check` clean in both
repositories. `planningState` appears in **zero** application files.

---

## Chunk 4B-D — decision package, second correction pass (3 Sep 2026)

Nine further contradictions corrected. **Documentation only.** Status remains
**PROPOSED — awaiting user approval**; Chunk 4B has **not** started.

1. **Writer arithmetic reconciled — and a writer was missing.** The owner
   breakdown summed to 11 against a claimed 12. Re-checking the code found
   `POST /:id/work-orders/:woId/mark-stage` (the PM *Mark Production* action)
   writes `WorkOrder.status` and had never been inventoried. It is now **W10**.
   Reconciled: **10** mechanisms · **12** functions · **5** execution contexts ·
   **11** HTTP endpoints (W8 is a cron with none). One apparent writer was a
   false positive — `status: "forwarded"` in `GET /stats/overview` is a
   `countDocuments` filter.
2. **Legacy classification is now mutually exclusive.** The table of independent
   rules overlapped: an `in_progress` record with no planning evidence matched
   both `not_started` and `unknown`. Replaced with an **ordered first-match-wins
   decision tree** (13 rules) in which execution, exceptional-status, vendor and
   scheduling evidence all precede the "no planning evidence" conclusion.
   Schedule membership is read before classification and an unavailable lookup
   **fails closed to `unknown`**. A truth table demonstrates the sixteen
   previously overlapping cases, each now claimed by exactly one rule.
3. **Atomicity honest about the complete write set.** Removing the split did not
   make the endpoint atomic — an idempotency receipt, planning history and a
   `ChangeLog` event are also required, and `ChangeLog` is a separate
   collection. Now: the domain mutation, receipt, replayable result and outbox
   event are **embedded on the WorkOrder and commit together**; the `ChangeLog`
   entry is **projected** from the durable outbox, explicitly **not** part of the
   commit, observable and retryable, and never able to erase the canonical event.
   Bounded retention specified for receipts and outbox entries.
4. **`unknown` exits by classification, not reopen.** New transition 17
   (`planning.classified`, approver-only, reason plus the destination's own
   evidence, cannot classify to `released`). Transition 16 now refuses `unknown`
   with `409 UNKNOWN_REQUIRES_CLASSIFICATION`.
5. **All four legacy planning routes specified**, including `bulk-plan`, which
   **must not mark work `complete`** — it validates no material line and no
   operation time, so it sets `in_progress` only. No route may downgrade
   `complete` or `released`.
6. **`productionStarted` is no longer self-contradictory** — three dimensions
   (`state`, `startedAt`, `exceptions`), so a real timestamp establishes a start
   *and* an incompatible status adds `startedButNotInProgress`. Exceptions never
   erase execution evidence.
7. **Scheduling eligibility explicit.** `not_started` and `in_progress` are
   schedulable. `unknown` is schedulable **until the backfill and review queue
   are resolved** — otherwise an additive field would break every legacy
   scheduling client on day one, since absent projects as `unknown`.
8. **Shortage evidence is structured** — required non-empty reason, actor,
   timestamp and the short lines, written inside the same atomic mutation, never
   implicit in `planningNotes`. A recorded shortage still leaves `materialsReady`
   **not ready**.
9. **Approval decisions de-duplicated.** 2 is now the `unknown` *policy*; 15 is
   the named *owner*. Fifteen consecutive rows, and **only 15 has no default.**

### Verification

All ten required checks pass: arithmetic reconciles; every classification case
receives exactly one outcome; no surviving "atomic"/"partial failure" claim
contradicts the write set; classification and reopen are distinct; all four
legacy routes addressed; production start carries evidence and an exception
together; approval rows consecutive 1–15 with one default-less row;
`planningState` appears in **zero** application files; focused Project Manager
baseline **297/297**, 10 suites.

---

## Chunk 4B-D — decision package, final correction pass (3 Sep 2026)

Eight corrections. **Documentation only.** Status remains **PROPOSED — awaiting
user approval**; Chunk 4B has **not** started.

1. **W10 integrated throughout, not just counted.** `mark-stage` writes the
   **same** `ProductionCompletionScanRecord` ledger as a device scan, labelled
   `scannedBy: "<actor> (manual mark)"` — verified in code. It now appears in
   the derived facts (`productionStarted` gained a **`source`** dimension:
   `scanner` | `manual_mark` | `unknown`), the transition matrix (**18**
   transitions), the bypass policy, authorization, observability, the rollout
   sequence and decisions 9 and 12. The exception is generalised to
   **`productionStartedWithoutRelease`** — a manual mark is never reported as a
   device scan. **Visibility-only applies to W10 exactly as to W8**: blocking it
   first would remove the manual backup flow used when scanners fail. Its
   capability is **direct, never held** — the route is not replay-safe.
   *(Superseded: this pass gave the reason as "a replayed hold would
   double-count production". That is wrong — production, QC and packaging are
   capped targets. The route is not replay-safe because its **dispatch** stage
   is incremental; see the 3 Sep 2026 entry below and lifecycle decision §9.3.)*
2. **No legacy record may be backfilled to `released`.** `released` is an
   explicit approver decision with `releasedAt`/`releasedBy`; no legacy record
   contains one, and `in_progress` + `plannedAt` proves work *began*, not that
   anyone authorised it. The backfill assigns it to **zero** records,
   classification cannot choose it, and only the post-cutover release transition
   creates it. Observability should therefore expect
   `productionStartedWithoutRelease` to **start high and fall**, not to be near
   zero on day one.
3. **`plannedAt` is no longer proof of validated completion.** The legacy
   `complete-planning` validated neither materials nor operations, so its
   timestamp is a *completion claim*, not verified completion. A record reaches
   `complete` only when its **current** evidence satisfies the new total rules;
   a claim without that evidence goes to `unknown` with
   `legacyCompletionUnverified`.
4. **"No materials required" needs affirmative evidence** — a recorded BOM
   snapshot with zero required lines, or an explicit `noMaterialsRequired`
   decision. An empty array without proof is **unavailable**, never ready, so
   such a record cannot reach `complete` and goes to review.
5. **Idempotency retention is honest.** A capped list cannot promise unbounded
   replay safety, so the promise is a documented **7-day window** ("the greater
   of 20 receipts or everything within 7 days") with an explicit client
   contract, plus a deterministic **atomic claim rule** for concurrent requests.
6. **Audit authority after archival is unambiguous.** Unprojected events are
   **never evictable**; projection is confirmed by stable event id; eviction is a
   separate later operation; once evicted, **`ChangeLog` is the canonical
   archive** for those events — it is no longer described as both a convenience
   index and the sole surviving copy.
7. **Authorization table completed** — `bulk-plan`, classify, manual
   `mark-stage`, release and reopen each carry an exact capability and a mode
   (direct / held / visibility-only). Never router-wide.
8. **Internal defects cleaned** — the opening note points at **§13**, the
   duplicated `To` row is gone, transition counts reconcile, and no "scan"
   wording silently excludes manual marks.

### Verification

All ten checks pass: W10 appears in seven sections beyond the inventory; the
only mention of assigning `released` is the rule forbidding it; `verified
completion` replaces `plannedAt` throughout; unproven empty materials are
`unavailable`; the 17-rule tree and 20-row truth table give one outcome each;
concurrency is deterministic; unprojected events are non-evictable;
cross-references reconcile; `planningState` remains in **zero** application
files; Project Manager baseline **297/297**, 10 suites.

---

## Chunk 4B-D — decision package, closing cleanup (3 Sep 2026)

Four narrow corrections. **Documentation only**, no design expansion. Status
remains **PROPOSED — awaiting user approval**; Chunk 4B has **not** started.

1. **W10 replay semantics corrected.** *(This item was itself over-corrected;
   the accurate version is the 3 Sep 2026 entry below.)* Verified in code that
   `mark-stage` treats `quantity` as a **capped target** for production, and
   that QC and packaging are monotonic in the same way — so the
   "every replay appends units and double-counts production" statement is wrong
   and was removed from the inventory, transition 18, the authorization table
   and decision 12. **The replacement claim, that an identical repeat of the
   whole route is a no-op, was also wrong** — it overlooked the dispatch stage.
   It keeps a **direct** route-specific capability.
2. **The unreleased-start exception is durable, not derived.** A comparison of
   *current* `planningState !== released` would turn false the moment someone
   released the work, erasing the history. It is now an **appended immutable
   event** recording source, evidence identity, observed timestamp, WorkOrder id
   and the planning state at that moment. A later release may **resolve** it but
   never delete or rewrite it; appending must never reject a valid scan or
   manual mark; and a reconciliation pass backfills a missing event from
   execution evidence. Observability now distinguishes **historical occurrences**
   (immutable, only grows), **unresolved exceptions** (should fall) and
   **new-occurrence rate** (should fall) — "should fall" no longer applied to the
   historical total.
3. **W10's partial-write boundary characterised.** It writes three documents in
   sequence with **no transaction**: `ProductionCompletionScanRecord` →
   `WorkOrder` → `EmployeeProductionProgress`. A later failure leaves earlier
   evidence committed. **Characterisation only** — 4B does not redesign the
   route, nothing calls it atomic, ledger evidence stays authoritative, and
   reconciliation must detect disagreement between the three.
4. **Stale text removed** — the recommendation now names both device scans and
   manual marks; the authority table says execution-ledger evidence with both
   sources; §11 says **four** existing routes; the rule count is recalculated
   for the 17-rule tree (**8 deterministic + 9 review = 17**, disjoint); the
   duplicated `shortageAccepted` row is gone; all transition counts say **18**.

### Verification

All ten checks pass: the only remaining "double-count" mentions are the
corrections themselves; a later release cannot erase
the historical event; the three-write boundary is stated; rule arithmetic is
disjoint and complete; no duplicate shortage row; counts reconcile;
`planningState` remains in **zero** application files; Project Manager baseline
**297/297**, 10 suites; `git diff --check` clean in both repositories.

## Chunk 4B-D — decision package, W10 dispatch correction (3 Sep 2026)

**Documentation only.** Status remains **PROPOSED — awaiting user approval**;
Chunk 4B has **not** started. This pass corrects the *previous* correction.

1. **`mark-stage` is not replay-idempotent — because of dispatch.** Re-read
   stage by stage from the route:

   | Stage | Computation | `quantity` | Identical repeat |
   | --- | --- | --- | --- |
   | Production | `cap(max(prodBefore, quantity))`, only the delta scanned | target | no-op |
   | QC | `min(prodAfter, max(qcBefore, quantity))` | target, capped by production | no-op |
   | Packaging | `min(qcCompleted, max(packBefore, quantity))` | target, capped by QC | no-op |
   | **Dispatch** | `min(quantity, packagedQuantity − alreadyDispatched)` | **additional amount** | **dispatches again** |

   `alreadyDispatched` is the sum of `bulkDispatchHistory[].quantity`, so each
   accepted repeat appends a new entry and eats into remaining availability;
   repeats stop only when packaged stock is exhausted, not because a duplicate
   was recognised. **Both earlier statements were wrong**: "a replayed hold
   would double-count production" (production is a capped target) and "an
   identical repeat is a no-op" (true of three stages, not the fourth).

2. **Effect of repeated dispatch on `EmployeeProductionProgress`** — only what
   the code proves. The production and packaging reflection loops are
   quantity-driven and skipped when their delta is zero, so a dispatch-only
   repeat does not touch them. The dispatch loop is driven by a per-employee
   **boolean**: it skips documents already `isDispatched`, and flags one only
   when the remaining delta covers that employee's **whole** `totalUnits`,
   appending a single `dispatchHistory` entry. So a repeated dispatch **can
   advance further, not-yet-dispatched records** — one whole allocation at a
   time — but cannot flag or re-append to the same document twice. A remainder
   too small for every remaining allocation is dropped: units land in
   `bulkDispatchHistory` with no employee record advanced, and the loop
   `continue`s rather than stopping, so a later smaller allocation can still be
   flagged out of `unitStart` order.

3. **Transition 18 and the authorization decision** now say the capability is
   direct because the endpoint contains a **non-idempotent dispatch operation**
   *and* crosses the non-transactional three-write boundary — not because
   production is double-counted.

4. **Retained unchanged:** the capped-target finding for production/QC/packaging
   (§9.3), and the three-write partial-failure characterisation (§9.1). The
   endpoint-access audit keeps its **"not idempotent"** classification, now with
   the dispatch reason spelled out so it is not read as the disproven
   double-count claim.

5. **The durable exception is keyed on new *production* evidence** (§9.2): a
   QC, packaging or dispatch repeat that adds no production is not a production
   start and appends no further `productionStartedWithoutRelease` occurrence.

6. **Contradictory historical prose marked superseded** rather than silently
   rewritten: the 4A-era `scanStartedWithoutRelease` name, the "replayed hold
   would double-count production" reason, the over-corrected "identical repeat
   is a no-op" entry, and the verification line that claimed
   `scanStartedWithoutRelease` appeared zero times (it appeared once, in the
   text now marked superseded).

### Verification

`planningState` in **zero** application files; Project Manager baseline
**297/297** across 10 suites; `git diff --check` clean in both repositories; no
`.js`, migration, schema, route, frontend or database change; no database
connection made.

## Chunk 4B-D — decisions 1–14 approved (3 Sep 2026)

**Approval recorded. No implementation.** No application code, model, route,
test, migration, frontend file or database was changed. Chunk 4B has **not**
started.

- **Decisions 1–14 accepted at their recommended defaults.** The "Default"
  column of §13 is now the accepted position for those rows. Notably: additive
  five-value `planningState` (1); persist `unknown`, approver-only Classify (2);
  refuse re-planning while scheduled / in progress / completed (3–5); explicit
  approver release (6); stored shortage-acceptance marker (7); no scheduling
  prerequisite yet (8); **visibility-only** production-without-release for both
  W8 scans and W10 manual marks (9); vendor forwarding preserves the planning
  axis (10); dead enum values kept (11); route-specific capabilities with a
  direct, never-held W10 manual-mark capability (12); **Option 2 — defer the
  split**, no transaction dependency (13); fix explicit zero operation duration
  (14).
- **Decision 15 — review-queue owner — is OUTSTANDING.** The approval message
  left the literal placeholder `[person or team name]` unsubstituted, so no name
  was supplied and none has been invented. Decision 15 has no default by
  construction.
- **What 15 blocks:** per §13, the legacy classification backfill cannot be
  signed off without a named owner, so that step of the §14 rollout is blocked.
  Nothing else is: the schema-additive work, the route guards, the orchestration
  endpoint and the observability work all depend only on decisions 1–14.

Status updated in the decision package header and §13, in
`docs/product/project-manager-professionalization.md`, and in
`docs/audits/project-manager-work-order-planning-integrity.md` §10.2. Earlier
dated handoff entries retain their original "PROPOSED" wording — they were
accurate when written and are not rewritten.

A stale count was corrected while updating the product doc: the writer inventory
is **ten** (`W1`–`W10`), not nine; the product summary still said nine.

## Chunk 4B.1 — additive planning-state foundation (3 Sep 2026)

**First implementation slice of the approved decision package.** The decision
package is now **partially implemented**, not complete: 4B.1 delivers the model
foundation only. Decision 15 is still unanswered, and **no backfill has been
approved, applied or dry-run.**

### Files changed (3 code, 3 docs)

| File | Change |
| --- | --- |
| `constants/workOrderPlanningState.js` | **New.** The five-value enum, its named constants, and `normalizePlanningState()`. Dependency-free — no mongoose, no models, no services — so the schema and the read side cannot drift apart. |
| `models/CMS_Models/Manufacturing/WorkOrder/WorkOrder.js` | Added `planningState` (enum from the constants module, **no default**, **not required**) and extended the existing `pre("validate")` invariant. |
| `test/project-manager/work-order-planning-state.test.js` | **New**, 27 tests. |
| `docs/product/project-manager-professionalization.md` | Corrected the "15 decisions required before any 4B code" gate. |
| `docs/audits/project-manager-work-order-planning-integrity.md` | Same correction, plus header status. |
| `docs/handoff/latest-implementation.md` | This entry. |

### The two design choices, and the evidence for them

**No schema default.** A default was added experimentally and measured: three
tests fail, because `findOne()` hydrates the default while `.lean()` shows no
stored field — so every legacy record would read as `not_started`, a positive
claim that planning had not begun. Absence is interpreted as `unknown` on
**read** instead. Reading never writes.

**One hook, not two.** The `planningState` invariant was folded into the
existing `assignCanonicalWorkOrderNumber` hook rather than added alongside it,
and the function renamed `assignNewWorkOrderInvariants`. Two `pre("validate")`
hooks would leave their relative order implicit. `validate` remains the event
because it is the only document hook `insertMany()` runs. Both invariants share
the single `isNew` guard, so no existing record is rewritten by an unrelated
save; removing the guard was verified to fail five tests.

An **explicitly supplied** value is never overwritten — including an invalid
one, which still fails validation rather than being silently replaced by a
valid-looking default.

### Verification

| Measurement | Result |
| --- | --- |
| PM baseline before | 10 suites / **297** tests |
| PM baseline after | 11 suites / **324** tests (+27, all new) |
| `work-order-identity` | 29/29, unchanged |
| Negative check — add a schema default | **3 tests fail** |
| Negative check — remove the invariant | **5 tests fail** |
| `node --check` on all 3 changed `.js` | clean |
| `git diff --check`, both repos | clean |
| `accountant` + `crm` + `hr-ai` pre-existing failures | 22 suites / **276** tests — **held constant** |

**The full backend suite is not a stable baseline right now.** Two consecutive
runs gave 23 suites/296 failures and 27 suites/318 failures, the *worse* run
being the one with all of this chunk's code removed. The Store/Purchase lane is
editing shared files concurrently. The one extra failing suite over the known
groups, `test/store-purchase/warehouse-master.route.test.js`, was proven not to
be ours: it references neither `WorkOrder` nor `planningState`, and fails
identically (13/114) with this chunk's model change stashed and restored.

### Scope held

`WorkOrder.status` untouched — the only `status` line in the model diff is a
comment. `planningState` appears in exactly two application files (the model and
the constants module) and no route, service, projection or frontend file. No
route contract, response field, migration, index, capability or database
changed; no real database was connected. Nothing was implemented from the
projection/derived-facts slice, the four legacy route transitions, `POST
/:id/plan`, guards, release/reopen/classify, shortage acceptance, schedule or
scan-ledger lookups, or `productionStartedWithoutRelease`.

## Chunk 4B.2A — pure planning facts (3 Sep 2026)

Sequence step 2, first half. The §7 facts derivable from **one WorkOrder
document**, as pure policy. **No database query, no route change.** External-
evidence facts are deferred to 4B.2B and are **not** partially implemented.

### Files changed (2 new code, 1 doc)

| File | Change |
| --- | --- |
| `services/manufacturing/planningFacts.js` | **New.** The pure module. Its only `require` is `constants/workOrderPlanningState.js` — no mongoose, no model, no router, no clock, no I/O. |
| `test/project-manager/planning-facts.test.js` | **New**, 97 tests, none touching a database. |
| `docs/handoff/latest-implementation.md` | This entry. |

4B.1's five-value enum, no-default schema and `isNew` invariant are untouched.

### Fact shapes

```
derivePlanningState(stored)
  → { value, origin: "stored"|"legacy_absent"|"malformed", storedValue, exceptions[] }

deriveMaterialsReady(rawMaterials, evidence)     // and deriveMaterialsIssued
  → { state, noMaterialsRequired, lineCount, exceptions[] }

deriveOperationsReady(operations)
  → { state, operationCount, zeroDurationDegraded, exceptions[] }

derivePlanningCompleteable({ materials, operations, shortage })
  → { state, materials, operations, acceptedShortage, exceptions[] }
```

`state` ∈ `ready` | `not_ready` | `unavailable`. Facts are **frozen objects, not
booleans**: an object is always truthy, so `if (fact)` cannot pass an
`unavailable` through a gate. `isReady()` / `isUnavailable()` are the safe reads.

### Truth tables as implemented

**Planning state** — `normalizePlanningState()` is unchanged and still answers
"what value to show". The richer projection additionally records **why**: a
legacy absence is the review queue's ordinary input, while a value outside the
enum is a defect. Both render `unknown`; only the second carries
`planningStateUnrecognized`. Collapsing them would bury a bad write inside the
legacy population.

**Materials** (`materialsReady` — satisfying set `fully_allocated` ∪ `issued`;
`materialsIssued` — satisfying set `issued`):

| Input | Result |
| --- | --- |
| non-empty, every line satisfying | **ready** |
| any `not_allocated` / `partially_allocated` (or, for issued, any non-`issued`) | **not ready** |
| empty **+** zero-line BOM snapshot, or a complete `noMaterialsRequired` decision | **ready**, `noMaterialsRequired: true` |
| empty **without** that evidence | **unavailable** |
| missing / not an array / malformed line / absent or unrecognised `allocationStatus` | **unavailable** |

Structural defects are checked across **all** lines before readiness, so an
`unavailable` is never downgraded to a `not_ready` that happened to match first.
A recorded shortage is **not a parameter** of these functions at all — that is
structural, not a rule someone can later relax.

**Operations:**

| Input | Result |
| --- | --- |
| ≥1 op, distinct ids, every duration positive and finite | **ready** |
| empty array | **not ready** — legible, not missing |
| missing / not an array / malformed entry | **unavailable** |
| missing or blank `_id`, or duplicate `_id` (compared by string) | **unavailable** |
| negative, `NaN`, `±Infinity`, numeric **string**, object, boolean | **unavailable** |
| duration missing | **not ready** |
| duration **zero** | **not ready** + `operationDurationZeroIndistinguishable` |

**Documented compatibility limitation.** §7 calls an *explicitly set* zero
**ready**. That is not implementable today: the sub-schema declares
`plannedTimeSeconds: { default: 0 }`, so a stored `0` cannot be told apart from
a field nobody filled in. Rather than guess, zero **degrades to not ready** and
sets `zeroDurationDegraded`. The schema default is **not** changed here — that
is decision 14, sequence step 4.

**Completeable:** operations must be ready; materials ready **or** a valid
accepted shortage; any `unavailable` input ⇒ `unavailable`. A shortage cannot
rescue unavailable material evidence — a shortage is a decision about *known*
short lines. **The shortage never rewrites `materialsReady`**, which stays
`not_ready` in the returned facts; it is reported separately as
`acceptedShortage`.

**Shortage marker** is validated whole against §11.2 and taken as an **input**,
not read from the document — the field does not exist on the schema yet
(decision 7, step 4), and adding it here would invent storage ahead of its
slice. A partial marker (blank reason, no actor, no timestamp, no lines) is
`shortageMarkerIncomplete` and buys nothing.

### The 4B.2B boundary

`REQUIRED_EXTERNAL_EVIDENCE` names each deferred fact with the evidence its
adapter must supply — `isScheduled`, `scheduledPlacement`, `productionStarted`,
`productionStartedSource`, `canStartProduction`,
`productionStartedWithoutRelease`, `hasPlanningExceptions`. Nothing is stubbed,
half-computed or defaulted.

### Verification

| Measurement | Result |
| --- | --- |
| PM baseline before | 11 suites / **324** |
| PM baseline after | 12 suites / **421** (+97, all new) |
| `work-order-planning-state` + `work-order-identity` | 56/56, unchanged |
| `accountant` + `crm` + `hr-ai` pre-existing | 22 suites / **276** — held constant |
| `node --check`, both new files | clean |
| `git diff --check`, both repos | clean |

**Negative regression proof** — each rule most likely to be "simplified" later
was broken and the suite caught it:

| Injected regression | Tests failed |
| --- | --- |
| empty array folded into `.every()` (the `[].every() === true` trap) | **13** |
| explicit zero guessed as ready (decision 14 pre-empted) | **2** |
| shortage allowed to rescue `unavailable` materials | **1** |

Restored: 97/97.

### Scope held

No schema, `WorkOrder.status`, planning writer, GET or mutation route, response
contract, capability, approval workflow, scheduling, scan ingestion, migration,
backfill, frontend, Lane B or Store/Purchase file changed. No database
connected; the new suite performs no query. `docs/tasks/current-task.md`
untouched. Decision 15 remains outstanding and does not gate this slice.

## Chunk 4B.2B — pure external planning evidence (3 Sep 2026)

Sequence step 2, second half. The §7 facts that need evidence from **outside**
the WorkOrder, still as pure policy over already-loaded data. **No MongoDB
query, no route.** 4B.1 and 4B.2A are untouched — `planningFacts.js` is
byte-identical and its 97 tests still pass.

### Files changed (2 new code, 1 doc)

| File | Change |
| --- | --- |
| `services/manufacturing/planningEvidence.js` | **New.** Requires only `./planningFacts` and the constants module — no mongoose, model, router, clock or I/O. |
| `test/project-manager/planning-evidence.test.js` | **New**, 122 tests, no database. |
| `docs/handoff/latest-implementation.md` | This entry. |

### Input shapes — every lookup carries an EXPLICIT success flag

```
scheduleLookup { ok, placements?: [ { scheduleId, scheduleDate?, segment } ], reason? }
ledger         { ok, entries?: [ { barcodeId, scannedAt, scannedBy } ], reason? }
eventStore     { ok, events?: [ { _id, source, observedAt, workOrderId,
                                  planningStateAtObservation, evidenceId, resolvedAt? } ], reason? }
```

An empty array cannot express "could not look", so the flag is mandatory. A
result with no `ok` boolean is itself `unavailable`. Locating this data is the
future adapter's job; this module never queries for it.

### Output shapes

```
deriveScheduleMembership(lookup)
  → { state: scheduled|not_scheduled|unavailable, placements[], placementCount, exceptions[] }
    placement: { scheduleId, scheduleDate, segmentId, scheduledStart, scheduledEnd,
                 position?, status?, isMultiDay?, dayNumber?, totalDays? }

deriveProductionStarted({ status, actualStartDate, ledger })
  → { state: started|not_started|unavailable, startedAt, source, exceptions[] }   // exactly as approved

deriveProductionSource(entries) → "scanner" | "manual_mark" | "unknown"

deriveCanStartProduction({ planningState, materialsIssued, status, productionStarted })
  → { state: allowed|blocked|unavailable, blockedBy[], unavailableBecause[], exceptions[] }

deriveUnreleasedStartOccurrences(store, currentPlanningState?)
  → { state: present|none|unavailable, occurrences[], occurrenceCount, unresolvedCount, exceptions[] }

deriveCombinedExceptions(facts)
  → { state: present|none|unavailable, exceptions[], count, unexaminedSources[] }
```

### Schedule truth table

| Input | Result |
| --- | --- |
| `ok: true`, zero placements | **not_scheduled** — a confident answer |
| `ok: true`, ≥1 valid segment | **scheduled**, every segment preserved |
| `ok: false` / no result / no `ok` flag / no placements array | **unavailable** + `scheduleLookupUnavailable` |
| `scheduleId` missing | **unavailable** + `scheduleReferenceMalformed` |
| segment missing, no `_id`, or unreadable start/end time | **unavailable** + `schedulePlacementMalformed` |

`WorkOrder.status` is **not a parameter** — membership is decided by placements
alone, and a status of `scheduled`, `ready_to_start` or `in_progress` passed
alongside cannot manufacture it. A multi-day work order keeps **every** segment
with its `dayNumber`/`totalDays`; nothing is collapsed to one arbitrary day. Only
established fields are exposed — no capacity, ownership or readiness is invented
even though the sub-schema carries adjacent fields (`exceedsCapacity`,
`colorCode`).

### Production-start truth table

| Evidence | state | startedAt | exceptions |
| --- | --- | --- | --- |
| valid timestamp + `in_progress` | started | timestamp | — |
| valid timestamp + `pending`/`planned`/`scheduled` | **started** | timestamp | `startedButNotInProgress` |
| ledger entries, no timestamp | **started** | `null` | `startedWithoutTimestamp` |
| `in_progress`, no timestamp, empty readable ledger | not_started | `null` | `inProgressWithoutEvidence` |
| no evidence, non-progress status | not_started | `null` | — |
| no timestamp + unreadable ledger | **unavailable** | `null` | `executionEvidenceUnavailable` |
| valid timestamp + unreadable ledger | **started** | timestamp | `executionEvidenceUnavailable` |
| non-null unreadable timestamp | malformed, not missing | | `actualStartDateMalformed` |

**Precedence, stated explicitly.** Execution evidence outranks status: a
timestamp or a ledger entry *establishes* a start, and a contradictory status
adds an exception beside that conclusion rather than overturning it. §7's
"ledger unreadable → unavailable" row assumes there is no timestamp — a valid
`actualStartDate` is independent evidence, so a failed ledger downgrades only
the **source** to `unknown`. A malformed timestamp likewise does not erase a
ledger-proven start.

**Timestamps are read, never coerced.** `new Date(true)` yields a
valid-looking 1ms-after-epoch Date out of a boolean; only a real `Date`, a
non-empty string or a finite number is considered, and it still has to parse.

### How manual marks stay distinguishable

W8 (`productionSyncService`) and W10 (`mark-stage`) write the **same**
`ProductionCompletionScanRecord` collection; W10 labels each entry
`` `${actorName} (manual mark)` `` ([manufacturingOrderRoutes.js:115]).
The label is read back, matched at the **end** of the string:

| Legible entries | source |
| --- | --- |
| all end with `(manual mark)` | `manual_mark` |
| all without the suffix | `scanner` |
| mixed | `unknown` |
| any entry's label unreadable (empty, blank, non-string, absent) | `unknown` |
| timestamp only, no ledger entries | `unknown` |
| genuinely not started | `null` |

Source ambiguity only ever blurs the **source**; it never erases the start.

### Start-eligibility truth table

All six approved conditions are evaluated and **every** failing one reported —
a disabled button needs all the reasons, not the first:

| Condition | Block code |
| --- | --- |
| `planningState === "released"` | `planningStateNotReleased` |
| `planningState !== "unknown"` | `planningStateUnknown` (reported *as well as* not-released: one needs a release, the other a human classification) |
| materials-issued ready | `materialsNotIssued` |
| status ∈ {`scheduled`, `ready_to_start`} | `statusNotStartable` |
| status ∉ {`completed`, `cancelled`, `forwarded`} | `statusTerminal` |
| not already started | `productionAlreadyStarted` |

Unavailable inputs report `materialsIssuedUnavailable`,
`productionEvidenceUnavailable`, `planningStateUnavailable`, `statusUnavailable`.
**`blocked` outranks `unavailable`**: a provably false condition is a definite
answer whatever else is unreadable. Neither ever reads as `allowed`.

**Schedule membership is deliberately NOT a prerequisite** — the approved
decision does not require it, and a test pins that an unscheduled or
lookup-failed schedule leaves the verdict `allowed`, so no new gate slipped in
behind the refactor.

### How historical exceptions survive a later release

`deriveUnreleasedStartOccurrences` **does not take the current planning state as
evidence** — structurally, not by rule. A derived
`planningState !== "released"` comparison turns false the moment someone
releases the work, and the violation disappears (§9.2). Occurrences arrive as
durable records or the fact is `unavailable`; **no occurrence is ever
manufactured from current state**, and an unreleased work order with a started
production but no event store reports `unavailable`, not `none`.

`currentPlanningState` is accepted for **display only**: it sets
`resolvableByCurrentRelease` on an unresolved occurrence. It never deletes,
rewrites or filters one. `resolved` comes from the event's own `resolvedAt`.
Malformed events (no `_id`, unreadable `observedAt`) → `unavailable` +
`unreleasedStartEventMalformed`. The event schema and writing path are **not**
added here — that is step 8.

### Combined exceptions

Fixed source order — `planningState`, `materials`, `materialsIssued`,
`operations`, `completeable`, `schedule`, `productionStarted`,
`unreleasedStarts` — so output is deterministic regardless of caller key order.
De-duplication is by **code + detail**, so a repeated identical contradiction
collapses while two durable occurrences (distinct `eventId`) both survive:
losing one would lose a historical violation. The accepted shortage is collected
**beside** the still-not-ready material fact.

`hasPlanningExceptions` is a structured fact, so **missing external evidence can
never render as a confident "no exceptions"**: unavailable or unsupplied sources
are named in `unexaminedSources` and the state becomes `unavailable`, while
whatever *was* found is still listed. An empty array with `state: none` requires
that every source was successfully examined.

### Verification

| Measurement | Result |
| --- | --- |
| PM baseline before | 12 suites / **421** |
| PM baseline after | 13 suites / **543** (+122, all new) |
| `planning-facts` + `work-order-planning-state` + `work-order-identity` | 153/153, unchanged |
| `planningFacts.js` vs accepted 4B.2A | **byte-identical** |
| `accountant` + `crm` + `hr-ai` pre-existing | 22 suites / **276** — held constant |
| `node --check` | clean |
| `git diff --check`, both repos | clean |

**Negative regression proof** — all four required mutations were injected,
demonstrated failing, and restored:

| Injected regression | Tests failed |
| --- | --- |
| `WorkOrder.status === "scheduled"` used as schedule membership | **2** |
| ledger lookup failure treated as an empty ledger | **7** |
| unreleased-start occurrence derived away after release | **3** |
| manual mark labelled as a scanner event | **6** |

Restored: 122/122. The schedule test was strengthened first — its original form
caught the regression only by function arity, so a behavioural assertion was
added that passing a status alongside still cannot manufacture membership.

### Scope held

No schema, route, response contract, planning writer, start-production
behaviour, scheduling behaviour, scan ingestion, durable event storage,
migration, backfill, frontend, Lane B or Store/Purchase file changed. No
database connected; the new suite issues no query. `WorkOrder.status` untouched.
`docs/tasks/current-task.md` untouched. Decision 15 remains outstanding and no
backfill work began.

## Visible Batch 3 — Products & BOM + Setup consistency (4 Sep 2026)

**Frontend only** (`/Users/risheeray/grav-cms`). No Chunk 4B work. No backend,
API, migration or database change. Existing APIs only.

### The problem

Six screens are SHARED — one component rendered under `/sales/dashboard`,
`/merchandiser`, `/production-supervisor` and `/project-manager`, given the
matching chrome by `AutoDashboardLayout`. The sharing is right and was
preserved; what leaked was identity. Every one of them hardcoded
`kicker="Sales"`, so a Project Manager on a PM URL, in the PM shell, with PM
navigation highlighted, read **"Sales"** above the title — and carried Sales'
vocabulary ("Size Configuration", "Registered Operations") for things the floor
calls something else.

### Files changed (8)

| File | Change |
| --- | --- |
| `components/pm/deptPageIdentity.js` | **New.** Department-aware `{kicker, title, sub, addLabel}` adapter. React-free so the existing `node --test` runner loads it. |
| `components/pm/deptPageIdentity.test.mjs` | **New**, 10 tests. |
| `app/sales/dashboard/stock-items/page.js` | Identity adapter; **table/grid toggle**; `countOrDash`. |
| `app/sales/dashboard/size-config/page.js` | Identity adapter. |
| `app/sales/dashboard/inventory-configurations/{units-packaging,registered-operations,warehouse,devices-machines}/page.js` | Identity adapter. |
| `.claude/launch.json` | Port corrected 3000 → 3001 to match `next dev -p 3001`. |

**No page was forked.** The five PM Setup routes stay one-line re-exports; a
sixth copy of each page was the alternative and was rejected.

### What changed on screen

- **PM:** "Products & BOM", kicker "Project Manager", sub naming variants,
  operations and the bill of materials work orders are planned from; **Add
  product** (still `RoleGate min="editor"`).
- **PM Setup titles now match the nav words** — Measurements, Units & packaging,
  Operations, Warehouses, Devices & machines — each with a one-line purpose.
- **Table/grid toggle** on the catalogue (table stays default). The grid shows
  image, name/reference, status, category and the three figures a planner opens
  this page for — variants, operations, materials — with the same View/Edit
  links and the same role gates as the row.
- **`countOrDash`:** an absent array renders **—**, an empty one renders 0.
  `item.operations?.length || 0` claimed "0 operations" for data never loaded,
  directly beside a warning telling the PM to go fix it.
- **Sales is untouched** — same titles, same subs, same "Add new product". Six
  of the ten tests exist to pin that.

### Verification

- New tests **10/10**. Full frontend suite **793 tests, 1 failure** —
  `components/store/catalogue-access/screens.test.mjs`, which asserts on
  `components/store/item-master/` (Store/Purchase lane, edited 08:17 today).
  Not ours.
- SWC parse clean on all 7 changed `.js` files. `git diff --check` clean.
- PM nav key resolution confirmed for all six routes (`products`,
  `size-config`, `units-packaging`, `operations`, `warehouse`,
  `devices-machines`).

### Blocker — browser verification could not be run

Two independent causes, neither ours:

1. **`components/DashboardLayout.js` does not parse — and it is committed.**
   Line 103 begins an orphaned array body (`{ section: "Desk" }, …` through
   `];` at 129) whose declaration was dropped in merge **d1224ca**
   (3 Sep, `origin/main` → `rishee_sales_frontend`). `withIcons` now sits where
   the declaration was. HEAD and the working tree fail identically; the file is
   unmodified, so this is on the branch, not in someone's editor. It poisons
   **every** department, because `AutoDashboardLayout` imports it — Sales 500s
   too. Left untouched: it is the PM shell owner's file, and the extracted
   `components/pm/projectManagerNavigation.js` already exports `PM_NAV`, so the
   intended end state is theirs to declare.
2. **No API and an auth wall.** Port 5000 answers as macOS AirPlay Receiver, not
   the CMS backend, and PM routes redirect to `/?next=…`. Populated, empty,
   refresh-failure and viewer-vs-editor states are unreachable without a backend
   and credentials regardless of (1).

Once (1) is fixed and a backend is up, the outstanding checks are the three
viewports, the data states and horizontal-overflow.

**Re-checked 4 Sep, later.** Blocker (1) is cleared — `DashboardLayout.js`
parses. Two *different* committed defects in the same lane's files now block
rendering, and browser verification is still not possible:

- `components/shell/FrostShell.js:511` calls `initialOpenGroups(nav, activeMenu)`
  but the file never imports it. The function exists and is already unit-tested
  (`components/shell/drawerGroups.js`, `drawerGroups.test.mjs`), so the fix is
  one line — `import { initialOpenGroups } from "./drawerGroups";`. The file is
  clean against HEAD, so this is committed. It throws inside the shell, so it
  takes down **every** dashboard page in every department.
- `app/project-manager/dashboard/production/manufacturing-orders/[id]/page.js:932`
  fails to parse (`Unexpected token` on `)}`). Also committed.

Blocker (2) is unchanged: port 5000 still answers as macOS AirPlay Receiver, not
the CMS backend, so the populated/empty/refresh-failure and viewer-versus-editor
states remain unreachable even with a working shell.

Batch 3 itself re-verified at that point: focused tests **10/10**, full frontend
suite **818/818** (the Store/Purchase failure noted above is fixed), SWC parse
clean on all 7 changed files, `git diff --check` clean.

## Visible Batch 3 — completed (4 Sep 2026)

Blockers cleared and browser verification done against intercepted read-only
fixtures. No backend work; the live API was never written to.

### Changes this pass

| File | Change |
| --- | --- |
| `components/DashboardLayout.js` | `const NAV = withIcons(PM_NAV)`. Removed the legacy array restored after merge d1224ca — it had reintroduced Dashboard, the Production/Desk section headings, "MF production schedule" and "Setting & Config". Visible nav is now the five entries: **Overview, Requests, Production, Pipeline, Setup**. All 13 `ICONS` keys still map; no icon import became unused. |
| `app/sales/dashboard/stock-items/page.js` | Fixed a real rendering bug found in the browser: the grid's warning printed a literal `—` because the escape sat in **JSX text**, not a string. Now a real em dash. The reference fallback (a valid string escape) was made a literal character too. |

`components/shell/FrostShell.js` — **no change needed**: the
`initialOpenGroups` import is already present at line 31. The MO detail page
parses clean, so per the brief it was left untouched.

### Browser verification (fixtures, zero mutations)

`NEXT_PUBLIC_API_URL` is **:5050** with a live backend; the code's `:5000`
default is what my earlier note wrongly assumed. Verification used a `fetch`
interceptor on :5050 that serves fixtures for GETs, answers `/api/auth/verify`
locally, and **refuses every non-GET with 405**. **Final mutation count: 0**,
with an empty mutation log — nothing was written to the live API.

Verified at **1440 / 768 / 375**:

- **PM Products & BOM** — kicker `PROJECT MANAGER`, title `Products & BOM`, the
  variants/operations/materials purpose line, five-entry nav with Production
  active, role-gated **Add product**, Refresh, Download Excel, KPI strip,
  completeness ring, search, category and status filters.
- **Table/grid toggle** — both render; grid shows image, name, reference,
  status, category and the Variants / Operations / Materials figures.
- **`—`, not zero** — the fixture's legacy row (no `operations`, no
  `rawMaterials` arrays) renders `Operations —` and `Materials —`.
- **States** — populated, empty ("No products found"), refresh-error (toast
  shown, existing rows **kept**), initial-error (heading and nav intact, no
  rows).
- **Links** — `/project-manager/products/stock-item-view/:id` and
  `/new-stock-item/:id`; department-scoped, no PM route hard-coded in shared
  content.
- **Setup** — Measurements, Units & packaging, Operations and Warehouses all
  render with the PM kicker, the correct title, a purpose line and the
  five-entry nav. No Sales heading anywhere under the PM shell.
- **Role gating live** — with the cached role at `viewer`, a Setup destination
  refuses with "This section needs Editor access"; owner-only Delete is absent
  at editor.
- **Sales route intact** — `/sales/dashboard/stock-items` keeps kicker `SALES`,
  title `Finished Products`, its original sub, "Add new product", Sales
  navigation and `/sales/dashboard/stock-items/...` links.
- **No horizontal overflow** at any of the three widths, in either view mode.

### Not verified

`devices-machines` would not render under fixtures — it throws inside its own
row rendering against synthetic machine data (first `warehouse.itemsCount`, then
further fields), and once React's boundary latches it survives soft navigation.
Five attempts with progressively complete payloads did not clear it. Batch 3
changed only that page's three `PageHead` props; its identity is covered by the
adapter's unit tests and the file parses clean. It remains unverified **in a
browser** under fixtures.

### Verification

Focused tests **30/30**; `npm test` **864/864**; SWC parse clean on all 10
touched or reported files; `git diff --check` clean in both repositories.

## Visible Batch 3 — Accounts design language applied (4 Sep 2026)

The earlier pass changed headings and vocabulary; it did not change how the
pages look. This one does.

### What now renders the Accounts language

Not an approximation — the PM path imports and renders the books' own
components, and reuses their class vocabulary verbatim:

| Accounts source | Used by PM |
| --- | --- |
| `components/accountant/ui/AcctPageSlab` | the page slab on Products & BOM and all five Setup pages |
| `SlabAction` / `SlabGhost` | Add product / Refresh / Export, in the slab |
| the invoices context strip (`rounded-inset` on `--surface-sunken`, 11px faint) | "Loaded · Showing · Filters" |
| the invoices control row (`frost-panel` + hairline + `rounded-card`, `p-3`) | search, category, status, Table/Grid, Clear filters |
| its segmented pills (`--surface-sunken` track, `--ink` active fill) | the view toggle |
| its table (sunken thead, `tracking-[0.09em]` uppercase, `px-3 py-2.5`) | the catalogue table |

This works without touching a single Accounts file because the slab's tokens
(`--slab`, `--slab-ink`) live on `.grav-ui`, which `FrostShell` already carries.

### Files

| File | Change |
| --- | --- |
| `components/pm/ProductCatalogue.js` | **New.** The whole PM catalogue in the Accounts silhouette. |
| `components/pm/SetupPageHead.js` | **New.** Department-aware head: slab for PM, `PageHead` everywhere else. |
| `components/pm/deptPageIdentity.js` | Added `slabSub` — a short label for the slab (its sub truncates); the full purpose sentence moved to the context strip. |
| `app/sales/dashboard/stock-items/page.js` | PM render branch; `clearFilters`; `loadedAt`; tabs hoisted so the slab leads. |
| the five Setup pages | `PageHead` → `SetupPageHead`, plus the icon imports it needs. |
| `components/pm/deptPageIdentity.test.mjs` | +2 tests (12 total). |

**Only the presentation forks.** Every fetch, handler, filter and role gate is
shared; Sales, Merchandising and Production keep the body they had.

### Judgement calls worth recording

- **"Loaded", never "as of".** The stock-items response carries no timestamp,
  so the strip stamps the client clock and says so. "As of" would claim the
  server vouched for the time.
- **Needs-attention is built from the loaded rows, not `stats.*.samples`.**
  The samples are names with no ids, so they cannot honour "every item links to
  a real product". The panel is labelled "on this page" for that reason.
- **Slab figures are dropped where a KPI strip already exists** (warehouse,
  devices, units, operations) — the books' own rule from
  `app/accountant/invoices`: a slab must not say the figures twice. Size-config
  keeps one figure because it has no strip.
- **Setup Add links still point at `/sales/dashboard/...`** because no PM
  add/edit routes exist. Left alone rather than pointed at a 404; it means an
  Add from PM Setup lands in the Sales shell. Flagged, not fixed — creating
  routes was not in scope.

### Verification

Screenshots at **1440 / 768 / 375** for Products & BOM and Setup. No horizontal
overflow at any width (`scrollWidth === innerWidth`); mobile switches to cards
at `md`. Sales re-checked at 1440: `SALES` kicker, "Finished Products", its own
KPI strip, completeness ring, toolbar, table and navigation — **no slab**.
Fixtures were read-only; **final mutation count 0**, empty mutation log.

`npm test` **907/907**. SWC parse clean on all 9 touched files.
`git diff --check` clean. `app/accountant/**`, `components/accountant/**`,
`app/accountant-ui.css` and `components/ceo/ui/**` are **untouched** (empty
`git status`).

**Not captured:** a live Accounts page for a side-by-side. The accountant shell
has its own onboarding/company gate and memoises its session verify, so it
bounces to `/onboarding` under fixtures. The comparison in this entry is
therefore component-level and exact — PM renders the same `AcctPageSlab` — not
photographic.

## PM shell — sidebar removed (4 Sep 2026)

The PM app had no desktop sidebar; below `deck` (1180px) its rail hid and a
288px full-height left drawer took over. That drawer is now gone for this
department only.

### Change

`components/shell/FrostShell.js` gains one opt-in prop, `railAtAllWidths`
(default **false**), alongside the existing `spreadNav` /
`collapsibleTopDrawerGroups` opt-ins. When set it drops the drawer, its scrim
and its toggle, and keeps the rail at every width.
`components/DashboardLayout.js` (PM) passes it. **No other department moves** —
removing the drawer globally would leave five shells with no navigation at all
under 1180px.

### Three follow-on defects the change exposed, each measured

1. **A `flex-1 deck:hidden` spacer stole half the bar.** It exists to push the
   controls right when the rail is hidden; with the rail visible it took 360 of
   720px at 1024 and pushed Pipeline and Setup off the end. Gated.
2. **The rail scrolls with a hidden scrollbar,** so a clipped entry was not
   merely off-screen but unreachable and unhinted — 549px of items in a 476px
   rail at 768 put Setup past the edge. It now **wraps** instead of scrolling.
3. **Five entries wrapped one-per-row on a phone**, making the header 194px.
   The rail now takes a full-width row of its own below `sm`: three rows, 167px.

### Sizing and margins after

| Width | Bar inset | Content inset | Nav | Drawer | Overflow |
| --- | --- | --- | --- | --- | --- |
| 1440 | 12px | 32px (`px-8`) | 5 items, 1 row | none | no |
| 1024 | 12px | 16px (`px-4`) | 5 items, 1 row | none | no |
| 768 | 12px | 16px | 5 items, 2 rows | none | no |
| 375 | 12px | 16px | 5 items, 3 rows | none | no |

The bar floats at a 12px inset by design (`mx-3` — "visible field/gap around
it"); content sits at 16/32px. Left as-is: the bar is deliberately not aligned
to the content edge, and its padding is shared by every department.

**Also:** the catalogue's table/cards switch moved `md` → `lg`. At 768 the
seven-column table needed 855px inside a 734px scroller; cards read better on a
tablet than a table you drag sideways.

### Verification

Sales re-checked at 1024: **drawer and hamburger still present**, page
unchanged. `npm test` **916/916** — this included updating
`components/shell/drawerGroups.test.mjs`, which asserted PM passes
`collapsibleTopDrawerGroups`; that prop configured a drawer this department no
longer has. The rule it protected (opt-in, nobody by accident) is still checked,
now for `railAtAllWidths`, plus a new test that the other five keep their
drawer. The unrelated failure in the Store lane's new `nav.test.mjs` was proven
theirs — it reproduced with my changes stashed — and they have since fixed it.
SWC parse clean; `git diff --check` clean.

## PM shell — the left department rail removed (4 Sep 2026, corrected)

### I removed the wrong thing first

The earlier entry removed PM's **mobile drawer**. The screenshot showed the
target was the **64px department rail down the left edge** — HR, Executive,
Production, Sales, … — rendered by `components/shell/AppShell.js`, above
FrostShell in the tree. That earlier change is **reverted**: `railAtAllWidths`
is gone from FrostShell, and PM has its drawer back, so its shell now matches
Accounts exactly rather than being bespoke.

### The change

`AppShell` already has `RAIL_HIDDEN_PATHS` — eight apps opted out before this,
each on one stated condition: the app's own shell must carry FrostShell's
`appLogoSlug`, so "Back to apps" survives the rail going.

- `components/DashboardLayout.js` — `appLogoSlug="project-manager"`.
- `components/shell/AppShell.js` — `/project-manager` added to
  `RAIL_HIDDEN_PATHS`.

Exactly the arrangement `/accountant`, `/store`, `/hr` and `/budget` use. The
list is an explicit allowlist, so no other department can be affected.

### Verified

At 1440: rail gone, `g-shell-body--full`, body `x=0 w=1440`, header inset 12px,
five nav entries, no overflow. The **"Switch application"** control sits at the
far left of the top bar and opens listing the other departments. At 768: rail
gone, drawer and hamburger restored (as Accounts has them), no overflow.

`npm test` **921/921**. SWC parse clean; `git diff --check` clean.

### Two things worth recording

- **`git checkout` on FrostShell wiped an uncommitted fix.** Reverting my change
  restored HEAD, which is still missing the `initialOpenGroups` import another
  lane had added in the working tree — the app crashed until I put that line
  back. HEAD remains broken for anyone who checks it out fresh.
- **The drawer peeks 64px when closed.** Its `<aside>` measures `x=-224` with
  `width: 288` and `transform: none` — `-translate-x-full` is not applying.
  **Sales measures identically**, so this predates and is unrelated to this
  change; it only became visible in PM again because the drawer came back. Left
  alone: it is in FrostShell, shared by ten departments.

## Field tracking rebuilt as an evidence tool; WhatsApp templates shown as messages (6 Sep 2026)

Explicit request: the tracking map "is not representing any strong thing or
like any evidence or like proper logs which helps the owner"; "minimum 20
features"; and in Contact Logs, template messages must show "like a normal
message", not a "Template · name" chip over "Sent the X template".

### The change — backend

- `services/whatsappTemplates.js` (new): cached WABA template list;
  `renderStoredText()` turns the two legacy `[template: name]` rows into the
  template's real body (`{{n}}` → `…`). `whatsappSend.js` resolves a missing
  `bodyText` from it so no new placeholder row can be written;
  `routes/CMS_Routes/Sales/whatsapp.js` maps thread, conversation-preview and
  for-lead reads through it. Stored rows are not rewritten.
- `routes/fieldTracking.js`: `/sessions?from&to`, `/summary` (one row per
  person per IST day, with visits and roster-matched calls), `/session/:id/calls`
  (salesAuth; joins SalesPerson.employeeCode → normalizedPhone →
  CallEvent.normalizedOwnerPhone), `PATCH /session/:id/notes`, zones CRUD,
  visits upsert/list/delete (keyed session+stopFrom), `/places` (customers
  learned from past tags — the CRM has 0 addresses with coordinates),
  `/search` (Nominatim forward, India-biased), `POST /geocode/batch`. Session
  delete now cascades to visits.
- Models: `FieldZone`, `FieldVisit` (new); `FieldTrackingSession.notes`.
- `reverseGeocode.service.js`: `searchPlace()` on the same 1 req/s chain.

### The change — frontend (grav-clothing)

`components/sales/field-tracking/fieldAnalytics.js` — pure, dependency-free:
stops (closing at any silence over `gapMs`), trips, gaps, integrity flags
(jump / frozen / zero-accuracy / clock), speed events, path-vs-device distance
reconciliation, data quality, timeline segments, zone dwell, attendance,
GPX/KML. `fieldAnalytics.test.mjs`: 17 tests, all pass under `npm test`.
`FieldSessionDetail.js` rewritten: Summary · Timeline · Visits (tag a stop
with customer/outcome/note, known-place suggestions) · Trips · Calls · Zones ·
Gaps & flags · Quality · Log · Notes · Rules. New: `DayTimeline`,
`AttentionPanel`, `ZonesManager`, `RangeReport` (per-day, attendance,
leaderboard, trend), `FeatureGuide` (33 entries, what/why/how),
`DayReportPDF` (letterhead via pdfChrome). Page: modes Live/Reports, map
layers for zones/calls/gaps/flags, measure, nearest-reps, place search,
replay speed, export CSV/GPX/KML, deep links.

### Verified

Real UI, CEO login. Template rows render as "Hi …, Your new account has been
created successfully…" / "Hello," with no chip. Synthetic duty (walk → 25 m
stop → drive with 95 km/h burst → 12 m stop → 20 m gap → return), created
through the app's own write endpoints and deleted afterwards: 2 stops with
reverse-geocoded addresses, 3 trips, 1 gap, 1 speed event, distance
reconciled, attendance "left early", quality 83 %; visit tag saved and
surfaced in `/places` and the summary; zone created by map click; Reports
tiles/leaderboard/attendance/trend; PDF built
(`field-day-Aroona_Panda-2026-09-06.pdf`); measure 6.87 km; copy-link; rules
change recomputes (min stop 30 → Visits 0 → reset 2).

### Two things worth recording

- **Leaflet's SVG renderer sizes itself once.** A route drawn while the map
  container is 0 px wide stays `width="0"`, every path `M0 0`, whatever the
  container does later; `invalidateSize()` does not re-project. The page now
  refuses to draw into a zero-width map and re-draws from a ResizeObserver —
  coalesced with `setTimeout`, not `requestAnimationFrame`, because rAF is
  starved in a hidden pane and that is precisely when the recovery must run.
- `npm test` in grav-clothing: 1119/1125. The 6 failures are pre-existing
  `ReferenceError`s in `components/budget/*` and `components/store/
  deliveryFigures` source-text tests, untouched by this work.

### Addendum — the person's position card (6 Sep 2026, later)

Request: "properly showcase the current location / last location... proper
human icon, with the name and all... as much as informative u can make".
The end of a route was a purple heading arrow with a hover-only name.

- Page: the last position is now a large human pin in the rep's colour with a
  PERMANENT card (`positionCardHtml`): name + id, status (Live / Idle /
  Signal lost / Waiting for GPS / Duty ended), place, "last seen HH:MM · N m
  ago" (or "duty ended HH:MM · last position HH:MM"), speed, accuracy,
  distance, on-duty time, and the zone it lies in. Live duties pulse; a known
  bearing draws a compass badge on the pin. Un-selected live reps carry an
  always-on name pill; the "Names" toggle hides pills for a crowded map. A
  session with a last position but no route still gets the pin. The device's
  own place name is preferred over the server geocode, matching the ping
  route's stated policy. `nav-arrow-icon` is gone.
- Backend: `FieldTrackingSession.lastSpeed/lastBearing/lastAccuracy` written
  on every ping, so `/live` (the 8 s poll) carries what the socket push
  already did — the heading badge no longer depends on a live socket.
- Verified in the real UI on the one real session (ended, one fix) and on a
  throwaway live duty created through the app's endpoints and deleted after:
  poll-path pin shows pulse + "Heading 135°" + pill "Aroona Panda · Live,
  just now"; selected card reads "Live · Nandankanan Road… · Last seen
  12:11 pm · 1m ago · Speed 15 km/h · Accuracy ±11 m · Distance 2.30 km ·
  On duty 25m".

### Addendum — history, navigation certainty, map performance, layering (6 Sep 2026, later)

Request: a proper end-to-end history for a finished trip ("where where area
he covered"); clicks that always go to the person; a map that does not hang;
dropdowns that never hide behind it; "so many features you skipped".

- **Story of the day** (`narrative()` + Story tab): the duty as ordered
  events with every name the page knows — started at X, travelled 7.08 km
  in 15 m (top 95 km/h), stopped 25 m at Y (tagged / in zone / not tagged),
  no signal 20 m, ended at Z — plus **Copy summary** as plain text and
  **Areas covered** (a dozen route samples geocoded and collapsed to
  localities in order). `deriveTrips` now splits a leg at a signal gap —
  the test suite caught a leg silently swallowing a 15-minute silence.
- **History tab**: the person's last 14 days from `/summary` (rows keep
  `sessionIds` so a day opens with one click) with a delta against the
  previous duty. **Unexplained stops** stat; **visits target** rule;
  per-stop Google Maps link; speed sparkline; Reports **Export CSV**;
  distance-from-Office on the card; **fullscreen**; keyboard (Esc, ← →,
  space).
- **Navigation certainty**: `selectPerson()` sets the view on every click,
  repeat clicks included, and every move (`goTo`, `fitBounds`) is followed
  by a settle check on a timer that snaps the map if an animation was cut
  short. Verified through Leaflet's own projection: after a repeat click the
  pin sits at container point (480, 280) — the centre.
- **Performance**: `preferCanvas: true`; speed colouring draws one polyline
  per colour (≤ 5) instead of one per fix (was 1,027 SVG paths for one
  route); `selectedSession` is stable by content so the 8 s poll no longer
  recomputes the scorecard and redraws every layer; live markers are
  reconciled in place rather than rebuilt.
- **Layering**: the map wrapper is `isolate z-0`, containing Leaflet's
  z-indexes (200–1000); overlays inside are z-1100, page dropdowns z-1200.
  The Export menu now hit-tests on top of the map.
- **Two bugs found while verifying**: React rewrites a div's `class` when its
  className prop changes, which wiped Leaflet's `leaflet-container` class
  the first time Fullscreen was pressed (the map div's className is now
  constant; sizing lives on the wrapper); and an earlier search-replace had
  glued `z-[1200]` to the next class token, leaving the dropdown at z auto.

`fieldAnalytics.test.mjs`: 20/20. Synthetic duty and all its tags deleted
after verification.

## Production Supervisor: offline-first Production Record, Orders section, nav trim; PM manufacturing-orders 500 fixed (6 Sep 2026)

Explicit request: remove "Raw Item Uses" and "Device Wifi Change" from the
supervisor portal; make Production Record user-friendly with **offline
support** ("if the network got offline… the scans are gonna store in the
localstorage… when network come the supervisor can sync"); add an **Orders**
section — MO cards, click → that MO's work orders with how much is completed /
remaining, "exactly as like happened in the qc dashboard"; formal UI; and fix
the Project Manager dashboard where the MO pages showed nothing.

### 1. PM "Manufacturing orders" register — 500 fixed (backend)

`GET /api/cms/manufacturing/manufacturing-orders` answered **500 "Server error
while fetching manufacturing orders"** on every request, so the PM register,
the PM dashboard home (limit=5) and everything opened from them were empty.
Cause: a half-merged handler in
`routes/CMS_Routes/Manufacturing/Manufacturing-Order/manufacturingOrderRoutes.js`
— it called the new `listManufacturingOrders(req.query)` service and then fell
through into the OLD inline pipeline, which referenced `matchQuery`, `status`,
`skip`, `limitNum`, `pageNum` that no longer exist → `ReferenceError` → 500.
(The merge `e7038b1` combined the service refactor with the 31 Aug
`orderOrigin` badges.)

- Handler is now wiring only: `res.json({ success: true, ...page })`.
- The one thing the inline copy had that the service lacked — `orderOrigin`
  (sampling / internal / testing / customer badge) — moved INTO the canonical
  projection: `services/manufacturing/moListProjection.js` projects
  `orderOrigin, isInternalOrder, sampleStyleId` and `projectRow` publishes
  `orderOrigin: resolveOrderOrigin(r)` (`services/orderOrigin.js` is pure, so
  the projection stays model-free).
- Verified live with a CEO Bearer token: `?limit=3` → 200, 11 rows,
  `orderOrigin` present; `page=abc`, `limit=0`, `search=(`, `status=bogus`,
  `deadlineRisk=overdue` all 200; `/:id`, `/:id/detailed`,
  `/emplloyeeTracking/:id`, `/:id/work-orders`, `/stats/overview`,
  `/stats/production-trend`, `/:id/bulk-tracking`, `/:id/dispatch-history`
  all 200. In the browser the PM register lists 11 orders with status /
  priority / deadline filters and the PM dashboard shows its 5 recent MOs.
- NOT run: `test/project-manager/*.route.test.js` — jest and
  mongodb-memory-server are absent from this checkout's node_modules
  (`npx jest` → "Cannot find module 'mongodb-memory-server'"). Run them once
  devDependencies are installed.

### 2. Supervisor nav (frontend)

`components/ProductionSupervisor_DashboardLayout.js`: menu is now Overview ·
Production Record · **Orders** · Live Production Tracker. "Raw Item Uses" and
"Device Wifi Change" are gone and their pages deleted
(`app/production-supervisor/dashboard/raw-item-tracker/`, `…/wifi-config/`);
nothing else linked them (the cutting master keeps its own raw-item tracker).
`/production-supervisor/dashboard/raw-item-tracker` now 404s.

### 3. Orders section (backend + frontend)

Backend, `routes/CMS_Routes/Manufacturing/Production/productionCompletionRoutes.js`
(both behind `EmployeeAuthMiddleware`; the whole `/api/cms` prefix is in any
case gated by `operations.js`'s router-level auth — see the gotcha below):

- `GET /orders` — one card per Manufacturing Order rolled up from every
  non-cancelled work order: `total, completed, remaining, today, extra,
  percent, workOrdersCount, completedWorkOrders, inProgressWorkOrders,
  notStartedWorkOrders, lastScanAt` + MO header (`requestId, customerName,
  customerEmail, requestType, measurementName, status, createdAt, deadline`).
  Work orders with no MO collect under `"unassigned"`, as /overview does.
- `GET /orders/:moId` — that MO's work orders with the same figures plus
  photo (`resolveProductImage`, same rule as QC), gender, reference, variants,
  WO status, `assignedDeadline`, `lastScanAt/lastScannedBy`, `doneUnits`,
  `pendingUnits` (the unit numbers still to make); `totals`; `trend` (units by
  IST day of first scan); `contributors` (units by scannedBy).
- What is counted: the `ProductionCompletionScanRecord` ledger — the same one
  the barcode scanner writes to. COMPLETED = distinct unit numbers scanned
  (any day) within 1..quantity; REMAINING = quantity − completed; TODAY =
  units whose FIRST scan is in today's IST bucket; a unit number above the
  ordered quantity is `extra`, never progress. One ledger read per request
  (`loadScanIndex`, one doc per day).
- `GET /ping` — reachability probe for the offline page (see 4).

Frontend: `app/production-supervisor/dashboard/orders/page.js` (MO cards —
header + state chip, customer, deadline, measurement tag, work-orders-done /
units / last-scan row, progress bar + Completed · Remaining · Today · Ordered
figures, "View work orders"; search; Still to make / Completed / All filter;
"Across these orders" rollup) and `orders/[moId]/page.js` (MO head, "Where
production stands", Day by day table, Who scanned, work-order cards with photo
zoom, WO status, deadline risk, per-WO figures and an expandable "Units still
to make" list shown as ranges, All / Not started / In production / Completed
filter). Shared: `components/production-supervisor/ProductionProgress.js`
(`ProductionProgressBar`, `FigureGrid`, `sumProduction`, `stateOf`,
`STATE_META`) — the supervisor's counterpart of `components/qc/OrderProgress.js`,
same shape on purpose. Built on `components/ceo/ui/Primitives` (neutral,
formal), which the supervisor shell's `.grav-ui` root already supports.

Verified in the browser as CEO: 11 MO cards (e.g. REQ-2026-0012 "1 / 19 done ·
6 / 92 (7%) · 86 remaining"; REQ-2026-0011 "629 / 632 (100%)"); the MO page
lists all 19 work orders with photos, references, sizes and "Units still to
make (3)"; filter counts 17 / 1 / 1.

### 4. Production Record — the previous page, with offline safety underneath

An offline-first rebuild (status chips, sync history, auto-sync, a "how this
works" panel, Primitives styling) shipped first and was rejected the same day
— feedback: "this page need to change completely because as like previously
it treats… these offline feature and all are just extra features… treat as
like previously". So `app/production-supervisor/dashboard/production-record/page.js`
is the previous page again — Barcode Scanner card, camera that closes after
one read, manual entry, the scanned list, **Save Record (N)** → preview →
confirm modal → save, the already-scanned / invalid result panels — and the
offline support is only what was asked for:

- The scanned list is kept in **localStorage** (`grav.productionRecord.queue.v1`,
  via `components/production-supervisor/scanQueue.js` — `safeStorage`,
  `loadQueue`, `saveQueue`; `scanQueue.test.mjs`, 5 tests). Scans survive a
  reload, a closed tab and a dead connection; nothing about scanning touches
  the network. Footer note: "Kept on this device until saved".
- A small header pill — **Online** (grey) / **Server unreachable — scans kept
  on this device** (amber) / **Offline — scans kept on this device** (red) —
  from `navigator.onLine` + `online/offline` events + `GET /ping` every 30 s
  (sent with the session, see the gotcha below).
- Pressing **Save Record** without a connection loses nothing: the list
  stays, and an amber message says "No connection right now. Your N scans are
  saved on this device — press Save Record again once the network is back."
  A network failure during preview or save says the same. The list is
  cleared only when the server has answered for every code (recorded /
  skipped / invalid).
- `scannedBy` now carries the signed-in user's name (was blank for every
  scanner entry), so the MO page's "Who scanned" is populated going forward.
- Two modal texts corrected: already-recorded barcodes are *skipped by the
  server, never counted twice* (the old copy said they would be duplicated).

Verified in the browser as CEO: the page renders as before (header badge,
scanner card, list, Save Record); added codes survive a reload; with the
network simulated off, Save Record shows the amber kept-on-device message and
the list stays; back online, Save Record → Confirm Save modal → save records
the new codes, the list clears, the result panels show what was skipped /
invalid. Test scans were removed from the ledger afterwards.

### Gotcha recorded

`app.use("/api/cms", productOperations)` in server.js (~line 1352) carries a
router-level `EmployeeAuthMiddleware`, so every `/api/cms/**` route mounted
after it needs the session even when its own file has no auth — an
unauthenticated `GET …/production-completion/ping` answered 401. The record
page therefore sends the session on the probe and reads 401/403 as "Signed
out" rather than "unreachable".

Frontend `node --test`: scanQueue 5/5, fieldAnalytics 20/20.

## Work-order numbers were blank on every Project Manager screen (6 Sep 2026)

Reported: "in the product manager side, the wo number are not showing… the mo
view page, list page got affected" plus "keep an list view to showcase the wo
in form of list".

### The cause — a data gap, not a regression

**Every one of the 143 work orders in the database has an empty
`workOrderNumber`.** The model assigns one in a `pre("validate")` hook guarded
on `isNew`, so it has never touched a single existing row; the model's own
comment says as much ("production holds many with neither field… populating
those records is a migration, deliberately separate"). That migration has never
been run, and there is no counter, so the field has always been empty.

Screens printing the field raw therefore showed nothing. On the PM's work-order
panel it was worse than blank: `woReferenceLabel()` in
`components/manufacturing/moWorkOrders.js` returns the literal string
**"Work order — no number"** when the field is empty, which is what was on
screen for all 19 rows of every order.

This is unrelated to the manufacturing-orders 500 fixed earlier the same day —
the list endpoint's fields are a strict superset of what the old inline
pipeline projected (verified field by field), and it never carried work-order
numbers at all.

### The fix — resolve at the API boundary, one rule

New `services/manufacturing/workOrderNumber.js`: `displayWorkOrderNumber(wo)`
returns the stored number, else `WO-<last 8 of the _id>`; plus
`withWorkOrderNumbers(rows)` for lists. Nothing writes to the database — if the
migration is ever run, the stored value wins and the module stops mattering.

**Why the short form and not `WorkOrder.canonicalNumber()`** (which returns
`WO-<full ObjectId>` and is the right choice for a stored unique key, left
untouched): every unit barcode is `WO-<last 8>-<unit>`, built and parsed that
way by the scanner, the QC pipeline and the production ledger. Showing
`WO-6a79a588da39e282a6b160a3` beside a label reading `WO-a6b16a8f-001` gives one
work order two different numbers — worse than the blank it replaces. The model's
own comment already calls the eight-character form "a PRESENTATION fallback".

Applied to every endpoint a PM screen reads work orders from:

| Endpoint | File |
|---|---|
| `GET /manufacturing-orders/:id` | manufacturingOrderRoutes.js |
| `GET /manufacturing-orders/:id/detailed` | " |
| `GET /manufacturing-orders/:id/work-orders` | " (also `/employeeTracking/:id/work-orders`; both needed `.lean()` added) |
| `GET /manufacturing-orders/emplloyeeTracking/:id` | " — the detail page and every tab under it |
| `GET /manufacturing-orders/:id/bulk-tracking` | " |
| `GET /production-completion/manufacturing-orders/:moId` | productionCompletionRoutes.js — the PM Production tab |
| `GET /employee-tracking/manufacturing-order/:id/employees` | employeeTrackingRoutes.js — published a literal `"—"` |

The supervisor Orders route added earlier had its own inline
`workOrderNumber || \`WO-${shortId}\`` — switched to the shared resolver so
there is one definition of the number rather than two.

Verified live, all eight sources: 19 rows each (1 for QC inspections, 12 for
employee tracking), **0 blanks**, e.g. `WO-a6b16a8f`. In the browser the PM
detail page shows real numbers on every card and row and **0** occurrences of
"Work order — no number" (was 19); the register still lists 11 orders with no
error.

### The list view

It already existed — `WorkOrdersPanel` renders `WorkOrderRow` when `view ===
"list"`, wired to `woViewMode` on the page. It was hidden behind two unlabelled
16px glyphs. `WorkOrderStats.js` now renders that switch as labelled pills —
**Grid** / **List**, icon plus word — so the choice is visible. No behaviour
change; `aria-label`, `aria-pressed` and the callbacks are as they were.
Verified: clicking List switches to rows reading e.g. "WO-a6b16a8f · Scheduled ·
F&B Service Shirt · Male · Size: 30 · — / 12 · View", and back to Grid.

### Still outstanding

The same empty field reaches other departments' screens through their own
routers — `grep` finds ~10 more route files publishing `workOrderNumber` raw
(CEO production and dispatch, cutting master, embroidery, stock items, barcode
tracking, wastage). They were left alone: this change was scoped to the Project
Manager side that was reported. The durable fix for all of them is either the
model's migration (with a decision about which form to store) or applying the
same resolver in each router.
| `google-lead-form-creation` (new) | **19 / 19** |
| focused (all `google-lead*`, `google-search-deployment`, `campaign*`) | **469 / 469**, 14 suites (measured at 17 lead-form tests; 2 added since, both in the full run) |
| `test/marketing` (full) | **1508 passed / 1508 total**, 37 suites (1489 + 19) |
| `test/crm` + `test/sales` (serial, `--runInBand`) | **42 failed / 841 passed / 883 total**, 44 suites. The 42 failures are the same baseline failures in the same nine suites. The +49 tests / +2 suites are new passing files from concurrent CRM work (`enquiry-product-identity.route`, `sales-journey-close.route`), not this slice |

Nothing committed.

# Marketing Enquiries inbox — read API (2026-09-21)

Read-only list and detail over the recorded lead-form submissions and their
processing receipts. **Not committed.**

## Files

| File | What it is |
|---|---|
| `constants/marketingEnquiries.js` | Public vocabulary: processing, consent, consent bases, review reasons, ingestion origins, contact labels, provenance, page bounds |
| `services/marketing/leads/enquiryInbox.service.js` | `list` / `detail` / `vocabulary`; reads only |
| `routes/CMS_Routes/Marketing/enquiries.js` | `GET /enquiries`, `GET /enquiries/:submissionRef` (Marketing, admin, CEO) |
| `server.js` | One mount, after `leadRecovery` |
| `test/marketing/marketing-enquiries.route.test.js` | 22 route tests |

## Decisions

- **Derived at read time.** Status comes from the receipt under the current
  `CONTRACT_VERSION`, joined company-first. Nothing is stored and no receipt is
  opened by reading.
- **Permission is `unknown` until `consentEvaluatedAt` is set.** No receipt, a
  pending or retrying receipt, a review hold and a refusal all read `unknown`.
  Only an evaluated receipt yields `permission_recorded` or
  `no_permission_recorded`, with `consentBasis` taken from the consent reason codes.
- **Processing** is one of `processing | needs_review | finished | cannot_process`.
  `retryable_failure` and the intermediate stages read as `processing`. Stage
  names, attempt counts and retry times never leave.
- **The list row's contact** is `{name, companyName, hasEmail, hasPhone}`. It
  carries no address and no number. The detail carries the supplied fields,
  answers with their questions, unmapped answers and `phoneVerified`. Everything
  is marked `self_reported`.
- **Fields are projected in** (an aggregate `$project` or `select`), so provider
  ids, `_id`, binding, deployment, click id, lead source/stage and API version
  are never read into the output.
- **Hidden identifiers.** An unmapped answer code that is not an UPPER_SNAKE
  enum is shown as `UNRECOGNISED_QUESTION`, so a numeric column id cannot surface.
- **Test deliveries** live in their own collection and never appear.
- **Existing view, unchanged.** `states` reuses the receipt's `publicView()`.
  For a `possible_duplicate_submission` hold that view says
  `needs_identity_review`. `reviewReason` carries the precise reason, and I did
  not change the existing view.

## Verification

- `npx jest test/marketing/marketing-enquiries.route.test.js`: 22/22.
  - Mutation checks: collapsing `unknown` into no-permission fails 8 tests;
    dropping the company from the receipt join fails 1; putting an email in a
    list row fails 2.
- `npx jest test/marketing`: 38 suites, **1530/1530**.
- `npx jest test/crm test/sales`: 42 failed / 841 passed / 883. These are the
  same 42 baseline failures in the same nine suites, unchanged.

# Marketing Content Planner — backend foundation (2026-09-21)

A planning tool only: it creates, schedules, sends and publishes nothing.
**Not committed.** The design record and the exact Lane B contract are in
`docs/decisions/marketing-content-planner.md`.

## Files

| File | What it is |
|---|---|
| `constants/marketingContentPlan.js` | Types, channels, states, actions and who may take them, editability, publication and library vocabularies, limits |
| `models/CMS_Models/Marketing/MarketingContentPlanItem.js` | Company-scoped item. Embedded append-only history; update and delete hooks refuse history edits and deletes |
| `services/marketing/contentPlan/zonedTime.js` | IANA zone conversion with `Intl`. Refuses a skipped time; takes the first of a repeated one |
| `services/marketing/contentPlan/contentAssets.js` | Confirms linked assets through the existing read-only content `list()`. Bounded paging |
| `services/marketing/contentPlan/contentPlan.service.js` | create / update / act / list / detail / calendar / owners |
| `routes/CMS_Routes/Marketing/contentPlan.js` | 7 routes (4 GET, 1 PATCH, 2 POST); mounted after `contentInventory` in `server.js` |
| `services/storePurchase/errors.js` | 8 `CONTENT_PLAN_*` codes |
| `test/marketing/content-plan.route.test.js` | 27 route tests |

## Verification

- `npx jest test/marketing/content-plan.route.test.js`: **27/27**. The tests cover:
  - month boundary in IST and UTC;
  - the repeated hour when clocks go back, and the skipped hour when they go forward;
  - overlaps, the empty calendar, isolation, permission refusals;
  - stale and racing edits, missing plan and asset links;
  - library unreadable or too large;
  - published, scheduled and expired only from the library;
  - no internal ids or provider names in responses, and no publishing routes.
- Mutation checks, each caught by at least one failing test:
  - removing the revision fence;
  - removing the self-approval check;
  - bucketing by the typed date instead of the viewer's local date;
  - treating a future publish date as published.
- `npx jest test/marketing`: 39 suites, **1557/1557**.
- `npx jest test/crm test/sales`: 42 failed / 841 passed / 883, the same nine
  baseline suites.
  - One earlier run also failed `test/sales/sample-style-customer-name.test.js`
    (untracked, not this lane's). It passes on its own and did not fail on the rerun.

# Content Planner — creative drafts (2026-09-21)

**Not committed.** The contract is in `docs/decisions/marketing-content-planner.md`,
under "Creative drafts".

- **Media found:** the Marketing advertising image library (JPEG and PNG,
  company-scoped, immutable hashed versions, signed company-bound ids). It is
  reused by reference. The planner has no upload or storage. **The gap:**
  there is no store for video, documents or design files; they can only be
  described in a note, which is labelled as not a stored file.
- **Files:**
  - `constants/marketingContentPlan.js`: creative vocabularies, the media-store statement and limits.
  - `models/CMS_Models/Marketing/MarketingContentPlanItem.js`: `creative`, `approvedRevision`,
    `approvedCreativeFingerprint`, and `history[].creativeFingerprint`.
  - `services/marketing/contentPlan/creative.js` (new): validation, image
    confirmation, fingerprint and views.
  - `contentPlan.service.js`: wiring, the submission gate, the approval pin and vocabulary.
  - `test/marketing/content-plan-creative.route.test.js` (new): 12 tests.
- **Verification:**
  - Creative tests pass 12/12. The existing planner tests pass 27/27.
  - Mutation checks, each caught by at least one failing test:
    - the approval ignoring the fingerprint;
    - the approval not recording it;
    - submission not requiring the creative;
    - the fingerprint using the file name instead of the image hash;
    - withdrawn images being accepted;
    - a vanished image being shown as available;
    - pointer keys not being refused.
  - `npx jest test/marketing`: 40 suites, **1569/1569**.
  - `npx jest test/crm test/sales`: 42 failed / 841 passed / 883, the same nine
    baseline suites.

# Creative media library — images (2026-09-21)

**Not committed.** Contract and blockers: `docs/decisions/marketing-content-planner.md`,
section "Creative media library".

- **Built:**
  - Company-scoped image library (JPEG and PNG, ≤10MB, 320–8000px).
  - Immutable, hashed versions; random company-bound `cmv_`/`cmg_` references.
  - Authenticated preview that re-hashes on every request.
  - Withdrawal by the uploader or an approver, with a reason.
  - A planner reference kind `media` pinned by version and hash, so approval
    validity reports withdrawn or missing files, and submit and approve are
    refused while a file is unavailable.
- **Video blocked, not faked:**
  - Buffer-only uploads.
  - No Range streaming.
  - The full-read integrity check.
  - No production video inspector.
  Videos are recognised and refused with those reasons.
- **Reused:** `imageBytes` and `companyDrive`.
- **Not touched:** the advertising image library and the Campaign Builder.
- **Files:**
  - `constants/marketingCreativeMedia.js`
  - `models/CMS_Models/Marketing/MarketingCreativeMedia.js`
  - `services/marketing/creativeMedia/creativeMedia.service.js`
  - `routes/CMS_Routes/Marketing/creativeMedia.js` (mounted in `server.js` after `contentPlan`)
  - 9 `CREATIVE_MEDIA_*` codes in `services/storePurchase/errors.js`
  - Planner:
    - `constants/marketingContentPlan.js`: the `media` reference kind and the
      updated media-store gap.
    - `MarketingContentPlanItem.js`: reference fields.
    - `creative.js`: confirmation, fingerprint, states and `unavailableMedia`.
    - `contentPlan.service.js`: approval validity, the submit and approve
      refusal, and the `media_unavailable` action reason.
  - `test/marketing/creative-media.route.test.js`: 15 tests.
  - Three planner assertions updated for the grown contract.
- **Verification:**
  - Media tests pass 15/15. The planner suites pass 39/39.
  - Mutation checks, each caught by at least one failing test:
    - a withdrawn file being previewed;
    - the hash check being skipped;
    - the company missing from the selector;
    - video not being recognised;
    - an orphaned file not being removed;
    - unavailable media being ignored;
    - withdrawn media being accepted into a creative;
    - a cut-short upload being reported generically.
  - `npx jest test/marketing`: 41 suites, **1584/1584**.
  - `npx jest test/crm test/sales`: 42 failed / 841 passed / 883, the same
    nine baseline suites.
  - **Not verified against the live company Drive.** Tests use an in-memory
    stand-in; the Drive path is the one the advertising image library already uses.

# Creative-media contract corrections (2026-09-21)

**Not committed.** Contract: `docs/decisions/marketing-content-planner.md`,
section "Creative-media contract corrections".

**Changes:**
- **Approval validity on every read.** One `approvalDecision` drives list,
  calendar and detail: `approvalStatus` plus `unavailableMediaCount` on every
  row, kept separate from `state`.
- **`media_changed`.** A preview that finds changed stored bytes records
  `integrityFailedAt`, and a preview that finds the exact bytes back clears it.
- **`viewerActions.withdraw` on every `MediaView`.** Driven by the same
  predicate the server enforces.
- **Wording.** Reference status labels are set per library (creative media vs
  advertising image library).
- **Preview header.** The preview exposes `X-Content-Hash` on that response only.
- **Fixed:** the `safeFileName` regex in `creativeMedia.service.js` contained a
  raw NUL byte instead of an escape sequence. It was harmless at runtime, but
  made grep treat the file as binary. `test/marketing/advertising-assets.test.js`
  also contains a NUL; it is not this lane's file and was left alone.

**Files:**
- `constants/marketingContentPlan.js`
- `models/CMS_Models/Marketing/MarketingCreativeMedia.js`
- `services/marketing/creativeMedia/creativeMedia.service.js`
- `routes/CMS_Routes/Marketing/creativeMedia.js`
- `services/marketing/contentPlan/creative.js`
- `services/marketing/contentPlan/contentPlan.service.js`
- Tests:
  - 9 new tests (16–24) in `creative-media.route.test.js`.
  - 4 label assertions updated to the corrected wording.

**Verification:**
- Media suite passes 24/24; planner suites pass 39/39.
- Mutation checks, each caught by at least one failing test:
  - rows computed without file states;
  - changed media ignored;
  - withdraw offered to every marketer;
  - the hash header not exposed;
  - media references named with advertising-library wording;
  - a restored copy never recovering.
- `npx jest test/marketing`: 41 suites, **1593/1593**.
- `npx jest test/crm test/sales`: 42 failed / 841 passed / 883, the same nine
  baseline suites.

**Real Drive verification is still outstanding.** No signed-in development
environment was available, and no token was minted to create one.

# Marketing permissions, end to end (2026-09-21)

**Not committed.** Design and contract: `docs/decisions/marketing-access-permissions.md`.

**Backend:**
- New:
  - `services/marketing/marketingAccess.js`: the resolver, capability table and
    route classification.
  - `routes/CMS_Routes/Marketing/access.js`: `GET /access`.
  - `test/marketing/marketing-access.route.test.js`: 19 tests using the real
    guard, real tokens and records, and all routers in server order.
- Rewritten: `Middlewear/MarketingAuthMiddlewear.js`. It resolves from the
  database once per request, enforces the act, and rebuilds `req.user` (Viewer
  becomes `marketing_viewer`).
- `server.js`: `googleLeadWebhook` and `access` are mounted before every guarded
  Marketing router.
- `routes/CMS_Routes/Marketing/googleLeadWebhook.js`: reads the body the global
  parser already consumed.
- Refusal wording: `campaignDraft.service.js`, `contentPlan.service.js`,
  `creativeMedia.service.js`.

**Frontend (grav-cms):**
- New:
  - `lib/marketing/marketingAccess.js` (+ test).
  - `components/marketing/MarketingAccessContext.js`: provider, hooks,
    `MarketingAct`, the refusal screen, and a preview provider.
  - `components/access/marketingRole.js`: truthful Access Control wording.
  - `components/marketing/marketingPermissionsUi.test.mjs`.
- Wired:
  - The Marketing shell provider.
  - Create links and the builder.
  - The edit page (read-only for Viewers).
  - Setup (save/upload for writers; create/reconcile for administrators).
  - Health generate/dismiss.
  - Media uploader.
  - Setup, performance and advertising pages use the server's answer instead of
    an unfilled `user` prop.
  - The preview gets a fixed administrator answer.
- Updated pinned tests: `marketingAccessRole`, `editPage`, `campaignHealthPanel`.

**Verification:**
- `test/marketing/marketing-access.route.test.js`: 19/19. Ten mutations of the
  model were each caught.
- `npx jest test/marketing`: 42 suites, **1612/1612**. One run had a load-timing
  failure in `marketing-overview`; it passes 34/34 alone and in the rerun.
- `npx jest test/crm test/sales`: 42 failed / 841 passed / 883, the same nine
  baseline suites.
- `npx jest test/access`: `department-role-cache` fails 3 of 11, from an
  uncommitted `services/departmentRoles.js` change dated 7 September that this
  work did not touch.
- Frontend Marketing, access and preview tests: **3303/3303**. The edited files
  parse as JSX.

# Budget pacing, read-only (2026-09-22)

**Not committed.** Contract: `docs/decisions/marketing-budget-pacing.md`.

- **New:**
  - `constants/marketingPacing.js`: calculation, thresholds, verdicts and reasons.
  - `services/marketing/performance/budgetPacing.service.js`.
  - `GET /campaign-drafts/:campaignDraftId/pacing` in
    `routes/CMS_Routes/Marketing/campaignPerformance.js`.
  - `test/marketing/budget-pacing.route.test.js`: 15 tests.
- **Changed:** the capability matrix entry `budget_pacing` is now available.
- **Baseline before edits:**
  - Marketing: 1 failed / 1615 passed / 1616. The failure is
    `google-lead-recovery` test 12, a clock-dependent assertion on
    `2026-09-19`.
  - CRM/Sales: 42 failed / 841 passed / 883.
  - Worktree: 657 changed paths.
- **After:**
  - Pacing suite: 15/15. Thirteen mutations, including unread days treated as
    zero, currency, revision, company, several channels, spread and stale data,
    were each caught.
  - Marketing: 1 failed / 1630 passed / 1631. It is the same clock-dependent
    recovery test, not a timeout.
  - CRM/Sales: 42 failed / 841 passed / 883, unchanged.

# Budget pacing — contract corrections (2026-09-22)

**Not committed.**

- **Stopped campaigns are not paced.** `paused_confirmed` gives `campaign_stopped`
  ("Campaign is stopped; spending pace does not apply"), even with a genuine
  zero.
- **Running needs evidence.** A verdict requires `activated` AND a campaign
  read-back that is delivering (`nonDeliveringConfirmed: false`, `stateReadAt`,
  Google `ENABLED` / Meta `ACTIVE`). Otherwise the result is
  `running_state_unconfirmed`. Nothing sets `activated` yet, so current
  deployments all read `campaign_stopped`.
- **Money precision.** The ISO 4217 exponent table is
  `constants/currencyMinorUnits.js`. Every money field uses the currency's own
  minor unit and states `minorUnitDigits`. An unknown currency gives
  `currency_precision_unsupported`, with null amounts.
- **Tests:** `budget-pacing.route.test.js` now has 20. The zero-spend test uses
  a confirmed-running deployment, and new tests cover:
  - stopped with zero;
  - stopped with historical spend (the report still shows it);
  - three unconfirmed-running cases;
  - JPY and KWD exactness;
  - an unknown currency.
  Four mutations were each caught.
- **Results:**
  - Focused (pacing + performance + capabilities): 56/56.
  - Marketing: 1 failed / 1635 passed / 1636. The failure is the pre-existing
    `google-lead-recovery` test 12, a date-dependent `2026-09-19` assertion.
- **Follow-up, outside this slice:** `campaignReport.service.js` still uses a
  fixed 100 minor units per major for every currency.

# IndiaMART lead source — bounded, idempotent pull into the enquiries inbox (2026-09-22)

**Not committed. Not verified live: no IndiaMART seller key exists, so IndiaMART was never called.**
The decision and the Lane B contract are in `docs/decisions/marketing-indiamart-lead-source.md`.

- **Contract source.** IndiaMART's "LMS CRM Integration V2" page (updated 11 Dec 2025), read on 22 Sep 2026.
  - The request is `GET mapi.indiamart.com/wservce/crm/crmListing/v2/` with the key, `start_time` and `end_time` in IST.
  - Limits: 7 days per call, 365 days retained, one call per 5 minutes.
  - Duplicates are removed by `UNIQUE_QUERY_ID`.
- **New records.**
  - `MarketingSourceEnquiry` is append-only and deduplicated per company on the source id.
    That id is `select:false` and never published.
  - `MarketingLeadSourceState` holds the cursor, the rate fence and the lease.
- **Routes.**
  - `GET /lead-sources/indiamart` is readable by all Marketing roles and never calls IndiaMART.
  - `POST /lead-sources/indiamart/check` is admin or CEO only. It is in `ADMINISTER` and makes one call per check.
- **Windows and retries.**
  - The cursor moves only after the whole window is saved.
  - Windows overlap by 15 minutes.
  - There is a 5-minute gap between calls, 15 minutes after a 429.
  - Lost answers and partial saves refetch the same window without creating duplicates.
- **Inbox.** `GET /enquiries` merges IndiaMART rows through `$unionWith`, and every row gains `source` and `kind`.
  - IndiaMART rows read `not_processed` / `no_permission_recorded` / `source_does_not_ask`, with `campaign: null`.
  - The detail adds `enquiryContext`.
  - `kind` separates buyer enquiries (W, P, WA) from purchased leads (B) and catalog views (BIZ).
- **Credentials.**
  - The key is read only from `MARKETING_INDIAMART_CRM_KEY`, and only for `MARKETING_COMPANY_ID`.
  - The key is not stored in MongoDB, responses or logs. IndiaMART's messages are never repeated.
- **Nothing follows.** No automatic scheduler, processing, consent, person, Sales record or handover is created.
- **Tests.**
  - `test/marketing/indiamart-lead-source.route.test.js` has 35 tests.
  - Seven mutations were tried against the sync service, the inbox and the model. Six were caught; the seventh broke every test instead of producing a meaningful result.
  - Updated: `marketing-enquiries.route.test.js`, for the pinned row keys and filters.
  - Updated: `marketing-access.route.test.js`, for the router list and the elevated route.
- **Results.**
  - Focused (IndiaMART, enquiries, access): 80/80.
  - Marketing: 1 failed / 1670 passed / 1671. The failure is the pre-existing `google-lead-recovery` test 12, a hard-coded `2026-09-19` date.
  - CRM/Sales: 42 failed / 841 passed / 883. That matches the baseline exactly: the same nine suites.
- **Needs the seller account.**
  - Paid status and the key.
  - Confirmation of the `DD-Mon-YYYYHH:MM:SS` request format and the `QUERY_TIME` format.
  - Whether window boundaries are inclusive.
  - Any record cap per response.
  - Which `QUERY_TYPE`s the account actually receives.
  - Whether IndiaMART signals errors through the HTTP status or the body `CODE`.
  - Whether pulling resets the key's 7-day inactivity expiry.

# IndiaMART: scheduled pull and routing of buyer enquiries to Sales (2026-09-22)

**Not committed. Simulated only.** No seller key exists, so IndiaMART was never called. The contract and the gaps are in `docs/decisions/marketing-indiamart-lead-source.md`, under "Scheduled pull and routing to Sales".

- **Schedule.**
  - `services/integration/indiamartScheduler.js` runs every 6 minutes from `server.js`, plus once 60 seconds after boot.
  - It is idle without a key, and switchable with the job flag `marketing-indiamart-pull`.
  - It reuses the source state row as the lock, the rate fence and the cursor.
  - Check now runs the same cycle, recorded with `startedBy: "manual"`.
- **Routing.**
  - `services/integration/indiamartSalesRouting.service.js` keeps one `MarketingSourceEnquiryRouting` row per enquiry, with atomic claims.
  - It writes the intent-ledger evidence, calls the existing `prospectHandover.submit`, then the existing `deliverPending`, which reaches the one Sales writer, `marketingProspectIntake.receive`.
  - Only W, P and WA enquiries are routed. B and BIZ are `not_routed`.
  - Incomplete, old or refused items are held with a reason. Editor-level users and above can release or dismiss them.
  - Permission always travels as `unknown`.
- **Boundary change, additive.** An optional `sourceEnquiry` block on the handover, the handover contract and the Sales receipt package. `leadFromPackage` writes the buyer's request into `possibleNeed`.
- **Read side.** `services/marketing/leads/indiamartRouting.read.js` serves:
  - `salesRouting` on the status and on the MSE detail;
  - the new `GET /lead-sources/indiamart/routing`;
  - `POST …/enquiries/:ref/release` and `POST …/enquiries/:ref/dismiss`.
- **Status additions.** `coverage.freshness` and `coverage.lagMinutes`, and a fuller `automaticChecks`.
- **Changes Lane B asked for.**
  - The shared inbox wording no longer calls a Buy-Lead or catalog view "their enquiry". `not_processed` no longer claims nothing reaches Sales.
  - `coveredFrom` restarts after a coverage gap.
- **Tests.**
  - New: `test/marketing/indiamart-sales-routing.test.js`, 23 tests.
  - Six mutations, all caught:
    - routing prospects;
    - no age hold;
    - inferred consent;
    - no delivery retry;
    - no tenant scope;
    - a random idempotency key.
  - `indiamart-lead-source` test 31 is narrowed to the pull alone. Test 7 now pins that `coveredFrom` never falls inside a gap.
  - Focused run (both IndiaMART suites, enquiries, Google lead processing): 111/111.
- **Regressions.**
  - Marketing, full run: 3 failed / 1691 passed / 1694, all in `google-lead-recovery`. Run alone it is 1 failed / 25 passed; the remaining failure is the pre-existing hard-coded date in test 12.
  - CRM/Sales, full run: 267 failed. The machine was shared with other sessions' Jest runs at load 13, and most failures were "Instance failed to start within 10000ms".
  - CRM/Sales, serial rerun of the failing suites: the same 42 baseline failures in the same suites, test for test.
  - `account.model`, `relationship` and `packaging-bom-link` pass.
  - `sales-journey-close.route` (a new suite from another session) passes alone, 37/37.

# IndiaMART → Sales, made truthful and actionable (2026-09-22)

**Not committed. Simulated only.** The details are in `docs/decisions/marketing-indiamart-lead-source.md`, under "Truthful and actionable in Sales".

- **Lead source.**
  - The new `constants/crm.js` `LEAD_SOURCES` is the single list of codes and labels. The Lead enum is built from it, with `indiamart` added.
  - The lookups endpoint serves it as `lead_source`, and falls back to the constants for categories added after seeding.
  - The Sales writer maps IndiaMART handovers to `indiamart`: the channel goes in `sourceDetails`, there is no campaign, and a new `marketingHandover.sourceEnquiry` holds the kind, GRAV reference and time provenance.
  - Campaign handovers are unchanged. No migration was needed, because no IndiaMART Lead could exist yet.
- **Sales queue.**
  - `GET /api/cms/sales/marketing-handovers` adds `source` and `order` filters, `total`, and `summary` (awaiting count by source, oldest item and its age, and the ownership rule, which is "none").
  - Every row, and the detail, gains a `queue` block: source, enquiry reference and kind, age, owner, next action, suggested first step, decision, Prospect reference, and `contacted: false`.
  - Nothing is assigned by the system.
  - Gaps: there is no ownership rule, and no dashboard or notification counts waiting handovers.
- **Time.**
  - A new hold, `submitted_time_implausible`, sits alongside `submitted_time_unknown`. Both can be released with a time-zoned `submittedAt` and a required note.
  - The confirmation is stored on the routing row's `timeConfirmation`, and provenance is carried through the intent event, the handover, the Sales receipt, the Lead and the queue.
  - `too_old` stays a separate, dismiss-only reason.
- **Tests.** New: `indiamart-sales-handover.test.js`, 13 tests; seven mutations, all caught. `indiamart-sales-routing` test 12 is updated for the new source.

# IndiaMART status-contract correction (2026-09-22)

**Not committed.** The details are in `docs/decisions/marketing-indiamart-lead-source.md`, under "Status-contract correction".

- **Automatic checks.** `automaticChecks` gains `state` (scheduled, switched off or no key) and `lastCycleOutcomeLabel`. `lastCycleOutcome` is limited to five labelled codes.
- **Vocabulary.** Two new lists: `vocabulary.automaticCheckStates` and `vocabulary.scheduledCycleOutcomes`.
- **Coverage notes.** They now describe coverage only, and no longer claim a schedule.
- **Fixed:**
  - The scheduler heartbeat now upserts its row, so a cycle that errors on a fresh deployment is no longer lost.
  - `indiamartSync.service.js` had literal control bytes in its `clean` regex, which made grep and git treat the file as binary. They are now escape sequences, with the same behaviour.
- **Tests.** `indiamart-status-contract.test.js`, 11/11. Focused IndiaMART, enquiries and access: 127/127.
