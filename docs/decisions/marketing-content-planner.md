# Marketing Content Planner — backend foundation (2026-09-21)

A planning tool, not a publisher. An item records somebody's intention to
produce a piece of content for a date. Nothing in the planner creates,
schedules, sends or publishes anything. It does not contact an advertising
network, and it does not write to the content library.

## What already existed, and was kept

- **The Content library** (`routes/CMS_Routes/Marketing/contentInventory.js`)
  stays read-only. It is GET-only over the marketing engine's email, form and
  landing-page lists, and it is gated to the configured Marketing company. The
  planner reuses its `list()` and safe row. It adds no endpoint, no single-item
  read and no write. A test pins that the content router still has only GET routes.
- **Campaign plans** are untouched. The planner links to a plan through the
  plan's existing public identifier (`campaignDraftId`, signed and company-bound).
- **The company** is resolved from membership on every request. No parameter
  names one.
- **Permissions** reuse the campaign-plan rule: `admin`/`ceo` approve, and
  `marketing` writes and submits. Sales is refused by `MarketingAuthMiddlewear`.
- **The audit pattern** is append-only history enforced at the model, the same
  as plan history. It lives on the item, so that each write is one atomic,
  revision-fenced `findOneAndUpdate` that sets fields, increments `revision` and
  `$push`es the entry together.

## Decisions

| Decision | Why |
|---|---|
| States are `idea → drafting → in_review → approved`, plus `cancelled` | They describe where the **plan** is. There is no `published`, `scheduled` or `live` state, so nobody can type one. |
| `approved` only means "approved to go ahead" | The state vocabulary says so on every response. |
| Publication is derived at read time from the linked asset's content-library row | The states are `published`, `scheduled`, `not_published`, `unknown`, `asset_missing`, `unavailable` and `no_linked_asset`. Nothing is stored. |
| The library's published flag is not trusted alone | A publish-from date in the future reads `scheduled`; a publish-until date in the past reads `not_published`. |
| `planned` and `actual` are separate objects | `planned` is typed. `actual.{scheduledAt, publishedAt}` come only from the library (`source: "content_library"`) and are `null` otherwise. |
| An asset link must be **confirmed** at write time | Missing from the whole library gives 422. Library unreadable, not configured, or too large to read within 20 pages gives 503 `CONTENT_PLAN_LINK_UNCONFIRMED`, and nothing is saved. `missing` is claimed only after every page was read. |
| A campaign link must exist in this company and not be cancelled or rejected | Otherwise 422 `CONTENT_PLAN_LINK_NOT_FOUND`. A plan that later disappears reads `link: "campaign_missing"`. |
| Owners are company members (`SpCompanyMembership`) | `ownerRef` is an HMAC of company and membership under its own purpose string, so it carries no id and cannot be moved between companies. `"self"` resolves the caller by email or employee reference. |
| Time zones use built-in `Intl` only | A time that doesn't exist (the hour skipped when clocks go forward) is refused. A time that happens twice when clocks go back is the first one. An all-day item is placed by its date in every zone. A timed item is placed by its instant in the viewer's zone. |
| Approval | `approve`, `return` and `cancel_approved` are for admin or CEO. Nobody approves their own submission (compared by id). `return`, `reopen` and `cancel_approved` need a reason. |
| Editing | `idea`/`drafting`: all fields. `in_review`/`approved`: notes only. `cancelled`: nothing. `reopen` clears the approval. |

## Known limits

- **Admins without a membership record.** An administrator with no
  `SpCompanyMembership` row cannot use `ownerRef: "self"`. They can still be
  chosen from `/content-plan/owners` if a row exists.
- **`campaignDraftId` is decodable.** It is the existing public plan
  identifier: signed and company-bound, but base64-decodable (see
  `draftIdentity.js`). The planner does not add a new one.
- **Library size.** Asset confirmation pages through at most 20 × 50 rows per
  kind. A larger library makes a link `unavailable`, never `missing`.

## Contract for Lane B

All routes are under `/api/cms/marketing`. They require Marketing auth, and the
company comes from the session. Errors use the shape
`{ success:false, error:{code,message,details}, message }`.

### Item view (every read and write returns this shape)

```
{
  itemRef: "MCI-<18 hex>", revision: 3,
  title, contentType:{code,label}, channel:{code,label},
  state:{code,label,means},
  planned: null | { date:"YYYY-MM-DD", time:"HH:MM"|null, timeZone, allDay, startsAt:ISO,
                    display?:{date, time|null, timeZone} },   // display: calendar only, viewer's zone
  owner: null | { name, isYou },
  campaign: null | { link:"linked"|"campaign_missing", campaignDraftId|null, reference, name, state|null },
  asset: null | { kind:{code,label}, name, nameIsSnapshot:true },
  publication: { code, label, means },
  actual: { scheduledAt|null, publishedAt|null, source:"content_library"|null, checkedAt|null },
  viewerActions: {
    edit: { allowed, fields:[…], reason|null },
    start|submit|withdraw|approve|return|reopen|cancel|cancel_approved:
      { allowed, reason: null|"not_in_this_state"|"approver_only"|"marketing_only"|"own_submission"|"incomplete",
        reasonRequired }
  },
  createdAt, updatedAt,
  overlapsWith?: n                     // calendar only: other items in the same local minute
  // detail and write responses only:
  brief, notes,
  submission: { missing:[…], submittedAt, submittedBy(name), approvedAt, approvedBy(name) },
  history: [{ revision, action, fromState, toState, changedFields, reason, by(name), at }]
}
```

### Reads

- `GET /content-plan/calendar`
  - Query: `from` and `to` (YYYY-MM-DD, required, at most 62 days apart);
    `timeZone` (default Asia/Kolkata); optional `state`, `channel`,
    `contentType`, `campaign` (a plan reference) and `owner` (`mine` or
    `unassigned`). Cancelled items are excluded unless `state=cancelled`.
  - Response: `{ range:{from,to,timeZone,days}, days:[{date, weekday, items:[itemRef…]}], items:[view…], empty, truncated, filters, contentLibrary:{code,label,means,checkedAt}, permissions:{canCreate, canApprove, approvalRule}, vocabulary }`.
  - `days` contains every date in the range, including empty ones. Within a
    day, all-day items come first, then items by local time.
- `GET /content-plan/items`
  - Query: `page`, `limit` (up to 100), the same filters, and `dated`
    (`planned` or `unplanned`).
  - Response: `{ items, page:{number,size,total,pages}, filters, contentLibrary, permissions, vocabulary }`.
    Dated items come first in time order, then undated ones.
- `GET /content-plan/items/:itemRef` returns `{ item, contentLibrary, permissions, vocabulary }`.
  Another company's item and a missing one give the same 404
  `CONTENT_PLAN_ITEM_NOT_FOUND`.
- `GET /content-plan/owners` returns `{ assignable, owners:[{ownerRef, name, isYou}] }`.

### Writes

The body must not contain unknown keys. Any query parameter on a write is refused.

- `POST /content-plan/items`
  - Body: `{ idempotencyKey, title, contentType, channel, brief?, notes?, campaignDraftId?, ownerRef?, planned?, assetLink? }`.
  - Returns 201, or 200 with `duplicate:true` when the same key is sent with the
    same body. The same key with a different body gives 409 `CONTENT_PLAN_KEY_REUSED`.
- `PATCH /content-plan/items/:itemRef`
  - Body: `{ expectedRevision, …any writable fields }`. `null` clears an
    optional field. The response carries `unchanged:true` when nothing changed,
    and then no revision is used.
- `POST /content-plan/items/:itemRef/actions`
  - Body: `{ expectedRevision, action, reason? }`.
  - A repeat of your own last action returns 200 with `duplicate:true`.

Field formats:

- `planned` is `{ date, time?, timeZone }`. Leaving out `time` makes the item all-day.
- `assetLink` is `{ kind:"email"|"form"|"landing_page", contentId }`, where
  `contentId` is the value the Content library lists. For an email, landing
  page or form item, the linked asset must be the same kind.
- `ownerRef` is `"self"`, an `ownerRef` from `/owners`, or `null`.

### Refusal codes

| Code | Status | Meaning |
|---|---|---|
| `VALIDATION` | 400 | Bad input |
| `CONTENT_PLAN_REVISION_CONFLICT` | 409 | Stale revision; `details` has `currentRevision` and `sentRevision` |
| `CONTENT_PLAN_STATE_CONFLICT` | 409 | Wrong state, frozen fields (`blockedFields`), or submission incomplete (`missing`) |
| `CONTENT_PLAN_DECISION_FORBIDDEN` | 403 | Not an approver, or approving your own submission |
| `CONTENT_PLAN_LINK_NOT_FOUND` | 422 | Linked plan, owner or asset does not exist |
| `CONTENT_PLAN_LINK_UNCONFIRMED` | 503 | The content library could not confirm the asset. Nothing saved |
| `CONTENT_PLAN_KEY_REUSED` | 409 | Idempotency key already used for a different body |
| `CONTENT_PLAN_ITEM_NOT_FOUND` | 404 | No such item for this company |

---

# Creative drafts (2026-09-21, second slice)

The planner's calendar, ownership, approval, revision and "nothing publishes"
rules are unchanged. One new writable field, `creative`, holds one concept, a
set of platform versions and optional references.

## Media: what existed, and the gap

- **Reused:** the Marketing **advertising image library** (`/advertising-assets`).
  - It is company-scoped and holds JPEG and PNG only.
  - Versions are immutable and hashed.
  - Its public identifier (`mai1.…`) is signed and company-bound. The Drive
    location is never published.
  - A preview is already available at `GET /advertising-assets/:assetId/binary`.
- **How a reference is stored:** an image reference is confirmed against that
  library at write time, and the planner records the exact version's hash, name
  and size. The planner adds **no upload, no storage and no URL field**.
  Pointer-shaped keys (`url`, `data`, `base64`, `path`, `file`, `storageRef` …)
  are refused by name.
- **The gap:** there is no company-scoped store for video, audio, documents or
  design files. Those can only be described in a `note` reference, which says
  plainly that no file is stored (`status: not_stored`). The vocabulary publishes
  this as `creative.mediaStore.gap`.
- **Two separate approvals:** an image's own library review ("approved for
  advertising") is not the same as a content item's approval. The reference
  shows the library state beside it.

## Decisions

| Decision | Why |
|---|---|
| Versions live inside one item and have no state, date or publication | One idea is one planned, approved and eventually published thing. Keys such as `state`, `planned` or `publishedAt` on a version are refused. |
| The whole creative is replaced on each write; `variantRef` keeps a version's identity | A new version is minted when no ref is sent, and a version not sent back is removed. An unknown or duplicated ref gives 400. |
| `creative.fingerprint` (`cf1_…`) covers concept, versions, copy, calls to action and the **image hashes** | Swapping a picture for different bytes with the same file name changes the fingerprint. |
| An approval records `approvedRevision` and `approvedCreativeFingerprint`; every history entry records the fingerprint | The item shows `approval.matchesCurrentCreative`. |
| `approve` accepts an optional `creativeFingerprint` | If it differs from the current creative, the approval is refused with 409 even at the current revision. It is refused (400) on any other action. |
| `social_post`, `advert` and `video` cannot be submitted without a concept and copy on every version | This is the `creative` entry in `submission.missing`. |
| The creative is frozen in `in_review` and `approved` (notes stay open); `reopen` clears the approval | Same editing rule as every other field. |
| Foreign, forged, garbage or withdrawn images are refused with 422 `CONTENT_PLAN_LINK_NOT_FOUND` | `details.field` names the exact reference. |
| An image that later disappears reads `missing` with `assetId: null`, keeping its file name and hash; a later withdrawal reads `withdrawn` | The fact is reported, not hidden. |

## Contract additions for Lane B

**Write (POST and PATCH):** `creative` is `null` or:

```
{ concept?: text ≤2000,
  references?: [Ref] ≤10,
  variants?: [{ variantRef?: "var_…" (existing only), platform, format, caption?: text ≤5000,
                callToAction?: { type, text?: ≤80 } | null, references?: [Ref] ≤10 }] ≤10 }
Ref = { kind: "image", assetId: "<advertising image assetId>" } | { kind: "note", text: ≤500 }
```

**Actions:** `approve` may include `creativeFingerprint`; send the fingerprint you displayed.

**Item view (list and calendar):**
`creative: null | { hasConcept, variantCount, platforms:[{code,label}], fingerprint }`

**Item view (detail and write responses):**

```
creative: null | {
  concept, fingerprint,
  references: [RefView],
  variants: [{ variantRef, platform{code,label}, format{code,label}, caption,
               callToAction: null | {code,label,text}, references:[RefView] }] }
RefView (note)  = { kind{code:"note"}, text, status{code:"not_stored"} }
RefView (image) = { kind{code:"image"}, assetId|null, fileName, width, height, contentHash,
                    status{code: available|withdrawn|missing}, libraryState: null|{code,label} }
approval: null | { revision, creativeFingerprint, matchesCurrentCreative }
history[].creativeFingerprint
```

**`vocabulary.creative`:** `requiredFor`, `platforms`, `formats`, `callsToAction`,
`referenceKinds`, `referenceStatus`, `mediaStore{images, formats, otherMedia:false, gap}`,
`variantsMean`, `limits`.

---

# Creative media library (2026-09-21, third slice)

A company-scoped library of **images** for planned social content, referenced
by exact version from creative drafts. It publishes, schedules and approves
nothing. **Video is not supported yet;** the specific blockers are below and in
every response.

## What was inspected, and what was reused

| Existing piece | Used? | Why |
|---|---|---|
| `services/marketing/assets/imageBytes.js` | **Reused** | Format and dimensions read from the bytes; SHA-256 over exactly what arrived; SVG, GIF and WebP identified by content |
| `services/companyDrive.service.js` | **Reused** | Private company Drive: no public permission, read back only through GRAV's authenticated route |
| The advertising image library (`/advertising-assets`) | **Not reused** | Its states mean "approved for advertising". That is a different decision and must not become a social post's approval. It and the Campaign Builder are **untouched**. |
| `routes/Access/files.js` (company Files) | Not reused | A document workspace, capped at 25MB in memory; its code comment says "video belongs somewhere else". Its access model is per document, not per company creative. |

## Video: the specific blockers

Also published as `vocabulary.video.blockers` on every creative-media response.

1. **`upload_buffers_whole_file`.** `companyDrive.uploadCompanyFile` accepts
   only an in-memory `Buffer`. Every upload path in GRAV does the same. Social
   video (tens to hundreds of MB) would hold whole files in server memory, and
   no streaming upload to storage exists.
2. **`no_range_streaming`.** `streamCompanyFile` reads a file from the start to
   the end. No GRAV preview supports `Range`, which a video player needs in
   order to seek.
3. **`integrity_check_reads_everything`.** The safe-preview rule here, as in
   the advertising library, is to re-read and re-hash the whole file before
   showing it. For video that means a full download on every view and every seek.
4. **`no_video_inspection_in_production`.** Verifying a video's container,
   codec and duration needs a tool such as ffprobe. It exists on the
   developer's machine but is not a project dependency or part of the
   deployment, so GRAV cannot tell a playable video from a renamed file.

A video upload is recognised by its signature (MP4 or QuickTime, WebM or
Matroska, AVI) and refused with 415 `CREATIVE_MEDIA_UNSUPPORTED`,
`details.code: "video_not_supported"` and the blocker codes. A written `note`
reference remains the only way to describe a video, and it is labelled
`not_stored`. It is never presented as an uploaded video.

## Decisions

| Decision | Why |
|---|---|
| Images: JPEG and PNG, ≤10MB, 320–8000px on each side | Checked while the bytes arrive (multer) and again in the service before storage. |
| A version is immutable: bytes, hash, size, storage place | Enforced on every update path. A changed file is a new version (`POST /:groupRef/versions`) with a new `mediaRef`. Rows are never deleted. |
| References are random (`cmv_` + 32 hex for a version, `cmg_` + 32 hex for a file) and always looked up together with the caller's company | No database id, no storage id and no URL is published. Another company's reference, a forged one and a missing one give the same 404. |
| Same bytes are one version per company | A re-upload returns the existing version (`deduplicated: true`), and a withdrawn file stays withdrawn. |
| Withdrawal, not deletion | Allowed for the uploader of that version, an admin or the CEO, with a reason. A withdrawn version is never previewed (409). |
| The preview re-hashes the bytes on every request | Bytes changed in storage give 409 `CREATIVE_MEDIA_INTEGRITY_FAILED`, not a wrong picture. Headers: `nosniff`, `private, no-store`, `X-Content-Hash`. |
| Nothing is written before every check passes; the row is written only after storage confirms | Storage failure gives 503 and no row. If the row fails after storage, the stored file is deleted (best effort; a failure to delete is logged). A cut-short or dropped upload gives 400 `CREATIVE_MEDIA_UPLOAD_INCOMPLETE` and nothing is stored. |
| A creative references `{ kind: "media", mediaRef }`, which pins the version and its hash | The fingerprint includes `["media", mediaRef, sha256]`, so switching to another version changes the creative and needs a new approval. A newer version is **never swapped in**; `newerVersionAvailable` says one exists. |
| A withdrawn or missing file stays identifiable and is never shown | The reference keeps `mediaRef`, `groupRef`, `version`, `fileName`, `contentHash` and dimensions, with `status: withdrawn` or `missing` and `previewable: false`. |
| **An approval that included a now-unavailable file is no longer valid** | `approval.valid: false` with `invalidBecause: ["media_withdrawn" \| "media_missing" \| "creative_changed"]`. The item's state is not rewritten on read; somebody must `reopen` and replace the file. |
| Submit and approve are refused while any referenced file is unavailable | 409 `CONTENT_PLAN_STATE_CONFLICT` with `details.unavailableMedia`. `viewerActions.submit` and `viewerActions.approve` show `reason: "media_unavailable"` on detail and write responses. |
| Planned dates, content approval and actual publication stay separate | Nothing in the media library changes an item's `planned` or `actual`. |

**Not verified live:** uploads and reads were tested against an in-memory
stand-in for Drive, never the real company Drive. The Drive path itself is the
same one the advertising image library already uses.

## Contract for Lane B: creative media

All routes are under `/api/cms/marketing` and require Marketing auth (marketing,
admin or CEO; Sales gets 403). The company comes from the session.

### `POST /creative-media`: upload a new file (version 1)

- **Request:** `multipart/form-data` with exactly one part named `file`, plus
  optional text fields `fileName` (≤200; defaults to the part's filename) and
  `note` (≤500). No other field and no query parameters.
- **Response 201:**
  `{ success, media: MediaView, deduplicated:false, means, vocabulary }`
- **Response 200:** the same bytes already exist, so the body carries
  `deduplicated:true` and the existing version, which may be withdrawn.

### `POST /creative-media/:groupRef/versions`: upload the next version

Same request and response as above. The new version gets the next number and
its own `mediaRef`; earlier versions are untouched.

### `GET /creative-media?page&limit(≤100)&state=available|withdrawn`

Response: `{ media: [MediaView + versionCount], page:{number,size,total,pages}, vocabulary }`.
Each row is one file, showing its latest version.

### `GET /creative-media/:groupRef`

Response: `{ groupRef, versions:[MediaView] (newest first), history:[{action: uploaded|version_added|withdrawn, mediaRef, by, at, reason, contentHash}], vocabulary }`.

### `GET /creative-media/versions/:mediaRef/preview`

- Returns the exact bytes (`image/jpeg` or `image/png`) with the headers
  `X-Content-Hash`, `nosniff` and `Cache-Control: private, no-store`.
- Load it with the session (the Bearer token), for example
  `fetch` → `blob` → object URL. There is no public URL.

### `POST /creative-media/versions/:mediaRef/withdraw`

- Body: `{ reason }` (required, ≤300).
- Response: `{ media, duplicate }`.
- Allowed for the uploader of that version, an admin or the CEO; anyone else
  gets 403 `CREATIVE_MEDIA_FORBIDDEN`.

### MediaView

```
{ mediaRef:"cmv_…", groupRef:"cmg_…", version, isLatestVersion,
  kind:{code:"image",label}, format:"JPEG"|"PNG", byteSize, width, height, contentHash,
  fileName, extensionAgreedWithBytes, note,
  state:{code:"available"|"withdrawn",label,means}, previewable,
  uploadedBy(name), uploadedAt, withdrawn: null | {by, at, reason} }
```

### `vocabulary`

`kinds[{code,label,supported}]`, `states`,
`image{formats,maxBytes,minWidth,minHeight,maxWidth,maxHeight}`,
`video{supported:false, means, blockers[{code,label,means}]}`, `approvalMeans`,
`limits`.

### Errors

| Code | Status | Meaning |
|---|---|---|
| `CREATIVE_MEDIA_NOT_FOUND` | 404 | Unknown, forged or another company's reference |
| `CREATIVE_MEDIA_WITHDRAWN` | 409 | Preview of a withdrawn version |
| `CREATIVE_MEDIA_INTEGRITY_FAILED` | 409 | Stored bytes changed |
| `CREATIVE_MEDIA_UPLOAD_INCOMPLETE` | 400 | The upload was cut short |
| `CREATIVE_MEDIA_TOO_LARGE` | 413 | Over the size limit |
| `CREATIVE_MEDIA_UNSUPPORTED` | 415 | `details.code`: `video_not_supported`, `gif_not_supported`, `svg_not_supported`, `webp_not_supported` or `not_an_image` |
| `VALIDATION` | 400 | Dimensions (`too_small`, `too_many_pixels`), extra fields, no file or two files, not multipart |
| `CREATIVE_MEDIA_STORAGE_UNAVAILABLE` | 503 | Nothing saved, or the file could not be read |
| `CREATIVE_MEDIA_FORBIDDEN` | 403 | Not allowed to withdraw |

In every failure case, nothing is stored.

### In the Content Planner

- **New reference kind.** `{ kind:"media", mediaRef }` is allowed in
  `creative.references` and `creative.variants[].references`. Foreign, forged,
  malformed or withdrawn references give 422 `CONTENT_PLAN_LINK_NOT_FOUND`, and
  `details.field` names the exact reference.
- **Media reference view:**

```
{ kind:{code:"media",label}, mediaRef, groupRef, version, fileName, format, width, height, contentHash,
  status:{code:"available"|"withdrawn"|"missing",label}, previewable, newerVersionAvailable }
```

  Show a preview only when `previewable` is true. For withdrawn or missing
  files, show the file name, version and hash with the status, and never
  substitute another file.
- **Detail and write responses gain:**
  - `unavailableMedia: [{kind, reference, fileName, contentHash, status}]`
  - `approval: null | { revision, creativeFingerprint, matchesCurrentCreative, mediaIntact, valid, invalidBecause:[…] }`
  - `viewerActions.*.reason` may be `"media_unavailable"`. This is not
    computed on list and calendar rows; the command still refuses.
- **When `approval.valid` is false:** show the approval as no longer standing.
  The fix is `reopen` (reason required), replace the file, then submit again.

---

# Creative-media contract corrections (2026-09-21)

This correction supersedes the earlier sections wherever they differ.

## 1. Approval validity on every row

- **One decision, used everywhere.** A single function decides whether an
  approval stands (`approvalDecision` in `contentPlan.service.js`). The
  calendar, the list, the detail read and write responses all use it, with
  file states loaded in one batch per page.
- **Validity is separate from state.** `state` keeps what was recorded
  (`approved`), and `approvalStatus` says whether that approval still stands.
- **What counts as invalid:** a withdrawn, missing or changed file in the
  creative (for advertising images, withdrawn or missing only), or a creative
  that differs from the approved fingerprint.
- **"Changed" is now observable without a download.** When the authenticated
  preview finds a stored copy that no longer hashes to its version, it records
  `integrityFailedAt` on that version. This is the version's one other
  writable field besides withdrawal; its bytes fields are still immutable.
  Every read then reports it. A later preview that finds the exact bytes back
  clears the flag.

**On every item view (list, calendar, detail, writes):**

```
approvalStatus: {
  code: "not_approved" | "valid" | "invalid",
  label, means,
  invalidBecause: [{ code: "creative_changed"|"media_withdrawn"|"media_missing"|"media_changed", label }]
}
unavailableMediaCount: n
```

- These fields carry codes and words only: no file names, references, hashes
  or storage details.
- `viewerActions.submit` and `viewerActions.approve` now show
  `reason: "media_unavailable"` on list and calendar rows too; this was
  previously detail-only.

**Detail only (unchanged fields, same decision):**
- `approval.valid` equals `approvalStatus.code === "valid"`.
- `approval.invalidBecause` holds the same codes, now possibly including
  `media_changed`.
- `unavailableMedia[].status` may be `changed`.

**Display rule for Lane B:** show `state.label`, and when `approvalStatus.code`
is `invalid`, show `approvalStatus.label` beside it (for example "Approved -
Approval no longer stands"). Never show a plain "Approved" when the code is
`invalid`.

## 2. Withdraw actions on the creative media library

Every `MediaView` (upload responses, the list, detail versions and the withdraw
response) now carries:

```
viewerActions: { withdraw: { allowed, reason: null|"marketing_only"|"not_uploader"|"already_withdrawn",
                             reasonLabel: null|string, reasonRequired: true } }
```

- The view and the server use the same predicate (`withdrawProblem`).
- The server still enforces it on its own: 403 `CREATIVE_MEDIA_FORBIDDEN` for
  `not_uploader` or `marketing_only`. Withdrawing an already-withdrawn version
  returns `duplicate: true` to anyone allowed to withdraw.
- Another company's version is 404 everywhere.
- Words: `vocabulary.withdrawRefusals`.

**`MediaView` also gains:**
- `storedCopyChanged` (boolean).
- `previewable` now also needs the stored copy to match (`available` and not
  changed).

## 3. Wording

- **Reference status words come from the library the file lives in:**

| Kind | Status labels |
|---|---|
| `media` | "In the creative media library", "Withdrawn from the creative media library", "No longer in the creative media library", "Stored copy changed" |
| `image` | "In the advertising image library", "Withdrawn from the advertising image library", "No longer in the advertising image library" |

- The `image` reference kind is now labelled "Image from the advertising image
  library".
- `vocabulary.creative.referenceStatus` keeps generic codes and neutral words,
  and **`vocabulary.creative.referenceStatusByKind`** holds the per-library
  words that responses use.
- New vocabulary: `vocabulary.approvalStatus` and `vocabulary.approvalInvalidReasons`.

## 4. Preview hash header

- A successful `GET /creative-media/versions/:mediaRef/preview` now sends
  `Access-Control-Expose-Headers: X-Content-Hash`, on that response only.
- Refused previews send neither header. No other route exposes a header.
- The app's CORS origin check is unchanged, so only admitted origins can read
  it. Tested behind a real `cors` middleware:
  - an admitted origin reads the header;
  - a stranger origin gets no `Access-Control-Allow-Origin`.
- **Keep the in-browser byte check.** The header is a second witness to the
  hash, not a replacement for hashing the bytes.

## Real-storage verification: still outstanding

No signed-in development environment was available: no backend was running and
there was no browser session. Starting one would have required minting a
sign-in token, which this work does not do. One real upload and authenticated
preview against the company Drive has **not** been performed.
