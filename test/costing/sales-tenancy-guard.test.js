// test/costing/sales-tenancy-guard.test.js
//
// A STATIC GUARD AGAINST THE NEXT UNSCOPED QUERY.
//
// ── WHY A SCANNER AND NOT A CONVENTION ──────────────────────────────────────
// Chunk 3A has now been corrected three times, and each time the defect was
// the same: an ownership field that existed, and a query that did not use it.
// A convention ("remember the company clause") holds until the next route is
// written, and the one that forgets looks exactly like the ones that did not —
// it works, it returns data, and nothing fails until the data belongs to
// somebody else.
//
// So this reads the production source and fails when a direct Enquiry or
// SalesJourney query appears outside the approved helpers. It is a blunt
// instrument on purpose: a new unscoped query should be inconvenient to add
// and impossible to add silently.
//
// ── THE ALLOWLIST IS SMALL, NAMED AND ARGUED ────────────────────────────────
// Every entry below is a line somebody had to justify. Adding one is a
// deliberate act with a reason attached; that is the point.
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "../..");
const SCANNED = ["routes", "services", "Middlewear"];

/**
 * Files permitted to query these models without a request scope, and why.
 *
 * A path here is NOT "trusted": each one is either the scope machinery itself,
 * or a flow whose authorisation is proved another way and tested separately.
 */
const ALLOWLIST = new Map([
  /* The scope helpers themselves — the one implementation everything else
     goes through. Excluding them is what lets the rule exist at all. */
  ["services/companyContext/salesScope.service.js", "the shared request scope implementation"],
  ["services/companyContext/serviceScope.service.js", "the shared service-context scope implementation"],
  ["services/companyContext/ownershipStamp.service.js", "resolves ownership; queries no Sales record"],

  /* NOTE: `services/companyContext/merchandisingScope.service.js` is
     deliberately NOT here. It builds the Merchandising style bound from the
     Sales parents and every one of its reads carries `companyClause`, so it
     passes the scan on its own merits. An earlier draft needed an exemption
     for one query that enumerated every unstamped journey in the database;
     that query is gone, and so is the exemption — an allowlist entry is for
     code that CANNOT carry a request scope, and this code can. */

  /* Company-scoped by construction through a service context, and covered by
     their own tests. They take `{companyId, reason}` and put it in the query. */
  ["services/closingVerdict.js", "takes an explicit {companyId, reason} service context"],
  ["services/sampleStyleEmail.service.js", "takes an explicit service context; returns nothing without one"],
  ["services/centralCosting/contextResolver.service.js", "costing's own scoped enquiry resolution"],

  /* NOTE: `routes/CMS_Routes/Sales/enquiries.js` is deliberately NOT here.
     Exempting the whole file for the sake of its one public-token query would
     mean the next unscoped query added anywhere in three thousand lines went
     unnoticed — the exact failure this guard exists to prevent. That single
     query carries a line-level marker instead (see REVIEWED_MARKER), and the
     rest of the file is scanned normally. */
]);

/**
 * A per-query exemption, placed on the line above the query it excuses.
 *
 * Narrow on purpose: it covers the NEXT query and nothing else, it is visible
 * in a diff, and it cannot be added by accident. The one use today is
 * `resolveCostingApprovalToken` — a lookup by SHA-256 of an unguessable,
 * single-use, time-bounded secret, on a public route with no CMS actor to
 * scope by, where taking a company from the requested record is the
 * circularity the tenant rules refuse.
 */
const REVIEWED_MARKER = "tenancy-guard:reviewed-public-token";

/** `Model.find*`, `Model.update*`, `Model.delete*`, `Model.aggregate`… */
const DIRECT = /\b(Enquiry|SalesJourney|Account|Lead|Contact)\s*\.\s*(find\w*|update\w*|delete\w*|remove\w*|aggregate|countDocuments)\s*\(/;

/** …unless the very same statement folds the scope in. */
/**
 * The established scoped forms.
 *
 * `$and: [<clause>,` covers a helper that received an already-resolved clause
 * as a PARAMETER rather than building one — the pattern
 * `assertUsableAccount(id, label, scope)` uses, which is scoped precisely
 * because the caller resolved the company once and passed it down.
 */
const SCOPED = new RegExp([
  "await\\s+scoped\\(req",
  /* ── A SESSION-LESS SCOPE, FROM AN AUTHORISED RECORD ──────────────────
     `scopedForEnquiry` defers to `scoped(req, …)` whenever there is a
     session, and otherwise pins the company to the enquiry an opaque
     approval token already resolved to. Every path returns a filter carrying
     a company or throws, which is what this list is for — the customer
     approval link has no session to scope by and must still not read across
     tenants. */
  "await\\s+scopedForEnquiry\\(",
  "scopedFilter",
  "serviceFilter",
  "companyClause",
  "scopedList",
  "await\\s+salesScoped",
  /* a resolved clause threaded in as an argument */
  "\\$and:\\s*\\[\\s*(scope|sourceScope|companyScope|clause)\\b",
].join("|"));

/** Blank out comment text so prose cannot satisfy a code test. */
function stripComments(lines) {
  let inBlock = false;
  return lines.map((raw) => {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end === -1) return "";
      line = line.slice(end + 2);
      inBlock = false;
    }
    /* Strip complete /* … *\/ spans, then an unterminated opener. */
    line = line.replace(/\/\*[\s\S]*?\*\//g, " ");
    const open = line.indexOf("/*");
    if (open !== -1) { inBlock = true; line = line.slice(0, open); }
    const slash = line.indexOf("//");
    return slash === -1 ? line : line.slice(0, slash);
  });
}

/**
 * Does a reviewed marker apply to the query on `index`?
 *
 * ── THE COMMENT BLOCK IMMEDIATELY ABOVE, AND NOTHING FURTHER ────────────────
 * A marker sits in a comment explaining WHY the query is exempt, and that
 * explanation is usually several lines. So the scan walks back over the
 * contiguous comment (and blank lines) directly above the query and asks
 * whether any of it carries the marker.
 *
 * It stops at the first line of actual CODE. That is what keeps the exemption
 * narrow: a second query cannot inherit it, because the first query is a code
 * line and ends the scan.
 */
function markerAppliesTo(lines, code, index) {
  /* Whether a line is comment-or-blank is decided by the SAME stripper the
     rest of the guard uses, rather than by guessing at prefixes — the middle
     line of a wrapped block comment starts with an ordinary word and would
     otherwise be mistaken for code. */
  for (let i = index - 1; i >= 0; i -= 1) {
    const raw = (lines[i] || "").trim();
    if (!raw) continue;
    if (raw.includes(REVIEWED_MARKER)) return true;
    if ((code[i] || "").trim()) return false;   // real code — the block ended
  }
  return false;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

describe("no unscoped Enquiry or SalesJourney query reaches production", () => {
  const offenders = [];

  beforeAll(() => {
    for (const root of SCANNED) {
      const dir = path.join(ROOT, root);
      if (!fs.existsSync(dir)) continue;
      for (const file of walk(dir)) {
        const rel = path.relative(ROOT, file);
        if (ALLOWLIST.has(rel)) continue;
        const lines = fs.readFileSync(file, "utf8").split("\n");
        /* ── COMMENTS ARE NOT CODE ──────────────────────────────────────
           A prose line explaining `sourceScope` used to satisfy the scoped
           test, so a comment could make an unscoped query look scoped. Both
           the query detection and the scope detection now run on source with
           comments stripped. */
        const code = stripComments(lines);

        code.forEach((line, i) => {
          if (!DIRECT.test(line)) return;
          /* ── THE MARKER EXEMPTS THE VERY NEXT QUERY, AND ONLY IT ───────
             A three-line window let a second unscoped query sit near a marker
             and inherit its exemption. The marker must be the last thing
             before the query: scanning back, the first non-blank CODE line
             above must be the marker's own line. */
          if (markerAppliesTo(lines, code, i)) return;
          /* The scope may be on this line or the one that opened the call. */
          const window = [code[i - 1] || "", line, code[i + 1] || ""].join(" ");
          if (SCOPED.test(window)) return;
          offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`);
        });
      }
    }
  });

  test("there are no unscoped Enquiry, SalesJourney, Account, Lead or Contact queries", () => {
    /* ── ZERO, NOT A RATCHET ────────────────────────────────────────────
       This was a recorded-debt ratchet while 114 queries were outstanding.
       They are scoped now, so the honest expectation is an empty list: a
       ratchet whose number never reaches zero is a way of living with the
       problem, and the number is zero.

       If this fails, scope the query. Do not add a file to the allowlist —
       an allowlist entry is for code that CANNOT carry a request scope, not
       for code that has not been given one yet. */
    expect(offenders).toEqual([]);
  });


  test("the allowlist stays small, and every entry carries a reason", () => {
    expect(ALLOWLIST.size).toBeLessThanOrEqual(8);
    for (const [file, reason] of ALLOWLIST) {
      expect(fs.existsSync(path.join(ROOT, file))).toBe(true);
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  test("the guard catches an unscoped query on every guarded model", () => {
    /* A scanner that matches nothing passes forever. */
    for (const sample of [
      "  const e = await Enquiry.findOne({ _id: req.params.id });",
      "await SalesJourney.aggregate([{ $match: {} }])",
      "const a = await Account.findById(b.accountId).lean();",
      "const l = await Lead.findOne({ _id: id });",
      "await Contact.countDocuments({ accountId: id })",
    ]) {
      expect(DIRECT.test(sample)).toBe(true);
    }
  });

  test("and accepts the established scoped forms", () => {
    for (const sample of [
      "await Enquiry.findOne(await scoped(req, { _id: id }))",
      "await Account.findOne({ $and: [sourceScope, { _id: id }] })",
      "await Enquiry.findOne(serviceFilter(ctx, { _id: id }))",
      "SalesJourney.countDocuments(scopedList)",
    ]) {
      expect(SCOPED.test(sample)).toBe(true);
    }
  });

  test("a second unscoped query near the marker is still caught", () => {
    /* The marker used to excuse anything within three lines, so a second
       query could sit beside a reviewed one and inherit its exemption. It now
       excuses only the query it immediately precedes. */
    const lines = [
      "  // tenancy-guard:reviewed-public-token",
      "  const a = await Enquiry.findOne({ tokenHash: h });",
      "  const b = await Enquiry.findOne({ _id: id });",
    ];
    const code = stripComments(lines);
    expect(markerAppliesTo(lines, code, 1)).toBe(true);
    expect(markerAppliesTo(lines, code, 2)).toBe(false);
  });

  test("a comment mentioning a scope word cannot make a query look scoped", () => {
    const lines = [
      "  /* uses sourceScope elsewhere */",
      "  const a = await Account.findById(id);",
    ];
    const code = stripComments(lines);
    expect(SCOPED.test([code[0], code[1]].join(" "))).toBe(false);
    expect(DIRECT.test(code[1])).toBe(true);
  });

  test("the reviewed marker exempts one query, not a file", () => {
    const src = fs.readFileSync(
      path.join(ROOT, "routes/CMS_Routes/Sales/enquiries.js"), "utf8",
    );
    /* Exactly one marker, and the file is still scanned — proved by the fact
       that it is not on the allowlist above. */
    expect(src.split(REVIEWED_MARKER).length - 1).toBe(1);
    expect(ALLOWLIST.has("routes/CMS_Routes/Sales/enquiries.js")).toBe(false);
  });
});
