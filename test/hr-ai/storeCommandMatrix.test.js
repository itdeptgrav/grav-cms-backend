// test/hr-ai/storeCommandMatrix.test.js
//
// EVERY STORE & PURCHASE FAMILY, QUESTIONED FROM ITS OWN DECLARATIONS.
//
// ── WHY GENERATED ─────────────────────────────────────────────────────────
// A hand-written list tests the questions somebody thought of. With 53 entity
// families and 2,647 concepts, the ones that quietly do not work are the ones
// nobody typed. So the fixtures seed a representative PAIR of records in every
// family from its own schema, and the matrix builds the questions from the
// catalogue's own vocabulary: the entity's label, a concept's aliases, a
// status concept's recorded values, a date concept's name.
//
// ── AND WHY A PAIR ────────────────────────────────────────────────────────
// A single record cannot catch the failure that matters. "Pending purchase
// orders" answered with the only purchase order there is looks right whether
// the filter was applied or dropped. Every filtered question therefore names
// the record that FAILS its filter and fails if it appears — which is how an
// unfiltered or broader answer is caught, rather than hoped against.
//
// Running this found, and this suite now holds shut, eight real defects:
// a bare plural routed to identity readers instead of the list capability;
// "warehouses" matching no capability because aliases are singular; a window
// refused although the capability had placed it; a workflow value grounded
// only when its field happened to be called `status`; a status word
// swallowed when it was part of a date concept's name; a reference crowded
// out by neighbouring families; two capabilities answering one constrained
// question, one of them unfiltered; and a reference answered by whichever
// capability spoke first rather than the one that found it.
"use strict";

const service = require("../../services/ai/storeCommandSearch.service");
const { seedEveryEntity } = require("../support/storeEntityFixtures");
const { matrix, names } = require("../support/storeQuestionMatrix");
const { storeReaderFor } = require("../support/storeCommandFixtures");
const { ENTITY_SPECS } = require("../../services/storePurchaseUniversalContract");

jest.setTimeout(180000);

/**
 * The questions this build is known NOT to answer.
 *
 * EMPTY, and it has to stay empty: a gap is a question of a supported shape
 * that comes back wrong or not at all, and there are none. What the palette
 * deliberately does not answer is a different thing — a product EXCLUSION,
 * declared in `services/ai/storeCommandExclusions` with its reason and what
 * answers instead, and asserted separately below.
 *
 * The three that used to be here are fixed: a family can now record its
 * workflow on a field not called `status` (a stock-ledger entry's
 * `applicationState`, a development request receipt's `state`), and a
 * question naming two families reaches the one whose name it names most
 * specifically ("goods receipt put-aways" is not a goods-receipt question).
 */
const KNOWN_GAPS = Object.freeze([]);

let world;
let reader;
let outcomes;

beforeAll(async () => {
  world = await seedEveryEntity();
  reader = storeReaderFor(world.companyId);
  const cases = matrix(world.seeded);

  outcomes = [];
  for (const probe of cases) {
    // eslint-disable-next-line no-await-in-loop
    const out = await service.search({ user: reader, query: probe.query });
    const spoken = [out.note || "", ...(out.groups || [])
      .flatMap((group) => group.results.map((row) => `${row.title || ""} ${row.value || ""}`))]
      .join(" || ");
    const failures = [];
    const rows = (out.groups || []).flatMap((group) => group.results);
    if (!probe.unsupported && probe.opens) {
      /* The record itself leads — not a neighbour that mentions its name. */
      const first = rows[0]?.href || "";
      if (!first.endsWith(`/${probe.opens}`)) failures.push(`first row opens ${first || "nothing"}`);
    }
    if (!probe.unsupported) {
      if (probe.states) {
        if (!probe.states.includes(out.state)) failures.push(`state ${out.state}`);
      } else if (!probe.softly && !["answered", "choices"].includes(out.state)) {
        failures.push(`state ${out.state}`);
      }
      for (const want of probe.says || []) {
        /* Whole-token: "202" inside the date "12/6/2026" is not the record
           numbered 202, and a substring test called that a match. */
        if (want && !names(spoken, want)) failures.push(`never said ${want}`);
      }
    }
    /* A broader answer is a failure whether the question was asked or not. */
    const leaks = (probe.never || []).filter((no) => no && names(spoken, no));
    outcomes.push({ ...probe, state: out.state, spoken, failures, leaks });
  }
});

/* ── AND ONCE MORE, WITH A ROUTER BEHIND THE GRAMMAR ────────────────────
   The plan's gate for step 6: the whole matrix with the model UNREACHABLE
   must answer exactly as it does with no router at all. And a second run
   with a hostile router — one that names a real, authorised family for every
   question it is shown — must still never answer more broadly than asked. */
const spokenOf = (out) => [out.note || "", ...(out.groups || [])
  .flatMap((group) => group.results.map((row) => `${row.title || ""} ${row.value || ""}`))].join(" || ");
let unreachable;
let hostile;
let hostileCalls = 0;
beforeAll(async () => {
  const down = () => Promise.reject(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), {
    code: "OLLAMA_UNAVAILABLE",
  }));
  const anyFamily = async ({ menu }) => {
    hostileCalls += 1;
    return { family: menu.families[0]?.label ?? null, concept: null, operation: "list", status: null, value: null };
  };
  unreachable = [];
  hostile = [];
  for (const probe of outcomes) {
    // eslint-disable-next-line no-await-in-loop
    const off = await service.search({ user: reader, query: probe.query, router: down });
    unreachable.push({ probe, state: off.state, spoken: spokenOf(off) });
    // eslint-disable-next-line no-await-in-loop
    const bad = await service.search({ user: reader, query: probe.query, router: anyFamily });
    hostile.push({ probe, state: bad.state, spoken: spokenOf(bad) });
  }
});

describe("with a router behind the grammar", () => {
  test("the model unreachable: every case answers exactly as it does with no router", () => {
    const changed = unreachable.filter((row) => row.state !== row.probe.state || row.spoken !== row.probe.spoken)
      .map((row) => `${row.probe.entity} [${row.probe.kind}] "${row.probe.query}": ${row.probe.state} -> ${row.state}`);
    expect(changed).toEqual([]);
    const asked = unreachable.filter((row) => !row.probe.unsupported);
    process.stdout.write(`\n  matrix, model unreachable: ${asked.length} asked, `
      + `${asked.filter((row) => !row.probe.failures.length && row.state === row.probe.state).length} unchanged\n`);
  });

  test("a hostile router still produces no broader answer", () => {
    /* Not vacuous: the router really was consulted, for every case the
       grammar left unplaced. */
    expect(hostileCalls).toBeGreaterThan(0);
    process.stdout.write(`\n  matrix, hostile router: consulted for ${hostileCalls} of ${hostile.length} cases\n`);
    const leaked = hostile.filter((row) => (row.probe.never || []).some((no) => no && names(row.spoken, no)))
      .map((row) => `${row.probe.entity} [${row.probe.kind}] "${row.probe.query}" -> ${row.spoken.slice(0, 100)}`);
    expect(leaked).toEqual([]);
  });

  test("and it never changes a question the grammar answered", () => {
    const changed = hostile.filter((row) => ["answered", "choices"].includes(row.probe.state))
      .filter((row) => row.state !== row.probe.state || row.spoken !== row.probe.spoken)
      .map((row) => `${row.probe.entity} [${row.probe.kind}] "${row.probe.query}"`);
    expect(changed).toEqual([]);
  });
});

/* Collections are cleared between tests, so everything is asked once in
   `beforeAll` and the assertions read the results. */
afterEach(async () => {});

describe("every family is seeded and asked", () => {
  test("a representative pair exists in all but the families that cannot hold one", () => {
    expect(Object.keys(world.seeded).length).toBeGreaterThanOrEqual(50);
    /* A family skipped for want of a writable identity is named, never
       silently absent. */
    for (const row of world.skipped) {
      expect(typeof row.why).toBe("string");
      expect(row.why.length).toBeGreaterThan(10);
    }
    expect(world.skipped.length).toBeLessThanOrEqual(3);
  });

  test("the questions cover every shape the brief names", () => {
    const kinds = new Set(outcomes.map((row) => row.kind));
    for (const kind of [
      "exact identity", "partial identity", "a field of a named record",
      "list", "count", "status filter", "date filter", "unplaced date window",
      "aggregate", "singleton lookup", "unknown reference", "by name",
    ]) {
      expect(kinds.has(kind)).toBe(true);
    }
    expect(outcomes.length).toBeGreaterThan(350);
  });

  test("they are generated, not written — one per family, from its own words", () => {
    const families = new Set(outcomes.map((row) => row.entity));
    expect(families.size).toBeGreaterThanOrEqual(50);
    expect(families.size).toBeLessThanOrEqual(ENTITY_SPECS.length);
  });
});

/* ══ THE HARD GATE ════════════════════════════════════════════════════════ */

describe("no question is answered more broadly than it was asked", () => {
  test("not one answer contains the record its own filter excludes", () => {
    /* The failure this whole layer exists to prevent: a filtered sentence
       over an unfiltered list. It is asserted for every case, including the
       ones this build cannot answer — a question it cannot answer must not
       answer it wrongly either. */
    const leaked = outcomes.filter((row) => row.leaks.length).map((row) => (
      `${row.entity} [${row.kind}] "${row.query}" said ${row.leaks.join(", ")}`
    ));
    expect(leaked).toEqual([]);
  });

  test("a window with no business date named is never applied to a guess", () => {
    for (const row of outcomes.filter((r) => r.kind === "unplaced date window")) {
      expect(["needs_clarification", "unsupported", "no_match"]).toContain(row.state);
      expect(row.leaks).toEqual([]);
    }
  });
});

describe("every family is reachable", () => {
  test("each one answers at least one question about its own records", () => {
    const byFamily = new Map();
    for (const row of outcomes) {
      if (row.unsupported) continue;
      /* Reachable means a capability ANSWERED about this family's records —
         not merely that nothing was asserted. A question marked `softly`
         still has to produce an answer to count as evidence. */
      const ok = !row.failures.length && ["answered", "choices"].includes(row.state);
      byFamily.set(row.entity, (byFamily.get(row.entity) || false) || ok);
    }
    const unreachable = [...byFamily].filter(([, ok]) => !ok).map(([entity]) => entity);
    /* An unreachable family is a capability nobody can use, which is the
       defect that started this whole correction. */
    expect(unreachable).toEqual([]);
  });

  test("and the identity of a record reaches it in most families", () => {
    const identity = outcomes.filter((r) => r.kind === "exact identity" && !r.unsupported);
    const found = identity.filter((r) => !r.failures.length);
    expect(found.length).toBe(identity.length);
    expect(identity.length).toBeGreaterThan(40);
  });
});

/* ══ WHAT THIS BUILD DOES NOT ANSWER ══════════════════════════════════════ */

describe("the gaps are named, not hidden", () => {
  test("the failing questions are exactly the known ones", () => {
    const failing = outcomes
      .filter((row) => !row.unsupported && row.failures.length)
      .map((row) => `${row.entity}|${row.kind} — ${row.failures.join("; ")}`)
      .sort();
    /* Exact, and empty: a new gap fails here rather than being added to a
       list of permanent excuses. */
    expect(failing).toEqual([...KNOWN_GAPS].sort());
  });

  test("every unasked question is a declared product exclusion", () => {
    const unasked = outcomes.filter((r) => r.unsupported);
    for (const row of unasked) {
      expect(typeof row.unsupported).toBe("string");
      /* The reason AND what answers instead — an exclusion that does not say
         where to go is a dead end wearing a justification. */
      expect(row.unsupported).toMatch(/Instead:/);
      expect(row.unsupported.length).toBeGreaterThan(60);
    }
    /* Exactly two shapes are excluded, and both are refusals to guess:
       a settings document has no reference to type, and a bare integer is
       not one. */
    const kinds = new Set(unasked.map((r) => r.kind));
    expect([...kinds].sort()).toEqual(["exact identity", "partial identity"]);
  });

  test("the exclusions come from the product, not from this suite", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "support", "storeQuestionMatrix.js"), "utf8",
    );
    expect(src).toMatch(/require\("\.\.\/\.\.\/services\/ai\/storeCommandExclusions"\)/);
    const { excludedFamilies } = require("../../services/ai/storeCommandExclusions");
    for (const family of excludedFamilies()) {
      /* A family excluded by name has to BE a family, or the exclusion is
         describing something that no longer exists. */
      expect(family.exists).toBe(true);
      expect(family.instead.length).toBeGreaterThan(20);
    }
  });

  test("and were there one, it would be an EMPTY answer, never a wrong one", () => {
    for (const row of outcomes.filter((r) => !r.unsupported && r.failures.length)) {
      expect(row.leaks).toEqual([]);
      /* It said it found nothing, or it said nothing. Either is honest; a
         confident answer about the wrong records is not. */
      expect(row.failures.every((why) => /never said|state |first row opens/.test(why))).toBe(true);
    }
  });

  test("most questions are answered, and the proportion is pinned", () => {
    const asked = outcomes.filter((row) => !row.unsupported);
    const answered = asked.filter((row) => !row.failures.length);
    expect(asked.length).toBeGreaterThan(400);
    /* The denominators, printed by the suite rather than quoted from memory. */
    process.stdout.write(`\n  matrix: ${outcomes.length} cases, ${asked.length} asked, `
      + `${answered.length} pass, ${outcomes.filter((r) => r.leaks.length).length} broader\n`);
    /* Every one of them. The bar is not "most". */
    expect(answered.length).toBe(asked.length);
  });
});

/* ══ A COLLECTION-ONLY RECORD IS REACHABLE BY ITS NAME ════════════════════ */

describe("a supplier or a material is found by the words a person types", () => {
  test("every collection-only family is asked for a record by name", () => {
    const families = ENTITY_SPECS.filter((spec) => spec.collectionOnly).map((spec) => spec.id);
    const asked = outcomes.filter((row) => row.kind === "by name");
    expect(asked.map((row) => row.entity).sort()).toEqual([...families].sort());
    /* And each name is ALSO on another family's record — without that the
       case could not have caught the defect it exists for. */
    for (const id of families) expect(world.seeded[id].nameMaskedBy).toBeTruthy();
  });

  test("and the record itself answers, first, every time", () => {
    const wrong = outcomes.filter((row) => row.kind === "by name" && row.failures.length)
      .map((row) => `${row.entity} "${row.query}": ${row.failures.join("; ")}`);
    expect(wrong).toEqual([]);
  });

  test("a reference that names no record is refused, never answered with the list", () => {
    const unknown = outcomes.filter((row) => row.kind === "unknown reference" && !row.unsupported);
    expect(unknown.length).toBeGreaterThan(40);
    const broad = unknown.filter((row) => row.failures.length || row.leaks.length)
      .map((row) => `${row.entity} "${row.query}" -> ${row.state}: ${row.spoken.slice(0, 120)}`);
    expect(broad).toEqual([]);
  });
});

/* ══ AND IT IS STILL BOUNDED, AND STILL MODEL-FREE ════════════════════════ */

describe("the route stays bounded and model-free under the whole matrix", () => {
  test("no question asks more than a handful of capabilities", async () => {
    const authorised = service.storeToolsFor(reader).length;
    expect(authorised).toBeGreaterThanOrEqual(107);
    for (const query of [
      "purchase orders", "Q12A7731-1", "pending material requests",
      "goods receipts with receipt date in June 2026",
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const { candidates } = await service.claimsFor(reader, query);
      expect(candidates).toBeLessThanOrEqual(6);
    }
  });

  test("no model module was loaded by any of it", () => {
    const forbidden = /gravAssistant|qwenToolPlanner|qwenClient|ollamaClient/i;
    const loaded = Object.keys(require.cache)
      .filter((file) => forbidden.test(file) && !/test/.test(file));
    expect(loaded).toEqual([]);
  });
});
