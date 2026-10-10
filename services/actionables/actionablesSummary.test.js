"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { summarise, cleanItem, withTimeout, STATUS } = require("./actionablesSummary");

test("cleanItem drops empty, zero and malformed items", () => {
  assert.equal(cleanItem(null), null);
  assert.equal(cleanItem({ key: "a", label: "A", count: 0 }), null);
  assert.equal(cleanItem({ key: "a", label: "A", count: -2 }), null);
  assert.equal(cleanItem({ key: "", label: "A", count: 1 }), null);
  assert.equal(cleanItem({ key: "a", label: "A", count: "x" }), null);
  assert.deepEqual(cleanItem({ key: "a", label: "A", count: 2.7, tone: "loud", href: "/hr" }), {
    key: "a", label: "A", count: 2, tone: "info", href: "/hr",
  });
});

test("cleanItem keeps only in-app paths, never a URL", () => {
  assert.equal(cleanItem({ key: "a", label: "A", count: 1, href: "https://evil.example" }).href, null);
  assert.equal(cleanItem({ key: "a", label: "A", count: 1, href: "//evil.example" }).href, null);
  assert.equal(cleanItem({ key: "a", label: "A", count: 1, href: "/store/x" }).href, "/store/x");
});

test("summarise ranks across applications: urgent, then attention, then by count", () => {
  const out = summarise([
    { slug: "hr", name: "HR", role: "owner", status: STATUS.OK, items: [
      { key: "leave", label: "Leave", count: 3, tone: "attention", href: "/hr" },
      { key: "none", label: "Nothing", count: 0, tone: "urgent" },
    ] },
    { slug: "store", name: "Store", role: "editor", status: STATUS.OK, items: [
      { key: "mrf", label: "MRFs", count: 9, tone: "info" },
      { key: "late", label: "Late POs", count: 1, tone: "urgent" },
    ] },
    { slug: "qc", name: "QC", status: STATUS.OK, items: [] },
    { slug: "ie", name: "IE", status: STATUS.NONE, items: [] },
    { slug: "ppc", name: "PPC", status: STATUS.UNAVAILABLE, items: [{ key: "x", label: "X", count: 5 }] },
  ]);

  assert.deepEqual(out.top.map((i) => `${i.slug}:${i.key}`), ["store:late", "hr:leave", "store:mrf"]);
  assert.equal(out.top[0].appName, "Store");
  assert.deepEqual(out.totals, {
    pending: 13, urgent: 1, attention: 3, apps: 5, appsWithWork: 2, appsClear: 1, appsUnavailable: 1,
  });
  // an unavailable application never contributes counts, and is never "clear"
  const ppc = out.apps.find((a) => a.slug === "ppc");
  assert.equal(ppc.pending, 0);
  assert.deepEqual(ppc.items, []);
  // catalogue order is kept for the blocks
  assert.deepEqual(out.apps.map((a) => a.slug), ["hr", "store", "qc", "ie", "ppc"]);
  assert.equal(out.apps[1].tone, "urgent");
  assert.equal(out.apps[2].tone, null);
});

test("summarise caps the attention list", () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, label: `L${i}`, count: i + 1 }));
  const out = summarise([{ slug: "a", name: "A", status: STATUS.OK, items }], { maxTop: 5 });
  assert.equal(out.top.length, 5);
  assert.equal(out.top[0].count, 20);
  assert.equal(out.apps[0].items.length, 20);
});

test("withTimeout rejects a slow read and passes a fast one", async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 50), 7);
  await assert.rejects(withTimeout(new Promise((r) => setTimeout(r, 200)), 20, "slow"), /slow timed out/);
});
