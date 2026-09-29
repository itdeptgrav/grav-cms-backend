// test/accountant/accounting-auth-inventory.test.js
//
// LANE A — a source-level inventory of how Accounting authenticates.
//
// The behavioural suites prove that today's code refuses what it should. This
// one exists for tomorrow's: the way this module got into trouble was not a bad
// decision, it was a SECOND place to make the decision. `AccountantAuthMiddleware`
// grew its own cookie parser, its own `jwt.verify`, and its own role table, and
// for a long time nobody noticed that the two middlewares disagreed about who
// was allowed to post a voucher.
//
// So this file reads the source and fails when a new independent path appears:
// a route that verifies its own token, an accounting router with no auth on it,
// or the legacy role→permission table coming back. It cannot be satisfied by
// making a test pass — only by not writing the second path.
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");

// This file `require`s every accounting router in order to walk its stack, and
// requiring Acc_backup.js self-starts the backup scheduler. Put it back so Jest
// exits cleanly instead of holding the boot timer and firing a database call
// into a connection the suite has already torn down.
afterAll(() => {
  try {
    require("../../services/accountantBackupScheduler").stop();
  } catch {
    /* not started — nothing to stop */
  }
});
const ACC_ROUTES_DIR = path.join(ROOT, "routes", "Accountant_Routes");

const read = (p) => fs.readFileSync(p, "utf8");
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

/** Every .js file under routes/Accountant_Routes, plus the one accounting
 *  router that lives outside it. */
function accountingRouteFiles() {
  const files = fs
    .readdirSync(ACC_ROUTES_DIR)
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join(ACC_ROUTES_DIR, f));
  files.push(
    path.join(ROOT, "routes", "CMS_Routes", "Inventory", "valuation", "landedCostRoutes.js"),
  );
  return files.filter((f) => fs.existsSync(f));
}

/* ------------------------------------------------------------------ */
/* 1. Exactly one token verifier                                       */
/* ------------------------------------------------------------------ */

// Two files legitimately call jwt.verify on something that is NOT a session
// credential. Both are listed with the reason, and the reason is what a future
// reader has to disagree with before adding a third.
const JWT_VERIFY_ALLOWED = {
  "routes/Accountant_Routes/Acc_auth.js":
    "GET /debug-token — a diagnostic that decodes the caller's own token and " +
    "returns its claim names. Authorises nothing.",
  "routes/Accountant_Routes/Acc_backup.js":
    "Verifies the Google OAuth `state` round-trip parameter. `decoded` is read " +
    "only for a display name; it grants no access and gates no route.",
};

describe("there is one token verifier in Accounting", () => {
  test("no accounting route file verifies a session token of its own", () => {
    const offenders = [];
    for (const file of accountingRouteFiles()) {
      const src = read(file);
      if (!/\bjwt\s*\.\s*verify\s*\(/.test(src)) continue;
      const name = rel(file);
      if (!(name in JWT_VERIFY_ALLOWED)) offenders.push(name);
    }

    expect(offenders).toEqual([]);
  });

  test("the allow-list has not silently grown", () => {
    // Pinned so that adding an entry is a deliberate edit to THIS list, with a
    // written reason, rather than a quiet append.
    expect(Object.keys(JWT_VERIFY_ALLOWED).sort()).toEqual([
      "routes/Accountant_Routes/Acc_auth.js",
      "routes/Accountant_Routes/Acc_backup.js",
    ]);
    for (const reason of Object.values(JWT_VERIFY_ALLOWED)) {
      expect(reason.length).toBeGreaterThan(40);
    }
  });

  test("the compatibility façade verifies nothing itself", () => {
    const src = read(path.join(ROOT, "Middlewear", "AccountantAuthMiddleware.js"));
    expect(src).not.toMatch(/\bjwt\s*\.\s*verify\s*\(/);
    expect(src).not.toMatch(/require\(["']jsonwebtoken["']\)/);
  });

  test("only the org middleware imports jsonwebtoken among the Accounting middlewares", () => {
    const middlewares = fs
      .readdirSync(path.join(ROOT, "Middlewear"))
      .filter((f) => /^Accountant.*\.js$/.test(f));
    const importers = middlewares.filter((f) =>
      /require\(["']jsonwebtoken["']\)/.test(
        read(path.join(ROOT, "Middlewear", f)),
      ),
    );
    expect(importers).toEqual(["AccountantOrgAuthMiddleware.js"]);
  });
});

/* ------------------------------------------------------------------ */
/* 2. The legacy grant is gone and cannot come back quietly            */
/* ------------------------------------------------------------------ */

describe("the legacy role→permission grant", () => {
  const facadeSrc = () =>
    read(path.join(ROOT, "Middlewear", "AccountantAuthMiddleware.js"));

  test("legacyRolePermissions no longer exists", () => {
    expect(facadeSrc()).not.toMatch(/function\s+legacyRolePermissions/);
    const facade = require("../../Middlewear/AccountantAuthMiddleware");
    expect(facade.legacyRolePermissions).toBeUndefined();
  });

  test("verifyToken — an independent verification path — is not exported", () => {
    const facade = require("../../Middlewear/AccountantAuthMiddleware");
    expect(facade.verifyToken).toBeUndefined();
  });

  test("no accounting middleware grants rights from a CMS role name", () => {
    // `role === "admin"` / `role === "accountant"` deciding a permission is the
    // exact shape of the hole. The names may appear in an ALLOW-LIST argument
    // (that is what makeAuth translates), but never in a capability decision.
    for (const f of ["AccountantAuthMiddleware.js", "AccountantOrgAuthMiddleware.js"]) {
      const src = read(path.join(ROOT, "Middlewear", f));
      expect(src).not.toMatch(/role\s*===\s*["'](admin|accountant|accountant_viewer)["']/);
      expect(src).not.toMatch(/\[["'](admin|accountant)["']\]\s*\.includes\(\s*role/);
    }
  });

  test("the org middleware is still the only thing that reads Acc_User for auth", () => {
    const src = read(
      path.join(ROOT, "Middlewear", "AccountantOrgAuthMiddleware.js"),
    );
    expect(src).toMatch(/Acc_User\.findById/);
    expect(src).toMatch(/tokenVersion/);
    expect(src).toMatch(/isActive/);
  });
});

/* ------------------------------------------------------------------ */
/* Files this runner cannot parse (pre-existing, see section 4)        */
/* ------------------------------------------------------------------ */
//
// Both are duplicate-declaration defects committed before Lane A Chunk 2 and
// untouched by it: Node loads them and the second declaration wins, babel-jest
// refuses them outright. Section 4 pins each one so that fixing either turns
// its exemption red. Section 3 skips them because it has to `require` a router
// to walk its stack.
const KNOWN_UNLOADABLE = {
  "Acc_auditNotes.js": "duplicate `notifyAuditNote` (lines 46 and 175)",
  "Acc_books.js": "duplicate `findPrimary` (lines 502 and 723)",
};

/* ------------------------------------------------------------------ */
/* 3. Every accounting ENDPOINT is behind a sanctioned gate            */
/* ------------------------------------------------------------------ */
//
// The first version of this section asked whether the FILE mentioned a gate
// anywhere. That is not a check — a `require` at the top, or the word
// `accountantAuth` inside a comment explaining why a route does not use one,
// satisfied it while every endpoint in the file stayed open. `Acc_companies.js`
// passed it while serving its whole read surface to anonymous callers.
//
// So this reads the ROUTER, not the file: each module is loaded and its Express
// stack walked, which is the same structure the server dispatches against.
// Aliases (`const auth = accountantAuth`), spreads (`...guard`) and wrappers all
// resolve correctly because they are the same function objects by then. Nothing
// written in a comment or an unused import appears in a router stack at all.

const GATE_FNS = (() => {
  const f = require("../../Middlewear/AccountantAuthMiddleware");
  const o = require("../../Middlewear/AccountantOrgAuthMiddleware");
  return new Set([
    f.accountantAuth,
    f.accountantReadOnlyAuth,
    f.adminOnlyAuth,
    o.orgAuth,
    o.legacyBootstrapAuth,
  ]);
})();

/** Strip comments so a gate NAMED inside a wrapper cannot pass for a call. */
function codeOnly(src) {
  let out = "";
  let i = 0;
  let state = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === "line") { if (c === "\n") { state = null; out += c; } i++; continue; }
    if (state === "block") { if (c === "*" && n === "/") { state = null; i += 2; continue; } if (c === "\n") out += c; i++; continue; }
    if (state) { if (c === "\\") { i += 2; continue; } if (c === state) state = null; if (c === "\n") out += c; i++; continue; }
    if (c === "/" && n === "/") { state = "line"; i += 2; continue; }
    if (c === "/" && n === "*") { state = "block"; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") { state = c; out += c + c; i++; continue; }
    out += c;
    i++;
  }
  return out;
}

/**
 * Strip comments but KEEP string contents. `codeOnly` empties string literals,
 * which is right when looking for gate NAMES but useless when the thing being
 * looked for is a literal — `req.method === "GET"` survives here and does not
 * survive there.
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  let state = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === "line") { if (c === "\n") { state = null; out += c; } i++; continue; }
    if (state === "block") { if (c === "*" && n === "/") { state = null; i += 2; continue; } if (c === "\n") out += c; i++; continue; }
    if (state) { out += c; if (c === "\\") { out += src[i + 1] || ""; i += 2; continue; } if (c === state) state = null; i++; continue; }
    if (c === "/" && n === "/") { state = "line"; i += 2; continue; }
    if (c === "/" && n === "*") { state = "block"; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") { state = c; out += c; i++; continue; }
    out += c;
    i++;
  }
  return out;
}

/**
 * A layer counts as a gate if it IS one, or if it is a thin wrapper that calls
 * one — `Acc_customers` wraps orgAuth to also set `req.accountantId`, and
 * `Acc_companies` wraps accountantAuth to skip a route that self-protects.
 */
function isGate(fn) {
  if (typeof fn !== "function") return false;
  if (GATE_FNS.has(fn)) return true;
  const body = codeOnly(String(fn));
  return /\b\w*(?:orgAuth|accountantAuth|ReadOnlyAuth|adminOnlyAuth)\w*\s*\(/i.test(body);
}

/** Every endpoint of a router, with whether a gate precedes it. */
function endpointsWithCoverage(router) {
  const out = [];
  let routerLevelGate = false;
  for (const layer of router.stack || []) {
    if (!layer.route) {
      // Router-level middleware. Mounted here, so it covers everything BELOW.
      if (isGate(layer.handle)) routerLevelGate = true;
      // A nested router (express.Router() mounted with .use) carries its own.
      continue;
    }
    const methods = Object.keys(layer.route.methods || {})
      .filter((m) => layer.route.methods[m])
      .map((m) => m.toUpperCase());
    const perRouteGate = (layer.route.stack || []).some((l) => isGate(l.handle));
    for (const method of methods) {
      out.push({
        method,
        path: layer.route.path,
        covered: routerLevelGate || perRouteGate,
      });
    }
  }
  return out;
}

// Endpoint-specific exceptions: file + METHOD + path, each with the reason it
// is reachable without a session. A whole file can no longer be waved through.
const PUBLIC_ENDPOINTS = {
  "Acc_auth.js POST /login":
    "The accounting login endpoint itself — it is what issues the session " +
    "everything else demands.",
  "Acc_auth.js POST /logout":
    "Clears the accountant cookie. Requiring a valid session to log out would " +
    "strand anyone whose session had already gone bad.",
  "Acc_auth.js POST /accept-invite":
    "Consumes a single-use invite token and sets the first password.",
  "Acc_auth.js POST /bootstrap":
    "Creates the very first organisation, and refuses once one exists.",
  "Acc_auth.js GET /debug-token":
    "Decodes the caller's OWN token and returns its claim names — it reveals " +
    "nothing the caller is not already holding.",
  "Acc_backup.js GET /google/callback":
    "The Google OAuth redirect landing page, reached by the browser rather " +
    "than by the app. Everything else on that router is behind accountantAuth.",
  "Acc_backup.js POST /cron":
    "External cron trigger, gated on the BACKUP_CRON_SECRET shared secret and " +
    "refusing outright when that variable is unset. Deliberately mounted above " +
    "the auth middleware, same pattern as the Setu webhook.",
  "accountant.routes.js GET /_health":
    "A mounting health probe on a wrapper router that server.js never requires " +
    "— dead code left from an earlier layout, pinned as unmounted below.",
  "Acc_setuAA.js POST /webhook":
    "Setu account-aggregator callback. Verifies an HMAC signature against " +
    "SETU_AA_NOTIFICATION_SECRET and 401s on mismatch — the caller is a machine " +
    "with no session, authenticated by the signature rather than by a token.",
};

describe("every accounting endpoint is behind a sanctioned gate", () => {
  test("no endpoint is reachable without one", () => {
    const unprotected = [];
    for (const file of accountingRouteFiles()) {
      const name = path.basename(file);
      if (name in KNOWN_UNLOADABLE) continue;
      let router;
      try {
        router = require(file);
      } catch {
        continue; // covered by the load test in section 4
      }
      if (!router || !Array.isArray(router.stack)) continue;

      for (const ep of endpointsWithCoverage(router)) {
        const key = `${name} ${ep.method} ${ep.path}`;
        if (ep.covered || key in PUBLIC_ENDPOINTS) continue;
        unprotected.push(key);
      }
    }
    expect(unprotected.sort()).toEqual([]);
  });

  test("a gate named only in a comment is not protection", () => {
    const commentOnly = (req, res, next) => {
      // accountantAuth is applied elsewhere for this route
      next();
    };
    expect(isGate(commentOnly)).toBe(false);
  });

  test("a gate named only in an import is not protection", () => {
    const express = require("express");
    const r = express.Router();
    r.get("/leak", (req, res) => res.json({}));
    const [ep] = endpointsWithCoverage(r);
    expect(ep.path).toBe("/leak");
    expect(ep.covered).toBe(false);
  });

  test("a real gate IS recognised, however it is aliased or spread", () => {
    const express = require("express");
    const facade = require("../../Middlewear/AccountantAuthMiddleware");

    const aliased = express.Router();
    const auth = facade.accountantAuth;
    aliased.use(auth);
    aliased.get("/x", (req, res) => res.json({}));
    expect(endpointsWithCoverage(aliased)[0].covered).toBe(true);

    const spread = express.Router();
    const guard = [facade.accountantAuth, (req, res, next) => next()];
    spread.get("/y", ...guard, (req, res) => res.json({}));
    expect(endpointsWithCoverage(spread)[0].covered).toBe(true);
  });

  test("a router-level gate does not retroactively cover routes above it", () => {
    const express = require("express");
    const facade = require("../../Middlewear/AccountantAuthMiddleware");
    const r = express.Router();
    r.get("/before", (req, res) => res.json({}));
    r.use(facade.accountantAuth);
    r.get("/after", (req, res) => res.json({}));
    const eps = endpointsWithCoverage(r);
    expect(eps.find((e) => e.path === "/before").covered).toBe(false);
    expect(eps.find((e) => e.path === "/after").covered).toBe(true);
  });

  test("the public-endpoint list is endpoint-specific and reasoned", () => {
    for (const [key, reason] of Object.entries(PUBLIC_ENDPOINTS)) {
      expect(key).toMatch(
        /^(Acc_\w+|accountant\.routes)\.js (GET|POST|PUT|PATCH|DELETE) \//,
      );
      expect(reason.length).toBeGreaterThan(30);
    }
  });

  test("the public-endpoint list has not silently grown", () => {
    expect(Object.keys(PUBLIC_ENDPOINTS).sort()).toEqual([
      "Acc_auth.js GET /debug-token",
      "Acc_auth.js POST /accept-invite",
      "Acc_auth.js POST /bootstrap",
      "Acc_auth.js POST /login",
      "Acc_auth.js POST /logout",
      "Acc_backup.js GET /google/callback",
      "Acc_backup.js POST /cron",
      "Acc_setuAA.js POST /webhook",
      "accountant.routes.js GET /_health",
    ]);
  });

  test("the unmounted wrapper router is still unmounted", () => {
    // `accountant.routes.js` is exempt only because nothing serves it. If it
    // is ever wired into server.js, its /_health probe becomes reachable and
    // this exemption has to be revisited.
    const server = read(path.join(ROOT, "server.js"));
    expect(server).not.toMatch(/accountant\.routes/);
  });

  // A conditional gate is the one thing the router stack cannot see: the layer
  // IS mounted and it DOES call accountantAuth, just not on every request.
  // `Acc_companies` shipped exactly that — `if (req.method === "GET") return
  // next();` in front of its only call — and served its whole read surface to
  // anonymous callers. Behavioural proof lives in
  // companies-and-mutating-gets.route.test.js; this is the source-level guard.
  test("no authenticating gate short-circuits on the request method", () => {
    const offenders = [];
    for (const file of accountingRouteFiles()) {
      const name = path.basename(file);
      if (name in KNOWN_UNLOADABLE) continue;
      // Comments stripped, string literals KEPT — the literal is the point.
      const src = stripComments(read(file));
      const re = /router\s*\.\s*use\s*\(\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*\{/g;
      let m;
      while ((m = re.exec(src))) {
        // Body of this router.use middleware, by brace depth.
        let i = src.indexOf("{", m.index + m[0].length - 1);
        let depth = 0;
        let end = i;
        for (; i < src.length; i++) {
          if (src[i] === "{") depth++;
          else if (src[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
        }
        const body = src.slice(m.index, end);
        if (!/\b\w*(?:accountantAuth|orgAuth)\w*\s*\(/i.test(body)) continue;
        if (/req\.method\s*===\s*["'`]GET["'`]/.test(body)) {
          offenders.push(`${name}: authenticating gate skips GET requests`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no GSTR-2B read route runs the index migration", () => {
    // `ensureIndexMigration` drops an index and backfills `returnType` on legacy
    // documents. It is guarded by a module-level once-flag, so whether a given
    // request writes depends on which route ran first in the process — which is
    // why a behavioural test alone cannot hold this. It belongs on POST /upload,
    // which `accountantAuth` makes canEdit by method.
    const src = stripComments(
      read(path.join(ROOT, "routes", "Accountant_Routes", "Acc_gstr2b.js")),
    );
    // Route declarations, in source order — the path may sit on the next line
    // (`router.post(\n  "/upload",`), so take the first string after the call.
    const routes = [];
    const re = /router\.(get|post|put|patch|delete)\(\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(src))) {
      routes.push({ at: m.index, label: `${m[1].toUpperCase()} ${m[2]}` });
    }
    // Which route each ensureIndexMigration() call sits inside.
    const callers = [];
    const cre = /ensureIndexMigration\s*\(\s*\)/g;
    let c;
    while ((c = cre.exec(src))) {
      // Skip its own declaration.
      if (/async function ensureIndexMigration/.test(
        src.slice(Math.max(0, c.index - 60), c.index),
      )) continue;
      const owner = [...routes].reverse().find((r) => r.at < c.index);
      if (owner && !callers.includes(owner.label)) callers.push(owner.label);
    }
    expect(callers).toEqual(["POST /upload"]);
  });

  test("that method short-circuit check actually detects one", () => {
    // Guards the guard: `codeOnly` would empty the "GET" literal and make the
    // assertion above vacuously true, which is how it was written first.
    const sample = [
      'router.use((req, res, next) => {',
      '  if (req.method === "GET") return next();',
      '  return accountantAuth(req, res, next);',
      '});',
    ].join("\n");
    const kept = stripComments(sample);
    expect(kept).toMatch(/req\.method\s*===\s*"GET"/);
    expect(codeOnly(sample)).not.toMatch(/req\.method\s*===\s*"GET"/);
  });
});

/* ------------------------------------------------------------------ */
/* 4. The façade's reach                                               */
/* ------------------------------------------------------------------ */

describe("the compatibility façade", () => {
  function facadeImporters() {
    const out = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".js") && /AccountantAuthMiddleware/.test(read(p)))
          out.push(rel(p));
      }
    };
    walk(path.join(ROOT, "routes"));
    return out.sort();
  }

  test("covers every route file that imports it, and the count is pinned", () => {
    const importers = facadeImporters();
    // 39 route files were on the legacy middleware when Chunk 2 began. If this
    // number moves, either a file was migrated off it (good — update this and
    // say so) or a NEW file was written against it (which is fine, since it now
    // resolves through orgAuth, but should be a conscious choice).
    expect(importers.length).toBe(39);
    for (const f of importers) {
      expect(f.startsWith("routes/")).toBe(true);
    }
  });

  test("each importer takes only names the façade exports", () => {
    const facade = require("../../Middlewear/AccountantAuthMiddleware");
    const exported = new Set([...Object.keys(facade), "default"]);
    const bad = [];

    for (const f of facadeImporters()) {
      const src = read(path.join(ROOT, f));
      // Destructured imports: const { a, b } = require(".../AccountantAuthMiddleware")
      const re =
        /const\s*\{([^}]*)\}\s*=\s*require\([^)]*AccountantAuthMiddleware[^)]*\)/g;
      let m;
      while ((m = re.exec(src))) {
        for (const raw of m[1].split(",")) {
          const nameRaw = raw.split(":")[0].trim();
          if (!nameRaw) continue;
          if (!exported.has(nameRaw)) bad.push(`${f} imports ${nameRaw}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  // Same list as section 3, keyed by repo-relative path for this section's
  // file-oriented assertions.
  const KNOWN_UNPARSEABLE = {
    "routes/Accountant_Routes/Acc_auditNotes.js":
      "Declares `async function notifyAuditNote` twice (lines 46 and 175), " +
      "committed at HEAD before Lane A Chunk 2 and untouched by it. Node's " +
      "sloppy mode accepts the redeclaration and the SECOND definition silently " +
      "wins; babel-jest rejects it outright. Whichever body is the intended one, " +
      "the other is dead — it needs an owner's decision, not an auth change.",
    "routes/Accountant_Routes/Acc_books.js":
      "Declares `function findPrimary` twice in the same function scope (lines " +
      "502 and 723), committed at HEAD before Lane A Chunk 2 and untouched by " +
      "it. Same shape as the audit-notes one: Node hoists and the second wins, " +
      "babel-jest refuses to parse. The two bodies take different arguments " +
      "(`grp` vs `grpId`), so one of the two call sites is being answered by a " +
      "function that was not written for it.",
  };

  test("all of them load without throwing", () => {
    const broken = [];
    for (const f of facadeImporters()) {
      if (f in KNOWN_UNPARSEABLE) continue;
      try {
        require(path.join(ROOT, f));
      } catch (e) {
        broken.push(`${f} :: ${e.message.split("\n")[0]}`);
      }
    }
    expect(broken).toEqual([]);
  });

  test("the known-unparseable list has not silently grown", () => {
    expect(Object.keys(KNOWN_UNPARSEABLE).sort()).toEqual([
      "routes/Accountant_Routes/Acc_auditNotes.js",
      "routes/Accountant_Routes/Acc_books.js",
    ]);
  });

  test.each([
    ["Acc_auditNotes.js", /async function notifyAuditNote/g],
    ["Acc_books.js", /function findPrimary\s*\(/g],
  ])(
    "%s still has exactly the duplicate that exempts it, and is still behind the façade",
    (file, pattern) => {
      // If someone fixes one, this fails and its exemption comes out.
      const src = read(path.join(ROOT, "routes", "Accountant_Routes", file));
      expect((src.match(pattern) || []).length).toBe(2);
      // And it is genuinely reachable at runtime — Node loads it, so the
      // façade is what stands in front of it.
      expect(/AccountantAuthMiddleware/.test(src)).toBe(true);
    },
  );
});
