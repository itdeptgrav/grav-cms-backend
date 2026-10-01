/* Dump every accountant endpoint that REQUIRES a company, as full URL paths.
 *
 * `companyScope` refuses a request that names no company with
 * "companyId is required for this request." — the error that made every invoice
 * unopenable. This lists the endpoints where that can happen, so the frontend
 * can be checked against it rather than guessed at.
 *
 * Output: JSON [{ method, path }] on stdout.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const server = fs.readFileSync("server.js", "utf8");

/** file basename -> mount prefix, read from server.js's app.use() pairs. */
const mounts = new Map();
const mountRe =
  /app\.use\(\s*(?:\n\s*)?["'`]([^"'`]+)["'`]\s*,[\s\S]{0,400}?require\(\s*["'`]\.\/routes\/Accountant_Routes\/([A-Za-z0-9_]+)["'`]/g;
let m;
while ((m = mountRe.exec(server))) {
  if (!mounts.has(m[2])) mounts.set(m[2], m[1]);
}

const out = [];
const dir = "routes/Accountant_Routes";
for (const file of fs.readdirSync(dir)) {
  if (!file.endsWith(".js")) continue;
  const base = file.replace(/\.js$/, "");
  const prefix = mounts.get(base);
  if (!prefix) continue; // not mounted directly (sub-router or unused)
  const src = fs.readFileSync(path.join(dir, file), "utf8");
  const routeRe =
    /^router\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]*)["'`]\s*,([^)]*)/gm;
  let r;
  while ((r = routeRe.exec(src))) {
    const [, method, route, middleware] = r;
    if (!/\bcompanyScope\b/.test(middleware)) continue;
    if (/companyScopeOptional/.test(middleware)) continue;
    const full = (prefix + (route === "/" ? "" : route)).replace(/\/+/g, "/");
    out.push({ method: method.toUpperCase(), path: full });
  }
}
process.stdout.write(JSON.stringify(out, null, 0));
