// test/hr-ai/storeCommandSearch.integration.test.js
//
// THE TEN QUESTIONS, ANSWERED FROM A DATABASE.
//
// ── WHY THESE EXIST SEPARATELY ────────────────────────────────────────────
// The unit suites prove the grammar compiles, the routing is bounded and the
// permission gates refuse. None of that proves an ANSWER. The previous report
// said ten of ten resolved on the strength of a catalogue lookup: the words
// mapped to a concept, and nothing ever read a record. Five of them would
// have returned nothing, and two would have answered the wrong question
// confidently — a receipt recorded in May offered as one expected in June,
// and every inspection offered as the pending ones.
//
// So each question here is asked of a seeded Store through the same entry
// point the HTTP route calls, and the ANSWER is asserted — the figure, the
// shelf, the five newest of seven — not merely that something came back.
"use strict";

const service = require("../../services/ai/storeCommandSearch.service");
const { seedStore, storeReaderFor, oid } = require("../support/storeCommandFixtures");

let store;
let reader;

beforeEach(async () => {
  store = await seedStore();
  reader = storeReaderFor(store.companyId);
});

const ask = (query, user = reader) => service.search({ user, query });
const titles = (out) => (out.groups || []).flatMap((g) => g.results.map((r) => r.title));
const said = (out) => titles(out).join(" || ");

/* ══ 1 — THE TEN ══════════════════════════════════════════════════════════ */

describe("the ten required questions", () => {
  test("1  a bare name opens the record", async () => {
    const out = await ask("macbook");
    expect(out.state).toBe("answered");
    expect(said(out)).toMatch(/Macbook/);
    /* A row with nowhere to go is not a search result. */
    const [row] = out.groups[0].results;
    expect(row.href).toMatch(/^\/store\/dashboard\/raw-items\//);
    /* And it is the item called Macbook, not the Pro that merely starts the
       same way. */
    expect(said(out)).not.toMatch(/Pro 14/);
  });

  test("2  a figure about a named material", async () => {
    const out = await ask("stock of macbook");
    expect(out.state).toBe("answered");
    expect(said(out)).toMatch(/Macbook/);
    expect(said(out)).toMatch(/\b4\b/);
  });

  test("3  where a material is kept", async () => {
    const out = await ask("where is soda ash kept");
    expect(out.state).toBe("answered");
    expect(said(out)).toMatch(/Soda Ash/);
    expect(said(out)).toMatch(/Bin 2/);
    expect(said(out)).toMatch(/25 Kg/);
  });

  test("4  which rack holds it", async () => {
    const out = await ask("which rack has soda ash");
    expect(out.state).toBe("answered");
    expect(said(out)).toMatch(/Rack 1/);
  });

  test("5  a document number, typed straight in", async () => {
    const out = await ask(store.receiptNumber);
    expect(out.state).toBe("answered");
    expect(said(out)).toContain(store.receiptNumber);
  });

  test("6  a date window, against the date the question named", async () => {
    const out = await ask("goods receipts expected in June 2026");
    expect(out.state).toBe("answered");
    /* The receipt recorded on 20 May is NOT an arrival expected in June, and
       answering with it was the defect. */
    expect(said(out)).not.toContain("GRN/2026-27/0004");
  });

  test("7  the latest five of seven, newest first", async () => {
    const out = await ask("latest five material requests");
    expect(out.state).toBe("answered");
    const sentence = said(out);
    expect(sentence).toContain("MRF-2605-0007");
    expect(sentence).toContain("MRF-2605-0003");
    /* The two oldest are not among the latest five. */
    expect(sentence).not.toContain("MRF-2605-0001");
    expect(sentence).not.toContain("MRF-2605-0002");
    /* And the newest is named before the one before it. */
    expect(sentence.indexOf("MRF-2605-0007")).toBeLessThan(sentence.indexOf("MRF-2605-0006"));
  });

  test("8  the records of one named supplier, and no other's", async () => {
    const out = await ask("purchase orders of Gaurav Enterprises");
    expect(out.state).toBe("answered");
    expect(said(out)).toContain("PO/2026-27/0101");
    expect(said(out)).not.toContain("PO/2026-27/0102");
  });

  test("9  pending work, from the capability that records it", async () => {
    const out = await ask("pending goods receipt inspections");
    expect(out.state).toBe("answered");
    /* The uninspected receipt is the pending one. The inspected receipt is
       not, and listing it was the defect — an inspection record has no
       status field at all, because it exists only once the decision is made. */
    expect(said(out)).toContain("GRN/2026-27/0005");
    expect(said(out)).not.toContain("GRN/2026-27/0004");
  });

  test("10  a shortfall, as the gap the record itself carries", async () => {
    const out = await ask("shortfall for 16mm flex pipe");
    expect(out.state).toBe("answered");
    expect(said(out)).toMatch(/16mm Flex Pipe/);
    expect(said(out)).toMatch(/short by 8 Mtr/);
    expect(said(out)).toMatch(/minimum of 10 Mtr/);
  });

  test("all ten answer, and none of them answers nothing", async () => {
    const QUESTIONS = [
      "macbook", "stock of macbook", "where is soda ash kept",
      "which rack has soda ash", store.receiptNumber,
      "goods receipts expected in June 2026", "latest five material requests",
      "purchase orders of Gaurav Enterprises", "pending goods receipt inspections",
      "shortfall for 16mm flex pipe",
    ];
    for (const question of QUESTIONS) {
      // eslint-disable-next-line no-await-in-loop
      const out = await ask(question);
      expect(["answered", "choices"]).toContain(out.state);
      expect(out.groups[0].results.length).toBeGreaterThan(0);
    }
  });
});

/* ══ 2 — A CONSTRAINT IS NEVER DROPPED ════════════════════════════════════ */

describe("a constraint it cannot place is a refusal, not a broader answer", () => {
  test("a window with no date named is refused, and says which words", async () => {
    const out = await ask("material requests in June 2026");
    expect(out.state).toBe("needs_clarification");
    expect(out.note).toMatch(/June 2026/i);
    expect(out.groups).toEqual([]);
  });

  test("a word that merely CONTAINS a status is not that status", async () => {
    /* `\b` treats a hyphen as a boundary, so "half-approved" matched
       "approved" and this question was answered with the approved requests —
       a filter the person never asked for, applied silently. Store records
       no "half-approved", so the word constrains nothing, and the answer
       must not be the approved subset. */
    const out = await ask("half-approved material requests");
    expect(out.state).toBe("answered");
    const sentence = said(out);
    expect(sentence).toContain("MRF-2605-0002"); // a PENDING one
    /* And it does not claim a filter it did not apply. */
    expect(sentence).not.toMatch(/half-approved/i);
  });

  test("a status that IS recorded filters by it", async () => {
    const out = await ask("pending material requests");
    expect(out.state).toBe("answered");
    /* Four of the seven are PENDING (the even-numbered ones). An answer
       naming an APPROVED one would mean the status was dropped. */
    expect(said(out)).toContain("MRF-2605-0002");
    expect(said(out)).not.toContain("MRF-2605-0001");
  });

  test("words with no meaning in Store are not a licence to read everything", async () => {
    const out = await ask("the of and it");
    expect(out.state).toBe("unsupported");
    expect(out.groups).toEqual([]);
  });
});

/* ══ 3 — AUTHORITY, AGAINST THE DATABASE ══════════════════════════════════ */

describe("authority is the actor's, not the request's", () => {
  test("another company's reader sees none of this company's records", async () => {
    const outsider = storeReaderFor(oid());
    for (const question of ["stock of macbook", "latest five material requests", store.receiptNumber]) {
      // eslint-disable-next-line no-await-in-loop
      const out = await ask(question, outsider);
      expect(said(out)).not.toMatch(/Macbook|MRF-2605|GRN\/2026-27/);
    }
  });

  test("without the Store application grant, nothing at all", async () => {
    const nobody = storeReaderFor(store.companyId);
    nobody.applicationAccess.store.allowed = false;
    const out = await ask("stock of macbook", nobody);
    expect(out.state).toBe("unauthorised");
    expect(out.groups).toEqual([]);
  });

  test("without a company, nothing at all", async () => {
    const homeless = storeReaderFor(store.companyId);
    homeless.storePurchaseAccess.companyId = null;
    const out = await ask("stock of macbook", homeless);
    expect(out.state).toBe("unauthorised");
  });
});

/* ══ 4 — CHOOSING ONE OF SEVERAL ══════════════════════════════════════════ */

describe("a choice resolves by identity, never by its label", () => {
  /* Two items whose names both contain "sodium", so the label cannot
     distinguish them and re-searching it would resolve neither. */
  beforeEach(async () => {
    await require("mongoose").connection.collection("rawitems").insertOne({
      _id: oid(), companyId: store.companyId, name: "Sodium Hydroxide Flake",
      sku: "SODIUM-FLAKE", quantity: 7, unit: "Kg", variants: [], deletedAt: null,
      createdAt: new Date(), updatedAt: new Date(),
    });
  });

  test("an ambiguous name offers canonical choices", async () => {
    const out = await ask("where is sodium kept");
    expect(out.state).toBe("choices");
    expect(out.groups[0].results.length).toBeGreaterThan(1);
    for (const choice of out.groups[0].results) {
      expect(choice.kind).toBe("choice");
      /* The id is what travels. The label never is. */
      expect(choice.resolve.recordId).toMatch(/^[a-f\d]{24}$/i);
      expect(JSON.stringify(choice.resolve)).not.toContain(choice.title);
    }
  });

  test("the chosen record is read, and it is the one chosen", async () => {
    const out = await ask("where is sodium kept");
    const picked = out.groups[0].results.find((r) => /Hydroxide \(/.test(r.title))
      || out.groups[0].results[0];
    const back = await service.resolveChoice({ user: reader, resolution: picked.resolve });
    expect(back.state).toBe("answered");
    expect(back.groups[0].results[0].metadata.recordId).toBe(picked.resolve.recordId);
  });

  test("a capability the person may not use refuses the same id", async () => {
    const out = await ask("where is sodium kept");
    const [picked] = out.groups[0].results;
    const back = await service.resolveChoice({
      user: reader,
      resolution: { ...picked.resolve, tool: "hr_employee_metric" },
    });
    expect(back.state).toBe("unauthorised");
    expect(back.groups).toEqual([]);
  });

  test("a concept belonging to another capability refuses", async () => {
    const out = await ask("where is sodium kept");
    const [picked] = out.groups[0].results;
    const back = await service.resolveChoice({
      user: reader,
      resolution: { ...picked.resolve, concept: "sp.purchase_order.ponumber" },
    });
    expect(back.state).toBe("unsupported");
  });

  test("another company's reader cannot resolve this company's id", async () => {
    const out = await ask("where is sodium kept");
    const [picked] = out.groups[0].results;
    const back = await service.resolveChoice({
      user: storeReaderFor(oid()),
      resolution: picked.resolve,
    });
    /* Not `answered` with a shrug — a failed read is reported as one. */
    expect(back.state).toBe("no_match");
    expect(back.groups).toEqual([]);
  });

  test("an id that is not an id is refused before anything is read", async () => {
    for (const recordId of ["", "../../etc/passwd", "{$ne:null}", "x".repeat(200)]) {
      // eslint-disable-next-line no-await-in-loop
      const back = await service.resolveChoice({
        user: reader,
        resolution: { tool: "inventory_location_metric", concept: "item.locations", recordId },
      });
      expect(["unsupported", "no_match"]).toContain(back.state);
    }
  });
});

/* ══ 5 — WHAT ONE QUESTION COSTS ══════════════════════════════════════════ */

describe("one question is bounded, and reads each subject once", () => {
  test("at most a handful of capabilities are asked, out of a hundred-odd", async () => {
    const authorised = service.storeToolsFor(reader).length;
    expect(authorised).toBeGreaterThan(100);
    const { candidates, identityReads } = await service.claimsFor(reader, "stock of macbook");
    expect(candidates).toBeLessThanOrEqual(6);
    /* One identity read per SUBJECT, not one per capability. */
    expect(identityReads).toBeLessThanOrEqual(candidates);
  });

  test("a question nothing recognises reads nothing", async () => {
    const { candidates, claims, identityReads } = await service.claimsFor(reader, "the of and it");
    expect(candidates).toBe(0);
    expect(claims).toEqual([]);
    expect(identityReads).toBe(0);
  });

  test("an aborted keystroke stops the work", async () => {
    const controller = new AbortController();
    controller.abort();
    const { claims } = await service.claimsFor(reader, "stock of macbook", { signal: controller.signal });
    expect(claims).toEqual([]);
  });
});
