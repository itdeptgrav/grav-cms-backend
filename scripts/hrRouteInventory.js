#!/usr/bin/env node
"use strict";
/**
 * scripts/hrRouteInventory.js — walk every mounted HR router and pair each
 * route with its authorisation declaration.
 *
 * Two outputs, one source of truth:
 *
 *   node scripts/hrRouteInventory.js --json      machine-readable, for the
 *                                                route-coverage test
 *   node scripts/hrRouteInventory.js --markdown  the endpoint/capability matrix
 *                                                in docs/audits/
 *
 * RUN AS A CHILD PROCESS BY THE TEST, DELIBERATELY. Several HR routers pull in
 * ESM-only dependencies (puppeteer through the payslip PDF renderer,
 * expo-server-sdk through payroll's push notifications) that Jest's CommonJS
 * loader refuses. Loading them in a real node process is both the only way to
 * see those routers and a more faithful check: it is how the server loads them.
 *
 * Read-only. It requires routers and reads `router.stack`; it starts no server
 * and touches no data.
 */

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || "hr-route-inventory";

const { walkMountedRoutes, MOUNTS } = require("../services/access/hrMountRegistry");
const { DECLARATIONS, findDeclaration } = require("../services/access/hrRouteContract");

function build() {
  const walked = walkMountedRoutes();
  const loadErrors = walked
    .filter((r) => r.method === "LOAD_ERROR")
    .map((r) => ({ module: r.module, error: r.error }));

  const routes = walked
    .filter((r) => r.method !== "LOAD_ERROR")
    .map((r) => {
      const d = findDeclaration(r.method, r.full);
      return {
        method: r.method,
        path: r.full,
        module: r.module,
        mount: r.mount,
        declared: Boolean(d),
        declarationKey: d ? `${d.method} ${d.path}` : null,
        declaration: d
          ? {
              path: d.path,
              capabilities: d.capabilities,
              scope: d.scope,
              protectedData: Boolean(d.protectedData),
              persona: d.persona || "",
              note: d.note || "",
            }
          : null,
      };
    });

  /* Keyed on method AND path: two declarations can share a path and differ only
     by verb, which is the normal case for a read/write pair. */
  const used = new Set(
    routes.filter((r) => r.declared).map((r) => `${r.declarationKey}`),
  );
  const stale = DECLARATIONS.filter((d) => !used.has(`${d.method} ${d.path}`)).map(
    (d) => `${d.method} ${d.path}`,
  );

  return {
    mounts: MOUNTS.length,
    routeCount: routes.length,
    declarationCount: DECLARATIONS.length,
    loadErrors,
    undeclared: routes.filter((r) => !r.declared).map((r) => `${r.method} ${r.path}`),
    stale,
    routes,
  };
}

function markdown(data) {
  const byMount = new Map();
  for (const r of data.routes) {
    if (!byMount.has(r.mount)) byMount.set(r.mount, []);
    byMount.get(r.mount).push(r);
  }

  const lines = [];
  lines.push("# HR endpoint / capability matrix");
  lines.push("");
  lines.push("> **Generated.** `node scripts/hrRouteInventory.js --markdown > docs/audits/hr-endpoint-capability-matrix.md`");
  lines.push(">");
  lines.push("> Source of truth: `services/access/hrRouteContract.js` (declarations)");
  lines.push("> and `services/access/hrMountRegistry.js` (mounted routers).");
  lines.push("");
  lines.push(
    `${data.routeCount} mounted routes across ${byMount.size} mount prefixes, ` +
      `${data.declarationCount} declarations, ${data.undeclared.length} undeclared.`,
  );
  lines.push("");
  lines.push("Columns: **Protected** marks a response that can carry private, compensation,");
  lines.push("statutory-identifier, medical or case data. **Scope** is `hr` (inside the HR");
  lines.push("application — global today, see the Chunk 2 note), `self`, `manager` or");
  lines.push("`public`.");
  lines.push("");

  for (const [mount, routes] of [...byMount.entries()].sort()) {
    lines.push(`## \`${mount}\``);
    lines.push("");
    lines.push(`Router: \`${routes[0].module}\``);
    lines.push("");
    lines.push("| Method | Path | Capabilities | Scope | Protected | Persona |");
    lines.push("|---|---|---|---|---|---|");
    for (const r of routes.sort((a, b) => a.path.localeCompare(b.path))) {
      const d = r.declaration;
      lines.push(
        `| ${r.method} | \`${r.path}\` | ${
          d ? (d.capabilities.length ? d.capabilities.map((c) => `\`${c}\``).join("<br>") : "—") : "**UNDECLARED**"
        } | ${d ? d.scope : "—"} | ${d && d.protectedData ? "yes" : ""} | ${d ? d.persona : ""} |`,
      );
    }
    lines.push("");
    const noted = routes.filter((r) => r.declaration && r.declaration.note);
    if (noted.length) {
      lines.push("Notes:");
      lines.push("");
      for (const r of noted) lines.push(`- \`${r.method} ${r.path}\` — ${r.declaration.note}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

const data = build();
const wantMarkdown = process.argv.includes("--markdown");
const body = wantMarkdown
  ? markdown(data)
  : JSON.stringify(data, null, process.argv.includes("--pretty") ? 2 : 0);

/* `--out <file>` rather than a pipe when the caller needs the whole thing.
 *
 * Several HR routers register timers at require time (the C4 presence cron, the
 * attendance notification scheduler), so this process will not exit on its own
 * and has to be told to. `process.exit()` does not wait for a pipe to drain,
 * which silently truncated the JSON at 64 KB — the inventory is ~700 KB. Writing
 * the file synchronously first means the exit cannot lose any of it.
 */
const outIndex = process.argv.indexOf("--out");
if (outIndex !== -1 && process.argv[outIndex + 1]) {
  require("fs").writeFileSync(process.argv[outIndex + 1], body);
  console.log(`wrote ${process.argv[outIndex + 1]} (${body.length} bytes)`);
} else {
  console.log(body);
}
process.exit(0);
