// node --test services/inventory/variantIdentity.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { assignIds, duplicateIds } = require("./variantIdentity.js");

const X = "66f000000000000000000001";
const Y = "66f000000000000000000002";
const row = (_id, quantity, ...combination) => ({ _id, combination, quantity });
const ids = (out) => out.map((o) => String(o._id));

test("a row keeps its stored variant by combination, with the spaces trimmed, else by id", () => {
  const stored = [row(X, 5, "Fancy Corner", "Green", "18L"), row(Y, 7, "Fancy Corner", "Blue", "18L")];
  const out = assignIds([
    { combination: ["Fancy Corner", "Blue ", "18L"] },
    { _id: X, combination: ["Fancy Corner", "Green Khaki", "18L"] },   // a true rename: no Green row left
    { combination: ["Fancy Corner", "Red", "18L"] },
  ], stored);
  assert.deepEqual(ids(out).slice(0, 2), [Y, X]);
  assert.equal(out[0].existing.quantity, 7, "Blue found by combination");
  assert.equal(out[1].existing.quantity, 5, "the renamed row keeps Green's identity and balance");
  assert.equal(out[2].existing, null, "Red is new");
  assert.ok(![X, Y].includes(ids(out)[2]));
});

test("a renamed row that left its old combination behind is a NEW variant; the old combination keeps the identity", () => {
  const stored = [row(X, 5, "Fancy Corner", "Green", "18L")];
  const out = assignIds([
    { _id: X, combination: ["Fancy Corner", "Green Khaki", "18L"] }, // carries X, listed FIRST
    { combination: ["Fancy Corner", "Green", "18L"] },               // the old combination, no id
  ], stored);
  assert.equal(ids(out)[1], X, "Green is the stored Green whatever the form sent");
  assert.notEqual(ids(out)[0], X);
  assert.equal(out[0].existing, null, "Green Khaki starts with no balance — the balance is not doubled");
  assert.equal(out[1].existing.quantity, 5);
});

test("an item already saved with one id on two variants is matched row by row and repaired", () => {
  const stored = [row(X, 5, "Fancy Corner", "Green", "18L"), row(X, 9, "Fancy Corner", "Green Khaki", "18L")];
  assert.deepEqual(duplicateIds(stored), [X]);
  const out = assignIds([
    { _id: X, combination: ["Fancy Corner", "Green", "18L"] },
    { _id: X, combination: ["Fancy Corner", "Green Khaki", "18L"] },
  ], stored);
  assert.equal(out[0].existing.quantity, 5, "Green finds its own stored row");
  assert.equal(out[1].existing.quantity, 9, "Green Khaki finds its own stored row, not Green's");
  assert.equal(ids(out)[0], X);
  assert.notEqual(ids(out)[1], X, "the second gets a fresh identity — the save repairs the item");
  assert.equal(new Set(ids(out)).size, 2);
});

test("adding an attribute keeps each stored identity and balance on the first row built from it", () => {
  const stored = [row(X, 100, "Fancy Corner", "Green"), row(Y, 7, "Fancy Corner", "Blue")];
  const out = assignIds([
    { combination: ["Fancy Corner", "Green", "18L"] }, { combination: ["Fancy Corner", "Green", "14L"] },
    { combination: ["Fancy Corner", "Blue", "18L"] }, { combination: ["Fancy Corner", "Blue", "14L"] },
  ], stored);
  assert.deepEqual(ids(out).map((v) => ([X, Y].includes(v) ? v : "new")), [X, "new", Y, "new"]);
  assert.equal(out[0].existing.quantity, 100);
  assert.equal(out[1].existing, null);
});

test("removing an attribute keeps the first stored kin; a true rename by id still wins over kin", () => {
  const stored = [row(X, 5, "Fancy Corner", "Green", "18L"), row(Y, 9, "Fancy Corner", "Green", "14L")];
  const out = assignIds([{ combination: ["Fancy Corner", "Green"] }], stored);
  assert.equal(ids(out)[0], X);
  const renamed = assignIds([{ _id: Y, combination: ["Fancy Corner", "Olive", "14L"] }, { combination: ["Fancy Corner", "Green"] }], stored);
  assert.deepEqual(ids(renamed), [Y, X], "Olive keeps Y by id; the short Green row takes the remaining kin, X");
});

test("a stored variant is claimed once even when two rows name its combination", () => {
  const stored = [row(X, 5, "Fancy Corner", "Green", "18L")];
  const out = assignIds([{ _id: X, combination: ["Fancy Corner", "Green", "18L"] }, { _id: X, combination: ["Fancy Corner", "Green", "18L"] }], stored);
  assert.equal(ids(out)[0], X);
  assert.notEqual(ids(out)[1], X);
  assert.equal(out[1].existing, null);
});
