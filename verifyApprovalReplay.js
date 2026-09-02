// verifyApprovalReplay.js
//
// An approval actually applies, a rejection actually rejects, and neither can
// happen twice.
//
// Run:  node -r dotenv/config verifyApprovalReplay.js
//
// THE BUG THIS PINS
// The replay token carried `role: departmentSlug` — "hr" — while the routes it
// replays into check the login role, "hr_manager". So every approval of an
// employee edit died with "Permission denied" regardless of who approved it,
// and because a `failed` request was terminal, the second attempt said "this
// request has already been failed". The owner had no way through.
//
// Its own rows are created under a throwaway department slug and deleted
// again, on crash too. It never replays against a real route — the token is
// decoded and checked directly, so no employee record is touched.

"use strict";

const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const SLUG = "verify-approvals";
const MARK = "verify@grav.invalid";

/* Real ObjectIds: the change log casts actor ids, and a harness that fed it
   "2" was exercising only its error path. */
const OWNER = new mongoose.Types.ObjectId();
const OTHER = new mongoose.Types.ObjectId();
const EDITOR = new mongoose.Types.ObjectId();

let pass = 0;
let fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass += 1; console.log(`  ok    ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ""}`); }
};

async function cleanup() {
  const ChangeRequest = require("./models/Access/ChangeRequest");
  const ChangeLog = require("./models/Access/ChangeLog");
  let n = (await ChangeRequest.deleteMany({ departmentSlug: SLUG })).deletedCount;
  n += (await ChangeLog.deleteMany({ departmentSlug: SLUG })).deletedCount;
  /* The one row the harness writes outside its own slug: the seeded login-
     collection entry, and any "hr" request left behind by a crash mid-test.
     Both keyed to the harness email so a real record can never match. */
  n += (await ChangeRequest.deleteMany({ "requestedBy.email": MARK })).deletedCount;
  try {
    n += (await mongoose.connection.db
      .collection("hrdepartments")
      .deleteMany({ email: MARK })).deletedCount;
  } catch { /* collection may not exist */ }
  return n;
}

const mkRequest = (over = {}) => ({
  departmentSlug: SLUG,
  section: "hr:employees",
  entity: "employee",
  entityId: "000000000000000000000000",
  entityLabel: "TEST PERSON",
  action: "update",
  summary: "Changing Email.",
  changes: [{ label: "Email", from: "a@x.com", to: "b@x.com" }],
  intent: { method: "PUT", path: "/api/employees/000000000000000000000000", body: { email: "b@x.com" } },
  requestedBy: { id: String(EDITOR), email: MARK, name: "Test Editor", role: "hr_manager", userType: "hr" },
  status: "pending",
  ...over,
});

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  console.log(`\nconnected to ${mongoose.connection.name}\n`);

  const ChangeRequest = require("./models/Access/ChangeRequest");
  const { SECRET } = require("./config/jwt");
  const svc = require("./services/changeRequests");

  await cleanup();

  /* ── the replay runs with a REAL role ─────────────────────────────────── */
  console.log("the replay carries the requester's actual role");

  /* applyChangeRequest builds the token then calls the route. The route is
     what we are NOT exercising here, so the token is read back off the
     outbound request by stubbing fetch — that is the value under test. */
  const realFetch = global.fetch;
  let seen = null;
  global.fetch = async (url, opts) => {
    seen = { url, headers: opts.headers, body: opts.body };
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  };

  const cr = await ChangeRequest.create(mkRequest());
  await svc.applyChangeRequest(cr);
  const claim = jwt.verify(String(seen.headers.Authorization).replace("Bearer ", ""), SECRET);

  check("the token's role is the requester's login role, not the slug",
    claim.role === "hr_manager", `got "${claim.role}"`);
  check("and it is NOT the department slug that used to be sent",
    claim.role !== SLUG);
  check("the requester is still who the change is attributed to",
    claim.email === MARK && claim.id === String(EDITOR));
  check("the approver travels separately in the headers",
    Object.keys(seen.headers).some((h) => /approver/i.test(h)),
    Object.keys(seen.headers).join(", "));
  check("the replay is marked as one, so the guard lets it through",
    Boolean(seen.headers[svc.REPLAY_HEADER]));

  /* ── an OLD request, held before the role was stored ──────────────────── */
  console.log("\na request held before the fix still resolves a role");
  const legacy = await ChangeRequest.create(mkRequest());
  /* Strip the role the way every row already in the queue has it: absent. */
  await ChangeRequest.updateOne(
    { _id: legacy._id },
    { $unset: { "requestedBy.role": "", "requestedBy.userType": "" } },
  );
  const reloaded = await ChangeRequest.findById(legacy._id);
  check("the stored role really is gone", !reloaded.requestedBy.role);
  seen = null;
  await svc.applyChangeRequest(reloaded);
  const legacyClaim = jwt.verify(String(seen.headers.Authorization).replace("Bearer ", ""), SECRET);
  /* No legacy collection matches this throwaway slug, so it lands on the last
     resort — which is the OLD behaviour, and must still be reached rather than
     throwing. The point is that it degrades instead of breaking. */
  check("it falls back without throwing", typeof legacyClaim.role === "string",
    `role="${legacyClaim.role}"`);

  /* THE CASE THAT MATTERS IN PRODUCTION: the requester IS in the department's
     login collection, which is where the old failed rows' role has to come
     from. Seeded here under the harness email and removed again — this is the
     exact lookup that lets the requests already sitting in the Failed tab be
     retried successfully. */
  const hrCol = mongoose.connection.db.collection("hrdepartments");
  await hrCol.insertOne({ email: MARK, role: "hr_manager", name: "Seeded", isActive: true });
  const oldHr = await ChangeRequest.create(mkRequest({ departmentSlug: "hr" }));
  await ChangeRequest.updateOne(
    { _id: oldHr._id },
    { $unset: { "requestedBy.role": "", "requestedBy.userType": "" } },
  );
  seen = null;
  await svc.applyChangeRequest(await ChangeRequest.findById(oldHr._id));
  const hrClaim = jwt.verify(String(seen.headers.Authorization).replace("Bearer ", ""), SECRET);
  check("an old HR request resolves hr_manager from the login collection",
    hrClaim.role === "hr_manager", `got "${hrClaim.role}"`);
  check("which is exactly what PUT /api/employees/:id requires",
    hrClaim.role === "hr_manager");
  await hrCol.deleteOne({ email: MARK });
  await ChangeRequest.deleteOne({ _id: oldHr._id });

  global.fetch = realFetch;

  /* ── a failed request can be retried ──────────────────────────────────── */
  console.log("\na failed request is not a dead end");
  const failed = await ChangeRequest.create(mkRequest({
    status: "failed",
    applyError: "Permission denied",
    decidedBy: { id: String(OWNER), email: "owner@grav.invalid", name: "Owner" },
    decidedAt: new Date(),
  }));

  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
  const retry = await svc.decideChangeRequest({
    id: String(failed._id),
    decision: "approve",
    actor: { id: String(OWNER), email: "owner@grav.invalid", name: "Owner" },
  });
  global.fetch = realFetch;

  check("approving a failed request retries it instead of refusing", retry.ok === true,
    retry.message);
  check("and it lands as approved",
    (await ChangeRequest.findById(failed._id)).status === "approved");
  check("the stale error from the first attempt is cleared",
    !(await ChangeRequest.findById(failed._id)).applyError);

  /* ── a failed request can also be closed ──────────────────────────────── */
  const failed2 = await ChangeRequest.create(mkRequest({ status: "failed", applyError: "boom" }));
  const rej = await svc.decideChangeRequest({
    id: String(failed2._id), decision: "reject",
    actor: { id: String(OWNER), email: "owner@grav.invalid", name: "Owner" },
  });
  check("rejecting a failed request closes it", rej.ok === true);
  check("and it lands as rejected",
    (await ChangeRequest.findById(failed2._id)).status === "rejected");

  /* ── the same change cannot be applied twice ──────────────────────────── */
  console.log("\nthe same change cannot be applied twice");
  const once = await ChangeRequest.create(mkRequest());
  let replays = 0;
  global.fetch = async () => {
    replays += 1;
    /* Slow enough that a second caller would overlap a naive read-check-write. */
    await new Promise((r) => setTimeout(r, 120));
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  };
  const both = await Promise.all([
    svc.decideChangeRequest({ id: String(once._id), decision: "approve", actor: { id: String(OWNER), email: "o@x.com", name: "O" } }),
    svc.decideChangeRequest({ id: String(once._id), decision: "approve", actor: { id: String(OTHER), email: "p@x.com", name: "P" } }),
  ]);
  global.fetch = realFetch;

  check("exactly one approver wins", both.filter((r) => r.ok).length === 1,
    both.map((r) => `${r.ok}:${r.message || r.code}`).join(" | "));
  check("the change was replayed exactly once — no double apply", replays === 1, `${replays}`);
  check("the loser is told why, not silently ignored",
    both.some((r) => !r.ok && /already|applying/i.test(r.message || "")),
    both.map((r) => r.message).join(" | "));

  /* ── a failed apply is recorded as FAILED, never as approved ──────────── */
  console.log("\na failed apply is recorded as failed, not approved");
  const ChangeLog = require("./models/Access/ChangeLog");
  const doomed = await ChangeRequest.create(mkRequest());
  global.fetch = async () => ({
    ok: false, status: 403, json: async () => ({ message: "Permission denied" }),
  });
  const bad = await svc.decideChangeRequest({
    id: String(doomed._id), decision: "approve",
    actor: { id: String(OWNER), email: "o@x.com", name: "O" },
  });
  global.fetch = realFetch;

  check("the decision reports failure", bad.ok === false);
  check("the request lands as failed",
    (await ChangeRequest.findById(doomed._id)).status === "failed");

  const entry = await ChangeLog.findOne({ departmentSlug: SLUG, entityId: doomed.entityId })
    .sort({ createdAt: -1 }).lean();
  check("the history entry's action is `fail`, not `approve`",
    entry?.action === "fail", `got "${entry?.action}"`);
  check("so the badge cannot read Approved on a change that never happened",
    entry?.action !== "approve");
  check("and the summary leads with the outcome",
    /^NOT applied/.test(entry?.summary || ""), entry?.summary);
  check("which still names who decided it",
    /decided by/i.test(entry?.summary || ""));

  /* A successful one must still be filed as an approval. */
  const good = await ChangeRequest.create(mkRequest());
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
  await svc.decideChangeRequest({
    id: String(good._id), decision: "approve",
    actor: { id: String(OWNER), email: "o@x.com", name: "O" },
  });
  global.fetch = realFetch;
  const okEntry = await ChangeLog.findOne({ departmentSlug: SLUG, entityId: good.entityId, action: "approve" })
    .sort({ createdAt: -1 }).lean();
  check("a successful approval is still filed as `approve`", Boolean(okEntry));
  check("and says it was applied", /applied/.test(okEntry?.summary || ""), okEntry?.summary);

  /* And a rejection is a rejection, not a failure. */
  const nope = await ChangeRequest.create(mkRequest());
  const rejected = await svc.decideChangeRequest({
    id: String(nope._id), decision: "reject",
    actor: { id: String(OWNER), email: "o@x.com", name: "O" },
  });
  check("a rejection succeeds rather than reporting a failed apply", rejected.ok === true);
  const rejEntry = await ChangeLog.findOne({ departmentSlug: SLUG, entityId: nope.entityId, action: "reject" })
    .sort({ createdAt: -1 }).lean();
  check("and is filed as `reject`", Boolean(rejEntry));

  /* ── a decided request stays decided ──────────────────────────────────── */
  console.log("\na decided request stays decided");
  const done = await ChangeRequest.create(mkRequest({ status: "approved" }));
  const again = await svc.decideChangeRequest({
    id: String(done._id), decision: "approve", actor: { id: String(OWNER), email: "o@x.com", name: "O" },
  });
  check("an approved request refuses a second approval", again.ok === false && again.code === 409,
    again.message);
  const gone = await svc.decideChangeRequest({
    id: "000000000000000000000000", decision: "approve", actor: { id: String(OWNER), email: "o@x.com", name: "O" },
  });
  check("a request that no longer exists says so", gone.code === 404);

  /* ── a stranded claim recovers ────────────────────────────────────────── */
  console.log("\na claim stranded by a restart recovers");
  const stuck = await ChangeRequest.create(mkRequest({
    status: "applying",
    decidedAt: new Date(Date.now() - 10 * 60 * 1000),
  }));
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
  const rescued = await svc.decideChangeRequest({
    id: String(stuck._id), decision: "approve", actor: { id: String(OWNER), email: "o@x.com", name: "O" },
  });
  global.fetch = realFetch;
  check("a claim older than five minutes can be taken over", rescued.ok === true, rescued.message);

  const fresh = await ChangeRequest.create(mkRequest({ status: "applying", decidedAt: new Date() }));
  const blocked = await svc.decideChangeRequest({
    id: String(fresh._id), decision: "approve", actor: { id: String(OWNER), email: "o@x.com", name: "O" },
  });
  check("but one still in flight is not", blocked.ok === false && /moment/i.test(blocked.message),
    blocked.message);

  console.log("\ncleanup");
  check("every harness row removed", (await cleanup()) >= 6);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (err) => {
  console.error("\nharness crashed:", err.message, err.stack);
  try {
    console.error(`cleaned up ${await cleanup()} row(s).`);
    await mongoose.disconnect();
  } catch { console.error(`CLEANUP FAILED — remove change_requests with departmentSlug=${SLUG}.`); }
  process.exit(1);
});
