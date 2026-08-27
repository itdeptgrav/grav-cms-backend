const test = require("node:test");
const assert = require("node:assert/strict");
const { slugify, displayOf } = require("./budgetDepartment.service");

/* ── The three spellings from the brief ──────────────────────────────────── */

test("case and surrounding space fold to one identity", () => {
  const want = "logistics";
  for (const v of ["Logistics", "logistics", "LOGISTICS", " Logistics ", "\tLogistics\n"]) {
    assert.equal(slugify(v), want, `${JSON.stringify(v)} should slugify to ${want}`);
  }
});

test("a MISSPELLING is honestly a different department — that is what aliases are for", () => {
  /* No rule can tell "Logistcs" from a genuinely different word. Folding it
     into "Logistics" would mean silently merging departments on a guess. */
  assert.notEqual(slugify("Logistcs"), slugify("Logistics"));
});

/* ── What else folds ─────────────────────────────────────────────────────── */

test("internal whitespace and punctuation fold", () => {
  assert.equal(slugify("Sales  Support"), "sales-support");
  assert.equal(slugify("Sales-Support"), "sales-support");
  assert.equal(slugify("Sales_Support"), "sales-support");
  assert.equal(slugify("Sales / Support"), "sales-support");
});

test("& and \"and\" are the same word", () => {
  assert.equal(slugify("R&D"), slugify("R and D"));
  assert.equal(slugify("R & D"), slugify("R and D"));
  assert.equal(slugify("Sales & Marketing"), slugify("Sales and Marketing"));
});

test("& is expanded before punctuation is stripped, or R&D would become rd", () => {
  assert.equal(slugify("R&D"), "r-and-d");
});

test("accents fold, so two departments that look identical on screen are one", () => {
  assert.equal(slugify("Opérations"), slugify("Operations"));
  assert.equal(slugify("Opérations"), "operations");
});

/* ── Emptiness ───────────────────────────────────────────────────────────── */

test("anything empty slugifies to the empty string, which callers read as no department", () => {
  for (const v of ["", "   ", "\t", null, undefined, "---", "///"]) {
    assert.equal(slugify(v), "", `${JSON.stringify(v)} should be empty`);
  }
});

test("punctuation-only input is empty, but & is a WORD and survives as one", () => {
  /* Not a wart worth fixing: "&" genuinely means "and", so a department
     called "&&&" is "and and and" and gets a stable identity like any other
     nonsense name. What matters is that it is stable, not that it is
     dignified. */
  assert.equal(slugify("&&&"), "and-and-and");
  assert.equal(slugify("&&&"), slugify("and and and"));
});

test("a numeric or non-string value does not throw", () => {
  assert.equal(slugify(42), "42");
  assert.equal(slugify(0), "0");
});

/* ── Stability ───────────────────────────────────────────────────────────── */

test("slugifying a slug is a no-op, so a stored slug round-trips", () => {
  for (const v of ["logistics", "r-and-d", "sales-support"]) {
    assert.equal(slugify(v), v);
  }
});

test("leading and trailing separators never survive", () => {
  assert.equal(slugify("-Logistics-"), "logistics");
  assert.equal(slugify("  --Logistics--  "), "logistics");
});

/* ── Display form ────────────────────────────────────────────────────────── */

test("the display form tidies whitespace but never invents a spelling", () => {
  assert.equal(displayOf("  Logistics  "), "Logistics");
  assert.equal(displayOf("Sales   Support"), "Sales Support");
  /* Case is NOT touched: normalising the case of a department nobody
     registered would be choosing a spelling on the user's behalf. */
  assert.equal(displayOf("LOGISTICS"), "LOGISTICS");
  assert.equal(displayOf(null), "");
});
