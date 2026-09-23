# Image Studio — Photopea delivery plan

**Date:** 2026-09-21  
**Status:** Roadmap; native-UX slice is active through `docs/tasks/current-task.md`  
**Product source:** `docs/product/image-studio-photopea.md`  
**Architecture decision:** `docs/decisions/image-studio-photopea-boundary.md`

This roadmap does not independently authorize implementation. Under the repository collaboration rules, Claude Code implements only the slice activated in `docs/tasks/current-task.md`. The prior Marketing consent history remains preserved there.

## Preconditions and scope

1. Hosted Photopea is allowed for Image Studio, but the first release excludes `restricted` and unclassified company-drive files. The editor-eligibility check is separate from ordinary drive permissions and must run server-side.
2. Record the exact editor origin, data-flow notice, CSP/frame policy, and test-data handling. Avoid secrets or private file URLs in editor configuration.
3. Revalidate the inspection report against both dirty repositories before coding. Preserve unrelated changes; do not commit without user instruction.
4. Codex activates each small implementation slice in `current-task.md`; later slices are not automatically authorized.

## Sequential slices

### Slice 0 — Contract and deployment proof

Confirm hosted Photopea supports documented configuration, live messaging, `customIO`, `saveToOE`, and the required format(s). Confirm it loads at the configured origin inside the CMS shell and that strict `postMessage` origin/source validation works. Use synthetic non-company files for this first proof. Record undocumented behavior as a limitation; do not invent close/dirty APIs.

**Exit:** Browser proof of editor readiness, binary open, and binary export with a synthetic file. This is not yet a GRAV save.

### Slice 0.5 — Native GRAV presentation before file integration

Refine the existing Image Studio entry and editor routes so the surrounding experience feels like a GRAV module rather than a diagnostic embed. Use the existing shell, navigation, UI primitives, and responsive conventions. Keep Photopea's own editing UI, branding, and ads intact; do not reach into its cross-origin DOM, cover it, or imply GRAV persistence. Remove proof-workbench diagnostics from the employee-facing default view while retaining a development-only or testable diagnostic path for the verified messaging flow. Show an honest editor loading/error state, clear back navigation, and enough viewport height and width to use Photopea. Fix the observed phone-width overlap between the CMS floating top bar and Photopea's menu row. Test desktop and narrow-phone layouts in a browser, including keyboard/navigation basics.

**Exit:** The embedded editor sits naturally in GRAV on desktop and phone widths, its menus are usable, and the synthetic open/export proof still passes. No company-drive bytes or backend save work in this slice.

### Slice 1 — GRAV file contract and safety

Reuse `Doc_File`, existing Drive storage, company scoping, and shared `mayRead` / `mayWrite` logic. Add narrowly scoped authenticated file-byte reads and save/revision operations, with real-byte type checks, file-size limits, CSRF protection appropriate to the deployed auth model, and authorization on every request. Design revision history and Drive cleanup so a rejected conflict cannot leave a misleading append-only history row; consider compare-and-set ordering, a transaction where supported, and recoverable storage-failure states. Do not make an in-memory limiter the sole abuse control for a multi-instance deployment.

**Exit:** Backend contract and negative tests for 401/403/404, malformed content, oversized content, wrong format, conflict, and storage failure. No existing file can be silently overwritten with a different format.

### Slice 2 — Minimal open/edit/save/reopen vertical slice

Add a lazy client-only Photopea adapter, a serialized/testable message coordinator, Image Studio navigation, and the editor route using existing UI conventions. Open one authorized GRAV file through the page's authenticated fetch and binary message transfer. On Save, export the correct format, write through the authenticated backend, and show Saved only after durable GRAV success. Reopen to verify the bytes and metadata. Do not implement a broad file browser first.

**Exit:** Real browser proof with hosted Photopea and one eligible, unrestricted `IMAGE-STUDIO-TEST` development file. Confirm dev connections first; record created Mongo and Drive IDs; delete only those test artifacts, and report any cleanup failure.

### Slice 3 — Save As, export, and file discovery

Save As creates an independent file record linked to the source. Export formats are enabled only after actual format-specific tests. Provide Recent, My, and Shared lists from the existing drive. Do not add Customer Assets without a demonstrated customer/project association. Document local-download actions separately from GRAV-persisted outputs.

### Slice 4 — Hardening, documentation, and release

Test permission revocation behavior, restricted files, SVG active content, large files, conflicting edits, iframe failure, network loss, session expiry, and incomplete storage writes. Define honest last-saved/leave-warning behavior; keep autosave off until a confirmed persistence protocol exists. Document environment configuration, licensing/branding, message flow, rollback/recovery, adapter replacement, and known limitations. Update `docs/handoff/latest-implementation.md` with actual verification only when implementation occurs.

## Review concerns from the initial inspection plan

- A custom `X-Grav-Client` header and CORS preflight are not, by themselves, a complete CSRF design. The existing `SameSite=None` cookie behavior must be considered.
- Writing an immutable previous-revision row **before** a compare-and-set can produce orphan history on conflict. Require a tested consistency and recovery design before adopting that sequence.
- Photopea's `"done"` messages do not mean GRAV persistence succeeded. Its File-menu hooks and export ordering must be verified in the approved browser deployment.
- The editor's `Document.source` is a routing hint, never authorization.
- The company drive's current broad write policy and session-revocation gap remain known cross-application risks; any global change needs its own scope and tests.
