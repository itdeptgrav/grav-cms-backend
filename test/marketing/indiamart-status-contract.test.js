// test/marketing/indiamart-status-contract.test.js
//
// THE INDIAMART STATUS CONTRACT: EVERY SCHEDULED-CYCLE OUTCOME IS LABELLED,
// AND COVERAGE NEVER CLAIMS A SCHEDULE THAT IS NOT RUNNING.
//
// ── WHAT THIS PINS ─────────────────────────────────────────────────────────
//   `automaticChecks.lastCycleOutcome` is only ever a code the vocabulary
//   labels, and each one is produced by a real scheduled cycle and read back
//   through the live status route with its label.
//   `automaticChecks.state` is scheduled / switched_off / no_key, from the key
//   and the real job switch. `coverage.notes` describe coverage only and are
//   true in all three; coverage history survives the schedule being switched
//   off or the key being removed.
//   Simulated: the IndiaMART transport is injected.
"use strict";

jest.mock("../../Middlewear/MarketingAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ success: false });
    req.user = JSON.parse(raw);
    return next();
  };
  mw.ALLOWED_ROLES = ["marketing", "admin", "ceo"];
  return mw;
});
jest.mock("../../services/changeLog", () => ({
  recordChange: jest.fn().mockResolvedValue(undefined),
  historyForWithChildren: jest.fn(),
}));

const express = require("express");
const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const { MarketingLeadSourceState } = require("../../models/CMS_Models/Marketing/MarketingLeadSourceState");
const JobHeartbeat = require("../../models/DevOps/JobHeartbeat");
const jobRegistry = require("../../services/jobRegistry");
const scheduler = require("../../services/integration/indiamartScheduler");
const sync = require("../../services/marketing/leads/indiamartSync.service");
const I = require("../../constants/marketingIndiamart");

const MINUTE = 60 * 1000;
const START = Math.floor(Date.now() / 1000) * 1000;
const KEY = "stC0SECRETindiamartKEYvalue77";
const MARKETER = { id: new mongoose.Types.ObjectId().toString(), name: "Mo", role: "marketing" };

let A;
let server; let base;
const clock = { now: START };
const now = () => clock.now;
const saved = {};

let answers = [];
const transport = () => Promise.resolve(answers.shift() || ok());
const ok = () => ({ status: 200, text: JSON.stringify({ CODE: 200, STATUS: "SUCCESS", MESSAGE: "", TOTAL_RECORDS: 0, RESPONSE: [] }) });
const code = (c) => ({ status: 200, text: JSON.stringify({ CODE: c, STATUS: "FAILURE", MESSAGE: "x", TOTAL_RECORDS: 0, RESPONSE: [] }) });

/* The live route, with the REAL job switch (no scheduleEnabled override). */
async function status() {
  jobRegistry.invalidateEnabled();
  const res = await fetch(`${base}/api/cms/marketing/lead-sources/indiamart`, {
    headers: { "x-test-user": JSON.stringify(MARKETER), "x-test-company": String(A) },
  });
  return res.json();
}
const cycle = () => scheduler.runCycle({ now, transport, isEnabled: async () => true });
async function switchSchedule(enabled) {
  await JobHeartbeat.updateOne(
    { name: I.SCHEDULE.JOB_NAME },
    { $set: { enabled }, $setOnInsert: { name: I.SCHEDULE.JOB_NAME, expectEverySeconds: 360 } },
    { upsert: true },
  );
  jobRegistry.invalidateEnabled();
}

beforeAll(async () => {
  for (const k of ["MARKETING_COMPANY_ID", I.KEY_ENV]) saved[k] = process.env[k];
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const c = String(req.headers["x-test-company"] || "");
    if (mongoose.Types.ObjectId.isValid(c)) req.__marketingCompanyId = new mongoose.Types.ObjectId(c);
    next();
  });
  app.locals.marketingIndiamartTransport = transport;
  app.locals.marketingIndiamartClock = now;
  app.use("/api/cms/marketing", require("../../routes/CMS_Routes/Marketing/leadSources"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  jobRegistry.invalidateEnabled();
  await new Promise((r) => server.close(r));
});
beforeEach(async () => {
  jest.restoreAllMocks();
  jobRegistry.invalidateEnabled();
  A = (await Acc_Company.create({ companyName: "GRAV Clothing", booksFromDate: new Date("2026-04-01") }))._id;
  process.env.MARKETING_COMPANY_ID = String(A);
  process.env[I.KEY_ENV] = KEY;
  clock.now = START;
  answers = [];
});

/* ═══ 1. EVERY CYCLE OUTCOME IS LABELLED ══════════════════════════════════ */

describe("scheduled-cycle outcomes", () => {
  test("1. the vocabulary labels exactly the values the scheduler can store", () => {
    const words = [
      scheduler.pullWord({ outcome: "completed" }),
      scheduler.pullWord({ outcome: "failed" }),
      scheduler.pullWord({ refused: "LEAD_SOURCE_CHECK_TOO_SOON" }),
      scheduler.pullWord({ refused: "LEAD_SOURCE_CHECK_IN_PROGRESS" }),
      scheduler.pullWord({ error: "MongoNetworkError" }),
      scheduler.pullWord({ outcome: "something_new" }),
      scheduler.pullWord(),
    ];
    for (const w of words) expect(I.SCHEDULED_CYCLE_OUTCOME_CODES).toContain(w);
    expect([...new Set(words)].sort()).toEqual([...I.SCHEDULED_CYCLE_OUTCOME_CODES].sort());
    for (const o of sync.vocabulary.scheduledCycleOutcomes) {
      expect(o.label.length).toBeGreaterThan(3);
      expect(o.means.length).toBeGreaterThan(20);
    }
  });

  const expectOutcome = async (codeWanted) => {
    const body = await status();
    const a = body.indiamart.automaticChecks;
    expect(a.lastCycleOutcome).toBe(codeWanted);
    expect(a.lastCycleOutcomeLabel).toEqual(body.vocabulary.scheduledCycleOutcomes.find((o) => o.code === codeWanted));
    expect(a.lastCycleAt).not.toBeNull();
    return body;
  };

  test("2. completed", async () => {
    await cycle();
    await expectOutcome("completed");
  });

  test("3. failed — and the last error is still separate", async () => {
    answers.push(code(401));
    await cycle();
    const body = await expectOutcome("failed");
    expect(body.indiamart.lastError.code).toBe("key_rejected");
  });

  test("4. waiting_rate_limit", async () => {
    await cycle();
    clock.now += MINUTE;
    await cycle();
    await expectOutcome("waiting_rate_limit");
  });

  test("5. another_check_running", async () => {
    await MarketingLeadSourceState.create({
      companyId: A, source: "indiamart", leaseUntil: new Date(START + MINUTE), leaseToken: "elsewhere",
    });
    await cycle();
    await expectOutcome("another_check_running");
  });

  test("6. error", async () => {
    jest.spyOn(sync, "check").mockRejectedValueOnce(Object.assign(new Error("boom"), { name: "MongoNetworkError" }));
    await cycle();
    await expectOutcome("error");
  });

  test("7. a stored value outside the vocabulary is never published unlabelled", async () => {
    await MarketingLeadSourceState.create({
      companyId: A, source: "indiamart", lastScheduledCycleAt: new Date(START), lastScheduledCycleOutcome: "mystery",
    });
    const a = (await status()).indiamart.automaticChecks;
    expect(a.lastCycleOutcome).toBeNull();
    expect(a.lastCycleOutcomeLabel).toBeNull();
    expect(a.lastCycleAt).not.toBeNull();
  });
});

/* ═══ 2. SCHEDULE STATE VERSUS COVERAGE ═══════════════════════════════════ */

describe("automatic checks and coverage notes", () => {
  const scheduleClaim = /on a schedule|every few minutes|checks IndiaMART on its own|at most once every 5 minutes/i;

  test("8. schedule on: state scheduled; coverage notes make no schedule claim", async () => {
    await cycle();
    const body = await status();
    const a = body.indiamart.automaticChecks;
    expect(a.state).toEqual(body.vocabulary.automaticCheckStates.find((s) => s.code === "scheduled"));
    expect(a).toMatchObject({ enabled: true, switchedOff: false, everyMinutes: 6 });
    expect(a.means).toBe(a.state.means);
    for (const n of body.indiamart.coverage.notes) expect(n).not.toMatch(scheduleClaim);
  });

  test("9. switched off: state switched_off; coverage history and the last cycle are kept, not rewritten", async () => {
    await cycle();
    const before = (await status()).indiamart;
    await switchSchedule(false);
    const body = await status();
    const a = body.indiamart.automaticChecks;
    expect(a.state.code).toBe("switched_off");
    expect(a).toMatchObject({ enabled: false, switchedOff: true, lastCycleOutcome: "completed" });
    expect(a.means).toMatch(/only when an administrator uses Check now/);
    expect(body.indiamart.coverage.coveredThrough).toBe(before.coverage.coveredThrough);
    expect(body.indiamart.coverage.notes).toEqual(before.coverage.notes);
    for (const n of body.indiamart.coverage.notes) expect(n).not.toMatch(scheduleClaim);
    /* And a switched-off cycle really does nothing. */
    expect(await scheduler.runCycle({ now, transport })).toEqual({ skipped: "disabled" });
  });

  test("10. no key: state no_key, even with the switch on; earlier coverage still shown as history", async () => {
    await cycle();
    delete process.env[I.KEY_ENV];
    const body = await status();
    const a = body.indiamart.automaticChecks;
    expect(a.state.code).toBe("no_key");
    expect(a).toMatchObject({ enabled: false, switchedOff: false, lastCycleOutcome: "completed" });
    expect(a.means).toMatch(/no IndiaMART key/);
    expect(body.indiamart.connection.code).toBe("not_configured");
    expect(body.indiamart.coverage.coveredThrough).not.toBeNull();
    for (const n of body.indiamart.coverage.notes) expect(n).not.toMatch(scheduleClaim);
    await switchSchedule(false);
    expect((await status()).indiamart.automaticChecks.state.code).toBe("no_key");
  });

  test("11. never checked, no key: nothing in automatic checks or coverage pretends otherwise", async () => {
    delete process.env[I.KEY_ENV];
    const i = (await status()).indiamart;
    expect(i.automaticChecks).toMatchObject({ state: { code: "no_key" }, lastCycleAt: null, lastCycleOutcome: null, lastCycleOutcomeLabel: null });
    expect(i.coverage).toMatchObject({ coveredFrom: null, coveredThrough: null, freshness: { code: "never_checked" } });
  });
});
