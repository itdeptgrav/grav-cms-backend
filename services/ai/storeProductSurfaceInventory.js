"use strict";

const fs = require("fs");
const path = require("path");

const SOURCE_EXT = /\.(?:js|jsx|mjs|ts|tsx)$/;
const SKIP = /(?:^|\/)(?:node_modules|\.next|coverage)(?:\/|$)|\.(?:test|spec)\.[^.]+$/;

function sourceFiles(roots) {
  const files = [];
  const stack = roots.filter((root) => fs.existsSync(root));
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (SKIP.test(target)) continue;
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile() && SOURCE_EXT.test(entry.name)) files.push(target);
    }
  }
  return files.sort();
}

function normaliseEndpoint(value) {
  let endpoint = String(value || "")
    .replace(/\$\{[^}]+\}/g, ":id")
    .split("${")[0]
    .split(/[?#]/)[0]
    .replace(/[),.;:]+$/, "")
    .replace(/\/+$/, "");
  if (!endpoint.startsWith("/api/")) return null;
  // Parameters following a known collection are represented by the family's
  // prefix; the manifest never relies on real ids or copied production data.
  endpoint = endpoint.replace(/\/:[A-Za-z0-9_]+/g, "/:id");
  return endpoint;
}

function inventoryStoreProduct({ frontendRoot } = {}) {
  const root = frontendRoot || path.resolve(process.cwd(), "../grav-cms");
  const roots = [path.join(root, "app/store"), path.join(root, "components/store")];
  const endpoints = new Map();
  for (const file of sourceFiles(roots)) {
    const source = fs.readFileSync(file, "utf8");
    const matches = source.matchAll(/\/api\/[A-Za-z0-9_./?&=${}:-]+/g);
    for (const match of matches) {
      const endpoint = normaliseEndpoint(match[0]);
      if (!endpoint) continue;
      if (!endpoints.has(endpoint)) endpoints.set(endpoint, new Set());
      endpoints.get(endpoint).add(path.relative(root, file));
    }
  }
  return [...endpoints].map(([endpoint, files]) => ({ endpoint, files: [...files].sort() }))
    .sort((a, b) => a.endpoint.localeCompare(b.endpoint));
}

module.exports = { inventoryStoreProduct, normaliseEndpoint, sourceFiles };
