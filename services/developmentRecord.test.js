// services/developmentRecord.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildDevelopmentRecord } = require("./developmentRecord");

const keys = (r) => r.evidence.map((e) => e.key);

test("a hand-typed style has nothing to stand on, and says so", () => {
  const r = buildDevelopmentRecord({});
  assert.equal(r.registered, false);
  assert.equal(r.proven, false);
  assert.deepEqual(r.evidence, []);
  assert.match(r.gaps[0], /typed by hand/);
});

test("REGISTERED IS NOT DEVELOPED — a bare stock item proves nothing", () => {
  // The failure this whole file exists to prevent: an item created with a name
  // and nothing else must not wave a style past R&D.
  const r = buildDevelopmentRecord({ stockItem: { name: "Gym Tshirt", reference: "PROD-1" } });
  assert.equal(r.registered, true);
  assert.equal(r.proven, false, "no operations, no BOM, no prior sample");
  assert.equal(r.gaps.length, 3);
});

test("a measured SAM is strong evidence — nobody types timings speculatively", () => {
  const r = buildDevelopmentRecord({
    stockItem: { name: "X", operations: [{ totalSeconds: 60 }, { totalSeconds: 90 }] },
  });
  assert.ok(keys(r).includes("sam"));
  assert.equal(r.evidence.find((e) => e.key === "sam").strength, "strong");
  assert.match(r.evidence.find((e) => e.key === "sam").label, /2\.5 min measured/);
  assert.equal(r.proven, true);
});

test("operations with NO times are weak, and do not prove development on their own", () => {
  const r = buildDevelopmentRecord({ stockItem: { name: "X", operations: [{ totalSeconds: 0 }, {}] } });
  assert.equal(r.evidence.find((e) => e.key === "operations").strength, "weak");
  assert.equal(r.proven, false);
});

test("a costed BOM is SUPPORTING, not proof — it can be typed off a spec sheet", () => {
  const r = buildDevelopmentRecord({
    stockItem: { name: "X", variants: [{ rawItems: [{ quantity: 1.6, unitCost: 65 }, { quantity: 12, unitCost: 0.25 }] }] },
  });
  const bom = r.evidence.find((e) => e.key === "bom");
  assert.equal(bom.strength, "supporting");
  assert.match(bom.detail, /107/);
  assert.equal(r.proven, false, "a bill of materials does not mean the garment was ever cut");
});

test("the BOM is read from the first variant that has one — they differ by size, not by material", () => {
  const r = buildDevelopmentRecord({
    stockItem: { name: "X", variants: [{ rawItems: [] }, { rawItems: [{ quantity: 1, unitCost: 10 }] }] },
  });
  assert.ok(keys(r).includes("bom"));
});

test("measurements and pictures are SUPPORTING only — they describe an intention", () => {
  const r = buildDevelopmentRecord({
    stockItem: { name: "X", measurements: [{}, {}], images: ["a.jpg"] },
  });
  assert.deepEqual(keys(r).sort(), ["images", "measurements"]);
  assert.equal(r.proven, false, "you can measure and photograph a garment you never made");
});

test("a prior APPROVED sample is the strongest evidence and names where it happened", () => {
  const r = buildDevelopmentRecord({
    stockItem: { name: "X", reference: "PROD-1" },
    priorStyles: [
      { journeyRef: "SJ-2026-0002", sample: { status: "rejected", approvedAt: null } },
      { journeyRef: "SJ-2026-0009", sample: { status: "approved", approvedAt: "2026-05-04", rounds: [{}, {}] } },
    ],
  });
  const prior = r.evidence.find((e) => e.key === "priorSample");
  assert.equal(prior.strength, "strong");
  assert.match(prior.detail, /SJ-2026-0009/);
  assert.match(prior.detail, /2026-05-04/);
  assert.match(prior.detail, /2 rounds/);
  assert.equal(r.proven, true);
  assert.ok(!r.gaps.some((g) => /earlier sample/.test(g)));
});

test("prior styles that were never approved do not count", () => {
  const r = buildDevelopmentRecord({
    stockItem: { name: "X" },
    priorStyles: [{ journeyRef: "SJ-1", sample: { status: "in_progress" } }],
  });
  assert.ok(!keys(r).includes("priorSample"));
  assert.equal(r.proven, false);
  assert.ok(r.gaps.some((g) => /earlier sample/.test(g)));
});

test("the most recent approval is the one reported", () => {
  const r = buildDevelopmentRecord({
    stockItem: { name: "X" },
    priorStyles: [
      { journeyRef: "OLD", sample: { status: "approved", approvedAt: "2024-01-01" } },
      { journeyRef: "NEW", sample: { status: "approved", approvedAt: "2026-06-01" } },
    ],
  });
  assert.match(r.evidence.find((e) => e.key === "priorSample").detail, /NEW/);
});

/* ── The waiver bar: has it actually been MADE? ───────────────────────────── */

test("the only two things that prove a garment was made", () => {
  const priorApproved = buildDevelopmentRecord({
    stockItem: { name: "X" }, priorStyles: [{ sample: { status: "approved", approvedAt: "2026-01-01" } }],
  });
  const measuredSam = buildDevelopmentRecord({ stockItem: { name: "X", operations: [{ totalSeconds: 120 }] } });
  assert.equal(priorApproved.proven, true);
  assert.equal(measuredSam.proven, true);
});

test("everything a person can author in advance proves nothing, alone or together", () => {
  const authored = buildDevelopmentRecord({
    stockItem: {
      name: "Gym Tshirt", reference: "PROD-T-S-GYMTSH-083",
      variants: [{ rawItems: [{ quantity: 1.6, unitCost: 65 }] }],
      measurements: [{}, {}, {}],
      images: ["a.jpg", "b.jpg"],
      operations: [{ totalSeconds: 0 }],
    },
  });
  assert.equal(authored.proven, false, "BOM + measurements + pictures + untimed operations is still not a made garment");
  assert.ok(authored.evidence.length >= 3, "they are all still shown — useful, just not proof");
});
