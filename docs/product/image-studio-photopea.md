# GRAV Image Studio — Photopea product plan

**Date:** 2026-09-21  
**Status:** Approved product direction; phased implementation  
**Scope:** Internal employees, existing GRAV CMS and company drive

## Outcome and boundary

GRAV CMS should provide **Creative → Image Studio** inside its application shell. An authorized employee can choose a company-drive image, edit it in Photopea, save it to GRAV, and reopen it without a manual download/upload cycle. Photopea is the only editor in this plan. GRAV owns navigation, identity, file records, storage, permissions, and save confirmation; Photopea supplies editing.

Do not build a Canva-like editor, import Fabric.js, or create a second file-management system. Keep Photopea behind a small editor adapter so a future product decision can replace it without rewriting GRAV's file workflows.

## Data-handling decision and release boundary

The user has explicitly allowed **hosted Photopea at `photopea.com`** for Image Studio. A browser-to-iframe `ArrayBuffer` transfer still provides the file bytes to code executing in the third-party Photopea page; avoiding a public file URL does not eliminate that disclosure. The UI and documentation must make the hosted-editor boundary clear.

For the first release, allow only **unrestricted** files that the employee may read under GRAV's existing drive rules. Block files marked `restricted` from being opened in hosted Photopea by default, even for their owner/admin, until that narrower disclosure is explicitly approved. Missing or ambiguous classification is treated as restricted. Apply this as a separate server-enforced editor-eligibility check, not as a change to the drive's ordinary read/write permissions. Do not substitute another editor without approval. Keep the Photopea origin configurable and verify the current vendor terms and API before launch.

Before implementation, record the deployment owner, license/contract, exact editor origin, network/data-flow review, logging/telemetry expectations, supported browser/CSP configuration, availability and upgrade ownership, and approval to use development company-drive data. Do not assume self-hosting alone resolves all privacy or security questions.

## Existing GRAV fit (inspection report, to revalidate before coding)

- Frontend: `/Users/risheeray/grav-cms`, Next.js 16 App Router and React 19, existing shell and File Manager patterns.
- Backend: `/Users/risheeray/grav-cms-backend`, Express, Mongoose, `Doc_File`, `/api/files`, and private Google Drive storage through `companyDrive.service.js`.
- The company drive is the canonical file and permission system. Image Studio inherits its server-side `mayRead` / `mayWrite` semantics, including the current owner/admin rule for `restricted` files. This is intentionally a reuse decision, not an endorsement of the drive's broad unrestricted-file write policy.
- Shared files are already represented by `sharedWith`. Customer Assets are not a first-release section unless an existing customer/project association is demonstrated.
- The current drive has no content-replacement endpoint or file revision model. Those capabilities require design and verification before editor work can be complete.

The report identified security weaknesses in existing file handling: browser-supplied MIME is trusted on upload, revoked sessions may remain valid until token expiry, and production cookies use `SameSite=None` without a general CSRF defense. Image Studio must not copy these weaknesses into new write endpoints; broader drive remediation should be separately scoped and tracked.

## First-release experience

- Image Studio should read as a GRAV workspace: consistent Creative navigation, title/context, spacing, typography, loading/error presentation, and a clear route back. Photopea remains the editor surface inside that workspace, with its own controls and branding visible. Do not cover its menu row, crop ads/branding, inject CSS into the iframe, or imitate editor controls merely for appearance.
- On narrow screens, give the editor an unobstructed usable viewport or an honest minimum-width/rotate-device treatment; the CMS top bar must not overlap Photopea's menus. Browser-test desktop and phone widths.
- Landing page: Recent Files, My Files, Shared Files where access already supports them, Open File, and New Document. Do not invent Customer Assets data.
- Editor page: hosted Photopea within the CMS shell, loading and failure states, file title, last **confirmed GRAV save**, Save, Save As, applicable Export actions, and Back to Image Studio.
- Do not promise a dirty indicator or autosave unless a supported Photopea signal and an acknowledged GRAV persistence flow are demonstrated. A conservative leave warning is acceptable if labelled honestly.
- Distinguish Photopea's local-download actions from saving to GRAV. Do not hide or alter vendor branding by unsupported means.

## File lifecycle

1. Authenticate and authorize the employee for the specific GRAV file and company scope on the backend.
2. Check Image Studio eligibility, fetch authorized bytes into the CMS page, and transfer them to the configured Photopea iframe through documented live messaging; do not expose a permanent public URL or place credentials in editor configuration.
3. Associate the editor document with an opaque GRAV file identity through a documented mechanism. Recheck identity before Save, but never treat editor-provided identity as authorization.
4. Request the appropriate output format from Photopea. The CMS sends the bytes to a GRAV endpoint, which independently checks authorization, actual file content, size, format, revision/concurrency, and storage result.
5. Show **Saved** only after GRAV confirms durable storage and metadata. Reopen the saved file as the acceptance proof.

Save on an existing file creates a new revision, not a silent format change. A PSD must never be replaced by flattened PNG bytes while retaining a PSD identity. Save As creates a separate `Doc_File`; Export creates a separately identified derivative or an explicitly local download. Preserve an editable source where practical. SVG opening and SVG round-trip saving are separate capabilities: SVG save remains disabled until safe export and sanitization are proven. Large-file limits must reflect both GRAV storage policy and browser/editor memory constraints.

## Acceptance and non-goals

The first usable release requires an authorized employee to open, edit, Save, and reopen one eligible GRAV file through hosted Photopea, with no manual download/upload and no false save confirmation. It also requires permission-denial, restricted-file, invalid-content, oversized-file, conflict, and storage-failure tests. Browser testing against development MongoDB and Drive may create only clearly identified `IMAGE-STUDIO-TEST` records/files after confirming the targets are development resources; record exact IDs, remove only those created by the test, and report any cleanup failure.

Not in the first release: autosave, customer-asset linking without an existing relationship, company font/plugin integration, global drive permission redesign, a custom image editor, restricted-file disclosure to hosted Photopea, or white-label presentation.

## References

- Photopea API: <https://www.photopea.com/api/>
- Live Messaging: <https://www.photopea.com/api/live>
- Environment and `customIO`: <https://www.photopea.com/api/environment>
- Scripting and `saveToOE`: <https://www.photopea.com/learn/scripts>
- Account and self-hosted offering: <https://www.photopea.com/api/accounts>
- Architecture decision: `docs/decisions/image-studio-photopea-boundary.md`
- Planned task: `docs/tasks/image-studio-photopea.md`
