// test/ppc/ppc-planning-file-contract.test.js
//
// PPC LANE B — CLOSING THE PLANNING FILE CONTRACT.
//
// What Lane A left open, each proved here rather than asserted in a comment:
//
//   · a successor is matched on the exact revision the caller read, so a stale
//     or concurrent successor changes nothing and exactly one ever wins;
//   · the frozen basis names PPC's own receipts for the exact pack and release
//     versions, and a mismatched or forged receipt makes nothing ready;
//   · a PLANNED file is permanent evidence — not patchable through the service,
//     and not writable through any query, save, replacement, upsert or delete;
//   · cancellation is a real, reasoned, approver-only, terminal command that
//     frees the line without making a new plan an accidental duplicate;
//   · planning commands and their idempotency ledger commit together, and
//     concurrent same-key requests produce one effect and one answer;
//   · business dates are `YYYY-MM-DD` from the browser to the database and
//     back, in any timezone;
//   · and a line's whole planning history is one readable chain.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const path = require("path");
const { execFileSync } = require("child_process");
const mongoose = require("mongoose");

const {
  PpcPlanningFile, PLANNING_STATE,
} = require("../../models/CMS_Models/PPC/PpcPlanningFile");
const { PpcPlanningCommand } = require("../../models/CMS_Models/PPC/PpcPlanningCommand");
const { ExecutionPack } = require("../../models/CMS_Models/Merchandising/ExecutionPack");
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const merch = require("../../services/merchandising/planningPublication.service");
const {
  server, nextKey, readyWorld, pack, release, company, orderLine, minutes, actor,
} = require("./planningFixtures");

const api = server();
const ppc = (...a) => api.call(...a);

beforeAll(async () => {
  await api.start();
  await PpcPlanningFile.syncIndexes();
  await PpcPlanningCommand.syncIndexes();
});
afterAll(async () => { await api.stop(); });
afterEach(() => { jest.restoreAllMocks(); });

const raw = () => mongoose.connection.collection("ppc_planning_files");
const rawDoc = (id) => raw().findOne({ _id: new mongoose.Types.ObjectId(String(id)) });

const createPlan = (w, { who = w.planner, body = {}, key = nextKey() } = {}) => ppc(
  `/order-book/${w.lineRef}/planning-file`,
  { method: "POST", token: who.token, company: w.co._id, body, key },
);
const command = (w, id, verb, body, { who = w.approver, key = nextKey() } = {}) => ppc(
  `/planning-files/${id}/${verb}`,
  { method: "POST", token: who.token, company: w.co._id, body, key },
);
const patch = (w, id, body, who = w.planner) => ppc(`/planning-files/${id}`,
  { method: "PATCH", token: who.token, company: w.co._id, body });

/** Create a file and walk it to PLANNED. Returns the planned projection. */
async function planned(w, fields = {}) {
  const c = await createPlan(w, { body: fields });
  expect(c.status).toBe(201);
  const id = c.body.planningFile.planningFileId;
  const s = await command(w, id, "planning-started", { expectedRevision: 1 }, { who: w.planner });
  expect(s.status).toBe(200);
  const p = await command(w, id, "planned", { expectedRevision: s.body.planningFile.revision });
  expect(p.status).toBe(200);
  return p.body.planningFile;
}

/** Supersede the current pack with an accepted v2, so a successor has something new. */
async function movePack(w) {
  await ExecutionPack.updateOne({ _id: w.pack._id }, { $set: { state: "SUPERSEDED" } });
  return pack(w.co, w.file, { versionNo: 2 });
}

const REASON = "The execution pack moved to version 2 and PPC accepted it.";

/* ══ 1–3. SUCCESSOR CONCURRENCY ═══════════════════════════════════════════ */

describe("a successor is matched on the exact revision that was read", () => {
  test("expectedRevision is required, and is part of the request", async () => {
    const w = await readyWorld("SuccNoRev");
    const c = await createPlan(w);
    const res = await command(w, c.body.planningFile.planningFileId, "successor", { reason: REASON });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("PPC_EXPECTED_REVISION_REQUIRED");
    expect(await PpcPlanningFile.countDocuments({ companyId: w.co._id })).toBe(1);
  });

  test("a stale successor revision changes nothing at all", async () => {
    const w = await readyWorld("SuccStale");
    const c = await createPlan(w);
    const id = c.body.planningFile.planningFileId;
    const edited = await patch(w, id, { expectedRevision: 1, priority: "HIGH" });
    expect(edited.body.planningFile.revision).toBe(2);
    await movePack(w);
    const before = await rawDoc(id);

    const key = nextKey();
    const res = await command(w, id, "successor", { expectedRevision: 1, reason: REASON }, { key });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PPC_PLANNING_REVISION_STALE");
    expect(res.body.error.details.currentRevision).toBe(2);

    /* Nothing moved: the predecessor is byte-identical, no successor, no ledger row. */
    expect(await rawDoc(id)).toEqual(before);
    expect(await PpcPlanningFile.countDocuments({ companyId: w.co._id })).toBe(1);
    expect(await PpcPlanningCommand.countDocuments({ idempotencyKey: key })).toBe(0);
  });

  test("two concurrent successors produce exactly one successor", async () => {
    const w = await readyWorld("SuccRace");
    const c = await createPlan(w);
    const id = c.body.planningFile.planningFileId;
    await movePack(w);

    const results = await Promise.all([1, 2, 3].map(() => command(w, id, "successor",
      { expectedRevision: 1, reason: REASON })));
    const won = results.filter((r) => r.status === 201);
    const lost = results.filter((r) => r.status !== 201);
    expect(won).toHaveLength(1);
    /* A loser either saw the revision move or found the file already
       superseded — both are refusals that wrote nothing. */
    for (const r of lost) {
      expect([400, 409]).toContain(r.status);
      expect(["PPC_PLANNING_REVISION_STALE", "PPC_PLANNING_FILE_CLOSED"]).toContain(r.body.error.code);
    }

    const all = await PpcPlanningFile.find({ companyId: w.co._id }).lean();
    expect(all).toHaveLength(2);
    const old = all.find((f) => String(f._id) === id);
    const next = all.find((f) => String(f._id) !== id);
    expect(old.state).toBe("SUPERSEDED");
    expect(old.revision).toBe(2);
    expect(String(old.supersededByFileId)).toBe(String(next._id));
    expect(old.history.filter((e) => e.type === "SUPERSEDED_BY_SUCCESSOR")).toHaveLength(1);
    expect(next.generation).toBe(2);
  });

  test("the same successor key sent twice at once is one successor and one answer", async () => {
    const w = await readyWorld("SuccSameKey");
    const c = await createPlan(w);
    const id = c.body.planningFile.planningFileId;
    await movePack(w);
    const key = nextKey();
    const [a, b] = await Promise.all([
      command(w, id, "successor", { expectedRevision: 1, reason: REASON }, { key }),
      command(w, id, "successor", { expectedRevision: 1, reason: REASON }, { key }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 201]);
    expect({ ...a.body, replayed: null }).toEqual({ ...b.body, replayed: null });
    expect([a.body.replayed, b.body.replayed].sort()).toEqual([false, true]);
    expect(await PpcPlanningFile.countDocuments({ companyId: w.co._id })).toBe(2);
  });

  test("an edit landing just before the retirement is neither overwritten nor rolled back", async () => {
    const w = await readyWorld("SuccInterleave");
    const c = await createPlan(w);
    const id = c.body.planningFile.planningFileId;
    await movePack(w);

    /* The successor has read the predecessor at revision 1 inside its
       transaction; the moment it asks for the current order line, a planner's
       edit lands and commits. */
    const original = merch.publishConfirmedOrderLine;
    let interleaved = null;
    jest.spyOn(merch, "publishConfirmedOrderLine").mockImplementation(async (...args) => {
      if (!interleaved) {
        interleaved = await patch(w, id,
          { expectedRevision: 1, priority: "CRITICAL", planningNote: "Edited mid-succession" });
      }
      return original(...args);
    });

    const res = await command(w, id, "successor", { expectedRevision: 1, reason: REASON });
    expect(interleaved.status).toBe(200);
    expect(interleaved.body.planningFile.revision).toBe(2);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PPC_PLANNING_REVISION_STALE");

    const now = await PpcPlanningFile.findById(id).lean();
    expect(now.revision).toBe(2);                         // not 1, not re-stamped
    expect(now.state).toBe("OPEN");                       // not superseded
    expect(now.planning.priority).toBe("CRITICAL");       // the edit survived
    expect(now.planning.planningNote).toBe("Edited mid-succession");
    expect(now.history.map((e) => e.revision)).toEqual([1, 2]);
    expect(await PpcPlanningFile.countDocuments({ companyId: w.co._id })).toBe(1);
  });

  test("the model refuses a revision that does not move forward by exactly one", async () => {
    const w = await readyWorld("RevBack");
    const c = await createPlan(w);
    const id = new mongoose.Types.ObjectId(c.body.planningFile.planningFileId);
    const filter = { _id: id, companyId: w.co._id, revision: 1, state: "OPEN", plannedAt: null };
    const ev = (revision) => ({ history: { $each: [{
      eventId: "x", type: "PLANNING_FIELDS_UPDATED", at: new Date(),
      fromState: "OPEN", toState: "OPEN", revision,
    }], $slice: -200 } });
    for (const revision of [1, 0, 3]) {
      await expect(PpcPlanningFile.updateOne(filter,
        { $set: { "planning.priority": "LOW", revision }, $push: ev(revision) }))
        .rejects.toMatchObject({ code: "PPC_PLANNING_FILE_IMMUTABLE" });
    }
    expect((await rawDoc(id)).revision).toBe(1);
  });
});

/* ══ 4–7. EXACT PPC RECEIPTS ══════════════════════════════════════════════ */

describe("the frozen basis names PPC's own receipts for the exact versions", () => {
  test("the exact pack receipt — for the current version, not an older one — is frozen", async () => {
    const w = await readyWorld("PackReceipt");
    /* v1 was accepted; v2 is current and accepted too. Only v2's counts. */
    const v2 = await movePack(w);
    const c = await createPlan(w);
    expect(c.status).toBe(201);
    const doc = await rawDoc(c.body.planningFile.planningFileId);
    expect(String(doc.sourceBasis.packReceiptId)).toBe(String(v2.receipt._id));
    expect(String(doc.sourceBasis.packReceiptId)).not.toBe(String(w.packReceipt._id));
    expect(doc.sourceBasis.packReceiptVersionNo).toBe(2);
    expect(doc.sourceBasis.executionPackVersionNo).toBe(2);
    expect(String(doc.sourceBasis.executionPackId)).toBe(String(v2.pack._id));
  });

  test("the exact IE receipt is frozen, and a successor freezes the new ones", async () => {
    const w = await readyWorld("IeReceipt");
    const c = await createPlan(w);
    const id = c.body.planningFile.planningFileId;
    const first = await rawDoc(id);
    expect(String(first.sourceBasis.ieReceiptId)).toBe(String(w.ieReceipt._id));
    expect(first.sourceBasis.ieReceiptVersionNo).toBe(1);

    await mongoose.connection.collection("ie_releases").updateOne(
      { _id: w.rel._id }, { $set: { state: "SUPERSEDED", supersededByVersionNo: 2 } });
    const v2 = await release(w.co, w.styleId, { versionNo: 2, releaseRef: w.rel.releaseRef });
    const v2pack = await movePack(w);
    /* And Merchandising meets again on the new engineering. A successor plan
       freezes release v2, so the minutes it is made against have to be the
       ones that reviewed v2 — the first meeting reviewed v1 and cannot speak
       for what replaced it. Re-issuing them is the remedy, not a workaround:
       PPC refuses the successor until it exists. */
    const stale = await command(w, id, "successor", { expectedRevision: 1, reason: REASON });
    expect(stale.status).toBe(409);
    await mongoose.connection.collection("merchandising_pre_production_meetings").updateOne(
      { companyId: w.co._id, fileId: w.file._id, state: "ISSUED" },
      { $set: { state: "SUPERSEDED", supersededByVersionNo: 2, supersededAt: new Date() } });
    await minutes(w.co, w.file, { versionNo: 2 });

    const succ = await command(w, id, "successor", { expectedRevision: 1, reason: REASON });
    expect(succ.status).toBe(201);
    const next = await rawDoc(succ.body.planningFile.planningFileId);
    expect(String(next.sourceBasis.ieReceiptId)).toBe(String(v2.receipt._id));
    expect(next.sourceBasis.ieReceiptVersionNo).toBe(2);
    expect(String(next.sourceBasis.packReceiptId)).toBe(String(v2pack.receipt._id));
    /* The predecessor still names the receipts IT was authorised by. */
    expect(await rawDoc(id)).toMatchObject({
      sourceBasis: expect.objectContaining({ ieReceiptId: w.ieReceipt._id, packReceiptId: w.packReceipt._id }),
    });
  });

  test("a receipt that names this pack but another version makes the line not ready", async () => {
    const w = await readyWorld("PackMismatch", { packAccepted: false });
    await mongoose.connection.collection("ppc_downstream_handover_receipts").insertOne({
      companyId: w.co._id, packId: w.pack._id, packVersionNo: 7, fileId: w.file._id,
      state: "ACCEPTED", decidedAt: new Date(), revision: 0,
    });
    const line = await ppc(`/order-book/${w.lineRef}`, { token: w.viewer.token, company: w.co._id });
    expect(line.body.row.inputs.executionPack.state).toBe("PENDING");
    expect(line.body.row.inputs.executionPack.reason).toBe("RECEIPT_VERSION_MISMATCH");
    expect(line.body.row.readyToPlan).toBe(false);

    const res = await createPlan(w);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PPC_PLANNING_NOT_READY");
    expect(await PpcPlanningFile.countDocuments({})).toBe(0);
  });

  test("an IE receipt whose recorded version disagrees with the release makes the line not ready", async () => {
    const w = await readyWorld("IeMismatch", { releaseAccepted: false });
    await mongoose.connection.collection("ppc_ie_release_receipts").insertOne({
      companyId: w.co._id, releaseRef: w.rel.releaseRef, releaseVersionNo: 9,
      ieReleaseId: w.rel._id, ieStyleFileId: w.rel.ieStyleFileId, state: "ACCEPTED",
      decidedAt: new Date(), decidedBy: { id: new mongoose.Types.ObjectId() },
      idempotencyKey: "k-mismatch", requestHash: "h-mismatch",
    });
    const res = await createPlan(w);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PPC_PLANNING_NOT_READY");
    expect(res.body.error.details.unsatisfied).toContain("ieRelease");
    expect(await PpcPlanningFile.countDocuments({})).toBe(0);
  });

  test("a receipt that stops being an acceptance between read and write authorises nothing", async () => {
    const w = await readyWorld("ReceiptMoved");
    const orderBook = require("../../services/ppc/orderBook.service");
    const gather = orderBook.gather;
    jest.spyOn(orderBook, "gather").mockImplementation(async (...args) => {
      const out = await gather(...args);
      /* PPC's pack receipt is superseded the instant after it was read. */
      await mongoose.connection.collection("ppc_downstream_handover_receipts")
        .updateOne({ _id: w.packReceipt._id }, { $set: { state: "SUPERSEDED" } });
      return out;
    });
    const res = await createPlan(w);
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("RECEIPT_IDENTITY_UNRESOLVED");
    expect(await PpcPlanningFile.countDocuments({})).toBe(0);
  });

  test("forged receipt identities are refused by name on every writer", async () => {
    const w = await readyWorld("ForgedReceipt");
    const forged = { packReceiptId: String(new mongoose.Types.ObjectId()),
      ieReceiptId: String(new mongoose.Types.ObjectId()) };

    const onCreate = await createPlan(w, { body: forged });
    expect(onCreate.status).toBe(400);
    expect(onCreate.body.error.code).toBe("PPC_PLANNING_FIELD_REFUSED");
    expect(onCreate.body.error.details.fields.sort()).toEqual(["ieReceiptId", "packReceiptId"]);

    const c = await createPlan(w);
    const id = c.body.planningFile.planningFileId;
    const onPatch = await patch(w, id, { expectedRevision: 1, ...forged });
    expect(onPatch.body.error.code).toBe("PPC_PLANNING_FIELD_REFUSED");

    await movePack(w);
    const onSuccessor = await command(w, id, "successor",
      { expectedRevision: 1, reason: REASON, packReceiptId: forged.packReceiptId });
    expect(onSuccessor.body.error.code).toBe("PPC_PLANNING_FIELD_REFUSED");

    /* What was frozen is PPC's own receipt, not anything sent. */
    const doc = await rawDoc(id);
    expect(String(doc.sourceBasis.packReceiptId)).toBe(String(w.packReceipt._id));
    expect(doc.revision).toBe(1);
  });

  test("receipt identities are provenance: frozen on the record, never on the wire", async () => {
    const w = await readyWorld("NoReceiptIds");
    const c = await createPlan(w);
    const id = c.body.planningFile.planningFileId;
    const receiptIds = [String(w.packReceipt._id), String(w.ieReceipt._id)];
    const answers = [
      c,
      await ppc(`/planning-files/${id}`, { token: w.viewer.token, company: w.co._id }),
      await ppc(`/planning-files/${id}/source-health`, { token: w.viewer.token, company: w.co._id }),
      await ppc(`/order-book/${w.lineRef}`, { token: w.viewer.token, company: w.co._id }),
      await ppc("/order-book?view=all", { token: w.viewer.token, company: w.co._id }),
      await ppc(`/order-book/${w.lineRef}/planning-files`, { token: w.viewer.token, company: w.co._id }),
    ];
    for (const a of answers) {
      expect(a.status).toBeLessThan(300);
      const text = JSON.stringify(a.body);
      for (const rid of receiptIds) expect(text).not.toContain(rid);
      expect(text).not.toMatch(/"(packReceiptId|ieReceiptId)"/);
    }
    /* What a reader DOES get: that each was frozen, and at which version. */
    expect(c.body.planningFile.sourceBasis).toMatchObject({
      packReceiptFrozen: true, packReceiptVersionNo: 1, ieReceiptFrozen: true, ieReceiptVersionNo: 1,
    });
  });
});

/* ══ 8–10. A PLANNED FILE IS PERMANENT ════════════════════════════════════ */

describe("a PLANNED file's planning content is permanent evidence", () => {
  test("its fields cannot be patched, and the refusal names the way forward", async () => {
    const w = await readyWorld("PlannedPatch");
    const file = await planned(w, { priority: "HIGH", requestedProductionStart: "2026-10-05" });
    const before = await rawDoc(file.planningFileId);
    expect(file.planningFrozen).toBe(true);

    for (const body of [{ priority: "LOW" }, { planningNote: "late change" },
      { requestedProductionStart: "2026-10-09" }, { assumptions: [] }, { owner: null }]) {
      const res = await patch(w, file.planningFileId, { expectedRevision: file.revision, ...body });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("PPC_PLANNING_FILE_FROZEN");
      expect(res.body.error.message).toMatch(/successor/i);
    }
    expect(await rawDoc(file.planningFileId)).toEqual(before);
  });

  test("a hold on a planned file leaves the plan as approved, and lifting it returns to PLANNED", async () => {
    const w = await readyWorld("PlannedHold");
    const file = await planned(w, { priority: "HIGH", planningNote: "Approved plan",
      requestedProductionStart: "2026-10-05", requestedProductionEnd: "2026-10-20" });
    const before = await rawDoc(file.planningFileId);

    const held = await command(w, file.planningFileId, "hold",
      { expectedRevision: file.revision, reason: "AWAITING_MATERIAL", note: "Fabric late." });
    expect(held.status).toBe(200);
    expect(held.body.planningFile.state).toBe("ON_HOLD");
    expect(held.body.planningFile.stateBeforeHold).toBe("PLANNED");

    /* Held from PLANNED is still frozen. */
    const edit = await patch(w, file.planningFileId,
      { expectedRevision: held.body.planningFile.revision, priority: "LOW" });
    expect(edit.body.error.code).toBe("PPC_PLANNING_FILE_FROZEN");

    const lifted = await command(w, file.planningFileId, "hold/remove",
      { expectedRevision: held.body.planningFile.revision, note: "Fabric lot confirmed by the mill today." });
    expect(lifted.status).toBe(200);
    expect(lifted.body.planningFile.state).toBe("PLANNED");

    const after = await rawDoc(file.planningFileId);
    expect(after.planning).toEqual(before.planning);
    expect(after.sourceBasis).toEqual(before.sourceBasis);
    expect(after.plannedAt).toEqual(before.plannedAt);
    expect(after.plannedBy).toEqual(before.plannedBy);
    expect(after.createdAt).toEqual(before.createdAt);
    expect(after.history.slice(0, before.history.length)).toEqual(before.history);
    expect(after.revision).toBe(before.revision + 2);
  });

  test("changing an approved plan takes an explicit successor, and the planned version stays readable", async () => {
    const w = await readyWorld("PlannedSuccessor");
    const file = await planned(w, { priority: "HIGH" });
    await movePack(w);
    const succ = await command(w, file.planningFileId, "successor",
      { expectedRevision: file.revision, reason: "Buyer moved the delivery; the plan has to change." });
    expect(succ.status).toBe(201);
    const next = succ.body.planningFile;
    expect(next.state).toBe("OPEN");
    expect(next.planningFrozen).toBe(false);
    const edit = await patch(w, next.planningFileId, { expectedRevision: 1, priority: "LOW" });
    expect(edit.status).toBe(200);

    const old = await ppc(`/planning-files/${file.planningFileId}`, { token: w.viewer.token, company: w.co._id });
    expect(old.status).toBe(200);
    expect(old.body.planningFile.state).toBe("SUPERSEDED");
    expect(old.body.planningFile.planning.priority).toBe("HIGH");
    expect(old.body.planningFile.plannedAt).toBe(file.plannedAt);
  });

  test("every query, save, replacement, upsert and delete path refuses a planned record", async () => {
    const w = await readyWorld("AllPaths");
    const file = await planned(w, { priority: "HIGH" });
    const id = new mongoose.Types.ObjectId(file.planningFileId);
    const before = await rawDoc(id);
    const M = PpcPlanningFile;
    const rev = file.revision;
    const exact = { _id: id, companyId: w.co._id, revision: rev, state: "PLANNED" };
    const oneEvent = (fromState, toState) => ({ history: { $each: [{
      eventId: "forged", type: "PLANNING_FIELDS_UPDATED", at: new Date(),
      fromState, toState, revision: rev + 1,
    }], $slice: -200 } });

    const attempts = {
      /* An edit dressed exactly like a real one — refused because it is PLANNED. */
      "updateOne: planning field on PLANNED": () => M.updateOne(
        { ...exact, plannedAt: null },
        { $set: { "planning.priority": "LOW", revision: rev + 1 }, $push: oneEvent("PLANNED", "PLANNED") }),
      "updateOne: bare": () => M.updateOne({ _id: id }, { $set: { "planning.priority": "LOW" } }),
      "updateOne: source basis": () => M.updateOne(exact,
        { $set: { "sourceBasis.confirmedQuantity": 1, revision: rev + 1 }, $push: oneEvent("PLANNED", "PLANNED") }),
      "updateOne: identity": () => M.updateOne(exact, { $set: { orderLineRef: "OTHER", revision: rev + 1 } }),
      "updateOne: authorship": () => M.updateOne(exact, { $set: { createdBy: { name: "x" }, revision: rev + 1 } }),
      "updateOne: timestamps": () => M.updateOne(exact, { $set: { createdAt: new Date(0), revision: rev + 1 } }),
      "updateOne: plannedAt rewritten": () => M.updateOne(exact, { $set: { plannedAt: new Date(0), revision: rev + 1 } }),
      "updateOne: history rewritten": () => M.updateOne(exact, { $set: { history: [], revision: rev + 1 } }),
      "updateOne: two events": () => M.updateOne(exact, { $set: { state: "ON_HOLD", revision: rev + 1 },
        $push: { history: { $each: [{ revision: rev + 1 }, { revision: rev + 1 }] } } }),
      "updateOne: future field": () => M.updateOne(exact,
        { $set: { state: "ON_HOLD", futureField: 1, revision: rev + 1 }, $push: oneEvent("PLANNED", "ON_HOLD") }),
      "updateOne: $inc": () => M.updateOne(exact, { $inc: { revision: 1 } }),
      "updateOne: $rename": () => M.updateOne(exact, { $rename: { planning: "old" } }),
      "updateOne: $pull history": () => M.updateOne(exact, { $pull: { history: {} } }),
      "updateOne: back to PLANNING": () => M.updateOne(exact,
        { $set: { state: "PLANNING", revision: rev + 1 }, $push: oneEvent("PLANNED", "PLANNING") }),
      "updateOne: upsert": () => M.updateOne(exact,
        { $set: { state: "ON_HOLD", revision: rev + 1 }, $push: oneEvent("PLANNED", "ON_HOLD") }, { upsert: true }),
      "updateOne: no operators": () => M.updateOne(exact, { priority: "LOW" }),
      "updateMany": () => M.updateMany({ companyId: w.co._id }, { $set: { "planning.priority": "LOW" } }),
      "findOneAndUpdate": () => M.findOneAndUpdate({ _id: id }, { $set: { "planning.planningNote": "x" } }),
      "findByIdAndUpdate": () => M.findByIdAndUpdate(id, { $set: { "planning.planningNote": "x" } }),
      "replaceOne": () => M.replaceOne({ _id: id }, { ...before, planning: {} }),
      "findOneAndReplace": () => M.findOneAndReplace({ _id: id }, { ...before, planning: {} }),
      "deleteOne (query)": () => M.deleteOne({ _id: id }),
      "deleteMany": () => M.deleteMany({ companyId: w.co._id }),
      "findOneAndDelete": () => M.findOneAndDelete({ _id: id }),
      "findByIdAndDelete": () => M.findByIdAndDelete(id),
      "document deleteOne": async () => (await M.findById(id)).deleteOne(),
      "document updateOne": async () => (await M.findById(id)).updateOne({ $set: { "planning.priority": "LOW" } }),
      "document save": async () => {
        const doc = await M.findById(id);
        doc.planning.priority = "LOW";
        return doc.save();
      },
      "document save: future path": async () => {
        const doc = await M.findById(id);
        doc.set("stateBeforeHold", "OPEN");
        return doc.save();
      },
      "bulkWrite": () => M.bulkWrite([{ updateOne: { filter: { _id: id }, update: { $set: { state: "OPEN" } } } }]),
      "insertMany": () => M.insertMany([{ ...before, _id: new mongoose.Types.ObjectId(), planningFileRef: "X" }]),
    };

    for (const [name, attempt] of Object.entries(attempts)) {
      let refused = null;
      try { await attempt(); } catch (err) { refused = err; }
      if (!refused) throw new Error(`"${name}" was not refused`);
    }
    expect(await rawDoc(id)).toEqual(before);
  });

  test("the narrow lifecycle writes still go through — and only through their own shape", async () => {
    const w = await readyWorld("NarrowWrites");
    const file = await planned(w);
    const held = await command(w, file.planningFileId, "hold",
      { expectedRevision: file.revision, reason: "AWAITING_BUYER" });
    expect(held.status).toBe(200);
    /* A lift that does not return to exactly where the hold was placed from is refused by the model. */
    const id = new mongoose.Types.ObjectId(file.planningFileId);
    const r = held.body.planningFile.revision;
    await expect(PpcPlanningFile.updateOne(
      { _id: id, companyId: w.co._id, revision: r, state: "ON_HOLD", stateBeforeHold: "PLANNED" },
      { $set: { state: "OPEN", revision: r + 1 },
        $push: { history: { $each: [{ fromState: "ON_HOLD", toState: "OPEN", revision: r + 1 }] } } },
    )).rejects.toMatchObject({ code: "PPC_PLANNING_FILE_IMMUTABLE" });
    const lifted = await command(w, file.planningFileId, "hold/remove", { expectedRevision: r, note: "Fabric lot confirmed by the mill today." });
    expect(lifted.body.planningFile.state).toBe("PLANNED");
  });
});

/* ══ 11–12. CANCELLATION ══════════════════════════════════════════════════ */

describe("cancellation is a real command: approver-only, reasoned, terminal", () => {
  test("it is reachable, refuses without a reason, and records one bounded event", async () => {
    const w = await readyWorld("Cancel");
    const c = await createPlan(w);
    const id = c.body.planningFile.planningFileId;

    const asPlanner = await command(w, id, "cancel",
      { expectedRevision: 1, reason: "OPENED_IN_ERROR" }, { who: w.planner });
    expect(asPlanner.status).toBe(403);

    for (const body of [{}, { reason: "" }, { reason: "BECAUSE" }, { reason: "OTHER" },
      { reason: "OTHER", note: "too short" }]) {
      const res = await command(w, id, "cancel", { expectedRevision: 1, ...body });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("PPC_CANCELLATION_REASON_INVALID");
    }
    const noKey = await ppc(`/planning-files/${id}/cancel`, { method: "POST", token: w.approver.token,
      company: w.co._id, body: { expectedRevision: 1, reason: "OPENED_IN_ERROR" } });
    expect(noKey.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const staleRev = await command(w, id, "cancel", { expectedRevision: 5, reason: "OPENED_IN_ERROR" });
    expect(staleRev.body.error.code).toBe("PPC_PLANNING_REVISION_STALE");
    expect((await rawDoc(id)).state).toBe("OPEN");

    const ok = await command(w, id, "cancel", { expectedRevision: 1, reason: "OTHER",
      note: "Buyer merged this line into another order line." });
    expect(ok.status).toBe(200);
    const f = ok.body.planningFile;
    expect(f.state).toBe("CANCELLED");
    expect(f.ownsLine).toBe(false);
    expect(f.cancellationReason).toBe("OTHER");
    expect(f.cancellationNote).toBe("Buyer merged this line into another order line.");
    expect(f.cancelledBy.name).toBe(w.approver.name);
    expect(f.cancelledAt).toBeTruthy();

    const doc = await rawDoc(id);
    const cancels = doc.history.filter((e) => e.type === "PLANNING_FILE_CANCELLED");
    expect(cancels).toHaveLength(1);
    expect(cancels[0]).toMatchObject({ fromState: "OPEN", toState: "CANCELLED", reason: "OTHER", revision: 2 });
    /* No successor, and the history before it is intact. */
    expect(await PpcPlanningFile.countDocuments({ companyId: w.co._id })).toBe(1);
    expect(doc.history[0].type).toBe("PLANNING_FILE_CREATED");
  });

  test("a cancelled file is immutable, and cancelling writes nothing upstream", async () => {
    const w = await readyWorld("CancelFinal");
    const file = await planned(w);
    const upstream = async () => Promise.all(["merchandisingexecutionfiles", "merchandising_execution_packs",
      "ie_releases", "ppc_downstream_handover_receipts", "ppc_ie_release_receipts"]
      .map((n) => mongoose.connection.collection(n).find({}).toArray()));
    const beforeUpstream = await upstream();

    const ok = await command(w, file.planningFileId, "cancel",
      { expectedRevision: file.revision, reason: "ORDER_CANCELLED_UPSTREAM" });
    expect(ok.status).toBe(200);
    const after = await rawDoc(file.planningFileId);
    const r = ok.body.planningFile.revision;

    for (const [verb, body] of [
      ["cancel", { reason: "OPENED_IN_ERROR" }], ["hold", { reason: "AWAITING_BUYER" }],
      ["hold/remove", { note: "Fabric lot confirmed by the mill today." }], ["planned", {}], ["planning-started", {}],
    ]) {
      const res = await command(w, file.planningFileId, verb, { expectedRevision: r, ...body });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("PPC_PLANNING_STATE_INVALID");
    }
    const succ = await command(w, file.planningFileId, "successor", { expectedRevision: r, reason: REASON });
    expect(succ.body.error.code).toBe("PPC_PLANNING_FILE_CLOSED");
    const edit = await patch(w, file.planningFileId, { expectedRevision: r, priority: "LOW" });
    expect(edit.body.error.code).toBe("PPC_PLANNING_FILE_CLOSED");
    await expect(PpcPlanningFile.updateOne(
      { _id: after._id, companyId: w.co._id, revision: r, state: "CANCELLED" },
      { $set: { state: "OPEN", revision: r + 1 },
        $push: { history: { $each: [{ fromState: "CANCELLED", toState: "OPEN", revision: r + 1 }] } } },
    )).rejects.toMatchObject({ code: "PPC_PLANNING_FILE_IMMUTABLE" });

    expect(await rawDoc(file.planningFileId)).toEqual(after);
    expect(await upstream()).toEqual(beforeUpstream);
  });

  test("a cancelled file frees the line, and a new plan must name the cancellation", async () => {
    const w = await readyWorld("CancelFree");
    const firstKey = nextKey();
    const first = await createPlan(w, { key: firstKey });
    const id = first.body.planningFile.planningFileId;
    const ref = first.body.planningFile.planningFileRef;
    await command(w, id, "cancel", { expectedRevision: 1, reason: "DUPLICATE_PLANNING_FILE" });

    const row = await ppc(`/order-book/${w.lineRef}`, { token: w.viewer.token, company: w.co._id });
    expect(row.body.row.planningFileId).toBeNull();
    expect(row.body.row.view).toBe("ready-to-plan");

    /* A retry of the ORIGINAL create replays its original answer — it does not
       silently open a second plan. */
    const replay = await createPlan(w, { key: firstKey });
    expect(replay.status).toBe(201);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.planningFile).toEqual(first.body.planningFile);

    /* A fresh POST that does not name the cancellation is refused. */
    const blind = await createPlan(w);
    expect(blind.status).toBe(409);
    expect(blind.body.error.code).toBe("PPC_PLANNING_PRIOR_CANCELLED");
    expect(blind.body.error.details.cancelledFileRef).toBe(ref);
    const wrong = await createPlan(w, { body: { afterCancelledFileRef: "PPCPF-NOPE" } });
    expect(wrong.body.error.code).toBe("PPC_PLANNING_PRIOR_CANCELLED");
    expect(await PpcPlanningFile.countDocuments({ companyId: w.co._id })).toBe(1);

    /* Named explicitly — and raced — it opens exactly one new generation. */
    const [a, b] = await Promise.all([
      createPlan(w, { body: { afterCancelledFileRef: ref } }),
      createPlan(w, { body: { afterCancelledFileRef: ref } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.planningFile.planningFileId).toBe(b.body.planningFile.planningFileId);
    const fresh = [a, b].find((r) => r.status === 201).body.planningFile;
    expect(fresh.generation).toBe(2);
    expect(fresh.followsCancelledFileRef).toBe(ref);
    expect(fresh.planningFileRef).not.toBe(ref);
    const doc = await rawDoc(fresh.planningFileId);
    expect(doc.history[0].reason).toContain(ref);
    expect(await PpcPlanningFile.countDocuments({ companyId: w.co._id })).toBe(2);
    expect(await PpcPlanningFile.countDocuments({ companyId: w.co._id,
      state: { $in: ["OPEN", "PLANNING", "PLANNED", "ON_HOLD"] } })).toBe(1);
  });
});

/* ══ 13–15. IDEMPOTENCY UNDER CONCURRENCY ═════════════════════════════════ */

describe("planning commands and their ledger are one transaction", () => {
  test("two concurrent requests with one key make one change and give one answer", async () => {
    const w = await readyWorld("SameKey");
    const c = await createPlan(w);
    const id = c.body.planningFile.planningFileId;
    const key = nextKey();
    const [a, b] = await Promise.all([1, 2].map(() => command(w, id, "planning-started",
      { expectedRevision: 1 }, { who: w.planner, key })));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect({ ...a.body, replayed: null }).toEqual({ ...b.body, replayed: null });
    expect([a.body.replayed, b.body.replayed].sort()).toEqual([false, true]);

    const doc = await rawDoc(id);
    expect(doc.revision).toBe(2);
    expect(doc.history.filter((e) => e.type === "PLANNING_STARTED")).toHaveLength(1);
    expect(await PpcPlanningCommand.countDocuments({ idempotencyKey: key })).toBe(1);
  });

  test("two concurrent creates with one key create one file and answer identically", async () => {
    const w = await readyWorld("SameKeyCreate");
    const key = nextKey();
    const [a, b] = await Promise.all([createPlan(w, { key }), createPlan(w, { key })]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect({ ...a.body, replayed: null }).toEqual({ ...b.body, replayed: null });
    expect(a.body.created).toBe(true);
    expect(b.body.created).toBe(true);
    expect(await PpcPlanningFile.countDocuments({ companyId: w.co._id })).toBe(1);
    const doc = (await raw().find({ companyId: w.co._id }).toArray())[0];
    expect(doc.history).toHaveLength(1);
  });

  test("a retry after a lost answer returns the stored answer, even after the record moved on", async () => {
    const w = await readyWorld("LostAnswer");
    const c = await createPlan(w);
    const id = c.body.planningFile.planningFileId;
    const key = nextKey();
    const first = await command(w, id, "planning-started", { expectedRevision: 1 }, { who: w.planner, key });
    await patch(w, id, { expectedRevision: 2, priority: "LOW" });

    const retry = await command(w, id, "planning-started", { expectedRevision: 1 }, { who: w.planner, key });
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect({ ...retry.body, replayed: false }).toEqual(first.body);
    expect(retry.body.planningFile.revision).toBe(2);        // the answer given, not the record now
    expect((await rawDoc(id)).revision).toBe(3);
  });

  test("if the ledger cannot be written, the command did not happen either", async () => {
    const w = await readyWorld("LedgerFails");
    const c = await createPlan(w);
    const id = c.body.planningFile.planningFileId;
    const before = await rawDoc(id);
    const key = nextKey();

    const realCreate = PpcPlanningCommand.create.bind(PpcPlanningCommand);
    jest.spyOn(PpcPlanningCommand, "create").mockImplementationOnce(async () => {
      throw new Error("ledger unavailable");
    });
    const failed = await command(w, id, "planning-started", { expectedRevision: 1 }, { who: w.planner, key });
    expect(failed.status).toBe(500);
    expect(await rawDoc(id)).toEqual(before);                // no effect without its ledger row
    expect(await PpcPlanningCommand.countDocuments({ idempotencyKey: key })).toBe(0);

    PpcPlanningCommand.create.mockImplementation(realCreate);
    const retried = await command(w, id, "planning-started", { expectedRevision: 1 }, { who: w.planner, key });
    expect(retried.status).toBe(200);
    expect(retried.body.replayed).toBe(false);
    const held = await PpcPlanningCommand.findOne({ idempotencyKey: key }).lean();
    /* The row holds exactly the public envelope that was answered. */
    expect(held.envelope).toEqual({ planningFile: retried.body.planningFile });
    expect((await rawDoc(id)).history.filter((e) => e.type === "PLANNING_STARTED")).toHaveLength(1);
  });

  test("a key reused with a different revision, or for a different command, is refused", async () => {
    const w = await readyWorld("ReusedKey");
    const c = await createPlan(w);
    const id = c.body.planningFile.planningFileId;
    const key = nextKey();
    const first = await command(w, id, "hold", { expectedRevision: 1, reason: "AWAITING_BUYER" }, { key });
    expect(first.status).toBe(200);

    const otherRevision = await command(w, id, "hold", { expectedRevision: 2, reason: "AWAITING_BUYER" }, { key });
    expect(otherRevision.status).toBe(409);
    expect(otherRevision.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    const otherCommand = await command(w, id, "cancel", { expectedRevision: 1, reason: "OPENED_IN_ERROR" }, { key });
    expect(otherCommand.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    const successorKey = nextKey();
    await command(w, id, "hold/remove", { expectedRevision: 2, note: "Fabric lot confirmed by the mill today." });
    await movePack(w);
    const s1 = await command(w, id, "successor", { expectedRevision: 3, reason: REASON }, { key: successorKey });
    expect(s1.status).toBe(201);
    const s2 = await command(w, id, "successor", { expectedRevision: 4, reason: REASON }, { key: successorKey });
    expect(s2.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await PpcPlanningFile.countDocuments({ companyId: w.co._id })).toBe(2);
  });

  test("the pack and IE-release receipt flows still use the shared ledger, unchanged", () => {
    const fs = require("fs");
    const read = (p) => fs.readFileSync(path.join(__dirname, "..", "..", p), "utf8");
    expect(read("services/ppc/inboundPack.service.js")).not.toMatch(/planningCommand/);
    expect(read("services/ppc/ieReleaseAck.service.js")).not.toMatch(/planningCommand/);
    expect(read("services/ppc/planningFile.service.js")).not.toMatch(/require\("\.\/commandOnce"\)/);
  });
});

/* ══ 16–17. BUSINESS DATES ════════════════════════════════════════════════ */

describe("business dates are calendar days, in every timezone", () => {
  test("the same string is stored, served and frozen — under UTC and non-UTC zones", () => {
    const probe = path.join(__dirname, "businessDateProbe.js");
    const zones = ["UTC", "America/Los_Angeles", "Asia/Kolkata", "Pacific/Kiritimati", "Pacific/Pago_Pago"];
    const results = zones.map((TZ) => JSON.parse(execFileSync(process.execPath, [probe], {
      env: { ...process.env, TZ }, encoding: "utf8",
    })));
    /* Non-vacuous: the zones really do differ. */
    expect(new Set(results.map((r) => r.offsetMinutes)).size).toBe(zones.length);
    for (const r of results) {
      const want = { start: "2026-10-05", end: "2026-10-26", completion: "2026-10-31" };
      expect(r.normalised).toEqual(want);
      expect(r.stored).toEqual({ ...want, delivery: "2026-11-20" });
      expect(r.wire).toEqual({ ...want, delivery: "2026-11-20" });
    }
  });

  test("the browser's string round-trips through the database unchanged", async () => {
    const w = await readyWorld("DatesRoundTrip");
    const c = await createPlan(w, { body: { requestedProductionStart: "2026-10-05",
      requestedProductionEnd: "2026-10-26", requestedCompletionDate: "2026-10-31" } });
    expect(c.status).toBe(201);
    const id = c.body.planningFile.planningFileId;
    const doc = await rawDoc(id);
    expect(doc.planning.requestedProductionStart).toBe("2026-10-05");
    expect(typeof doc.planning.requestedProductionEnd).toBe("string");
    expect(doc.sourceBasis.earliestDeliveryDate).toBe("2026-11-20");
    /* Events stay instants. */
    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(doc.sourceBasis.capturedAt).toBeInstanceOf(Date);

    const read = await ppc(`/planning-files/${id}`, { token: w.viewer.token, company: w.co._id });
    expect(read.body.planningFile.planning).toMatchObject({ requestedProductionStart: "2026-10-05",
      requestedProductionEnd: "2026-10-26", requestedCompletionDate: "2026-10-31" });
    expect(read.body.planningFile.sourceBasis.earliestDeliveryDate).toBe("2026-11-20");
    const row = await ppc(`/order-book/${w.lineRef}`, { token: w.viewer.token, company: w.co._id });
    expect(row.body.row.earliestDeliveryDate).toBe("2026-11-20");
  });

  test("malformed, impossible and instant-shaped dates are refused", async () => {
    const w = await readyWorld("DatesBad");
    const c = await createPlan(w);
    const id = c.body.planningFile.planningFileId;
    for (const bad of ["2026-02-30", "2026-13-01", "2026-00-10", "2025-02-29", "05/10/2026",
      "2026-10-5", "2026-10-05T00:00:00Z", "2026-10-05T00:00:00+05:30", "tomorrow", 20261005, true]) {
      const res = await patch(w, id, { expectedRevision: 1, requestedProductionStart: bad });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("PPC_PLANNING_DATE_INVALID");
    }
    const leap = await patch(w, id, { expectedRevision: 1, requestedProductionStart: "2028-02-29" });
    expect(leap.status).toBe(200);
    expect(leap.body.planningFile.planning.requestedProductionStart).toBe("2028-02-29");
  });

  test("start after end, and completion before start, are refused — including against stored values", async () => {
    const w = await readyWorld("DatesOrder");
    const inverted = await createPlan(w, { body: {
      requestedProductionStart: "2026-10-20", requestedProductionEnd: "2026-10-19" } });
    expect(inverted.body.error.code).toBe("PPC_PLANNING_WINDOW_INVALID");

    const c = await createPlan(w, { body: {
      requestedProductionStart: "2026-10-05", requestedProductionEnd: "2026-10-26" } });
    const id = c.body.planningFile.planningFileId;
    const early = await patch(w, id, { expectedRevision: 1, requestedCompletionDate: "2026-10-04" });
    expect(early.status).toBe(400);
    expect(early.body.error.code).toBe("PPC_PLANNING_WINDOW_INVALID");
    const endOnly = await patch(w, id, { expectedRevision: 1, requestedProductionEnd: "2026-10-01" });
    expect(endOnly.body.error.code).toBe("PPC_PLANNING_WINDOW_INVALID");
    const same = await patch(w, id, { expectedRevision: 1, requestedProductionEnd: "2026-10-05",
      requestedCompletionDate: "2026-10-05" });
    expect(same.status).toBe(200);
    expect((await rawDoc(id)).revision).toBe(2);
  });
});

/* ══ 18. THE GENERATION CHAIN ═════════════════════════════════════════════ */

describe("a line's planning history is one complete, readable chain", () => {
  test("cancelled, superseded and current generations, in order, with their links", async () => {
    const w = await readyWorld("Chain");
    const first = await createPlan(w, { body: { planningNote: "CONFIDENTIAL-NOTE" } });
    const g1 = first.body.planningFile;
    await command(w, g1.planningFileId, "cancel", { expectedRevision: 1, reason: "OPENED_IN_ERROR" });
    const second = await createPlan(w, { body: { afterCancelledFileRef: g1.planningFileRef } });
    const g2 = second.body.planningFile;
    await command(w, g2.planningFileId, "planning-started", { expectedRevision: 1 }, { who: w.planner });
    await command(w, g2.planningFileId, "planned", { expectedRevision: 2 });
    await movePack(w);
    const third = await command(w, g2.planningFileId, "successor", { expectedRevision: 3, reason: REASON });
    const g3 = third.body.planningFile;

    const res = await ppc(`/order-book/${w.lineRef}/planning-files`, { token: w.viewer.token, company: w.co._id });
    expect(res.status).toBe(200);
    expect(res.body.complete).toBe(true);
    expect(res.body.activePlanningFileRef).toBe(g3.planningFileRef);
    const gens = res.body.generations;
    expect(gens.map((g) => [g.generation, g.planningFileRef, g.state])).toEqual([
      [1, g1.planningFileRef, "CANCELLED"],
      [2, g2.planningFileRef, "SUPERSEDED"],
      [3, g3.planningFileRef, "OPEN"],
    ]);
    expect(gens[0].cancelledAt).toBeTruthy();
    expect(gens[0].cancellationReason).toBe("OPENED_IN_ERROR");
    expect(gens[1].followsCancelledFileRef).toBe(g1.planningFileRef);
    expect(gens[1].plannedAt).toBeTruthy();
    expect(gens[1].supersededAt).toBeTruthy();
    expect(gens[1].supersededByFileRef).toBe(g3.planningFileRef);
    expect(gens[2].supersedesFileRef).toBe(g2.planningFileRef);
    expect(gens.every((g) => g.createdAt)).toBe(true);
    expect(gens[1].sourceSummary.executionPackVersionNo).toBe(1);
    expect(gens[2].sourceSummary.executionPackVersionNo).toBe(2);
    expect(gens[2].sourceSummary.earliestDeliveryDate).toBe("2026-11-20");

    /* Summary only: no planning content, no receipts, no upstream internals. */
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("CONFIDENTIAL-NOTE");
    expect(text).not.toMatch(/ReceiptId|executionPackId|ieReleaseId|ppmMeetingId|price|cost|supplier/i);

    /* Each earlier generation stays readable in full. */
    for (const g of [g1, g2]) {
      const read = await ppc(`/planning-files/${g.planningFileId}`, { token: w.viewer.token, company: w.co._id });
      expect(read.status).toBe(200);
    }
  });

  test("the chain is company-scoped and needs a PPC read grant", async () => {
    const w = await readyWorld("ChainScope");
    await createPlan(w);
    const other = await company("ChainOther");
    const outsider = await actor({ companies: [other], grants: { ppc: "viewer" } });
    const res = await ppc(`/order-book/${w.lineRef}/planning-files`, { token: outsider.token, company: other._id });
    expect(res.status).toBe(200);
    expect(res.body.generations).toEqual([]);
    const noGrant = await actor({ companies: [w.co], grants: { merchandiser: "approver" } });
    const refused = await ppc(`/order-book/${w.lineRef}/planning-files`, { token: noGrant.token, company: w.co._id });
    expect(refused.status).toBe(403);
  });
});

/* ══ PRESERVED BOUNDARIES ═════════════════════════════════════════════════ */

describe("the accepted boundaries are unchanged", () => {
  test("no new route books, allocates or releases, and material still gates nothing", async () => {
    const router = require("../../routes/CMS_Routes/PPC/orderBookRoute");
    const segments = router.stack.filter((l) => l.route)
      .flatMap((l) => l.route.path.split("/").filter(Boolean));
    expect(segments.filter((s) => /^(capacity|book|bookings?|allocate|allocation|lines?|release|releases|work-orders?|production)$/i
      .test(s))).toEqual([]);
    const { REQUIRED_KEYS } = require("../../services/ppc/planningReadiness.contract");
    expect(REQUIRED_KEYS).not.toContain("material");

    const co = await company("Bare");
    await orderLine(co, { lineRef: "L-BARE-B" });
    const viewer = await actor({ companies: [co], grants: { ppc: "viewer" } });
    const res = await ppc("/order-book?view=all", { token: viewer.token, company: co._id });
    const row = res.body.rows.find((r) => r.orderLineRef === "L-BARE-B");
    expect(row.eligible).toBe(true);
    expect(row.readyToPlan).toBe(false);
    void minutes; void ExecutionFile;
  });
});
