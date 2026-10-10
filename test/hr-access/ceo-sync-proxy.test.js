"use strict";
/**
 * THE CEO ATTENDANCE RE-SYNC PROXIES TO A ROUTE THAT EXISTS.
 *
 * POST /api/ceo/hr/attendance/sync does not sync anything itself: it makes a
 * loopback HTTP call to the HR attendance router. That indirection means a
 * typo in the target path is invisible to every type checker and every import
 * graph, and the only symptom is a 404 wearing the proxy's own clothes. It
 * shipped pointing at `/hr/attendance/sync` — a path that has never existed,
 * the route being `/sync-period` — and sending `fromDate`/`toDate` where the
 * handler reads `from`/`to`. Both halves were wrong, so fixing either alone
 * would still have failed.
 *
 * These are source assertions rather than a live request on purpose: actually
 * exercising the proxy runs a real biometric sync and writes attendance rows,
 * which is not something a test suite should do to prove a string is spelled
 * correctly.
 */

const fs = require("fs");
const path = require("path");

const read = (p) => fs.readFileSync(path.join(__dirname, "..", "..", p), "utf8");

const PROXY = read("routes/CEO_Routes/hr.js");
const ATTENDANCE = read("routes/HrRoutes/Attendance_section.js");

/** The `path:` the proxy requests, from its http.request options. */
const proxyTarget = () => {
  const m = PROXY.match(/path:\s*"(\/hr\/attendance\/[^"]+)"/);
  return m && m[1];
};

describe("the CEO attendance re-sync proxy", () => {
  it("targets a path the HR attendance router actually serves", () => {
    const target = proxyTarget();
    expect(target).toBeTruthy();

    /* The router is mounted at /hr/attendance, so the sub-path is what
       `router.post(...)` declares. */
    const sub = target.replace("/hr/attendance", "");
    const declared = new RegExp(`router\\.post\\(\\s*"${sub.replace(/[/-]/g, (c) => "\\" + c)}"`);

    expect({ target, servedByTheRouter: declared.test(ATTENDANCE) }).toEqual({
      target,
      servedByTheRouter: true,
    });
  });

  it("sends the body keys that route reads", () => {
    /* The handler destructures `{ from, to, … }` and answers 400 "from and to
       required" for anything else, so the proxy's own body must use those
       names and not the `fromDate`/`toDate` it used to send. */
    expect(ATTENDANCE).toMatch(/const \{ from, to,[^}]*\} = req\.body;/);
    expect(PROXY).toMatch(/JSON\.stringify\(\{ from: date, to: date \}\)/);
    expect(PROXY).not.toMatch(/fromDate: date/);
  });

  it("forwards the caller's Authorization header, not only the cookie", () => {
    /* This file's own header explains why: in production the frontend is a
       different host, the auth_token cookie is third-party and Safari drops
       it, so the session arrives as a Bearer header. A proxy that forwards
       only `Cookie` therefore carries no identity at all in production while
       working perfectly on a developer's machine. */
    expect(PROXY).toMatch(/Authorization: req\.headers\.authorization/);
    expect(PROXY).toMatch(/Cookie: req\.headers\.cookie/);
  });

  it("passes the upstream status through instead of flattening it to 200", () => {
    /* /sync-period answers 202 with a job for a long range, and the contract
       answers 403 when the caller lacks the attendance CLOSE capability — a
       CEO-only session does not hold it, by design. Both must reach the page
       as themselves. */
    expect(PROXY).toMatch(/res\.status\(syncResult\.status\)\.json\(syncResult\.payload\)/);
  });
});
