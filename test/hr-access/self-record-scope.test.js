"use strict";
/**
 * A SELF-SERVICE ROUTE WHOSE `:id` IS A RECORD MUST NOT READ IT AS A PERSON.
 *
 * services/access/hrAuthorization.js:namesSelf defaults to treating a path
 * `:id` as an EMPLOYEE id. That is correct for /api/employees/:id and wrong for
 * every employee self-service route whose `:id` names a record the caller owns:
 * a leave application, a document request, a regularization. On those the
 * guard compared
 *
 *     leaveApplication._id  ===  the caller's own employee _id
 *
 * which is false for everybody, always — so the owner of the record was refused
 * their own record with HR_OUT_OF_SCOPE, "You do not have permission to perform
 * this action." Ten endpoints were dead that way; the one somebody hit was the
 * leave withdrawal on the employee app.
 *
 * `selfRecord: true` on the declaration says the path id is a record. These
 * tests pin the three things that makes true:
 *
 *   1. the owner is permitted,
 *   2. naming ANOTHER employee in the body or the query is still refused —
 *      dropping the record-id comparison must not drop the impersonation one,
 *   3. every route carrying the marker really does scope its own query by the
 *      token's employee. That is what proves the RECORD, so a route that
 *      stopped doing it would be a hole the declaration no longer covers.
 *
 * (3) is a source sweep rather than a request, deliberately: the point is that
 * the owner filter EXISTS in the handler, which is a property of the file, and
 * a stub app with the real guard — what hr-contract.route.test.js does — cannot
 * see it.
 */

const fs = require("fs");
const path = require("path");

const express = require("express");
const cookieParser = require("cookie-parser");

const { resetAccessCaches, makeDepartment, grantHrRole, makeEmployee, appToken } =
  require("./helpers");
const hrContract = require("../../Middlewear/hrContract");

const { DECLARATIONS, findDeclaration, extractParams } =
  require("../../services/access/hrRouteContract");
const { namesSelf } = require("../../services/access/hrAuthorization");

/* A record id and an employee id that are not each other. The bug was exactly
   the confusion between these two, so the fixture must keep them distinct. */
const RECORD_ID = "68d1aa0000000000000000aa";
const MY_EMPLOYEE_ID = "67b0bb0000000000000000bb";
const SOMEBODY_ELSE = "6700000000000000000000cc";

const ME = { employeeRef: MY_EMPLOYEE_ID, biometricId: "GR0003" };

const marked = DECLARATIONS.filter((d) => d.selfRecord);

/** The declared path with its `:id` filled in. */
const concretePath = (d) => d.path.replace(":id", RECORD_ID);

const allows = (d, { body = {}, query = {} } = {}) => {
  const full = concretePath(d);
  const req = { hrParams: extractParams(d, full), body, query };
  return namesSelf(req, ME, d.selfParams || [], { selfRecord: d.selfRecord });
};

describe("self-scope on record-owned routes", () => {
  it("marks the routes whose :id is a record, and no others", () => {
    /* Named explicitly rather than counted: if a future route joins the list
       it should be a deliberate edit here, with the owner filter checked
       below, not a number quietly going up. */
    expect(marked.map((d) => `${d.method} ${d.path}`).sort()).toEqual(
      [
        "DELETE /api/employee/leave-applications/:id",
        "GET /api/employee/documents/:id",
        "GET /api/employee/documents/:id/file",
        "GET /api/employee/leave-applications/:id",
        "PATCH /api/employee/documents/:id/cancel",
        "PATCH /api/employee/leave-applications/:id/cancel",
        "PATCH /api/employee/leave-applications/:id/cancel-withdraw",
        "PATCH /api/employee/regularizations/:id/cancel",
        "POST /api/employee/leave-applications/:id/upload-document",
        "PUT /api/employee/leave-applications/:id",
      ].sort(),
    );
  });

  it("every marked route is declared scope self", () => {
    for (const d of marked) expect(d.scope).toBe("self");
  });

  it("permits the owner of the record", () => {
    for (const d of marked) {
      expect({ route: `${d.method} ${d.path}`, allowed: allows(d) }).toEqual({
        route: `${d.method} ${d.path}`,
        allowed: true,
      });
    }
  });

  it("still refuses a request naming another employee", () => {
    for (const d of marked) {
      expect(allows(d, { body: { employeeId: SOMEBODY_ELSE } })).toBe(false);
      expect(allows(d, { query: { employeeId: SOMEBODY_ELSE } })).toBe(false);
    }
    /* And the caller's own id in the body is not an impersonation. */
    for (const d of marked) {
      expect(allows(d, { body: { employeeId: MY_EMPLOYEE_ID } })).toBe(true);
    }
  });

  it("leaves a route whose :id really is a person reading it as one", () => {
    const d = findDeclaration("GET", `/api/employee/payslip/${SOMEBODY_ELSE}`);
    expect(d).toBeTruthy();
    expect(d.selfRecord).toBeFalsy();
    const full = `/api/employee/payslip/${SOMEBODY_ELSE}`;
    const req = { hrParams: extractParams(d, full), body: {}, query: {} };
    expect(namesSelf(req, ME, d.selfParams || [], { selfRecord: d.selfRecord })).toBe(false);
  });

  /* ── (3) the handler's own owner filter ──────────────────────────────────*/

  const ROUTERS = {
    "/api/employee/leave-applications": "routes/Employee_Routes/leaveRoutes.js",
    "/api/employee/documents": "routes/Employee_Routes/documents.js",
    "/api/employee/regularizations": "routes/Employee_Routes/regularization.js",
  };

  /** Anything that scopes a query to the caller rather than to a path value. */
  const OWNER_FILTER = /employeeId:\s*req\.user\.id|visibleTo\(req\.user\.id\)/;

  it("every marked route scopes its own query by the token's employee", () => {
    const missing = [];

    for (const d of marked) {
      const mount = Object.keys(ROUTERS).find((m) => d.path.startsWith(m + "/"));
      expect(mount).toBeTruthy();

      const file = path.join(__dirname, "..", "..", ROUTERS[mount]);
      const src = fs.readFileSync(file, "utf8");
      const sub = d.path.slice(mount.length); // e.g. "/:id/cancel"

      /* The handler's opening line. Written across two forms in these routers —
         `router.patch("/:id/cancel", mw, …)` and the same broken over lines. */
      const open = new RegExp(
        `router\\.${d.method.toLowerCase()}\\(\\s*"${sub.replace(/[/:]/g, (c) => "\\" + c)}"`,
      );
      const at = src.search(open);
      if (at === -1) {
        missing.push(`${d.method} ${d.path} — handler not found in ${ROUTERS[mount]}`);
        continue;
      }

      /* The owner filter is the first query the handler makes. A generous
         window, because one of these takes a multer middleware and a couple of
         argument checks first. */
      const body = src.slice(at, at + 1600);
      if (!OWNER_FILTER.test(body)) {
        missing.push(`${d.method} ${d.path} — no owner-scoped query near the handler`);
      }
    }

    expect(missing).toEqual([]);
  });
});

/* ── AND THROUGH A REAL REQUEST ────────────────────────────────────────────
   The decision function above is where the bug was, but what the person on
   the phone experienced was an HTTP 403 with a sentence on it. This mounts
   the REAL guard on the real prefix and checks the status code, so the fix
   is pinned at the layer the failure was reported from. The handler is a
   stub for the reason hr-contract.route.test.js gives: the guard runs before
   any router, so what is proved here is independent of leaveRoutes.js. */
describe("the withdrawal actually gets through the guard", () => {
  let server, base, me;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/api/employee", hrContract());
    app.use((req, res) => res.json({ reached: true, scope: req.hrAuth?.declaration?.scope }));
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => { await new Promise((r) => server.close(r)); });

  beforeEach(async () => {
    resetAccessCaches();
    await makeDepartment("hr", "HR", "/hr/dashboard");
    await grantHrRole("configured@grav.in", "viewer", "Someone");
    me = await makeEmployee({
      firstName: "Renu", lastName: "Kumari",
      email: "renu@grav.in", biometricId: "GR0003",
    });
    resetAccessCaches();
  });

  const withdraw = (query = "", body = { cancelReason: "Employee withdrawal request" }) =>
    fetch(`${base}/api/employee/leave-applications/${RECORD_ID}/cancel${query}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${appToken({ id: String(me._id), email: me.email })}`,
      },
      body: JSON.stringify(body),
    });

  it("lets an employee withdraw their own leave", async () => {
    const res = await withdraw();
    const payload = await res.json();
    /* Before the fix this was 403 HR_OUT_OF_SCOPE, "You do not have
       permission to perform this action." */
    expect({ status: res.status, reached: payload.reached }).toEqual({
      status: 200,
      reached: true,
    });
  });

  it("still refuses one that names somebody else", async () => {
    const res = await withdraw(`?employeeId=${SOMEBODY_ELSE}`);
    expect(res.status).toBe(403);
    const payload = await res.json();
    expect(payload.code).toBe("HR_OUT_OF_SCOPE");
  });

  it("still refuses an unauthenticated one", async () => {
    const res = await fetch(`${base}/api/employee/leave-applications/${RECORD_ID}/cancel`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });
});
