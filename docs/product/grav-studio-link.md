# GRAV Studio ↔ CMS (14 Oct 2026)

The owner's flow: Sales raises a sample, Merchandising does the materials and BOM, and Sales routes the style to Design (R&D) as today. From that moment the designer's **Styles** board shows a **GRAV Studio card** for the style: the brief and specification, plus **Create in GRAV Studio**. That button links a 3D file to the style and opens the desktop app on it. The file also waits on the app's start screen. The designer makes the garment and uses **File › Send for Review** in the app, which sends the project, five renders and the flats as a new version. **Sales** reviews the renders and either approves them or asks for changes with a note. The designer sees the answer on the card and in the app, and their next send becomes the next version.

Owner decisions (14 Oct):
- Routing stays as it is today.
- Create both links the file and opens the app.
- Designers sign in to the app with a key an administrator issues.
- The review is **Sales'**, not Merchandising's ("its not merchandiser it is from sales"), and Sales' side starts from its **pipeline page**. The merchandiser review was removed the same day; the Sales side is the next step and is not built yet.

## Data — embedded (the cluster is at its collection cap)
- `SampleStyle.studio` (`models/CMS_Models/Sales/sampleStudioSchema.js`):
  - `status`: linked → in_progress → in_review → changes | approved
  - `fileId`, `linkedAt/By`, `openedAt`, `designer`
  - `versions[]`: `{version, sentAt, sentBy, note, appVersion, project, renders[], flats[], manifest, outcome, feedback, decidedAt, decidedBy}`
  - Each step is also written to `history[]` (studio_linked / opened / sent / approved / changes).
- `AccessDepartment.studioKeys` on `research-development`:
  - `select: false`, and only a SHA-256 of each key is stored. The key itself is shown once, when it is issued.
  - Each record keeps the holder, the company, the issuer, lastUsedAt and revokedAt.
  - Every use re-checks that the holder still has a Design (R&D) role.
- Files are private company-Drive objects named `GRAV Studio / <style> / v<N> / <file>` (`services/studio/studioStorage.service.js` → `companyDrive.service.js`). They are only ever read back through the authenticated routes, which check that the file id belongs to that style.

## Routes
CMS side, `/api/cms/studio-link` (`routes/CMS_Routes/Sales/sampleStudio.js`, session JWT, company-scoped):

| method | path | who |
|---|---|---|
| GET | `/styles?view=design\|review` | the cards / the review list |
| GET | `/styles/:id` | one style's card and every version |
| POST | `/styles/:id/link` | Design (R&D), or an administrator |
| POST | `/styles/:id/versions/:v/decide` `{outcome: approved\|changes, feedback}` | for now an administrator or the CEO (Sales is added with its pipeline page); Merchandising is refused; only the newest pending version |
| GET | `/styles/:id/files/:fileId` | a render, flat or project file |
| GET/POST | `/keys`, GET `/keys/people`, POST `/keys/:keyId/revoke` | administrators only |

GRAV Studio side, `/api/studio/v1` (`routes/Studio/studioApi.js`, `Authorization: Bearer gsk_…`):

| method | path | what |
|---|---|---|
| GET | `/me` | who the key belongs to |
| GET | `/samples` | the start screen's cards |
| GET | `/samples/:id` | one style: brief, specs, images, every version and its answer |
| POST | `/samples/:id/open` | the app made or reopened the file |
| GET | `/samples/:id/files/:fileId` | a brief image or a sent file |
| POST | `/samples/:id/versions` | multipart send (limits below) |

Version upload limits: `project` up to 150 MB; 1–12 `renders` (PNG); up to 4 `flats` (PNG or SVG); `manifest`; `note`.

Notifications (`departmentNotify.service`):
- `studio_review_decided` goes to Design (R&D).
- Nobody is emailed that a version is waiting yet. That email comes back for Sales with its pipeline page.

## CMS screens (grav-cms, branch `studio-link`)
- R&D Styles board: a "GRAV Studio" panel with the cards (`components/studio/StudioCardsPanel.js`, `StudioCard.js`).
- Review: Sales, from its pipeline page (next step). The merchandiser panel and review page built first were removed on the owner's word.
- CEO › Access control: "GRAV Studio keys" (issue, copy once, revoke).

## Tests
- `test/studio/studioLink.route.test.js`: 5 tests over real HTTP on an in-memory MongoDB. They cover issuing keys, the card, open, send, review, resend, company isolation, role loss and revocation.
- Also checked end to end against the desktop app. A local harness mounts these route files on an in-memory database with stand-ins for Drive, email and company scope. It never touches Atlas.

## Before it goes live (owner's OK needed)
- Merge and deploy are the owner's call. Nothing has been pushed.
- `API_PUBLIC_URL` must be the public backend address: it goes into the `gravstudio://` link.
- The app registers `gravstudio://` for the Windows user after sign-in. The release installer should register it too.
