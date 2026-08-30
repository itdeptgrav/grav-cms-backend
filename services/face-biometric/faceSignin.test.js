"use strict";

/**
 * faceSignin.test.js — recognition becomes a session, exactly once.
 *
 * The engine and the employee collection are stubbed. What is under test is
 * the join between them: which statuses may create a session, which may not,
 * and what happens when the same face keeps arriving.
 *
 *   node --test services/face-biometric/faceSignin.test.js
 */

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");

/** Load the router with the engine, employee lookup and auth stubbed out. */
function loadRouter({ engine, employee, departments } = {}) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes("faceSignin") || k.includes("faceBiometric")) delete require.cache[k];
  }
  const authPath = require.resolve(path.join(ROOT, "Middlewear/EmployeeAuthMiddlewear"));
  require.cache[authPath] = { id: authPath, filename: authPath, loaded: true,
    exports: (req, _res, next) => next() };

  const empPath = require.resolve(path.join(ROOT, "models/Employee"));
  require.cache[empPath] = { id: empPath, filename: empPath, loaded: true,
    exports: {
      findOne: () => ({ select: () => ({ lean: async () => employee ?? null }) }),
      findById: () => ({ select: () => ({ lean: async () => employee ?? null }) }),
    } };

  const deptPath = require.resolve(path.join(ROOT, "routes/auth/deptAuth"));
  require.cache[deptPath] = { id: deptPath, filename: deptPath, loaded: true,
    exports: {
      signToken: () => "test.token.value",
      resolveEmployeeDepartments: async () => departments ?? [],
    } };

  const jwtPath = require.resolve(path.join(ROOT, "config/jwt"));
  require.cache[jwtPath] = { id: jwtPath, filename: jwtPath, loaded: true,
    exports: { COOKIE_NAME: "auth_token", cookieOptions: () => ({}),
               SECRET: "t", LEGACY_SECRETS: [], TOKEN_TTL: "1d" } };

  global.fetch = async (url) => {
    if (String(url).endsWith("/health")) {
      if (!engine) throw new Error("ECONNREFUSED");
      return { json: async () => ({ ok: true, gallery_size: 2, frames_required: 3 }) };
    }
    if (!engine) throw new Error("ECONNREFUSED");
    return { status: 200, json: async () => ({ ok: true, ...engine }) };
  };
  return require(path.join(ROOT, "routes/auth/faceSignin"));
}

/** Drive one route handler without starting a server. */
async function call(router, method, url, body) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === url && l.route.methods[method.toLowerCase()],
  );
  assert.ok(layer, `no ${method} ${url}`);
  const handlers = layer.route.stack.map((s) => s.handle);
  const req = { body: body || {}, params: {}, headers: {} };
  let done;
  const p = new Promise((r) => (done = r));
  const res = {
    statusCode: 200,
    cookies: {},
    status(c) { this.statusCode = c; return this; },
    cookie(n, v) { this.cookies[n] = v; return this; },
    json(payload) { done({ status: this.statusCode, body: payload, cookies: this.cookies }); return this; },
  };
  let i = 0;
  const next = () => { const h = handlers[i++]; if (h) h(req, res, next); };
  next();
  return p;
}

const SESSION = "abcdefgh12345678abcdefgh";
const IMAGE = "data:image/jpeg;base64," + "A".repeat(2000);
const EMPLOYEE = { _id: "emp1", firstName: "TEST", lastName: "PERSON",
                   email: "t@example.com", biometricId: "GR9999" };
const DEPTS = [{ _id: "d1", slug: "hr", name: "HR", isActive: true,
                 legacyRole: "hr", legacyUserType: "hr" }];
const VERIFIED = { status: "VERIFIED", employee_id: "GR9999",
                   employee_name: "TEST PERSON", distance: 0.31, margin: 0.4,
                   frames_matched: 3, frames_required: 3, reason: "verified" };

test("a verified face creates a session and returns where to go", async () => {
  const r = loadRouter({ engine: VERIFIED, employee: EMPLOYEE, departments: DEPTS });
  const res = await call(r, "POST", "/verify", { sessionId: SESSION, image: IMAGE });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "VERIFIED");
  assert.equal(res.body.signedIn, true);
  assert.equal(res.body.employeeId, "GR9999");
  assert.equal(res.body.user.employeeId, "GR9999");
  assert.ok(res.body.redirectTo, "must say where to go");
  assert.ok(res.cookies.auth_token, "the session cookie is what signs them in");
  // No employee name is hardcoded anywhere: it comes from the record.
  assert.equal(res.body.employeeName, "TEST PERSON");
});

test("the same session verifying again does not mint a second session", async () => {
  const r = loadRouter({ engine: VERIFIED, employee: EMPLOYEE, departments: DEPTS });
  const first = await call(r, "POST", "/verify", { sessionId: SESSION, image: IMAGE });
  const second = await call(r, "POST", "/verify", { sessionId: SESSION, image: IMAGE });
  const third = await call(r, "POST", "/verify", { sessionId: SESSION, image: IMAGE });
  assert.equal(first.body.alreadySignedIn, undefined);
  assert.equal(second.body.alreadySignedIn, true);
  assert.equal(third.body.alreadySignedIn, true);
  assert.equal(second.body.redirectTo, first.body.redirectTo);
  // A repeat is still a success for the page; it just is not a new login.
  assert.equal(second.body.signedIn, true);
});

test("an unknown face signs nobody in", async () => {
  const r = loadRouter({
    engine: { status: "UNKNOWN", employee_id: null, distance: 0.71,
              frames_matched: 0, frames_required: 3, reason: "no_registered_employee_within_range" },
    employee: EMPLOYEE, departments: DEPTS });
  const res = await call(r, "POST", "/verify", { sessionId: SESSION, image: IMAGE });
  assert.equal(res.body.status, "UNKNOWN");
  assert.equal(res.body.signedIn, false);
  assert.equal(res.body.employeeId, null);
  assert.equal(res.cookies.auth_token, undefined, "no cookie for a stranger");
});

test("no face in the frame signs nobody in", async () => {
  const r = loadRouter({
    engine: { status: "NO_FACE", employee_id: null, frames_matched: 0,
              frames_required: 3, reason: "no_face_in_frame" },
    employee: EMPLOYEE, departments: DEPTS });
  const res = await call(r, "POST", "/verify", { sessionId: SESSION, image: IMAGE });
  assert.equal(res.body.status, "NO_FACE");
  assert.equal(res.body.signedIn, false);
  assert.equal(res.cookies.auth_token, undefined);
});

test("a partial streak signs nobody in", async () => {
  const r = loadRouter({
    engine: { status: "MATCHING", employee_id: null, employee_name: "TEST PERSON",
              distance: 0.33, frames_matched: 2, frames_required: 3,
              reason: "building_the_streak" },
    employee: EMPLOYEE, departments: DEPTS });
  const res = await call(r, "POST", "/verify", { sessionId: SESSION, image: IMAGE });
  assert.equal(res.body.signedIn, false);
  assert.equal(res.body.framesMatched, 2);
  assert.equal(res.cookies.auth_token, undefined);
});

test("the Python service being down is reported, not swallowed", async () => {
  const r = loadRouter({ engine: null, employee: EMPLOYEE, departments: DEPTS });
  const res = await call(r, "POST", "/verify", { sessionId: SESSION, image: IMAGE });
  assert.equal(res.status, 503);
  assert.equal(res.body.success, false);
  assert.equal(res.body.reason, "face_service_unreachable");
  assert.ok(/npm run face:service/.test(res.body.message), "must say how to fix it");
});

test("a recognised id with no employee record signs nobody in", async () => {
  const r = loadRouter({ engine: VERIFIED, employee: null, departments: DEPTS });
  const res = await call(r, "POST", "/verify", { sessionId: SESSION, image: IMAGE });
  assert.equal(res.body.signedIn, false);
  assert.equal(res.body.status, "RECOGNISED_NOT_PERMITTED");
  assert.equal(res.body.code, "NO_EMPLOYEE");
  assert.equal(res.cookies.auth_token, undefined);
});

test("a recognised employee with no department signs nobody in", async () => {
  const r = loadRouter({ engine: VERIFIED, employee: EMPLOYEE, departments: [] });
  const res = await call(r, "POST", "/verify", { sessionId: SESSION, image: IMAGE });
  assert.equal(res.body.signedIn, false);
  assert.equal(res.body.code, "NO_DEPARTMENT");
  assert.equal(res.cookies.auth_token, undefined);
});

test("an inactive department signs nobody in", async () => {
  const r = loadRouter({ engine: VERIFIED, employee: EMPLOYEE,
    departments: [{ ...DEPTS[0], isActive: false }] });
  const res = await call(r, "POST", "/verify", { sessionId: SESSION, image: IMAGE });
  assert.equal(res.body.signedIn, false);
  assert.equal(res.body.code, "DEPARTMENT_INACTIVE");
});

test("a face recognised but unlinked to HR signs nobody in", async () => {
  const r = loadRouter({
    engine: { status: "VERIFIED_BUT_UNLINKED", employee_id: null,
              employee_name: "SomeFolder", frames_matched: 3, frames_required: 3,
              reason: "face_recognised_but_no_hr_employee_linked" },
    employee: EMPLOYEE, departments: DEPTS });
  const res = await call(r, "POST", "/verify", { sessionId: SESSION, image: IMAGE });
  assert.equal(res.body.signedIn, false);
  assert.equal(res.cookies.auth_token, undefined);
});

test("payload validation refuses junk before it reaches the engine", async () => {
  const r = loadRouter({ engine: VERIFIED, employee: EMPLOYEE, departments: DEPTS });
  const short = await call(r, "POST", "/verify", { sessionId: "abc", image: IMAGE });
  assert.equal(short.status, 400);
  assert.equal(short.body.reason, "invalid_session");
  const bad = await call(r, "POST", "/verify",
    { sessionId: SESSION, image: "data:application/pdf;base64,QQ==" });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.reason, "unsupported_image_type");
});
