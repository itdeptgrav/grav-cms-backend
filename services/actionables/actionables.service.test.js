"use strict";

// The service with its two collaborators replaced: the access resolver (which
// applications this person holds) and the provider registry (what each one
// counts). Proves the wiring, not the counts — no database.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.ACTIONABLES_PROVIDER_TIMEOUT_MS = "40";
process.env.ACTIONABLES_CACHE_MS = "60000";

const calls = { list: 0, providers: [] };
let apps = [];

function stub(rel, exports) {
  const file = require.resolve(path.join(__dirname, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

stub("../access/appAccess.service", {
  listAccessibleApps: async (user) => {
    calls.list += 1;
    if (user.id === "broken") return { ok: false, denialCode: "ACCESS_CHECK_UNAVAILABLE", apps: [] };
    return { ok: true, isPlatformAdmin: false, apps };
  },
});
stub("./actionableProviders", {
  PROVIDERS: {
    hr: async (ctx) => {
      calls.providers.push(["hr", ctx.role, ctx.canApprove]);
      return [{ key: "leave", label: "Leave requests", count: 2, tone: "attention", href: "/hr/leave" }];
    },
    store: async () => {
      calls.providers.push(["store"]);
      return new Promise((r) => setTimeout(() => r([{ key: "x", label: "X", count: 1 }]), 200));
    },
    qc: async () => {
      calls.providers.push(["qc"]);
      throw new Error("boom");
    },
    // a provider for an application the person does NOT hold — must never run
    ceo: async () => {
      calls.providers.push(["ceo"]);
      return [{ key: "secret", label: "Secret", count: 99 }];
    },
  },
});

const { actionablesFor } = require("./actionables.service");

const dept = (slug) => ({ department: { slug, name: slug.toUpperCase() }, access: {
  role: slug === "hr" ? "approver" : "editor",
  capabilities: { approve: slug === "hr" },
} });

test("only the applications the resolver allows are asked; failures are unavailable, never clear", async () => {
  apps = [dept("hr"), dept("store"), dept("qc"), dept("ie")];
  const out = await actionablesFor({ id: "u1", email: "a@x", subject: "dept_user", tv: 0 });
  assert.equal(out.ok, true);
  assert.deepEqual(out.apps.map((a) => [a.slug, a.status]), [
    ["hr", "ok"], ["store", "unavailable"], ["qc", "unavailable"], ["ie", "none"],
  ]);
  assert.ok(!calls.providers.some(([s]) => s === "ceo"), "a provider for an app not held ran");
  assert.deepEqual(calls.providers.find(([s]) => s === "hr"), ["hr", "approver", true]);
  assert.equal(out.totals.pending, 2);
  assert.equal(out.top[0].href, "/hr/leave");
  assert.ok(out.generatedAt);
});

test("the answer is memoised per identity; fresh skips the memo", async () => {
  apps = [dept("hr")];
  const user = { id: "u2", email: "b@x", subject: "dept_user", tv: 0 };
  const before = calls.list;
  await actionablesFor(user);
  await actionablesFor(user);
  assert.equal(calls.list - before, 1);
  await actionablesFor(user, { fresh: true });
  assert.equal(calls.list - before, 2);
  // a different token version is a different session
  await actionablesFor({ ...user, tv: 1 });
  assert.equal(calls.list - before, 3);
});

test("a resolver refusal is passed through and not cached", async () => {
  const before = calls.list;
  const a = await actionablesFor({ id: "broken", email: "c@x" });
  const b = await actionablesFor({ id: "broken", email: "c@x" });
  assert.equal(a.ok, false);
  assert.equal(a.code, "ACCESS_CHECK_UNAVAILABLE");
  assert.equal(b.ok, false);
  assert.equal(calls.list - before, 2);
});
