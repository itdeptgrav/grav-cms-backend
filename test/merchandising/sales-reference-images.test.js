// test/merchandising/sales-reference-images.test.js
//
// THE BUYER'S PICTURES REACH THE ORDER — THROUGH ONE AUTHORITATIVE LINK.
//
// ── THE DEFECT ──────────────────────────────────────────────────────────────
// The reference-image read looked at
// `SalesHandoverVersion.developmentReference.developmentFileId`. Nothing in the
// live Sales issue has ever written that field — only the complete-order demo
// stamps it. So the demo showed a populated gallery and a real order showed
// nothing, with no explanation, and the gap was invisible precisely because the
// demo "proved" it worked.
//
// Stamping it from Sales would be the wrong repair: a Development File id is a
// Merchandising record, and giving Sales a handle on one is what the ownership
// boundary exists to prevent. Merchandising joins its own two records instead, by
// the stable `sampleStyleId`, records the answer once on the Execution File, and
// BOM lineage and images then read the same link.
//
// What this suite proves:
//   1  A live handover — nothing stamped — resolves the images.
//   2  The link is RECORDED on the file, and recorded once.
//   3  Another company's Development record and its images are unreachable.
//   4  A similar display style code is NOT evidence; only the stable id is.
//   5  An honest reason is given when there is nothing, per cause.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const {
  DevelopmentFile, DevelopmentBomRevision,
} = require("../../models/CMS_Models/Merchandising/Development");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const {
  SalesDevelopmentRequest,
} = require("../../models/CMS_Models/Sales/DevelopmentRequest");
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const adoption = require("../../services/merchandising/developmentAdoption.service");

let seq = 0;
const oid = () => new mongoose.Types.ObjectId();
const IMG = (n) => `https://res.cloudinary.com/demo/image/upload/ref-${n}.jpg`;

/** A company, a style identity, a Sales request with pictures, its Development file. */
async function world({ withImages = true, styleId = null } = {}) {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `Img Co ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const sampleStyleId = styleId || oid();

  const request = await SalesDevelopmentRequest.create({
    companyId: co._id, requestRef: `SDR-${n}`, versionNo: 1,
    journeyId: oid(), enquiryId: oid(), productLineRef: `PL-${n}`,
    accountId: oid(), productName: `Polo ${n}`, styleRef: `SC-${n}`,
    sampleStyleId,
    referenceImages: withImages
      ? [
        { url: IMG(`${n}-a`), caption: "Front view", referenceType: "PRODUCT", storageRef: `sr-${n}-a` },
        { url: IMG(`${n}-b`), caption: "Buyer's own sample", referenceType: "BUYER_SAMPLE" },
      ]
      : [],
    requirementSummary: "Two-colour chest print.",
  });

  const devFile = await DevelopmentFile.create({
    companyId: co._id, developmentNumber: `DEV-${n}`, productName: `Polo ${n}`,
    styleRef: `SC-${n}`, sampleStyleId, currentRequestId: request._id,
    journeyId: request.journeyId, productLineRef: `PL-${n}`,
  });

  /* ── THE SALES RECORDS THE EXACT KEY IS DERIVED FROM ──────────────────────
     A SampleStyle carrying the journey, and an order whose line carries the
     product-line reference. Both are Sales-owned; Merchandising reads them and
     looks up its OWN file on `{companyId, journeyId, productLineRef}`, which the
     collection's unique index makes unambiguous by construction. */
  await SampleStyle.create({
    _id: sampleStyleId, sampleStyleId: `SS-${n}`, styleCode: `SC-${n}`,
    productName: `Polo ${n}`, journeyId: request.journeyId, enquiryId: oid(),
    stage: "rnd",
  });
  const order = await CustomerRequest.create({
    requestId: `REQ-IMG-${n}`, status: "quotation_sales_approved", orderOrigin: "customer",
    customerInfo: { name: `Buyer ${n}` },
    items: [{
      stockItemName: `Polo ${n}`, totalQuantity: 100, totalEstimatedPrice: 100,
      sampleStyleId, productLineRef: `PL-${n}`,
    }],
  });
  const savedOrder = await CustomerRequest.findById(order._id).lean();

  return {
    co, sampleStyleId, request, devFile, n,
    order: savedOrder, lineRef: String(savedOrder.items[0].lineRef),
  };
}

/** An accepted Execution File whose projection carries the stable style id. */
const fileFor = (co, sampleStyleId, over = {}) => ExecutionFile.create({
  companyId: co._id, fileNumber: `MEF-${++seq}`,
  handoverRef: `REQ-${seq}`, handoverLineRef: `LN-${String(seq).padStart(12, "0")}`,
  currentHandoverVersionId: oid(),
  executionPhase: "COORDINATION", lifecycleStatus: "OPEN", revision: 0,
  currentExecutionProjection: {
    orderRef: `REQ-${seq}`, orderLineRef: `LN-${String(seq).padStart(12, "0")}`,
    styleRef: `SC-x`, productName: "Polo", totalQuantity: 500,
    deliveries: [{ dropRef: "DROP-1", committedDeliveryDate: new Date("2026-12-15"), quantity: 500 }],
    sampleStyleId,
  },
  ...over,
});

const ctxOf = (co) => ({ companyId: co._id });

/* ══ 1 · A LIVE HANDOVER, NOTHING STAMPED ═════════════════════════════════ */

test("a file whose handover stamped nothing still resolves the buyer's pictures", async () => {
  const w = await world();
  const file = await fileFor(w.co, w.sampleStyleId);
  /* The premise: no development reference anywhere, exactly as a live Sales
     issue leaves it. */
  expect(file.developmentReference?.developmentFileId ?? null).toBeNull();

  const out = await adoption.referenceImagesFor(ctxOf(w.co), { file: file.toObject() });

  expect(out.reason).toBe("");
  expect(out.images.map((i) => i.caption)).toEqual(["Front view", "Buyer's own sample"]);
  expect(out.images[0].referenceType).toBe("PRODUCT");
  /* Attributed, because every image is somebody's. */
  expect(out.images[0].source).toBe(`Development file DEV-${w.n}`);
  /* And the source record is named, so a reader can go to the original. */
  expect(out.source).toMatchObject({
    app: "sales", recordType: "development_request", recordRef: `SDR-${w.n}`,
  });
});

test("READING an order records nothing at all", async () => {
  /* This is the correction that matters most here. The read used to WRITE the link
     it had just resolved, so opening an order — or refreshing it — mutated business
     data, and the write was swallowed so a failure to record it was invisible. */
  const w = await world();
  const file = await fileFor(w.co, w.sampleStyleId);
  const before = await ExecutionFile.findById(file._id).lean();

  const out = await adoption.referenceImagesFor(ctxOf(w.co), { file: file.toObject() });
  expect(out.images).toHaveLength(2);

  const after = await ExecutionFile.findById(file._id).lean();
  expect(after.developmentReference?.developmentFileId ?? null).toBeNull();
  /* Nothing else moved either — not the revision, not the timestamp. */
  expect(after.revision).toBe(before.revision);
  expect(String(after.updatedAt)).toBe(String(before.updatedAt));
});

test("refreshing the panel a dozen times still records nothing", async () => {
  const w = await world();
  const file = await fileFor(w.co, w.sampleStyleId);
  const before = await ExecutionFile.findById(file._id).lean();

  for (let i = 0; i < 12; i += 1) {
    await adoption.referenceImagesFor(ctxOf(w.co), { file: file.toObject() });
  }
  const after = await ExecutionFile.findById(file._id).lean();
  expect(String(after.updatedAt)).toBe(String(before.updatedAt));
  expect(after.developmentReference?.developmentFileId ?? null).toBeNull();
});

test("the link is recorded by an explicit repair, which is idempotent", async () => {
  /* The deliberate command that replaced repair-on-read. */
  const w = await world();
  const file = await fileFor(w.co, w.sampleStyleId);

  const first = await adoption.repairDevelopmentLink(ctxOf(w.co), { fileId: String(file._id) });
  expect(first.repaired).toBe(true);
  expect(first.developmentNumber).toBe(`DEV-${w.n}`);

  const after = await ExecutionFile.findById(file._id).lean();
  expect(String(after.developmentReference.developmentFileId)).toBe(String(w.devFile._id));

  /* Run again: nothing to do, and it says so rather than rewriting. */
  const again = await adoption.repairDevelopmentLink(ctxOf(w.co), { fileId: String(file._id) });
  expect(again.repaired).toBe(false);
  expect(again.reason).toBe("ALREADY_LINKED");
});

test("a repair refuses to guess when two Development jobs match", async () => {
  const w = await world();
  await DevelopmentFile.create({
    companyId: w.co._id, developmentNumber: "DEV-SECOND", productName: "Polo",
    styleRef: `SC-${w.n}`, sampleStyleId: w.sampleStyleId, currentRequestId: w.request._id,
    journeyId: w.request.journeyId, productLineRef: `PL-${w.n}-second-line`,
  });
  const file = await fileFor(w.co, w.sampleStyleId);

  const out = await adoption.repairDevelopmentLink(ctxOf(w.co), { fileId: String(file._id) });
  expect(out.repaired).toBe(false);
  expect(out.reason).toBe("AMBIGUOUS_DEVELOPMENT_LINEAGE");
  expect(new Set(out.candidates.map((c) => c.developmentNumber)))
    .toEqual(new Set(["DEV-SECOND", `DEV-${w.n}`]));
  /* Both are named so a person can look at them and say which it was. Nothing
     here picks by recency, which is what "newest wins" used to do. */
  expect(out.candidates).toHaveLength(2);
  expect(await ExecutionFile.findById(file._id).lean()
    .then((f) => f.developmentReference?.developmentFileId ?? null)).toBeNull();
});

test("a link-write failure is reported, never swallowed", async () => {
  /* It used to end in `.catch(() => {})` on the reasoning that the next read would
     resolve it again. That reasoning died with the read-only change: a link that
     silently fails to record leaves the order with no lineage and nobody told. */
  const w = await world();
  const file = await fileFor(w.co, w.sampleStyleId);
  const spy = jest.spyOn(ExecutionFile, "updateOne")
    .mockRejectedValueOnce(new Error("write concern failed"));

  await expect(adoption.repairDevelopmentLink(ctxOf(w.co), { fileId: String(file._id) }))
    .rejects.toThrow(/write concern failed/);
  spy.mockRestore();

  expect(await ExecutionFile.findById(file._id).lean()
    .then((f) => f.developmentReference?.developmentFileId ?? null)).toBeNull();
});

/* ══ 2 · THE COMPANY BOUNDARY ═════════════════════════════════════════════ */

test("another company's development record and its images are not reachable", async () => {
  const mine = await world();
  const theirs = await world();

  /* My file, their style identity — the only handle a forged payload could use. */
  const file = await fileFor(mine.co, theirs.sampleStyleId);
  const out = await adoption.referenceImagesFor(ctxOf(mine.co), { file: file.toObject() });

  expect(out.images).toEqual([]);
  expect(out.reason).toBe("NO_DEVELOPMENT_RECORD");
  /* Nothing of theirs was recorded onto my file either. */
  const after = await ExecutionFile.findById(file._id).lean();
  expect(after.developmentReference?.developmentFileId ?? null).toBeNull();
});

test("a development file id recorded from another company reads as missing, not as theirs", async () => {
  const mine = await world({ withImages: false });
  const theirs = await world();

  const file = await fileFor(mine.co, mine.sampleStyleId, {
    developmentReference: {
      developmentFileId: theirs.devFile._id,
      developmentNumber: "DEV-THEIRS",
    },
  });
  const out = await adoption.referenceImagesFor(ctxOf(mine.co), { file: file.toObject() });
  expect(out.images).toEqual([]);
  expect(out.reason).toBe("DEVELOPMENT_RECORD_MISSING");
});

/* ══ 3 · A SIMILAR NAME IS NOT EVIDENCE ═══════════════════════════════════ */

test("a matching display style code does NOT resolve the record", async () => {
  /* `styleRef` is a code somebody can rename and two styles can share. Picking a
     development record because its code looks similar would attach one buyer's
     pictures to another buyer's order. */
  const w = await world();
  const file = await fileFor(w.co, null, {
    currentExecutionProjection: {
      orderRef: "REQ-z", orderLineRef: "LN-zzzzzzzzzzzz",
      styleRef: `SC-${w.n}`, productName: "Polo", totalQuantity: 10,
      deliveries: [{ dropRef: "DROP-1", committedDeliveryDate: new Date("2026-12-15"), quantity: 10 }],
    },
  });

  const out = await adoption.referenceImagesFor(ctxOf(w.co), { file: file.toObject() });
  expect(out.images).toEqual([]);
  /* And it says WHICH kind of nothing this is. */
  expect(out.reason).toBe("NO_STABLE_STYLE_IDENTITY");
});

/* ══ 4 · HONEST EMPTINESS, PER CAUSE ══════════════════════════════════════ */

test("each empty answer names its own cause", async () => {
  const w = await world({ withImages: false });

  /* A development record exists; its Sales request simply has no pictures yet. */
  const file = await fileFor(w.co, w.sampleStyleId);
  const none = await adoption.referenceImagesFor(ctxOf(w.co), { file: file.toObject() });
  expect(none.images).toEqual([]);
  expect(none.reason).toBe("");

  /* A development record with no Sales request behind it at all. */
  await DevelopmentFile.updateOne({ _id: w.devFile._id }, { $set: { currentRequestId: null } });
  const detached = await fileFor(w.co, w.sampleStyleId);
  const out = await adoption.referenceImagesFor(ctxOf(w.co), { file: detached.toObject() });
  expect(out.reason).toBe("NO_SALES_REQUEST");
});

test("a handover still being reviewed resolves from its projection, with no file yet", async () => {
  /* Merchandising reviews a handover BEFORE accepting it, so there is no
     Execution File to carry a link. The pictures must still be visible — that is
     part of deciding whether to accept. */
  const w = await world();
  const out = await adoption.referenceImagesFor(ctxOf(w.co), {
    projection: { sampleStyleId: w.sampleStyleId, styleRef: `SC-${w.n}` },
  });
  expect(out.images).toHaveLength(2);
  expect(out.reason).toBe("");
});

/* ══ 5 · AMBIGUOUS LINEAGE IS REFUSED, NOT RESOLVED BY RECENCY ════════════ */

// The resolver used to `find({ sampleStyleId })`, sort by `updatedAt` and take the
// first. Nothing in the database enforces one Development File per style, and two
// files for one style is a legitimate state — two journey product lines, one style.
// So "newest" was not authority: it was whichever file somebody had touched most
// recently, and picking it would attach one buyer's pictures and one buyer's BOM to
// the other buyer's order, with a result nobody would question.

describe("two Development jobs for one style", () => {
  /** A second file for the same style, on a different journey product line. */
  const second = (w, over = {}) => DevelopmentFile.create({
    companyId: w.co._id, developmentNumber: "DEV-OTHER", productName: "Polo",
    styleRef: `SC-${w.n}`, sampleStyleId: w.sampleStyleId,
    currentRequestId: w.request._id,
    journeyId: w.request.journeyId, productLineRef: `PL-${w.n}-other`,
    ...over,
  });

  test("images are refused rather than guessed, and both candidates are named", async () => {
    const w = await world();
    /* Deliberately touched last, so a recency tiebreak would have chosen it. */
    await second(w);
    const file = await fileFor(w.co, w.sampleStyleId);

    const out = await adoption.referenceImagesFor(ctxOf(w.co), { file: file.toObject() });
    expect(out.images).toEqual([]);
    expect(out.reason).toBe("AMBIGUOUS_DEVELOPMENT_LINEAGE");
    expect(out.candidates).toHaveLength(2);
    /* Each candidate carries enough to go and look at it. */
    for (const c of out.candidates) {
      expect(c.developmentFileId).toMatch(/^[0-9a-f]{24}$/);
      expect(c.developmentNumber).toBeTruthy();
    }
  });

  test("the BOM adoption source is refused too — no approved revision is imported", async () => {
    /* The same resolver, so the same refusal. Importing the wrong product line's
       approved BOM would be a worse outcome than importing nothing. */
    const w = await world();
    const other = await second(w);
    await DevelopmentBomRevision.create({
      companyId: w.co._id, developmentFileId: other._id, revisionNo: 1,
      state: "APPROVED", rows: [], journeyId: w.request.journeyId,
      productLineRef: `PL-${w.n}-other`,
    });
    const file = await fileFor(w.co, w.sampleStyleId);

    const source = await adoption.sourceFor(ctxOf(w.co), file.toObject());
    expect(source).toBeNull();
  });

  test("and the exact key resolves it when Sales' own records can produce one", async () => {
    /* `{companyId, journeyId, productLineRef}` is unique by index. Both halves are
       Sales-owned and stable — the SampleStyle's journey and the order line's own
       product-line reference — so Merchandising derives the key and looks up its
       own file with it. Nothing gives Sales a handle on a Merchandising id. */
    const w = await world();
    await second(w);

    const key = await adoption.preciseKeyFor(ctxOf(w.co), {
      projection: {
        sampleStyleId: w.sampleStyleId,
        orderRef: w.order.requestId,
        orderLineRef: w.lineRef,
      },
    });
    expect(String(key.journeyId)).toBe(String(w.request.journeyId));
    expect(key.productLineRef).toBe(`PL-${w.n}`);

    const found = await adoption.developmentFileFor(ctxOf(w.co), {
      projection: {
        sampleStyleId: w.sampleStyleId,
        orderRef: w.order.requestId,
        orderLineRef: w.lineRef,
      },
    });
    expect(found.reason).toBe("");
    expect(found.key).toBe("JOURNEY_PRODUCT_LINE");
    expect(found.devFile.developmentNumber).toBe(`DEV-${w.n}`);
  });

  test("another company's file is never a candidate, however it is matched", async () => {
    const mine = await world();
    const theirs = await world();
    /* Their file, my style identity — the only handle a forged payload could use. */
    await DevelopmentFile.updateOne(
      { _id: theirs.devFile._id }, { $set: { sampleStyleId: mine.sampleStyleId } },
    );
    const file = await fileFor(mine.co, mine.sampleStyleId);

    const out = await adoption.referenceImagesFor(ctxOf(mine.co), { file: file.toObject() });
    /* Exactly one candidate — mine — so this resolves rather than reporting
       ambiguity, and theirs was never in the running. */
    expect(out.reason).toBe("");
    expect(out.source.developmentNumber).toBe(`DEV-${mine.n}`);
  });
});

/* ══ 6 · THE REPAIR IS ONE OPERATION, OR IT IS NONE ═══════════════════════ */

// The link update and the audit row describing it used to be two writes with
// nothing holding them together. A failure on the second left the file linked with
// nothing recording who linked it or why — a change to an order's lineage that the
// trail denies ever happened, which is worse than the gap the repair was fixing.

describe("repairing a legacy link", () => {
  const {
    MerchandisingAuditEvent,
  } = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");

  const auditRows = (w, file) => MerchandisingAuditEvent.find({
    companyId: w.co._id, recordId: file._id,
    "details.change": /repaired the Development record link/,
  }).lean();

  test("a successful repair writes the link and exactly one audit row", async () => {
    const w = await world();
    const file = await fileFor(w.co, w.sampleStyleId);

    const out = await adoption.repairDevelopmentLink(ctxOf(w.co), {
      fileId: String(file._id), actor: { name: "Repairer" },
    });
    expect(out.repaired).toBe(true);

    const after = await ExecutionFile.findById(file._id).lean();
    expect(String(after.developmentReference.developmentFileId)).toBe(String(w.devFile._id));

    const rows = await auditRows(w, file);
    expect(rows).toHaveLength(1);
    expect(rows[0].details.developmentNumber).toBe(`DEV-${w.n}`);
    expect(rows[0].details.resolvedBy).toBeTruthy();
    expect(rows[0].actor.name).toBe("Repairer");
  });

  test("an audit failure leaves the file UNLINKED", async () => {
    /* The whole point of the transaction. Before it, this left a linked file with no
       record of the linking. */
    const w = await world();
    const file = await fileFor(w.co, w.sampleStyleId);
    const spy = jest.spyOn(MerchandisingAuditEvent, "create")
      .mockRejectedValueOnce(new Error("audit store unavailable"));

    await expect(adoption.repairDevelopmentLink(ctxOf(w.co), { fileId: String(file._id) }))
      .rejects.toThrow(/audit store unavailable/);
    spy.mockRestore();

    const after = await ExecutionFile.findById(file._id).lean();
    expect(after.developmentReference?.developmentFileId ?? null).toBeNull();
    expect(await auditRows(w, file)).toHaveLength(0);
  });

  test("a replay is a no-op, and writes no second audit row", async () => {
    /* A misleading audit row is the specific thing to avoid: "repaired" logged for
       a call that repaired nothing would read, later, as two separate decisions. */
    const w = await world();
    const file = await fileFor(w.co, w.sampleStyleId);
    expect((await adoption.repairDevelopmentLink(ctxOf(w.co), { fileId: String(file._id) })).repaired)
      .toBe(true);

    const again = await adoption.repairDevelopmentLink(ctxOf(w.co), { fileId: String(file._id) });
    expect(again.repaired).toBe(false);
    expect(again.reason).toBe("ALREADY_LINKED");
    expect(again.developmentNumber).toBe(`DEV-${w.n}`);

    expect(await auditRows(w, file)).toHaveLength(1);
  });

  test("ambiguity writes neither a link nor an audit row", async () => {
    const w = await world();
    await DevelopmentFile.create({
      companyId: w.co._id, developmentNumber: "DEV-RIVAL", productName: "Polo",
      styleRef: `SC-${w.n}`, sampleStyleId: w.sampleStyleId, currentRequestId: w.request._id,
      journeyId: w.request.journeyId, productLineRef: `PL-${w.n}-rival`,
    });
    const file = await fileFor(w.co, w.sampleStyleId);

    const out = await adoption.repairDevelopmentLink(ctxOf(w.co), { fileId: String(file._id) });
    expect(out.repaired).toBe(false);
    expect(out.reason).toBe("AMBIGUOUS_DEVELOPMENT_LINEAGE");

    const after = await ExecutionFile.findById(file._id).lean();
    expect(after.developmentReference?.developmentFileId ?? null).toBeNull();
    /* No trail of attempted repairs either — noise that would bury the one entry
       that matters. */
    expect(await auditRows(w, file)).toHaveLength(0);
  });

  test("two simultaneous repairs link once and record once", async () => {
    const w = await world();
    const file = await fileFor(w.co, w.sampleStyleId);

    const [a, b] = await Promise.all([
      adoption.repairDevelopmentLink(ctxOf(w.co), { fileId: String(file._id) }),
      adoption.repairDevelopmentLink(ctxOf(w.co), { fileId: String(file._id) }),
    ]);
    expect([a.repaired, b.repaired].filter(Boolean)).toHaveLength(1);
    expect(await auditRows(w, file)).toHaveLength(1);
  });
});
