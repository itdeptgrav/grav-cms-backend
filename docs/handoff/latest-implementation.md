# Latest implementation — R&D 3D workspace: why it would not open, and what now opens it

1 Oct 2026. **Committed on `NEW_CMS_BRANCH` in both repositories. Five grant
rows and three demo accounts were written to the dev Atlas database; nothing
else was.**

## What was wrong

`http://localhost:3001/research-development/styles/<id>/workspace-3d` rendered a
near-empty black canvas reading *"Technical records are the R&D team's."*

The signed-in account (`ray@grav.in`) was an **active employee with exactly one
active GRAV CLOTHING membership and no `research-development` row in
`department_roles`**. Company resolution succeeded; the R&D capability check
refused. Proven by HTTP, not by reading code:

```
GET /api/cms/rnd/garment-models/styles/6abb3397de13c635ae989477
→ 403 FORBIDDEN
  details.requires = { department: "research-development",
                       capability: "rnd.model.read", minimumRole: "viewer" }
```

Before the fix **one** R&D grant existed in the entire database — `ceo@grav.in`,
owner, on an account with no Employee record. So the workspace had never been
openable by anybody who could sign in and reach it.

Two things made a correct refusal look like a crash, and both are fixed here:

- the refusal rendered **outside** the department shell, as a full-screen dark
  canvas with one line of grey text — no company, no way back, nothing to click;
- the viewer **mounted anyway**: a WebGL context, a loader and a render loop
  were started for a model the server had already refused to describe.

## What was NOT done

Authorisation is unchanged. No job title in a token became authority, no admin
became an automatic R&D user, the capability middleware is still in front of
every model route, and no foreign-company style was made readable. The fix is
access *data* plus an honest screen.

## The fix

### 1 · `scripts/seed/rndWorkspaceAccess.js` — the demo grants, idempotently

Three accounts, three roles, three different people — the separation matters
because a publisher cannot accept their own model, so a one-account demo cannot
show an approval at all:

| Account | Role | May |
|---|---|---|
| `rnd.editor.demo@grav.demo` | editor | view, upload, annotate, submit |
| `rnd.approver.demo@grav.demo` | approver | review and approve, plus everything an editor can |
| `rnd.viewer.demo@grav.demo` | viewer | inspect models and read notes, change nothing |

Each gets an Employee record, a `DeptUser` sign-in account, an active
`SpCompanyMembership` for GRAV CLOTHING and an active `research-development`
grant. `--grant-editor <email>` attaches a grant to a **real existing** account
and refuses to invent an employee record for one that does not exist; that is
how `ray@grav.in` — the account that hit the failure — became an editor.

Grants are written through `departmentRoles.setRole` under
`ALLOW_FIXTURE_ROLE_WRITES=1`, the declared fixture path (GAC-2's single-writer
rule), following the `scripts/ie/ieDemoScenario.js` precedent.

Passwords are never printed. `RND_DEMO_PASSWORD` if set, otherwise a random one
written to `.rnd-demo-credentials.local` (mode 0600, git-ignored) — a seeder
that prints a working credential has published it to every terminal history and
CI log that ever sees the run.

`--dry-run` reports what it would change and writes nothing.

### 2 · `GET /api/cms/rnd/garment-models/context` — deliberately not behind the capability

The one call a refused screen can make. Session and company only; it returns the
company's **name** and plain booleans (`canOpen`, `canAnnotate`, `canPublish`,
`canApprove`) — no capability keys, no role vocabulary, no style, no model. A
screen that could only explain a refusal to somebody who had not been refused
would help nobody.

### 3 · `AccessDenied` — a panel, not a black screen

Inside the R&D shell: *"You don't currently have access to the R&D 3D
workspace."*, the company it is about, **Back to style**, **Retry**, and **Open
Access Control** only for someone the route would actually open for. It names no
capability, role key, HTTP code or API path.

### 4 · The canvas waits for both answers

`Workspace3D` returns the panel for 401/403/404 before the element the engine
attaches to is ever rendered, and gates the viewer on the publication's metadata
having loaded. The engine is created from a callback ref that cannot fire until
that element exists, so a refused request cannot reach three.js.

### 5 · The company goes with every request

One `companyHeader` helper, one `fetch` in the adapter, and
`assetUrl(url, companyId)` appends `actingCompanyId` because an `<img>` and a
`GLTFLoader` send no headers. Every loading effect lists `companyId` in its
dependencies, so changing company re-asks rather than redrawing stale data.

### 6 · A real defect the tests could not see

`createDraft` stored `str(up?.id || up?.fileId || up)` as the Drive handle.
`uploadCompanyFile` returns `{ driveFileId, mimeType, bytes }` — so the fallback
chain ended at the object itself and **every publication stored the literal
string `"[object Object]"`**, and every asset request answered 500. The suite
passed throughout, because the mock returned `{ id, name }` — a shape the real
service has never returned. The mock now matches its subject, and the caller
reads one named field with no fallback.

## A finding that is not a bug

A probe account whose only membership was another company still read the GRAV
style. That is **GAC-AR1** (`docs/decisions/single-organisation-access-control.md`,
25 Sep 2026): GRAV is one organisation, so internal apps resolve the company
server-side from `Acc_Company.isPrimary` and do not consult
`SpCompanyMembership` at all. An internal employee cannot be "from another
company" on this deployment; the probe read the style because I had given it an
R&D grant. Remove the grant and it is refused. Verified live:

- no grant → the real style and an invented id return **byte-identical** 403s,
  so existence cannot be inferred;
- `X-Costing-Company` or `actingCompanyId` naming another company →
  `TENANT_MEMBERSHIP_UNPROVEN`, refused rather than honoured.

`styleForCompany` still filters by ownership and is pinned by the suite's
tenancy tests, which run against an in-memory database with no primary company —
the path where memberships *are* the authority.

## Verification

Live, on the normal application at
`http://localhost:3001/research-development/styles/6abb3397de13c635ae989477/workspace-3d`
(backend on :5001), signed in through the ordinary screens:

model loads (7,424 triangles) · orbit/zoom/reset move the camera · a marker
saves and comes back at the **same anchor after reload**
(`local: [-0.067842, -0.008663, 1.58588]`) · submit → `IN_REVIEW` · a **separate**
approver → `APPROVED`, `decidedBy: "R&D Approver (demo)"` · the viewer's 9
inputs, 1 textarea and 3 selects are all disabled with no save and a server 403 ·
the no-grant account gets the panel with **no canvas and no engine**.

Screenshots: `docs/product/reference-images/rnd-3d-port3001-editor-2026-10-01.png`,
`rnd-3d-port3001-viewer-2026-10-01.png`, `rnd-3d-access-denied-2026-10-01.png`.

Tests:

| Suite | Result |
|---|---|
| `test/rnd/garment-model.route.test.js` | 48 passed (40 before; +8) |
| `test/rnd/demo-access-seed.test.js` | 5 passed (new) |
| `npx jest test/rnd test/access` | 242 passed, 4 failed |
| `components/rnd/**` (frontend) | 192 passed |

The 4 failures are in `test/access/department-role-cache.test.js` and
`test/access/gac-ar1-app-access.test.js`. They fail identically on a clean
worktree at `HEAD` — pre-existing and unrelated to this work.
